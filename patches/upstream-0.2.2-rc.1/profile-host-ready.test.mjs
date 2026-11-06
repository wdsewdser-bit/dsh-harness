import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootProfile } from './profile-host.mjs';

/**
 * The negative half of the host wiring: a Team plugin whose initialize() rejects must make bootProfile fail with that
 * error. Before bootProfile awaited teamRuntime.ready it returned a ctx whose teamRuntime.core was still undefined,
 * so every probe failed one dereference later with a TypeError that named nothing. The boot override stands in for the
 * real Loader so the refusal itself is what is tested; the profile is still generated and audited by bootProfile.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ready-refused-'));
let passed = 0;
try {
  const refusal = Object.assign(Error('TEAM_READY_REFUSED'), { code: 'TEAM_READY_REFUSED' });
  const boot = () => ({
    loader: { entries: () => [] },
    fiber: { dispose: async () => {} },
    teamRuntime: { ready: Promise.reject(refusal) },
  });
  await assert.rejects(
    () => bootProfile(root, { team: true, guard: true, goalCheck: true }, [], { boot }),
    error => error.code === 'TEAM_READY_REFUSED',
    'a refused Team runtime must reject bootProfile itself');
  passed++;
  console.log('PASS bootProfile fails when teamRuntime.ready rejects, instead of returning an uninitialised runtime');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exitCode = passed === 1 ? 0 : 1;
