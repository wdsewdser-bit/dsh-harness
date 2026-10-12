const fs=require('fs'),path=require('path'),zlib=require('zlib');
const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
function decodeAll(buf){const parts=[];let i=0;while((i=buf.indexOf(MAGIC,i))!==-1){try{parts.push(zlib.zstdDecompressSync(buf.subarray(i)))}catch(e){}i+=1}return Buffer.concat(parts).toString('utf8')}
const bases=['D:/dsh-test/home/sessions','D:/dsh/home/sessions'];
const hits=[];
for(const base of bases){
  if(!fs.existsSync(base))continue;
  for(const ws of fs.readdirSync(base)){
    const wsDir=path.join(base,ws);
    let dirs; try{dirs=fs.readdirSync(wsDir)}catch{continue}
    for(const d of dirs){
      const f=path.join(wsDir,d,'session.v3.jsonl.zstd');
      if(!fs.existsSync(f))continue;
      let text; try{text=decodeAll(fs.readFileSync(f))}catch{continue}
      if(!text.includes('"team/usage"'))continue;
      const n=text.split('"team/usage"').length-1;
      hits.push({f,base:base.includes('dsh-test')?'TEST':'PROD',ws,d,n});
    }
  }
}
console.log('polluted sessions:', hits.length);
for(const h of hits) console.log('  ['+h.base+'] '+h.ws+'/'+h.d+'  team/usage x'+h.n);
fs.writeFileSync('D:/dsh-test/polluted.json', JSON.stringify(hits.map(h=>h.f), null, 1));
