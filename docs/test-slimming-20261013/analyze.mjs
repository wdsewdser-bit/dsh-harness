import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const norm = f => String(f).replaceAll('\\', '/').replace(/^file:\/\/\//, '')
const rel = f => norm(f).split('/').slice(-2).join('/')
console.log(JSON.stringify(j.counts), Math.round(j.durationMs / 1000) + 's', j.files.length + ' files')
const dir = {}
for (const f of j.files) {
  const d = norm(f.file).split('/').slice(-2, -1)[0]
  const r = (dir[d] ??= { files: 0, tests: 0, ms: 0, fail: 0, skip: 0 })
  r.files++; r.tests += f.tests; r.ms += f.ms; r.fail += f.fail; r.skip += f.skipped
}
for (const [k, v] of Object.entries(dir).sort()) console.log(k.padEnd(20), String(v.files).padStart(4), String(v.tests).padStart(5), (v.ms / 1000).toFixed(1).padStart(7) + 's', 'fail', v.fail, 'skip', v.skip)
console.log('sum leaf', Math.round(j.files.reduce((a, f) => a + f.ms, 0) / 1000) + 's')
console.log('--- slowest 30 files (leaf ms)')
for (const f of [...j.files].sort((a, b) => b.ms - a.ms).slice(0, 30)) console.log((f.ms / 1000).toFixed(1).padStart(6) + 's', String(f.tests).padStart(4), rel(f.file))
console.log('--- files with <=1 test:', j.files.filter(f => f.tests <= 1).length)
console.log('--- failing/skipped files')
for (const f of j.files) if (f.fail || f.skipped) console.log(rel(f.file), 'fail', f.fail, 'skip', f.skipped)
const names = new Map()
for (const f of j.files) for (const [n] of f.cases) { const a = names.get(n) ?? []; a.push(rel(f.file)); names.set(n, a) }
const dups = [...names].filter(([, a]) => a.length > 1).sort((a, b) => b[1].length - a[1].length)
console.log('--- duplicate test names across files:', dups.length)
for (const [n, a] of dups.slice(0, 25)) console.log(a.length, JSON.stringify(n.slice(0, 80)), a.slice(0, 3).join(' | '))
