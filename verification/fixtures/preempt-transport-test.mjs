import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Engine} from '../real/scenario.mjs';
import {Transport} from '../real/transport.mjs';
import {Budget} from '../real/budget.mjs';
import {ConcurrencyGate} from '../real/concurrency.mjs';

// A real product member runs through the actual real-suite Transport and its budget/gate. The first fake provider
// request deliberately ignores preemption and stays in flight; the new request must start before it is released.
const root=path.resolve(process.argv[2]??'');
assert(root.toLowerCase().replaceAll('\\','/').startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/'),'PREEMPT_TRANSPORT_SCOPE');
assert(!fs.existsSync(root),'the evidence root must be new');fs.mkdirSync(root,{recursive:true});
const facts={stage:'smoke',mode:'fake',requests:[],messages:[],toolActions:[],turns:[],deliveries:[],decisions:[],
  protocolErrors:[],security:[],folds:[],cold:[],latency:{},completedCycles:0};
const engine=new Engine(root,facts,'fake',{stage:'smoke'}),gate=new ConcurrencyGate({maxConcurrent:1,globalConcurrency:6});
const wait=async(p,label)=>{const end=Date.now()+30000;while(!p()){if(Date.now()>end)throw Error('TIMEOUT:'+label);await new Promise(r=>setTimeout(r,10));}};
let releaseOld,oldReleased=false;const hold=new Promise(r=>releaseOld=r);const bodies=[];
let budget;
try {
  budget=new Budget(root+'/budget.json','smoke');await engine.open();
  engine.gate=gate;engine.transport=new Transport({root,budget,gate,mode:'fake',facts,stopped:()=>null,
    onDispatchPhase:event=>engine.onDispatchPhase(event),fake:async body=>{
      const index=bodies.length;bodies.push(structuredClone(body));
      if(index===0)await hold;
      const text=index===0?'obsolete-old-answer':'new-answer';
      return {output:[{type:'message',id:'response-'+index,role:'assistant',content:[{type:'output_text',text}]}],
        usage:{input_tokens:100+index,output_tokens:10,input_tokens_details:{cached_tokens:0}}};
    }});
  await engine.bind('a1','preempt-transport');await wait(()=>bodies.length>=1,'first provider request');
  const agent=engine.agent('a1');assert.equal(agent.phase.kind,'running');
  engine.deliverPrompt('a1','PREEMPT_REAL_TRANSPORT');
  await wait(()=>bodies.length>=2,'follow-up provider request before old request settles');
  assert.equal(oldReleased,false);assert.equal(bodies.length,2);
  assert(JSON.stringify(bodies[1].input).includes('PREEMPT_REAL_TRANSPORT'),'follow-up carries the delivered responsibility');
  await agent.whenIdle();await engine.waitTurn('a1',0);
  const during=gate.stats();assert.equal(during.peakPerMember,2,'the overlap is reported as physical IO');
  assert.equal(during.peakActivePerMember,1,'only one live session step is active');
  assert.equal(during.supersededInFlight,1);assert.equal(during.inFlight,1,'the old IO slot was not falsely released');
  assert.equal(budget.outstanding(),1,'the abandoned provider request keeps its reservation');
  assert.equal(agent.preemptStats.fired,1);assert.equal(agent.preemptStats.extraRequests,1);
  assert(JSON.stringify(engine.raw).includes('new-answer'));assert(!JSON.stringify(engine.raw).includes('obsolete-old-answer'));
  oldReleased=true;releaseOld();await wait(()=>gate.stats().inFlight===0,'old transport drained');
  assert.equal(budget.outstanding(),0);assert(!JSON.stringify(engine.raw).includes('obsolete-old-answer'),
    'late old raw output cannot relabel the new assistant');
  assert.deepEqual(facts.requests.map(r=>r.id).sort((a,b)=>a-b),[1,2],'overlapping requests keep distinct identities');
  assert.equal(facts.requests.find(r=>r.id===1).superseded,true);assert.equal(facts.requests.find(r=>r.id===2).superseded,false);
  assert.equal([...engine.transport.lastCall.values()][0].requestNumber,2,'late old usage cannot replace the newer prefix estimate');
  fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',requests:2,preempts:1,extraRequests:1,
    physicalPeak:2,activePeak:1,globalPeak:during.peakInFlight,reservationRetained:true,lateRawDiscarded:true},null,2));
  console.log('real transport preempt PASS: follow-up before old completion; physical IO and reservation retained');
} finally {
  if(!oldReleased){oldReleased=true;releaseOld();}
  try{await wait(()=>gate.stats().inFlight===0,'cleanup transport');}finally{await engine.close();budget?.close();}
}
