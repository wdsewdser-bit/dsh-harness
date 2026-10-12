#!/usr/bin/env node
/** Room snapshot v2: latest-round summary, open-only unresolved, semantic dedupe. */
import { compactRoomSnapshot } from '../home/profiles/web/plugins/team-tools-v2-r3.mjs'
import { latestClosedRound, roomActivity } from '../home/profiles/web/plugins/team-control-plane.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + String(detail)))
}

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

check('latestClosedRound returns the newest closed round', latestClosedRound(state, roomId)?.roundId === 'r2')
check('roomActivity treats open unresolved as blocked', roomActivity(state, room) === 'blocked')

const snapshot = compactRoomSnapshot(state, roomId, 'm1', 3)
check('snapshot uses the latest closed round summary', snapshot.summary === 'latest summary', snapshot.summary)
check('resolved unresolved items do not enter the injected snapshot',
  snapshot.unresolved.length === 1 && snapshot.unresolved[0].id === 'u2', JSON.stringify(snapshot.unresolved))
check('snapshot includes a bounded recent message tail',
  snapshot.recentMessages.length === 3 && snapshot.recentMessages.at(-1).messageId === 'm3',
  JSON.stringify(snapshot.recentMessages))
check('snapshot exposes the latest closed round',
  snapshot.latestClosedRound?.roundId === 'r2', JSON.stringify(snapshot.latestClosedRound))
check('snapshot exposes activity', snapshot.activity === 'blocked', snapshot.activity)

const revisionOnly = compactRoomSnapshot({
  ...state,
  rooms: { [roomId]: { ...room, revision: 9999 } },
}, roomId, 'm1', 3)
check('notice-only revision changes do not create a new snapshot id',
  revisionOnly.snapshotId === snapshot.snapshotId,
  snapshot.snapshotId + ' != ' + revisionOnly.snapshotId)

const changed = compactRoomSnapshot({
  ...state,
  rooms: {
    [roomId]: {
      ...room,
      messages: [...room.messages, { messageId: 'm4', roundId: null, author: 'lead', kind: 'notice', content: 'newer', createdAt: 40, turn: false }],
    },
  },
}, roomId, 'm1', 3)
check('a new recent message creates a new snapshot id', changed.snapshotId !== snapshot.snapshotId)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
