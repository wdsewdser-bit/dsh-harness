// Isolated host for the strict-plan-delivery live run. Derived from constraint-ledger-team-20261012/driver/team-host.mjs.
// usage: node plan-host.mjs --prepare --name <n> --strict on|off
//        node plan-host.mjs --start --name <n> [--run <r>] [--minutes N] [--max-requests N]
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const prod = 'D:/dsh-test'
const staging = prod + '/staging/context-runtime-unified-20261001'
const outputRoot = prod + '/output/strict-plan-live-20261012'
const arg = (name, fallback) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : fallback }
const nameValue = arg('--name')
if (!/^[a-z0-9-]+$/.test(nameValue ?? '')) throw new Error('NAME_REQUIRED')
const root = outputRoot + '/' + nameValue
const home = root + '/home'
const sandbox = root + '/workspace'
const profile = home + '/profiles/web'
const run = arg('--run', 'initial')
if (!/^[a-z0-9-]+$/.test(run)) throw new Error('INVALID_RUN_NAME')
const minutes = Number(arg('--minutes', '60')), maxRequests = Number(arg('--max-requests', '200'))
if (!(minutes > 0) || !(maxRequests > 0)) throw new Error('INVALID_LIMIT')
const stateFile = root + (run === 'initial' ? '/state.json' : '/' + run + '-state.json')
const stopFile = root + (run === 'initial' ? '/stop' : '/' + run + '-stop')
const yaml = createRequire(prod + '/home/profiles/web/package.json')('yaml')
const yamlTags = [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }]
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()

// Every write is resolved through realpath first: a target that lands outside the output directory (for example through a junction to production) is refused.
const norm = text => path.resolve(text).replaceAll('\\', '/').toLowerCase()
function assertInside(target) {
  let existing = path.resolve(target), tail = []
  while (!fs.existsSync(existing)) { tail.unshift(path.basename(existing)); existing = path.dirname(existing) }
  const real = norm(path.join(fs.realpathSync(existing), ...tail))
  const base = norm(fs.realpathSync(outputRoot))
  if (real !== base && !real.startsWith(base + '/')) throw new Error('WRITE_OUTSIDE_OUTPUT ' + target + ' -> ' + real)
}
const write = (file, value) => { assertInside(path.dirname(file)); fs.mkdirSync(path.dirname(file), { recursive: true }); assertInside(file); fs.writeFileSync(file, value) }
const copyFile = (from, to) => { assertInside(path.dirname(to)); fs.mkdirSync(path.dirname(to), { recursive: true }); assertInside(to); fs.copyFileSync(from, to) }
const copyTree = (from, to) => { assertInside(to); fs.cpSync(from, to, { recursive: true }) }

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
  const nativeFiles = ['dsh-goal', 'dsh-session-persistence-jsonl', 'dsh-session'].map(name => prod + '/app/node_modules/@deepseek-ai/' + name + '/lib/index.js')
  for (const file of [real + '/.git/config', real + '/.git/HEAD', real + '/.git/index', real + '/README.md', real + '/index.html', 'C:/Users/yadaz/.gitconfig',
    prod + '/home/profiles/web/cordis.patch.yml', prod + '/home/profiles/web/cordis.yml', ...nativeFiles]) {
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
function entriesById(node, id, found = []) {
  if (Array.isArray(node)) for (const item of node) entriesById(item, id, found)
  else if (node && typeof node === 'object') {
    if (node.id === id) found.push(node)
    for (const value of Object.values(node)) entriesById(value, id, found)
  }
  return found
}

const overlayPlugins = ['team-v15-delivery-service.mjs', 'team-v15-delivery-presentation.mjs', 'team-v15-goal-delivery.mjs', 'session-plan-delivery.mjs', 'team-v12-runtime.mjs', 'team-tools-v2-r10.mjs']
const overlayNative = ['dsh-goal', 'dsh-session-persistence-jsonl', 'dsh-session'].map(name => '@deepseek-ai/' + name + '/lib/index.js')

if (process.argv.includes('--prepare')) {
  const strict = arg('--strict')
  if (strict !== 'on' && strict !== 'off') throw new Error('STRICT_REQUIRED_on_or_off')
  if (fs.existsSync(root)) throw new Error('ISOLATED_OUTPUT_EXISTS')
  assertInside(profile)
  fs.mkdirSync(profile, { recursive: true })
  fs.symlinkSync(prod + '/app', root + '/app', 'junction')
  fs.symlinkSync(prod + '/home/profiles/web/node_modules', profile + '/node_modules', 'junction')
  for (const name of ['plugins', 'presets']) copyTree(prod + '/home/profiles/web/' + name, profile + '/' + name)
  for (const name of ['package.json', 'cordis.yml']) copyFile(prod + '/home/profiles/web/' + name, profile + '/' + name)
  // Staging plugins replace the copied production ones; both hashes are recorded.
  const overlaid = overlayPlugins.map(name => {
    const target = profile + '/plugins/' + name
    if (!fs.existsSync(target)) throw new Error('OVERLAY_TARGET_MISSING ' + name)
    const before = sha(target), productionSha = sha(prod + '/home/profiles/web/plugins/' + name)
    copyFile(staging + '/home/profiles/web/plugins/' + name, target)
    const after = sha(target), stagingSha = sha(staging + '/home/profiles/web/plugins/' + name)
    if (before !== productionSha || after !== stagingSha) throw new Error('OVERLAY_HASH_MISMATCH ' + name)
    return { file: name, beforeSha256: before, afterSha256: after, changed: before !== after }
  })
  // Tighter than production: writes stay inside the workspace, and anything beyond it still needs a human approval.
  const remap = text => text.replaceAll('D:\\dsh-test\\home', home.replaceAll('/', '\\'))
    .replaceAll('D:/dsh-test/home', home).replaceAll('file:///D:/dsh-test/home', 'file:///' + home)
    .replace('defaultPreset: danger-full-access', 'defaultPreset: workspace-write')
  let source = remap(fs.readFileSync(prod + '/home/profiles/web/cordis.patch.yml', 'utf8'))
  // Production already carries the constraint-ledger entry; it is not appended again.
  const original = yaml.parseDocument(source, { customTags: yamlTags })
  if (original.errors.length) throw original.errors[0]
  if (entriesById(original.toJS(), 'constraint-ledger').length !== 1) throw new Error('CONSTRAINT_LEDGER_ENTRY_NOT_UNIQUE_IN_PRODUCTION')
  if (entriesById(original.toJS(), 'team-v12-runtime').length !== 1) throw new Error('TEAM_V12_ENTRY_NOT_UNIQUE')
  if (strict === 'on') {
    const needle = "    - id: team-v12-runtime\n      name: './plugins/team-v12-runtime.mjs'\n      config:\n"
    if (source.split(needle).length !== 2) throw new Error('TEAM_V12_ENTRY_TEXT_SHAPE')
    source = source.replace(needle, needle + '        deliveryPolicy:\n          requirePlan: true\n')
  }
  const overrides = ['browser-use-stagehand-native'].map(id => ({ id, disabled: true }))
  const inserts = [{ insert: [
    { id: 'zz-request-dump', name: './plugins/zz-request-dump.mjs', config: { file: root + '/requests.jsonl' } },
  ] }]
  const patched = source + '\n' + yaml.stringify(overrides) + yaml.stringify(inserts)
  const doc = yaml.parseDocument(patched, { customTags: yamlTags })
  if (doc.errors.length) throw doc.errors[0]
  if (!patched.includes('defaultPreset: workspace-write') || !/sandbox: workspace-write\s+approval: ask/.test(patched)) throw new Error('PERMISSION_PATCH_FAILED')
  write(profile + '/cordis.patch.yml', patched)
  // Re-read the written copy and assert the effective team-v12-runtime policy.
  const written = yaml.parseDocument(fs.readFileSync(profile + '/cordis.patch.yml', 'utf8'), { customTags: yamlTags })
  if (written.errors.length) throw written.errors[0]
  const runtimeEntries = entriesById(written.toJS(), 'team-v12-runtime')
  if (runtimeEntries.length !== 1) throw new Error('TEAM_V12_ENTRY_COUNT_IN_COPY ' + runtimeEntries.length)
  const policy = runtimeEntries[0].config?.deliveryPolicy
  if (strict === 'on' ? policy?.requirePlan !== true : (policy && 'requirePlan' in policy)) throw new Error('STRICT_CONFIG_ASSERT_FAILED ' + JSON.stringify(policy))
  const ledgerEntries = entriesById(written.toJS(), 'constraint-ledger'), dumpEntries = entriesById(written.toJS(), 'zz-request-dump')
  if (ledgerEntries.length !== 1 || dumpEntries.length !== 1) throw new Error('LEDGER_OR_DUMP_ENTRY_COUNT')
  const dump = fs.readFileSync(prod + '/output/constraint-ledger-impl-20261012/live1/home/profiles/web/plugins/zz-request-dump.mjs', 'utf8')
  if (dump.split('.slice(-700)').length !== 2) throw new Error('DUMP_PLUGIN_SHAPE')
  write(profile + '/plugins/zz-request-dump.mjs', dump.replace('.slice(-700)', '.slice(-2500)'))
  // The copied plugins/presets must contain no link back to production.
  const links = []
  const scan = dir => { for (const row of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, row.name); if (row.isSymbolicLink()) links.push(file); else if (row.isDirectory()) scan(file) } }
  scan(profile + '/plugins'); scan(profile + '/presets')
  if (links.length) throw new Error('LINKS_IN_COPY ' + links.join(','))
  fs.mkdirSync(home + '/sessions', { recursive: true })
  fs.mkdirSync(home + '/team-control-plane', { recursive: true })
  copyTree(prod + '/home/team-roles', home + '/team-roles')
  for (const name of ['.credentials.yaml', 'team-milestones.json', 'write-scopes.json', 'team-clearances.json', 'evidence-reducer.json']) {
    if (fs.existsSync(prod + '/home/' + name)) copyFile(prod + '/home/' + name, home + '/' + name)
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
  write(root + '/prepare.json', JSON.stringify({ workspaceId, home, sandbox, nativeCode: prod + '/app', strict,
    strictConfig: { teamV12RuntimeDeliveryPolicy: policy ?? null, assertion: strict === 'on' ? 'config.deliveryPolicy.requirePlan === true' : 'no requirePlan in config.deliveryPolicy' },
    constraintLedger: 'production cordis.patch.yml already carries the entry; not appended',
    overlaidPlugins: overlaid,
    nativeOverlay: { mechanism: 'driver/native-overlay.mjs via NODE_OPTIONS --import at --start (production files are not written)', files: overlayNative.map(rel => ({ file: rel, productionSha256: sha(prod + '/app/node_modules/' + rel), stagingSha256: sha(staging + '/app/node_modules/' + rel) })),
      notOverlaid: ['@deepseek-ai/dsh-client-ui-chat/lib/client.js (browser-side static bundle)'] },
    permission: 'workspace-write / approval ask (production preset unchanged)', isolatedDisabledEntries: overrides.map(row => row.id), seed: git('log', '--oneline').trim() }, null, 2))
  console.log(fs.readFileSync(root + '/prepare.json', 'utf8'))
} else if (process.argv.includes('--start')) {
  if (!fs.existsSync(root + '/prepare.json') || fs.existsSync(stateFile)) throw new Error('ISOLATED_START_PRECONDITION')
  for (const name of fs.readdirSync(root).filter(name => name === 'state.json' || name.endsWith('-state.json'))) {
    if (JSON.parse(fs.readFileSync(root + '/' + name)).status === 'running') throw new Error('PREVIOUS_HOST_NOT_STOPPED')
  }
  const baseline = productionSignatures()
  write(root + '/' + run + '-production-signatures.json', JSON.stringify([...baseline]))
  const logFile = root + (run === 'initial' ? '/host.log' : '/' + run + '-host.log')
  const overlayLog = root + '/overlay-' + run + '.log'
  const fd = fs.openSync(logFile, 'wx')
  const overlayImport = '--import=' + pathToFileURL(path.resolve(import.meta.dirname, 'native-overlay.mjs')).href
  // A CLI flag reaches the host and its worker threads only. NODE_OPTIONS also reached every node process the model started inside the sandbox.
  const nodeOptions = overlayImport
  const host = spawn(process.execPath, [overlayImport, prod + '/app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--no-open', '--port', '40124'],
    { cwd: root, env: { ...process.env, DSH_HOME: home, STRICT_PLAN_OVERLAY_LOG: overlayLog }, windowsHide: true, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  const state = { hostPid: host.pid, home, status: 'running', startedAt: new Date().toISOString(), protectedProductionFiles: baseline.size, minutes, maxRequests, nodeOptions, overlayLog }
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
      // A plugin that fails to import leaves the host running without it; a run in that state validates nothing.
      if (tick <= 60 && tick % 5 === 0 && fs.readFileSync(logFile, 'utf8').includes('failed to import')) return stop('plugin-import-failed')
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
} else console.log(JSON.stringify({ root, prepare: '--prepare --strict on|off', start: '--start' }))
