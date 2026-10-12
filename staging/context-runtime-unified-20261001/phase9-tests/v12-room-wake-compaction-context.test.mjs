import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceRoomCursor,
  appendRoomMessage,
  closeRoomRound,
  confirmDecision,
  createRoomLedger,
  createWakeState,
  deliverWakeBatch,
  effectiveDecisions,
  enqueueInboxMessage,
  evaluateStopEpisode,
  handleWakeBatch,
  listRoomMessagesSince,
  proposeDecision,
  pendingDecisionConfirmations,
  rejectWake,
  replaceDecision,
  requestWake,
  resolveUnresolved,
  retryWake,
  revokeDecision,
} from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import {
  COMPACTION_RECOVERY_FIRST_ACTION,
  buildCompactionResumeContext,
  bypassHandoffForPressure,
  completeCompaction,
  createCompactionState,
  doneMilestone,
  failCompaction,
  markHandoffReady,
  retryCompaction,
  setMilestone,
  startCompaction,
  waitForHandoff,
} from '../home/profiles/web/plugins/team-v12-compaction.mjs'
import {
  buildContextPack,
  contentHash,
  estimateTokens,
} from '../home/profiles/web/plugins/team-v12-context.mjs'

test('D: transcript cursor is incremental, gap-safe and idempotent', () => {
  const doc = createRoomLedger()
  for (const message of [
    { messageId: 'm1', roomId: 'room-1', author: 'lead', content: 'one' },
    { messageId: 'm2', roomId: 'room-1', author: 'peer', content: 'two', recipients: ['member-1'] },
    { messageId: 'm3', roomId: 'room-1', author: 'lead', content: 'three', recipients: ['member-1'] },
  ]) {
    assert.equal(appendRoomMessage(doc, message).ok, true)
  }
  assert.equal(appendRoomMessage(doc, {
    messageId: 'm2',
    roomId: 'room-1',
    author: 'peer',
    content: 'two',
  }).deduplicated, true)
  assert.equal(appendRoomMessage(doc, { messageId: 'm2', roomId: 'room-1' }).deduplicated, true)
  assert.equal(doc.transcripts['room-1'].length, 3)

  const initial = listRoomMessagesSince(doc, 'room-1', 'member-1')
  assert.deepEqual(initial.messages.map((message) => message.messageId), ['m1', 'm2', 'm3'])

  const gap = advanceRoomCursor(doc, 'room-1', 'member-1', { messageId: 'm2' })
  assert.equal(gap.ok, false)
  assert.equal(gap.reason, 'cursor-gap')

  const outOfRange = advanceRoomCursor(doc, 'room-1', 'member-1', { messageId: 'missing' })
  assert.equal(outOfRange.ok, false)
  assert.equal(outOfRange.reason, 'cursor-out-of-range')

  const firstBatch = advanceRoomCursor(doc, 'room-1', 'member-1', {
    messageIds: ['m1', 'm2'],
  })
  assert.equal(firstBatch.ok, true)
  assert.equal(firstBatch.cursor.messageId, 'm2')
  assert.deepEqual(
    listRoomMessagesSince(doc, 'room-1', 'member-1').messages.map((message) => message.messageId),
    ['m3'],
  )

  assert.equal(advanceRoomCursor(doc, 'room-1', 'member-1', {
    messageIds: ['m1', 'm2'],
  }).deduplicated, true)
  assert.equal(advanceRoomCursor(doc, 'room-1', 'member-1', {
    messageId: 'm3',
  }).cursor.sequence, 3)
  assert.equal(listRoomMessagesSince(doc, 'room-1', 'member-1').messages.length, 0)

  const sparse = createRoomLedger()
  appendRoomMessage(sparse, { messageId: 's1', roomId: 'room-2', author: 'lead', content: 'for member' })
  appendRoomMessage(sparse, {
    messageId: 's2',
    roomId: 'room-2',
    author: 'lead',
    content: 'for another member',
    recipients: ['member-2'],
  })
  appendRoomMessage(sparse, { messageId: 's3', roomId: 'room-2', author: 'lead', content: 'for member' })
  assert.equal(advanceRoomCursor(sparse, 'room-2', 'member-1', {
    messageIds: ['s1', 's3'],
  }).ok, true)
})

test('D: decisions, unresolved items and round summaries stay separate', () => {
  const doc = createRoomLedger()
  appendRoomMessage(doc, {
    messageId: 'm1',
    roomId: 'room-1',
    author: 'lead',
    content: 'Proposal A',
  })
  const proposed = proposeDecision(doc, {
    roomId: 'room-1',
    decisionId: 'd1',
    sourceMessageId: 'm1',
    title: 'Use A',
    choice: 'A',
    owner: 'lead',
    scope: 'task-1',
  })
  assert.equal(proposed.ok, true)
  assert.equal(effectiveDecisions(doc, 'room-1').decisions.length, 0)
  assert.equal(confirmDecision(doc, 'room-1', 'd1', {
    confirmedBy: 'lead',
    sourceMessageId: 'm1',
  }).decision.status, 'confirmed')
  assert.equal(effectiveDecisions(doc, 'room-1').decisions[0].decisionId, 'd1')

  const replaced = replaceDecision(doc, 'room-1', 'd1', {
    decisionId: 'd2',
    sourceMessageId: 'm1',
    title: 'Use B',
    choice: 'B',
    owner: 'lead',
    scope: 'task-1',
    confirmed: true,
    confirmedBy: 'lead',
  })
  assert.equal(replaced.ok, true)
  assert.equal(replaced.replacement.status, 'confirmed')
  assert.equal(effectiveDecisions(doc, 'room-1').decisions[0].decisionId, 'd2')
  assert.equal(revokeDecision(doc, 'room-1', 'd2', { revokedBy: 'lead' }).ok, true)
  assert.equal(effectiveDecisions(doc, 'room-1').decisions.length, 0)

  const firstClose = closeRoomRound(doc, {
    roomId: 'room-1',
    roundId: 'r1',
    summary: 'Round one concluded.',
    decisions: ['d2'],
    unresolved: [{ itemId: 'u1', kind: 'risk', text: 'Need evidence' }],
    owners: ['lead'],
    nextSteps: ['collect evidence'],
    evidenceLinks: ['artifact://one'],
  })
  assert.equal(firstClose.ok, true)
  assert.equal(firstClose.summary.summaryRevision, 1)
  assert.equal(resolveUnresolved(doc, 'room-1', 'u1', { resolution: 'evidence attached' }).ok, true)
  const secondClose = closeRoomRound(doc, {
    roomId: 'room-1',
    roundId: 'r2',
    summary: 'Round two concluded.',
    unresolved: [],
  })
  assert.equal(secondClose.summary.summaryRevision, 2)
  assert.equal(doc.transcripts['room-1'].length, 1)
  assert.equal(doc.roundSummaries['room-1'].length, 2)
  assert.equal(doc.decisions['room-1'].d2.revision >= 2, true)
})

test('D: cross-group decisions become effective only after every affected lead confirms', () => {
  const doc = createRoomLedger()
  const proposed = proposeDecision(doc, {
    roomId: 'room-cross',
    decisionId: 'd-cross',
    title: 'Freeze shared contract',
    choice: 'Use schema v2',
    scope: 'shared-contract',
    requiredConfirmations: ['lead-a', 'lead-b'],
  })
  assert.equal(proposed.ok, true)
  assert.equal(proposed.decision.status, 'proposed')
  assert.equal(effectiveDecisions(doc, 'room-cross').decisions.length, 0)

  const first = confirmDecision(doc, 'room-cross', 'd-cross', {
    confirmedBy: 'lead-a',
    rationale: 'API owner agrees',
  })
  assert.equal(first.ok, true)
  assert.equal(first.decision.status, 'proposed')
  assert.deepEqual(first.missingConfirmations, ['lead-b'])
  assert.equal(effectiveDecisions(doc, 'room-cross').decisions.length, 0)

  const duplicate = confirmDecision(doc, 'room-cross', 'd-cross', {
    confirmedBy: 'lead-a',
  })
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.decision.confirmations.length, 1)

  const second = confirmDecision(doc, 'room-cross', 'd-cross', {
    confirmedBy: 'lead-b',
    rationale: 'Persistence owner agrees',
  })
  assert.equal(second.decision.status, 'confirmed')
  assert.deepEqual(second.missingConfirmations, [])
  assert.equal(effectiveDecisions(doc, 'room-cross').decisions[0].decisionId, 'd-cross')
  assert.deepEqual(pendingDecisionConfirmations(doc, 'room-cross').decisions, [])
})

test('E: pending wake batches merge without losing message rows', () => {
  const doc = createWakeState()
  const first = requestWake(doc, {
    target: 'member-1',
    reason: 'action-required',
    dedupeKey: 'batch-1',
    priority: 'low',
    messages: [
      { messageId: 'm1', sender: 'lead', originalText: 'first', priority: 'low' },
      { messageId: 'm2', sender: 'peer', originalText: 'second', priority: 'normal' },
    ],
  })
  assert.equal(first.status, 'queued')
  assert.equal(first.wake.messageIds.length, 2)

  const merged = requestWake(doc, {
    target: 'member-1',
    reason: 'action-required',
    dedupeKey: 'batch-1',
    priority: 'high',
    messages: [
      { messageId: 'm3', sender: 'lead', originalText: 'third', priority: 'high' },
    ],
  })
  assert.equal(merged.status, 'queued')
  assert.deepEqual(merged.wake.messageIds, ['m1', 'm2', 'm3'])
  assert.equal(doc.inbox.m1.originalText, 'first')
  assert.equal(doc.inbox.m2.priority, 'normal')
  assert.equal(doc.inbox.m3.priority, 'high')

  const duplicate = requestWake(doc, {
    target: 'member-1',
    reason: 'action-required',
    dedupeKey: 'batch-1',
    messages: [{ messageId: 'm3', sender: 'lead', originalText: 'third', priority: 'high' }],
  })
  assert.equal(duplicate.status, 'deduplicated')
  assert.equal(requestWake(doc, {
    target: 'member-1',
    reason: 'action-required',
    dedupeKey: 'batch-1',
    messageIds: ['m3'],
  }).status, 'deduplicated')
  assert.equal(doc.wakes[first.wake.wakeId].messageIds.length, 3)

  assert.equal(deliverWakeBatch(doc, first.wake.wakeId).status, 'delivered')
  assert.equal(handleWakeBatch(doc, first.wake.wakeId, { messageIds: ['m1', 'm2'] }).status, 'partially-handled')
  assert.equal(doc.inbox.m1.status, 'handled')
  assert.equal(handleWakeBatch(doc, first.wake.wakeId, { messageIds: ['m3'] }).status, 'handled')
  const repeated = handleWakeBatch(doc, first.wake.wakeId, { messageIds: ['m3'] })
  assert.equal(repeated.ok, true)
  assert.equal(repeated.status, 'handled')
  assert.equal(repeated.deduplicated, true)
})

test('E: silent delivery does not wake, failures retry and stop episodes notify once', () => {
  const doc = createWakeState()
  const before = Object.keys(doc.wakes).length
  const silent = requestWake(doc, {
    target: 'member-2',
    kind: 'silent',
    silent: true,
    messages: [{ messageId: 's1', sender: 'lead', originalText: 'quiet note' }],
  })
  assert.equal(silent.status, 'queued')
  assert.equal(silent.wakeup, false)
  assert.equal(silent.wake, null)
  assert.equal(Object.keys(doc.wakes).length, before)
  assert.equal(doc.inbox.s1.wakeRequested, false)

  const failed = requestWake(doc, {
    target: 'member-3',
    reason: 'retryable',
    dedupeKey: 'retryable',
    messages: [{ messageId: 'f1', sender: 'lead', originalText: 'retry me' }],
  })
  assert.equal(deliverWakeBatch(doc, failed.wake.wakeId, { error: 'transport down' }).status, 'delivery-failed')
  assert.equal(retryWake(doc, failed.wake.wakeId).status, 'queued')
  assert.equal(doc.inbox.f1.status, 'queued')

  const rejected = requestWake(doc, {
    target: 'member-4',
    reason: 'business-rejection',
    dedupeKey: 'reject',
    messages: [{ messageId: 'r1', sender: 'lead', originalText: 'not allowed' }],
  })
  assert.equal(rejectWake(doc, rejected.wake.wakeId, { reason: 'policy' }).status, 'rejected')
  assert.equal(retryWake(doc, rejected.wake.wakeId).reason, 'wake-not-retryable')

  assert.equal(evaluateStopEpisode(doc, { projectId: 'p1', active: false, now: 1 }).status, 'notify')
  assert.equal(evaluateStopEpisode(doc, { projectId: 'p1', active: false, now: 2 }).status, 'suppressed')
  assert.equal(evaluateStopEpisode(doc, { projectId: 'p1', active: true, now: 3 }).status, 'closed')
  assert.equal(evaluateStopEpisode(doc, { projectId: 'p1', active: false, now: 4 }).status, 'notify')
  assert.equal(doc.stopEpisodes.p1.reminderCount, 1)
})

test('F: done atomically creates one job and next milestone is a new record', () => {
  const doc = createCompactionState()
  assert.equal(setMilestone(doc, {
    milestoneId: 'm1',
    owner: 'lead',
    goal: 'finish D',
    acceptance: ['tests pass'],
    firstStep: 'write tests',
    contextRevision: 4,
  }).ok, true)
  const firstDone = doneMilestone(doc, { milestoneId: 'm1', contextRevision: 5 })
  assert.equal(firstDone.ok, true)
  assert.equal(firstDone.job.status, 'queued')
  assert.equal(firstDone.maySetNextMilestone, true)

  assert.equal(setMilestone(doc, {
    milestoneId: 'm2',
    owner: 'lead',
    goal: 'finish E',
    acceptance: ['wake tests pass'],
    firstStep: 'merge batches',
  }).ok, true)
  assert.equal(doc.jobs[firstDone.job.jobId].status, 'queued')
  assert.equal(doc.milestones.m1.status, 'done')

  const duplicateDone = doneMilestone(doc, { milestoneId: 'm1' })
  assert.equal(duplicateDone.deduplicated, true)
  assert.equal(Object.keys(doc.jobs).length, 1)
})

test('F: handoff gate, failure retry, explicit none and pressure bypass are durable', () => {
  const doc = createCompactionState()
  setMilestone(doc, { milestoneId: 'm1', owner: 'lead', goal: 'first', firstStep: 'one' })
  const done = doneMilestone(doc, { milestoneId: 'm1' })
  assert.equal(waitForHandoff(doc, done.job.jobId).status, 'waiting_for_handoff')
  const blocked = markHandoffReady(doc, done.job.jobId)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'handoff-gate')
  assert.equal(doc.jobs[done.job.jobId].status, 'waiting_for_handoff')

  setMilestone(doc, { milestoneId: 'm2', owner: 'lead', goal: 'second', firstStep: 'two' })
  assert.equal(markHandoffReady(doc, done.job.jobId, {
    nextMilestoneId: 'm2',
    decisions: [{ decisionId: 'd1' }],
    unresolved: [{ itemId: 'u1' }],
    cursors: { 'room-1': { memberId: 'member-1', sequence: 2 } },
  }).status, 'ready')
  assert.equal(startCompaction(doc, done.job.jobId).status, 'running')
  assert.equal(failCompaction(doc, done.job.jobId, { error: 'provider reset' }).status, 'failed')
  assert.equal(retryCompaction(doc, done.job.jobId).status, 'queued')
  assert.equal(waitForHandoff(doc, done.job.jobId).status, 'waiting_for_handoff')
  assert.equal(markHandoffReady(doc, done.job.jobId, { none: true }).status, 'ready')
  assert.equal(startCompaction(doc, done.job.jobId).status, 'running')
  assert.equal(completeCompaction(doc, done.job.jobId).status, 'completed')

  setMilestone(doc, { milestoneId: 'm3', owner: 'lead', goal: 'third', firstStep: 'three' })
  const pressure = doneMilestone(doc, { milestoneId: 'm3' })
  const bypassed = bypassHandoffForPressure(doc, pressure.job.jobId)
  assert.equal(bypassed.status, 'ready')
  assert.equal(bypassed.handoff_pending, true)
  const resume = buildCompactionResumeContext(doc, { jobId: pressure.job.jobId })
  assert.equal(resume.firstAction, COMPACTION_RECOVERY_FIRST_ACTION)
  assert.match(resume.firstAction, /恢复当前任务/)
  assert.doesNotMatch(resume.firstAction, /重新读取 v12|重新读取 v13/)
  assert.equal(resume.handoff_pending, true)
  assert.match(resume.recoveryNote, /handoff_pending/)
})

test('J: context sources are filtered, deduped and auditable', () => {
  const duplicateContent = 'same authoritative body'
  const pack = buildContextPack({
    target: {
      memberId: 'member-1',
      teamId: 'team-1',
      taskId: 'task-1',
      permissions: ['read'],
    },
    maxTokens: 500,
    sources: [
      {
        sourceId: 'permission',
        revision: 1,
        content: 'permission constraints',
        retentionClass: 'permission',
        required: true,
        permissions: ['read'],
        teamId: 'team-1',
      },
      {
        sourceId: 'contract',
        revision: 1,
        content: 'current task contract',
        retentionClass: 'task-contract',
        required: true,
        teamId: 'team-1',
        taskId: 'task-1',
      },
      {
        sourceId: 'decision',
        revision: 1,
        content: 'old decision',
        retentionClass: 'decision',
        required: true,
        teamId: 'team-1',
      },
      {
        sourceId: 'decision',
        revision: 2,
        content: 'new decision',
        retentionClass: 'decision',
        required: true,
        teamId: 'team-1',
      },
      {
        sourceId: 'same-a',
        revision: 1,
        content: duplicateContent,
        retentionClass: 'background',
      },
      {
        sourceId: 'same-b',
        revision: 1,
        content: duplicateContent,
        retentionClass: 'background',
      },
      {
        sourceId: 'wrong-team',
        revision: 1,
        content: 'secret',
        teamId: 'team-2',
      },
      {
        sourceId: 'expired',
        revision: 1,
        content: 'expired',
        expiresAt: 1,
      },
      {
        sourceId: 'denied',
        revision: 1,
        content: 'denied',
        permissions: ['admin'],
      },
    ],
  })
  assert.equal(pack.ok, true)
  assert.equal(pack.status, 'ready')
  assert.equal(pack.items.some((item) => item.sourceId === 'decision' && item.revision === 2), true)
  assert.equal(pack.items.filter((item) => item.contentHash === contentHash(duplicateContent)).length, 1)
  assert.equal(pack.items.some((item) => item.sourceId === 'wrong-team'), false)
  assert.equal(pack.manifest.filtered.some((entry) => entry.reason === 'wrong-team'), true)
  assert.equal(pack.manifest.filtered.some((entry) => entry.reason === 'expired'), true)
  assert.equal(pack.manifest.filtered.some((entry) => entry.reason === 'permission-denied'), true)
  assert.equal(pack.manifest.duplicates.some((entry) => entry.reason === 'superseded-revision'), true)
  assert.equal(pack.manifest.duplicates.some((entry) => entry.reason === 'duplicate-content'), true)
  assert.equal(pack.items.every((item) => item.sourceId && item.revision && item.estimatedTokens > 0), true)
})

test('J: optional sources clip to summaries and required over-budget blocks', () => {
  const large = 'tool output '.repeat(100)
  const pack = buildContextPack({
    target: { memberId: 'member-1', teamId: 'team-1', taskId: 'task-1' },
    maxTokens: 45,
    sources: [
      {
        sourceId: 'contract',
        revision: 1,
        content: 'task contract',
        retentionClass: 'task-contract',
        required: true,
      },
      {
        sourceId: 'log',
        revision: 1,
        content: large,
        summary: 'log summary',
        retentionClass: 'tool-log',
        locator: 'artifact://log',
      },
    ],
  })
  assert.equal(pack.ok, true)
  const log = pack.items.find((item) => item.sourceId === 'log')
  assert.equal(log.clipped, true)
  assert.equal(log.content, 'log summary')
  assert.equal(log.locator, 'artifact://log')
  assert.equal(pack.manifest.trimmed.some((entry) => entry.sourceId === 'log'), true)

  const blocked = buildContextPack({
    target: { memberId: 'member-1', teamId: 'team-1', taskId: 'task-1' },
    maxTokens: 3,
    sources: [{
      sourceId: 'required',
      revision: 1,
      content: 'this required contract is definitely too large',
      retentionClass: 'task-contract',
      required: true,
    }],
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.status, 'context-budget-blocked')
  assert.equal(blocked.blocked, true)
  assert.deepEqual(blocked.items, [])
  assert.equal(blocked.overBy > 0, true)
  assert.equal(blocked.manifest.excluded[0].reason, 'required-over-budget')
  assert.equal(estimateTokens('abcd'), 1)
})
