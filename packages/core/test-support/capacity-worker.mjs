import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ControlStore} from '../../store/index.mjs';
import {TeamCore,drain,capacityUsage} from '../index.mjs';
const [dir,index]=process.argv.slice(2),store=new ControlStore(dir),core=new TeamCore(store,{}, {enabled:true,attach:true,
 teamId:'team:h',maxRuns:1,autonomy:'on',collab:'on',superagentBorrow:'v1',intentSemantics:'root-decision-v1'});
const waitCell=new Int32Array(new SharedArrayBuffer(4));
process.on('message',message=>{
 if(message==='done'){store.close();process.disconnect();return;}
 const {round}=message,errors=[],violations=[];let accepted=0,commits=0,heldAt=null,heldUntil=null;
 const started=process.hrtime.bigint().toString();
 fs.writeFileSync(path.join(dir,'barrier-'+round+'-'+index),'entered');
 store.hooks.beforeCommit=()=>{
  commits++;const used=capacityUsage(store);
  if(used.normal>1||used.human>1)violations.push({normal:used.normal,human:used.human});
  for(const a of used.runs.filter(a=>a.capacityLane==='human'))if(!used.slots.some(s=>s.holderRef===a.entityId&&s.state==='held'))violations.push(
    'missing mailbox index');
  // Keep a real BEGIN IMMEDIATE transaction locked long enough for other processes to contend.
  if(commits===1){heldAt=process.hrtime.bigint().toString();
    const other=path.join(dir,'barrier-'+round+'-'+(1-Number(index)));
    for(let tries=0;tries<100&&!fs.existsSync(other);tries++)Atomics.wait(waitCell,0,0,10);
    assert(fs.existsSync(other),'both processes entered this round before writer unlock');
    Atomics.wait(waitCell,0,0,8);heldUntil=process.hrtime.bigint().toString();}
 };
 for(let target=Number(index);target<8;target+=2) {
  try{core.schedule('stress:'+target+':'+round,'task:w'+target+':'+round);accepted++;}catch(e){errors.push(e.code??e.message);}
 }
 // One drain is one pass, exactly what one cycle round asks of the scheduler. A pass is best effort by design: it
 // can lose a wake row's revision to the other process, and a wake it allocated earlier in the pass is released
 // again when the same member takes its work slot. The driver's answer to a pass that did not admit everything is
 // the next round's drain, so this drives that same sequence - while a lane with queued work is still free, at most
 // four passes - instead of assuming that one pass must always be enough under contention.
 const lanes=()=>capacityUsage(store),full=()=>{const u=lanes();return u.normal>=1&&u.human>=1;};
 let rejected=0,rejections=[],passes=0;
 for(let pass=0;pass<4&&(pass===0||!full());pass++){
  let drained;
  try{drained=drain(core);}catch(e){errors.push('drain:'+(e.code??e.message)+'@'+(e.taskId??'?'));rejections=rejections.concat(e.rejections??[]);break;}
  passes++;accepted+=drained.length;rejected+=drained.rejected??0;rejections=rejections.concat(drained.rejections??[]);
  if(!drained.length)break;
 }
 store.hooks.beforeCommit=null;
 const afterDrain=capacityUsage(store);
 process.send({round,accepted,passes,rejected,rejections,after:{normal:afterDrain.normal,human:afterDrain.human},errors,violations,commits,started,ended:
   process.hrtime.bigint().toString(),heldAt,heldUntil});
});
process.send({ready:true});
