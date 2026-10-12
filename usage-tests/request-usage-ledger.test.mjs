import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeUsage, measureRequest, observeStream, createLedgerWriter, apply,
  identityFromManifest, resolveIdentity, resolveRoute,
} from '../home/profiles/web/plugins/request-usage-ledger.mjs'

const options = () => ({ sessionId: 'member-session', provider: 'test-route', model: 'test-model', messages: [] })
const freeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }
  return value
}
const collect = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks }
const context = services => {
  const hooks = new Map()
  const ctx = { ...services, get: key => services?.[key], on: (event, fn) => {
    const entries = hooks.get(event) ?? new Set()
    entries.add(fn); hooks.set(event, entries)
    return () => entries.delete(fn)
  } }
  return { ctx, hooks }
}

test('canonical usage preserves unknowns and checks disjoint total without adding reasoning twice', () => {
  const value = normalizeUsage({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 7, reasoningTokens: 5, totalTokens: 40 })
  assert.equal(value.totalConsistent, true)
  assert.equal(value.componentSum, 40)
  assert.equal(value.reasoningTokens, 5)
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }).totalConsistent, null)
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 2 }).totalTokens, null)
  assert.equal(normalizeUsage({ cacheReadTokens: 0 }).cacheReadTokens, 0)
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) assert.equal(normalizeUsage(null)[key], null)
  assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: Infinity, totalTokens: '99' }).totalTokens, null)
  assert.equal(normalizeUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3 }).totalConsistent, false)
})

test('payload category estimates have lengths and hashes, retain no body or schema', () => {
  const secret = 'SECRET-BODY-AND-KEY-123'
  const value = measureRequest(freeze({ system: secret, tools: [{ name: 'secret-tool', description: secret, parameters: { secret } }], messages: [
    { role: 'system', content: [{ type: 'text', text: 'system' }] },
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: secret }] },
    { role: 'user', source: { kind: 'team-message', senderName: secret }, content: [{ type: 'text', text: 'team' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }, { type: 'tool-call', arguments: secret }] },
    { role: 'tool', content: [{ type: 'text', text: 'normal result' }] },
    { role: 'tool', content: [{ type: 'text', text: 'sol_pi_observation_source_v1 {}' }] },
    { role: 'tool', content: [{ type: 'text', text: 'sol_pi_evidence_receipt_v1 {}' }] },
  ] }))
  for (const key of ['system', 'toolSchema', 'ordinaryUser', 'teamInjected', 'assistantReasoning', 'assistantText', 'assistantToolCall', 'toolResult', 'observationHandle', 'reducerReceipt']) assert.ok(value.categories[key].items > 0, key)
  assert.deepEqual(value.teamSourceKinds, { 'team-message': 1 })
  assert.equal(value.categories.teamInjected.estimatedTokens, 1)
  assert.match(value.categories.system.sha256, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(value).includes(secret))
  assert.ok(!JSON.stringify(value).includes('secret-tool'))
  const unicode = measureRequest({ system: '\u4e2d\ud83d\ude00' }).categories.system
  assert.equal(unicode.bytes, 7)
  assert.equal(unicode.utf16Units, 3)
  assert.match(value.estimateMethod, /not real tokens/)
})

test('only explicit Team sources classify user/developer Team injection; non-Team and unknown stay separate', () => {
  const message = (role, source) => ({ role, ...(source === undefined ? {} : { source }), content: [{ type: 'text', text: 'SECRET-PAYLOAD' }] })
  const value = measureRequest(freeze({ messages: [
    message('user', { kind: 'team-message' }), message('developer', { kind: 'team-message' }),
    message('user', { kind: 'time-context' }), message('user', { kind: 'runtime-context' }),
    message('developer', { kind: 'tmux-context' }),
    message('user', { kind: 'future-team-looking-context' }), message('developer', { kind: 'unknown-producer' }),
    message('user', { kind: 'user' }), message('user'), message('developer'),
    message('user', { kind: 'SECRET INVALID SOURCE' }),
  ] }))
  assert.equal(value.categories.teamInjected.items, 2)
  assert.equal(value.categories.nonTeamInjected.items, 3)
  assert.equal(value.categories.unknownInjected.items, 3)
  assert.equal(value.categories.ordinaryUser.items, 2)
  assert.equal(value.categories.developer.items, 1)
  assert.deepEqual(value.teamSourceKinds, { 'team-message': 2 })
  assert.deepEqual(value.nonTeamSourceKinds, { 'time-context': 1, 'runtime-context': 1, 'tmux-context': 1 })
  assert.ok(!JSON.stringify(value).includes('SECRET'))
})

test('stream uses final snapshot, keeps exact objects, does not mutate frozen options, emits once', async () => {
  const records = []
  const request = freeze({ ...options(), purpose: 'compaction', reasoningEffort: 'high' })
  const chunks = [
    { type: 'text-delta', index: 0, text: 'SECRET-TEXT' },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 } },
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  let ticks = 1000
  const stream = observeStream(request, () => (async function* () { yield* chunks })(), { record: row => records.push(row), now: () => ticks++, uuid: () => 'local-uuid' })
  const actual = await collect(stream)
  assert.deepEqual(actual, chunks)
  chunks.forEach((chunk, index) => assert.equal(actual[index], chunk))
  await stream.next(); await stream.return()
  assert.equal(records.length, 2)
  assert.equal(records[1].usage.outputTokens, 10)
  assert.equal(records[1].usage.totalTokens, 110)
  assert.equal(records[1].usageSnapshots, 2)
  assert.equal(records[1].status, 'success')
  assert.equal(records[1].purpose, 'compaction')
  assert.equal(records[1].requestId, 'local-uuid')
  assert.ok(!JSON.stringify(records).includes('SECRET-TEXT'))
  assert.equal(request.reasoningEffort, 'high')
})

test('concurrent streams keep independent UUIDs and usage state', async () => {
  const records = []
  const stream = (n) => observeStream(options(), () => (async function* () { await Promise.resolve(); yield { type: 'usage', usage: { inputTokens: n, outputTokens: n } } })(), { record: row => records.push(row) })
  await Promise.all([collect(stream(1)), collect(stream(7))])
  const terminal = records.filter(row => row.event === 'terminal')
  assert.equal(new Set(terminal.map(row => row.requestId)).size, 2)
  assert.deepEqual(terminal.map(row => row.usage.inputTokens).sort(), [1, 7])
  terminal.forEach(row => assert.equal(records.filter(other => other.requestId === row.requestId).length, 2))
})

test('synchronous/stream errors propagate unchanged with safe code and existing request ID only', async () => {
  const error = Object.assign(new Error('SECRET-ERROR-BODY'), { code: 'RATE_LIMIT', requestId: 'provider-req-1', headers: { authorization: 'SECRET-HEADER' } })
  for (const next of [() => { throw error }, () => (async function* () { yield { type: 'text-delta', text: 'SECRET-CHUNK' }; throw error })()]) {
    const records = []
    try { await collect(observeStream(options(), next, { record: row => records.push(row) })); assert.fail('expected throw') } catch (caught) { assert.equal(caught, error) }
    assert.equal(records.length, 2)
    assert.equal(records[1].status, 'error')
    assert.equal(records[1].failure.code, 'RATE_LIMIT')
    assert.equal(records[1].providerRequestId, 'provider-req-1')
    assert.ok(!JSON.stringify(records).includes('SECRET'))
  }
})

test('abort/failure chunks and early iterator return have one terminal without altering underlying return', async () => {
  const controller = new AbortController()
  const records = []
  const failure = { type: 'finish', reason: { kind: 'aborted', failure: { message: 'SECRET-FAILURE', code: 'CANCELLED', requestId: 'req-abort' } } }
  await collect(observeStream({ ...options(), signal: controller.signal }, () => (async function* () { yield failure })(), { record: row => records.push(row) }))
  assert.equal(records[1].status, 'aborted')
  assert.equal(records[1].providerRequestId, 'req-abort')
  assert.ok(!JSON.stringify(records).includes('SECRET'))
  const early = []
  let returned = false
  const stream = observeStream(options(), () => (async function* () { try { yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }; yield 'more' } finally { returned = true } })(), { record: row => early.push(row) })
  await stream.next()
  const result = await stream.return('caller-value')
  assert.deepEqual(result, { value: 'caller-value', done: true })
  await stream.return()
  assert.equal(returned, true)
  assert.equal(early.length, 2)
  assert.equal(early[1].status, 'consumer-return')
  assert.equal(early[1].complete, false)
  const beforeStart = []
  await observeStream(options(), () => (async function* () { yield 1 })(), { record: row => beforeStart.push(row) }).return()
  assert.equal(beforeStart.length, 2)
  const aborted = []
  controller.abort()
  await collect(observeStream({ ...options(), signal: controller.signal }, () => (async function* () {})(), { record: row => aborted.push(row) }))
  assert.equal(aborted[1].status, 'aborted')
})

test('iterator return that yields from finally is preserved until real terminal', async () => {
  const records = []
  const stream = observeStream(options(), () => (async function* () { try { yield 1 } finally { yield 2 } })(), { record: row => records.push(row) })
  assert.deepEqual(await stream.next(), { value: 1, done: false })
  assert.deepEqual(await stream.return('sentinel'), { value: 2, done: false })
  assert.equal(records.length, 1)
  assert.deepEqual(await stream.next(), { value: 'sentinel', done: true })
  assert.equal(records.length, 2)
  assert.equal(records[1].status, 'consumer-return')
  assert.equal(records[1].complete, false)
})

test('consumer throw is delegated and recovered underlying result stays transparent', async () => {
  const records = []
  const stream = observeStream(options(), () => (async function* () { try { yield 1 } catch { yield 2 } })(), { record: row => records.push(row) })
  await stream.next()
  assert.deepEqual(await stream.throw(new Error('secret')), { value: 2, done: false })
  await stream.next()
  assert.equal(records[1].status, 'success')
})

test('writer/record failure is fail-open, nonblocking and warnings are bounded', async () => {
  const records = []
  const log = []
  const writer = createLedgerWriter({ directory: 'unused', instanceId: 'test', logger: { warn: row => log.push(row) }, maxPending: 2,
    io: { mkdir: async () => {}, appendFile: async () => { await Promise.resolve(); throw new Error('SECRET-WRITE-ERROR') } } })
  for (let n = 0; n < 1000; n++) writer.enqueue({ n })
  await writer.flush()
  assert.equal(writer.stats().pending, 0)
  assert.equal(writer.stats().failures, 1000)
  assert.ok(log.length <= 8)
  assert.ok(!JSON.stringify(log).includes('SECRET'))
  const stream = observeStream(options(), () => (async function* () { yield 1 })(), { record: row => { records.push(row); throw new Error('failure') } })
  assert.deepEqual(await collect(stream), [1])
  assert.equal(records.length, 2)
  assert.deepEqual(await collect(observeStream(options(), () => (async function* () { yield 2 })(), { record: () => Promise.reject(new Error('async failure')) })), [2])
})

test('identity handles manifest schema, live relationship and unknown nulls', () => {
  const manifest = { sessions: { child: { sessionId: 'child', parentSessionId: 'root', rootTeamId: 'team-a', workspace: 'D:\\workspace' } } }
  assert.equal(identityFromManifest(manifest, 'child').parentId, 'root')
  const unknown = resolveIdentity({}, 'not-present', manifest)
  assert.deepEqual(unknown, { rootTeamId: null, rootSessionId: null, immediateTeamId: null, immediateTeamRootId: null,
    parentId: null, workspace: null, identitySource: 'unknown', globalRootSource: 'unknown', globalRootStatus: 'unknown', lineageDepth: 0 })
  const agent = { id: 'child', session: { header: { cwd: 'D:\\live', parentSession: 'live-parent' } } }
  const ctx = { agents: { get: () => agent }, agentTeams: { tryMembership: () => ({ id: 'team-live', root: { id: 'root-live' } }) } }
  const live = resolveIdentity(ctx, 'child', manifest)
  assert.equal(live.rootTeamId, 'team-a')
  assert.equal(live.rootSessionId, 'team-a')
  assert.equal(live.immediateTeamId, 'team-live')
  assert.equal(live.immediateTeamRootId, 'root-live')
  assert.equal(live.parentId, 'live-parent')
  assert.equal(live.workspace, 'D:\\live')
  const teammate = resolveIdentity({ agentTeams: { tryMembership: () => ({ id: 'team-live', root: { id: 'root-live' }, role: 'teammate' }) } }, 'child', null, null, { id: 'child' })
  assert.equal(teammate.parentId, 'root-live')
  assert.equal(teammate.rootTeamId, null)
})

test('verified global root wins over tier2 immediate membership', () => {
  const child = { id: 'tier2-child', session: { header: { parentSession: 'tier1-lead', cwd: 'D:\\nested' } } }
  const lead = { id: 'tier1-lead', session: { header: { parentSession: 'user-root' } } }
  const manifest = { sessions: { 'tier2-child': { rootTeamId: 'user-root', parentSessionId: 'tier1-lead', lineageStatus: 'resolved' } } }
  const ctx = { agents: { get: id => id === child.id ? child : id === lead.id ? lead : null },
    agentTeams: { tryMembership: () => ({ id: 'tier1-lead', root: lead, role: 'teammate' }) } }
  const result = resolveIdentity(ctx, child.id, manifest)
  assert.equal(result.rootTeamId, 'user-root')
  assert.equal(result.rootSessionId, 'user-root')
  assert.equal(result.immediateTeamId, 'tier1-lead')
  assert.equal(result.parentId, 'tier1-lead')
  assert.equal(result.globalRootSource, 'history-manifest')
})

test('new descendants trace live parent chains or a verified manifest ancestor', () => {
  const live = new Map([
    ['fresh-child', { id: 'fresh-child', session: { header: { parentSession: 'tier2-lead' } } }],
    ['tier2-lead', { id: 'tier2-lead', session: { header: { parentSession: 'tier1-lead' } } }],
    ['tier1-lead', { id: 'tier1-lead', session: { header: { parentSession: 'user-root' } } }],
    ['user-root', { id: 'user-root', session: { header: { cwd: 'D:\\root' } } }],
  ])
  const ctx = { agents: { get: id => live.get(id) }, agentTeams: { tryMembership: () => ({ id: 'tier2-lead', root: live.get('tier2-lead'), role: 'teammate' }) } }
  const result = resolveIdentity(ctx, 'fresh-child')
  assert.equal(result.rootTeamId, 'user-root')
  assert.equal(result.immediateTeamId, 'tier2-lead')
  assert.equal(result.parentId, 'tier2-lead')
  assert.equal(result.globalRootSource, 'live-parent-chain')
  assert.equal(result.lineageDepth, 3)
  live.delete('user-root')
  const manifest = { sessions: { 'tier1-lead': { rootTeamId: 'user-root', lineageStatus: 'resolved' } } }
  assert.equal(resolveIdentity(ctx, 'fresh-child', manifest).rootTeamId, 'user-root')
  const cached = new Map([['tier1-lead', { rootTeamId: 'user-root', rootSessionId: 'user-root' }]])
  assert.equal(resolveIdentity(ctx, 'fresh-child', null, null, null, cached).rootTeamId, 'user-root')
  live.delete('tier1-lead')
  assert.equal(resolveIdentity(ctx, 'fresh-child', manifest).rootTeamId, 'user-root')
  assert.equal(resolveIdentity(ctx, 'fresh-child').rootTeamId, null)
})

test('lineage tracing detects cycles, limits depth and never promotes an unresolved parent', () => {
  const cycle = new Map(['a', 'b'].map((id, index) => [id, { id, session: { header: { parentSession: index === 0 ? 'b' : 'a' } } }]))
  const cyc = resolveIdentity({ agents: { get: id => cycle.get(id) } }, 'a')
  assert.equal(cyc.rootTeamId, null)
  assert.equal(cyc.globalRootStatus, 'cycle')
  let reads = 0
  const deep = resolveIdentity({ agents: { get: id => { reads++; return { id, session: { header: { parentSession: 'node-' + (Number(id.slice(5)) + 1) } } } } } }, 'node-0')
  assert.equal(deep.rootTeamId, null)
  assert.equal(deep.globalRootStatus, 'depth-limit')
  assert.ok(reads <= 65)
  const orphan = { id: 'orphan', session: { header: { origin: 'subagent' } } }
  assert.equal(resolveIdentity({}, 'orphan', null, null, orphan).rootTeamId, null)
  assert.equal(identityFromManifest({ sessions: { a: { rootTeamId: 'bad-root', lineageStatus: 'cycle', teamId: 'immediate' } } }, 'a').rootTeamId, null)
  assert.equal(identityFromManifest({ sessions: { a: { teamId: 'immediate' } } }, 'a').rootTeamId, null)
})

test('route reads array/object live Settings and strips URL secrets, defaults stay unknown', () => {
  const value = { providers: { 'test-route': { baseURL: 'https://u:SECRET@api.example/v1?key=SECRET#SECRET', api: 'openai-responses', apiKeyEnv: 'SECRET', headers: { key: 'SECRET' } } } }
  for (const description of [[{ ns: 'llm-pi-ai', value }], { namespaces: [{ ns: 'llm-pi-ai', value }] }]) {
    const route = resolveRoute({ get: () => ({ describe: () => description }) }, options())
    assert.equal(route.endpoint, 'https://api.example/v1')
    assert.equal(route.protocol, 'openai-responses')
    assert.equal(route.routeSource, 'live-settings:llm-pi-ai.providers')
    assert.ok(!JSON.stringify(route).includes('SECRET'))
  }
  const missing = resolveRoute({}, options())
  assert.equal(missing.endpoint, null)
  assert.equal(missing.protocol, null)
  assert.equal(missing.routeSource, 'unknown')
})

test('HMR detach keeps inflight final usage and one real terminal, never accessing disposed services', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'request-ledger-test-'))
  try {
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify({ sessions: { 'member-session': { rootTeamId: 'manifest-team', parentSessionId: 'manifest-parent', workspace: 'D:\\manifest' } } }))
    let forbidContextRead = false
    let forbiddenContextReads = 0
    const state = context({})
    state.ctx.get = () => { if (forbidContextRead) forbiddenContextReads++; return null }
    const dispose = apply(state.ctx, { directory, identityManifestPath: manifestPath, profile: 'headless' })
    await dispose.ready
    const listener = [...state.hooks.get('llm/stream')][0]
    const chunks = [{ type: 'usage', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } },
      { type: 'text-delta', text: 'SECRET-OUTPUT' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } },
      { type: 'finish', reason: { kind: 'stop' } }]
    const stream = listener(freeze(options()), () => (async function* () { yield* chunks })())
    assert.equal((await stream.next()).value, chunks[0])
    await dispose()
    forbidContextRead = true
    assert.equal(dispose.stats().inflight, 1)
    assert.equal((await stream.next()).value, chunks[1])
    assert.equal((await stream.next()).value, chunks[2])
    assert.equal((await stream.next()).value, chunks[3])
    await stream.next()
    await dispose.flush()
    assert.equal(forbiddenContextReads, 0)
    assert.equal(dispose.stats().inflight, 0)
    const rows = (await readFile(dispose.stats().file, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].status, 'success')
    assert.equal(rows[1].complete, true)
    assert.equal(rows[1].rootTeamId, 'manifest-team')
    assert.equal(rows[1].workspace, 'D:\\manifest')
    assert.equal(rows[1].usage.outputTokens, 8)
    assert.equal(rows[1].usage.totalTokens, 18)
    assert.equal(rows[0].requestId, rows[1].requestId)
    assert.ok(!JSON.stringify(rows).includes('SECRET'))
    const runtime = (await readFile(dispose.stats().runtimeFile, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(runtime.map(row => row.event), ['loaded', 'disposed'])
    assert.match(runtime[0].moduleHash, /^[a-f0-9]{64}$/)
    assert.equal(runtime[0].pid, process.pid)
    assert.equal(runtime[0].profile, 'headless')
    assert.equal(runtime[1].inflight, 1)
    assert.equal(state.hooks.get('llm/stream').size, 0)
    assert.match(dispose.stats().file, new RegExp(`requests-${process.pid}-`))
    forbidContextRead = false
    const second = apply(state.ctx, { directory, identityManifestPath: manifestPath })
    await second.ready; await second()
    assert.notEqual(second.stats().file, dispose.stats().file)
    assert.equal((await readdir(directory)).filter(file => file.startsWith('runtime-status-')).length, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('projection metadata records only safe runtime receipts, not transform body or credentials', async () => {
  const { resolveProjection } = await import('../home/profiles/web/plugins/request-usage-ledger.mjs')
  const state = context({})
  state.ctx.get = key => key === 'requestMessageProjection' ? {
    stats: () => ({ pid: 42, moduleHash: 'a'.repeat(64), installed: true, secret: 'DO_NOT_RECORD' }),
    audit: () => ({ call: 3, changed: true, transforms: [{ id: 'sdk', status: 'applied', order: 10,
      beforeMessages: 8, afterMessages: 8, metadata: { sha256: 'b'.repeat(64), raw: 'DO_NOT_RECORD' } }] }),
  } : null
  const result = resolveProjection(state.ctx, {})
  assert.equal(result.installed, true)
  assert.equal(result.changed, true)
  assert.equal(result.transforms[0].metadataHash, 'b'.repeat(64))
  assert.ok(!JSON.stringify(result).includes('DO_NOT_RECORD'))
  assert.equal(resolveProjection({ get: () => null }, {}), null)
})

test('agent events cache header attribution even if the registry is unavailable later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'request-ledger-events-'))
  try {
    const state = context({})
    const dispose = apply(state.ctx, { directory, identityManifestPath: join(directory, 'missing.json') })
    await dispose.ready
    const agent = { id: 'member-session', session: { header: { cwd: 'D:\\event-workspace', parentSession: 'event-parent' } } }
    for (const listener of state.hooks.get('agent/status')) listener({ agent, status: 'running' })
    const listener = [...state.hooks.get('llm/stream')][0]
    await collect(listener(options(), () => (async function* () {})()))
    await dispose()
    const rows = (await readFile(dispose.stats().file, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows[1].workspace, 'D:\\event-workspace')
    assert.equal(rows[1].parentId, 'event-parent')
    assert.equal(rows[1].rootTeamId, null)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
