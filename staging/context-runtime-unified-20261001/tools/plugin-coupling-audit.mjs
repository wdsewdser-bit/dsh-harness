// Read-only audit of which staged plugins can be deployed to production on their own. Each staged web plugin that
// differs from production is laid over a scratch copy of the production plugin set and imported there; a failure
// means it depends on another staged change and must not be deployed (or validated on a production overlay) alone.
// Usage: node tools/plugin-coupling-audit.mjs                   print the report
//        node tools/plugin-coupling-audit.mjs --check           exit 1 when the report differs from plugin-coupling-baseline.json
//        node tools/plugin-coupling-audit.mjs --write-baseline --reason=<why the new state is accepted>
// The report depends on what production holds, so it changes after a deployment; re-accept it then.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stage = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const production = path.resolve(stage, '../../home/profiles/web')
const check = process.argv.includes('--check'), write = process.argv.includes('--write-baseline')
const reason = (process.argv.find(arg => arg.startsWith('--reason=')) ?? '').slice(9).trim()
if (write && reason.length < 10) throw new Error('REASON_REQUIRED: pass --reason=<why the new state is accepted> (at least 10 characters)')
const baselineFile = path.join(stage, 'plugin-coupling-baseline.json')
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const staged = path.join(stage, 'home/profiles/web/plugins'), live = path.join(production, 'plugins')
const names = fs.readdirSync(staged).filter(name => name.endsWith('.mjs')).sort()
const changed = names.filter(name => !fs.existsSync(path.join(live, name)) || sha(path.join(live, name)) !== sha(path.join(staged, name)))

// Some plugins reach the native packages by a relative path, so the scratch profile sits at the same depth below
// a junction to the production app directory.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-coupling-'))
const scratch = path.join(base, 'home/profiles/web')
const junctions = [path.join(base, 'app'), path.join(scratch, 'node_modules')]
const report = {}
try {
  fs.mkdirSync(scratch, { recursive: true })
  fs.symlinkSync(path.resolve(production, '../../../app'), junctions[0], 'junction')
  fs.symlinkSync(path.join(production, 'node_modules'), junctions[1], 'junction')
  fs.copyFileSync(path.join(production, 'package.json'), path.join(scratch, 'package.json'))
  const plugins = path.join(scratch, 'plugins')
  const reset = () => {
    fs.rmSync(plugins, { recursive: true, force: true }); fs.mkdirSync(plugins)
    for (const name of fs.readdirSync(live)) if (fs.statSync(path.join(live, name)).isFile()) fs.copyFileSync(path.join(live, name), path.join(plugins, name))
  }
  for (const name of changed) {
    reset()
    fs.copyFileSync(path.join(staged, name), path.join(plugins, name))
    const url = pathToFileURL(path.join(plugins, name)).href
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); process.exit(0)`],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    report[name] = out.status === 0 ? 'alone-ok'
      : 'coupled: ' + (out.stderr.split('\n').find(line => /Error/.test(line)) ?? 'import failed').replaceAll(base, '<scratch>').trim()
  }
} finally {
  // The junctions are removed first and by themselves, so nothing below them in production is ever traversed.
  for (const junction of junctions) if (fs.existsSync(junction)) fs.rmdirSync(junction)
  fs.rmSync(base, { recursive: true, force: true })
}
const text = JSON.stringify(report, null, 1) + '\n'
if (write) {
  fs.writeFileSync(baselineFile, text)
  fs.appendFileSync(path.join(stage, 'manifest-rewrite-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), tool: 'plugin-coupling-audit', reason }) + '\n')
}
process.stdout.write(text)
if (check) {
  if (!fs.existsSync(baselineFile)) throw new Error('BASELINE_MISSING: run --write-baseline first')
  if (fs.readFileSync(baselineFile, 'utf8').replaceAll('\r\n', '\n') !== text) { console.error('PLUGIN_COUPLING_CHANGED: compare with plugin-coupling-baseline.json'); process.exit(1) }
}
