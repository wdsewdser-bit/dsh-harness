#!/usr/bin/env node
/** Merge gate: untracked opt-in and post-merge ancestry verification. */
import assert from 'node:assert/strict'
import { mergeExact, sourceSnapshot } from '../home/profiles/web/plugins/team-worktree.mjs'

const sourceRunner = (status) => (_cwd, argv) => {
  if (argv[0] === 'rev-parse') return { code: 0, stdout: 'abc123\n', stderr: '' }
  if (argv[0] === 'status') return { code: 0, stdout: status, stderr: '' }
  return { code: 1, stdout: '', stderr: 'unexpected ' + argv.join(' ') }
}

const dirty = await sourceSnapshot('repo', 'source', 'team/x', sourceRunner('?? scratch.ps1\n'))
assert.equal(dirty.ok, false)
assert.equal(dirty.code, 'source-worktree-dirty')
const ignored = await sourceSnapshot('repo', 'source', 'team/x', sourceRunner('?? scratch.ps1\n'), { ignoreUntracked: true })
assert.equal(ignored.ok, true)

let headReads = 0
let ancestorCode = 0
const mergeRunner = (_cwd, argv) => {
  if (argv[0] === 'rev-parse' && argv[1] === 'team/x') return { code: 0, stdout: 'abc123\n', stderr: '' }
  if (argv[0] === 'status') return { code: 0, stdout: '', stderr: '' }
  if (argv[0] === 'rev-parse' && argv[1] === 'HEAD') {
    headReads += 1
    return { code: 0, stdout: (headReads === 1 ? 'before' : 'after') + '\n', stderr: '' }
  }
  if (argv[0] === 'merge') return { code: 0, stdout: 'merged\n', stderr: '' }
  if (argv[0] === 'merge-base') return { code: ancestorCode, stdout: '', stderr: '' }
  return { code: 1, stdout: '', stderr: 'unexpected ' + argv.join(' ') }
}
const merged = await mergeExact('repo', 'dest', 'source', 'team/x', 'abc123', mergeRunner)
assert.equal(merged.ok, true)
assert.equal(merged.previous, 'before')
assert.equal(merged.commit, 'after')
assert.equal(merged.ancestorVerified, true)
assert.equal(merged.changed, true)

ancestorCode = 1
headReads = 0
const failed = await mergeExact('repo', 'dest', 'source', 'team/x', 'abc123', mergeRunner)
assert.equal(failed.ok, false)
assert.equal(failed.code, 'merge-postcondition-failed')

console.log('PASS untracked merge opt-in and post-merge ancestry are enforced')
