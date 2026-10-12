#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
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
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

function* parseRows(text) {
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\n', start)
    const line = end === -1 ? text.slice(start) : text.slice(start, end)
    start = end === -1 ? text.length : end + 1
    if (line.length === 0) continue
    try {
      yield JSON.parse(line)
    } catch {
      yield { type: '__invalid_json__', text: line }
    }
  }
}

const [path, needle = '', maxHitsRaw = '20'] = process.argv.slice(2)
if (!path) {
  console.error('usage: node inspect-zstd-jsonl.mjs <path> [needle] [maxHits]')
  process.exit(2)
}
const maxHits = Math.max(1, Number(maxHitsRaw) || 20)
const bytes = readFileSync(path)
const scan = scanZstdFrames(bytes)
let rowCount = 0
let invalidRows = 0
let hits = 0
let decodedBytes = 0
for (const [index, frame] of scan.frames.entries()) {
  let text
  try {
    text = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
  } catch (error) {
    console.log(JSON.stringify({ frame: index, start: frame.start, end: frame.end, error: String(error?.message ?? error) }))
    continue
  }
  decodedBytes += Buffer.byteLength(text)
  for (const row of parseRows(text)) {
    rowCount += 1
    if (row.type === '__invalid_json__') invalidRows += 1
    if (needle.length === 0) continue
    const encoded = JSON.stringify(row)
    if (!encoded.includes(needle)) continue
    hits += 1
    if (hits <= maxHits) {
      console.log(JSON.stringify({ frame: index, row: rowCount, value: row }))
    }
    if (hits >= maxHits) break
  }
  if (needle.length > 0 && hits >= maxHits) break
}
console.log(JSON.stringify({
  frames: scan.frames.length,
  tornStart: scan.tornStart ?? null,
  rowCount,
  invalidRows,
  decodedBytes,
  hits,
}))
