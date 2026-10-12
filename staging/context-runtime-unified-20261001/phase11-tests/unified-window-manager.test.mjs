import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../home/profiles/web/plugins/team-v15-window-manager.mjs'

const require = createRequire(new URL('../../../app/package.json', import.meta.url))
const official = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))

const SECRET = 'TOPSECRET-MESSAGE-BODY-9f3a'

function usageChunks(inputTokens, cacheReadTokens, cacheWriteTokens) {
  const total = inputTokens + cacheReadTokens + cacheWriteTokens + 1
  return [
    { type: 'usage', providerRequestId: 'provider-request-1', usage: {
      inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens: 1, totalTokens: total,
    } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function tempDir(t, prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(base, { recursive: true, force: true }))
  return base
}

function fixture(t, config = {}) {
  const cordis = new Context()
  const llm = new official.LlmRuntime(cordis)
  const captured = []
  const scripts = []
  const warnings = []
  const listenerStops = new Map()
  const effects = []
  const unregisterAdapter = llm.registerAdapter(['fixture'], new class extends official.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) {
      return { model: { provider, id: model, name: model }, stream(options) {
        captured.push(options)
        const chunks = scripts.shift() ?? [{ type: 'finish', reason: { kind: 'stop' } }]
        return (async function* () { for (const chunk of chunks) yield chunk })()
      } }
    }
  }())
  const agent = { id: 'agent-root', name: 'root', session: { id: 'session-root' }, status: 'idle' }
  const ctx = {
    llm,
    agents: { list: () => [agent], get: id => [agent].find(row => row.id === id || row.session.id === id) },
    logger: { warn: message => warnings.push(String(message)) },
    on(name, listener, options) {
      const stop = cordis.on(name, listener, options)
      const stops = listenerStops.get(name) ?? new Set()
      stops.add(stop)
      listenerStops.set(name, stops)
      return () => { stop(); stops.delete(stop) }
    },
    effect(register) { effects.push(register) },
  }
  const stop = apply(ctx, config)
  t.after(async () => {
    await stop()
    unregisterAdapter()
  })
  return { llm, cordis, ctx, agent, captured, scripts, warnings, listenerStops, effects, stop }
}

async function send(f, spec = {}) {
  if (spec.chunks !== undefined) f.scripts.push(spec.chunks)
  const controller = new AbortController()
  if (spec.abort === true) controller.abort()
  const options = {
    provider: 'fixture', model: 'fixture-model', signal: controller.signal,
    messages: [
      { id: 'window-test', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: SECRET }] },
    ],
  }
  if (spec.sessionId !== null) options.sessionId = spec.sessionId ?? f.agent.session.id
  if (spec.purpose !== null) options.purpose = spec.purpose ?? 'conversation'
  try {
    const prepared = await f.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
    for await (const _chunk of prepared.stream(official.markAgentLoopRequest(options))) { /* drain */ }
  } catch (error) {
    if (spec.abort !== true) throw error
  }
}

async function records(directory) {
  let names = []
  try { names = await readdir(directory) } catch { return [] }
  const rows = []
  for (const name of names.filter(entry => entry.endsWith('.jsonl')).sort()) {
    const text = await readFile(join(directory, name), 'utf8')
    for (const line of text.split('\n')) if (line.trim().length > 0) rows.push(JSON.parse(line))
  }
  return rows
}

test('off, default and directory-less configs install no observer and create no file', async t => {
  const never = join(await tempDir(t, 'wm-off-'), 'never-created')
  for (const config of [{}, { mode: 'off' }, { mode: 'bogus' }, { mode: 'off', directory: never }]) {
    const f = fixture(t, config)
    assert.equal(f.listenerStops.get('llm/stream')?.size ?? 0, 0)
    await send(f, { chunks: usageChunks(60000, 0, 0) })
    await f.stop()
    await assert.rejects(readdir(never), /ENOENT/)
  }
  // Shadow without a destination warns once and behaves as off instead of writing nothing silently.
  const f = fixture(t, { mode: 'shadow' })
  assert.equal(f.listenerStops.get('llm/stream')?.size ?? 0, 0)
  await send(f, { chunks: usageChunks(60000, 0, 0) })
  await f.stop()
  assert.equal(f.warnings.length, 1)
  assert.match(f.warnings[0], /directory/)
})

test('shadow records only transitions of the verdict for a session', async t => {
  const directory = await tempDir(t, 'wm-shadow-')
  const f = fixture(t, { mode: 'shadow', directory })
  assert.equal(f.listenerStops.get('llm/stream')?.size ?? 0, 1)

  // The first request names no purpose at all, as the agent loop's real requests do.
  await send(f, { chunks: usageChunks(60000, 0, 0), purpose: null })
  await send(f, { chunks: usageChunks(6000, 294000, 0) })
  await send(f, { chunks: usageChunks(6000, 294000, 0) })
  await send(f, { chunks: usageChunks(550000, 0, 0) })
  await f.stop()

  const rows = await records(directory)
  assert.deepEqual(rows.map(row => [row.action, row.reason]), [
    ['none', 'below-floor'],
    ['none', 'cache-warm-phase-open'],
    ['fold', 'proactive-size'],
  ])
  assert.deepEqual(rows.map(row => row.version), [1, 1, 1])
  assert.deepEqual(rows.map(row => row.sessionId), ['session-root', 'session-root', 'session-root'])
  assert.equal(rows[0].mechanism, null)
  assert.equal(rows[2].mechanism, 'compaction')
  assert.equal(rows[0].contextTokens, 60000)
  assert.equal(rows[1].contextTokens, 300000)
  assert.ok(Math.abs(rows[1].cacheHitRatio - 0.98) < 1e-9)
  assert.equal(rows[0].milestoneKnown, false)
  assert.equal(rows[0].boundaryKnown, true)
  assert.match(rows[0].settingsHash, /^[a-f0-9]{64}$/)
  assert.ok(rows.every(row => typeof row.at === 'string' && !Number.isNaN(Date.parse(row.at))))
  assert.ok(rows.every(row => typeof row.requestId === 'string' && row.requestId.length > 0))
})

test('non-main requests and non-success terminals produce no record', async t => {
  const directory = await tempDir(t, 'wm-filter-')
  const f = fixture(t, { mode: 'shadow', directory })
  assert.equal(f.listenerStops.get('llm/stream')?.size ?? 0, 1)

  await send(f, { chunks: usageChunks(300000, 0, 0), purpose: 'compaction' })
  await send(f, { chunks: usageChunks(300000, 0, 0), sessionId: null })
  await send(f, { chunks: usageChunks(0, 0, 0) })
  await send(f, { chunks: usageChunks(300000, 0, 0), abort: true })
  await f.stop()
  assert.deepEqual(await records(directory), [])
})

test('idleDecision re-runs the rule on the cached terminal size and its age', async t => {
  const directory = await tempDir(t, 'wm-idle-')
  const f = fixture(t, { mode: 'shadow', directory })
  const startedAt = Date.now()
  await send(f, { chunks: usageChunks(6000, 294000, 0) })
  await f.stop()

  assert.equal(f.stop.idleDecision('session-root', startedAt + 61 * 60 * 1000).reason, 'cache-cold')
  assert.equal(f.stop.idleDecision('session-root', startedAt + 59 * 60 * 1000).reason, 'cache-warm-phase-open')
  assert.equal(f.stop.idleDecision('session-missing', startedAt), null)
})

test('observer faults never reach the request stream', async t => {
  // An unwritable destination must warn once and never break the request that produced the record.
  const parent = await tempDir(t, 'wm-broken-')
  const blocker = join(parent, 'blocker')
  await writeFile(blocker, 'not a directory')
  const broken = fixture(t, { mode: 'shadow', directory: blocker })
  await send(broken, { chunks: usageChunks(300000, 0, 0) })
  await send(broken, { chunks: usageChunks(550000, 0, 0) })
  await broken.stop()
  assert.equal(broken.warnings.length, 1)

  // A malformed config must fail inside the observer, not during apply and not in the request.
  const directory = await tempDir(t, 'wm-malformed-')
  const malformed = fixture(t, { mode: 'shadow', directory, settings: { get minFoldTokens() { throw new Error('boom') } } })
  await send(malformed, { chunks: usageChunks(300000, 0, 0) })
  await malformed.stop()
  assert.equal(malformed.warnings.length, 1)
  assert.deepEqual(await records(directory), [])
})

test('dispose removes the observer and stops further writes', async t => {
  const directory = await tempDir(t, 'wm-dispose-')
  const f = fixture(t, { mode: 'shadow', directory })
  await send(f, { chunks: usageChunks(6000, 294000, 0) })
  await f.stop()
  assert.equal((await records(directory)).length, 1)

  assert.equal(f.listenerStops.get('llm/stream')?.size ?? 0, 0)
  await send(f, { chunks: usageChunks(550000, 0, 0) })
  await f.stop.flush()
  assert.equal((await records(directory)).length, 1)
})

test('records carry no message body', async t => {
  const directory = await tempDir(t, 'wm-body-')
  const f = fixture(t, { mode: 'shadow', directory })
  await send(f, { chunks: usageChunks(300000, 0, 0) })
  await f.stop()
  const rows = await records(directory)
  assert.ok(rows.length >= 1)
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(SECRET))
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'action', 'at', 'boundaryKnown', 'cacheHitRatio', 'contextTokens', 'mechanism',
    'milestoneKnown', 'reason', 'requestId', 'sessionId', 'settingsHash', 'version',
  ])
})

test('a ticked, not yet folded milestone is read from the milestone file; verdicts survive an agent being recreated', async t => {
  const directory = await tempDir(t, 'wm-milestone-'), milestonePath = join(directory, 'milestones.json')
  const write = member => writeFile(milestonePath, JSON.stringify({ version: 3, teams: { 'team-1': { members: { root: member }, bands: {}, compactions: {} } } }))
  await write({ owner: 'root', stage: 'big phase', doneWhen: 'x', setAt: 1, done: false })
  const f = fixture(t, { mode: 'shadow', directory, milestonePath })
  f.ctx.agentTeams = { tryMembership: agent => agent === f.agent ? { id: 'team-1', name: 'root' } : undefined }
  await send(f, { chunks: usageChunks(6000, 294000, 0) })
  // The agent object going away between turns must not reset what was already recorded for the session.
  f.cordis.emit('agent/disposed', { agent: f.agent })
  await send(f, { chunks: usageChunks(6000, 296000, 0) })
  await write({ owner: 'root', stage: 'big phase', doneWhen: 'x', setAt: 1, done: true })
  await send(f, { chunks: usageChunks(6000, 298000, 0) })
  await write({ owner: 'root', stage: 'big phase', doneWhen: 'x', setAt: 1, done: true, compactedAt: 5 })
  await send(f, { chunks: usageChunks(6000, 299000, 0) })
  await f.stop()
  const rows = (await records(directory)).map(row => [row.reason, row.mechanism, row.milestoneKnown])
  assert.deepEqual(rows, [['cache-warm-phase-open', null, true], ['milestone', 'compaction', true], ['cache-warm-phase-open', null, true]])
})
