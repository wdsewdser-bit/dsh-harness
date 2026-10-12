import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveWaitingTickets,
  normalizeWaitingCondition,
  reconcileWaitingTickets,
  recordWaiting,
  resolveWaiting,
  waitingHealth,
  waitingTicketActive,
  waitingTimeOf,
} from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import { continuationCandidates } from '../home/profiles/web/plugins/team-v14-event-continuation.mjs'

const task = (overrides = {}) => ({ id: 't', status: 'pending', lifecycle: 'approved', ownerName: 'm', revision: 2, contract: { acceptanceCriteria: ['done'] }, ...overrides })

test('waiting record keeps distinct tickets per request, bounds TTL, and resolves', () => {
  const state = { boards: { main: { tasks: { t: task() } } } }
  const first = recordWaiting(state, { taskId: 't', owner: 'm', reason: 'manual', ttlMs: 99 * 24 * 60 * 60 * 1000 }, 'lead', { now: 100 })
  const second = recordWaiting(state, { taskId: 't', owner: 'm', reason: 'manual-updated', nextCheckAt: 200 }, 'lead', { now: 150 })
  assert.notEqual(first.ticketId, second.ticketId)
  assert.equal(Object.keys(state.v14Waiting.tickets).length, 2)
  assert.equal(second.taskRevision, 2)
  assert.ok(second.expiresAt <= second.createdAt + 24 * 60 * 60 * 1000)
  assert.equal(resolveWaiting(state, { taskId: 't', owner: 'm', ticketId: first.ticketId, resolution: 'operator resumed' }, 'lead', { now: 250 }).status, 'resolved')
  assert.equal(waitingTicketActive(first, state, 250), false)
  assert.equal(waitingTicketActive(second, state, 250), true)
})

test('waiting tickets automatically clear when revision or unblock condition changes', () => {
  const state = { boards: { main: { tasks: { dep: task({ id: 'dep', status: 'pending', phase: 'accepted' }), t: task({ blockedBy: ['dep'] }) } } } }
  const ticket = recordWaiting(state, { taskId: 't', owner: 'm', reason: 'dependency', unblockCondition: { type: 'dependency', taskIds: ['dep'] } }, 'lead', { now: 100 })
  assert.equal(waitingTicketActive(ticket, state, 101), true)
  state.boards.main.tasks.dep.status = 'completed'
  assert.equal(waitingTicketActive(ticket, state, 101), false)
  const revisionTicket = recordWaiting(state, { taskId: 't', owner: 'm', reason: 'manual' }, 'lead', { now: 100 })
  state.boards.main.tasks.t.revision = 3
  assert.equal(waitingTicketActive(revisionTicket, state, 101), true)
  assert.equal(waitingTicketActive({ ...revisionTicket, reason: 'dependency', unblockCondition: { type: 'dependency', taskIds: ['dep'] } }, state, 101), false)
})

test('derived waiting rows identify dependency, lease, room and frozen responsibility', () => {
  const state = { boards: { main: { tasks: {
    dep: task({ id: 'dep', status: 'pending' }),
    t: task({ blockedBy: ['dep'], roomId: 'task:t' }),
  } } }, leases: { run: { member: 'm', taskId: 't', status: 'active' } },
  rooms: { 'task:t': { currentRoundId: 'r', status: 'open' } }, rounds: { r: { status: 'open' } }, frozenMembers: { m: { frozen: true } } }
  const rows = deriveWaitingTickets(state, [{ name: 'm', status: 'frozen', frozen: true }], 100)
  assert.deepEqual(new Set(rows.map((row) => row.reason)), new Set(['waiting-dependency', 'waiting-lease', 'waiting-frozen', 'waiting-room']))
})

test('continuation respects an open manual ticket and resumes after resolve', () => {
  const state = { boards: { main: { tasks: { t: task() } } }, leases: {}, v14Waiting: { tickets: {} } }
  recordWaiting(state, { taskId: 't', owner: 'm', reason: 'manual' }, 'lead', { now: 100 })
  const members = [{ name: 'm', status: 'idle' }]
  assert.deepEqual(continuationCandidates(state, members, 101), [])
  resolveWaiting(state, { taskId: 't', owner: 'm' }, 'lead', { now: 102 })
  assert.equal(continuationCandidates(state, members, 103)[0].id, 't')
})

test('expired manual tickets and missing rooms remain blocked until explicit facts resolve them', () => {
  const state = { boards: { main: { tasks: { t: task({ phase: 'room-discussion' }) } } }, rooms: {}, rounds: {} }
  const manual = recordWaiting(state, { taskId: 't', owner: 'm', reason: 'manual', ttlMs: 1 }, 'lead', { now: 100 })
  assert.equal(waitingTicketActive(manual, state, 10_000), true)
  resolveWaiting(state, { taskId: 't', owner: 'm' }, 'lead', { now: 101 })
  const room = { ...recordWaiting(state, { taskId: 't', owner: 'm', reason: 'room', ttlMs: 1000, unblockCondition: { type: 'room-closed', roomId: 'missing' } }, 'lead', { now: 100 }), taskId: 't', owner: 'm' }
  assert.equal(waitingTicketActive(room, state, 101), true)
})

test('waiting conditions accept prompt aliases and reject malformed input', () => {
  assert.equal(normalizeWaitingCondition({ type: 'room', roomId: 'r1' }).type, 'room-closed')
  assert.equal(normalizeWaitingCondition({ type: 'provider' }).type, 'provider-healthy')
  assert.equal(normalizeWaitingCondition({ type: 'manual-resolve' }).type, 'manual')
  assert.equal(normalizeWaitingCondition({ type: 'approval-granted' }).type, 'approval')
  assert.throws(() => normalizeWaitingCondition({ type: 'not-a-condition' }), /unknown waiting condition/)
  assert.throws(() => normalizeWaitingCondition({ type: 'dependency', taskIds: [] }), /requires taskIds/)
  assert.throws(() => normalizeWaitingCondition('dependency'), /must be an object/)
})

test('waiting times accept ISO-8601 and reject invalid strings', () => {
  assert.equal(waitingTimeOf('2026-09-25T20:00:00+08:00', 0), Date.parse('2026-09-25T20:00:00+08:00'))
  assert.equal(waitingTimeOf(1234, 0), 1234)
  assert.throws(() => waitingTimeOf('not-a-time', 0), /invalid waiting time/)
})

test('approval waits auto-close after plan-approved and ignore unrelated revisions', () => {
  const state = {
    boards: { main: { tasks: { t: task() } } },
    plans: { t: { taskId: 't', state: 'plan-proposed' } },
  }
  const ticket = recordWaiting(state, {
    taskId: 't', owner: 'm', reason: 'approval', unblockCondition: { type: 'approval' },
  }, 'lead', { now: 100 })
  state.boards.main.tasks.t.revision = 3
  assert.equal(waitingTicketActive(ticket, state, 101), true)
  state.plans.t.state = 'plan-approved'
  assert.equal(waitingTicketActive(ticket, state, 102), false)
  const reconciled = reconcileWaitingTickets(state, { now: 102 })
  assert.equal(reconciled.stale, 1)
  assert.equal(ticket.status, 'resolved')
  assert.equal(ticket.resolution, 'auto:plan-approved')
  assert.equal(state.v14Waiting.health.lastReconcile.stale, 1)
})

test('reconciliation preserves structured terminal waits, deduplicates responsibility, and exposes stale counts', () => {
  const state = { boards: { main: { tasks: {
    t: task(),
    done: task({ id: 'done', status: 'completed' }),
  } } } }
  recordWaiting(state, {
    ticketId: 'legacy-a', taskId: 't', owner: 'm', responsible: 'lead',
    reason: 'manual', unblockCondition: { type: 'manual' },
  }, 'm', { now: 100 })
  recordWaiting(state, {
    ticketId: 'legacy-b', taskId: 't', owner: 'm', responsible: 'lead',
    reason: 'manual', unblockCondition: { type: 'manual' },
  }, 'm', { now: 110 })
  recordWaiting(state, {
    taskId: 'done', owner: 'm', reason: 'manual', unblockCondition: { type: 'manual' },
  }, 'm', { now: 120 })
  const before = waitingHealth(state, 200)
  assert.equal(before.stale, 0)
  assert.equal(before.duplicate, 1)
  const reconciled = reconcileWaitingTickets(state, { now: 200 })
  assert.equal(reconciled.resolved, 0)
  assert.equal(reconciled.deduped, 1)
  assert.equal(state.v14Waiting.tickets['legacy-a'].supersededBy, 'legacy-b')
  assert.equal(state.v14Waiting.health.open, 2)
  assert.equal(state.v14Waiting.health.active, 2)
})
