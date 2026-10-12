#!/usr/bin/env node
/** Room snapshot v2 parity: the headless profile must match the web contract. */
import assert from 'node:assert/strict'
import { compactRoomSnapshot as compactWeb } from '../home/profiles/web/plugins/team-tools-v2-r3.mjs'
import { latestClosedRound as latestWeb, roomActivity as activityWeb } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { compactRoomSnapshot as compactHeadless } from '../home/profiles/headless/plugins/team-tools-v2.mjs'
import { latestClosedRound as latestHeadless, roomActivity as activityHeadless } from '../home/profiles/headless/plugins/team-control-plane.mjs'

const roomId = 'group:test:tier-2'
const room = {
  roomId,
  kind: 'group',
  status: 'open',
  host: 'lead',
  members: ['lead', 'm1'],
  currentRoundId: null,
  revision: 9,
  summary: 'stale first-round summary',
  latestRoundId: 'r2',
  latestSummary: { roundId: 'r2', text: 'latest summary', closedAt: 220 },
  messages: [
    { messageId: 'm1', roundId: 'r1', author: 'm1', kind: 'proposal', content: 'old', createdAt: 10, turn: true },
    { messageId: 'm2', roundId: 'r2', author: 'm1', kind: 'proposal', content: 'latest proposal', createdAt: 20, turn: true },
    { messageId: 'm3', roundId: null, author: 'lead', kind: 'notice', content: 'latest notice', createdAt: 30, turn: false },
  ],
  decisions: [{ decisionId: 'd1', title: 'api', choice: 'v1' }],
  unresolved: [
    { id: 'u1', text: 'old resolved', status: 'resolved', resolution: 'done' },
    { id: 'u2', text: 'open item', status: 'open' },
  ],
}
const state = {
  rooms: { [roomId]: room },
  rounds: {
    r1: { roundId: 'r1', roomId, topic: 'first', status: 'closed', summary: 'first summary', closedAt: 100, order: ['m1'], mainSpoken: ['m1'] },
    r2: { roundId: 'r2', roomId, topic: 'second', status: 'closed', summary: 'latest summary', closedAt: 200, order: ['m1'], mainSpoken: ['m1'] },
  },
  escalations: {},
}

for (const [label, compact, latest, activity] of [
  ['web', compactWeb, latestWeb, activityWeb],
  ['headless', compactHeadless, latestHeadless, activityHeadless],
]) {
  assert.equal(latest(state, roomId)?.roundId, 'r2', label + ': latest closed round')
  assert.equal(activity(state, room), 'blocked', label + ': activity')

  const snapshot = compact(state, roomId, 'm1', 3)
  assert.equal(snapshot.summary, 'latest summary', label + ': summary')
  assert.deepEqual(snapshot.unresolved.map((item) => item.id), ['u2'], label + ': open unresolved')
  assert.equal(snapshot.recentMessages.length, 3, label + ': recent message count')
  assert.equal(snapshot.recentMessages.at(-1).messageId, 'm3', label + ': recent message tail')
  assert.equal(snapshot.latestClosedRound?.roundId, 'r2', label + ': latest closed round projection')
  assert.equal(snapshot.activity, 'blocked', label + ': projected activity')

  const revisionOnly = compact({
    ...state,
    rooms: { [roomId]: { ...room, revision: 9999 } },
  }, roomId, 'm1', 3)
  assert.equal(revisionOnly.snapshotId, snapshot.snapshotId, label + ': semantic dedupe')

  const changed = compact({
    ...state,
    rooms: {
      [roomId]: {
        ...room,
        messages: [...room.messages, { messageId: 'm4', roundId: null, author: 'lead', kind: 'notice', content: 'newer', createdAt: 40, turn: false }],
      },
    },
  }, roomId, 'm1', 3)
  assert.notEqual(changed.snapshotId, snapshot.snapshotId, label + ': new message changes snapshot id')
}

console.log('PASS room snapshot v2 web/headless parity')
