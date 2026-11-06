import assert from 'node:assert/strict';import {ControlStore} from '../../packages/store/index.mjs';import {TeamCore} from '../../packages/core/index.mjs';
import {Projection} from '../../packages/projections/index.mjs';const s=new ControlStore(process.argv[2]),c=new TeamCore(s,{}, {enabled:true});c
.member('member:root','root');c.member('member:a','worker');const p=new Projection(s,{recentLimit:2});assert.throws(()=>new Projection(s,{recentLimit:0}),
  /INVALID_RETENTION/);const m=c.send('member:root','member:a','info','late fixture').result;const original=p.snapshot('member:root').data.messages.find(x=>x
  .id===m.entityId).receipts.stored.at;c.mutate(m.entityId,'root',{},(tx,r)=>tx.put(m.entityId,{...r,status:'resolved'}));for(let i=0;i<10;i++){c
  .mutate('checkpoint:late:'+i,'root',{},tx=>tx.put('checkpoint:late:'+i,{i}));p.sync()}assert(!p.rows.has(m.entityId));c.mutate(m.entityId,'root',{},(tx,r)=>tx
  .put(m.entityId,{...r,summary:'late update'}));assert.equal(p.snapshot('member:root').data.messages.find(x=>x.id===m.entityId).receipts.stored.at,original);
const cold=new Projection(s,{recentLimit:2});assert.deepEqual(cold.snapshot('member:root'),p.snapshot('member:root'));assert.throws(()=>p.events('member:root',
    -1),/INVALID_CURSOR/);console.log('late receipt/restart/invalid cursor PASS');s.close();
