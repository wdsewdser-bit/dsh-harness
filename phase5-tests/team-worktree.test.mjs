#!/usr/bin/env node
/** Phase 5: worktree isolation and the merge gate (Agent Team v2). */
import { mergePlan, clearanceGate, mergeBranch, groupBranch, memberBranch, worktreePath, integrationBranch, BRANCH_MAIN } from '../home/profiles/web/plugins/team-worktree.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}

const members = new Map([
  ['lead', { name: 'lead', tier: 0, group: 'root' }],
  ['alpha', { name: 'alpha', tier: 1, group: 'alpha', parent: 'lead' }],
  ['beta', { name: 'beta', tier: 1, group: 'beta', parent: 'lead' }],
  ['a1', { name: 'a1', tier: 2, group: 'alpha', parent: 'alpha' }],
  ['b1', { name: 'b1', tier: 2, group: 'beta', parent: 'beta' }],
  ['frozen-lead', { name: 'frozen-lead', tier: 1, group: 'gamma', parent: 'lead', frozen: true }],
])
const reg = { members }
const get = (registry, name) => registry.members.get(name)
const plan = (caller, target) => mergePlan(reg, caller, target, get)

// ---- branch topology ----
check('a member branch nests under its group branch', memberBranch('alpha', 'a1') === 'team/alpha/a1' && groupBranch('alpha') === 'grp/alpha')
check('worktree paths flatten the slashes', worktreePath('.dsh-worktrees', 'team/alpha/a1') === '.dsh-worktrees/team__alpha__a1')
check('tier 0 integrates into main', integrationBranch(get(reg, 'lead')) === BRANCH_MAIN)
check('a group lead integrates into its group branch', integrationBranch(get(reg, 'alpha')) === 'grp/alpha')
check('a member integrates into its own branch', integrationBranch(get(reg, 'a1')) === 'team/alpha/a1')

// ---- who may merge what ----
{
  const p = plan('alpha', 'a1')
  check('the spawning lead may merge its member into the group branch', p.ok && p.source === 'team/alpha/a1' && p.dest === 'grp/alpha', JSON.stringify(p))
}
check('another group lead cannot merge a member it did not spawn', plan('beta', 'a1').code === 'only-the-spawning-lead-may-merge', JSON.stringify(plan('beta', 'a1')))
check('tier 0 cannot reach past a lead and merge a tier-2 member', plan('lead', 'a1').code === 'only-the-spawning-lead-may-merge', JSON.stringify(plan('lead', 'a1')))
check('a member cannot merge another member', plan('a1', 'b1').code === 'only-the-spawning-lead-may-merge' && plan('a1', 'a2').code === 'unknown-target', JSON.stringify(plan('a1', 'b1')))
check('a member cannot merge to main', plan('a1', 'alpha').code === 'only-tier-0-may-merge-to-main', JSON.stringify(plan('a1', 'alpha')))
check('a group lead cannot merge itself to main', plan('beta', 'beta').code === 'only-tier-0-may-merge-to-main', JSON.stringify(plan('beta', 'beta')))
{
  const p = plan('lead', 'alpha')
  check('tier 0 merges a group branch into main', p.ok && p.source === 'grp/alpha' && p.dest === 'main' && p.needsClearance === true, JSON.stringify(p))
}
check('a frozen target is refused', plan('lead', 'frozen-lead').code === 'target-frozen', JSON.stringify(plan('lead', 'frozen-lead')))
check('an unknown member is refused', plan('lead', 'ghost').code === 'unknown-target' && plan('ghost', 'alpha').code === 'unknown-caller')

// ---- the verifier clearance gate on main ----
check('main refuses a branch with no verifier record', clearanceGate(undefined, 'abc').code === 'no-verifier-clearance')
check('main refuses a clearance for a different commit', clearanceGate({ commit: 'old', severity: 'minor' }, 'abc').code === 'clearance-is-for-another-commit')
check('main refuses a blocker', clearanceGate({ commit: 'abc', severity: 'blocker' }, 'abc').code === 'verifier-found-a-blocker')
check('main refuses a major finding', clearanceGate({ commit: 'abc', severity: 'major' }, 'abc').code === 'verifier-found-a-major')
check('main accepts a clean clearance for that exact commit', clearanceGate({ commit: 'abc', severity: 'minor' }, 'abc').ok === true)

// ---- git outcomes, driven through a fake runner ----
const sig = (code, stdout = '', stderr = '') => ({ code, stdout, stderr })
const runnerFor = (map) => (cwd, args) => {
  const key = args.join(' ')
  for (const [prefix, value] of map) if (key.startsWith(prefix)) return typeof value === 'function' ? value(cwd, args) : value
  return sig(1, '', 'unexpected: ' + key)
}
{
  const r = mergeBranch('/w', 'grp/alpha', runnerFor([['rev-parse --git-dir', sig(128, '', 'not a git repository')]]))
  check('a directory that is not a git repository is refused', r.code === 'not-a-git-repository', JSON.stringify(r))
}
{
  const r = mergeBranch('/w', 'grp/alpha', runnerFor([['rev-parse --git-dir', sig(0, '.git')], ['rev-parse HEAD', sig(0, 'aaa')], ['merge --no-ff', sig(0, '')]]))
  check('a clean merge reports the resulting commit', r.ok === true && r.commit === 'aaa', JSON.stringify(r))
}
{
  const r = mergeBranch('/w', 'grp/alpha', runnerFor([
    ['rev-parse --git-dir', sig(0, '.git')],
    ['rev-parse HEAD', sig(0, 'aaa')],
    ['merge --no-ff', sig(1, '', 'CONFLICT')],
    ['diff --name-only', sig(0, 'js/render.js\njs/world.js\n')],
  ]))
  check('a conflict is reported with its files and marked for escalation', r.code === 'merge-conflict' && r.escalate === true && r.files.length === 2 && r.files[0] === 'js/render.js', JSON.stringify(r))
  check('a conflict is never auto-resolved into a success', r.ok !== true)
}
{
  const r = mergeBranch('/w', 'grp/alpha', runnerFor([
    ['rev-parse --git-dir', sig(0, '.git')],
    ['rev-parse HEAD', sig(0, 'aaa')],
    ['merge --no-ff', sig(1, '', 'fatal: refusing to merge unrelated histories')],
    ['diff --name-only', sig(0, '')],
  ]))
  check('a non-conflict merge failure is reported as such', r.code === 'merge-failed' && r.escalate === undefined, JSON.stringify(r))
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
