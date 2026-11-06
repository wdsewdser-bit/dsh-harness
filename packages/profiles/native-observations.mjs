import { autonomySettings, recordReadModel, recordUsage } from '../core/index.mjs';
import { sessionUsage } from '../adapter-dsh/index.mjs';
import { digest } from '../contracts/index.mjs';
import { GATE_RATIO } from '../context/index.mjs';

const minuteOf = now => Math.floor(now / 60000);

/**
 * The measurement revision of one stored usage row, read from its own field.
 *
 * `revision` is the row's version in the control store (one new entity per boundary, so almost always 1); the session's
 * log revision lives in `logRevision`. A row written before the two were separated recovers its measurement sequence
 * from the event key it was written with — 'session:<sessionId>:<logRevision>' — which is the same fact, spelled in the
 * key the dedup uses, and never the row version.
 */
function sourceRevisionOf(row) {
  if (Number.isSafeInteger(row?.logRevision)) return row.logRevision;
  const match = /:(\d+)$/.exec(String(row?.eventKey ?? ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * P6 §8.2.3: an unmeasurable boundary is recorded as unknown, never as zero. One row per minute, because the
 * observation tick is not a measurement boundary and a row per tick would grow without bound while saying the same
 * thing. The row is what the unmeasured clock reads: a lasting gap is what opens the budget-unknown decision (§12 U2),
 * and nothing here ever stops a turn.
 */
function markUnmeasured(core, memberId, session, now, reason) {
  try {
    recordUsage(core, { memberId, sessionId: session.id, unknown: true, reason, source: 'none',
      eventKey: 'unmeasured:' + session.id + ':' + minuteOf(now), now });
  } catch { /* accounting never fails an observation; the next tick repeats it */ }
}

/**
 * P6 §8.2.2 / §12 U2: one measured boundary of one session, written as an increment.
 *
 * sessionUsage reports what the session has spent so far, cumulatively; the ledger stores increments, because a
 * delegation's usage is the sum of its members' rows (§8.2.2) and an increment is the only form that stays correct
 * when an observation tick is skipped. The cumulative reading of the previous row is the baseline, and the dedup key
 * (session + log revision) is what keeps a replayed observation or a restarted host from counting the same boundary
 * twice - the increment would be zero anyway, but the row itself must not exist twice.
 *
 * Nothing in this function can fail an observation: a measurement that cannot be taken becomes an unknown row, and a
 * row that cannot be written becomes one on the next tick.
 */
function observeUsage(core, ctx, memberId, session, now) {
  let usage = null;
  try { usage = sessionUsage(ctx, session); } catch { usage = null; }
  if (!usage) { markUnmeasured(core, memberId, session, now, 'measure-unavailable'); return; }
  try {
    const rows = core.store.list('usage:').filter(row => row.memberId === memberId && row.sessionId === session.id && row.unknown !== true);
    // The baseline is the latest MEASUREMENT, never the latest row version (§8.2.2): the third boundary of a session
    // would otherwise be diffed against the first reading and count the middle twice.
    const prior = rows.reduce((best, row) => {
      const at = sourceRevisionOf(row);
      if (at === null) return best;
      return best === null || at > best.at ? { row, at } : best;
    }, null)?.row ?? null;
    const base = key => (Number.isFinite(prior?.[key]) ? prior[key] : 0);
    // A cumulative reading that went backwards (a compaction shrinking the estimate, or a switch from the measured
    // source to the estimated one) contributes no negative spend: the row records zero rather than crediting tokens.
    const input = Math.max(0, usage.input - base('totalInput'));
    const output = Math.max(0, usage.output - base('totalOutput'));
    if (input === 0 && output === 0) return;
    recordUsage(core, { memberId, sessionId: session.id, input, output, source: usage.source,
      approximate: usage.approximate, eventKey: 'session:' + session.id + ':' + String(usage.logRevision),
      revision: usage.logRevision, logRevision: usage.logRevision, totalInput: usage.input, totalOutput: usage.output, now });
  } catch { markUnmeasured(core, memberId, session, now, 'usage-write-failed'); }
}

/** Commit observational facts from native session projections, never authorize from them. */
export function observeNative(ctx, core, memberId, session) {
  const now = Date.now();
  // §8.2.2 / §10 P0: the measurement ledger belongs to the autonomy package. With the switch off this function writes
  // exactly what it wrote before P6 existed -- the goal and context read-model facts, and not one usage row, not one
  // journal event, not one cursor move -- which is what keeps a default team's observation identical to HEAD's.
  if (autonomySettings(core).autonomy === 'on') observeUsage(core, ctx, memberId, session, now);
  const events = session.snapshotEvents();
  const lastGoal = events.filter(e => e.type === 'goal/change' && e.data?.goal).at(-1);
  if (lastGoal) {
    const prior = core.store.read('read-model:goal:' + session.id);
    if (!prior || prior.sourceSeq < lastGoal.seq) recordReadModel(core, 'goal:' + session.id, { sessionId: session.id, sourceSeq: lastGoal.seq, goal: lastGoal.data.goal });
  }
  let state;
  // 0.2.2 deprecated the registry-wide lookup and publishes the same folded state through the owning service, which
  // reads its own projection handle. The registry call still exists but warns; the public method is the supported read
  // and it returns the same pressureTokens/contextWindow, so nothing below this line changes. The projection read stays
  // as the capability fallback for a meter that does not expose the method; no supported build lacks it since 0.2.2,
  // and the try/catch turns that case into "no context fact" rather than a guessed value. The service is injected by
  // team-plugin.mjs, because Cordis refuses an uninjected access and this read must not fail silently.
  try {
    state = typeof ctx.tokenMeter?.contextPressure === 'function'
      ? ctx.tokenMeter.contextPressure(session)
      : ctx.sessionProjections.stateOf(session, 'contextPressure');
  } catch { return; }
  const I = state?.pressureTokens, W = state?.contextWindow;
  const known = Number.isFinite(I) && I >= 0 && Number.isFinite(W) && W > 0;
  const facts = { owner: memberId, sessionId: session.id, status: known ? 'known' : 'unknown',
    source: { kind: 'native-contextPressure', logRevision: session.seq, semantics: 'last-committed-usage-and-window', pressureTokens: I ?? null, contextWindow: W ?? null },
    context: known ? { inputTokens: I, window: W, limitRatio: GATE_RATIO, limitTokens: W * GATE_RATIO, pct: I / (W * GATE_RATIO) * 100, logRevision: session.seq } : null };
  const key = 'context:' + memberId, previous = core.store.read('read-model:' + key);
  if (!previous || digest(Object.fromEntries(Object.keys(facts).map(k => [k, previous[k]]))) !== digest(facts)) recordReadModel(core, key, facts);
}
