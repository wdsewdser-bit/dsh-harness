import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Session, installNativeSessionBridge } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { BasicCompactionEngine } from '../app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js'
import { ReactLoopInbox, inboxProjectionDefinition } from '../app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
import { createJsonlWindowBarrier } from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js'
import { createWindowTransition } from '../home/profiles/web/plugins/team-v15-window-transition.mjs'
import { windowHash as hash } from '../home/profiles/web/plugins/team-v15-window-checkpoint.mjs'
const require = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { SessionProjectionRegistry } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-projection')))
const msg = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function fixture(fault = () => {}, rootPath) {
  const root = rootPath ?? await mkdtemp(join(tmpdir(), 'window-transition-'))
  const backend = new Jsonl(new Context(), { root, compression: 'none' })
  const session = Session.create('w2-fixture', undefined, { id: 'w2-fixture', version: 4, cwd: root, createdAt: Date.now(), isSeeded: false })
  session.append('user/message', msg('old', 'old history '.repeat(100)), { surfaceOp: 'append' })
  session.append('user/message', msg('tail', 'safe current user'), { surfaceOp: 'append' })
  const handle = await backend.create(session.header), barrier = { ...createJsonlWindowBarrier(handle, session) }
  const bridge = installNativeSessionBridge(session, { isolated: true, sessionId: session.id, flush: async () => { await barrier.persist(); return true } })
  let critical = { authority: 1, identity: 1, lease: 1, plan: 1, config: 1 }, lock
  const participation = {
    certificate: () => ({ kind: 'participating-writers-v1', sessionId: session.id, domains: ['authority', 'identity', 'lease', 'plan', 'config', 'input-claim'], verified: true }),
    verifyCertificate: c => c.verified === true,
    read: () => structuredClone(critical),
    acquire(expected) { assert.deepEqual(critical, expected); if (lock) throw new Error('critical locked'); const token = {}; lock = token; return token },
    assertHeld(token, expected) { if (lock !== token || hash(critical) !== hash(expected)) throw new Error('critical CAS'); return true },
    release(token) { if (lock !== token) throw new Error('stale critical worker'); lock = undefined },
  }
  const coordinator = createWindowTransition({ session, bridge, barrier, participation, isolated: true, sessionId: session.id,
    validateProposal: p => p.checkpoint.authorityVerified === true, safeBoundary: () => true, fault })
  const proposal = () => ({ checkpoint: { id: 'cp', authorityVerified: true }, message: msg('checkpoint-' + session.seq, 'server checkpoint'),
    range: { startSeq: session.surface.nodes[0], endSeq: session.surface.nodes[0] },
    sourceEventSeqs: [session.surface.nodes[0]], protocolCertificate: 'fixture-only', transformFingerprint: hash('order') })
  return { root, backend, session, handle, barrier, bridge, coordinator, participation, proposal,
    mutate: () => { if (lock) throw new Error('participant fenced'); critical.authority++ }, close: () => handle.close() }
}
if (!process.env.WINDOW_CRASH_FIXTURE) {
test('missing control-plane participation stays blocked; exact opt-in mandatory', async () => {
  const f = await fixture()
  assert.throws(() => createWindowTransition({ session: f.session, bridge: f.bridge, barrier: f.barrier, isolated: true, sessionId: f.session.id }), /PARTICIPATION/)
  await f.close()
})
test('one durable replacement record is commit authority, preserves exact old journal and tail', async () => {
  const f = await fixture(), original = f.session.snapshotEvents()
  const receipt = await f.coordinator.transition(f.proposal(), { transitionId: 'one' })
  assert.equal(receipt.state, 'COMMITTED')
  assert.equal(receipt.durable, true)
  assert.deepEqual(f.session.snapshotEvents().slice(0, original.length), original)
  assert.equal(f.session.deriveMessages().at(-1).id, 'tail')
  const disk = await f.barrier.read()
  assert.equal(disk.filter(e => e.data?.source?.windowCommit?.transitionId === 'one').length, 1)
  assert.equal((await f.coordinator.recover()).state, 'clean')
  await f.close()
})
test('intent boundary fences append, compaction, reads and critical writers while preserving enqueue', async () => {
  let f, seen = false
  f = await fixture(async stage => {
    if (stage !== 'prepared-durable') return
    seen = true
    assert.throws(() => f.session.append('user/message', msg('illegal', 'x'), { surfaceOp: 'append' }), /FENCED/)
    assert.throws(() => f.session.deriveMessages(), /WINDOW_READ_PAUSED/)
    const ctx = new Context(); ctx.provide('llm', {}); ctx.provide('tokenMeter', {}); ctx.provide('sessions', {})
    const engine = new BasicCompactionEngine(ctx, { auto: false })
    assert.throws(() => engine.compactNow({ session: f.session }, new AbortController().signal), /COMPACTION_FENCED/)
    assert.throws(() => f.mutate(), /fenced/)
    f.session.append('native/input-accepted', { inputId: 'new', messageId: 'queued', target: 'next-step' })
    f.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [msg('queued', 'new correction')] })
    assert.throws(() => f.session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }), /FENCED/)
  })
  const receipt = await f.coordinator.transition(f.proposal(), { transitionId: 'queue' })
  assert.equal(seen, true)
  assert.deepEqual(receipt.consumedInputIds, [])
  assert.ok(f.session.snapshotEvents().some(e => e.type === 'native/input-accepted' && e.seq > receipt.pendingInputCutoff))
  await f.close()
})
for (const stage of ['before-prepare', 'prepared-durable', 'before-commit', 'commit-appended', 'commit-durable', 'before-publish']) {
  test('fault at ' + stage + ' never publishes mixed view; replay is idempotent', async () => {
    let fired = false
    const f = await fixture(at => { if (at === stage && !fired) { fired = true; throw new Error('fault-' + stage) } })
    await assert.rejects(f.coordinator.transition(f.proposal(), { transitionId: 'fault' }), /fault/)
    if (stage === 'commit-appended') {
      const before=await f.barrier.read()
      await assert.rejects(f.coordinator.recover(),/WINDOW_RECOVERY_REQUIRED/)
      assert.deepEqual(await f.barrier.read(),before)
      assert.throws(()=>f.session.deriveMessages(),/WINDOW_READ_PAUSED/)
      // The original writer resolves its own outstanding flush explicitly;
      // recovery itself must never perform that old commit's first persistence.
      await f.barrier.persist()
    }
    const result = await f.coordinator.recover()
    assert.ok(['clean', 'aborted', 'committed'].includes(result.state))
    assert.equal(f.session.deriveMessages().at(-1).id, 'tail')
    assert.equal((await f.coordinator.recover()).state, 'clean')
    await f.close()
  })
}
test('120 transitions + replay preserve old journal and monotonic window IDs', async () => {
  const f = await fixture(), original = f.session.snapshotEvents()
  for (let i = 1; i <= 120; i++) {
    const r = await f.coordinator.transition(f.proposal(), { transitionId: 'r' + i })
    assert.equal(r.toWindowId, i)
    assert.equal((await f.coordinator.recover()).state, 'clean')
  }
  assert.deepEqual(f.session.snapshotEvents().slice(0, original.length), original)
  assert.equal(f.session.deriveMessages().at(-1).id, 'tail')
  await f.close()
})
test('historical durable commit is confirmed under changed authority without a fresh proposal validator or flush',async()=> {
  const f=await fixture(stage=>{if(stage==='commit-durable')throw new Error('durable-crash')})
  await assert.rejects(f.coordinator.transition(f.proposal(),{transitionId:'historical'}))
  f.mutate()
  assert.equal((await f.coordinator.recover()).state,'committed')
  assert.equal((await f.barrier.read()).filter(e=>e.data?.source?.windowCommit).length,1)
  await f.close()
})
test('two concurrent transition calls serialize by rejecting second CAS owner', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(async stage => { if (stage === 'prepared-durable') { entered.resolve(); await release.promise } })
  const p = f.proposal(), first = f.coordinator.transition(p, { transitionId: 'first' })
  await entered.promise
  await assert.rejects(f.coordinator.transition(p, { transitionId: 'second' }), /BUSY/)
  release.resolve(); await first; await f.close()
})
for (const operation of ['persistBatch', 'readStoredLog']) test('actual JSONL ' + operation + ' failure blocks visibility until recovery', async () => {
  const f = await fixture(), original = f.backend[operation]
  let entered = false
  f.backend[operation] = async function(...args) { if (!entered) { entered = true; throw new Error('io-' + operation) } return original.apply(this, args) }
  await assert.rejects(f.coordinator.transition(f.proposal(), { transitionId: 'io' }), /io-/)
  assert.throws(() => f.session.deriveMessages(), /WINDOW_READ_PAUSED/)
  await f.coordinator.recover()
  assert.equal(f.session.deriveMessages().at(-1).id, 'tail')
  await f.close()
})
test('stale authority at commit aborts in the commit step itself: one durable resolution, readable without recover', async () => {
  let expired = false
  const f = await fixture(stage => { if (stage === 'prepared-durable' && !expired) { expired = true; f.participation.assertHeld = () => { throw new Error('lease expired') } } })
  const error = await f.coordinator.transition(f.proposal(), { transitionId: 'expired' }).then(() => null, failure => failure)
  assert.match(error.message, /lease expired/)
  assert.equal(error.transitionAborted, true)
  assert.equal(f.coordinator.status().paused, false)
  assert.equal(f.session.deriveMessages()[0].id, 'old')
  assert.equal((await f.barrier.read()).filter(e => e.type === 'native/window-aborted' && e.data.reason === 'commit-cas-conflict').length, 1)
  f.participation.assertHeld = () => true
  f.mutate()
  assert.equal((await f.coordinator.recover()).state, 'clean')
  await assert.rejects(f.coordinator.transition(f.proposal(), { transitionId: 'expired' }), /ALREADY_ABORTED/)
  assert.equal((await f.coordinator.transition(f.proposal(), { transitionId: 'retry' })).state, 'COMMITTED')
  await f.close()
})
test('a commit-step abort whose own persistence fails stays fenced until that write is resolved', async () => {
  const f = await fixture(stage => { if (stage === 'prepared-durable') f.participation.assertHeld = () => { throw new Error('lease expired') } })
  const original = f.backend.persistBatch
  let calls = 0
  // The intent persists; the ABORTED record's persistence is the second batch and fails.
  f.backend.persistBatch = async function(...args) { if (++calls === 2) throw new Error('abort-disk-failure'); return original.apply(this, args) }
  await assert.rejects(f.coordinator.transition(f.proposal(), { transitionId: 'unresolved' }), /abort-disk-failure/)
  assert.equal(f.coordinator.status().paused, true)
  assert.throws(() => f.session.deriveMessages(), /WINDOW_READ_PAUSED/)
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'native/window-aborted' && e.data.reason === 'commit-cas-conflict').length, 1)
  f.backend.persistBatch = original; f.participation.assertHeld = () => true
  assert.equal((await f.barrier.read()).filter(e => e.type === 'native/window-aborted').length, 0)
  // Recovery does not perform the first persistence of that record on the writer's behalf.
  await assert.rejects(f.coordinator.recover(), /WINDOW_RECOVERY_REQUIRED/)
  await f.barrier.persist()
  assert.equal((await f.coordinator.recover()).state, 'aborted')
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'native/window-aborted').length, 1)
  assert.equal(f.session.deriveMessages()[0].id, 'old')
  await f.close()
})
test('double recovery rejects competing worker and leaves exactly one durable resolution', async () => {
  const f = await fixture(stage => { if (stage === 'prepared-durable') throw new Error('paused') })
  await assert.rejects(f.coordinator.transition(f.proposal(), { transitionId: 'dual' }))
  const outcomes = await Promise.allSettled([f.coordinator.recover(), f.coordinator.recover()])
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1)
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'native/window-aborted').length, 1)
  await f.close()
})

test('a release that fails does not replace a durable commit receipt or the abort marker', async () => {
  let expire = false
  const f = await fixture(stage => { if (stage === 'prepared-durable' && expire) f.participation.assertHeld = () => { throw new Error('lease expired') } })
  const release = f.participation.release
  f.participation.release = token => { release(token); throw new Error('release-broke') }
  const receipt = await f.coordinator.transition(f.proposal(), { transitionId: 'kept' })
  assert.equal(receipt.state, 'COMMITTED')
  assert.equal(f.coordinator.status().releaseError, 'release-broke')
  expire = true
  const error = await f.coordinator.transition(f.proposal(), { transitionId: 'aborted' }).then(() => null, failure => failure)
  assert.equal(error.transitionAborted, true)
  assert.equal(error.releaseError?.message, 'release-broke')
  await f.close()
})
test('a defect inside a commit validator is not turned into a retryable abort', async () => {
  const f = await fixture(stage => { if (stage === 'prepared-durable') f.participation.assertHeld = () => { throw new TypeError('validator defect') } })
  const error = await f.coordinator.transition(f.proposal(), { transitionId: 'defect' }).then(() => null, failure => failure)
  assert.ok(error instanceof TypeError)
  assert.equal(error.transitionAborted, undefined)
  assert.equal(f.coordinator.status().paused, true)
  assert.equal(f.session.snapshotEvents().filter(e => e.type === 'native/window-aborted').length, 0)
  await f.close()
})

for(const corruption of ['duplicate','wrong-intent'])test('durable '+corruption+' abort resolution refuses recovery without journal rewrite',async()=> {
  const f=await fixture(stage=>{if(stage==='prepared-durable')throw new Error('prepared-crash')})
  await assert.rejects(f.coordinator.transition(f.proposal(),{transitionId:'corrupt-abort'}))
  const intent=f.session.snapshotEvents().find(row=>row.type==='native/window-intent').data
  const writer=f.bridge.acquireWriter(f.bridge.surfaceRevision)
  const data={transitionId:intent.transitionId,reason:'test-corruption',intentHash:corruption==='wrong-intent'?'wrong':intent.integrityHash}
  f.session.append('native/window-aborted',data,{writerToken:writer})
  if(corruption==='duplicate')f.session.append('native/window-aborted',data,{writerToken:writer})
  f.bridge.releaseWriter(writer);await f.barrier.persist()
  const before=await f.barrier.read()
  await assert.rejects(f.coordinator.recover(),/WINDOW_RECOVERY_REQUIRED/)
  assert.equal(f.coordinator.status().paused,true)
  assert.deepEqual(await f.barrier.read(),before)
  await f.close()
})
test('real native Inbox claim shares window fence; durable A/B/C enqueue wakes only after commit', async () => {
  let f, agent, wakes = 0
  f = await fixture(async stage => {
    if (stage !== 'prepared-durable') return
    assert.throws(() => agent.inbox.claim('next-step', 1), /WINDOW_READ_PAUSED/)
    assert.throws(() => f.bridge.admit(f.bridge.generation), /WINDOW_READ_PAUSED/)
    for (const id of ['A', 'B', 'C']) {
      const accepted = await f.bridge.accept(agent, { ...msg(id, id), source: { kind: 'user', rpcId: id } }, 'next-step', true)
      const durable = await f.barrier.read()
      assert.equal(durable[accepted.acceptanceSeq].type, 'native/input-accepted')
      assert.equal(durable[accepted.acceptanceSeq].data.inputId, id)
    }
    assert.equal(wakes, 0)
  })
  const registry = new SessionProjectionRegistry(new Context()); registry.register(inboxProjectionDefinition)
  agent = { phase: { kind: 'idle' }, inbox: new ReactLoopInbox(registry, f.session, { emit() {} }), wakeDriver() { wakes++ } }
  await f.coordinator.transition(f.proposal(), { transitionId: 'abc' })
  assert.equal(wakes, 1)
  assert.deepEqual(agent.inbox.claim('next-step', 1).map(m => m.id), ['A', 'B', 'C'])
  assert.equal(agent.inbox.nextStep.length, 3)
  const restored = Session.create(f.session.id, (await f.barrier.read()), f.session.header)
  assert.deepEqual(new ReactLoopInbox(registry, restored, { emit() {} }).nextStep.map(m => m.id), ['A', 'B', 'C'])
  await f.close()
})
function multipleProposal(f) {
  f.session.append('user/message', msg('second', 'second foldable history'), { surfaceOp: 'append' })
  f.session.append('user/message', msg('decision', 'keep teammate decision'), { surfaceOp: 'append' })
  f.session.append('user/message', msg('new-tail', 'latest human constraint'), { surfaceOp: 'append' })
  const { range, ...proposal } = f.proposal()
  const nodes = [...f.session.surface.nodes]
  return { ...proposal, ranges: [range, { startSeq: nodes[2], endSeq: nodes[2] }], sourceEventSeqs: [nodes[0], nodes[2]] }
}

for (const stage of ['before-prepare', 'prepared-durable', 'before-commit', 'commit-appended', 'commit-durable', 'before-publish']) {
  test('multi-range failure at ' + stage + ' keeps a complete old or new surface and recovers idempotently', async () => {
    let fired = false
    const f = await fixture(at => { if (at === stage && !fired) { fired = true; throw new Error('multi-fault') } })
    const proposal = multipleProposal(f), before = f.session.snapshotEvents()
    await f.barrier.persist()
    await assert.rejects(f.coordinator.transition(proposal, { transitionId: 'multiple-fault' }), /multi-fault/)
    if (stage === 'commit-appended') {
      await assert.rejects(f.coordinator.recover(), /WINDOW_RECOVERY_REQUIRED/)
      assert.throws(() => f.session.deriveMessages(), /WINDOW_READ_PAUSED/)
      await f.barrier.persist()
    }
    const recovered = await f.coordinator.recover()
    assert.ok(['clean', 'aborted', 'committed'].includes(recovered.state))
    const messages = f.session.deriveMessages(), ids = messages.map(row => row.id)
    const landed = ['commit-appended', 'commit-durable', 'before-publish'].includes(stage)
    assert.deepEqual(ids, landed ? [proposal.message.id, 'tail', 'decision', 'new-tail'] : ['old', 'tail', 'second', 'decision', 'new-tail'])
    assert.deepEqual(f.session.snapshotEvents().slice(0, before.length), before)
    const disk = await f.barrier.read(), cold = Session.create(f.session.id, disk, f.session.header)
    assert.deepEqual(cold.deriveMessages(), messages)
    assert.equal((await f.coordinator.recover()).state, 'clean')
    await f.close()
  })
}

test('multi-range preparation rejects missing sources, overlap, reorder, ambiguity and protected tail before a durable intent', async () => {
  const f = await fixture(), p = multipleProposal(f), before = f.session.snapshotEvents()
  for (const bad of [
    { ...p, sourceEventSeqs: [p.sourceEventSeqs[0]] },
    { ...p, ranges: [p.ranges[0], p.ranges[0]] },
    { ...p, ranges: [...p.ranges].reverse() },
    { ...p, range: p.ranges[0] },
    { ...p, ranges: [p.ranges[0], { startSeq: f.session.surface.nodes.at(-1), endSeq: f.session.surface.nodes.at(-1) }], sourceEventSeqs: [p.sourceEventSeqs[0], f.session.surface.nodes.at(-1)] },
  ]) await assert.rejects(f.coordinator.transition(bad), /WINDOW_INVALID_SURFACE_PROPOSAL|WINDOW_PROTECTED_TAIL/)
  assert.deepEqual(f.session.snapshotEvents(), before)
  await f.close()
})

test('durable multi-range commit confirmation verifies its exact ranges and rejects a modified commit without rewriting history', async () => {
  const f = await fixture(at => { if (at === 'commit-durable') throw new Error('multi-durable') })
  const proposal = multipleProposal(f)
  await assert.rejects(f.coordinator.transition(proposal, { transitionId: 'multi-durable' }))
  const originalRead = f.barrier.read
  f.barrier.read = async () => {
    const disk = structuredClone(await originalRead())
    const event = disk.find(row => row.data?.source?.windowCommit)
    event.surfaceOp.ranges[1].endSeq = event.surfaceOp.ranges[0].endSeq
    return disk
  }
  await assert.rejects(f.coordinator.recover(), /WINDOW_RECOVERY_REQUIRED/)
  f.barrier.read = originalRead
  assert.equal((await f.coordinator.recover()).state, 'committed')
  assert.equal((await f.coordinator.recover()).state, 'clean')
  await f.close()
})

for (const stage of ['prepared-durable', 'commit-appended', 'commit-durable', 'before-publish']) test('isolated subprocess crash at ' + stage + ' reconstructs exact durable authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'window-crash-'))
  const child = spawnSync(process.execPath, ['--import', new URL('../tools/prepare-unified-lab-host.mjs', import.meta.url).href, fileURLToPath(import.meta.url), root, stage], {
    env: { ...process.env, DSH_LAB_CANONICAL_MODULES: '1', WINDOW_CRASH_FIXTURE: '1' }, encoding: 'utf8', timeout: 20000,
  })
  assert.equal(child.status, 17, child.stderr)
  const backend = new Jsonl(new Context(), { root, compression: 'none' })
  const handle = await backend.open('w2-fixture', 'write'), disk = (await handle.read()).events
  const session = Session.create('w2-fixture', disk, handle.header)
  const barrier = createJsonlWindowBarrier(handle, session)
  const bridge = installNativeSessionBridge(session, { isolated: true, sessionId: session.id, flush: async () => { await barrier.persist(); return true } })
  const binding = disk.find(e => e.type === 'native/window-intent').data.expectedCritical
  let held
  const participation = {
    certificate: () => ({ kind: 'participating-writers-v1', sessionId: session.id, domains: ['authority', 'identity', 'lease', 'plan', 'config', 'input-claim'], verified: true }),
    verifyCertificate: () => true, read: () => binding, acquire: () => (held = {}),
    assertHeld: token => token === held, release: () => { held = undefined },
  }
  const coordinator = createWindowTransition({ session, bridge, barrier, participation, isolated: true, sessionId: session.id, validateProposal: () => true, safeBoundary: () => true })
  const restored = await coordinator.recover()
  assert.ok(['clean', 'aborted', 'committed'].includes(restored.state))
  assert.equal(session.deriveMessages().at(-1).id, 'tail')
  assert.equal(session.eventAt(0).data.id, 'old')
  const commits = session.snapshotEvents().filter(e => e.data?.source?.windowCommit)
  assert.equal(commits.length, ['commit-durable', 'before-publish'].includes(stage) ? 1 : 0)
  assert.equal((await coordinator.recover()).state, 'clean')
  const writer = bridge.acquireWriter(bridge.surfaceRevision)
  assert.ok(writer.epoch > disk.find(e => e.type === 'native/window-intent').data.fencingEpoch)
  bridge.releaseWriter(writer)
  await handle.close()
})
} else {
  const stage = process.argv[3]
  const f = await fixture(at => { if (at === stage) process.exit(17) }, process.argv[2])
  await f.coordinator.transition(f.proposal(), { transitionId: 'crashed' })
  process.exit(18)
}
