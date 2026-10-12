#!/usr/bin/env node
/** Plan replacement and terminal-phase recovery regressions. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-plan-recovery-'))
try {
  resetControlPlaneCache()
  const cp = controlPlaneFor('plan-recovery', { directory: root })
  await cp.boardCreate({
    boardId: 'group-test',
    taskId: 'task-1',
    subject: 'scope recovery',
    description: 'replace an approved plan after discovering one missing scope',
    writeScopes: ['src'],
    phase: 'plan-approved',
    workKind: 'edit',
  })
  const base = {
    taskId: 'task-1',
    requirementId: 'req-1',
    goal: 'ship',
    members: ['lead', 'member'],
    writeScopes: ['src'],
    checks: { build: 'node --check src/index.mjs' },
    rollback: 'revert',
    proposedBy: 'lead',
  }
  await cp.planPropose(base)
  await cp.planApprove({ taskId: 'task-1', approvedBy: 'lead' })

  const replacement = await cp.planPropose({
    ...base,
    writeScopes: ['src', 'lib'],
    replaceApproved: true,
    replaceReason: 'the approved scope omitted lib/config.mjs',
  })
  assert.equal(replacement.state, 'plan-proposed')
  assert.equal(replacement.revision, 2)
  assert.equal(replacement.replacedState, 'plan-approved')
  assert.deepEqual(replacement.writeScopes, ['src', 'lib'])
  await cp.planApprove({ taskId: 'task-1', approvedBy: 'lead' })

  await cp.leaseAcquire({ member: 'member', taskId: 'task-1', runId: 'run-active' })
  await assert.rejects(
    () => cp.planPropose({
      ...base,
      writeScopes: ['src', 'lib', 'extra'],
      replaceApproved: true,
      replaceReason: 'must wait for the active lease',
    }),
    /active/,
  )
  await cp.leaseRelease({ runId: 'run-active', status: 'cancelled' })

  const recovered = await cp.boardUpdate({
    boardId: 'group-test',
    taskId: 'task-1',
    expectedRevision: cp.boardGet('group-test', 'task-1').revision,
    action: 'recover_phase',
    phase: 'room-discussion',
  })
  assert.equal(recovered.phase, 'room-discussion')
  await assert.rejects(
    () => cp.roomResolveUnresolved({
      roomId: 'missing-room',
      unresolvedId: 'missing',
      resolution: 'none',
    }),
    /unknown room/,
  )

  console.log('PASS approved plan replacement and phase recovery are available')
} finally {
  resetControlPlaneCache()
  rmSync(root, { recursive: true, force: true })
}
