/**
 * Keep the Agent Team mailbox projection bounded.
 *
 * The shipped projection retains every queued message forever, even after the
 * durable delivered acknowledgement arrives. On long-lived Teams that turns
 * the projection into an ever-growing array: every queue copies the whole
 * array and every turn checkpoint serializes it. Delivered messages are no
 * longer needed by the mailbox; the delivered id is enough to deduplicate a
 * replay. This plugin compacts existing live state immediately and keeps the
 * running process compact until the persistent package patch is loaded.
 */
export const name = 'team-agentteam-mailbox-compaction'
export const inject = ['sessions', 'sessionProjections']

function compactState(state) {
  if (!state || !Array.isArray(state.messages) || !Array.isArray(state.delivered)) return undefined
  const before = state.messages.length
  if (before === 0 || state.delivered.length === 0) return { before, after: before }
  const delivered = new Set(state.delivered)
  const next = state.messages.filter((message) => !delivered.has(message.id))
  if (next.length === before) return { before, after: before }
  state.messages = next
  return { before, after: next.length }
}

export function apply(ctx) {
  const compactSession = (session) => {
    try {
      const state = ctx.sessionProjections.stateOf(session, 'agentTeam')
      return compactState(state)
    } catch (error) {
      ctx.logger?.warn?.('[team-agentteam-mailbox-compaction] compact failed for ' + String(session?.id) + ': ' + String(error?.message ?? error))
      return undefined
    }
  }

  const persist = (session) => {
    const cache = ctx.get('sessionProjectionCache')
    if (!cache?.write) return
    Promise.resolve(cache.write(session)).catch((error) => {
      ctx.logger?.warn?.('[team-agentteam-mailbox-compaction] persist failed for ' + String(session?.id) + ': ' + String(error?.message ?? error))
    })
  }

  setImmediate(() => {
    const sessions = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
    let compacted = 0
    for (const session of sessions) {
      const result = compactSession(session)
      if (result !== undefined && result.after < result.before) {
        compacted += 1
        persist(session)
      }
    }
    if (compacted > 0) {
      ctx.logger?.info?.('[team-agentteam-mailbox-compaction] compacted live projections: ' + String(compacted))
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'team/message/delivered') return
    compactSession(session)
  })
}
