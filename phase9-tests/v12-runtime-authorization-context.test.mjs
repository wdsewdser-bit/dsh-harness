import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const externalStubs = new Map([
  ['@deepseek-ai/dsh-tools', 'export const defineTool = (definition) => definition\n'],
  ['@deepseek-ai/dsh-llm', 'export const createUserMessage = (message) => message\n'],
])
registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = externalStubs.get(specifier)
    if (source !== undefined) {
      return {
        url: 'data:text/javascript,' + encodeURIComponent(source),
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

const runtime = await import('../home/profiles/web/plugins/team-v12-runtime.mjs')
const {
  apply: applyRuntime,
  authorizeCompactionTransition,
  authorizeInboxAck,
  authorizeRoomCursor,
  authorizeTaskContractSet,
  compactRuntimeFacts,
  contextPackAlreadyPresent,
  diskObservation,
  inject: runtimeInject,
  roomCursorIdsFromContextItems,
  runtimeObservation,
} = runtime
import {
  buildContextPack,
  contentHash,
  renderContextPack,
} from '../home/profiles/web/plugins/team-v12-context.mjs'
import { collectRuntimeFacts } from '../home/profiles/web/plugins/team-v12-runtime-facts.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('v12 runtime injects loader and registers a valid tool output envelope', () => {
  assert.equal(runtimeInject.includes('loader'), true)

  let registeredTool = null
  const noop = () => {}
  const agent = {
    ctx: {
      systemPrompt: {
        getSectionOrder: () => 0,
        section: () => noop,
      },
      tools: {
        register: (definition) => {
          registeredTool = definition
          return noop
        },
      },
      on: () => noop,
      effect: () => noop,
    },
  }
  const ctx = {
    agents: { list: () => [agent] },
    agentTeams: { tryMembership: () => ({ name: 'lead', tier: 0 }) },
    on: () => noop,
    effect: () => noop,
    logger: { warn: noop },
  }

  applyRuntime(ctx, {
    controlDir: join(tmpdir(), 'dsh-v12-runtime-test-control'),
    pluginDir: join(tmpdir(), 'dsh-v12-runtime-test-plugins'),
    profile: 'web-test',
  })

  assert.equal(registeredTool?.name, 'team_v12')
  assert.equal(typeof registeredTool?.output?.schema, 'object')
  assert.equal(typeof registeredTool?.output?.render, 'function')
  assert.equal(registeredTool?.output?.type, undefined)
})

test('team_v12 defaults to runtime facts and populates capability and disk control status', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v12-runtime-defaults-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const controlDir = join(root, 'control')
  const pluginDir = join(root, 'plugins')
  const noop = () => {}
  const agent = {
    ctx: {
      systemPrompt: {
        getSectionOrder: () => 0,
        section: () => noop,
      },
      tools: {
        register: (definition) => {
          registeredTool = definition
          return noop
        },
      },
      on: () => noop,
      effect: () => noop,
    },
  }
  let registeredTool = null
  const ctx = {
    agents: { list: () => [agent] },
    agentTeams: { tryMembership: () => ({ id: 'root-test', name: 'lead', tier: 0 }) },
    loader: { entries: () => [] },
    on: () => noop,
    effect: () => noop,
    logger: { warn: noop },
  }
  applyRuntime(ctx, { controlDir, pluginDir, profile: 'web-test' })

  const compact = await registeredTool.execute({}, {})
  assert.equal(compact.kind, 'dsh.runtime-facts')
  assert.equal(compact.dsh.profile, 'web-test')

  const matrix = await registeredTool.execute({ action: 'capability_matrix' }, {})
  assert.equal(matrix.profiles['web-test'].id, 'web-test')
  assert.equal(matrix.rows.some((row) => row.capability === 'runtime.facts'), true)
  assert.equal(matrix.rows.some((row) => row.capability === 'control.persistence.status'), true)

  mkdirSync(controlDir, { recursive: true })
  writeFileSync(join(controlDir, 'root-test.json'), JSON.stringify({
    version: 2,
    schemaVersion: 2,
    rootId: 'root-test',
    revision: 7,
    updatedAt: Date.now(),
    rooms: {},
    rounds: {},
    plans: {},
    dispatches: {},
    leases: {},
    wakeEpisodes: {},
    escalations: {},
    privilegeRequests: {},
    evidence: {},
    packets: {},
    boards: {},
    provider: {},
    providerFailures: {},
    frozenMembers: {},
    counters: {},
    health: {},
  }))

  const status = await registeredTool.execute({ action: 'control_status' }, {})
  assert.equal(status.source, 'disk')
  assert.equal(status.read.ok, true)
  assert.equal(status.revision, 7)

  await assert.rejects(
    registeredTool.execute({ action: 'inbox_ack', input: { all: true } }, {}),
    /bulk-ack-unsupported/,
  )
  await assert.rejects(
    registeredTool.execute({ action: 'inbox_ack' }, {}),
    /wake-id-required/,
  )
  await assert.rejects(
    registeredTool.execute({ action: 'inbox_ack', wake_id: 'wake:missing' }, {}),
    /wake-not-found: wake:missing; available wake ids: none/,
  )
})

test('runtime facts default output stays compact while full reports remain available', () => {
  const report = {
    schemaVersion: 1,
    kind: 'runtime-facts',
    collectedAt: '2026-09-24T00:00:00.000Z',
    instance: { pid: 1 },
    dsh: { profile: 'web' },
    collection: { complete: true },
    plugins: {
      'team-v12-runtime': {
        runtime: { enabled: true, entry: { path: 'runtime.mjs', sha256: 'runtime-hash' } },
        disk: { enabled: true, entry: { path: 'disk.mjs', sha256: 'disk-hash' } },
        runtimeConfig: { apiToken: 'must-not-leak' },
      },
      'other-plugin': {
        runtime: { enabled: true, entry: { path: 'other.mjs', sha256: 'other-hash' } },
      },
    },
    differences: [{
      pluginId: 'team-v12-runtime',
      code: 'runtime-disk-hash-mismatch',
      severity: 'warning',
      message: 'hash mismatch',
    }],
    diffSummary: { total: 1, errors: 0, warnings: 1 },
  }

  const compact = compactRuntimeFacts(report, ['team-v12-runtime'])
  assert.equal(compact.totalPlugins, 2)
  assert.deepEqual(Object.keys(compact.plugins), ['team-v12-runtime'])
  assert.equal(compact.plugins['team-v12-runtime'].runtimeEntry.sha256, 'runtime-hash')
  assert.deepEqual(compact.plugins['team-v12-runtime'].differences, [{
    code: 'runtime-disk-hash-mismatch',
    severity: 'warning',
  }])
  assert.equal(JSON.stringify(compact).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(report).includes('must-not-leak'), true)
})

test('loader and disk observations resolve to real entry hashes', (t) => {
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-v12-runtime-observation-'))
  t.after(() => rmSync(pluginDir, { recursive: true, force: true }))
  const entry = join(pluginDir, 'team-v12-runtime.mjs')
  writeFileSync(entry, 'export const observed = true\n')

  const runtime = runtimeObservation({
    loader: {
      entries: () => [{
        options: { id: 'team-v12-runtime', name: './team-v12-runtime.mjs' },
        fiber: { state: 2 },
      }],
    },
  }, pluginDir)
  const disk = diskObservation(pluginDir)
  const report = collectRuntimeFacts({
    observedAt: '2026-09-24T00:00:00.000Z',
    dsh: { profile: 'web-test' },
    runtime,
    disk,
    baseDir: pluginDir,
  })

  const observed = report.plugins['team-v12-runtime']
  assert.equal(observed.runtime.entry.exists, true)
  assert.equal(observed.runtime.entry.sha256, observed.disk.entry.sha256)
  assert.equal(observed.runtime.enabled, true)
  assert.equal(report.collection.readOnly, true)
})

test('v12 runtime authorization fails closed for task, Room, inbox and compaction mutations', () => {
  const task = { ownerName: 'member-a', contract: { owner: 'member-a' } }
  assert.equal(authorizeTaskContractSet({
    tier: 1,
    memberName: 'member-a',
    task,
  }).ok, true)
  assert.equal(authorizeTaskContractSet({
    tier: 1,
    memberName: 'member-b',
    task,
  }).code, 'task-contract-scope')
  assert.equal(authorizeTaskContractSet({
    tier: 1,
    memberName: 'member-a',
    task,
    activeLease: { member: 'member-b', status: 'active' },
  }).code, 'task-contract-lease')
  assert.equal(authorizeTaskContractSet({
    tier: 0,
    memberName: 'root',
    task,
    activeLease: { member: 'member-b', status: 'active' },
  }).ok, true)

  assert.equal(authorizeRoomCursor({
    tier: 1,
    memberName: 'member-a',
    targetMember: 'member-a',
  }).ok, true)
  assert.equal(authorizeRoomCursor({
    tier: 1,
    memberName: 'member-a',
    targetMember: 'member-b',
  }).code, 'room-cursor-scope')
  assert.equal(authorizeRoomCursor({
    tier: 0,
    memberName: 'root',
    targetMember: 'member-b',
  }).ok, true)

  assert.equal(authorizeInboxAck({
    tier: 1,
    memberName: 'member-a',
    wake: { target: 'member-a' },
  }).ok, true)
  assert.equal(authorizeInboxAck({
    tier: 1,
    memberName: 'member-a',
    wake: { target: 'member-b' },
  }).code, 'inbox-ack-scope')
  assert.equal(authorizeInboxAck({
    tier: 0,
    memberName: 'root',
    wake: { target: 'member-b' },
  }).ok, true)

  assert.equal(authorizeCompactionTransition({
    tier: 1,
    memberName: 'member-a',
    milestone: { owner: 'member-a' },
  }).ok, true)
  assert.equal(authorizeCompactionTransition({
    tier: 1,
    memberName: 'member-b',
    milestone: { owner: 'member-a' },
  }).code, 'compaction-scope')
  assert.equal(authorizeCompactionTransition({
    tier: 1,
    memberName: 'member-a',
    requestedOwner: 'member-a',
  }).ok, true)
  assert.equal(authorizeCompactionTransition({
    tier: 1,
    memberName: 'member-a',
    requestedOwner: 'member-b',
  }).code, 'compaction-scope')
  assert.equal(authorizeCompactionTransition({
    tier: 1,
    memberName: 'member-a',
  }).code, 'compaction-scope')
  assert.equal(authorizeCompactionTransition({
    tier: 0,
    memberName: 'root',
  }).ok, true)
})

test('Room context cursors advance only messages included in the rendered pack', () => {
  const first = buildContextPack({
    target: { memberId: 'member-a', teamId: 'team-1' },
    sources: [{
      sourceId: 'room:group:g-core:m1',
      revision: 1,
      content: 'first message',
      teamId: 'team-1',
      retentionClass: 'message',
    }],
  })
  const firstRendered = renderContextPack(first)
  const firstDigest = contentHash(firstRendered)
  assert.equal(roomCursorIdsFromContextItems(first.items).get('group:g-core')?.join(','), 'm1')
  assert.equal(contextPackAlreadyPresent({
    rendered: firstRendered,
    digest: firstDigest,
    messages: [{ content: [{ type: 'text', text: '[team v12 context pack] digest=' + firstDigest }] }],
  }), true)

  const second = buildContextPack({
    target: { memberId: 'member-a', teamId: 'team-1' },
    sources: [
      {
        sourceId: 'room:group:g-core:m1',
        revision: 1,
        content: 'first message',
        teamId: 'team-1',
        retentionClass: 'message',
      },
      {
        sourceId: 'room:group:g-core:m2',
        revision: 1,
        content: 'second message',
        teamId: 'team-1',
        retentionClass: 'message',
      },
    ],
  })
  const secondRendered = renderContextPack(second)
  const secondDigest = contentHash(secondRendered)
  assert.notEqual(secondDigest, firstDigest)
  assert.deepEqual(
    roomCursorIdsFromContextItems(second.items).get('group:g-core'),
    ['m1', 'm2'],
  )
  assert.equal(contextPackAlreadyPresent({
    rendered: secondRendered,
    digest: secondDigest,
    messages: [{ content: [{ type: 'text', text: '[team v12 context pack] digest=' + firstDigest }] }],
  }), false)
})
