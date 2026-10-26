import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openHandleBridge } from '../home/profiles/web/plugins/verifier-native-transport.mjs';
if(!process.env.DSH_HOME)throw new Error('EXPLICIT_FIXTURE_DSH_HOME_REQUIRED');
const here=path.resolve(process.env.DSH_HOME),fixture=path.join(here,'transport-fixture-'+randomUUID());fs.mkdirSync(fixture);
const toolDirectory=path.dirname(fileURLToPath(import.meta.url));
const namespace=path.join(fixture,'namespace'),root=path.join(namespace,'owned'),product=path.join(fixture,'fake-product');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(path.join(product,'owned'),{recursive:true});
const checks={};
let refused=false;
try{await openHandleBridge(root,{beforeSpawnForFixture(){fs.renameSync(namespace,namespace+'-original');fs.symlinkSync(product,namespace,'junction');}});}catch{refused=true;}finally{fs.unlinkSync(namespace);fs.renameSync(namespace+'-original',namespace);}
checks.ancestorJunctionAtCaptureRefused=refused&&fs.readdirSync(path.join(product,'owned')).length===0;
refused=false;
try{await openHandleBridge(root,{beforeSpawnForFixture(){fs.renameSync(root,root+'-original');fs.mkdirSync(root);}});}catch{refused=true;}finally{fs.rmdirSync(root);fs.renameSync(root+'-original',root);}
checks.samePathDifferentObjectRefused=refused;
const healthy=await openHandleBridge(root);const created=await healthy.rpc('write','normal.txt',{content:'native physical',expected:{kind:'createIfAbsent'}});await healthy.close();
checks.nodeInoMatchesNativeFileId=!!healthy.expectedFileId&&created.after==='native physical'&&fs.readFileSync(path.join(root,'normal.txt'),'utf8')==='native physical';
refused=false;
try{await openHandleBridge(root,{bridgeScriptForFixture:path.join(toolDirectory,'verifier-native-fault-ready.ps1')});}catch{refused=true;}
checks.readyFailureNoServiceOrLateWrite=refused&&!fs.existsSync(path.join(root,'late-write.txt'));
const fault=await openHandleBridge(root,{bridgeScriptForFixture:path.join(toolDirectory,'verifier-native-fault-protocol.ps1')});
const responses=await Promise.allSettled([fault.rpc('read','normal.txt'),fault.rpc('write','late-write.txt',{content:'must not dispatch'})]);
await fault.close();
checks.protocolFailureStopsQueuedDispatch=responses.every(value=>value.status==='rejected')&&fault.state==='failed'&&!fs.existsSync(path.join(root,'late-write.txt'));
const release=path.join(fixture,'release'),results=[];
const inputFault=spawn('pwsh',['-NoProfile','-File',path.join(toolDirectory,'verifier-native-input-fault-fixture.ps1'),'-ControllerDerivedRoot',root,'-ControllerExpectedFileId',fs.statSync(root,{bigint:true}).ino.toString(),'-ReleaseFile',release],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let errorText='',sent=false,released=false;
const timer=setTimeout(()=>{inputFault.kill();},25000);
const lines=createInterface({input:inputFault.stdout});
lines.on('line',line=>{const value=JSON.parse(line);results.push(value);if(value.ready)inputFault.stdin.write(JSON.stringify({id:1,op:'write',relative:'active-cancel.txt',content:'must not publish',expected:{kind:'createIfAbsent'}})+'\n');});
inputFault.stderr.on('data',chunk=>{
  errorText+=chunk;
  if(!sent&&errorText.includes('FIXTURE_BEFORE_PUBLICATION')){sent=true;inputFault.stdin.write(JSON.stringify({id:2,op:'write',relative:'queued-cancel.txt',content:'must not dispatch'})+'\n{invalid-json\n');}
  if(!released&&errorText.includes('JsonReaderException')){released=true;fs.writeFileSync(release,'release after real reader fault');inputFault.stdin.end();}
});
const code=await new Promise((resolve,reject)=>{inputFault.once('error',reject);inputFault.once('close',resolve);});clearTimeout(timer);lines.close();
checks.realInputFaultCancelsActiveBeforePublication=code===0&&sent&&released&&results.some(value=>value.id===1&&value.error?.code==='FS_ABORTED')&&!fs.existsSync(path.join(root,'active-cancel.txt'));
checks.realInputFaultCancelsQueuedWrite=results.some(value=>value.id===2&&value.error?.code==='FS_ABORTED')&&!fs.existsSync(path.join(root,'queued-cancel.txt'));
checks.realInputFaultLeavesNoTemporaryFiles=fs.readdirSync(root).every(name=>name==='normal.txt');
fs.writeFileSync(path.join(here,'input-fault-result.json'),JSON.stringify({code,results,errorText,checks: {active:checks.realInputFaultCancelsActiveBeforePublication,queued:checks.realInputFaultCancelsQueuedWrite,clean:checks.realInputFaultLeavesNoTemporaryFiles}},null,2));
assert.ok(Object.values(checks).every(Boolean),JSON.stringify(checks));
fs.writeFileSync(path.join(here,'transport-result.json'),JSON.stringify({scope:'real-root-binding-negative-controls-and-synthetic-protocol-fault-injection',fixture,checks,passed:true},null,2));console.log(JSON.stringify(checks));
