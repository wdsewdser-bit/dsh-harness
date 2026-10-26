import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './v16-capabilities-fixture.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { ToolRuntime, renderToolsSdk } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { installToolReferences, createToolReferences } from '../home/profiles/web/plugins/team-v16-tool-references.mjs'
import { createSdkCatalog, installSdkCatalog } from '../home/profiles/web/plugins/team-v16-sdk-catalog.mjs'
import { createContextEpisodes } from '../home/profiles/web/plugins/team-v16-context-episodes.mjs'
import { canonical } from '../home/profiles/web/plugins/team-v16-capability-common.mjs'
import { NodePtcRuntime } from '../app/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js'
import { SandboxPolicyService } from '../app/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js'
import { LocalSandboxProvider } from '../app/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js'
import { LocalSubprocessRuntime } from '../app/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js'
import { LocalFileSystem } from '../app/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js'
const authority = () => ({ role: 'root', workspace: 'fixture', task: 't1', taskRevision: 2, plan: 'collector-plan', planRevision: 1 })
const signal = () => new AbortController().signal

test('v16 lossless canonical JSON rejects lossy and executable shapes', () => {
  assert.equal(canonical({ z: 2, a: [1, null] }), '{"a":[1,null],"z":2}')
  for (const value of [undefined, NaN, -0, { x: undefined }, [,,], new Date(), { get x() { throw new Error('must not run') } }]) assert.throws(() => canonical(value))
  const circular = {}; circular.self = circular; assert.throws(() => canonical(circular))
})

test('v16 references use native pre guard around post result with canonical args and parent token', async t => {
  const f = await fixture(t), stages = [], childExecs = []
  await initializeNativeHost(f.ctx, async () => {
    const tools = new ToolRuntime(f.ctx, { mode: 'both' })
    f.tools = tools
    tools.register({ name: 'echo', description: 'Fixture echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_, value) => [{ type: 'text', text: 'render:' + value.text }] },
      execute(args, exec) { assert.ok(Object.isFrozen(exec.arguments)); childExecs.push(exec); exec.deferContext({ role: 'user', content: [{ type: 'text', text: 'deferred' }] }); exec.concludeTurn(); return args } })
    for (const stage of ['tools/pre-execute', 'tools/execute', 'tools/post-execute']) f.ctx.on(stage, async (exec, ...rest) => {
      if (exec.name === 'echo') stages.push(stage)
      return rest.at(-1)()
    }, { global: true })
    tools.guard(exec => { if (exec.name === 'echo') { stages.push('guard'); if (exec.arguments.text === 'denied') return 'WRITE_SCOPE_DENIED' } })
    f.ctx.on('tools/result', exec => { if (exec.name === 'echo') stages.push('result') }, { global: true })
    f.installed = installToolReferences(f.ctx, { resolveActor: authority })
  })
  t.after(() => f.installed.dispose())
  const run = (name, args, opts = {}) => f.tools.execute({ name, arguments: args, callId: 'outer', rootCallId: 'root-call', agent: f.agent, signal: signal(), ...opts })
  const inline = await run('echo', { text: 'exact' })
  const put = await run('tool_ref_put', { tool: 'echo', arguments: { text: 'exact' } })
  assert.equal(put.isError, false)
  stages.length = 0
  const ref = { ref: put.value.ref, hash: put.value.hash }
  let parentToken
  const stop = f.ctx.on('tools/pre-execute', (exec, next) => { if (exec.name === 'tool_ref_invoke') parentToken = exec.token; return next() }, { global: true })
  const indirect = await run('tool_ref_invoke', ref)
  stop()
  assert.deepEqual(indirect, inline)
  assert.deepEqual(stages, ['tools/pre-execute', 'guard', 'tools/execute', 'tools/post-execute', 'result'])
  assert.equal(childExecs.at(-1).parent, parentToken)
  assert.equal(childExecs.at(-1).rootCallId, 'root-call')
  assert.notEqual(childExecs.at(-1).callId, 'outer')
  const denied = (await run('tool_ref_put', { tool: 'echo', arguments: { text: 'denied' } })).value
  assert.deepEqual(await run('tool_ref_invoke', { ref: denied.ref, hash: denied.hash }), await run('echo', { text: 'denied' }))
  const abort = new AbortController(); abort.abort()
  assert.deepEqual(await run('tool_ref_invoke', ref, { signal: abort.signal }), await run('echo', { text: 'exact' }, { signal: abort.signal }))
  assert.equal((await run('tool_ref_invoke', { ...ref, hash: 'bad' })).isError, true)
  const invalid = (await run('tool_ref_put', { tool: 'echo', arguments: { wrong: true } })).value
  assert.deepEqual(await run('tool_ref_invoke', { ref: invalid.ref, hash: invalid.hash }), await run('echo', { wrong: true }))
  assert.equal((await run('tool_ref_revoke', ref)).isError, false)
  assert.equal((await run('tool_ref_invoke', ref)).isError, true)
})

test('v16 reference TTL role task session schema sharing and recursive composites fail closed', async t => {
  const f = await fixture(t)
  await initializeNativeHost(f.ctx, async () => { f.tools = new ToolRuntime(f.ctx); f.stop = f.tools.register({ name: 'echo', description: 'echo', parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute: args => args }) })
  let clock = 10, revision = 2
  const service = createToolReferences(f.ctx, { now: () => clock, resolveActor: () => ({ ...authority(), taskRevision: revision }) })
  const exec = { agent: f.agent, token: Symbol(), signal: signal(), callId: 'p' }
  const request = { tool: 'echo', arguments: { x: 1 }, ttlMs: 10 }
  const row = service.put(request, exec), ref = { ref: row.ref, hash: row.hash }
  assert.deepEqual(service.read(ref, exec).arguments, { x: 1 })
  revision++; assert.throws(() => service.read(ref, exec), /ACL_DENIED/); revision--
  f.revoke(); assert.throws(() => service.read(ref, exec), /ACTOR_DENIED/); f.restoreRoster()
  assert.throws(() => service.put({ ...request, shareWith: [{ ...authority(), team: 'other' }] }, exec), /SHARE_DENIED/)
  assert.throws(() => service.put({ tool: 'tool_ref_invoke', arguments: {} }, exec), /RECURSION/)
  clock = 20; assert.throws(() => service.read(ref, exec), /UNAVAILABLE/)
  clock = 10
  await initializeNativeHost(f.ctx, async () => { f.stop(); f.tools.register({ name: 'echo', description: 'changed', parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute: args => args }) })
  assert.throws(() => service.read(ref, exec), /SCHEMA_CHANGED/)
  service.dispose(); assert.throws(() => service.read(ref, exec), /CLOSED/)
})

test('v16 native SDK catalog pages every visible schema, rejects stale scope and projects exact renderer only', async t => {
  const f = await fixture(t)
  await initializeNativeHost(f.ctx, async () => {
    f.tools = new ToolRuntime(f.ctx, { mode: 'both' })
    for (let i = 0; i < 5; i++) f.tools.register({ name: 'tool_' + i, description: 'Native fixture ' + i, parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute: () => ({}) })
    f.catalog = installSdkCatalog(f.ctx, { isolated: true, projectCore: true })
  })
  t.after(() => f.catalog.dispose())
  const catalog = f.catalog.service, names = []
  let cursor
  do { const page = catalog.list(f.agent, { cursor, limit: 2 }); names.push(...page.tools.map(row => row.name)); cursor = page.cursor } while (cursor)
  assert.deepEqual(names, f.tools.schemas(f.agent).map(row => row.name).sort())
  for (const name of names) assert.deepEqual(catalog.describe(f.agent, name).schema.parameters, f.tools.get(name, f.agent).parameters)
  assert.throws(() => catalog.describe(f.agent, 'unknown'), /TOOL_DENIED/)
  const old = catalog.list(f.agent, { limit: 1 }).cursor
  let restore
  await initializeNativeHost(f.ctx, async () => { restore = f.agent.ctx.tools.restrict({ deny: ['tool_4'] }) })
  assert.throws(() => catalog.list(f.agent, { cursor: old }), /CURSOR_STALE/)
  assert.throws(() => catalog.describe(f.agent, 'tool_4'), /TOOL_DENIED/)
  assert.equal((await f.tools.execute({ name: 'tool_4', arguments: {}, callId: 'hidden', signal: signal(), agent: f.agent })).isError, true)
  restore()
  const rows = f.tools.schemas(f.agent).filter(row => row.name !== 'run_code').map(row => ({ ...row, output: f.tools.get(row.name, f.agent).output.schema }))
  const full = renderToolsSdk(rows), core = renderToolsSdk(rows.filter(row => row.name === 'sdk_catalog'))
  const options = f.request()
  options.messages = [{ id: 'sdk-system', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'prefix\n' + full + '\nsuffix' }] }]
  const projected = catalog.project(options)
  assert.equal(projected.messages[0].content[0].text, 'prefix\n' + core + '\nsuffix')
  assert.ok(Buffer.byteLength(projected.messages[0].content[0].text) < Buffer.byteLength(options.messages[0].content[0].text))
  for await (const _ of f.llm.stream(options)) {}
  assert.equal(f.captured.at(-1).messages[0].content[0].text, 'prefix\n' + core + '\nsuffix')
  const unknown = f.request(); unknown.messages = [{ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: full.replace('interface ToolArgsMap', 'interface UnknownArgsMap') }] }]
  assert.equal(catalog.project(unknown).messages, unknown.messages)
  assert.equal(createSdkCatalog(f.ctx).project(options).messages, options.messages)
})

test('v16 episodes use real collector durable retention and exact read, revoke role stale pending and debt', async t => {
  const f = await fixture(t), service = createContextEpisodes(f.ctx, { collector: f.service, resolveActor: authority })
  const result = await service.collect(f.agent)
  assert.equal(result.ids.length, 1)
  const id = result.ids[0], exact = service.read(f.agent, id)
  assert.deepEqual(exact.events, f.service.readRecovery(f.session.id, f.service.authorityForSurface(f.session.id).capture(f.session.id).source.completedSpans[0].retentionReceipt))
  assert.ok(exact.events.some(event => event.type === 'turn/start'))
  assert.ok(exact.events.some(event => event.type === 'turn/end'))
  assert.match(service.summarize(f.agent, id).text, /completed but raw original/)
  assert.equal(service.list(f.agent).length, 1)
  f.changeTier(); assert.throws(() => service.read(f.agent, id)); f.restoreRoster()
  await f.control.mutateHot('fixture/changed', {}, f.agent, state => { state.boards.global.tasks.t1.revision++ }, { deferMs: 0 })
  assert.throws(() => service.read(f.agent, id), /STALE/)
  const again = (await service.collect(f.agent)).ids[0]
  service.revoke(f.agent, again); assert.throws(() => service.read(f.agent, again), /DENIED/)
  assert.deepEqual((await service.collect(f.agent)).ids, [], 'recollection must not resurrect a revoked episode')
  const noAuthority = createContextEpisodes(f.ctx)
  assert.throws(() => noAuthority.list(f.agent), /AUTHORITY_REQUIRED/)
  service.dispose(); assert.throws(() => service.list(f.agent), /AUTHORITY_REQUIRED/)
})

test('v16 episodes reject native pending input and history debt without consuming or rewriting either', async t => {
  const f = await fixture(t), service = createContextEpisodes(f.ctx, { collector: f.service, resolveActor: authority })
  const id = (await service.collect(f.agent)).ids[0]
  await f.control.mutateHot('fixture/history-debt', {}, f.agent, state => {
    state.v15HistoryRecall = { debts: { h: { status: 'required', readerSessionId: f.session.id, sourceRef: { seq: 1 } } } }
  }, { deferMs: 0 })
  assert.throws(() => service.read(f.agent, id), /RECOVERY_PENDING/)
  await f.control.mutateHot('fixture/clear-history-debt', {}, f.agent, state => { state.v15HistoryRecall = { debts: {} } }, { deferMs: 0 })
  f.agent.inbox.append('next-step', { id: 'pending', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'current correction' }] })
  const before = f.session.snapshotEvents()
  assert.throws(() => service.list(f.agent), /RECOVERY_PENDING/)
  assert.equal(f.agent.inbox.nextStep[0].id, 'pending')
  assert.deepEqual(f.session.snapshotEvents(), before)
})

test('v16 code references execute one real native run_code instance and block composite reference cycles', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  let runs = 0, calls = 0, installed
  await initializeNativeHost(f.ctx, async () => {
    f.tools = new ToolRuntime(f.ctx, { mode: 'both' })
    new SandboxPolicyService(f.ctx, { mode: 'read-only', workspaceRoot: f.root })
    new LocalSandboxProvider(f.ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 })
    new LocalSubprocessRuntime(f.ctx)
    new LocalFileSystem(f.ctx, { cwd: f.root, diffBasisMaxBytes: 1048576 })
    const runtime = new NodePtcRuntime(f.ctx, { timeoutMs: 5000, maxTimeoutMs: 6000, maxOutputBytes: 8192, maxMessageBytes: 8192, maxPendingCalls: 8, maxOldGenerationSizeMb: 128, graceMs: 100 })
    const original = runtime.run.bind(runtime)
    runtime.run = spec => { runs++; return original(spec) }
    f.tools.register({ name: 'once', description: 'Count one native child dispatch', parameters: { type: 'object' }, output: { schema: {}, render: () => [] }, execute() { calls++; return { calls } } })
    installed = installToolReferences(f.ctx, { resolveActor: authority })
  })
  t.after(() => installed.dispose())
  const run = (name, args) => f.tools.execute({ name, arguments: args, callId: 'code-parent', agent: f.agent, signal: signal() })
  const row = (await run('tool_ref_put', { tool: 'run_code', kind: 'code', arguments: { code: 'return await tools.once({});', description: 'Count once' } })).value
  const outcome = await run('tool_ref_invoke', { ref: row.ref, hash: row.hash })
  assert.equal(outcome.isError, false, JSON.stringify(outcome))
  assert.equal(runs, 1)
  assert.equal(calls, 1)
  assert.equal((await run('tool_ref_invoke', { ref: row.ref, hash: row.hash })).isError, true)
  assert.equal(runs, 1, 'a code reference cannot restart an already started native instance')
  const recursive = (await run('tool_ref_put', { tool: 'run_code', kind: 'code', arguments: { code: 'return await tools.tool_ref_invoke(' + JSON.stringify({ ref: row.ref, hash: row.hash }) + ');', description: 'Ref cycle must fail' } })).value
  const denied = await run('tool_ref_invoke', { ref: recursive.ref, hash: recursive.hash })
  assert.equal(denied.isError, true)
  assert.match(JSON.stringify(denied), /RECURSION/)
  assert.equal(runs, 2, 'cycle starts only the outer run, never duplicates the referenced instance')
  assert.equal(calls, 1)
})
