#!/usr/bin/env node
/**
 * Recover human messages that were claimed by a blocked turn but never became
 * model-visible user/message events. Raw inbox records remain untouched.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const file = path.resolve(arg('--file', ''))
const limit = Number(arg('--limit', '20'))
const write = args.includes('--write')
if (!file || !fs.existsSync(file)) throw new Error(`session file not found: ${file}`)

const require = createRequire(import.meta.url)
const sessionEntry = require.resolve('@deepseek-ai/dsh-session', { paths: ['D:/dsh-test/app'] })
const { Session } = await import(pathToFileURL(sessionEntry).href)

const MAGIC = 0xFD2FB528
function decodeFrames(buffer) {
  let offset = 0
  let text = ''
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`invalid zstd magic at ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (header & 1) !== 0
      const blockType = (header >>> 1) & 3
      const blockSize = header >>> 3
      if (blockType === 3) throw new Error('reserved zstd block type')
      offset += blockType === 1 ? 1 : blockSize
      if (last) break
    }
    if (checksum) offset += 4
    text += zlib.zstdDecompressSync(buffer.subarray(start, offset)).toString('utf8')
  }
  return text
}

const rows = decodeFrames(fs.readFileSync(file)).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const header = rows[0]
const seed = rows.slice(1)
const session = Session.create(header.id, seed, header)

const visibleIds = new Set()
for (const seq of session.surface.nodes) {
  const event = session.eventAt(seq)
  if (event?.type === 'user/message' && typeof event.data?.id === 'string') visibleIds.add(event.data.id)
}

const candidates = []
for (const event of session.log) {
  if (event.type !== 'agent/inbox/spliced' || event.data?.target !== 'next-turn') continue
  for (const message of event.data?.inserted ?? []) {
    if (typeof message?.source?.rpcId !== 'string' || typeof message?.id !== 'string') continue
    if (visibleIds.has(message.id)) continue
    candidates.push({ sourceSeq: event.seq, message })
  }
}

const missing = candidates.slice(-limit)
for (const { message } of missing) {
  session.append('user/message', message, { surfaceOp: 'append' })
  visibleIds.add(message.id)
}

const newEvents = session.log.slice(seed.length)
const result = {
  file,
  sessionId: header.id,
  recovered: missing.length,
  sourceSeqs: missing.map((row) => row.sourceSeq),
  messageIds: missing.map((row) => row.message.id),
  newEvents: newEvents.length,
  mode: write ? 'write' : 'dry-run',
}

if (write) {
  if (newEvents.length === 0) {
    console.log(JSON.stringify({ ...result, written: 0 }, null, 2))
    process.exit(0)
  }
  const plaintext = newEvents.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const frame = zlib.zstdCompressSync(Buffer.from(plaintext, 'utf8'), {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  })
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, frame)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

console.log(JSON.stringify({ ...result, written: write ? newEvents.length : 0 }, null, 2))
