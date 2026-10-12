/**
 * Agent Team v12 runtime bridge.
 *
 * HMR activation marker: 2026-09-28T15:30+08:00 perf67-query-status-input-form.
 * Performance marker: perf57-readonly-room-view+perf59-board-index.
 * This plugin deliberately sits beside the existing r10 tool layer instead of
 * forking it. The old tools remain the model-facing workflow; pre/post hooks
 * mirror their durable effects into the v12 contracts, ledgers and state
 * machines. The aggregate `team_v12` tool exposes read-only diagnostics and the
 * few explicit recovery actions that do not belong in the normal work path.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as controlPlane from './team-control-plane.mjs'
import * as teamPolicy from './team-policy.mjs'
console.warn('[team-v12-runtime] HMR perf67-query-status-input-form+merge-receipt-scope loaded 2026-09-28')
const { teamKeyOf } = teamPolicy
const controlPlaneForMember = controlPlane.controlPlaneForMember ?? ((ctx, agent, config) =>
  controlPlane.controlPlaneFor(teamKeyOf(ctx, agent), config))
import { activeTask, buildContextDelivery, compactReceipt, durableContextVersions, identitySource, messageText, nativeMessageIds, parseContextManifest, taskContext } from './team-v14-context-delivery.mjs'
import { deriveWaitingTickets, normalizeWaitingCondition, projectWaitingTickets, recordWaiting, resolveWaiting, waitingTicketActive } from './team-v14-waiting.mjs'
import { actionFailureSummary, actionFingerprint, clearActionByFingerprint } from './team-v13-failure-memory.mjs'
import {
  LIFECYCLE_STATES,
  contractDigest,
  evaluateReadyGate,
  migrateTaskContract,
  normalizeTaskContract,
  transitionTaskLifecycle,
  validateTaskContract,
} from './team-v12-contract.mjs'
import {
  applyStateMigration,
  auditConsistencyResult,
  compareStateSnapshots,
  planStateMigration,
  planStateRecovery,
  readStateSnapshot,
  validateStateSchema,
} from './team-v12-persistence.mjs'
import {
  advanceRoomCursor,
  buildRoomRecoverySnapshot,
  canReadRoom,
  confirmDecision,
  deliverWakeBatch,
  effectiveDecisions,
  enqueueInboxMessage,
  evaluateStopEpisode,
  handleInboxMessage,
  handleWakeBatch,
  markWakeInjected,
  migrateLegacyRoomState,
  normalizeRoomWakeState,
  pendingDecisionConfirmations,
  proposeDecision,
  rememberAcknowledgedInbox,
  requestWake,
  recordDeliveredInboxMessage,
  recordRoomInjection,
  resolveUnresolved,
  roomIds,
  retryWake,
} from './team-v12-room-wake.mjs'
import {
  buildRequirementSnapshot,
  contextRequirementSnapshot,
  createRequirementLedger,
  diffRequirements,
  recordDecision,
  recordRequirement,
} from './team-v14-requirements.mjs'
import {
  buildCompactionResumeContext,
  completeCompaction,
  doneMilestone,
  failCompaction,
  markHandoffReady,
  normalizeCompactionState,
  retryCompaction,
  setMilestone,
  startCompaction,
  transitionCompaction,
  waitForHandoff,
} from './team-v12-compaction.mjs'
import {
  buildContextPack,
  contentHash,
  estimateTokens,
  renderContextPack,
} from './team-v12-context.mjs'
import {
  buildAcceptanceMatrix,
  buildReadyQueue,
  buildReviewPackage,
  buildSchedulerAdvice,
  buildVerificationPlan,
  classifyStall,
  costGuard,
  createEvidenceRegistry,
  checkFanOut,
  estimateTaskEffort,
  invalidateEvidence,
  projectLeasesForMember,
  queryEvidence,
  recipeFingerprint,
  registerEvidence,
  resolveEvidenceId,
  reuseEvidenceForPlan,
  selectVerificationRecipe,
} from './team-v12-evidence-scheduler.mjs'
import {
  buildCapabilityMatrix,
  collectRuntimeFacts,
  diffCapabilityMatrices,
  evaluateUpgradeGate,
  hashEntry,
} from './team-v12-runtime-facts.mjs'
import {
  createObservationEvent,
  locateObservationBreakpoint,
  queryTimeline,
} from './team-v12-observability.mjs'
import {
  runReplay,
} from './team-v12-replay.mjs'

export const name = 'team-v12-runtime'
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'loader']

const VOLATILE_PTC_RECEIPT_LIMIT = 500
const volatilePtcReceipts = []

function rememberVolatilePtcReceipt(row) {
  volatilePtcReceipts.push(row)
  if (volatilePtcReceipts.length > VOLATILE_PTC_RECEIPT_LIMIT) {
    volatilePtcReceipts.splice(0, volatilePtcReceipts.length - VOLATILE_PTC_RECEIPT_LIMIT)
  }
}

const V12_POLICY = 'Agent Team v14 is active through team_v12. Dynamic requirements and Room/inbox deltas are appended after the stable prompt. info is silent; action/decision and team_wake queue only the target, never interrupt its current turn. Use inbox_list then inbox_ack with the exact wake_id after handling, not merely reading. Before stopping for a task, use waiting_set with task_id and input {reason,unblockCondition,responsible}; waiting_resolve explicitly clears it. waiting_list shows responsibility and accepts input {includeClosed:true} with closurePolicy and closedReason. ptc_receipts can query input {rootCallId,callId}: a failed PTC script or blocked output does not roll back successful child calls. Query effects before retrying. After compaction reread your assigned task, current requirements, decisions and unresolved items, not platform implementation documents. done queues mandatory idle compaction; a following set must not cancel it.'

const V12_DOC_PATH = 'D:/dsh-test/docs/agent-team-v12-architecture-improvement-plan.md'
const V12_LEDGER_PATH = 'D:/dsh-test/docs/agent-team-v12-implementation-ledger.md'
const V12_ACTION_CAPABILITIES = Object.freeze({
  runtime_facts: 'runtime.facts',
  capability_matrix: 'capability.matrix',
  upgrade_gate: 'upgrade.gate',
  task_contract_get: 'task.contract.read',
  task_contract_set: 'task.contract.write',
  ready_queue: 'scheduler.ready-queue',
  scheduler_advice: 'scheduler.advice',
  leases: 'scheduler.leases.read',
  control_status: 'control.persistence.status',
  control_recover: 'control.persistence.recover',
  room_snapshot: 'room.snapshot',
  room_confirm_decision: 'room.decision.confirm',
  room_migrate: 'room.migrate',
  room_cursor: 'room.cursor',
  requirements_snapshot: 'requirements.snapshot',
  requirements_diff: 'requirements.diff',
  requirement_record: 'requirements.record',
  decision_record: 'decisions.record',
  waiting_set: 'scheduler.waiting.record',
  waiting_resolve: 'scheduler.waiting.resolve',
  waiting_list: 'scheduler.waiting.read',
  failure_memory_status: 'failure.memory.read',
  failure_memory_clear: 'failure.memory.clear',
  ptc_receipts: 'ptc.receipts.read',
  inbox_list: 'wake.inbox.read',
  inbox_ack: 'wake.inbox.ack',
  compaction_status: 'compaction.status',
  compaction_transition: 'compaction.transition',
  evidence_query: 'evidence.query',
  review_package: 'evidence.review-package',
  verification_plan: 'evidence.verification-plan',
  merge_status: 'integration.status',
  merge_recover: 'integration.recover',
  context_pack: 'context.pack',
  timeline: 'observability.timeline',
  replay: 'replay.run',
})

function text(value) {
  return String(value ?? '').trim()
}

/**
 * Derive only a bounded model-visible tail. Full `deriveMessages()` copies the
 * entire session history per pre-step and is a major allocation source for long
 * Team sessions; repair and dedupe only need recent committed messages.
 */
function recentDerivedMessages(session, limit = 512) {
  try {
    const nodes = session?.surface?.nodes
    if (nodes === undefined || nodes === null) return session?.deriveMessages?.() ?? []
    const list = Array.isArray(nodes) ? nodes : Array.from(nodes)
    const start = Math.max(0, list.length - Math.max(1, Number(limit) || 512))
    const messages = []
    for (let index = start; index < list.length; index += 1) {
      const event = session.eventAt?.(list[index])
      if (event === undefined) continue
      const message = session.deriveEventMessage?.(event)
      if (message !== null && message !== undefined) messages.push(message)
    }
    return messages
  } catch {
    return session?.deriveMessages?.() ?? []
  }
}

const messageTokenCache = new WeakMap()

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 1
  let total = 2
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    let tokens
    const content = message?.content
    const contentLength = Array.isArray(content) ? content.length : undefined
    const cached = message !== null && typeof message === 'object' ? messageTokenCache.get(message) : undefined
    if (cached !== undefined
      && cached.content === content
      && cached.contentLength === contentLength
      && cached.role === message.role
      && cached.toolCallId === message.toolCallId) {
      tokens = cached.tokens
    }
    if (tokens === undefined) {
      tokens = estimateTokens(JSON.stringify(message))
      if (message !== null && typeof message === 'object') {
        messageTokenCache.set(message, { tokens, content, contentLength, role: message.role, toolCallId: message.toolCallId })
      }
    }
    total += tokens + (index === 0 ? 0 : 1)
  }
  return Math.max(1, total)
}

function jsonOutput(schema) {
  return { schema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
}

function loaderEntryPath(entry, pluginDir) {
  const name = text(entry?.options?.name)
  if (name.startsWith('file:')) {
    try { return fileURLToPath(name) } catch { return null }
  }
  if (name.startsWith('./') || name.startsWith('../')) return resolve(pluginDir, name)
  return null
}

export function runtimeObservation(ctx, pluginDir) {
  const entries = [...(ctx.loader?.entries?.() ?? [])]
  return {
    complete: entries.length > 0,
    degradedReasons: entries.length > 0 ? [] : ['loader observation is unavailable'],
    plugins: entries.map((entry) => {
      const id = text(entry?.options?.id)
      const entryPath = loaderEntryPath(entry, pluginDir)
      return {
        id: id || entryPath || 'unknown',
        name: id || undefined,
        enabled: entry?.disabled !== true && entry?.fiber?.state === 2,
        installed: true,
        entryPath,
        source: 'dsh-loader',
        stateOwner: 'dsh-loader',
        schemaVersion: null,
        patch: entry?.options?.patch ?? null,
        config: entry?.options?.config,
      }
    }).filter((row) => row.id !== 'unknown'),
  }
}

export function diskObservation(pluginDir) {
  let names = []
  try {
    names = readdirSync(pluginDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === '.mjs')
      .map((entry) => entry.name)
  } catch {
    return { complete: false, degradedReasons: ['plugin directory is unreadable'], plugins: [] }
  }
  return {
    complete: true,
    plugins: names.map((name) => ({
      id: basename(name, '.mjs'),
      name,
      enabled: true,
      installed: true,
      entryPath: join(pluginDir, name),
      source: 'local-plugin-directory',
      stateOwner: null,
      schemaVersion: null,
      patch: null,
    })),
  }
}

function collectCurrentRuntimeFacts(ctx, config, supplied = {}) {
  return collectRuntimeFacts({
    ...supplied,
    observedAt: supplied.observedAt ?? Date.now(),
    instance: supplied.instance ?? {
      pid: process.pid,
      startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    },
    // These are optional observation layers. Supplying an explicit empty layer
    // records "nothing documented/session-scoped was observed" without turning
    // every default runtime_facts read into a degraded collection.
    documented: supplied.documented ?? [],
    disk: supplied.disk ?? diskObservation(config.pluginDir),
    runtime: supplied.runtime ?? runtimeObservation(ctx, config.pluginDir),
    session: supplied.session ?? [],
    dsh: {
      profile: config.profile ?? 'web',
      ...(supplied.dsh ?? {}),
    },
    baseDir: config.pluginDir,
  })
}

function capabilityProfilesFromRuntimeFacts(report) {
  const profileId = text(report?.dsh?.profile) || 'unknown'
  const plugin = report?.plugins?.['team-v12-runtime'] ?? report?.plugins?.['team-v12'] ?? {}
  const runtime = plugin?.runtime ?? plugin?.disk ?? {}
  const observedEntry = runtime?.entry ?? hashEntry(fileURLToPath(import.meta.url))
  const capabilities = ['team.v12', ...Object.values(V12_ACTION_CAPABILITIES)]
  return {
    [profileId]: {
      id: profileId,
      pluginId: 'team-v12-runtime',
      pluginVersion: runtime?.version ?? null,
      entry: observedEntry?.path ?? null,
      entryHash: observedEntry?.sha256 ?? null,
      installed: true,
      enabled: true,
      declaredCapabilities: capabilities,
      callableCapabilities: capabilities,
      tools: [{
        name: 'team_v12',
        capability: 'team.v12',
        callable: true,
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: Object.keys(V12_ACTION_CAPABILITIES) },
          },
          additionalProperties: true,
        },
      }],
      persistenceSchemas: {
        'team.control-plane': { version: 2 },
      },
      semantics: {
        'team.v12': {
          mode: 'aggregate',
          stateOwner: 'local-control-plane',
          wake: 'queued-next-turn',
        },
      },
      contractResults: {},
      runtimeReachable: true,
    },
  }
}

const RUNTIME_FACT_ENTRY_NOISE_CODES = new Set([
  'patch-source-unknown',
  'entry-path-mismatch',
  'entry-hash-mismatch',
  'evidence-missing',
  'schema-unknown',
  'state-owner-unknown',
])

export function compactRuntimeFacts(report, requestedIds = []) {
  const requested = new Set(Array.isArray(requestedIds) ? requestedIds.map(text).filter(Boolean) : [])
  const pluginIds = Object.keys(report.plugins ?? {})
  const differences = Array.isArray(report.differences) ? report.differences : []
  const differencesFor = (id) => differences.filter((item) => item.pluginId === id)
  const omittedNoise = (id) => {
    const codes = differencesFor(id).map((item) => item.code)
    return codes.length > 0 && codes.every((code) => RUNTIME_FACT_ENTRY_NOISE_CODES.has(code))
  }
  const selected = requested.size > 0
    ? pluginIds.filter((id) => requested.has(id))
    : pluginIds.filter((id) => differencesFor(id).length > 0 && !omittedNoise(id))
  return {
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    collectedAt: report.collectedAt,
    instance: report.instance,
    dsh: report.dsh,
    collection: report.collection,
    totalPlugins: pluginIds.length,
    includedPlugins: selected.length,
    omittedPlugins: pluginIds.length - selected.length,
    omittedNoisePlugins: pluginIds.filter(omittedNoise).length,
    omittedUnobservedRuntimeEntries: pluginIds.filter(omittedNoise).length,
    plugins: Object.fromEntries(selected.map((id) => {
      const row = report.plugins[id]
      return [id, {
        enabled: row?.runtime?.enabled ?? row?.disk?.enabled ?? null,
        runtimeEntry: row?.runtime?.entry ?? null,
        diskEntry: row?.disk?.entry ?? null,
        differences: differencesFor(id).map((item) => ({
          code: item.code,
          severity: item.severity,
        })),
      }]
    })),
    diffSummary: report.diffSummary,
  }
}

function refuse(code, detail) {
  const error = new Error(code + (detail ? ': ' + String(detail) : ''))
  error.code = code
  throw error
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function readStateFileDiagnostic(path) {
  try {
    return readStateSnapshot(readFileSync(path, 'utf8'))
  } catch (error) {
    return readStateSnapshot({ error })
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

function membershipFor(ctx, agent) {
  try {
    const member = ctx.agentTeams.tryMembership(agent)
    if (!member) return undefined
    const policy = teamPolicy.policyFor?.(teamKeyOf(ctx, agent))
    const record = policy?.get?.(member.name)
    return { ...member, ...record, tier: Number(record?.tier ?? member.tier ?? member.level ?? (member.role === 'lead' ? 0 : 2)) }
  } catch {
    return undefined
  }
}

function controlFor(ctx, agent, config) {
  const control = controlPlaneForMember(ctx, agent, { directory: config.controlDir })
  if (!control) refuse('team-context', 'no Team root identity is available')
  return control
}

function boardTasks(snapshot) {
  return Object.values(snapshot?.boards ?? {})
    .flatMap((board) => Object.values(board?.tasks ?? {}))
}

function taskOccurrences(snapshot, taskId) {
  return Object.entries(snapshot?.boards ?? {}).flatMap(([boardId, board]) =>
    Object.values(board?.tasks ?? {})
      .filter((task) => String(task?.id) === String(taskId))
      .map((task) => ({ task, boardId })))
}

/**
 * Resolve one task to its real board. A global projection may contain a copy of
 * a group card, so the non-global occurrence wins unless the caller names a
 * board explicitly.
 */
export function selectTaskOccurrence(snapshot, taskId, requestedBoard = '', actor = {}) {
  const rows = taskOccurrences(snapshot, taskId)
  if (rows.length === 0) return { ok: false, code: 'task-not-found', detail: text(taskId) }
  const rawRequested = text(requestedBoard)
  const requested = rawRequested === 'group'
    ? 'group-' + text(actor.group)
    : rawRequested === 'level' ? 'level-' + text(actor.tier) : rawRequested
  if (requested.length > 0) {
    const exact = rows.find((row) => row.boardId === requested)
    if (exact !== undefined) return { ok: true, ...exact, requestedBoard: requested }
    return {
      ok: false,
      code: 'waiting-board-not-found',
      detail: 'task "' + text(taskId) + '" is not on requested board "' + requested
        + '"; available boards=' + JSON.stringify([...new Set(rows.map((row) => row.boardId))]),
    }
  }
  const selected = rows.find((row) => text(row.task?.board) === row.boardId && row.boardId !== 'global')
    ?? rows.find((row) => row.boardId !== 'global')
    ?? rows[0]
  return { ok: true, ...selected, requestedBoard: null }
}

function findTask(snapshot, taskId) {
  return selectTaskOccurrence(snapshot, taskId).task
}

function allEvidence(snapshot) {
  return Object.values(snapshot?.evidence ?? {})
}

/**
 * Evidence is append-only and has no board scope of its own. A member may
 * always read rows they recorded; task/board visibility remains the fallback
 * for rows written before `recordedBy` existed or by another member. Landing
 * tokens are the authorization anchor for clearance, so the independent
 * verifier receives a narrow read-only projection of those rows even though
 * they are global and unscoped.
 */
export function filterVisibleEvidence(rows, options = {}) {
  const tier = Number(options.tier)
  const mine = options.mine
  const canReadTask = options.canReadTask
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (tier === 0) return true
    if (mine?.name !== undefined && String(row?.recordedBy ?? '') === String(mine.name)) return true
    const verifier = String(mine?.group ?? '').toLowerCase() === 'verifier'
      || String(mine?.role ?? '').toLowerCase() === 'verifier'
    const kind = String(row?.kind ?? '').toLowerCase()
    const classification = String(row?.classification ?? '').toLowerCase()
    if (verifier && (
      kind === 'landing-token'
      || kind === 'landing-token-confirmation'
      || classification === 'landing-token'
      || classification === 'token-confirmation'
    )) return true
    return typeof canReadTask === 'function' && canReadTask(row) === true
  })
}

export function describeGateUnavailable(tool, args, stage, error) {
  const action = String(args?.action ?? args?.phase ?? 'pre-execute')
  const taskId = String(args?.task_id ?? args?.taskId ?? 'none')
  return 'gate=' + String(tool) + '/' + action
    + '; read=' + String(stage)
    + '; task=' + taskId
    + '; state=unavailable'
    + '; cause=' + String(error?.message ?? error)
}

export function withReceiptNotice(downstream, result, text) {
  const base = Array.isArray(downstream?.content)
    ? downstream.content
    : Array.isArray(result?.content) ? result.content : []
  return {
    ...downstream,
    content: [...base, { type: 'text', text }],
  }
}

/**
 * Build the model-facing evidence-query envelope. Keeping id resolution and
 * visibility in one pure function makes the distinction between malformed,
 * missing, unique-prefix and ambiguous ids testable at the tool boundary.
 */
export function evidenceQueryEnvelope({
  requestedId = '',
  requestedField = null,
  resolved = null,
  rows = [],
  total = 0,
  visible = 0,
  tier = 0,
  queryKey = null,
  queryFormed = false,
  queryFormation = null,
  scopeDeclaration = null,
} = {}) {
  const idResolution = resolved === null ? null : { ...resolved }
  const resolvedForm = idResolution?.form ?? null
  const inputForm = evidenceIdInputForm(requestedId)
  const declaredScope = scopeDeclaration === null
    ? {
        mode: Number(tier) === 0 ? 'all-authors' : 'reader-or-readable-task',
        reader: null,
        visibleAuthors: [],
        registryRevision: null,
        stability: null,
        resolutionPolicy: null,
      }
    : { ...scopeDeclaration }
  if (idResolution !== null) {
    delete idResolution.rows
    idResolution.inputForm = inputForm
    idResolution.resolvedForm = resolvedForm
    idResolution.form = inputForm
    idResolution.scope = declaredScope
    if (idResolution.status === 'not-found') {
      idResolution.notFoundMeaning = 'not-visible-in-declared-scope'
    }
  }
  const effectiveFormation = queryFormation === null ? null : queryFormation
  const effectiveQueryKey = requestedId.length === 0
    ? effectiveFormation?.queryKey ?? queryKey
    : {
        field: requestedField ?? 'id',
        value: requestedId,
        form: inputForm,
        accepted: idResolution?.accepted ?? null,
      }
  const rejected = idResolution?.accepted === false
  const requestedKeys = Array.isArray(effectiveFormation?.requestedKeys)
    ? effectiveFormation.requestedKeys
    : effectiveQueryKey === null ? [] : [effectiveQueryKey.field]
  const acceptedKeys = Array.isArray(effectiveFormation?.acceptedKeys)
    ? effectiveFormation.acceptedKeys
    : effectiveQueryKey === null ? [] : [effectiveQueryKey.field]
  const ignoredKeys = Array.isArray(effectiveFormation?.ignoredKeys)
    ? effectiveFormation.ignoredKeys
    : []
  const effectiveQueryFormed = !rejected
    && (requestedId.length > 0
      || effectiveFormation?.queryStatus === 'formed'
      || effectiveFormation?.queryStatus === 'partial'
      || queryFormed
      || effectiveQueryKey !== null)
  const queryStatus = rejected
    ? 'rejected'
    : requestedId.length > 0
      ? ignoredKeys.length > 0 ? 'partial' : 'formed'
      : effectiveFormation?.queryStatus ?? (effectiveQueryFormed ? 'formed' : 'not-formed')
  return {
    rows,
    ...(idResolution === null ? {} : { idResolution }),
    ...(idResolution?.formRejected === undefined ? {} : { formRejected: idResolution.formRejected }),
    visibility: {
      scope: Number(tier) === 0 ? 'global' : 'member',
      scopeBasis: declaredScope.mode,
      reader: declaredScope.reader ?? null,
      visibleAuthors: declaredScope.visibleAuthors ?? [],
      registryRevision: declaredScope.registryRevision ?? null,
      projectionStability: declaredScope.stability ?? null,
      resolutionPolicy: declaredScope.resolutionPolicy ?? null,
      total: Number(total ?? 0),
      visible: Number(visible ?? 0),
      matched: Array.isArray(rows) ? rows.length : 0,
      filtered: Number(total ?? 0) !== Number(visible ?? 0),
      queryKey: effectiveQueryKey,
      requestedKeys,
      acceptedKeys,
      ignoredKeys,
      queryFormed: effectiveQueryFormed,
      queryStatus,
      queryDetail: effectiveFormation?.detail ?? null,
      idStatus: idResolution?.status ?? null,
      notFoundMeaning: idResolution?.notFoundMeaning ?? null,
      candidateCount: idResolution?.candidateCount ?? null,
      resolvedForm,
    },
  }
}

/** Classify only the caller-provided id string; never the server-side lookup result. */
export function evidenceIdInputForm(rawId) {
  const requested = text(rawId)
  if (requested.length === 0) return 'none'
  if (/^(?:evidence-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)) {
    return 'full-id'
  }
  if (/^(?:evidence-)?[0-9a-f]{4,36}(?:-[0-9a-f]{1,12}){0,4}$/i.test(requested)) return 'prefix'
  return 'invalid'
}

/** Identify the first-class evidence filters that form a real query. */
export function evidenceQueryKey(input = {}) {
  const fields = [
    ['taskId', input.taskId ?? input.task_id],
    ['commitSha', input.commitSha ?? input.commit_sha],
    ['requirementId', input.requirementId ?? input.requirement_id],
    ['recipeId', input.recipeId ?? input.recipe_id],
    ['recipeFingerprint', input.recipeFingerprint ?? input.recipe_fingerprint],
    ['treeHash', input.treeHash ?? input.tree_hash],
    ['status', input.status],
    ['kind', input.kind],
  ]
  const found = fields.find(([, value]) => text(value).length > 0)
  if (found !== undefined) return { field: found[0], value: found[1], form: 'filter', accepted: true }
  if (input.exact === true) return { field: 'exact', value: true, form: 'exact', accepted: true }
  return null
}

/** Report both effective filters and caller-supplied filters that did not apply. */
export function evidenceQueryFormation(input = {}) {
  const fields = [
    ['taskId', 'task_id'],
    ['commitSha', 'commit_sha'],
    ['requirementId', 'requirement_id'],
    ['recipeId', 'recipe_id'],
    ['recipeFingerprint', 'recipe_fingerprint'],
    ['treeHash', 'tree_hash'],
    ['status', null],
    ['kind', null],
    ['exact', null],
  ]
  const requested = []
  const accepted = []
  for (const [field, alias] of fields) {
    const hasField = Object.prototype.hasOwnProperty.call(input, field)
    const hasAlias = alias !== null && Object.prototype.hasOwnProperty.call(input, alias)
    if (!hasField && !hasAlias) continue
    requested.push(field)
    const value = hasField ? input[field] : input[alias]
    const applies = field === 'exact' ? value === true : text(value).length > 0
    if (applies) accepted.push({ field, value, form: field === 'exact' ? 'exact' : 'filter' })
  }
  const acceptedKeys = accepted.map((row) => row.field)
  const ignoredKeys = requested.filter((field) => !acceptedKeys.includes(field))
  const queryKey = accepted.length === 0
    ? null
    : { ...accepted[0], accepted: true }
  const queryStatus = accepted.length > 0 && ignoredKeys.length === 0
    ? 'formed'
    : accepted.length > 0 ? 'partial'
      : ignoredKeys.length > 0 ? 'rejected' : 'not-formed'
  return {
    requestedKeys: requested,
    acceptedKeys,
    ignoredKeys,
    queryKey,
    queryStatus,
    detail: ignoredKeys.length === 0
      ? null
      : 'ignored filter keys: ' + ignoredKeys.join(', '),
  }
}

function v12RoomState(snapshot, options = {}) {
  // normalizeRoomWakeState mutates its input. Copy only this bounded document
  // so callers can safely read the shared hot control-plane view.
  const doc = normalizeRoomWakeState(structuredClone(snapshot?.v12RoomWake ?? {}))
  const legacyRooms = snapshot?.rooms && typeof snapshot.rooms === 'object' && !Array.isArray(snapshot.rooms)
    ? snapshot.rooms
    : {}
  const canonicalRooms = doc.rooms && typeof doc.rooms === 'object' ? doc.rooms : {}
  const sourceRooms = { ...legacyRooms, ...canonicalRooms }
  const legacyRounds = snapshot?.rounds && typeof snapshot.rounds === 'object' && !Array.isArray(snapshot.rounds)
    ? snapshot.rounds
    : {}
  if (Object.keys(sourceRooms).length > 0) {
    // The legacy payload is only a migration source. Keeping it in the v12
    // hot document would duplicate every transcript and defeat cold storage.
    doc.rooms = sourceRooms
    doc.rounds = legacyRounds
    if (options.migrate !== false) migrateLegacyRoomState(doc)
    if (options.keepLegacySource !== true) delete doc.rooms
    delete doc.rounds
  }
  return doc
}

/**
 * Read-only Room view for hot context assembly. Normalization mutates only the
 * top-level wake document, wake rows and inbox rows, so copy those containers
 * shallowly instead of structured-cloning multi-megabyte projections such as
 * roomInjections and roundSummaries. Legacy room payloads keep the full clone
 * path because migration can mutate nested Room records.
 */
function v12RoomStateView(snapshot, options = {}) {
  const legacyRooms = snapshot?.rooms
  if (legacyRooms !== null && typeof legacyRooms === 'object' && !Array.isArray(legacyRooms)
    && Object.keys(legacyRooms).length > 0) {
    return v12RoomState(snapshot, options)
  }
  const wake = snapshot?.v12RoomWake
  if (wake === null || typeof wake !== 'object' || Array.isArray(wake)) {
    return v12RoomState(snapshot, options)
  }
  const copyRow = (row) => row !== null && typeof row === 'object' && !Array.isArray(row)
    ? { ...row }
    : row
  const copyWake = (row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
    return {
      ...row,
      ...(Array.isArray(row.messageIds) ? { messageIds: [...row.messageIds] } : {}),
      ...(Array.isArray(row.dedupeKeys) ? { dedupeKeys: [...row.dedupeKeys] } : {}),
      ...(Array.isArray(row.reasons) ? { reasons: [...row.reasons] } : {}),
    }
  }
  const draft = {
    ...wake,
    inbox: Object.fromEntries(Object.entries(wake.inbox ?? {}).map(([key, row]) => [key, copyRow(row)])),
    wakes: Object.fromEntries(Object.entries(wake.wakes ?? {}).map(([key, row]) => [key, copyWake(row)])),
  }
  return normalizeRoomWakeState(draft)
}

function withRoomTails(snapshot) {
  const tails = snapshot?.roomTails
  const transcriptTails = snapshot?.roomTranscriptTails
  const hasTails = tails !== null && typeof tails === 'object' && !Array.isArray(tails)
  const hasTranscriptTails = transcriptTails !== null && typeof transcriptTails === 'object' && !Array.isArray(transcriptTails)
  if (!hasTails && !hasTranscriptTails) return snapshot
  const next = {
    ...snapshot,
    rooms: snapshot.rooms !== null && typeof snapshot.rooms === 'object' && !Array.isArray(snapshot.rooms)
      ? { ...snapshot.rooms }
      : {},
    v12RoomWake: snapshot.v12RoomWake !== null && typeof snapshot.v12RoomWake === 'object'
      ? { ...snapshot.v12RoomWake }
      : {},
  }
  const rooms = next.rooms
  const wake = next.v12RoomWake
  wake.transcripts = wake.transcripts !== null && typeof wake.transcripts === 'object' && !Array.isArray(wake.transcripts)
    ? { ...wake.transcripts }
    : {}
  const roomIds = new Set([
    ...Object.keys(hasTails ? tails : {}),
    ...Object.keys(hasTranscriptTails ? transcriptTails : {}),
  ])
  for (const roomId of roomIds) {
    const messages = Array.isArray(tails?.[roomId]) && tails[roomId].length > 0
      ? tails[roomId]
      : Array.isArray(transcriptTails?.[roomId]) ? transcriptTails[roomId] : []
    if (!Array.isArray(messages) || messages.length === 0) continue
    const room = rooms[roomId] ?? { roomId, status: 'open', members: [], messages: [] }
    rooms[roomId] = { ...room, messages }
    wake.transcripts[roomId] = messages
  }
  return next
}

function roomTailsCoverContext(snapshot, memberName) {
  const doc = v12RoomStateView(snapshot)
  for (const roomId of roomIds(doc)) {
    if (!canReadRoom(doc, roomId, memberName)) continue
    const room = snapshot.rooms?.[roomId]
    if (room?.lastMessageAt > 0 && (!Array.isArray(snapshot.roomTails?.[roomId]) || snapshot.roomTails[roomId].length === 0)) return false
    const tail = Array.isArray(snapshot.roomTails?.[roomId]) ? snapshot.roomTails[roomId] : []
    const first = tail.length === 0 ? 0 : Number(tail[0]?.sequence ?? 0)
    const cursor = Number(doc.cursors?.[roomId]?.[memberName]?.sequence ?? 0)
    if (tail.length > 0 && cursor > 0 && first > cursor + 1) return false
  }
  return true
}

function v12RequirementsState(snapshot) {
  return createRequirementLedger(snapshot?.v12Requirements ?? {})
}

function taskAcceptance(contract) {
  const rows = Array.isArray(contract?.acceptanceCriteria) ? contract.acceptanceCriteria : []
  return rows.map((row) => typeof row === 'string' ? row.trim() : (JSON.stringify(row) ?? ''))
    .filter((row) => row.length > 0)
}

/**
 * Task acceptance requirements are execution context, not board-readable
 * gossip. A task owner, its group lead, the verifier, and tier 0 may receive
 * them; an unrelated group member may not.
 */
export function taskRequirementVisibleTo(task, member, boardId, canReadBoard = () => false) {
  if (!task || !member) return false
  const tier = Number(member.tier)
  if (tier === 0) return true
  const owner = text(task.ownerName ?? task.contract?.owner)
  if (owner.length > 0 && owner === text(member.name)) return true
  if (text(member.group) === 'verifier' && canReadBoard(member.name, boardId) === true) return true
  return tier === 1
    && String(boardId ?? '') === 'group-' + text(member.group)
    && canReadBoard(member.name, boardId) === true
}

function contextSummary(value, max = 240) {
  const valueText = text(value)
  return valueText.length <= max ? valueText : valueText.slice(0, Math.max(0, max - 3)) + '...'
}

function mirrorTaskRequirement(state, taskId, contract, source = 'task-contract') {
  const acceptance = taskAcceptance(contract)
  if (acceptance.length === 0) return { ok: true, skipped: true }
  const ledger = v12RequirementsState(state)
  const result = recordRequirement(ledger, {
    requirementId: 'task:' + String(taskId) + ':acceptance',
    text: acceptance.join('\n'),
    quote: acceptance.join('\n'),
    taskIds: [String(taskId)],
    acceptance,
    source,
  })
  state.v12Requirements = ledger
  return result
}

function v12CompactionState(snapshot) {
  return normalizeCompactionState(snapshot?.v12Compaction ?? {})
}

function v12EvidenceState(snapshot) {
  return snapshot?.v12Evidence ?? { version: 1, records: {} }
}

function v12MergeState(snapshot) {
  return snapshot?.v12MergeOperations ?? { version: 1, operations: {} }
}

function v12EventState(snapshot) {
  return Array.isArray(snapshot?.v12Events) ? snapshot.v12Events : []
}

function makeObservation(actor, type, data, stage = 'observed') {
  return createObservationEvent({
    ...data,
    eventType: type,
    stage,
    correlationId: text(data?.correlationId) || text(data?.callId) || actor + ':' + type,
    causationId: text(data?.causationId) || null,
    actor,
    tool: type,
  })
}

function successfulToolValue(result, decision) {
  // Post-tool policy controls presentation, not the already committed effect.
  if (result?.isError === true || result?.kind === 'error') return undefined
  return result?.value
}

const READ_TOOLS = new Set(['list_agents', 'list_frozen_agents', 'team_task_get', 'team_task_list', 'team_plan_get', 'team_room_read', 'team_room_list', 'team_delivery_check'])
const V12_READ_ACTIONS = new Set(['runtime_facts', 'capability_matrix', 'upgrade_gate', 'task_contract_get', 'ready_queue', 'scheduler_advice', 'leases', 'control_status', 'room_snapshot', 'requirements_snapshot', 'requirements_diff', 'inbox_list', 'compaction_status', 'evidence_query', 'review_package', 'verification_plan', 'merge_status', 'merge_recover', 'context_pack', 'timeline', 'replay', 'waiting_list', 'failure_memory_status', 'ptc_receipts'])
function mutatesTeam(tool, args) {
  if (READ_TOOLS.has(tool)) return false
  if (tool === 'team_v12') return !V12_READ_ACTIONS.has(text(args.action) || 'runtime_facts')
  if (tool === 'team_milestone' && ['get', 'status'].includes(args.action)) return false
  return tool.startsWith('team_') || ['send_message', 'spawn_agent', 'interrupt_agent', 'freeze_member', 'unfreeze_member'].includes(tool)
}

function resultJsonValue(result) {
  if (result?.value !== undefined) return result.value
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const value = JSON.parse(block.text)
      if (value !== null && typeof value === 'object') return value
    } catch {}
  }
  return undefined
}

export function failureMemoryTargetFingerprint(input = {}, sessionId = '') {
  const explicit = text(input.action_fingerprint ?? input.actionFingerprint)
  if (explicit) return explicit
  const targetTool = text(input.tool ?? input.targetTool)
  if (!targetTool) return ''
  return actionFingerprint({
    name: targetTool,
    arguments: input.arguments ?? input.args ?? {},
    sessionId: text(sessionId),
  })
}

function messageIdOf(value, exec) {
  const candidate = value?.messageId ?? value?.message_id ?? value?.dispatchId
  const candidateText = text(candidate).trim()
  if (candidateText.length > 0 && candidateText.length <= 200 && !/[\r\n]/.test(candidateText)) return candidateText
  const callId = text(exec?.callId ?? exec?.id)
  if (callId.length > 0) return 'tool-call:' + callId
  return candidateText.length > 0 ? 'message:' + contentHash(candidateText) : ''
}

function appendResultSummary(value, result) {
  const source = value ?? resultJsonValue(result)
  return source !== undefined && source !== null ? source : {}
}

function migrateAndValidate(task, options = {}) {
  const migration = migrateTaskContract(task?.contract ?? task, options.targetVersion)
  const contract = migration.contract ?? task?.contract ?? task
  const verdict = validateTaskContract(contract, { ...options, allowLegacy: true })
  return { contract, migration, verdict }
}

export function taskContractReadResult(task) {
  const lifecycle = taskLifecycle(task)
  const kind = text(task?.contract?.kind ?? task?.contract?.workKind ?? task?.workKind ?? '').toLowerCase()
  const migrated = migrateAndValidate({
    ...task,
    lifecycle,
    contract: { ...(task?.contract ?? {}), lifecycle },
  }, {
    allowLegacy: true,
    allowReadOnly: ['discussion', 'review'].includes(kind),
  })
  return {
    contract: migrated.contract,
    validation: migrated.verdict,
    lifecycle,
  }
}

function taskLifecycle(task) {
  const status = text(task?.status).toLowerCase()
  if (['completed', 'accepted', 'deleted'].includes(status)) return 'completed'
  if (['cancelled', 'expired'].includes(status)) return 'cancelled'
  const phase = text(task?.phase)
  if (['member-check', 'group-check', 'verifier-review', 'integration-ready', 'integrated'].includes(phase)) return 'review'
  if (['blocked', 'rejected', 'cancelled', 'expired'].includes(phase)) return phase === 'blocked' ? 'blocked' : 'cancelled'
  if (['in_progress', 'running'].includes(status)) return 'running'
  if (['execution', 'plan-approved'].includes(phase) || task?.approved === true || task?.lifecycle === 'ready') return 'ready'
  if (phase === 'accepted') return 'completed'
  return 'proposed'
}

function synchronizeTaskContract(task) {
  const previous = task.contract ?? {}
  task.lifecycle = taskLifecycle(task)
  task.contract = normalizeTaskContract({
    ...previous, taskId: task.id, subject: task.subject,
    deliverable: previous.deliverable || task.subject,
    owner: Object.hasOwn(task, 'ownerName') ? task.ownerName : previous.owner,
    dependencies: task.blockedBy ?? previous.dependencies ?? [],
    writeScopes: task.writeScopes ?? previous.writeScopes ?? [],
    acceptanceCriteria: task.acceptanceCriteria ?? previous.acceptanceCriteria ?? [],
    kind: task.workKind ?? previous.kind ?? 'discussion',
    lifecycle: task.lifecycle,
  })
  task.contractDigest = contractDigest(task.contract)
  return task.contract
}

export function authorizeTaskContractSet({ tier, memberName, task, activeLease }) {
  if (Number(tier) === 0) return { ok: true }
  const owner = text(task?.ownerName ?? task?.contract?.owner)
  if (owner !== text(memberName)) {
    return {
      ok: false,
      code: 'task-contract-scope',
      detail: 'only the current owner or tier 0 may revise this contract',
    }
  }
  if (activeLease !== undefined && text(activeLease?.member) !== text(memberName)) {
    return {
      ok: false,
      code: 'task-contract-lease',
      detail: 'the task has an active lease owned by another member',
    }
  }
  return { ok: true }
}

/**
 * Contract writes have their own revision stream. A caller that supplies an
 * expected revision gets compare-and-set semantics instead of silently
 * overwriting a newer contract.
 */
export function contractRevisionVerdict(currentRevision, expectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null || String(expectedRevision).trim() === '') {
    return { ok: true, currentRevision: Number(currentRevision ?? 0) }
  }
  const expected = Number(expectedRevision)
  const current = Number(currentRevision ?? 0)
  if (!Number.isFinite(expected)) {
    return {
      ok: false,
      code: 'contract-revision-invalid',
      currentRevision: current,
      expectedRevision,
      detail: 'expected_contract_revision must be a finite number',
    }
  }
  if (expected !== current) {
    return {
      ok: false,
      code: 'stale-contract-revision',
      currentRevision: current,
      expectedRevision: expected,
      detail: 'contract revision changed from ' + String(expected) + ' to ' + String(current) + '; reread the contract before writing',
    }
  }
  return { ok: true, currentRevision: current, expectedRevision: expected }
}

/**
 * A group lead may record requirements or decisions only for its own group,
 * its own group rooms, or tasks on a board it may write. Global and unscoped
 * records stay tier-0 only; otherwise a lead could silently change every
 * group's context.
 */
function requirementRecordTaskIds(input, existing) {
  const ids = []
  for (const source of [input.taskIds, input.task_ids, existing?.taskIds]) {
    for (const value of Array.isArray(source) ? source : []) {
      const id = text(value)
      if (id) ids.push(id)
    }
  }
  const recordId = text(input.requirementId ?? input.id)
  const taskPrefix = /^task:([^:]+):/.exec(recordId)
  if (taskPrefix?.[1]) ids.push(taskPrefix[1])
  return [...new Set(ids)]
}

export function authorizeRequirementRecord({
  tier,
  memberName,
  group,
  input = {},
  taskRows = [],
  existingRecords = {},
  canWriteBoard = () => false,
  kind = 'requirement',
}) {
  if (Number(tier) === 0) return { ok: true }
  if (Number(tier) !== 1) {
    return { ok: false, code: 'lead-or-tier-0-only', detail: 'only a Team lead or tier 0 may record a ' + kind }
  }
  const recordId = text(input.requirementId ?? input.id)
  const existing = recordId && existingRecords && typeof existingRecords === 'object'
    ? existingRecords[recordId]
    : undefined
  const taskIds = requirementRecordTaskIds(input, existing)
  if (taskIds.length > 0) {
    for (const id of taskIds) {
      const row = taskRows.find((candidate) => text(candidate?.task?.id) === id)
      if (!row) return { ok: false, code: kind + '-task-scope', detail: 'unknown task "' + id + '" for ' + kind }
      if (row.board === 'global' || canWriteBoard(memberName, row.board) !== true) {
        return { ok: false, code: kind + '-task-scope', detail: 'task "' + id + '" is outside the lead writable board scope' }
      }
    }
    return { ok: true }
  }
  const scope = text(input.scope) || text(existing?.scope)
  if (scope.length === 0 || scope === 'global') {
    return { ok: false, code: kind + '-scope', detail: 'global or unscoped ' + kind + 's require tier 0' }
  }
  if (scope === text(group) || scope === 'group-' + text(group)
    || (scope.startsWith('room:') && scope.includes(text(group)))) return { ok: true }
  return { ok: false, code: kind + '-scope', detail: kind + ' scope "' + scope + '" is outside the lead group' }
}

export function authorizeRoomCursor({ tier, memberName, targetMember }) {
  if (Number(tier) === 0 || text(targetMember) === text(memberName)) return { ok: true }
  return {
    ok: false,
    code: 'room-cursor-scope',
    detail: 'only the cursor owner or tier 0 may advance this Room cursor',
  }
}

/** Project durable pending handoffs into the same inbox the receiver already reads. */
export function pendingDispatchInboxRows(dispatches = {}, target = '') {
  const wanted = text(target)
  const rows = []
  for (const dispatch of Object.values(dispatches ?? {})) {
    if (dispatch === null || typeof dispatch !== 'object' || (wanted.length > 0 && text(dispatch.target) !== wanted)) continue
    for (const message of Array.isArray(dispatch.pendingMessages) ? dispatch.pendingMessages : []) {
      if (message === null || typeof message !== 'object') continue
      const messageId = text(message.messageId ?? message.message_id)
      const status = text(message.status ?? 'queued')
      if (messageId.length === 0 || ['handled', 'rejected'].includes(status)) continue
      rows.push({
        messageId,
        inboxId: messageId,
        inbox_id: messageId,
        target: wanted,
        sender: text(dispatch.sender),
        status,
        dispatchStatus: text(dispatch.status),
        dispatchId: text(dispatch.dispatchId),
        wakeId: null,
        wake_id: null,
        originalText: text(message.text).slice(0, 2000),
        createdAt: Number(message.createdAt ?? dispatch.createdAt ?? 0),
        updatedAt: Number(message.updatedAt ?? dispatch.resolvedAt ?? dispatch.createdAt ?? 0),
        source: 'dispatch-pending',
        ackable: true,
      })
    }
  }
  return rows
}

/** Acknowledge one durable pending handoff without requiring a synthetic wake row. */
export function acknowledgePendingDispatchMessage(state, { target, inboxId, at = Date.now() } = {}) {
  const wanted = text(target)
  const requested = text(inboxId)
  for (const dispatch of Object.values(state?.dispatches ?? {})) {
    if (dispatch === null || typeof dispatch !== 'object' || text(dispatch.target) !== wanted) continue
    const message = (Array.isArray(dispatch.pendingMessages) ? dispatch.pendingMessages : [])
      .find((candidate) => text(candidate?.messageId ?? candidate?.message_id) === requested)
    if (message === undefined) continue
    message.status = 'handled'
    message.updatedAt = Number(at)
    const open = (Array.isArray(dispatch.pendingMessages) ? dispatch.pendingMessages : [])
      .some((candidate) => !['handled', 'rejected'].includes(text(candidate?.status)))
    let dispatchCompleted = false
    if (!open && ['dispatch-created', 'queued', 'delivered', 'turn-started', 'first-observation', 'checkpointed', 'response-recorded'].includes(text(dispatch.status))) {
      dispatch.status = 'completed'
      dispatch.lastError = null
      dispatch.resolvedAt = Number(at)
    }
    dispatchCompleted = !open && text(dispatch.status) === 'completed'
    for (const episode of Object.values(state?.wakeEpisodes ?? {})) {
      if (episode === null || typeof episode !== 'object' || text(episode.dispatchId) !== text(dispatch.dispatchId)) continue
      episode.pendingMessages = dispatch.pendingMessages
      episode.updatedAt = Number(at)
      if (!open) {
        episode.status = text(dispatch.status)
        episode.resolvedAt = Number(at)
        episode.redeliveryRequired = false
      }
    }
    return {
      ok: true,
      inboxId: requested,
      messageId: requested,
      dispatchId: text(dispatch.dispatchId),
      status: 'handled',
      handled: true,
      cleared: true,
      pendingRetired: true,
      dispatchStatus: text(dispatch.status),
      dispatchCompleted,
    }
  }
  return { ok: false, reason: 'inbox-not-found', inboxId: requested }
}

/**
 * Acknowledge one inbox row across both carriers. A durable dispatch row can
 * also be projected into the room inbox, so acknowledging only one carrier
 * leaves the other row visible forever.
 */
export function acknowledgeInboxEntry(state, { target, inboxId, input = {}, at = Date.now(), allowOtherTarget = false } = {}) {
  const wanted = text(target)
  const requested = text(inboxId)
  const pending = pendingDispatchInboxRows(state?.dispatches, allowOtherTarget === true ? '' : wanted)
    .find((row) => row.inboxId === requested)
  const roomState = v12RoomState(state)
  const durable = roomState.inbox?.[requested]
  if (pending === undefined && durable === undefined) {
    const retiredVerdict = handleInboxMessage(roomState, requested, {
      ...input,
      target: wanted,
      allowOtherTarget,
    })
    if (retiredVerdict.ok === true) state.v12RoomWake = roomState
    return retiredVerdict
  }
  if (allowOtherTarget !== true && durable !== undefined && text(durable.target) !== wanted) {
    return { ok: false, reason: 'inbox-ack-scope', inboxId: requested }
  }

  let durableVerdict
  if (durable !== undefined) {
    durableVerdict = handleInboxMessage(roomState, requested, {
      ...input,
      allowUndelivered: pending !== undefined,
    })
    if (durableVerdict.ok !== true && !(pending !== undefined && text(durable.status) === 'rejected')) {
      return durableVerdict
    }
  }

  let pendingVerdict
  if (pending !== undefined) {
    pendingVerdict = acknowledgePendingDispatchMessage(state, {
      target: text(pending.target) || wanted,
      inboxId: requested,
      at,
    })
    if (pendingVerdict.ok !== true) return pendingVerdict
  }
  if (pending !== undefined) {
    rememberAcknowledgedInbox(roomState, requested, {
      target: text(pending.target) || wanted,
      wakeIds: pending.wakeId ? [pending.wakeId] : [],
    }, at)
  }
  if (durableVerdict?.ok === true) state.v12RoomWake = roomState
  if (pending !== undefined) state.v12RoomWake = roomState

  return {
    ok: true,
    inboxId: requested,
    messageId: requested,
    status: 'handled',
    handled: true,
    cleared: true,
    source: pending !== undefined ? 'dispatch-pending' : 'inbox',
    pendingRetired: pending !== undefined,
    durableHandled: durableVerdict?.ok === true || text(durable?.status) === 'handled',
    inboxStatus: text(durable?.status) || null,
    dispatchId: pendingVerdict?.dispatchId ?? pending?.dispatchId ?? null,
    dispatchStatus: pendingVerdict?.dispatchStatus ?? pending?.dispatchStatus ?? null,
    wakeStatus: durableVerdict?.wakeStatus ?? null,
    wakeHandled: durableVerdict?.wakeStatus === 'handled',
    redeliveryRequired: durableVerdict?.redeliveryRequired === true,
  }
}

/**
 * wake_id and inbox_id are different namespaces. Name the namespace mistake
 * before the generic not-found path can hide which identifier the caller used.
 */
export function inboxAckIdentifierVerdict({
  wakeId,
  inboxId,
  roomState,
  memberName,
  tier = -1,
} = {}) {
  const wake = text(wakeId)
  const inbox = text(inboxId)
  const visible = (row) => row !== undefined
    && (Number(tier) === 0 || text(row.target) === text(memberName))
  if (wake.length > 0 && inbox.length > 0) {
    return {
      ok: false,
      code: 'inbox-ack-id-ambiguous',
      detail: 'pass exactly one of wake_id or inbox_id',
    }
  }
  if (inbox.length > 0 && visible(roomState?.wakes?.[inbox])) {
    return {
      ok: false,
      code: 'wake-id-passed-as-inbox',
      detail: '"' + inbox + '" is a wake_id; pass it as top-level wake_id, not inbox_id',
    }
  }
  if (wake.length > 0 && visible(roomState?.inbox?.[wake])) {
    return {
      ok: false,
      code: 'inbox-id-passed-as-wake',
      detail: '"' + wake + '" is an inbox_id; pass it as top-level inbox_id, not wake_id',
    }
  }
  return { ok: true }
}

/** Refuse a fuzzy waiting resolve when it would hit a resolved legacy ticket
 * instead of the active derived row the caller can see. */
export function waitingResolveDerivedGuard(state, {
  taskId,
  owner,
  waiter,
  responsible,
  ticketId,
  members = [],
  now = Date.now(),
} = {}) {
  if (text(ticketId)) return { ok: true }
  const wantedTask = text(taskId)
  const derived = deriveWaitingTickets(state, members, now)
    .filter((row) => text(row.taskId) === wantedTask)
  if (derived.length === 0) return { ok: true }
  const candidates = [owner, waiter, responsible].map(text).filter(Boolean)
  const explicitOpen = Object.values(state?.v14Waiting?.tickets ?? {}).filter((row) => {
    if (text(row?.taskId) !== wantedTask || text(row?.status || 'open').toLowerCase() !== 'open') return false
    return candidates.some((candidate) => [row.owner, row.waiter, row.responsible].map(text).includes(candidate))
  })
  if (explicitOpen.length > 0) {
    return { ok: true, explicitTicketIds: explicitOpen.map((row) => text(row.ticketId)).filter(Boolean) }
  }
  return {
    ok: false,
    code: 'derived-ticket-not-resolvable',
    detail: 'task "' + wantedTask + '" has active derived waiting rows but no matching explicit ticket; derived rows clear only when their condition changes',
    candidates: derived.map((row) => ({
      taskId: row.taskId,
      reason: row.reason,
      unblockCondition: row.unblockCondition,
      responsible: row.responsible,
    })),
  }
}

/**
 * A waiting ticket id is not a task id. Reject that alias before lookup so the
 * caller gets the exact field-name correction instead of task-not-found.
 */
export function waitingResolveInputVerdict({ taskId, ticketId } = {}) {
  const requestedTaskId = text(taskId)
  const requestedTicketId = text(ticketId)
  if (requestedTaskId.startsWith('wait:')) {
    return {
      ok: false,
      code: 'waiting-ticket-passed-as-task',
      detail: 'task_id="' + requestedTaskId + '" is a waiting ticket id; pass it as ticket_id, not task_id',
    }
  }
  if (requestedTaskId.length > 0 && requestedTicketId.length > 0) {
    return {
      ok: false,
      code: 'waiting-task-and-ticket-ambiguous',
      detail: 'waiting_resolve accepts either task_id="' + requestedTaskId
        + '" or ticket_id="' + requestedTicketId + '", not both',
    }
  }
  return { ok: true }
}

export function authorizeInboxAck({ tier, memberName, wake }) {
  if (Number(tier) === 0 || text(wake?.target) === text(memberName)) return { ok: true }
  return {
    ok: false,
    code: 'inbox-ack-scope',
    detail: 'only the target member or tier 0 may acknowledge this wake batch',
  }
}

/**
 * Waiting tickets are coordination state for the task owner. A group lead also
 * needs to be able to register or resolve a wait for work assigned to one of
 * its own members, while global boards and other groups remain tier-0 only.
 */
export function authorizeWaitingAction({
  tier,
  memberName,
  group,
  taskOwner,
  requestedOwner,
  taskBoard,
  ownerGroup,
  ticket,
  allowWaiterResolve = false,
  canWriteBoard = () => false,
}) {
  const owner = text(taskOwner)
  const requested = text(requestedOwner)
  const caller = text(memberName)
  if (Number(tier) === 0) return { ok: true }
  if (owner.length > 0 && owner === caller) return { ok: true }
  if (owner.length === 0 && requested === caller) return { ok: true }
  if (allowWaiterResolve === true && ticket !== undefined
    && (text(ticket.waiter) === caller || text(ticket.responsible) === caller)) {
    return { ok: true }
  }
  if (Number(tier) === 1 && owner.length > 0
    && (requested.length === 0 || requested === owner)
    && text(taskBoard).length > 0 && text(taskBoard) !== 'global'
    && canWriteBoard(caller, text(taskBoard)) === true
    && (text(ownerGroup).length === 0 || text(ownerGroup) === text(group))) {
    return { ok: true }
  }
  return {
    ok: false,
    code: 'waiting-scope',
    detail: 'only the task owner, its group lead on a writable group board, or tier 0 may change its wait'
      + '; taskBoard="' + text(taskBoard) + '", caller="' + caller + '", owner="' + owner
      + '", requestedOwner="' + requested + '"',
  }
}

export function authorizeCompactionTransition({ tier, memberName, job, milestone, requestedOwner }) {
  if (Number(tier) === 0) return { ok: true }
  const owner = text(job?.owner) || text(milestone?.owner) || text(requestedOwner)
  if (owner.length > 0 && owner === text(memberName)) return { ok: true }
  return {
    ok: false,
    code: 'compaction-scope',
    detail: 'only the milestone owner or tier 0 may change this compaction state',
  }
}

export function roomCursorIdsFromContextItems(items = []) {
  const includedByRoom = new Map()
  for (const item of items) {
    const sourceId = text(item?.sourceId)
    if (!sourceId.startsWith('room:')) continue
    const separator = sourceId.lastIndexOf(':')
    if (separator <= 'room:'.length) continue
    const roomId = sourceId.slice('room:'.length, separator)
    const messageId = sourceId.slice(separator + 1)
    if (roomId.length === 0 || messageId.length === 0) continue
    const ids = includedByRoom.get(roomId) ?? []
    ids.push(messageId)
    includedByRoom.set(roomId, ids)
  }
  return includedByRoom
}

export function contextPackAlreadyPresent({ rendered, digest, visible = [], messages = [], decisionMessages = [] }) {
  if (text(rendered).length === 0) return true
  return [...visible, ...messages, ...decisionMessages]
    .some((message) => JSON.stringify(message?.content ?? '').includes('[team v12 context pack] digest=' + digest))
}

function messageTextOf(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .map((block) => block?.type === 'text' ? String(block.text ?? '') : '')
    .join('\n')
}

/**
 * Replace older, repeated v12 context packs in a live session with tiny
 * placeholders. The original event stays in the append-only journal; the
 * replacement only changes what future model requests can see.
 */
function pruneHistoricalContextPacks(agent, keep = 1) {
  const session = agent?.session
  if (session === undefined
    || typeof session.eventAt !== 'function'
    || typeof session.deriveEventMessage !== 'function'
    || typeof session.append !== 'function'
    || session.surface?.nodes === undefined) {
    return { pruned: 0, kept: 0, charsRemoved: 0 }
  }

  const rows = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const message = session.deriveEventMessage(event)
    const sourceText = messageTextOf(message)
    if (!sourceText.includes('[team v12 context pack]') || sourceText.includes('[context-prune]')) continue
    rows.push({ seq, message, sourceText })
  }

  const keepCount = Math.max(0, Number(keep) || 0)
  const victims = rows.slice(0, Math.max(0, rows.length - keepCount))
  let charsRemoved = 0
  for (const row of victims) {
    const digest = /\[team v12 context pack\]\s+digest=([0-9a-f]+)/i.exec(row.sourceText)?.[1] ?? 'unknown'
    const marker = '[context-prune] team v12 context pack digest=' + digest
      + ' removed from model history; a current pack is injected separately and the original remains in the session journal.'
    const replacement = JSON.parse(JSON.stringify(row.message))
    replacement.content = [{ type: 'text', text: marker }]
    session.append('compaction/prune', {
      shadowedRange: { start: row.seq, end: row.seq },
      shadowedSeqs: [row.seq],
      shadowedTokenCount: 0,
    })
    session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: row.seq, endSeq: row.seq },
      sourceEventSeqs: [row.seq],
    })
    charsRemoved += Math.max(0, row.sourceText.length - marker.length)
  }
  return {
    pruned: victims.length,
    kept: Math.min(rows.length, keepCount),
    charsRemoved,
  }
}

function updateTaskV12(task, patch) {
  return {
    ...task,
    ...patch,
    revision: Number(task.revision ?? 0) + 1,
    updatedAt: Date.now(),
  }
}

function install(agent, ctx, config) {
  const scoped = agent.ctx
  const disposers = []
  const register = (disposer) => disposers.push(disposer)
  const member = () => membershipFor(ctx, agent)
  const memberName = () => member()?.name ?? 'root'
  const cp = () => controlFor(ctx, agent, config)
  const snapshotHot = () => cp().view({ history: false })
  const snapshotFull = () => cp().snapshot({ history: true, copy: false })
  // Pre-step context must stay bounded. The panel cache already carries a
  // recent Room tail, summaries, unresolved items, and decisions; replaying
  // the full cold transcript on every model step made ordinary turns wait on
  // thousands of files. A caller that explicitly needs the cold transcript can
  // opt in with input.full_history=true.
  const snapshotContext = (_name) => withRoomTails(snapshotHot())
  const boardIdForTask = (state, task) => {
    const explicit = text(task?.board)
    if (explicit && state?.boards?.[explicit]?.tasks?.[task.id] !== undefined) return explicit
    return Object.entries(state?.boards ?? {})
      .find(([, board]) => Object.values(board?.tasks ?? {}).some((item) => item.id === task?.id))?.[0]
  }
  const canReadTask = (state, task, mine = member()) => {
    if (!mine || !task) return false
    if (Number(mine.tier) === 0 || text(task.ownerName ?? task.contract?.owner) === mine.name) return true
    const board = boardIdForTask(state, task)
    const policy = teamPolicy.policyFor?.(teamKeyOf(ctx, agent))
    return board === 'global' || policy?.canReadBoard?.(mine.name, board) === true
  }
  const assertTaskRead = (state, taskId) => {
    const task = findTask(state, taskId)
    if (!task) refuse('task-not-found', taskId)
    if (!canReadTask(state, task)) refuse('task-read-scope', 'this task is outside your board scope')
    return task
  }
  const scopedRequirements = (state, mine = member()) => {
    const ledger = v12RequirementsState(state)
    if (Number(mine?.tier) === 0) return ledger
    const taskById = new Map(boardTasks(state).map((task) => [String(task.id), task]))
    const roomDoc = v12RoomStateView(state)
    const visible = (row) => {
      if (row.taskIds?.length) return row.taskIds.some((id) => {
        const task = taskById.get(String(id))
        if (task === undefined) return false
        const boardId = boardIdForTask(state, task)
        const canReadBoard = (memberName, board) => teamPolicy.policyFor?.(teamKeyOf(ctx, agent))?.canReadBoard?.(memberName, board) === true
        return taskRequirementVisibleTo(task, mine, boardId, canReadBoard)
      })
      if (row.scope === 'room' || String(row.scope).startsWith('room:')) {
        return roomIds(roomDoc).some((id) => canReadRoom(roomDoc, id, mine.name)
          && (row.scope === 'room:' + id || String(row.decisionId).startsWith('room:' + id + ':')))
      }
      return !row.scope || row.scope === 'global' || row.scope === mine.group || row.scope === 'group-' + mine.group
    }
    ledger.requirements = Object.fromEntries(Object.entries(ledger.requirements).filter(([, row]) => visible(row)))
    ledger.decisions = Object.fromEntries(Object.entries(ledger.decisions).filter(([, row]) => visible(row)))
    ledger.events = ledger.events.filter((row) => ledger.requirements[row.requirementId] || ledger.decisions[row.decisionId])
    return ledger
  }
  const scopedContextRequirements = (state, mine = member()) => {
    if (Number(mine?.tier) === 0) {
      const activeIds = new Set(boardTasks(state).filter((task) => activeTask(task)).map((task) => String(task.id)))
      const visible = (row) => {
        const taskIds = Array.isArray(row?.taskIds) ? row.taskIds.map(String) : []
        if (taskIds.length > 0) return taskIds.some((taskId) => activeIds.has(taskId))
        return !row?.scope || row.scope === 'global'
      }
      return contextRequirementSnapshot(state?.v12Requirements ?? {}, {
        visible,
        sortRecent: true,
        limitRequirements: 12,
        limitDecisions: 8,
      })
    }
    const taskById = new Map(boardTasks(state).map((task) => [String(task.id), task]))
    const roomDoc = v12RoomStateView(state)
    const visible = (row) => {
      if (row.taskIds?.length) return row.taskIds.some((id) => {
        const task = taskById.get(String(id))
        if (task === undefined) return false
        const boardId = boardIdForTask(state, task)
        const canReadBoard = (memberName, board) => teamPolicy.policyFor?.(teamKeyOf(ctx, agent))?.canReadBoard?.(memberName, board) === true
        return taskRequirementVisibleTo(task, mine, boardId, canReadBoard)
      })
      if (row.scope === 'room' || String(row.scope).startsWith('room:')) {
        return roomIds(roomDoc).some((id) => canReadRoom(roomDoc, id, mine.name)
          && (row.scope === 'room:' + id || String(row.decisionId).startsWith('room:' + id + ':')))
      }
      return !row.scope || row.scope === 'global' || row.scope === mine.group || row.scope === 'group-' + mine.group
    }
    return contextRequirementSnapshot(state?.v12Requirements ?? {}, { visible })
  }
  const refreshDerived = async (actor = agent) => {
    try {
      const state = snapshotHot()
      const members = typeof ctx.agentTeams?.listMembers === 'function'
        ? ctx.agentTeams.listMembers(actor)
        : []
      const queue = buildReadyQueue(boardTasks(state), members, Object.values(state.leases ?? {}), {
        now: Date.now(),
        plans: state.plans ?? {},
      })
      const stallClasses = boardTasks(state)
        .filter((task) => !['completed', 'cancelled', 'expired', 'deleted'].includes(text(task.status).toLowerCase()))
        .map((task) => ({
          taskId: task.id,
          owner: task.ownerName ?? null,
          classification: classifyStall({
            state: ['execution', 'running', 'in_progress'].includes(text(task.phase || task.status).toLowerCase()) ? 'running' : 'idle',
            lastProgressAt: Number(task.updatedAt ?? task.createdAt ?? Date.now()),
            now: Date.now(),
            permissionBlocked: task.phase === 'blocked',
            dependencyState: (task.blockedBy ?? []).length > 0 ? 'waiting' : 'ready',
          }),
        }))
      const previousQueue = state.v12ReadyQueue
      // The revision is a stable digest of the task/member/lease inputs. A
      // matching revision already proves the derived rows are unchanged; the
      // previous deep JSON comparison serialized the whole queue on every
      // idle refresh and was pure duplicate work.
      const queueStable = previousQueue?.revision === queue.revision
      const stallsStable = JSON.stringify(state.v12StallClasses ?? []) === JSON.stringify(stallClasses)
      if (queueStable && stallsStable) return
      await cp().mutateHot('v12/derived-views', { revision: queue.revision }, actor, (latest) => {
        latest.v12ReadyQueue = queue
        latest.v12StallClasses = stallClasses
        return queue
      }, { deferMs: 250 })
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('team-v12 derived view refresh failed: ' + String(error?.message ?? error))
    }
  }

  const appendEvent = async (type, data, stage) => {
    const row = makeObservation(memberName(), type, data, stage)
    await cp().mutateHot('v12/observation', { type, stage, data }, agent, (state) => {
      const events = Array.isArray(state.v12Events) ? state.v12Events : []
      events.push(row)
      state.v12Events = events.slice(-256)
      return row
    }, { deferMs: 250 })
    return row
  }

  register(scoped.systemPrompt.section({
    name: 'team:v12',
    order: scoped.systemPrompt.getSectionOrder('TEAM_POLICY') + 1,
    text: () => V12_POLICY,
  }))

  const acknowledgeCommittedMessage = async (session, message, stateOverride) => {
    if (text(session?.id) !== text(agent.session?.id)) return
    const manifest = parseContextManifest(message)
    const nativeIds = [...nativeMessageIds([message])]
    if (!manifest && nativeIds.length === 0) return
    const mine = member()
    if (!mine || (manifest && (manifest.member !== mine.name || manifest.sessionId !== text(session?.id)))) return
    const receipt = text(session?.id) + ':' + (manifest?.receiptId ?? contentHash(nativeIds.join('|')))
    const observed = stateOverride ?? withRoomTails(snapshotHot())
    if ((observed.v14DeliveryReceipts ?? []).some((row) => row.receipt === receipt)) return
    const inboxIds = [...new Set([...nativeIds, ...(manifest?.items ?? []).map((item) => item.inboxId).filter(Boolean)])]
    const roomItems = (manifest?.items ?? []).filter((item) => item.roomId && item.messageId)
    if (nativeIds.length === 0 && roomItems.length === 0 && !manifest) return
    await cp().mutateHot('v14/delivery-receipt', { receipt, member: mine.name }, agent, (latest) => {
      const live = v12RoomState(withRoomTails(latest))
      for (const id of nativeIds) {
        recordDeliveredInboxMessage(live, {
          messageId: id,
          target: mine.name,
          injectionReceipt: receipt,
          injectedAt: Date.now(),
        })
      }
      const rooms = new Map()
      for (const item of roomItems) {
        if (!canReadRoom(live, item.roomId, mine.name)) continue
        const ids = rooms.get(item.roomId) ?? []
        ids.push(item.messageId)
        rooms.set(item.roomId, ids)
      }
      for (const [roomId, messageIds] of rooms) {
        const recorded = recordRoomInjection(live, roomId, mine.name, { messageIds, receipt })
        if (recorded.ok === true) advanceRoomCursor(live, roomId, mine.name, { messageIds, requireInjection: true })
      }
      const ids = inboxIds.filter((id) => live.inbox?.[id]?.target === mine.name && live.inbox[id].status !== 'handled')
      for (const wake of Object.values(live.wakes ?? {})) {
        if (wake.target !== mine.name || ['handled', 'rejected'].includes(wake.status)) continue
        const selected = wake.messageIds.filter((id) => ids.includes(id))
        if (!selected.length) continue
        if (selected.some((id) => live.inbox[id]?.status === 'queued')) deliverWakeBatch(live, wake.wakeId, { messageIds: selected })
        markWakeInjected(live, wake.wakeId, { messageIds: selected, injectionReceipt: receipt })
      }
      // Informational messages have no wake batch. Delivery is not handling.
      for (const id of ids) {
        const row = live.inbox[id]
        if (row.status === 'queued') row.status = 'delivered'
        row.injectionReceipt = receipt
        row.injectedAt = Date.now()
      }
      latest.v14DeliveryReceipts = [...(latest.v14DeliveryReceipts ?? []).filter((row) => row.receipt !== receipt), {
        receipt, sessionId: text(session?.id), member: mine.name, committedAt: Date.now(),
        items: Array.isArray(manifest?.items) ? manifest.items : [],
        debt: Array.isArray(manifest?.debt) ? manifest.debt : [],
        baselineId: text(manifest?.baselineId) || null,
      }].slice(-500)
      const cursorKey = text(session?.id) + '::' + mine.name
      const previousCursor = live.contextCursors?.[cursorKey]
      const cursorVersions = { ...(previousCursor?.versions ?? {}) }
      for (const item of Array.isArray(manifest?.items) ? manifest.items : []) {
        if (item?.id && item?.hash) cursorVersions[item.id] = item.hash
      }
      for (const item of Array.isArray(manifest?.debt) ? manifest.debt : []) {
        if (item?.id && item?.hash) cursorVersions[item.id] = item.hash
      }
      live.contextCursors = {
        ...(live.contextCursors ?? {}),
        [cursorKey]: {
          member: mine.name,
          sessionId: text(session?.id),
          versions: cursorVersions,
          baselineId: text(manifest?.baselineId) || previousCursor?.baselineId || null,
          updatedAt: Date.now(),
        },
      }
      latest.v12RoomWake = live
    }, { panelCache: true, deferMs: 250 })
  }

  // Only the post-commit session feed acknowledges an admitted message.
  register(scoped.on('session/event', async (session, event) => {
    if (event?.type === 'compaction/end' && !event?.error) {
      const sessionId = text(session?.id)
      const compactionId = text(event?.compactionId)
      if (sessionId && compactionId) {
        try {
          await cp().mutateHot('v14/context-baseline', { sessionId, compactionId }, agent, (latest) => {
            const roomState = v12RoomState(latest)
            roomState.contextEpochs = {
              ...(roomState.contextEpochs ?? {}),
              [sessionId]: { compactionId, endedAt: Date.now() },
            }
            latest.v12RoomWake = roomState
          }, { deferMs: 250 })
        } catch (error) {
          ctx.logger?.warn?.('team-v14 context baseline persistence failed: ' + String(error?.message ?? error))
        }
      }
      return
    }
    if (event?.type !== 'user/message') return
    const message = session.deriveEventMessage?.(event) ?? event.message ?? event.data ?? event
    try { await acknowledgeCommittedMessage(session, message) }
    catch (error) { ctx.logger?.warn?.('team-v14 delivery receipt failed: ' + String(error?.message ?? error)) }
  }))

  register(scoped.tools.register(defineTool({
    name: 'team_v12',
    description: 'Agent Team v12 aggregate control/read tool. Use it for runtime facts, capability gates, task contracts, ready queues, run leases, Room recovery, inbox acknowledgement, compaction state, evidence reuse, merge recovery, context packs, timelines and replay fixtures. Omit action to return compact runtime facts. leases shows the caller\'s own run leases; tier 0 may inspect any member and a group lead may inspect its own group through input {member}. waiting_list returns active tickets by default; input {includeClosed:true} also returns closurePolicy, closedReason, closedAt and closedBy; use input {ticketId,taskId,offset,limit} for exact or paged reads. failure_memory_status inspects one call signature; failure_memory_clear requires action_fingerprint plus reason and evidence. For inbox_ack, call inbox_list first and pass either the exact top-level wake_id or inbox_id; bulk/all acknowledgement is not supported.',
    parameters: {
      action: { type: 'string', enum: [
        'runtime_facts', 'capability_matrix', 'upgrade_gate',
        'task_contract_get', 'task_contract_set', 'ready_queue', 'scheduler_advice', 'leases',
        'control_status', 'control_recover',
        'room_snapshot', 'room_migrate', 'room_cursor', 'room_confirm_decision', 'inbox_list', 'inbox_ack',
        'requirements_snapshot', 'requirements_diff', 'requirement_record', 'decision_record',
        'waiting_set', 'waiting_resolve', 'waiting_list', 'ptc_receipts',
        'failure_memory_status', 'failure_memory_clear',
        'compaction_status', 'compaction_transition',
        'evidence_query', 'review_package', 'verification_plan',
        'merge_status', 'merge_recover',
        'context_pack', 'timeline', 'replay',
      ] },
      input: { type: 'object', additionalProperties: true },
      task_id: { type: 'string' },
      owner: { type: 'string' },
      board: { type: 'string' },
      room_id: { type: 'string' },
      member: { type: 'string' },
      wake_id: { type: 'string' },
      inbox_id: { type: 'string' },
      ticket_id: { type: 'string' },
      job_id: { type: 'string' },
      phase: { type: 'string' },
      confirm: { type: 'boolean' },
      mode: { type: 'string' },
    },
    output: jsonOutput({ type: 'object', additionalProperties: true }),
    async execute(args, exec) {
      const action = text(args.action) || 'runtime_facts'
      const statelessActions = new Set(['runtime_facts', 'capability_matrix', 'upgrade_gate', 'failure_memory_status', 'failure_memory_clear'])
      const wantsFullHistory = args.input?.full_history === true
      const state = statelessActions.has(action)
        ? undefined
        : wantsFullHistory ? snapshotFull() : snapshotHot()
      const mine = member()
      if (!mine) refuse('team-context', 'no Team membership is available')
      const tier = Number(mine.tier)
      if (action === 'failure_memory_status' || action === 'failure_memory_clear') {
        const input = args.input ?? {}
        const fingerprint = failureMemoryTargetFingerprint(input, agent?.session?.id)
        if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
          refuse('failure-memory-target-required',
            'provide action_fingerprint or input {tool,arguments}; example: {tool:"team_v12",arguments:{action:"waiting_list"}}')
        }
        const before = actionFailureSummary(fingerprint)
        if (action === 'failure_memory_status') return before
        const reason = text(input.reason)
        const evidence = text(input.evidence)
        if (!reason || !evidence) refuse('failure-memory-clear-evidence', 'failure_memory_clear requires non-empty reason and evidence')
        const cleared = clearActionByFingerprint(fingerprint, {
          reason,
          evidence,
          operator: mine.name,
          identity: agent,
        })
        return {
          ...actionFailureSummary(fingerprint),
          actionFingerprint: fingerprint,
          cleared,
          before,
          reason,
          evidence,
        }
      }
      if (action === 'runtime_facts') {
        const supplied = args.input ?? {}
        const report = collectCurrentRuntimeFacts(ctx, config, supplied)
        const full = supplied.full === true || supplied.summaryOnly === false
        return full ? report : compactRuntimeFacts(report, supplied.pluginIds)
      }
      if (action === 'capability_matrix') {
        const supplied = args.input ?? {}
        const directProfiles = supplied.profiles
          ?? (Array.isArray(supplied) || supplied.web !== undefined || supplied.headless !== undefined ? supplied : undefined)
        if (directProfiles !== undefined) return buildCapabilityMatrix(directProfiles)
        const facts = collectCurrentRuntimeFacts(ctx, config, supplied.facts ?? {})
        return {
          ...buildCapabilityMatrix(capabilityProfilesFromRuntimeFacts(facts)),
          source: {
            kind: 'current-runtime',
            collectedAt: facts.collectedAt,
            dsh: facts.dsh,
            collection: facts.collection,
          },
        }
      }
      if (action === 'upgrade_gate') {
        return evaluateUpgradeGate(args.input ?? {})
      }
      if (action === 'task_contract_get') {
        const task = assertTaskRead(state, args.task_id)
        const read = taskContractReadResult(task)
        return { taskId: task.id, contract: read.contract, validation: read.validation, lifecycle: read.lifecycle }
      }
      if (action === 'task_contract_set') {
        if (!args.task_id) refuse('task-id-required')
        const current = findTask(state, args.task_id)
        if (current === undefined) refuse('task-not-found', args.task_id)
        const activeLease = Object.values(state.leases ?? {}).find((lease) =>
          String(lease.status ?? '') === 'active' && String(lease.taskId ?? '') === String(args.task_id))
        const authorization = authorizeTaskContractSet({
          tier,
          memberName: mine.name,
          task: current,
          activeLease,
        })
        if (authorization.ok !== true) refuse(authorization.code, authorization.detail)
        const currentContract = normalizeTaskContract(current.contract ?? current)
        const requestedContract = args.input ?? {}
        const expectedContractRevision = args.input?.expected_contract_revision ?? args.input?.expectedContractRevision
        const contractRevision = contractRevisionVerdict(currentContract.contractRevision, expectedContractRevision)
        if (contractRevision.ok !== true) refuse(contractRevision.code, contractRevision.detail)
        const allowedContractKeys = new Set([
          'schemaVersion', 'contractVersion', 'contractId', 'taskId', 'id', 'goal', 'deliverable',
          'subject', 'description', 'owner', 'ownerName', 'owner_name', 'writeScopes', 'write_scopes',
          'scope', 'worktreeId', 'worktree_id', 'dependencies', 'blockedBy', 'blocked_by', 'dependsOn',
          'depends_on', 'acceptanceCriteria', 'acceptance_criteria', 'acceptance', 'doneWhen', 'done_when',
          'risk', 'riskLevel', 'riskRationale', 'contractRevision', 'contract_revision', 'lifecycle',
          'status', 'phase', 'lease', 'createdAt', 'updatedAt', 'kind', 'workKind', 'roomId',
          'expected_revision', 'expectedRevision',
        ])
        const unknownContractKeys = Object.keys(requestedContract).filter((key) => !allowedContractKeys.has(key))
        if (unknownContractKeys.length > 0) {
          refuse('task-contract-unknown-fields', 'unknown contract field(s): ' + unknownContractKeys.join(', ')
            + '; pass contract fields directly under input, not inside a nested contract object')
        }
        const contractInput = { ...requestedContract }
        delete contractInput.expected_revision
        delete contractInput.expectedRevision
        delete contractInput.expected_contract_revision
        delete contractInput.expectedContractRevision
        const contract = normalizeTaskContract({
          ...currentContract,
          ...contractInput,
          taskId: args.task_id,
          contractId: requestedContract.contractId ?? currentContract.contractId ?? args.task_id,
          contractRevision: Number(currentContract.contractRevision ?? 0) + 1,
        })
        contract.contractRevision = Number(currentContract.contractRevision ?? 0) + 1
        const contractKind = String(contract.kind ?? contract.workKind ?? '').toLowerCase()
        const validation = validateTaskContract(contract, {
          allowLegacy: true,
          allowReadOnly: ['discussion', 'review'].includes(contractKind),
        })
        if (validation.ok !== true) {
          refuse('task-contract-invalid', JSON.stringify(validation.errors ?? validation.reason ?? validation.reasons ?? 'invalid contract'))
        }
        const expectedRevision = Number(args.input?.expected_revision ?? args.input?.expectedRevision ?? current.revision ?? 0)
        const updated = await cp().mutateHot('v12/task-contract', { taskId: args.task_id, contract }, agent, (latest) => {
          const task = findTask(latest, args.task_id)
          if (task === undefined) refuse('task-not-found', args.task_id)
          const lease = Object.values(latest.leases ?? {}).find((row) => row.status === 'active' && String(row.taskId) === String(args.task_id))
          const lockedAuthorization = authorizeTaskContractSet({ tier: Number(member()?.tier), memberName: memberName(), task, activeLease: lease })
          if (!lockedAuthorization.ok) refuse(lockedAuthorization.code, lockedAuthorization.detail)
          const lockedContract = normalizeTaskContract(task.contract ?? task)
          const lockedRevision = contractRevisionVerdict(lockedContract.contractRevision, currentContract.contractRevision)
          if (lockedRevision.ok !== true) {
            refuse(lockedRevision.code, lockedRevision.detail)
          }
          if (Number(task.revision ?? 0) !== expectedRevision) refuse('stale-revision', 'read the current task before revising the contract')
          Object.assign(task, {
            contract,
            contractDigest: contractDigest(contract),
            lifecycle: taskLifecycle(task),
            revision: Number(task.revision ?? 0) + 1,
            updatedAt: Date.now(),
          })
          mirrorTaskRequirement(latest, args.task_id, contract, 'task-contract-set')
          return task
        })
        return {
          taskId: args.task_id,
          contract: updated.contract,
          lifecycle: updated.lifecycle,
          previousContractRevision: Number(currentContract.contractRevision ?? 0),
          contractRevision: Number(updated.contract?.contractRevision ?? 0),
          updatedAt: updated.updatedAt ?? null,
        }
      }
      if (action === 'ready_queue') {
        const members = ctx.agentTeams.listMembers?.(agent) ?? []
        const queue = buildReadyQueue(boardTasks(state), members, Object.values(state.leases ?? {}), {
          now: Date.now(),
          plans: state.plans ?? {},
        })
        for (const key of ['ready', 'blocked']) queue[key] = (queue[key] ?? []).filter((row) => canReadTask(state, findTask(state, row.id)))
        return queue
      }
      if (action === 'leases') {
        const input = args.input ?? {}
        const requestedMember = text(input.member ?? args.member)
        const targetMember = requestedMember || mine.name
        const policy = teamPolicy.policyFor?.(teamKeyOf(ctx, agent))
        const mayInspectTarget = tier === 0
          || targetMember === mine.name
          || (tier === 1 && policy?.canInterrupt?.(mine.name, targetMember) === true)
        if (!mayInspectTarget) {
          refuse('lease-read-scope', 'only tier 0 or the target member\'s group lead may inspect another member\'s run leases')
        }
        const taskId = text(input.taskId ?? input.task_id)
        return {
          member: targetMember,
          taskId: taskId || null,
          now: Date.now(),
          leases: projectLeasesForMember(Object.values(state.leases ?? {}), {
            tier,
            member: tier === 0 ? requestedMember : targetMember,
            taskId,
            status: input.status,
          }),
        }
      }
      if (action === 'scheduler_advice') {
        const members = ctx.agentTeams.listMembers?.(agent) ?? []
        const input = args.input ?? {}
        const tasks = boardTasks(state).filter((task) => canReadTask(state, task))
        const history = Array.isArray(input.history)
          ? input.history
          : Array.isArray(state.v12Scheduling?.history)
            ? state.v12Scheduling.history
            : tasks
        return buildSchedulerAdvice(tasks, members, Object.values(state.leases ?? {}), {
          ...input,
          history,
          now: Date.now(),
        })
      }
      if (action === 'control_status') {
        const read = readStateFileDiagnostic(cp().file)
        const observedState = read.ok && read.state ? read.state : state
        const readSummary = {
          ok: read.ok,
          kind: read.kind,
          code: read.code,
          error: read.error ?? null,
          validation: read.validation
            ? {
                ok: read.validation.ok,
                code: read.validation.code,
                errors: read.validation.errors,
                warnings: read.validation.warnings,
                unknownFields: read.validation.unknownFields,
              }
            : null,
        }
        return {
          file: cp().file,
          source: read.ok ? 'disk' : 'fallback',
          revision: observedState.revision,
          read: readSummary,
          audit: typeof controlPlane.auditStatusFor === 'function'
            ? controlPlane.auditStatusFor(cp().file, observedState)
            : auditConsistencyResult(observedState, []),
          migration: planStateMigration(observedState, { targetVersion: 2 }),
          capabilities: Object.keys(observedState.v12Capabilities ?? {}),
          runtimeCapabilities: Object.values(V12_ACTION_CAPABILITIES),
        }
      }
      if (action === 'control_recover') {
        if (tier !== 0) refuse('tier-0-only', 'only root may apply a control-plane recovery')
        const requested = args.input ?? {}
        const current = readJson(cp().file, state)
        const snapshotValue = requested.snapshot ?? state
        const plan = planStateRecovery({ current, snapshot: snapshotValue, requestedBy: memberName(), confirm: args.confirm === true })
        if (args.confirm !== true) return plan
        if (plan.ok !== true && plan.allowed !== true) refuse('recovery-not-confirmed', plan.reason ?? plan.verdict)
        const backup = cp().file + '.before-v12-recovery-' + Date.now()
        copyFileSync(cp().file, backup)
        writeJsonAtomic(cp().file, snapshotValue)
        cp().reload()
        await appendEvent('control/recovered', { backup, revision: snapshotValue.revision }, 'handled')
        return { recovered: true, backup, plan }
      }
      if (action === 'room_snapshot') {
        const target = text(args.member) || mine.name
        if (tier !== 0 && target !== mine.name) refuse('room-read-scope', 'only tier 0 may inspect another member cursor')
        const roomState = roomTailsCoverContext(state, target)
          ? withRoomTails(state)
          : (typeof cp().roomSnapshot === 'function'
              ? cp().roomSnapshot(args.room_id)
              : snapshotFull())
        const doc = v12RoomStateView(roomState)
        if (!canReadRoom(doc, args.room_id, target)) refuse('room-access-denied', args.room_id)
        return buildRoomRecoverySnapshot(doc, args.room_id, target, { limit: args.input?.limit })
      }
      if (action === 'room_migrate') {
        if (tier !== 0) refuse('tier-0-only', 'only root may persist a legacy Room migration')
        const result = await cp().mutate('v12/room-legacy-migration', { requestedBy: memberName() }, agent, (latest) => {
          const doc = v12RoomState(latest, { migrate: false, keepLegacySource: true })
          const migration = migrateLegacyRoomState(doc)
          delete doc.rooms
          delete doc.rounds
          latest.v12RoomWake = doc
          return migration
        })
        return result
      }
      if (action === 'room_cursor') {
        const targetMember = text(args.member) || mine.name
        const authorization = authorizeRoomCursor({ tier, memberName: mine.name, targetMember })
        if (authorization.ok !== true) refuse(authorization.code, authorization.detail)
        const result = await cp().mutateHot('v12/room-cursor', { roomId: args.room_id, member: targetMember, input: args.input }, agent, (latest) => {
          const doc = v12RoomState(latest)
          const verdict = advanceRoomCursor(doc, args.room_id, targetMember, { ...args.input, requireInjection: true })
          latest.v12RoomWake = doc
          return verdict
        })
        return result
      }
      if (action === 'room_confirm_decision') {
        const roomId = text(args.room_id ?? args.input?.roomId ?? args.input?.room_id)
        const decisionId = text(args.input?.decisionId ?? args.input?.decision_id)
        if (!roomId || !decisionId) refuse('room-decision-required', 'room_id and input.decisionId are required')
        const targetMember = text(args.member) || mine.name
        const docForRead = v12RoomState(state)
        if (!canReadRoom(docForRead, roomId, targetMember)) refuse('room-access-denied', roomId)
        const result = await cp().mutateHot('v12/room-decision-confirm', { roomId, decisionId, member: targetMember }, agent, (latest) => {
          const doc = v12RoomState(latest)
          const verdict = confirmDecision(doc, roomId, decisionId, {
            confirmedBy: targetMember,
            rationale: args.input?.rationale,
            evidenceLinks: args.input?.evidenceLinks ?? args.input?.evidence_links,
          })
          if (verdict.ok !== true) refuse('room-decision-confirm-failed', verdict.reason ?? verdict.detail)
          latest.v12RoomWake = doc
          return verdict
        })
        return result
      }
      if (action === 'requirements_snapshot') {
        const input = { ...(args.input ?? {}) }
        if (args.task_id !== undefined) input.taskId = args.task_id
        if (input.taskId) assertTaskRead(state, input.taskId)
        const all = v12RequirementsState(state)
        const visible = scopedRequirements(state)
        return {
          ...buildRequirementSnapshot(visible, input),
          visibility: {
            scope: tier === 0 ? 'global' : 'member',
            totalRequirements: Object.keys(all.requirements ?? {}).length,
            visibleRequirements: Object.keys(visible.requirements ?? {}).length,
            totalDecisions: Object.keys(all.decisions ?? {}).length,
            visibleDecisions: Object.keys(visible.decisions ?? {}).length,
            filtered: Object.keys(all.requirements ?? {}).length !== Object.keys(visible.requirements ?? {}).length
              || Object.keys(all.decisions ?? {}).length !== Object.keys(visible.decisions ?? {}).length,
          },
        }
      }
      if (action === 'requirements_diff') {
        const input = args.input ?? {}
        if (input.taskId) assertTaskRead(state, input.taskId)
        return diffRequirements(scopedRequirements(state), input.sinceRevision ?? input.since_revision ?? 0, input)
      }
      if (action === 'requirement_record') {
        if (tier > 1) refuse('lead-or-tier-0-only', 'only a Team lead or tier 0 may record a requirement')
        const input = args.input ?? {}
        const authorization = authorizeRequirementRecord({
          tier, memberName: mine.name, group: mine.group, input, kind: 'requirement',
          taskRows: boardTasks(state).map((task) => ({
            task,
            board: boardIdForTask(state, task),
          })),
          existingRecords: v12RequirementsState(state).requirements,
          canWriteBoard: (name, board) => teamPolicy.policyFor?.(teamKeyOf(ctx, agent))?.canWriteBoard?.(name, board) === true,
        })
        if (authorization.ok !== true) refuse(authorization.code, authorization.detail)
        const result = await cp().mutateHot('v12/requirement-recorded', { requirementId: input.requirementId ?? input.id }, agent, (latest) => {
          const ledger = v12RequirementsState(latest)
          const recorded = recordRequirement(ledger, input)
          if (recorded.ok !== true) refuse('requirement-invalid', recorded.reason)
          latest.v12Requirements = ledger
          return recorded
        })
        return result
      }
      if (action === 'decision_record') {
        if (tier > 1) refuse('lead-or-tier-0-only', 'only a Team lead or tier 0 may record a decision')
        const input = args.input ?? {}
        const authorization = authorizeRequirementRecord({
          tier, memberName: mine.name, group: mine.group, input, kind: 'decision',
          taskRows: boardTasks(state).map((task) => ({
            task,
            board: boardIdForTask(state, task),
          })),
          existingRecords: v12RequirementsState(state).decisions,
          canWriteBoard: (name, board) => teamPolicy.policyFor?.(teamKeyOf(ctx, agent))?.canWriteBoard?.(name, board) === true,
        })
        if (authorization.ok !== true) refuse(authorization.code, authorization.detail)
        const result = await cp().mutateHot('v12/decision-recorded', { decisionId: input.decisionId ?? input.id }, agent, (latest) => {
          const ledger = v12RequirementsState(latest)
          const recorded = recordDecision(ledger, input)
          if (recorded.ok !== true) refuse('decision-invalid', recorded.reason)
          latest.v12Requirements = ledger
          return recorded
        })
        return result
      }
      if (action === 'inbox_list') {
        const doc = v12RoomStateView(state)
        const target = text(args.member) || mine.name
        if (tier !== 0 && target !== mine.name) refuse('inbox-read-scope', 'only the target or tier 0 may read an inbox')
        const limit = Math.max(1, Math.min(100, Number(args.input?.limit) || 30))
        const pendingOnly = args.input?.include_handled !== true
        const durableRows = Object.values(doc.inbox ?? {})
          .filter((row) => row.target === target && (!pendingOnly || !['handled', 'rejected'].includes(row.status)))
        const pendingDispatchRows = pendingDispatchInboxRows(state.dispatches, target)
        const rowsById = new Map(pendingDispatchRows.map((row) => [row.messageId, row]))
        for (const row of durableRows) {
          const id = row.messageId ?? row.inboxId
          const pending = rowsById.get(id)
          rowsById.set(id, pending === undefined
            ? row
            : {
                ...row,
                ...pending,
                inboxId: row.inboxId ?? pending.inboxId ?? id,
                inbox_id: row.inbox_id ?? row.inboxId ?? pending.inbox_id ?? id,
                status: row.status ?? pending.status,
                inboxStatus: row.status ?? null,
                pendingStatus: pending.status ?? null,
                source: 'dispatch-pending+inbox',
                ackable: true,
              })
        }
        const rows = [...rowsById.values()]
          .sort((left, right) => Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0))
        const wakes = Object.values(doc.wakes ?? {}).filter((row) => row.target === target && (!pendingOnly || !['handled', 'rejected'].includes(row.status)))
        return {
          target,
          total: rows.length,
          inbox: rows.slice(-limit).map((row) => ({
            ...row,
            inboxId: row.inboxId ?? row.messageId ?? null,
            inbox_id: row.inboxId ?? row.messageId ?? null,
            originalText: String(row.originalText ?? '').slice(0, 2000),
          })),
          wakes: wakes.slice(-limit).map((row) => ({
            ...row,
            wakeId: row.wakeId ?? row.wake_id ?? null,
            wake_id: row.wakeId ?? row.wake_id ?? null,
            inbox_id: row.inboxId ?? row.inbox_id ?? null,
          })),
          hasMore: rows.length > limit,
        }
      }
      if (action === 'ptc_receipts') {
        const input = args.input ?? {}
        const byKey = new Map()
        for (const row of [...(state.v14Receipts ?? []), ...volatilePtcReceipts]) {
          const key = text(row?.sessionId) + ':' + text(row?.callId)
          if (key.length > 1) byKey.set(key, row)
        }
        const rows = [...byKey.values()].filter((row) => tier === 0 || row.sessionId === text(agent.session?.id))
          .filter((row) => !input.callId || row.callId === input.callId)
          .filter((row) => !input.rootCallId || row.rootCallId === input.rootCallId)
        return { receipts: rows.slice(-Math.min(100, Number(input.limit) || 20)), total: rows.length }
      }
      if (action === 'waiting_list') {
        const input = args.input ?? {}
        const includeClosed = input.includeClosed === true || input.include_closed === true
        const visible = Object.values(state.v14Waiting?.tickets ?? {})
          .filter((row) => tier === 0 || canReadTask(state, findTask(state, row.taskId)))
        const derived = deriveWaitingTickets(state, ctx.agentTeams.listMembers?.(agent) ?? [])
          .filter((row) => tier === 0 || canReadTask(state, findTask(state, row.taskId)))
        const projection = projectWaitingTickets(state, {
          stored: visible,
          derived,
          members: ctx.agentTeams.listMembers?.(agent) ?? [],
          includeClosed,
          ticketId: input.ticketId ?? input.ticket_id ?? args.ticket_id,
          taskId: input.taskId ?? input.task_id ?? args.task_id,
          offset: input.offset,
          limit: input.limit,
        })
        return {
          ...projection,
          source: {
            kind: 'v14Waiting.tickets',
            authoritative: true,
            visibleStored: visible.length,
          },
        }
      }
      if (action === 'waiting_set' || action === 'waiting_resolve') {
        const input = args.input ?? {}
        const requestedTicketId = text(args.ticket_id ?? args.ticketId ?? input.ticketId ?? input.ticket_id)
        let taskId = text(args.task_id ?? input.taskId)
        if (action === 'waiting_resolve') {
          const inputVerdict = waitingResolveInputVerdict({ taskId, ticketId: requestedTicketId })
          if (inputVerdict.ok !== true) refuse(inputVerdict.code, inputVerdict.detail)
          if (taskId.length === 0 && requestedTicketId.length > 0) {
            const ticket = Object.values(state.v14Waiting?.tickets ?? {})
              .find((row) => text(row?.ticketId) === requestedTicketId)
            if (ticket === undefined) refuse('waiting-ticket-not-found', requestedTicketId)
            taskId = text(ticket.taskId)
          }
        }
        const result = await cp().mutateHot('v14/' + action, { taskId, actor: mine.name }, agent, (latest) => {
          const occurrence = selectTaskOccurrence(latest, taskId, args.board ?? input.board, mine)
          if (occurrence.ok !== true) refuse(occurrence.code, occurrence.detail)
          const task = occurrence.task
          const taskOwner = text(task.ownerName ?? task.contract?.owner)
          const requestedOwner = text(args.owner ?? input.owner)
          const owner = taskOwner || requestedOwner || mine.name
          const taskBoard = occurrence.boardId
          const explicitTicket = action === 'waiting_resolve' && requestedTicketId.length > 0
            ? latest.v14Waiting?.tickets?.[requestedTicketId]
            : undefined
          const ownerMember = (ctx.agentTeams.listMembers?.(agent) ?? [])
            .find((member) => text(member?.name ?? member?.agentName ?? member?.id) === taskOwner)
          const authorization = authorizeWaitingAction({
            tier,
            memberName: mine.name,
            group: mine.group,
            taskOwner,
            requestedOwner: requestedOwner || (taskOwner ? '' : owner),
            taskBoard,
            ownerGroup: text(ownerMember?.group ?? ownerMember?.groupId),
            ticket: explicitTicket,
            allowWaiterResolve: action === 'waiting_resolve',
            canWriteBoard: (name, board) => teamPolicy.policyFor?.(teamKeyOf(ctx, agent))?.canWriteBoard?.(name, board) === true,
          })
          if (authorization.ok !== true) refuse(authorization.code, authorization.detail)
          if (action === 'waiting_set') {
            const reason = text(input.reason)
            const rawCondition = input.unblockCondition ?? input.unblock_condition
            if (!reason || !rawCondition) {
              refuse('waiting-details-required', 'provide input.reason and input.unblockCondition; unblock_condition is accepted as an alias')
            }
            let unblockCondition
            try {
              unblockCondition = normalizeWaitingCondition(rawCondition)
            } catch (error) {
              refuse('waiting-condition-invalid', String(error?.message ?? error))
            }
            return recordWaiting(latest, {
              ...input,
              reason,
              unblockCondition,
              taskId,
              owner,
              waiter: mine.name,
              taskRevision: task.revision,
              status: 'open',
            }, mine.name)
          }
          const derivedGuard = waitingResolveDerivedGuard(latest, {
            taskId,
            owner,
            waiter: mine.name,
            responsible: requestedOwner || taskOwner || owner,
            ticketId: requestedTicketId,
            members: ctx.agentTeams.listMembers?.(agent) ?? [],
          })
          if (derivedGuard.ok !== true) {
            refuse(derivedGuard.code, derivedGuard.detail + '; candidates=' + JSON.stringify(derivedGuard.candidates))
          }
          const resolved = resolveWaiting(latest, {
            taskId,
            owner,
            waiter: mine.name,
            responsible: requestedOwner || taskOwner || owner,
            ticketId: requestedTicketId,
            resolution: input.resolution,
          }, mine.name)
          if (resolved !== undefined) return resolved
          const candidates = Object.values(latest.v14Waiting?.tickets ?? {})
            .filter((row) => row?.status === 'open' && String(row.taskId) === taskId)
            .map((row) => ({
              ticketId: String(row.ticketId),
              owner: row.owner ?? null,
              waiter: row.waiter ?? null,
              responsible: row.responsible ?? null,
            }))
          return candidates.length > 1
            ? { status: 'ticket-id-required', taskId, candidates }
            : { status: 'not-found', taskId, candidateCount: candidates.length, candidates }
        })
        if (action === 'waiting_set') {
          const fresh = snapshotHot()
          const stored = fresh.v14Waiting?.tickets?.[text(result?.ticketId)]
          if (stored === undefined || String(stored.status || 'open').toLowerCase() !== 'open') {
            refuse('waiting-not-persisted', 'waiting_set returned ticket "' + String(result?.ticketId ?? '')
              + '" but a fresh control-plane read cannot see it as open; do not assume the wait exists')
          }
        }
        return result
      }
      if (action === 'inbox_ack') {
        const requestedWakeId = text(args.wake_id ?? args.input?.wakeId ?? args.input?.wake_id)
        const requestedInboxId = text(args.inbox_id ?? args.inboxId ?? args.input?.inboxId ?? args.input?.inbox_id)
        const roomState = v12RoomStateView(state)
        const idVerdict = inboxAckIdentifierVerdict({
          wakeId: requestedWakeId,
          inboxId: requestedInboxId,
          roomState,
          memberName: mine.name,
          tier,
        })
        if (idVerdict.ok !== true) refuse(idVerdict.code, idVerdict.detail)
        if (requestedInboxId) {
          return cp().mutateHot('v12/inbox-ack', { inboxId: requestedInboxId, input: args.input }, agent, (latest) => {
            const verdict = acknowledgeInboxEntry(latest, {
              target: mine.name,
              inboxId: requestedInboxId,
              input: args.input ?? {},
              allowOtherTarget: tier === 0,
            })
            if (verdict.ok !== true) refuse(verdict.reason, requestedInboxId)
            return verdict
          }, { panelCache: true })
        }
        if (!requestedWakeId) {
          if (args.input?.all === true) {
            refuse('bulk-ack-unsupported', 'inbox_ack requires one explicit wake_id; call inbox_list and acknowledge wakes individually')
          }
          refuse('wake-id-required', 'call inbox_list first and pass exactly one top-level wake_id or inbox_id')
        }
        const wake = roomState.wakes?.[requestedWakeId]
        if (wake === undefined) {
          const available = Object.values(roomState.wakes ?? {})
            .filter((row) => tier === 0 || row.target === mine.name)
            .map((row) => row.wakeId)
            .filter(Boolean)
            .slice(0, 20)
          refuse('wake-not-found', requestedWakeId + '; available wake ids: ' + (available.length > 0 ? available.join(', ') : 'none'))
        }
        const authorization = authorizeInboxAck({ tier, memberName: mine.name, wake })
        if (authorization.ok !== true) refuse(authorization.code, authorization.detail)
        const result = await cp().mutateHot('v12/inbox-ack', { wakeId: requestedWakeId, input: args.input }, agent, (latest) => {
          const doc = v12RoomState(latest)
          const verdict = handleWakeBatch(doc, requestedWakeId, args.input ?? {})
          latest.v12RoomWake = doc
          return verdict
        }, { panelCache: true })
        return result
      }
      if (action === 'compaction_status') {
        const doc = v12CompactionState(state)
        if (tier !== 0) {
          doc.jobs = Object.fromEntries(Object.entries(doc.jobs).filter(([, row]) => row.owner === mine.name))
          doc.milestones = Object.fromEntries(Object.entries(doc.milestones).filter(([, row]) => row.owner === mine.name))
          doc.events = (doc.events ?? []).filter((row) => row.owner === mine.name || doc.jobs[row.jobId] || doc.milestones[row.milestoneId])
          if (args.job_id && !doc.jobs[args.job_id]) refuse('compaction-scope', args.job_id)
        }
        return {
          state: doc,
          resume: args.job_id ? buildCompactionResumeContext(doc, { jobId: args.job_id }) : null,
          firstAction: '重新读取 v12 计划及实施台账，再读取 v13 计划及实施台账',
        }
      }
      if (action === 'compaction_transition') {
        const doc = v12CompactionState(state)
        const job = args.job_id ? doc.jobs?.[args.job_id] : undefined
        const milestoneId = text(args.input?.milestoneId)
        const milestone = milestoneId ? doc.milestones?.[milestoneId] : undefined
        const authorization = authorizeCompactionTransition({
          tier,
          memberName: mine.name,
          job,
          milestone,
          requestedOwner: args.input?.owner,
        })
        if (authorization.ok !== true) refuse(authorization.code, authorization.detail)
        const result = await cp().mutateHot('v12/compaction-transition', { jobId: args.job_id, phase: args.phase, input: args.input }, agent, (latest) => {
          const doc = v12CompactionState(latest)
          let verdict
          if (args.phase === 'set') verdict = setMilestone(doc, args.input ?? {})
          else if (args.phase === 'done') verdict = doneMilestone(doc, args.input ?? {})
          else if (args.phase === 'wait') verdict = waitForHandoff(doc, args.job_id, args.input ?? {})
          else if (args.phase === 'ready') verdict = markHandoffReady(doc, args.job_id, args.input ?? {})
          else if (args.phase === 'start') verdict = startCompaction(doc, args.job_id, args.input ?? {})
          else if (args.phase === 'complete') verdict = completeCompaction(doc, args.job_id, args.input ?? {})
          else if (args.phase === 'fail') verdict = failCompaction(doc, args.job_id, args.input ?? {})
          else if (args.phase === 'retry') verdict = retryCompaction(doc, args.job_id, args.input ?? {})
          else verdict = transitionCompaction(doc, args.job_id, args.phase, args.input ?? {})
          latest.v12Compaction = doc
          return verdict
        })
        return result
      }
      if (action === 'evidence_query') {
        const all = allEvidence(state)
        const mine = member()
        const visibleEvidence = filterVisibleEvidence(all, {
          tier,
          mine,
          canReadTask: (row) => canReadTask(state, findTask(state, row.taskId), mine),
        })
        const registry = createEvidenceRegistry(visibleEvidence)
        const input = args.input ?? {}
        const requestedId = text(input.id ?? input.evidenceId ?? input.evidence_id)
        const requestedField = input.id !== undefined
          ? 'id'
          : input.evidenceId !== undefined ? 'evidenceId' : input.evidence_id !== undefined ? 'evidence_id' : null
        const resolved = requestedId.length > 0 ? resolveEvidenceId(registry, requestedId) : null
        const queryInput = { ...input }
        if (queryInput.taskId === undefined && args.task_id !== undefined) queryInput.taskId = args.task_id
        const rows = resolved === null ? queryEvidence(registry, queryInput) : resolved.rows
        const queryFormation = evidenceQueryFormation(queryInput)
        const queryKey = queryFormation.queryKey
        const visibleAuthors = [...new Set(visibleEvidence
          .map((row) => text(row?.recordedBy))
          .filter((value) => value.length > 0))].sort()
        const scopeDeclaration = {
          mode: Number(tier) === 0 ? 'all-authors' : 'reader-or-readable-task',
          reader: text(mine?.name) || null,
          visibleAuthors,
          visibleEvidence: visibleEvidence.length,
          totalEvidence: all.length,
          registryRevision: state.revision,
          stability: {
            reader: 'scope-dependent',
            writer: 'not-guaranteed',
            time: 'not-guaranteed',
            mechanism: 'not-isolated',
          },
          resolutionPolicy: {
            notFoundMeaning: 'not-visible-in-declared-scope',
            reuse: 're-resolve-before-citing',
            singleWriterRule: 'not-sufficient',
          },
        }
        return {
          ...evidenceQueryEnvelope({
            requestedId,
            requestedField,
            resolved,
            rows,
            total: all.length,
            visible: visibleEvidence.length,
            tier,
            queryKey,
            queryFormed: queryFormation.queryStatus === 'formed',
            queryFormation,
            scopeDeclaration,
          }),
          registryRevision: state.revision,
          evidenceScope: scopeDeclaration,
        }
      }
      if (action === 'review_package') {
        const mine = member()
        const registry = createEvidenceRegistry(filterVisibleEvidence(allEvidence(state), {
          tier,
          mine,
          canReadTask: (row) => canReadTask(state, findTask(state, row.taskId), mine),
        }))
        const tasks = args.input?.task_ids
          ? boardTasks(state).filter((task) => args.input.task_ids.map(String).includes(String(task.id)))
          : boardTasks(state)
        const readable = tasks.filter((task) => canReadTask(state, task))
        const reviewPackage = buildReviewPackage(readable, registry)
        const resourceScan = readable.map((task) => ({
          taskId: text(task.id ?? task.taskId),
          resourceScan: task.resourceScan ?? task.contract?.resourceScan ?? null,
        }))
        return {
          ...reviewPackage,
          package: reviewPackage,
          resourceScan,
          verificationPlans: readable.map((task) => buildVerificationPlan(task)),
        }
      }
      if (action === 'verification_plan') {
        const input = args.input ?? {}
        const task = args.task_id
          ? assertTaskRead(state, args.task_id)
          : boardTasks(state).find((row) => text(row.id) === text(input.taskId ?? input.task_id))
        if (!task) refuse('task-id-required', 'task_id or input.taskId is required')
        const recipe = selectVerificationRecipe(task)
        const plan = buildVerificationPlan(task, {
          recipe,
          now: Date.now(),
          exactShaRequired: input.exactShaRequired !== false,
        })
        const registry = createEvidenceRegistry(allEvidence(state).filter((row) =>
          tier === 0 || canReadTask(state, findTask(state, row.taskId))))
        return {
          plan,
          recipeFingerprint: recipeFingerprint(task, recipe),
          reuse: reuseEvidenceForPlan(plan, registry, {
            commitSha: input.commitSha ?? input.commit_sha,
            treeHash: input.treeHash ?? input.tree_hash,
          }),
          fanOut: checkFanOut(task, { history: input.history ?? [] }),
          effort: estimateTaskEffort(task, input.history ?? []),
        }
      }
      if (action === 'merge_status') {
        const merge = v12MergeState(state)
        merge.operations = Object.fromEntries(Object.entries(merge.operations ?? {}).filter(([, row]) => tier === 0 || canReadTask(state, findTask(state, row.taskId))))
        return {
          operations: args.input?.operation_id
            ? { [args.input.operation_id]: merge.operations?.[args.input.operation_id] ?? null }
            : merge.operations,
        }
      }
      if (action === 'merge_recover') {
        const merge = v12MergeState(state)
        const operation = merge.operations?.[args.input?.operation_id]
        if (operation === undefined) refuse('merge-operation-not-found', args.input?.operation_id)
        assertTaskRead(state, operation.taskId)
        return operation
      }
      if (action === 'context_pack') {
        const pack = buildContextPack(args.input ?? {})
        return { ...pack, rendered: renderContextPack(pack) }
      }
      if (action === 'timeline') {
        const events = v12EventState(state).filter((row) => tier === 0 || row.actor === mine.name)
        return {
          events: queryTimeline(events, args.input ?? {}),
          breakpoint: locateObservationBreakpoint(events, args.input ?? {}),
        }
      }
      if (action === 'replay') {
        return runReplay(args.input?.fixture ?? args.input, args.input?.options ?? {})
      }
      refuse('unsupported-action', action)
    },
  })))

  register(scoped.on('tools/post-execute', async (exec, result, next) => {
    const downstream = typeof next === 'function' ? await next() : { kind: 'accept' }
    const value = successfulToolValue(result, downstream)
    const tool = text(exec?.tool?.name ?? exec?.name)
    const args = exec?.arguments ?? {}
    const mutation = mutatesTeam(tool, args)
    const ptc = Boolean(exec?.rootCallId && exec.rootCallId !== exec.callId)
    if (!mutation && !ptc) return downstream
    let mirrorError
    const receipt = compactReceipt({ ...exec, agent: exec.agent ?? agent }, result, downstream)
    if (!mutation && ptc) {
      rememberVolatilePtcReceipt(receipt)
      return downstream
    }
    try {
      const control = cp()
      const commit = control.mutateHot
      // room_post already writes the panel cache through its append path;
      // doing it again here doubles the largest panel write on every post.
      const panelCache = ['send_message', 'team_wake', 'team_wake_superior', 'team_escalate',
        'team_room_close', 'team_room_decide', 'team_room_confirm', 'team_room_resolve'].includes(tool)
      await commit('v14/tool-receipt', { callId: receipt.callId, rootCallId: receipt.rootCallId, tool }, agent, (latest) => {
        if (value !== undefined && tool === 'team_task_create' && value.id) {
          const task = findTask(latest, value.id)
          if (!task) refuse('mirror-task-not-found', value.id)
          const contract = normalizeTaskContract({
            taskId: value.id, subject: value.subject ?? args.subject,
            deliverable: args.deliverable ?? value.deliverable ?? value.subject ?? args.subject,
            acceptanceCriteria: args.acceptance_criteria ?? value.acceptanceCriteria ?? [args.description ?? value.description],
            owner: value.ownerName ?? args.owner ?? '', writeScopes: value.writeScopes ?? args.write_scopes ?? [],
            dependencies: value.blockedBy ?? args.blocked_by ?? [],
            riskLevel: args.risk_level ?? value.riskLevel ?? 'medium', kind: value.workKind ?? args.kind ?? 'discussion',
          })
          task.contract = contract
          if (text(task.ownerName) && contract.kind !== 'edit' && Number(member()?.tier) <= 1) task.lifecycle = 'ready'
          task.contractDigest = contractDigest(contract)
          synchronizeTaskContract(task)
          delete task.approved
          mirrorTaskRequirement(latest, value.id, contract, 'task-contract-created')
        }
        if (value !== undefined && ['team_task_update', 'team_plan_propose', 'team_plan_approve', 'team_task_reconcile'].includes(tool)) {
          const task = findTask(latest, value.taskId ?? value.id ?? args.task_id)
          if (task) {
            synchronizeTaskContract(task)
            mirrorTaskRequirement(latest, task.id, task.contract, tool)
          }
        }
        if (value !== undefined && ['send_message', 'team_wake', 'team_wake_superior', 'team_escalate'].includes(tool)) {
          const messageId = messageIdOf(value, exec)
          const target = text(value.target ?? args.target)
          if (messageId && target) {
            const doc = v12RoomState(latest)
            const explicit = tool !== 'send_message' || args.delivery !== 'info'
            const body = args.message ?? args.summary ?? args.reason ?? ''
            const enqueued = enqueueInboxMessage(doc, { messageId, target, sender: memberName(),
              taskId: args.task_id, priority: args.urgency, originalText: body, wakeRequested: explicit,
              dedupeKey: value.dispatchId ?? messageId })
            if (!enqueued.ok) refuse('inbox-mirror-failed', enqueued.reason)
            if (explicit) {
              const requested = requestWake(doc, { target, messageId, sender: memberName(), originalText: body,
                priority: args.urgency, reason: args.reason ?? tool, dedupeKey: value.dispatchId ?? messageId })
              if (!requested.ok) refuse('wake-mirror-failed', requested.reason)
            }
            latest.v12RoomWake = doc
          }
        }
        if (value !== undefined && ['team_room_post', 'team_room_close', 'team_room_decide', 'team_room_confirm', 'team_room_resolve'].includes(tool)) {
          latest.v12RoomWake = v12RoomState(latest)
          if (tool === 'team_room_decide' && value.decisionId) {
            const roomDoc = v12RoomState(latest)
            const proposed = proposeDecision(roomDoc, {
              roomId: args.room_id,
              decisionId: value.decisionId,
              title: args.title,
              choice: args.choice,
              rationale: args.rationale,
              proposedBy: memberName(),
              requiredConfirmations: args.required_confirmations,
              confirmations: value.confirmations,
            })
            if (!proposed.ok) refuse('room-decision-mirror-failed', proposed.reason)
            if (value.status === 'confirmed') {
              const confirmed = confirmDecision(roomDoc, args.room_id, value.decisionId, {
                confirmedBy: value.confirmedBy ?? memberName(),
                rationale: args.rationale,
              })
              if (!confirmed.ok) refuse('room-decision-confirm-mirror-failed', confirmed.reason)
            }
            latest.v12RoomWake = roomDoc
            const ledger = v12RequirementsState(latest)
            const recorded = recordDecision(ledger, {
              decisionId: 'room:' + args.room_id + ':' + value.decisionId,
              status: value.status, choice: args.choice, title: args.title, rationale: args.rationale,
              scope: 'room:' + args.room_id, sourceMessageId: value.decisionId, source: 'team_room_decide',
            })
            if (!recorded.ok) refuse('decision-mirror-failed', recorded.reason)
            latest.v12Requirements = ledger
          }
          if (tool === 'team_room_confirm' && value.decisionId) {
            const roomDoc = v12RoomState(latest)
            const confirmed = confirmDecision(roomDoc, args.room_id, value.decisionId, {
              confirmedBy: memberName(),
              rationale: args.rationale,
              evidenceLinks: args.evidence_links,
            })
            if (!confirmed.ok) refuse('room-decision-confirm-mirror-failed', confirmed.reason)
            latest.v12RoomWake = roomDoc
          }
          if (tool === 'team_room_resolve' && value.roomId && value.unresolvedId) {
            const roomDoc = v12RoomState(latest)
            let resolved = resolveUnresolved(roomDoc, value.roomId, value.unresolvedId, {
              resolution: value.resolution,
              resolvedBy: memberName(),
            })
            if (resolved.ok !== true && resolved.reason === 'unresolved-not-found' && args.text) {
              const byText = Object.values(roomDoc.unresolved?.[value.roomId] ?? {})
                .find((item) => String(item?.text ?? '').replace(/\s+/g, ' ').trim()
                  === String(args.text).replace(/\s+/g, ' ').trim())
              if (byText !== undefined) {
                resolved = resolveUnresolved(roomDoc, value.roomId, byText.itemId, {
                  resolution: value.resolution,
                  resolvedBy: memberName(),
                })
              }
            }
            latest.v12RoomWake = roomDoc
          }
        }
        if (value !== undefined && tool === 'team_milestone' && args.action === 'done' && value.armed === true) {
          const milestoneId = 'legacy:' + memberName() + ':' + String(value.stage ?? 'milestone')
          const doc = v12CompactionState(latest)
          setMilestone(doc, { milestoneId, owner: memberName(), goal: value.stage, acceptance: value.doneWhen ? [value.doneWhen] : [] })
          doneMilestone(doc, { milestoneId })
          latest.v12Compaction = doc
        }
        if (value !== undefined && tool === 'team_evidence_record' && value.evidenceId) {
          const registry = createEvidenceRegistry(allEvidence(latest))
          registerEvidence(registry, { ...value, id: value.evidenceId,
            status: value.status === 'recorded' ? 'passed' : value.status, evidenceRef: value.evidenceId })
          latest.v12Evidence = registry
        }
        if (value !== undefined && tool === 'team_merge' && args.task_id) {
          const merge = v12MergeState(latest)
          const operationId = 'merge:' + args.task_id + ':' + String(value.sourceSha ?? value.commit ?? 'pending')
          merge.operations[operationId] = { operationId, taskId: args.task_id,
            status: value.merged === true ? 'verified' : 'recovery-needed',
            source: value.source ?? null, destination: value.destination ?? null,
            sourceSha: value.sourceSha ?? null, targetSha: value.commit ?? null,
            previousSha: value.previous ?? null, ancestorVerified: value.ancestorVerified === true,
            previousMeaning: value.previousMeaning ?? null,
            destinationBefore: value.destinationBefore ?? value.previous ?? null,
            sourceHead: value.sourceHead ?? value.sourceSha ?? null,
            mergeBase: value.mergeBase ?? null,
            fastForwarded: value.fastForwarded === true,
            createdCommit: value.createdCommit === true,
            alreadyUpToDate: value.alreadyUpToDate === true,
            verifiedAt: Date.now(), lastError: value.merged === true ? null : value.reason ?? 'merge did not verify' }
          latest.v12MergeOperations = merge
        }
        latest.v14Receipts = [...(latest.v14Receipts ?? []).filter((row) =>
          row.callId !== receipt.callId || row.sessionId !== receipt.sessionId), receipt].slice(-500)
        if (mutation) {
          const members = ctx.agentTeams.listMembers?.(agent) ?? []
          latest.v12ReadyQueue = buildReadyQueue(boardTasks(latest), members, Object.values(latest.leases ?? {}), {
            now: Date.now(),
            plans: latest.plans ?? {},
          })
          try {
            const row = makeObservation(memberName(), tool + '/post', {
              callId: receipt.callId, correlationId: receipt.rootCallId, causationId: receipt.callId,
              taskId: receipt.ids.taskId ?? args.task_id, payload: { receipt }, time: { wall: Date.now() },
            }, result.isError ? 'failed' : 'handled')
            latest.v12Events = [...v12EventState(latest), row].slice(-256)
          } catch (error) {
            latest.v14ObservationHealth = { status: 'degraded', callId: receipt.callId, error: String(error?.message ?? error).slice(0, 300) }
          }
        }
        return receipt
      }, { panelCache, deferMs: 250 })
    } catch (error) {
      mirrorError = error
      const failed = compactReceipt({ ...exec, agent: exec.agent ?? agent }, result, downstream, error)
      try {
        await cp().mutateHot('v14/mirror-failed', { callId: receipt.callId, tool }, agent, (latest) => {
          latest.v14Receipts = [...(latest.v14Receipts ?? []), failed].slice(-500)
          latest.v14MirrorHealth = { status: 'degraded', lastFailure: failed }
        }, { deferMs: 250 })
      } catch (receiptError) {
        ctx.logger?.warn?.('team-v14 mirror receipt persistence failed: ' + String(receiptError?.message ?? receiptError))
      }
      ctx.logger?.warn?.('team-v14 mirror failed; query the original effect before retrying: ' + String(error?.message ?? error))
    }
    if (mirrorError && downstream?.kind === 'accept' && Array.isArray(result?.content)) {
      return withReceiptNotice(downstream, result,
        '[Team receipt] Original tool effect may already be committed. Mirror failed; do not repeat this call. callId=' + receipt.callId)
    }
    return downstream
  }))
  register(scoped.on('tools/pre-execute', async (exec, next) => {
    const tool = text(exec?.tool?.name ?? exec?.name)
    const args = exec?.arguments ?? {}
    let gateStage = 'start'
    try {
      if (tool === 'team_task_update' && (args.action === 'claim' || args.phase === 'execution')) {
        gateStage = 'snapshotHot'
        const state = snapshotHot()
        const task = findTask(state, args.task_id)
        if (task !== undefined) {
          gateStage = 'migrateAndValidate'
          const migrated = migrateAndValidate(task, {
            allowLegacy: true,
            allowReadOnly: true,
            claimOwner: args.action === 'claim' ? memberName() : undefined,
          })
          if (migrated.verdict.ok !== true && migrated.verdict.valid !== true) {
            refuse('task-contract-ready-gate', migrated.verdict.reason ?? migrated.verdict.reasons)
          }
          gateStage = 'evaluateReadyGate'
          const gate = evaluateReadyGate({ ...task, contract: migrated.contract }, {
            tasks: boardTasks(state),
            leases: Object.values(state.leases ?? {}),
            members: (ctx.agentTeams.listMembers?.(agent) ?? []).map((row) => ({
              name: text(row?.name ?? row?.agentName ?? row?.id),
              tier: Number(row?.tier ?? -1),
              group: text(row?.group ?? row?.groupId),
              frozen: row?.status === 'frozen' || row?.frozen === true,
            })),
            claimOwner: args.action === 'claim' ? memberName() : undefined,
            allowReadOnly: true,
            now: Date.now(),
          })
          if (gate.ok !== true && gate.allowed !== true) {
            const reasons = Array.isArray(gate.reasons) ? gate.reasons.map(String) : [String(gate.reason ?? 'not-ready')]
            const primary = reasons.includes('already-running')
              ? 'task-already-running'
              : reasons.includes('lease-revision-mismatch')
                ? 'lease-revision-mismatch'
                : reasons.includes('scope-conflict') && Array.isArray(gate.conflicts) && gate.conflicts.length > 0
                  ? 'scope-conflict'
                  : reasons.includes('owner-unknown')
                    ? 'owner-unknown'
                    : 'task-not-ready'
            const hint = primary === 'task-already-running'
              ? '; this task already has an active owner/run; do not claim it again'
              : primary === 'lease-revision-mismatch'
                ? '; refresh the task/contract revision or reopen the task before retrying'
                : primary === 'scope-conflict'
                  ? '; conflicts=' + JSON.stringify(gate.conflicts)
                  : ''
            refuse(primary, reasons.join(', ') + hint)
          }
        }
      }
      return typeof next === 'function' ? next() : { kind: 'allow' }
    } catch (error) {
      if (error?.code === 'task-contract-ready-gate' || error?.code === 'task-ready-gate') throw error
      if (ctx.logger !== undefined) ctx.logger.warn?.('team-v12 pre-execute gate failed: ' + String(error?.message ?? error))
      refuse('task-contract-gate-unavailable', describeGateUnavailable(tool, args, gateStage, error))
    }
  }))

  register(scoped.on('agent/pre-step', async ({ agent: stepped, messages = [], step }, next) => {
    const decision = typeof next === 'function' ? await next() : { kind: 'enter', messages }
    if (decision?.kind === 'reject') return decision
    const mine = membershipFor(ctx, stepped)
    if (!mine) return decision
    try {
      let state = snapshotContext(mine.name)
      const sessionId = text(stepped.session?.id)
      const committed = recentDerivedMessages(stepped.session)
      const receipts = new Set((state.v14DeliveryReceipts ?? []).map((row) => row.receipt))
      // Repair a lost post-commit receipt after restart using actual history,
      // never pending input. No history is rewritten or pruned here.
      let receiptsChanged = false
      for (const message of committed) {
        const manifest = parseContextManifest(message)
        const nativeIds = [...nativeMessageIds([message])]
        const receipt = text(stepped.session?.id) + ':' + (manifest?.receiptId ?? contentHash(nativeIds.join('|')))
        if (receipts.has(receipt)) continue
        if (!manifest && !nativeIds.some((id) => state.v12RoomWake?.inbox?.[id]?.target === mine.name
          && !state.v12RoomWake.inbox[id].injectionReceipt)) continue
        await acknowledgeCommittedMessage(stepped.session, message, state)
        receiptsChanged = true
      }
      if (receiptsChanged) state = snapshotContext(mine.name)
      const doc = v12RoomStateView(state)
      const visible = [...committed, ...(decision.messages ?? messages)]
      const nativeIds = nativeMessageIds(visible)
      const sources = []
      const identity = identitySource(config.rolesDir, mine)
      if (identity) sources.push(identity)
      const owned = boardTasks(state).filter((task) => activeTask(task) && text(task.ownerName ?? task.contract?.owner) === mine.name)
      for (const task of owned) sources.push({
        id: 'task:' + task.id, revision: task.revision ?? 1, priority: 5, required: true, safetyCritical: true,
        content: JSON.stringify(taskContext(task)),
        metadata: { fetch: { action: 'task_contract_get', task_id: task.id } },
      })
      const requirements = scopedContextRequirements(state, mine)
      const contextRequirements = requirements
      for (const row of contextRequirements.requirements) {
        const taskId = Array.isArray(row.taskIds) && row.taskIds.length > 0 ? String(row.taskIds[0]) : null
        const fetch = { action: 'requirements_snapshot', input: taskId ? { taskId } : {} }
        const content = Number(mine.tier) === 0
          ? {
              requirementId: row.requirementId, revision: row.revision, status: row.status,
              scope: row.scope, taskIds: row.taskIds,
              summary: contextSummary(row.text ?? row.quote),
              acceptanceSummary: Array.isArray(row.acceptance) && row.acceptance.length > 0
                ? row.acceptance.length + ' acceptance criteria; fetch the full ledger before acting'
                : undefined,
              fetch,
            }
          : { ...row, history: undefined }
        sources.push({
          id: 'requirement:' + row.requirementId, revision: row.revision, priority: 8, required: true,
          content: JSON.stringify(content),
          metadata: { fetch },
        })
      }
      for (const row of contextRequirements.decisions) {
        const taskId = Array.isArray(row.taskIds) && row.taskIds.length > 0 ? String(row.taskIds[0]) : null
        const fetch = { action: 'requirements_snapshot', input: taskId ? { taskId } : {} }
        const content = Number(mine.tier) === 0
          ? {
              decisionId: row.decisionId, revision: row.revision, status: row.status,
              scope: row.scope, taskIds: row.taskIds,
              choice: contextSummary(row.choice ?? row.title),
              rationale: contextSummary(row.rationale),
              fetch,
            }
          : { ...row, history: undefined }
        sources.push({
          id: 'decision:' + row.decisionId, revision: row.revision, priority: 9, required: true,
          content: JSON.stringify(content),
          metadata: { fetch },
        })
      }
      for (const roomId of roomIds(doc)) {
        const room = buildRoomRecoverySnapshot(doc, roomId, mine.name)
        if (room.ok !== true) continue
        const roomFetch = { action: 'room_snapshot', room_id: roomId, input: {} }
        if (room.latestSummary?.summary) sources.push({
          id: 'room-summary:' + roomId, revision: room.latestSummary.summaryRevision ?? 1,
          content: room.latestSummary.summary, priority: 12, required: true, metadata: { fetch: roomFetch },
        })
        for (const row of room.unresolved ?? []) sources.push({
          id: 'unresolved:' + roomId + ':' + (row.itemId ?? row.id), revision: row.revision ?? 1,
          content: JSON.stringify(row), priority: 11, required: true, metadata: { fetch: roomFetch },
        })
        for (const row of room.decisions ?? []) sources.push({
          id: 'room-decision:' + roomId + ':' + row.decisionId, revision: row.revision ?? 1,
          content: JSON.stringify(row), priority: 10, required: true, metadata: { fetch: roomFetch },
        })
        // Latest unread discussion is most useful; receipts still prevent the
        // durable cursor from skipping any earlier relevant, undelivered row.
        for (const [index, row] of [...(room.messages ?? [])].reverse().entries()) {
          if (nativeIds.has(row.messageId) || doc.inbox?.[row.messageId]) continue
          sources.push({ id: 'room:' + roomId + ':' + row.messageId, revision: row.revision ?? 1,
            content: row.content, priority: 30 + index / 1000, required: false,
            metadata: { roomId, messageId: row.messageId, fetch: roomFetch } })
        }
      }
      for (const row of Object.values(doc.inbox ?? {})) {
        if (row.target !== mine.name || ['handled', 'rejected'].includes(row.status) || nativeIds.has(row.messageId)) continue
        sources.push({ id: 'inbox:' + row.messageId, revision: 1,
          content: '[' + row.sender + '] ' + row.originalText,
          priority: row.wakeRequested ? 15 : 40, required: false,
          metadata: { inboxId: row.messageId, fetch: { action: 'inbox_list', input: {} } } })
      }
      const cost = costGuard({ events: state.v12Events ?? [], threshold: config.costAlertThreshold ?? 25000 })
      if (cost.alert && Number(mine.tier) <= 1) sources.push({
        id: 'cost-guard', revision: 1, content: '[team cost guard] ' + cost.reason, priority: 45,
      })
      const epoch = doc.contextEpochs?.[sessionId]
      const cursorKey = sessionId + '::' + mine.name
      const cursor = doc.contextCursors?.[cursorKey]
      const baselinePending = Boolean(epoch?.compactionId)
        && cursor?.baselineId !== epoch.compactionId
        && !(state.v14DeliveryReceipts ?? []).some((row) => row.member === mine.name
          && row.sessionId === sessionId && row.baselineId === epoch.compactionId)
      const configuredCap = Number(config.contextPackMaxTokens) || 12000
      const safetyFallback = cp().providerSafety?.(mine.name)
      const fallbackCap = Math.max(256, Number(config.providerSafetyFallbackMaxTokens) || 1200)
      const tierCap = safetyFallback !== undefined && safetyFallback !== null
        ? Math.min(configuredCap, fallbackCap)
        : Number(mine.tier) === 0
        ? Math.min(configuredCap, Number(config.tier0ContextPackMaxTokens) || 6000)
        : configuredCap
      const deltaCap = safetyFallback !== undefined && safetyFallback !== null
        ? Math.min(fallbackCap, Math.max(256, Number(config.contextDeltaMaxTokens) || 2500))
        : Math.max(256, Number(config.contextDeltaMaxTokens) || 2500)
      const fullBudget = baselinePending || Number(step ?? 0) <= 1
      if (safetyFallback !== undefined && safetyFallback !== null) {
        sources.push({
          id: 'provider-safety-fallback',
          revision: Number(safetyFallback.updatedAt ?? 1),
          priority: 0,
          required: true,
          safetyCritical: true,
          content: JSON.stringify({
            reason: safetyFallback.reason,
            attempts: safetyFallback.attempts,
            requestBytes: safetyFallback.requestBytes,
            requestTokens: safetyFallback.requestTokens,
            expiresAt: safetyFallback.expiresAt,
            instruction: 'Use the reduced context pack, fetch omitted details explicitly, and do not resend the refused full pack.',
          }),
        })
      }
      const delivery = buildContextDelivery({
        sources, visible, acknowledged: [...(state.v14DeliveryReceipts ?? []), ...(cursor ? [cursor] : [])],
        member: mine.name, sessionId, force: baselinePending,
        baselineId: baselinePending ? epoch.compactionId : null,
        maxTokens: Math.max(256, Math.min(fullBudget ? tierCap : Math.min(tierCap, deltaCap),
          Number(config.windowTokens) || 1048576) - estimateMessagesTokens(decision.messages ?? [])),
      })
      if (delivery.failClosed) {
        const debt = delivery.debtItems.map((row) => row.id + (row.fetch ? ' via ' + JSON.stringify(row.fetch) : ''))
        return {
          kind: 'reject',
          reason: 'team-context-safety-debt: required identity or task contract was omitted; fetch it before continuing: '
            + debt.join(', '),
        }
      }
      if (!delivery.body) return decision
      const notice = createUserMessage({
        content: [{ type: 'text', text: delivery.body }],
        source: { kind: 'team-message', plugin: name, form: 'snapshot', summary: 'versioned Team context delta' },
      })
      return { ...decision, messages: [...(decision.messages ?? messages), notice] }
    } catch (error) {
      ctx.logger?.warn?.('team-v14 context assembly failed: ' + String(error?.message ?? error))
      return { kind: 'reject', reason: 'team-context-unavailable: cannot safely assemble current requirements; ' + String(error?.message ?? error).slice(0, 300) }
    }
  }))

  register(scoped.on('agent/status', async ({ agent: changed, status }) => {
    if (status !== 'idle') return
    try {
      await refreshDerived(changed)
      const state = snapshotHot()
      const doc = v12RoomState(state)
       const roster = typeof ctx.agentTeams?.listMembers === 'function' ? ctx.agentTeams.listMembers(changed) : []
       const ownIds = new Set(roster.map((peer) => String(peer.id ?? peer.name ?? '')))
       const active = ctx.agents.list().some((peer) => ownIds.has(String(peer.id ?? peer.name ?? peer.session?.id ?? ''))
         && ['running', 'provisioning'].includes(String(peer.status ?? peer.state ?? '')))
      const episode = evaluateStopEpisode(doc, {
        projectId: state.rootId,
        teamId: state.rootId,
        active,
        now: Date.now(),
      })
      if (episode.notify === true) {
        await cp().mutateHot('v12/stop-episode', { episodeId: episode.episode.episodeId }, changed, (latest) => {
          latest.v12RoomWake = doc
          return episode
        })
      }
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('team-v12 status refresh failed: ' + String(error?.message ?? error))
    }
  }))

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}

export function apply(ctx, config = {}) {
  const resolved = {
    ...config,
    controlDir: text(config.controlDir) || join(process.env.DSH_HOME ?? process.cwd(), 'team-control-plane'),
    pluginDir: text(config.pluginDir) || join(process.env.DSH_HOME ?? process.cwd(), 'profiles', 'web', 'plugins'),
    profile: text(config.profile) || 'web',
    rolesDir: text(config.rolesDir) || undefined,
  }
  const pruneMarker = text(config.contextPruneMarker) || join(resolved.pluginDir, '.context-prune-request.json')
  const runOneShotPrune = () => {
    if (!existsSync(pruneMarker)) return
    let request
    try {
      request = JSON.parse(readFileSync(pruneMarker, 'utf8'))
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('context-prune marker is invalid: ' + String(error?.message ?? error))
      return
    }
    const targets = new Set((Array.isArray(request?.sessionIds) ? request.sessionIds : []).map(text).filter(Boolean))
    if (targets.size === 0) return
    const results = []
    const busy = []
    for (const agent of ctx.agents.list()) {
      const sessionId = text(agent?.session?.id)
      if (!targets.has(sessionId)) continue
      const status = text(agent?.status ?? agent?.state).toLowerCase()
      if (status === 'running' || status === 'provisioning') {
        busy.push(sessionId)
        continue
      }
      results.push({ sessionId, ...pruneHistoricalContextPacks(agent, request?.keep ?? 1) })
    }
    if (busy.length > 0 || results.length !== targets.size) {
      if (ctx.logger !== undefined) {
        ctx.logger.warn?.('context-prune waiting for idle sessions: '
          + JSON.stringify({ missing: [...targets].filter((id) => !results.some((row) => row.sessionId === id)), busy }))
      }
      return
    }
    const resultPath = pruneMarker + '.result.json'
    try {
      writeFileSync(resultPath, JSON.stringify({ ok: true, results }, null, 2) + '\n', 'utf8')
      renameSync(pruneMarker, pruneMarker + '.done')
    } catch (error) {
      if (ctx.logger !== undefined) ctx.logger.warn?.('context-prune result write failed: ' + String(error?.message ?? error))
    }
  }
  const installed = new Map()
  const maybeInstall = (agent) => {
    if (installed.has(agent) || membershipFor(ctx, agent) === undefined) return
    installed.set(agent, install(agent, ctx, resolved))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => {
    maybeInstall(agent)
    runOneShotPrune()
  })
  ctx.on('agent/status', ({ status }) => {
    if (status === 'idle') runOneShotPrune()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
  })
  runOneShotPrune()
  ctx.effect(() => () => {
    for (const dispose of installed.values()) {
      try { dispose() } catch {}
    }
    installed.clear()
    // HMR replaces this module while other long-lived plugins may still hold
    // an old import graph. Release the bounded parsed/cold caches explicitly
    // so repeated reloads cannot retain multi-megabyte snapshots.
    try { controlPlane.resetControlPlaneCache?.() } catch {}
  }, 'team-v12-runtime.scoped()')
}
