import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ControlStore} from '../../packages/store/index.mjs';import {TeamCore} from '../../packages/core/index.mjs';
import {noteRouteReady,noteFirstRequest,noteCheckpoint} from '../real/timing.mjs';import {performanceGate} from '../real/performance.mjs';
test('timing uses durable ready/admission, preserves early request across route observation, and separates attempt/cycle',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'timing-metrics-')),store=new ControlStore(root),core=new TeamCore(store,{}, {enabled:true});let now=1000;
 const original=Date.now;Date.now=()=>now;
 try{
  core.mutate('ready','root',{},tx=>tx.put('task:t',{status:'ready',owner:'member:w'}));now=1200;
  core.mutate('admit','scheduler',{},tx=>tx.put('attempt:a',{status:'admitted',taskId:'task:t',admittedAt:now,owner:'member:w'}));
  const engine={core,facts:{latency:{}}};noteFirstRequest(engine,'w',1,'attempt:a',1300);
  noteRouteReady(engine,'w',1,'attempt:a',9000);noteCheckpoint(engine,'w',1,'attempt:a',1600);
  assert.deepEqual(engine.facts.latency.readyToAdmitted,[200]);assert.deepEqual(engine.facts.latency.admittedToRouteReady,[7800]);
  assert.deepEqual(engine.facts.latency.admittedToFirstRequest,[100]);assert.deepEqual(engine.facts.latency.firstRequestToCheckpoint,[300]);
  noteFirstRequest(engine,'w',1,'attempt:a',9999);noteCheckpoint(engine,'w',2,'attempt:a',2000);
  assert.equal(engine.facts.attemptTiming[0].firstRequestAt,1300);assert.equal(engine.facts.attemptTiming[1].firstRequestAt,null);
  assert.equal(engine.facts.latency.firstRequestToCheckpoint.length,1);assert.equal(engine.facts.timingMissing.at(-1).metric,'firstRequestToCheckpoint');
  assert.ok(engine.facts.timingSamples.every(r=>r.taskId==='task:t'&&r.actor==='w'&&r.attemptId==='attempt:a'));
 }finally{Date.now=original;store.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('fake faults are functional only; wall clock performance needs independent controlled samples',()=>{
 const latency={readyToAdmitted:{raw:Array(60).fill(2003),p90:2003},storedToBoundary:{raw:Array(60).fill(6000),p90:6000}};
 assert.equal(performanceGate({mode:'fake',fault:'fault'},latency).status,'not-run');
 const performanceStudy={concurrency:1,backgroundLoad:'idle',samples:['cold','warm'].flatMap(condition=>Array.from({length:30},()=>({condition,
           warmupCycles:condition==='cold'?0:2,readyToAdmittedMs:2003,storedToBoundaryMs:6000})))};
 assert.equal(performanceGate({mode:'live',performanceStudy},latency).passed,false);
 assert.equal(performanceGate({mode:'fake',performanceStudy},latency).status,'insufficient');
 assert.equal(performanceGate({mode:'live',performanceStudy:{...performanceStudy,samples:performanceStudy.samples.map(s=>({...s,warmupCycles:0}))}},latency)
   .status,'insufficient');
 for(const s of performanceStudy.samples){s.readyToAdmittedMs=2000;s.storedToBoundaryMs=5000;}latency.readyToAdmitted.p90=2000;latency.storedToBoundary.p90
 =5000;assert.equal(performanceGate({mode:'live',performanceStudy},latency).passed,true);
});

test('cold and warm are independently measured; labels, warmup and non-finite values cannot sign a pass',()=>{
 const samples=condition=>Array.from({length:condition==='cold'?30:300},()=>({condition,warmupCycles:condition==='cold'?0:2,readyToAdmittedMs:condition==='cold'
       ?3000:1000,storedToBoundaryMs:1000}));
 const performanceStudy={concurrency:1,backgroundLoad:'idle',samples:[...samples('cold'),...samples('warm')]},facts={mode:'live',performanceStudy};
 const misleading={readyToAdmitted:{raw:Array(330).fill(1000),p90:1000},storedToBoundary:{raw:Array(330).fill(1000),p90:1000}};
 const measured=performanceGate(facts,misleading);assert.equal(measured.status,'measured');assert.equal(measured.passed,false);
 assert.equal(measured.conditions.cold.readyP90,3000);assert.equal(measured.conditions.cold.passed,false);assert.equal(measured.conditions.warm.passed,true);
 for(const bad of [null,NaN,Infinity,-Infinity,undefined]){
  const p=structuredClone(performanceStudy);for(const row of p.samples)row.readyToAdmittedMs=bad;
  assert.equal(performanceGate({mode:'live',performanceStudy:p},misleading).passed,false);
 }
 const zero=structuredClone(performanceStudy);for(const row of zero.samples){row.readyToAdmittedMs=0;row.storedToBoundaryMs=0;}assert.equal(performanceGate({
       mode:'live',performanceStudy:zero},misleading).passed,true);zero.samples[0].readyToAdmittedMs=null;assert.equal(performanceGate({mode:'live',
       performanceStudy:zero},misleading).passed,false);
 for(const mutation of ['missing-label','warmup','missing-cold','fractional-warmup']){
  const p=structuredClone(performanceStudy);if(mutation==='missing-label')delete p.samples[0].condition;
  if(mutation==='warmup')p.samples.find(r=>r.condition==='warm').warmupCycles=0;
  if(mutation==='missing-cold')p.samples=p.samples.filter(r=>r.condition!=='cold');
  if(mutation==='fractional-warmup')p.samples[0].warmupCycles=NaN;
  assert.equal(performanceGate({mode:'live',performanceStudy:p},misleading).passed,false,mutation);
 }
});

