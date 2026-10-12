import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PLAN_REPLACEMENT_RECOVERY,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import {
  mergePhaseAdvanceFailureVerdict,
  mergePhaseAdvanceVerdict,
  memberMergeSourceVerdict,
  taskEditWriteScopeVerdict,
  worktreeTargetVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import {
  ackableWakeIdForInboxRow,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import {
  classifyFailure,
} from '../home/profiles/web/plugins/team-v13-failure-memory.mjs'
import {
  shellWriteTargets,
} from '../home/profiles/web/plugins/write-scope-guard.mjs'

test('B-237 masks PowerShell line and block comments before path extraction', () => {
  const cwd = 'C:\\dsh-test\\workspaces\\RustMc'
  const parsed = shellWriteTargets([
    '# prose with a closed quote "tools/rig-batch/tests/ not-a-path.ps1"',
    '<# block prose "tools/rig-batch/tests/block-not-a-path.ps1" #>',
    "Set-Content -LiteralPath 'tools/rig-batch/tests/actual.ps1' -Value x",
  ].join('\n'), cwd)

  assert.deepEqual(parsed.targets.map((target) => target.replace(/\\/g, '/')), [
    'C:/dsh-test/workspaces/RustMc/tools/rig-batch/tests/actual.ps1',
  ])
  assert.equal(parsed.opaque, false)

  const hashInsideString = shellWriteTargets(
    "Set-Content -LiteralPath 'tools/rig-batch/tests/name#1.ps1' -Value x",
    cwd,
  )
  assert.deepEqual(hashInsideString.targets.map((target) => target.replace(/\\/g, '/')), [
    'C:/dsh-test/workspaces/RustMc/tools/rig-batch/tests/name#1.ps1',
  ])
})

test('B-238 selects commit_sha or branch_head explicitly and preserves the default', () => {
  const taskCommit = 'a'.repeat(40)
  const branchHead = 'b'.repeat(40)
  const task = { commitSha: taskCommit }

  const defaultMemberMerge = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task,
    sourceSha: branchHead,
    sourceDescendsFromTask: true,
  })
  assert.equal(defaultMemberMerge.ok, false)
  assert.equal(defaultMemberMerge.code, 'member-merge-source-drift')

  const commitSource = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task,
    sourceSha: branchHead,
    sourceDescendsFromTask: true,
    allowSourceAncestor: true,
    sourceSelection: 'commit_sha',
  })
  assert.equal(commitSource.ok, true)
  assert.equal(commitSource.mergeSource, taskCommit)
  assert.equal(commitSource.selection, 'commit_sha')

  const branchSource = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task,
    sourceSha: branchHead,
    sourceDescendsFromTask: true,
    sourceSelection: 'branch_head',
  })
  assert.equal(branchSource.ok, true)
  assert.equal(branchSource.mergeSource, branchHead)
  assert.equal(branchSource.selection, 'branch_head')

  const unrelated = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task,
    sourceSha: branchHead,
    sourceDescendsFromTask: false,
    sourceSelection: 'branch_head',
  })
  assert.equal(unrelated.ok, false)
  assert.equal(unrelated.code, 'member-merge-branch-head-not-descendant')
})

test('B-236 exposes both safe plan-replacement recovery paths', () => {
  const reason = taskEditWriteScopeVerdict({
    action: 'edit',
    write_scopes: ['tools/rig-batch/tests'],
  }, { planExists: true }).reason
  assert.match(reason, /finish the task and record exact commit_sha plus evidence/i)
  assert.match(reason, /release this lease as completed/i)
  assert.match(reason, /release or cancel the active lease/i)
  assert.match(reason, /call team_plan_propose with replace_approved:true/i)
  assert.equal(PLAN_REPLACEMENT_RECOVERY.includes('Recovery path A'), true)
  assert.equal(PLAN_REPLACEMENT_RECOVERY.includes('Recovery path B'), true)
})

test('inbox ack exposes one live wake id and ignores blank legacy wakes for context', () => {
  const wakeId = 'wake:lead:106'
  assert.equal(ackableWakeIdForInboxRow({
    wakeIds: [wakeId],
  }, {
    [wakeId]: { wakeId, status: 'queued' },
  }), wakeId)
  assert.equal(ackableWakeIdForInboxRow({
    wakeIds: [wakeId],
  }, {
    [wakeId]: { wakeId, status: 'handled' },
  }), null)
})

test('inbox ack accounting failures do not enter deterministic failure memory', () => {
  const exec = {
    name: 'team_v12',
    arguments: { action: 'inbox_ack', wake_id: 'wake:lead:106' },
  }
  assert.equal(classifyFailure({ isError: true, message: 'wake-not-found: wake:lead:106' }, exec), 'stale-state')
  assert.equal(classifyFailure({ isError: true, message: 'permission denied' }), 'permission')
})

test('B-239 reports the git and phase halves independently', () => {
  assert.deepEqual(mergePhaseAdvanceVerdict('integration-ready', 'integrated'), {
    status: 'advanced',
    phase: 'integrated',
  })
  assert.deepEqual(mergePhaseAdvanceVerdict('integrated', 'integrated'), {
    status: 'already-at-or-beyond',
    phase: 'integrated',
  })
  assert.deepEqual(
    mergePhaseAdvanceFailureVerdict(
      new Error('team policy refusal [task-phase-status]: task is pending'),
      'integrated',
      'integration-ready',
    ),
    {
      status: 'failed',
      phase: 'integration-ready',
      targetPhase: 'integrated',
      code: 'task-phase-status',
      reason: 'task is pending',
    },
  )
})

test('worktree setup refuses a task owned by another member', () => {
  assert.deepEqual(worktreeTargetVerdict({ id: 't1', ownerName: 'member-a' }, 'member-a'), {
    ok: true,
  })
  assert.deepEqual(worktreeTargetVerdict({ id: 't1' }, 'member-b'), {
    ok: true,
  })
  assert.deepEqual(worktreeTargetVerdict({ id: 't1', ownerName: 'member-a' }, 'member-b'), {
    ok: false,
    code: 'worktree-task-owner-mismatch',
    reason: 'task "t1" belongs to "member-a", not target "member-b"; reassign the task before laying out its worktree',
  })
})
