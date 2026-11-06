import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '../../store/index.mjs';
import { digest } from '../../contracts/index.mjs';
import { migrateBorrowPolicy } from '../index.mjs';
import { initializeBorrowPolicy } from '../borrow-policy.mjs';
import { installOwnerGuard } from '../runtime.mjs';
import { cleanupOrThrow, withStore } from './temp-roots.mjs';
const dirs=[];
const fresh=()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'borrow-review-'));dirs.push(root);return root;};
let seq=0;
const teamId='team:review', op=()=> 'v1:operation:review-'+String(++seq).padStart(8,'0');
const proof=f=>({...f,terminated:true,evidenceRef:'external:independent-stop'});
function put(s,rows,extra=()=>{}) {const payload={rows};return s.commit({entityId:'review:'+seq,teamId,actor:'adapter',expectedRevision:0,operationId:op(),
  payload,payloadHash:digest(payload)},tx=>{for(const [id,row] of Object.entries(rows))tx.put(id,row);extra(tx);return null;});}
function seed(root){withStore(ControlStore,root,s=>put(s,{'member:root':{role:'root',desired:'active'}}));}
const migrate=(root,extra={})=>migrateBorrowPolicy({root,teamId,to:'v1',operationId:op(),reason:'independent review',verifyQuiescence:proof,...extra});
test.after(()=>cleanupOrThrow(dirs));

test('review migration: lifecycle and unknown member facts cannot be treated as drained',async()=>{
 for(const [id,row] of [
  ['member-intent:applying',{status:'applying'}],['member-intent:unknown',{status:'unknown'}],
  ['member:w',{status:'unknown',observed:'unknown'}],
  ['message:unknown',{kind:'intent',status:'unknown'}],
 ]) {const root=fresh();seed(root);const head=withStore(ControlStore,root,s=>{put(s,{[id]:row});return s.latestEventSeq();});let verified=0;
  await assert.rejects(migrate(root,{verifyQuiescence:f=>{verified++;return proof(f);}}),e=>e.code==='MIGRATION_REQUIRED',id);
  assert.equal(verified,0,'persistent blockers precede any external proof');withStore(ControlStore,root,s=>assert.equal(s.latestEventSeq(),head));
 }
 const orphan=fresh();seed(orphan);const orphanDb=new DatabaseSync(path.join(orphan,'state-v2/control.sqlite'));
 try{orphanDb.prepare('INSERT INTO run_slots VALUES(?,?,?)').run('attempt:orphan','member:w','task:w');}finally{orphanDb.close();}
 await assert.rejects(migrate(orphan),e=>e.code==='MIGRATION_REQUIRED','orphan SQL occupancy is not drained');
 for(const status of ['pending','retryable','applying','unknown']) {const root=fresh();seed(root);withStore(ControlStore,root,s=>put(s,{},tx=>tx.outbox(
   'wake:review',{kind:'wake'})));
  const db=new DatabaseSync(path.join(root,'state-v2/control.sqlite'));try{db.prepare('UPDATE outbox SET data=?').run(JSON.stringify({id:'wake:review',
    payload:{kind:'wake'},status}));}finally{db.close();}
  await assert.rejects(migrate(root),e=>e.code==='MIGRATION_REQUIRED','wake '+status);
 }
});

test('review migration: proof direction and saved summary are authenticated, not merely present',async()=>{
 for(const wrong of [{root:'another-database'},{from:'v1'},{to:'off'}]){const root=fresh();seed(root);await assert.rejects(migrate(root,{verifyQuiescence:f=>({
   ...proof(f),...wrong})}),e=>e.code==='MIGRATION_REQUIRED');}
 for(const patch of [{reason:'rewritten reason'},{cutoffSeq:0},{archived:['thread:invented']}]) {const root=fresh();seed(root);const receipt=await migrate(
   root);withStore(ControlStore,root,s=>{const ref=receipt.result.migrationRef;
  put(s,{[ref]:{...s.read(ref),...patch}});assert.throws(()=>initializeBorrowPolicy(s,teamId,'v1'),e=>e.code==='POLICY_MISMATCH');});
 }
 const root=fresh();seed(root);await migrate(root);withStore(ControlStore,root,s=>{const id='team-policy:'+teamId;
  put(s,{[id]:{...s.read(id),migrationRef:null}});assert.throws(()=>initializeBorrowPolicy(s,teamId,'v1'),e=>e.code==='POLICY_MISMATCH');});
});

test('review migration: cleanup failures preserve the primary refusal and release ownership',async()=>{
 const root=fresh();seed(root);const primary=Object.assign(Error('independent proof unavailable'),{code:'REVIEW_PRIMARY'}),close=ControlStore.prototype.close;
 ControlStore.prototype.close=function(){close.call(this);throw Error('injected close failure');};
 try {await assert.rejects(migrate(root,{verifyQuiescence:()=>{throw primary;}}),e=>e===primary&&e.cleanupErrors?.[0]?.message==='injected close failure');}
 finally {ControlStore.prototype.close=close;}
 assert.equal((await migrate(root)).result.to,'v1','ownership must be released even when close fails');
});

test('review migration: pristine means every authoritative table, not only entities',()=>{
 const inserts={events:db=>db.prepare('INSERT INTO events(entity,revision,operationId,schema,payload) VALUES(?,?,?,?,?)').run('old',1,op(),1,'{}'),operations:
   db=>db.prepare('INSERT INTO operations VALUES(?,?,?)').run(op(),'hash','{}'),outbox:db=>db.prepare('INSERT INTO outbox VALUES(?,?)').run('old','{}'),inbox:
   db=>db.prepare('INSERT INTO inbox VALUES(?,?)').run('old','old'),cursors:db=>db.prepare('INSERT INTO cursors(id, seq) VALUES(?,?)').run('old',1),run_slots:
   db=>db.prepare('INSERT INTO run_slots VALUES(?,?,?)').run('old','owner','task')};
 for(const [name,insert] of Object.entries(inserts)){const root=fresh();withStore(ControlStore,root,()=>{});const db=new DatabaseSync(path.join(root,
   'state-v2/control.sqlite'));try{insert(db);}finally{db.close();}
  withStore(ControlStore,root,s=>{assert.throws(()=>initializeBorrowPolicy(s,teamId,'v1'),e=>e.code==='MIGRATION_REQUIRED',name);assert.equal(s.read(
    'team-policy:'+teamId),null);});
 }
});

test('review model: op-refined object schemas and execution use the same capabilities',()=>{
 const ctx={on:()=>()=>{},tools:{roleToolBoundary:{version:'role-tool-boundary/1',install(){},current:()=>null}}},core={configuration:{collab:'on',autonomy:
   'on'},store:{read:()=>({role:'root'})}};
 const guard=installOwnerGuard({ctx,core,authorize:(_k,f)=>f(),route:()=>({routed:true,kind:'owner',teamId}),borrow:{superagentBorrow:'v1',teamId}});
   guard.bindOwnerSession('owner');
 const definition={name:'op_read',parameters:{type:'object',properties:{op:{enum:['read','write']}},required:['op'],additionalProperties:false}};
 guard.register({identity:definition.name,implementation:definition,capabilities:['opaque'],operations:{read:['read-local'],write:['write-local']},source:
   'trusted-review'});
 const visible=guard.visibleDefinitions([definition],'owner');assert.equal(visible.length,1,'allowed read operation must be visible');
 assert.deepEqual(visible[0].parameters.properties.op.enum,['read']);
 assert.doesNotThrow(()=>guard.assertCall({sessionId:'owner',identity:definition.name,implementation:definition,operation:'read'}));
 assert.throws(()=>guard.assertCall({sessionId:'owner',identity:definition.name,implementation:definition,operation:'write'}),e=>e.code==='ROLE_GUARD_DENIED');
   guard.revoke();
});
