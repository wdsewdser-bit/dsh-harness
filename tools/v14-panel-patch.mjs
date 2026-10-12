import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [base, packageRoot, patchFile, lockFile] = process.argv.slice(2)
if (![base, packageRoot, patchFile, lockFile].every(Boolean)) {
  throw new Error('usage: node v14-panel-patch.mjs <original-package-dir> <patched-package-dir> <patch-file> <pnpm-lock>')
}
const chunks = []
for (const relative of ['lib/client.js', 'package.json']) {
  const result = spawnSync('git', ['diff', '--no-index', '--', join(base, relative), join(packageRoot, relative)], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  if (result.status !== 1) throw new Error(`git diff ${relative}: ${result.stderr || result.status}`)
  const lines = result.stdout.replace(/\r\n/g, '\n').split('\n')
  lines[0] = `diff --git a/${relative} b/${relative}`
  lines[2] = `--- a/${relative}`
  lines[3] = `+++ b/${relative}`
  chunks.push(lines.join('\n').trimEnd() + '\n')
}
const patch = chunks.join('')
const oldHash = createHash('sha256').update(readFileSync(patchFile)).digest('hex')
const newHash = createHash('sha256').update(patch).digest('hex')
const lock = readFileSync(lockFile, 'utf8')
const matches = lock.match(new RegExp(oldHash, 'g')) ?? []
if (matches.length < 2) throw new Error('expected UI patch hash in lockfile')
writeFileSync(patchFile, patch, 'utf8')
writeFileSync(lockFile, lock.replaceAll(oldHash, newHash), 'utf8')
process.stdout.write(`UI patch ${oldHash} -> ${newHash}; lock references ${matches.length}\n`)
