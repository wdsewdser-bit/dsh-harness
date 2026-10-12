#!/usr/bin/env node
/** Print the last N meaningful rows of a DSH zstd session log as compact text. */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    const start = offset
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
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
  return frames
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (block?.type === 'text') return block.text ?? ''
    if (block?.type === 'reasoning') return '[reasoning] ' + String(block.text ?? '').slice(0, 400)
    if (block?.type === 'tool-call') return '[tool-call ' + String(block.name ?? '') + '] ' + String(block.arguments ?? '').slice(0, 400)
    return '[' + String(block?.type ?? 'block') + ']'
  }).join(' ').replace(/\s+/g, ' ').slice(0, 700)
}

const [path, countRaw = '20'] = process.argv.slice(2)
if (!path) {
  console.error('usage: node tail-session.mjs <session.v4.jsonl.zstd> [count]')
  process.exit(2)
}
const count = Math.max(1, Number(countRaw) || 20)
const rows = []
for (const frame of scanFrames(readFileSync(path))) {
  let text
  try { text = zstdDecompressSync(readFileSync(path).subarray(frame.start, frame.end)).toString('utf8') } catch { continue }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* torn row */ }
  }
}
for (const row of rows.slice(-count)) {
  const message = row?.data?.message
  const kind = row?.type ?? '?'
  if (kind === 'tool/call') {
    console.log(`#${row.seq} ${kind} ${row.data?.name} ${String(row.data?.arguments ?? '').slice(0, 300)}`)
    continue
  }
  if (kind === 'tool/result') {
    const block = message?.content?.[0]
    console.log(`#${row.seq} ${kind} isError=${message?.isError} ${String(block?.text ?? '').slice(0, 300)}`)
    continue
  }
  if (message?.role) {
    console.log(`#${row.seq} ${kind} role=${message.role} ${textOf(message.content)}`)
    continue
  }
  console.log(`#${row.seq} ${kind} ${JSON.stringify(row.data ?? {}).slice(0, 200)}`)
}
