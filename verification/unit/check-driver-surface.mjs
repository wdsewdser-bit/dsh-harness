import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * F2a: the F1 driver switch is deleted, not just defaulted away.
 *
 * This is the static half of that acceptance. A configuration or a code path that still names the removed driver, or
 * the harness-only error code, would mean the second execution shape is still reachable - the exact failure F2 exists
 * to remove ("the real experiments would be measuring the harness, not the product").
 *
 * What counts as naming it: the word appears in *code*, in any form - a quoted literal, a template, a property value,
 * a bare identifier. Comments are stripped first (blanked, not removed, so line numbers stay true), so prose that
 * explains the removal is allowed while anything executable is not. The only opt-out is an explicit marker on or just
 * above a line, used solely for the negative test that proves the removed value is refused.
 *
 * Scope: packages/ and verification/, with no directory exempt. F2b migrated verification/real onto the product
 * profile and deleted engine.mjs, so the real experiments are held to the same rule as the rest of the tree.
 */
export const PATTERNS = Object.freeze([
  { id: 'removed-driver', re: /\bharness\b/g },
  { id: 'harness-only-error', re: /MISSING_SERVER_BINDING/g },
]);
const EXEMPT_DIRS = ['node_modules', '.scratch', 'runs', 'verification/archive'];
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Blank out comments while keeping every newline, so a match index still maps to the original line. */
export function codeOnly(text) {
  let out = '', index = 0;
  while (index < text.length) {
    const block = text.indexOf('/*', index), line = text.indexOf('//', index);
    const next = block === -1 ? line : line === -1 ? block : Math.min(block, line);
    if (next === -1) { out += text.slice(index); break; }
    // A '//' inside a string literal is not a comment; the scans here are only as fine as they need to be, and a
    // string that contains '//' has no driver name to hide behind.
    out += text.slice(index, next);
    if (next === block) {
      const end = text.indexOf('*/', next + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(next, stop).replace(/[^\n]/g, ' ');
      index = stop;
    } else {
      const end = text.indexOf('\n', next);
      const stop = end === -1 ? text.length : end;
      out += text.slice(next, stop).replace(/[^\n]/g, ' ');
      index = stop;
    }
  }
  return out;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replaceAll('\\', '/');
    if (EXEMPT_DIRS.some(prefix => rel === prefix || rel.startsWith(prefix + '/'))) continue;
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (!/\.(mjs|js|cjs)$/.test(entry.name)) continue;
    out.push(rel);
  }
  return out;
}

/**
 * Inside an import/export specifier the directory segment `harness/` is a location, not the removed driver: mask that
 * one segment and leave the rest of the specifier in the text, so a forbidden name sitting in the same path is still
 * reported. Anything outside a specifier is not touched, and files under the harness directory are scanned like any
 * other file.
 */
export function maskDirectorySegments(code) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]*)\2/g,
    (whole, lead, quote, specifier) => specifier.includes('harness/')
      ? lead + quote + specifier.replace(/(^|\/)harness\//g, match => ' '.repeat(match.length)) + quote
      : whole);
}

/** The hits of one file's text: the unit scan() is built from, so the guard can be tested on synthetic content. */
export function scanText(file, text) {
  const code = maskDirectorySegments(codeOnly(text));
  const lines = text.split('\n');
  const hits = [];
  for (const { id, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const match of code.matchAll(re)) {
      const line = code.slice(0, match.index).split('\n').length;
      const around = lines.slice(Math.max(0, line - 2), line).join('\n');
      // One explicit opt-out, and only for a negative case that proves the refusal itself.
      if (around.includes('f2a-allow-removed-driver')) continue;
      hits.push({ file, line, id, text: lines[line - 1].trim() });
    }
  }
  return hits;
}

/** Every match, with its 1-based line, so a failure names the exact place to fix. */
export function scan(files = null) {
  const list = files ?? [...walk(path.join(ROOT, 'packages'), []), ...walk(path.join(ROOT, 'verification'), [])]
    .filter(file => file !== 'verification/unit/check-driver-surface.mjs');
  const hits = list.flatMap(file => scanText(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
  return { scanned: list.length, hits };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { scanned, hits } = scan();
  if (hits.length) {
    for (const hit of hits) console.error(hit.file + ':' + hit.line + '  [' + hit.id + ']  ' + hit.text);
    console.error('driver surface: FAIL (' + hits.length + ' hits in ' + scanned + ' files)');
    process.exit(1);
  }
  console.log('driver surface: PASS (' + scanned + ' files scanned; no removed driver in code, no harness-only error)');
}
