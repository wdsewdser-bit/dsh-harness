import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { controlPlaneFor } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { normalizeTaskContract, validateTaskContract } from '../home/profiles/web/plugins/team-v12-contract.mjs'

test('an unowned contract can be claimed by exactly the candidate owner', () => {
  const contract = normalizeTaskContract({
    taskId: 'task-claim',
    goal: 'Claim an unowned task',
    owner: null,
    writeScopes: ['src/claim'],
    acceptanceCriteria: [{ id: 'ac-1', text: 'claim succeeds' }],
    risk: { level: 'low', rationale: 'isolated' },
  })

  const rejected = validateTaskContract(contract, { allowLegacy: true })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.errors.some((error) => error.code === 'owner-required'), true)

  const accepted = validateTaskContract(contract, { allowLegacy: true, claimOwner: 'member-a' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.contract.owner, 'member-a')
})

test('room host replacement and frozen-speaker force close are audited', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-room-recovery-'))
  try {
    const control = controlPlaneFor('room-recovery-' + Date.now(), { directory })
    control.roomOpen({
      roomId: 'room-1',
      kind: 'group',
      host: 'lead-old',
      members: ['lead-old', 'member-a'],
    })
    control.roomJoin('room-1', 'member-a')
    control.frozenSet({ member: 'lead-old', frozen: true })
    const round = control.roomNext({
      roomId: 'room-1',
      topic: 'recovery',
      members: ['member-a', 'lead-old'],
    })
    control.roomPost({
      roomId: 'room-1',
      roundId: round.roundId,
      author: 'member-a',
      content: 'The active member has spoken.',
      kind: 'fact',
    })

    await assert.rejects(
      control.roomClose({
        roomId: 'room-1',
        roundId: round.roundId,
        summary: 'missing frozen host',
        unresolved: [],
      }),
      /missing: lead-old/,
    )

    const closed = await control.roomClose({
      roomId: 'room-1',
      roundId: round.roundId,
      summary: 'frozen host waived',
      unresolved: [],
      forceClose: true,
      waivedMembers: ['lead-old'],
      forceCloseReason: 'host frozen before the round closed',
      forceClosedBy: 'lead',
    })
    assert.deepEqual(closed.round.waivedMembers, ['lead-old'])
    assert.equal(closed.round.forceClosedBy, 'lead')
    assert.equal(closed.round.forceCloseReason, 'host frozen before the round closed')

    const reopened = await control.roomOpen({
      roomId: 'room-1',
      kind: 'group',
      host: 'lead-new',
      replaceHost: true,
      members: ['lead-old', 'member-a'],
    })
    assert.equal(reopened.host, 'lead-new')
    assert.equal(reopened.members.includes('lead-new'), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cross-group room decisions stay proposed until every affected lead confirms', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-room-confirm-'))
  try {
    const control = controlPlaneFor('room-confirm-' + Date.now(), { directory })
    await control.roomOpen({
      roomId: 'room-cross',
      kind: 'level',
      host: 'lead-a',
      members: ['lead-a', 'lead-b'],
    })
    const decision = await control.roomDecision({
      roomId: 'room-cross',
      title: 'Shared API contract',
      choice: 'Use v2',
      rationale: 'Both groups depend on it.',
      decidedBy: 'lead-a',
      requiredConfirmations: ['lead-a', 'lead-b'],
    }, { id: 'lead-a' })
    assert.equal(decision.status, 'proposed')
    assert.deepEqual(decision.missingConfirmations, ['lead-a', 'lead-b'])

    const first = await control.roomDecisionConfirm({
      roomId: 'room-cross',
      decisionId: decision.decisionId,
      confirmedBy: 'lead-a',
      rationale: 'API owner agrees.',
    }, { id: 'lead-a' })
    assert.equal(first.status, 'proposed')
    assert.deepEqual(first.missingConfirmations, ['lead-b'])

    const second = await control.roomDecisionConfirm({
      roomId: 'room-cross',
      decisionId: decision.decisionId,
      confirmedBy: 'lead-b',
      rationale: 'Persistence owner agrees.',
    }, { id: 'lead-b' })
    assert.equal(second.status, 'confirmed')
    assert.deepEqual(second.missingConfirmations, [])
    assert.equal(second.confirmations.length, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('single-confirmer room decisions do not project a stale missing confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-room-single-confirm-'))
  try {
    const control = controlPlaneFor('room-single-confirm-' + Date.now(), { directory })
    await control.roomOpen({
      roomId: 'room-single',
      kind: 'task',
      host: 'lead-a',
      members: ['lead-a'],
    })
    const decision = await control.roomDecision({
      roomId: 'room-single',
      title: 'Local contract',
      choice: 'Use v1',
      rationale: 'Only one affected lead.',
      decidedBy: 'lead-a',
      requiredConfirmations: ['lead-a'],
    }, { id: 'lead-a' })
    assert.equal(decision.status, 'confirmed')
    assert.deepEqual(decision.missingConfirmations, [])
    assert.equal(decision.confirmations.length, 1)
    assert.equal(decision.confirmations[0].member, 'lead-a')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
