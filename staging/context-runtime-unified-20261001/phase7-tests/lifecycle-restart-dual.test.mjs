#!/usr/bin/env node
/**
 * Phase 7: process restart, dormant work recovery, scaled long-session compaction,
 * and two Teams mutating one durable directory concurrently.
 *
 * The long-session budget is intentionally scaled to 1,000 tokens. It exercises
 * the same pre-step/compaction state machine at 85% without buying an 800k-token
 * provider run merely to prove a threshold comparison.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : ''))
}

const controlModuleUrl = pathToFileURL(
  'D:\\dsh-test\\home\\profiles\\web\\plugins\\team-control-plane.mjs',
).href
const milestoneModuleUrl = pathToFileURL(
  'D:\\dsh-test\\home\\profiles\\web\\plugins\\team-milestone-v2.mjs',
).href
const compactionModuleUrl = pathToFileURL(
  'D:\\dsh-test\\home\\profiles\\web\\plugins\\step-compaction-v3.mjs',
).href

const runChild = (script, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', reject)
  child.on('exit', (code) => {
    if (code === 0) resolve(stdout.trim())
    else reject(new Error('child exit ' + code + ': ' + stderr))
  })
})

const root = mkdtempSync(join(tmpdir(), 'dsh-v5-lifecycle-'))
const controlDir = join(root, 'control')
const milestonePath = join(root, 'milestones.json')

const restartWriter = `
  import { controlPlaneFor } from ${JSON.stringify(controlModuleUrl)}
  import { createMilestoneDoc, setMilestone, markMilestoneDone } from ${JSON.stringify(milestoneModuleUrl)}
  import { writeFileSync } from 'node:fs'
  const cp = controlPlaneFor('restart-team', { directory: process.env.CONTROL_DIR })
  await cp.roomOpen({ roomId: 'task:restart', kind: 'task', title: 'restart recovery', members: ['lead', 'member'] })
  await cp.roomJoin('task:restart', 'lead')
  await cp.roomJoin('task:restart', 'member')
  const round = await cp.roomNext({ roomId: 'task:restart', topic: 'resume', members: ['lead', 'member'] })
  await cp.roomPost({ roomId: round.roomId, roundId: round.roundId, author: 'lead', content: 'plan the recovery', kind: 'proposal' })
  await cp.roomPost({ roomId: round.roomId, roundId: round.roundId, author: 'member', content: 'checkpoint is durable', kind: 'fact' })
  await cp.roomClose({ roomId: round.roomId, roundId: round.roundId, summary: 'recovery plan recorded' })
  await cp.planPropose({
    taskId: 'restart-task',
    requirementId: 'REQ-RESTART',
    goal: 'resume a stopped member without losing facts',
    members: ['lead', 'member'],
    writeScopes: ['src'],
    checks: { member: ['node --check src/index.mjs'] },
    rollback: 'revert',
    proposedBy: 'lead',
  })
  await cp.planApprove({ taskId: 'restart-task', approvedBy: 'lead' })
  let task = await cp.boardCreate({
    boardId: 'global',
    taskId: 'restart-task',
    subject: 'restart recovery',
    description: 'durable lifecycle',
    writeScopes: ['src'],
  })
  const phase = async (next) => {
    task = await cp.boardUpdate({
      boardId: 'global',
      taskId: 'restart-task',
      expectedRevision: task.revision,
      action: 'advance_phase',
      phase: next,
      actorName: 'lead',
    })
  }
  await phase('room-discussion')
  await phase('plan-proposed')
  await phase('plan-approved')
  task = await cp.boardUpdate({
    boardId: 'global',
    taskId: 'restart-task',
    expectedRevision: task.revision,
    action: 'claim',
    actorName: 'member',
  })
  await phase('execution')
  const dispatch = await cp.dispatchCreate({
    taskId: 'restart-task',
    roomId: round.roomId,
    sender: 'lead',
    target: 'member',
    message: 'resume from checkpoint',
    wakeup: false,
  })
  await cp.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'queued' })
  await cp.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' })
  const lease = await cp.leaseAcquire({
    member: 'member',
    taskId: 'restart-task',
    dispatchId: dispatch.dispatchId,
    expiresAt: Date.now() + 60000,
  })
  await cp.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'turn-started', runId: lease.runId })
  await cp.leaseHeartbeat({ runId: lease.runId, checkpoint: 'before process stop' })
  await cp.dispatchTransition({
    dispatchId: dispatch.dispatchId,
    status: 'checkpointed',
    runId: lease.runId,
    checkpoint: 'before process stop',
  })
  const dormant = await cp.dispatchCreate({
    taskId: 'restart-task',
    roomId: round.roomId,
    sender: 'lead',
    target: 'member',
    message: 'queued while dormant',
    wakeup: false,
  })
  await cp.dispatchTransition({ dispatchId: dormant.dispatchId, status: 'queued' })
  const wake = await cp.wakeClaim({
    episodeId: 'idle:restart-team:1',
    roomId: round.roomId,
    sender: 'team-idle-watch',
    target: 'lead',
    messageHash: 'idle-hash',
  })
  const doc = createMilestoneDoc()
  setMilestone(doc, 'member', 'checkpoint persisted', 'dispatch checkpoint exists', Date.now())
  markMilestoneDone(doc, 'member', Date.now())
  writeFileSync(process.env.MILESTONE_PATH, JSON.stringify(doc, null, 1), 'utf8')
  await cp.flush()
  console.log(JSON.stringify({
    dispatchId: dispatch.dispatchId,
    dormantId: dormant.dispatchId,
    runId: lease.runId,
    wakeId: wake.dispatch.dispatchId,
  }))
`

const restartReader = `
  import { controlPlaneFor } from ${JSON.stringify(controlModuleUrl)}
  import { compactOnIdle, preStepBudget } from ${JSON.stringify(compactionModuleUrl)}
  import { readFileSync } from 'node:fs'
  const cp = controlPlaneFor('restart-team', { directory: process.env.CONTROL_DIR })
  const before = cp.snapshot()
  const task = cp.boardGet('global', 'restart-task')
  const dispatch = cp.dispatchGet(process.env.DISPATCH_ID)
  const dormant = cp.dispatchGet(process.env.DORMANT_ID)
  const lease = cp.leaseGet(process.env.RUN_ID)
  const injected = {
    teams: { tryMembership: () => ({ name: 'member' }) },
    meter: { measure: () => ({ totalTokens: 851 }) },
    engine: { compactNow: async () => ({ committed: true }) },
  }
  const agent = { session: {} }
  const cfg = {
    milestonePath: process.env.MILESTONE_PATH,
    windowTokens: 1000,
    reservedOutputTokens: 100,
    safetyMarginTokens: 50,
  }
  const budget = preStepBudget({}, cfg, agent, 851, injected)
  const compacted = await compactOnIdle({}, cfg, agent, undefined, injected)
  const afterCompact = JSON.parse(readFileSync(process.env.MILESTONE_PATH, 'utf8'))
  await cp.dispatchTransition({ dispatchId: process.env.DORMANT_ID, status: 'delivered' })
  const resumed = await cp.leaseAcquire({
    member: 'member-2',
    taskId: 'restart-task',
    dispatchId: process.env.DORMANT_ID,
    expiresAt: Date.now() + 60000,
  })
  await cp.dispatchTransition({ dispatchId: process.env.DORMANT_ID, status: 'turn-started', runId: resumed.runId })
  await cp.leaseHeartbeat({ runId: resumed.runId, checkpoint: 'after restart' })
  await cp.dispatchTransition({
    dispatchId: process.env.DORMANT_ID,
    status: 'checkpointed',
    runId: resumed.runId,
    checkpoint: 'after restart',
  })
  await cp.leaseRelease({ runId: resumed.runId, status: 'completed' })
  await cp.dispatchTransition({ dispatchId: process.env.DORMANT_ID, status: 'completed', runId: resumed.runId })
  await cp.leaseRelease({ runId: process.env.RUN_ID, status: 'completed' })
  await cp.dispatchTransition({ dispatchId: process.env.DISPATCH_ID, status: 'response-recorded', runId: process.env.RUN_ID })
  await cp.dispatchTransition({ dispatchId: process.env.DISPATCH_ID, status: 'completed', runId: process.env.RUN_ID })
  const finishPhase = async (next) => {
    const latest = cp.boardGet('global', 'restart-task')
    return cp.boardUpdate({
      boardId: 'global',
      taskId: 'restart-task',
      expectedRevision: latest.revision,
      action: 'advance_phase',
      phase: next,
      actorName: 'lead',
    })
  }
  const completed = await cp.boardUpdate({
    boardId: 'global',
    taskId: 'restart-task',
    expectedRevision: task.revision,
    action: 'complete',
    actorName: 'member',
    commitSha: 'restart-sha',
    evidenceIds: ['restart-evidence'],
  })
  await finishPhase('group-check')
  await finishPhase('verifier-review')
  await finishPhase('integration-ready')
  await finishPhase('integrated')
  await finishPhase('accepted')
  const wakeAgain = await cp.wakeClaim({
    episodeId: 'idle:restart-team:1',
    roomId: 'task:restart',
    sender: 'team-idle-watch',
    target: 'lead',
    messageHash: 'idle-hash',
  })
  await cp.flush()
  console.log(JSON.stringify({
    hadRoom: before.rooms['task:restart']?.summary === 'recovery plan recorded',
    planApproved: before.plans['restart-task']?.state === 'plan-approved',
    taskBefore: task.phase,
    dispatchBefore: dispatch.status,
    dormantBefore: dormant.status,
    leaseBefore: lease.status,
    budgetRefused: budget.ok === false && budget.tokens === 851 && budget.window === 1000,
    compacted,
    compactionStatus: afterCompact.compactions.member?.status,
    compactionAttempts: afterCompact.compactions.member?.attempts,
    resumedCheckpoint: cp.dispatchGet(process.env.DORMANT_ID)?.lastCheckpoint?.value,
    completedPhase: completed.phase,
    finalPhase: cp.boardGet('global', 'restart-task')?.phase,
    wakeCoalesced: wakeAgain.claimed === false,
  }))
`

const dualTeamWriter = `
  import { controlPlaneFor } from ${JSON.stringify(controlModuleUrl)}
  const rootId = process.env.ROOT_ID
  const cp = controlPlaneFor(rootId, { directory: process.env.CONTROL_DIR })
  const roomId = 'room:' + rootId
  await cp.roomOpen({ roomId, kind: 'group', title: rootId, members: ['lead-' + rootId, 'member-' + rootId] })
  const round = await cp.roomNext({ roomId, topic: 'isolated', members: ['lead-' + rootId, 'member-' + rootId] })
  await cp.roomPost({ roomId, roundId: round.roundId, author: 'lead-' + rootId, content: rootId + ' proposal', kind: 'proposal' })
  await cp.planPropose({
    taskId: 'task-' + rootId,
    requirementId: 'REQ-' + rootId,
    goal: rootId + ' goal',
    members: ['lead-' + rootId, 'member-' + rootId],
    writeScopes: ['src/' + rootId],
    checks: { member: ['node --check src/' + rootId + '.mjs'] },
    rollback: 'revert',
    proposedBy: 'lead-' + rootId,
  })
  await cp.planApprove({ taskId: 'task-' + rootId, approvedBy: 'lead-' + rootId })
  await cp.boardCreate({ boardId: 'group-' + rootId, taskId: 'task-' + rootId, subject: rootId, description: rootId, writeScopes: ['src/' + rootId] })
  const dispatch = await cp.dispatchCreate({ taskId: 'task-' + rootId, roomId, sender: 'lead-' + rootId, target: 'member-' + rootId, message: rootId, wakeup: false })
  await cp.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'queued' })
  await cp.countersUpdate({ activeSlots: 1, lifetimeCreates: 1, tokenUsed: rootId === 'dual-a' ? 11 : 17 })
  await cp.flush()
`

try {
  resetControlPlaneCache()
  const first = JSON.parse(await runChild(restartWriter, {
    CONTROL_DIR: controlDir,
    MILESTONE_PATH: milestonePath,
  }))
  check('first process writes a durable checkpoint and dormant queue',
    typeof first.dispatchId === 'string' && typeof first.dormantId === 'string' && typeof first.runId === 'string'
      && first.wakeId.startsWith('wake:'))
  check('control snapshot and audit sidecar exist after first process',
    existsSync(join(controlDir, 'restart-team.json'))
      && existsSync(join(controlDir, 'restart-team.json.audit.jsonl')))

  const second = JSON.parse(await runChild(restartReader, {
    CONTROL_DIR: controlDir,
    MILESTONE_PATH: milestonePath,
    DISPATCH_ID: first.dispatchId,
    DORMANT_ID: first.dormantId,
    RUN_ID: first.runId,
  }))
  check('cold restart restores room, approved plan and running task',
    second.hadRoom === true && second.planApproved === true && second.taskBefore === 'execution')
  check('cold restart restores checkpointed and queued dispatch state',
    second.dispatchBefore === 'checkpointed' && second.dormantBefore === 'queued' && second.leaseBefore === 'active')
  check('an 85% scaled long-session request is refused before overflow',
    second.budgetRefused === true)
  check('milestone compaction is performed after restart and persisted',
    String(second.compacted).startsWith('folded:')
      && second.compactionStatus === 'compacted'
      && Number(second.compactionAttempts) >= 1, JSON.stringify(second))
  check('dormant dispatch is delivered, checkpointed and completed after restart',
    second.resumedCheckpoint === 'after restart')
  check('task can cross the complete phase state machine to accepted',
    second.completedPhase === 'member-check' && second.finalPhase === 'accepted')
  check('duplicate idle wake is coalesced after restart',
    second.wakeCoalesced === true)

  await Promise.all([
    runChild(dualTeamWriter, { CONTROL_DIR: controlDir, ROOT_ID: 'dual-a' }),
    runChild(dualTeamWriter, { CONTROL_DIR: controlDir, ROOT_ID: 'dual-b' }),
  ])
  resetControlPlaneCache()
  const dualA = controlPlaneFor('dual-a', { directory: controlDir }).snapshot()
  const dualB = controlPlaneFor('dual-b', { directory: controlDir }).snapshot()
  check('two Teams can mutate one durable directory concurrently without loss',
    dualA.rooms['room:dual-a'] !== undefined
      && dualB.rooms['room:dual-b'] !== undefined
      && dualA.plans['task-dual-a']?.state === 'plan-approved'
      && dualB.plans['task-dual-b']?.state === 'plan-approved')
  check('Team A never sees Team B rooms, plans or boards',
    dualA.rooms['room:dual-b'] === undefined
      && dualA.plans['task-dual-b'] === undefined
      && dualA.boards['group-dual-b'] === undefined)
  check('Team B never sees Team A rooms, plans or boards',
    dualB.rooms['room:dual-a'] === undefined
      && dualB.plans['task-dual-a'] === undefined
      && dualB.boards['group-dual-a'] === undefined)
  check('Team counters remain isolated under concurrent writes',
    dualA.counters.tokenUsed === 11 && dualB.counters.tokenUsed === 17)
} catch (error) {
  failed += 1
  console.log('FAIL lifecycle harness: ' + String(error?.stack ?? error))
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
