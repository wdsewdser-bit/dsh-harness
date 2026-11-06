// P5 of the team-autonomy design (docs/decisions/team-autonomy-design.md §7.4 F7): a REAL Windows process tree.
//
// One node parent, two node children, killed through the production port and proven gone by reading the same WMI table
// the kill used. Nothing outside this tree is ever addressed: the only pids handed to taskkill are the ones this test
// started and the prover tracked from their parent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createProcessTree } from '../src/win/process-tree.mjs';
import { createStopProver } from '../src/stop-proof.mjs';

const windows = process.platform === 'win32';

function killQuietly(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  return new Promise(resolve => {
    let child;
    try { child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch { resolve(); return; }
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

async function treePids(parent) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('the child tree did not report its pids within 30s')), 30000);
    const done = (fn, value) => { clearTimeout(timer); fn(value); };
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', chunk => {
      buffer += chunk;
      const start = buffer.indexOf('[');
      const end = buffer.indexOf(']', start + 1);
      if (start < 0 || end < 0) return;
      try { done(resolve, JSON.parse(buffer.slice(start, end + 1))); } catch { /* wait for more */ }
    });
    parent.on('error', error => done(reject, error));
    parent.on('close', code => { if (code !== null) done(reject, new Error('the child tree exited early with ' + code)); });
  });
}

test('a real node process tree is killed by pid and proven gone (F7)', { skip: !windows, timeout: 180000 }, async () => {
  let parent = null;
  let pids = [];
  try {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const kids = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }));",
      "console.log(JSON.stringify([process.pid, ...kids.map(kid => kid.pid)]));",
      "setInterval(() => {}, 1000);",
    ].join('\n');
    parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    pids = await treePids(parent);
    assert.equal(pids.length, 3, 'one parent and two children');
    const tree = createProcessTree();
    const before = [];
    for (const pid of pids) {
      const row = await tree.identity(pid);
      assert.ok(row, 'the process table shows pid ' + pid);
      before.push({ pid, createdAt: row.createdAt });
    }
    const prover = createStopProver({ tree, pollMs: 250, stablePolls: 3 });
    // The graceful stop is the port's own job in production; here the fixture is already stuck, so the prover goes
    // straight to the grace period and then to taskkill.
    const row = await prover.prove({ subject: { kind: 'member-session', id: 'integration-tree', fence: 1 },
      roots: [{ pid: before[0].pid, createdAt: before[0].createdAt }], graceMs: 1000, proofTimeoutMs: 30000 });
    assert.equal(row.verified, false, 'no stop was proven: ' + JSON.stringify(row.error));
    assert.equal(row.descendantsAfter, 0);
    assert.equal(row.error.code, 'STOP_SCOPE_UNPROVEN');
    assert.ok(row.reaped.some(entry => entry.pid === before[0].pid), 'the root was reaped');
    assert.match(row.tool, /^taskkill \/PID \d+ \/T \/F$/, 'the kill is taskkill by pid, never by image name');
    for (const tracked of before) {
      const now = await tree.identity(tracked.pid);
      assert.ok(!now || now.createdAt !== tracked.createdAt, 'pid ' + tracked.pid + ' is gone');
    }
  } finally {
    await killQuietly(pids[0] ?? parent?.pid);
    parent?.stdout?.destroy();
  }
});
