import { createHash } from 'node:crypto';
import { failWith } from './index.mjs';

/**
 * The dispatch-phase contract shared by the upstream patch, the host and the probes; M1b design §1.4.2, §2.2.
 *
 * contract = 'team-dispatch/2'. Four phases, one event name:
 *
 *   prepared     final adapter options are frozen; the adapter iterator has not run yet. Never evidence.
 *   send-started fetch arguments are built and fetch is about to be called. Never evidence; it marks the window
 *                "request may have left, no response yet" and is the only place the request-side sessionSeq is read.
 *   committed    the awaited fetch returned a Response (headers arrived). The only phase that may write visible.
 *   failed       a failure that provably happened before send-started. Never evidence; never revokes a committed
 *                transmission of the same attempt.
 *
 * This module is the host-side half of the two implementations the design requires (the other half lives in the
 * upstream patch). The canonical digest here and the patch's must agree field by field; the A-pack probe compares them.
 */
export const DISPATCH_CONTRACT = 'team-dispatch/2';
export const DISPATCH_EVENT = 'llm/dispatch';
export const DISPATCH_PHASES = Object.freeze(['prepared', 'send-started', 'committed', 'failed']);
export const DISPATCH_ACCEPTED = Object.freeze(['accepted', 'auth-rejected', 'proxy-error', 'other-rejected']);

/** Recursively sorted JSON, identical to packages/contracts/team.mjs canonical() and to the patch's own copy. */
export function dispatchCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(dispatchCanonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + dispatchCanonical(value[key])).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) failWith('INVALID_DISPATCH_EVENT', 'message content cannot be serialized as JSON');
  return encoded;
}

/** sha256(canonical({ role, content })): only role and content, never the id and never the source. */
export function dispatchDigest(message) {
  if (!message || typeof message !== 'object') failWith('INVALID_DISPATCH_EVENT', 'a dispatch message must be an object');
  return createHash('sha256').update(dispatchCanonical({ role: message.role, content: message.content })).digest('hex');
}

/** The per-message summary every prepared/committed event carries. */
export function summariseDispatchMessages(messages) {
  if (!Array.isArray(messages)) failWith('INVALID_DISPATCH_EVENT', 'messages must be an array');
  return messages.map(message => Object.freeze({
    id: typeof message.id === 'string' ? message.id : null,
    role: message.role,
    digest: dispatchDigest(message),
    chars: dispatchCanonical(message.content).length,
  }));
}

/**
 * accepted is a diagnostic classification of a committed response; it never decides visibility.
 * accepted: 2xx. auth-rejected: 401/403. proxy-error: any other HTTP status (including a non-JSON proxy page).
 * other-rejected: an in-process receiver (fake provider) that answered with its own error.
 */
export function classifyAccepted(httpStatus, { receiverError = false } = {}) {
  if (receiverError) return 'other-rejected';
  if (!Number.isInteger(httpStatus) || httpStatus <= 0) return null;
  if (httpStatus >= 200 && httpStatus < 300) return 'accepted';
  if (httpStatus === 401 || httpStatus === 403) return 'auth-rejected';
  return 'proxy-error';
}

/** requestId = request:<epoch>:<attempt>:<transmission>; generated only on committed. */
export function dispatchRequestId(epoch, attempt, transmission) {
  if (typeof attempt !== 'string' || !attempt) failWith('INVALID_DISPATCH_EVENT', 'requestId needs an attempt id');
  if (!Number.isSafeInteger(transmission) || transmission < 1) failWith('INVALID_DISPATCH_EVENT', 'requestId needs a transmission number');
  return 'request:' + String(epoch ?? 'unknown') + ':' + attempt + ':' + transmission;
}

/** Validate an event against the frozen contract and freeze it. Throws instead of guessing a missing field. */
export function assertDispatchEvent(event) {
  if (!event || typeof event !== 'object') failWith('INVALID_DISPATCH_EVENT', 'a dispatch event must be an object');
  if (event.contract !== DISPATCH_CONTRACT) {
    failWith('INVALID_DISPATCH_EVENT', 'contract must be ' + JSON.stringify(DISPATCH_CONTRACT) + ', got ' + JSON.stringify(event.contract ?? null));
  }
  if (!DISPATCH_PHASES.includes(event.phase)) failWith('INVALID_DISPATCH_EVENT', 'unknown phase ' + JSON.stringify(event.phase ?? null));
  if (typeof event.attempt !== 'string' || !event.attempt) failWith('INVALID_DISPATCH_EVENT', 'attempt must be a non-empty string');
  if (typeof event.sessionId !== 'string' || !event.sessionId) failWith('INVALID_DISPATCH_EVENT', 'sessionId must be a non-empty string');
  if (event.kind !== 'main' && event.kind !== 'auxiliary') failWith('INVALID_DISPATCH_EVENT', 'kind must be main or auxiliary');
  if (event.purpose !== null && event.purpose !== undefined && !['compaction', 'session-title'].includes(event.purpose)) {
    failWith('INVALID_DISPATCH_EVENT', 'unknown purpose ' + JSON.stringify(event.purpose));
  }
  if (event.phase === 'send-started' || event.phase === 'committed') {
    if (!Number.isSafeInteger(event.transmission) || event.transmission < 1) {
      failWith('INVALID_DISPATCH_EVENT', event.phase + ' needs a positive transmission number');
    }
  }
  const accepted = event.accepted ?? null;
  if (accepted !== null && !DISPATCH_ACCEPTED.includes(accepted)) {
    failWith('INVALID_DISPATCH_EVENT', 'unknown accepted classification ' + JSON.stringify(accepted));
  }
  return Object.freeze({ ...event, purpose: event.purpose ?? null, accepted });
}

/**
 * Publish one dispatch event with listener isolation; the patch does the same thing upstream.
 *
 * cordis emits synchronously and does not await returned promises, so a listener that throws would become a failure
 * chunk of the request it is observing and a rejected promise would become an unhandled rejection. Every listener is
 * called inside its own try/catch, a thenable result gets a rejection handler, and nothing is awaited here.
 */
export function publishDispatchEvent(target, event) {
  const payload = event && event.contract === DISPATCH_CONTRACT ? event : assertDispatchEvent(event);
  const events = target && typeof target.events === 'object' && typeof target.events.dispatch === 'function' ? target.events : null;
  if (!events) {
    // A plain {on(...)} collector (probes, tests) is supported so a caller never has to fake cordis.
    const listeners = target && typeof target.on === 'function' ? target.listeners?.(DISPATCH_EVENT) ?? [] : [];
    for (const listener of listeners) safely(listener, payload, target);
    return payload;
  }
  const listeners = events.dispatch('emit', [DISPATCH_EVENT, payload]);
  for (const listener of listeners) safely(listener, payload, target);
  return payload;
}

function safely(listener, payload, target) {
  const warn = error => {
    try {
      target.logger?.warn?.('llm/dispatch listener failed', error);
    } catch {
      // A logger that throws must not become a request failure either.
    }
  };
  try {
    const returned = listener(payload);
    if (returned != null && typeof returned.then === 'function') Promise.resolve(returned).then(undefined, warn);
  } catch (error) {
    warn(error);
  }
}

/**
 * Per-attempt immutable request context for the host-side dispatch publication (F2b: moved here from the real
 * harness, where it was the only copy).
 *
 * The earlier shape kept one global "current request" slot. Two interleaved requests overwrite it, so a committed
 * event of the first request could carry the second request's session or messages, and whichever finished first
 * cleared the slot for the other. Nothing here is "current": an entry is keyed by the attempt id the patched runtime
 * minted, it is frozen when the request is dispatched, and a lookup that misses returns null instead of guessing.
 */
export function createDispatchContexts({ limit = 256, audit = () => {} } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('dispatch contexts need a positive limit');
  const entries = new Map();
  const terminal = new Set();
  const refusals = [];
  return {
    get size() {
      return entries.size;
    },
    has(attemptId) {
      return typeof attemptId === 'string' && entries.has(attemptId);
    },
    /**
     * Register the context of one attempt. The first registration wins: a retry of the same attempt must not be able
     * to re-point the identity of the request that was actually sent.
     */
    register(attemptId, context = {}) {
      if (typeof attemptId !== 'string' || !attemptId) return null;
      if (entries.has(attemptId)) return entries.get(attemptId);
      if (!Array.isArray(context.messages)) throw new TypeError('a dispatch context needs the request messages');
      if (entries.size >= limit) {
        const reclaim = terminal.values().next().value;
        if (reclaim !== undefined) { entries.delete(reclaim); terminal.delete(reclaim); }
        else {
          const event = Object.freeze({ code: 'DISPATCH_CONTEXT_CAPACITY', attemptId });
          refusals.push(event); audit(event);
          throw Object.assign(new Error(event.code), event);
        }
      }
      const entry = Object.freeze({
        attemptId,
        sessionId: typeof context.sessionId === 'string' && context.sessionId ? context.sessionId : null,
        kind: context.kind === 'auxiliary' ? 'auxiliary' : 'main',
        purpose: typeof context.purpose === 'string' ? context.purpose : null,
        provider: context.provider ?? null,
        model: context.model ?? null,
        sessionSeq: Number.isSafeInteger(context.sessionSeq) ? context.sessionSeq : null,
        confirmedSessionSeq: Number.isSafeInteger(context.confirmedSessionSeq) ? context.confirmedSessionSeq : null,
        messages: Object.freeze(summariseDispatchMessages(context.messages)),
      });
      entries.set(attemptId, entry);
      return entry;
    },
    get(attemptId) {
      return typeof attemptId === 'string' ? entries.get(attemptId) ?? null : null;
    },
    get audit() { return [...refusals]; },
    finish(attemptId) {
      if (!entries.has(attemptId)) return false;
      terminal.add(attemptId);
      return true;
    },
    forget(attemptId) {
      if (!terminal.delete(attemptId)) return false;
      return entries.delete(attemptId);
    },
    clear() {
      entries.clear();
      terminal.clear();
    },
  };
}

/**
 * Publish one raw phase report from an adapter that does not hold the patched attempt object (the fallback path of
 * the real harness and of any self-built provider). The attempt the event names decides the request-side facts, so a
 * reverse-order completion cannot relabel a request, and an attempt this host never dispatched publishes nothing.
 * A listener that throws or rejects cannot change whether the request was sent: publishDispatchEvent contains it.
 */
export function publishDispatchPhase(target, contexts, report) {
  if (!report || typeof report.attemptId !== 'string' || !report.attemptId) return null;
  const context = contexts.get(report.attemptId);
  if (!context) return null;
  return publishDispatchEvent(target, { contract: DISPATCH_CONTRACT, phase: report.phase, attempt: report.attemptId,
    sessionId: context.sessionId, kind: context.kind, purpose: context.purpose, provider: context.provider, model: context.model,
    messages: context.messages, transmission: report.transmission ?? null,
    sendStartedAt: report.sendStartedAt ?? null, at: Date.now(), accepted: report.accepted ?? null,
    httpStatus: Number.isInteger(report.httpStatus) ? report.httpStatus : null, reason: report.reason ?? null });
}

/**
 * The host-side evidence ledger: one attempt, many transmissions.
 *
 * It encodes the two rules the probe pins: (1) visible requires a committed transmission and only the first
 * committed transmission of an attempt counts; (2) a later failure never revokes a receipt that already exists.
 * The request-side sessionSeq is stored at send-started and echoed at committed; confirmedSessionSeq is a separate
 * diagnostic and is never used as the boundary value (design §2.2).
 */
export class DispatchEvidenceLedger {
  #leaseMs;
  #now;
  #slots = new Map();
  #receipts = new Map();
  #missing = [];
  #unknown = 0;

  constructor({ leaseMs = 30000, now = Date.now } = {}) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) failWith('INVALID_CONFIG', 'the dispatch evidence lease must be a positive number of milliseconds');
    this.#leaseMs = leaseMs;
    this.#now = now;
  }

  get leaseMs() {
    return this.#leaseMs;
  }

  slot(attempt) {
    return this.#slots.get(attempt) ?? null;
  }

  receipts() {
    return [...this.#receipts.values()];
  }

  /**
   * The receipts a host may write visible: committed, first of its attempt, and a main-kind request. An auxiliary
   * request (compaction, session title) is observed - it holds a slot and carries its own phases - but it is never
   * consumed as evidence for a turn. That filter lives here, in the consumer, rather than in whichever caller happens
   * to be looping over the events.
   */
  consumable(kind = 'main') {
    const visible = [];
    for (const receipt of this.#receipts.values()) {
      if (receipt.visible && receipt.slot.kind === kind) visible.push(receipt);
    }
    return visible;
  }

  missing() {
    return this.#missing.slice();
  }

  /** Observe one event. context carries the synchronously read session watermarks and the current epoch. */
  observe(rawEvent, context = {}) {
    const event = rawEvent && rawEvent.contract === DISPATCH_CONTRACT ? rawEvent : assertDispatchEvent(rawEvent);
    const at = this.#now();
    if (event.phase === 'prepared') {
      if (this.#slots.has(event.attempt)) {
        return this.#miss(event, 'duplicate-attempt', 'the attempt was already prepared');
      }
      const slot = {
        attempt: event.attempt, sessionId: event.sessionId, kind: event.kind, purpose: event.purpose ?? null,
        provider: event.provider ?? null, model: event.model ?? null, messages: event.messages ?? [],
        preparedAt: event.at ?? at, sendStarted: false, sendStartedAt: null, sendStartedSessionSeq: null,
        confirmedSessionSeq: null, transmissions: new Map(), committedCount: 0, failedCount: 0, closedAt: null,
      };
      this.#slots.set(event.attempt, slot);
      return { accepted: true, phase: event.phase, visible: false, slot };
    }
    const slot = this.#slots.get(event.attempt);
    if (!slot) return this.#miss(event, 'unbound-attempt', 'no prepared slot for this attempt');
    if (event.phase === 'send-started') {
      slot.sendStarted = true;
      slot.sendStartedAt = event.sendStartedAt ?? event.at ?? at;
      // The request-side watermark is read once, synchronously, and stored; committed echoes it.
      if (context.sessionSeq !== undefined) slot.sendStartedSessionSeq = context.sessionSeq;
      if (context.confirmedSessionSeq !== undefined) slot.confirmedSessionSeq = context.confirmedSessionSeq;
      if (!slot.transmissions.has(event.transmission)) slot.transmissions.set(event.transmission, { transmission: event.transmission, sendStartedAt: event.sendStartedAt, sessionSeq: context.sessionSeq ?? null, started: true, committed: null, failed: null });
      // A repeated send-started for a transmission that already has an entry marks the same window: whether the request
      // may have left the machine is what close()/release() read, not how many times the adapter said it.
      else slot.transmissions.get(event.transmission).started = true;
      return { accepted: true, phase: event.phase, visible: false, slot };
    }
    if (event.phase === 'committed') {
      const transmission = slot.transmissions.get(event.transmission);
      if (!transmission || !Number.isFinite(event.sendStartedAt) || transmission.sendStartedAt !== event.sendStartedAt || !Number.isInteger(transmission.sessionSeq)) {
        return this.#miss(event, 'missing-send-time', 'committed arrived without a send-started watermark');
      }
      const key = event.attempt + ':' + event.transmission;
      const prior = this.#receipts.get(key);
      if (prior) return { accepted: true, phase: event.phase, visible: false, duplicate: true, receipt: prior, slot };
      const receipt = Object.freeze({
        attempt: event.attempt,
        transmission: event.transmission,
        requestId: dispatchRequestId(context.epoch, event.attempt, event.transmission),
        sessionSeq: transmission.sessionSeq,
        confirmedSessionSeq: context.confirmedSessionSeq ?? null,
        requestedAt: transmission.sendStartedAt,
        confirmedAt: event.at ?? at,
        accepted: event.accepted ?? null,
        httpStatus: Number.isInteger(event.httpStatus) ? event.httpStatus : null,
        // Only the first committed transmission of an attempt may write visible.
        visible: slot.committedCount === 0,
        slot,
      });
      transmission.committed = receipt;
      this.#receipts.set(key, receipt);
      slot.committedCount += 1;
      return { accepted: true, phase: event.phase, visible: receipt.visible, receipt, slot };
    }
    // failed: closes this transmission. A failure after send-started is unknown, never a proof of "not sent".
    // It only adds the failure to the entry that is already there. Replacing the entry would drop the send watermark
    // (sessionSeq, sendStartedAt) and the committed pointer of a transmission that may still answer, so a late or
    // replayed committed would be rejected as "no send time" and close() would count a settled transmission as
    // unresolved (D review #3). An entry is created only when this transmission had none.
    const transmissionId = event.transmission ?? slot.transmissions.size + 1;
    const existing = slot.transmissions.get(transmissionId);
    slot.transmissions.set(transmissionId, existing
      ? { ...existing, failed: event.reason ?? 'failed' }
      : { transmission: transmissionId, sendStartedAt: slot.sendStartedAt, sessionSeq: null, started: false,
        committed: null, failed: event.reason ?? 'failed' });
    slot.failedCount += 1;
    return {
      accepted: true, phase: event.phase, visible: false, slot,
      classification: slot.sendStarted ? 'dispatchUnconfirmed' : 'dispatchFailed(notSent)',
    };
  }

  /**
   * The transmissions that left the machine and never came back: send-started, no committed answer.
   *
   * Review 2 #4: this is a per-transmission fact, not a per-attempt one. An attempt may commit one transmission and lose
   * another on the wire; the second one's send watermark is still the evidence a late commit would need, so it is the
   * unit the retention rules below count.
   */
  #uncertain(slot) {
    let count = 0;
    for (const transmission of slot.transmissions.values()) if (!transmission.committed && transmission.started === true) count += 1;
    return count;
  }

  /** Close an attempt (its step or member moved on): anything unresolved becomes unknown and is counted. */
  close(attempt, reason = 'slot-closed') {
    const slot = this.#slots.get(attempt);
    if (!slot || slot.closedAt !== null) return false;
    let unresolved = 0;
    for (const transmission of slot.transmissions.values()) if (!transmission.committed) unresolved += 1;
    // Review 2 #4: a committed transmission does not settle the attempt while another one is still unconfirmed, so the
    // ambiguity branch now fires for it too - the slot is retained as unknown rather than looking fully accounted for.
    if ((!slot.committedCount && (slot.sendStarted || slot.transmissions.size === 0)) || this.#uncertain(slot) > 0) {
      // An unknown attempt is retained: release() refuses it, because it is exactly the state an operator has to see.
      slot.unknown = true;
      this.#unknown += 1;
      this.#missing.push({ attempt, reason: slot.sendStarted ? 'unconfirmed' : 'never-dispatched', at: this.#now() });
    }
    slot.closedAt = this.#now();
    return unresolved > 0;
  }

  /**
   * The evidence lease: an attempt that produced neither committed nor failed inside the lease is unknown, not
   * visible. Returns the attempts that moved.
   */
  expire(now = this.#now()) {
    const moved = [];
    for (const slot of this.#slots.values()) {
      if (slot.closedAt !== null || slot.committedCount > 0 || (slot.failedCount > 0 && !slot.sendStarted)) continue;
      const started = slot.sendStarted ? slot.sendStartedAt : slot.preparedAt;
      if (now - started < this.#leaseMs) continue;
      slot.closedAt = now;
      slot.unknown = true;
      this.#unknown += 1;
      const reason = slot.sendStarted ? 'evidence-lease-expired' : 'never-dispatched';
      this.#missing.push({ attempt: slot.attempt, reason, at: now });
      moved.push(slot.attempt);
    }
    return moved;
  }

  /**
   * Forget an attempt the host has already persisted (review 2 #6).
   *
   * A settled attempt keeps no slot and no receipt: the caller writes the evidence to its database and releases it here,
   * so the ledger holds in-flight and unknown attempts only. Refused for an unknown attempt (unproven, stays visible) and
   * for one with an unresolved transmission (a later commit may still answer).
   */
  release(attempt) {
    const slot = this.#slots.get(attempt);
    if (!slot || slot.unknown === true || slot.closedAt === null) return false;
    for (const transmission of slot.transmissions.values()) {
      if (transmission.committed) continue;
      // "failed" is terminal only when it happened BEFORE send-started: that failure really proves the request never
      // left. A failure after send-started is an unconfirmed transmission that may still answer, and dropping it would
      // delete the send watermark and the uncertainty an operator has to see (review 2 #4).
      if (transmission.failed && transmission.started !== true) continue;
      return false;
    }
    for (const [key, receipt] of this.#receipts) if (receipt.attempt === attempt) this.#receipts.delete(key);
    this.#slots.delete(attempt);
    return true;
  }

  status() {
    let visible = 0;
    for (const receipt of this.#receipts.values()) if (receipt.visible) visible += 1;
    return {
      attempts: this.#slots.size,
      visible,
      receipts: this.#receipts.size,
      unknown: this.#unknown,
      evidenceMissing: this.#missing.length,
      auxiliary: [...this.#slots.values()].filter(slot => slot.kind === 'auxiliary').length,
    };
  }

  #miss(event, reason, detail) {
    this.#missing.push({ attempt: event.attempt, reason, detail, at: this.#now() });
    return { accepted: false, phase: event.phase, visible: false, reason };
  }
}
