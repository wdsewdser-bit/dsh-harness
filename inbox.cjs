const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const f='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd';
const evs=decodeAll(fs.readFileSync(f)).split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const spl=evs.filter(e=>e.type==='agent/inbox/spliced');
console.log('inbox splices:', spl.length);
const kinds={};
for(const e of spl){const items=(e.data&&e.data.inserted)||[];for(const it of items){const k=(it.source&&it.source.kind)||'?';kinds[k]=(kinds[k]||0)+1}}
console.log('splice sources:', JSON.stringify(kinds));
console.log('--- first 6 splices with content ---');
for(const e of spl.slice(0,6)){
  const items=(e.data&&e.data.inserted)||[];
  for(const it of items){
    const txt=Array.isArray(it.content)?it.content.map(c=>c.text||'').join(' '):'';
    console.log('  ['+((it.source&&it.source.kind)||'?')+'] '+txt.slice(0,150).replace(/\n/g,' '));
  }
}
