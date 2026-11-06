import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { id, operationIdPattern } from '../../contracts/index.mjs';
import assert from 'node:assert/strict';
import { createCoreAccess, createRestrictedTx } from '../src/core-access.mjs';
import { createTeamHost } from '../index.mjs';
import { InflightRegistry } from '../src/inflight.mjs';

/**
 * Counterexamples for the controlled write ports (design §3.4, §3.5): a route that can be talked into another
 * route's work is the bug these tests exist to catch, so every test here asserts a refusal and then asserts that the
 * refused transaction left nothing behind.
 */


export const rule = Object.freeze({ attemptId: 'attempt:a1', effectId: 'effect:cancel-a1' });

export const cleanups = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/** Real SQLite replacement writes, operation ledger and transaction rollback. */
export function realCore(seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ca-'));
  const store = new ControlStore(root);
  cleanups.push(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:ca' });
  core.mutate('seed', 'scheduler', {}, tx => {
    for (const [key, value] of Object.entries(seed)) tx.put(key, key.startsWith('attempt:') ? { owner: 'member:1', taskId: 'task:t1', ...value } : value);
    for (const effect of ['effect:e1', 'effect:cancel-a1']) tx.outbox(effect, { kind: 'cancel', attemptId: 'attempt:a1' });
    return null;
  });
  const applied = [];
  const mutate = core.mutate.bind(core);
  core.mutate = (entityId, actor, payload, reducer, meta) => mutate(entityId, actor, payload, (tx, row) => {
    const pending = [];
    const receipt = reducer({ ...tx,
      put: (...args) => { const v = tx.put(...args); pending.push({ via: 'write', kind: 'put' }); return v; },
      outbox: (...args) => { const v = tx.outbox(...args); pending.push({ via: 'write', kind: 'outbox' }); return v; },
    }, row) ?? null;
    applied.push({ via: 'mutate', entityId, actor }, ...pending);
    return receipt;
  }, meta);
  for (const name of ['claim', 'settle']) {
    const original = store[name].bind(store);
    store[name] = (...args) => { const result = original(...args); applied.push({ via: name, args }); return result; };
  }
  return { core, rows: { get: key => store.read(key) }, applied };
}

export function world({ state = 'running', epoch = 7, at = 1000, owns = true, failed = null } = {}) {
  const w = { state, epoch, at, owns, failed, token: { epoch, revoked: false }, inflight: new InflightRegistry() };
  w.ports = createCoreAccess({
    teamId: 'team:ca',
    epoch: () => w.epoch,
    state: () => w.state,
    token: () => w.token,
    ownership: () => w.owns,
    failure: () => w.failed,
    inflight: w.inflight,
    now: () => w.at,
  });
  return w;
}

export function open(w, { operationId = id('operation'), command = 'effect.settle', entityId = 'effect:e1', actor = 'adapter' } = {}) {
  const { token } = w.inflight.open({ label: 'effect', epoch: w.epoch, operationId, command, entityId, actor, now: () => w.at });
  return token;
}

export const codeOf = fn => {
  try {
    fn();
  } catch (error) {
    return error.code ?? error.message;
  }
  return 'no-throw';
};

