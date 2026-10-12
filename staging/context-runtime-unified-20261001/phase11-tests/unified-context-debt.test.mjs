import test from 'node:test'
import assert from 'node:assert/strict'
import { buildContextDelivery, committedContextCursor, durableContextVersions, visibleContextVersions } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'

const scope = { member: 'member-a', sessionId: 'session-a' }
const dispatch = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'request-1' }
const source = { id: 'requirement:long', revision: 4, required: true, content: 'required middle constraint '.repeat(160), fetch: { action: 'requirements_get', id: 'long' } }
const visible = (delivery, override = {}) => [{ source: { kind: 'team-message', plugin: 'team-v12-runtime' }, content: [{ type: 'text', text: delivery.body }], ...override }]

test('notice-only receipt cannot retire content in visible or durable history', () => {
  const small = buildContextDelivery({ sources: [source], maxTokens: 256, ...scope })
  assert.equal(small.manifest.items.length, 0)
  assert.equal(small.manifest.debt.length, 1)
  const receipts = [{ ...scope, items: small.manifest.items, debt: small.manifest.debt }]
  assert.equal(visibleContextVersions(visible(small), scope).has(source.id), false)
  assert.equal(durableContextVersions(receipts, scope).has(source.id), false)
  const full = buildContextDelivery({ sources: [source], visible: visible(small), acknowledged: receipts, maxTokens: 12000, ...scope })
  assert.equal(full.manifest.items.length, 1)
  assert.match(full.body, /required middle constraint/)
  assert.equal(full.debt, false)
})

test('legacy versions-only cursors are unknown until item receipts prove content', () => {
  const small = buildContextDelivery({ sources: [source], maxTokens: 256, ...scope })
  const hash = small.manifest.debt[0].hash
  const legacy = { ...scope, versions: { [source.id]: hash } }
  assert.equal(durableContextVersions([legacy], scope).size, 0)
  const cursor = committedContextCursor(legacy, [], small.manifest, scope)
  assert.equal(cursor.contentReceiptVersion, 3)
  assert.equal(cursor.versions[source.id], undefined)
  assert.equal(cursor.noticeVersions[source.id], hash)
  const full = buildContextDelivery({ sources: [source], acknowledged: [cursor], maxTokens: 12000, ...scope })
  assert.equal(full.manifest.items.length, 1)
  const unhanded = committedContextCursor(cursor, [], full.manifest, scope)
  assert.equal(unhanded.versions[source.id], undefined)
  const next = committedContextCursor(cursor, [], full.manifest, { ...scope, dispatch })
  assert.equal(next.versions[source.id], hash)
  assert.equal(next.noticeVersions[source.id], undefined)
  assert.equal(buildContextDelivery({ sources: [source], acknowledged: [next], maxTokens: 12000, ...scope }).body, '')
})

test('history receipts stay unknown; migration replays actual dispatch and isolates scope', () => {
  const full = buildContextDelivery({ sources: [source], maxTokens: 12000, ...scope })
  const historyOnly = [{ ...scope, items: full.manifest.items }]
  assert.equal(durableContextVersions(historyOnly, scope).size, 0)
  assert.equal(durableContextVersions([{ ...scope, contentReceiptVersion: 2, versions: { wrong: 'history-hash' } }], scope).size, 0)
  const receipts = [{ ...scope, dispatch, items: full.manifest.items }]
  const cursor = committedContextCursor({ ...scope, versions: { wrong: 'debt-hash' } }, receipts, null, scope)
  assert.equal(cursor.versions[source.id], full.manifest.items[0].hash)
  assert.equal(cursor.versions.wrong, undefined)
  const foreign = buildContextDelivery({ sources: [source], maxTokens: 12000, member: 'other', sessionId: 'other' })
  const result = buildContextDelivery({ sources: [source], visible: visible(foreign), maxTokens: 12000, ...scope })
  assert.equal(result.manifest.items.length, 1)
  assert.equal(visibleContextVersions(visible(full, { source: { kind: 'user' } }), scope).size, 0)
})
