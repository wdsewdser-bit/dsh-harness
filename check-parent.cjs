const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const base='D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--';
const rows=[];
for(const d of fs.readdirSync(base)){
  const dir=path.join(base,d), f=path.join(dir,'session.v3.jsonl.zstd');
  if(!fs.existsSync(f))continue;
  if(Date.now()-fs.statSync(f).mtimeMs>600000)continue;
  const text=decodeAll(fs.readFileSync(f));
  const evs=text.split('\n').map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const head=evs.find(e=>e.type==='session')||{};
  const desc=evs.find(e=>e.type==='subagent/descriptor');
  rows.push({id:head.id,parent:head.parentSession||'(root)',label:(desc&&desc.data&&desc.data.label)||'(root)',t:fs.statSync(f).mtimeMs});
}
rows.sort((a,b)=>a.t-b.t);
for(const r of rows) console.log('  '+String(r.id).slice(0,14)+'  parent='+String(r.parent).slice(0,14).padEnd(16)+'  '+r.label);
