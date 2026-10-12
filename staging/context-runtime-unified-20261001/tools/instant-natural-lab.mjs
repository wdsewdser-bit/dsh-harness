import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {join,resolve,sep} from 'node:path'
import {getHostLifecycleGate,Context} from '@deepseek-ai/cordis'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import {createUserMessage,BlockAssembler,expandAssistantStream} from '@deepseek-ai/dsh-llm'
import {installNativeSessionBridge} from '@deepseek-ai/dsh-session'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {runProfile} from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
import {controlPlaneForMember} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {captureLoadedPtcBinding} from './capture-lab-ptc-binding.mjs'
import {createLabAdmission,installLabToolAdmission,bootstrapCode,labLimits} from './unified-natural-lab.mjs'
import {createProtocolTrialEvidence,installReplayTrialGuard} from './window-protocol-trial.mjs'
const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
const route={provider:'opencodego',model:'deepseek-v4.1-flash'}
const sha=value=>createHash('sha256').update(value).digest('hex')

export function verifyInstantNatural(journal,requests,{run=true}={}){
  if(!run)return {accepted:requests.length===0,scope:'bootstrap-no-provider'}
  const attempts=journal.filter(row=>row.type==='assistant/attempt'&&row.data?.superseded===true)
  const admissions=journal.filter(row=>row.type==='native/input-accepted'&&row.data?.preemptGeneration>=1)
  const results=journal.filter(row=>row.type==='tool/result').map(row=>row.data.message)
  const messages=journal.filter(row=>row.type==='assistant/message')
  const calls=messages.flatMap(row=>row.data.message?.content??[]).filter(block=>block.type==='tool-call')
  const code=call=>typeof call.arguments==='string'?JSON.parse(call.arguments).code:call.arguments?.code
  const paired=calls.length===1&&results.length===1&&calls.some(call=>call.name==='run_code'&&code(call)?.trim()===bootstrapCode
    &&results.some(message=>message?.toolCallId===call.id&&message?.isError===false))
  const final=messages.some(row=>(row.data.message?.content??[]).some(block=>block.type==='text'&&block.text.trim()==='UNIFIED_PTC_BOOTSTRAP_OK'))
  const input=admissions[0],committed=journal.filter(row=>row.type==='user/message'&&row.data?.id===input?.data.messageId)
  const interrupted=journal.filter(row=>row.type==='native/sampling-interrupted'&&row.data?.superseded===true)
  const inputOnce=admissions.length===1&&committed.length===1&&committed[0].seq>input.seq
    &&committed[0].data.source?.nativeInputId===input.data.inputId
  const terminal=journal.at(-1)?.type==='turn/end'&&journal.at(-1).data.reason.kind==='completed'
  const ordered=interrupted.length===1&&attempts.length===1&&input?.seq<attempts[0].seq
    &&attempts[0].seq<interrupted[0].seq&&interrupted[0].seq<committed[0]?.seq
  const leaked=attempts.some(row=>{
    const assembler=new BlockAssembler()
    for(const timed of expandAssistantStream(row.data.stream))assembler.push(timed.chunk)
    const old=assembler.interruptedBlocks()
    return old.length>0&&requests.slice(1).some(request=>request.messages.some(message=>
      message.role==='assistant'&&JSON.stringify(message.content)===JSON.stringify(old)))
  })
  return {accepted:requests.length>=2&&requests.length<=4&&attempts.length===1&&inputOnce&&ordered&&terminal&&paired&&final&&!leaked,
    scope:'isolated-Team-actual-DS4.1F-Instant-single-case-not-full-AB',supersededAttempts:attempts.length,
    preemptAdmissions:admissions.length,inputConsumedOnce:inputOnce,causalOrderVerified:ordered,completedTerminal:terminal,
    toolPairMatched:paired,finalMatched:final,oldAttemptStreamLeaked:leaked}
}

export function observeInstantStream(stream,request,signal,onDelta){
  return (async function*(){
    try{for await(const chunk of stream){
      request.chunks++
      if(chunk.type==='usage')request.usage=chunk.usage
      if(/^(text|reasoning|tool-call)-delta$/.test(chunk.type)){
        request.firstDeltaAt??=Date.now()
        onDelta(request)
      }
      yield chunk
    }request.terminal='completed'}
    catch(error){request.terminal=signal?.aborted?'aborted':'failed';request.error=error.code??error.name;throw error}
    finally{request.endedAt=Date.now()}
  })()
}

export async function verifyStored(directory){
  directory=resolve(directory)
  assert.ok(directory.startsWith(join(root,'lab-runs')+sep))
  const historical=JSON.parse(readFileSync(join(directory,'result.json'),'utf8'))
  assert.equal(directory,join(root,'lab-runs','natural-instant-'+historical.sessionId))
  const journal=JSON.parse(readFileSync(join(directory,'canonical-journal.json'),'utf8'))
  const requests=JSON.parse(readFileSync(join(directory,'request-evidence.json'),'utf8'))
  for(const request of requests)assert.equal(sha(JSON.stringify(request.messages)),request.payloadSha256)
  const ctx=new Context(),gate=getHostLifecycleGate(ctx)
  let storage,handle
  try{
    await gate.observeSettlement(()=>gate.runAsync(()=>{storage=new Jsonl(ctx,{root:join(directory,'sessions')})}))
    handle=await storage.open(historical.sessionId,'read')
    const disk=(await handle.read()).events
    assert.deepEqual(disk.slice(0,journal.length),journal)
    const evidence={...verifyInstantNatural(disk,requests,{run:historical.run}),sessionId:historical.sessionId,
      independentNativeDiskReadback:true,externalRequests:0,events:disk.length,
      journalSha256:sha(JSON.stringify(disk)),requestEvidenceSha256:sha(readFileSync(join(directory,'request-evidence.json'))),
      historicalResultPreserved:true,historicalAccepted:historical.accepted,verifiedAt:new Date().toISOString()}
    writeFileSync(join(directory,'offline-verification.json'),JSON.stringify(evidence,null,2)+'\n')
    console.log(JSON.stringify(evidence))
    assert.equal(evidence.accepted,true)
    return evidence
  }finally{
    await handle?.close()
    await gate.observeSettlement(()=>gate.runAsync(()=>ctx.fiber.dispose()))
  }
}

export async function main(){
  const run=process.argv.includes('--run'),sessionId=randomUUID()
  assert.equal(process.env.DSH_HOME,join(root,'lab-host-home'))
  assert.equal(process.env.DSH_LAB_CANONICAL_MODULES,'1')
  const prep=JSON.parse(readFileSync(join(process.env.DSH_HOME,'preparation-evidence.json'),'utf8'))
  assert.equal(prep.prepared,true)
  assert.equal(sha(readFileSync(join(process.env.DSH_HOME,'dump-config.yaml'))),prep.dumpSha256)
  const output=join(root,'lab-runs','natural-instant-'+sessionId),cwd=join(output,'workspace')
  mkdirSync(cwd,{recursive:true})
  const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n')
  const requests=[],events=[],first=Promise.withResolvers()
  const admission=createLabAdmission(sessionId,{run,scenario:'static'})
  const result={sessionId,output,route,limits:labLimits,run,accepted:false,productionWrites:false,startedAt:new Date().toISOString()}
  save('run-manifest.json',result)
  const overlay=join(output,'storage-overlay.json')
  save('storage-overlay.json',[
    {id:'session-persistence-jsonl',config:{root:join(output,'sessions')}},
    {id:'session-query-sqlite',config:{path:join(output,'query.sqlite'),openAt:'startup'}},
    {id:'team-runtime-guard',config:{sessionListCachePath:join(output,'session-list-cache.json')}}])
  let ctx,agent,barrier,restore,timer,acceptedAt
  const record=value=>events.push({...value,time:Date.now()})
  const timeout=(promise,ms,label)=>{
    let handle
    return Promise.race([promise,new Promise((_,reject)=>{handle=setTimeout(()=>reject(new Error('INSTANT_TIMEOUT_'+label)),ms)})]).finally(()=>clearTimeout(handle))
  }
  try{
    const host=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]),
      profile:'web',patchFiles:[overlay],args:['--no-open','--port','40124']})
    ctx=host.ctx
    const gate=getHostLifecycleGate(ctx)
    await gate.observeSettlement(()=>gate.runAsync(async()=>{
      ctx.on('llm/stream',(options,next)=>{
        admission.admit(options)
        const index=requests.length
        const request={index,time:Date.now(),messages:options.messages,payloadSha256:sha(JSON.stringify(options.messages)),chunks:0,usage:null}
        requests.push(request)
        return observeInstantStream(next(),request,options.signal,()=>{
          if(index===0)first.resolve()
          else if(acceptedAt)result.successorTtftMs??=Date.now()-acceptedAt
        })
      },{global:true})
      installLabToolAdmission(ctx,admission)
      ctx.on('agent/error',event=>{record({event:'agent-error',code:event.error?.code??event.error?.name});first.reject(event.error)},{global:true})
      const composition=await ctx.sessionController.agents.composeAgent('ptc')
      agent=(await ctx.agents.create({sessionId,agentOptions:{...route,maxTokens:labLimits.maxOutputTokens},
        meta:{cwd,agentPreset:composition.agentPreset},setup:composition.setup})).agent
    }))
    await ctx.sessionController.selectModel({sessionId,...route})
    const cp=controlPlaneForMember(ctx,agent,{directory:join(process.env.DSH_HOME,'team-control-plane')})
    assert.ok(cp);await cp.flush()
    const current=cp.snapshot({history:false,copy:true}),proposal=ctx.teamIdentityRuntime.proposal(agent)
    await ctx.teamIdentityRuntime.activate(agent,{expectedControlRevision:current.revision,
      expectedIdentityEpoch:current.identityEpoch??0,expectedBundleHash:proposal.contentHash})
    const binding=captureLoadedPtcBinding(ctx,agent,{expectedRoute:route,expectedSessionId:sessionId})
    save('loaded-ptc-binding.json',binding)
    save('protocol-trial.json',createProtocolTrialEvidence(binding,sessionId,Date.now(),{nativeSurface:true}))
    await gate.observeSettlement(()=>gate.runAsync(()=>{restore=installReplayTrialGuard(ctx.llm.registration(route.provider).adapter,record)}))
    barrier=await ctx.sessionPersistence.windowBarrierFor(agent.session,{isolated:true,sessionId})
    installNativeSessionBridge(agent.session,{isolated:true,sessionId,flush:async()=>(await barrier.persist()).durable===true})
    if(run){
      timer=setTimeout(()=>agent.cancel({kind:'user'},{keepInbox:true}),labLimits.maxWallMs)
      const message=(id,text)=>createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text}]})
      await agent.followup(message('initial','Do not call any tool. Start a detailed plain text explanation of the integers from 1 through 1000. This draft may be replaced by a new user instruction.'))
      await timeout(first.promise,60000,'first-real-delta')
      await agent.steer(message('changed',`Replace the obsolete draft. Invoke run_code exactly once with this exact code and a short description:\n${bootstrapCode}\nDo not invoke another tool. After success answer only UNIFIED_PTC_BOOTSTRAP_OK.`))
      acceptedAt=Date.now();record({event:'durable-steer-accepted'})
      await timeout(agent.whenIdle(),70000,'successor-idle')
      await barrier.persist()
    }
    const journal=agent.session.snapshotEvents()
    save('canonical-journal.json',journal)
    save('request-evidence.json',requests)
    save('usage-root-only.json',{scope:{rootSessionId:sessionId,descendantSessionIds:[],descendantsForbidden:true},economics:ctx.windowEconomics.readSnapshot(agent),money:null})
    Object.assign(result,verifyInstantNatural(journal,requests,{run}))
    result.pending=agent.inbox.hasPending
    assert.equal(result.accepted,true)
    assert.equal(result.pending,false)
  }catch(error){result.error={code:error.code??error.name,message:error.message};throw error}
  finally{
    clearTimeout(timer)
    if(ctx){
      agent?.cancel({kind:'user'},{keepInbox:true})
      await timeout(agent?.whenIdle()??Promise.resolve(),15000,'cleanup-idle')
      if(agent){await ctx.sessions.flush(agent.session);save('canonical-journal.json',agent.session.snapshotEvents());save('request-evidence.json',requests)}
      restore?.()
      await getHostLifecycleGate(ctx).observeSettlement(()=>getHostLifecycleGate(ctx).runAsync(()=>ctx.fiber.dispose()))
      result.hostDisposed=true
    }
    result.requests=requests.length;result.finishedAt=new Date().toISOString()
    save('runtime-events.json',events);save('result.json',result)
    console.log(JSON.stringify(result))
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const i=process.argv.indexOf('--verify')
  const task=i>=0?verifyStored(process.argv[i+1]):main()
  task.catch(error=>{console.error(error.message);process.exitCode=1})
}
