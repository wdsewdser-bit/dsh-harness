import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createExecutionScopes } from '../execution-scope.mjs';
const caps={gates:true,attribution:true,transport:true,subprocess:true};
const E=n=>({teamId:'team',memberId:'member:'+n,generation:1,attemptId:'attempt:'+n,attemptFence:1,executionSessionId:'session:'+n,executionEpoch:'epoch:'+n});
function run(trace) {
  const registry=createExecutionScopes();
  const worlds=[0,1].map(n=>({s:registry.open(E(n),caps),closed:false,bad:false,outstanding:new Map(),calls:new Map(),sent:new Set(),turn:null}));
  for(const [epoch,action,id] of trace) {
    const w=worlds[epoch],s=w.s,key=String(action==='call'?id%2:id),canStart=!w.closed;
    if(action==='seal'){s.seal();w.closed=true;}
    else if(action==='spawn'||action==='turn'||action==='call'||action==='send'){
      const start=()=>{
        if(action==='turn'){if(w.turn)return false;const token=s.startTurn(key);w.turn=token;w.outstanding.set('turn',token);}
        else if(action==='call'){if(w.calls.has(key))return false;const call=s.call();w.calls.set(key,call);w.outstanding.set('call:'+key,call);}
        else if(action==='send'){const c=w.calls.get(String(id%2));if(!c||!w.outstanding.has('call:'+String(id%2))||w.sent.has(key))return false;
          const token=c.reserve('A'+(id%2),id+1);w.sent.add(key);w.outstanding.set('x:'+key,token);}
        else {if(w.outstanding.has('spawn:'+key))return false;w.outstanding.set('spawn:'+key,s.acquire('pending-spawn'));}
        return true;
      };
      if(!canStart){
        // The oracle's closed bit is independent of the implementation's state getter.
        assert.throws(()=>s.acquire('probe'),/EXECUTION_SEALED/);
      }else start();
    } else if(action==='end') {
      const k=[...w.outstanding.keys()][id%Math.max(1,w.outstanding.size)],token=w.outstanding.get(k);
      if(token){if(k==='turn'){s.endTurn(token);w.turn=null;}else if(k.startsWith('call'))token.close();else s.finish(token);w.outstanding.delete(k);}
    } else if(action==='coverage') {s.invalidate('unattributed-grandchild');w.bad=true;}
    else if(action==='parent-death') {s.invalidate('range-unproven');w.bad=true;}
    if(w.closed)assert.equal(s.prove({kind:'attempt',id:E(epoch).attemptId,fence:1}).verified,!w.bad&&w.outstanding.size===0);
    for(const [n,other] of worlds.entries())assert.equal(other.s.E.executionEpoch,E(n).executionEpoch);
  }
}
function shrink(trace) {
  let small=trace;
  for(let width=Math.floor(trace.length/2);width; width=Math.floor(width/2))for(let i=0;i+width<=small.length;i++) {
    const candidate=[...small.slice(0,i),...small.slice(i+width)];try{run(candidate);}catch{small=candidate;i=-1;}
  }
  return small;
}
test('fixed-seed independent model: 2 epochs, 2 turns/calls, 4 X, pending spawn and parent/child/grandchild faults',()=>{
  const actions=['spawn','turn','call','send','end','end','seal','coverage','parent-death'];
  for(let seed=1;seed<=500;seed++) {
    let state=seed;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
    const trace=Array.from({length:100},()=>[(next()>>>16)%2,actions[(next()>>>16)%actions.length],(next()>>>16)%4]);
    try{run(trace);}catch(error){
      const path='runs/execution-property-failure-'+seed+'.json';fs.writeFileSync(path,JSON.stringify({seed,trace,minimal:shrink(trace)},null,2));
      error.message+=' trace='+path;throw error;
    }
  }
});
