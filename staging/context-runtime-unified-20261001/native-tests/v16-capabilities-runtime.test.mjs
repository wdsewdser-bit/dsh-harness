import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fixture } from './v16-capabilities-fixture.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { apply as applyPolicy, policyFor, resetPolicyServices } from '../home/profiles/web/plugins/team-policy.mjs'
import { installCapabilitiesRuntime } from '../home/profiles/web/plugins/team-v16-capabilities-runtime.mjs'

test('integrated capabilities require live approved task and lease and preserve native guards', async t => {
  const f = await fixture(t)
  t.after(() => resetPolicyServices())
  let tools, installed, leafCalls = 0, approval = false
  const now = Date.now()
  await f.control.mutateHot('fixture/approved-task-and-lease', {}, f.agent, state => {
    state.plans.t1 = { state: 'plan-approved', approvedBy: 'root', approvedAt: now,
      revision: 1, members: ['root'] }
    state.leases['v16-owner'] = { runId: 'v16-owner', status: 'active', member: 'root', taskId: 't1',
      contractRevision: 3, expiresAt: now + 600000 }
  }, { deferMs: 0 })
  await initializeNativeHost(f.ctx, () => {
    applyPolicy(f.ctx, { controlDir: join(f.root, 'control') })
    policyFor('window-team').put({ name: 'root', tier: 0, group: 'root', frozen: false })
    tools = new ToolRuntime(f.ctx)
    tools.register({ name: 'guarded_v16_echo', description: 'Guarded integration leaf', parameters: {
      type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args) { leafCalls++; return args } })
    tools.guard(exec => {
      if (exec.name !== 'guarded_v16_echo') return
      if (exec.arguments.text !== 'inside-scope') return 'WRITE_SCOPE_DENIED'
      if (!approval) return 'APPROVAL_REQUIRED'
    })
    installed = installCapabilitiesRuntime(f.ctx, { controlDir: join(f.root, 'control') })
  })
  t.after(() => installed.dispose())
  const run = (name, args) => tools.execute({ name, arguments: args, callId: 'bridge-' + name,
    agent: f.agent, signal: new AbortController().signal })
  const actor = installed.service.resolveActor(f.agent)
  assert.equal(actor.plan, 'collector-plan')
  assert.equal(actor.authority.runId, 'v16-owner')
  assert.equal(actor.workspace.toLowerCase(), f.root.toLowerCase())
  const catalog = await run('sdk_catalog', { operation: 'describe', tool: 'guarded_v16_echo' })
  assert.notEqual(catalog.isError, true)
  const put = await run('tool_ref_put', { tool: 'guarded_v16_echo', arguments: { text: 'inside-scope' } })
  assert.notEqual(put.isError, true, JSON.stringify(put))
  const ref = { ref: put.value.ref, hash: put.value.hash }
  assert.deepEqual(await run('tool_ref_invoke', ref), await run('guarded_v16_echo', { text: 'inside-scope' }))
  assert.equal(leafCalls, 0)
  approval = true
  assert.deepEqual(await run('tool_ref_invoke', ref), await run('guarded_v16_echo', { text: 'inside-scope' }))
  assert.equal(leafCalls, 2)
  const outside = await run('tool_ref_put', { tool: 'guarded_v16_echo', arguments: { text: 'outside-scope' } })
  assert.deepEqual(await run('tool_ref_invoke', { ref: outside.value.ref, hash: outside.value.hash }),
    await run('guarded_v16_echo', { text: 'outside-scope' }))
  assert.equal(leafCalls, 2)
  const unavailable = await run('context_episode', { operation: 'list' })
  assert.equal(unavailable.isError, true)
  assert.match(JSON.stringify(unavailable), /V16_AUTHORIZED_COLLECTOR_UNAVAILABLE/)
  await f.control.mutateHot('fixture/heartbeat', {}, f.agent,
    state => { state.leases['v16-owner'].expiresAt += 600000 }, { deferMs: 0 })
  assert.notEqual((await run('tool_ref_read', ref)).isError, true, 'heartbeat alone does not replace the lease identity')
  await f.control.mutateHot('fixture/replaced-approved-plan', {}, f.agent,
    state => { state.plans.t1.revision++ }, { deferMs: 0 })
  assert.equal((await run('tool_ref_read', ref)).isError, true, 'approved task-plan revision invalidates references')
  await f.control.mutateHot('fixture/expire-lease', {}, f.agent,
    state => { state.leases['v16-owner'].expiresAt = 0 }, { deferMs: 0 })
  const expired = await run('tool_ref_put', { tool: 'guarded_v16_echo', arguments: { text: 'inside-scope' } })
  assert.equal(expired.isError, true)
  assert.match(JSON.stringify(expired), /V16_CURRENT_OWNER_LEASE_REQUIRED/)
  assert.equal(installed.service.runtimeFacts().collectorScopeChanged, false)
})
