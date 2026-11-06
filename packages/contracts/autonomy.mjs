import { failWith } from './index.mjs';

/**
 * P0 of the team-autonomy design (docs/decisions/team-autonomy-design.md §10): the contract, not the behaviour.
 *
 * This module only names what later packages may say and may be configured with. It wires nothing: no reducer, no
 * gate and no runner reads these values yet, so every default below reproduces today's behaviour exactly, and every
 * existing profile patch resolves to the same runtime it did before this switch existed. Later packages consume the
 * frozen object; they must not re-declare a second spelling of the same limit or of the same refusal.
 */

/**
 * The refusal codes the autonomy packages introduce, grouped by the design section that raises them.
 *
 * They are published now, while nothing raises them, for one reason: an error code is part of the contract the UI,
 * the protocol classifier and the auditors read, and a code invented at implementation time would be invented a
 * second time by the next package. The list is a name table, never an allow-list of failures.
 */
export const AUTONOMY_CODES = Object.freeze({
  // §2.3: the decision row's subject moved between open and decide.
  decision: Object.freeze(['DECISION_STALE', 'SELF_JUDGE_DENIED']),
  // §5.2: the team-level goal record, its per-target bases and the legacy chain migration.
  goal: Object.freeze([
    'TEAM_GOAL_REQUIRED',
    'TEAM_GOAL_TOO_LATE',
    'TARGET_BASE_UNRECORDED',
    'TARGET_ALREADY_HAS_DELIVERIES',
    'UNVERIFIED_LEGACY_BASE',
  ]),
  // §7.2.3/§7.2.4: a pid whose creation time no longer matches is never killed, and every other way a stop proof can
  // fail says which of the three reasons it was (the platform could not be asked, the kill was refused, or the tree was
  // still alive when the second budget ran out). None of them is ever read as "stopped".
  stop: Object.freeze(['PID_REUSED', 'STOP_NOT_VERIFIED', 'STOP_CAPABILITY_MISSING', 'STOP_ACCESS_DENIED',
    'STOP_PROOF_TIMEOUT']),
  // §8.2: the three budgets and the removed unit-less cost field.
  // §8.2.3 / §12 U2: the three ways a budget refuses new work, plus the code a measurement gap carries into its
  // decision (BUDGET_UNMEASURED is evidence, never a refusal: an unmeasured count does not stop the team).
  budget: Object.freeze(['INVALID_BUDGET_FIELD', 'DELEGATION_CONCURRENCY', 'DELEGATION_TOKEN_BUDGET', 'BUDGET_UNMEASURED']),
  // §12 U6: root sending to itself and accepting it.
  message: Object.freeze(['SELF_ADDRESSED']),
  // §3.2.3: the owner holds no execution lease, so an execution-class command cannot run under the owner identity.
  owner: Object.freeze(['OWNER_HAS_NO_LEASE']),
  // §4.2: a workspace outside the team root, or one the fence refused; and the two ways a group assignment is refused
  // (a locked workspace, a group name or move that is not root's). INVALID_WORKSPACE is the one the design names; the
  // other three say which half of §4.2.3/§4.2.4 refused, so the operator does not read them as a path problem.
  workspace: Object.freeze(['INVALID_WORKSPACE', 'WORKSPACE_LOCKED', 'INVALID_GROUP', 'GROUP_LOCKED']),
  // The one code every switch in this module raises, plus the §6.2 effect-capability codes: an undeclared kind at
  // start-up (§6.2.1), a readback that is missing or cannot decide (§6.3), and a safe retry that ran out of attempts.
  // None of them is ever a business refusal: they say the adapter could not answer, which is what opens the decision.
  config: Object.freeze(['INVALID_CONFIG', 'EFFECT_KIND_UNDECLARED', 'EFFECT_READBACK_MISSING',
    'EFFECT_READBACK_UNCERTAIN', 'EFFECT_RETRY_EXHAUSTED']),
});

/** The same table flattened, so the published code list can be extended in one place only. */
export const autonomyCodeList = Object.freeze(Object.values(AUTONOMY_CODES).flat());

/** The row kind §7.2.1 writes, and the only kind a close-out may cite as stop evidence. */
export const STOP_PROOF_KIND = 'stop-proof';

/**
 * §7.2.4: the one question every close-out asks of a stop-proof row — "does this row prove THIS subject stopped?".
 *
 * Four things have to hold, and a caller cannot supply any of them from a request: the row says it is a stop proof, the
 * platform layer marked it verified, the host adapter wrote it (F4: a row a model or an owner wrote is not evidence),
 * and the switch was on when it was written (autonomy off writes no rows at all, so an old store keeps its old
 * behaviour). The subject match is exact — kind, id and the fence the proof was taken at — so a proof for one attempt
 * can never close a different one.
 */
export function stopProofCovers(row, subject) {
  if (!row || row.kind !== STOP_PROOF_KIND || row.verified !== true || row.writtenBy !== 'adapter' || row.switch !== 'on' || !subject) return false;
  const certs=row.contract==='execution-stop-set/1'?row.certificates:[row];
  if(!Array.isArray(certs)||!certs.length)return false;
  return certs.every(c=>c?.contract==='execution-stop/1' && c.stopState==='proven' && c.verified===true &&
    c.coverage?.complete===true && typeof c.stopId==='string' && typeof c.certificateId==='string' && Number.isSafeInteger(c.scopeVersion) &&
    (subject.kind==='attempt' ? certs.length===1 && c.E?.attemptId===subject.id && c.E.attemptFence===subject.fence :
      subject.kind==='member-session' && c.E?.memberId===subject.id && c.E.generation===subject.fence));
}

/**
 * The defaults of the autonomy contract. Each one is either "today's behaviour" or the recommendation the design
 * records for an open question, and nothing else:
 *
 *   autonomy                off      - the switch P1-P6 hang off; off is the product as it is today.
 *   goalGate.strict         false    - the F2 status: the chain root is still the first accepted delivery's base
 *                                      (§5.1). §12 U5 makes strict = true the target state before M6, not the default.
 *   goalGate.legacy         adopt-tail - §5.2.4 / §12 U5: the only migration stance that keeps a running team running.
 *   stopGraceMs             5000     - §7.2.3: the grace period before the hard kill.
 *   stopProofTimeoutMs      10000    - §7.2.3: the second budget, after the hard kill, before "unverified".
 *   decisionTtlMs           900000   - §12 U8: a decision row expires after 15 minutes, and this is configurable.
 *   budget.unknownUsage     continue - §12 U2: an unmeasured token count never halts the team.
 *   budget.unknownGraceMs   1800000  - §8.2.3 / §12 U2: 30 minutes of no measurement opens a budget-unknown row.
 *   pricing                 null     - §8.2.4: no price table means the projection carries no cost at all.
 */
export const AUTONOMY_DEFAULTS = Object.freeze({
  autonomy: 'off',
  goalGate: Object.freeze({ strict: false, legacy: 'adopt-tail' }),
  stopGraceMs: 5000,
  stopProofTimeoutMs: 10000,
  decisionTtlMs: 900000,
  budget: Object.freeze({ unknownUsage: 'continue', unknownGraceMs: 1800000 }),
  pricing: null,
});

const CONFIG_KEYS = Object.freeze(Object.keys(AUTONOMY_DEFAULTS));
const GOAL_GATE_KEYS = Object.freeze(['strict', 'legacy']);
const BUDGET_KEYS = Object.freeze(['unknownUsage', 'unknownGraceMs']);
const PRICING_KEYS = Object.freeze(['currency', 'perInputToken', 'perOutputToken']);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuse = detail => failWith('INVALID_CONFIG', 'autonomy: ' + detail);
const inRange = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

/** Reject an object carrying a key the contract does not define: a typo must fail loudly, not fall back to a default. */
function onlyKeys(value, allowed, where) {
  if (!isPlainObject(value)) refuse(where + ' must be an object, got ' + JSON.stringify(value));
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) refuse(where + ' does not define ' + unknown.map(key => JSON.stringify(key)).join(', '));
  return value;
}

function goalGate(value) {
  onlyKeys(value, GOAL_GATE_KEYS, 'goalGate');
  const merged = { ...AUTONOMY_DEFAULTS.goalGate, ...value };
  if (typeof merged.strict !== 'boolean') refuse('goalGate.strict must be a boolean, got ' + JSON.stringify(merged.strict));
  // One stance, so one legal value: §5.2.4 adopts adopt-tail and explicitly rejects "refuse a non-empty store". A
  // single-valued option is published as a constant rather than as a menu of stances nobody implements (§12 U5).
  if (merged.legacy !== 'adopt-tail') {
    refuse('goalGate.legacy must be "adopt-tail", got ' + JSON.stringify(merged.legacy) + ' (the design adopted no other stance)');
  }
  return Object.freeze({ strict: merged.strict, legacy: merged.legacy });
}

function budget(value) {
  onlyKeys(value, BUDGET_KEYS, 'budget');
  const merged = { ...AUTONOMY_DEFAULTS.budget, ...value };
  if (!['continue', 'stop'].includes(merged.unknownUsage)) {
    refuse('budget.unknownUsage must be "continue" or "stop", got ' + JSON.stringify(merged.unknownUsage));
  }
  if (!inRange(merged.unknownGraceMs, 0, 86400000)) {
    refuse('budget.unknownGraceMs must be an integer between 0 and 86400000, got ' + JSON.stringify(merged.unknownGraceMs));
  }
  return Object.freeze({ unknownUsage: merged.unknownUsage, unknownGraceMs: merged.unknownGraceMs });
}

/**
 * Validate the optional price table. It is display-only (§8.2.4): no reducer reads it, and without it the projection
 * carries no cost field at all, which is how the UI knows not to print a currency symbol.
 *
 * Exported because the projection is the reader this contract is written for, and a second, weaker check there would
 * let a table the profile refuses (an empty currency, a negative rate) still print an amount. The returned object is a
 * frozen copy: whoever configured the table keeps its own object and cannot move an amount without a new event.
 */
export function pricingConfig(value) {
  if (value === null) return null;
  onlyKeys(value, PRICING_KEYS, 'pricing');
  const missing = PRICING_KEYS.filter(key => value[key] === undefined);
  if (missing.length) refuse('pricing needs ' + missing.join(', ') + ' when it is set at all');
  if (typeof value.currency !== 'string' || value.currency.length < 1 || value.currency.length > 16) {
    refuse('pricing.currency must be a non-empty string of at most 16 characters, got ' + JSON.stringify(value.currency));
  }
  for (const key of ['perInputToken', 'perOutputToken']) {
    const rate = value[key];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0) {
      refuse('pricing.' + key + ' must be a finite non-negative number, got ' + JSON.stringify(rate));
    }
  }
  return Object.freeze({ currency: value.currency, perInputToken: value.perInputToken, perOutputToken: value.perOutputToken });
}

/**
 * Validate and freeze the autonomy configuration; design §10 P0, §12 U2/U5/U8.
 *
 * Same shape and same discipline as collabConfig(): unknown keys and out-of-range values are INVALID_CONFIG, and the
 * result is frozen, because a switch that can be edited after the mount is not a contract. Schema:
 * packages/contracts/autonomy.schema.json.
 */
export function autonomyConfig(overrides = {}) {
  onlyKeys(overrides, CONFIG_KEYS, 'configuration');
  const value = { ...AUTONOMY_DEFAULTS, ...overrides };
  if (!['off', 'on'].includes(value.autonomy)) {
    refuse('autonomy must be "off" or "on", got ' + JSON.stringify(value.autonomy));
  }
  if (!inRange(value.stopGraceMs, 0, 600000)) {
    refuse('stopGraceMs must be an integer between 0 and 600000, got ' + JSON.stringify(value.stopGraceMs));
  }
  if (!inRange(value.stopProofTimeoutMs, 1, 600000)) {
    refuse('stopProofTimeoutMs must be an integer between 1 and 600000, got ' + JSON.stringify(value.stopProofTimeoutMs));
  }
  // §12 U8: 15 minutes by default and configurable, bounded so a row cannot outlive a working day.
  if (!inRange(value.decisionTtlMs, 60000, 86400000)) {
    refuse('decisionTtlMs must be an integer between 60000 and 86400000, got ' + JSON.stringify(value.decisionTtlMs));
  }
  return Object.freeze({
    autonomy: value.autonomy,
    goalGate: goalGate(value.goalGate),
    stopGraceMs: value.stopGraceMs,
    stopProofTimeoutMs: value.stopProofTimeoutMs,
    decisionTtlMs: value.decisionTtlMs,
    budget: budget(value.budget),
    pricing: pricingConfig(value.pricing),
  });
}
