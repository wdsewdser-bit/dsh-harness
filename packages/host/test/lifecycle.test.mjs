// Offline feature tests for start/stop/recover; docs/host-protocol.md §2.1 and invariant 9 (F23).
// The defects these pin: stop did not own the state machine, its budget did not cover resource closing, a bad
// timeout could poison every later stop, and a failing start could leave a host that was 'running' with no lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTeamHost } from '../index.mjs';
import { createClock } from '../src/clock.mjs';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { recordPath, removeDir, tempDir, waitFor } from '../test-support/helpers.mjs';

const admissionOpen = async () => ({ status: 'ok', admission: true });

test('start walks the spec states in order and stop releases the lock', async () => {
  const dir = tempDir('walk');
  const host = createTeamHost({ teamId: 'team:walk', root: dir, ownerSessionId: 'session:walk' });
  try {
    const started = await host.start();
    assert.equal(started.state, 'running');
    assert.equal(started.admission, false, 'no recoverer means admission stays closed');
    assert.equal(host.status().recovery.status, 'skeleton', 'a missing recoverer is reported, not hidden');
    assert.deepEqual(
      host.status().history.map(step => step.from + '>' + step.to),
      ['created>starting', 'starting>recovering', 'recovering>running'],
    );
    assert.equal(host.status().capabilities.receipts, 'memory-only');
    const result = await host.stop({ timeoutMs: 1000 });
    assert.deepEqual(
      { state: result.state, store: result.store, ownership: result.ownership, inFlight: result.inFlight, timedOut: result.timedOut },
      { state: 'stopped', store: 'none', ownership: 'released', inFlight: 'settled', timedOut: false },
    );
    assert.equal(fs.existsSync(recordPath(dir)), false);
    assert.equal(host.status().ownership.released, true);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('repeated stop returns the same result object, and an invalid timeout cannot poison it', async () => {
  const dir = tempDir('repeat-stop');
  const host = createTeamHost({ teamId: 'team:repeat-stop', root: dir, ownerSessionId: 'session:repeat-stop' });
  try {
    await host.start();
    assert.throws(() => host.stop({ timeoutMs: -1 }), error => error.code === 'INVALID_TIMEOUT');
    assert.throws(() => host.stop({ timeoutMs: 'soon' }), error => error.code === 'INVALID_TIMEOUT');
    const [first, second] = await Promise.all([host.stop(), host.stop()]);
    const third = await host.stop();
    assert.equal(first, second, 'concurrent stop calls share one result');
    assert.equal(second, third, 'a later stop returns the stored result');
    assert.equal(first.state, 'stopped');
  } finally {
    removeDir(dir);
  }
});

test('recover() is refused while running, after stop and before ownership', async () => {
  const dir = tempDir('recover-refused');
  const host = createTeamHost({ teamId: 'team:recover-refused', root: dir, ownerSessionId: 'session:recover-refused' });
  try {
    await assert.rejects(host.recover(), error => error.code === 'INVALID_STATE');
    await host.start();
    await assert.rejects(host.recover(), error => error.code === 'RECOVER_NOT_ALLOWED');
    await host.stop();
    await assert.rejects(host.recover(), error => error.code === 'INVALID_STATE');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('stop during recovery returns within its budget and isolates the late result (F23)', async () => {
  const dir = tempDir('stop-during-recover');
  let finish = null;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const host = createTeamHost({ teamId: 'team:stop-recover', root: dir, ownerSessionId: 'session:stop-recover', recoverer: () => pending });
  try {
    const started = host.start();
    const failure = started.then(() => null, error => error);
    await waitFor(() => host.status().state === 'recovering', 'recovering');
    const at = Date.now();
    const result = await host.stop({ timeoutMs: 120 });
    const elapsed = Date.now() - at;
    assert.equal(result.timedOut, true);
    assert.equal(result.isolated, true);
    assert.equal(result.inFlight, 'timeout');
    assert.equal(result.ownership, 'released');
    assert.ok(elapsed < 620, 'stop returned in ' + elapsed + 'ms with a 120ms budget');
    assert.equal(host.status().state, 'stopped');
    finish({ status: 'ok', admission: true });
    const error = await failure;
    assert.equal(error.code, 'HOST_STOPPED');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(host.status().recovery, null, 'an isolated recovery result must not be written');
    assert.equal(host.status().admission, false);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('stop during starting converges to stopped without opening the business store (F23)', async () => {
  const dir = tempDir('stop-during-start');
  let storeOpens = 0;
  const host = createTeamHost({
    teamId: 'team:stop-start',
    root: dir,
    ownerSessionId: 'session:stop-start',
    openStore: () => {
      storeOpens += 1;
      return { close() {} };
    },
  });
  let stopping = null;
  host.onStateChange(step => {
    if (step.to === 'starting' && !stopping) stopping = host.stop({ timeoutMs: 500 });
  });
  try {
    const started = host.start();
    const failure = started.then(() => null, error => error);
    const error = await failure;
    assert.equal(error.code, 'HOST_STOPPED');
    assert.equal(host.status().failed, null, 'a start cancelled by stop is not a failure');
    const result = await stopping;
    assert.equal(result.state, 'stopped');
    assert.equal(result.timedOut, false);
    assert.equal(storeOpens, 0, 'stop before ownership means no business store is opened');
    assert.equal(host.status().epoch, null);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('hooks are unmounted by stop, a same-name mount is refused, and an old invoke is a no-op', async () => {
  const dir = tempDir('hooks');
  const seen = [];
  const host = createTeamHost({ teamId: 'team:hooks', root: dir, ownerSessionId: 'session:hooks', recoverer: admissionOpen });
  try {
    await host.start();
    const invoke = host.mountHook('session/event', payload => {
      seen.push(payload);
      return 'handled';
    });
    assert.throws(() => host.mountHook('session/event', () => {}), error => error.code === 'HOOK_ALREADY_MOUNTED');
    assert.equal(invoke('a'), 'handled');
    assert.deepEqual(host.status().hooks, { mounted: 1, inflight: 0 });
    assert.equal(host.unmountHook('session/event'), true);
    assert.equal(invoke('b'), undefined, 'an unmounted invoke never reaches the handler');
    assert.equal(host.unmountHook('session/event'), false);
    const again = host.mountHook('session/event', payload => {
      seen.push(payload);
      return 'second';
    });
    await host.stop();
    assert.equal(again('c'), undefined, 'an invoke that outlives stop does nothing');
    assert.deepEqual(seen, ['a']);
    assert.throws(() => host.mountHook('session/event', () => {}), error => error.code === 'HOST_STOPPED');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a throwing listener cannot break start or stop', async () => {
  const dir = tempDir('listeners');
  const host = createTeamHost({ teamId: 'team:listeners', root: dir, ownerSessionId: 'session:listeners', recoverer: admissionOpen });
  host.onStateChange(step => {
    if (step.to === 'running') throw Object.assign(new Error('observer failed'), { code: 'OBSERVER_FAILED' });
  });
  host.onStateChange(step => {
    if (step.to === 'stopping') throw Object.assign(new Error('stop observer failed'), { code: 'STOP_OBSERVER_FAILED' });
  });
  try {
    const started = await host.start();
    assert.equal(started.state, 'running');
    assert.equal(host.status().listenerErrors.length, 1);
    assert.deepEqual(
      { code: host.status().listenerErrors[0].code, transition: host.status().listenerErrors[0].transition },
      { code: 'OBSERVER_FAILED', transition: 'recovering>running' },
    );
    const result = await host.stop();
    assert.equal(result.state, 'stopped');
    assert.equal(host.status().listenerErrors.length, 2, 'the stopping-phase observer error is recorded too');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a failing route registration fails the start, records it and releases everything', async () => {
  const dir = tempDir('route-failure');
  const router = {
    registerTeam() {
      throw Object.assign(new Error('route busy'), { code: 'ROUTE_BUSY' });
    },
    unregisterTeam() {
      return false;
    },
  };
  let storeClosed = 0;
  const host = createTeamHost({
    teamId: 'team:route',
    root: dir,
    ownerSessionId: 'session:route',
    router,
    openStore: () => ({
      close() {
        storeClosed += 1;
      },
    }),
    recoverer: admissionOpen,
  });
  const invoke = host.mountHook('session/event', () => 'never');
  try {
    await assert.rejects(host.start(), error => error.code === 'ROUTE_BUSY');
    assert.equal(host.status().state, 'recovering', 'a failed start stays where it failed');
    assert.equal(host.status().failed.code, 'ROUTE_BUSY');
    assert.equal(host.status().failed.stage, 'routing');
    assert.equal(host.status().admission, false);
    assert.equal(host.status().ownership.held, false);
    assert.equal(host.status().hooks.mounted, 0);
    assert.equal(storeClosed, 1);
    assert.equal(invoke('x'), undefined);
    const blocked = {
      requestId: 'r1',
      teamId: 'team:route',
      actor: 'member:root',
      operationId: 'v1:operation:route-failure-0001',
      payload: { entityId: 'message:m', command: 'host.ping' },
    };
    assert.throws(() => host.command(blocked), error => error.code === 'HOST_FAILED');
    const probe = createTeamHost({ teamId: 'team:route2', root: dir, ownerSessionId: 'session:route2' });
    await probe.start();
    await probe.stop();
    const result = await host.stop();
    assert.equal(result.state, 'stopped');
    assert.equal(result.failed.code, 'ROUTE_BUSY');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('openStore must be synchronous, and an unfinished async close is never reported as closed', async () => {
  const dir = tempDir('store-port');
  const asyncOpen = createTeamHost({ teamId: 'team:store-async', root: dir, ownerSessionId: 'session:store-async', openStore: async () => ({ close() {} }) });
  try {
    await assert.rejects(asyncOpen.start(), error => error.code === 'INVALID_STORE_PORT');
    assert.equal(asyncOpen.status().failed.code, 'INVALID_STORE_PORT');
    await asyncOpen.stop();
  } finally {
    removeDir(dir);
  }

  const slowDir = tempDir('store-slow-close');
  let releaseClose = null;
  const slow = createTeamHost({
    teamId: 'team:slow-close',
    root: slowDir,
    ownerSessionId: 'session:slow-close',
    openStore: () => ({
      close: () => new Promise(resolve => {
        releaseClose = resolve;
      }),
    }),
  });
  try {
    await slow.start();
    const at = Date.now();
    const result = await slow.stop({ timeoutMs: 100 });
    assert.equal(result.store, 'isolated', 'an unfinished async close is never reported as closed');
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - at < 600);
    releaseClose();
    await waitFor(() => !fs.existsSync(recordPath(slowDir)), 'the lock is released once the close settles');
  } finally {
    removeDir(slowDir);
  }

  const syncDir = tempDir('store-sync-close');
  const sync = createTeamHost({ teamId: 'team:sync-close', root: syncDir, ownerSessionId: 'session:sync-close', openStore: () => ({ close() {} }) });
  try {
    await sync.start();
    const result = await sync.stop({ timeoutMs: 500 });
    assert.equal(result.store, 'closed');
    assert.equal(result.timedOut, false);
  } finally {
    removeDir(syncDir);
  }
});

test('a stopped host cannot be restarted: a new epoch needs a new instance', async () => {
  const dir = tempDir('restart');
  try {
    const first = createTeamHost({ teamId: 'team:restart', root: dir, ownerSessionId: 'session:restart' });
    await first.start();
    const epoch = first.status().epoch;
    await first.stop();
    assert.throws(() => first.start(), error => error.code === 'HOST_STOPPED');
    const second = createTeamHost({ teamId: 'team:restart', root: dir, ownerSessionId: 'session:restart' });
    await second.start();
    assert.equal(second.status().epoch, epoch + 1);
    await second.stop();
  } finally {
    removeDir(dir);
  }
});

// Regression: a host without an owner session registers no routes, so the heartbeat has nothing to renew. It used to
// call teamSessions() unconditionally and throw NOT_ROUTED as an uncaught exception one heartbeat after start. The
// owner-less host is a supported construction (manager.mount defaults ownerSessionId to null and the profiles fixtures
// build exactly this host), so the heartbeat must be a no-op, not a crash. The clock is driven by hand: no test waits
// 20 seconds for a real interval.
test('an owner-less host heartbeats as a no-op instead of failing with NOT_ROUTED', async () => {
  const dir = tempDir('ownerless-heartbeat');
  const store = new ControlStore(dir);
  const at = Date.now();
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:ownerless', now: () => at });
  const intervals = [];
  const timers = {
    setInterval: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
    setTimeout: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
    clearInterval: handle => { if (handle) handle.cleared = true; },
    clearTimeout: handle => { if (handle) handle.cleared = true; }
  };
  const host = createTeamHost({ teamId: 'team:ownerless', root: dir, core, clock: createClock({ now: () => at, timers }),
    heartbeatIntervalMs: 1000, cycleIntervalMs: 1000000, evidenceRetentionCommitThreshold: false,
    recoverer: async () => ({ status: 'ok', admission: true }), openStore: () => ({ close() {} }) });
  try {
    await host.start();
    assert.equal(host.status().state, 'running');
    const heartbeat = intervals.find(handle => handle.ms === 1000);
    assert.ok(heartbeat, 'the heartbeat is armed on the host clock');
    for (let tick = 0; tick < 3; tick += 1) {
      assert.doesNotThrow(() => heartbeat.fn(), 'the heartbeat of an owner-less host must not throw');
    }
    assert.equal(host.status().state, 'running', 'the heartbeat neither stops nor fails the host');
    assert.equal(host.status().lastError ?? null, null);
  } finally {
    await host.stop();
    store.close();
    removeDir(dir);
  }
});

// Negative regression: the owner-less exemption must not swallow a real routing defect. With an owner configured, a
// route that is lost at runtime still has to surface NOT_ROUTED instead of being treated as "nothing to renew".
test('a host with an owner still surfaces NOT_ROUTED when its runtime route is lost', async () => {
  const dir = tempDir('owner-route-lost');
  const store = new ControlStore(dir);
  const at = Date.now();
  const core = new TeamCore(store, {}, { enabled: true, attach: true, teamId: 'team:route-lost', now: () => at });
  const intervals = [];
  const timers = {
    setInterval: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
    setTimeout: (fn, ms) => { const handle = { fn, ms, cleared: false }; intervals.push(handle); return handle; },
    clearInterval: handle => { if (handle) handle.cleared = true; },
    clearTimeout: handle => { if (handle) handle.cleared = true; }
  };
  const lost = Object.assign(Error('team team:route-lost is not hosted in this process'), { code: 'NOT_ROUTED' });
  const router = { registerTeam() {}, unregisterTeam() {}, teamSessions() { throw lost; } };
  const host = createTeamHost({ teamId: 'team:route-lost', root: dir, ownerSessionId: 'session:route-lost', core, router,
    clock: createClock({ now: () => at, timers }), heartbeatIntervalMs: 1000, cycleIntervalMs: 1000000,
    evidenceRetentionCommitThreshold: false, recoverer: async () => ({ status: 'ok', admission: true }),
    openStore: () => ({ close() {} }) });
  try {
    await host.start();
    assert.equal(host.status().state, 'running');
    const heartbeat = intervals.find(handle => handle.ms === 1000);
    assert.ok(heartbeat, 'the heartbeat is armed on the host clock');
    assert.throws(() => heartbeat.fn(), error => error === lost && error.code === 'NOT_ROUTED',
      'a lost route of an owned host is a real failure, not an owner-less no-op');
  } finally {
    await host.stop();
    store.close();
    removeDir(dir);
  }
});
