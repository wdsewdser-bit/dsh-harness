import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDeliveryPort, git, resolveGitRoots } from '../index.mjs';

/**
 * The delivery port pins: design §3.7 - non-blocking Git with a timeout, an unparsable answer is `unknown`, and the
 * Git scope is a validated configuration.
 *
 * The suite is package-local and offline: the readback behaviour is driven through an injected spawn, so a hang is a
 * hang (no sleeping on a real subprocess) and the questions are "what evidence comes back", never "how does Git work".
 */
function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-del-' + label + '-'));
}

function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false, error = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    setImmediate(() => {
      if (error) { child.emit('error', error); return; }
      if (hang) return;
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
}

test('a hang is a timeout and a timeout is unknown, never a guessed answer', async () => {
  const root = tempDir('timeout');
  try {
    const port = createDeliveryPort({ repository: root, gitRoots: [root], timeoutMs: 10, spawn: fakeSpawn({ hang: true }) });
    const started = Date.now();
    const result = await port.git(root, 'status', '--porcelain');
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.equal(result.code, 'GIT_TIMEOUT');
    assert.ok(Date.now() - started < 2000, 'the timeout is what ends the call');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a proved git failure is a refusal, not an unknown', async () => {
  const root = tempDir('fail');
  try {
    const port = createDeliveryPort({ repository: root, gitRoots: [root], timeoutMs: 100, spawn: fakeSpawn({ stderr: 'fatal: not a git repository', code:
      128 }) });
    const result = await port.git(root, 'rev-parse', 'HEAD');
    assert.equal(result.ok, false);
    assert.equal(result.unknown, undefined);
    assert.equal(result.code, 'GIT_FAILED');
    assert.match(result.reason, /not a git repository/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the verifier answer is evidence: a timeout or an unparsable answer is unknown, a non-zero exit is a refusal', async () => {
  const root = tempDir('verify');
  try {
    const request = { taskId: 'task:a', candidate: 'cand', tree: 'tree', base: 'base', verifier: 'member:v', evidence: 'e' };
    const timedOut = createDeliveryPort({ repository: root, gitRoots: [root], timeoutMs: 10, spawn: fakeSpawn({ hang: true }) });
    const hang = await timedOut.verify({ directory: root, request });
    assert.equal(hang.unknown, true);
    assert.equal(hang.code, 'VERIFIER_TIMEOUT');
    const garbage = createDeliveryPort({ repository: root, gitRoots: [root], timeoutMs: 1000, spawn: fakeSpawn({ stdout: 'not json' }) });
    const unreadable = await garbage.verify({ directory: root, request });
    assert.equal(unreadable.unknown, true);
    assert.equal(unreadable.code, 'VERIFIER_UNREADABLE');
    const refused = createDeliveryPort({ repository: root, gitRoots: [root], timeoutMs: 1000, spawn: fakeSpawn({ stderr: 'SHA_MISMATCH', code: 1 }) });
    const failure = await refused.verify({ directory: root, request });
    assert.equal(failure.ok, false);
    assert.equal(failure.unknown, undefined);
    assert.equal(failure.code, 'VERIFIER_FAILED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('gitRoots is validated up front and checked on every call', async () => {
  const root = tempDir('roots');
  const other = tempDir('other');
  try {
    fs.mkdirSync(path.join(root, 'repo'));
    assert.throws(() => resolveGitRoots([]), { code: 'INVALID_CONFIG' });
    assert.throws(() => resolveGitRoots([path.join(root, 'missing')]), { code: 'INVALID_GIT_ROOT' });
    assert.throws(() => resolveGitRoots([path.join(root, 'repo', 'nope')]), { code: 'INVALID_GIT_ROOT' });
    const roots = resolveGitRoots([path.join(root, 'repo')]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0], roots[0].toLowerCase());
    const port = createDeliveryPort({ repository: path.join(root, 'repo'), gitRoots: [root], timeoutMs: 100, spawn: fakeSpawn() });
    assert.equal((await port.dirty(path.join(root, 'repo'))).ok, true);
    await assert.rejects(() => port.dirty(other), { code: 'GIT_SCOPE' });
    // The shipped default is still the repository runs/ tree, and the module-level git() keeps throwing on a refusal.
    await assert.rejects(() => git(process.cwd(), 'status'), { code: 'GIT_SCOPE' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
