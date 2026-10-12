import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acknowledgeInboxEntry,
  acknowledgePendingDispatchMessage,
  pendingDispatchInboxRows,
  waitingResolveDerivedGuard,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { handleWakeBatch } from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import {
  deriveWaitingTickets,
  providerWaitingActive,
  recordWaiting,
  waitingTicketActive,
} from '../home/profiles/web/plugins/team-v14-waiting.mjs'

const task = (overrides = {}) => ({
  id: 't',
  status: 'pending',
  lifecycle: 'approved',
  ownerName: 'member',
  revision: 1,
  contract: { acceptanceCriteria: ['done'] },
  ...overrides,
})

test('B-108: ack retires both durable inbox and dispatch-pending carriers', () => {
  const dispatch = {
    dispatchId: 'wake:member:packet-1',
    sender: 'lead',
    target: 'member',
    status: 'completed',
    createdAt: 100,
    resolvedAt: 150,
    pendingMessages: [{
      messageId: 'packet-1',
      messageHash: 'hash-1',
      text: 'Handle the exact packet.',
      status: 'delivered',
      createdAt: 100,
    }],
  }
  const state = {
    dispatches: { [dispatch.dispatchId]: dispatch },
    wakeEpisodes: {
      episode: {
        episodeId: 'episode',
        dispatchId: dispatch.dispatchId,
        status: 'queued',
        redeliveryRequired: true,
        pendingMessages: dispatch.pendingMessages,
      },
    },
    v12RoomWake: {
      inbox: {
        'packet-1': {
          messageId: 'packet-1',
          target: 'member',
          status: 'delivered',
          injectionReceipt: 'receipt-1',
          wakeIds: [],
        },
      },
      wakes: {},
    },
  }

  const ack = acknowledgeInboxEntry(state, {
    target: 'member',
    inboxId: 'packet-1',
    at: 200,
  })

  assert.equal(ack.ok, true)
  assert.equal(ack.cleared, true)
  assert.equal(ack.pendingRetired, true)
  assert.equal(ack.durableHandled, true)
  assert.equal(state.v12RoomWake.inbox['packet-1'].status, 'handled')
  assert.equal(dispatch.pendingMessages[0].status, 'handled')
  assert.equal(pendingDispatchInboxRows(state.dispatches, 'member').length, 0)
  assert.equal(state.wakeEpisodes.episode.status, 'completed')
  assert.equal(state.wakeEpisodes.episode.redeliveryRequired, false)
  assert.equal(state.wakeEpisodes.episode.pendingMessages[0].status, 'handled')
})

test('B-108: a permanent queued dispatch row has an explicit clear path', () => {
  const dispatch = {
    dispatchId: 'wake:member:packet-2',
    sender: 'lead',
    target: 'member',
    status: 'timed-out',
    createdAt: 100,
    resolvedAt: 300,
    pendingMessages: [{
      messageId: 'packet-2',
      messageHash: 'hash-2',
      text: 'Previously queued payload.',
      status: 'delivery-failed',
      createdAt: 100,
    }],
  }
  const state = { dispatches: { [dispatch.dispatchId]: dispatch } }

  const ack = acknowledgeInboxEntry(state, {
    target: 'member',
    inboxId: 'packet-2',
    at: 400,
  })

  assert.equal(ack.ok, true)
  assert.equal(ack.cleared, true)
  assert.equal(ack.pendingRetired, true)
  assert.equal(dispatch.pendingMessages[0].status, 'handled')
  assert.equal(pendingDispatchInboxRows(state.dispatches, 'member').length, 0)
})

test('B-108: repeated dispatch acknowledgement is idempotent and visible as cleared', () => {
  const dispatch = {
    dispatchId: 'wake:member:packet-3',
    target: 'member',
    status: 'completed',
    pendingMessages: [{ messageId: 'packet-3', status: 'handled', createdAt: 1 }],
  }
  const state = { dispatches: { [dispatch.dispatchId]: dispatch } }
  const ack = acknowledgePendingDispatchMessage(state, { target: 'member', inboxId: 'packet-3', at: 2 })
  assert.equal(ack.ok, true)
  assert.equal(ack.cleared, true)
  assert.equal(ack.pendingRetired, true)
})

test('B-108: wake-level ack clears queued redelivery state after all messages handled', () => {
  const state = {
    inbox: {
      'packet-wake': {
        messageId: 'packet-wake',
        target: 'member',
        status: 'delivered',
        wakeIds: ['wake-1'],
      },
    },
    wakes: {
      'wake-1': {
        wakeId: 'wake-1',
        target: 'member',
        status: 'queued',
        messageIds: ['packet-wake'],
        redeliveryRequired: true,
      },
    },
  }
  const verdict = handleWakeBatch(state, 'wake-1')
  assert.equal(verdict.ok, true)
  assert.equal(state.wakes['wake-1'].status, 'handled')
  assert.equal(state.wakes['wake-1'].redeliveryRequired, false)
})

test('B-108: inbox acknowledgement cannot cross member scope', () => {
  const state = {
    dispatches: {
      'wake:other:packet-4': {
        dispatchId: 'wake:other:packet-4',
        target: 'other',
        status: 'queued',
        pendingMessages: [{ messageId: 'packet-4', status: 'queued', createdAt: 1 }],
      },
    },
    v12RoomWake: {
      inbox: {
        'packet-4': { messageId: 'packet-4', target: 'other', status: 'delivered' },
      },
      wakes: {},
    },
  }
  const ack = acknowledgeInboxEntry(state, {
    target: 'member',
    inboxId: 'packet-4',
    at: 2,
  })
  assert.equal(ack.ok, false)
  assert.equal(ack.reason, 'inbox-ack-scope')
  assert.equal(state.v12RoomWake.inbox['packet-4'].status, 'delivered')
  assert.equal(state.dispatches['wake:other:packet-4'].pendingMessages[0].status, 'queued')
})

test('B-109: provider waits require a real recorded provider failure', () => {
  const base = {
    boards: { main: { tasks: { t: task() } } },
    provider: { status: 'blocked', lastFailure: null },
    health: { status: 'disabled', reasons: ['unrelated health condition'] },
  }
  assert.equal(providerWaitingActive(base), false)
  assert.equal(deriveWaitingTickets(base, [{ name: 'member', status: 'running' }], 100)
    .some((row) => row.reason === 'waiting-provider'), false)

  const realFailure = {
    ...base,
    provider: {
      status: 'blocked',
      lastFailure: { category: 'quota', summary: 'quota exhausted', createdAt: 50 },
    },
  }
  assert.equal(providerWaitingActive(realFailure), true)
  const rows = deriveWaitingTickets(realFailure, [{ name: 'member', status: 'idle' }], 100)
  const providerRow = rows.find((row) => row.reason === 'waiting-provider')
  assert.ok(providerRow)
  assert.equal(providerRow.derivedFrom, 'provider')
  assert.equal(providerRow.providerLastFailure.category, 'quota')

  const resumed = {
    ...base,
    provider: { status: 'unknown', lastFailure: null },
    health: { status: 'disabled', reasons: ['unrelated health condition'] },
  }
  assert.equal(providerWaitingActive(resumed), false)
  assert.equal(deriveWaitingTickets(resumed, [{ name: 'member', status: 'running' }], 100)
    .some((row) => row.reason === 'waiting-provider'), false)

  const explicit = {
    ...base,
    v14Waiting: { tickets: {} },
  }
  const ticket = recordWaiting(explicit, {
    taskId: 't',
    owner: 'member',
    reason: 'provider',
    unblockCondition: { type: 'provider-healthy' },
  }, 'lead', { now: 60 })
  assert.equal(waitingTicketActive(ticket, explicit, 100), false)
  explicit.provider.lastFailure = { category: 'network', summary: 'offline', createdAt: 90 }
  assert.equal(waitingTicketActive(ticket, explicit, 100), true)
})

test('B-109: fuzzy resolve refuses an active derived row instead of hitting an old ticket', () => {
  const state = {
    boards: { main: { tasks: { t: task() } } },
    provider: {
      status: 'blocked',
      lastFailure: { category: 'network', summary: 'provider unavailable', createdAt: 50 },
    },
    health: { status: 'disabled', reasons: ['provider failure [network]'] },
    v14Waiting: {
      tickets: {
        old: {
          ticketId: 'old',
          taskId: 't',
          owner: 'member',
          waiter: 'lead',
          responsible: 'member',
          status: 'resolved',
          reason: 'dependency',
        },
      },
    },
  }
  const guard = waitingResolveDerivedGuard(state, {
    taskId: 't',
    owner: 'member',
    waiter: 'lead',
    responsible: 'member',
    members: [{ name: 'member', status: 'idle' }],
    now: 100,
  })
  assert.equal(guard.ok, false)
  assert.equal(guard.code, 'derived-ticket-not-resolvable')
  assert.equal(guard.candidates[0].reason, 'waiting-provider')
})
