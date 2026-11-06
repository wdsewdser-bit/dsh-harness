import { failWith } from '../../contracts/index.mjs';
import { RECOVERY_CONTRACT, sweepInterruptedClaims } from '../../core/index.mjs';

/**
 * The cold-start pass; design §3.5.1, §3.8, host-protocol invariant 7 rule 10.
 *
 * Fixed order: system.recover (recovery class) -> interrupted-claim sweep -> completion-token reconciliation -> the
 * Delivery readback for rows left applying -> report the deferred release-task rows -> conclude. The conclusion decides
 * admission and nothing else does: admission opens only when the recovery transaction committed, no journal read was
 * missing, and no completion token is left unresolved. An unresolved attempt (lease unknown) is reported but never
 * closes admission for the rest of the team (invariant 5 rule 1, F24).
 *
 * The field contract of the recovery transaction lives in core/commands/recovery.mjs (RECOVERY_CONTRACT), and the
 * command enforces it through createRecoveryScope. RECOVERY_GRANTS is that same table derived for the host's restricted
 * recovery route: one source, two consumers, so the route's whitelist cannot drift from what the command writes
 * (review finding 5).
 */
const grantKey = kind => kind === 'runtime' ? 'runtime' : kind + '*';

export const RECOVERY_GRANTS = Object.freeze({
  entities: Object.freeze(Object.keys(RECOVERY_CONTRACT.entityKinds).map(grantKey)),
  fields: Object.freeze(Object.fromEntries(Object.entries(RECOVERY_CONTRACT.entityKinds)
    .map(([kind, fields]) => [grantKey(kind), fields]))),
  outboxKinds: RECOVERY_CONTRACT.outboxKinds,
});

export const DEFAULT_SAFETY_BUDGET_MS = 60000;

export function createRecovery({ core = null, access = null, allowDirectCore = false, goal = null, delivery = null,
  now = Date.now, safetyBudgetMs = DEFAULT_SAFETY_BUDGET_MS } = {}) {
  if (!core || typeof core.dispatch !== 'function') failWith('INVALID_CONFIG', 'recovery needs the team core it converges');
  // Finding 3: a write port that exists but has no recovery route is a configuration defect, not a licence to fall
  // back to writing straight through the core; and that fallback is itself a declaration the caller must make.
  if (access !== null && typeof access?.recovery !== 'function') {
    failWith('INVALID_CONFIG', 'the recovery write port must expose recovery(grants); pass access: null only with allowDirectCore: true');
  }
  if (access === null && allowDirectCore !== true) {
    failWith('INVALID_CONFIG', 'recovery without a host write port must be declared with allowDirectCore: true');
  }
  if (typeof now !== 'function') failWith('INVALID_CONFIG', 'recovery needs a now() function');
  if (!Number.isFinite(safetyBudgetMs) || safetyBudgetMs < 0) failWith('INVALID_CONFIG', 'the safety budget must be a non-negative finite number of milliseconds');
  let last = null;
  let cancellations = Object.freeze([]);

  const unresolvedTokens = () => core.store.list('completion:').filter(t => ['prepared', 'authorized', 'unknown'].includes(t.status));
  const deferredEffects = () => core.store.effects().filter(e => e.payload?.kind === 'release-task').map(e => e.id);

  /**
   * The transition itself. The recovery route keeps the recovering window and the ownership check; the command type is
   * what crosses the completion fence and is fixed here, so no caller can choose it (design §3.5).
   */
  const recoverTransaction = () => {
    if (access === null) return core.dispatch('runtime', 'scheduler', { recovery: true }, { type: 'system.recover', payload: {} });
    const route = access.recovery(RECOVERY_GRANTS);
    if (!route || typeof route.recover !== 'function') failWith('INVALID_CONFIG', 'the recovery route must expose recover()');
    return route.recover();
  };

  /** A step that threw proved nothing: record it and let the conclusion say so (review finding 2). */
  const stepFailure = error => Object.freeze({ status: 'unknown', failed: true, code: error?.code ?? 'ERROR',
    message: error?.message ?? String(error) });

  /** The cancels this recovery minted, with the new fence that makes the old holder's authority useless. */
  const discoverCancellations = () => core.store.effects()
    .filter(effect => typeof effect.id === 'string' && effect.id.startsWith('recover-cancel:') && effect.payload?.kind === 'cancel')
    .map(effect => {
      const attempt = core.store.read(effect.payload.attemptId);
      return Object.freeze({ attemptId: effect.payload.attemptId, effectId: effect.id,
        owner: effect.payload.owner ?? attempt?.owner ?? null, fence: attempt?.fence ?? effect.payload.fence ?? null,
        status: effect.status });
    });

  const conclude = ({ at, status, capability, reason = null, steps }) => {
    const conclusion = Object.freeze({
      status,
      admission: status === 'ok' && unresolvedTokens().length === 0,
      capability,
      reason,
      at,
      steps: Object.freeze({ ...steps }),
      cancellations,
      tokens: Object.freeze({ unresolved: Object.freeze(unresolvedTokens().map(token => token.entityId)) }),
      deferred: Object.freeze({ releaseTask: Object.freeze(deferredEffects()) }),
    });
    last = conclusion;
    return conclusion;
  };

  /**
   * One cold start. It never throws: a defect in any step downgrades the conclusion to unknown and keeps admission
   * closed, because host.start() must still finish and expose a readable status (review finding 2).
   */
  async function recover(context = {}) {
    const { capability = null, signal = null } = context ?? {};
    if (capability && capability.scope !== 'recovery') {
      failWith('INVALID_CONFIG', 'the recoverer is handed a recovery-scope capability, got ' + String(capability.scope));
    }
    const at = now();
    try {
      return await pass({ at, signal });
    } catch (error) {
      return conclude({ at, status: 'unknown', capability: error?.code ?? 'ERROR', reason: error?.message ?? String(error), steps: {} });
    }
  }

  /** The fixed order; every step that can fail is recorded as a step, never as an escape. */
  async function pass({ at, signal }) {
    const steps = {};
    let receipt;
    try {
      receipt = recoverTransaction();
      steps.recover = Object.freeze({ status: 'confirmed', at, wrote: receipt?.writes?.length ?? null });
    } catch (error) {
      steps.recover = stepFailure(error);
      return conclude({ at, status: 'unknown', capability: error?.code ?? 'ERROR', reason: error?.message ?? String(error), steps });
    }
    try {
      steps.sweep = Object.freeze({ swept: sweepInterruptedClaims(core) ?? null });
    } catch (error) {
      steps.sweep = stepFailure(error);
    }
    try {
      cancellations = Object.freeze(discoverCancellations());
    } catch (error) {
      steps.cancellations = stepFailure(error);
    }
    const tokens = unresolvedTokens();
    if (goal && typeof goal.reconcileAll === 'function') {
      try {
        steps.goal = await goal.reconcileAll({ signal });
      } catch (error) {
        steps.goal = stepFailure(error);
      }
    } else {
      steps.goal = Object.freeze({ status: tokens.length ? 'unknown' : 'ok', capability: tokens.length ? 'session-log-unavailable' : null,
        reason: tokens.length ? 'no goal reconciliation is installed' : null, sessions: Object.freeze([]), at });
    }
    if (delivery && typeof delivery.reconcileApplying === 'function') {
      try {
        steps.delivery = await delivery.reconcileApplying({ signal });
      } catch (error) {
        steps.delivery = stepFailure(error);
      }
    }
    if (signal?.aborted || steps.goal?.capability === 'recovery-aborted') {
      return conclude({ at, status: 'unknown', capability: 'recovery-aborted', reason: 'stop() cancelled the recovery pass', steps });
    }
    // A step that threw proved nothing, so the pass cannot conclude ok however green the rest looks.
    const broken = ['recover', 'sweep', 'cancellations', 'goal', 'delivery'].find(name => {
      const step = steps[name];
      return step?.failed === true || (Array.isArray(step?.failed) && step.failed.length > 0) ||
        (Array.isArray(step?.errors) && step.errors.length > 0) || step?.status === 'unknown';
    }) ?? null;
    const goalOk = steps.goal?.status === 'ok';
    const status = goalOk && broken === null ? 'ok' : 'unknown';
    return conclude({
      at,
      status,
      capability: status === 'ok' ? null : (broken ? (steps[broken].code ?? steps[broken].errors?.[0]?.code ?? steps[broken].failed?.[0]?.code ?? steps[broken].capability ?? 'RECOVERY_STEP_FAILED') : steps.goal.capability ?? 'session-log-unavailable'),
      reason: status === 'ok' ? null : (broken ? (steps[broken].message ?? steps[broken].reason ?? ('recovery step failed: ' + broken)) : steps.goal.reason ?? null),
      steps,
    });
  }

  /**
   * The safety capabilities this recovery owes: one per new cancel, causally bound to its attempt and expiring with
   * the drain budget (design §3.5: stop 之后不再新铸；已铸造的只在预算内收口它的 subject). Minting is explicit
   * because installing the pump is the composition root's job (F).
   */
  function safetyCapabilities() {
    if (!access || typeof access.safety !== 'function') return Object.freeze([]);
    const expiresAt = now() + safetyBudgetMs;
    return Object.freeze(cancellations.map(item => access.safety({
      cause: 'recovery',
      subject: { attemptId: item.attemptId, effectId: item.effectId },
      commands: ['claim', 'register', 'settle'],
      fields: {
        [item.attemptId]: ['lease', 'status', 'reason', 'lastEvidence', 'nextReviewAt', 'responsible', 'evidenceRef'],
        [item.effectId]: ['status', 'reason', 'lastEvidence', 'nextReviewAt'],
      },
      outboxKinds: [],
      expiresAt,
    })));
  }

  return Object.freeze({ recover, safetyCapabilities, status: () => ({ last, cancellations, safetyBudgetMs }) });
}
