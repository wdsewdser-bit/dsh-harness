import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const base = 'D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins/'
const cpMod = await import(pathToFileURL(base + 'team-control-plane.mjs'))
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs'))
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs'))
const queryMod = await import(pathToFileURL(base + 'team-query-efficiency.mjs'))
const scheduler = await import(pathToFileURL(base + 'team-v12-evidence-scheduler.mjs'))
const operationMod = await import(pathToFileURL(base + 'team-message-operation.mjs'))
const digest = await import(pathToFileURL(base + 'team-activity-digest.mjs'))
const runtime = await import(pathToFileURL(base + 'team-v12-runtime.mjs'))
let checks = 0
const check = (name, fn) => { fn(); checks++; console.log('PASS ' + name) }
const dir = mkdtempSync(join(tmpdir(), 'dsh-team-efficiency-'))
const registrations = []
const received = []
const makeAgent = (name, role) => ({ name, id: name, status: 'idle', inject: (msg) => received.push({ name, msg }),
  ctx: { systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 }, tools: { register: (definition) => { registrations.push({ owner: name, definition }); return () => {} } } },
  membership: { id: 'efficiency-fixture', name, role } })
const lead = makeAgent('lead', 'lead')
const worker = makeAgent('worker', 'teammate')
const foreign = makeAgent('foreign', 'teammate')
const agents = [lead, worker, foreign]
agents.forEach((agent) => { agent.membership.root = lead })
let control
const ctx = {
  agents: { list: () => agents },
  agentTeams: { tryMembership: (agent) => agent.membership, membership: (agent) => agent.membership,
    listMembers: () => agents.map((agent) => ({ name: agent.name, role: agent.membership.role, status: agent.status, id: agent.id })),
    getTask: (_caller, taskId) => control.boardGet('global', String(taskId)),
    listTasks: () => control.boardList('global'), waitForChange: async () => ({ timedOut: true }) },
  set(key, value) { this[key] = value }, logger: { warn: () => {} }, on: () => () => {}, effect: () => () => {},
}
try {
  policyMod.apply(ctx, { controlDir: dir })
  const key = policyMod.teamKeyOf(ctx, lead)
  control = cpMod.controlPlaneFor(key, { directory: dir })
  const policy = policyMod.policyFor(key)
  policy.put({ name: 'worker', tier: 1, group: 'alpha', parent: 'lead', frozen: false })
  policy.put({ name: 'foreign', tier: 2, group: 'beta', parent: 'beta-lead', frozen: false })
  for (let i = 0; i < 12; i++) await control.boardCreate({ boardId: 'global', taskId: 't' + i, subject: 'Task ' + i, description: 'Full detail ' + i, phase: 'draft', workKind: 'discussion' })
  await control.boardCreate({ boardId: 'group-beta', taskId: 'secret', subject: 'secret', description: 'hidden', phase: 'draft', workKind: 'discussion' })
  const scopesFile = join(dir, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({ byName: { lead: ['*'] }, bySession: {} }))
  toolsMod.apply(ctx, { scopesFile, rolesDir: join(dir, 'roles'), reportDir: join(dir, 'reports'), clearanceFile: join(dir, 'clearance.json'), milestonePath: join(dir, 'milestone.json'), controlDir: dir, reconcileIntervalMs: 100000 })
  await control.flush()
  const tool = (name, agent = lead) => registrations.find((row) => row.owner === agent.name && row.definition.name === name)?.definition
  const call = (name, args, agent = lead) => tool(name, agent).execute(args, { agent, signal: undefined })
  const source = readFileSync(base + 'team-tools-v2-r10.mjs', 'utf8')
  const toolInputSource = (name) => { const start = source.indexOf("name: '" + name + "'"); return source.slice(start, source.indexOf('output:', start)) }
  check('operation schema fields belong only to send_message', () => { assert.ok(toolInputSource('send_message').includes('operation_id:')); assert.ok(toolInputSource('send_message').includes('operation_recovery:')); assert.ok(!toolInputSource('team_escalation_list').includes('operation_id:')); assert.ok(!toolInputSource('team_wake').includes('operation_id:')) })
  check('compact query schemas are exposed on the intended tools', () => { assert.ok(toolInputSource('team_task_list').includes('taskIds:')); assert.ok(toolInputSource('team_task_list').includes('changed_since:')); assert.ok(toolInputSource('team_task_get').includes('view:')); assert.ok(toolInputSource('team_task_get').includes('snapshotRevision:')) })
  const snapshot = control.snapshot()
  let builds = 0
  const q = queryMod.createTaskQuerySnapshot(snapshot, ctx.agentTeams.listMembers(), { now: 100, buildReadyQueue: (...args) => { builds++; return scheduler.buildReadyQueue(...args) } })
  snapshot.boards.global.tasks.t0.description = 'mutated copy'
  check('snapshot is isolated from live authority', () => assert.equal(control.boardGet('global', 't0').description, 'Full detail 0'))
  for (let i = 0; i < 12; i++) q.readyById.get('t' + i)
  check('one buildReadyQueue for whole query including limit=1', () => assert.equal(builds, 1))
  const full = await call('team_task_list', { limit: 100 })
  const page = await call('team_task_list', { limit: 1, snapshotRevision: full.snapshotRevision })
  check('same revision paged row equals legacy full row', () => assert.deepEqual(page.tasks[0], full.tasks[0]))
  const get = await call('team_task_get', { task_id: 't0', snapshotRevision: full.snapshotRevision })
  check('get and list agree on authoritative task values', () => { const { snapshotId, snapshotRevision, ...row } = get; assert.deepEqual(row, full.tasks[0]) })
  const compact = await call('team_task_list', { taskIds: ['t0'], view: 'compact', limit: 1 })
  check('compact IDs select exact row, no full description or completion evidence', () => { assert.equal(compact.tasks.length, 1); assert.equal(compact.tasks[0].description, ''); assert.equal(compact.tasks[0].completionEvidence, false) })
  const changed = await call('team_task_list', { changed_since: Date.now() + 100000 })
  check('changed_since timestamp strictly filters unchanged tasks', () => assert.equal(changed.tasks.length, 0))
  await assert.rejects(call('team_task_get', { task_id: 't0', snapshotRevision: 0 }), /snapshot-revision-conflict/); checks++
  await assert.rejects(call('team_task_list', { board: 'group-beta', view: 'compact' }, worker), /may not read/); checks++
  await assert.rejects(call('send_message', { target: 'foreign', message: 'bad', delivery: 'info', operation_id: 'forbidden' }, worker), /scope|message/); checks++
  check('denied read/write creates no reservation/Room', () => { assert.equal(Object.keys(control.view().messageOperations ?? {}).length, 0); assert.equal(Object.keys(control.view().rooms).length, 0) })
  const before = Object.keys(control.view().rooms).length
  await assert.rejects(call('send_message', { target: 'worker', message: 'stale', delivery: 'action', reason: 'act', task_id: 't0', based_on_revision: 99, based_on_phase: 'draft' }), /instruction-stale/); checks++
  check('stale validation precedes Room mutation', () => assert.equal(Object.keys(control.view().rooms).length, before))
  const args = { target: 'worker', message: 'progress', delivery: 'info', operation_id: 'progress-1' }
  const first = await call('send_message', args)
  const second = await call('send_message', args)
  check('duplicate operation returns same real message/dispatch receipt', () => { assert.equal(first.messageId, second.messageId); assert.equal(first.dispatchId, second.dispatchId); assert.equal(second.duplicate, true) })
  check('quiet operation injects once without wake', () => { assert.equal(received.length, 1); assert.equal(Object.keys(control.view().wakeEpisodes).length, 0) })
  await assert.rejects(call('send_message', { ...args, message: 'conflicting content' }), /message-operation-conflict.*existing receipt=/); checks++
  const third = await call('send_message', { ...args, operation_id: 'progress-2' })
  check('new event with same text is not permanently deduplicated', () => { assert.notEqual(third.messageId, first.messageId); assert.equal(received.length, 2) })
  const realDispatchCreate = control.dispatchCreate
  let dispatchFailures = 0
  control.dispatchCreate = (...values) => { if (dispatchFailures++ === 0) throw new Error('fixture dispatch creation failure'); return realDispatchCreate(...values) }
  const actualPartialArgs = { ...args, operation_id: 'actual-info-partial', message: 'partial info delivery' }
  const injectedBefore = received.length
  const actualPartial = await call('send_message', actualPartialArgs)
  const actualRecovered = await call('send_message', actualPartialArgs)
  control.dispatchCreate = realDispatchCreate
  check('real send_message retries missing dispatch but keeps confirmed notice/injection', () => { assert.equal(actualPartial.partial, true); assert.equal(actualRecovered.partial, false); assert.equal(actualRecovered.messageId, actualPartial.messageId); assert.equal(received.length, injectedBefore + 1); assert.ok(actualRecovered.dispatchId) })
  worker.steer = async (message) => received.push({ name: worker.name, msg: message })
  const actionArgs = { target: 'worker', message: 'act now', reason: 'new task ready', delivery: 'action', operation_id: 'action-event-1', task_id: 't0', based_on_revision: 1, based_on_phase: 'draft' }
  const actionFirst = await call('send_message', actionArgs)
  const actionRepeat = await call('send_message', actionArgs)
  check('action duplicate preserves real wake/dispatch episode receipt', () => { assert.equal(actionFirst.status, 'delivered'); assert.equal(actionRepeat.episodeId, actionFirst.episodeId); assert.equal(actionRepeat.dispatchId, actionFirst.dispatchId); assert.equal(actionRepeat.duplicate, true) })
  await control.wakeAcknowledge({ episodeId: actionFirst.episodeId, status: 'completed' }, worker)
  const nextAction = await call('send_message', { ...actionArgs, operation_id: 'action-event-2' })
  check('same-text action in new completed episode is allowed', () => { assert.notEqual(nextAction.episodeId, actionFirst.episodeId); assert.notEqual(nextAction.messageId, actionFirst.messageId); assert.equal(nextAction.status, 'delivered') })
  const aliasWake = await call('team_wake', { target: 'worker', message: 'legacy alias event', reason: 'alias regression' })
  check('team_wake alias executes without send_message-local identifiers', () => assert.ok(['delivered', 'coalesced'].includes(aliasWake.status)))
  const reserveArgs = { target: 'worker', message: 'reserved crash fixture', delivery: 'info', operation_id: 'reserved-crash' }
  const reserveInput = { ...operationMod.messageOperationIdentity({ operationId: reserveArgs.operation_id, sender: 'lead', target: 'worker', delivery: 'info', payload: { message: reserveArgs.message, reason: '', blockedAction: '', evidence: [], urgency: null, privilegeRequestId: null } }), receipt: { messageId: '', delivery: 'info', status: 'queued', wakeReminder: 'reserved' } }
  await control.messageOperationBegin(reserveInput, lead)
  const reserved = await call('send_message', reserveArgs)
  const reserveReceived = received.length
  const reserveRecovered = await call('send_message', { ...reserveArgs, operation_recovery: { expected_revision: reserved.operationRevision, reason: 'fixture: confirmed reservation before any effects' } })
  check('reserved-before-effect crash has explicit audited same-op recovery', () => { assert.equal(reserved.partial, true); assert.equal(reserveRecovered.partial, false); assert.equal(received.length, reserveReceived + 1); assert.ok(control.messageOperationGet(reserveInput.key).recovery.reason) })
  await assert.rejects(call('send_message', { ...reserveArgs, operation_recovery: { expected_revision: reserved.operationRevision, reason: 'stale recovery' } }), /revision-conflict/); checks++
  const noticeArgs = { ...reserveArgs, operation_id: 'notice-crash', message: 'notice crash fixture' }
  const noticeInput = { ...reserveInput, ...operationMod.messageOperationIdentity({ operationId: noticeArgs.operation_id, sender: 'lead', target: 'worker', delivery: 'info', payload: { message: noticeArgs.message, reason: '', blockedAction: '', evidence: [], urgency: null, privilegeRequestId: null } }) }
  await control.messageOperationBegin(noticeInput, lead)
  const durableNotice = await control.roomNotice({ roomId: first.roomId, author: 'lead', content: noticeArgs.message, messageOperationKey: noticeInput.key }, lead)
  await control.flush()
  const noticeCount = control.roomSnapshot(first.roomId).rooms[first.roomId].messages.length
  const noticeReserved = await call('send_message', noticeArgs)
  const noticeRecovered = await call('send_message', { ...noticeArgs, operation_recovery: { expected_revision: noticeReserved.operationRevision, reason: 'fixture: durable notice exists, dispatch missing' } })
  check('crash after Room notice resumes only missing dispatch without a second notice', () => { assert.equal(noticeRecovered.messageId, durableNotice.messageId); assert.equal(control.roomSnapshot(first.roomId).rooms[first.roomId].messages.length, noticeCount) })
  const identity = { ...operationMod.messageOperationIdentity({ operationId: 'partial', sender: 'lead', target: 'worker', delivery: 'info', payload: { message: 'partial' } }), receipt: { messageId: '', delivery: 'info', status: 'queued', wakeReminder: 'quiet' } }
  let notices = 0
  const execute = async (checkpoint, _key, prior) => { if (!prior.messageId) { notices++; await checkpoint({ messageId: 'confirmed-notice' }); throw new Error('fixture: dispatch failed after notice') } return { ...prior, dispatchId: 'confirmed-dispatch', status: 'delivered' } }
  const failed = await operationMod.runMessageOperation(control, identity, lead, execute)
  const repeated = await operationMod.runMessageOperation(control, identity, lead, execute)
  check('partial failure resumes only missing step without replaying notice', () => { assert.equal(notices, 1); assert.equal(failed.partial, true); assert.equal(repeated.messageId, 'confirmed-notice'); assert.equal(repeated.dispatchId, 'confirmed-dispatch') })
  const unknownIdentity = { ...identity, ...operationMod.messageOperationIdentity({ operationId: 'unknown-delivery', sender: 'lead', target: 'worker', delivery: 'info', payload: {} }) }
  let unknownEffects = 0
  const unknownExecute = async (checkpoint) => { unknownEffects++; await checkpoint({ messageId: 'confirmed-unknown-notice', externalAttempted: true }); throw new Error('fixture: external delivery unconfirmed') }
  await operationMod.runMessageOperation(control, unknownIdentity, lead, unknownExecute)
  const unknownRetry = await operationMod.runMessageOperation(control, unknownIdentity, lead, unknownExecute)
  check('unconfirmed external effect is returned partial without blind replay', () => { assert.equal(unknownEffects, 1); assert.equal(unknownRetry.partial, true); assert.equal(unknownRetry.duplicate, true) })
  await assert.rejects(operationMod.runMessageOperation(control, { ...unknownIdentity, recovery: { expected_revision: unknownRetry.operationRevision, reason: 'fixture unknown result must not replay' } }, lead, unknownExecute), /recovery-unconfirmed/); checks++
  const postIdentity = { ...identity, ...operationMod.messageOperationIdentity({ operationId: 'post-delivery-crash', sender: 'lead', target: 'worker', delivery: 'info', payload: {} }) }
  let postEffects = 0
  const postExecute = async (checkpoint, operationKey) => { const notice = await control.roomNotice({ roomId: first.roomId, author: 'lead', content: 'post delivery fixture', messageOperationKey: operationKey }, lead); await checkpoint({ messageId: notice.messageId, externalAttempted: true }); worker.inject({ content: [] }); postEffects++; await control.dispatchCreate({ sender: 'lead', target: 'worker', wakeup: false, status: 'completed', messageOperationKey: operationKey }, lead); throw new Error('fixture: delivered, receipt not completed') }
  const postFailed = await operationMod.runMessageOperation(control, postIdentity, lead, postExecute)
  const postRecovered = await operationMod.runMessageOperation(control, { ...postIdentity, recovery: { expected_revision: postFailed.operationRevision, reason: 'fixture: confirm matching completed dispatch receipt' } }, lead, postExecute)
  check('post-delivery crash recovers matching real receipt without redelivery', () => { assert.equal(postEffects, 1); assert.equal(postRecovered.partial, false); assert.equal(postRecovered.duplicate, true); assert.equal(postRecovered.dispatchId, postFailed.dispatchId) })
  const concurrentIdentity = { ...identity, ...operationMod.messageOperationIdentity({ operationId: 'concurrent', sender: 'lead', target: 'worker', delivery: 'info', payload: {} }) }
  let effects = 0
  const concurrent = await Promise.all([1, 2].map(() => operationMod.runMessageOperation(control, concurrentIdentity, lead, async () => { effects++; return { ...identity.receipt, messageId: 'one-effect', status: 'delivered' } })))
  check('concurrent operation has one side effect', () => assert.equal(effects, 1))
  const racingIdentity = { ...identity, ...operationMod.messageOperationIdentity({ operationId: 'review-recovery-race', sender: 'lead', target: 'worker', delivery: 'info', payload: { message: 'race' } }) }
  let releaseReview
  const gateReview = new Promise((resolve) => { releaseReview = resolve })
  let racingEffects = 0
  const firstReview = operationMod.runMessageOperation(control, racingIdentity, lead, async () => { racingEffects++; await gateReview; return { messageId: 'first-review', status: 'delivered' } })
  const secondReview = operationMod.runMessageOperation(control, { ...racingIdentity, recovery: { expected_revision: 1, reason: 'fixture concurrent recovery' } }, lead, async () => { racingEffects++; return { messageId: 'second-review', status: 'delivered' } })
  const secondOutcome = await secondReview.catch((error) => ({ error: error.message }))
  releaseReview()
  const firstOutcome = await firstReview
  check('reviewer concurrent recovery race refuses inflight and effects stay one', () => { assert.equal(racingEffects, 1); assert.match(secondOutcome.error, /inflight/); assert.equal(firstOutcome.partial, false) })
  await control.flush()
  check('operation receipts persisted to actual control snapshot', () => { const stored = JSON.parse(readFileSync(control.file, 'utf8')); assert.equal(stored.messageOperations[identity.key].receipt.messageId, 'confirmed-notice'); assert.equal(stored.messageOperations[identity.key].status, 'completed'); assert.equal(stored.messageOperations[unknownIdentity.key].status, 'partial-failed') })
  const registry = scheduler.createEvidenceRegistry([{ id: 'e1', taskId: 't0', kind: 'test', recordedAt: 10, raw: 'large secret detail' }, { id: 'e2', taskId: 'secret', kind: 'test', recordedAt: 20 }])
  const visible = runtime.filterVisibleEvidence(Object.values(registry.records), { tier: 2, mine: { name: 'worker' }, canReadTask: (row) => row.taskId === 't0' })
  const selected = scheduler.queryEvidence(scheduler.createEvidenceRegistry(visible), { taskIds: ['t0'], changed_since: 5 })
  check('evidence ACL filters before metadata projection', () => { const meta = queryMod.projectEvidenceQueryView(selected, 'metadata'); assert.equal(meta.length, 1); assert.equal(meta[0].taskId, 't0'); assert.equal(meta[0].raw, undefined); assert.equal(meta[0].completionEvidence, false) })
  check('legacy evidence full view preserves original rows', () => assert.strictEqual(queryMod.projectEvidenceQueryView(selected), selected))
  check('new evidence filters declared formed', () => assert.equal(runtime.evidenceQueryFormation({ taskIds: ['t0'], changed_since: 0 }).queryStatus, 'formed'))
  const rows = [{ name: 'lead', role: 'lead', status: 'idle' }, { name: 'worker', tier: 2, group: 'alpha', status: 'running' }]
  const factState = { boards: { global: { tasks: { t: { id: 't', revision: 1, status: 'in_progress', phase: 'execution', updatedAt: 1 } } } }, leases: {} }
  const a = digest.activityFactSignature(rows, factState, 100)
  const b = digest.activityFactSignature([{ ...rows[0], status: 'running' }, rows[1]], { ...factState, revision: 999, updatedAt: 999 }, 1000000)
  check('pure time slots/control timestamps/root digest wake do not change facts', () => assert.equal(a.factsHash, b.factsHash))
  const blocker = structuredClone(factState); blocker.boards.global.tasks.t.blockedBy = ['dependency']
  check('new blocker changes actionable fact signature', () => assert.notEqual(a.factsHash, digest.activityFactSignature(rows, blocker).factsHash))
  const done = structuredClone(factState); done.boards.global.tasks.t.status = 'completed'
  check('completion changes fact signature', () => assert.notEqual(a.factsHash, digest.activityFactSignature(rows, done).factsHash))
  const due = { ...factState, v14Waiting: { tickets: { w: { status: 'active', expiresAt: 500, responsible: 'worker' } } } }
  check('actual responsibility deadline changes once at due boundary', () => { const before = digest.activityFactSignature(rows, due, 499); const after = digest.activityFactSignature(rows, due, 501); assert.notEqual(before.factsHash, after.factsHash); assert.equal(after.dueResponsibilities, 1); assert.equal(after.factsHash, digest.activityFactSignature(rows, due, 1000).factsHash) })
  check('provider blocked suppression unchanged', () => assert.equal(digest.suppressForControlPlane({ providerState: () => ({ status: 'blocked' }) }), true))
  await control.activityDigestRecord(a)
  await control.activityDigestRecord(a)
  check('identical delivered digest does not advance episode sequence', () => assert.equal(control.view().activityDigest.sequence, 1))
  console.log('PASS checks=' + checks)
} finally {
  if (control) await control.flush()
  rmSync(dir, { recursive: true, force: true })
}
