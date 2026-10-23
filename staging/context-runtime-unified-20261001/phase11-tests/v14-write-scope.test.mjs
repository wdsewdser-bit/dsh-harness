import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, isVerifierScratchPath, runCodeWriteRisk } from '../home/profiles/web/plugins/write-scope-guard.mjs'
import { TeamRoster } from '../home/profiles/web/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/types/roster.js'

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

function nativeVerifierHarness(rows, membership, useAgentContext = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-verifier-scratch-'))
  tempDirs.push(root)
  const scopesFile = join(root, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({ rootDir: root, defaultDeny: true, byName: {} }))
  const hooks = new Map()
  const agent = { id: 'native-v1', session: { id: 'native-v1', header: { cwd: root } } }
  const service = {
    tryMembership: current => current === agent ? membership : undefined,
    listMembers: current => {
      assert.equal(current, agent)
      return typeof rows === 'function' ? rows() : rows
    },
  }
  const ctx = {
    logger: { warn: () => {} },
    on: (event, callback) => { hooks.set(event, callback); return () => {} },
    ...(useAgentContext ? {} : { agentTeams: service }),
  }
  if (useAgentContext) agent.ctx = { agentTeams: service }
  const scratch = join(root, 'verifier-scratch')
  apply(ctx, { scopesFile, enforce: true, verifierScratchRoot: scratch })
  const intent = (event, path) => hooks.get(event)({ displayPath: path, targetKey: path }, { agent })
  return { root, scratch, agent, hooks, intent }
}

const nativeMembership = { id: 'native-team', name: 'v1', role: 'teammate' }
const nativeVerifierRow = { id: 'native-v1', name: 'v1', level: 1, groupId: 'verifier', parentName: 'lead' }

test('D-新-3 native membership uses the exact durable roster group for write, edit and shell', async () => {
  const h = nativeVerifierHarness([nativeVerifierRow], nativeMembership)
  const path = join(h.scratch, 't55', 'probe.txt')
  for (const event of ['fs/write-intent', 'fs/edit-intent']) {
    assert.doesNotThrow(() => h.intent(event, path))
    assert.throws(() => h.intent(event, join(h.root, 'product.txt')), error => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
    assert.throws(() => h.intent(event, join(h.root, 'verifier-scratch-evil', 'probe.txt')), error => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
  }
  const result = await h.hooks.get('tools/pre-execute')({
    tool: { name: 'bash' }, arguments: { command: `Set-Content '${path}' x` }, agent: h.agent,
  }, async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'allow')
})

test('D-新-3 scratch refuses non-verifiers and mismatched roster identities', () => {
  for (const row of [
    { ...nativeVerifierRow, groupId: 'rig' },
    { ...nativeVerifierRow, id: 'other-team-v1' },
    { ...nativeVerifierRow, name: 'other-member' },
    { ...nativeVerifierRow, groupId: undefined },
  ]) {
    const h = nativeVerifierHarness([row], nativeMembership)
    assert.throws(() => h.intent('fs/write-intent', join(h.scratch, 'probe.txt')), error => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
  }
})

test('D-新-3 scratch stays denied without native membership or a readable roster', () => {
  for (const [rows, membership] of [
    [[nativeVerifierRow], undefined],
    [[], nativeMembership],
    [() => { throw new Error('roster unavailable') }, nativeMembership],
  ]) {
    const h = nativeVerifierHarness(rows, membership)
    assert.throws(() => h.intent('fs/write-intent', join(h.scratch, 'probe.txt')), error => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
  }
})

test('D-新-3 scratch resolves the agent-local native service when host context is unavailable', () => {
  const h = nativeVerifierHarness([nativeVerifierRow], nativeMembership, true)
  assert.doesNotThrow(() => h.intent('fs/write-intent', join(h.scratch, 'probe.txt')))
})

test('D-新-3 actual native roster exposes group only in its exact member row', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-actual-roster-scratch-'))
  tempDirs.push(root)
  const scopesFile = join(root, 'scopes.json')
  writeFileSync(scopesFile, JSON.stringify({ rootDir: root, defaultDeny: true, byName: {} }))
  const lead = { id: 'native-root', options: {}, session: { header: {}, snapshotEvents: () => [] } }
  const verifier = { id: 'native-child', options: {}, session: { header: { parentSession: lead.id } } }
  const live = new Map([[lead.id, lead], [verifier.id, verifier]])
  const row = { id: verifier.id, name: 'v1', phase: 'active', level: 1, groupId: 'verifier', parentName: 'lead' }
  const roster = new TeamRoster({ agents: { get: id => live.get(id) } }, {
    state: current => { assert.equal(current, lead); return { members: [row] } },
  }, {}, 2)
  const membership = roster.tryMembership(verifier)
  assert.equal(membership.name, 'v1')
  assert.equal(membership.group, undefined)
  assert.equal(isVerifierScratchPath(join(root, 'verifier-scratch', 'probe.txt'), membership, {},
    join(root, 'verifier-scratch')), false, 'the previous guard expression denies this native verifier')
  assert.equal(roster.list(membership).find(member => member.id === verifier.id).groupId, 'verifier')
  const hooks = new Map()
  apply({
    agentTeams: {
      tryMembership: agent => roster.tryMembership(agent),
      listMembers: agent => roster.list(roster.membership(agent)),
    },
    on: (event, callback) => { hooks.set(event, callback); return () => {} },
    logger: { warn: () => {} },
  }, { scopesFile, enforce: true, verifierScratchRoot: join(root, 'verifier-scratch') })
  const target = { targetKey: join(root, 'verifier-scratch', 'probe.txt') }
  assert.doesNotThrow(() => hooks.get('fs/write-intent')(target, { agent: verifier }))
  assert.throws(() => hooks.get('fs/write-intent')({ targetKey: join(root, 'product.txt') }, { agent: verifier }),
    error => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
  assert.throws(() => hooks.get('fs/write-intent')(target, { agent: { ...verifier } }),
    error => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
  row.groupId = 'rig'
  assert.throws(() => hooks.get('fs/write-intent')(target, { agent: verifier }),
    error => error?.code === 'FS_WRITE_OUT_OF_SCOPE')
})
