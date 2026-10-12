const SHARED = 'shared'
import { randomUUID } from 'node:crypto'

const unresolvedSessions = new WeakMap()

function valid(value) {
  if (value === undefined || value === null) return false
  const text = String(value).trim()
  return text.length > 0 && !['unknown', 'undefined', 'null', 'n/a', 'na'].includes(text.toLowerCase())
}

function first(...values) {
  const value = values.find(valid)
  return value === undefined ? SHARED : String(value)
}

// Cordis Context objects are proxies that throw `cannot get property "x" without
// inject` for undeclared properties. Never read a candidate identity field
// directly off a context: probe it behind a guard so an unknown service cannot
// abort the whole tool pipeline.
function read(holder, key) {
  if (holder === null || holder === undefined) return undefined
  if (typeof holder !== 'object' && typeof holder !== 'function') return undefined
  try {
    return holder[key]
  } catch {
    return undefined
  }
}

/** Safe property probe for cordis contexts; shared with sibling plugins. */
export const readProperty = read

function readPath(holder, ...keys) {
  let value = holder
  for (const key of keys) {
    value = read(value, key)
    if (value === undefined || value === null) return value
  }
  return value
}

function sessionFallback(source, agent, context) {
  // Prefer the agent context (stable for the life of a member) over the
  // per-call execution object, so repeated failures still correlate.
  const owner = agent && typeof agent === 'object'
    ? agent : source && typeof source === 'object' ? source : context
  let id = unresolvedSessions.get(owner)
  if (id === undefined) {
    id = 'unresolved:' + randomUUID()
    unresolvedSessions.set(owner, id)
  }
  return id
}

/** Resolve stable storage dimensions without allowing an unknown sentinel. */
export function resolveIdentity(execOrAgent, ctx = {}, config = {}) {
  const source = execOrAgent && typeof execOrAgent === 'object' ? execOrAgent : {}
  const context = ctx && typeof ctx === 'object' ? ctx : {}
  const defaults = config && typeof config === 'object' ? config : {}
  const session = read(source, 'session') ?? read(source, 'execution') ?? {}
  const team = read(source, 'team') ?? read(source, 'agentTeam') ?? {}
  const workspace = read(source, 'workspace') ?? {}
  const agentSource = read(source, 'agent') ?? read(source, 'member')
  const agent = agentSource ?? {}
  const root = read(source, 'root') ?? read(agent, 'root') ?? {}
  const membership = (() => {
    try {
      const lookup = agentSource ?? source
      return read(context, 'agentTeams')?.tryMembership?.(lookup) ?? {}
    } catch { return {} }
  })()
  const teamRoot = membership.root ?? root
  const sessionId = first(read(source, 'sessionId'), read(session, 'id'), read(agent, 'sessionId'),
    readPath(agent, 'session', 'id'), read(agent, 'id'), read(context, 'sessionId'),
    readPath(context, 'session', 'id'), read(membership, 'sessionId'),
    readPath(teamRoot, 'session', 'id'), read(defaults, 'sessionId'))
  return {
    sessionId: sessionId === SHARED ? sessionFallback(source, agentSource, context) : sessionId,
    teamId: first(read(source, 'teamId'), read(team, 'id'), read(membership, 'teamId'), read(membership, 'id'),
      read(teamRoot, 'teamId'), read(teamRoot, 'id'), read(context, 'teamId'), read(defaults, 'teamId')),
    workspaceId: first(read(source, 'workspaceId'), read(workspace, 'id'), read(source, 'cwd'),
      read(agent, 'workspaceId'), readPath(agent, 'workspace', 'id'), read(agent, 'cwd'),
      read(context, 'workspaceId'), readPath(context, 'workspace', 'id'), read(context, 'cwd'),
      read(defaults, 'workspaceId')),
    profile: first(read(source, 'profile'), read(source, 'profileName'), read(agent, 'profile'),
      read(context, 'profile'), read(defaults, 'profile')),
    agentName: first(read(source, 'agentName'), read(source, 'name'), read(agent, 'name'),
      read(membership, 'name'), read(context, 'agentName'), read(defaults, 'agentName')),
    runId: first(read(source, 'runId'), readPath(source, 'run', 'id'), read(agent, 'runId'),
      read(context, 'runId'), read(defaults, 'runId')),
  }
}

export const SHARED_IDENTITY = Object.freeze({
  sessionId: SHARED,
  teamId: SHARED,
  workspaceId: SHARED,
  profile: SHARED,
  agentName: SHARED,
  runId: SHARED,
})
