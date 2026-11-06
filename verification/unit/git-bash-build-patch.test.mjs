import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defaultBuild } from '../../packages/adapter-dsh/build-target.mjs';
import { BASH_PIN_URL, WHITELIST, installGitBash, patchGitBashFiles } from './git-bash-build-patch.mjs';

/**
 * WP-D: the build patch is a decision over the WHOLE FILE, and it fails closed.
 *
 * The fixtures here are the real upstream text (the default build's copies, hash-checked against the pinned upstream
 * fingerprint below), so the normal case is the case that actually runs. Everything else is a text that is neither
 * upstream nor this patch's own result, and every one of them must be refused with the files left byte-for-byte as they
 * were. That includes the two shapes the review reproduced by hand - a low-indent comment between the fields of a record,
 * and an id carrying a trailing comment - which keep the replacement anchor intact on purpose: an anchor-based patch
 * would happily rewrite them, and only the whole-file fingerprint refuses them.
 *
 * The whitelist itself is a test subject: exactly four whole-file sha256 values, one unmodified and one patched per
 * file, and nothing else is accepted.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const FILES = Object.freeze({
  base: 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
  preset: 'node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml',
});

const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const fingerprint = (file, state) => {
  const entries = WHITELIST.filter(entry => entry.file === file && entry.state === state);
  assert.equal(entries.length, 1, file + ' has exactly one pinned ' + state + ' fingerprint');
  return entries[0].sha256;
};
const upstreamText = file => fs.readFileSync(path.join(defaultBuild(), FILES[file]), 'utf8');

/** The same two files as an install lays them out (a package root, without the node_modules prefix). */
const PACKAGE_FILES = Object.freeze({
  base: 'dsh-base/cordis.patch.yml',
  preset: 'dsh-web-app/presets/standard.patch.yml',
});

/** Write a package tree - the thing a junction in a build can point at. */
function writePackages(root, { base, preset }) {
  fs.mkdirSync(path.dirname(path.join(root, PACKAGE_FILES.base)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, PACKAGE_FILES.preset)), { recursive: true });
  fs.writeFileSync(path.join(root, PACKAGE_FILES.base), base);
  fs.writeFileSync(path.join(root, PACKAGE_FILES.preset), preset);
}

/** Write a whole build under runs/. */
function writeBuild(root, { base, preset }) {
  writePackages(path.join(root, 'node_modules/@deepseek-ai'), { base, preset });
}

const packagesSnapshot = root => Object.fromEntries(Object.keys(PACKAGE_FILES).map(file =>
  [file, fs.readFileSync(path.join(root, PACKAGE_FILES[file]))]));

/** A directory outside runs/, where a link must never lead a write. */
const outsideRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-d-outside-'));

const removeLink = link => {
  try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* already gone */ } }
};
const noLinks = error => error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN';

const upstreamBase = upstreamText('base');
const upstreamPreset = upstreamText('preset');

const ANCHOR_BASH_SANDBOX = [
  '    - id: bash-sandbox',
  "      name: '@deepseek-ai/dsh-bash-sandbox'",
  "      disabled: !!js process.platform === 'win32'",
  '      config:',
  '        timeoutMs: 60000',
  '',
].join('\n');

/** A throwaway build under runs/ (the patch refuses any other target), removed whatever the test does. */
function fixture({ base, preset }, run) {
  const dir = fs.mkdtempSync(path.join(repoRoot, 'runs', 'wp-d-patch-fixture-'));
  try {
    fs.mkdirSync(path.dirname(path.join(dir, FILES.base)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(dir, FILES.preset)), { recursive: true });
    fs.writeFileSync(path.join(dir, FILES.base), base);
    fs.writeFileSync(path.join(dir, FILES.preset), preset);
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const snapshot = dir => Object.fromEntries(Object.keys(FILES).map(file =>
  [file, fs.readFileSync(path.join(dir, FILES[file]))]));

function expectRefused({ base, preset }) {
  fixture({ base, preset }, dir => {
    const before = snapshot(dir);
    assert.throws(() => installGitBash(dir), error => {
      assert.equal(error.code, 'PATCH_MISSING');
      assert.match(error.message, /neither the pinned upstream/);
      return true;
    });
    assert.deepEqual(snapshot(dir), before, 'a refused patch leaves every file untouched');
  });
}

test('the default build carries the pinned upstream text and the patch reproduces the pinned result', () => {
  assert.equal(hash(upstreamBase), fingerprint('base', 'upstream'));
  assert.equal(hash(upstreamPreset), fingerprint('preset', 'upstream'));
  assert.ok(BASH_PIN_URL.endsWith('/packages/profiles/shell-bash-pin.mjs'));

  const patched = patchGitBashFiles({ base: upstreamBase, preset: upstreamPreset });
  assert.equal(hash(patched.base), fingerprint('base', 'patched'));
  assert.equal(hash(patched.preset), fingerprint('preset', 'patched'));
  assert.deepEqual(patched.changed, { base: true, preset: true });

  // The rows the package exists for.
  assert.equal(patched.base.split('    - id: bash-pin').length - 1, 1, 'exactly one bash-pin row');
  assert.ok(patched.base.includes("      name: '" + BASH_PIN_URL + "'"), 'the row names this checkout\'s executor');
  assert.ok(patched.base.includes(
    '    - id: pwsh-sandbox\n      name: \'@deepseek-ai/dsh-pwsh-sandbox\'\n      disabled: true\n'),
  'pwsh-sandbox is disabled outright, not left as a fallback');
  assert.equal(patched.preset.includes('tool-pwsh'), false, 'no pwsh tool row survives');
  assert.equal(patched.preset.split("name: '@deepseek-ai/dsh-tool-bash'").length - 1, 1);
  assert.equal(patched.preset.includes("dsh-tool-bash'\n            disabled:"), false, 'tool-bash is enabled on win32');

  // Already patched is a no-op that returns the same text, and CRLF is the same file, not a different one.
  const again = patchGitBashFiles({ base: patched.base, preset: patched.preset });
  assert.deepEqual(again.changed, { base: false, preset: false });
  assert.equal(again.base, patched.base);
  assert.equal(again.preset, patched.preset);
  const crlf = patchGitBashFiles({ base: upstreamBase.replace(/\n/g, '\r\n'), preset: upstreamPreset.replace(/\n/g, '\r\n') });
  assert.equal(crlf.base, patched.base);
  assert.equal(crlf.preset, patched.preset);
});

test('a prepared build is patched once, and a second run writes nothing', () => {
  fixture({ base: upstreamBase, preset: upstreamPreset }, dir => {
    const result = installGitBash(dir);
    assert.equal(result.bashPinUrl, BASH_PIN_URL);
    for (const file of Object.keys(FILES)) {
      assert.equal(hash(fs.readFileSync(path.join(dir, FILES[file]), 'utf8')), fingerprint(file, 'patched'));
    }
    const before = Object.keys(FILES).map(file => {
      const target = path.join(dir, FILES[file]);
      return { text: fs.readFileSync(target, 'utf8'), mtime: fs.statSync(target).mtimeMs };
    });
    installGitBash(dir);
    const after = Object.keys(FILES).map(file => {
      const target = path.join(dir, FILES[file]);
      return { text: fs.readFileSync(target, 'utf8'), mtime: fs.statSync(target).mtimeMs };
    });
    assert.deepEqual(after.map(entry => entry.text), before.map(entry => entry.text));
    assert.deepEqual(after.map(entry => entry.mtime), before.map(entry => entry.mtime), 'nothing was rewritten');
  });
});

test('text that is neither upstream nor the pinned result is refused and nothing is written', async t => {
  const variants = [
    {
      name: 'a low-indent comment followed by fields inside the bash-sandbox record',
      file: 'base',
      text: upstreamBase.replace(ANCHOR_BASH_SANDBOX, ANCHOR_BASH_SANDBOX + '  # note about the row below\n      smuggled: true\n'),
      anchor: ANCHOR_BASH_SANDBOX,
    },
    {
      name: 'an id carrying a trailing comment',
      file: 'base',
      text: upstreamBase.replace('    - id: pwsh-sandbox\n', '    - id: pwsh-sandbox # the windows fallback\n'),
    },
    {
      name: 'a missing bash-sandbox row',
      file: 'base',
      text: upstreamBase.replace(ANCHOR_BASH_SANDBOX, ''),
    },
    {
      name: 'a bash-pin row with a different config already present',
      file: 'base',
      text: upstreamBase.replace(ANCHOR_BASH_SANDBOX, ANCHOR_BASH_SANDBOX +
        '\n    - id: bash-pin\n      name: \'file:///elsewhere/bash.exe.mjs\'\n      disabled: false\n' +
        '      config:\n        timeoutMs: 1000\n'),
      anchor: ANCHOR_BASH_SANDBOX,
    },
    {
      name: 'a bash-pin row carrying extra fields',
      file: 'base',
      text: upstreamBase.replace(ANCHOR_BASH_SANDBOX, ANCHOR_BASH_SANDBOX +
        '\n    - id: bash-pin\n      name: \'' + BASH_PIN_URL + '\'\n      disabled: !!js process.platform !== \'win32\'\n' +
        '      config: {}\n      inject: [timeoutMs]\n'),
      anchor: ANCHOR_BASH_SANDBOX,
    },
    {
      name: 'a pwsh-sandbox row left enabled as a fallback',
      file: 'base',
      text: upstreamBase.replace(
        "    - id: pwsh-sandbox\n      name: '@deepseek-ai/dsh-pwsh-sandbox'\n      disabled: !!js process.platform !== 'win32'\n",
        "    - id: pwsh-sandbox\n      name: '@deepseek-ai/dsh-pwsh-sandbox'\n"),
    },
    {
      name: 'a preset that already lost its tool-bash row',
      file: 'preset',
      text: upstreamPreset.replace(
        "          - id: tool-bash\n            name: '@deepseek-ai/dsh-tool-bash'\n            disabled: !!js process.platform === 'win32'\n",
        ''),
    },
  ];
  for (const variant of variants) {
    await t.test(variant.name, () => {
      assert.notEqual(hash(variant.text), fingerprint(variant.file, 'upstream'), 'the fixture is not the upstream text');
      assert.notEqual(hash(variant.text), fingerprint(variant.file, 'patched'), 'the fixture is not the patched text');
      if (variant.anchor) {
        assert.equal(variant.text.split(variant.anchor).length, 2,
          'the replacement anchor is still intact: only the whole-file fingerprint can refuse this');
      }
      expectRefused(upstream(variant));
    });
  }
});

test('a build that is a junction to a directory outside runs is refused', t => {
  const host = fs.mkdtempSync(path.join(repoRoot, 'runs', 'wp-d-link-'));
  const outside = outsideRoot();
  const link = path.join(host, 'build-link');
  try {
    writeBuild(outside, { base: upstreamBase, preset: upstreamPreset });
    try { fs.symlinkSync(outside, link, 'junction'); } catch (error) {
      if (noLinks(error)) { t.skip('this machine cannot create a junction: ' + error.code); return; }
      throw error;
    }
    const root = path.join(outside, 'node_modules/@deepseek-ai');
    const before = packagesSnapshot(root);
    assert.throws(() => installGitBash(link), error => {
      assert.equal(error.code, 'PATCH_OUTSIDE_RUNS');
      assert.match(error.message, /not physically inside runs/);
      return true;
    });
    assert.deepEqual(packagesSnapshot(root), before, 'the directory the junction points at is untouched');
  } finally {
    removeLink(link);
    fs.rmSync(host, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a node_modules/@deepseek-ai junction to an install outside runs is refused', t => {
  const build = fs.mkdtempSync(path.join(repoRoot, 'runs', 'wp-d-link-'));
  const outside = outsideRoot();
  const link = path.join(build, 'node_modules/@deepseek-ai');
  try {
    writePackages(outside, { base: upstreamBase, preset: upstreamPreset });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(outside, link, 'junction'); } catch (error) {
      if (noLinks(error)) { t.skip('this machine cannot create a junction: ' + error.code); return; }
      throw error;
    }
    const before = packagesSnapshot(outside);
    assert.throws(() => installGitBash(build), error => {
      assert.equal(error.code, 'PATCH_OUTSIDE_RUNS');
      assert.match(error.message, /resolves outside the build/);
      return true;
    });
    assert.deepEqual(packagesSnapshot(outside), before, 'the install the junction points at is untouched');
  } finally {
    removeLink(link);
    fs.rmSync(build, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a target file that is a link is refused, even when it points at a valid copy', t => {
  const build = fs.mkdtempSync(path.join(repoRoot, 'runs', 'wp-d-link-'));
  const outside = outsideRoot();
  const link = path.join(build, FILES.preset);
  try {
    writeBuild(build, { base: upstreamBase, preset: upstreamPreset });
    writePackages(outside, { base: upstreamBase, preset: upstreamPreset });
    fs.rmSync(link);
    try { fs.symlinkSync(path.join(outside, PACKAGE_FILES.preset), link, 'file'); } catch (error) {
      if (noLinks(error)) { t.skip('this machine cannot create file links without elevation: ' + error.code); return; }
      throw error;
    }
    const before = packagesSnapshot(outside);
    assert.throws(() => installGitBash(build), error => {
      assert.equal(error.code, 'PATCH_OUTSIDE_RUNS');
      assert.match(error.message, /is a link, not a file/);
      return true;
    });
    assert.deepEqual(packagesSnapshot(outside), before, 'the file the link points at is untouched');
    assert.equal(hash(fs.readFileSync(path.join(build, FILES.base), 'utf8')), fingerprint('base', 'upstream'),
      'the other file is not written either: the refusal happens before the first write');
  } finally {
    removeLink(link);
    fs.rmSync(build, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the whitelist is four whole-file fingerprints, one upstream and one patched per file', () => {
  assert.equal(WHITELIST.length, 4);
  for (const file of ['base', 'preset']) {
    const upstream = fingerprint(file, 'upstream');
    const patched = fingerprint(file, 'patched');
    for (const value of [upstream, patched]) assert.match(value, /^[0-9a-f]{64}$/);
    assert.notEqual(upstream, patched);
  }
  assert.equal(Object.isFrozen(WHITELIST), true);
  assert.equal(WHITELIST.every(entry => Object.isFrozen(entry)), true);
});

/** The pair to hand the fixture: the variant's file, and the untouched upstream for the other one. */
function upstream(variant) {
  return variant.file === 'base'
    ? { base: variant.text, preset: upstreamPreset }
    : { base: upstreamBase, preset: variant.text };
}
