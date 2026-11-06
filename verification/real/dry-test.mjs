import fs from 'node:fs';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import path from 'node:path';import {stages
  } from './config.mjs';const root=process.argv[2];assert(root&&!fs.existsSync(root));fs.mkdirSync(root,{recursive:true});const ledger=process.env
.DSH_BUDGET_LEDGER??'runs/real-budget.json',before=fs.existsSync(ledger)?fs.readFileSync(ledger):null,reports=[];for(const stage of Object.keys(stages)){
  const run=root+'/'+stage;const env={...process.env};delete env.CLOSEOUT_PROVIDER_KEY;const x=spawnSync(process.execPath,['verification/real/run.mjs',stage,
      '--root',path.resolve(run),'--authorize-provider','--dry-run'],{env,encoding:'utf8',timeout:60000});assert.equal(x.status,0,x.stdout);const r=JSON.parse(
      fs
    .readFileSync(run+'/report.json'));assert.equal(r.providerRequests,0);assert(r.boundaryReached&&r.cleanup&&r.ports.every(p=>p.closed));assert.equal(
      r.status,
    'dry-run-passed');reports.push({stage,status:r.status,providerRequests:r.providerRequests,boundaryReached:r.boundaryReached,cleanup:r.cleanup});
      }assert.deepEqual(fs.existsSync(ledger)?fs.readFileSync(ledger):null,before);fs.writeFileSync(root+'/summary.json',JSON.stringify({reports,
        ledgerUnchanged:true,
      providerKeyPresent:false},null,2));console.log(JSON.stringify(reports));
