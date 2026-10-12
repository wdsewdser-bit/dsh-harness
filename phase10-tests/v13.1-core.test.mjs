import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReceiptEvidenceRecord,
  routeAllowed,
} from '../home/profiles/web/plugins/evidence-reducer.mjs'
import {
  createCompactionState,
  recordCompactionDecision,
} from '../home/profiles/web/plugins/team-v12-compaction.mjs'
import {
  createTelemetry,
  dormantVerdict,
  normalizeTelemetryState,
} from '../home/profiles/web/plugins/team-v13-mechanism-telemetry.mjs'
import {
  parseObservationSource,
  renderObservationSource,
} from '../home/profiles/web/plugins/team-v13-observation-source.mjs'
import {
  createObservation,
  projectMessages,
  verifyArchive,
} from '../home/profiles/web/plugins/observation-pack-v2.mjs'
import {
  clearAction,
  readFailureMemory,
  recordFailure,
  shouldBlockAction,
} from '../home/profiles/web/plugins/team-v13-failure-memory.mjs'
import { detectCacheAnomalies } from '../home/profiles/web/plugins/team-v13-cache-monitor.mjs'
import { validateCompactionAnchors } from '../home/profiles/web/plugins/team-v13-compaction-anchors.mjs'
import { createEvidenceRegistry, registerEvidence } from '../home/profiles/web/plugins/team-v12-evidence-scheduler.mjs'

test('reducer route safety applies to session and explicit routes', () => {
  assert.equal(routeAllowed({ provider: 'local-a' }, { localProviders: ['local-a'], remoteAllowed: false }), true)
  assert.equal(routeAllowed({ provider: 'remote-a' }, { localProviders: ['local-a'], remoteAllowed: false }), false)
  assert.equal(routeAllowed({ provider: 'remote-a' }, { localProviders: [], remoteAllowed: true }), true)
  assert.equal(routeAllowed(undefined, { remoteAllowed: true }), false)
})

test('verified reducer receipts bind archive, model and fixture into v12 evidence', () => {
  const record = buildReceiptEvidenceRecord(
    {
      name: 'bash',
      arguments: {
        task_id: 't-1',
        commit_sha: 'abc123',
        fixture_version: 'fixture-7',
      },
    },
    { quotes: [{ line: 2 }, { line: 9 }] },
    {
      id: 'evr_x',
      filePath: 'D:/archive/x.txt',
      sha256: 'deadbeef',
      bytes: 42,
      lines: 10,
    },
    { provider: 'local', model: 'm' },
  )
  const registry = createEvidenceRegistry([])
  registerEvidence(registry, record)
  const stored = Object.values(registry.records)[0]
  assert.equal(stored.status, 'passed')
  assert.equal(stored.commitSha, 'abc123')
  assert.equal(stored.fixtureVersion, 'fixture-7')
  assert.equal(stored.provider, 'local')
  assert.deepEqual(stored.lineNumbers, [2, 9])
})

test('telemetry accumulates consecutive sessions without a firing event', () => {
  const root = mkdtempSync(join(tmpdir(), 'v131-telemetry-'))
  try {
    const telemetry = createTelemetry('fixture', { dir: root, enabled: true, bufferSkips: 1 })
    telemetry.event('fired', { sessionId: 's1' }, { savedTokens: 50 })
    telemetry.skipped('no-rule-match', { sessionId: 's2' })
    telemetry.skipped('no-rule-match', { sessionId: 's3' })
    telemetry.skipped('no-rule-match', { sessionId: 's4' })
    const state = telemetry.snapshot()
    assert.equal(state.fired, 1)
    assert.equal(state.dormantSessions, 2)
    assert.equal(dormantVerdict(state, { threshold: 2 }), true)
    assert.equal(state.metrics.savedTokens, 50)
    assert.equal(state.sessions.s1.fired, true)
    assert.equal(state.sessions.s4.fired, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('telemetry migration backfills fired counts from historical kind histograms', () => {
  const state = normalizeTelemetryState({
    version: 1,
    name: 'cache-prefix',
    enabled: true,
    events: 3,
    fired: 0,
    kinds: { 'cache-hit-drop': 2, skipped: 1 },
    lastEventAt: '2026-09-25T07:36:46.348Z',
    lastEvent: { kind: 'cache-hit-drop' },
  }, 'cache-prefix')
  assert.equal(state.fired, 2)
  assert.equal(state.lastFiredAt, '2026-09-25T07:36:46.348Z')
  assert.equal(dormantVerdict(state), false)
})

test('compaction decisions are mirrored with economic reason and debt', () => {
  const state = createCompactionState()
  const result = recordCompactionDecision(state, {
    owner: 'lead',
    sessionId: 'session-1',
    decision: 'defer',
    reason: 'deferred_growth',
    contextTokens: 123456,
    applied: false,
    carriedDebtTokens: 700,
  })
  assert.equal(result.job.trigger, 'economic')
  assert.equal(result.job.decision, 'defer')
  assert.equal(result.job.reason, 'deferred_growth')
  assert.equal(result.job.carriedDebtTokens, 700)
})

test('shared observation metadata identifies reducer and pack processors', () => {
  const text = renderObservationSource({
    processor: 'observation-pack',
    result: 'archived-handle',
    sha256: 'abc',
    archiveId: 'obs_1',
    bytes: 12,
  })
  const parsed = parseObservationSource(text)
  assert.equal(parsed.processor, 'observation-pack')
  assert.equal(parsed.archiveId, 'obs_1')
})

test('ObservationPack produces measured savings and verifies its archive', () => {
  const root = mkdtempSync(join(tmpdir(), 'v131-observation-'))
  try {
    const text = Array.from({ length: 2000 }, (_, index) => 'line ' + String(index)).join('\n')
    const observation = createObservation({
      toolName: 'bash',
      callId: 'call-1',
      blocks: [{ type: 'text', text }],
      spillDir: root,
      previewBytes: 256,
      evidenceChars: 128,
    })
    assert.ok(observation)
    assert.equal(verifyArchive(observation), true)
    observation.fullSends = 0
    const projected = projectMessages([{
      role: 'toolResult',
      toolCallId: 'call-1',
      content: [{ type: 'text', text }],
    }], new Map([['call-1', observation]]))
    assert.equal(projected.changed, 1)
    assert.ok(projected.savedTokens > 0)
    assert.match(projected.messages[0].content[0].text, /sol_pi_observation_source_v1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('failure memory blocks only the same action plus failure fingerprint', () => {
  const root = mkdtempSync(join(tmpdir(), 'v131-failure-'))
  try {
    const file = join(root, 'failures.json')
    const exec = { name: 'bash', arguments: { command: 'node test.mjs' } }
    const error = { isError: true, code: 1, content: [{ type: 'text', text: 'Error: same failure\n at test.mjs:1' }] }
    for (let index = 0; index < 3; index += 1) recordFailure(exec, error, { file, now: index + 1 })
    assert.equal(shouldBlockAction(exec, { file, threshold: 3, now: 3 }), true)
    assert.equal(shouldBlockAction({ name: 'bash', arguments: { command: 'node test.mjs --changed' } }, { file, threshold: 3, now: 3 }), false)
    clearAction(exec, { file, now: 3, reason: 'fixture reset', evidence: 'test failure was intentionally recorded', operator: 'phase10-test' })
    assert.equal(shouldBlockAction(exec, { file, threshold: 3, now: 3 }), false)
    assert.deepEqual(readFailureMemory(file).actions, {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cache monitor binds a hit-rate drop to an exact same-request handoff receipt', () => {
  const requests = [
    { seq: 1, time: '2026-09-25T00:00:00.000Z', inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 },
    { seq: 2, requestId: 'request-2', sessionId: 'session-1', time: '2026-09-25T00:00:01.000Z', inputTokens: 600, cacheReadTokens: 400, cacheWriteTokens: 0 },
  ]
  const receipt = { requestId: 'request-2', sessionId: 'session-1', handedToAdapter: true,
    handedAt: '2026-09-25T00:00:00.500Z', firstChangedMessageIndex: 4, commonPrefixBytes: 1024,
    transforms: [{ id: 'observation-pack', status: 'applied' }, { id: 'ptc-sdk-retention', status: 'unchanged' }] }
  const same = { requestId: 'request-2', sessionId: 'session-1', requestProjection: receipt }
  const unrelated = { name: 'future-other-session', requestId: 'other-request', sessionId: 'other-session',
    lastEventAt: '2099-01-01T00:00:00.000Z', lastEvent: { kind: 'replaced' } }
  const anomalies = detectCacheAnomalies(requests, [unrelated, same], { dropThreshold: 0.2 })
  assert.equal(anomalies.length, 1)
  assert.equal(anomalies[0].mechanism, 'observation-pack')
  assert.equal(anomalies[0].requestId, 'request-2')
  assert.equal(anomalies[0].previousCacheReadShare, 0.9)
  assert.equal(anomalies[0].cacheReadShare, 0.4)
  assert.equal(anomalies[0].drop, 0.5)
  assert.equal(anomalies[0].mechanismKind, 'same-request-projection-receipt')
  assert.equal(anomalies[0].projection.firstChangedMessageIndex, 4)
  assert.equal(anomalies[0].projection.commonPrefixBytes, 1024)
  assert.match(anomalies[0].prefixChurnSummary, /causality unproven/)
  assert.equal(detectCacheAnomalies(requests, [unrelated], { dropThreshold: 0.2 })[0].attribution, 'unknown')
  for (const changed of [
    { ...same, sessionId: 'other-session' },
    { ...same, requestId: 'other-request' },
    { ...same, requestProjection: { ...receipt, sessionId: 'other-session' } },
    { ...same, requestProjection: { ...receipt, handedToAdapter: false } },
    { ...same, requestProjection: { ...receipt, handedAt: '2099-01-01T00:00:00.000Z' } },
  ]) assert.equal(detectCacheAnomalies(requests, [changed], { dropThreshold: 0.2 })[0].attribution, 'unknown')
  const unchanged = { ...same, requestProjection: { ...receipt, transforms: [{ id: 'observation-pack', status: 'unchanged' }] } }
  const unchangedAnomaly = detectCacheAnomalies(requests, [unchanged], { dropThreshold: 0.2 })[0]
  assert.equal(unchangedAnomaly.mechanism, null)
  assert.equal(unchangedAnomaly.mechanismKind, 'same-request-projection-receipt')
  assert.equal(detectCacheAnomalies(requests, [same], { dropThreshold: 0.6 }).length, 0)
})

test('compaction anchors do not require concatenated milestone text', () => {
  const valid = validateCompactionAnchors('task t-1 owner lead stage build-room decisions [] cursors [] blockers []', {
    taskContract: 't-1',
    ownerScope: 'lead',
    milestoneNext: 'build-room',
    roomDecisions: [],
    cursor: {},
    blockers: [],
  })
  assert.equal(valid.ok, true)
  const missing = validateCompactionAnchors('task t-1 owner lead', {
    taskContract: 't-1',
    ownerScope: 'lead',
    milestoneNext: 'build-room',
    roomDecisions: [],
    cursor: {},
    blockers: [],
  })
  assert.deepEqual(missing.missing, ['milestoneNext'])
})
