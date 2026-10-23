import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openHandleBridge} from '../home/profiles/web/plugins/verifier-native-transport.mjs';
import {verifierNativeProfilePatch} from './verifier-native-profile-patch.mjs';
if(!process.env.DSH_HOME)throw new Error('EXPLICIT_FIXTURE_DSH_HOME_REQUIRED');
const home=path.resolve(process.env.DSH_HOME),base=path.join(home,'bootstrap-'+randomUUID());fs.mkdirSync(base);
const checks={};
const refusedWorkspace=path.join(base,'refused');fs.mkdirSync(refusedWorkspace);
try{await openHandleBridge(path.join(refusedWorkspace,'.dsh-verifier-scratch','revoked'),{bootstrap:{workspace:refusedWorkspace,workspaceFileId:fs.lstatSync(refusedWorkspace,{bigint:true}).ino.toString(),sessionId:'revoked'},authorizeBootstrap(){throw new Error('identity or policy revoked during initialization');}});checks.initializationRevalidationRefused=false;}catch{checks.initializationRevalidationRefused=!fs.existsSync(path.join(refusedWorkspace,'.dsh-verifier-scratch'));}
const workspace=path.join(base,'workspace');fs.mkdirSync(workspace);
const root=path.join(workspace,'.dsh-verifier-scratch','native-session');
const options=()=>({bootstrap:{workspace,workspaceFileId:fs.lstatSync(workspace,{bigint:true}).ino.toString(),sessionId:'native-session'}});
const denied=async action=>{try{await action();return false;}catch{return true;}};
const first=await openHandleBridge(root,options());
try {
 checks.freshRootAutomaticallyCreated=fs.statSync(root).isDirectory();
 checks.create=(await first.rpc('write','proof.txt',{content:'bootstrap',expected:{kind:'createIfAbsent'}})).after==='bootstrap';
 checks.workspaceRenamePinned=await denied(async()=>fs.renameSync(workspace,workspace+'-moved'));
 checks.namespaceRenamePinned=await denied(async()=>fs.renameSync(path.dirname(root),path.dirname(root)+'-moved'));
 const second=await openHandleBridge(root,options());
 try{checks.concurrentSameRootCapture=(await second.rpc('read','proof.txt')).Content==='bootstrap';const values=await Promise.all([first.rpc('write','a.txt',{content:'a',expected:{kind:'createIfAbsent'}}),second.rpc('write','b.txt',{content:'b',expected:{kind:'createIfAbsent'}})]);checks.concurrentIndependentWrites=values.every(value=>value.operation==='create');}finally{await second.close();}
}finally{await first.close();}
const reopened=await openHandleBridge(root,options());try{checks.sameSessionReopen=(await reopened.rpc('read','proof.txt')).Content==='bootstrap';}finally{await reopened.close();}
fs.renameSync(workspace,workspace+'-moved');fs.renameSync(workspace+'-moved',workspace);checks.disposeReleasesAncestorHandles=true;
checks.workspaceSwapBeforeCapture=await denied(()=>openHandleBridge(root,{...options(),beforeSpawnForFixture(){fs.renameSync(workspace,workspace+'-original');fs.mkdirSync(workspace);}}));
fs.rmdirSync(workspace);fs.renameSync(workspace+'-original',workspace);
checks.existingRootSwapBeforeCapture=await denied(()=>openHandleBridge(root,{...options(),beforeSpawnForFixture(){fs.renameSync(root,root+'-original');fs.mkdirSync(root);}}));
fs.rmdirSync(root);fs.renameSync(root+'-original',root);
const outside=path.join(base,'product');fs.mkdirSync(outside);
checks.namespaceJunctionBeforeCapture=await denied(()=>openHandleBridge(root,{...options(),beforeSpawnForFixture(){fs.renameSync(path.dirname(root),path.dirname(root)+'-original');fs.symlinkSync(outside,path.dirname(root),'junction');}}));
fs.unlinkSync(path.dirname(root));fs.renameSync(path.dirname(root)+'-original',path.dirname(root));
checks.workspaceJunctionBeforeCapture=await denied(()=>openHandleBridge(root,{...options(),beforeSpawnForFixture(){fs.renameSync(workspace,workspace+'-original');fs.symlinkSync(outside,workspace,'junction');}}));
fs.unlinkSync(workspace);fs.renameSync(workspace+'-original',workspace);
checks.productUntouched=fs.readdirSync(outside).length===0;
const invalid=options();invalid.bootstrap.sessionId='../product';checks.invalidSessionRefused=await denied(()=>openHandleBridge(root,invalid));
const leaseWorkspace=path.join(base,'lease-workspace');fs.mkdirSync(leaseWorkspace);
const leaseTest=spawnSync('pwsh',['-NoProfile','-File',fileURLToPath(new URL('./verifier-native-lease-test.ps1',import.meta.url)),'-Workspace',leaseWorkspace,'-WorkspaceFileId',fs.lstatSync(leaseWorkspace,{bigint:true}).ino.toString()],{encoding:'utf8',windowsHide:true});
checks.nativeLeaseLifecycleAndReparse=leaseTest.status===0;
if(leaseTest.status!==0)console.error(leaseTest.stderr);
checks.defaultPatchOff=JSON.stringify(verifierNativeProfilePatch([{test:'preserved'}]))==='[{"test":"preserved"}]';
checks.patchRequiresExplicitIsolation=await denied(async()=>verifierNativeProfilePatch([],{enabled:true}));
const patch=verifierNativeProfilePatch([],{enabled:true,isolatedHost:true});checks.patchOnlyEnablesRequestedPlugin=patch.length===2&&patch[0].id==='write-scope-guard'&&patch[0].config.verifierScratchMode==='session-workspace'&&patch[1].insert.length===1&&patch[1].insert[0].id==='verifier-native-capability';
const sourceHashes=Object.fromEntries(['verifier-native-capability.mjs','verifier-native-transport.mjs','verifier-native-host-bridge.ps1','verifier-native-Capability.cs','verifier-native-BridgeRuntime.cs'].map(name=>[name,createHash('sha256').update(fs.readFileSync(new URL('../home/profiles/web/plugins/'+name,import.meta.url))).digest('hex')]));
const result={scope:'staging-native-handle-bootstrap',fixture:base,checks,sourceHashes,passed:Object.values(checks).every(Boolean)};
fs.writeFileSync(path.join(home,'bootstrap-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));assert.ok(result.passed);
