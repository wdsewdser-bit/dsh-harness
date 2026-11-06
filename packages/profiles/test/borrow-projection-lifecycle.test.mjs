import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '../../store/index.mjs';
import { Projection } from '../../projections/index.mjs';
import { applyTeamProjections } from '../index.mjs';
import { maintenanceFixture } from '../test-support/retention-graph.mjs';

const fixture = () => maintenanceFixture({ evidenceMaintenanceIntervalMs: 1000000 });
const listen = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const close = server => new Promise((resolve, reject) => { if (!server?.listening) return resolve(); server.close(error => error ? reject(error) : resolve());
  });
function context(w, publish = null) {
  const disposers = [];
  const runtime = { ready: Promise.resolve(), core: w.core, host: w.host,
    bindPrincipal: value => value };
  const ctx = { teamRuntime: runtime, on(name, work) { if (name === 'dispose') disposers.push(work); },
    provide(name, value) { if (publish) publish(name, value); this[name] = value; } };
  return { ctx, runtime, async dispose() { for (const work of disposers) await work(); } };
}

test('retention projection lifecycle: initialization bind failure immediately retires its reader', async () => {
  const w = await fixture(), block = net.createServer(), c = context(w);
  try {
    await listen(block, 40299);
    const before = w.store.readers();
    await assert.rejects(applyTeamProjections(c.ctx, { port: 40299, sessions: { token: { teamId: w.host.teamId, memberId: 'member:root' } } }), { code:
      'EADDRINUSE' });
    assert.deepEqual(w.store.readers(), before, 'failed initialization must retire now, not wait for host/store shutdown');
    assert.equal(w.host.state, 'running', 'the host is still alive, so store.close is not the cleanup boundary');
    const status = c.runtime.projectionStatus();
    assert.equal(status.state, 'failed'); assert.equal(status.initializationError.code, 'EADDRINUSE');
    assert.equal(status.warnings[0].code, 'PROJECTION_INITIALIZATION_FAILED');
  } finally { await c.dispose(); await close(block); await w.close(); }
});

test('retention projection lifecycle: initialization after listen closes transport as well as the reader', async () => {
  const w = await fixture(), failure = Object.assign(Error('publication failed'), { code: 'PROJECTION_PUBLISH_FAILED' });
  const c = context(w, () => { throw failure; }); const rebound = net.createServer();
  try {
    const before = w.store.readers();
    await assert.rejects(applyTeamProjections(c.ctx, { port: 40299, sessions: {} }), error => error === failure);
    assert.deepEqual(w.store.readers(), before);
    await listen(rebound, 40299); // no retry: a successfully-created transport must have been closed before rejection
    assert.equal(c.runtime.projectionStatus().state, 'failed');
  } finally { await c.dispose(); await close(rebound); await w.close(); }
});

for (const fault of ['tail', 'advance']) test('retention projection lifecycle: ' + fault + ' failure keeps durable cursor and retries without duplicate state',
  async () => {
  const w = await fixture(); let projection, cold;
  try {
    w.core.mutate('member:root', 'adapter', {}, tx => tx.put('member:root', { role: 'root' }));
    projection = new Projection(w.store, { recentLimit: 16 });
    const id = projection.reader.id, before = w.store.readers().find(row => row.id === id);
    w.core.mutate('usage:one', 'adapter', { n: 1 }, tx => tx.put('usage:one', { memberId: 'member:root', sessionId: 'one', input: 1, turns: 1 }));
    const first = w.store.latestEventSeq();
    w.core.mutate('usage:one', 'adapter', { n: 2 }, (tx, row) => tx.put('usage:one', { ...row, input: 2, turns: 2 }));
    const head = w.store.latestEventSeq(), failure = Object.assign(Error(fault + ' injected'), { code: 'INJECTED_' + fault.toUpperCase() });
    let failing = true;
    if (fault === 'tail') {
      const events = projection.reader.events;
      projection.reader.events = after => events(after).map(event => {
        if (event.seq !== head) return event;
        const payload = event.payload;
        return Object.defineProperty({ ...event }, 'payload', { enumerable: true, get() { if (failing) throw failure; return payload; } });
      });
    } else {
      const advance = projection.reader.advance;
      projection.reader.advance = seq => {
        if (!failing) return advance(seq);
        const exec = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function(sql) { if (sql === 'COMMIT') throw failure; return exec.call(this, sql); };
        try { return advance(seq); } finally { DatabaseSync.prototype.exec = exec; }
      };
    }
    assert.throws(() => projection.sync(), error => error === failure);
    assert.equal(w.store.inTransaction(), false, 'failed acknowledgement must roll back its actual SQL transaction');
    const protectedPosition = w.store.readers().find(row => row.id === id);
    assert.equal(protectedPosition.seq, before.seq, 'a failing call must not advance the durable watermark');
    assert.equal(protectedPosition.lastAdvancedAt, before.lastAdvancedAt);
    assert.deepEqual(protectedPosition.identity, before.identity);
    assert.equal(projection.seq, fault === 'tail' ? first : head, 'the injection exercises partial apply or failed acknowledgement');
    failing = false; projection.sync();
    assert.equal(w.store.cursor(id), head);
    assert.deepEqual(projection.history.map(event => event.seq), [first, head], 'retry must not apply an already-applied event twice');
    assert.equal(projection.rows.get('usage:one').turns, 2);
    cold = new Projection(w.store, { recentLimit: 16 });
    assert.deepEqual(projection.snapshot('member:root'), cold.snapshot('member:root'));
  } finally { cold?.close(); projection?.close(); await w.close(); }
});

test('retention projection lifecycle: reader identity survives checkpoints and is visible through readonly status', async () => {
  const w = await fixture(); let projection, readonly;
  try {
    const created = Date.now();
    projection = new Projection(w.store, { readerIdentity: { teamId: w.host.teamId, serviceId: 'test-projection' } });
    const id = projection.reader.id, identity = w.store.readers().find(row => row.id === id).identity;
    assert.equal(identity.pid, process.pid); assert(identity.hostId.endsWith(':' + process.pid));
    assert.equal(typeof identity.instanceId, 'string'); assert(identity.instanceId.length > 10);
    assert(identity.createdAt >= created && identity.createdAt <= Date.now());
    assert.equal(identity.serviceId, 'test-projection'); assert.equal(identity.teamId, w.host.teamId);
    projection.reader.checkpoint();
    assert.deepEqual(w.store.readers().find(row => row.id === id).identity, identity, 'rebase must not change ownership or creation time');
    readonly = ControlStore.openReadOnly(w.root);
    assert.deepEqual(readonly.storageStatus().authoritativeEvidenceRetention.readers.find(row => row.id === id).identity, identity);
    assert.throws(() => w.store.openProjectionReader(id), { code: 'READER_ALREADY_REGISTERED' }, 'a live identity cannot silently be stolen');
    projection.close();
    assert.equal(w.store.readers().some(row => row.id === id), false);
  } finally { readonly?.close(); projection?.close(); await w.close(); }
});

test('retention projection lifecycle: initialization disposal cannot publish a late transport or leak its port', async () => {
  const w = await fixture(), c = context(w), rebound = net.createServer();
  const on = c.ctx.on.bind(c.ctx);
  c.ctx.on = (name, work) => { on(name, work); if (name === 'dispose') void work(); };
  const interval = globalThis.setInterval, cancel = globalThis.clearInterval, active = new Set();
  globalThis.setInterval = (...args) => { const timer = interval(...args); active.add(timer); return timer; };
  globalThis.clearInterval = timer => { active.delete(timer); return cancel(timer); };
  try {
    const before = w.store.readers();
    await assert.rejects(applyTeamProjections(c.ctx, { port: 40299, sessions: {}, contextDatabase: w.root + '/never-opened-context' }), { code:
      'PROJECTION_INITIALIZATION_CANCELLED' });
    assert.equal(active.size, 0, 'dispose must also clear timers created after an early disposal began');
    assert.deepEqual(w.store.readers(), before);
    assert.equal(c.ctx.teamProjections, undefined, 'a stopped service cannot be published after listen resolves');
    await listen(rebound, 40299);
  } finally {
    try { await c.dispose(); } finally {
      for (const timer of active) cancel(timer);
      globalThis.setInterval = interval; globalThis.clearInterval = cancel;
      await close(rebound); await w.close();
    }
  }
});

