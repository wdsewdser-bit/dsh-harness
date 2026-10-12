#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return { frames }
}

function* parseRows(text) {
  let start = 0
  while (start < text.length) {
    const end = text.indexOf('\n', start)
    const line = end === -1 ? text.slice(start) : text.slice(start, end)
    start = end === -1 ? text.length : end + 1
    if (line.length !== 0) yield JSON.parse(line)
  }
}

const [source, target] = process.argv.slice(2)
if (!source || !target) {
  console.error('usage: node extract-team-state-from-session.mjs <session.v3.jsonl.zstd> <out.json>')
  process.exit(2)
}

const bytes = readFileSync(source)
const { frames } = scanZstdFrames(bytes)
let selected
let candidates = 0
for (const frame of frames) {
  const text = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
  for (const row of parseRows(text)) {
    if (row?.type !== 'command/done' || row?.data?.kind !== 'success' || typeof row?.data?.text !== 'string') continue
    let value
    try { value = JSON.parse(row.data.text) } catch { continue }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const rootId = typeof value.rootId === 'string' ? value.rootId : value.teamRootId
    if (typeof rootId !== 'string' || rootId.length === 0) continue
    if (value.boards === null || typeof value.boards !== 'object') continue
    candidates += 1
    selected = { value, seq: Number(row.seq ?? -1), time: Number(row.time ?? -1) }
  }
}
if (selected === undefined) throw new Error('no complete Team metadata snapshot found')

const serialized = JSON.stringify(selected.value, null, 2) + '\n'
const temporary = target + '.tmp-' + String(process.pid)
try {
  writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, target)
} catch (error) {
  try { rmSync(temporary, { force: true }) } catch {}
  throw error
}

const counts = Object.fromEntries(Object.entries(selected.value).map(([key, value]) => [
  key,
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : Array.isArray(value) ? value.length : null,
]))
console.log(JSON.stringify({
  candidates,
  selectedSeq: selected.seq,
  selectedTime: selected.time,
  rootId: selected.value.rootId ?? selected.value.teamRootId,
  revision: selected.value.revision,
  updatedAt: selected.value.updatedAt,
  counts,
  bytes: Buffer.byteLength(serialized),
  sha256: createHash('sha256').update(serialized).digest('hex'),
  target,
}, null, 2))
