import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { failWith, id } from '../../contracts/index.mjs';
import { canonicalTeamDir, teamDirKey } from './paths.mjs';

/**
 * Ownership: one host per team directory; docs/host-protocol.md §1.1, invariant 1.
 *
 * The exclusion primitive is a process-held operating-system name, not a file:
 *   - Windows: a named pipe, \\.\pipe\dsh-team-<hash of the normalised directory>;
 *   - Linux:   the abstract socket namespace, \0dsh-team-<hash>;
 *   - macOS:   the platform has no abstract namespace, so the name is a socket file inside the team directory
 *              (see the limitation noted below).
 * net.Server.listen(name) fails with EADDRINUSE when the name is taken. On Windows the first bind uses
 * FILE_FLAG_FIRST_PIPE_INSTANCE, so an independent process competing for the same pipe receives
 * ERROR_ACCESS_DENIED, which libuv maps to UV_EADDRINUSE. The server accepts nothing (a connection is destroyed on
 * arrival) and is unref'd, which keeps it from blocking process exit; unref does not close the server while the
 * process keeps running, which is what a lock needs.
 *
 * A Windows pipe instance is removed when its last handle is closed, including on process exit. A client that still
 * holds a handle, or the system's cleanup scheduling, can delay that, so a new starter may need a bounded retry.
 * Nothing here deletes or steals a name, and no pid-liveness file is consulted. EADDRINUSE means "someone else owns
 * it"; every other listen error is fail-closed.
 *
 * Platform status: Windows is validated by the multi-process tests. Linux (abstract namespace) and macOS (socket
 * file fallback) are implemented but NOT validated. A macOS socket file also survives a crash; this module never
 * deletes a socket file it did not create, so after a crash the file blocks startup until an operator removes it.
 *
 * The owner record (<dir>/.host-owner.json) and the epoch file are NOT part of the exclusion decision. The record is
 * diagnostics only; nobody ever reads it to decide whether a mount may proceed. The epoch is a monotonic counter for
 * rejecting old receipts, and it is read and written only while the OS lock is held.
 */
const EPOCH_FILE = '.host-epoch';
const RECORD_FILE = '.host-owner.json';

/** In-process fast path. The OS lock below is the authority; this only makes a second mount in one process cheap. */
export class OwnershipRegistry {
  #held = new Map();

  acquire(key, detail = {}) {
    const holder = this.#held.get(key);
    if (holder) failWith('OWNERSHIP_HELD', 'team directory ' + key + ' is already mounted by host ' + holder.hostId);
    const token = Object.freeze({ ...detail, key, hostId: id('host') });
    this.#held.set(key, token);
    return token;
  }

  release(token) {
    if (!token || this.#held.get(token.key) !== token) return false;
    this.#held.delete(token.key);
    return true;
  }

  has(key) {
    return this.#held.has(key);
  }

  holder(key) {
    return this.#held.get(key) ?? null;
  }

  get size() {
    return this.#held.size;
  }
}

export const ownershipRegistry = new OwnershipRegistry();

/**
 * The OS lock name for a normalised team directory. Exported so diagnostics and tests can name it.
 * Windows: named pipe (validated). Linux: abstract socket namespace (implemented, not validated).
 * macOS and everything else: socket file in the team directory (implemented, not validated).
 */
export function lockTarget(dir, key) {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 40);
  const name = 'dsh-team-' + digest;
  if (process.platform === 'win32') return { kind: 'pipe', target: '\\\\.\\pipe\\' + name };
  if (process.platform === 'linux') return { kind: 'abstract', target: '\u0000' + name };
  return { kind: 'socket-file', target: path.join(dir, '.' + name + '.sock') };
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

/**
 * The epoch file: only an absent file means "new team, start at 1". Anything unreadable, corrupt or out of range is
 * refused (EPOCH_UNREADABLE / EPOCH_EXHAUSTED) - reusing an epoch would let an old receipt pass the epoch check.
 */
function readEpoch(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    failWith('EPOCH_UNREADABLE', 'epoch file ' + file + ' cannot be read (' + (error.code || error.message) + '); refusing to invent an epoch');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    failWith('EPOCH_UNREADABLE', 'epoch file ' + file + ' is not valid JSON; refusing to reuse an epoch');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Number.isSafeInteger(parsed.epoch) || parsed.epoch < 1) {
    failWith('EPOCH_UNREADABLE', 'epoch file ' + file + ' has no usable epoch; refusing to reuse an epoch');
  }
  return parsed.epoch;
}

/**
 * Durable replace: write the temporary file, fsync its content, rename, then best-effort fsync the directory.
 *
 * Durability boundary: this makes a torn file unlikely, and it keeps the counter monotonic across crashes on Linux
 * only when the directory fsync above actually succeeded - the catch swallows every directory-sync error, so that
 * condition cannot be assumed. On Windows there is no directory handle to fsync at all, so the rename's directory
 * entry is never synced. This is improved durability, not a strict transactional guarantee: a power loss inside that
 * narrow window can lose the newest epoch and reuse it. The OS lock, not the epoch, remains the exclusion proof.
 */
function writeEpochFile(file, text) {
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(temporary, 'w');
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  let directory = null;
  try {
    directory = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(directory);
  } catch {
    // Windows cannot fsync a directory handle; the file content is already synced and the rename is atomic there.
    // Linux and macOS do sync here, which is what makes the rename itself durable across a crash.
  } finally {
    if (directory !== null) {
      try {
        fs.closeSync(directory);
      } catch {
        // Ignore: the durability decision was already made above.
      }
    }
  }
}

function nextEpoch(file, now) {
  const previous = readEpoch(file);
  const epoch = previous + 1;
  if (!Number.isSafeInteger(epoch)) {
    failWith('EPOCH_EXHAUSTED', 'epoch ' + previous + ' is at the safe-integer limit; the team must be rebuilt, not reused');
  }
  writeEpochFile(file, JSON.stringify({ epoch, pid: process.pid, at: now() }) + '\n');
  return epoch;
}

function writeRecord(file, record) {
  try {
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
  } catch {
    // Diagnostics only: a team must not fail to start because its owner record is not writable.
  }
}

function removeRecord(file, ownerId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.ownerId === ownerId) fs.unlinkSync(file);
  } catch {
    // Missing, unreadable or somebody else's record: leave it alone.
  }
}

/** A held OS lock. release() closes only this handle's server, so an old handle can never free a newer holder. */
export class OwnershipHandle {
  #dir;
  #key;
  #token;
  #registry;
  #server;
  #lock;
  #epoch;
  #ownerId;
  #recordPath;
  #released = false;
  #closePromise = null;

  constructor({ dir, key, token, registry, server, lock, epoch, recordPath }) {
    this.#dir = dir;
    this.#key = key;
    this.#token = token;
    this.#registry = registry;
    this.#server = server;
    this.#lock = lock;
    this.#epoch = epoch;
    this.#ownerId = token.hostId;
    this.#recordPath = recordPath;
  }

  get dir() {
    return this.#dir;
  }

  get key() {
    return this.#key;
  }

  get epoch() {
    return this.#epoch;
  }

  get kind() {
    return this.#lock.kind;
  }

  get name() {
    return this.#lock.target;
  }

  get recordPath() {
    return this.#recordPath;
  }

  get released() {
    return this.#released;
  }

  /** True while this handle still holds the OS name: released, closed or never listening all mean "no". */
  owns() {
    return !this.#released && Boolean(this.#server && this.#server.listening);
  }

  /** Invariant 1 rule 3: checked before dispatching an external action. */
  verify() {
    if (this.owns()) return { ok: true };
    return { ok: false, reason: this.#released ? 'released' : 'not-listening' };
  }

  release() {
    if (this.#closePromise) return this.#closePromise;
    this.#released = true;
    this.#closePromise = (async () => {
      const closed = await closeServer(this.#server);
      this.#server = null;
      // The socket-file fallback leaves a file behind; only this handle created it, so only this handle removes it.
      if (this.#lock.kind === 'socket-file') {
        try {
          fs.unlinkSync(this.#lock.target);
        } catch {
          // Already gone.
        }
      }
      this.#registry.release(this.#token);
      removeRecord(this.#recordPath, this.#ownerId);
      return closed;
    })();
    return this.#closePromise;
  }
}

/**
 * Acquire ownership: in-process slot, OS name, persistent epoch (all three), then a diagnostic owner record.
 * Throws OWNERSHIP_HELD when the name is taken, OWNERSHIP_UNAVAILABLE for any other listen error (fail closed), and
 * EPOCH_UNREADABLE / EPOCH_EXHAUSTED when the counter cannot be advanced safely. Nothing is left held on failure.
 */
export async function acquireOwnership({ root, registry = ownershipRegistry, now = Date.now, signal = null } = {}) {
  const dir = canonicalTeamDir(root);
  const key = teamDirKey(dir);
  const token = registry.acquire(key, { dir });
  const lock = lockTarget(dir, key);
  let server = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      server = await listenExclusive(lock.target);
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        failWith('OWNERSHIP_HELD', 'the OS lock ' + lock.kind + ' ' + JSON.stringify(lock.target) + ' for ' + key + ' is held by a live process');
      }
      failWith('OWNERSHIP_UNAVAILABLE', 'the OS lock ' + lock.kind + ' for ' + key + ' could not be opened (' + (error.code || error.message) + ')');
    }
    // Cancellation barrier: a stop that already gave up must not leave a name, an epoch or a record behind. Checked
    // after the name is bound and before the epoch is allocated, so cancelling closes this handle only.
    if (signal && signal.aborted) {
      await closeServer(server);
      server = null;
      failWith('HOST_STOPPED', 'ownership was cancelled before the epoch was allocated');
    }
    server.unref();
    server.on('error', () => {
      // A listener error after acquisition means the name may be gone; owns()/verify() report it from server state.
    });
    // Read and write the epoch only now that the name is ours.
    const epoch = nextEpoch(path.join(dir, EPOCH_FILE), now);
    const recordPath = path.join(dir, RECORD_FILE);
    const handle = new OwnershipHandle({ dir, key, token, registry, server, lock, epoch, recordPath });
    writeRecord(recordPath, { ownerId: token.hostId, pid: process.pid, epoch, kind: lock.kind, name: lock.target, at: now() });
    return handle;
  } catch (error) {
    await closeServer(server);
    registry.release(token);
    throw error;
  }
}
