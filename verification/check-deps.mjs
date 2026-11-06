import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dependency check for packages/**.mjs (M0, extended by M4 §2.2 of docs/refactor-20261026/19-M3a-M4-plan.md).
 *
 * Four rules, reported with file:line, rule id and the import path:
 *   (a) no file under packages/ may import anything under verification/;
 *   (b) an import into another package must go through that package's public entry
 *       (packages/<pkg>/index.mjs, or a target declared in its package.json "exports"). Reaching into
 *       ../other-pkg/src/x.mjs is a violation;
 *   (c) a source file must not hard-code a drive-letter absolute path (a build path that only works on one machine).
 *       Test fixtures are exempt: they legitimately name throw-away scratch directories;
 *   (d) a source file must not import a test module (/test/, /test-support/, *.test.mjs), even its own package's. A test
 *       may still import source, and a test may import a test;
 *   (e) no package's "exports" may expose a test module, judged by the target template: a plain target that is a test
 *       module, a pattern "./P*S" whose reachable files include one, or a pattern whose prefix P already sits inside
 *       /test/ or /test-support/. This is the source-level closure of rule (d)'s bare path;
 *   (f) "exports" must be one "./" string or a plain map of "."/"./..." keys to "./"-relative string targets without
 *       "..". Condition objects, arrays, null and other values are unsupported, and a "*" must be on both sides of a
 *       pair or on neither, at most once each. Not modelling Node's condition resolution keeps rule (b)/(e) decidable.
 *
 * Two structural checks, computed over SOURCE files only (§2.2 rule 1: "按 /test/、/test-support/、*.test.mjs 区分
 * 源码与测试：矩阵与循环只看源码，测试只禁深导"):
 *   matrix - the per-package dependency direction of §2.2. A source file may only import the packages its row names;
 *   cycles - packages must not form an import cycle at package granularity.
 *
 * Exemptions live in verification/dependency-policy.json. Every entry must carry a non-empty "reason"; an entry
 * without one fails the run. An exemption silences the MATRIX check only: the cycle graph always uses the complete
 * source graph, so an exemption can never hide a cycle.
 *
 * Intra-package relative imports are fine. Bare specifiers for npm packages are ignored; a bare specifier
 * that names a workspace package is treated as a cross-package edge.
 *
 * Reporting only by default (exit 0). With --strict, any violation or cycle exits 1.
 */

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagesRoot = path.join(repoRoot, 'packages');
const policyPath = path.join(repoRoot, 'verification', 'dependency-policy.json');
const strict = process.argv.includes('--strict');

/**
 * §2.2 dependency direction: each package may only import the packages listed for it.
 *   contracts -   core - contracts   store - contracts   context - contracts
 *   delivery - contracts, core (ports only)   adapter-dsh - contracts
 *   host - contracts, core, store, context, delivery, adapter-dsh
 *   projections - contracts, core (read only), store (read only)
 *   ui - (HTTP only)   profiles - all
 * packages/ptc-boost is the upstream plugin overlay (plain .js, outside the module matrix) and is not listed.
 */
const MATRIX = Object.freeze({
  contracts: Object.freeze([]),
  core: Object.freeze(['contracts']),
  store: Object.freeze(['contracts']),
  context: Object.freeze(['contracts']),
  delivery: Object.freeze(['contracts', 'core']),
  'adapter-dsh': Object.freeze(['contracts']),
  host: Object.freeze(['contracts', 'core', 'store', 'context', 'delivery', 'adapter-dsh']),
  projections: Object.freeze(['contracts', 'core', 'store']),
  ui: Object.freeze([]),
  profiles: Object.freeze(['contracts', 'core', 'store', 'context', 'delivery', 'adapter-dsh', 'host', 'projections', 'ui']),
});

/** Packages that are not part of the module matrix (upstream overlays, not this repository's modules). */
const OUTSIDE_MATRIX = Object.freeze(new Set(['ptc-boost']));

import { createWalkers, toPosix } from './runner/deps-walk.mjs';
import { pathProblem, foldCase, exportsShapeProblems, matchExport } from './runner/deps-exports.mjs';
import { cycles } from './runner/deps-cycles.mjs';
import { createHardCodedPathCheck } from './runner/deps-paths.mjs';

const { walk, packageOf, isTestFile, specifiersOf, resolveRelative, publicEntries, key } = createWalkers(packagesRoot);

// --- policy -------------------------------------------------------------------------------------------------------

const policyProblems = [];
function loadPolicy() {
  const empty = { exemptions: [] };
  if (!fs.existsSync(policyPath)) return empty;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(policyPath, 'utf8')); }
  catch (error) { policyProblems.push('verification/dependency-policy.json is not valid JSON: ' + error.message); return empty; }
  const value = raw.exemptions ?? [];
  if (!Array.isArray(value)) { policyProblems.push('dependency-policy.json: "exemptions" must be an array'); return empty; }
  for (const entry of value) {
    if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      policyProblems.push('dependency-policy.json: every exemption needs "from" and "to" package names');
    } else if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      policyProblems.push('dependency-policy.json: exemption ' + entry.from + ' -> ' + entry.to + ' has no "reason"; an exemption without one fails the check');
    }
  }
  return { exemptions: value };
}
const policy = loadPolicy();
// Only a well-formed exemption (both packages named, a non-empty reason) takes effect. An entry without its reason is
// reported as a policy problem and stays inert, so a malformed exemption cannot quietly widen the matrix.
const exemptionByEdge = new Map(policy.exemptions
  .filter(entry => entry && typeof entry.from === 'string' && typeof entry.to === 'string' &&
    typeof entry.reason === 'string' && entry.reason.trim() !== '')
  .map(entry => [entry.from + ' -> ' + entry.to, entry]));

// --- scan ---------------------------------------------------------------------------------------------------------

const files = fs.existsSync(packagesRoot) ? walk(packagesRoot) : [];
const packageDirs = new Map();
for (const name of fs.readdirSync(packagesRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
  packageDirs.set(name, path.join(packagesRoot, name));
}
const publicByPackage = new Map([...packageDirs].map(([name, dir]) => [name, publicEntries(dir)]));
const packageByNpmName = new Map();
for (const [name, dir] of packageDirs) {
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name) packageByNpmName.set(manifest.name, name);
}

const violations = [];
/** Source edges only (tests excluded). Policy exemptions are applied by the matrix check alone, never by the cycle graph. */
const edges = new Map();

function addViolation(file, line, rule, specifier, detail) {
  violations.push({
    file: toPosix(path.relative(repoRoot, file)),
    line,
    rule,
    specifier,
    detail,
  });
}

/**
 * Every file under a package, plus every symlink/junction entry the walk meets. A link is never followed: rule (f)
 * refuses it, so "the file that ships" and "the file the exports name" cannot drift apart.
 */
function walkAll(dir, links) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) { links.push(full); continue; }
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') files.push(...walkAll(full, links)); }
    else if (entry.isFile()) files.push(full);
  }
  return files;
}


function checkExportsShape() {
  for (const [, dir] of [...packageDirs].sort()) {
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const problem of exportsShapeProblems(manifest, dir)) {
      addViolation(manifestPath, 1, 'f', problem.key, 'unsupported "exports" shape: ' + problem.detail);
    }
  }
}


/**
 * rule (e): a package's "exports" must not expose a test module, judged by the TARGET template rather than by the key
 * (the key is a virtual name and need not correspond to any directory):
 *   - a plain target is a test module exactly when its path is one;
 *   - a pattern "./P*S" is reachable wherever an existing file lies under P and above S, and any such file that is a
 *     test module is an exposure;
 *   - when one of the complete directory segments of P is "test" or "test-support", every file the pattern can ever
 *     name is test code, so it is reported even before such a file exists ("./test*" and "./src/a.test.mjs*" are not).
 * A walk that meets a symlink or junction reports it as rule (f).
 */
function checkExportExposure() {
  for (const [, dir] of [...packageDirs].sort()) {
    const manifestPath = path.join(dir, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const map = manifest.exports;
    if (map === undefined) continue;
    const entries = typeof map === 'string' ? [['.', map]]
      : map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map) : [];
    let scan = null;
    const linksReported = new Set();
    for (const [key, target] of entries) {
      if (pathProblem(target) !== null) continue; // the shape problem belongs to rule (f)
      const at = target.indexOf('*');
      if (at < 0) {
        if (isTestFile(path.join(dir, target))) {
          addViolation(manifestPath, 1, 'e', key, '"exports" exposes a test module: ' + JSON.stringify(key) + ' -> ' + target);
        }
        continue;
      }
      const fixed = target.slice(0, at), suffix = target.slice(at + 1);
      const dirPrefix = fixed.slice(0, fixed.lastIndexOf('/') + 1);
      const directories = dirPrefix.split('/').filter(segment => segment && segment !== '.');
      if (directories.some(segment => segment === 'test' || segment === 'test-support')) {
        addViolation(manifestPath, 1, 'e', key,
          '"exports" points at a test directory: ' + JSON.stringify(key) + ' -> ' + target);
        continue;
      }
      if (scan === null) {
        const links = [];
        scan = { files: walkAll(dir, links), links };
      }
      for (const link of scan.links) {
        if (linksReported.has(link)) continue;
        linksReported.add(link);
        addViolation(manifestPath, 1, 'f', '.',
          'unsupported "exports" shape: the package tree contains a symlink or junction: ' + toPosix(path.relative(dir, link)));
      }
      const reachable = scan.files
        .map(file => './' + toPosix(path.relative(dir, file)))
        .filter(rel => { const r = foldCase(rel); return r.startsWith(foldCase(fixed)) && r.endsWith(foldCase(suffix)) && rel.length >= fixed.length +
          suffix.length;
            })
        .find(rel => isTestFile(path.join(dir, foldCase(rel))));
      if (reachable) {
        addViolation(manifestPath, 1, 'e', key, '"exports" pattern reaches a test module: ' + JSON.stringify(key) +
          ' -> ' + target + ' (reaches ' + reachable + ')');
      }
    }
  }
}

function check(file, specifier, line) {
  const sourcePackage = packageOf(file);
  if (!sourcePackage) return;
  const sourceIsTest = isTestFile(file);

  let targetPackage = null;
  let resolved = null;

  if (specifier.startsWith('.')) {
    resolved = resolveRelative(file, specifier);
    const relative = toPosix(path.relative(packagesRoot, resolved));
    if (toPosix(resolved).toLowerCase().includes('/verification/')) {
      addViolation(file, line, 'a', specifier, 'packages must not import from verification/ (' + toPosix(path.relative(repoRoot, resolved)) + ')');
      return;
    }
    if (relative.startsWith('..')) {
      addViolation(file, line, 'b', specifier, 'target is outside packages/ (' + toPosix(path.relative(repoRoot, resolved)) + ')');
      return;
    }
    targetPackage = relative.split('/')[0];
  } else {
    const segments = specifier.split('/');
    const npmName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
    targetPackage = packageByNpmName.get(npmName) ?? null;
    if (!targetPackage) return; // external dependency or node: builtin
    const packageDir = packageDirs.get(targetPackage);
    const subpath = segments.slice(npmName.split('/').length).join('/');
    // A bare root import ("@dsh-v2/x") is admitted here; what the root exposes is rule (e)'s business.
    if (!subpath) return addEdge(sourcePackage, targetPackage, sourceIsTest);
    const manifestPath = path.join(packageDir, 'package.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
    const match = matchExport(manifest, subpath);
    // Rule (b) only asks whether a key names this subpath; the shape of that key is rule (f)'s business, reported once.
    const target = match.matched && match.legal ? (match.star === null ? match.target : match.target.replace('*', match.star)) : null;
    // Review P2-2 (round 3): matching a key of "exports" - an exact key or any * pattern - IS a public export. The old
    // literal re-check against publicEntries() reported false rule (b) violations for every pattern entry. Only a key
    // that does not exist, or one that names nothing (null), is a violation.
    if (!match.matched) {
      addViolation(file, line, 'b', specifier, 'subpath "' + subpath + '" is not declared in ' + targetPackage + '/package.json exports');
      return;
    }
    if (!match.legal) return; // the matched entry violates rule (f), which already reports it
    resolved = path.join(packageDir, target);
    // Second line of defence (rule (e) judges the map up front, this gates one import): a bare target that is a test
    // module is refused outright, whichever branch produced it.
    if (!sourceIsTest && isTestFile(resolved)) {
      addViolation(file, line, 'd', specifier, 'a shipped source file must not import a test module (' +
        toPosix(path.relative(repoRoot, resolved)) + ')');
      return;
    }
    return addEdge(sourcePackage, targetPackage, sourceIsTest);
  }

  // Review P2-2: both forms are judged on the file they actually resolve to. A relative path or a bare subpath (alias
  // included) that lands in /test/, /test-support/ or *.test.mjs is the same defect; the intra-package return below is
  // exactly where the old code lost it, and with it every package edge the fixture makes.
  if (!sourceIsTest && isTestFile(resolved)) {
    addViolation(file, line, 'd', specifier, 'a shipped source file must not import a test module (' +
      toPosix(path.relative(repoRoot, resolved)) + ')');
    return;
  }

  if (targetPackage === sourcePackage) return; // intra-package: allowed
  addEdge(sourcePackage, targetPackage, sourceIsTest);
  if (!publicByPackage.has(targetPackage)) {
    addViolation(file, line, 'b', specifier, 'unknown package directory ' + targetPackage);
    return;
  }
  if (!publicByPackage.get(targetPackage).includes(key(resolved))) {
    addViolation(file, line, 'b', specifier, 'cross-package import must use ' + targetPackage + '/index.mjs or its package.json exports, got ' + toPosix(path
        .relative(repoRoot, resolved)));
  }
}

/**
 * Record one package edge. Tests add no edge at all (§2.2 rule 1: the matrix and the cycle graph see source only).
 * A policy exemption is applied by the matrix check alone (review P2-2a): the cycle graph keeps the complete source
 * graph, so an exemption can never hide a cycle.
 */
function addEdge(from, to, isTest) {
  if (!from || !to || from === to) return;
  if (isTest) return;
  if (!edges.has(from)) edges.set(from, new Set());
  edges.get(from).add(to);
}

/**
 * rule (c): a drive-letter absolute path literal in a SOURCE file. Test fixtures are the only whitelist (§2.2 rule 3):
 * a fixture legitimately names a throw-away scratch directory, a shipped module may not depend on one machine.
 */
const checkHardCodedPaths = createHardCodedPathCheck({ isTestFile, addViolation });

for (const file of files) {
  for (const { specifier, line } of specifiersOf(file)) check(file, specifier, line);
  checkHardCodedPaths(file);
}
// Rules (e) and (f) are about the manifest, not about any one import.
checkExportsShape();
checkExportExposure();

// --- matrix -------------------------------------------------------------------------------------------------------

const matrixViolations = [];
for (const [from, targets] of [...edges].sort()) {
  if (OUTSIDE_MATRIX.has(from)) continue;
  // The policy exemption is scoped to this check (review P2-2a); the cycle graph above/below still sees the edge.
  const checked = [...targets].filter(to => !exemptionByEdge.has(from + ' -> ' + to)).sort();
  if (checked.length === 0) continue;
  const allowed = MATRIX[from];
  if (!allowed) {
    matrixViolations.push('[matrix] ' + from + ' -> ' + checked.join(', ') +
      '  -- package ' + from + ' has no row in the §2.2 dependency matrix');
    continue;
  }
  const forbidden = checked.filter(to => !allowed.includes(to));
  if (forbidden.length > 0) {
    matrixViolations.push('[matrix] ' + from + ' -> ' + forbidden.join(', ') + '  -- allowed: ' +
      (allowed.length ? allowed.join(', ') : '(none)'));
  }
}

// --- cycles -------------------------------------------------------------------------------------------------------


const found = cycles(edges);
const byRule = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, matrix: 0 };
for (const violation of violations) byRule[violation.rule]++;
byRule.matrix = matrixViolations.length;

const testCount = files.filter(isTestFile).length;
console.log('scanned ' + files.length + ' .mjs files across ' + packageDirs.size + ' packages (' +
  (files.length - testCount) + ' source, ' + testCount + ' test)');
if (violations.length === 0 && matrixViolations.length === 0) {
  console.log('no rule (a)/(b)/(c)/(d)/(e)/(f) or matrix violations');
} else {
  for (const violation of [...violations].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line)) {
    console.log(violation.file + ':' + violation.line + '  [' + violation.rule + ']  ' + violation.specifier + '  -- ' + violation.detail);
  }
  for (const line of matrixViolations) console.log(line);
}
for (const entry of policy.exemptions) {
  const reason = typeof entry?.reason === 'string' && entry.reason.trim() !== '' ? entry.reason
    : '(missing reason: this exemption fails the check and is not applied)';
  console.log('[exempt] ' + (entry?.from ?? '?') + ' -> ' + (entry?.to ?? '?') + '  -- ' + reason);
}
if (policy.exemptions.length === 0) {
  console.log('[exempt] none declared in verification/dependency-policy.json');
}
for (const problem of policyProblems) console.log('POLICY: ' + problem);
if (found.length > 0) {
  for (const component of found) {
    console.log('[cycle] ' + component.join(' -> ') + ' -> ' + component[0]);
  }
}
// Review P2-2b: total counts every class the run reports - rules (a)-(d), the matrix, and policy problems - so a
// failure can never hide behind a separate counter. Cycles stay their own line (as before).
const total = violations.length + matrixViolations.length + policyProblems.length;
const failed = total + found.length;
console.log(
  'violations: total=' + total + ' rule(a)=' + byRule.a + ' rule(b)=' + byRule.b + ' cycles=' + found.length +
  ' rule(matrix)=' + byRule.matrix + ' rule(c)=' + byRule.c + ' rule(d)=' + byRule.d + ' rule(e)=' + byRule.e +
  ' rule(f)=' + byRule.f +
  ' policy=' + policyProblems.length +
  (strict ? ' (strict)' : ' (report only; pass --strict to fail the build)'),
);
if (policyProblems.length > 0) process.exitCode = 1;
else if (strict && failed > 0) process.exitCode = 1;
