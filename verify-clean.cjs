const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const p=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{p.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{}i+=1}return Buffer.concat(p).toString('utf8')}
const files=[
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-ced09189-b46a-4fb5-adb1-00d0c2faadc4/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-b8f7c4d7-b0a6-4c4e-a6b5-9056045cfd13/session.v3.jsonl.zstd',
'+'.slice(0,0)+'D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--/session-30f1e364-7033-4349-8723-b299f6b104f6/session.v3.jsonl.zstd',
'+'.slice(0,0)+'D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--/session-732c7f63-10e6-45d6-a18e-90a0bd3d9cdf/session.v3.jsonl.zstd',
'+'.slice(0,0)+'D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--/session-abbcf2f9-fdaf-4b4a-a454-e53c0502b200/session.v3.jsonl.zstd',
];
for(const f of files){
  if(!fs.existsSync(f)){console.log('MISSING '+f);continue}
  let text; try{text=decodeAll(fs.readFileSync(f))}catch(e){console.log('UNDECODABLE '+f);continue}
  let lines=0,bad=0; const types={};
  for(const l of text.split('\n')){ if(!l.trim())continue; lines++; try{const e=JSON.parse(l); types[e.type]=(types[e.type]||0)+1}catch{bad++} }
  const hasUsage=text.includes('"team/usage"');
  console.log((bad===0&&!hasUsage?'OK   ':'BAD  ')+f.split('/').slice(-2)[0].slice(0,24)+'  events='+lines+' badJson='+bad+' teamUsage='+hasUsage);
  if(bad===0) console.log('      types: '+JSON.stringify(types).slice(0,200));
}
