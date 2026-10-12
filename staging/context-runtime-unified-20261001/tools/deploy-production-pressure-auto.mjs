// Turns on the compaction engine's own step-boundary pressure fold at the hard cap, in every preset of both production
// profiles: `auto: false # compaction-policy: milestone-only` becomes `auto: true` + `thresholdRatio: 0.75`.
//   node tools/deploy-production-pressure-auto.mjs --plan
//   node tools/deploy-production-pressure-auto.mjs --apply --backup <new dir>
//   node tools/deploy-production-pressure-auto.mjs --rollback <dir>
// Milestone folds and their size floor are untouched: they are the step-compaction plugin's, not the engine's.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'

const prod = 'D:/dsh-test', record = 'pressure-auto-backup.json'
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
const line = /^([ \t]*)auto: false # compaction-policy: milestone-only[ \t]*(\r?)$/gm
function edit(text) {
  let count = 0
  const next = text.replace(line, (whole, indent, cr) => { count++
    return `${indent}# The engine folds by itself only at the hard cap, at the next step boundary, so a long turn that never${cr}\n`
      + `${indent}# goes idle cannot run past it. Below the cap folding stays milestone-only (step-compaction plugin).${cr}\n`
      + `${indent}auto: true${cr}\n${indent}thresholdRatio: 0.75${cr}` })
  return { text: next, count }
}
const mode = ['--plan', '--apply', '--rollback'].find(flag => process.argv.includes(flag)) ?? '--plan'
if (mode !== '--plan' && await listening(40123)) fail('production host is listening on 40123')
if (mode === '--rollback') {
  const directory = path.resolve(argument('--rollback') ?? ''), saved = JSON.parse(fs.readFileSync(path.join(directory, record), 'utf8'))
  for (const row of saved.files) {
    const before = fs.readFileSync(path.join(directory, 'pressure-auto', row.file), 'utf8')
    if (sha(before) !== row.beforeSha256) fail('backup copy is damaged: ' + row.file)
    fs.writeFileSync(path.join(prod, row.file), before)
  }
  console.log(JSON.stringify({ restored: saved.files.map(row => row.file) }))
  process.exit(0)
}
const planned = files.map(file => {
  const target = path.join(prod, file), before = fs.readFileSync(target, 'utf8'), result = edit(before)
  return { file, target, before, after: result.text, count: result.count, remaining: (before.match(/^\s*auto:\s*false/gm) ?? []).length - result.count }
})
console.log(JSON.stringify(planned.map(row => ({ file: row.file, presetsChanged: row.count, otherAutoFalseLeft: row.remaining })), null, 1))
if (mode === '--plan') process.exit(0)
// headless carries no engine override at all (it inherits the packaged defaults), so only profiles that have the line are edited.
if (planned.every(row => row.count === 0)) fail('no matching line in any profile')
const backup = path.resolve(argument('--backup') ?? '')
if (!argument('--backup') || fs.existsSync(backup)) fail('--backup must name a new directory')
const saved = { createdAt: new Date().toISOString(), files: [] }
for (const row of planned.filter(item => item.count > 0)) {
  const copy = path.join(backup, 'pressure-auto', row.file)
  fs.mkdirSync(path.dirname(copy), { recursive: true })
  fs.writeFileSync(copy, row.before)
  saved.files.push({ file: row.file, beforeSha256: sha(row.before), afterSha256: sha(row.after) })
}
fs.writeFileSync(path.join(backup, record), JSON.stringify(saved, null, 1) + '\n')
for (const row of planned.filter(item => item.count > 0)) {
  fs.writeFileSync(row.target, row.after)
  if (sha(fs.readFileSync(row.target, 'utf8')) !== sha(row.after)) fail('write did not verify: ' + row.file)
}
console.log(JSON.stringify({ applied: saved.files.map(row => row.file), rollback: `node tools/deploy-production-pressure-auto.mjs --rollback ${backup}` }))
