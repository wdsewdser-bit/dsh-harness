/**
 * v12 causal delivery observability.
 *
 * Events describe observations only. A queued event never implies delivery,
 * a delivered event never implies injection, and an injected event never
 * implies handling. Timeline APIs are read-only and never wake a member.
 */

import { createHash, randomUUID } from 'node:crypto'
import { redactSecrets } from './team-v12-runtime-facts.mjs'

export const OBSERVATION_SCHEMA_VERSION = 1
export const DELIVERY_STAGES = Object.freeze([
  'requested',
  'queued',
  'dispatched',
  'delivered',
  'injected',
  'acknowledged',
  'handled',
])
export const TERMINAL_OBSERVATION_STAGES = Object.freeze(['rejected', 'failed'])
export const ALL_OBSERVATION_STAGES = Object.freeze([...DELIVERY_STAGES, ...TERMINAL_OBSERVATION_STAGES])
export const OBSERVATION_RESULTS = Object.freeze(['observed', 'ok', 'accepted', 'rejected', 'failed', 'pending'])

const STAGE_INDEX = new Map(DELIVERY_STAGES.map((stage, index) => [stage, index]))
const TERMINAL_STAGE_SET = new Set(TERMINAL_OBSERVATION_STAGES)
const LINK_NAMES = Object.freeze([
  'taskId',
  'teamId',
  'sessionId',
  'wakeId',
  'messageId',
  'roomId',
  'cursor',
  'turnId',
  'toolCallId',
  'operationId',
  'providerRequestId',
])

const asArray = (value) => Array.isArray(value) ? value : []
const text = (value) => String(value ?? '').trim()

function stableJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
    .join(',') + '}'
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeDeep(child)
  return Object.freeze(value)
}

function normalizeTime(input, fallbackMonotonic) {
  const time = input?.time ?? input
  const monotonicValue = time?.monotonic ?? input?.monotonic ?? fallbackMonotonic
  const wallValue = time?.wall ?? input?.wall ?? input?.at ?? null
  const wall = wallValue === null || wallValue === undefined
    ? null
    : wallValue instanceof Date
      ? wallValue.toISOString()
      : typeof wallValue === 'number'
        ? new Date(wallValue).toISOString()
        : String(wallValue)
  return {
    wall,
    monotonic: Number.isFinite(Number(monotonicValue)) ? Number(monotonicValue) : null,
    estimated: time?.estimated === true || input?.estimated === true,
  }
}

function normalizePlugin(input = {}) {
  const plugin = input.plugin ?? {}
  return {
    id: text(input.pluginId ?? plugin.id ?? plugin.name) || null,
    version: text(input.pluginVersion ?? plugin.version) || null,
    entryHash: text(input.entryHash ?? plugin.entryHash ?? plugin.sha256) || null,
  }
}

function normalizeLinks(input = {}) {
  const source = input.links ?? input
  return Object.fromEntries(LINK_NAMES.map((name) => [name, source?.[name] ?? null]))
}

function normalizeResult(input = {}) {
  const result = input.result ?? {}
  const status = text(result.status ?? input.resultStatus ?? input.status) || 'observed'
  return {
    status,
    errorCode: result.errorCode ?? input.errorCode ?? null,
    message: result.message ?? input.error ?? null,
    retryable: result.retryable ?? input.retryable ?? null,
  }
}

function normalizeRetry(input = {}) {
  const retry = input.retry ?? {}
  return {
    attempt: Number.isFinite(Number(retry.attempt ?? input.attempt))
      ? Number(retry.attempt ?? input.attempt)
      : 0,
    maxAttempts: Number.isFinite(Number(retry.maxAttempts ?? input.maxAttempts))
      ? Number(retry.maxAttempts ?? input.maxAttempts)
      : null,
    reason: retry.reason ?? input.retryReason ?? null,
  }
}

function mergeTraceContext(context = {}, input = {}) {
  return {
    correlationId: text(input.correlationId ?? context.correlationId) || null,
    causationId: text(input.causationId ?? context.causationId) || null,
    profile: input.profile ?? context.profile ?? null,
    revision: input.revision ?? context.revision ?? null,
    plugin: normalizePlugin({ ...context, ...input }),
    actor: input.actor ?? context.actor ?? null,
    tool: input.tool ?? context.tool ?? null,
  }
}

/**
 * Create a new correlation context.
 *
 * @param {object} [input] Optional correlation and runtime metadata.
 * @returns {{ correlationId: string, causationId: string|null, profile: string|null, revision: unknown, plugin: object, actor: string|null, tool: string|null }}
 */
export function createTraceContext(input = {}) {
  return {
    correlationId: text(input.correlationId) || 'corr-' + randomUUID(),
    causationId: text(input.causationId) || null,
    profile: input.profile ?? null,
    revision: input.revision ?? null,
    plugin: normalizePlugin(input),
    actor: input.actor ?? null,
    tool: input.tool ?? null,
  }
}

/**
 * Propagate a correlation ID while setting the current event as the cause.
 *
 * @param {object} parent Parent context or event.
 * @param {object} [overrides] Fields to override.
 * @returns {object} Child context.
 */
export function propagateTraceContext(parent = {}, overrides = {}) {
  const inherited = {
    correlationId: parent.correlationId ?? parent.trace?.correlationId,
    causationId: parent.eventId ?? parent.causationId ?? null,
    profile: parent.profile,
    revision: parent.revision,
    plugin: parent.plugin,
    actor: parent.actor,
    tool: parent.tool,
    ...overrides,
  }
  return createTraceContext(inherited)
}

export const deriveTraceContext = propagateTraceContext

/**
 * Build a normalized observation event.
 *
 * @param {{
 *   eventId?: string,
 *   correlationId: string,
 *   causationId?: string|null,
 *   stage: string,
 *   eventType?: string,
 *   revision?: unknown,
 *   profile?: string,
 *   plugin?: object,
 *   actor?: string,
 *   tool?: string,
 *   result?: object,
 *   retry?: object,
 *   time?: object,
 *   links?: object,
 *   payload?: object
 * }} input Event fields.
 * @param {object} [context] Default fields propagated from a parent event.
 * @returns {object} Frozen event.
 */
export function createObservationEvent(input = {}, context = {}) {
  const merged = mergeTraceContext(context, input)
  const stage = text(input.stage ?? input.eventType)
  if (!ALL_OBSERVATION_STAGES.includes(stage)) throw new Error('unsupported observation stage "' + stage + '"')
  if (!merged.correlationId) throw new Error('correlationId is required')
  const eventId = text(input.eventId) || 'evt-' + digest({
    correlationId: merged.correlationId,
    causationId: merged.causationId,
    stage,
    revision: merged.revision,
    actor: merged.actor,
    tool: merged.tool,
    time: input.time ?? null,
    links: input.links ?? null,
  }).slice(0, 24)
  const event = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    eventId,
    eventType: text(input.eventType) || stage,
    correlationId: merged.correlationId,
    causationId: merged.causationId,
    stage,
    revision: merged.revision,
    profile: merged.profile,
    plugin: merged.plugin,
    pluginId: merged.plugin.id,
    pluginVersion: merged.plugin.version,
    entryHash: merged.plugin.entryHash,
    actor: merged.actor,
    tool: merged.tool,
    result: normalizeResult(input),
    retry: normalizeRetry(input),
    time: normalizeTime(input.time, input.sequence),
    sequence: Number.isFinite(Number(input.sequence)) ? Number(input.sequence) : null,
    links: normalizeLinks(input),
    payload: redactSecrets(input.payload ?? null),
  }
  const validation = validateObservationEvent(event)
  if (!validation.ok) throw new Error(validation.errors.join('; '))
  return freezeDeep(event)
}

/**
 * Validate an observation event.
 *
 * @param {object} event Candidate event.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateObservationEvent(event) {
  const errors = []
  if (!event || typeof event !== 'object') return { ok: false, errors: ['event must be an object'] }
  if (!text(event.eventId)) errors.push('eventId is required')
  if (!text(event.correlationId)) errors.push('correlationId is required')
  if (!ALL_OBSERVATION_STAGES.includes(text(event.stage))) errors.push('unsupported stage')
  if (!event.time || typeof event.time !== 'object') errors.push('time is required')
  if (!event.result || typeof event.result !== 'object') errors.push('result is required')
  if (event.result && !OBSERVATION_RESULTS.includes(text(event.result.status))) errors.push('unsupported result status')
  return { ok: errors.length === 0, errors }
}

function eventList(events) {
  if (events instanceof ObservationTimeline) return events.all()
  return asArray(events)
}

function compareEvents(left, right) {
  const leftMonotonic = left?.time?.monotonic
  const rightMonotonic = right?.time?.monotonic
  if (Number.isFinite(leftMonotonic) && Number.isFinite(rightMonotonic) && leftMonotonic !== rightMonotonic) {
    return leftMonotonic - rightMonotonic
  }
  const leftSequence = Number(left?.sequence)
  const rightSequence = Number(right?.sequence)
  if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) {
    return leftSequence - rightSequence
  }
  const leftWall = Date.parse(left?.time?.wall ?? '')
  const rightWall = Date.parse(right?.time?.wall ?? '')
  if (Number.isFinite(leftWall) && Number.isFinite(rightWall) && leftWall !== rightWall) return leftWall - rightWall
  return String(left?.eventId ?? '').localeCompare(String(right?.eventId ?? ''))
}

function matchesQuery(event, query = {}) {
  if (query.correlationId && event.correlationId !== query.correlationId) return false
  if (query.causationId && event.causationId !== query.causationId) return false
  if (query.stage && event.stage !== query.stage) return false
  if (query.profile && event.profile !== query.profile) return false
  if (query.actor && event.actor !== query.actor) return false
  if (query.tool && event.tool !== query.tool) return false
  if (query.eventType && event.eventType !== query.eventType) return false
  for (const name of LINK_NAMES) {
    if (query[name] !== undefined && event.links?.[name] !== query[name]) return false
  }
  return true
}

/**
 * Query a timeline without mutating events or triggering side effects.
 *
 * @param {Array|ObservationTimeline} events Events to inspect.
 * @param {object} [query] Correlation, link, actor, tool or stage filters.
 * @returns {object[]} Sorted event clones.
 */
export function queryTimeline(events, query = {}) {
  return eventList(events)
    .filter((event) => matchesQuery(event, query))
    .slice()
    .sort(compareEvents)
    .map(clone)
}

function confirmedStages(events) {
  const confirmed = new Set()
  for (const event of events) {
    if (event.result?.status === 'failed' || event.result?.status === 'rejected') continue
    confirmed.add(event.stage)
  }
  return confirmed
}

/**
 * Locate the last observed stage and the first missing delivery stage.
 *
 * @param {Array|ObservationTimeline} events Events to inspect.
 * @param {object} [query] Timeline filter.
 * @returns {{
 *   correlationId: string|null,
 *   observedStages: string[],
 *   confirmedStages: string[],
 *   lastObservedStage: string|null,
 *   lastSuccessfulStage: string|null,
 *   expectedNextStage: string|null,
 *   missingStages: string[],
 *   terminal: boolean,
 *   outcome: string,
 *   reason: string
 * }}
 */
export function locateObservationBreakpoint(events, query = {}) {
  const rows = queryTimeline(events, query)
  const observedStages = [...new Set(rows.map((event) => event.stage))]
  const confirmed = confirmedStages(rows)
  const terminalEvent = [...rows].reverse().find((event) =>
    TERMINAL_STAGE_SET.has(event.stage)
      || event.result?.status === 'failed'
      || event.result?.status === 'rejected')
  const successful = rows.filter((event) =>
    event.result?.status !== 'failed'
      && event.result?.status !== 'rejected'
      && STAGE_INDEX.has(event.stage))
  const lastObservedStage = rows.at(-1)?.stage ?? null
  const lastSuccessfulStage = successful.at(-1)?.stage ?? null
  const lastIndex = lastSuccessfulStage === null ? -1 : STAGE_INDEX.get(lastSuccessfulStage)
  const expectedNextStage = terminalEvent
    ? null
    : lastIndex < 0
      ? DELIVERY_STAGES[0]
      : DELIVERY_STAGES[lastIndex + 1] ?? null
  const missingStages = terminalEvent
    ? []
    : DELIVERY_STAGES.filter((stage, index) => index > lastIndex && !confirmed.has(stage))
  const complete = !terminalEvent && confirmed.has('handled')
  const outcome = terminalEvent
    ? terminalEvent.stage === 'rejected' || terminalEvent.result?.status === 'rejected' ? 'rejected' : 'failed'
    : complete
      ? 'handled'
      : 'pending'
  return {
    correlationId: query.correlationId ?? rows[0]?.correlationId ?? null,
    observedStages,
    confirmedStages: DELIVERY_STAGES.filter((stage) => confirmed.has(stage)),
    lastObservedStage,
    lastSuccessfulStage,
    expectedNextStage,
    missingStages,
    terminal: terminalEvent !== undefined,
    outcome,
    reason: terminalEvent
      ? 'terminal observation ' + terminalEvent.stage
      : complete
        ? 'handled was observed'
        : expectedNextStage
          ? 'waiting for ' + expectedNextStage
          : 'no later delivery stage is defined',
  }
}

export const analyzeTimeline = locateObservationBreakpoint

/**
 * Summarize observed latency and outcomes for one correlation chain.
 *
 * @param {Array|ObservationTimeline} events Events to inspect.
 * @param {object} [query] Timeline filter.
 * @returns {object} Read-only summary.
 */
export function summarizeTimeline(events, query = {}) {
  const rows = queryTimeline(events, query)
  const breakpoint = locateObservationBreakpoint(rows)
  const first = rows[0]
  const last = rows.at(-1)
  const duration = first?.time?.monotonic !== null && first?.time?.monotonic !== undefined
    && last?.time?.monotonic !== null && last?.time?.monotonic !== undefined
    ? Number(last.time.monotonic) - Number(first.time.monotonic)
    : null
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    eventCount: rows.length,
    correlationId: breakpoint.correlationId,
    firstEventId: first?.eventId ?? null,
    lastEventId: last?.eventId ?? null,
    durationMonotonic: duration,
    stages: breakpoint.observedStages,
    lastSuccessfulStage: breakpoint.lastSuccessfulStage,
    expectedNextStage: breakpoint.expectedNextStage,
    outcome: breakpoint.outcome,
    retries: rows.reduce((total, event) => total + Math.max(0, Number(event.retry?.attempt ?? 0) - 1), 0),
    failures: rows.filter((event) => event.result?.status === 'failed' || event.stage === 'failed').length,
    rejections: rows.filter((event) => event.result?.status === 'rejected' || event.stage === 'rejected').length,
  }
}

/**
 * In-memory timeline with monotonic sequence assignment.
 */
export class ObservationTimeline {
  /**
   * @param {{ clock?: () => number, idFactory?: () => string }} [options] Injection points.
   */
  constructor(options = {}) {
    this.clock = typeof options.clock === 'function' ? options.clock : () => 0
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : null
    this.events = []
    this.eventIds = new Set()
  }

  /**
   * Append one observation.
   *
   * @param {object} input Event input.
   * @param {object} [context] Parent context.
   * @returns {object} Stored event.
   */
  append(input = {}, context = {}) {
    const sequence = this.events.length + 1
    const eventId = input.eventId ?? this.idFactory?.()
    const event = createObservationEvent({
      ...input,
      eventId,
      sequence,
      time: input.time ?? { monotonic: this.clock(), estimated: false },
    }, context)
    if (this.eventIds.has(event.eventId)) throw new Error('duplicate observation eventId "' + event.eventId + '"')
    this.eventIds.add(event.eventId)
    this.events.push(event)
    return clone(event)
  }

  /** @returns {object[]} All events in insertion order. */
  all() {
    return this.events.map(clone)
  }

  /** @param {object} [query] Timeline filter. @returns {object[]} Matching events. */
  query(query = {}) {
    return queryTimeline(this.events, query)
  }

  /** @param {object} [query] Timeline filter. @returns {object} Breakpoint analysis. */
  breakpoint(query = {}) {
    return locateObservationBreakpoint(this.events, query)
  }

  /** @param {object} [query] Timeline filter. @returns {object} Summary. */
  summary(query = {}) {
    return summarizeTimeline(this.events, query)
  }
}

export const __private = {
  compareEvents,
  confirmedStages,
  digest,
  matchesQuery,
  stableJson,
}
