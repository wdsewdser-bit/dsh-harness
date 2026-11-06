import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEEP_RUNS, ensureOwner, pruneRuns, writeBundle } from './runner/diagnostics.mjs';

/**
 * The failure bundle a suite writes when it fails on its own terms (full-test catches an unhandled error, p4-web
 * catches a projection failure), and the bundle the old runner writes for a failed suite.
 *
 * Bundles go to verification/.scratch/<runId>/diagnostics/<label>/ — never to runs/, which holds authoritative
 * evidence. The run id comes from the runner through DSH_TEST_RUN_ID so a suite's bundle lands in the run that
 * started it; a standalone invocation mints its own and shares the same five-run retention policy.
 */

const scratch = fileURLToPath(new URL('./.scratch/', import.meta.url));
let standaloneRunId = null;

export const spawnFailure = error => error
  ? {
      message: error.message,
      path: error.path ?? null,
      spawnargs: error.spawnargs ?? null,
      code: error.code ?? null,
      errno: error.errno ?? null
    }
  : null;

export function currentRunId() {
  if (process.env.DSH_TEST_RUN_ID) return process.env.DSH_TEST_RUN_ID;
  if (standaloneRunId === null) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    standaloneRunId = 'run-' + stamp + '-p' + process.pid;
  }
  return standaloneRunId;
}

export function saveFailure({ label, output = '', error = null, metadata = {}, roots = [] }) {
  // A suite that runs on its own mints its own run directory: give it an owner so retention can tell it is dead.
  ensureOwner(path.join(scratch, currentRunId()));
  const dir = path.join(scratch, currentRunId(), 'diagnostics', String(label).replaceAll('/', '-'));
  writeBundle({ dir, suite: label, output, metadata: { ...metadata, spawnError: spawnFailure(error) }, roots });
  pruneRuns(scratch, KEEP_RUNS, [currentRunId()]);
  return dir;
}
