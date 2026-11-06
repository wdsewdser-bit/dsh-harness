import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profile, until } from '../test-support/profile.mjs';

/**
 * §22: a restarted host must still be able to create a member.
 *
 * The native session store mints its default `session-<n>` from a counter that begins at 1 in every process. A host
 * that boots over the directory its previous run left behind therefore asks for `session-1` again, and the JSONL
 * backend refuses an id whose log is already on disk. The lifecycle create effect then ends `unknown`, the member
 * intent never confirms, and every later request for that member times out - this is exactly what the second epoch of
 * the offline soak hit. The fix belongs to the layer that owns the durable nativeRef: it names the session itself.
 */

/** A session store that behaves like the persisted one: the counter starts fresh, the disk does not. */
function persistedSessions(taken) {
  const sessions = new Map();
  let counter = 0;
  return {
    sessions,
    taken,
    async create(options = {}) {
      let id = options.sessionId;
      if (id === undefined) do { id = 'session-' + (++counter); } while (sessions.has(id));
      if (taken.has(id)) throw Error('session "' + id + '" already exists');
      taken.add(id);
      const session = { id, seq: 0, snapshotEvents: () => [] };
      sessions.set(id, session);
      return { agent: { session, ctx: { tools: { register() {}, restrict() {}, guard() {} } }, wakeDriver() {}, cancel() {}, async whenIdle() {} },
        async dispose() {} };
    },
  };
}

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-minting-'));

test('a host that boots over its own session directory creates its member under a fresh id', async () => {
  const dir = root();
  // What the first run left on disk: the counter would hand out exactly this id again.
  const store = persistedSessions(new Set(['session-1']));
  const w = await profile({ root: dir }, async ({ ctx }) => { ctx.agents.create = store.create; });
  try {
    const r = w.runtime;
    r.host.command({ teamId: r.host.teamId, actor: 'root', requestId: 'member', operationId: 'v1:operation:session-minting-01',
      payload: { command: 'team.member.request', entityId: 'member-intent:w', role: 'worker' } });
    await until(() => r.store.read('member-intent:w')?.status === 'confirmed');
    const nativeRef = r.store.read('member:w').nativeRef;
    assert.match(nativeRef, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'the product names the session instead of borrowing the store counter that restarts at 1');
    assert.notEqual(nativeRef, 'session-1', 'the id the previous boot left on disk is not reused');
    assert.deepEqual([...store.sessions.keys()], [nativeRef], 'exactly one native session exists');
  } finally { await w.close(); }
});

test('two members created by one host get two distinct session identities', async () => {
  const dir = root();
  const store = persistedSessions(new Set());
  const w = await profile({ root: dir }, async ({ ctx }) => { ctx.agents.create = store.create; });
  try {
    const r = w.runtime;
    for (const name of ['a', 'b']) {
      r.host.command({ teamId: r.host.teamId, actor: 'root', requestId: 'member-' + name, operationId: 'v1:operation:session-minting-1' + name,
        payload: { command: 'team.member.request', entityId: 'member-intent:' + name, role: 'worker' } });
    }
    await until(() => ['a', 'b'].every(name => r.store.read('member-intent:' + name)?.status === 'confirmed'));
    const refs = ['a', 'b'].map(name => r.store.read('member:' + name).nativeRef);
    assert.equal(new Set(refs).size, 2, 'no two members share one execution identity');
    assert.equal(store.sessions.size, 2);
  } finally { await w.close(); }
});
