// Review 2 #1 (blocker) and review 2 #2 remainder: the fence must answer with the path the native backend touches.
//
// The guard used to resolve paths with Node's own path.resolve(), which is not the native filesystem backend's answer:
// "~/file" is a directory named "~" to path.resolve and the user's home directory to the backend, and on Windows a
// root-relative "\\dir\\file" has no drive of its own - the backend resolves it against the drive of the SESSION
// directory, not of whichever process happens to be asking. A fence that answers differently from the tool it fences
// allows a write it believes is inside the lease. The cases below drive the profile's own guard and then the tool's own
// resolution, which the test writes out independently of the fence (test-support/guard-world.mjs nativeWriteTarget).
//
// The last case is the other half of review 2 #2: "no working-directory service" and "the service could not be read"
// are different facts, and only the first may fall back to the directory recorded at bind time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardWorld, nativeWriteTarget } from '../test-support/guard-world.mjs';
import { resolveToolPath } from '../index.mjs';

test('review 2 #1: a home alias resolves to the home directory, which the fence then refuses', async () => {
  const w = await guardWorld();
  // A name no other run can have used: a leaked probe from an earlier (mutated) run must never decide this assertion.
  const probe = '~/dsh-guard-probe-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.txt';
  const native = path.join(os.homedir(), path.basename(probe.slice(2)));
  try {
    // What the native backend does with the same argument: the file lands in the user's home directory, never under the
    // session workspace a fence that read "~" as a literal directory name would have checked.
    assert.equal(nativeWriteTarget(probe, w.control.cwd), native);
    assert.equal(fs.existsSync(native), false);
    const refused = w.run('write', { file_path: probe, content: 'escaped' });
    assert.match(String(refused.refused), /OUT_OF_SCOPE/, 'the fence judged the backend target, not "<cwd>/~"');
    assert.equal(fs.existsSync(native), false, 'and nothing was written outside the lease');
    assert.equal(fs.existsSync(path.join(w.control.cwd, '~')), false, 'and nothing was written as a literal "~" either');
  } finally { fs.rmSync(native, { force: true }); await w.close(); }
});

test('review 2 #1 / review 3 #1: a Windows root-relative path is answered on the session drive, and refused there', async () => {
  const w = await guardWorld();
  try {
    if (process.platform !== 'win32') return; // the alias only exists on Windows
    // The backend resolves this against the drive of the SESSION directory, so that is the path the fence now answers.
    // It is outside the lease and refused; guessing the host process drive instead is what let a write escape.
    const native = nativeWriteTarget('\\dsh-guard-probe.txt', w.control.cwd);
    assert.equal(native, path.resolve(path.parse(path.resolve(w.control.cwd)).root, 'dsh-guard-probe.txt'));
    const refused = w.run('write', { file_path: '\\dsh-guard-probe.txt', content: 'escaped' });
    assert.match(String(refused.refused), /OUT_OF_SCOPE/, 'the fence judged the backend target, not a drive it picked itself');
    assert.equal(fs.existsSync(native), false, 'and nothing was written outside the lease');
  } finally { await w.close(); }
});

test('review 2 #1: the aliases the fence cannot reproduce are refusals, not guesses', () => {
  // Another user's home: the backend expands it, this module does not, so it must not be resolved here either.
  assert.throws(() => resolveToolPath('~someone/notes.txt', '/tmp'), { code: 'UNRESOLVED_TARGET' });
  // A relative path with no session directory: the host process directory is not the tool's directory.
  assert.throws(() => resolveToolPath('notes.txt', null), { code: 'UNRESOLVED_TARGET' });
  // The three shapes that ARE answered: home, an absolute path, and a relative path with its directory.
  assert.equal(resolveToolPath('~/a.txt', '/tmp'), path.join(os.homedir(), 'a.txt'));
  assert.equal(resolveToolPath(path.resolve('/tmp/b.txt'), null), path.resolve('/tmp/b.txt'));
  assert.equal(resolveToolPath('c.txt', '/tmp/ws'), path.resolve('/tmp/ws/c.txt'));
});

test('review 3 #1: with no session directory only a fully qualified path is answered', () => {
  // A relative path has no directory to be resolved against, and the host process directory is not the tool's.
  for (const value of ['notes.txt', 'sub/notes.txt', '.\\notes.txt', '../notes.txt', '..']) {
    assert.throws(() => resolveToolPath(value, null), { code: 'UNRESOLVED_TARGET' }, JSON.stringify(value) + ' is not fully qualified');
  }
  if (process.platform === 'win32') {
    // The shapes that only LOOK absolute: several leading separators, an incomplete UNC, a drive-relative path, and a
    // root-relative one. Realpath/isAbsolute say "absolute" for most of them; none of them names a root by itself.
    for (const value of ['///x', '////x', '//server', 'C:x', 'C:', '\\x', '/x']) {
      assert.throws(() => resolveToolPath(value, null), { code: 'UNRESOLVED_TARGET' }, JSON.stringify(value) + ' is not fully qualified');
    }
    // The two shapes that ARE fully qualified stay answerable, and answer with the native resolution.
    assert.equal(resolveToolPath('C:/a', null), path.resolve('C:/a'));
    assert.equal(resolveToolPath('C:\\a', null), path.resolve('C:\\a'));
    assert.equal(resolveToolPath('//s/share/x', null), path.resolve('//s/share/x'));
    assert.equal(resolveToolPath('\\\\s\\share\\x', null), path.resolve('\\\\s\\share\\x'));
  } else {
    assert.equal(resolveToolPath('/tmp/a.txt', null), '/tmp/a.txt');
  }
});

test('review 3 #1: with a session directory the fence answers what the native backend answers', async () => {
  const base = process.platform === 'win32' ? 'C:\\member\\ws' : '/member/ws';
  const values = ['note.txt', 'sub/note.txt', '.\\note.txt', '..\\note.txt', '..', '~/note.txt'];
  if (process.platform === 'win32') values.push('///x', '////x', '//server', '\\x', '/x', 'C:x', 'C:', 'C:/a', 'C:\\a', '//s/share/x');
  for (const value of values) {
    assert.equal(resolveToolPath(value, base), nativeWriteTarget(value, base),
      JSON.stringify(value) + ' resolved against ' + base + ' must be the backend target, not a second opinion');
  }
});

test('review 3 #5: a service that exists but cannot name a directory refuses the write', async () => {
  const w = await guardWorld();
  try {
    const inside = path.join(w.control.cwd, 'note.txt');
    for (const [label, service] of [
      ['a service without get()', {}],
      ['get() answering null', { get: () => null }],
      ['get() answering undefined', { get: () => undefined }],
      ["get() answering ''", { get: () => '' }],
    ]) {
      w.control.liveService = service;
      const refused = w.run('write', { file_path: 'note.txt', content: 'x' });
      assert.match(String(refused.refused), /SESSION_CWD_UNAVAILABLE/, label + ': the fence refused instead of guessing');
      assert.equal(fs.existsSync(inside), false, label + ': the header directory was not used as a silent fallback');
    }
    // The one fact that may fall back: this context never offered the service at all.
    w.control.liveService = null;
    w.control.liveInjectError = true;
    const absent = w.run('write', { file_path: 'note3.txt', content: 'x' });
    assert.equal(absent.written, path.join(w.control.cwd, 'note3.txt'), 'with no service, the header is the directory');
  } finally { await w.close(); }
});

test('review 2 #2 remainder: a working directory that cannot be read refuses the write', async () => {
  const w = await guardWorld();
  try {
    const inside = path.join(w.control.cwd, 'note.txt');
    // The service itself cannot be read (an "without inject" style access error): not "this runtime has none".
    w.control.liveError = true;
    const unreadable = w.run('write', { file_path: 'note.txt', content: 'x' });
    assert.match(String(unreadable.refused), /SESSION_CWD_UNAVAILABLE/);
    assert.equal(fs.existsSync(inside), false, 'the header directory was not used as a silent fallback');
    // The service is there but its read fails: the same answer, for the same reason. (live is set, so the fixture really
    // offers a service; live === null would mean "this runtime has none", which is the fallback the header is for.)
    w.control.liveError = false;
    w.control.live = w.control.cwd;
    w.control.liveReadError = true;
    const failed = w.run('write', { file_path: 'note.txt', content: 'x' });
    assert.match(String(failed.refused), /SESSION_CWD_UNAVAILABLE/);
    assert.equal(fs.existsSync(inside), false);
    // With the read working again the identical call lands where the tool puts it.
    w.control.liveReadError = false;
    w.control.live = w.control.cwd;
    const allowed = w.run('write', { file_path: 'note.txt', content: 'x' });
    assert.equal(allowed.written, inside);
    // The one case that may fall back: this context never offered the service at all (cordis answers a property the
    // plugin did not declare with "without inject", which is the same whether or not the composition has one). The
    // session's recorded directory is then the only directory there is, exactly as before this review.
    w.control.liveInjectError = true;
    const absent = w.run('write', { file_path: 'note2.txt', content: 'x' });
    assert.equal(absent.written, path.join(w.control.cwd, 'note2.txt'), 'with no service, the header is the directory');
  } finally { await w.close(); }
});
