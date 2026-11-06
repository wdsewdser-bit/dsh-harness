import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { profile } from '../test-support/profile.mjs';
import { TeamManager } from '../index.mjs';
test('F12 production profile manager persists owner identity, rejects a second manager without registry mutation, and reopens',async()=>{
 const first=await profile({ownerSessionId:'session:owner'});const root=first.root;let second;
 try{
  const manager=first.runtime.manager,teamId=first.runtime.host.teamId;
  const before=fs.readFileSync(manager.registry.file);
  const competitor=new TeamManager({home:root});await assert.rejects(competitor.open(),{code:'REGISTRY_LOCKED'});
  assert.deepEqual(fs.readFileSync(manager.registry.file),before);
  const entries=await Promise.all([manager.ensureOwner({ownerSessionId:'session:owner',root}),manager.ensureOwner({ownerSessionId:'session:owner',root})]);
  assert.equal(entries[0],first.runtime.host);assert.equal(entries[1],first.runtime.host);assert.equal(entries[0].teamId,teamId);assert.equal(entries[
    1].teamId,teamId);assert.equal(manager.registry.list().length,1);assert.equal(manager.size,1);
  await first.close({remove:false});second=await profile({root,ownerSessionId:'session:owner'});
  assert.equal(second.runtime.host.teamId,teamId);assert.equal(second.runtime.manager.registry.list().length,1);
  assert.equal(second.runtime.router.routeOwner('session:owner').teamId,teamId);
 }finally{if(second)await second.close();else{await first.close();}}
});
