import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {verifierNativeProfilePatch} from '../tools/verifier-native-profile-patch.mjs';

const stage=fileURLToPath(new URL('..',import.meta.url));
test('explicit scratch opt-in activates its guard mode and backend together without changing permissions or source',()=>{
  const source=[{insert:[{id:'write-scope-guard',config:{enforce:true,scopesFile:'fixture-scopes.json',verifierScratchMode:'legacy'}}]},{id:'unrelated',disabled:true,config:{sandbox:'read-only'}}];
  const before=structuredClone(source);
  assert.deepEqual(verifierNativeProfilePatch(source),source);
  assert.throws(()=>verifierNativeProfilePatch(source,{enabled:true}),/ISOLATED_HOST_OPT_IN_REQUIRED/);
  const patch=verifierNativeProfilePatch(source,{enabled:true,isolatedHost:true});
  assert.deepEqual(source,before);
  assert.deepEqual(patch.slice(0,source.length),source);
  assert.deepEqual(patch.at(-2),{id:'write-scope-guard',config:{verifierScratchMode:'session-workspace'}});
  assert.equal(patch.at(-1).insert[0].id,'verifier-native-capability');
  assert.deepEqual(patch.at(-1).insert[0].config,{enabled:true,isolatedHost:true});
  assert.equal(patch[0].insert[0].config.enforce,true);
  assert.equal(patch[1].config.sandbox,'read-only');
});
const output=path.resolve(stage,'../../output/verifier-native-stage-20261016','canonical-'+randomUUID());
fs.mkdirSync(output,{recursive:true});
async function run(name){
  const directory=path.join(output,name);fs.mkdirSync(directory);
  const env={...process.env,DSH_HOME:directory};
  delete env.NODE_TEST_CONTEXT;delete env.DSH_FIXTURE_LATE_GUARD;delete env.DSH_FIXTURE_PROJECT_OBSERVATION_ACTOR;
  const child=spawn(process.execPath,[path.join(stage,'tools',name+'.mjs')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});
  const timer=setTimeout(()=>child.kill(),90000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
  fs.writeFileSync(path.join(directory,'run.log'),log);assert.equal(code,0,log);
  return directory;
}
test('native staged bootstrap creates fresh scratch through real Cordis filesystem tools and preserves readonly policy',{timeout:100000},async()=>{
  const directory=await run('verifier-native-host-test');
  const result=JSON.parse(fs.readFileSync(path.join(directory,'host-plugin-result.json'),'utf8'));
  assert.equal(result.passed,true);
  for(const name of ['bootstrapWithoutManualMkdir','installedToolsAutomaticActorRouting','readonlyFirstReadDoesNotCreateRoot','readonlyFirstWriteDoesNotCreateRoot','ordinaryNativeDelegation','sameSessionPluginReinstallReadsExistingRoot'])assert.equal(result.checks[name],true,name);
});
test('native bootstrap revocation denies publication, reaps failed helper before plugin disposal, and retries cleanly',{timeout:100000},async()=>{
  const directory=await run('verifier-native-authorization-test');
  const result=JSON.parse(fs.readFileSync(path.join(directory,'authorization-green-result.json'),'utf8'));
  assert.equal(result.passed,true);
  for(const kind of ['policy','identity','identity-after-ready'])for(const name of ['OperationDenied','NoArtifact','ReleasedBeforePluginDispose','FailedInitializationReaped','HealthyRetry','OnlyOneHealthyHelper','QueuedMutationRechecksCurrentPolicy','UnknownCurrentPolicyRefused'])assert.equal(result.checks[kind+name],true,kind+name);
});
