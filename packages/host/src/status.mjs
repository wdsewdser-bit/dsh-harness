/**
 * status(); docs/host-protocol.md §2.5 plus the facts this skeleton can already report: ownership, a failed start,
 * listener and hook errors, managed in-flight counters, the receipt scope, the last cycle and the controlled
 * write-port routes.
 *
 * Capabilities stay exactly the pre-M1b shape on purpose: a status consumer (and the M1a tests) can rely on it, and
 * dispatch evidence is reported per path by the visibility layer (design §2.5), not folded into this object.
 */
export function buildStatus(state) {
  const { teamId, epoch, machineState, admission, failed, lastError, listenerErrors, inflight, recovery, ownership,
    hooks, hookErrors, capability, startedAt, stoppedAt, history, cycle = null, access = null } = state;
  return {
    teamId,
    epoch,
    state: machineState,
    admission,
    failed: failed ? { ...failed } : null,
    // Dispatch evidence is reported by the visibility layer itself (design §2.5): the object is passed through, and
    // the audit persistence counter is named here so a consumer reads it from a fixed place even if an observer
    // reports a different set of keys. Zero means "nothing was refused", not "no visibility layer".
    ...(state.visibility ? { visibility: { auditPersistFailed: 0, ...state.visibility } } : {}),
    lastCycle: cycle ? cycle.lastCycle : null,
    cycle: cycle ? {
      rounds: cycle.rounds,
      kicks: cycle.kicks,
      coalesced: cycle.coalesced,
      noProgressRounds: cycle.noProgressRounds,
      dirty: cycle.dirty,
      running: cycle.running,
      stopped: cycle.stopped,
      internalProgress: cycle.internalProgress,
      installed: cycle.installed,
    } : null,
    // Authoritative-evidence maintenance: absent when the host has no ControlStore to maintain.
    evidenceRetention: state.evidenceRetention ?? null,
    lastError,
    listenerErrors: listenerErrors.slice(),
    pendingEffects: cycle ? cycle.pendingEffects ?? 0 : 0,
    unknownEffects: cycle ? cycle.unknownEffects ?? 0 : 0,
    inflight: {
      active: inflight.open,
      capacity: cycle ? cycle.capacity ?? 0 : 0,
      saturated: Boolean(cycle && cycle.capacity && inflight.open >= cycle.capacity),
      opened: inflight.opened,
      completed: inflight.completed,
      withheld: inflight.opened - inflight.completed,
    },
    intents: { passed: 0, passedUnseen: 0, objected: 0, seenAll: 0, seenPartial: 0, seenNone: 0 },
    ownership,
    recovery,
    hooks: { mounted: hooks.mounted, inflight: hooks.inflight },
    hookErrors: hookErrors.slice(),
    capabilities: capability,
    access,
    startedAt,
    stoppedAt,
    history,
  };
}
