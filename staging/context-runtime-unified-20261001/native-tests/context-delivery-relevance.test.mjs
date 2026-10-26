import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContextDelivery, committedContextCursor, durableContextVersions, durableCompactVersions, CONTEXT_MARKER,
} from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'
import { memberTaskUse, requirementCompactRank } from '../home/profiles/web/plugins/team-v12-runtime.mjs'

const scope = { member: 'alice', sessionId: 's' }
const baselineId = 'window:new'
const dispatch = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'r' }

const identity = { id: 'identity:alice', revision: 1, priority: 0, required: true, safetyCritical: true,
  content: '[team identity update] 1\n' + 'role rule text. '.repeat(8) }
const task = { id: 'task:t1', revision: 2, priority: 5, required: true, safetyCritical: true,
  content: JSON.stringify({ id: 't1', goal: 'finish the 中文 deliverable '.repeat(6) }),
  fetch: { action: 'task_contract_get', task_id: 't1' } }
const requirement = (id, { revision = 1, priority = 8, size = 8, ...extra } = {}) => ({
  id: 'requirement:' + id, revision, priority, required: true,
  content: JSON.stringify({ requirementId: id, revision, text: 'keep the constraint verbatim. '.repeat(size) }),
  fetch: { action: 'requirements_snapshot', input: {} },
  ...extra,
})
const compact = (source) => ({
  ...source,
  compactContent: JSON.stringify({ id: source.id, summary: 'short summary', fetch: source.fetch }),
})
const formOf = (result, id) => result.manifest.items.find((row) => row.id === id)?.form
const commit = (previous, manifest) => committedContextCursor(previous, [], manifest, { ...scope, dispatch })
const receiptOf = (manifest) => ({ ...scope, baselineId: manifest.baselineId ?? null, items: manifest.items, dispatch })

// Same pressure shape as the compact fallback tests: two large requirements cannot both stay full at 2500 tokens.
const pressed = (overrides = {}) => [
  identity, task,
  compact(requirement('rA', { size: 200, ...overrides.rA })),
  compact(requirement('rB', { size: 200, ...overrides.rB })),
  compact(requirement('rC', { size: 4, ...overrides.rC })),
]

test('without compactRank the order is unchanged; an explicit equal rank on every source changes nothing', () => {
  const plain = buildContextDelivery({ ...scope, sources: pressed(), baselineId, maxTokens: 2500 })
  assert.deepEqual(plain.compacted, ['requirement:rB', 'requirement:rC'])
  const zero = buildContextDelivery({ ...scope, baselineId, maxTokens: 2500,
    sources: pressed({ rA: { compactRank: 0 }, rB: { compactRank: 0 }, rC: { compactRank: 0 } }) })
  assert.equal(zero.body, plain.body)
  assert.deepEqual(zero.manifest, plain.manifest)
  const same = buildContextDelivery({ ...scope, baselineId, maxTokens: 2500,
    sources: pressed({ rA: { compactRank: 1 }, rB: { compactRank: 1 }, rC: { compactRank: 1 } }) })
  assert.deepEqual(same.compacted, plain.compacted)
})

test('a higher compactRank is compacted first and a rank 0 source keeps its full text', () => {
  const result = buildContextDelivery({ ...scope, baselineId, maxTokens: 2500,
    sources: pressed({ rA: { compactRank: 2 }, rB: { compactRank: 0 }, rC: { compactRank: 1 } }) })
  assert.equal(result.failClosed, false)
  assert.equal(result.debt, false)
  assert.deepEqual(result.compacted, ['requirement:rA'])
  assert.equal(formOf(result, 'requirement:rA'), 'compact')
  assert.equal(formOf(result, 'requirement:rB'), undefined)
  assert.equal(formOf(result, 'requirement:rC'), undefined)
  assert.match(result.body, /"requirementId":"rB"/)
})

test('rank is only the first key: equal ranks fall back to priority number, then reverse id', () => {
  const result = buildContextDelivery({ ...scope, baselineId, maxTokens: 2500,
    sources: pressed({ rA: { compactRank: 1, priority: 8 }, rB: { compactRank: 1, priority: 8 }, rC: { compactRank: 1, priority: 20 } }) })
  assert.deepEqual(result.compacted, ['requirement:rB', 'requirement:rC'])
})

test('rank never compacts a safety-critical source or a source without a compact form', () => {
  const sources = [{ ...identity, compactRank: 9, compactContent: 'short identity' }, task,
    requirement('rA', { size: 200, compactRank: 9 }),
    compact(requirement('rB', { size: 200, compactRank: 0 }))]
  const result = buildContextDelivery({ ...scope, sources, baselineId, maxTokens: 2500 })
  assert.deepEqual(result.compacted, ['requirement:rB'])
  assert.equal(formOf(result, 'identity:alice'), undefined)
  assert.equal(formOf(result, 'requirement:rA'), undefined)
})

// A baseline that had to compact rB, then the committed cursor.
const compactedBaseline = () => {
  const first = buildContextDelivery({ ...scope, baselineId, maxTokens: 2500,
    sources: pressed({ rA: { compactRank: 2 }, rB: { compactRank: 2 }, rC: { compactRank: 0 } }) })
  assert.deepEqual(first.compacted, ['requirement:rB'])
  return first
}

test('a source last delivered compact and now wantFull comes back in full, with no compact mark', () => {
  const first = compactedBaseline()
  const wanted = first.compacted[0]
  const cursor = commit(null, first.manifest)
  assert.equal(cursor.compactVersions[wanted], first.manifest.items.find((row) => row.id === wanted).hash)
  const sources = pressed({ rA: { compactRank: 2 }, rB: { compactRank: 2 }, rC: { compactRank: 0 } })
    .map((source) => (source.id === wanted ? { ...source, wantFull: true } : source))

  const quiet = buildContextDelivery({ ...scope, sources: pressed(), acknowledged: [cursor], baselineId, maxTokens: 12000 })
  assert.deepEqual(quiet.manifest.items, [])
  const next = buildContextDelivery({ ...scope, sources, acknowledged: [cursor], baselineId, maxTokens: 12000 })
  assert.deepEqual(next.manifest.items.map((row) => row.id), [wanted])
  assert.equal('form' in next.manifest.items[0], false)
  assert.deepEqual(next.compacted, [])
  assert.equal(next.debt, false)
  assert.equal(next.failClosed, false)
  assert.equal(next.manifest.baselineId, baselineId)
  assert.doesNotMatch(next.body, / compact\]/)

  // Once the full form is committed it is known, so the next turn does not resend it.
  const after = commit(cursor, next.manifest)
  assert.equal(after.compactVersions?.[wanted], undefined)
  const again = buildContextDelivery({ ...scope, sources, acknowledged: [after], baselineId, maxTokens: 12000 })
  assert.deepEqual(again.manifest.items, [])
  assert.equal(again.body, '')
})

test('the compact mark is read from item receipts as well as from the cursor', () => {
  const first = compactedBaseline()
  const wanted = first.compacted[0]
  const sources = pressed({ rA: { compactRank: 2 }, rB: { compactRank: 2 }, rC: { compactRank: 0 } })
    .map((source) => (source.id === wanted ? { ...source, wantFull: true } : source))
  const receipts = [receiptOf(first.manifest)]
  assert.equal(durableCompactVersions(receipts, { ...scope, epochId: baselineId }).has(wanted), true)
  const next = buildContextDelivery({ ...scope, sources, acknowledged: receipts, baselineId, maxTokens: 12000 })
  assert.deepEqual(next.manifest.items.map((row) => row.id), [wanted])
  assert.equal(formOf(next, wanted), undefined)
  const both = [...receipts, receiptOf(next.manifest)]
  assert.equal(durableCompactVersions(both, { ...scope, epochId: baselineId }).has(wanted), false)
  assert.equal(buildContextDelivery({ ...scope, sources, acknowledged: both, baselineId, maxTokens: 12000 }).body, '')
})

test('a resend that does not fit in the budget is dropped: no debt, no failClosed, state stays compact', () => {
  const first = compactedBaseline()
  const wanted = first.compacted[0]
  const cursor = commit(null, first.manifest)
  const sources = pressed({ rA: { compactRank: 2 }, rB: { compactRank: 2 }, rC: { compactRank: 0 } })
    .map((source) => (source.id === wanted ? { ...source, wantFull: true } : source))
  for (const extra of [{ baselineId }, {}]) {
    const tight = buildContextDelivery({ ...scope, sources, acknowledged: [cursor], maxTokens: 300, ...extra })
    assert.equal(tight.debt, false, JSON.stringify(extra))
    assert.equal(tight.failClosed, false, JSON.stringify(extra))
    assert.deepEqual(tight.debtItems, [])
    assert.deepEqual(tight.manifest.items, [])
    assert.equal(tight.manifest.debt, undefined)
    assert.equal(tight.body, '')
    const dropped = tight.omitted.find((row) => row.id === wanted)
    assert.equal(dropped?.required, false)
  }
  // Nothing was recorded, so the compact state survives and a later roomy turn still resends it.
  assert.equal(durableCompactVersions([cursor], { ...scope, epochId: baselineId }).has(wanted), true)
  const roomy = buildContextDelivery({ ...scope, sources, acknowledged: [cursor], baselineId, maxTokens: 12000 })
  assert.deepEqual(roomy.manifest.items.map((row) => row.id), [wanted])
})

test('a resend yields to a required source that changed, which is never starved by it', () => {
  const first = compactedBaseline()
  const wanted = first.compacted[0]
  const cursor = commit(null, first.manifest)
  const sources = pressed({ rA: { compactRank: 2 }, rB: { compactRank: 2 }, rC: { compactRank: 0 } })
    .map((source) => (source.id === wanted ? { ...source, wantFull: true } : source))
    .map((source) => (source.id === 'requirement:rC' ? { ...source, revision: 2 } : source))
  const result = buildContextDelivery({ ...scope, sources, acknowledged: [cursor], baselineId, maxTokens: 600 })
  assert.deepEqual(result.manifest.items.map((row) => row.id), ['requirement:rC'])
  assert.equal(result.failClosed, false)
  assert.equal(result.debt, false)
})

test('full delivery is never resent for wantFull, and a changed hash is an ordinary required update', () => {
  const full = [identity, task, requirement('rA', { size: 20, compactRank: 0, wantFull: true })]
  const first = buildContextDelivery({ ...scope, sources: full, baselineId, maxTokens: 12000 })
  assert.equal(first.manifest.items.length, 3)
  const cursor = commit(null, first.manifest)
  assert.equal(cursor.compactVersions, undefined)
  const same = buildContextDelivery({ ...scope, sources: full, acknowledged: [cursor], baselineId, maxTokens: 12000 })
  assert.deepEqual(same.manifest.items, [])
  assert.equal(same.body, '')

  // The compacted hash is stale once the revision moves: that is a normal required update and may fail closed.
  const stale = buildContextDelivery({ ...scope, baselineId, maxTokens: 600, acknowledged: [cursor],
    sources: [identity, task, requirement('rA', { size: 200, revision: 2, compactRank: 0, wantFull: true })] })
  assert.equal(stale.debt, true)
  assert.equal(stale.failClosed, true)
})

test('baseline delivery keeps its rule when wantFull is set: required, compacted if needed, else fail closed', () => {
  const sources = pressed({ rA: { compactRank: 0, wantFull: true }, rB: { compactRank: 0, wantFull: true } })
  const forced = buildContextDelivery({ ...scope, sources, baselineId, force: true, maxTokens: 2500 })
  assert.equal(forced.failClosed, false)
  assert.ok(forced.compacted.length > 0)
  assert.ok(forced.manifest.items.some((row) => row.id === 'requirement:rA'))
  const bare = [identity, task, requirement('rA', { size: 200, wantFull: true, compactRank: 0 })]
  const closed = buildContextDelivery({ ...scope, sources: bare, baselineId, force: true, maxTokens: 600 })
  assert.equal(closed.failClosed, true)
  assert.deepEqual(closed.debtItems.map((row) => row.id), ['requirement:rA'])
  // The binding is computed from full content and does not see the resend flag.
  assert.deepEqual(forced.manifest.required, buildContextDelivery({ ...scope, baselineId, force: true, maxTokens: 12000, sources: pressed() }).manifest.required)
})

test('a visible compact delivery (no baseline) is resent the same way', () => {
  const first = buildContextDelivery({ ...scope, maxTokens: 1000, sources: [compact(requirement('r1', { size: 200 }))] })
  assert.deepEqual(first.compacted, ['requirement:r1'])
  const message = { source: { kind: 'team-message', plugin: 'team-v12-runtime' }, content: [{ type: 'text', text: first.body }] }
  assert.ok(first.body.startsWith(CONTEXT_MARKER))
  const wanted = [compact(requirement('r1', { size: 200, wantFull: true }))]
  const idle = buildContextDelivery({ ...scope, maxTokens: 12000, visible: [message], sources: [compact(requirement('r1', { size: 200 }))] })
  assert.deepEqual(idle.manifest.items, [])
  const next = buildContextDelivery({ ...scope, maxTokens: 12000, visible: [message], sources: wanted })
  assert.deepEqual(next.manifest.items.map((row) => row.id), ['requirement:r1'])
  assert.equal(formOf(next, 'requirement:r1'), undefined)
  const none = buildContextDelivery({ ...scope, maxTokens: 12000, visible: [message, { ...message, content: [{ type: 'text', text: next.body }] }], sources: wanted })
  assert.deepEqual(none.manifest.items, [])
})

test('compact marks follow the latest confirmed delivery and ignore unconfirmed or foreign rows', () => {
  const item = (form) => ({ id: 'requirement:r1', hash: 'h1', ...(form ? { form } : {}) })
  const row = (items, extra = {}) => ({ ...scope, baselineId, items, dispatch, ...extra })
  const opts = { ...scope, epochId: baselineId }
  assert.equal(durableCompactVersions([row([item('compact')])], opts).get('requirement:r1'), 'h1')
  assert.equal(durableCompactVersions([row([item('compact')]), row([item()])], opts).has('requirement:r1'), false)
  assert.equal(durableCompactVersions([row([item()]), row([item('compact')])], opts).has('requirement:r1'), true)
  assert.equal(durableCompactVersions([row([item('compact')], { dispatch: null })], opts).has('requirement:r1'), false)
  assert.equal(durableCompactVersions([row([item('compact')], { member: 'bob' })], opts).has('requirement:r1'), false)
  assert.equal(durableCompactVersions([row([item('compact')], { baselineId: 'window:old' })], opts).has('requirement:r1'), false)
  assert.equal(durableContextVersions([row([item('compact')])], opts).get('requirement:r1'), 'h1')
  // A cursor restating the same hash does not override what the receipts established.
  const cursor = { ...scope, epochId: baselineId, contentReceiptVersion: 3, versions: { 'requirement:r1': 'h1' }, compactVersions: { 'requirement:r1': 'h1' } }
  assert.equal(durableCompactVersions([row([item()]), cursor], opts).has('requirement:r1'), false)
  assert.equal(durableCompactVersions([cursor], opts).has('requirement:r1'), true)
})

const taskRow = (id, extra = {}) => ({ id, status: 'in_progress', ownerName: 'alice', ...extra })

test('memberTaskUse: owned active tasks are in use, finished tasks are ended, other members tasks are neutral', () => {
  const use = memberTaskUse({ tasks: [
    taskRow('t-own'),
    taskRow('t-done', { status: 'completed' }),
    taskRow('t-accepted', { phase: 'accepted' }),
    taskRow('t-cancelled', { status: 'pending', phase: 'cancelled' }),
    taskRow('t-bob', { ownerName: 'bob' }),
    { id: 't-contract', status: 'pending', contract: { owner: 'alice' } },
    taskRow('t-deleted', { status: 'deleted' }),
  ] }, 'alice')
  assert.deepEqual([...use.inUse].sort(), ['t-contract', 't-own'])
  assert.deepEqual([...use.ended].sort(), ['t-accepted', 't-cancelled', 't-deleted', 't-done'])
})

test('memberTaskUse: unfinished dispatches and active leases for the member count; finished or foreign ones do not', () => {
  const tasks = [taskRow('t1', { ownerName: 'bob' }), taskRow('t2', { ownerName: 'bob' }), taskRow('t3', { ownerName: 'bob' }),
    taskRow('t4', { ownerName: 'bob' }), taskRow('t5', { ownerName: 'bob' }), taskRow('t6', { ownerName: 'bob', status: 'completed' })]
  const dispatches = {
    d1: { dispatchId: 'd1', target: 'alice', taskId: 't1', status: 'queued' },
    d2: { dispatchId: 'd2', target: 'alice', taskId: 't2', status: 'completed' },
    d3: { dispatchId: 'd3', target: 'carol', taskId: 't3', status: 'queued' },
    d4: { dispatchId: 'd4', target: 'alice', taskId: null, status: 'queued' },
    d5: { dispatchId: 'd5', target: 'alice', taskId: 't6', status: 'checkpointed' },
  }
  const leases = {
    l1: { runId: 'l1', member: 'alice', taskId: 't4', status: 'active' },
    l2: { runId: 'l2', member: 'alice', taskId: 't5', status: 'expired' },
  }
  const use = memberTaskUse({ tasks, dispatches, leases }, 'alice')
  assert.deepEqual([...use.inUse].sort(), ['t1', 't4', 't6'])
  // t6 is finished but still has an open dispatch for the member, so it counts as in use, not ended.
  assert.deepEqual([...use.ended], [])
  assert.deepEqual([...memberTaskUse({ tasks: Object.values(tasks), dispatches: Object.values(dispatches), leases: Object.values(leases) }, 'alice').inUse].sort(), ['t1', 't4', 't6'])
  assert.deepEqual(memberTaskUse(undefined, 'alice'), { inUse: new Set(), ended: new Set() })
})

test('requirementCompactRank: 0 when any task is in use, 2 when all are over, 1 otherwise', () => {
  const use = { inUse: new Set(['a']), ended: new Set(['x', 'y']) }
  assert.equal(requirementCompactRank(['a'], use), 0)
  assert.equal(requirementCompactRank(['x', 'a'], use), 0)
  assert.equal(requirementCompactRank(['x', 'y'], use), 2)
  assert.equal(requirementCompactRank(['x', 'unknown'], use), 1)
  assert.equal(requirementCompactRank(['unknown'], use), 1)
  assert.equal(requirementCompactRank([], use), 1)
  assert.equal(requirementCompactRank(undefined, use), 1)
  assert.equal(requirementCompactRank(['a'], undefined), 1)
})

const packet = (packetId, kind, taskIds, createdAt) => ({ packetId, kind, taskIds, ...(createdAt === undefined ? {} : { createdAt }) })

test('memberTaskUse: a submitted task (status completed, phase under review) still waits for acceptance', () => {
  const tasks = [taskRow('s1', { ownerName: 'bob', status: 'completed', phase: 'verifier-review' }),
    taskRow('s2', { ownerName: 'bob', status: 'completed', phase: 'accepted' }), taskRow('s3', { ownerName: 'bob', status: 'deleted', phase: 'room-discussion' })]
  const packets = [packet('p1', 'group-acceptance', ['s1'], 1), packet('p2', 'group-acceptance', ['s2'], 2), packet('p3', 'group-acceptance', ['s3'], 3)]
  const use = memberTaskUse({ tasks, packets }, 'verifier')
  assert.deepEqual([...use.inUse], ['s1'])
  assert.deepEqual([...use.ended].sort(), ['s2', 's3'])
})

test('memberTaskUse: a task whose latest packet is a group-acceptance is in use for any member', () => {
  const tasks = [taskRow('t1', { ownerName: 'bob' }), taskRow('t2', { ownerName: 'bob' }), taskRow('t3', { ownerName: 'bob' }),
    taskRow('t4', { ownerName: 'bob' }), taskRow('t5', { ownerName: 'bob', phase: 'accepted' })]
  const packets = {
    p1: packet('p1', 'group-acceptance', ['t1', 't4'], 10),
    p2: packet('p2', 'group-acceptance', ['t2'], 11),
    p3: packet('p3', 'verifier-review', ['t2'], 12),
    p4: packet('p4', 'group-acceptance', ['t3'], 13),
    p5: packet('p5', 'verifier-review', ['t3'], 14),
    'p4-r2': packet('p4-r2', 'group-acceptance', ['t3'], 15),
    p6: packet('p6', 'group-acceptance', ['t5'], 16),
    p7: packet('p7', 'verifier-review', ['t4'], 17),
  }
  const use = memberTaskUse({ tasks, packets }, 'verifier')
  // t1: acceptance only. t2: reviewed. t3: resubmitted after review. t4: reviewed by a later packet. t5: already accepted.
  assert.deepEqual([...use.inUse].sort(), ['t1', 't3'])
  assert.deepEqual([...use.ended], ['t5'])
  assert.equal(requirementCompactRank(['t1'], use), 0)
  assert.equal(requirementCompactRank(['t2'], use), 1)
  assert.equal(requirementCompactRank(['t5'], use), 2)
  assert.deepEqual([...memberTaskUse({ tasks, packets: Object.values(packets) }, 'verifier').inUse].sort(), ['t1', 't3'])
})

test('memberTaskUse: packet order follows createdAt, falls back to insertion order, and ignores missing packets', () => {
  const tasks = [taskRow('t1', { ownerName: 'bob' })]
  // Stored out of order: createdAt says the review came last.
  const reviewedLast = { a: packet('a', 'verifier-review', ['t1'], 20), b: packet('b', 'group-acceptance', ['t1'], 10) }
  assert.equal(memberTaskUse({ tasks, packets: reviewedLast }, 'v').inUse.has('t1'), false)
  // No timestamps: insertion order decides.
  const plain = { a: packet('a', 'verifier-review', ['t1']), b: packet('b', 'group-acceptance', ['t1']) }
  assert.equal(memberTaskUse({ tasks, packets: plain }, 'v').inUse.has('t1'), true)
  const base = memberTaskUse({ tasks: [taskRow('t1'), taskRow('t2', { ownerName: 'bob' })] }, 'alice')
  for (const packets of [undefined, null, {}, []]) {
    const use = memberTaskUse({ tasks: [taskRow('t1'), taskRow('t2', { ownerName: 'bob' })], packets }, 'alice')
    assert.deepEqual(use, base)
  }
  assert.deepEqual([...base.inUse], ['t1'])
  // Unrelated packet kinds and malformed rows change nothing.
  const noise = { x: packet('x', 'note', ['t2'], 5), y: null, z: { kind: 'group-acceptance' } }
  assert.deepEqual(memberTaskUse({ tasks: [taskRow('t1'), taskRow('t2', { ownerName: 'bob' })], packets: noise }, 'alice'), base)
})
