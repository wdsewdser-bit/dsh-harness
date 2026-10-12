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

export function visibleContextVersions(messages) {
  const versions = new Map()
  for (const message of messages ?? []) {
    const manifest = parseContextManifest(message)
    if (!manifest) continue
    for (const item of manifest.items) versions.set(item.id, item.hash)
    for (const item of manifest.debt ?? []) {
      if (item?.id && item?.hash) versions.set(item.id, item.hash)
    }
  }
  return versions
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
export function durableContextVersions(receipts = [], { member, sessionId } = {}) {
  const versions = new Map()
  for (const row of receipts ?? []) {
    if (member !== undefined && text(row?.member) !== text(member)) continue
    if (sessionId !== undefined && text(row?.sessionId) !== text(sessionId)) continue
    for (const [id, version] of Object.entries(row?.versions ?? {})) {
      if (id && version) versions.set(text(id), text(version))
    }
    for (const item of Array.isArray(row?.items) ? row.items : []) {
      if (!item?.id || !item?.hash) continue
      versions.set(text(item.id), text(item.hash))
    }
    for (const item of Array.isArray(row?.debt) ? row.debt : []) {
      if (!item?.id || !item?.hash) continue
      versions.set(text(item.id), text(item.hash))
    }
  }
  return versions
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
}) {
  const known = force ? new Map() : durableContextVersions(acknowledged, { member, sessionId })
  if (!force) {
    for (const [id, version] of visibleContextVersions(visible)) known.set(id, version)
  }
  const changed = sources.map((source) => ({ ...source, hash: hash([source.revision, source.content]) }))
    .filter((source) => known.get(source.id) !== source.hash)
    .sort((a, b) => Number(a.priority ?? 50) - Number(b.priority ?? 50) || text(a.id).localeCompare(text(b.id)))
  const items = []
  const omitted = []
  const preparedStats = new WeakMap()
  for (const source of changed) {
    preparedStats.set(source, {
      line: tokenStats('[' + source.id + '@' + source.revision + ']\n' + source.content),
      debt: tokenStats('[context-debt] required source "' + source.id
        + '" was omitted by the context budget; read-before-act.'
        + (source.fetch ? ' fetch=' + JSON.stringify(source.fetch) : '')),
    })
  }
  const sourceLineStats = (source) => preparedStats.get(source)?.line
    ?? tokenStats('[' + source.id + '@' + source.revision + ']\n' + source.content)
  const sourceDebtStats = (source) => preparedStats.get(source)?.debt
    ?? tokenStats('[context-debt] required source "' + source.id
      + '" was omitted by the context budget; read-before-act.'
      + (source.fetch ? ' fetch=' + JSON.stringify(source.fetch) : ''))
  const manifestFor = (selected, debt = []) => ({
    version: 1, member, sessionId,
    receiptId: hash({
      baselineId: baselineId ?? null,
      items: selected.map((source) => [source.id, source.hash]),
      debt: debt.map((source) => source.id),
    }).slice(0, 24),
    ...(baselineId ? { baselineId } : {}),
    items: selected.map((source) => ({ id: source.id, hash: source.hash, revision: source.revision, ...source.metadata })),
    ...(debt.length ? { debt: debt.map((source) => ({
      id: source.id,
      hash: source.hash,
      revision: source.revision,
      fetch: source.fetch ?? null,
    })) } : {}),
  })
  const render = (selected, debt = []) => {
    const manifest = manifestFor(selected, debt)
    const lines = selected.map((source) => '[' + source.id + '@' + source.revision + ']\n' + source.content)
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
      required: source.required === true,
      estimatedTokens: estimateTokens(source.content),
      fetch: source.fetch ?? source.metadata?.fetch ?? null,
      safetyCritical: source.safetyCritical === true,
    })
  }
  const required = changed.filter((source) => source.required === true)
  const optional = changed.filter((source) => source.required !== true)
  for (const source of required) add(source)
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
    failClosed: debt.some((source) => source.safetyCritical),
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
