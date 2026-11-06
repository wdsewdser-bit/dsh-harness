import fs from 'node:fs';
import path from 'node:path';

/**
 * The suite list (verification/runner/suites.json) is the single manifest of what npm test runs.
 *
 * It stays an explicit, reviewed constant ("discovery by filename could silently pick up a live experiment"), and this
 * module is where a broken manifest fails loudly instead of shrinking the run: an unknown id, a duplicate id, an entry
 * file that does not exist, a bad layer/resource, an uncompilable success marker.
 */

export const LAYERS = new Set(['static', 'unit', 'domain', 'integration', 'e2e', 'real']);
export const RESOURCES = new Set(['exclusive', 'runs-root']);

const isPositive = value => Number.isSafeInteger(value) && value > 0;

export function loadManifest(manifestPath, repoRoot, overrides = {}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const list = manifest.suites;
  if (!Array.isArray(list) || list.length === 0) throw Error('suites.json has no suites');

  const defaultTimeout = isPositive(manifest.timeoutMs) ? manifest.timeoutMs : 600000;
  const suites = [];
  const seen = new Set();
  for (const raw of list) {
    const id = raw.id;
    if (typeof id !== 'string' || id.trim() === '') throw Error('suite without id: ' + JSON.stringify(raw));
    if (seen.has(id)) throw Error('duplicate suite id: ' + id);
    seen.add(id);
    if (!LAYERS.has(raw.layer)) throw Error(id + ': unknown layer ' + raw.layer);
    if (!Array.isArray(raw.entry) || raw.entry.length === 0) throw Error(id + ': empty entry');
    if (!raw.entry.every(arg => typeof arg === 'string')) throw Error(id + ': entry must be strings');
    const resources = raw.resources ?? [];
    if (!resources.every(resource => RESOURCES.has(resource))) {
      throw Error(id + ': unknown resource in ' + JSON.stringify(resources));
    }
    const expect = raw.expect ?? [];
    if (!Array.isArray(expect) || expect.length === 0) throw Error(id + ': empty expect');
    for (const source of expect) {
      try {
        new RegExp(source);
      } catch (error) {
        throw Error(id + ': bad success marker ' + JSON.stringify(source) + ': ' + error.message);
      }
    }
    const cwd = raw.cwd ?? '.';
    const base = path.resolve(repoRoot, cwd);
    if (!fs.existsSync(base)) throw Error(id + ': missing suite directory ' + cwd);
    for (const arg of raw.entry) {
      if (arg.startsWith('-') || !/\.(mjs|cjs|js)$/.test(arg)) continue;
      const file = path.resolve(base, arg);
      if (!fs.existsSync(file)) throw Error(id + ': missing entry file ' + arg);
    }
    suites.push({
      id,
      layer: raw.layer,
      entry: [...raw.entry],
      cwd,
      root: raw.root ?? null,
      expect: expect.map(source => new RegExp(source)),
      resources,
      ports: raw.ports === true,
      // deep suites are the long/mutation sweeps: npm test skips them, test:deep runs only them.
      deep: raw.deep === true,
      timeoutMs: overrides.timeoutMs ?? (isPositive(raw.timeoutMs) ? raw.timeoutMs : defaultTimeout)
    });
  }
  return suites;
}

/** Serial phase: shared evidence or OS-level assertions must not race. Everything else may run side by side. */
export const isSerial = suite => suite.resources.some(resource => resource === 'exclusive' || resource === 'runs-root');
