import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

const prod = 'D:/dsh-test'
const root = prod + '/output/window-isolated-live-20261011'
const home = root + '/home'
const id = 'session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a'
const relativeSession = '--D-dsh-test-workspaces-window-large2-20261008--/' + id
const profile = home + '/profiles/web'
const runArg = process.argv.indexOf('--run')
const run = runArg >= 0 ? process.argv[runArg + 1] : process.argv.includes('--resume') ? 'resume' : 'initial'
if (!/^[a-z0-9-]+$/.test(run ?? '')) throw new Error('INVALID_RUN_NAME')
const stateFile = root + (run === 'initial' ? '/state.json' : '/' + run + '-state.json')
const stopFile = root + (run === 'initial' ? '/stop' : '/' + run + '-stop')
const yaml = createRequire(prod + '/home/profiles/web/package.json')('yaml')
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
function productionSignatures() {
  const found = new Map()
  function visit(dir) {
    for (const row of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, row.name)
      if (row.isDirectory()) visit(file)
      else if (/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(row.name) || /^(?:default|session-[a-f0-9-]+)\.json$/.test(row.name)) {
        const stat = fs.statSync(file)
        found.set(file, `${stat.size}:${stat.mtimeMs}`)
      }
    }
  }
  visit(prod + '/home/sessions')
  visit(prod + '/home/team-control-plane')
  return found
}
if (process.argv.includes('--prepare')) {
  if (fs.existsSync(root)) throw new Error('ISOLATED_OUTPUT_EXISTS')
  fs.mkdirSync(profile, { recursive: true })
  fs.symlinkSync(prod + '/app', root + '/app', 'junction')
  fs.symlinkSync(prod + '/home/profiles/web/node_modules', profile + '/node_modules', 'junction')
  for (const name of ['plugins', 'presets']) fs.cpSync(prod + '/home/profiles/web/' + name, profile + '/' + name, { recursive: true })
  for (const name of ['package.json', 'cordis.yml']) fs.copyFileSync(prod + '/home/profiles/web/' + name, profile + '/' + name)
  const remap = text => text.replaceAll('D:\\dsh-test\\home', home.replaceAll('/', '\\'))
    .replaceAll('D:/dsh-test/home', home).replaceAll('file:///D:/dsh-test/home', 'file:///' + home)
  const doc = yaml.parseDocument(remap(fs.readFileSync(prod + '/home/profiles/web/cordis.patch.yml', 'utf8')),
    { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (doc.errors.length) throw doc.errors[0]
  // Only the isolated copy suppresses autonomous scheduling; the fold and admission services stay intact.
  const overrides = ['team-v14-event-continuation', 'team-idle-watch', 'browser-use-stagehand-native']
    .map(id => ({ id, disabled: true }))
  write(profile + '/cordis.patch.yml', remap(fs.readFileSync(prod + '/home/profiles/web/cordis.patch.yml', 'utf8'))
    + '\n' + yaml.stringify(overrides))
  fs.cpSync(prod + '/home/sessions/' + relativeSession, home + '/sessions/' + relativeSession, { recursive: true })
  const control = prod + '/home/team-control-plane'
  const cold = fs.readdirSync(control).filter(name => name === id + '.json' || name.startsWith(id + '.json.cold-'))
  fs.mkdirSync(home + '/team-control-plane', { recursive: true })
  for (const name of cold) fs.copyFileSync(control + '/' + name, home + '/team-control-plane/' + name)
  fs.cpSync(prod + '/home/team-roles', home + '/team-roles', { recursive: true })
  for (const name of ['.credentials.yaml', 'team-milestones.json', 'write-scopes.json', 'team-clearances.json', 'evidence-reducer.json']) {
    if (fs.existsSync(prod + '/home/' + name)) fs.copyFileSync(prod + '/home/' + name, home + '/' + name)
  }
  const workspace = JSON.parse(fs.readFileSync(prod + '/home/storages/workspace.json', 'utf8'))
  const entries = Object.entries(workspace.tables.workspaces).filter(([, row]) => row.sessionIds.includes(id))
  if (entries.length !== 1) throw new Error('ONE_SOURCE_WORKSPACE_REQUIRED')
  const [workspaceId, record] = entries[0]
  workspace.global.workspaceIds = [workspaceId]
  workspace.global.archivedSessionIds = []
  workspace.tables.workspaces = { [workspaceId]: { ...record, sessionIds: [id] } }
  write(home + '/storages/workspace.json', JSON.stringify(workspace))
  write(root + '/prepare.json', JSON.stringify({ id, workspaceId, home, nativeCode: prod + '/app',
    clonedSessionSha256: sha(home + '/sessions/' + relativeSession + '/session.v4.jsonl.zstd'),
    originalSessionSha256: sha(prod + '/home/sessions/' + relativeSession + '/session.v4.jsonl.zstd'),
    coldFilesCopied: cold.length, isolatedDisabledEntries: overrides.map(row => row.id) }, null, 2))
  console.log(fs.readFileSync(root + '/prepare.json', 'utf8'))
} else if (process.argv.includes('--start')) {
  if (!fs.existsSync(root + '/prepare.json') || fs.existsSync(stateFile)) throw new Error('ISOLATED_START_PRECONDITION')
  for (const name of fs.readdirSync(root).filter(name => name === 'state.json' || name.endsWith('-state.json'))) {
    if (JSON.parse(fs.readFileSync(root + '/' + name)).status === 'running') throw new Error('PREVIOUS_HOST_NOT_STOPPED')
  }
  const baseline = productionSignatures()
  write(root + '/' + run + '-production-signatures.json', JSON.stringify([...baseline]))
  const fd = fs.openSync(root + (run === 'initial' ? '/host.log' : '/' + run + '-host.log'), 'wx')
  const host = spawn(process.execPath, [prod + '/app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--no-open', '--port', '40124'],
    { cwd: root, env: { ...process.env, DSH_HOME: home }, windowsHide: true, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  const state = { hostPid: host.pid, home, status: 'running', startedAt: new Date().toISOString(), protectedProductionFiles: baseline.size }
  const save = () => write(stateFile, JSON.stringify(state, null, 2))
  save(); console.log(JSON.stringify(state))
  let stopping = false
  const start = Date.now()
  const stop = (reason, file) => {
    if (stopping) return
    stopping = true; Object.assign(state, { reason, ...(file ? { changedProductionFile: file } : {}) }); save()
    spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  const timer = setInterval(() => {
    try {
      const now = productionSignatures()
      for (const [file, signature] of now) if (baseline.get(file) !== signature) return stop('production-file-changed', file)
      for (const file of baseline.keys()) if (!now.has(file)) return stop('production-file-removed', file)
      if (fs.existsSync(stopFile)) stop('requested-stop')
      else if (Date.now() - start > 30 * 60000) stop('bounded-timeout')
    } catch (error) { stop('guard-error:' + error.message) }
  }, 1000)
  host.on('error', error => { clearInterval(timer); Object.assign(state, { status: 'failed', error: error.message }); save() })
  host.on('exit', (code, signal) => { clearInterval(timer); Object.assign(state, { status: 'stopped', code, signal, stoppedAt: new Date().toISOString() }); save(); console.log(JSON.stringify(state)) })
  process.on('SIGINT', () => stop('controller-interrupted'))
  process.on('SIGTERM', () => stop('controller-terminated'))
} else console.log(JSON.stringify({ root, prepare: '--prepare', start: '--start' }))
