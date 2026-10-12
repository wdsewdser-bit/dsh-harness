#!/usr/bin/env node
'use strict'

/**
 * Search plaintext JSONL inside a concatenated-frame DSH .jsonl.zstd artifact
 * without requiring an external zstd executable.
 *
 * Usage:
 *   node search-zstd-session.cjs <file> <needle> [contextChars]
 */

const fs = require('node:fs')
const zlib = require('node:zlib')

function scanFrames(buffer) {
  const magic = 0xFD2FB528
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== magic) throw new Error(`invalid zstd magic at ${offset}`)
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved zstd header bit at ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let complete = false
    while (offset < buffer.length) {
      if (buffer.length - offset < 3) break
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved zstd block type at ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) break
      offset += payloadBytes
      if (lastBlock) {
        complete = true
        break
      }
    }
    if (!complete) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

const [file, needle, contextArg, afterArg] = process.argv.slice(2)
if (!file || !needle) {
  process.stderr.write('usage: search-zstd-session.cjs <file> <needle> [contextChars]\n')
  process.exit(1)
}
const context = Number(contextArg || 1200)
const after = Number(afterArg || 0)
const buffer = fs.readFileSync(file)
const frames = scanFrames(buffer)
let hits = 0
let lineNumber = 0
let lastError = ''

for (const frame of frames) {
  let text
  try {
    text = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  } catch (error) {
    lastError = `frame ${frame.start}-${frame.end}: ${String(error)}`
    continue
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    if (after > 0) {
      try {
        const parsed = JSON.parse(line)
        if (Number(parsed.time || 0) < after) continue
      } catch {
        continue
      }
    }
    lineNumber += 1
    const at = line.indexOf(needle)
    if (at < 0) continue
    hits += 1
    const start = Math.max(0, at - context)
    const end = Math.min(line.length, at + needle.length + context)
    process.stdout.write(`LINE ${lineNumber}\n${line.slice(start, end)}\n\n`)
  }
}

process.stdout.write(`frames=${frames.length} hits=${hits}${lastError ? ` lastError=${lastError}` : ''}\n`)
if (hits === 0) process.exitCode = 2
