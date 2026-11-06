import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {closeRealFixture} from '../../packages/host/test-support/cleanup.mjs';
const confirmed={state:'stopped',timedOut:false,isolated:false,store:'closed',ownership:'released'};
test('confirmed stop retries only finite Windows deletion races and preserves original test error',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'test-clean-'));let attempts=0,closed=0;const delays=[];
 const result=await closeRealFixture({root,host:{stop:async()=>confirmed},store:{close(){closed++;}},remove:p=>{if(++attempts<3)throw Object
       .assign(Error('scanner lock'),{code:'EPERM'});fs.rmSync(p,{recursive:true});},wait:async ms=>delays.push(ms)});
 assert.equal(result.removed,true);assert.equal(attempts,3);assert.equal(closed,1);assert.deepEqual(delays,[20,50]);assert.equal(result.stopResult,confirmed);
 const kept=fs.mkdtempSync(path.join(os.tmpdir(),'test-clean-keep-')),original=Object.assign(Error('body assertion'),{code:'BODY'});let calls=0;
 try{
  const failed=await closeRealFixture({root:kept,host:{stop:async()=>confirmed},store:{close(){}},error:original,remove(){calls++;throw Object
        .assign(Error('locked'),{code:'EPERM'});},wait:async()=>{}});
  assert.equal(failed.removed,false);assert.equal(calls,5);assert.equal(fs.existsSync(kept),true);assert.equal(failed.originalError.message,original.message);
  assert.equal(original.cleanupDiagnostics,failed.diagnostics);
  const saved=JSON.parse(fs.readFileSync(failed.diagnostics,'utf8'));assert.equal(saved.originalError.code,'BODY');assert.equal(saved.cleanupError.code,
    'EPERM');
 }finally{fs.rmSync(kept,{recursive:true,force:true});}
});
test('unconfirmed isolated stop never deletes or replaces the body failure',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'test-clean-isolate-')),original=Error('original failure');let removes=0;
 try{
  const result=await closeRealFixture({root,host:{stop:async()=>({...confirmed,timedOut:true,isolated:true,ownership:'isolated'})},store:{close(){}},
      error:original,remove(){removes++;}});
  assert.equal(removes,0);assert.equal(result.removed,false);assert.equal(result.stopResult.ownership,'isolated');assert.equal(result.originalError.message,
    'original failure');assert.ok(original.cleanupDiagnostics);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
