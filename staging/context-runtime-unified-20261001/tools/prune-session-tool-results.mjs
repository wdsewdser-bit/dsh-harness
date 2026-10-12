#!/usr/bin/env node
/**
 * Replace older model-visible tool/result messages with tiny placeholders.
 * Raw events remain in the append-only journal; replacements use the same
 * surfaceOp mechanism as the shipped tool-result pruner.
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
const keepRecent = Number(arg('--keep', '15'))
const keepTeamContexts = Number(arg('--team-context-keep', '1'))
const write = args.includes('--write')
if (!file || !fs.existsSync(file)) throw new Error(`session file not found: ${file}`)
if (!Number.isInteger(keepRecent) || keepRecent < 0) throw new Error(`--keep must be a non-negative integer`)
if (!Number.isInteger(keepTeamContexts) || keepTeamContexts < 0) throw new Error(`--team-context-keep must be a non-negative integer`)

const require = createRequire(import.meta.url)
const sessionEntry = require.resolve('@deepseek-ai/dsh-session', {
  paths: [
    'D:/dsh-test/app',
    'D:/dsh-test/app/node_modules/.pnpm/node_modules',
  ],
})
const { Session } = await import(pathToFileURL(sessionEntry).href)
const imageOffloadEntry = require.resolve('@deepseek-ai/dsh-compaction-image-offload/projection', {
  paths: [
    'D:/dsh-test/app',
    'D:/dsh-test/app/node_modules/.pnpm/node_modules',
  ],
})
const { imageOffloadProjection } = await import(pathToFileURL(imageOffloadEntry).href)

const MAGIC = 0xFD2FB528
function decodeFrames(buffer) {
  let offset = 0
  let text = ''
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== MAGIC) {
      throw new Error(`invalid zstd frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) throw new Error('torn zstd frame header')
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('torn zstd block header')
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved zstd block type')
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) throw new Error('torn zstd frame')
    text += zlib.zstdDecompressSync(buffer.subarray(start, offset)).toString('utf8')
  }
  return text
}

const rows = decodeFrames(fs.readFileSync(file)).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const header = rows[0]
const seed = rows.slice(1)
const session = Session.create(header.id, seed, header, 0, [imageOffloadProjection])
const beforeCount = session.log.length
const callNames = new Map()
for (const event of session.log) {
  if (event.type === 'tool/call') callNames.set(event.data.callId, event.data.name)
}

const currentToolResults = []
const currentTeamContexts = []
const messageText = (message) => (Array.isArray(message?.content) ? message.content : [])
  .map((block) => block?.type === 'text' ? String(block.text ?? '') : '')
  .join('\n')
for (const seq of [...session.surface.nodes]) {
  const event = session.eventAt(seq)
  if (event?.type === 'tool/result') {
    currentToolResults.push({ seq, event, message: session.deriveEventMessage(event) })
    continue
  }
  if (event?.type !== 'user/message') continue
  const message = session.deriveEventMessage(event)
  const text = messageText(message)
  if (text.includes('[team v12 context pack]') && !text.includes('[context-prune]')) {
    currentTeamContexts.push({ seq, event, message, text })
  }
}

const victims = [
  ...currentToolResults
    .slice(0, Math.max(0, currentToolResults.length - keepRecent))
    .map((row) => ({ ...row, kind: 'tool-result' })),
  ...currentTeamContexts
    .slice(0, Math.max(0, currentTeamContexts.length - keepTeamContexts))
    .map((row) => ({ ...row, kind: 'team-context-pack' })),
].sort((left, right) => left.seq - right.seq)
const details = []
let replaced = 0
let charsBefore = 0
let charsAfter = 0

for (const victim of victims) {
  const { seq, event, kind } = victim
  const original = victim.message ?? session.deriveEventMessage(event)
  if (!original) continue
  const text = victim.text ?? messageText(original)
  if (text.includes('[context-prune]')) continue
  const name = callNames.get(original.source?.callId) ?? 'tool'
  const digest = /\[team v12 context pack\]\s+digest=([0-9a-f]+)/i.exec(text)?.[1] ?? 'unknown'
  const marker = kind === 'team-context-pack'
    ? `[context-prune] team v12 context pack digest=${digest} removed from model history; latest pack retained and original remains in the session journal.`
    : `[context-prune] ${name} result removed from model history; original remains in the session journal.`
  const replacement = JSON.parse(JSON.stringify(original))
  replacement.content = [{ type: 'text', text: marker }]
  const replacementData = event.type === 'tool/result'
    ? { ...JSON.parse(JSON.stringify(event.data)), message: replacement }
    : replacement

  session.append('compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: 0,
  })
  session.append(event.type, replacementData, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })

  replaced += 1
  charsBefore += text.length
  charsAfter += marker.length
  if (details.length < 20) details.push({ seq, kind, name, beforeChars: text.length, afterChars: marker.length })
}

const newEvents = session.log.slice(seed.length)
const result = {
  file,
  sessionId: header.id,
  keepRecent,
  keepTeamContexts,
  currentToolResults: currentToolResults.length,
  currentTeamContexts: currentTeamContexts.length,
  replaced,
  skipped: victims.length - replaced,
  charsBefore,
  charsAfter,
  charsRemoved: charsBefore - charsAfter,
  newEvents: newEvents.length,
  firstReplacementSeq: newEvents.find((event) => event.type === 'tool/result')?.seq ?? null,
  mode: write ? 'write' : 'dry-run',
  details,
}

if (write) {
  if (newEvents.length === 0) throw new Error('nothing to write')
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

console.log(JSON.stringify(result, null, 2))
