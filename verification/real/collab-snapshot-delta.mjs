import fs from 'node:fs';
import assert from 'node:assert/strict';
import {ControlStore} from '../../packages/store/index.mjs';
import {TeamCore} from '../../packages/core/index.mjs';
import {handleTool} from '../../packages/core/tools.mjs';
import {snapshot} from '../../packages/core/snapshot.mjs';
import {collabConfig} from '../../packages/contracts/index.mjs';
import {canonical, digest} from '../../packages/contracts/index.mjs';

/**
 * The snapshot price of the collaboration block, measured on one committed state.
 *
 * The two stage runs are the experiment, but they do not isolate the block: the on arm also has more messages, more
 * decisions and a different number of requests. This script takes one store state and snapshots it twice, once per arm,
 * so the difference is the block itself. It reports characters (exact) and a token estimate using the same rule the
 * harness uses for every other number: UTF-8 bytes * 2 is the ceiling test, and a 4-chars-per-token estimate is what
 * the offline provider charges, so both are printed and neither is called a measurement of the model.
 */
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const state=core=>{
  for(const m of ['member:fe','member:be','member:qa'])core.member(m,'worker','A');
  core.task('task:fe','member:fe',[]);core.task('task:be','member:be',[]);
  const a=core.schedule('m1','task:fe').result,b=core.schedule('m2','task:be').result;
  return {fe:{actor:'member:fe',attemptId:a.attemptId,fence:a.fence},be:{actor:'member:be',attemptId:b.attemptId,fence:b.fence}};
};
const measure=arm=>{
  const store=new ControlStore(root+'/'+arm);
  try{
    const core=new TeamCore(store,{},{enabled:true,...(arm==='on'?collabConfig({collab:'on'}):{})});
    core.member('member:root','root','root');
    const bind=state(core);
    // The same committed facts on both arms: one delivered message worth accepting, one intent, one assumption,
    // and three decisions. Off has nowhere to put the last two, which is exactly the difference being measured.
    core.send('member:root','member:be','action','Do the backend part',{expectedOutcome:'server.mjs',deadline:new Date(Date.now()+600000).toISOString()});
    if(arm==='on'){
      handleTool(core,bind.fe,'team_message',{operationId:'v1:operation:measure-intent',op:'send',to:['member:be'],kind:'intent',
          summary:'GET /api/todos returns an array of rows',expectedOutcome:'ok, or object',taskRef:'task:fe',contractRevision:1});
      handleTool(core,bind.fe,'team_assume',{operationId:'v1:operation:measure-assume',expectedRevision:0,about:'member:be',claim:
        'ids are server-minted strings',
          impact:'I never post an id'});
      for(let i=0;i<3;i++)handleTool(core,bind.fe,'team_decision',{operationId:'v1:operation:measure-decision-'+i,expectedRevision:0,summary:'decision number '
      +i
          +' about the collection shape'});
    }
    const cand=snapshot(core,'member:be');
    const text=cand.text;
    // The block's own price, isolated from everything else the on arm happens to have queued: the same payload is
    // rendered again with the collab key removed, and the difference is exactly what the mechanisms add.
    const base=cand.payload,copy={...base};delete copy.collab;
    const bareText='<team_snapshot rev="'+base.asOfSeq+'" hash="'+digest(copy)+'">\n'+
      canonical(copy).replaceAll('<','\\u003c').replaceAll('>','\\u003e')+'\n</team_snapshot>';
    return {arm,bytes:Buffer.byteLength(text),blockBytes:Buffer.byteLength(text)-Buffer.byteLength(bareText),
      chars:text.length,tokensEstimate:Math.ceil(text.length/4),
      ceilingBytes:4096,pctOfCeiling:Math.round(Buffer.byteLength(text)*2/4096*1000)/10,
      hasCollab:Object.hasOwn(cand.payload,'collab'),
      decisions:cand.payload.collab?.decisions?.length??0,omitted:cand.payload.collab?.decisionOmitted??0};
  }finally{store.close()}
};
const off=measure('off'),on=measure('on');
const delta={bytes:on.bytes-off.bytes,blockBytes:on.blockBytes,tokensEstimate:on.tokensEstimate-off.tokensEstimate,
  pctOfCeiling:Math.round((on.pctOfCeiling-off.pctOfCeiling)*10)/10};
assert.equal(off.hasCollab,false,'the control arm snapshot carries no collaboration block');
assert.equal(on.hasCollab,true);
assert(on.bytes<=2048,'the block stays inside the unchanged 4096-byte ceiling (payload*2)');
const report={off,on,delta,
  note:'off is the same committed state without the block; bytes are exact, the token figure is the offline provider 4-chars rule and not a model measurement'};
fs.writeFileSync(root+'/report.json',JSON.stringify(report,null,2));
console.log('collab snapshot delta: off '+off.bytes+' B / on '+on.bytes+' B (+'+delta.bytes+' B; the block itself is '+on.blockBytes+' B = +'+Math.ceil(on
    .blockBytes/4)+' est. tokens), ceiling use '+off.pctOfCeiling+'% -> '+on.pctOfCeiling+'%');