import { failWith, sameExecution } from '../contracts/index.mjs';
import { subscriptionId } from './thread-events.mjs';

/**
 * S3 (§5.1): one input model for a member's next turn.
 *
 * This is a pure read. It adds no queue, no listener and no second dispatcher: it projects the durable facts that
 * already exist — the addressed mailbox (the legacy facade is untouched), the closed coordination result an initiator
 * has not seen, and the pending resource deliveries of the current subscription epoch — into one list of typed
 * bindings, each naming the row it came from and the binding it was prepared under. Anything absent from this list
 * is not an input, and an internal cursor/audit write can never become one (design §5.1).
 *
 * cutoffSeq is the team log's commit watermark at read time. sourceSeq keeps the source's own sequence (a message
 * revision, a thread event seq); the two are never compared, because they live in different spaces (§5.1).
 */

import { messageHumanOrigin } from './control-capacity.mjs';

export const INPUT_KINDS = Object.freeze(['human-control', 'message', 'coordination-result', 'thread-delivery']);

/** §5.3 ordering: human control first, then action/decision intents, then results, then resource, then plain info. */
const PRIORITY = Object.freeze({ 'human-control': 0, action: 1, decision: 1, intent: 1, 'coordination-result': 2,
  'thread-delivery': 3, info: 4 });

const DELIVERY_PREFIX = 'thread-delivery:';
/**
 * How many human/control inputs lead a batch before the reserved resource slot (§5.3 fairness).
 *
 * One, deliberately: the published 4096-byte ceiling holds only a handful of typed bindings, so a larger block would
 * let the batch fill up before the reserved slot is reached and the guarantee would be nominal. Every further human
 * input still precedes the other classes; only the first one precedes the reserved resource input.
 */
export const HUMAN_SLOTS = 1;

const isHuman = (row, store) => Boolean(messageHumanOrigin(store,row));

/**
 * The durable binding of one mailbox row, exactly as the legacy reducer would judge it.
 *
 * An intent is bound per recipient (generation and binding generation for THIS member); every other message is
 * addressed to one recipient with one generation. The two shapes are kept apart here so provenance can rebuild the
 * binding from the row instead of trusting the caller's copy.
 */
function messageBinding(message, memberId, store) {
  const intent = message.kind === 'intent';
  const generation = intent ? (message.generations?.[memberId] ?? null) : (message.generation ?? null);
  const bindingEpoch = intent ? (message.bindingGenerations?.[memberId] ?? 0) : (message.bindingGeneration ?? 0);
  const kind = isHuman(message, store) ? 'human-control' : 'message';
  return Object.freeze({ kind, ref: message.entityId, revision: message.revision ?? null, memberId, generation,
    bindingEpoch, sourceSeq: Number.isSafeInteger(message.seq) ? message.seq : null,
    priority: isHuman(message, store) ? PRIORITY['human-control'] : (PRIORITY[message.kind] ?? PRIORITY.info),
    bodyRef: message.bodyRef ?? message.entityId, messageKind: message.kind ?? null,
    threadRef: message.threadRef ?? null, summary: String(message.summary ?? '').slice(0, 160) });
}

/** A resource delivery is bound to the subscription epoch that produced it, never to the subscription at large. */
function deliveryBinding(delivery, memberId) {
  return Object.freeze({ kind: 'thread-delivery', ref: delivery.entityId, revision: delivery.seq ?? null, memberId,
    generation: delivery.generation ?? null, bindingEpoch: delivery.subscriptionEpoch ?? 0,
    sourceSeq: Number.isSafeInteger(delivery.seq) ? delivery.seq : null, priority: PRIORITY['thread-delivery'],
    bodyRef: delivery.eventRef ?? delivery.entityId, messageKind: null, threadRef: delivery.threadRef ?? null,
    summary: '' });
}

/**
 * The closed coordination result an initiator has not seen: the same durable intent row, after its decision.
 *
 * It is not a new entity and not a second port: the row already carries the outcome, and its visibility record is the
 * same one every other message uses. A result is carried (priority 2) but never wakes an idle member by itself.
 */
function coordinationBinding(message, memberId) {
  const base = { ...messageBinding(message, memberId), generation: message.initiator?.generation ?? null,
    bindingEpoch: message.initiator?.bindingGeneration ?? 0 };
  return Object.freeze({ ...base, kind: 'coordination-result', priority: PRIORITY['coordination-result'],
    messageKind: 'coordination-result', summary: JSON.stringify(message.coordination).slice(0, 160) });
}

/**
 * Every durable input for one member, in the order the batch builder may consider it.
 *
 * A member with no row is UNKNOWN_MEMBER: an input list for nobody is not an empty list.
 */
export function coordinationExecutionMatches(read, message, memberId) {
  const init = message.initiator;
  if (init?.kind !== 'execution' || init.memberId !== memberId) return false;
  const attempt = read(init.attemptId);
  if (!attempt || attempt.owner !== memberId || attempt.lease !== 'active' || attempt.status !== 'running' ||
      attempt.generation !== init.generation || attempt.fence !== init.fence) return false;
  const E = read('execution-current:' + init.attemptId)?.E;
  return E ? Boolean(init.E && sameExecution(init.E, E)) : !init.E;
}

export function pendingInputs(core, memberId, binding = {}) {
  const store = core.store;
  const member = store.read(memberId);
  if (!member) failWith('UNKNOWN_MEMBER', 'there is no member row for ' + memberId);
  const generation = binding?.generation ?? member.generation ?? null;
  const bindings = [];
  const cutoffSeq = store.latestEventSeq(['manifest:', 'visibility-audit:', 'dispatch-cursor', 'wake-receipt:',
    'owner-input-receipt:', 'attempt-dispatch:', 'input-cursor:', 'batch-receipt:',
    'control-slot:', 'effect-io:', 'execution-outcome:', 'control-recovery', 'human-input:']);
  const commits = new Map();
  for (const event of store.scanEvents()) {
    if (event.seq > cutoffSeq) break;
    // The creation commit, not a source-local revision, orders independent sources.
    if (!commits.has(event.entity)) commits.set(event.entity, event.seq);
  }
  const add = item => {
    const commitSeq = commits.get(item.ref);
    if (Number.isSafeInteger(commitSeq) && commitSeq <= cutoffSeq) bindings.push(Object.freeze({ ...item, commitSeq }));
  };
  // 1. The addressed mailbox. core.pending() is the legacy facade and stays the only reader of that rule; the list
  //    below adds no eligibility of its own.
  for (const message of core.pending(memberId)) {
    if (message.kind === 'intent' ? message.visibility?.[memberId] : message.visible) continue;
    add(messageBinding(message, memberId, store));
  }
  // 2. A coordination result the initiator has not seen. In v1 the request row is the intent message addressed to
  //    root; the outcome is the same row after the decision, so the initiator reads it as one more input.
  for (const message of store.list('message:')) {
    if (!message.coordination || message.status === 'open') continue;
    const addressed = message.sender === memberId || message.initiator?.memberId === memberId;
    if (!addressed || message.visibility?.[memberId]) continue;
    if (message.initiator?.generation !== generation || !coordinationExecutionMatches(id => store.read(id), message, memberId)) continue;
    add(coordinationBinding(message, memberId));
  }
  // 3. Pending resource deliveries of this member's current generation and subscription epoch.
  for (const delivery of store.list(DELIVERY_PREFIX)) {
    if (delivery.memberId !== memberId || delivery.state !== 'pending') continue;
    if (generation !== null && delivery.generation !== generation) continue;
    const sub = store.read(subscriptionId(delivery.threadRef, memberId));
    if (!sub || sub.state !== 'active' || sub.generation !== generation ||
        sub.subscriptionEpoch !== delivery.subscriptionEpoch) continue;
    add(deliveryBinding(delivery, memberId));
  }
  return Object.freeze({ memberId, generation, cutoffSeq, bindings: Object.freeze(bindings),
    pendingCount: bindings.length });
}

/**
 * §5.3: deterministic order with one reserved slot, so a human/control flood cannot starve an old resource event.
 *
 * Within a class the order is the source sequence (commit order). The human-control, action/decision and result
 * classes keep their order strictly. The resource class is rotated by the batch counter, and when a human-control
 * input is present one resource input is promoted right after it: the oldest resource event always has a path into
 * some batch, no matter how long the human conversation runs.
 */
export function orderedInputs(bindings, { rotation = 0 } = {}) {
  const stable = list => [...list].sort((a, b) => (a.priority - b.priority) ||
    (a.commitSeq ?? 0) - (b.commitSeq ?? 0) || String(a.ref).localeCompare(String(b.ref)));
  const human = stable(bindings.filter(b => b.kind === 'human-control'));
  const rest = stable(bindings.filter(b => b.kind !== 'human-control'));
  const resources = rest.filter(b => b.kind === 'thread-delivery');
  const others = rest.filter(b => b.kind !== 'thread-delivery');
  const groups = new Map();
  for (const item of resources) {
    const key = item.threadRef ?? item.ref;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const queues = [...groups.values()];
  const offset = queues.length && Number.isSafeInteger(rotation) && rotation > 0 ? rotation % queues.length : 0;
  const rotated = [...queues.slice(offset), ...queues.slice(0, offset)].flat();
  if (human.length && rotated.length) {
    // The reserved slot: at most HUMAN_SLOTS human inputs lead the batch, then one resource input, then everything
    // else. The cap is what makes the guarantee real under a hard byte budget: without it a sustained human
    // conversation would fill every batch and the resource class would never be carried (§5.3).
    return Object.freeze([...human.slice(0, HUMAN_SLOTS), rotated[0], ...human.slice(HUMAN_SLOTS),
      ...others, ...rotated.slice(1)]);
  }
  return Object.freeze([...human, ...rotated.slice(0, 1), ...others, ...rotated.slice(1)]);
}

/** The public, hashable projection of one binding: what a manifest may state and provenance may rebuild. */
export function publicBinding(binding) {
  return Object.freeze({ kind: binding.kind, ref: binding.ref, revision: binding.revision ?? null,
    memberId: binding.memberId, generation: binding.generation ?? null, bindingEpoch: binding.bindingEpoch ?? 0,
    sourceSeq: binding.sourceSeq ?? null, bodyRef: binding.bodyRef ?? null, threadRef: binding.threadRef ?? null });
}

/** The ordered refs that are real messages (never a resource thread, never an event). */
export const messageRefsOf = bindings => bindings.filter(b => b.kind !== 'thread-delivery').map(b => b.ref);
