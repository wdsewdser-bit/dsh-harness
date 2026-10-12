import assert from 'node:assert/strict'
import {readFile,access} from 'node:fs/promises'
import {watch} from 'node:fs'
import {resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {getHostLifecycleGate} from '@deepseek-ai/cordis'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {runProfile} from '../app/node_modules/@deepseek-ai/dsh/lib/profile-boot.js'
const stage=fileURLToPath(new URL('../',import.meta.url))
const directory=resolve(process.argv[2])
assert.ok(directory.startsWith(resolve(stage,'lab-runs')+sep))
assert.equal(process.env.DSH_LAB_CANONICAL_MODULES,'1')
assert.equal(resolve(process.env.DSH_HOME),resolve(stage,'lab-host-home'))
const overlay=resolve(directory,'storage-overlay.json')
const rows=JSON.parse(await readFile(overlay,'utf8'))
assert.deepEqual(rows.map(row=>row.id),['session-persistence-jsonl','session-query-sqlite','team-runtime-guard'])
assert.equal(resolve(rows[0].config.root),resolve(directory,'sessions'))
assert.equal(resolve(rows[1].config.path),resolve(directory,'query.sqlite'))
const {ctx}=await runProfile({environment:createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]),profile:'web',patchFiles:[overlay],args:['--no-open','--port','40124']})
let watcher,timer
try{
  await getHostLifecycleGate(ctx).observeSettlement(()=>getHostLifecycleGate(ctx).runAsync(()=>{
    ctx.on('llm/stream',()=>{throw new Error('REPLAY_PROVIDER_REFUSED')},{global:true})
    ctx.on('agent/pre-step',()=>({kind:'reject',reason:'read-only browser replay'}),{global:true})
  }))
  const ids=(await ctx.sessionController.list()).items?.map(row=>row.sessionId)
  console.log('INSTANT_UI_REPLAY_READY='+JSON.stringify({directory,ids,externalRequests:0}))
  const marker=resolve(directory,'browser-replay-closed.txt')
  await new Promise((accept,reject)=>{
    const check=()=>access(marker).then(accept,()=>{})
    watcher=watch(directory,check);watcher.on('error',reject);check()
    timer=setTimeout(()=>reject(new Error('REPLAY_BROWSER_CLOSE_TIMEOUT')),180000)
  })
}finally{
  clearTimeout(timer);watcher?.close()
  await getHostLifecycleGate(ctx).observeSettlement(()=>getHostLifecycleGate(ctx).runAsync(()=>ctx.fiber.dispose()))
}
