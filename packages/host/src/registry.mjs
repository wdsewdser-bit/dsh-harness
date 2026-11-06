import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { failWith } from '../../contracts/index.mjs';
import { canonicalTeamDir, teamDirKey } from './paths.mjs';
import { lockTarget } from './ownership.mjs';

/**
 * The per-DSH_HOME team registry; M1b design §4.1, §4.2.
 *
 * One manager per DSH_HOME, proven by an OS-level exclusive name on the home directory (the same mechanism
 * host/src/ownership.mjs uses for a team directory). A second manager fails REGISTRY_LOCKED before it reads or writes
 * the file, so "two processes each created their own team and both succeeded" cannot happen.
 *
 * Ownership is claimed by a placeholder row: { teamId, ownerSessionId, status: 'creating' } written and fsynced
 * before the team exists, flipped to 'ready' once it does. The placeholder is also the unique constraint that makes
 * two concurrent creations for the same owner return the same teamId instead of two teams.
 */
export const REGISTRY_FILE = 'team-registry.json';
const REGISTRY_VERSION = 1;

/** team-<32 hex>: server-generated, no colon, so it can never be confused with a member id. */
export function newTeamId() {
  return 'team-' + randomBytes(16).toString('hex');
}

function listenExclusive(target) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    const settle = (callback, value) => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      callback(value);
    };
    const onError = error => settle(reject, error);
    const onListening = () => settle(resolve, server);
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(target);
    } catch (error) {
      settle(reject, error);
    }
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server) return resolve(false);
    try {
      server.close(error => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

export class TeamRegistry {
  #home;
  #file;
  #now;
  #lock = null;
  #server = null;
  #closed = false;
  #bytes = 0;

  constructor({ home, now = Date.now } = {}) {
    if (typeof home !== 'string' || !home.trim()) failWith('INVALID_HOME', 'the registry needs a non-empty DSH_HOME');
    this.#home = canonicalTeamDir(home);
    this.#file = path.join(this.#home, REGISTRY_FILE);
    this.#now = now;
  }

  get home() {
    return this.#home;
  }

  get file() {
    return this.#file;
  }

  get held() {
    return Boolean(this.#server && this.#server.listening);
  }

  /**
   * Every data entry point runs this first. A registry that was never opened, whose open() was refused (the name was
   * taken), or that has been closed has no right to read or write the file: the lock is what makes this process the
   * one that may change the mapping, so without it the answer is a refusal, not a best effort.
   */
  #assertLock() {
    if (this.#closed) failWith('REGISTRY_CLOSED', 'the team registry was closed; a closed registry takes no reads or writes');
    if (!this.held) failWith('REGISTRY_NOT_OPEN', 'the team registry is not open: open() must hold the global name before any read or write');
  }

  /** Take the global name. A second manager is refused here, before the file is even opened. */
  async open(signal = null) {
    if (this.#closed) failWith('REGISTRY_CLOSED', 'the registry was closed');
    fs.mkdirSync(this.#home, { recursive: true });
    const key = 'registry:' + teamDirKey(this.#home);
    this.#lock = lockTarget(this.#home, key);
    try {
      this.#server = await listenExclusive(this.#lock.target);
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        failWith('REGISTRY_LOCKED', 'another manager holds ' + this.#lock.kind + ' ' + JSON.stringify(this.#lock.target) + ' for ' + this.#home);
      }
      failWith('REGISTRY_UNAVAILABLE', 'the registry lock could not be opened (' + (error.code || error.message) + ')');
    }
    if (signal && signal.aborted) {
      await closeServer(this.#server);
      this.#server = null;
      failWith('HOST_STOPPED', 'the registry lock was cancelled');
    }
    this.#server.unref();
    this.#server.on('error', () => {});
    return this;
  }

  /** The parsed registry, or an empty one. A corrupt file is refused: guessing would invent teams. */
  read() {
    this.#assertLock();
    let raw;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { version: REGISTRY_VERSION, teams: [] };
      failWith('REGISTRY_UNREADABLE', 'the team registry cannot be read (' + (error.code || error.message) + ')');
    }
    this.#bytes = Buffer.byteLength(raw);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      failWith('REGISTRY_UNREADABLE', 'the team registry is not valid JSON; refusing to overwrite it');
    }
    if (!parsed || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.teams)) {
      failWith('REGISTRY_UNREADABLE', 'the team registry has no usable shape; refusing to overwrite it');
    }
    return parsed;
  }

  /** Byte-for-byte length of the file as last read; the probe for "a refused manager did not touch it". */
  get bytes() {
    return this.#bytes;
  }

  write(state) {
    this.#assertLock();
    const text = JSON.stringify({ version: REGISTRY_VERSION, teams: state.teams }, null, 2) + '\n';
    const temporary = this.#file + '.tmp-' + process.pid + '-' + this.#now();
    const fd = fs.openSync(temporary, 'w');
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.#file);
    this.#bytes = Buffer.byteLength(text);
    return state;
  }

  /** Reserve the owner's team. The same owner gets the same teamId back while its row exists. */
  reserve({ ownerSessionId, teamId = newTeamId(), dir = null } = {}) {
    this.#assertLock();
    if (typeof ownerSessionId !== 'string' || !ownerSessionId) failWith('INVALID_OWNER', 'a team registry row needs an ownerSessionId');
    if (!/^team-[0-9a-f]{32}$/.test(teamId)) failWith('INVALID_TEAM', 'a team id must look like team-<32 hex>, got ' + JSON.stringify(teamId));
    const state = this.read();
    const owned = state.teams.find(row => row.ownerSessionId === ownerSessionId);
    if (owned) return { ...owned, reused: true };
    if (state.teams.some(row => row.teamId === teamId)) failWith('TEAM_ID_TAKEN', 'team id ' + teamId + ' is already registered');
    const row = { teamId, ownerSessionId, status: 'creating', dir, createdAt: this.#now() };
    state.teams.push(row);
    this.write(state);
    return { ...row, reused: false };
  }

  markReady(teamId) {
    this.#assertLock();
    const state = this.read();
    const row = state.teams.find(item => item.teamId === teamId);
    if (!row) failWith('UNKNOWN_TEAM', 'no registry row for ' + teamId);
    row.status = 'ready';
    row.readyAt = this.#now();
    this.write(state);
    return { ...row };
  }

  /** A host that stopped is not a team that never existed: the row and its owner mapping stay. */
  markUnmounted(teamId) {
    this.#assertLock();
    const state = this.read();
    const row = state.teams.find(item => item.teamId === teamId);
    if (!row) return null;
    row.unmountedAt = this.#now();
    this.write(state);
    return { ...row };
  }

  /** Archive keeps the mapping and marks the team as no longer active. */
  archive(teamId) {
    this.#assertLock();
    const state = this.read();
    const row = state.teams.find(item => item.teamId === teamId);
    if (!row) failWith('UNKNOWN_TEAM', 'no registry row for ' + teamId);
    row.status = 'archived';
    row.archivedAt = this.#now();
    this.write(state);
    return { ...row };
  }

  /**
   * Destroy removes the row. It is the only operation that does, and it is never reached from unmount, stop or close:
   * a shutdown that silently forgot owner -> team would make a restart create a second team for the same session.
   */
  destroy(teamId) {
    this.#assertLock();
    return this.drop(teamId);
  }

  drop(teamId) {
    this.#assertLock();
    const state = this.read();
    const before = state.teams.length;
    state.teams = state.teams.filter(row => row.teamId !== teamId);
    if (state.teams.length !== before) this.write(state);
    return before !== state.teams.length;
  }

  entry(teamId) {
    return this.read().teams.find(row => row.teamId === teamId) ?? null;
  }

  list() {
    return this.read().teams.map(row => ({ ...row }));
  }

  /**
   * Decide a crashed 'creating' row: with no epoch file the team was never born and the row is dropped; with an
   * epoch the team exists and its row is kept for the ordinary recovery path.
   */
  recoverCreating({ hasEpoch = () => false } = {}) {
    this.#assertLock();
    const state = this.read();
    const dropped = [];
    state.teams = state.teams.filter(row => {
      if (row.status !== 'creating') return true;
      const born = row.dir ? hasEpoch(row.dir) : false;
      if (!born) dropped.push(row.teamId);
      return born;
    });
    if (dropped.length) this.write(state);
    return dropped;
  }

  async close() {
    if (this.#closed) return false;
    this.#closed = true;
    const closed = await closeServer(this.#server);
    this.#server = null;
    if (this.#lock && this.#lock.kind === 'socket-file') {
      try {
        fs.unlinkSync(this.#lock.target);
      } catch {
        // Already gone.
      }
    }
    return closed;
  }
}
