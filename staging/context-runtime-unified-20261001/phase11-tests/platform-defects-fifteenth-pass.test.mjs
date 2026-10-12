import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  controlPlaneLockTimeoutMessage,
  normalizeStoredTask,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  createWakeState,
  deliverWakeBatch,
  handleInboxMessage,
  handleWakeBatch,
  markWakeInjected,
  requestWake,
} from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import {
  deriveWaitingTickets,
  projectWaitingTickets,
  reconcileWaitingTickets,
  recordWaiting,
  resolveWaiting,
} from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import { waitingResolveInputVerdict } from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import {
  clearanceDestinationMetadata,
  clearanceLandingVerdict,
  memberMergeSourceVerdict,
  taskCommitShaVerdict,
  taskIntegrationVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { runGit } from '../home/profiles/web/plugins/team-worktree.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function runner(cwd, argv) {
  return runGit(cwd, argv)
}

test('B-156: waiting projections expose an inactive responsible member', () => {
  const state = {
    boards: {
      main: {
        tasks: {
          t: { id: 't', status: 'in_progress', phase: 'execution', ownerName: 'rig-runner', background: true, revision: 1 },
        },
      },
    },
    v14Waiting: { tickets: {} },
  }
  const ticket = recordWaiting(state, {
    taskId: 't',
    owner: 'rig-runner',
    reason: 'background',
    unblockCondition: { type: 'background' },
  }, 'lead-rig', { now: 100 })
  const members = [{ name: 'rig-runner', status: 'inactive' }]
  const derived = deriveWaitingTickets(state, members, 200)
  assert.equal(derived.some((row) => row.responsibleInactive === true), true)
  const projection = projectWaitingTickets(state, {
    stored: [ticket],
    members,
    includeClosed: true,
    now: 200,
  })
  assert.equal(projection.responsibleInactive, 1)
  assert.equal(projection.tickets[0].responsibleInactive, true)
})

test('B-157: lock timeout never claims that no mutation was written', () => {
  const message = controlPlaneLockTimeoutMessage('C:\\state\\team.json')
  assert.match(message, /outcome is unknown/)
  assert.match(message, /query the durable effect before retrying/)
  assert.doesNotMatch(message, /retrying is safe/)
})

test('B-158/B-163: completed commits distinguish integrated from not integrated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b158-b163-'))
  const repo = join(directory, 'repo')
  const source = join(directory, 'source')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b158@example.test'])
    git(repo, ['config', 'user.name', 'B-158 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    git(repo, ['worktree', 'add', '-b', 'team/rig/member', source, 'main'])
    writeFileSync(join(source, 'task.txt'), 'task\n')
    git(source, ['add', 'task.txt'])
    git(source, ['commit', '-m', 'task'])
    const commit = git(source, ['rev-parse', 'HEAD'])
    const task = { status: 'completed', workKind: 'edit', commitSha: commit }

    assert.equal(taskIntegrationVerdict(task, repo, runner).state, 'completed-not-integrated')
    git(repo, ['merge', '--no-ff', '--no-edit', commit])
    assert.equal(taskIntegrationVerdict(task, repo, runner).state, 'integrated-pending-terminal')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-159: a clearance survives only disjoint main advances', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b159-'))
  const repo = join(directory, 'repo')
  const source = join(directory, 'source')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b159@example.test'])
    git(repo, ['config', 'user.name', 'B-159 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    const destinationBefore = git(repo, ['rev-parse', 'main'])
    git(repo, ['worktree', 'add', '-b', 'grp/rig', source, 'main'])
    writeFileSync(join(source, 'task.txt'), 'task\n')
    git(source, ['add', 'task.txt'])
    git(source, ['commit', '-m', 'source'])
    const commit = git(source, ['rev-parse', 'HEAD'])
    const metadata = clearanceDestinationMetadata(commit, repo, runner)
    assert.equal(metadata.ok, true)
    assert.equal(metadata.destinationSha, destinationBefore)

    const record = {
      commit,
      severity: 'condition',
      report: 'b159',
      ...metadata,
    }
    writeFileSync(join(repo, 'docs.txt'), 'docs\n')
    git(repo, ['add', 'docs.txt'])
    git(repo, ['commit', '-m', 'unrelated main advance'])
    const disjointDestination = git(repo, ['rev-parse', 'main'])
    const disjoint = clearanceLandingVerdict(record, {
      commit,
      destinationRef: 'main',
      destinationSha: disjointDestination,
      repo,
      runner,
    })
    assert.equal(disjoint.ok, true)
    assert.equal(disjoint.mode, 'disjoint-destination-advance')

    writeFileSync(join(repo, 'task.txt'), 'main conflict\n')
    git(repo, ['add', 'task.txt'])
    git(repo, ['commit', '-m', 'overlapping main advance'])
    const overlapping = clearanceLandingVerdict(record, {
      commit,
      destinationRef: 'main',
      destinationSha: git(repo, ['rev-parse', 'main']),
      repo,
      runner,
    })
    assert.equal(overlapping.ok, false)
    assert.equal(overlapping.code, 'clearance-destination-overlap')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-160: legacy task-terminal closure records its real reason and accepts a late conclusion', () => {
  const state = {
    boards: {
      main: {
        tasks: {
          t: { id: 't', status: 'completed', phase: 'integration-ready', revision: 2 },
        },
      },
    },
    v14Waiting: { tickets: {} },
  }
  const ticket = recordWaiting(state, {
    taskId: 't',
    owner: 'rig-runner',
    reason: 'legacy',
  }, 'lead-rig', { now: 100 })
  reconcileWaitingTickets(state, { now: 200 })
  assert.equal(ticket.resolution, 'auto:task-terminal')
  assert.equal(ticket.closedReason, 'task-terminal')
  const late = resolveWaiting(state, {
    ticketId: ticket.ticketId,
    resolution: 'verifier concluded and advanced the card',
  }, 'rig-runner', { now: 300 })
  assert.equal(late.alreadyResolved, true)
  assert.equal(late.resolutionUpdated, true)
  assert.equal(ticket.resolution, 'verifier concluded and advanced the card')
  assert.equal(ticket.autoResolution, 'auto:task-terminal')
})

test('B-161: task commit bindings canonicalize and reject sentinel or short values', () => {
  const legacy = {
    status: 'completed',
    phase: 'integration-ready',
    commitSha: 'no-commit:discussion-only-phase',
  }
  normalizeStoredTask(legacy)
  assert.equal(legacy.commitSha, null)
  assert.equal(legacy.commitShaIssue, 'non-commit-sentinel')

  const short = {
    status: 'completed',
    phase: 'integration-ready',
    commitSha: 'abc123',
  }
  normalizeStoredTask(short)
  assert.equal(short.commitSha, null)
  assert.equal(short.commitShaIssue, 'invalid-shape')

  const directory = mkdtempSync(join(tmpdir(), 'dsh-b161-'))
  const repo = join(directory, 'repo')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b161@example.test'])
    git(repo, ['config', 'user.name', 'B-161 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    const full = git(repo, ['rev-parse', 'HEAD'])
    const resolved = taskCommitShaVerdict(full.slice(0, 7), repo, runner)
    assert.equal(resolved.ok, true)
    assert.equal(resolved.commit, full)
    assert.equal(taskCommitShaVerdict('not-a-sha', repo, runner).ok, false)
    const merge = memberMergeSourceVerdict({
      destination: 'grp/rig',
      task: { commitSha: full.slice(0, 7) },
      sourceSha: full,
    })
    assert.equal(merge.ok, false)
    assert.equal(merge.code, 'member-merge-task-commit-invalid')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-170: source-ancestor substitution requires explicit opt-in', () => {
  const taskCommit = 'a'.repeat(40)
  const branchTip = 'b'.repeat(40)
  const implicit = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task: { commitSha: taskCommit },
    sourceSha: branchTip,
    sourceDescendsFromTask: true,
  })
  assert.equal(implicit.ok, false)
  assert.equal(implicit.code, 'member-merge-source-drift')

  const explicit = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task: { commitSha: taskCommit },
    sourceSha: branchTip,
    sourceDescendsFromTask: true,
    allowSourceAncestor: true,
  })
  assert.equal(explicit.ok, true)
  assert.equal(explicit.expected, taskCommit)
  assert.equal(explicit.sourceHead, branchTip)
})

test('B-162: individually settled messages clear the aggregate wake', () => {
  const state = createWakeState()
  const queued = requestWake(state, {
    target: 'lead-rig',
    reason: 'aggregate',
    dedupeKey: 'aggregate-b162',
    messages: [
      { messageId: 'b162-a', originalText: 'one' },
      { messageId: 'b162-b', originalText: 'two' },
    ],
  })
  assert.equal(queued.ok, true)
  const wakeId = queued.wake.wakeId
  assert.equal(deliverWakeBatch(state, wakeId).ok, true)
  assert.equal(markWakeInjected(state, wakeId, { injectionReceipt: 'receipt-b162' }).ok, true)

  const first = handleInboxMessage(state, 'b162-a', { updatedAt: 10 })
  assert.equal(first.handled, true)
  assert.equal(first.wakeStatus, 'delivered')
  assert.equal(first.redeliveryRequired, true)
  const second = handleInboxMessage(state, 'b162-b', { updatedAt: 11 })
  assert.equal(second.wakeStatus, 'handled')
  assert.equal(second.redeliveryRequired, false)
  assert.equal(state.wakes[wakeId].status, 'handled')
  assert.equal(state.wakes[wakeId].redeliveryRequired, false)

  const terminalState = createWakeState()
  const terminal = requestWake(terminalState, {
    target: 'lead-rig',
    reason: 'aggregate-terminal',
    dedupeKey: 'aggregate-terminal-b162',
    messages: [
      { messageId: 'b162-c', originalText: 'three' },
      { messageId: 'b162-d', originalText: 'four' },
    ],
  })
  deliverWakeBatch(terminalState, terminal.wake.wakeId)
  terminalState.inbox['b162-c'].status = 'handled'
  terminalState.inbox['b162-d'].status = 'deduplicated'
  const settled = handleWakeBatch(terminalState, terminal.wake.wakeId)
  assert.equal(settled.ok, true)
  assert.equal(settled.handled, true)
  assert.equal(settled.redeliveryRequired, false)
})

test('O-10-4: waiting_resolve names ticket_id versus task_id mistakes', () => {
  const ticketAsTask = waitingResolveInputVerdict({ taskId: 'wait:group-rig-t45' })
  assert.equal(ticketAsTask.ok, false)
  assert.equal(ticketAsTask.code, 'waiting-ticket-passed-as-task')
  assert.match(ticketAsTask.detail, /pass it as ticket_id/)
  const both = waitingResolveInputVerdict({
    taskId: 'group-rig-t45',
    ticketId: 'wait:group-rig-t45:rig-runner:one',
  })
  assert.equal(both.ok, false)
  assert.equal(both.code, 'waiting-task-and-ticket-ambiguous')
})
