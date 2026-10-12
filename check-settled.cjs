const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const base='D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--';
for(const d of fs.readdirSync(base)){
  const f=path.join(base,d,'session.v3.jsonl.zstd'); if(!fs.existsSync(f))continue;
  if(Date.now()-fs.statSync(f).mtimeMs>420000)continue;
  const evs=decodeAll(fs.readFileSync(f)).split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const head=evs.find(e=>e.type==='session')||{};
  const desc=evs.find(e=>e.type==='subagent/descriptor');
  const spl=evs.filter(e=>e.type==='agent/inbox/spliced').flatMap(e=>(e.data&&e.data.inserted)||[]);
  const kinds={}; for(const it of spl){const k=(it.source&&it.source.kind)||'?';kinds[k]=(kinds[k]||0)+1}
  console.log('  '+String(head.id).slice(0,14)+'  parent='+String(head.parentSession||'(root)').slice(0,14).padEnd(15)+'  '+'turns='+evs.filter(e=>e.type==='turn/start').length+'  '+JSON.stringify(kinds)+'  '+((desc&&desc.data&&desc.data.label)||''));
}
