import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const production = 'D:/dsh-test'
const sessions = path.join(production, 'home/sessions')
const target = path.resolve(sessions, '--D-dsh-test-workspaces-window-large2-20261008--/session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a')
const output = path.join(production, 'output/window-production-live-20261011')
const stopFile = path.join(output, 'stop')
const stateFile = path.join(output, 'state.json')
const logFile = path.join(output, 'host.log')
const foreign = () => {
  const rows = new Map()
  function visit(directory) {
    if (path.resolve(directory).toLowerCase() === target.toLowerCase()) return
    for (const row of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, row.name)
      if (row.isDirectory()) visit(file)
      else if (/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(row.name)) {
        const stat = fs.statSync(file)
        rows.set(file, `${stat.size}:${stat.mtimeMs}`)
      }
    }
  }
  visit(sessions)
  return rows
}
if (!fs.existsSync(target)) throw new Error('TEST_SESSION_NOT_FOUND')
const baseline = foreign()
const control = path.join(production, 'home/team-control-plane')
const ownControl = 'session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a.json'
const foreignControl = new Map(fs.readdirSync(control).filter(name => /^(?:default|session-[a-f0-9-]+)\.json$/.test(name)
  && name !== ownControl).map(name => {
    const file = path.join(control, name), stat = fs.statSync(file)
    return [file, `${stat.size}:${stat.mtimeMs}`]
  }))
if (!process.argv.includes('--start')) {
  console.log(JSON.stringify({ dryRun: true, allowedSessionDirectory: target, protectedSessionFiles: baseline.size,
    protectedControlFiles: foreignControl.size }))
  process.exit(0)
}
fs.mkdirSync(output, { recursive: true })
if (fs.existsSync(stateFile) || fs.existsSync(stopFile)) throw new Error('LIVE_OUTPUT_ALREADY_EXISTS')
const fd = fs.openSync(logFile, 'wx')
const host = spawn(process.execPath, ['app/node_modules/@deepseek-ai/dsh/lib/bin.js', 'web', '--no-open', '--port', '40123'], {
  cwd: production, env: { ...process.env, DSH_HOME: path.join(production, 'home') }, windowsHide: true,
  stdio: ['ignore', fd, fd],
})
fs.closeSync(fd)
const started = Date.now()
const state = { startedAt: new Date().toISOString(), hostPid: host.pid, allowedSessionDirectory: target,
  protectedSessionFiles: baseline.size, protectedControlFiles: foreignControl.size, hostLog: logFile, stopFile, status: 'running' }
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
save()
console.log(JSON.stringify(state))
let stopping = false
function stop(reason, file) {
  if (stopping) return
  stopping = true
  Object.assign(state, { status: 'stopping', reason, ...(file ? { changedForeignFile: file } : {}) })
  save()
  if (host.pid) spawnSync('taskkill', ['/PID', String(host.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}
host.on('error', error => { clearInterval(timer); Object.assign(state, { status: 'failed', error: error.message }); save() })
host.on('exit', (code, signal) => {
  clearInterval(timer)
  Object.assign(state, { status: 'stopped', exitCode: code, signal, stoppedAt: new Date().toISOString() })
  save()
  console.log(JSON.stringify(state))
})
const timer = setInterval(() => {
  try {
    const current = foreign()
    for (const [file, signature] of current) if (baseline.get(file) !== signature) return stop('foreign-session-changed', file)
    for (const file of baseline.keys()) if (!current.has(file)) return stop('foreign-session-removed', file)
    for (const [file, signature] of foreignControl) {
      if (!fs.existsSync(file)) return stop('foreign-control-removed', file)
      const stat = fs.statSync(file)
      if (`${stat.size}:${stat.mtimeMs}` !== signature) return stop('foreign-control-changed', file)
    }
    if (fs.existsSync(stopFile)) stop('requested-stop')
    else if (Date.now() - started >= 45 * 60000) stop('bounded-live-test-timeout')
  } catch (error) { stop('guard-read-failed:' + error.message) }
}, 1000)
process.on('SIGINT', () => stop('controller-interrupted'))
process.on('SIGTERM', () => stop('controller-terminated'))
