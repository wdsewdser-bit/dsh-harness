import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Regenerate candidate.patch from original/ and a patched build copy.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const build = path.resolve(process.argv[2] ?? process.env.DSH_UPSTREAM_BUILD ?? '<path-to-dsh-v2>/runs/m1b-build-2026-10-28T19-26-17');
const modules = path.join(build, 'node_modules', '@deepseek-ai');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'anchors.json'), 'utf8'));
let patch = '';
for (const file of Object.keys(meta.files)) {
  const original = path.join(ROOT, 'original', file);
  const patched = path.join(modules, file);
  const diff = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-color', '--', original, patched], { encoding: 'utf8' });
  if (diff.status !== 1) throw new Error('DIFF_FAILED:' + diff.status + ':' + diff.stderr);
  const lines = diff.stdout.split('\n');
  const start = lines.findIndex(line => line.startsWith('@@'));
  if (start < 0) throw new Error('NO_HUNKS:' + file);
  patch += '--- a/' + file + '\n+++ b/' + file + '\n' + lines.slice(start).join('\n').replace(/\n*$/, '\n');
}
fs.writeFileSync(path.join(ROOT, 'candidate.patch'), patch);
const stats = { hunks: patch.split('\n').filter(l => l.startsWith('@@')).length, added: patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length, removed: patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length };
fs.writeFileSync(path.join(ROOT, 'patch-stats.json'), JSON.stringify(stats, null, 2) + '\n');
console.log(JSON.stringify(stats));