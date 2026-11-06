import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Shared fixtures for the host feature tests. Every directory lives under the system temp root: a team host takes an
 * OS-level name on its directory, so a test must never point one at runs/ or reports/.
 */
export function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-' + label + '-'));
}

export function epochPath(dir) {
  return path.join(dir, '.host-epoch');
}

/** Diagnostics only; no ownership decision is ever made from this file. */
export function recordPath(dir) {
  return path.join(dir, '.host-owner.json');
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export async function waitFor(predicate, label, attempts = 600) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for ' + label);
}

/**
 * The M1a placeholder command registry. The class of every command is fixed here, in trusted code: a caller cannot
 * ask for a business command to be treated as an operator command, because the class is not part of the request.
 */
export const commands = Object.freeze({
  'host.ping': {
    kind: 'business',
    completion: 'inflight',
    reduce: (tx, current, payload) => tx.put(payload.entityId, { ok: true, revision: (current?.revision ?? 0) + 1, command: 'host.ping' }),
  },
  'host.audit': {
    kind: 'business',
    completion: 'inflight',
    reduce: (tx, current, payload) => tx.put(payload.entityId, { ok: true, audit: true, command: 'host.audit' }),
  },
  'host.plain': {
    kind: 'business',
    reduce: (tx, current, payload) => tx.put(payload.entityId, { ok: true, command: 'host.plain' }),
  },
  'host.probe': {
    kind: 'business',
    completion: 'inflight',
    actor: 'adapter',
    reduce: (tx, current, payload) => tx.put(payload.entityId, { ok: true, probe: true, command: 'host.probe' }),
  },
  'host.observe': {
    kind: 'operator',
    actor: 'operator',
    reduce: (tx, current, payload) => tx.put(payload.entityId, { observed: true, command: 'host.observe' }),
  },
  'host.recovery-note': {
    kind: 'recovery',
    reduce: (tx, current, payload) => tx.put(payload.entityId, { recovered: true, command: 'host.recovery-note' }),
  },
});

/** A TeamCore-shaped fake: records every mutate call and hands the reducer the normalised snapshot it was given. */
export function fakeCore() {
  const calls = [];
  return {
    calls,
    mutate(entityId, actor, payload, reducer) {
      calls.push({ entityId, actor, payload });
      const tx = { put: (id, data) => ({ entityId: id, ...data }) };
      return { revision: calls.length, entityId, data: reducer(tx, null) };
    },
  };
}

const workerPath = fileURLToPath(new URL('./owner-worker.mjs', import.meta.url));

/** Spawn the real ownership worker and read one JSON report line at a time. */
export function startWorker(args) {
  const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const queue = [];
  const waiting = [];
  let buffer = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      if (waiting.length) waiting.shift()(value);
      else queue.push(value);
    }
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiting.push(resolve))),
    stderr: () => stderr,
  };
}
