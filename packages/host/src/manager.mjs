import { failWith } from '../../contracts/index.mjs';
import { canonicalTeamDir, teamDirKey } from './paths.mjs';
import { TeamRegistry } from './registry.mjs';
import { createTeamHost } from './host.mjs';

/**
 * One manager per context, one driver per team; M1b design §4.3.
 *
 * The manager owns the processes' team registry (one global lock), the Map<teamId, TeamHost>, and the rule that a
 * canonical team directory is mounted at most once. Everything a profile registers hooks for is registered once, on
 * the context, by the composition root; the manager routes by session and never broadcasts.
 *
 * TEAM_HOST_MOUNTED is the F1 answer to a second apply: the profile checks it before it touches anything, so a
 * duplicate mount cannot create a second cycle, a second set of timers or a second completion guard.
 */
export const MANAGER_MARKER = 'teamHosts';

export function assertSingleMount(ctx, marker = 'teamRuntime') {
  // ctx.get first: on a cordis context, reading an undeclared service property throws, which would turn the first
  // legitimate mount into TEAM_HOST_MOUNTED. A plain object (tests, a composition root of its own) falls back to the
  // property.
  let existing = null;
  try {
    existing = ctx && typeof ctx.get === 'function' ? ctx.get(marker) : ctx ? ctx[marker] : null;
  } catch {
    existing = null;
  }
  if (existing) failWith('TEAM_HOST_MOUNTED', 'this context already has ' + marker + '; a second team host mount is refused (F1)');
  return true;
}

export class TeamManager {
  #ctx;
  #registry;
  #hosts = new Map();
  #dirs = new Map();
  #createHost;
  #now;
  #pendingOwners = new Map();
  #singleTeam;

  constructor({ ctx = null, home, now = Date.now, registry = null, singleTeam = false, createHost = createTeamHost } = {}) {
    this.#ctx = ctx; this.#singleTeam = singleTeam;
    this.#registry = registry ?? new TeamRegistry({ home, now });
    this.#createHost = createHost;
    this.#now = now;
  }

  get registry() {
    return this.#registry;
  }

  get size() {
    return this.#hosts.size;
  }

  async open(signal = null) {
    await this.#registry.open(signal);
    return this;
  }

  /**
   * Mount one team. The directory is canonicalised first: a relative path, a trailing separator, a junction or a
   * different case all resolve to one key, and the second mount of that key is refused.
   */
  async mount({ teamId, root, ownerSessionId = null, config = {} } = {}) {
    if (typeof teamId !== 'string' || !teamId) failWith('INVALID_TEAM', 'mount needs a teamId');
    if (this.#singleTeam && this.#hosts.size && !this.#hosts.has(teamId)) throw Error('MULTI_TEAM_NOT_SUPPORTED');
    const dir = canonicalTeamDir(root);
    const key = teamDirKey(dir);
    const existing = this.#hosts.get(teamId);
    if (existing) failWith('TEAM_ALREADY_MOUNTED', 'team ' + teamId + ' is already mounted by this manager');
    const alias = this.#dirs.get(key);
    if (alias) failWith('TEAM_ALIAS_TAKEN', 'directory ' + key + ' is already mounted as team ' + alias);
    const host = this.#createHost({ teamId, root: dir, ownerSessionId, ...config });
    this.#hosts.set(teamId, host);
    this.#dirs.set(key, teamId);
    try {
      await host.start();
    } catch (error) {
      this.#hosts.delete(teamId);
      this.#dirs.delete(key);
      await host.stop({ timeoutMs: 100 }).catch(() => {});
      throw error;
    }
    return host;
  }

  /** Owner creation is single-flight inside the globally exclusive registry. */
  ensureOwner({ ownerSessionId, root, config = {} }) {
    if (this.#pendingOwners.has(ownerSessionId)) return this.#pendingOwners.get(ownerSessionId);
    if (this.#singleTeam && this.#registry.list().some(row => row.ownerSessionId !== ownerSessionId)) throw Error('MULTI_TEAM_NOT_SUPPORTED');
    const row = this.#registry.reserve({ ownerSessionId, dir: root });
    const existing = this.#hosts.get(row.teamId);
    if (existing) return Promise.resolve(existing);
    const work = this.mount({ teamId: row.teamId, root: row.dir ?? root, ownerSessionId, config }).then(host => {
      this.#registry.markReady(row.teamId); return host;
    }).finally(() => this.#pendingOwners.delete(ownerSessionId));
    this.#pendingOwners.set(ownerSessionId, work);
    return work;
  }

  team(teamId) {
    return this.#hosts.get(teamId) ?? null;
  }

  teams() {
    return [...this.#hosts.keys()].sort();
  }

  /**
   * Unmount stops one host. The persistent row stays: an unmount is a shutdown, not a deletion, so a restart still
   * knows which session owns which team. Deletion is manager.destroy(), archiving is manager.archive().
   */
  async unmount(teamId, { timeoutMs } = {}) {
    const host = this.#hosts.get(teamId);
    if (!host) return null;
    const key = teamDirKey(host.root);
    this.#hosts.delete(teamId);
    this.#dirs.delete(key);
    const stopped = await host.stop({ timeoutMs });
    if (this.#registry.held) this.#registry.markUnmounted(teamId);
    return stopped;
  }

  /** Archive one team: the row keeps the owner mapping and records that the team is no longer active. */
  async archive(teamId) {
    return this.#registry.archive(teamId);
  }

  /** Destroy one team: stop its host if it is mounted here, then remove the persistent row. */
  async destroy(teamId, options = {}) {
    if (this.#hosts.has(teamId)) await this.unmount(teamId, options);
    return this.#registry.destroy(teamId);
  }

  async stopAll(options = {}) {
    const results = [];
    for (const teamId of this.teams()) results.push(await this.unmount(teamId, options));
    return results;
  }

  status() {
    return {
      open: this.#registry.held,
      teams: this.teams().map(teamId => {
        const host = this.#hosts.get(teamId);
        const status = host.status();
        return { teamId, state: status.state, admission: status.admission, epoch: status.epoch, lastCycle: status.lastCycle };
      }),
    };
  }

  async close(options = {}) {
    await this.stopAll(options);
    return this.#registry.close();
  }
}
