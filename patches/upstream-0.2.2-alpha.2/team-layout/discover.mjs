import fs from 'node:fs';import crypto from 'node:crypto';
const root=new URL('./',import.meta.url),source='<path-to-dsh-upstream-0.2.2-alpha.2>/install/node_modules/@deepseek-ai/';
const plan=JSON.parse(fs.readFileSync(new URL('plan.json',root),'utf8'));const hashes={};
for(const file of new Set(plan.map(r=>r.file))){const dest=new URL('original/'+file,root);fs.mkdirSync(new URL('./',dest),{recursive:true});fs.copyFileSync(source+file,dest);hashes[file]=crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');}
fs.writeFileSync(new URL('anchors.json',root),JSON.stringify(hashes,null,2));console.log('PASS discovery: '+Object.keys(hashes).length+' original byte snapshots');
