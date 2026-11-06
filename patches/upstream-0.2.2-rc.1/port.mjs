import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const scripts=fileURLToPath(new URL('./',import.meta.url));
// Match the VERIFIED legacy build matrix, not the historical C1/C2 patch labels.
for(const file of ['instant-preempt/prepare.mjs','team-layout/discover.mjs','team-layout/apply.mjs','goal-veto/discover.mjs','goal-veto/apply.mjs','prepare-c2.mjs','instant-preempt/discover.mjs','instant-preempt/apply.mjs','instant-preempt/install-plugin.mjs','audit.mjs','verify-patches.mjs']){
 const r=spawnSync(process.execPath,[scripts+file],{stdio:'inherit'});if(r.status!==0)throw Error(file+':exit '+r.status);
}
console.log('PASS fresh builds complete; next: node '+scripts+'run.mjs');
