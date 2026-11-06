import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { guardWorld } from '../test-support/guard-world.mjs';

/**
 * Review 2 #2: the guard captured the assigned workspace once and compared every target against it for the life of the
 * agent. That is not the directory the native tool uses: a resumed session restores its own recorded cwd, and a legal
 * cd inside a turn changes the live one. So a relative write judged "inside" could land outside the lease.
 *
 * The fence now reads the session's working-directory state at every check, and a resume whose restored directory is
 * not the assigned one is refused instead of being rebound to a directory nobody reviewed.
 */
test('review 2 #2: every check reads the live session directory, and a disagreeing resume is refused', async () => {
  const w = await guardWorld();
  try {
    const elsewhere = path.join(w.root, 'elsewhere');
    // The session is really running somewhere else: the same relative path is resolved there and refused.
    w.control.live = elsewhere;
    const refused = w.run('write', { file_path: 'note.txt', content: 'x' });
    assert.match(String(refused.refused), /OUT_OF_SCOPE/, 'the fence judged the directory the tool resolved against');
    assert.equal(fs.existsSync(path.join(elsewhere, 'note.txt')), false);
    // Back inside the assignment the identical call is allowed, and the file lands where the tool puts it.
    w.control.live = w.control.cwd;
    const allowed = w.run('write', { file_path: 'note.txt', content: 'x' });
    assert.equal(allowed.written, path.join(w.control.cwd, 'note.txt'));
    // A resume that restores a different directory is refused rather than bound with a stale cache. No live service
    // here, so the resumed session's own recorded directory is the one the host must agree with.
    w.control.live = null;
    w.control.resumeCwd = elsewhere;
    await assert.rejects(() => w.runtime.core.ports.resume({ memberId: 'member:w', nativeRef: 'session:recorded', cwd: w.control.cwd }),
      { code: 'INVALID_WORKSPACE' });
    w.control.resumeCwd = w.control.cwd;
    const resumed = await w.runtime.core.ports.resume({ memberId: 'member:w', nativeRef: 'session:recorded', cwd: w.control.cwd });
    assert.equal(resumed.nativeRef, 'session:recorded', 'a resume that agrees with the assignment is bound');
  } finally { await w.close(); }
});
