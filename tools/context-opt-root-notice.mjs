import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { rpc } from './usage-runtime-rpc.mjs'

const directory = 'D:/dsh-test/docs/context-opt-20261001'
const output = `${directory}/dsh-root-notice-receipt.json`
try {
  await access(output)
  throw new Error('Notice receipt already exists; do not send a duplicate')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const noticePath = `${directory}/dsh-root-notice.md`
const bytes = await readFile(noticePath)
const requestId = randomUUID()
const sessionId = 'session-028e6f5b-1716-4c23-a232-af16d853d191'
const result = await rpc('session/prompt', { request: {
  requestId, sessionId, mode: 'queue',
  content: [{ type: 'text', text: bytes.toString('utf8') }],
  clientTimeZone: 'Asia/Shanghai',
} })
assert.equal(result.accepted, true)
const receipt = { version: 1, at: new Date().toISOString(), sessionId, requestId,
  mode: 'queue', accepted: true, processingConfirmed: false, noticePath,
  noticeSha256: createHash('sha256').update(bytes).digest('hex'),
  note: 'Queue acceptance is not proof of model processing. No steering or Team control operation.' }
await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ output, ...receipt }))
