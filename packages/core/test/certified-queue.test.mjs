import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,verify as verifySignature} from 'node:crypto';
import fs from 'node:fs';
import {assertCertifiedQueue} from '../goal-gate.mjs';
import {canonical,digest} from '../index.mjs';
function fixture(count=3) {
 const tasks=new Map(), rows=[];const links=new Set();
 for(let i=0;i<count;i++){
  const taskId='task:'+i, task={approved:true,scopeSet:['part-'+i],contractRevision:1};tasks.set(taskId,task);
  const c={base:i?'commit-'+(i-1):'initial',candidate:'commit-'+i,tree:'tree-'+i,verifier:'member:verifier',contractRevision:1,
   contractHash:digest(task)};const keys=generateKeyPairSync('ed25519');
  rows.push({entityId:'delivery:'+i,taskId,owner:'member:worker-'+i,status:'accepted',base:c.base,candidate:c.candidate,tree:c.tree,
   integrationCommit:c.candidate,integrationTree:c.tree,certificate:c,certificateHash:digest(c),
   publicKey:keys.publicKey,signature:sign(null,Buffer.from(canonical(c)),keys.privateKey).toString('base64'),keys});
  links.add(c.base+'>'+c.candidate);
 }
 const options={initialBase:'initial',head:'commit-'+(count-1),headTree:'tree-'+(count-1),readTask:id=>tasks.get(id),isAncestor:(a,b)=>links.has(a+'>'+b)};
 const resign=d=>{d.certificateHash=digest(d.certificate);d.signature=sign(null,Buffer.from(canonical(d.certificate)),d.keys.privateKey).toString('base64');};
 return {rows,tasks,options,resign};
}
const rejects=(f,code,fn=assertCertifiedQueue)=>assert.throws(()=>fn(f.rows,f.options),e=>e.code===code);
test('single certified delivery closes at its exact target',()=>{const f=fixture(1);assert.deepEqual(assertCertifiedQueue(f.rows,f.options),['delivery:0']);});
test('three certified deliveries are ordered by links, not input order',()=>{const f=fixture();f.rows.reverse();assert.deepEqual(assertCertifiedQueue(f.rows,
  f.options),['delivery:0','delivery:1','delivery:2']);});
test('uncertified descendant after the tail is TARGET_DRIFT',()=>{const f=fixture();f.options.head='uncertified-child';f.options.isAncestor=()=>true;rejects(f,
  'TARGET_DRIFT');});
test('non-ancestor target movement is TARGET_DRIFT',()=>{const f=fixture();f.options.head='unrelated-branch';rejects(f,'TARGET_DRIFT');});
test('a signed queue link that is not a Git ancestor is TARGET_DRIFT',()=>{const f=fixture();f.options.isAncestor=()=>false;rejects(f,'TARGET_DRIFT');});
test('gap, including wrong initial goal base, is DELIVERY_CHAIN_GAP',()=>{const f=fixture();f.rows.splice(1,1);rejects(f,'DELIVERY_CHAIN_GAP');const g=fixture(
  );g.options.initialBase='wrong';rejects(g,'DELIVERY_CHAIN_GAP');});
test('two successors of one base are DELIVERY_CHAIN_FORK',()=>{const f=fixture();const d=f.rows[2];d.base=d.certificate.base='initial';f.resign(d);rejects(f,
  'DELIVERY_CHAIN_FORK');});
test('tampered certificate digest is UNMET_DELIVERY',()=>{const f=fixture();f.rows[0].certificate.verifier='forged';rejects(f,'UNMET_DELIVERY');});
test('bad signature is STALE_CERTIFICATE even with a fresh digest',()=>{const f=fixture();f.rows[0].signature=Buffer.alloc(64).toString('base64');rejects(f,
  'STALE_CERTIFICATE');});
test('changed task contract is STALE_CERTIFICATE',()=>{const f=fixture();f.tasks.get('task:0').contractRevision++;rejects(f,'STALE_CERTIFICATE');});
test('wrong chain-tail tree is TARGET_DRIFT',()=>{const f=fixture();f.options.headTree='unverified-tree';rejects(f,'TARGET_DRIFT');});
test('an async ancestry answer cannot authorize a synchronous goal guard',()=>{const f=fixture();f.options.isAncestor=async()=>true;rejects(f,'TARGET_DRIFT');
  });
test('missing first acceptance base is DELIVERY_CHAIN_GAP',()=>{const f=fixture();delete f.options.initialBase;rejects(f,'DELIVERY_CHAIN_GAP');});
test('mutation: descendant instead of exact tail equality is killed by the descendant negative case',()=>{
 const source=fs.readFileSync(new URL('../goal-gate.mjs',import.meta.url),'utf8');
 const begin=source.indexOf('export function assertCertifiedQueue('),end=source.indexOf('/** Read committed delivery evidence',begin);
 const original=source.slice(begin,end).replace('export function','function');
 const mutant=original.replace('head !== tail.integrationCommit || headTree !== tail.integrationTree','!isAncestor(tail.integrationCommit, head)');
 assert.notEqual(mutant,original,'the intended equality site must be mutated');
 const fn=new Function('fail','digest','canonical','verifySignature',mutant+'; return assertCertifiedQueue;')(
  code=>{throw Object.assign(Error(code),{code});},digest,canonical,verifySignature);
 const f=fixture();f.options.head='uncertified-child';f.options.isAncestor=()=>true;
 rejects(f,'TARGET_DRIFT');
 assert.throws(()=>rejects(f,'TARGET_DRIFT',fn),assert.AssertionError,'the same refusal assertion fails under the descendant mutant');
});
