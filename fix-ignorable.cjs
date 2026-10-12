/** Restore the team/usage events and mark them ignorable instead of deleting them. */
const fs=require('fs'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function frames(buf){const out=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){out.push(i);i+=1}return out}
const dirs=['--D-dsh-test-workspaces-test--','--D-dsh-test-workspace-mini--'];
let files=0,marked=0;
for(const ws of dirs){
  const base='D:/dsh-test/home/sessions/'+ws;
  if(!fs.existsSync(base))continue;
  for(const d of fs.readdirSync(base)){
    const f=base+'/'+d+'/session.v3.jsonl.zstd';
    if(!fs.existsSync(f))continue;
    const bak=f+'.pre-teamusage.bak';
    if(!fs.existsSync(bak))continue;
    // Restore the ORIGINAL bytes first: seq numbering and every sourceEventSeqs range in
    // them are internally consistent. Deleting events broke those ranges; marking the
    // unknown type ignorable keeps every number exactly as written.
    const buf=fs.readFileSync(bak);
    const starts=frames(buf); const lines=[];
    for(let i=0;i<starts.length;i++){
      const end=i+1<starts.length?starts[i+1]:buf.length;
      let t; try{t=zlib.zstdDecompressSync(buf.subarray(starts[i],end)).toString('utf8')}catch{buffer_fallback=true}
      if(t===undefined) continue;
      for(const l of t.split('\n')) if(l.trim()) lines.push(l);
    }
    const out=lines.map(l=>{
      if(!l.includes('"team/usage"')) return l;
      let e; try{e=JSON.parse(l)}catch{return l}
      e.ignorable=true; marked++;
      return JSON.stringify(e);
    });
    fs.writeFileSync(f, Buffer.concat(out.map(l=>zlib.zstdCompressSync(Buffer.from(l+'\n')))));
    files++;
  }
}
console.log('files rebuilt: '+files+', events marked ignorable: '+marked);
