import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const source='<path-to-dsh-upstream-0.2.2-alpha.2>/install';
const build='<path-to-dsh-c1-build-0.2.2>';
const norm=p=>path.resolve(p).toLowerCase();
if(fs.existsSync(build))throw Error('blocked: build already exists');
const links=[];let files=0;
function scan(p,anc=new Set()){const st=fs.lstatSync(p),real=fs.realpathSync(p);if(st.isSymbolicLink())links.push({path:p,real});if(fs.statSync(p).isDirectory()){if(anc.has(norm(real)))throw Error('blocked: cyclic link '+p);const next=new Set(anc).add(norm(real));for(const e of fs.readdirSync(p))scan(path.join(p,e),next);}else files++;}
scan(source);
fs.cpSync(source,build,{recursive:true,dereference:true,errorOnExist:true,force:false});
let checked=0;const hash= p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function verify(s,d){const st=fs.lstatSync(d),real=norm(fs.realpathSync(d));if(st.isSymbolicLink()||!(real===norm(build)||real.startsWith(norm(build)+path.sep)))throw Error('blocked: copy escapes '+d);if(st.isDirectory()){for(const e of fs.readdirSync(s))verify(path.join(s,e),path.join(d,e));}else{if(hash(s)!==hash(d))throw Error('copy hash mismatch '+d);checked++;}}
verify(source,build);
const report={source,build,sourceLinks:links,sourceFiles:files,verifiedFiles:checked,method:'fs.cpSync dereference:true; every destination lstat/realpath confined and sha256 compared'};
fs.writeFileSync(new URL('./copy-verification.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({sourceFiles:files,sourceLinks:links.length,verifiedFiles:checked,copySafe:true}));