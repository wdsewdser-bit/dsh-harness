// Opt-in study; each labelled condition owns its samples. Aggregated/declared counters confer no evidence.
export const PERFORMANCE_PROTOCOL=Object.freeze({samplesPerCondition:30,warmupCycles:2,conditions:['cold','warm'],concurrency:1,backgroundLoad:'idle',
    faults:'none',readyP90Ms:2000,mailboxP90Ms:5000});
const p90=values=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.9)-1]:null;
export function performanceGate(f,_latency){
 const p=f.performanceStudy;
 if(!p)return {status:'not-run',reason:'functional run; separate controlled performance study required',protocol:PERFORMANCE_PROTOCOL};
 const conditions={};let eligible=f.mode==='live'&&!f.fault&&p.concurrency===1&&p.backgroundLoad==='idle'&&Array.isArray(p.samples);
 const samples=Array.isArray(p.samples)?p.samples:[];
 if(samples.some(s=>!['cold','warm'].includes(s.condition)))eligible=false;
 for(const condition of ['cold','warm']){
  const rows=samples.filter(s=>s.condition===condition),ready=[],mailbox=[];let valid=rows.length>0;
  for(const row of rows){
   const numbers=[row.readyToAdmittedMs,row.storedToBoundaryMs];
   if(!numbers.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)||!Number.isSafeInteger(row.warmupCycles)||row.warmupCycles<0||
      (condition==='cold'?row.warmupCycles!==0:row.warmupCycles<PERFORMANCE_PROTOCOL.warmupCycles)){valid=false;continue;}
   ready.push(row.readyToAdmittedMs);mailbox.push(row.storedToBoundaryMs);
  }
  valid=valid&&ready.length>=30&&mailbox.length>=30;eligible=eligible&&valid;
  const readyP90=p90(ready),mailboxP90=p90(mailbox);
  conditions[condition]={samples:rows.length,valid,readyP90,mailboxP90,passed:valid&&Number.isFinite(readyP90)&&Number.isFinite(mailboxP90)&&readyP90<=2000
    &&mailboxP90<=5000};
 }
 if(!eligible)return {status:'insufficient',passed:false,conditions,protocol:PERFORMANCE_PROTOCOL};
 return {status:'measured',passed:Object.values(conditions).every(c=>c.passed),conditions,protocol:PERFORMANCE_PROTOCOL};
}
