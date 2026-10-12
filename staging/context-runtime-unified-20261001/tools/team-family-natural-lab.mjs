import assert from 'node:assert/strict'
import {createHash, randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join, resolve, sep} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import {Context, getHostLifecycleGate} from '@deepseek-ai/cordis'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {installNativeSessionBridge,nativeSessionBridge} from '@deepseek-ai/dsh-session'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import {runProfile} from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
import {controlPlaneForMember} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {policyFor, teamKeyOf} from '../home/profiles/web/plugins/team-policy.mjs'
import {observeStream} from '../home/profiles/web/plugins/request-usage-ledger.mjs'
import {aggregateWindowUsage} from '../home/profiles/web/plugins/team-v15-window-economics.mjs'
import {captureLoadedPtcBinding} from './capture-lab-ptc-binding.mjs'
import {createProtocolTrialEvidence, installReplayTrialGuard} from './window-protocol-trial.mjs'
import {installLabToolAdmission} from './unified-natural-lab.mjs'

const stage = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(new URL('../app/package.json', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const route = Object.freeze({provider:'opencodego',model:'deepseek-v4.1-flash'})
const roles = Object.freeze({root:{tier:0,name:'lead'},lead:{tier:1,name:'probe-lead'},
  member:{tier:2,name:'probe-member'},verifier:{tier:1,name:'probe-verifier'}})
export const familyLimits = Object.freeze({maxRequests:8,maxOutputTokens:2048,maxPayloadBytes:262144,
  maxWallMs:150000,maxProcessMs:185000})
const fail = code => {throw Object.assign(new Error(code),{code})}
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
function answer(text) {
  const match = /^```json\s*\n([\s\S]*?)\n```$/.exec(text.trim())
  try {return JSON.parse(match ? match[1] : text)} catch {return null}
}
export function familyAdmission(run) {
  const permits = new Map(), admitted = [], rejected = []
  return {
    permit(sessionId,version) {if(permits.size) fail('FAMILY_CONCURRENT_TURN'); permits.set(sessionId,version)},
    revoke() {permits.clear()},
    allows(sessionId) {return permits.has(sessionId)},
    admit(options) {
      const version = permits.get(options.sessionId)
      if (!run || !version) {rejected.push({sessionId:options.sessionId,reason:'unpermitted-sampling'});fail('FAMILY_UNPERMITTED_SAMPLING')}
      if(options.provider !== route.provider || options.model !== route.model) fail('FAMILY_FOREIGN_ROUTE')
      if(options.maxTokens !== familyLimits.maxOutputTokens) fail('FAMILY_OUTPUT_LIMIT')
      if(Buffer.byteLength(JSON.stringify(options.messages)) > familyLimits.maxPayloadBytes) fail('FAMILY_PAYLOAD_LIMIT')
      if(admitted.length >= familyLimits.maxRequests) fail('FAMILY_REQUEST_LIMIT')
      admitted.push({sessionId:options.sessionId,version});return version
    },
    snapshot() {return {admitted,rejected,limits:familyLimits}},
  }
}

export function verifyFamily(journals,requests,terminals,evidence) {
  try {
    const ids = Object.values(evidence.members).map(member => member.sessionId)
    const rootId = evidence.members.root.sessionId
    if(new Set(ids).size !== 4 || Object.keys(journals).length !== 4 || requests.length !== 8 || terminals.length !== 8
      || evidence.rounds.length !== 8 || new Set(requests.map(row => row.requestId)).size !== 8) return {accepted:false}
    const active = {A:evidence.activationA,B:evidence.activationB}
    if(active.A?.status !== 'active' || active.B?.status !== 'active'
      || !Number.isSafeInteger(active.A.epoch) || active.A.epoch < 1 || active.B.epoch !== active.A.epoch+1
      || active.A.contentHash === active.B.contentHash) return {accepted:false}
    for(const version of ['A','B']) if(active[version].identityVersion !== 'family-'+version
      || active[version].activatedBy !== rootId || !/^[a-f0-9]{64}$/.test(active[version].contentHash)) return {accepted:false}
    const rootLog = journals[rootId].events
    const activeRoster = new Map(rootLog.filter(event => event.type === 'team/member').map(event => [event.data.member.id,event.data.member]))
    for (const [role,spec] of Object.entries(roles)) {
      const member = evidence.members[role], stored = journals[member.sessionId]
      if(member.tier !== spec.tier || member.roleFile !== role+'.md' || member.name !== spec.name) return {accepted:false}
      if(stored.header.id !== member.sessionId || stored.events.some((event,index) => event.seq !== index)) return {accepted:false}
      if(role !== 'root' && (stored.header.parentSession !== rootId || activeRoster.get(member.sessionId)?.phase !== 'active'
        || activeRoster.get(member.sessionId)?.name !== spec.name)) return {accepted:false}
      for(const version of ['A','B']) {
        const matches = requests.filter(request => request.sessionId === member.sessionId && request.version === version)
        if(matches.length !== 1) return {accepted:false}
        const request = matches[0], body = JSON.stringify({system:request.system,messages:request.messages})
        const identityText = evidence.identityTexts[version][role]
        const deliveredText = [request.system ?? '',...request.messages.map(textOf)].join('\n')
        if(sha(body) !== request.payloadSha256 || !deliveredText.includes(identityText)
          || !deliveredText.includes(active[version].contentHash)) return {accepted:false}
        const terminal = terminals.find(row => row.requestId === request.requestId)
        if(!terminal || terminal.sessionId !== member.sessionId || terminal.status !== 'success' || terminal.usageFinal !== true
          || terminal.provider !== route.provider || terminal.model !== route.model) return {accepted:false}
        const round = evidence.rounds.find(row => row.sessionId === member.sessionId && row.version === version)
        if(!round || ![round.beforeEventCount,round.answerSeq,round.endSeq].every(Number.isSafeInteger)
          || round.beforeEventCount < 0 || round.beforeEventCount > round.answerSeq || round.answerSeq >= round.endSeq
          || sha(JSON.stringify(stored.events.slice(0,round.beforeEventCount))) !== round.beforeHash) return {accepted:false}
        const assistant = stored.events[round.answerSeq]
        if(assistant?.type !== 'assistant/message') return {accepted:false}
        for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens']) {
          if((terminal.usage?.[key] ?? null) !== (assistant.data.usage?.[key] ?? null)) return {accepted:false}
        }
        if(!evidence.fixtureMode) {
          const dispatch = terminal.requestProjection
          const response = assistant.data.stream?.findLast(row => row.chunk?.type === 'finish')?.chunk.replayState?.response
          if(dispatch?.stage !== 'handed-to-adapter' || dispatch.sessionId !== member.sessionId
            || dispatch.provider !== route.provider || dispatch.model !== route.model
            || response?.kind !== 'pi-ai' || response.api !== 'openai-responses'
            || response.provider !== route.provider || response.model !== route.model || !response.responseId) return {accepted:false}
        }
        const value = answer(textOf(assistant.data.message))
        if(!value || Object.keys(value).length !== 4 || value.roleFile !== role+'.md' || value.tier !== spec.tier
          || value.identityProbe !== `family-${version}-${role}` || value.completionAllowed !== false) return {accepted:false}
        if(stored.events[round.endSeq]?.type !== 'turn/end' || stored.events[round.endSeq].data.reason.kind !== 'completed') return {accepted:false}
      }
    }
    if(new Set(terminals.map(row => row.requestId)).size !== 8) return {accepted:false}
    const usage = aggregateWindowUsage(terminals,{rootSessionId:rootId,memberSessionIds:ids})
    return {accepted:usage.membership.scopeResolved && usage.activity.requests === 8 && usage.activity.providerTerminal === 8
      && usage.activity.unclassifiedTerminal === 0,scope:'isolated-actual-Team-four-role-next-turn; native-flat-parentage; root-plus-three-descendants',
      fixtureMode:evidence.fixtureMode ?? null,providerAccepted:!evidence.fixtureMode,
      usage,money:null,productionEnabled:false}
  } catch {return {accepted:false}}
}

async function coldRead(directory,id) {
  const ctx = new Context(), gate = getHostLifecycleGate(ctx)
  let storage,handle
  try {
    await gate.observeSettlement(() => gate.runAsync(() => {storage = new Jsonl(ctx,{root:join(directory,'sessions')})}))
    handle = await storage.open(id,'read')
    return {header:handle.header,events:(await handle.read()).events}
  } finally {await handle?.close();await gate.observeSettlement(() => gate.runAsync(() => ctx.fiber.dispose()))}
}
export async function verifyStored(directory) {
  directory = resolve(directory);assert.ok(directory.startsWith(join(stage,'lab-runs')+sep))
  const load = name => JSON.parse(readFileSync(join(directory,name)))
  const saved = load('family-journals.json'), evidence = load('family-evidence.json'),journals = {}
  for(const member of Object.values(evidence.members)) {
    journals[member.sessionId] = await coldRead(directory,member.sessionId)
    assert.deepEqual(journals[member.sessionId],saved[member.sessionId])
  }
  const receipt = {...verifyFamily(journals,load('request-evidence.json'),load('request-terminals.json'),evidence),
    independentNativeDiskReadback:true,journalSha256:sha(JSON.stringify(journals)),externalRequests:0,verifiedAt:new Date().toISOString()}
  writeFileSync(join(directory,'offline-verification.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify(receipt));assert.equal(receipt.accepted,true);return receipt
}

async function child(run,output) {
  const offlineError = process.argv.includes('--offline-error')
  const offlineRounds = process.argv.includes('--offline-rounds')
  const home = join(stage,'lab-host-home'), rolesDir = join(output,'roles'),cwd = join(output,'workspace')
  assert.equal(process.env.DSH_HOME,home);assert.equal(process.env.DSH_LAB_CANONICAL_MODULES,'1')
  mkdirSync(rolesDir);mkdirSync(cwd)
  const save = (name,value) => writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n')
  const original = Object.fromEntries(['AGENTS.md','root.md','lead.md','member.md','verifier.md']
    .map(name => [name,readFileSync(join(home,'team-roles',name),'utf8')]))
  const evidence = {members:{},identityTexts:{},rounds:[],provisioning:[],nativeParentage:'flat-direct-root; logical-tier-policy-separate',
    ...offlineRounds ? {fixtureMode:'offline-rounds-not-provider'} : {}}
  const setIdentity = version => {
    const bodies = Object.fromEntries(Object.entries(original).map(([name,body]) => [name,
      name === 'AGENTS.md' ? body : body+`\n\nFixture identity probe token: family-${version}-${name.slice(0,-3)}\n`]))
    for(const [name,body] of Object.entries(bodies)) writeFileSync(join(rolesDir,name),body)
    writeFileSync(join(rolesDir,'identity-version.json'),JSON.stringify({schemaVersion:1,identityVersion:'family-'+version,
      files:Object.fromEntries(Object.entries(bodies).map(([name,body]) => [name,sha(body)]))}))
    evidence.identityTexts[version] = Object.fromEntries(Object.keys(roles).map(role => [role,bodies[role+'.md']]))
  }
  setIdentity('A')
  save('storage-overlay.json',[
    {id:'session-persistence-jsonl',config:{root:join(output,'sessions')}},
    {id:'session-query-sqlite',config:{path:join(output,'query.sqlite'),openAt:'startup'}},
    {id:'team-runtime-guard',config:{sessionListCachePath:join(output,'session-list-cache.json')}},
    {id:'tool-agent-team-v2',config:{rolesDir}},
    {id:'team-v12-runtime',config:{rolesDir,activeIdentity:{enabled:true,allowedRoots:[rolesDir]}}},
  ])
  const requests = [],terminals = [],runtimeEvents = [],hostFailures = [],admission = familyAdmission(run || offlineError || offlineRounds), agents = {},journals = {}
  const result = {run,output,route,limits:familyLimits,accepted:false,productionWrites:false,startedAt:new Date().toISOString()}
  let ctx,restore,timer,preProbe = false,provision,durableProbe
  const abort = new AbortController(),signal = abort.signal
  try {
    ctx = (await runProfile({environment:createEnvironment(),profile:'web',patchFiles:[join(output,'storage-overlay.json')],
      args:['--no-open','--port','40124']})).ctx
    const gate = getHostLifecycleGate(ctx)
    if(process.env.DSH_LAB_HOST_DEBUG === '1') {
      const runSync = gate.runSync
      gate.runSync = function(...args) {
        try {return runSync.apply(this,args)} catch(error) {
          hostFailures.push({code:error.code,snapshot:this.snapshot(),stack:error.stack});throw error
        }
      }
    }
    await gate.observeSettlement(() => gate.runAsync(async () => {
      ctx.on('agent/created',async({agent}) => {
        agent.options = {...agent.options,maxTokens:2048}
        for(const [role,member] of Object.entries(evidence.members)) if(member.sessionId === agent.id) agents[role] = agent
        const barrier = await ctx.sessionPersistence.windowBarrierFor(agent.session,{isolated:true,sessionId:agent.id})
        installNativeSessionBridge(agent.session,{isolated:true,sessionId:agent.id,flush:async() => {
          const probe = durableProbe
          if(probe?.sessionId === agent.id) {probe.entered.resolve();await probe.release.promise}
          return (await barrier.persist()).durable === true
        }})
      },{global:true})
      ctx.on('agent/pre-step',async({agent},next) => {
        if(provision?.caller === agent) {
          const pending = provision;provision = undefined
          const sampling = nativeSessionBridge(agent.session).beginSampling(signal)
          try {pending.execution = await pending.execute()} catch(error) {pending.error = error}
          finally {sampling.dispose()}
          return {kind:'reject',reason:'FAMILY_FIXTURE_PROVISIONED_WITHOUT_SAMPLING'}
        }
        return preProbe || admission.allows(agent.id) ? next()
          : {kind:'reject',reason:'FAMILY_STARTUP_NO_SAMPLING_UNTIL_EXPLICIT_PROBE'}
      },{global:true,prepend:true})
      ctx.on('llm/stream',(options,next) => {
        const version = admission.admit(options),requestId = randomUUID()
        const body = {system:options.system ?? null,messages:options.messages}
        requests.push({sessionId:options.sessionId,version,requestId,...body,payloadSha256:sha(JSON.stringify(body))})
        save('request-evidence.json',requests);save('family-evidence.json',evidence)
        const stream = offlineError && options.sessionId === evidence.members.member?.sessionId
          ? () => (async function*(){throw Object.assign(new Error('FAMILY_OFFLINE_TRANSPORT_ERROR'),{code:'AUTH'})})()
          : offlineRounds || offlineError ? () => (async function*(){
            const standing = [options.system ?? '',...options.messages.map(textOf)].join('\n')
            const token = [...standing.matchAll(/Fixture identity probe token: family-([AB])-(root|lead|member|verifier)/g)].at(-1)
            assert.ok(token,'offline fixture must receive an actual standing identity token')
            yield {type:'text-delta',index:0,text:JSON.stringify({roleFile:token[2]+'.md',tier:roles[token[2]].tier,
              identityProbe:'family-'+token[1]+'-'+token[2],completionAllowed:false})}
            yield {type:'usage',usage:{inputTokens:1,cacheReadTokens:0,outputTokens:1,totalTokens:2}}
            yield {type:'finish',reason:{kind:'stop'}}
          })() : next
        return observeStream(options,stream,{requestId,metadata:() => ({attemptId:requestId,
          requestProjection:ctx.requestMessageProjection?.audit(options) ?? null}),record:row => {
            if(row.event === 'terminal') {terminals.push(row);save('request-terminals.json',terminals)}
          }})
      },{global:true})
      ctx.on('agent/error',({agent,error}) => {
        result.agentErrors ??= [];result.agentErrors.push({sessionId:agent.id,code:error.code,message:error.message})
        save('result.json',result)
        admission.revoke();abort.abort(error)
      },{global:true})
      const composition = await ctx.sessionController.agents.composeAgent('ptc'),sessionId = randomUUID()
      agents.root = (await ctx.agents.create({sessionId,agentOptions:{...route,maxTokens:2048},
        meta:{cwd,agentPreset:composition.agentPreset},setup:composition.setup})).agent
    }))
    await ctx.sessionController.selectModel({sessionId:agents.root.id,...route})
    timer = setTimeout(() => {abort.abort(new Error('FAMILY_WALL_LIMIT'));for(const agent of Object.values(agents).filter(Boolean)) agent.cancel({kind:'user'},{keepInbox:true})},familyLimits.maxWallMs)
    const control = controlPlaneForMember(ctx,agents.root,{directory:join(home,'team-control-plane')})
    const activate = async () => {
      await control.flush();const state = control.snapshot({copy:true}),bundle = ctx.teamIdentityRuntime.proposal(agents.root)
      await ctx.teamIdentityRuntime.activate(agents.root,{expectedControlRevision:state.revision,
        expectedIdentityEpoch:state.identityEpoch ?? 0,expectedBundleHash:bundle.contentHash})
      return ctx.teamIdentityRuntime.status(agents.root)
    }
    evidence.activationA = await activate()
    const spawn = async (role,caller) => {
      const args = {name:roles[role].name,role,context:'fresh',provider:route.provider,model:route.model,
        prompt:'Isolated read-only identity/usage fixture. Do not spawn, send messages, mutate or run tools. Wait for a direct user identity probe; do not claim overall completion.'}
      const code = 'return await tools.spawn_teammate('+JSON.stringify(args)+');'
      // Native PTC dispatches require a real open turn, including zero-model provisioning.
      const pending = {caller,execute:() => caller.ctx.tools.execute({name:'run_code',arguments:{code,
        description:'Create one bounded isolated identity probe member'},agent:caller,callId:randomUUID(),signal})}
      provision = pending
      await caller.steer(createUserMessage({source:{kind:'user',rpcId:'family-fixture-provision-'+role},
        content:[{type:'text',text:'Read-only family fixture provisioning turn; no provider sampling is authorized.'}]}))
      await caller.whenIdle()
      if(pending.error) throw pending.error
      assert.ok(pending.execution,'native open-turn provisioning must execute')
      const execution = pending.execution
      evidence.provisioning.push({caller:caller.id,args,result:execution})
      save('family-evidence.json',evidence)
      assert.equal(execution.isError,false,JSON.stringify(execution))
      const suffix = '\nFile sandbox enforcement is partial on this host.'
      const text = textOf(execution)
      const nested = execution.value?.result ?? JSON.parse(text.endsWith(suffix) ? text.slice(0,-suffix.length) : text)
      const member = nested.member;assert.equal(typeof member?.id,'string')
      const candidate = ctx.agents.get(member.id);assert.ok(candidate,'spawned Team member must remain live')
      agents[role] = candidate
      await agents[role].whenIdle();await agents.root.whenIdle()
      agents[role].options = {...agents[role].options,...route,maxTokens:2048}
    }
    await spawn('lead',agents.root);await spawn('member',agents.lead);await spawn('verifier',agents.root)
    for(const [role,agent] of Object.entries(agents)) {
      const membership = ctx.agentTeams.tryMembership(agent),policy = policyFor(teamKeyOf(ctx,agent))?.get(membership?.name)
      let pre
      try {preProbe = true;pre = await agent.dispatch.waterfall('agent/pre-step',{messages:[],signal,turn:1,step:1},() => Promise.resolve({kind:'enter',messages:[]}))}
      finally {preProbe = false}
      evidence.members[role] = {sessionId:agent.id,name:membership?.name,tier:policy?.tier,roleFile:role+'.md',policy,
        runtimeParent:agent.session.header.parentSession ?? null,preStep:pre.kind}
      assert.equal(policy?.tier,roles[role].tier);assert.equal(pre.kind,'enter')
      assert.ok(JSON.stringify(pre.messages).includes('family-A-'+role))
      const binding = captureLoadedPtcBinding(ctx,agent,{expectedRoute:route,expectedSessionId:agent.id})
      save('binding-'+role+'.json',binding);save('protocol-'+role+'.json',createProtocolTrialEvidence(binding,agent.id,Date.now(),{nativeSurface:true}))
    }
    await gate.observeSettlement(() => gate.runAsync(() => {restore = installReplayTrialGuard(ctx.llm.registration(route.provider).adapter,
      row => runtimeEvents.push(row))}))
    await gate.observeSettlement(() => gate.runAsync(() => installLabToolAdmission(ctx,
      {tool:() => ({kind:'deny',reason:'FAMILY_READ_ONLY_IDENTITY_PROBE_NO_TOOLS'})})))
    if(run || offlineError || offlineRounds) {
      for(const version of ['A','B']) {
        if(version === 'B') {setIdentity('B');evidence.activationB = await activate()}
        for(const role of Object.keys(agents)) {
          let agent = agents[role]
          signal.throwIfAborted()
          const before = agent.session.snapshotEvents(),round = {sessionId:agent.id,version,beforeEventCount:before.length,beforeHash:sha(JSON.stringify(before))}
          admission.permit(agent.id,version)
          let stopWatching
          try {
            const requestId = 'family-'+version+'-'+role,content = [{type:'text',
              text:'This is only a read-only identity/usage fixture. The platform goal has ten mandatory requirements and only six have verified acceptance; changes do not mean enabled or delivered. Read your CURRENT standing identity. Do not call tools, spawn or message anyone. Answer only one JSON object with roleFile (the standing role filename), tier (integer), identityProbe (the current fixture identity probe token in the standing role body), completionAllowed (whether all ten requirements can be called complete). No other fields or commentary.'}]
            let settled
            if(role === 'root') await agent.steer(createUserMessage({source:{kind:'user',rpcId:requestId},content}))
            else {
              settled = new Promise((resolve,reject) => {
                const onAbort = () => reject(signal.reason)
                const off = ctx.on('subagent/end',event => {if(event.id === agent.id) resolve(event)},{global:true})
                signal.addEventListener('abort',onAbort,{once:true})
                stopWatching = () => {off();signal.removeEventListener('abort',onAbort)}
              })
              settled.catch(() => {})
              if(offlineRounds && version === 'B') durableProbe = {sessionId:agent.id,entered:Promise.withResolvers(),release:Promise.withResolvers()}
              const delivery = ctx.subagents.prompt({parentSessionId:agents.root.id,childSessionId:agent.id,
                requestId,content,mode:'continuable',delivery:'steer'},signal)
              if(durableProbe) {
                let returned = false
                delivery.then(() => {returned = true},() => {returned = true})
                await Promise.race([durableProbe.entered.promise,delivery.then(() => fail('FAMILY_EARLY_DELIVERY_ACK'))])
                await new Promise(resolve => setImmediate(resolve))
                const pendingBeforeDurability = !returned
                durableProbe.release.resolve();durableProbe = undefined
                assert.equal(pendingBeforeDurability,true)
                evidence.durableAcceptanceChecks ??= []
                evidence.durableAcceptanceChecks.push({sessionId:agent.id,version,pendingBeforeDurability})
              }
              await delivery
            }
            agent = agents[role]
            await agent.whenIdle();signal.throwIfAborted()
            if(settled) assert.equal((await settled).stopReason,'completed')
            else await ctx.sessions.flush(agent.session)
          } finally {durableProbe?.release.resolve();durableProbe = undefined;stopWatching?.();admission.revoke()}
          const events = agent.session.snapshotEvents();round.answerSeq = events.findLast(event => event.type === 'assistant/message')?.seq
          round.endSeq = events.findLast(event => event.type === 'turn/end')?.seq;evidence.rounds.push(round)
          journals[agent.id] = {header:agent.session.header,events}
          save('family-journals.json',journals);save('family-evidence.json',evidence)
        }
      }
      for(const agent of Object.values(agents)) journals[agent.id] = {header:agent.session.header,events:agent.session.snapshotEvents()}
      Object.assign(result,verifyFamily(journals,requests,terminals,evidence));assert.equal(result.accepted,true)
      if(offlineRounds) {result.scope='actual-four-role-Team-offline-rounds-not-provider';result.externalRequests=0}
    } else {result.accepted = requests.length === 0;result.scope = 'actual-four-role-Team-bootstrap-no-provider'}
  } catch(error) {
    result.error = {code:error.code ?? error.name,message:error.message}
    if(!offlineError || error.message !== 'FAMILY_OFFLINE_TRANSPORT_ERROR') throw error
    result.fixtureTransportFailure = true;result.externalRequests = 0;result.scope = 'actual-host-offline-error-fixture-not-provider-accepted'
  }
  finally {
    clearTimeout(timer);admission.revoke()
    if(ctx) {
      result.cleanupErrors = []
      for(const agent of Object.values(agents).filter(Boolean)) {
        try {
          if(ctx.agents.get(agent.id)) agent.cancel({kind:'user'},{keepInbox:true})
          await agent.whenIdle()
          if(ctx.sessions.get(agent.id) === agent.session) await ctx.sessions.flush(agent.session)
        } catch(error) {result.cleanupErrors.push({sessionId:agent.id,code:error.code ?? error.name,message:error.message})}
        journals[agent.id] = {header:agent.session.header,events:agent.session.snapshotEvents()}
      }
      try {
        restore?.();await getHostLifecycleGate(ctx).observeSettlement(() => getHostLifecycleGate(ctx).runAsync(() => ctx.fiber.dispose()))
        result.hostDisposed = true
      } catch(error) {result.hostDisposed = false;result.cleanupErrors.push({code:error.code ?? error.name,message:error.message})}
      if(result.hostDisposed) {
        evidence.finalReadback = []
        try {
          for(const [id,live] of Object.entries(journals)) {
            const stored = await coldRead(output,id)
            // The JSONL header format materializes the native default depth.
            assert.deepEqual(stored.header,{...live.header,delegationDepth:live.header.delegationDepth ?? 0})
            assert.deepEqual(stored.events.slice(0,live.events.length),live.events)
            evidence.finalReadback.push({sessionId:id,beforeEventCount:live.events.length,
              afterEventCount:stored.events.length,preservedPrefixSha256:sha(JSON.stringify(live.events))})
            journals[id] = stored
          }
          result.nativeDiskReadback = true
          if(result.accepted && (run || offlineRounds)) result.accepted = verifyFamily(journals,requests,terminals,evidence).accepted
        } catch(error) {
          result.accepted = false;result.nativeDiskReadback = false
          result.cleanupErrors.push({code:error.code ?? error.name,message:error.message})
        }
      }
    }
    save('family-journals.json',journals);save('family-evidence.json',evidence);save('request-evidence.json',requests)
    save('request-terminals.json',terminals);save('runtime-events.json',runtimeEvents)
    save('host-lifecycle-failures.json',hostFailures)
    result.admission = admission.snapshot();result.finishedAt = new Date().toISOString();save('result.json',result);console.log(JSON.stringify(result))
  }
}

function createEnvironment() {return environmentSnapshot([{source:'process',values:process.env}])}
import {createLaunchEnvironmentSnapshot as environmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
export async function main() {
  const verifyAt = process.argv.indexOf('--verify');if(verifyAt >= 0) return verifyStored(process.argv[verifyAt+1])
  const outputAt = process.argv.indexOf('--output');assert.ok(outputAt >= 0)
  const output = resolve(process.argv[outputAt+1]);assert.ok(output.startsWith(join(stage,'lab-runs')+sep))
  const run = process.argv.includes('--run');if(process.argv.includes('--child')) return child(run,output)
  mkdirSync(output,{recursive:false})
  const env = {...process.env,DSH_HOME:join(stage,'lab-host-home'),DSH_LAB_CANONICAL_MODULES:'1'}
  if(run) {
    const {parseCredentialsDocument} = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')))
    const key = parseCredentialsDocument(readFileSync('D:/dsh-test/home/.credentials.yaml','utf8'),'readonly-production').refs.get('OPENCODEGO_API_KEY')
    if(typeof key !== 'string' || !key) fail('LAB_CREDENTIAL_REFERENCE_MISSING');env.OPENCODEGO_API_KEY = key
  }
  const childProcess = spawnSync(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','--import',
    new URL('./prepare-unified-lab-host.mjs',import.meta.url).href,fileURLToPath(import.meta.url),'--child','--output',output,...(run ? ['--run']:[]),
    ...(process.argv.includes('--offline-error') ? ['--offline-error']:[]),
    ...(process.argv.includes('--offline-rounds') ? ['--offline-rounds']:[])],
    {cwd:stage,env,windowsHide:true,encoding:'utf8',timeout:familyLimits.maxProcessMs,maxBuffer:4*1024*1024})
  writeFileSync(join(output,'host.stdout.log'),childProcess.stdout ?? '');writeFileSync(join(output,'host.stderr.log'),childProcess.stderr ?? '')
  console.log(JSON.stringify({output,exitCode:childProcess.status,processError:childProcess.error?.code ?? null}));if(childProcess.status !== 0) process.exitCode = 1
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {console.error(error.code ?? error.name,error.message);process.exitCode = 1})
