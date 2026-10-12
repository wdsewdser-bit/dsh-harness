import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  memberWorktreeSyncPlan,
  mergePhaseAdvanceVerdict,
  planApprovalVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { withMergeLock, worktreeAdd } from '../home/profiles/web/plugins/team-worktree.mjs'
import {
  dependencySatisfied,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  createReadyQueueContext,
  evaluateReadyTask,
  resolveEvidenceId,
} from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import {
  contractRevisionVerdict,
  evidenceQueryEnvelope,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { resolveWaiting } from '../home/profiles/web/plugins/team-v14-waiting.mjs'

test('B-85: a group lead cannot approve foreign-group or global-scope plans', () => {
  const lead = { name: 'lead-proto', tier: 1, group: 'proto' }
  const members = [{ name: 'member-a', tier: 2, group: 'proto' }]

  assert.equal(planApprovalVerdict(lead, {
    taskId: 'group-proto-t99',
    members,
    writeScopes: ['crates/mc-proto/src/lib.rs', 'docs/groups/proto/spec.md'],
  }, 'group-proto').ok, true)

  const foreign = planApprovalVerdict(lead, {
    taskId: 'group-proto-t99',
    members,
    writeScopes: ['docs/groups/world/foreign.md'],
  }, 'group-proto')
  assert.equal(foreign.ok, false)
  assert.match(foreign.reason, /world.*proto/)

  const global = planApprovalVerdict(lead, {
    taskId: 'group-proto-t99',
    members,
    writeScopes: ['docs/GOVERNANCE.md'],
  }, 'group-proto')
  assert.equal(global.ok, false)
  assert.match(global.reason, /global documentation/)

  const globalCard = planApprovalVerdict(lead, {
    taskId: 'task-99',
    members,
    writeScopes: ['crates/mc-proto/src/lib.rs'],
  }, 'global')
  assert.equal(globalCard.ok, false)
  assert.match(globalCard.reason, /group board/)
})

test('B-86: evidence query envelope exposes prefix status and rejected form', () => {
  const registry = {
    records: {
      one: {
        id: 'evidence-7619de69-21ff-4056-9174-9351ab0da5c8',
        kind: 'one',
      },
    },
  }
  const resolved = resolveEvidenceId(registry, 'evidence-7619de69')
  const envelope = evidenceQueryEnvelope({
    requestedId: 'evidence-7619de69',
    requestedField: 'id',
    resolved,
    rows: resolved.rows,
    total: 1,
    visible: 1,
    tier: 1,
  })
  assert.equal(envelope.idResolution.status, 'resolved-prefix')
  assert.equal(envelope.visibility.queryKey.form, 'prefix')
  assert.equal(envelope.visibility.queryKey.accepted, true)
  assert.equal(envelope.visibility.idStatus, 'resolved-prefix')
  assert.equal(envelope.visibility.candidateCount, 1)

  const invalidResolved = resolveEvidenceId(registry, 'not an evidence id')
  const invalid = evidenceQueryEnvelope({
    requestedId: 'not an evidence id',
    requestedField: 'evidenceId',
    resolved: invalidResolved,
    rows: [],
    total: 1,
    visible: 1,
    tier: 1,
  })
  assert.equal(invalid.formRejected.code, 'evidence-id-form')
  assert.equal(invalid.visibility.queryKey.field, 'evidenceId')
  assert.equal(invalid.visibility.queryKey.accepted, false)
})

test('waiting_resolve is idempotent and can match the waiter when the task owner changed', () => {
  const state = {
    v14Waiting: {
      tickets: {
        'wait:t1:member-a:one': {
          ticketId: 'wait:t1:member-a:one',
          taskId: 't1',
          owner: 'old-owner',
          waiter: 'member-a',
          responsible: 'lead-a',
          status: 'open',
          createdAt: 1,
          updatedAt: 1,
        },
      },
    },
  }
  const resolved = resolveWaiting(state, {
    taskId: 't1',
    owner: 'new-owner',
    waiter: 'member-a',
    responsible: 'lead-a',
    resolution: 'condition cleared',
  }, 'member-a')
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.alreadyResolved, false)
  assert.equal(state.v14Waiting.tickets['wait:t1:member-a:one'].resolution, 'condition cleared')

  const repeated = resolveWaiting(state, {
    taskId: 't1',
    owner: 'new-owner',
    waiter: 'member-a',
  }, 'member-a')
  assert.equal(repeated.status, 'resolved')
  assert.equal(repeated.alreadyResolved, true)
})

test('B-87: dependency release requires final acceptance, not completed alone', () => {
  assert.equal(dependencySatisfied({ status: 'completed', phase: 'integration-ready' }), false)
  assert.equal(dependencySatisfied({ status: 'completed', phase: 'integrated' }), false)
  assert.equal(dependencySatisfied({ status: 'completed', phase: 'accepted' }), true)
  assert.equal(dependencySatisfied({ status: 'pending', phase: 'accepted' }), false)

  const dependency = { id: 'dep', status: 'completed', phase: 'integration-ready' }
  const dependent = {
    id: 'downstream',
    status: 'pending',
    phase: 'plan-approved',
    ownerName: 'member-a',
    blockedBy: ['dep'],
    acceptanceCriteria: ['must use the integrated dependency'],
    writeScopes: ['src/output.rs'],
  }
  const context = createReadyQueueContext([dependency, dependent], [{ name: 'member-a', status: 'active' }], [])
  const row = evaluateReadyTask(dependent, context)
  assert.equal(row.eligible, false)
  assert.ok(row.reasons.includes('dependencies-unmet'))
})

test('B-88: merge lock is outside the destination worktree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b88-'))
  try {
    const outcome = await withMergeLock(directory, async () => ({
      ok: true,
      lockInsideRepo: existsSync(join(directory, '.dsh-merge.lock')),
    }))
    assert.deepEqual(outcome, { ok: true, lockInsideRepo: false })
    assert.equal(existsSync(join(directory, '.dsh-merge.lock')), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-89: merge phase reporting distinguishes an idempotent no-op', () => {
  assert.deepEqual(mergePhaseAdvanceVerdict('integration-ready', 'integrated'), {
    status: 'advanced',
    phase: 'integrated',
  })
  assert.deepEqual(mergePhaseAdvanceVerdict('accepted', 'accepted'), {
    status: 'already-at-or-beyond',
    phase: 'accepted',
  })
})

test('B-91: lease-time member worktree sync fast-forwards the member branch to main', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b91-'))
  const repo = join(directory, 'repo')
  const branch = 'team/world/member-a'
  const worktree = join(repo, '.dsh-worktrees', 'team__world__member-a')
  const git = (args, cwd = repo) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    mkdirSync(repo, { recursive: true })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'team@example.test'])
    git(['config', 'user.name', 'Team Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(['add', 'base.txt'])
    git(['commit', '-m', 'base'])
    git(['branch', branch])
    const first = worktreeAdd(repo, worktree, branch, 'main', undefined, false)
    assert.equal(first.ok, true)
    writeFileSync(join(repo, 'main-only.txt'), 'main\n')
    git(['add', 'main-only.txt'])
    git(['commit', '-m', 'main advance'])

    const plan = memberWorktreeSyncPlan(
      { tier: 2, group: 'world' },
      { worktreePath: worktree },
      repo,
      '.dsh-worktrees',
      'member-a',
    )
    assert.deepEqual(plan, { branch, path: worktree })
    const synced = worktreeAdd(repo, plan.path, plan.branch, 'main', undefined, false)
    assert.equal(synced.ok, true)
    assert.equal(existsSync(join(worktree, 'main-only.txt')), true)
    assert.doesNotThrow(() => git(['merge-base', '--is-ancestor', 'main', branch]))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-90: contract writes expose a compare-and-set conflict', () => {
  assert.equal(contractRevisionVerdict(7, 7).ok, true)
  const stale = contractRevisionVerdict(8, 7)
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale-contract-revision')
  assert.equal(stale.currentRevision, 8)
  assert.equal(stale.expectedRevision, 7)
  assert.match(stale.detail, /reread the contract/)
})
