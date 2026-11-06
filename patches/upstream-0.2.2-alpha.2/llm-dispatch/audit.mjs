import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Verbatim anchor audit of one build; M1b design §1.4.2 and §6 A pack.
 *
 * Three outcomes per file:
 *   applied   the file is exactly the postimage: every inserted anchor text is present exactly once.
 *   pristine  the file is exactly the preimage: every recorded anchor block is present, character for character, with
 *             its recorded multiplicity. This is the "the build is the version this patch was written for" proof.
 *   patch-missing  anything else - a different hash, a moved anchor, a missing postimage. The audit reports
 *             patch-missing; it never degrades into "diagnostic only" (design §2.5).
 *
 * It also proves the WeakMap prerequisite statically: the module specifier "@deepseek-ai/dsh-llm" resolved from the
 * provider package must be the same file the runtime is loaded from, or the two tables would not be shared.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const buildArg = process.argv[2] ?? process.env.DSH_UPSTREAM_BUILD;
if (!buildArg) {
  console.error('audit: usage: node audit.mjs <build root>  (or set DSH_UPSTREAM_BUILD)');
  process.exit(2);
}
const build = path.resolve(buildArg);
const modules = path.join(build, 'node_modules', '@deepseek-ai');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'anchors.json'), 'utf8'));

const report = { candidate: 'llm-dispatch', contract: meta.contract, build, files: [], missing: [] };

for (const [file, hashes] of Object.entries(meta.files)) {
  const target = path.join(modules, file);
  const anchors = meta.anchors.filter(anchor => anchor.file === file);
  if (!fs.existsSync(target)) {
    report.missing.push({ file, reason: 'missing-file' });
    report.files.push({ file, state: 'patch-missing' });
    continue;
  }
  const text = fs.readFileSync(target, 'utf8');
  const hash = sha256(target);
  let state;
  if (hash === hashes.postimage) state = 'applied';
  else if (hash === hashes.preimage) state = 'pristine';
  else state = 'unknown';
  const checks = [];
  for (const anchor of anchors) {
    // A patched file is checked by its postimage literal; a pristine or unknown file by the recorded preimage anchor.
    const probe = state === 'applied' ? anchor.postText : anchor.text;
    const count = text.split(probe).length - 1;
    const expected = state === 'applied' ? 1 : anchor.count;
    const ok = count === expected;
    checks.push({ name: anchor.name, line: anchor.line, expected, found: count, ok });
    if (!ok) {
      state = 'patch-missing';
      report.missing.push({ file, anchor: anchor.name, line: anchor.line, expected, found: count });
    }
  }
  if (state === 'unknown') {
    state = 'patch-missing';
    report.missing.push({ file, reason: 'unknown-preimage', hash });
  }
  report.files.push({ file, state, hash, checks });
}

// The WeakMap only works when both packages resolve one dsh-llm instance.
let moduleIdentity = 'unknown';
try {
  const deepseekLib = path.join(modules, 'dsh-llm-deepseek/lib/index.js');
  const runtimeLib = path.join(modules, 'dsh-llm/lib/index.js');
  const resolved = createRequire(deepseekLib).resolve('@deepseek-ai/dsh-llm');
  moduleIdentity = fs.realpathSync(resolved) === fs.realpathSync(runtimeLib) ? 'same-instance' : 'different-instance:' + resolved;
  if (!moduleIdentity.startsWith('same-instance')) report.missing.push({ file: 'dsh-llm-deepseek', reason: 'duplicate-module', resolved });
} catch (error) {
  moduleIdentity = 'unresolved:' + (error.code ?? error.message);
  report.missing.push({ file: 'dsh-llm-deepseek', reason: 'module-unresolved' });
}
report.moduleIdentity = moduleIdentity;
// "patch-present" means the patch is in this build and every inserted anchor is there exactly once. A pristine
// build whose anchors all match is still patch-missing for a probe that needs the patch: the anchors are recorded
// as verbs-ok so the reason is unambiguous.
const applied = report.files.every(entry => entry.state === 'applied');
const verbsOk = report.files.every(entry => entry.state !== 'patch-missing');
if (!applied && report.missing.length === 0) report.missing.push({ reason: 'not-applied', detail: 'the build matches the preimage; the patch is not in it' });
report.anchorStatus = verbsOk ? 'verbs-ok' : 'anchor-drift';
report.status = applied && report.missing.length === 0 ? 'patch-present' : 'patch-missing';

console.log(JSON.stringify(report, null, 2));
if (report.status !== 'patch-present') process.exitCode = 1;
