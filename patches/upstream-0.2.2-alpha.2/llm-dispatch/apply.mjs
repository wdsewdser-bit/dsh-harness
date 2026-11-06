import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Apply the llm-dispatch candidate to one copied build; M1b design §1.4.2, §6 A pack.
 *
 * The patch is only ever applied to a copy: <path-to-dsh-v2>/runs/m1b-build-<timestamp>/. Before a byte is
 * written, the target file is realpath'ed and its package directory is lstat'ed; anything that resolves outside the
 * copy - a junction into the production install, a stale symlink - aborts instead of writing through it.
 *
 * Every edit replaces a literal that plan.json records verbatim, with an exact expected multiplicity, and the preimage
 * and postimage hashes come from anchors.json. A build that does not match the preimage, or whose anchors moved, is
 * PATCH_MISSING: the build audit must never degrade into a diagnostic.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (code, detail) => {
  const error = new Error(detail ? code + ': ' + detail : code);
  error.code = code;
  throw error;
};

const buildArg = process.argv[2] ?? process.env.DSH_UPSTREAM_BUILD;
if (!buildArg) fail('BUILD_REQUIRED', 'usage: node apply.mjs <build root>  (or set DSH_UPSTREAM_BUILD)');
const build = path.resolve(buildArg);
const modules = path.join(build, 'node_modules', '@deepseek-ai');
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'plan.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'anchors.json'), 'utf8'));

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** The containment proof the task requires before any write: realpath the file, lstat the package directory. */
function assertInsideCopy(target) {
  const buildReal = fs.realpathSync(build);
  const fileReal = fs.realpathSync(target);
  const packageDir = path.dirname(path.dirname(fileReal));
  const packageStat = fs.lstatSync(packageDir);
  if (packageStat.isSymbolicLink()) fail('ABORT_LINKED_PACKAGE', packageDir + ' is a link; refusing to write through it');
  if (!inside(buildReal, fileReal)) fail('ABORT_OUTSIDE_COPY', target + ' resolves to ' + fileReal + ', outside ' + buildReal);
  if (!inside(buildReal, packageDir)) fail('ABORT_OUTSIDE_COPY', packageDir + ' resolves outside ' + buildReal);
  return { fileReal, packageDir };
}

const results = [];
for (const file of [...new Set(plan.map(edit => edit.file))]) {
  const target = path.join(modules, file);
  if (!fs.existsSync(target)) fail('PATCH_MISSING', target + ' does not exist');
  const { fileReal } = assertInsideCopy(target);
  const before = sha256(fileReal);
  if (before === meta.files[file].postimage) {
    results.push({ file, status: 'already-applied', before, after: before });
    continue;
  }
  if (before !== meta.files[file].preimage) {
    fail('PATCH_MISSING', file + ' has hash ' + before + ', which is neither the preimage nor the postimage of this patch');
  }
  let text = fs.readFileSync(fileReal, 'utf8');
  for (const edit of plan.filter(item => item.file === file)) {
    const count = text.split(edit.from).length - 1;
    if (count !== 1) {
      fail('PATCH_MISSING', edit.name + ' matched ' + count + ' times in ' + file + ' (expected exactly 1); the build drifted');
    }
    text = text.split(edit.from).join(edit.to);
  }
  fs.writeFileSync(fileReal, text);
  const after = sha256(fileReal);
  if (after !== meta.files[file].postimage) fail('POSTIMAGE_MISMATCH', file + ' became ' + after);
  results.push({ file, status: 'applied', before, after });
}

const report = { candidate: 'llm-dispatch', contract: meta.contract, build, at: new Date().toISOString(), files: results };
const reportPath = path.join(ROOT, 'hashes-and-scope.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
