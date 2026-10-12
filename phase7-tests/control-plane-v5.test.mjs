import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import { preStepBudget } from '../home/profiles/web/plugins/step-compaction.mjs'

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed++
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : ''))
}
const expectReject = async (label, fn) => {
  try {
    await fn()
    check(label, false, 'did not reject')
  } catch (error) {
    check(label, true, String(error?.message ?? error))
  }
}

const rootA = mkdtempSync(join(tmpdir(), 'dsh-v5-a-'))
const rootB = mkdtempSync(join(tmpdir(), 'dsh-v5-b-'))
const rootC = mkdtempSync(join(tmpdir(), 'dsh-v5-c-'))
const rootD = mkdtempSync(join(tmpdir(), 'dsh-v5-d-'))
const controlModuleUrl = new URL('../home/profiles/web/plugins/team-control-plane.mjs', import.meta.url).href
const runChild = (script, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', reject)
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('child exit ' + code + ': ' + stderr)))
})
try {
  resetControlPlaneCache()
  const a = controlPlaneFor('same-team', { directory: rootA })
  const b = controlPlaneFor('same-team', { directory: rootB })
  await a.roomOpen({ roomId: 'group:alpha:tier-2', kind: 'group', title: 'alpha', members: ['lead', 'a1', 'c1'] })
  await a.roomJoin('group:alpha:tier-2', 'lead')
  await a.roomJoin('group:alpha:tier-2', 'a1')
  await a.roomJoin('group:alpha:tier-2', 'c1')
  const round = await a.roomNext({ roomId: 'group:alpha:tier-2', topic: 'interface', members: ['lead', 'a1', 'c1'] })
  const first = await a.roomPost({ roomId: round.roomId, roundId: round.roundId, author: 'lead', content: 'proposal', kind: 'proposal' })
  check('room round-robin accepts current speaker', first.author === 'lead' && first.roundId === round.roundId)
  const clarification = await a.roomPost({
    roomId: round.roomId,
    roundId: round.roundId,
    author: 'lead',
    content: 'one short clarification',
    kind: 'clarification',
  })
  check('one clarification is accepted without advancing the turn',
    clarification.kind === 'clarification' && a.snapshot().rounds[round.roundId].nextSpeaker === 'a1')
  await expectReject('a second clarification is refused', () => a.roomPost({
    roomId: round.roomId,
    roundId: round.roundId,
    author: 'lead',
    content: 'again',
    kind: 'clarification',
  }))
  await expectReject('a non-turn main speech is refused', () => a.roomPost({
    roomId: round.roomId,
    roundId: round.roundId,
    author: 'c1',
    content: 'not yet',
    kind: 'fact',
  }))
  await expectReject('a second open round is refused', () => a.roomNext({
    roomId: round.roomId,
    topic: 'another',
    members: ['lead', 'a1', 'c1'],
  }))
  await expectReject('a round cannot close before every participant speaks', () => a.roomClose({
    roomId: round.roomId,
    roundId: round.roundId,
    summary: 'premature',
  }))
  await a.roomPost({ roomId: round.roomId, roundId: round.roundId, author: 'a1', content: 'ack', kind: 'fact' })
  await a.roomPost({ roomId: round.roomId, roundId: round.roundId, author: 'c1', content: 'done', kind: 'fact' })
  await expectReject('a duplicate main speech is refused', () => a.roomPost({
    roomId: round.roomId,
    roundId: round.roundId,
    author: 'a1',
    content: 'duplicate',
    kind: 'fact',
  }))
  const closed = await a.roomClose({ roomId: round.roomId, roundId: round.roundId, summary: 'resolved' })
  check('room close persists summary and closed round',
    closed.round.status === 'closed' && closed.round.summary === 'resolved' && closed.room.summary === 'resolved')
  const nextRound = await a.roomNext({ roomId: round.roomId, topic: 'second', members: ['lead', 'a1'] })
  check('a closed round allows a new round', nextRound.status === 'open' && nextRound.roundId !== round.roundId)
  await a.roomPost({ roomId: round.roomId, roundId: nextRound.roundId, author: 'lead', content: 'lead summary', kind: 'fact' })
  await a.roomPost({ roomId: round.roomId, roundId: nextRound.roundId, author: 'a1', content: 'member summary', kind: 'fact' })
  await a.roomClose({ roomId: round.roomId, roundId: nextRound.roundId, summary: 'second resolved' })
  await a.roomOpen({ roomId: 'group:budget:tier-2', kind: 'group', title: 'budget', members: ['lead'] })
  for (let index = 1; index <= 3; index += 1) {
    const budgetRound = await a.roomNext({ roomId: 'group:budget:tier-2', topic: 'budget ' + String(index), members: ['lead'] })
    await a.roomPost({ roomId: 'group:budget:tier-2', roundId: budgetRound.roundId, author: 'lead', content: 'round ' + String(index), kind: 'fact' })
    await a.roomClose({ roomId: 'group:budget:tier-2', roundId: budgetRound.roundId, summary: 'round ' + String(index) })
  }
  await expectReject('a fourth room round is refused by the three-round budget', () => a.roomNext({
    roomId: 'group:budget:tier-2',
    topic: 'fourth',
    members: ['lead'],
  }))
  await expectReject('open round cannot escalate normally', () => a.escalate({
    category: 'blocked', summary: 'x', decisionNeeded: 'choose', roomId: round.roomId,
    roundId: 'missing', references: ['test'], urgency: 'normal',
  }))
  const esc = await a.escalate({
    category: 'blocked', summary: 'x', decisionNeeded: 'choose', roomId: round.roomId,
    roundId: round.roundId, options: [{ id: 'A', tradeoff: 'pick one' }], references: ['test'], urgency: 'normal',
  })
  check('closed round accepts evidence-backed escalation', esc.status === 'queued')
  const wakeOne = await a.wakeClaim({
    episodeId: 'escalation:lead', roomId: round.roomId, sender: 'a1', target: 'lead', messageHash: 'one',
  })
  const wakeTwo = await a.wakeClaim({
    episodeId: 'escalation:lead', roomId: round.roomId, sender: 'a1', target: 'lead', messageHash: 'two',
  })
  check('one target episode coalesces multiple escalations',
    wakeOne.claimed === true && wakeTwo.claimed === false && wakeTwo.dispatch.mergedCount === 1)
  const acknowledgedWake = await a.wakeAcknowledge({ episodeId: 'escalation:lead', status: 'delivered' })
  check('wake delivery acknowledgement advances the episode without starting a turn',
    acknowledgedWake.episode.status === 'delivered' && acknowledgedWake.dispatch.status === 'delivered')
  const startedWake = await a.wakeAcknowledge({ episodeId: 'escalation:lead', status: 'turn-started' })
  check('a control wake completes when the target turn actually starts',
    startedWake.episode.status === 'completed' && startedWake.dispatch.status === 'completed'
      && startedWake.dispatch.resolvedAt !== null)
  check('different control directories stay isolated', b.snapshot().rooms?.[round.roomId] === undefined)

  writeFileSync(join(rootD, 'legacy-team.json'), JSON.stringify({
    rootId: 'legacy-team',
    rooms: {
      'task:legacy-empty': {
        roomId: 'task:legacy-empty',
        kind: 'task',
        host: null,
        members: ['lead'],
        status: 'open',
        createdAt: Date.now() - 10 * 60 * 1000,
        currentRoundId: null,
        messages: [],
        decisions: [],
        unresolved: [],
      },
    },
  }))
  const legacy = controlPlaneFor('legacy-team', { directory: rootD })
  check('legacy empty task room is removed from persisted state',
    legacy.snapshot().rooms?.['task:legacy-empty'] === undefined)

  const childScript = `
    import { controlPlaneFor } from ${JSON.stringify(controlModuleUrl)}
    const cp = controlPlaneFor('concurrent-team', { directory: process.env.TEST_CONTROL_DIR })
    await cp.roomOpen({ roomId: process.env.TEST_ROOM, kind: 'task', title: process.env.TEST_ROOM, members: ['lead'] })
    await cp.flush()
  `
  await Promise.all([
    runChild(childScript, { TEST_CONTROL_DIR: rootC, TEST_ROOM: 'task:one' }),
    runChild(childScript, { TEST_CONTROL_DIR: rootC, TEST_ROOM: 'task:two' }),
  ])
  resetControlPlaneCache()
  const concurrent = controlPlaneFor('concurrent-team', { directory: rootC })
  check('cross-process mutations keep both durable rooms',
    concurrent.snapshot().rooms?.['task:one'] !== undefined
      && concurrent.snapshot().rooms?.['task:two'] !== undefined)

  const plan = await a.planPropose({
    taskId: 'task-1', requirementId: 'REQ-1', goal: 'ship', members: ['lead', 'a1'],
    writeScopes: ['src'], checks: { member: ['node --check src/a.mjs'] }, rollback: 'revert',
    proposedBy: 'lead',
  })
  check('plan starts proposed', plan.state === 'plan-proposed')
  await expectReject('execution gate rejects unapproved plan', () => Promise.resolve(a.planRequireApproved('task-1')))
  const approved = await a.planApprove({ taskId: 'task-1', approvedBy: 'lead' })
  check('plan approval is durable', approved.state === 'plan-approved' && a.planRequireApproved('task-1').approvedBy === 'lead')

  const task = await a.boardCreate({ boardId: 'group-alpha', taskId: 'task-1', subject: 'ship', description: 'd', writeScopes: ['src'] })
  const updated = await a.boardUpdate({ boardId: 'group-alpha', taskId: 'task-1', expectedRevision: task.revision, action: 'claim', actorName: 'a1' })
  check('board CAS claim advances revision', updated.status === 'in_progress' && updated.revision === 2)
  await expectReject('stale board revision is refused', () => a.boardUpdate({ boardId: 'group-alpha', taskId: 'task-1', expectedRevision: 1, action: 'complete', actorName: 'a1' }))
  const evidence = await a.evidencePut({ taskId: 'task-1', commitSha: 'abc123', requirementId: 'REQ-1', kind: 'test', command: 'node --check src/a.mjs', output: 'ok' })
  const afterEvidence = a.boardGet('group-alpha', 'task-1')
  const completed = await a.boardUpdate({ boardId: 'group-alpha', taskId: 'task-1', expectedRevision: afterEvidence.revision, action: 'complete', actorName: 'a1', commitSha: 'abc123', evidenceIds: [evidence.evidenceId] })
  check('completed task persists exact commit and evidence ids', completed.status === 'completed' && completed.commitSha === 'abc123' && completed.evidenceIds[0] === evidence.evidenceId)

  const dispatch = await a.dispatchCreate({ taskId: 'task-1', sender: 'lead', target: 'a1', message: 'run', wakeup: false })
  await a.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'queued' })
  await a.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' })
  const lease = await a.leaseAcquire({ member: 'a1', taskId: 'task-1', dispatchId: dispatch.dispatchId })
  await a.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'turn-started', runId: lease.runId })
  await a.leaseHeartbeat({ runId: lease.runId, checkpoint: 'tests' })
  await a.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'checkpointed', runId: lease.runId, checkpoint: 'tests' })
  await a.leaseRelease({ runId: lease.runId, status: 'completed' })
  await a.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'completed', runId: lease.runId })
  check('dispatch reaches completed through lease checkpoints', a.dispatchGet(dispatch.dispatchId).status === 'completed' && a.leaseGet(lease.runId).status === 'completed')
  const oneWay = await a.dispatchCreate({ taskId: 'task-1', sender: 'a1', target: 'lead', message: 'status', wakeup: false })
  await a.dispatchTransition({ dispatchId: oneWay.dispatchId, status: 'queued' })
  await a.dispatchTransition({ dispatchId: oneWay.dispatchId, status: 'delivered' })
  await a.dispatchTransition({ dispatchId: oneWay.dispatchId, status: 'completed' })
  check('delivered one-way summaries can complete without a run lease', a.dispatchGet(oneWay.dispatchId).status === 'completed')
  const lease2 = await a.leaseAcquire({ member: 'a1', taskId: 'task-1' })
  await expectReject('one active run lease per member', () => a.leaseAcquire({ member: 'a1', taskId: 'task-1' }))
  await a.leaseRelease({ runId: lease2.runId, status: 'cancelled' })

  const expiredLease = await a.leaseAcquire({ member: 'expired-member', taskId: 'task-expired', expiresAt: Date.now() - 1 })
  const expiredDispatch = await a.dispatchCreate({
    taskId: 'task-expired',
    sender: 'lead',
    target: 'expired-member',
    message: 'expire me',
    deadlineAt: Date.now() - 1,
  })
  await a.dispatchTransition({ dispatchId: expiredDispatch.dispatchId, status: 'queued' })
  await a.dispatchTransition({ dispatchId: expiredDispatch.dispatchId, status: 'delivered' })
  await a.dispatchTransition({ dispatchId: expiredDispatch.dispatchId, status: 'turn-started', runId: expiredLease.runId })
  const reconciled = await a.reconcileDispatches({ maxAttempts: 3, deliveryTimeoutMs: 1000, runTimeoutMs: 1000 })
  check('automatic reconciliation expires stale run leases and dispatches',
    a.leaseGet(expiredLease.runId).status === 'expired'
      && a.dispatchGet(expiredDispatch.dispatchId).status === 'expired'
      && reconciled.changes.some((row) => row.kind === 'lease-expired'))

  const fileBefore = readFileSync(join(rootA, 'same-team.json'), 'utf8')
  const auditAgent = { session: { append() { throw new Error('session event map is closed') } } }
  await a.healthSet({ status: 'healthy', reasons: [] }, auditAgent)
  check('control mutations use a sidecar audit trail', existsSync(join(rootA, 'same-team.json.audit.jsonl')))
  resetControlPlaneCache()
  const recovered = controlPlaneFor('same-team', { directory: rootA })
  check('room survives cold cache restart', recovered.snapshot().rooms[round.roomId].summary === 'second resolved')
  check('board, plan and dispatch survive cold cache restart',
    recovered.boardGet('group-alpha', 'task-1').status === 'completed'
      && recovered.planState('task-1').state === 'plan-approved'
      && recovered.dispatchGet(dispatch.dispatchId).status === 'completed')
  check('durable file was written', fileBefore.includes('"revision"') && recovered.snapshot().revision > 0)

  const milestonePath = join(rootA, 'milestones.json')
  const under = preStepBudget({ agentTeams: { tryMembership: () => ({ name: 'a1' }) } }, {
    milestonePath, windowTokens: 1000, reservedOutputTokens: 100, safetyMarginTokens: 50,
  }, { session: {} }, 800)
  const over = preStepBudget({ agentTeams: { tryMembership: () => ({ name: 'a1' }) } }, {
    milestonePath, windowTokens: 1000, reservedOutputTokens: 100, safetyMarginTokens: 50,
  }, { session: {} }, 900)
  check('pre-step budget allows safe request', under.ok === true)
  check('pre-step budget refuses over-window request', over.ok === false && over.reason === 'context-budget')
} finally {
  rmSync(rootA, { recursive: true, force: true })
  rmSync(rootB, { recursive: true, force: true })
  rmSync(rootC, { recursive: true, force: true })
  rmSync(rootD, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
