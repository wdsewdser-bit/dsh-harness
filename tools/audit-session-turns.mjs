#!/usr/bin/env node
/** Read-only V3 Session audit: list tool/result rows outside an open turn. */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xFD2FB528

function frames(buffer) {
  const out = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`invalid zstd frame at ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (blockHeader & 1) !== 0
      const type = blockHeader >>> 1 & 3
      const size = blockHeader >>> 3
      if (type === 3) throw new Error(`reserved zstd block at ${offset - 3}`)
      offset += type === 1 ? 1 : size
      if (last) break
    }
    if (checksum) offset += 4
    out.push({ start, end: offset })
  }
  return out
}

function rows(buffer) {
  const result = []
  for (const frame of frames(buffer)) {
    const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of text.split(/\r?\n/)) if (line.length > 0) result.push(JSON.parse(line))
  }
  return result
}

const file = process.argv[2]
if (!file) {
  console.error('usage: node audit-session-turns.mjs <session.v3.jsonl.zstd>')
  process.exit(2)
}
const all = rows(readFileSync(file))
const header = all[0]
let openTurn = false
let turn = null
const outside = []
for (const row of all.slice(1)) {
  if (row.type === 'turn/start') {
    openTurn = true
    turn = row.data?.turn
  } else if (row.type === 'turn/end') {
    openTurn = false
    turn = null
  } else if (row.type === 'tool/result' && !openTurn) {
    outside.push({
      seq: row.seq,
      time: row.time,
      turn,
      callId: row.data?.message?.source?.callId ?? row.data?.message?.content?.[0]?.toolCallId ?? null,
      messageId: row.data?.message?.id ?? null,
      surfaceOp: row.surfaceOp ?? null,
      sourceEventSeqs: row.sourceEventSeqs ?? null,
    })
  }
}
console.log(JSON.stringify({ file, version: header?.version, id: header?.id, rows: all.length, outsideCount: outside.length, outside }, null, 2))
