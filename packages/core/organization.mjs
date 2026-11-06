import { fail, failWith } from '../contracts/index.mjs';
import { normalizeScope } from './scopes.mjs';
import { autonomyOn } from './authority.mjs';

/**
 * P6 §8.2.1: the budget a delegation may carry, and the one shape refusal.
 *
 * With the switch off this function is HEAD's: tasks and concurrency are positive integers and `cost` is a finite
 * non-negative number, stored exactly as the caller wrote it. With the switch on the budget is the three units the
 * product actually enforces — tasks, concurrency, tokens — and `cost` is refused by name: an amount without a unit was
 * never a limit here, and accepting one again would silently resurrect the per-task spend it used to drive (§8.1).
 *
 * Old rows are never rewritten: a delegation stored with `cost` stays readable, and every reader tolerates a missing
 * `tokens` (§8.2.1 存量行兼容).
 */
const BUDGET_KEYS = Object.freeze(['tasks', 'concurrency', 'tokens']);
const TOKEN_KEYS = Object.freeze(['inputLimit', 'outputLimit']);

/** The design writes `{ limit }`; the stored form is the number, which is what every reader already reads. */
function limitOf(value, what) {
  const limit = value !== null && typeof value === 'object' ? value.limit : value;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    failWith('INVALID_DELEGATION', what + ' must be a positive integer limit, got ' + JSON.stringify(value ?? null));
  }
  return limit;
}

function tokenLimitOf(value, what) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    failWith('INVALID_DELEGATION', what + ' must be a non-negative integer or null, got ' + JSON.stringify(value));
  }
  return value;
}

function declaredBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) fail('INVALID_DELEGATION');
  const unknown = Object.keys(budget).filter(key => !BUDGET_KEYS.includes(key));
  if (unknown.length > 0) {
    failWith('INVALID_BUDGET_FIELD', 'a delegation budget is tasks, concurrency and tokens; ' +
      unknown.map(key => JSON.stringify(key)).join(', ') + ' is not a unit this product enforces' +
      (unknown.includes('cost') ? ' (an amount with no unit never limited anything, §8.2.1)' : ''));
  }
  if (!('tasks' in budget) || !('concurrency' in budget)) fail('INVALID_DELEGATION');
  const tokens = budget.tokens ?? null;
  if (tokens !== null) {
    if (typeof tokens !== 'object' || Array.isArray(tokens)) failWith('INVALID_DELEGATION', 'budget.tokens must be an object');
    const extra = Object.keys(tokens).filter(key => !TOKEN_KEYS.includes(key));
    if (extra.length > 0) failWith('INVALID_BUDGET_FIELD', 'budget.tokens does not define ' + extra.map(key => JSON.stringify(key)).join(', '));
  }
  return { tasks: limitOf(budget.tasks, 'budget.tasks'), concurrency: limitOf(budget.concurrency, 'budget.concurrency'),
    tokens: tokens === null ? null : { inputLimit: tokenLimitOf(tokens.inputLimit, 'budget.tokens.inputLimit'),
      outputLimit: tokenLimitOf(tokens.outputLimit, 'budget.tokens.outputLimit') } };
}

/** Store bounded delegation as explicit root authority; 08 §4.3. */
export function delegate(core, delegationId, owner, approvedScope, budget, expiresAt) {
  return core.mutate(delegationId, 'root', { owner, approvedScope, budget, expiresAt }, tx => {
    const expires = Date.parse(expiresAt);
    if (tx.read(owner)?.role !== 'subCoordinator' || !Number.isFinite(expires) || expires <= Date.now()) {
      fail('INVALID_DELEGATION');
    }
    if (!autonomyOn(core)) {
      // §8.1/§8.2.1: off is HEAD, field for field — including the unti-less cost this package is about to remove.
      if (budget?.tasks < 1 || budget?.concurrency < 1 || !Number.isSafeInteger(budget?.tasks) ||
        !Number.isSafeInteger(budget?.concurrency) || !Number.isFinite(budget?.cost) || budget?.cost < 0) fail('INVALID_DELEGATION');
      return tx.put(delegationId, { owner, approvedScope: approvedScope.map(normalizeScope), budget, expiresAt, riskClass: 'bounded' });
    }
    const normalized = declaredBudget(budget);
    return tx.put(delegationId, { owner, approvedScope: approvedScope.map(normalizeScope), budget: normalized, expiresAt, riskClass: 'bounded' });
  });
}

/** Request lifecycle changes without claiming native stop or start; 08 §4.3. */
export function lifecycle(core, memberId, desired, reason) {
  return core.mutate(memberId, 'root', { desired, reason }, (tx, member) => {
    if (!member || !['frozen', 'active', 'retired'].includes(desired)) fail('INVALID_MEMBER_TRANSITION');
    const status = desired === 'frozen' ? 'freezing' : desired === 'retired' ? 'retiring' : 'resuming';
    const result = tx.put(memberId, { ...member, desired, status, reason });
    tx.outbox(memberId + ':' + result.revision, { kind: 'member-lifecycle', memberId, generation: member.generation, desired });
    return result;
  });
}

/** Observe native bindings by generation, archive stale observations; 08 §2.1, §4.3. */
export function observeMember(core, memberId, generation, eventId, observation) {
  return core.mutate(memberId, 'adapter', { generation, eventId, observation }, (tx, member) => {
    if (!tx.inbox('native-member', eventId)) return { duplicate: true };
    if (member.generation !== generation) return tx.put('stale-observation:' + eventId, { memberId, generation, observation });
    return tx.put(memberId, { ...member, observed: observation.status, nativeRef: observation.nativeRef ?? member.nativeRef ?? null,
      status: observation.status === 'stopped' && member.desired === 'frozen' ? 'frozen' : member.status ?? 'active' });
  });
}
