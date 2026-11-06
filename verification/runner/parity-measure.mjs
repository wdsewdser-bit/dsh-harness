import fs from 'node:fs';
import path from 'node:path';

/**
 * Measurement half of verification/check-parity.mjs (WP-0 of docs/refactor-20261026/20-M5-plan.md).
 *
 * A factory, so the caller owns the repository root: the parity fixture in check-parity.test.mjs builds a throw-away
 * repository and has to measure that tree, not the one this file happens to live in.
 *
 * What a suite covers:
 *   files   - test-side closure: entry files plus everything they import by relative path, or spawn by a literal path,
 *             restricted to verification/ and packages/<pkg>/{test,test-support}/. Product source stops the walk.
 *   asserts - static count of assert.<name> / assert( call sites across that closure.
 *
 * ONE reader, ONE listing. guardedRead() is the only way file content is ever read in the parity gate and
 * guardedReaddir() the only way a directory is ever listed; both refuse verification/archive/, runs/ and node_modules/
 * before touching the disk and throw ForbiddenPathError (code PARITY_FORBIDDEN) for the caller to report. Deciding
 * after a read would already have opened the archive the default run promises not to scan.
 *
 * options.readFile - override of fs.readFileSync (a reader that records its calls is how the test proves a forbidden
 *                    file is never opened); options.onRead - called with the relative path of each content read.
 */
export class ForbiddenPathError extends Error {
  constructor(relative) {
    super('forbidden path: ' + relative);
    this.name = 'ForbiddenPathError';
    this.code = 'PARITY_FORBIDDEN';
    this.relative = relative;
  }
}

export function createMeasurer(repoRoot, options = {}) {
  const readFile = options.readFile ?? ((file, encoding) => fs.readFileSync(file, encoding));
  const onRead = options.onRead ?? null;

  const toPosix = value => value.replaceAll('\\', '/');
  const relOf = absolute => toPosix(path.relative(repoRoot, absolute));

  /** Only test-side files take part: verification/**, packages/<pkg>/test/**, packages/<pkg>/test-support/**. */
  const isTestSide = relative =>
    relative.startsWith('verification/') || /^packages\/[^/]+\/(test|test-support)\//.test(relative);

  /** Rule 8 and the offline contract: never scanned, never read, never counted. */
  function isForbidden(relative) {
    const normalised = toPosix(relative);
    if (normalised === 'verification/archive' || normalised.startsWith('verification/archive/')) return true;
    const parts = normalised.split('/');
    return parts.includes('runs') || parts.includes('node_modules');
  }

  /** The only content read in the parity gate. Throws before opening anything that sits on a forbidden path. */
  function guardedRead(file) {
    const absolute = path.isAbsolute(file) ? file : path.join(repoRoot, file);
    const relative = relOf(absolute);
    if (isForbidden(relative)) throw new ForbiddenPathError(relative);
    if (onRead) onRead(relative);
    return readFile(absolute, 'utf8');
  }

  /** The only directory listing in the parity gate. A forbidden directory yields no entries at all. */
  function guardedReaddir(dir) {
    const absolute = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
    const relative = relOf(absolute);
    if (isForbidden(relative)) throw new ForbiddenPathError(relative);
    return fs.readdirSync(absolute, { withFileTypes: true });
  }

  const SKIP_DIRS = new Set(['node_modules', '.git', 'runs', 'archive']);

  function walk(dir, out = []) {
    for (const entry of guardedReaddir(dir)) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.isFile()) out.push(full);
    }
    return out;
  }

  /** What "node --test" discovers when a suite passes no file argument: anything under a directory named "test". */
  const TEST_NAME = /\.(test|spec)\.(mjs|cjs|js)$|-test\.(mjs|cjs|js)$|_test\.(mjs|cjs|js)$|^test-.*\.(mjs|cjs|js)$/;
  const discover = dir => walk(dir)
    .filter(file => /\.(mjs|cjs|js)$/.test(file))
    .filter(file => relOf(file).split('/').includes('test') || TEST_NAME.test(path.basename(file)));

  const IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  const SCRIPT_LITERAL = /['"]([^'"\n]+?\.(?:mjs|cjs))['"]/g;
  /** A literal only counts when it sits next to a child-process call: mentioning a path is not running it. */
  const SPAWN_NEARBY = /\b(spawn|spawnSync|execFile|execFileSync|fork|execSync)\b|\bchild\(|\brun\(/;

  function references(file) {
    const source = guardedRead(file);
    const lines = source.split(/\r?\n/);
    const lineOf = index => source.slice(0, index).split('\n').length - 1;
    const found = [];
    for (const match of source.matchAll(IMPORT)) found.push({ specifier: match[1], fromDir: true });
    for (const match of source.matchAll(SCRIPT_LITERAL)) {
      const index = lineOf(match.index);
      if (SPAWN_NEARBY.test(lines.slice(Math.max(0, index - 3), index + 3).join('\n'))) {
        found.push({ specifier: match[1], fromDir: false });
      }
    }
    return found;
  }

  function resolveLocal(fromFile, specifier, fromDir) {
    const bases = fromDir ? [path.dirname(fromFile)] : [path.dirname(fromFile), repoRoot];
    for (const dir of bases) {
      if (!specifier.startsWith('.') && !path.isAbsolute(specifier) && dir === path.dirname(fromFile)) continue;
      const base = path.resolve(dir, specifier);
      const candidates = [base, base + '.mjs', base + '.cjs', base + '.js', path.join(base, 'index.mjs')];
      const hit = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (hit) return hit;
    }
    return null;
  }

  function entryFiles(suite) {
    const base = path.resolve(repoRoot, suite.cwd ?? '.');
    const named = suite.entry.filter(arg => !arg.startsWith('-') && /\.(mjs|cjs|js)$/.test(arg));
    return named.length > 0 ? named.map(arg => path.resolve(base, arg)) : discover(base);
  }

  /** Test-side closure. Every path is vetted before it is opened; a forbidden one is reported, not read. */
  function closure(entries, forbiddenHits) {
    const seen = new Set();
    const queue = [];
    for (const entry of entries) {
      const relative = relOf(entry);
      if (isForbidden(relative)) {
        forbiddenHits.push(relative);
        continue;
      }
      seen.add(relative);
      queue.push(entry);
    }
    while (queue.length > 0) {
      const file = queue.shift();
      for (const reference of references(file)) {
        const target = resolveLocal(file, reference.specifier, reference.fromDir);
        if (!target) continue;
        const relative = relOf(target);
        if (isForbidden(relative)) {
          forbiddenHits.push(relative);
          continue;
        }
        if (!isTestSide(relative) || seen.has(relative)) continue;
        seen.add(relative);
        queue.push(target);
      }
    }
    return [...seen].sort();
  }

  const ASSERT_CALL = /assert\.[a-zA-Z_$][a-zA-Z0-9_$]*/g;
  const ASSERT_BARE = /(?<![.\w$])assert\(/g;
  function countAsserts(relative) {
    const source = guardedRead(relative);
    return (source.match(ASSERT_CALL) ?? []).length + (source.match(ASSERT_BARE) ?? []).length;
  }

  function measure(suites) {
    const measured = new Map();
    const missing = [];
    const forbidden = [];
    for (const suite of suites) {
      const base = path.resolve(repoRoot, suite.cwd ?? '.');
      const baseRel = relOf(base);
      if (isForbidden(baseRel)) {
        // The cwd itself is off limits: do not walk it, and do not compare the suite against the baseline.
        forbidden.push(suite.id + ': ' + baseRel);
        measured.set(suite.id, { layer: suite.layer, files: [], fileAsserts: {}, asserts: 0,
          markers: [...suite.expect].sort(), skipped: true });
        continue;
      }
      const entries = entryFiles(suite);
      for (const entry of entries) if (!fs.existsSync(entry)) missing.push(suite.id + ': ' + relOf(entry));
      const hits = [];
      const files = closure(entries, hits);
      for (const hit of hits) forbidden.push(suite.id + ': ' + hit);
      const fileAsserts = {};
      let asserts = 0;
      for (const file of files) {
        fileAsserts[file] = countAsserts(file);
        asserts += fileAsserts[file];
      }
      measured.set(suite.id, { layer: suite.layer, files, fileAsserts, asserts, markers: [...suite.expect].sort() });
    }
    return { measured, missing, forbidden };
  }

  return { measure, countAsserts, relOf, isForbidden, guardedRead, guardedReaddir };
}
