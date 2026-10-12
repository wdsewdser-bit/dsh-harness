import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { normalizeUsage, scanFrames, projectEvent, mergeEvents, resolveRoot, buildLedger, summarize } from '../tools/usage-history-backfill.mjs'

const source = version => ({ file: `synthetic-v${version}`, version, seq: 3, line: 4, frame: 1 })
const event = (usage, version = 3, extra = {}) => projectEvent({ type: 'assistant/message', seq: 3, time: 1790784000000, data: { turn: 1, step: 0, message: { id: 'message-id' }, usage, ...extra } }, source(version), 4)

test('migration duplicates merge both journals and retain version-exclusive requests', () => {
  const a = event({ inputTokens: 10, outputTokens: 2 }, 3)
  const b = event({ inputTokens: 10, outputTokens: 2 }, 4)
  const c = event({ inputTokens: 5 }, 3, { message: { id: 'v3-only' } })
  const d = event({ inputTokens: 7 }, 4, { message: { id: 'v4-only' } })
  const merged = mergeEvents([[a, c], [b, d]])
  assert.equal(merged.events.length, 3)
  assert.equal(merged.duplicates, 1)
  assert.equal(merged.events.find(e => e.messageId === 'message-id').sources.length, 2)
})

test('usage conflict is explicit; higher version wins and preserves lower known fields', () => {
  const merged = mergeEvents([[event({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }, 3)], [event({ inputTokens: 11 }, 4)]])
  assert.equal(merged.usageConflicts, 1)
  assert.equal(merged.duplicates, 0)
  assert.deepEqual(merged.conflicts[0].fields, ['input'])
  assert.equal(merged.events[0].usage.input, 11)
  assert.equal(merged.events[0].usage.output, 2)
  assert.equal(merged.events[0].usage.cacheRead, 0)
  assert.equal(merged.events[0].usage.total, null)
})

test('missing token counters are null and reasoning is not added to total', () => {
  assert.equal(normalizeUsage({ inputTokens: 0 }).input, 0)
  assert.equal(normalizeUsage({ inputTokens: 0 }).output, null)
  const rows = buildLedger({ id: 's', workspace: 'mc189-rs', header: { isSeeded: false } }, mergeEvents([[event({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3, totalTokens: 15 })]]), { rootTeam: 's', status: 'resolved', chain: ['s'] })
  assert.equal(rows[0].usage.total, 15)
  assert.equal(rows[0].promptInput, 10)
  assert.match(rows[0].provenance.promptInput, /^total-output/)
  assert.equal(summarize(rows).own.usage.cacheWrite.observedSum, null)
})

test('header association follows route changes without claiming wire evidence', () => {
  const header = (seq, provider) => projectEvent({ type: 'request/header', seq, time: seq, data: { header: { config: { provider, model: provider + '-model', apiKey: 'must-not-be-exported' } } } }, source(4), seq)
  const a = event({ inputTokens: 10 }, 4); a.seq = 2
  const b = event({ inputTokens: 20 }, 4, { message: { id: 'second' } }); b.seq = 4
  const rows = buildLedger({ id: 's', workspace: 'mc189-rs', header: { isSeeded: false } }, { events: [header(1, 'a'), a, header(3, 'b'), b] }, { rootTeam: 's', status: 'resolved', chain: ['s'] })
  assert.deepEqual(rows.map(r => r.provider), ['a', 'b'])
  assert.equal(rows[0].protocol, null)
  assert.equal(rows[0].provenance.route.evidence, 'historical-association-not-wire')
  assert.ok(!JSON.stringify(rows).includes('must-not-be-exported'))
})

test('root chain resolves, missing ancestors and cycles stay unknown', () => {
  const headers = new Map([['a', { parent: 'b' }], ['b', { parent: null }]])
  assert.equal(resolveRoot('a', headers).rootTeam, 'b')
  assert.equal(resolveRoot('missing', headers).status, 'missing-parent')
  headers.set('b', { parent: 'a' })
  assert.equal(resolveRoot('a', headers).status, 'cycle')
  const mixedIds = new Map([['child-uuid', { parent: 'session-root-uuid' }], ['session-root-uuid', { parent: null }]])
  assert.equal(resolveRoot('child-uuid', mixedIds).rootTeam, 'session-root-uuid')
})

test('strict scanning handles multiple frames, embedded magic and truncated tail', () => {
  const frames = [zstdCompressSync(Buffer.from('one\n')), zstdCompressSync(Buffer.from('two\n'))]
  assert.equal(scanFrames(Buffer.concat(frames)).frames.length, 2)
  const concatenated = Buffer.concat(frames)
  assert.equal(scanFrames(concatenated).frames.map(frame => zstdDecompressSync(concatenated.subarray(frame.start, frame.end)).toString()).join(''), 'one\ntwo\n')
  assert.equal(zstdDecompressSync(concatenated).toString(), 'one\n')
  const torn = scanFrames(Buffer.concat([...frames, frames[0].subarray(0, 5)]))
  assert.equal(torn.frames.length, 2)
  assert.equal(torn.tail.kind, 'incomplete')
  assert.equal(scanFrames(Buffer.concat([...frames, Buffer.from('xxxx')])).tail.kind, 'corrupt')
})

test('attempt and compaction usage are separate counted requests with direct historical route', () => {
  const attempt = projectEvent({ type: 'assistant/attempt', seq: 1, time: 1790784000000, data: { turn: 1, step: 0, usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } } }, source(4), 1)
  const compaction = projectEvent({ type: 'compaction/summary', seq: 2, time: 1790784000001, data: { compactionId: 'compaction', provider: 'summary-provider', model: 'summary-model', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } } }, source(4), 2)
  const rows = buildLedger({ id: 's', workspace: 'mc189-rs', header: { isSeeded: false } }, { events: [attempt, compaction] }, { rootTeam: 's', status: 'resolved', chain: ['s'] })
  const summary = summarize(rows)
  assert.equal(summary.own.requests, 2)
  assert.equal(summary.own.types['assistant/attempt'], 1)
  assert.equal(summary.own.types['compaction/summary'], 1)
  assert.equal(summary.own.usage.total.observedSum, 23)
  assert.equal(rows[1].provider, 'summary-provider')
})

test('official timed attempt chunks use the final usage snapshot once without exposing content', () => {
  const stream = [
    { type: 'chunk', time: 1, chunk: { type: 'content', content: 'sensitive-attempt-body' } },
    { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
    { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, totalTokens: 14 } } }
  ]
  const attempt = projectEvent({ type: 'assistant/attempt', seq: 1, time: 1, data: { turn: 1, step: 0, stream } }, source(4), 1)
  assert.equal(attempt.usage.total, 14)
  assert.equal(attempt.usage.reasoning, 2)
  assert.equal(attempt.usageSource, 'data.stream.last-usage-snapshot')
  assert.equal(attempt.sources[0].usageSnapshotIndex, 2)
  assert.ok(!JSON.stringify(attempt).includes('sensitive-attempt-body'))
  const explicit = projectEvent({ type: 'assistant/attempt', seq: 2, time: 2, data: { usage: { totalTokens: 20 }, stream } }, source(4), 2)
  assert.equal(explicit.usage.total, 20)
  assert.equal(explicit.usageSource, 'data.usage')
})

test('same-millisecond independent attempts preserve same-journal multiplicity across migration', () => {
  const makeAttempt = (version, seq, provider, total) => projectEvent({ type: 'assistant/attempt', seq, time: 123, data: { turn: 1, step: 0, provider, usage: { totalTokens: total } } }, { ...source(version), seq, line: seq + 1 }, seq)
  const v3 = [makeAttempt(3, 10, 'a', 12), makeAttempt(3, 20, 'b', 15)]
  const v4 = [makeAttempt(4, 10, 'a', 12), makeAttempt(4, 15, 'c', 19), makeAttempt(4, 20, 'b', 15)]
  const merged = mergeEvents([v3, v4])
  assert.equal(merged.events.length, 3)
  assert.equal(merged.duplicates, 2)
  assert.equal(merged.usageConflicts, 0)
  assert.deepEqual(merged.events.map(event => event.usage.total), [12, 19, 15])
  assert.deepEqual(merged.events.map(event => event.sources.length), [2, 1, 2])
  assert.equal(new Set(merged.events.map(event => event.identity)).size, 3)
  assert.equal(mergeEvents([[makeAttempt(4, 10, 'a', 12), makeAttempt(4, 11, 'b', 15)]]).events.length, 2)
})

test('only a proven same-file same-sequence copy is a local duplicate', () => {
  const first = projectEvent({ type: 'assistant/attempt', seq: 10, time: 123, data: { turn: 1, step: 0 } }, { ...source(4), seq: 10 }, 10)
  const copy = projectEvent({ type: 'assistant/attempt', seq: 10, time: 123, data: { turn: 1, step: 0 } }, { ...source(4), seq: 10, line: 20 }, 20)
  const merged = mergeEvents([[first, copy]])
  assert.equal(merged.events.length, 1)
  assert.equal(merged.duplicates, 1)
  assert.equal(merged.events[0].matching, 'same-file-same-sequence')
})

test('auxiliary search preserves its persisted model and does not borrow parent provider', () => {
  const header = projectEvent({ type: 'request/header', seq: 1, time: 1, data: { header: { config: { provider: 'parent', model: 'parent-model' } } } }, source(4), 1)
  const search = projectEvent({ type: 'web/deepseek-search-llm-request', seq: 2, time: 2, data: { endpoint: 'https://example.invalid', body: { model: 'search-model', messages: [{ content: 'sensitive-body' }] } } }, source(4), 2)
  const rows = buildLedger({ id: 's', workspace: 'mc189-rs', header: { isSeeded: false } }, { events: [header, search] }, { rootTeam: 's', status: 'resolved', chain: ['s'] })
  assert.equal(rows[0].provider, null)
  assert.equal(rows[0].model, 'search-model')
  assert.ok(!JSON.stringify(rows).includes('sensitive-body'))
  assert.equal(summarize(rows).byType[0].usage.total.observedSum, null)
})

test('seeded inherited prefix is retained but excluded from own usage aggregates', () => {
  const a = event({ inputTokens: 10 }, 4); a.seq = 1
  const cut = projectEvent({ type: 'session/end-seed', seq: 2, time: 2, data: { inherited: true } }, source(4), 2)
  const b = event({ inputTokens: 20 }, 4, { message: { id: 'own' } }); b.seq = 3
  const rows = buildLedger({ id: 's', workspace: 'mc189-rs', header: { isSeeded: true } }, { events: [a, cut, b] }, { rootTeam: 's', status: 'resolved', chain: ['s'] })
  assert.equal(summarize(rows).own.requests, 1)
  assert.equal(summarize(rows).inheritedRowsExcluded, 1)
})
