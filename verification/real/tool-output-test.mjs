import fs from 'node:fs';
import assert from 'node:assert/strict';
import {brief} from '../../packages/core/workload.mjs';
import {assertLosslessJson} from './tool-output.mjs';
const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});
const cycle={id:1,assignments:{a1:{own:3,from:'b1',to:'b1'}},deliveries:[],issue:null};
for(const c of [null,cycle])for(const actor of ['root','a1','a2','b1','b2','verifier']){
  const value=brief(actor,{cycle:c});
  assertLosslessJson(value);assert.deepEqual(JSON.parse(JSON.stringify(value)),value);
  assert(Array.isArray(value.deliveries));assert(value.issue===null);
}
const cycleObject={};cycleObject.self=cycleObject;
const invalid=[undefined,NaN,Infinity,-Infinity,-0,1n,new Date(),new Map(),new Set(),()=>{},Symbol('x'),{x:undefined},{x:NaN},{x:1n},[,],cycleObject,Object
  .defineProperty({},'getter',{get(){throw Error('getter must not execute')},enumerable:true})];
for(const value of invalid)assert.throws(()=>assertLosslessJson(value),e=>e.code==='INVALID_TOOL_OUTPUT');
for(const value of [null,true,false,1,'x',[],{},[1,{x:null}],{nested:{list:['a',3]}}])assertLosslessJson(value);
fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',briefCases:12,invalidOutputCases:invalid.length,realProviderRequests:0},null,2));
console.log('strict fixture tool-output tests PASS');
