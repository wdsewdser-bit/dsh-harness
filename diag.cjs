const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const parts=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch(e){}i+=1}return Buffer.concat(parts).toString('utf8')}
const f='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-4a1d8fcf-bfc5-4929-aea8-1f204e71d875/session.v3.jsonl.zstd';
const text=decodeAll(fs.readFileSync(f));
const evs=[];for(const l of text.split('\n')){if(!l.trim())continue;try{evs.push(JSON.parse(l))}catch{}}
const calls=new Map(), results=new Map();
for(const e of evs){
  const d=e.data||{};
  if(e.type==='tool/call'){const cid=d.callId;if(cid)calls.set(cid,{t:e.time,args:d.arguments})}
  if(e.type==='tool/result'){const cid=d.message&&d.message.source&&d.message.source.callId;if(cid)results.set(cid,e.time)}
}
const durs=[];
for(const [cid,c] of calls){const rt=results.get(cid);if(!rt)continue;durs.push({ms:rt-c.t,args:String(c.args||'').slice(0,120)})}
durs.sort((a,b)=>b.ms-a.ms);
console.log('run_code calls with result:', durs.length);
const buckets={'<1s':0,'1-5s':0,'5-20s':0,'20-35s':0,'35-60s':0,'>60s':0};
for(const d of durs){const s=d.ms/1000;if(s<1)buckets['<1s']++;else if(s<5)buckets['1-5s']++;else if(s<20)buckets['5-20s']++;else if(s<35)buckets['20-35s']++;else if(s<60)buckets['35-60s']++;else buckets['>60s']++}
console.log('duration buckets:', JSON.stringify(buckets));
console.log('--- top 8 slowest ---');
for(const d of durs.slice(0,8)) console.log('  '+(d.ms/1000).toFixed(1)+'s  '+d.args.replace(/\n/g,' ').slice(0,110));
const waits=durs.filter(d=>d.args.includes('wait_agent'));
console.log('--- run_code calls containing wait_agent: '+waits.length);
for(const d of waits) console.log('  '+(d.ms/1000).toFixed(1)+'s  '+d.args.replace(/\n/g,' ').slice(0,150));
