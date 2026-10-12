import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  applyTaskEdit,
  taskDeleteDependents,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  leaseReleaseOrderVerdict,
  privilegeActivationAllowed,
  readyReasonDiagnostics,
  taskListPageMetadata,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { recordWaiting } from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import { waitingSetTargetVerdict } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { shellWriteTargets } from '../home/profiles/web/plugins/write-scope-guard.mjs'

test('B-237: exact-limit pages expose total and truncation metadata', () => {
  assert.deepEqual(taskListPageMetadata(100, 0, 50, 50), {
    total: 100,
    returned: 50,
    truncated: true,
  })
  assert.deepEqual(taskListPageMetadata(50, 0, 50, 50), {
    total: 50,
    returned: 50,
    truncated: false,
  })
})

test('B-238: editing the default description updates the default acceptance text', () => {
  const task = {
    id: 't238',
    subject: 'old subject',
    description: 'old description',
    ownerName: 'member',
    contract: {
      goal: 'old subject',
      deliverable: 'old description',
      acceptanceCriteria: [{ id: 'ac-1', text: 'old description', required: true }],
      contractRevision: 2,
    },
  }
  const updated = applyTaskEdit(task, { description: 'new description' })
  assert.equal(updated.contract.deliverable, 'new description')
  assert.equal(updated.contract.acceptanceCriteria[0].text, 'new description')
})

test('B-240: dependency diagnostics survive a missing scheduler reason', () => {
  const result = readyReasonDiagnostics({ id: 't240', reasons: ['no-plan'], unmet: ['group-world:dep'] })
  assert.deepEqual(result.readyReasons.map((row) => row.code), ['no-plan', 'dependency-unmet'])
  assert.deepEqual(result.readyReasons[1].taskIds, ['group-world:dep'])
})

test('B-242: delete preflight names every dependent task', () => {
  const dependents = taskDeleteDependents({
    group: {
      tasks: {
        source: { id: 'source', status: 'pending' },
        child: { id: 'child', status: 'pending', blockedBy: ['source'] },
      },
    },
  }, 'group', 'source')
  assert.deepEqual(dependents, ['child'])
})

test('B-243: waiting_set reuses the same responsibility row when the responsible actor changes', () => {
  const state = { boards: { group: { tasks: { t: { id: 't', ownerName: 'member', revision: 1 } } } } }
  const first = recordWaiting(state, {
    taskId: 't', owner: 'member', waiter: 'lead', responsible: 'old-lead',
    reason: 'manual', unblockCondition: { type: 'manual' },
  }, 'lead', { now: 100 })
  const target = waitingSetTargetVerdict(state, {
    taskId: 't', owner: 'member', waiter: 'lead', responsible: 'new-lead',
    reason: 'manual', unblockCondition: { type: 'manual' },
  })
  assert.equal(target.ok, true)
  assert.equal(target.ticketId, first.ticketId)
  const updated = recordWaiting(state, {
    ticketId: target.ticketId, taskId: 't', owner: 'member', waiter: 'lead',
    responsible: 'new-lead', reason: 'manual', unblockCondition: { type: 'manual' },
  }, 'lead', { now: 200 })
  assert.equal(updated.ticketId, first.ticketId)
  assert.equal(updated.responsible, 'new-lead')
  assert.equal(Object.keys(state.v14Waiting.tickets).length, 1)
})

test('B-244: a completed run may leave a task open only with a named residual dependency', () => {
  const openWithoutReason = leaseReleaseOrderVerdict({ id: 't244', status: 'pending' }, 'completed', {
    boards: { group: { tasks: { t244: { id: 't244', status: 'pending' } } } },
    v14Waiting: { tickets: {} },
  })
  assert.equal(openWithoutReason.ok, false)
  assert.equal(openWithoutReason.code, 'lease-release-order')

  const openWithDependency = leaseReleaseOrderVerdict({ id: 't244', status: 'pending', blockedBy: ['external-task'] }, 'completed', {
    boards: { group: { tasks: { t244: { id: 't244', status: 'pending', blockedBy: ['external-task'] } } } },
    v14Waiting: { tickets: {} },
  })
  assert.equal(openWithDependency.ok, true)
  assert.equal(openWithDependency.residual, true)
})

test('B-246: approval received mid-turn waits for the next turn', () => {
  const turnStartedAt = 2_000
  assert.equal(privilegeActivationAllowed({ status: 'approved', approvedAt: 1_999 }, turnStartedAt), true)
  assert.equal(privilegeActivationAllowed({ status: 'approved', approvedAt: 2_001 }, turnStartedAt), false)
  assert.equal(privilegeActivationAllowed({ status: 'approved' }, undefined), true)
  assert.equal(privilegeActivationAllowed({ status: 'pending', approvedAt: 1_999 }, turnStartedAt), false)
})

test('B-249: target selection has a single-owner result contract', () => {
  const source = String(readFileSync('D:/dsh-test/home/profiles/web/plugins/team-tools-v2-r10.mjs', 'utf8'))
  assert.match(source, /const targetMembers = args\.target === undefined/)
  assert.match(source, /\[\[wanted, state\.members\[wanted\]\]\]/)
})

test('B-245: read-only git commands with a PowerShell path stay non-writing', () => {
  const cwd = 'D:/dsh-test/workspaces/RustMc'
  for (const command of [
    'git ls-tree HEAD -- tools/rig-batch/tests/verify.ps1',
    'git cat-file -p HEAD:tools/rig-batch/tests/verify.ps1',
    'git log -- tools/rig-batch/tests/verify.ps1',
    'git ls-tree HEAD',
  ]) {
    const parsed = shellWriteTargets(command, cwd)
    assert.deepEqual(parsed.targets, [])
    assert.equal(parsed.opaque, false)
    assert.equal(parsed.gitWrite, false)
  }
})
