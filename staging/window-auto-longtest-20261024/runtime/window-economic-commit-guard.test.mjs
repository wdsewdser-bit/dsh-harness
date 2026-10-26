import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Session, installNativeSessionBridge } from '../../context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import Jsonl from '../../context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { createJsonlWindowBarrier } from '../../context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js'
import { createWindowTransition } from '../../context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-transition.mjs'
import { windowHash } from '../../context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
import { installEconomicCommitGuard } from './window-economic-commit-guard.mjs'
const require = createRequire(new URL('../../context-runtime-unified-20261001/app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))

async function fixture(t, fault = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'w3-native-boundary-'))
  const ctx = new Context(), backend = new Jsonl(ctx, { root, compression: 'none' })
  const session = Session.create('w3-boundary', undefined, { id: 'w3-boundary', version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
  const msg = id => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: id }] })
  session.append('user/message', msg('old'), { surfaceOp: 'append' })
  session.append('user/message', msg('tail'), { surfaceOp: 'append' })
  const original = session.snapshotEvents()
  const handle = await backend.create(session.header), barrier = createJsonlWindowBarrier(handle, session)
  const bridge = installNativeSessionBridge(session, { isolated: true, sessionId: session.id, flush: async () => { await barrier.persist(); return true } })
  let lock
  const participation = {
    certificate: () => ({ kind: 'participating-writers-v1', sessionId: session.id,
      domains: ['authority', 'identity', 'lease', 'plan', 'config', 'input-claim'], verified: true }),
    verifyCertificate: c => c.verified === true,
    read: () => ({ authority: 1 }),
    acquire() { assert.equal(lock, undefined); lock = {}; return lock },
    assertHeld(token) { assert.equal(token, lock); return true },
    release(token) { assert.equal(token, lock); lock = undefined },
  }
  const source = { sessionId: session.id, actorId: 'actor', rootTeamId: 'team', windowId: 0, surfaceRevision: 2,
    criticalRevisionVector: { authorityHash: 'fixed', host: { epoch: 1 }, nativeBoundaryHash: 'idle' },
    configFingerprint: 'idle-config-with-host', identityVersion: 1, identityHashes: { actor: 'fixed' },
    authority: { revision: 1 }, recovery: { memoryDebt: [], requiredRereads: [], activeJobs: [] },
    messages: original.map(e => e.data), completedSpans: [{ messageIds: ['old'], eventRefs: [{ seq: 0, sha256: windowHash(original[0]) }] }] }
  const policy = { route: { provider: 'synthetic', model: 'synthetic' }, config: { enabled: true }, certificateHash: 'a'.repeat(64) }
  const raw = { rawGatePreserved: true, rawSafetyTokens: 100, safeLimitTokens: 1000, safeCompactionRequired: false }
  const audit = []
  const gate = installEconomicCommitGuard({ session,
    readSource({ writerToken } = {}) {
      if (writerToken) bridge.readWindowSurface(writerToken)
      return source
    }, readPolicyBinding: () => policy, readRawSafety: () => raw, audit: row => audit.push(row) })
  const coordinator = createWindowTransition({ session, bridge, barrier, participation, isolated: true, sessionId: session.id,
    validateProposal: p => p.checkpoint.authorityVerified === true, safeBoundary: () => true, fault })
  const proposal = { checkpoint: { id: 'cp', authorityVerified: true }, message: msg('checkpoint'),
    range: { startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0], protocolCertificate: 'fixture', transformFingerprint: windowHash('order') }
  const abort = new AbortController()
  const run = () => gate.run({ guard: () => true, signal: abort.signal, actorId: 'actor',
    candidateHash: windowHash(proposal), sourceEventSeqs: [0], expiresAt: Date.now() + 10000 },
  () => coordinator.transition(proposal))
  t.after(async () => { gate.dispose(); await handle.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { gate, source, policy, raw, abort, run, coordinator, session, barrier, audit }
}

test('guard permits actual native durable commit while maintenance-only epochs change', async t => {
  let f
  f = await fixture(t, async stage => {
    if (stage === 'before-prepare') {
      await Promise.resolve()
      f.source.criticalRevisionVector.host.epoch++
      f.source.criticalRevisionVector.nativeBoundaryHash = 'maintenance'
      f.source.configFingerprint = 'maintenance-config-with-host'
    }
  })
  const result = await f.run()
  assert.equal(result.state, 'COMMITTED'); assert.equal(result.durable, true)
  assert.equal((await f.barrier.read()).filter(e => e.data?.source?.windowCommit).length, 1)
  assert.equal(f.audit.length, 1)
})

for (const stage of ['before-prepare', 'before-commit']) test('semantic source change after await at ' + stage + ' blocks native append', async t => {
  let f
  f = await fixture(t, async at => { if (at === stage) { await Promise.resolve(); f.source.authority.revision++ } })
  await assert.rejects(f.run(), { code: 'WINDOW_ECONOMIC_SOURCE_CHANGED' })
  assert.equal((await f.barrier.read()).filter(e => e.data?.source?.windowCommit).length, 0)
  assert.equal(f.session.snapshotEvents().filter(e => e.data?.source?.windowCommit).length, 0)
  assert.equal((await f.coordinator.recover()).state, 'aborted')
})

for (const action of ['signal', 'dispose', 'policy', 'raw', 'candidate']) test(action + ' changes after final asynchronous fault cannot authorize durable commit', async t => {
  let f
  f = await fixture(t, at => {
    if (at !== 'before-commit') return
    // This runs after a fault-hook-only guard would already have returned.
    queueMicrotask(() => {
      if (action === 'signal') f.abort.abort()
      if (action === 'dispose') f.gate.dispose()
      if (action === 'policy') f.policy.config.enabled = false
      if (action === 'raw') f.raw.rawSafetyTokens = f.raw.safeLimitTokens
      if (action === 'candidate') f.source.completedSpans[0].messageIds = ['other']
    })
  })
  await assert.rejects(f.run(), /WINDOW_ECONOMIC_/)
  assert.equal((await f.barrier.read()).filter(e => e.data?.source?.windowCommit).length, 0)
  assert.equal(f.session.snapshotEvents().filter(e => e.data?.source?.windowCommit).length, 0)
  assert.equal((await f.coordinator.recover()).state, 'aborted')
})

test('unarmed normal native capacity transition remains independent', async t => {
  const f = await fixture(t)
  const proposal = { checkpoint: { authorityVerified: true },
    message: { id: 'normal', role: 'user', source: { kind: 'runtime' }, content: [{ type: 'text', text: 'normal' }] },
    range: { startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0], protocolCertificate: 'fixture', transformFingerprint: windowHash('order') }
  assert.equal((await f.coordinator.transition(proposal)).state, 'COMMITTED')
  assert.equal(f.audit.length, 0)
})
