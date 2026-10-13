// For every test file: which plugin modules it references, and whether each is loaded in the shipped profile.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
const root = process.argv[2] // stage root
const pluginsDir = join(root, 'home/profiles/web/plugins')
const plugins = readdirSync(pluginsDir).filter(n => n.endsWith('.mjs'))
const patch = readFileSync(join(root, '../../home/profiles/web/cordis.patch.yml'), 'utf8')
const headless = existsSync(join(root, '../../home/profiles/headless/cordis.patch.yml')) ? readFileSync(join(root, '../../home/profiles/headless/cordis.patch.yml'), 'utf8') : ''
const loaded = new Set()
const queue = plugins.filter(n => patch.includes(n) || headless.includes(n))
for (const n of queue) loaded.add(n)
// transitive: plugin imports another plugin
for (let i = 0; i < queue.length; i++) {
  const src = readFileSync(join(pluginsDir, queue[i]), 'utf8')
  for (const n of plugins) if (!loaded.has(n) && (src.includes('./' + n) || src.includes('/' + n))) { loaded.add(n); queue.push(n) }
}
console.log('plugins', plugins.length, 'loaded(direct+transitive)', loaded.size)
console.log('NOT loaded:', plugins.filter(n => !loaded.has(n)).join(', '))
const testDirs = readdirSync(root).filter(d => /^(native|architecture|usage|phase\d+)-tests$/.test(d))
const rows = []
for (const d of testDirs) for (const f of readdirSync(join(root, d)).filter(n => n.endsWith('.test.mjs'))) {
  const src = readFileSync(join(root, d, f), 'utf8')
  const refs = plugins.filter(n => src.includes(n))
  const unl = refs.filter(n => !loaded.has(n))
  rows.push({ file: d + '/' + f, refs: refs.length, unloaded: unl })
}
console.log('--- tests whose plugin refs are ALL unloaded (and refs>0):')
for (const r of rows) if (r.refs > 0 && r.unloaded.length === r.refs) console.log(r.file, r.unloaded.join(','))
console.log('--- tests with no plugin refs:', rows.filter(r => r.refs === 0).length)
for (const r of rows) if (r.refs === 0) console.log('  ', r.file)
