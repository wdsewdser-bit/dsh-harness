import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Context } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/cordis/lib/index.js'
import { Session, SessionId } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { windowMessageBytes } from 'file:///D:/dsh-test/home/profiles/web/plugins/team-v15-window-checkpoint.mjs'

const root = 'D:/dsh-test/output/window-isolated-live-20261011'
const id = SessionId('session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a')
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const before = JSON.parse(fs.readFileSync('D:/dsh-test/output/window-measure-before-live-20261011.json'))
const backend = new JsonlSessionPersistence(new Context(), { root: root + '/home/sessions', compression: 'zstd' })
const handle = await backend.open(id, 'read')
try {
  const stored = await handle.read()
  const session = Session.fromRestore(id, stored.events, handle.header, handle.inheritedEventCount, stored.eventState)
  const messages = session.deriveMessages()
  const byId = new Map(messages.map(message => [message.id, message]))
  const witnesses = before.derivedConversation.preservationWitness
  const failed = witnesses.filter(row => !byId.has(row.id) || sha(byId.get(row.id)) !== row.sha256)
  const windowOps = stored.events.filter(event => event.surfaceOp?.op === 'replace-many')
  const checkpoints = messages.filter(message => message.content?.some(part => {
    if (part.type !== 'text') return false
    try { return JSON.parse(part.text).kind === 'historical-window-checkpoint' } catch { return false }
  }))
  const report = { generatedAt: new Date().toISOString(), sessionId: id, coldReplay: true,
    messages: messages.length, modelVisibleHarnessJsonBytes: windowMessageBytes(messages),
    beforeModelVisibleHarnessJsonBytes: before.derivedConversation.modelVisibleHarnessJsonBytes,
    preservationWitnessCount: witnesses.length, preservationFailures: failed.map(row => row.id),
    replaceManyEvents: windowOps.length, replaceManyRanges: windowOps.map(event => event.surfaceOp.ranges?.length),
    checkpointMessages: checkpoints.length, eventCount: stored.events.length,
    lastEvents: stored.events.slice(-8).map(event => ({ seq: event.seq, type: event.type })) }
  if (process.argv.includes('--accept')) {
    const host = JSON.parse(fs.readFileSync(root + '/recovery2-state.json'))
    const rows = fs.readdirSync(root + '/home/usage-ledger').filter(name => name.startsWith(`requests-${host.hostPid}-`))
      .flatMap(name => fs.readFileSync(root + '/home/usage-ledger/' + name, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
    const terminal = rows.filter(row => row.event === 'terminal' && row.sessionId === id)
    const answer = [...messages].reverse().find(message => message.role === 'assistant')
    const answerText = answer?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
    const afterFold = stored.events.filter(event => event.seq > windowOps[0].seq)
    const eventTypes = {}
    for (const event of afterFold) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
    const newToolCalls = messages.filter(message => Number(message.id) > windowOps[0].seq)
      .flatMap(message => message.content ?? []).filter(part => part.type === 'tool-call').length
    const signatures = JSON.parse(fs.readFileSync(root + '/recovery2-production-signatures.json'))
    const productionChanges = signatures.filter(([file, signature]) => {
      if (!fs.existsSync(file)) return true
      const stat = fs.statSync(file)
      return `${stat.size}:${stat.mtimeMs}` !== signature
    }).map(([file]) => file)
    const regressionPath = 'D:/dsh-test/output/regressions/2026-10-11T13-00-44-122Z-373bad5f/summary.json'
    const regression = JSON.parse(fs.readFileSync(regressionPath))
    const checks = {
      coldReplay: failed.length === 0 && windowOps.length === 1 && checkpoints.length === 1,
      oracle: answerText.startsWith('WINDOW_LIVE_OK') && answerText.includes('Roguelike')
        && /8\s*层/.test(answerText) && /30\s*种/.test(answerText) && /8\s*个阶段里程碑/.test(answerText)
        && answerText.includes('index.html') && answerText.includes('不依赖构建工具') && answerText.includes('不使用任何第三方库'),
      realRequest: terminal.length === 1 && terminal[0].complete === true && terminal[0].status === 'success'
        && terminal[0].provider === 'opencodego' && terminal[0].model === 'deepseek-v4.1-flash'
        && terminal[0].requestProjection?.handedToAdapter === true && terminal[0].usage?.inputTokens > 0
        && terminal[0].requestProjection.transforms.some(row => row.id.startsWith('native-window-admission-') && row.status === 'applied'),
      noToolCalls: newToolCalls === 0 && !afterFold.some(event => /tool[/-](?:call|effect|execute)/.test(event.type))
        && afterFold.some(event => event.type === 'turn/end'),
      productionProtected: productionChanges.length === 0 && host.status === 'stopped' && host.reason === 'requested-stop',
      regression: regression.complete === true && regression.success === true && regression.counts.failed === 0,
    }
    Object.assign(report, { acceptance: Object.values(checks).every(Boolean), checks, answerText,
      newToolCalls, postFoldEventTypes: eventTypes, productionChanges, protectedProductionFiles: signatures.length,
      host, regression: { path: regressionPath, ...regression },
      providerRequest: terminal.map(row => ({ requestId: row.requestId, provider: row.provider, model: row.model,
        status: row.status, startedAt: row.startedAt, endedAt: row.endedAt, latencyMs: row.latencyMs, usage: row.usage,
        projection: { handedToAdapter: row.requestProjection.handedToAdapter, adapterPayload: row.requestProjection.adapterPayload,
          transforms: row.requestProjection.transforms.map(item => ({ id: item.id, status: item.status })) } })) })
    const fileSha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    report.binding = {
      sourceHash: sha(['native', 'plugin'].map(kind => [kind, fileSha(`D:/dsh-test/staging/context-runtime-unified-20261001/${kind}-change-manifest.json`)])),
      configHash: fileSha(root + '/home/profiles/web/cordis.patch.yml'),
      fixtureHash: JSON.parse(fs.readFileSync(root + '/prepare.json')).originalSessionSha256,
      fixtureVersion: 'isolated-production-root-v1', model: terminal[0]?.model ?? null,
    }
    report.v12Evidence = { id: 'window-multi-live-20261011-' + report.binding.sourceHash.slice(0, 16),
      requirementId: 'W-02-multi-span-cold-consumption', status: report.acceptance ? 'passed' : 'failed',
      command: 'node tools/window-isolated-replay-20261011.mjs --accept' }
    fs.writeFileSync(root + '/acceptance.json', JSON.stringify(report, null, 2))
    if (!report.acceptance) process.exitCode = 1
  }
  fs.writeFileSync(root + '/cold-replay.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(process.argv.includes('--accept') ? { acceptance: report.acceptance, checks: report.checks,
    preservationWitnessCount: witnesses.length, replaceManyRanges: report.replaceManyRanges, evidence: root + '/acceptance.json' } : report))
  if (failed.length || windowOps.length !== 1) process.exitCode = 1
} finally { await handle.close() }
