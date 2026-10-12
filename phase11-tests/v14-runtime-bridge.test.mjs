import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply, authorizeRequirementRecord, authorizeWaitingAction } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { controlPlaneFor, controlPlaneForMember, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { createWakeState, enqueueInboxMessage, requestWake } from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import { createRequirementLedger } from '../home/profiles/web/plugins/team-v14-requirements.mjs'

const tempDirs = []
afterEach(() => {
  resetControlPlaneCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness({ name = 'alice', tier = 2, teamId = 'team-v14', sessionId = name + '-session', config = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-v14-runtime-'))
  tempDirs.push(directory)
  const hooks = new Map()
  const tools = new Map()
  const messages = []
  const member = { id: name, name, tier, role: tier === 0 ? 'lead' : 'teammate' }
  const session = {
    id: sessionId,
    deriveMessages: () => messages.slice(),
    deriveEventMessage: (event) => event.message ?? event.data ?? event,
  }
  const agent = { id: name, name, session, status: 'idle' }
  const scoped = {
    systemPrompt: {
      section: () => () => {},
      getSectionOrder: () => 0,
    },
    tools: {
      register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
    },
    on: (event, callback) => {
      const rows = hooks.get(event) ?? []
      rows.push(callback)
      hooks.set(event, rows)
      return () => hooks.set(event, rows.filter((row) => row !== callback))
    },
  }
  agent.ctx = scoped
  const ctxHooks = new Map()
  const ctx = {
    agents: { list: () => [agent] },
    agentTeams: {
      tryMembership: () => ({ ...member, id: teamId }),
      listMembers: () => [member],
    },
    on: (event, callback) => { ctxHooks.set(event, callback); return () => ctxHooks.delete(event) },
    effect: () => {},
    logger: { warn: () => {} },
  }
  apply(ctx, { controlDir: directory, pluginDir: directory, profile: 'web', ...config })
  const cp = controlPlaneForMember(ctx, agent, { directory })
  assert.ok(cp, 'runtime should resolve the Team control plane')
  return { directory, ctx, agent, session, messages, hooks, tools, cp, member, teamId,
    hook: (event) => hooks.get(event)?.[0],
    seed: (type, fn) => cp.mutate(type, {}, agent, fn),
    teamTool: () => tools.get('team_v12'),
  }
}

function execFor(h, name, callId = name + '-call', extra = {}) {
  return { name, callId, rootCallId: extra.rootCallId ?? callId, arguments: extra.arguments ?? {}, agent: h.agent }
}

async function seedWake(h, { inbox = [], roomAccess = {} } = {}) {
  return h.seed('test/seed-room-wake', (state) => {
    const doc = createWakeState()
    doc.roomAccess = roomAccess
    for (const row of inbox) enqueueInboxMessage(doc, row)
    for (const row of inbox.filter((item) => item.wakeRequested)) requestWake(doc, row)
    state.v12RoomWake = doc
    return doc
  })
}

test('post hook mirrors result.value even when next blocks and persists a compact receipt', async () => {
  const h = harness()
  const before = h.cp.snapshot().revision
  const next = async () => ({ kind: 'block', feedback: 'downstream policy' })
  const result = { isError: false, value: { taskId: 'task-1', revision: 3 }, content: [] }
  const decision = await h.hook('tools/post-execute')(execFor(h, 'team_task_update', 'call-blocked'), result, next)
  assert.equal(decision.kind, 'block')
  const state = h.cp.snapshot()
  assert.ok(state.revision > before)
  const receipt = state.v14Receipts.find((row) => row.callId === 'call-blocked')
  assert.equal(receipt.ids.taskId, 'task-1')
  assert.equal(receipt.projectionBlocked, true)
  assert.equal(receipt.mirrorStatus, 'committed')
})

test('failed original result never creates a successful mirror', async () => {
  const h = harness()
  await h.hook('tools/post-execute')(execFor(h, 'send_message', 'call-failed', { arguments: { target: 'bob', message: 'do not mirror' } }),
    { isError: true, error: { message: 'official failure' }, value: { messageId: 'm-failed' }, content: [] },
    async () => ({ kind: 'accept' }))
  const state = h.cp.snapshot()
  assert.equal(state.v12RoomWake?.inbox?.['m-failed'], undefined)
  assert.equal(state.v14Receipts.find((row) => row.callId === 'call-failed')?.isError, true)
})

test('ordinary team_v12 read does not increment control-plane revision', async () => {
  const h = harness()
  const before = h.cp.snapshot().revision
  await h.hook('tools/post-execute')(execFor(h, 'team_v12', 'read-call', { arguments: { action: 'inbox_list' } }),
    { isError: false, value: { target: 'alice', inbox: [], wakes: [] }, content: [] }, async () => ({ kind: 'accept' }))
  assert.equal(h.cp.snapshot().revision, before)
})

test('room_snapshot and inbox_list enforce caller scope and filter inbox rows', async () => {
  const h = harness({ name: 'alice', tier: 2 })
  await seedWake(h, {
    roomAccess: { room1: { members: ['alice', 'bob'], host: 'alice' } },
    inbox: [
      { messageId: 'own', target: 'alice', sender: 'bob', originalText: 'own', wakeRequested: false },
      { messageId: 'other', target: 'bob', sender: 'alice', originalText: 'other', wakeRequested: false },
    ],
  })
  const tool = h.teamTool()
  await assert.rejects(() => tool.execute({ action: 'room_snapshot', room_id: 'room1', member: 'bob', input: {} }, { agent: h.agent }), /room-read-scope/)
  const own = await tool.execute({ action: 'inbox_list', input: {} }, { agent: h.agent })
  assert.deepEqual(own.inbox.map((row) => row.messageId), ['own'])
  await assert.rejects(() => tool.execute({ action: 'inbox_list', member: 'bob', input: {} }, { agent: h.agent }), /inbox-read-scope/)
})

test('task_contract_set rejects a stale revision after the locked recheck', async () => {
  const h = harness()
  await h.cp.boardCreate({ taskId: 'task-cas', subject: 'CAS task', ownerName: 'alice' }, h.agent)
  await h.seed('test-contract', (state) => {
    const task = state.boards.global.tasks['task-cas']
    task.ownerName = 'alice'
    task.contract = { taskId: 'task-cas', owner: 'alice', subject: 'CAS task', deliverable: 'x', acceptanceCriteria: ['x'], writeScopes: ['src'], risk: { level: 'medium', rationale: 'test' } }
    return task
  })
  const tool = h.teamTool()
  const cp = h.cp
  const mutate = cp.mutate
  let raced = false
  cp.mutate = async (...args) => {
    if (!raced && args[0] === 'v12/task-contract') {
      raced = true
      await mutate.call(cp, 'test-race-owner', {}, h.agent, (state) => {
        state.boards.global.tasks['task-cas'].ownerName = 'bob'
        state.boards.global.tasks['task-cas'].revision += 1
      })
    }
    return mutate.apply(cp, args)
  }
  try {
    await assert.rejects(() => tool.execute({ action: 'task_contract_set', task_id: 'task-cas', input: {
      expected_revision: 2, owner: 'alice', subject: 'CAS task', deliverable: 'x', acceptanceCriteria: ['x'], writeScopes: ['src'], risk: { level: 'medium', rationale: 'test' },
    } }, { agent: h.agent }), /stale-revision|task-contract-scope/)
  } finally { cp.mutate = mutate }
})

test('pre-step is idempotent for 20 calls, cursor waits for session commit, and native message ids prevent duplicate body', async () => {
  const h = harness()
  const roomState = createWakeState()
  roomState.roomAccess.room1 = { members: ['alice'], host: 'alice' }
  roomState.transcripts.room1 = [{ messageId: 'room-m1', roomId: 'room1', sequence: 1, author: 'bob', content: 'room update', originalText: 'room update', revision: 1 }]
  roomState.cursors.room1 = { alice: { sequence: 0, messageIds: [], injected: [], revision: 0 } }
  roomState.inbox['in-m1'] = { messageId: 'in-m1', target: 'alice', sender: 'bob', originalText: 'wake body', status: 'queued', wakeRequested: true }
  roomState.wakes['wake-1'] = { wakeId: 'wake-1', target: 'alice', messageIds: ['in-m1'], status: 'queued', updatedAt: 1 }
  await h.seed('test-pre-step', (state) => { state.v12RoomWake = roomState; return roomState })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(first.messages?.length >= 1)
  const beforeCommit = h.cp.snapshot().v12RoomWake.cursors.room1.alice
  for (let i = 0; i < 20; i += 1) {
    const repeat = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: first.messages }))
    assert.deepEqual(repeat.messages ?? [], first.messages, 'same manifest must not append a replay')
  }
  assert.deepEqual(h.cp.snapshot().v12RoomWake.cursors.room1.alice, beforeCommit)
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  assert.ok(h.cp.snapshot().v12RoomWake.cursors.room1.alice.sequence >= 1)

  h.messages.length = 0
  h.messages.push({ source: { kind: 'team-message' }, content: [{ type: 'text', text: '[team message id=in-m1] wake body' }] })
  const native = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const text = JSON.stringify(native.messages ?? [])
  assert.equal(text.includes('wake body'), false)
})

test('pre-step deduplicates a committed context manifest when no inbox is pending', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-context-manifest-dedupe', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = {
      requirementId: 'req1',
      text: 'manifest dedupe requirement',
      quote: 'manifest dedupe requirement',
      scope: '',
      taskIds: [],
      acceptance: [],
      status: 'active',
      revision: 1,
    }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages?.length, 1)
  assert.equal(JSON.stringify(first.messages).includes('[team v14 context manifest]'), true)

  h.messages.push(first.messages[0])
  const repeat = await pre({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(repeat.messages ?? [], [])
})

test('pre-step uses the durable receipt after the visible manifest leaves history', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-context-durable-cursor', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = {
      requirementId: 'req1',
      text: 'durable cursor requirement',
      quote: 'durable cursor requirement',
      scope: '',
      taskIds: [],
      acceptance: [],
      status: 'active',
      revision: 1,
    }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages?.length, 1)
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  assert.equal(h.cp.snapshot().v14DeliveryReceipts[0].items.length, 1)
  assert.equal(h.cp.snapshot().v12RoomWake.contextCursors['alice-session::alice'].versions['requirement:req1'].length, 64)

  h.messages.length = 0
  await h.seed('test-drop-bounded-receipts', (state) => {
    state.v14DeliveryReceipts = []
    return state.v12RoomWake.contextCursors
  })
  const repeat = await pre({ agent: h.agent, messages: [], step: 2 }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(repeat.messages ?? [], [])
})

test('post-compaction baseline reinjects a bounded root context once', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-context-compaction-baseline', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = {
      requirementId: 'req1',
      text: 'baseline requirement',
      quote: 'baseline requirement',
      scope: '',
      taskIds: [],
      acceptance: [],
      status: 'active',
      revision: 1,
    }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const pre = h.hook('agent/pre-step')
  const first = await pre({ agent: h.agent, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  await h.hook('session/event')(h.session, { type: 'user/message', message: first.messages[0] })
  await h.hook('session/event')(h.session, { type: 'compaction/end', compactionId: 'compact-1' })
  h.messages.length = 0
  const baseline = await pre({ agent: h.agent, messages: [], step: 9 }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(JSON.stringify(baseline.messages ?? []).includes('baseline requirement'), true)
  await h.hook('session/event')(h.session, { type: 'user/message', message: baseline.messages[0] })
  h.messages.length = 0
  const settled = await pre({ agent: h.agent, messages: [], step: 10 }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(settled.messages ?? [], [])
})

test('tier 0 context keeps only active relevant requirements and compact acceptance', async () => {
  const h = harness({ name: 'lead', tier: 0, config: { contextPackMaxTokens: 32000, tier0ContextPackMaxTokens: 900 } })
  const longAcceptance = 'acceptance '.repeat(400)
  await h.seed('test-root-context-budget', (state) => {
    state.boards = {
      global: {
        tasks: {
          active: {
            id: 'active', taskId: 'active', subject: 'active task', status: 'in_progress', phase: 'execution',
            lifecycle: 'running', ownerName: 'lead', revision: 2,
            contract: { owner: 'lead', deliverable: 'root result', acceptanceCriteria: [longAcceptance], writeScopes: ['reports'] },
          },
          done: {
            id: 'done', taskId: 'done', subject: 'done task', status: 'completed', lifecycle: 'completed',
            ownerName: 'member-a', revision: 3, contract: { owner: 'member-a', acceptanceCriteria: ['done'] },
          },
        },
      },
    }
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.active = {
      requirementId: 'active', text: 'root active requirement', quote: 'root active requirement',
      scope: '', taskIds: ['active'], acceptance: [longAcceptance], status: 'active', revision: 2,
    }
    state.v12Requirements.requirements.done = {
      requirementId: 'done', text: 'completed requirement must not enter root context',
      quote: 'completed requirement must not enter root context', scope: '', taskIds: ['done'],
      acceptance: [], status: 'completed', revision: 1,
    }
    state.v12Requirements.revision = 2
    return state
  })
  const decision = await h.hook('agent/pre-step')({ agent: h.agent, messages: [], step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const body = JSON.stringify(decision.messages ?? [])
  assert.equal(body.includes('root active requirement'), true)
  assert.equal(body.includes('completed requirement must not enter root context'), false)
  assert.equal(body.includes('acceptanceSummary'), true)
  assert.equal(body.includes(longAcceptance), false)
  assert.ok(body.length < 12000, 'root context body should stay bounded: ' + body.length)
})

test('new requirement is delivered without a new Room message', async () => {
  const h = harness({ tier: 1 })
  await h.seed('test-requirement', (state) => {
    state.v12Requirements = createRequirementLedger()
    state.v12Requirements.requirements.req1 = { requirementId: 'req1', text: 'new requirement', quote: 'new requirement', scope: '', taskIds: [], acceptance: [], status: 'active', revision: 1 }
    state.v12Requirements.revision = 1
    return state.v12Requirements
  })
  const decision = await h.hook('agent/pre-step')({ agent: h.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.ok(JSON.stringify(decision.messages ?? []).includes('req1'))
})

test('provider safety refusal activates a reduced Team context fallback', async () => {
  const h = harness({ name: 'alice', tier: 0 })
  await h.seed('test-provider-safety-fallback', (state) => {
    state.providerSafety = {
      alice: {
        member: 'alice',
        reason: 'content did not pass safety review',
        category: 'provider-safety',
        attempts: 1,
        requestBytes: 123456,
        requestTokens: 30864,
        contextPack: '[team-context-pack] refused full pack',
        expiresAt: Date.now() + 60_000,
        updatedAt: Date.now(),
      },
    }
    return state.providerSafety
  })
  const decision = await h.hook('agent/pre-step')({ agent: h.agent, messages: [] },
    async () => ({ kind: 'enter', messages: [] }))
  const body = JSON.stringify(decision.messages ?? [])
  assert.ok(body.includes('provider-safety-fallback'))
  assert.ok(body.includes('content did not pass safety review'))
  assert.ok(body.length < 12_000)
})

test('unexpected ready-gate read failure rejects closed', async () => {
  const h = harness()
  await h.cp.boardCreate({ taskId: 'gate-task', subject: 'gate', ownerName: 'alice' }, h.agent)
  const original = h.cp.snapshot
  const originalView = h.cp.view
  h.cp.snapshot = () => { throw new Error('unexpected read failure') }
  h.cp.view = () => { throw new Error('unexpected read failure') }
  try {
    await assert.rejects(() => h.hook('tools/pre-execute')(execFor(h, 'team_task_update', 'gate-call', {
      arguments: { action: 'claim', task_id: 'gate-task' },
    }), async () => ({ kind: 'allow' })), /task-contract-gate-unavailable/)
  } finally {
    h.cp.snapshot = original
    h.cp.view = originalView
  }
})

test('claim gate allows zero-scope discussion/review tasks without weakening edit tasks', async () => {
  const h = harness()
  await h.seed('test-readonly-claim', (state) => {
    state.boards = state.boards ?? {}
    state.boards.global = state.boards.global ?? { tasks: {} }
    for (const kind of ['discussion', 'review', 'edit']) {
      state.boards.global.tasks[kind] = {
        id: kind,
        taskId: kind,
        subject: kind,
        status: 'pending',
        lifecycle: 'proposed',
        phase: 'room-discussion',
        ownerName: 'alice',
        workKind: kind,
        writeScopes: [],
        revision: 1,
        contract: {
          schemaVersion: 2,
          contractId: kind,
          taskId: kind,
          goal: 'verify the claim gate',
          deliverable: 'claim gate result',
          kind,
          owner: 'alice',
          writeScopes: [],
          dependencies: [],
          acceptanceCriteria: [{ id: 'ac-1', text: 'claim is accepted', required: true }],
          risk: { level: 'low', rationale: 'test' },
          contractRevision: 1,
          lifecycle: 'proposed',
        },
      }
    }
    return state.boards.global.tasks
  })
  const pre = h.hook('tools/pre-execute')
  for (const kind of ['discussion', 'review']) {
    const decision = await pre(execFor(h, 'team_task_update', kind + '-claim', {
      arguments: { action: 'claim', task_id: kind },
    }), async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'allow')
  }
  await assert.rejects(() => pre(execFor(h, 'team_task_update', 'edit-claim', {
    arguments: { action: 'claim', task_id: 'edit' },
  }), async () => ({ kind: 'allow' })), /task-contract-ready-gate|scope-required/)
})

test('waiting_set accepts an unowned task and snake_case condition alias', async () => {
  const h = harness()
  await h.seed('test-unowned-waiting', (state) => {
    state.boards = state.boards ?? {}
    state.boards.global = state.boards.global ?? { tasks: {} }
    state.boards.global.tasks.unowned = {
      id: 'unowned',
      taskId: 'unowned',
      subject: 'unowned waiting task',
      status: 'pending',
      lifecycle: 'proposed',
      writeScopes: [],
      revision: 1,
    }
    return state.boards.global.tasks.unowned
  })
  const tool = h.teamTool()
  const ticket = await tool.execute({
    action: 'waiting_set',
    task_id: 'unowned',
    input: {
      reason: 'external operator action',
      unblock_condition: { type: 'external' },
      responsible: 'operator',
    },
  }, { agent: h.agent })
  assert.equal(ticket.owner, 'alice')
  assert.equal(ticket.unblockCondition.type, 'external')
  assert.equal(h.cp.snapshot().v14Waiting.tickets[ticket.ticketId].owner, 'alice')

  const resolved = await tool.execute({
    action: 'waiting_resolve',
    task_id: 'unowned',
    input: { resolution: 'operator cleared the condition' },
  }, { agent: h.agent })
  assert.equal(resolved.status, 'resolved')
})

test('requirement record authorization keeps leads inside their own board and scope', () => {
  const tasks = [
    { board: 'group-g1', task: { id: 't1' } },
    { board: 'group-g2', task: { id: 't2' } },
    { board: 'global', task: { id: 't3' } },
  ]
  const canWriteBoard = (_name, board) => board === 'group-g1'
  assert.equal(authorizeRequirementRecord({ tier: 0, memberName: 'lead', group: 'root', input: { scope: 'global' } }).ok, true)
  assert.equal(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { taskIds: ['t1'] }, taskRows: tasks, canWriteBoard }).ok, true)
  assert.equal(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { scope: 'group-g1' }, taskRows: tasks, canWriteBoard }).ok, true)
  assert.match(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { scope: 'global' }, taskRows: tasks, canWriteBoard }).code, /scope/)
  assert.match(authorizeRequirementRecord({ tier: 1, memberName: 'g1', group: 'g1', input: { taskIds: ['t2'] }, taskRows: tasks, canWriteBoard }).code, /task-scope/)
  assert.match(authorizeRequirementRecord({ tier: 2, memberName: 'm', group: 'g1', input: { scope: 'group-g1' } }).code, /lead-or-tier-0-only/)
})

test('waiting authorization lets a group lead manage waits for its own member task', () => {
  const canWriteBoard = (_name, board) => board === 'group-g1'
  assert.equal(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g1',
    taskBoard: 'group-g1',
    ownerGroup: 'g1',
    canWriteBoard,
  }).ok, true)
  assert.equal(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g1',
    requestedOwner: 'member-g1',
    taskBoard: 'group-g1',
    ownerGroup: 'g1',
    canWriteBoard,
  }).ok, true)
  assert.match(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g2',
    taskBoard: 'group-g2',
    ownerGroup: 'g2',
    canWriteBoard,
  }).code, /waiting-scope/)
  assert.match(authorizeWaitingAction({
    tier: 1,
    memberName: 'lead-g1',
    group: 'g1',
    taskOwner: 'member-g1',
    taskBoard: 'global',
    ownerGroup: 'g1',
    canWriteBoard,
  }).code, /waiting-scope/)
  assert.match(authorizeWaitingAction({
    tier: 2,
    memberName: 'member-g1',
    group: 'g1',
    taskOwner: 'member-g1-other',
    taskBoard: 'group-g1',
    ownerGroup: 'g1',
    canWriteBoard,
  }).code, /waiting-scope/)
  assert.equal(authorizeWaitingAction({
    tier: 2,
    memberName: 'member-g1',
    group: 'g1',
    taskOwner: '',
    requestedOwner: 'member-g1',
    taskBoard: 'group-g1',
    canWriteBoard,
  }).ok, true)
  assert.equal(authorizeWaitingAction({
    tier: 0,
    memberName: 'root',
    group: 'root',
    taskOwner: 'member-g2',
    taskBoard: 'global',
    ownerGroup: 'g2',
  }).ok, true)
})
