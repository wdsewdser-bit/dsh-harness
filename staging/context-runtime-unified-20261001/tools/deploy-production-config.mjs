// Production config edits that go with the file deployment: two step-compaction settings, in both real profiles.
//   node tools/deploy-production-config.mjs --plan
//   node tools/deploy-production-config.mjs --apply --backup <existing deploy backup dir>
//   node tools/deploy-production-config.mjs --rollback <dir>
// Text-level edits only, so comments, order and line endings of cordis.patch.yml stay as they are. It adds no
// plugin entry and enables no feature. desktop is a junction to web and is not written separately.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'

const prod = 'D:/dsh-test'
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
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const once = (pattern, label) => { const found = text.match(new RegExp(pattern, 'gm')) ?? []; if (found.length !== 1) fail(`${label}: expected exactly one match, found ${found.length}`) }
  if (/^\s*minMilestoneFoldTokens:/m.test(text)) return switches(text)
  once('^([ \\t]*)autoCompactRatio: 0\\.75[ \\t]*\\r?$', 'autoCompactRatio')
  once('^([ \\t]*)cacheWriteReadRatio: 12\\.5[ \\t]*\\r?$', 'cacheWriteReadRatio')
  let next = text.replace(/^([ \t]*)autoCompactRatio: 0\.75[ \t]*\r?$/m, (line, indent) => line.replace(/\r$/, '') + eol
    + `${indent}# A ticked milestone folds only once the context has reached this size. A milestone closes a large phase;${eol}`
    + `${indent}# folding a small, still-cached context costs more than it saves. The 0.75 cap above is unaffected.${eol}`
    + `${indent}minMilestoneFoldTokens: 200000` + (line.endsWith('\r') ? '\r' : ''))
  // Cache-hit input is priced at 1/50 of cache-miss input on this route (0.003 vs 0.15 USD per 1M, 2026-10).
  next = next.replace(/^([ \t]*)cacheWriteReadRatio: 12\.5([ \t]*\r?)$/m, '$1cacheWriteReadRatio: 50$2')
  return { text: switches(next).text, changed: true }
}

// The two team-v12-runtime switches the user asked to turn on: the hypothesis/convergence runtime and next-turn
// identity. They go at the end of that plugin's config block, shaped as in the lab profile.
function switches(text) {
  const block = /(name: '\.\/plugins\/team-v12-runtime\.mjs'\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?)([ \t]*)costAlertThreshold: 25000[ \t]*(\r?)\n/
  const found = text.match(block)
  if (!found) fail('team-v12-runtime config block not found')
  const hasHypothesis = /\n[ \t]*hypothesis:[ \t]*\r?\n/.test(text), hasIdentity = /\n[ \t]*activeIdentity:[ \t]*\r?\n/.test(text)
  // activeIdentity needs an activated identity bundle per Team root before the first sampling. Production has no
  // driver that activates one, so it is written only together with hostBootstrap (the runtime publishes the
  // configured bundle once for a root that has none); without that every step is refused and every turn "blocked".
  const lines = [...(hasHypothesis ? [] : ['hypothesis:', '  enabled: true']),
    ...(process.argv.includes('--with-active-identity') && !hasIdentity
      ? ['activeIdentity:', '  enabled: true', '  hostBootstrap: true', '  allowedRoots:', "    - 'D:\\dsh-test\\home\\team-roles'"] : [])]
  if (!lines.length) return { text, changed: false }
  // Insert after the last line this script already owns in the block.
  const anchor = hasHypothesis ? /(([ \t]*)hypothesis:[ \t]*(\r?)\n[ \t]*enabled: true[ \t]*\r?\n)/ : null
  if (anchor) {
    const at = text.match(anchor)
    return { text: text.replace(anchor, whole => whole + lines.map(line => at[2] + line + at[3] + '\n').join('')), changed: true }
  }
  const indent = found[2], cr = found[3]
  return { text: text.replace(block, whole => whole + lines.map(line => indent + line + cr + '\n').join('')), changed: true }
}

const mode = ['--plan', '--apply', '--rollback'].find(flag => process.argv.includes(flag)) ?? '--plan'
if (mode !== '--plan' && await listening(40123)) fail('production host is listening on 40123')
if (mode === '--rollback') {
  const directory = path.resolve(argument('--rollback') ?? '')
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'config-backup.json'), 'utf8'))
  for (const row of record.files) {
    const saved = fs.readFileSync(path.join(directory, 'config', row.file))
    if (sha(saved) !== row.beforeSha256) fail('backup copy is damaged: ' + row.file)
    fs.writeFileSync(path.join(prod, row.file), saved)
  }
  console.log(JSON.stringify({ restored: record.files.map(row => row.file) }))
  process.exit(0)
}
const planned = files.map(file => {
  const target = path.join(prod, file), before = fs.readFileSync(target, 'utf8'), result = edit(before)
  return { file, target, before, after: result.text, changed: result.changed, lines: result.text.split('\n').length - before.split('\n').length }
})
console.log(JSON.stringify(planned.map(row => ({ file: row.file, changed: row.changed, addedLines: row.lines, beforeSha256: sha(row.before).slice(0, 12), afterSha256: sha(row.after).slice(0, 12) })), null, 1))
if (mode === '--plan') process.exit(0)
const backup = path.resolve(argument('--backup') ?? '')
if (!argument('--backup') || !fs.existsSync(backup) || fs.existsSync(path.join(backup, 'config-backup.json'))) fail('--backup must name an existing directory without a config backup')
const record = { createdAt: new Date().toISOString(), files: [] }
for (const row of planned.filter(item => item.changed)) {
  const saved = path.join(backup, 'config', row.file)
  fs.mkdirSync(path.dirname(saved), { recursive: true })
  fs.writeFileSync(saved, row.before)
  if (sha(fs.readFileSync(saved)) !== sha(row.before)) fail('backup did not verify: ' + row.file)
  record.files.push({ file: row.file, beforeSha256: sha(row.before), afterSha256: sha(row.after) })
}
fs.writeFileSync(path.join(backup, 'config-backup.json'), JSON.stringify(record, null, 1) + '\n')
for (const row of planned.filter(item => item.changed)) {
  fs.writeFileSync(row.target, row.after)
  if (sha(fs.readFileSync(row.target, 'utf8')) !== sha(row.after)) fail('write did not verify: ' + row.file)
}
console.log(JSON.stringify({ applied: record.files.map(row => row.file), rollback: `node tools/deploy-production-config.mjs --rollback ${backup}` }))
