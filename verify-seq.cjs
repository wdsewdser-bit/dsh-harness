const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
const files=[
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-e5adf9ae-9539-46b1-98fb-eac7a35945e8/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-ced09189-b46a-4fb5-adb1-00d0c2faadc4/session.v3.jsonl.zstd',
'D:/dsh-test/home/sessions/--D-dsh-test-workspaces-test--/session-b8f7c4d7-b0a6-4c4e-a6b5-9056045cfd13/session.v3.jsonl.zstd',
];
for(const f of files){
  const buf=fs.readFileSync(f); const parts=[]; let i=0;
  while((i=buf.indexOf(MAGIC,i))!==-1){ try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch{} i+=1 }
  const lines=Buffer.concat(parts).toString('utf8').split('\n').filter(l=>l.trim());
  let gaps=0,bad=0,usage=0,ignorable=0,first=null,last=null,srcRefs=0,srcBad=0;
  const seqOf=new Map();
  const parsed=[];
  for(const l of lines){ let e; try{e=JSON.parse(l)}catch{bad++;continue} parsed.push(e); }
  for(const e of parsed){ if(typeof e.seq==='number') seqOf.set(e.seq,true) }
  for(const e of parsed){
    if(e.type==='team/usage'){ usage++; if(e.ignorable===true) ignorable++ }
    const s=e.seq;
    if(typeof s==='number'){ if(first===null)first=s; if(last!==null&&s!==last+1)gaps++; last=s }
    // every referenced source seq must exist and be earlier than this event
    const refs=e.sourceEventSeqs;
    if(Array.isArray(refs)) for(const r of refs){ srcRefs++; const v=typeof r==='number'?r:(r&&typeof r.seq==='number'?r.seq:null); if(v===null||!seqOf.has(v)||v>=s) srcBad++ }
  }
  const ok=gaps===0&&bad===0&&first===0&&usage===ignorable&&srcBad===0;
  console.log((ok?'OK  ':'BAD ')+f.split('/').slice(-2)[0].slice(0,24)+'  events='+lines.length+' firstSeq='+first+' gaps='+gaps+' badJson='+bad+' usage='+usage+' ignorable='+ignorable+' srcRefs='+srcRefs+' srcBad='+srcBad);
}
