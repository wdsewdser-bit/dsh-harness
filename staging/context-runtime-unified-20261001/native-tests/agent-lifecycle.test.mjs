import test from 'node:test'
import assert from 'node:assert/strict'
import {Context,getHostLifecycleGate} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {bindScopeParent} from '@deepseek-ai/dsh-scope'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const ctx = new Context(),gate = getHostLifecycleGate(ctx)
  let registry
  await gate.observeSettlement(() => gate.runAsync(() => {registry = new AgentRegistry(ctx)}))
  t.after(() => gate.observeSettlement(() => gate.runAsync(() => ctx.fiber.dispose())))
  return {ctx,gate,registry}
}
test('native AgentRegistry create does not enter factory while a transition fence is held',async t => {
  const {ctx,gate,registry} = await fixture(t)
  let started = false
  await gate.observeSettlement(() => gate.runAsync(() => registry.setFactory({createAgent(){started=true;return {agent:{id:'child'}}}})))
  const lease = gate.acquireTransition()
  const operation = registry.create({sessionId:'child'})
  await tick();const beforeRelease = started;lease.release()
  assert.equal((await operation).agent.id,'child')
  assert.equal(beforeRelease,false);assert.equal(started,true);assert.equal(gate.snapshot().pending,false)
})
test('native AgentRegistry resume waits before invoking the persisted factory',async t => {
  const {gate,registry} = await fixture(t)
  let entered = false
  await gate.observeSettlement(() => gate.runAsync(() => registry.setFactory({resume(){entered=true;return {agent:{id:'old'}}}})))
  const lease = gate.acquireTransition(),operation = registry.resume({resumeSessionId:'old'})
  await tick();const beforeRelease = entered;lease.release();await operation
  assert.equal(beforeRelease,false);assert.equal(gate.snapshot().pending,false)
})
test('native create owns asynchronous scope installation and later preset-parent binding as one writer',async t => {
  const {ctx,gate,registry} = await fixture(t)
  const setup = Promise.withResolvers();let binding,plugin
  await gate.observeSettlement(() => gate.runAsync(() => registry.setFactory({async createAgent(owner){
    plugin = owner.plugin(async() => {await setup.promise})
    try {await tick();binding = bindScopeParent({},{});return {agent:{id:'created'}}}
    finally {setup.resolve();await plugin}
  }})))
  const result = await registry.create({sessionId:'created'})
  assert.equal(result.agent.id,'created');assert.ok(binding);assert.equal(gate.snapshot().pending,false)
})
test('rejected creation retains the host writer until asynchronous partial cleanup settles',async t => {
  const {gate,registry} = await fixture(t),cleanup = Promise.withResolvers(),entered = Promise.withResolvers()
  await gate.observeSettlement(() => gate.runAsync(() => registry.setFactory({async createAgent(){entered.resolve();await cleanup.promise;throw new Error('setup-failed')}})))
  const operation = registry.create({sessionId:'failed'});const outcome = operation.catch(error => error)
  await entered.promise;assert.equal(gate.snapshot().pending,true)
  assert.throws(() => gate.acquireTransition(),{code:'HOST_PENDING'})
  cleanup.resolve();assert.match((await outcome).message,/setup-failed/);assert.equal(gate.snapshot().pending,false)
})
