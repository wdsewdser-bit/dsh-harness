import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createWakeState,
  deliverWakeBatch,
  handleInboxMessage,
  normalizeRoomWakeState,
  requestWake,
} from '../home/profiles/web/plugins/team-v12-room-wake.mjs'

test('B-221: acknowledged legacy wake rows stay handled across wake-state rehydration', () => {
  const state = createWakeState()
  const dedupeKey = 'wake:team-wake:lead:lead-rig:r68'
  const input = {
    target: 'lead-rig',
    sender: 'lead',
    dedupeKey,
    priority: 'normal',
    wakeup: true,
  }
  const first = requestWake(state, {
    ...input,
    messageId: 'msg-acked',
    originalText: 'already handled',
  })
  assert.equal(first.ok, true)
  const second = requestWake(state, {
    ...input,
    messageId: 'msg-open',
    originalText: 'still open',
  })
  assert.equal(second.ok, true)
  assert.equal(second.wake.wakeId, first.wake.wakeId)

  const delivered = deliverWakeBatch(state, first.wake.wakeId, { updatedAt: 2 })
  assert.equal(delivered.ok, true)
  assert.equal(delivered.status, 'delivered')

  const handled = handleInboxMessage(state, 'msg-acked', { updatedAt: 3 })
  assert.equal(handled.ok, true)
  assert.equal(state.inbox['msg-acked'].status, 'handled')
  assert.equal(state.wakes[first.wake.wakeId].status, 'delivered')

  delete state.inbox['msg-acked']
  normalizeRoomWakeState(state)

  assert.equal(state.acknowledgedInbox['msg-acked'].status, 'handled')
  assert.equal(state.inbox['msg-acked']?.status, 'handled')
  assert.equal(state.inbox['msg-open']?.status, 'delivered')
  assert.equal(state.wakes[first.wake.wakeId].status, 'delivered')
})
