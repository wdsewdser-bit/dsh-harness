#!/usr/bin/env node
/**
 * Phase 7: two hard gates that a real session exposed on 0.1.6.
 *
 * 1. A room handoff must carry the caller's AbortSignal into the Team mailbox.
 *    Without it the SDK throws
 *    `The "signals[0]" argument must be an instance of AbortSignal`, every
 *    next-speaker wake is recorded as delivery-failed, and the round stalls.
 * 2. A task that declares write scopes must not complete outside an approved
 *    plan with a recorded evidence reference. The old gate only ran when a plan
 *    row already existed, so a scoped task could skip plan and evidence entirely.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2-r7.mjs').href)

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const root = mkdtempSync(join(tmpdir(), 'dsh-v5-wake-'))
const controlDir = join(root, 'control')
const scopesFile = join(root, 'scopes.json')
const milestonePath = join(root, 'milestones.json')

const registrations = []
const mkAgent = (name) => ({
  name,
  ctx: {
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: {
      register: (definition) => {
        registrations.push({ owner: name, definition })
        return () => {}
      },
    },
  },
})

const lead = mkAgent('lead')
const groupLead = mkAgent('lead-a')
const memberOne = mkAgent('m1')
const memberTwo = mkAgent('m2')
const agents = [lead, groupLead, memberOne, memberTwo]
const memberships = new Map([
  [lead, { id: 'wake-team', name: 'lead', role: 'lead', root: lead }],
  [groupLead, { id: 'wake-team', name: 'lead-a', role: 'teammate', root: lead }],
  [memberOne, { id: 'wake-team', name: 'm1', role: 'teammate', root: lead }],
  [memberTwo, { id: 'wake-team', name: 'm2', role: 'teammate', root: lead }],
])
const sent = []

const ctx = {
  agents: { list: () => agents },
  agentTeams: {
    tryMembership: (agent) => memberships.get(agent),
    membership: (agent) => memberships.get(agent),
    listMembers: () => agents.map((agent) => ({
      id: 'id-' + agent.name,
      name: agent.name,
      role: memberships.get(agent).role,
      status: 'idle',
      diagnostics: [],
      frozen: false,
      ...(agent === lead ? {} : {
        level: agent === groupLead ? 1 : 2,
        groupId: 'group-a',
        parentName: agent === groupLead ? 'lead' : 'lead-a',
      }),
    })),
    listTasks: () => [],
    getTask: async () => undefined,
    updateTask: async () => { throw new Error('not used') },
    sendMessage: async (caller, request) => {
      if (!(request.signal instanceof AbortSignal)) {
        throw new Error('ROOM_WAKE_WITHOUT_SIGNAL for "' + String(request.target) + '"')
      }
      sent.push({ caller: caller.name, target: request.target })
      return { messageId: 'team-message-' + String(sent.length) }
    },
    waitForChange: async () => ({ timedOut: true }),
  },
  logger: { warn: () => {} },
  on: () => {},
  effect: () => {},
}

try {
  policyMod.apply(ctx, { controlDir })
  const policy = policyMod.policyFor('wake-team')
  policy.seedRoot(lead)
  policy.put({ name: 'lead-a', tier: 1, group: 'group-a', parent: 'lead' })
  policy.put({ name: 'm1', tier: 2, group: 'group-a', parent: 'lead-a' })
  policy.put({ name: 'm2', tier: 2, group: 'group-a', parent: 'lead-a' })
  toolsMod.apply(ctx, { controlDir, scopesFile, milestonePath, rolesDir: join(root, 'roles') })

  const toolFor = (owner, name) => registrations.find((row) => row.owner === owner && row.definition.name === name)?.definition
  const roomNext = toolFor('lead-a', 'team_room_next')
  check('the real team_room_next tool is installed for the group lead', roomNext !== undefined)

  const cp = policy.control
  await cp.roomOpen({
    roomId: 'group:group-a:tier-2',
    kind: 'group',
    title: 'group a',
    members: ['lead-a', 'm1', 'm2'],
    host: 'lead-a',
  })

  const signal = new AbortController().signal
  const round = await roomNext.execute(
    { room_id: 'group:group-a:tier-2', topic: 'interface', members: ['m1', 'm2'] },
    { agent: groupLead, signal },
  )
  const roundState = cp.snapshot().rounds[round.roundId]
  check('the host is appended after the named participants',
    JSON.stringify(roundState.order) === JSON.stringify(['m1', 'm2', 'lead-a']),
    JSON.stringify(roundState.order))
  const compact = toolsMod.compactRoomSnapshot(cp.snapshot(), 'group:group-a:tier-2', 'lead-a', 3)
  check('room snapshots expose the three-round budget',
    compact.roundBudget.used === 1 && compact.roundBudget.max === 3 && compact.roundBudget.remaining === 2,
    JSON.stringify(compact.roundBudget))
  check('room handoff delivers the first speaker', round.wakeStatus === 'delivered', JSON.stringify(round))
  check('room handoff carries the caller AbortSignal',
    sent.length === 1 && sent[0].caller === 'lead-a' && sent[0].target === 'm1',
    JSON.stringify(sent))

  await cp.roomOpen({
    roomId: 'level:1',
    kind: 'level',
    title: 'level one',
    members: ['lead', 'lead-a'],
    host: 'lead',
  })
  const rootRoomNext = toolFor('lead', 'team_room_next')
  const rootRound = await rootRoomNext.execute(
    { room_id: 'level:1', topic: 'parent plan', members: ['lead-a'] },
    { agent: lead, signal },
  )
  const roomPost = toolFor('lead-a', 'team_room_post')
  const rootWake = await roomPost.execute(
    {
      room_id: 'level:1',
      round_id: rootRound.roundId,
      kind: 'proposal',
      content: 'child work may proceed after this round closes',
    },
    { agent: groupLead, signal },
  )
  check('the final speaker wakes the root host as a peer, never as a self-message',
    rootWake.wakeTarget === 'lead'
      && rootWake.wakeStatus === 'delivered'
      && sent[sent.length - 1].caller === 'lead-a'
      && sent[sent.length - 1].target === 'lead',
    JSON.stringify({ rootWake, lastSent: sent[sent.length - 1] }))

  const sendMessage = toolFor('lead-a', 'send_message')
  const sendResult = await sendMessage.execute({ target: 'm1', message: 'downward control', delivery: 'info' }, { agent: groupLead, signal })
  check('an informational send returns a wake reminder',
    typeof sendResult.wakeReminder === 'string'
      && /Informational delivery only/.test(sendResult.wakeReminder)
      && /delivery:\"action\"/.test(sendResult.wakeReminder)
      && /delivery:\"decision\"/.test(sendResult.wakeReminder),
    JSON.stringify(sendResult))
  const downward = Object.values(cp.snapshot().dispatches ?? {})
    .find((row) => row.target === 'm1' && row.roomId !== null && row.roomId !== 'group:group-a:tier-2')
  const groupBound = Object.values(cp.snapshot().dispatches ?? {})
    .some((row) => row.target === 'm1' && row.roomId === 'group:group-a:tier-2')
  check('a lead-to-member control message uses the group room, never level:1',
    downward === undefined && groupBound,
    JSON.stringify({ downward, groupBound }))

  const taskUpdate = toolFor('lead-a', 'team_task_update')
  await cp.boardCreate({
    boardId: 'group-group-a',
    taskId: 'scoped-task',
    subject: 'scoped task',
    description: 'task that declares a product write scope',
    writeScopes: ['src'],
  })
  let refused
  try {
    await taskUpdate.execute(
      { task_id: 'scoped-task', expected_revision: 1, action: 'complete', board: 'group', evidence_ids: ['missing-evidence'] },
      { agent: groupLead, signal },
    )
  } catch (error) {
    refused = String(error?.message ?? error)
  }
  check('a scoped task cannot complete without an approved plan',
    /complete-plan/.test(refused ?? ''),
    refused)
  const after = cp.boardGet('group-group-a', 'scoped-task')
  check('the refused completion did not mutate the task',
    after?.status === 'pending' && after?.revision === 1,
    JSON.stringify(after))

  // A legacy / unplanned task still has to carry evidence: the delivery gate used
  // to skip every task without a plan row, so `deliverable=true` could be returned
  // while such a task sat completed with no evidence at all.
  await cp.boardCreate({
    boardId: 'group-group-a',
    taskId: 'unplanned-complete',
    subject: 'unplanned completion',
    description: 'legacy task completed without a plan',
    writeScopes: [],
  })
  await cp.boardUpdate({ boardId: 'group-group-a', taskId: 'unplanned-complete', expectedRevision: 1, action: 'claim', actorName: 'lead-a' })
  await cp.boardUpdate({ boardId: 'group-group-a', taskId: 'unplanned-complete', expectedRevision: 2, action: 'complete', actorName: 'lead-a', evidenceIds: [] })
  const deliveryCheck = toolFor('lead', 'team_delivery_check')
  const gate = await deliveryCheck.execute({}, { agent: lead, signal })
  check('an unplanned completion without evidence blocks delivery',
    gate.deliverable === false
      && gate.blockers.some((row) => row.taskId === 'unplanned-complete' && row.requirement === 'evidence'),
    JSON.stringify(gate.blockers))
} catch (error) {
  failed += 1
  console.log('FAIL room wake harness: ' + String(error?.stack ?? error))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
