import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {closeRealFixture} from '../../packages/host/test-support/cleanup.mjs';
for(const fault of ['stop','remove'])test('cleanup preserves body exception after '+fault+' failure',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'stop-errors-'));const body=Error('body remains primary');let removes=0,closed=0;
 try{const result=await closeRealFixture({root,error:body,host:{async stop(){if(fault==='stop')throw Object.assign(Error('stop broke'),{code:'STOP_BROKE'});
           return {state:'stopped',timedOut:false,isolated:false,store:'closed',ownership:'released'};}},store:{close(){closed++;}},remove(){removes++;
           throw Object
         .assign(Error('not retryable'),{code:'EACCES'});}});
 assert.equal(result.removed,false);assert.equal(removes,fault==='stop'?0:1);assert.equal(closed,1);assert.equal(result.originalError.message,body.message);
 assert.ok(body.cleanupDiagnostics);assert.equal(fs.existsSync(root),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
