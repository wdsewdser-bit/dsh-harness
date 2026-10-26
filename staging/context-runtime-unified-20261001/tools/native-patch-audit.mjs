// Read-only audit of how each modified native package is carried: a registered pnpm patch that survives a
// reinstall, or a direct edit of a staged copy that an upstream upgrade silently drops.
// Usage: node tools/native-patch-audit.mjs                   print the report
//        node tools/native-patch-audit.mjs --check           exit 1 when the report differs from native-patch-baseline.json
//        node tools/native-patch-audit.mjs --write-baseline --reason=<why the new state is accepted>
// Run --check before and after every upstream upgrade. A changed upstream version means every edit to that
// package has to be re-examined against architecture-tests/upstream-compat-contract.test.mjs, not re-hashed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const stage = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const app = path.resolve(stage, '../../app')
const scope = '@deepseek-ai'
const check = process.argv.includes('--check'), write = process.argv.includes('--write-baseline')
const reason = (process.argv.find(arg => arg.startsWith('--reason=')) ?? '').slice(9).trim()
if (write && reason.length < 10) throw new Error('REASON_REQUIRED: pass --reason=<why the new state is accepted> (at least 10 characters)')
const baselineFile = path.join(stage, 'native-patch-baseline.json')

// Manifest paths are absolute on the machine that wrote them; only the part below the stage is portable.
const marker = path.basename(stage).toLowerCase() + '/'
const local = recorded => {
  const normal = String(recorded).replaceAll('\\', '/'), at = normal.toLowerCase().indexOf(marker)
  if (at === -1) throw new Error('PATH_OUTSIDE_STAGE ' + recorded)
  return path.join(stage, normal.slice(at + marker.length))
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const version = directory => { try { return readJson(path.join(directory, 'package.json')).version ?? null } catch { return null } }

// patchedDependencies, without a YAML dependency: the block is a flat map of quoted keys.
const workspaceFile = path.join(app, 'pnpm-workspace.yaml')
const registered = new Map()
if (fs.existsSync(workspaceFile)) {
  const text = fs.readFileSync(workspaceFile, 'utf8'), start = text.search(/^patchedDependencies:\s*$/m)
  if (start !== -1) for (const line of text.slice(start).split(/\r?\n/).slice(1)) {
    if (!/^\s+\S/.test(line)) break
    const match = line.match(/^\s+'?(@?[^'@\s]+(?:\/[^'@\s]+)?)@([^':\s]+)'?:\s*(\S+)\s*$/)
    if (!match) throw new Error('UNPARSED_PATCHED_DEPENDENCY ' + line)
    registered.set(match[1], { version: match[2], patch: match[3] })
  }
}
const patchDirectory = path.join(app, 'patches')
const patchFiles = fs.existsSync(patchDirectory) ? fs.readdirSync(patchDirectory).filter(name => name.endsWith('.patch')) : []

const packages = new Map()
for (const entry of readJson(path.join(stage, 'native-change-manifest.json'))) {
  const file = local(entry.path), parts = path.relative(path.join(stage, 'app/node_modules', scope), file).split(path.sep)
  if (parts[0] === '..' || parts.length < 2) throw new Error('NOT_A_SCOPED_PACKAGE_FILE ' + entry.path)
  const directory = parts[0], name = entry.package ?? directory.replace(/-v\d+$/, '')
  const row = packages.get(name) ?? { package: scope + '/' + name, stagedDirectories: new Set(), files: 0, newFiles: 0 }
  row.stagedDirectories.add(directory); row.files++; if (entry.before == null) row.newFiles++
  packages.set(name, row)
}

const rows = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, row]) => {
  const full = scope + '/' + name, patch = registered.get(full)
  const plain = path.join(stage, 'app/node_modules', scope, name)
  const directories = [...row.stagedDirectories].sort()
  // The plain directory is usually a junction to the production install, so its version is the installed upstream version.
  const upstreamVersion = version(plain) ?? version(path.join(app, 'node_modules', scope, name)) ?? version(path.join(stage, 'app/node_modules', scope, directories[0]))
  return {
    package: full, upstreamVersion, files: row.files, newFiles: row.newFiles, stagedDirectories: directories,
    channel: patch ? 'pnpm-patch' : 'staging-copy',
    ...(patch ? { patch: patch.patch, patchVersion: patch.version, patchFilePresent: fs.existsSync(path.join(app, patch.patch)),
      patchVersionMatchesInstalled: upstreamVersion === null ? null : patch.version === upstreamVersion } : {}),
  }
})
const manifestNames = new Set(rows.map(row => row.package))
const registeredOnly = [...registered].filter(([name]) => name.startsWith(scope + '/') && !manifestNames.has(name)).map(([name, patch]) => ({ package: name, ...patch })).sort((a, b) => a.package.localeCompare(b.package))
const registeredPatchFiles = new Set([...registered.values()].map(patch => path.basename(patch.patch)))
const report = {
  summary: {
    manifestPackages: rows.length,
    carriedByPnpmPatch: rows.filter(row => row.channel === 'pnpm-patch').length,
    carriedByStagingCopyOnly: rows.filter(row => row.channel === 'staging-copy').length,
    registeredButNotInManifest: registeredOnly.length,
    unregisteredPatchFiles: patchFiles.filter(name => !registeredPatchFiles.has(name)).length,
    upstreamVersions: [...new Set(rows.map(row => row.upstreamVersion))].sort(),
  },
  packages: rows,
  registeredButNotInManifest: registeredOnly,
  unregisteredPatchFiles: patchFiles.filter(name => !registeredPatchFiles.has(name)).sort(),
}

if (write) {
  fs.writeFileSync(baselineFile, JSON.stringify({ acceptedAt: new Date().toISOString(), reason, ...report }, null, 2) + '\n')
  console.log(JSON.stringify({ written: path.basename(baselineFile), ...report.summary }, null, 1))
} else if (check) {
  if (!fs.existsSync(baselineFile)) throw new Error('BASELINE_MISSING: run --write-baseline first')
  const { acceptedAt, reason: accepted, ...baseline } = readJson(baselineFile)
  const before = new Map(baseline.packages.map(row => [row.package, JSON.stringify(row)])), differences = []
  for (const row of rows) {
    if (!before.has(row.package)) differences.push('new modified package: ' + row.package)
    else if (before.get(row.package) !== JSON.stringify(row)) differences.push('changed: ' + row.package + ' ' + before.get(row.package) + ' -> ' + JSON.stringify(row))
    before.delete(row.package)
  }
  for (const name of before.keys()) differences.push('no longer in manifest: ' + name)
  for (const key of ['registeredButNotInManifest', 'unregisteredPatchFiles']) {
    if (JSON.stringify(baseline[key]) !== JSON.stringify(report[key])) differences.push(key + ' changed')
  }
  console.log(JSON.stringify({ check: true, baselineAcceptedAt: acceptedAt, differences, ...report.summary }, null, 1))
  if (differences.length) process.exitCode = 1
} else console.log(JSON.stringify(report, null, 1))
