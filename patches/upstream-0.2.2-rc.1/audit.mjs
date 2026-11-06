import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
import { PRISTINE, PRISTINE_ROOT, C1, C2 } from './paths.mjs';
const root=new URL('./',import.meta.url),hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const scan=root=>{const files=new Map();function walk(dir,rel=''){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const next=path.join(dir,ent.name),r=rel+ent.name;if(fs.lstatSync(next).isSymbolicLink())throw Error('LINK:'+next);if(ent.isDirectory())walk(next,r+'/');else files.set(r,hash(next));}}walk(root);return files;};
const report={};
for(const [version,source,builds] of [
 ['old','<path-to-dsh-upstream-0.2.1-rc.4>/install',['<path-to-dsh-c1-build>','<path-to-dsh-c2-build>']],
 ['new',PRISTINE_ROOT,[C1,C2]]]){
 const base=scan(source);for(const build of builds){const found=scan(build),changed=[],added=[],missing=[];for(const [file,sha]of base){if(!found.has(file))missing.push(file);else if(found.get(file)!==sha)changed.push({file,before:sha,after:found.get(file)});}for(const file of found.keys())if(!base.has(file))added.push(file);report[build]={version,source,baseFiles:base.size,files:found.size,changed,added,missing};console.log(build+': '+base.size+' base files, '+changed.length+' changed, '+added.length+' added, '+missing.length+' missing');}
}
for(const [build,r] of Object.entries(report)) {
 const base=['dsh-goal/lib/index.js','dsh-goal/lib/types/index.d.ts',...JSON.parse(fs.readFileSync(new URL('team-layout/plan.json',root),'utf8')).map(x=>x.file)];
 const isC2=build.includes('dsh-c2-build');
 if(isC2)base.push('dsh-agent-loop/lib/index.js','dsh-agent-loop/lib/types/index.d.ts');
 const expected=[...new Set(base.map(p=>'node_modules/@deepseek-ai/'+p))].sort();
 if(JSON.stringify(r.changed.map(x=>x.file).sort())!==JSON.stringify(expected)||r.missing.length)throw Error('BUILD_SCOPE_DRIFT:'+build);
 const added=r.version==='new'&&isC2?['node_modules/@deepseek-ai/dsh-tool-executor-preempt/lib/index.js','node_modules/@deepseek-ai/dsh-tool-executor-preempt/package.json']:[];
 if(JSON.stringify(r.added.sort())!==JSON.stringify(added.sort()))throw Error('ADDED_FILE_DRIFT:'+build);
}
fs.writeFileSync(new URL('build-scope.json',root),JSON.stringify(report,null,2));
const stats={};
for(const n of ['instant-preempt','team-layout','goal-veto']){
 const build=(n==='instant-preempt'?C2:C1);
 const files=n==='instant-preempt'?['dsh-agent-loop/lib/index.js','dsh-agent-loop/lib/types/index.d.ts']:JSON.parse(fs.readFileSync(new URL(n+'/plan.json',root),'utf8')).map(x=>x.file);
 let patch='';for(const file of new Set(files)){
  const original=new URL(n+'/original/'+file,root);fs.mkdirSync(new URL('./',original),{recursive:true});
  if(n==='instant-preempt')fs.copyFileSync(PRISTINE+file,original);
  const diff=spawnSync('git',['-c','core.autocrlf=false','diff','--no-index','--no-ext-diff','--no-color','--',original.pathname.replace(/^\/([A-Z]:)/,'$1'),build+'/node_modules/@deepseek-ai/'+file],{encoding:'utf8'});
  if(diff.status!==1)throw Error('DIFF_FAILED:'+diff.status+':'+diff.stderr);
  const lines=diff.stdout.split('\n');const start=lines.findIndex(l=>l.startsWith('@@'));
  patch+='--- a/'+file+'\n+++ b/'+file+'\n'+lines.slice(start).join('\n');
 }
 fs.writeFileSync(new URL(n+'/candidate.patch',root),patch);
 const lines=patch.split('\n');stats[n]={hunks:lines.filter(l=>l.startsWith('@@')).length,added:lines.filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length,removed:lines.filter(l=>l.startsWith('-')&&!l.startsWith('---')).length};
}
fs.writeFileSync(new URL('patch-stats.json',root),JSON.stringify(stats,null,2));console.log(JSON.stringify(stats));
