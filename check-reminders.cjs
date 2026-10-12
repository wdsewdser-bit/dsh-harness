const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const base='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--';
let found=0;
for(const d of fs.readdirSync(base)){
  const f=path.join(base,d,'session.v3.jsonl.zstd');
  if(!fs.existsSync(f))continue;
  if(Date.now()-fs.statSync(f).mtimeMs>3600000)continue;
  const text=decodeAll(fs.readFileSync(f));
  if(!text.includes('context check')&&!text.includes('team context'))continue;
  const evs=text.split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const head=evs.find(e=>e.type==='session')||{};
  const spl=evs.filter(e=>e.type==='agent/inbox/spliced').flatMap(e=>(e.data&&e.data.inserted)||[]);
  const chk=spl.filter(it=>{const t=Array.isArray(it.content)?it.content.map(c=>c.text||'').join(' '):'';return t.includes('[context check]')}).length;
  const ctx=spl.filter(it=>{const t=Array.isArray(it.content)?it.content.map(c=>c.text||'').join(' '):'';return t.includes('[team context]')}).length;
  if(chk||ctx){found++;console.log('  '+String(head.id).slice(0,16)+'  [context check]='+chk+'  [team context]='+ctx)}
}
if(!found)console.log('  (none found in the last hour)');
