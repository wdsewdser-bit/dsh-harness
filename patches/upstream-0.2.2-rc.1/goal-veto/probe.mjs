import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL,fileURLToPath} from 'node:url';
import { PRISTINE_ROOT, C1 } from '../paths.mjs';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const mode=process.argv[2], home=process.argv[3];
process.env.DSH_HOME=home;
const base=(mode==='original'?PRISTINE_ROOT:(process.env.DSH_GOAL_TEST_BUILD ?? C1))+'/node_modules/@deepseek-ai/';
const load=async n=>import(pathToFileURL(base+n+'/lib/index.js'));
const {Context}=await load('cordis');const ctx=new Context();
for(const n of ['dsh-session-projection','dsh-session','dsh-llm','dsh-tools','dsh-tool-executor-native','dsh-system-prompt','dsh-agent','dsh-token-meter','dsh-session-persistence-jsonl','dsh-agent-loop','dsh-goal']){
const m=await load(n);const config=n==='dsh-agent-loop'?{agents:[]}:n==='dsh-session-persistence-jsonl'?{root:home+'/sessions',compression:'none',listConcurrency:4}:{};
await ctx.plugin(m.default??m,config).await();
}
const {LlmAdapter}=await load('dsh-llm');let requests=0;
ctx.llm.registerAdapter(['offline'],new class extends LlmAdapter{providerInfo(id){return {id,name:id}}async prepareCall(provider,id){return {model:{provider,id,name:id,contextWindow:100000,inputModalities:['text']},stream(){requests++;throw Error('network forbidden')}}}}());
const options={provider:'offline',model:'model'};
const {GoalReconciler}=await import('./goal-reconciler.mjs');
const alarms=[];ctx.on('team/goal-violation',v=>alarms.push(v));
const reconciler=mode==='original'?null:new GoalReconciler({ledgerPath:home+'/approvals.json',alarm:v=>ctx.emit('team/goal-violation',v)});
let teamDetach;if(reconciler&&mode!=='cold')teamDetach=reconciler.attach(ctx);
if(mode==='cold'){
const saved=JSON.parse(fs.readFileSync(home+'/hot.json','utf8'));
const h=await ctx.agents.resume({resumeSessionId:saved.id,agentOptions:options});
assert.deepEqual(ctx.goals.get(h.agent),saved.view);
const coldEvents=h.agent.session.snapshotEvents();
assert.deepEqual(coldEvents.slice(0,saved.events.length),saved.events);
assert(coldEvents.slice(saved.events.length).every(e=>e.type==='session/end-seed'));
assert.deepEqual(coldEvents.filter(e=>e.type==='goal/change'),saved.events.filter(e=>e.type==='goal/change'));
const state=reconciler.reconcile(h.agent.session);assert.deepEqual(state,saved.reconciliation);
// Rebuild violation projection from durable approval tokens alone, not the saved violation list.
const tokensOnly=home+'/rebuild.json';fs.writeFileSync(tokensOnly,JSON.stringify({version:1,approvals:state.approvals,violations:[]}));
const rebuilt=new GoalReconciler({ledgerPath:tokensOnly});assert.deepEqual(rebuilt.reconcile(h.agent.session),state);
assert.equal(state.teamAcceptance,'unknown');assert.equal(state.violations.length,1);
assert.equal(state.violations[0].kind,'inconsistency');
// An approved completion alone must not be classified as an inconsistency.
const approvedEvent=coldEvents.find(e=>e.type==='goal/change'&&e.data.operation==='complete');
const approvedSession={id:h.agent.session.id,snapshotEvents:()=>coldEvents.filter(e=>e.seq<=approvedEvent.seq)};
const approvedLedger=home+'/approved-only.json';fs.writeFileSync(approvedLedger,JSON.stringify({version:1,approvals:state.approvals,violations:[]}));
const approvedReconciler=new GoalReconciler({ledgerPath:approvedLedger});
assert.equal(approvedReconciler.reconcile(approvedSession).violations.length,0);
assert.equal(approvedReconciler.snapshot().teamAcceptance,'not-unknown');
// A token for a different revision must not authorize this completion.
const staleLedger=home+'/stale-token.json';fs.writeFileSync(staleLedger,JSON.stringify({version:1,approvals:state.approvals.map(a=>({...a,revision:a.revision+100})),violations:[]}));
const coldAlarms=[];const stale=new GoalReconciler({ledgerPath:staleLedger,alarm:v=>coldAlarms.push(v)});
assert.equal(stale.reconcile(approvedSession).teamAcceptance,'unknown');assert.equal(coldAlarms.length,1);
assert.equal(stale.reconcile(approvedSession).violations.length,1);assert.equal(coldAlarms.length,1);
const reopened=new GoalReconciler({ledgerPath:staleLedger,alarm:()=>assert.fail('duplicate durable alarm')});
assert.deepEqual(reopened.reconcile(approvedSession),stale.snapshot());
console.log('PASS reconciliation controls: approved-only clean; wrong revision unknown; durable inconsistency and idempotent alarm');
assert.equal(requests,0);await h.dispose();console.log('PASS cold recovery: goal/journal equal; same violation rebuilt from approval tokens; unknown; zero requests');process.exit(0);
}
const h=await ctx.agents.create({sessionId:'c1-probe',agentOptions:options,meta:{cwd:home}});const agent=h.agent,s=agent.session;
const create=()=>ctx.goals.create(agent,{objective:'offline contract'});
let goal=create();const ref=g=>({id:g.id,revision:g.revision});
const snap=()=>({view:ctx.goals.get(agent),events:s.snapshotEvents(),seq:s.seq});
const evidence=[];const pass=(name)=>{evidence.push(name);console.log('PASS '+name)};
if(mode==='patched'){
for(const [name,guard] of [['deny',()=>false],['throw',()=>{throw Error('policy failure')}],['Promise rejected as non-boolean',()=>Promise.resolve(true)]]){
const off=ctx.goals.registerCompletionGuard(guard);const before=snap();
await ctx.sessions.flush(s);
const files=[];function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())walk(f);else files.push(f)}}walk(home+'/sessions');
const disk=files.map(f=>[f,fs.readFileSync(f).toString('base64')]);
assert.throws(()=>ctx.goals.complete(agent,ref(goal)),e=>e.code==='GOAL_COMPLETION_VETOED');
assert.deepEqual(snap(),before);await ctx.sessions.flush(s);for(const [f,b]of disk)assert.equal(fs.readFileSync(f).toString('base64'),b);
off();pass(name+': journal bytes, seq, revision and activation unchanged');
}
let calls=0;const off=ctx.goals.registerCompletionGuard(input=>{calls++;assert(Object.isFrozen(input));assert(Object.isFrozen(input.goal));return reconciler.approve(input,'approved-completion-1')});
const before=snap();goal=ctx.goals.complete(agent,ref(goal));assert.equal(calls,1);assert.equal(goal.revision,before.view.revision+1);assert.equal(s.seq,before.seq+1);assert.equal(s.snapshotEvents().filter(e=>e.type==='goal/change'&&e.data.operation==='complete').length,1);assert.throws(()=>ctx.goals.complete(agent,ref(before.view)));assert.equal(s.seq,before.seq+1);off();assert.equal(reconciler.snapshot().violations.length,0);assert.equal(reconciler.snapshot().approvals.length,1);pass('allow: one guard, one revision, one append; durable approved token matched; stale retry no append');
}
// Compare default path against upstream in independent processes, stripping random identity/time only.
const defaultHandle=await ctx.agents.create({sessionId:'default-control',agentOptions:options,meta:{cwd:home}});
const defaultAgent=defaultHandle.agent;const defaultGoal=ctx.goals.create(defaultAgent,{objective:'offline contract'});const beforeDefault=defaultAgent.session.seq;
// Default/no-guard parity is outside Team admission: temporarily stop only the reconciler observer.
if(mode==='patched')teamDetach();
const defaultResult=ctx.goals.complete(defaultAgent,ref(defaultGoal));assert.equal(defaultAgent.session.seq,beforeDefault+1);assert.equal(defaultResult.phase,'complete');
const normalize=g=>({revision:g.revision,objective:g.objective,phase:g.phase,maxGoalRounds:g.maxGoalRounds,roundsStarted:g.roundsStarted,activation:g.activation});
fs.writeFileSync(home+'/default.json',JSON.stringify(normalize(defaultResult)));await defaultHandle.dispose();pass('default no guard: synchronous complete + single append');
if(mode==='patched'){
teamDetach=reconciler.attach(ctx);
goal=create();let calls=0;ctx.goals.registerCompletionGuard(()=>{calls++;return false});const before=snap();
assert.throws(()=>ctx.goals.complete(agent,ref(goal)));assert.deepEqual(snap(),before);
const createEvent=s.snapshotEvents().filter(e=>e.type==='goal/change').at(-1);
const change={...createEvent.data,operation:'complete',goal:{...createEvent.data.goal,revision:goal.revision+1,phase:'complete'},updatedAt:Math.max(Date.now(),createEvent.data.updatedAt)};
let rejected=false;try{s.append('goal/change',change)}catch{rejected=true}
const actual=ctx.goals.get(agent);const bypass={rejected,calls,phase:actual.phase,revisionBefore:goal.revision,revisionAfter:actual.revision,seqBefore:before.seq,seqAfter:s.seq};
fs.writeFileSync(home+'/bypass.json',JSON.stringify(bypass,null,2));
await ctx.sessions.flush(s);fs.writeFileSync(home+'/hot.json',JSON.stringify({id:s.id,view:ctx.goals.get(agent),events:s.snapshotEvents(),reconciliation:reconciler.snapshot()}));
console.log('BYPASS '+JSON.stringify(bypass));
assert.equal(rejected,false);assert.equal(calls,1);assert.equal(actual.phase,'complete');
const reconciliation=reconciler.snapshot();assert.equal(reconciliation.teamAcceptance,'unknown');assert.equal(reconciliation.violations.length,1);assert.equal(alarms.length,1);assert.equal(alarms[0].seq,before.seq);
assert.deepEqual(reconciler.reconcile(s),reconciliation);assert.equal(alarms.length,1);
await h.dispose();assert.equal(requests,0);pass('accepted-risk bypass: detected once, durable violation, Team unknown, alarm emitted; native journal NOT rolled back');
}else{await h.dispose();assert.equal(requests,0)}