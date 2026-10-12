#!/usr/bin/env node
/** Only actionable Room snapshots may override a system wake with waitAction=stop. */
import assert from 'node:assert/strict'
import { compactRoomSnapshot, shouldInjectRoomSnapshot } from '../home/profiles/web/plugins/team-tools-v2-r7.mjs'

const roomId = 'group:test:tier-2'
const baseRoom = {
  roomId,
  kind: 'group',
  status: 'open',
  host: 'lead',
  members: ['lead', 'm1'],
  currentRoundId: null,
  revision: 1,
  summary: '',
  messages: [
    { messageId: 'm1', roundId: null, author: 'm1', kind: 'notice', content: 'recent chatter', createdAt: 10, turn: false },
  ],
  decisions: [],
  unresolved: [],
}
const baseState = { rooms: { [roomId]: baseRoom }, rounds: {}, escalations: {} }

const closed = compactRoomSnapshot(baseState, roomId, 'lead', 3)
assert.equal(closed.waitAction, 'stop')
assert.equal(shouldInjectRoomSnapshot(closed), false, 'recent messages in an idle room must not inject stop')

const openState = {
  ...baseState,
  rooms: { [roomId]: { ...baseRoom, currentRoundId: 'r1' } },
  rounds: {
    r1: { roundId: 'r1', roomId, topic: 'open', status: 'open', nextSpeaker: 'm1', order: ['m1'], mainSpoken: [] },
  },
}
const open = compactRoomSnapshot(openState, roomId, 'lead', 3)
assert.equal(open.waitAction, 'stop')
assert.equal(shouldInjectRoomSnapshot(open), true, 'an open round is actionable')

const unresolvedState = {
  ...baseState,
  rooms: { [roomId]: { ...baseRoom, unresolved: [{ id: 'u1', text: 'needs action', status: 'open' }] } },
}
assert.equal(shouldInjectRoomSnapshot(compactRoomSnapshot(unresolvedState, roomId, 'lead', 3)), true, 'an open unresolved item is actionable')

console.log('PASS closed Room chatter does not override team-idle wake')
