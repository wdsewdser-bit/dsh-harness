// Stage closeout in one step: sync changed web plugins to headless, refresh the "after" hash of every drifted
// manifest entry, and rebind the protocol-trial source pins. Text-level edits keep each file's formatting.
// Usage: node tools/stage-closeout.mjs <backup-directory> [--check]
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const stage = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const check = process.argv.includes('--check')
const backupArg = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (!check && !backupArg) throw new Error('BACKUP_DIRECTORY_REQUIRED')
const backup = backupArg ? path.resolve(backupArg) : null
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inStage = file => fs.realpathSync(file).toLowerCase().startsWith(stage.toLowerCase() + path.sep)
const mustBeStage = file => { if (!inStage(file)) throw new Error('REALPATH_OUTSIDE_STAGE ' + file) }
const report = { check, backups: [], headless: [], manifests: [], pins: [] }
function keep(file, name) {
  if (check) return
  fs.mkdirSync(backup, { recursive: true })
  const target = path.join(backup, name)
  if (!fs.existsSync(target)) fs.copyFileSync(file, target)
  report.backups.push(name)
}
function replaceOnce(text, from, to, label) {
  const count = text.split(from).length - 1
  if (count !== 1) throw new Error(`EXPECTED_ONE_MATCH ${label} count=${count}`)
  return text.replace(from, to)
}

const web = path.join(stage, 'home/profiles/web/plugins'), headless = path.join(stage, 'home/profiles/headless/plugins')
mustBeStage(web); mustBeStage(headless)
if (fs.lstatSync(headless).isSymbolicLink() || fs.realpathSync(headless).toLowerCase() === fs.realpathSync(web).toLowerCase()) throw new Error('HEADLESS_ALIASES_WEB')

const pluginManifest = JSON.parse(fs.readFileSync(path.join(stage, 'plugin-change-manifest.json'), 'utf8'))
for (const entry of pluginManifest) {
  const source = path.join(web, entry.name), target = path.join(headless, entry.name)
  if (!fs.existsSync(source)) continue
  const before = fs.existsSync(target) ? sha(target) : 'absent'
  if (before === sha(source)) continue
  report.headless.push(`${entry.name} ${before.slice(0, 8)} -> ${sha(source).slice(0, 8)}`)
  if (check) continue
  mustBeStage(source)
  if (before !== 'absent') { mustBeStage(target); keep(target, 'headless-' + entry.name) }
  fs.copyFileSync(source, target)
  if (sha(target) !== sha(source)) throw new Error('SYNC_MISMATCH ' + entry.name)
}

const trial = path.join(stage, 'tools/window-protocol-trial.mjs')
{
  let text = fs.readFileSync(trial, 'utf8')
  let changed = false
  // Two pin tables: the protocol sources (`name: ['path', 'sha']`) and the native surface sources (`['name','path','sha']`).
  for (const match of [...text.matchAll(/\['(\w+)','(\.\.\/[^']+)','([0-9a-f]{64})'\]/g), ...text.matchAll(/(\w+): \['(\.\.\/[^']+)', '([0-9a-f]{64})'\]/g)]) {
    const [, name, relative, pinned] = match
    const actual = sha(path.resolve(stage, 'tools', relative))
    if (actual === pinned) continue
    report.pins.push(`${name} ${pinned.slice(0, 8)} -> ${actual.slice(0, 8)}`)
    if (check) continue
    text = replaceOnce(text, pinned, actual, 'pin ' + name)
    changed = true
  }
  if (changed) { mustBeStage(trial); keep(trial, 'tools-window-protocol-trial.mjs'); fs.writeFileSync(trial, text) }
}

// The offline live-lab template pins the schema-bearing sources it was written against.
const template = path.join(stage, 'docs/context-runtime-unified-20261001/live-lab-stage-template.json')
if (fs.existsSync(template)) {
  let text = fs.readFileSync(template, 'utf8'), changed = false
  for (const schema of JSON.parse(text).schemaFiles ?? []) {
    if (!fs.existsSync(schema.path)) throw new Error('MISSING ' + schema.path)
    const actual = sha(schema.path)
    if (actual === schema.sha256) continue
    report.pins.push(`template ${path.basename(schema.path)} ${schema.sha256.slice(0, 8)} -> ${actual.slice(0, 8)}`)
    if (check) continue
    text = replaceOnce(text, schema.sha256, actual, 'template ' + path.basename(schema.path))
    changed = true
  }
  if (changed) { mustBeStage(template); keep(template, 'live-lab-stage-template.json'); JSON.parse(text); fs.writeFileSync(template, text) }
}

for (const kind of ['native', 'plugin', 'tools']) {
  const file = path.join(stage, kind + '-change-manifest.json')
  let text = fs.readFileSync(file, 'utf8')
  const raw = JSON.parse(text), entries = Array.isArray(raw) ? raw : raw.entries
  let changed = false
  for (const entry of entries) {
    const target = entry.path ?? path.join(stage, 'tools', entry.name)
    if (!fs.existsSync(target)) throw new Error('MISSING ' + target)
    const actual = sha(target).toUpperCase(), recorded = String(entry.after)
    if (actual === recorded.toUpperCase()) continue
    report.manifests.push(`${kind} ${path.basename(target)} ${recorded.slice(0, 8)} -> ${actual.slice(0, 8)}`)
    if (check) continue
    mustBeStage(target)
    text = replaceOnce(text, `"after": "${recorded}"`, `"after": "${actual}"`, kind + ' ' + path.basename(target))
    changed = true
  }
  if (!changed) continue
  const reparsed = JSON.parse(text)
  if ((Array.isArray(reparsed) ? reparsed : reparsed.entries).length !== entries.length) throw new Error('ENTRY_COUNT_CHANGED')
  mustBeStage(file); keep(file, path.basename(file)); fs.writeFileSync(file, text)
}
report.pending = report.headless.length + report.manifests.length + report.pins.length
console.log(JSON.stringify(report, null, 1))
if (check && report.pending) process.exitCode = 1
