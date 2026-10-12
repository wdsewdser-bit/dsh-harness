// Read-only audit: run actual v12 hooks against in-memory storage.
// No provider requests, live agents, filesystem mutations, or timers.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const noop = () => {}
const hooks = new Map()
const warnings = []
const mutations = []
const state = {
  rootId: 'audit-memory-only',
  rooms: {
    root: {
      roomId: 'root', members: ['lead', 'm'],
      messages: [{ messageId: 'room-msg-1', author: 'm', content: 'new requirement', createdAt: 1 }],
      latestSummary: 'confirmed summary', unresolved: [{ id: 'u1', text: 'blocker' }],
    },
  },
  rounds: {},
  boards: { group: { tasks: { t1: { id: 't1', revision: 1, subject: 'real task', status: 'pending', ownerName: 'lead' } } } },
  leases: {},
  v12RoomWake: { version: 1, rooms: {}, inbox: {}, wakes: {}, stopEpisodes: {}, sequence: {}, revision: 0 },
  v12Events: [],
}
globalThis.auditControl = {
  snapshot: () => structuredClone(state),
  file: 'memory-only',
  mutate: async (type, data, actor, fn) => { mutations.push(type); return fn(state) },
}

registerHooks({
  resolve(specifier, context, next) {
    const stubs = {
      '@deepseek-ai/dsh-tools': 'export const defineTool = x => x',
      '@deepseek-ai/dsh-llm': 'export const createUserMessage = x => x',
      './team-control-plane.mjs': 'export const controlPlaneFor = () => globalThis.auditControl',
      './team-policy.mjs': 'export const teamKeyOf = () => "audit-memory-only"',
    }
    const source = stubs[specifier]
    return source === undefined ? next(specifier, context)
      : { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
  },
})

const { apply } = await import('../home/profiles/web/plugins/team-v12-runtime.mjs')
const agent = {
  session: { id: 'audit-memory-only', deriveMessages: () => [] },
  ctx: {
    systemPrompt: { getSectionOrder: () => 0, section: () => noop },
    tools: { register: () => noop },
    on: (name, callback) => { hooks.set(name, callback); return noop },
    effect: () => noop,
  },
}
const context = {
  agents: { list: () => [agent] },
  agentTeams: { tryMembership: () => ({ id: 'audit-memory-only', name: 'lead', tier: 0 }) },
  on: () => noop, effect: () => noop,
  logger: { warn: message => warnings.push(message) },
}
// A data: URL cannot resolve to a real local prune-marker file.
apply(context, { controlDir: 'memory-only', pluginDir: 'memory-only', contextPruneMarker: 'data:audit-no-marker' })
const hook = hooks.get('tools/post-execute')
const next = async () => ({ kind: 'accept' })

await hook({ name: 'team_task_create', arguments: { subject: 'real task' } },
  { isError: false, value: { id: 't1', subject: 'real task' }, content: [] }, next)
const missingTaskContract = state.boards.group.tasks.t1.contract === undefined

await hook({ name: 'send_message', arguments: { target: 'm', delivery: 'action', message: 'please resume t1' } },
  { isError: false, value: { messageId: 'msg-real', dispatchId: 'dispatch-real' }, content: [] }, next)
const messageIdIsBody = !!state.v12RoomWake.inbox['please resume t1'] && !state.v12RoomWake.inbox['msg-real']

await hook({ name: 'send_message', arguments: { target: 'm', delivery: 'action', message: 'THIS SEND FAILED' } },
  { isError: true, error: { message: 'policy denied' }, content: [] }, next)
const failedSendCreatesMirror = !!state.v12RoomWake.inbox['THIS SEND FAILED']

await hook({ name: 'team_room_read', arguments: { room_id: 'root' } },
  { isError: false, value: {}, content: [] }, next)
const transcriptStoredButRoomIndexEmpty = state.v12RoomWake.transcripts.root?.length === 1
  && Object.keys(state.v12RoomWake.rooms).length === 0
const traceFailureSkipsDerivedRefresh = state.v12Events.length === 0
  && warnings.some(message => message.includes('correlationId is required'))
  && !mutations.includes('v12/derived-views')
const legacySummaryNotMirrored = !state.v12RoomWake.roundSummaries.root?.length

const defects = { missingTaskContract, messageIdIsBody, failedSendCreatesMirror,
  transcriptStoredButRoomIndexEmpty, traceFailureSkipsDerivedRefresh, legacySummaryNotMirrored }
assert.equal(Object.keys(defects).length, 6)
console.log(JSON.stringify({ observedAt: new Date().toISOString(), defects,
  reproduced: Object.values(defects).filter(Boolean).length,
  warnings: [...new Set(warnings)],
  note: 'Diagnostic booleans indicate reproduced defects, not passing product acceptance. Re-run after fixes; false means this fixture no longer reproduced that defect.' }, null, 2))
