#!/usr/bin/env node
/**
 * Pin `auto: false` on every `compaction-basic` row declared inside our own
 * profile presets, so the milestone flow is the only automatic path and the
 * policy is visible in the file it governs rather than only at launch time.
 *
 * Idempotent: a file that already carries the marker is left alone.
 */
const fs = require('node:fs')

const marker = 'compaction-policy: milestone-only'
const files = process.argv.slice(2)

if (files.length === 0) {
  console.error('usage: node apply-profile-milestone-policy.cjs <cordis.patch.yml> [...]')
  process.exit(2)
}

const rowPattern = /^([ \t]*)- id: compaction-basic\r?\n([ \t]*)name: '@deepseek-ai\/dsh-compaction-basic'[ \t]*$/gm

let changed = 0
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`skip (missing): ${file}`)
    continue
  }
  const before = fs.readFileSync(file, 'utf8')
  if (before.includes(marker)) {
    console.log(`already pinned: ${file}`)
    continue
  }
  let hits = 0
  const after = before.replace(rowPattern, (match, rowIndent, nameIndent) => {
    hits += 1
    return `${match}\n${nameIndent}config:\n${nameIndent}  auto: false # ${marker}`
  })
  if (hits === 0) {
    console.log(`no compaction-basic row: ${file}`)
    continue
  }
  fs.writeFileSync(file, after, 'utf8')
  changed += hits
  console.log(`pinned ${hits} row(s): ${file}`)
}
console.log(`sites changed: ${changed}`)
