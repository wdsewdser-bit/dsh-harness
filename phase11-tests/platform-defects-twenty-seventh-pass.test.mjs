import test from 'node:test'
import assert from 'node:assert/strict'

import {
  recordWaiting,
  reconcileWaitingTickets,
  resolveWaiting,
  waitingTicketActive,
} from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import { authorizeRequirementRecord } from '../home/profiles/web/plugins/team-v12-runtime.mjs'

test('B-182: structured post-completion waits survive task-terminal', () => {
  const state = {
    boards: {
      global: {
        tasks: {
          t: { id: 't', status: 'completed', phase: 'integration-ready', revision: 3 },
          dep: { id: 'dep', status: 'pending', phase: 'room-discussion', revision: 1 },
        },
      },
    },
    v14Waiting: { tickets: {} },
  }
  const external = recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'external',
    unblockCondition: { type: 'external', on: 'cross-group negative control' },
  }, 'lead', { now: 100 })
  const dependency = recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'dependency',
    unblockCondition: { type: 'dependency', taskIds: ['dep'] },
  }, 'lead', { now: 101 })
  const legacy = recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'legacy',
  }, 'lead', { now: 102 })

  reconcileWaitingTickets(state, { now: 200 })
  assert.equal(external.status, 'open')
  assert.equal(dependency.status, 'open')
  assert.equal(waitingTicketActive(external, state, 200), true)
  assert.equal(waitingTicketActive(dependency, state, 200), true)
  assert.equal(legacy.status, 'resolved')
  assert.equal(legacy.closedReason, 'task-terminal')

  state.boards.global.tasks.dep.status = 'completed'
  state.boards.global.tasks.dep.phase = 'accepted'
  reconcileWaitingTickets(state, { now: 300 })
  assert.equal(dependency.status, 'resolved')
  assert.equal(dependency.closedReason, 'condition-cleared')
  assert.equal(external.status, 'open')

  const late = resolveWaiting(state, {
    ticketId: external.ticketId,
    resolution: 'external gate cleared explicitly',
  }, 'lead', { now: 400 })
  assert.equal(late.alreadyResolved, false)
  assert.equal(external.closedReason, 'explicit-resolve')
})

test('B-183: task-scoped requirement authorization inherits taskIds and scope', () => {
  const requirementId = 'task:group-world-t133:acceptance'
  const taskRows = [
    { task: { id: 'group-world-t133' }, board: 'group-world' },
    { task: { id: 'group-rig-t99' }, board: 'group-rig' },
  ]
  const existingRecords = {
    [requirementId]: {
      requirementId,
      taskIds: ['group-world-t133'],
      scope: 'crates/mc-worldgen/tests/',
    },
  }
  const allowWorld = (_name, board) => board === 'group-world'

  assert.deepEqual(authorizeRequirementRecord({
    tier: 1,
    memberName: 'lead-world',
    group: 'world',
    input: { requirementId, text: 'strengthen c1' },
    taskRows,
    existingRecords,
    canWriteBoard: allowWorld,
  }), { ok: true })

  assert.deepEqual(authorizeRequirementRecord({
    tier: 1,
    memberName: 'lead-world',
    group: 'world',
    input: { requirementId, scope: '', text: 'strengthen c1' },
    taskRows,
    existingRecords,
    canWriteBoard: allowWorld,
  }), { ok: true })

  assert.deepEqual(authorizeRequirementRecord({
    tier: 1,
    memberName: 'lead-world',
    group: 'world',
    input: { requirementId: 'task:group-rig-t99:acceptance', text: 'cross-board' },
    taskRows,
    existingRecords: {},
    canWriteBoard: allowWorld,
  }), {
    ok: false,
    code: 'requirement-task-scope',
    detail: 'task "group-rig-t99" is outside the lead writable board scope',
  })
})
