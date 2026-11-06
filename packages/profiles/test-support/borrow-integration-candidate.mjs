import test from 'node:test';
import './borrow-integration-review.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { ControlStore, BORROW_STORE_VERSION, TEAM_STORE_VERSION } from '../../store/index.mjs';
import { digest } from '../../contracts/index.mjs';
import { initializeBorrowPolicy } from '../borrow-policy.mjs';
import { migrateBorrowPolicy, generate, applyTeamProfile } from '../index.mjs';
import { acquireOwnership } from '../../host/index.mjs';
import { host, loadBuild } from '../../adapter-dsh/index.mjs';
import { teamSchemasForBorrow, validateTool } from '../../contracts/team-tools.mjs';
import { handleTool, TeamCore, toolDescription, rolePrompt } from '../../core/index.mjs';
import { cleanupOrThrow, withStore } from './temp-roots.mjs';
import { writeProcessIdentity } from './process-tree.mjs';
if(process.env.BORROW_PID_FILE)writeProcessIdentity(process.env.BORROW_PID_FILE);
const dirs=[];
const fresh=()=>{ const root=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-integration-'));dirs.push(root);return root; };
const op=s=>'v1:operation:integration-'+s;
let seq=0;
function put(store, rows, teamId='team:integration') {
 const operationId=op('seed-'+(++seq)),payload={rows};
 return store.commit({ entityId:'seed:'+seq,teamId,actor:'adapter',expectedRevision:0,operationId,payload,payloadHash:digest(payload) },tx=>{
  for(const [id,row] of Object.entries(rows))tx.put(id,row);return null;
 });
}
const proof=f=>({...f,terminated:true,evidenceRef:'external:terminated'});
const migrate=(root,to,extra={})=>migrateBorrowPolicy({root,teamId:'team:integration',to,operationId:op(to+'-'+(++seq)),reason:'deployment acceptance',
  verifyQuiescence:proof,...extra});
const seed=root=>withStore(ControlStore,root,s=>{put(s,{'member:root':{role:'root',desired:'active'}});});
test.after(()=>cleanupOrThrow(dirs));

test('migration: no policy is not fresh, hot configuration rejects before writes, unknown metadata rejects',async()=>{
 const root=fresh();seed(root);
 withStore(ControlStore,root,s=>{const head=s.latestEventSeq();
  initializeBorrowPolicy(s,'team:integration','off');assert.equal(s.latestEventSeq(),head);
  assert.throws(()=>initializeBorrowPolicy(s,'team:integration','v1'),e=>e.code==='MIGRATION_REQUIRED');
  assert.equal(s.read('team-policy:team:integration'),null);
 });
 const receipt=await migrate(root,'v1');
 withStore(ControlStore,root,s=>{
  assert.equal(receipt.result.to,'v1');assert(s.read(receipt.result.migrationRef));assert.deepEqual(s.version(),BORROW_STORE_VERSION);
  const originalHead=s.latestEventSeq();let commits=0;s.hooks.beforeCommit=()=>commits++;
  assert.throws(()=>initializeBorrowPolicy(s,'team:integration','off'),e=>e.code==='POLICY_MISMATCH');assert.equal(commits,0);assert.equal(s.latestEventSeq(),
    originalHead);
  s.hooks.beforeCommit=null;put(s,{'team-policy:team:integration':{...s.read('team-policy:team:integration'),surprise:true}});
  assert.throws(()=>initializeBorrowPolicy(s,'team:integration','v1'),e=>e.code==='POLICY_MISMATCH');
 });
 const pristine=fresh();withStore(ControlStore,pristine,s=>{initializeBorrowPolicy(s,'team:integration','v1');assert.equal(s.read(
   'team-policy:team:integration').migrationRef,null);});
 const hidden=fresh();withStore(ControlStore,hidden,s=>{put(s,{});assert.throws(()=>initializeBorrowPolicy(s,'team:integration','v1'),e=>
   e.code==='MIGRATION_REQUIRED');});
});

test('migration: stop proof, real M2b windows/objections, slots/unknown and transaction-head race fail closed',async()=>{
 const blockers=[['message:intent',{kind:'intent',status:'open',decision:null}],['message:objection',{kind:'intent',status:'objected',decision:'objected',
   contractRevision:1,waiver:true}],
 ['attempt:unknown',{owner:'member:w',taskId:'task:w',lease:'unknown'}],['effect-io:old',{state:'unknown'}],['control-slot:old',{state:'held'}],[
   'decision:old',{state:'open'}]];
 for(const [id,row] of blockers){const root=fresh();seed(root);const head=withStore(ControlStore,root,s=>{put(s,{[id]:row});return s.latestEventSeq();});
  await assert.rejects(migrate(root,'v1'),e=>e.code==='MIGRATION_REQUIRED',id);withStore(ControlStore,root,s=>{assert.equal(s.latestEventSeq(),head);
    assert.equal(s.read('team-policy:team:integration'),null);});}
 const root=fresh();seed(root);
 for(const verifyQuiescence of [null,()=>({terminated:true}),f=>({...proof(f),cutoffSeq:f.cutoffSeq-1})])await assert.rejects(migrate(root,'v1',{
   verifyQuiescence}),e=>e.code==='MIGRATION_REQUIRED');
 const ownership=await acquireOwnership({root});try{await assert.rejects(migrate(root,'v1'),e=>e.code==='OWNERSHIP_HELD');}finally{await ownership.release();}
 await assert.rejects(migrate(root,'v1',{verifyQuiescence:f=>{withStore(ControlStore,root,s=>{put(s,{'audit:concurrent':{}});});return proof(f);}}),e=>
   e.code==='MIGRATION_REQUIRED');
});

test('migration: rollback archives resources, retains history/reader floor and both directions replay after real COMMIT cuts',async()=>{
 const crash=fileURLToPath(new URL('./borrow-migration-crash.mjs',import.meta.url));
 for(const to of ['v1','off'])for(const point of ['beforeCommit','afterCommit']){
  const root=fresh();seed(root);if(to==='off')await migrate(root,'v1');
  const {head,before}=withStore(ControlStore,root,s=>{if(to==='off')put(s,{'thread:resource':{kind:'resource',status:'open'},'thread-subscription:one':{state:
    'active'},'thread-delivery:one':{state:'pending'}});
   return {head:s.latestEventSeq(),before:s.read('team-policy:team:integration')};});const operationId=op('cut-'+to+'-'+point);
  const child=spawnSync(process.execPath,[crash,root,'team:integration',to,point,operationId],{encoding:'utf8',timeout:15000});
  assert.equal(child.status,71,child.stdout+child.stderr);assert.equal(child.signal,null);
  withStore(ControlStore,root,s=>{if(point==='beforeCommit'){assert.equal(s.latestEventSeq(),head);assert.deepEqual(s.read('team-policy:team:integration'),
    before);if(to==='off')assert.equal(s.read('thread:resource').status,'open');}
   else{assert.equal(s.read('team-policy:team:integration').superagentBorrow,to);assert.deepEqual(s.version(),BORROW_STORE_VERSION);}});
  const retry=()=>migrateBorrowPolicy({root,teamId:'team:integration',to,operationId,reason:'crash acceptance',verifyQuiescence:proof});
  const receipt=await retry();assert.deepEqual(await retry(),receipt);
  withStore(ControlStore,root,s=>{assert.equal(s.read('team-policy:team:integration').superagentBorrow,to);
   initializeBorrowPolicy(s,'team:integration',to);assert.deepEqual(s.version(),BORROW_STORE_VERSION);
   if(to==='off'){assert.equal(s.read('thread:resource').status,'closed');assert.equal(s.read('thread-subscription:one').state,'closed');assert.equal(s.read(
     'thread-delivery:one').state,'superseded');}});
  const OldStore=(await import('./legacy-control-store.mjs')).ControlStore;
  assert.throws(()=>new OldStore(root),e=>e.code==='INCOMPATIBLE_TEAM_STORE');
 }
});

test('model contract: resource branches/page, explicit decision prompting, schema cannot re-enable M2b',()=>{
 const schemas=teamSchemasForBorrow('v1');assert(schemas.team_thread.oneOf.some(b=>b.properties.op.const==='publish'));
 validateTool(schemas.team_read,{view:'thread-events',ref:'thread:resource',afterSeq:1,limit:1});
 assert.throws(()=>validateTool(schemas.team_read,{view:'thread-events',ref:'thread:resource',afterSeq:0,limit:51}));
 assert.throws(()=>validateTool(schemas.team_thread,{op:'subscribe',operationId:op('replay-zero'),expectedRevision:0,issueId:'thread:resource',replayFrom:0}));
 assert.throws(()=>validateTool(schemas.team_message,{operationId:op('vote'),op:'reply',messageId:'message:one',verdict:'ok'}));
 for(const role of ['root','worker','verifier','subCoordinator']){const p=rolePrompt(role,'on','on','v1');assert.equal(p.version,'superagent-borrow-v1');
   assert.doesNotMatch(p.text,/silence.*counts as ok|objection window/);assert.match(toolDescription(role,'team_message','on','on','v1'),
   /silence or expiry never approves/);}
 withStore(ControlStore,fresh(),s=>{
  const core=new TeamCore(s,{}, {enabled:true,attach:true,teamId:'team:integration',superagentBorrow:'v1',intentSemantics:'root-decision-v1',collab:'on',
    autonomy:'on'});
  put(s,{'member:root':{role:'root',desired:'active'},'thread:resource':{kind:'resource',owner:'member:root',eventSeq:3},
    'thread-event:thread:resource:000002':{threadRef:'thread:resource',seq:2},'thread-event:thread:resource:000003':{threadRef:'thread:resource',seq:3}});
  const page=handleTool(core,{actor:'member:root'},'team_read',{view:'thread-events',ref:'thread:resource',afterSeq:1,limit:1});assert.deepEqual(
    page.events.map(e=>e.seq),[2]);assert.equal(page.nextAfterSeq,2);
  core.configuration.repositories=['repo'];
  const call=args=>handleTool(core,{actor:'member:root'},'team_thread',args);
  const opened=call({op:'open-resource',operationId:op('model-open'),expectedRevision:0,resource:{kind:'branch',repositoryKey:'repo',key:'refs/heads/model'},
    descriptionRef:'doc:description'});
  const issueId=opened.result.entityId;assert.equal(s.read(issueId).kind,'resource');
  for(const [operation,extra] of [['subscribe',{}],['publish',{eventType:'report',summary:'model event'}],['unsubscribe',{reason:'finished'}],[
    'close-resource',{reason:'closed'}]]){
   call({op:operation,operationId:op('model-'+operation),issueId,expectedRevision:s.read(issueId).revision,...extra});
  }
  const actual=handleTool(core,{actor:'member:root'},'team_read',{view:'thread-events',ref:issueId,afterSeq:0,limit:1});assert.equal(actual.events[0].summary,
    'model event');assert.equal(s.read(issueId).status,'closed');
 });
});

test('governance: canonical resource bound is atomic; authoritative evidence growth is observable, never claimed pruned',()=>{
 const root=fresh();withStore(ControlStore,root,s=>{
  const core=new TeamCore(s,{}, {enabled:true,attach:true,teamId:'team:integration',superagentBorrow:'v1',intentSemantics:'root-decision-v1',collab:'on',
    autonomy:'on',repositories:['repo']});
  const rows={'member:root':{role:'root',desired:'active'}};for(let n=0;n<1000;n++)rows['thread-resource:'+n]={threadRef:'thread:history:'+n};put(s,rows);
  const before=s.latestEventSeq();assert.throws(()=>handleTool(core,{actor:'member:root'},'team_thread',{op:'open-resource',operationId:op('resource-bound'),
    expectedRevision:0,resource:{kind:'branch',repositoryKey:'repo',key:'refs/heads/main'},descriptionRef:'doc:description'}),e=>
    e.code==='THREAD_BACKLOG_FULL');
  assert.equal(s.latestEventSeq(),before);const status=s.storageStatus();assert.equal(status.counts.resources,1000);assert.equal(status.limits.resources,
    1000);assert.equal(status.authoritativeEvidenceRetention.mode,'reference-closure');assert.equal(typeof status.authoritativeEvidenceRetention.runs,'number');
    assert.deepEqual(status.authoritativeEvidenceRetention.limits,{...status.authoritativeEvidenceRetention.limits,receipts:512,archive:512});assert(
    status.databaseBytes+status.walBytes>0);
 });
});

const observe=async(predicate,label)=>{for(let n=0;n<500;n++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw Error('timeout '+label);};
// This branch exists only for the parent's timeout acceptance. It keeps the real topology (node --test -> this file ->
// a worker) and hangs after the worker has created its directory and published its PID, so the parent can prove that
// the whole tree is gone before it deletes the parent-owned temp root.
if(process.env.BORROW_TIMEOUT_TEST==='1'){
 test('timeout topology: worker is ready before the parent terminates the tree',{timeout:600000},async()=>{
  const worker=fileURLToPath(new URL('./borrow-timeout-worker.mjs',import.meta.url));
  const child=spawn(process.execPath,[worker],{stdio:'ignore',env:process.env,windowsHide:true});
  await new Promise((resolve,reject)=>{const deadline=Date.now()+30000;const poll=()=>{if(fs.existsSync(process.env.BORROW_TIMEOUT_READY))return resolve();if(
    child.exitCode!==null)return reject(Error('worker exited before ready'));if(Date.now()>deadline)return reject(Error('worker ready timeout'));setTimeout(
    poll,20);};poll();});
  await new Promise(()=>{});
 });
}
function* finished(){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'safe'};yield {type:'block-end',index:0,block:{
  type:'text',text:'safe'}};yield {type:'finish',reason:{kind:'stop'}};}
test('public candidate profile: generate/apply, authenticated native transport, root visible tools and trusted H terminal', {timeout:30000},async()=>{
 const root=fresh();const specification={team:true,guard:true,goalCheck:true,autonomy:'on',collab:'on',superagentBorrow:'v1',intentSemantics:
   'root-decision-v1'};
 generate(root,specification);const entries=JSON.parse(fs.readFileSync(path.join(root,'cordis.patch.yml'),'utf8'))[0].insert;
 assert.equal(entries.find(e=>e.name.endsWith('dsh-agent-loop')).config.instantInterrupt,false);
 const stack=await host(root,{prepared:true}),credential={};let runtime,handle;
 try{
  stack.ctx.agentLoop.config.instantInterrupt=false;
  Object.defineProperty(stack.ctx,'goals',{value:{registerCompletionGuard:()=>()=>{}},configurable:true});
  handle=await stack.create({sessionId:'integration-owner',agentOptions:{provider:'offline',model:'model'},meta:{cwd:root}});
  const module=await loadBuild('dsh-llm');let requests=0,io=0,throttle=false;
  const adapter=new class extends stack.LlmAdapter{
   executionPermitContract='execution-permit/1';providerInfo(id){return{id,name:'offline integration'};}
   async prepareCall(provider,id){return{model:{provider,id,name:id,contextWindow:1e6,inputModalities:['text']},stream:options=>this.stream(options)};}
   // The transport answers a real 429; the adapter maps it to the provider-neutral RATE_LIMIT failure the llm layer
   // reports in the finish chunk. Nothing here contacts a gateway or bills a provider.
   async *stream(){requests++;if(throttle)throw Object.assign(new module.LlmError('fake provider throttled','RATE_LIMIT'),{status:429,headers:{'retry-after':
     '1'}});yield* finished();}
  }();module.registerExecutionTarget(adapter);stack.ctx.llm.registerAdapter(['offline'],adapter);
  const configuration={...entries.find(e=>e.id==='team-runtime').config,home:root,ownerSessionId:'integration-owner',lifecycleIntervalMs:20,gcIntervalMs:
    1000000,
   authenticateHumanInput:c=>c===credential?{teamId:runtime.core.configuration.teamId,ownerSessionId:'integration-owner',authenticatedEntry:
     'owner-user-input'}:null};
  applyTeamProfile(stack.ctx,configuration);runtime=stack.ctx.teamRuntime;await runtime.ready;
  assert.equal(runtime.store.read('team-policy:'+runtime.core.configuration.teamId).superagentBorrow,'v1');
  assert.throws(()=>applyTeamProfile(stack.ctx,{...configuration,superagentBorrow:'off'}),e=>e.code==='TEAM_HOST_MOUNTED');
  configuration.superagentBorrow='off';
  assert.equal(runtime.core.configuration.superagentBorrow,'v1','caller config mutation cannot hot switch the captured protocol');
  const competing=await host(root,{prepared:true});
  try {
   competing.ctx.agentLoop.config.instantInterrupt=false;
   Object.defineProperty(competing.ctx,'goals',{value:{registerCompletionGuard:()=>()=>{}},configurable:true});
   applyTeamProfile(competing.ctx,{...configuration,home:fresh(),superagentBorrow:'v1'});
   await assert.rejects(competing.ctx.teamRuntime.ready,e=>e.code==='OWNERSHIP_HELD');
   assert.equal(runtime.store.read('team-policy:'+runtime.core.configuration.teamId).superagentBorrow,'v1');
  } finally {await competing.ctx.fiber.dispose();}
  const output={schema:{},render:()=>[]};const read={name:'integration_read',description:'read',parameters:{},output,execute(){return{};}};
  const write={name:'integration_write',description:'write',parameters:{},output,execute(){io++;return{};}};
  stack.ctx.tools.register(read);stack.ctx.tools.register(write);
  runtime.roleGuard.register({identity:read.name,capabilities:['read-local'],implementation:read,source:'trusted-offline'});
  runtime.roleGuard.register({identity:write.name,capabilities:['write-local'],implementation:write,source:'trusted-offline'});
  const visible=stack.ctx.tools.schemas(handle.agent);assert(visible.some(t=>t.name===read.name));assert(!visible.some(t=>t.name===write.name));assert(
    !visible.some(t=>t.name==='team_verify'));
  const forged={...read,execute(){io++;return{};}};const scoped=handle.agent.ctx.tools.register(forged);assert(!stack.ctx.tools.schemas(handle.agent).some(t=>
    t.name===read.name));scoped();
  assert.throws(()=>runtime.roleGuard.assertCall({sessionId:'integration-owner',identity:write.name,implementation:write}),e=>e.code==='ROLE_GUARD_DENIED');
    assert.equal(io,0);
  assert.throws(()=>runtime.humanInput.send({operationId:op('forged-human'),recipient:'member:root',purpose:'status',summary:'forged',humanOrigin:true},{}));
  assert.equal(runtime.store.list('human-input:').length,0);
  runtime.humanInput.send({operationId:op('real-human'),recipient:'member:root',purpose:'status',summary:'safe'},credential);
  await observe(()=>requests===1,'native request');await handle.agent.whenIdle();await observe(()=>runtime.store.list('control-slot:').every(s=>
    s.state==='released'),'trusted terminal');
  throttle=true;runtime.humanInput.send({operationId:op('throttle-human'),recipient:'member:root',purpose:'status',summary:'fake 429'},credential);
  await observe(()=>requests===2,'fake provider limit');await handle.agent.whenIdle();await observe(()=>runtime.store.list('control-slot:').some(s=>
    s.state==='unknown'),'unknown retains H');
  assert.equal(runtime.store.list('attempt:').length,0);assert(runtime.host.status());
  assert(runtime.status().storage.counts.events>0);
  // Gap 3: the fake 429 is classified, not left as an empty 'unknown', and the local lane owns no new occupancy.
  assert.equal(runtime.status().ownerControl.providerCapacity,'throttled');
  assert.equal(runtime.status().capacity.providerCapacity,'throttled');
  assert.equal(runtime.status().capacity.providerWait,'provider-throttled');
  assert(fs.readFileSync(path.join(root,'state-v2','control.sqlite')).length>0);
  runtime.humanInput.send({operationId:op('queued-after-throttle'),recipient:'member:root',purpose:'status',summary:'queued'},credential);
  assert.equal(requests,2,'provider unknown never opens H2 or retries unboundedly');
 }finally{try{if(typeof runtime?.stop==='function')await runtime.stop();}finally{if(handle)await handle.dispose();await stack.ctx.fiber.dispose();}}
});
