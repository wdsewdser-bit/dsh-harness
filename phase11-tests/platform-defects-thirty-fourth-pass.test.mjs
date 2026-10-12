import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:/dsh-test/home/profiles/web/plugins/'
const guard = await import(pathToFileURL(base + 'write-scope-guard.mjs').href)
const cwd = 'D:/dsh-test/workspaces/RustMc'

test('B-213 resolves a Join-Path assignment to its path instead of the cmdlet name', () => {
  const parsed = guard.shellWriteTargets(
    '$p = Join-Path "a" "b"; Set-Content -LiteralPath $p -Value x',
    cwd,
  )
  assert.equal(parsed.opaque, false)
  assert.deepEqual(parsed.targets, ['D:\\dsh-test\\workspaces\\RustMc\\a\\b'])
})

test('B-213 keeps literal variable targets while refusing unknown dynamic targets', () => {
  const literal = guard.shellWriteTargets(
    '$p = "literal.tmp"; Set-Content -LiteralPath $p -Value x',
    cwd,
  )
  assert.equal(literal.opaque, false)
  assert.deepEqual(literal.targets, ['D:\\dsh-test\\workspaces\\RustMc\\literal.tmp'])

  const dynamic = guard.shellWriteTargets(
    '$p = [string]::Concat("a", "b"); Set-Content -LiteralPath $p -Value x',
    cwd,
  )
  assert.equal(dynamic.opaque, true)
  assert.deepEqual(dynamic.targets, [])
})

test('B-213b treats an unknown cmdlet with a write-shaped switch as opaque', () => {
  const parsed = guard.shellWriteTargets(
    'Start-Process -FilePath pwsh -ArgumentList x -PassThru',
    cwd,
  )
  assert.equal(parsed.opaque, true)
  assert.deepEqual(parsed.targets, [])

  const acl = guard.shellWriteTargets('Set-Acl -Path "outside.txt" -AclObject $acl', cwd)
  assert.equal(acl.opaque, true)
  assert.deepEqual(acl.targets, [])
})

test('B-213b keeps known read-only cmdlets with path switches non-opaque', () => {
  const parsed = guard.shellWriteTargets('Test-Path -LiteralPath "literal.tmp"', cwd)
  assert.equal(parsed.opaque, false)
  assert.deepEqual(parsed.targets, [])
})

test('B-213b refuses a write through a dynamically invoked cmdlet name', () => {
  const parsed = guard.shellWriteTargets(
    '$c = "Set-Content"; & $c -LiteralPath "amp2.tmp" -Value x -WhatIf',
    cwd,
  )
  assert.equal(parsed.opaque, true)
  assert.deepEqual(parsed.targets, [])
})

test('worktree carrier keeps tier-1 writes inside the member worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worktree-carrier-'))
  const worktree = join(root, '.dsh-worktrees', 'team__world__member-world-anvil')
  const scopesFile = join(root, 'scopes.json')
  mkdirSync(join(worktree, 'crates', 'mc-world', 'src'), { recursive: true })
  writeFileSync(scopesFile, JSON.stringify({
    rootDir: root,
    defaultDeny: true,
    byName: {},
  }))
  const hooks = new Map()
  const member = {
    name: 'member-world-anvil',
    tier: 1,
    role: 'teammate',
    group: 'world',
  }
  const agent = {
    id: 'member-world-anvil',
    name: 'member-world-anvil',
    session: { id: 'world-anvil-session', header: { cwd: root } },
  }
  const ctx = {
    agentTeams: { tryMembership: () => member },
    logger: { warn: () => {} },
    on: (event, callback) => {
      hooks.set(event, callback)
      return () => {}
    },
  }
  const controlPlane = {
    leaseList: () => [{
      member: member.name,
      taskId: 'group-world-t140',
      status: 'active',
      expiresAt: Date.now() + 60_000,
    }],
    planState: () => ({
      state: 'plan-approved',
      writeScopes: [
        'crates/mc-world/src/block_registry.rs',
        'crates/mc-world/src/lib.rs',
      ],
    }),
    boardSnapshot: () => ({
      'group-world': {
        tasks: {
          'group-world-t140': {
            id: 'group-world-t140',
            worktreePath: worktree,
          },
        },
      },
    }),
  }
  guard.apply(ctx, { scopesFile, enforce: true, controlDir: root, controlPlane })
  const writeIntent = hooks.get('fs/write-intent')
  const worktreeTarget = join(worktree, 'crates', 'mc-world', 'src', 'block_registry.rs')
  assert.doesNotThrow(() => writeIntent({
    displayPath: worktreeTarget,
    targetKey: worktreeTarget,
  }, { agent }))
  const sessionTarget = join(root, 'crates', 'mc-world', 'src', 'block_registry.rs')
  assert.throws(() => writeIntent({
    displayPath: sessionTarget,
    targetKey: sessionTarget,
  }, { agent }), (error) => error?.code === 'FS_WRITE_OUT_OF_SCOPE'
    && /worktree-carrier-mismatch/.test(String(error.message)))
  rmSync(root, { recursive: true, force: true })
})
