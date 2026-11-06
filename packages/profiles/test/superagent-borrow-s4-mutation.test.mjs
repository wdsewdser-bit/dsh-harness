import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {
  createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';import {runControlled} from '../test-support/controlled-run.mjs';import {runMutant,
  firstRunTail} from '../test-support/mutant-policy.mjs';import {buildTarget} from '../../adapter-dsh/index.mjs';
test('P4 critical guards: isolated baseline is green, all capacity/source/IO/owner/tool/index mutants fail behavioral assertions', {timeout:300000},async()=>{
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'s4-mutants-'));
 const domain='packages/core/test/superagent-borrow-s4.test.mjs',io='packages/host/test/superagent-borrow-s4-io.test.mjs',owner=
   'packages/profiles/test/superagent-borrow-s4-owner.test.mjs',entries='packages/profiles/test/runtime-execution-entries.test.mjs';
 try{
  fs.cpSync(path.join(repo,'packages'),path.join(dir,'packages'),{recursive:true,filter:p=>!['node_modules','.scratch'].includes(path.basename(p))});
  fs.mkdirSync(path.join(dir,'runs'),{recursive:true});
  // The build roots are configuration (build/builds.json); a source copy must carry it, or buildTarget() cannot name
  // the pristine install the adapter composes.
  fs.mkdirSync(path.join(dir,'build'),{recursive:true});fs.copyFileSync(path.join(repo,'build','builds.json'),path.join(dir,'build','builds.json'));
  const env={...process.env,FORCE_COLOR:'0',DSH_UPSTREAM_BUILD:buildTarget().build};delete env.NODE_TEST_CONTEXT;
  // A run is bounded by progress, not by wall clock: a loaded machine that keeps producing TAP output is slower, not hung.
  const run=async(files,pattern=null)=>{
    const tempRoot=fs.mkdtempSync(path.join(dir,'run-tmp-'));
    const result=await runControlled({tempRoot,file:files.at(-1),args:['--test','--test-concurrency=1','--test-reporter=tap',...(pattern?[
      '--test-name-pattern='+pattern]:[]),...files.slice(0,-1)],cwd:dir,env:{...env,TEMP:tempRoot,TMP:tempRoot,TMPDIR:tempRoot},idleTimeoutMs:120000,timeoutMs:
      180000});
    // No verdict here: a stalled or capped first run must reach runMutant(), which is the only place that may retry it.
    // The baseline and the final mutant verdict assert stalled/timedOut/terminated themselves.
    return result;
  };
  const manifestOf=root=>{const out=new Map();const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,
    entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile())out.set(path.relative(root,full).split(path.sep).join('/'),createHash('sha256').update(
    fs.readFileSync(full)).digest('hex'));}};walk(root);return out;};
  const drift=(before,after)=>[...new Set([...before.keys(),...after.keys()])].filter(file=>before.get(file)!==after.get(file)).sort();
  const baselineFiles=manifestOf(path.join(dir,'packages'));
  const baseline=await run([domain,io,owner,entries]);
  assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);assert.match(baseline.stdout,/# pass [1-9]/);assert.match(baseline.stdout,/# fail 0/);
  assert.equal(baseline.stalled??false,false,'the baseline made no progress: '+baseline.stopReason);
  assert.equal(baseline.timedOut??false,false,'the baseline hit its 180s hard cap: '+baseline.stopReason);
  assert.equal(baseline.terminated,true,'the baseline tree was not confirmed gone');
  const mutants=[
   {file:'host/src/effect-runner.mjs',old:"if(!slot || slot.reclaimed || stopped)return {unknown:true,reason:'readback dispatch isolated'};",replacement:
     '/* mutant: dispatch readback after isolation */',test:io,killed:'H06 stopped readback'},
   {file:'core/runtime.mjs',old:'orderedCandidates.sort((a,b)=>readyAt(a)-readyAt(b)||a.localeCompare(b));',replacement:
     '/* mutant: ID order can starve old work/mail */',test:domain,killed:'H07 normal FIFO'},
   {file:'host/src/effect-runner.mjs',old:' && (!capacityLanes || (!slot.closeIO && !slot.closeUnknown))',replacement:'',test:io,killed:'H06 readback timeout'},
   {file:'core/control-capacity.mjs',old:"runs.filter(a=>a.lease==='unknown').length",replacement:
     "runs.filter(a=>a.lease==='unknown'&&a.capacityLane==='human').length",test:domain,killed:'H06 normal unknown'},
   {file:'host/src/effect-runner.mjs',old:'[row.effectId ?? row.id,row.fence]',replacement:'[row.effectId ?? row.id]',test:io,killed:'H06 stale index'},
   {file:'host/src/effect-runner.mjs',old:"effect-io:' + effectId + ':' + String(fence)",replacement:"effect-io:' + effectId",test:io,killed:
     'H06 claim identity'},
   {file:'host/src/effect-runner.mjs',old:'startedAt: slot.startedAt,',replacement:'startedAt: null,',test:io,killed:'H06 claim fields'},
   {file:'host/src/effect-runner.mjs',old:'attemptId: slot.attemptId ?? null });',replacement:'attemptId: null });',test:io,killed:'H06 claim fields'},
   {file:'host/src/effect-runner.mjs',old:'if (slot.identityMissing === true)',replacement:'if (false)',test:io,killed:'H06 legacy index'},
   {file:'host/src/effect-runner.mjs',old:'const persistedKey=row.entityId&&row.entityId!==claimKey?row.entityId:undefined;',replacement:
     'const persistedKey=undefined;',test:io,killed:'legacy idempotency'},
   {file:'profiles/llm-execution.mjs',old:'if(!entryAllows(entry,label))',replacement:'if(borrowV1 && !entryAllows(entry,label))',test:entries,killed:
     'capability binding matrix'},
   {file:'profiles/llm-execution.mjs',old:'if(borrowV1 && !scope && !owner)',replacement:'if(borrowV1 && !scope)',test:entries,killed:
     'capability binding matrix'},
   {file:'profiles/llm-execution.mjs',old:"if(entry!==null && entry!==undefined && entry!=='owner-conversation')",replacement:'if(false)',test:entries,
     killed:'operation-bound'},
   {file:'profiles/llm-execution.mjs',old:'Boolean(HOST_ENTRY_OPERATIONS[entry]?.includes(label))',replacement:'true',test:entries,killed:'operation-bound'},
   {file:'core/control-capacity.mjs',old:"if (used[lane] >= (lane === 'human' ? 1 : maxRuns)) fail('CAPACITY');",replacement:
     '/* mutant: no capacity bounds */',test:domain,killed:'H01/H05'},
   {file:'host/src/gateway.mjs',old:'const principal=authenticate(credential);',replacement:
     "const principal={teamId,ownerSessionId,authenticatedEntry:'owner-user-input'};",test:domain,killed:'H04'},
   {file:'core/control-capacity.mjs',old:"(!p.recipient||p.recipient===m.recipient)",replacement:'true',test:domain,killed:'H04'},
   {file:'host/src/effect-runner.mjs',old:'if(capacityLanes)continue;break;',replacement:'if(capacityLanes)break;break;',test:io,killed:'H01/H03/H08'},
   {file:'host/src/effect-runner.mjs',old:'ioDone && closeDone && (!capacityLanes || slot.terminal)',replacement:'closeDone',test:io,killed:'H06: timeout'},
   {file:'host/src/effect-runner.mjs',old:'stop() { stopped = true;',replacement:'stop() { stopped = true; activeIO.clear();',test:io,killed:'H06: timeout'},
   {file:'core/control-capacity.mjs',old:"state:terminal?'released':'unknown'",replacement:"state:'released'",test:owner,killed:'H06 owner unknown'},
   {file:'profiles/llm-execution.mjs',old:'a.ended && !a.calls.size && !a.pending.size && !a.unknown',replacement:'a.ended',test:owner,killed:
     'H06 owner unknown'},
   {file:'profiles/runtime.mjs',old:"if(attempt?.runClass==='human-mailbox')",replacement:'if(false)',test:owner,killed:'H05 final tool boundary'},
   {file:'store/index.mjs',old:"if (id.startsWith('attempt:') && data.capacityLane === 'human')",replacement:'if (false)',test:domain,killed:'H02/H07'},
   {file:'profiles/llm-execution.mjs',old:"if(['error','aborted','cancelled','cancel'].includes(event.data?.reason?.kind))",replacement:'if(false)',test:
     owner,killed:'B07/H02/H06/H07 real owner unknown'},
   {file:'profiles/llm-execution.mjs',old:' || identities.getStore()!==active.id',replacement:'',test:owner,killed:'H06 owner unknown'},
   {file:'core/control-capacity.mjs',old:"if (queuedHumans(tx).length) fail('CAPACITY');",replacement:'/* mutant: no human priority */',test:domain,killed:
     'H07: ordinary mailbox'},
  ];
  for(const m of mutants){
   const file=path.join(dir,'packages',m.file),original=fs.readFileSync(file,'utf8');assert.equal(original.split(m.old).length,2,'one mutant anchor '+m.old);
   fs.writeFileSync(file,original.replace(m.old,m.replacement));let attempt;try{
    // Only an identified infrastructure failure (spawn EBUSY, stalled, killed by signal) is retried; a first run that
    // exits 0 is a survivor and is never retried, and NOT_ROUTED is a verdict about the tree, not infrastructure.
    attempt=await runMutant(()=>run([m.test],m.killed),{maxAttempts:2});
   }finally{fs.writeFileSync(file,original);}
   const result=attempt.result,output=result.stdout+result.stderr,evidence=' ('+attempt.evidence+')';
   // stalled and timedOut are separate verdicts; neither may hide behind the other.
   assert.equal(result.stalled??false,false,'run made no progress for 120s'+evidence+': '+result.stopReason+'\n'+output);
   assert.equal(result.timedOut??false,false,'run hit its 180s hard cap'+evidence+': '+result.stopReason+'\n'+output);
   assert.equal(result.terminated,true,'the controlled tree was not confirmed gone'+evidence);
   assert.equal(attempt.history[0].status===0,false,'the first run already survived; retrying would launder it: '+m.file+' '+m.old+'\n'+(attempt.history[
     0].stdout+attempt.history[0].stderr));
   assert.notEqual(result.status,0,'survived '+m.file+' '+m.old+evidence+(attempt.retried?'\nfirst run:\n'+firstRunTail(attempt.history[0]):'')+'\n'+output);
   assert.match(output,/failureType: 'testCodeFailure'/,m.killed+evidence);assert.match(output,/ERR_ASSERTION/,m.killed+
     ' died without a behavioral assertion'+evidence);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export/);
   assert(output.includes('not ok')&&output.includes(m.killed),'wrong killed case '+output);
  }
  // The sha256 manifest proves that the SOURCE is restored to the bytes that produced the green baseline; it is not a
  // second run and does not prove the run is green. It holds because the build stays external (build/builds.json names
  // the pristine install; the copy carries the same file), the isolated runs/ directory is never written by a mutation
  // run, and the environment (DSH_UPSTREAM_BUILD, TEMP/TMP/TMPDIR inside the copy) is the same for baseline and mutants.
  // A drift names every file that was not restored.
  const restoredFiles=manifestOf(path.join(dir,'packages')),changed=drift(baselineFiles,restoredFiles);
  assert.deepEqual(changed,[],'the source was not restored to the baseline bytes: '+changed.slice(0,5).join(', '));
  assert.equal(restoredFiles.size,baselineFiles.size,'the restored source keeps every baseline file');
  console.log('P4 mutation: '+mutants.length+'/'+mutants.length+
    ' killed by behavioral assertions; baseline nonzero/green; source restored: the tree is byte-identical to the '+baselineFiles.size+
    '-file baseline (same external build, runs/ and environment), so its evidence is reused');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
