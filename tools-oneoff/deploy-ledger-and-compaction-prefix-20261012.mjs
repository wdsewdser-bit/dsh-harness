// One-off, minimal-scope production deployment of two plugins (2026-10-12): constraint-ledger.mjs (new) and
// request-message-projection.mjs (compaction prefix projection), plus the constraint-ledger entry in both profiles'
// cordis.patch.yml. tools/deploy-production.mjs is not used because its change set cannot be narrowed and currently
// holds 50 files, among them the PTC package that has no production authorization.
//   node deploy-ledger-and-compaction-prefix-20261012.mjs --plan | --apply | --rollback
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'

const prod = 'D:/dsh-test', stage = prod + '/staging/context-runtime-unified-20261001'
const backup = prod + '/backups/context-runtime-production-constraint-ledger-20261012'
const sha = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase() : null
const fail = message => { console.error('REFUSED ' + message); process.exit(1) }
const expected = {
  'constraint-ledger.mjs': { before: null, after: '68C63F80' },
  'request-message-projection.mjs': { before: '4AF4102B', after: '7ECF041E' },
}
const entry = eol => ['    - id: constraint-ledger', "      name: './plugins/constraint-ledger.mjs'"].map(line => line + eol).join('')
const anchor = /(    - id: request-message-projection\r?\n      name: '\.\/plugins\/request-message-projection\.mjs'\r?\n      config:\r?\n        maxAuditRecords: 64\r?\n)/

const listening = port => new Promise(resolve => {
  const socket = net.connect({ port, host: '127.0.0.1' })
  socket.setTimeout(1000)
  socket.once('connect', () => { socket.destroy(); resolve(true) })
  socket.once('timeout', () => { socket.destroy(); resolve(false) })
  socket.once('error', () => resolve(false))
})
for (let port = 40120; port <= 40129; port++) if (await listening(port)) fail('a host is listening on ' + port)

const mode = process.argv[2]
if (mode === '--rollback') {
  const record = JSON.parse(fs.readFileSync(backup + '/deploy-backup.json', 'utf8'))
  for (const row of record.files) {
    if (sha(row.target) !== row.after) fail('changed since deployment: ' + row.target)
    if (row.before === null) fs.rmSync(row.target); else fs.copyFileSync(backup + '/files/' + row.saved, row.target)
    if (sha(row.target) !== row.before) fail('rollback verification failed: ' + row.target)
  }
  console.log('rolled back ' + record.files.length + ' files'); process.exit(0)
}

const work = []
for (const profile of ['web', 'headless']) {
  for (const [name, want] of Object.entries(expected)) {
    const source = `${stage}/home/profiles/${profile}/plugins/${name}`, target = `${prod}/home/profiles/${profile}/plugins/${name}`
    if (fs.realpathSync(path.dirname(target)).split(path.sep).join('/').toLowerCase() !== path.dirname(target).toLowerCase()) fail('target directory is a link: ' + target)
    const before = sha(target), after = sha(source)
    if (!after.startsWith(want.after)) fail('stage file is not the validated version: ' + source)
    if ((before?.slice(0, 8) ?? null) !== want.before) fail(`production drifted: ${target} is ${before}`)
    work.push({ target, before, after, saved: `${profile}--${name}`, write: () => fs.copyFileSync(source, target) })
  }
  const target = `${prod}/home/profiles/${profile}/cordis.patch.yml`, text = fs.readFileSync(target, 'utf8')
  if (text.includes('constraint-ledger')) fail('already registered: ' + target)
  if ((text.match(new RegExp(anchor.source, 'g')) ?? []).length !== 1) fail('anchor not found exactly once: ' + target)
  const next = text.replace(anchor, whole => whole + entry(whole.endsWith('\r\n') ? '\r\n' : '\n'))
  work.push({ target, before: sha(target), after: createHash('sha256').update(next).digest('hex').toUpperCase(), saved: `${profile}--cordis.patch.yml`, write: () => fs.writeFileSync(target, next) })
}
console.log(JSON.stringify(work.map(({ write, ...row }) => row), null, 1))
if (mode !== '--apply') process.exit(0)
if (fs.existsSync(backup)) fail('backup directory exists: ' + backup)
fs.mkdirSync(backup + '/files', { recursive: true })
for (const row of work) if (row.before !== null) { fs.copyFileSync(row.target, backup + '/files/' + row.saved); if (sha(backup + '/files/' + row.saved) !== row.before) fail('backup verification failed') }
fs.writeFileSync(backup + '/deploy-backup.json', JSON.stringify({ at: new Date().toISOString(), tool: 'deploy-ledger-and-compaction-prefix-20261012.mjs', files: work.map(({ write, ...row }) => row) }, null, 1))
for (const row of work) { row.write(); if (sha(row.target) !== row.after) fail('write verification failed (run --rollback): ' + row.target) }
console.log('deployed ' + work.length + ' files; backup ' + backup)
