import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * WP-D: the build-installation half of "Windows runs Git Bash, not pwsh and not a sandbox".
 *
 * The shell provider and the tool rows live in dsh-base's and dsh-web-app's bundle patches, which exist only inside a
 * prepared build (the repository carries no copy of either). Editing the install by hand would be lost by the next
 * prepare, so the change is a patch like every other one.
 *
 * The patch is a WHOLE-FILE decision, not a parsed one. Each of the two files is read, CRLF is normalised to LF, and the
 * whole text is hashed. Only two hashes are accepted per file: UPSTREAM (the text as shipped) and PATCHED (the text this
 * patch produces). UPSTREAM is turned into PATCHED by fixed string replacements, each of which must match exactly once;
 * the result must hash to PATCHED. A file that already hashes to PATCHED is left alone. Anything else is PATCH_MISSING.
 *
 * That is deliberate: a record parser can be fooled by shapes it did not anticipate (a low-indent comment between
 * fields, an id with a trailing comment) because the meaning of the text decides where a record ends. A whole-file
 * fingerprint has no such notion - text that is not exactly the upstream or exactly the result is simply not ours.
 *
 * Both files are computed and validated in memory first; only then are they written, and only if they changed.
 *
 * "Under runs/" is a logical path, and a build can contain junctions: node_modules in a staging build may point at the
 * upstream install or at the user's own DSH_HOME, and a write follows the link. So the physical paths are checked too,
 * before anything is touched: runs/, the build and both files are resolved with realpathSync, each file must resolve
 * inside the build, the build must resolve inside runs/, and neither file may be a link itself. Writes are atomic
 * (same-directory temporary file, then rename), so a failure cannot leave a half-written patch behind.
 *
 * What it does:
 *   base   - insert the pinned executor row (bash-pin) beside bash-sandbox, enabled on win32 only and pointing at this
 *            repository's packages/profiles/shell-bash-pin.mjs;
 *   base   - disable pwsh-sandbox. bash-pin and pwsh-sandbox both provide the one 'shell' service, and Service admits
 *            exactly one provider: an enabled pwsh row beside bash-pin is two providers, and leaving it enabled as a
 *            fallback is the failure this package exists to prevent;
 *   preset - standard: drop the tool-pwsh row and stop disabling tool-bash on win32.
 *
 * The two PATCHED hashes carry this checkout's absolute module URL (the bash-pin row names the executor file), so a copy
 * of the repository at another path re-pins them; that failure is loud and closed, never silent.
 *
 * The other preset files (ptc/cordis/minimal) are outside this package's scope: the default preset is standard, and
 * they name other tools (persistent terminals) whose Windows wiring is a separate decision.
 */
const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const failWith = (code, message) => { throw Object.assign(Error(code + ': ' + message), { code }); };
const fail = message => failWith('PATCH_MISSING', message);

/** The executor module URL: the same file a generated profile mounts, resolved from this repository. */
export const BASH_PIN_URL = new URL('../../packages/profiles/shell-bash-pin.mjs', import.meta.url).href;

const sha256 = text => createHash('sha256').update(text).digest('hex');
/** Fingerprints are over LF text: a CRLF checkout is the same file, not a different one. */
const newlines = text => text.replace(/\r\n/g, '\n');
const lines = (...rows) => rows.join('\n');

const BASE_SANDBOX = lines(
  '    - id: bash-sandbox',
  "      name: '@deepseek-ai/dsh-bash-sandbox'",
  "      disabled: !!js process.platform === 'win32'",
  '      config:',
  '        timeoutMs: 60000',
  '',
);
const BASH_PIN_BLOCK = lines(
  '    - id: bash-pin',
  "      name: '" + BASH_PIN_URL + "'",
  "      disabled: !!js process.platform !== 'win32'",
  '      config: {}',
  '',
);
const PWSH_SANDBOX = lines(
  '    - id: pwsh-sandbox',
  "      name: '@deepseek-ai/dsh-pwsh-sandbox'",
  '',
);
const TOOL_PWSH = lines(
  '          - id: tool-pwsh',
  "            name: '@deepseek-ai/dsh-tool-pwsh'",
  '',
);
const TOOL_BASH = lines(
  '          - id: tool-bash',
  "            name: '@deepseek-ai/dsh-tool-bash'",
  '',
);

/**
 * The four whole-file fingerprints, one unmodified and one patched per file. Nothing else is accepted.
 * (Computed from the 0.2.2-rc.1 upstream text and from this patch's own output for this checkout; a baseline bump
 * re-pins all four, which is why the failure below is loud rather than a fallback.)
 */
export const WHITELIST = Object.freeze([
  Object.freeze({ file: 'base', state: 'upstream', sha256: 'b65a86e55f02d863286bb6faac8ae292c18fffca3c8aa4491b600fa4dd6b48d0' }),
  Object.freeze({ file: 'base', state: 'patched', sha256: '06871856513d58ffe3c67abd7bfbd05c65221e4de23540a1d867e4ba5b3e43eb' }),
  Object.freeze({ file: 'preset', state: 'upstream', sha256: '3006cc3780cddaa7fb0089e5854e6bbef4409cf1d425930fd835226b95660afd' }),
  Object.freeze({ file: 'preset', state: 'patched', sha256: '8d9a65d66b310292410bc46540b797979ddc45d05ed70ec4eee10978be9f03ad' }),
]);

const fingerprint = (file, state) => WHITELIST.find(entry => entry.file === file && entry.state === state).sha256;

/** The fixed edits. Every anchor must occur exactly once; the result is checked against the PATCHED fingerprint. */
const FILES = Object.freeze({
  base: Object.freeze({
    path: 'dsh-base/cordis.patch.yml',
    replacements: Object.freeze([
      Object.freeze({ before: BASE_SANDBOX, after: BASE_SANDBOX + '\n\n' + BASH_PIN_BLOCK,
        describe: 'bash-sandbox row' }),
      Object.freeze({ before: PWSH_SANDBOX + '      disabled: !!js process.platform !== \'win32\'\n',
        after: PWSH_SANDBOX + '      disabled: true\n', describe: 'pwsh-sandbox row' }),
    ]),
  }),
  preset: Object.freeze({
    path: 'dsh-web-app/presets/standard.patch.yml',
    replacements: Object.freeze([
      Object.freeze({ before: TOOL_PWSH + '            disabled: !!js process.platform !== \'win32\'\n', after: '',
        describe: 'tool-pwsh row' }),
      Object.freeze({ before: TOOL_BASH + '            disabled: !!js process.platform === \'win32\'\n',
        after: TOOL_BASH, describe: 'tool-bash row' }),
    ]),
  }),
});

/**
 * One file: PATCHED is returned untouched, UPSTREAM is patched, anything else is refused. Nothing is written here.
 */
function patchOne(file, text) {
  const upstream = fingerprint(file, 'upstream');
  const patched = fingerprint(file, 'patched');
  const normalized = newlines(text);
  const found = sha256(normalized);
  if (found === patched) return { text: normalized, changed: false };
  if (found !== upstream) {
    fail(file + ': the file is neither the pinned upstream (' + upstream.slice(0, 12) + ') nor the pinned patch result (' +
      patched.slice(0, 12) + '); found ' + found.slice(0, 12));
  }
  let next = normalized;
  for (const replacement of FILES[file].replacements) {
    if (next.split(replacement.before).length !== 2) {
      fail(file + ': the ' + replacement.describe + ' occurs ' + (next.split(replacement.before).length - 1) + ' times, expected exactly 1');
    }
    next = next.replace(replacement.before, () => replacement.after);
  }
  if (sha256(next) !== patched) fail(file + ': the fixed replacements do not produce the pinned patch result');
  return { text: next, changed: true };
}

/**
 * Patch both bundle patches in memory and validate the result. Nothing is written here: a failure leaves the caller's
 * files exactly as they were. Applying an already patched pair is a no-op that returns the same text.
 */
export function patchGitBashFiles({ base, preset }) {
  if (typeof base !== 'string' || typeof preset !== 'string') fail('both bundle patches must be given as text');
  const patchedBase = patchOne('base', base);
  const patchedPreset = patchOne('preset', preset);
  return { base: patchedBase.text, preset: patchedPreset.text,
    changed: { base: patchedBase.changed, preset: patchedPreset.changed } };
}

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

const realpathOf = (label, target) => {
  try { return fs.realpathSync(target); } catch (error) {
    return failWith('PATCH_OUTSIDE_RUNS', label + ' cannot be resolved: ' + error.message);
  }
};

/**
 * The physical check, before the first write. A prepared build is a copy under runs/, and every file this patch touches
 * must be that copy - not something a junction points at. A target file that is itself a link is refused even when it
 * points back inside runs/: a link is not part of the copy.
 */
function assertPhysicallyInsideRuns(target, paths) {
  const realRuns = realpathOf('the runs directory', path.join(repo, 'runs'));
  const realTarget = realpathOf('the build directory', target);
  if (realTarget === realRuns || !inside(realRuns, realTarget)) {
    failWith('PATCH_OUTSIDE_RUNS', 'the build is not physically inside runs/: ' + target + ' -> ' + realTarget);
  }
  for (const [file, filePath] of Object.entries(paths)) {
    let stat;
    try { stat = fs.lstatSync(filePath); } catch { fail('build file is missing: ' + filePath); }
    if (stat.isSymbolicLink()) failWith('PATCH_OUTSIDE_RUNS', file + ' is a link, not a file: ' + filePath);
    const realFile = realpathOf(file + ' (' + filePath + ')', filePath);
    if (!inside(realTarget, realFile)) {
      failWith('PATCH_OUTSIDE_RUNS', file + ' resolves outside the build: ' + filePath + ' -> ' + realFile);
    }
  }
}

let tempCounter = 0;

/** Replace one file in a single step: a reader sees the old text or the new one, never a truncated file. */
function writeAtomically(filePath, text) {
  const temp = filePath + '.wp-d-' + process.pid + '-' + (tempCounter += 1) + '.tmp';
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, filePath);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the original is untouched either way */ }
    throw error;
  }
}

/**
 * Apply the WP-D rows to one prepared build. Refuses any target whose logical or physical path leaves runs/: the
 * pristine install and the user's own DSH_HOME are never edited here. Both files are computed and validated - and their
 * physical location checked - before the first write; a file that did not change is not written at all.
 */
export function installGitBash(build) {
  const target = path.resolve(build);
  if (!target.startsWith(path.join(repo, 'runs') + path.sep)) fail('PATCH_TARGET_UNSAFE: ' + target);
  const paths = { base: path.join(target, 'node_modules/@deepseek-ai/' + FILES.base.path),
    preset: path.join(target, 'node_modules/@deepseek-ai/' + FILES.preset.path) };
  assertPhysicallyInsideRuns(target, paths);
  const next = patchGitBashFiles({ base: fs.readFileSync(paths.base, 'utf8'), preset: fs.readFileSync(paths.preset, 'utf8') });
  if (next.changed.base) writeAtomically(paths.base, next.base);
  if (next.changed.preset) writeAtomically(paths.preset, next.preset);
  // Read back: the patch is not "done" because the writes returned. A mismatch here is a disk failure, not a decision.
  for (const [file, filePath] of [['base', paths.base], ['preset', paths.preset]]) {
    const stored = sha256(newlines(fs.readFileSync(filePath, 'utf8')));
    if (stored !== fingerprint(file, 'patched')) fail(file + ': after the write the file is not the pinned patch result');
  }
  return { base: paths.base, preset: paths.preset, bashPinUrl: BASH_PIN_URL };
}
