/** Remove the custom team/usage event from session journals it was written into. */
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function frames(buf){const out=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){out.push(i);i+=1}return out}
function decodeFrame(slice){return zlib.zstdDecompressSync(slice).toString('utf8')}
const targets=JSON.parse(fs.readFileSync('D:/dsh-test/polluted.json','utf8'));
let touched=0, removed=0;
for(const f of targets){
  const buf=fs.readFileSync(f);
  const starts=frames(buf);
  const rebuilt=[];
  for(let i=0;i<starts.length;i++){
    const start=starts[i];
    const end=i+1<starts.length?starts[i+1]:buf.length;
    let text;
    try{ text=decodeFrame(buf.subarray(start,end)) }catch{ continue }
    const kept=[];
    let localRemoved=0;
    for(const line of text.split('\n')){
      if(line.length===0) continue;
      if(line.includes('"team/usage"')){ localRemoved++; continue }
      kept.push(line);
    }
    if(localRemoved===0){ rebuilt.push(buf.subarray(start,end)); continue }
    removed+=localRemoved;
    if(kept.length===0) continue;
    rebuilt.push(zlib.zstdCompressSync(Buffer.from(kept.join('\n')+'\n')))
  }
  if(rebuilt.length===0){ console.log('SKIP (nothing left) '+f); continue }
  const backup=f+'.pre-teamusage.bak';
  if(!fs.existsSync(backup)) fs.copyFileSync(f,backup);
  fs.writeFileSync(f,Buffer.concat(rebuilt));
  touched++;
}
console.log('files cleaned: '+touched+', events removed: '+removed);
