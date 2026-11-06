import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { guardWorld } from '../test-support/guard-world.mjs';

/**
 * Review 2 #1 (blocker): the model's arguments could forge the guard's metadata.
 *
 * The profile built the guard effect as { tool: execution.name, ...arguments }, so a "tool" field in the arguments
 * replaced the real tool name (a structured write judged as read: no fence, no audit) and, inside effectTargets, an
 * "targets" array beat the file_path the tool actually writes. Upstream file tools accept the extra fields and still
 * write file_path, so both calls really escaped. The cases below go through the guard the profile installs for the
 * member, which is the pipeline a native call passes, and then through the tool's own resolution.
 */
test('review 2 #1: a model cannot forge the tool class or the fenced target', async () => {
  const w = await guardWorld();
  try {
    const inside = path.join(w.control.cwd, 'inside.txt');
    const outside = path.join(w.root, 'outside.txt');
    const legit = w.run('write', { file_path: 'inside.txt', content: 'ok' });
    assert.equal(legit.written, inside, 'a genuine relative write is allowed and lands in the member workspace');
    assert.equal(fs.readFileSync(inside, 'utf8'), 'ok');
    // (a) a targets array the tool never reads: the guard must keep judging file_path.
    const forgedTargets = w.run('write', { file_path: outside, targets: [inside], content: 'escaped' });
    assert.match(String(forgedTargets.refused), /OUT_OF_SCOPE/, 'the self-declared targets did not become the fenced path');
    assert.equal(fs.existsSync(outside), false, 'nothing was written outside the workspace');
    // (b) a tool field in the arguments: the class comes from execution.name, so a write is still a write.
    const forgedTool = w.run('write', { file_path: outside, tool: 'read', content: 'escaped' });
    assert.match(String(forgedTool.refused), /OUT_OF_SCOPE/, 'the tool class came from the execution, not from the arguments');
    assert.equal(fs.existsSync(outside), false, 'the forged class did not turn the write into a read');
  } finally { await w.close(); }
});
