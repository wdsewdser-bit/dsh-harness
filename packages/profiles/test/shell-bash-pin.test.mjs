import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASH_PIN_ID, BASH_PIN_MODULE, GIT_BASH, GIT_BASH_BIN, bashPinEntry, resolveBashPath } from '../shell-entries.mjs';
import { generate } from '../index.mjs';

/**
 * WP-D: Windows runs Git Bash - one pinned provider, no pwsh, no sandbox, no fallback.
 *
 * These assertions are about the *choice*, not the machine: the default program is pinned by value, the environment
 * override is the only other source, and a program that is not there is BASH_PIN_MISSING rather than a substitute.
 * The live run (this machine's Git Bash, real commands, real timeout) is verification/archive/wp-d-git-bash.mjs.
 *
 * "The bytes did not move" is checked against the generator as it was BEFORE this change - the fixed baseline commit
 * 190751e - not against the generator under test: a self-comparison cannot see a change to the output, and HEAD moves
 * with every commit, so it would stop being a baseline the moment this work lands. The baseline module is re-pointed at
 * this repository - every relative specifier and every `new URL('./x', import.meta.url)` becomes the absolute file URL
 * of the real file - so it can live in the system temp directory and still import the real modules and name the real
 * plugin URLs.
 */
const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(packageDir, '../..');
/** The pre-WP-D generator, by commit: "unchanged" means unchanged against this, whatever HEAD later becomes. */
const GOLDEN_COMMIT = '190751e';
const SPEC = { team: true, guard: true, goalCheck: true };

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bash-pin-'));
const withBashPath = (value, run) => {
  const previous = process.env.DSH_BASH_PATH;
  if (value === undefined) delete process.env.DSH_BASH_PATH; else process.env.DSH_BASH_PATH = value;
  try { return run(); } finally {
    if (previous === undefined) delete process.env.DSH_BASH_PATH; else process.env.DSH_BASH_PATH = previous;
  }
};

/** Run with an injected platform, so both arms are asserted on every machine. */
async function withPlatform(platform, run) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return await run(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}

/** The baseline generator (190751e), re-pointed at this repository so it can be imported from anywhere. */
function mirrorHead(source) {
  const absolute = specifier => pathToFileURL(path.resolve(packageDir, specifier)).href;
  return source
    .replace(/\bfrom\s+(['"])(\.[^'"]*)\1/g, (_, quote, specifier) => 'from ' + JSON.stringify(absolute(specifier)))
    .replace(/(\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g, (_, lead, quote, specifier) => lead + JSON.stringify(absolute(specifier)))
    .replace(/(\bimport\s+)(['"])(\.[^'"]*)\2/g, (_, lead, quote, specifier) => lead + JSON.stringify(absolute(specifier)))
    .replace(/new URL\(\s*(['"])(\.\/[^'"]*)\1\s*,\s*import\.meta\.url\s*\)/g,
      (_, quote, specifier) => 'new URL(' + JSON.stringify(absolute(specifier)) + ')');
}

/** The generate() of the baseline commit, as its own module in the system temp directory, for golden comparisons. */
async function headGenerator() {
  const spec = GOLDEN_COMMIT + ':packages/profiles/index.mjs';
  const shown = spawnSync('git', ['show', spec], { cwd: repoRoot, encoding: 'utf8' });
  if (shown.status !== 0) throw Error('GOLDEN_MISSING: git show ' + spec + ' failed: ' + (shown.stderr ?? '').slice(-400));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-head-generator-'));
  const file = path.join(dir, 'index.mjs');
  fs.writeFileSync(file, mirrorHead(shown.stdout));
  try { return { generate: (await import(pathToFileURL(file).href)).generate, dir }; }
  catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
}

const bytesOf = root => fs.readFileSync(root + '/cordis.patch.yml', 'utf8');

test('the pinned program is Git for Windows usr/bin/bash.exe', () => {
  assert.equal(GIT_BASH_BIN, 'C:/Program Files/Git/usr/bin');
  assert.equal(GIT_BASH, 'C:/Program Files/Git/usr/bin/bash.exe');
});

test('DSH_BASH_PATH overrides the program; a missing one is BASH_PIN_MISSING, never a substitute', () => {
  const dir = tempRoot();
  try {
    const present = path.join(dir, 'bash.exe');
    fs.writeFileSync(present, '');
    assert.equal(resolveBashPath({ DSH_BASH_PATH: present }), present);
    for (const missing of [path.join(dir, 'missing.exe'), '']) {
      assert.throws(() => resolveBashPath({ DSH_BASH_PATH: missing }),
        error => error.code === 'BASH_PIN_MISSING' && /^BASH_PIN_MISSING: /.test(error.message), JSON.stringify(missing));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the entry names the executor module and is enabled only on win32', () => {
  assert.deepEqual(bashPinEntry('win32'), { id: BASH_PIN_ID, name: BASH_PIN_MODULE, config: {} });
  assert.deepEqual(bashPinEntry('linux'), { id: BASH_PIN_ID, name: BASH_PIN_MODULE, disabled: true, config: {} });
  assert.match(BASH_PIN_MODULE, /shell-bash-pin\.mjs$/);
});

test('generate(): no shell key is byte for byte what the baseline generator (190751e) generates', async () => {
  const head = await headGenerator();
  const dir = tempRoot();
  try {
    const root = dir + '/profile';
    const before = head.generate(root, SPEC);
    const beforeBytes = bytesOf(root);
    const now = generate(root, SPEC);
    assert.equal(bytesOf(root), beforeBytes, 'byte for byte the same profile');
    assert.deepEqual(now.entries, before.entries);
    assert.deepEqual(now.whitelist, before.whitelist);
    assert.equal(now.capabilityHash, before.capabilityHash);
    assert.equal(now.entries.some(entry => entry.id === BASH_PIN_ID), false);
    assert.equal(beforeBytes.includes('shell-bash-pin'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(head.dir, { recursive: true, force: true }); }
});

test('generate(): shell git-bash on win32 mounts exactly one pinned provider, ahead of the runtime', async () => {
  const head = await headGenerator();
  const dir = tempRoot();
  const pinned = path.join(dir, 'bash.exe');
  fs.writeFileSync(pinned, '');
  try {
    await withPlatform('win32', async () => {
      const root = dir + '/pinned';
      const before = head.generate(root, SPEC);
      const beforeBytes = bytesOf(root);
      const profile = withBashPath(pinned, () => generate(root, { ...SPEC, shell: 'git-bash' }));
      assert.notEqual(bytesOf(root), beforeBytes, 'the pinned row is a real addition');
      const shellRows = profile.entries.filter(entry => /bash|pwsh|shell/i.test(entry.name));
      assert.deepEqual(shellRows.map(entry => entry.id), [BASH_PIN_ID], 'exactly one shell provider');
      assert.deepEqual(shellRows[0], bashPinEntry('win32'));
      assert.deepEqual(profile.entries.filter(entry => entry.id !== BASH_PIN_ID), before.entries,
        'the pinned row is the only entry added');
      const at = profile.entries.findIndex(entry => entry.id === BASH_PIN_ID);
      assert.equal(profile.entries[at + 1].id, 'team-runtime');
      assert.equal(profile.whitelist.includes(BASH_PIN_MODULE), true, 'the boot audit admits the executor module');
      assert.equal(profile.capabilityHash, before.capabilityHash, 'the shell is a deployment position, not a capability');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(head.dir, { recursive: true, force: true }); }
});

test('generate(): shell git-bash off win32 adds no entry at all - the profile is what the baseline generates', async () => {
  const head = await headGenerator();
  const dir = tempRoot();
  try {
    await withPlatform('linux', async () => {
      const root = dir + '/linux';
      const before = head.generate(root, SPEC);
      const beforeBytes = bytesOf(root);
      // No DSH_BASH_PATH and no Git Bash here: the row is never written, so the program is never consulted.
      const now = withBashPath(path.join(dir, 'missing-bash.exe'), () => generate(root, { ...SPEC, shell: 'git-bash' }));
      assert.equal(bytesOf(root), beforeBytes, 'byte for byte what the baseline (190751e) generates');
      assert.deepEqual(now.entries, before.entries, 'no entry is added');
      assert.deepEqual(now.whitelist, before.whitelist);
      assert.equal(now.entries.some(entry => entry.id === BASH_PIN_ID), false);
      assert.equal(now.capabilityHash, before.capabilityHash);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(head.dir, { recursive: true, force: true }); }
});

test('generate(): an unknown shell is INVALID_CONFIG, and a missing pinned bash on win32 writes nothing', async () => {
  const dir = tempRoot();
  try {
    assert.throws(() => generate(dir + '/unknown', { shell: 'pwsh' }), /INVALID_CONFIG/);
    assert.equal(fs.existsSync(dir + '/unknown'), false);
    await withPlatform('win32', async () => {
      assert.throws(() => withBashPath(path.join(dir, 'missing-bash.exe'), () => generate(dir + '/missing', { shell: 'git-bash' })),
        error => error.code === 'BASH_PIN_MISSING');
      assert.equal(fs.existsSync(dir + '/missing'), false, 'fail closed before the profile is written');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
