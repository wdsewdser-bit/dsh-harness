import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {verifyWindowRecallProbe} from '../tools/unified-natural-lab.mjs'
const directory=new URL('../lab-runs/natural-window-native-20261003-2216/',import.meta.url)
const sha=text=>createHash('sha256').update(text).digest('hex')
const read=name=>JSON.parse(readFileSync(new URL(name,directory),'utf8'))
function evidence() {
  const rawJournal=readFileSync(new URL('canonical-journal.json',directory),'utf8')
  const rawEvents=readFileSync(new URL('runtime-events.jsonl',directory),'utf8')
  assert.equal(sha(rawJournal),'b163000487158633d076450a1fc216cb500760396ed10afe2756e29999a356c3')
  assert.equal(sha(rawEvents),'d89dede49fa5c8b1a368a14c0ed6791809db77e3c7d860504fdf8ec60f189e1b')
  return {journal:JSON.parse(rawJournal),events:rawEvents.trim().split('\n').map(JSON.parse),
    target:read('history-quality-target.json'),projected:read('window-project-evidence.json'),
    options:{qualityOracle:true,nativeEvidence:read('native-window-evidence.json'),collector:read('window-shadow-evidence.json'),historyLedger:read('history-quality-ledger.json')}}
}
const verify=e=>verifyWindowRecallProbe(e.journal,e.events,e.target,e.projected,e.options)

test('actual six-request W2 case independently binds durable journal, current authority and exact history delivery',()=> {
  const result=verify(evidence())
  assert.equal(result.accepted,true)
  assert.equal(result.completedTurnCount,3)
  assert.equal(result.nativeSurfaceVerified,true)
  assert.equal(result.initialRequestProjected,false)
  assert.equal(result.canonicalPageDeliveryClaimed,false)
})

test('W2 natural verifier rejects forged durability, originals, surface, current authority and SDK parent receipt',()=> {
  const mutations=[
    e=>{e.options.nativeEvidence.receipt.durable=false},
    e=>{e.options.nativeEvidence.durableFinalJournal.pop()},
    e=>{e.options.nativeEvidence.beforeJournal[0].type='forged'},
    e=>{e.options.nativeEvidence.retention.receipts[0].eventRefs[0].sha256='forged'},
    e=>{e.options.nativeEvidence.afterSurface.push(e.options.nativeEvidence.beforeSurface.find(row=>row.toolCallId===e.target.data.message.toolCallId))},
    e=>{e.options.nativeEvidence.authorityReceipts[0].handedToAdapter=false},
    e=>{e.options.nativeEvidence.authorityReceipts[0].body.authoritative=false},
    e=>{e.options.nativeEvidence.currentRevision=0},
    e=>{e.options.nativeEvidence.protocolTrial.nativeSurface=false},
    e=>{Object.values(e.options.historyLedger.returnedArtifacts)[0].rootCallId='foreign'},
    e=>{e.events.push({event:'protocol-replay-degraded'})},
    e=>{e.journal.findLast(row=>row.type==='assistant/message').data.message.content=[{type:'text',text:'{"remaining":0,"completionAllowed":true,"pendingInputPolicy":"discard"}'}]},
  ]
  for(const mutate of mutations){const data=evidence();mutate(data);assert.equal(verify(data).accepted,false)}
})
