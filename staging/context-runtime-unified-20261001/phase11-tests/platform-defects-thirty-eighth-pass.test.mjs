import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply as applyWriteScopeGuard } from '../home/profiles/web/plugins/write-scope-guard.mjs'

const PLAN_SCOPES = ['tools/rig-batch/tests/', 'tests/golden/rig-batch/', 'target/']

function makeAgent(root, name = 'lead') {
  return {
    id: name,
    name,
    session: { id: name + '-session', header: { cwd: root } },
  }
}

function makeContext(root, agent, planScopes = PLAN_SCOPES, worktreePath = root) {
  const member = { name: 'lead', tier: 1, role: 'lead', group: 'rig', status: 'active' }
  const hooks = new Map()
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
  const scopesFile = join(root, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({
    rootDir: root,
    defaultDeny: true,
    byName: { lead: planScopes },
  }), 'utf8')
  const controlPlane = {
    leaseList: () => [{ member: 'lead', status: 'active', taskId: 't114', expiresAt: Date.now() + 60_000 }],
    planState: (taskId) => taskId === 't114'
      ? { state: 'plan-approved', writeScopes: planScopes }
      : undefined,
    boardSnapshot: () => ({ rig: { tasks: { t114: { id: 't114', worktreePath } } } }),
  }
  applyWriteScopeGuard(ctx, {
    scopesFile,
    enforce: true,
    controlDir: join(root, 'control'),
    controlPlane,
  })
  return { agent, hooks }
}

async function runPreExecute({
  root,
  command,
  tool = 'pwsh',
  planScopes = PLAN_SCOPES,
  cwd = root,
  worktreePath = root,
}) {
  const agent = makeAgent(root)
  const { hooks } = makeContext(root, agent, planScopes, worktreePath)
  return hooks.get('tools/pre-execute')[0]({
    tool: { name: tool },
    arguments: { command, workdir: cwd },
    agent,
  }, async () => ({ kind: 'allow' }))
}

function writeScopedScript(root, relative, source) {
  const script = join(root, relative)
  mkdirSync(join(script, '..'), { recursive: true })
  writeFileSync(script, source, 'utf8')
  return script
}

test('B-218 regression: a scoped -File script with runtime paths is allowed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-scoped-'))
  try {
    const script = writeScopedScript(
      root,
      'tools/rig-batch/tests/run.ps1',
      "$parts = @('out', '.log')\n$out = Join-Path (Get-Location).Path ($parts -join '')\nSet-Content -LiteralPath $out -Value x\n",
    )
    const result = await runPreExecute({
      root,
      command: `pwsh -NoProfile -File "${script}"`,
    })
    assert.deepEqual(result, { kind: 'allow' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218 regression: a -File script outside the approved plan remains denied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-outside-'))
  try {
    const script = writeScopedScript(
      root,
      'outside/run.ps1',
      "$parts = @('out', '.log')\n$out = Join-Path (Get-Location).Path ($parts -join '')\nSet-Content -LiteralPath $out -Value x\n",
    )
    await assert.rejects(() => runPreExecute({
      root,
      command: `pwsh -NoProfile -File "${script}"`,
    }), /\[script-outside-plan-scope\]/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218 regression: a scoped -File script still enforces the bound worktree carrier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-carrier-'))
  try {
    const boundWorktree = join(root, 'bound-worktree')
    const script = writeScopedScript(
      boundWorktree,
      'tools/rig-batch/tests/run.ps1',
      "$parts = @('out', '.log')\n$out = Join-Path (Get-Location).Path ($parts -join '')\nSet-Content -LiteralPath $out -Value x\n",
    )
    await assert.rejects(() => runPreExecute({
      root,
      cwd: root,
      worktreePath: boundWorktree,
      command: `pwsh -NoProfile -File "${script}"`,
    }), /worktree-carrier-mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218 regression: inline pwsh -Command stays fail-closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-inline-'))
  try {
    await assert.rejects(() => runPreExecute({
      root,
      command: 'pwsh -NoProfile -Command "Set-Content -LiteralPath outside.txt -Value x"',
    }), /opaque expression/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218 regression: a bash wrapper around a scoped -File script stays fail-closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-bash-'))
  try {
    const script = writeScopedScript(
      root,
      'tools/rig-batch/tests/run.ps1',
      "$parts = @('out', '.log')\n$out = Join-Path (Get-Location).Path ($parts -join '')\nSet-Content -LiteralPath $out -Value x\n",
    )
    await assert.rejects(() => runPreExecute({
      root,
      tool: 'bash',
      command: `bash -lc 'pwsh -NoProfile -File "${script}"'`,
    }), /opaque expression/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218 regression: a shell separator around a scoped script stays fail-closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-separator-'))
  try {
    const script = writeScopedScript(
      root,
      'tools/rig-batch/tests/run.ps1',
      "$parts = @('out', '.log')\n$out = Join-Path (Get-Location).Path ($parts -join '')\nSet-Content -LiteralPath $out -Value x\n",
    )
    await assert.rejects(() => runPreExecute({
      root,
      command: `pwsh -NoProfile -File "${script}"; Set-Content outside.txt -Value x`,
    }), /\[explicit-file-required\]/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218 regression: a missing or non-UTF-8 top-level script stays fail-closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-invalid-'))
  try {
    const missing = join(root, 'tools', 'rig-batch', 'tests', 'missing.ps1')
    await assert.rejects(() => runPreExecute({
      root,
      command: `pwsh -NoProfile -File "${missing}"`,
    }), /\[script-invalid\]/)

    const utf16 = join(root, 'tools', 'rig-batch', 'tests', 'utf16.ps1')
    mkdirSync(join(utf16, '..'), { recursive: true })
    writeFileSync(utf16, Buffer.from("Set-Content -LiteralPath 'outside.txt' -Value x\n", 'utf16le'))
    await assert.rejects(() => runPreExecute({
      root,
      command: `pwsh -NoProfile -File "${utf16}"`,
    }), /\[script-invalid\]/)

    const invalidUtf8 = join(root, 'tools', 'rig-batch', 'tests', 'invalid-utf8.ps1')
    writeFileSync(invalidUtf8, Buffer.from([0xff, 0x53, 0x65, 0x74, 0x0a]))
    await assert.rejects(() => runPreExecute({
      root,
      command: `pwsh -NoProfile -File "${invalidUtf8}"`,
    }), /\[script-invalid\]/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
