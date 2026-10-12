import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  shellWriteTargets,
  worktreeBindingMissingVerdict,
} from '../home/profiles/web/plugins/write-scope-guard.mjs'
import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  phaseAdvanceGuidance,
  taskGateActionable,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import {
  acknowledgeInboxEntry,
  authorizeWaitingAction,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'

test('pwsh here-strings stay data while an explicit write target remains visible', () => {
  const cwd = join(tmpdir(), 'dsh-batch25-shell-fixture')
  const command = [
    "$message = @'",
    'per',
    'src/not-a-path.rs',
    "'@",
    'Set-Content -LiteralPath docs/out.txt -Value $message',
  ].join('\n')
  const targets = shellWriteTargets(command, cwd).targets
  assert.deepEqual(targets, [resolve(cwd, 'docs/out.txt')])
  assert.equal(targets.includes(resolve(cwd, 'per')), false)
})

test('managed worktree targets without a plan binding name the real cause', () => {
  const target = 'D:/repo/.dsh-worktrees/grp__proto/crates/demo/src/lib.rs'
  const missing = worktreeBindingMissingVerdict({
    activePlan: { taskId: 'group-proto-t1', member: 'lead-proto' },
    targetPath: target,
    tier: 1,
  })
  assert.equal(missing.missing, true)
  assert.equal(missing.code, 'worktree-binding-missing')
  assert.match(missing.detail, /team_worktree_setup/)

  assert.equal(worktreeBindingMissingVerdict({
    activePlan: { worktreePath: 'D:/repo/.dsh-worktrees/grp__proto' },
    targetPath: target,
    tier: 1,
  }).missing, false)
  assert.equal(worktreeBindingMissingVerdict({
    activePlan: {},
    targetPath: 'D:/repo/src/lib.rs',
    tier: 1,
  }).missing, false)
  assert.equal(worktreeBindingMissingVerdict({
    activePlan: {},
    targetPath: target,
    tier: 2,
  }).missing, false)
})

test('lease heartbeat can rebind contractRevision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-batch25-heartbeat-'))
  try {
    const cp = controlPlaneFor('batch25-heartbeat', { directory: root })
    const initial = await cp.leaseAcquire({
      member: 'member-a',
      taskId: 'task-a',
      contractRevision: 2,
    }, {})
    assert.equal(initial.contractRevision, 2)
    const heartbeat = await cp.leaseHeartbeat({
      runId: initial.runId,
      contractRevision: 3,
    }, {})
    assert.equal(heartbeat.contractRevision, 3)
    assert.equal(cp.snapshot().leases[initial.runId].contractRevision, 3)
    await assert.rejects(() => cp.leaseHeartbeat({
      runId: initial.runId,
      contractRevision: 0,
    }, {}), /positive integer/)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a retired pending inbox acknowledgement is idempotent and target-scoped', () => {
  const state = {
    dispatches: {
      d1: {
        dispatchId: 'd1',
        target: 'member-a',
        status: 'queued',
        pendingMessages: [{
          messageId: 'msg-1',
          status: 'queued',
          text: 'handle me',
        }],
      },
    },
  }
  const first = acknowledgeInboxEntry(state, {
    target: 'member-a',
    inboxId: 'msg-1',
    at: 100,
  })
  assert.equal(first.ok, true)
  assert.equal(state.dispatches.d1.pendingMessages[0].status, 'handled')
  assert.equal(state.v12RoomWake.acknowledgedInbox['msg-1'].target, 'member-a')

  const second = acknowledgeInboxEntry(state, {
    target: 'member-a',
    inboxId: 'msg-1',
    at: 200,
  })
  assert.equal(second.ok, true)
  assert.equal(second.deduplicated, true)
  assert.equal(second.retired, true)

  const wrongTarget = acknowledgeInboxEntry(state, {
    target: 'member-b',
    inboxId: 'msg-1',
    at: 300,
  })
  assert.equal(wrongTarget.ok, false)
  assert.equal(wrongTarget.reason, 'inbox-ack-scope')
})

test('phase refusal guidance lists every adjacent step', () => {
  const guidance = phaseAdvanceGuidance('member-check', 'integration-ready')
  assert.deepEqual(guidance.steps, ['group-check', 'verifier-review', 'integration-ready'])
  assert.match(guidance.detail, /3 steps/)
  assert.match(guidance.detail, /call team_task_update\(action:"advance_phase"\) once per step/)
  assert.deepEqual(phaseAdvanceGuidance('group-check', 'verifier-review').steps, ['verifier-review'])
})

test('integrated history suppresses only historical packet gates', () => {
  assert.equal(taskGateActionable(true, 'phase-accepted'), false)
  assert.equal(taskGateActionable(true, 'group-acceptance'), false)
  assert.equal(taskGateActionable(true, 'verifier-review'), false)
  assert.equal(taskGateActionable(true, 'final-acceptance'), false)
  assert.equal(taskGateActionable(true, 'owner'), true)
  assert.equal(taskGateActionable(true, 'commit'), true)
  assert.equal(taskGateActionable(true, 'evidence'), true)
  assert.equal(taskGateActionable(false, 'phase-accepted'), true)
})

test('a waiter may resolve its own explicit ticket but not set waits or resolve another ticket', () => {
  const base = {
    tier: 2,
    memberName: 'verifier',
    group: 'rig',
    taskOwner: 'member-a',
    taskBoard: 'group-rig',
    ownerGroup: 'rig',
  }
  assert.equal(authorizeWaitingAction({
    ...base,
    ticket: { ticketId: 'wait:1', waiter: 'verifier' },
    allowWaiterResolve: true,
  }).ok, true)
  assert.equal(authorizeWaitingAction({
    ...base,
    ticket: { ticketId: 'wait:1', responsible: 'verifier' },
    allowWaiterResolve: true,
  }).ok, true)
  assert.equal(authorizeWaitingAction({
    ...base,
    ticket: { ticketId: 'wait:1', waiter: 'verifier' },
  }).code, 'waiting-scope')
  assert.equal(authorizeWaitingAction({
    ...base,
    ticket: undefined,
    allowWaiterResolve: true,
  }).code, 'waiting-scope')
  assert.equal(authorizeWaitingAction({
    ...base,
    ticket: { ticketId: 'wait:2', waiter: 'someone-else' },
    allowWaiterResolve: true,
  }).code, 'waiting-scope')
})
