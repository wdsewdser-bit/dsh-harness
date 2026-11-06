import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { observeNative } from './native-observations.mjs';
import { createExecutionScopes } from './execution-scope.mjs';
import { installLlmExecutionEntries } from './llm-execution.mjs';
import { BORROW_TRANSPORT_CONTRACT, v1BuildCapability } from './borrow-entry-support.mjs';
import { loadBuild } from '../adapter-dsh/index.mjs';
import { isBusinessTool } from './business-tools.mjs';
import { AUTONOMY_DEFAULTS, id, sameExecution, capabilityDeclaration, TOOL_OPERATION_CAPABILITIES, ROOT_TOOL_POLICY } from '../contracts/index.mjs';
import { roleTools, teamSchemasFor, teamSchemasForBorrow } from '../contracts/team-tools.mjs';
import { RoleToolGuard, ToolCapabilityRegistry, ToolGuard } from '../host/index.mjs';
import { autonomySettings, collabSettings, consumedGenerationProof, handleTool, MemberInputArbiter, messageHumanOrigin,
  providerObserver, toolDescription } from '../core/index.mjs';
import { createDispatchTracker, createInProcessStopProver, createSubprocessTracker, loadSessionRuntime, memberScope, withMember } from './session-subprocess.mjs';

/**
 * F1 R5-5: a tool that only reads the team is an authorized query, not a business write. A frozen team or a pending
 * adjudication must stop new work, not inspection, so `team_read` keeps the ownership and lifecycle checks and is
 * exempt from the admission gate alone. The class comes from this closed catalog, decided server-side from the tool
 * name the profile registered - never from a caller's claim, and never by promoting a query to the operator class,
 * which would hand a read the operator's write permission.
 */
const READ_ONLY_TOOLS = Object.freeze(new Set(['team_read']));
/**
 * P1 of the autonomy design §2.2.5 item 2: the decision entry is the operator class, because it must work while the
 * team is frozen -- adjudicating a completion token is what unfreezes it. The class is decided server-side from the
 * closed catalog, never from a caller, and only while the autonomy switch publishes the tool at all.
 */
const OPERATOR_TOOLS = Object.freeze(new Set(['team_decide']));
const commandKind = (name, autonomy) => READ_ONLY_TOOLS.has(name) ? 'read'
  : autonomy === 'on' && OPERATOR_TOOLS.has(name) ? 'operator' : 'business';

/**
 * Bind native lifecycle and role capabilities to server authority; 08 §4.3, §4.7, §4.10.
 *
 * F2a: there is exactly one driver. The F1 switch (host or harness) is gone, and with it every branch
 * here that used to bypass the admission gate for the harness: the session observation, the role tools and the tool
 * guard audit are all ordinary business writes now. The harness-only `lifecycle()` outlet is gone too - member
 * lifecycle is driven by the host's durable intents and effects, never by the runtime surface.
 */
/**
 * Review 1 #3 / §12 U7: the admission a pending completion closed is reopened by the verdict that decides it.
 *
 * The host owns admission, so it publishes the refresh as `core.notifyDecisionSettled` (host-driver installs it); this
 * layer only calls it, after the verdict has committed and outside any transaction. A composition with no hook (a bare
 * core, a test) is a no-op: nothing here can open admission on its own, and a refresh that throws reports through the
 * host's own status instead of failing a write that already committed.
 */
export function decisionSettled(core) {
  try { core?.notifyDecisionSettled?.(); } catch { /* the host keeps its own record of a refused refresh */ }
  return true;
}


/**
 * §4.2 (P2): which protocol this core runs under. Only the switch is read here; the profile refuses to boot v1 while
 * any stage is unimplemented, so this branch is reachable in this build only from a core assembled for a test or by a
 * later package that has implemented the remaining stages. Off is the default and the answer for every other value.
 */
function borrowPosition(core) {
  const configuration = core?.configuration ?? {};
  return Object.freeze({
    superagentBorrow: configuration.superagentBorrow === 'v1' ? 'v1' : 'off',
    ownerModel: configuration.ownerModel ?? null,
    intentSemantics: configuration.intentSemantics ?? null,
    teamId: typeof configuration.teamId === 'string' && configuration.teamId ? configuration.teamId : null,
  });
}

const guardUnavailable = cause => Object.assign(Error('ROOT_GUARD_UNAVAILABLE: ' + String(cause?.message ?? cause)),
  { code: 'ROOT_GUARD_UNAVAILABLE', cause });

/**
 * §4.1/§4.2 (P2): the owner session's role guard, installed at the composition root and answered before any tool IO.
 *
 * The principal is the host's answer - the session route plus the durable root role - never an argument the model
 * supplies. The tool is the actual trusted registration (team/business/native definition),
 * never the name or a name-shaped native token the model typed; the capability declaration is bound to that implementation, so a
 * later registration or a same-name replacement cannot inherit it. The member fence is untouched: a call from a
 * member session is out of this policy's scope and continues to the scope/lease fence exactly as before.
 *
 * The guard is installed here rather than in bindAgent because the owner session is not a member agent: waiting for a
 * bind would leave the window the §11 probe found wide open. A context that cannot take the listener fails the mount
 * with ROOT_GUARD_UNAVAILABLE instead of running the owner without a guard.
 */
export function installOwnerGuard({ ctx, core, authorize, route, borrow, currentScope = () => null }) {
  if (typeof ctx?.on !== 'function') throw guardUnavailable('the context has no tools/execute hook');
  const boundary = ctx.tools?.roleToolBoundary;
  if (boundary?.version !== 'role-tool-boundary/1' || typeof boundary.install !== 'function') {
    throw guardUnavailable('this build has no non-bypassable tool boundary');
  }
  const registry = new ToolCapabilityRegistry({ policy: ROOT_TOOL_POLICY });
  // Names are templates, not native implementation tokens. Only trusted registration points may bind definitions.
  const state = { ownerSessionId: null, detach: null, retired: new Set(), generation: 0 };
  const guard = new RoleToolGuard({ registry, policy: ROOT_TOOL_POLICY, teamId: borrow.teamId,
    // The ledger is an authorized business write; a writer that throws is reported by the guard and never obeyed.
    audit: record => authorize('business', () => core.mutate('guard-audit:' + id('audit'), 'adapter', record,
      tx => tx.put('guard-audit:latest', record))) });
  const registeredNative = new WeakSet();
  const rootRole = () => core.store.read('member:root')?.role ?? null;

  const principalOf = sessionId => {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    if (state.retired.has(sessionId)) return { kind: 'owner', sessionId, role: null };
    const binding = route(sessionId);
    if (sessionId === state.ownerSessionId && !(binding?.routed && binding.kind === 'owner' && binding.teamId === borrow.teamId)) {
      return { kind: 'owner', teamId: borrow.teamId, sessionId, role: null, routed: false };
    }
    if (binding?.routed) {
      if (binding.teamId !== borrow.teamId || binding.kind !== 'owner') return { kind: 'other', sessionId };
      return { kind: 'owner', teamId: binding.teamId ?? borrow.teamId ?? null, sessionId, role: rootRole(), routed: true };
    }
    // The host installs this guard before it registers the owner route. The owner session is still the owner, and it
    // has no durable role to act under yet, so the call is refused rather than handed to the platform.
    if (state.ownerSessionId !== null && sessionId === state.ownerSessionId) {
      return { kind: 'owner', teamId: borrow.teamId ?? null, sessionId, role: null, routed: false };
    }
    // A human session that is not part of this team is not this policy's business, and is never locked out by it.
    return { kind: 'other', sessionId };
  };

  const toolDefinitionOf = (_execution, identity) => ({ identity,
    implementation: boundary.current()?.definition ?? null });

  /** One decision for one call. The owner question is asked first; every other session is out of scope. */
  const decide = ({ sessionId, identity, toolDefinition, operation, authority = boundary.current()?.authority }) => {
    const principal = principalOf(sessionId);
    if (principal?.kind === 'owner' && authority) {
      if (authority.has(guard) && authority.get(guard) !== state.generation) {
        return guard.assert({ principal: null, toolDefinition, operation, sessionId });
      }
      authority.set(guard, state.generation);
    }
    const native = toolDefinition?.implementation;
    const nativeCapabilities = boundary.nativeDeclaration?.(native);
    if (nativeCapabilities && !registeredNative.has(native)) {
      registeredNative.add(native);
      const previous = registry.entry(identity);
      if (!previous || previous.source === 'trusted-native-registration') registry.register({ identity, capabilities: nativeCapabilities, implementation: native,
        source: 'trusted-native-registration' });
    }
    if (principal && principal.kind !== 'owner') {
      const binding=route(sessionId), attempt=binding?.attemptId ? core.store.read(binding.attemptId) : null;
      if(attempt?.runClass==='human-mailbox') {
        const allowed=identity==='team_read' || identity==='team_decide' || identity==='team_message' ||
          (identity==='team_thread' && ['reply','publish','subscribe','unsubscribe'].includes(operation));
        if(identity?.startsWith('team_') && !allowed)throw Object.assign(Error('control-only mailbox'),{code:'ROLE_GUARD_DENIED'});
        return guard.assert({principal:{kind:'owner',teamId:borrow.teamId,sessionId,role:'root',routed:true},toolDefinition,operation,sessionId});
      }
      return guard.check({ principal, toolDefinition: null, operation });
    }
    const scoped = currentScope();
    if (scoped) return guard.assert({ principal: null, toolDefinition, operation, sessionId });
    return guard.assert({ principal, toolDefinition, operation, sessionId });
  };

  /** The final execution hook: name + arguments only, exactly what the platform hands every listener. */
  const assertExecution = execution => {
    const sessionId = boundary.current()?.sessionId ?? execution?.agent?.session?.id ?? null;
    const identity = typeof execution?.name === 'string' ? execution.name : null;
    const operation = typeof execution?.arguments?.op === 'string' ? execution.arguments.op : null;
    return decide({ sessionId, identity, operation, toolDefinition: toolDefinitionOf(execution, identity) });
  };

  /** The same guard one level in, for a registered implementation invoked directly or from a nested call. */
  const assertCall = ({ sessionId = null, identity = null, implementation = null, operation = null, authority } = {}) =>
    decide({ sessionId: boundary.current()?.sessionId ?? sessionId, identity, operation, authority, toolDefinition: { identity, implementation } });

  const install = () => {
    if (state.detach) return guard;
    let detach;
    const generation = ++state.generation;
    try {
      detach = ctx.on('tools/execute', async (execution, next) => {
        // Answered before any tool IO and before every listener installed after this one (the autonomy scope).
        if (generation !== state.generation) guard.assert({ principal: null });
        assertExecution(execution);
        return next();
      });
    } catch (error) { throw guardUnavailable(error); }
    if (typeof detach !== 'function') throw guardUnavailable('the tools/execute hook is not revocable');
    state.detach = detach;
    guard.installed(true);
    return guard;
  };

  /** §4.2: the guard leaves with the team/owner route. A captured old callback still refuses: the check is live. */
  const revoke = () => {
    const detach = state.detach;
    state.detach = null;
    state.generation++;
    if (typeof detach === 'function') { try { detach(); } catch { /* the listener set is going away with the host */ } }
    guard.installed(false);
    return guard.status();
  };

  const registerTeamTool = (name, definition) => {
    registry.register({ identity: name, capabilities: capabilityDeclaration(name)?.capabilities ?? [],
      operations: Object.hasOwn(TOOL_OPERATION_CAPABILITIES, name) ? TOOL_OPERATION_CAPABILITIES[name] : null,
      implementation: definition, source: 'team-tool' });
  };

  const ownerTeamTools = new Set(Object.keys(roleTools('root', collabSettings(core).collab, autonomySettings(core).autonomy, borrow.superagentBorrow)));
  const visibleDefinitions = (definitions, sessionId) => {
    const principal = principalOf(sessionId);
    if (principal?.kind !== 'owner') return definitions;
    if (!state.detach || principal.role !== 'root' || principal.routed !== true) return [];
    return definitions.flatMap(definition => {
      const identity = definition.name, nativeCapabilities = boundary.nativeDeclaration?.(definition);
      if (nativeCapabilities && !registeredNative.has(definition)) {
        registeredNative.add(definition);
        const previous = registry.entry(identity);
        if (!previous || previous.source === 'trusted-native-registration') registry.register({ identity,
          capabilities: nativeCapabilities, implementation: definition, source: 'trusted-native-registration' });
      }
      const entry = registry.resolve(identity, definition);
      if (!entry || (entry.source === 'team-tool' && !ownerTeamTools.has(identity))) return [];
      const allowed = operation => registry.decide({ identity, implementation: definition, operation }).decision === 'allow';
      if (entry.operations) {
        const prune = schema => {
          if (!schema) return null;
          if (schema.oneOf) {
            const oneOf = schema.oneOf.map(prune).filter(Boolean);
            return oneOf.length ? { ...schema, oneOf } : null;
          }
          const op = schema.properties?.op;
          if (!op) return null;
          const choices = Object.hasOwn(op, 'const') ? [op.const] : op.enum ?? Object.keys(entry.operations);
          const permitted = choices.filter(allowed);
          if (!permitted.length) return null;
          return { ...schema, properties: { ...schema.properties, op: { ...op, enum: permitted } },
            required: [...new Set([...(schema.required ?? []), 'op'])] };
        };
        const parameters = prune(definition.parameters);
        return parameters ? [{ ...definition, parameters }] : [];
      }
      return allowed(null) ? [definition] : [];
    });
  };
  // definitions() feeds both native model schemas and system-prompt descriptions. Resolve current registrations on
  // every read, including late plugins/shadows. Never alter execution tokens or member definitions.
  if (typeof ctx.tools.definitions === 'function') {
    const original = ctx.tools.definitions;
    ctx.tools.definitions = function(scope, toolSet) {
      return visibleDefinitions(Reflect.apply(original, this, [scope, toolSet]), scope?.session?.id ?? null);
    };
  }
  try { boundary.install(assertCall, () => ctx.agents.currentInitiator?.()); }
  catch (error) { throw guardUnavailable(error); }
  install();
  return Object.freeze({ guard, registry, install, revoke, registerTeamTool, assertCall, assertExecution, principalOf, visibleDefinitions,
    // The trusted registration point business tools bind their declaration and implementation to.
    register: entry => registry.register(entry),
    bindOwnerSession(ownerSessionId) {
      if (state.ownerSessionId && state.ownerSessionId !== ownerSessionId) state.retired.add(state.ownerSessionId);
      state.ownerSessionId = typeof ownerSessionId === 'string' && ownerSessionId ? ownerSessionId : null;
      return state.ownerSessionId;
    },
    status: () => Object.freeze({ ...guard.status(), ownerSessionId: state.ownerSessionId }) });
}

export function createOwnerInputPort({ core, arbiter, route, teamId, ownerSessionId, epoch, agent, hostControl, control }) {
  const current = () => {
    const r = route(ownerSessionId), root = core.store.read('member:root');
    return r?.routed && r.kind === 'owner' && r.teamId === teamId && r.sessionId === ownerSessionId &&
      root?.role === 'root' && root.desired === 'active' && r.generation === root.generation && r.epoch === (typeof epoch==='function'?epoch():epoch) ? r : null;
  };
  if (!agent || typeof hostControl !== 'function') throw Error('OWNER_CONTROL_UNAVAILABLE');
  let ownerBound=false;
  return async request => {
    const effect = core.store.effects().find(e => e.id === request.operationId);
    const p = effect?.payload, row = core.store.read(p?.messageId);
    const binding = current();
    if (!binding || !['wake','message'].includes(p?.kind) || p.targetKind !== 'owner' || p.recipient !== binding.memberId ||
        p.generation !== binding.generation || request.messageId !== p.messageId ||
        !(row?.protocol === 'root-decision-v1' && (row.recipients ?? []).includes(binding.memberId) ||
          messageHumanOrigin(core.store,row)?.recipient === binding.memberId)) return { notExecuted: true, reason: 'invalid durable owner input binding' };
    if(!ownerBound){arbiter.bindOwner('member:root',agent);ownerBound=true;}
    const key = 'owner-input-receipt:' + effect.id;
    if (core.store.read(key) || row.visibility?.[binding.memberId] || row.visible) return { executed: true, receipt: { deduplicated: true } };
    if (agent.phase?.kind === 'maintenance' || agent.phase?.kind === 'running') {
      return { deferred: true, reason: 'owner input awaits a natural boundary or idle' };
    }
    if (agent.phase?.kind !== 'idle') return { unknown: true, reason: 'unknown owner phase' };
    // H is not optional. P4 supplies a lifecycle-owned capability which retains occupancy through real termination.
    // Missing capacity never falls back to a member permit, nor to an unguarded followup.
    if (typeof control?.run !== 'function') return { deferred: true, reason: 'owner control capacity unavailable (P4)' };
    return control.run(binding, () => hostControl('owner-conversation', () => {
      const live = current();
      if (!live || JSON.stringify(live) !== JSON.stringify(binding)) return { notExecuted: true, reason: 'owner route changed' };
      const wake = arbiter.wakeIdle(binding.memberId);
      if (wake.error) return { unknown: true, reason: 'owner wake uncertain' };
      if (!wake.fired) return wake.reason === 'alreadyLive' || wake.defer ? { deferred: true, reason: 'owner busy' }
        : { notExecuted: true, reason: wake.reason };
      core.mutate(key, 'adapter', {}, tx => tx.put(key, { binding, messageId: p.messageId }));
      return { executed: true, receipt: { dispatched: true, targetKind: 'owner' } };
    }), {originRef:messageHumanOrigin(core.store,row)?.entityId ?? row.decisionRef});
  };
}

export function installRuntime(ctx, core, { authorize = (_kind, work) => work(), route = () => null, ownerSessionId = null, ownerModelSelection = null, preparedRoleGuard = null } = {}) {
  const handles = new Map();
  // F2: the workspace a member session was created with. The native file tools resolve a relative path against it,
  // and so must the ordinary-effect fence, or a genuine write is judged against the host process directory.
  const workspaces = new Map();
  /**
   * The directory this member's native session resolves a relative path against, read NOW, per check (review 2 #2).
   *
   * The guard used to capture the assignment once, when the agent was bound, and compare every target against that.
   * That is not the directory the tool uses: a resumed session restores its own recorded cwd from its log, and a
   * legitimate `cd` inside a turn changes the live one (working-directory/change). The native fs tools resolve through
   * ctx.workingDirectory, so the fence reads the same state from the same service and only falls back - header first,
   * then the assignment - when the runtime does not provide it.
   *
   * Review 2 #2 remainder: "no such service" and "the service could not be read" are different facts. The catch below
   * used to fold both into the second one, so a service that raised (including an `without inject` access error) sent
   * the fence back to the directory recorded at bind time while the native tool itself still resolved against the live
   * one. A read that fails is now a refusal: there is no directory to compare against, and guessing one is how a write
   * lands outside the lease.
   */
  const cwdUnavailable = message => Object.assign(Error('SESSION_CWD_UNAVAILABLE: ' + message), { code: 'SESSION_CWD_UNAVAILABLE' });
  /**
   * The working-directory service of one agent's context, read the way a plugin may read it.
   *
   * cordis answers a property the plugin never declared with "cannot get property X without inject", and that message is
   * the same whether or not the service exists in the composition - so the property alone cannot tell "this runtime has
   * no such service" from "the read failed". ctx.get(name) is the supported accessor: it hands back the service when the
   * context has one and nothing when it does not. The property is kept as the second way in, for the in-process
   * fixtures and for an older adapter, and its "without inject" answer is read as absence - which is exactly what it
   * means: this context never offered the service to this plugin. Every other failure is a failed read and refuses.
   */
  const workingDirectoryOf = (source, sessionId) => {
    if (!source) return null;
    if (typeof source.get === 'function') {
      let viaGet;
      try { viaGet = source.get('workingDirectory'); }
      catch (error) {
        throw cwdUnavailable('the working-directory service of ' + sessionId + ' could not be read (' +
          String(error?.code ?? error?.message ?? error) + '); the fence will not judge paths against a guessed directory');
      }
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
    let service;
    try { service = source.workingDirectory; }
    catch (error) {
      if (/without inject/i.test(String(error?.message ?? error))) return null;
      throw cwdUnavailable('the working-directory service of ' + sessionId + ' could not be read (' +
        String(error?.code ?? error?.message ?? error) + '); the fence will not judge paths against a guessed directory');
    }
    return service ?? null;
  };
  const sessionCwd = agent => {
    const sessionId = String(agent?.session?.id ?? 'this session');
    const service = workingDirectoryOf(agent?.ctx ?? null, sessionId);
    // Review 2 #2 remainder (review 3 #5): "this runtime has no working-directory service" is the ONLY fact that may
    // fall back to the directory recorded at bind time. A service that IS there and still cannot name a directory - no
    // get(), or a get() that answers null/undefined/an empty path - has failed, and the native tool's directory is then
    // unknown. Judging the call against the header would compare it with a directory the tool may not be using, which is
    // exactly the mismatch this fence exists to prevent.
    if (service !== undefined && service !== null) {
      if (typeof service !== 'object') {
        throw cwdUnavailable('the working-directory service of ' + sessionId + ' is ' + typeof service +
          ', not a service; the fence will not judge paths against a guessed directory');
      }
      if (typeof service.get !== 'function') {
        throw cwdUnavailable('the working-directory service of ' + sessionId + ' offers no get(), so the directory it ' +
          'resolves paths against cannot be read; the fence will not judge paths against a guessed directory');
      }
      let live;
      try { live = service.get(agent.session); }
      catch (error) {
        throw cwdUnavailable('the working directory of ' + sessionId + ' could not be read (' +
          String(error?.code ?? error?.message ?? error) + '); the fence will not judge paths against a guessed directory');
      }
      if (typeof live === 'string' && live) return live;
      throw cwdUnavailable('the working-directory service of ' + sessionId + ' answered ' +
        (live === null ? 'null' : live === undefined ? 'undefined'
          : typeof live === 'string' ? 'an empty path' : typeof live) +
        ' instead of a directory path; the fence will not judge paths against a guessed directory');
    }
    const header = agent?.session?.header?.cwd;
    return typeof header === 'string' && header ? header : null;
  };
  /** Windows paths differ in case and separators for the same directory; the comparison is about the directory. */
  const sameDirectory = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  const bindings = new WeakMap();
  // P5b (§7.2.2/§7.2.3): the in-process stop proof. Three pieces live here because this is the only layer that owns all
  // of them: the live agents (above), the provider-request events (ctx) and the subprocess service (ctx).
  const executionScopes = createExecutionScopes({
    read: key => core.store.read(key),
    persist: snapshot => {
      const previous=core.store.read('execution-scope:'+snapshot.E.executionEpoch);
      const admission=snapshot.state==='OPEN' && (!previous || snapshot.active>previous.active);
      return authorize(admission?'business':'operator', () => core.dispatch('execution-scope:' + snapshot.E.executionEpoch, 'adapter',
        { snapshot }, { type:'execution.record',payload:{snapshot} }));
    },
  });
  const stopTracker = createSubprocessTracker();
  const dispatchTracker = createDispatchTracker({scopes:executionScopes});
  const sessionOwners = new Map();
  const memberOfSession = sessionId => (typeof sessionId === 'string' ? sessionOwners.get(sessionId) ?? null : null);
  /**
   * Which member a spawn belongs to.
   *
   * The explicit scope (AsyncLocalStorage, opened around every turn this layer starts) is the carrier the task asked
   * for; the runtime's documented host-attribution API `agents.currentInitiator()` is the fallback for a turn opened
   * somewhere else. Both are read at spawn time, inside the tool execution that caused it. A spawn neither can
   * attribute is recorded as unattributed: never counted as any member's proof, and never ignored while it is alive.
   */
  const attribute = () => {
    const scoped = memberScope.getStore();
    if (scoped?.memberId) return { memberId: scoped.memberId, sessionId: scoped.sessionId ?? null, basis: 'scope' };
    let sessionId = null;
    try { sessionId = ctx.agents?.currentInitiator?.()?.session?.id ?? null; } catch { sessionId = null; }
    return { memberId: memberOfSession(sessionId), sessionId, basis: sessionId === null ? 'none' : 'initiator' };
  };
  const stopProver = createInProcessStopProver({ tracker: stopTracker, dispatch: dispatchTracker,
    agentOf: memberId => handles.get(memberId)?.agent ?? null, scopes:executionScopes });
  // The profile owns the stop-proof port unless a stronger one was installed before it (a platform prover).
  if (typeof core.ports.stopProof !== 'function') core.ports.stopProof = stopProver;
  const autonomyOnNow = autonomySettings(core).autonomy === 'on';
  // §4.2 (P2): the owner's final execution hook. Off installs nothing and adds no field, which is what keeps the
  // default profile object-identical to HEAD; v1 installs the role guard before every other tools/execute listener,
  // so the role question is answered before the autonomy scope and before any tool IO. The optional owner model is
  // resolved here too: a model this host cannot select fails the mount instead of running a model nobody chose.
  const borrow = borrowPosition(core);
  // Every recovery start re-reads the build capability: a host restarted over durable v1 state must not run on a build
  // that generate()/the direct apply would have refused.
  if (borrow.superagentBorrow === 'v1') v1BuildCapability(undefined);
  const ownerGuard = borrow.superagentBorrow === 'v1'
    ? preparedRoleGuard ?? installOwnerGuard({ ctx, core, authorize, route, borrow, currentScope: () => executionScopes.current() }) : null;
  ownerGuard?.bindOwnerSession(ownerSessionId);
  const ownerModel = ownerGuard ? ownerModelSelection : null;
  if (ownerGuard && borrow.ownerModel !== null) {
    const actual = ctx.agents?.get?.(ownerSessionId)?.model?.current?.();
    if (ownerModel?.effective?.provider !== borrow.ownerModel.provider || ownerModel?.effective?.model !== borrow.ownerModel.model ||
        actual?.provider !== borrow.ownerModel.provider || actual?.model !== borrow.ownerModel.model) {
      ownerGuard.revoke();
      throw Object.assign(Error('ROOT_MODEL_UNAVAILABLE: owner selection was not applied'), { code: 'ROOT_MODEL_UNAVAILABLE' });
    }
  }
  let transportCapability=false,subprocessCapability=false,dispatchCapability=false,trustedTransportCoverage=false;
  const transportReady=(autonomyOnNow || ctx.llm?.executionPermitContract==='execution-permit/1') ? loadBuild('dsh-llm').catch(()=>null) : Promise.resolve(null);
  transportReady.then(module=>{transportCapability=dispatchCapability && module?.EXECUTION_PERMIT_CONTRACT===BORROW_TRANSPORT_CONTRACT && ctx.llm?.executionPermitContract===BORROW_TRANSPORT_CONTRACT;});
  const llmEntries=installLlmExecutionEntries({ctx,scopes:executionScopes,memberOfSession,
    sessionId:()=>attribute().sessionId,authorizeHost:work=>authorize('read',work),
    hostSessionAuthorized:sid=>{const bound=route(sid);return bound?.routed===true && bound.kind==='owner';},
    moduleReady:transportReady,autonomy:autonomyOnNow,borrowV1:borrow.superagentBorrow==='v1',transportReady:()=>transportCapability,
    ...(borrow.superagentBorrow==='v1'?{ownerControl:{resolve:sid=>core.ports.ownerControl?.resolve(sid)??null},observeProvider:providerObserver(core)}:{})});
  transportReady.then(module=>{trustedTransportCoverage=llmEntries.transportCovered(module);});
  if(autonomyOnNow)ctx.on('tools/execute',async(execution,next)=>{
    const scope=executionScopes.resolve(execution.agent?.session?.id);
    if(!scope){if(memberOfSession(execution.agent?.session?.id))throw Error('EXECUTION_SCOPE_MISSING');return next();}
    // The generic tool boundary cannot attest arbitrary plugin network/redirect/auth work.
    if(!Object.hasOwn(teamSchemasFor(collabSettings(core).collab,autonomySettings(core).autonomy),execution.name) && !['read','write','edit'].includes(execution.name))scope.invalidate('unmanaged-tool-network');
    return scope.perform('tool',next,{toolCallId:execution.callId,tool:execution.name});
  });
  if(autonomyOnNow)for(const name of ['fetch','search','fetchReady','searchReady'])if(typeof ctx.web?.[name]==='function'){
    const original=ctx.web[name];ctx.web[name]=(...args)=>{const scope=executionScopes.resolve(attribute().sessionId);if(scope)scope.invalidate('unmanaged-web-network');return original.apply(ctx.web,args);};
  }
  try { if (autonomyOnNow) dispatchCapability=typeof ctx.on('llm/dispatch', event => dispatchTracker.observe(event))==='function'; }
  catch {dispatchCapability=false;} // missing diagnostics/monitor installation never means an empty complete scope
  // One provider per context (§6.2.1): when the composition root already mounted one, this layer does not replace it,
  // and the proof reports what it can see (no recorded handles) instead of pretending to see them.
  const subprocessReady = (async () => {
    if (!autonomyOnNow) return { mounted: false, reason: 'autonomy is off: the profile does not own the subprocess provider' };
    if (ctx.subprocess) return { mounted: false, reason: 'a subprocess provider is already mounted' };
    try {
      const Runtime = await loadSessionRuntime(stopTracker, attribute, executionScopes);
      const fiber = ctx.plugin(Runtime);
      if (typeof fiber?.await === 'function') await fiber.await();
      subprocessCapability=typeof ctx.subprocess==='object';
      return { mounted: true, service: subprocessCapability };
    } catch (error) {
      return { mounted: false, reason: String(error?.message ?? error) };
    }
  })();
  // Instant preemption is installed here because this is the only place that owns both halves it needs: the
  // durable member id and the live agent that can preempt its current step. The host binds the live agent to the
  // member on the start receipt (host-driver), so this watcher starts with no bindings.
  // S3 (§5.4): one arbiter per member. A legacy team selects the 'preempt' strategy (HEAD's instant-preempt); a v1
  // team selects 'queue', where no step is ever preempted. The class is the same object either way.
  const preempt = new MemberInputArbiter(core);
  ctx.on('agent/assistant-stream', ({ agent, frame }) => preempt.observeAssistantFrame(agent, frame));
  const turnPermits=new WeakMap(),turnDiagnostics=[];
  ctx.on('session/event',(session,event)=>{
    if(!autonomyOnNow)return;
    const scope=executionScopes.get(session?.id);if(!scope)return;
    const trace=['turn/start','turn/end'].includes(event?.type)?{at:Date.now(),type:event.type,turn:event.data?.turn??null,before:scope.snapshot()}:null;
    if(event?.type==='turn/start') {
      try { turnPermits.set(scope,scope.startTurn(event.data?.turn == null ? randomUUID() : String(event.data.turn))); }
      catch(error) { if(trace)trace.error={code:error.code,message:error.message};scope.rejectTurn(error); }
    } else if(event?.type==='turn/end') {
      const token=turnPermits.get(scope);
      if(token && (event.data?.turn == null || String(event.data.turn)===token.turnId)) { scope.endTurn(token);turnPermits.delete(scope); }
    }
    if(trace){trace.after=scope.snapshot();turnDiagnostics.push(trace);if(turnDiagnostics.length>128)turnDiagnostics.shift();}
  });
  ctx.on('session/event', (session) => {
    const memberId = [...handles].find(([, h]) => h.agent.session === session)?.[0];
    if (memberId) { try { authorize('business', () => observeNative(ctx, core, memberId, session)); } catch {} }
  });
  // The global surface is published from the switch: collab=off hands back teamSchemas itself, so the default
  // profile registers exactly the tools (and descriptions) it registered before this experiment.
  const collab = collabSettings(core).collab;
  const autonomy = autonomySettings(core).autonomy;
  for (const [name, parameters] of Object.entries(teamSchemasForBorrow(borrow.superagentBorrow, collab, autonomy))) {
    const definition = { name, description: toolDescription('root', name, collab, autonomy, borrow.superagentBorrow), parameters,
    output: { schema: { type: 'object' }, render: (unused, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args) {
      const sessionId = ctx.agents.currentInitiator?.()?.session?.id;
      // P2 (§4.1): the registered implementation asks the same guard before it dispatches, so a direct or nested
      // invocation of this entry is decided exactly like one the platform routed through tools/execute.
      ownerGuard?.assertCall({ sessionId: sessionId ?? null, identity: name, implementation: definition,
        operation: typeof args?.op === 'string' ? args.op : null });
      const binding = route(sessionId);
      if (!binding?.routed) throw Error('NOT_ROUTED');
      const result = authorize(commandKind(name, autonomy), () => handleTool(core, { actor: binding.memberId ?? 'member:root', ...binding }, name, args));
      // Review 1 #3: this entry can decide the completion token that holds admission closed, so the host recomputes
      // admission right after the verdict commits - exactly what the operator channel already does. The call is outside
      // the transaction (a host state refresh, not a write) and the host's own rule keeps a failed recovery closed.
      if (name === 'team_decide') decisionSettled(core);
      return result;
    } };
    // The declaration is bound to this very definition: a later registration of the same name replaces the entry, so
    // the definition it replaced no longer resolves and cannot inherit the new declaration.
    ownerGuard?.registerTeamTool(name, definition);
    ctx.tools.register(definition);
  }
  core.ports.create = async options => {
    // §22: the product names the member execution's session id itself. The native store mints its default
    // `session-<n>` from a process-local counter that starts at 1 on every boot, so a host restarted over the same
    // session directory asks for `session-1` a second time; the JSONL backend refuses an id whose log is already on
    // disk ("session "session-1" already exists"), the create effect ends unknown, and the member intent never
    // confirms. The id is this layer's durable nativeRef, so this layer decides it: explicit, opaque and unique.
    const handle = await ctx.agents.create({ sessionId: options.sessionId ?? 'session-' + randomUUID(),
      agentOptions: { provider: 'offline', model: 'model' }, meta: { cwd: options.cwd } });
    handles.set(options.memberId, handle);
    if (options.cwd) workspaces.set(options.memberId, options.cwd);
    bindSessionToMember(handle.agent, options.memberId);
    observeNative(ctx, core, options.memberId, handle.agent.session);
    return { nativeRef: handle.agent.session.id };
  };
  core.ports.resume = async options => {
    const handle = await ctx.agents.resume({ resumeSessionId: options.nativeRef,
      agentOptions: { provider: 'offline', model: 'model' } });
    // The restored session resolves relative paths against the directory recorded in its own log. If that is not the
    // directory this host assigned and fenced for the member, binding the agent would put every later guard decision on
    // a directory nobody reviewed - so the resume is refused instead of the cache being overwritten (review 2 #2).
    const restored = sessionCwd(handle?.agent);
    if (options.cwd && restored && !sameDirectory(restored, options.cwd)) {
      await handle.dispose?.();
      throw Object.assign(Error('INVALID_WORKSPACE: the resumed session of ' + options.memberId + ' resolves paths against ' +
        restored + ', not the assigned ' + options.cwd + '; refusing to bind it'), { code: 'INVALID_WORKSPACE' });
    }
    handles.set(options.memberId, handle);
    if (options.cwd) workspaces.set(options.memberId, options.cwd);
    bindSessionToMember(handle.agent, options.memberId);
    observeNative(ctx, core, options.memberId, handle.agent.session);
    return { nativeRef: handle.agent.session.id };
  };
  /**
   * P5 §7.2.2-§7.2.5: the stop proof of one member session, taken where the production lifecycle port runs.
   *
   * The proof is asked of the platform port (the in-process prover this profile installs, or a stronger one a
   * composition mounted before it) and returned as a ROW. The close-out writes that row and re-checks it in the very
   * transaction that would retire the member, so a port that only says { stopped: true } -- the claim this replaces --
   * can no longer become "stopped". Every way of failing (no port, a throw, a row the platform did not verify) answers
   * verified:false, and nothing here ever turns that into a stop.
   */
  async function proveMemberStop(memberId, generation, operation) {
    const currentScope=executionScopes.get(handles.get(memberId)?.agent?.session?.id);
    const captured=currentScope?.E.memberId===memberId && currentScope.E.generation===generation?executionScopes.captureStop(currentScope.E.executionSessionId,operation==='dispose'?'retire':'cancel',currentScope.E):null;
    const configuration = core.configuration ?? {};
    const graceMs = Number.isSafeInteger(configuration.stopGraceMs) ? configuration.stopGraceMs : AUTONOMY_DEFAULTS.stopGraceMs;
    const proofTimeoutMs = Number.isSafeInteger(configuration.stopProofTimeoutMs)
      ? configuration.stopProofTimeoutMs : AUTONOMY_DEFAULTS.stopProofTimeoutMs;
    const subject = { kind: 'member-session', id: memberId, fence: Number.isSafeInteger(generation) ? generation : 1 };
    const blank = { kind: 'stop-proof', subject, method: 'session-dispose', roots: [], reaped: [], descendantsAfter: null,
      polls: 0, emptySince: null, verified: false, confidence: 'low', at: Date.now(), tool: operation, error: null };
    if(!captured){
      const consumed=!currentScope&&consumedGenerationProof(core.store,memberId,generation);
      if(consumed)return {...consumed,evidenceOnly:true}; // durable evidence only: never select/control today's session
      return {...blank,writtenBy:'adapter',switch:'on',error:{code:'EXECUTION_SCOPE_MISSING',message:'no captured execution identity or valid consumed generation evidence'}};
    }
    const prover = core.ports?.stopProof;
    if (typeof prover !== 'function') {
      return { ...blank, error: { code: 'STOP_CAPABILITY_MISSING',
        message: 'no stop-proof port is installed, so the session of ' + memberId + ' cannot be proven stopped' } };
    }
    try {
      const proven = await prover({ subject, roots: [], graceMs, proofTimeoutMs, operation, ...(captured??{}) });
      if (!proven || typeof proven !== 'object') {
        return { ...blank, error: { code: 'STOP_NOT_VERIFIED', message: 'the stop-proof port returned no row' } };
      }
      // The subject and the provenance are the host's, never the prover's: a prover reports what the platform showed,
      // not which subject it proved or who wrote the row (§7.2.4).
      return { ...proven, kind: 'stop-proof', subject, verified: proven.verified === true && sameExecution(proven.E,captured.E)&&proven.stopId===captured.stopId, writtenBy: 'adapter', switch: 'on' };
    } catch (error) {
      return { ...blank, error: { code: error?.code ?? 'STOP_NOT_VERIFIED', message: String(error?.message ?? error) } };
    }
  }
  const autonomyStopOn = () => autonomySettings(core).autonomy === 'on';
  core.ports.cancel = async options => {
    const h = handles.get(options.memberId);
    // P5 §7.2.3: with the switch on, a cancel is complete only when the proof says the turn and every child it started
    // are gone. The prover owns the cancel request and the two budgets, so this path never reports a stop it did not
    // observe -- and never leaves the port before the turn it was asked to stop has actually ended.
    if (autonomyStopOn()) {
      const proof = await proveMemberStop(options.memberId, options.generation, 'cancel');
      return { stopped: proof.verified === true, stopProof: proof };
    }
    h.agent.cancel({ keepInbox: options.keepInbox === true });
    await h.agent.whenIdle();
    return { stopped: true };
  };
  core.ports.dispose = async options => {
    const h = handles.get(options.memberId),memberGeneration=core.store.read(options.memberId)?.generation,binding=h&&bindings.get(h.agent);
    const capturedE=executionScopes.get(h?.agent?.session?.id)?.E??null;
    const unchanged=()=>handles.get(options.memberId)===h && core.store.read(options.memberId)?.generation===memberGeneration && (!h||bindings.get(h.agent)===binding) &&
      (!executionScopes.get(h?.agent?.session?.id) || (capturedE&&sameExecution(executionScopes.get(h.agent.session.id).E,capturedE)));
    // Off mode keeps its historical unbind timing. Evidence-only/stale operations must not unbind today's agent.
    if(!autonomyStopOn())preempt.unbind(options.memberId);
    // §7.2.2: the proof is taken BEFORE the handle is dropped. After the delete there is nothing left to ask the platform
    // about, and a retirement nobody proved must not look like one that was.
    const proof = autonomyStopOn() ? await proveMemberStop(options.memberId, options.generation, 'dispose') : null;
    if (proof && proof.verified !== true) return { stopped:false,stopProof:proof,retained:true };
    const live=executionScopes.get(h?.agent?.session?.id);
    if(proof?.evidenceOnly || !unchanged() || (proof?.E && live && !sameExecution(proof.E,live.E)))return {stopped:true,stopProof:proof,retained:true};
    if(autonomyStopOn())preempt.unbind(options.memberId);
    if (h) await h.dispose();
    if(!unchanged())return {stopped:true,...(proof?{stopProof:proof}:{}),retained:true};
    handles.delete(options.memberId);
    workspaces.delete(options.memberId);
    return proof ? { stopped: proof.verified === true, stopProof: proof } : { stopped: true };
  };
  function bindSessionToMember(agent, memberId) {
    const sessionId = agent?.session?.id ?? null;
    if (typeof sessionId === 'string') sessionOwners.set(sessionId, memberId);
    if (!agent || agent.__memberScopeBound === true) return;
    const original = agent.followup;
    const gated = (kind, work) => {
      if (autonomySettings(core).autonomy !== 'on') return withMember(memberId,sessionId,work);
      const scope = executionScopes.resolve(sessionId);
      if (!scope) throw Object.assign(Error('EXECUTION_SCOPE_MISSING'),{code:'EXECUTION_SCOPE_MISSING'});
      const token = scope.acquire(kind);
      try {
        const result = scope.run(() => withMember(memberId,sessionId,work));
        if (result?.then) return Promise.resolve(result).then(value=>{scope.finish(token);return value;},error=>{scope.finish(token,'unknown');throw error;});
        scope.finish(token);return result;
      } catch(error) { scope.finish(token,'unknown');throw error; }
    };
    if(typeof original==='function')agent.followup = (...args) => gated('followup',()=>original.apply(agent,args));
    for(const key of autonomyStopOn()?['wakeDriver','preemptStep']:[]) if(typeof agent[key] === 'function') {
      const method=agent[key];agent[key]=(...args)=>gated(key,()=>method.apply(agent,args));
    }
    Object.defineProperty(agent, '__memberScopeBound', { value: true, enumerable: false });
  }
  return { handles, preempt, executionScopes, turnDiagnostics, hostControl:llmEntries.hostControl,
    ...(ownerGuard ? { roleGuard: ownerGuard, ownerModel: ownerModel?.effective ?? null } : {}), stop: { tracker: stopTracker, dispatch: dispatchTracker, ready: subprocessReady, prover: stopProver, attribute, memberOfSession }, bindSessionToMember,
    bindAgent(memberId, binding) {
      const agent = handles.get(memberId).agent;
      if (autonomySettings(core).autonomy === 'on') {
        const prior=executionScopes.get(agent.session.id);
        if (!prior || prior.E.attemptId !== binding.attemptId || prior.E.attemptFence !== binding.fence) {
          if(prior) { prior.invalidate('rebind');prior.seal();throw Object.assign(Error('EXECUTION_REBIND_UNPROVEN'),{code:'EXECUTION_REBIND_UNPROVEN'}); }
          executionScopes.open({teamId:core.configuration.teamId ?? 'team',memberId,generation:binding.generation,
            executionSessionId:agent.session.id,attemptId:binding.attemptId,attemptFence:binding.fence},
            {gates:true,attribution:true,transport:transportCapability===true && trustedTransportCoverage,subprocess:subprocessCapability===true});
        }
      }
      const installed = bindings.has(agent); bindings.set(agent, binding);
      if (installed) return agent;
      const role = core.store.read(memberId).role;
      const schemas = roleTools(role, collab, autonomy, borrow.superagentBorrow);
      // F2 defect fix: the member's surface is the host's own tools plus this role's team tools. Restricting to an
      // allow-list of team tools alone also hid every native file and shell tool a workload legitimately uses, and a
      // later, wider restriction cannot bring a tool back - restrictions accumulate. So only the team tools of the
      // other roles are denied; a native write is still fenced by the ordinary-effect guard above.
      agent.ctx.tools.restrict({ deny: Object.keys(teamSchemasFor(collab, autonomy)).filter(name => !(name in schemas)) });
      for (const [name, parameters] of Object.entries(schemas)) agent.ctx.tools.register({ name, description: toolDescription(role, name, collab, autonomy, borrow.superagentBorrow), parameters,
        output: { schema: { type: 'object' }, render: (unused, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: args => authorize(commandKind(name, autonomy), () => handleTool(core, { actor: memberId, ...bindings.get(agent) }, name, args)) });
      const guard = new ToolGuard((attempt, fence) => core.authority(attempt, fence), record =>
        authorize('business', () => core.mutate('guard-audit:' + id('audit'), 'adapter', record, tx => tx.put('guard-audit:latest', record))));
      agent.ctx.tools.guard(execution => {
        if (autonomySettings(core).autonomy === 'on') {
          try { const scope=executionScopes.resolve(agent.session.id);if(!scope)throw Error('EXECUTION_SCOPE_MISSING');scope.assertOpen(); } catch(error) { return error.code; }
        }
        if (Object.hasOwn(schemas, execution.name) || isBusinessTool(agent, execution.name)) return;
        // The fence judges the paths the tool call really names, resolved against the session's own working directory as
        // it stands at this check, and the action itself stays an ordinary write of the attempt that holds the lease.
        // Only the tool name and that call's arguments travel into the guard: spreading the model's arguments into the
        // guard's metadata let a "tool" or "targets" field in them decide the class and the targets (review 2 #1).
        try {
          // The directory is read HERE, for this call: a read that fails raises SESSION_CWD_UNAVAILABLE and the tool call
          // is refused by the catch below, instead of being judged against a directory nobody can vouch for.
          guard.authorize({ tool: execution.name, args: execution.arguments ?? {},
            cwd: sessionCwd(agent) ?? workspaces.get(memberId) ?? null },
          bindings.get(agent).attemptId, bindings.get(agent).fence);
        } catch (error) { return error.message; }
      });
      return agent;
    } };
}
