import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Contract tests for verification/check-parity.mjs (WP-0 of 20-M5-plan.md).
 *
 * Every case builds a throwaway repository under os.tmpdir() that carries its own copy of check-parity.mjs, so the
 * script under test resolves its root inside the fixture and the real tree is never read or written. The fixture is
 * three files (the gate, its measurer and its guarded reader): a suite entry that imports a helper, so a move and a
 * lost assertion can each be expressed in one edit.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'check-parity.mjs');
const measurePath = path.join(here, '..', 'runner', 'parity-measure.mjs');
const readPath = path.join(here, '..', 'runner', 'parity-read.mjs');

const SUITE = 'demo';
const ENTRY = 'verification/suite.test.mjs';
const HELPER = 'verification/helper.mjs';
const MOVED = 'verification/moved/helper.mjs';

const entrySource = importLine => [
  "import assert from 'node:assert/strict';",
  importLine,
  'assert.equal(1, 1);',
  ''
].join('\n');

const helperSource = count => [
  "import assert from 'node:assert/strict';",
  ...Array.from({ length: count }, (_, index) => 'assert.equal(' + (index + 2) + ', ' + (index + 2) + ');'),
  ''
].join('\n');

/** One fixture repository: entry (1 assert) + helper (helperAsserts) => suite total 1 + helperAsserts. */
function fixture({ helperAsserts = 3, helperAt = HELPER, importLine = "import './helper.mjs';", suite = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-fixture-'));
  const verification = path.join(root, 'verification');
  fs.mkdirSync(path.join(verification, 'runner'), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(verification, 'check-parity.mjs'));
  fs.copyFileSync(measurePath, path.join(verification, 'runner', 'parity-measure.mjs'));
  fs.copyFileSync(readPath, path.join(verification, 'runner', 'parity-read.mjs'));
  const manifest = {
    timeoutMs: 600000,
    suites: [{ id: SUITE, layer: 'unit', entry: [ENTRY], cwd: '.', root: null, expect: ['demo: PASS'], ...suite }]
  };
  fs.writeFileSync(path.join(verification, 'runner', 'suites.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(verification, 'suite.test.mjs'), entrySource(importLine));
  fs.mkdirSync(path.dirname(path.join(root, helperAt)), { recursive: true });
  fs.writeFileSync(path.join(root, helperAt), helperSource(helperAsserts));
  return root;
}

function run(root, args = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'verification', 'check-parity.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return { code: result.status, output: String(result.stdout ?? '') + String(result.stderr ?? '') };
}

const baselinePathOf = root => path.join(root, 'verification', 'parity-baseline.json');
const writeJson = (root, relative, value) => {
  fs.writeFileSync(path.join(root, 'verification', relative), JSON.stringify(value, null, 2) + '\n');
};
test('shrinksWithNoException: one assertion less fails the gate', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0, 'the first --write creates the baseline');
    fs.writeFileSync(path.join(root, HELPER), helperSource(2));
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /PARITY FAIL: demo: asserts 3\/4 \(-1\)/);
    assert.match(checked.output, /parity-exceptions\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shrinksWithException: an exact exception entry passes', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.writeFileSync(path.join(root, HELPER), helperSource(2));
    writeJson(root, 'parity-exceptions.json', {
      exceptions: [{ suite: SUITE, field: 'asserts', from: 4, to: 3, reason: 'the retired case is covered elsewhere' }]
    });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 0, checked.output);
    assert.match(checked.output, /exempt: the retired case is covered elsewhere/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeRefusesExistingBaselineShrink: --write keeps the old baseline', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    const before = fs.readFileSync(baselinePathOf(root), 'utf8');
    fs.writeFileSync(path.join(root, HELPER), helperSource(2));
    const written = run(root, ['--write']);
    assert.equal(written.code, 1, written.output);
    assert.match(written.output, /WRITE REFUSED: demo: asserts 3\/4 \(-1\)/);
    assert.equal(fs.readFileSync(baselinePathOf(root), 'utf8'), before, 'the baseline on disk is untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('moveWithMapPasses: a mapped move keeps the count', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.mkdirSync(path.join(root, 'verification', 'moved'), { recursive: true });
    fs.renameSync(path.join(root, HELPER), path.join(root, MOVED));
    fs.writeFileSync(path.join(root, ENTRY), entrySource("import './moved/helper.mjs';"));
    writeJson(root, 'runner/parity-moves.json', { moves: [{ from: HELPER, to: MOVED }] });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 0, checked.output);
    assert.doesNotMatch(checked.output, /files gone/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('moveThatLosesAssertsFails: a mapped move that drops one fails', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.mkdirSync(path.join(root, 'verification', 'moved'), { recursive: true });
    fs.writeFileSync(path.join(root, MOVED), helperSource(2));
    fs.rmSync(path.join(root, HELPER));
    fs.writeFileSync(path.join(root, ENTRY), entrySource("import './moved/helper.mjs';"));
    writeJson(root, 'runner/parity-moves.json', { moves: [{ from: HELPER, to: MOVED }] });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /move verification\/helper\.mjs -> verification\/moved\/helper\.mjs asserts 2\/3/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const moveTo = (root, target, helperAt = HELPER) => {
  fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
  fs.renameSync(path.join(root, helperAt), path.join(root, target));
  fs.writeFileSync(path.join(root, ENTRY), entrySource("import './moved/helper.mjs';"));
};

test('movesInvalidDuplicateTargetInsideOneMove', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    moveTo(root, MOVED);
    writeJson(root, 'runner/parity-moves.json', { moves: [{ from: HELPER, to: [MOVED, MOVED] }] });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /moves invalid: duplicate to inside one move/);
    const written = run(root, ['--write']);
    assert.equal(written.code, 1, written.output);
    assert.match(written.output, /WRITE REFUSED: moves invalid:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('movesInvalidTargetSharedByTwoMoves', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    moveTo(root, MOVED);
    writeJson(root, 'runner/parity-moves.json', {
      moves: [{ from: HELPER, to: MOVED }, { from: ENTRY, to: MOVED }]
    });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /moves invalid: to shared by two moves/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('movesInvalidTargetAlreadyInBaseline', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    writeJson(root, 'runner/parity-moves.json', { moves: [{ from: HELPER, to: ENTRY }] });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /moves invalid: to already exists in the baseline and is not a from/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('movesInvalidDuplicateFrom', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    moveTo(root, MOVED);
    writeJson(root, 'runner/parity-moves.json', {
      moves: [{ from: HELPER, to: MOVED }, { from: HELPER, to: 'verification/other/helper.mjs' }]
    });
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /moves invalid: duplicate from: verification\/helper\.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('referenceIntoRunsIsReportedNotFiltered', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runs', 'evidence.mjs'), "import assert from 'node:assert/strict';\nassert.equal(7, 7);\n");
    fs.writeFileSync(path.join(root, ENTRY), entrySource("import '../runs/evidence.mjs';\nimport './helper.mjs';"));
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /never scanned: demo: runs\/evidence\.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('archiveFileIsNeverOpened', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.mkdirSync(path.join(root, 'verification', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification', 'archive', 'legacy.mjs'),
      "import assert from 'node:assert/strict';\nassert.equal(9, 9);\n");
    fs.writeFileSync(path.join(root, ENTRY), entrySource("import './helper.mjs';\nimport './archive/legacy.mjs';"));
    const checked = run(root, ['--check'], { DSH_PARITY_TRACE_READS: '1' });
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /never scanned: demo: verification\/archive\/legacy\.mjs/);
    assert.match(checked.output, /^read verification\/helper\.mjs$/m, 'the trace records real reads');
    assert.doesNotMatch(checked.output, /^read verification\/archive\/legacy\.mjs$/m,
      'the archived file must not be opened at all');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('moveTargetInArchiveIsNeverRead', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.mkdirSync(path.join(root, 'verification', 'archive'), { recursive: true });
    // Same assertion count as the helper, so a counted target would look perfectly healthy.
    fs.writeFileSync(path.join(root, 'verification', 'archive', 'legacy.mjs'), helperSource(3));
    writeJson(root, 'runner/parity-moves.json', { moves: [{ from: HELPER, to: 'verification/archive/legacy.mjs' }] });
    const checked = run(root, ['--check'], { DSH_PARITY_TRACE_READS: '1' });
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /moves invalid: to is a path that is never scanned: verification\/archive\/legacy\.mjs/);
    assert.doesNotMatch(checked.output, /^read verification\/archive\/legacy\.mjs$/m,
      'a mapping into the archive must not even count the target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('suiteCwdInsideArchiveIsNotWalked', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.mkdirSync(path.join(root, 'verification', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification', 'archive', 'legacy.test.mjs'),
      "import assert from 'node:assert/strict';\nassert.equal(5, 5);\n");
    writeJson(root, 'runner/suites.json', {
      timeoutMs: 600000,
      suites: [{ id: SUITE, layer: 'unit', entry: ['legacy.test.mjs'], cwd: 'verification/archive', expect: ['demo: PASS'] }]
    });
    const checked = run(root, ['--check'], { DSH_PARITY_TRACE_READS: '1' });
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /never scanned: demo: verification\/archive/);
    assert.doesNotMatch(checked.output, /^read verification\/archive\//m, 'nothing under the archive cwd is read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('closureMayNotReachArchiveRunsOrNodeModules', async () => {
  const root = fixture();
  try {
    assert.equal(run(root, ['--write']).code, 0);
    fs.mkdirSync(path.join(root, 'verification', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification', 'archive', 'legacy.mjs'),
      "import assert from 'node:assert/strict';\nassert.equal(9, 9);\n");
    fs.writeFileSync(path.join(root, ENTRY), entrySource("import './helper.mjs';\nimport './archive/legacy.mjs';"));
    const checked = run(root, ['--check']);
    assert.equal(checked.code, 1, checked.output);
    assert.match(checked.output, /never scanned: demo: verification\/archive\/legacy\.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
