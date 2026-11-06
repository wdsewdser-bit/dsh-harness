import os from 'node:os';
import path from 'node:path';
import { fail, normalizeScope, ROOT_TOOL_POLICY, TOOL_CAPABILITIES, toolCapabilityDecision } from '../../../contracts/index.mjs';

/** Resolve existing ancestors and normalize Windows write targets; 08 §4.7. */
export const normalizeTarget = normalizeScope;

/**
 * F2: which native tools touch the filesystem in a way the fence has to cover.
 *
 * The classes are explicit, because the fence is an allow-list and not a guess: a tool that names a path is an
 * effect, a tool that runs a shell is an accepted opaque risk, a tool that only reads is not an effect at all, and
 * anything else still fails closed as UNKNOWN_EFFECT.
 */
export const OPAQUE_TOOLS = Object.freeze(['shell', 'bash', 'PTC', 'run_code']);
export const WRITE_TOOLS = Object.freeze(['write', 'edit', 'apply-patch', 'move', 'delete']);
export const READ_ONLY_TOOLS = Object.freeze(['read', 'read_image', 'list', 'glob', 'grep', 'search', 'webfetch', 'fetch', 'todo']);

const unresolved = message => Object.assign(Error('UNRESOLVED_TARGET: ' + message), { code: 'UNRESOLVED_TARGET' });

/**
 * Review 2 #1 (blocker): the path a native file tool really touches, resolved the way the native backend resolves it.
 *
 * The fence used to answer with `path.resolve()` alone, which is not the native backend's answer for two aliases:
 * `~/file` is the user's home directory to the backend (and a directory literally named "~" under the session
 * directory to `path.resolve`), and a Windows root-relative path `\dir\file` has no drive at all - the backend
 * resolves it against the drive of the SESSION directory, not against the drive of whichever process is asking. A
 * fence that answers differently from the tool it fences allows a write it believes is inside the lease.
 *
 * So the aliases are either reproduced or refused; a guess is never turned into an allow:
 *   - `~`, `~/`, `~\` expand to the home directory, exactly as the backend expands them;
 *   - a root-relative Windows path, and a home alias of any other shape (`~user/...`), are refused with
 *     UNRESOLVED_TARGET: this module cannot reproduce what the backend would do with them;
 *   - a relative path needs the session working directory. Without it there is no honest answer, and the host
 *     process directory is not one.
 */
const fullyQualified = value => {
  if (process.platform !== 'win32') return path.isAbsolute(value);
  // A drive plus its root: C:\x or C:/x, never the drive-relative C:x.
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  // A complete UNC path: exactly two leading separators, a server and a share.
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
};

export function resolveToolPath(value, cwd = null) {
  if (typeof value !== 'string' || !value) return value;
  const base = typeof cwd === 'string' && cwd ? cwd : null;
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(value === '~' ? os.homedir() : path.join(os.homedir(), value.slice(2)));
  }
  if (value.startsWith('~')) {
    throw unresolved('the home alias ' + JSON.stringify(value) + ' is not one this fence resolves the way the native ' +
      'backend does; write an absolute path instead');
  }
  if (base !== null) return path.resolve(base, value);
  if (fullyQualified(value)) return path.resolve(value);
  throw unresolved('the path ' + JSON.stringify(value) + ' is not fully qualified (a drive plus its root, or a ' +
    'complete \\\\server\\share) and there is no session working directory to resolve it against');
}

/**
 * The write targets one native tool call names, resolved the way the tool itself resolves them.
 *
 * F2 defect fix: a real model calls the file tools with `file_path` (and `source`/`destination` for a move), and a
 * relative path means "relative to my session's working directory", never "relative to the host process". The fence
 * used to look only for a pre-shaped `targets` array, so every genuine write was refused with MISSING_TARGETS
 * before any scope was compared - the ordinary-effect fence had never met a real file tool. The map below is the tool
 * surface, not a shortcut: an effect that names no path still yields no target and authorize() still fails closed.
 */
export function effectTargets(tool, args = {}, cwd = null) {
  const resolve = value => typeof value === 'string' && value ? resolveToolPath(value, cwd) : value;
  // The fields below are the ones the tools themselves read. A `targets` array in the model's own arguments is NOT one
  // of them: `write` and `edit` take `file_path`, and an argument the tool never looks at must never become the path
  // the fence compares (review 2 #1).
  const named = tool === 'move' ? [args.source, args.destination]
    : WRITE_TOOLS.includes(tool) ? [args.file_path] : [];
  return named.filter(value => typeof value === 'string' && value.length > 0).map(resolve);
}

/** Fail closed on structured effects, audit opaque accepted risk; 08 §4.7, I06. */
export class ToolGuard {
  constructor(authority, audit) { this.authority = authority; this.audit = audit; }
  authorize(effect, attemptId, fence) {
    try {
      const lease = this.authority(attemptId, fence);
      if (OPAQUE_TOOLS.includes(effect.tool)) {
        const record = { decision: 'allow', risk: 'accepted-risk', opaque: true, effect, attemptId, fence };
        this.audit(record);
        return record;
      }
      // A read is not an effect: it changes nothing the completion fence protects, and auditing every look would
      // bury the writes the ledger exists for.
      if (READ_ONLY_TOOLS.includes(effect.tool)) return { decision: 'allow', readOnly: true, effect, attemptId, fence };
      if (!WRITE_TOOLS.includes(effect.tool)) fail('UNKNOWN_EFFECT');
      // Targets are derived HERE, from the tool's real arguments and the directory it resolves them against. The caller
      // supplies the tool name, that call's arguments and the session directory - never a pre-decided target list and
      // never a tool class, both of which a model's own arguments could otherwise forge (review 2 #1).
      const targets = effectTargets(effect.tool, effect.args ?? {}, effect.cwd ?? null);
      if (!targets?.length || targets.some(target => typeof target !== 'string')) fail('MISSING_TARGETS');
      const scopes = lease.scopeSet.map(normalizeTarget);
      if (!targets.map(normalizeTarget).every(target => scopes.some(scope => target === scope || target.startsWith(scope + '/')))) fail('OUT_OF_SCOPE');
      const record = { decision: 'allow', effect: { tool: effect.tool, targets }, attemptId, fence };
      this.audit(record);
      return record;
    } catch (error) {
      this.audit({ decision: 'deny', reason: error.message, effect, attemptId, fence });
      throw error;
    }
  }
}
/**
 * §4.1/§4.2 (P2): the owner's role policy, decided at the final execution hook.
 *
 * §11 probe A found the owner path had no unified guard at all: with the switch off nothing listened on
 * `tools/execute`, and with it on the owner simply called next(). This module is the one authority that answers the
 * role question, and it answers it from trusted declarations only - never from a tool name the model chose, never from
 * an argument among the model's own (role, toolClass, targets, capability), and never from the tool's visibility.
 *
 * The parts:
 *   NATIVE_TOOL_CAPABILITIES  this repository's declaration of the platform's native tools, bound here (P2) because
 *                             the design keeps native/MCP/business declarations at their registration point;
 *   ToolCapabilityRegistry    declarations bound to the implementation that was actually registered, so a later
 *                             registration or a same-name replacement cannot inherit the previous declaration;
 *   authorizeRoleTool         the pure decision the design names: principal + declaration + operation -> allow/deny;
 *   RoleToolGuard             the same decision plus the closed audit record and the refusal counter.
 */

/** Legacy fixture token only. Production native authorization binds the actual registered definition, never this token. */
export const NATIVE_IMPLEMENTATION = Object.freeze({ source: 'native' });

/**
 * §4.1: native capability templates/fixtures only; NOT a runtime name-based authorization lookup.
 * The P2 build patch binds declarations at the native plugins' registration sites.
 *
 * fetch/search/webfetch only read, but they read anywhere on the network, which is opaque work the owner does not get;
 * todo writes the plan artifact, so it is a write. `list` and every other platform tool stay undeclared on purpose.
 */
export const NATIVE_TOOL_CAPABILITIES = Object.freeze({
  read: Object.freeze(['read-local']),
  read_image: Object.freeze(['read-local']),
  glob: Object.freeze(['read-local']),
  grep: Object.freeze(['read-local']),
  write: Object.freeze(['write-local']),
  edit: Object.freeze(['write-local']),
  'apply-patch': Object.freeze(['write-local']),
  move: Object.freeze(['write-local']),
  delete: Object.freeze(['write-local']),
  shell: Object.freeze(['opaque']),
  bash: Object.freeze(['opaque']),
  PTC: Object.freeze(['opaque']),
  run_code: Object.freeze(['opaque']),
  fetch: Object.freeze(['opaque']),
  webfetch: Object.freeze(['opaque']),
  search: Object.freeze(['opaque']),
  todo: Object.freeze(['write-local']),
});

/**
 * §4.1: tool shapes that can reach arbitrary work whatever their own name suggests.
 *
 * An MCP-wrapped tool and a batch/parallel wrapper are the design's own example of "the generic tools, and the
 * MCP/batch/dynamic tools that wrap them". Their declaration is opaque, which the owner policy denies; a registration
 * that declares something else under such a name is still judged by what it declared, but the shape is registered here
 * so that an undeclared wrapper fails closed instead of disappearing into the undeclared class with no record.
 */
const OPAQUE_SHAPES = Object.freeze([
  [/^mcp[_:.-]/i, 'an MCP-wrapped tool performs work this repository cannot classify'],
  [/(^|[_:.-])(batch|parallel|multi)([_:.-]|$)/i, 'a batch/parallel wrapper can invoke other tools, including denied ones'],
]);

/** The opaque declaration a tool name's shape implies, or null when the shape says nothing. */
export function shapeCapabilities(name) {
  if (typeof name !== 'string' || !name) return null;
  for (const [pattern] of OPAQUE_SHAPES) if (pattern.test(name)) return Object.freeze(['opaque']);
  return null;
}

const CAPABILITY_NAMES = new Set(TOOL_CAPABILITIES);
const trustRefused = code => Object.assign(Error(code), { code });

function declaredCapabilities(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw trustRefused('INVALID_TOOL_DECLARATION');
  for (const capability of value) if (!CAPABILITY_NAMES.has(capability)) throw trustRefused('UNKNOWN_CAPABILITY');
  return Object.freeze([...value]);
}

/**
 * §4.1/§4.3: trusted declarations, each bound to the implementation that was registered with it.
 *
 * The registry is the answer to "a name is not an identity": resolve() only returns an entry when the caller presents
 * the very implementation the entry was registered with. A later registration for the same identity replaces the
 * entry, so the previous implementation - an old callback, a stale closure, a tool that was swapped out - no longer
 * resolves and its calls fail closed. An identity nobody registered resolves to nothing, which is the design's
 * "unknown declaration: deny".
 */
export class ToolCapabilityRegistry {
  #entries = new Map();
  #policy;

  constructor({ policy = ROOT_TOOL_POLICY } = {}) { this.#policy = policy; }

  get policy() { return this.#policy; }

  /**
   * Register one declaration. `operations`, when given, refines the declaration per operation exactly as the contract
   * table does; `operations: {}` therefore denies every operation.
   */
  register({ identity, capabilities = [], operations = null, implementation = null, source = null } = {}) {
    if (typeof identity !== 'string' || !identity.length) throw trustRefused('INVALID_TOOL_IDENTITY');
    if (implementation === null || implementation === undefined) throw trustRefused('INVALID_TOOL_IMPLEMENTATION');
    const declared = declaredCapabilities(capabilities);
    let refined = null;
    if (operations !== null && operations !== undefined) {
      if (typeof operations !== 'object' || Array.isArray(operations)) throw trustRefused('INVALID_TOOL_DECLARATION');
      const table = Object.create(null);
      for (const [operation, list] of Object.entries(operations)) table[operation] = declaredCapabilities(list);
      refined = Object.freeze(table);
    }
    const entry = Object.freeze({ identity, capabilities: declared, operations: refined, implementation, source });
    // Post-registration wins, and it does not inherit: the previous implementation stops resolving with this line.
    this.#entries.set(identity, entry);
    const registry = this;
    return Object.freeze({
      identity,
      implementation,
      dispose() { if (registry.#entries.get(identity) === entry) registry.#entries.delete(identity); },
    });
  }

  entry(identity) { return this.#entries.get(identity) ?? null; }

  resolve(identity, implementation) {
    const entry = this.#entries.get(identity);
    if (!entry) return null;
    return entry.implementation === implementation ? entry : null;
  }

  identities() { return Object.freeze([...this.#entries.keys()]); }

  /**
   * Decide one call from the bound declaration. Every denial carries the rule that refused, so the audit row says
   * whether the tool was undeclared, the operation unknown, or the capability denied by the policy.
   */
  decide({ identity = null, implementation = null, operation = null } = {}) {
    const entry = this.resolve(identity, implementation);
    if (!entry) return Object.freeze({ decision: 'deny', reason: 'UNDECLARED_TOOL', identity, operation, capabilities: null });
    if (entry.operations !== null) {
      if (typeof operation !== 'string' || !Object.hasOwn(entry.operations, operation)) {
        return Object.freeze({ decision: 'deny', reason: 'UNKNOWN_OPERATION', identity, operation, capabilities: null });
      }
      return Object.freeze({ ...toolCapabilityDecision(this.#policy, entry.operations[operation]), identity, operation,
        capabilities: entry.operations[operation], source: entry.source });
    }
    return Object.freeze({ ...toolCapabilityDecision(this.#policy, entry.capabilities), identity, operation: null,
      capabilities: entry.capabilities, source: entry.source });
  }
}

/**
 * §4.1: `authorizeRoleTool({principal, toolDefinition, operation})`.
 *
 * The principal is the host's answer (route + durable role), never the model's; the toolDefinition is the trusted
 * registration's identity and implementation token, never the name the model typed. A principal that is not the owner
 * is out of this policy's scope and says so (`applies: false`); everything else is a decision the caller must obey.
 */
export function authorizeRoleTool({ principal = null, toolDefinition = null, operation = null, registry = null,
  policy = ROOT_TOOL_POLICY } = {}) {
  const identity = typeof toolDefinition?.identity === 'string' ? toolDefinition.identity
    : typeof toolDefinition?.name === 'string' ? toolDefinition.name : null;
  const implementation = toolDefinition?.implementation ?? toolDefinition ?? null;
  const base = { identity, operation, principalKind: principal?.kind ?? null, role: principal?.role ?? null };
  if (!principal || typeof principal !== 'object' || !['owner', 'other', 'member', 'execution', 'human'].includes(principal.kind)) {
    return Object.freeze({ ...base, decision: 'deny', reason: 'ROOT_PRINCIPAL_UNBOUND', applies: true });
  }
  if (principal.kind !== policy.principalKind) {
    return Object.freeze({ ...base, decision: 'allow', reason: 'NOT_OWNER', applies: false });
  }
  if (principal.role !== 'root') {
    return Object.freeze({ ...base, decision: 'deny', applies: true,
      reason: principal.role === null || principal.role === undefined ? 'ROOT_PRINCIPAL_UNBOUND' : 'PRINCIPAL_MISMATCH' });
  }
  if (identity === null || !registry || typeof registry.decide !== 'function') {
    return Object.freeze({ ...base, decision: 'deny', reason: 'UNDECLARED_TOOL', applies: true });
  }
  return Object.freeze({ ...base, ...registry.decide({ identity, implementation, operation }), applies: true });
}

/**
 * §4.2: the guard the composition root installs for the owner session.
 *
 * The audit record is closed: exactly the fields the design names, so a projection can render a refusal without
 * leaking the model's arguments. Denials are recorded after the refusal has been decided - the record is a ledger,
 * not a permission - and a failed write only sets auditPersistFailed; it never turns the refusal into an allow.
 */
export class RoleToolGuard {
  #registry; #policy; #audit; #teamId; #state;

  constructor({ registry, policy = ROOT_TOOL_POLICY, audit = null, teamId = null } = {}) {
    if (!registry || typeof registry.decide !== 'function') throw trustRefused('ROOT_GUARD_UNAVAILABLE');
    this.#registry = registry;
    this.#policy = policy;
    this.#audit = typeof audit === 'function' ? audit : null;
    this.#teamId = typeof teamId === 'string' && teamId ? teamId : null;
    this.#state = { installed: false, revoked: false, denials: 0, allows: 0, auditPersistFailed: false };
  }

  get registry() { return this.#registry; }
  get policy() { return this.#policy; }
  get audit() { return this.#audit; }

  register(entry) { return this.#registry.register(entry); }

  /** The closed audit record of one decision; arguments never enter it. */
  auditRecord(decision, { sessionId = null } = {}) {
    return Object.freeze({
      teamId: this.#teamId,
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      principalKind: decision.principalKind ?? null,
      role: decision.role ?? null,
      toolIdentity: decision.identity ?? null,
      op: decision.operation ?? null,
      decision: decision.decision,
      reason: decision.reason ?? null,
    });
  }

  check({ principal = null, toolDefinition = null, operation = null, sessionId = null } = {}) {
    let decision = authorizeRoleTool({ principal, toolDefinition, operation, registry: this.#registry, policy: this.#policy });
    if (decision.applies !== false && (this.#state.revoked || (!this.#state.installed && decision.decision === 'allow'))) {
      decision = Object.freeze({ ...decision, decision: 'deny', reason: 'ROOT_GUARD_UNAVAILABLE' });
    }
    if (decision.applies !== false) {
      if (decision.decision === 'allow') this.#state.allows++;
      else {
        this.#state.denials++;
        if (this.#audit) {
          // The refusal is already the answer. A ledger that cannot be written is reported, never obeyed.
          try { this.#audit(this.auditRecord(decision, { sessionId })); } catch { this.#state.auditPersistFailed = true; }
        }
      }
    }
    return decision;
  }

  assert(question) {
    const decision = this.check(question);
    if (decision.decision !== 'allow') {
      throw Object.assign(Error('ROLE_GUARD_DENIED: ' + decision.reason + ' for ' + String(decision.identity ?? 'unknown tool')),
        { code: 'ROLE_GUARD_DENIED', decision });
    }
    return decision;
  }

  installed(installed) { this.#state.installed = installed === true; this.#state.revoked = installed !== true; return this; }

  status() {
    return Object.freeze({ installed: this.#state.installed, revoked: this.#state.revoked, denials: this.#state.denials,
      allows: this.#state.allows, auditPersistFailed: this.#state.auditPersistFailed, teamId: this.#teamId,
      declared: this.#registry.identities() });
  }
}
