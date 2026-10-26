import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizePlan } from '../home/profiles/web/plugins/team-v15-plan-delivery.mjs'
import { currentTaskPlanRefs, readTaskPlanRef, recordPlanRead, confirmPlanReadDispatch, installPlanReadDispatchObserver, planReadBodyHash, createPlanReadDispatchCandidate } from '../home/profiles/web/plugins/team-v15-plan-refs.mjs'
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
test('replayed full-plan dispatch and repeated exact reads preserve the first durable confirmation', () => run(f => {
  const result = readTaskPlanRef(f.doc, f.input, f.options)
  recordPlanRead(f.doc, result.readReceipt)
  const first = confirmPlanReadDispatch(f.doc, result.readReceipt.id, { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'first-request' })
  const confirmedHash = sha(JSON.stringify(f.doc.v15PlanReadReceipts))
  const replay = confirmPlanReadDispatch(f.doc, result.readReceipt.id, { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'later-request' })
  assert.deepEqual(replay, first)
  assert.equal(sha(JSON.stringify(f.doc.v15PlanReadReceipts)), confirmedHash)
  assert.deepEqual(recordPlanRead(f.doc, readTaskPlanRef(f.doc, f.input, f.options).readReceipt), first)
  assert.equal(sha(JSON.stringify(f.doc.v15PlanReadReceipts)), confirmedHash)
  assert.throws(() => confirmPlanReadDispatch(f.doc, result.readReceipt.id, { requestId: 'not-handed', stage: 'prepared' }), /RECOVERY_DISPATCH_REQUIRED/)
  f.doc.boards.global.tasks.t.revision++
  assert.throws(() => confirmPlanReadDispatch(f.doc, result.readReceipt.id, { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'stale-task' }), /CAS_CONFLICT/)
}))
test('a confirmed prior context does not satisfy a new session or compaction epoch', () => run(f => {
  const first = readTaskPlanRef(f.doc, f.input, f.options).readReceipt
  recordPlanRead(f.doc, first)
  confirmPlanReadDispatch(f.doc, first.id, { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'first-request' })
  for (const options of [{ ...f.options, sessionId: 'new-session' }, { ...f.options, epoch: 'new-epoch' }]) {
    const next = readTaskPlanRef(f.doc, f.input, options).readReceipt
    assert.notEqual(next.id, first.id)
    recordPlanRead(f.doc, next)
    assert.equal(f.doc.v15PlanReadReceipts[next.id].status, 'read-complete-awaiting-dispatch')
    assert.equal(f.doc.v15PlanReadReceipts[next.id].requiredFetch, true)
    assert.equal(f.doc.v15PlanReadReceipts[next.id].dispatch, undefined)
  }
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
function observe(pending) {
  let project, observer
  const confirmed = []
  installPlanReadDispatchObserver({ isAgentLoopRequest: options => options.branded === true,
    register(_id, transform, options) { project = transform; observer = options; return () => {} } },
    { sessionId: 'session', pending, onDispatch: id => { confirmed.push(id) } })
  return { confirmed, async dispatch(messages, overrides = {}, receipt = { handedToAdapter: true, stage: 'handed-to-adapter', requestId: 'request' }, finalOptions) {
    const inputOptions = { sessionId: 'session', branded: true, messages, ...overrides }
    return observer.onDispatch({ options: finalOptions ?? inputOptions, inputOptions, result: project(inputOptions), receipt })
  } }
}
const toolMessage = (toolCallId, text, extra = {}) => ({ role: 'tool', toolCallId, content: [{ type: 'text', text }], ...extra })

test('plan-read candidate admits only the trusted nested execution root identity', () => {
  const result = { ok: true, text: 'exact', readReceipt: { id: 'receipt' } }
  const native = createPlanReadDispatchCandidate(result, { callId: 'call', rootCallId: 'foreign-root' })
  assert.equal(native.rootCallId, null)
  assert.equal(native.bodyHash, planReadBodyHash(result))
  assert.deepEqual(native.rootBodyHashes, [])
  const child = createPlanReadDispatchCandidate(result, { callId: 'child', rootCallId: 'root', parent: Symbol('native-parent') })
  assert.equal(child.rootCallId, 'root')
  assert.equal(child.rootBodyHashes.length, 4)
})

test('dispatch observer accepts only the exact full successful tool result', async () => {
  const f = fixture()
  try {
    const result = readTaskPlanRef(f.doc, f.input, f.options), pending = new Map([['call', { receiptId: result.readReceipt.id, bodyHash: planReadBodyHash(result) }]])
    const observer = observe(pending)
    await observer.dispatch([toolMessage('call', JSON.stringify({ ...result, text: 'truncated' }))])
    assert.equal(observer.confirmed.length, 0)
    await observer.dispatch([toolMessage('call', JSON.stringify(result))], {}, { stage: 'prepared' })
    assert.equal(observer.confirmed.length, 0)
    await observer.dispatch([toolMessage('call', JSON.stringify(result))])
    assert.deepEqual(observer.confirmed, [result.readReceipt.id])
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('PTC root dispatch accepts exact native compact or object rendering with only its fixed sandbox suffix', async () => {
  const f = fixture()
  try {
    const result = readTaskPlanRef(f.doc, f.input, f.options), compact = JSON.stringify(result), rendered = JSON.stringify(result, null, 2)
    const suffix = '\nFile sandbox enforcement is partial on this host.'
    const pending = new Map([['child', { receiptId: result.readReceipt.id, rootCallId: 'root', bodyHash: sha(compact),
      rootBodyHashes: [compact, rendered, compact + suffix, rendered + suffix].map(sha) }]])
    const observer = observe(pending)
    for (const body of [compact, rendered, compact + suffix, rendered + suffix]) await observer.dispatch([toolMessage('root', body)])
    assert.equal(observer.confirmed.length, 4)
    await observer.dispatch([toolMessage('child', compact)])
    assert.equal(observer.confirmed.length, 4, 'PTC child execution is not model-visible root delivery')
    for (const body of [JSON.stringify(result, null, 4), compact + suffix + '\n', 'log\n' + compact, JSON.stringify({ ...result, text: 'truncated' })]) {
      await observer.dispatch([toolMessage('root', body)])
    }
    await observer.dispatch([toolMessage('foreign-root', compact + suffix)])
    assert.equal(observer.confirmed.length, 4)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('plan-read dispatch rejects foreign, auxiliary, failed, multiblock, aborted and late-rewritten envelopes', async () => {
  const result = { ok: true, text: 'exact' }, body = JSON.stringify(result)
  const observer = observe(new Map([['call', { receiptId: 'receipt', bodyHash: sha(body) }]]))
  const tool = toolMessage('call', body)
  await observer.dispatch([tool], { sessionId: 'foreign' })
  await observer.dispatch([tool], { purpose: 'compaction' })
  await observer.dispatch([tool], { branded: false })
  await observer.dispatch([{ ...tool, isError: true }])
  await observer.dispatch([{ ...tool, content: [...tool.content, { type: 'image', data: 'not-a-plan' }] }])
  const abort = new AbortController(); abort.abort()
  await observer.dispatch([tool], { signal: abort.signal })
  await observer.dispatch([tool], {}, undefined, { sessionId: 'session', messages: [toolMessage('call', 'truncated')] })
  assert.deepEqual(observer.confirmed, [])
  await observer.dispatch([tool])
  assert.deepEqual(observer.confirmed, ['receipt'])
})
