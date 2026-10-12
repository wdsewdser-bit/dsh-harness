// Isolated host for the constraint-ledger team run. Derived from constraint-ledger-impl-20261012/driver/impl-host.mjs.
// usage: node team-host.mjs --prepare --name <n> | --start --name <n> [--run <r>] [--minutes N] [--max-requests N]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'

const prod = 'D:/dsh-test'
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback }
const nameValue = arg('--name')
if (!/^[a-z0-9-]+$/.test(nameValue ?? '')) throw new Error('NAME_REQUIRED')
const root = prod + '/output/constraint-ledger-team-20261012/' + nameValue
const home = root + '/home'
const sandbox = root + '/workspace'
const profile = home + '/profiles/web'
const run = arg('--run', 'initial')
if (!/^[a-z0-9-]+$/.test(run)) throw new Error('INVALID_RUN_NAME')
const minutes = Number(arg('--minutes', '180')), maxRequests = Number(arg('--max-requests', '3000'))
if (!(minutes > 0) || !(maxRequests > 0)) throw new Error('INVALID_LIMIT')
const stateFile = root + (run === 'initial' ? '/state.json' : '/' + run + '-state.json')
const stopFile = root + (run === 'initial' ? '/stop' : '/' + run + '-stop')
const yaml = createRequire(prod + '/home/profiles/web/package.json')('yaml')
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
  const real = prod + '/workspaces/window-large2-20261008'
  for (const file of [real + '/.git/config', real + '/.git/HEAD', real + '/.git/index', real + '/README.md', real + '/index.html', 'C:/Users/yadaz/.gitconfig',
    prod + '/home/profiles/web/cordis.patch.yml', prod + '/home/profiles/web/cordis.yml']) {
    if (fs.existsSync(file)) { const stat = fs.statSync(file); found.set(file, stat.size + ':' + stat.mtimeMs) } else found.set(file, 'absent')
  }
  return found
}
function terminals() {
  const dir = home + '/usage-ledger'
  if (!fs.existsSync(dir)) return 0
  let count = 0
  for (const name of fs.readdirSync(dir).filter(name => name.startsWith('requests-'))) count += fs.readFileSync(dir + '/' + name, 'utf8').split('"event":"terminal"').length - 1
  return count
}

if (process.argv.includes('--prepare')) {
  if (fs.existsSync(root)) throw new Error('ISOLATED_OUTPUT_EXISTS')
  fs.mkdirSync(profile, { recursive: true })
  fs.symlinkSync(prod + '/app', root + '/app', 'junction')
  fs.symlinkSync(prod + '/home/profiles/web/node_modules', profile + '/node_modules', 'junction')
  for (const name of ['plugins', 'presets']) fs.cpSync(prod + '/home/profiles/web/' + name, profile + '/' + name, { recursive: true })
  for (const name of ['package.json', 'cordis.yml']) fs.copyFileSync(prod + '/home/profiles/web/' + name, profile + '/' + name)
  // Tighter than production: writes stay inside the workspace, and anything beyond it still needs a human approval.
  const remap = text => text.replaceAll('D:\\dsh-test\\home', home.replaceAll('/', '\\'))
    .replaceAll('D:/dsh-test/home', home).replaceAll('file:///D:/dsh-test/home', 'file:///' + home)
    .replace('defaultPreset: danger-full-access', 'defaultPreset: workspace-write')
  const source = remap(fs.readFileSync(prod + '/home/profiles/web/cordis.patch.yml', 'utf8'))
  const overrides = ['browser-use-stagehand-native'].map(id => ({ id, disabled: true }))
  const inserts = [{ insert: [
    { id: 'constraint-ledger', name: './plugins/constraint-ledger.mjs', config: { directory: home + '/constraint-ledger' } },
    { id: 'zz-request-dump', name: './plugins/zz-request-dump.mjs', config: { file: root + '/requests.jsonl' } },
  ] }]
  const patched = source + '\n' + yaml.stringify(overrides) + yaml.stringify(inserts)
  const doc = yaml.parseDocument(patched, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
  if (doc.errors.length) throw doc.errors[0]
  if (!patched.includes('defaultPreset: workspace-write') || !/sandbox: workspace-write\s+approval: ask/.test(patched)) throw new Error('PERMISSION_PATCH_FAILED')
  write(profile + '/cordis.patch.yml', patched)
  fs.copyFileSync(prod + '/staging/context-runtime-unified-20261001/home/profiles/web/plugins/constraint-ledger.mjs', profile + '/plugins/constraint-ledger.mjs')
  const dump = fs.readFileSync(prod + '/output/constraint-ledger-impl-20261012/live1/home/profiles/web/plugins/zz-request-dump.mjs', 'utf8')
  if (dump.split('.slice(-700)').length !== 2) throw new Error('DUMP_PLUGIN_SHAPE')
  write(profile + '/plugins/zz-request-dump.mjs', dump.replace('.slice(-700)', '.slice(-2500)'))
  fs.mkdirSync(home + '/sessions', { recursive: true })
  fs.mkdirSync(home + '/team-control-plane', { recursive: true })
  fs.cpSync(prod + '/home/team-roles', home + '/team-roles', { recursive: true })
  for (const name of ['.credentials.yaml', 'team-milestones.json', 'write-scopes.json', 'team-clearances.json', 'evidence-reducer.json']) {
    if (fs.existsSync(prod + '/home/' + name)) fs.copyFileSync(prod + '/home/' + name, home + '/' + name)
  }
  fs.mkdirSync(sandbox, { recursive: true })
  write(sandbox + '/README.md', '# workspace\n')
  const git = (...args) => { const out = spawnSync('git', args, { cwd: sandbox, windowsHide: true, encoding: 'utf8' }); if (out.status !== 0) throw new Error('GIT_FAILED ' + args.join(' ') + ' ' + out.stderr); return out.stdout }
  git('init', '-b', 'main'); git('add', 'README.md')
  git('-c', 'user.name=seed', '-c', 'user.email=seed@team.local', 'commit', '-m', 'seed')
  const workspaceId = 'a5000000-0000-4000-8000-0000000000a5', now = new Date().toISOString()
  write(home + '/storages/workspace.json', JSON.stringify({ unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [workspaceId]: { path: sandbox.replaceAll('/', '\\'), title: path.basename(root), sessionIds: [], createdAt: now, updatedAt: now } } } }))
  write(root + '/prepare.json', JSON.stringify({ workspaceId, home, sandbox, nativeCode: prod + '/app',
    permission: 'workspace-write / approval ask (production preset unchanged)', isolatedDisabledEntries: overrides.map(row => row.id), seed: git('log', '--oneline').trim() }, null, 2))
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
  const state = { hostPid: host.pid, home, status: 'running', startedAt: new Date().toISOString(), protectedProductionFiles: baseline.size, minutes, maxRequests }
  const save = () => write(stateFile, JSON.stringify(state, null, 2))
  save(); console.log(JSON.stringify(state))
  let stopping = false, tick = 0
  const start = Date.now()
  const stop = (reason, file) => {
    if (stopping) return
    stopping = true; Object.assign(state, { reason, ...(file ? { changedProductionFile: file } : {}) }); save()
    spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  const timer = setInterval(() => {
    try {
      tick += 1
      if (fs.existsSync(stopFile)) return stop('requested-stop')
      if (Date.now() - start > minutes * 60000) return stop('bounded-timeout')
      if (tick % 15 === 0 && terminals() > maxRequests) return stop('request-cap')
      // The production tree is large; a full signature pass every five seconds is enough to catch a stray write.
      if (tick % 5) return
      const now = productionSignatures()
      for (const [file, signature] of now) if (baseline.get(file) !== signature) return stop('production-file-changed', file)
      for (const file of baseline.keys()) if (!now.has(file)) return stop('production-file-removed', file)
    } catch (error) { stop('guard-error:' + error.message) }
  }, 1000)
  host.on('error', error => { clearInterval(timer); Object.assign(state, { status: 'failed', error: error.message }); save() })
  host.on('exit', (code, signal) => { clearInterval(timer); Object.assign(state, { status: 'stopped', code, signal, stoppedAt: new Date().toISOString(), terminals: terminals() }); save(); console.log(JSON.stringify(state)) })
  process.on('SIGINT', () => stop('controller-interrupted'))
  process.on('SIGTERM', () => stop('controller-terminated'))
} else console.log(JSON.stringify({ root, prepare: '--prepare', start: '--start' }))
