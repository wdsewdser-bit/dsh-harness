import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { captureLoadedPtcBinding } from '../tools/capture-lab-ptc-binding.mjs'
import { apply as applyContext } from '../home/profiles/web/plugins/context-workspace.mjs'
import { initializeNativeHost } from '../native-tests/native-host-fixture.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { ToolRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')))
const { NodePtcRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-ptc-runtime-node')))
const route = { provider: 'opencodego', model: 'deepseek-v4.1-flash' }
const sha = value => createHash('sha256').update(value).digest('hex')

export async function fixture() {
  const ctx = new Context()
  return initializeNativeHost(ctx, () => {
  for (const name of ['systemPrompt', 'agents', 'sessionProjections', 'requestMessageProjection']) ctx.provide(name)
  ctx.set('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 1 } })
  const tools = new ToolRuntime(ctx, { mode: 'ptc' })
  const runtime = new NodePtcRuntime(ctx, { timeoutMs: 1000, maxTimeoutMs: 2000, maxOutputBytes: 4096, maxMessageBytes: 4096, maxPendingCalls: 1, maxOldGenerationSizeMb: 128, graceMs: 100 })
  const agent = { id: 'session-offline', ctx, session: { id: 'session-offline', requestHeader() { return { config: route } } } }
  let preset = 'ptc', pending = route, registered = agent
  ctx.set('agents', { get() { return registered }, list() { return [agent] } })
  ctx.set('sessionProjections', { stateOf(session, name) { assert.equal(session, agent.session); return name === 'agentPreset' ? preset : { pending } } })
  ctx.set('requestMessageProjection', { register() { return () => {} } })
  const stop = applyContext(ctx, { mode: 'shadow' })
  const options = { expectedRoute: route, expectedSessionId: agent.session.id }
  return { ctx, tools, runtime, agent, options,
    stop: () => initializeNativeHost(ctx, () => stop()),
    capture: () => captureLoadedPtcBinding(ctx, agent, options), preset(value) { preset = value }, pending(value) { pending = value }, registered(value) { registered = value } }
  })
}

test('offline real stage services and plugin render loaded TypeScript schemas without dispatch', async t => {
  const f = await fixture(), result = f.capture()
  t.after(f.stop)
  assert.equal(result.language, 'typescript')
  assert.equal(result.schemaCount, 1)
  assert.equal(result.sdkSha256, sha(f.tools.sdkSection().text({ scope: f.agent, agent: f.agent })))
  assert.equal(result.toolsSchemaBindings.context_manage, sha(JSON.stringify(f.tools.sdkSchemas(f.agent)[0].parameters)))
  assert.equal(result.pid, process.pid)
  assert.deepEqual(result.route, route)
  const formal = JSON.parse(readFileSync(new URL('./context-workspace.schema.json', import.meta.url)))
  const loaded = JSON.parse(readFileSync(new URL('./context-workspace.loaded.schema.json', import.meta.url)))
  assert.notDeepEqual(result.contextParameters, formal)
  assert.deepEqual(result.contextParameters, loaded)
  f.pending(null)
  assert.deepEqual(f.capture().route, route)
})

test('missing foreign non-PTC and caller certificates cannot replace loaded facts', async t => {
  const f = await fixture()
  t.after(f.stop)
  assert.throws(() => captureLoadedPtcBinding(f.ctx, f.agent, { ...f.options, expectedSessionId: 'foreign' }), /SESSION_REQUIRED/)
  f.registered({ ...f.agent }); assert.throws(f.capture, /AGENT_REQUIRED/); f.registered(f.agent)
  f.tools.defaultMode = 'native'; assert.throws(f.capture, /MODE_REQUIRED/); f.tools.defaultMode = 'ptc'
  f.preset('native'); assert.throws(f.capture, /PRESET_REQUIRED/); f.preset('ptc')
  f.pending({ ...route, model: 'foreign' }); assert.throws(f.capture, /ROUTE_REQUIRED/); f.pending(route)
  f.runtime.language = 'python'; assert.throws(f.capture, /MODE_REQUIRED/); f.runtime.language = 'typescript'
  f.runtime.disposed = true; assert.throws(f.capture, /SERVICES_REQUIRED/); f.runtime.disposed = false
  assert.throws(() => captureLoadedPtcBinding({ get() { return undefined } }, f.agent, { ...f.options, certificate: f.capture() }), /AGENT_REQUIRED/)
})

test('native owned children bind their real runtime route without taking over generic Session routing',async t => {
  const f = await fixture();t.after(f.stop)
  f.pending(null);f.agent.session.requestHeader = () => undefined
  f.agent.options = {...route};f.agent.session.header = {parentSession:'parent'}
  const parent = {},registry = f.ctx.get('agents'),get = registry.get
  registry.get = id => id === 'parent' ? parent : get(id)
  registry.isOwnedBy = (id,owner) => id === f.agent.id && owner === parent
  assert.equal(f.capture().routeSource,'native-owned-child-options')
  f.agent.options.model = 'foreign';assert.throws(f.capture,/ROUTE_REQUIRED/)
  f.agent.options.model = route.model;registry.isOwnedBy = () => false
  assert.throws(f.capture,/ROUTE_REQUIRED/)
  delete f.agent.session.header.parentSession;assert.throws(f.capture,/ROUTE_REQUIRED/)
})
