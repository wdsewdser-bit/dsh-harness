import fs from 'node:fs';import crypto from 'node:crypto';
const c1='<path-to-dsh-c1-build-0.2.2-rc.1>/node_modules/@deepseek-ai/',c2='<path-to-dsh-c2-build-0.2.2-rc.1>/node_modules/@deepseek-ai/',up='<path-to-dsh-upstream-0.2.2-rc.1>/install/node_modules/@deepseek-ai/';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const scope=JSON.parse(fs.readFileSync(new URL('./build-scope.json',import.meta.url),'utf8'));
for(const r of scope['<path-to-dsh-c1-build-0.2.2-rc.1>'].changed)if(hash('<path-to-dsh-c1-build-0.2.2-rc.1>/'+r.file)!==r.after)throw Error('PREIMAGE_DRIFT');
for(const file of ['dsh-agent-loop/lib/index.js','dsh-agent-loop/lib/types/index.d.ts'])fs.copyFileSync(up+file,c1+file);
for(const n of ['team-layout','goal-veto']){
 const files=new Set(JSON.parse(fs.readFileSync(new URL('./'+n+'/plan.json',import.meta.url),'utf8')).map(r=>r.file));
 for(const file of files){if(hash(c1+file)!==hash(up+file))throw Error('UNEXPECTED_C1_PATCH:'+file);fs.copyFileSync(c2+file,c1+file);}
}
fs.rmSync(c1+'dsh-tool-executor-preempt',{recursive:true,force:true});
console.log('PASS actual legacy composition restored: C1 goal-veto + team-layout; C2 all three');
