#!/usr/bin/env node
import { readFileSync } from 'node:fs'
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

const [path, needle, maxHitsRaw = '20', radiusRaw = '220', minSeqRaw = '0'] = process.argv.slice(2)
if (!path || !needle) {
  console.error('usage: node find-zstd-jsonl-text.mjs <session.v3.jsonl.zstd> <needle> [maxHits] [radius]')
  process.exit(2)
}
const maxHits = Math.max(1, Number(maxHitsRaw) || 20)
const radius = Math.max(40, Number(radiusRaw) || 220)
const bytes = readFileSync(path)
const { frames, tornStart } = scanZstdFrames(bytes)
let rowCount = 0
let hits = 0
for (const [frameIndex, frame] of frames.entries()) {
  const text = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
  for (const row of parseRows(text)) {
    rowCount += 1
    if (Number(row.seq ?? 0) < Math.max(0, Number(minSeqRaw) || 0)) continue
    const encoded = JSON.stringify(row)
    const at = encoded.indexOf(needle)
    if (at === -1) continue
    hits += 1
    const snippet = encoded.slice(Math.max(0, at - radius), Math.min(encoded.length, at + needle.length + radius))
    console.log(JSON.stringify({
      frame: frameIndex,
      seq: row.seq ?? null,
      time: row.time ?? null,
      type: row.type ?? null,
      role: row.data?.message?.role ?? null,
      tool: row.data?.message?.content?.find?.((item) => item?.type === 'tool-call')?.name ?? null,
      snippet,
    }))
    if (hits >= maxHits) break
  }
  if (hits >= maxHits) break
}
console.log(JSON.stringify({ frames: frames.length, tornStart: tornStart ?? null, rowCount, hits }))
