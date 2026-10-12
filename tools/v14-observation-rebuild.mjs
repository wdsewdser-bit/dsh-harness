import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const files = [
  'home/profiles/web/plugins/observation-pack-v2.mjs',
  'home/profiles/web/plugins/evidence-reducer.mjs',
  'home/profiles/web/plugins/action-fusion-v2.mjs',
]
const target = process.argv[2] || 'D:\\dsh-test\\rebuild-v14-observation'
for (const relative of files) {
  const source = resolve(root, relative)
  const destination = resolve(target, relative)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, readFileSync(source))
  process.stdout.write(`rebuilt ${relative}\n`)
}
