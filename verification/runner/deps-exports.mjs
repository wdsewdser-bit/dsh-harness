import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './deps-walk.mjs';

/** rule (f) path grammar: "./" + lowercase name characters, one optional "*". */
const EXPORT_PATH = /^\.\/[a-z0-9._\-/]*(\*[a-z0-9._\-/]*)?$/;
const describeShape = value => value === null ? 'null' : Array.isArray(value) ? 'an array'
  : typeof value === 'object' ? 'a condition object' : JSON.stringify(value) ?? String(value);

/**
 * One "./" export path. Uppercase, backslashes, "..", "//", a trailing "/" and more than one "*" are all refused here;
 * this grammar is the only modelling of "exports" the check does, so rules (b)/(e) stay decidable.
 */
export function pathProblem(value, { starAllowed = true } = {}) {
  if (typeof value !== 'string') return 'must be a string, got ' + describeShape(value);
  if (!EXPORT_PATH.test(value)) {
    return 'must be "./" + [a-z0-9._-/] with ' + (starAllowed ? 'at most one "*"' : 'no "*"') + ', got ' + JSON.stringify(value);
  }
  if (value.includes('..')) return 'must not contain ".."';
  if (value.includes('//')) return 'must not contain "//"';
  if (value.endsWith('/')) return 'must not end with "/"';
  if (!starAllowed && value.includes('*')) return 'must not contain "*"';
  return null;
}

/**
 * The first path segment (from the package root) that is a symlink or a junction. For a pattern target only the fixed
 * directories before "*" are walked; for a plain target the whole path is. The walk stops at the first path that does
 * not exist - there is nothing further to resolve.
 */
// Windows resolves paths case-insensitively: a lower-case template reaches a directory stored as Src, so the
// comparison (and the test-module classification) folds case there; case-sensitive platforms keep the literal path.
export const foldCase = text => (process.platform === 'win32' ? text.toLowerCase() : text);

function firstLinkSegment(packageDir, relative, { whole = false } = {}) {
  const cut = whole ? relative.length : relative.lastIndexOf('/');
  const segments = relative.slice(0, cut).split('/').filter(segment => segment && segment !== '.');
  let current = packageDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try { stat = fs.lstatSync(current); } catch { return null; }
    if (stat.isSymbolicLink()) return './' + toPosix(path.relative(packageDir, current));
  }
  return null;
}

/**
 * rule (f): "exports" must be one "./" string (no "*": it is the "." root) or a plain map whose keys are "."/"./..."
 * and whose values are one "./"-relative target. Condition objects, arrays, null and anything else are unsupported;
 * a "*" must appear on both sides of a pair or on neither; no target path may pass through a symlink or junction.
 */
export function exportsShapeProblems(manifest, dir) {
  const map = manifest?.exports;
  if (map === undefined) return [];
  if (typeof map === 'string') {
    const problem = pathProblem(map, { starAllowed: false });
    if (problem) return [{ key: '.', detail: '"exports" must be one "./" path: ' + problem }];
    const link = firstLinkSegment(dir, map, { whole: true });
    return link ? [{ key: '.', detail: 'target path passes through a link: ' + link }] : [];
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    return [{ key: '.', detail: '"exports" must be a "./" path or a plain map of "./" targets, got ' + describeShape(map) }];
  }
  const problems = [];
  for (const [key, value] of Object.entries(map)) {
    if (key !== '.') {
      const keyProblem = pathProblem(key);
      if (keyProblem) { problems.push({ key, detail: 'export key ' + JSON.stringify(key) + ': ' + keyProblem }); continue; }
    }
    const valueProblem = pathProblem(value);
    if (valueProblem) { problems.push({ key, detail: 'export ' + JSON.stringify(key) + ': ' + valueProblem }); continue; }
    if (key.includes('*') !== value.includes('*')) {
      problems.push({ key, detail: 'export ' + JSON.stringify(key) + ' must carry "*" on both sides or on neither, got ' + JSON.stringify(value) });
      continue;
    }
    // A plain file target is checked to its last segment: the file itself may be the link.
    const link = firstLinkSegment(dir, value, { whole: !value.includes('*') });
    if (link) problems.push({ key, detail: 'export ' + JSON.stringify(key) + ' passes through a link: ' + link });
  }
  return problems;
}
/**
 * Node's key match for one subpath, under the rule (f) shapes only: the exact key, else the pattern with the longest
 * prefix and, among equal prefixes, the longer full key. "legal" is false when the matched entry itself violates rule
 * (f): the shape problem is reported once, by rule (f), and rule (b) must not repeat it.
 */
export function matchExport(manifest, subpath) {
  const map = manifest?.exports;
  const legal = (key, value) => (key === '.' || pathProblem(key) === null) && pathProblem(value) === null &&
    key.includes('*') === value.includes('*');
  if (typeof map === 'string') {
    return subpath ? { matched: false } : { matched: true, key: '.', target: map, star: null,
      legal: pathProblem(map, { starAllowed: false }) === null };
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { matched: false };
  const wanted = './' + subpath;
  if (Object.hasOwn(map, wanted)) {
    return { matched: true, key: wanted, target: map[wanted], star: null, legal: legal(wanted, map[wanted]) };
  }
  let best = null;
  for (const [key, target] of Object.entries(map)) {
    const at = key.indexOf('*');
    if (at < 0) continue;
    const prefix = key.slice(0, at), suffix = key.slice(at + 1);
    if (!wanted.startsWith(prefix) || !wanted.endsWith(suffix) || wanted.length < prefix.length + suffix.length) continue;
    if (best && (prefix.length < best.prefixLength ||
      (prefix.length === best.prefixLength && key.length <= best.key.length))) continue;
    best = { key, target, star: wanted.slice(prefix.length, wanted.length - suffix.length), prefixLength: prefix.length };
  }
  return best ? { matched: true, ...best, legal: legal(best.key, best.target) } : { matched: false };
}