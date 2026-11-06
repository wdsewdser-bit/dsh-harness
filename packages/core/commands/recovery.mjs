import { isDeepStrictEqual } from 'node:util';
import { fail, failWith } from '../../contracts/index.mjs';

/**
 * system.recover: the one cold-start transition that converges what a previous host left open; design §3.5.1.
 *
 * The field contract IS this reducer. It writes, and only writes:
 *
 *   attempt:<id> (lease active only)   lease/status -> unknown, fence -> old + 1, responsible, reason,
 *                                      lastEvidence -> null, nextReviewAt
 *   outbox                             one new recover-cancel:<attemptId>:<new fence> row (kind 'cancel')
 *   task:<attempt.taskId>              lastFence -> the new fence, and nothing else
 *   member-intent:<id> (applying)      status -> unknown, reason, responsible, nextReviewAt
 *   runtime                            { recovered: true }
 *
 * It never writes task.status/owner/contractRevision/assignmentEpoch/scopeSet, never writes an attempt's
 * owner/taskId/generation/scopeSet/admittedAt and never touches a publishable row. Because the whole row is written,
 * the same function serves the ordinary TeamCore path (where tx.put replaces the row) and the host's restricted
 * recovery transaction (where tx.put patches it and compares every changed key with the whitelist).
 */
export const RECOVERY_REVIEW_MS = 60000;

/**
 * The same contract as data (review finding 5): the entity kinds and the only fields each one may change, plus the
 * only effect kind recovery may mint. recoverFacts writes through createRecoveryScope, so this table is enforced rather
 * than described - on the ordinary dispatch path and on the host's restricted route alike, because both run the one
 * reducer.
 */
export const RECOVERY_CONTRACT = Object.freeze({
  entityKinds: Object.freeze({
    'attempt:': Object.freeze(['lease', 'status', 'fence', 'responsible', 'reason', 'lastEvidence', 'nextReviewAt']),
    'task:': Object.freeze(['lastFence']),
    'member-intent:': Object.freeze(['status', 'reason', 'responsible', 'nextReviewAt']),
    runtime: Object.freeze(['recovered']),
  }),
  outboxPrefix: 'recover-cancel:',
  outboxKinds: Object.freeze(['cancel']),
  outboxFields: Object.freeze(['kind', 'attemptId', 'owner', 'fence']),
});

export const RECOVERY_GRANT_VIOLATION = 'RECOVERY_GRANT_VIOLATION';

const kindOf = entityId => {
  if (typeof entityId !== 'string') return null;
  return Object.keys(RECOVERY_CONTRACT.entityKinds)
    .find(kind => (kind === 'runtime' ? entityId === 'runtime' : entityId.startsWith(kind))) ?? null;
};

/** The fields a write would change, compared value by value: a whole-row put may only move whitelisted keys. */
const changedFields = (before, after) => {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter(key => !isDeepStrictEqual(before?.[key], after?.[key]));
};

/**
 * One transaction bound to the recovery contract. A put of an entity outside the contract, a change to a field outside
 * the whitelist, or an effect that is not a recover-cancel is refused before it reaches the store; what was written is
 * reported, so a caller can assert the contract held without parsing rows afterwards.
 */
export function createRecoveryScope(tx) {
  if (!tx || typeof tx.put !== 'function' || typeof tx.outbox !== 'function') fail('INVALID_CONFIG');
  const writes = [];
  const read = id => typeof tx.read === 'function' ? tx.read(id) : null;
  return Object.freeze({
    read,
    list: prefix => tx.list(prefix),
    put(entityId, row) {
      const kind = kindOf(entityId);
      const allowed = kind ? RECOVERY_CONTRACT.entityKinds[kind] : null;
      if (!allowed) failWith(RECOVERY_GRANT_VIOLATION, String(entityId) + ' is outside the recovery contract');
      const changed = changedFields(read(entityId), row);
      const outside = changed.filter(field => !allowed.includes(field));
      if (outside.length) failWith(RECOVERY_GRANT_VIOLATION, entityId + ' would change ' + outside.join(', '));
      writes.push(Object.freeze({ entityId, fields: Object.freeze(changed) }));
      return tx.put(entityId, row);
    },
    outbox(effectId, payload) {
      if (typeof effectId !== 'string' || !effectId.startsWith(RECOVERY_CONTRACT.outboxPrefix) ||
        !RECOVERY_CONTRACT.outboxKinds.includes(payload?.kind)) {
        failWith(RECOVERY_GRANT_VIOLATION, 'recovery may only mint ' + RECOVERY_CONTRACT.outboxPrefix + '* effects of kind ' + RECOVERY_CONTRACT.outboxKinds.join('/'));
      }
      const extra = Object.keys(payload).filter(key => !RECOVERY_CONTRACT.outboxFields.includes(key));
      if (extra.length) failWith(RECOVERY_GRANT_VIOLATION, 'a recovery cancel carries only ' + RECOVERY_CONTRACT.outboxFields.join('/') + ', got ' + extra.join(', '));
      writes.push(Object.freeze({ entityId: effectId, fields: Object.freeze(Object.keys(payload).sort()) }));
      return tx.outbox(effectId, payload);
    },
    writes: () => Object.freeze([...writes]),
  });
}

export function recoverFacts(tx, now = 0) {
  const at = Number.isFinite(now) ? now : 0;
  const scope = createRecoveryScope(tx);
  const cancellations = [];
  for (const attempt of scope.list('attempt:')) {
    if (attempt.lease !== 'active') continue;
    const fence = (attempt.fence ?? 0) + 1;
    scope.put(attempt.entityId, { ...attempt, lease: 'unknown', status: 'unknown', fence,
      responsible: 'operator', reason: 'restart requires native stop evidence', lastEvidence: null,
      nextReviewAt: at + RECOVERY_REVIEW_MS });
    cancellations.push(Object.freeze({ attemptId: attempt.entityId, effectId: 'recover-cancel:' + attempt.entityId + ':' + fence,
      owner: attempt.owner ?? null, fence }));
    scope.outbox('recover-cancel:' + attempt.entityId + ':' + fence,
      { kind: 'cancel', attemptId: attempt.entityId, owner: attempt.owner });
    const task = scope.read(attempt.taskId);
    if (task) scope.put(task.entityId, { ...task, lastFence: fence });
  }
  const interrupted = [];
  for (const intent of scope.list('member-intent:')) {
    if (intent.status !== 'applying') continue;
    scope.put(intent.entityId, { ...intent, status: 'unknown', reason: 'interrupted lifecycle',
      responsible: 'operator', nextReviewAt: at + RECOVERY_REVIEW_MS });
    interrupted.push(intent.entityId);
  }
  // Merged, not replaced: the store owns the row's metadata (entityId, revision, timestamps) and the contract only
  // lets this command move the one field it owns.
  scope.put('runtime', { ...(scope.read('runtime') ?? {}), recovered: true });
  return Object.freeze({ recovered: true, at, cancellations: Object.freeze(cancellations),
    interrupted: Object.freeze(interrupted), writes: scope.writes() });
}

/**
 * The command class is fixed here, not by the caller: only the scheduler converges an interrupted lifecycle, and only
 * with this one command type. The host never gets a generic "write through the completion fence" entry.
 */
export function systemRecover(tx, command) {
  if (command.actor !== 'scheduler') fail('DENIED');
  return recoverFacts(tx, command.now ?? command.payload?.now);
}

export const recoveryCommands = Object.freeze({ 'system.recover': systemRecover });
