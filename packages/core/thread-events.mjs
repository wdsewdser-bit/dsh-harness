import { fail, failWith, hash } from '../contracts/index.mjs';
import path from 'node:path';
import { normalizeScope } from './scopes.mjs';

/**
 * §3 of the super-agent borrow design: resource threads, thread events and the fan-out one transaction performs.
 *
 * A resource thread is a discriminated sibling of the decision thread in the SAME thread: id space, not a second
 * Topic system: the row carries kind 'resource' plus the resource identity, an event head and a retention watermark,
 * and everything else in the family (readiness, replies, decisions) refuses it with WRONG_THREAD_KIND. A legacy row
 * has no kind at all and remains a decision thread -- nothing here rewrites history to say otherwise.
 *
 * One writer: open, subscribe, unsubscribe, publish, close and the retention step are all reducers in this file, run
 * inside the caller's transaction. Allocating the next event sequence, writing the event, fanning it out to the
 * subscriptions that are active with a matching generation and writing the wake effects happen in that one
 * transaction, so 'subscribed just before publish' and 'published just before subscribe' are decided by commit order
 * and never by a check-then-listen window (design §3.1, §3.4).
 *
 * An event is an observation, never a write authorisation: nothing here touches a lease, a scope, a certificate or a
 * delivery verdict, and a subscription is not a response obligation (goal-gate only blocks on decision threads).
 */

/** The resource identities the first package accepts (§3.1). */
export const RESOURCE_KINDS = Object.freeze(['branch', 'pr', 'file-area']);

/**
 * §3.4: how many events one resource may keep that retention still cannot collect.
 *
 * It is a first-package default, not a measured fact: reaching it refuses the publish outright (no half event, no
 * sequence burned) instead of silently dropping a report. A deployment may tighten it, never widen it away.
 */
export const THREAD_EVENT_LIMIT = 1000;
// Includes closed resources: canonical identities and their evidence are retained, never silently reused.
export const THREAD_RESOURCE_LIMIT = 1000;

const RESOURCE_FIELDS = Object.freeze(['kind', 'repositoryKey', 'key']);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The member row's generation, or 1 for a row written before generations existed (the same default sendMessage uses). */
const generationOf = member => member?.generation ?? 1;

/**
 * Normalise one resource key (§3.1): a full branch ref, provider/repository/number, or a repository-relative path.
 *
 * A member cannot self-report an arbitrary repository path: the key is normalised here, and anything with a drive
 * letter, a UNC prefix, a leading slash, a backslash or a '..' segment is refused instead of being compared as text.
 * Directory overlap is not one resource -- two file-areas stay two subscriptions; only the exact normalised key is
 * the identity.
 */
function normalizeKey(kind, key) {
  const invalid = detail => failWith('INVALID_RESOURCE', detail);
  if (kind === 'branch') {
    if (typeof key !== 'string' || !key) invalid('a branch resource key is the full ref, e.g. refs/heads/main');
    if (!key.startsWith('refs/') || /\s/.test(key) || key.includes('..') || key.includes('//') || /[\\:]/.test(key)) {
      invalid('a branch key must be the full ref (refs/...) with no whitespace, backslash, colon or "..": ' + JSON.stringify(key));
    }
    return key;
  }
  if (kind === 'pr') {
    // One spelling only: the object the host reads off an authenticated remote. A free-form string would be a second
    // identity format for the same pull request, which is exactly what the canonical index cannot tolerate.
    if (!isPlainObject(key)) invalid('a pr key is {provider, repository, number}, e.g. {provider:"github",repository:"acme/app",number:7}');
    for (const field of Object.keys(key)) if (!['provider', 'repository', 'number'].includes(field)) {
      invalid('a pr key does not define ' + JSON.stringify(field));
    }
    const token = /^[A-Za-z0-9._-]{1,128}$/;
    // A repository is 'name' or 'owner/name': one optional slash, never a path.
    const repository = /^[A-Za-z0-9._-]{1,128}(?:\/[A-Za-z0-9._-]{1,128})?$/;
    if (typeof key.provider !== 'string' || !token.test(key.provider) ||
      typeof key.repository !== 'string' || !repository.test(key.repository)) {
      invalid('a pr key needs a provider and a repository (name or owner/name) of A-Z a-z 0-9 . _ - : ' + JSON.stringify(key));
    }
    if (!Number.isSafeInteger(key.number) || key.number < 1) invalid('a pr key needs a positive integer number: ' + JSON.stringify(key));
    return key.provider + '/' + key.repository + '#' + key.number;
  }
  if (kind === 'file-area') {
    if (typeof key !== 'string' || !key) invalid('a file-area key is a repository-relative path, e.g. src/team');
    const normalised = key.replace(/\\/g, '/');
    if (normalised !== key) invalid('a file-area key uses forward slashes only: ' + JSON.stringify(key));
    if (/^[A-Za-z]:/.test(key) || key.startsWith('//') || key.startsWith('/')) {
      invalid('a file-area key is relative to the repository, never absolute, a drive letter or a UNC path: ' + JSON.stringify(key));
    }
    const segments = key.split('/');
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..' ||
      /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
      invalid('a file-area key has no empty, "." or ".." segment: ' + JSON.stringify(key));
    }
    return segments.join('/');
  }
  return invalid('unknown resource kind ' + JSON.stringify(kind));
}

/**
 * Validate and canonicalise one resource identity (§3.1).
 *
 * repositoryKey must be one the team registered: the first package accepts only registered repositories and never
 * guesses an identity from a remote API, so a forged key is UNKNOWN_REPOSITORY instead of a thread nobody can find.
 */
export function canonicalResource(resource, command = {}) {
  if (!isPlainObject(resource)) failWith('INVALID_RESOURCE', 'a resource is {kind, repositoryKey, key}, got ' + JSON.stringify(resource ?? null));
  for (const field of Object.keys(resource)) if (!RESOURCE_FIELDS.includes(field)) {
    failWith('INVALID_RESOURCE', 'a resource does not define ' + JSON.stringify(field));
  }
  const repositories = Array.isArray(command?.repositories) ? command.repositories : [];
  const repositoryKey = resource.repositoryKey;
  if (typeof repositoryKey !== 'string' || !repositoryKey) {
    failWith('INVALID_RESOURCE', 'a resource names the registered repositoryKey it belongs to, got ' + JSON.stringify(repositoryKey ?? null));
  }
  const registration = repositories.find(entry => entry === repositoryKey || entry?.repositoryKey === repositoryKey);
  if (!registration) {
    failWith('UNKNOWN_REPOSITORY', 'repositoryKey ' + JSON.stringify(repositoryKey) + ' is not registered for this team (' +
      (repositories.length ? repositories.join(', ') : 'none registered') + '); a member cannot name an arbitrary repository');
  }
  let key = normalizeKey(resource.kind, resource.key);
  if (resource.kind === 'file-area') {
    // A lexical path check does not fence symlinks/junctions. Require the host's repository root.
    if (typeof registration?.root !== 'string' || !path.isAbsolute(registration.root)) {
      failWith('INVALID_RESOURCE', 'a file-area requires a host-registered absolute repository root');
    }
    try {
      const root = normalizeScope(registration.root);
      const resolved = normalizeScope(path.resolve(registration.root, key));
      if (resolved !== root && !resolved.startsWith(root + '/')) throw Error('outside repository');
      key = resolved === root ? '.' : resolved.slice(root.length + 1);
    } catch { failWith('INVALID_RESOURCE', 'file-area escapes or cannot be resolved under the registered repository'); }
  }
  return Object.freeze({ kind: resource.kind, repositoryKey, key });
}

/** The one index row per (team, resource): the same resource opens the same thread (§3.1, T02). */
export const resourceIndexId = resource => 'thread-resource:' + hash(JSON.stringify([resource.kind, resource.repositoryKey, resource.key])).slice(0, 32);

const subscriptionPrefix = threadRef => 'thread-subscription:' + threadRef + ':';
const eventPrefix = threadRef => 'thread-event:' + threadRef + ':';
const deliveryPrefix = threadRef => 'thread-delivery:' + threadRef + ':';
export const subscriptionId = (threadRef, memberId) => subscriptionPrefix(threadRef) + memberId;
export const eventId = (threadRef, seq) => eventPrefix(threadRef) + String(seq).padStart(6, '0');

/** A resource thread, or the refusal that says why this id is not one. */
function requireResourceThread(tx, threadRef) {
  const row = typeof threadRef === 'string' ? tx.read(threadRef) : null;
  if (!row) failWith('UNKNOWN_THREAD', 'no thread "' + String(threadRef) + '"; open one with thread.open-resource');
  if (row.kind !== 'resource') {
    failWith('WRONG_THREAD_KIND', threadRef + ' is a decision thread; resource events, subscriptions and close-resource ' +
      'belong to a thread opened with thread.open-resource (and thread.reply/decide do not apply to a resource)');
  }
  return row;
}

const actorIsRoot = (tx, actor) => tx.read(actor)?.role === 'root' && tx.read(actor)?.desired === 'active';
const activeMember = (tx, actor) => {
  const member = typeof actor === 'string' && actor.startsWith('member:') ? tx.read(actor) : null;
  if (!member || member.desired !== 'active') failWith('DENIED', 'resource commands require an active team member');
  return member;
};
function supersedePending(tx, threadRef, memberId, now) {
  for (const delivery of tx.list(deliveryPrefix(threadRef)).filter(row => row.threadRef === threadRef)) {
    if (delivery.memberId === memberId && delivery.state === 'pending') {
      tx.put(delivery.entityId, { ...delivery, state: 'superseded', supersededBy: 'subscription-rebind', supersededAt: now });
    }
  }
}

/**
 * Write one durable delivery and its wake effect (§3.2).
 *
 * The delivery id carries the epoch, so a second transmission of the same event to the same member under the same
 * subscription is one row and one effect -- never a new wake per retry -- while a re-subscription is a new epoch and
 * therefore a new audience. The wake key is the design's stable 'wake:<deliveryId>:<member>', not the epoch at large:
 * deduping on the epoch would make every event after the first one unwakeable.
 */
function writeDelivery(tx, threadRef, event, { memberId, generation, subscriptionEpoch }) {
  const deliveryId = deliveryPrefix(threadRef) + String(event.seq).padStart(6, '0') + ':' + memberId + ':' + subscriptionEpoch;
  if (tx.read(deliveryId)) return deliveryId;
  tx.put(deliveryId, { threadRef, eventRef: event.entityId ?? eventId(threadRef, event.seq), seq: event.seq, memberId, generation,
    subscriptionEpoch, state: 'pending', visibility: null });
  tx.outbox('wake:' + deliveryId + ':' + memberId, { kind: 'wake', deliveryId, threadRef, seq: event.seq,
    memberId, generation, subscriptionEpoch });
  return deliveryId;
}

/** thread.open-resource (§3.2): the owner is the caller unless root opens it for somebody it named. */
export function openResourceThread(tx, command) {
  const p = command.payload;
  activeMember(tx, command.actor);
  const resource = canonicalResource(p.resource, command);
  const indexId = resourceIndexId(resource);
  const known = tx.read(indexId);
  if (known) {
    const row = tx.read(known.threadRef);
    if (!row) failWith('MISSING_REFERENCE', 'the resource index names ' + known.threadRef + ', which does not exist');
    // The index already owns this identity: the call answers the same thread instead of opening a second one.
    return row;
  }
  if (tx.list('thread-resource:').length >= THREAD_RESOURCE_LIMIT) failWith('THREAD_BACKLOG_FULL', 'team resource identity limit reached; archive/export requires operator governance');
  const owner = p.owner ?? command.actor;
  activeMember(tx, owner);
  if (owner !== command.actor && !actorIsRoot(tx, command.actor)) {
    failWith('DENIED', 'only root may open a resource thread for ' + owner + '; open your own resources as yourself');
  }
  if (typeof p.descriptionRef !== 'string' || !p.descriptionRef) {
    failWith('MISSING_RESPONSIBILITY', 'a resource thread names the description it was opened from (descriptionRef)');
  }
  const threadRef = p.issueId;
  if (typeof threadRef !== 'string' || !threadRef.startsWith('thread:')) fail('INVALID_ENTITY');
  if (tx.read(threadRef)) {
    failWith('ID_CONFLICT', threadRef + ' already exists; a new resource thread needs a new operationId');
  }
  // acl names the members the shared reference check already lets touch this row: the owner, and every member that
  // subscribes. It is the fact authorize() reads (entity.acl), so subscribing someone is what makes the thread theirs to
  // report on -- nobody gains access to a resource conversation by naming its id.
  const row = tx.put(threadRef, { kind: 'resource', status: 'open', owner, acl: [owner], resource, eventSeq: 0,
    retainedFrom: 1, descriptionRef: p.descriptionRef, taskRef: p.taskRef ?? null, openedAt: command.now ?? Date.now() });
  tx.put(indexId, { threadRef });
  return row;
}

/**
 * thread.subscribe (§3.2): a subscription starts at the event head unless a replay is asked for explicitly.
 *
 * startAfterSeq is the head read inside THIS transaction, so 'subscribe then publish' and 'publish then subscribe'
 * are decided by commit order; a replay below the retention watermark is refused rather than answered with a gap.
 */
export function subscribeThread(tx, command) {
  const p = command.payload;
  const thread = requireResourceThread(tx, p.issueId);
  if (thread.status !== 'open') failWith('THREAD_CLOSED', p.issueId + ' is closed; a closed resource takes no new subscription');
  const memberId = p.memberId ?? command.actor;
  if (memberId !== command.actor && !actorIsRoot(tx, command.actor)) {
    failWith('DENIED', 'only root may subscribe another member; subscribe yourself as yourself');
  }
  activeMember(tx, command.actor);
  const member = activeMember(tx, memberId);
  if (member.desired === 'retired') failWith('DENIED', memberId + ' is retired and takes no subscription');
  const generation = generationOf(member);
  const id = subscriptionId(p.issueId, memberId);
  const existing = tx.read(id);
  const head = thread.eventSeq ?? 0;
  const retainedFrom = thread.retainedFrom ?? 1;
  const replay = p.replayFrom ?? null;
  if (replay !== null) {
    if (!Number.isSafeInteger(replay) || replay < 1) {
      failWith('THREAD_REPLAY_UNAVAILABLE', 'replayFrom is the first sequence number to replay (>= 1), got ' + JSON.stringify(p.replayFrom));
    }
    if (replay < retainedFrom) {
      failWith('THREAD_REPLAY_UNAVAILABLE', p.issueId + ' retains events from ' + retainedFrom + '; replay from ' + replay +
        ' would answer a history this thread no longer has');
    }
    if (replay > head + 1) {
      failWith('THREAD_REPLAY_UNAVAILABLE', p.issueId + ' has reached sequence ' + head + '; replay from ' + replay +
        ' is beyond its head');
    }
  }
  if (existing && existing.state === 'active' && existing.generation === generation && replay === null) {
    // The same subscription asked for twice is the same fact: no new epoch, no second fan-out.
    return existing;
  }
  // A re-subscription is a new audience: the epoch steps so old deliveries are never consumed by the new one.
  supersedePending(tx, p.issueId, memberId, command.now ?? Date.now());
  const subscriptionEpoch = (existing?.subscriptionEpoch ?? 0) + 1;
  const row = tx.put(id, { threadRef: p.issueId, memberId, generation, subscriptionEpoch, state: 'active',
    startAfterSeq: replay === null ? head : replay - 1, visibleThrough: 0,
    ...(memberId === command.actor ? {} : { by: command.actor }), subscribedAt: command.now ?? Date.now() });
  const acl = Array.isArray(thread.acl) ? thread.acl : [thread.owner];
  if (!acl.includes(memberId)) tx.put(p.issueId, { ...tx.read(p.issueId), acl: [...acl, memberId] });
  const delivered = [];
  if (replay !== null) {
    for (const event of tx.list(eventPrefix(p.issueId)).filter(row => row.threadRef === p.issueId).sort((a, b) => a.seq - b.seq)) {
      if (event.seq < replay) continue;
      delivered.push(writeDelivery(tx, p.issueId, event, { memberId, generation, subscriptionEpoch }));
    }
  }
  return { ...row, delivered };
}

/** thread.unsubscribe (§3.2): pending deliveries of that epoch become superseded, sent ones stay history. */
export function unsubscribeThread(tx, command) {
  const p = command.payload;
  requireResourceThread(tx, p.issueId);
  const memberId = p.memberId ?? command.actor;
  if (memberId !== command.actor && !actorIsRoot(tx, command.actor)) {
    failWith('DENIED', 'only root may end another member subscription');
  }
  if (typeof p.reason !== 'string' || !p.reason.trim()) {
    failWith('MISSING_RESPONSIBILITY', 'unsubscribing names a reason; an unexplained audience change is not an audit fact');
  }
  const id = subscriptionId(p.issueId, memberId);
  const sub = tx.read(id);
  if (!sub) failWith('UNKNOWN_SUBSCRIPTION', memberId + ' is not subscribed to ' + p.issueId);
  if (sub.state === 'closed') return sub;
  const now = command.now ?? Date.now();
  let superseded = 0;
  for (const delivery of tx.list(deliveryPrefix(p.issueId)).filter(row => row.threadRef === p.issueId)) {
    if (delivery.memberId !== memberId || delivery.subscriptionEpoch !== sub.subscriptionEpoch || delivery.state !== 'pending') continue;
    tx.put(delivery.entityId, { ...delivery, state: 'superseded', supersededBy: 'unsubscribe', supersededAt: now });
    superseded += 1;
  }
  return tx.put(id, { ...sub, state: 'closed', closedAt: now, reason: p.reason, closedBy: command.actor, superseded });
}

/**
 * thread.publish (§3.2): one event, its sequence, its audience and its wakes in one commit.
 *
 * Publishing needs no intent and no approval: a report is an observation, not a change of responsibility. It does
 * need a live subscription of the reporting member (the host evidence path is the one exception, and only the host
 * port may take it), so a member cannot inject events into a conversation it was not part of.
 */
export function publishThreadEvent(tx, command) {
  const p = command.payload;
  const thread = requireResourceThread(tx, p.issueId);

  const source = isPlainObject(p.source) ? { kind: p.source.kind, ref: p.source.ref ?? command.actor } : { kind: 'member-report', ref: command.actor };
  if (typeof p.eventType !== 'string' || !p.eventType.trim()) {
    failWith('MISSING_RESPONSIBILITY', 'an event names its eventType (e.g. conflict-observed, conflict-resolved, change-reported)');
  }
  if (typeof p.summary !== 'string' || !p.summary.trim()) {
    failWith('MISSING_RESPONSIBILITY', 'an event carries the summary a subscriber reads');
  }
  if (typeof p.operationId !== 'string' || !p.operationId) fail('INVALID_OPERATION_ID');
  if (source.kind === 'host-evidence' && (command.actor !== 'adapter' || command.hostEvidence !== true)) {
    failWith('DENIED', 'host-evidence requires the trusted adapter port');
  }
  if (source.kind === 'member-report' && source.ref !== command.actor) failWith('DENIED', 'a member report names its actual author');
  const payloadHash = hash(JSON.stringify([command.actor, p.eventType, p.summary, p.bodyRef ?? null, source, p.occurredAt ?? null]));
  const indexId = 'thread-publish:' + p.issueId + ':' + p.operationId;
  const prior = tx.read(indexId);
  if (prior) {
    // One operationId allocates one sequence. A different payload under the same id is a different report.
    if (prior.payloadHash !== payloadHash) fail('ID_CONFLICT');
    const event = tx.read(prior.eventRef);
    return { ...event, delivered: [] };
  }
  if (thread.status !== 'open') failWith('THREAD_CLOSED', p.issueId + ' is closed; a closed resource takes no new event');
  if (source.kind === 'host-evidence') {
    if (command.actor !== 'adapter' || command.hostEvidence !== true) {
      failWith('DENIED', 'host-evidence is written by the host port and by nothing else; a member reports member-report');
    }
  } else if (source.kind !== 'member-report') {
    failWith('INVALID_RESOURCE', 'an event source is member-report or host-evidence, got ' + JSON.stringify(source.kind));
  } else if (!tx.read(subscriptionId(p.issueId, command.actor)) ||
    tx.read(subscriptionId(p.issueId, command.actor)).state !== 'active' ||
    tx.read(subscriptionId(p.issueId, command.actor)).generation !== generationOf(tx.read(command.actor)) ||
    tx.read(command.actor)?.desired !== 'active') {
    failWith('NOT_SUBSCRIBED', command.actor + ' is not an active subscriber of ' + p.issueId + '; subscribe before reporting');
  }
  const retainedFrom = thread.retainedFrom ?? 1;
  const kept = tx.list(eventPrefix(p.issueId)).filter(row => row.threadRef === p.issueId).sort((a, b) => a.seq - b.seq).filter(event => event.seq >= retainedFrom).length;
  const limit = Number.isSafeInteger(command.threadEventLimit) && command.threadEventLimit > 0 ? Math.min(command.threadEventLimit, THREAD_EVENT_LIMIT) : THREAD_EVENT_LIMIT;
  if (kept >= limit) {
    // Refuse before a single write: a full backlog is back pressure, not a half event with a burned sequence.
    failWith('THREAD_BACKLOG_FULL', p.issueId + ' already holds ' + kept + ' events it cannot collect (limit ' + limit +
      '); collect the retained history or open a new resource before reporting again');
  }
  const now = command.now ?? Date.now();
  const seq = (thread.eventSeq ?? 0) + 1;
  const eventRef = eventId(p.issueId, seq);
  const event = { threadRef: p.issueId, seq, operationId: p.operationId, actor: command.actor, eventType: p.eventType,
    summary: String(p.summary).slice(0, 1024), bodyRef: p.bodyRef ?? null, source, occurredAt: p.occurredAt ?? now };
  tx.put(eventRef, event);
  tx.put(p.issueId, { ...thread, eventSeq: seq });
  const delivered = [];
  for (const sub of tx.list(subscriptionPrefix(p.issueId)).filter(row => row.threadRef === p.issueId)) {
    if (sub.state !== 'active') continue;
    const member = tx.read(sub.memberId);
    // A subscription belongs to a generation: a replaced member is not handed the events of the one it replaced.
    if (!member || member.desired !== 'active' || generationOf(member) !== sub.generation) continue;
    delivered.push(writeDelivery(tx, p.issueId, { ...event, entityId: eventRef },
      { memberId: sub.memberId, generation: sub.generation, subscriptionEpoch: sub.subscriptionEpoch }));
  }
  tx.put(indexId, { threadRef: p.issueId, seq, eventRef, payloadHash });
  return { ...event, entityId: eventRef, delivered };
}

/** thread.close-resource (§3.2): the owner or root stops new events and subscriptions; existing deliveries stay. */
export function closeResourceThread(tx, command) {
  const p = command.payload;
  const thread = requireResourceThread(tx, p.issueId);
  if (thread.status === 'closed') return thread;
  if (thread.owner !== command.actor && !actorIsRoot(tx, command.actor)) {
    failWith('DENIED', 'only the resource owner or root may close ' + p.issueId);
  }
  if (typeof p.reason !== 'string' || !p.reason.trim()) {
    failWith('MISSING_RESPONSIBILITY', 'closing a resource names a reason');
  }
  const now = command.now ?? Date.now();
  // Existing deliveries are kept until they are visible or explicitly superseded (§3.2, §3.4): closing the resource
  // does not silently retract what a member was already told.
  return tx.put(p.issueId, { ...thread, status: 'closed', closedAt: now, closedBy: command.actor, closeReason: p.reason });
}

/**
 * §3.4: which events retention may drop, and which are still reserved.
 *
 * An event stays reserved while a delivery of it is pending, or while a decision row names it (subject or evidence).
 * Everything else is collectable once the resource is closed -- an open resource keeps its history readable, which is
 * why the plan reports both sets instead of deleting anything here.
 */
export function threadRetention(tx, threadRef) {
  const thread = requireResourceThread(tx, threadRef);
  const retainedFrom = thread.retainedFrom ?? 1;
  const events = tx.list(eventPrefix(threadRef)).filter(row => row.threadRef === threadRef).sort((a, b) => a.seq - b.seq);
  const reserved = new Map();
  const reserve = (seq, reason) => { if (!reserved.has(seq)) reserved.set(seq, []); reserved.get(seq).push(reason); };
  for (const delivery of tx.list(deliveryPrefix(threadRef)).filter(row => row.threadRef === threadRef)) {
    if (delivery.state !== 'pending') continue;
    reserve(delivery.seq, 'pending delivery ' + delivery.entityId);
  }
  for (const decision of tx.list('decision:')) {
    const refs = [decision.subject?.id, decision.verdict?.evidenceRef, ...(decision.evidence ?? []).map(entry => entry?.ref)];
    for (const ref of refs) {
      if (typeof ref !== 'string' || !ref.startsWith(eventPrefix(threadRef))) continue;
      reserve(Number(ref.slice(eventPrefix(threadRef).length)), 'cited by ' + decision.entityId);
    }
  }
  const protectedSeqs = [...reserved.keys()].filter(seq => Number.isSafeInteger(seq)).sort((a, b) => a - b);
  const collectable = events.filter(event => event.seq >= retainedFrom && !reserved.has(event.seq)).map(event => event.seq);
  return Object.freeze({ threadRef, head: thread.eventSeq ?? 0, retainedFrom, status: thread.status,
    protected: Object.freeze(protectedSeqs), protectedReasons: Object.freeze(Object.fromEntries([...reserved.entries()].map(([seq, why]) => [seq, Object.freeze(why.slice())]))),
    collectable: Object.freeze(collectable) });
}

/**
 * thread.retain (§3.4): advance the retention watermark, never past an event something still reserves.
 *
 * The store has no delete in this package (P1 owns the domain, not the storage policy), so the step publishes the
 * watermark every later read and replay is judged against; the removal itself belongs to the retention package, which
 * must use this same plan. A step that would pass a reserved event is refused instead of quietly skipping it.
 */
export function retainThreadEvents(tx, command) {
  const p = command.payload;
  const thread = requireResourceThread(tx, p.issueId);
  if (thread.owner !== command.actor && !actorIsRoot(tx, command.actor)) failWith('DENIED', 'only owner/root may retain resource history');
  const plan = threadRetention(tx, p.issueId);
  const through = p.throughSeq;
  if (!Number.isSafeInteger(through) || through < 0 || through > (thread.eventSeq ?? 0)) {
    failWith('INVALID_RESOURCE', 'throughSeq is the last collected sequence (>= 0), got ' + JSON.stringify(p.throughSeq));
  }
  const firstReserved = plan.protected.find(seq => seq <= through);
  if (firstReserved !== undefined) {
    failWith('THREAD_RETENTION_BLOCKED', 'event ' + firstReserved + ' of ' + p.issueId + ' is still reserved (' +
      plan.protectedReasons[firstReserved].join('; ') + '); it cannot be collected');
  }
  if (through + 1 <= plan.retainedFrom) return { ...plan, advanced: false };
  const row = tx.put(p.issueId, { ...thread, retainedFrom: through + 1 });
  return { ...threadRetention(tx, p.issueId), retainedFrom: row.retainedFrom, advanced: true };
}

export function bridgeThreadEvidence(tx, command) {
  if (command.actor !== 'adapter') failWith('DENIED', 'only the host bridges durable evidence');
  const p = command.payload, thread = requireResourceThread(tx, p.issueId);
  const source = typeof p.sourceRef === 'string' && p.sourceRef.startsWith('delivery:') ? tx.read(p.sourceRef) : null;
  if (!source) failWith('MISSING_REFERENCE', 'the bridge requires an existing delivery fact');
  if (source.repositoryKey !== thread.resource.repositoryKey || !source.status) {
    failWith('INVALID_RESOURCE', 'the delivery must carry the same host-registered repository identity as the resource');
  }
  return publishThreadEvent(tx, { ...command, hostEvidence: true, payload: { issueId: p.issueId,
    operationId: 'host:' + source.entityId + ':' + source.revision,
    eventType: 'delivery-status', summary: source.entityId + ': ' + source.status, bodyRef: source.entityId,
    source: { kind: 'host-evidence', ref: source.entityId }, occurredAt: source.updatedAt } });
}

export const threadEventCommands = {
  'thread.bridge-evidence': bridgeThreadEvidence,
  'thread.open-resource': openResourceThread,
  'thread.subscribe': subscribeThread,
  'thread.unsubscribe': unsubscribeThread,
  'thread.publish': publishThreadEvent,
  'thread.close-resource': closeResourceThread,
  'thread.retain': retainThreadEvents,
};

/** The read side of §3.2: the resource identity plus each subscriber's head and pending count. */
export function resourceThreadView(store, threadRef, canReadMember = () => true) {
  const row = store.read(threadRef);
  if (!row || row.kind !== 'resource') return null;
  const subscriptions = store.list(subscriptionPrefix(threadRef)).filter(row => row.threadRef === threadRef).filter(sub => canReadMember(sub.memberId)).map(sub => ({
    memberId: sub.memberId, generation: sub.generation, subscriptionEpoch: sub.subscriptionEpoch, state: sub.state,
    startAfterSeq: sub.startAfterSeq, visibleThrough: sub.visibleThrough ?? 0,
    pending: store.list(deliveryPrefix(threadRef)).filter(row => row.threadRef === threadRef).filter(delivery => delivery.memberId === sub.memberId &&
      delivery.subscriptionEpoch === sub.subscriptionEpoch && delivery.state === 'pending').length,
  }));
  const events = store.list(eventPrefix(threadRef)).filter(row => row.threadRef === threadRef).sort((a, b) => a.seq - b.seq);
  const last = events[events.length - 1] ?? null;
  return { entityId: row.entityId, revision: row.revision, threadRef, kind: 'resource', status: row.status,
    owner: row.owner, resource: row.resource,
    head: row.eventSeq ?? 0, retainedFrom: row.retainedFrom ?? 1, descriptionRef: row.descriptionRef ?? null,
    subscribers: subscriptions, lastEvent: last ? { seq: last.seq, eventType: last.eventType,
      summary: String(last.summary ?? '').slice(0, 120), actor: last.actor, occurredAt: last.occurredAt ?? null } : null };
}

/** Paginated resource-event read (§3.2): by thread sequence, never by the database's global journal sequence. */
export function readThreadEvents(store, { threadRef, afterSeq = 0, limit = 20 } = {}) {
  const row = store.read(threadRef);
  if (!row) failWith('UNKNOWN_THREAD', 'no thread "' + String(threadRef) + '"');
  if (row.kind !== 'resource') failWith('WRONG_THREAD_KIND', threadRef + ' is a decision thread; it has replies, not thread events');
  if (!Number.isSafeInteger(afterSeq) || afterSeq < (row.retainedFrom ?? 1) - 1) {
    failWith('THREAD_REPLAY_UNAVAILABLE', 'the requested cursor precedes the retained resource history');
  }
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const events = store.list(eventPrefix(threadRef)).filter(row => row.threadRef === threadRef).sort((a, b) => a.seq - b.seq).filter(event => event.seq > (afterSeq ?? 0)).slice(0, size);
  return { threadRef, retainedFrom: row.retainedFrom ?? 1, head: row.eventSeq ?? 0,
    events, nextAfterSeq: events.length === size ? events[events.length - 1].seq : null };
}
