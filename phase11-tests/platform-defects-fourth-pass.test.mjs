import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const gitDir = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd')
process.env.PATH = gitDir + ';' + String(process.env.PATH ?? '')

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const guard = await import(pathToFileURL(base + 'write-scope-guard.mjs').href)
const policyModule = await import(pathToFileURL(base + 'team-policy.mjs').href)
const contract = await import(pathToFileURL(base + 'team-v12-contract.mjs').href)
const control = await import(pathToFileURL(base + 'team-control-plane.mjs').href)
const scheduler = await import(pathToFileURL(base + 'team-v12-evidence-scheduler.mjs').href)
const waiting = await import(pathToFileURL(base + 'team-v14-waiting.mjs').href)
const worktree = await import(pathToFileURL(base + 'team-worktree.mjs').href)
const tools = await import(pathToFileURL(base + 'team-tools-v2-r10.mjs').href)

test('B-46/B-66 distinguish git write commands and read-only git options', () => {
  assert.equal(guard.gitWriteCommand('git show HEAD | Select-String -Pattern "git add -A"'), false)
  assert.equal(guard.gitWriteCommand('git add -A'), true)
  assert.equal(guard.gitWriteCommand('git -C repo commit -m x'), true)
  const parsed = guard.shellWriteTargets("git ls-files -c -o --exclude-standard '*.rs' '*.md'", 'D:/dsh-test/workspaces/RustMc')
  assert.equal(parsed.opaque, false)
  assert.deepEqual(parsed.targets, [])
})

test('B-58 scope conflict ignores stale nested contract lifecycle', () => {
  const tasks = [{
    id: 't1',
    status: 'completed',
    lifecycle: 'completed',
    writeScopes: ['docs/'],
    contract: { lifecycle: 'running', writeScopes: ['docs/'] },
  }]
  const candidate = { id: 't2', lifecycle: 'running', writeScopes: ['docs/'], owner: 'm' }
  assert.deepEqual(contract.detectScopeConflicts(tasks, candidate), [])
})

test('B-41/B-54 packet revision and supersedes track the actual previous packet', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b41-'))
  try {
    const cp = control.controlPlaneFor('fourth-pass-b41', { directory: root })
    const packet = (value) => ({ packetId: 'packet-base', kind: 'group-acceptance', taskIds: ['t1'], checks: [value] })
    const first = await cp.packetPut(packet(1), 'verifier')
    const second = await cp.packetPut(packet(2), 'verifier')
    const third = await cp.packetPut(packet(3), 'verifier')
    assert.equal(first.packetId, 'packet-base')
    assert.equal(first.meta.revision, 1)
    assert.equal(second.packetId, 'packet-base-r2')
    assert.equal(second.meta.revision, 2)
    assert.equal(second.meta.supersedes, 'packet-base')
    assert.equal(third.packetId, 'packet-base-r3')
    assert.equal(third.meta.revision, 3)
    assert.equal(third.meta.supersedes, 'packet-base-r2')
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-62 timed-out wake dead letters can be cancelled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b62-'))
  try {
    const cp = control.controlPlaneFor('fourth-pass-b62', { directory: root })
    await cp.dispatchCreate({
      dispatchId: 'wake:test:r1',
      wakeup: true,
      status: 'queued',
      sender: 'lead',
      target: 'member',
    }, 'lead')
    await cp.dispatchTransition({ dispatchId: 'wake:test:r1', status: 'timed-out' }, 'lead')
    const cancelled = await cp.dispatchTransition({ dispatchId: 'wake:test:r1', status: 'cancelled' }, 'lead')
    assert.equal(cancelled.status, 'cancelled')
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-182b timed-out dead letters have a tier-0 retirement path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b182b-'))
  try {
    const cp = control.controlPlaneFor('fourth-pass-b182b', { directory: root })
    await cp.dispatchCreate({
      dispatchId: 'wake:test:r182',
      wakeup: true,
      status: 'queued',
      sender: 'lead',
      target: 'missing-member',
    }, 'lead')
    await cp.dispatchTransition({ dispatchId: 'wake:test:r182', status: 'timed-out' }, 'lead')
    const retired = await cp.dispatchTransition({ dispatchId: 'wake:test:r182', status: 'expired' }, 'lead')
    assert.equal(retired.status, 'expired')
    assert.equal(tools.dispatchRetireVerdict({ actorTier: 0, currentStatus: 'timed-out', nextStatus: 'expired' }).ok, true)
    assert.equal(tools.dispatchRetireVerdict({ actorTier: 1, currentStatus: 'timed-out', nextStatus: 'expired' }).ok, false)
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-185 group acceptance packet must name the group branch tip', () => {
  const tip = 'a'.repeat(40)
  assert.equal(tools.acceptanceCommitVerdict({ commitSha: tip, groupTip: tip }).ok, true)
  const stale = tools.acceptanceCommitVerdict({ commitSha: 'b'.repeat(40), groupTip: tip })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'packet-commit-not-group-tip')
})

test('B-187 verifier conditions and blockers are delivered directly to tier 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b187-routing-'))
  try {
    const registrations = []
    const makeAgent = (name) => ({
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
    const rootAgent = makeAgent('lead')
    const groupLead = makeAgent('lead-a')
    const verifier = makeAgent('verifier')
    const agents = [rootAgent, groupLead, verifier]
    const memberships = new Map([
      [rootAgent, { id: 'b187-routing', name: 'lead', role: 'lead', root: rootAgent }],
      [groupLead, { id: 'b187-routing', name: 'lead-a', role: 'teammate', root: rootAgent }],
      [verifier, { id: 'b187-routing', name: 'verifier', role: 'teammate', root: rootAgent }],
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
          ...(agent === rootAgent ? {} : {
            level: 1,
            groupId: agent === verifier ? 'verifier' : 'group-a',
            parentName: 'lead',
          }),
        })),
        listTasks: () => [],
        getTask: async () => undefined,
        updateTask: async () => { throw new Error('not used') },
        sendMessage: async (caller, request) => {
          sent.push({ caller: caller.name, target: request.target })
          return { messageId: 'b187-message-' + String(sent.length) }
        },
        waitForChange: async () => ({ timedOut: true }),
      },
      logger: { warn: () => {}, error: () => {} },
      on: () => {},
      effect: () => {},
    }
    policyModule.apply(ctx, { controlDir: join(root, 'control') })
    const policy = policyModule.policyFor('b187-routing')
    policy.seedRoot(rootAgent)
    policy.put({ name: 'lead-a', tier: 1, group: 'group-a', parent: 'lead' })
    policy.put({ name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' })
    tools.apply(ctx, {
      controlDir: join(root, 'control'),
      scopesFile: join(root, 'scopes.json'),
      milestonePath: join(root, 'milestones.json'),
      rolesDir: join(root, 'roles'),
      wakeAckWaitMs: 20,
    })
    const verifierPacketTool = registrations.find((row) =>
      row.owner === 'verifier' && row.definition.name === 'team_acceptance_packet')?.definition
    assert.ok(verifierPacketTool)
    assert.ok(registrations.some((row) =>
      row.owner === 'lead' && row.definition.name === 'team_escalation_list'))
    const findings = tools.verifierReviewEscalations({
      checks: [
        { name: 'criterion', condition: 'the tier-0 landing criterion is stale' },
        { name: 'duplicate', condition: 'the tier-0 landing criterion is stale' },
      ],
      blockers: [
        { taskId: 'group-rig-t117', reason: 'the packet commit is not on the group branch' },
      ],
    })
    assert.deepEqual(findings.map((finding) => finding.severity), ['condition', 'blocker'])
    const packet = await verifierPacketTool.execute({
      kind: 'verifier-review',
      task_ids: ['group-rig-t117'],
      commit_sha: 'deadbeef',
      requirements: ['review'],
      checks: [
        { name: 'criterion', condition: 'the tier-0 landing criterion is stale' },
      ],
      files: [],
      blockers: [
        { taskId: 'group-rig-t117', reason: 'the packet commit is not on the group branch' },
      ],
    }, { agent: verifier, signal: new AbortController().signal })
    assert.equal(packet.rootEscalation.target, 'lead')
    assert.equal(packet.rootEscalation.findings, 2)
    assert.ok(['delivered', 'queued'].includes(packet.rootEscalation.status))
    assert.deepEqual(sent, [{ caller: 'verifier', target: 'lead' }])
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-190 ready=false names the reason and the scope holder', () => {
  const diagnostics = tools.readyReasonDiagnostics({
    id: 'group-world-t137',
    owner: 'lead-world-2',
    reasons: ['scope-conflict:group-world-t129'],
    unmet: [],
  }, [{
    id: 'group-world-t129',
    owner: 'member-world-chunk',
  }])
  assert.equal(diagnostics.readyReason, 'write-scope-held-by')
  assert.deepEqual(diagnostics.readyReasons, [{
    code: 'write-scope-held-by',
    detail: 'write scope is held by task group-world-t129',
    taskId: 'group-world-t129',
    member: 'member-world-chunk',
  }])
  const dependency = tools.readyReasonDiagnostics({
    reasons: ['dependencies-unmet'],
    unmet: ['group-world-t128'],
  })
  assert.equal(dependency.readyReason, 'dependency-unmet')
  assert.deepEqual(dependency.readyReasons[0].taskIds, ['group-world-t128'])
})

test('B-193 blocked tasks do not hold the runnable scope and holders can see waiters', () => {
  const tasks = [
    {
      id: 'group-world-t134',
      status: 'pending',
      lifecycle: 'blocked',
      phase: 'blocked',
      owner: 'member-world-chunk',
      writeScopes: ['crates/mc-worldgen/src/generator.rs'],
      acceptanceCriteria: ['ok'],
      contract: { owner: 'member-world-chunk', writeScopes: ['crates/mc-worldgen/src/generator.rs'], acceptanceCriteria: ['ok'] },
    },
    {
      id: 'group-world-t129',
      status: 'running',
      lifecycle: 'running',
      phase: 'execution',
      owner: 'member-world-chunk',
      writeScopes: ['crates/mc-worldgen/src/generator.rs'],
      acceptanceCriteria: ['ok'],
      contract: { owner: 'member-world-chunk', writeScopes: ['crates/mc-worldgen/src/generator.rs'], acceptanceCriteria: ['ok'] },
    },
  ]
  const queue = scheduler.buildReadyQueue(tasks, [{ name: 'member-world-chunk', status: 'idle' }], [])
  assert.equal(queue.ready.some((row) => row.id === 'group-world-t134'), false)
  assert.ok(queue.blocked.find((row) => row.id === 'group-world-t134').reasons.includes('blocked-phase'))
  assert.equal(queue.ready.some((row) => row.id === 'group-world-t129'), true)
  const diagnostics = tools.readyReasonDiagnostics(
    { id: 'group-world-t134', owner: 'member-world-chunk', reasons: ['blocked-phase'], unmet: [] },
    [
      { id: 'group-world-t134', reasons: ['blocked-phase'] },
      { id: 'group-world-t129', reasons: ['scope-conflict:group-world-t134'] },
    ],
  )
  assert.equal(diagnostics.readyReasons.at(-1).code, 'write-scope-holding')
  assert.deepEqual(diagnostics.readyReasons.at(-1).taskIds, ['group-world-t129'])
})

test('batch 194 escalation reads separate automated dead letters from human decisions', () => {
  const rows = [
    {
      escalationId: 'esc-human',
      category: 'blocked',
      status: 'queued',
      urgency: 'high',
      target: 'lead',
      summary: 'tier 0 must decide',
      decisionNeeded: 'choose a recovery path',
      createdAt: 2,
    },
    {
      escalationId: 'esc-auto',
      category: 'wake-dead-letter',
      status: 'queued',
      urgency: 'critical',
      target: 'lead',
      summary: 'automatic retry exhausted',
      decisionNeeded: 'inspect the dead letter',
      createdAt: 3,
    },
    {
      escalationId: 'esc-member',
      category: 'blocked',
      status: 'queued',
      urgency: 'normal',
      target: 'lead-a',
      summary: 'group decision',
      decisionNeeded: 'answer the member',
      createdAt: 1,
    },
  ]
  const rootView = tools.escalationView({ rows, actorTier: 0, actorName: 'lead' })
  assert.equal(rootView.openCount, 3)
  assert.equal(rootView.humanDecisionCount, 2)
  assert.equal(rootView.automatedNotificationCount, 1)
  assert.deepEqual(rootView.byCategory, { blocked: 2, 'wake-dead-letter': 1 })
  assert.deepEqual(rootView.escalations.map((row) => row.escalationId), ['esc-auto', 'esc-human', 'esc-member'])
  assert.equal(rootView.escalations[0].automated, true)
  const memberView = tools.escalationView({ rows, actorTier: 1, actorName: 'lead-a' })
  assert.deepEqual(memberView.escalations.map((row) => row.escalationId), ['esc-member'])
})

test('B-44 plan proposal rejects unsupported glob scopes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b44-'))
  try {
    const cp = control.controlPlaneFor('fourth-pass-b44', { directory: root })
    await assert.rejects(() => cp.planPropose({
      taskId: 't1',
      goal: 'glob rejection',
      members: ['m'],
      writeScopes: ['docs/groups/rig/**'],
      checks: { one: 'yes' },
      rollback: 'none',
    }, 'lead'), /plan-scope-glob-unsupported/)
  } finally {
    control.resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-52 waiting ticket records the waiter separately from the task owner', () => {
  const state = { boards: { b: { tasks: { t: { id: 't', status: 'in_progress', ownerName: 'member' } } } } }
  const ticket = waiting.recordWaiting(state, {
    taskId: 't',
    owner: 'member',
    waiter: 'lead',
    reason: 'manual',
    unblockCondition: { type: 'manual' },
  }, 'lead', { now: 1 })
  assert.equal(ticket.owner, 'member')
  assert.equal(ticket.waiter, 'lead')
})

test('B-67 pure ancestor worktree branch is fast-forwarded to the moving base', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b67-'))
  const repo = join(root, 'repo')
  const path = join(root, 'wt')
  try {
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'one'], { cwd: repo })
    execFileSync('git', ['branch', 'team/test/member'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    execFileSync('git', ['commit', '-qam', 'two'], { cwd: repo })
    const mainSha = execFileSync('git', ['rev-parse', 'main'], { cwd: repo, encoding: 'utf8' }).trim()
    const outcome = worktree.worktreeAdd(repo, path, 'team/test/member', 'main')
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(outcome.created, true)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(), mainSha)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-71 all-gitignored edit scopes are recognized as non-product', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b71-'))
  const repo = join(root, 'repo')
  try {
    mkdirSync(repo)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), '/tests/golden/\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
    assert.equal(tools.scopesAreEntirelyIgnored(repo, ['tests/golden/rig-batch']), true)
    mkdirSync(join(repo, 'docs'))
    writeFileSync(join(repo, 'docs', 'tracked.md'), 'tracked\n')
    execFileSync('git', ['add', 'docs/tracked.md'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'tracked'], { cwd: repo })
    assert.equal(tools.scopesAreEntirelyIgnored(repo, ['docs']), false)
    assert.equal(tools.scopesAreEntirelyIgnored(repo, ['tests/golden/rig-batch', 'docs']), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
