import { captureExecutionStop,resolveExecutionStop } from './execution-stop.mjs';
import { createOwnerControl } from './llm-execution.mjs';
import { createOwnerInputPort } from './runtime.mjs';
import { effectExecutionTarget,permitEffectPort } from './effect-execution.mjs';
import { createTeamHost, createHumanInputGateway, createEffectRunner, effectIoClaimKey, createVisibility, visibilityDirty, createRecovery, createGoalRecovery, createHostDelivery, createGarbageCollector, SessionRouter, TeamManager, acquireOwnership, canonicalTeamDir, teamDirKey } from '../host/index.mjs';
import { openSessionLog, loadBuild } from '../adapter-dsh/index.mjs';
import { randomUUID } from 'node:crypto';
import { observeMailboxTurn } from './mailbox-observation.mjs';
import { mailboxVisibility, mailboxInvalidation } from './mailbox-visibility.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ArtifactStore } from '../context/index.mjs';
import { ControlStore } from '../store/index.mjs';
import { capacityStatus, effectTrafficClass, autonomySettings, hasUnknownExecutionEffect, hasUnsettledExecutionEffect, openExecutionTurnAlert } from '../core/index.mjs';
import { AUTONOMY_DEFAULTS, sameExecution } from '../contracts/index.mjs';

export async function prepareHost(ctx, configuration) {
  const previous = configuration.previousDriver;
  if (previous) { await previous.stop(); await previous.whenSettled(); if (previous.status().stopped !== true) throw Error('DRIVER_NOT_STOPPED'); }
  const root = canonicalTeamDir(configuration.root);
  ControlStore.preflight(root);
  const manager = new TeamManager({ ctx, home: configuration.home ?? root, singleTeam: true, createHost: spec => { if (!manager.profileHost || spec.teamId !== manager.profileHost.teamId) throw Error('MULTI_TEAM_NOT_SUPPORTED'); return manager.profileHost; } });
  await manager.open();
  try {
    const known = manager.registry.list();
    if (known.length > 1 || (known.length && configuration.ownerSessionId && known[0].ownerSessionId !== configuration.ownerSessionId)) throw Error('MULTI_TEAM_NOT_SUPPORTED');
    // R5-1: a registry owner is an existing identity with a durable journal. Creating an empty Session under its id
    // would hand openSessionLog() a live session with no events, which it must read as a complete journal - "nothing
    // was completed" - and the prepared token behind it would be withdrawn on a log that was never loaded. Only an id
    // this profile mints may be created empty; an existing owner is either already live (reuse it) or not loaded at
    // all, and then the log port reads the persistent journal. Unreadable keeps the token unknown and admission closed.
    const requested = configuration.ownerSessionId ?? known[0]?.ownerSessionId ?? null;
    let owner = requested ? ctx.sessions.get(requested) ?? null : null;
    if (!owner && requested === null) owner = await ctx.sessions.create('owner-' + randomUUID(), {});
    const ownerSessionId = owner?.id ?? requested;
    if (!ownerSessionId) throw Error('OWNER_SESSION_REQUIRED');
    const entry = manager.registry.reserve({ ownerSessionId, dir: root });
    if (teamDirKey(canonicalTeamDir(entry.dir)) !== teamDirKey(root)) throw Error('OWNER_DIRECTORY_MISMATCH');
    const ownership = await acquireOwnership({ root: canonicalTeamDir(entry.dir) });
    return { manager, ownership, teamId: entry.teamId, ownerSessionId, loaded: Boolean(owner), root: canonicalTeamDir(entry.dir) };
  } catch (error) { await manager.close(); throw error; }
}
/**
 * The main-request predicate, read from the module instance the Loader boots.
 *
 * dsh-llm marks the requests the agent loop assembles in a module-level WeakSet, so the predicate is only correct when
 * it comes from the same instance the running loop uses. The service object does not expose it (ctx.llm.isAgentLoopRequest
 * is undefined) and the pristine copy answers false for the build's requests; F2b found this when the migrated scenario
 * stopped being woken into a model call at all.
 */
export async function mainRequestPredicate() {
  const llm = await loadBuild('dsh-llm');
  return options => llm.isAgentLoopRequest(options) === true;
}
/**
 * Where a member's native execution may work; design §F, decided as a profile hook rather than a command field.
 *
 * A member's session cwd comes from the lifecycle request, and the public command surface deliberately carries no
 * directory: an operator does not get to point a member at an arbitrary path over the command gateway. A deployment
 * that needs per-member directories (the collaboration arm gives every member its own workspace) supplies a hook,
 * and the profile validates what it returns before any session is created:
 *
 *   memberWorkspace({ teamId, memberId, request }) -> absolute path
 *
 * The answer must be absolute and, after resolving symlinks on the deepest existing ancestor, must sit inside one of
 * the configured workspace roots. Anything else is INVALID_CONFIG, refused at the port - before an execution exists -
 * never silently clamped to the root or created outside it.
 */
export function assertMemberWorkspace(value, roots, label = 'memberWorkspace') {
  if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) {
    throw Object.assign(Error('INVALID_CONFIG: ' + label + ' must return an absolute directory, got ' + JSON.stringify(value ?? null)), { code: 'INVALID_CONFIG' });
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    throw Object.assign(Error('INVALID_CONFIG: ' + label + ' needs a workspace root to check the answer against'), { code: 'INVALID_CONFIG' });
  }
  const real = target => {
    let existing = target;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    return fs.realpathSync(existing).toLowerCase();
  };
  const inside = roots.some(root => {
    const base = real(path.resolve(root));
    const candidate = real(value);
    return candidate === base || candidate.startsWith(base + path.sep);
  });
  if (!inside) {
    throw Object.assign(Error('INVALID_CONFIG: ' + label + ' returned ' + value + ', which is outside the configured workspace roots'), { code: 'INVALID_CONFIG' });
  }
  return value;
}

/** The deepest existing ancestor's realpath plus the segments that do not exist yet (§4.2.2, the E-package worktree rule). */
function realpathDeepest(target) {
  let existing = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const real = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(existing) : fs.realpathSync(existing);
  return path.join(real, ...tail);
}

const invalidWorkspace = detail => Object.assign(Error('INVALID_WORKSPACE: ' + detail), { code: 'INVALID_WORKSPACE' });

/**
 * §4.2.2: the shape every relative workspace must have, stated a second time on the host side on purpose.
 *
 * profiles/ may not import core/commands/members.mjs (check-deps rule b), and the host fence is the security
 * boundary: it must be able to refuse on its own, not because the reducer already did. The two rules are kept identical
 * by the tests that drive both entries with the same list of bad paths (appendix 7).
 */
function assertRelativeShape(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(value)) {
    throw invalidWorkspace('a workspace must be a relative path of A-Z a-z 0-9 . _ - and / (at most 200 characters); absolute paths, drive letters, UNC paths, backslashes and ".." are refused: ' +
      JSON.stringify(value ?? null));
  }
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.length === 0) throw invalidWorkspace('the team root is not assignable: ' + JSON.stringify(value) + ' names it');
  // A leading separator is how a UNC path starts once it is not backslash-escaped, and path.resolve would silently turn
  // it into a different absolute path: refuse it before resolving anything.
  if (value.startsWith('/')) throw invalidWorkspace('a workspace is relative to the team root, never absolute: ' + JSON.stringify(value));
  return segments.join('/');
}

/**
 * §4.2.2/§4.2.3 rule 3: resolve one relative workspace against the team root and prove it is inside it.
 *
 * The team root is the profile's `configuration.root`; root may not change it (§4.2.2). The comparison is done on
 * realpaths with both sides lowercased, which is what closes the Windows case and 8.3 short-name bypasses at once, and
 * a junction or symlink anywhere on the way out resolves to its target before the comparison, so an escape is refused
 * rather than clamped. The root itself is not assignable.
 */
export function fenceWorkspace(teamRoot, relPath) {
  const normalized = assertRelativeShape(relPath);
  const base = realpathDeepest(path.resolve(teamRoot));
  const candidate = path.resolve(base, ...normalized.split('/'));
  if (candidate.toLowerCase() === base.toLowerCase()) throw invalidWorkspace(JSON.stringify(relPath) + ' names the team root');
  const resolved = realpathDeepest(candidate);
  const lowered = resolved.toLowerCase(), loweredBase = base.toLowerCase();
  if (lowered !== loweredBase && !lowered.startsWith(loweredBase + path.sep)) {
    throw invalidWorkspace(JSON.stringify(relPath) + ' resolves to ' + resolved + ', which is outside the team root ' + base);
  }
  return { relPath: normalized, base, resolved };
}

/**
 * §4.2.3 rule 3 / appendix 7: no sharing, no nesting, and no second assignment to a live member.
 *
 * The domain reducer states the same rules in core/commands/members.mjs; this entry states them again because a
 * host command never reaches that reducer (appendix 7 records the duplication and its reason).
 */
function assertWorkspaceSlot(readable, memberId, relPath) {
  const record = memberId ? readable.read('member.workspace:' + memberId) : null;
  if (record?.lockedAt) {
    const member = readable.read(memberId);
    const dead = !member || ['retired', 'unknown', 'cancelled', 'create-failed'].includes(member.status);
    if (!dead) {
      throw Object.assign(Error('WORKSPACE_LOCKED: the workspace of ' + memberId + ' is locked until the member is retired'),
        { code: 'WORKSPACE_LOCKED' });
    }
  }
  const candidate = relPath.toLowerCase();
  for (const row of readable.list('member.workspace:')) {
    if (memberId && row.memberId === memberId) continue;
    const other = String(row.relPath ?? '').toLowerCase();
    if (!other) continue;
    if (other === candidate || other.startsWith(candidate + '/') || candidate.startsWith(other + '/')) {
      throw invalidWorkspace('workspace ' + relPath + ' overlaps ' + row.relPath + ', already assigned to ' + row.memberId +
        '; two members never share or nest workspaces (appendix 7)');
    }
  }
}

function assertGroupToken(value, label = 'group') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw Object.assign(Error('INVALID_GROUP: ' + label + ' must be one token of A-Z a-z 0-9 . _ -, at most 64 characters; got ' +
      JSON.stringify(value ?? null)), { code: 'INVALID_GROUP' });
  }
  return value;
}

/**
 * Where one lifecycle request runs: root's assignment first, then the deployment hook (§4.2.3 rule 4).
 *
 * The assignment is fenced AGAIN here, at the last moment before the port runs. That second check is the whole point of
 * the two-layer rule: the record was written when root assigned it, and a directory can be replaced by a junction in
 * between. When the two answers disagree the assignment is refused, never silently used.
 */
function memberWorkspaceFor(configuration, teamId, request, core) {
  const record = core?.store?.read('member.workspace:' + request.memberId) ?? null;
  if (record && typeof record.relPath === 'string' && record.relPath) {
    const fenced = fenceWorkspace(configuration.root, record.relPath);
    if (typeof record.resolved === 'string' && record.resolved &&
      record.resolved.toLowerCase() !== fenced.resolved.toLowerCase()) {
      throw invalidWorkspace('workspace ' + record.relPath + ' of ' + request.memberId + ' now resolves to ' +
        fenced.resolved + ', not the recorded ' + record.resolved + '; refusing rather than running somewhere nobody reviewed');
    }
    return fenced.resolved;
  }
  const hook = configuration.memberWorkspace;
  if (hook === undefined || hook === null) return request.cwd;
  if (typeof hook !== 'function') {
    throw Object.assign(Error('INVALID_CONFIG: memberWorkspace must be a function'), { code: 'INVALID_CONFIG' });
  }
  const roots = configuration.workspaceRoots ?? configuration.workspaceRoot ?? configuration.root;
  return assertMemberWorkspace(hook({ teamId, memberId: request.memberId, request }),
    Array.isArray(roots) ? roots : [roots]);
}

export async function activateHost({ ctx, core, gate, runtime, configuration, registerVisibility, prepared, previous = configuration.previousDriver }) {
  if (!prepared) { if (previous) { await previous.stop(); await previous.whenSettled(); if (!previous.status().stopped) throw Error('DRIVER_NOT_STOPPED'); } throw Error('PREPARED_OWNER_REQUIRED'); }
  const { manager, ownership, teamId, ownerSessionId } = prepared;
  // §4.2 (P2): the owner final execution hook is installed before the route exists, so tell it which session the host
  // installed it for. Off (no role guard) is a no-op and adds nothing.
  runtime.roleGuard?.bindOwnerSession?.(ownerSessionId);
  // §4.2.3 rule 3 / appendix 7: the one function core asks before it records a workspace. It lives here because the
  // team root does: the core has no filesystem policy, and the profile owns the root the fence measures against.
  if (core && core.ports && typeof core.ports === 'object') {
    core.ports.workspaceFence = ({ relPath }) => fenceWorkspace(configuration.root, relPath);
  }
  const router = new SessionRouter();
  let host;
  let runner, recovery, safety = [];
  host = createTeamHost({ teamId, ownerSessionId, root: configuration.root, core, acquire: async () => ownership,
    cycleIntervalMs: configuration.lifecycleIntervalMs ?? 500,
    // Storage governance is on by default (the host's own default); a profile can only tune or explicitly switch it
    // off. A consumer that reads the raw journal after the fact registers as a reader (registerReader) instead.
    ...(configuration.evidenceRetentionCommitThreshold !== undefined ? { evidenceRetentionCommitThreshold: configuration.evidenceRetentionCommitThreshold } : {}),
    ...(configuration.evidenceMaintenanceIntervalMs !== undefined ? { evidenceMaintenanceIntervalMs: configuration.evidenceMaintenanceIntervalMs } : {}),
    ...(configuration.evidenceRetentionLimits !== undefined ? { evidenceRetentionLimits: configuration.evidenceRetentionLimits } : {}),
    // R9: one clock for every decision the host makes, including the deferred nextDue a maintenance wait persists. The
    // profile passes one in when a caller needs a controlled clock (tests, benchmarks); otherwise the host mints its own.
    clock: configuration.clock ?? null,
    router, recoverer: context => recovery.recover(context),
    commands: { 'team.member.request': { kind: 'business', actor: 'root', reduce(tx, current, payload) {
      if (current || !['worker', 'verifier', 'subCoordinator'].includes(payload.role) || !payload.entityId.startsWith('member-intent:')) throw Error('INVALID_MEMBER_INTENT');
      const operationId = payload.entityId.slice('member-intent:'.length);
      // P2 §4.2.1: this entry carries the same two assignments the root tool carries -- a group and a workspace -- and
      // applies the same rules (shape, fence, one assignment per member). They are stated twice because profiles/ may not
      // import packages/core/commands/members.mjs (check-deps rule b); the tests drive both entries with the same
      // list of bad paths so the two statements cannot drift (appendix 7).
      const group = payload.group === undefined ? null : assertGroupToken(payload.group);
      const relPath = payload.workspaceRel === undefined ? null : payload.workspaceRel;
      const memberId = 'member:' + operationId;
      const fenced = relPath === null ? null : fenceWorkspace(configuration.root, relPath);
      if (fenced) {
        assertWorkspaceSlot(tx, memberId, fenced.relPath);
        tx.put('member.workspace:' + memberId, { memberId, relPath: fenced.relPath, base: fenced.base,
          resolved: fenced.resolved, recordedAt: Date.now(), by: 'member:root', lockedAt: null });
      }
      if (group !== null && !tx.read('group:' + group)) {
        tx.put('group:' + group, { name: group, lead: null, createdAt: Date.now(), by: 'member:root' });
      }
      return tx.put(payload.entityId, { op: 'request', role: payload.role,
        ...(group === null ? {} : { group }), ...(fenced === null ? {} : { workspaceRel: fenced.relPath }),
        operationId, status: 'intent' });
    } }, 'team.task.request': { kind:'business',actor:'root',reduce(tx,current,payload) {
      if (current || !tx.read(payload.owner) || !payload.entityId.startsWith('task:')) throw Error('INVALID_TASK');
      if(payload.plannedDelivery){const ref=payload.plannedDelivery;if(!ref.startsWith('delivery:'))throw Error('INVALID_DELIVERY');if(!tx.read(ref))tx.put(ref,{owner:payload.owner,taskId:payload.entityId,status:'planned',contractRevision:1,acl:['member:root','member:verifier']});}
      if (payload.artifactRef) { if (!payload.artifactRef.startsWith('artifact:')) throw Error('INVALID_ARTIFACT'); tx.put(payload.artifactRef,{owner:payload.owner,contractRevision:1,status:'planned',acl:['member:root','member:verifier']}); }
      return tx.put(payload.entityId,{owner:payload.owner,status:'ready',approved:true,worktreeReady:true,contractRevision:1,assignmentEpoch:1,scopeSet:payload.scopeSet??[]});
    } }, 'team.wake': { kind:'business',actor:'root',reduce(tx,current,payload) {
      const member=tx.read(payload.recipient), message=tx.read(payload.messageId);
      if (!member || !message || message.recipient !== member.entityId) throw Error('DENIED');
      const key = 'wake-intent:' + message.entityId + ':' + member.entityId;
      if (!tx.read(key)) { tx.outbox('wake:' + message.entityId + ':' + member.entityId,{kind:'wake',messageId:message.entityId,recipient:member.entityId,generation:member.generation}); tx.put(key,{messageId:message.entityId,recipient:member.entityId}); } return member;
    } }, 'delivery.reconcile': { kind: 'business', actor: 'root', reduce(tx, current, payload) {
      const row = tx.read(payload.deliveryId);
      if (!row || row.status !== 'applying' || payload.entityId !== row.entityId) throw Error('INVALID_DELIVERY');
      tx.outbox('delivery:' + row.entityId + ':' + row.revision, { kind:'delivery', deliveryId:row.entityId, taskId:row.taskId, deliveryRevision:row.revision, target:row.target });
      return row;
    } } },
    steps: { intents: () => host.coreAccess.lifecycle().prepareLifecycle(), pump: () => { ensureTurnFaultAlerts();for(const scope of runtime.executionScopes?.all()??[])maybeCloseExecution(scope);pruneExecutions(); for (const capability of safety) runner.pumpSafety(capability); return runner.pump(); } } });
  // createVisibility reads sessions.get(id) (a session lookup, not a resolver): a plain function here failed every
  // dispatch event with "sessions.get is not a function", which the old catch flattened into invalid-event.
  const sessions = { get: id => ctx.sessions.get(id) };
  const bind = (memberId, sessionId, generation, attempt = {}) => {
    const binding = router.bindExecution({ executionSessionId: sessionId, teamId, memberId, generation, ...attempt });
    for (const watcher of [...mailboxWatchers.values()]) watcher.revalidate();
    return binding;
  };
  const ports = {};
  let artifacts = null;
  for (const kind of ['create', 'resume', 'dispose', 'cancel-member']) ports[kind] = async request => {
    const operation = kind === 'cancel-member' ? 'cancel' : kind;
    const member = core.store.read(request.memberId);
    // Only the two operations that open or reopen a session carry a directory; dispose/cancel keep their payload.
    const cwd = kind === 'create' || kind === 'resume' ? memberWorkspaceFor(configuration, teamId, request, core) : request.cwd;
    const receipt = await core.ports[operation]({ ...request, nativeRef: member.nativeRef, cwd });
    return { executed: true, receipt };
  };
  const executions = new Map();
  // Preserve exact agents while cancellation/recovery can need them. Terminal leases
  // with no pending start receipt are history, not a cache entry for the host lifetime.
  const pruneExecutions = () => {
    for (const attemptId of executions.keys()) {
      const attempt = core.store.read(attemptId);
      const scope=runtime.executionScopes?.get(attempt?.executionSessionId);
      if(scope && scope.state()!=='RELEASED')continue;
      const unsettled = attempt && hasUnsettledExecutionEffect(core.store, attempt,
        attempt.lease === 'revoked' ? ['applying'] : ['applying', 'unknown']);
      if (!['active', 'unknown'].includes(attempt?.lease) && !startInFlight(attemptId) && !unsettled) executions.delete(attemptId);
    }
  };
  const unbind = sessionId => {
    router.unbindExecution(sessionId);
    runtime.executionScopes?.detach(sessionId);
    mailboxTurns.delete(sessionId);
    for (const [key, watcher] of [...mailboxWatchers]) if (JSON.parse(key)[4] === sessionId) watcher.done();
    pruneExecutions();
  };
  /**
   * Ruling A (F2): a mailbox task is a wake, not work.
   *
   * The attempt it opens lives for exactly the turn that wake opened. When that turn ends the host closes the attempt
   * through the product's own release variant (attempt.release), which the completion fence already classifies as a
   * safe command, so a release during a completion freeze is not refused. Nothing renews the lease to keep the wake
   * alive: a message that is still unread is the next drain's business and asks for a new mailbox task by the
   * ordinary rule. A failed release is recorded and reported in status(), never swallowed.
   */
  const mailboxReleases = [];
  /**
   * Review 2 #3: the start effect of an attempt is the row whose id IS the attempt id, and a release that lands before
   * that effect is closed out makes the close-out fail (STALE_EFFECT_SUBJECT) and leaves the effect applying, which later
   * becomes unknown. So a release that arrives while the start is still pending/retryable/applying is recorded and applied
   * when the start confirms (onReceipt), never raced against it.
   */
  // Only off-mode compatibility uses the old journal-only lifecycle below.
  const legacyPendingReleases = new Map();
  const scopeCloseScheduled=new WeakSet(),scopeWatches=new WeakMap(),closeoutChecks=new Map();
  const closeoutCheck=(scope,reason,details={})=>{const key=scope.E.executionEpoch,prior=closeoutChecks.get(key),snapshot=scope.snapshot();
    if(prior?.reason===reason && prior.scope.version===snapshot.version)return;
    closeoutChecks.set(key,{reason,at:host.clock.now(),scope:snapshot,...details});if(closeoutChecks.size>64)closeoutChecks.delete(closeoutChecks.keys().next().value);
  };
  // Recover the crash window and epochs without an in-memory registry; acknowledgement never reopens E.
  function ensureTurnFaultAlerts(){
    if(autonomySettings(core).autonomy!=='on'||host.state!=='running')return;
    for(const row of core.store.list('execution-scope:'))if(row.state!=='RELEASED'&&row.coverageGaps?.includes('unpermitted-turn')&&!core.store.read('execution-alert:'+row.E.executionEpoch)){
      try{host.coreAccess.lifecycle().mutate('execution-alert:'+row.E.executionEpoch,'adapter',{},tx=>openExecutionTurnAlert(tx,row,{now:host.clock.now(),ttlMs:autonomySettings(core).decisionTtlMs}));}
      catch(error){mailboxReleases.push({attemptId:row.E.attemptId,code:error.code,message:error.message,at:host.clock.now()});}
    }
  }
  const maybeCloseExecution=scope=>{
    if(!scope || scopeCloseScheduled.has(scope))return;
    scopeCloseScheduled.add(scope);
    queueMicrotask(()=>{
      scopeCloseScheduled.delete(scope);
      if(host.state!=='running'){closeoutCheck(scope,'host-not-running',{hostState:host.state});return;}
      const attempt=core.store.read(scope.E.attemptId),finish=core.store.read('execution-finish:'+scope.E.executionEpoch);
      const requested=finish?.state==='requested';
       if(scope.snapshot().coverageGaps.includes('unpermitted-turn')){ensureTurnFaultAlerts();closeoutCheck(scope,'unpermitted-turn',{alertId:'execution-alert:'+scope.E.executionEpoch});return;}
      if(scope.snapshot().closeoutPurpose && scope.snapshot().closeoutPurpose!=='complete'){closeoutCheck(scope,'destructive-stop');return;}
      if(!requested && core.store.read(attempt?.taskId)?.mailboxOnly!==true){closeoutCheck(scope,'not-mailbox-or-completion');return;}
      if(requested)scope.beginStop('complete');
      const snap=scope.snapshot();
      if((!requested&&!snap.lastEndedTurn) || snap.currentTurn!==null || snap.active || snap.uncertain || !['OPEN','DRAINING','PROVEN'].includes(snap.state)){closeoutCheck(scope,'not-drained',{requested});return;}
      try {
        if(snap.state==='OPEN')scope.seal();
        const proof=scope.prove({kind:'attempt',id:scope.E.attemptId,fence:scope.E.attemptFence});
        if(!proof.verified){closeoutCheck(scope,'proof-unverified',{proof});return;}
        const payload={proof,evidenceRef:'stop-proof:mailbox:'+scope.E.executionEpoch,purpose:requested?'complete':'retire'};
        host.coreAccess.lifecycle().dispatch(scope.E.attemptId,'adapter',payload,{type:'execution.close',payload});
        scope.released(proof);closeoutCheck(scope,'released');scopeWatches.get(scope)?.();scopeWatches.delete(scope);pruneExecutions();
      }catch(error){closeoutCheck(scope,'commit-error',{error:{code:error.code,message:error.message}});mailboxReleases.push({attemptId:scope.E.attemptId,code:error.code,message:error.message,at:host.clock.now()});}
    });
  };
  // Independent of watcher lifetime: a deferred T1 end must never authorize release of T2.
  const mailboxTurns = new Map();
  const turnState = session => {
    if (!mailboxTurns.has(session.id)) mailboxTurns.set(session.id, { turn: openTurnOf(session), ended: false });
    return mailboxTurns.get(session.id);
  };
  const detachMailboxTurns = ctx.on('session/event', (session, event) => {
    if (autonomySettings(core).autonomy==='on' || !session || !router.routeExecution(session.id)?.routed) return;
    if (event?.type === 'turn/start') mailboxTurns.set(session.id, { turn: turnOf(event), ended: false });
    else if (event?.type === 'turn/end') {
      const state = turnState(session), turn = turnOf(event);
      if (turn === null || state.turn === turn) state.ended = true;
    }
  });
  const startInFlight = attemptId => core.store.effects().some(effect => effect.id === attemptId &&
    effect.payload?.kind === 'start' && ['pending', 'retryable', 'applying'].includes(effect.status));
  const releaseMailbox = request => {
    if(autonomySettings(core).autonomy==='on'){maybeCloseExecution(runtime.executionScopes?.get(request.binding.sessionId));return;}
    const { binding, agent, turn } = request, attemptId = binding.attemptId;
    try {
      if (host.state !== 'running' || !sameMailboxBinding(binding, agent) ||
        mailboxTurns.get(binding.sessionId) !== turn || !turn.ended) {
        if (legacyPendingReleases.get(attemptId) === request) legacyPendingReleases.delete(attemptId);
        return null;
      }
      const attempt = core.store.read(attemptId);
      if (!attempt || attempt.lease !== 'active' || hasUnknownExecutionEffect(core.store, attempt)) {
        legacyPendingReleases.delete(attemptId); return null;
      }
      if (startInFlight(attemptId) || hasUnsettledExecutionEffect(core.store, attempt, ['applying'])) {
        legacyPendingReleases.set(attemptId, request); return null;
      }
      legacyPendingReleases.delete(attemptId);
      const payload = { attemptId, fence: attempt.fence, status: 'cancelled', reason: 'mailbox wake ended with its turn' };
      const receipt = host.coreAccess.lifecycle().dispatch(attemptId, attempt.owner, payload, { type: 'attempt.release', payload });
      for (const [key, merge] of mailboxMerges) if (merge.binding.attemptId === attemptId) mailboxMerges.delete(key);
      pruneExecutions();
      return receipt;
    } catch (error) {
      mailboxReleases.push({ attemptId, code: error?.code ?? null, message: error?.message ?? String(error), at: host.clock.now() });
      return null;
    }
  };
  /** The turn number an event carries, or null when this journal does not name turns. */
  const turnOf = event => (Number.isInteger(event?.data?.turn) ? event.data.turn : null);
  /** The turn this session journal is inside right now, or null when the journal does not name turns. */
  const openTurnOf = session => {
    try {
      let open = null;
      for (const entry of session?.snapshotEvents?.() ?? []) {
        const turn = turnOf(entry);
        if (turn === null) continue;
        if (entry.type === 'turn/start') open = turn;
        else if (entry.type === 'turn/end' && turn === open) open = null;
      }
      return open;
    } catch { return null; }
  };
  // Mailbox state belongs to an execution, never to a reusable member id.
  const mailboxMerges = new Map();
  const mailboxWatchers = new Map();
  const mailboxKey = b => JSON.stringify([b.memberId, b.attemptId, b.fence, b.generation, b.sessionId]);
  const mailboxBinding = (attempt, agent) => ({ memberId: attempt.owner, attemptId: attempt.entityId,
    fence: attempt.fence, generation: attempt.generation, sessionId: agent.session.id });
  const sameMailboxBinding = (b, agent) => {
    const attempt = core.store.read(b.attemptId);
    const routed = router.routeExecution(b.sessionId);
    // During start the receipt has not installed the route yet; after that it must still be exact.
    if (attempt?.executionSessionId && (!routed?.routed || routed.attemptId !== b.attemptId ||
      routed.fence !== b.fence || routed.generation !== b.generation || routed.epoch !== host.epoch)) return false;
    return attempt?.lease === 'active' && attempt.owner === b.memberId && attempt.fence === b.fence &&
      attempt.generation === b.generation && (!attempt.executionSessionId || attempt.executionSessionId === b.sessionId) &&
      core.store.read(b.memberId)?.generation === b.generation && runtime.handles.get(b.memberId)?.agent === agent &&
      agent.session.id === b.sessionId;
  };
  const sameAuthority = (current, agent) => {
    const live = authority(current.attempt.owner, current.binding.generation);
    return live.ok && live.binding.attemptId === current.binding.attemptId && live.binding.fence === current.binding.fence &&
      live.binding.sessionId === current.binding.sessionId && runtime.handles.get(current.attempt.owner)?.agent === agent;
  };
  // Open BEFORE invoking the driver: even a synchronous, unnumbered start belongs to this window.
  // Failed wakes discard the tentative events. Events before the window cannot arm a new wake.
  const beginMailboxMerge = (current, agent) => {
    if(autonomySettings(core).autonomy==='on')return null;
    if (core.store.read(current.attempt.taskId)?.mailboxOnly !== true || !agent?.session) return null;
    const binding = mailboxBinding(current.attempt, agent), key = mailboxKey(binding);
    if (!mailboxWatchers.has(key)) watchMailboxAttempt(binding.attemptId, agent);
    const window = mailboxWatchers.get(key)?.begin();
    return { binding, key, agent, before: openTurnOf(agent.session), beforeToken: turnState(agent.session), window,
      close: uncertain => mailboxWatchers.get(key)?.cancel(window, uncertain) };
  };
  const markMailboxMerge = (observation, kind) => {
    if (!observation || !sameMailboxBinding(observation.binding, observation.agent)) return;
    const { binding, key, agent, before, beforeToken, window } = observation;
    const now = openTurnOf(agent.session);
    const turn = kind === 'live' ? (before ?? now) : (now !== null && now !== before ? now : null);
    const merge = { binding, kind, turn, window, token: kind === 'live' && before !== null ? beforeToken : turnState(agent.session) };
    const watcher = mailboxWatchers.get(key);
    if (watcher) watcher.arm(merge); else mailboxMerges.set(key, merge);
  };
  const watchMailboxAttempt = (attemptId, agent) => {
    if(autonomySettings(core).autonomy==='on'){
      const scope=runtime.executionScopes?.get(agent?.session?.id);
      if(scope && !scopeWatches.has(scope))scopeWatches.set(scope,scope.subscribe(()=>maybeCloseExecution(scope)));
      return;
    }
    const attempt = core.store.read(attemptId);
    if (!attempt || core.store.read(attempt.taskId)?.mailboxOnly !== true || !agent?.session) return;
    const binding = mailboxBinding(attempt, agent), key = mailboxKey(binding);
    mailboxWatchers.get(key)?.done();
    turnState(agent.session);
    const watcher = observeMailboxTurn({
      listen: listener => ctx.on('session/event', (session, event) => {
        if (session?.id === binding.sessionId) listener(event);
      }),
      valid: () => sameMailboxBinding(binding, agent),
      openTurn: () => openTurnOf(agent.session), turnOf,
      tokenOf: event => event.observationToken ?? turnState(agent.session),
      onDone: () => { mailboxWatchers.delete(key); mailboxMerges.delete(key); },
      onRelease: observedTurn => {
        const turn = observedTurn;
        if (!turn || mailboxTurns.get(binding.sessionId) !== turn) return;
        // A live numbered turn may already have ended before arm() read the journal.
        if (openTurnOf(agent.session) === null) turn.ended = true;
        const request = { binding, agent, turn };
        queueMicrotask(() => releaseMailbox(request));
      },
    });
    mailboxWatchers.set(key, watcher);
    const pending = mailboxMerges.get(key);
    if (pending) { mailboxMerges.delete(key); watcher.arm(pending); }
  };
  ports.start = async request => {
    const memberId = request.memberId ?? request.owner;
    // Rebinding actively revokes the old observer, even if its session never emits again.
    for (const [key, watcher] of mailboxWatchers) if (JSON.parse(key)[0] === memberId) watcher.done();
    const agent = runtime.bindAgent(memberId, { attemptId: request.attemptId, fence: request.fence, generation: request.generation });
    executions.set(request.attemptId, agent);
    // Review 3 #2: preparing an execution is not a merge. The listener is installed here (a wake delivered before this
    // start has its merge record waiting for exactly this attempt), but it is only ARMED by a merge this host observed.
    watchMailboxAttempt(request.attemptId, agent);
    return { executed: true, receipt: { prepared: true, executionSessionId: agent.session.id } };
  };
  const stopBudgets = () => {
    const settings = core.configuration ?? {};
    return {
      graceMs: Number.isSafeInteger(settings.stopGraceMs) ? settings.stopGraceMs : AUTONOMY_DEFAULTS.stopGraceMs,
      proofTimeoutMs: Number.isSafeInteger(settings.stopProofTimeoutMs) ? settings.stopProofTimeoutMs : AUTONOMY_DEFAULTS.stopProofTimeoutMs,
    };
  };
  /**
   * Review 1 #1 (blocker): the stop of one EXECUTION, proven where the cancel effect runs.
   *
   * The automatic path used to answer `{ stopped: true, evidenceRef: 'native-stop:<id>' }` after `agent.cancel()` and
   * `whenIdle()` and then let the close-out release the lease as the operator's manual fallback. Neither half is a
   * proof: the turn may still be finishing, the tool children may still be alive, and an automatic stop must not borrow
   * the exemption the human channel has. So the same platform prover the member path uses is asked here, for this
   * member at this generation, with the exact execution this cancel was bound to - and the receipt carries the row the
   * platform read back, or nothing.
   */
  const proveExecutionStop = async (attempt, agent, captured) => {
    // The subject is the member session of the attempt that owns the execution: it is the fact the prover can read back
    // (turn ended, no provider request in flight, no child process left), and §7.2.4 accepts it for this attempt.
    const subject = { kind: 'member-session', id: attempt.owner, fence: attempt.generation };
    const { graceMs, proofTimeoutMs } = stopBudgets();
    const blank = { kind: 'stop-proof', subject, method: 'session-cancel', roots: [], reaped: [],
      descendantsAfter: null, polls: 0, emptySince: null, verified: false, confidence: 'low', at: host.clock.now(),
      tool: 'cancel', error: null, writtenBy:'adapter',switch:'on' };
    if(!captured)return {...blank,error:{code:'EXECUTION_SCOPE_MISSING',message:'no captured execution identity'}};
    const prover = core.ports?.stopProof;
    if (typeof prover !== 'function') {
      return { ...blank, error: { code: 'STOP_CAPABILITY_MISSING', message: 'no stop-proof port is installed, so the ' +
        'execution of ' + attempt.entityId + ' cannot be proven stopped' } };
    }
    try {
      const proof = await prover({ subject, roots: [], graceMs, proofTimeoutMs, operation: 'cancel', agent, E:captured?.E,stopId:captured?.stopId });
      if (!proof || typeof proof !== 'object') {
        return { ...blank, error: { code: 'STOP_NOT_VERIFIED', message: 'the stop-proof port returned no row' } };
      }
      // A prover that read another session of the same member proved a different turn than the one this attempt ran.
      const provenSession = proof.checks?.llm?.sessionId ?? null;
      const verified = proof.verified === true && Boolean(captured) && sameExecution(proof.E,captured.E) && proof.stopId===captured.stopId && (provenSession === null || provenSession === attempt.executionSessionId);
      return { ...proof, kind: 'stop-proof', subject, verified, writtenBy: 'adapter', switch: 'on',
        ...(verified ? {} : { error: proof.error ?? { code: 'STOP_NOT_VERIFIED', message: 'the proof covers session ' +
          String(provenSession) + ', not the execution ' + String(attempt.executionSessionId) + ' this cancel belongs to' } }) };
    } catch (error) {
      return { ...blank, error: { code: error?.code ?? 'STOP_NOT_VERIFIED', message: String(error?.message ?? error) } };
    }
  };
  ports.cancel = async request => {
    const attempt = core.store.read(request.attemptId);
    const captured=attempt && autonomySettings(core).autonomy==='on'?captureExecutionStop(core.store,runtime.executionScopes,attempt,'cancel'):null;
    const prior=captured&&runtime.executionScopes.stopResult(captured.E,captured.stopId);
    if(prior?.proof)return {executed:true,stopState:'proven',receipt:{stopped:true,stopProof:{...prior.proof,closeoutResult:prior}}};
    const agent = captured ? await resolveExecutionStop(runtime.executionScopes,captured,()=>executions.get(request.attemptId) ?? configuration.executionOf?.({attemptId:request.attemptId,executionSessionId:attempt?.executionSessionId})) :
      executions.get(request.attemptId) ?? await configuration.executionOf?.({ attemptId: request.attemptId, executionSessionId: attempt?.executionSessionId });
    const consumed=captured&&runtime.executionScopes.stopResult(captured.E,captured.stopId);
    if(consumed?.proof)return {executed:true,stopState:'proven',receipt:{stopped:true,stopProof:{...consumed.proof,closeoutResult:consumed}}};
    if (agent && agent.session.id !== attempt?.executionSessionId) return { unknown: true, reason: 'exact execution session mismatch' };
    if (!agent) return { unknown: true, reason: 'exact execution binding unavailable' };
    // Review 1 #1: with the switch on this port never reports a stop it did not observe. The proof is the receipt; a
    // prover that could not verify leaves the effect unproven, the attempt unknown and its slot occupied.
    if (attempt && autonomySettings(core).autonomy === 'on') {
      const stopProof = await proveExecutionStop(attempt, agent, captured);
      return { [stopProof.verified===true?'executed':'unknown']:true,stopState:stopProof.verified?'proven':'unverified',
        receipt:{stopped:stopProof.verified===true,stopProof} };
    }
    agent.cancel({ keepInbox: true }); await agent.whenIdle();
    return { executed: true, receipt: { stopped: true, evidenceRef: 'native-stop:' + request.operationId } };
  };
  // R5-3: one execution-authority check for every port that may touch a native agent. The routed execution, the
  // member generation, the attempt's own binding, the fence and this host's epoch must all agree. handles.get() is
  // never evidence of authority: an agent sits there after its attempt was released, and a newer agent may now hold
  // the same member id, so a port that reached for it would wake an execution this result never belonged to.
  const authority = (memberId, generation) => {
    const member = core.store.read(memberId);
    if (!member) return { ok: false, reason: 'no such member' };
    const binding = member.nativeRef ? router.routeExecution(member.nativeRef) : null;
    if (!binding?.routed) return { ok: false, reason: 'no routed execution' };
    if (binding.teamId !== teamId || binding.memberId !== memberId) return { ok: false, reason: 'execution belongs to another team or member' };
    if (binding.epoch !== host.epoch) return { ok: false, reason: 'execution belongs to an old epoch' };
    if (binding.generation !== generation || member.generation !== generation) return { ok: false, reason: 'member generation changed' };
    // R6-3: the lease rule is not restated here. TeamCore.authority is the one implementation (commands/lease.mjs
    // leaseOf) and it already refuses an expired lease, a foreign fence, an inactive member (desired !== 'active') and
    // a generation that moved; the host passes its own trusted clock. Everything else here only adds the router,
    // teamId/epoch and execution-session binding on top of it.
    let attempt;
    try { attempt = core.authority(binding.attemptId, binding.fence, host.clock.now()); }
    catch (error) { return { ok: false, reason: 'lease is not valid: ' + (error.message ?? String(error)) }; }
    if (attempt.owner !== memberId || attempt.generation !== binding.generation) return { ok: false, reason: 'attempt does not belong to this execution' };
    if (attempt.status !== 'running') return { ok: false, reason: 'attempt is not running' };
    if (hasUnknownExecutionEffect(core.store, attempt)) return { ok: false, reason: 'execution effect is unknown' };
    // The routed session is the execution session (sessions.mjs routeExecution reports it as sessionId); the attempt
    // must name the same one, or the binding points at an execution this attempt never started.
    if (attempt.executionSessionId !== binding.sessionId) return { ok: false, reason: 'execution session mismatch' };
    return { ok: true, member, binding, attempt };
  };
  // R6-2: the attempt-level first-dispatch record. Dispatch and mailbox are two producers of one fact - "this attempt
  // has already had its first turn opened" - so a mailbox wake that got there first is visible to a dispatch that
  // arrives after the turn ended, and the dispatch does not open a second one. Later messages are not gated by it:
  // each input still preempts or wakes by its own identity.
  const markDispatched = (attemptId, by) => {
    if (!attemptId) return null;
    const key = 'attempt-dispatch:' + attemptId;
    const prior = core.store.read(key);
    if (prior) return prior;
    host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, { attemptId, by, at: host.clock.now() }));
    return core.store.read(key);
  };
  // The one mailbox wake. A delivery is durable on its own; this wake only decides when the recipient's authorized
  // execution opens its next turn, and it happens at most once per (message, recipient) across retries and restarts.
  const bindEffectExecution = (effectId, current) => {
    const key = 'effect-execution:' + effectId;
    const binding = { attemptId: current.attempt.entityId, fence: current.attempt.fence,
      generation: current.attempt.generation, executionSessionId: current.binding.sessionId };
    const prior = core.store.read(key);
    if (prior) {
      if (prior.attemptId === binding.attemptId && prior.fence === binding.fence &&
        prior.generation === binding.generation && prior.executionSessionId === binding.executionSessionId) return true;
      const previous = core.store.effects().find(effect => effect.id === effectId)?.lastEvidence;
      // A proven refusal/scheduling wait can move to a new execution; an uncertain send cannot.
      if (previous?.notExecuted !== true && previous?.deferred !== true) return false;
    }
    host.coreAccess.lifecycle().mutate(key, 'adapter', binding, tx => tx.put(key, binding));
    return true;
  };
  const deliver = async (recipient, generation, messageId, effectId) => {
    const key = 'wake-receipt:' + messageId + ':' + recipient;
    const prior = core.store.read(key);
    if (prior && prior.generation === generation) {
      // Invalidated means stop scheduling, not proof that a pre-deadline request was never delivered. Its carrying
      // evidence may commit later; the core corrects this at visibility commit, and dedup also repairs older receipts.
      if (prior.delivered === false && mailboxVisibility(core, messageId, recipient, generation)) {
        const receipt = { ...prior, delivered: true, deliveryCorrected: true,
          deliveryEvidence: core.store.read(messageId)?.observation ?? core.store.read(messageId)?.visibility?.[recipient] ?? null };
        host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, receipt));
        return { outcome: 'executed', receipt: { ...receipt, deduplicated: true } };
      }
      return { outcome: 'executed', receipt: { ...prior, deduplicated: true } };
    }
    const invalidate = () => {
      const reason = mailboxInvalidation(core, messageId, recipient, generation, host.clock.now());
      if (!reason) return null;
      const receipt = { delivered: mailboxVisibility(core, messageId, recipient, generation),
        invalidated: true, reason, generation, dispatched: false };
      host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, receipt));
      return { outcome: 'executed', receipt };
    };
    const terminal = invalidate();
    if (terminal) return terminal;
    const current = authority(recipient, generation);
    if (!current.ok) return { outcome: 'noExecution', reason: 'stale wake binding: ' + current.reason };
    if (!bindEffectExecution(effectId, current)) return { outcome: 'unknown', reason: 'delivery effect belongs to another execution' };
    // A previous merge may have become visible since its deferred result. Close it without buying another turn.
    if (mailboxVisibility(core, messageId, recipient, generation)) {
      host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, { generation,
        attemptId: current.binding.attemptId, wake: 'visible', dispatched: false }));
      return { outcome: 'executed', receipt: { wake: 'visible', dispatched: false } };
    }
    const agent=runtime.handles.get(recipient)?.agent;
    const before=agent?.session?.snapshotEvents?.().findLast(e=>e.type==='step/start')?.seq??-1;
    // Review 3 #2: the turn this wake is bound to is read at the merge, not at the attempt's start (which may precede it).
    let mergeObservation = beginMailboxMerge(current, agent);
    let detach, timer, uncertain = false;
    try {
      let resolveStep;
      const nextStep=new Promise(resolve=>{resolveStep=resolve;});
      if(agent?.session) detach=ctx.on('session/event',(session,event)=>{if(session.id===agent.session.id&&event.type==='step/start'&&event.seq>before)resolveStep('step');});
      let outcome=runtime.preempt.deliverMail(recipient,messageId);
      // A queue latch is NOT proof that a later natural boundary occurred. Keep this very effect retryable until
      // visibility is committed, or its retry observes idle and owns the one wake edge. No turn/end followup driver.
      if (outcome.wake === 'queued') {
        const row = core.store.read(messageId);
        const visible = row?.entityId?.startsWith('thread-delivery:') ? ['visible', 'superseded'].includes(row.state)
          : row?.kind === 'intent' ? row.visibility?.[recipient] : row?.visible;
        if (!visible && row?.kind !== 'info') return { outcome: 'deferred', reason: 'input awaits a natural boundary or the next idle edge' };
      }
      if (outcome.wake === 'unknown') return { outcome: 'unknown', reason: 'input driver publishes no phase' };
      if(['live','coalesced'].includes(outcome.wake)&&agent?.whenIdle&&agent?.session?.snapshotEvents){
        const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),30000);timer.unref?.();});
        const edge=await Promise.race([nextStep,Promise.resolve(agent.whenIdle()).then(()=>'idle',()=>'idle'),timeout]);
        clearTimeout(timer);if(typeof detach==='function')detach();
        if(edge==='timeout')return {outcome:'deferred',reason:'awaiting a native step after the mailbox merge'};
        // A merge into the last milliseconds of a final step may buy no request. Do not confirm that as delivery:
        // the same effect owns the idle fallback, before its one durable wake receipt is committed.
        if (!sameAuthority(current, agent)) return { outcome: 'unknown', reason: 'mailbox execution changed during delivery' };
        const terminal = invalidate();
        if (terminal) return terminal;
        if(edge==='idle'&&agent.phase?.kind==='idle') {
          mergeObservation?.close();
          mergeObservation = beginMailboxMerge(current, agent);
          outcome=runtime.preempt.deliverMail(recipient,messageId);
        }
      }else if(typeof detach==='function')detach();
      if (!sameAuthority(current, agent)) return { outcome: 'unknown', reason: 'mailbox execution changed during delivery' };
      // R7-1: the wake's own outcome decides the receipt, exactly as it does for dispatch and intent-result. A driver
      // that refused did not execute; a driver that raised may have - that is unknown. Neither may be written as a
      // consumed delivery, and neither records the attempt as dispatched.
      if (outcome.wake === 'error') { uncertain = true; return { outcome: 'unknown', reason: 'mailbox wake is uncertain: ' + (outcome.error?.message ?? String(outcome.error)) }; }
      if (outcome.wake === 'refused') return { outcome: 'notExecuted', reason: 'the mailbox wake was refused by the driver' };
      // R8: a phase that executes nothing (upstream's maintenance) has no merge target either: no turn will read the
      // message at a later boundary of it, and nothing in the team store starts one by itself. The delivery stays
      // notExecuted, so the bounded retry can open the member's turn once the job ends and the phase is idle again;
      // neither the consumption receipt nor the shared first-dispatch record may be written here.
      // R9: upstream's maintenance phase ends by itself and gives the agent back as idle, so this wait is a schedule, not
      // an execution that failed. The effect is deferred (nextDue moves, no try spent, no receipt and no first-dispatch
      // fact) and the product's own cycle dispatches it once the job is over. Any other non-executing phase may never
      // end, so it keeps the bounded notExecuted path.
      if (outcome.wake === 'notExecuting' && outcome.defer === true) {
        return { outcome: 'deferred', reason: 'the member is in maintenance (' + (outcome.phase ?? 'maintenance') + '); the delivery waits for its idle phase' };
      }
      if (outcome.wake === 'notExecuting') return { outcome: 'notExecuted', reason: 'the mailbox has no merge target: the member is in ' + (outcome.phase ?? 'a non-executing phase') + ', not in a turn' };
      // The merge is a fact now: a wake that went into a running turn binds that turn, one that opened a turn binds the
      // turn whose start comes next. Nothing before this line is evidence that any turn belongs to this wake.
      if (outcome.wake === 'live' || outcome.wake === 'coalesced') markMailboxMerge(mergeObservation, 'live');
      else if (outcome.wake === 'woke') markMailboxMerge(mergeObservation, 'next');
      const dispatched = outcome.dispatched === true;
      if (dispatched) markDispatched(current.binding.attemptId, 'mailbox');
      if (!mailboxVisibility(core, messageId, recipient, generation)) {
        const terminal = invalidate();
        if (terminal) return terminal;
        return { outcome: 'deferred', reason: 'input was not carried by a committed request snapshot' };
      }
      host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, { generation,
        attemptId: current.binding.attemptId, wake: outcome.wake ?? null, reason: outcome.reason ?? null, dispatched }));
      return { outcome: 'executed', receipt: { wake: outcome.wake ?? null, reason: outcome.reason ?? null, dispatched } };
    } catch (error) {
      uncertain = true;
      throw error;
    } finally {
      clearTimeout(timer);
      if (typeof detach === 'function') detach();
      // A start followed by a thrown wake is NOT a confirmed merge or stop proof.
      // Drop observation only; the unknown effect/lease remains for recovery and verified stop.
      mergeObservation?.close(uncertain);
    }
  };
  ports.wake = async request => {
    const result = await deliver(request.recipient ?? request.memberId, request.generation,
      request.messageId ?? request.deliveryId, request.operationId);
    if (result.outcome === 'executed') return { executed: true, receipt: result.receipt };
    if (result.outcome === 'unknown') return { unknown: true, reason: result.reason };
    if (result.outcome === 'deferred') return { deferred: true, reason: result.reason };
    return { notExecuted: true, reason: result.reason };
  };
  // R5-2: an ordinary message effect is a delivery notice, never a transfer of responsibility: the durable row stays
  // the responsibility, so this port always closes with a receipt and never falls through to 'missing adapter port'.
  // The wake itself goes through the same mailbox edge and the same idempotency key as team.wake.
  ports.message = async request => {
    const message = core.store.read(request.messageId);
    if (!message || typeof message.recipient !== 'string') return { executed: true, receipt: { delivered: false, reason: 'no addressed recipient' } };
    const member = core.store.read(message.recipient);
    if (!member || message.generation !== member.generation) return { executed: true, receipt: { delivered: false, reason: 'stale recipient generation' } };
    const result = await deliver(message.recipient, message.generation, message.entityId, request.operationId);
    if (result.outcome === 'executed') return { executed: true, receipt: { delivered: true, ...result.receipt } };
    // R7-1: a wake that was refused or failed is not a consumed delivery. It is retried (bounded by the effect's
    // tries) or reported unknown, so the message is not silently confirmed as handled.
    if (result.outcome === 'unknown') return { unknown: true, reason: result.reason };
    // R9: a maintenance wait is deferred, never a consumed delivery and never a spent try.
    if (result.outcome === 'deferred') return { deferred: true, reason: result.reason };
    if (result.outcome === 'notExecuted') return { notExecuted: true, reason: result.reason };
    // No authorized execution to wake: the durable row is the delivery and the scheduler's mailbox task is the
    // fallback (F1 contract), so this notice closes without claiming any execution happened.
    return { executed: true, receipt: { delivered: false, reason: result.reason } };
  };
  // R5-2/R6-2: the first dispatch of a new attempt. The start close-out produced this effect (effects/protocol.mjs
  // start branch); it is bound to that attempt and executed by the one wake consumer, and it consults the shared
  // attempt-level record first, so a mailbox wake that already dispatched this attempt - even one whose turn ended
  // before this effect was claimed - is a legal merge rather than a second turn. A wake that was refused or failed is
  // never written as a receipt: it stays notExecuted (retryable, observable) or unknown.
  ports.dispatch = async request => {
    const current = authority(request.recipient, request.generation);
    if (!current.ok) return { notExecuted: true, reason: 'stale dispatch binding: ' + current.reason };
    if (current.binding.attemptId !== request.attemptId || current.binding.fence !== request.fence) return { notExecuted: true, reason: 'dispatch attempt superseded' };
    const prior = core.store.read('attempt-dispatch:' + request.attemptId);
    if (prior) return { executed: true, receipt: { dispatched: false, by: prior.by, reason: 'this attempt was already dispatched' } };
    const dispatchAgent = runtime.handles.get(request.recipient)?.agent;
    const mergeObservation = beginMailboxMerge(current, dispatchAgent);
    let uncertain = false;
    try {
      const wake = runtime.preempt.wakeIdle(request.recipient);
      if (!sameAuthority(current, dispatchAgent)) return { unknown: true, reason: 'dispatch execution changed during wake' };
      if (wake.error) { uncertain = true; return { unknown: true, reason: 'dispatch wake is uncertain: ' + (wake.error.message ?? String(wake.error)) }; }
      if (wake.fired === true) {
        // Review 3 #2: the wake opened this member's turn, so the turn whose start comes next is the one this mailbox
        // attempt lives for. Recorded here, at the merge - not read back from a journal at start time.
        markMailboxMerge(mergeObservation, 'next');
        markDispatched(request.attemptId, 'dispatch');
        return { executed: true, receipt: { dispatched: true, by: 'dispatch' } };
      }
      if (wake.reason === 'alreadyLive') {
        // The attempt already has a live turn (a mailbox delivery or another producer opened it): the legal merge.
        markMailboxMerge(mergeObservation, 'live');
        markDispatched(request.attemptId, 'live');
        return { executed: true, receipt: { dispatched: false, by: 'live', reason: 'the attempt already has a live turn' } };
      }
      // R9: the same maintenance wait, seen from the dispatch edge: deferred, not a bounded failure, and the retry
      // re-checks authority before it wakes anything.
      if (wake.reason === 'notExecuting' && wake.defer === true) return { deferred: true, reason: 'the attempt waits for maintenance to end' };
      return { notExecuted: true, reason: 'dispatch wake not executed: ' + wake.reason };
    } catch (error) { uncertain = true; throw error; } finally { mergeObservation?.close(uncertain); }
  };
  // R5-3/R6-1: an intent conclusion addresses the execution recorded when the window opened, never whichever agent is
  // bound to the sender now, and the owner path is selected from that trusted binding - the product's owner tool acts
  // as 'member:root', so a literal-string check would miss it. A released or superseded execution leaves the result in
  // the journal for a later legal consumption; the owner result is delivered by the durable row (F1 does not drive the
  // owner session), which is a normal confirmation, not a dead letter.
  ports['intent-result'] = async request => {
    const message = core.store.read(request.messageId);
    if (!message) return { notExecuted: true, reason: 'intent result message is missing' };
    const initiator = message.initiator ?? null;
    if (!initiator || initiator.memberId !== message.sender) return { notExecuted: true, reason: 'the intent carries no trusted initiator binding' };
    const key = 'intent-result-receipt:' + request.messageId;
    if (initiator.kind === 'owner') {
      const owner = core.store.read(initiator.memberId);
      if (!owner || owner.role !== 'root') return { notExecuted: true, reason: 'owner binding does not name a root member' };
      if (core.store.read(key)) return { executed: true, receipt: { deduplicated: true } };
      host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, { owner: initiator.memberId, delivered: request.messageId }));
      return { executed: true, receipt: { owner: initiator.memberId, delivered: request.messageId, dispatched: false } };
    }
    if (initiator.kind !== 'execution' || !initiator.attemptId || !Number.isInteger(initiator.generation)) {
      return { notExecuted: true, reason: 'the intent was opened without an executing attempt' };
    }
    const current = authority(message.sender, initiator.generation);
    if (!current.ok) return { notExecuted: true, reason: 'intent initiator has no authorized execution: ' + current.reason };
    if (current.binding.attemptId !== initiator.attemptId || current.binding.fence !== initiator.fence) {
      return { notExecuted: true, reason: 'intent result belongs to a superseded execution' };
    }
    if (core.store.read(key)) return { executed: true, receipt: { deduplicated: true } };
    if (!bindEffectExecution(request.operationId, current)) return { unknown: true, reason: 'intent result effect belongs to another execution' };
    const wake = runtime.preempt.wakeIdle(message.sender);
    if (wake.error) return { unknown: true, reason: 'intent result wake is uncertain: ' + (wake.error.message ?? String(wake.error)) };
    if (wake.fired === true) {
      host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, { attemptId: initiator.attemptId, woke: true }));
      return { executed: true, receipt: { dispatched: true } };
    }
    if (wake.reason === 'alreadyLive') {
      host.coreAccess.lifecycle().mutate(key, 'adapter', {}, tx => tx.put(key, { attemptId: initiator.attemptId, woke: false, reason: 'alreadyLive' }));
      return { executed: true, receipt: { dispatched: false, reason: 'the initiator already has a live turn' } };
    }
    if (wake.reason === 'notExecuting' && wake.defer === true) return { deferred: true, reason: 'the intent result waits for maintenance to end' };
    return { notExecuted: true, reason: 'intent result wake not executed: ' + wake.reason };
  };
  ports.gc = async () => {
    if (typeof configuration.gc === 'function') return configuration.gc();
    artifacts ??= new ArtifactStore(configuration.artifactRoot ?? configuration.root);
    artifacts.gc(host.clock.now());
    return { executed: true, receipt: { collectedAt: host.clock.now() } };
  };
  // R9: the pre-claim half of the maintenance rule. Asking before the claim is what keeps a wait from spending a try;
  // the answer only names the scheduling fact (this member's agent is in a maintenance phase right now). Every other
  // check - lease, generation, epoch, ownership, stop, completion fence - still runs in the port when the effect is
  // retried after the job ends.
  const deferrableKinds = new Set(['wake', 'message', 'dispatch', 'intent-result']);
  // The member a deferred effect is waiting for, resolved the same way for the scheduling question and for the report a
  // capability shows (R10): one resolver, so "who is this wait about" can never disagree with "can it run now".
  const deferralMember = effect => {
    const p = effect?.payload;
    if (!p) return null;
    if (p.kind === 'message') return core.store.read(p.messageId)?.recipient ?? null;
    if (p.kind === 'intent-result') {const target=effectExecutionTarget(core.store,p);return target.kind==='execution'?target.memberId:null;}
    return p.recipient ?? p.memberId ?? p.owner ?? null;
  };
  // Closing an obsolete notice is control-plane bookkeeping, not member IO. It needs neither a running scope nor
  // an idle agent, and must not be trapped behind maintenance deferral after its responsibility disappeared.
  const noticeInvalidated = p => {
    if (!p || !['wake', 'message'].includes(p.kind)) return false;
    const id = p.messageId ?? p.deliveryId, row = core.store.read(id);
    const recipient = p.recipient ?? p.memberId ?? row?.recipient;
    return Boolean(mailboxInvalidation(core, id, recipient, p.generation ?? row?.generation, host.clock.now()));
  };
  const deferrable = effect => {
    const p = effect?.payload;
    if (!p || !deferrableKinds.has(p.kind) || noticeInvalidated(p)) return false;
    const memberId = deferralMember(effect);
    return typeof memberId === 'string' && runtime.preempt?.maintenance(memberId) === true;
  };
  const delivery = createHostDelivery({ core, access: host.coreAccess, repository: configuration.repository ?? configuration.root,
    gitRoots: configuration.gitRoots ?? [configuration.root], port: configuration.deliveryPort ?? null });
  ports.delivery = async request => {
    let transition;
    await delivery.reconcile(request.taskId, { route: { dispatch(entityId, actor, payload, command) {
      if (entityId !== request.deliveryId || actor !== 'root' || command.type !== 'delivery.transition') throw Error('DENIED');
      transition = structuredClone(command); return { result: command.payload };
    } } });
    return { executed: true, receipt: { transition } };
  };
  // P4 §6.2: the capability table exists only while the autonomy switch is on, and it names every kind this composition
  // can emit — derived from the ports it actually serves plus the one kind the runner closes itself. An undeclared kind
  // therefore refuses the host at start-up instead of being treated as retryable: "no declaration" is never "probably
  // safe to send again". With the switch off nothing here is built, and the runner keeps the ledger's own rule.
  const autonomyNow = autonomySettings(core);
  const ownerControl = core.configuration.superagentBorrow === 'v1' ? createOwnerControl({core,ctx,teamId,ownerSessionId,epoch:()=>host.epoch,
    authorize:work=>host.executeAuthorized('business',work),now:()=>host.clock.now(),verifyTerminated:configuration.verifyOwnerTerminated}) : null;
  if(ownerControl)core.ports.ownerControl=ownerControl;
  const ownerInput = core.configuration.superagentBorrow === 'v1' ? createOwnerInputPort({ core,
    arbiter: runtime.preempt, route: routeInputSession, teamId, ownerSessionId, epoch: () => host.epoch,
    agent: ctx.agents.get(ownerSessionId), hostControl: runtime.hostControl, control: core.ports.ownerControl }) : null;
  if(autonomyNow.autonomy==='on')for(const kind of ['dispatch','wake','message','intent-result']) {
    const controlPort = ports[kind];
    const memberPort = permitEffectPort({store:core.store,scopes:runtime.executionScopes,handles:runtime.handles,invoke:controlPort,kind});
    ports[kind] = request => {
      const payload = core.store.effects().find(e => e.id === request.operationId)?.payload;
      if (noticeInvalidated(payload ?? { ...request, kind })) return controlPort(request);
      return ownerInput && ['wake','message'].includes(kind) && payload?.targetKind === 'owner' ? ownerInput(request) : memberPort(request);
    };
  }
  const effectKinds = [...new Set([...Object.keys(ports), 'release-task', 'member-lifecycle'])].sort();
  // §6.2.2 and M1b §E deviation (3): delivery is read back through the port that already exists (the git readback plus
  // delivery.transition), never through a second implementation; the wrapper only translates "came back unknown" into
  // the vocabulary the capability table reads.
  const deliveryReadback = async request => {
    const result = await ports.delivery(request);
    const status = result?.receipt?.transition?.payload?.status;
    if (status === 'accepted') return { executed: true, receipt: result.receipt, readback: 'git' };
    return { unknown: true, reason: 'the git readback did not prove the delivery landed (' + String(status ?? 'no transition') + ')' };
  };
  runner = createEffectRunner({ access: host.coreAccess, ports, clock: host.clock, verifyStopped: configuration.verifyExternalStop, deferrable, teamId, hostEpoch: () => host.epoch,
    ...(ownerControl?{capacityLanes:{store:core.store,classify:effect=>effectTrafficClass(core.store,effect),
      // One row per claim: (effectId, fence). The transaction re-checks the row it releases, so an old fence can never
      // overwrite a newer claim and two concurrent reclaims cannot both report success.
      persist:row=>{const {claimKey,...value}=row;const key=claimKey??effectIoClaimKey(value.effectId,value.fence);return core.controlFact(key,value,tx=>{
        const current=tx.read(key);
        if(!current){if(value.state==='released')throw Object.assign(Error('CLAIM_GONE'),{code:'CLAIM_GONE'});return tx.put(key,value);}
        if(current.effectId!==value.effectId||current.fence!==value.fence)throw Object.assign(Error('CLAIM_MISMATCH'),{code:'CLAIM_MISMATCH'});
        if(value.state==='released'&&current.state==='released')throw Object.assign(Error('CLAIM_ALREADY_RELEASED'),{code:'CLAIM_ALREADY_RELEASED'});
        return tx.put(key,value);});},
      queue:()=>{const q=core.store.effects().filter(e=>['pending','retryable'].includes(e.status));return {
        normal:q.filter(e=>effectTrafficClass(core.store,e)==='normal').length,human:q.filter(e=>effectTrafficClass(core.store,e)==='human').length,
        oldestAge:q.length?Math.max(0,host.clock.now()-Math.min(...q.map(e=>core.store.read(e.payload.messageId??e.payload.attemptId??e.payload.deliveryId)?.createdAt??host.clock.now()))):null,
        origins:q.map(e=>e.payload.originRef).filter(Boolean)};}}}:{}),
    memberOf: deferralMember, alertAfterMs: configuration.deferAlertMs ?? 30000,
    ...(autonomyNow.autonomy === 'on' ? { capabilities: { on: true, kinds: effectKinds, store: core.store, teamId,
      readbacks: { git: deliveryReadback }, ttlMs: autonomyNow.decisionTtlMs,
      readbackTimeoutMs: configuration.readbackTimeoutMs ?? 15000 } } : {}),
    onReceipt: effectId => {
      if (host.state !== 'running') return;
      // Review 2 #3: a mailbox release that arrived while this start effect was still unconfirmed is applied now, in
      // the receipt's own turn, so it never competes with the close-out that just committed.
      // A turn may finish while message/wake/dispatch is still applying. Revisit every
      // deferred release after any receipt; unknown drops the request without releasing.
      if(autonomySettings(core).autonomy!=='on')for (const request of [...legacyPendingReleases.values()]) releaseMailbox(request);
      const binding=core.store.read('effect-execution:'+effectId);
      if(binding)maybeCloseExecution(runtime.executionScopes?.get(binding.executionSessionId));
      const effect = core.store.effects().find(row => row.id === effectId);
      if (effect?.status === 'confirmed') {
        const p = effect.payload, member = core.store.read(p.memberId ?? p.owner);
        if(['cancel','cancel-member','dispose'].includes(p.kind)) {
          const proof=effect.lastEvidence?.receipt?.stopProof;
          for(const cert of proof?.certificates??(proof?.E?[proof]:[])) {
            const scope=runtime.executionScopes?.get(cert.E.executionSessionId);
            try {scope?.released(cert);}catch(error){mailboxReleases.push({attemptId:cert.E.attemptId,code:error.code,message:error.message});}
          }
        }
        if (['create', 'resume'].includes(p.kind) && member?.nativeRef) bind(member.entityId, member.nativeRef, member.generation);
        if (['dispose', 'cancel-member'].includes(p.kind) && member?.nativeRef) unbind(member.nativeRef);
        if (p.kind === 'start') {
          const agent = executions.get(p.attemptId), attempt = core.store.read(p.attemptId);
          if (agent && attempt?.status === 'running' && attempt.lease === 'active') {
            runtime.preempt.bind(member.entityId, agent);
            bind(member.entityId, agent.session.id, attempt.generation, { attemptId: p.attemptId, fence: attempt.fence, epoch: host.epoch });
            // start prepares authority; wake effects own dispatch.
          }
        }
      }
      pruneExecutions();
      host.cycle?.kick('receipt');
    } });
  const goal = createGoalRecovery({ core, gate, clock: host.clock, sessionLog: options => openSessionLog({ ...options, context: ctx }) });
  recovery = createRecovery({ core, access: host.coreAccess, goal,
    delivery: { reconcileApplying: options => delivery.reconcileApplying({ ...options, route: host.coreAccess.deliveryRecovery() }) } });
  manager.profileHost = host;
  // Review 1 #3: the tool entry that decides a completion token runs inside the core, and the admission the token held
  // closed belongs to this host. The core publishes the refresh here, once, from the one place that owns admission;
  // core-access/runtime.mjs only ever calls it, after the verdict committed.
  if (core && core.ports && typeof core.ports === 'object') {
    core.notifyDecisionSettled = () => host.refreshAdmission();
  }
  try { await manager.ensureOwner({ root: configuration.root, ownerSessionId }); }
  catch (error) { await manager.close(); throw error; }
  if (host.status().admission && !core.store.read('member:root')) host.executeAuthorized('business', () => core.member('member:root', 'root'));
  safety = recovery.safetyCapabilities();
  for (const capability of safety) runner.pumpSafety(capability);
  function routeInputSession(id) {
    const r = router.route(id);
    if (!r?.routed || r.teamId !== teamId) return null;
    if (r.kind === 'execution') {
      const E = core.store.read('execution-current:' + r.attemptId)?.E;
      if (!E || E.teamId !== teamId || E.memberId !== r.memberId || E.generation !== r.generation ||
          E.attemptId !== r.attemptId || E.attemptFence !== r.fence || E.executionSessionId !== id) return null;
      return { ...r, executionEpoch: E.executionEpoch };
    }
    const root = core.store.read('member:root');
    if (r.kind !== 'owner' || id !== ownerSessionId || root?.role !== 'root' || root.desired !== 'active') return null;
    return { ...r, ownerSessionId, memberId: root.entityId, generation: root.generation, epoch: host.epoch };
  };
  const visibility = createVisibility({ host, core, sessions, routeExecution: id => router.routeExecution(id),
    routeInputSession, inputArbiter: runtime.preempt, isMain: await mainRequestPredicate() });
  // The dispatch path is a property of the transport that carried the request, and the evidence surface reports one
  // capability per path. 'offline' is the scripted/dry transport; a deepseek provider is the production adapter; the CPA
  // transport names itself. Anything else stays 'other' and is visible as unconfirmed rather than being guessed.
  const pathOf = event => event?.provider === 'offline' ? 'fake'
    : typeof event?.provider === 'string' && event.provider.includes('deepseek') ? 'deepseek-adapter'
      : typeof event?.transport === 'string' && event.transport === 'real-cpa' ? 'real-cpa-transport'
        : 'other';
  const detachVisibility = registerVisibility(ctx, visibility, { host, markDirty: visibilityDirty, pathOf,
    sessionIdOf: payload => payload.agent?.session?.id, newMessageId: () => 'message:' + randomUUID() });
  const gc = createGarbageCollector({ access: host.coreAccess, clock: host.clock, now: () => host.clock.now(), intervalMs: configuration.gcIntervalMs ?? 60000 });
  gc.arm();
  const ended = ctx.on('session/disposed', async session => { const binding=router.route(session.id); if (!binding.routed) return; if (binding.kind === 'owner') await stop(); else unbind(session.id); });
  const guard = ctx.goals.registerCompletionGuard(input => router.route(input.sessionId).routed ? gate.check(input) : true);
  const detach = ctx.on('session/event', (session, event) => { const route = router.route(session.id); if (!route.routed) return; gate.inspect(session, event); host.cycle.kick('session/event'); });
  let stopping = null;
  const stop = () => stopping ??= (async () => { runtime.roleGuard?.revoke?.(); ownerControl?.stop(); detachVisibility(); if (typeof ended === 'function') ended(); if (typeof guard === 'function') guard(); gc.stop(); if (typeof detach === 'function') detach(); const result = await host.stop(); runner.stop(); for (const watcher of [...mailboxWatchers.values()]) watcher.done(); mailboxMerges.clear(); legacyPendingReleases.clear(); detachMailboxTurns(); mailboxTurns.clear(); executions.clear(); artifacts?.close(); await manager.close(); core.store.close(); return result; })();
  const authenticated = new WeakSet();
  function bindPrincipal(identity) {
    if (!identity || typeof identity.teamId !== 'string' || typeof identity.memberId !== 'string') throw Error('INVALID_PRINCIPAL');
    const principal = Object.freeze({ teamId: identity.teamId, memberId: identity.memberId }); authenticated.add(principal); return principal;
  }
  async function adjudicate(request, authentication) {
    const actor = authenticated.has(authentication) && authentication.teamId === teamId && authentication.memberId === 'operator' ? 'operator' : null;
    if (actor !== 'operator') throw Object.assign(Error('DENIED'), { code: 'DENIED' });
    const token = core.store.read(request.tokenId);
    if (!token?.input?.sessionId) throw Object.assign(Error('DENIED'), { code: 'DENIED' });
    const log = await openSessionLog({ sessionId: token.input.sessionId, context: ctx });
    if (!log || log.complete !== true) throw Object.assign(Error('SESSION_LOG_UNAVAILABLE'), { code: 'SESSION_LOG_UNAVAILABLE' });
    if (host.state !== 'running' || !host.ownership.verify().ok) throw Object.assign(Error('WRITE_REVOKED'), { code: 'WRITE_REVOKED' });
    const events = log.events ?? log.snapshotEvents();
    const result = gate.resolveCompletion({ id: token.input.sessionId, seq: log.seq, snapshotEvents: () => events }, request.tokenId, request.decision, request.evidence, actor);
    host.refreshAdmission(); return result;
  }
  const humanInput=ownerControl?createHumanInputGateway({core,teamId,ownerSessionId,now:()=>host.clock.now(),
    authorize:work=>host.executeAuthorized('business',work),authenticate:credential=>
      configuration.authenticateHumanInput?.(credential)??null}):null;
  return { host, manager, runner, visibility, delivery, gc, router, stop, adjudicate, bindPrincipal, mailboxReleases,
    ...(ownerControl?{humanInput,ownerControl}:{}),
    status: () => ({ ...host.status(), ...(runtime.projectionStatus ? { projection: runtime.projectionStatus() } : {}), ...(ownerControl?{capacity:capacityStatus(core,host.clock.now()),ownerControl:ownerControl.status(),storage:core.store.storageStatus()}:{}), ...(host.status().evidenceRetention ? { evidenceRetention: host.status().evidenceRetention } : {}), ...(runtime.roleGuard ? { roleGuard: { ...runtime.roleGuard.status(), ownerModel: runtime.ownerModel ?? null } } : {}), effects: runner.status(), gc: gc.status(), executionBindings: executions.size, mailboxReleases: [...mailboxReleases],executionCloseout:[...closeoutChecks.values()],executionAlerts:core.store.list('execution-alert:') }) };
}
