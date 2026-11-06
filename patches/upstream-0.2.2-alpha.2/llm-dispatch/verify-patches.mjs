import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * candidate.patch roundtrip; same shape as patches/upstream-0.2.2-alpha.2/verify-patches.mjs.
 *
 * The originals are laid out under roundtrip/<timestamp>/, git apply --check must accept the patch there, the applied
 * files must be byte-identical to the patched build copy, and the whole thing is recorded in patch-roundtrip.json.
 * A patch that only "applies cleanly" is not enough: the postimage has to be the bytes the probe ran.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, '../../..');
const buildArg = process.argv[2] ?? process.env.DSH_UPSTREAM_BUILD;
if (!buildArg) {
  console.error('verify-patches: usage: node verify-patches.mjs <patched build root>  (or set DSH_UPSTREAM_BUILD)');
  process.exit(2);
}
const build = path.resolve(buildArg);
const modules = path.join(build, 'node_modules', '@deepseek-ai');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'anchors.json'), 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const dest = path.join(ROOT, 'roundtrip', String(Date.now()));
const relative = path.relative(REPO, dest).replaceAll('\\', '/');
for (const file of Object.keys(meta.files)) {
  fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'original', file), path.join(dest, file));
}
for (const check of [true, false]) {
  const args = ['-c', 'core.autocrlf=false', 'apply', ...(check ? ['--check'] : []), '--directory=' + relative, path.join(ROOT, 'candidate.patch')];
  const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('PATCH_' + (check ? 'CHECK' : 'APPLY') + ':' + result.stderr);
}
const report = [];
for (const file of Object.keys(meta.files)) {
  const applied = hash(path.join(dest, file));
  const expected = hash(path.join(modules, file));
  if (applied !== expected || applied !== meta.files[file].postimage) throw new Error('ROUNDTRIP_HASH_MISMATCH:' + file);
  report.push({ file, ok: true, sha256: applied });
}
fs.rmSync(dest, { recursive: true, force: true });
fs.writeFileSync(path.join(ROOT, 'patch-roundtrip.json'), JSON.stringify({ candidate: 'llm-dispatch', build, roundtrip: report }, null, 2) + '\n');
console.log('PASS llm-dispatch candidate.patch --check + apply: byte-identical postimage');
