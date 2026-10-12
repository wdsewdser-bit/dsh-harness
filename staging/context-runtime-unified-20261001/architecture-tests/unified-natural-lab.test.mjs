import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createLabAdmission, labLimits, nativeLabLimits, nativeIsolationPatch, bootstrapCode, memoCode, memoText, viewCode, viewText, verifyNaturalProbe, verifyViewProbe, verifyWindowShadowProbe, verifyWindowProjectProbe } from '../tools/unified-natural-lab.mjs'
import { windowHash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'

test('isolated admission binds exact root and route with bounded requests and payload', () => {
  const gate = createLabAdmission('isolated-root')
  const request = { sessionId: 'isolated-root', provider: 'opencodego', model: 'deepseek-v4.1-flash',
    maxTokens: labLimits.maxOutputTokens, messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }] }
  assert.throws(() => gate.admit({ ...request, sessionId: 'foreign' }), /FOREIGN_SESSION/)
  assert.throws(() => gate.admit({ ...request, provider: 'foreign' }), /FOREIGN_ROUTE/)
  assert.throws(() => gate.admit({ ...request, maxTokens: undefined }), /OUTPUT_LIMIT/)
  assert.throws(() => gate.admit({ ...request, messages: ['x'.repeat(labLimits.maxPayloadBytes + 1)] }), /PAYLOAD_LIMIT/)
  assert.equal(gate.snapshot().admittedRequests, 0)
  for (let i = 0; i < labLimits.maxRequests; i++) gate.admit(request)
  assert.throws(() => gate.admit(request), /REQUEST_LIMIT/)
  assert.equal(gate.snapshot().admittedRequests, labLimits.maxRequests)
  assert.equal(gate.snapshot().payloads[0].bytes, Buffer.byteLength(JSON.stringify(request.messages)))
  assert.equal(gate.snapshot().payloads[0].sha256.length, 64)
  assert.equal(JSON.stringify(gate.snapshot()).includes('probe'), false)
})

test('bootstrap denies all sampling and tool admission cannot escape the static probe', () => {
  const gate = createLabAdmission('isolated-root', { run: false })
  assert.throws(() => gate.admit({ sessionId: 'isolated-root' }), /BOOTSTRAP_NO_SAMPLING/)
  const actor = { id: 'isolated-root', session: { id: 'isolated-root' } }
  assert.equal(gate.tool({ agent: actor, name: 'run_code', arguments: { code: bootstrapCode } }).kind, 'allow')
  assert.equal(gate.tool({ agent: actor, name: 'run_code', arguments: { code: 'await tools.bash({command: "pwd"})' } }).kind, 'deny')
  assert.equal(gate.tool({ agent: actor, name: 'bash' }).kind, 'deny')
  assert.equal(gate.tool({ agent: { ...actor, id: 'foreign' }, name: 'run_code' }).kind, 'deny')
  assert.equal(gate.tool({ sessionId: 'isolated-root', name: 'run_code' }).kind, 'deny')
  assert.equal(gate.tool({agent:actor,name:'run_code',arguments:{code:bootstrapCode,sandbox_permissions:'danger-full-access'}}).kind,'deny')
})

test('native W2 scenario has its own six-request bound without expanding older probes',()=> {
  assert.equal(labLimits.maxRequests,4)
  assert.equal(nativeLabLimits.maxRequests,6)
  const gate=createLabAdmission('root',{scenario:'window-native'})
  const request={sessionId:'root',provider:'opencodego',model:'deepseek-v4.1-flash',maxTokens:2048,messages:[]}
  for(let i=0;i<6;i++)gate.admit(request)
  assert.throws(()=>gate.admit(request),/REQUEST_LIMIT/)
  const bootstrap=createLabAdmission('root',{scenario:'window-native',run:false})
  assert.throws(()=>bootstrap.admit(request),/NO_SAMPLING/)
  const actor={id:'root',session:{id:'root'}}
  assert.equal(gate.tool({agent:actor,name:'run_code',arguments:{code:bootstrapCode}}).kind,'allow')
  assert.equal(gate.tool({agent:actor,name:'run_code',arguments:{code:bootstrapCode+'\nreturn 1;'}}).kind,'deny')
})

test('native lab overlay preserves isolated base config and only authorizes the exact new session',()=> {
  const source=[{id:'group',config:[{id:'team-v12-runtime',config:{rolesDir:'isolated/roles',controlDir:'isolated/cp',windowIsolatedSessions:['old']}}]}]
  const before=structuredClone(source),patch=nativeIsolationPatch(source,'new')
  assert.deepEqual(source,before)
  assert.deepEqual(patch[0].config.windowIsolatedSessions,['new'])
  assert.equal(patch[0].config.rolesDir,'isolated/roles')
  assert.equal(patch[0].config.windowOsFileProtection,true)
  assert.throws(()=>nativeIsolationPatch([],'new'),/CONFIG_REQUIRED/)
  assert.throws(()=>nativeIsolationPatch([...source,...source],'new'),/CONFIG_REQUIRED/)
  assert.throws(()=>nativeIsolationPatch(source,''),/EXACT_SESSION/)
})

test('probe verification uses paired canonical tool messages, never missing structuredContent', () => {
  const call = { type: 'tool-call', name: 'run_code', id: 'call-1', arguments: JSON.stringify({code: bootstrapCode}) }
  const journal = [
    { type: 'assistant/message', data: { message: { content: [call] } } },
    { type: 'tool/result', data: { message: { toolCallId: 'call-1', isError: false, content: [{type: 'text', text: 'UNIFIED_PTC_BOOTSTRAP_OK\nFile sandbox enforcement is partial on this host.'}] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'UNIFIED_PTC_BOOTSTRAP_OK' }] } } },
  ]
  const events = [{event: 'tool-final', name: 'run_code', isError: false}]
  assert.equal(verifyNaturalProbe(journal, events).accepted, true)
  assert.equal(verifyNaturalProbe(journal, events).sandboxPartial, true)
  assert.equal(verifyNaturalProbe(journal.slice(0,2), events).accepted, false)
  assert.equal(verifyNaturalProbe(journal, [...events, {event: 'wall-timeout'}]).accepted, false)
  assert.equal(verifyNaturalProbe([...journal,journal[1]], events).accepted, false)
})

test('memo scenario permits only fixed isolated CAS probe code and exact SDK arguments', () => {
  const gate = createLabAdmission('root', {scenario: 'memo-cas'})
  const agent = {id:'root',session:{id:'root'}}
  const exec = {agent,name:'run_code',arguments:{code:memoCode}}
  assert.equal(gate.tool(exec).kind,'allow')
  assert.equal(gate.tool({...exec,arguments:{code:memoCode + '\nawait tools.bash({command:"pwd"});'}}).kind,'deny')
  const args = {action:'memo_put',input:{sourceId:'lab-memo-cas',expectedRevision:0,scope:'member',text:memoText}}
  assert.equal(gate.tool({agent,name:'context_manage',arguments:args}).kind,'allow')
  assert.equal(gate.tool({agent,name:'context_manage',arguments:{...args,input:{...args.input,sourceId:'foreign'}}}).kind,'deny')
  assert.equal(gate.tool({agent,name:'context_manage',arguments:{...args,input:{...args.input,taskId:'foreign'}}}).kind,'deny')
})

test('fixed memo probe checks business rejection without confusing it with native tool errors', async () => {
  const hash = createHash('sha256').update(memoText).digest('hex')
  let count = 0
  const row = {ok:true,revision:1,sha256:hash,text:memoText}
  const tools = {context_manage: async () => ++count === 3 ? {ok:false,partial:true,code:'CAS_CONFLICT'} : row}
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  assert.equal(await new AsyncFunction('tools',memoCode)(tools),'UNIFIED_MEMO_CAS_OK')
  assert.equal(count,4)
  await assert.rejects(new AsyncFunction('tools',memoCode)({context_manage: async () => row}),/STALE_CAS_NOT_REJECTED/)
})

test('view cycle admits dynamic proposals only from its own admitted canonical tool result', () => {
  const gate = createLabAdmission('root', {scenario:'view-cycle'})
  const agent = {id:'root',session:{id:'root'}}
  const hash = createHash('sha256').update(viewText).digest('hex')
  const proposal = {agent,name:'context_manage',arguments:{action:'propose',input:{expectedRevision:0,
    operations:[{op:'select',sourceId:'lab-view-cycle',revision:1,sha256:hash}]}}}
  const commit = {agent,name:'context_manage',arguments:{action:'commit',input:{expectedRevision:0,proposalId:'proposal:trusted'}}}
  const result = {isError:false,content:[{type:'text',text:JSON.stringify({ok:true,expectedRevision:0,proposalId:'proposal:trusted'})}]}
  assert.equal(gate.tool(commit).kind,'deny')
  gate.observe({...proposal},result)
  assert.equal(gate.tool(commit).kind,'deny')
  assert.equal(gate.tool(proposal).kind,'allow')
  gate.observe(proposal,result)
  assert.equal(gate.tool(commit).kind,'allow')
  assert.equal(gate.tool({...commit,agent:{id:'foreign',session:{id:'foreign'}}}).kind,'deny')
  assert.equal(gate.tool({...commit,arguments:{...commit.arguments,input:{...commit.arguments.input,proposalId:'proposal:foreign'}}}).kind,'deny')
  assert.equal(gate.tool({agent,name:'run_code',arguments:{code:viewCode}}).kind,'allow')
  assert.equal(gate.tool({agent,name:'run_code',arguments:{code:viewCode + '\nawait tools.bash({command:"pwd"});'}}).kind,'deny')
})

test('fixed view cycle and verifier require preview purity, stale denial, rollback and original memo', async () => {
  const hash = createHash('sha256').update(viewText).digest('hex')
  const rows = [
    {ok:true,revision:1,sha256:hash}, {ok:true,proposalId:'proposal:trusted',expectedRevision:0},
    {ok:true,originalHistoryPreserved:true,authorityPreserved:true,entries:[{sourceId:'lab-view-cycle'}]},
    {ok:true,viewRevision:0}, {ok:true,viewRevision:1,mode:'shadow'}, {ok:false,code:'VIEW_CAS_CONFLICT'},
    {ok:true,viewRevision:1}, {ok:true,viewRevision:2,parentRevision:1}, {ok:true,viewRevision:2,pins:[],sources:[{}]},
    {ok:true,revision:1,sha256:hash,text:viewText},
  ]
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  let index = 0
  assert.equal(await new AsyncFunction('tools',viewCode)({context_manage:async () => rows[index++]}),'UNIFIED_VIEW_CYCLE_OK')
  assert.equal(index,10)
  const journal = [
    {type:'assistant/message',data:{message:{content:[{type:'tool-call',name:'run_code',id:'view-call',arguments:JSON.stringify({code:viewCode})}]}}},
    {type:'tool/result',data:{message:{toolCallId:'view-call',isError:false,content:[{type:'text',text:'UNIFIED_VIEW_CYCLE_OK'}]}}},
    {type:'assistant/message',data:{message:{content:[{type:'text',text:'UNIFIED_VIEW_CYCLE_OK'}]}}},
  ]
  const events = rows.map(row => ({event:'tool-final',name:'context_manage',isError:false,content:[{type:'text',text:JSON.stringify(row)}]}))
  events.push({event:'tool-final',name:'run_code',isError:false})
  assert.equal(verifyViewProbe(journal,events).accepted,true)
  for (const badIndex of [3,5,7,9]) {
    const bad = structuredClone(events)
    bad[badIndex].content[0].text = JSON.stringify({ok:true,viewRevision:99})
    assert.equal(verifyViewProbe(journal,bad).accepted,false)
    index = 0
    await assert.rejects(new AsyncFunction('tools',viewCode)({context_manage:async () => {
      const i = index++
      return i === badIndex ? {ok:true,viewRevision:99} : rows[i]
    }}))
  }
  assert.equal(verifyViewProbe(journal,[...events,{event:'wall-timeout'}]).accepted,false)
})

test('W0 two-turn verifier requires exact canonical original retention, shadow dispatches and incomplete task authority', () => {
  const journal = []
  for (let turn = 1; turn <= 2; turn++) {
    journal.push({seq:journal.length,type:'assistant/message',data:{message:{content:[{type:'tool-call',name:'run_code',id:'w0-'+turn,arguments:JSON.stringify({code:bootstrapCode})}]}}})
    journal.push({seq:journal.length,type:'tool/result',data:{message:{toolCallId:'w0-'+turn,isError:false,content:[{type:'text',text:'UNIFIED_PTC_BOOTSTRAP_OK'}]}}})
    journal.push({seq:journal.length,type:'assistant/message',data:{message:{content:[{type:'text',text:'UNIFIED_PTC_BOOTSTRAP_OK'}]}}})
    journal.push({seq:journal.length,type:'turn/end',data:{turn,reason:{kind:'completed'}}})
  }
  const events = [1,2].map(() => ({event:'tool-final',name:'run_code',isError:false}))
  const originals = journal.slice(0,4), eventRefs = originals.map(event => ({seq:event.seq,sha256:windowHash(event)}))
  const acl = {sessionId:'root',rootTeamId:'team',memberName:'root',tier:0}
  const receipt = {id:windowHash({acl,eventRefs}),acl,eventRefs,eventsHash:windowHash(originals),retention:'durable-copy-no-expiry-no-gc'}
  const body = {sessionId:'root',authority:{phaseRefs:{'global:w0':{status:'in_progress'}}}}
  const collector = {retention:{receipts:[receipt]},recovered:true,
    successor:{completedSpanCount:1,recoveryDebtCount:0,checkpoint:{...body,checkpointIntegrityHash:windowHash(body)}},
    audit:[1,2,3,4].map(() => ({status:'shadow',changedMessages:false,actual:{handedToAdapter:true,before:{sha256:'a'},after:{sha256:'a'},adapterPayload:{sha256:'a'}}}))}
  assert.equal(verifyWindowShadowProbe(journal,events,collector).accepted,true)
  const projectedCollector = structuredClone(collector)
  for (const row of projectedCollector.audit.slice(2)) {
    row.actual.before = {sha256:'old',bytes:100}
    row.actual.after = {sha256:'new',bytes:50}
    row.actual.adapterPayload = {sha256:'new',bytes:50}
  }
  const trialBody = {kind:'isolated-protocol-trial-v1',providerAccepted:false,productionAuthorized:false,sessionId:'root'}
  const projected = {trial:{...trialBody,certificateHash:windowHash(trialBody)},audit:[1,2].map(() => ({
    status:'projected',postSource:'unchanged',estimated:{beforeBytes:100,candidateBytes:50},
    actual:{handedToAdapter:true,payload:{bytes:50}}}))}
  assert.equal(verifyWindowProjectProbe(journal,events,projectedCollector,projected).accepted,true)
  const stale = structuredClone(projected); stale.trial.sessionId = 'foreign'
  assert.equal(verifyWindowProjectProbe(journal,events,projectedCollector,stale).accepted,false)
  assert.equal(verifyWindowProjectProbe(journal,[...events,{event:'protocol-replay-degraded'}],projectedCollector,projected).accepted,false)
  const bypassed = structuredClone(projected); bypassed.audit[1].status='blocked'
  assert.equal(verifyWindowProjectProbe(journal,events,projectedCollector,bypassed).accepted,false)
  const enlarged = structuredClone(projectedCollector); enlarged.audit[2].actual.after.bytes=101
  assert.equal(verifyWindowProjectProbe(journal,events,enlarged,projected).accepted,false)
  for (const change of [
    c => c.retention.receipts[0].eventsHash='forged',
    c => c.successor.checkpoint.authority.phaseRefs['global:w0'].status='completed',
    c => c.audit[2].actual.adapterPayload.sha256='different',
    c => c.successor.completedSpanCount=0,
  ]) {
    const changed = structuredClone(collector); change(changed)
    assert.equal(verifyWindowShadowProbe(journal,events,changed).accepted,false)
  }
  const gate = createLabAdmission('root',{scenario:'window-shadow'})
  assert.equal(gate.tool({agent:{id:'root',session:{id:'root'}},name:'run_code',arguments:{code:bootstrapCode}}).kind,'allow')
  assert.equal(gate.tool({agent:{id:'root',session:{id:'root'}},name:'context_manage',arguments:{action:'state'}}).kind,'deny')
})
