// Review 1, item 6: with the autonomy switch off, a running team must be HEAD's, and that has to be shown against HEAD
// itself -- not against a list of expected entries.
//
// This test extracts the committed baseline (`git archive f41fdd1`) into a throwaway directory, copies ONE fixed
// scenario file into it (verification/autonomy-off-baseline-scenario.mjs), runs it there and here with the same store
// shape, and requires the two answers to be identical. The scenario covers the three things the review named: the
// observation writes (usage rows / read-model facts / journal events), the published tool surface (schema and per-role
// catalogs), and the journal sequence of a fixed set of real tool calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE = 'f41fdd1';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenario = path.join(repo, 'verification', 'fixtures', 'autonomy-off-baseline-scenario.mjs');

/** A pristine checkout of the committed baseline; the commit is a contract of this test, so its absence is a failure. */
function headTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-head-baseline-'));
  const archive = path.join(dir, 'head.tar');
  try {
    execFileSync('git', ['cat-file', '-e', BASELINE + '^{commit}'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  } catch (error) {
    throw Error('the baseline commit ' + BASELINE + ' is not in this repository (' + (error.message ?? error) + '); the ' +
      'off-switch comparison needs the committed code, not a description of it');
  }
  execFileSync('git', ['archive', '--format=tar', '-o', archive, BASELINE], { cwd: repo, windowsHide: true });
  const tree = path.join(dir, 'head');
  fs.mkdirSync(tree, { recursive: true });
  // Relative paths and a relative -C, run from the extraction directory: a drive letter in -f is "host:path" to the tar
  // that ships with this platform, and the tree this unpacks is never outside the throwaway directory anyway.
  execFileSync('tar', ['-xf', 'head.tar', '-C', 'head'], { cwd: dir, windowsHide: true });
  const BASELINE_SCENARIO = 'autonomy-off-baseline-scenario.mjs';
  // The package directories were renamed after this baseline commit (team-core -> core, control-store -> store): the
  // copy stays the same file, and only its relative import paths are translated to the names that tree carries.
  const BASELINE_PACKAGES = { core: 'team-core', store: 'control-store', 'adapter-dsh': 'dsh-adapter', ui: 'client-team' };
  const baselineScenario = fs.readFileSync(scenario, 'utf8').replace(/\.\.\/\.\.\/packages\/(core|store|adapter-dsh|ui)\//g,
    (whole, name) => '../../packages/' + BASELINE_PACKAGES[name] + '/');
  fs.mkdirSync(path.join(tree, 'verification', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'verification', 'fixtures', BASELINE_SCENARIO), baselineScenario);
  // packages/delivery resolves its git roots against <repo>/runs at import time and refuses a root that does not exist;
  // an archive carries no ignored directory, so the tree gets the same empty root the working copy has.
  fs.mkdirSync(path.join(tree, 'runs'), { recursive: true });
  return { dir, tree };
}

/** Run the scenario in one tree over its own store and return what it printed. */
function run(tree, scriptPath, storeRoot) {
  const out = execFileSync(process.execPath, [scriptPath, storeRoot], { cwd: tree, encoding: 'utf8', windowsHide: true,
    maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim().split(/\r?\n/).at(-1));
}

test('the autonomy switch off is HEAD: same observation, same tool surface, same journal', { timeout: 240000 }, () => {
  const head = headTree();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-off-baseline-run-'));
  try {
    const before = run(head.tree, path.join(head.tree, 'verification', 'fixtures', 'autonomy-off-baseline-scenario.mjs'),
      path.join(scratch, 'head-store'));
    const after = run(repo, scenario, path.join(scratch, 'work-store'));
    // Named assertions first, so a regression says which half moved instead of only "the documents differ".
    assert.equal(after.usageRows, before.usageRows, 'the switch off writes exactly the usage rows HEAD wrote');
    assert.equal(after.usageRows, 0, 'and HEAD wrote none: the measurement ledger belongs to the package');
    assert.deepEqual(after.readModels, before.readModels, 'the observation facts are the same facts');
    assert.equal(after.schemas, before.schemas, 'teamSchemasFor("off") is HEAD\'s published surface');
    assert.deepEqual(after.roles, before.roles, 'and every role catalog is the one HEAD published');
    assert.deepEqual(after.toolResults, before.toolResults, 'the same real tool calls answer the same way');
    assert.deepEqual(after.journal, before.journal, 'and the journal is the same sequence of the same rows');
    assert.deepEqual(after.rows, before.rows, 'every stored row is the same row');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(head.dir, { recursive: true, force: true });
  }
});
