import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTokens } from './team-v12-context.mjs'

// HMR activation marker: 2026-09-28T11:30+08:00 b99-explicit-tier-identity.
export const CONTEXT_MARKER = '[team v14 context manifest] '
const END_STATES = new Set(['completed', 'deleted', 'cancelled', 'expired', 'accepted'])
const TASK_DELIVERABLE_PREVIEW_CHARS = 4096
const hash = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const text = (value) => String(value ?? '')

function boundedDeliverable(value) {
  if (value === undefined) return { value: undefined, truncated: false, chars: 0, digest: null }
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  if (raw.length <= TASK_DELIVERABLE_PREVIEW_CHARS) {
    return { value, truncated: false, chars: raw.length, digest: hash(raw).slice(0, 16) }
  }
  const marker = '\n...[task deliverable truncated; originalChars=' + raw.length
    + '; fetch the full contract with task_contract_get]...\n'
  const remaining = Math.max(0, TASK_DELIVERABLE_PREVIEW_CHARS - marker.length)
  const headChars = Math.ceil(remaining / 2)
  const tailChars = Math.floor(remaining / 2)
  return {
    value: raw.slice(0, headChars) + marker + raw.slice(raw.length - tailChars),
    truncated: true,
    chars: raw.length,
    digest: hash(raw).slice(0, 16),
  }
}

const tokenStats = (value) => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  let ascii = 0
  let nonAscii = 0
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    if (code <= 0x7f) {
      ascii += 1
      continue
    }
    nonAscii += 1
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < raw.length) {
      const next = raw.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index += 1
    }
  }
  return { ascii, nonAscii }
}

const addTokenStats = (...rows) => rows.reduce((total, row) => ({
  ascii: total.ascii + row.ascii,
  nonAscii: total.nonAscii + row.nonAscii,
}), { ascii: 0, nonAscii: 0 })

const tokenCount = (stats) => Math.max(1, Math.ceil(stats.ascii / 4) + stats.nonAscii)

const joinTokenStats = (rows) => rows.reduce((total, row, index) => {
  if (index === 0) return row
  return addTokenStats(total, tokenStats('\n\n'), row)
}, { ascii: 0, nonAscii: 0 })

export const messageText = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((block) => block.type === 'text').map((block) => text(block.text)).join('\n')

export function activeTask(task) {
  return !END_STATES.has(text(task?.status).toLowerCase()) && !END_STATES.has(text(task?.lifecycle).toLowerCase())
}

export function taskContext(task) {
  const contract = task.contract ?? task
  const acceptance = Array.isArray(contract.acceptanceCriteria ?? task.acceptanceCriteria)
    ? (contract.acceptanceCriteria ?? task.acceptanceCriteria)
    : []
  const deliverable = boundedDeliverable(contract.deliverable)
  return {
    id: task.id, revision: task.revision, owner: task.ownerName ?? contract.owner,
    status: task.status, phase: task.phase, subject: task.subject,
    deliverable: deliverable.value,
    deliverableTruncated: deliverable.truncated,
    deliverableChars: deliverable.chars,
    deliverableDigest: deliverable.digest,
    acceptanceSummary: acceptance.length === 0
      ? 'no acceptance criteria recorded'
      : acceptance.length + ' acceptance criteria; fetch the full contract before acting',
    acceptanceDigest: acceptance.length === 0 ? null : hash(acceptance).slice(0, 16),
    dependencies: contract.dependencies ?? task.blockedBy ?? [],
    writeScopes: contract.writeScopes ?? task.writeScopes ?? [],
    planId: task.planId ?? task.id, evidenceIds: task.evidenceIds ?? [],
    fetch: { action: 'task_contract_get', task_id: task.id },
  }
}

/** Only trusted plugin messages can acknowledge system-generated context. */
export function parseContextManifest(message) {
  if (message?.source?.kind !== 'team-message' || message?.source?.plugin !== 'team-v12-runtime') return null
  const line = messageText(message).split('\n').find((row) => row.startsWith(CONTEXT_MARKER))
  if (!line) return null
  try {
    const row = JSON.parse(line.slice(CONTEXT_MARKER.length))
    return row?.version === 1 && typeof row.receiptId === 'string' && Array.isArray(row.items) ? row : null
  } catch { return null }
}

export function nativeMessageIds(messages) {
  const ids = new Set()
  for (const message of messages ?? []) {
    // User/assistant quoting a marker is not a delivery receipt.
    if (message?.source?.kind !== 'team-message') continue
    for (const match of messageText(message).matchAll(/\[team message id=([^\]\r\n]+)\]/g)) ids.add(match[1])
  }
  return ids
}

function scanVisibleContext(messages, { member, sessionId } = {}) {
  const versions = new Map()
  const compact = new Map()
  for (const message of messages ?? []) {
    const manifest = parseContextManifest(message)
    if (!manifest) continue
    if (member !== undefined && text(manifest.member) !== text(member)) continue
    if (sessionId !== undefined && text(manifest.sessionId) !== text(sessionId)) continue
    for (const item of manifest.items) {
      versions.set(item.id, item.hash)
      if (item.form === 'compact') compact.set(item.id, item.hash)
      else compact.delete(item.id)
    }
  }
  return { versions, compact }
}

export function visibleContextVersions(messages, options = {}) {
  return scanVisibleContext(messages, options).versions
}

export const IDENTITY_ROLE_FILES = Object.freeze({
  0: 'root.md',
  1: 'lead.md',
  2: 'member.md',
})

/** Resolve the standing identity without silently degrading an unknown tier. */
export function identityRoleFile(mine, manifest = {}) {
  if (mine?.role === 'verifier' || mine?.group === 'verifier') return 'verifier.md'
  const tier = Number(mine?.tier)
  if (!Number.isInteger(tier) || !Object.prototype.hasOwnProperty.call(IDENTITY_ROLE_FILES, tier)) {
    throw new Error('identity role unresolved: member "' + text(mine?.name)
      + '" has invalid tier "' + text(mine?.tier) + '"')
  }
  const file = IDENTITY_ROLE_FILES[tier]
  const declared = manifest?.roleFiles?.[tier] ?? manifest?.roleFiles?.[String(tier)]
  if (declared !== undefined && text(declared) !== file) {
    throw new Error('identity role mapping mismatch: tier ' + tier
      + ' declares "' + text(declared) + '", expected "' + file + '"')
  }
  return file
}

/** Read and verify the actual role text. A version label alone is not an update. */
export function identitySource(rolesDir, mine) {
  if (!rolesDir) return null
  const manifest = JSON.parse(readFileSync(join(rolesDir, 'identity-version.json'), 'utf8'))
  const file = identityRoleFile(mine, manifest)
  const files = ['AGENTS.md', file]
  const bodies = files.map((name) => {
    const bytes = readFileSync(join(rolesDir, name))
    if (hash(bytes).toLowerCase() !== text(manifest.files?.[name]).toLowerCase()) throw new Error('identity hash mismatch: ' + name)
    return bytes.toString('utf8')
  })
  return {
    id: 'identity:' + mine.name, revision: manifest.identityVersion,
    content: '[team identity update] ' + manifest.identityVersion + '\n' + bodies.join('\n\n'),
    priority: 0, required: true, safetyCritical: true,
    metadata: { identityVersion: manifest.identityVersion, roleFile: file },
  }
}

/** Rebuild source cursors from durable committed-delivery receipts. */
function scanDurableContext(receipts = [], { member, sessionId, epochId } = {}) {
  const versions = new Map()
  // id -> hash of the source whose latest confirmed delivery was in compact form.
  const compact = new Map()
  for (const row of receipts ?? []) {
    if (member !== undefined && text(row?.member) !== text(member)) continue
    if (sessionId !== undefined && text(row?.sessionId) !== text(sessionId)) continue
    if (epochId && text(row?.epochId ?? row?.baselineId) !== text(epochId)) continue
    // History admission is not adapter dispatch; older receipts cannot attest
    // that their candidate prompt reached the actual request boundary.
    if (row?.contentReceiptVersion === 3) {
      for (const [id, version] of Object.entries(row?.versions ?? {})) {
        if (!id || !version) continue
        // A cursor restates what item receipts already established; its own form
        // marks decide only for hashes the receipts do not cover.
        const restated = versions.get(text(id)) === text(version)
        versions.set(text(id), text(version))
        if (restated) continue
        if (row.compactVersions?.[id] === version) compact.set(text(id), text(version))
        else compact.delete(text(id))
      }
    }
    const dispatched = row?.dispatch?.handedToAdapter === true
      && row.dispatch.stage === 'handed-to-adapter' && text(row.dispatch.requestId)
    for (const item of dispatched && Array.isArray(row?.items) ? row.items : []) {
      if (!item?.id || !item?.hash) continue
      versions.set(text(item.id), text(item.hash))
      if (item.form === 'compact') compact.set(text(item.id), text(item.hash))
      else compact.delete(text(item.id))
    }
  }
  return { versions, compact }
}

export function durableContextVersions(receipts = [], options = {}) {
  return scanDurableContext(receipts, options).versions
}

/** Sources whose latest confirmed delivery carried only the compact form. */
export function durableCompactVersions(receipts = [], options = {}) {
  return scanDurableContext(receipts, options).compact
}

export function completeContextBaseline(manifest) {
  return Boolean(manifest?.baselineId && manifest?.bindingHash && Array.isArray(manifest?.required)
    && manifest.required.length > 0 && !(manifest.debt?.length)
    && manifest.required.every(item => manifest.items?.some(row => row.id === item.id && row.hash === item.hash)))
}

/** Only committed native log events establish an epoch; intent and notices cannot. */
const epochCache = new WeakMap()
export function committedContextEpoch(session) {
  const previous = epochCache.get(session)
  const seq = Number(session?.seq)
  if (previous && Number.isFinite(seq) && previous.seq === seq) return previous.epoch
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents(previous && Number.isFinite(seq) && seq >= previous.seq ? previous.seq : 0) : session?.log
  if (!Array.isArray(events)) throw new Error('team-context-epoch-log-unavailable')
  let epoch = previous && Number.isFinite(seq) && seq >= previous.seq ? previous.epoch : null
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    const commit = event?.type === 'user/message' ? event.data?.source?.windowCommit : null
    if (commit) { epoch = { compactionId: 'window:' + text(commit.transitionId ?? commit.toWindowId ?? event.seq), endedAt: Number(event.time) || 0 }; break }
    if (event?.type === 'compaction/end' && !event.error && !event.data?.error && event.data?.compactionId) {
      epoch = { compactionId: text(event.data.compactionId), endedAt: Number(event.time) || 0 }; break
    }
  }
  epochCache.set(session, { seq, epoch })
  return epoch
}

/** Migrate by replaying actual item receipts, never legacy notice cursors. */
export function committedContextCursor(previous, receipts, manifest, { member, sessionId, dispatch, now = Date.now() } = {}) {
  const dispatched = dispatch?.handedToAdapter === true && dispatch.stage === 'handed-to-adapter' && text(dispatch.requestId)
  const epochId = text(manifest?.baselineId ?? previous?.epochId) || null
  const scanned = scanDurableContext(
    [...(receipts ?? []), ...(previous ? [previous] : []), { member, sessionId, dispatch, baselineId: manifest?.baselineId, items: manifest?.items ?? [] }],
    { member, sessionId, epochId },
  )
  const versions = Object.fromEntries(scanned.versions)
  const noticeVersions = { ...(epochId && previous?.epochId !== epochId ? {} : previous?.noticeVersions ?? {}) }
  for (const item of manifest?.debt ?? []) {
    if (item?.id && item?.hash) noticeVersions[item.id] = item.hash
  }
  for (const item of dispatched ? manifest?.items ?? [] : []) {
    if (noticeVersions[item.id] === item.hash) delete noticeVersions[item.id]
  }
  return {
    member, sessionId, contentReceiptVersion: 3, versions, noticeVersions,
    // Which of those hashes were last delivered only in compact form; absent when none, so older readers see no change.
    ...(scanned.compact.size ? { compactVersions: Object.fromEntries(scanned.compact) } : {}),
    epochId,
    baselineProof: dispatch?.handedToAdapter === true && dispatch.stage === 'handed-to-adapter' && dispatch.requestId
      && completeContextBaseline(manifest) ? manifest : previous?.epochId === epochId ? previous?.baselineProof ?? null : null,
    baselineId: dispatch?.handedToAdapter === true && dispatch.stage === 'handed-to-adapter' && dispatch.requestId
      && completeContextBaseline(manifest) ? manifest.baselineId : previous?.epochId === epochId ? previous?.baselineId ?? null : null,
    updatedAt: now,
  }
}

export function installContextDispatchObserver(bridge, { sessionId, member, onDispatch, expectation, maxAttempts = 3 }) {
  if (typeof bridge?.register !== 'function') return null
  // Every context message still in the conversation comes past here on every request. A receipt is confirmed once
  // per process; the durable side deduplicates only its most recent receipts, so re-confirming the old ones on each
  // request would write the control plane once per message per request.
  const confirmed = new Set()
  const failed = new Map()
  const inFlight = new Set()
  const persist = async (message, receipt, attempts = 1) => {
    const id = parseContextManifest(message).receiptId
    try {
      await onDispatch(message, receipt)
      confirmed.add(id)
      failed.delete(id)
    } catch (error) {
      confirmed.delete(id)
      failed.set(id, { message, receipt, attempts, error })
      throw error
    }
  }
  const project = (options) => {
    // The agent loop sets no purpose; only an auxiliary request names one.
    if (options?.sessionId !== sessionId || (options?.purpose !== undefined && options.purpose !== 'conversation')
      || bridge.isAgentLoopRequest(options) !== true) return undefined
    const candidates = (options.messages ?? []).flatMap(message => {
      const manifest = parseContextManifest(message)
      return manifest?.member === member && manifest?.sessionId === sessionId
        ? [{ receiptId: manifest.receiptId, bodyHash: hash(messageText(message)) }] : []
    })
    return { messages: options.messages, candidates }
  }
  const dispose = bridge.register('team-context:' + hash({ sessionId, member }).slice(0, 32), project, {
    order: 1000, preview: project,
    validateAdapter({ options, result }) {
      if (!result) return
      const expected = expectation?.()
      if (!expected) return
      const reject = () => { throw Object.assign(new Error('team-context-baseline-debt: current required source coverage or durable receipt unavailable'), { code: 'TEAM_CONTEXT_BASELINE_DEBT' }) }
      if (failed.size || inFlight.size || expected.unavailable) reject()
      const known = new Map(expected.known ?? [])
      for (const message of options.messages ?? []) {
        const manifest = parseContextManifest(message)
        if (manifest?.member !== member || manifest.sessionId !== sessionId || manifest.bindingHash !== expected.bindingHash
          || text(manifest.baselineId) !== text(expected.epochId)) continue
        if (!result.candidates.some(row => row.receiptId === manifest.receiptId && row.bodyHash === hash(messageText(message)))) continue
        for (const item of manifest.items) known.set(item.id, item.hash)
      }
      if (!(expected.required?.length) || expected.required.some(item => known.get(item.id) !== item.hash)) reject()
    },
    onDispatch({ options, receipt, result }) {
      if (!receipt?.handedToAdapter || receipt.stage !== 'handed-to-adapter' || !receipt.requestId) return
      const pending = []
      const expected = expectation?.()
      for (const message of options.messages ?? []) {
        const manifest = parseContextManifest(message)
        if (expected?.epochId && (manifest?.baselineId !== expected.epochId || manifest?.bindingHash !== expected.bindingHash)) continue
        if (manifest?.member === member && manifest?.sessionId === sessionId && !confirmed.has(manifest.receiptId) && !failed.has(manifest.receiptId)
          && result.candidates.some(candidate => candidate.receiptId === manifest.receiptId
            && candidate.bodyHash === hash(messageText(message)))) {
          confirmed.add(manifest.receiptId)
          const work = persist(message, receipt)
          inFlight.add(work)
          work.finally(() => inFlight.delete(work)).catch(() => {})
          pending.push(work)
        }
      }
      if (confirmed.size > 4096) confirmed.clear()
      return Promise.all(pending)
    },
  })
  dispose.flushPending = async () => {
    await Promise.allSettled([...inFlight])
    for (const row of [...failed.values()]) {
      if (row.attempts >= maxAttempts) throw row.error
      await persist(row.message, row.receipt, row.attempts + 1)
    }
  }
  return dispose
}

/**
 * Delta assembly has one total budget including headers and receipts. Nothing
 * is marked read here. The caller acknowledges a manifest only after commit.
 */
export function buildContextDelivery({
  sources = [],
  visible = [],
  acknowledged = [],
  member,
  sessionId,
  maxTokens = 12000,
  force = false,
  baselineId = null,
  bindingHash = null,
}) {
  const durable = force ? { versions: new Map(), compact: new Map() }
    : scanDurableContext(acknowledged, { member, sessionId, epochId: baselineId })
  const known = durable.versions
  const compactKnown = durable.compact
  if (!force && !baselineId) {
    const seen = scanVisibleContext(visible, { member, sessionId })
    for (const [id, version] of seen.versions) {
      known.set(id, version)
      if (seen.compact.has(id)) compactKnown.set(id, version)
      else compactKnown.delete(id)
    }
  }
  // A source last delivered in compact form is delivered again in full when the caller
  // marks it wantFull. That resend is best effort, never required: see add() and required.
  const changed = sources.map((source) => ({ ...source, hash: hash([source.revision, source.content]) }))
    .map((source) => (source.wantFull === true && known.get(source.id) === source.hash && compactKnown.get(source.id) === source.hash
      ? { ...source, refill: true } : source))
    .filter((source) => source.refill === true || known.get(source.id) !== source.hash)
    .sort((a, b) => Number(a.priority ?? 50) - Number(b.priority ?? 50) || text(a.id).localeCompare(text(b.id)))
  const requiredSources = sources.filter(source => source.required === true).map(source => ({ id: source.id, hash: hash([source.revision, source.content]) }))
  const sourceBinding = bindingHash ?? hash({ baselineId, required: requiredSources })
  const items = []
  const omitted = []
  // Build-local choice: sources delivered in their compact form. Hash, bindingHash
  // and requiredSources are computed from full content and never read this set.
  const compacted = new Set()
  const fullRow = (source) => '[' + source.id + '@' + source.revision + ']\n' + source.content
  const compactRow = (source) => '[' + source.id + '@' + source.revision + ' compact]\n' + source.compactContent
  const rowFor = (source) => (compacted.has(source) ? compactRow(source) : fullRow(source))
  const preparedStats = new WeakMap()
  for (const source of changed) {
    preparedStats.set(source, {
      line: tokenStats(fullRow(source)),
      ...(typeof source.compactContent === 'string' ? { compactLine: tokenStats(compactRow(source)) } : {}),
      debt: tokenStats('[context-debt] required source "' + source.id
        + '" was omitted by the context budget; read-before-act.'
        + (source.fetch ? ' fetch=' + JSON.stringify(source.fetch) : '')),
    })
  }
  const sourceLineStats = (source) => (compacted.has(source)
    ? preparedStats.get(source)?.compactLine ?? tokenStats(compactRow(source))
    : preparedStats.get(source)?.line ?? tokenStats(fullRow(source)))
  const sourceDebtStats = (source) => preparedStats.get(source)?.debt
    ?? tokenStats('[context-debt] required source "' + source.id
      + '" was omitted by the context budget; read-before-act.'
      + (source.fetch ? ' fetch=' + JSON.stringify(source.fetch) : ''))
  const manifestFor = (selected, debt = []) => ({
    version: 1, member, sessionId,
    receiptId: hash({
      baselineId: baselineId ?? null,
      bindingHash: baselineId ? sourceBinding : null,
      items: selected.map((source) => (compacted.has(source) ? [source.id, source.hash, 'compact'] : [source.id, source.hash])),
      debt: debt.map((source) => source.id),
    }).slice(0, 24),
    ...(baselineId ? { baselineId } : {}),
    ...(baselineId ? { bindingHash: sourceBinding, required: requiredSources } : {}),
    items: selected.map((source) => ({ id: source.id, hash: source.hash, revision: source.revision, ...source.metadata,
      ...(compacted.has(source) ? { form: 'compact' } : {}) })),
    ...(debt.length ? { debt: debt.map((source) => ({
      id: source.id,
      hash: source.hash,
      revision: source.revision,
      fetch: source.fetch ?? null,
    })) } : {}),
  })
  const render = (selected, debt = []) => {
    const manifest = manifestFor(selected, debt)
    const lines = selected.map(rowFor)
    for (const source of debt) {
      const fetch = source.fetch ? ' fetch=' + JSON.stringify(source.fetch) : ''
      lines.push('[context-debt] required source "' + source.id + '" was omitted by the context budget; read-before-act.'
        + fetch)
    }
    return { manifest, body: CONTEXT_MARKER + JSON.stringify(manifest) + '\n' + lines.join('\n\n') }
  }
  const renderStats = (selected, debt = []) => addTokenStats(
    tokenStats(CONTEXT_MARKER),
    tokenStats(JSON.stringify(manifestFor(selected, debt))),
    tokenStats('\n'),
    joinTokenStats([
      ...selected.map(sourceLineStats),
      ...debt.map(sourceDebtStats),
    ]),
  )
  const add = (source) => {
    const proposed = renderStats([...items, source])
    if (tokenCount(proposed) <= maxTokens) items.push(source)
    else omitted.push({
      id: source.id,
      hash: source.hash,
      revision: source.revision,
      required: source.required === true && source.refill !== true,
      estimatedTokens: estimateTokens(source.content),
      fetch: source.fetch ?? source.metadata?.fetch ?? null,
      safetyCritical: source.safetyCritical === true,
    })
  }
  const required = changed.filter((source) => source.required === true && source.refill !== true)
  const optional = changed.filter((source) => source.required !== true || source.refill === true)
  const admitRequired = () => {
    items.length = 0
    omitted.length = 0
    for (const source of required) add(source)
  }
  admitRequired()
  // Compact fallback runs only when a required source did not fit at full size.
  // Candidates are compacted least urgent first (higher compactRank, then higher
  // priority number, then reverse id). After each change every required source is
  // re-admitted in the original order, until all of them fit or no candidate is left.
  if (omitted.some((source) => source.required)) {
    const candidates = required
      .filter((source) => typeof source.compactContent === 'string' && source.safetyCritical !== true)
      .sort((a, b) => Number(b.compactRank ?? 0) - Number(a.compactRank ?? 0)
        || Number(b.priority ?? 50) - Number(a.priority ?? 50) || text(b.id).localeCompare(text(a.id)))
    for (const source of candidates) {
      compacted.add(source)
      admitRequired()
      if (!omitted.some((row) => row.required)) break
    }
  }
  // A missing required source must remain visible instead of being hidden by
  // lower-priority optional content that happens to fit.
  if (!omitted.some((source) => source.required)) {
    for (const source of optional) add(source)
  }
  const debt = omitted.filter((source) => source.required)
  const result = render(items, debt)
  return {
    ...result, body: items.length || debt.length ? result.body : '',
    estimatedTokens: items.length || debt.length ? estimateTokens(result.body) : 0,
    maxTokens, omitted, debtItems: debt,
    debt: debt.length > 0,
    failClosed: debt.some((source) => source.safetyCritical || baselineId),
    compacted: items.filter((source) => compacted.has(source)).map((source) => source.id),
  }
}

export function compactReceipt(exec, result, decision, mirrorError) {
  const value = result?.value
  const callId = text(exec?.callId ?? exec?.id)
  const ids = {}
  for (const key of ['id', 'taskId', 'revision', 'messageId', 'dispatchId', 'runId', 'evidenceId', 'roomId', 'roundId', 'status', 'merged', 'commit']) {
    if (typeof value?.[key] === 'string' || typeof value?.[key] === 'number' || typeof value?.[key] === 'boolean') ids[key] = value[key]
  }
  return {
    callId, rootCallId: text(exec?.rootCallId) || callId,
    sessionId: text(exec?.agent?.session?.id ?? exec?.agent?.id),
    tool: text(exec?.name ?? exec?.tool?.name),
    isError: result?.isError === true,
    projectionBlocked: decision?.kind === 'block',
    ids,
    mirrorStatus: mirrorError ? 'failed' : 'committed',
    error: text(mirrorError?.message ?? result?.error?.message).slice(0, 600) || null,
    retry: result?.isError === true ? 'query-effect-before-retrying' : 'do-not-repeat-successful-call',
    at: Date.now(),
  }
}
