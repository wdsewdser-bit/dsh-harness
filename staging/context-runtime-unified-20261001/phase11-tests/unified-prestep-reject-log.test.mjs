import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import '../native-tests/host-lifecycle-resolve.mjs'
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
// `controlDir` is the temp directory itself, which is where the reject log is expected to land.
async function createNativeIdentityWorld(t, identityOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'prestep-reject-'))
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
    const session = Session.create('prestep-reject')
    sessions.enter(session); sessions.announce(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} })
    await tick()
    const membership = { id: 'prestep-reject-team', name: 'root', tier: 0, role: 'lead' }
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
  const activate = async () => execute('identity_activate', {
    expectedControlRevision: f.cp.snapshot().revision, expectedIdentityEpoch: f.cp.snapshot().identityEpoch ?? 0,
    expectedBundleHash: (await execute('identity_proposal')).contentHash,
  })
  const preStep = (step, messages = []) => f.agent.dispatch.waterfall('agent/pre-step', { messages, step },
    () => Promise.resolve({ kind: 'enter', messages }))
  const rejectLog = () => join(directory, 'pre-step-rejects.jsonl')
  const rejectRows = () => readFileSync(rejectLog(), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { f, execute, activate, writeRoles, preStep, rejectLog, rejectRows, controlDir: directory }
}

// The identity is required and safety-critical, so one that no longer fits the full tier-0 pack budget must
// block the turn instead of silently dropping the member's rules.
test('a real team-context-safety-debt rejection is recorded with its code, session and step', async t => {
  const w = await createNativeIdentityWorld(t)
  // Only the two files `identitySource` concatenates are huge: together they far exceed the entire 6000-token
  // root pack budget, so even the full-budget fallback cannot fit them, while staying under the 256 KB bundle cap.
  const marker = 'A ' + 'standing rule text. '.repeat(3000)
  w.writeRoles({ 'AGENTS.md': marker, 'root.md': marker })
  await w.activate()
  const pending = { id: 'pending-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'pasted document body' }] }
  const decision = await w.preStep(2, [pending])
  assert.equal(decision.kind, 'reject', JSON.stringify(decision).slice(0, 300))
  assert.match(decision.reason, /^team-context-safety-debt:/)
  const rows = w.rejectRows()
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.version, 1)
  assert.equal(row.source, 'team-v12-runtime')
  assert.equal(row.code, 'team-context-safety-debt')
  assert.equal(row.sessionId, w.f.session.id)
  assert.equal(row.member, 'root')
  assert.equal(row.step, 2)
  assert.equal(row.pendingMessages, 1)
  assert.equal(Number.isNaN(Date.parse(row.at)), false, 'at must be an ISO timestamp')
  assert.ok(row.reason.length <= 600)
  assert.ok(row.reason.startsWith('team-context-safety-debt:'), 'the truncated reason keeps its code')
  // No message body may leak into the log, only the lowercased code prefix and debt identifiers.
  assert.equal(readFileSync(w.rejectLog(), 'utf8').includes('pasted'), false)
})

test('an upstream reject is passed through unchanged and recorded as upstream', async t => {
  const w = await createNativeIdentityWorld(t)
  const upstream = { kind: 'reject', reason: 'upstream-test: because' }
  const decision = await w.f.agent.dispatch.waterfall('agent/pre-step', { messages: [], step: 1 },
    () => Promise.resolve(upstream))
  assert.deepEqual(decision, upstream, 'the upstream decision must not be rewritten')
  const rows = w.rejectRows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'upstream')
  assert.equal(rows[0].code, 'upstream-test')
  assert.equal(rows[0].sessionId, w.f.session.id)
  assert.equal(rows[0].member, 'root')
  assert.equal(rows[0].reason, 'upstream-test: because')
})

// A rejection is the rare path; an ordinary enter must not add a byte of bookkeeping.
test('a normal pre-step enter writes no reject log', async t => {
  const w = await createNativeIdentityWorld(t)
  await w.activate()
  const decision = await w.preStep(1)
  assert.equal(decision.kind, 'enter', JSON.stringify(decision).slice(0, 300))
  assert.equal(existsSync(w.rejectLog()), false)
})

// Losing the audit trail must never turn into a second failure: the reject still has to reach the agent loop.
test('an unwritable reject log cannot change the rejection or throw', async t => {
  const w = await createNativeIdentityWorld(t)
  w.writeRoles({ 'AGENTS.md': 'A ' + 'standing rule text. '.repeat(3000), 'root.md': 'A ' + 'standing rule text. '.repeat(3000) })
  await w.activate()
  // A directory at the target path makes every append fail without touching the decision.
  mkdirSync(w.rejectLog(), { recursive: true })
  const decision = await w.preStep(2)
  assert.equal(decision.kind, 'reject', JSON.stringify(decision).slice(0, 300))
  assert.match(decision.reason, /^team-context-safety-debt:/)
})
