import { failWith } from '../../contracts/index.mjs';

/**
 * Session routing and team registration; docs/host-protocol.md §2.3, invariant 11.
 *
 * Two separate maps, never folded into one:
 *   ownerSessionId     <-> teamId                        (one team and one lead session, one to one)
 *   executionSessionId  -> (teamId, memberId, generation) (one member generation of one team)
 *
 * Every global entry point routes first and handles second. An unmapped session gets an explicit "not routed"
 * answer; broadcasting to every team and letting each one try is forbidden (rule 3).
 */
export const UNROUTED = Object.freeze({ routed: false, reason: 'unmapped' });

const unrouted = detail => ({ ...UNROUTED, ...detail });

function requiredId(value, name) {
  if (typeof value !== 'string' || !value) failWith('INVALID_SESSION_BINDING', name + ' must be a non-empty string');
}

function requiredGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) failWith('INVALID_SESSION_BINDING', 'generation must be a positive integer');
}

export class SessionRouter {
  #teams = new Map();
  #owners = new Map();
  #executions = new Map();

  /** Bind a lead session to its team. One owner session owns one team and one team has one owner session. */
  registerTeam({ teamId, ownerSessionId, host = null } = {}) {
    requiredId(teamId, 'teamId');
    requiredId(ownerSessionId, 'ownerSessionId');
    const boundTeam = this.#owners.get(ownerSessionId);
    if (boundTeam && boundTeam !== teamId) {
      failWith('OWNER_ALREADY_BOUND', 'lead session ' + ownerSessionId + ' already owns ' + boundTeam);
    }
    const existing = this.#teams.get(teamId);
    if (existing) {
      if (existing.ownerSessionId !== ownerSessionId) {
        failWith('TEAM_ALREADY_OWNED', 'team ' + teamId + ' is already owned by ' + existing.ownerSessionId);
      }
      existing.host = host ?? existing.host;
      return existing;
    }
    const entry = { teamId, ownerSessionId, host };
    this.#teams.set(teamId, entry);
    this.#owners.set(ownerSessionId, teamId);
    return entry;
  }

  /** Drop a team, its owner map and every execution binding that belongs to it. */
  unregisterTeam(teamId, { host = null } = {}) {
    const entry = this.#teams.get(teamId);
    if (!entry) return false;
    if (host && entry.host && entry.host !== host) return false;
    this.#teams.delete(teamId);
    if (this.#owners.get(entry.ownerSessionId) === teamId) this.#owners.delete(entry.ownerSessionId);
    for (const [sessionId, binding] of [...this.#executions]) {
      if (binding.teamId === teamId) this.#executions.delete(sessionId);
    }
    return true;
  }

  /** Bind (or rebind, on a new generation) one native execution session to a member of an existing team. */
  bindExecution({ executionSessionId, teamId, memberId, generation, attemptId = null, fence = null, epoch = null } = {}) {
    requiredId(executionSessionId, 'executionSessionId');
    requiredId(teamId, 'teamId');
    requiredId(memberId, 'memberId');
    requiredGeneration(generation);
    if (!this.#teams.has(teamId)) {
      failWith('NOT_ROUTED', 'execution session ' + executionSessionId + ' names team ' + teamId + ', which this process does not host');
    }
    const existing = this.#executions.get(executionSessionId);
    if (existing && (existing.teamId !== teamId || existing.memberId !== memberId)) {
      failWith('EXECUTION_SESSION_CONFLICT', 'execution session ' + executionSessionId + ' already belongs to ' + existing.teamId + '/' + existing.memberId);
    }
    if (attemptId !== null && (typeof attemptId !== 'string' || !attemptId.startsWith('attempt:') ||
      !Number.isSafeInteger(fence) || fence < 1 || !Number.isSafeInteger(epoch) || epoch < 1)) {
      failWith('INVALID_BINDING', 'execution lease binding needs attemptId, fence and epoch');
    }
    const binding = { teamId, memberId, generation, ...(attemptId === null ? {} : { attemptId, fence, epoch }) };
    this.#executions.set(executionSessionId, binding);
    return { executionSessionId, ...binding };
  }

  unbindExecution(executionSessionId, { generation = null } = {}) {
    const existing = this.#executions.get(executionSessionId);
    if (!existing) return false;
    if (generation !== null && existing.generation !== generation) return false;
    this.#executions.delete(executionSessionId);
    return true;
  }

  routeOwner(sessionId) {
    const teamId = this.#owners.get(sessionId);
    return teamId ? { routed: true, kind: 'owner', teamId, sessionId } : unrouted({ sessionId });
  }

  routeExecution(sessionId) {
    const binding = this.#executions.get(sessionId);
    return binding ? { routed: true, kind: 'execution', sessionId, ...binding } : unrouted({ sessionId });
  }

  /** Owner mapping first, then the execution mapping. Never a broadcast. */
  route(sessionId) {
    const owner = this.routeOwner(sessionId);
    return owner.routed ? owner : this.routeExecution(sessionId);
  }

  teamSessions(teamId) {
    const entry = this.#teams.get(teamId);
    if (!entry) failWith('NOT_ROUTED', 'team ' + teamId + ' is not hosted in this process');
    const executions = [...this.#executions]
      .filter(([, binding]) => binding.teamId === teamId)
      .map(([sessionId, binding]) => ({ sessionId, ...binding }));
    return { teamId, ownerSessionId: entry.ownerSessionId, executions };
  }

  /**
   * Route a session event. Only the lead (owner) session ending stops the team (rule 6): a member execution session
   * ending only detaches its own binding and leaves the team, its other members and other teams alone.
   */
  async handleSessionEnd({ sessionId, timeoutMs } = {}) {
    const route = this.route(sessionId);
    if (!route.routed) return { ...route, action: 'none' };
    if (route.kind === 'owner') {
      const host = this.#teams.get(route.teamId)?.host ?? null;
      const stopped = host && typeof host.stop === 'function' ? await host.stop({ timeoutMs }) : null;
      return { routed: true, kind: 'owner', teamId: route.teamId, sessionId, action: 'team-stopped', stopped: Boolean(stopped), stop: stopped };
    }
    this.unbindExecution(sessionId, { generation: route.generation });
    return {
      routed: true, kind: 'execution', teamId: route.teamId, memberId: route.memberId, generation: route.generation,
      sessionId, action: 'binding-ended',
    };
  }
}

/** Process-wide router used by hosts created without an explicit router. */
export const sessionRouter = new SessionRouter();
