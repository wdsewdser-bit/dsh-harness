const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const base='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--';
const f=path.join(base,'session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd');
const evs=decodeAll(fs.readFileSync(f)).split('\n').filter(l=>l.trim()).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const withUsage=evs.filter(e=>e.type==='assistant/message'&&e.data&&e.data.usage);
console.log('assistant messages with usage: '+withUsage.length);
const recent=withUsage.slice(-14);
console.log('--- 最近 14 条 usage ---');
for(const e of recent){
  const u=e.data.usage;
  const prompt=(u.uncachedInputTokens||0)+(u.cacheReadTokens||0)+(u.cacheWriteTokens||0);
  const pct=prompt>0?Math.round(((u.cacheReadTokens||0)/prompt)*100):0;
  console.log('  in='+String(u.uncachedInputTokens||0).padStart(8)+' cacheRead='+String(u.cacheReadTokens||0).padStart(9)+' out='+String(u.outputTokens||0).padStart(6)+'  命中='+String(pct).padStart(3)+'%');
}
const last6=withUsage.slice(-6);
let sumP=0,sumC=0;
for(const e of last6){const u=e.data.usage;sumP+=(u.uncachedInputTokens||0)+(u.cacheReadTokens||0)+(u.cacheWriteTokens||0);sumC+=(u.cacheReadTokens||0)}
console.log('最近 6 条整体命中率: '+(sumP>0?Math.round(sumC/sumP*100):0)+'%');
