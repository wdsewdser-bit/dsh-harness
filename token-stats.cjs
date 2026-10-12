const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const parts=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch(e){}i+=1}return Buffer.concat(parts).toString('utf8')}
const root='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--';
const dirs=fs.readdirSync(root).filter(d=>fs.statSync(path.join(root,d)).isDirectory());
const rows=[];
for(const d of dirs){
  const f=path.join(root,d,'session.v3.jsonl.zstd');
  if(!fs.existsSync(f)) continue;
  const text=decodeAll(fs.readFileSync(f));
  let label='',parent='',depth=0,input=0,output=0,cached=0,total=0,turns=0,steps=0;
  for(const l of text.split('\n')){
    if(!l.trim()) continue; let e; try{e=JSON.parse(l)}catch{continue}
    if(e.type==='subagent/descriptor'){label=e.data&&e.data.label||label;depth=e.delegationDepth||0}
    if(e.type==='session'){parent=e.parentSession||'';if(e.delegationDepth!==undefined)depth=e.delegationDepth}
    if(e.type==='turn/start')turns++;
    if(e.type==='step/start')steps++;
    const u=e.data&&e.data.usage;
    if(u&&typeof u.inputTokens==='number'){input+=u.inputTokens;output+=u.outputTokens;cached+=u.cacheReadTokens||0;total+=u.totalTokens}
  }
  const key=d.replace('session-','').slice(0,8);
  rows.push({key,dir:d,label,parent,depth,input,output,cached,total,turns,steps});
}
const byKey={};for(const r of rows)byKey[r.key]=r;
const main=rows.find(r=>r.dir.startsWith('session-4a1d8f'));
const isMine=new Set([main.key]);
let grew=true;while(grew){grew=false;for(const r of rows){if(isMine.has(r.key))continue;const p=(r.parent||'').replace('session-','').slice(0,8);if(p&&isMine.has(p)){isMine.add(r.key);grew=true}}}
const mine=rows.filter(r=>isMine.has(r.key));const others=rows.filter(r=>!isMine.has(r.key));
const S=(a,k)=>a.reduce((x,r)=>x+(r[k]||0),0);
console.log('MAIN turns='+main.turns+' steps='+main.steps+' total='+main.total);
console.log('THIS TEAM: agents='+mine.length+' (1 main + '+(mine.length-1)+' sub) total='+S(mine,'total')+' in='+S(mine,'input')+' out='+S(mine,'output')+' cached='+S(mine,'cached'));
console.log('unrelated sessions:', others.map(r=>r.dir.slice(0,20)+' turns='+r.turns+' steps='+r.steps+' total='+r.total).join(' | '));
console.log('--- team members by depth ---');
for(const r of mine.sort((a,b)=>b.total-a.total)) console.log('  d'+(r.depth||0)+' '+(r.label||r.key).slice(0,24).padEnd(26),'total='+String(r.total).padStart(10),'turn='+String(r.turns).padStart(4),'step='+String(r.steps).padStart(4));
