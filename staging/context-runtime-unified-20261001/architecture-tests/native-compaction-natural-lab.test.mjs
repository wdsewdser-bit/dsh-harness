import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {compactionLimits,createCompactionAdmission,verifyCompactionAnswer,verifyCompactionSummary,verifyCompactionNatural,decodeHistoryArtifact,
  contextLimits,contextFillerTargetChars,generateContextFiller,fillerDeclaration,FILLER_MESSAGE_CHARS}
  from '../tools/native-compaction-natural-lab.mjs'

const request = () => ({sessionId:'root',provider:'opencodego',model:'deepseek-v4.1-flash',maxTokens:4096,messages:[]})
test('new native-compaction admission is independently bounded and denies bootstrap/foreign/oversized requests',() => {
  assert.equal(compactionLimits.maxRequests,12)
  const fresh = () => createCompactionAdmission('root')
  assert.throws(() => createCompactionAdmission('root',false).admit(request()),{code:'LAB_BOOTSTRAP_NO_SAMPLING'})
  for (const [field,value,code] of [['sessionId','foreign','LAB_FOREIGN_SESSION'],['provider','other','LAB_FOREIGN_ROUTE'],
    ['model','other','LAB_FOREIGN_ROUTE'],['maxTokens',8192,'LAB_OUTPUT_LIMIT'],['messages',[{content:'x'.repeat(262145)}],'LAB_PAYLOAD_LIMIT']]) {
    assert.throws(() => fresh().admit({...request(),[field]:value}),{code})
  }
  const guard = fresh()
  for (let i=0;i<12;i++) guard.admit(request())
  assert.throws(() => guard.admit(request()),{code:'LAB_REQUEST_LIMIT'})
  assert.equal(guard.tool({agent:{id:'root',session:{id:'root'}},name:'exec_command',arguments:{cmd:'anything'}}).kind,'deny')
})
test('summary oracle requires all official sections and exact full plan identity',() => {
  const sections = ['Primary Request and Intent','Key Technical Concepts','Files and Code','Errors and Fixes',
    'Pending Jobs','Current Work','Next Step','Critical Context']
  const plan = {path:'D:/fixture/full-plan.json',sha256:'a'.repeat(64)}
  const body = sections.map(title => '## '+title+'\n- '+plan.path+' '+plan.sha256+' active-production').join('\n')
  assert.equal(verifyCompactionSummary(body,plan),true)
  assert.equal(verifyCompactionSummary(body.replace('## Pending Jobs','## Done'),plan),false)
  assert.equal(verifyCompactionSummary(body,{...plan,sha256:'b'.repeat(64)}),false)
})
test('quality oracle refuses false completion, lost input and stale scope without supplying model answers',() => {
  const value = {remaining:4,completionAllowed:false,pendingInputPolicy:'preserve',writeScope:'read-only'}
  assert.equal(verifyCompactionAnswer(JSON.stringify(value),'read-only'),true)
  assert.equal(verifyCompactionAnswer('```json\n'+JSON.stringify(value)+'\n```','read-only'),true)
  assert.equal(verifyCompactionAnswer('not recovered\n```json\n'+JSON.stringify(value)+'\n```','read-only'),false)
  for (const change of [{remaining:0},{completionAllowed:true},{pendingInputPolicy:'discard'},
    {writeScope:'staging-only'},{extra:true}]) assert.equal(verifyCompactionAnswer(JSON.stringify({...value,...change}),'read-only'),false)
  assert.equal(verifyCompactionNatural([],[],{}).accepted,false)
})

test('partial recovery keeps the original request budget and locator observation gate',() => {
  const guard = createCompactionAdmission('root',true,9)
  for (let i=0;i<3;i++) guard.admit(request())
  assert.throws(() => guard.admit(request()),{code:'LAB_REQUEST_LIMIT'})
  assert.throws(() => createCompactionAdmission('root',true,13),{code:'LAB_INITIAL_REQUESTS_INVALID'})
  const g = createCompactionAdmission('root')
  g.bindTarget(18)
  const actor = {id:'root',session:{id:'root'}}, locator = 'history-own'
  const locate = {agent:actor,name:'history_recall',arguments:{action:'locate',seq:18}}
  const read = {agent:actor,name:'history_recall',arguments:{action:'read',locator,
    expectedRevision:18,expectedSourceHash:'a'.repeat(64),offset:0}}
  assert.equal(g.tool(read).kind,'deny')
  assert.equal(g.tool(locate).kind,'allow')
  g.observe(locate,{isError:false,content:[{type:'text',text:JSON.stringify({ok:true,descriptor:{locator,
    readerSessionId:'root',sourceRef:{sessionId:'root',seq:18,sourceRevision:18,
      sourceHash:'a'.repeat(64),artifactHash:'b'.repeat(64)},pairingComplete:true,
    bytes:1000,pageBytes:1024,pages:1}})}]})
  assert.equal(g.tool(read).kind,'allow')
  assert.equal(g.tool({...read,arguments:{...read.arguments,expectedSourceHash:'c'.repeat(64)}}).kind,'deny')
})

test('artifact decoder accepts only the exact native sandbox annotation, never arbitrary trailing text',() => {
  const message = text => ({content:[{type:'text',text}]})
  assert.deepEqual(decodeHistoryArtifact(message('{"ok":true}\nFile sandbox enforcement is partial on this host.')),{ok:true})
  assert.throws(() => decodeHistoryArtifact(message('{"ok":true}\nUNTRUSTED OTHER NOTE')))
  assert.throws(() => decodeHistoryArtifact(message('{"ok":true}\nFile sandbox enforcement is complete on this host.')))
})

test('actual three-summary/recovery canonical fixture is accepted; source, parent, tail, completion and dispatch tampering are rejected',() => {
  const directory = new URL('../lab-runs/natural-native-compaction-recovery-20261004-0953/',import.meta.url)
  const load = (name,expected) => {
    const raw = readFileSync(new URL(name,directory))
    if (expected) assert.equal(createHash('sha256').update(raw).digest('hex'),expected)
    return JSON.parse(raw)
  }
  const journal = load('canonical-journal.json','4a208d236f811d5d346811cdf1a7e2fbf4a5542bbbb9b335de84e9585f2b74cc')
  const requests = load('request-evidence.json','21c0865644b310558551ff497d3b00c1248440523c027df7397a1590852861c6')
  const evidence = load('compaction-evidence.json','0690f32ca9169b89c0e603664770462eadda81ecdcb2af038ac28ea3a6624f26')
  evidence.sessionId = load('result.json').sessionId
  assert.equal(verifyCompactionNatural(journal,requests,evidence).accepted,true)
  const negative = change => {
    const j = structuredClone(journal), r = structuredClone(requests), e = structuredClone(evidence)
    change(j,r,e); assert.equal(verifyCompactionNatural(j,r,e).accepted,false)
  }
  negative(j => {j[18].data.message.content[0].text += ' altered'})
  negative(j => {j[27].data.summary[0].text = 'incomplete summary'})
  negative(j => {j[100].seq = 99})
  negative(j => {j[121].data.message.content = [{type:'text',text:'{"remaining":0,"completionAllowed":true,"pendingInputPolicy":"preserve","writeScope":"read-only"}'}]})
  negative(j => {j[114].data.parentCallId = 'foreign-parent'})
  negative(j => {j[116].data.parentCallId = 'foreign-parent'})
  negative((j,r) => {r.pop()})
  negative((j,r) => {r.at(-1).messages = []})
  negative((j,r,e) => {e.sessionId = 'foreign-root'})
  negative((j,r,e) => {e.rounds[2].afterSurface = []})
  negative((j,r,e) => {e.recoveryRetry.beforeJournalHash = '0'.repeat(64)})
})

test('large-context filler is deterministic, diverse, declared and sized to about the requested token count',() => {
  const first = generateContextFiller(300000), again = generateContextFiller(300000), other = generateContextFiller(300001)
  assert.deepEqual(first.messages,again.messages)
  assert.equal(first.chars,again.chars)
  assert.notDeepEqual(first.messages,other.messages)
  for (const tokens of [50000,300000,800000]) {
    const value = generateContextFiller(tokens), target = contextFillerTargetChars(tokens)
    assert.ok(Math.abs(value.chars - target) / target <= 0.05, `${tokens} produced ${value.chars} vs target ${target}`)
    assert.ok(value.messages.length > 1)
    assert.ok(value.messages.every(text => text.startsWith(fillerDeclaration + '\n')))
    assert.ok(value.messages.every(text => text.length <= FILLER_MESSAGE_CHARS + fillerDeclaration.length + 1))
  }
})

test('size-dependent caps scale with N while the no-argument limits stay byte-for-byte the original ones',() => {
  assert.equal(contextLimits(undefined), compactionLimits)
  assert.deepEqual(contextLimits(undefined), {maxRequests:12,maxOutputTokens:4096,maxPayloadBytes:262144,maxWallMs:180000,maxProcessMs:215000})
  const scaled = contextLimits(500000)
  assert.ok(scaled.maxPayloadBytes >= 500000 * 6)
  assert.ok(scaled.maxWallMs >= 900000)
  assert.ok(scaled.maxProcessMs > scaled.maxWallMs)
  assert.equal(scaled.maxOutputTokens,compactionLimits.maxOutputTokens)
  assert.equal(scaled.maxRequests,compactionLimits.maxRequests)
  createCompactionAdmission('root',true,0,contextLimits(300000)).admit({...request(),messages:[{content:'x'.repeat(300000)}]})
  assert.throws(() => createCompactionAdmission('root').admit({...request(),messages:[{content:'x'.repeat(300000)}]}),{code:'LAB_PAYLOAD_LIMIT'})
  for (const invalid of [40000,900000,1.5,NaN]) assert.throws(() => contextLimits(invalid),{code:'LAB_CONTEXT_TOKENS_INVALID'})
})
