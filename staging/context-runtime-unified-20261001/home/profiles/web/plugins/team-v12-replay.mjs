/**
 * v12 deterministic incident replay.
 *
 * A fixture drives caller-supplied logic through a temporary state clone,
 * simulated clock and fake adapters. This module never calls a provider,
 * dispatches a real wake, opens an active session, or writes a user file.
 */

import { createHash } from 'node:crypto'
import { redactSecrets } from './team-v12-runtime-facts.mjs'

export const REPLAY_FIXTURE_SCHEMA_VERSION = 1
export const REPLAY_RESULT_SCHEMA_VERSION = 1

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

function truncateLargeStrings(value, maxStringLength, path, replacements) {
  if (typeof value === 'string') {
    if (value.length <= maxStringLength) return value
    const replacement = '[TRUNCATED:sha256=' + digest(value) + ':length=' + value.length + ']'
    replacements.push(path)
    return replacement
  }
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item, index) => truncateLargeStrings(item, maxStringLength, path + '[' + index + ']', replacements))
  return Object.fromEntries(Object.keys(value).map((key) => [
    key,
    truncateLargeStrings(value[key], maxStringLength, path + '.' + key, replacements),
  ]))
}

/**
 * Redact secrets and replace oversized strings with a stable digest marker.
 *
 * @param {unknown} fixture Fixture to sanitize.
 * @param {{ maxStringLength?: number }} [options] Sanitization options.
 * @returns {unknown} Sanitized fixture.
 */
export function redactFixture(fixture, options = {}) {
  const maxStringLength = Math.max(64, Number(options.maxStringLength ?? 4096))
  const redacted = redactSecrets(fixture)
  const replacements = []
  const compacted = truncateLargeStrings(redacted, maxStringLength, '$', replacements)
  if (compacted && typeof compacted === 'object' && !Array.isArray(compacted)) {
    compacted.redaction = {
      applied: true,
      policy: 'v12-fixture-redaction-v1',
      maxStringLength,
      truncatedPaths: replacements,
    }
  }
  return compacted
}

function normalizeReplayEvent(event, index, clock) {
  const type = text(event?.type ?? event?.kind ?? event?.eventType)
  if (!type) throw new Error('fixture event ' + String(index) + ' requires a type')
  const atValue = event?.at ?? event?.time?.monotonic
  const at = Number.isFinite(Number(atValue))
    ? Number(atValue)
    : Number(clock.start) + index * Number(clock.stepMs)
  return {
    index,
    type,
    at,
    correlationId: event?.correlationId ?? null,
    causationId: event?.causationId ?? null,
    actor: event?.actor ?? null,
    tool: event?.tool ?? null,
    fault: event?.fault ?? null,
    data: redactSecrets(event?.data ?? event?.payload ?? null),
  }
}

/**
 * Validate and normalize a replay fixture.
 *
 * @param {object} input Fixture input.
 * @param {{ maxStringLength?: number }} [options] Sanitization options.
 * @returns {object} Stable fixture representation.
 */
export function normalizeReplayFixture(input = {}, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('replay fixture must be an object')
  const fixtureId = text(input.fixtureId ?? input.id)
  if (!fixtureId) throw new Error('fixtureId is required')
  const clockInput = input.clock ?? {}
  const clock = {
    start: Number.isFinite(Number(clockInput.start)) ? Number(clockInput.start) : 0,
    stepMs: Math.max(1, Number(clockInput.stepMs ?? clockInput.step ?? 1)),
  }
  const initialState = input.initialState ?? input.state ?? {}
  if (initialState === null || typeof initialState !== 'object' || Array.isArray(initialState)) {
    throw new Error('initialState must be an object')
  }
  const redacted = redactFixture({
    initialState: clone(initialState),
    events: asArray(input.events).map((event) => clone(event)),
    faultInjections: clone(input.faultInjections ?? []),
    postconditions: clone(input.postconditions ?? input.assertions ?? []),
    invariants: clone(input.invariants ?? []),
  }, options)
  const normalized = {
    schemaVersion: REPLAY_FIXTURE_SCHEMA_VERSION,
    fixtureId,
    fixtureVersion: Number(input.fixtureVersion ?? input.version ?? 1),
    title: text(input.title) || fixtureId,
    category: text(input.category ?? input.sourceIncident?.category),
    liveOnly: input.liveOnly === true,
    sourceIncident: clone(input.sourceIncident ?? input.incident ?? null),
    evidenceRef: clone(input.evidenceRef ?? input.evidence_ref ?? null),
    profile: clone(input.profile ?? null),
    plugin: clone(input.plugin ?? null),
    schema: clone(input.schema ?? null),
    clock,
    initialState: redacted.initialState,
    events: asArray(redacted.events).map((event, index) => normalizeReplayEvent(event, index, clock)),
    faultInjections: redacted.faultInjections,
    postconditions: redacted.postconditions,
    invariants: redacted.invariants,
    redaction: redacted.redaction,
  }
  normalized.fixtureFingerprint = digest({ ...normalized, fixtureFingerprint: undefined })
  return normalized
}

/**
 * Simulated monotonic clock.
 */
export class SimulatedClock {
  /**
   * @param {number} [start] Initial monotonic value.
   */
  constructor(start = 0) {
    this.value = Number(start)
    if (!Number.isFinite(this.value)) throw new Error('clock start must be finite')
  }

  /** @returns {number} Current monotonic value. */
  now() {
    return this.value
  }

  /**
   * Advance the clock.
   *
   * @param {number} delta Non-negative duration.
   * @returns {number} New value.
   */
  advance(delta = 1) {
    const amount = Number(delta)
    if (!Number.isFinite(amount) || amount < 0) throw new Error('clock delta must be non-negative')
    this.value += amount
    return this.value
  }

  /**
   * Move to an absolute monotonic value.
   *
   * @param {number} value Target value.
   * @returns {number} New value.
   */
  advanceTo(value) {
    const target = Number(value)
    if (!Number.isFinite(target)) throw new Error('clock target must be finite')
    if (target > this.value) this.value = target
    return this.value
  }

  /** @returns {{ value: number }} Serializable clock state. */
  snapshot() {
    return { value: this.value }
  }
}

/**
 * @param {number} [start] Initial clock value.
 * @returns {SimulatedClock} Simulated clock.
 */
export function createSimulatedClock(start = 0) {
  return new SimulatedClock(start)
}

/**
 * Create a fake provider with a deterministic response queue.
 *
 * @param {Array|Function} responses Response queue or pure response function.
 * @returns {object} Fake provider.
 */
export function createFakeProvider(responses = []) {
  const queue = asArray(responses).map(clone)
  const calls = []
  return {
    kind: 'fake-provider',
    async complete(prompt, context = {}) {
      const index = calls.length
      calls.push({ index, prompt: redactSecrets(prompt), context: redactSecrets(context) })
      if (typeof responses === 'function') return clone(await responses({ prompt, context, index }))
      if (index >= queue.length) throw new Error('fake provider response queue exhausted at call ' + String(index))
      return clone(queue[index])
    },
    calls() {
      return calls.map(clone)
    },
    snapshot() {
      return { kind: 'fake-provider', calls: calls.length, remaining: Math.max(0, queue.length - calls.length) }
    },
  }
}

/**
 * Create a fake tool dispatcher.
 *
 * @param {object|Map} handlers Tool handlers keyed by tool name.
 * @returns {object} Fake tool adapter.
 */
export function createFakeTool(handlers = {}) {
  const calls = []
  const lookup = handlers instanceof Map ? handlers : new Map(Object.entries(handlers))
  return {
    kind: 'fake-tool',
    async invoke(name, args = {}) {
      const toolName = text(name)
      calls.push({ name: toolName, args: redactSecrets(args) })
      const handler = lookup.get(toolName)
      if (typeof handler !== 'function') throw new Error('fake tool "' + toolName + '" has no handler')
      return clone(await handler(clone(args)))
    },
    calls() {
      return calls.map(clone)
    },
    snapshot() {
      return { kind: 'fake-tool', calls: calls.length }
    },
  }
}

/**
 * Create a fake message dispatcher.
 *
 * @returns {object} Fake dispatcher.
 */
export function createFakeDispatcher() {
  const rows = []
  return {
    kind: 'fake-dispatcher',
    async dispatch(message) {
      const row = {
        index: rows.length,
        message: redactSecrets(clone(message)),
        status: 'delivered',
      }
      rows.push(row)
      return clone(row)
    },
    sent() {
      return rows.map(clone)
    },
    snapshot() {
      return { kind: 'fake-dispatcher', deliveries: rows.length }
    },
  }
}

/**
 * Create an isolated replay harness.
 *
 * @param {object} fixture Fixture input.
 * @param {{ providerResponses?: Array|Function, toolHandlers?: object, maxStringLength?: number }} [options] Adapters.
 * @returns {object} Replay harness.
 */
export function createReplayHarness(fixture, options = {}) {
  const normalized = normalizeReplayFixture(fixture, options)
  const initialState = clone(normalized.initialState)
  const clock = createSimulatedClock(normalized.clock.start)
  const provider = createFakeProvider(options.providerResponses ?? [])
  const tool = createFakeTool(options.toolHandlers ?? {})
  const dispatcher = createFakeDispatcher()
  const emitted = []
  const harness = {
    fixture: normalized,
    state: clone(initialState),
    initialState: clone(initialState),
    clock,
    provider,
    tool,
    dispatcher,
    adapters: { provider, tool, dispatcher, clock },
    emitted,
    emit(event) {
      emitted.push(redactSecrets(clone(event)))
    },
    snapshot() {
      return {
        state: clone(harness.state),
        emitted: emitted.map(clone),
        clock: clock.snapshot(),
        provider: provider.snapshot(),
        tool: tool.snapshot(),
        dispatcher: dispatcher.snapshot(),
      }
    },
  }
  return harness
}

function readPath(source, path) {
  if (!path) return source
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let current = source
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

function equal(left, right) {
  return stableJson(left) === stableJson(right)
}

function eventHasStage(events, stage, requireSuccess = false) {
  return events.some((event) =>
    event.stage === stage
      && (!requireSuccess || !['failed', 'rejected'].includes(event.result?.status)))
}

/**
 * Evaluate one declarative replay assertion.
 *
 * @param {object} assertion Assertion definition.
 * @param {{ state: object, initialState: object, events: object[], adapters: object }} context Evaluation context.
 * @returns {object} Assertion result.
 */
export function evaluateReplayAssertion(assertion, context) {
  const kind = text(assertion?.kind ?? assertion?.type ?? 'equals')
  const id = text(assertion?.id) || 'assertion-' + kind
  const path = assertion?.path ?? null
  const expected = assertion?.expected ?? assertion?.value ?? null
  const actual = readPath(context.state, path)
  let ok = false
  try {
    if (typeof assertion?.test === 'function') ok = assertion.test(context) === true
    else if (kind === 'equals') ok = equal(actual, expected)
    else if (kind === 'notEquals') ok = !equal(actual, expected)
    else if (kind === 'exists') ok = actual !== undefined && actual !== null
    else if (kind === 'truthy') ok = Boolean(actual)
    else if (kind === 'falsy') ok = !actual
    else if (kind === 'lengthEquals') ok = actual?.length === Number(expected)
    else if (kind === 'unique') ok = Array.isArray(actual) && new Set(actual.map((item) => stableJson(item))).size === actual.length
    else if (kind === 'lessThanOrEqual') ok = Number(actual) <= Number(expected)
    else if (kind === 'unchanged') ok = equal(actual, readPath(context.initialState, assertion?.initialPath ?? path))
    else if (kind === 'stageReached') ok = eventHasStage(context.events, text(assertion?.stage), assertion?.successful === true)
    else if (kind === 'stageNotReached') ok = !eventHasStage(context.events, text(assertion?.stage))
    else if (kind === 'eventCount') ok = context.events.length === Number(expected)
    else if (kind === 'retryAtMost') {
      const maximum = Number(expected)
      ok = context.events.every((event) => Number(event.retry?.attempt ?? 0) <= maximum)
    } else {
      throw new Error('unsupported replay assertion kind "' + kind + '"')
    }
  } catch (error) {
    return {
      id,
      scope: assertion?.scope ?? 'postcondition',
      safety: assertion?.safety === true,
      kind,
      path,
      expected,
      actual: redactSecrets(actual),
      ok: false,
      message: String(error?.message ?? error),
    }
  }
  return {
    id,
    scope: assertion?.scope ?? 'postcondition',
    safety: assertion?.safety === true,
    kind,
    path,
    expected: redactSecrets(expected),
    actual: redactSecrets(actual),
    ok,
    message: ok ? 'passed' : text(assertion?.message) || kind + ' failed',
  }
}

/**
 * Evaluate fixture invariants and postconditions.
 *
 * @param {object[]} assertions Assertions.
 * @param {object} context Evaluation context.
 * @returns {object[]} Results.
 */
export function evaluateReplayAssertions(assertions, context) {
  return asArray(assertions).map((assertion) => evaluateReplayAssertion(assertion, context))
}

function implementationHash(options) {
  const identity = options.implementationId
    ?? options.reducer?.name
    ?? (typeof options.reducer === 'function' ? options.reducer.toString() : 'no-reducer')
  return digest(String(identity))
}

/**
 * Run a deterministic replay.
 *
 * @param {object} fixture Fixture input.
 * @param {{
 *   reducer?: Function,
 *   handlers?: object,
 *   implementationId?: string,
 *   providerResponses?: Array|Function,
 *   toolHandlers?: object,
 *   maxStringLength?: number
 * }} [options] Replay logic and fake adapters.
 * @returns {Promise<object>} Replay result.
 */
export async function runReplay(fixture, options = {}) {
  const normalized = normalizeReplayFixture(fixture, options)
  if (normalized.liveOnly) {
    return {
      schemaVersion: REPLAY_RESULT_SCHEMA_VERSION,
      fixtureId: normalized.fixtureId,
      fixtureVersion: normalized.fixtureVersion,
      fixtureFingerprint: normalized.fixtureFingerprint,
      status: 'not-run',
      covered: false,
      liveOnly: true,
      reason: 'fixture requires live services and is not represented as local replay coverage',
      isolation: {
        temporaryState: true,
        liveProviderCalls: 0,
        liveDispatcherCalls: 0,
        activeSessionWrites: 0,
      },
    }
  }

  const harness = createReplayHarness(normalized, options)
  const initialFixtureState = clone(normalized.initialState)
  const assertionResults = []
  const errors = []
  try {
    for (const event of normalized.events) {
      harness.clock.advanceTo(event.at)
      const handler = options.handlers?.[event.type]
      const reducer = handler ?? options.reducer
      let result
      if (typeof reducer === 'function') {
        result = await reducer({
          state: harness.state,
          event,
          clock: harness.clock,
          provider: harness.provider,
          tool: harness.tool,
          dispatcher: harness.dispatcher,
          adapters: harness.adapters,
          harness,
        })
      }
      if (result !== undefined) harness.state = result
      harness.emit({
        index: event.index,
        type: event.type,
        at: event.at,
        correlationId: event.correlationId,
        causationId: event.causationId,
        result: result === undefined ? null : redactSecrets(result),
      })
    }
    const invariantResults = evaluateReplayAssertions(normalized.invariants, {
      state: harness.state,
      initialState: harness.initialState,
      events: harness.emitted,
      adapters: harness.adapters,
    }).map((row) => ({ ...row, scope: 'invariant', safety: true }))
    const postconditionResults = evaluateReplayAssertions(normalized.postconditions, {
      state: harness.state,
      initialState: harness.initialState,
      events: harness.emitted,
      adapters: harness.adapters,
    }).map((row) => ({ ...row, scope: 'postcondition' }))
    assertionResults.push(...invariantResults, ...postconditionResults)
  } catch (error) {
    errors.push(String(error?.message ?? error))
  }

  const violations = assertionResults.filter((row) => !row.ok)
  const initialStateUnchanged = equal(initialFixtureState, normalized.initialState)
  const finalStateDigest = digest(harness.state)
  const safeFinalState = redactSecrets(harness.state)
  const resultEvents = harness.emitted.map(clone)
  const runId = digest({
    fixtureFingerprint: normalized.fixtureFingerprint,
    implementation: implementationHash(options),
    finalStateDigest,
    events: resultEvents,
  })
  const status = errors.length === 0 && violations.length === 0 ? 'passed' : 'failed'
  const result = {
    schemaVersion: REPLAY_RESULT_SCHEMA_VERSION,
    fixtureId: normalized.fixtureId,
    fixtureVersion: normalized.fixtureVersion,
    fixtureFingerprint: normalized.fixtureFingerprint,
    runId,
    status,
    covered: true,
    liveOnly: false,
    deterministicInputs: {
      clock: normalized.clock,
      eventCount: normalized.events.length,
      implementationHash: implementationHash(options),
    },
    finalState: clone(safeFinalState),
    finalStateDigest,
    events: resultEvents,
    assertions: assertionResults,
    violations,
    errors,
    isolation: {
      temporaryState: true,
      initialStateUnchanged,
      liveProviderCalls: 0,
      liveDispatcherCalls: 0,
      activeSessionWrites: 0,
      fakeProviderCalls: harness.provider.snapshot().calls,
      fakeToolCalls: harness.tool.snapshot().calls,
      fakeDispatcherDeliveries: harness.dispatcher.snapshot().deliveries,
    },
  }
  if (status === 'failed') result.diagnostic = { finalState: clone(safeFinalState), events: resultEvents }
  return result
}

/**
 * Prove a fix with the same fixture: the before implementation must fail and
 * the after implementation must pass.
 *
 * @param {object} fixture Fixture input.
 * @param {{ before: object, after: object }} options Two replay option sets.
 * @returns {Promise<object>} Fix evidence.
 */
export async function runRegressionPair(fixture, options = {}) {
  const before = await runReplay(fixture, options.before ?? {})
  const after = await runReplay(fixture, options.after ?? {})
  const verified = before.status === 'failed' && after.status === 'passed'
  return {
    schemaVersion: REPLAY_RESULT_SCHEMA_VERSION,
    fixtureId: before.fixtureId,
    fixtureFingerprint: before.fixtureFingerprint,
    status: verified ? 'verified' : 'not-verified',
    fixBeforeFail: before.status === 'failed',
    afterPass: after.status === 'passed',
    before,
    after,
  }
}

export const verifyFixBeforeFailAfterPass = runRegressionPair

export const __private = {
  digest,
  equal,
  readPath,
  stableJson,
  truncateLargeStrings,
}
