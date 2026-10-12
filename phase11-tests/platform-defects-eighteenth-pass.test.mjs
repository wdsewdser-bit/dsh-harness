import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildRuntimeFacts } from '../home/profiles/web/plugins/team-v12-runtime-facts.mjs'
import {
  cargoTargetIsolationVerdict,
} from '../home/profiles/web/plugins/team-worktree.mjs'
import {
  mainAncestorSet,
  taskIntegrationVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { runGit } from '../home/profiles/web/plugins/team-worktree.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function cargoFixture(directory, name, targetDir) {
  const checkout = join(directory, name)
  mkdirSync(join(checkout, '.cargo'), { recursive: true })
  writeFileSync(join(checkout, 'Cargo.toml'), '[package]\nname="b173fixture"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="lib.rs"\n')
  writeFileSync(join(checkout, 'lib.rs'), '')
  writeFileSync(join(checkout, '.cargo', 'config.toml'), '[build]\ntarget-dir = "' + targetDir.replace(/\\/g, '/') + '"\n')
  return checkout
}

test('B-173: shared Cargo target is rejected while per-checkout targets pass', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b173-'))
  try {
    const shared = join(directory, 'shared-target')
    const main = cargoFixture(directory, 'main', shared)
    const worktree = cargoFixture(directory, 'worktree', shared)
    const bad = cargoTargetIsolationVerdict([
      { id: 'main', path: main },
      { id: 'worktree', path: worktree },
    ])
    assert.equal(bad.ok, false)
    assert.equal(bad.shared.length, 1)
    assert.equal(bad.shared[0].worktrees.length, 2)

    writeFileSync(join(worktree, '.cargo', 'config.toml'), '[build]\ntarget-dir = "' + join(worktree, 'target').replace(/\\/g, '/') + '"\n')
    const good = cargoTargetIsolationVerdict([
      { id: 'main', path: main },
      { id: 'worktree', path: worktree },
    ])
    assert.equal(good.ok, true)
    assert.equal(good.checked, 2)
    assert.equal(good.shared.length, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('O-10-13: one main ancestry read classifies a whole task page', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-o1013-ancestry-'))
  const repo = join(directory, 'repo')
  const worktree = join(directory, 'worktree')
  try {
    git(directory, ['init', '-b', 'main', repo])
    git(repo, ['config', 'user.email', 'o1013@example.test'])
    git(repo, ['config', 'user.name', 'O-10-13 Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, ['add', 'base.txt'])
    git(repo, ['commit', '-m', 'base'])
    git(repo, ['worktree', 'add', '-b', 'task-branch', worktree, 'main'])
    writeFileSync(join(worktree, 'task.txt'), 'task\n')
    git(worktree, ['add', 'task.txt'])
    git(worktree, ['commit', '-m', 'task'])
    const pendingCommit = git(worktree, ['rev-parse', 'HEAD'])
    git(repo, ['merge', '--ff-only', pendingCommit])
    const integratedCommit = git(repo, ['rev-parse', 'HEAD'])
    const ancestors = mainAncestorSet(repo, runGit)
    assert.equal(ancestors instanceof Set, true)

    const runnerThatMustNotRun = () => {
      throw new Error('per-task git runner should not be called when ancestry is batched')
    }
    const integrated = taskIntegrationVerdict({
      status: 'completed',
      workKind: 'edit',
      commitSha: integratedCommit,
    }, repo, runnerThatMustNotRun, ancestors)
    assert.equal(integrated.state, 'integrated-pending-terminal')

    const pending = taskIntegrationVerdict({
      status: 'completed',
      workKind: 'edit',
      commitSha: 'f'.repeat(40),
    }, repo, runnerThatMustNotRun, ancestors)
    assert.equal(pending.state, 'completed-not-integrated')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('O-10-13: runtime_facts does not degrade every plugin for a null schemaVersion', () => {
  const entry = 'D:/dsh-test/home/profiles/web/plugins/team-tools-v2-r10.mjs'
  const report = buildRuntimeFacts({
    documented: [],
    disk: [],
    runtime: {
      complete: true,
      plugins: [{
        id: 'team-tools',
        enabled: true,
        installed: true,
        entryPath: entry,
        source: 'dsh-loader',
        stateOwner: 'dsh-loader',
        schemaVersion: null,
      }],
    },
    session: [],
  })
  assert.equal(report.plugins['team-tools'].runtime.schemaVersion, null)
  assert.equal(report.collection.complete, true)
  assert.equal(report.collection.degraded, false)
  assert.equal(report.collection.reasons.some((reason) => reason.includes('runtime evidence incomplete')), false)
  assert.equal(report.differences.some((row) => row.code === 'schema-unknown'), true)
})
