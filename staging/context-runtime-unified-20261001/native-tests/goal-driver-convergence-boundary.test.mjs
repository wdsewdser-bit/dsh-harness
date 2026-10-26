import test from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate} from 'node:timers/promises'
import {apply} from '../app/node_modules/@deepseek-ai/dsh-goal-round-driver-v15/lib/index.js'

async function fixture(mode) {
  const listeners=new Map(),warnings=[],goal={id:'goal',revision:1,objective:'work',phase:'active',activation:'armed',roundsStarted:mode==='limit'?1:0,maxGoalRounds:1}
  let blocks=0,submitted,cleanup
  const agent={id:'root',status:'idle',session:{id:'root'},inbox:{nextTurn:[],nextStep:[]},followup(message){if(mode==='queue')throw Error('QUEUE_FAILURE');submitted=message}}
  const ctx={fiber:{state:2},logger:{warn:m=>warnings.push(m)},agents:{get:id=>id==='root'?agent:undefined,list:()=>[],withoutInitiator:fn=>fn(),currentInitiator:()=>undefined},sessions:{flush:async()=>{}},goals:{get:()=>({...goal}),disarm:()=>{goal.activation='disarmed'},block:async()=>{blocks++;return goal}},on:(name,fn)=>listeners.set(name,fn),effect(fn){const generator=fn();cleanup=generator.next().value}}
  apply(ctx);listeners.get('agent/status')({agent,status:'idle'});for(let i=0;i<5;i++)await setImmediate()
  if(mode==='reject'){agent.inbox.nextTurn=[submitted];listeners.get('agent/inbox/claimed')({agent,message:submitted});await listeners.get('agent/pre-step')({agent,messages:[submitted],signal:new AbortController().signal},async()=>({kind:'reject'}))}
  for(let i=0;i<5;i++)await setImmediate()
  const observed={blocks,goal:{...goal},warnings};await cleanup();return observed
}
for(const mode of ['limit','queue','reject'])test('driver '+mode+' disarms without forging convergence blocker',async()=>{const r=await fixture(mode);assert.equal(r.blocks,0,'DRIVER_MUST_NOT_CALL_MODEL_CONVERGENCE_BLOCK');assert.equal(r.goal.phase,'active');assert.equal(r.goal.activation,'disarmed');assert.ok(r.warnings.length)})
