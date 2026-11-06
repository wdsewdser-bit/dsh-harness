import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from '../test-support/profile.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { applyTeamProjections as projections } from '../../profiles/index.mjs';
test('production HTTP adjudication uses authenticated compound identity and host-resolved log, rejecting five classes',async()=>{
 let events=[{seq:7,type:'goal/change',data:{goal:{id:'goal:a',revision:2,objective:'done',maxGoalRounds:3,phase:'complete'}}}];
 const w=await profile({},({root,sessions})=>{
  const store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true});
  core.mutate('completion:auth','operator',{},tx=>tx.put('completion:auth',{status:'unknown',input:{sessionId:'session:auth',goal:{id:'goal:a',revision:1,
    objective:'done',maxGoalRounds:3}}}));store.close();
  sessions.set('session:auth',{id:'session:auth',seq:7,snapshotEvents:()=>events});
 });
 try{
  const teamId=w.runtime.host.teamId;
  await projections(w.ctx,{port:40299,sessions:{operator:{teamId,memberId:'operator'},root:{teamId,memberId:'member:root'},other:{teamId:'team:other',
    memberId:'operator'}}});
  const post=async(token,args)=>{const res=await fetch('http://127.0.0.1:40299/team/commands',{method:'POST',headers:{authorization:'Bearer '+token,
    'content-type':'application/json'},body:JSON.stringify({name:'completion.resolve',args})});return {status:res.status,body:await res.json()};};
  const request={tokenId:'completion:auth',decision:'consumed',evidence:{seq:7},actor:'operator',session:{id:'forged'},log:{complete:true,events:[]}};
  assert.equal((await post('root',request)).status,400);
  assert.equal((await post('operator',{...request,evidence:{seq:99}})).status,400);
  const good=events;events=[{...good[0],data:{goal:{...good[0].data.goal,id:'goal:other'}}}];assert.equal((await post('operator',request)).status,400);
  events=[{...good[0],data:{goal:{...good[0].data.goal,objective:'wrong'}}}];assert.equal((await post('operator',request)).status,400);
  assert.equal(w.runtime.store.read('completion:auth').status,'unknown');events=good;
  assert.equal((await post('operator',request)).status,200);
  assert.equal(w.runtime.store.read('completion:auth').status,'consumed');assert.equal(w.runtime.host.status().admission,true);
  assert.equal((await post('operator',{...request,decision:'cancelled'})).status,400);
  const empty=await fetch('http://127.0.0.1:40299/team/projection/snapshot',{headers:{authorization:'Bearer other'}});assert.equal((await empty.json()).data,
    null);
 }finally{await w.ctx.teamProjections?.transport.close();await w.close();}
});
