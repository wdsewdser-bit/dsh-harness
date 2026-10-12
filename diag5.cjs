const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const parts=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch(e){}i+=1}return Buffer.concat(parts).toString('utf8')}
const f='D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd';
const text=decodeAll(fs.readFileSync(f));
const evs=[];for(const l of text.split('\n')){if(!l.trim())continue;try{evs.push(JSON.parse(l))}catch{}}
console.log('=== command/run + done ===');
for(const e of evs.filter(x=>x.type==='command/run'||x.type==='command/done')) console.log('  ['+e.type+'] '+JSON.stringify(e.data).slice(0,220));
console.log('=== refusal / freeze / limit 相关 ===');
for(const e of evs){const s=JSON.stringify(e);if(/refus|freeze|Team member limit|budget|TEAM_MEMBER|TEAM_CREATE/.test(s)){console.log('  ['+e.type+'] '+s.slice(0,300));console.log('')}}
