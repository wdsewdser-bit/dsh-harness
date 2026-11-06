import { DispatchEvidenceLedger, assertDispatchEvent, dispatchDigest, classifyAccepted, failWith } from '../../../contracts/index.mjs';
import { prepareVisibility, prepareBatch } from './pre-step.mjs';
import { carriesCandidate } from './candidate.mjs';
import { createVisibilityQueue } from './queue.mjs';
import { assertDirtyWiring, markDirtySafely } from './dirty.mjs';

/**
 * Replace a manifest row this host wrote with a tombstone: the id stays, every field that made it a source goes. The
 * store has no delete, and removing the row outside the lifecycle port would be a write outside core-access, so the row
 * is emptied instead: requestBoundary re-hashes text, trustedManifests re-matches the source, preStep checks the text
 * hash, and none of them accepts a tombstone (D review #4).
 *
 * Exported because the branch needs a direct test: the flush path only reaches it when an injection succeeds and the
 * boundary after it fails, which the generation gate makes unreachable in the normal flow (review 2 #3).
 */
export function withdrawManifest({ host, now, manifestId, code }) {
  if (typeof manifestId !== 'string' || !manifestId.startsWith('manifest:')) {
    failWith('INVALID_MANIFEST', 'withdrawManifest takes the manifest entity id; got ' + JSON.stringify(manifestId ?? null));
  }
  if (!host || typeof host !== 'object' || !host.coreAccess || typeof now !== 'function') {
    failWith('INVALID_HOST', 'withdrawManifest needs the host and its clock reading');
  }
  host.coreAccess.lifecycle().mutate(manifestId, 'adapter', { withdrawn: true, reason: code },
    tx => tx.put(manifestId, { withdrawn: true, withdrawnReason: code, withdrawnAt: now(),
      text: '', hash: manifestId.slice('manifest:'.length), messageId: null, messageIds: [], messageBindings: [],
      sourceEventSeqs: [] }));
}

/** Inert until explicitly wired by the composition root (F owns production activation).
 * Event handlers capture all boundary facts synchronously and never write the database.
 * No current-request fallback: only prepared attempt -> immutable candidate -> transmission.
 */
export function createVisibility({ host, core, routeExecution, routeInputSession = null, inputArbiter = null, sessions, isMain, leaseMs = 30000,
  ledger: sharedLedger = null, queue: sharedQueue = null }) {
  const now = () => host.clock.now();
  // The ledger and the serial queue may be handed in, so one process can run two teams against the same evidence state
  // instead of two isolated ones. Neither object carries a team identity: a receipt is still only usable by the
  // instance whose own maps confirmed that attempt (D review #6).
  const ledger = sharedLedger ?? new DispatchEvidenceLedger({ now, leaseMs });
  // A shared ledger keeps the lease and the clock of whoever built it, so an injected ledger must at least agree on the
  // lease: otherwise this host's timer expires the other host's attempts on a budget it never agreed to. The clock
  // source cannot be compared cheaply (each host owns its own clock object), so it stays a wiring constraint: a shared
  // ledger requires one clock source (design §6 F, review 2 #4).
  if (sharedLedger && sharedLedger.leaseMs !== leaseMs) {
    failWith('INVALID_CONFIG', 'a shared evidence ledger keeps its own lease (' + sharedLedger.leaseMs + 'ms); inject it with the same leaseMs (got ' + leaseMs + 'ms)');
  }
  const queue = sharedQueue ?? createVisibilityQueue(), candidates = new Map(), attempts = new Map(), confirmed = new Map(), consumed = new Set();
  // The attempts this host itself observed. A shared ledger also holds the other host's receipts, and this set is what
  // keeps them out of this team's audit (review 2 #1).
  const observed = new Set();
  // A closure capability minted for one call is the ownership channel, not ambient ALS.
  // The transport must retain its bound publisher across callback/event forwarding boundaries.
  const calls = new WeakMap(), attemptCalls = new Map();
  // Review 2 #6: the audit is a bounded diagnostic tail plus the two counters status() reports. It used to be the whole
  // history, and a heap-per-event budget cannot see an array that grows with the run. Rows still reach the store as
  // entities (auditWrites is the monotonic index); only the in-memory copy is bounded.
  const audit = [], unpersisted = []; const skipped = new Set();
  const AUDIT_TAIL = 256;
  let auditWrites = 0, visibleCount = 0, missingCount = 0, persistFailed = 0, missingRead = 0;
  const record = row => {
    audit.push(row); if (audit.length > AUDIT_TAIL) audit.shift();
    if (row.type === 'visibilityCommitted') visibleCount += 1;
    if (row.type === 'evidenceMissing') missingCount += 1;
    unpersisted.push(row);
  };
  const capabilities = Object.fromEntries(['deepseek-adapter', 'real-cpa-transport', 'fake', 'other'].map(p => [p, 'adapter-unconfirmed']));
  const missing = (reason, facts = {}) => record({ type: 'evidenceMissing', reason, at: now(), ...facts });
  const batchMode = core.configuration?.superagentBorrow === 'v1';
  const route = id => {
    const r = batchMode ? routeInputSession?.(id) : routeExecution(id);
    if (!r?.routed || r.teamId !== host.teamId) return null;
    if (batchMode && (!['owner', 'execution'].includes(r.kind) || r.epoch !== host.epoch ||
        r.sessionId !== id || !r.memberId || !Number.isSafeInteger(r.generation))) return null;
    if (batchMode && r.kind === 'execution' && (!r.attemptId || !Number.isSafeInteger(r.fence) ||
        typeof r.executionEpoch !== 'string' || !r.executionEpoch)) return null;
    if (batchMode && r.kind === 'owner' && (r.ownerSessionId !== id || core.store.read(r.memberId)?.role !== 'root')) return null;
    return r;
  };
  const routeKey = r => JSON.stringify([r.kind, r.teamId, r.memberId, r.generation, r.sessionId,
    r.ownerSessionId, r.epoch, r.attemptId, r.fence, r.executionEpoch]);
  /** A refused boundary must not leave a usable manifest behind. The store has no delete, so the row keeps its id and
   * loses every field that made it a source: requestBoundary re-hashes text, trustedManifests re-matches the source,
   * preStep checks the text hash. None of them accepts a tombstone (D review #4). */
  const withdraw = (manifestId, code, attempt) => {
    try { withdrawManifest({ host, now, manifestId, code }); }
    catch (error) { missing(error.code ?? 'manifest-withdraw-failed', { attempt }); }
  };
  const flush = () => queue('evidence', () => {
    ledger.expire(now());
    const settled = new Set();
    for (const receipt of ledger.consumable()) {
      const key = receipt.attempt + ':' + receipt.transmission;
      if (consumed.has(key)) continue;
      // Decide ownership before consuming. A shared ledger carries the other host's receipts too, and an attempt this
      // host never observed (or a session it does not route) is not its evidence: writing "unbound-attempt" for it would
      // put the other team's transaction into this team's database and inflate both evidenceMissing counts, which is
      // this pack's own observation currency. Attempt ids must be unique across teams for this to be decisive — one of
      // the preconditions a shared ledger has (design §6 F, review 2 #1).
      if (!observed.has(receipt.attempt) || !route(receipt.slot.sessionId)) continue;
      consumed.add(key);
      // Every branch below terminates this key, so the attempt is settled for this host once the loop reaches it; the
      // pruning pass at the end of flush keeps these sets from growing with the run (review 2 #6).
      settled.add(receipt.attempt);
      // Every branch below terminates this key (it either writes the evidence or records the reason it could not), so the
      // binding is released here: keeping it would hold the journal snapshot of every dispatch for the life of the host.
      const binding = confirmed.get(key);
      confirmed.delete(key);
      if (!binding) { missing('unbound-attempt', { attempt: receipt.attempt }); continue; }
      const { slot, event, tx, events } = binding;
      if (slot.closed || slot.ambiguous) { missing('ambiguous-or-closed', { attempt: receipt.attempt }); continue; }
      // The route is a live fact, not a property of the slot. A session that was rebound (or unbound) while the request
      // was in flight no longer belongs to the member and generation this candidate was prepared for, so the evidence
      // closes here instead of being written for whoever holds the session now (D review #1).
      const live = route(slot.sessionId);
      if (!live || live.memberId !== slot.memberId || live.generation !== slot.generation || (batchMode && routeKey(live) !== slot.routeKey)) {
        missing('stale-route', { attempt: receipt.attempt, sessionId: slot.sessionId }); continue;
      }
      if (!tx || !Number.isFinite(event.sendStartedAt) || event.sendStartedAt !== tx.sendStartedAt || !Number.isInteger(tx.sessionSeq)) {
        missing('missing-send-time', { attempt: receipt.attempt }); continue;
      }
      const summary = event.messages?.filter(m => m.id === slot.messageId);
      if (summary?.length !== 1 || summary[0].digest !== slot.digest) { missing('content-projected', { attempt: receipt.attempt }); continue; }
      const native = events.filter(e => e.type === 'user/message' && e.data?.id === slot.messageId);
      if (native.length !== 1 || dispatchDigest({ role: 'user', content: native[0].data.content }) !== slot.digest) { missing('missing-native-source', { attempt: receipt.attempt }); continue; }
      // The real generation gate is inside recordInjection's transaction (provenance): it compares the generation this
      // candidate was built for with the member row itself. This layer only guarantees that the route still points at
      // the same member; the generation comparison above exists so that stale-route and that gate decide on the same
      // fact. live.generation is therefore NOT an independent second check — do not delete the comparison above on the
      // assumption that it is (review 2 #5).
      const manifestId = 'manifest:' + slot.candidate.manifest.hash;
      const injected = Boolean(core.store.read(manifestId));
      try {
        const result = host.coreAccess.lifecycle().visibility(slot.candidate, slot.messageId, [native[0].seq], live.generation,
          { requestId: receipt.requestId, sessionSeq: tx.sessionSeq, requestedAt: tx.sendStartedAt,
             ...(batchMode ? { executionRef: slot.candidate.manifest.batch.executionRef } : {}) });
        if (batchMode && result?.confirmed?.length) inputArbiter?.noteBatch({ items: result.confirmed.length,
          omitted: slot.candidate.manifest.batch.omittedCount });
        record({ type: 'visibilityCommitted', attempt: receipt.attempt, transmission: receipt.transmission,
          sendStartedAt: tx.sendStartedAt, sendStartedSessionSeq: tx.sessionSeq, confirmedAt: event.at,
          confirmedSessionSeq: binding.confirmedSessionSeq, accepted: event.accepted ?? classifyAccepted(event.httpStatus) });
      } catch (error) {
        // recordInjection and the boundary are two transactions; when the second one refuses, the first one's row would
        // otherwise stay behind as a manifest that was never consumed (D review #4).
        if (!injected && core.store.read(manifestId)) withdraw(manifestId, error.code ?? 'commit-failed', receipt.attempt);
        missing(error.code ?? 'commit-failed', { attempt: receipt.attempt });
      }
    }
    // Review 2 #6: an attempt whose evidence is written keeps nothing here. The ledger drops its slot and receipts, and
    // the sets keyed by attempt are trimmed with it. In-flight transmissions and unknown attempts are kept - those are the
    // states an operator has to see.
    const retire = attempt => {
      // A binding the flush has not consumed yet is still needed; so is a slot the candidate is still using (its close,
      // and its second transmission, both belong to the live candidate) and an unknown one, which is evidence.
      const slot = ledger.slot(attempt);
      if (slot?.kind === 'auxiliary' && attemptCalls.get(attempt)?.ended !== true) return;
      if (slot && slot.closedAt === null && !settled.has(attempt)) return;
      if (slot && !ledger.release(attempt)) return;
      observed.delete(attempt);
      attemptCalls.delete(attempt);
      attempts.delete(attempt);
      for (const key of [...consumed]) if (key.startsWith(attempt + ':')) consumed.delete(key);
    };
    for (const attempt of settled) retire(attempt);
    // A superseded candidate closes its attempts after the flush that wrote their evidence, so the slot is retired on the
    // next pass rather than being left for the life of the process.
    for (const attempt of [...observed]) retire(attempt);
    const ledgerMissing = ledger.missing();
    while (missingRead < ledgerMissing.length) record({ type: 'evidenceMissing', ...ledgerMissing[missingRead++] });
    // Audits have their own entities, never effect rows. Revoked/frozen writers retain diagnostic memory only.
    while (unpersisted.length) {
      const index = auditWrites++, row = unpersisted.shift();
      // A frozen or revoked store takes no audit rows. Counting the refusal is what makes "the audit is not in the
      // database" observable in status(), instead of it disappearing into an empty catch (D review #5).
      try { host.coreAccess.lifecycle().mutate('visibility-audit:' + host.epoch + ':' + index, 'adapter', row,
        tx => tx.put('visibility-audit:' + host.epoch + ':' + index, row)); } catch { persistFailed += 1; }
    }
  });
  // Only iterator termination proves the call cannot produce another transmission.
  // Transmission outcomes alone, and a sibling's prepared event, prove no such thing.
  const retireAuxiliary = attempt => {
    const call = attemptCalls.get(attempt);
    if (!call?.ended || !ledger.slot(attempt)) return false;
    ledger.close(attempt, 'auxiliary-settled');
    if (!ledger.release(attempt)) return false;
    observed.delete(attempt);
    call.attempts.delete(attempt);
    attemptCalls.delete(attempt);
    attempts.delete(attempt);
    for (const key of [...consumed]) if (key.startsWith(attempt + ':')) consumed.delete(key);
    for (const key of [...confirmed.keys()]) if (key.startsWith(attempt + ':')) confirmed.delete(key);
    return true;
  };
  const stopLease = host.clock.every(leaseMs, () => {
    ledger.expire(now());
    void flush().catch(error => missing(error.code ?? 'flush-failed'));
  }, 'visibility-evidence');
  const api = {
    stop: stopLease,
    ledger,
    /** The tool-gap dirty mark belongs to this layer (dirty.mjs): registration validates the pair once, the hook calls
     * mark, and a failing mark never leaves this object as an exception (review 2 #2). */
    dirty: Object.freeze({ assert: assertDirtyWiring, mark: markDirtySafely }),
    preStep(sessionId, messageId) {
      return queue(sessionId, () => {
        const r = route(sessionId); if (!r) return null;
        const old = candidates.get(sessionId);
        if (old) { old.closed = true; for (const [id, b] of attempts) if (b.slot === old) {
          ledger.close(id); attempts.delete(id); for (const key of confirmed.keys()) if (key.startsWith(id + ':')) confirmed.delete(key);
        } }
        const candidate = batchMode ? prepareBatch(core, r.memberId, { binding: { generation: r.generation,
          executionRef: routeKey(r) } }) : prepareVisibility(core, r.memberId); if (!candidate) return null;
        // The generation this candidate is built for travels with it: recordInjection re-reads the member row in its
        // own transaction and refuses the manifest if the member has left that generation (D review #2).
        candidate.generation = r.generation;
        const slot = { candidate, routeKey: routeKey(r), messageId, sessionId, memberId: r.memberId, generation: r.generation, digest: dispatchDigest({ role: 'user', content: [{ type: 'text', text: candidate.text }] }), closed: false, active: 0, ambiguous: false };
        candidates.set(sessionId, slot);
        return { id: messageId, role: 'user', source: { kind: 'trusted-team-plugin' }, content: [{ type: 'text', text: candidate.text }] };
      });
    },
    candidate(options) {
      const call = { sessionId: options.sessionId, purpose: options.purpose ?? null, attempts: new Set(), ended: false };
      const releaseAuxiliary = () => {
        if (call.ended) return;
        call.ended = true;
        for (const attempt of [...call.attempts]) retireAuxiliary(attempt);
      };
      calls.set(releaseAuxiliary, call);
      // Source-bound publisher: safe to retain and invoke outside this call, or from a sibling's callback.
      releaseAuxiliary.dispatch = (event, path) => api.dispatch(event, path, releaseAuxiliary);
      const slot = candidates.get(options.sessionId);
      if (!route(options.sessionId)) return () => {};
      if (!isMain(options)) return releaseAuxiliary;
      if (!carriesCandidate(options, slot, isMain)) {
        // One line per session, not one per main request: a run makes far more model requests than team messages, and
        // every line here becomes an entity row in the team database (D review #5).
        if (!skipped.has(options.sessionId)) { skipped.add(options.sessionId); missing('visibilitySkipped', { sessionId: options.sessionId }); }
        return () => {};
      }
      slot.active++; if (slot.active > 1) { slot.ambiguous = true; missing('ambiguous', { sessionId: options.sessionId }); }
      const prior = new Set(attempts.keys());
      let closed = false;
      return () => { if (!closed) {
        closed = true; slot.active--;
        const ids = [...attempts].filter(([id, b]) => !prior.has(id) && b.slot === slot).map(([id]) => id);
        if (!ids.length) missing('patch-missing-or-unconfirmed', { sessionId: options.sessionId });
        void flush().catch(error => missing(error.code ?? 'flush-failed'));
      } };
    },
    dispatch(raw, path = 'other', callIdentity = null) {
      try {
        const event = structuredClone(assertDispatchEvent(raw));
        if (!route(event.sessionId)) return;
        const stored = ledger.slot(event.attempt);
        const owner = attemptCalls.get(event.attempt);
        // Stored ownership cannot be bypassed by relabelling an auxiliary phase as main.
        if (stored && (stored.kind !== event.kind || stored.sessionId !== event.sessionId || stored.purpose !== event.purpose)) {
          missing('attempt-session-mismatch', { attempt: event.attempt, phase: event.phase });
          void flush().catch(error => missing(error.code ?? 'flush-failed'));
          return { accepted: false, reason: 'attempt-session-mismatch' };
        }
        if (event.kind === 'auxiliary' || owner) {
          const call = callIdentity ? calls.get(callIdentity) : null;
          const preparing = event.phase === 'prepared' && !stored;
          if (preparing ? (!call || call.ended || call.sessionId !== event.sessionId || call.purpose !== event.purpose)
            : (!call || !owner || call !== owner || owner.sessionId !== event.sessionId || owner.purpose !== event.purpose || stored?.kind !== 'auxiliary')) {
            // Legacy/native events without a source-bound identity are explicitly unsupported, NOT "not sent".
            // Reject before observed/ledger insertion: no orphan slot, receipt, or guessed sibling ownership.
            missing('auxiliary-call-unverified', { attempt: event.attempt, phase: event.phase, sessionId: event.sessionId });
            void flush().catch(error => missing(error.code ?? 'flush-failed'));
            return { accepted: false, reason: 'auxiliary-call-unverified' };
          }
          if (preparing) { call.attempts.add(event.attempt); attemptCalls.set(event.attempt, call); }
        }
        observed.add(event.attempt);
        const session = sessions.get(event.sessionId);
        const seq = session?.seq;
        if (event.phase === 'prepared' && event.kind === 'main' && !attempts.has(event.attempt)) {
          const slot = candidates.get(event.sessionId);
          if (slot && slot.active === 1 && !slot.closed && !slot.ambiguous) attempts.set(event.attempt, { slot, sessionId: event.sessionId, transmissions: new Map() });
          else missing('unbound-attempt', { attempt: event.attempt });
        }
        const b = attempts.get(event.attempt);
        if (b && (b.sessionId !== event.sessionId || event.kind !== 'main' || event.purpose !== null)) { missing('attempt-session-mismatch', { attempt: event.attempt }); return; }
        if (b && event.phase === 'send-started' && !b.transmissions.has(event.transmission)) b.transmissions.set(event.transmission, { sendStartedAt: event.sendStartedAt, sessionSeq: seq });
        if (b && event.phase === 'committed') {
          b.event = event; b.tx = b.transmissions.get(event.transmission); b.confirmedSessionSeq = seq;
          // Only the journal events this receipt can use are kept: the flush looks for the one native user/message that
          // carried the candidate (by id) and refuses anything but exactly one match. Cloning the whole journal instead -
          // once per commit, over a journal that only grows - made a long run's memory quadratic in its own history;
          // the offline soak's 30-minute heap plateau is what caught it (M1b-F2 §22.8).
          const carried = (session?.snapshotEvents() ?? []).filter(e => e.type === 'user/message' && e.data?.id === b.slot.messageId)
            .map(e => structuredClone(e));
          confirmed.set(event.attempt + ':' + event.transmission, { ...b, events: carried });
          if (Object.hasOwn(capabilities, path)) capabilities[path] = 'adapter-confirmed';
        }
        const result = ledger.observe(event, { epoch: host.epoch, sessionSeq: seq, confirmedSessionSeq: seq });
        // Late answers can retire an ended call, but never an active or unowned one.
        if (event.kind === 'auxiliary' && attemptCalls.get(event.attempt)?.ended) retireAuxiliary(event.attempt);
        // Review 2 #5 / review 1 #6: a failure diagnosis goes through the ONE bounded, persisted entry point. A direct
        // audit.push() bypassed both the 256-row tail and the write queue, so consecutive failures grew this array
        // without limit and the team database never saw a single one of them.
        if (event.phase === 'failed') record({ type: result.classification ?? 'dispatchFailed', attempt: event.attempt, transmission: event.transmission ?? null, at: event.at });
        // Snapshot the complete receipt binding before an asynchronous flush can see a later transmission.
        if (event.phase === 'committed' && event.kind === 'main') return flush().catch(error => missing(error.code ?? 'flush-failed'));
        if (event.phase === 'failed') void flush().catch(error => missing(error.code ?? 'flush-failed'));
      } catch (error) {
      // A throw without a contract code is not a validation failure. Flattening everything into "invalid-event" hid a
      // real defect for a whole round (F2b: the event reached this boundary and the failure was invisible), so the
      // classified failures keep their own code and everything else keeps its name and message for the operator.
      const known = error && typeof error.code === 'string' && error.code.startsWith('INVALID_DISPATCH_EVENT');
      missing(known ? 'invalid-event' : (error?.code ?? 'dispatch-failed'),
        { name: error?.name ?? null, message: error?.message ?? String(error) });
    }
    },
    expire() { ledger.expire(now()); },
    settled: flush,
    // retained is the diagnostic count of the live bindings this layer holds: a run must not grow them per dispatch
    // (attempts and confirmed are released once their receipt is consumed or their candidate is superseded, §22.8).
    // Review 2 #6: every auxiliary structure this layer holds is counted, so a soak can assert each one is bounded
    // instead of relying on a heap-per-event ratio that a history-sized array hides inside.
    status() { return { ...ledger.status(), retained: { attempts: attempts.size, confirmed: confirmed.size },
      visible: visibleCount, evidenceMissing: missingCount + ledger.missing().length - missingRead,
      auditRetained: audit.length, auditWrites, auditPersistFailed: persistFailed,
      observations: observed.size, consumedKeys: consumed.size, candidates: candidates.size, skippedSessions: skipped.size,
      dispatchEvidence: { ...capabilities } }; },
    audit() { return [...audit, ...ledger.missing().slice(missingRead).map(a => ({ type: 'evidenceMissing', ...a }))]; },
  };
  host.observeVisibility(() => api.status());
  return api;
}
