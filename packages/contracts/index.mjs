export { effectSettlementFields, hasEffectSettlementFields } from './effect-outcome.mjs';
export { EXECUTION_STATES, EXECUTION_ID_FIELDS, sameExecution, executionIdentity, executionScopeId, scopeCertificateMatches } from './execution.mjs';
export { DispatchEvidenceLedger, assertDispatchEvent, dispatchDigest, classifyAccepted, summariseDispatchMessages } from './dispatch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { autonomyCodeList } from './autonomy.mjs';
import { superagentBorrowCodes } from './superagent-borrow.mjs';

export const schemaVersion = 1;

// The dispatch-phase contract (design §1.4.2, §2.2): the host half of the 'team-dispatch/2' event, its canonical
// digest and the evidence ledger. The upstream patch carries its own copy of the digest; the A-pack probe compares them.
export * from './dispatch.mjs';

// P0 of team-autonomy (§10): the switch, its validated defaults and its refusal codes. Re-exported here so a caller
// keeps one contract entry point, exactly as the dispatch and deadline contracts are reached.
export * from './autonomy.mjs';

// P0 of the super-agent borrow design (§10): the protocol switch, the team-policy row, the migration preconditions and
// the tool-capability/root-policy contract. Re-exported here for the same reason: one contract entry point, so a later
// package cannot reach for a second copy of the same refusal or of the same policy table.
export * from './superagent-borrow.mjs';
export { canonical, digest, validateDependency } from './team.mjs';
// The deadline contract (07 §4.3): the tool argument deadline is validated once, here, and every tool entry reads the
// same rule instead of reaching for the module (check-deps rule b).
export { deadlineDescription, deadlineSchema, normalizeDeadline, normalizeToolDeadlines } from './deadline.mjs';

/** Create a versioned stable identifier; 08 §2.2. */
export const id = kind => 'v1:' + kind + ':' + randomUUID();

/** Hash evidence or command payload bytes with SHA-256; 08 §2.2–3.3. */
export const hash = payload => createHash('sha256').update(payload).digest('hex');

/** Accept any unique, readable operation identity; idempotency needs uniqueness, not hex; 08 §2.2. */
export const operationIdPattern = /^v1:operation:[A-Za-z0-9._-]{8,128}$/;
export const operationIdSource = operationIdPattern.source;

export const codes = [
  'UNKNOWN_BUDGET',
  'BLOCKED_BUDGET',
  'CAS_CONFLICT',
  'ID_CONFLICT',
  'denied',
  'expired',
  'corrupt',
  // The autonomy packages' refusals, appended from the one table that defines them (§10 P0). Nothing raises these
  // yet; publishing the names first is what keeps a later package from inventing a second spelling of the same refusal.
  ...autonomyCodeList,
  // The borrow protocol's refusals (§10 P0). Protocol/policy checks already raise them; publishing the full table keeps a
  // later package from inventing a second spelling of the same refusal, and no code below repeats an autonomy code.
  ...Object.values(superagentBorrowCodes()).flat(),
];

/** Raise a machine-readable contract failure; 08 §2.2. */
export function fail(code) {
  throw Object.assign(Error(code), { code });
}

/** Raise a machine-readable failure whose message also tells the caller what to fix. */
export function failWith(code, detail) {
  throw Object.assign(Error(detail ? code + ': ' + detail : code), { code, detail });
}

/**
 * Validate the team collaboration switch that gates the three proactive-collaboration mechanisms.
 *
 * It is a separate frozen object for one reason: `config()` below is the certified P2 context configuration, and
 * its UNCERTIFIED_CONFIG branch is what proves the default profile still loads the exact upstream behaviour. Folding
 * a new switch into that object would make every "behaviour is unchanged" assertion depend on a field that has
 * nothing to do with the context budget. Schema: packages/contracts/team-collab.schema.json.
 */
export function collabConfig(overrides = {}) {
  const allowed = ['collab', 'decisionLimit', 'assumptionDeadline'];
  if (Object.keys(overrides).some(key => !allowed.includes(key))) fail('INVALID_CONFIG');
  const value = { collab: 'off', decisionLimit: 5, assumptionDeadline: 'PT10M', ...overrides };
  if (!['off', 'on'].includes(value.collab)) fail('INVALID_CONFIG');
  if (!Number.isSafeInteger(value.decisionLimit) || value.decisionLimit < 0 || value.decisionLimit > 20) {
    fail('INVALID_CONFIG');
  }
  if (typeof value.assumptionDeadline !== 'string' || !value.assumptionDeadline.length) fail('INVALID_CONFIG');
  return Object.freeze(value);
}

/**
 * The context hard limit: the pre-request gate refuses once the estimated input ALONE reaches this share of the
 * window (M3a §1.2), and every projection renders it as `limitRatio`. It is defined here, at the bottom of the
 * dependency graph, so the context rule and the read-only projections read one number instead of two copies; the
 * browser bundle (packages/ui, which may not import a package) keeps the display copy and a test pins them equal.
 */
export const GATE_RATIO = 0.75;

/** Validate and freeze the offline context configuration; 08 §1.3, §3.2–3.4. */
export function config(overrides = {}) {
  const allowed = ['schemaVersion', 'profile', 'W', 'R', 'M', 'truncateChars', 'fold'];
  if (Object.keys(overrides).some(key => !allowed.includes(key))) {
    fail('INVALID_CONFIG');
  }

  const configuration = {
    schemaVersion: 1,
    profile: 'default',
    R: 4096,
    M: 4096,
    truncateChars: 8192,
    fold: false,
    ...overrides,
  };
  for (const key of ['W', 'R', 'M', 'truncateChars']) {
    if (!Number.isSafeInteger(configuration[key]) || configuration[key] <= 0) {
      fail('UNKNOWN_BUDGET');
    }
  }
  if (
    configuration.schemaVersion !== 1 ||
    configuration.profile !== 'default' ||
    configuration.fold !== false
  ) {
    fail('UNCERTIFIED_CONFIG');
  }
  return Object.freeze(configuration);
}


/**
 * Canonicalize every lease, delegation and tool path using existing ancestors; 08 §4.7.
 *
 * It lives at the bottom of the dependency graph (contracts) because both core and the host's tool guard resolve
 * targets: one implementation, reached through the package entry, instead of the guard deep-importing core/scopes.mjs.
 */
export function normalizeScope(target) {
  if (!path.isAbsolute(target) || target.includes('\0')) fail('INVALID_PATH');
  let ancestor = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('MISSING_ANCESTOR');
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync.native(ancestor), ...suffix).replaceAll('\\', '/').toLowerCase();
}

/**
 * P4 of the team-autonomy design (§6.2, appendix 5): the effect capability table.
 *
 * Every effect kind says which of the three answers applies when its outcome is not a plain success:
 *
 *   readback       the host can ask the outside world what happened, and that answer decides the row;
 *   retry: 'safe'  the same request may be re-sent even after unknown, up to maxTries;
 *   not-executed   retry only with affirmative evidence that no execution occurred;
 *   neither        the row stays unknown and one decision (kind 'unknown-effect') is opened for root.
 *
 * The table is a declaration, not behaviour: it is pure configuration, so it belongs to contracts, and both the host
 * (which closes effects out) and the read-only projections (which display it) read the same object through this entry.
 */
export const EFFECT_CAPABILITIES = Object.freeze({
  // Wake producers deduplicate only AFTER a successful wake. An exception may follow turn/start:
  // only proven notExecuted may retry; unknown must never be relabelled as notExecuted.
  'wake': Object.freeze({ readback: null, retry: 'not-executed', maxTries: 3 }),
  'message': Object.freeze({ readback: null, retry: 'not-executed', maxTries: 3 }),
  'dispatch': Object.freeze({ readback: null, retry: 'not-executed', maxTries: 3 }),
  'intent-result': Object.freeze({ readback: null, retry: 'not-executed', maxTries: 3 }),
  'gc': Object.freeze({ readback: null, retry: 'safe', maxTries: 3 }),
  // Delivery is the one external effect in this repository that is provably readable: the git readback plus
  // delivery.transition decides it (design §6.2.2, M1b §E deviation (3)). It reuses the delivery port; no second
  // readback implementation exists here.
  'delivery': Object.freeze({ readback: 'git', retry: 'safe', maxTries: 3 }),
  'release-task': Object.freeze({ readback: null, retry: 'safe', maxTries: 5 }),
  // Things that open, stop or replace an execution: re-sending one can start something a second time, so an uncertain
  // outcome is never retried. A session readback answers when the composition has a session-state port (§11 item 4).
  'start': Object.freeze({ readback: null, retry: 'unsafe', maxTries: 1 }),
  'cancel': Object.freeze({ readback: 'session', retry: 'unsafe', maxTries: 1 }),
  'cancel-member': Object.freeze({ readback: 'session', retry: 'unsafe', maxTries: 1 }),
  'member-lifecycle': Object.freeze({ readback: 'session', retry: 'unsafe', maxTries: 1 }),
  'create': Object.freeze({ readback: 'session', retry: 'unsafe', maxTries: 1 }),
  'resume': Object.freeze({ readback: 'session', retry: 'unsafe', maxTries: 1 }),
  'dispose': Object.freeze({ readback: 'session', retry: 'unsafe', maxTries: 1 }),
});

/** Every kind this table answers for, in one place (a composition compares its own list against it at start-up). */
export const DECLARED_EFFECT_KINDS = Object.freeze(Object.keys(EFFECT_CAPABILITIES));

/**
 * P9 (docs/decisions/team-autonomy-design.md §10 P9, appendix 9): the table as a reader outside the host may see it.
 *
 * Every call answers with a fresh frozen copy: a reader that edits its copy cannot leave the declaration table - or the
 * copy another reader is holding - changed.
 */
export function effectCapabilities() {
  return Object.freeze(Object.fromEntries(DECLARED_EFFECT_KINDS.map(kind => {
    const declaration = EFFECT_CAPABILITIES[kind];
    return [kind, Object.freeze({ readback: declaration.readback, retry: declaration.retry, maxTries: declaration.maxTries })];
  })));
}

/**
 * The one lookup: a declared kind answers with its declaration, an undeclared one answers with `null` — never with a
 * default. It is the same rule the host's close-out reads the table through (host/src/effect-capabilities.mjs), so
 * "no declaration" cannot mean one thing at start-up and something else at runtime. A kind whose declaration IS
 * `null` therefore reads as undeclared, which is what the pre-M4 implementation answered.
 */
const declarationOf = (declarations, kind) => (typeof kind === 'string' && Object.hasOwn(declarations, kind) ? declarations[kind] : null);

/**
 * §6.2.1: the start-up refusal. Called only while the autonomy switch is on — with the switch off there is no
 * capability layer at all, and today's behaviour (including undeclared kinds) is exactly what must keep happening.
 */
export function validateEffectKinds(kinds, declarations = EFFECT_CAPABILITIES) {
  if (!Array.isArray(kinds)) failWith('INVALID_CONFIG', 'the effect capability check needs the list of kinds this composition emits');
  const missing = [...new Set(kinds)].filter(kind => declarationOf(declarations, kind) === null);
  if (missing.length > 0) {
    failWith('EFFECT_KIND_UNDECLARED', 'every effect kind must declare its capability (§6.2.1); undeclared: ' +
      missing.map(kind => JSON.stringify(kind)).join(', ') + '. An undeclared kind is a configuration defect, not a ' +
      'retryable effect');
  }
  return true;
}
