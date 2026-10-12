import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import './host-lifecycle-resolve.mjs'
import { apply } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { controlPlaneForMember, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
const { Context, getHostLifecycleGate } = await import('@deepseek-ai/cordis')
const { Session, SessionStore } = await import('../app/node_modules/@deepseek-ai/dsh-session/lib/index.js')
const { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } = await import('../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
const { ToolRuntime } = await import('../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js')
const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const tick = () => new Promise(resolve => setImmediate(resolve))

// `marker` is one marker for all five files, or a per-file map ({ 'AGENTS.md': 'B' }, others default 'A').
function writeNativeRoles(rolesDir, marker) {
  const markerFor = name => typeof marker === 'string' ? marker : marker[name] ?? 'A'
  const bodies = Object.fromEntries(['AGENTS.md', 'root.md', 'lead.md', 'member.md', 'verifier.md']
    .map(name => [name, name + ' actual identity ' + markerFor(name)]))
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(rolesDir, name), body)
  writeFileSync(join(rolesDir, 'identity-version.json'), JSON.stringify({ schemaVersion: 1, identityVersion: 'same-name',
    files: Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name,
      createHash('sha256').update(body).digest('hex')])) }))
}

// Real SessionStore / ReactLoopAgent / ToolRuntime / dispatch waterfall; only team membership is a fixture.
async function createNativeIdentityWorld(t, identityOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-identity-'))
  const rolesDir = join(directory, 'roles')
  mkdirSync(rolesDir)
  const writeRoles = marker => writeNativeRoles(rolesDir, marker)
  writeRoles('A')
  const ctx = new Context()
  await tick()
  const f = await getHostLifecycleGate(ctx).runAsync(async () => {
    const sessions = new SessionStore(ctx)
    await tick()
    const projections = new SessionProjectionRegistry(ctx)
    await tick()
    projections.register(inboxProjectionDefinition)
    projections.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await tick()
    new AgentRegistry(ctx)
    await tick()
    const tools = new ToolRuntime(ctx)
    await tick()
    const session = Session.create('identity-native')
    sessions.enter(session); sessions.announce(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} })
    await tick()
    // Membership is fixture-owned; dispatch, event hooks, schema and Session are native.
    const membership = { id: 'identity-native-team', name: 'root', tier: 0, role: 'lead' }
    ctx.provide('agentTeams', { tryMembership: current => current === agent ? membership : undefined,
      listMembers: () => [membership] })
    apply(ctx, { controlDir: directory, pluginDir: directory, rolesDir,
      activeIdentity: { enabled: true, allowedRoots: [rolesDir], ...identityOptions } })
    const cp = controlPlaneForMember(ctx, agent, { directory })
    return { tools, session, agent, cp }
  })
  t.after(async () => { await f.cp.flush(); resetControlPlaneCache(); rmSync(directory, { recursive: true, force: true }) })
  const execute = async (action, input) => {
    const result = await f.tools.execute({ name: 'team_v12', arguments: { action, ...(input ? { input } : {}) },
      agent: f.agent, callId: action + '-' + Date.now(), signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result))
    return result.value
  }
  const pre = () => f.agent.dispatch.waterfall('agent/pre-step', { messages: [] }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  const activate = async () => execute('identity_activate', {
    expectedControlRevision: f.cp.snapshot().revision, expectedIdentityEpoch: f.cp.snapshot().identityEpoch ?? 0,
    expectedBundleHash: (await execute('identity_proposal')).contentHash,
  })
  return { f, execute, pre, activate, writeRoles }
}

test('native ToolRuntime activation and real agent pre-step consume only the approved durable role bundle', async t => {
  const { f, execute, pre, activate, writeRoles } = await createNativeIdentityWorld(t)
  const missing = await pre()
  assert.equal(missing.kind, 'reject')
  assert.match(missing.reason, /ACTIVE_IDENTITY_NOT_SET/)
  await activate()
  const first = await pre()
  assert.ok(JSON.stringify(first.messages).includes('root.md actual identity A'))
  for (const message of first.messages) f.session.append('user/message', message, { surfaceOp: 'append' })
  writeRoles('B')
  const repeat = await pre()
  assert.ok(!JSON.stringify(repeat.messages).includes('actual identity B'))
  await activate()
  const second = await pre()
  assert.ok(JSON.stringify(second.messages).includes('root.md actual identity B'))
  assert.equal((await execute('identity_status')).epoch, 2)
  assert.equal(f.agent.name, undefined, 'identity resolves actual registry membership, not a synthetic agent.name')
})

test('native pre-step: a common-only (AGENTS.md) change waits for activation, then reaches the next turn without the old common', async t => {
  const { f, execute, pre, activate, writeRoles } = await createNativeIdentityWorld(t)
  await activate()
  const first = await pre()
  const firstText = JSON.stringify(first.messages)
  assert.ok(firstText.includes('AGENTS.md actual identity A'))
  assert.ok(firstText.includes('root.md actual identity A'))
  for (const message of first.messages) f.session.append('user/message', message, { surfaceOp: 'append' })

  // Only the common file changes (manifest hashes regenerated); role files stay byte-identical.
  writeRoles({ 'AGENTS.md': 'B' })
  const beforeActivation = await execute('identity_status')
  const repeat = await pre()
  assert.ok(!JSON.stringify(repeat.messages).includes('actual identity'),
    'an unactivated proposal must not reach the next turn')
  assert.equal(beforeActivation.epoch, 1)

  // Activation lands while the previous request is already captured: that request must not change.
  await activate()
  assert.equal(JSON.stringify(first.messages), firstText, 'activation must not rewrite the captured pre-step messages')
  assert.equal((await execute('identity_status')).epoch, 2)

  const second = await pre()
  const secondText = JSON.stringify(second.messages)
  assert.ok(secondText.includes('AGENTS.md actual identity B'), 'next turn carries the new common')
  assert.ok(!secondText.includes('AGENTS.md actual identity A'), 'next turn must not carry the old common')
  assert.ok(secondText.includes('root.md actual identity A'), 'unchanged role text is delivered unchanged')
  assert.ok(!secondText.includes('root.md actual identity B'))
  for (const message of second.messages) f.session.append('user/message', message, { surfaceOp: 'append' })
  const settled = await pre()
  assert.ok(!JSON.stringify(settled.messages).includes('actual identity'), 'delivered identity is not repeated')
})

// Production has no lab driver to activate a bundle before the first sampling. With hostBootstrap the runtime itself
// publishes the configured bundle once for a Team root that has none; it never re-activates on its own afterwards.
test('host bootstrap activates the configured bundle once for a root that has none, and never re-activates by itself', async t => {
  const { f, execute, pre, activate, writeRoles } = await createNativeIdentityWorld(t, { hostBootstrap: true })
  const [first, concurrent] = await Promise.all([pre(), pre()])
  assert.equal(first.kind, 'enter', JSON.stringify(first).slice(0, 300))
  assert.equal(concurrent.kind, 'enter')
  assert.ok(JSON.stringify(first.messages).includes('root.md actual identity A'))
  const status = await execute('identity_status')
  assert.equal(status.epoch, 1, 'two racing first steps publish exactly one activation')
  assert.equal(f.cp.snapshot().activeIdentity.activatedBy, f.agent.id)
  for (const message of first.messages) f.session.append('user/message', message, { surfaceOp: 'append' })
  // A later edit of the role files is a proposal: it waits for an explicit activation, as without the bootstrap.
  writeRoles('B')
  const repeat = await pre()
  assert.equal(repeat.kind, 'enter')
  assert.ok(!JSON.stringify(repeat.messages).includes('actual identity B'))
  assert.equal((await execute('identity_status')).epoch, 1)
  await activate()
  assert.ok(JSON.stringify((await pre()).messages).includes('root.md actual identity B'))
  assert.equal((await execute('identity_status')).epoch, 2)
})

// A large pasted message must not starve the required identity out of the context pack. The window bound applies to
// what is added in this step as a whole; the pack's own cap is not reduced by the size of the pending input.
test('a required identity that outgrows the mid-turn delta cap is delivered with the full pack budget, not a blocked turn', async t => {
  const { f, activate, writeRoles } = await createNativeIdentityWorld(t)
  // Sized between the 2500-token mid-turn cap and the 6000-token root pack cap.
  const marker = 'A ' + 'standing rule text. '.repeat(400)
  writeRoles(marker)
  await activate()
  const decision = await f.agent.dispatch.waterfall('agent/pre-step', { messages: [], step: 2 }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(decision.kind, 'enter', JSON.stringify(decision).slice(0, 300))
  assert.ok(JSON.stringify(decision.messages).includes('root.md actual identity ' + marker))
})

test('a pending message far larger than the context-pack cap still gets the required identity instead of a blocked turn', async t => {
  const { f, activate, writeRoles } = await createNativeIdentityWorld(t)
  // A realistically sized identity: far more than the 256-token floor the pack budget used to collapse to.
  const marker = 'A ' + 'standing rule text. '.repeat(400)
  writeRoles(marker)
  await activate()
  const huge = { id: 'huge-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'pasted document line. '.repeat(20000) }] }
  const decision = await f.agent.dispatch.waterfall('agent/pre-step', { messages: [huge] }, () => Promise.resolve({ kind: 'enter', messages: [huge] }))
  assert.equal(decision.kind, 'enter', JSON.stringify(decision).slice(0, 300))
  assert.ok(decision.messages.some(message => message.id === 'huge-input'), 'the pending input is preserved')
  assert.ok(JSON.stringify(decision.messages).includes('root.md actual identity ' + marker))
})
