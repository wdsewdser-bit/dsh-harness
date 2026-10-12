import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync,existsSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {SubagentInbox} from '../app/node_modules/@deepseek-ai/dsh-subagent-v15/lib/types/inbox.js'

const stage = fileURLToPath(new URL('..',import.meta.url))
function runFixture(mode) {
  const output = join(stage,'lab-runs','offline-family-durable-'+randomUUID())
  const result = spawnSync(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','--import',
    './tools/prepare-unified-lab-host.mjs','./tools/team-family-natural-lab.mjs',
    mode,'--output',output],{cwd:stage,env:{...process.env,DSH_LAB_CANONICAL_MODULES:'1'},
    windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:1024*1024})
  const saved = existsSync(join(output,'result.json')) ? JSON.parse(readFileSync(join(output,'result.json'))) : null
  assert.equal(result.status,0,JSON.stringify({output,error:result.error?.code,saved,stderr:result.stderr?.slice(-1800)}))
  assert.equal(saved.externalRequests,0)
  assert.equal(saved.hostDisposed,true)
  assert.equal(saved.nativeDiskReadback,true)
  assert.deepEqual(saved.cleanupErrors,[])
  return {saved,output}
}

test('actual Team follow-up waits for durable acceptance and cold resumes every child for its next identity turn',{timeout:50000},() => {
  const {saved,output} = runFixture('--offline-rounds')
  assert.equal(saved.accepted,true)
  assert.equal(saved.admission.admitted.length,8)
  const evidence = JSON.parse(readFileSync(join(output,'family-evidence.json')))
  assert.equal(evidence.rounds.length,8)
  assert.equal(evidence.durableAcceptanceChecks.length,3)
  assert.ok(evidence.durableAcceptanceChecks.every(row => row.pendingBeforeDurability && row.version === 'B'))
  for(const role of ['lead','member','verifier']) {
    const rounds = evidence.rounds.filter(row => row.sessionId === evidence.members[role].sessionId)
    assert.equal(rounds.length,2)
    assert.ok(rounds.every(row => Number.isInteger(row.answerSeq) && row.endSeq > row.answerSeq))
  }
})

test('actual Team child transport failure retains terminal evidence and closes without a late writer flush',{timeout:50000},() => {
  const {saved,output} = runFixture('--offline-error')
  assert.equal(saved.accepted,false)
  assert.equal(saved.fixtureTransportFailure,true)
  assert.equal(saved.admission.admitted.length,3)
  const evidence = JSON.parse(readFileSync(join(output,'family-evidence.json')))
  assert.equal(saved.agentErrors.length,1)
  assert.equal(saved.agentErrors[0].sessionId,evidence.members.member.sessionId)
  assert.equal(saved.agentErrors[0].message,'FAMILY_OFFLINE_TRANSPORT_ERROR')
  const terminals = JSON.parse(readFileSync(join(output,'request-terminals.json')))
  assert.equal(terminals.length,3)
  assert.equal(terminals.filter(row => row.status === 'success').length,2)
  assert.equal(terminals.find(row => row.sessionId === evidence.members.member.sessionId).status,'error')
  assert.doesNotMatch(readFileSync(join(output,'host.stderr.log'),'utf8'),/SessionHandleClosedError|fatal load failure/)
})

test('subagent inbox retains an admitted delivery until its durability barrier settles',async () => {
  const durable = Promise.withResolvers()
  const inbox = new SubagentInbox({id:'child',inbox:{nextTurn:[],nextStep:[]},steer:() => durable.promise})
  const accepted = inbox.deliver({id:'input'},'steer')
  const pending = inbox.hasPending
  durable.resolve();await accepted
  assert.equal(pending,true)
  assert.equal(inbox.hasPending,false)
})

test('subagent inbox closes admission immediately but cannot release an unsettled writer',async () => {
  const durable = Promise.withResolvers()
  const inbox = new SubagentInbox({id:'child',inbox:{nextTurn:[],nextStep:[]},followup:() => durable.promise})
  const accepted = inbox.deliver({id:'input'},'queue')
  let released = false
  const closing = inbox.close(async () => {released = true})
  await new Promise(resolve => setImmediate(resolve))
  const releasedEarly = released
  assert.throws(() => inbox.deliver({id:'late'},'queue'),{code:'ACTIVATION_CLOSING'})
  durable.resolve();await accepted;await closing
  assert.equal(releasedEarly,false)
  assert.equal(released,true)
})

test('subagent inbox returns a failed durability receipt instead of acknowledging success',async () => {
  const durable = Promise.withResolvers()
  durable.promise.catch(() => {})
  const inbox = new SubagentInbox({id:'child',inbox:{nextTurn:[],nextStep:[]},steer:() => durable.promise})
  const operation = Promise.resolve(inbox.deliver({id:'input'},'steer'))
  const observed = operation.catch(error => error)
  durable.reject(new Error('persist-failed'))
  assert.match((await observed)?.message ?? '',/persist-failed/)
  assert.equal(inbox.hasPending,false)
})

test('subagent inbox keeps synchronous release for the legacy void-returning Agent',async () => {
  const inbox = new SubagentInbox({id:'child',inbox:{nextTurn:[],nextStep:[]},steer:() => {}})
  assert.equal(inbox.deliver({id:'input'},'steer'),undefined)
  let released = false
  const closing = inbox.close(async () => {released = true})
  assert.equal(released,true)
  await closing
})
