import { EFFECT_CAPABILITIES, DECLARED_EFFECT_KINDS, effectCapabilities, effectSettlementFields, failWith, id,
  validateEffectKinds } from '../../contracts/index.mjs';
import { digest, openUnknownEffect } from '../../core/index.mjs';
import { evidenceOf } from './effects/protocol.mjs';

// The effect capability declaration table, its reader copy (effectCapabilities) and the start-up refusal
// (validateEffectKinds) live in contracts (§WP-C 2 of 19-M3a-M4-plan): the table is configuration, not host behaviour,
// and the read-only projections display it without importing the host. They are re-exported here so the host keeps one
// import site for its own modules and suites.
export { EFFECT_CAPABILITIES, DECLARED_EFFECT_KINDS, effectCapabilities, validateEffectKinds };

/**
 * The one lookup: a declared kind answers with its declaration, an undeclared one answers with `null` — never with a
 * default. Both the start-up check and the close-out read the table through it, so "no declaration" cannot mean one
 * thing at start-up and something else at runtime.
 */
const lookup = (declarations, kind) => (typeof kind === 'string' && Object.hasOwn(declarations, kind) ? declarations[kind] : null);

const timer = ms => new Promise(resolve => { const handle = setTimeout(resolve, Math.max(1, ms)); handle.unref?.(); });

/** One readback, bounded: a readback that does not answer is not an answer (design §6.3). */
async function readBack(port, request, timeoutMs) {
  try {
    const value = await Promise.race([Promise.resolve().then(() => port(request)), timer(timeoutMs).then(() => Symbol.for('readback-timeout'))]);
    if (value === Symbol.for('readback-timeout')) return { unknown: true, reason: 'the readback did not answer within ' + timeoutMs + 'ms', code: 'EFFECT_READBACK_UNCERTAIN' };
    return evidenceOf(value);
  } catch (error) {
    return { unknown: true, reason: String(error?.message ?? error), code: error?.code ?? 'EFFECT_READBACK_UNCERTAIN' };
  }
}

/**
 * The capability layer the runner consults before it closes an effect out.
 *
 * `null` when the switch is off: the runner then keeps the ledger's own rule untouched (notExecuted below the fifth try
 * is retried, everything else is what store has always done). With the switch on, this object decides, and the
 * ledger only records the answer it is given.
 */
export function createEffectCapabilities({ on = false, declarations = EFFECT_CAPABILITIES, kinds = null, readbacks = {},
  store = null, access = null, teamId = null, ttlMs = 900000, now = Date.now, readbackTimeoutMs = 10000, audit = () => {} } = {}) {
  if (on !== true) return null;
  if (Array.isArray(kinds)) validateEffectKinds(kinds, declarations);
  if (!store || typeof store.effects !== 'function' || typeof store.effect !== 'function' || typeof store.list !== 'function') {
    failWith('INVALID_CONFIG', 'the capability layer needs the effect ledger (store.effects/effect/list) to read back and settle');
  }
  const declarationOf = kind => lookup(declarations, kind);

  const ticketEvidence = (kind, code, message, attempts, original) => ({ unknown: true, reason: message, code,
    attempts, kind, adapterEvidence: original ?? null });

  /**
   * Decide what the receipt says (§6.2.1). Returns the evidence the ledger must settle with, plus — when the outcome
   * cannot be proven — the ticket to open once the row is written.
   */
  async function decide({ effectId, kind, tries, evidence, request }) {
    const declaration = declarationOf(kind);
    if (!declaration) {
      const message = 'effect kind ' + JSON.stringify(kind) + ' has no capability declaration; it is never retried';
      return { evidence: ticketEvidence(kind, 'EFFECT_KIND_UNDECLARED', message, tries, evidence),
        ticket: { code: 'EFFECT_KIND_UNDECLARED', message } };
    }
    // A definite success, or a scheduling wait, is an answer already.
    if (evidence.executed === true || evidence.deferred === true) return { evidence, ticket: null };
    // Unsafe describes repeating possibly executed IO, not a refusal BEFORE IO.
    // Preserve that proof so closeEffect can cancel a released start/dispatch.
    if (evidence.notExecuted === true) return { evidence: { ...evidence, executionOutcome:'notExecuted',
      retryPolicy: tries < declaration.maxTries ? 'allowed' : 'exhausted' }, ticket: null };
    let state = evidence.notExecuted === true ? 'notExecuted' : 'unknown';
    if (declaration.readback) {
      const port = readbacks[declaration.readback];
      if (typeof port !== 'function') {
        const message = 'no ' + declaration.readback + ' readback is installed, so the outcome of this ' + kind +
          ' cannot be decided';
        return { evidence: ticketEvidence(kind, 'EFFECT_READBACK_MISSING', message, tries, evidence),
          ticket: { code: 'EFFECT_READBACK_MISSING', message } };
      }
      const read = await readBack(port, request, readbackTimeoutMs);
      if (read.executed === true) return { evidence: { executed: true, receipt: read.receipt ?? null,
        readback: declaration.readback, reason: 'decided by the ' + declaration.readback + ' readback' }, ticket: null };
      state = read.notExecuted === true ? 'notExecuted' : 'unknown';
      if(state==='notExecuted')return {evidence:{...read,notExecuted:true,executionOutcome:'notExecuted',
        retryPolicy:tries<declaration.maxTries?'allowed':'exhausted',readback:declaration.readback},ticket:null};
      if (state === 'unknown') {
        const message = 'the ' + declaration.readback + ' readback could not decide the outcome (' +
          (read.reason ?? read.code ?? 'no answer') + ')';
        return { evidence: ticketEvidence(kind, read.code ?? 'EFFECT_READBACK_UNCERTAIN', message, tries, evidence),
          ticket: { code: read.code ?? 'EFFECT_READBACK_UNCERTAIN', message } };
      }
    }
    // A definite "it did not happen" (and, for a safe kind, an unknown outcome) may be re-sent — within its own cap.
    if ((declaration.retry === 'safe' || (declaration.retry === 'not-executed' && state === 'notExecuted')) && tries < declaration.maxTries) {
      return { evidence: { [state]: true, executionOutcome:state, retryPolicy:'allowed',
        reason: 'retry permitted by ' + declaration.retry + ' (' + tries + '/' + declaration.maxTries + ')', attempts: tries,
        adapterEvidence: evidence }, ticket: null };
    }
    const message = declaration.retry === 'safe' || (declaration.retry === 'not-executed' && state === 'notExecuted')
      ? 'the safe retry cap of ' + declaration.maxTries + ' was reached without a definite outcome'
      : 'this kind is not safe to re-send, so an uncertain outcome is decided by root, not by another attempt';
    return { evidence: ticketEvidence(kind, 'EFFECT_RETRY_EXHAUSTED', message, tries, evidence),
      ticket: { code: 'EFFECT_RETRY_EXHAUSTED', message } };
  }

  /**
   * §6.2.4/§6.3: one decision per unproven effect, in its own transaction right after the row was written (a crash
   * between the two is repaired by sweep(), which is why the ticket is derived from the ledger and not from a callback
   * payload). The row carries what the adapter saw, so a verdict is read against evidence rather than a claim.
   */
  async function closeOut(input) {
    const result = await decide(input), evidence = result.evidence;
    const directive=evidence.code==='EFFECT_RETRY_EXHAUSTED'?{...evidence,retryPolicy:'exhausted'}:evidence;
    return { ...result, evidence: { ...evidence,...effectSettlementFields(directive,{tries:input.tries,
      maxTries:declarationOf(input.kind)?.maxTries??1}) } };
  }

  function openTicket({ effectId, kind, code, message, attempts, evidence }) {
    if (!access || typeof access.lifecycle !== 'function') return null;
    try {
      return access.lifecycle().mutate('decision-ticket:' + effectId, 'adapter', { effectId, code }, tx => {
        const subjectId = 'effect:' + effectId;
        const subject = tx.read(subjectId);
        if (!subject || subject.status !== 'unknown') return null;
        if (subject.adjudication) return null; // a verdict is already recorded and waits for its settlement
        const rows = tx.list('decision:').filter(row => row.kind === 'unknown-effect' && row.subject?.id === subjectId);
        // §6.2.4: only a row that can still be decided blocks the ticket. A row opened against an older revision of this
        // subject can never be decided (DECISION_STALE), so treating it as "already answered" leaves the effect unknown
        // with nothing anybody can do about it.
        if (rows.some(row => row.state === 'open' && row.subject?.revision === subject.revision)) return null;
        const at0 = now();
        // The supersession and the replacement are one transaction: a second sweep in the same pass sees exactly one
        // open row and opens nothing.
        for (const row of rows) {
          if (row.state === 'superseded') continue;
          tx.put(row.entityId, { ...row, state: 'superseded', supersededAt: at0,
            supersededReason: 'effect:' + effectId + ' moved to revision ' + subject.revision + '; this row can no longer ' +
              'be decided, so the effect was handed a new ticket' });
        }
        const evidenceId = 'effect-evidence:' + effectId;
        const at = now();
        tx.put(evidenceId, { effectId, kind, code, message, attempts, evidence: evidence ?? null, at, switch: 'on' });
        return openUnknownEffect(tx, { autonomy: 'on', now: at, decisionTtlMs: ttlMs }, {
          effectId, revision: subject.revision,
          evidence: [{ at, kind: 'effect', ref: evidenceId, text: message }],
          openedFor: 'member:root' });
      });
    } catch (error) {
      // The row is already unknown and durable; a ticket that could not open here is opened by the next sweep.
      audit({ stage: 'ticket', effectId, code: error?.code ?? 'ERROR' });
      return null;
    }
  }

  /** The crash repair: every unknown effect with no open decision and no recorded verdict gets its decision. */
  function sweep() {
    let opened = 0;
    for (const effect of store.effects()) {
      if (effect.status !== 'unknown') continue;
      const subject = store.read('effect:' + effect.id);
      if (!subject) continue;
      if (subject.adjudication) continue;
      // §6.2.4: only a verdict on the CURRENT revision blocks the repair. An expired or superseded row cannot be decided
      // any more, and the domain stays unknown while it exists -- so it is exactly the case the sweep has to re-open.
      const revivable = store.list('decision:').some(row => row.kind === 'unknown-effect' &&
        row.subject?.id === 'effect:' + effect.id && row.state === 'open' && row.subject?.revision === subject.revision);
      if (revivable) continue;
      const at = now();
      const evidenceId = 'effect-evidence:' + effect.id;
      if (!store.read(evidenceId)) {
        // The decision needs a readable evidence row; write one that names the ledger's own last evidence.
        const written = openTicketRow(effect, evidenceId, at);
        if (written) opened++;
        continue;
      }
      const written = openTicket({ effectId: effect.id, kind: effect.payload?.kind ?? null, code: 'EFFECT_RETRY_EXHAUSTED',
        message: 'the outcome of this effect was never proven', attempts: effect.tries ?? 0, evidence: effect.lastEvidence ?? null });
      if (written) opened++;
    }
    return opened;
  }

  function openTicketRow(effect, evidenceId, at) {
    try {
      access?.lifecycle().mutate(evidenceId, 'adapter', { effectId: effect.id }, tx => {
        if (tx.read(evidenceId)) return null;
        return tx.put(evidenceId, { effectId: effect.id, kind: effect.payload?.kind ?? null, code: 'EFFECT_RETRY_EXHAUSTED',
          message: 'the outcome of this effect was never proven', attempts: effect.tries ?? 0,
          evidence: effect.lastEvidence ?? null, at, switch: 'on' });
      });
      return true;
    } catch (error) { audit({ stage: 'sweep-evidence', effectId: effect.id, code: error?.code ?? 'ERROR' }); return false; }
  }

  /**
   * §6.2.4: `unknown --decision(root)--> confirmed | cancelled`. The verdict itself is written by the decision reducer
   * (it records the adjudication on this row); applying it to the ledger is this layer's transaction, and it is the one
   * transition the capability table cannot perform for itself — the outbox row is not writable from a domain reducer.
   */
  function applySettlements() {
    let applied = 0;
    for (const row of store.list('effect:')) {
      const adjudication = row.adjudication;
      if (!adjudication || typeof adjudication.decision !== 'string') continue;
      const effectId = row.effectId ?? String(row.entityId).slice('effect:'.length);
      const current = store.effects().find(item => item.id === effectId);
      if (!current || current.status !== 'unknown') continue;
      const status = adjudication.decision === 'effective' ? 'confirmed' : 'cancelled';
      const at = now();
      const payload = { effectId, decision: adjudication.decision, evidenceRef: adjudication.evidenceRef ?? null, status };
      try {
        store.effect({ entityId: 'effect:' + effectId, actor: 'adapter', payload, operationId: id('operation'),
          ...(typeof teamId === 'string' && teamId ? { teamId } : {}),
          expectedRevision: store.read('effect:' + effectId)?.revision ?? 0, payloadHash: digest(payload) }, effectId, effect => ({
          ...effect, status, nextDue: 0, nextReviewAt: null, responsible: 'operator',
          lastEvidence: { decided: adjudication.decision, evidenceRef: adjudication.evidenceRef ?? null,
            by: adjudication.actor ?? null, at } }));
        applied++;
      } catch (error) { audit({ stage: 'settlement', effectId, code: error?.code ?? 'ERROR' }); }
    }
    return applied;
  }

  return Object.freeze({ closeOut, openTicket, sweep, applySettlements,
    declaration: kind => declarationOf(kind), readbacks: Object.freeze({ ...readbacks }),
    kinds: () => DECLARED_EFFECT_KINDS.filter(kind => Object.hasOwn(declarations, kind)) });
}
