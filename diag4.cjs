const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const parts=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch(e){}i+=1}return Buffer.concat(parts).toString('utf8')}
const f='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd';
const text=decodeAll(fs.readFileSync(f));
const evs=[];for(const l of text.split('\n')){if(!l.trim())continue;try{evs.push(JSON.parse(l))}catch{}}
console.log('events:', evs.length);
const types={};for(const e of evs){types[e.type]=(types[e.type]||0)+1}
console.log('types:', JSON.stringify(types).slice(0,700));
console.log('--- team/member events ---');
for(const e of evs.filter(x=>x.type==='team/member')){const m=e.data.member;console.log('  '+(m.name||'?')+' phase='+m.phase+' level='+(m.level===undefined?'-':m.level)+' group='+(m.groupId||'-')+' frozen='+(m.frozen===undefined?'-':m.frozen)+(m.error?(' err='+String(m.error).slice(0,60)):''))}
