import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildContextDelivery, committedContextCursor } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'

const scope = { member: 'alice', sessionId: 's' }
const baselineId = 'window:new'
const dispatch = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'r' }
const sha = (value) => createHash('sha256').update(value).digest('hex')

const identity = { id: 'identity:alice', revision: 1, priority: 0, required: true, safetyCritical: true,
  content: '[team identity update] 1\n' + 'role rule text. '.repeat(8) }
const task = { id: 'task:t1', revision: 2, priority: 5, required: true, safetyCritical: true,
  content: JSON.stringify({ id: 't1', goal: 'finish the 中文 deliverable '.repeat(6) }),
  fetch: { action: 'task_contract_get', task_id: 't1' } }
const optional = { id: 'room:x:m1', revision: 1, priority: 30, required: false, content: 'optional room note '.repeat(6) }
const requirement = (id, { revision = 1, priority = 8, size = 8 } = {}) => ({
  id: 'requirement:' + id, revision, priority, required: true,
  content: JSON.stringify({ requirementId: id, revision, text: 'keep the constraint verbatim. '.repeat(size) }),
  fetch: { action: 'requirements_snapshot', input: {} },
})
const compact = (source) => ({
  ...source,
  compactContent: JSON.stringify({ id: source.id, summary: 'short summary', fetch: source.fetch }),
})

test('reproduction: a baseline whose large required sources exceed the cap fails closed without compact forms', () => {
  const sources = [identity, task, requirement('r1', { size: 200 }), requirement('r2', { size: 200 }), requirement('r3', { size: 200 })]
  const result = buildContextDelivery({ ...scope, sources, baselineId, maxTokens: 2500 })
  assert.equal(result.failClosed, true)
  assert.equal(result.debt, true)
  assert.deepEqual(result.debtItems.map((row) => row.id), ['requirement:r2', 'requirement:r3'])
  assert.deepEqual(result.compacted, [])
})

test('compact fallback fits the baseline: the least urgent large requirement is compacted, the rest stay full', () => {
  const sources = [
    identity, task,
    compact(requirement('r1', { priority: 8, size: 200 })),
    compact(requirement('r2', { priority: 20, size: 200 })),
    compact(requirement('r3', { priority: 8, size: 4 })),
  ]
  const result = buildContextDelivery({ ...scope, sources, baselineId, maxTokens: 2500 })
  assert.equal(result.failClosed, false)
  assert.equal(result.debt, false)
  assert.deepEqual(result.debtItems, [])
  assert.deepEqual(result.compacted, ['requirement:r2'])
  assert.match(result.body, /\[requirement:r2@1 compact\]\n\{"id":"requirement:r2","summary":"short summary"/)
  assert.doesNotMatch(result.body, /"requirementId":"r2"/)
  const byId = Object.fromEntries(result.manifest.items.map((row) => [row.id, row]))
  assert.equal(byId['requirement:r2'].form, 'compact')
  assert.equal('form' in byId['requirement:r1'], false)
  assert.equal('form' in byId['requirement:r3'], false)
  assert.equal('form' in byId['identity:alice'], false)
  assert.ok(result.estimatedTokens <= 2500, 'estimatedTokens ' + result.estimatedTokens)
})

test('tie order: higher priority number is compacted first, then reverse id; compacted lists the selected forms', () => {
  const sources = [
    identity, task,
    compact(requirement('rA', { priority: 8, size: 200 })),
    compact(requirement('rB', { priority: 8, size: 200 })),
    compact(requirement('rC', { priority: 20, size: 4 })),
  ]
  const result = buildContextDelivery({ ...scope, sources, baselineId, maxTokens: 2500 })
  assert.equal(result.failClosed, false)
  assert.deepEqual(result.compacted, ['requirement:rB', 'requirement:rC'])
  assert.equal('form' in result.manifest.items.find((row) => row.id === 'requirement:rA'), false)
})

test('compact forms keep the full-content hash, so a later delta does not resend them', () => {
  const pressed = [identity, task, compact(requirement('r1', { size: 200 })), compact(requirement('r2', { priority: 20, size: 200 })), requirement('r3', { size: 4 })]
  const compactRun = buildContextDelivery({ ...scope, sources: pressed, baselineId, maxTokens: 2500 })
  assert.deepEqual(compactRun.compacted, ['requirement:r2'])
  const full = [identity, task, requirement('r1', { size: 200 }), requirement('r2', { priority: 20, size: 200 }), requirement('r3', { size: 4 })]
  const fullRun = buildContextDelivery({ ...scope, sources: full, baselineId, maxTokens: 12000 })
  assert.equal(fullRun.failClosed, false)
  assert.deepEqual(fullRun.compacted, [])
  const fullHashes = Object.fromEntries(fullRun.manifest.items.map((row) => [row.id, row.hash]))
  for (const row of compactRun.manifest.items) assert.equal(row.hash, fullHashes[row.id], row.id)
  assert.equal(compactRun.manifest.bindingHash, fullRun.manifest.bindingHash)
  assert.deepEqual(compactRun.manifest.required, fullRun.manifest.required)

  const cursor = committedContextCursor(null, [], compactRun.manifest, { ...scope, dispatch })
  assert.equal(cursor.baselineId, baselineId)
  assert.equal(cursor.versions['requirement:r2'], fullHashes['requirement:r2'])
  const next = buildContextDelivery({ ...scope, sources: pressed, acknowledged: [cursor], baselineId, maxTokens: 2500 })
  assert.deepEqual(next.manifest.items, [])
  assert.equal(next.body, '')
  assert.equal(next.debt, false)
})

test('the same inputs produce the same output on every call', () => {
  const build = () => buildContextDelivery({ ...scope, baselineId, maxTokens: 2500,
    sources: [identity, task, compact(requirement('r1', { size: 200 })), compact(requirement('r2', { priority: 20, size: 200 })), requirement('r3', { size: 4 })] })
  assert.deepEqual(build(), build())
})

test('regression: when every required source fits in full, compact forms change neither body nor manifest', () => {
  const plain = [identity, task, requirement('r1', { revision: 3, size: 20 }), requirement('r2', { revision: 1, size: 30 }), optional]
  const withCompact = [identity, task, compact(requirement('r1', { revision: 3, size: 20 })), compact(requirement('r2', { revision: 1, size: 30 })), optional]
  for (const extra of [{ baselineId }, {}]) {
    const a = buildContextDelivery({ ...scope, sources: plain, maxTokens: 12000, ...extra })
    const b = buildContextDelivery({ ...scope, sources: withCompact, maxTokens: 12000, ...extra })
    assert.equal(b.body, a.body)
    assert.deepEqual(b.manifest, a.manifest)
    assert.deepEqual(b.compacted, [])
    assert.deepEqual(a.compacted, [])
  }
})

test('regression pin: full-fit output matches the pre-change module byte for byte', () => {
  const sources = [identity, task, requirement('r1', { revision: 3, size: 20 }), requirement('r2', { revision: 1, size: 30 }), optional]
  const withBaseline = buildContextDelivery({ ...scope, sources, maxTokens: 12000, baselineId })
  assert.equal(sha(withBaseline.body), '29fc99422d926fd73994285635ae1a02824f96a2f8d946a9e6b3459130f44bed')
  assert.equal(sha(JSON.stringify(withBaseline.manifest)), 'e873ba7e54036a96841c51ffb08abe16a8aa8af8097ab76c62e7f0fbe052e390')
  const noBaseline = buildContextDelivery({ ...scope, sources, maxTokens: 12000 })
  assert.equal(sha(noBaseline.body), '1b7199be986efa77f0c4147cf5ae8fec77ff812de8cb5650676b91f0d9657ec1')
  assert.equal(sha(JSON.stringify(noBaseline.manifest)), '5f9c9653dac35feda6916f6eb2f3691e618b32d6c67c98e0b7e955602042ce86')
})

test('safety-critical sources are never compacted, even when they carry a compact form', () => {
  const bigIdentity = { ...identity, content: '[team identity update] 1\n' + 'role rule text. '.repeat(200), compactContent: 'short identity' }
  const sources = [bigIdentity, compact(requirement('r1', { size: 200 }))]
  const result = buildContextDelivery({ ...scope, sources, baselineId, maxTokens: 300 })
  assert.deepEqual(result.compacted, ['requirement:r1'])
  assert.equal(result.failClosed, true)
  assert.deepEqual(result.debtItems.map((row) => [row.id, row.safetyCritical]), [['identity:alice', true]])
  assert.doesNotMatch(result.body, /short identity/)
})

test('a required source still omitted after every compact form is debt, and fails closed with a baseline', () => {
  const bulky = 'summary '.repeat(200)
  const sources = [
    identity, task,
    { ...requirement('r1', { size: 200 }), compactContent: bulky },
    { ...requirement('r2', { size: 200 }), compactContent: bulky },
    optional,
  ]
  const result = buildContextDelivery({ ...scope, sources, baselineId, maxTokens: 800 })
  assert.equal(result.failClosed, true)
  assert.equal(result.debt, true)
  assert.deepEqual(result.compacted, ['requirement:r1'])
  assert.deepEqual(result.debtItems.map((row) => row.id), ['requirement:r2'])
  assert.equal(result.debtItems[0].fetch.action, 'requirements_snapshot')
  assert.equal(result.manifest.items.some((row) => row.id === 'room:x:m1'), false)
})

test('without a baseline the compact fallback runs before debt is judged', () => {
  const plain = buildContextDelivery({ ...scope, sources: [requirement('r1', { size: 200 })], maxTokens: 1000 })
  assert.equal(plain.debt, true)
  assert.equal(plain.failClosed, false)
  assert.deepEqual(plain.compacted, [])

  const fallback = buildContextDelivery({ ...scope, sources: [compact(requirement('r1', { size: 200 }))], maxTokens: 1000 })
  assert.equal(fallback.debt, false)
  assert.equal(fallback.failClosed, false)
  assert.deepEqual(fallback.compacted, ['requirement:r1'])
  assert.match(fallback.body, /\[requirement:r1@1 compact\]/)
})
