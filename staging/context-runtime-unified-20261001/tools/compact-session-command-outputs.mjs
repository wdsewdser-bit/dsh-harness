#!/usr/bin/env node
/**
 * Shrink oversized command/done text records in a DSH v4 JSONL session.
 *
 * The operator panel writes /team meta results into command/done events. Older
 * builds returned multi-megabyte snapshots, which made session open linear in
 * panel polling history. This tool preserves every event and sequence, but
 * replaces only oversized command/done text with a bounded preview marker.
 *
 * Usage:
 *   node compact-session-command-outputs.mjs <session.v4.jsonl.zstd> [--apply]
 */
import { copyFileSync, openSync, closeSync, writeSync, readFileSync, statSync, rmSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const MAX_TEXT_BYTES = 256 * 1024
const OUTPUT_FRAME_BYTES = 16 * 1024 * 1024

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function frameBytes(bytes) {
  return zstdCompressSync(bytes, {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

function compact(sessionPath, apply) {
  const beforeStat = statSync(sessionPath)
  const beforeBytes = readFileSync(sessionPath)
  const { frames, tornStart } = scanZstdFrames(beforeBytes)
  if (tornStart !== undefined) throw new Error(`refusing to compact a torn session at byte ${tornStart}`)

  const tempPath = join(dirname(sessionPath), basename(sessionPath) + '.compact-' + process.pid + '.tmp')
  const out = openSync(tempPath, 'wx')
  let pending = Buffer.alloc(0)
  let batch = []
  let batchBytes = 0
  let lineCount = 0
  let eventCount = 0
  let truncated = 0
  let originalTextBytes = 0
  let compactedTextBytes = 0

  const writeFrame = (bytes) => {
    if (bytes.length === 0) return
    writeSync(out, frameBytes(bytes))
  }
  const flushBatch = () => {
    if (batch.length === 0) return
    writeFrame(Buffer.concat(batch, batchBytes))
    batch = []
    batchBytes = 0
  }
  const emitLine = (line) => {
    lineCount += 1
    let output = Buffer.concat([line, Buffer.from('\n')])
    if (lineCount > 1) {
      let row
      try {
        row = JSON.parse(line.toString('utf8'))
      } catch {
        throw new Error(`unparsable session row at line ${lineCount}`)
      }
      if (row?.type === 'command/done' && typeof row?.data?.text === 'string') {
        const textBytes = Buffer.byteLength(row.data.text, 'utf8')
        if (textBytes > MAX_TEXT_BYTES) {
          originalTextBytes += textBytes
          row.data.text = JSON.stringify({
            truncated: true,
            originalBytes: textBytes,
            preview: row.data.text.slice(0, 2000),
          })
          compactedTextBytes += Buffer.byteLength(row.data.text, 'utf8')
          truncated += 1
          output = Buffer.concat([Buffer.from(JSON.stringify(row)), Buffer.from('\n')])
        }
      }
      eventCount += 1
    }
    if (lineCount === 1) {
      writeFrame(output)
      return
    }
    batch.push(output)
    batchBytes += output.length
    if (batchBytes >= OUTPUT_FRAME_BYTES) flushBatch()
  }

  try {
    for (const frame of frames) {
      const plain = zstdDecompressSync(beforeBytes.subarray(frame.start, frame.end))
      const input = pending.length === 0 ? plain : Buffer.concat([pending, plain])
      let start = 0
      for (let newline = input.indexOf(10, start); newline !== -1; newline = input.indexOf(10, start)) {
        emitLine(input.subarray(start, newline))
        start = newline + 1
      }
      pending = Buffer.from(input.subarray(start))
    }
    if (pending.length > 0) emitLine(pending)
    flushBatch()
  } finally {
    closeSync(out)
  }

  const afterBytes = readFileSync(tempPath)
  const afterFrames = scanZstdFrames(afterBytes)
  let verifyPending = Buffer.alloc(0)
  let verifyLines = 0
  for (const frame of afterFrames.frames) {
    const plain = zstdDecompressSync(afterBytes.subarray(frame.start, frame.end))
    const input = verifyPending.length === 0 ? plain : Buffer.concat([verifyPending, plain])
    let start = 0
    for (let newline = input.indexOf(10, start); newline !== -1; newline = input.indexOf(10, start)) {
      const line = input.subarray(start, newline)
      verifyLines += 1
      JSON.parse(line.toString('utf8'))
      start = newline + 1
    }
    verifyPending = Buffer.from(input.subarray(start))
  }
  if (verifyPending.length > 0) throw new Error('compacted session has a torn final row')
  if (verifyLines !== lineCount) throw new Error(`line count changed: ${lineCount} -> ${verifyLines}`)

  const afterStat = statSync(sessionPath)
  if (afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs) {
    rmSync(tempPath, { force: true })
    throw new Error('session changed while compaction was running; no changes were applied')
  }

  const result = {
    session: sessionPath,
    beforeMB: +(beforeStat.size / 1048576).toFixed(2),
    compactedMB: +(statSync(tempPath).size / 1048576).toFixed(2),
    lines: lineCount,
    events: eventCount,
    truncated,
    originalTextMB: +(originalTextBytes / 1048576).toFixed(2),
    compactedTextMB: +(compactedTextBytes / 1048576).toFixed(2),
    applied: false,
  }
  if (!apply) {
    console.log(JSON.stringify({ ...result, tempPath }, null, 2))
    return result
  }

  const backupPath = sessionPath + '.bak-command-outputs-' + Date.now()
  copyFileSync(sessionPath, backupPath)
  copyFileSync(tempPath, sessionPath)
  rmSync(tempPath, { force: true })
  result.applied = true
  result.backup = backupPath
  console.log(JSON.stringify(result, null, 2))
  return result
}

const [sessionPath, ...args] = process.argv.slice(2)
if (!sessionPath) {
  console.error('usage: node compact-session-command-outputs.mjs <session.v4.jsonl.zstd> [--apply]')
  process.exit(2)
}
compact(sessionPath, args.includes('--apply'))
