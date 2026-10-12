import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { controlPlaneFor, controlPlaneForMember, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'
import { classifyProviderFailure, apply as applyRuntimeGuard } from '../home/profiles/web/plugins/team-runtime-guard.mjs'
import { inspectHealth } from '../home/profiles/web/plugins/team-health.mjs'

let failed = 0
const check = (label, cond, detail) => {
  if (!cond) failed++
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-team-runtime-'))
const root = { name: 'lead', id: 'lead-id' }
const member = { name: 'member-a', id: 'member-id' }
const memberships = new Map([
  [root, { role: 'lead', name: 'lead', id: 'team-runtime', root }],
  [member, { role: 'teammate', name: 'member-a', id: 'team-runtime', root }],
])
const cp = controlPlaneFor('team-runtime', { directory: dir })

check('transient 429 is not treated as terminal', classifyProviderFailure({ status: 429, provider: 'cmd', failure: { message: 'retry later' } }).permanent === false)
check('a weekly-limit 429 is terminal until its reset', classifyProviderFailure({
  status: 429,
  provider: 'cmd',
  failure: { code: 'RATE_LIMITED', message: "You've reached your weekly usage limit; resets at 2026-09-20T09:30:01.167Z" },
}).permanent === true)
check('auth failure is terminal', classifyProviderFailure({ provider: 'cmd', failure: { status: 401, message: 'invalid api key' } }).permanent === true)

await cp.boardCreate({
  boardId: 'global',
  taskId: 'task-runtime',
  subject: 'runtime',
  description: 'runtime guard',
  phase: 'execution',
  writeScopes: ['src'],
})
const dispatch = await cp.dispatchCreate({ taskId: 'task-runtime', sender: 'lead', target: 'member-a', message: 'run' })
await cp.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'queued' })
await cp.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'delivered' })
await cp.dispatchTransition({ dispatchId: dispatch.dispatchId, status: 'turn-started' })
const lease = await cp.leaseAcquire({ member: 'member-a', taskId: 'task-runtime', dispatchId: dispatch.dispatchId })

const listeners = new Map()
const ctx = {
  agentTeams: { tryMembership: (agent) => memberships.get(agent) },
  on: (event, listener) => {
    listeners.set(event, listener)
    return () => {}
  },
  logger: { warn: () => {}, error: () => {} },
}
applyRuntimeGuard(ctx, { controlDir: dir })
let downstreamCalls = 0
await listeners.get('agent/request-error')({
  agent: member,
  provider: 'cmd',
  failure: { status: 401, message: 'invalid api key' },
}, async () => {
  downstreamCalls++
  return { kind: 'retry' }
})

let snapshot = cp.snapshot()
check('provider failure blocks the control plane', snapshot.provider.status === 'blocked' && snapshot.health.status === 'disabled')
check('terminal provider failure stops retry waterfall', downstreamCalls === 0)
check('active lease is failed', snapshot.leases[lease.runId]?.status === 'failed')
check('running dispatch is failed', snapshot.dispatches[dispatch.dispatchId]?.status === 'run-failed')
check('unfinished task is blocked', snapshot.boards.global.tasks['task-runtime']?.phase === 'blocked')
check('one deterministic escalation is created', Object.keys(snapshot.escalations).length === 1)

await listeners.get('agent/request-error')({
  agent: member,
  provider: 'cmd',
  failure: { status: 401, message: 'invalid api key' },
}, async () => undefined)
snapshot = cp.snapshot()
check('duplicate provider failure does not duplicate escalation', Object.keys(snapshot.escalations).length === 1)

const rejected = await listeners.get('agent/pre-step')(
  { agent: member, messages: [] },
  async () => ({ kind: 'enter', messages: [] }),
)
check('blocked subordinate step is hard rejected', rejected?.kind === 'reject')

const inactiveListeners = new Map()
const inactiveCtx = {
  get agentTeams() {
    throw new Error('cannot get required service "agentTeams" in inactive context')
  },
  on: (event, listener) => {
    inactiveListeners.set(event, listener)
    return () => {}
  },
  logger: { warn: () => {}, error: () => {} },
}
applyRuntimeGuard(inactiveCtx, { controlDir: dir })
const inactiveStep = await inactiveListeners.get('agent/pre-step')(
  { agent: member, messages: [] },
  async () => ({ kind: 'enter', messages: [] }),
)
check('inactive HMR context cannot fail a message turn', inactiveStep?.kind === 'enter')

const resumed = await cp.providerResume({ resumedBy: 'lead' })
check('tier-0 resume clears the provider block', resumed.resumed === true && cp.providerState().status === 'unknown')
let transientDownstreamCalls = 0
await listeners.get('agent/request-error')({
  agent: member,
  provider: 'cmd',
  failure: { status: 429, message: 'retry later' },
}, async () => {
  transientDownstreamCalls++
  return undefined
})
check('transient provider failure reaches retry waterfall', transientDownstreamCalls === 1)

const alternateRoot = { session: { id: 'alternate-root' } }
const mismatchAgent = { name: 'member-b', id: 'member-b-id' }
const mismatchCtx = {
  agentTeams: {
    tryMembership: () => ({ role: 'teammate', name: 'member-b', id: 'stale-team-id', root: alternateRoot }),
  },
}
const alternate = controlPlaneFor('alternate-root', { directory: dir })
await alternate.leaseAcquire({ member: 'member-b', taskId: 'task-runtime' })
check('root-id resolver finds an existing alternate control plane', controlPlaneForMember(mismatchCtx, mismatchAgent, { directory: dir })?.rootId === 'alternate-root')

const roleDir = join(dir, 'team-roles')
const health = inspectHealth({
  pluginDir: join(dir, 'plugins'),
  scopesFile: join(dir, 'scopes.json'),
  rolesDir: roleDir,
  requireRoleFiles: true,
})
check('missing role identities disable health', health.status === 'disabled' && health.reasons.some((reason) => reason.includes('required role identity')))

resetControlPlaneCache()
rmSync(dir, { recursive: true, force: true })
console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
