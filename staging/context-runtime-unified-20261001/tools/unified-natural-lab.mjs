import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { windowHash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { matchesQualityArchive, qualityArchiveCode, createHistoryQualityGuard, historyQualityCode, verifyHistoryQualityResult, qualityAnswerInstruction, verifyQualityAnswer } from './window-history-quality.mjs'

const stage = resolve(fileURLToPath(new URL('..', import.meta.url)))
const home = join(stage, 'lab-host-home')
const require = createRequire(new URL('../app/package.json', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const route = Object.freeze({ provider: 'opencodego', model: 'deepseek-v4.1-flash' })
export const labLimits = Object.freeze({ maxRequests: 4, maxOutputTokens: 2048, maxPayloadBytes: 256 * 1024,
  maxWallMs: 90000, maxProcessMs: 125000 })
export const nativeLabLimits = Object.freeze({...labLimits,maxRequests:6,maxWallMs:120000,maxProcessMs:155000})
// --context-tokens N support (window-native only). The filler and the size scaling are reused verbatim from
// native-compaction-natural-lab.mjs (generateContextFiller / contextLimits); that module imports this one, so it is
// loaded lazily to avoid a static cycle. Only the size-dependent caps move: maxRequests (protocol request count) and
// maxOutputTokens (single-model-output cap) intentionally stay fixed. Without N this returns `base` unchanged, so the
// default path is byte-for-byte identical. `scale` is the imported contextLimits function.
export const contextReminderAllowance = 3
export function labContextLimits(base, contextTokens, scale) {
  if (contextTokens === null || contextTokens === undefined) return base
  const scaled = scale(contextTokens)
  // From 20% of the window the runtime itself reminds the agent about its milestone, and answering that costs a
  // request or two that the small-context budget never had to cover.
  return Object.freeze({ ...base, maxRequests: base.maxRequests + contextReminderAllowance, maxPayloadBytes: scaled.maxPayloadBytes, maxWallMs: scaled.maxWallMs, maxProcessMs: scaled.maxProcessMs })
}
export const bootstrapCode = 'return "UNIFIED_PTC_BOOTSTRAP_OK";'
export const memoText = 'UNIFIED MEMO CAS PROBE'
const memoHash = sha(memoText)
export const memoCode = `const put = await tools.context_manage({action:"memo_put",input:{sourceId:"lab-memo-cas",expectedRevision:0,scope:"member",text:${JSON.stringify(memoText)}}});
if (put.ok !== true || put.revision !== 1 || put.sha256 !== "${memoHash}") throw new Error("MEMO_PUT_MISMATCH");
const got = await tools.context_manage({action:"memo_get",input:{sourceId:"lab-memo-cas",revision:1,sha256:"${memoHash}"}});
if (got.ok !== true || got.text !== ${JSON.stringify(memoText)}) throw new Error("MEMO_GET_MISMATCH");
const stale = await tools.context_manage({action:"memo_put",input:{sourceId:"lab-memo-cas",expectedRevision:0,scope:"member",text:"STALE MUST NOT COMMIT"}});
if (stale.ok !== false || stale.code !== "CAS_CONFLICT") throw new Error("STALE_CAS_NOT_REJECTED");
const after = await tools.context_manage({action:"memo_get",input:{sourceId:"lab-memo-cas",revision:1,sha256:"${memoHash}"}});
if (after.ok !== true || after.text !== ${JSON.stringify(memoText)} || after.revision !== 1) throw new Error("MEMO_CHANGED_AFTER_REJECTION");
return "UNIFIED_MEMO_CAS_OK";`
export const viewText = 'UNIFIED VIEW CYCLE ORIGINAL'
const viewHash = sha(viewText)
const viewOperation = { op: 'select', sourceId: 'lab-view-cycle', revision: 1, sha256: viewHash }
export const viewCode = `const put = await tools.context_manage({action:"memo_put",input:{sourceId:"lab-view-cycle",expectedRevision:0,scope:"member",text:${JSON.stringify(viewText)}}});
if (put.ok !== true || put.revision !== 1 || put.sha256 !== "${viewHash}") throw new Error("VIEW_MEMO_MISMATCH");
const proposal = await tools.context_manage({action:"propose",input:{expectedRevision:0,operations:[${JSON.stringify(viewOperation)}]}});
if (proposal.ok !== true || typeof proposal.proposalId !== "string") throw new Error("VIEW_PROPOSAL_FAILED");
const preview = await tools.context_manage({action:"preview",input:{expectedRevision:0,operations:[${JSON.stringify(viewOperation)}]}});
if (preview.ok !== true || preview.originalHistoryPreserved !== true || preview.authorityPreserved !== true || preview.entries.length !== 1) throw new Error("VIEW_PREVIEW_FAILED");
const before = await tools.context_manage({action:"state",input:{}});
if (before.ok !== true || before.viewRevision !== 0) throw new Error("PREVIEW_WROTE_VIEW");
const committed = await tools.context_manage({action:"commit",input:{expectedRevision:0,proposalId:proposal.proposalId}});
if (committed.ok !== true || committed.viewRevision !== 1 || committed.mode !== "shadow") throw new Error("VIEW_COMMIT_FAILED");
const stale = await tools.context_manage({action:"commit",input:{expectedRevision:0,proposalId:proposal.proposalId}});
if (stale.ok !== false || stale.code !== "VIEW_CAS_CONFLICT") throw new Error("VIEW_STALE_NOT_REJECTED");
const selected = await tools.context_manage({action:"state",input:{}});
if (selected.ok !== true || selected.viewRevision !== 1) throw new Error("VIEW_STALE_CHANGED_STATE");
const rolled = await tools.context_manage({action:"rollback",input:{expectedRevision:1,targetRevision:0}});
if (rolled.ok !== true || rolled.viewRevision !== 2 || rolled.parentRevision !== 1) throw new Error("VIEW_ROLLBACK_FAILED");
const after = await tools.context_manage({action:"state",input:{}});
if (after.ok !== true || after.viewRevision !== 2 || after.pins.length !== 0 || after.sources.length !== 1) throw new Error("VIEW_ROLLBACK_STATE_FAILED");
const original = await tools.context_manage({action:"memo_get",input:{sourceId:"lab-view-cycle",revision:1,sha256:"${viewHash}"}});
if (original.ok !== true || original.text !== ${JSON.stringify(viewText)} || original.revision !== 1) throw new Error("VIEW_ORIGINAL_LOST");
return "UNIFIED_VIEW_CYCLE_OK";`
const scenarios = Object.freeze({
  static: { code: bootstrapCode, marker: 'UNIFIED_PTC_BOOTSTRAP_OK' },
  'memo-cas': { code: memoCode, marker: 'UNIFIED_MEMO_CAS_OK' },
  'view-cycle': { code: viewCode, marker: 'UNIFIED_VIEW_CYCLE_OK' },
  'window-shadow': { code: bootstrapCode, marker: 'UNIFIED_PTC_BOOTSTRAP_OK' },
  'window-project': { code: bootstrapCode, marker: 'UNIFIED_PTC_BOOTSTRAP_OK' },
  'window-recall': { code: qualityArchiveCode, marker: 'UNIFIED_ARCHIVE_WRITTEN' },
  'window-native': { code: qualityArchiveCode, marker: 'UNIFIED_ARCHIVE_WRITTEN' },
})
const fail = code => { throw Object.assign(new Error(code), { code }) }

// First-turn archived history. Without a filler this is the original literal; with --context-tokens the single
// leading WINDOW_TRIAL_ARCHIVE_TOKEN marker is kept first, then the diversified filler messages are appended, so any
// matcher anchored on that token still holds.
export function buildWindowHistory(scenario, native, contextFiller) {
  if (scenario !== 'window-project' && !native) return ''
  const archive = contextFiller ? 'WINDOW_TRIAL_ARCHIVE_TOKEN ' + contextFiller.messages.join('\n')
    : 'WINDOW_TRIAL_ARCHIVE_TOKEN '.repeat(native ? 2048 : 128)
  return '\nArchived trial document; retain its original canonical event for exact recovery:\n' + archive
}
export function buildFirstPrompt(scenario, native, contextFiller) {
  const { marker, code } = scenarios[scenario]
  return `This is an isolated official PTC smoke test. Invoke run_code exactly once with the following exact code and a short description:\n${code}\nDo not change the code or invoke any other file, shell, network, or Team operation. Only the context_manage calls contained in this exact code are authorized. After the tool succeeds answer only ${marker}. This is a probe, not completion of the platform implementation.` + buildWindowHistory(scenario, native, contextFiller)
}

export function nativeIsolationPatch(document,sessionId) {
  if(typeof sessionId!=='string'||!sessionId)fail('LAB_EXACT_SESSION_REQUIRED')
  const matches=[]
  const visit=value=>{
    if(Array.isArray(value))return value.forEach(visit)
    if(!value||typeof value!=='object')return
    if(value.id==='team-v12-runtime')matches.push(value)
    Object.values(value).forEach(visit)
  }
  visit(document)
  if(matches.length!==1)fail('LAB_NATIVE_RUNTIME_CONFIG_REQUIRED')
  return [{id:'team-v12-runtime',config:{...structuredClone(matches[0].config),
    windowHostParticipation:true,windowOsFileProtection:true,windowIsolatedSessions:[sessionId],
    contextPackMaxTokens:32000,tier0ContextPackMaxTokens:32000,contextDeltaMaxTokens:32000}}]
}

export function verifyNaturalProbe(journal, events) {
  const assistants = journal.filter(event => event.type === 'assistant/message').map(event => event.data?.message)
  const calls = assistants.flatMap(message => message?.content?.filter(block => block.type === 'tool-call') ?? [])
  const results = journal.filter(event => event.type === 'tool/result').map(event => event.data?.message)
  const finalText = assistants.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  let code
  try { code = JSON.parse(calls[0]?.arguments).code } catch {}
  const finalTextMatched = finalText === 'UNIFIED_PTC_BOOTSTRAP_OK'
  const paired = calls.length === 1 && calls[0].name === 'run_code' && code === bootstrapCode
    && results.length === 1 && results[0]?.toolCallId === calls[0].id && results[0]?.isError === false
    && results[0]?.content?.some(block => block.type === 'text' && block.text.split('\n')[0] === 'UNIFIED_PTC_BOOTSTRAP_OK')
  const observed = events.filter(event => event.event === 'tool-final')
  const failed = events.some(event => event.event === 'agent-error' || event.event === 'wall-timeout')
  return { accepted: paired && finalTextMatched && !failed && observed.length === 1 && !observed[0].isError,
    finalTextMatched, toolPairMatched: paired, toolFinalCount: observed.length,
    sandboxPartial: results.some(message => message?.content?.some(block => block.type === 'text' && block.text.includes('sandbox enforcement is partial'))) }
}

export function verifyMemoProbe(journal, events) {
  const assistants = journal.filter(event => event.type === 'assistant/message').map(event => event.data?.message)
  const calls = assistants.flatMap(message => message?.content?.filter(block => block.type === 'tool-call') ?? [])
  const results = journal.filter(event => event.type === 'tool/result').map(event => event.data?.message)
  const finalText = assistants.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  let exact = false
  try { exact = calls.length === 1 && calls[0].name === 'run_code' && JSON.parse(calls[0].arguments).code === memoCode } catch {}
  const finals = events.filter(event => event.event === 'tool-final')
  const nested = finals.filter(event => event.name === 'context_manage')
  const outer = finals.filter(event => event.name === 'run_code')
  const business = nested.map(event => {
    try { return JSON.parse(event.content?.filter(block => block.type === 'text').map(block => block.text).join('')) } catch { return null }
  })
  const paired = results.some(message => message?.toolCallId === calls[0]?.id && message?.isError === false
    && message.content?.some(block => block.type === 'text' && block.text.split('\n')[0] === 'UNIFIED_MEMO_CAS_OK'))
  const casRejected = business.length === 4 && business[2]?.ok === false && business[2]?.code === 'CAS_CONFLICT'
    && nested.every(event => !event.isError) && business[0]?.revision === 1 && business[0]?.sha256 === memoHash
    && [business[1], business[3]].every(row => row?.ok === true && row.revision === 1 && row.sha256 === memoHash && row.text === memoText)
  return { accepted: exact && paired && finalText === 'UNIFIED_MEMO_CAS_OK' && nested.length === 4
      && casRejected && outer.length === 1 && !outer[0].isError && finals.length === 5
      && !events.some(event => event.event === 'agent-error' || event.event === 'wall-timeout'),
    finalTextMatched: finalText === 'UNIFIED_MEMO_CAS_OK', toolPairMatched: paired,
    casRejected, nestedToolCount: nested.length, toolFinalCount: finals.length,
    sandboxPartial: results.some(message => message?.content?.some(block => block.type === 'text' && block.text.includes('sandbox enforcement is partial'))) }
}

export function verifyViewProbe(journal, events) {
  const assistants = journal.filter(event => event.type === 'assistant/message').map(event => event.data?.message)
  const calls = assistants.flatMap(message => message?.content?.filter(block => block.type === 'tool-call') ?? [])
  const results = journal.filter(event => event.type === 'tool/result').map(event => event.data?.message)
  const finalText = assistants.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  let exact = false
  try { exact = calls.length === 1 && calls[0].name === 'run_code' && JSON.parse(calls[0].arguments).code === viewCode } catch {}
  const finals = events.filter(event => event.event === 'tool-final')
  const nested = finals.filter(event => event.name === 'context_manage')
  const rows = nested.map(event => {
    try { return JSON.parse(event.content?.filter(block => block.type === 'text').map(block => block.text).join('')) } catch { return null }
  })
  const toolPairMatched = results.length === 1 && results[0]?.toolCallId === calls[0]?.id && results[0]?.isError === false
    && results[0]?.content?.some(block => block.type === 'text' && block.text.split('\n')[0] === scenarios['view-cycle'].marker)
  const viewCycleMatched = rows.length === 10 && nested.every(event => !event.isError)
    && rows.every((row, index) => index === 5 ? row?.ok === false && row.code === 'VIEW_CAS_CONFLICT' : row?.ok === true)
    && rows[0].revision === 1 && rows[0].sha256 === viewHash && typeof rows[1].proposalId === 'string'
    && rows[2].originalHistoryPreserved === true && rows[2].authorityPreserved === true
    && rows[2].entries?.length === 1 && rows[2].entries[0].sourceId === 'lab-view-cycle'
    && rows[3].viewRevision === 0 && rows[4].viewRevision === 1 && rows[4].mode === 'shadow'
    && rows[6].viewRevision === 1 && rows[7].viewRevision === 2 && rows[7].parentRevision === 1
    && rows[8].viewRevision === 2 && rows[8].pins?.length === 0 && rows[8].sources?.length === 1
    && rows[9].text === viewText && rows[9].sha256 === viewHash && rows[9].revision === 1
  const outer = finals.filter(event => event.name === 'run_code')
  const finalTextMatched = finalText === scenarios['view-cycle'].marker
  return { accepted: exact && toolPairMatched && finalTextMatched && viewCycleMatched
      && outer.length === 1 && !outer[0].isError && finals.length === 11
      && !events.some(event => ['agent-error', 'wall-timeout'].includes(event.event)),
    toolPairMatched, finalTextMatched, viewCycleMatched, nestedToolCount: nested.length, toolFinalCount: finals.length,
    sandboxPartial: results.some(message => message?.content?.some(block => block.type === 'text' && block.text.includes('sandbox enforcement is partial'))) }
}

export function verifyWindowShadowProbe(journal, events, collector) {
  const assistants = journal.filter(event => event.type === 'assistant/message').map(event => event.data?.message)
  const calls = assistants.flatMap(message => message?.content?.filter(block => block.type === 'tool-call') ?? [])
  const results = journal.filter(event => event.type === 'tool/result').map(event => event.data?.message)
  const toolPairMatched = calls.length === 2 && results.length === 2 && calls.every((call, index) => {
    let code
    try { code = JSON.parse(call.arguments).code } catch {}
    return call.name === 'run_code' && code === bootstrapCode && results[index]?.toolCallId === call.id && results[index].isError === false
      && results[index].content?.some(block => block.type === 'text' && block.text.split('\n')[0] === scenarios['window-shadow'].marker)
  })
  const finalTextMatched = assistants.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('').trim() === scenarios['window-shadow'].marker
  const completedTurns = journal.filter(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed')
  const finals = events.filter(event => event.event === 'tool-final')
  const audit = collector?.audit ?? []
  const rawPreserved = audit.length === 4 && audit.every(row => row.status === 'shadow' && row.changedMessages === false
    && row.actual.handedToAdapter === true && row.actual.before.sha256 === row.actual.after.sha256
    && row.actual.after.sha256 === row.actual.adapterPayload.sha256)
  const retentionReceipt = collector?.retention?.receipts?.[0]
  const originals = retentionReceipt?.eventRefs?.map(ref => journal.find(event => event.seq === ref.seq)) ?? []
  const exactOriginals = originals.length > 0 && originals.every((event, index) => event && windowHash(event) === retentionReceipt.eventRefs[index].sha256)
    && windowHash(originals) === retentionReceipt.eventsHash && retentionReceipt.retention === 'durable-copy-no-expiry-no-gc'
    && retentionReceipt.id === windowHash({ acl: retentionReceipt.acl, eventRefs: retentionReceipt.eventRefs })
    && retentionReceipt.acl.sessionId === collector?.successor?.checkpoint?.sessionId
  const checkpoint = collector?.successor?.checkpoint
  const { checkpointIntegrityHash, ...checkpointBody } = checkpoint ?? {}
  const checkpointValid = checkpointIntegrityHash && windowHash(checkpointBody) === checkpointIntegrityHash
    && checkpoint.authority?.phaseRefs?.['global:w0']?.status === 'in_progress'
  const retained = collector?.retention?.receipts?.length === 1 && collector?.recovered === true && exactOriginals && checkpointValid
    && collector?.successor?.completedSpanCount === 1 && collector?.successor?.recoveryDebtCount === 0
  return { accepted: toolPairMatched && finalTextMatched && completedTurns.length === 2 && rawPreserved && retained
      && finals.length === 2 && finals.every(row => row.name === 'run_code' && !row.isError)
      && !events.some(row => ['agent-error', 'wall-timeout'].includes(row.event)),
    toolPairMatched, finalTextMatched, completedTurnCount: completedTurns.length, rawPreserved, retained,
    collectorDispatches: audit.length, completedSpanCount: collector?.successor?.completedSpanCount ?? 0, exactOriginals, checkpointValid: !!checkpointValid,
    sandboxPartial: results.some(message => message?.content?.some(block => block.type === 'text' && block.text.includes('sandbox enforcement is partial'))) }
}

export function verifyWindowProjectProbe(journal, events, collector, projected) {
  const base = verifyWindowShadowProbe(journal, events, collector)
  const trial = projected?.trial
  const { certificateHash, ...body } = trial ?? {}
  const binding = trial?.kind === 'isolated-protocol-trial-v1' && trial.providerAccepted === false && trial.productionAuthorized === false
    && certificateHash === windowHash(body) && trial.sessionId === collector?.successor?.checkpoint?.sessionId
  const audit = projected?.audit ?? []
  const reduction = audit.length === 2 && audit.every(row => row.status === 'projected' && row.postSource === 'unchanged'
    && row.actual.handedToAdapter === true && row.actual.payload.bytes === row.estimated.candidateBytes
    && row.estimated.candidateBytes < row.estimated.beforeBytes)
  const original = collector?.audit ?? []
  const actualReduction = original.length === 4 && original.every((row, index) => row.actual.handedToAdapter === true
    && (index < 2 ? row.actual.before.sha256 === row.actual.after.sha256 : row.actual.after.bytes < row.actual.before.bytes)
    && row.actual.after.sha256 === row.actual.adapterPayload.sha256)
  const finals = events.filter(row => row.event === 'tool-final')
  const noErrors = !events.some(row => ['agent-error', 'wall-timeout', 'protocol-replay-degraded', 'runner-failure'].includes(row.event))
  return { ...base, accepted: !!(base.toolPairMatched && base.finalTextMatched && base.completedTurnCount === 2
    && base.retained && binding && reduction && actualReduction && noErrors && finals.length === 2
    && finals.every(row => row.name === 'run_code' && !row.isError)),
    verificationScope: 'isolated-W1-protocol-trial-not-full-recovery-quality-AB', protocolTrialBound: !!binding,
    projectedDispatches: audit.length, boundedReduction: reduction && actualReduction, replayDegraded: !noErrors }
}

export function verifyWindowRecallProbe(journal, events, target, projected, {baseline=false,qualityOracle=false,collector,historyLedger,nativeEvidence}={}) {
  const native=!!nativeEvidence,last=native?2:1
  const assistants = journal.filter(event => event.type === 'assistant/message').map(event => event.data?.message)
  const calls = assistants.flatMap(message => message?.content?.filter(block => block.type === 'tool-call') ?? [])
  const results = journal.filter(event => event.type === 'tool/result').map(event => event.data?.message)
  const paired = calls.length === last+1 && results.length === last+1 && calls.every((call, i) => {
    let code
    try { code = JSON.parse(call.arguments).code } catch {}
    return call.name === 'run_code' && code === (i === 0 ? qualityArchiveCode : i===last ? historyQualityCode(target.seq) : bootstrapCode)
      && results[i]?.toolCallId === call.id && results[i].isError === false
  })
  let value
  try { value = JSON.parse(results[last].content.filter(block => block.type === 'text').map(block => block.text).join('').split('\n')[0]) } catch {}
  const exact = verifyHistoryQualityResult(value, target)
  const delivered = events.filter(row => row.event === 'history-quality-result-handed')
  const handed = delivered.length === 1 && delivered[0].sourceHash === sha(JSON.stringify(target))
    && delivered[0].artifactHash === value?.descriptor?.sourceRef?.artifactHash && delivered[0].toolCallId === calls[last]?.id
  const assembled = value?.kind === 'history-raw-artifact-v1'
  let artifactReceiptVerified = false, matchingDebtResolved = false
  if (assembled) try {
    const d = value.descriptor, candidate = historyLedger.returnedArtifacts[value.deliveryCandidate.id]
    const progress = historyLedger.reads[d.locator], receipt = progress.artifactDeliveryReceipt
    const debts = Object.values(historyLedger.debts).filter(row=>row.readerSessionId===d.readerSessionId
      && (row.id==='history-debt-'+d.locator || row.sourceRef.locator===d.locator
        && row.sourceRef.sourceHash===d.sourceRef.sourceHash && row.sourceRef.artifactHash===d.sourceRef.artifactHash))
    artifactReceiptVerified = JSON.stringify(historyLedger.descriptors[d.locator])===JSON.stringify(d)
      && candidate.status==='handed-to-adapter' && candidate.rootCallId===calls[last].id
      && candidate.callId===value.deliveryCandidate.callId && candidate.callId!==candidate.rootCallId
      && candidate.exactOutputHash===sha(JSON.stringify(value)) && candidate.requestId===delivered[0].requestId
      && JSON.stringify(candidate.sourceRef)===JSON.stringify(d.sourceRef)
      && receipt.status==='full-artifact-dispatched' && receipt.callId===calls[last].id
      && receipt.assemblyCallId===candidate.callId && receipt.requestId===candidate.requestId
      && receipt.readerSessionId===d.readerSessionId && receipt.bytes===d.bytes && receipt.pageCount===d.pages
      && receipt.modelUnderstanding==='unknown' && JSON.stringify(receipt.sourceRef)===JSON.stringify(d.sourceRef)
      && !progress.modelDeliveryReceipt && !progress.handedPages
      && value.pageHashes.every((hash,i)=>progress.pageHashes[i*d.pageBytes]===hash)
    matchingDebtResolved = debts.length>0 && debts.every(row=>row.status==='resolved')
  } catch {}
  const finalText = assistants.at(-1)?.content?.filter(block => block.type === 'text').map(block => block.text).join('').trim()
  const completed = journal.filter(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed').length
  const {certificateHash,...body} = projected?.trial ?? {}
  const trialBound = certificateHash === windowHash(body) && body.sessionId === value?.descriptor?.readerSessionId
    && body.sessionId === value?.descriptor?.sourceRef?.sessionId && body.providerAccepted === false && body.productionAuthorized === false
  const audit = projected?.audit ?? []
  const originallyProjected = native ? audit.length===0 : baseline ? audit.length === 0
    : audit.length === 2 && audit[0].status === 'projected' && audit[0].actual.handedToAdapter === true
  const qualityMatched = qualityOracle ? verifyQualityAnswer(finalText,target)
    : finalText === 'UNIFIED_HISTORY_QUALITY_OK remaining=4 constraint=preserve-pending-input'
  const noErrors = !events.some(row => ['agent-error','wall-timeout','protocol-replay-degraded','runner-failure','lab-pre-step-rejected'].includes(row.event))
  let originalsPreserved = false, taskStillInProgress = false
  try {
    const receipt = collector.retention.receipts[0], refs = receipt.eventRefs
    const originalEvents = refs.map(ref=>journal.find(event=>event.seq===ref.seq))
    const {checkpointIntegrityHash,...body} = collector.successor.checkpoint
    originalsPreserved = collector.recovered === true && collector.retention.receipts.length === 1
      && receipt.acl.sessionId === body.sessionId && refs.length > 1
      && refs.every((ref,i)=>originalEvents[i] && windowHash(originalEvents[i])===ref.sha256
        && (!i || ref.seq===refs[i-1].seq+1))
      && receipt.id === windowHash({acl:receipt.acl,eventRefs:refs}) && receipt.eventsHash === windowHash(originalEvents)
      && originalEvents[0].type==='turn/start' && originalEvents.at(-1).type==='turn/end'
      && originalEvents.at(-1).data.reason.kind==='completed'
      && windowHash(originalEvents.find(event=>event.seq===target.seq)) === windowHash(target)
      && checkpointIntegrityHash === windowHash(body)
    taskStillInProgress = body.authority.phaseRefs['global:w0'].status === 'in_progress'
  } catch {}
  let nativeVerified=!native
  if(native)try {
    const n=nativeEvidence,c=n.receipt,commit=n.committedJournal[c.commitSeq],intent=n.committedJournal.find(row=>row.type==='native/window-intent')
    const retainedTarget=n.beforeSurface.find(row=>row.toolCallId===target.data.message.toolCallId)
    const nativeCheckpoint=n.afterSurface.find(row=>row.source?.nativeWindowCheckpoint)
    const current=n.authorityReceipts
    nativeVerified=c.state==='COMMITTED' && c.durable===true && c.sessionId===body.sessionId && c.toWindowId===1
      && windowHash(commit.data.source.windowCommit)===windowHash(Object.fromEntries(Object.entries(c).filter(([key])=>!['state','durable','commitSeq','commitAuthority'].includes(key))))
      && c.intentHash===intent.data.integrityHash && c.checkpointHash===windowHash(intent.data.proposal.checkpoint)
      && windowHash(n.committedJournal.slice(0,n.beforeJournal.length))===windowHash(n.beforeJournal)
      && windowHash(n.durableCommittedJournal)===windowHash(n.committedJournal)
      && windowHash(n.durableFinalJournal)===windowHash(journal)
      && windowHash(journal.slice(0,n.committedJournal.length))===windowHash(n.committedJournal)
      && n.retention.receipts.length===2 && n.retention.receipts.every(receipt=>receipt.eventRefs.every(ref=>windowHash(journal[ref.seq])===ref.sha256))
      && retainedTarget && !n.afterSurface.some(row=>row.id===retainedTarget.id)
      && nativeCheckpoint?.source.authorityMode==='historical-snapshot-current-authority-required'
      && Buffer.byteLength(JSON.stringify(n.afterSurface))<Buffer.byteLength(JSON.stringify(n.beforeSurface))
      && current.length===2 && current.every(row=>row.handedToAdapter===true && row.body.kind==='current-server-window-authority'
        && row.body.authoritative===true && row.body.checkpoint.criticalRevisionVector.controlRevision>=n.currentRevision
        && row.body.checkpoint.checkpointIntegrityHash===windowHash(Object.fromEntries(Object.entries(row.body.checkpoint).filter(([key])=>key!=='checkpointIntegrityHash'))))
      && n.currentRevision>intent.data.proposal.checkpoint.criticalRevisionVector.controlRevision && n.protocolTrial.nativeSurface===true
      && windowHash(n.protocolTrial)===windowHash(projected.trial)
  } catch {nativeVerified=false}
  return { accepted: !!(paired && exact && handed && completed === (native?3:2) && originallyProjected && trialBound && noErrors
    && qualityMatched && originalsPreserved && taskStillInProgress && nativeVerified && (!assembled || artifactReceiptVerified && matchingDebtResolved)),
    verificationScope: native ? 'isolated-native-W2-surface-with-exact-SDK-recovery-not-full-Team-AB' : qualityOracle ? 'isolated-SDK-exact-recovery-quality-single-AB-case' : 'isolated-SDK-full-artifact-recovery-trial-not-whole-AB', exactArtifactMatched: exact,
    artifactHandedToAdapter: handed, toolPairMatched: paired, completedTurnCount: completed,
    finalConstraintMatched: qualityMatched, qualityOracle, baseline, originalsPreserved, taskStillInProgress,
    initialRequestProjected: !native && !baseline && originallyProjected, finalProjectionStatus: audit[1]?.status ?? null,
    finalProjectionBlockedReason: audit[1]?.blockedReason ?? null, canonicalPageDeliveryClaimed: false,
    serverAssembledArtifact: assembled, artifactReceiptVerified, matchingDebtResolved,nativeSurfaceVerified:native?nativeVerified:null }
}

export function createLabAdmission(sessionId, { run = true, scenario = 'static', limits } = {}) {
  if (!Object.hasOwn(scenarios, scenario)) fail('LAB_SCENARIO_INVALID')
  let admittedRequests = 0
  const payloads = []
  const proposalIds = new Set()
  const trustedProposalCalls = new WeakSet()
  let qualityGuard
  const activeLimits=limits ?? (scenario==='window-native'?nativeLabLimits:labLimits)
  return Object.freeze({
    admit(options) {
      if (!run) fail('LAB_BOOTSTRAP_NO_SAMPLING')
      if (options.sessionId !== sessionId) fail('LAB_FOREIGN_SESSION')
      if (options.provider !== route.provider || options.model !== route.model) fail('LAB_FOREIGN_ROUTE')
      if (options.maxTokens !== labLimits.maxOutputTokens) fail('LAB_OUTPUT_LIMIT')
      const encoded = JSON.stringify(options.messages), bytes = Buffer.byteLength(encoded)
      if (bytes > activeLimits.maxPayloadBytes) fail('LAB_PAYLOAD_LIMIT')
      if (admittedRequests >= activeLimits.maxRequests) fail('LAB_REQUEST_LIMIT')
      payloads.push({ bytes, sha256: sha(encoded) })
      admittedRequests++
    },
    tool(exec) {
      const actor = exec?.agent, name = exec?.name ?? exec?.tool?.name
      const mine = actor?.id === sessionId && actor?.session?.id === sessionId
      const args = exec?.arguments
      if (name === 'run_code' && (!args || Object.keys(args).some(key => !['code','description'].includes(key)))) {
        return {kind:'deny',reason:'LAB_STATIC_PROBE_ONLY'}
      }
      const code = scenarios[scenario].code
      const memoGet = { action: 'memo_get', input: { sourceId: 'lab-memo-cas', revision: 1, sha256: memoHash } }
      const puts = [memoText, 'STALE MUST NOT COMMIT'].map(text => ({ action: 'memo_put', input: {
        sourceId: 'lab-memo-cas', expectedRevision: 0, scope: 'member', text } }))
      const equivalent = (left, right) => left && Object.keys(left).length === Object.keys(right).length
        && Object.keys(right).every(key => typeof right[key] === 'object' ? equivalent(left[key], right[key]) : left[key] === right[key])
      const allowed = mine && (qualityGuard?.allow(exec) === true || name === 'run_code' && args?.code?.trim() === code
        || scenario==='window-native' && name==='run_code' && args?.code?.trim()===bootstrapCode
        || scenario === 'memo-cas' && name === 'context_manage' && [memoGet, ...puts].some(expected => equivalent(args, expected))
        || scenario === 'view-cycle' && name === 'context_manage' && [
          { action: 'memo_put', input: { sourceId: 'lab-view-cycle', expectedRevision: 0, scope: 'member', text: viewText } },
          ...['propose', 'preview'].map(action => ({ action, input: { expectedRevision: 0, operations: [viewOperation] } })),
          { action: 'state', input: {} },
          { action: 'rollback', input: { expectedRevision: 1, targetRevision: 0 } },
          { action: 'memo_get', input: { sourceId: 'lab-view-cycle', revision: 1, sha256: viewHash } },
          ...[...proposalIds].map(proposalId => ({ action: 'commit', input: { expectedRevision: 0, proposalId } })),
        ].some(expected => equivalent(args, expected)))
      if (allowed && scenario === 'view-cycle' && name === 'context_manage' && args.action === 'propose') trustedProposalCalls.add(exec)
      return allowed ? { kind: 'allow' } : { kind: 'deny', reason: 'LAB_STATIC_PROBE_ONLY' }
    },
    observe(exec, result) {
      qualityGuard?.observe(exec, result)
      if (!trustedProposalCalls.has(exec) || result?.isError) return
      trustedProposalCalls.delete(exec)
      let row
      try { row = JSON.parse(result?.content?.filter(block => block.type === 'text').map(block => block.text).join('')) } catch { return }
      if (row?.ok === true && row.expectedRevision === 0 && typeof row.proposalId === 'string') proposalIds.add(row.proposalId)
    },
    snapshot: () => ({ admittedRequests, payloads: structuredClone(payloads), providerTokens: null,
      tokenMeasurement: 'payload byte guard is not a provider-token estimate', limits: activeLimits }),
    configureHistoryQuality(seq) {
      if (!['window-recall','window-native'].includes(scenario) || qualityGuard) fail('LAB_HISTORY_QUALITY_CONFIG_INVALID')
      qualityGuard = createHistoryQualityGuard(sessionId, seq)
      return qualityGuard.code
    },
  })
}

async function assertPortFree(port) {
  const server = createServer()
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok) })
  await new Promise((ok, no) => server.close(error => error ? no(error) : ok()))
}

export function installLabToolAdmission(ctx, admission) {
  return ctx.tools.guard(exec => {
    const verdict = admission.tool(exec)
    return verdict.kind === 'allow' ? undefined : verdict.reason ?? 'LAB_STATIC_PROBE_ONLY'
  })
}

async function child(run, output, scenario, baseline, qualityOracle, contextTokens = null) {
  if (process.env.DSH_HOME !== home || process.env.DSH_LAB_CANONICAL_MODULES !== '1') fail('LAB_ENVIRONMENT_REQUIRED')
  const prep = JSON.parse(readFileSync(join(home, 'preparation-evidence.json'), 'utf8'))
  if (!prep.prepared || prep.labHome !== home || prep.route?.api !== 'openai-responses') fail('LAB_PREPARATION_REQUIRED')
  if (sha(readFileSync(join(home, 'dump-config.yaml'))) !== prep.dumpSha256) fail('LAB_PREPARATION_DRIFT')
  await assertPortFree(40124)
  const load = name => import('@deepseek-ai/' + name)
  const { runProfile } = await import('../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js')
  const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment')
  const { getHostLifecycleGate } = await load('cordis')
  const { controlPlaneForMember } = await import('../home/profiles/web/plugins/team-control-plane.mjs')
  const { captureLoadedPtcBinding } = await import('./capture-lab-ptc-binding.mjs')
  const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n')
  const events = []
  const record = value => { events.push(value); appendFileSync(join(output, 'runtime-events.jsonl'), JSON.stringify(value) + '\n') }
  const sessionId = randomUUID(), cwd = join(output, 'workspace')
  mkdirSync(cwd)
  const native=scenario==='window-native',recall=native||scenario==='window-recall'
  const contextApi = contextTokens === null ? null : await import('./native-compaction-natural-lab.mjs')
  const limits = labContextLimits(native?nativeLabLimits:labLimits, contextTokens, contextApi?.contextLimits)
  const contextFiller = contextApi === null ? null : contextApi.generateContextFiller(contextTokens)
  const admission = createLabAdmission(sessionId, { run, scenario, limits })
  let ctx, agent, timer, windowCollector, windowProjection, restoreReplayGuard, protocolTrial, qualityTarget, stopQualityObserver,nativeSurface,nativeEvidence
  const authorityReceipts=[],nativeRoutes=[]
  const summary = { version: 1, runId: sessionId, output, route, limits, mode: run ? 'static-natural-probe' : 'bootstrap-no-sampling',
    scenario, baseline, qualityOracle, startedAt: new Date().toISOString(), accepted: false, samplingStarted: false, productionWrites: false }
  if (contextFiller) Object.assign(summary, { contextTokens, contextFillerChars: contextFiller.chars,
    contextFillerTargetChars: contextFiller.targetChars })
  save('run-manifest.json', summary)
  try {
    record({ event: 'host-boot-start' })
    const patchFiles=[]
    if(native) {
      const yaml=require('js-yaml'),schema=yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:value=>value})])
      const patch=nativeIsolationPatch(yaml.load(readFileSync(join(home,'dump-config.yaml'),'utf8'),{schema}),sessionId)
      const path=join(output,'exact-native-window.patch.json')
      save('exact-native-window.patch.json',patch);patchFiles.push(path)
    }
    const host = await runProfile({ environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: process.env }]),
      profile: 'web', patchFiles, args: ['--no-open', '--port', '40124'] })
    ctx = host.ctx
    record({ event: 'host-boot-settled' })
    const gate = getHostLifecycleGate(ctx)
    await gate.observeSettlement(() => gate.runAsync(async () => {
      ctx.on('llm/stream', (options, next) => { admission.admit(options); record({ event: 'request-admitted', ...admission.snapshot() }); return next() }, { global: true })
      installLabToolAdmission(ctx, admission)
      ctx.on('tools/result', (exec, result) => { admission.observe(exec, result); record({ event: 'tool-final', sessionId: exec?.agent?.session?.id,
        callId: exec?.callId, name: exec?.name ?? exec?.tool?.name, isError: result?.isError === true,
        resultHash: sha(JSON.stringify(result)), content: result?.content, structuredContent: result?.structuredContent }) }, { global: true })
      ctx.on('agent/error', event => record({ event: 'agent-error', code: event?.error?.code ?? event?.error?.info?.code ?? event?.error?.name ?? 'unknown' }), { global: true })
      ctx.on('agent/pre-step', async (_event, next) => {
        const decision = await next()
        if (decision?.kind === 'reject') record({ event: 'lab-pre-step-rejected', reason: String(decision.reason ?? 'unknown').slice(0, 900) })
        return decision
      }, { global: true })
      const composition = await ctx.sessionController.agents.composeAgent('ptc')
      record({ event: 'preset-composed' })
      const published = await ctx.agents.create({ sessionId, agentOptions: { ...route, maxTokens: labLimits.maxOutputTokens },
        meta: { cwd, agentPreset: composition.agentPreset }, setup: async (agentCtx, currentAgent) => {
          record({ event: 'agent-setup-start' })
          await composition.setup(agentCtx, currentAgent)
          record({ event: 'agent-setup-settled' })
        } })
      agent = published.agent
      record({ event: 'agent-published' })
    }))
    record({ event: 'agent-install-settled' })
    await ctx.sessionController.selectModel({ sessionId, ...route })
    if (!await ctx.sessions.flush(agent.session)) fail('LAB_SESSION_FLUSH_FAILED')
    const cp = controlPlaneForMember(ctx, agent, { directory: join(home, 'team-control-plane') })
    if (!cp) fail('LAB_TEAM_ROOT_REQUIRED')
    await cp.flush()
    const current = cp.snapshot({ history: false, copy: true })
    const proposal = ctx.teamIdentityRuntime.proposal(agent)
    const activation = await ctx.teamIdentityRuntime.activate(agent, { expectedControlRevision: current.revision,
      expectedIdentityEpoch: current.identityEpoch ?? 0, expectedBundleHash: proposal.contentHash })
    const identity = ctx.teamIdentityRuntime.status(agent)
    save('identity-activation.json', { proposal, activation, identity, teamRootId: current.rootId })
    const binding = captureLoadedPtcBinding(ctx, agent, { expectedRoute: route, expectedSessionId: sessionId })
    save('loaded-ptc-binding.json', binding)
    const denied = await ctx.tools.prepareScheduledExecution({name:'run_code',
      arguments:{code:'return "UNAUTHORIZED_LAB_CANARY";',description:'Safe negative admission canary'},
      agent,callId:randomUUID(),signal:new AbortController().signal})
    if (denied.kind !== 'post-result' || denied.result.isError !== true
      || !JSON.stringify(denied.result).includes('LAB_STATIC_PROBE_ONLY')) fail('LAB_TOOL_ADMISSION_NOT_ENFORCED')
    save('tool-admission-proof.json',{kind:'actual-native-PTC-predispatch-denial',providerRequests:0,
      sessionId,preparedKind:denied.kind,isError:denied.result.isError,bodyAdmitted:false})
    save('runtime-services.json', { contextWorkspace: ctx.contextWorkspace.runtimeReceipt(agent),
      windowEconomics: ctx.windowEconomics.stats(), identity, host: gate.snapshot(), resolutions: globalThis.labModuleResolutions })
    summary.loaded = { sdkSha256: binding.sdkSha256, schemaCount: binding.schemaCount, identityEpoch: identity.epoch, identityHash: identity.contentHash }
    if (['window-shadow', 'window-project', 'window-recall','window-native'].includes(scenario)) {
      if (scenario === 'window-project' || recall) {
        const { createProtocolTrialEvidence, installReplayTrialGuard } = await import('./window-protocol-trial.mjs')
        protocolTrial = createProtocolTrialEvidence(binding, sessionId,Date.now(),{nativeSurface:native})
        save('protocol-trial.json', protocolTrial)
        await gate.observeSettlement(() => gate.runAsync(() => {
          restoreReplayGuard = installReplayTrialGuard(ctx.llm.registration(route.provider).adapter, record)
        }))
      }
      const { createPlanRegistry } = await import('../home/profiles/web/plugins/team-v15-plan-registry.mjs')
      const { readControlPlaneSnapshot } = await import('../home/profiles/web/plugins/team-control-plane.mjs')
      const { apply: installCollector } = await import('../home/profiles/web/plugins/team-v15-window-collector.mjs')
      const planPath = join(cwd, 'plan.json'), planId = 'natural-window-shadow'
      const body = JSON.stringify({ kind: 'dsh-plan-contract', version: 1, planId, scope: ['probe-only'],
        items: [{ requirementId: 'w0-raw-preservation', taskRefs: [{ boardId: 'global', taskId: 'w0' }], requiredDimensions: ['accepted'] }] }, null, 2)
      writeFileSync(planPath, body)
      await cp.mutateHot('lab/w0-authority-fixture', {}, agent, state => {
        state.boards.global = { tasks: { w0: { id: 'w0', ownerName: ctx.agentTeams.tryMembership(agent).name,
          revision: 1, status: 'in_progress', phase: 'execution', contract: { contractRevision: 1 } } } }
        state.v14Waiting = { tickets: {} }
      }, { deferMs: 0 })
      const registry = createPlanRegistry({ control: cp, readDurable: () => readControlPlaneSnapshot(cp.file), allowedRoots: [output], authorize: () => true })
      await registry.register({ planId, expectedPlanRevision: 0, ref: { path: planPath, sha256: sha(body) } }, agent)
      const milestone = ctx.get('stepCompactionRuntime')?.runtimeFacts()
      const milestonePath = join(home, 'team-milestones.json')
      if (!milestone?.loaded || resolve(milestone.configuredPath) !== resolve(milestonePath)) fail('LAB_W0_MILESTONE_WRITER_REQUIRED')
      if (!existsSync(milestonePath)) {
        const empty = JSON.stringify({ version: 3, teams: {} }, null, 2) + '\n'
        writeFileSync(milestonePath, empty, { flag: 'wx' })
        record({ event: 'isolated-empty-milestone-source-initialized', sha256: sha(empty), scope: 'lab-home-only-no-completion-records' })
      }
      await gate.observeSettlement(() => gate.runAsync(() => installCollector(ctx, { enabled: true, isolated: true,
        sessionIds: [sessionId], planBindings: { [sessionId]: planId }, allowedRoots: [output, home],
        recoveryDirectory: join(output, 'window-recovery'), controlDirectory: join(home, 'team-control-plane'), recentMessages: 1,
        ...(protocolTrial ? { protocolCertificateHash: protocolTrial.certificateHash } : {}) })))
      windowCollector = ctx.windowCheckpointRuntime
      save('window-collector-loaded.json', windowCollector.runtimeFacts())
      record({ event: 'window-collector-installed', mode: 'W0', providerRequests: 0 })
      if (recall) stopQualityObserver = ctx.requestMessageProjection.register('lab-exact-quality-observer',
        options => ({messages:options.messages}), {order:1200, onDispatch({options,inputOptions,receipt}) {
          if (!qualityTarget || receipt.handedToAdapter !== true || options.sessionId !== sessionId
            || !ctx.requestMessageProjection.isAgentLoopRequest(inputOptions)) return
          if(native)for(const message of options.messages.filter(row=>row.source?.nativeWindowAuthority)) {
            const body=JSON.parse(message.content[0].text)
            authorityReceipts.push({requestId:receipt.requestId,handedToAdapter:true,body})
          }
          for (const message of options.messages.filter(row => row.role === 'tool' && !row.isError)) {
            let value
            try { value = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('').split('\n')[0]) } catch {continue}
            if (!verifyHistoryQualityResult(value,qualityTarget)) continue
            record({event:'history-quality-result-handed',requestId:receipt.requestId,toolCallId:message.toolCallId,
              sourceHash:sha(JSON.stringify(qualityTarget)),artifactHash:value.descriptor.sourceRef.artifactHash})
          }
        } })
      if(native) {
        const facts=ctx.teamWindowRuntime.facts(agent)
        if(facts.exactIsolatedOptIn!==true)fail('LAB_NATIVE_EXACT_OPTIN_NOT_LOADED')
        const {createServerWindowSurface}=await import('../home/profiles/web/plugins/team-v15-window-surface.mjs')
        const {proveCompletedReasoningSpan}=await import('../home/profiles/web/plugins/team-v15-window-protocol.mjs')
        nativeSurface=await createServerWindowSurface(ctx,{collector:windowCollector,sessionId,proveReasoningSpan:proveCompletedReasoningSpan,
          routes:nativeRoutes})
        save('native-runtime-optin.json',{facts,surfaceStatus:nativeSurface.status(),providerRequests:0,commitAttempted:false})
      }
    }
    if (contextFiller) {
      const historyText = buildWindowHistory(scenario, native, contextFiller)
      const promptText = buildFirstPrompt(scenario, native, contextFiller)
      save('context-filler-evidence.json', { contextTokens, targetChars: contextFiller.targetChars, chars: contextFiller.chars,
        messageCount: contextFiller.messages.length, historyChars: historyText.length, promptChars: promptText.length,
        promptBytes: Buffer.byteLength(promptText), maxPayloadBytes: limits.maxPayloadBytes,
        payloadFitsAdmission: Buffer.byteLength(JSON.stringify([{ role: 'user', content: [{ type: 'text', text: promptText }] }])) <= limits.maxPayloadBytes,
        providerRequests: 0 })
    }
    if (run) {
      const { marker } = scenarios[scenario]
      const prompt = buildFirstPrompt(scenario, native, contextFiller)
      summary.promptSha256 = sha(prompt)
      save('prompt.json', { prompt, sha256: summary.promptSha256 })
      timer = setTimeout(() => { record({ event: 'wall-timeout' }); agent.cancel({ kind: 'user', reason: 'isolated-lab-wall-budget' }, { keepInbox: true }) }, limits.maxWallMs)
      summary.samplingStarted = true
      await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), content: [{ type: 'text', text: prompt }], mode: 'followup' }, new AbortController().signal)
      await agent.whenIdle()
      if (windowCollector) {
        const first = windowCollector.readSnapshot(sessionId)
        if (!first?.checkpoint) fail('LAB_FIRST_WINDOW_CHECKPOINT_MISSING')
        save('window-first-snapshot.json', first)
        const retention = await windowCollector.retainCompletedTurns(sessionId)
        const recovered = retention.receipts.length === 1 && windowCollector.readRecovery(sessionId, retention.receipts[0])
          .some(event => event.type === 'turn/end' && event.data?.reason?.kind === 'completed')
        if (protocolTrial && !baseline && !native) {
          const { installWindowProjection } = await import('../home/profiles/web/plugins/team-v15-window-projection.mjs')
          const { proveCompletedReasoningSpan } = await import('../home/profiles/web/plugins/team-v15-window-protocol.mjs')
          windowProjection = installWindowProjection({ projection: ctx.requestMessageProjection, llm: ctx.llm,
            authorityFor: windowCollector.authorityFor, proveReasoningSpan: proveCompletedReasoningSpan,
            mode: 'W1', sessions: [sessionId], routes: [{ ...route, protocol: 'deepseek-dsh-v1',
              certificateHash: protocolTrial.certificateHash, configFingerprint: first.checkpoint.configFingerprint,
              expiresAt: protocolTrial.expiresAt, reasoningPolicy: protocolTrial.reasoningPolicy }] })
          record({ event: 'isolated-window-trial-installed', mode: 'W1', productionAuthorized: false, providerAccepted: false })
        }
        let successorCode = bootstrapCode
        let successorMarker = marker
        if (recall) {
          const target = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
            && event.data?.message?.isError === false
            && event.data?.message?.content?.some(block => block.type === 'text' && matchesQualityArchive(block.text)))
          if (!target) fail('LAB_HISTORY_ARCHIVE_TARGET_MISSING')
          qualityTarget = target
          successorCode = admission.configureHistoryQuality(target.seq)
          successorMarker = 'UNIFIED_HISTORY_QUALITY_OK remaining=4 constraint=preserve-pending-input'
          save('history-quality-target.json', target)
        }
        if(native) {
          const secondPrompt=`Invoke run_code exactly once with this exact code and a short description:\n${bootstrapCode}\nDo not invoke any other tool. After it succeeds answer only UNIFIED_PTC_BOOTSTRAP_OK. The authoritative task remains in progress.`
          save('native-second-prompt.json',{prompt:secondPrompt,sha256:sha(secondPrompt)})
          await ctx.sessionController.prompt({sessionId,requestId:randomUUID(),content:[{type:'text',text:secondPrompt}],mode:'followup'},new AbortController().signal)
          await agent.whenIdle()
          const retained=await windowCollector.retainCompletedTurns(sessionId)
          const beforeJournal=agent.session.snapshotEvents(),beforeSurface=agent.session.deriveMessages()
          const source=windowCollector.authorityForSurface(sessionId).capture(sessionId).source
          nativeRoutes.push(Object.freeze({...route,protocol:'deepseek-dsh-v1',certificateHash:protocolTrial.certificateHash,
            configFingerprint:source.configFingerprint,expiresAt:protocolTrial.expiresAt,reasoningPolicy:protocolTrial.reasoningPolicy}))
          const receipt=await nativeSurface.commit(),committedJournal=agent.session.snapshotEvents(),afterSurface=agent.session.deriveMessages()
          const barrier=await ctx.sessionPersistence.windowBarrierFor(agent.session,{isolated:true,sessionId})
          const durableCommittedJournal=await barrier.read()
          await cp.mutateHot('lab/native-current-authority-proof',{},agent,state=>{state.labNativeWindowProof={historicalCheckpointNotCurrent:true}},{deferMs:0})
          const currentRevision=cp.windowSnapshot().revision
          nativeEvidence={receipt,beforeJournal,committedJournal,durableCommittedJournal,beforeSurface,afterSurface,
            retention:retained,currentRevision,protocolTrial,authorityReceipts}
          save('native-window-evidence.json',nativeEvidence)
          record({event:'native-window-committed',transitionId:receipt.transitionId,toWindowId:receipt.toWindowId,durable:receipt.durable})
        }
        const successorPrompt = `The authoritative task remains in progress. Invoke run_code exactly once with the following exact code and a short description:\n${successorCode}\nOnly the history_recall calls contained in this exact code are authorized. ${qualityOracle || native ? qualityAnswerInstruction : 'Read the returned original artifact and its midpoint correction and tail constraint; after it succeeds answer only '+successorMarker+'.'} Do not modify files or use any other SDK.`
        save('successor-prompt.json', { prompt: successorPrompt, sha256: sha(successorPrompt) })
        await ctx.sessionController.prompt({ sessionId, requestId: randomUUID(), content: [{ type: 'text', text: successorPrompt }], mode: 'followup' }, new AbortController().signal)
        await agent.whenIdle()
        await ctx.teamWindowRuntime.drainHistoryDispatch(agent)
        if(native) {
          const barrier=await ctx.sessionPersistence.windowBarrierFor(agent.session,{isolated:true,sessionId})
          await barrier.persist();nativeEvidence.durableFinalJournal=await barrier.read()
          save('native-window-evidence.json',nativeEvidence)
        }
        save('window-shadow-evidence.json', { first, retention, recovered, successor: windowCollector.readSnapshot(sessionId), audit: windowCollector.audit() })
        if (protocolTrial) save('window-project-evidence.json', { trial: protocolTrial, audit: windowProjection?.audit() ?? [] })
      }
      clearTimeout(timer)
      if (!await ctx.sessions.flush(agent.session)) fail('LAB_FINAL_FLUSH_FAILED')
      const economics = ctx.windowEconomics.readSnapshot(agent)
      if (recall) save('history-quality-ledger.json', cp.windowSnapshot().v15HistoryRecall)
      save('usage-root-only.json', { scope: { rootSessionId: sessionId, descendantSessionIds: [], descendantsForbidden: true }, economics })
      const journal = agent.session.snapshotEvents()
      save('canonical-journal.json', journal)
      Object.assign(summary, recall ? verifyWindowRecallProbe(journal, events,
        JSON.parse(readFileSync(join(output, 'history-quality-target.json'), 'utf8')), JSON.parse(readFileSync(join(output, 'window-project-evidence.json'), 'utf8')),
        {baseline,qualityOracle:qualityOracle||native,nativeEvidence,collector:JSON.parse(readFileSync(join(output,'window-shadow-evidence.json'),'utf8')),
          historyLedger:JSON.parse(readFileSync(join(output,'history-quality-ledger.json'),'utf8'))})
        : scenario === 'window-project' ? verifyWindowProjectProbe(journal, events,
        JSON.parse(readFileSync(join(output, 'window-shadow-evidence.json'), 'utf8')), JSON.parse(readFileSync(join(output, 'window-project-evidence.json'), 'utf8')))
        : scenario === 'window-shadow' ? verifyWindowShadowProbe(journal, events, JSON.parse(readFileSync(join(output, 'window-shadow-evidence.json'), 'utf8')))
        : scenario === 'view-cycle' ? verifyViewProbe(journal, events)
        : scenario === 'memo-cas' ? verifyMemoProbe(journal, events) : verifyNaturalProbe(journal, events))
      if (!summary.accepted) fail('LAB_NATURAL_PROBE_NOT_ACCEPTED')
    } else summary.accepted = admission.snapshot().admittedRequests === 0
  } catch (error) {
    summary.error = { code: error?.code ?? error?.name ?? 'unknown', stack: String(error?.stack ?? '').slice(0, 2500) }
    record({ event: 'runner-failure', ...summary.error })
    throw error
  } finally {
    clearTimeout(timer)
    summary.admission = admission.snapshot()
    if (ctx) {
      if (agent && summary.samplingStarted) {
        try {
          await ctx.sessions.flush(agent.session)
          save('canonical-journal.json', agent.session.snapshotEvents())
          save('usage-root-only.json', { scope: { rootSessionId: sessionId, descendantSessionIds: [], descendantsForbidden: true }, economics: ctx.windowEconomics.readSnapshot(agent) })
          if (windowCollector) save('window-collector-final-audit.json', windowCollector.audit())
          if (windowProjection) save('window-project-final-audit.json', { trial: protocolTrial, audit: windowProjection.audit() })
        } catch (error) { record({ event: 'failure-evidence-save-error', code: error?.code ?? error?.name ?? 'unknown' }) }
      }
      windowProjection?.dispose()
      stopQualityObserver?.()
      restoreReplayGuard?.()
      await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(() => ctx.fiber.dispose()))
      summary.hostDisposed = true
    }
    summary.finishedAt = new Date().toISOString()
    save('result.json', summary)
  }
  console.log(JSON.stringify(summary))
}

async function main() {
  const run = process.argv.includes('--run')
  const scenarioIndex = process.argv.indexOf('--scenario')
  const scenario = scenarioIndex < 0 ? 'static' : process.argv[scenarioIndex + 1]
  if (!Object.hasOwn(scenarios, scenario)) fail('LAB_SCENARIO_INVALID')
  const baseline = process.argv.includes('--baseline'), qualityOracle = process.argv.includes('--quality-oracle')
  if ((baseline || qualityOracle) && scenario !== 'window-recall') fail('LAB_QUALITY_SCENARIO_REQUIRED')
  const contextAt = process.argv.indexOf('--context-tokens')
  if (contextAt >= 0 && scenario !== 'window-native') fail('LAB_CONTEXT_TOKENS_SCENARIO')
  const contextTokens = contextAt < 0 ? null : Number(process.argv[contextAt + 1])
  const contextApi = contextTokens === null ? null : await import('./native-compaction-natural-lab.mjs')
  labContextLimits(scenario === 'window-native' ? nativeLabLimits : labLimits, contextTokens, contextApi?.contextLimits)
  const outputArg = process.argv.indexOf('--output')
  if (outputArg < 0 || !process.argv[outputArg + 1]) fail('LAB_OUTPUT_REQUIRED')
  const output = resolve(process.argv[outputArg + 1])
  if (!output.startsWith(join(stage, 'lab-runs') + '\\') && !output.startsWith(join(stage, 'lab-runs') + '/')) fail('LAB_OUTPUT_OUTSIDE_STAGE')
  if (process.argv.includes('--verify')) {
    const rawJournal = readFileSync(join(output, 'canonical-journal.json'), 'utf8')
    const rawEvents = readFileSync(join(output, 'runtime-events.jsonl'), 'utf8')
    const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'))
    const usage = JSON.parse(readFileSync(join(output, 'usage-root-only.json'), 'utf8'))
    const recall=['window-recall','window-native'].includes(result.scenario),native=result.scenario==='window-native'
    const verify = recall ? verifyWindowRecallProbe : result.scenario === 'window-project' ? verifyWindowProjectProbe : result.scenario === 'window-shadow' ? verifyWindowShadowProbe
      : result.scenario === 'view-cycle' ? verifyViewProbe : result.scenario === 'memo-cas' ? verifyMemoProbe : verifyNaturalProbe
    const collector = recall ? JSON.parse(readFileSync(join(output, 'history-quality-target.json'), 'utf8'))
      : ['window-shadow', 'window-project'].includes(result.scenario) ? JSON.parse(readFileSync(join(output, 'window-shadow-evidence.json'), 'utf8')) : undefined
    const projected = ['window-project', 'window-recall','window-native'].includes(result.scenario) ? JSON.parse(readFileSync(join(output, 'window-project-evidence.json'), 'utf8')) : undefined
    const verification = { ...verify(JSON.parse(rawJournal), rawEvents.trim().split('\n').map(line => JSON.parse(line)), collector, projected,
      {baseline:result.baseline===true,qualityOracle:result.qualityOracle===true||native,
        ...(native?{nativeEvidence:JSON.parse(readFileSync(join(output,'native-window-evidence.json'),'utf8'))}:{}),
        ...(recall?{collector:JSON.parse(readFileSync(join(output,'window-shadow-evidence.json'),'utf8')),
          historyLedger:JSON.parse(readFileSync(join(output,'history-quality-ledger.json'),'utf8'))}:{})}),
      source: 'offline-canonical-readback-no-provider', runId: result.runId, journalSha256: sha(rawJournal), eventsSha256: sha(rawEvents),
      hostDisposed: result.hostDisposed === true, originalRunnerAccepted: result.accepted,
      admittedRequests: result.admission.admittedRequests, providerTerminal: usage.economics.usage.activity.providerTerminal,
      verifiedAt: new Date().toISOString() }
    // Scaled-limit readback: a run recorded with --context-tokens must be re-checked against the same grown caps,
    // never against the small constants, or a valid large-context run would be misjudged. Absent the flag nothing is added.
    const recordedTokens = Number.isSafeInteger(result.contextTokens) ? result.contextTokens : null
    if (recordedTokens !== null) {
      const { contextLimits: scaleLimits } = await import('./native-compaction-natural-lab.mjs')
      const expectedLimits = labContextLimits(native ? nativeLabLimits : labLimits, recordedTokens, scaleLimits)
      const scaledOk = ['maxPayloadBytes', 'maxWallMs', 'maxProcessMs'].every(key => result.limits?.[key] === expectedLimits[key])
        && (result.admission?.payloads ?? []).every(row => row.bytes <= expectedLimits.maxPayloadBytes)
      Object.assign(verification, { contextTokens: recordedTokens, scaledLimitsVerified: scaledOk })
      if (!scaledOk) verification.accepted = false
    }
    const expectedRequests = native?6:['window-shadow', 'window-project', 'window-recall'].includes(result.scenario) ? 4 : 2
    // A large-context run may spend the reminder allowance on top of the scripted requests; nothing below that count is valid.
    const requestCeiling = expectedRequests + (result.contextTokens ? contextReminderAllowance : 0)
    if (!verification.hostDisposed || verification.admittedRequests < expectedRequests || verification.admittedRequests > requestCeiling
      || verification.providerTerminal !== verification.admittedRequests) verification.accepted = false
    writeFileSync(join(output, 'offline-verification.json'), JSON.stringify(verification, null, 2) + '\n')
    console.log(JSON.stringify(verification))
    if (!verification.accepted) process.exitCode = 1
    return
  }
  if (process.argv.includes('--child')) return child(run, output, scenario, baseline, qualityOracle, contextTokens)
  mkdirSync(output, { recursive: false })
  const env = { ...process.env, DSH_HOME: home, DSH_LAB_CANONICAL_MODULES: '1' }
  if (run) {
    const { parseCredentialsDocument } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')))
    const key = parseCredentialsDocument(readFileSync('D:/dsh-test/home/.credentials.yaml', 'utf8'), 'readonly-production').refs.get('OPENCODEGO_API_KEY')
    if (typeof key !== 'string' || !key) fail('LAB_CREDENTIAL_REFERENCE_MISSING')
    env.OPENCODEGO_API_KEY = key
  }
  const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--import',
    new URL('./prepare-unified-lab-host.mjs', import.meta.url).href, fileURLToPath(import.meta.url), '--child', '--scenario', scenario, '--output', output,
    ...(run ? ['--run'] : []), ...(baseline ? ['--baseline'] : []), ...(qualityOracle ? ['--quality-oracle'] : []),
    ...(contextTokens === null ? [] : ['--context-tokens', String(contextTokens)])],
    { cwd: stage, env, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      timeout: labContextLimits(scenario==='window-native'?nativeLabLimits:labLimits, contextTokens, contextApi?.contextLimits).maxProcessMs })
  writeFileSync(join(output, 'host.stdout.log'), result.stdout ?? '')
  writeFileSync(join(output, 'host.stderr.log'), result.stderr ?? '')
  const receipt = existsSync(join(output, 'result.json')) ? JSON.parse(readFileSync(join(output, 'result.json'), 'utf8')) : null
  console.log(JSON.stringify({ output, exitCode: result.status, processError: result.error?.code ?? null,
    completedReceipt: receipt?.accepted === true && receipt?.hostDisposed === true,
    resultFile: join(output, 'result.json') }))
  if (result.status !== 0 || receipt?.accepted !== true || receipt?.hostDisposed !== true) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify({ failed: true, code: error?.code ?? error?.name ?? 'unknown' })); process.exitCode = 1 })
}
