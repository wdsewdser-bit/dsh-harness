import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import { C1, C2 } from './paths.mjs';
const root=fileURLToPath(new URL('./',import.meta.url)),repo=fileURLToPath(new URL('../../',import.meta.url));

const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),result=[];
for(const name of ['instant-preempt','team-layout','goal-veto']){
 const dest=root+'roundtrip/'+Date.now()+'-'+name,relative=path.relative(repo,dest).replaceAll('\\','/'),build=(name==='instant-preempt'?C2:C1)+'/node_modules/@deepseek-ai/';
 const files=name==='instant-preempt'?['dsh-agent-loop/lib/index.js','dsh-agent-loop/lib/types/index.d.ts']:[...new Set(JSON.parse(fs.readFileSync(root+name+'/plan.json','utf8')).map(r=>r.file))];
 for(const f of files){fs.mkdirSync(path.dirname(dest+'/'+f),{recursive:true});fs.copyFileSync(root+name+'/original/'+f,dest+'/'+f);}
 const patch=root+name+'/candidate.patch';for(const check of [true,false]){const args=['-c','core.autocrlf=false','apply',...(check?['--check']:[]),'--directory='+relative,patch];const r=spawnSync('git',args,{cwd:repo,encoding:'utf8'});if(r.status!==0)throw Error('PATCH_'+(check?'CHECK':'APPLY')+':'+name+':'+r.stderr);}
 for(const f of files)if(hash(dest+'/'+f)!==hash(build+f))throw Error('ROUNDTRIP_HASH_MISMATCH:'+f);
 result.push({name,files:files.length,ok:true});console.log('PASS '+name+' candidate.patch --check + apply: byte-identical postimage');
}
fs.writeFileSync(root+'patch-roundtrip.json',JSON.stringify(result,null,2));
