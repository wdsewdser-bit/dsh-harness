import { drain } from './effects/drain.mjs';
import { recordInjection, requestBoundary, recordBatchInjection, requestBoundaryBatch } from '../../core/index.mjs';
import { closeEffect } from './effects/protocol.mjs';
import { isDeepStrictEqual } from 'node:util';
import { reduceCommand, heartbeat } from '../../core/index.mjs';
import { id, failWith } from '../../contracts/index.mjs';

/**
 * The controlled write ports; M1b design §3.4, 3.5.
 *
 * Three routes, never one "the host is up" gate, and none of them substitutes for another:
 *
 *   lifecycle  the ordinary cycle: tick/reconcile, lease renewal, dispatch drain, visibility while running. A live
 *              lifecycle token of this epoch, an allowed host state, and the team lock. stop() revokes the token
 *              first, so cycle and dispatch work stops immediately.
 *   managed    the receipt of one registered operation: the managed in-flight token itself (operation four-way
 *              binding, same epoch, drain barrier). It deliberately does NOT check the lifecycle token - revoking it
 *              before the drain is exactly what makes "settle inside the drain budget" possible. It can only close
 *              the operation it was opened for: no claim, and the call's own target and actor are compared with the
 *              token, not with a facts object captured when the port was built.
 *   safety     the frozen-period close-out, minted for one cause and one exact subject. Every call re-checks
 *              revocation, epoch, host state, expiry and the exact subject ids; the command, entity and field
 *              whitelists are enforced on the transaction the reducer receives, never merely recorded.
 *   recovery   system.recover: recovering only, with explicit entity and field whitelists. An empty whitelist denies
 *              everything; it never means "all".
 */
export const ACCESS_ROUTES = Object.freeze(['lifecycle', 'managed', 'safety', 'recovery']);

const MANAGED_FACTS = Object.freeze(['operationId', 'command', 'entityId', 'actor']);

/** One whitelist rule: an exact id, or a trailing '*' that makes it a prefix. Substring matching is never used. */
function matches(value, rule) {
  if (typeof rule !== 'string' || !rule) return false;
  return rule.endsWith('*') ? value.startsWith(rule.slice(0, -1)) : value === rule;
}

function matchesAny(value, rules) {
  for (const rule of rules) if (matches(value, rule)) return true;
  return false;
}

function requireStrings(value, what) {
  if (!Array.isArray(value)) failWith('INVALID_ACCESS', what + ' must be an array of strings');
  for (const item of value) {
    if (typeof item !== 'string' || !item) {
      failWith('INVALID_ACCESS', what + ' must contain non-empty strings, got ' + JSON.stringify(item));
    }
  }
  return [...value];
}

function requireFieldRules(fields, what) {
  if (fields === null || fields === undefined) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    failWith('INVALID_ACCESS', what + ' must be an object of rule -> field names');
  }
  const out = {};
  for (const [rule, names] of Object.entries(fields)) {
    if (typeof rule !== 'string' || !rule) failWith('INVALID_ACCESS', what + ' has an empty rule');
    out[rule] = requireStrings(names, what + '[' + JSON.stringify(rule) + ']');
  }
  return out;
}

/**
 * The transaction a whitelisted reducer actually receives.
 *
 * This is where the whitelist is enforced, not at the call site: the reducer cannot reach the raw tx, so a recovery
 * or safety reducer that writes some other row, or some other field, fails inside the transaction and the commit
 * rolls back. There is no channel through which it could widen what it was granted.
 */
export function createRestrictedTx(tx, { entities = [], fields = {}, outboxKinds = [], effectIds = entities, subjectAttempt = null } = {}) {
  const entityRules = requireStrings(entities, 'entities');
  const fieldRules = requireFieldRules(fields, 'fields');
  const kinds = requireStrings(outboxKinds, 'outboxKinds');
  const effects = requireStrings(effectIds, 'effectIds');
  const checkEntity = id => {
    if (entityRules.length === 0) failWith('DENIED', 'an empty entity whitelist rejects every write');
    if (!matchesAny(id, entityRules)) failWith('DENIED', JSON.stringify(id) + ' is outside the entity whitelist of this route');
  };
  const fieldsFor = id => {
    let allowed = null;
    for (const [rule, names] of Object.entries(fieldRules)) {
      if (!matches(id, rule)) continue;
      allowed = allowed === null ? new Set(names) : new Set([...allowed, ...names]);
    }
    return allowed;
  };
  return Object.freeze({
    read: id => tx.read(id),
    list: prefix => tx.list(prefix),
    latestEventSeq: exclude => (typeof tx.latestEventSeq === 'function' ? tx.latestEventSeq(exclude) : 0),
    put(id, data) {
      checkEntity(id);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        failWith('DENIED', 'a whitelisted write needs an object body');
      }
      // Snapshot once: getters cannot change an authorized value between validation and the write.
      data = structuredClone(data);
      const allowed = fieldsFor(id);
      if (allowed === null || allowed.size === 0) failWith('DENIED', 'no field whitelist covers ' + JSON.stringify(id));
      // Restricted PATCH: omitted keys are preserved, never deleted by store replacement.
      // 授权字段写 undefined 会被 store 的 canonical 序列化拒绝，不是删除语义。
      const prior = tx.read(id) ?? {};
      for (const key of Object.keys(data)) {
        if (!allowed.has(key) && !isDeepStrictEqual(data[key], prior[key])) {
          failWith('DENIED', 'field ' + JSON.stringify(key) + ' may not be written on ' + JSON.stringify(id));
        }
      }
      return tx.put(id, { ...prior, ...data });
    },
    outbox(id, payload) {
      payload = payload && structuredClone(payload);
      const kind = payload && typeof payload === 'object' ? payload.kind : null;
      if (!kinds.includes(kind) || !['cancel', 'release-task'].includes(kind)) {
        failWith('DENIED', 'this route may only emit whitelisted close-out effects');
      }
      if (!matchesAny(id, effects) || typeof payload.attemptId !== 'string' || !payload.attemptId.startsWith('attempt:') ||
        (subjectAttempt ? payload.attemptId !== subjectAttempt : !matchesAny(payload.attemptId, entityRules))) {
        failWith('DENIED', 'effect id and payload must belong to the subject');
      }
      const attempt = tx.read(payload.attemptId);
      const payloadFields = kind === 'cancel' ? ['kind', 'attemptId', 'owner', 'fence'] :
        ['kind', 'attemptId', 'taskId', 'status', 'reason', 'evidenceRef'];
      if (!attempt || Object.keys(payload).some(key => !payloadFields.includes(key)) ||
        ('owner' in payload && payload.owner !== attempt.owner) ||
        ('fence' in payload && payload.fence !== attempt.fence)) {
        failWith('DENIED', 'effect payload must retain its subject associations');
      }
      if (kind === 'release-task') {
        checkEntity(payload.taskId);
        if (payload.taskId !== attempt.taskId || !['failed', 'cancelled'].includes(payload.status)) {
          failWith('DENIED', 'release-task must close only its bound task');
        }
      }
      if (id.startsWith('recover-cancel:')) {
        if (!attempt || id !== 'recover-cancel:' + payload.attemptId + ':' + attempt.fence) {
          failWith('DENIED', 'recovery cancel must bind the subject fence');
        }
      }
      return tx.outbox(id, { ...payload });
    },
    inbox() {
      failWith('DENIED', 'this route may not write an inbox row');
    },
    cursor() {
      failWith('DENIED', 'this route may not write a cursor');
    },
  });
}

export function createCoreAccess({ core = null, teamId, epoch = () => null, state = () => 'created', token = () => null,
  ownership = () => false, failure = () => null, inflight = null, drainWritable = () => true, now = Date.now } = {}) {
  if (typeof teamId !== 'string' || !teamId) failWith('INVALID_TEAM', 'core access needs a non-empty teamId');
  if (typeof now !== 'function') failWith('INVALID_ACCESS', 'core access needs a now() function');

  const requireCore = () => {
    if (!core || typeof core.mutate !== 'function') {
      failWith('CORE_NOT_ATTACHED', 'the controlled write port needs a core exposing mutate(entityId, actor, payload, reducer)');
    }
    return core;
  };
  const requireStore = what => {
    const store = requireCore().store;
    if (!store || typeof store[what] !== 'function') failWith('CORE_NOT_ATTACHED', what + ' needs a store port');
    return store;
  };
  const execute = (entityId, actor, payload, reduce, meta = {}) => requireCore().mutate(entityId, actor, payload, reduce, meta);
  const dispatchThrough = (entityId, actor, payload, command) => {
    if (command.type === 'delivery.transition' && (!Number.isSafeInteger(command.payload?.revision) || command.payload.revision < 1)) failWith('INVALID_REVISION', 'delivery.transition requires the captured revision');
    return requireCore().dispatch(entityId, actor, payload, command);
  };
  /** A domain command for the internal (non-gateway) writers; the operation id is internal, never a request id. */
  const commandFor = (entityId, actor, payload, operationId = id('operation')) => {
    requireCore();
    if (typeof core.command === 'function') return core.command(entityId, actor, payload, operationId);
    return { entityId, actor, payload, operationId, expectedRevision: 0, payloadHash: '' };
  };
  const assertOwnership = () => {
    if (!ownership()) failWith('OWNERSHIP_LOST', 'the host no longer holds the team lock');
  };

  /**
   * R10: the completion fence of every ordinary scheduling write. A prepared/authorized/unknown completion freezes new
   * work, so it must stop the claim AND the deferral that would otherwise keep rewriting nextDue, defers and evidence
   * underneath it. One rule, shared by both, so a new ordinary write cannot acquire its own weaker copy.
   */
  const assertNoPendingCompletion = (store, what) => {
    if (store.list('completion:').some(t => ['prepared', 'authorized', 'unknown'].includes(t.status))) {
      failWith('COMPLETION_FROZEN', what + ' cannot cross the completion fence');
    }
  };

  const assertLifecycle = (allowedStates) => {
    const failed = failure();
    if (failed) failWith('WRITE_REVOKED', 'the host failed to start (' + failed.code + ') and takes no writes until stop()');
    const current = token();
    if (!current) failWith('WRITE_REVOKED', 'no lifecycle token: the host has not started');
    if (current.revoked) {
      failWith('WRITE_REVOKED', 'the lifecycle token was revoked' + (current.reason ? ': ' + current.reason : ''));
    }
    if (current.epoch !== epoch()) {
      failWith('STALE_EPOCH', 'the lifecycle token belongs to epoch ' + current.epoch + ', the host is at ' + String(epoch()));
    }
    const hostState = state();
    if (!allowedStates.includes(hostState)) failWith('WRITE_REVOKED', 'this write is closed while the host is ' + hostState);
    assertOwnership();
  };

  /** The managed receipt: the token must be live, current, and identical to the target and actor of this call. */
  const assertManaged = (candidate, facts, target, actor) => {
    const hostState = state();
    if (!drainWritable() || hostState === 'stopped' || hostState === 'isolated') {
      failWith('WRITE_REVOKED', 'managed receipts are closed while the host is ' + hostState);
    }
    if (!['running', 'stopping'].includes(hostState)) failWith('HOST_NOT_RUNNING', 'managed receipts need a running host, got ' + hostState);
    if (!inflight) failWith('INFLIGHT_UNKNOWN', 'this host keeps no managed operations');
    if (!candidate || !inflight.has(candidate)) failWith('INFLIGHT_UNKNOWN', 'the receipt does not match a managed in-flight token');
    if (candidate.epoch !== epoch()) {
      failWith('STALE_EPOCH', 'the in-flight token belongs to epoch ' + candidate.epoch + ', the host is at ' + String(epoch()));
    }
    // The binding is compared with the call, never with a snapshot of facts taken when the port was built: a token
    // opened for one operation cannot be re-pointed at another by calling with different arguments.
    if (target !== candidate.entityId) {
      failWith('MANAGED_MISMATCH', 'this token closes ' + JSON.stringify(candidate.entityId) + ', not ' + JSON.stringify(target));
    }
    if (actor !== candidate.actor) {
      failWith('MANAGED_MISMATCH', 'this token was opened by ' + JSON.stringify(candidate.actor) + ', not ' + JSON.stringify(actor));
    }
    for (const key of MANAGED_FACTS) {
      if (facts[key] !== undefined && facts[key] !== candidate[key]) {
        failWith('MANAGED_MISMATCH', 'this token is bound to ' + key + '=' + String(candidate[key]) + ', not ' + String(facts[key]));
      }
    }
    assertOwnership();
  };

  /** The command a call claims to close; a receipt never carries a different command than its token. */
  const namedCommand = (payload, explicit = null) => {
    if (typeof explicit === 'string' && explicit) return explicit;
    if (payload && typeof payload === 'object' && typeof payload.command === 'string' && payload.command) return payload.command;
    return null;
  };

  // Authorization is closure-private provenance, never a caller-selected bypass argument.
  const registerEffect = (effectId, fence, authorization = null) => {
        const store = requireStore('effects');
        const effect = store.effects().find(e => e.id === effectId);
        if (!effect || effect.status !== 'applying' || effect.fence !== fence) failWith('STALE_FENCE', 'claim must precede registration');
        if (!inflight) failWith('INFLIGHT_UNKNOWN', 'runner requires a host ledger');
        const p = effect.payload;
        const ids = [p.memberId, p.attemptId, p.intentId, p.deliveryId, p.taskId].filter(Boolean);
        const registration = { effectId, fence, epoch: epoch(), owner: effect.owner,
          revisions: ids.map(id => [id, store.read(id)?.revision ?? 0]) };
        const operationId = id('operation');
        store.commit(commandFor('effect-ledger:' + effectId, 'scheduler', { effectId }), tx => tx.put('effect-ledger:' + effectId, registration));
        const managed = inflight.open({ label: 'effect', epoch: epoch(), operationId, command: 'effect.settle', entityId: effectId, actor: 'adapter', now });
        return Object.freeze({ close: managed.close, assertDispatch() {
          if (authorization) authorization.assertDispatch(effectId);
          else assertLifecycle(['running']);
          assertManaged(managed.token, {}, effectId, 'adapter');
          const current = store.effects().find(e => e.id === effectId);
          if (!current || current.status !== 'applying' || current.fence !== fence || current.owner !== registration.owner) failWith('STALE_FENCE', 'claim no longer authorizes IO');
          if (!authorization && store.list('completion:').some(t => ['prepared', 'authorized', 'unknown'].includes(t.status))) failWith('COMPLETION_FROZEN', 'new IO is forbidden');
          for (const [id, revision] of registration.revisions) if ((store.read(id)?.revision ?? 0) !== revision) failWith('STALE_EFFECT_SUBJECT', 'subject changed before IO');
          if (p.kind === 'start') {
            const a = requireCore().authority(p.attemptId, p.fence, now());
            if (a.generation !== p.generation) failWith('STALE_EFFECT_SUBJECT', 'start generation changed');
            const task = store.read(a.taskId);
            if (!task || task.status !== 'executing' || task.attemptId !== a.entityId || task.lastFence !== a.fence) failWith('STALE_EFFECT_SUBJECT', 'start task binding changed');
          }
          if (p.kind === 'cancel') {
            const a = store.read(p.attemptId);
            if (!a || a.lease !== 'unknown') failWith('INVALID_LEASE', 'cancel no longer belongs to an unknown execution');
          }
          if (['create', 'resume', 'dispose', 'cancel-member'].includes(p.kind)) {
            const m = store.read(p.memberId);
            if (!m || m.generation !== p.generation) failWith('STALE_EFFECT_SUBJECT', 'member generation changed');
          }
          return true;
        }, complete(evidence) {
          if (authorization) authorization.assertComplete(effectId);
          assertManaged(managed.token, {}, effectId, 'adapter');
          // P5 §7.2.5: the close-out needs the switch, and only the composition knows it. It is read here, from the core
          // the settlement already belongs to -- never from a command payload, which a request could reach.
          let stop = { autonomy: false, decisionTtlMs: 900000 };
          try {
            const settings = requireCore().configuration ?? {};
            stop = { autonomy: settings.autonomy === 'on',
              decisionTtlMs: Number.isSafeInteger(settings.decisionTtlMs) ? settings.decisionTtlMs : 900000 };
          } catch { stop = { autonomy: false, decisionTtlMs: 900000 }; }
          return store.settle(commandFor('effect:' + effectId, 'adapter', { effectId }, operationId), effectId, fence, evidence,
            (tx, current) => closeEffect(tx, current, evidence, registration, stop), now());
        } });
  };

  const lifecycle = ({ states = ['running'] } = {}) => {
    const allowed = Array.isArray(states) && states.length ? requireStrings(states, 'states') : ['running'];
    const wrap = fn => (...args) => {
      assertLifecycle(allowed);
      return fn(...args);
    };
    return Object.freeze({
      route: 'lifecycle',
      visibility: wrap((candidate, messageId, seqs, generation, request) => {
        const attached = requireCore();
        if (candidate.manifest.batch?.version === 2) {
          recordBatchInjection(attached, candidate, messageId, seqs, { generation });
          return requestBoundaryBatch(attached, candidate.manifest.hash, { ...request, generation });
        }
        recordInjection(attached, candidate, messageId, seqs, { generation });
        return requestBoundary(attached, candidate.manifest.hash, { ...request, generation });
      }),
      effects: wrap(() => requireStore('effects').effects()),
      prepareLifecycle: wrap(() => {
        const core = requireCore(); let dispatched = 0;
        for (const intent of core.store.list('member-intent:')) {
          if (intent.status !== 'intent') continue;
          const memberId = intent.memberRef ?? 'member:' + intent.operationId;
          if (intent.op === 'request' && !core.store.read(memberId)) core.member(memberId, intent.role);
          const member = core.store.read(memberId);
          if (!member) continue;
          const kind = intent.op === 'request' ? 'create' : intent.op === 'retire' ? 'dispose' : intent.op === 'freeze' ? 'cancel-member' : 'resume';
          core.mutate(intent.entityId, 'scheduler', { dispatch: true }, tx => {
            const current = tx.read(intent.entityId);
            if (current.status !== 'intent') return null;
            tx.outbox('lifecycle:' + intent.entityId, { kind, memberId, generation: member.generation, intentId: intent.entityId });
            tx.put(intent.entityId, { ...current, status: 'applying' });
            tx.put(memberId, { ...member, status: kind + '-pending' });
            return null;
          });
          dispatched++;
        }
        return { dispatched };
      }),
      /**
       * R11: the ordinary registration is itself a write. It commits effect-ledger:<id> and opens a managed in-flight
       * token before assertDispatch ever runs, so the completion fence must hold here and not only there. The check
       * belongs on this wrapper, never inside the shared registerEffect(): the safety capability registers the
       * frozen-period cancel through that same function and must still be allowed to write.
       */
      registerEffect: wrap((effectId, fence) => {
        assertNoPendingCompletion(requireStore('effects'), 'ordinary effect registrations');
        return registerEffect(effectId, fence);
      }),
      isDue: wrap((at = now()) => requireCore().isDue(at)),
      drain: wrap((at = now()) => drain(requireCore(), at)),
      heartbeat: wrap((attemptId, fence, expectedEpoch, at = now()) => {
        if (expectedEpoch !== epoch()) failWith('STALE_EPOCH', 'heartbeat belongs to an old host');
        return heartbeat(requireCore(), attemptId, fence, at);
      }),
      mutate: wrap((entityId, actor, payload, reducer) => execute(entityId, actor, payload, reducer)),
      dispatch: wrap((entityId, actor, payload, command) => dispatchThrough(entityId, actor, payload, command)),
      /** tick(now): the scheduled domain clock; only the ordinary cycle may call it. */
      tick: wrap((at = now()) => requireCore().tick(at)),
      reconcile: wrap((at = now()) => requireStore('reconcile').reconcile(commandFor('scheduler', 'scheduler', {}), at)),
      claim: wrap((effectId, owner, ttl = 60000, claimIndex = null) => {
        const store = requireStore('claim');
        assertNoPendingCompletion(store, 'ordinary claims');
        return store.claim(commandFor('effect:' + effectId, 'scheduler', { effectId, owner }), effectId, owner, now(), ttl,
          typeof claimIndex === 'function' ? claimIndex : null);
      }),
      /**
       * R9: defer(effectId) - a due effect whose member cannot run it yet (a maintenance phase). Lifecycle-wrapped like
       * every ordinary write: it needs the token, the host state and the team lock, takes no claim and spends no try,
       * and the ledger - not the caller - owns the delay.
       */
      defer: wrap(effectId => {
        const store = requireStore('defer');
        // R10: a deferral is an ordinary scheduling write, not a frozen-period exemption. The same pending completion
        // that stops a claim stops the write that would move nextDue/defers/evidence underneath it.
        assertNoPendingCompletion(store, 'ordinary deferrals');
        return store.defer(commandFor('effect:' + effectId, 'scheduler', { effectId }), effectId, now());
      }),
      /**
       * R11: there is deliberately no unbound settle on this route. It took no managed token and no completion fence,
       * so a claim fence alone - including one taken just before a freeze - was enough to close the effect. A receipt
       * now closes only the operation it was opened for (managed) or the exact frozen-period subject (safety); the
       * check is not pushed down into store.settle, which both of those routes legitimately call.
       */
    });
  };

  /**
   * One registered operation's receipt. The facts object, when supplied, only adds binding: the call's own target and
   * actor are what is compared with the token. There is deliberately no claim here and no generic dispatch - a receipt
   * closes work, it never starts it, which is why the drain period can accept receipts without a hole for new claims.
   */
  const managed = ({ token: candidate, facts = {} } = {}) => {
    const guard = (target, actor, payload, command) => {
      assertManaged(candidate, facts, target, actor);
      const named = namedCommand(payload, command);
      if (named === null || named !== candidate.command) {
        failWith('MANAGED_MISMATCH', 'this token closes ' + candidate.command + ', not ' + named);
      }
    };
    return Object.freeze({
      route: 'managed',
      mutate(entityId, actor, payload, reducer, command = null) {
        guard(entityId, actor, payload, command);
        if (candidate.command !== 'effect.settle') failWith('DENIED', 'managed reducers only close effect receipts');
        return execute(entityId, actor, payload, (tx, current) => reducer(createRestrictedTx({ ...tx, put(id, data) {
          if ('status' in data && !['confirmed', 'retryable', 'unknown', 'cancelled', 'dead-letter'].includes(data.status)) {
            failWith('DENIED', 'managed receipts cannot publish business outcomes');
          }
          return tx.put(id, data);
        } }, {
          entities: [candidate.entityId], fields: { [candidate.entityId]: ['status', 'reason', 'lastEvidence', 'nextReviewAt'] },
        }), current), { operationId: candidate.operationId });
      },
      dispatch(entityId, actor, payload, command) {
        if (!command || typeof command !== 'object' || command.type !== candidate.command) {
          failWith('MANAGED_MISMATCH', 'this token closes ' + candidate.command + ', not ' + String(command && command.type));
        }
        guard(entityId, actor, payload, command.type);
        return this.mutate(entityId, actor, payload, tx => reduceCommand(tx, { ...command, actor }), command.type);
      },
      /** settle(effectId, fence, evidence): only the effect this token was opened for. */
      settle(effectId, fence, evidence, actor = candidate.actor) {
        guard(effectId, actor, null, 'effect.settle');
        // Only this internal claim fence is execution metadata (§3.6); business attempt fences in
        // mutate/dispatch payloads remain hashed authorization fields. The store validates this fence.
        return requireStore('settle').settle(commandFor('effect:' + effectId, actor, { effectId }, candidate.operationId), effectId, fence, evidence, null, now());
      },
    });
  };

  /**
   * A safety capability minted for one cause and one exact subject. Mint-time validation is not enough: a capability
   * that outlived stop(), the epoch or its own budget must not keep working because it was minted early, so every call
   * re-checks all of it.
   */
  const safety = ({ cause, subject, commands = [], fields = {}, entities = [], outboxKinds = [], expiresAt = null } = {}) => {
    subject = subject && structuredClone(subject);
    if (!['recovery', 'lease-expiry', 'operator-stop'].includes(cause)) {
      failWith('INVALID_SAFETY', 'a safety capability needs a cause, got ' + JSON.stringify(cause ?? null));
    }
    if (!subject || typeof subject !== 'object') failWith('INVALID_SAFETY', 'a safety capability must be bound to a subject');
    // The subject is a set of exact entity ids: the attempt, its cancel effect, and whatever rows that one transition
    // owns. Nothing here is a pattern, so an id that merely embeds the attempt id is a different row.
    const exact = [subject.attemptId, subject.effectId, ...(Array.isArray(subject.entities) ? subject.entities : [])]
      .filter(id => typeof id === 'string' && id);
    if (exact.length === 0) failWith('INVALID_SAFETY', 'a safety capability must name the entities it covers');
    const subjectIds = requireStrings([...new Set(exact)], 'subject entities');
    const allowedCommands = new Set(requireStrings(commands, 'commands'));
    const fieldRules = requireFieldRules(fields, 'fields');
    const kinds = requireStrings(outboxKinds, 'outboxKinds');
    if (expiresAt !== null && !Number.isFinite(expiresAt)) {
      failWith('INVALID_SAFETY', 'expiresAt, when supplied, is a finite millisecond timestamp');
    }
    const mintedEpoch = epoch();
    let revoked = false;
    const assertUsable = (entityId, allowDrain = false) => {
      if (revoked) failWith('WRITE_REVOKED', 'this safety capability was revoked');
      if (epoch() !== mintedEpoch) {
        failWith('STALE_EPOCH', 'this safety capability belongs to epoch ' + mintedEpoch + ', the host is at ' + String(epoch()));
      }
      const hostState = state();
      if (hostState === 'stopped' || hostState === 'isolated' || (hostState === 'stopping' && !(allowDrain && drainWritable()))) {
        failWith('WRITE_REVOKED', 'a safety capability cannot write while the host is ' + hostState);
      }
      if (expiresAt !== null && now() > expiresAt) failWith('SAFETY_EXPIRED', 'the safety capability expired at ' + expiresAt);
      assertOwnership();
      if (!subjectIds.includes(entityId)) {
        failWith('DENIED', 'this safety capability covers ' + JSON.stringify(subjectIds) + ', not ' + JSON.stringify(entityId));
      }
    };
    const assertCommand = name => {
      if (allowedCommands.size === 0) failWith('DENIED', 'an empty command whitelist rejects every safety write');
      if (typeof name !== 'string' || !name) failWith('DENIED', 'a safety write must name the command it runs');
      if (!allowedCommands.has(name)) failWith('DENIED', 'this safety capability may not run ' + JSON.stringify(name));
    };
    const assertEffect = effectId => {
      if (effectId !== subject.effectId) failWith('DENIED', 'only the bound safety effect may be claimed or settled');
      const effect = requireStore('effects').effects().find(item => item.id === effectId);
      if (!effect || effect.payload.kind !== 'cancel' || effect.payload.attemptId !== subject.attemptId) {
        failWith('DENIED', 'safety effects must cancel their bound attempt');
      }
    };
    const scope = tx => createRestrictedTx(tx, { entities: subjectIds, fields: fieldRules, outboxKinds: kinds, effectIds: [subject.effectId].filter(Boolean), subjectAttempt: subject.attemptId });
    return Object.freeze({
      route: 'safety',
      cause,
      subject: Object.freeze({ ...subject, ...(subject.entities ? { entities: Object.freeze([...subject.entities]) } : {}) }),
      commands: Object.freeze([...allowedCommands]),
      fields: Object.freeze(Object.fromEntries(Object.entries(fieldRules).map(([k, v]) => [k, Object.freeze([...v])]))),
      entities: Object.freeze([...subjectIds]),
      epoch: mintedEpoch,
      expiresAt,
      get revoked() {
        return revoked;
      },
      registerEffect(effectId, fence) {
        assertUsable(effectId); assertCommand('register'); assertEffect(effectId);
        const assertSource = (id, allowDrain) => {
          if (!['recovery', 'lease-expiry', 'operator-stop'].includes(cause)) failWith('INVALID_SAFETY', 'invalid safety cause');
          assertUsable(id, allowDrain);
          assertCommand('register'); assertCommand('settle'); assertEffect(id);
          if (id !== subject.effectId) failWith('DENIED', 'dispatch must retain the exact safety subject');
        };
        return registerEffect(effectId, fence, Object.freeze({
          assertDispatch(id) { assertSource(id, false); },
          assertComplete(id) { assertSource(id, true); },
        }));
      },
      release(payload) {
        assertUsable(payload.attemptId); assertCommand('release');
        if (payload.attemptId !== subject.attemptId) failWith('DENIED', 'release must retain its subject');
        const { actor = 'operator', ...business } = payload;
        return requireCore().dispatch(payload.attemptId, actor, business, { type: 'attempt.release', payload: business });
      },
      revoke() {
        revoked = true;
        return true;
      },
      mutate(entityId, actor, payload, reducer, command = null) {
        assertUsable(entityId);
        assertCommand(namedCommand(payload, command));
        return execute(entityId, actor, payload, (tx, current) => reducer(scope(tx), current));
      },
      claim(effectId, owner, ttl = 60000, claimIndex = null) {
        assertUsable(effectId);
        assertCommand('claim');
        assertEffect(effectId);
        return requireStore('claim').claim(commandFor('effect:' + effectId, 'scheduler', { effectId, owner }), effectId, owner, now(), ttl,
          typeof claimIndex === 'function' ? claimIndex : null);
      },
      settle(effectId, fence, evidence, actor = 'operator') {
        assertUsable(effectId);
        assertCommand('settle');
        assertEffect(effectId);
        return requireStore('settle').settle(commandFor('effect:' + effectId, actor, { effectId, fence }), effectId, fence, evidence, null, now());
      },
    });
  };

  /** system.recover: recovering only, with explicit entity and field whitelists enforced on the transaction. */
  const recovery = ({ entities = [], fields = {}, outboxKinds = [] } = {}) => {
    const rules = requireStrings(entities, 'entities');
    const fieldRules = requireFieldRules(fields, 'fields');
    const kinds = requireStrings(outboxKinds, 'outboxKinds');
    const assertRecovering = () => {
      if (state() !== 'recovering') {
        failWith('RECOVERY_WINDOW_CLOSED', 'recovery commands are only accepted while recovering, got ' + state());
      }
      if (failure()) failWith('WRITE_REVOKED', 'the host failed to start and takes no recovery write');
      assertOwnership();
    };
    return Object.freeze({
      route: 'recovery',
      entities: Object.freeze([...rules]),
      fields: Object.freeze(Object.fromEntries(Object.entries(fieldRules).map(([k, v]) => [k, Object.freeze([...v])]))),
      mutate(entityId, actor, payload, reducer) {
        assertRecovering();
        if (rules.length === 0) failWith('DENIED', 'an empty recovery entity whitelist rejects every write');
        if (!matchesAny(entityId, rules)) failWith('DENIED', 'the recovery capability may not write ' + JSON.stringify(entityId));
        return execute(entityId, actor, payload, (tx, current) => reducer(createRestrictedTx(tx, { entities: rules, fields: fieldRules, outboxKinds: kinds, effectIds: ['recover-cancel:*'] }), current));
      },
      /**
       * The system.recover transition itself; design §3.5.1.
       *
       * Recovery has to cross the completion fence (that is the whole point of converging an interrupted attempt
       * before admission opens), and the safe-command marker that crosses it is computed inside TeamCore.dispatch from
       * the command type - a caller cannot set it. This entry therefore runs that one fixed command, never a reducer of
       * the caller's choosing; the field contract is enforced by the reducer the command names
       * (core/commands/recovery.mjs), which is why mutate() above keeps its separate whitelist for everything else.
       */
      recover() {
        assertRecovering();
        return requireCore().dispatch('runtime', 'scheduler', { recovery: true }, { type: 'system.recover', payload: {} });
      },
    });
  };

  return Object.freeze({
    teamId,
    lifecycle,
    deliveryRecovery() {
      const mintedEpoch = epoch();
      return Object.freeze({ dispatch(entityId, actor, payload, command) {
        if (state() !== 'recovering' || failure()) failWith('RECOVERY_WINDOW_CLOSED', 'Delivery readback requires recovering');
        if (epoch() !== mintedEpoch) failWith('STALE_EPOCH', 'old Delivery recovery');
        assertOwnership();
        if (actor !== 'root' || command?.type !== 'delivery.transition' || command.payload?.deliveryId !== entityId ||
          command.payload?.from !== 'applying' || !['accepted', 'unknown'].includes(command.payload?.status)) failWith('DENIED', 'only applying Delivery readback');
        // Ordinary dispatch retains the completion fence; this is not system.recover permission.
        return dispatchThrough(entityId, actor, payload, command);
      } });
    },
    managed,
    safety,
    recovery,
    describe() {
      return {
        teamId,
        routes: [...ACCESS_ROUTES],
        lifecycle: { states: state(), token: token() ? (token().revoked ? 'revoked' : 'live') : 'none', epoch: epoch() },
        managed: { inflight: inflight ? inflight.size : 0 },
        safety: { minted: 'by the host transition that produced the cause' },
        recovery: { window: state() === 'recovering' ? 'recovering' : 'closed' },
      };
    },
  });
}
