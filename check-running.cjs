const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const base='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--';
for(const d of ['63ae185f-ab7c-4810-b4f6-e58ecd1a19b6','session-e5adf9ae-9539-46b1-98fb-eac7a35945e8']){
  const f=path.join(base,d,'session.v3.jsonl.zstd');
  if(!fs.existsSync(f)){console.log(d+' missing');continue}
  const evs=decodeAll(fs.readFileSync(f)).split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const head=evs.find(e=>e.type==='session')||{};
  const types={}; for(const e of evs) types[e.type]=(types[e.type]||0)+1;
  const spl=evs.filter(e=>e.type==='agent/inbox/spliced').flatMap(e=>(e.data&&e.data.inserted)||[]);
  const ctxMsgs=spl.filter(it=>{const t=Array.isArray(it.content)?it.content.map(c=>c.text||'').join(' '):'';return t.includes('[team context]')});
  const chkMsgs=spl.filter(it=>{const t=Array.isArray(it.content)?it.content.map(c=>c.text||'').join(' '):'';return t.includes('[context check]')});
  const last=evs[evs.length-1];
  console.log('=== '+d.slice(0,20)+'  parent='+(head.parentSession||'(root)')+'  events='+evs.length);
  console.log('    turns='+(types['turn/start']||0)+'  steps='+(types['step/start']||0)+'  last='+new Date(last.time).toLocaleTimeString());
  console.log('    inbox splices='+spl.length+'  [team context]='+ctxMsgs.length+'  [context check]='+chkMsgs.length);
  if(chkMsgs.length){const t=chkMsgs[chkMsgs.length-1].content.map(c=>c.text||'').join(' ');console.log('    sample: '+t.slice(0,150).replace(/\n/g,' '))}
  if(ctxMsgs.length){const t=ctxMsgs[ctxMsgs.length-1].content.map(c=>c.text||'').join(' ');console.log('    ctx sample: '+t.slice(0,190).replace(/\n/g,' '))}
}
