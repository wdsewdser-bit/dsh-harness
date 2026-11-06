import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildTarget } from '../../adapter-dsh/index.mjs';
import { cleanupOrThrow } from '../test-support/temp-roots.mjs';
import { isRecordAlive, runProcessTree } from '../test-support/process-tree.mjs';
import { runControlled } from '../test-support/controlled-run.mjs';

test('integration candidate: public activation and migration baseline; critical guards killed in isolated copy', {timeout:180000},async()=>{
 const repo=fileURLToPath(new URL('../../..',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-candidate-'));
 let primary=null,retainRoot=false;
 try{
  fs.cpSync(path.join(repo,'packages'),path.join(root,'packages'),{recursive:true,filter:p=>!['node_modules','.scratch'].includes(path.basename(p))});
  // This is a candidate build, never a production activation flag or environment override.
  const contract=path.join(root,'packages/contracts/superagent-borrow.mjs');
  const source=fs.readFileSync(contract,'utf8');assert.equal(source.split("v1: 'contract-only'").length,2);
  fs.writeFileSync(contract,source.replace("v1: 'contract-only'","v1: 'implemented'"));
  const old=spawnSync('git',['show','5325aeb:packages/control-store/index.mjs'],{cwd:repo,encoding:'utf8',timeout:10000});assert.equal(old.status,0,old.stderr);
  fs.writeFileSync(path.join(root,'packages/profiles/test-support/legacy-control-store.mjs'),old.stdout.replaceAll('../contracts/index.mjs',
    '../../contracts/index.mjs').replaceAll('../contracts/team.mjs','../../contracts/index.mjs'));
  fs.mkdirSync(path.join(root,'runs'));
  // The build roots are configuration (build/builds.json); a source copy must carry it, or buildTarget() cannot name
  // the pristine install the adapter composes.
  fs.mkdirSync(path.join(root,'build'),{recursive:true});fs.copyFileSync(path.join(repo,'build','builds.json'),path.join(root,'build','builds.json'));
  const env={...process.env,FORCE_COLOR:'0',DSH_UPSTREAM_BUILD:buildTarget().build};delete env.NODE_TEST_CONTEXT;
  // Each child run gets a parent-owned temp root; TEMP/TMP/TMPDIR point at it, and the parent removes the whole root
  // only after spawnSync has observed the child exit. The candidate's own cleanup is still verified, not assumed.
  const run=async pattern=>{
   const temp=fs.mkdtempSync(path.join(root,'run-tmp-'));
   const pidFiles=[path.join(temp,'candidate.pid'),path.join(temp,'worker.pid')];
   const result=await runControlled({tempRoot:temp,file:'packages/profiles/test-support/borrow-integration-candidate.mjs',
    args:['--test','--test-concurrency=1','--test-reporter=tap',...(pattern?['--test-name-pattern='+pattern]:[])],
    cwd:root,env:{...env,TEMP:temp,TMP:temp,TMPDIR:temp,BORROW_PID_FILE:pidFiles[0],BORROW_WORKER_PID_FILE:pidFiles[1]},
    timeoutMs:60000,pidFiles,maxBuffer:1024*1024});
   assert.equal(fs.existsSync(temp),false,'child temp root must be gone after the child tree exits');
   return result;
  };
  const baseline=await run();assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);assert.match(baseline.stdout,/# pass 11/);assert.match(
    baseline.stdout,/# fail 0/);assert.match(baseline.stdout,/# skipped 0/);
  const mutants=[
   ['profiles/borrow-policy.mjs','assertPolicyCompatible(policy, protocol);','/* mutant: hot switch */','migration: no policy'],
   ['profiles/borrow-policy.mjs','      tx.requireBorrowReader();','      /* mutant: no permanent reader floor */','migration: no policy'],
   ['core/thread-events.mjs',"if (tx.list('thread-resource:').length >= THREAD_RESOURCE_LIMIT)",'if (false)','governance: canonical resource'],
   ['profiles/borrow-policy.mjs','if (!tx.isPristine())', 'if (false)', 'migration: no policy'],
   ['profiles/borrow-policy.mjs',"r.entityId.startsWith('message:') && r.kind === 'intent'",'false', 'migration: stop proof'],
   ['profiles/borrow-policy.mjs','proof.cutoffSeq !== first.head','false','migration: stop proof'],
   ['profiles/borrow-policy.mjs','if (facts.head !== first.head)','if (false)','migration: stop proof'],
   ['profiles/borrow-policy.mjs',"if (to === 'off') for (const row of facts.rows)",'if (false) for (const row of facts.rows)','migration: rollback'],
   ['profiles/runtime.mjs',"if (principal?.kind !== 'owner') return definitions;",'return definitions;','public candidate profile'],
  ];
  mutants.push(
   ['profiles/borrow-policy.mjs',"r.entityId.startsWith('member-intent:') && !['confirmed','cancelled'].includes(r.status)",'false',
     'review migration: lifecycle'],
   ['profiles/borrow-policy.mjs',"proof.from !== (before?.superagentBorrow ?? 'off')",'false','review migration: proof'],
   ['profiles/borrow-policy.mjs',"proof.to !== to",'false','review migration: proof'],
   ['profiles/borrow-policy.mjs','receipt.result.summaryDigest !== digest(summaryValue(summary))','false','review migration: proof'],
   ['profiles/borrow-policy.mjs',"failWith('POLICY_MISMATCH', 'initial policy has no pristine creation evidence');",
     '/* mutant: accept rewritten initial policy */','review migration: proof'],
   ['profiles/runtime.mjs','op: { ...op, enum: permitted }','op','review model: op-refined'],
   ['profiles/borrow-policy.mjs',"check('run-slots', tx.runSlots());",'/* mutant: ignore SQL occupants */','review migration: lifecycle'],
  );
  for(const [file,oldText,newText,pattern] of mutants){
   const target=path.join(root,'packages',file),original=fs.readFileSync(target,'utf8');assert.equal(original.split(oldText).length,2,'one mutant anchor');
   fs.writeFileSync(target,original.replace(oldText,newText));let result;try{result=await run(pattern);}finally{fs.writeFileSync(target,original);}
   const text=result.stdout+result.stderr;assert.equal(result.signal,null);assert.equal(result.error,null);assert.equal(result.status,1,
     'mutant must exit through behavioral failure');assert.notEqual(result.status,0,'surviving mutant '+oldText);assert.match(text,/ERR_ASSERTION/);
     assert.doesNotMatch(text,/SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export/);
  }
  // Controlled timeout in the real topology: parent -> node --test -> candidate -> worker. The worker creates its
  // directory and publishes its PID before the parent starts the timeout; termination waits for every recorded PID.
  const timeoutRoot=fs.mkdtempSync(path.join(root,'timeout-root-'));
  const ready=path.join(timeoutRoot,'ready.json'),candidatePid=path.join(timeoutRoot,'candidate.pid'),workerPid=path.join(timeoutRoot,'worker.pid');
  const timed=await runProcessTree({file:'packages/profiles/test-support/borrow-integration-candidate.mjs',
   args:['--test','--test-concurrency=1','--test-name-pattern=timeout topology'],cwd:root,
   env:{...env,TEMP:timeoutRoot,TMP:timeoutRoot,TMPDIR:timeoutRoot,BORROW_TIMEOUT_TEST:'1',BORROW_TIMEOUT_READY:ready,
    BORROW_PID_FILE:candidatePid,BORROW_WORKER_PID_FILE:workerPid},timeoutMs:5000,readyFile:ready,
   pidFiles:[candidatePid,workerPid]});
  if(timed.terminated!==true){retainRoot=true;throw Object.assign(Error('终止未确认: timeout topology'),{code:'TERMINATION_UNCONFIRMED',processResult:timed});}
  assert.equal(timed.timedOut,true,'the parent must time out the real process tree');
  assert.equal(timed.terminated,true,'every recorded process must be gone before cleanup');
  assert.equal(fs.existsSync(ready),true,'the worker must have created its directory and published readiness before the timeout');
  assert(timed.pids.length>=3,'the direct test runner, candidate and worker must all be recorded: '+JSON.stringify(timed.pids));
  for(const file of [candidatePid,workerPid]){const value=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(typeof value.startTime,'string',
    'pid file must carry its own creation time: '+file);assert.equal(value.source,'estimated','pid file identity must declare its source: '+file);assert(
    value.pid>0);}
  for(const pid of timed.pids){const record=timed.records.find(r=>r.pid===pid);assert(record,'missing identity record: '+pid);assert.equal(
    await isRecordAlive(record),false,'recorded process identity is still alive: '+pid);}
  cleanupOrThrow([timeoutRoot]);assert.equal(fs.existsSync(timeoutRoot),false);
  console.log('borrow integration candidate: 11 baseline cases, 4 real transaction crash cuts, '+mutants.length+'/'+mutants.length+
    ' behavioral mutants killed; no production activation');
 }catch(error){primary=error;if(error.code==='TERMINATION_UNCONFIRMED')retainRoot=true;throw error;}finally{
  if(retainRoot)console.error('retaining unconfirmed candidate root: '+root);else cleanupOrThrow([root],primary);
 }
});
