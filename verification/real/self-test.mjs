import { fakeProvider } from './fake.mjs';
import fs from 'node:fs';import assert from 'node:assert/strict';import {Budget,usage} from './budget.mjs';import {policy,stages} from './config.mjs';import {
  summarize} from './metrics.mjs';const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});const globalLimit=policy
.globalLimit,base=globalLimit-50000,ledger=root+'/ledger.json';let sent=0,b=new Budget(ledger,'smoke');async function fake(bound,input,output){b.reserve(bound);
  sent++;b.settle(usage({input_tokens:input,output_tokens:output,input_tokens_details:{cached_tokens:100000}}))}const room=stages.smoke-400000;await fake(
    450000,
  350000,50000);await assert.rejects(()=>fake(room+1,350000,50000),/BUDGET_STOP_BEFORE_REQUEST/);assert.equal(sent,1);assert.equal(b.data.total,400000);
  b.close();
b=new Budget(ledger,'smoke');assert.equal(b.data.total,400000);assert.equal(b.data.cacheHit,100000);assert.equal(b.data.cacheMiss,250000);assert(!b
  .canAdmit(room+1));assert(b.canAdmit(room));b.close();const global=root+'/global.json';fs.writeFileSync(global,JSON.stringify({version:1,total:base,stages:{},
      input:base,output:0,cacheHit:0,cacheMiss:base,pending:null}));b=new Budget(global,'soak');assert(!b.canAdmit(50001));b.reserve(50000);b.settle({input:
        45000,
    output:5000,cacheHit:null,cacheMiss:null});assert.equal(b.data.total,globalLimit);assert(!b.canAdmit(1));b.close();b=new Budget(root+'/uncertain.json',
      'smoke');
b.reserve(100000);b.close();assert.throws(()=>new Budget(root+'/uncertain.json','smoke'),/RECONCILIATION/);b=new Budget(root+'/overrun.json','smoke');b
.reserve(100);assert.throws(()=>b.settle({input:1000,output:1,cacheHit:null,cacheMiss:null}),/USAGE_BOUND_VIOLATION/);assert.equal(b.data.total,1001);b.close();
assert.throws(()=>new Budget(root+'/overrun.json','smoke'),/RECONCILIATION/);fs.writeFileSync(root+'/report.json',JSON.stringify({status:'passed',
      fakeRequests:sent,blockedRequests:1,recordedTokens:400000,globalHardStop:globalLimit,crashPendingFailClosed:true,usageOverrunFailClosed:true,
      realProviderRequests:0},null,2));console
.log('budget fake provider PASS: one 400000-token request, second request not sent; persistence/global/pending/overrun PASS');
// A pending row (or marker elsewhere in the request) is not evidence that the model read its instruction.
const instruction={entityId:'message:instruction',sender:'member:root',recipient:'member:a1',kind:'action',visible:false,
  summary:'Cross-peer task cycle 1'};
const engine={states:new Map([['a1',{}]]),core:{pending:()=>[instruction]},cycle:{id:1,sent:new Set(),deliveries:[],
  assignments:{a1:{to:'b1',own:7}}}};
const provider=fakeProvider(engine),meta={actor:'a1',purpose:'main'};
const calls=result=>result.output.filter(item=>item.type==='function_call');
assert.equal(calls(await provider({input:[],tools:[]},meta)).length,0,'unseen stored instruction must not trigger a peer send');
const input=text=>[{type:'message',role:'user',content:[{type:'input_text',text}]}];
assert.equal(calls(await provider({input:input(instruction.summary),tools:[]},meta)).length,0,'unbound marker text is not an instruction');
const payload={self:{memberId:'member:a1'},responsibilities:[{messageId:instruction.entityId,from:'member:root',kind:'action'}],
  memberData:[{messageId:instruction.entityId,text:instruction.summary}]};
const carried='<team_snapshot rev="1" hash="fixture">\n'+JSON.stringify(payload)+'\n</team_snapshot>';
const action=calls(await provider({input:input(carried),tools:[]},meta));
assert.equal(action.length,1,'positive control: the request really carries the instruction');
assert.equal(action[0].name,'team_message');
assert.equal(JSON.parse(action[0].arguments).to,'member:b1');
// Production summaries are truncated to 80 characters: the carrying identity, not a marker substring in that
// truncated excerpt, proves the instruction was present. A marker anywhere else in input still proves nothing.
payload.memberData[0].text='Role/task contract header before the cycle detail'.repeat(2).slice(0,80);
const truncated='<team_snapshot rev="2" hash="fixture">\n'+JSON.stringify(payload)+'\n</team_snapshot>';
assert.equal(calls(await provider({input:input(truncated),tools:[]},meta))[0]?.name,'team_message');
payload.self.memberId='member:b1';
const wrongOwner='<team_snapshot rev="3" hash="fixture">\n'+JSON.stringify(payload)+'\n</team_snapshot>';
assert.equal(calls(await provider({input:input(wrongOwner),tools:[]},meta)).length,0,'another member snapshot is not authority');
console.log('fake instruction visibility PASS: empty/unbound request refused; carrying snapshot obeyed');
