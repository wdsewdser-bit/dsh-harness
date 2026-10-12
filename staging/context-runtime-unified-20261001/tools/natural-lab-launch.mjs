// Parent launcher for natural labs that have no parent mode of their own (instant-natural-lab): it sets the isolated
// lab home and canonical module resolution, and for --run inherits the provider key read-only into the child only.
// The key is never printed, copied to disk or placed in this process's own environment.
// Usage: node tools/natural-lab-launch.mjs tools/instant-natural-lab.mjs [--run]
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stage = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fail = code => { console.error(JSON.stringify({ failed: true, code })); process.exit(1) }
const [target, ...args] = process.argv.slice(2)
const lab = target ? resolve(target) : ''
if (!lab.startsWith(join(stage, 'tools') + sep) || !/-natural-lab\.mjs$/.test(lab)) fail('LAB_TARGET_NOT_ALLOWED')
const env = { ...process.env, DSH_HOME: join(stage, 'lab-host-home'), DSH_LAB_CANONICAL_MODULES: '1' }
if (args.includes('--run')) {
  const require = createRequire(new URL('../app/package.json', import.meta.url))
  const { parseCredentialsDocument } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')))
  const key = parseCredentialsDocument(readFileSync('D:/dsh-test/home/.credentials.yaml', 'utf8'), 'readonly-production').refs.get('OPENCODEGO_API_KEY')
  if (typeof key !== 'string' || !key) fail('LAB_CREDENTIAL_REFERENCE_MISSING')
  env.OPENCODEGO_API_KEY = key
}
const result = spawnSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', '--import',
  new URL('./prepare-unified-lab-host.mjs', import.meta.url).href, lab, ...args],
  { cwd: stage, env, windowsHide: true, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 })
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error) fail(result.error.code ?? 'LAB_SPAWN_FAILED')
process.exitCode = result.status ?? 1
