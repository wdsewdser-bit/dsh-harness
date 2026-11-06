import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Archive isolation (20-M5-plan.md, rule 8).
 *
 * verification/archive/ keeps the one-off scripts that no entry runs and nothing imports. This check proves the
 * isolation is real, not a convention: no suite entry points into the archive, and nothing outside the archive
 * references a file inside it. It also prints what is archived, so the list is visible in the CI log.
 *
 * A reference counts only when it resolves to a file that exists: fixture strings inside a test ("verification/archive/legacy.mjs"
 * as an argument) are not a dependency on the archive.
 *
 * Every archived script carries an ARCHIVED marker on line 1 (date and the path it was moved from), so the archive
 * cannot grow by dropping a live file in without saying so.
 *
 * One pre-existing dead link stays outside this rule: verification/fixtures/preempt-transport-test.mjs takes Engine
 * from verification/real/scenario.mjs:11, which stays in real/ and is not archived; preempt-transport is spawned by the
 * real/preempt-copy suite, so it is not an orphan and never counts as a reference into the archive.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const archiveDir = path.join(here, 'archive');
const suitesPath = path.join(here, 'runner', 'suites.json');
const problems = [];

const insideArchive = abs => {
  const rel = path.relative(archiveDir, abs);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

let archived = [];
try {
  archived = fs.readdirSync(archiveDir).filter(name => /\.(mjs|cjs|ps1|json)$/.test(name));
} catch {
  archived = [];
}

const manifest = JSON.parse(fs.readFileSync(suitesPath, 'utf8'));
for (const suite of manifest.suites) {
  for (const arg of suite.entry) {
    if (arg.includes('archive/')) problems.push(suite.id + ': entry points into the archive: ' + arg);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.scratch' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'archive') continue;
      walk(full);
      continue;
    }
    if (!/\.(mjs|cjs|ps1)$/.test(entry.name)) continue;
    scan(full);
  }
}

function scan(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');
  for (const match of text.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (insideArchive(target) && fs.existsSync(target)) problems.push(rel + ': imports ' + match[1]);
  }
  for (const match of text.matchAll(/['"](verification\/archive\/[^'"]+)['"]/g)) {
    const target = path.join(repoRoot, match[1]);
    if (fs.existsSync(target)) problems.push(rel + ': references ' + match[1]);
  }
}

// The marker is the archive's own record: a file dropped here without one would be invisible in review.
for (const name of archived) {
  if (!/\.(mjs|cjs|ps1)$/.test(name)) continue;
  let firstLine = '';
  try {
    firstLine = fs.readFileSync(path.join(archiveDir, name), 'utf8').split(/\r?\n/, 1)[0];
  } catch {
    problems.push(name + ': cannot be read');
    continue;
  }
  if (!firstLine.includes('ARCHIVED')) problems.push(name + ': no ARCHIVED marker on line 1');
}

walk(here);

if (problems.length > 0) {
  for (const problem of problems) console.error('archive: ' + problem);
  console.error('check-archive: ' + problems.length + ' violation(s)');
  process.exit(1);
}
console.log('check-archive: 0 violations; ' + archived.length + ' archived file(s): ' + archived.join(', '));
