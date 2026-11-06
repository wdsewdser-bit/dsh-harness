import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildConfig, buildTarget} from '../../packages/adapter-dsh/build-target.mjs';

// Equivalent to instant-preempt/run.mjs but uses the selected prepared copy and the current product host, rather than
// the historic C1/C2 paths and deleted lifecycle driver. The native probes, executor parity and product wake all run.
const root=path.resolve(process.argv[2]??'');
assert(root.toLowerCase().replaceAll('\\','/').startsWith(process.cwd().replaceAll('\\', '/').toLowerCase() + '/runs/'),'PREEMPT_COPY_SCOPE');
assert(!fs.existsSync(root),'the evidence root must be new');fs.mkdirSync(root,{recursive:true});
const target=buildTarget();
const env={...process.env,DSH_PREEMPT_TEST_BUILD:target.build};delete env.CLOSEOUT_PROVIDER_KEY;
const script='patches/'+buildConfig().patches+'/instant-preempt/';
const child=(name,args)=>{const r=spawnSync(process.execPath,[name,...args],{env,encoding:'utf8',timeout:90000,windowsHide:true});
  const output=(r.stdout??'')+(r.stderr??'');assert.equal(r.status,0,name+' failed: '+output);return output;};
for(const mode of ['original','patched','cold','instant'])child(script+'probe.mjs',[mode,path.join(root,mode)]);
const load=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
assert.deepEqual(load('patched/default.json'),load('original/default.json'),'flag off must reproduce the pristine journal');
const cold=load('cold/cold.json');assert.equal(cold.replayEqualsJournal,true);assert.equal(cold.requestsWhileResuming,0);
const cases=load('instant/instant.json');for(const name of ['A','B','C','D','E','F','G'])assert.equal(cases[name]?.ok,true,'missing instant case '+name);
const executor=child(script+'executor-probe.mjs',[]);assert.match(executor,/PASS executor switch-off parity/);
const product=child('verification/fixtures/preempt-product-test.mjs',[path.join(root,'product')]);assert.match(product,/real preempt product PASS/);
const completed=child('verification/fixtures/preempt-completed-test.mjs',[path.join(root,'completed')]);
assert.match(completed,/completed response preempt PASS/);
const noFinish=child('verification/fixtures/preempt-completed-test.mjs',[path.join(root,'no-finish'),'--no-finish']);
assert.match(noFinish,/completed response preempt PASS/);
const transport=child('verification/fixtures/preempt-transport-test.mjs',[path.join(root,'transport')]);assert.match(transport,/real transport preempt PASS/);
fs.writeFileSync(path.join(root,'report.json'),JSON.stringify({status:'passed',build:target.build,cases:['A','B','C','D','E','F','G'],
  coldReplay:true,requestsWhileResuming:0,switchOffParity:true,executorParity:true,productWake:true,transportWake:true},null,2));
console.log('instant preempt copy PASS: A-G, cold replay, switch-off parity, executor drain and product wake');
