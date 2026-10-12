import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  confirmDecision,
  createWakeState,
  normalizeRoomWakeState,
  proposeDecision,
} from '../home/profiles/web/plugins/team-v12-room-wake.mjs'
import {
  controlPlaneFile,
  controlPlaneFor,
  resetControlPlaneCache,
  shouldMoveTaskPhase,
} from '../home/profiles/web/plugins/team-control-plane.mjs'
import { mergeExact, sourceSnapshot, worktreeAdd } from '../home/profiles/web/plugins/team-worktree.mjs'
import {
  describeGateUnavailable,
  filterVisibleEvidence,
  withReceiptNotice,
} from '../home/profiles/web/plugins/team-v12-runtime.mjs'
import { createEvidenceRegistry, resolveEvidenceId } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import { apply as applyWriteScopeGuard } from '../home/profiles/web/plugins/write-scope-guard.mjs'

test('B-73: legacy unresolved itemId survives normalization and remains resolvable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b73-'))
  const rootId = 'b73-root'
  const file = controlPlaneFile(rootId, { directory })
  try {
    writeFileSync(file, JSON.stringify({
      version: 2,
      schemaVersion: 2,
      rooms: {
        'room-a': {
          roomId: 'room-a',
          host: 'lead',
          members: ['lead'],
          status: 'open',
          unresolved: [{ itemId: 'msg-1defe70a', text: 'decision request' }],
        },
      },
    }))
    resetControlPlaneCache()
    const control = controlPlaneFor(rootId, { directory })
    const room = control.view({ history: false }).rooms['room-a']
    assert.equal(room.unresolved[0].id, 'msg-1defe70a')
    assert.equal(room.unresolved[0].itemId, 'msg-1defe70a')
    const resolved = await control.roomResolveUnresolved({
      roomId: 'room-a',
      unresolvedId: 'msg-1defe70a',
      resolution: 'handled by the original decision',
      resolvedBy: 'lead',
    }, { name: 'lead' })
    assert.equal(resolved.item.status, 'resolved')
  } finally {
    resetControlPlaneCache()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-74: decision missingConfirmations is derived on every mutation and normalization', () => {
  const state = createWakeState()
  const proposed = proposeDecision(state, {
    roomId: 'room-a',
    decisionId: 'decision-1',
    choice: 'ship',
    requiredConfirmations: ['lead-rig', 'lead-world', 'lead-proto'],
  })
  assert.equal(proposed.ok, true)
  assert.deepEqual(proposed.decision.missingConfirmations, ['lead-rig', 'lead-world', 'lead-proto'])

  confirmDecision(state, 'room-a', 'decision-1', { confirmedBy: 'lead-rig' })
  assert.deepEqual(state.decisions['room-a']['decision-1'].missingConfirmations, ['lead-world', 'lead-proto'])
  confirmDecision(state, 'room-a', 'decision-1', { confirmedBy: 'lead-world' })
  const confirmed = confirmDecision(state, 'room-a', 'decision-1', { confirmedBy: 'lead-proto' })
  assert.equal(confirmed.decision.status, 'confirmed')
  assert.deepEqual(confirmed.decision.missingConfirmations, [])

  const stale = {
    decisions: {
      'room-a': {
        'decision-1': {
          decisionId: 'decision-1',
          status: 'confirmed',
          requiredConfirmations: ['lead-rig', 'lead-world', 'lead-proto'],
          confirmations: [
            { member: 'lead-rig' },
            { member: 'lead-world' },
            { member: 'lead-proto' },
          ],
          missingConfirmations: ['lead-rig', 'lead-world', 'lead-proto'],
        },
      },
    },
  }
  normalizeRoomWakeState(stale)
  assert.deepEqual(stale.decisions['room-a']['decision-1'].missingConfirmations, [])
})

test('worktree refusals identify the dirty source and invalid destination', async () => {
  const dirty = await sourceSnapshot('repo', 'source-worktree', 'team/x', (_cwd, argv) => {
    if (argv[0] === 'rev-parse') return { code: 0, stdout: 'abc123\n', stderr: '' }
    if (argv[0] === 'status') return { code: 0, stdout: ' M src/lib.rs\n?? scratch.txt\n', stderr: '' }
    return { code: 1, stdout: '', stderr: 'unexpected ' + argv.join(' ') }
  })
  assert.equal(dirty.ok, false)
  assert.equal(dirty.code, 'source-worktree-dirty')
  assert.equal(dirty.path, 'source-worktree')
  assert.deepEqual(dirty.files, ['M src/lib.rs', '?? scratch.txt'])

  const invalidDestination = await mergeExact('repo', 'destination-worktree', 'source-worktree', 'team/x', 'abc123', (cwd, argv) => {
    if (argv[0] === 'rev-parse' && argv[1] === 'team/x') return { code: 0, stdout: 'abc123\n', stderr: '' }
    if (argv[0] === 'status' && cwd === 'source-worktree') return { code: 0, stdout: '', stderr: '' }
    if (argv[0] === 'status' && cwd === 'destination-worktree') {
      return { code: 1, stdout: '', stderr: 'fatal: not a git worktree' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected ' + argv.join(' ') }
  })
  assert.equal(invalidDestination.ok, false)
  assert.equal(invalidDestination.code, 'destination-worktree-invalid')
  assert.equal(invalidDestination.path, 'destination-worktree')
  assert.match(invalidDestination.detail, /not a git worktree/)
})

test('B-76: evidence rows retain their writer and remain visible to that writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b76-'))
  try {
    const control = controlPlaneFor('b76-root', { directory })
    const row = await control.evidencePut({
      kind: 'verifier-t83-oracle-counts',
      status: 'recorded',
      recordedBy: 'verifier',
    }, { name: 'verifier' })
    assert.equal(row.recordedBy, 'verifier')
    assert.equal(filterVisibleEvidence([row], {
      tier: 2,
      mine: { name: 'verifier' },
      canReadTask: () => false,
    }).length, 1)
    assert.equal(filterVisibleEvidence([row], {
      tier: 2,
      mine: { name: 'other-member' },
      canReadTask: () => false,
    }).length, 0)
  } finally {
    resetControlPlaneCache()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-79: evidence id resolution distinguishes prefix, ambiguity, missing and invalid forms', () => {
  const registry = createEvidenceRegistry([
    { id: 'evidence-7619de69-21ff-4056-9174-9351ab0da5c8', kind: 'one' },
    { id: 'evidence-7619dead-21ff-4056-9174-9351ab0da5c8', kind: 'two' },
  ])

  const exact = resolveEvidenceId(registry, 'evidence-7619de69-21ff-4056-9174-9351ab0da5c8')
  assert.equal(exact.status, 'resolved')
  assert.equal(exact.form, 'full-id')
  assert.equal(exact.rows.length, 1)

  const unique = resolveEvidenceId(registry, 'evidence-7619de69')
  assert.equal(unique.status, 'resolved-prefix')
  assert.equal(unique.form, 'prefix')
  assert.equal(unique.resolvedId, 'evidence-7619de69-21ff-4056-9174-9351ab0da5c8')
  assert.equal(unique.rows[0].kind, 'one')

  const ambiguous = resolveEvidenceId(registry, 'evidence-7619')
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.candidateCount, 2)
  assert.equal(ambiguous.rows.length, 0)
  assert.equal(ambiguous.candidates.length, 2)

  const missing = resolveEvidenceId(registry, 'evidence-deadbeef')
  assert.equal(missing.status, 'not-found')
  assert.equal(missing.form, 'prefix')
  assert.equal(missing.rows.length, 0)

  const invalid = resolveEvidenceId(registry, 'not an evidence id')
  assert.equal(invalid.status, 'invalid-id')
  assert.equal(invalid.accepted, false)
  assert.equal(invalid.formRejected.code, 'evidence-id-form')
})

test('B-77: ordinary phase advancement cannot roll back packet phases', () => {
  assert.equal(shouldMoveTaskPhase('plan-approved', 'execution'), true)
  assert.equal(shouldMoveTaskPhase('execution', 'member-check'), true)
  assert.equal(shouldMoveTaskPhase('verifier-review', 'execution'), false)
  assert.equal(shouldMoveTaskPhase('integration-ready', 'execution'), false)
  assert.equal(shouldMoveTaskPhase('verifier-review', 'execution', { allowRollback: true }), true)
})

test('B-78: tier-2 writes fail closed without their own worktree', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b78-'))
  const repo = join(directory, 'repo')
  const worktree = join(repo, '.dsh-worktrees', 'team__group-a__member-a')
  const scopesFile = join(directory, 'write-scopes.json')
  const rootId = 'b78-root'
  const controlFile = controlPlaneFile(rootId, { directory })
  const membership = { id: rootId, name: 'member-a', tier: 2, group: 'group-a' }
  const agent = { id: 'agent-a', name: 'member-a', session: { header: { cwd: repo } } }
  const actor = { agent }
  let writeIntent
  const ctx = {
    agentTeams: { tryMembership: () => membership },
    logger: { warn() {} },
    on(event, handler) {
      if (event === 'fs/write-intent') writeIntent = handler
    },
  }
  const state = (worktreePath) => ({
    version: 2,
    schemaVersion: 2,
    revision: 1,
    boards: {
      'group-group-a': {
        tasks: {
          t1: {
            id: 't1',
            board: 'group-group-a',
            status: 'in_progress',
            phase: 'execution',
            writeScopes: ['docs/'],
            worktreePath,
          },
        },
      },
    },
    plans: {
      t1: {
        taskId: 't1',
        state: 'plan-approved',
        members: ['member-a'],
        writeScopes: ['docs/'],
      },
    },
    leases: {
      r1: {
        runId: 'r1',
        member: 'member-a',
        taskId: 't1',
        status: 'active',
        expiresAt: Date.now() + 60000,
      },
    },
  })
  try {
    mkdirSync(repo, { recursive: true })
    writeFileSync(scopesFile, JSON.stringify({
      rootDir: repo,
      defaultDeny: true,
      byName: { 'member-a': ['docs/'] },
    }))
    writeFileSync(controlFile, JSON.stringify(state(null)))
    resetControlPlaneCache()
    applyWriteScopeGuard(ctx, { scopesFile, controlDir: directory, rootDir: repo, enforce: true })
    assert.equal(typeof writeIntent, 'function')
    assert.throws(() => writeIntent({
      targetKey: join(repo, 'docs', 'shared.md'),
      displayPath: 'docs/shared.md',
    }, actor), /has no active worktree/)

    writeFileSync(controlFile, JSON.stringify(state(worktree)))
    resetControlPlaneCache()
    assert.doesNotThrow(() => writeIntent({
      targetKey: join(worktree, 'docs', 'owned.md'),
      displayPath: 'docs/owned.md',
    }, actor))
    assert.throws(() => writeIntent({
      targetKey: join(repo, 'docs', 'shared.md'),
      displayPath: 'docs/shared.md',
    }, actor), /outside the active plan write scope|not its own/)
  } finally {
    resetControlPlaneCache()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-80/B-81: stale integration branch is merged without rebasing and a missing destination worktree is created', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b80-b81-'))
  const repo = join(directory, 'repo')
  const destination = join(repo, '.dsh-worktrees', 'grp__rig')
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
    git(['branch', 'grp/rig'])
    writeFileSync(join(repo, 'main-only.txt'), 'main\n')
    git(['add', 'main-only.txt'])
    git(['commit', '-m', 'main advance'])
    git(['checkout', 'grp/rig'])
    writeFileSync(join(repo, 'group-only.txt'), 'group\n')
    git(['add', 'group-only.txt'])
    git(['commit', '-m', 'group advance'])
    git(['checkout', 'main'])

    const outcome = worktreeAdd(repo, destination, 'grp/rig', 'main', undefined, false)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.created, true)
    assert.equal(existsSync(join(destination, 'main-only.txt')), true)
    assert.equal(existsSync(join(destination, 'group-only.txt')), true)
    assert.doesNotThrow(() => git(['merge-base', '--is-ancestor', 'main', 'grp/rig']))
    assert.equal(readFileSync(join(destination, 'base.txt'), 'utf8').trim(), 'base')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-82: receipt notice does not mutate a frozen downstream content array', () => {
  const original = Object.freeze([{ type: 'text', text: 'original result' }])
  const downstream = Object.freeze({ kind: 'accept', content: original })
  const result = Object.freeze({ content: original })
  const returned = withReceiptNotice(downstream, result, '[Team receipt] mirror failed')
  assert.notEqual(returned, downstream)
  assert.notEqual(returned.content, original)
  assert.deepEqual(returned.content.map((row) => row.text), [
    'original result',
    '[Team receipt] mirror failed',
  ])
  assert.equal(original.length, 1)
})

test('B-83: unavailable gate reports the concrete gate, read stage, task, and state', () => {
  const detail = describeGateUnavailable(
    'team_task_update',
    { action: 'claim', task_id: 'group-world-t99' },
    'evaluateReadyGate',
    new Error('lease projection unavailable'),
  )
  assert.match(detail, /gate=team_task_update\/claim/)
  assert.match(detail, /read=evaluateReadyGate/)
  assert.match(detail, /task=group-world-t99/)
  assert.match(detail, /state=unavailable/)
  assert.match(detail, /lease projection unavailable/)
  assert.doesNotMatch(detail, /repair the control-plane read/)
})
