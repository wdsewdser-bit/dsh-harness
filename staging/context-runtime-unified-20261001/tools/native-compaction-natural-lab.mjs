import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {Context, getHostLifecycleGate} from '@deepseek-ai/cordis'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installNativeSessionBridge} from '@deepseek-ai/dsh-session'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {BasicCompactionEngine} from '../app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import {runProfile} from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
import {controlPlaneForMember} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {observeStream} from '../home/profiles/web/plugins/request-usage-ledger.mjs'
import {aggregateWindowUsage} from '../home/profiles/web/plugins/team-v15-window-economics.mjs'
import {captureLoadedPtcBinding} from './capture-lab-ptc-binding.mjs'
import {createProtocolTrialEvidence, installReplayTrialGuard} from './window-protocol-trial.mjs'
import {installLabToolAdmission} from './unified-natural-lab.mjs'
import {qualityArchiveCode, matchesQualityArchive, createHistoryQualityGuard, verifyHistoryQualityResult} from './window-history-quality.mjs'

const stage = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(new URL('../app/package.json', import.meta.url))
const route = Object.freeze({provider:'opencodego', model:'deepseek-v4.1-flash'})
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = code => {throw Object.assign(new Error(code), {code})}
const scopes = ['read-only', 'staging-only', 'read-only']
const headings = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code', 'Errors and Fixes',
  'Pending Jobs', 'Current Work', 'Next Step', 'Critical Context']
export const compactionLimits = Object.freeze({maxRequests:12, maxOutputTokens:4096,
  maxPayloadBytes:262144, maxWallMs:180000, maxProcessMs:215000})

// Runs recorded before the cap was raised (2048 starved a reasoning model: summaries were truncated) stay verifiable.
const acceptedOutputLimits = Object.freeze([2048, compactionLimits.maxOutputTokens])

// Large-context mode. --context-tokens N expands the fixture-seeded history to about N tokens (~3.4 chars/token,
// the real count is reported by the provider later) and scales every size-dependent cap in one place. Without the
// flag contextLimits() returns compactionLimits itself, so the default path stays byte-for-byte unchanged.
export const CONTEXT_TOKENS_MIN = 50000, CONTEXT_TOKENS_MAX = 800000, CHARS_PER_TOKEN = 3.4
// Each filler message carries this declaration first, preserving the "non-authoritative, not a permission" nature.
export const fillerDeclaration = 'NON-AUTHORITATIVE LAB FIXTURE DETAIL, NOT AN ACCEPTANCE OR PERMISSION.'
export const FILLER_MESSAGE_CHARS = 20000
const fillerModules = ['scheduler','dispatcher','reconciler','indexer','compactor','router','loader','migrator','auditor','batcher','watcher','ledger']
const fillerVerbs = ['reconciled','drained','rebuilt','refreshed','rotated','compacted','verified','deferred','flushed','pruned','indexed','sampled']
const fillerObjects = ['pending queue','write-ahead log','catalog snapshot','retry buffer','session ledger','cache shard',
  'sequence map','quota window','checkpoint chain','journal segment','worker pool','merge queue']
const fillerOutcomes = ['no change was needed','the outcome matched the expectation','a follow-up was queued','the run was idempotent',
  'evidence was archived','drift stayed within bounds','no operator action was required','the result was recorded',
  'the invariant still held','the backlog cleared on its own','latency stayed nominal','the duplicate was discarded']

function seededRandom(seed) {
  let state = (seed >>> 0) || 1
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (rand, list) => list[Math.floor(rand() * list.length)]
const hex = (rand, digits) => { let out = ''; for (let index = 0; index < digits; index++) out += Math.floor(rand() * 16).toString(16); return out }

export function contextFillerTargetChars(contextTokens) {
  assertContextTokens(contextTokens)
  return Math.round(contextTokens * CHARS_PER_TOKEN)
}
function assertContextTokens(contextTokens) {
  if (!Number.isSafeInteger(contextTokens) || contextTokens < CONTEXT_TOKENS_MIN || contextTokens > CONTEXT_TOKENS_MAX) fail('LAB_CONTEXT_TOKENS_INVALID')
}

// Deterministic diverse filler: same N yields byte-identical messages, a different N yields a different stream.
export function generateContextFiller(contextTokens) {
  assertContextTokens(contextTokens)
  const rand = seededRandom(contextTokens), targetChars = contextFillerTargetChars(contextTokens), lines = []
  for (let entry = 1, bodyChars = 0; bodyChars < targetChars; entry++) {
    const line = `[entry ${entry}] ${pick(rand, fillerModules)} ${hex(rand, 5)}: ${pick(rand, fillerVerbs)} the ${pick(rand, fillerObjects)}`
      + ` after ${Math.floor(rand() * 90) + 1} minutes; ${pick(rand, fillerOutcomes)} (ref ${hex(rand, 5)}-${hex(rand, 5)}).`
    lines.push(line); bodyChars += line.length + 1
  }
  const messages = []
  for (let current = [], currentChars = 0, index = 0; index <= lines.length; index++) {
    if (index === lines.length || (currentChars + lines[index].length + 1 > FILLER_MESSAGE_CHARS && current.length)) {
      messages.push(fillerDeclaration + '\n' + current.join('\n')); current = []; currentChars = 0
    }
    if (index < lines.length) { current.push(lines[index]); currentChars += lines[index].length + 1 }
  }
  const chars = messages.reduce((sum, text) => sum + text.length, 0)
  return {contextTokens, targetChars, chars, messages}
}

// One place for every cap that size changes: payload bytes, wall clock and process timeout grow with N.
// maxRequests/maxOutputTokens intentionally stay fixed (the protocol's request count does not depend on N, and the
// single-model-output cap must not grow); the compaction engine's manualRetainTokens/maxTokens are token-retention and
// output caps, not context caps, so they are intentionally not scaled.
export function contextLimits(contextTokens) {
  if (contextTokens === undefined || contextTokens === null) return compactionLimits
  assertContextTokens(contextTokens)
  return Object.freeze({...compactionLimits,
    maxPayloadBytes: Math.max(compactionLimits.maxPayloadBytes, contextTokens * 6),
    maxWallMs: Math.max(compactionLimits.maxWallMs, contextTokens * 2),
    maxProcessMs: Math.max(compactionLimits.maxProcessMs, contextTokens * 2 + 35000)})
}

export function verifyCompactionAnswer(text, scope) {
  try {
    const fenced = /^```json\s*\n([\s\S]*?)\n```$/.exec(text.trim())
    const value = JSON.parse(fenced ? fenced[1] : text)
    return Object.keys(value).length === 4 && value.remaining === 4 && value.completionAllowed === false
      && value.pendingInputPolicy === 'preserve' && value.writeScope === scope
  } catch {return false}
}

export function verifyCompactionSummary(text, plan) {
  const found = [...text.matchAll(/^## ([^\n\r]+)\s*$/gm)].map(match => match[1])
  return JSON.stringify(found) === JSON.stringify(headings) && text.includes(plan.path)
    && text.includes(plan.sha256) && text.includes('active-production')
}

export function createCompactionAdmission(sessionId, run = true, initialRequests = 0, limits = compactionLimits) {
  if (!Number.isSafeInteger(initialRequests) || initialRequests < 0 || initialRequests > limits.maxRequests) fail('LAB_INITIAL_REQUESTS_INVALID')
  let requests = initialRequests, recovery
  return Object.freeze({
    admit(options) {
      if (!run) fail('LAB_BOOTSTRAP_NO_SAMPLING')
      if (options.sessionId !== sessionId) fail('LAB_FOREIGN_SESSION')
      if (options.provider !== route.provider || options.model !== route.model) fail('LAB_FOREIGN_ROUTE')
      if (options.maxTokens !== limits.maxOutputTokens) fail('LAB_OUTPUT_LIMIT')
      if (Buffer.byteLength(JSON.stringify(options.messages)) > limits.maxPayloadBytes) fail('LAB_PAYLOAD_LIMIT')
      if (requests >= limits.maxRequests) fail('LAB_REQUEST_LIMIT')
      requests++
    },
    tool(exec) {
      const mine = exec?.agent?.id === sessionId && exec.agent.session?.id === sessionId
      const name = exec?.name ?? exec?.tool?.name, args = exec?.arguments ?? {}
      const archive = mine && name === 'run_code' && args.code?.trim() === qualityArchiveCode
        && Object.keys(args).every(key => ['code','description'].includes(key))
      return archive || recovery?.allow(exec) ? {kind:'allow'} : {kind:'deny',reason:'LAB_STATIC_PROBE_ONLY'}
    },
    observe(exec, result) {recovery?.observe(exec, result)},
    bindTarget(seq) {if (recovery) fail('LAB_TARGET_ALREADY_BOUND'); recovery = createHistoryQualityGuard(sessionId, seq); return recovery.code},
    snapshot() {return {requests, limits:compactionLimits}},
  })
}

const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
const argumentCode = call => typeof call.arguments === 'string' ? JSON.parse(call.arguments).code : call.arguments?.code
export function decodeHistoryArtifact(message) {
  const text = textOf(message), suffix = '\nFile sandbox enforcement is partial on this host.'
  return JSON.parse(text.endsWith(suffix) ? text.slice(0,-suffix.length) : text)
}
export function verifyCompactionNatural(journal, requests, evidence, limits = compactionLimits) {
  try {
    if (journal.some((event,index) => event.seq !== index)) return {accepted:false,scope:'noncontiguous-canonical-journal'}
    const summaries = journal.filter(event => event.type === 'compaction/summary')
    const target = journal[evidence.targetSeq]
    const results = journal.filter(event => event.type === 'tool/result').map(event => event.data.message)
    const calls = journal.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content)
      .filter(block => block.type === 'tool-call')
    const recovery = results.find(message => {
      try {
        const value = decodeHistoryArtifact(message)
        const started = journal.find(event => event.type === 'tool/ptc-dispatch-start'
          && event.data.subCallId === value.deliveryCandidate?.callId)
        const finished = journal.find(event => event.type === 'tool/ptc-dispatch'
          && event.data.subCallId === value.deliveryCandidate?.callId)
        return verifyHistoryQualityResult(value,target) && value.descriptor.readerSessionId === evidence.sessionId
          && value.descriptor.sourceRef.sessionId === evidence.sessionId
          && started?.data.rootCallId === message.toolCallId && started.data.parentCallId === message.toolCallId
          && started.data.name === 'history_recall' && started.data.arguments.action === 'assemble'
          && started.data.arguments.locator === value.descriptor.locator
          && started.data.arguments.expectedRevision === value.descriptor.sourceRef.sourceRevision
          && started.data.arguments.expectedSourceHash === value.descriptor.sourceRef.sourceHash
          && finished?.data.rootCallId === message.toolCallId && finished.data.parentCallId === message.toolCallId
          && finished.data.isError === false && finished.seq > started.seq
          && JSON.stringify(finished.data.arguments) === JSON.stringify(started.data.arguments)
      } catch {return false}
    })
    const sourceBound = target?.type === 'tool/result' && matchesQualityArchive(textOf(target.data.message))
    const retry = evidence.recoveryRetry
    const paired = calls.length === (retry ? 3 : 2) && results.length === calls.length && calls.every((call, index) => call.name === 'run_code'
      && argumentCode(call) === (index === 0 ? qualityArchiveCode : evidence.recoveryCode)
      && results.some(result => result.toolCallId === call.id && result.isError === (retry && index === 1 ? true : false)))
    const retryBound = !retry || sha(JSON.stringify(journal.slice(0,retry.beforeEventCount))) === retry.beforeJournalHash
      && journal[retry.priorAnswerSeq]?.type === 'assistant/message' && evidence.rounds[2].answerSeq >= retry.beforeEventCount
    const rounds = evidence.rounds.length === 3 && evidence.rounds.every((round, index) => {
      if (sha(JSON.stringify(journal.slice(0, round.beforeEventCount))) !== round.beforeJournalHash) return false
      if (!verifyCompactionAnswer(textOf(journal[round.answerSeq]?.data.message), scopes[index])) return false
      if (evidence.baseline) return round.summarySeq === null && JSON.stringify(round.beforeSurface) === JSON.stringify(round.afterSurface)
      const summary = journal[round.summarySeq], start = journal[round.startSeq], end = journal[round.endSeq]
      return summary?.type === 'compaction/summary' && summary.data.llmStreamCall === true
        && start?.type === 'compaction/start' && end?.type === 'compaction/end' && end.data.error === undefined
        && summary.data.compactionId === start.data.compactionId && start.data.compactionId === end.data.compactionId
        && verifyCompactionSummary(textOf({content:summary.data.summary}), evidence.plan)
        && summary.data.shadowedSeqs.includes(round.fillerSeq) && !summary.data.shadowedSeqs.includes(round.boundarySeq)
        && round.afterSurface.includes(round.boundarySeq) && round.afterBytes < round.beforeBytes
    })
    const final = journal.at(-1)
    const requestBound = requests.length === (retry ? 11 : evidence.baseline ? 6 : 9) && requests.every(request =>
      request.status === 'success' && acceptedOutputLimits.includes(request.maxTokens) && request.maxTokens === requests[0].maxTokens
      && sha(JSON.stringify(request.messages)) === request.payloadSha256
      && Buffer.byteLength(JSON.stringify(request.messages)) <= limits.maxPayloadBytes)
    const summaryRequests = requests.filter(request => request.purpose === 'compaction').length
    const recoveryDispatched = !!recovery && requests.some(request => request.messages.some(message =>
      message.role === 'tool' && message.toolCallId === recovery.toolCallId && textOf(message) === textOf(recovery)))
    return {accepted:sourceBound && paired && retryBound && rounds && requestBound && recoveryDispatched
      && summaries.length === (evidence.baseline ? 0 : 3) && summaryRequests === summaries.length
      && final?.type === 'turn/end' && final.data.reason.kind === 'completed',
      scope:'matched-native-three-compaction-quality-case; root-only; not-full-Team-AB',
      sourceBound, toolPairMatched:paired, retryPrefixPreserved:retryBound, roundsVerified:rounds, requestBound, recoveryDispatched,
      nativeSummaryCount:summaries.length, compactionRequests:summaryRequests, remainingMandatory:4, money:null}
  } catch {return {accepted:false, scope:'native-three-compaction-malformed-evidence'}}
}

async function coldRead(directory, sessionId) {
  const ctx = new Context(), gate = getHostLifecycleGate(ctx)
  let storage, handle
  try {
    await gate.observeSettlement(() => gate.runAsync(() => {storage = new Jsonl(ctx, {root:join(directory,'sessions')})}))
    handle = await storage.open(sessionId, 'read')
    return (await handle.read()).events
  } finally {
    await handle?.close()
    await gate.observeSettlement(() => gate.runAsync(() => ctx.fiber.dispose()))
  }
}

export async function verifyStored(directory) {
  directory = resolve(directory)
  assert.ok(directory.startsWith(join(stage,'lab-runs') + sep))
  const result = JSON.parse(readFileSync(join(directory,'result.json')))
  const saved = JSON.parse(readFileSync(join(directory,'canonical-journal.json')))
  const requests = JSON.parse(readFileSync(join(directory,'request-evidence.json')))
  const evidence = JSON.parse(readFileSync(join(directory,'compaction-evidence.json')))
  evidence.sessionId ??= result.sessionId
  const storageDirectory = resolve(result.resumeOf ?? directory)
  assert.ok(storageDirectory.startsWith(join(stage,'lab-runs') + sep))
  const journal = await coldRead(storageDirectory, result.sessionId)
  assert.deepEqual(journal, saved)
  const natural = verifyCompactionNatural(journal,requests,evidence,result.limits ?? compactionLimits)
  const receipt = {...natural, independentNativeDiskReadback:true,
    sessionId:result.sessionId, journalSha256:sha(JSON.stringify(journal)), requestEvidenceSha256:sha(readFileSync(join(directory,'request-evidence.json'))),
    externalRequests:0, historicalResultPreserved:true, verifiedAt:new Date().toISOString()}
  // Large-context runs recheck the recorded N against the actual journal instead of any small-context constant.
  if (result.contextTokens) {
    const limits = contextLimits(result.contextTokens), filler = generateContextFiller(result.contextTokens)
    const texts = new Set(journal.filter(event => event.type === 'user/message').map(event => textOf(event.data)))
    if (filler.messages.some(text => !texts.has(text)) || filler.chars !== result.seededHistoryChars
      || filler.messages.length !== result.seededHistoryMessages
      || JSON.stringify(limits) !== JSON.stringify(result.limits)) natural.accepted = false
    Object.assign(receipt, {contextTokens:result.contextTokens, seededHistoryChars:filler.chars,
      seededHistoryMessages:filler.messages.length, scaledLimitsMatch:JSON.stringify(limits) === JSON.stringify(result.limits),
      accepted:natural.accepted})
  }
  writeFileSync(join(directory,'offline-verification.json'), JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify(receipt)); assert.equal(receipt.accepted,true)
  return receipt
}

async function child(run, baseline, output, resumeDirectory = null, contextTokensArg = null) {
  if (resumeDirectory) assert.ok(resolve(resumeDirectory).startsWith(join(stage,'lab-runs') + sep))
  const previous = resumeDirectory ? JSON.parse(readFileSync(join(resumeDirectory,'result.json'))) : null
  const contextTokens = contextTokensArg ?? previous?.contextTokens ?? null
  const limits = contextLimits(contextTokens)
  const previousJournal = resumeDirectory ? JSON.parse(readFileSync(join(resumeDirectory,'canonical-journal.json'))) : null
  if (previous) {
    assert.equal(previous.requests,9); assert.equal(previous.nativeSummaryCount,3); assert.equal(previous.baseline,false)
    assert.deepEqual((await coldRead(resumeDirectory,previous.sessionId)).slice(0,previousJournal.length),previousJournal)
    assert.equal(baseline,false)
  }
  const home = join(stage,'lab-host-home'), sessionId = previous?.sessionId ?? randomUUID(), cwd = join(output,'workspace')
  const storageDirectory = resumeDirectory ?? output
  assert.equal(process.env.DSH_HOME, home)
  assert.equal(process.env.DSH_LAB_CANONICAL_MODULES,'1')
  const prep = JSON.parse(readFileSync(join(home,'preparation-evidence.json')))
  assert.equal(prep.prepared,true); assert.equal(sha(readFileSync(join(home,'dump-config.yaml'))),prep.dumpSha256)
  mkdirSync(cwd,{recursive:true})
  const save = (name,value) => writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n')
  const planBody = {fixture:true, fullRequirements:10, verifiedRequirements:6, productionEnabled:false,
    prohibitions:['active-production','do-not-restart','preserve-pending-input'], status:'partial'}
  const planPath = join(output,'fixture-full-plan.json')
  save('fixture-full-plan.json',planBody)
  const evidence = resumeDirectory ? JSON.parse(readFileSync(join(resumeDirectory,'compaction-evidence.json')))
    : {baseline, plan:{path:planPath,sha256:sha(readFileSync(planPath)),revision:1}, rounds:[]}
  evidence.sessionId = sessionId
  save('storage-overlay.json',[
    {id:'session-persistence-jsonl',config:{root:join(storageDirectory,'sessions')}},
    {id:'session-query-sqlite',config:{path:join(storageDirectory,'query.sqlite'),openAt:'startup'}},
    {id:'team-runtime-guard',config:{sessionListCachePath:join(storageDirectory,'session-list-cache.json')}},
  ])
  const requests = resumeDirectory ? JSON.parse(readFileSync(join(resumeDirectory,'request-evidence.json'))) : []
  const terminals = resumeDirectory ? JSON.parse(readFileSync(join(resumeDirectory,'request-terminals.json'))) : []
  for (const request of requests) assert.equal(sha(JSON.stringify(request.messages)),request.payloadSha256)
  const events = [], admission = createCompactionAdmission(sessionId,run,requests.length,limits)
  const result = {sessionId,output,route,limits,baseline,run,accepted:false,productionWrites:false,
    fixtureSeededHistory:true,resumeOf:resumeDirectory,startedAt:new Date().toISOString()}
  // Recorded only in large-context mode, so the default output files stay byte-for-byte identical.
  if (contextTokens) Object.assign(result,{contextTokens,seededHistoryChars:previous?.seededHistoryChars ?? 0,
    seededHistoryMessages:previous?.seededHistoryMessages ?? 0})
  save('run-manifest.json',result)
  const abort = new AbortController()
  let ctx, agent, barrier, restore, timer
  try {
    const host = await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]),
      profile:'web',patchFiles:[join(output,'storage-overlay.json')],args:['--no-open','--port','40124']})
    ctx = host.ctx
    const gate = getHostLifecycleGate(ctx)
    await gate.observeSettlement(() => gate.runAsync(async () => {
      ctx.on('llm/stream',(options,next) => {
        admission.admit(options)
        const request = {purpose:options.purpose ?? null,maxTokens:options.maxTokens,messages:options.messages,
          payloadSha256:sha(JSON.stringify(options.messages)),status:'started'}
        requests.push(request)
        const attemptId = 'observer-'+requests.length
        return observeStream(options,next,{metadata:() => ({attemptId,rootSessionId:sessionId,
          requestProjection:ctx.requestMessageProjection?.audit(options) ?? null}), record:row => {
          if (row.event === 'terminal') {
            terminals.push(row)
            Object.assign(request,{status:row.status,usage:row.usage,
              reportedUsage:row.reportedUsage,usageFinal:row.usageFinal,latencyMs:row.latencyMs})
          }
        }})
      },{global:true})
      installLabToolAdmission(ctx,admission)
      ctx.on('tools/result',(exec,result) => admission.observe(exec,result),{global:true})
      if (resumeDirectory) {
        const found = await ctx.sessionController.agents.resolveAgent(sessionId)
        if (found.error) throw found.error
        agent = found.agent
        agent.options = {...agent.options,maxTokens:limits.maxOutputTokens}
      } else {
        const composition = await ctx.sessionController.agents.composeAgent('ptc')
        agent = (await ctx.agents.create({sessionId,agentOptions:{...route,maxTokens:limits.maxOutputTokens},
          meta:{cwd,agentPreset:composition.agentPreset},setup:composition.setup})).agent
      }
    }))
    await ctx.sessionController.selectModel({sessionId,...route})
    const cp = controlPlaneForMember(ctx,agent,{directory:join(home,'team-control-plane')})
    assert.ok(cp); await cp.flush()
    const state = cp.snapshot({history:false,copy:true}), identity = ctx.teamIdentityRuntime.proposal(agent)
    await ctx.teamIdentityRuntime.activate(agent,{expectedControlRevision:state.revision,
      expectedIdentityEpoch:state.identityEpoch ?? 0,expectedBundleHash:identity.contentHash})
    const binding = captureLoadedPtcBinding(ctx,agent,{expectedRoute:route,expectedSessionId:sessionId})
    save('loaded-ptc-binding.json',binding)
    save('protocol-trial.json',createProtocolTrialEvidence(binding,sessionId,Date.now(),{nativeSurface:true}))
    await gate.observeSettlement(() => gate.runAsync(() => {restore = installReplayTrialGuard(ctx.llm.registration(route.provider).adapter,
      value => events.push(value))}))
    barrier = await ctx.sessionPersistence.windowBarrierFor(agent.session,{isolated:true,sessionId})
    installNativeSessionBridge(agent.session,{isolated:true,sessionId,flush:async () => (await barrier.persist()).durable === true})
    let engine
    await gate.observeSettlement(() => gate.runAsync(async () => {
      const ready = Promise.withResolvers()
      agent.ctx.inject(BasicCompactionEngine.inject, scoped => {
        try {
          // LAB_AUTO_PRESSURE_RATIO=<ratio> turns on the engine's own step-boundary pressure compaction at that share of the
          // model window (with a proportionally small retained tail), to observe a fold in the middle of an open turn.
          const autoRatio = Number(process.env.LAB_AUTO_PRESSURE_RATIO)
          engine = new BasicCompactionEngine(scoped, autoRatio > 0 && autoRatio < 1
            ? {auto:true,thresholdRatio:autoRatio,retainRatio:autoRatio/4,manualRetainTokens:64,maxTokens:limits.maxOutputTokens}
            : {auto:false,manualRetainTokens:64,maxTokens:limits.maxOutputTokens})
          assert.equal(typeof scoped.llm.stream,'function')
          assert.equal(typeof scoped.sessions.flush,'function')
          save('engine-dependencies.json',{inject:[...BasicCompactionEngine.inject],
            measuredTokens:scoped.tokenMeter.measure(agent.session).totalTokens,source:'actual-Cordis-injected-services'})
          ready.resolve()
        } catch (error) {ready.reject(error)}
      })
      await ready.promise
    }))
    const user = (id,text) => createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text}]})
    const follow = async (id,text) => {
      await agent.followup(user(id,text)); await agent.whenIdle(); abort.signal.throwIfAborted(); await barrier.persist()
    }
    // Append the deterministic fixture-seeded history directly to the surface: no model request is made for it.
    const seedContextHistory = async () => {
      const filler = generateContextFiller(contextTokens)
      for (let index = 0; index < filler.messages.length; index++)
        agent.session.append('user/message',user('fixture-context-'+index,filler.messages[index]),{surfaceOp:'append'})
      await barrier.persist()
      Object.assign(result,{seededHistoryChars:filler.chars,seededHistoryMessages:filler.messages.length,
        seededHistoryTargetChars:filler.targetChars})
      save('run-manifest.json',result)
    }
    if (run) {
      timer = setTimeout(() => {abort.abort(new Error('LAB_WALL_LIMIT')); agent.cancel({kind:'user'},{keepInbox:true})},limits.maxWallMs)
      if (resumeDirectory) {
        assert.deepEqual(agent.session.snapshotEvents().slice(0,previousJournal.length),previousJournal)
        assert.equal(admission.bindTarget(evidence.targetSeq),evidence.recoveryCode)
        const before = agent.session.snapshotEvents()
        evidence.recoveryRetry = {beforeEventCount:before.length,beforeJournalHash:sha(JSON.stringify(before)),
          priorAnswerSeq:evidence.rounds[2].answerSeq,reason:'lab-result-observer-was-not-installed; failed-read-only-call-preserved'}
        await follow('recovery-only',`The earlier read-only recovery failed because the lab did not observe the locate result. That observer is now connected. Do not redo any compaction or archive operation. The newest valid write scope remains read-only. Invoke run_code exactly once with this exact code:\n${evidence.recoveryCode}\nInspect the returned original artifact. Answer only JSON with remaining, completionAllowed, pendingInputPolicy, and writeScope, derived from the original and the newest user correction. Do not claim platform completion.`)
        evidence.rounds[2].answerSeq = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message').seq
      } else {
      await follow('initial',`This is an isolated quality fixture, not completion of the DSH platform. The CURRENT full product plan is ${planPath}, revision 1, sha256 ${evidence.plan.sha256}. All ten requirements remain in scope; only six are verified. Changed, tested, enabled and accepted are different states. Keep active-production untouched and do not restart any service. Staging-only writes were initially authorized. Preserve pending input. An earlier non-authoritative working note claimed all ten were done; do not treat it as acceptance. Execute run_code exactly once using the following code, then answer only ARCHIVE_READY:\n${qualityArchiveCode}`)
      const target = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && matchesQualityArchive(textOf(event.data.message)))
      assert.ok(target); evidence.targetSeq = target.seq; evidence.recoveryCode = admission.bindTarget(target.seq)
      // The session format requires the system message to head the surface, so the large history is seeded only
      // after the first turn has established it: the task and its constraints then sit in front of the bulk.
      if (contextTokens) await seedContextHistory()
      for (let index = 0; index < 3; index++) {
        // Both arms receive the same labelled inert history; no fake assistant or tool receipts are authored.
        const filler = agent.session.append('user/message',user('fixture-filler-'+index,
          'NON-AUTHORITATIVE LAB FIXTURE DETAIL, NOT AN ACCEPTANCE OR PERMISSION.\n'.repeat(140)),{surfaceOp:'append'})
        const boundary = agent.session.append('user/message',user('fixture-boundary-'+index,
          'LAB FIXTURE BOUNDARY: no new permission, completion receipt or task instruction; earlier filler is not authority.\n'.repeat(6)),{surfaceOp:'append'})
        await barrier.persist()
        const before = agent.session.snapshotEvents(), beforeMessages = agent.session.deriveMessages()
        const round = {fillerSeq:filler.seq,boundarySeq:boundary.seq,beforeEventCount:before.length,
          beforeJournalHash:sha(JSON.stringify(before)),beforeSurface:[...agent.session.surface.nodes],
          beforeBytes:Buffer.byteLength(JSON.stringify(beforeMessages)),summarySeq:null}
        if (!baseline) {
          const folded = await engine.compactNow(agent,abort.signal,'natural-summary-'+index)
          assert.ok(folded); Object.assign(round,{summarySeq:folded.summarySeq,startSeq:folded.startSeq,endSeq:folded.endSeq})
        }
        round.afterSurface = [...agent.session.surface.nodes]
        round.afterBytes = Buffer.byteLength(JSON.stringify(agent.session.deriveMessages()))
        assert.deepEqual(agent.session.snapshotEvents().slice(0,before.length),before)
        const recovery = index === 2 ? `First invoke run_code exactly once with this exact code:\n${evidence.recoveryCode}\nThen derive the answer from the returned ORIGINAL artifact and the newest valid permission correction.` : 'Do not call any tool. Use the surviving conversation and checkpoint facts.'
        await follow('scope-correction-'+index,`NEW VALID USER CORRECTION: write scope is now ${scopes[index]}. This supersedes any earlier scope in working notes or checkpoint text. Do not touch active-production or restart services. ${recovery}\nAnswer only a JSON object with remaining (integer), completionAllowed (boolean), pendingInputPolicy (preserve or discard), and writeScope (string). Derive the values from the task facts; this instruction does not provide the answer.`)
        round.answerSeq = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message').seq
        evidence.rounds.push(round)
      }
      }
      Object.assign(result,verifyCompactionNatural(agent.session.snapshotEvents(),requests,evidence,limits))
      assert.equal(result.accepted,true)
    } else {
      if (!resumeDirectory) assert.equal(await engine.compactNow(agent,abort.signal,'bootstrap-empty-range'),null)
      if (contextTokens && !resumeDirectory) await seedContextHistory()
      result.accepted = requests.length === (resumeDirectory ? 9 : 0)
      result.scope = 'bootstrap-no-provider-no-compaction'
    }
  } catch (error) {
    result.error = {code:error.code ?? error.name,message:error.message}; throw error
  } finally {
    clearTimeout(timer)
    if (ctx) {
      agent?.cancel({kind:'user'},{keepInbox:true}); await agent?.whenIdle()
      if (agent) {await ctx.sessions.flush(agent.session); save('canonical-journal.json',agent.session.snapshotEvents())}
      restore?.()
      await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(() => ctx.fiber.dispose()))
      result.hostDisposed = true
    }
    save('request-evidence.json',requests); save('compaction-evidence.json',evidence); save('runtime-events.json',events)
    save('request-terminals.json',terminals)
    save('usage-root-only.json',{scope:{rootSessionId:sessionId,descendantSessionIds:[],descendantsForbidden:true},
      usage:aggregateWindowUsage(terminals,{rootSessionId:sessionId,memberSessionIds:[sessionId]}),money:null})
    result.admission = admission.snapshot(); result.requests = requests.length; result.finishedAt = new Date().toISOString()
    result.newRequests = requests.length - (previous?.requests ?? 0)
    save('result.json',result); console.log(JSON.stringify(result))
  }
}

export async function main() {
  const at = process.argv.indexOf('--verify')
  if (at >= 0) return verifyStored(process.argv[at+1])
  const run = process.argv.includes('--run'), baseline = process.argv.includes('--baseline')
  const resumeAt = process.argv.indexOf('--resume')
  const resumeDirectory = resumeAt >= 0 ? resolve(process.argv[resumeAt+1]) : null
  const contextAt = process.argv.indexOf('--context-tokens')
  const contextTokens = contextAt >= 0 ? Number(process.argv[contextAt+1]) : null
  const limits = contextLimits(contextTokens)
  const outputAt = process.argv.indexOf('--output')
  assert.ok(outputAt >= 0)
  const output = resolve(process.argv[outputAt+1])
  assert.ok(output.startsWith(join(stage,'lab-runs') + sep))
  if (process.argv.includes('--child')) return child(run,baseline,output,resumeDirectory,contextTokens)
  mkdirSync(output,{recursive:false})
  const env = {...process.env,DSH_HOME:join(stage,'lab-host-home'),DSH_LAB_CANONICAL_MODULES:'1'}
  if (run) {
    const {parseCredentialsDocument} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')))
    const key = parseCredentialsDocument(readFileSync('D:/dsh-test/home/.credentials.yaml','utf8'),'readonly-production').refs.get('OPENCODEGO_API_KEY')
    if (typeof key !== 'string' || !key) fail('LAB_CREDENTIAL_REFERENCE_MISSING')
    env.OPENCODEGO_API_KEY = key
  }
  const spawned = spawnSync(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','--import',
    new URL('./prepare-unified-lab-host.mjs',import.meta.url).href,fileURLToPath(import.meta.url),'--child','--output',output,
    ...(run ? ['--run'] : []),...(baseline ? ['--baseline'] : []),...(resumeDirectory ? ['--resume',resumeDirectory] : []),
    ...(contextTokens ? ['--context-tokens',String(contextTokens)] : [])],
    {cwd:stage,env,windowsHide:true,encoding:'utf8',timeout:limits.maxProcessMs,maxBuffer:4*1024*1024})
  writeFileSync(join(output,'host.stdout.log'),spawned.stdout ?? '')
  writeFileSync(join(output,'host.stderr.log'),spawned.stderr ?? '')
  console.log(JSON.stringify({output,exitCode:spawned.status,processError:spawned.error?.code ?? null}))
  if (spawned.status !== 0) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {console.error(error.code ?? error.name, error.message);process.exitCode = 1})
}
