import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getHostLifecycleGate } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { nativeSessionBridge } from '@deepseek-ai/dsh-session'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { runProfile } from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
import { PtcBackground } from '../home/profiles/web/plugins/team-v15-ptc-background.mjs'

const stage = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(stage, 'lab-runs/ptc-background-team-' + randomUUID())
assert.ok(directory.startsWith(resolve(stage, 'lab-runs') + sep))
assert.equal(process.env.DSH_LAB_CANONICAL_MODULES, '1')
assert.equal(resolve(process.env.DSH_HOME), resolve(stage, 'lab-host-home'))
const bounded = async (label, promise, ms = 15000) => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PTC_TEAM_LAB_TIMEOUT_' + label)), ms) })]) }
  finally { clearTimeout(timer) }
}
const hash = value => createHash('sha256').update(value).digest('hex')
const binding = {}
for (const path of ['tools/ptc-background-team-lab.mjs', 'home/profiles/web/plugins/team-v15-ptc-background.mjs',
  ...['dsh-session/lib/index.js', 'dsh-session/lib/native-bridge.js', 'dsh-tools/lib/index.js', 'dsh-tools/lib/types/ptc.js',
    'dsh-session-format-v3-to-v4/lib/index.js', 'dsh-session-persistence-jsonl/lib/index.js', 'dsh-experimental-agent-team/lib/index.js']
    .map(path => 'app/node_modules/@deepseek-ai/' + path)]) binding[path] = hash(await readFile(resolve(stage, path)))
let ctx, root, child, barrier, rootRequests = 0, childRequests = 0, externalRequests = 0, originalRuns = 0, originalBodies = 0, collectorSent = false
const entered = Promise.withResolvers(), release = Promise.withResolvers(), successor = Promise.withResolvers(), collected = Promise.withResolvers(), peerDone = Promise.withResolvers()
const agentErrors = []
const jobs = () => root.session.log.filter(row => row.type === 'native/ptc-job' && row.data.rootCallId === 'original-program')
try {
  await mkdir(directory, { recursive: true })
  const overlay = resolve(directory, 'storage-overlay.json')
  await writeFile(overlay, JSON.stringify([
    { id: 'session-persistence-jsonl', config: { root: resolve(directory, 'sessions') } },
    { id: 'session-query-sqlite', config: { path: resolve(directory, 'query.sqlite'), openAt: 'startup' } },
    { id: 'agent-team', disabled: false },
    { id: 'jobs', config: { journalDirectory: resolve(directory, 'jobs') } },
    ...['context-workspace', 'tool-agent-team-v2', 'team-v12-runtime', 'team-v14-event-continuation', 'team-policy', 'team-health',
      'team-idle-watch', 'team-runtime-guard', 'team-operator', 'write-scope-guard', 'step-compaction', 'failure-memory'].map(id => ({ id, disabled: true })),
  ]))
  const host = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
    profile: 'web', patchFiles: [overlay], args: ['--no-open', '--port', '40124'] })
  ctx = host.ctx
  await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(async () => {
    assert.ok(ctx.get('agentTeams'))
    ctx.on('llm/stream', (options, next) => {
      if (options.provider !== 'ptc-team-fixture') { externalRequests++; throw new Error('EXTERNAL_PROVIDER_REFUSED') }
      return next()
    }, { global: true })
    ctx.on('agent/error', event => { agentErrors.push(String(event.error?.stack ?? event.error)) }, { global: true })
    ctx.llm.registerAdapter(['ptc-team-fixture'], new class extends LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider } }
      listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }] }
      async prepareCall(provider, model) { return { model: { provider, id: model, name: model }, stream: request => (async function* () {
        const peer = request.messages.some(row => JSON.stringify(row).includes('PEER_SEND_NEW_DIRECTION'))
        const index = peer ? ++childRequests : ++rootRequests
        if (rootRequests > 6 || childRequests > 2) throw new Error('PTC_TEAM_REQUEST_BUDGET_EXCEEDED')
        if (peer) {
          if (index === 1) yield { type: 'tool-call-delta', index: 0, id: 'peer-send', name: 'run_code', argumentsDelta: JSON.stringify({
            code: 'return await tools.ptc_lab_send({});', description: 'Send one real Team mailbox message' }) }
          else { peerDone.resolve(); yield { type: 'text-delta', index: 0, text: 'PEER_MESSAGE_SENT' } }
        } else if (index === 1) yield { type: 'tool-call-delta', index: 0, id: 'original-program', name: 'run_code', argumentsDelta: JSON.stringify({
          code: 'return await tools.ptc_lab_hold({});', description: 'Original PTC program instance' }) }
        else if (index === 2) {
          assert.ok(request.messages.some(row => JSON.stringify(row).includes('NEW_DIRECTION')))
          assert.equal(originalRuns, 1)
          assert.equal(originalBodies, 1)
          successor.resolve()
          yield { type: 'text-delta', index: 0, text: 'REAL_TEAM_NEW_DIRECTION_HANDLED' }
        } else if (!collectorSent && request.messages.some(row => JSON.stringify(row).includes('ptc-completion'))) {
          collectorSent = true
          yield { type: 'tool-call-delta', index: 0, id: 'collect-original', name: 'run_code', argumentsDelta: JSON.stringify({
            code: 'return await tools.ptc_job_result({job_id:' + JSON.stringify(jobs()[0].data.jobId) + '});', description: 'Collect the original Team-root PTC result' }) }
        } else if (collectorSent) { collected.resolve(); yield { type: 'text-delta', index: 0, text: 'REAL_TEAM_ORIGINAL_RESULT_COLLECTED' } }
        else yield { type: 'text-delta', index: 0, text: 'PEER_STATUS_RECEIVED; original program remains running.' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() } }
    }())
    ctx.tools.register({ name: 'ptc_lab_hold', description: 'Controlled read-only fixture', parameters: { type: 'object' }, concurrency: 'parallel',
      output: { schema: {}, render: (_, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute() { originalBodies++; entered.resolve(); await release.promise; return { value: 37 } } })
    ctx.tools.register({ name: 'ptc_lab_send', description: 'One canonical Team mailbox send inside the isolated fixture', parameters: { type: 'object' },
      output: { schema: {}, render: (_, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      execute: (_, exec) => ctx.agentTeams.sendMessage(exec.agent, { target: 'lead', content: [{ type: 'text', text: 'NEW_DIRECTION' }], signal: exec.signal }) })
    const runtimeRun = ctx.ptcRuntime.run.bind(ctx.ptcRuntime)
    ctx.ptcRuntime.run = spec => { if (spec.program === 'return await tools.ptc_lab_hold({});') originalRuns++; return runtimeRun(spec) }
    const composition = await ctx.sessionController.agents.composeAgent('ptc')
    root = (await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'ptc-team-fixture', model: 'fixture', maxTokens: 64 },
      meta: { cwd: directory, agentPreset: composition.agentPreset }, setup: composition.setup })).agent
    assert.equal(nativeSessionBridge(root.session), undefined)
    const background = new PtcBackground(ctx, { sessionIds: [root.session.id], resultDirectory: resolve(directory, 'results'), teamInstant: true })
    await background.install(root)
    barrier = await ctx.sessionPersistence.windowBarrierFor(root.session, { isolated: true, sessionId: root.session.id })
  }))
  await ctx.sessionController.selectModel({ sessionId: root.session.id, provider: 'ptc-team-fixture', model: 'fixture' })
  await root.followup(createUserMessage({ source: { kind: 'user', rpcId: 'start-original' }, content: [{ type: 'text', text: 'START_ORIGINAL' }] }))
  await bounded('original-entered', entered.promise)
  const roster = await ctx.agentTeams.spawnTeammate(root, { name: 'peer', description: 'One isolated mailbox sender',
    prompt: [{ type: 'text', text: 'PEER_SEND_NEW_DIRECTION' }], context: 'fresh', provider: 'spawn', signal: new AbortController().signal })
  child = ctx.agents.get(roster.member.id)
  assert.ok(child)
  await bounded('real-team-successor', successor.promise)
  await bounded('peer-complete', peerDone.promise)
  await bounded('peer-idle', child.whenIdle())
  await bounded('root-idle-before-release', root.whenIdle())
  assert.equal(jobs().at(-1).data.action, 'detached')
  const received = root.session.log.find(row => row.type === 'user/message' && row.data.source?.kind === 'team-message')
  assert.equal(received.data.source.senderId, child.id)
  assert.equal(received.data.source.teamId, root.id)
  assert.equal(originalRuns, 1)
  release.resolve()
  await bounded('collected', collected.promise)
  await bounded('root-idle-after-collection', root.whenIdle())
  assert.equal(jobs().at(-1).data.action, 'consumed')
  assert.equal(jobs().at(-1).data.status, 'succeeded')
  assert.equal(originalRuns, 1)
  assert.equal(originalBodies, 1)
  assert.ok(rootRequests >= 4 && rootRequests <= 6, 'only canonical input and completion events may create extra root turns')
  assert.equal(childRequests, 2)
  assert.equal(externalRequests, 0)
  assert.deepEqual(agentErrors, [])
  await barrier.persist()
  const reader = await ctx.sessionPersistence.open(root.session.id, 'read')
  let cold
  try { cold = (await reader.read()).events } finally { await reader.close() }
  assert.ok(cold.some(row => row.type === 'team/message/delivered' && row.data.messageId === received.data.source.messageId))
  for (const [path, expected] of Object.entries(binding)) assert.equal(hash(await readFile(resolve(stage, path))), expected)
  const evidence = { scope: 'actual-Team-host-official-PTC-one-real-child-fixture-adapter-not-real-provider', directory,
    rootId: root.id, childId: child.id, rootRequests, childRequests, externalRequests, originalRuns, originalBodies, agentErrors,
    sourceHash: hash(JSON.stringify(binding)), sourceBinding: binding, configHash: hash(await readFile(overlay)),
    lifecycle: jobs().map(row => ({ seq: row.seq, ...row.data })), source: received.data.source, coldEventCount: cold.length, verified: true }
  await writeFile(resolve(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log('PTC_TEAM_ACCEPTED=' + JSON.stringify({ directory, rootId: root.id, childId: child.id, originalRuns, rootRequests, childRequests, externalRequests }))
} catch (error) {
  console.error('PTC_TEAM_LAB_ERROR=' + JSON.stringify({ directory, message: error.message, stack: error.stack?.split('\n').slice(0, 8), rootRequests, childRequests, agentErrors }))
  throw error
} finally {
  release.resolve()
  if (ctx) {
    for (const agent of [child, root].filter(Boolean)) { agent.cancel({ kind: 'user' }, { keepInbox: true }); await bounded('dispose-idle', agent.whenIdle()) }
    await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(() => ctx.fiber.dispose()))
    console.log('PTC_TEAM_HOST_DISPOSED=true')
  }
}
