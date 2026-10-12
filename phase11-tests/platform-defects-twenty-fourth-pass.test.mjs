import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { projectLeasesForMember } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'
import {
  apply,
  gitCommandWorkdir,
  worktreeCarrierVerdict,
} from '../home/profiles/web/plugins/write-scope-guard.mjs'
import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'

const tempDirs = []
afterEach(() => {
  resetControlPlaneCache()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function guardHarness({ member, scopes, controlDir, cwd }) {
  const hooks = new Map()
  const agent = {
    id: member.name,
    name: member.name,
    session: { id: member.name + '-session', header: { cwd } },
  }
  const ctx = {
    agentTeams: {
      tryMembership: () => member,
      listMembers: () => [member],
    },
    logger: { warn: () => {} },
    on: (event, callback) => {
      const rows = hooks.get(event) ?? []
      rows.push(callback)
      hooks.set(event, rows)
      return () => {}
    },
  }
  apply(ctx, { scopesFile: scopes, enforce: true, controlDir })
  return {
    agent,
    hook: (event) => hooks.get(event)?.[0],
  }
}

test('D-new-14 follow-up: tier 0 member filtering applies when explicitly requested', () => {
  const leases = [
    { runId: 'run-a', member: 'member-a', taskId: 'task-a', status: 'active', acquiredAt: 200 },
    { runId: 'run-b', member: 'member-b', taskId: 'task-b', status: 'active', acquiredAt: 300 },
    { runId: 'run-c', member: 'member-a', taskId: 'task-c', status: 'completed', acquiredAt: 100 },
  ]

  assert.deepEqual(
    projectLeasesForMember(leases, { tier: 0, member: '' }).map((lease) => lease.runId),
    ['run-b', 'run-a', 'run-c'],
  )
  assert.deepEqual(
    projectLeasesForMember(leases, { tier: 0, member: 'member-a' }).map((lease) => lease.runId),
    ['run-a', 'run-c'],
  )
  assert.deepEqual(
    projectLeasesForMember(leases, {
      tier: 0,
      member: 'member-a',
      taskId: 'task-a',
      status: 'active',
    }).map((lease) => lease.runId),
    ['run-a'],
  )
  assert.deepEqual(
    projectLeasesForMember(leases, { tier: 2, member: '' }).map((lease) => lease.runId),
    [],
  )
})

test('D-new-15: git -C and carrier verdict distinguish bound worktrees from the shared checkout', () => {
  const shared = resolve('D:/repo')
  const bound = resolve('D:/repo/.dsh-worktrees/team__rig__rig-runner')
  const other = resolve('D:/repo/.dsh-worktrees/team__rig__rig-capture')

  assert.equal(gitCommandWorkdir('git commit -m t123', shared), null)
  assert.equal(
    gitCommandWorkdir('git -C "' + shared + '" commit -m t123', bound),
    shared,
  )

  assert.deepEqual(
    worktreeCarrierVerdict({
      activePlan: { member: 'rig-runner', taskId: 'group-rig-t66', worktreePath: bound },
      tier: 1,
      carrierPath: join(bound, 'crates', 'demo', 'src', 'lib.rs'),
    }).ok,
    true,
  )
  const sharedVerdict = worktreeCarrierVerdict({
    activePlan: { member: 'rig-runner', taskId: 'group-rig-t66', worktreePath: bound },
    tier: 1,
    carrierPath: join(shared, 'crates', 'demo', 'src', 'lib.rs'),
  })
  assert.equal(sharedVerdict.ok, false)
  assert.equal(sharedVerdict.code, 'worktree-carrier-mismatch')
  assert.equal(worktreeCarrierVerdict({
    activePlan: { member: 'rig-runner', taskId: 'group-rig-t66', worktreePath: bound },
    tier: 1,
    carrierPath: join(other, 'crates', 'demo', 'src', 'lib.rs'),
  }).ok, false)
  assert.equal(worktreeCarrierVerdict({
    activePlan: { member: 'lead-rig', taskId: 'group-rig-t66' },
    tier: 1,
    carrierPath: join(shared, 'crates', 'demo', 'src', 'lib.rs'),
  }).code, 'worktree-binding-missing')
  assert.equal(worktreeCarrierVerdict({
    activePlan: { member: 'lead-rig', taskId: 'group-rig-t66' },
    tier: 0,
    carrierPath: shared,
  }).enforced, false)
})

test('D-new-15: the write guard rejects shared-checkout writes and commits but allows the bound worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-d15-write-carrier-'))
  tempDirs.push(root)
  const shared = join(root, 'RustMc')
  const bound = join(shared, '.dsh-worktrees', 'team__rig__rig-runner')
  const other = join(shared, '.dsh-worktrees', 'team__rig__rig-capture')
  const controlDir = join(root, 'control')
  const scopesFile = join(root, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({
    rootDir: shared,
    defaultDeny: true,
    byName: { 'rig-runner': ['crates/demo/src/lib.rs'] },
  }))

  const member = {
    id: 'team-root',
    teamId: 'team-root',
    name: 'rig-runner',
    tier: 1,
    role: 'lead',
    group: 'rig',
    status: 'active',
  }
  const cp = controlPlaneFor('team-root', { directory: controlDir })
  await cp.mutate('fixture/d15-carrier', {}, member, (state) => {
    state.leases = {
      run: {
        member: 'rig-runner',
        taskId: 'group-rig-t66',
        status: 'active',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    }
    state.plans = {
      'group-rig-t66': {
        state: 'plan-approved',
        writeScopes: ['crates/demo/src/lib.rs'],
      },
    }
    state.boards = {
      global: {
        tasks: {
          'group-rig-t66': {
            id: 'group-rig-t66',
            ownerName: 'rig-runner',
            worktreePath: bound,
            phase: 'execution',
            status: 'in_progress',
          },
        },
      },
    }
  }, { deferMs: 0 })
  await cp.flush()

  const h = guardHarness({ member, scopes: scopesFile, controlDir, cwd: shared })
  const writeIntent = h.hook('fs/write-intent')
  const preExecute = h.hook('tools/pre-execute')

  assert.doesNotThrow(() => writeIntent({
    displayPath: join(bound, 'crates', 'demo', 'src', 'lib.rs'),
    targetKey: join(bound, 'crates', 'demo', 'src', 'lib.rs'),
  }, { agent: h.agent }))
  assert.throws(() => writeIntent({
    displayPath: join(shared, 'crates', 'demo', 'src', 'lib.rs'),
    targetKey: join(shared, 'crates', 'demo', 'src', 'lib.rs'),
  }, { agent: h.agent }), (error) => /worktree-carrier-mismatch/.test(error?.message))
  assert.throws(() => writeIntent({
    displayPath: join(other, 'crates', 'demo', 'src', 'lib.rs'),
    targetKey: join(other, 'crates', 'demo', 'src', 'lib.rs'),
  }, { agent: h.agent }), (error) => /worktree-carrier-mismatch/.test(error?.message))

  await assert.rejects(() => preExecute({
    tool: { name: 'bash' },
    arguments: { command: 'git commit -m t123', workdir: shared },
    agent: h.agent,
  }, async () => ({ kind: 'allow' })), /worktree-carrier-mismatch/)
  await assert.rejects(() => preExecute({
    tool: { name: 'bash' },
    arguments: { command: 'git -C "' + shared + '" commit -m t123', workdir: bound },
    agent: h.agent,
  }, async () => ({ kind: 'allow' })), /worktree-carrier-mismatch/)

  const allowed = await preExecute({
    tool: { name: 'bash' },
    arguments: { command: 'git -C "' + bound + '" commit -m t123', workdir: shared },
    agent: h.agent,
  }, async () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
})

test('tier 0 keeps the shared-checkout compatibility path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-d15-tier0-'))
  tempDirs.push(root)
  const scopesFile = join(root, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({
    rootDir: root,
    defaultDeny: true,
    byName: { lead: '*' },
  }))
  const h = guardHarness({
    member: { name: 'lead', tier: 0, role: 'lead', group: 'root', status: 'active' },
    scopes: scopesFile,
    controlDir: join(root, 'control'),
    cwd: root,
  })
  const allowed = await h.hook('tools/pre-execute')({
    tool: { name: 'bash' },
    arguments: { command: 'git commit -m tier0', workdir: root },
    agent: h.agent,
  }, async () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
})
