import { failWith } from '../contracts/index.mjs';
import { readiness } from './index.mjs';

/**
 * The cross-peer workload's rules, on the product side.
 *
 * F2b moved these out of verification/real/engine.mjs: they never touched a native agent, a store write or a driver
 * outlet - they are pure functions over one cycle's committed state and they are what the acceptance suites assert.
 * Keeping them here gives them one home that both the offline runs and the unit suites import, instead of six
 * copies inside a harness module that F2 deletes.
 *
 * The review ordering is the part that cost real runs: a verifier that reviewed before root opened the issue, and an
 * integrate that ran before every delivery was verified. Both were null-path TypeErrors; both are now business
 * refusals that name the missing step, decided before anything is written.
 */

/** The real_work tool's published schema: one op and the arguments that op needs, nothing else. */
export const workSchema = { type: 'object', additionalProperties: false,
  properties: { op: { enum: ['brief', 'accept', 'produce', 'review', 'open', 'integrate'] },
    messageId: { type: 'string' }, value: { type: 'integer' }, deliveryId: { type: 'string' }, approved: { type: 'boolean' } },
  required: ['op'] };

/**
 * Per-branch required arguments, answered the way the published schema answers: a caller-side refusal that names the
 * missing field and how to obtain it, never a TypeError from reading a missing argument.
 */
export const workArgs = { accept: ['messageId'], produce: ['messageId', 'value'], review: ['deliveryId'], open: [], integrate: [], brief: [] };
const workRemedy = { messageId: 'take the message id from real_work brief (inbox) or team_read {view:"message"}',
  value: 'the integer result of your own value plus the peer value you accepted',
  deliveryId: 'copy id (artifact:<cycle>:<actor>) or deliveryId (delivery:task:...) from real_work brief (deliveries)' };

export function requireWorkArgs(args) {
  if (!args || typeof args !== 'object') failWith('INVALID_TOOL_FIELDS', 'real_work needs an object with op; ops are ' + Object.keys(workArgs).join('|'));
  const needed = workArgs[args.op] ?? [];
  const missing = needed.filter(key => args[key] === undefined || args[key] === null);
  if (missing.length) failWith('INVALID_TOOL_FIELDS', 'real_work op "' + args.op + '" needs ' + missing.map(key => key + ' (' + workRemedy[key] + ')').join('; '));
}

/**
 * The deliveries the review issue must account for. Root opens the issue before the workers produce, so the expected
 * ids come from the cycle's assignments (artifact:<cycle>:<actor>) and not from whatever has been produced so far.
 */
export const deliveryRefs = cycle => Object.keys(cycle.assignments ?? {}).map(actor => 'artifact:' + cycle.id + ':' + actor);

/**
 * Ordering rules as data, so they can be asserted without a live run.
 * A review stands only on an existing issue; integration needs the issue, every verified delivery, and a thread that
 * records every review reply. Deciding before merging keeps the thread and the merged set in step.
 */
export function reviewDelivery(cycle, args, actor) {
  const delivery = cycle?.deliveries.find(d => d.id === args.deliveryId || d.deliveryId === args.deliveryId);
  if (!delivery || delivery.actor === actor || delivery.status !== 'produced' || args.approved !== true) {
    const choices = (cycle?.deliveries ?? []).filter(d => d.actor !== actor && d.status === 'produced')
      .map(d => ({ id: d.id, deliveryId: d.deliveryId }));
    failWith('REVIEW_REJECTED', 'Use real_work review {deliveryId,approved:true}; accept either id or deliveryId from ' +
      'real_work brief deliveries. Only produced, not already reviewed candidates qualify. Valid choices: ' + JSON.stringify(choices));
  }
  return delivery;
}

export const reviewGuard = cycle => !cycle?.issue ? 'REVIEW_THREAD_NOT_OPENED' : null;

export function integrateGuard(cycle, thread) {
  if (!cycle?.issue) return 'DECISION_THREAD_REQUIRED';
  if (cycle.deliveries.length !== 4 || cycle.deliveries.some(d => d.status !== 'verified')) return 'DELIVERIES_NOT_VERIFIED';
  if (!thread) return 'DECISION_THREAD_REQUIRED';
  if (!['collecting', 'decided'].includes(thread.status)) return 'DECISION_THREAD_REQUIRED';
  return thread.status === 'collecting' && thread.readyToDecide === false ? 'REVIEWS_INCOMPLETE' : null;
}

/**
 * The issue as the model should see it: the stored thread plus what is missing and whether integrate may run now.
 * A missing core or a cycle without an issue answers null, so the brief stays lossless JSON in every state.
 */
export function issueView(core, cycle) {
  const id = cycle?.issue;
  if (!id || !core?.store) return null;
  const thread = core.store.read(id);
  if (!thread) return null;
  const state = readiness(thread);
  return { ...thread, missing: state.missing, readyToDecide: state.readyToDecide, nextAction: state.nextAction,
    integrateReady: !!(state.readyToDecide && cycle.deliveries.length === 4 && cycle.deliveries.every(d => d.status === 'verified')) };
}

/** One member's brief: its assignment, its inbox and, for the reviewing roles, the batch. */
export function brief(actor, { cycle = null, pending = [], core = null } = {}) {
  return { actor, cycle: cycle?.id ?? 0, assignment: cycle?.assignments?.[actor] ?? null, inbox: pending,
    deliveries: actor === 'verifier' || actor === 'root' ? cycle?.deliveries ?? [] : [], issue: issueView(core, cycle),
    marker: 'ALPHA7' };
}
