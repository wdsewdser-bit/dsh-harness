import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createObservation, projectMessages } from '../home/profiles/web/plugins/observation-pack-v2.mjs'
import { buildBoundedInput } from '../home/profiles/web/plugins/evidence-reducer.mjs'
import { acquireWorkspaceLock } from '../home/profiles/web/plugins/action-fusion-v2.mjs'

test('observation keys are session scoped and missing call ids stay traceable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-obs-'))
  try {
    const observation = createObservation({ toolName: 'read', blocks: [{ type: 'text', text: 'x'.repeat(12000) }], spillDir: dir, previewBytes: 100, evidenceChars: 100 })
    assert.match(observation.callId, /^generated:/)
    observation.fullSends = 0
    const map = new Map([['s1\0' + observation.callId, observation]])
    const first = projectMessages([{ role: 'toolResult', toolCallId: observation.callId, content: [{ type: 'text', text: observation.text }] }], map, 's1')
    assert.equal(first.changed, 1)
    const second = projectMessages([{ role: 'toolResult', toolCallId: observation.callId, content: [{ type: 'text', text: observation.text }] }], map, 's2')
    assert.equal(second.changed, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('reducer input is bounded and reports scanned ranges and fallback', () => {
  const source = Array.from({ length: 100 }, (_, i) => i === 77 ? 'ERROR decisive failure' : `line ${i}` ).join('\n')
  const bounded = buildBoundedInput(source, { maxInputBytes: 300, maxInputLines: 20 })
  assert.ok(Buffer.byteLength(bounded.text, 'utf8') <= 300)
  assert.ok(bounded.scannedRanges.length > 0)
  assert.equal(bounded.fallbackReason, 'bounded-input-truncated')
  assert.match(bounded.text, /ERROR decisive failure/)
})

test('workspace lock queues briefly then fails open after bounded wait', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-lock-'))
  try {
    const release = await acquireWorkspaceLock(dir, 'workspace:test', 60000, 100, 10)
    assert.equal(typeof release, 'function')
    let queued = 0
    const blocked = await acquireWorkspaceLock(dir, 'workspace:test', 60000, 40, 10, () => { queued += 1 })
    assert.equal(blocked, undefined)
    assert.equal(queued, 1)
    release()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
