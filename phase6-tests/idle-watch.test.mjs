import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const controlMod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\team-control-plane.mjs').href)
const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\team-idle-watch-v6.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const row = (name, status, extra) => Object.assign({ name, role: 'teammate', status }, extra)

// ---- the pure stop decision -------------------------------------------------
const idle = [row('lead', 'inactive', { role: 'lead' }), row('a1', 'idle'), row('a2', 'idle')]
check('everyone idle is stopped', mod.stoppedState(idle, 'idle').stopped === true)
check('one running member is not stopped', mod.stoppedState([...idle, row('a3', 'running')], 'idle').stopped === false)
check('a running Lead is not stopped', mod.stoppedState(idle, 'running').stopped === false)
check('a provisioning member is not stopped', mod.stoppedState([...idle, row('a3', 'provisioning')], 'idle').stopped === false)
check('a Team with no subordinates is never reported', mod.stoppedState([row('lead', 'inactive', { role: 'lead' })], 'idle').stopped === false)
check('parked members do not count as waiting', mod.stoppedState([row('lead', 'inactive', { role: 'lead' }), row('a1', 'inactive', { frozen: true })], 'idle').stopped === false)
check('a failed member is not waited on', mod.stoppedState([row('lead', 'inactive', { role: 'lead' }), row('a1', 'idle'), row('a2', 'failed')], 'idle').stopped === true)
check('the reminder names both outcomes', /交付/.test(mod.idleReminderText()) && /中断/.test(mod.idleReminderText()))

// ---- the watcher ------------------------------------------------------------
let woken = []
let members = idle
const root = { status: 'idle', followup: (m) => woken.push(m), inject: () => woken.push('quiet') }
const teams = {
  tryMembership: (agent) => (agent === root ? { id: 'team-1', root, name: 'lead' } : undefined),
  listMembers: () => members,
}
let listener
const host = { get: (n) => (n === 'agentTeams' ? teams : undefined), on: (_e, fn) => { listener = fn; return () => {} } }
const ctx = { logger: { info: () => {}, warn: () => {} }, inject: (_deps, cb) => cb(host) }
mod.apply(ctx, { settleMs: 20, retryAfterMs: 1 })
check('a listener was installed', typeof listener === 'function')

listener({ agent: root, status: 'running' })
listener({ agent: root, status: 'idle' })
await sleep(60)
check('the Lead is woken once when the Team stopped', woken.length === 1, String(woken.length))
check('the wake carries a user message', woken[0] !== undefined && woken[0] !== 'quiet')

listener({ agent: root, status: 'running' })
listener({ agent: root, status: 'idle' })
await sleep(60)
check('a fresh stop episode may remind again after the settle window', woken.length === 2, String(woken.length))

members = [row('lead', 'inactive', { role: 'lead' }), row('a1', 'running')]
listener({ agent: root, status: 'running' })
listener({ agent: root, status: 'idle' })
await sleep(60)
check('a working member suppresses the reminder', woken.length === 2, String(woken.length))

members = idle
listener({ agent: root, status: 'running' })
listener({ agent: root, status: 'idle' })
await sleep(60)
check('the next stop episode reminds again', woken.length === 3, String(woken.length))

// ---- durable cap -----------------------------------------------------------
// ---- progress-aware budget -------------------------------------------------
// A Lead that keeps dispatching work but never closes the board used to create a
// fresh stop episode on every quiet period, so the reminder repeated without bound.
// The budget counts only consecutive reminders that saw no deliverable change, so a
// real task advance resets it.
check('progress hash is stable for the same deliverable state',
  mod.idleProgressHash({}) === mod.idleProgressHash({ boards: {} }))
const beforeAdvance = { boards: { global: { tasks: { t1: { id: 't1', status: 'in_progress', revision: 1, evidenceIds: [] } } } } }
const afterAdvance = { boards: { global: { tasks: { t1: { id: 't1', status: 'completed', revision: 2, evidenceIds: ['e1'] } } } } }
check('progress hash changes when a task advances',
  mod.idleProgressHash(beforeAdvance) !== mod.idleProgressHash(afterAdvance))
check('progress hash ignores task creation, claims and revision-only churn',
  mod.idleProgressHash({ boards: {} })
    === mod.idleProgressHash({ boards: { global: { tasks: { t1: { id: 't1', status: 'in_progress', revision: 9, evidenceIds: [] } } } } }))
check('progress hash changes when a room round lands a summary',
  mod.idleProgressHash({ rooms: { r: { roomId: 'r', summary: '' } } })
    !== mod.idleProgressHash({ rooms: { r: { roomId: 'r', summary: 'decided' } } }))
check('progress hash ignores room chatter',
  mod.idleProgressHash({ rooms: { r: { roomId: 'r', summary: 's', messages: [1, 2] } } })
    === mod.idleProgressHash({ rooms: { r: { roomId: 'r', summary: 's', messages: [1, 2, 3, 4] } } }))
const capDir = mkdtempSync(join(tmpdir(), 'dsh-idle-cap-'))
const capWoken = []
const capRoot = { status: 'idle', followup: (m) => capWoken.push(m), inject: () => capWoken.push('quiet') }
let capListener
const capTeams = {
  tryMembership: (agent) => (agent === capRoot ? { id: 'cap-team', root: capRoot, name: 'lead' } : undefined),
  listMembers: () => idle,
}
const capHost = { get: (n) => (n === 'agentTeams' ? capTeams : undefined), on: (_e, fn) => { capListener = fn; return () => {} } }
const stopEpisode = async () => {
  capListener({ agent: capRoot, status: 'running' })
  capListener({ agent: capRoot, status: 'idle' })
  await sleep(60)
}
try {
  mod.apply({ logger: { info: () => {}, warn: () => {} }, inject: (_deps, cb) => cb(capHost) },
    { settleMs: 20, controlDir: capDir, maxNoProgressReminders: 2, maxReminders: 20, retryAfterMs: 1 })
  capListener({ agent: capRoot, status: 'running' })
  capListener({ agent: capRoot, status: 'idle' })
  await sleep(60)
  check('the first stop episode reminds the Lead', capWoken.length === 1, String(capWoken.length))
  await stopEpisode()
  check('a second stop with no deliverable progress still reminds', capWoken.length === 2, String(capWoken.length))
  await stopEpisode()
  check('no-progress stop episodes keep reminding without a lifetime cap', capWoken.length === 3, String(capWoken.length))

  const capControl = controlMod.controlPlaneFor('cap-team', { directory: capDir })
  await capControl.boardCreate({
    boardId: 'global',
    taskId: 'progress-task',
    subject: 'progress',
    description: 'board moved',
    writeScopes: [],
  })
  await capControl.boardUpdate({
    boardId: 'global',
    taskId: 'progress-task',
    expectedRevision: 1,
    action: 'complete',
    actorName: 'lead',
    evidenceIds: ['progress-evidence'],
  })
  await stopEpisode()
  check('deliverable progress still wakes the Lead on the next stop episode',
    capWoken.length === 4, String(capWoken.length))
} finally {
  rmSync(capDir, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
