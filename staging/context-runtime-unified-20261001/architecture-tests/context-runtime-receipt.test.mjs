import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply } from '../home/profiles/web/plugins/context-workspace.mjs'
import { installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'
import { resetPolicyServices } from '../home/profiles/web/plugins/team-policy.mjs'
import { resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const official = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))

function fixture(t, bridge) {
  const directory = mkdtempSync(join(tmpdir(), 'context-runtime-receipt-'))
  t.after(() => { resetPolicyServices(); resetControlPlaneCache(); rmSync(directory, { recursive: true, force: true }) })
  const brands = bridge ? { add: official.markAgentLoopRequest, has: official.isAgentLoopRequest } : new WeakSet()
  const tools = new Map(), registrations = []
  const agent = { name: 'root', session: { id: 'isolated-root' }, ctx: { tools: {
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
  } } }
  const ctx = { agents: { list: () => [agent] },
    agentTeams: { tryMembership: () => ({ id: 'receipt-team', name: 'root', tier: 0 }) },
    on: () => () => {}, effect: () => {}, provide: (_name, value) => { ctx.contextWorkspace = value; return () => {} },
    requestMessageProjection: { isAgentLoopRequest: options => brands.has(options),
      register: (_name, project, options) => { registrations.push({ project, ...options }); return bridge?.register(_name, project, options) ?? (() => {}) } },
  }
  const config = { controlDir: directory, directory: join(directory, 'memo'), mode: 'apply', appliedSessionIds: [agent.session.id] }
  const stop = apply(ctx, config), service = ctx.contextWorkspace
  const row = service.manage(agent, { action: 'memo_put', input: { sourceId: 'working', expectedRevision: 0, text: 'exact working memo' } })
  assert.equal(row.ok, true)
  const proposal = service.manage(agent, { action: 'propose', input: { expectedRevision: 0,
    operations: [{ op: 'select', sourceId: row.sourceId, revision: row.revision, sha256: row.sha256 }] } })
  assert.equal(proposal.ok, true)
  assert.equal(service.manage(agent, { action: 'commit', input: { expectedRevision: 0, proposalId: proposal.proposalId } }).ok, true)
  const options = { sessionId: agent.session.id, purpose: 'conversation', messages: [{ id: 'current', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'current task' }] }] }
  brands.add(options)
  const projected = registrations[0].project(options)
  return { ctx, agent, service, config, stop, options, projected, observer: registrations[0].onDispatch, brands }
}

test('registered loaded service requires exact real dispatch, not preview or caller metadata', t => {
  const f = fixture(t)
  assert.equal(typeof f.observer, 'function')
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, false)
  const receipt = { stage: 'handed-to-adapter', handedToAdapter: true, requestId: 'real-request' }
  f.observer({ options: f.options, receipt, result: f.projected })
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, false, 'original input omitted the projected body')
  const wire = { ...f.options, messages: f.projected.messages }; f.brands.add(wire)
  f.observer({ options: wire, receipt: { ...receipt, handedToAdapter: false }, result: f.projected })
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, false)
  f.observer({ options: wire, receipt, result: f.projected })
  const proof = f.service.runtimeReceipt(f.agent)
  assert.equal(proof.consumed, true)
  assert.equal(proof.loaded, true)
  assert.equal(proof.toolRegistered, true)
  assert.equal(proof.dispatch.requestId, 'real-request')
  assert.equal(proof.modelUnderstanding, 'unknown')
  assert.equal(proof.moduleHash, f.service.runtimeFacts().moduleHash)
})

test('changed view and disabled route cannot inherit the old consumption receipt', t => {
  const f = fixture(t), wire = { ...f.options, messages: f.projected.messages }; f.brands.add(wire)
  f.observer({ options: wire, receipt: { stage: 'handed-to-adapter', handedToAdapter: true, requestId: 'r' } })
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, true)
  const proposal = f.service.manage(f.agent, { action: 'propose', input: { expectedRevision: 1, operations: [] } })
  assert.equal(f.service.manage(f.agent, { action: 'commit', input: { expectedRevision: 1, proposalId: proposal.proposalId } }).ok, true)
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, false)
  f.config.mode = 'shadow'
  assert.equal(f.service.runtimeReceipt(f.agent).enabled, false)
})

test('foreign agents, unknown protocol, and disposed plugin cannot claim a live installed receipt', t => {
  const f = fixture(t)
  assert.throws(() => f.service.runtimeReceipt({ ...f.agent }), /LIVE_AGENT_REQUIRED/)
  const wire = { ...f.options, messages: f.projected.messages }; f.brands.add(wire)
  f.observer({ options: wire, receipt: { stage: 'prepared', handedToAdapter: true, requestId: 'wrong-stage' } })
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, false)
  f.stop()
  assert.equal(f.service.runtimeReceipt(f.agent).loaded, false)
  assert.equal(f.service.runtimeReceipt(f.agent).toolRegistered, false)
})

test('real LlmRuntime adapter boundary records consumption even after replay-state filtering changes request identity', async t => {
  const llm = new official.LlmRuntime(new Context())
  const captured = []
  const unregister = llm.registerAdapter(['fixture'], new class extends official.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) { return { model: { provider, id: model, name: model },
      stream(options) { captured.push(options); return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })() } } }
  }())
  const bridge = installRequestMessageProjection(llm, official), f = fixture(t, bridge)
  t.after(() => { f.stop(); bridge.dispose(); unregister() })
  const request = { ...f.options, provider: 'fixture', model: 'fixture-model', signal: new AbortController().signal,
    messages: [...f.options.messages, { role: 'assistant', id: 'foreign-history', source: { kind: 'model', provider: 'foreign', model: 'old', replayState: { ignored: true } },
      content: [{ type: 'text', text: 'earlier response' }] }] }
  official.markAgentLoopRequest(request)
  const prepared = await llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  const iterator = prepared.stream(request)
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, false, 'uniterated stream is not a dispatch')
  for await (const _chunk of iterator) {}
  assert.equal(captured.length, 1)
  assert.equal(captured[0].messages[1].source.replayState, undefined)
  assert.equal(f.service.runtimeReceipt(f.agent).consumed, true)
})
