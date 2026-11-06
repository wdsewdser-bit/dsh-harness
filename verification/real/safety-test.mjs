import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {Budget} from './budget.mjs';
import {Transport} from './transport.mjs';
import {stopReason} from './stop.mjs';
import {policy} from './config.mjs';
import {scopedRoot} from './scope.mjs';
import {route} from './config.mjs';
const root=scopedRoot(process.argv[2]);assert(!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const marks=[],facts=()=>({requests:[],latency:{}});
const clock={stage:'soak',started:0,lastProgress:899999};
assert.equal(stopReason({...clock,now:900000}),null);
assert.equal(stopReason({...clock,lastProgress:0,now:900000}),'NO_PROGRESS_STOP');
assert.equal(stopReason({...clock,lastProgress:3600000,now:3600000}),'TIME_STOP');
assert.equal(stopReason({...clock,now:100,stopRequested:true}),'SIGNAL_STOP');
// The collaboration stage has two clocks and two codes, and the difference is the point of the split: its own
// 30-minute ceiling ends a healthy run (clockStopCodes / cycle forgiveness), while a progress window that expires
// stays a defect. The progress window is measured from the stage's newest signal (a round, an integration, a produce,
// a verify, a turn, a workspace write) and not from the stage start; before this, "no progress" was really
// "time since the stage began" and ended the fourth real run mid-change with the whole team working.
{
  const collab=stage=>({stage,started:0,lastProgress:policy.collabNoProgressMs-1});
  assert.equal(stopReason({...collab('collab'),now:policy.collabNoProgressMs}),null,'a fresh signal keeps the run alive');
  assert.equal(stopReason({...collab('collab'),lastProgress:0,now:policy.collabNoProgressMs}),'NO_PROGRESS_STOP',
    'collab silence past its own window is still a defect');
  assert.equal(stopReason({stage:'collab',started:0,lastProgress:policy.collabNoProgressMs-1,now:policy.collabDurationMs}),
    'STAGE_TIME_LIMIT','the collab stage ceiling has its own code');
  assert.equal(stopReason({stage:'collab',started:0,lastProgress:0,now:policy.collabDurationMs}),'STAGE_TIME_LIMIT',
    'the ceiling is reported as the ceiling even when the team was also silent');
  assert.equal(stopReason({stage:'soak',started:0,lastProgress:policy.collabNoProgressMs-1,now:policy.collabNoProgressMs}),
    null,'the release stages keep the longer release window');
  // A run whose progress keeps advancing never trips the window, whatever its wall clock: 30 windows in a row, each
  // opened by a signal one millisecond before it expired. Inside the stage ceiling the verdict is null; past it the
  // ceiling is what ends the run, with its own code -- in neither case the stall's.
  const window=policy.collabNoProgressMs;
  const advancing=Array.from({length:30},(_,i)=>stopReason({stage:'collab',started:0,lastProgress:(i+1)*window-1,now:(i+1)*window-1}));
  assert.equal(advancing.includes('NO_PROGRESS_STOP'),false,'continuous progress is never read as a stall');
  assert.equal(advancing.filter(x=>x!==null).every(x=>x==='STAGE_TIME_LIMIT'),true,
    'past the ceiling the only remaining verdict is the ceiling itself');
  // And a stage whose signals stop at the first one still ends the run, so the window is not merely a longer clock.
  assert.equal(stopReason({stage:'collab',started:0,lastProgress:1,now:window+1}),'NO_PROGRESS_STOP');
  marks.push('collab separations: progress window vs stage ceiling');
}
for(const reason of ['NO_PROGRESS_STOP','TIME_STOP','SIGNAL_STOP','STAGE_TIME_LIMIT']){
  const dir=root+'/'+reason;fs.mkdirSync(dir);const b=new Budget(dir+'/budget.json','p2-replay');let sent=0;
  const t=new Transport({root:dir,budget:b,mode:'fake',facts:facts(),stopped:()=>reason,fake:async()=>{sent++}});
  await assert.rejects(()=>t.call('root',[]),new RegExp(reason));assert.equal(sent,0);assert.equal(b.data.pending,null);b.close();marks.push(reason
    +' no dispatch');
}
{
  // The pre-request estimate is the serialized UTF-8 byte count, which is an upper bound on tokens (a BPE token is
  // at least one byte), and the gate reads that input bound alone: 75% of the window already leaves a quarter of it
  // for the answer, so a full output cap added on top counted the same headroom twice. An input just under the line
  // must dispatch, an input past it must be refused before dispatch, and an input close to the window must shrink the
  // cap the request asks for instead of raising the refusal. Sizing every case from the route keeps them honest if the
  // ratio or the window ever changes.
  const line=route.contextWindow*.75;
  const dir=root+'/context';fs.mkdirSync(dir);const b=new Budget(dir+'/budget.json','p2-replay');let sent=0;const bodies=[];
  const t=new Transport({root:dir,budget:b,mode:'fake',facts:facts(),stopped:()=>null,
    fake:async body=>{sent++;bodies.push(body);return{output:[],usage:{input_tokens:1000,output_tokens:10}}}});
  const prompt=bytes=>({role:'user',content:[{type:'input_text',text:'x'.repeat(bytes)}]});
  // Just under the line: the estimate is under it, the cap is the rule min(route cap, what the window leaves), and the
  // request reaches the provider.
  await t.call('root',[prompt(Math.floor(line)-2000)],[],{nativeSessionId:'session-under'});
  assert.equal(sent,1,'an input just under 75% must reach the provider');
  const under=t.facts.requests[0];
  assert(under.inputUpperBound<line,'the estimate of the dispatching request is under the line');
  assert.equal(under.outputCap,Math.min(route.maxOutputTokens,route.contextWindow-under.inputUpperBound),
    'the cap is the smaller of the route cap and what the window leaves');
  assert.equal(bodies[0].max_output_tokens,under.outputCap,'the body asks for exactly the recorded cap');
  // At and past the line: refused before any dispatch, and nothing sent.
  const over=Math.ceil(line)+2000;
  await assert.rejects(()=>t.call('root',[prompt(over)],[],{nativeSessionId:'session-full'}),
    /CONTEXT_75_PERCENT_GATE_BEFORE_REQUEST/);
  assert.equal(sent,1,'the refusing request must never reach the provider');
  // Close to the window and still under the line: the request is dispatched with a cap clamped to the window remainder,
  // because the input has already spent what the full route cap would need.
  await t.call('root',[prompt(route.contextWindow-route.maxOutputTokens+1000)],[],{nativeSessionId:'session-clamp'});
  assert.equal(sent,2,'an input near the window must still dispatch');
  const tight=t.facts.requests[1];
  assert(tight.inputUpperBound>route.contextWindow-route.maxOutputTokens,'the input leaves less room than the route cap');
  assert.equal(tight.outputCap,route.contextWindow-tight.inputUpperBound,'the cap is exactly what the window leaves');
  assert(tight.outputCap<route.maxOutputTokens,'the cap was clamped below the route cap');
  assert.equal(bodies[1].max_output_tokens,tight.outputCap,'the body asks for exactly that clamped cap');
  assert.equal(b.data.pending,null);b.close();
  marks.push('75% gate reads the input alone ('+under.inputUpperBound+' bytes dispatched, '+over+' bytes refused); cap clamped to the window remainder');
}
{
  // The regression the live soak paid for: its last root request was 159,104 bytes and the provider reported 51,835
  // input tokens, i.e. about one token per three bytes. bytes*4 refused the next, ~187 KB request at roughly 6% of a
  // 1,000,000-token window, so a safe-but-absurd estimate ended a 22.5-minute run. Such a request must dispatch.
  const dir=root+'/context-under';fs.mkdirSync(dir);const b=new Budget(dir+'/budget.json','p2-replay');let sent=0;
  const t=new Transport({root:dir,budget:b,mode:'fake',facts:facts(),stopped:()=>null,
    fake:async()=>{sent++;return{output:[],usage:{input_tokens:51835,output_tokens:200}}}});
  const out=await t.call('root',[{role:'user',content:[{type:'input_text',text:'y'.repeat(190000)}]}]);
  assert.equal(t.facts.requests[0].outputCap,route.maxOutputTokens,'a short prompt still asks for the full route cap');
  assert.equal(sent,1,'the 190 KB request must reach the provider exactly once');
  assert.equal(t.requests,1);assert.deepEqual(out.output,[]);
  assert.equal(b.data.total,52035,'actual usage is what the ledger charges');
  assert.equal(b.data.pending,null);assert.equal(b.data.stages['p2-replay'],52035);
  b.close();marks.push('190KB request dispatches (byte-count upper bound, not bytes*4)');
}
{
  // Prefix-delta in both directions. The provider reports 1,000 input tokens for the first request; the next one
  // repeats those two items and appends one. The estimate must be 1,000 + that item's bytes (+ any body growth),
  // never the full ~190 KB again, and it must be recorded as such. A rewritten history must fall back to bytes.
  const dir=root+'/prefix';fs.mkdirSync(dir);const b=new Budget(dir+'/budget.json','p2-replay');
  const first=[{role:'user',content:[{type:'input_text',text:'a'.repeat(1000)}]},
    {role:'assistant',content:[{type:'output_text',text:'b'.repeat(1000)}]}];
  const appended={role:'user',content:[{type:'input_text',text:'c'.repeat(2000)}]};
  let sent=0;const t=new Transport({root:dir,budget:b,mode:'fake',facts:facts(),stopped:()=>null,
    fake:async()=>{sent++;return{output:[],usage:{input_tokens:1000,output_tokens:20}}}});
  const session={nativeSessionId:'session-prefix'};
  await t.call('root',first,[],session);
  await t.call('root',[...first,appended],[],session);
  const [one,two]=t.facts.requests;
  assert.equal(one.estimateMethod,'full-bytes');assert.equal(one.inputUpperBound,one.requestBytes);
  assert.equal(two.estimateMethod,'prefix-delta');
  const added=Buffer.byteLength(JSON.stringify(appended));// both calls carry the same empty tools list, so no body growth
  assert.equal(two.estimateEvidence.previousInput,1000);assert.equal(two.estimateEvidence.reusedItems,2);
  assert.equal(two.estimateEvidence.addedItems,1);assert.equal(two.estimateEvidence.addedBytes,added);
  assert.equal(two.inputUpperBound,1000+added);
  assert(two.inputUpperBound<two.requestBytes,'the delta must be smaller than the whole prompt it extends');
  // History rewritten: the first item changed, so nothing may be carried over from the previous report.
  await t.call('root',[{role:'user',content:[{type:'input_text',text:'z'.repeat(1000)}]},appended],[],session);
  const three=t.facts.requests[2];
  assert.equal(three.estimateMethod,'full-bytes');
  assert.equal(three.inputUpperBound,three.requestBytes);
  assert.match(three.estimateEvidence.reason,/not a prefix/);
  // A different session never inherits another session's report.
  await t.call('root',[...first,appended],[],{nativeSessionId:'session-other'});
  assert.equal(t.facts.requests[3].estimateMethod,'full-bytes');
  assert.equal(sent,4);b.close();marks.push('prefix-delta estimate reuses the reported prefix, full bytes otherwise');
}
{
  // Prefix hit at the line: the delta is the estimate that matters and the gate reads it alone. The provider reports
  // 700,000 input tokens for the prefix, and the appended item is sized so the delta lands exactly on 75% of the window
  // -- which must be refused -- while one byte less must dispatch. Only a delta can see this: the first call is a
  // harmless ~190 KB and the appended item is 50 KB, but the pair together is what reaches the line. Sizing all three
  // numbers from the route keeps the boundary exact if the window ever changes; the output cap no longer enters the
  // arithmetic at all.
  const line=Math.floor(route.contextWindow*.75);
  const dir=root+'/prefix-gate';fs.mkdirSync(dir);const b=new Budget(dir+'/budget.json','soak');let sent=0;
  const t=new Transport({root:dir,budget:b,mode:'fake',facts:facts(),stopped:()=>null,
    fake:async()=>{sent++;return{output:[],usage:{input_tokens:700000,output_tokens:10}}}});
  const first=[{role:'user',content:[{type:'input_text',text:'p'.repeat(190000)}]}];
  const session={nativeSessionId:'session-tight'};
  await t.call('root',first,[],session);
  const item=text=>({role:'user',content:[{type:'input_text',text}]});
  const target=line-700000,overhead=Buffer.byteLength(JSON.stringify(item('')));
  const atLine=item('q'.repeat(target-overhead));
  assert.equal(Buffer.byteLength(JSON.stringify(atLine)),target,'the appended item is sized to land on the line');
  await assert.rejects(()=>t.call('root',[...first,atLine],[],session),/CONTEXT_75_PERCENT_GATE_BEFORE_REQUEST/);
  assert.equal(sent,1,'the refusing request must never reach the provider');
  // ...and one byte under the same prefix still dispatches, so the refusal is about the total.
  const fits=item('q'.repeat(target-overhead-1));
  await t.call('root',[...first,fits],[],session);
  assert.equal(sent,2);assert.equal(t.facts.requests[1].estimateMethod,'prefix-delta');
  assert.equal(t.facts.requests[1].inputUpperBound,line-1,'one byte under the line is the estimate that dispatches');
  assert.equal(t.facts.requests[1].outputCap,route.contextWindow-(line-1),'and its cap is what the window leaves');
  b.close();marks.push('prefix hit on 75% refuses, one byte under dispatches');
}
const secret='offline-sentinel-"not-a-real-key';
{
  const dir=root+'/reflected-secret';fs.mkdirSync(dir);const b=new Budget(dir+'/budget.json','smoke');
  const t=new Transport({root:dir,budget:b,mode:'fake',key:secret,facts:facts(),stopped:()=>null,fake:async()=>({output:[{type:'message',content:[{
                  type:'output_text',text:secret}]}],[secret]:'reflected property name',usage:{input_tokens:10,output_tokens:1}})});
  await assert.rejects(()=>t.call('root',[]),/SECRET_IN_PROVIDER_OUTPUT/);
  const logged=JSON.parse(fs.readFileSync(dir+'/requests.jsonl','utf8'));assert.equal(logged.result.output[0].content[0].text,'[REDACTED]');assert(!Object
    .hasOwn(logged.result,secret));assert.equal(b.data.total,11);b.close();marks.push(
      'reflected secret redacted, accounted, stopped before native persistence');
}
const env={...process.env,CLOSEOUT_PROVIDER_KEY:secret};
for(const mode of ['--dry-run','--fake-provider']){
  const dir=root+'/'+mode.slice(2),x=spawnSync(process.execPath,['verification/real/run.mjs','smoke',mode,'--root',dir],{env,encoding:'utf8',timeout:60000});
  assert.equal(x.status,0,x.stdout+x.stderr);const report=JSON.parse(fs.readFileSync(dir+'/report.json'));
  assert.equal(report.providerKeyPresent,false);assert.equal(report.realProviderRequests,0);assert(report.cleanup);
  const scan=p=>{for(const item of fs.readdirSync(p,{withFileTypes:true})){const file=path.join(p,item.name);if(item.isDirectory())scan(file);else assert(!fs
        .readFileSync(file).includes(Buffer.from(secret)),file);}};scan(dir);
  marks.push(mode+' ignores inherited sentinel key');
}
for(const args of [[],['--authorize-provider']]){
  const clean={...process.env};delete clean.CLOSEOUT_PROVIDER_KEY;
  const x=spawnSync(process.execPath,['verification/real/run.mjs','smoke','--root',root+'/unauthorized',...args],{env:clean,encoding:'utf8'});
  assert.notEqual(x.status,0);assert(!fs.existsSync(root+'/unauthorized'));
}
assert.throws(()=>scopedRoot('<path-to-outside-real-root>'),/WRITE_SCOPE/);
fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',checks:marks,authorizationDenied:true,outsideRootDenied:true,realProviderRequests:0},null,
    2));
console.log('safety PASS: clock, context gate, redaction, inherited key stripping, authorization and scope');
