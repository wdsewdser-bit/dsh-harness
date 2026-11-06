import { failWith } from '../../contracts/index.mjs';
import { assertWritable, createCapability } from './capability.mjs';

const SCOPES = Object.freeze({ recovery: Object.freeze(['recovering']), hook: Object.freeze(['running']) });

/**
 * Normalise the per-scope write whitelist once, at construction: every scope must map to an array of non-empty
 * strings, and the result is an independent immutable snapshot. A string value would otherwise make includes() do
 * substring matching, and keeping the caller's array would let it widen permissions while the host runs.
 */
export function normaliseWriteKinds(writeKinds) {
  if (writeKinds === undefined || writeKinds === null) return new Map();
  if (typeof writeKinds !== 'object' || Array.isArray(writeKinds)) {
    failWith('INVALID_CONFIG', 'writeKinds must be an object mapping a scope to an array of kinds');
  }
  const snapshot = new Map();
  for (const [scope, kinds] of Object.entries(writeKinds)) {
    if (!Array.isArray(kinds)) failWith('INVALID_CONFIG', 'writeKinds.' + scope + ' must be an array of non-empty strings');
    const allowed = new Set();
    for (const kind of kinds) {
      if (typeof kind !== 'string' || !kind) failWith('INVALID_CONFIG', 'writeKinds.' + scope + ' must contain only non-empty strings');
      allowed.add(kind);
    }
    snapshot.set(scope, Object.freeze(allowed));
  }
  return snapshot;
}

/**
 * The host's write ports; docs/host-protocol.md §2.1 rule 3, invariant 9.
 *
 * One place decides whether a capability may write or dispatch: lifecycle token, current token identity, epoch, host
 * state, failed start, and - for every path - that the host still holds the team lock. Writes additionally need their
 * kind to be whitelisted for that scope, so a hook cannot submit a recovery write and recovery cannot submit a hook
 * event. The gateway is reached lazily: this object is built before the gateway exists.
 *
 * writeSink is the durable store port handed to capability writes. It is absent in M1a; capabilities then report
 * forwarded:false rather than pretending a write landed, and status().capabilities says so.
 */
export function createWritePorts({ teamId, dir, now, getGateway, writeSink, writeKinds, token, epoch, state, failure, ownership }) {
  const allowedKinds = writeKinds instanceof Map ? writeKinds : new Map();

  const assertEligible = (candidate, scope) => {
    assertWritable({
      token: candidate,
      current: token(),
      epoch: epoch(),
      state: state(),
      allowedStates: SCOPES[scope] ?? [],
      failure: failure(),
    });
    if (!ownership()) failWith('OWNERSHIP_LOST', 'the host no longer holds the team lock; ' + scope + ' writes are refused');
  };

  const writeThrough = (kind, payload, scope) => {
    const allowed = allowedKinds.get(scope);
    if (typeof kind !== 'string' || !kind || !allowed || !allowed.has(kind)) {
      failWith('WRITE_FORBIDDEN', 'scope ' + scope + ' may not write kind ' + JSON.stringify(kind ?? null));
    }
    if (typeof writeSink !== 'function') {
      return Object.freeze({ accepted: true, forwarded: false, kind, epoch: epoch(), at: now() });
    }
    const result = writeSink({ teamId, epoch: epoch(), scope, kind, payload });
    if (result && typeof result.then === 'function') failWith('INVALID_WRITE_PORT', 'writeSink must be synchronous');
    return Object.freeze({ accepted: true, forwarded: true, kind, epoch: epoch(), at: now(), result: result ?? null });
  };

  const capability = scope => createCapability({
    scope,
    token: token(),
    teamId,
    dir,
    epoch: epoch(),
    deps: {
      state,
      assertWritable: assertEligible,
      write: writeThrough,
      command: (request, candidateScope, candidateToken) => {
        assertEligible(candidateToken, candidateScope);
        return getGateway().command(request);
      },
    },
  });

  return {
    capability,
    assertEligible,
    /** Hooks fire only while the team runs; null means the invocation is a no-op. */
    hookCapability: () => (state() === 'running' && token() ? capability('hook') : null),
  };
}
