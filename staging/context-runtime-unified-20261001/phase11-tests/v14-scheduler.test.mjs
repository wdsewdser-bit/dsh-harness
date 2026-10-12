import test from 'node:test'
import assert from 'node:assert/strict'
import {
  idleWatchCadence,
  roomCloseAttempt,
  roomTimeoutReminder,
  roomTimeoutAttempt,
  timedOutRoomClosures,
  timedOutRoomSpeakers,
} from '../home/profiles/web/plugins/team-idle-watch-v6.mjs'
import {
  activeDispatchBlockers,
  deadLetterRows,
  reconcileSourceRequirement,
  stallDetail,
  taskCompletionHandoff,
  waitingResponsibility,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { buildReadyQueue, taskStatus } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'

test('ready queue derives active execution from live leases instead of in_progress status', () => {
  const edit = (id, owner, scopes, extra = {}) => ({
    id, status: 'in_progress', lifecycle: 'running', phase: 'execution', ownerName: owner,
    revision: 1, writeScopes: scopes, contract: { kind: 'edit', acceptanceCriteria: ['done'] }, ...extra,
  })
  const tasks = [
    edit('active', 'a', ['src/a'], { updatedAt: 9000 }),
    edit('stale', 'b', ['src/b'], { createdAt: 0, updatedAt: 0 }),
  ]
  const members = [{ name: 'a', status: 'running' }, { name: 'b', status: 'idle' }]
  const leases = [{ member: 'a', taskId: 'active', status: 'active', heartbeatAt: 9000, expiresAt: 20_000 }]
  const queue = buildReadyQueue(tasks, members, leases, { now: 10_000, staleExecutionMs: 1000 })
  assert.deepEqual(queue.ready.map((row) => row.id), ['stale'])
  assert.equal(queue.counts.runnable, 1)
  assert.equal(queue.counts.active, 1)
  assert.equal(queue.counts.stalled, 1)
  assert.equal(queue.counts.blocked, 1)
})

test('pending work outranks stale scope and terminal lifecycle never revives', () => {
  const stale = {
    id: 'old', status: 'in_progress', lifecycle: 'running', phase: 'execution', ownerName: 'm',
    revision: 1, writeScopes: ['src/shared'], contract: { kind: 'edit', acceptanceCriteria: ['done'] },
    createdAt: 0, updatedAt: 0,
  }
  const pending = {
    id: 'new', status: 'pending', lifecycle: 'approved', phase: 'execution', ownerName: 'm',
    revision: 1, writeScopes: ['src/shared'], contract: { kind: 'edit', acceptanceCriteria: ['done'] },
  }
  const cancelled = {
    id: 'cancelled', status: 'in_progress', lifecycle: 'cancelled', phase: 'cancelled', ownerName: 'm',
    revision: 1, writeScopes: ['src/other'], contract: { kind: 'edit', acceptanceCriteria: ['done'] },
  }
  assert.equal(taskStatus(cancelled), 'cancelled')
  const queue = buildReadyQueue([stale, pending, cancelled], [{ name: 'm', status: 'idle' }], [],
    { now: 10_000, staleExecutionMs: 1000 })
  assert.deepEqual(queue.ready.map((row) => row.id), ['new'])
  assert.equal(queue.blocked.some((row) => row.id === 'old'
    && row.reasons.includes('runnable-scope-conflict:new')), true)
  assert.equal(queue.blocked.some((row) => row.id === 'cancelled'), false)
})

test('room timeout detection is durable and only reports the current speaker', () => {
  const state = {
    rooms: {
      'group:a:tier-2': {
        roomId: 'group:a:tier-2', status: 'open', host: 'lead', currentRoundId: 'r1',
        messages: [{ roundId: 'r1', createdAt: 1000 }],
      },
      closed: { roomId: 'closed', status: 'closed', currentRoundId: 'r2', messages: [] },
    },
    rounds: {
      r1: { roundId: 'r1', roomId: 'group:a:tier-2', status: 'open', nextSpeaker: 'member', openedAt: 1000, topic: 'x' },
      r2: { roundId: 'r2', roomId: 'closed', status: 'open', nextSpeaker: 'member', openedAt: 1000 },
    },
  }
  const rows = timedOutRoomSpeakers(state, 20_000, 5_000)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].speaker, 'member')
  assert.equal(rows[0].episodeId, 'room-timeout:group:a:tier-2:r1:member')
  assert.match(roomTimeoutReminder(rows[0], 5000), /team_room_timeout_recover/)
  assert.equal(timedOutRoomSpeakers(state, 20_000, 30_000).length, 0)
})

test('room timeout delivery retries are bounded and respect backoff', () => {
  const wait = { episodeId: 'room-timeout:room:round:member' }
  const state = { wakeEpisodes: {} }
  assert.deepEqual(roomTimeoutAttempt(state, wait, 1000, 2, 100), {
    episodeId: 'room-timeout:room:round:member:a1',
    attempt: 1,
  })
  state.wakeEpisodes[wait.episodeId + ':a1'] = { status: 'delivery-failed', updatedAt: 1000 }
  assert.equal(roomTimeoutAttempt(state, wait, 1050, 2, 100), null)
  assert.deepEqual(roomTimeoutAttempt(state, wait, 1100, 2, 100), {
    episodeId: 'room-timeout:room:round:member:a2',
    attempt: 2,
  })
  state.wakeEpisodes[wait.episodeId + ':a2'] = { status: 'delivery-failed', updatedAt: 1100 }
  assert.equal(roomTimeoutAttempt(state, wait, 1200, 2, 100), null)
})

test('awaiting-close rounds have a deadline, bounded host re-wakes and a configured cadence', () => {
  const state = {
    rooms: {
      r: {
        roomId: 'r', status: 'open', host: 'lead', currentRoundId: 'round',
        members: ['lead', 'member'], lastMessageAt: 1000,
        messages: [
          { roundId: 'round', createdAt: 900, turn: true },
          { roundId: 'round', createdAt: 1000, turn: true },
        ],
      },
    },
    rounds: {
      round: {
        roundId: 'round', roomId: 'r', status: 'open', nextSpeaker: null,
        order: ['member', 'lead'], mainSpoken: ['member', 'lead'], openedAt: 800,
      },
    },
    wakeEpisodes: {},
  }
  const waits = timedOutRoomClosures(state, 2000, 500)
  assert.equal(waits.length, 1)
  assert.equal(waits[0].episodeId, 'room-close:r:round')
  assert.equal(waits[0].deadlineAt, 1500)
  assert.deepEqual(roomCloseAttempt(state, waits[0], 2000, 2, 100), {
    episodeId: 'room-close:r:round:a1',
    attempt: 1,
  })
  state.wakeEpisodes['room-close:r:round:a1'] = { status: 'delivered', updatedAt: 2000 }
  assert.equal(roomCloseAttempt(state, waits[0], 2050, 2, 100), null)
  assert.deepEqual(roomCloseAttempt(state, waits[0], 2100, 2, 100), {
    episodeId: 'room-close:r:round:a2',
    attempt: 2,
  })
  assert.deepEqual(idleWatchCadence({ settleMs: 30000, intervalMs: 600000 }), {
    settleMs: 30000,
    intervalMs: 600000,
    scanIntervalMs: 600000,
  })
})

test('waiting responsibility and completion handoff stay compact', () => {
  const snapshot = {
    rooms: { r: { roomId: 'r', host: 'lead', currentRoundId: 'round' } },
    rounds: { round: { roundId: 'round', roomId: 'r', status: 'open', nextSpeaker: 'member', topic: 'topic' } },
  }
  assert.deepEqual(waitingResponsibility(snapshot, 'r'), {
    waiting: true, roomId: 'r', roundId: 'round', speaker: 'member', host: 'lead',
    responsibility: 'speaker-main-turn', topic: 'topic',
  })
  assert.equal(stallDetail({ now: 100, lastProgressAt: 25, owner: 'member' }).quietMs, 75)
  assert.deepEqual(taskCompletionHandoff({ id: 't', ownerName: 'member', status: 'completed' }, { evidenceIds: ['e1'], commitSha: 'abc', at: 100 }).evidenceIds, ['e1'])
})

test('reconcile accepts evidence-only discussion sources and keeps edit commits mandatory', () => {
  const discussion = reconcileSourceRequirement({
    id: 'group-a-t1',
    workKind: 'discussion',
    writeScopes: [],
    commitSha: null,
    evidenceIds: ['evidence-discussion'],
  }, 'group-a-t1')
  assert.equal(discussion.ok, true)
  assert.equal(discussion.commitSha, undefined)
  assert.deepEqual(discussion.evidenceIds, ['evidence-discussion'])

  const editWithoutCommit = reconcileSourceRequirement({
    id: 'group-a-t2',
    workKind: 'edit',
    writeScopes: ['src/a'],
    commitSha: null,
    evidenceIds: ['evidence-edit'],
  }, 'group-a-t2')
  assert.equal(editWithoutCommit.ok, false)
  assert.equal(editWithoutCommit.code, 'reconcile-source')
  assert.match(editWithoutCommit.reason, /exact commit_sha/)

  const missingEvidence = reconcileSourceRequirement({
    id: 'group-a-t3',
    workKind: 'review',
    evidenceIds: [],
  }, 'group-a-t3')
  assert.equal(missingEvidence.ok, false)
  assert.match(missingEvidence.reason, /evidence_ids/)
})

test('delivery blockers ignore superseded attempts and completed-task failures', () => {
  const dispatches = {
    'wake:continuation:task-1:r1:lead:a1': {
      dispatchId: 'wake:continuation:task-1:r1:lead:a1',
      taskId: 'task-1',
      status: 'delivery-failed',
      target: 'lead',
    },
    'wake:continuation:task-1:r1:lead:a2': {
      dispatchId: 'wake:continuation:task-1:r1:lead:a2',
      taskId: 'task-1',
      status: 'queued',
      target: 'lead',
    },
    'wake:continuation:task-2:r1:lead:a1': {
      dispatchId: 'wake:continuation:task-2:r1:lead:a1',
      taskId: 'task-2',
      status: 'delivery-failed',
      target: 'lead',
    },
    'wake:room:round:speaker:member': {
      dispatchId: 'wake:room:round:speaker:member',
      taskId: null,
      status: 'delivery-failed',
      target: 'member',
    },
  }
  const blockers = activeDispatchBlockers(dispatches, [
    { id: 'task-1', status: 'in_progress' },
    { id: 'task-2', status: 'completed' },
  ])
  assert.deepEqual(blockers, [{
    kind: 'dispatch',
    id: 'wake:continuation:task-1:r1:lead:a2',
    status: 'queued',
    target: 'lead',
  }])
})

test('terminal wake rows remain visible as dead letters until a new episode supersedes them', () => {
  const dispatches = {
    'wake:team-wake:lead:member': {
      dispatchId: 'wake:team-wake:lead:member',
      sender: 'lead', target: 'member', taskId: 'task-1', wakeup: true,
      status: 'timed-out', attempt: 3, lastError: 'dispatch deadline expired',
      resolvedAt: 1000,
    },
    'wake:team-wake:lead:member:r2': {
      dispatchId: 'wake:team-wake:lead:member:r2',
      sender: 'lead', target: 'member', taskId: 'task-1', wakeup: true,
      status: 'queued', attempt: 1,
      deadLetter: { status: 'superseded', createdAt: 1000 },
    },
  }
  const rows = deadLetterRows(dispatches, { now: 2000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].dispatchId, 'wake:team-wake:lead:member')
  assert.equal(rows[0].ageMs, 1000)
  assert.equal(activeDispatchBlockers(dispatches, [{ id: 'task-1', status: 'in_progress' }]).length, 1)
  dispatches['wake:team-wake:lead:member'].deadLetter = { status: 'superseded', createdAt: 1000 }
  assert.equal(activeDispatchBlockers(dispatches, [{ id: 'task-1', status: 'in_progress' }]).length, 0)
})
