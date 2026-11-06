// Offline feature tests for write isolation and the capability interface; docs/host-protocol.md §2.1 rule 3.
// The defects these pin: the capability held a gateway captured before construction finished, so a legal
// capability.command() threw; and capability.write() never checked ownership or the kind whitelist of its scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamHost } from '../index.mjs';
import { commands, fakeCore, removeDir, tempDir, waitFor } from '../test-support/helpers.mjs';

const admissionOpen = async () => ({ status: 'ok', admission: true });

const command = (teamId, operationId, commandName = 'host.ping', entityId = 'message:m1') => ({
  requestId: 'req-' + operationId.slice(-4),
  teamId,
  actor: 'member:root',
  operationId,
  payload: { entityId, command: commandName },
});

test('a recovery capability can dispatch a recovery-class command during recovery', async () => {
  const dir = tempDir('iso-recovery-command');
  const core = fakeCore();
  let observed = null;
  const host = createTeamHost({
    teamId: 'team:rec-cmd',
    root: dir,
    ownerSessionId: 'session:rec-cmd',
    core,
    commands,
    recoverer: async ({ capability }) => {
      observed = capability.command(command('team:rec-cmd', 'v1:operation:recovery-command-0001', 'host.recovery-note', 'runtime:team'));
      return { status: 'ok', admission: true };
    },
  });
  try {
    const started = await host.start();
    assert.equal(started.state, 'running');
    assert.equal(observed.class, 'recovery', 'the class comes from the trusted registry');
    assert.equal(observed.result.revision, 1);
    assert.equal(core.calls.length, 1);
    assert.equal(core.calls[0].payload.command, 'host.recovery-note');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a running hook can dispatch a business-class command', async () => {
  const dir = tempDir('iso-hook-command');
  const core = fakeCore();
  const host = createTeamHost({ teamId: 'team:hook-cmd', root: dir, ownerSessionId: 'session:hook-cmd', core, commands, recoverer: admissionOpen });
  try {
    await host.start();
    const invoke = host.mountHook('session/event', (payload, capability) =>
      capability.command(command('team:hook-cmd', 'v1:operation:hook-command-0001')));
    const receipt = invoke({ step: 1 });
    assert.equal(receipt.class, 'business');
    assert.equal(receipt.result.revision, 1);
    assert.equal(core.calls.length, 1);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a recovery capability is dead after stop, even when the recoverer ignores the signal', async () => {
  const dir = tempDir('iso-recovery-stop');
  const writes = [];
  let captured = null;
  let finish = null;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const host = createTeamHost({
    teamId: 'team:isolated',
    root: dir,
    ownerSessionId: 'session:isolated',
    commands,
    writeKinds: { recovery: ['recovery-checkpoint'] },
    writeSink: ({ kind, epoch }) => {
      writes.push({ kind, epoch });
      return { ok: true };
    },
    recoverer: async ({ signal, capability }) => {
      assert.equal(signal.aborted, false);
      captured = capability;
      assert.equal(captured.writable(), true);
      const receipt = captured.write('recovery-checkpoint', { step: 1 });
      assert.equal(receipt.accepted, true);
      assert.equal(receipt.forwarded, true);
      await pending;
      return { status: 'ok', admission: true };
    },
  });
  try {
    const started = host.start();
    const failure = started.then(() => null, error => error);
    await waitFor(() => host.status().state === 'recovering', 'recovering');
    const result = await host.stop({ timeoutMs: 150 });
    assert.equal(result.timedOut, true);
    assert.equal(result.isolated, true);
    assert.equal(captured.writable(), false, 'the capability is dead once stop revoked the token');
    assert.throws(() => captured.write('recovery-checkpoint', { step: 2 }), error => error.code === 'WRITE_REVOKED');
    assert.throws(
      () => captured.command(command('team:isolated', 'v1:operation:isolation-0002', 'host.recovery-note', 'runtime:team')),
      error => error.code === 'WRITE_REVOKED',
    );
    assert.equal(writes.length, 1, 'nothing reached the write sink after stop');
    finish({ status: 'ok', admission: true });
    const error = await failure;
    assert.equal(error.code, 'HOST_STOPPED');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(host.status().recovery, null);
    assert.equal(host.status().admission, false);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a hook writes through a capability that closes with the host', async () => {
  const dir = tempDir('iso-hook');
  const writes = [];
  let captured = null;
  const host = createTeamHost({
    teamId: 'team:hook-iso',
    root: dir,
    ownerSessionId: 'session:hook-iso',
    writeKinds: { hook: ['session-event'] },
    writeSink: payload => {
      writes.push(payload);
      return { ok: true };
    },
    recoverer: admissionOpen,
  });
  try {
    await host.start();
    const invoke = host.mountHook('session/event', (payload, capability) => {
      captured = capability;
      return capability.write('session-event', payload);
    });
    const receipt = invoke({ type: 'step' });
    assert.equal(receipt.forwarded, true);
    assert.equal(captured.writable(), true);
    assert.equal(writes.length, 1);
    await host.stop();
    assert.equal(captured.writable(), false);
    assert.throws(() => captured.write('session-event', {}), error => error.code === 'WRITE_REVOKED');
    assert.equal(invoke({ type: 'later' }), undefined, 'an old invoke never calls the handler again');
    assert.equal(writes.length, 1);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a scope cannot write a kind outside its own whitelist', async () => {
  const dir = tempDir('iso-write-kinds');
  let recoveryWrite = null;
  let hookWrite = null;
  const host = createTeamHost({
    teamId: 'team:kinds',
    root: dir,
    ownerSessionId: 'session:kinds',
    writeKinds: { recovery: ['recovery-checkpoint'], hook: ['session-event'] },
    writeSink: () => ({ ok: true }),
    recoverer: async ({ capability }) => {
      try {
        capability.write('session-event', { type: 'not-recovery' });
      } catch (error) {
        recoveryWrite = error;
      }
      return { status: 'ok', admission: true };
    },
  });
  try {
    await host.start();
    const invoke = host.mountHook('session/event', (payload, capability) => {
      try {
        capability.write('recovery-checkpoint', { step: 1 });
      } catch (error) {
        hookWrite = error;
      }
      return 'checked';
    });
    assert.equal(invoke({ step: 1 }), 'checked');
    assert.equal(recoveryWrite.code, 'WRITE_FORBIDDEN', 'recovery may not submit hook events');
    assert.equal(hookWrite.code, 'WRITE_FORBIDDEN', 'a hook may not submit recovery writes');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a live capability stops writing as soon as the owned handle is lost', async () => {
  const dir = tempDir('iso-ownership');
  let captured = null;
  let finish = null;
  const pending = new Promise(resolve => {
    finish = resolve;
  });
  const host = createTeamHost({
    teamId: 'team:ownership',
    root: dir,
    ownerSessionId: 'session:ownership',
    writeKinds: { recovery: ['recovery-checkpoint'] },
    writeSink: () => ({ ok: true }),
    recoverer: async ({ capability }) => {
      captured = capability;
      await pending;
      return { status: 'ok', admission: false };
    },
  });
  try {
    const started = host.start();
    started.catch(() => {});
    await waitFor(() => host.status().state === 'recovering', 'recovering');
    assert.equal(captured.writable(), true);
    await host.ownership.release();
    assert.equal(captured.writable(), false, 'eligibility follows the actual lock, not just the token');
    assert.throws(() => captured.write('recovery-checkpoint', { step: 1 }), error => error.code === 'OWNERSHIP_LOST');
    finish({ status: 'ok', admission: false });
    await started.catch(error => error);
    assert.equal(host.status().ownership.held, false);
  } finally {
    await host.stop();
    removeDir(dir);
  }
});

test('a rejected hook promise is recorded and produces no unhandled rejection', async () => {
  const dir = tempDir('iso-hook-rejection');
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const host = createTeamHost({ teamId: 'team:hook-fail', root: dir, ownerSessionId: 'session:hook-fail', recoverer: admissionOpen });
  try {
    await host.start();
    const invoke = host.mountHook('session/event', async () => {
      throw Object.assign(new Error('hook blew up'), { code: 'HOOK_BLEW_UP' });
    });
    const result = invoke({ step: 1 });
    assert.equal(typeof result.then, 'function', 'the caller still receives the original promise');
    await assert.rejects(result, error => error.code === 'HOOK_BLEW_UP');
    await waitFor(() => host.status().hooks.inflight === 0, 'the tracked invocation to settle');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, [], 'the tracking promise consumed its own rejection');
    assert.equal(host.status().hookErrors.length, 1);
    assert.equal(host.status().hookErrors[0].code, 'HOOK_BLEW_UP');
    assert.equal(host.status().hookErrors[0].hook, 'session/event');
    const stopped = await host.stop({ timeoutMs: 500 });
    assert.equal(stopped.state, 'stopped', 'the host survived the hook failure');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await host.stop();
    removeDir(dir);
  }
});

test('a hook that never settles is tracked and the stop budget still closes the host', async () => {
  const dir = tempDir('iso-hook-hang');
  const host = createTeamHost({ teamId: 'team:hook-hang', root: dir, ownerSessionId: 'session:hook-hang', recoverer: admissionOpen });
  let release = null;
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  try {
    await host.start();
    const invoke = host.mountHook('session/event', () => blocked);
    invoke({ step: 1 });
    assert.equal(host.status().hooks.inflight, 1, 'a running hook is tracked');
    const at = Date.now();
    const result = await host.stop({ timeoutMs: 120 });
    assert.equal(result.inFlight, 'timeout');
    assert.equal(result.drain, 'isolated');
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - at < 620);
    assert.equal(result.ownership, 'released', 'the lock is released even when a hook hangs');
    assert.equal(result.state, 'stopped');
    release();
  } finally {
    await host.stop();
    removeDir(dir);
  }
});
test('writeKinds is validated and snapshotted at construction', async () => {
  const dir = tempDir('iso-write-kinds-config');
  const invalid = [
    { hook: 'session-event' },
    { hook: [''] },
    { hook: [42] },
    { hook: ['session-event'], recovery: 'recovery-checkpoint' },
    ['session-event'],
  ];
  for (const writeKinds of invalid) {
    assert.throws(
      () => createTeamHost({ teamId: 'team:config', root: dir, writeKinds }),
      error => error.code === 'INVALID_CONFIG',
      'configuration should be refused: ' + JSON.stringify(writeKinds),
    );
  }

  const kinds = ['session-event'];
  const host = createTeamHost({
    teamId: 'team:kinds-snapshot',
    root: dir,
    ownerSessionId: 'session:kinds-snapshot',
    writeKinds: { hook: kinds },
    writeSink: () => ({ ok: true }),
    recoverer: admissionOpen,
  });
  let captured = null;
  try {
    await host.start();
    const invoke = host.mountHook('session/event', (payload, capability) => {
      captured = capability;
      return 'checked';
    });
    invoke({ step: 1 });
    assert.equal(captured.write('session-event', {}).forwarded, true);
    // Mutating the caller's array after construction must not widen the host's permissions.
    kinds.push('escalation');
    assert.throws(() => captured.write('escalation', {}), error => error.code === 'WRITE_FORBIDDEN');
  } finally {
    await host.stop();
    removeDir(dir);
  }
});
