import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  identityRoleFile,
  identitySource,
} from '../home/profiles/web/plugins/team-v14-context-delivery.mjs'
import {
  authorizeWaitingAction,
  selectTaskOccurrence,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import {
  VERIFIER_ISSUE_SEVERITIES,
  infoDeliveryReceiptStatus,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { handleInboxMessage } from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import { clearanceGate } from '../home/profiles/web/plugins/team-worktree.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

test('B-99: tier identity mapping is explicit and unknown tiers fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b99-'))
  try {
    const files = {
      'AGENTS.md': 'shared rules\n',
      'root.md': 'root operational identity\n',
      'lead.md': 'tier 1 group lead identity\n',
      'member.md': 'tier 2 member identity\n',
    }
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
    writeFileSync(join(root, 'identity-version.json'), JSON.stringify({
      identityVersion: 'b99-test',
      files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, digest(body)])),
    }))

    const lead = identitySource(root, { name: 'lead-proto', tier: 1, role: 'lead', group: 'proto' })
    assert.equal(lead.metadata.roleFile, 'lead.md')
    assert.match(lead.content, /tier 1 group lead identity/)
    assert.doesNotMatch(lead.content, /tier 2 member identity/)

    assert.equal(identityRoleFile({ name: 'root', tier: 0 }), 'root.md')
    assert.equal(identityRoleFile({ name: 'member', tier: 2 }), 'member.md')
    assert.throws(
      () => identityRoleFile({ name: 'unknown', tier: undefined }),
      /identity role unresolved/,
    )
    assert.throws(
      () => identityRoleFile({ name: 'lead-proto', tier: 1 }, { roleFiles: { 1: 'member.md' } }),
      /identity role mapping mismatch/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-100: waiting resolves the real group card instead of its global projection', () => {
  const task = {
    id: 'group-proto-t61',
    board: 'group-proto',
    ownerName: 'proto-member',
  }
  const snapshot = {
    boards: {
      global: { tasks: { 'group-proto-t61': { ...task, board: undefined } } },
      'group-proto': { tasks: { 'group-proto-t61': task } },
    },
  }
  const actor = { name: 'lead-proto', tier: 1, group: 'proto' }
  assert.deepEqual(selectTaskOccurrence(snapshot, task.id, '', actor), {
    ok: true,
    task,
    boardId: 'group-proto',
    requestedBoard: null,
  })
  assert.deepEqual(selectTaskOccurrence(snapshot, task.id, 'group', actor), {
    ok: true,
    task,
    boardId: 'group-proto',
    requestedBoard: 'group-proto',
  })
  assert.equal(selectTaskOccurrence(snapshot, task.id, 'group-world', actor).code, 'waiting-board-not-found')

  assert.equal(authorizeWaitingAction({
    tier: 1,
    memberName: actor.name,
    group: actor.group,
    taskOwner: task.ownerName,
    taskBoard: 'group-proto',
    ownerGroup: actor.group,
    canWriteBoard: (_name, board) => board === 'group-proto',
  }).ok, true)

  const denied = authorizeWaitingAction({
    tier: 1,
    memberName: actor.name,
    group: actor.group,
    taskOwner: task.ownerName,
    taskBoard: 'global',
    ownerGroup: actor.group,
    canWriteBoard: (_name, board) => board === 'group-proto',
  })
  assert.equal(denied.code, 'waiting-scope')
  assert.match(denied.detail, /taskBoard="global"/)
})

test('B-101: an upward info receipt reports direct delivery truthfully', () => {
  assert.equal(infoDeliveryReceiptStatus(true), 'delivered')
  assert.equal(infoDeliveryReceiptStatus(false), 'queued')
})

test('B-102: condition is a non-blocking verifier severity', () => {
  assert.deepEqual(VERIFIER_ISSUE_SEVERITIES, ['blocker', 'major', 'condition', 'minor', 'nit'])
  assert.equal(clearanceGate({ commit: 'abc123', severity: 'condition' }, 'abc123').ok, true)
  assert.equal(clearanceGate({ commit: 'abc123', severity: 'major' }, 'abc123').ok, false)
  assert.equal(clearanceGate({ commit: 'abc123', severity: 'blocker' }, 'abc123').ok, false)
})

test('B-103: delivered inbox rows with no wake ids remain individually ackable', () => {
  const delivered = handleInboxMessage({
    inbox: {
      'msg-info': {
        messageId: 'msg-info',
        target: 'verifier',
        status: 'delivered',
        wakeIds: [],
      },
    },
  }, 'msg-info')
  assert.equal(delivered.ok, true)
  assert.equal(delivered.status, 'handled')
  assert.equal(delivered.handled, true)

  const queued = handleInboxMessage({
    inbox: {
      'msg-queued': {
        messageId: 'msg-queued',
        target: 'verifier',
        status: 'queued',
        wakeIds: [],
      },
    },
  }, 'msg-queued')
  assert.equal(queued.ok, false)
  assert.equal(queued.reason, 'message-not-delivered')
  assert.equal(queued.status, 'queued')

  const missing = handleInboxMessage({ inbox: {} }, 'msg-missing')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'inbox-not-found')
})
