import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Session, foldSurface } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { foldSurface as browserFold, validateSurfaceMetadata } from '../app/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { createJsonlWindowBarrier } from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js'
import { assertV4RowAdmission, releasedV4SessionFormatCodec } from '../app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const message = (id, window = false) => ({ id, role: 'user', content: [{ type: 'text', text: id }],
  source: { kind: 'user', ...(window ? { windowCommit: { transitionId: id, toWindowId: 1 } } : {}) } })
const many = ranges => ({ op: 'replace-many', ranges })
const range = (startSeq, endSeq = startSeq) => ({ startSeq, endSeq })
function fixture(system = false) {
  const session = Session.create('multi-surface')
  if (system) session.append('system/message', { message: { id: 'system', role: 'system',
    source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'system prompt' }] } }, { surfaceOp: 'append' })
  const entries = Array.from({ length: 7 }, (_, index) => session.append('user/message', message('m' + index), { surfaceOp: 'append' }))
  return { session, seqs: entries.map(event => event.seq) }
}
function rejectUnchanged(session, data, surfaceOp, sources, type = 'user/message') {
  const before = { seq: session.seq, nodes: [...session.surface.nodes], events: session.snapshotEvents(),
    replacements: session.surface.replaceGeneration, content: session.surface.contentGeneration }
  assert.throws(() => session.append(type, data, { surfaceOp, sourceEventSeqs: sources }))
  assert.equal(session.seq, before.seq)
  assert.deepEqual(session.surface.nodes, before.nodes)
  assert.deepEqual(session.snapshotEvents(), before.events)
  assert.equal(session.surface.replaceGeneration, before.replacements)
  assert.equal(session.surface.contentGeneration, before.content)
}

test('multi-range fold preserves gaps and journal, with one checkpoint and generation', () => {
  const { session, seqs: s } = fixture(true)
  const original = session.snapshotEvents()
  const ranges = [range(s[0], s[1]), range(s[3], s[4]), range(s[6])]
  const sources = [s[0], s[1], s[3], s[4], s[6]]
  const generation = session.surface.replaceGeneration
  const checkpoint = session.append('user/message', message('checkpoint', true), { surfaceOp: many(ranges), sourceEventSeqs: sources })
  assert.equal(session.seq, original.length + 1)
  assert.equal(session.surface.replaceGeneration, generation + 1)
  assert.deepEqual(session.surface.nodes, [original[0].seq, checkpoint.seq, s[2], s[5]])
  assert.equal(session.surface.nodes.filter(seq => seq === checkpoint.seq).length, 1)
  assert.deepEqual(session.snapshotEvents().slice(0, original.length), original)
  for (const fold of [foldSurface, browserFold]) {
    const result = fold(session.snapshotEvents())
    assert.deepEqual(result.nodes, session.surface.nodes)
    assert.deepEqual(result.replacements, [{ seq: checkpoint.seq, start: s[0], end: s[6], ranges,
      shadowedSeqs: sources }])
  }
})

test('multi-range ordering uses current surface position rather than numeric seq', () => {
  const { session, seqs: s } = fixture()
  const prior = session.append('user/message', message('old-replace'), {
    surfaceOp: { op: 'replace', ...range(s[1]) }, sourceEventSeqs: [s[1]] })
  const checkpoint = session.append('user/message', message('checkpoint', true), {
    surfaceOp: many([range(prior.seq, s[2]), range(s[4], s[5])]),
    sourceEventSeqs: [prior.seq, s[2], s[4], s[5]] })
  assert.deepEqual(session.surface.nodes, [s[0], checkpoint.seq, s[3], s[6]])
  assert.deepEqual(browserFold(session.snapshotEvents()), foldSurface(session.snapshotEvents()))
})

test('overlap, reverse order, missing endpoints and invalid ranges reject without admission', () => {
  const { session, seqs: s } = fixture()
  const invalid = [
    [range(s[1], s[3]), range(s[3], s[4])],
    [range(s[4]), range(s[1])],
    [range(s[1]), range(999)],
    [range(s[1]), range(s[4], s[3])],
    [range(s[1])], [],
    [range(s[1]), { ...range(s[4]), extra: true }],
    [range(s[1]), { startSeq: -1, endSeq: s[4] }],
    [range(s[1]), { startSeq: 1.5, endSeq: s[4] }],
    [range(s[1]), { startSeq: Number.MAX_SAFE_INTEGER + 1, endSeq: s[4] }],
    [range(s[1]), { startSeq: -0, endSeq: s[4] }],
    [range(s[1]), , range(s[4])],
  ]
  for (const ranges of invalid) rejectUnchanged(session, message('bad', true), many(ranges), s)
  rejectUnchanged(session, message('bad', true), { ...many([range(s[1]), range(s[4])]), extra: true }, s)
  const prototypeRange = Object.create({ startSeq: s[4] }); prototypeRange.endSeq = s[4]
  assert.throws(() => validateSurfaceMetadata({ type: 'user/message', seq: session.seq, data: message('bad', true),
    surfaceOp: many([range(s[1]), prototypeRange]), sourceEventSeqs: s }))
})

test('all shadowed sources must be cited and source arrays must be valid before mutation', () => {
  const { session, seqs: s } = fixture()
  const op = many([range(s[1], s[2]), range(s[4], s[5])])
  for (const sources of [undefined, [], [s[1], s[2], s[4]], [s[1], s[2], s[4], s[5], s[5]],
    [s[1], s[2], s[4], s[5], session.seq], [s[1], , s[2], s[4], s[5]]])
    rejectUnchanged(session, message('bad', true), op, sources)
})

test('only user window checkpoints may use multi-range replacement; system head stays protected', () => {
  const { session, seqs: s } = fixture(true)
  const op = many([range(s[1]), range(s[4])])
  rejectUnchanged(session, message('plain'), op, [s[1], s[4]])
  for (const windowCommit of [null, false, 'marker', []])
    rejectUnchanged(session, { ...message('bad'), source: { kind: 'user', windowCommit } }, op, [s[1], s[4]])
  rejectUnchanged(session, { message: { ...message('system', true), role: 'system', source: { kind: 'system-prompt', windowCommit: {} } } },
    op, [s[1], s[4]], 'system/message')
  rejectUnchanged(session, { callId: 'tool', message: { ...message('tool', true), role: 'tool', toolCallId: 'tool',
    source: { kind: 'tool', callId: 'tool', windowCommit: {} } } }, op, [s[1], s[4]], 'tool/result')
  rejectUnchanged(session, message('checkpoint', true), many([range(session.surface.nodes[0]), range(s[4])]),
    [session.surface.nodes[0], s[4]])
})

test('Session seed, both folds and subsequent appends agree after a multi-range checkpoint', () => {
  const { session, seqs: s } = fixture()
  session.append('user/message', message('checkpoint', true), { surfaceOp: many([range(s[0], s[1]), range(s[4], s[5])]),
    sourceEventSeqs: [s[0], s[1], s[4], s[5]] })
  session.append('session/end-seed', {})
  const events = session.snapshotEvents()
  const restored = Session.create('multi-surface', events)
  assert.deepEqual(restored.surface.nodes, session.surface.nodes)
  assert.equal(restored.surface.replaceGeneration, session.surface.replaceGeneration)
  for (const current of [session, restored]) current.append('user/message', message('after'), { surfaceOp: 'append' })
  assert.deepEqual(restored.surface.nodes, session.surface.nodes)
  for (const fold of [foldSurface, browserFold]) assert.deepEqual(fold(restored.snapshotEvents()).nodes, session.surface.nodes)
  const corrupted = structuredClone(events)
  corrupted.find(event => event.surfaceOp?.op === 'replace-many').surfaceOp.ranges.reverse()
  assert.throws(() => Session.create('invalid', corrupted), /strictly ordered/)
  for (const fold of [foldSurface, browserFold]) assert.throws(() => fold(corrupted), /strictly ordered/)
})

test('durable JSONL records one checkpoint, retains originals and cold restores multi-range surface', async t => {
  const root = await mkdtemp(join(tmpdir(), 'window-multi-surface-'))
  const backend = new Jsonl(new Context(), { root, compression: 'none' })
  const { session, seqs: s } = fixture()
  const handle = await backend.create(session.header)
  t.after(async () => { await handle.close(); await rm(root, { recursive: true, force: true }) })
  const barrier = createJsonlWindowBarrier(handle, session)
  const before = session.snapshotEvents()
  const checkpoint = session.append('user/message', message('durable', true), {
    surfaceOp: many([range(s[1], s[2]), range(s[5])]), sourceEventSeqs: [s[1], s[2], s[5]] })
  await barrier.persist()
  const disk = await barrier.read()
  assert.deepEqual(disk.slice(0, before.length), before)
  assert.equal(disk.filter(event => event.data?.source?.windowCommit).length, 1)
  assert.deepEqual(disk.at(-1), checkpoint)
  assert.deepEqual(Session.create('cold-durable', disk).surface.nodes, session.surface.nodes)
})

test('legacy replace metadata, tool content restrictions and system head rewrite remain compatible', () => {
  const { session, seqs: s } = fixture(true)
  const checkpoint = session.append('user/message', message('legacy'), {
    surfaceOp: { op: 'replace', ...range(s[1], s[2]) }, sourceEventSeqs: [s[1], s[2]] })
  for (const fold of [foldSurface, browserFold]) assert.deepEqual(fold(session.snapshotEvents()).replacements,
    [{ seq: checkpoint.seq, start: s[1], end: s[2], shadowedSeqs: [s[1], s[2]] }])
  const head = session.surface.nodes[0]
  const rewritten = session.append('system/message', { message: { id: 'system-rewrite', role: 'system',
    source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'new system' }] } },
    { surfaceOp: { op: 'replace', ...range(head) }, sourceEventSeqs: [head] })
  assert.equal(session.surface.nodes[0], rewritten.seq)
  const toolData = { message: { id: 'tool', role: 'tool', toolCallId: 'c', source: { kind: 'tool', callId: 'c' },
    content: [{ type: 'text', text: 'original' }] }, callId: 'c' }
  const tool = session.append('tool/result', toolData, { surfaceOp: 'append' })
  const changed = { ...toolData, message: { ...toolData.message, content: [{ type: 'text', text: 'short' }] } }
  const update = session.append('tool/result', changed, { surfaceOp: { op: 'replace', ...range(tool.seq) }, sourceEventSeqs: [tool.seq] })
  rejectUnchanged(session, { ...changed, callId: 'different' }, { op: 'replace', ...range(update.seq) }, [update.seq], 'tool/result')
  rejectUnchanged(session, changed, many([range(s[0]), range(update.seq)]), [s[0], update.seq], 'tool/result')
  assert.deepEqual(browserFold(session.snapshotEvents()), foldSurface(session.snapshotEvents()))
})

test('V4 codec rejects malformed multi-range rows before recoverable-tail handling', () => {
  const { session, seqs: s } = fixture()
  const good = { type: 'user/message', seq: session.seq, time: Date.now(), data: message('codec', true),
    surfaceOp: many([range(s[1]), range(s[4])]), sourceEventSeqs: [s[1], s[4]] }
  assert.doesNotThrow(() => assertV4RowAdmission(good))
  assert.deepEqual(releasedV4SessionFormatCodec.encodeEvent(good), good)
  const invalid = [
    { ...good, surfaceOp: many([range(s[1])]) },
    { ...good, surfaceOp: many([range(s[1]), , range(s[4])]) },
    { ...good, surfaceOp: many([range(s[1]), { ...range(s[4]), extra: true }]) },
    { ...good, surfaceOp: { ...good.surfaceOp, extra: true } },
    { ...good, surfaceOp: many([range(s[1]), range(good.seq)]) },
    { ...good, surfaceOp: many([range(s[1]), range(-1)]) },
    { ...good, surfaceOp: many([range(s[1]), range(1.5)]) },
    { ...good, surfaceOp: many([range(s[1]), range(Number.MAX_SAFE_INTEGER + 1)]) },
    { ...good, data: message('plain') },
    { ...good, type: 'tool/result' },
  ]
  const header = releasedV4SessionFormatCodec.encodeHeader({ ...session.header, delegationDepth: 0 }, 0)
  for (const row of invalid) {
    assert.throws(() => assertV4RowAdmission(row))
    assert.throws(() => releasedV4SessionFormatCodec.encodeEvent(row))
    const decoder = releasedV4SessionFormatCodec.createDecoder(header, 'tail')
    let emitted = false
    assert.throws(() => decoder.decodeRow(row, { emitRun() { emitted = true }, emitEvent() { emitted = true } }))
    assert.equal(emitted, false)
  }
})
