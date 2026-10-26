import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs'
import {join,resolve,sep} from 'node:path'
import {prepareInstantHistoryHome,assertInstantHistoryHome} from '../tools/instant-history-fixture-home.mjs'
for(const queueSteer of [false,true])test('actual SessionController '+(queueSteer?'queued-input promotion':'direct steer')+' reconnect preserves native generation and superseded predecessor terminal',{timeout:45000},()=>{
  const root=fileURLToPath(new URL('../',import.meta.url))
  const parent=process.env.DSH_HOME??join(root,'lab-runs')
  assert.ok([join(root,'../../output'),join(root,'lab-runs')].some(base=>resolve(parent).toLowerCase()===resolve(base).toLowerCase()||resolve(parent).toLowerCase().startsWith(resolve(base).toLowerCase()+sep)))
  mkdirSync(parent,{recursive:true})
  const home=mkdtempSync(join(parent,'instant-history-'))
  prepareInstantHistoryHome(home)
  const result=spawnSync(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','--import',
    new URL('../tools/prepare-unified-lab-host.mjs',import.meta.url).href,
    fileURLToPath(new URL('../tools/instant-history-lab.mjs',import.meta.url)),'--isolated-home',...queueSteer?['--queue-steer']:[]],{
    cwd:root,env:{...process.env,DSH_LAB_CANONICAL_MODULES:'1',DSH_HOME:home},
    windowsHide:true,encoding:'utf8',timeout:35000,maxBuffer:1024*1024})
  writeFileSync(join(home,'child.stdout.log'),result.stdout??'')
  writeFileSync(join(home,'child.stderr.log'),result.stderr??'')
  assert.equal(result.status,0,(result.stderr??'').slice(-2000))
  const line=result.stdout.split('\n').find(line=>line.startsWith('INSTANT_HISTORY_EVIDENCE='))
  assert.ok(line,'actual host did not return evidence')
  const evidence=JSON.parse(line.slice('INSTANT_HISTORY_EVIDENCE='.length))
  const directory=new URL('../lab-runs/',import.meta.url)
  mkdirSync(directory,{recursive:true})
  const evidencePath=new URL('instant-api-'+evidence.sessionId+'.json',directory)
  writeFileSync(evidencePath,JSON.stringify(evidence,null,2)+'\n')
  console.log('INSTANT_HISTORY_ARTIFACT='+fileURLToPath(evidencePath))
  assert.equal(evidence.externalRequests,0);assert.equal(evidence.requests,2)
  assert.ok(evidence.workspace && !resolve(evidence.workspace).toLowerCase().startsWith(resolve(root).toLowerCase()+sep),
    'the streaming fixture must not snapshot the controller source repository')
  assert.equal(evidence.home,home);assert.equal(evidence.homeReceipt.inheritedRuntimeState,false)
  assert.equal(evidence.homeReceipt.sessionsInitiallyAbsent,true);assert.equal(evidence.homeReceipt.controlInitiallyAbsent,true)
  assert.equal(evidence.initial.activeAttempt.generation,0)
  assert.equal(evidence.updated.activeAttempt.generation,1)
  assert.equal(evidence.updated.lastAttempt.generation,0)
  assert.equal(evidence.updated.lastAttempt.superseded,true)
  assert.equal(evidence.updated.lastAttempt.outcome.eventType,'assistant/attempt')
  assert.equal(evidence.completed.lastAttempt.generation,1)
  assert.equal(evidence.completed.lastAttempt.superseded,false)
  assert.equal(evidence.committedTexts.includes('superseded-text'),false)
  assert.equal(evidence.committedTexts.includes('current-text'),true)
  assert.equal(evidence.committedTexts.filter(text=>text==='changed').length,1)
  assert.equal(evidence.pending,false)
  assert.equal(evidence.admissions.filter(row=>row.data.action==='promote').length,queueSteer?1:0)
})

test('Instant fixture rejects a prepared profile still pointing at shared mutable state',()=>{
  const parent=process.env.DSH_HOME
  assert.ok(parent)
  const home=mkdtempSync(join(parent,'instant-history-negative-'))
  prepareInstantHistoryHome(home)
  writeFileSync(join(home,'profiles/web/cordis.patch.yml'),fileURLToPath(new URL('../lab-host-home',import.meta.url)).replaceAll('\\','/'))
  assert.throws(()=>assertInstantHistoryHome(home),/INSTANT_SHARED_HOME_REFERENCE/)
})
