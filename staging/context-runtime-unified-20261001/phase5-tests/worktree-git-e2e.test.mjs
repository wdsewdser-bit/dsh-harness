/** Real-git end-to-end: two members edit adjacent files without overwriting each other. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeBranch, mergePlan, clearanceGate, setupPlan, worktreeAdd, worktreePath } from '../home/profiles/web/plugins/team-worktree.mjs'

let failed = 0
const check = (name, ok, detail) => { if (!ok) failed += 1; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail)) }
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const repo = mkdtempSync(join(tmpdir(), 'team-wt-'))
const run = (args) => git(repo, args)

run(['init', '-q', '-b', 'main'])
run(['config', 'user.email', 't@t'])
run(['config', 'user.name', 't'])
mkdirSync(join(repo, 'js'), { recursive: true })
writeFileSync(join(repo, 'js', 'a.js'), 'a\n')
writeFileSync(join(repo, 'js', 'b.js'), 'b\n')
run(['add', '-A'])
run(['commit', '-qm', 'base'])

const root = join(repo, '.dsh-worktrees')
// two member worktrees, exactly the topology the plugin computes
run(['worktree', 'add', '-q', '-b', 'team/alpha/a1', worktreePath(root, 'team/alpha/a1'), 'main'])
run(['worktree', 'add', '-q', '-b', 'team/alpha/a2', worktreePath(root, 'team/alpha/a2'), 'main'])
// the group lead's integration worktree
run(['worktree', 'add', '-q', '-b', 'grp/alpha', worktreePath(root, 'grp/alpha'), 'main'])
run(['worktree', 'add', '-q', '-b', 'team/alpha/verifier', worktreePath(root, 'team/alpha/verifier'), 'main'])

const a1 = worktreePath(root, 'team/alpha/a1')
const a2 = worktreePath(root, 'team/alpha/a2')
const group = worktreePath(root, 'grp/alpha')
writeFileSync(join(a1, 'js', 'a.js'), 'a from a1\n')
git(a1, ['commit', '-qam', 'a1 edits a.js'])
writeFileSync(join(a2, 'js', 'b.js'), 'b from a2\n')
git(a2, ['commit', '-qam', 'a2 edits b.js'])

check('two members work in separate worktrees', readFileSync(join(a2, 'js', 'a.js'), 'utf8').trim() === 'a', readFileSync(join(a2, 'js', 'a.js'), 'utf8'))

const m1 = mergeBranch(group, 'team/alpha/a1')
check('the first member branch merges cleanly into the group branch', m1.ok === true, JSON.stringify(m1))
const m2 = mergeBranch(group, 'team/alpha/a2')
check('the second member branch merges cleanly too', m2.ok === true, JSON.stringify(m2))
check('the group branch now contains BOTH members edits', readFileSync(join(group, 'js', 'a.js'), 'utf8').includes('a1') && readFileSync(join(group, 'js', 'b.js'), 'utf8').includes('a2'))

// main needs a verifier clearance for that exact commit
const groupCommit = git(group, ['rev-parse', 'grp/alpha']).trim()
check('main refuses the group branch without a clearance', clearanceGate(undefined, groupCommit).ok === false)
check('main refuses a clearance for a different commit', clearanceGate({ commit: 'deadbeef', severity: 'minor' }, groupCommit).ok === false)
check('main accepts a clean clearance for that commit', clearanceGate({ commit: groupCommit, severity: 'minor' }, groupCommit).ok === true)

const m3 = mergeBranch(repo, 'grp/alpha')
check('the group branch merges into main', m3.ok === true, JSON.stringify(m3))
check('main contains both members work', readFileSync(join(repo, 'js', 'a.js'), 'utf8').includes('a1') && readFileSync(join(repo, 'js', 'b.js'), 'utf8').includes('a2'))

// conflict: the same file, two branches, intentionally
writeFileSync(join(a1, 'js', 'a.js'), 'a1 wins\n')
git(a1, ['commit', '-qam', 'a1 rewrites a.js'])
writeFileSync(join(a2, 'js', 'a.js'), 'a2 wins\n')
git(a2, ['commit', '-qam', 'a2 rewrites a.js'])
mergeBranch(group, 'team/alpha/a1')
const conflict = mergeBranch(group, 'team/alpha/a2')
check('a conflicting merge is detected, not auto-resolved', conflict.code === 'merge-conflict' && conflict.escalate === true, JSON.stringify(conflict))
check('the conflicting file is named in the escalation', Array.isArray(conflict.files) && conflict.files.includes('js/a.js'), JSON.stringify(conflict.files))

// authorization, end to end against the real member tree
const members = new Map([
  ['lead', { name: 'lead', tier: 0, group: 'root' }],
  ['alpha', { name: 'alpha', tier: 1, group: 'alpha', parent: 'lead' }],
  ['a1', { name: 'a1', tier: 2, group: 'alpha', parent: 'alpha' }],
])
const get = (r, n) => r.members.get(n)
check('the spawning lead can merge its own member', mergePlan({ members }, 'alpha', 'a1', get).ok === true)
check('tier 0 cannot merge a tier 2 member directly', mergePlan({ members }, 'lead', 'a1', get).ok === false)

// ---- laying out the topology for real ----
// The script built its four worktrees by hand above; rebuilding them with the plugin
// itself proves the TOOL, not just the arithmetic, produces the topology.
for (const name of ['team__alpha__a1', 'team__alpha__a2', 'grp__alpha', 'team__alpha__verifier']) {
  try { run(['worktree', 'remove', '--force', join(root, name)]) } catch {}
}
try { run(['worktree', 'prune']) } catch {}

const mkWt = (branch, base, readOnly) => worktreeAdd(repo, worktreePath(root, branch), branch, base, undefined, readOnly)
const created = mkWt('team/alpha/setup-probe', 'main', false)
check('worktreeAdd creates a new branch worktree', created.ok === true && created.created === true, JSON.stringify(created))
const again = mkWt('team/alpha/setup-probe', 'main', false)
check('worktreeAdd is idempotent', again.ok === true && again.created === false, JSON.stringify(again))
const ro = mkWt('team/alpha/ro-probe', 'main', true)
check('a read-only checkout is created detached', ro.ok === true && ro.readOnly === true, JSON.stringify(ro))
const roHead = git(worktreePath(root, 'team/alpha/ro-probe'), ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
check('a detached checkout has no branch to commit into', roHead === 'HEAD', roHead)
check('worktreeAdd refuses a directory that is not a repository', worktreeAdd(tmpdir(), join(root, 'nope'), 'x', 'main', undefined, false).code === 'not-a-git-repository')

// ---- who may lay out whose worktree ----
const setupTree = new Map([
  ['lead', { name: 'lead', tier: 0, group: 'root' }],
  ['alpha', { name: 'alpha', tier: 1, group: 'alpha', parent: 'lead' }],
  ['beta', { name: 'beta', tier: 1, group: 'beta', parent: 'lead' }],
  ['a1', { name: 'a1', tier: 2, group: 'alpha', parent: 'alpha' }],
  ['verifier', { name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' }],
])
const sg = (r, n) => r.members.get(n)
const setup = (caller, target) => setupPlan({ members: setupTree }, caller, target, sg)
check('tier 0 lays out a group lead on the group branch', setup('lead', 'alpha').ok && setup('lead', 'alpha').branch === 'grp/alpha')
check('a group lead lays out its own member on the member branch', setup('alpha', 'a1').ok && setup('alpha', 'a1').branch === 'team/alpha/a1')
check('a group lead cannot lay out another group member', setup('beta', 'a1').code === 'only-the-spawning-lead-lays-out-its-member')
check('tier 0 cannot lay out a tier 2 member directly', setup('lead', 'a1').code === 'only-the-spawning-lead-lays-out-its-member')
check('the verifier lays out its own checkout, read-only', setup('verifier', 'verifier').ok && setup('verifier', 'verifier').readOnly === true)
check('nobody else lays out the verifier checkout', setup('lead', 'verifier').code === 'only-the-verifier-lays-out-its-own-read-only-checkout')

rmSync(repo, { recursive: true, force: true })
console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
