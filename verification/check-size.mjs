import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WP-5 size gate: long lines and oversized files.
 *
 *   >160 characters - a line that does not fit a normal review viewport; split assertions and object literals instead.
 *   >400 lines      - a file that should be split by responsibility (a stage, a rule group, a fixture family), never by
 *                     carving up a state machine.
 *
 * Scope:
 *   verification - verification/ excluding archive/ (history) and .scratch/ (run evidence)
 *   packages     - packages/<pkg>/test and packages/<pkg>/test-support
 *   all          - both (the default)
 *
 * Report-only by default; --strict exits 1 when a violation exists. Counts are characters in the line (UTF-16 units),
 * which is the same measure the plan's "160 字符" uses.
 */
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const KNOWN = new Set(['--strict']);
let scope = 'all';
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--scope') { scope = argv[index + 1] ?? ''; index += 1; continue; }
  if (arg.startsWith('--scope=')) { scope = arg.slice('--scope='.length); continue; }
  if (!KNOWN.has(arg)) { console.error('check-size: unknown argument ' + arg); process.exit(2); }
}
if (!['verification', 'packages', 'all'].includes(scope)) {
  console.error('check-size: --scope must be verification, packages or all, got ' + JSON.stringify(scope));
  process.exit(2);
}
const strict = argv.includes('--strict');
const CODE = /\.(mjs|js|cjs)$/;

/**
 * File-level exemptions for files that cannot be split without carving up one indivisible unit. At most three, each
 * with a reason. An exempt file is listed in the report but does not count towards either rule.
 */
const EXEMPTIONS = new Map([
  ['verification/probes/llm-dispatch.mjs',
    'one probe data table: ~850 lines of fixed request/response fixtures and dispatch steps; splitting it would slice a ' +
    'single table into pieces, not separate responsibilities (WP-5a, reviewed)']
]);
if (EXEMPTIONS.size > 3) {
  console.error('check-size: at most three file exemptions are allowed, got ' + EXEMPTIONS.size);
  process.exit(2);
}
for (const [file, reason] of EXEMPTIONS) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    console.error('check-size: exemption for ' + file + ' has no reason');
    process.exit(2);
  }
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.isFile() && CODE.test(entry.name)) out.push(full);
  }
}

function collect() {
  const files = [];
  if (scope === 'verification' || scope === 'all') {
    const root = path.join(repoRoot, 'verification');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.name === 'archive' || entry.name === '.scratch' || entry.name === 'node_modules') continue;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) walk(full, files);
      else if (entry.isFile() && CODE.test(entry.name)) files.push(full);
    }
  }
  if (scope === 'packages' || scope === 'all') {
    const packages = path.join(repoRoot, 'packages');
    for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      walk(path.join(packages, entry.name, 'test'), files);
      walk(path.join(packages, entry.name, 'test-support'), files);
    }
  }
  return files.sort();
}

const rows = [];
for (const file of collect()) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const relative = path.relative(repoRoot, file).replaceAll('\\', '/');
  if (EXEMPTIONS.has(relative)) continue;
  const long = lines.reduce((count, line) => count + (line.length > 160 ? 1 : 0), 0);
  if (long > 0 || lines.length > 400) {
    rows.push({ file: relative, long, lines: lines.length });
  }
}
const longTotal = rows.reduce((sum, row) => sum + row.long, 0);
const huge = rows.filter(row => row.lines > 400);
const scopeLabel = scope === 'all' ? 'verification + packages' : scope;
console.log('check-size: scope=' + scopeLabel + ' files scanned=' + collect().length);
for (const row of rows.sort((a, b) => b.long - a.long || b.lines - a.lines)) {
  const longLabel = row.long > 0 ? row.long + ' long' : '       ';
  const sizeLabel = row.lines > 400 ? ' >400L' : '      ';
  console.log('  ' + longLabel + '  ' + String(row.lines).padStart(5) + sizeLabel + '  ' + row.file);
}
for (const [file, reason] of EXEMPTIONS) console.log('  [exempt] ' + file + ' -- ' + reason);
console.log('summary: long(>160)=' + longTotal + ' files(>400)=' + huge.length +
  ' offenders=' + rows.length + (strict ? ' (strict)' : ' (report only; pass --strict to fail)'));
if (strict && (longTotal > 0 || huge.length > 0)) process.exitCode = 1;
