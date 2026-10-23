import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {existsSync,watch} from 'node:fs'
import {getHostLifecycleGate} from '@deepseek-ai/cordis'
import {LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm'
import {installNativeSessionBridge} from '@deepseek-ai/dsh-session'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {runProfile} from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
import {controlPlaneForMember} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {TYPERT} from '../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js'
import remote from '../app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.remote-client.js'
import {assertInstantHistoryHome} from './instant-history-fixture-home.mjs'
const root=new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')
assert.equal(process.env.DSH_LAB_CANONICAL_MODULES,'1')
const homeReceipt=process.argv.includes('--isolated-home')?assertInstantHistoryHome(process.env.DSH_HOME):null
if(!homeReceipt)assert.equal(process.env.DSH_HOME.replaceAll('\\','/'),root.replace(/\/$/,'')+'/lab-host-home')
// This fixture tests session streaming, not change capture of the controller's
// dirty source repository. Keep the real observer on a separate empty workspace.
const workspace=await mkdtemp(join(tmpdir(),'dsh-instant-history-work-'))
const started=Promise.withResolvers(),successor=Promise.withResolvers(),finish=Promise.withResolvers()
const ui=process.argv.includes('--ui')
const runDirectory=fileURLToPath(new URL('../lab-runs/instant-ui-'+randomUUID()+'/',import.meta.url))
const waitBrowserClose=async()=>{
  const path=runDirectory+'browser-closed.txt'
  let observer
  const closed=new Promise((resolve,reject)=>{
    observer=watch(runDirectory,()=>{if(existsSync(path))resolve()})
    observer.on('error',reject)
    if(existsSync(path))resolve()
  })
  try{await bounded('browser-close',closed,180000)}finally{observer.close()}
}
const followCodec=registry=>(registry.invocations??registry.descriptors).find(row=>row.namespace==='session'&&row.method==='follow').result.create()
const hostCodec=followCodec(TYPERT),remoteCodec=followCodec(remote)
let ctx,agent,requests=0,externalRequests=0
const lifecycle=[],pendingFlushes=new Map()
const note=(kind,details={})=>{lifecycle.push({kind,at:Date.now(),...details});if(lifecycle.length>64)lifecycle.shift()}
const bounded=async(label,promise,timeout=6000)=>{
  console.error('INSTANT_PHASE='+label)
  let timer
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('INSTANT_TIMEOUT_'+label)),timeout)})])}
  finally{clearTimeout(timer)}
}
try {
  const patchFiles=[]
  if(ui){
    await mkdir(runDirectory,{recursive:true})
    const overlay=runDirectory+'storage-overlay.json'
    await writeFile(overlay,JSON.stringify([
      {id:'session-persistence-jsonl',config:{root:runDirectory+'sessions'}},
      {id:'session-query-sqlite',config:{path:runDirectory+'query.sqlite',openAt:'startup'}},
      {id:'team-runtime-guard',config:{sessionListCachePath:runDirectory+'session-list-cache.json'}},
    ]))
    patchFiles.push(overlay)
  }
  const host=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]),profile:'web',patchFiles,args:['--no-open','--port','40124']})
  ctx=host.ctx
  const spawnProcess=ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn=options=>{
    const at=Date.now(),handle=spawnProcess(options)
    const command={argv:options.argv,cwd:options.cwd}
    note('process-start',{at,...command})
    void handle.done.then(result=>note('process-end',{...command,ms:Date.now()-at,exitCode:result.exitCode}),
      error=>note('process-error',{...command,ms:Date.now()-at,message:error.message}))
    return handle
  }
  if(homeReceipt)assert.equal(ctx.sessionPersistence.root.replaceAll('\\','/'),homeReceipt.home.replaceAll('\\','/')+'/sessions')
  const flush=ctx.sessions.flush.bind(ctx.sessions)
  let flushId=0
  ctx.sessions.flush=async session=>{
    const id=++flushId;pendingFlushes.set(id,{sessionId:session.id,at:Date.now()});note('flush-start',{id,sessionId:session.id})
    try{return await flush(session)}finally{pendingFlushes.delete(id);note('flush-end',{id})}
  }
  if(ui){assert.equal(ctx.sessionPersistence.root,runDirectory+'sessions');console.log('INSTANT_UI_STORAGE='+runDirectory)}
  await getHostLifecycleGate(ctx).observeSettlement(()=>getHostLifecycleGate(ctx).runAsync(async()=>{
    ctx.on('llm/stream',(options,next)=>{
      if(options.provider!=='instant-fixture'){externalRequests++;throw new Error('EXTERNAL_PROVIDER_REFUSED')}
      return next()
    },{global:true})
    ctx.on('agent/error',event=>console.error('INSTANT_AGENT_ERROR='+JSON.stringify({name:event.error?.name,message:event.error?.message,code:event.error?.code})),{global:true})
    ctx.on('agent/pre-step',async(event,next)=>{const decision=await next();console.error('INSTANT_PRE_STEP='+JSON.stringify({kind:decision?.kind,reason:decision?.reason}));return decision},{global:true})
    ctx.llm.registerAdapter(['instant-fixture'],new class extends LlmAdapter {
      providerInfo(provider){return{id:provider,name:provider}}
      listModels(provider){return[{provider,id:'fixture',name:'Fixture'}]}
      async prepareCall(provider,model){return{model:{provider,id:model,name:model},stream:options=>(async function*(){
        requests++
        if(requests>2)throw new Error('INSTANT_REQUEST_BUDGET_EXCEEDED')
        yield{type:'text-delta',index:0,text:requests===1?'superseded-text':'current-text'}
        if(requests===1){started.resolve();await new Promise((_,reject)=>{const abort=()=>reject(options.signal.reason);options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort()})}
        else{successor.resolve();await finish.promise;yield{type:'finish',reason:{kind:'stop'}}}
      })()}}
    }())
    const composition=await ctx.sessionController.agents.composeAgent('ptc')
    agent=(await ctx.agents.create({sessionId:randomUUID(),agentOptions:{provider:'instant-fixture',model:'fixture',maxTokens:64},
      meta:{cwd:workspace,agentPreset:composition.agentPreset},setup:composition.setup})).agent
  }))
  await ctx.sessionController.selectModel({sessionId:agent.session.id,provider:'instant-fixture',model:'fixture'})
  const control=controlPlaneForMember(ctx,agent,{directory:process.env.DSH_HOME+'/team-control-plane'})
  assert.ok(control)
  await control.flush()
  const current=control.snapshot({history:false,copy:true}),proposal=ctx.teamIdentityRuntime.proposal(agent)
  await ctx.teamIdentityRuntime.activate(agent,{expectedControlRevision:current.revision,
    expectedIdentityEpoch:current.identityEpoch??0,expectedBundleHash:proposal.contentHash})
  const barrier=await ctx.sessionPersistence.windowBarrierFor(agent.session,{isolated:true,sessionId:agent.session.id})
  installNativeSessionBridge(agent.session,{isolated:true,sessionId:agent.session.id,flush:async()=>{return(await barrier.persist()).durable===true}})
  const snapshot=async()=>{
    const abort=new AbortController(),stream=ctx.sessionController.follow({address:{kind:'session',sessionId:agent.session.id},assistantStream:true},abort.signal)
    try{return remoteCodec.parse(hostCodec.parse((await bounded('snapshot',stream.next())).value))}finally{abort.abort();await stream.return()}
  }
  const message=text=>createUserMessage({source:{kind:'user',rpcId:text},content:[{type:'text',text}]})
  await bounded('followup',agent.followup(message('initial')));await bounded('started',started.promise)
  const initial=await snapshot()
  if(ui){console.log('INSTANT_UI_READY='+JSON.stringify({port:40124,sessionId:agent.session.id}));await bounded('browser-steer',successor.promise,360000)}
  else{
    if(process.argv.includes('--queue-steer')){
      await ctx.sessionController.prompt({sessionId:agent.session.id,requestId:'changed',content:[{type:'text',text:'changed'}],mode:'followup'},new AbortController().signal)
      const queued=agent.inbox.nextTurn.find(row=>row.source.rpcId==='changed');assert.ok(queued)
      await bounded('queue-steer',ctx.sessionController.updateQueue({sessionId:agent.session.id,itemId:queued.id,action:{kind:'steer'}},new AbortController().signal))
    }else await bounded('steer',agent.steer(message('changed')))
    await bounded('successor',successor.promise)
  }
  const updated=await snapshot()
  if(ui){console.log('INSTANT_UI_SUCCESSOR_READY='+agent.session.id);await new Promise(resolve=>setTimeout(resolve,45000))}
  finish.resolve();await bounded('idle',agent.whenIdle());await barrier.persist()
  const completed=await snapshot(),journal=agent.session.snapshotEvents()
  console.log('INSTANT_HISTORY_EVIDENCE='+JSON.stringify({scope:ui?'actual-isolated-Team-host-browser-fake-adapter-not-provider':'actual-isolated-Team-host-fake-adapter-not-provider-or-UI',sessionId:agent.session.id,
    initial:initial.assistantStream,updated:updated.assistantStream,home:process.env.DSH_HOME,workspace,homeReceipt,lifecycle,
    completed:completed.assistantStream,requests,externalRequests,
    interrupted:journal.filter(row=>row.type==='native/sampling-interrupted').map(row=>row.data),
    attempts:journal.filter(row=>row.type==='assistant/attempt').map(row=>({seq:row.seq,data:row.data})),
    admissions:journal.filter(row=>row.type==='native/input-accepted').map(row=>({seq:row.seq,data:row.data})),
    pending:agent.inbox.hasPending,
    committedTexts:agent.session.deriveMessages().flatMap(row=>row.content.filter(block=>block.type==='text').map(block=>block.text))}))
  if(ui){console.log('INSTANT_UI_COMPLETED='+agent.session.id);await waitBrowserClose()}
}catch(error){
  console.error('INSTANT_ERROR='+JSON.stringify({code:error.code,message:error.message,stack:error.stack?.split('\n').slice(0,6)}))
  console.error('INSTANT_DIAGNOSTIC='+JSON.stringify({requests,externalRequests,home:process.env.DSH_HOME,phase:agent?.phase?.kind,pendingFlushes:[...pendingFlushes.values()],lifecycle,events:agent?.session.snapshotEvents().slice(-8).map(row=>({type:row.type,seq:row.seq,data:row.type==='agent/error'?row.data:undefined}))}))
  throw error
}finally{
  finish.resolve()
  if(ctx){agent?.cancel({kind:'user'},{keepInbox:true});await bounded('cleanup-idle',agent?.whenIdle());await getHostLifecycleGate(ctx).observeSettlement(()=>getHostLifecycleGate(ctx).runAsync(()=>ctx.fiber.dispose()))}
}
