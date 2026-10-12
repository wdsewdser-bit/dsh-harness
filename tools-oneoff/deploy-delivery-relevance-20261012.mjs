// One-off production deployment (2026-10-12) of the two context delivery optimizations (relevance order for compact
// candidates, full refill of compact sources in use) and the context pack cap, 32000 -> 80000, in both profiles.
// team-v12-runtime.mjs is the production version plus the optimizations (relevance-only/, built from the staging file
// by item3-only/build-from-staging.mjs); team-v14-context-delivery.mjs is the staging file. These are the bytes
// validated in the live test. The cap is a one-line text edit of cordis.patch.yml.
//   node deploy-delivery-relevance-20261012.mjs --plan | --apply | --rollback
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const prod = 'D:/dsh-test', stage = prod + '/staging/context-runtime-unified-20261001/home/profiles/web/plugins'
const backup = prod + '/backups/context-runtime-production-delivery-relevance-20261012'
const sha = file => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase() : null
const fail = message => { console.error('REFUSED ' + message); process.exit(1) }
const sources = {
  'team-v12-runtime.mjs': { source: here + '/relevance-only/team-v12-runtime.mjs', before: '1A1C428F', after: '86A82128' },
  'team-v14-context-delivery.mjs': { source: stage + '/team-v14-context-delivery.mjs', before: '7F52A10A', after: 'BB7FB807' },
}
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
    fs.copyFileSync(backup + '/files/' + row.saved, row.target)
    if (sha(row.target) !== row.before) fail('rollback verification failed: ' + row.target)
  }
  console.log('rolled back ' + record.files.length + ' files'); process.exit(0)
}
const work = []
for (const profile of ['web', 'headless']) for (const [name, want] of Object.entries(sources)) {
  const target = `${prod}/home/profiles/${profile}/plugins/${name}`
  if (fs.realpathSync(path.dirname(target)).split(path.sep).join('/').toLowerCase() !== path.dirname(target).toLowerCase()) fail('target directory is a link: ' + target)
  const before = sha(target), after = sha(want.source)
  if (!after?.startsWith(want.after)) fail('source is not the validated version: ' + want.source)
  if (!before?.startsWith(want.before)) fail(`production drifted: ${target} is ${before}`)
  work.push({ target, before, after, saved: `${profile}--${name}`, source: want.source })
}
const capLine = /^( {8}contextPackMaxTokens: )32000([ \t]*\r?)$/m
for (const profile of ['web', 'headless']) {
  const target = `${prod}/home/profiles/${profile}/cordis.patch.yml`, text = fs.readFileSync(target, 'utf8')
  if ((text.match(new RegExp(capLine.source, 'gm')) ?? []).length !== 1) fail('cap line not found exactly once: ' + target)
  const next = text.replace(capLine, '$180000$2')
  work.push({ target, before: sha(target), after: createHash('sha256').update(next).digest('hex').toUpperCase(), saved: `${profile}--cordis.patch.yml`, text: next })
}
console.log(JSON.stringify(work.map(({ text, ...row }) => row), null, 1))
if (mode !== '--apply') process.exit(0)
if (fs.existsSync(backup)) fail('backup directory exists: ' + backup)
fs.mkdirSync(backup + '/files', { recursive: true })
for (const row of work) { fs.copyFileSync(row.target, backup + '/files/' + row.saved); if (sha(backup + '/files/' + row.saved) !== row.before) fail('backup verification failed') }
fs.writeFileSync(backup + '/deploy-backup.json', JSON.stringify({ at: new Date().toISOString(), tool: 'deploy-delivery-relevance-20261012.mjs', files: work.map(({ text, ...row }) => row) }, null, 1))
for (const row of work) { if (row.text !== undefined) fs.writeFileSync(row.target, row.text); else fs.copyFileSync(row.source, row.target); if (sha(row.target) !== row.after) fail('write verification failed (run --rollback): ' + row.target) }
console.log('deployed ' + work.length + ' files; backup ' + backup)
