import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const stage = resolve(fileURLToPath(new URL('../', import.meta.url)))
const testDirectory = /^(native|architecture|usage|phase(?:[1-9]|1[01]))-tests$/
// Slow files (real hosts, subprocess death, real git, production-data replays) are listed in tools/regression-slow.json
// with the reason. They stay runnable: --slow adds them to the full run, --only-slow runs just those.
export function slowTests(root = stage) {
  const manifest = resolve(root, 'tools/regression-slow.json')
  if (!existsSync(manifest)) return new Set()
  const rows = JSON.parse(readFileSync(manifest, 'utf8')).slow ?? {}
  return new Set(Object.keys(rows).map(path => resolve(root, path)))
}
export function discoverTests(root = stage, slow = 'exclude') {
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path)
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && testDirectory.test(entry.name)) visit(resolve(root, entry.name))
  const listed = slowTests(root), sorted = files.sort()
  return slow === 'include' ? sorted : slow === 'only' ? sorted.filter(path => listed.has(path)) : sorted.filter(path => !listed.has(path))
}
const clip = (value, max) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)

export async function runRegression(args) {
  if (args.includes('--help')) {
    console.log('node tools/run-regression.mjs [--slow | --only-slow] [--keep-logs] [--files path.test.mjs ...]\nDefault: all canonical offline tests except the slow group listed in tools/regression-slow.json. --slow adds the slow group; --only-slow runs only it.\nstdout prints failures and one summary; the full log is kept only when the run fails (or with --keep-logs).')
    return 0
  }
  const filesAt = args.indexOf('--files')
  const options = filesAt < 0 ? args : args.slice(0, filesAt)
  const flags = new Set(options)
  const valid = options.every(arg => ['--slow', '--only-slow', '--keep-logs'].includes(arg))
  if (!valid || (flags.has('--slow') && flags.has('--only-slow')) || (filesAt >= 0 && (filesAt === args.length - 1 || args.slice(filesAt + 1).some(arg => arg.startsWith('--'))))) {
    throw new Error('Use [--slow|--only-slow] [--keep-logs] and optionally --files followed by exact .test.mjs paths.')
  }
  const slowMode = flags.has('--only-slow') ? 'only' : flags.has('--slow') ? 'include' : 'exclude'
  const files = filesAt >= 0 ? args.slice(filesAt + 1).map(path => resolve(stage, path)) : discoverTests(stage, slowMode)
  const skippedSlow = filesAt < 0 && slowMode === 'exclude' ? slowTests(stage).size : 0
  if (!files.length) throw new Error('NO_TEST_FILES')
  for (const file of files) {
    const physical = realpathSync(file)
    if (!physical.toLowerCase().startsWith(realpathSync(stage).toLowerCase() + sep) || !file.endsWith('.test.mjs') || !statSync(file).isFile()) throw new Error('INVALID_TEST_FILE:' + file)
  }
  const directory = resolve(stage, '../../output/regressions', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8))
  mkdirSync(directory, { recursive: true })
  const full = resolve(directory, 'full.log'), summaryFile = resolve(directory, 'summary.json'), processLog = resolve(directory, 'process.log')
  const parameters = ['--preserve-symlinks', '--preserve-symlinks-main', '--import', new URL('./prepare-unified-lab-host.mjs', import.meta.url).href,
    '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=' + full,
    '--test-reporter=' + new URL('./compact-test-reporter.mjs', import.meta.url).href, '--test-reporter-destination=' + summaryFile,
    ...files.map(path => relative(stage, path))]
  console.log(`RUN ${files.length} files; concurrency=1${skippedSlow ? `; ${skippedSlow} slow files skipped (--slow to include)` : ''}`)
  const fd = openSync(processLog, 'wx')
  let code, signal, spawnError
  // The operator shell exports the production DSH_HOME, and plugins fall back to it for process-local files. A home the
  // caller chose on purpose is passed through.
  const production = resolve(stage, '../../home').toLowerCase()
  const home = !process.env.DSH_HOME || resolve(process.env.DSH_HOME).toLowerCase() === production ? resolve(directory, 'home') : process.env.DSH_HOME
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, DSH_HOME: home, DSH_LAB_CANONICAL_MODULES: '1', FORCE_COLOR: '0' }
  // Tests that trim a slow variant of their own can check this; set whenever the slow group is part of the run.
  if (filesAt >= 0 || slowMode !== 'exclude') env.DSH_REGRESSION_SLOW = '1'
  // A new CLI run is not a nested node:test worker, even in runner self-tests.
  delete env.NODE_TEST_CONTEXT
  try {
    const child = spawn(process.execPath, parameters, { cwd: stage, windowsHide: true,
      env, stdio: ['ignore', fd, fd] })
    ;({ code, signal, spawnError } = await new Promise(accept => {
      child.once('error', error => accept({ spawnError: error.message }))
      child.once('close', (code, signal) => accept({ code, signal }))
    }))
  } finally { closeSync(fd) }
  let summary
  try { summary = JSON.parse(readFileSync(summaryFile, 'utf8')) } catch {}
  const c = summary?.counts
  const success = code === 0 && !signal && !spawnError && summary?.complete === true && summary.success === true && c?.tests > 0
  console.log(`${success ? 'PASS' : 'FAIL'} files=${files.length} tests=${c?.tests ?? 'unknown'} pass=${c?.passed ?? 'unknown'} fail=${c?.failed ?? 'unknown'} cancelled=${c?.cancelled ?? 'unknown'} skipped=${c?.skipped ?? 'unknown'} durationMs=${Math.round(summary?.durationMs ?? 0)}`)
  if (!summary?.complete || code !== 0 || signal || spawnError) console.log(`PROCESS exit=${code ?? 'unknown'} signal=${signal ?? 'none'} error=${clip(spawnError, 300) || 'none'} summaryComplete=${summary?.complete === true}`)
  const failures = summary?.failures ?? []
  for (const failure of failures.slice(0, 6)) console.log(`FAILURE ${clip(failure.name, 180)} | ${failure.file ?? ''}:${failure.line ?? ''} | ${clip(failure.message, 480)}`)
  if (failures.length > 6) console.log(`+ ${failures.length - 6} more failures in summary.json; no details omitted from full.log`)
  if (success && !flags.has('--keep-logs')) {
    // A passing run has nothing to diagnose; the noisy logs only stay for failures or on request.
    rmSync(full, { force: true }); rmSync(processLog, { force: true })
    if (home === resolve(directory, 'home')) rmSync(home, { recursive: true, force: true })
    console.log(`SUMMARY ${summaryFile}`)
  } else console.log(`SUMMARY ${summaryFile}\nFULL ${full}\nPROCESS_LOG ${processLog}`)
  return success ? 0 : Number.isInteger(code) && code !== 0 ? code : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runRegression(process.argv.slice(2)) }
  catch (error) { console.error('REGRESSION_RUNNER_ERROR ' + clip(error.message, 700)); process.exitCode = 1 }
}
