import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  controlPlaneFor,
  parseTaskDependencyReference,
  resetControlPlaneCache,
  taskDependencySatisfied,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  normalizeWaitingCondition,
  recordWaiting,
  resolveWaiting,
  waitingTicketActive,
} from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import { buildReadyQueue } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import {
  blockedLeaseReleaseVerdict,
  crossBoardBlockerVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'

const tempDirs = []

afterEach(() => {
  resetControlPlaneCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempControlPlane(name) {
  const root = mkdtempSync(join(tmpdir(), name))
  tempDirs.push(root)
  return controlPlaneFor(name, { directory: root })
}

test('B-175: board-qualified dependencies gate readiness across boards', async () => {
  assert.deepEqual(parseTaskDependencyReference('group-world:task-102', 'global'), {
    raw: 'group-world:task-102',
    boardId: 'group-world',
    taskId: 'task-102',
    qualified: true,
  })
  assert.deepEqual(parseTaskDependencyReference('task-102', 'global'), {
    raw: 'task-102',
    boardId: 'global',
    taskId: 'task-102',
    qualified: false,
  })

  const boards = {
    global: { tasks: {} },
    'group-world': {
      tasks: {
        'task-102': {
          id: 'task-102',
          board: 'group-world',
          status: 'completed',
          phase: 'integrated',
        },
      },
    },
  }
  assert.equal(crossBoardBlockerVerdict(['group-world:task-102'], 'global', boards).ok, true)
  assert.equal(crossBoardBlockerVerdict(['task-102'], 'global', boards).ok, false)
  assert.equal(taskDependencySatisfied(boards, 'global', 'group-world:task-102', 'accepted'), false)
  boards['group-world'].tasks['task-102'].phase = 'accepted'
  assert.equal(taskDependencySatisfied(boards, 'global', 'group-world:task-102', 'accepted'), true)

  const blocker = boards['group-world'].tasks['task-102']
  const dependent = {
    id: 'global-t1',
    board: 'global',
    status: 'pending',
    phase: 'room-discussion',
    ownerName: 'member',
    blockedBy: ['group-world:task-102'],
    acceptanceCriteria: ['consume the cleared dependency'],
  }
  const ready = buildReadyQueue([blocker, dependent], [{ name: 'member', status: 'idle' }], [], { now: 100 })
  assert.equal(ready.ready.some((row) => row.id === 'global-t1'), true)
  assert.deepEqual(ready.ready.find((row) => row.id === 'global-t1').dependencyGate[0], {
    id: 'group-world:task-102',
    requiredPhase: 'accepted',
    status: 'completed',
    phase: 'accepted',
    satisfied: true,
    boardId: 'group-world',
    taskId: 'task-102',
    qualified: true,
  })

  const cp = tempControlPlane('dsh-b175-cross-board-')
  await cp.boardCreate({
    boardId: 'group-world',
    taskId: 'task-102',
    subject: 'dependency',
    description: 'cross-board blocker',
    phase: 'accepted',
  }, {})
  const blocked = await cp.boardCreate({
    boardId: 'global',
    taskId: 'global-t1',
    subject: 'dependent',
    description: 'waits on another board',
    blockedBy: ['group-world:task-102'],
    phase: 'room-discussion',
  }, {})
  assert.equal(blocked.ready, false)
  assert.equal(blocked.status, 'pending')
  await cp.boardUpdate({
    boardId: 'group-world',
    taskId: 'task-102',
    expectedRevision: 1,
    action: 'complete',
  }, {})
  const released = cp.boardGet('global', 'global-t1')
  assert.equal(released.ready, true)
  assert.equal(released.revision, 2)

  await cp.boardCreate({
    boardId: 'group-world',
    taskId: 'task-103',
    subject: 'cycle-a',
    description: 'cycle candidate',
    phase: 'room-discussion',
  }, {})
  await cp.boardCreate({
    boardId: 'group-rig',
    taskId: 'task-104',
    subject: 'cycle-b',
    description: 'cycle candidate',
    blockedBy: ['group-world:task-103'],
    phase: 'room-discussion',
  }, {})
  await assert.rejects(
    () => cp.boardUpdate({
      boardId: 'group-world',
      taskId: 'task-103',
      expectedRevision: 1,
      action: 'set_dependencies',
      blockedBy: ['group-rig:task-104'],
    }, {}),
    /task dependency cycle/,
  )
})

test('B-176: a dependency wait may name a non-task object and remains explicit', () => {
  const state = {
    boards: {
      global: {
        tasks: {
          t: {
            id: 't',
            status: 'pending',
            ownerName: 'member',
            revision: 1,
            acceptanceCriteria: ['done'],
          },
        },
      },
    },
  }
  const condition = normalizeWaitingCondition({
    type: 'dependency',
    on: 'verifier clearance for 0123456789abcdef',
  })
  assert.equal(condition.object, 'verifier clearance for 0123456789abcdef')
  const ticket = recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'dependency',
    unblockCondition: condition,
  }, 'lead', { now: 100 })
  assert.equal(ticket.closurePolicy, 'explicit')
  assert.equal(waitingTicketActive(ticket, state, 101), true)
  state.boards.global.tasks.t.revision = 2
  assert.equal(waitingTicketActive(ticket, state, 102), true)
  resolveWaiting(state, { taskId: 't', owner: 'member', ticketId: ticket.ticketId }, 'lead', { now: 103 })
  assert.equal(waitingTicketActive(ticket, state, 104), false)
  assert.throws(
    () => normalizeWaitingCondition({ type: 'dependency' }),
    /requires taskIds or a named object\/note/,
  )
})

test('B-177: blocked release requires a named dependency and is durable', async () => {
  assert.equal(blockedLeaseReleaseVerdict({
    id: 't',
    status: 'in_progress',
    blockedBy: ['group-world:task-102'],
  }, {}).ok, true)
  assert.equal(blockedLeaseReleaseVerdict({
    id: 't',
    status: 'in_progress',
  }, {
    v14Waiting: {
      tickets: {
        wait: {
          ticketId: 'wait',
          taskId: 't',
          status: 'open',
          unblockCondition: { type: 'dependency', on: 'verifier clearance' },
        },
      },
    },
  }).ok, true)
  assert.equal(blockedLeaseReleaseVerdict({ id: 't', status: 'in_progress' }, {}).ok, false)

  const cp = tempControlPlane('dsh-b177-blocked-release-')
  const lease = await cp.leaseAcquire({
    member: 'member',
    taskId: 't',
    expiresAt: Date.now() + 60_000,
  }, {})
  const released = await cp.leaseRelease({
    runId: lease.runId,
    status: 'blocked',
    error: 'named external dependency remains open',
  }, {})
  assert.equal(released.status, 'blocked')
  assert.match(released.error, /named external dependency/)
})
