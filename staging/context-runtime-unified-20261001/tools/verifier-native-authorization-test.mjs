import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import * as plugin from '../home/profiles/web/plugins/verifier-native-capability.mjs';
if(!process.env.DSH_HOME)throw new Error('EXPLICIT_FIXTURE_DSH_HOME_REQUIRED');
const home=path.resolve(process.env.DSH_HOME),phase=process.argv.includes('--red')?'red':'green';
const checks={},results=[];
for(const kind of ['policy','identity','identity-after-ready']){
 const workspace=path.join(home,'authorization-'+kind+'-'+randomUUID());fs.mkdirSync(workspace);
 const session={id:'native-authorization-session',header:{cwd:workspace}},agent={id:'native-authorization-agent',session};
 const root=path.join(workspace,'.dsh-verifier-scratch',session.id),file=path.join(root,'after-revocation.txt');
 let mode='workspace-write',revoked=false,challenge=false,armed=true,unavailable=false,challengePolicyChecks=0;
 const callbacks=new Map(),disposers=[],native={},helpers=[];
 const originalSpawn=childProcess.spawn;
 childProcess.spawn=function(...args){const child=originalSpawn(...args);if(args[1]?.some(value=>String(value).endsWith('verifier-native-host-bridge.ps1'))){helpers.push(child);child.stdout.on('data',chunk=>{if(chunk.toString().includes('"bootstrapReady":true'))challenge=true;});}return child;};syncBuiltinESMExports();
 const ctx={fs:native,agentTeams:{tryMembership:a=>a===agent&&!revoked?{id:'team',name:'v1'}:undefined,listMembers:()=>[{id:agent.id,name:'v1',groupId:'verifier'}]},tools:{get:name=>name==='verifier_scratch'?{async execute(){return{ok:true,ownerSessionId:session.id,root};}}:undefined},get(){return{resolve(){if(unavailable)return undefined;const policy={mode,workspaceRoot:workspace};if(challenge&&armed&&++challengePolicyChecks===(kind==='identity-after-ready'?2:1)){armed=false;queueMicrotask(()=>{if(kind==='policy')mode='read-only';else revoked=true;});}return policy;}};},effect(factory){disposers.push(factory());},on(event,callback){callbacks.set(event,callback);}};
 const supplied={mode:'workspace-write',workspaceRoot:workspace};
 const invoke=async(relative,content,provided=supplied)=>callbacks.get('tools/execute')({agent},async()=>{const target=await native.resolve(path.join(root,relative));return native.writeText(target,content,{kind:'createIfAbsent'},undefined,provided);});
 const alive=()=>helpers.filter(child=>child.exitCode===null&&child.signalCode===null).length;
 plugin.apply(ctx,{enabled:true,isolatedHost:true});
 let outcome;
 try{
  try{outcome=await invoke('after-revocation.txt','must not publish');}catch(error){outcome={error:error.code,message:error.message};}
  checks[kind+'RevocationTriggered']=!armed;
  checks[kind+'OperationDenied']=!!outcome.error;
  checks[kind+'NoArtifact']=!fs.existsSync(file);
  try{fs.renameSync(workspace,workspace+'-released');fs.renameSync(workspace+'-released',workspace);checks[kind+'ReleasedBeforePluginDispose']=true;}catch{checks[kind+'ReleasedBeforePluginDispose']=false;}
  checks[kind+'FailedInitializationReaped']=alive()===0;
  mode='workspace-write';revoked=false;
  const recovered=await invoke('healthy-retry.txt','healthy retry');
  checks[kind+'HealthyRetry']=recovered.after==='healthy retry';
  checks[kind+'OnlyOneHealthyHelper']=alive()===1;
  mode='read-only';let denied=false;
  try{await invoke('stale-permit.txt','must not publish');}catch(error){denied=error.code==='FS_SANDBOX_DENIED';}
  checks[kind+'SuppliedPermitCannotOverrideCurrentDeny']=denied&&!fs.existsSync(path.join(root,'stale-permit.txt'));
  mode='workspace-write';denied=false;
  try{await invoke('provided-deny.txt','must not publish',{mode:'read-only'});}catch(error){denied=error.code==='FS_SANDBOX_DENIED';}
  checks[kind+'SuppliedDenyPreserved']=denied&&!fs.existsSync(path.join(root,'provided-deny.txt'));
  unavailable=true;denied=false;
  try{await invoke('unknown-policy.txt','must not publish');}catch(error){denied=error.code==='FS_SANDBOX_DENIED';}
  checks[kind+'UnknownCurrentPolicyRefused']=denied&&!fs.existsSync(path.join(root,'unknown-policy.txt'));unavailable=false;
  const helper=helpers.find(child=>child.exitCode===null&&child.signalCode===null),originalWrite=helper.stdin.write;
  let dispatched=false;
  helper.stdin.write=function(chunk,...args){const result=originalWrite.call(this,chunk,...args);try{const request=JSON.parse(String(chunk));if(request.op==='write'&&request.relative==='queue-blocker.txt'){dispatched=true;mode='read-only';}}catch{}return result;};
  try{
    const queued=await Promise.allSettled([invoke('queue-blocker.txt','already authorized'),invoke('queued-denied.txt','must not publish')]);
    checks[kind+'QueuedMutationRechecksCurrentPolicy']=dispatched&&queued[0].status==='fulfilled'&&queued[1].status==='rejected'&&queued[1].reason.code==='FS_SANDBOX_DENIED'&&!fs.existsSync(path.join(root,'queued-denied.txt'));
  }finally{helper.stdin.write=originalWrite;mode='workspace-write';}
 }finally{
  for(const dispose of disposers.reverse())await dispose();
  checks[kind+'DisposeReapedAllHelpers']=alive()===0;
  childProcess.spawn=originalSpawn;syncBuiltinESMExports();
 }
 results.push({kind,workspace,outcome,helperCount:helpers.length});
}
const result={scope:'real-helper-challenge-revocation-and-reaping-simulated-native-identity',phase,checks,results,passed:Object.values(checks).every(Boolean)};
fs.writeFileSync(path.join(home,'authorization-'+phase+'-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert.ok(result.passed,JSON.stringify(checks));
