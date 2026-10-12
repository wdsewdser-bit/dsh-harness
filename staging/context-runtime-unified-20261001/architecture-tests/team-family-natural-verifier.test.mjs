import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {verifyFamily} from '../tools/team-family-natural-lab.mjs'

const directory = new URL('../lab-runs/natural-team-family-20261005-0654/',import.meta.url)
const hashes = {
  'family-journals.json':'9c5ac61b25c4fc0be840bd5370043565f194bb3312d7b76beeb8ffe14fcf2ed0',
  'request-evidence.json':'381098c76b943f58be760e0f102ba5343eabd8cbb777ffe5707af8f1532ef629',
  'request-terminals.json':'759f4ebf12c0a11652d5e73a46812e63a8b189c46a6bf83cc23130715bab75a9',
  'family-evidence.json':'555f735aab1524b83f04585a2883d2dec1e648c122e8dafe7394e1c8c2d8bb57',
}
function fixture() {
  const data = Object.entries(hashes).map(([name,expected]) => {
    const raw = readFileSync(new URL(name,directory))
    assert.equal(createHash('sha256').update(raw).digest('hex'),expected)
    return JSON.parse(raw)
  })
  return {journals:data[0],requests:data[1],terminals:data[2],evidence:data[3]}
}
const verify = data => verifyFamily(data.journals,data.requests,data.terminals,data.evidence)
const firstAnswer = data => data.journals[data.evidence.rounds[0].sessionId].events[data.evidence.rounds[0].answerSeq]
const lastAnswer = data => data.journals[data.evidence.rounds.at(-1).sessionId].events[data.evidence.rounds.at(-1).answerSeq]

test('original eight real requests bind four native journals and root-plus-three-descendant usage',() => {
  const result = verify(fixture())
  assert.equal(result.accepted,true)
  assert.equal(result.providerAccepted,true)
  assert.equal(result.usage.activity.requests,8)
  assert.equal(result.usage.usage.tokens.totalTokens.value,236649)
  assert.equal(result.usage.usage.tokens.cacheWriteTokens.value,null)
})

for(const [name,mutate] of Object.entries({
  'missing descendant':d => {delete d.journals[d.evidence.members.member.sessionId]},
  'foreign physical parent':d => {d.journals[d.evidence.members.member.sessionId].header.parentSession='foreign'},
  'wrong logical role':d => {d.evidence.members.member.tier=0},
  'request payload changed':d => {d.requests[0].system+='unrecorded'},
  'duplicate request identity':d => {d.requests[1].requestId=d.requests[0].requestId},
  'native prefix removed':d => {d.journals[d.evidence.members.root.sessionId].events.shift()},
  'answer outside observed round':d => {const r=d.evidence.rounds[0];r.beforeEventCount=r.endSeq+1;
    r.beforeHash=createHash('sha256').update(JSON.stringify(d.journals[r.sessionId].events.slice(0,r.beforeEventCount))).digest('hex')},
  'false completion':d => {firstAnswer(d).data.message.content=[{type:'text',text:'{"roleFile":"root.md","tier":0,"identityProbe":"family-A-root","completionAllowed":true}'}]},
  'wrong active epoch':d => {d.evidence.activationB.epoch=d.evidence.activationA.epoch},
  'wrong identity bundle hash':d => {d.evidence.activationB.contentHash='0'.repeat(64)},
  'foreign provider terminal':d => {d.terminals[0].provider='foreign'},
  'not handed to actual adapter':d => {d.terminals[0].requestProjection.stage='prepared'},
  'invented usage':d => {d.terminals[0].usage.inputTokens++},
  'non-final usage':d => {d.terminals[0].usageFinal=false},
  'missing native provider replay':d => {lastAnswer(d).data.stream=lastAnswer(d).data.stream.filter(row => row.chunk?.type!=='finish')},
})) test('family verifier rejects '+name,() => {
  const data = fixture();mutate(data)
  assert.equal(verify(data).accepted,false)
})
