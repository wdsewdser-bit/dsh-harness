import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyTaskEdit,
  reconcileState,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import { contractDigest } from '../home/profiles/web/plugins/team-v12-contract.mjs'
import {
  mergeTargetPhase,
  pendingDispatchText,
  taskUpdateUnknownFields,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import {
  acknowledgePendingDispatchMessage,
  pendingDispatchInboxRows,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'

test('B-104: task update rejects unknown fields and accepts explicit contract fields', () => {
  assert.deepEqual(taskUpdateUnknownFields({
    task_id: 'task-1',
    expected_revision: 1,
    action: 'edit',
    goal: 'new goal',
    deliverable: 'new deliverable',
  }), [])
  assert.deepEqual(taskUpdateUnknownFields({
    task_id: 'task-1',
    expected_revision: 1,
    action: 'edit',
    deliverable_typo: 'silently lost before this fix',
  }), ['deliverable_typo'])
})

test('B-105: task edit updates the row and nested contract deterministically', () => {
  const task = {
    id: 'task-1',
    revision: 7,
    subject: 'old subject',
    description: 'old description',
    writeScopes: ['src/old'],
    status: 'pending',
    contract: {
      taskId: 'task-1',
      goal: 'old goal',
      deliverable: 'old deliverable',
      writeScopes: ['src/old'],
      contractRevision: 3,
    },
  }
  applyTaskEdit(task, {
    taskId: 'task-1',
    expectedRevision: 7,
    action: 'edit',
    goal: 'new goal',
    deliverable: 'new deliverable',
    description: 'new description',
    writeScopes: ['src/new'],
  })

  assert.equal(task.subject, 'old subject')
  assert.equal(task.description, 'new description')
  assert.deepEqual(task.writeScopes, ['src/new'])
  assert.equal(task.contract.goal, 'new goal')
  assert.equal(task.contract.deliverable, 'new deliverable')
  assert.deepEqual(task.contract.writeScopes, ['src/new'])
  assert.equal(task.contract.contractRevision, 4)
  assert.equal(task.contractDigest, contractDigest(task.contract))

  const subjectOnly = {
    id: 'task-2',
    revision: 1,
    subject: 'old',
    description: 'old description',
    writeScopes: ['src'],
    status: 'pending',
    contract: { taskId: 'task-2', contractRevision: 1 },
  }
  applyTaskEdit(subjectOnly, { taskId: 'task-2', expectedRevision: 1, action: 'edit', subject: 'new' })
  assert.equal(subjectOnly.contract.goal, 'new')
  assert.equal(subjectOnly.contract.deliverable, 'new')
})

test('B-106: requeued handoffs expose their original payload in inbox_list', () => {
  const dispatch = {
    dispatchId: 'wake:acceptance-verifier:packet-1',
    sender: 'lead-proto',
    target: 'verifier',
    status: 'queued',
    createdAt: 100,
    pendingMessages: [{
      messageId: 'packet-1',
      messageHash: 'hash-1',
      text: 'Review the exact commit and task set.',
      status: 'queued',
      createdAt: 100,
    }],
  }
  assert.equal(pendingDispatchText(dispatch), 'Review the exact commit and task set.')
  const rows = pendingDispatchInboxRows({ [dispatch.dispatchId]: dispatch }, 'verifier')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].inboxId, 'packet-1')
  assert.equal(rows[0].dispatchId, dispatch.dispatchId)
  assert.equal(rows[0].originalText, 'Review the exact commit and task set.')
  assert.equal(rows[0].source, 'dispatch-pending')
})

test('B-106: pending handoffs have an ack path and terminal retry is visible', () => {
  const dispatch = {
    dispatchId: 'wake:acceptance-verifier:packet-2',
    sender: 'lead-proto',
    target: 'verifier',
    status: 'queued',
    createdAt: 100,
    pendingMessages: [{
      messageId: 'packet-2',
      messageHash: 'hash-2',
      text: 'Review this exact packet.',
      status: 'queued',
      createdAt: 100,
    }],
  }
  const state = { dispatches: { [dispatch.dispatchId]: dispatch } }
  const ack = acknowledgePendingDispatchMessage(state, {
    target: 'verifier',
    inboxId: 'packet-2',
    at: 200,
  })
  assert.equal(ack.ok, true)
  assert.equal(dispatch.pendingMessages[0].status, 'handled')
  assert.equal(dispatch.status, 'completed')

  const terminal = {
    dispatchId: 'wake:acceptance-verifier:packet-3',
    sender: 'lead-proto',
    target: 'verifier',
    status: 'queued',
    wakeup: true,
    attempt: 3,
    createdAt: 0,
    deadlineAt: 0,
    pendingMessages: [{
      messageId: 'packet-3',
      messageHash: 'hash-3',
      text: 'Terminal retry payload.',
      status: 'queued',
      createdAt: 0,
    }],
  }
  const terminalState = { dispatches: { [terminal.dispatchId]: terminal } }
  reconcileState(terminalState, { deliveryTimeoutMs: 100, maxAttempts: 3 }, 1000)
  assert.equal(terminal.status, 'timed-out')
  assert.equal(terminal.pendingMessages[0].status, 'delivery-failed')
  const visible = pendingDispatchInboxRows(terminalState.dispatches, 'verifier')
  assert.equal(visible.length, 1)
  assert.equal(visible[0].dispatchStatus, 'timed-out')
})

test('B-107: only main merges advance a task to integrated', () => {
  assert.equal(mergeTargetPhase('main'), 'integrated')
  assert.equal(mergeTargetPhase('grp/proto'), 'integration-ready')
})
