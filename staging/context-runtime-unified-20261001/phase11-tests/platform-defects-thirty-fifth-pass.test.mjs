import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply as applyWriteScopeGuard, shellWriteTargets } from '../home/profiles/web/plugins/write-scope-guard.mjs'
import { recordWaiting } from '../home/profiles/web/plugins/team-v14-waiting.mjs'
import { waitingSetTargetVerdict } from '../home/profiles/web/plugins/team-v12-runtime.mjs'

test('B-218: a pwsh -File script exposes its static writes to the guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-'))
  try {
    const script = join(root, 'write-outside.ps1')
    writeFileSync(script, "Set-Content -LiteralPath 'outside.txt' -Value x\n", 'utf8')
    const parsed = shellWriteTargets(`pwsh -File "${script}"`, join(root, 'work'))
    assert.equal(parsed.opaque, false)
    assert.deepEqual(parsed.targets, [resolve(root, 'outside.txt')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218: a pwsh -File script follows a static nested script invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-nested-'))
  try {
    const helper = join(root, 'helper.ps1')
    const outer = join(root, 'outer.ps1')
    writeFileSync(helper, "Set-Content -LiteralPath 'nested-outside.txt' -Value x\n", 'utf8')
    writeFileSync(outer, '& "$PSScriptRoot\\helper.ps1"\n', 'utf8')
    const parsed = shellWriteTargets(`pwsh -File "${outer}"`, root)
    assert.equal(parsed.opaque, false)
    assert.deepEqual(parsed.targets, [resolve(root, 'nested-outside.txt')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218: pre-execute rejects writes made by a pwsh -File script', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-pre-execute-'))
  try {
    const script = join(root, 'write-outside.ps1')
    const scopesFile = join(root, 'scopes.json')
    writeFileSync(script, "Set-Content -LiteralPath 'outside.txt' -Value x\n", 'utf8')
    writeFileSync(scopesFile, JSON.stringify({
      rootDir: root,
      defaultDeny: true,
      byName: { lead: ['allowed.txt'] },
    }))
    const member = { name: 'lead', tier: 0, role: 'lead', group: 'root', status: 'active' }
    const agent = { id: 'lead', name: 'lead', session: { id: 'lead-session', header: { cwd: root } } }
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
    applyWriteScopeGuard(ctx, { scopesFile, enforce: true, controlDir: join(root, 'control') })
    await assert.rejects(() => hooks.get('tools/pre-execute')[0]({
      tool: { name: 'pwsh' },
      arguments: { command: `pwsh -File "${script}"`, workdir: root },
      agent,
    }, async () => ({ kind: 'allow' })), /outside this member write scope/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-218: a non-UTF-8 script is opaque instead of silently unscanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-b218-utf16-'))
  try {
    const script = join(root, 'utf16.ps1')
    writeFileSync(script, Buffer.from("Set-Content -LiteralPath 'outside.txt' -Value x\n", 'utf16le'))
    const parsed = shellWriteTargets(`pwsh -File "${script}"`, root)
    assert.equal(parsed.opaque, true)
    assert.deepEqual(parsed.targets, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B-219: a dynamic expression target is opaque instead of a fake path', () => {
  const parsed = shellWriteTargets(
    'Set-Content -LiteralPath ($env:TEMP + "\\mt_proto.txt") -Value x',
    'D:/dsh-test/workspaces/RustMc',
  )
  assert.equal(parsed.opaque, true)
  assert.deepEqual(parsed.targets, [])
})

test('B-220: waiting_set updates the existing open ticket for the same task', () => {
  const state = {
    boards: {
      main: {
        tasks: {
          t: { id: 't', ownerName: 'm', revision: 2, status: 'pending' },
        },
      },
    },
  }
  const first = recordWaiting(state, {
    taskId: 't',
    owner: 'm',
    waiter: 'lead',
    responsible: 'verifier',
    reason: 'manual',
    unblockCondition: { type: 'manual' },
  }, 'lead', { now: 100 })
  const target = waitingSetTargetVerdict(state, {
    taskId: 't',
    owner: 'm',
    waiter: 'lead',
    responsible: 'lead-world',
    reason: 'manual',
    unblockCondition: { type: 'manual' },
  })
  assert.equal(target.ok, true)
  assert.equal(target.ticketId, first.ticketId)
  const updated = recordWaiting(state, {
    ticketId: target.ticketId,
    taskId: 't',
    owner: 'm',
    waiter: 'lead',
    responsible: 'lead-world',
    reason: 'manual',
    unblockCondition: { type: 'manual' },
    taskRevision: 3,
  }, 'lead', { now: 200 })
  assert.equal(updated.ticketId, first.ticketId)
  assert.equal(updated.responsible, 'lead-world')
  assert.equal(Object.keys(state.v14Waiting.tickets).length, 1)
})
