import fs from 'node:fs';

export const DRIVE_PATH = /['"`]([^'"`]*\b[A-Za-z]:[\\/][^'"`]*)['"`]/;
export function createHardCodedPathCheck({ isTestFile, addViolation }) {
  return function checkHardCodedPaths(file) {
  if (isTestFile(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = DRIVE_PATH.exec(lines[i]);
    if (match) {
      addViolation(file, i + 1, 'c', match[1],
        'a drive-letter absolute path only works on one machine; build roots come from build/builds.json or an env override');
    }
  }
  };
}
