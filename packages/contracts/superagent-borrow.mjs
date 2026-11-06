import { failWith } from './index.mjs';

/**
 * P0 of the super-agent borrow design (docs/decisions/superagent-borrow-design.md §2, §10, §11): the protocol and the
 * baseline, never a behaviour.
 *
 * Profiles consume the validators/refusals only; no v1 behaviour is installed. What this module publishes is the
 * shape the later packages (P1 Thread/intent, P2 root guard, P3 batch/wake, P4 human capacity) must agree on before any
 * of them is wired: the one switch, its validated defaults, the team-policy row and its start-up check, the migration
 * preconditions, the trusted tool-capability contract and the root role policy. A second spelling of any of these
 * invented at implementation time is exactly what this module exists to prevent.
 *
 * §12 records the 2026-11-01 away-mode selection (user may revise): root-decision-v1. The default remains
 * undecided to require explicit deployment intent; recording the selection never enables a P0 consumer.
 */

/**
 * The refusal codes this protocol introduces, grouped by the section that raises them.
 *
 * Published before v1 consumers (P0 already raises protocol/policy refusals): an error code is part of the contract
 * the UI, the classifier and the auditor read, and a code invented at implementation time is invented a second time by
 * the next package. The list is a name table, never an allow-list of failures, and it repeats no code the autonomy table
 * already publishes (INVALID_CONFIG is that table's).
 */
// Hoisted factory breaks the entry-module cycle: direct import here also initializes index.mjs.
// index can obtain these names before this module's const bindings initialize, with no duplicated table.
export function superagentBorrowCodes() {
  return Object.freeze({
  // §2: the switch says v1 but this build has no v1 consumer, and a stored policy disagrees with the configuration.
  protocol: Object.freeze(['PROTOCOL_UNSUPPORTED', 'POLICY_MISMATCH', 'MIGRATION_REQUIRED']),
  // §4.1/§4.2: the owner session's final execution hook. ROOT_GUARD_UNAVAILABLE is the start-up refusal; the other
  // three are the hook's own answers: a trusted declaration refuses the capability (ROLE_GUARD_DENIED), a routed owner
  // session whose durable role is not root (PRINCIPAL_MISMATCH), and an owner call the hook cannot attribute to a
  // bound owner principal (ROOT_PRINCIPAL_UNBOUND).
  guard: Object.freeze(['ROOT_GUARD_UNAVAILABLE', 'ROLE_GUARD_DENIED', 'PRINCIPAL_MISMATCH', 'ROOT_PRINCIPAL_UNBOUND', 'ROOT_WORK_ATTEMPT_DENIED']),
  // §3.3: a member asking another member to change work goes through root; a plain notice still does not. A v1
  // coordination request is a root decision, so the codes below say which state of that decision blocks the revision
  // (P1 raised them, §3.3 rules 4-6); WRONG_INTENT_PROTOCOL keeps the M2b window/vote surface from being used on one.
  coordination: Object.freeze(['COORDINATE_VIA_ROOT', 'COORDINATION_PENDING', 'COORDINATION_REJECTED',
    'COORDINATION_REVISION_REQUESTED', 'WRONG_INTENT_PROTOCOL']),
  // §3.1/§3.4: the thread family's refusals. A decision command on a resource thread, an identity that is not a
  // registered repository or not a normalised key, a publish that would exceed the per-resource backlog, a closed
  // resource, a replay below the retention watermark, a retention step that would pass a still-reserved event, and
  // the subscription states the publish path reads.
  thread: Object.freeze(['WRONG_THREAD_KIND', 'THREAD_BACKLOG_FULL', 'THREAD_CLOSED', 'THREAD_REPLAY_UNAVAILABLE',
    'THREAD_RETENTION_BLOCKED', 'INVALID_RESOURCE', 'UNKNOWN_REPOSITORY', 'UNKNOWN_SUBSCRIPTION', 'NOT_SUBSCRIBED']),
  // §5.3: an input that does not fit even as a reference stays pending instead of being dropped or looped on.
  batch: Object.freeze(['BATCH_ITEM_TOO_LARGE']),
  // §6: unknown owner transport / real effect IO retains occupancy and closes new admission.
  capacity: Object.freeze(['CAPACITY_UNKNOWN']),
  // §4.2: the deployment named an owner model this build cannot select. Start-up fails instead of silently falling
  // back to a heavier model or to the member offline placeholder.
  model: Object.freeze(['ROOT_MODEL_UNAVAILABLE']),
  // Gap 1: authoritative evidence governance compacted an operation's receipt after it committed. The tool entry refuses
  // the replay instead of answering with a null result body; the durable answer is the summary, and the caller must not
  // re-run the business action under a new operationId.
  storage: Object.freeze(['RECEIPT_COMPACTED']),
  });
}
export const SUPERAGENT_BORROW_CODES = superagentBorrowCodes();

/** The same table flattened, so the published code list can be extended in one place only. */
export const superagentBorrowCodeList = Object.freeze(Object.values(SUPERAGENT_BORROW_CODES).flat());

/** The only policy row version this contract reads; anything else is a store this build must not reinterpret. */
export const BORROW_POLICY_VERSION = 1;

/**
 * The defaults of the borrow contract. Every one of them is "the product as it is today":
 *
 *   superagentBorrow  off        - the whole protocol is off; the profile, the surfaces, the executor choice and the
 *                                  budgets are HEAD's (§2, first bullet). The switch is one position, never four
 *                                  independent booleans, so "some of the protocol" cannot be configured by accident.
 *   ownerModel        null       - the host keeps the owner model it already selects; a lighter coordinator model is a
 *                                  deployment choice (§4.2) and is never assumed.
 *   intentSemantics   undecided  - no deployment selection recorded. §12 selected root-decision-v1; a deployment
 *                                  must name it explicitly before activation. This sentinel is not a third protocol.
 */
export const SUPERAGENT_BORROW_DEFAULTS = Object.freeze({
  superagentBorrow: 'off',
  ownerModel: null,
  intentSemantics: 'undecided',
});

/**
 * Historical choice vocabulary plus the unresolved deployment sentinel. §12 selected root-decision-v1.
 * silence-pass-m2b remains parseable as a recorded alternative, not a supported v1 implementation; changing
 * the selection requires revising the v1 design/tests, not silently enabling a second intent state machine.
 */
export const INTENT_SEMANTICS_VALUES = Object.freeze(['undecided', 'root-decision-v1', 'silence-pass-m2b']);

/**
 * §3.3/§12: the name a deployment configures to get the explicit-root-decision semantics P1 implements.
 *
 * Published here so the profile, the team-policy reader and the core reducers that dispatch the publish gate
 * cannot spell the protocol three ways. The reducers select it through intentProtocol() in collab.mjs; the
 * composition root still refuses to boot it until every stage in BORROW_IMPLEMENTATION_STAGES is implemented.
 */
export const ROOT_DECISION_SEMANTICS = 'root-decision-v1';

/** Historical question and recorded decision (export name retained); defaults do not auto-enable it. */
export const SUPERAGENT_BORROW_OPEN_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 's1-intent-semantics',
    section: '§12',
    question: 'Does a v1 intent become an explicit root decision (no silence = consent), or does M2b\'s window stay?',
    unresolvedValue: 'undecided',
    values: INTENT_SEMANTICS_VALUES,
    selectedValue: 'root-decision-v1',
    decidedAt: '2026-11-01',
    source: 'away-mode-selection; user may revise',
  }),
]);

const CONFIG_KEYS = Object.freeze(Object.keys(SUPERAGENT_BORROW_DEFAULTS));
const OWNER_MODEL_KEYS = Object.freeze(['provider', 'model']);
// The row's own fields, plus the envelope every stored entity carries (ControlStore.put adds these). The envelope is
// listed so a stored row is readable, not so an unknown business field is: anything outside both lists is still refused.
const POLICY_KEYS = Object.freeze(['version', 'superagentBorrow', 'activatedAt', 'migrationRef']);
const POLICY_ENVELOPE = Object.freeze(['entityId', 'revision', 'schemaVersion', 'teamId', 'createdAt', 'updatedAt']);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = detail => failWith('INVALID_CONFIG', 'superagentBorrow: ' + detail);
const unsupported = detail => failWith('PROTOCOL_UNSUPPORTED', detail);

/** Reject an object carrying a key the contract does not define: a typo must fail loudly, not fall back to a default. */
function onlyKeys(value, allowed, where) {
  if (!isPlainObject(value)) refuse(where + ' must be an object, got ' + JSON.stringify(value));
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) refuse(where + ' does not define ' + unknown.map(key => JSON.stringify(key)).join(', '));
  return value;
}

/**
 * Validate the optional owner model (§4.2). Display and deployment selection only: no code path reads the result today,
 * and the profile refuses to boot with one set (assertProtocolSupported), so a deployment cannot believe it switched the
 * owner's model when nothing did.
 */
export function ownerModelConfig(value) {
  if (value === null) return null;
  onlyKeys(value, OWNER_MODEL_KEYS, 'ownerModel');
  const missing = OWNER_MODEL_KEYS.filter(key => value[key] === undefined);
  if (missing.length) refuse('ownerModel needs ' + missing.join(', ') + ' when it is set at all');
  for (const key of OWNER_MODEL_KEYS) {
    const name = value[key];
    if (typeof name !== 'string' || name.length < 1 || name.length > 128) {
      refuse('ownerModel.' + key + ' must be a non-empty string of at most 128 characters, got ' + JSON.stringify(name));
    }
  }
  return Object.freeze({ provider: value.provider, model: value.model });
}

/**
 * Validate and freeze the borrow configuration; design §2 and §10 P0.
 *
 * Same discipline as collabConfig() and autonomyConfig(): unknown keys and illegal values are INVALID_CONFIG, and the
 * result is frozen, because a protocol switch that can be edited after the mount is not a contract. Schema:
 * packages/contracts/superagent-borrow.schema.json.
 */
export function superagentBorrowConfig(overrides = {}) {
  onlyKeys(overrides, CONFIG_KEYS, 'configuration');
  const value = { ...SUPERAGENT_BORROW_DEFAULTS, ...overrides };
  if (!['off', 'v1'].includes(value.superagentBorrow)) {
    refuse('superagentBorrow must be "off" or "v1", got ' + JSON.stringify(value.superagentBorrow));
  }
  if (!INTENT_SEMANTICS_VALUES.includes(value.intentSemantics)) {
    refuse('intentSemantics must be one of ' + INTENT_SEMANTICS_VALUES.join(', ') + ', got ' + JSON.stringify(value.intentSemantics));
  }
  return Object.freeze({
    superagentBorrow: value.superagentBorrow,
    ownerModel: ownerModelConfig(value.ownerModel),
    intentSemantics: value.intentSemantics,
  });
}

/**
 * Pick the borrow keys out of a profile patch or a plugin configuration.
 *
 * Returns {} when none is named, so a specification that says nothing about the protocol keeps generating the profile it
 * generated before the switch existed (the same rule autonomyOptions follows in packages/profiles/index.mjs).
 */
export function borrowOptions(source = {}) {
  const given = {};
  if (!isPlainObject(source)) return given;
  for (const key of CONFIG_KEYS) if (source[key] !== undefined) given[key] = source[key];
  return given;
}

/**
 * §2: v1 is one protocol version, and it only exists on top of the four capabilities it was designed against.
 *
 * A profile that says v1 without them is INVALID_CONFIG before anything is mounted - not a partial protocol and not a
 * defaulted-away field. The values are passed in rather than read from a profile object because this contract also
 * serves the plugin, which has its own configuration shape.
 */
export function assertBorrowPreconditions({ team, guard, goalCheck, autonomy, collab } = {}) {
  const missing = [];
  if (team !== true) missing.push('team=true');
  if (guard !== true) missing.push('guard=true');
  if (goalCheck !== true) missing.push('goalCheck=true');
  if (autonomy !== 'on') missing.push('autonomy=on');
  if (collab !== 'on') missing.push('collab=on');
  if (missing.length) refuse('superagentBorrow="v1" requires ' + missing.join(', '));
  return true;
}

/**
 * What this build actually implements. P0 ships the contract and the probes; it implements no v1 consumer, so naming v1
 * (or naming an owner model, whose entry belongs to P2) must fail at start-up instead of running the old behaviour under
 * a new name. Mark v1 implemented only after ALL required consumers/capability checks pass (P1-P5), never
 * merely because the first package landed. Owner-model support is an independent P2 capability.
 */
export const BORROW_IMPLEMENTATION = Object.freeze({ off: 'implemented', v1: 'contract-only' });

/**
 * §2, §10: the implementation state of each v1 mechanism, package by package.
 *
 * The position above stays 'contract-only' until EVERY stage here is implemented and its acceptance checks pass. The
 * table exists so a landed package records what it really installed without that record flipping v1 on: P1 installed
 * S1 (§3 Thread/intent), and S2-S5 are still contracts, so naming v1 keeps failing closed at start-up exactly as P0
 * did. A later package moves its own row; nobody moves the whole position.
 */
export const BORROW_IMPLEMENTATION_STAGES = Object.freeze({
  s1: Object.freeze({ id: 's1-thread-intent', section: '§3', status: 'implemented',
    detail: 'resource threads, thread events/subscriptions and root-decision coordination' }),
  s2: Object.freeze({ id: 's2-root-guard', section: '§4', status: 'implemented',
    detail: 'the role guard at the owner final execution hook' }),
  s3: Object.freeze({ id: 's3-input-batch', section: '§5', status: 'implemented',
    detail: 'one input arbiter, typed bounded batches and the wake edge' }),
  s4: Object.freeze({ id: 's4-human-capacity', section: '§6', status: 'implemented',
    detail: 'the reserved human execution and effect-IO capacity' }),
  s5: Object.freeze({ id: 's5-projections', section: '§10 P5', status: 'implemented',
    detail: 'the v1 projection/UI read surface and the whole-protocol acceptance wiring' }),
});

/** The v1 mechanisms this build has not installed yet, as data a status projection and a test can both read. */
export function unimplementedBorrowStages() {
  return Object.freeze(Object.values(BORROW_IMPLEMENTATION_STAGES).filter(entry => entry.status !== 'implemented'));
}

/**
 * §2: what still stands between this configuration and an admissible v1 team.
 *
 * The list is data so a status projection can print it and a test can pin it. It is also why "v1" cannot be faked by
 * configuring it: an unresolved product decision is a blocker, not a default.
 */
export function borrowReadiness(configuration) {
  const value = superagentBorrowConfig(configuration ?? {});
  const blockers = [];
  if (BORROW_IMPLEMENTATION[value.superagentBorrow] !== 'implemented') {
    blockers.push(Object.freeze({ id: 'v1-not-implemented',
      detail: 'P1-P5, the integration candidate, the public build/transport unknown-recovery matrix, provider ' +
        'throttling classification and authoritative evidence retention (reference closure plus atomic receipt ' +
        'compaction/archive) are installed, but the full public activation acceptance has not been re-run on this ' +
        'build; none of that opens v1' }));
  }
  if (value.ownerModel !== null && value.superagentBorrow === 'off') {
    blockers.push(Object.freeze({ id: 'owner-model-not-wired',
      detail: 'the owner model entry belongs to P2; this build would otherwise report a model it never selected' }));
  }
  if (value.superagentBorrow === 'v1' && value.intentSemantics === 'silence-pass-m2b') {
    blockers.push(Object.freeze({ id: 's1-intent-semantics-unsupported',
      detail: 'v1 uses root-decision-v1 (§12, 2026-11-01); silence-pass-m2b requires a design revision' }));
  }
  if (value.superagentBorrow === 'v1' && value.intentSemantics === 'undecided') {
    blockers.push(Object.freeze({ id: 's1-intent-semantics-undecided',
      detail: 'the deployment must explicitly record root-decision-v1 (§12, 2026-11-01) before v1 activation' }));
  }
  // P1 records that S1 is installed and names the stages that are not. v1 is one protocol version: a build that has
  // three of its four mechanisms is not a v1 build, and the list is what makes that checkable instead of implied.
  if (value.superagentBorrow === 'v1') {
    for (const entry of unimplementedBorrowStages()) {
      blockers.push(Object.freeze({ id: entry.id + '-not-implemented',
        detail: entry.section + ' ' + entry.detail + ' is still a contract in this build' }));
    }
  }
  return Object.freeze({ ready: blockers.length === 0, blockers: Object.freeze(blockers) });
}

/**
 * Refuse a configuration this build cannot honour, at the composition root, before anything is mounted.
 *
 * Everything the switch promises (no root execution, one input arbiter, resource subscripts) is missing in P0, so
 * accepting "v1" here would be a false report of the protocol in force. Owner-model selection has the same shape of
 * problem: the design forbids silently falling back to a heavier model (§4.2), and this build cannot select one at all.
 */
export function assertProtocolSupported(configuration) {
  const value = superagentBorrowConfig(configuration ?? {});
  const readiness = borrowReadiness(value);
  // Every blocker refuses, including the §12 one: a build may not activate a protocol position whose product question is
  // still open, even once the packages exist. The alternative - running v1 with an unanswered semantics - is exactly the
  // "two silent protocols" the design forbids.
  if (readiness.ready) return readiness;
  if (value.superagentBorrow === 'v1' && BORROW_IMPLEMENTATION.v1 !== 'implemented') {
    unsupported('superagentBorrow="v1" is ' + BORROW_IMPLEMENTATION.v1 + ' in this build: the P1-P5 consumers and ' +
      'storage/transport/provider governance are installed, but the full public activation acceptance has not been run ' +
      'on this build; the protocol in force is "off" and this process will not claim otherwise');
  }
  unsupported(readiness.blockers.map(blocker => blocker.id + ': ' + blocker.detail).join('; '));
}

/**
 * The persistent team policy row, §2: `team-policy:<teamId> = {version:1, superagentBorrow, activatedAt, migrationRef}`.
 *
 * Nothing writes this row in P0 - activation requires all consumers and their acceptance checks - so a store that has
 * never run the new protocol keeps none, and "off" over an old database writes nothing on upgrade. The writer this
 * function exists for reads it back before it admits work.
 *
 * migrationRef is null only for a team created under the new protocol (no legacy history to migrate); a team that had
 * history must name the saved migration summary instead of an empty string.
 */
export function teamPolicyRow(teamId, { superagentBorrow, activatedAt, migrationRef } = {}) {
  if (typeof teamId !== 'string' || !teamId.length || teamId.length > 128) {
    refuse('teamPolicyRow needs a team id of 1 to 128 characters, got ' + JSON.stringify(teamId));
  }
  if (!['off', 'v1'].includes(superagentBorrow)) {
    refuse('teamPolicyRow.superagentBorrow must be "off" or "v1", got ' + JSON.stringify(superagentBorrow));
  }
  const stamp = typeof activatedAt === 'string' ? activatedAt : activatedAt instanceof Date &&
    Number.isFinite(activatedAt.getTime()) ? activatedAt.toISOString() : null;
  if (stamp === null || !/^\d{4}-\d{2}-\d{2}T/.test(stamp) || Number.isNaN(Date.parse(stamp))) {
    refuse('teamPolicyRow.activatedAt must be an ISO timestamp, got ' + JSON.stringify(activatedAt));
  }
  if (migrationRef !== null && (typeof migrationRef !== 'string' || !migrationRef.length || migrationRef.length > 256)) {
    refuse('teamPolicyRow.migrationRef must be null or a non-empty string of at most 256 characters, got ' + JSON.stringify(migrationRef));
  }
  return Object.freeze({ version: BORROW_POLICY_VERSION, superagentBorrow, activatedAt: stamp, migrationRef });
}

/**
 * §2: configuration and stored policy must agree, and neither may be reinterpreted on the way in.
 *
 * A team with no row is "fresh" and needs no decision: nothing has run the new protocol on it, so "off" is not a change.
 * Any other difference is refused - the row is the team's record of which protocol wrote its history, and a build that
 * opens it under the other one would be reading old facts with new rules.
 */
export function policyDecision(persisted, configured) {
  if (persisted === null || persisted === undefined) return Object.freeze({ decision: 'fresh', reason: 'no-policy-row' });
  if (!isPlainObject(persisted)) return Object.freeze({ decision: 'mismatch', reason: 'policy-row-unreadable' });
  const unknown = Object.keys(persisted).filter(key => !POLICY_KEYS.includes(key) && !POLICY_ENVELOPE.includes(key));
  if (unknown.length) return Object.freeze({ decision: 'mismatch', reason: 'policy-row-has-unknown-fields' });
  if (persisted.version !== BORROW_POLICY_VERSION) {
    return Object.freeze({ decision: 'mismatch', reason: 'unknown-policy-version' });
  }
  if (!['off', 'v1'].includes(persisted.superagentBorrow)) {
    return Object.freeze({ decision: 'mismatch', reason: 'invalid-stored-protocol' });
  }
  try {
    teamPolicyRow('policy-validation', persisted);
  } catch {
    return Object.freeze({ decision: 'mismatch', reason: 'invalid-policy-metadata' });
  }
  if (persisted.superagentBorrow !== configured) {
    return Object.freeze({ decision: 'mismatch', reason: 'configured-protocol-differs-from-store' });
  }
  return Object.freeze({ decision: 'match', reason: null });
}

/** Raise POLICY_MISMATCH for a persisted row this configuration may not open; §2 and the §8 failure matrix. */
export function assertPolicyCompatible(persisted, configured) {
  const decision = policyDecision(persisted, configured);
  if (decision.decision === 'mismatch') {
    failWith('POLICY_MISMATCH', 'the stored team policy is ' + decision.reason + ' (' +
      (persisted?.superagentBorrow ?? 'none') + ' stored, ' + configured + ' configured); a team changes protocol only ' +
      'through a quiescent migration, never by reinterpreting its own history');
  }
  return decision;
}

/**
 * §2: the checks that stand between a legacy team and a v1 one, as the design lists them.
 *
 * They are evidence, not booleans a caller may assert: each one is read from a fact the migration step already
 * published (execution close-out, effect settlement, intent windows, decision rows, the saved summary). A process
 * restart is not one of them - restarting moves no execution out of "unknown" and closes no objection.
 */
export const MIGRATION_PREREQUISITES = Object.freeze([
  Object.freeze({ id: 'admission-stopped', requirement: 'no new work is admitted before the protocol value changes' }),
  Object.freeze({ id: 'executions-drained', requirement: 'no active and no unknown execution remains' }),
  Object.freeze({ id: 'effects-settled', requirement: 'no applying and no unknown effect remains' }),
  Object.freeze({ id: 'intent-windows-closed', requirement: 'no M2b window is still open' }),
  Object.freeze({ id: 'objections-decided', requirement: 'every objection was decided under the old protocol, not carried over' }),
  Object.freeze({ id: 'migration-summary-saved', requirement: 'the migration summary is saved and addressable' }),
  Object.freeze({ id: 'host-stopped', requirement: 'the host is stopped before the stored protocol changes' }),
]);

const MIGRATION_FIELDS = Object.freeze(['admissionStopped', 'activeExecutions', 'unknownExecutions', 'applyingEffects',
  'unknownEffects', 'openIntentWindows', 'openObjections', 'migrationSummaryRef', 'hostStopped']);

/**
 * Evaluate the migration preconditions against an observation; §2 and §8.
 *
 * Every field is required: a missing count is not zero, and a caller that has not looked must not be able to receive
 * "ready". The answer is a list of the prerequisites that are still unsatisfied, so the operator is told what to drain
 * instead of being told "migration required".
 */
export function migrationCheck(observation = {}) {
  onlyKeys(observation, MIGRATION_FIELDS, 'migration observation');
  const missing = MIGRATION_FIELDS.filter(key => observation[key] === undefined);
  if (missing.length) refuse('migration observation needs ' + missing.join(', '));
  for (const key of ['admissionStopped', 'hostStopped']) {
    if (typeof observation[key] !== 'boolean') refuse('migration observation.' + key + ' must be a boolean, got ' + JSON.stringify(observation[key]));
  }
  for (const key of ['activeExecutions', 'unknownExecutions', 'applyingEffects', 'unknownEffects', 'openIntentWindows', 'openObjections']) {
    if (!Number.isSafeInteger(observation[key]) || observation[key] < 0) {
      refuse('migration observation.' + key + ' must be a non-negative integer, got ' + JSON.stringify(observation[key]));
    }
  }
  const summary = observation.migrationSummaryRef;
  if (summary !== null && (typeof summary !== 'string' || !summary.length)) {
    refuse('migration observation.migrationSummaryRef must be null or a non-empty string, got ' + JSON.stringify(summary));
  }
  const satisfied = {
    'admission-stopped': observation.admissionStopped === true,
    'executions-drained': observation.activeExecutions === 0 && observation.unknownExecutions === 0,
    'effects-settled': observation.applyingEffects === 0 && observation.unknownEffects === 0,
    'intent-windows-closed': observation.openIntentWindows === 0,
    'objections-decided': observation.openObjections === 0,
    'migration-summary-saved': summary !== null,
    'host-stopped': observation.hostStopped === true,
  };
  const checks = MIGRATION_PREREQUISITES.map(entry => Object.freeze({ id: entry.id, requirement: entry.requirement,
    satisfied: satisfied[entry.id] === true }));
  const unsatisfied = Object.freeze(checks.filter(check => !check.satisfied).map(check => check.id));
  return Object.freeze({ ready: unsatisfied.length === 0, unsatisfied, checks: Object.freeze(checks) });
}

/** Raise MIGRATION_REQUIRED naming what is still outstanding; §2, §8. */
export function assertMigrationReady(observation) {
  const result = migrationCheck(observation);
  if (!result.ready) {
    failWith('MIGRATION_REQUIRED', 'the team is not quiescent enough to change protocol: ' + result.unsatisfied.join(', ') +
      ' (a restart is not a drain)');
  }
  return result;
}

/**
 * §4.1: what a tool is allowed to do, as a closed vocabulary.
 *
 * A name is readable or it is not: a checker that accepted "read" and "read-only" and "read_local" would let a
 * registration choose its own class by spelling.
 */
export const TOOL_CAPABILITIES = Object.freeze(['read-local', 'coordinate', 'execute', 'write-local', 'opaque']);

/**
 * §4.1, §4.3: the owner is a coordinator and never an executor.
 *
 * The policy is data so that the final execution hook (P2) and its tests read one table. "unknown: deny" is not a
 * fallback that can be switched off: a tool whose capabilities nobody declared is refused, because the alternative is
 * deciding permission from a tool's name.
 */
export const ROOT_TOOL_POLICY = Object.freeze({
  principalKind: 'owner',
  deny: Object.freeze(['opaque', 'write-local', 'execute']),
  allow: Object.freeze(['read-local', 'coordinate']),
  unknown: 'deny',
});

/**
 * The capabilities of the tools THIS repository publishes (§4.1), keyed by the tool identity a registration carries.
 *
 * Only the team tools are declared here. Native, MCP, batch and executor tools are declared where they are registered
 * (P2), so there is one declaration per tool and not two tables that can disagree; anything absent from either is
 * undeclared and therefore refused by toolCapabilityDecision.
 *
 * team_task and team_verify are execution-capability tools: a member produces a delivery under a lease, and the owner
 * never does. Op-level refinement (root may check a member's progress) is the P2 `allowedOperations` extension the
 * design names; P0 publishes the conservative answer, which is "deny", because fail-closed is the safe direction.
 */
export const TOOL_CAPABILITY_DECLARATIONS = Object.freeze({
  team_read: Object.freeze(['read-local', 'coordinate']),
  team_message: Object.freeze(['coordinate']),
  team_thread: Object.freeze(['coordinate']),
  team_wait: Object.freeze(['coordinate']),
  team_plan: Object.freeze(['coordinate']),
  team_member: Object.freeze(['coordinate']),
  team_goal: Object.freeze(['coordinate']),
  team_assume: Object.freeze(['coordinate']),
  team_decision: Object.freeze(['coordinate']),
  team_decide: Object.freeze(['coordinate']),
  team_task: Object.freeze(['coordinate', 'execute']),
  team_verify: Object.freeze(['execute']),
});

/**
 * The declaration of one tool identity, or null when nobody declared it.
 *
 * Null is the answer a caller must treat as "deny": an undeclared tool cannot inherit another tool's permissions by
 * sharing its name (a different implementation is a different identity), which is §4.1's fail-closed rule.
 */
export function capabilityDeclaration(identity) {
  if (typeof identity !== 'string') return null;
  if (!Object.hasOwn(TOOL_CAPABILITY_DECLARATIONS, identity)) return null;
  const capabilities = TOOL_CAPABILITY_DECLARATIONS[identity];
  return capabilities ? Object.freeze({ identity, capabilities }) : null;
}

/**
 * Decide one role-policy question from declared capabilities alone; §4.1.
 *
 * The arguments are the trusted declaration, never a model-supplied tool class: the caller that reaches this function is
 * the final execution hook, which already knows the registered tool identity. An empty declaration, an unknown capability
 * name, a denied capability or a capability the policy does not allow all answer "deny", each with its own reason so the
 * audit row says which rule refused.
 */
export function toolCapabilityDecision(policy, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return Object.freeze({ decision: 'deny', reason: 'UNDECLARED_TOOL' });
  }
  if (policy?.unknown === 'deny' && capabilities.some(capability => !TOOL_CAPABILITIES.includes(capability))) {
    return Object.freeze({ decision: 'deny', reason: 'UNKNOWN_CAPABILITY' });
  }
  const denied = capabilities.filter(capability => policy.deny.includes(capability));
  if (denied.length) return Object.freeze({ decision: 'deny', reason: 'CAPABILITY_DENIED', capabilities: Object.freeze(denied) });
  const outside = capabilities.filter(capability => !policy.allow.includes(capability));
  if (outside.length) return Object.freeze({ decision: 'deny', reason: 'CAPABILITY_NOT_ALLOWED', capabilities: Object.freeze(outside) });
  return Object.freeze({ decision: 'allow', reason: null });
}

/**
 * §4.1, §10 P2: the operation of each team tool, and the capability that operation needs.
 *
 * The whole-tool declaration above stays the conservative answer and is never rewritten: team_task still carries
 * 'execute', so a caller that names no operation is denied. This table is the refinement the design asks for - the
 * owner may coordinate a member's progress (team_task checkpoint) but never produce a delivery (team_task produce) -
 * and it only refines downward: an operation that the table does not name is denied, so a schema branch added before
 * this table fails closed instead of inheriting the tool's whole-tool allow. A tool with no row here is decided by its
 * whole-tool declaration alone.
 */
export const TOOL_OPERATION_CAPABILITIES = Object.freeze({
  team_task: Object.freeze({
    checkpoint: Object.freeze(['coordinate']),
    produce: Object.freeze(['execute']),
  }),
  team_thread: Object.freeze({
    open: Object.freeze(['coordinate']), reply: Object.freeze(['coordinate']), decide: Object.freeze(['coordinate']),
    'open-resource': Object.freeze(['coordinate']), subscribe: Object.freeze(['coordinate']),
    unsubscribe: Object.freeze(['coordinate']), publish: Object.freeze(['coordinate']),
    'close-resource': Object.freeze(['coordinate']),
  }),
  team_message: Object.freeze({
    send: Object.freeze(['coordinate']), accept: Object.freeze(['coordinate']), resolve: Object.freeze(['coordinate']),
  }),
  team_plan: Object.freeze({ create: Object.freeze(['coordinate']), approve: Object.freeze(['coordinate']) }),
  team_member: Object.freeze({
    request: Object.freeze(['coordinate']), freeze: Object.freeze(['coordinate']), resume: Object.freeze(['coordinate']),
    retire: Object.freeze(['coordinate']), provision: Object.freeze(['coordinate']), group: Object.freeze(['coordinate']),
  }),
  team_goal: Object.freeze({ inspect: Object.freeze(['coordinate']), requestCompletion: Object.freeze(['coordinate']) }),
});

/**
 * The capabilities one operation of one declared tool needs; null means "deny".
 *
 * Null is returned for an identity nobody declared, for an operation the table does not name, and - for a tool that
 * has an operation table at all - for a call that names no operation: a missing operation is not the whole tool.
 */
export function toolOperationCapabilities(identity, operation) {
  const template = capabilityDeclaration(identity);
  if (!template) return null;
  if (!Object.hasOwn(TOOL_OPERATION_CAPABILITIES, identity)) return template.capabilities;
  const table = TOOL_OPERATION_CAPABILITIES[identity];
  if (typeof operation !== 'string' || !Object.hasOwn(table, operation)) return null;
  return table[operation];
}
