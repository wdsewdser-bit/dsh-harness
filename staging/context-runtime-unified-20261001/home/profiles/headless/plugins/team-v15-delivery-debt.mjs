import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { planDeliveryHash } from './team-v15-plan-delivery.mjs'
import { completeContextBaseline, durableContextVersions } from './team-v14-context-delivery.mjs'
import { waitingTicketActive } from './team-v14-waiting.mjs'

const text = value => String(value ?? '').trim()
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
function map(value, required = false) {
  if (value === undefined && !required) return {}
  if (!object(value)) fail('DELIVERY_DEBT_STATE_INVALID')
  return value
}
function rows(value) {
  if (value === undefined) return []
  if (Array.isArray(value)) return value
  return Object.values(map(value))
}
function inside(root, path) {
  const delta = relative(root, path)
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith('../') && !delta.startsWith('..\\'))
}

/** Read the configured server source, not a caller's empty snapshot. Missing,
 * corrupt and oversized sources must not be normalized into a clean ledger. */
// The milestone file is shared by every Team of the host and is never pruned; on 2026-10-08 it passed 1MB during a
// test run, and with the first bound (1MB) that turned every read here into a refusal for every Team at once.
export function readDeliveryMilestones(path, { allowedRoots = [], maxBytes = 67108864 } = {}) {
  if (!text(path) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('DELIVERY_DEBT_SOURCE_UNAVAILABLE')
  try {
    const physicalPath = realpathSync(path)
    if (!allowedRoots.some(root => inside(realpathSync(root), physicalPath))) fail('DELIVERY_DEBT_SOURCE_DENIED')
    const before = statSync(physicalPath)
    if (!before.isFile() || before.size > maxBytes) fail('DELIVERY_DEBT_SOURCE_INVALID')
    const bytes = readFileSync(physicalPath)
    const after = statSync(physicalPath)
    if (bytes.length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || realpathSync(path) !== physicalPath) fail('DELIVERY_DEBT_SOURCE_CHANGED')
    const body = bytes.toString('utf8')
    if (!Buffer.from(body, 'utf8').equals(bytes)) fail('DELIVERY_DEBT_SOURCE_INVALID')
    const doc = JSON.parse(body)
    if (!object(doc) || doc.version !== 3 || !object(doc.teams)) fail('DELIVERY_DEBT_SOURCE_INVALID')
    return { doc, physicalPath }
  } catch (error) {
    if (text(error.code).startsWith('DELIVERY_')) throw error
    fail('DELIVERY_DEBT_SOURCE_UNAVAILABLE')
  }
}

export function readRuntimeDeliveryMilestones(path, service, options) {
  const source = readDeliveryMilestones(path, options)
  if (typeof service?.runtimeFacts !== 'function' || service.runtimeFacts.constructor?.name === 'AsyncFunction') fail('DELIVERY_MILESTONE_RUNTIME_UNAVAILABLE')
  const facts = service.runtimeFacts()
  if (!facts || facts.then || facts.loaded !== true || facts.pid !== process.pid || !text(facts.instanceId)
    || !/^[a-f\d]{64}$/i.test(facts.moduleHash ?? '') || !text(facts.configuredPath)
    || facts.physicalPath !== source.physicalPath) fail('DELIVERY_MILESTONE_RUNTIME_UNVERIFIED')
  try {
    if (realpathSync(facts.configuredPath) !== source.physicalPath) fail('DELIVERY_MILESTONE_RUNTIME_MISMATCH')
  } catch (error) {
    if (text(error.code).startsWith('DELIVERY_')) throw error
    fail('DELIVERY_MILESTONE_RUNTIME_UNAVAILABLE')
  }
  return { ...source, runtimeIdentity: structuredClone(facts) }
}

/** Snapshot pending native acceptance without importing an opt-in bridge into
 * legacy hosts. Inbox absence is unknown; journal admission is not model recall. */
export function deliveryPendingInput(agent) {
  const sessionId = text(agent?.session?.id)
  const nextStep = agent?.inbox?.nextStep, nextTurn = agent?.inbox?.nextTurn
  if (!sessionId || !Array.isArray(nextStep) || !Array.isArray(nextTurn)) fail('DELIVERY_INPUT_STATE_UNAVAILABLE')
  const events = agent.session.log ?? agent.session.snapshotEvents?.()
  if (!Array.isArray(events)) fail('DELIVERY_INPUT_STATE_UNAVAILABLE')
  const pending = new Map()
  for (const event of events) {
    if (event.type === 'native/input-accepted') {
      if (!text(event.data?.inputId) || !text(event.data?.messageId)) fail('DELIVERY_INPUT_STATE_INVALID')
      pending.set(event.data.inputId, event.data.messageId)
    } else if (event.type === 'user/message' && text(event.data?.source?.nativeInputId)) {
      const id = event.data.source.nativeInputId
      if (pending.get(id) === event.data.id) pending.delete(id)
    }
  }
  return { sessionId, nextStep: nextStep.length, nextTurn: nextTurn.length,
    pendingNativeIds: [...pending.keys()].sort() }
}

/** Pure current-plan debt projection. All inputs come from locked canonical
 * state, the configured milestone writer source, and exact live Agent objects. */
export function collectRuntimeDeliveryDebt(state, plan, { milestones, inputs, member, sessionId, now = Date.now() } = {}) {
  if (!text(state?.rootId) || !object(milestones?.doc?.teams) || !text(milestones.physicalPath)
    || !Array.isArray(inputs) || !inputs.some(row => row.member === member && row.sessionId === sessionId)) fail('DELIVERY_DEBT_UNVERIFIED')
  const wake = map(state.v12RoomWake, true), compaction = map(state.v12Compaction, true)
  const requirements = map(state.v12Requirements, true)
  if (wake.version !== 1 || compaction.version !== 1 || requirements.version !== 1) fail('DELIVERY_DEBT_STATE_INVALID')
  const refs = plan.items.flatMap(item => item.taskRefs), taskIds = new Set(), members = new Set([member])
  for (const ref of refs) {
    taskIds.add(ref.taskId); taskIds.add(ref.boardId + ':' + ref.taskId)
    const task = state.boards?.[ref.boardId]?.tasks?.[ref.taskId]
    if (task) {
      const owner = text(task.ownerName ?? task.owner ?? task.contract?.owner)
      if (owner) members.add(owner)
    }
  }
  const relevant = row => {
    const ids = row?.taskIds ?? (row?.taskId ? [row.taskId] : [])
    return !ids.length || ids.some(id => taskIds.has(text(id)))
  }
  const unresolvedDebt = new Set(), blockers = new Set(), roomFacts = {}
  const roomIds = new Set([...Object.keys(map(wake.rooms)), ...Object.keys(map(wake.roomAccess)), ...Object.keys(map(state.rooms)),
    ...Object.keys(map(wake.unresolved)), ...Object.keys(map(wake.decisions))])
  for (const id of roomIds) {
    const legacy = map(state.rooms?.[id]), access = wake.roomAccess?.[id] ?? wake.rooms?.[id] ?? legacy
    const readers = [...(access.members ?? []), access.host].filter(Boolean)
    const tied = taskIds.has(text(access.taskId)) || (access.taskIds ?? []).some(taskId => taskIds.has(text(taskId)))
    if (!tied && !readers.some(name => members.has(name))) continue
    const unresolved = rows(wake.unresolved?.[id] ?? legacy.unresolved)
    const decisions = rows(wake.decisions?.[id] ?? legacy.decisions)
    roomFacts[id] = { unresolved, decisions }
    for (const [index, row] of unresolved.entries()) {
      if (!row?.status || row.status === 'open') blockers.add('room-unresolved:' + id + ':' + text(row.itemId ?? row.id ?? index))
      else if (!['resolved', 'cancelled'].includes(row.status)) fail('DELIVERY_DEBT_STATE_INVALID')
    }
    for (const row of decisions) {
      if (['superseded', 'revoked'].includes(row.status)) continue
      if (!['confirmed', 'proposed'].includes(row.status)) fail('DELIVERY_DEBT_STATE_INVALID')
      const confirmed = new Set((row.confirmations ?? []).map(entry => entry.member))
      const missing = (row.requiredConfirmations ?? []).filter(name => !confirmed.has(name))
      if (row.status !== 'confirmed' || missing.length) unresolvedDebt.add('decision-confirmation:' + id + ':' + text(row.decisionId ?? row.id))
    }
  }
  const deliveryRows = {}
  for (const field of ['inbox', 'wakes']) {
    deliveryRows[field] = Object.fromEntries(Object.entries(map(wake[field])).filter(([, row]) => members.has(row.target) && relevant(row)))
    for (const [id, row] of Object.entries(deliveryRows[field])) {
      if (!['handled', 'deduplicated', 'rejected'].includes(row.status)) unresolvedDebt.add(field + ':' + id)
    }
  }
  const waiting = rows(map(state.v14Waiting).tickets).filter(row => relevant(row) && (row.taskId || members.has(row.owner)))
  for (const row of waiting) if ((row.status ?? 'open') === 'open' && waitingTicketActive(row, state, now)) blockers.add('waiting:' + text(row.ticketId))
  const jobs = Object.fromEntries(Object.entries(map(compaction.jobs, true)).filter(([, row]) => relevant(row) && (row.taskId || members.has(row.owner))))
  for (const [id, row] of Object.entries(jobs)) if (!['completed'].includes(row.status)) unresolvedDebt.add('compaction-job:' + id)
  const teamMilestones = map(milestones.doc.teams[state.rootId])
  const milestoneRows = Object.fromEntries(Object.entries(map(teamMilestones.compactions)).filter(([name]) => members.has(name)))
  for (const [name, row] of Object.entries(milestoneRows)) {
    if (row.memoryDebt != null || row.status === 'completed_with_debt') unresolvedDebt.add('compaction-memory:' + name)
    else if (!['compacted', 'no_compactable_range'].includes(row.status)) unresolvedDebt.add('compaction-pending:' + name)
  }
  const inputFacts = inputs.filter(row => members.has(row.member))
  for (const name of members) if (!inputFacts.some(row => row.member === name)) unresolvedDebt.add('input-state-unavailable:' + name)
  for (const row of inputFacts) if (row.nextStep || row.nextTurn || row.pendingNativeIds.length) unresolvedDebt.add('pending-input:' + row.member + ':' + row.sessionId)
  const contextFacts = {}
  for (const input of inputFacts) {
    const receipts = [...rows(state.v14DeliveryReceipts), ...rows(wake.contextReceipts)]
      .filter(row => row.member === input.member && row.sessionId === input.sessionId)
    const cursors = rows(wake.contextCursors).filter(row => row.member === input.member && row.sessionId === input.sessionId)
    const epoch = wake.contextEpochs?.[input.sessionId]
    const validDispatch = row => row.dispatch?.handedToAdapter === true && row.dispatch.stage === 'handed-to-adapter' && text(row.dispatch.requestId)
    const currentReceipts = epoch?.compactionId ? receipts.filter(row => row.baselineId === epoch.compactionId) : receipts
    if (epoch?.compactionId && !currentReceipts.some(row => row.baselineComplete === true && completeContextBaseline(row) && validDispatch(row))
      && !cursors.some(row => row.baselineId === epoch.compactionId && completeContextBaseline(row.baselineProof))) {
      unresolvedDebt.add('context-baseline:' + input.member + ':' + epoch.compactionId)
    }
    // v3 cursors inherit older hashes; they cannot certify a new window's body.
    const known = durableContextVersions([...currentReceipts, ...(epoch?.compactionId ? [] : cursors)], { member: input.member, sessionId: input.sessionId })
    const debt = [...receipts.flatMap(row => row.debt ?? []), ...cursors.flatMap(row => Object.entries(map(row.noticeVersions)).map(([id, hash]) => ({ id, hash })))]
    for (const row of debt) if (known.get(row.id) !== row.hash) unresolvedDebt.add('context-fetch:' + input.member + ':' + row.id + ':' + row.hash)
    contextFacts[input.sessionId] = { epoch: epoch ?? null, debt, known: [...known.entries()].sort() }
  }
  const ledgerFacts = { requirements: rows(requirements.requirements).filter(relevant), decisions: rows(requirements.decisions).filter(relevant) }
  const reads = rows(state.v15PlanReadReceipts).filter(row => row.planId === plan.planId && row.planRevision === plan.planRevision)
  for (const row of reads) if (row.requiredFetch === true) unresolvedDebt.add('plan-read:' + row.id)
  return { unresolvedDebt: [...unresolvedDebt].sort(), blockers: [...blockers].sort(),
    authorityDebtSnapshot: { version: 1, rootId: state.rootId, planId: plan.planId, planRevision: plan.planRevision,
      milestonePath: milestones.physicalPath, sourceHash: planDeliveryHash({ roomFacts, deliveryRows, waiting, jobs,
        milestoneRows, milestoneRuntime: milestones.runtimeIdentity ?? null, ledgerFacts, inputFacts, contextFacts, reads }), verificationScope: 'canonical-state-and-input-admission-not-model-understanding' } }
}
