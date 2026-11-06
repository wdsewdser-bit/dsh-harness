import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildConfig, buildTarget, defaultBuild } from '../packages/adapter-dsh/build-target.mjs';
import { installGitBash } from './unit/git-bash-build-patch.mjs';

/**
 * Prepare the one build the suites run against: a copy of the C1 build with llm-dispatch and instant-preempt applied.
 *
 * The visibility chain has no producer without that patch - dsh-llm emits no llm/dispatch waterfall, so no manifest is
 * ever written and a responsibility can never become visible. The base build is read-only here: every step writes to the
 * copy (apply.mjs itself refuses a path outside it), and the pristine install is never touched.
 *
 * Idempotent: an already fully patched copy is reused; --force rebuilds.
 * The path is printed on the last line and remembered in runs/m1b-build-current.txt, which build-target.mjs reads when
 * DSH_UPSTREAM_BUILD is not set. Nothing here may fail silently: a missing patch is PATCH_MISSING.
 */
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = process.env.DSH_PREPARE_BASE ?? defaultBuild();
// The active patch set is configuration (build/builds.json), never a release name repeated in this script.
const patchSet = buildConfig().patches;
if (typeof patchSet !== 'string' || !patchSet) {
  throw Object.assign(Error('PATCH_MISSING: build/builds.json names no patches directory'), { code: 'PATCH_MISSING' });
}
const patches = repo + '/patches/' + patchSet;
const { applyToCopy } = await import(pathToFileURL(patches + '/instant-preempt/apply.mjs').href);
const { installPlugin } = await import(pathToFileURL(patches + '/instant-preempt/install-plugin.mjs').href);
const { installExecutionPermit } = await import(pathToFileURL(patches + '/execution-permit/apply.mjs').href);
const { installRoleToolBoundary } = await import(pathToFileURL(patches + '/role-tool-boundary/apply.mjs').href);
const pointer = repo + '/runs/m1b-build-current.txt';
const llm = dir => dir + '/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
// Verify every literal postimage, not an audit script's exit code (the legacy audits are not target-aware).
function verifyInherited(dir) {
  for (const name of ['goal-veto', 'team-layout']) {
    const plan = JSON.parse(fs.readFileSync(patches + '/' + name + '/plan.json', 'utf8'));
    for (const { file, to } of plan) {
      const target = dir + '/node_modules/@deepseek-ai/' + file;
      if (!fs.existsSync(target) || !fs.readFileSync(target, 'utf8').includes(to))
        fail('PATCH_MISSING', name + ' postimage missing: ' + file);
    }
  }
}
const prepared = dir => {
  try { buildTarget(dir); verifyInherited(dir); return true; } catch { return false; }
};
const fail = (code, message) => { throw Object.assign(Error(code + ': ' + message), { code }); };

export function currentBuild() {
  const selected = process.env.DSH_UPSTREAM_BUILD ?? (fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : '');
  return selected || null;
}

function step(script, target, { allowFailure = false } = {}) {
  const run = spawnSync(process.execPath, [patches + '/llm-dispatch/' + script, target], { encoding: 'utf8' });
  const output = ((run.stdout ?? '') + (run.stderr ?? '')).trim();
  if (run.status !== 0 && !allowFailure) fail('PATCH_FAILED', script + ' failed on ' + target + ': ' + output.slice(-800));
  return { status: run.status, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes('--force');
  const known = currentBuild();
  if (!force && known && prepared(known)) { installExecutionPermit(known); installRoleToolBoundary(known); installGitBash(known); console.log(known); process
    .exit(0); }
  if (!fs.existsSync(base)) fail('PATCH_MISSING', 'base build does not exist: ' + base);
  const target = repo + '/runs/m1b-build-' + Date.now();
  fs.cpSync(base, target, { recursive: true });
  // audit first: on an unpatched copy this reports patch-missing / not-applied, which is the expected starting point.
  const audit = step('audit.mjs', target, { allowFailure: true });
  const applied = step('apply.mjs', target);
  const verified = step('verify-patches.mjs', target);
  if (!fs.existsSync(llm(target)) || !fs.readFileSync(llm(target), 'utf8').includes('DISPATCH_CONTRACT')) fail('PATCH_MISSING',
    'after apply the copy still does not export DISPATCH_CONTRACT');
  // C1 supplies goal-veto and team-layout; instant-preempt is applied to this copy, not assumed to ship with C1.
  verifyInherited(target);
  try { applyToCopy(target); installPlugin(target); }
  catch (error) { fail('PATCH_FAILED', 'instant-preempt: ' + error.message); }
  installExecutionPermit(target);
  installRoleToolBoundary(target);
  installGitBash(target);
  buildTarget(target); // the same fail-closed capability decision used by every composition root
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  fs.writeFileSync(pointer, target + '\n');
  console.log(JSON.stringify({ target, audit: audit.status, applied: applied.status, verified: verified.status }));
  console.log(target);
}
