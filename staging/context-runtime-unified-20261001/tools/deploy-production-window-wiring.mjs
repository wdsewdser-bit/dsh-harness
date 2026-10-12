// Wires the durable-window executor into the production web profile, for the sessions named on the command line only.
//   node tools/deploy-production-window-wiring.mjs --plan  --sessions <id>[,<id>...]
//   node tools/deploy-production-window-wiring.mjs --apply --sessions <id>[,<id>...] --backup <new dir>
//   node tools/deploy-production-window-wiring.mjs --rollback <dir>
// Three text-level edits, each idempotent:
//   1. the team-v15-window-wiring plugin entry (scope: list) after the window-manager entry; running again with a
//      different --sessions replaces the list;
//   2. windowAdmission / windowHostParticipation / windowOsFileProtection on team-v12-runtime. They only take effect
//      for a session the wiring admits;
//   3. proactiveFoldTokens on step-compaction: the "at or above 500k, fold at the next idle boundary" rule.
// `--sessions none` writes the entry with scope off (protection of existing windows only).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'

const prod = 'D:/dsh-test', record = 'window-wiring-config-backup.json'
const files = ['home/profiles/web/cordis.patch.yml', 'home/profiles/headless/cordis.patch.yml']
const sha = text => createHash('sha256').update(text).digest('hex').toUpperCase()
const fail = message => { console.error('CONFIG_REFUSED ' + message); process.exit(1) }
const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const listening = port => new Promise(resolve => {
  const socket = net.connect({ port, host: '127.0.0.1' })
  socket.setTimeout(1500)
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('timeout', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => resolve(false))
})
const sessionsArg = argument('--sessions')
const sessions = sessionsArg === undefined || sessionsArg === 'none' ? [] : sessionsArg.split(',').map(id => id.trim()).filter(Boolean)
if (sessions.some(id => !/^[A-Za-z0-9._:-]+$/.test(id))) fail('session ids may only contain letters, digits, . _ : -')
// --workspaces <folder>[,<folder>...]: Team roots working in these folders are in scope too (list scope only).
const workspaces = (argument('--workspaces') ?? '').split(',').map(value => value.trim()).filter(Boolean)
if (workspaces.some(value => /['\r\n]/.test(value))) fail('workspace folders may not contain quotes or line breaks')

function wiringBlock(eol) {
  return ['- insert:', '    - id: team-v15-window-wiring', "      name: './plugins/team-v15-window-wiring.mjs'", '      config:',
    '        # Durable window folding. Sessions that already hold a window are always protected; new folds happen only',
    '        # for the sessions listed here. Do not widen the scope without a decision: team-roots covers every Team root.',
    `        enabled: ${sessions.length ? 'true' : 'false'}`, `        scope: ${sessions.length ? 'list' : 'off'}`,
    ...(sessions.length ? ['        sessions:', ...sessions.map(id => `          - '${id}'`)] : []),
    ...(sessions.length && workspaces.length ? ['        workspaces:', ...workspaces.map(value => `          - '${value}'`)] : []),
    "        logFile: 'D:\\dsh-test\\home\\window-decisions\\wiring.jsonl'",
    '        allowedRoots:', "          - 'D:\\dsh-test\\home'",
    "        recoveryDirectory: 'D:\\dsh-test\\home\\window-recovery'",
    "        controlDirectory: 'D:\\dsh-test\\home\\team-control-plane'", ''].join(eol)
}
// The config block of one plugin entry: [first line after `config:`, first line past the block).
function configRange(lines, pluginName) {
  const at = lines.findIndex(line => new RegExp(`name:\\s*'\\./plugins/${pluginName.replace('.', '\\.')}'`).test(line))
  if (at < 0) return null
  const indent = lines[at].match(/^\s*/)[0].length
  let config = -1, end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() && line.match(/^\s*/)[0].length <= indent - 2) { end = i; break }
    if (config < 0 && /^\s*config:\s*\r?$/.test(line) && line.match(/^\s*/)[0].length === indent) config = i
  }
  return config < 0 ? null : { config, end, keyIndent: ' '.repeat(indent + 2) }
}
function setKeys(lines, pluginName, pairs, comment) {
  const range = configRange(lines, pluginName)
  if (!range) fail('config block not found: ' + pluginName)
  const cr = lines[range.config].endsWith('\r') ? '\r' : ''
  let changed = 0
  const missing = []
  for (const [key, value] of pairs) {
    const at = lines.slice(range.config + 1, range.end).findIndex(line => new RegExp(`^${range.keyIndent}${key}:`).test(line))
    if (at < 0) { missing.push(`${range.keyIndent}${key}: ${value}${cr}`); continue }
    const index = range.config + 1 + at, wanted = `${range.keyIndent}${key}: ${value}${cr}`
    if (lines[index] !== wanted) { lines[index] = wanted; changed++ }
  }
  if (missing.length) { lines.splice(range.config + 1, 0, `${range.keyIndent}# ${comment}${cr}`, ...missing); changed += missing.length }
  return changed
}
// The window itself is wired into the web profile only; the headless profile gets the size rule and nothing else.
function edit(text, file) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let next = text, changed = 0
  if (file.includes('/headless/')) {
    const only = next.split('\n')
    changed += setKeys(only, 'step-compaction-v4.mjs', [['proactiveFoldTokens', '500000']],
      'At or above this size the next idle boundary folds the context even with no finished phase.')
    return { text: only.join('\n'), changed }
  }
  const existing = /- insert:\r?\n    - id: team-v15-window-wiring\r?\n(?:[ \t]+[^\r\n]*\r?\n)+/
  if (existing.test(next)) {
    const replaced = next.replace(existing, () => wiringBlock(eol))
    if (replaced !== next) { next = replaced; changed++ }
  } else {
    const anchor = /(- insert:\r?\n    - id: team-v15-window-manager\r?\n(?:[ \t]+[^\r\n]*\r?\n)+)\r?\n/
    if ((next.match(new RegExp(anchor.source, 'g')) ?? []).length !== 1) fail('window-manager entry not found exactly once')
    next = next.replace(anchor, whole => whole + wiringBlock(eol) + eol)
    changed++
  }
  const lines = next.split('\n')
  changed += setKeys(lines, 'team-v12-runtime.mjs', [['windowAdmission', 'runtime'], ['windowHostParticipation', 'true'], ['windowOsFileProtection', 'true']],
    'Window admission by the wiring plugin. Only a session it admits is affected.')
  changed += setKeys(lines, 'step-compaction-v4.mjs', [['proactiveFoldTokens', '500000']],
    'At or above this size the next idle boundary folds the context even with no finished phase.')
  return { text: lines.join('\n'), changed }
}

const mode = ['--plan', '--apply', '--rollback'].find(flag => process.argv.includes(flag)) ?? '--plan'
if (mode !== '--plan' && await listening(40123)) fail('production host is listening on 40123')
if (mode === '--rollback') {
  const directory = path.resolve(argument('--rollback') ?? ''), saved = JSON.parse(fs.readFileSync(path.join(directory, record), 'utf8'))
  for (const row of saved.files) {
    const before = fs.readFileSync(path.join(directory, 'window-wiring-config', row.file))
    if (sha(before) !== row.beforeSha256) fail('backup copy is damaged: ' + row.file)
    fs.writeFileSync(path.join(prod, row.file), before)
  }
  console.log(JSON.stringify({ restored: saved.files.map(row => row.file) }))
  process.exit(0)
}
if (sessionsArg === undefined) fail('--sessions <id,...> (or none) is required')
const planned = files.map(file => {
  const target = path.join(prod, file), before = fs.readFileSync(target, 'utf8'), result = edit(before, file)
  return { file, target, before, after: result.text, changed: result.changed }
})
console.log(JSON.stringify(planned.map(row => ({ file: row.file, changed: row.changed, addedLines: row.after.split('\n').length - row.before.split('\n').length })), null, 1))
if (mode === '--plan') { if (process.argv.includes('--show')) console.log(planned[0].after); process.exit(0) }
const backup = path.resolve(argument('--backup') ?? '')
if (!argument('--backup') || fs.existsSync(backup)) fail('--backup must name a new directory')
const saved = { createdAt: new Date().toISOString(), sessions, files: [] }
for (const row of planned.filter(item => item.changed)) {
  const copy = path.join(backup, 'window-wiring-config', row.file)
  fs.mkdirSync(path.dirname(copy), { recursive: true })
  fs.writeFileSync(copy, row.before)
  if (sha(fs.readFileSync(copy, 'utf8')) !== sha(row.before)) fail('backup did not verify: ' + row.file)
  saved.files.push({ file: row.file, beforeSha256: sha(row.before), afterSha256: sha(row.after) })
}
fs.mkdirSync(backup, { recursive: true })
fs.writeFileSync(path.join(backup, record), JSON.stringify(saved, null, 1) + '\n')
for (const row of planned.filter(item => item.changed)) {
  fs.writeFileSync(row.target, row.after)
  if (sha(fs.readFileSync(row.target, 'utf8')) !== sha(row.after)) fail('write did not verify: ' + row.file)
}
console.log(JSON.stringify({ applied: saved.files.map(row => row.file), sessions, rollback: `node tools/deploy-production-window-wiring.mjs --rollback ${backup}` }))
