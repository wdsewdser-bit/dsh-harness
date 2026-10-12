import { readFileSync } from 'node:fs'
import YAML from 'yaml'
const p = 'D:\\dsh-test\\home\\profiles\\teamtest\\cordis.patch.yml'
const text = readFileSync(p, 'utf8')
let doc
try { doc = YAML.parse(text) } catch (e) { console.log('PARSE ERROR', e.message); process.exit(1) }
console.log('entries:', doc.length)
for (const [i, e] of doc.entries()) {
  console.log(i, JSON.stringify({ id: e.id, disabled: e.disabled, hasInsert: Array.isArray(e.insert), insertIds: Array.isArray(e.insert) ? e.insert.map((r) => r.id) : undefined }))
}

