#!/usr/bin/env node
/**
 * Local DSH 0.1.7 compatibility for Session logs produced by the old
 * context-pruning tool. Those logs contain tool/result surface replacements
 * outside a turn. Keep the normal strict lifecycle, but admit the exact
 * historical shape: replace op + explicit sourceEventSeqs.
 */
const { readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', 'node_modules')
const touched = []

function patchRelationships(file) {
  let source = readFileSync(file, 'utf8')
  const before = source
  const pattern = /(if \(event\.type === "tool\/result" && event\["surfaceOp"\] !== "append"\) \{\r?\n)(\s*)(this\.requireTurn\(event\.type\);)/g
  source = source.replace(pattern, (match, start, indent, call) => {
    if (source.includes('historicalPrune')) return match
    return start
      + indent + 'const historicalPrune = event["surfaceOp"] !== null && typeof event["surfaceOp"] === "object" && event["surfaceOp"]["op"] === "replace" && Array.isArray(event["sourceEventSeqs"]) && event["sourceEventSeqs"].length > 0;\n'
      + indent + 'if (!historicalPrune) ' + call
  })
  const oldElse = '\t\t\t\t} else if (openTurn === null) throw new SessionFormatError("tool/result replacement is outside an open turn");'
  const newElse = '\t\t\t\t} else if (openTurn === null) {\n'
    + '\t\t\t\t\tconst historicalPrune = event["surfaceOp"] !== null && typeof event["surfaceOp"] === "object" && event["surfaceOp"]["op"] === "replace" && Array.isArray(event["sourceEventSeqs"]) && event["sourceEventSeqs"].length > 0;\n'
    + '\t\t\t\t\tif (!historicalPrune) throw new SessionFormatError("tool/result replacement is outside an open turn");\n'
    + '\t\t\t\t}'
  source = source.replace(oldElse, newElse)
  if (source !== before) {
    writeFileSync(file, source, 'utf8')
    touched.push(file)
  }
}

function walk(directory) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(path)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name === 'index.js' && path.includes('dsh-session-format-v3-to-v4')) patchRelationships(path)
    if (entry.name === 'index.js' && path.includes('dsh-session-format-v0-to-v1')) patchRelationships(path)
    if (entry.name === 'worker.cjs' && path.includes('dsh-session-persistence-jsonl')) patchRelationships(path)
  }
}

walk(root)
for (const file of touched) process.stdout.write('[dsh-local-session-compat] patched ' + file + '\n')
