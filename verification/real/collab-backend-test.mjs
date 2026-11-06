import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend, fetchBlockedPort } from './collab-task/hidden-set/backend.mjs';

const backend = fileURLToPath(new URL('./collab-task/fixtures/be-v1/server.mjs', import.meta.url));
function blockedChild(events) {
  const child = new EventEmitter();
  Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: null, signalCode: null });
  child.kill = () => {
    child.signalCode = 'SIGTERM'; child.stdout.end(); child.stderr.end();
    child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); events.push('closed'); return true;
  };
  queueMicrotask(() => {
    child.stdout.write('http://127.0.0.1:6');
    queueMicrotask(() => child.stdout.write('000\n'));
  });
  return child;
}

test('the native Fetch client refuses port 6000 before HTTP, independently of product wake/visibility', async () => {
  assert.equal(fetchBlockedPort('http://127.0.0.1:6000'), true);
  assert.equal(fetchBlockedPort('http://127.0.0.1:6697'), true);
  assert.equal(fetchBlockedPort('http://127.0.0.1:18080'), false);
  await assert.rejects(fetch('http://127.0.0.1:6000/api/todos'), error => error.cause?.message === 'bad port');
});

test('a split bad-port URL is rejected and reaped before another backend starts; CRUD is still required', async () => {
  const events = []; let calls = 0;
  const started = await startBackend(backend, { spawnChild: (...args) => {
    if (++calls === 1) return blockedChild(events);
    assert.deepEqual(events, ['closed'], 'the unusable process must be gone before its replacement starts');
    return spawn(...args);
  } });
  try {
    assert(calls >= 2, 'a partial URL ending in port 6 must not be mistaken for ready');
    assert.equal(started.startupPorts[0], '6000'); assert.equal(fetchBlockedPort(started.url), false);
    const url = started.url + '/api/todos';
    const response = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({title:'same workload',tags:['alpha']}) });
    assert.equal(response.status, 201); const row = await response.json(); assert.equal(typeof row.id, 'string');
    assert.equal((await (await fetch(url)).json()).length, 1);
    const patched = await fetch(url + '/' + row.id, {method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({done:true})});
    assert.equal(patched.status, 200); assert.equal((await patched.json()).done, true);
    assert.equal((await fetch(url + '/' + row.id, {method:'DELETE'})).status, 204);
    assert.deepEqual(await (await fetch(url)).json(), []);
    assert.equal(calls, started.startupPorts.length, 'API assertions never restart the backend');
  } finally { await stopBackend(started); }
  assert.notEqual(started.child.signalCode, null, 'the successful child is also reaped');
});

test('repeated bad ports are bounded, explicit failures, with every rejected child closed', async () => {
  const events = [];
  await assert.rejects(startBackend(backend, { maxStarts: 2, spawnChild: () => blockedChild(events) }), /only Fetch-blocked ports: 6000,6000/);
  assert.deepEqual(events, ['closed','closed']);
});

test('application startup errors are not retried or hidden as port allocation problems', async () => {
  let calls = 0;
  await assert.rejects(startBackend(backend + '.missing', {spawnChild:(...args)=>{calls++;return spawn(...args);}}), /backend exited 1/);
  assert.equal(calls, 1);
});
