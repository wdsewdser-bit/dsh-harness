// Sets the conversation output reservation of the step-compaction plugin to what the default route really sends.
//   node tools/deploy-production-budget.mjs --plan
//   node tools/deploy-production-budget.mjs --apply --backup <new dir>
// Only the reservedOutputTokens line inside the step-compaction-v4 config block is touched; other plugins have
// settings of the same name that mean something else.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const prod = 'D:/dsh-test', files = ['home/profiles/web/cordis.patch.yml', 'home/profiles/headless/cordis.patch.yml']
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
  const lines = text.split('\n'), at = lines.findIndex(line => /name:\s*'\.\/plugins\/step-compaction-v4\.mjs'/.test(line))
  if (at < 0) return { text, changed: 0 }
  const indent = lines[at].match(/^\s*/)[0].length
  let changed = 0
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    // The block ends at the next list item or key at the plugin row's own indentation or shallower.
    if (line.trim() && line.match(/^\s*/)[0].length <= indent - 2) break
    // The margin has to absorb one step of estimated (not provider-counted) growth.
    const marginLine = line.match(/^(\s*)safetyMarginTokens:\s*(\d+)(\s*\r?)$/)
    if (marginLine && Number(marginLine[2]) < 32768) { lines[i] = `${marginLine[1]}safetyMarginTokens: 32768${marginLine[3]}`; changed++; continue }
    const match = line.match(/^(\s*)reservedOutputTokens:\s*(\d+)(\s*\r?)$/)
    if (match && match[2] !== '128000') {
      lines[i] = `${match[1]}# The default route sends max output 128000; reserving less let 915k requests through to a provider 400.${match[3].includes('\r') ? '\r' : ''}\n`
        + `${match[1]}reservedOutputTokens: 128000${match[3]}`
      changed++
    }
  }
  return { text: lines.join('\n'), changed }
}
const mode = process.argv.includes('--apply') ? '--apply' : '--plan'
if (mode === '--apply' && await listening(40123)) fail('production host is listening on 40123')
const planned = files.map(file => { const target = path.join(prod, file), before = fs.readFileSync(target, 'utf8'); return { file, target, before, ...edit(before) } })
console.log(JSON.stringify(planned.map(row => ({ file: row.file, changed: row.changed })), null, 1))
if (mode === '--plan') process.exit(0)
const backup = path.resolve(argument('--backup') ?? '')
if (!argument('--backup') || fs.existsSync(backup)) fail('--backup must name a new directory')
for (const row of planned.filter(item => item.changed)) {
  const copy = path.join(backup, 'budget', row.file)
  fs.mkdirSync(path.dirname(copy), { recursive: true })
  fs.writeFileSync(copy, row.before)
  fs.writeFileSync(row.target, row.text)
}
console.log(JSON.stringify({ applied: planned.filter(item => item.changed).map(row => row.file), restoreFrom: backup + '/budget' }))
