import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendRoomMessage,
  advanceRoomCursor,
  buildRoomRecoverySnapshot,
  createWakeState,
  deliverWakeBatch,
  getWakeMessageStates,
  handleWakeBatch,
  listRoomMessagesSince,
  markWakeInjected,
  markRoomMessagesInjected,
  migrateLegacyRoomState,
  normalizeRoomWakeState,
  readRoomMessages,
  requestWake,
  roomIds,
  roomIndex,
} from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import {
  contextDigest,
  contextVersionDiff,
  createRequirementLedger,
  diffRequirements,
  recordDecision,
  recordRequirement,
  requirementSnapshot,
  supersedeRequirement,
} from '../home/profiles/web/plugins/team-v14-requirements.mjs'
import { captureMemberMemory, buildMemberRecoveryPack } from '../home/profiles/web/plugins/team-v14-memory-anchor.mjs'
import { validateCompactionAnchors } from '../home/profiles/web/plugins/team-v13-compaction-anchors.mjs'

test('Room index and migration preserve legacy messages, summaries, unresolved items and decisions', () => {
  const state = {
    version: 1,
    revision: 7,
    rooms: {
      'room-a': {
        roomId: 'room-a', revision: 12, host: 'lead', members: ['lead', 'member'], status: 'open',
        messages: [{ messageId: 'legacy-m1', author: 'lead', content: 'original', createdAt: 10, custom: 'kept' }],
        summary: 'legacy summary',
        latestSummary: { summary: 'latest round', roundId: 'round-3', summaryRevision: 3 },
        unresolved: [{ itemId: 'u1', kind: 'risk', text: 'pending risk', owner: 'lead' }],
        decisions: [{ id: 'd1', choice: 'proposal only', status: 'proposed' }],
      },
    },
    rounds: { r4: { roomId: 'room-a', roundId: 'r4', summary: 'round history', revision: 4 } },
  }
  assert.deepEqual(roomIds(state), ['room-a'])
  assert.equal(roomIndex(state)['room-a'].legacyRevision, 12)
  const first = migrateLegacyRoomState(state)
  assert.equal(first.changed, true)
  assert.equal(state.rooms['room-a'].messages[0].custom, 'kept')
  assert.equal(state.transcripts['room-a'][0].content, 'original')
  assert.equal(state.transcripts['room-a'][0].migratedFrom.revision, 12)
  assert.equal(state.roundSummaries['room-a'].length, 3)
  assert.equal(state.unresolved['room-a'].u1.sourceRevision, 12)
  assert.equal(state.decisions['room-a'].d1.status, 'proposed')
  assert.equal(buildRoomRecoverySnapshot(state, 'room-a', 'member').latestSummary.summary, 'round history')
  const second = migrateLegacyRoomState(state)
  assert.equal(second.changed, false)
  assert.equal(state.transcripts['room-a'].length, 1)
})

test('Room queries separate hot tail/history and cursor increments only through relevant messages', () => {
  const state = createWakeState()
  for (let n = 1; n <= 5; n += 1) {
    assert.equal(appendRoomMessage(state, {
      roomId: 'room', messageId: `m${n}`, author: 'lead', content: `message-${n}`,
      ...(n === 3 ? { recipients: ['other'] } : {}),
    }).ok, true)
  }
  const page = readRoomMessages(state, 'room', { hotLimit: 2, cursor: { sequence: 5 }, historyLimit: 2 })
  assert.deepEqual(page.hot.map((row) => row.messageId), ['m4', 'm5'])
  assert.deepEqual(page.historical.map((row) => row.messageId), ['m2', 'm4'])
  const visible = listRoomMessagesSince(state, 'room', 'member', { cursor: { sequence: 0 }, permissions: [] })
  assert.deepEqual(visible.messageIds, ['m1', 'm2', 'm4', 'm5'])
})

test('wake delivery, injection and handling remain distinct and each transition is idempotent', () => {
  const state = createWakeState()
  const queued = requestWake(state, {
    target: 'member', reason: 'work', dedupeKey: 'work-1',
    messages: [{ messageId: 'msg-1', originalText: 'do work' }],
  })
  const wakeId = queued.wake.wakeId
  assert.equal(deliverWakeBatch(state, wakeId, { injectionReceipt: 'receipt-1' }).status, 'delivered')
  assert.equal(getWakeMessageStates(state, wakeId).messages[0].injected, true)
  assert.equal(deliverWakeBatch(state, wakeId, { injectionReceipt: 'receipt-1' }).deduplicated, true)
  assert.equal(state.wakes[wakeId].attempts, 1)
  assert.equal(markWakeInjected(state, wakeId).status, 'delivered')
  assert.equal(getWakeMessageStates(state, wakeId).messages[0].handled, false)
  assert.equal(markWakeInjected(state, wakeId).ok, true)
  assert.equal(handleWakeBatch(state, wakeId).status, 'handled')
  assert.equal(getWakeMessageStates(state, wakeId).messages[0].status, 'handled')
})

test('legacy wake bodies are moved to inbox rows and hot tracking stays bounded', () => {
  const state = createWakeState()
  const body = 'legacy wake body\n' + 'x'.repeat(1200)
  state.wakes['wake:legacy'] = {
    wakeId: 'wake:legacy',
    target: 'member',
    messageIds: [body],
    dedupeKeys: [body],
    reasons: [body],
    status: 'queued',
    createdAt: 10,
    updatedAt: 10,
  }
  const compact = normalizeRoomWakeState(state)
  const wake = compact.wakes['wake:legacy']
  assert.equal(wake.messageIds.length, 1)
  assert.ok(wake.messageIds[0].length < 200)
  assert.equal(compact.inbox[wake.messageIds[0]].originalText, body)
  assert.ok(wake.dedupeKeys[0].length < 200)
  assert.equal(wake.reasons[0].length, 500)
})

test('requirement and decision changes produce scoped version diffs with history and stable digest', () => {
  const ledger = createRequirementLedger()
  assert.equal(recordRequirement(ledger, {
    id: 'req-1', text: 'initial acceptance', acceptance: ['test one'], taskIds: ['task-a'], changedAt: 10,
  }).ok, true)
  const before = requirementSnapshot(ledger, { taskId: 'task-a' })
  assert.equal(recordRequirement(ledger, {
    id: 'req-1', text: 'changed acceptance', acceptance: ['test two'], taskIds: ['task-a'], changedAt: 20,
  }).ok, true)
  assert.equal(ledger.requirements['req-1'].history[0].text, 'initial acceptance')
  assert.equal(recordRequirement(ledger, { id: 'req-2', text: 'other task', taskIds: ['task-b'] }).ok, true)
  assert.equal(recordDecision(ledger, { id: 'dec-1', choice: 'use B', status: 'confirmed', confirmedBy: 'lead', taskIds: ['task-a'] }).ok, true)
  const diff = diffRequirements(ledger, before.revision, { taskId: 'task-a' })
  assert.equal(diff.changed, true)
  assert.deepEqual(diff.requirements.map((row) => row.requirementId), ['req-1'])
  assert.deepEqual(diff.decisions.map((row) => row.decisionId), ['dec-1'])
  assert.equal(contextVersionDiff(before, ledger, { taskId: 'task-a' }).changed, true)
  assert.equal(contextDigest({ a: 1, b: 2 }), contextDigest({ b: 2, a: 1 }))
  assert.equal(supersedeRequirement(ledger, 'req-1', 'req-2').ok, true)
  assert.equal(ledger.requirements['req-1'].status, 'superseded')
  assert.equal(requirementSnapshot(ledger).requirements.some((row) => row.requirementId === 'req-1'), false)
})

test('requirement ledger mutations use copy-on-write snapshots', () => {
  const source = createRequirementLedger({
    revision: 3,
    requirements: {
      a: { requirementId: 'a', text: 'one', status: 'active', taskIds: ['task-a'], history: [], revision: 1 },
      b: { requirementId: 'b', text: 'two', status: 'active', taskIds: ['task-a'], history: [], revision: 1 },
    },
    events: [{ revision: 3, type: 'requirement/recorded', requirementId: 'b' }],
  })
  const before = JSON.stringify(source)
  const next = createRequirementLedger(source)

  assert.equal(recordRequirement(next, { id: 'c', text: 'three', taskIds: ['task-a'] }).ok, true)
  assert.equal(supersedeRequirement(next, 'a', 'b').ok, true)
  assert.equal(JSON.stringify(source), before)
  assert.equal(source.requirements.a.status, 'active')
  assert.equal(source.requirements.a.supersededBy, undefined)
  assert.equal(next.requirements.a.status, 'superseded')
  assert.equal(next.requirements.a.supersededBy, 'b')
  assert.equal(source.requirements.b.supersedes, undefined)
  assert.equal(next.requirements.b.supersedes, 'a')
})

test('legacy Room migration is stable across unrelated revisions and preserves access, resolved state and round facts', () => {
  const state = {
    rooms: { alpha: {
      revision: 3, host: 'lead', members: ['lead', 'member'],
      messages: [{ id: 'legacy-id', author: 'lead', content: 'private' }],
      summary: 'closed summary',
      latestSummary: { roundId: 'r1', text: 'latest text', closedAt: 20 },
      unresolved: [{ id: 'issue-1', text: 'old issue', status: 'open' }],
    } },
    rounds: { r1: { roomId: 'alpha', roundId: 'r1', summary: 'closed round', unresolved: [{ id: 'round-issue', text: 'round risk' }] } },
  }
  assert.equal(migrateLegacyRoomState(state).changed, true)
  assert.equal(state.transcripts.alpha[0].messageId, 'legacy-id')
  assert.equal(state.unresolved.alpha['issue-1'].status, 'open')
  assert.equal(state.unresolved.alpha['round-issue'].text, 'round risk')
  assert.equal(buildRoomRecoverySnapshot(state, 'alpha', 'outsider').reason, 'room-access-denied')
  assert.equal(readRoomMessages(state, 'alpha', { memberId: 'outsider' }).reason, 'room-access-denied')
  assert.equal(buildRoomRecoverySnapshot(state, 'alpha', 'member').latestSummary.summary, 'latest text')
  const count = state.roundSummaries.alpha.length
  state.rooms.alpha.revision += 1
  state.rooms.alpha.unresolved[0].status = 'resolved'
  assert.equal(migrateLegacyRoomState(state).changed, true)
  assert.equal(state.roundSummaries.alpha.length, count)
  assert.equal(state.unresolved.alpha['issue-1'].status, 'resolved')
  assert.equal(migrateLegacyRoomState(state).changed, false)
})

test('Room cursor requires an injection receipt when strict path is requested', () => {
  const state = createWakeState()
  appendRoomMessage(state, { roomId: 'room', messageId: 'm1', content: 'one', permissions: ['read'] })
  appendRoomMessage(state, { roomId: 'room', messageId: 'm2', content: 'two' })
  state.transcripts.room[0].permissions = ['read']
  assert.deepEqual(listRoomMessagesSince(state, 'room', 'member').messageIds, ['m2'])
  assert.equal(advanceRoomCursor(state, 'room', 'member', { messageIds: ['m2'], requireInjection: true }).reason, 'message-not-injected')
  assert.equal(markRoomMessagesInjected(state, 'room', 'member', { messageIds: ['m2'], receipt: 'receipt-1' }).ok, true)
  assert.equal(advanceRoomCursor(state, 'room', 'member', { messageIds: ['m2'], requireInjection: true }).ok, true)
  assert.equal(state.cursors.room.member.sequence, 2)
})

test('Room cursor accepts previously injected relevant rows across latest-first batches', () => {
  const state = createWakeState()
  for (const id of ['m1', 'm2', 'm3']) appendRoomMessage(state, { roomId: 'room', messageId: id, content: id })
  assert.equal(markRoomMessagesInjected(state, 'room', 'member', { messageIds: ['m1'], receipt: 'before-compress' }).ok, true)
  assert.equal(markRoomMessagesInjected(state, 'room', 'member', { messageIds: ['m3'], receipt: 'latest' }).ok, true)
  const refused = advanceRoomCursor(state, 'room', 'member', { messageIds: ['m3'], requireInjection: true })
  assert.equal(refused.reason, 'cursor-gap')
  assert.equal(markRoomMessagesInjected(state, 'room', 'member', { messageIds: ['m2'], receipt: 'middle' }).ok, true)
  assert.equal(advanceRoomCursor(state, 'room', 'member', { messageIds: ['m3'], requireInjection: true }).ok, true)
  assert.equal(state.cursors.room.member.sequence, 3)
  const refreshed = markRoomMessagesInjected(state, 'room', 'member', { messageIds: ['m1'], receipt: 'after-compress' })
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.updated, true)
  assert.equal(state.roomInjections.room.member.m1.firstReceipt, 'before-compress')
  assert.equal(state.roomInjections.room.member.m1.lastReceipt, 'after-compress')
  assert.equal(markRoomMessagesInjected(state, 'room', 'member', { messageIds: ['m1'], receipt: 'after-compress' }).deduplicated, true)
})

test('Room message since supports optional newest-tail max/limit bounds', () => {
  const state = createWakeState()
  for (let n = 1; n <= 5; n += 1) appendRoomMessage(state, { roomId: 'room', messageId: `m${n}`, content: `message-${n}` })
  const limited = listRoomMessagesSince(state, 'room', 'member', { max: 2 })
  assert.deepEqual(limited.messageIds, ['m4', 'm5'])
  assert.equal(limited.truncated, true)
  assert.equal(limited.hasMore, true)
  assert.deepEqual(listRoomMessagesSince(state, 'room', 'member', { limit: 1 }).messageIds, ['m5'])
  assert.deepEqual(listRoomMessagesSince(state, 'room', 'member', { max: 0 }).messageIds, [])
  assert.deepEqual(listRoomMessagesSince(state, 'room', 'member').messageIds, ['m1', 'm2', 'm3', 'm4', 'm5'])
})

test('requirements revisions stay linear and decisions require explicit confirmation', () => {
  const ledger = createRequirementLedger()
  assert.equal(recordRequirement(ledger, { id: 'r', text: 'v1' }).ok, true)
  const revision = ledger.revision
  assert.equal(recordRequirement(ledger, { id: 'r', text: 'v1' }).deduplicated, true)
  assert.equal(ledger.revision, revision)
  for (let n = 2; n <= 12; n += 1) recordRequirement(ledger, { id: 'r', text: `v${n}` })
  assert.equal(ledger.requirements.r.history.length, 11)
  assert.equal(ledger.requirements.r.history.every((row) => row.history === undefined), true)
  assert.equal(recordDecision(ledger, { id: 'd', choice: 'A', status: 'confirmed' }).reason, 'explicit-confirmation-required')
  assert.equal(recordDecision(ledger, { id: 'd', choice: 'A' }).decision.status, 'proposed')
  assert.equal(recordDecision(ledger, { id: 'd', choice: 'A', status: 'confirmed', confirmedBy: 'lead' }).decision.status, 'confirmed')
})

test('pressure memory fixture distinguishes empty, missing and loaded sources', () => {
  assert.equal(captureMemberMemory(undefined, 'member').sourceStatus, 'unavailable')
  assert.equal(captureMemberMemory({}, 'member').sourceStatus, 'unavailable')
  assert.equal(captureMemberMemory({ boards: {}, rooms: {} }, 'member').sourceStatus, 'empty')
  const control = {
    revision: 9,
    boards: { group: { tasks: { task: { id: 'task', ownerName: 'member', revision: 2, subject: 'build', status: 'in_progress', blockedBy: ['dependency'] } } } },
    v12Requirements: {
      requirements: { r1: { requirementId: 'r1', status: 'active', revision: 2, text: 'acceptance', taskIds: ['task'] } },
      decisions: { d1: { decisionId: 'd1', status: 'confirmed', choice: 'use B', taskIds: ['task'] } },
    },
    rooms: { room: { host: 'lead', members: ['lead', 'member'], summary: 'room summary', unresolved: [{ id: 'issue', text: 'pending' }] } },
    v12RoomWake: { roomAccess: { room: { members: ['lead', 'member'] } }, cursors: { room: { member: { sequence: 4 } } } },
  }
  const memory = captureMemberMemory(control, 'member', { milestoneNext: 'next stage' })
  assert.equal(memory.sourceStatus, 'loaded')
  assert.deepEqual(memory.anchors.taskContract, ['task'])
  assert.deepEqual(memory.anchors.requirements, ['r1'])
  assert.deepEqual(memory.anchors.roomDecisions, ['d1'])
  assert.deepEqual(memory.anchors.cursor, ['room:4'])
  assert.equal(memory.anchors.blockers.includes('issue'), true)
  const pack = buildMemberRecoveryPack(memory, { maxChars: 1200 })
  assert.equal(pack.text.includes('r1'), true)
  assert.equal(validateCompactionAnchors(pack.text, memory.anchors, { sourceStatus: memory.sourceStatus }).ok, true)
  assert.equal(validateCompactionAnchors('task only', memory.anchors, { sourceStatus: memory.sourceStatus }).ok, false)
  assert.equal(validateCompactionAnchors('summary', {}, { sourceStatus: 'unavailable' }).ok, false)
  assert.equal(buildMemberRecoveryPack(memory, { maxChars: 512 }).text.length <= 512, true)
})
