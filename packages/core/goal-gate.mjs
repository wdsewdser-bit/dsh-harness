import fs from 'node:fs';
import path from 'node:path';
import { recordReadModel } from './read-model.mjs';
import { verify as verifySignature } from 'node:crypto';
import { canonical, digest, fail, failWith, id } from '../contracts/index.mjs';
import { autonomyOn, autonomySettings, operatorBindingOf, ownerBindingOf } from './authority.mjs';
import { completionProofOf, openDecision } from './commands/decisions.mjs';
import { closeGoalOnCompletion, goalGateSettings, goalIdOf, queueKeyOf } from './commands/goals.mjs';

/**
 * Readback failures that mean "this host cannot prove anything about the evidence", as opposed to "the evidence
 * says no" (review finding 1). They are recorded as a missing capability and reported, never folded into a plain
 * false that would read like an ordinary unmet precondition.
 */
const CAPABILITY_CODES = Object.freeze(['GIT_SCOPE', 'GIT_UNAVAILABLE', 'GIT_TIMEOUT']);

/**
 * The runner the gate reads Git back through, when the composition installed none. It answers every call with the
 * capability gap GIT_UNAVAILABLE: the gate reports "this host cannot prove anything about the evidence" rather than
 * guessing, and core keeps no import into delivery (delivery owns the real runner).
 */
const NO_GIT_GUARD = Object.freeze({
  run: () => ({ ok: false, unknown: true, code: 'GIT_UNAVAILABLE',
    reason: 'no git guard runner is configured (inject configuration.ports.gitGuard)' }),
});

/**
 * The domain refusals the completion guard may answer with false. Anything else escapes evaluateCheck: an
 * unexpected defect must not look like "the team is not ready to complete".
 */
const REFUSAL_CODES = Object.freeze(['UNMET_DELIVERY', 'UNKNOWN_EFFECT', 'STALE_CERTIFICATE', 'TARGET_DRIFT',
  'UNMET_TEAM_STATE', 'STALE_COMPLETION', 'GIT_FAILED', 'COMPLETION_FROZEN', 'CAS_CONFLICT', 'ID_CONFLICT', 'DENIED',
  'RECOVERY_REQUIRED', 'DELIVERY_CHAIN_GAP', 'DELIVERY_CHAIN_FORK', 'DELIVERY_EVIDENCE_MISSING',
  // §5.2.2/§5.2.3/§5.3: the goal record's own refusals. They are domain verdicts ("this team is not ready to
  // complete"), so the guard answers false for them instead of throwing out of evaluateCheck.
  'TEAM_GOAL_REQUIRED', 'TEAM_GOAL_TOO_LATE', 'TARGET_BASE_UNRECORDED', 'TARGET_ALREADY_HAS_DELIVERIES',
  'UNVERIFIED_LEGACY_BASE']);

/** A ref that does not exist yet, as opposed to a repository this host cannot read (§5.2.2: the base is read back). */
const UNKNOWN_REF = /unknown revision|ambiguous argument|Needed a single revision|not a valid object name/i;

const isCapabilityFailure = error => CAPABILITY_CODES.includes(error?.code);
const isRefusal = error => REFUSAL_CODES.includes(error?.code);

/** Validate one target queue rooted in its first product acceptance event.
 * Signed links prove closure; product acceptance order, never actor order, proves queue order. */
/**
 * §3.4 (P1): the threads that still block a team completion.
 *
 * Only a DECISION thread does: a resource thread is a topic with events and subscribers, not an unanswered review,
 * so a long-lived resource nobody responded to must not hold the goal open. A legacy row has no kind and is a
 * decision thread, which keeps the completion predicate of every existing team exactly as it was.
 */
export function unresolvedDecisionThreads(store) {
  return store.list('thread:').filter(row => row.kind !== 'resource' && !['decided', 'closed'].includes(row.status));
}
export function assertCertifiedQueue(deliveries, { initialBase, head, headTree, readTask, isAncestor }) {
  if (typeof initialBase !== 'string' || !initialBase) fail('DELIVERY_CHAIN_GAP');
  if (!deliveries.length) fail('UNMET_DELIVERY');
  const successors = new Map(), candidates = new Set();
  for (const d of deliveries) {
    const c = d.certificate;
    if (d.status !== 'accepted' || !c || digest(c) !== d.certificateHash ||
        d.integrationCommit !== c.candidate || d.integrationTree !== c.tree) fail('UNMET_DELIVERY');
    const task = readTask(d.taskId);
    let signed = false;
    try { signed = verifySignature(null, Buffer.from(canonical(c)), d.publicKey, Buffer.from(d.signature, 'base64')); } catch {}
    if (![c.base, c.candidate, c.tree].every(value => typeof value === 'string' && value.length > 0) ||
        !task?.approved || task.contractRevision !== c.contractRevision || d.owner === c.verifier ||
        digest({scopeSet: task.scopeSet, contractRevision: task.contractRevision, approved: task.approved}) !== c.contractHash ||
        !signed || d.base !== c.base || d.candidate !== c.candidate || d.tree !== c.tree) fail('STALE_CERTIFICATE');
    if (successors.has(c.base) || candidates.has(c.candidate)) fail('DELIVERY_CHAIN_FORK');
    successors.set(c.base, d); candidates.add(c.candidate);
  }
  const ordered = []; let cursor = initialBase;
  const seen = new Set();
  while (successors.has(cursor)) {
    const next = successors.get(cursor);
    if (seen.has(next)) fail('DELIVERY_CHAIN_FORK');
    seen.add(next); ordered.push(next); cursor = next.integrationCommit;
  }
  if (ordered.length !== deliveries.length) fail('DELIVERY_CHAIN_GAP');
  for (const d of ordered) if (d.base === d.integrationCommit || isAncestor(d.base, d.integrationCommit) !== true) fail('TARGET_DRIFT');
  const tail = ordered.at(-1);
  // Equality is essential: even an otherwise valid descendant may contain uncertified changes.
  if (head !== tail.integrationCommit || headTree !== tail.integrationTree) fail('TARGET_DRIFT');
  return Object.freeze(ordered.map(d => d.entityId));
}

/** Read committed delivery evidence synchronously for C1 completion; 08 §4.9. */
export class GoalGate {
  /**
   * sessionLog is the offline journal port (design §3.8, adapter-dsh openSessionLog): { sessionId } -> a log view
   * ({ events, complete } or { snapshotEvents() }) or a falsy value when it cannot be read. Without one, reconcile() can
   * only read a live session object; an unreadable or incomplete journal is reported as a missing capability, never as
   * "nothing ran".
   */
  constructor(core, alarm = () => {}, { sessionLog = null, gitGuard = null } = {}) {
    this.core = core; this.alarm = alarm;
    this.sessionLog = typeof sessionLog === 'function' ? sessionLog : null;
    // The guard's readback (review findings 1 and 6) is a port, not an import: delivery still exports the factory
    // (createGitGuardRunner - its own roots, its own short budget, so a slow disk is GIT_TIMEOUT instead of freezing
    // every timer of the host for the full batch budget) and the composition injects the runner through
    // configuration.ports.gitGuard or this option. That keeps the one edge core -> delivery out of the source graph.
    this.git = gitGuard ?? core?.ports?.gitGuard ?? core?.configuration?.ports?.gitGuard ?? NO_GIT_GUARD;
    this.cachedEvidence = null;
    this.lastCapability = null;
    this.capabilityFailures = 0;
    // §12 U5: every chain still rooted at rows[0].base is reported, never silently. One record per queue per
    // readback, kept on the gate so a report can read what the compatibility stance actually used.
    this.lastLegacyChain = null;
    this.legacyChains = 0;
  }
  /** The team goal row (§5.2.1) or null: one row per team, so presence is the whole switch for the migration stance. */
  teamGoal() {
    return this.core.store.read(goalIdOf(this.core));
  }
  goalSettings() {
    return goalGateSettings(this.core);
  }
  /** The legacy-chain reports of this gate (§12 U5 / §5.2.4): what was still rooted at rows[0].base, and when. */
  legacyChain() {
    return Object.freeze({ count: this.legacyChains, last: this.lastLegacyChain });
  }
  recordLegacyChain(record) {
    this.legacyChains += 1;
    this.lastLegacyChain = Object.freeze({ ...record, at: Date.now() });
    return this.lastLegacyChain;
  }
  /**
   * One evidence readback per public entry (review finding 6). The hash is a snapshot for this evaluation: recomputing
   * it inside the write transaction would block a SQLite transaction on git, the opposite of the goal.
   */
  evidenceOnce() {
    if (this.cachedEvidence === null) this.cachedEvidence = this.evidence();
    return this.cachedEvidence;
  }
  clearEvidence() {
    this.cachedEvidence = null;
  }
  /** Remember and report a readback that could not be performed: a capability gap, not a verdict (finding 1). */
  recordCapability(error) {
    this.capabilityFailures += 1;
    this.lastCapability = Object.freeze({ code: error?.code ?? 'ERROR', message: error?.message ?? String(error), at: Date.now() });
    return this.lastCapability;
  }
  capability() {
    return Object.freeze({ last: this.lastCapability, failures: this.capabilityFailures });
  }
  evidence() {
    const deliveries = this.core.store.list('delivery:');
    if (!deliveries.length || deliveries.some(d => d.status !== 'accepted' || !d.certificate ||
      digest(d.certificate) !== d.certificateHash || d.integrationCommit !== d.certificate.candidate ||
      d.integrationTree !== d.certificate.tree)) fail('UNMET_DELIVERY');
    if (this.core.store.effects().some(e => !['confirmed', 'cancelled'].includes(e.status)) ||
      this.core.store.list('inconsistency:').some(row => row.status !== 'resolved')) fail('UNKNOWN_EFFECT');
    const events = this.core.store.events();
    const accepted = new Map();
    for (const e of events) if (e.payload?.status === 'accepted' && e.entity?.startsWith('delivery:') && !accepted.has(e.entity)) {
      accepted.set(e.entity, e);
    }
    const queues = new Map();
    for (const d of deliveries) {
      const event = accepted.get(d.entityId);
      if (!event || event.payload.integrationCommit !== d.integrationCommit || event.payload.certificateHash !== d.certificateHash) fail('DELIVERY_EVIDENCE_MISSING');
      const snapshot = this.git.run(d.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir', d.target, d.target + '^{tree}']);
      if (!snapshot.ok) failWith(snapshot.code ?? 'GIT_FAILED', snapshot.reason);
      const [common, head, tree] = snapshot.value.split(/\r?\n/);
      if (!common || !head || !tree) fail('GIT_FAILED');
      const real = fs.realpathSync(path.resolve(d.directory, common));
      // §5.2.1: the queue key is the (real common dir, target) pair, and queueKeyOf is the same function the goal
      // record uses to name a base, so "the base of this queue" means one thing in both files.
      const key = queueKeyOf(process.platform === 'win32' ? real.toLowerCase() : real, d.target);
      let queue = queues.get(key);
      if (!queue) queues.set(key, queue = { head, tree, rows: [] });
      if (queue.head !== head || queue.tree !== tree) fail('TARGET_DRIFT');
      queue.rows.push({ row: d, seq: event.seq });
    }
    // §5.2.2 / §5.2.4: the chain root is the base the goal record holds for THIS (directory, target), not the base
    // of the first delivery that happened to be accepted. With no record the compatibility stance keeps HEAD's rule
    // and reports the chain it used (U5: a legacy root is never silent).
    const goal = this.teamGoal();
    const settings = this.goalSettings();
    if (!goal && settings.strict) {
      failWith('TEAM_GOAL_REQUIRED', 'this team has no goal record and the goal gate is strict: open one before the ' +
        'first task so every chain starts at a base somebody recorded');
    }
    const legacyIds = new Set((goal?.legacy?.chains ?? []).flatMap(chain => chain.deliveries ?? [])
      .map(row => row.deliveryId));
    for (const [key, queue] of queues) {
      const all = queue.rows.sort((a,b) => a.seq - b.seq).map(e => e.row);
      // The adopted legacy chain stays readable and stops being the chain that closes now (§5.2.4 step 4): its rows
      // are recorded in goal.legacy.deliveries with chainEpoch 1 and are excluded here by id, not rewritten.
      const rows = all.filter(row => !legacyIds.has(row.entityId));
      const recorded = (goal?.bases ?? []).find(base => queueKeyOf(base.key.realCommonDir, base.key.target) === key);
      if (!rows.length) {
        // Nothing accepted since the goal was adopted: the target must still be exactly at the recorded base (§5.2.4).
        if (recorded && (queue.head !== recorded.commit || queue.tree !== recorded.tree)) fail('TARGET_DRIFT');
        continue;
      }
      let initialBase;
      if (recorded) initialBase = recorded.commit;
      else if (settings.strict) {
        failWith('TARGET_BASE_UNRECORDED', 'the goal record has no initial base for ' + JSON.parse(key)[1] + ' in ' +
          JSON.parse(key)[0] + '; add one with team.goal.addTarget before the first delivery on that target');
      } else {
        initialBase = rows[0].base;
        this.recordLegacyChain({ key: JSON.parse(key), mode: 'adopt-tail', initialBase, deliveries: rows.length,
          head: queue.head, tree: queue.tree });
      }
      const ids = assertCertifiedQueue(rows, { initialBase, head: queue.head, headTree: queue.tree,
        readTask: id => this.core.store.read(id), isAncestor: (base, candidate) => {
          const result = this.git.run(rows[0].directory, ['merge-base', '--is-ancestor', base, candidate]);
          if (!result.ok && result.code !== 'GIT_FAILED') failWith(result.code, result.reason);
          return result.ok;
        } });
      if (ids.some((id,index) => id !== rows[index].entityId)) fail('DELIVERY_CHAIN_GAP');
    }
    const tasks = this.core.store.list('task:');
    if (tasks.some(t => !['accepted', 'cancelled'].includes(t.status)) ||
      this.core.store.list('attempt:').some(a => ['active', 'unknown'].includes(a.lease)) ||
      unresolvedDecisionThreads(this.core.store).length > 0 ||
      this.core.store.list('wait:').some(w => w.status === 'pending')) fail('UNMET_TEAM_STATE');
    // §5.2.3: the goal row is part of the evidence, not only of the fingerprint. A prepared token stores this hash, so
    // a goal that moved between prepare and check must make the token unfindable (STALE_COMPLETION) rather than
    // silently authorise a completion against a chain root nobody was looking at. With no goal the digest is exactly
    // HEAD's digest -- the compatibility stance must stay byte-identical, not merely equivalent.
    const goalFacts = goal ? [goal.entityId, goal.revision, goal.state,
      (goal.bases ?? []).map(base => [base.key.target, base.commit])] : null;
    return digest(goalFacts ? { deliveries, tasks, teamGoal: goalFacts } : { deliveries, tasks });
  }
  prepare(input) {
    try {
      // §5.2.3: once a team has a goal record, a completion request names it. A token prepared against one goal
      // revision cannot authorise a completion of another (the fingerprint below covers the row as well).
      const goal = this.teamGoal();
      if (goal && (input?.goal?.teamGoalRef !== goal.entityId ||
        (input.goal.teamGoalRevision !== undefined && input.goal.teamGoalRevision !== goal.revision))) {
        failWith('STALE_COMPLETION', 'this completion names team goal ' + String(input?.goal?.teamGoalRef ?? 'none') +
          ' but the team goal record is ' + goal.entityId + ' at revision ' + goal.revision);
      }
      const evidenceHash = this.evidenceOnce();
      const fingerprint = this.storeFingerprint();
      const tokenId = 'completion:' + id('token');
      this.core.mutate(tokenId, 'root', { input, evidenceHash }, tx => {
        if (this.storeFingerprint() !== fingerprint || tx.list('completion:').some(t => ['prepared', 'authorized', 'unknown'].includes(t.status))) fail('COMPLETION_CONFLICT');
        return tx.put(tokenId, { input, evidenceHash, status: 'prepared' });
      });
      return tokenId;
    } catch (error) {
      // A readback that could not be performed is the missing capability it is, reported as such (review finding 1);
      // a domain refusal keeps travelling as itself.
      if (isCapabilityFailure(error)) {
        const capability = this.recordCapability(error);
        failWith('EVIDENCE_UNAVAILABLE', 'the completion evidence cannot be read back (' + capability.code + ')');
      }
      throw error;
    } finally {
      this.clearEvidence();
    }
  }
  /**
   * The store half of the evidence: cheap enough to recompute inside a write transaction, where git must never run.
   * The guard uses it to notice that the rows moved between the readback and the write (review finding 6).
   */
  storeFingerprint() {
    // §5.2.3: the team goal is part of the fingerprint. Without it a goal that changed between prepare and the
    // authorising write leaves a prepared token looking like the same evidence (:189-:191 compare evidenceHash and
    // digest(input), and input carries only sessionId/objective) -- a silent defect, not a style question. The
    // migration of the chain root and this fingerprint therefore land in the same change.
    const goal = this.teamGoal();
    return digest({
      deliveries: this.core.store.list('delivery:').map(d => [d.entityId, d.status, d.certificateHash, d.integrationCommit, d.integrationTree]),
      effects: this.core.store.effects().map(e => [e.effectId, e.status]),
      inconsistencies: this.core.store.list('inconsistency:').map(i => i.entityId),
      tasks: this.core.store.list('task:').map(t => [t.entityId, t.status]),
      teamGoal: goal ? [goal.entityId, goal.revision, goal.state, (goal.bases ?? []).length,
        (goal.bases ?? []).map(base => [base.key?.target ?? null, base.commit])] : null });
  }
  check(input) {
    const allowed = this.evaluateCheck(input);
    recordReadModel(this.core, 'gate:' + input.sessionId, { sessionId: input.sessionId, goalId: input.goal.id, goalRevision: input.goal.revision, evaluatedAt: Date.now(), sourceSeq: this.core.store.latestEventSeq(), result: allowed ? 'allowed' : 'blocked' });
    return allowed;
  }
  evaluateCheck(input) {
    try {
      const evidenceHash = this.evidenceOnce();
      const fingerprint = this.storeFingerprint();
      const token = this.core.store.list('completion:').find(t => t.status === 'prepared' &&
        t.evidenceHash === evidenceHash && digest(t.input) === digest(input));
      if (!token) return false;
      this.core.mutate(token.entityId, 'adapter', {}, tx => {
        if (tx.read(token.entityId).status !== 'prepared' || this.storeFingerprint() !== fingerprint) fail('STALE_COMPLETION');
        return tx.put(token.entityId, { ...token, status: 'authorized', expectedRevision: input.goal.revision + 1 });
      });
      return true;
    } catch (error) {
      // The guard must answer with a boolean, so a capability gap is false - but it is recorded and reported through
      // capability(), never silently folded into the ordinary "not ready" verdict (review finding 1).
      if (isCapabilityFailure(error)) { this.recordCapability(error); return false; }
      if (isRefusal(error)) return false;
      throw error;
    } finally {
      this.clearEvidence();
    }
  }
  inspect(session, event) {
    if (event.type === 'goal/change' && event.data?.goal) {
      const ref = 'read-model:goal:' + session.id;
      const prior = this.core.store.read(ref);
      if (!prior || event.seq > prior.sourceSeq) recordReadModel(this.core, 'goal:' + session.id, { sessionId: session.id, sourceSeq: event.seq, goal: event.data.goal });
    }
    if (event.type !== 'goal/change' || event.data?.goal?.phase !== 'complete') return;
    const goal = event.data.goal;
    const token = this.core.store.list('completion:').find(t => ['authorized', 'consumed'].includes(t.status) &&
      t.input.sessionId === session.id && t.input.goal.id === goal.id && t.expectedRevision === goal.revision &&
      t.input.goal.objective === goal.objective && t.input.goal.maxGoalRounds === goal.maxGoalRounds &&
      (t.status !== 'consumed' || t.seq === event.seq));
    if (token) {
      if (token.status !== 'consumed') this.core.mutate(token.entityId, 'adapter', {}, tx => tx.put(token.entityId, { ...token, status: 'consumed', seq: event.seq }));
      return;
    }
    const ref = 'inconsistency:' + session.id + ':' + event.seq;
    if (this.core.store.read(ref)) return;
    this.core.mutate(ref, 'adapter', {}, tx => tx.put(ref, { kind: 'inconsistency', status: 'unknown', goalId: goal.id, seq: event.seq }));
    this.alarm({ sessionId: session.id, seq: event.seq, status: 'unknown' });
  }
  /**
   * The durable journal of one session: the injected offline port first, a live session view second, and otherwise a
   * missing capability. Never an empty journal - "I could not read it" and "nothing is there" are different facts
   * (design §3.8, host-protocol invariant 7 rule 7).
   */
  journal(session) {
    const sessionId = typeof session === 'string' ? session : session?.id ?? session?.sessionId ?? null;
    if (this.sessionLog) {
      let log = null;
      try { log = this.sessionLog({ sessionId }); }
      catch (error) {
        return Object.freeze({ sessionId, available: false, capability: 'session-log-unavailable', reason: error.message ?? 'the session log could not be read' });
      }
      if (!log) return Object.freeze({ sessionId, available: false, capability: 'session-log-unavailable', reason: 'the offline session log is not available' });
      const events = typeof log.snapshotEvents === 'function' ? log.snapshotEvents() : log.events;
      if (!Array.isArray(events)) return Object.freeze({ sessionId, available: false, capability: 'session-log-unavailable', reason: 'the session log carries no event list' });
      // A journal that does not declare itself complete cannot prove that a completion is absent (review finding 4):
      // cancelling a prepared token on a truncated log would withdraw a completion that may well have happened.
      if (log.complete !== true) return Object.freeze({ sessionId, available: false, capability: 'session-log-truncated', truncated: true,
        reason: log.complete === false || log.truncated === true ? 'the session log is not a complete journal' : 'the session log does not declare itself complete' });
      return Object.freeze({ sessionId, available: true, complete: true, events, seq: log.seq ?? events.at(-1)?.seq ?? null });
    }
    if (session && typeof session === 'object' && typeof session.snapshotEvents === 'function') {
      return Object.freeze({ sessionId, available: true, events: session.snapshotEvents(), seq: session.seq ?? null });
    }
    return Object.freeze({ sessionId, available: false, capability: 'session-log-unavailable', reason: 'no offline session log port is installed' });
  }
  /**
   * §2.2.6 / §12 U7: an unknown completion opens one decision row, in the transaction that made it unknown.
   *
   * The row is opened only while the autonomy package is on (off is HEAD: the operator exit, no inbox). Its evidence
   * names the journal the verdict will have to agree with, which is what makes "root decided a completion" checkable.
   */
  /**
   * §3.2.2: the owner row's entity id, read from committed rows rather than assumed.
   *
   * A completion decision is addressed to the owner (snapshot.mjs lists exactly the rows whose openedFor is the reader),
   * so the id has to be the row's: a hard-coded name would put the one row that unfreezes the team into an inbox nobody
   * reads.
   */
  ownerMemberId() {
    const owner = this.core.store.list('member:').find(row => row.role === 'root' && row.desired === 'active');
    return owner?.entityId ?? 'member:root';
  }
  openCompletionDecision(tx, tokenRow, sessionId, at = Date.now()) {
    if (!autonomyOn(this.core)) return null;
    const settings = autonomySettings(this.core);
    const decisionId = 'decision:' + id('decision');
    openDecision(tx, { autonomy: 'on', now: at, decisionTtlMs: settings.decisionTtlMs },
      { kind: 'completion', decisionId,
        subject: { type: 'completion', id: tokenRow.entityId, revision: tokenRow.revision },
        evidence: [
          { at, kind: 'journal', ref: sessionId, text: 'the session journal of ' + sessionId + ' is the only source of a ' +
            'completion verdict' },
          { at, kind: 'row', ref: tokenRow.entityId, text: 'completion token is unknown since ' + at },
        ],
        // §2.2.6: addressed to the owner, which is the one inbox a completion verdict belongs in. Left null, the row
        // exists and is shown to nobody, and the token it is about keeps the team frozen.
        openedFor: this.ownerMemberId(), now: at, ttlMs: settings.decisionTtlMs });
    return decisionId;
  }
  /** Completion tokens that still hold the business admission closed (index.mjs execute(): prepared/authorized/unknown). */
  unresolved(sessionId = null) {
    return this.core.store.list('completion:')
      .filter(t => ['prepared', 'authorized', 'unknown'].includes(t.status) &&
        (sessionId === null || t.input?.sessionId === sessionId));
  }
  /**
   * Reconcile every completion token of one session against its committed journal; design §3.8, invariant 7 rule 4.
   *
   * The conclusion is returned, not implied: an unreadable journal is status 'unknown' with the missing capability
   * named, and no token is touched - the caller keeps admission closed. Prepared tokens are reconciled too:
   *   - the journal proves the goal completed, so the completion happened without the gate's authorization -> unknown,
   *     kept as evidence for the one operator adjudication exit;
   *   - the journal does not contain it, so nothing was published -> cancelled (a safe withdrawal, not a verdict).
   */
  reconcile(session) {
    const journal = this.journal(session);
    if (!journal.available) {
      return Object.freeze({ sessionId: journal.sessionId, status: 'unknown', capability: journal.capability ?? 'session-log-unavailable',
        reason: journal.reason ?? null, inspected: 0, prepared: 0, cancelled: 0, unknown: 0,
        unresolved: this.unresolved(journal.sessionId).length });
    }
    const view = { id: journal.sessionId, seq: journal.seq, snapshotEvents: () => journal.events };
    const events = journal.events;
    const complete = goal => events.some(e => e.type === 'goal/change' && e.data?.goal?.phase === 'complete' &&
      e.data.goal.id === goal?.id && e.data.goal.revision === (goal?.revision ?? 0) + 1);
    for (const event of events) this.inspect(view, event);
    let unknown = 0; let prepared = 0; let cancelled = 0;
    for (const token of this.core.store.list('completion:').filter(t => t.input.sessionId === journal.sessionId && t.status !== 'prepared' && (t.status === 'authorized' ||
      (t.status === 'consumed' && !events.some(e => e.seq === t.seq && e.type === 'goal/change' && e.data?.goal?.phase === 'complete'))))) {
      this.core.mutate(token.entityId, 'adapter', {}, tx => {
        const written = tx.put(token.entityId, { ...token, status: 'unknown', reason: 'authorized completion absent from durable journal', responsible: 'operator',
          lastEvidence: { sessionId: journal.sessionId, journalSeq: journal.seq ?? null }, nextReviewAt: Date.now() + 60000 });
        this.openCompletionDecision(tx, written, journal.sessionId);
        return written;
      });
      unknown++;
    }
    for (const token of this.core.store.list('completion:').filter(t => t.status === 'prepared' && t.input?.sessionId === journal.sessionId)) {
      prepared++;
      if (complete(token.input.goal)) {
        // Evidence that a completion was published while this preparation was still un-resolved: keep it, do not
        // rewrite the goal's history, and leave the decision to the operator exit.
        this.core.mutate(token.entityId, 'adapter', {}, tx => {
          const written = tx.put(token.entityId, { ...tx.read(token.entityId), status: 'unknown',
            reason: 'a completion for this preparation is in the durable journal but was never authorized', responsible: 'operator',
            lastEvidence: { sessionId: journal.sessionId, journalSeq: journal.seq ?? null, goalId: token.input.goal?.id ?? null },
            nextReviewAt: Date.now() + 60000 });
          this.openCompletionDecision(tx, written, journal.sessionId);
          return written;
        });
        unknown++;
      } else {
        this.core.mutate(token.entityId, 'adapter', {}, tx => tx.put(token.entityId, { ...tx.read(token.entityId), status: 'cancelled',
          reason: 'the prepared completion was never authorized before the restart',
          lastEvidence: { sessionId: journal.sessionId, journalSeq: journal.seq ?? null } }));
        cancelled++;
      }
    }
    return Object.freeze({ sessionId: journal.sessionId, status: 'ok', capability: null, reason: null,
      inspected: events.length, prepared, cancelled, unknown, unresolved: this.unresolved(journal.sessionId).length });
  }
  /**
   * Who may adjudicate a completion (§3.2.2, §12 U7): the operator principal that has no member row, and -- while the
   * autonomy package is on -- the team owner row. Both are predicates over committed rows; neither is a name test.
   * With the switch off this is exactly HEAD's "operator only", so the live operator exit and every existing caller
   * keep their behaviour.
   */
  completionActorAllowed(reader, actor) {
    if (operatorBindingOf(reader, actor)) return true;
    return autonomyOn(this.core) && Boolean(ownerBindingOf(reader, actor));
  }
  resolveCompletion(session, tokenId, decision, evidence, actor) {
    const token = this.core.store.read(tokenId);
    if (!this.completionActorAllowed(this.core.store, actor) || !evidence ||
      !['consumed', 'cancelled'].includes(decision) || !token || token.input.sessionId !== session.id) fail('DENIED');
    if (token.status === decision && token.adjudication?.decision === decision && digest(token.adjudication.evidence) === digest(evidence)) return token;
    if (token.status !== 'unknown') fail('DENIED');
    const journal = this.journal(session);
    if (!journal.available) fail('SESSION_LOG_UNAVAILABLE');
    const events = journal.events.filter(e => e.type === 'goal/change' && e.data?.goal?.phase === 'complete' &&
      e.data.goal.id === token.input.goal.id);
    const event = events.find(e => e.seq === evidence.seq && e.data.goal.revision === token.input.goal.revision + 1 &&
      e.data.goal.objective === token.input.goal.objective && e.data.goal.maxGoalRounds === token.input.goal.maxGoalRounds);
    if (decision === 'consumed' && !event) fail('JOURNAL_CONFLICT');
    if (decision === 'cancelled' && events.length) fail('JOURNAL_CONFLICT');
    const adjudication = { decision, evidence, actor, at: Date.now() };
    return this.core.mutate(tokenId, actor, { adjudication }, tx => {
      // The authoritative check: the pre-read above is a fast refusal, this one is the rule (§3.2.5, "the request body
      // cannot choose the channel").
      if (!this.completionActorAllowed(tx, actor)) {
        failWith('DENIED', 'a completion verdict is the operator channel, or the team owner while the autonomy package ' +
          'is on; ' + String(actor) + ' is neither');
      }
      const current = tx.read(tokenId);
      if (current.status !== 'unknown') fail('DENIED');
      if (event) {
        const ref = 'inconsistency:' + session.id + ':' + event.seq;
        const inconsistency = tx.read(ref);
        if (inconsistency) tx.put(ref, { ...inconsistency, status: 'resolved', tokenId, adjudication });
      }
      // §5.2.2: a consumed completion is what closes the team goal, in the same transaction as the verdict.
      if (decision === 'consumed') closeGoalOnCompletion(tx, { goalId: goalIdOf(this.core), tokenId, at: adjudication.at });
      // A row opened for this token stops being decidable the moment the operator exit decides the token: leaving it
      // open would let a later verdict apply to a subject that already moved, which is exactly what DECISION_STALE
      // exists to prevent (§2.3). Superseding it here is the same rule, resolved by the channel that got there first.
      for (const row of tx.list('decision:')) {
        if (row.state !== 'open' || row.subject?.id !== tokenId) continue;
        tx.put(row.entityId, { ...row, state: 'superseded', supersededAt: adjudication.at,
          supersededBy: actor, supersededReason: 'the completion token was resolved through the ' + actor + ' channel' });
      }
      return tx.put(tokenId, { ...current, status: decision, ...(event ? { seq: event.seq, expectedRevision: event.data.goal.revision } : {}),
        adjudication, responsible: null, nextReviewAt: null });
    });
  }
  resolveAbsent(session, tokenId, evidence, actor) {
    return this.resolveCompletion(session, tokenId, 'cancelled', evidence, actor);
  }
  /**
   * The decision channel for a completion (§2.2.1 completion row, §12 U7): the same journal evidence, a different
   * entry.
   *
   * Root may decide a completion, but only on log evidence: this method reads the journal first (outside the
   * transaction, as every readback in this file does), works out what the log proves, and hands that proof to the
   * decision reducer as trusted metadata. commands/decisions.mjs refuses a completion verdict that arrives without
   * one, so no entry can turn "I think it finished" into a consumed token.
   */
  decideCompletion(session, decisionId, verdict, actor, entry = 'owner') {
    const decision = this.core.store.read(decisionId);
    if (!decision) fail('MISSING_REFERENCE');
    if (decision.kind !== 'completion') {
      failWith('INVALID_ADJUDICATION', decisionId + ' is a ' + decision.kind + ' decision, not a completion');
    }
    if (decision.state !== 'open') {
      failWith('DECISION_STALE', 'decision ' + decisionId + ' is ' + decision.state);
    }
    const option = verdict?.decision;
    if (!['consumed', 'cancelled'].includes(option)) fail('INVALID_ADJUDICATION');
    const token = this.core.store.read(decision.subject?.id);
    if (!token || token.input?.sessionId !== session.id) fail('DENIED');
    // The proof is computed by the one function the tool entry uses too (commands/decisions.mjs): two entries, one rule,
    // so "the journal proves it" cannot mean two things.
    const proof = completionProofOf(this.journal(session), token, option);
    return this.core.decideDecision(decisionId, actor, { decision: option, reason: verdict.reason ?? null }, entry,
      { journal: proof });
  }
  /** Read one (directory, target) back as an initial base (§5.2.2: the host reads, root never reports it). */
  readBase(directory, target) {
    let snapshot = this.git.run(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir', target,
      target + '^{tree}']);
    if (!snapshot.ok && UNKNOWN_REF.test(String(snapshot.reason ?? ''))) {
      // A target that has never been published has no ref yet; the initial base is where the repository is now, which
      // is exactly the commit its first delivery will build on. Any other failure stays the git failure it is.
      snapshot = this.git.run(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir', 'HEAD', 'HEAD^{tree}']);
    }
    if (!snapshot.ok) failWith(snapshot.code ?? 'GIT_FAILED', snapshot.reason);
    const [common, head, tree] = snapshot.value.split(/\r?\n/);
    if (!common || !head || !tree) fail('GIT_FAILED');
    const real = fs.realpathSync(path.resolve(directory, common));
    const at = Date.now();
    return { key: { realCommonDir: process.platform === 'win32' ? real.toLowerCase() : real, target }, directory, target,
      commit: head, tree, recordedAt: at, recordedBy: 'adapter',
      evidence: { method: 'git rev-parse --path-format=absolute', raw: snapshot.value, at, gitExit: 0 } };
  }
  /** The queue key of one stored delivery row, by the same realpath normalisation the readback uses. */
  keyOfRow(row, cache = new Map()) {
    const cacheKey = String(row.directory) + '|' + String(row.target);
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const snapshot = this.git.run(row.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir', row.target]);
    if (!snapshot.ok) failWith(snapshot.code ?? 'GIT_FAILED', snapshot.reason);
    const common = snapshot.value.split(/\r?\n/)[0];
    const real = fs.realpathSync(path.resolve(row.directory, common));
    const key = queueKeyOf(process.platform === 'win32' ? real.toLowerCase() : real, row.target);
    cache.set(cacheKey, key);
    return key;
  }
  /** Acceptance order of the delivery rows, which is the only order a queue may be read in (§5.1). */
  acceptanceSeq() {
    const seqs = new Map();
    for (const event of this.core.store.events()) {
      if (event.payload?.status === 'accepted' && event.entity?.startsWith('delivery:') && !seqs.has(event.entity)) {
        seqs.set(event.entity, event.seq);
      }
    }
    return seqs;
  }
  /**
   * Open the team goal (§5.2.2/§5.2.4) after reading every base back.
   *
   * A store that already has accepted deliveries is adopted: each queue is validated with HEAD's own rule (its root
   * is the first delivery's base), and the recorded base of that key becomes the chain TAIL, so the old chain stays
   * readable as history and the next delivery extends it. When the old chain does not close exactly at the current
   * head, nothing is opened: UNVERIFIED_LEGACY_BASE, never a base recorded from a chain that does not add up.
   */
  openGoal(objective, { targets = [], actor = 'member:root' } = {}) {
    const goalId = goalIdOf(this.core);
    const bases = [];
    const chains = [];
    const cache = new Map();
    const seqs = this.acceptanceSeq();
    const accepted = this.core.store.list('delivery:').filter(row => row.status === 'accepted' && seqs.has(row.entityId));
    for (const { directory, target } of targets) {
      const base = this.readBase(directory, target);
      const key = queueKeyOf(base.key.realCommonDir, base.key.target);
      const rows = accepted.filter(row => this.keyOfRow(row, cache) === key)
        .sort((left, right) => seqs.get(left.entityId) - seqs.get(right.entityId));
      if (rows.length) {
        let ordered;
        try {
          ordered = assertCertifiedQueue(rows, { initialBase: rows[0].base, head: base.commit, headTree: base.tree,
            readTask: id => this.core.store.read(id), isAncestor: (parent, child) => {
              const result = this.git.run(rows[0].directory, ['merge-base', '--is-ancestor', parent, child]);
              if (!result.ok && result.code !== 'GIT_FAILED') failWith(result.code, result.reason);
              return result.ok;
            } });
        } catch (error) {
          failWith('UNVERIFIED_LEGACY_BASE', 'the existing chain on ' + target + ' cannot be adopted (' +
            String(error?.code ?? 'ERROR') + '); no goal was opened, and no base was recorded from a chain that does ' +
            'not close at the current head');
        }
        const tail = this.core.store.read(ordered.at(-1));
        // The chain of this key is already at the head: the tail becomes the initial base of everything that follows.
        base.commit = tail.integrationCommit;
        base.tree = tail.integrationTree;
        chains.push({ key: base.key, initialBase: rows[0].base, tail: { commit: base.commit, tree: base.tree },
          deliveries: ordered.map(deliveryId => {
            const row = this.core.store.read(deliveryId);
            return { deliveryId, seq: seqs.get(deliveryId) ?? null, base: row.base, candidate: row.candidate,
              tree: row.tree, chainEpoch: 1 };
          }) });
      }
      bases.push(base);
    }
    // §5.2.4: an existing library is adopted, an empty one is opened. The two acts have two proofs, and neither can
    // stand in for the other: adoption records each queue's existing tail, opening records where the repository is now.
    const adopting = chains.length > 0;
    const legacy = adopting ? { mode: 'adopt-tail', adoptedAt: Date.now(), chains } : null;
    return this.core.dispatch(goalId, actor, { objective, targets: bases.length },
      { type: adopting ? 'team.goal.adopt' : 'team.goal.open', policy: { authority: 'owner' },
        payload: { goalId, objective, bases, legacy } });
  }
  /** Record one more queue's initial base (§5.2.2), after the same readback. */
  addTarget(directory, target, actor = 'member:root') {
    const goalId = goalIdOf(this.core);
    const base = this.readBase(directory, target);
    const key = queueKeyOf(base.key.realCommonDir, base.key.target);
    const cache = new Map();
    // The realpath-correct refusal runs here; the reducer keeps the row-level check it can do without a filesystem.
    const produced = this.core.store.list('delivery:').filter(row => row.status === 'accepted');
    if (produced.some(row => this.keyOfRow(row, cache) === key)) {
      failWith('TARGET_ALREADY_HAS_DELIVERIES', target + ' already has accepted deliveries; its chain root is the ' +
        'first of them, not a base recorded now');
    }
    return this.core.dispatch(goalId, actor, { target }, { type: 'team.goal.addTarget',
      policy: { authority: 'owner' }, payload: { goalId, base } });
  }
  attach(ctx) {
    const off = ctx.goals.registerCompletionGuard(input => this.check(input));
    ctx.on('session/event', (session, event) => this.inspect(session, event));
    ctx.on('dispose', off);
  }
}
