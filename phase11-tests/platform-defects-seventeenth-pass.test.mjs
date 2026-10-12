import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { memberMergeDestinationBase } from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { mergeExact, runGit, worktreeAdd } from '../home/profiles/web/plugins/team-worktree.mjs'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function runner(cwd, argv) {
  return runGit(cwd, argv)
}

function setupCounterexample(label) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-b172-' + label + '-'))
  const repo = join(directory, 'repo')
  const source = join(directory, 'source')
  const destination = join(directory, 'destination')
  git(directory, ['init', '-b', 'main', repo])
  git(repo, ['config', 'user.email', 'b172@example.test'])
  git(repo, ['config', 'user.name', 'B-172 Test'])
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-m', 'base'])
  git(repo, ['branch', 'grp/rig'])
  git(repo, ['switch', 'grp/rig'])
  writeFileSync(join(repo, 'group.txt'), 'group advance\n')
  git(repo, ['add', 'group.txt'])
  git(repo, ['commit', '-m', 'group advance'])
  git(repo, ['switch', 'main'])
  writeFileSync(join(repo, 'main.txt'), 'main advance\n')
  git(repo, ['add', 'main.txt'])
  git(repo, ['commit', '-m', 'main advance'])
  git(repo, ['worktree', 'add', '-b', 'team/rig/member', source, 'grp/rig'])
  git(source, ['merge', '--no-edit', 'main'])
  writeFileSync(join(source, 'task.txt'), 'task\n')
  git(source, ['add', 'task.txt'])
  git(source, ['commit', '-m', 'task'])
  const sourceSha = git(source, ['rev-parse', 'HEAD'])
  const sourceContainsMain = runner(repo, ['merge-base', '--is-ancestor', 'main', sourceSha]).code === 0
  const destinationHeadIsAncestor = runner(repo, ['merge-base', '--is-ancestor', 'grp/rig', sourceSha]).code === 0
  assert.equal(sourceContainsMain, true)
  assert.equal(destinationHeadIsAncestor, true)
  return { directory, repo, source, destination, sourceSha, sourceContainsMain, destinationHeadIsAncestor }
}

function runMerge(label, selectedBase) {
  const fixture = setupCounterexample(label)
  try {
    const base = selectedBase(fixture)
    const destination = worktreeAdd(
      fixture.repo,
      fixture.destination,
      'grp/rig',
      base,
      runner,
      false,
    )
    assert.equal(destination.ok, true)
    const outcome = mergeExact(
      fixture.repo,
      fixture.destination,
      fixture.source,
      'team/rig/member',
      fixture.sourceSha,
      runner,
      { destinationRef: 'grp/rig' },
    )
    assert.equal(outcome.ok, true)
    return {
      outcome,
      finalHead: git(fixture.destination, ['rev-parse', 'HEAD']),
      parents: git(fixture.destination, ['show', '-s', '--format=%P', 'HEAD']).split(/\s+/).filter(Boolean),
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
}

test('B-172: a cleared source that already contains main is not wrapped by a destination refresh', () => {
  const refreshed = runMerge('old', () => 'main')
  assert.equal(refreshed.outcome.fastForwarded, false)
  assert.equal(refreshed.outcome.createdCommit, true)
  assert.equal(refreshed.parents.length, 2)
  assert.notEqual(refreshed.finalHead, refreshed.outcome.sourceSha)

  const fastForward = runMerge('fixed', ({ sourceContainsMain, destinationHeadIsAncestor }) =>
    memberMergeDestinationBase({ sourceContainsMain, destinationHeadIsAncestor }))
  assert.equal(fastForward.outcome.fastForwarded, true)
  assert.equal(fastForward.outcome.createdCommit, false)
  assert.equal(fastForward.finalHead, fastForward.outcome.sourceSha)
  assert.equal(fastForward.parents.length, 1)
})
