#!/usr/bin/env node
/**
 * Phase 8: hard gates exposed by the two-level Room smoke test.
 *
 * These checks use the real policy, control plane and model-facing tools. They
 * cover discussion-task completion, edit-task gates, parent-room ordering,
 * unresolved-item resolution, and the no-poll room-turn instruction.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policyMod = await import(pathToFileURL(base + 'team-policy.mjs').href)
const toolsMod = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const root = mkdtempSync(join(tmpdir(), 'dsh-phase8-'))
const controlDir = join(root, 'control')
const scopesFile = join(root, 'scopes.json')
const milestonePath = join(root, 'milestones.json')
const taskCommit = 'b'.repeat(40)

const registrations = []
const mkAgent = (name, role) => ({
  id: 'phase8-' + name,
  status: 'idle',
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
  membership: { id: 'phase8-team', name, role, root: undefined },
})

const lead = mkAgent('lead', 'lead')
const groupLead = mkAgent('lead-a', 'teammate')
const memberOne = mkAgent('m1', 'teammate')
const memberTwo = mkAgent('m2', 'teammate')
const agents = [lead, groupLead, memberOne, memberTwo]
for (const agent of agents) agent.membership.root = lead
const memberships = new Map(agents.map((agent) => [agent, agent.membership]))
const sent = []
const domainInterrupts = []
const rawSubagentInterrupts = []
const domainTasks = new Map()
let taskSequence = 0

const clone = (value) => structuredClone(value)
const ctx = {
  agents: { list: () => agents },
  agentTeams: {
    tryMembership: (agent) => memberships.get(agent),
    membership: (agent) => memberships.get(agent),
    interrupt: (authority, target) => { domainInterrupts.push({ authority, target }) },
    listMembers: () => agents.map((agent) => ({
      id: 'phase8-' + agent.name,
      name: agent.name,
      role: agent.membership.role,
      status: 'idle',
      diagnostics: [],
      ...(agent === lead ? {} : {
        level: agent === groupLead ? 1 : 2,
        groupId: agent === groupLead ? 'lead-a' : 'lead-a',
        parentName: agent === groupLead ? 'lead' : 'lead-a',
      }),
    })),
    createTask: async (caller, request) => {
      const id = 'task-' + String(++taskSequence)
      const task = {
        id,
        revision: 1,
        subject: request.subject,
        description: request.description,
        status: 'pending',
        phase: 'room-discussion',
        blockedBy: request.blockedBy ?? [],
        writeScopes: request.writeScopes ?? [],
        commitSha: null,
        evidenceIds: [],
        ready: true,
        writeScopeWarnings: [],
      }
      domainTasks.set(id, task)
      return clone(task)
    },
    listTasks: () => [...domainTasks.values()].map(clone),
    getTask: (_caller, id) => {
      const task = domainTasks.get(String(id))
      if (task === undefined) throw new Error('unknown domain task')
      return clone(task)
    },
    updateTask: async (_caller, request) => {
      const task = domainTasks.get(String(request.taskId))
      if (task === undefined) throw new Error('unknown domain task')
      if (task.revision !== request.expectedRevision) throw new Error('stale domain revision')
      if (request.action === 'claim') {
        task.status = 'in_progress'
      } else if (request.action === 'complete') {
        task.status = 'completed'
        if (request.commitSha !== undefined) task.commitSha = request.commitSha
        if (request.evidenceIds !== undefined) task.evidenceIds = request.evidenceIds
      }
      task.revision += 1
      return clone(task)
    },
    sendMessage: async (caller, request) => {
      sent.push({ caller: caller.name, target: request.target })
      return { messageId: 'message-' + String(sent.length) }
    },
    waitForChange: async () => ({ timedOut: true }),
  },
  logger: { warn: () => {}, info: () => {} },
  subagents: { interrupt: (id, authority) => { rawSubagentInterrupts.push({ id, authority }) } },
  on: () => {},
  effect: () => {},
}

try {
  policyMod.apply(ctx, { controlDir })
  const policy = policyMod.policyFor('phase8-team')
  policy.seedRoot(lead)
  policy.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead' })
  policy.put({ name: 'm1', tier: 2, group: 'lead-a', parent: 'lead-a' })
  policy.put({ name: 'm2', tier: 2, group: 'lead-a', parent: 'lead-a' })
  toolsMod.apply(ctx, { controlDir, scopesFile, milestonePath, rolesDir: join(root, 'roles') })

  const tool = (owner, name) => registrations
    .find((row) => row.owner === owner && row.definition.name === name)?.definition
  const signal = new AbortController().signal

  const createTask = tool('lead', 'team_task_create')
  const updateTask = tool('lead', 'team_task_update')
  const recordEvidence = tool('lead', 'team_evidence_record')
  const reconcileTask = tool('lead', 'team_task_reconcile')
  const runLease = tool('lead-a', 'team_run_lease')
  const groupCreateTask = tool('lead-a', 'team_task_create')
  const groupUpdateTask = tool('lead-a', 'team_task_update')
  const wakeSuperior = tool('m1', 'team_wake_superior')
  const leadWakeSuperior = tool('lead-a', 'team_wake_superior')

  let editWithoutScope
  try {
    await createTask.execute(
      { subject: 'invalid edit', description: 'must fail', kind: 'edit', write_scopes: [], board: 'global' },
      { agent: lead, signal },
    )
  } catch (error) {
    editWithoutScope = String(error?.message ?? error)
  }
  check('an edit task without write scopes is refused at creation',
    /task-kind-scope/.test(editWithoutScope ?? ''),
    editWithoutScope)

  const discussion = await createTask.execute(
    {
      subject: 'two-level room smoke',
      description: 'pure discussion with room evidence',
      kind: 'discussion',
      write_scopes: [],
      board: 'global',
    },
    { agent: lead, signal },
  )
  check('a discussion task is created without write scopes',
    discussion.workKind === 'discussion' && discussion.writeScopes.length === 0,
    JSON.stringify(discussion))

  // The shipped Team domain has no `advance_phase` action; phase transitions
  // are owned by the local control plane and must not be forwarded to domain CAS.
  const domainPhaseBefore = domainTasks.get(discussion.id)?.phase
  const phaseTask = await createTask.execute(
    { subject: 'phase-only task', description: 'local phase', kind: 'discussion', write_scopes: [], board: 'global' },
    { agent: lead, signal },
  )
  const phased = await updateTask.execute(
    { task_id: phaseTask.id, expected_revision: 1, action: 'advance_phase', phase: 'plan-proposed', board: 'global' },
    { agent: lead, signal },
  )
  check('global advance_phase is recorded without domain action support',
    phased.phase === 'plan-proposed' && domainTasks.get(phaseTask.id)?.phase === 'room-discussion',
    JSON.stringify({ returned: phased.phase, domain: domainTasks.get(phaseTask.id)?.phase }))
  const claimedAfterLocalPhase = await updateTask.execute(
    { task_id: phaseTask.id, expected_revision: 2, action: 'claim', board: 'global' },
    { agent: lead, signal },
  )
  check('a domain CAS after a local-only phase move binds the domain revision, not the local one',
    claimedAfterLocalPhase.status === 'in_progress'
      && claimedAfterLocalPhase.revision === 3
      && domainTasks.get(phaseTask.id)?.revision === 2,
    JSON.stringify({ view: claimedAfterLocalPhase, domain: domainTasks.get(phaseTask.id) }))
  await updateTask.execute(
    { task_id: discussion.id, expected_revision: 1, action: 'claim', board: 'global' },
    { agent: lead, signal },
  )
  const evidence = await recordEvidence.execute(
    { task_id: discussion.id, kind: 'room-decision', output: 'three room rounds closed', status: 'pass' },
    { agent: lead, signal },
  )
  const discussionAfterEvidence = policy.control.boardGet('global', discussion.id)
  const completed = await updateTask.execute(
    {
      task_id: discussion.id,
      expected_revision: discussionAfterEvidence.revision,
      action: 'complete',
      evidence_ids: [evidence.evidenceId],
      board: 'global',
    },
    { agent: lead, signal },
  )
  check('a discussion task closes with evidence and no plan or commit',
    completed.status === 'completed' && completed.workKind === 'discussion',
    JSON.stringify(completed))
  const completedList = await tool('lead', 'team_task_list').execute(
    { status: 'completed', board: 'global' },
    { agent: lead, signal },
  )
  check('the global task list projects local completion over the stale domain status',
    completedList.tasks.some((task) => task.id === discussion.id && task.status === 'completed'),
    JSON.stringify(completedList.tasks))

  const source = await createTask.execute(
    { subject: 'completed execution source', description: 'source delivery', kind: 'discussion', write_scopes: [], board: 'group' },
    { agent: groupLead, signal },
  )
  await updateTask.execute(
    { task_id: source.id, expected_revision: 1, action: 'claim', board: 'group' },
    { agent: groupLead, signal },
  )
  const sourceEvidence = await recordEvidence.execute(
    { task_id: source.id, commit_sha: taskCommit, kind: 'source-delivery', output: 'source complete', status: 'pass' },
    { agent: groupLead, signal },
  )
  const sourceAfterEvidence = policy.control.boardGet(source.board, source.id)
  await updateTask.execute(
    { task_id: source.id, expected_revision: sourceAfterEvidence.revision, action: 'complete', evidence_ids: [sourceEvidence.evidenceId], commit_sha: taskCommit, board: 'group' },
    { agent: groupLead, signal },
  )
  const reference = await createTask.execute(
    { subject: 'global reference', description: 'points at group delivery', kind: 'edit', write_scopes: ['docs'], board: 'global' },
    { agent: lead, signal },
  )
  const reconciled = await reconcileTask.execute(
    { task_id: reference.id, source_task_id: source.id, reason: 'global board is a reference entry', board: 'global' },
    { agent: lead, signal },
  )
  check('a stranded global reference completes from a completed same-Team execution task',
    reconciled.status === 'completed' && reconciled.commitSha === taskCommit && reconciled.evidenceIds.length >= 2,
    JSON.stringify(reconciled))
  const delivery = await tool('lead', 'team_delivery_check').execute({}, { agent: lead, signal })
  check('the delivery gate accepts a completed global reference backed by its completed source',
    delivery.open.every((task) => task.id !== reference.id)
      && delivery.blockers.every((row) => row.taskId !== reference.id),
    JSON.stringify({ open: delivery.open, blockers: delivery.blockers }))

  let fabricatedRefusal
  const missingSourceRef = await createTask.execute(
    { subject: 'global reference missing source', description: 'must not fabricate', kind: 'edit', write_scopes: ['docs'], board: 'global' },
    { agent: lead, signal },
  )
  try {
    await reconcileTask.execute(
      { task_id: missingSourceRef.id, source_task_id: 'missing-source', reason: 'must fail', board: 'global' },
      { agent: lead, signal },
    )
  } catch (error) {
    fabricatedRefusal = String(error?.message ?? error)
  }
  check('reconcile refuses a missing source instead of fabricating evidence',
    /reconcile-source/.test(fabricatedRefusal ?? ''),
    fabricatedRefusal)

  const leaseTask = await groupCreateTask.execute(
    { subject: 'lease order', description: 'complete before release', kind: 'edit', write_scopes: ['docs'], board: 'group' },
    { agent: groupLead, signal },
  )
  await groupUpdateTask.execute(
    { task_id: leaseTask.id, expected_revision: 1, action: 'claim', board: 'group' },
    { agent: groupLead, signal },
  )
  await tool('lead-a', 'team_plan_propose').execute(
    { task_id: leaseTask.id, requirement_id: 'lease-order', goal: 'lease order', members: ['lead-a'], write_scopes: ['docs'], checks: { order: ['complete before release'] }, rollback: 'revert' },
    { agent: groupLead, signal },
  )
  await tool('lead-a', 'team_plan_propose').execute(
    { task_id: leaseTask.id, requirement_id: 'lease-order', goal: 'lease order revised', members: ['lead-a'], write_scopes: ['docs'], checks: { order: ['complete before release'] }, rollback: 'revert' },
    { agent: groupLead, signal },
  )
  check('an unapproved plan can be re-proposed in place',
    policy.control.planState(leaseTask.id)?.goal === 'lease order revised',
    JSON.stringify(policy.control.planState(leaseTask.id)))
  await tool('lead-a', 'team_plan_approve').execute(
    { task_id: leaseTask.id },
    { agent: groupLead, signal },
  )
  const lease = await runLease.execute(
    { action: 'acquire', task_id: leaseTask.id },
    { agent: groupLead, signal },
  )
  let prematureRelease
  try {
    await runLease.execute(
      { action: 'release', run_id: lease.runId, status: 'completed' },
      { agent: groupLead, signal },
    )
  } catch (error) {
    prematureRelease = String(error?.message ?? error)
  }
  check('a completed lease cannot be released while its task is still open',
    /lease-release-order/.test(prematureRelease ?? ''),
    prematureRelease)

  const memberWake = await wakeSuperior.execute({
    blocked_action: 'approve the scoped rework',
    reason: 'the group lead owns the approval and the task cannot proceed',
    evidence: ['task is plan-proposed and waiting for the group lead'],
  }, { agent: memberOne, signal })
  check('a tier-2 member can wake its direct group lead',
    memberWake.target === 'lead-a' && memberWake.status === 'delivered',
    JSON.stringify(memberWake))
  const coalescedWake = await wakeSuperior.execute({
    blocked_action: 'approve the scoped rework',
    reason: 'still waiting on the same approval',
    evidence: ['same pending task'],
  }, { agent: memberOne, signal })
  check('a duplicate superior wake is coalesced instead of delivered again',
    coalescedWake.coalesced === true && coalescedWake.dispatchId === memberWake.dispatchId,
    JSON.stringify(coalescedWake))

  const leadWake = await leadWakeSuperior.execute({
    blocked_action: 'review a privilege request',
    reason: 'only tier 0 can approve the one-turn privilege bypass',
    evidence: ['privilege request is approved-pending activation'],
  }, { agent: groupLead, signal })
  check('a tier-1 lead can wake tier 0',
    leadWake.target === 'lead' && leadWake.status === 'delivered',
    JSON.stringify(leadWake))

  const taskTwo = Object.values(policy.control.snapshot().boards ?? {})
    .flatMap((board) => Object.values(board.tasks ?? {}))
    .find((task) => task.id === 'task-2')
  const teamWake = tool('lead', 'team_wake')
  let staleWake
  try {
    await teamWake.execute({
      target: 'lead-a',
      message: 'continue from the stale snapshot',
      reason: 'test the stale-instruction gate',
      task_id: taskTwo.id,
      based_on_revision: Number(taskTwo.revision) - 1,
      based_on_phase: taskTwo.phase,
    }, { agent: lead, signal })
  } catch (error) {
    staleWake = String(error?.message ?? error)
  }
  check('a task wake based on an old revision is refused before delivery',
    /instruction-stale/.test(staleWake ?? ''), staleWake)
  const freshWake = await teamWake.execute({
    target: 'lead-a',
    message: 'continue from the exact current snapshot',
    reason: 'test the instruction state binding',
    task_id: taskTwo.id,
    based_on_revision: taskTwo.revision,
    based_on_phase: taskTwo.phase,
  }, { agent: lead, signal })
  check('a fresh task wake carries its state snapshot and receipt rule',
    freshWake.taskSnapshot?.taskId === taskTwo.id
      && freshWake.taskSnapshot?.revision === taskTwo.revision
      && freshWake.taskSnapshot?.phase === taskTwo.phase,
    JSON.stringify(freshWake))

  const interrupt = tool('lead-a', 'interrupt_agent')
  const interrupted = await interrupt.execute({ target: 'm1' }, { agent: groupLead, signal })
  check('a group lead interrupts its own member through the root Team authority',
    interrupted.previousStatus === 'idle' && rawSubagentInterrupts.length === 1
      && rawSubagentInterrupts[0].authority?.kind === 'ancestor'
      && rawSubagentInterrupts[0].authority?.agent === lead
      && rawSubagentInterrupts[0].id === 'phase8-m1' && domainInterrupts.length === 0,
    JSON.stringify({
      previousStatus: interrupted.previousStatus,
      domain: domainInterrupts.length,
      raw: rawSubagentInterrupts.map((entry) => ({
        id: entry.id,
        kind: entry.authority?.kind,
        authority: entry.authority?.agent?.name ?? String(entry.authority?.agent),
      })),
    }))

  let missingWakeEvidence
  try {
    await wakeSuperior.execute({
      blocked_action: 'do something',
      reason: 'no evidence supplied',
      evidence: [],
    }, { agent: memberOne, signal })
  } catch (error) {
    missingWakeEvidence = String(error?.message ?? error)
  }
  check('a superior wake without evidence is refused',
    /wake-superior-evidence/.test(missingWakeEvidence ?? ''),
    missingWakeEvidence)

  const cp = policy.control
  const roomOpen = tool('lead', 'team_room_open')
  const roomNext = tool('lead', 'team_room_next')
  const roomClose = tool('lead', 'team_room_close')
  const roomResolve = tool('lead', 'team_room_resolve')
  const waitAgent = tool('m2', 'wait_agent')

  const pendingLevelRead = await tool('lead-a', 'team_room_read').execute(
    { room_id: 'level:1' },
    { agent: groupLead, signal },
  )
  check('a lead reading level:1 before the host opens it gets stop semantics',
    pendingLevelRead.status === 'not-open'
      && pendingLevelRead.waitAction === 'stop'
      && pendingLevelRead.kind === 'level',
    JSON.stringify(pendingLevelRead))
  await roomOpen.execute(
    { room_id: 'level:1', kind: 'level', title: 'parent plan', members: ['lead-a'] },
    { agent: lead, signal },
  )
  const parentRound = await roomNext.execute(
    { room_id: 'level:1', topic: 'agree before child work', members: ['lead-a'] },
    { agent: lead, signal },
  )
  let tierTwoOpenRefusal
  try {
    await tool('m2', 'team_room_open').execute(
      {
        room_id: 'group:lead-a:tier-2',
        kind: 'group',
        title: 'must not open',
        members: ['m1', 'm2'],
      },
      { agent: memberTwo, signal },
    )
  } catch (error) {
    tierTwoOpenRefusal = String(error?.message ?? error)
  }
  check('tier 2 cannot pre-open its group room',
    /room-open-scope/.test(tierTwoOpenRefusal ?? ''),
    tierTwoOpenRefusal)
  const pendingJoin = await tool('m1', 'team_room_join').execute(
    { room_id: 'group:lead-a:tier-2' },
    { agent: memberOne, signal },
  )
  const pendingRead = await tool('m1', 'team_room_read').execute(
    { room_id: 'group:lead-a:tier-2' },
    { agent: memberOne, signal },
  )
  const pendingWait = await tool('m1', 'wait_agent').execute(
    { timeout_ms: 45000 },
    { agent: memberOne, signal },
  )
  check('a member joining before the host opens gets stop-not-error semantics',
    pendingJoin.status === 'pending'
      && pendingRead.status === 'not-open'
      && pendingRead.action === 'stop'
      && pendingWait.noProgress?.reason === 'room-turn-pending',
    JSON.stringify({ pendingJoin, pendingRead, pendingWait }))
  await roomOpen.execute(
    {
      room_id: 'group:lead-a:tier-2',
      kind: 'group',
      title: 'child group',
      members: ['m1', 'm2'],
    },
    { agent: groupLead, signal },
  )
  let dependencyRefusal
  try {
    await tool('lead-a', 'team_room_next').execute(
      { room_id: 'group:lead-a:tier-2', topic: 'too early', members: ['m1', 'm2'] },
      { agent: groupLead, signal },
    )
  } catch (error) {
    dependencyRefusal = String(error?.message ?? error)
  }
  check('a child group round is refused while its level:1 parent round is open',
    /room-dependency/.test(dependencyRefusal ?? ''),
    dependencyRefusal)

  await tool('lead-a', 'team_room_post').execute(
    { room_id: 'level:1', round_id: parentRound.roundId, kind: 'proposal', content: 'proceed after close' },
    { agent: groupLead, signal },
  )
  await tool('lead', 'team_room_post').execute(
    { room_id: 'level:1', round_id: parentRound.roundId, kind: 'fact', content: 'parent closes now' },
    { agent: lead, signal },
  )
  await roomClose.execute(
    {
      room_id: 'level:1',
      round_id: parentRound.roundId,
      summary: 'parent plan accepted',
      unresolved: ['child round not started'],
    },
    { agent: lead, signal },
  )
  const childRound = await tool('lead-a', 'team_room_next').execute(
    { room_id: 'group:lead-a:tier-2', topic: 'child discussion', members: ['m1', 'm2'] },
    { agent: groupLead, signal },
  )
  check('the child round opens after the parent closes',
    childRound.status === 'open' && childRound.wakeTarget === 'm1',
    JSON.stringify(childRound))

  const waiting = await waitAgent.execute({ timeout_ms: 45000 }, { agent: memberTwo, signal })
  const nextWait = await tool('m1', 'wait_agent').execute(
    { timeout_ms: 45000 },
    { agent: memberOne, signal },
  )
  const waitingSnapshot = await tool('m2', 'team_room_read').execute(
    { room_id: 'group:lead-a:tier-2' },
    { agent: memberTwo, signal },
  )
  check('a non-next room participant is told to stop instead of waiting',
    waiting.noProgress?.reason === 'room-turn-pending'
      && nextWait.noProgress?.reason === 'room-turn-pending'
      && /Post your main turn/.test(nextWait.noProgress?.message ?? '')
      && waitingSnapshot.waitAction === 'stop'
      && /Do not call wait_agent/.test(waitingSnapshot.waitInstruction ?? ''),
    JSON.stringify({ waiting, nextWait, waitingSnapshot }))

  const unresolvedId = cp.snapshot().rooms['level:1'].unresolved[0].id
  const resolved = await roomResolve.execute(
    {
      room_id: 'level:1',
      unresolved_id: unresolvedId,
      resolution: 'child round opened and member m1 was woken',
    },
    { agent: lead, signal },
  )
  const level = cp.snapshot().rooms['level:1']
  const parent = cp.snapshot().rounds[parentRound.roundId]
  check('resolving an unresolved item updates the room and its round',
    resolved.status === 'resolved'
      && level.unresolved[0].status === 'resolved'
      && parent.unresolved[0].status === 'resolved',
    JSON.stringify({ resolved, level: level.unresolved, parent: parent.unresolved }))

  const unifiedSend = tool('lead', 'send_message')
  let missingDelivery
  try {
    await unifiedSend.execute({ target: 'lead-a', message: 'missing intent' }, { agent: lead, signal })
  } catch (error) {
    missingDelivery = String(error?.message ?? error)
  }
  check('send_message refuses a missing delivery intent before sending',
    /delivery-intent-required/.test(missingDelivery ?? ''), missingDelivery)
  const groupSend = tool('lead-a', 'send_message')
  const actionDelivery = await groupSend.execute({
    target: 'm2',
    message: 'perform the next action now',
    delivery: 'action',
    reason: 'exercise the unified action path',
  }, { agent: groupLead, signal })
  check('send_message delivery:action routes through the waking path',
    actionDelivery.delivery === 'action'
      && ['delivered', 'coalesced'].includes(actionDelivery.status)
      && sent[sent.length - 1]?.caller === 'lead-a'
      && sent[sent.length - 1]?.target === 'm2',
    JSON.stringify(actionDelivery))
  const memberSend = tool('m2', 'send_message')
  const decisionDelivery = await memberSend.execute({
    target: 'lead-a',
    message: 'the work is blocked on a decision',
    delivery: 'decision',
    blocked_action: 'approve the next scope',
    reason: 'only the group lead can approve it',
    evidence: ['focused test fixture block'],
  }, { agent: memberTwo, signal })
  check('send_message delivery:decision requires and carries superior evidence',
    decisionDelivery.delivery === 'decision'
      && ['delivered', 'coalesced'].includes(decisionDelivery.status),
    JSON.stringify(decisionDelivery))
} catch (error) {
  failed += 1
  console.log('FAIL phase8 harness: ' + String(error?.stack ?? error))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
