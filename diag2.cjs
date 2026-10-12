const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const parts=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch(e){}i+=1}return Buffer.concat(parts).toString('utf8')}
const root='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--';
const dirs=fs.readdirSync(root).filter(d=>fs.statSync(path.join(root,d)).isDirectory());
function evs(d){const f=path.join(root,d,'session.v3.jsonl.zstd');if(!fs.existsSync(f))return[];const t=decodeAll(fs.readFileSync(f));const o=[];for(const l of t.split('\n')){if(!l.trim())continue;try{o.push(JSON.parse(l))}catch{}}return o}
const mainDir=dirs.find(d=>d.startsWith('session-4a1d8f'));
const main=evs(mainDir);
const id2name={}, name2id={};
for(const d of dirs){const e=evs(d);const first=e.find(x=>x.type==='session');if(!first)continue;const sid=first.id;
  const desc=e.find(x=>x.type==='subagent/descriptor');const label=desc&&desc.data&&desc.data.label;
  id2name[sid]=label||sid.slice(0,10);name2id[label||sid.slice(0,10)]=sid}
const q=main.filter(e=>e.type==='team/message/queued').map(e=>e.data.message);
const to={},from={};
for(const m of q){const t=id2name[m.targetId]||String(m.targetId).slice(0,10);to[t]=(to[t]||0)+1;from[m.senderName]=(from[m.senderName]||0)+1}
const sort=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]);
console.log('MESSAGES -> recipient (in MAIN journal, '+q.length+' total)');
for(const [k,v] of sort(to)) console.log('   '+String(v).padStart(4)+'  '+k);
console.log('MESSAGES from sender');
for(const [k,v] of sort(from)) console.log('   '+String(v).padStart(4)+'  '+k);
console.log('--- 每个子代理 journal 里收到的消息 ---');
for(const d of dirs){const e=evs(d);const first=e.find(x=>x.type==='session');if(!first)continue;const sid=first.id;
  const inbox=e.filter(x=>x.type==='team/message/queued'&&x.data.message.targetId===sid);
  const label=id2name[sid];
  if(inbox.length>0||label) console.log('   '+String(inbox.length).padStart(4)+'  '+(label||sid.slice(0,10)));
}
