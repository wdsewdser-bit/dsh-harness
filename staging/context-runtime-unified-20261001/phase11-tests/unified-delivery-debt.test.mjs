import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectRuntimeDeliveryDebt, deliveryPendingInput, readDeliveryMilestones } from '../home/profiles/web/plugins/team-v15-delivery-debt.mjs'
import { collectDeliveryContext } from '../home/profiles/web/plugins/team-v15-delivery-source.mjs'
import { committedContextCursor } from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'
import { createHash } from 'node:crypto'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-debt-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'milestones.json')
  const doc = { version: 3, teams: { team: { compactions: {} } } }
  const write = value => writeFileSync(path, JSON.stringify(value))
  write(doc)
  const state = { rootId: 'team', boards: { b: { tasks: { task: { id: 'task', ownerName: 'alice' } } } },
    v12RoomWake: { version: 1, rooms: {}, inbox: {}, wakes: {} },
    v12Compaction: { version: 1, jobs: {} }, v12Requirements: { version: 1, requirements: {}, decisions: {} } }
  const plan = { planId: 'p', planRevision: 1, items: [{ taskRefs: [{ boardId: 'b', taskId: 'task' }] }] }
  const inputs = [{ member: 'root', sessionId: 's', nextStep: 0, nextTurn: 0, pendingNativeIds: [] },
    { member: 'alice', sessionId: 'a', nextStep: 0, nextTurn: 0, pendingNativeIds: [] }]
  const read = () => readDeliveryMilestones(path, { allowedRoots: [directory] })
  const collect = () => collectRuntimeDeliveryDebt(state, plan, { milestones: read(), inputs, member: 'root', sessionId: 's', now: 1000 })
  return { directory, path, doc, write, state, plan, inputs, read, collect }
}

test('clean authoritative stores return a source-bound snapshot without mutating the locked state', t => {
  const f = fixture(t), before = structuredClone(f.state)
  const first = f.collect()
  assert.deepEqual(first.unresolvedDebt, [])
  assert.deepEqual(first.blockers, [])
  assert.equal(first.authorityDebtSnapshot.sourceHash.length, 64)
  assert.deepEqual(f.state, before)
  f.state.v12Requirements.requirements.r = { requirementId: 'r', taskIds: ['task'], status: 'active', text: 'new exact constraint' }
  assert.notEqual(f.collect().authorityDebtSnapshot.sourceHash, first.authorityDebtSnapshot.sourceHash)
  f.state.v12Requirements = undefined
  assert.throws(f.collect, { code: 'DELIVERY_DEBT_STATE_INVALID' })
})

test('external missing, corrupt, unsupported, oversized and escaped sources fail closed', t => {
  const f = fixture(t)
  assert.throws(() => readDeliveryMilestones(), { code: 'DELIVERY_DEBT_SOURCE_UNAVAILABLE' })
  assert.throws(() => readDeliveryMilestones(join(f.directory, 'missing'), { allowedRoots: [f.directory] }), { code: 'DELIVERY_DEBT_SOURCE_UNAVAILABLE' })
  writeFileSync(f.path, '{bad json')
  assert.throws(f.read, { code: 'DELIVERY_DEBT_SOURCE_UNAVAILABLE' })
  f.write({ version: 1, teams: {} })
  assert.throws(f.read, { code: 'DELIVERY_DEBT_SOURCE_INVALID' })
  f.write(f.doc)
  assert.throws(() => readDeliveryMilestones(f.path, { allowedRoots: [f.directory], maxBytes: 1 }), { code: 'DELIVERY_DEBT_SOURCE_INVALID' })
  const outside = mkdtempSync(join(tmpdir(), 'delivery-debt-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'm.json'), JSON.stringify(f.doc))
  symlinkSync(outside, join(f.directory, 'escape'), 'junction')
  assert.throws(() => readDeliveryMilestones(join(f.directory, 'escape', 'm.json'), { allowedRoots: [f.directory] }), { code: 'DELIVERY_DEBT_SOURCE_DENIED' })
})

test('current-plan Room, waiting, compaction, plan-read and descendant input debt cannot be hidden by notices', t => {
  const f = fixture(t), w = f.state.v12RoomWake
  w.roomAccess = { room: { members: ['alice'] } }
  w.unresolved = { room: { u: { itemId: 'u', status: 'open' } } }
  w.decisions = { room: { d: { decisionId: 'd', status: 'confirmed', requiredConfirmations: ['alice'], confirmations: [] } } }
  w.inbox.i = { target: 'alice', taskId: 'task', status: 'injected' }
  w.wakes.w = { target: 'alice', taskId: 'task', status: 'delivered' }
  f.state.v14Waiting = { tickets: { t: { ticketId: 't', taskId: 'task', owner: 'alice', status: 'open', unblockCondition: { type: 'manual' } } } }
  f.state.v12Compaction.jobs.j = { owner: 'alice', taskId: 'task', status: 'running' }
  f.doc.teams.team.compactions.alice = { status: 'completed_with_debt', memoryDebt: { missing: ['constraint'], recoveryPromptedAt: 99 } }
  f.write(f.doc)
  f.inputs[1].nextStep = 1
  f.state.v15PlanReadReceipts = { r: { id: 'r', planId: 'p', planRevision: 1, requiredFetch: true } }
  const result = f.collect()
  for (const debt of ['inbox:i', 'wakes:w', 'decision-confirmation:room:d', 'compaction-job:j', 'compaction-memory:alice', 'pending-input:alice:a', 'plan-read:r']) {
    assert.ok(result.unresolvedDebt.includes(debt), debt)
  }
  assert.deepEqual(result.blockers, ['room-unresolved:room:u', 'waiting:t'])
})

test('unrelated plans and Teams do not silently become current-plan blockers or clear its debt', t => {
  const f = fixture(t)
  f.state.v12RoomWake.roomAccess = { other: { members: ['bob'] } }
  f.state.v12RoomWake.unresolved = { other: { u: { status: 'open' } } }
  f.state.v12RoomWake.inbox = { i: { target: 'alice', taskId: 'foreign', status: 'queued' } }
  f.state.v12Compaction.jobs = { j: { taskId: 'foreign', owner: 'alice', status: 'failed' } }
  f.doc.teams.other = { compactions: { alice: { status: 'completed_with_debt' } } }
  f.write(f.doc)
  assert.deepEqual(f.collect().unresolvedDebt, [])
  assert.deepEqual(f.collect().blockers, [])
})

test('only exact current-session dispatched body clears context fetch debt, not history or old versions', t => {
  const f = fixture(t), w = f.state.v12RoomWake
  f.state.v14DeliveryReceipts = [{ member: 'alice', sessionId: 'a', debt: [{ id: 'contract', hash: 'exact-hash' }] }]
  w.contextCursors = { a: { member: 'alice', sessionId: 'a', contentReceiptVersion: 2, versions: { contract: 'exact-hash' } } }
  const debt = 'context-fetch:alice:contract:exact-hash'
  assert.ok(f.collect().unresolvedDebt.includes(debt))
  f.state.v14DeliveryReceipts.push({ member: 'alice', sessionId: 'old', items: [{ id: 'contract', hash: 'exact-hash' }],
    dispatch: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'old' } })
  assert.ok(f.collect().unresolvedDebt.includes(debt))
  f.state.v14DeliveryReceipts.push({ member: 'alice', sessionId: 'a', items: [{ id: 'contract', hash: 'wrong-hash' }] })
  assert.ok(f.collect().unresolvedDebt.includes(debt))
  f.state.v14DeliveryReceipts.push({ member: 'alice', sessionId: 'a', items: [{ id: 'contract', hash: 'exact-hash' }],
    dispatch: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'current' } })
  assert.ok(!f.collect().unresolvedDebt.includes(debt))
})

test('a newer witnessed numeric source revision supersedes historical fetch debt without clearing the current revision', t => {
  const f = fixture(t)
  const receipt = value => ({ member: 'alice', sessionId: 'a', ...value })
  const dispatch = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'current' }
  f.state.v14DeliveryReceipts = [
    receipt({ debt: [{ id: 'contract', hash: 'old', revision: 1 }] }),
    receipt({ debt: [{ id: 'contract', hash: 'current', revision: 2 }] }),
  ]
  assert.deepEqual(f.collect().unresolvedDebt, ['context-fetch:alice:contract:current'])
  f.state.v14DeliveryReceipts.push(receipt({ items: [{ id: 'contract', hash: 'current', revision: 2 }], dispatch }))
  assert.deepEqual(f.collect().unresolvedDebt, [])
  f.state.v14DeliveryReceipts.push(receipt({ debt: [{ id: 'contract', hash: 'next', revision: 3 }] }))
  assert.deepEqual(f.collect().unresolvedDebt, ['context-fetch:alice:contract:next'])
  // Redispatching an old body cannot satisfy the new revision or retire its debt.
  f.state.v14DeliveryReceipts.push(receipt({ items: [{ id: 'contract', hash: 'old', revision: 1 }], dispatch }))
  assert.deepEqual(f.collect().unresolvedDebt, ['context-fetch:alice:contract:next'])
})

test('history-only items and opaque revision labels do not authorize supersession', t => {
  const f = fixture(t)
  f.state.v14DeliveryReceipts = [
    { member: 'alice', sessionId: 'a', debt: [{ id: 'contract', hash: 'required', revision: 1 }] },
    { member: 'alice', sessionId: 'a', items: [{ id: 'contract', hash: 'unhanded', revision: 2 }] },
    { member: 'alice', sessionId: 'a', debt: [{ id: 'identity', hash: 'opaque-required', revision: 'release-a' }] },
    { member: 'alice', sessionId: 'a', items: [{ id: 'identity', hash: 'other', revision: 'release-b' }],
      dispatch: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'unrelated' } },
  ]
  assert.deepEqual(f.collect().unresolvedDebt, ['context-fetch:alice:contract:required', 'context-fetch:alice:identity:opaque-required'])
})

test('supersession also reconciles a real v3 cursor retaining the old notice hash', t => {
  const f = fixture(t), member = 'alice', sessionId = 'a'
  const old = { debt: [{ id: 'contract', hash: 'old', revision: 1 }] }
  const current = { items: [{ id: 'contract', hash: 'current', revision: 2 }] }
  const dispatch = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'current' }
  const previous = committedContextCursor(undefined, [], old, { member, sessionId, dispatch })
  const receipts = [{ member, sessionId, ...old, dispatch }, { member, sessionId, ...current, dispatch }]
  const cursor = committedContextCursor(previous, receipts, current, { member, sessionId, dispatch })
  assert.equal(cursor.noticeVersions.contract, 'old')
  f.state.v14DeliveryReceipts = receipts
  f.state.v12RoomWake.contextCursors = { a: cursor }
  assert.deepEqual(f.collect().unresolvedDebt, [])
})

test('a complete current-epoch baseline retires old-window source debt; an unhanded baseline cannot', t => {
  const f = fixture(t), w = f.state.v12RoomWake
  w.contextEpochs = { a: { compactionId: 'epoch-2', endedAt: 200 } }
  const old = { member: 'alice', sessionId: 'a', baselineId: 'epoch-1', debt: [{ id: 'revoked-source', hash: 'old' }] }
  const current = { member: 'alice', sessionId: 'a', baselineId: 'epoch-2', bindingHash: 'source-binding',
    required: [{ id: 'current-source', hash: 'current' }], items: [{ id: 'current-source', hash: 'current' }],
    baselineComplete: true }
  f.state.v14DeliveryReceipts = [old, current]
  assert.ok(f.collect().unresolvedDebt.includes('context-fetch:alice:revoked-source:old'))
  current.dispatch = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'current-baseline' }
  assert.deepEqual(f.collect().unresolvedDebt, [])
})

test('accepted native input with missing or mismatched canonical admission remains pending', () => {
  const log = [{ type: 'native/input-accepted', data: { inputId: 'i', messageId: 'm' } }]
  const agent = { session: { id: 's', log }, inbox: { nextStep: [], nextTurn: [] } }
  assert.deepEqual(deliveryPendingInput(agent).pendingNativeIds, ['i'])
  log.push({ type: 'user/message', data: { id: 'foreign', source: { nativeInputId: 'i' } } })
  assert.deepEqual(deliveryPendingInput(agent).pendingNativeIds, ['i'])
  log.push({ type: 'user/message', data: { id: 'm', source: { nativeInputId: 'i' } } })
  assert.deepEqual(deliveryPendingInput(agent).pendingNativeIds, [])
  assert.throws(() => deliveryPendingInput({ session: { id: 's' } }), { code: 'DELIVERY_INPUT_STATE_UNAVAILABLE' })
})

test('a new compaction epoch and unavailable owner input state cannot reuse old body cursors to clear debt', t => {
  const f = fixture(t), w = f.state.v12RoomWake
  w.contextEpochs = { a: { compactionId: 'epoch-2', endedAt: 200 } }
  w.contextCursors = { a: { member: 'alice', sessionId: 'a', contentReceiptVersion: 3,
    versions: { contract: 'hash' }, noticeVersions: { contract: 'hash' }, baselineId: 'epoch-2' } }
  f.state.v14DeliveryReceipts = [{ member: 'alice', sessionId: 'a', committedAt: 100, baselineId: 'epoch-1',
    items: [{ id: 'contract', hash: 'hash' }], dispatch: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'old' } }]
  const debt = 'context-fetch:alice:contract:hash'
  assert.ok(f.collect().unresolvedDebt.includes(debt))
  assert.ok(f.collect().unresolvedDebt.includes('context-baseline:alice:epoch-2'))
  f.state.v14DeliveryReceipts.push({ member: 'alice', sessionId: 'a', committedAt: 201, baselineId: 'epoch-2',
    items: [{ id: 'contract', hash: 'hash' }], dispatch: { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'new' } })
  assert.ok(!f.collect().unresolvedDebt.includes(debt))
  f.inputs.pop()
  assert.ok(f.collect().unresolvedDebt.includes('input-state-unavailable:alice'))
})

test('exact collector snapshot participates in delivery CAS bindings even with an empty debt list', t => {
  const f = fixture(t)
  const ref = (name, contents) => {
    const path = join(f.directory, name); writeFileSync(path, contents)
    return { path, sha256: createHash('sha256').update(contents).digest('hex') }
  }
  const policy = { workspaceRoot: f.directory, allowedRoots: [f.directory],
    environmentRefs: [ref('env', 'fixed')], recipeRef: ref('recipe', 'fixed'),
    collectAuthorityDebt: () => f.collect() }
  const plan = { ...f.plan, scope: ['env'] }
  const first = collectDeliveryContext(f.state, plan, policy)
  f.state.v12Requirements.requirements.r = { taskIds: ['task'], revision: 2, status: 'active' }
  const next = collectDeliveryContext(f.state, plan, policy)
  assert.deepEqual(first.unresolvedDebt, next.unresolvedDebt)
  assert.notDeepEqual(first.authorityDebtSnapshot, next.authorityDebtSnapshot)
})
