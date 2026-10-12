import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createHistoryQualityGuard, historyQualityCode, qualityArchive, qualityArchiveCode, matchesQualityArchive, verifyHistoryQualityResult, qualityAnswerInstruction, verifyQualityAnswer } from '../tools/window-history-quality.mjs'
import { verifyWindowRecallProbe } from '../tools/unified-natural-lab.mjs'
import { windowHash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const target = {seq:7,type:'tool/result',data:{message:{toolCallId:'c0',isError:false,content:[{type:'text',text:qualityArchive}]}}}
const artifact = {target,neighbors:[],pairedEvents:[],trace:{kind:'fixture'}}
const bytes = Buffer.from(JSON.stringify(artifact)), pageBytes = 4096
const descriptor = {locator:'actual-fixture-locator',readerSessionId:'root',sourceRef:{sessionId:'root',seq:7,sourceRevision:7,
  sourceHash:hash(JSON.stringify(target)),artifactHash:hash(bytes)},pairingComplete:true,bytes:bytes.length,pageBytes,pages:Math.ceil(bytes.length/pageBytes)}
const actor = {id:'root',session:{id:'root'}}
const result = value => ({content:[{type:'text',text:JSON.stringify(value)}],isError:false})
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
const assembled = () => ({ok:true,durable:true,kind:'history-raw-artifact-v1',descriptor,pageHashes:
  Array.from({length:descriptor.pages},(_,i)=>hash(bytes.subarray(i*pageBytes,Math.min((i+1)*pageBytes,bytes.length)))),
  receipt:{status:'full-fetched',pageCount:descriptor.pages},artifact,
  deliveryCandidate:{id:'server-fixture-candidate',callId:'assembly-inner',status:'returned-awaiting-dispatch'}})

test('bounded fixed SDK program fetches every page and returns exact raw artifact with late corrections', async () => {
  const calls = []
  const value = JSON.parse(await new AsyncFunction('tools',historyQualityCode(7))({history_recall:async args => {
    calls.push(args)
    if (args.action === 'locate') return {ok:true,descriptor}
    if (args.action === 'assemble') return assembled()
    const chunk = bytes.subarray(args.offset,Math.min(args.offset+pageBytes,bytes.length))
    const last = args.offset+chunk.length === bytes.length
    return {ok:true,offset:args.offset,bytes:chunk.length,dataBase64:chunk.toString('base64'),pageHash:hash(chunk),
      complete:last,nextOffset:last?null:args.offset+chunk.length,receipt:{status:'full-fetched',pageCount:descriptor.pages}}
  }}))
  assert.equal(calls.length,2+descriptor.pages)
  assert.equal(verifyHistoryQualityResult(value,target),true)
  const firstCode = qualityArchiveCode
  const journal = [firstCode,historyQualityCode(7)].flatMap((code,i)=>[
    {type:'assistant/message',data:{message:{content:[{type:'tool-call',name:'run_code',id:'c'+i,arguments:JSON.stringify({code})}]}}},
    {type:'tool/result',data:{message:{toolCallId:'c'+i,isError:false,content:[{type:'text',text:i===0?qualityArchive:JSON.stringify(value)}]}}},
    {type:'assistant/message',data:{message:{content:[{type:'text',text:i===0?'UNIFIED_ARCHIVE_WRITTEN':'UNIFIED_HISTORY_QUALITY_OK remaining=4 constraint=preserve-pending-input'}]}}},
    {type:'turn/end',data:{reason:{kind:'completed'}}},
  ])
  journal.forEach((row,i)=>{row.seq=i+6})
  journal.unshift({seq:5,type:'turn/start',data:{turn:1}})
  const originals = journal.filter(row=>row.seq<=9), acl={sessionId:'root',rootTeamId:'team',memberName:'root',tier:0}
  const eventRefs = originals.map(row=>({seq:row.seq,sha256:windowHash(row)}))
  const checkpoint={sessionId:'root',authority:{phaseRefs:{'global:w0':{status:'in_progress'}}}}
  const collector={recovered:true,retention:{receipts:[{id:windowHash({acl,eventRefs}),acl,eventRefs,eventsHash:windowHash(originals)}]},
    successor:{checkpoint:{...checkpoint,checkpointIntegrityHash:windowHash(checkpoint)}}}
  const trialBody = {sessionId:'root',providerAccepted:false,productionAuthorized:false}
  const projected = {trial:{...trialBody,certificateHash:windowHash(trialBody)},audit:[
    {status:'projected',actual:{handedToAdapter:true}},{status:'blocked',blockedReason:'WINDOW_NO_COMPLETED_SPAN'}]}
  const events = [{event:'history-quality-result-handed',requestId:'actual-request',toolCallId:'c1',sourceHash:descriptor.sourceRef.sourceHash,artifactHash:descriptor.sourceRef.artifactHash}]
  const historyLedger={descriptors:{[descriptor.locator]:descriptor},returnedArtifacts:{[value.deliveryCandidate.id]:{
    status:'handed-to-adapter',rootCallId:'c1',callId:value.deliveryCandidate.callId,exactOutputHash:hash(JSON.stringify(value)),
    requestId:'actual-request',sourceRef:descriptor.sourceRef}},reads:{[descriptor.locator]:{
      pageHashes:Object.fromEntries(value.pageHashes.map((hash,i)=>[i*pageBytes,hash])),artifactDeliveryReceipt:{
        status:'full-artifact-dispatched',callId:'c1',assemblyCallId:value.deliveryCandidate.callId,requestId:'actual-request',
        readerSessionId:'root',bytes:descriptor.bytes,pageCount:descriptor.pages,modelUnderstanding:'unknown',sourceRef:descriptor.sourceRef}}},
    debts:{['history-debt-'+descriptor.locator]:{id:'history-debt-'+descriptor.locator,readerSessionId:'root',status:'resolved'}}}
  const evidence={collector,historyLedger}
  assert.equal(verifyWindowRecallProbe(journal,events,target,projected,evidence).accepted,true)
  const qualityJournal = structuredClone(journal)
  qualityJournal.filter(row=>row.type==='assistant/message').at(-1).data.message.content[0].text = JSON.stringify({remaining:4,completionAllowed:false,pendingInputPolicy:'preserve'})
  assert.equal(verifyWindowRecallProbe(qualityJournal,events,target,projected,{qualityOracle:true,...evidence}).accepted,true)
  const baseline = {...projected,audit:[]}
  assert.equal(verifyWindowRecallProbe(qualityJournal,events,target,baseline,{baseline:true,qualityOracle:true,...evidence}).accepted,true)
  assert.equal(verifyWindowRecallProbe(qualityJournal,events,target,projected,{baseline:true,qualityOracle:true,...evidence}).accepted,false)
  assert.equal(verifyWindowRecallProbe(qualityJournal,events,target,projected,{qualityOracle:true,collector}).accepted,false)
  for (const alter of [store=>store.returnedArtifacts[value.deliveryCandidate.id].rootCallId='wrong-parent',
    store=>store.reads[descriptor.locator].artifactDeliveryReceipt.requestId='wrong-request',
    store=>store.debts['history-debt-'+descriptor.locator].status='returned-awaiting-dispatch',
    store=>store.reads[descriptor.locator].modelDeliveryReceipt={status:'full-dispatched'}]) {
    const store=structuredClone(historyLedger); alter(store)
    assert.equal(verifyWindowRecallProbe(qualityJournal,events,target,projected,{qualityOracle:true,collector,historyLedger:store}).accepted,false)
  }
  const corrupt = structuredClone(collector); corrupt.retention.receipts[0].eventRefs[0].sha256='fake'
  assert.equal(verifyWindowRecallProbe(qualityJournal,events,target,projected,{qualityOracle:true,collector:corrupt}).accepted,false)
  assert.equal(verifyWindowRecallProbe(journal,[],target,projected).accepted,false)
  assert.equal(verifyWindowRecallProbe(journal,[...events,{event:'protocol-replay-degraded'}],target,projected).accepted,false)
  assert.ok(JSON.stringify(value.artifact.target).includes('only six of ten'))
  const partial = structuredClone(value); partial.pageHashes.pop()
  assert.equal(verifyHistoryQualityResult(partial,target),false)
  const stale = structuredClone(value); stale.artifact.target.data.message.content[0].text='all done'
  assert.equal(verifyHistoryQualityResult(stale,target),false)
})

test('guard accepts only native own-session locate and its observed descriptor; foreign and forged reads cannot authorize a locator', () => {
  const guard = createHistoryQualityGuard('root',7)
  const call = {agent:actor,name:'history_recall',arguments:{action:'locate',seq:7}}
  const read = {agent:actor,name:'history_recall',arguments:{action:'read',locator:descriptor.locator,expectedRevision:7,
    expectedSourceHash:descriptor.sourceRef.sourceHash,offset:0}}
  guard.observe(call,result({ok:true,descriptor}))
  assert.equal(guard.allow(read),false)
  assert.equal(guard.allow(call),true)
  guard.observe(call,result({ok:true,descriptor}))
  assert.equal(guard.allow(read),true)
  const assemble = {...read,arguments:{action:'assemble',locator:descriptor.locator,expectedRevision:7,
    expectedSourceHash:descriptor.sourceRef.sourceHash}}
  assert.equal(guard.allow(assemble),true)
  assert.equal(guard.allow({...assemble,arguments:{...assemble.arguments,status:'full-dispatched'}}),false)
  assert.equal(guard.allow({...assemble,arguments:{...assemble.arguments,expectedSourceHash:'fake'}}),false)
  assert.equal(guard.allow({...read,agent:{id:'other',session:{id:'root'}}}),false)
  assert.equal(guard.allow({...read,arguments:{...read.arguments,offset:1}}),false)
  assert.equal(guard.allow({...read,arguments:{...read.arguments,expectedSourceHash:'fake'}}),false)
  assert.equal(guard.allow({agent:actor,name:'run_code',arguments:{code:guard.code+';await tools.bash({})'}}),false)
})

test('SDK returns the exact server packet and rejects self-assembled or altered packets', async () => {
  for (const alter of [value=>({...value,kind:'exact-history-quality-result'}),value=>({...value,durable:false}),
    value=>({...value,artifact:{...value.artifact,target:{...target,seq:8}}}),value=>({...value,pageHashes:[]})]) {
    await assert.rejects(new AsyncFunction('tools',historyQualityCode(7))({history_recall:async args=> {
      if (args.action==='locate') return {ok:true,descriptor}
      if (args.action==='assemble') return alter(assembled())
      const chunk=bytes.subarray(args.offset,Math.min(args.offset+pageBytes,bytes.length))
      return {ok:true,offset:args.offset,bytes:chunk.length,dataBase64:chunk.toString('base64'),pageHash:hash(chunk),
        complete:args.offset+chunk.length===bytes.length,nextOffset:args.offset+chunk.length===bytes.length?null:args.offset+chunk.length,
        receipt:{status:'full-fetched',pageCount:descriptor.pages}}
    }}),/HISTORY_ASSEMBLY_FAILED/)
  }
  const legacy={...assembled(),kind:'exact-history-quality-result'}
  assert.equal(verifyHistoryQualityResult(legacy,target),true)
  assert.equal(verifyHistoryQualityResult({...assembled(),durable:false},target),false)
})

test('SDK program refuses truncated pages and never turns first-page fetch into completion', async () => {
  await assert.rejects(new AsyncFunction('tools',historyQualityCode(7))({history_recall:async args => args.action === 'locate'
    ? {ok:true,descriptor} : {ok:true,offset:args.offset,bytes:1,dataBase64:'eA==',pageHash:hash('x'),
      complete:false,nextOffset:1,receipt:{status:'partial'}}}), /HISTORY_INCOMPLETE/)
})

test('compact archive program preserves exact original; known runtime warning is not truncation', async () => {
  assert.equal(await new AsyncFunction(qualityArchiveCode)(),qualityArchive)
  assert.ok(qualityArchiveCode.length < 600)
  assert.equal(matchesQualityArchive(qualityArchive),true)
  assert.equal(matchesQualityArchive(qualityArchive+'\nFile sandbox enforcement is partial on this host.'),true)
  assert.equal(matchesQualityArchive(qualityArchive.replace('Supporting archived context.\n','')),false)
  assert.equal(matchesQualityArchive(qualityArchive+'\nforeign data'),false)
})

test('quality oracle derives the late correction; prompt has no prefilled answer and completion claims fail', () => {
  assert.equal(/remaining=4|"remaining":4|six|four|ten|false/.test(qualityAnswerInstruction),false)
  assert.equal(verifyQualityAnswer('{"remaining":4,"completionAllowed":false,"pendingInputPolicy":"preserve"}',target),true)
  for (const text of ['{"remaining":0,"completionAllowed":true,"pendingInputPolicy":"preserve"}',
    '{"remaining":4,"completionAllowed":false,"pendingInputPolicy":"discard"}',
    'UNIFIED_HISTORY_QUALITY_OK remaining=4 constraint=preserve-pending-input']) assert.equal(verifyQualityAnswer(text,target),false)
  const truncated = structuredClone(target); truncated.data.message.content[0].text=qualityArchive.slice(0,200)
  assert.equal(verifyQualityAnswer('{"remaining":4,"completionAllowed":false,"pendingInputPolicy":"preserve"}',truncated),false)
})
