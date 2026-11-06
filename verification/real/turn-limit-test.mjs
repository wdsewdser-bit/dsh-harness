import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {policy,turnLimitFor,stages} from './config.mjs';
import {noteToolCall,callKey,loopCode} from './loop-guard.mjs';
import {summarize} from './metrics.mjs';

/**
 * The two safety nets that end a turn, checked offline.
 *
 * The per-turn request ceiling was one hardcoded 16 sized for the synthetic soak workload, and the first real
 * collaboration runs died on it: a member writing code reads, writes and runs commands, and the verifier alone issued
 * 33 calls in a single turn. So the ceiling is now stage-specific: default 16, soak 32, collab 80. The
 * thing that actually has to stop a runaway turn -- a member repeating itself -- gets its own detector and its own
 * error code. Both are proved here, including the negative: a run that repeats itself must end with that code and
 * must fail its own assertion.
 */
const root=path.resolve(process.argv[2]??'');
assert(root.toLowerCase().replaceAll('\\','/').startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/'),'TURN_LIMIT_TEST_SCOPE');
assert(!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const checks=[];
const load=p=>JSON.parse(fs.readFileSync(p,'utf8'));

// 1. The ceiling is per stage, and every stage that existed before keeps 16.
{
  assert.equal(policy.turnRequestLimit.default,16,'a stage without its own entry keeps the release value');
  for(const stage of ['smoke','p2-replay','model-contracts'])assert.equal(turnLimitFor(stage),16,stage+' must be unchanged');
  assert.equal(turnLimitFor('soak'),32,'soak has room for productive review without changing other stages');
  assert.equal(turnLimitFor('unknown-stage'),16);
  assert.equal(turnLimitFor('collab'),80,'the collaboration stage gets room for a real working turn');
  assert.equal(policy.repeatedToolCallLimit,6);
  for(const stage of Object.keys(stages))assert(Number.isSafeInteger(turnLimitFor(stage))&&turnLimitFor(stage)>0,stage);
  checks.push('per-turn ceiling: release stages and any unlisted stage at 16, collab at 80, loop limit 6');
}

// 2. The detector as a pure function over one member's turn state.
{
  const state={};
  const hit=limit=>noteToolCall(state,'read',{file_path:'a.mjs'},limit);
  for(let n=1;n<6;n++)assert.deepEqual(hit(6),{count:n,looped:false},'identical call '+n+' of 6 is not yet a loop');
  assert.deepEqual(hit(6),{count:6,looped:true},'the sixth identical call is the loop');
  // A different call breaks the run, and the same call after that starts a new one.
  assert.equal(noteToolCall(state,'read',{file_path:'b.mjs'},6).count,1);
  assert.equal(noteToolCall(state,'read',{file_path:'a.mjs'},6).count,1);
  // Same name, same arguments in another key order: still the same call.
  const other={};
  noteToolCall(other,'bash',{command:'ls',workdir:'/w'},6);
  assert.equal(noteToolCall(other,'bash',{workdir:'/w',command:'ls'},6).count,2,'argument order must not change identity');
  // Same name, one different character: not the same call.
  assert.equal(noteToolCall(other,'bash',{command:'ls ',workdir:'/w'},6).count,1);
  // A new turn starts a new run, which is what engine.turn() does by clearing the state.
  assert.equal(noteToolCall({},'read',{file_path:'a.mjs'},6).count,1);
  assert.equal(callKey('read',{a:1,b:[1,2]}),'read|{"a":1,"b":[1,2]}');
  checks.push('dead-loop detector: identical calls accumulate, key order does not matter, one different argument or name resets');
}

// 3. A run that repeats one call ends on that code, with the evidence and on its own assertion.
{
  const dir=root+'/repeat';
  const x=spawnSync(process.execPath,['verification/real/run.mjs','smoke','--fake-provider','--fake-fault','repeat-tool-call','--root',dir],
    {env:{...process.env,CLOSEOUT_PROVIDER_KEY:''},encoding:'utf8',timeout:300000});
  assert.equal(x.status,2,x.stdout+x.stderr);
  const report=load(dir+'/report.json'),facts=load(dir+'/facts.json');
  assert.equal(report.error.code,loopCode,'the run must report the loop code, not a generic failure');
  assert.equal(report.error.evidence.count,6);assert.equal(report.error.evidence.limit,6);
  assert.equal(report.loops.length,1);assert.equal(report.loops[0].name,'team_read');
  assert.equal(report.metrics.assertions.turnLimitHonest,false,'a loop must fail the run on its own line');
  assert.equal(report.metrics.assertions.noHarnessErrors,true,'a loop is model behaviour, not a JavaScript defect');
  assert.equal(report.metrics.assertions.nativeToolProtocol,true,'a repeated legal call is not a protocol defect');
  assert.equal(report.realProviderRequests,0);
  // The turn ended at the detector, well before the ceiling it would otherwise have reached.
  assert.equal(report.providerRequests<report.turnRequestLimit,true,'the detector fires long before the ceiling');
  assert((facts.toolRepeats??[]).length>=1,'the first repeat is recorded, so a near miss is visible in the report');
  checks.push('repeat-tool-call: run ends with '+loopCode+' at 6 identical calls, evidence recorded, own assertion fails');
}

// Actual native overflow: distinct legal reads avoid the independent repeated-call detector.
{
  const dir=root+'/ceiling';
  const x=spawnSync(process.execPath,['verification/real/run.mjs','smoke','--fake-provider','--fake-fault','turn-request-limit','--root',dir],
    {env:{...process.env,CLOSEOUT_PROVIDER_KEY:''},encoding:'utf8',timeout:300000});
  assert.equal(x.status,2,x.stdout+x.stderr);
  const report=load(dir+'/report.json'),facts=load(dir+'/facts.json'),ev=report.error.evidence;
  assert.equal(report.error.code,'NATIVE_TURN_REQUEST_LIMIT');
  assert.equal(ev.actor,'root');assert.equal(typeof ev.sessionId,'string');assert(Number.isInteger(ev.turn));
  assert.equal(ev.requests,17);assert.equal(ev.limit,16);
  assert.equal(facts.loops?.length??0,0);
  assert.equal(facts.rejectedRequests.length,1);const refused=facts.rejectedRequests[0];
  assert.equal(refused.dispatched,false);assert.equal(refused.requests,17);
  assert(!facts.requests.some(r=>r.requestId===refused.requestId),'refused admission is not a provider request');
  assert.equal(report.providerRequests,16);assert.equal(facts.requests.length,16);
  const killed=facts.turns.find(t=>t.killed);assert(killed);
  for(const key of ['actor','sessionId','turn','requests','limit'])assert.equal(killed[key],ev[key]);
  assert.equal(killed.admittedRequests,16);assert.equal(killed.turnFinish,'error');
  assert.equal(report.metrics.assertions.turnLimitHonest,false);assert.equal(report.realProviderRequests,0);
  checks.push('native ceiling: 16 dispatched, request 17 rejected separately, killed turn and report retain full evidence');
}

// 4. The ceiling itself is reported, and a run under it is not excused by the detector.
{
  const clean=load(root+'/repeat/report.json');
  assert.equal(clean.repeatedToolCallLimit,6);assert.equal(clean.turnRequestLimit,16);
  const base=load(root+'/repeat/facts.json');
  const facts=structuredClone(base);
  facts.stop={code:'NATIVE_TURN_REQUEST_LIMIT'};facts.loops=[];
  const summary=summarize(facts);
  assert.equal(summary.assertions.turnLimitHonest,false,'exiting at the ceiling must fail, never pass quietly');
  facts.stop={code:'TIME_STOP'};facts.loops=[{actor:'a1',name:'team_read',count:6}];
  assert.equal(summarize(facts).assertions.turnLimitHonest,false,'a recorded loop fails even when the run stops for the clock');
  checks.push('turnLimitHonest fails for the ceiling exit and for any recorded loop, and only those');
}

fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',checks,realProviderRequests:0},null,2));
console.log('turn limit tests PASS: '+checks.length+' checks');