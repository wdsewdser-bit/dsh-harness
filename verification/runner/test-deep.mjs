import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * npm run test:deep - the suites npm test leaves out on purpose (the mutation sweeps and the long retention runs).
 *
 * The same runner runs them, so the job objects, the timeout and the diagnostics are identical; the outcome is then
 * recorded where the default run looks for it (verification/.scratch/test-deep.json), which is what turns the
 * "test:deep: never run on this machine" line into a dated verdict. A suite opts in with "deep": true in suites.json.
 */
const runnerDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(runnerDir, '..', '..');
const recordPath = path.join(repoRoot, 'verification', '.scratch', 'test-deep.json');
const manifest = JSON.parse(fs.readFileSync(path.join(runnerDir, 'suites.json'), 'utf8'));
const deepIds = manifest.suites.filter(suite => suite.deep === true).map(suite => suite.id);
if (deepIds.length === 0) {
  console.error('test-deep: no suite is marked "deep": true in suites.json');
  process.exit(2);
}
const startedAt = new Date().toISOString();
const child = spawnSync(process.execPath, [path.join(runnerDir, 'run.mjs'), '--only=' + deepIds.join(','), '--jobs=1'],
  { cwd: repoRoot, stdio: 'inherit' });
const ok = child.status === 0;
fs.mkdirSync(path.dirname(recordPath), { recursive: true });
fs.writeFileSync(recordPath, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), ok,
  suites: deepIds, exitCode: child.status, signal: child.signal }, null, 2) + '\n');
process.exit(ok ? 0 : 1);
