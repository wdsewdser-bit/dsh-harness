import fs from 'node:fs'; import crypto from 'node:crypto';
const root=new URL('./',import.meta.url),build=(process.argv[2] ?? '<path-to-dsh-c1-build-0.2.2>')+'/node_modules/@deepseek-ai/';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const plan=JSON.parse(fs.readFileSync(new URL('plan.json',root),'utf8')), outputs=new Map(),report=[];
for(const file of new Set(plan.map(r=>r.file))){
 const source=fs.readFileSync(new URL('original/'+file,root),'utf8');
 if(fs.readFileSync(build+file,'utf8')!==source)throw Error('PREIMAGE_MISMATCH:'+file);
 let text=source;for(const r of plan.filter(r=>r.file===file)){if(text.split(r.from).length!==2)throw Error('ANCHOR_DRIFT:'+file);text=text.replace(r.from,r.to);}
 outputs.set(file,text);report.push({file,before:hash(source),after:hash(text)});
}
for(const [file,text] of outputs)fs.writeFileSync(build+file,text);
fs.writeFileSync(new URL('hashes-and-scope.json',root),JSON.stringify(report,null,2));console.log('PASS team-layout: '+plan.length+' exact edits in '+outputs.size+' files');