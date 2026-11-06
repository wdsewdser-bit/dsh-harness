import fs from 'node:fs';
import path from 'node:path';
import { failWith } from '../../contracts/index.mjs';

/**
 * Team directory normalisation; docs/host-protocol.md §1.1 and invariant 1.
 *
 * Ownership is keyed by the normalised team directory, so two spellings of one directory must collapse to one key:
 * a relative path, './', '..', a trailing separator, a junction/symlink, and (on Windows) a different letter case.
 */

/** Resolve to the spelling the filesystem actually uses; best effort, because the directory may not exist yet. */
function realOrResolved(absolute) {
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    // Walk up to the deepest existing ancestor, resolve that, and re-join the rest.
  }
  let head = absolute;
  const tail = [];
  for (;;) {
    const parent = path.dirname(head);
    if (parent === head) return absolute;
    tail.unshift(path.basename(head));
    head = parent;
    try {
      const real = fs.realpathSync.native(head);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      // Keep walking up; path.join below normalises the leftover './' and '..' segments.
    }
  }
}

/** The canonical directory for a team. Throws INVALID_TEAM_ROOT instead of guessing. */
export function canonicalTeamDir(root) {
  if (typeof root !== 'string' || !root.trim()) failWith('INVALID_TEAM_ROOT', 'a team root must be a non-empty path string');
  if (root.includes('\u0000')) failWith('INVALID_TEAM_ROOT', 'a team root must not contain NUL');
  const resolved = path.resolve(root);
  const real = realOrResolved(resolved);
  const fileSystemRoot = path.parse(real).root;
  return real.length > fileSystemRoot.length ? real.replace(/[\\/]+$/, '') : real;
}

/** The identity used by the in-process registry: case-insensitive on Windows, exact elsewhere. */
export function teamDirKey(root) {
  const dir = canonicalTeamDir(root);
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
}
