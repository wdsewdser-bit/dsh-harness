import { windowHash as hash } from './team-v15-window-checkpoint.mjs'

const messageOf = event => event.type === 'user/message' ? event.data : event.data?.message

// This proves a bounded canonical turn, not provider acceptance or an issued certificate.
export function proveCompletedReasoningSpan(source, span, options) {
  try {
    const events = source.events
    if (!Array.isArray(events) || !span.messageIds?.length || span.status !== 'completed') return false
    const selected = span.messageIds.map(id => events.find(event => messageOf(event)?.id === id))
    if (selected.some(event => !event)) return false
    const first = selected[0].seq, last = selected.at(-1).seq
    const start = events.filter(event => event.type === 'turn/start' && event.seq < first).at(-1)
    const end = events.find(event => event.type === 'turn/end' && event.seq > last)
    if (!start || !end || start.data.turn !== end.data.turn || end.data.reason?.kind !== 'completed') return false
    const turn = events.filter(event => event.seq > start.seq && event.seq < end.seq)
    if (turn.some(event => event.type === 'turn/start' || event.type === 'turn/end')) return false
    const group = turn.filter(event => messageOf(event)?.id && !['system', 'developer'].includes(messageOf(event).role))
    // A whole-turn span is the turn's messages exactly. A step range is an unbroken slice of them, still inside one
    // completed turn: the reasoning of a finished turn is not owed to the provider again, slice or whole.
    const offset = group.findIndex(event => messageOf(event).id === span.messageIds[0])
    const covered = span.scope === 'steps' ? (offset < 0 ? [] : group.slice(offset, offset + span.messageIds.length)) : group
    if (hash(covered.map(event => messageOf(event).id)) !== hash(span.messageIds)
      || hash(covered.map(event => ({ seq: event.seq, sha256: hash(event) }))) !== hash(span.eventRefs)) return false
    for (const event of covered) {
      const message = messageOf(event)
      if (hash(message) !== hash(source.messages.find(row => row.id === message.id))) return false
      if (message.role !== 'assistant') continue
      const replay = message.source?.replayState, response = replay?.response
      if (message.source.provider !== options.provider || message.source.model !== options.model
        || response?.kind !== 'pi-ai' || response.version !== 2 || response.api !== 'openai-responses'
        || response.provider !== options.provider || response.model !== options.model
        || !['stop', 'toolUse'].includes(response.stopReason)
        || !Array.isArray(replay.blocks) || replay.blocks.length !== message.content.length) return false
      for (const [index, block] of message.content.entries()) {
        const metadata = replay.blocks[index]
        if (!['text', 'reasoning', 'tool-call'].includes(block.type) || metadata.type !== block.type) return false
        for (const key of ['textSignature', 'thinkingSignature', 'thoughtSignature']) {
          if (metadata[key] !== undefined && typeof metadata[key] !== 'string') return false
        }
        if (metadata.redacted !== undefined && typeof metadata.redacted !== 'boolean') return false
        if (block.type === 'reasoning') {
          if (typeof metadata.thinkingSignature !== 'string') return false
          const signed = JSON.parse(metadata.thinkingSignature)
          if (signed.type !== 'reasoning' || typeof signed.id !== 'string' || !signed.id) return false
        }
      }
    }
    return true
  } catch { return false }
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
