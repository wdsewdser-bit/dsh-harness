// Adds the shadow window-manager plugin entry to both production profiles (text-level, after the usage-ledger entry).
//   node tools/deploy-production-window-manager.mjs --plan
//   node tools/deploy-production-window-manager.mjs --apply --backup <existing dir without window-manager-config-backup.json>
//   node tools/deploy-production-window-manager.mjs --rollback <dir>
// The plugin only records what the fold rule would decide; it folds nothing and registers no tool.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'

const prod = 'D:/dsh-test', record = 'window-manager-config-backup.json'
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
function edit(text) {
  if (text.includes("./plugins/team-v15-window-manager.mjs")) return { text, changed: false }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const anchor = /(- insert:\r?\n    - id: request-usage-ledger\r?\n(?:[ \t]+[^\r\n]*\r?\n)+)\r?\n/
  if ((text.match(new RegExp(anchor.source, 'g')) ?? []).length !== 1) fail('usage-ledger entry not found exactly once')
  const block = ['- insert:', '    - id: team-v15-window-manager', "      name: './plugins/team-v15-window-manager.mjs'", '      config:',
    '        # Records what the fold rule would decide after each main request. It folds nothing.', '        mode: shadow',
    "        directory: 'D:\\dsh-test\\home\\window-decisions'", ''].join(eol)
  return { text: text.replace(anchor, whole => whole + block + eol), changed: true }
}
const mode = ['--plan', '--apply', '--rollback'].find(flag => process.argv.includes(flag)) ?? '--plan'
if (mode !== '--plan' && await listening(40123)) fail('production host is listening on 40123')
if (mode === '--rollback') {
  const directory = path.resolve(argument('--rollback') ?? ''), saved = JSON.parse(fs.readFileSync(path.join(directory, record), 'utf8'))
  for (const row of saved.files) {
    const before = fs.readFileSync(path.join(directory, 'window-manager-config', row.file))
    if (sha(before) !== row.beforeSha256) fail('backup copy is damaged: ' + row.file)
    fs.writeFileSync(path.join(prod, row.file), before)
  }
  console.log(JSON.stringify({ restored: saved.files.map(row => row.file) }))
  process.exit(0)
}
const planned = files.map(file => {
  const target = path.join(prod, file), before = fs.readFileSync(target, 'utf8'), result = edit(before)
  return { file, target, before, after: result.text, changed: result.changed }
})
console.log(JSON.stringify(planned.map(row => ({ file: row.file, changed: row.changed, addedLines: row.after.split('\n').length - row.before.split('\n').length })), null, 1))
if (mode === '--plan') process.exit(0)
const backup = path.resolve(argument('--backup') ?? '')
if (!argument('--backup') || !fs.existsSync(backup) || fs.existsSync(path.join(backup, record))) fail('--backup must name an existing directory without ' + record)
const saved = { createdAt: new Date().toISOString(), files: [] }
for (const row of planned.filter(item => item.changed)) {
  const copy = path.join(backup, 'window-manager-config', row.file)
  fs.mkdirSync(path.dirname(copy), { recursive: true })
  fs.writeFileSync(copy, row.before)
  if (sha(fs.readFileSync(copy, 'utf8')) !== sha(row.before)) fail('backup did not verify: ' + row.file)
  saved.files.push({ file: row.file, beforeSha256: sha(row.before), afterSha256: sha(row.after) })
}
fs.writeFileSync(path.join(backup, record), JSON.stringify(saved, null, 1) + '\n')
for (const row of planned.filter(item => item.changed)) {
  fs.writeFileSync(row.target, row.after)
  if (sha(fs.readFileSync(row.target, 'utf8')) !== sha(row.after)) fail('write did not verify: ' + row.file)
}
console.log(JSON.stringify({ applied: saved.files.map(row => row.file), rollback: `node tools/deploy-production-window-manager.mjs --rollback ${backup}` }))
