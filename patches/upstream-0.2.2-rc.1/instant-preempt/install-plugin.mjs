import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { C2 } from '../paths.mjs';

/** Install the candidate wrapper into the selected independent copy, never its native executor. */
export function installPlugin(build) {
 const source=fs.readFileSync(new URL('./executor.mjs',import.meta.url),'utf8');
 const dest=path.join(build,'node_modules/@deepseek-ai/dsh-tool-executor-preempt');
 fs.mkdirSync(path.join(dest,'lib'),{recursive:true});
 fs.writeFileSync(path.join(dest,'lib/index.js'),source);
 fs.writeFileSync(path.join(dest,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tool-executor-preempt',version:'0.2.2-rc.1-controlled.1',type:'module',exports:'./lib/index.js'},null,2));
 return dest;
}
if(process.argv[1] && path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()) {
 const dest=installPlugin(process.argv[2] ?? C2);
 console.log('PASS installed native wrapper: '+dest);
}
