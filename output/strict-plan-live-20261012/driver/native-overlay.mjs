// Preload (node --import) that serves three staging native files in place of the production ones, without writing to production.
// Hook: node:module registerHooks (synchronous, in-thread). Preloaded through NODE_OPTIONS so worker threads that inherit it are covered too.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { threadId } from 'node:worker_threads'

const staging = 'D:/dsh-test/staging/context-runtime-unified-20261001'
const prod = 'D:/dsh-test'
const targets = [
  '/@deepseek-ai/dsh-goal/lib/index.js',
  '/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
  '/@deepseek-ai/dsh-session/lib/index.js',
]
const logFile = process.env.STRICT_PLAN_OVERLAY_LOG
if (!logFile) throw new Error('STRICT_PLAN_OVERLAY_LOG_REQUIRED')
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex').toUpperCase()
const norm = text => text.replaceAll('\\', '/')

// Preconditions: staging files are exactly the manifest's "after"; production files carry no requiresPlan.
const manifest = JSON.parse(fs.readFileSync(staging + '/native-change-manifest.json', 'utf8'))
const replacement = new Map()
for (const suffix of targets) {
  const file = staging + '/app/node_modules' + suffix
  const buffer = fs.readFileSync(file)
  const hash = sha(buffer)
  const rows = manifest.filter(row => row.path && norm(row.path).toLowerCase() === file.toLowerCase())
  if (rows.length !== 1) throw new Error('OVERLAY_MANIFEST_ROW_COUNT ' + suffix + ' ' + rows.length)
  if (rows[0].after.toUpperCase() !== hash) throw new Error('OVERLAY_STAGING_HASH_MISMATCH ' + suffix + ' ' + hash + ' != ' + rows[0].after)
  const production = fs.readFileSync(prod + '/app/node_modules' + suffix, 'utf8')
  if (production.includes('requiresPlan')) throw new Error('OVERLAY_PRODUCTION_ALREADY_HAS_requiresPlan ' + suffix)
  replacement.set(suffix, { file, hash, source: buffer.toString('utf8') })
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.startsWith('file:')) return result
    const normalized = norm(fileURLToPath(url))
    const suffix = targets.find(item => normalized.endsWith(item))
    if (!suffix) return result
    const row = replacement.get(suffix)
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, threadId, url, suffix, format: result.format, stagingFile: row.file, stagingSha256: row.hash }) + '\n')
    return { ...result, source: row.source, shortCircuit: true }
  },
})
fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, threadId, event: 'overlay-registered', files: [...replacement].map(([suffix, row]) => ({ suffix, sha256: row.hash })) }) + '\n')
