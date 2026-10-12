// Deploy the staged change set to the production tree, with a verified backup and a one-command rollback.
//   node tools/deploy-production.mjs --plan                     report the change set and every precondition; writes nothing
//   node tools/deploy-production.mjs --apply --backup <dir>     back up every target, copy, verify; rolls itself back on any failure
//   node tools/deploy-production.mjs --rollback <dir>           restore exactly what --apply replaced and remove what it added
// It copies files only. It does not edit cordis.patch.yml, start or stop anything, or enable any feature.
// --apply refuses to run while the production host is listening, or if any production file is not at its recorded
// "before" state: a target that drifted since the manifests were written is somebody else's change, not ours to overwrite.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const stage = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const prod = path.resolve(stage, '../..')
const PRODUCTION_PORT = 40123
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
const rel = file => path.relative(prod, file).replaceAll('\\', '/')
const fail = message => { console.error('DEPLOY_REFUSED ' + message); process.exit(1) }
const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const inside = (file, root) => path.resolve(file).toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep)

function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => resolve(false))
  })
}

/**
 * The other physical copies of an installed package. pnpm hard-links one package into several directories (its
 * .pnpm entry and each profile's own node_modules), and plugins resolve packages from the profile copy. A file we
 * replace in place reaches every copy through the shared inode; a file we ADD, or one that an earlier patch already
 * unlinked, does not. So every copy is brought to the same state explicitly.
 */
function packageCopies(packageRoot) {
  const copies = new Set()
  const manifest = path.join(packageRoot, 'package.json')
  if (process.platform === 'win32' && fs.existsSync(manifest)) {
    const listed = execFileSync('fsutil', ['hardlink', 'list', manifest], { encoding: 'utf8' }).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    for (const link of listed) {
      const directory = path.dirname(path.resolve(path.parse(manifest).root, '.' + link))
      // The content-addressed store holds loose files, not package directories.
      if (inside(directory, prod) && !directory.toLowerCase().includes(path.sep + '.pnpm-store' + path.sep)) copies.add(directory)
    }
  }
  for (const profile of ['web', 'headless']) {
    const directory = path.join(prod, 'home/profiles', profile, 'node_modules/@deepseek-ai', path.basename(packageRoot))
    if (fs.existsSync(directory)) copies.add(fs.realpathSync(directory))
  }
  copies.delete(path.resolve(packageRoot)); copies.delete(fs.existsSync(packageRoot) ? fs.realpathSync(packageRoot) : packageRoot)
  return [...copies]
}

/** Every file to copy: where it comes from, where it lands, and what production must hold right now. */
function changeSet() {
  const items = []
  const native = JSON.parse(fs.readFileSync(path.join(stage, 'native-change-manifest.json'), 'utf8'))
  for (const entry of native) {
    const source = path.resolve(entry.path)
    // Staged "-v15" packages are the next version of the package of the same name without the suffix.
    const mirrored = path.join(prod, path.relative(stage, source)).replace(/([\\/]@deepseek-ai[\\/][^\\/]+)-v15([\\/])/, '$1$2')
    const target = path.resolve(entry.deploymentPath ?? mirrored)
    items.push({ group: 'native', source, target, before: entry.before, after: entry.after })
    const scoped = target.match(/^(.*[\\/]@deepseek-ai[\\/][^\\/]+)[\\/](.+)$/)
    if (scoped) for (const copy of packageCopies(scoped[1])) {
      items.push({ group: 'native-copy', source, target: path.join(copy, scoped[2]), before: entry.before, after: entry.after, copy: true, lineageTarget: target })
    }
  }
  const plugins = JSON.parse(fs.readFileSync(path.join(stage, 'plugin-change-manifest.json'), 'utf8'))
  for (const entry of plugins) {
    const source = path.resolve(entry.path)
    items.push({ group: 'plugin-web', source, target: path.join(prod, 'home/profiles/web/plugins', entry.name), before: entry.before, after: entry.after })
    const headless = path.join(stage, 'home/profiles/headless/plugins', entry.name)
    // The same lineage on both profiles: the headless target must hold what web held before, or not exist yet.
    if (fs.existsSync(headless)) items.push({ group: 'plugin-headless', source: headless, target: path.join(prod, 'home/profiles/headless/plugins', entry.name), before: entry.before, after: entry.after })
  }
  const roles = path.join(stage, 'home/team-roles')
  for (const name of fs.readdirSync(roles).filter(file => /\.(md|json)$/.test(file))) {
    const source = path.join(roles, name), target = path.join(prod, 'home/team-roles', name)
    // Role files carry no manifest entry: production's current content is recorded at plan time and backed up.
    items.push({ group: 'roles', source, target, before: fs.existsSync(target) ? sha(target) : null, after: sha(source), unpinned: true })
  }
  return items
}

// --previous <dir>[,<dir>...]: earlier deploy backups, oldest first; the last record of a target wins.
const previouslyDeployed = new Map()
for (const directory of (argument('--previous') ?? '').split(',').filter(Boolean)) {
  for (const row of JSON.parse(fs.readFileSync(path.join(path.resolve(directory), 'deploy-backup.json'), 'utf8')).files) {
    previouslyDeployed.set(row.target.toLowerCase(), row.afterSha256)
  }
}

function inspect(items) {
  const problems = []
  for (const item of items) {
    if (!fs.existsSync(item.source)) { problems.push(`source missing: ${item.source}`); continue }
    if (!inside(fs.realpathSync(item.source), stage)) problems.push(`source resolves outside the stage: ${item.source}`)
    if (sha(item.source) !== String(item.after).toUpperCase()) problems.push(`stage drift (run stage-closeout): ${path.relative(stage, item.source)}`)
    if (!inside(item.target, prod) || inside(item.target, path.join(prod, 'staging'))) problems.push(`target outside production: ${item.target}`)
    const parent = path.dirname(item.target)
    if (fs.existsSync(parent) && !inside(fs.realpathSync(parent), prod)) problems.push(`target directory resolves outside production: ${rel(item.target)}`)
    item.exists = fs.existsSync(item.target)
    item.current = item.exists ? sha(item.target) : null
    item.state = item.current === String(item.after).toUpperCase() ? 'already-deployed'
      : !item.exists && item.copy ? 'new'
      : item.before === null ? (item.exists ? 'unexpected-existing-file' : 'new')
        : item.current === String(item.before).toUpperCase() ? 'replace' : item.exists ? 'drifted' : 'missing-in-production'
    // A file we deployed ourselves earlier is ours to replace again: its current content must be exactly what that
    // earlier deployment wrote, as recorded in the backup directories named with --previous.
    if (['unexpected-existing-file', 'drifted'].includes(item.state) && previouslyDeployed.get(rel(item.target).toLowerCase()) === item.current) item.state = 'replace'
    // A package copy may have received the earlier write through a hard link without its own backup row.
    // Accept only the exact previously recorded canonical hash, never an arbitrary current copy hash.
    if (item.copy && item.lineageTarget && ['unexpected-existing-file', 'drifted'].includes(item.state)
      && previouslyDeployed.get(rel(item.lineageTarget).toLowerCase()) === item.current) item.state = 'replace'
    if (['unexpected-existing-file', 'drifted', 'missing-in-production'].includes(item.state)) {
      problems.push(`${item.state}: ${rel(item.target)} (production ${String(item.current).slice(0, 8)}, expected before ${String(item.before).slice(0, 8)})`)
    }
  }
  // Two entries must never land on one file, and a junction must not make us write the same file twice.
  const seen = new Map()
  for (const item of items) {
    const key = (fs.existsSync(path.dirname(item.target)) ? path.join(fs.realpathSync(path.dirname(item.target)), path.basename(item.target)) : item.target).toLowerCase()
    if (seen.has(key)) problems.push(`two entries land on one file: ${rel(item.target)}`)
    seen.set(key, item)
  }
  return problems
}

function summary(items) {
  const count = {}
  for (const item of items) { count[item.group] ??= {}; count[item.group][item.state] = (count[item.group][item.state] ?? 0) + 1 }
  return count
}

function rollback(directory) {
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'deploy-backup.json'), 'utf8'))
  const outcome = { restored: 0, removed: 0, problems: [] }
  for (const row of record.files) {
    const target = path.join(prod, row.target)
    try {
      if (row.existed) {
        const saved = path.join(directory, 'files', row.target)
        if (sha(saved) !== row.beforeSha256) throw new Error('backup copy is damaged')
        fs.copyFileSync(saved, target)
        if (sha(target) !== row.beforeSha256) throw new Error('restore did not verify')
        outcome.restored++
      } else if (fs.existsSync(target)) { fs.rmSync(target); outcome.removed++ }
    } catch (error) { outcome.problems.push(`${row.target}: ${error.message}`) }
  }
  return outcome
}

const mode = ['--plan', '--apply', '--rollback'].find(flag => process.argv.includes(flag)) ?? '--plan'
if (mode === '--rollback') {
  const directory = path.resolve(argument('--rollback') ?? '')
  if (!fs.existsSync(path.join(directory, 'deploy-backup.json'))) fail('no deploy-backup.json in ' + directory)
  if (await listening(PRODUCTION_PORT)) fail(`production host is listening on ${PRODUCTION_PORT}: stop it before restoring files`)
  const outcome = rollback(directory)
  console.log(JSON.stringify(outcome, null, 1))
  process.exit(outcome.problems.length ? 1 : 0)
}

const items = changeSet(), problems = inspect(items)
const running = await listening(PRODUCTION_PORT)
const pending = items.filter(item => item.state === 'replace' || item.state === 'new')
console.log(JSON.stringify({ mode, production: prod, productionHostListening: running, files: items.length, toWrite: pending.length, byGroup: summary(items), problems }, null, 1))
if (mode === '--plan') {
  if (process.argv.includes('--list')) for (const item of items) console.log(`${item.state.padEnd(16)} ${item.group.padEnd(15)} ${rel(item.target)}`)
  process.exit(problems.length ? 1 : 0)
}

// --apply
if (problems.length) fail('preconditions failed; nothing was written')
// --hot: the user asked for a live reload. The host picks the changed plugin up through HMR; rollback still needs it stopped.
if (running && !process.argv.includes('--hot')) fail(`production host is listening on ${PRODUCTION_PORT}; files are only replaced while it is stopped (or pass --hot)`)
const backup = path.resolve(argument('--backup') ?? '')
if (!argument('--backup') || fs.existsSync(backup)) fail('--backup must name a directory that does not exist yet')
if (inside(backup, path.join(prod, 'home')) || inside(backup, path.join(prod, 'app'))) fail('the backup directory must not live inside the tree being changed')
fs.mkdirSync(path.join(backup, 'files'), { recursive: true })
const record = { createdAt: new Date().toISOString(), production: prod, stage, files: [] }
for (const item of pending) {
  const row = { target: rel(item.target), group: item.group, existed: item.exists, beforeSha256: item.current, afterSha256: String(item.after).toUpperCase() }
  if (item.exists) {
    const saved = path.join(backup, 'files', row.target)
    fs.mkdirSync(path.dirname(saved), { recursive: true })
    fs.copyFileSync(item.target, saved)
    if (sha(saved) !== item.current) fail('backup did not verify for ' + row.target + '; nothing was written')
  }
  record.files.push(row)
}
fs.writeFileSync(path.join(backup, 'deploy-backup.json'), JSON.stringify(record, null, 1) + '\n')
try {
  for (const item of pending) {
    fs.mkdirSync(path.dirname(item.target), { recursive: true })
    fs.copyFileSync(item.source, item.target)
    if (sha(item.target) !== String(item.after).toUpperCase()) throw new Error('copy did not verify: ' + rel(item.target))
  }
} catch (error) {
  const outcome = rollback(backup)
  fail(`${error.message}; rolled back (${outcome.restored} restored, ${outcome.removed} removed, ${outcome.problems.length} problems)`)
}
console.log(JSON.stringify({ applied: pending.length, backup, rollback: `node tools/deploy-production.mjs --rollback ${backup}` }, null, 1))
