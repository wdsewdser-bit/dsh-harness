import { failWith, hash, operationIdPattern } from '../../contracts/index.mjs';
import { preflightCommand } from './preflight.mjs';
import { mintHumanInput, reduceCommand } from '../../core/index.mjs';

/**
 * Command gateway interface; docs/host-protocol.md §2.4.
 *
 * Two identities, never one:
 *   1. external request identity - (teamId, authenticated actor, operationId, normalised business payload). It decides
 *      idempotency: the same operationId from the same actor with the same payload returns the stored receipt; the
 *      same operationId from a different actor, or with a different payload, is an explicit OPERATION_CONFLICT.
 *   2. internal concurrency control - the current revision and CAS retries inside one transaction. It never enters the
 *      external identity; a revision bump caused by visibility, a clock tick or a lease renewal must not turn a
 *      successful retry into a conflict.
 *
 * The command class (business / recovery / operator) is fixed in the trusted command registry handed to the
 * constructor; a caller cannot choose it. The registry also says which commands may be closed through the in-flight
 * channel (completion: 'inflight') and which principal a command belongs to (actor: 'operator'), so a token or an
 * unauthenticated caller cannot widen its own rights. Payloads are strict JSON, normalised once and used for both
 * the identity hash and the reducer.
 *
 * Receipt scope: receipts live in this instance's memory only. Rebuilding the gateway, or restarting the host, loses
 * them, so this skeleton provides no cross-restart idempotency - see status().capabilities. Durable operations are M2.
 */
export function createHumanInputGateway({ core, teamId, ownerSessionId, authenticate, authorize = work => work(), now = Date.now }) {
  if(typeof authenticate !== 'function')failWith('INVALID_CONFIG','human entry needs an authenticator');
  return Object.freeze({ send(request, credential) {
    const principal=authenticate(credential);
    if(core.configuration.superagentBorrow!=='v1' || principal?.teamId!==teamId || principal.ownerSessionId!==ownerSessionId ||
      !['owner-user-input','authenticated-viewer'].includes(principal.authenticatedEntry))failWith('DENIED','verified human entry required');
    request=normaliseJson(request);
    const allowed=['operationId','recipient','purpose','summary','bodyRef'];
    if(!request || Object.keys(request).some(k=>!allowed.includes(k)) || !operationIdPattern.test(request.operationId) ||
      typeof request.summary!=='string' || !request.summary.trim())failWith('INVALID_PAYLOAD','invalid human control input');
    const messageId='message:human-'+hash(teamId+':'+request.operationId), at=now();
    return authorize(()=>core.execute(messageId,'adapter',request,tx=>{
      const origin=mintHumanInput(tx,{...request,teamId,ownerSessionId,authenticatedEntry:principal.authenticatedEntry,now:at});
      return reduceCommand(tx,{type:'message.send',actor:'operator',superagentBorrow:'v1',intentProtocol:'root-decision-v1',
        humanOriginRef:origin.entityId,now:at,payload:{messageId,to:request.recipient,kind:'action',summary:request.summary,
          bodyRef:request.bodyRef,expectedOutcome:'answer this control input',deadline:new Date(at+86400000).toISOString()}});
    },{operationId:request.operationId,now:at}));
  }});
}

const REGISTRY_KINDS = Object.freeze(['business', 'recovery', 'operator']);

export function normaliseJson(value, seen = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) failWith('INVALID_PAYLOAD', 'payload contains a non-finite number, which JSON cannot carry');
    return value;
  }
  if (type !== 'object') failWith('INVALID_PAYLOAD', 'payload contains a ' + type + ' value, which is not JSON data');
  if (seen.has(value)) failWith('INVALID_PAYLOAD', 'payload contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => normaliseJson(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = value.constructor && value.constructor.name ? value.constructor.name : 'unknown';
      failWith('INVALID_PAYLOAD', 'payload contains a non-plain object (' + name + '), which JSON cannot carry');
    }
    // Null-prototype target keeps keys such as "__proto__" as ordinary data instead of hitting the prototype setter.
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) failWith('INVALID_PAYLOAD', 'key ' + JSON.stringify(key) + ' is undefined, which JSON cannot carry');
      out[key] = normaliseJson(value[key], seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value) {
  return JSON.stringify(normaliseJson(value));
}

function normaliseRegistry(commands) {
  const registry = new Map();
  for (const [name, entry] of Object.entries(commands ?? {})) {
    const spec = typeof entry === 'function' ? { kind: 'business', reduce: entry } : entry;
    if (!spec || typeof spec.reduce !== 'function') failWith('INVALID_CONFIG', 'command ' + JSON.stringify(name) + ' needs a reduce function');
    if (!REGISTRY_KINDS.includes(spec.kind)) {
      failWith('INVALID_CONFIG', 'command ' + JSON.stringify(name) + ' has an unknown class ' + JSON.stringify(spec.kind));
    }
    const completion = spec.completion ?? null;
    if (completion !== null && completion !== 'inflight') {
      failWith('INVALID_CONFIG', 'command ' + JSON.stringify(name) + ' has an unknown completion channel ' + JSON.stringify(completion));
    }
    if (spec.actor !== undefined && (typeof spec.actor !== 'string' || !spec.actor)) {
      failWith('INVALID_CONFIG', 'command ' + JSON.stringify(name) + ' declares an invalid actor');
    }
    registry.set(name, Object.freeze({ kind: spec.kind, completion, actor: spec.actor ?? null, reduce: spec.reduce }));
  }
  return registry;
}

function denyAll(kind) {
  failWith('AUTHORIZATION_NOT_CONFIGURED', 'the command gateway was built without an authorization check and refuses ' + kind + ' commands');
}

export class CommandGateway {
  #teamId;
  #authorize;
  #core;
  #registry;
  #now;
  #receipts = new Map();

  constructor({ teamId, core = null, commands = {}, now = Date.now, authorize = denyAll } = {}) {
    if (typeof teamId !== 'string' || !teamId) failWith('INVALID_TEAM', 'the command gateway needs a non-empty teamId');
    if (typeof authorize !== 'function') failWith('INVALID_CONFIG', 'authorize must be a function');
    this.#teamId = teamId;
    this.#authorize = authorize;
    this.#core = core;
    this.#registry = normaliseRegistry(commands);
    this.#now = now;
  }

  get teamId() {
    return this.#teamId;
  }

  get size() {
    return this.#receipts.size;
  }

  /** What the trusted registry says about a command, or null when it is not registered. */
  describe(commandName) {
    const entry = this.#registry.get(commandName);
    if (!entry) return null;
    return { command: commandName, kind: entry.kind, completion: entry.completion, actor: entry.actor };
  }

  /**
   * host.command({ requestId, teamId, actor, operationId, payload }, { inflight })
   * The class comes from the registry; options.inflight marks a managed in-flight receipt of the current epoch.
   */
  command(request, options = {}) {
    if (!request || typeof request !== 'object') failWith('INVALID_COMMAND', 'a command request object is required');
    if (options.kind !== undefined) {
      failWith('INVALID_COMMAND', 'the command class is fixed in the trusted registry and cannot be chosen by the caller');
    }
    const { requestId, teamId, actor, operationId, payload } = request;
    if (typeof requestId !== 'string' || !requestId) failWith('INVALID_COMMAND', 'requestId is required');
    if (teamId !== this.#teamId) {
      failWith('NOT_ROUTED', 'a command for ' + JSON.stringify(teamId ?? null) + ' is not routable here; this host owns ' + this.#teamId);
    }
    if (typeof operationId !== 'string' || !operationIdPattern.test(operationId)) {
      failWith('INVALID_OPERATION_ID', 'operationId must match ' + operationIdPattern.source);
    }
    if (typeof actor !== 'string' || !actor) failWith('INVALID_COMMAND', 'an authenticated actor is required');
    if (payload === undefined) failWith('INVALID_PAYLOAD', 'payload is required and must be strict JSON');

    let snapshot;
    try {
      snapshot = normaliseJson(payload);
    } catch (error) {
      if (error && error.code) throw error;
      failWith('INVALID_PAYLOAD', 'payload must be strict JSON: ' + error.message);
    }
    const payloadHash = hash(JSON.stringify(snapshot));

    const key = this.#teamId + '\u0000' + operationId;
    const prior = this.#receipts.get(key);
    if (prior) {
      // Receipt lookup comes before the state ruling (rule 3), but the identity includes the actor: a different
      // principal must get a conflict, never somebody else's result.
      if (prior.actor !== actor) {
        failWith('OPERATION_CONFLICT', 'operationId ' + operationId + ' was issued by ' + prior.actor + '; another actor cannot reuse it');
      }
      if (prior.payloadHash !== payloadHash) {
        failWith('OPERATION_CONFLICT', 'operationId ' + operationId + ' was already used for a different business payload');
      }
      return prior.receipt;
    }

    const entityId = snapshot && typeof snapshot.entityId === 'string' ? snapshot.entityId : null;
    if (!entityId) failWith('INVALID_COMMAND', 'payload.entityId is required');
    const commandName = snapshot.command ?? snapshot.op ?? null;
    const entry = typeof commandName === 'string' ? this.#registry.get(commandName) : undefined;
    const facts = { command: commandName, entityId, operationId, actor };
    const inflight = options.inflight !== undefined;
    if (!entry) {
      // An unregistered command has no class, so it is authorized as a business write and then refused: a caller
      // cannot learn what exists from outside, and a failed or ownership-less host stays closed.
      this.#authorize('business', request, options, facts);
    }
    // Shared with openManagedOperation: class, channel and the command's own principal are decided in one place.
    preflightCommand({ entry, command: commandName, actor, inflight });
    this.#authorize(inflight ? 'inflight' : entry.kind, request, options, facts);

    if (!this.#core || typeof this.#core.mutate !== 'function') {
      failWith('CORE_NOT_ATTACHED', 'the command gateway placeholder needs a core exposing mutate(entityId, actor, payload, reducer)');
    }
    // The reducer receives the same normalised snapshot that produced the identity, never the raw caller object.
    // The gateway is where the trusted operation identity and the trusted instant enter the command: operationId and
    // actor are passed through as the durable record key, and now is command metadata rather than payload, so it
    // never reaches the stable identity (design §3.6).
    let result;
    try {
      result = this.#core.mutate(entityId, actor, snapshot, (tx, current) => entry.reduce(tx, current, snapshot),
        { operationId, now: this.#now() });
    } catch (error) {
      // The durable operation record is the cross-restart half of the identity. A stable-identity mismatch there is
      // the same answer the in-memory receipt gives: this operationId already names a different request.
      if (error && error.code === 'ID_CONFLICT') {
        failWith('OPERATION_CONFLICT', 'operationId ' + operationId + ' is already recorded for a different actor or business payload');
      }
      throw error;
    }
    const receipt = Object.freeze({
      requestId,
      teamId: this.#teamId,
      operationId,
      actor,
      command: commandName,
      class: entry.kind,
      payloadHash,
      at: this.#now(),
      result: result ?? null,
    });
    this.#receipts.set(key, { actor, payloadHash, receipt });
    return receipt;
  }
}
