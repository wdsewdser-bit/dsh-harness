import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

/**
 * The acceptance command for the instant-preempt candidate.
 *
 * Four offline runs, each in its own home directory, no socket and no provider:
 *   original  the upstream install, default scenario      -> parity baseline
 *   patched   the C2 build with instantInterrupt off      -> must match the baseline exactly
 *   cold      the C2 build resuming the flushed session   -> must replay with zero requests
 *   instant   the C2 build with instantInterrupt on       -> cases A, B, C, D, E, F, G
 * plus a team run (case H) that drives a real durable delivery through tools.mjs/preempt.mjs into a live step,
 * and a profile run that proves the switch itself: the default profile is the upstream configuration under both
 * builds, and DSH_UPSTREAM_BUILD is the only thing that changes the team profile.
 */
const root = path.dirname(fileURLToPath(import.meta.url));
const runDir = path.join(root, 'runs', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
let failed = false;

const child = (script, args) => {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], { encoding: 'utf8', cwd: root });
  return { status: result.status, text: (result.stdout ?? '') + (result.stderr ?? '') };
};

const modes = ['original', 'patched', 'cold', 'instant'];
for (const mode of modes) {
  const home = path.join(runDir, mode);
  fs.mkdirSync(home, { recursive: true });
  const result = child('probe.mjs', [mode, home]);
  fs.writeFileSync(path.join(runDir, mode + '.log'), result.text);
  console.log('=== ' + mode + ' exit=' + result.status + ' ===\n' + result.text);
  if (result.status !== 0) failed = true;
}
{
  // H is the plugin half: a durable team delivery that lands inside a live step, through the real send path.
  const result = child('team-preempt-probe.mjs', [path.join(runDir, 'team')]);
  fs.writeFileSync(path.join(runDir, 'team.log'), result.text);
  console.log('=== team exit=' + result.status + ' ===\n' + result.text);
  if (result.status !== 0) failed = true;
}
{
  // The host wiring's refusal half: a Team runtime that never becomes ready must fail bootProfile, not surface later
  // as an undefined core (patches/upstream-0.2.2-rc.1/profile-host.mjs).
  const result = child('../profile-host-ready.test.mjs', []);
  fs.writeFileSync(path.join(runDir, 'ready.log'), result.text);
  console.log('=== ready exit=' + result.status + ' ===\n' + result.text);
  if (result.status !== 0) failed = true;
}

{
  const result = child('profile-probe.mjs', [path.join(runDir, 'profiles')]);
  fs.writeFileSync(path.join(runDir, 'profiles.log'), result.text);
  console.log('=== profiles exit=' + result.status + ' ===\n' + result.text);
  if (result.status !== 0) failed = true;
}

{
  const result = child('executor-probe.mjs', []);
  fs.writeFileSync(path.join(runDir, 'executor.log'), result.text);
  console.log('=== executor exit=' + result.status + ' ===\n' + result.text);
  if (result.status !== 0) failed = true;
}

// P: with the flag off, the patched build must reproduce the upstream journal byte for byte.
try {
  const original = JSON.parse(fs.readFileSync(path.join(runDir, 'original/default.json')));
  const patched = JSON.parse(fs.readFileSync(path.join(runDir, 'patched/default.json')));
  assert.deepEqual(patched, original);
  console.log('PASS switch-off parity: the candidate build with instantInterrupt off is the upstream journal');
} catch (error) { failed = true; console.error(error); }

// The instant run must have produced every case, so a silently skipped case cannot pass as green.
try {
  const instant = JSON.parse(fs.readFileSync(path.join(runDir, 'instant/instant.json')));
  const cold = JSON.parse(fs.readFileSync(path.join(runDir, 'cold/cold.json')));
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) assert.equal(instant[name]?.ok, true, 'case ' + name + ' did not run');
  const team = JSON.parse(fs.readFileSync(path.join(runDir, 'team/team-preempt.json')));
  assert.equal(team.ok, true, 'the team delivery case did not run');
  assert.equal(team.counters.preempts, 1);
  assert.equal(cold.replayEqualsJournal, true);
  assert.equal(cold.requestsWhileResuming, 0);
  console.log('PASS instant cases A B C D E F G and cold resume');
} catch (error) { failed = true; console.error(error); }

const status = failed ? 'blocked' : 'passed';
fs.writeFileSync(path.join(root, 'latest-run.json'), JSON.stringify({ run: runDir, failed, status }, null, 2));
console.log('TASK_TERMINAL=' + status);
process.exitCode = failed ? 1 : 0;