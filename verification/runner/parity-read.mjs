import path from 'node:path';

/** The parity gate's own config reader: one guarded read path, with the same error text as the gate. */
export const toPosix = value => value.replaceAll('\\', '/');

export function createJsonReader({ repoRoot, guardedRead }) {
  return function readJson(file, fallback) {
    try {
      return JSON.parse(guardedRead(file));
    } catch (error) {
      if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
      console.error('cannot read ' + toPosix(path.relative(repoRoot, file)) + ': ' + error.message);
      process.exit(2);
    }
  };
}
