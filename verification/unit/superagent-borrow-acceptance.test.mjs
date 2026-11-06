// P5 total acceptance: every §9 case is attached to a test file, every suite that runs those files is in the one
// offline entrance, and v1 is not activated by this wiring (the public entry still refuses it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BORROW_IMPLEMENTATION, assertProtocolSupported } from '../../packages/contracts/index.mjs';
import { teamSchemasForBorrow } from '../../packages/contracts/team-tools.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); continue; }
    if (entry.name.endsWith('.mjs') && entry.name.includes('test')) out.push(path.relative(root, full).replaceAll('\\', '/'));
  }
  return out;
};
const testFiles = walk(path.join(root, 'packages'));
for (const file of fs.readdirSync(path.join(root, 'verification'))) {
  if (file.startsWith('superagent-borrow-') && file.endsWith('.test.mjs')) testFiles.push('verification/' + file);
}
const corpus = new Map(testFiles.map(file => [file, read(file)]));

const designRecord = path.join(root, 'docs/decisions/superagent-borrow-design.md');
test('§9: the design checkpoint names exactly the T/R/B/H cases, and each has a test title',
  { skip: !fs.existsSync(designRecord) && 'the design record is internal and not part of the public export' }, () => {
  const design = read('docs/decisions/superagent-borrow-design.md');
  const ids = [...design.matchAll(/^-\s+\[[ x]\]\s+(T\d{2}|R\d{2}|B\d{2}|H\d{2})\b/gm)].map(match => match[1]);
  assert.equal(ids.length, 28, 'S1 x8 + S2 x5 + S3 x7 + S4 x8');
  assert.equal(new Set(ids).size, ids.length, 'no case is listed twice');
  const missing = [];
  for (const id of ids) {
    // T06 is split into T06a/T06b/T06c; a suffixed case still counts as the same §9 item.
    const file = [...corpus].find(([, text]) => new RegExp("test\\([^\\n]*\\b" + id + "[a-z]?\\b").test(text));
    if (!file) missing.push(id);
  }
  assert.deepEqual(missing, [], 'every §9 case name appears in a test title');
});

test('§9 total: the one offline entrance still retains the original package suites and adds P5', () => {
  // The suite table moved to runner/run-all-suites.mjs (WP-5a size split); the entrance imports it.
  const runAll = read('verification/run-all.mjs') + '\n' + read('verification/runner/run-all-suites.mjs');
  for (const id of ['driver-surface', 'superagent-borrow', 'core', 'profiles', 'host', 'ui',
    'superagent-borrow-p5', 'superagent-borrow-profile-e2e', 'superagent-borrow-performance']) {
    assert(runAll.includes("id: '" + id + "'"), 'run-all is missing ' + id);
  }
  // The P0 off golden and the §11 probes are still in the same suite; nothing removed them.
  assert(runAll.includes('verification/unit/superagent-borrow-p0.test.mjs'));
  assert(runAll.includes('verification/unit/superagent-borrow-probe.test.mjs'));
  // The new files are attached, not listed and forgotten.
  for (const file of ['verification/unit/superagent-borrow-p5.test.mjs', 'verification/unit/superagent-borrow-acceptance.test.mjs',
    'verification/e2e/superagent-borrow-profile-e2e.test.mjs', 'verification/unit/superagent-borrow-performance.test.mjs']) {
    assert(runAll.includes(file), 'run-all does not run ' + file);
  }
  assert(JSON.stringify(JSON.parse(read('package.json')).scripts).includes('verification/check-deps.mjs'));
});

test('§2/§10: P5 does not activate v1; the public entry stays closed while the integration publishes v1 schemas', () => {
  // Activation requires the public profile path, the policy writer/migration and the v1 model surface; this package
  // wires the read side and acceptance only. The position stays contract-only until those are accepted.
  assert.equal(BORROW_IMPLEMENTATION.v1, 'contract-only');
  assert.throws(() => assertProtocolSupported({ superagentBorrow: 'v1', intentSemantics: 'root-decision-v1' }),
    error => error?.code === 'PROTOCOL_UNSUPPORTED');
  assert(teamSchemasForBorrow('v1').team_read.oneOf.some(b => b.properties.view.const === 'thread-events'),
    'integration publishes schemas without activating v1');
});

// Source-title inventory above is a wiring check, not acceptance evidence. These are the reviewed behavioural suites,
// not an arbitrary corpus in which a projection test sharing a case number could hide a missing domain/host test.
const behaviouralFiles = [
  'packages/core/test/superagent-borrow-s1.test.mjs',
  'packages/core/test/superagent-borrow-s1-decisions.test.mjs',
  'packages/core/test/superagent-borrow-s1-review.test.mjs',
  'packages/profiles/test/superagent-borrow-s2.test.mjs',
  'packages/profiles/test/superagent-borrow-s2-review.test.mjs',
  'packages/core/test/superagent-borrow-s3.test.mjs',
  'packages/core/test/superagent-borrow-s3-review.test.mjs',
  'packages/profiles/test/superagent-borrow-s3-boundary.test.mjs',
  'packages/core/test/superagent-borrow-s4.test.mjs',
  'packages/profiles/test/superagent-borrow-s4-owner.test.mjs',
  'packages/host/test/superagent-borrow-s4-io.test.mjs',
];
test('§9 executable acceptance: all 28 cases pass real reducer/native/host assertions, with no skips or zero-test green', { timeout: 240000 }, () => {
  const env = { ...process.env }; delete env.CLOSEOUT_PROVIDER_KEY;
  // A fresh test runner must not inherit node:test's child marker (which otherwise suppresses --test discovery).
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...behaviouralFiles], {
    cwd: root, env, encoding: 'utf8', timeout: 210000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert.equal(result.status, 0, String(result.error ?? '') + output.slice(-12000));
  const count = name => Number(output.match(new RegExp('^# ' + name + ' ([0-9]+)$', 'm'))?.[1] ?? NaN);
  assert(count('tests') >= 80, 'the reviewed behavioural corpus actually ran');
  assert.equal(count('pass'), count('tests')); assert.equal(count('fail'), 0);
  assert.equal(count('skipped'), 0); assert.equal(count('todo'), 0); assert.equal(count('cancelled'), 0);
  const passed = [...output.matchAll(/^ok [0-9]+ - (.+)$/gm)].map(m => m[1]);
  const ids = ['T01','T02','T03','T04','T05','T06','T07','T08','R01','R02','R03','R04','R05',
    'B01','B02','B03','B04','B05','B06','B07','H01','H02','H03','H04','H05','H06','H07','H08'];
  for (const id of ids) assert(passed.some(title => new RegExp('(?:^|/)' + id + '[a-z]?(?=[: /])').test(title)), 'no executed behaviour for ' + id);
  // The larger compound cases require native boundaries/IO as well as reducer assertions, not P5's projection aliases.
  for (const title of ['held native step and tool are not aborted', 'real owner complete', 'real owner unknown',
    '8 contenders in 2 real processes contend', 'C full and normal head does not hide later human I',
    'selected owner model reaches the real owner request', 'every visible item traces back to its real row']) {
    assert(passed.some(name => name.includes(title)), 'missing executed boundary evidence: ' + title);
  }
  console.log('§9 executable evidence: 28/28 T/R/B/H; behavioural assertions=' + count('pass') + '; activation/migration/live latency remain gated');
});
