// Measurements are keyed by durable execution attempt and workload cycle, never by bind's polling interval.
const valid=value=>Number.isFinite(value)&&value>0;
const key=(actor,cycle,attemptId)=>JSON.stringify([actor,cycle,attemptId]);
function rows(engine){return engine.facts.attemptTiming??=[];}
function missing(engine,metric,identity,reason){const list=engine.facts.timingMissing??=[];if(!list.some(x=>x.metric===metric&&x.key===identity))list.push({
      metric,key:identity,reason});
  }
function sample(engine,metric,row,from,to){
 if(!valid(from)||!valid(to)||to<from){missing(engine,metric,row.key,'missing or non-monotonic timestamp');return;}
 const samples=engine.facts.timingSamples??=[];
 if(samples.some(x=>x.metric===metric&&x.key===row.key))return;
 samples.push({metric,key:row.key,actor:row.actor,cycle:row.cycle,taskId:row.taskId,attemptId:row.attemptId,from,to,ms:to-from});
 (engine.facts.latency[metric]??=[]).push(to-from);
}
export function attemptTiming(engine,actor,cycle,attemptId){
 const identity=key(actor,cycle,attemptId);let row=rows(engine).find(r=>r.key===identity);if(row)return row;
 const attempt=engine.core.store.read(attemptId),events=engine.core.store.events();
 const admission=events.find(e=>e.entity===attemptId&&e.payload.status==='admitted');
 const ready=events.filter(e=>e.entity===attempt?.taskId&&e.payload.status==='ready'&&(!admission||e.seq<admission.seq)).at(-1);
 row={key:identity,actor,cycle,attemptId,taskId:attempt?.taskId??null,readyAt:ready?.payload.updatedAt??null,admittedAt:admission?.payload.admittedAt??null,
   readyEventSeq:ready?.seq??null,admissionEventSeq:admission?.seq??null,firstRequestAt:null};
 rows(engine).push(row);sample(engine,'readyToAdmitted',row,row.readyAt,row.admittedAt);return row;
}
export function noteRouteReady(engine,actor,cycle,attemptId,at){const row=attemptTiming(engine,actor,cycle,attemptId);row.routeReadyAt??=at;sample(engine,
    'admittedToRouteReady',row,row.admittedAt,row.routeReadyAt);return row;
  }
export function noteFirstRequest(engine,actor,cycle,attemptId,at){
 const row=attemptTiming(engine,actor,cycle,attemptId);row.firstRequestAt??=at;sample(engine,'admittedToFirstRequest',row,row.admittedAt,row.firstRequestAt);
 return row;
}
export function noteCheckpoint(engine,actor,cycle,attemptId,at){const row=attemptTiming(engine,actor,cycle,attemptId);sample(engine,'firstRequestToCheckpoint',
    row,row.firstRequestAt,at);
  }
