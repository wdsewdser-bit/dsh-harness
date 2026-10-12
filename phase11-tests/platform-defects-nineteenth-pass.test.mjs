import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGit, worktreeAdd } from '../home/profiles/web/plugins/team-worktree.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '')
}

function fixture(directory) {
  const repo = join(directory, 'repo')
  const worktree = join(directory, 'worktree')
  git(directory, ['init', '-b', 'main', repo])
  git(repo, ['config', 'user.email', 'b174@example.test'])
  git(repo, ['config', 'user.name', 'B-174 Test'])
  writeFileSync(join(repo, 'local.txt'), 'local-base\n')
  writeFileSync(join(repo, 'main.txt'), 'main-base\n')
  git(repo, ['add', 'local.txt', 'main.txt'])
  git(repo, ['commit', '-m', 'base'])
  git(repo, ['branch', 'task'])
  git(repo, ['worktree', 'add', worktree, 'task'])
  return { repo, worktree }
}

function advanceMain(repo) {
  writeFileSync(join(repo, 'main.txt'), 'main-advanced\n')
  git(repo, ['add', 'main.txt'])
  git(repo, ['commit', '-m', 'advance main'])
}

test('B-174: lease sync preserves an unrelated unstaged tracked edit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b174-unrelated-'))
  try {
    const { repo, worktree } = fixture(directory)
    advanceMain(repo)
    writeFileSync(join(worktree, 'local.txt'), 'local-uncommitted\n')

    const outcome = worktreeAdd(repo, worktree, 'task', 'main', runGit, false, {
      allowTrackedUnstaged: true,
    })

    assert.equal(outcome.ok, true)
    assert.deepEqual(outcome.preservedTrackedUnstaged, [' M local.txt'])
    assert.equal(git(repo, ['merge-base', '--is-ancestor', 'main', 'task']), '')
    assert.equal(readFileSync(join(worktree, 'local.txt'), 'utf8'), 'local-uncommitted\n')
    assert.equal(git(worktree, ['status', '--porcelain']), ' M local.txt')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-174: overlapping main changes are rejected without losing the local edit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b174-overlap-'))
  try {
    const { repo, worktree } = fixture(directory)
    writeFileSync(join(repo, 'local.txt'), 'main-conflict\n')
    git(repo, ['add', 'local.txt'])
    git(repo, ['commit', '-m', 'conflicting main change'])
    writeFileSync(join(worktree, 'local.txt'), 'local-edit\n')

    const outcome = worktreeAdd(repo, worktree, 'task', 'main', runGit, false, {
      allowTrackedUnstaged: true,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'worktree-stale-base-merge-failed')
    assert.equal(readFileSync(join(worktree, 'local.txt'), 'utf8'), 'local-edit\n')
    assert.equal(git(worktree, ['status', '--porcelain']), ' M local.txt')
    assert.throws(() => git(repo, ['merge-base', '--is-ancestor', 'main', 'task']))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-174: staged edits remain fail-closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b174-staged-'))
  try {
    const { repo, worktree } = fixture(directory)
    advanceMain(repo)
    writeFileSync(join(worktree, 'local.txt'), 'staged-edit\n')
    git(worktree, ['add', 'local.txt'])

    const outcome = worktreeAdd(repo, worktree, 'task', 'main', runGit, false, {
      allowTrackedUnstaged: true,
    })

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'worktree-refresh-dirty')
    assert.deepEqual(outcome.dirtyFiles, ['M  local.txt'])
    assert.equal(readFileSync(join(worktree, 'local.txt'), 'utf8'), 'staged-edit\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('B-174: the default setup path still rejects every tracked edit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b174-default-'))
  try {
    const { repo, worktree } = fixture(directory)
    advanceMain(repo)
    writeFileSync(join(worktree, 'local.txt'), 'local-uncommitted\n')

    const outcome = worktreeAdd(repo, worktree, 'task', 'main', runGit, false)

    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'worktree-refresh-dirty')
    assert.deepEqual(outcome.dirtyFiles, ['M local.txt'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
