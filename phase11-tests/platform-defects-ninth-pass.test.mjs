import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RECENT_DONE_WHEN_WINDOW_MS,
  createMilestoneDoc,
  markMilestoneDone,
  milestoneProofVerdict,
  setMilestone,
} from '../home/profiles/web/plugins/team-milestone-v2.mjs'
import {
  memberWorktreeBindingVerdict,
} from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { shellWriteTargets } from '../home/profiles/web/plugins/write-scope-guard.mjs'

test('B-92: a recent proof edit requires an exact echo and records its age', () => {
  const doc = createMilestoneDoc()
  setMilestone(doc, 'member-a', 'finish the unit', 'run focused test and confirm PASS', 1000, 't1')

  const missingEcho = milestoneProofVerdict(doc.members['member-a'], undefined, 2000)
  assert.equal(missingEcho.ok, false)
  assert.equal(missingEcho.code, 'milestone-proof-echo')

  const mismatch = milestoneProofVerdict(doc.members['member-a'], 'something else', 2000)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'milestone-proof-mismatch')

  const echoed = milestoneProofVerdict(doc.members['member-a'], 'run focused test and confirm PASS', 2000)
  assert.equal(echoed.ok, true)
  assert.equal(echoed.echoVerified, true)

  const ticked = markMilestoneDone(doc, 'member-a', 2000, 't1')
  assert.equal(ticked.doneWhenSetAt, 1000)
  assert.equal(ticked.doneWhenEditedMsBeforeDone, 1000)
  assert.equal(ticked.doneWhenEditedBeforeDone, true)

  const older = milestoneProofVerdict(doc.members['member-a'], undefined, 1000 + RECENT_DONE_WHEN_WINDOW_MS + 1)
  assert.equal(older.ok, true)
})

test('B-93: reassignment computes a deterministic worktree binding for tier-2 edit cards', () => {
  const binding = memberWorktreeBindingVerdict(
    { tier: 2, group: 'proto', name: 'member-a' },
    { id: 'group-proto-t1', workKind: 'edit', worktreePath: null },
    'D:/repo',
    '.dsh-worktrees',
    'member-a',
  )
  assert.equal(binding.required, true)
  assert.equal(binding.needsBinding, true)
  assert.equal(binding.branch, 'team/proto/member-a')
  assert.match(binding.path.replace(/\\/g, '/'), /\.dsh-worktrees\/team__proto__member-a$/)

  const alreadyBound = memberWorktreeBindingVerdict(
    { tier: 2, group: 'proto', name: 'member-a' },
    { id: 'group-proto-t1', workKind: 'edit', worktreePath: binding.path },
    'D:/repo',
    '.dsh-worktrees',
    'member-a',
  )
  assert.equal(alreadyBound.required, true)
  assert.equal(alreadyBound.needsBinding, false)

  const discussion = memberWorktreeBindingVerdict(
    { tier: 2, group: 'proto', name: 'member-a' },
    { id: 'group-proto-t2', workKind: 'discussion', worktreePath: null },
    'D:/repo',
    '.dsh-worktrees',
    'member-a',
  )
  assert.equal(discussion.required, false)
})

test('B-94: a newline ends a write command before the next cmdlet is parsed', () => {
  const root = 'D:/dsh-test/workspaces/RustMc'
  const command = "Remove-Item -LiteralPath 'target/debug/deps/citation_integrity-eb2dd5ef90589bb6.*' -Force\nWrite-Output 'removed'"
  const parsed = shellWriteTargets(command, root)
  assert.equal(parsed.opaque, false)
  assert.ok(parsed.targets.some((target) => /citation_integrity-eb2dd5ef90589bb6\.\*$/.test(target)))
  assert.equal(parsed.targets.some((target) => /[\\/]Write-Output$/i.test(target)), false)
})
