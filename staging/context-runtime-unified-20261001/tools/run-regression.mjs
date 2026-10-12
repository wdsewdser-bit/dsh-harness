import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const stage = resolve(fileURLToPath(new URL('../', import.meta.url)))
const testDirectory = /^(native|architecture|usage|phase(?:[1-9]|1[01]))-tests$/
export function discoverTests(root = stage) {
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path)
    }
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && testDirectory.test(entry.name)) visit(resolve(root, entry.name))
  return files.sort()
}
const clip = (value, max) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, max)

export async function runRegression(args) {
  if (args.includes('--help')) {
    console.log('node tools/run-regression.mjs [--files path.test.mjs ...]\nDefault: all canonical offline tests. Full logs stay on disk; stdout is bounded.')
    return 0
  }
  if (args.length && (args[0] !== '--files' || args.length < 2)) throw new Error('Use --files followed by exact .test.mjs paths, or omit arguments for the full suite.')
  const files = args.length ? args.slice(1).map(path => resolve(stage, path)) : discoverTests()
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
  console.log(`RUN ${files.length} files; concurrency=1; full output -> ${full}`)
  const fd = openSync(processLog, 'wx')
  let code, signal, spawnError
  const env = { ...process.env, DSH_LAB_CANONICAL_MODULES: '1', FORCE_COLOR: '0' }
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
  console.log(`SUMMARY ${summaryFile}\nFULL ${full}\nPROCESS_LOG ${processLog}`)
  return success ? 0 : Number.isInteger(code) && code !== 0 ? code : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runRegression(process.argv.slice(2)) }
  catch (error) { console.error('REGRESSION_RUNNER_ERROR ' + clip(error.message, 700)); process.exitCode = 1 }
}
