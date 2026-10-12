import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goalFixture } from './native-goal-fixture.mjs'
import { bindGoalDeliveryPlan } from '../home/profiles/web/plugins/team-v15-goal-delivery.mjs'
import remoteGoal from '../app/node_modules/@deepseek-ai/dsh-goal/lib/typert.remote-client.js'

async function fixture(t, options = {}) {
  const f = await goalFixture(mkdtempSync(join(tmpdir(), 'goal-requirement-')), { native: false, ...options })
  t.after(() => f.current.handle.close())
  return f
}
function binding(f, extra = {}) {
  const c = f.current, goal = c.goals.get(c.agent)
  return bindGoalDeliveryPlan({ control: f.control, readDurable: f.readDurable, registry: f.registry,
    getGoal: () => c.goals.get(c.agent), agent: c.agent, flush: c.flush,
    input: { planId: 'p1', expectedGoalId: goal.id, expectedGoalRevision: goal.revision }, ...extra })
}
const markers = f => f.current.session.log.filter(row => row.type === 'native/delivery-required')

test('binding flush failure cannot return a receipt or commit the control-plane binding; retry keeps one marker', async t => {
  const f = await fixture(t, { bindPlan: false })
  f.failFlush(true)
  await assert.rejects(binding(f), { code: 'GOAL_BINDING_DURABILITY_UNAVAILABLE' })
  assert.equal(f.readDurable().v15GoalBindings?.[f.current.session.id], undefined)
  assert.equal(markers(f).length, 1)
  f.failFlush(false)
  assert.equal((await binding(f)).durable, true)
  assert.equal(markers(f).length, 1)
  await f.reload({ completionGate: false })
  assert.equal(markers(f).length, 1)
  assert.throws(() => f.current.goals.complete(f.current.agent, f.ref), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
})

test('a crash boundary after the session requirement and before control-plane binding fails closed on cold load', async t => {
  const f = await fixture(t, { bindPlan: false })
  await assert.rejects(binding(f, { control: { mutateHot: () => { throw new Error('CONTROL_UNAVAILABLE') } } }), /CONTROL_UNAVAILABLE/)
  assert.equal(f.readDurable().v15GoalBindings?.[f.current.session.id], undefined)
  await f.reload({ completionGate: false })
  assert.throws(() => f.current.goals.complete(f.current.agent, f.ref), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
})

test('cold loading cannot remove an installed delivery policy before the first plan binding', async t => {
  const f = await fixture(t, { bindPlan: false })
  await f.current.flush()
  const c = await f.reload({ completionGate: false })
  assert.throws(() => c.goals.complete(c.agent, f.ref), { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
})

test('an edited objective cannot rebind unchanged old plan proof and claim completion', async t => {
  const f = await fixture(t), c = f.current
  c.goals.edit(c.agent, f.ref, { objective: 'The original scope plus a new unverified requirement' })
  await assert.rejects(binding(f), { code: 'GOAL_PLAN_STALE' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
})

test('pause and resume do not invalidate a plan when its objective remains identical', async t => {
  const f = await fixture(t), c = f.current
  const paused = c.goals.pause(c.agent, f.ref)
  const resumed = c.goals.resume(c.agent, { id: paused.id, revision: paused.revision })
  assert.equal((await c.goals.complete(c.agent, { id: resumed.id, revision: resumed.revision })).phase, 'complete')
})

test('the actual UI Remote endpoint rejects incomplete delivery and returns the still-active canonical goal', async t => {
  const f = await fixture(t, { remote: true }), c = f.current
  await f.control.mutateHot('fixture/missing-acceptance', {}, c.agent, state => {
    state.v12Evidence = structuredClone(state.v12Evidence)
    delete state.v12Evidence.records.accept
  }, { deferMs: 0 })
  await assert.rejects(c.gateway.invoke({ namespace: 'goals', method: 'complete', args: { agentId: c.agent.id, ref: f.ref } }),
    { code: 'DELIVERY_INCOMPLETE' })
  const actual = await c.gateway.invoke({ namespace: 'goals', method: 'get', args: { agentId: c.agent.id } })
  const codec = remoteGoal.descriptors.find(row => row.namespace === 'goals' && row.method === 'get').result.create()
  assert.equal(codec.parse(actual).phase, 'active')
  assert.equal(c.session.log.filter(row => row.type === 'goal/change' && row.data.operation === 'complete').length, 0)
})

test('the actual UI Remote endpoint cannot bypass a missing gate after cold non-Team restoration', async t => {
  const f = await fixture(t, { remote: true })
  const c = await f.reload({ completionGate: false })
  await assert.rejects(c.gateway.invoke({ namespace: 'goals', method: 'complete', args: { agentId: c.agent.id, ref: f.ref } }),
    { code: 'GOAL_DELIVERY_BRIDGE_UNAVAILABLE' })
  assert.equal(c.goals.get(c.agent).phase, 'active')
})

test('the actual UI Remote endpoint returns completion only after the bound receipt is durable', async t => {
  const f = await fixture(t, { remote: true }), c = f.current
  const result = await c.gateway.invoke({ namespace: 'goals', method: 'complete', args: { agentId: c.agent.id, ref: f.ref } })
  const codec = remoteGoal.descriptors.find(row => row.namespace === 'goals' && row.method === 'complete').result.create()
  assert.equal(codec.parse(result).phase, 'complete')
  assert.equal(Object.values(f.readDurable().v15PlanDelivery.outbox)[0].status, 'consumed')
  assert.equal((await f.reload()).goals.get(f.current.agent).phase, 'complete')
})

for (const [label, patch] of Object.entries({ foreignSession: { sessionId: 'foreign' }, invalidVersion: { version: 2 },
  missingObjective: { goalObjectiveHash: null }, invalidPlanRevision: { planRevision: 0 }, invalidPlanHash: { planHash: 'forged' } })) {
  test('JSONL rejects malformed durable delivery requirement: ' + label, async t => {
    const f = await fixture(t), c = f.current
    c.session.append('native/delivery-required', { ...markers(f)[0].data, ...patch })
    await c.flush()
    await assert.rejects(f.reload(), /Invalid native bridge event/)
  })
}
