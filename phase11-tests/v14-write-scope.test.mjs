import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, runCodeWriteRisk } from '../home/profiles/web/plugins/write-scope-guard.mjs'

const tempDirs = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v14-write-scope-'))
  tempDirs.push(root)
  const scopesFile = join(root, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({
    rootDir: root,
    defaultDeny: true,
    byName: { lead: ['docs', 'reports', 'scratch', 'tmp', 'downloads'] },
  }))
  const hooks = new Map()
  const member = { name: 'lead', tier: 0, role: 'lead', group: 'root' }
  const agent = { id: 'lead', name: 'lead', session: { id: 'lead-session', header: { cwd: root } } }
  const ctx = {
    agentTeams: { tryMembership: () => member },
    logger: { warn: () => {} },
    on: (event, callback) => {
      const rows = hooks.get(event) ?? []
      rows.push(callback)
      hooks.set(event, rows)
      return () => {}
    },
  }
  apply(ctx, { scopesFile, enforce: true })
  return {
    root,
    agent,
    hook: (event) => hooks.get(event)?.[0],
  }
}

test('tier 0 operational directories are allowed but product and arbitrary paths stay denied', () => {
  const h = harness()
  const writeIntent = h.hook('fs/write-intent')
  assert.equal(typeof writeIntent, 'function')
  assert.doesNotThrow(() => writeIntent({
    displayPath: join(h.root, 'docs', 'handoff.md'),
    targetKey: join(h.root, 'docs', 'handoff.md'),
  }, { agent: h.agent }))
  assert.throws(() => writeIntent({
    displayPath: join(h.root, 'src', 'main.mjs'),
    targetKey: join(h.root, 'src', 'main.mjs'),
  }, { agent: h.agent }), (error) => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
})

test('static scope resolves the Team membership when the root agent has no name', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v14-write-scope-membership-'))
  tempDirs.push(root)
  const scopesFile = join(root, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({
    rootDir: root,
    defaultDeny: true,
    byName: { lead: ['docs'] },
  }))
  const hooks = new Map()
  const agent = {
    id: 'root-agent-id',
    session: { id: 'root-session', header: { cwd: root } },
  }
  const ctx = {
    agentTeams: { tryMembership: () => ({ name: 'lead', tier: 0, role: 'lead', group: 'root' }) },
    logger: { warn: () => {} },
    on: (event, callback) => {
      hooks.set(event, callback)
      return () => {}
    },
  }
  apply(ctx, { scopesFile, enforce: true })
  assert.doesNotThrow(() => hooks.get('fs/write-intent')({
    displayPath: join(root, 'docs', 'probe.md'),
    targetKey: join(root, 'docs', 'probe.md'),
  }, { agent }))
  assert.throws(() => hooks.get('fs/write-intent')({
    displayPath: join(root, 'src', 'probe.rs'),
    targetKey: join(root, 'src', 'probe.rs'),
  }, { agent }), (error) => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
})

test('run_code rejects direct filesystem access but allows controlled child dispatch', async () => {
  const h = harness()
  const pre = h.hook('tools/pre-execute')
  assert.equal(runCodeWriteRisk("import { writeFileSync } from 'node:fs'").opaque, false)
  assert.equal(runCodeWriteRisk("import { writeFileSync } from 'node:fs'; writeFileSync('D:/outside.md', 'x')").opaque, true)
  assert.equal(runCodeWriteRisk("await tools.team_v12({ action: 'requirements_snapshot' })").opaque, false)
  assert.equal(runCodeWriteRisk("await tools.bash({ command: 'git status --short' })").opaque, false)
  assert.equal(runCodeWriteRisk("await tools.write({ path: 'docs/a.md', content: 'x' })").opaque, false)
  assert.equal(runCodeWriteRisk("await tools.edit({ path: 'docs/a.md', old: 'a', new: 'b' })").opaque, false)
  await assert.rejects(() => pre({
    tool: { name: 'run_code' },
    arguments: { code: "import { writeFileSync } from 'node:fs'; writeFileSync('D:/outside.md', 'x')" },
    agent: h.agent,
  }, async () => ({ kind: 'allow' })), /run_code denied/)
  const nestedBash = await pre({
    tool: { name: 'run_code' },
    arguments: { code: "await tools.bash({ command: 'Set-Content D:/outside.md x' })" },
    agent: h.agent,
  }, async () => ({ kind: 'allow' }))
  assert.equal(nestedBash.kind, 'allow')
  await assert.rejects(() => pre({
    tool: { name: 'bash' },
    arguments: { command: 'Set-Content D:/outside.md x' },
    agent: h.agent,
  }, async () => ({ kind: 'allow' })), (error) => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
  const allowedChild = await pre({
    tool: { name: 'bash' },
    arguments: { command: 'Set-Content docs/a.md x' },
    agent: h.agent,
  }, async () => ({ kind: 'allow' }))
  assert.equal(allowedChild.kind, 'allow')
  await assert.rejects(() => pre({
    tool: { name: 'run_code' },
    arguments: { code: "await tools.run_code({ code: 'return 1' })" },
    agent: h.agent,
  }, async () => ({ kind: 'allow' })), /run_code denied/)
  const allowed = await pre({
    tool: { name: 'run_code' },
    arguments: { code: "return await tools.team_v12({ action: 'requirements_snapshot' })" },
    agent: h.agent,
  }, async () => ({ kind: 'allow' }))
  assert.equal(allowed.kind, 'allow')
})

test('D-新-3 verifier scratch is writable without granting product write access', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v14-verifier-scratch-'))
  tempDirs.push(root)
  const scopesFile = join(root, 'scopes.json')
  const scratch = join(root, 'verifier-scratch')
  writeFileSync(scopesFile, JSON.stringify({
    rootDir: root,
    defaultDeny: true,
    byName: {},
  }))
  const hooks = new Map()
  const member = { name: 'verifier', tier: 2, role: 'teammate', group: 'verifier' }
  const agent = { id: 'verifier', name: 'verifier', session: { id: 'verifier-session', header: { cwd: root } } }
  const ctx = {
    agentTeams: { tryMembership: () => member },
    logger: { warn: () => {} },
    on: (event, callback) => {
      hooks.set(event, callback)
      return () => {}
    },
  }
  apply(ctx, { scopesFile, enforce: true, verifierScratchRoot: scratch })
  const writeIntent = hooks.get('fs/write-intent')
  assert.doesNotThrow(() => writeIntent({
    displayPath: join(scratch, 't55', 'probe.txt'),
    targetKey: join(scratch, 't55', 'probe.txt'),
  }, { agent }))
  assert.throws(() => writeIntent({
    displayPath: join(root, 'src', 'main.rs'),
    targetKey: join(root, 'src', 'main.rs'),
  }, { agent }), (error) => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
})
