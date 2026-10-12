import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { Session, SessionStore, KNOWN_SESSION_EVENT_TYPES, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { assertReleasedV4Relationships } from '../app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js'
import { AgentLoop, ReactLoopAgent } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { createJsonlWindowBarrier } from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js'
import { PtcBackground } from '../home/profiles/web/plugins/team-v15-ptc-background.mjs'
import { GoalService } from '../app/node_modules/@deepseek-ai/dsh-goal/lib/index.js'
import { deliveryCheckCoverage } from '../home/profiles/web/plugins/team-v15-delivery-service.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)))
const { Context, Service } = await load('cordis')
const { SessionProjectionRegistry } = await load('dsh-session-projection')
const { SystemPrompt } = await load('dsh-system-prompt')
const { AgentRegistry } = await load('dsh-agent')
const { LlmRuntime, LlmAdapter, createUserMessage } = await load('dsh-llm')
const { NodePtcRuntime } = await load('dsh-ptc-runtime-node')
const { LocalJobRegistry } = await load('dsh-jobs-local')
const { SandboxPolicyService } = await load('dsh-sandbox-policy')
const { LocalSandboxProvider } = await load('dsh-sandbox-local')
const { LocalSubprocessRuntime } = await load('dsh-subprocess-local')
const { LocalFileSystem } = await load('dsh-fs-local')
const bounded = async (label, promise, ms = 10000) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PTC_TEST_TIMEOUT_' + label)), ms) })]) }
  finally { clearTimeout(timer) }
}
const message = (text, source = { kind: 'user', rpcId: text }) => createUserMessage({ source, content: [{ type: 'text', text }] })
const jobEvents = f => f.session.log.filter(event => event.type === 'native/ptc-job')

async function fixture(t, { second = false, team = false, autoCollect = true, program, timeoutMs, restoreRoot, failHold = false, largeResult = false } = {}) {
  const root = restoreRoot ?? mkdtempSync(join(tmpdir(), 'ptc-background-')), ctx = new Context(), storageCtx = new Context()
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), successor = Promise.withResolvers()
  const requests = [], errors = []
  let bodies = 0, secondBodies = 0, runs = 0, agent, barrier, originalJob
  const backend = await initializeNativeHost(storageCtx, async () => new Jsonl(storageCtx, { root: join(root, 'sessions'), compression: 'none' }))
  let session, handle
  if (restoreRoot) {
    handle = await backend.open(basename(root), 'write')
    const snapshot = await handle.read()
    session = Session.fromRestore(basename(root), snapshot.events, handle.header, handle.inheritedEventCount, snapshot.eventState)
  } else {
    session = Session.create(basename(root), undefined, { id: basename(root), version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
    handle = await backend.create(session.header)
  }
  barrier = createJsonlWindowBarrier(handle, session)
  const f = await initializeNativeHost(ctx, async () => {
    const sessions = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new AgentRegistry(ctx)
    new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 10 } })
    ctx.on('session/flush', async target => { assert.equal(target, session); await barrier.persist() })
    sessions.enter(session); sessions.announce(session)
    const tools = new ToolRuntime(ctx, { mode: 'ptc' })
    new SandboxPolicyService(ctx, { mode: 'read-only', workspaceRoot: root })
    new LocalSandboxProvider(ctx, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 })
    new LocalSubprocessRuntime(ctx)
    new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 1048576 })
    const runtime = new NodePtcRuntime(ctx, { timeoutMs: 5000, maxTimeoutMs: 6000, maxOutputBytes: largeResult ? 131072 : 8192,
      maxMessageBytes: largeResult ? 262144 : 8192, maxPendingCalls: 8, maxOldGenerationSizeMb: 128, graceMs: 100 })
    const originalRun = runtime.run.bind(runtime)
    runtime.run = spec => { runs++; return originalRun(spec) }
    const jobs = new LocalJobRegistry(ctx, { maxConcurrentJobsPerOwner: 10, retainBytes: 65536, settledRetainBytes: 65536,
      pumpPollMs: 10, journalDirectory: join(root, 'jobs') })
    jobs.attachController('ptc-test')
    tools.register({ name: 'hold', description: 'Controlled read-only fixture', parameters: { type: 'object' }, concurrency: 'parallel',
      output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute() {
        bodies++; entered.resolve(); await release.promise
        if (failHold) throw new Error('CONTROLLED_CHILD_FAILURE_AFTER_MUTATION')
        return largeResult ? { text: 'y'.repeat(65536) } : { value: 37 }
      } })
    tools.register({ name: 'record', description: 'Controlled fixture mutation inside its private workspace', parameters: { type: 'object' },
      output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute() { writeFileSync(join(root, 'mutation.txt'), 'one committed mutation'); return { mutation: 'committed' } } })
    tools.register({ name: 'second', description: 'Must not start in the superseded generation', parameters: { type: 'object' },
      output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute() { secondBodies++; return { unexpected: true } } })
    new LlmRuntime(ctx).registerAdapter(['fixture'], new class extends LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream: request => (async function* () {
        requests.push(request)
        if (requests.length > 4) throw new Error('PTC_FIXTURE_REQUEST_LIMIT')
        if (restoreRoot && requests.length === 1) {
          originalJob = jobEvents({ session }).find(event => event.data.rootCallId === 'held-program').data.jobId
          yield { type: 'tool-call-delta', index: 0, id: 'cold-collect', name: 'run_code', argumentsDelta: JSON.stringify({
            code: 'return await tools.ptc_job_result({job_id:' + JSON.stringify(originalJob) + '});', description: 'Collect the lost owner receipt without rerunning it' }) }
        } else if (restoreRoot) yield { type: 'text-delta', index: 0, text: 'LOST_OWNER_RECEIPT_HANDLED' }
        else if (requests.length === 1) yield { type: 'tool-call-delta', index: 0, id: 'held-program', name: 'run_code',
          argumentsDelta: JSON.stringify({ code: program ?? (second ? 'await tools.hold({}); return await tools.second({});' : 'return await tools.hold({});'),
            description: 'Original single PTC instance', ...(timeoutMs ? { timeoutMs } : {}) }) }
        else if (requests.length === 2) {
          if (!program) assert.ok(request.messages.some(row => JSON.stringify(row).includes('NEW_DIRECTION')))
          successor.resolve()
          yield { type: 'text-delta', index: 0, text: 'NEW_DIRECTION_HANDLED' }
        } else if (requests.length === 3 && autoCollect) {
          originalJob = jobEvents({ session }).find(event => event.data.rootCallId === 'held-program').data.jobId
          yield { type: 'tool-call-delta', index: 0, id: 'collect-program', name: 'run_code', argumentsDelta: JSON.stringify({
            code: 'return await tools.ptc_job_result({job_id:' + JSON.stringify(originalJob) + '});', description: 'Collect the existing program receipt' }) }
        } else yield { type: 'text-delta', index: 0, text: 'PTC_RECEIPT_HANDLED' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() } }
    }())
    agent = new ReactLoopAgent(ctx, session.id, { provider: 'fixture', model: 'fixture' }, session)
    ctx.agents.enter(agent, { dispose: async () => {} })
    ctx.on('agent/error', event => { errors.push((event.error?.stack ?? String(event.error)).split('\n').slice(0, 8).join('\n')) })
    if (team) new class extends Service {
      constructor() { super(ctx, 'agentTeams') }
      tryMembership(target) { return target === agent ? { root: agent, tier: 0, name: 'lead' } : undefined }
      listMembers() { return [{ id: 'peer', name: 'peer' }, { id: agent.id, name: 'lead' }] }
    }()
    const bridge = installNativeSessionBridge(session, { isolated: true, sessionId: session.id,
      flush: async () => (await barrier.persist()).durable === true })
    const background = new PtcBackground(ctx, { sessionIds: [session.id], resultDirectory: join(root, 'results'), allowOrdinary: !team, teamInstant: team })
    await background.install(agent)
    return { root, ctx, session, agent, tools, runtime, jobs, bridge, background, handle, backend, barrier,
      entered, release, successor, requests, errors, bodies: () => bodies, secondBodies: () => secondBodies, runs: () => runs }
  })
  t.after(async () => {
    if (t.passed === false) console.error('PTC_DEBUG=' + JSON.stringify({ root, errors, requests: requests.length, runs, bodies,
      effects: session.log.filter(event => event.type === 'native/tool-effect').map(event => ({ callId: event.data.callId, outcome: event.data.effectOutcome, result: event.data.result?.error, error: event.data.error })),
      jobs: jobEvents({ session }).map(event => ({ action: event.data.action, status: event.data.status })) }))
    release.resolve()
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await bounded('cleanup-idle', agent.whenIdle())
    await ctx.fiber.dispose()
    await barrier.persist()
    await handle.close()
    await storageCtx.fiber.dispose()
  })
  return f
}

for (const team of [false, true]) test('Instant handles ' + (team ? 'authorized Team' : 'user') + ' input before the same running PTC instance settles; late result survives a closed turn', async t => {
  const f = await fixture(t, { team })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  assert.equal(f.runs(), 1)
  await f.agent.steer(message('NEW_DIRECTION', team ? { kind: 'team-message', teamId: f.agent.id, messageId: 'peer-message', senderId: 'peer' } : undefined))
  await bounded('successor-before-release', f.successor.promise)
  await bounded('foreground-idle', f.agent.whenIdle())
  assert.equal(f.bodies(), 1)
  assert.equal(f.runs(), 1, 'detaching must not invoke runtime.run a second time')
  assert.equal(f.jobs.list(f.agent.id)[0].status, 'running')
  assert.equal(f.bridge.generation, 1)
  assert.throws(() => f.bridge.acquireWriter(f.bridge.surfaceRevision), { code: 'NATIVE_WRITER_CAS_CONFLICT' })
  await f.barrier.persist()
  await f.handle.read()
  f.release.resolve()
  await bounded('job', f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id))
  await bounded('notification-and-collection', f.agent.whenIdle())
  assert.deepEqual(f.errors, [])
  const events = jobEvents(f).filter(event => event.data.rootCallId === 'held-program')
  assert.deepEqual(events.map(event => event.data.action), ['started', 'detached', 'settled', 'notified', 'consumed'])
  assert.equal(events.at(-1).data.status, 'succeeded')
  const value = JSON.parse(readFileSync(events.at(-1).data.resultRef.path))
  assert.deepEqual(value.value.result, { value: 37 })
  assert.equal(f.bodies(), 1)
  assert.equal(f.runs(), 2, 'only the later distinct receipt-collection program may add an instance')
  const data = await f.handle.read()
  assert.ok(data.events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'hold'))
  assert.equal(f.requests.length, 4)
})

test('superseded PTC cannot start a later child tool; its already-started result is still recorded and failure is collected', async t => {
  const f = await fixture(t, { second: true })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  f.release.resolve()
  await bounded('job', f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id))
  await f.agent.whenIdle()
  assert.deepEqual(f.errors, [])
  assert.equal(f.secondBodies(), 0)
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.status, 'failed')
  assert.equal(row.action, 'consumed')
  assert.ok(f.session.log.some(event => event.type === 'native/tool-effect' && event.data.callId === 'held-program:ptc:1' && event.data.effectOutcome === 'succeeded'))
  await f.handle.read()
})

test('pending detached result blocks legacy Goal and Team delivery, then canonical collection clears the debt', async t => {
  const f = await fixture(t)
  const goals = await initializeNativeHost(f.ctx, () => new GoalService(f.ctx))
  const goal = goals.create(f.agent, { objective: 'Collect the original program result' }), ref = { id: goal.id, revision: goal.revision }
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  assert.throws(() => goals.complete(f.agent, ref), { code: 'GOAL_BACKGROUND_PENDING' })
  const coverage = deliveryCheckCoverage(f.ctx, f.agent, {})
  assert.equal(coverage.required, true)
  assert.equal(coverage.deliverable, false)
  assert.equal(coverage.code, 'DELIVERY_BACKGROUND_PENDING')
  f.release.resolve()
  await f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id)
  await f.agent.whenIdle()
  assert.deepEqual(f.errors, [])
  assert.equal(deliveryCheckCoverage(f.ctx, f.agent, {}).deliverable, true)
  assert.equal(goals.complete(f.agent, ref).phase, 'complete')
})

test('wrong Team binding cannot preempt, and a modified result file is not collected or acknowledged', async t => {
  const f = await fixture(t, { team: true, autoCollect: false })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('FORGED_TEAM_SOURCE', { kind: 'team-message', teamId: 'another-root', messageId: 'bad', senderId: 'peer' }))
  assert.equal(f.bridge.generation, 0)
  await f.agent.steer(message('NEW_DIRECTION', { kind: 'team-wake', plugin: 'team-tools-v2-r10', form: 'action' }))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  assert.equal(f.bridge.generation, 1)
  f.release.resolve()
  await f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id)
  await f.agent.whenIdle()
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.action, 'notified')
  writeFileSync(row.resultRef.path, '{}')
  await assert.rejects(f.background.collect(row.jobId, { agent: f.agent, deferContext() {} }), { code: 'PTC_RESULT_READBACK_MISMATCH' })
  assert.equal(jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data.action, 'notified')
})

test('explicit job kill cancels the original instance and still preserves the already-started child effect', async t => {
  const f = await fixture(t)
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  const job = f.jobs.list(f.agent.id)[0]
  assert.equal(f.jobs.kill(job.id, f.agent.id, 'explicit-test-kill'), 'requested')
  f.release.resolve()
  await bounded('cancelled-job', f.jobs.wait(job.id, 8000, f.agent.id))
  await f.agent.whenIdle()
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.status, 'cancelled')
  assert.equal(row.action, 'consumed')
  assert.equal(f.bodies(), 1)
  assert.equal(f.runs(), 2)
  assert.ok(f.session.log.some(event => event.type === 'native/tool-effect' && event.data.callId === 'held-program:ptc:1' && event.data.effectOutcome === 'succeeded'))
  await f.handle.read()
})

for (const mode of ['timeout', 'output-limit']) test('structured ' + mode + ' is not misreported as cancellation or success', async t => {
  const f = await fixture(t, { program: mode === 'timeout' ? 'await new Promise(() => {});' : 'console.log("x".repeat(32768));', timeoutMs: mode === 'timeout' ? 200 : 5000 })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('program-idle', f.agent.whenIdle())
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.status, mode === 'timeout' ? 'timed-out' : 'failed')
  assert.equal(row.action, 'consumed')
  const value = JSON.parse(readFileSync(row.resultRef.path))
  assert.match(value.error.message, mode === 'timeout' ? /timeout/ : /output-limit/)
  assert.equal(f.runs(), 2, 'one original program and its later receipt collector')
  await f.handle.read()
})

for (const afterAcceptance of [false, true]) test('notification recovery is idempotent when failure occurs ' + (afterAcceptance ? 'after durable acceptance' : 'before acceptance'), async t => {
  const f = await fixture(t, { autoCollect: false })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  const steer = f.agent.steer.bind(f.agent)
  let failOnce = true
  f.agent.steer = async msg => {
    if (msg.source.kind !== 'ptc-background' || !failOnce) return steer(msg)
    failOnce = false
    if (afterAcceptance) await steer(msg)
    throw new Error('FIXTURE_NOTIFICATION_CHANNEL_LOST')
  }
  f.release.resolve()
  await f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id)
  await f.agent.whenIdle()
  await Promise.all([f.background.recover(f.agent), f.background.recover(f.agent)])
  await f.agent.whenIdle()
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.action, 'notified')
  assert.equal(f.session.log.filter(event => event.type === 'native/input-accepted' && event.data.inputId === row.notificationInputId).length, 1)
  assert.equal(jobEvents(f).filter(event => event.data.rootCallId === 'held-program' && event.data.action === 'notified').length, 1)
  assert.equal(f.runs(), 1)
  assert.deepEqual(f.errors, [])
  await f.handle.read()
})

test('duplicate consumption is monotonic; cold replay rejects forged collection, notification and detach receipts', async t => {
  const f = await fixture(t)
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  f.release.resolve()
  await f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id)
  await f.agent.whenIdle()
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  const before = jobEvents(f).length
  await Promise.all([f.background.mark(f.agent, row), f.background.mark(f.agent, row)])
  assert.equal(jobEvents(f).length, before)
  const events = structuredClone((await f.handle.read()).events)
  const validate = seed => assertReleasedV4Relationships({ header: f.session.header, events: seed, inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
  validate(events)
  for (const [action, key, value, expected] of [
    ['consumed', 'collectionCallId', 'not-an-effect', /matching successful tool receipt/],
    ['notified', 'notificationInputId', 'not-an-input', /durable input receipt/],
    ['detached', 'triggerSeq', 0, /exact durable preempt input/],
    ['settled', 'jobId', 'different-job', /origin binding/],
  ]) {
    const forged = structuredClone(events)
    forged.find(event => event.type === 'native/ptc-job' && event.data.rootCallId === 'held-program' && event.data.action === action).data[key] = value
    assert.throws(() => validate(forged), expected)
  }
})

test('owner teardown cancels and drains one program; another caller cannot kill or collect it', async t => {
  const f = await fixture(t, { autoCollect: false })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  const job = f.jobs.list(f.agent.id)[0]
  assert.throws(() => f.jobs.kill(job.id, 'another-owner', 'not-authorized'))
  await assert.rejects(f.background.collect(job.id, { agent: { id: 'another-owner', session: { id: 'another-owner' } } }), { code: 'PTC_BACKGROUND_ACTOR_DENIED' })
  const disposing = f.jobs.disposeSession(f.agent.id, 'controlled owner teardown')
  assert.equal(f.jobs.list(f.agent.id)[0].status, 'stopping')
  f.release.resolve()
  await bounded('owner-disposed', disposing)
  await f.agent.whenIdle()
  assert.equal(f.jobs.list(f.agent.id).length, 0)
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.status, 'cancelled')
  assert.equal(row.action, 'notified')
  assert.equal(f.runs(), 1)
  await f.handle.read()
})

test('partial mutation and a failed later child keep separate canonical effect references', async t => {
  const f = await fixture(t, { program: 'await tools.record({}); return await tools.hold({});', failHold: true })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  assert.equal(readFileSync(join(f.root, 'mutation.txt'), 'utf8'), 'one committed mutation')
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  f.release.resolve()
  await f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id)
  await f.agent.whenIdle()
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.status, 'failed')
  assert.equal(row.action, 'consumed')
  const artifact = JSON.parse(readFileSync(row.resultRef.path))
  assert.deepEqual(artifact.effects.map(effect => effect.effectOutcome), ['succeeded', 'unknown'])
  assert.equal(f.session.log[artifact.effects[0].seq].data.callId, 'held-program:ptc:1')
  assert.equal(readFileSync(join(f.root, 'mutation.txt'), 'utf8'), 'one committed mutation')
  assert.equal(f.runs(), 2)
  await f.handle.read()
})

test('large output remains intact in its durable artifact while collection returns a small verified receipt', async t => {
  const f = await fixture(t, { largeResult: true })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  f.release.resolve()
  await f.jobs.wait(f.jobs.list(f.agent.id)[0].id, 8000, f.agent.id)
  await f.agent.whenIdle()
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.status, 'succeeded')
  assert.equal(row.action, 'consumed')
  assert.equal(JSON.parse(readFileSync(row.resultRef.path)).value.result.text.length, 65536)
  const effect = f.session.log.find(event => event.type === 'native/tool-effect' && event.data.callId === 'collect-program:ptc:1')
  assert.equal(effect.data.result.value.artifactOnly, true)
  assert.ok(Buffer.byteLength(JSON.stringify(effect.data.result.value)) < 4096)
  assert.deepEqual(f.errors, [])
  assert.equal(f.runs(), 2)
  await f.handle.read()
})

if (process.env.PTC_CRASH_READY) test('crash-child', async t => {
  const f = await fixture(t, { autoCollect: false })
  await f.agent.followup(message('START_ORIGINAL'))
  await bounded('entered', f.entered.promise)
  await f.agent.steer(message('NEW_DIRECTION'))
  await bounded('successor', f.successor.promise)
  await f.agent.whenIdle()
  await f.barrier.persist()
  if (process.env.PTC_CRASH_AFTER_RESULT === '1') {
    const mark = f.background.mark.bind(f.background)
    f.background.mark = async (agent, row) => {
      if (row.rootCallId === 'held-program' && row.action === 'settled') {
        writeFileSync(process.env.PTC_CRASH_READY, JSON.stringify({ root: f.root, originalRuns: f.runs(), originalBodies: f.bodies(), uncommittedResult: row.resultRef }))
        await new Promise(resolve => setInterval(resolve, 60000))
      }
      return mark(agent, row)
    }
    f.release.resolve()
    await new Promise(resolve => setInterval(resolve, 60000))
    return
  }
  writeFileSync(process.env.PTC_CRASH_READY, JSON.stringify({ root: f.root, originalRuns: f.runs(), originalBodies: f.bodies() }))
  await new Promise(resolve => setInterval(resolve, 60000))
})

for (const afterResult of [false, true]) test('real process death ' + (afterResult ? 'after artifact fsync but before terminal receipt' : 'during a started tool') + ' recovers unknown effects without restarting the original program', async t => {
  const ready = join(mkdtempSync(join(tmpdir(), 'ptc-crash-coordinator-')), 'ready.json')
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--import', new URL('../tools/prepare-unified-lab-host.mjs', import.meta.url).href,
    '--test', '--test-isolation=none', '--test-name-pattern=^crash-child$', new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
    env: { ...process.env, PTC_CRASH_READY: ready, PTC_CRASH_AFTER_RESULT: afterResult ? '1' : '0', NODE_TEST_CONTEXT: '' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostic = ''
  child.stdout.on('data', value => { diagnostic = (diagnostic + value).slice(-5000) })
  child.stderr.on('data', value => { diagnostic = (diagnostic + value).slice(-5000) })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed })
  await bounded('crash-ready', (async () => {
    while (!existsSync(ready)) { if (child.exitCode !== null) throw new Error('CRASH_CHILD_EXIT:' + diagnostic); await delay(20) }
  })())
  const evidence = JSON.parse(readFileSync(ready))
  assert.equal(evidence.originalRuns, 1)
  assert.equal(evidence.originalBodies, 1)
  child.kill()
  await bounded('child-exit', closed)
  const f = await fixture(t, { restoreRoot: evidence.root })
  await bounded('cold-result', f.agent.whenIdle())
  const row = jobEvents(f).filter(event => event.data.rootCallId === 'held-program').at(-1).data
  assert.equal(row.status, 'unknown')
  assert.equal(row.action, 'consumed')
  assert.equal(JSON.parse(readFileSync(row.resultRef.path)).code, 'PTC_OWNER_PROCESS_LOST')
  if (afterResult) {
    assert.notEqual(row.resultRef.path, evidence.uncommittedResult.path)
    assert.deepEqual(JSON.parse(readFileSync(evidence.uncommittedResult.path)).value.result, { value: 37 }, 'preserve the uncommitted artifact as evidence, not as delivery authority')
  }
  assert.equal(f.bodies(), 0)
  assert.equal(f.runs(), 1, 'the only new runtime is the distinct receipt collector')
  assert.deepEqual(f.errors, [])
  await f.handle.read()
})
