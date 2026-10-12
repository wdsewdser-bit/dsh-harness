const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const parts=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch(e){}i+=1}return Buffer.concat(parts).toString('utf8')}
const root='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--';
const dirs=fs.readdirSync(root).filter(d=>fs.statSync(path.join(root,d)).isDirectory());
for(const d of dirs){
  const f=path.join(root,d,'session.v3.jsonl.zstd'); if(!fs.existsSync(f))continue;
  const text=decodeAll(fs.readFileSync(f));
  if(!text.includes('打断')) continue;
  const evs=[];for(const l of text.split('\n')){if(!l.trim())continue;try{evs.push(JSON.parse(l))}catch{}}
  const desc=evs.find(e=>e.type==='subagent/descriptor');
  const label=(desc&&desc.data&&desc.data.label)||d.slice(0,14);
  for(const e of evs){
    if(e.type!=='assistant/message') continue;
    const s=JSON.stringify(e.data);
    if(!s.includes('打断')) continue;
    const i=s.indexOf('打断');
    console.log('['+label+'] ...'+s.slice(Math.max(0,i-320),i+320).replace(/\\n/g,' '));
    console.log('');
  }
}
