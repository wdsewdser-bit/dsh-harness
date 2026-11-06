import fs from 'node:fs';
import path from 'node:path';
import { processTable } from './guard.mjs';

/**
 * Failure bundles and run retention.
 *
 * A failing suite writes <run>/diagnostics/<suite>/ with the complete output (never a truncated tail), the metadata a
 * reader needs to reproduce it, and the JSON artifacts the suite left in its root. Bundles live under
 * verification/.scratch/ (gitignored) rather than runs/, which holds authoritative evidence.
 *
 * Retention has to survive concurrency: several runners (a suite that starts its own runner, two sessions) share the
 * same scratch directory, and one must never delete another's work. So every run owns itself:
 *
 *   owner.json   written when the run starts: {pid, created, startedAt}. "created" is this process's start time, so
 *                a recycled pid is not mistaken for the same run.
 *   finished     written when the run ends, by any path including a signal.
 *
 * pruneRuns removes a directory only when it is finished, or when its owner is gone (pid absent, or pid present with a
 * different creation time) and the directory is older than a grace period. Anything else - a sibling run, an ancestor
 * run, a run whose owner cannot be read - is left alone. Every filesystem step tolerates ENOENT and EBUSY: a pruner
 * must never fail the run that called it.
 */

export const KEEP_RUNS = 5;
export const GRACE_MS = 10 * 60 * 1000;
const ARTIFACTS = new Set(['report.json', 'facts.json', 'summary.json']);

/** This process's start time, as Windows reports it for a process (within a second). */
export const processStart = () => new Date(Date.now() - process.uptime() * 1000).toISOString();

export function writeOwner(runDir, startedAt = new Date().toISOString()) {
  const file = path.join(runDir, 'owner.json');
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, created: processStart(), startedAt }, null, 2));
    return file;
  } catch {
    return null;
  }
}

/** Write the owner only when the directory has none: an outer run's owner is never overwritten. */
export function ensureOwner(runDir) {
  try {
    if (fs.existsSync(path.join(runDir, 'owner.json'))) return path.join(runDir, 'owner.json');
  } catch {
    return null;
  }
  return writeOwner(runDir);
}

export function markFinished(runDir) {
  try {
    fs.writeFileSync(path.join(runDir, 'finished'), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

const ignore = error => error && (error.code === 'ENOENT' || error.code === 'EBUSY');

function hasFinished(dir) {
  try {
    return fs.existsSync(path.join(dir, 'finished'));
  } catch {
    return false;
  }
}

function readOwner(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
    return parsed && Number.isInteger(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
}

/** Dead means "not that process any more": the pid is gone, or a different process took the pid. */
function ownerGone(owner, table) {
  if (table === null) return false; // the process list could not be read: never guess
  const row = table.find(entry => entry.pid === owner.pid);
  if (!row) return true;
  if (!owner.created || !row.creation) return false;
  const recorded = Date.parse(owner.created);
  const live = Date.parse(row.creation);
  if (!Number.isFinite(recorded) || !Number.isFinite(live)) return false;
  return Math.abs(live - recorded) > 5000;
}

function copyArtifacts(source, target, collected) {
  if (!fs.existsSync(source)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(source)) copyArtifacts(path.join(source, name), path.join(target, name), collected);
    return;
  }
  if (!ARTIFACTS.has(path.basename(source))) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  collected.push(target);
}

/** Write one bundle into an explicit directory and return it. */
export function writeBundle({ dir, suite, output = '', metadata = {}, roots = [] }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.log'), output);
  const artifacts = [];
  roots.forEach((root, index) => {
    if (root) copyArtifacts(root, path.join(dir, 'artifacts', String(index)), artifacts);
  });
  fs.writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ suite, ...metadata, artifacts }, null, 2));
  return dir;
}

/** The runner's entry point: the bundle belongs to this run. */
export function saveFailure({ runDir, suiteId, output = '', metadata = {}, roots = [] }) {
  return writeBundle({
    dir: path.join(runDir, 'diagnostics', suiteId.replaceAll('/', '-')),
    suite: suiteId,
    output,
    metadata,
    roots
  });
}

function listRuns(baseDir) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
    const dir = path.join(baseDir, entry.name);
    let mtime;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch (error) {
      if (ignore(error)) continue;
      continue;
    }
    if (!Number.isFinite(mtime)) continue;
    runs.push({ name: entry.name, dir, mtime });
  }
  return runs.sort((a, b) => b.mtime - a.mtime);
}

function remove(dir, pruned) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    pruned.push(dir);
  } catch (error) {
    if (ignore(error)) return; // already gone, or locked by someone else: nothing to do
  }
}

/** Keep the newest KEEP_RUNS; beyond that, only finished runs or runs whose owner is gone past the grace. */
export function pruneRuns(baseDir, keep = KEEP_RUNS, protect = [], options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : GRACE_MS;
  const now = Date.now();
  const protectedNames = new Set(protect.filter(Boolean).map(name => path.basename(name)));
  const candidates = listRuns(baseDir).slice(keep).filter(run => !protectedNames.has(run.name));
  if (candidates.length === 0) return [];
  let table = null;
  if (candidates.some(run => !hasFinished(run.dir))) {
    try {
      table = processTable();
    } catch {
      table = null; // unreadable process list: only finished runs may go
    }
  }
  const pruned = [];
  for (const run of candidates) {
    if (hasFinished(run.dir)) {
      remove(run.dir, pruned);
      continue;
    }
    const owner = readOwner(run.dir);
    if (!owner) continue;
    if (!ownerGone(owner, table)) continue;
    if (now - run.mtime < graceMs) continue;
    remove(run.dir, pruned);
  }
  return pruned;
}

export function writeRunSummary(runDir, summary) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2));
}
