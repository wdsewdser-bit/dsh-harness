import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply as applyWriteScopeGuard } from '../home/profiles/web/plugins/write-scope-guard.mjs'

const PLAN_SCOPES = ['tools/rig-batch/tests/']

function makeAgent(root, name = 'lead') {
  return {
    id: name,
    name,
    session: { id: name + '-session', header: { cwd: root } },
  }
}

function makeHarness(root, { lease = false } = {}) {
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
    byName: { lead: PLAN_SCOPES },
  }), 'utf8')
  const controlPlane = {
    leaseList: () => lease
      ? [{ member: 'lead', status: 'active', taskId: 't223', expiresAt: Date.now() + 60_000 }]
      : [],
    planState: (taskId) => lease && taskId === 't223'
      ? { state: 'plan-approved', writeScopes: PLAN_SCOPES }
      : undefined,
    boardSnapshot: () => ({ rig: { tasks: { t223: { id: 't223', worktreePath: root } } } }),
  }
  applyWriteScopeGuard(ctx, {
    scopesFile,
    enforce: true,
    controlDir: join(root, 'control'),
    controlPlane,
  })
  return { agent: makeAgent(root), hooks }
}

async function runPreExecute({ root, command, lease = false }) {
  const { agent, hooks } = makeHarness(root, { lease })
  return hooks.get('tools/pre-execute')[0]({
    tool: { name: 'pwsh' },
    arguments: { command, workdir: root },
    agent,
  }, async () => ({ kind: 'allow' }))
}

function writeScopedScript(root) {
  const script = join(root, 'tools', 'rig-batch', 'tests', 'run.ps1')
  mkdirSync(join(script, '..'), { recursive: true })
  writeFileSync(
    script,
    "$parts = @('out', '.log')\n$out = Join-Path (Get-Location).Path ($parts -join '')\nSet-Content -LiteralPath $out -Value x\n",
    'utf8',
  )
  return script
}

test('B-213c: all no-lease -File variants report the missing plan lease, not write capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b213c-no-lease-'))
  try {
    const script = writeScopedScript(root)
    const output = join(root, 'out.log')
    const commands = [
      `& pwsh -NoProfile -File "${script}" -OutFile "${output}"`,
      `pwsh -NoProfile -File "${script}" -OutFile "${output}"`,
      `& pwsh -NoProfile -File "${script}"`,
      `pwsh -NoProfile -File "${script}"`,
    ]
    for (const command of commands) {
      await assert.rejects(() => runPreExecute({ root, command }), (error) => {
        assert.match(error.message, /\[active-plan-required\]/)
        assert.match(error.message, /has no declared static scope or active approved plan lease/)
        assert.match(error.message, /active lease: none/)
        assert.doesNotMatch(error.message, /can write through an inline interpreter or opaque expression/)
        return true
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-213c: a sanctioned in-scope -File script remains allowed with a valid lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b213c-lease-'))
  try {
    const script = writeScopedScript(root)
    const output = join(root, 'out.log')
    const commands = [
      `pwsh -NoProfile -File "${script}"`,
      `pwsh -NoProfile -File "${script}" -OutFile "${output}"`,
    ]
    for (const command of commands) {
      assert.deepEqual(await runPreExecute({ root, command, lease: true }), { kind: 'allow' })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-213c: unverifiable non-File composition is named without claiming write capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b213c-composition-'))
  try {
    const script = writeScopedScript(root)
    await assert.rejects(() => runPreExecute({
      root,
      command: `pwsh -NoProfile -File "${script}"; Set-Content outside.txt -Value x`,
      lease: true,
    }), (error) => {
      assert.match(error.message, /\[explicit-file-required\]/)
      assert.match(error.message, /not a single explicit pwsh -File invocation/)
      assert.doesNotMatch(error.message, /can write through an inline interpreter or opaque expression/)
      return true
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
