import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
import {GoalGate} from '../goal-gate.mjs';
import {TeamCore,canonical,digest} from '../index.mjs';
import {ControlStore} from '../../store/index.mjs';
import {createGitGuardRunner} from '../../delivery/index.mjs';
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-target-queues-')),repo=path.join(root,'repo');fs.mkdirSync(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true}).trim();
 git('init','-b','main');git('config','user.name','Offline');git('config','user.email','offline@example.invalid');git('commit','--allow-empty','-m','base');
 const base=git('rev-parse','HEAD'),tree=git('rev-parse','HEAD^{tree}');
 const store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true});const keys=generateKeyPairSync('ed25519');let seq=0;
 const publish=(target,parent)=>{
  const candidate=git('commit-tree',tree,'-p',parent,'-m','candidate '+(++seq));const taskId='task:'+seq,deliveryId='delivery:'+taskId;
  core.mutate(taskId,'root',{},tx=>tx.put(taskId,{owner:'member:worker',approved:true,scopeSet:[repo],contractRevision:1,status:'produced'}));
  const certificate={base:parent,candidate,tree,verifier:'member:verifier',contractRevision:1,contractHash:digest({scopeSet:[repo],contractRevision:1,
    approved:true})};
  const row={taskId,owner:'member:worker',directory:repo,base:parent,candidate,tree,target,status:'verified',certificate,certificateHash:digest(certificate),
   signature:sign(null,Buffer.from(canonical(certificate)),keys.privateKey).toString('base64'),publicKey:keys.publicKey.export({type:'spki',format:'pem'})};
  core.dispatch(deliveryId,'root',{}, {type:'delivery.put',payload:{deliveryId,row}});
  git('update-ref',target,candidate);
  core.dispatch(deliveryId,'root',{}, {type:'delivery.transition',payload:{deliveryId,from:'verified',status:'accepted',integrationCommit:candidate,
    integrationTree:tree}});
  return candidate;
 };
 const gate=new GoalGate(core,()=>{},{gitGuard:createGitGuardRunner({roots:[root]})});return {root,repo,git,base,tree,core,store,publish,gate,close(){
   store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('production evidence: different target queues have independent roots and interleaved accept events',()=>{
 const f=fixture();try{const a=f.publish('refs/heads/a',f.base),b=f.publish('refs/heads/b',f.base);f.publish('refs/heads/b',b);f.publish('refs/heads/a',a);
   assert.equal(typeof f.gate.evidence(),'string');}finally{f.close();}
});
test('production evidence: one uncertified descendant on either target blocks the whole team with TARGET_DRIFT',()=>{
 const f=fixture();try{f.publish('refs/heads/a',f.base);const b=f.publish('refs/heads/b',f.base);const child=f.git('commit-tree',f.tree,'-p',b,'-m',
   'uncertified');f.git('update-ref','refs/heads/b',child);assert.throws(()=>f.gate.evidence(),e=>e.code==='TARGET_DRIFT');}finally{f.close();}
});
test('production evidence: even a link-complete chain in reverse acceptance order is DELIVERY_CHAIN_GAP',()=>{
 const f=fixture();try{const a=f.git('commit-tree',f.tree,'-p',f.base,'-m','earlier candidate');f.publish('refs/heads/a',a);f.publish('refs/heads/a',f.base);
   assert.throws(()=>f.gate.evidence(),e=>e.code==='DELIVERY_CHAIN_GAP');}finally{f.close();}
});
