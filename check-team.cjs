const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const f='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd';
const evs=decodeAll(fs.readFileSync(f)).split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const types={}; for(const e of evs) types[e.type]=(types[e.type]||0)+1;
console.log('team/member events: '+(types['team/member']||0));
const seen={};
for(const e of evs.filter(x=>x.type==='team/member')){const m=e.data.member;const key=m.name+'|'+m.phase;if(!seen[key]){seen[key]=1;console.log('  '+m.name+'  phase='+m.phase+'  level='+m.level)}}

// 现在实例内存里的 roster 从哪来？检查该 workspace 下最新 root 会话
console.log('--- 该 workspace 最新的 root 会话 ---');
const base='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--';
const roots=[];
for(const d of fs.readdirSync(base)){
  const p=base+'/'+d+'/session.v3.jsonl.zstd'; if(!fs.existsSync(p))continue;
  if(Date.now()-fs.statSync(p).mtimeMs>3600000)continue;
  const t=decodeAll(fs.readFileSync(p)); const h=t.split('\n')[0]; let j; try{j=JSON.parse(h)}catch{continue}
  if(j.parentSession)continue;
  roots.push(d.slice(0,20)+'  mtime='+new Date(fs.statSync(p).mtimeMs).toLocaleTimeString());
}
for(const r of roots) console.log('  '+r);
