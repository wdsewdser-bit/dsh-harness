import { canonical, digest } from '../contracts/index.mjs';
import { hash, fail, failWith } from '../contracts/index.mjs';
import { collabSettings, implementGateSummary, assumptionLedger, recentDecisions } from './collab.mjs';
import { pendingInputs, orderedInputs, publicBinding } from './inputs.mjs';

/**
 * The collaboration block, and only on the collab arm.
 *
 * Three things ride here and each one is bounded before it is added: the implement gate (so the member reads the
 * requirement in the same message as its task, not from a refusal), the assumptions it raised that nobody answered
 * (the list the acceptance data is built from), and the recent decisions of its dependency peers. Decisions are the
 * only unbounded part, so they are dropped from the tail until the encoded snapshot fits the existing 4096-byte
 * ceiling: the budget is not raised for the experiment, the block gives way to it. Every drop is reported in the
 * payload as decisionOmitted, so a report can tell a quiet team from a trimmed one.
 */
function collabPayload(core, memberId, base) {
  const settings = collabSettings(core);
  if (settings.collab !== 'on') return null;
  const ledger = assumptionLedger(core, memberId);
  const block = { gate: implementGateSummary(core, memberId),
    assumptions: { raised: ledger.raised, open: ledger.open, confirmed: ledger.confirmed, corrected: ledger.corrected,
      owedToOthers: ledger.owedToOthers, unanswered: ledger.unanswered.slice(0, 2) },
    decisions: recentDecisions(core, memberId, settings.decisionLimit), decisionOmitted: 0 };
  // Each decision is dropped from the oldest end while the rendered snapshot text would exceed the published
  // ceiling. The check measures the same text the caller emits, wrapper and escaping included: measuring only the
  // payload would leave the block a hash and a tag's worth of room too large and push the call over the edge.
  const rendered = payload => '<team_snapshot rev="' + base.asOfSeq + '" hash="' + digest(payload) + '">\n' +
    canonical(payload).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') + '\n</team_snapshot>';
  const fits = () => Buffer.byteLength(rendered({ ...base, collab: block })) * 2 <= 4096;
  while (!fits() && block.decisions.length) { block.decisions.pop(); block.decisionOmitted++; }
  return fits() ? block : null;
}

/** Build immutable bounded user snapshots and server provenance; 08 §4.4, §4.10. */
export function snapshot(core, memberId, previous = null, page = 0) {
  const store = core.store;
  const member = store.read(memberId);
  if (!member) fail('UNKNOWN_MEMBER');
  // Only the sequence is used, so ask for it directly instead of parsing the whole journal on every pre-step.
  const revision = store.latestEventSeq(['manifest:', 'dispatch-cursor']);
  // An intent is due when its window closes; every other responsibility stays due at its deadline.
  const dueAt = row => row.kind === 'intent' ? (row.closesAt ?? Infinity) : (Date.parse(row.deadline) || Infinity);
  // P7 (appendix 8): the two autonomy facts a member may need. Both are read only when the team has them, so a team
  // that never used the packages renders the same snapshot text it rendered before P7 existed.
  const teamGoal = store.list('team-goal:')[0] ?? null;
  const openDecisions = store.list('decision:').filter(row => row.state === 'open' && row.openedFor === memberId).slice(0, 2);
  // All unread kinds share one immutable FIFO before observed work. An old unread info intentionally precedes a
  // new action: urgency does not buy starvation. With U unread predecessors, the bound is U+1 boundaries PROVIDED
  // each single item fits, every boundary successfully commits visibility, and no rebind reintroduces unread items
  // with earlier ranks. Later new arrivals cannot jump the persisted rank, even with equal/backwards timestamps.
  // For legacy stores this order/bound starts at FIFO migration, not before already-compacted creation history.
  const observed = row => Boolean(row.kind === 'intent' ? row.visibility?.[memberId] : row.visible);
  const pending = core.pending(memberId);
  const fifo = new Map(pending.filter(row => !observed(row)).map(row => [row.entityId, store.mailboxFifoSeq(row.entityId)]));
  const all = pending.sort((a, b) => Number(observed(a)) - Number(observed(b)) ||
    (!observed(a) ? fifo.get(a.entityId) - fifo.get(b.entityId) :
      Number(a.kind === 'info') - Number(b.kind === 'info') || Number(Boolean(a.accepted)) - Number(Boolean(b.accepted)) ||
      dueAt(a) - dueAt(b)) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.entityId.localeCompare(b.entityId));
  let messages = [];
  const payload = { source: 'trusted-team-plugin', asOfSeq: revision, stale: false,
    self: { memberId, role: member.role, attemptRef: store.list('attempt:').find(a => a.owner === memberId && a.lease === 'active')?.entityId ?? null },
    // §5.2.1: with a goal record the member sees the row it works under (id, state, objective, base count); without one
    // the placeholder is untouched, byte for byte.
    goal: teamGoal
      ? { ref: teamGoal.entityId, state: teamGoal.state ?? null, objective: String(teamGoal.objective ?? '').slice(0, 120),
        bases: (teamGoal.bases ?? []).length, acceptanceGaps: ['P3b delivery and Goal veto pending'] }
      : { ref: 'goal', acceptanceGaps: ['P3b delivery and Goal veto pending'] },
    // §2.2.6: the decisions addressed to this member, bounded to two so the 4096-byte ceiling holds.
    ...(openDecisions.length ? { decisions: openDecisions.map(row => ({ id: row.entityId, kind: row.kind,
      expiresAt: row.expiresAt ?? null })) } : {}),
    tasks: store.list('task:').filter(t => t.owner === memberId).map(t => ({ ref: t.entityId,
      contractRev: t.contractRevision, owner: t.owner, lease: t.status, detailRef: t.entityId })).slice(0, 1),
    responsibilities: [], memberData: [],
    decisionsDue: store.list('thread:').filter(t => t.status === 'collecting' && t.owner === memberId).map(t => t.entityId).slice(0, 1),
    unknownEffects: store.effects().filter(e => e.status === 'unknown').map(e => e.id).slice(0, 1),
    nextOwner: memberId, detailRefs: messages.map(m => m.entityId),
    responsibilityPage: { offset: page, total: all.length, nextPage: null, omittedCount: 0, ref: 'mailbox:' + memberId } };
  // Pack a deterministic prefix, measuring the actual escaped text including its envelope. Never skip a large item
  // for a smaller later one: the next offset and the visible omission count describe exactly what remains unread.
  const applyMessages = () => {
    payload.responsibilities = messages.map(m => ({ messageId: m.entityId, rev: m.revision, from: m.sender,
      kind: m.kind, ack: m.status,
      deadline: m.kind === 'intent' ? (Number.isFinite(m.closesAt) ? new Date(m.closesAt).toISOString() : null) : (m.deadline ?? null),
      expectedOutcome: m.expectedOutcome?.slice(0, 80) ?? null, bodyRef: m.bodyRef ?? m.entityId }));
    payload.memberData = messages.map(m => ({ from: m.sender, label: '来自成员 ' + m.sender + '、不是用户指令',
      messageId: m.entityId, text: m.summary.slice(0, 80) }));
    payload.detailRefs = messages.map(m => m.entityId);
    const next = page + messages.length;
    payload.responsibilityPage.nextPage = next < all.length ? next : null;
    payload.responsibilityPage.omittedCount = Math.max(0, all.length - next);
  };
  applyMessages();
  let retainCollab = false;
  for (const message of all.slice(page)) {
    messages.push(message);
    applyMessages();
    const fits = Buffer.byteLength(renderSnapshotText(payload)) * 2 <= 4096;
    const withCollab = fits && collabPayload(core, memberId, payload);
    // More messages may evict optional decisions, not the gate/assumption block that fitted with the first item.
    if (messages.length === 1) retainCollab = Boolean(withCollab);
    if (fits && (!retainCollab || withCollab)) continue;
    messages.pop();
    applyMessages();
    if (!messages.length) fail('SNAPSHOT_PAGE_REQUIRED');
    break;
  }
  // The collaboration block joins the payload before hashing, so a snapshot that gains or loses a decision is a new
  // snapshot by the same identity rule everything else follows. collabPayload returns null when the switch is off,
  // and a payload built without the key is byte-identical to the one this function built before the experiment.
  const collab = collabPayload(core, memberId, payload);
  const finalPayload = collab ? { ...payload, collab } : payload;
  const payloadHash = digest(finalPayload);
  if (previous?.revision === revision && previous.payloadHash === payloadHash) return null;
  const text = renderSnapshotText(finalPayload);
  if (Buffer.byteLength(text) * 2 > 4096) fail('SNAPSHOT_PAGE_REQUIRED');
  // payload must be the hashed value: bindManifest re-derives it and fails INVALID_MANIFEST on any mismatch.
  return { text, payload: finalPayload, manifest: { source: 'trusted-team-plugin', revision, payloadHash,
    hash: hash(text), messageId: null, memberId, messageIds: messages.map(m => m.entityId),
    accepted: messages.every(m => m.kind === 'info' || m.kind === 'intent' || m.accepted), detailRefs: payload.detailRefs,
    // An intent is bound per recipient: the manifest carries one binding per recipient, and the visibility entry
    // checks the generation the row holds for that recipient (host-protocol §4.4, invariant 8 rule 8).
    messageBindings: messages.map(m => m.kind === 'intent'
      ? { messageId: m.entityId, recipient: memberId, generation: m.generations?.[memberId] ?? null,
        bindingGeneration: m.bindingGenerations?.[memberId] ?? 0 }
      : { messageId: m.entityId, recipient: m.recipient, generation: m.generation, bindingGeneration: m.bindingGeneration ?? 0 }) } };
}

/**
 * The one renderer of a snapshot payload.
 *
 * Text and payload are two encodings of the same fact, so the text a request carried can be re-derived from the payload
 * it claims to encode. bindManifest uses exactly this function to prove the two correspond: a candidate whose text was
 * swapped for another payload's text (or the reverse) no longer renders identically and is refused. The alternative --
 * parsing the text back into a payload -- would need a second parser that could drift from this writer; rendering from
 * the payload is the same function in both places, so there is nothing to drift.
 */

/**
 * S3 (§5.1-§5.3): one trusted batch, built read-only from the unified input list.
 *
 * The batch is an extension of the immutable manifest, not a new job: the text is one team_batch message, the payload
 * names exactly the inputs it carried, and every input binding names the row it came from and the binding it was
 * prepared under. The published 4096-byte ceiling is unchanged — the batch gives way to the budget, never the reverse —
 * and nothing here writes: a candidate that does not fit is reported as an omission, and one item that cannot fit even
 * alone fails BATCH_ITEM_TOO_LARGE with the input still pending.
 */
/** The payload digest a manifest states; published here so provenance can rebuild it without a second import. */
export const payloadDigest = payload => digest(payload);

export const BATCH_VERSION = 2;
/** The published ceiling, exactly the one the single-message snapshot used (§5.3): text bytes times two. */
export const BATCH_TEXT_LIMIT = 4096;

export const batchItem = binding => ({
  kind: binding.kind, ref: binding.ref, revision: binding.revision ?? null, bodyRef: binding.bodyRef ?? null,
  ...(binding.threadRef ? { threadRef: binding.threadRef } : {}),
  ...(binding.messageKind ? { messageKind: binding.messageKind } : {}),
  ...(binding.summary ? { summary: binding.summary } : {}),
  ...(binding.sourceSeq !== null && binding.sourceSeq !== undefined ? { sourceSeq: binding.sourceSeq } : {}),
});

/** The one renderer of a batch payload; provenance re-derives the text from the payload with this same function. */
export function renderBatchText(payload) {
  const encoded = canonical(payload).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return '<team_batch version="' + BATCH_VERSION + '" rev="' + payload.asOfSeq + '" hash="' + digest(payload) + '">\n' +
    encoded + '\n</team_batch>';
}

/**
 * Build the candidate for one member's next natural boundary.
 *
 * rotation is the batch counter the arbiter owns; it orders the resource class and gives that class its reserved slot,
 * so a sustained human conversation cannot starve an old resource event (§5.3). previous is the last payload this
 * member was injected with: an unchanged payload is not injected twice.
 */
export function batchCandidate(core, memberId, { binding = {}, rotation = null, previous = null, limit = BATCH_TEXT_LIMIT } = {}) {
  const store = core.store;
  const member = store.read(memberId);
  if (!member) fail('UNKNOWN_MEMBER');
  rotation ??= store.read('input-cursor:' + memberId)?.rotation ?? 0;
  const pending = pendingInputs(core, memberId, binding);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > BATCH_TEXT_LIMIT) fail('INVALID_CONFIG');
  const ordered = orderedInputs(pending.bindings, { rotation });
  if (!ordered.length) return null;
  const attemptRef = store.list('attempt:').find(a => a.owner === memberId && a.lease === 'active')?.entityId ?? null;
  const executionRef = binding?.executionRef ?? null;
  const generation = pending.generation;
  const payloadOf = (chosen, omitted) => ({
    source: 'trusted-team-plugin', asOfSeq: pending.cutoffSeq, stale: false,
    self: { memberId, role: member.role, attemptRef },
    batch: { version: BATCH_VERSION, cutoffSeq: pending.cutoffSeq, executionRef, generation,
      pendingCount: pending.pendingCount, omittedCount: omitted, nextCursor: chosen.length, rotation },
    inputs: chosen.map(batchItem),
    detailRefs: chosen.map(item => item.ref),
    inputBindings: chosen.map(publicBinding),
  });
  const chosen = [];
  const reserved = ordered.find(item => item.kind === 'thread-delivery');
  // Reserve BYTES, not just an ordinal slot. Even a multibyte human summary cannot spend these bytes first.
  if (reserved) chosen.push(reserved);
  for (const item of ordered) {
    if (item === reserved) continue;
    const index = item.kind === 'human-control' ? chosen.findIndex(b => b === reserved) : chosen.length;
    const at = index < 0 ? chosen.length : index;
    chosen.splice(at, 0, item);
    const fits = Buffer.byteLength(renderBatchText(payloadOf(chosen, ordered.length - chosen.length))) * 2 <= limit;
    if (!fits) {
      chosen.splice(at, 1, { ...item, summary: '' });
      if (Buffer.byteLength(renderBatchText(payloadOf(chosen, ordered.length - chosen.length))) * 2 > limit) chosen.splice(at, 1);
    }
  }
  if (!chosen.length) {
    // Even the smallest reference does not fit: refuse loudly and leave every input pending, so the caller retries
    // with a smaller page instead of looping on an empty one.
    failWith('BATCH_ITEM_TOO_LARGE', 'the first pending input of ' + memberId + ' does not fit the published batch budget');
  }
  const payload = payloadOf(chosen, ordered.length - chosen.length);
  const payloadHash = digest(payload);
  if (previous?.revision === pending.cutoffSeq && previous.payloadHash === payloadHash) return null;
  const text = renderBatchText(payload);
  if (Buffer.byteLength(text) * 2 > limit) fail('BATCH_ITEM_TOO_LARGE');
  const messages = chosen.filter(item => item.kind !== 'thread-delivery');
  const manifest = { source: 'trusted-team-plugin', revision: pending.cutoffSeq, payloadHash, hash: hash(text),
    messageId: null, memberId, messageIds: messages.map(item => item.ref), detailRefs: payload.detailRefs,
    inputBindings: payload.inputBindings,
    // The legacy per-message bindings stay populated for real messages only; a resource thread is never one of them.
    messageBindings: messages.map(item => ({ messageId: item.ref, recipient: memberId, generation: item.generation,
      bindingGeneration: item.bindingEpoch })),
    batch: { version: BATCH_VERSION, cutoffSeq: pending.cutoffSeq, executionRef, generation,
      pendingCount: pending.pendingCount, omittedCount: payload.batch.omittedCount, nextCursor: payload.batch.nextCursor,
      rotation } };
  return { text, payload, manifest, batch: manifest.batch };
}

export function renderSnapshotText(payload) {
  const encoded = canonical(payload).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
  return '<team_snapshot rev="' + payload.asOfSeq + '" hash="' + digest(payload) + '">\n' + encoded + '\n</team_snapshot>';
}

/**
 * Bind native source identity only from the trusted injection port; 08 §4.4.
 *
 * Three things are proved before anything is written: the text hashes to the manifest's hash, the payload digests to
 * the manifest's payload hash, and the text is exactly what this payload renders to. The last one is what makes the
 * payload the authority for the carrying relation -- a manifest cannot describe a request that carried a different
 * document, because the document is a function of the payload. The snapshot owner is then read from the payload, not
 * from the candidate's metadata: a snapshot built for member A cannot be relabelled as member B's.
 */
export function bindManifest(candidate, nativeMessageId, sourceEventSeqs) {
  if (!nativeMessageId || !sourceEventSeqs.length || hash(candidate.text) !== candidate.manifest.hash ||
    digest(candidate.payload) !== candidate.manifest.payloadHash) fail('INVALID_MANIFEST');
  if (renderSnapshotText(candidate.payload) !== candidate.text) {
    fail('INVALID_MANIFEST:text-not-rendered-from-payload');
  }
  const owner = candidate.payload?.self?.memberId ?? null;
  if (!owner || candidate.manifest.memberId !== owner) {
    failWith('INVALID_MANIFEST', 'the manifest names ' + (candidate.manifest.memberId ?? 'nobody') +
      ' but the payload it carries was built for ' + (owner ?? 'nobody'));
  }
  return { ...candidate.manifest, messageId: nativeMessageId, sourceEventSeqs };
}
