#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'

const FIELDS = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens', reasoning: 'reasoningTokens', total: 'totalTokens' }
const REQUEST_TYPES = new Set(['assistant/message', 'assistant/attempt', 'compaction/summary', 'session/title-llm-request', 'web/deepseek-search-llm-request'])
const TRACK_TYPES = new Set([...REQUEST_TYPES, 'request/header', 'request/context', 'model/selection', 'subagent/descriptor', 'session/end-seed'])
const hash = value => createHash('sha256').update(value).digest('hex')
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const textValue = value => typeof value === 'string' && value.length <= 300 && !/\s|Bearer|sk-[a-zA-Z0-9]{10}/.test(value) ? value : null
const sessionKey = value => typeof value === 'string' ? value : null
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)

export function normalizeUsage(raw) {
  return Object.fromEntries(Object.entries(FIELDS).map(([key, source]) => [key, finite(raw?.[source])]))
}

export function scanFrames(buffer) {
  const frames = []
  let offset = 0
  const finish = (kind, at, reason) => ({ frames, tail: { kind, offset: at, bytes: buffer.length - at, reason } })
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return finish('incomplete', start, 'magic')
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) return finish('corrupt', start, 'magic')
    offset += 4
    if (offset === buffer.length) return finish('incomplete', start, 'descriptor')
    const descriptor = buffer[offset++]
    if (descriptor & 24) return finish('corrupt', start, 'reserved-header-bit')
    const single = Boolean(descriptor & 32)
    const flag = descriptor >>> 6
    const dictionary = descriptor & 3
    const headerBytes = (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (flag === 0 ? single ? 1 : 0 : 1 << flag)
    if (buffer.length - offset < headerBytes) return finish('incomplete', start, 'header')
    offset += headerBytes
    for (;;) {
      if (buffer.length - offset < 3) return finish('incomplete', start, 'block-header')
      const block = buffer.readUIntLE(offset, 3)
      offset += 3
      const type = block >>> 1 & 3
      if (type === 3) return finish('corrupt', start, 'reserved-block-type')
      const bytes = type === 1 ? 1 : block >>> 3
      if (buffer.length - offset < bytes) return finish('incomplete', start, 'block-payload')
      offset += bytes
      if (block & 1) break
    }
    if (descriptor & 4) {
      if (buffer.length - offset < 4) return finish('incomplete', start, 'checksum')
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tail: null }
}

function routeValues(raw) {
  return { provider: textValue(raw?.provider), model: textValue(raw?.model), protocol: textValue(raw?.protocol) }
}

export function projectEvent(event, source, order) {
  const data = event.data ?? {}
  const message = data.message ?? event.message ?? data
  let rawUsage = data.usage ?? event.usage ?? message.usage
  let usageSource = data.usage !== undefined ? 'data.usage' : event.usage !== undefined ? 'event.usage' : message.usage !== undefined ? 'message.usage' : 'unknown'
  let usageSnapshotIndex = null
  if (rawUsage === undefined && Array.isArray(data.stream)) {
    for (let index = data.stream.length - 1; index >= 0; index--) {
      const record = data.stream[index]
      if (record?.type !== 'chunk' || record.chunk?.type !== 'usage' || !record.chunk.usage) continue
      rawUsage = record.chunk.usage
      usageSource = 'data.stream.last-usage-snapshot'
      usageSnapshotIndex = index
      break
    }
  }
  const usage = normalizeUsage(rawUsage)
  const route = event.type === 'web/deepseek-search-llm-request' ? routeValues({ model: data.body?.model })
    : event.type === 'request/header' ? routeValues(data.header?.config ?? data.header)
    : event.type === 'subagent/descriptor' ? routeValues({ provider: data.agentProvider, model: data.agentModel })
      : routeValues(event.type === 'session/title-llm-request' ? data.route : data)
  const projected = { type: event.type, time: finite(event.time), seq: finite(event.seq), turn: finite(data.turn ?? event.turn), step: finite(data.step ?? event.step), messageId: textValue(message.id), compactionId: textValue(data.compactionId), label: event.type === 'subagent/descriptor' && typeof data.label === 'string' && data.label.length <= 120 ? data.label : null, usage, usageSource, usageFieldSources: Object.fromEntries(Object.keys(FIELDS).map(key => [key, usage[key] === null ? null : usageSource])), route, inherited: data.inherited === true, order, sources: [{ ...source, usageSource, usageSnapshotIndex }] }
  const id = projected.messageId ?? projected.compactionId
  const clock = projected.time !== null || projected.turn !== null || projected.step !== null
  projected.identity = `${event.type}:${id ? 'id:' + id : clock ? canonical([projected.time, projected.turn, projected.step]) : 'usage:' + hash(canonical(usage)) + ':seq:' + projected.seq}`
  projected.baseIdentity = projected.identity
  projected.hasStableId = Boolean(id)
  return projected
}

export function readJournalSnapshot(file, workspace, sessionId) {
  const before = statSync(file)
  const bytes = readFileSync(file)
  const after = statSync(file)
  const version = Number(basename(file).match(/v(\d+)/)?.[1])
  const scan = scanFrames(bytes)
  const source = { file, workspace, sessionId, version, sha256: hash(bytes), size: bytes.length, mtimeMs: before.mtimeMs, readStatSize: before.size, changedDuringRead: before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size, frames: scan.frames.length, tail: scan.tail, decodeErrors: [], invalidJsonLines: 0, unterminatedJsonLine: false, eventCounts: {}, header: null }
  const events = []
  let pending = ''
  let line = 0
  let pendingStartFrame = 0
  const parse = (raw, frame) => {
    line++
    if (!raw.trim()) return
    let event
    try { event = JSON.parse(raw) } catch { source.invalidJsonLines++; return }
    source.eventCounts[event.type] = (source.eventCounts[event.type] ?? 0) + 1
    if (event.type === 'session') {
      source.header = { id: sessionKey(event.id), parent: sessionKey(event.parentSession), createdAt: finite(event.createdAt), isSeeded: event.isSeeded === true, workspace: textValue(event.cwd) ?? workspace }
    }
    if (TRACK_TYPES.has(event.type)) events.push(projectEvent(event, { file, version, seq: finite(event.seq), line, frame }, line))
  }
  for (const [index, frame] of scan.frames.entries()) {
    let decoded
    try { decoded = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8') } catch { source.decodeErrors.push({ frame: index, start: frame.start, end: frame.end, kind: 'zstd-decode-failed' }); if (pending) { source.invalidJsonLines++; pending = '' }; continue }
    if (!pending) pendingStartFrame = index
    const combined = pending + decoded
    let start = 0
    let end
    while ((end = combined.indexOf('\n', start)) !== -1) { parse(combined.slice(start, end), start === 0 ? pendingStartFrame : index); start = end + 1 }
    pending = combined.slice(start)
    pendingStartFrame = index
  }
  if (pending.trim()) { source.unterminatedJsonLine = true; parse(pending, pendingStartFrame) }
  return { source, events }
}

export function mergeEvents(eventGroups) {
  const buckets = new Map()
  const conflicts = []
  let duplicates = 0
  let usageConflicts = 0
  let sameJournalDistinctSequenceOccurrences = 0
  const combine = (prior, event, matching) => {
    const changed = Object.keys(FIELDS).filter(key => prior.usage[key] !== null && event.usage[key] !== null && prior.usage[key] !== event.usage[key])
    const routeChanged = ['provider', 'model', 'protocol'].filter(key => prior.route[key] && event.route[key] && prior.route[key] !== event.route[key])
    if (changed.length || routeChanged.length) {
      usageConflicts += changed.length > 0 ? 1 : 0
      conflicts.push({ identity: event.baseIdentity, fields: changed, routeFields: routeChanged, previous: { usage: prior.usage, route: prior.route, sources: prior.sources }, incoming: { usage: event.usage, route: event.route, sources: event.sources }, matching, resolution: 'higher-journal-version-with-null-field-preservation' })
    } else duplicates++
    event.sources = [...prior.sources, ...event.sources]
    event.usageFieldSources = Object.fromEntries(Object.keys(FIELDS).map(key => [key, event.usage[key] === null ? prior.usageFieldSources[key] : event.usageFieldSources[key]]))
    event.usage = Object.fromEntries(Object.keys(FIELDS).map(key => [key, event.usage[key] ?? prior.usage[key]]))
    event.route = Object.fromEntries(['provider', 'model', 'protocol'].map(key => [key, event.route[key] ?? prior.route[key]]))
    event.conflict = prior.conflict || changed.length > 0 || routeChanged.length > 0
    const selectedUsageSources = new Set(Object.values(event.usageFieldSources).filter(Boolean))
    event.usageSource = selectedUsageSources.size === 1 ? [...selectedUsageSources][0] : selectedUsageSources.size ? 'merged-field-sources' : 'unknown'
    event.matching = matching
    return event
  }
  for (const event of eventGroups.flat()) {
    if (!buckets.has(event.baseIdentity)) buckets.set(event.baseIdentity, new Map())
    const files = buckets.get(event.baseIdentity)
    const file = event.sources[0].file
    if (!files.has(file)) files.set(file, [])
    files.get(file).push(event)
  }
  const merged = []
  for (const [baseIdentity, files] of buckets) {
    const union = []
    for (const localEvents of [...files.values()].sort((a, b) => a[0].sources[0].version - b[0].sources[0].version)) {
      const local = new Map()
      for (const event of localEvents.sort((a, b) => (a.seq ?? a.order) - (b.seq ?? b.order))) {
        const key = event.seq === null ? `order:${event.order}` : `seq:${event.seq}`
        const prior = local.get(key)
        local.set(key, prior ? combine(prior, event, 'same-file-same-sequence') : event)
      }
      const incoming = [...local.values()]
      sameJournalDistinctSequenceOccurrences += Math.max(0, incoming.length - 1)
      const localVersion = localEvents[0].sources[0].version
      const available = new Set(union.map((event, index) => event.sources.some(source => source.version === localVersion) ? null : index).filter(index => index !== null))
      const matches = new Map()
      // Reserve exact sequence pairs before ordinal fallback so an inserted event
      // cannot consume a later exact match in a migrated journal.
      for (const event of incoming) {
        if (event.seq === null) continue
        const index = [...available].find(index => union[index].sources.some(source => source.seq === event.seq))
        if (index !== undefined) { matches.set(event, { index, method: 'cross-version-same-sequence' }); available.delete(index) }
      }
      for (const event of incoming) {
        if (matches.has(event)) continue
        const signature = canonical({ usage: event.usage, route: event.route })
        const index = [...available].find(index => canonical({ usage: union[index].usage, route: union[index].route }) === signature)
        if (index !== undefined) { matches.set(event, { index, method: 'cross-version-same-counters-and-route' }); available.delete(index) }
      }
      for (const event of incoming) {
        if (matches.has(event)) continue
        const index = available.values().next().value
        if (index !== undefined) { matches.set(event, { index, method: 'cross-version-base-identity-ordinal' }); available.delete(index) }
      }
      for (const event of incoming) {
        const match = matches.get(event)
        if (match) union[match.index] = combine(union[match.index], event, match.method)
        else { event.matching ??= 'version-exclusive-sequence'; union.push(event) }
      }
    }
    union.sort((a, b) => (a.seq ?? a.order) - (b.seq ?? b.order))
    union.forEach((event, ordinal) => {
      event.occurrence = ordinal
      event.identity = event.hasStableId && union.length === 1 ? baseIdentity : `${baseIdentity}:occurrence:${ordinal}`
      merged.push(event)
    })
  }
  return { events: merged.sort((a, b) => (a.seq ?? a.order) - (b.seq ?? b.order) || (a.time ?? 0) - (b.time ?? 0)), duplicates, usageConflicts, conflicts, sameJournalDistinctSequenceOccurrences }
}

export function resolveRoot(sessionId, headers) {
  const chain = []
  const seen = new Set()
  let id = sessionId
  while (id) {
    if (seen.has(id)) return { rootTeam: 'unknown', status: 'cycle', chain }
    seen.add(id); chain.push(id)
    const header = headers.get(id)
    if (!header) return { rootTeam: 'unknown', status: 'missing-parent', chain }
    if (header.lineageConflict) return { rootTeam: 'unknown', status: 'conflicting-header', chain }
    if (!header.parent) return { rootTeam: id, status: 'resolved', chain }
    id = header.parent
  }
  return { rootTeam: 'unknown', status: 'missing-header', chain }
}

export function buildLedger(session, merged, root) {
  let header = null
  let context = null
  let descriptor = null
  const inheritedCut = merged.events.filter(e => e.type === 'session/end-seed' && e.inherited).at(-1)?.seq ?? null
  const ledger = []
  for (const event of merged.events) {
    if (event.type === 'request/header') { header = event; context = null; continue }
    if (event.type === 'request/context') { context = event; continue }
    if (event.type === 'subagent/descriptor' || event.type === 'model/selection') { descriptor = event; continue }
    if (!REQUEST_TYPES.has(event.type)) continue
    const own = !session.header?.isSeeded ? 'own' : inheritedCut === null ? 'unknown-seeded-cut' : event.seq < inheritedCut ? 'inherited' : 'own'
    const directRoute = event.route.provider || event.route.model ? event : null
    const association = directRoute ?? (context?.route.provider && (!header?.route.provider || header.route.provider === context.route.provider) ? context : header) ?? descriptor
    const selected = association?.route ?? { provider: null, model: null, protocol: null }
    const route = { provider: event.route.provider ?? selected.provider, model: event.route.model ?? selected.model, protocol: event.route.protocol ?? selected.protocol }
    let promptInput = null
    let promptDerivation = 'unknown'
    if (event.usage.input !== null && event.usage.cacheRead !== null && event.usage.cacheWrite !== null) {
      promptInput = event.usage.input + event.usage.cacheRead + event.usage.cacheWrite
      promptDerivation = 'input+cacheRead+cacheWrite;all-three-known'
    } else if (event.usage.total !== null && event.usage.output !== null) {
      const aggregate = event.usage.total - event.usage.output
      const knownMinimum = (event.usage.input ?? 0) + (event.usage.cacheRead ?? 0) + (event.usage.cacheWrite ?? 0)
      if (aggregate >= knownMinimum) { promptInput = aggregate; promptDerivation = 'total-output;nonnegative-and-consistent-with-known-input-counters' }
    }
    ledger.push({ identity: `${session.id}:${event.identity}`, session: session.id, rootTeam: root.rootTeam, workspace: session.workspace, time: event.time === null ? null : new Date(event.time).toISOString(), beijingDay: event.time === null ? 'unknown' : new Date(event.time + 8 * 3600_000).toISOString().slice(0, 10), ...route, requestType: event.type, requestOwnership: own, usage: event.usage, promptInput, conflict: Boolean(event.conflict), lineageStatus: root.status, provenance: { sources: event.sources, usage: 'durable-event-usage;missing-preserved-as-null', usageSource: event.usageSource, usageFieldSources: event.usageFieldSources, identityMatching: { baseIdentity: event.baseIdentity, occurrence: event.occurrence ?? 0, method: event.matching }, route: association ? { evidence: 'historical-association-not-wire', type: association.type, sources: association.sources } : { evidence: 'unknown' }, promptInput: promptDerivation, reasoning: 'separate-counter-not-added-to-output-or-total', root: { status: root.status, chain: root.chain }, ownership: { isSeeded: session.header?.isSeeded ?? null, inheritedCut } } })
  }
  return ledger
}

const quantile = (sorted, fraction) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
export function summarize(rows) {
  const own = rows.filter(row => row.requestOwnership === 'own')
  const groups = new Map()
  const add = (map, row) => {
    const key = canonical([row.beijingDay, row.rootTeam, row.workspace, row.provider, row.model, row.protocol])
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  own.forEach(row => add(groups, row))
  const metrics = records => {
    const prompt = records.map(r => r.promptInput).filter(v => v !== null).sort((a, b) => a - b)
    const uncached = records.map(r => r.usage.input).filter(v => v !== null).sort((a, b) => a - b)
    const stats = values => ({ knownRequests: values.length, average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, p50: quantile(values, 0.5), p95: quantile(values, 0.95) })
    return { requests: records.length, usage: Object.fromEntries(Object.keys(FIELDS).map(key => { const values = records.map(r => r.usage[key]).filter(v => v !== null); return [key, { knownRequests: values.length, missingRequests: records.length - values.length, observedSum: values.length ? values.reduce((a, b) => a + b, 0) : null, complete: values.length === records.length }] })), promptInput: stats(prompt), uncachedInput: stats(uncached), missingRoute: records.filter(r => !r.provider || !r.model).length, missingProtocol: records.filter(r => !r.protocol).length, unknownTeam: records.filter(r => r.rootTeam === 'unknown').length, conflictedRequests: records.filter(r => r.conflict).length, types: Object.fromEntries([...REQUEST_TYPES].map(type => [type, records.filter(r => r.requestType === type).length])) }
  }
  const aggregate = fields => {
    const buckets = new Map()
    for (const row of own) { const key = canonical(fields.map(field => row[field])); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row) }
    return [...buckets.values()].map(records => ({ ...Object.fromEntries(fields.map(field => [field, records[0][field]])), ...metrics(records) }))
  }
  return { allLedgerRows: rows.length, inheritedRowsExcluded: rows.filter(r => r.requestOwnership === 'inherited').length, unknownOwnershipRowsExcluded: rows.filter(r => r.requestOwnership.startsWith('unknown')).length, own: metrics(own), byType: aggregate(['requestType']), byDay: aggregate(['beijingDay']), byWorkspace: aggregate(['workspace']), byRoute: aggregate(['provider', 'model', 'protocol']), groups: [...groups.values()].map(records => ({ beijingDay: records[0].beijingDay, rootTeam: records[0].rootTeam, workspace: records[0].workspace, provider: records[0].provider, model: records[0].model, protocol: records[0].protocol, ...metrics(records) })) }
}

export function run({ sessionsBase = 'D:/dsh-test/home/sessions', outputDir = 'D:/dsh-test/docs/usage-audit-20261001' } = {}) {
  const startedAt = new Date().toISOString()
  const toolFile = fileURLToPath(import.meta.url)
  const testsFile = join(dirname(toolFile), '..', 'usage-tests', 'usage-history-backfill.test.mjs')
  const generatedBy = { node: process.version, tool: { file: toolFile, sha256: hash(readFileSync(toolFile)) }, tests: existsSync(testsFile) ? { file: testsFile, sha256: hash(readFileSync(testsFile)) } : null }
  const sessions = []
  const sources = []
  const headers = new Map()
  for (const workspace of ['mc189-rs', 'RustMc']) {
    const base = join(sessionsBase, `--D-dsh-test-workspaces-${workspace}--`)
    for (const dir of readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const files = readdirSync(join(base, dir.name)).filter(file => /^session\.v[34]\.jsonl\.zstd$/.test(file)).sort()
      if (!files.length) continue
      const snapshots = files.map(file => readJournalSnapshot(join(base, dir.name, file), workspace, dir.name))
      sources.push(...snapshots.map(s => s.source))
      const availableHeaders = snapshots.map(s => s.source.header).filter(Boolean)
      const header = availableHeaders.at(-1) ?? null
      if (header) header.lineageConflict = availableHeaders.some(h => h.id !== header.id || h.parent !== header.parent || h.isSeeded !== header.isSeeded) || header.id !== dir.name
      headers.set(dir.name, header)
      sessions.push({ id: dir.name, workspace, header, snapshots, merged: mergeEvents(snapshots.map(s => s.events)) })
    }
  }
  const ledger = sessions.flatMap(s => buildLedger(s, s.merged, resolveRoot(s.id, headers)))
  const conflicts = sessions.flatMap(s => s.merged.conflicts.map(c => ({ session: s.id, workspace: s.workspace, ...c })))
  const migration = sessions.map(s => { const overlaps = s.merged.events.filter(e => new Set(e.sources.map(source => source.version)).size > 1); return { session: s.id, workspace: s.workspace, versions: s.snapshots.map(v => v.source.version), sourceTrackedEvents: s.snapshots.map(v => ({ file: v.source.file, trackedEvents: v.events.length, requestEvents: v.events.filter(e => REQUEST_TYPES.has(e.type)).length })), mergedTrackedEvents: s.merged.events.length, duplicateOccurrences: s.merged.duplicates, usageConflictOccurrences: s.merged.usageConflicts, conflictOccurrences: s.merged.conflicts.length, overlapIdentities: overlaps.length, overlapRequestIdentities: overlaps.filter(e => REQUEST_TYPES.has(e.type)).length, versionExclusiveIdentities: s.merged.events.filter(e => new Set(e.sources.map(source => source.version)).size === 1).length, lineage: resolveRoot(s.id, headers) } })
  const summary = summarize(ledger)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(outputDir, { recursive: true })
  const prefix = join(outputDir, `history-${stamp}`)
  const ledgerPath = `${prefix}-requests.jsonl`
  const conflictsPath = `${prefix}-conflicts.jsonl`
  const reportPath = `${prefix}-report.json`
  const identitiesPath = join(outputDir, 'history-identities.json')
  writeFileSync(ledgerPath, ledger.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' })
  writeFileSync(conflictsPath, conflicts.map(row => JSON.stringify(row)).join('\n') + (conflicts.length ? '\n' : ''), { flag: 'wx' })
  const identities = { version: 1, generatedAt: new Date().toISOString(), sessions: Object.fromEntries(sessions.map(session => {
    const lineage = resolveRoot(session.id, headers)
    const descriptor = session.merged.events.find(event => event.type === 'subagent/descriptor')
    return [session.id, { sessionId: session.id, parentSessionId: session.header?.parent ?? null, rootTeamId: lineage.rootTeam, workspace: session.workspace, label: descriptor?.label ?? null, lineageStatus: lineage.status, lineageChain: lineage.chain, provenance: session.snapshots.map(snapshot => ({ file: snapshot.source.file, sha256: snapshot.source.sha256, size: snapshot.source.size, mtimeMs: snapshot.source.mtimeMs })) }]
  })) }
  const priorIdentitiesPath = existsSync(identitiesPath) ? `${prefix}-identities-previous.json` : null
  if (priorIdentitiesPath) renameSync(identitiesPath, priorIdentitiesPath)
  writeFileSync(identitiesPath, JSON.stringify(identities, null, 2) + '\n', { flag: 'wx' })
  const report = { schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), scope: ['mc189-rs', 'RustMc'], restrictions: 'read-only-original-journals;no-provider-call;no-current-profile-inference', zstdVerification: { node: process.version, concatenatedOneShotResult: zstdDecompressSync(Buffer.concat([zstdCompressSync(Buffer.from('first')), zstdCompressSync(Buffer.from('second'))])).toString(), decoder: 'strict-complete-frame-scan;each-frame-decoded-once', corruptTailPolicy: 'stop-at-first-invalid-frame;preserve-prefix-and-report-unread-tail' }, definitions: { request: [...REQUEST_TYPES], usage: 'DSH TokenUsage input is uncached; cacheRead/cacheWrite disjoint input; reasoning separate and not added to total', promptInput: 'null unless input/cacheRead/cacheWrite all known; uncachedInput independently reported', aggregation: 'own rows only; inherited/unknown-seeded ownership retained in ledger but excluded', missing: 'null; observedSum never claims an exact grand total when missingRequests>0', routing: 'historical association; protocol unknown unless explicitly persisted; no wire evidence', migration: 'stable request/event identity union; higher version wins conflicts, lower version fills null; all source references retained' }, workspaces: ['mc189-rs', 'RustMc'].map(workspace => ({ workspace, sessions: sessions.filter(s => s.workspace === workspace).length, files: sources.filter(s => s.workspace === workspace).length, dualVersionSessions: sessions.filter(s => s.workspace === workspace && s.snapshots.length === 2).length })), decoding: { filesWithIncompleteTail: sources.filter(s => s.tail?.kind === 'incomplete').length, filesWithCorruptTail: sources.filter(s => s.tail?.kind === 'corrupt').length, failedFrames: sources.reduce((n, s) => n + s.decodeErrors.length, 0), invalidJsonLines: sources.reduce((n, s) => n + s.invalidJsonLines, 0), changedDuringRead: sources.filter(s => s.changedDuringRead).length }, duplicates: migration.reduce((n, m) => n + m.duplicateOccurrences, 0), usageConflicts: migration.reduce((n, m) => n + m.usageConflictOccurrences, 0), conflicts: conflicts.length, summary, migration, sources, outputs: { ledger: { path: ledgerPath, sha256: hash(readFileSync(ledgerPath)) }, conflicts: { path: conflictsPath, sha256: hash(readFileSync(conflictsPath)) } } }
  report.definitions.promptInput = 'input+cacheRead+cacheWrite when all known; otherwise total-output only if nonnegative and consistent with known input counters; missing raw fields remain null'
  report.outputs.identities = { path: identitiesPath, sha256: hash(readFileSync(identitiesPath)) }
  report.priorIdentitiesPath = priorIdentitiesPath
  report.generatedBy = generatedBy
  report.definitions.migration = 'preserve distinct sequences within each journal; merge only same-sequence local copies; cross-version base-identity matching reserves same-sequence pairs then counters/route then ordinal; higher version wins conflicts and lower version fills null'
  report.definitions.usageSource = 'explicit event usage preferred; otherwise last timed chunk {type:chunk,chunk:{type:usage,usage}} snapshot; cumulative snapshots are never summed'
  report.sameJournalDistinctSequenceOccurrencesPreserved = sessions.reduce((n, session) => n + session.merged.sameJournalDistinctSequenceOccurrences, 0)
  report.usageProvenance = [...new Set(ledger.map(row => row.provenance.usageSource))].map(usageSource => {
    const rows = ledger.filter(row => row.provenance.usageSource === usageSource)
    const totals = rows.map(row => row.usage.total).filter(value => value !== null)
    return { usageSource, requests: rows.length, knownTotalRequests: totals.length, observedTotal: totals.length ? totals.reduce((n, value) => n + value, 0) : null }
  })
  report.requestDuplication = { crossVersionIdentities: ledger.filter(row => new Set(row.provenance.sources.map(source => source.version)).size > 1).length, duplicateOccurrences: ledger.reduce((n, row) => n + row.provenance.sources.length - 1, 0), sameVersionDuplicateOccurrences: ledger.reduce((n, row) => n + row.provenance.sources.length - new Set(row.provenance.sources.map(source => source.version)).size, 0) }
  report.snapshot = { atomicAcrossFiles: false, description: 'Each compressed file is a read-only byte snapshot between startedAt and completedAt; appends after its read do not alter captured SHA or ledger' }
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  return { ledgerPath, conflictsPath, reportPath, identitiesPath, workspaces: report.workspaces, decoding: report.decoding, duplicates: report.duplicates, usageConflicts: report.usageConflicts, summary: { allLedgerRows: summary.allLedgerRows, inheritedRowsExcluded: summary.inheritedRowsExcluded, unknownOwnershipRowsExcluded: summary.unknownOwnershipRowsExcluded, own: summary.own, groups: summary.groups.length } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  if (args.length) throw new Error('This audit intentionally uses only the two bounded default workspaces; no arbitrary CLI path arguments')
  console.log(JSON.stringify(run(), null, 2))
}
