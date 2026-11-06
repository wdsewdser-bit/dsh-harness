import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {saveFailure,spawnFailure} from '../failure-diagnostics.mjs';
test('failure diagnostics preserve full output, spawn metadata and stage facts across cleanup',()=>{
  const output='start\n'+'x'.repeat(500001)+'\nend',error=Object.assign(Error('busy'),{path:'node',spawnargs:['suite'],code:'EBUSY',errno:-4082});
  const root=fs.mkdtempSync(path.resolve('runs','diagnostic-test-'));fs.mkdirSync(path.join(root,'stage'));fs.writeFileSync(path.join(root,'stage',
    'facts.json'),
    '{}');
  const dir=saveFailure({label:'test',output,error,roots:[root]});fs.rmSync(root,{recursive:true,force:true});
  try {
    assert.equal(fs.readFileSync(path.join(dir,'output.log'),'utf8'),output);
    const report=JSON.parse(fs.readFileSync(path.join(dir,'failure.json'),'utf8'));
    assert.deepEqual(report.spawnError,spawnFailure(error));assert.equal(report.artifacts.length,1);assert.ok(fs.existsSync(report.artifacts[0]));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
