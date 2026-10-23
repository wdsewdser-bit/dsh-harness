import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Session, SessionStore } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as reducer from '../home/profiles/web/plugins/evidence-reducer.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'

test('mounted Reducer reduces a real native tool result, verifies quotes and preserves canonical business value', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-reducer-')), ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const f = await initializeNativeHost(ctx, async () => {
    const projections = new SessionProjectionRegistry(ctx), sessions = new SessionStore(ctx)
    projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new AgentRegistry(ctx)
    const session = Session.create('native-reducer')
    sessions.enter(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'tiny' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} }); agent.wakeDriver = () => {}
    const runtime = new ToolRuntime(ctx), original = 'header\nERROR: bounded fixture failure\n' + 'inert log line\n'.repeat(180)
    runtime.register({ name: 'bash', description: 'Controlled read-only log fixture', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: value.output }] },
      execute() { return { output: original, code: 0 } } })
    let calls = 0, valid = true
    new LlmRuntime(ctx).registerAdapter(['fixture'], new class extends LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream: () => (async function* () {
        calls++
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ version: 1, summary: 'bounded error',
          quotes: [{ line: 2, text: valid ? 'ERROR: bounded fixture failure' : 'invented evidence' }], unresolved: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() } }
    }())
    const config = { enabled: true, useSettingsFile: false, settingsFile: join(directory, 'settings.json'),
      archiveDir: directory, telemetryDir: directory, controlDir: directory, controlPlaneEnabled: false,
      localProviders: ['fixture'], routeMode: 'explicit', provider: 'fixture', model: 'tiny', thresholdBytes: 128 }
    class Settings extends Service { constructor(ctx) { super(ctx, 'settings') } describe() { return [{ ns: 'evidence-reducer', value: config }] } }
    new Settings(ctx)
    await ctx.plugin(reducer, config)
    return { agent, runtime, original, calls: () => calls, corrupt: () => { valid = false } }
  })
  const run = callId => f.runtime.execute({ agent: f.agent, name: 'bash', callId, arguments: {}, signal: new AbortController().signal })
  const first = await run('native-reducer-valid')
  assert.equal(first.isError, false)
  assert.equal(f.calls(), 1, 'the actual LlmRuntime route must be invoked')
  assert.match(first.content[0].text, /^sol_pi_evidence_receipt_v1/)
  assert.deepEqual(first.value, { output: f.original, code: 0 }, 'observation projection must not rewrite execution truth')
  f.corrupt()
  const second = await run('native-reducer-invalid')
  assert.equal(f.calls(), 2)
  assert.equal(second.isError, false)
  assert.equal(second.content[0].text, f.original, 'unverified evidence keeps the original observation')
  const telemetry = JSON.parse(readFileSync(join(directory, 'mechanism-telemetry-evidence-reducer.json'), 'utf8'))
  assert.equal(telemetry.kinds.reduced, 1)
})
