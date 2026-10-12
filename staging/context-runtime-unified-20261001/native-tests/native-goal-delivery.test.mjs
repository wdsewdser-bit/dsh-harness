import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { goalFixture } from './native-goal-fixture.mjs'
import { nativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { apply as applyGoalTools } from '../app/node_modules/@deepseek-ai/dsh-tool-goal-v15/lib/index.js'
import { createGoalOutboxRecovery } from '../home/profiles/web/plugins/team-v15-goal-delivery.mjs'

async function fixture(t, options) {
  const f = await goalFixture(mkdtempSync(join(tmpdir(), 'native-goal-delivery-')), options)
  t.after(async () => { await f.current.handle.close() })
  return f
}
const outbox = f => Object.values(f.readDurable().v15PlanDelivery.outbox ?? {})

test('automatic outbox recovery waits for a real event or changed outbox rather than polling every step', async () => {
  let calls = 0
  const recovery = createGoalOutboxRecovery({ recover: async () => { calls++; return { acknowledged: [], pending: ['unproven'] } } }, 'session1')
  const state = { v15PlanDelivery: { outbox: { r: { receiptId: 'r', status: 'queued', consumer: { sessionId: 'session1' } } } } }
  for (let n = 0; n < 20; n++) await recovery.beforeStep(state)
  assert.equal(calls, 1)
  recovery.onEvent({ id: 'foreign' }, { type: 'native/delivery-consumed' })
  await recovery.beforeStep(state)
  assert.equal(calls, 1)
  recovery.onEvent({ id: 'session1' }, { type: 'native/delivery-consumed' })
  await recovery.beforeStep(state)
  assert.equal(calls, 2)
  state.v15PlanDelivery.outbox.r.status = 'consumed'
  assert.equal(await recovery.beforeStep(state), null)
})

test('actual GoalService completes only after canonical durable receipt and JSONL effect flush', async t => {
  const f = await fixture(t), c = f.current
  const completed = await c.goals.complete(c.agent, f.ref)
  assert.equal(completed.phase, 'complete')
  assert.equal(outbox(f).length, 1)
  assert.equal(outbox(f)[0].status, 'consumed')
  const restored = await f.reload()
  assert.equal(restored.goals.get(restored.agent).phase, 'complete')
  assert.equal(restored.session.log.filter(row => row.type === 'native/delivery-consumed').length, 1)
  assert.equal((await restored.gate.recover()).acknowledged.length, 0)
})

test('missing enablement and unbound goal cannot bypass the service boundary', async t => {
  const f = await fixture(t), c = f.current
  await f.control.mutateHot('fixture/missing-enable', {}, c.agent, state => { state.runtimeReceipts = {} }, { deferMs: 0 })
  await assert.rejects(c.goals.complete(c.agent, f.ref), { code: 'DELIVERY_INCOMPLETE' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
  assert.equal(outbox(f).length, 0)
  await f.control.mutateHot('fixture/unbind', {}, c.agent, state => { state.v15GoalBindings = {} }, { deferMs: 0 })
  await assert.rejects(c.goals.complete(c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
})

test('failed JSONL flush leaves queued receipt, returns no completion and replays from durable active goal', async t => {
  const f = await fixture(t), c = f.current
  f.failFlush(true)
  await assert.rejects(c.goals.complete(c.agent, f.ref), { code: 'NATIVE_DURABILITY_UNAVAILABLE' })
  assert.equal(outbox(f)[0].status, 'queued')
  await assert.rejects(c.gate.recover(), { code: 'NATIVE_DURABILITY_UNAVAILABLE' })
  const restored = await f.reload()
  assert.equal(restored.goals.get(restored.agent).phase, 'active')
  f.failFlush(false)
  assert.equal((await restored.goals.complete(restored.agent, f.ref)).phase, 'complete')
  assert.equal(outbox(f).length, 1)
  assert.equal(outbox(f)[0].status, 'consumed')
  assert.equal(restored.session.log.filter(row => row.type === 'goal/change' && row.data.operation === 'complete').length, 1)
})

test('durable goal effect survives ack failure; fresh gate recovers without repeating the goal transition', async t => {
  const f = await fixture(t), c = f.current
  f.failAck(true)
  await assert.rejects(c.goals.complete(c.agent, f.ref), { code: 'ACK_FAILURE' })
  assert.equal(outbox(f)[0].status, 'queued')
  const restored = await f.reload()
  assert.equal(restored.goals.get(restored.agent).phase, 'complete')
  f.failAck(false)
  const recovered = await restored.gate.recover()
  assert.deepEqual(recovered.pending, [])
  assert.equal(recovered.acknowledged.length, 1)
  assert.equal(outbox(f)[0].status, 'consumed')
  assert.equal(restored.session.log.filter(row => row.type === 'goal/change' && row.data.operation === 'complete').length, 1)
  assert.equal((await restored.gate.recover()).acknowledged.length, 0)
})

test('queued receipt and complete goal with mismatched consumed marker never prove outbox consumption', async t => {
  const f = await fixture(t), c = f.current
  const append = c.session.append.bind(c.session)
  c.session.append = (type, data, ...rest) => append(type,
    type === 'native/delivery-consumed' ? { ...data, planHash: 'forged' } : data, ...rest)
  f.failAck(true)
  await assert.rejects(c.goals.complete(c.agent, f.ref), { code: 'ACK_FAILURE' })
  await assert.rejects(c.gate.recover(), { code: 'DELIVERY_CONSUMPTION_UNVERIFIED' })
  assert.equal(outbox(f)[0].status, 'queued')
})

test('service gate without native opt-in is durable; HMR removal cannot fall back to unguarded completion', async t => {
  const f = await fixture(t, { native: false }), c = f.current
  assert.equal(nativeSessionBridge(c.session), undefined)
  c.disposeGate()
  assert.throws(() => c.goals.complete(c.agent, f.ref), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
  c.goals.registerCompletionGate(c.agent, c.gate)
  assert.equal((await c.goals.complete(c.agent, f.ref)).phase, 'complete')
  assert.equal(nativeSessionBridge(c.session), undefined)
  assert.equal(outbox(f)[0].status, 'consumed')
})

test('cold non-Team restoration cannot forget a previously bound goal completion requirement', async t => {
  const f = await fixture(t, { native: false })
  const restored = await f.reload({ completionGate: false })
  assert.throws(() => restored.goals.complete(restored.agent, f.ref), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
  assert.equal(restored.goals.get(restored.agent).phase, 'active')
  assert.equal(outbox(f).length, 0)
})

test('an installed gate cannot downgrade a durable requirement to an unbound completion', async t => {
  const f = await fixture(t, { native: false }), c = f.current
  c.disposeGate()
  c.goals.registerCompletionGate(c.agent, { ...c.gate, isBound: () => false })
  assert.throws(() => c.goals.complete(c.agent, f.ref), { code: 'GOAL_PLAN_UNBOUND' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
})

test('editing a bound objective invalidates the old plan binding before completion', async t => {
  const f = await fixture(t, { native: false }), c = f.current
  const changed = c.goals.edit(c.agent, f.ref, { objective: 'An additional unverified mandatory requirement' })
  await c.flush()
  await assert.rejects(c.goals.complete(c.agent, { id: changed.id, revision: changed.revision }), { code: 'GOAL_PLAN_STALE' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
  assert.equal(outbox(f).length, 0)
})

test('actual registered model goal tool awaits durable service completion and propagates flush failure', async t => {
  for (const failure of [false, true]) {
    const f = await fixture(t, { native: false }), c = f.current, tools = new Map()
    c.agent.phase = { kind: 'running', abort: new AbortController(), turn: 1, step: 1 }
    c.session.append('user/message', { id: 'human-input', role: 'user', content: [{ type: 'text', text: 'Finish after verification' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
    applyGoalTools({ systemPrompt: { section() {}, getSectionOrder: () => 0 }, tools: { register: tool => tools.set(tool.name, tool) },
      goals: c.goals, sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) },
      agents: { get: () => c.agent, roots: () => [c.agent], currentInitiator: () => c.agent } }, {})
    const pending = tools.get('update_goal').execute({ action: 'complete', goal_id: f.ref.id, revision: f.ref.revision }, { agent: c.agent })
    if (failure) {
      f.failFlush(true)
      await assert.rejects(pending, { code: 'NATIVE_DURABILITY_UNAVAILABLE' })
      assert.equal(outbox(f)[0].status, 'queued')
    } else {
      const value = await pending
      assert.equal(value.goal.phase, 'complete')
      assert.equal(value.goal.objective, 'Fully verified fixture delivery')
      assert.equal(outbox(f)[0].status, 'consumed')
    }
  }
})

test('abrupt process exit after goal flush recovers only durable matching outbox effect', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-goal-crash-'))
  const child = spawnSync(process.execPath, ['--import', new URL('../tools/prepare-unified-lab-host.mjs', import.meta.url).href,
    fileURLToPath(new URL('./native-goal-crash-fixture.mjs', import.meta.url)), root],
    { encoding: 'utf8', timeout: 15000, env: { ...process.env, DSH_LAB_CANONICAL_MODULES: '1' } })
  assert.equal(child.status, 19, child.stderr)
  const f = await goalFixture(root, { restore: true, native: false }), c = f.current
  t.after(async () => { await c.handle.close() })
  assert.equal(c.goals.get(c.agent).phase, 'complete')
  assert.equal(outbox(f)[0].status, 'queued')
  assert.equal((await c.gate.recover()).acknowledged.length, 1)
  assert.equal(outbox(f)[0].status, 'consumed')
  assert.equal(c.session.log.filter(row => row.type === 'goal/change' && row.data.operation === 'complete').length, 1)
})

test('recovery acknowledges an older durable effect without completing or modifying the new goal', async t => {
  const f = await fixture(t, { native: false }), c = f.current
  f.failAck(true)
  await assert.rejects(c.goals.complete(c.agent, f.ref), { code: 'ACK_FAILURE' })
  const fresh = c.goals.create(c.agent, { objective: 'A different unfinished goal' })
  await c.flush()
  const restored = await f.reload()
  assert.equal((await restored.gate.recover()).acknowledged.length, 1)
  assert.equal(restored.goals.get(restored.agent).id, fresh.id)
  assert.equal(restored.goals.get(restored.agent).phase, 'active')
  assert.equal(outbox(f)[0].status, 'consumed')
})

test('goal/change alone is insufficient; malformed native markers and arbitrary unknown events stay rejected', async t => {
  const f = await fixture(t, { native: false }), c = f.current
  const append = c.session.append.bind(c.session)
  c.session.append = (type, data, ...rest) => type === 'native/delivery-consumed' ? { seq: c.session.seq } : append(type, data, ...rest)
  f.failAck(true)
  await assert.rejects(c.goals.complete(c.agent, f.ref), { code: 'ACK_FAILURE' })
  const restored = await f.reload()
  const result = await restored.gate.recover()
  assert.equal(result.acknowledged.length, 0)
  assert.equal(result.pending[0].code, 'GOAL_EFFECT_NOT_DURABLY_PROVEN')
  assert.equal(outbox(f)[0].status, 'queued')
  restored.session.append('native/delivery-consumed', { receiptId: 'malformed' })
  await restored.flush()
  await assert.rejects(f.reload(), /Invalid native bridge event/)
  const other = await fixture(t, { native: false })
  other.current.session.append('native/arbitrary-unknown', {})
  await other.current.flush()
  await assert.rejects(other.reload(), /unknown to this harness/)
})
