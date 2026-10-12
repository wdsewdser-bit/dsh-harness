import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyFsTools } from '../app/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js'
import {
  auditStatusFor,
  controlPlaneFor,
  normalizeStoredTask,
  readAuditEvents,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import { apply as applyTeamHealth } from '../home/profiles/web/plugins/team-health.mjs'
import { buildReadyQueue } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import { buildRoomRecoverySnapshot, createRoomLedger, projectRoomDecisions, proposeDecision } from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import {
  buildClearanceRecords,
  clearanceCommitVerdict,
  clearanceCommitsForReport,
  deadLetterCounts,
  deadLetterRows,
  milestoneDeliveryVerdict,
  memberMergeSourceVerdict,
  mergeClearanceRecords,
  planApprovePhaseVerdict,
  planProposePhaseVerdict,
  reportClearanceVerdict,
  selectRoomRoundMembers,
  taskViewFields,
  taskEditWriteScopeVerdict,
  taskReopenReason,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { boardCreate, boardUpdate, createBoards } from '../home/profiles/web/plugins/team-policy.mjs'
import { clearanceDigestGate, mergeExact, worktreeAdd } from '../home/profiles/web/plugins/team-worktree.mjs'
import {
  reconcileWaitingTickets,
  recordWaiting,
  projectWaitingTickets,
  resolveWaiting,
  waitingTicketActive,
} from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import {
  evidenceIdInputForm,
  evidenceQueryEnvelope,
  evidenceQueryFormation,
  evidenceQueryKey,
  failureMemoryTargetFingerprint,
  taskContractReadResult,
  taskRequirementVisibleTo,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { shellWriteTargets } from '../home/profiles/web/plugins/write-scope-guard.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function waitFor(check, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

test('B-110: mergeExact fast-forwards an ancestor source and reports commit creation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b110-'))
  const repo = join(directory, 'repo')
  const source = join(directory, 'source')
  const destination = join(directory, 'destination')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b110@example.test'])
    git(repo, ['config', 'user.name', 'B-110 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])

    git(repo, ['worktree', 'add', '-b', 'source', source, 'main'])
    writeFileSync(join(source, 'source.txt'), 'source\n')
    git(source, ['add', 'source.txt'])
    git(source, ['commit', '-m', 'source change'])
    const sourceSha = git(source, ['rev-parse', 'HEAD'])

    git(repo, ['worktree', 'add', '-b', 'destination', destination, 'main'])
    const destinationBefore = git(destination, ['rev-parse', 'HEAD'])
    assert.notEqual(destinationBefore, sourceSha)

    const outcome = mergeExact(repo, destination, source, 'source', sourceSha)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.commit, sourceSha)
    assert.equal(outcome.sourceSha, sourceSha)
    assert.equal(outcome.previous, destinationBefore)
    assert.equal(outcome.previousMeaning, 'destination-head-before-merge')
    assert.equal(outcome.destinationBefore, destinationBefore)
    assert.equal(outcome.sourceHead, sourceSha)
    assert.equal(outcome.mergeBase, destinationBefore)
    assert.equal(outcome.ancestorVerified, true)
    assert.equal(outcome.fastForwarded, true)
    assert.equal(outcome.createdCommit, false)
    assert.equal(outcome.alreadyUpToDate, false)
    assert.equal(git(destination, ['rev-parse', 'HEAD']), sourceSha)
    const fastForwardParents = git(destination, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/)
    assert.deepEqual(fastForwardParents, [sourceSha, destinationBefore])

    const repeated = mergeExact(repo, destination, source, 'source', sourceSha)
    assert.equal(repeated.ok, true)
    assert.equal(repeated.commit, sourceSha)
    assert.equal(repeated.fastForwarded, false)
    assert.equal(repeated.createdCommit, false)
    assert.equal(repeated.alreadyUpToDate, true)

    writeFileSync(join(destination, 'destination.txt'), 'destination\n')
    git(destination, ['add', 'destination.txt'])
    git(destination, ['commit', '-m', 'destination change'])
    const destinationHead = git(destination, ['rev-parse', 'HEAD'])

    writeFileSync(join(source, 'source-2.txt'), 'source 2\n')
    git(source, ['add', 'source-2.txt'])
    git(source, ['commit', '-m', 'source divergence'])
    const divergentSourceSha = git(source, ['rev-parse', 'HEAD'])

    const merged = mergeExact(repo, destination, source, 'source', divergentSourceSha)
    assert.equal(merged.ok, true)
    assert.equal(merged.fastForwarded, false)
    assert.equal(merged.createdCommit, true)
    assert.equal(merged.alreadyUpToDate, false)
    assert.equal(merged.previousMeaning, 'destination-head-before-merge')
    assert.equal(merged.destinationBefore, destinationHead)
    assert.equal(merged.sourceHead, divergentSourceSha)
    assert.notEqual(merged.commit, divergentSourceSha)
    const parents = git(destination, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/)
    assert.deepEqual(parents, [merged.commit, destinationHead, divergentSourceSha])
    git(destination, ['merge-base', '--is-ancestor', divergentSourceSha, 'HEAD'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-116: one verifier report can clear both task and branch-head commits', () => {
  const taskCommit = '70d9395f5e9e'.padEnd(40, '0')
  const headCommit = '88b88ad025cf'.padEnd(40, '1')
  assert.deepEqual(
    clearanceCommitsForReport({ commit: taskCommit, clearedCommits: [headCommit, taskCommit] }),
    [taskCommit, headCommit],
  )

  const clearance = buildClearanceRecords({
    commit: taskCommit,
    clearedCommits: [headCommit],
    severity: 'nit',
    summary: 'both exact objects cleared',
    issues: [{ severity: 'nit', title: 'none', evidence: 'focused fixture' }],
    report: 'b116-report',
    by: 'verifier',
    at: '2026-09-28T00:00:00.000Z',
  })
  assert.deepEqual(clearance.commits, [taskCommit, headCommit])
  assert.equal(clearance.records[taskCommit].reportDigest, clearance.records[headCommit].reportDigest)
  assert.equal(clearanceDigestGate(clearance.records[headCommit], { commit: headCommit }).ok, true)
})

test('B-117/B-118: query formation and input form remain explicit and context-free', () => {
  const fullId = 'evidence-7619de69-21ff-4056-9174-9351ab0da5c8'
  assert.equal(evidenceIdInputForm(fullId), 'full-id')
  assert.equal(evidenceIdInputForm('evidence-7619de69'), 'prefix')

  const filterKey = evidenceQueryKey({ taskId: 'group-world-t98' })
  assert.deepEqual(evidenceQueryKey({ task_id: 'group-world-t98' }), filterKey)
  const filtered = evidenceQueryEnvelope({
    queryKey: filterKey,
    queryFormed: true,
    rows: [],
    total: 10,
    visible: 10,
    tier: 1,
  })
  assert.equal(filtered.visibility.queryFormed, true)
  assert.equal(filtered.visibility.queryStatus, 'formed')
  assert.deepEqual(filtered.visibility.queryKey, filterKey)

  const unformed = evidenceQueryEnvelope({ rows: [], total: 10, visible: 10, tier: 1 })
  assert.equal(unformed.visibility.queryFormed, false)
  assert.equal(unformed.visibility.queryStatus, 'not-formed')

  const resolvedElsewhere = evidenceQueryEnvelope({
    requestedId: fullId,
    requestedField: 'evidenceId',
    resolved: {
      status: 'not-found',
      form: 'prefix',
      accepted: true,
      candidateCount: 0,
      rows: [],
    },
    rows: [],
    total: 10,
    visible: 10,
    tier: 1,
  })
  assert.equal(resolvedElsewhere.idResolution.inputForm, 'full-id')
  assert.equal(resolvedElsewhere.idResolution.resolvedForm, 'prefix')
  assert.equal(resolvedElsewhere.idResolution.form, 'full-id')
  assert.equal(resolvedElsewhere.visibility.queryKey.form, 'full-id')
  assert.equal(resolvedElsewhere.visibility.resolvedForm, 'prefix')
  assert.equal(resolvedElsewhere.visibility.queryStatus, 'formed')
})

test('B-119: worktree sync refusal names behind and dirty preconditions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b119-'))
  const repo = join(directory, 'repo')
  const worktree = join(directory, 'member')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b119@example.test'])
    git(repo, ['config', 'user.name', 'B-119 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    git(repo, ['worktree', 'add', '-b', 'team/a/member', worktree, 'main'])
    writeFileSync(join(repo, 'main-only.txt'), 'main\n')
    git(repo, ['add', 'main-only.txt'])
    git(repo, ['commit', '-m', 'main advances'])
    writeFileSync(join(worktree, 'dirty.txt'), 'untracked\n')

    const result = worktreeAdd(repo, worktree, 'team/a/member', 'main')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'worktree-refresh-dirty')
    assert.equal(result.behind, 1)
    assert.equal(result.dirtyCount, 1)
    assert.deepEqual(result.dirtyFiles, ['?? dirty.txt'])
    assert.equal(result.nextStep, 'git merge main')
    assert.match(result.detail, /behind=1, dirty=1/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-121: generator and fixture-manifest output flags are parsed as writes', () => {
  const root = 'D:/repo'
  const generated = shellWriteTargets('rig-runner --gen-fixtures tests/golden/rig-stats/gen', root)
  assert.equal(generated.opaque, false)
  assert.ok(generated.targets.some((target) => target.endsWith('tests\\golden\\rig-stats\\gen')
    || target.endsWith('tests/golden/rig-stats/gen')))

  const manifest = shellWriteTargets('rig-runner --emit-fixture-manifest tests/golden/rig-stats/manifest.txt', root)
  assert.equal(manifest.opaque, false)
  assert.ok(manifest.targets.some((target) => target.endsWith('tests\\golden\\rig-stats\\manifest.txt')
    || target.endsWith('tests/golden/rig-stats/manifest.txt')))
})

test('B-122: a structured wait survives phase revision changes until its condition clears', () => {
  const state = {
    boards: {
      main: {
        tasks: {
          dep: { id: 'dep', status: 'pending', phase: 'execution', revision: 1 },
          t: { id: 't', status: 'pending', phase: 'execution', revision: 2 },
        },
      },
    },
  }
  const ticket = recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'dependency',
    unblockCondition: { type: 'dependency', taskIds: ['dep'] },
  }, 'lead', { now: 100 })
  state.boards.main.tasks.t.revision = 3
  state.boards.main.tasks.t.phase = 'member-check'
  assert.equal(waitingTicketActive(ticket, state, 101), true)

  state.boards.main.tasks.dep.status = 'completed'
  state.boards.main.tasks.dep.phase = 'accepted'
  assert.equal(waitingTicketActive(ticket, state, 101), false)
})

test('B-123: a report with major issues cannot advertise cleared commits', () => {
  const commit = 'df12ad2b'.padEnd(40, '0')
  const blocked = reportClearanceVerdict({
    commit,
    clearedCommits: ['head-commit'],
    issues: [{ severity: 'major', title: 'still broken', evidence: 'fixture' }],
  })
  assert.equal(blocked.ok, false)
  assert.deepEqual(blocked.commits, [])
  assert.equal(blocked.blockingSeverity, 'major')

  const cleared = reportClearanceVerdict({
    commit,
    clearedCommits: ['head-commit'],
    issues: [{ severity: 'condition', title: 'merge condition', evidence: 'fixture' }],
  })
  assert.equal(cleared.ok, true)
  assert.deepEqual(cleared.commits, [commit, 'head-commit'])
})

test('B-112: ready queue names the dependency phase gate and honors an explicit override', () => {
  const blocker = {
    id: 'blocker',
    status: 'completed',
    phase: 'integrated',
    lifecycle: 'execution',
  }
  const dependent = {
    id: 'dependent',
    status: 'pending',
    phase: 'execution',
    lifecycle: 'execution',
    ownerName: 'member',
    blockedBy: ['blocker'],
    acceptanceCriteria: ['accepted by the consumer'],
    writeScopes: ['reports/b112'],
  }
  const members = [{ name: 'member', status: 'idle' }]

  const blocked = buildReadyQueue([blocker, dependent], members, [], { now: 100 })
  const blockedRow = blocked.blocked.find((row) => row.id === 'dependent')
  assert.ok(blockedRow)
  assert.deepEqual(blockedRow.unmet, ['blocker'])
  assert.deepEqual(blockedRow.dependencyGate, [{
    id: 'blocker',
    requiredPhase: 'accepted',
    status: 'completed',
    phase: 'integrated',
    satisfied: false,
  }])

  const override = buildReadyQueue([
    blocker,
    { ...dependent, dependencyPhase: 'integrated' },
  ], members, [], { now: 100 })
  const readyRow = override.ready.find((row) => row.id === 'dependent')
  assert.ok(readyRow)
  assert.deepEqual(readyRow.unmet, [])
  assert.equal(readyRow.dependencyGate[0].requiredPhase, 'integrated')
  assert.equal(readyRow.dependencyGate[0].satisfied, true)

  const accepted = buildReadyQueue([
    { ...blocker, phase: 'accepted' },
    dependent,
  ], members, [], { now: 100 })
  assert.equal(accepted.ready.some((row) => row.id === 'dependent'), true)
})

test('B-112 supplement: ready queue separates no-plan from plan-not-approved', () => {
  const task = {
    id: 'edit-pending',
    status: 'pending',
    phase: 'room-discussion',
    lifecycle: 'proposed',
    ownerName: 'member',
    acceptanceCriteria: ['accepted'],
    writeScopes: ['src/edit-pending'],
    contract: { kind: 'edit', acceptanceCriteria: ['accepted'] },
  }
  const members = [{ name: 'member', status: 'idle' }]

  const noPlan = buildReadyQueue([task], members, [], { now: 100 })
  const noPlanRow = noPlan.blocked.find((row) => row.id === task.id)
  assert.deepEqual(noPlanRow.reasons, ['no-plan'])
  assert.deepEqual(noPlanRow.approvalGate, {
    required: true,
    satisfied: false,
    reason: 'no-plan',
    planState: null,
  })

  const proposedPlan = buildReadyQueue([task], members, [], {
    now: 100,
    plans: { [task.id]: { taskId: task.id, state: 'plan-proposed' } },
  })
  const proposedRow = proposedPlan.blocked.find((row) => row.id === task.id)
  assert.deepEqual(proposedRow.reasons, ['plan-not-approved'])
  assert.equal(proposedRow.approvalGate.planState, 'plan-proposed')

  const approvedPlan = buildReadyQueue([task], members, [], {
    now: 100,
    plans: { [task.id]: { taskId: task.id, state: 'plan-approved' } },
  })
  const approvedRow = approvedPlan.ready.find((row) => row.id === task.id)
  assert.ok(approvedRow)
  assert.deepEqual(approvedRow.approvalGate, {
    required: true,
    satisfied: true,
    reason: null,
    planState: 'plan-approved',
  })
})

test('B-114: frozen participants are excluded from both speaking and close quorum', () => {
  const room = {
    roomId: 'group:a:tier-2',
    kind: 'group',
    host: 'lead-a',
  }
  const records = {
    'lead-a': { name: 'lead-a', tier: 1, group: 'a' },
    'member-a': { name: 'member-a', tier: 2, group: 'a' },
    'member-b': { name: 'member-b', tier: 2, group: 'b' },
  }
  const frozen = new Set(['member-a'])
  const selected = selectRoomRoundMembers({
    room,
    requested: ['member-a', 'member-b', 'lead-a'],
    memberRecord: (name) => records[name],
    frozen: (name) => frozen.has(name),
  })
  assert.equal(selected.ok, true)
  assert.deepEqual(selected.members, ['lead-a'])
  assert.deepEqual(selected.excludedMembers, ['member-a', 'member-b'].sort((a, b) => a.localeCompare(b)))

  const frozenHost = selectRoomRoundMembers({
    room,
    requested: ['lead-a', 'member-a'],
    memberRecord: (name) => records[name],
    frozen: (name) => name === 'lead-a',
  })
  assert.equal(frozenHost.ok, false)
  assert.equal(frozenHost.code, 'room-host-frozen')
})

test('B-115: room decision projections retain proposed rows on both read paths', () => {
  const ledger = createRoomLedger()
  const proposed = proposeDecision(ledger, {
    roomId: 'root',
    decisionId: 'decision-pending',
    title: 'Pending decision',
    choice: 'keep proposed rows visible',
    rationale: 'required confirmations are incomplete',
    requiredConfirmations: ['lead-a', 'lead-b'],
    confirmations: ['lead-a'],
    createdAt: 100,
  })
  assert.equal(proposed.ok, true)

  const recovery = buildRoomRecoverySnapshot(ledger, 'root', 'lead-a')
  assert.equal(recovery.ok, true)
  assert.deepEqual(recovery.decisions.map((row) => row.decisionId), ['decision-pending'])
  assert.deepEqual(recovery.pendingDecisions.map((row) => row.decisionId), ['decision-pending'])
  assert.deepEqual(recovery.decisionProjection, {
    total: 1,
    returned: 1,
    truncated: false,
    statuses: { proposed: 1 },
  })

  const legacyArray = [{
    decisionId: 'decision-pending',
    status: 'proposed',
    title: 'Pending decision',
    choice: 'keep proposed rows visible',
    rationale: 'required confirmations are incomplete',
    requiredConfirmations: ['lead-a', 'lead-b'],
    confirmations: [{ member: 'lead-a' }],
    missingConfirmations: ['lead-b'],
    createdAt: 100,
    revision: 1,
  }]
  const compactDecision = (decision) => ({
    decisionId: decision.decisionId,
    status: decision.status,
    title: decision.title,
    choice: decision.choice,
    requiredConfirmations: decision.requiredConfirmations,
    missingConfirmations: decision.missingConfirmations,
  })
  assert.deepEqual(
    projectRoomDecisions(legacyArray).decisions.map(compactDecision),
    projectRoomDecisions(ledger.decisions.root).decisions.map(compactDecision),
  )
})

test('B-111: read output exposes structured truncation and continuation fields', () => {
  const registered = []
  const ctx = {
    systemPrompt: {
      section() {},
      getSectionOrder() {
        return 0
      },
    },
    tools: {
      get() {},
      register(tool) {
        registered.push(tool)
      },
    },
    fs: {},
    get() {},
    inject() {},
  }
  applyFsTools(ctx, {
    readLimit: 2000,
    readMaxLineLength: 2000,
    readMaxBytes: 51200,
    readStreamMinSize: 10485760,
  })
  const tool = registered.find((candidate) => candidate.name === 'read')
  assert.ok(tool)
  assert.equal(tool.output.schema.properties.returnedLines.type, 'integer')
  assert.equal(tool.output.schema.properties.truncated.type, 'boolean')
  assert.equal(tool.output.schema.properties.nextOffset.type, 'integer')
  const rendered = tool.output.render({ file_path: 'large.txt', offset: 1, limit: 2000 }, {
    path: 'large.txt',
    offset: 1,
    lines: [{ number: 1, text: 'first' }],
    totalLines: 100,
    returnedLines: 1,
    truncated: true,
    nextOffset: 2,
  })
  assert.match(rendered[0].text, /Output capped/)
})

test('B-124: reopen requires and stores a card-level reason in the same mutation', () => {
  assert.equal(taskReopenReason({ action: 'reopen' }).ok, false)
  assert.equal(taskReopenReason({ action: 'reopen', reason: 'major finding needs rework' }).ok, true)
  assert.equal(taskReopenReason({
    action: 'reopen',
    reopen_reason: 'verifier found a major issue',
  }).reason, 'verifier found a major issue')

  const store = createBoards()
  const created = boardCreate(store, 'group-a', {
    subject: 'reopen target',
    description: 'original description',
  })
  const reopened = boardUpdate(store, 'group-a', {
    taskId: created.id,
    expectedRevision: created.revision,
    action: 'reopen',
    reopenReason: 'verifier found a major issue',
  }, 'lead-a')
  assert.equal(reopened.status, 'pending')
  assert.equal(reopened.lastReopenReason, 'verifier found a major issue')
  assert.equal(Number.isSafeInteger(reopened.lastReopenAt), true)
})

test('B-126: task creation can assign an owner atomically', () => {
  const store = createBoards()
  const task = boardCreate(store, 'group-a', {
    subject: 'owned on create',
    description: 'no ownerless handoff',
    workKind: 'review',
    ownerName: 'member-a',
  })
  assert.equal(task.ownerName, 'member-a')
  assert.equal(task.status, 'in_progress')
})

test('B-127: PTC completion sanitizes nested undefined values before lossless JSON validation', () => {
  const source = readFileSync(new URL('../app/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js', import.meta.url), 'utf8')
  assert.match(source, /sanitizePtcCompletion\(value\)/)
  const start = source.indexOf('function sanitizePtcCompletion')
  const end = source.indexOf('/** Build the fixed overflow fragment', start)
  assert.ok(start >= 0 && end > start)
  const sanitize = new Function(`${source.slice(start, end)}; return sanitizePtcCompletion`)()
  assert.deepEqual(
    sanitize({ optional: undefined, nested: [undefined, { deeper: undefined }] }),
    { optional: null, nested: [null, { deeper: null }] },
  )
})

test('B-128: direct task-row writeScopes edits are refused with the plan recovery path', () => {
  const verdict = taskEditWriteScopeVerdict({
    action: 'edit',
    write_scopes: ['src/'],
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'task-write-scopes-plan-controlled')
  assert.match(verdict.reason, /team_plan_propose/)
  assert.doesNotMatch(verdict.reason, /replace the approved plan/i)

  const store = createBoards()
  const created = boardCreate(store, 'group-a', {
    subject: 'scope target',
    description: 'scope is plan controlled',
  })
  assert.throws(() => boardUpdate(store, 'group-a', {
    taskId: created.id,
    expectedRevision: created.revision,
    action: 'edit',
    description: 'must not partially apply',
    writeScopes: ['src/'],
  }, 'lead-a'), /controlled by its plan/)
  assert.equal(boardUpdate(store, 'group-a', {
    taskId: created.id,
    expectedRevision: created.revision,
    action: 'edit',
    description: 'readback only',
  }, 'lead-a').description, 'readback only')
})

test('B-129: PTC tool failures preserve the structured HarnessError code', () => {
  const source = readFileSync(new URL('../app/node_modules/@deepseek-ai/dsh-tools/lib/types/ptc.js', import.meta.url), 'utf8')
  assert.match(source, /resolve\(ptcBindingOutcome\(result\)\)/)
  assert.match(source, /if \(typeof info\.name === "string"/)
  assert.match(source, /if \(typeof info\.code === "string"/)
  assert.match(source, /outcome\.code = info\.code/)
})

test('B-130: mergeExact allows only named untracked paths and reports what was ignored', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b130-'))
  const repo = join(directory, 'repo')
  const source = join(directory, 'source')
  const destination = join(directory, 'destination')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b130@example.test'])
    git(repo, ['config', 'user.name', 'B-130 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])

    git(repo, ['worktree', 'add', '-b', 'source', source, 'main'])
    writeFileSync(join(source, 'source.txt'), 'source\n')
    git(source, ['add', 'source.txt'])
    git(source, ['commit', '-m', 'source change'])
    const sourceSha = git(source, ['rev-parse', 'HEAD'])

    git(repo, ['worktree', 'add', '-b', 'destination', destination, 'main'])
    mkdirSync(join(source, 'logs'))
    mkdirSync(join(destination, 'logs'))
    writeFileSync(join(source, 'logs', 'source.log'), 'source untracked\n')
    writeFileSync(join(destination, 'logs', 'destination.log'), 'destination untracked\n')

    const merged = mergeExact(repo, destination, source, 'source', sourceSha, undefined, {
      allowedUntracked: ['logs/'],
    })
    assert.equal(merged.ok, true)
    assert.deepEqual(merged.ignoredUntracked, ['logs/'])
    assert.equal(git(destination, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'logs']), '')

    writeFileSync(join(destination, 'scratch.tmp'), 'still blocking\n')
    const blocked = mergeExact(repo, destination, source, 'source', sourceSha, undefined, {
      allowedUntracked: ['logs/'],
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'destination-worktree-dirty')
    assert.deepEqual(blocked.files, ['?? scratch.tmp'])
    assert.deepEqual(blocked.ignoredUntracked, ['logs/'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-132: worktree setup reports its merge shape and never hides a merge commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b132-'))
  const repo = join(directory, 'repo')
  const member = join(directory, 'member')
  const branch = 'team/a/member'
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b132@example.test'])
    git(repo, ['config', 'user.name', 'B-132 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])

    git(repo, ['worktree', 'add', '-b', branch, member, 'main'])
    writeFileSync(join(member, 'member.txt'), 'member\n')
    git(member, ['add', 'member.txt'])
    git(member, ['commit', '-m', 'member change'])
    const memberHead = git(member, ['rev-parse', 'HEAD'])

    writeFileSync(join(repo, 'main-only.txt'), 'main\n')
    git(repo, ['add', 'main-only.txt'])
    git(repo, ['commit', '-m', 'main advances'])
    const mainHead = git(repo, ['rev-parse', 'HEAD'])

    const refreshed = worktreeAdd(repo, member, branch, 'main')
    assert.equal(refreshed.ok, true)
    assert.equal(refreshed.created, false)
    assert.equal(refreshed.previousHead, memberHead)
    assert.equal(refreshed.headKind, 'merge')
    assert.equal(refreshed.mergeCommitCreated, true)
    assert.deepEqual(refreshed.parents, [memberHead, mainHead])
    assert.equal(refreshed.head, git(member, ['rev-parse', 'HEAD']))

    const repeated = worktreeAdd(repo, member, branch, 'main')
    assert.equal(repeated.ok, true)
    assert.equal(repeated.previousHead, refreshed.head)
    assert.equal(repeated.head, refreshed.head)
    assert.equal(repeated.headKind, 'merge')
    assert.equal(repeated.mergeCommitCreated, false)
    assert.deepEqual(repeated.parents, [memberHead, mainHead])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-133: waiting closure lifecycle is explicit and same-task rehangs do not overwrite', () => {
  const state = {
    boards: {
      main: {
        tasks: {
          t: { id: 't', status: 'in_progress', phase: 'execution', revision: 2 },
        },
      },
    },
    v14Waiting: { tickets: {} },
  }
  const external = recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    reason: 'external',
    unblockCondition: { type: 'external' },
  }, 'lead', { now: 100 })
  assert.equal(external.closurePolicy, 'explicit')
  state.boards.main.tasks.t.revision = 3
  assert.equal(waitingTicketActive(external, state, 110), true)
  const preview = reconcileWaitingTickets(state, { now: 120, apply: false })
  assert.equal(preview.stale, 0)
  assert.equal(external.status, 'open')

  state.boards.main.tasks.t.status = 'completed'
  const reconciled = reconcileWaitingTickets(state, { now: 130 })
  assert.equal(reconciled.resolved, 0)
  assert.equal(external.status, 'open')
  resolveWaiting(state, { ticketId: external.ticketId, resolution: 'external gate cleared' }, 'lead', { now: 140 })
  assert.equal(external.closedReason, 'explicit-resolve')
  assert.equal(external.closedAt, 140)
  assert.equal(external.closedBy, 'lead')

  const explicitState = {
    boards: { main: { tasks: { t: { id: 't', status: 'in_progress', revision: 1 } } } },
    v14Waiting: { tickets: {} },
  }
  const manual = recordWaiting(explicitState, {
    taskId: 't',
    owner: 'member',
    reason: 'manual',
    unblockCondition: { type: 'manual' },
  }, 'lead', { now: 200 })
  resolveWaiting(explicitState, { ticketId: manual.ticketId, resolution: 'operator resumed' }, 'lead', { now: 210 })
  assert.equal(manual.closedReason, 'explicit-resolve')
  assert.equal(manual.closedAt, 210)
  assert.equal(manual.closedBy, 'lead')

  const rehangState = {
    boards: { main: { tasks: { t: { id: 't', status: 'in_progress', revision: 1 } } } },
    v14Waiting: { tickets: {} },
  }
  const first = recordWaiting(rehangState, {
    taskId: 't',
    owner: 'member',
    reason: 'external-a',
    unblockCondition: { type: 'external' },
  }, 'lead', { now: 300 })
  const second = recordWaiting(rehangState, {
    taskId: 't',
    owner: 'member',
    reason: 'manual-b',
    unblockCondition: { type: 'manual' },
  }, 'lead', { now: 301 })
  assert.notEqual(first.ticketId, second.ticketId)
  assert.equal(rehangState.v14Waiting.tickets[first.ticketId].status, 'open')
  resolveWaiting(rehangState, { ticketId: second.ticketId }, 'lead', { now: 302 })
  assert.equal(rehangState.v14Waiting.tickets[first.ticketId].status, 'open')
})

test('B-133 closure two: waiting projections preserve structured post-completion tickets', () => {
  const state = {
    boards: {
      main: {
        tasks: {
          active: { id: 'active', status: 'in_progress', revision: 1 },
          closed: { id: 'closed', status: 'in_progress', revision: 1 },
          stale: { id: 'stale', status: 'completed', revision: 2 },
        },
      },
    },
    v14Waiting: {
      tickets: {
        'wait:active': {
          ticketId: 'wait:active',
          taskId: 'active',
          owner: 'member',
          reason: 'manual',
          status: 'open',
          unblockCondition: { type: 'manual' },
          createdAt: 1,
        },
        'wait:closed': {
          ticketId: 'wait:closed',
          taskId: 'closed',
          owner: 'member',
          reason: 'manual',
          status: 'resolved',
          closedReason: 'explicit-resolve',
          createdAt: 1,
        },
        'wait:stale': {
          ticketId: 'wait:stale',
          taskId: 'stale',
          owner: 'member',
          reason: 'manual',
          status: 'open',
          unblockCondition: { type: 'manual' },
          createdAt: 1,
        },
      },
    },
  }
  const stored = Object.values(state.v14Waiting.tickets)
  const complete = projectWaitingTickets(state, { stored, includeClosed: true, now: 10 })
  assert.equal(complete.total, 3)
  assert.equal(complete.active, 2)
  assert.equal(complete.closed, 1)
  assert.equal(complete.stale, 0)
  assert.equal(complete.projectionComplete, true)

  const exact = projectWaitingTickets(state, { stored, ticketId: 'wait:stale', includeClosed: false, now: 10 })
  assert.equal(exact.total, 1)
  assert.equal(exact.tickets[0].ticketId, 'wait:stale')

  const paged = projectWaitingTickets(state, { stored, includeClosed: true, offset: 1, limit: 1, now: 10 })
  assert.equal(paged.returned, 1)
  assert.equal(paged.truncated, true)
  assert.equal(paged.nextOffset, 2)
})

test('B-136: waiting_list no longer references an undefined lower helper', () => {
  const source = readFileSync(new URL('../home/profiles/web/plugins/team-v12-runtime.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\blower\s*\(/)
  assert.match(source, /projectWaitingTickets/)
})

test('B-139: failure-memory clear resolves the exact blocked call signature', () => {
  const sessionId = 'session-028e6f5b-1716-4c23-a232-af16d853d191'
  assert.equal(
    failureMemoryTargetFingerprint({ tool: 'team_v12', arguments: { action: 'waiting_list' } }, sessionId),
    '66af5a3d4a84530cd668b847c9adb58e11cd68c0b46d9d7a175583f712804cfc',
  )
  assert.equal(
    failureMemoryTargetFingerprint({ action_fingerprint: 'a'.repeat(64) }, sessionId),
    'a'.repeat(64),
  )
  assert.equal(failureMemoryTargetFingerprint({}, sessionId), '')
})

test('B-137: a milestone bound to another task is not reported as this task owner forgetting', () => {
  assert.deepEqual(
    milestoneDeliveryVerdict({ done: true, taskId: 't', stage: 'done' }, 't'),
    { milestoneTaskId: 't', verdict: 'owner-forgot-to-mark-it' },
  )
  assert.deepEqual(
    milestoneDeliveryVerdict({ done: true, taskId: 'other', stage: 'done' }, 't'),
    { milestoneTaskId: 'other', verdict: 'milestone-unbound' },
  )
  assert.deepEqual(
    milestoneDeliveryVerdict({ done: false, taskId: 't', stage: 'running' }, 't'),
    { milestoneTaskId: 't', verdict: 'work-genuinely-unfinished' },
  )
})

test('B-140: complete unions evidence pointers instead of shrinking the proof set', async () => {
  const store = createBoards()
  const created = boardCreate(store, 'group-a', {
    subject: 'preserve evidence',
    description: 'completion must be monotonic',
    workKind: 'review',
    ownerName: 'member-a',
  })
  const stored = store.boards.get('group-a').get(created.id)
  stored.evidenceIds = ['evidence-existing']
  const completed = boardUpdate(store, 'group-a', {
    taskId: created.id,
    expectedRevision: created.revision,
    action: 'complete',
    evidenceIds: ['evidence-new'],
  }, 'member-a')
  assert.deepEqual(completed.evidenceIds, ['evidence-existing', 'evidence-new'])
  const repaired = boardUpdate(store, 'group-a', {
    taskId: created.id,
    expectedRevision: completed.revision,
    action: 'bind_fix',
    commitSha: 'a'.repeat(40),
    evidenceIds: ['evidence-new'],
    bindFixReason: 'repair commit binding without deleting history',
  }, 'lead-a')
  assert.deepEqual(repaired.evidenceIds, ['evidence-existing', 'evidence-new'])

  const root = mkdtempSync(join(tmpdir(), 'dsh-b140-'))
  try {
    const cp = controlPlaneFor('b140-evidence-union', { controlDir: root })
    let task = await cp.boardCreate({
      boardId: 'group-a',
      taskId: 't140',
      subject: 'global completion',
      evidenceIds: ['evidence-existing'],
    })
    task = await cp.boardUpdate({
      boardId: 'group-a',
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'complete',
      actorName: 'member-a',
      evidenceIds: ['evidence-new'],
    })
    assert.deepEqual(task.evidenceIds, ['evidence-existing', 'evidence-new'])
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-141: dead-letter counts separate system notifications from peer messages', () => {
  const dispatches = {
    'wake:idle:session-1:1:abc': {
      dispatchId: 'wake:idle:session-1:1:abc',
      sender: 'system',
      target: 'lead',
      wakeup: true,
      status: 'timed-out',
      deadlineAt: 1000,
    },
    'wake:activity:session-1:2': {
      dispatchId: 'wake:activity:session-1:2',
      sender: 'system',
      target: 'lead',
      wakeup: true,
      status: 'expired',
      deadlineAt: 900,
    },
    'wake:team-wake:lead:member': {
      dispatchId: 'wake:team-wake:lead:member',
      sender: 'lead',
      target: 'member',
      taskId: 'task-1',
      wakeup: true,
      status: 'timed-out',
      deadlineAt: 800,
    },
  }
  const rows = deadLetterRows(dispatches, { now: 2000 })
  const counts = deadLetterCounts(rows)
  assert.equal(rows.length, 3)
  assert.equal(rows.find((row) => row.dispatchId.includes('idle')).deadLetterKind, 'system-notification')
  assert.equal(rows.find((row) => row.dispatchId.includes('team-wake')).deadLetterKind, 'peer-message')
  assert.deepEqual(counts, {
    total: 3,
    peerMessage: 1,
    systemNotification: 2,
    oldestPeerAgeMs: 1200,
  })
})

test('B-142: reassign clears the previous owner worktree binding', async () => {
  const store = createBoards()
  const created = boardCreate(store, 'group-a', {
    subject: 'reassign target',
    description: 'old binding must not leak',
    workKind: 'edit',
    ownerName: 'member-a',
  })
  store.boards.get('group-a').get(created.id).worktreePath = 'D:/worktrees/team__a__member-a'
  const reassigned = boardUpdate(store, 'group-a', {
    taskId: created.id,
    expectedRevision: created.revision,
    action: 'reassign',
    owner: 'member-b',
  }, 'lead-a')
  assert.equal(reassigned.ownerName, 'member-b')
  assert.equal(reassigned.worktreePath, null)

  const root = mkdtempSync(join(tmpdir(), 'dsh-b142-'))
  try {
    const cp = controlPlaneFor('b142-reassign-worktree', { controlDir: root })
    let task = await cp.boardCreate({
      boardId: 'group-a',
      taskId: 't142',
      subject: 'global reassign target',
      worktreePath: 'D:/worktrees/team__a__member-a',
      ownerName: 'member-a',
    })
    task = await cp.boardUpdate({
      boardId: 'group-a',
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'member-b',
    })
    assert.equal(task.ownerName, 'member-b')
    assert.equal(task.worktreePath, null)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-147: reassign closes the previous owner waiting tickets without touching the replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b147-'))
  try {
    const cp = controlPlaneFor('b147-reassign-waiting', { directory: root })
    let task = await cp.boardCreate({
      boardId: 'group-a',
      taskId: 't147',
      subject: 'global reassign waiting target',
      ownerName: 'member-a',
    })
    await cp.mutate('test/seed-waiting', {}, {}, (state) => {
      state.v14Waiting = {
        tickets: {
          'wait:t147:member-a': {
            ticketId: 'wait:t147:member-a',
            taskId: 't147',
            owner: 'member-a',
            status: 'open',
            reason: 'old owner wait',
            createdAt: 1,
            updatedAt: 1,
          },
          'wait:t147:member-b': {
            ticketId: 'wait:t147:member-b',
            taskId: 't147',
            owner: 'member-b',
            status: 'open',
            reason: 'replacement wait',
            createdAt: 2,
            updatedAt: 2,
          },
          'wait:other:member-a': {
            ticketId: 'wait:other:member-a',
            taskId: 'other-task',
            owner: 'member-a',
            status: 'open',
            reason: 'unrelated task',
            createdAt: 3,
            updatedAt: 3,
          },
        },
      }
      return state.v14Waiting
    })
    await cp.flush()
    task = await cp.boardUpdate({
      boardId: 'group-a',
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'member-b',
      actorName: 'lead-a',
    })
    assert.equal(task.ownerName, 'member-b')
    const tickets = cp.snapshot().v14Waiting.tickets
    assert.equal(tickets['wait:t147:member-a'].status, 'resolved')
    assert.equal(tickets['wait:t147:member-a'].closedReason, 'reassigned')
    assert.equal(tickets['wait:t147:member-a'].closedBy, 'lead-a')
    assert.equal(tickets['wait:t147:member-a'].reassignedTo, 'member-b')
    assert.equal(tickets['wait:t147:member-b'].status, 'open')
    assert.equal(tickets['wait:other:member-a'].status, 'open')
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-143: ignored evidence filters make query formation partial or rejected', () => {
  const partial = evidenceQueryFormation({ kind: 'probe', taskId: null })
  assert.deepEqual(partial.requestedKeys, ['taskId', 'kind'])
  assert.deepEqual(partial.acceptedKeys, ['kind'])
  assert.deepEqual(partial.ignoredKeys, ['taskId'])
  assert.equal(partial.queryStatus, 'partial')
  assert.match(partial.detail, /taskId/)

  const rejected = evidenceQueryFormation({ taskId: null })
  assert.equal(rejected.queryStatus, 'rejected')
  assert.deepEqual(rejected.ignoredKeys, ['taskId'])

  const envelope = evidenceQueryEnvelope({
    queryKey: partial.queryKey,
    queryFormation: partial,
    queryFormed: false,
    rows: [],
    total: 2,
    visible: 2,
    tier: 1,
  })
  assert.equal(envelope.visibility.queryStatus, 'partial')
  assert.deepEqual(envelope.visibility.ignoredKeys, ['taskId'])
})

test('B-144: evidence id resolution declares the reader and visible author scope', () => {
  const fullId = 'evidence-7619de69-21ff-4056-9174-9351ab0da5c8'
  const envelope = evidenceQueryEnvelope({
    requestedId: fullId,
    requestedField: 'evidenceId',
    resolved: {
      status: 'not-found',
      form: 'full-id',
      accepted: true,
      candidateCount: 0,
      rows: [],
    },
    rows: [],
    total: 20,
    visible: 3,
    tier: 2,
    scopeDeclaration: {
      mode: 'reader-or-readable-task',
      reader: 'lead-a',
      visibleAuthors: ['lead-a', 'verifier'],
      registryRevision: 66809,
      stability: {
        reader: 'scope-dependent',
        writer: 'not-guaranteed',
        time: 'not-guaranteed',
        mechanism: 'not-isolated',
      },
      resolutionPolicy: {
        notFoundMeaning: 'not-visible-in-declared-scope',
        reuse: 're-resolve-before-citing',
        singleWriterRule: 'not-sufficient',
      },
    },
  })
  assert.equal(envelope.idResolution.notFoundMeaning, 'not-visible-in-declared-scope')
  assert.equal(envelope.idResolution.scope.reader, 'lead-a')
  assert.equal(envelope.visibility.scopeBasis, 'reader-or-readable-task')
  assert.equal(envelope.visibility.reader, 'lead-a')
  assert.deepEqual(envelope.visibility.visibleAuthors, ['lead-a', 'verifier'])
  assert.equal(envelope.visibility.registryRevision, 66809)
  assert.equal(envelope.visibility.projectionStability.reader, 'scope-dependent')
  assert.equal(envelope.visibility.projectionStability.writer, 'not-guaranteed')
  assert.equal(envelope.visibility.projectionStability.time, 'not-guaranteed')
  assert.equal(envelope.visibility.projectionStability.mechanism, 'not-isolated')
  assert.equal(envelope.visibility.resolutionPolicy.reuse, 're-resolve-before-citing')
  assert.equal(envelope.visibility.notFoundMeaning, 'not-visible-in-declared-scope')
})

test('B-148: team health refreshes a stale disabled snapshot and mirrors recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b148-'))
  let dispose
  try {
    const dirs = ['desktop', 'web', 'headless'].map((profile) => join(root, profile, 'plugins'))
    const sharedFile = 'shared.mjs'
    const healthySource = 'export const name = "shared"\nexport function run() {}\n'
    const driftedSource = 'export const name = "shared"\n'
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, sharedFile), healthySource, 'utf8')
    }
    const scopesFile = join(root, 'scopes.json')
    writeFileSync(scopesFile, JSON.stringify({ defaultDeny: true }), 'utf8')
    writeFileSync(join(dirs[2], sharedFile), driftedSource, 'utf8')

    const hooks = new Map()
    const agent = { id: 'root', name: 'root', status: 'idle', session: { id: 'root-session' } }
    const ctx = {
      agents: { list: () => [agent] },
      agentTeams: { tryMembership: () => ({ id: 'team-health-b148' }) },
      on: (event, callback) => {
        hooks.set(event, callback)
        return () => hooks.delete(event)
      },
      logger: { info: () => {}, warn: () => {} },
    }
    const controlDir = join(root, 'control')
    dispose = applyTeamHealth(ctx, {
      pluginDir: dirs[1],
      profileDirs: dirs,
      sharedPluginFiles: [sharedFile],
      requiredFiles: [sharedFile],
      criticalFiles: [sharedFile],
      scopesFile,
      profile: 'web',
      controlDir,
      healthFile: join(root, 'team-health.json'),
      healthRefreshMs: 20,
    })
    const cp = controlPlaneFor('team-health-b148', { directory: controlDir })
    await waitFor(() => cp.healthStatus().status === 'disabled')
    assert.match(cp.healthStatus().reasons.join(' '), /profile parity failed for shared\.mjs/)

    for (const dir of dirs) writeFileSync(join(dir, sharedFile), healthySource, 'utf8')
    hooks.get('agent/status')({ agent, status: 'running' })
    await waitFor(() => cp.healthStatus().status === 'healthy')

    writeFileSync(join(dirs[2], sharedFile), driftedSource, 'utf8')
    await waitFor(() => cp.healthStatus().status === 'disabled')

    for (const dir of dirs) writeFileSync(join(dir, sharedFile), healthySource, 'utf8')
    await waitFor(() => cp.healthStatus().status === 'healthy')

    const listAgents = ctx.agents.list
    ctx.agents.list = () => { throw new Error('plugin disposed during refresh') }
    await new Promise((resolve) => setTimeout(resolve, 50))
    ctx.agents.list = listAgents
  } finally {
    dispose?.()
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-149: task output drops legacy undeclared fields while preserving lifecycle', () => {
  const projected = taskViewFields({
    id: 't149',
    revision: 2,
    subject: 'legacy card',
    description: 'must remain readable',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    lifecycle: 'ready',
    approved: true,
    legacyUnknownField: 'must not reach tool output',
  })
  assert.equal(projected.id, 't149')
  assert.equal(projected.lifecycle, 'ready')
  assert.equal(Object.hasOwn(projected, 'approved'), false)
  assert.equal(Object.hasOwn(projected, 'legacyUnknownField'), false)
})

test('B-150: reassign adds the replacement owner to the approved plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b150-'))
  try {
    const cp = controlPlaneFor('b150-reassign-plan', { directory: root })
    let task = await cp.boardCreate({
      boardId: 'group-a',
      taskId: 't150',
      subject: 'reassigned edit task',
      description: 'replacement owner must retain plan access',
      workKind: 'edit',
      ownerName: 'member-a',
      writeScopes: ['src/'],
    })
    await cp.planPropose({
      taskId: 't150',
      requirementId: 'req-150',
      goal: 'allow the replacement owner to record evidence',
      members: ['member-a'],
      writeScopes: ['src/'],
      dependencies: [],
      options: [],
      selectedOption: 'reassign',
      checks: { owner: 'member-b' },
      risks: [],
      rollback: 'reassign back to member-a',
      proposedBy: 'lead-a',
    })
    await cp.planApprove({ taskId: 't150', approvedBy: 'lead-a' })
    task = await cp.boardUpdate({
      boardId: 'group-a',
      taskId: 't150',
      expectedRevision: task.revision,
      action: 'reassign',
      owner: 'member-b',
      actorName: 'lead-a',
    })
    const plan = cp.planState('t150')
    assert.equal(task.ownerName, 'member-b')
    assert.equal(plan.state, 'plan-approved')
    assert.deepEqual(plan.members, ['member-a', 'member-b'])
    assert.ok(plan.revision > 1)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-151: discussion contract reads allow empty write scopes and synchronize lifecycle', () => {
  const result = taskContractReadResult({
    id: 'task-100',
    status: 'completed',
    phase: 'room-discussion',
    ownerName: 'rig-diff',
    workKind: 'discussion',
    contract: {
      taskId: 'task-100',
      kind: 'discussion',
      goal: 'produce a decision with evidence',
      owner: 'rig-diff',
      writeScopes: [],
      acceptanceCriteria: [{ text: 'evidence is recorded', required: true }],
      risk: { level: 'low' },
      lifecycle: 'running',
      contractRevision: 1,
    },
  })
  assert.equal(result.validation.ok, true)
  assert.deepEqual(result.validation.errors, [])
  assert.equal(result.contract.lifecycle, 'completed')
  assert.deepEqual(result.contract.writeScopes, [])
})

test('B-152: task acceptance requirements do not leak to unrelated group members', () => {
  const task = { id: 'task-100', ownerName: 'rig-diff', board: 'global' }
  const canReadBoard = () => true
  assert.equal(taskRequirementVisibleTo(task, { name: 'member-framing', tier: 2, group: 'proto' }, 'global', canReadBoard), false)
  assert.equal(taskRequirementVisibleTo(task, { name: 'rig-diff', tier: 2, group: 'rig' }, 'global', canReadBoard), true)
  assert.equal(taskRequirementVisibleTo(task, { name: 'lead-rig', tier: 1, group: 'rig' }, 'group-rig', canReadBoard), true)
  assert.equal(taskRequirementVisibleTo(task, { name: 'verifier', tier: 2, group: 'verifier' }, 'global', canReadBoard), true)
})

test('R23: stored legacy task fields are removed and lifecycle follows status', () => {
  const task = {
    id: 'task-100',
    status: 'completed',
    phase: 'room-discussion',
    lifecycle: 'running',
    approved: true,
    contract: { lifecycle: 'running' },
  }
  normalizeStoredTask(task)
  assert.equal(Object.hasOwn(task, 'approved'), false)
  assert.equal(task.lifecycle, 'completed')
  assert.equal(task.contract.lifecycle, 'completed')
})

test('R23: replacing an approved plan preserves a post-approval task phase', () => {
  assert.deepEqual(planProposePhaseVerdict('verifier-review', true), { action: 'preserve', phase: 'verifier-review' })
  assert.deepEqual(planProposePhaseVerdict('plan-proposed', false), { action: 'advance', phase: 'plan-proposed' })
  assert.deepEqual(planApprovePhaseVerdict('verifier-review'), { action: 'preserve', phase: 'verifier-review' })
  assert.deepEqual(planApprovePhaseVerdict('plan-proposed'), { action: 'advance', phase: 'plan-approved' })
})

test('R23: member-to-group merge binds the exact task commit and rejects unrelated drift', () => {
  assert.deepEqual(memberMergeSourceVerdict({
    destination: 'grp/rig',
    task: { commitSha: 'a'.repeat(40) },
    sourceSha: 'a'.repeat(40),
  }), { ok: true, expected: 'a'.repeat(40), sourceHead: 'a'.repeat(40) })
  const drift = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task: { commitSha: 'a'.repeat(40) },
    sourceSha: 'b'.repeat(40),
  })
  assert.equal(drift.ok, false)
  assert.equal(drift.code, 'member-merge-source-drift')
  const invalid = memberMergeSourceVerdict({
    destination: 'grp/rig',
    task: { commitSha: 'abc123' },
    sourceSha: 'a'.repeat(40),
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'member-merge-task-commit-invalid')
  assert.equal(memberMergeSourceVerdict({ destination: 'main', task: {}, sourceSha: 'b'.repeat(40) }).ok, true)
})

test('D-4: control-plane audit status reads real rows and versions mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-d4-audit-'))
  try {
    const cp = controlPlaneFor('d4-audit', { directory: root })
    await cp.mutate('d4/test-mutation', { marker: 'audit' }, undefined, (state) => {
      state.counters = { ...(state.counters ?? {}), d4: 1 }
      return { ok: true }
    }, { deferMs: 0, history: false })
    await cp.flush()

    const state = cp.view()
    const audit = readAuditEvents(cp.file)
    assert.ok(audit.events.length > 0)
    assert.equal(audit.events.at(-1).revision, state.revision)
    const status = auditStatusFor(cp.file, state)
    assert.equal(status.consistent, true)
    assert.equal(status.lastAuditRevision, state.revision)
    assert.equal(status.trackedFromRevision, state.revision)
    assert.equal(status.versionedAuditEvents, 1)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('D-4: legacy unversioned audit rows are explicit, not reported as an empty log', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-d4-legacy-'))
  try {
    const file = join(root, 'legacy.json')
    writeFileSync(file + '.audit.jsonl', JSON.stringify({ type: 'legacy/event', data: { at: 1 } }) + '\n', 'utf8')
    const state = {
      version: 2,
      schemaVersion: 2,
      rootId: 'legacy',
      revision: 7,
      rooms: {},
      rounds: {},
      plans: {},
      dispatches: {},
      leases: {},
      wakeEpisodes: {},
      escalations: {},
      privilegeRequests: {},
      evidence: {},
      packets: {},
      boards: {},
      provider: {},
      providerFailures: {},
      frozenMembers: {},
      counters: {},
      health: {},
    }
    const status = auditStatusFor(file, state)
    assert.equal(status.code, 'audit-legacy-unversioned')
    assert.equal(status.auditEventsRead, 1)
    assert.equal(status.versionedAuditEvents, 0)
    assert.equal(status.legacyAuditEvents, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('D-5: clearance commits are validated against the repository before registration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-d5-clearance-'))
  const repo = join(directory, 'repo')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'd5@example.test'])
    git(repo, ['config', 'user.name', 'D-5 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    const commit = git(repo, ['rev-parse', 'HEAD'])

    assert.deepEqual(clearanceCommitVerdict(commit, repo), {
      ok: true,
      commit,
      resolvedCommit: commit,
    })
    const short = clearanceCommitVerdict('fe9340491d2fd2e15be65eb012182e4f108070', repo)
    assert.equal(short.ok, false)
    assert.equal(short.code, 'invalid-clearance-commit')
    assert.equal(short.actualKey, 'fe9340491d2fd2e15be65eb012182e4f108070')
    const missing = clearanceCommitVerdict('f'.repeat(40), repo)
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'invalid-clearance-commit')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('D-6: a lower-severity probe cannot overwrite a formal clearance', () => {
  const commit = 'a'.repeat(40)
  const formal = {
    commit,
    severity: 'condition',
    report: 'formal-clearance',
  }
  const probe = {
    commit,
    severity: 'nit',
    report: 'zz-probe-both',
  }
  const retained = mergeClearanceRecords({ [commit]: formal }, { [commit]: probe })
  assert.equal(retained.records[commit].severity, 'condition')
  assert.equal(retained.records[commit].report, 'formal-clearance')
  assert.equal(retained.ignored.length, 1)
  assert.equal(retained.ignored[0].commit, commit)
  assert.equal(retained.ignored[0].retainedSeverity, 'condition')
  assert.equal(retained.ignored[0].ignoredSeverity, 'nit')

  const promoted = mergeClearanceRecords(
    { [commit]: probe },
    { [commit]: { ...formal, report: 'formal-replacement' } },
  )
  assert.equal(promoted.records[commit].severity, 'condition')
  assert.equal(promoted.records[commit].report, 'formal-replacement')
  assert.equal(promoted.ignored.length, 0)
})

test('D-7: mergeExact refuses a detached destination instead of reporting a false landing', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-d7-detached-'))
  const repo = join(directory, 'repo')
  const source = join(directory, 'source')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'd7@example.test'])
    git(repo, ['config', 'user.name', 'D-7 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    git(repo, ['worktree', 'add', '-b', 'source', source, 'main'])
    writeFileSync(join(source, 'source.txt'), 'source\n')
    git(source, ['add', 'source.txt'])
    git(source, ['commit', '-m', 'source'])
    const sourceSha = git(source, ['rev-parse', 'HEAD'])
    const mainBefore = git(repo, ['rev-parse', 'main'])

    git(repo, ['checkout', '--detach', 'main'])
    const detachedBefore = git(repo, ['rev-parse', 'HEAD'])
    const refused = mergeExact(repo, repo, source, 'source', sourceSha, undefined, { destinationRef: 'main' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'destination-is-detached')
    assert.equal(git(repo, ['rev-parse', 'main']), mainBefore)
    assert.equal(git(repo, ['rev-parse', 'HEAD']), detachedBefore)

    git(repo, ['checkout', 'main'])
    const merged = mergeExact(repo, repo, source, 'source', sourceSha, undefined, { destinationRef: 'main' })
    assert.equal(merged.ok, true)
    assert.equal(merged.destinationRefBefore, 'main')
    assert.equal(merged.destinationRefAfter, 'main')
    assert.equal(git(repo, ['rev-parse', 'main']), merged.commit)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-153: worktree setup can resolve a stale-base conflict through an explicit pinned strategy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b153-sync-'))
  const repo = join(directory, 'repo')
  const member = join(directory, 'member')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b153@example.test'])
    git(repo, ['config', 'user.name', 'B-153 Test'])
    writeFileSync(join(repo, 'conflict.txt'), 'base\n')
    git(repo, ['add', 'conflict.txt'])
    git(repo, ['commit', '-m', 'base'])

    git(repo, ['worktree', 'add', '-b', 'team/rig/member', member, 'main'])
    writeFileSync(join(member, 'conflict.txt'), 'member\n')
    git(member, ['add', 'conflict.txt'])
    git(member, ['commit', '-m', 'member change'])
    const memberHead = git(member, ['rev-parse', 'HEAD'])

    writeFileSync(join(repo, 'conflict.txt'), 'main\n')
    git(repo, ['add', 'conflict.txt'])
    git(repo, ['commit', '-m', 'main change'])
    const mainHead = git(repo, ['rev-parse', 'main'])

    const blocked = worktreeAdd(repo, member, 'team/rig/member', 'main')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'worktree-stale-base-merge-conflict')
    assert.equal(blocked.head, memberHead)
    assert.equal(blocked.baseSha, mainHead)
    assert.deepEqual(blocked.files, ['conflict.txt'])

    const missingPins = worktreeAdd(repo, member, 'team/rig/member', 'main', undefined, false, {
      conflictStrategy: 'base',
    })
    assert.equal(missingPins.ok, false)
    assert.equal(missingPins.code, 'worktree-conflict-precondition-required')

    const changedPins = worktreeAdd(repo, member, 'team/rig/member', 'main', undefined, false, {
      conflictStrategy: 'base',
      expectedHead: memberHead,
      expectedBase: '0'.repeat(40),
    })
    assert.equal(changedPins.ok, false)
    assert.equal(changedPins.code, 'worktree-conflict-precondition-changed')

    const resolved = worktreeAdd(repo, member, 'team/rig/member', 'main', undefined, false, {
      conflictStrategy: 'base',
      expectedHead: memberHead,
      expectedBase: mainHead,
    })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.conflictStrategy, 'base')
    assert.equal(resolved.sourceHeadBefore, memberHead)
    assert.equal(resolved.baseHeadBefore, mainHead)
    assert.equal(resolved.mergeCommitCreated, true)
    assert.equal(readFileSync(join(member, 'conflict.txt'), 'utf8').replace(/\r\n/g, '\n'), 'main\n')
    assert.equal(git(repo, ['merge-base', '--is-ancestor', 'main', 'team/rig/member']), '')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-154: a member merge may consume an exact task commit even when the branch tip advanced', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b154-exact-'))
  const repo = join(directory, 'repo')
  const source = join(directory, 'source')
  const destination = join(directory, 'destination')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'b154@example.test'])
    git(repo, ['config', 'user.name', 'B-154 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])

    git(repo, ['worktree', 'add', '-b', 'team/rig/member', source, 'main'])
    writeFileSync(join(source, 'task.txt'), 'task\n')
    git(source, ['add', 'task.txt'])
    git(source, ['commit', '-m', 'task commit'])
    const taskCommit = git(source, ['rev-parse', 'HEAD'])
    writeFileSync(join(source, 'later.txt'), 'later\n')
    git(source, ['add', 'later.txt'])
    git(source, ['commit', '-m', 'later unverified commit'])
    const branchTip = git(source, ['rev-parse', 'HEAD'])

    git(repo, ['worktree', 'add', '-b', 'grp/rig', destination, 'main'])
    const strict = mergeExact(repo, destination, source, 'team/rig/member', taskCommit)
    assert.equal(strict.ok, false)
    assert.equal(strict.code, 'source-sha-changed')
    assert.equal(strict.actualSha, branchTip)

    const unrelated = join(directory, 'unrelated')
    git(repo, ['worktree', 'add', '-b', 'team/rig/unrelated', unrelated, 'main'])
    writeFileSync(join(unrelated, 'unrelated.txt'), 'unrelated\n')
    git(unrelated, ['add', 'unrelated.txt'])
    git(unrelated, ['commit', '-m', 'unrelated tip'])
    const unrelatedTip = git(unrelated, ['rev-parse', 'HEAD'])
    const unrelatedMerge = mergeExact(repo, destination, unrelated, 'team/rig/unrelated', taskCommit, undefined, {
      allowSourceAncestor: true,
    })
    assert.equal(unrelatedMerge.ok, false)
    assert.equal(unrelatedMerge.code, 'source-sha-changed')
    assert.equal(unrelatedMerge.actualSha, unrelatedTip)

    const merged = mergeExact(repo, destination, source, 'team/rig/member', taskCommit, undefined, {
      allowSourceAncestor: true,
    })
    assert.equal(merged.ok, true)
    assert.equal(merged.sourceSha, taskCommit)
    assert.equal(merged.sourceBranchHead, branchTip)
    assert.equal(merged.sourceBranchHeadAfter, branchTip)
    assert.equal(existsSync(join(destination, 'task.txt')), true)
    assert.equal(existsSync(join(destination, 'later.txt')), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-155: request-bound approval waits ignore unrelated plan approval', () => {
  const requestId = 'privilege-b155'
  const state = {
    boards: {
      global: {
        tasks: {
          'task-b155': {
            id: 'task-b155',
            status: 'in_progress',
            phase: 'execution',
            revision: 1,
          },
        },
      },
    },
    plans: {
      'task-b155': { state: 'plan-approved' },
    },
    privilegeRequests: {
      [requestId]: { requestId, status: 'pending' },
    },
    v14Waiting: { tickets: {} },
  }
  const ticket = recordWaiting(state, {
    taskId: 'task-b155',
    owner: 'member-rig',
    reason: 'privilege-approval',
    unblockCondition: { type: 'approval', requestId },
  }, 'lead-rig', { now: 1000 })

  assert.equal(waitingTicketActive(ticket, state, 2000), true)
  assert.equal(ticket.closedReason, undefined)

  state.privilegeRequests[requestId].status = 'approved'
  assert.equal(waitingTicketActive(ticket, state, 3000), false)
  const reconciled = reconcileWaitingTickets(state, { now: 3000 })
  assert.equal(reconciled.resolved, 1)
  assert.equal(ticket.closedReason, 'privilege-approved:' + requestId)
  assert.equal(ticket.resolution, 'auto:privilege-approved')
})
