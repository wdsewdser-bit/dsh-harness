import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { Session, SessionStore } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { ReactLoopAgent, inboxProjectionDefinition, turnBoundaryProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { createLabAdmission, installLabToolAdmission, bootstrapCode } from '../tools/unified-natural-lab.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context } = await load('cordis')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { NodePtcRuntime } = await load('dsh-ptc-runtime-node')

async function fixture(t, override = false) {
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  return initializeNativeHost(ctx, async () => {
    const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
    projections.register(inboxProjectionDefinition); projections.register(turnBoundaryProjectionDefinition)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new AgentRegistry(ctx)
    const session = Session.create('lab-admission-root')
    sessions.enter(session); sessions.announce(session)
    const agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} })
    const tools = new ToolRuntime(ctx, {mode:'ptc'})
    new NodePtcRuntime(ctx, {timeoutMs:1000,maxTimeoutMs:2000,maxOutputBytes:4096,maxMessageBytes:4096,
      maxPendingCalls:1,maxOldGenerationSizeMb:128,graceMs:100})
    let bodies = 0
    ctx.on('tools/execute',(exec,next) => { bodies++; return next() })
    const admission = createLabAdmission(session.id)
    if (override) ctx.on('tools/pre-execute', async () => ({kind:'allow'}), {global:true,prepend:true})
    const dispose = installLabToolAdmission(ctx, admission)
    let seq = 0
    const run = code => tools.prepareScheduledExecution({name:'run_code',arguments:{code,description:'Bounded admission only'},agent,
      callId:'lab-guard-'+ ++seq,signal:new AbortController().signal})
    return { run, bodies:() => bodies, dispose }
  })
}

test('real native tool runtime denies altered program before any body, including dangerous suffix', async t => {
  const f = await fixture(t)
  for (const code of ['return "altered";', bootstrapCode + '\nawait tools.bash({command:"pwd"});']) {
    const result = await f.run(code)
    assert.equal(result.kind,'post-result','unauthorized program must never reach dispatch')
    assert.equal(result.result.isError,true)
    assert.match(JSON.stringify(result.result),/LAB_STATIC_PROBE_ONLY/)
    assert.equal(f.bodies(),0)
  }
  assert.equal((await f.run(bootstrapCode)).kind,'dispatch')
  assert.equal(f.bodies(),0)
})

test('monotonic lab admission survives a pre-execute listener that force-allows', async t => {
  const f = await fixture(t,true)
  assert.equal((await f.run('return "foreign";')).kind,'post-result')
  assert.equal(f.bodies(),0)
  assert.equal((await f.run(bootstrapCode)).kind,'dispatch')
  assert.equal(f.bodies(),0)
})
