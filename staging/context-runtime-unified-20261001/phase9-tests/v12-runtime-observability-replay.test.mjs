import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildCapabilityMatrix,
  buildRuntimeFacts,
  collectRuntimeFacts,
  diffCapabilityMatrices,
  evaluateUpgradeGate,
  hashEntry,
  redactSecrets,
} from '../home/profiles/web/plugins/team-v12-runtime-facts.mjs'
import {
  createObservationEvent,
  createTraceContext,
  locateObservationBreakpoint,
  propagateTraceContext,
  queryTimeline,
  summarizeTimeline,
} from '../home/profiles/web/plugins/team-v12-observability.mjs'
import {
  createFakeDispatcher,
  createFakeProvider,
  createFakeTool,
  createSimulatedClock,
  normalizeReplayFixture,
  runRegressionPair,
  runReplay,
} from '../home/profiles/web/plugins/team-v12-replay.mjs'

test('runtime facts hash the canonical entry and redact secret config', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-v12-facts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const entry = join(root, 'team-v12-runtime-facts.mjs')
  const content = 'export const observed = true\n'
  writeFileSync(entry, content)
  const expectedHash = createHash('sha256').update(content).digest('hex')

  const hashed = hashEntry(entry)
  assert.equal(hashed.exists, true)
  assert.equal(hashed.path, realpathSync.native(entry))
  assert.equal(hashed.sha256, expectedHash)

  const plugin = {
    id: 'team-v12',
    version: '2.0.0',
    entry,
    enabled: true,
    installed: true,
    source: 'local',
    patch: 'patch-v12',
    configSource: 'profiles/web/team.json',
    stateOwner: 'local-control-plane',
    schemaVersion: 12,
    config: { apiToken: 'top-secret-token-value', mode: 'read-only' },
  }
  const report = collectRuntimeFacts({
    observedAt: '2026-09-24T00:00:00.000Z',
    instance: { id: 'pid-1', pid: 1 },
    dsh: { version: '0.1.6', profile: 'web' },
    documented: { complete: true, plugins: [{ ...plugin, version: '1.0.0' }] },
    disk: { complete: true, plugins: [plugin] },
    runtime: { complete: true, plugins: [{ ...plugin, version: '2.0.0' }] },
    session: { complete: true, plugins: [{ ...plugin, version: '2.0.0' }] },
    features: [{
      id: 'wake-delivery',
      stateOwner: 'local-control-plane',
      schemaVersion: 12,
      permissions: 'tier-checked',
      wake: 'queued-next-turn',
      recovery: 'reconcile',
    }],
  })

  assert.equal(report.plugins['team-v12'].runtime.entry.path, realpathSync.native(entry))
  assert.equal(report.plugins['team-v12'].runtime.entry.sha256, expectedHash)
  assert.equal(report.differences.some((row) => row.code === 'runtime-version-mismatch'), true)
  assert.equal(report.collection.readOnly, true)
  assert.equal(JSON.stringify(report).includes('top-secret-token-value'), false)
  assert.equal(report.plugins['team-v12'].runtime.config.apiToken, '[REDACTED]')
  assert.equal(report.redaction.applied, true)

  const incomplete = buildRuntimeFacts({
    dsh: { version: '0.1.6', profile: 'web' },
    runtime: { complete: true, plugins: [plugin] },
  })
  assert.equal(incomplete.collection.complete, false)
  assert.equal(incomplete.collection.degraded, true)
  assert.equal(incomplete.collection.reasons.some((reason) => reason.includes('session observation was not supplied')), true)
})

test('capability matrix separates declared capability from callability and blocks drift', () => {
  const baseline = buildCapabilityMatrix([
    {
      id: 'web',
      installed: true,
      enabled: true,
      pluginId: 'team-tools',
      pluginVersion: '1.0.0',
      entryHash: 'hash-web-1',
      declaredCapabilities: ['room.message', 'wake.deliver'],
      callableCapabilities: ['room.message', 'wake.deliver'],
      tools: [{ name: 'room_message', capability: 'room.message', schema: { type: 'object', required: ['roomId'] } }],
      persistenceSchemas: { 'room.message': { version: 1 } },
      semantics: { 'room.message': { cursor: 'after-injection' }, 'wake.deliver': { mode: 'queued' } },
      contractResults: { 'room.message': { passed: true }, 'wake.deliver': { passed: true } },
    },
    {
      id: 'headless',
      installed: true,
      enabled: true,
      pluginId: 'team-tools',
      pluginVersion: '1.0.0',
      entryHash: 'hash-headless-1',
      declaredCapabilities: ['room.message', 'wake.deliver'],
      callableCapabilities: ['room.message'],
      tools: [{ name: 'room_message', capability: 'room.message', schema: { type: 'object', required: ['roomId'] } }],
      persistenceSchemas: { 'room.message': { version: 1 } },
      semantics: { 'room.message': { cursor: 'after-injection' }, 'wake.deliver': { mode: 'queued' } },
      contractResults: { 'room.message': { passed: true } },
    },
  ])
  assert.equal(baseline.profiles.web.capabilities['wake.deliver'].declared, true)
  assert.equal(baseline.profiles.web.capabilities['wake.deliver'].callable, true)
  assert.equal(baseline.profiles.headless.capabilities['wake.deliver'].declared, true)
  assert.equal(baseline.profiles.headless.capabilities['wake.deliver'].callable, false)

  const candidate = buildCapabilityMatrix([
    {
      id: 'web',
      installed: true,
      enabled: true,
      pluginId: 'team-tools',
      pluginVersion: '2.0.0',
      entryHash: 'hash-web-2',
      declaredCapabilities: ['room.message', 'wake.deliver'],
      callableCapabilities: ['room.message', 'wake.deliver'],
      tools: [{ name: 'room_message', capability: 'room.message', schema: { type: 'object', required: ['roomId', 'cursor'] } }],
      persistenceSchemas: { 'room.message': { version: 2 } },
      semantics: { 'room.message': { cursor: 'after-handled' }, 'wake.deliver': { mode: 'queued' } },
      contractResults: {},
    },
  ])
  const diff = diffCapabilityMatrices(baseline, candidate)
  const roomDiff = diff.rows.find((row) => row.profile === 'web' && row.capability === 'room.message')
  assert.equal(roomDiff.drift, true)
  assert.equal(roomDiff.changes.includes('toolSchemas'), true)
  assert.equal(roomDiff.changes.includes('persistenceSchema'), true)
  assert.equal(roomDiff.changes.includes('semantics'), true)

  const gate = evaluateUpgradeGate({
    baseline,
    candidate,
    requiredCapabilities: ['room.message', 'wake.deliver'],
    contracts: { web: { 'wake.deliver': { passed: true } } },
  })
  assert.equal(gate.ok, false)
  assert.equal(gate.blockers.some((row) => row.code === 'contract-not-passed'), true)
  assert.equal(gate.blockers.some((row) => row.code === 'unverified-capability-drift'), true)
})

test('causal timeline propagates IDs and does not promote delivered to handled', () => {
  const root = createTraceContext({
    correlationId: 'corr-1',
    profile: 'web',
    revision: 7,
    plugin: { id: 'team-tools', version: '2.0.0', entryHash: 'hash-1' },
    actor: 'lead',
    tool: 'team_wake',
  })
  const requested = createObservationEvent({
    eventId: 'evt-requested',
    ...root,
    stage: 'requested',
    result: { status: 'ok' },
    retry: { attempt: 1 },
    time: { monotonic: 10 },
    links: { taskId: 'task-1', wakeId: 'wake-1', messageId: 'message-1', roomId: 'group:g:tier-2' },
  })
  const queuedContext = propagateTraceContext(requested)
  const queued = createObservationEvent({
    eventId: 'evt-queued',
    ...queuedContext,
    stage: 'queued',
    result: { status: 'accepted' },
    retry: { attempt: 1 },
    time: { monotonic: 11 },
    links: requested.links,
  })
  const delivered = createObservationEvent({
    eventId: 'evt-delivered',
    ...propagateTraceContext(queued),
    stage: 'delivered',
    result: { status: 'ok' },
    retry: { attempt: 1 },
    time: { monotonic: 12 },
    links: requested.links,
  })
  const events = [requested, queued, delivered]
  const breakpoint = locateObservationBreakpoint(events, { correlationId: 'corr-1' })
  assert.equal(breakpoint.lastSuccessfulStage, 'delivered')
  assert.equal(breakpoint.expectedNextStage, 'injected')
  assert.equal(breakpoint.confirmedStages.includes('injected'), false)
  assert.equal(breakpoint.outcome, 'pending')
  assert.equal(queued.causationId, requested.eventId)
  assert.equal(delivered.causationId, queued.eventId)
  assert.equal(delivered.revision, 7)
  assert.equal(delivered.profile, 'web')
  assert.equal(delivered.plugin.entryHash, 'hash-1')
  assert.equal(delivered.tool, 'team_wake')
  assert.deepEqual(delivered.retry, { attempt: 1, maxAttempts: null, reason: null })
  assert.equal(JSON.stringify(delivered).includes('prompt'), false)

  const before = JSON.stringify(events)
  const timeline = queryTimeline(events, { wakeId: 'wake-1' })
  assert.equal(timeline.length, 3)
  assert.equal(JSON.stringify(events), before)
  assert.equal(summarizeTimeline(events, { correlationId: 'corr-1' }).retries, 0)
})

test('replay is deterministic, isolated, and redacts fixture secrets', async () => {
  const fixture = {
    fixtureId: 'wake-minimal',
    fixtureVersion: 3,
    profile: 'web',
    plugin: { id: 'team-tools', version: '2.0.0', entryHash: 'hash-1' },
    initialState: { messages: [], delivered: 0 },
    clock: { start: 100, stepMs: 5 },
    events: [
      { type: 'provider', at: 101 },
      { type: 'tool', at: 102 },
      { type: 'dispatch', at: 103 },
    ],
    invariants: [
      { id: 'no-duplicate-messages', kind: 'unique', path: 'messages', safety: true },
    ],
    postconditions: [
      { id: 'message-count', kind: 'lengthEquals', path: 'messages', expected: 1 },
      { id: 'delivered', kind: 'equals', path: 'delivered', expected: 1 },
    ],
    secret: { apiToken: 'fixture-secret-value' },
  }
  const inputBefore = JSON.stringify(fixture)
  const reducer = async ({ state, event, provider, tool, dispatcher }) => {
    if (event.type === 'provider') {
      await provider.complete('hello', { apiToken: 'request-secret' })
    } else if (event.type === 'tool') {
      await tool.invoke('send_message', { message: 'hello' })
    } else if (event.type === 'dispatch') {
      await dispatcher.dispatch({ messageId: 'm1', content: 'hello' })
      state.messages.push({ messageId: 'm1', content: 'hello' })
      state.delivered += 1
    }
    return state
  }
  const options = {
    reducer,
    implementationId: 'replay-test-v1',
    providerResponses: [{ text: 'ok' }],
    toolHandlers: { send_message: () => ({ messageId: 'm1' }) },
  }
  const first = await runReplay(fixture, options)
  const second = await runReplay(fixture, options)
  assert.equal(first.status, 'passed')
  assert.equal(second.status, 'passed')
  assert.equal(first.runId, second.runId)
  assert.equal(first.finalStateDigest, second.finalStateDigest)
  assert.equal(first.isolation.initialStateUnchanged, true)
  assert.equal(first.isolation.liveProviderCalls, 0)
  assert.equal(first.isolation.liveDispatcherCalls, 0)
  assert.equal(first.isolation.activeSessionWrites, 0)
  assert.equal(first.isolation.fakeProviderCalls, 1)
  assert.equal(first.isolation.fakeToolCalls, 1)
  assert.equal(first.isolation.fakeDispatcherDeliveries, 1)
  assert.equal(JSON.stringify(fixture), inputBefore)
  assert.equal(JSON.stringify(first).includes('fixture-secret-value'), false)
  assert.equal(JSON.stringify(first).includes('request-secret'), false)
})

test('fix evidence requires before-fail and after-pass on the same fixture', async () => {
  const fixture = {
    fixtureId: 'cursor-fix',
    initialState: { messages: [], cursor: 0 },
    events: [{ type: 'deliver' }],
    invariants: [{ id: 'cursor-not-ahead', kind: 'lessThanOrEqual', path: 'cursor', expected: 1, safety: true }],
    postconditions: [{ id: 'message-delivered', kind: 'lengthEquals', path: 'messages', expected: 1 }],
  }
  const beforeReducer = ({ state }) => state
  const afterReducer = ({ state, event }) => {
    if (event.type === 'deliver') {
      state.messages.push({ messageId: 'm1' })
      state.cursor = 1
    }
    return state
  }
  const pair = await runRegressionPair(fixture, {
    before: { reducer: beforeReducer, implementationId: 'before' },
    after: { reducer: afterReducer, implementationId: 'after' },
  })
  assert.equal(pair.status, 'verified')
  assert.equal(pair.fixBeforeFail, true)
  assert.equal(pair.afterPass, true)
  assert.equal(pair.before.violations.some((row) => row.id === 'message-delivered'), true)
  assert.equal(pair.after.violations.length, 0)
})

test('live-only fixtures are marked uncovered and never executed locally', async () => {
  const fixture = normalizeReplayFixture({
    fixtureId: 'live-only-case',
    liveOnly: true,
    initialState: { safe: true },
    events: [{ type: 'real-provider-call' }],
    postconditions: [{ kind: 'equals', path: 'safe', expected: true }],
  })
  const result = await runReplay(fixture, {
    reducer: () => {
      throw new Error('must not run')
    },
  })
  assert.equal(result.status, 'not-run')
  assert.equal(result.covered, false)
  assert.equal(result.liveOnly, true)
  assert.equal(result.isolation.liveProviderCalls, 0)
})

test('clock, secret filter, and fake adapters are local deterministic primitives', async () => {
  const clock = createSimulatedClock(5)
  assert.equal(clock.advance(2), 7)
  assert.equal(clock.advanceTo(10), 10)
  assert.deepEqual(clock.snapshot(), { value: 10 })
  assert.deepEqual(redactSecrets({ authorization: 'Bearer abc.def.ghi', tokenBudget: 100 }), {
    authorization: '[REDACTED]',
    tokenBudget: 100,
  })
  const provider = createFakeProvider([{ text: 'one' }])
  assert.deepEqual(await provider.complete('prompt'), { text: 'one' })
  const tool = createFakeTool({ echo: ({ value }) => ({ value }) })
  assert.deepEqual(await tool.invoke('echo', { value: 1 }), { value: 1 })
  const dispatcher = createFakeDispatcher()
  assert.equal((await dispatcher.dispatch({ messageId: 'm1' })).status, 'delivered')
})
