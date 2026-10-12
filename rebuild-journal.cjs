const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function frames(buf){const out=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){out.push(i);i+=1}return out}
const targets=[
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-ced09189-b46a-4fb5-adb1-00d0c2faadc4/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-b8f7c4d7-b0a6-4c4e-a6b5-9056045cfd13/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--/session-30f1e364-7033-4349-8723-b299f6b104f6/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--/session-732c7f63-10e6-45d6-a18e-90a0bd3d9cdf/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspace-mini--/session-abbcf2f9-fdaf-4b4a-a454-e53c0502b200/session.v3.jsonl.zstd',
];
for(const f of targets){
  if(!fs.existsSync(f))continue;
  const bak=f+'.pre-teamusage.bak';
  const buf=fs.readFileSync(fs.existsSync(bak)?bak:f);
  const starts=frames(buf); const lines=[];
  for(let i=0;i<starts.length;i++){
    const end=i+1<starts.length?starts[i+1]:buf.length;
    let t; try{t=zlib.zstdDecompressSync(buf.subarray(starts[i],end)).toString('utf8')}catch{continue}
    for(const l of t.split('\n')) if(l.trim()) lines.push(l);
  }
  const kept=[];
  for(const l of lines) if(!l.includes('"team/usage"')) kept.push(l);
  // Only events that CARRY a seq participate in numbering, and the header line does not,
  // so the counter starts at 0 for the first sequenced event rather than at 1.
  let n=0;
  const rebuilt=kept.map(l=>{
    let e; try{e=JSON.parse(l)}catch{return l}
    if(typeof e.seq==='number'){ e.seq=n; n++ }
    return JSON.stringify(e);
  });
  fs.writeFileSync(f, Buffer.concat(rebuilt.map(l=>zlib.zstdCompressSync(Buffer.from(l+'\n')))));
  console.log(f.split('/').slice(-2)[0].slice(0,24)+'  events='+rebuilt.length+' sequenced='+n);
}
