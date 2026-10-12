import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePlan } from '../home/profiles/web/plugins/team-v15-plan-delivery.mjs'
import { currentTaskPlanRefs, readTaskPlanRef, recordPlanRead, confirmPlanReadDispatch, installPlanReadDispatchObserver, planReadBodyHash } from '../home/profiles/web/plugins/team-v15-plan-refs.mjs'
const sha = value => createHash('sha256').update(value).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plan-refs-'))
  const docs = join(root, 'docs'); mkdirSync(docs)
  const path = join(docs, 'current.md'), text = 'current product plan\nmiddle mandatory constraint\nlast constraint\n'
  writeFileSync(path, text)
  const plan = normalizePlan({ planId: 'p', planRevision: 1, ref: { path, sha256: sha(text) }, scope: ['product'],
    items: [{ requirementId: 'r', taskRefs: [{ boardId: 'global', taskId: 't' }] }] })
  const doc = { boards: { global: { tasks: { t: { id: 't', revision: 1, planId: 'p', contract: { contractRevision: 1 } } } } },
    v15PlanDelivery: { plans: { p: plan } } }
  const input = { boardId: 'global', taskId: 't', referenceIndex: 0, expectedPlanRevision: 1, expectedPlanHash: plan.planHash }
  const options = { allowedRoots: [docs], sessionId: 'session', member: 'owner', epoch: 'epoch-1' }
  return { root, docs, path, text, plan, doc, input, options }
}
const run = fn => { const f = fixture(); try { return fn(f) } finally { rmSync(f.root, { recursive: true, force: true }) } }
test('exact current registered product plan returns full text and a pending read receipt', () => run(f => {
  assert.equal(currentTaskPlanRefs(f.doc, f.input).refs[0].path, f.path)
  const result = readTaskPlanRef(f.doc, f.input, f.options)
  assert.equal(result.text, f.text)
  recordPlanRead(f.doc, result.readReceipt)
  assert.equal(f.doc.v15PlanReadReceipts[result.readReceipt.id].requiredFetch, true)
  assert.throws(() => confirmPlanReadDispatch(f.doc, result.readReceipt.id, { stage: 'prepared' }), /RECOVERY_DISPATCH_REQUIRED/)
  const confirmed = confirmPlanReadDispatch(f.doc, result.readReceipt.id, { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'request' })
  assert.equal(confirmed.requiredFetch, false)
  assert.equal(confirmed.status, 'content-fetched')
}))
test('stale plan, task mapping, changed source and oversized full read fail closed', () => run(f => {
  assert.throws(() => readTaskPlanRef(f.doc, { ...f.input, expectedPlanRevision: 0 }, f.options), /CAS_CONFLICT/)
  assert.throws(() => readTaskPlanRef(f.doc, f.input, { ...f.options, maxBytes: 1 }), /BUDGET_EXCEEDED/)
  const result = readTaskPlanRef(f.doc, f.input, f.options)
  f.doc.boards.global.tasks.t.revision++
  assert.throws(() => recordPlanRead(f.doc, result.readReceipt), /CAS_CONFLICT/)
  writeFileSync(f.path, 'wrong plan')
  assert.throws(() => readTaskPlanRef(f.doc, f.input, f.options), /HASH_MISMATCH/)
  assert.throws(() => readTaskPlanRef(f.doc, f.input, { ...f.options, allowedRoots: [] }), /PATH_DENIED/)
}))
test('physical junction escape does not inherit an allowed logical parent', () => run(f => {
  const outside = join(f.root, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'current.md'), f.text)
  const link = join(f.docs, 'link'); symlinkSync(outside, link, 'junction')
  const plan = normalizePlan({ ...f.plan, ref: { path: join(link, 'current.md'), sha256: sha(f.text) } })
  f.doc.v15PlanDelivery.plans.p = plan
  assert.throws(() => readTaskPlanRef(f.doc, { ...f.input, expectedPlanHash: plan.planHash }, f.options), /PATH_DENIED/)
}))
test('read receipts are distinct across session and compaction epoch', () => run(f => {
  const first = readTaskPlanRef(f.doc, f.input, f.options).readReceipt.id
  assert.notEqual(readTaskPlanRef(f.doc, f.input, { ...f.options, epoch: 'epoch-2' }).readReceipt.id, first)
  assert.notEqual(readTaskPlanRef(f.doc, f.input, { ...f.options, sessionId: 'other' }).readReceipt.id, first)
}))
test('dispatch observer accepts only the exact full successful tool result', async () => {
  const f = fixture()
  try {
    const result = readTaskPlanRef(f.doc, f.input, f.options), pending = new Map([['call', { receiptId: result.readReceipt.id, bodyHash: planReadBodyHash(result) }]])
    let observer, count = 0
    installPlanReadDispatchObserver({ isAgentLoopRequest: () => true, register(_id, _project, options) { observer = options; return () => {} } },
      { sessionId: 'session', pending, onDispatch: () => { count++ } })
    const receipt = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'request' }
    const tool = text => ({ role: 'tool', toolCallId: 'call', content: [{ type: 'text', text }] })
    await observer.onDispatch({ options: { messages: [tool(JSON.stringify({ ...result, text: 'truncated' }))] }, receipt })
    assert.equal(count, 0)
    await observer.onDispatch({ options: { messages: [tool(JSON.stringify(result))] }, receipt: { stage: 'prepared' } })
    assert.equal(count, 0)
    await observer.onDispatch({ options: { messages: [tool(JSON.stringify(result))] }, receipt })
    assert.equal(count, 1)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
