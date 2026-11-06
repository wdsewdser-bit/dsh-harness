import { fail, failWith } from '../contracts/index.mjs';
import { AUTONOMY_DEFAULTS } from '../contracts/index.mjs';

/**
 * P6 of the team-autonomy design (docs/decisions/team-autonomy-design.md §8.2.2/§8.2.3, appendix 6): usage accounting.
 *
 * One measured boundary writes one row. The row is the only thing the budget checks read, and it is written at the
 * request boundary by the adapter — never by a reducer that would be guessing, and never by the model.
 *
 * Two disciplines are structural here, not conventions:
 *
 *   dedup      every reading carries the event key it came from, and the durable inbox table (`tx.inbox`) refuses the
 *              second write of that key. A replay inside one process and a restart over the same store both count a
 *              measurement once (§8.3 重放).
 *   honesty    a reading that could not be taken is stored as `unknown: true` with its reason, never as zero (§8.3
 *              用量行写失败: "不伪造 0"). The unmeasured clock (`usage-unknown:<memberId>`) is what turns a lasting
 *              measurement gap into a decision; it never stops the team by itself (§12 U2).
 */

/** §8.2.3: the tunables this package reads, from the core configuration with the contract's own defaults behind them. */
export function budgetSettings(core) {
  const declared = core?.configuration?.budget;
  const fallback = AUTONOMY_DEFAULTS.budget;
  const grace = Number.isSafeInteger(declared?.unknownGraceMs) && declared.unknownGraceMs >= 0 ? declared.unknownGraceMs : fallback.unknownGraceMs;
  return Object.freeze({ unknownGraceMs: grace, unknownUsage: declared?.unknownUsage === 'stop' ? 'stop' : 'continue' });
}

/** §8.2.4: the price table is a display option; nothing in this module lets it reach a decision. */
export function pricingOf(core) {
  const pricing = core?.configuration?.pricing ?? null;
  if (!pricing) return null;
  return Object.freeze({ currency: String(pricing.currency), perInputToken: Number(pricing.perInputToken),
    perOutputToken: Number(pricing.perOutputToken) });
}

const unmeasuredId = memberId => 'usage-unknown:' + memberId;

/**
 * One measured boundary (or one unmeasurable boundary) for one member.
 *
 * The event key is the measurement's own identity — the session revision it was taken at, or an explicit key — so the
 * same boundary can be offered twice (a retried event, a restarted host) and still be counted once.
 */
export function recordUsage(core, { memberId, sessionId = null, attemptId = null, delegationRef = null, input = null,
  output = null, turns = 0, source = 'delta', approximate = false, unknown = false, reason = null, eventKey = null,
  revision = null, logRevision = null, totalInput = null, totalOutput = null, now = Date.now() } = {}) {
  if (typeof memberId !== 'string' || !memberId) fail('INVALID_USAGE');
  const key = typeof eventKey === 'string' && eventKey ? eventKey : sessionId + ':' + String(source) + ':' + String(now);
  const entityId = 'usage:' + memberId + ':' + key;
  return core.mutate(entityId, 'adapter', { memberId, key, source }, tx => {
    if (!tx.inbox('usage', memberId + ':' + key)) return { duplicate: true };
    // input/output are the increment this row adds; totalInput/totalOutput are the cumulative reading it was derived
    // from, which is what lets the next observation compute its own increment after a restart or a skipped tick.
    // §8.2.2: the MEASUREMENT revision (the session's log revision the reading was taken at) is stored in its own
    // field. `revision` is the row's own version, written by the store from the entity counter -- every boundary is a
    // new entity, so it is almost always 1 and can never say which reading came first.
    const row = { memberId, sessionId, attemptId, delegationRef, input, output, turns, source, approximate,
      revision, logRevision: Number.isSafeInteger(logRevision) ? logRevision : null,
      totalInput, totalOutput, unknown: unknown === true, reason, eventKey: key, measuredAt: now };
    const written = tx.put(entityId, row);
    const current = tx.read(unmeasuredId(memberId));
    if (row.unknown) {
      // The clock starts at the first unmeasured boundary and is not restarted by later ones: "how long has this
      // member been unmeasurable" is the question the grace period answers.
      if (!current || current.since === null || current.since === undefined) {
        tx.put(unmeasuredId(memberId), { memberId, since: now, lastAt: now, reason, sessions: [sessionId].filter(Boolean) });
      } else {
        tx.put(unmeasuredId(memberId), { ...current, lastAt: now, reason });
      }
    } else if (current && current.since !== null && current.since !== undefined) {
      // A real measurement ends the gap. The row stays (a durable record of the gap), with since cleared.
      tx.put(unmeasuredId(memberId), { ...current, since: null, clearedAt: now, lastAt: now });
    }
    return written;
  }).result;
}

/** The unmeasured clock of one member, or null when it is currently measured. */
export function unmeasuredOf(readable, memberId) {
  const row = readable.read(unmeasuredId(memberId));
  if (!row || row.since === null || row.since === undefined) return null;
  return row;
}

/**
 * §8.2.2: "委派用量 = 该委派成员名下全部 usage: 行之和" — the members of a delegation are the owners of its tasks,
 * which is how the sum survives a member that never had a usage row of its own.
 */
export function usageOf(readable, { memberId = null, delegationRef = null } = {}) {
  const members = new Set();
  if (typeof memberId === 'string' && memberId) members.add(memberId);
  const tasks = delegationRef ? readable.list('task:').filter(task => task.delegationRef === delegationRef) : [];
  for (const task of tasks) if (typeof task.owner === 'string') members.add(task.owner);
  const rows = readable.list('usage:').filter(row => members.has(row.memberId));
  const counted = rows.filter(row => row.unknown !== true);
  const sum = key => counted.reduce((total, row) => total + (Number.isFinite(row[key]) ? row[key] : 0), 0);
  const sources = new Set(counted.map(row => row.source));
  return Object.freeze({
    members: [...members].sort(),
    rows: rows.length,
    counted: counted.length,
    input: sum('input'),
    output: sum('output'),
    turns: sum('turns'),
    approximate: counted.some(row => row.approximate === true),
    // "unknown" answers one question: did the measurement of this subject fail? No row at all is not a failure — it is
    // simply a subject nobody has measured yet, and the unmeasured clock is the separate fact that reports gaps.
    unknown: rows.length > 0 && counted.length === 0,
    source: sources.size === 1 ? [...sources][0] : sources.size === 0 ? null : 'mixed',
  });
}

/**
 * §8.2.4: the display projection. This is the only reader of the price table, and the only place a cost exists at all:
 * without a table the projection carries no cost field, which is how the UI knows not to print a currency symbol.
 * Nothing here is imported by a reducer or by the admission gate.
 */
export function usageProjection(core, { pricing = null, memberId = null, delegationRef = null } = {}) {
  const usage = usageOf(core.store, { memberId, delegationRef });
  const declared = pricing ?? pricingOf(core);
  if (!declared) return usage;
  const amount = usage.input * declared.perInputToken + usage.output * declared.perOutputToken;
  return Object.freeze({ ...usage, cost: Object.freeze({ currency: declared.currency, amount }) });
}

/** §8.2.3: the closed refusal for an over-budget admission. Never thrown for a *running* turn. */
export const tokenBudgetRefusal = detail => failWith('DELEGATION_TOKEN_BUDGET', detail);
