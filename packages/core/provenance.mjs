import { fail, failWith, hash } from '../contracts/index.mjs';
import { snapshot, bindManifest, batchCandidate, renderBatchText, payloadDigest } from './snapshot.mjs';
import { subscriptionId } from './thread-events.mjs';
import { pendingInputs, publicBinding, coordinationExecutionMatches } from './inputs.mjs';
import { batchItem } from './snapshot.mjs';
const canonical = payloadDigest; // Compare canonical payload identities without another cross-package deep import.

/**
 * Record the snapshot a host really injected, together with the manifest row that is the only accepted source of a
 * visible fact (invariant 8). bindManifest re-derives the payload hash, so a candidate that was edited in between is
 * refused here; every later visibility check compares against this row.
 */
/** The only injection metadata a caller may add; everything else is a provenance field the candidate must carry. */
const INJECTION_EXTRA = new Set(['generation', 'sessionSeq', 'requestedAt', 'note']);

export function recordInjection(core, candidate, nativeMessageId, sourceEventSeqs, extra = {}) {
  for (const key of Object.keys(extra)) {
    if (!INJECTION_EXTRA.has(key)) {
      failWith('INVALID_MANIFEST', 'injection metadata may not set ' + key + '; provenance fields come from the injected ' +
        'candidate, and only ' + [...INJECTION_EXTRA].join('/') + ' may be added');
    }
  }
  const manifest = bindManifest(candidate, nativeMessageId, sourceEventSeqs);
  core.mutate('manifest:' + manifest.hash, 'adapter', { manifest }, tx => {
    // The two hashes prove the text and the payload; bindManifest has already proved the text is what this payload
    // renders to. So the carrying relation is not checked item by item -- it is REBUILT from the payload and the
    // committed rows and must be reproduced exactly. Checking each binding against "some legal binding" is not enough:
    // the manifest of a snapshot built for member A could keep A's real text and relabel its owner and bindings as B's
    // (B is a genuine recipient of the same intent), and every item would still be true. Rebuilding makes the owner,
    // the carried set and the per-message generation a consequence of the injected document, not a claim beside it
    // (invariant 8 rule 4).
    const owner = candidate.payload?.self?.memberId ?? null;
    const carried = (candidate.payload?.detailRefs ?? []).slice();
    if (manifest.memberId !== owner) {
      failWith('INVALID_MANIFEST', 'the manifest belongs to ' + (manifest.memberId ?? 'nobody') +
        ' but the payload was built for ' + (owner ?? 'nobody'));
    }
    // A candidate that states the generation it was built for is bound to it here, inside this transaction, against the
    // member row itself. The generation recorded in the manifest is otherwise whatever the caller passed, and the
    // boundary's request.generation is compared with that same copy — a caller that echoes its own value back agrees
    // with itself by construction. Re-reading the row makes the recorded generation a fact the store holds, so a
    // candidate prepared for a generation the member has since left is refused before any manifest row exists
    // (D review #2). Injection ports that make no such claim (the preStep port) are unaffected.
    const declaredGeneration = candidate.generation;
    if (declaredGeneration !== undefined && declaredGeneration !== null) {
      const member = tx.read(owner);
      if (!member || member.generation !== declaredGeneration) {
        failWith('STALE_MESSAGE_BINDING', 'the candidate was built for ' + owner + ' at generation ' +
          JSON.stringify(declaredGeneration) + ' but the member row is at ' + (member?.generation ?? 'none'));
      }
    }
    if (JSON.stringify(carried) !== JSON.stringify(manifest.messageIds ?? [])) {
      failWith('INVALID_MANIFEST', 'the manifest carries ' + JSON.stringify(manifest.messageIds ?? []) +
        ' but the hashed payload names ' + JSON.stringify(carried));
    }
    const expected = carried.map(messageId => {
      const row = tx.read(messageId);
      if (!row) failWith('INVALID_MANIFEST', 'the payload names ' + messageId + ', which the store does not hold');
      const recipient = row.kind === 'intent' ? owner : row.recipient;
      if (recipient !== owner) {
        failWith('INVALID_MANIFEST', 'the snapshot of ' + owner + ' could not have carried ' + messageId +
          ', which is addressed to ' + recipient);
      }
      return { messageId, recipient: owner,
        generation: row.kind === 'intent' ? (row.generations?.[owner] ?? null) : (row.generation ?? null),
        bindingGeneration: row.kind === 'intent' ? (row.bindingGenerations?.[owner] ?? 0) : (row.bindingGeneration ?? 0) };
    });
    const bindings = manifest.messageBindings ?? [];
    const same = bindings.length === expected.length && expected.every((row, index) => {
      const got = bindings[index] ?? {};
      return got.messageId === row.messageId && got.recipient === row.recipient &&
        got.generation === row.generation && got.bindingGeneration === row.bindingGeneration;
    });
    if (!same) {
      failWith('INVALID_MANIFEST', 'the bindings this manifest claims are not the ones the payload and the rows produce: ' +
        JSON.stringify(bindings) + ' vs ' + JSON.stringify(expected));
    }
    return tx.put('manifest:' + manifest.hash, { ...manifest, snapshotRevision: manifest.revision,
      text: candidate.text, ...extra });
  });
  return manifest;
}

/** Register injected source via the unique writer port; 08 §4.4. */
export async function preStep(core, memberId, ports, previous = null, page = 0) {
  return ports.serialize(async () => {
    const candidate = snapshot(core, memberId, previous, page);
    if (!candidate) return null;
    // A withdrawn manifest is a tombstone, not a source: it must not stand in for an injection that never happened, so
    // the same candidate can be injected again (review 2 #7).
    const existing = core.store.read('manifest:' + candidate.manifest.hash);
    if (existing && existing.withdrawn !== true) return null;
    const source = await ports.inject(candidate.text);
    const manifest = recordInjection(core, candidate, source.messageId, source.sourceEventSeqs,
      { generation: source.generation });
    return { ...candidate, manifest };
  });
}

/**
 * Acknowledge visibility only at a generation-exact request boundary; 08 §4.4, host-protocol invariant 8.
 *
 * This is the M1b seam: the host hands over the payload of a request it really sent (requestId, sessionSeq, and the
 * instant the request started), and every message the manifest carried becomes visible for the recipient that
 * binding names. The reducer re-checks the manifest, the generation and the binding, so a fabricated hash or a stale
 * generation is refused there even if this caller forgets to. Injecting messages between steps stays M1b work.
 */
export function requestBoundary(core, manifestHash, request) {
  const manifest = core.store.read('manifest:' + manifestHash);
  if (!manifest || hash(manifest.text) !== manifestHash || request.generation !== manifest.generation) fail('MISSING_SOURCE');
  // The identity of a request is the boundary's own fact. Without a request id, a session sequence and the instant the
  // request started, nothing can be binned against a window's close, so the boundary refuses to record anything.
  if (!request.requestId || !Number.isInteger(request.sessionSeq) || !Number.isFinite(request.requestedAt)) {
    failWith('MISSING_REQUEST_EVIDENCE', 'a request boundary names requestId, sessionSeq and requestedAt; got ' +
      JSON.stringify({ requestId: request.requestId ?? null, sessionSeq: request.sessionSeq ?? null,
        requestedAt: request.requestedAt ?? null }));
  }
  for (const binding of manifest.messageBindings ?? []) {
    const message = core.store.read(binding.messageId);
    if (!message) fail('STALE_MESSAGE_BINDING');
    const generation = message.kind === 'intent' ? message.generations?.[binding.recipient] : message.generation;
    const bindingGeneration = message.kind === 'intent'
      ? (message.bindingGenerations?.[binding.recipient] ?? 0) : (message.bindingGeneration ?? 0);
    // ...and the member the manifest bound is still the one holding this row (invariant 8 rule 8, §4.4 class 4): two
    // old rows agreeing with each other proves nothing after a generation change.
    const member = core.store.read(binding.recipient);
    if (generation !== binding.generation || bindingGeneration !== binding.bindingGeneration ||
      !member || member.generation !== binding.generation) {
      failWith('STALE_MESSAGE_BINDING', 'manifest ' + manifestHash + ' carried ' + binding.messageId + ' for ' +
        binding.recipient + ' at generation ' + binding.generation + '; the row is at ' + generation + ' and the member ' +
        'is at ' + (member?.generation ?? 'none'));
    }
  }
  for (const binding of manifest.messageBindings ?? []) {
    core.visible(binding.messageId, { requestId: request.requestId, manifestHash, sessionSeq: request.sessionSeq,
      requestedAt: request.requestedAt }, binding.recipient);
  }
}

/** Return source-exact server records for fold planning; 08 §4.4. */
export function trustedManifests(core, nodes) {
  return core.store.list('manifest:').filter(manifest => nodes.some(node => node.messageId === manifest.messageId &&
    node.source === manifest.source && hash(node.text) === manifest.hash &&
    JSON.stringify(node.seqs) === JSON.stringify(manifest.sourceEventSeqs)))
    .map(manifest => ({ ...manifest, revision: manifest.snapshotRevision, accepted: manifest.messageIds.every(id => {
      const message = core.store.read(id);
      return message && (message.kind === 'info' || message.accepted);
    }) }));
}
/**
 * S3 (§5.1-§5.3): the typed validator and the batch boundary.
 *
 * Everything below is the v1 side of the same seam the single-message path already uses. The difference is that a
 * manifest now states a list of typed input bindings, so provenance must rebuild each one from the row it names —
 * recipient, generation, subscription epoch and revision — and only the items the payload really carried may enter
 * evidence. A thread ref never appears in messageIds: the two collections stay separate, on purpose.
 */

/** Rebuild one input binding from the row it names; every mismatch is a refusal, never a fallback. */
export function verifyInputBinding(read, binding, owner) {
  if (!binding || typeof binding.ref !== 'string' || typeof binding.kind !== 'string' || binding.memberId !== owner) {
    failWith('INVALID_MANIFEST', 'an input binding names a row, a kind and the member it was built for');
  }
  const member = read(owner);
  if (!member || member.generation !== binding.generation) fail('STALE_MESSAGE_BINDING');
  const row = read(binding.ref);
  if (!row) failWith('INVALID_MANIFEST', 'the batch names ' + binding.ref + ', which the store does not hold');
  if (binding.kind === 'thread-delivery') {
    if (row.memberId !== owner || row.generation !== binding.generation ||
        row.subscriptionEpoch !== binding.bindingEpoch || row.seq !== binding.revision) {
      failWith('STALE_MESSAGE_BINDING', 'delivery ' + binding.ref + ' is not the one this binding was prepared for');
    }
    const sub = read(subscriptionId(row.threadRef, owner));
    if (!sub || sub.state !== 'active' || sub.subscriptionEpoch !== binding.bindingEpoch ||
        sub.generation !== binding.generation || row.eventRef !== binding.bodyRef ||
        row.threadRef !== binding.threadRef || row.seq !== binding.sourceSeq) fail('STALE_MESSAGE_BINDING');
    return row;
  }
  if (!['message', 'human-control', 'coordination-result'].includes(binding.kind)) fail('INVALID_MANIFEST');
  if (binding.kind === 'coordination-result') {
    if (!coordinationExecutionMatches(read, row, owner) || !row.coordination || row.status === 'open' || row.initiator?.memberId !== owner ||
        row.initiator?.generation !== binding.generation || row.revision !== binding.revision) fail('STALE_MESSAGE_BINDING');
    return row;
  }
  const intent = row.kind === 'intent';
  const recipient = intent ? (row.recipients ?? []).includes(owner) : row.recipient === owner;
  if (!recipient) failWith('INVALID_MANIFEST', 'the batch of ' + owner + ' could not have carried ' + binding.ref);
  const generation = intent ? (row.generations?.[owner] ?? null) : (row.generation ?? null);
  const bindingEpoch = intent ? (row.bindingGenerations?.[owner] ?? 0) : (row.bindingGeneration ?? 0);
  if (generation !== binding.generation || bindingEpoch !== binding.bindingEpoch) {
    failWith('STALE_MESSAGE_BINDING', binding.ref + ' is bound at generation ' + generation + '/' + bindingEpoch +
      ', not ' + binding.generation + '/' + binding.bindingEpoch);
  }
  if (binding.revision !== null && binding.revision !== undefined && row.revision !== binding.revision) {
    failWith('STALE_MESSAGE_BINDING', binding.ref + ' moved from revision ' + binding.revision + ' to ' + row.revision);
  }
  if (binding.kind === 'coordination-result' && row.status === 'open') {
    failWith('INVALID_MANIFEST', 'a coordination result cannot be carried while its decision is still open');
  }
  return row;
}

/** The three hashes plus the two collections a v2 manifest must agree with its payload about. */
export function assertBatchCandidate(candidate, nativeMessageId, sourceEventSeqs) {
  if (!nativeMessageId || !sourceEventSeqs?.length) fail('INVALID_MANIFEST');
  if (hash(candidate.text) !== candidate.manifest.hash) fail('INVALID_MANIFEST');
  if (payloadDigest(candidate.payload) !== candidate.manifest.payloadHash) fail('INVALID_MANIFEST');
  if (renderBatchText(candidate.payload) !== candidate.text) fail('INVALID_MANIFEST:text-not-rendered-from-payload');
  if (candidate.payload?.batch?.version !== 2 || candidate.manifest.batch?.version !== 2) fail('INVALID_MANIFEST');
  const owner = candidate.payload?.self?.memberId ?? null;
  if (!owner || candidate.manifest.memberId !== owner) {
    failWith('INVALID_MANIFEST', 'the batch names ' + (candidate.manifest.memberId ?? 'nobody') +
      ' but the payload it carries was built for ' + (owner ?? 'nobody'));
  }
  const stated = (candidate.manifest.inputBindings ?? []).map(item => item.ref);
  if (JSON.stringify(stated) !== JSON.stringify(candidate.payload.detailRefs ?? [])) {
    failWith('INVALID_MANIFEST', 'the manifest states ' + JSON.stringify(stated) + ' but the payload names ' +
      JSON.stringify(candidate.payload.detailRefs ?? []));
  }
  const messageRefs = (candidate.manifest.inputBindings ?? []).filter(item => item.kind !== 'thread-delivery')
    .map(item => item.ref);
  if (JSON.stringify(candidate.manifest.messageIds ?? []) !== JSON.stringify(messageRefs)) {
    failWith('INVALID_MANIFEST', 'messageIds may only name real messages; a resource thread is an input binding, not a message');
  }
  const equal = (a, b) => canonical(a) === canonical(b);
  const expectedMessages = (candidate.manifest.inputBindings ?? []).filter(b => b.kind !== 'thread-delivery').map(b => ({
    messageId: b.ref, recipient: owner, generation: b.generation, bindingGeneration: b.bindingEpoch }));
  if (!equal(candidate.manifest.messageBindings, expectedMessages)) fail('INVALID_MANIFEST');
  if (!equal(candidate.manifest.inputBindings, candidate.payload.inputBindings) ||
      !equal(candidate.manifest.batch, candidate.payload.batch) ||
      !equal(candidate.batch, candidate.payload.batch) ||
      candidate.manifest.revision !== candidate.payload.batch.cutoffSeq ||
      candidate.payload.asOfSeq !== candidate.payload.batch.cutoffSeq ||
      !equal(candidate.manifest.detailRefs, candidate.payload.detailRefs) ||
      new Set(stated).size !== stated.length || candidate.payload.inputs?.length !== stated.length ||
      !equal(candidate.payload.inputs.map(item => item.ref), stated)) fail('INVALID_MANIFEST');
  return { ...candidate.manifest, messageId: nativeMessageId, sourceEventSeqs };
}

/** Record one batch: the manifest row is the only accepted source of a visible fact (invariant 8). */
export function recordBatchInjection(core, candidate, nativeMessageId, sourceEventSeqs, extra = {}) {
  for (const key of Object.keys(extra)) {
    if (!INJECTION_EXTRA.has(key)) {
      failWith('INVALID_MANIFEST', 'injection metadata may not set ' + key + '; provenance fields come from the injected candidate');
    }
  }
  const manifest = assertBatchCandidate(candidate, nativeMessageId, sourceEventSeqs);
  const prior = core.store.read('manifest:' + manifest.hash);
  if (prior && prior.withdrawn !== true) {
    if (prior.text !== candidate.text || prior.messageId !== nativeMessageId ||
        canonical(prior.sourceEventSeqs) !== canonical(sourceEventSeqs)) fail('INVALID_MANIFEST');
    return prior; // Another transmission of this same immutable native message, not another accept/injection.
  }
  core.mutate('manifest:' + manifest.hash, 'adapter', { manifest }, tx => {
    const eligible = pendingInputs(core, manifest.memberId).bindings;
    for (const [index, binding] of (manifest.inputBindings ?? []).entries()) {
      verifyInputBinding(id => tx.read(id), binding, manifest.memberId);
      const real = eligible.find(item => item.ref === binding.ref);
      const shown = candidate.payload.inputs[index];
      if (!real || real.commitSeq > manifest.batch.cutoffSeq || canonical(publicBinding(real)) !== canonical(binding) ||
          (canonical(batchItem(real)) !== canonical(shown) && canonical(batchItem({ ...real, summary: '' })) !== canonical(shown))) {
        fail('INVALID_MANIFEST');
      }
    }
    const declared = candidate.payload.batch.generation;
    if (extra.generation !== undefined && extra.generation !== declared) fail('STALE_MESSAGE_BINDING');
    if (declared !== undefined && declared !== null) {
      const member = tx.read(manifest.memberId);
      if (!member || member.generation !== declared) {
        failWith('STALE_MESSAGE_BINDING', 'the batch was built for ' + manifest.memberId + ' at generation ' +
          JSON.stringify(declared) + ' but the member row is at ' + (member?.generation ?? 'none'));
      }
    }
    return tx.put('manifest:' + manifest.hash, { ...manifest, snapshotRevision: manifest.revision,
      // The batch's own generation is the default binding; an injection port that declares one still wins.
      generation: candidate.batch?.generation ?? null,
      text: candidate.text, ...extra });
  });
  return manifest;
}

/**
 * Advance a subscription's visible watermark only over a contiguous prefix (§5.3).
 *
 * A visible or superseded delivery is terminal and may be crossed; the first pending one stops the walk, so a later
 * confirmation never steps over an earlier hole. This is the only place the watermark moves.
 */
export function advanceThreadWatermark(core, threadRef, memberId) {
  const id = subscriptionId(threadRef, memberId);
  const sub = core.store.read(id);
  if (!sub) return null;
  const rows = core.store.list('thread-delivery:' + threadRef + ':')
    .filter(row => row.memberId === memberId && row.subscriptionEpoch === sub.subscriptionEpoch)
    .sort((a, b) => a.seq - b.seq);
  let through = sub.visibleThrough ?? 0;
  for (const row of rows) {
    if (row.seq <= through) continue;
    if (!['visible', 'superseded'].includes(row.state) || row.seq !== Math.max(through, sub.startAfterSeq ?? 0) + 1) break;
    through = row.seq;
  }
  if (through === (sub.visibleThrough ?? 0)) return sub;
  return core.mutate(id, 'adapter', { visibleThrough: through }, tx => tx.put(id, { ...tx.read(id), visibleThrough: through }));
}

/**
 * Acknowledge a batch at a real request boundary.
 *
 * Only the items the manifest carried are considered; an item already terminal (visible, superseded, already in the
 * request) is skipped instead of accepted twice, which is what makes a retried transmission idempotent. Nothing is
 * guessed: the request identity is the boundary's own fact, and a missing one records nothing.
 */
export function requestBoundaryBatch(core, manifestHash, request) {
  const manifest = core.store.read('manifest:' + manifestHash);
  if (!manifest || manifest.withdrawn === true || hash(manifest.text ?? '') !== manifestHash ||
      request.generation !== manifest.generation) fail('MISSING_SOURCE');
  if (!request.requestId || !Number.isInteger(request.sessionSeq) || !Number.isFinite(request.requestedAt)) {
    failWith('MISSING_REQUEST_EVIDENCE', 'a request boundary names requestId, sessionSeq and requestedAt');
  }
  if (manifest.batch?.executionRef !== null && manifest.batch?.executionRef !== undefined &&
      request.executionRef !== manifest.batch.executionRef) fail('STALE_MESSAGE_BINDING');
  const owner = manifest.memberId;
  if (core.store.read(owner)?.generation !== manifest.generation) fail('STALE_MESSAGE_BINDING');
  if (request.accepted === false) fail('MISSING_REQUEST_EVIDENCE');
  // Validate the complete nonterminal set before the first write; a stale last item cannot partially consume a batch.
  for (const binding of manifest.inputBindings ?? []) {
    const row = core.store.read(binding.ref);
    if (binding.kind === 'thread-delivery' && row?.state === 'superseded') continue;
    if (binding.kind === 'thread-delivery' ? row?.state === 'visible' : row?.kind === 'intent' ? row.visibility?.[owner] : row?.visible) continue;
    verifyInputBinding(id => core.store.read(id), binding, owner);
  }
  const confirmed = [], skipped = [];
  for (const binding of manifest.inputBindings ?? []) {
    // A terminal item (visible, superseded, or already in this request) is skipped before the strict rebuild: its row
    // legitimately advanced when it became visible, and a retried transmission must not re-accept it.
    const current = core.store.read(binding.ref);
    if (!current) failWith('INVALID_MANIFEST', 'the batch names ' + binding.ref + ', which the store does not hold');
    const terminal = binding.kind === 'thread-delivery' ? ['visible', 'superseded'].includes(current.state)
      : (current.kind === 'intent' ? current.visibility?.[owner] : current.visible);
    if (terminal) { skipped.push(binding.ref); continue; }
    const row = verifyInputBinding(id => core.store.read(id), binding, owner);
    const evidence = { requestId: request.requestId, manifestHash, sessionSeq: request.sessionSeq, requestedAt: request.requestedAt };
    if (binding.kind === 'coordination-result') {
      core.mutate(binding.ref, 'adapter', evidence, tx => tx.put(binding.ref, { ...tx.read(binding.ref),
        visibility: { ...tx.read(binding.ref).visibility, [owner]: true }, resultEvidence: evidence }));
      confirmed.push(binding.ref);
      continue;
    }
    if (binding.kind === 'thread-delivery') {
      if (row.state !== 'pending') { skipped.push(binding.ref); continue; }
      core.mutate(binding.ref, 'adapter', evidence, tx => tx.put(binding.ref, { ...tx.read(binding.ref),
        state: 'visible', visibility: evidence }));
      confirmed.push(binding.ref);
      continue;
    }
    const intent = row.kind === 'intent';
    if (intent ? row.visibility?.[owner] : row.visible) { skipped.push(binding.ref); continue; }
    core.visible(binding.ref, evidence, owner);
    confirmed.push(binding.ref);
  }
  const threads = [...new Set((manifest.inputBindings ?? []).filter(item => item.kind === 'thread-delivery')
    .map(item => item.threadRef))];
  for (const threadRef of threads) advanceThreadWatermark(core, threadRef, owner);
  if (confirmed.length) core.mutate('input-cursor:' + owner, 'adapter', { manifestHash }, tx => {
    if (tx.read('batch-receipt:' + manifestHash)) return null;
    tx.put('batch-receipt:' + manifestHash, { memberId: owner, requestId: request.requestId });
    const cursor = tx.read('input-cursor:' + owner);
    return tx.put('input-cursor:' + owner, { rotation: (cursor?.rotation ?? 0) + 1 });
  });
  return { confirmed, skipped, manifestHash };
}

/** v1 pre-step: build the batch, inject it, record it; a withdrawn manifest is a tombstone, not a source. */
export async function batchPreStep(core, memberId, ports, { binding = {}, rotation = null, previous = null } = {}) {
  return ports.serialize(async () => {
    const candidate = batchCandidate(core, memberId, { binding, rotation, previous });
    if (!candidate) return null;
    const existing = core.store.read('manifest:' + candidate.manifest.hash);
    if (existing && existing.withdrawn !== true) return null;
    const source = await ports.inject(candidate.text);
    const manifest = recordBatchInjection(core, candidate, source.messageId, source.sourceEventSeqs,
      { generation: source.generation });
    return { ...candidate, manifest };
  });
}
