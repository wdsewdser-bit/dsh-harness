import fs from 'node:fs';
import path from 'node:path';

export const toPosix = value => value.replaceAll('\\', '/');

export function createWalkers(packagesRoot) {
  const key = value => toPosix(path.resolve(value)).toLowerCase();
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

function packageOf(file) {
  const relative = path.relative(packagesRoot, file);
  if (relative.startsWith('..')) return null;
  const segments = toPosix(relative).split('/');
  return segments.length > 1 ? segments[0] : null;
}

/** §2.2 rule 1: /test/, /test-support/ directories and *.test.mjs are tests, everything else is source. */
function isTestFile(file) {
  const relative = '/' + toPosix(path.relative(packagesRoot, file));
  return /\/(test|test-support)\//.test(relative) || file.endsWith('.test.mjs');
}

/** Import/export/require specifiers with their line numbers. */
function specifiersOf(file) {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  const found = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(lines[i])) !== null) {
        found.push({ specifier: match[1], line: i + 1 });
      }
    }
  }
  const seen = new Set();
  return found.filter(item => {
    const id = item.line + '|' + item.specifier;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Resolve a relative specifier the way Node would for this tree (explicit extensions dominate the code). */
function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base + '.mjs', base + '.js', path.join(base, 'index.mjs'), path.join(base, 'index.js')];
  return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? base;
}

/** Public entries of a package: index.mjs plus every target declared in its package.json "exports". */
function publicEntries(packageDir) {
  const entries = [key(path.join(packageDir, 'index.mjs'))];
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return entries;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const addTargets = node => {
    if (typeof node === 'string') {
      if (node.startsWith('./')) entries.push(key(path.join(packageDir, node)));
      return;
    }
    if (node && typeof node === 'object') Object.values(node).forEach(addTargets);
  };
  addTargets(manifest.exports);
  return entries;
}
  return { walk, packageOf, isTestFile, specifiersOf, resolveRelative, publicEntries, key };
}
