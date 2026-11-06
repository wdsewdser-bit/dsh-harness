import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The borrow profile names the release its files are pinned to (packages/profiles/borrow-entry-support.mjs). A
 * borrow.release that drifted from the build this repository actually runs would make that entry describe another
 * release's wiring, so the configuration is checked against the default build's own manifest here, where the default
 * is read, instead of being trusted. The build-target suite cannot carry this assertion: verification/check-parity
 * pins a moved file's assertion count exactly, so new checks live in their own file.
 */
test('builds.json borrow.release equals the default build manifest version', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'build', 'builds.json'), 'utf8'));
  assert.equal(typeof config.borrow?.release, 'string', 'builds.json must name borrow.release');
  assert.equal(typeof config.default, 'string', 'builds.json must name a default build');
  const manifest = JSON.parse(fs.readFileSync(path.join(config.default, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  assert.equal(config.borrow.release, manifest.version,
    'borrow.release must be the release the default build actually carries, not a copy that can drift');
});
