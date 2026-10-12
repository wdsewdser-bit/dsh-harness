import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync, watch } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHostLifecycleGate } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeSessionBridge } from '@deepseek-ai/dsh-session'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
import { PtcBackground } from '../home/profiles/web/plugins/team-v15-ptc-background.mjs'

const stage = fileURLToPath(new URL('../', import.meta.url))
const ui = process.argv.includes('--ui')
const directory = resolve(stage, 'lab-runs/ptc-background-' + randomUUID())
assert.ok(directory.startsWith(resolve(stage, 'lab-runs') + sep))
assert.equal(process.env.DSH_LAB_CANONICAL_MODULES, '1')
assert.equal(resolve(process.env.DSH_HOME), resolve(stage, 'lab-host-home'))
const sourcePaths = ['tools/ptc-background-lab.mjs', 'home/profiles/web/plugins/team-v15-ptc-background.mjs',
  ...['dsh-session/lib/index.js', 'dsh-session/lib/native-bridge.js', 'dsh-tools/lib/index.js', 'dsh-tools/lib/types/ptc.js',
    'dsh-session-format-v3-to-v4/lib/index.js', 'dsh-session-persistence-jsonl/lib/index.js', 'dsh-goal/lib/index.js',
    'dsh-client-ui-chat/lib/client.js'].map(path => 'app/node_modules/@deepseek-ai/' + path)]
const sourceBinding = {}
for (const path of sourcePaths) {
  const physical = await realpath(resolve(stage, path))
  assert.ok(physical.toLowerCase().startsWith(resolve(stage).toLowerCase() + sep))
  sourceBinding[path] = createHash('sha256').update(await readFile(physical)).digest('hex')
}
const sourceHash = createHash('sha256').update(JSON.stringify(sourceBinding)).digest('hex')
const bounded = async (label, promise, ms = 15000) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PTC_LAB_TIMEOUT_' + label)), ms) })]) }
  finally { clearTimeout(timer) }
}
const marker = async (name, ms = 180000) => {
  let observer
  const path = resolve(directory, name)
  try { await bounded(name, new Promise((accept, reject) => {
    const check = () => { if (existsSync(path)) accept() }
    observer = watch(directory, check); observer.on('error', reject); check()
  }), ms) } finally { observer?.close() }
}
const input = text => createUserMessage({ source: { kind: 'user', rpcId: text }, content: [{ type: 'text', text }] })
let ctx, agent, barrier, entered = Promise.withResolvers(), successor = Promise.withResolvers(), collected = Promise.withResolvers()
let originalBodies = 0, originalRuns = 0, totalRuns = 0, requests = 0, externalRequests = 0
const agentErrors = [], observations = []
const backgroundRows = () => agent.session.log.filter(event => event.type === 'native/ptc-job' && event.data.rootCallId === 'original-program')
try {
  await mkdir(directory, { recursive: true })
  const overlay = resolve(directory, 'storage-overlay.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'session-persistence-jsonl', config: { root: resolve(directory, 'sessions') } },
    { id: 'session-query-sqlite', config: { path: resolve(directory, 'query.sqlite'), openAt: 'startup' } },
    { id: 'ptc-runtime', config: { timeoutMs: 180000, maxTimeoutMs: 180000 } },
    { id: 'jobs', config: { journalDirectory: resolve(directory, 'jobs') } },
    ...['context-workspace', 'agent-team', 'tool-agent-team-v2', 'team-v12-runtime', 'team-v14-event-continuation', 'team-policy', 'team-health',
      'team-idle-watch', 'team-runtime-guard', 'team-operator', 'write-scope-guard', 'step-compaction', 'failure-memory'].map(id => ({ id, disabled: true })),
  ]))
  const host = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
    profile: 'web', patchFiles: [overlay], args: ['--no-open', '--port', '40124'] })
  ctx = host.ctx
  await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(async () => {
    assert.equal(ctx.get('agentTeams'), undefined)
    ctx.on('llm/stream', (options, next) => {
      if (options.provider !== 'ptc-background-fixture') { externalRequests++; throw new Error('EXTERNAL_PROVIDER_REFUSED') }
      return next()
    }, { global: true })
    ctx.on('agent/error', event => { agentErrors.push(String(event.error?.stack ?? event.error)) }, { global: true })
    ctx.llm.registerAdapter(['ptc-background-fixture'], new class extends LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }] }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream: request => (async function* () {
        if (++requests > 4) throw new Error('PTC_LAB_REQUEST_BUDGET_EXCEEDED')
        observations.push({ request: requests, at: Date.now(), originalBodies, originalRuns, totalRuns })
        if (requests === 1) {
          yield { type: 'tool-call-delta', index: 0, id: 'original-program', name: 'run_code', argumentsDelta: JSON.stringify({
            code: 'return await tools.ptc_lab_hold({});', description: 'Original PTC instance waiting for fixture release', timeoutMs: 180000 }) }
        } else if (requests === 2) {
          assert.ok(request.messages.some(message => JSON.stringify(message).includes('NEW_DIRECTION')))
          assert.equal(existsSync(resolve(directory, 'release.txt')), false)
          assert.equal(originalBodies, 1)
          assert.equal(originalRuns, 1)
          successor.resolve()
          yield { type: 'text-delta', index: 0, text: 'NEW_DIRECTION_HANDLED; original PTC instance remains running.' }
        } else if (requests === 3) {
          const jobId = backgroundRows()[0].data.jobId
          assert.ok(request.messages.some(message => JSON.stringify(message).includes('ptc-completion')))
          yield { type: 'tool-call-delta', index: 0, id: 'collect-original', name: 'run_code', argumentsDelta: JSON.stringify({
            code: 'return await tools.ptc_job_result({job_id:' + JSON.stringify(jobId) + '});', description: 'Collect the original PTC result receipt' }) }
        } else {
          collected.resolve()
          yield { type: 'text-delta', index: 0, text: 'ORIGINAL_PTC_RESULT_COLLECTED; verified value 37; no rerun.' }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() } }
    }())
    ctx.tools.register({ name: 'ptc_lab_hold', description: 'Read-only controlled fixture result', parameters: { type: 'object' }, concurrency: 'parallel',
      output: { schema: {}, render: (_, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute() { originalBodies++; entered.resolve(); await marker('release.txt'); return { value: 37 } } })
    const runtimeRun = ctx.ptcRuntime.run.bind(ctx.ptcRuntime)
    ctx.ptcRuntime.run = spec => { totalRuns++; if (spec.program === 'return await tools.ptc_lab_hold({});') originalRuns++; return runtimeRun(spec) }
    const composition = await ctx.sessionController.agents.composeAgent('ptc')
    agent = (await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'ptc-background-fixture', model: 'fixture', maxTokens: 64 },
      meta: { cwd: directory, agentPreset: composition.agentPreset }, setup: composition.setup })).agent
    assert.equal(nativeSessionBridge(agent.session), undefined, 'lab must exercise automatic installation, not install a fixture bridge')
    const background = new PtcBackground(ctx, { sessionIds: [agent.session.id], resultDirectory: resolve(directory, 'results'), allowOrdinary: true })
    await Promise.all([background.install(agent), background.install(agent)])
    barrier = await ctx.sessionPersistence.windowBarrierFor(agent.session, { isolated: true, sessionId: agent.session.id })
    assert.equal(typeof nativeSessionBridge(agent.session).requireDurable, 'function')
  }))
  await ctx.sessionController.selectModel({ sessionId: agent.session.id, provider: 'ptc-background-fixture', model: 'fixture' })
  await agent.followup(input('START_ORIGINAL'))
  await bounded('original-entered', entered.promise)
  await barrier.persist()
  const ready = { directory, sessionId: agent.session.id, originalBodies, originalRuns, requests, externalRequests }
  await writeFile(resolve(directory, 'ready.json'), JSON.stringify(ready, null, 2))
  console.log('PTC_UI_RUNNING=' + JSON.stringify(ready))
  if (!ui) await agent.steer(input('NEW_DIRECTION'))
  await bounded('new-direction-before-release', successor.promise, ui ? 180000 : 15000)
  await bounded('new-direction-idle', agent.whenIdle())
  assert.equal(backgroundRows().at(-1).data.action, 'detached')
  assert.equal(ctx.jobs.list(agent.id).filter(job => job.status === 'running').length, 1)
  console.log('PTC_UI_DETACHED=' + JSON.stringify({ directory, sessionId: agent.session.id, originalRuns, originalBodies }))
  if (ui) await marker('release.txt')
  else await writeFile(resolve(directory, 'release.txt'), 'bounded fixture release\n')
  await bounded('collected', collected.promise)
  await bounded('collection-idle', agent.whenIdle())
  assert.deepEqual(agentErrors, [])
  assert.equal(requests, 4)
  assert.equal(externalRequests, 0)
  assert.equal(originalBodies, 1)
  assert.equal(originalRuns, 1)
  assert.equal(totalRuns, 2)
  const terminal = backgroundRows().at(-1).data
  assert.equal(terminal.status, 'succeeded')
  assert.equal(terminal.action, 'consumed')
  const resultBytes = await readFile(terminal.resultRef.path)
  assert.equal(createHash('sha256').update(resultBytes).digest('hex'), terminal.resultRef.sha256)
  assert.deepEqual(JSON.parse(resultBytes).value.result, { value: 37 })
  await barrier.persist()
  const cold = await ctx.sessionPersistence.open(agent.session.id, 'read')
  let replay
  try { replay = (await cold.read()).events } finally { await cold.close() }
  assert.deepEqual(replay.filter(row => row.type === 'native/ptc-job'), agent.session.log.filter(row => row.type === 'native/ptc-job'))
  const evidence = { scope: 'actual-Web-host-official-PTC-fixture-adapter-not-real-provider', directory, sessionId: agent.session.id,
    sourceHash, sourceBinding, configHash: createHash('sha256').update(await readFile(overlay)).digest('hex'),
    requests, externalRequests, agentErrors, originalBodies, originalRuns, totalRuns, observations,
    pendingInput: agent.inbox.hasPending, lifecycle: backgroundRows().map(row => ({ seq: row.seq, ...row.data })),
    coldEventCount: replay.length, terminalResult: JSON.parse(resultBytes), verified: true }
  for (const [path, expected] of Object.entries(sourceBinding)) assert.equal(createHash('sha256').update(await readFile(resolve(stage, path))).digest('hex'), expected, 'source changed during live acceptance: ' + path)
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('PTC_UI_COLLECTED=' + JSON.stringify({ directory, sessionId: agent.session.id, originalRuns, originalBodies, totalRuns, requests, externalRequests }))
  if (ui) await marker('browser-closed.txt')
} catch (error) {
  console.error('PTC_LAB_ERROR=' + JSON.stringify({ code: error.code, message: error.message, stack: error.stack?.split('\n').slice(0, 8), requests, externalRequests }))
  throw error
} finally {
  if (ctx) {
    await writeFile(resolve(directory, 'release.txt'), 'cleanup release\n')
    if (agent) { agent.cancel({ kind: 'user' }, { keepInbox: true }); await bounded('dispose-idle', agent.whenIdle()) }
    await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(() => ctx.fiber.dispose()))
    console.log('PTC_HOST_DISPOSED=true')
  }
}
