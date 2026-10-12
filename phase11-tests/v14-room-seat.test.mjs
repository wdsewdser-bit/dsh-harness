import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roomSeatVerdict } from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { controlPlaneFor } from '../home/profiles/web/plugins/team-control-plane.mjs'

test('room seat rules keep unseatable members out of level and root rooms', () => {
  assert.equal(roomSeatVerdict('level:1', 'level', { name: 'alpha-m1', tier: 2, group: 'alpha' }).ok, false)
  assert.equal(roomSeatVerdict('level:1', 'level', { name: 'lead-alpha', tier: 1, group: 'alpha' }).ok, true)
  assert.equal(roomSeatVerdict('level:1', 'level', { name: 'lead', tier: 0 }).ok, true)
  assert.equal(roomSeatVerdict('root', 'root', { name: 'beta-m1', tier: 2, group: 'beta' }).ok, false)
  assert.equal(roomSeatVerdict('group:alpha:tier-2', 'group', { name: 'alpha-m1', tier: 2, group: 'alpha' }).ok, true)
  assert.equal(roomSeatVerdict('group:alpha:tier-2', 'group', { name: 'beta-m1', tier: 2, group: 'beta' }).ok, false)
})

test('forced close waives an unseatable missing speaker only when the caller proves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-room-seat-'))
  try {
    const cp = controlPlaneFor('root-seat', { directory: dir })
    await cp.roomOpen({ roomId: 'level:1', kind: 'level', host: 'lead', members: ['lead', 'lead-alpha', 'alpha-m1'] }, { name: 'lead', tier: 0 })
    await cp.roomNext({ roomId: 'level:1', topic: 't', members: ['lead-alpha', 'alpha-m1', 'lead'] }, { name: 'lead', tier: 0 })
    await cp.roomPost({ roomId: 'level:1', author: 'lead-alpha', content: 'main' }, { name: 'lead-alpha', tier: 1 })
    await assert.rejects(
      () => cp.roomClose({ roomId: 'level:1', summary: 's' }, { name: 'lead', tier: 0 }),
      /cannot close before every participant/,
    )
    await assert.rejects(
      () => cp.roomClose({ roomId: 'level:1', summary: 's', forceClose: true, forceCloseReason: 'x', waivedMembers: ['alpha-m1'] }, { name: 'lead', tier: 0 }),
      /cannot waive active participants|invalid waivers/,
    )
    const closed = await cp.roomClose({
      roomId: 'level:1',
      summary: 's',
      forceClose: true,
      forceCloseReason: 'unseatable tier-2 speaker',
      waivedMembers: ['alpha-m1', 'lead'],
      waivableMembers: ['alpha-m1', 'lead'],
    }, { name: 'lead', tier: 0 })
    assert.equal(closed.round.status, 'closed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('frozen next speaker is skipped so the host can finish and force-close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-room-frozen-speaker-'))
  try {
    const cp = controlPlaneFor('root-frozen-speaker', { directory: dir })
    await cp.roomOpen({ roomId: 'task:g-boot-wake-3', kind: 'task', host: 'lead', members: ['lead', 'lead-boot2'] }, { name: 'lead', tier: 0 })
    await cp.roomNext({ roomId: 'task:g-boot-wake-3', topic: 't', members: ['lead-boot2', 'lead'] }, { name: 'lead', tier: 0 })
    await cp.frozenSet({ member: 'lead-boot2', frozen: true }, { name: 'lead', tier: 0 })

    const posted = await cp.roomPost({
      roomId: 'task:g-boot-wake-3',
      author: 'lead',
      content: 'host main speech after frozen speaker',
    }, { name: 'lead', tier: 0 })
    assert.equal(posted.author, 'lead')
    const roundId = cp.snapshot().rooms['task:g-boot-wake-3'].currentRoundId
    assert.equal(cp.snapshot().rounds[roundId].nextSpeaker, null)

    const closed = await cp.roomClose({
      roomId: 'task:g-boot-wake-3',
      summary: 'closed after frozen speaker was skipped',
      forceClose: true,
      forceCloseReason: 'lead-boot2 was frozen before its turn',
      waivedMembers: ['lead-boot2'],
      waivableMembers: ['lead-boot2'],
      forceClosedBy: 'lead',
    }, { name: 'lead', tier: 0 })
    assert.equal(closed.round.status, 'closed')
    assert.deepEqual(closed.round.waivedMembers, ['lead-boot2'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
