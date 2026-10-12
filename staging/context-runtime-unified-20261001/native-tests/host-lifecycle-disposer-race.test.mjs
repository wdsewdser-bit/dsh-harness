import './host-lifecycle-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { Context, getHostLifecycleGate } = await import('@deepseek-ai/cordis');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settleWithin = async (promise, ms = 3000) => { let timer; try { return await Promise.race([promise.then(() => 'settled'), new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms); })]); } finally { clearTimeout(timer); } };
const deferred = () => { let resolve; const promise = new Promise(a => { resolve = a; }); return { promise, resolve }; };
async function host() { const ctx = new Context(); await tick(); return [ctx, getHostLifecycleGate(ctx)]; }

// Shape of dsh-api-gateway handleUpgrade: `release = peer.ctx.effect(() => () => websocket.close())` is registered from a
// socket callback, and `done.then(() => { ...; release(); })` runs from the connection's promise chain, outside any
// host-lifecycle writer token (no AsyncLocalStorage inheritance) and without a rejection handler.
// Expected behaviour (post-fix): a connection-end callback must never surface HOST_WRITER_BUSY, whichever writer is open.

test('connection-end effect disposer does not fail while host dispose holds the writer', async () => {
  const [ctx, gate] = await host();
  const peer = ctx.plugin(() => {}); await peer; await tick();
  let released = 0; const ended = deferred();
  const release = peer.ctx.effect(() => () => { released++; });
  const outcome = ended.promise.then(() => { release(); }).then(() => undefined, error => error);
  // Server owner: terminating sockets resolves `done` while its own disposer is still awaited by the writer.
  ctx.plugin(function server(child) { child.effect(() => async () => { ended.resolve(); await ended.promise; await tick(); }); });
  await tick();
  await gate.observeSettlement(() => gate.runAsync(() => ctx.fiber.dispose()));
  const error = await outcome;
  assert.equal(error, undefined, 'disposer from a foreign continuation threw ' + error?.code);
  assert.equal(released, 1, 'peer-bound effect must be released exactly once');
});

test('connection-end effect disposer does not fail while an async plugin install holds the writer', async () => {
  const [ctx, gate] = await host();
  const peer = ctx.plugin(() => {}); await peer; await tick();
  let released = 0; const setup = deferred();
  const release = peer.ctx.effect(() => () => { released++; });
  const installing = ctx.plugin(async () => { await setup.promise; });
  try {
    await tick();
    assert.equal(gate.snapshot().pending, true, 'precondition: install writer open');
    const error = await Promise.resolve().then(() => { release(); }).then(() => undefined, failure => failure);
    assert.equal(error, undefined, 'disposer from a foreign continuation threw ' + error?.code);
  } finally { setup.resolve(); await installing; await tick(); }
  await tick();
  assert.equal(gate.snapshot().pending, false);
  assert.equal(released, 1, 'peer-bound effect must be released exactly once, at the latest when the writer closes');
  await ctx.fiber.dispose(); await tick();
});

// Foreign-continuation call: no AsyncLocalStorage token, exactly like a socket callback.
// A release queued behind a foreign writer is fire-and-forget: it returns undefined and never a promise that only settles
// after the writer ends, because the caller may be a continuation that the writer itself awaits (see the deadlock tests).
// Completion is observed through the writer/gate becoming idle.
const foreign = action => new Promise((resolve, reject) => setImmediate(() => { try { resolve({ result: action() }); } catch (error) { reject(error); } }));
const peerWithEffect = async ctx => {
  const peer = ctx.plugin(() => {}); await peer; await tick();
  const state = { released: 0 };
  state.release = peer.ctx.effect(() => () => { state.released++; });
  return [peer, state];
};

test('deferred disposer is idempotent when invoked repeatedly while the writer is open', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx); const hold = deferred();
  const writer = gate.runAsync(async () => { await hold.promise; });
  await tick();
  const first = (await foreign(() => state.release())).result, second = (await foreign(() => state.release())).result;
  assert.equal(first, undefined, 'queued release must not hand back a writer-dependent promise'); assert.equal(second, undefined);
  assert.equal(state.released, 0, 'busy writer must defer, not run, the disposer');
  hold.resolve(); await writer; await tick();
  assert.equal(state.released, 1); assert.equal(gate.snapshot().pending, false);
  assert.equal((await foreign(() => state.release())).result, undefined); assert.equal(state.released, 1);
});

test('deferred disposer is a no-op when its fiber was cascade-disposed by the open writer', async () => {
  const [ctx, gate] = await host(); const [peer, state] = await peerWithEffect(ctx); const ready = deferred();
  const writer = gate.runAsync(async () => { await ready.promise; await peer.dispose(); });
  await tick();
  assert.equal((await foreign(() => state.release())).result, undefined); assert.equal(state.released, 0);
  ready.resolve(); await writer; await tick();
  assert.equal(state.released, 1, 'cascade disposal ran the effect once; the deferred call must not run it again');
  assert.equal(gate.snapshot().pending, false);
});

test('deferred disposer is dropped silently when the gate closes before it can run', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx); const hold = deferred();
  gate.track(hold.promise); hold.promise.then(() => gate.close());
  await tick();
  assert.equal((await foreign(() => state.release())).result, undefined);
  hold.resolve(); await tick(); await tick();
  assert.equal(state.released, 0);
});

test('disposer called after the gate closed keeps the synchronous HOST_CLOSED failure', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx);
  gate.close();
  assert.throws(() => state.release(), { code: 'HOST_CLOSED' }); assert.equal(state.released, 0);
});

test('an external disposer under a read lease is deferred until the lease is released, with no side effect before', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx);
  const lease = gate.acquireRead();
  assert.equal(state.release(), undefined); await tick(); assert.equal(state.released, 0);
  lease.assert();
  lease.release(); await tick(); await tick(); assert.equal(state.released, 1);
  state.release(); await tick(); assert.equal(state.released, 1);
});

test('connection-end effect disposer does not fail while a window transition holds a read lease', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx);
  const lease = gate.acquireTransition();
  const error = await Promise.resolve().then(() => { state.release(); }).then(() => undefined, failure => failure);
  assert.equal(error, undefined, 'disposer from a connection callback threw ' + error?.code);
  assert.equal(state.released, 0, 'nothing may change under the lease');
  lease.release(); await tick(); await tick(); assert.equal(state.released, 1);
});

test('a disposer queued behind read leases waits for every one of them', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx);
  const first = gate.acquireRead(), second = gate.acquireRead();
  state.release(); first.release(); await tick(); assert.equal(state.released, 0, 'still fenced by the second lease');
  second.release(); await tick(); await tick(); assert.equal(state.released, 1);
});

test('deferred disposer failure is reported through the logger, not swallowed, and still releases the writer', async () => {
  const [ctx, gate] = await host(); const peer = ctx.plugin(() => {}); await peer; await tick(); const hold = deferred();
  const logged = []; ctx.logger.exporter({ export: message => logged.push(message) });
  const release = peer.ctx.effect(() => () => { throw new Error('disposer-boom'); });
  const writer = gate.runAsync(async () => { await hold.promise; }); await tick();
  assert.equal((await foreign(() => release())).result, undefined);
  hold.resolve(); await writer; await tick(); await tick();
  assert.ok(logged.some(message => message.type === 'error' && message.args?.[0]?.message === 'disposer-boom'), 'deferred disposer failure must reach the logger as an error');
  assert.equal(gate.snapshot().pending, false);
});

test('gate-level queued release hands its failure to onError and still releases the writer', async () => {
  const [, gate] = await host(); const hold = deferred(); const errors = [];
  const writer = gate.runAsync(async () => { await hold.promise; }); await tick();
  assert.equal(gate.runRelease(() => { throw new Error('boom'); }, error => errors.push(error)), undefined); assert.equal(errors.length, 0);
  hold.resolve(); await writer; await tick(); await tick();
  assert.deepEqual(errors.map(error => error.message), ['boom']); assert.equal(gate.snapshot().pending, false);
});

test('a synchronous release failure with no writer still throws to the caller', async () => {
  const [, gate] = await host();
  assert.throws(() => gate.runRelease(() => { throw new Error('sync-boom'); }, () => assert.fail('onError is for queued releases only')), /sync-boom/);
});

test('deferred disposer queues behind earlier writers and ahead of later ones', async () => {
  const [ctx, gate] = await host(); const [peer] = await peerWithEffect(ctx); const hold = deferred(); const order = [];
  const release = peer.ctx.effect(() => () => { order.push('release'); });
  const first = gate.runAsync(async () => { await hold.promise; });
  await tick();
  const early = gate.runAsync(() => { order.push('early'); });
  const queued = (await foreign(() => release())).result;
  const late = gate.runAsync(() => { order.push('late'); });
  assert.equal(queued, undefined);
  hold.resolve(); await Promise.all([first, early, late]); await tick();
  assert.deepEqual(order, ['early', 'release', 'late']);
  assert.equal(gate.snapshot().pending, false);
});

// Deadlock shape: a continuation started OUTSIDE the writer (a socket callback, an async teardown begun earlier) calls an
// effect disposer while the host writer is open and awaits it; the writer in turn awaits that continuation. A disposer queued
// behind the writer must not hand back a promise that settles only after the writer ends.
test('a writer awaiting a foreign continuation that awaits a queued disposer does not deadlock', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx); const go = deferred();
  const flow = (async () => { await go.promise; await state.release(); })();
  const outcome = await settleWithin(gate.runAsync(async () => { go.resolve(); await flow; }));
  assert.equal(outcome, 'settled', 'writer awaiting a continuation that awaits the disposer must not hang');
  await tick(); assert.equal(state.released, 1, 'queued disposer runs exactly once after the writer is released');
  assert.equal(gate.snapshot().pending, false);
});

test('host dispose does not deadlock on a foreign teardown that awaits a peer disposer (agent-loop shape)', async () => {
  const [ctx, gate] = await host(); const [, state] = await peerWithEffect(ctx); const go = deferred();
  const flow = (async () => { await go.promise; await state.release(); })();
  ctx.plugin(function owner(child) { child.effect(() => async () => { go.resolve(); await flow; }); });
  await tick();
  const outcome = await settleWithin(gate.observeSettlement(() => gate.runAsync(() => ctx.fiber.dispose())));
  assert.equal(outcome, 'settled', 'host dispose hung on a foreign continuation awaiting a queued disposer');
  await tick(); assert.equal(state.released, 1, 'peer effect released exactly once (cascade or queued, never both)');
});
