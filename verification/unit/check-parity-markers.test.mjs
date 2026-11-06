import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Marker accounting across a split rename (WP-6 review, check-parity.mjs summary).
 *
 * A renamed suite keeps the baseline of the split source it came from, a changed marker must still fail, and a
 * mapping the validator rejects must never back anything. Each case builds a throwaway repository with its own copy
 * of the gate, exactly like check-parity.test.mjs, so the real tree is never read or written.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'check-parity.mjs');
const measurePath = path.join(here, '..', 'runner', 'parity-measure.mjs');
const readPath = path.join(here, '..', 'runner', 'parity-read.mjs');

const SUITE = 'demo';
const ENTRY = 'verification/suite.test.mjs';
const entrySource = "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n";

const writeJson = (root, relative, value) =>
  fs.writeFileSync(path.join(root, 'verification', relative), JSON.stringify(value, null, 2) + '\n');

/** One suite under the id a rename leaves behind; the marker defaults to the baseline's evidence. */
const manifestOf = (id, expect = ['demo: PASS']) => ({
  timeoutMs: 600000,
  suites: [{ id, layer: 'unit', entry: [ENTRY], cwd: '.', root: null, expect }]
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-markers-'));
  const verification = path.join(root, 'verification');
  fs.mkdirSync(path.join(verification, 'runner'), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(verification, 'check-parity.mjs'));
  fs.copyFileSync(measurePath, path.join(verification, 'runner', 'parity-measure.mjs'));
  fs.copyFileSync(readPath, path.join(verification, 'runner', 'parity-read.mjs'));
  writeJson(root, 'runner/suites.json', manifestOf(SUITE));
  fs.writeFileSync(path.join(root, ENTRY), entrySource);
  return root;
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [path.join(root, 'verification', 'check-parity.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env }
  });
  return { code: result.status, output: String(result.stdout ?? '') + String(result.stderr ?? '') };
}

test('markersFollowASplitRename', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    writeJson(root, 'runner/suites.json', manifestOf('domain/demo'));
    writeJson(root, 'runner/parity-moves.json', { splits: [{ from: SUITE, to: ['domain/demo'] }] });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 0, checked.output);
    assert.match(checked.output, /markers=1\/1/, 'the renamed suite is backed by its split source');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('markersMismatchAfterASplitRenameStillFails', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    writeJson(root, 'runner/suites.json', manifestOf('domain/demo', ['demo: CHANGED']));
    writeJson(root, 'runner/parity-moves.json', { splits: [{ from: SUITE, to: ['domain/demo'] }] });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /domain\/demo: success markers changed/);
    assert.match(checked.output, /markers=0\/1/, 'a changed marker is never counted as backed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalidSplitNeverBacksASuite', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    writeJson(root, 'runner/suites.json', manifestOf('domain/demo'));
    writeJson(root, 'runner/parity-moves.json', { splits: [{ from: SUITE, to: ['domain/demo', 'ghost'] }] });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /splits invalid: split target is not a suite: ghost/);
    assert.match(checked.output, /markers=0\/1/, 'a rejected mapping contributes nothing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
