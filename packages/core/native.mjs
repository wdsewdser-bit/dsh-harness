import { AUTONOMY_DEFAULTS, fail } from '../contracts/index.mjs';
import { openDecision } from './commands/decisions.mjs';
import { canCloseExecution, canFinishStoppedGeneration, stoppedTransitionMatches, closeStoppedGeneration, closeLegacyGeneration } from './commands/execution.mjs';

/**
 * §7 of the team-autonomy design (docs/decisions/team-autonomy-design.md §7.2.2-§7.2.5): a lifecycle stop is only
 * "stopped" when a stop proof says so.
 *
 * With the switch off this file behaves exactly as it always did. With it on, a cancel or dispose that cannot produce a
 * verified proof never reaches retired/frozen: the member goes unknown, keeps its attempts (releasing a lease before
 * the stop is proven would let two generations hold the same work, §2.2.4), records the proof row either way, and opens
 * the stuck-member decision that hands it to the operator (§12 U8).
 */

const bounded = (value, minimum, maximum, fallback) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;

/** The switch and the two stop budgets, read from the same defaults the contract publishes (§7.2.3). */
function stopSettings(core) {
  const configuration = core?.configuration ?? {};
  return {
    autonomy: configuration.autonomy === 'on',
    stopGraceMs: bounded(configuration.stopGraceMs, 0, 600000, AUTONOMY_DEFAULTS.stopGraceMs),
    stopProofTimeoutMs: bounded(configuration.stopProofTimeoutMs, 1, 600000, AUTONOMY_DEFAULTS.stopProofTimeoutMs),
    decisionTtlMs: bounded(configuration.decisionTtlMs, 60000, 86400000, AUTONOMY_DEFAULTS.decisionTtlMs),
  };
}

/**
 * §7.2.2: the process identity a port may return, in the one shape the prover accepts.
 *
 * A port that reports `{ pid, createdAt }` (or a `roots` array for a tree it started itself) is giving the host a
 * process to prove; a port that reports neither is telling the host the session has no OS process of its own, which is
 * exactly what this repository's adapter does today (docs/decisions/team-autonomy-design.md §11 item 5).
 */
export function nativeRootsOf(result) {
  const source = Array.isArray(result?.roots) ? result.roots : [];
  const roots = source.map(entry => ({ pid: entry?.pid, createdAt: entry?.createdAt === undefined || entry.createdAt === null ? null : String(entry.createdAt), image: entry?.image ?? null }))
    .filter(entry => Number.isSafeInteger(entry.pid) && entry.pid > 0 && entry.createdAt);
  if (!roots.length && Number.isSafeInteger(result?.pid) && result.pid > 0 && result.createdAt !== undefined && result.createdAt !== null) {
    roots.push({ pid: result.pid, createdAt: String(result.createdAt), image: result.image ?? null });
  }
  return roots;
}

/** The identity a member row recorded when its session was created or resumed (§7.2.2). */
function recordedRoots(member) {
  if (!Number.isSafeInteger(member?.nativePid) || !member.nativeStartedAt) return [];
  return [{ pid: member.nativePid, createdAt: String(member.nativeStartedAt), image: member.nativeImage ?? null }];
}

/**
 * Ask the platform layer for a proof. The prover is a port (`core.ports.stopProof`) because only the host owns the
 * operating system: this file never spawns anything (§10 "no await outside a transaction" is about reducers, but a
 * reducer reaching for taskkill would be a second platform implementation).
 *
 * Every way this can fail ends in a row with verified:false — capability missing, a throw, or a row the prover marked
 * unverified. None of them is ever turned into "stopped" (§7.2.3 rule 2).
 */
async function proveStop(core, settings, member, operation, result, failure = null) {
  const subject = { kind: 'member-session', id: member.entityId, fence: member.generation ?? 1 };
  const roots = nativeRootsOf(failure ? null : result);
  const effective = roots.length ? roots : recordedRoots(member);
  const at = Date.now();
  const missing = message => ({ kind: 'stop-proof', subject, method: 'session-dispose', roots: effective, reaped: [],
    descendantsAfter: null, polls: 0, emptySince: null, verified: false, confidence: 'low', at, tool: operation,
    error: { code: 'STOP_CAPABILITY_MISSING', message } });
  const prover = core.ports?.stopProof;
  if (typeof prover !== 'function') {
    return missing('no stop-proof port is installed, so the process tree of ' + member.entityId + ' cannot be read back');
  }
  let row;
  try {
    row = await prover({ subject, roots: effective, graceMs: settings.stopGraceMs,
      proofTimeoutMs: settings.stopProofTimeoutMs, operation });
  } catch (error) {
    return { ...missing(String(error?.message ?? error)),
      error: { code: error?.code ?? 'STOP_NOT_VERIFIED', message: String(error?.message ?? error) } };
  }
  if (!row || typeof row !== 'object') return missing('the stop-proof port returned no row');
  // The row's subject and provenance are the host's, never the prover's: a prover cannot say which subject it proved or
  // who wrote it, only what the platform showed.
  return { ...row, kind: 'stop-proof', subject, roots: Array.isArray(row.roots) && row.roots.length ? row.roots : effective,
    verified: row.verified === true, writtenBy: 'adapter', switch: 'on' };
}

/**
 * §7.2.5: a proof the lifecycle port already took.
 *
 * The production cancel/dispose port stops the turn itself and returns the row it read back, so asking the platform a
 * second time would terminate handles that are already gone (and, for a provider that reports the second terminate as a
 * failure, turn a real stop into an unproven one). The subject and the provenance are still this file's: a port cannot
 * say which subject it proved.
 */
function adoptPortProof(proof, subject) {
  const named = proof?.subject ?? null;
  const same = Boolean(named) && named.kind === subject.kind && named.id === subject.id && named.fence === subject.fence;
  return { ...proof, kind: 'stop-proof', subject, verified: same && proof.verified === true,
    writtenBy: 'adapter', switch: 'on' };
}

/** §7.2.1: the row is durable evidence, and an attempt number keeps a retry from overwriting the last one. */
function writeProofRow(tx, member, proof, at) {
  const subject = { kind: 'member-session', id: member.entityId, fence: member.generation ?? 1 };
  const id = 'stop-proof:' + member.entityId + ':' + subject.fence + ':' +
    (tx.list('stop-proof:' + member.entityId + ':' + subject.fence + ':').length + 1);
  return tx.put(id, { ...proof, kind: 'stop-proof', subject, writtenBy: 'adapter', switch: 'on', at });
}

/**
 * The unverified ending (§7.2.5): the member stays unknown with the operator responsible, the proof row is written,
 * and one stuck-member decision is opened in the same transaction (§12 U8: this is the one kind whose expiry escalates
 * to the operator, so the row is the escalation, not a note beside it).
 */
function recordUnprovenStop(tx, { settings, member, proof, operation, at }) {
  proof={...proof,verified:false,stopState:'unverified'};
  const written = writeProofRow(tx, member, proof, at);
  // The decision names the revision this transaction is about to write (there is exactly one write of the member row
  // below, so that is member.revision + 1). Opening it against the row as it is now would make the operator's verdict
  // DECISION_STALE the moment the row lands -- the same trap the completion decisions avoid by naming the written row.
  const decision = openDecision(tx, { autonomy: 'on', now: at, decisionTtlMs: settings.decisionTtlMs }, {
    kind: 'stuck-member',
    subject: { type: 'member', id: member.entityId, revision: member.revision + 1 },
    evidence: [{ at, kind: 'stop-proof', ref: written.entityId,
      text: 'a ' + operation + ' could not be proven stopped: ' + (proof.error?.code ?? 'STOP_NOT_VERIFIED') }],
    openedFor: 'operator',
    now: at,
    ttlMs: settings.decisionTtlMs,
    fallback: 'escalate',
  });
  return tx.put(member.entityId, { ...member, status: 'unknown', observed: 'unknown', responsible: 'operator',
    reason: proof.error?.message ?? 'the stop could not be proven', lastStopProof: written.entityId,
    stopDecision: decision.entityId });
}

/** Map durable lifecycle intents onto fake or native adapter ports; 08 §4.3. */
export async function applyLifecycle(core, memberId, operation, options = {}) {
  const member = core.store.read(memberId);
  if (!member || !['create', 'resume', 'cancel', 'dispose'].includes(operation)) fail('INVALID_LIFECYCLE');
  if (['create', 'resume'].includes(operation) && core.store.list('attempt:').some(a =>
    a.owner === memberId && ['active', 'unknown'].includes(a.lease))) fail('STOP_REQUIRED');
  const stopKind=operation==='cancel'?'cancel-member':operation,priorTransition=core.store.read('member-stop-transition:'+memberId+':'+(member.generation-1)+':'+stopKind);
  if(core.configuration.autonomy==='on' && ['cancel','dispose'].includes(operation) && priorTransition && stoppedTransitionMatches(core.store,priorTransition.proof,memberId,member.generation-1,stopKind))return {replayed:true,result:member};
  const previous = core.store.read('native-intent:' + memberId);
  if (previous && core.store.effects().some(effect => effect.id === previous.effectId &&
    ['pending', 'applying', 'unknown'].includes(effect.status))) fail('RECONCILIATION_REQUIRED');
  const intent = core.mutate('native-intent:' + memberId, 'root', { operation, options }, tx => {
    const effectId = 'native:' + memberId + ':' + ((tx.read('native-intent:' + memberId)?.revision ?? 0) + 1);
    tx.outbox(effectId, { kind: operation, memberId, generation: member.generation, options });
    tx.put(memberId, { ...member, desired: operation === 'dispose' ? 'retired' : operation === 'cancel' ? 'frozen' : 'active', status: operation + '-pending' });
    return tx.put('native-intent:' + memberId, { effectId, operation });
  }).result;
  const settings = stopSettings(core);
  const proving = settings.autonomy && ['cancel', 'dispose'].includes(operation);
  const claim = core.store.claim(core.command('claim:' + intent.effectId, 'adapter', {}), intent.effectId, 'adapter', Date.now()).result;
  let evidence;
  let result = null;
  let failure = null;
  try {
    result = await core.ports[operation]({ memberId, nativeRef: member.nativeRef ?? null, operationId: intent.effectId, ...options, generation:member.generation });
    if (['cancel', 'dispose'].includes(operation) && result.stopped !== true) fail('STOP_NOT_CONFIRMED');
  } catch (error) {
    failure = error;
  }
  // The proof is taken outside the transaction (it reads the operating system and waits out two budgets); the row it
  // returns is written inside the same transaction as the member transition it justifies.
  const proof = proving
    ? (result && typeof result === 'object' && result.stopProof && typeof result.stopProof === 'object'
      ? adoptPortProof(result.stopProof, { kind: 'member-session', id: member.entityId, fence: member.generation ?? 1 })
      : await proveStop(core, settings, member, operation, result, failure))
    : null;
  if (!failure) {
    evidence = { executed: true, result };
    try {
      core.mutate(memberId, 'adapter', evidence, (tx, current) => {
        if (current.generation !== member.generation) fail('STALE_NATIVE_GENERATION');
        const attempts = tx.list('attempt:').filter(a => a.owner === memberId && a.generation === current.generation && ['active','unknown'].includes(a.lease));
        if (proving && !canFinishStoppedGeneration(tx,proof,memberId,current.generation)) {
          return recordUnprovenStop(tx, { settings, member: current, proof:{...proof,verified:false,stopState:'unverified',
            error:proof.error??{code:'STOP_SCOPE_UNPROVEN',message:'certificate does not cover the current execution set'}}, operation, at: Date.now() });
        }
        const written = proving ? writeProofRow(tx, current, proof, Date.now()) : null;
        const stopped = ['cancel', 'dispose'].includes(operation);
        if (proving) closeStoppedGeneration(tx,memberId,current.generation,proof,written.entityId);
        else if (!settings.autonomy) closeLegacyGeneration(tx,memberId);
        else if(attempts.length)fail('EXECUTION_REQUIRES_CLOSEOUT');
        if(proving)tx.put('member-stop-transition:'+memberId+':'+current.generation+':'+stopKind,{proof:written,memberId,generation:current.generation,kind:stopKind});
        const roots = nativeRootsOf(result);
        return tx.put(memberId, { ...current, generation: current.generation + 1,
          nativeRef: result.nativeRef ?? current.nativeRef ?? null, observed: stopped ? 'stopped' : 'running',
          ...(roots.length ? { nativePid: roots[0].pid, nativeStartedAt: roots[0].createdAt, nativeImage: roots[0].image ?? null } : {}),
          ...(written ? { lastStopProof: written.entityId } : {}),
          status: operation === 'dispose' ? 'retired' : stopped ? 'frozen' : 'active' });
      });
    } catch (error) {
      // The generation moved between the port and the write: nothing to retire, and nothing to prove either.
      evidence = { reason: error.message };
      core.mutate(memberId, 'adapter', evidence, (tx, current) => {
        if (current.generation !== member.generation) return { stale: true };
        return tx.put(memberId, { ...current, status: 'unknown', reason: error.message, responsible: 'operator' });
      });
    }
  } else {
    evidence = { reason: failure.message };
    core.mutate(memberId, 'adapter', evidence, (tx, current) => {
      if (current.generation !== member.generation) return { stale: true };
      if (proving) return recordUnprovenStop(tx, { settings, member: current, proof, operation, at: Date.now() });
      return tx.put(memberId, { ...current, status: 'unknown', reason: failure.message, responsible: 'operator' });
    });
  }
  return core.store.settle(core.command('settle:' + intent.effectId, 'adapter', evidence), intent.effectId, claim.fence, evidence);
}
