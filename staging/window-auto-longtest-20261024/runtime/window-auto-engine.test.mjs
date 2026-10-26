import test from 'node:test'
import assert from 'node:assert/strict'
import { createWindowAutoEngine, selectWindowAction } from './window-auto-engine.mjs'
import { authorityKeys, createWindowCheckpointAuthority, windowHash } from '../../context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { createWindowProjection } from '../../context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-projection.mjs'

const now = 10000
const sha = c => c.repeat(64)
function evidence(kind = 'W2') {
  const route = { provider: 'synthetic', model: 'synthetic', protocol: 'deepseek-dsh-v1', priceVersion: 'fixture-relative-v1' }
  const e = { sessionId: 's', actorId: 'a', sourceHash: sha('a'), route, revision: 1, observedAt: now, expiresAt: now + 1000,
    live: { idle: kind === 'W2', effectsInFlight: 0, certifiedRequestBoundary: kind === 'W1', adapterValidation: kind === 'W1', requestId: 'req' },
    hardSafety: { rawGatePreserved: true, rawSafetyTokens: 100, safeLimitTokens: 1000, safeCompactionRequired: false }, candidates: [] }
  e.candidates.push({ id: 'candidate', kind, candidateHash: sha('b'),
    certification: { verified: true, sessionId: 's', actorId: 'a', route, sourceHash: e.sourceHash, candidateHash: sha('b'), certificateHash: sha('c'), expiresAt: now + 1000 },
    pricing: { known: true, kind: 'relative-estimate', unit: 'relative-cost', source: 'synthetic-fixture-only', priceVersion: route.priceVersion },
    usage: { status: 'known', source: 'synthetic-terminal', requestId: 'prior', inputTokens: 1000, cacheReadTokens: 100,
      cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 5 },
    qualityRisk: { verified: true, acceptable: true, score: 0.1, evidenceRef: 'synthetic-quality' },
    remainingTurns: { estimate: 10, uncertainty: 1, source: 'synthetic-horizon' },
    costs: Object.fromEntries(Object.entries({ checkpointCost: 2, firstColdPenalty: 2, expectedRecallCost: 2, stableOldCost: 10, stableNewCost: 6 })
      .map(([k, amount]) => [k, { amount, unit: 'relative-cost', source: 'synthetic-fixture-only' }])) })
  return e
}
const select = e => selectWindowAction(e, { sessionId: 's', now })
function host(e = evidence(), overrides = {}) {
  const audits = [], effects = []
  const adapter = { readEvidence: () => e,
    executeW1(args) { args.guard(); effects.push('W1'); return { applied: true, receiptId: 'selection' } },
    async executeW2(args) { args.guard(); effects.push('W2'); return { applied: true, receiptId: 'native-fold' } }, ...overrides }
  const engine = createWindowAutoEngine({ enabled: true, adapter, audit: row => audits.push(row), clock: () => now })
  return { engine, audits, effects, adapter, e }
}

test('positive selector computes conservative break-even and tags relative estimates', () => {
  const r = select(evidence())
  assert.equal(r.action, 'W2'); assert.equal(r.breakEvenTurns, 1.5)
  assert.equal(r.netBenefit, 30); assert.equal(r.conservativeHorizon, 9)
  assert.equal(r.estimated, true); assert.equal(r.realFeeClaim, false)
})

for (const [name, mutate] of [
  ['price missing', e => { e.candidates[0].pricing.known = false }],
  ['price wrong route version', e => { e.candidates[0].pricing.priceVersion = 'other' }],
  ['relative price pretending USD', e => { e.candidates[0].pricing.unit = 'USD' }],
  ['cache write unknown', e => { e.candidates[0].usage.cacheWriteTokens = null }],
  ['reasoning unknown', e => { delete e.candidates[0].usage.reasoningTokens }],
  ['input unknown', e => { e.candidates[0].usage.inputTokens = null }],
  ['cost unknown', e => { e.candidates[0].costs.firstColdPenalty.amount = null }],
  ['cost unit mismatch', e => { e.candidates[0].costs.firstColdPenalty.unit = 'USD' }],
  ['cost overflow', e => { e.candidates[0].costs.checkpointCost.amount = Number.MAX_VALUE; e.candidates[0].costs.firstColdPenalty.amount = Number.MAX_VALUE }],
  ['horizon unknown', e => { e.candidates[0].remainingTurns.uncertainty = null }],
  ['horizon too short', e => { e.candidates[0].remainingTurns.estimate = 1 }],
  ['quality unverified', e => { e.candidates[0].qualityRisk.verified = false }],
  ['quality evidence missing', e => { e.candidates[0].qualityRisk.evidenceRef = null }],
  ['session mismatch', e => { e.sessionId = 'other' }],
  ['actor mismatch', e => { e.candidates[0].certification.actorId = 'other' }],
  ['source mismatch', e => { e.candidates[0].certification.sourceHash = sha('d') }],
  ['candidate mismatch', e => { e.candidates[0].certification.candidateHash = sha('d') }],
  ['certificate expired', e => { e.candidates[0].certification.expiresAt = now }],
  ['evidence expired', e => { e.expiresAt = now }],
  ['evidence in future', e => { e.observedAt = now + 1 }],
  ['raw unknown', e => { e.hardSafety.rawSafetyTokens = null }],
  ['raw cap', e => { e.hardSafety.rawSafetyTokens = e.hardSafety.safeLimitTokens }],
  ['raw gate removed', e => { e.hardSafety.rawGatePreserved = false }],
  ['busy W2', e => { e.live.idle = false }],
  ['tool effect W2', e => { e.live.effectsInFlight = 1 }],
]) test(name + ' cannot authorize automatic action', () => {
  const e = evidence(); mutate(e)
  assert.equal(select(e).action, 'defer')
})

test('auto W2 dispatches trusted callback, serializes/coalesces and deduplicates', async () => {
  const { engine, effects, audits } = host()
  const a = engine.tick('s'), b = engine.tick('s')
  assert.equal(a, b)
  assert.equal((await a).outcome, 'applied'); assert.deepEqual(effects, ['W2'])
  assert.equal((await engine.tick('s')).reason, 'already-attempted')
  assert.equal(audits.filter(x => x.outcome === 'dispatch-intent').length, 1)
  await engine.dispose()
})

test('native refusal is final for this source/candidate, no retry storm', async () => {
  let calls = 0
  const { engine } = host(evidence(), { executeW2(args) { args.guard(); calls++; return { applied: false, reason: 'rule:below-floor' } } })
  assert.equal((await engine.tick('s')).outcome, 'native-refused')
  for (let n = 0; n < 10; n++) assert.equal((await engine.tick('s')).reason, 'already-attempted')
  assert.equal(calls, 1); await engine.dispose()
})

test('W1 actual running request boundary works synchronously; idle tick does not arm it', async () => {
  const { engine, effects, e } = host(evidence('W1'))
  assert.equal(e.live.idle, false)
  assert.equal((await engine.tick('s')).action, 'defer')
  assert.equal(engine.dispatchW1('s').outcome, 'applied')
  assert.equal(engine.dispatchW1('s').reason, 'already-attempted')
  e.live.requestId = 'next-request'
  assert.equal(engine.dispatchW1('s').outcome, 'applied')
  assert.deepEqual(effects, ['W1', 'W1']); await engine.dispose()
})

test('W1 request boundary absent or native adapter validation missing refuses', () => {
  for (const key of ['certifiedRequestBoundary', 'adapterValidation']) {
    const e = evidence('W1'); e.live[key] = false
    assert.equal(select(e).action, 'defer')
  }
})

test('revalidation notices source/route/quality changes immediately after dispatch-intent audit', async () => {
  for (const mutate of [e => { e.sourceHash = sha('e') }, e => { e.route.model = 'changed' }, e => { e.candidates[0].qualityRisk.score++ }]) {
    const e = evidence(); let effects = 0
    const engine = createWindowAutoEngine({ enabled: true, clock: () => now,
      adapter: { readEvidence: () => e, executeW2() { effects++; return { applied: true } } },
      audit: row => { if (row.outcome === 'dispatch-intent') mutate(e) } })
    assert.equal((await engine.tick('s')).reason, 'WINDOW_AUTO_STALE_EVIDENCE')
    assert.equal(effects, 0); await engine.dispose()
  }
})

test('host guard after asynchronous preparation rejects a newly busy session', async () => {
  const e = evidence(); let effects = 0
  const { engine } = host(e, { async executeW2(args) {
    await Promise.resolve(); e.live.idle = false; args.guard(); effects++; return { applied: true }
  } })
  assert.equal((await engine.tick('s')).reason, 'WINDOW_AUTO_STALE_EVIDENCE')
  assert.equal(effects, 0); await engine.dispose()
})

test('disposal aborts a callback before its delayed side effect', async () => {
  let started, release, effects = 0
  const start = new Promise(r => { started = r }), pause = new Promise(r => { release = r })
  const { engine } = host(evidence(), { async executeW2(args) {
    started(); await pause; assert.equal(args.signal.aborted, true); args.guard(); effects++; return { applied: true }
  } })
  const pending = engine.tick('s'); await start
  const disposing = engine.dispose(); release()
  assert.equal((await pending).reason, 'WINDOW_AUTO_DISPOSED_OR_EXPIRED')
  await disposing; assert.equal(effects, 0)
  assert.equal((await engine.tick('s')).reason, 'disposed')
})

test('late retained guards expire and adapter methods cannot be replaced', async () => {
  let retained
  const { engine, adapter } = host(evidence(), { executeW2(args) { retained = args.guard; args.guard(); return { applied: true } } })
  adapter.executeW2 = () => { throw new Error('untrusted replacement') }
  assert.equal((await engine.tick('s')).outcome, 'applied')
  assert.throws(() => retained(), { code: 'WINDOW_AUTO_DISPOSED_OR_EXPIRED' })
  await engine.dispose()
})

test('missing callback guard and async W1 callback cannot claim success', async () => {
  const { engine } = host(evidence(), { executeW2() { return { applied: true } } })
  assert.equal((await engine.tick('s')).reason, 'executor-guard-contract-violated')
  assert.throws(() => host(evidence('W1'), { async executeW1() {} }), /WINDOW_AUTO_SYNC_W1_REQUIRED/)
  await engine.dispose()
})

test('disabled mode and missing evidence never call executors', async () => {
  let calls = 0
  const engine = createWindowAutoEngine({ adapter: { readEvidence() { calls++; return null } } })
  assert.equal((await engine.tick('s')).reason, 'auto-disabled'); assert.equal(calls, 0)
  await engine.dispose()
  const h = host(null)
  assert.equal((await h.engine.tick('s')).action, 'defer'); assert.equal(h.effects.length, 0)
  await h.engine.dispose()
})

test('audit failure fails closed before dispatch', async () => {
  let effects = 0
  const engine = createWindowAutoEngine({ enabled: true, clock: () => now,
    adapter: { readEvidence: () => evidence(), executeW2() { effects++; return { applied: true } } },
    audit() { throw new Error('disk unavailable') } })
  await assert.rejects(engine.tick('s'), /disk unavailable/)
  assert.equal(effects, 0); await engine.dispose()
})

test('malformed or duplicate candidates are refused without selector exceptions', () => {
  const e = evidence(); e.candidates = [null]
  assert.equal(select(e).action, 'defer')
  e.candidates = [evidence().candidates[0], evidence().candidates[0]]
  assert.equal(select(e).reason, 'candidate-identity-ambiguous')
})

function nativeW1Fixture() {
  const m = (id, role, value) => ({ id, role, source: { kind: 'fixture' }, content: [{ type: 'text', text: value }] })
  const messages = [m('sys', 'system', 'system'), m('old-u', 'user', 'old history '.repeat(4000)),
    m('old-a', 'assistant', 'old result '.repeat(4000)), m('now', 'user', 'current')]
  const source = { sessionId: 's', actorId: 'a', rootTeamId: 'team', windowId: 1, surfaceRevision: 1,
    criticalRevisionVector: { task: 1 }, identityVersion: 1, identityHashes: { actor: 'fixture' }, configFingerprint: 'fixture-config',
    planRef: { path: 'fixture-plan', sha256: sha('c') }, planRevision: 1, planHash: sha('c'),
    authority: Object.fromEntries(authorityKeys.map(k => [k, []])), working: {},
    recovery: { requiredRereads: [], memoryDebt: [], activeJobs: [] }, messages,
    recentTailIds: ['now'], pendingMessageIds: ['now'], protocolCertificateHash: sha('c'),
    events: messages.slice(1, -1).map((message, seq) => ({ seq, type: message.role + '/message', data: message.role === 'user' ? message : { message } })) }
  source.completedSpans = [{ status: 'completed', messageIds: ['old-u', 'old-a'],
    eventRefs: source.events.map(event => ({ seq: event.seq, sha256: windowHash(event) })), retentionReceipt: { currentAcl: true }, memoryDebtCovered: true }]
  const authority = createWindowCheckpointAuthority({ readSource: () => source, verifyRecovery: (_s, span) => span.retentionReceipt.currentAcl })
  const planner = createWindowProjection({ authority, mode: 'W1', sessions: ['s'], now: () => now,
    routes: [{ provider: 'synthetic', model: 'synthetic', protocol: 'deepseek-dsh-v1', certificateHash: sha('c'),
      configFingerprint: 'fixture-config', expiresAt: now + 1000 }] })
  const request = { sessionId: 's', actorId: 'a', provider: 'synthetic', model: 'synthetic', messages, signal: new AbortController().signal }
  const preview = planner.plan(request)
  assert.equal(preview.status, 'projected')
  const e = evidence('W1')
  e.sourceHash = preview.checkpoint.sourceHash; e.candidates[0].certification.sourceHash = e.sourceHash
  e.candidates[0].candidateHash = windowHash(preview.candidateMessages)
  e.candidates[0].certification.candidateHash = e.candidates[0].candidateHash
  return { e, source, authority, planner, request, preview, messages }
}

test('real native W1 planner receives approved candidate, validates dispatch and leaves original source intact', async () => {
  const f = nativeW1Fixture(), before = windowHash(f.source)
  let selected
  const { engine } = host(f.e, { executeW1(args) {
    args.guard()
    assert.equal(args.candidate.candidateHash, windowHash(f.preview.candidateMessages))
    f.planner.validateDispatch({ ...f.request, messages: f.preview.candidateMessages }, f.preview.checkpoint)
    selected = f.preview.candidateMessages
    return { applied: true, receiptId: 'native-transform-selection-only' }
  } })
  assert.equal(engine.dispatchW1('s').outcome, 'applied')
  assert.ok(selected.length < f.messages.length)
  assert.equal(windowHash(f.source), before)
  await engine.dispose()
})

test('native W1 dispatch CAS remains authoritative after W3 approval', async () => {
  const f = nativeW1Fixture(); let selected = false
  const { engine } = host(f.e, { executeW1(args) {
    args.guard()
    f.source.criticalRevisionVector.task++
    f.planner.validateDispatch({ ...f.request, messages: f.preview.candidateMessages }, f.preview.checkpoint)
    selected = true
    return { applied: true }
  } })
  assert.equal(engine.dispatchW1('s').reason, 'WINDOW_SOURCE_CAS_CONFLICT')
  assert.equal(selected, false); await engine.dispose()
})
