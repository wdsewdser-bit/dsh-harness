import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  memberMergeSourceVerdict,
  planScopeConflictVerdict,
  PRIVILEGE_TURN_POLICY,
  VERIFIER_CLEARANCE_POLICY,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { inboxAckIdentifierVerdict } from '../home/profiles/web/plugins/team-v12-runtime.mjs'

test('B-167: plan proposals reuse the active-task scope conflict gate', () => {
  const active = {
    id: 't124',
    status: 'in_progress',
    phase: 'execution',
    ownerName: 'member-a',
    writeScopes: ['tests/fixtures/worldgen'],
  }
  const conflict = planScopeConflictVerdict([active], {
    id: 't123',
    taskId: 't123',
    owner: 'member-b',
    writeScopes: ['tests/fixtures/worldgen/ORACLE-SPEC.md'],
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'scope-conflict')
  assert.equal(conflict.conflicts[0].taskId, 't124')

  const disjoint = planScopeConflictVerdict([active], {
    id: 't123',
    taskId: 't123',
    owner: 'member-b',
    writeScopes: ['docs/groups/world'],
  })
  assert.equal(disjoint.ok, true)

  const completed = planScopeConflictVerdict([{
    ...active,
    status: 'completed',
    phase: 'accepted',
  }], {
    id: 't123',
    taskId: 't123',
    owner: 'member-b',
    writeScopes: ['tests/fixtures/worldgen'],
  })
  assert.equal(completed.ok, true)
})

test('O-10-8: heartbeat extends expiresAt when no explicit expiry is supplied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-o10-8-'))
  try {
    const cp = controlPlaneFor('o10-8-root', { directory: root })
    const initial = await cp.leaseAcquire({
      member: 'member-a',
      taskId: 'task-a',
      expiresAt: Date.now() + 1000,
    }, {})
    await new Promise((resolve) => setTimeout(resolve, 10))
    const heartbeat = await cp.leaseHeartbeat({ runId: initial.runId }, {})
    assert.ok(heartbeat.expiresAt > initial.expiresAt)
    assert.ok(heartbeat.expiresAt - heartbeat.heartbeatAt >= 29 * 60 * 1000)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('O-10-9: inbox_ack names namespace mistakes in both directions', () => {
  const roomState = {
    wakes: {
      'wake:member-a:1': { wakeId: 'wake:member-a:1', target: 'member-a' },
    },
    inbox: {
      'msg-1': { inboxId: 'msg-1', target: 'member-a' },
    },
  }
  const inboxAsWake = inboxAckIdentifierVerdict({
    wakeId: 'msg-1',
    roomState,
    memberName: 'member-a',
    tier: 2,
  })
  assert.equal(inboxAsWake.ok, false)
  assert.equal(inboxAsWake.code, 'inbox-id-passed-as-wake')
  assert.match(inboxAsWake.detail, /top-level inbox_id/)

  const wakeAsInbox = inboxAckIdentifierVerdict({
    inboxId: 'wake:member-a:1',
    roomState,
    memberName: 'member-a',
    tier: 2,
  })
  assert.equal(wakeAsInbox.ok, false)
  assert.equal(wakeAsInbox.code, 'wake-id-passed-as-inbox')
  assert.match(wakeAsInbox.detail, /top-level wake_id/)
})

test('B-169: clearance documentation names both blocking severities', () => {
  assert.match(VERIFIER_CLEARANCE_POLICY, /no blocker or major/)
  assert.match(VERIFIER_CLEARANCE_POLICY, /condition, minor, and nit/)
})

test('B-171: active task-scoped privilege can replace only the missing merge pointer', () => {
  const commit = 'a'.repeat(40)
  const privilege = {
    status: 'active',
    taskId: 'group-proto-t82',
    blockedAction: 'team_merge(target:"member-framing", task_id:"group-proto-t82")',
  }
  const allowed = memberMergeSourceVerdict({
    destination: 'grp/proto',
    task: { id: 'group-proto-t82' },
    sourceSha: commit,
    privilege,
    target: 'member-framing',
  })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.expected, commit)
  assert.equal(allowed.privilegeBypass, 'member-merge-task-commit-missing')

  const wrongTarget = memberMergeSourceVerdict({
    destination: 'grp/proto',
    task: { id: 'group-proto-t82' },
    sourceSha: commit,
    privilege,
    target: 'other-member',
  })
  assert.equal(wrongTarget.ok, false)
  assert.equal(wrongTarget.code, 'member-merge-task-commit-missing')

  const invalidSource = memberMergeSourceVerdict({
    destination: 'grp/proto',
    task: { id: 'group-proto-t82' },
    sourceSha: 'abc123',
    privilege,
    target: 'member-framing',
  })
  assert.equal(invalidSource.ok, false)
})

test('O-10-12: approved privilege persists to the next wake and expires at that turn end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-o10-12-'))
  try {
    const cp = controlPlaneFor('o10-12-root', { directory: root })
    const request = await cp.privilegeRequest({
      member: 'member-a',
      requestedBy: 'member-a',
      taskId: 'task-a',
      blockedAction: 'team_merge(target:"member-a", task_id:"task-a")',
      reason: 'fixture',
      evidence: ['fixture'],
    }, {})
    await cp.privilegeApprove({ requestId: request.requestId, approvedBy: 'lead' }, {})
    await cp.privilegeEnd({ member: 'member-a', reason: 'turn ended' }, {})
    assert.equal(cp.privilegeList('approved').length, 1)
    assert.equal(cp.privilegeActive('member-a'), null)

    const active = await cp.privilegeActivate({ member: 'member-a' }, {})
    assert.equal(active.status, 'active')
    await cp.privilegeEnd({ member: 'member-a', reason: 'turn ended' }, {})
    assert.equal(cp.privilegeActive('member-a'), null)
    assert.match(PRIVILEGE_TURN_POLICY, /next wake/)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})
