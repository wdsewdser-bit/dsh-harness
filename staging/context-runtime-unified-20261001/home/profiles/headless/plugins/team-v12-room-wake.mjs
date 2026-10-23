/**
 * team-v12-room-wake
 *
 * Pure, durable state helpers for v12 Room memory and wake delivery.
 *
 * The module deliberately has no filesystem or Cordis dependency. A caller owns
 * persistence and passes the same state object back into these functions.
 * Every mutation returns a structured result instead of relying on exceptions
 * for expected business refusals.
 */

export const ROOM_WAKE_DOC_VERSION = 1

export const DECISION_STATUSES = Object.freeze(['proposed', 'confirmed', 'superseded', 'revoked'])
export const UNRESOLVED_STATUSES = Object.freeze(['open', 'resolved', 'cancelled'])
export const INBOX_STATUSES = Object.freeze([
  'queued',
  'delivered',
  'injected',
  'handled',
  'deduplicated',
  'delivery-failed',
  'rejected',
])
export const WAKE_STATUSES = Object.freeze([
  'queued',
  'delivered',
  'injected',
  'handled',
  'deduplicated',
  'delivery-failed',
  'rejected',
])
export const WAKE_KINDS = Object.freeze([
  'directed',
  'silent',
  'poll',
  'idle-watch',
  'all-idle',
])
export const STOP_EPISODE_STATUSES = Object.freeze(['open', 'closed'])

const WAKE_TERMINAL = new Set(['handled', 'rejected'])
const WAKE_MERGEABLE = new Set(['queued', 'delivered', 'injected', 'delivery-failed'])
const WAKE_BATCH_MESSAGE_LIMIT = 256
const WAKE_META_LIMIT = 64
const MAX_STORED_MESSAGE_ID_LENGTH = 200

/** Return a value that is safe to mutate as a plain object. */
function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Return a stable array without changing the caller's value. */
function arrayOf(value) {
  return Array.isArray(value) ? value : []
}

/** Keep a stable, bounded tail of unique strings. */
function uniqueStrings(value, limit = Infinity) {
  const rows = []
  const seen = new Set()
  for (const item of arrayOf(value)) {
    const text = stringOf(item)
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    rows.push(text)
  }
  return Number.isFinite(limit) && rows.length > limit ? rows.slice(-limit) : rows
}

/** Legacy callers sometimes put a whole message body in messageId. */
function stableMessageId(value) {
  const text = stringOf(value)
  if (text.length <= MAX_STORED_MESSAGE_ID_LENGTH && !/[\r\n]/.test(text)) return text
  return 'legacy-message:' + stableTextId(text) + ':' + text.length.toString(16)
}

/** Treat legacy list and map encodings uniformly without dropping values. */
function rowsOf(value) {
  if (Array.isArray(value)) return value
  return Object.values(objectOf(value))
}

/** Return a non-empty string or an empty string. */
function stringOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

/** Return a finite number or a fallback. */
function numberOf(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function stableTextId(value) {
  const text = stringOf(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0
  return hash.toString(16).padStart(8, '0')
}

/** Stable JSON copy used for decision revisions and audit snapshots. */
function copyValue(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

/** Structured refusal for expected caller errors. */
function refusal(reason, detail) {
  return detail === undefined
    ? { ok: false, reason }
    : { ok: false, reason, detail }
}

/** Add an audit event without making the event log a second state machine. */
function audit(state, kind, detail) {
  if (!Array.isArray(state.events)) state.events = []
  state.events.push({ kind, at: numberOf(detail?.at, numberOf(state.now, Date.now())), ...objectOf(detail) })
  if (state.events.length > 2000) state.events.splice(0, state.events.length - 2000)
}

/** Bump the document revision after a successful state change. */
function touch(state, detail) {
  state.revision = numberOf(state.revision, 0) + 1
  audit(state, detail?.kind ?? 'state', { revision: state.revision, ...objectOf(detail) })
  return state.revision
}

export function rememberAcknowledgedInbox(state, messageId, entry, at) {
  const id = stringOf(messageId)
  if (id.length === 0) return undefined
  state.acknowledgedInbox = objectOf(state.acknowledgedInbox)
  const prior = state.acknowledgedInbox[id]
  const row = {
    ...objectOf(prior),
    inboxId: id,
    target: stringOf(entry?.target ?? prior?.target),
    status: 'handled',
    handledAt: numberOf(prior?.handledAt, numberOf(at, Date.now())),
    wakeIds: uniqueStrings([
      ...arrayOf(prior?.wakeIds),
      ...arrayOf(entry?.wakeIds),
    ], WAKE_META_LIMIT),
  }
  state.acknowledgedInbox[id] = row
  return row
}

function acknowledgedInboxEvidence(state, messageId) {
  const id = stringOf(messageId)
  const direct = state?.acknowledgedInbox?.[id]
  if (direct !== undefined) return direct
  for (let index = arrayOf(state?.events).length - 1; index >= 0; index -= 1) {
    const event = state.events[index]
    if (event === null || typeof event !== 'object') continue
    if (stringOf(event.messageId) === id && event.kind === 'inbox/handled') {
      return { inboxId: id, status: 'handled', handledAt: numberOf(event.at, 0), source: 'event' }
    }
    if (event.kind === 'wake/handled' && arrayOf(event.messageIds).map(String).includes(id)) {
      return { inboxId: id, status: 'handled', handledAt: numberOf(event.at, 0), source: 'wake-event' }
    }
  }
  return undefined
}

/**
 * Older builds persisted full message bodies in wake.messageIds. Move those
 * bodies into inbox rows and keep only bounded IDs in the hot wake state.
 */
function compactWakeTracking(doc) {
  for (const wake of Object.values(doc.wakes)) {
    if (wake === null || typeof wake !== 'object') continue
    const ids = []
    for (const raw of arrayOf(wake.messageIds)) {
      const original = stringOf(raw)
      const id = stableMessageId(original)
      const acknowledged = doc.acknowledgedInbox?.[id]
      if (id !== original && doc.inbox[id] === undefined) {
        doc.inbox[id] = {
          messageId: id,
          target: stringOf(wake.target),
          sender: 'legacy-wake',
          taskId: null,
          priority: wake.priority ?? 'normal',
          priorityRank: priorityRank(wake.priority),
          originalText: original,
          status: acknowledged !== undefined || WAKE_TERMINAL.has(String(wake.status)) ? 'handled' : 'queued',
          wakeRequested: true,
          wakeIds: [stringOf(wake.wakeId)],
          dedupeKey: stringOf(wake.dedupeKey) || null,
          createdAt: numberOf(wake.createdAt, 0),
          updatedAt: numberOf(wake.updatedAt, numberOf(wake.createdAt, 0)),
          attempts: 0,
          lastError: null,
          ...(acknowledged === undefined ? {} : { handledAt: numberOf(acknowledged.handledAt, 0) }),
        }
      }
      ids.push(id)
    }
    wake.messageIds = uniqueStrings(ids, WAKE_BATCH_MESSAGE_LIMIT)
    wake.dedupeKeys = uniqueStrings(arrayOf(wake.dedupeKeys).map((value) => {
      const text = stringOf(value)
      return text.length <= MAX_STORED_MESSAGE_ID_LENGTH ? text : stableMessageId(text)
    }), WAKE_META_LIMIT)
    wake.reasons = uniqueStrings(arrayOf(wake.reasons).map((value) => stringOf(value).slice(0, 500)), WAKE_META_LIMIT)
    const injected = Boolean(wake.injectionReceipt) || Number(wake.injectedAt) > 0
    for (const id of wake.messageIds) {
      const entry = doc.inbox[id]
      const acknowledged = doc.acknowledgedInbox?.[id]
      if (entry === undefined) {
        doc.inbox[id] = {
          messageId: id,
          target: stringOf(wake.target),
          sender: 'legacy-wake',
          taskId: null,
          priority: wake.priority ?? 'normal',
          priorityRank: priorityRank(wake.priority),
          originalText: '',
          status: acknowledged !== undefined || WAKE_TERMINAL.has(String(wake.status)) ? 'handled' : injected ? 'injected' : 'queued',
          wakeRequested: true,
          wakeIds: [stringOf(wake.wakeId)],
          dedupeKey: stringOf(wake.dedupeKey) || null,
          createdAt: numberOf(wake.createdAt, 0),
          updatedAt: numberOf(wake.updatedAt, numberOf(wake.createdAt, 0)),
          attempts: numberOf(wake.attempts, 0),
          lastError: null,
          ...(acknowledged === undefined ? {} : { handledAt: numberOf(acknowledged.handledAt, 0) }),
          ...(injected ? {
            injectionReceipt: stringOf(wake.injectionReceipt) || null,
            injectedAt: numberOf(wake.injectedAt, 0),
          } : {}),
        }
      } else if (injected && entry.status === 'queued' && (entry.injectionReceipt || entry.injectedAt)) {
        entry.status = 'injected'
      }
      const reconciled = doc.inbox[id]
      if (acknowledged !== undefined && reconciled !== undefined) {
        reconciled.status = 'handled'
        reconciled.handledAt = Math.max(
          Number(reconciled.handledAt ?? 0),
          Number(acknowledged.handledAt ?? 0),
        )
        reconciled.updatedAt = Math.max(Number(reconciled.updatedAt ?? 0), reconciled.handledAt)
      }
    }
  }
}

/** Normalize a room or wake state document without discarding unknown fields. */
export function normalizeRoomWakeState(state) {
  const value = objectOf(state)
  value.version = numberOf(value.version, ROOM_WAKE_DOC_VERSION)
  value.revision = numberOf(value.revision, 0)
  value.rooms = objectOf(value.rooms)
  value.roomAccess = objectOf(value.roomAccess)
  value.roomInjections = objectOf(value.roomInjections)
  value.transcripts = objectOf(value.transcripts)
  value.cursors = objectOf(value.cursors)
  value.roundSummaries = objectOf(value.roundSummaries)
  value.unresolved = objectOf(value.unresolved)
  value.decisions = objectOf(value.decisions)
  value.inbox = objectOf(value.inbox)
  value.acknowledgedInbox = objectOf(value.acknowledgedInbox)
  value.wakes = objectOf(value.wakes)
  value.stopEpisodes = objectOf(value.stopEpisodes)
  value.events = arrayOf(value.events)
  value.sequence = objectOf(value.sequence)
  for (const room of Object.values(value.decisions)) {
    if (room === null || typeof room !== 'object' || Array.isArray(room)) continue
    for (const decision of Object.values(room)) {
      if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) continue
      decision.missingConfirmations = missingConfirmations(decision)
    }
  }
  compactWakeTracking(value)
  return value
}

/** Create the D-phase Room ledger. */
export function createRoomLedger() {
  return normalizeRoomWakeState({
    version: ROOM_WAKE_DOC_VERSION,
    revision: 0,
    rooms: {},
    roomAccess: {},
    roomInjections: {},
    transcripts: {},
    cursors: {},
    roundSummaries: {},
    unresolved: {},
    decisions: {},
    inbox: {},
    wakes: {},
    stopEpisodes: {},
    events: [],
    sequence: {},
  })
}

/** Create the E-phase wake and inbox state. */
export function createWakeState() {
  return createRoomLedger()
}

/** Ensure one Room's storage buckets exist. */
function ensureRoom(state, roomId) {
  const id = stringOf(roomId)
  if (id.length === 0) return undefined
  if (!Array.isArray(state.transcripts[id])) state.transcripts[id] = []
  if (!state.cursors[id] || typeof state.cursors[id] !== 'object') state.cursors[id] = {}
  if (!Array.isArray(state.roundSummaries[id])) state.roundSummaries[id] = []
  if (!state.unresolved[id] || typeof state.unresolved[id] !== 'object') state.unresolved[id] = {}
  if (!state.decisions[id] || typeof state.decisions[id] !== 'object') state.decisions[id] = {}
  return {
    roomId: id,
    transcript: state.transcripts[id],
    cursors: state.cursors[id],
    roundSummaries: state.roundSummaries[id],
    unresolved: state.unresolved[id],
    decisions: state.decisions[id],
  }
}

function roomReadAllowed(state, roomId, memberId) {
  const access = objectOf(state.roomAccess?.[roomId])
  const members = arrayOf(access.members).map(String)
  if (members.length === 0) return true
  return members.includes(stringOf(memberId)) || stringOf(access.host) === stringOf(memberId)
}

export function canReadRoom(state, roomId, memberId) {
  return roomReadAllowed(objectOf(state), stringOf(roomId), memberId)
}

/** Return every Room ID present in either the legacy or v12 stores. */
export function roomIds(state) {
  const value = objectOf(state)
  const keys = new Set()
  for (const bucket of [value.rooms, value.roomAccess, value.transcripts, value.cursors, value.roundSummaries, value.unresolved, value.decisions]) {
    for (const key of Object.keys(objectOf(bucket))) if (String(key).length > 0) keys.add(String(key))
  }
  return [...keys].sort()
}

/**
 * Build a read-only Room index.  The legacy room object is retained as source
 * data; callers can use the counts to decide whether migration is needed.
 */
export function roomIndex(state) {
  const value = objectOf(state)
  const index = {}
  for (const roomId of roomIds(value)) {
    const legacy = objectOf(value.rooms?.[roomId])
    const access = objectOf(value.roomAccess?.[roomId])
    index[roomId] = {
      roomId,
      legacy: value.rooms?.[roomId] !== undefined,
      legacyRevision: numberOf(legacy.revision, 0),
      transcriptCount: arrayOf(value.transcripts?.[roomId]).length || rowsOf(legacy.messages).length,
      summaryCount: arrayOf(value.roundSummaries?.[roomId]).length
        || (stringOf(legacy.summary).length > 0 ? 1 : 0)
        + (legacy.latestSummary ? 1 : 0)
        + Object.values(objectOf(value.rounds)).filter((round) => stringOf(round?.roomId) === roomId && stringOf(round?.summary ?? round?.text).length > 0).length,
      unresolvedCount: Object.keys(objectOf(value.unresolved?.[roomId])).length || rowsOf(legacy.unresolved).length,
      decisionCount: Object.keys(objectOf(value.decisions?.[roomId])).length || rowsOf(legacy.decisions).length,
      members: [...new Set(arrayOf(access.members ?? legacy.members).map(String).filter(Boolean))],
      host: stringOf(access.host ?? legacy.host) || null,
      status: stringOf(legacy.status) || null,
    }
  }
  return index
}

/** Convert one legacy row to the v12 transcript shape without losing fields. */
function legacyMessage(row, roomId, sequence, sourceRevision) {
  const value = objectOf(row)
  const content = stringOf(value.content ?? value.text ?? value.originalText)
  return {
    ...copyValue(value),
    messageId: stringOf(value.messageId ?? value.id) || `${roomId}:legacy-message:${sequence}`,
    roomId,
    sequence,
    author: stringOf(value.author ?? value.sender ?? value.source),
    source: stringOf(value.source ?? value.author ?? value.sender) || 'legacy-room',
    kind: stringOf(value.kind) || 'message',
    content,
    originalText: stringOf(value.originalText ?? content),
    recipients: [...new Set(arrayOf(value.recipients).map(String).filter(Boolean))],
    evidenceLinks: arrayOf(value.evidenceLinks ?? value.references).map(String),
    createdAt: numberOf(value.createdAt, 0),
    revision: numberOf(value.revision, sourceRevision || 1),
    sourceRevision,
    migratedFrom: { store: 'rooms', roomId, field: 'messages', revision: sourceRevision },
  }
}

/**
 * Idempotently mirror legacy `rooms` records into the canonical v12 buckets.
 * Legacy data is never deleted or rewritten.  Existing canonical rows win on
 * conflicting IDs, while a conflict is reported for operator review.
 */
export function migrateLegacyRoomState(state, options = {}) {
  const doc = normalizeRoomWakeState(state)
  const source = objectOf(doc.rooms)
  const migrated = []
  const conflicts = []
  const roomRevisions = {}
  for (const roomId of Object.keys(source)) {
    const legacy = objectOf(source[roomId])
    const sourceRevision = numberOf(legacy.revision, numberOf(doc.revision, 0))
    roomRevisions[roomId] = sourceRevision
    const access = {
      members: [...new Set(arrayOf(legacy.members).map(String).filter(Boolean))],
      host: stringOf(legacy.host) || null,
      sourceRevision,
    }
    if (JSON.stringify(doc.roomAccess[roomId]) !== JSON.stringify(access)) {
      doc.roomAccess[roomId] = access
      migrated.push({ roomId, type: 'access', id: roomId })
    }
    if (!Array.isArray(doc.transcripts[roomId])) doc.transcripts[roomId] = []
    if (!Array.isArray(doc.roundSummaries[roomId])) doc.roundSummaries[roomId] = []
    if (!doc.unresolved[roomId] || typeof doc.unresolved[roomId] !== 'object') doc.unresolved[roomId] = {}
    if (!doc.decisions[roomId] || typeof doc.decisions[roomId] !== 'object') doc.decisions[roomId] = {}

    const byId = new Map(doc.transcripts[roomId].map((row) => [stringOf(row?.messageId), row]))
    for (const row of rowsOf(legacy.messages)) {
      const message = legacyMessage(row, roomId, doc.transcripts[roomId].length + 1, sourceRevision)
      const existing = byId.get(message.messageId)
      if (existing !== undefined) {
        if (stringOf(existing.content) !== message.content) conflicts.push({ roomId, messageId: message.messageId })
        continue
      }
      doc.transcripts[roomId].push(message)
      byId.set(message.messageId, message)
      migrated.push({ roomId, type: 'message', id: message.messageId })
    }

    if (!doc.cursors[roomId] || typeof doc.cursors[roomId] !== 'object') doc.cursors[roomId] = {}
    for (const [memberId, cursor] of Object.entries(objectOf(legacy.cursors))) {
      if (doc.cursors[roomId][memberId] === undefined) doc.cursors[roomId][memberId] = copyValue(cursor)
    }

    const summaries = []
    if (stringOf(legacy.summary).length > 0) summaries.push({
      summaryId: `${roomId}:legacy:summary:${stableTextId(legacy.summary)}`,
      roundId: stringOf(legacy.currentRoundId) || `legacy-${sourceRevision}`,
      summary: legacy.summary,
      closedAt: numberOf(legacy.lastMessageAt, numberOf(legacy.updatedAt, 0)),
      sourceField: 'summary',
    })
    if (stringOf(legacy.latestSummary?.summary ?? legacy.latestSummary?.text ?? legacy.latestSummary).length > 0) {
      const latest = objectOf(legacy.latestSummary)
      summaries.push({
        ...latest,
        summaryId: stringOf(latest.summaryId) || `${roomId}:legacy:latest-summary:${stringOf(latest.roundId) || 'current'}:${stableTextId(latest.summary ?? latest.text ?? legacy.latestSummary)}`,
        roundId: stringOf(latest.roundId) || `legacy-latest-${sourceRevision}`,
        summary: latest.summary ?? latest.text ?? legacy.latestSummary,
        sourceField: 'latestSummary',
      })
    }
    for (const round of Object.values(objectOf(doc.rounds))) {
      if (stringOf(round?.roomId) !== roomId || stringOf(round?.summary).length === 0) continue
      summaries.push({ ...round, summaryId: `${roomId}:legacy:round:${stringOf(round.roundId)}`, sourceField: 'rounds' })
    }
    const knownSummaryIds = new Set(doc.roundSummaries[roomId].map((row) => stringOf(row?.summaryId)))
    for (const raw of summaries) {
      const summaryId = stringOf(raw.summaryId)
      if (knownSummaryIds.has(summaryId)) {
        const existing = doc.roundSummaries[roomId].find((row) => stringOf(row?.summaryId) === summaryId)
        if (stringOf(existing?.summary) !== stringOf(raw.summary)) conflicts.push({ roomId, summaryId })
        continue
      }
      const migratedSummary = {
        ...copyValue(raw),
        summaryId,
        roomId,
        summary: stringOf(raw.summary),
        summaryRevision: numberOf(raw.summaryRevision, doc.roundSummaries[roomId].length + 1),
        decisions: arrayOf(raw.decisions).map(String),
        unresolved: arrayOf(raw.unresolved).map((item) => typeof item === 'string' ? item : stringOf(item?.itemId)),
        source: 'legacy-room',
        sourceRevision,
        migratedFrom: { store: 'rooms', roomId, field: raw.sourceField, revision: sourceRevision },
      }
      doc.roundSummaries[roomId].push(migratedSummary)
      knownSummaryIds.add(summaryId)
      migrated.push({ roomId, type: 'summary', id: summaryId })
    }

    for (const [index, raw] of rowsOf(legacy.unresolved).entries()) {
      const value = typeof raw === 'string' ? { text: raw } : objectOf(raw)
      const itemId = stringOf(value.itemId ?? value.unresolvedId ?? value.id) || `${roomId}:legacy:unresolved:${index + 1}`
      const previous = doc.unresolved[roomId][itemId]
      if (previous !== undefined) {
        if (sourceRevision > numberOf(previous.sourceRevision, 0) || (value.status === 'resolved' && previous.status !== 'resolved')) {
          doc.unresolved[roomId][itemId] = { ...previous, ...copyValue(value), itemId, sourceRevision }
          migrated.push({ roomId, type: 'unresolved-update', id: itemId })
        }
        continue
      }
      doc.unresolved[roomId][itemId] = {
        ...copyValue(value), itemId, roomId, kind: stringOf(value.kind) || 'issue',
        status: stringOf(value.status) || 'open', text: stringOf(value.text ?? value.summary),
        source: 'legacy-room', sourceRevision,
        migratedFrom: { store: 'rooms', roomId, field: 'unresolved', revision: sourceRevision },
        revision: numberOf(value.revision, 1),
      }
      migrated.push({ roomId, type: 'unresolved', id: itemId })
    }

    for (const round of Object.values(objectOf(doc.rounds))) {
      if (stringOf(round?.roomId) !== roomId) continue
      for (const [index, raw] of rowsOf(round.unresolved).entries()) {
        const value = typeof raw === 'string' ? { text: raw } : objectOf(raw)
        const itemId = stringOf(value.itemId ?? value.unresolvedId ?? value.id)
          || `${roomId}:legacy:round:${stringOf(round.roundId)}:unresolved:${index + 1}`
        if (doc.unresolved[roomId][itemId] !== undefined) continue
        doc.unresolved[roomId][itemId] = {
          ...copyValue(value), itemId, roomId, kind: stringOf(value.kind) || 'issue',
          status: stringOf(value.status) || 'open', text: stringOf(value.text ?? value.summary),
          source: 'legacy-round', sourceRevision: numberOf(round.revision, sourceRevision),
          migratedFrom: { store: 'rounds', roomId, roundId: round.roundId, field: 'unresolved', revision: numberOf(round.revision, 1) },
          revision: numberOf(value.revision, 1),
        }
        migrated.push({ roomId, type: 'unresolved', id: itemId })
      }
    }

    for (const [index, raw] of rowsOf(legacy.decisions).entries()) {
      const value = typeof raw === 'string' ? { choice: raw, title: raw } : objectOf(raw)
      const decisionId = stringOf(value.decisionId ?? value.id) || `${roomId}:legacy:decision:${index + 1}`
      if (doc.decisions[roomId][decisionId] !== undefined) continue
      doc.decisions[roomId][decisionId] = {
        ...copyValue(value), decisionId, roomId,
        status: DECISION_STATUSES.includes(stringOf(value.status)) ? value.status : 'proposed',
        source: 'legacy-room', sourceRevision,
        migratedFrom: { store: 'rooms', roomId, field: 'decisions', revision: sourceRevision },
        revision: numberOf(value.revision, 1), revisions: arrayOf(value.revisions),
      }
      migrated.push({ roomId, type: 'decision', id: decisionId })
    }
  }
  if (migrated.length > 0) touch(doc, { kind: 'room/legacy-migrated', rooms: Object.keys(roomRevisions), migrated: migrated.length })
  return {
    ok: true,
    changed: migrated.length > 0,
    migrated,
    conflicts,
    roomRevisions,
    revision: doc.revision,
    preserveLegacy: options.preserveLegacy !== false,
    roomIds: roomIds(doc),
  }
}

/** Find a transcript row by its durable message ID. */
function findMessage(room, messageId) {
  const id = stringOf(messageId)
  if (id.length === 0) return undefined
  return room.transcript.find((message) => stringOf(message?.messageId) === id)
}

/** A message is relevant when it is addressed to the member or is a room broadcast. */
function messageIsRelevant(message, memberId, options = {}) {
  const recipients = arrayOf(message?.recipients).map(String).filter(Boolean)
  if (recipients.length > 0 && !recipients.includes(String(memberId))) return false
  const taskId = stringOf(message?.taskId)
  const requestedTaskId = stringOf(options.taskId)
  if (requestedTaskId.length > 0 && taskId.length > 0 && taskId !== requestedTaskId) return false
  if (Array.isArray(message?.permissions)) {
    const held = new Set(arrayOf(options.permissions).map(String))
    if (!message.permissions.every((permission) => held.has(String(permission)))) return false
  }
  return true
}

/** The sequence carried by a cursor-like value. */
function cursorSequence(room, cursor) {
  if (cursor === undefined || cursor === null) return 0
  if (typeof cursor === 'number' && Number.isFinite(cursor)) return Math.max(0, Math.floor(cursor))
  if (typeof cursor === 'string') {
    const found = findMessage(room, cursor)
    return found === undefined ? undefined : numberOf(found.sequence, 0)
  }
  if (typeof cursor === 'object') {
    if (typeof cursor.messageId === 'string') {
      const found = findMessage(room, cursor.messageId)
      if (found !== undefined) return numberOf(found.sequence, 0)
    }
    if (Number.isFinite(Number(cursor.sequence))) return Math.max(0, Math.floor(Number(cursor.sequence)))
  }
  return undefined
}

/** Return the current member cursor, or a zero cursor when no read has happened. */
export function getRoomCursor(state, roomId, memberId) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const member = stringOf(memberId)
  if (member.length === 0) return refusal('member-id-required')
  const cursor = room.cursors[member]
  return cursor === undefined
    ? { ok: true, cursor: { messageId: null, sequence: 0 }, found: false }
    : { ok: true, cursor: copyValue(cursor), found: true }
}

/**
 * Append one immutable transcript row.
 *
 * Repeating the same message ID is idempotent and never creates a second row.
 * The source, original text, task, recipients, priority and evidence are kept
 * separate from summaries and decisions.
 */
export function appendRoomMessage(state, input) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const room = ensureRoom(doc, row.roomId)
  if (room === undefined) return refusal('room-id-required')
  const messageId = stringOf(row.messageId)
  if (messageId.length === 0) return refusal('message-id-required')
  const existing = findMessage(room, messageId)
  if (existing !== undefined) {
    const contentProvided = row.content !== undefined || row.text !== undefined
    const authorProvided = row.author !== undefined || row.source !== undefined
    const same = (!contentProvided || stringOf(existing.content) === stringOf(row.content ?? row.text))
      && (!authorProvided || stringOf(existing.author ?? existing.source) === stringOf(row.author ?? row.source))
    return same
      ? { ok: true, deduplicated: true, message: copyValue(existing), revision: doc.revision }
      : refusal('message-id-conflict', { messageId })
  }
  const content = stringOf(row.content ?? row.text)
  if (content.length === 0) return refusal('message-content-required')
  const sequence = room.transcript.length + 1
  const message = {
    messageId,
    roomId: room.roomId,
    sequence,
    author: stringOf(row.author ?? row.source),
    source: stringOf(row.source ?? row.author),
    kind: stringOf(row.kind) || 'message',
    content,
    originalText: stringOf(row.originalText ?? content),
    taskId: stringOf(row.taskId) || null,
    recipients: [...new Set(arrayOf(row.recipients).map(String).filter(Boolean))],
    priority: row.priority ?? 'normal',
    evidenceLinks: arrayOf(row.evidenceLinks).map(String),
    createdAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    revision: doc.revision + 1,
    correctionOf: stringOf(row.correctionOf) || null,
  }
  room.transcript.push(message)
  touch(doc, { kind: 'room/message-appended', roomId: room.roomId, messageId, sequence })
  return { ok: true, deduplicated: false, message: copyValue(message), revision: doc.revision }
}

/** Alias used by callers that prefer an explicit verb. */
export const addRoomMessage = appendRoomMessage

/** Return transcript rows for one Room, optionally paged. */
export function getRoomTranscript(state, roomId, options = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, options.memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const cursor = cursorSequence(room, options.cursor ?? options.after ?? options.since)
  if (cursor === undefined) return refusal('cursor-out-of-range')
  const before = options.before !== undefined || options.direction === 'before'
  const selected = options.cursor !== undefined || options.after !== undefined || options.since !== undefined || before
    ? room.transcript.filter((message) => before
      ? numberOf(message.sequence, 0) < cursor
      : numberOf(message.sequence, 0) > cursor)
    : room.transcript
  const visible = selected.filter((message) => messageIsRelevant(message, options.memberId, options))
  const offset = Math.max(0, Math.floor(numberOf(options.offset, 0)))
  const limit = Math.max(0, Math.floor(numberOf(options.limit, room.transcript.length)))
  const messages = visible.slice(offset, offset + limit).map(copyValue)
  const last = messages[messages.length - 1]
  return {
    ok: true,
    roomId: room.roomId,
    revision: doc.revision,
    total: room.transcript.length,
    messages,
    nextCursor: last ? { messageId: last.messageId, sequence: last.sequence } : null,
    hasMore: visible.length > offset + messages.length,
  }
}

/** Read the hot tail and an optional historical cursor window in one call. */
export function readRoomMessages(state, roomId, options = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, options.memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const hotLimit = Math.max(0, Math.floor(numberOf(options.hotLimit ?? options.recentLimit, 20)))
  const historyLimit = Math.max(0, Math.floor(numberOf(options.historyLimit ?? options.limit, 50)))
  const visible = room.transcript.filter((message) => messageIsRelevant(message, options.memberId, options))
  const hot = visible.slice(Math.max(0, visible.length - hotLimit)).map(copyValue)
  const cursor = cursorSequence(room, options.cursor)
  if (cursor === undefined) return refusal('cursor-out-of-range')
  const historicalRows = options.cursor === undefined
    ? []
    : visible.filter((message) => numberOf(message.sequence, 0) < cursor).slice(-historyLimit)
  const historical = historicalRows.map(copyValue)
  const last = historicalRows[historicalRows.length - 1]
  return {
    ok: true,
    roomId: room.roomId,
    revision: doc.revision,
    hot,
    historical,
    nextCursor: last ? { messageId: last.messageId, sequence: last.sequence } : null,
    hasMoreHistorical: last ? visible.some((message) => numberOf(message.sequence, 0) < last.sequence) : false,
  }
}

export const queryRoomMessages = readRoomMessages

/**
 * Return only relevant transcript rows after a member's durable cursor.
 *
 * The cursor is advanced by advanceRoomCursor after the rows have actually
 * entered the member's context. Reading never advances it.
 */
export function listRoomMessagesSince(state, roomId, memberId, options = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const member = stringOf(memberId)
  if (member.length === 0) return refusal('member-id-required')
  const cursor = options.cursor === undefined ? room.cursors[member] : options.cursor
  const sequence = cursorSequence(room, cursor)
  if (sequence === undefined) return refusal('cursor-out-of-range')
  if (sequence > room.transcript.length) return refusal('cursor-out-of-range')
  const allMessages = room.transcript
    .filter((message) => numberOf(message.sequence, 0) > sequence)
    .filter((message) => messageIsRelevant(message, member, options))
  const requestedLimit = options.max ?? options.limit
  const bounded = requestedLimit !== undefined && Number.isFinite(Number(requestedLimit))
    ? Math.max(0, Math.floor(Number(requestedLimit)))
    : undefined
  const selected = bounded === undefined || allMessages.length <= bounded
    ? allMessages
    : bounded === 0 ? [] : allMessages.slice(-bounded)
  const messages = selected.map(copyValue)
  return {
    ok: true,
    roomId: room.roomId,
    memberId: member,
    cursor: copyValue(cursor ?? { messageId: null, sequence: 0 }),
    messages,
    messageIds: messages.map((message) => message.messageId),
    nextCursor: messages.length === 0 ? null : {
      messageId: messages[messages.length - 1].messageId,
      sequence: messages[messages.length - 1].sequence,
    },
    hasMore: bounded !== undefined && allMessages.length > selected.length
      ? true
      : messages.length > 0 && numberOf(messages[messages.length - 1].sequence, 0) < room.transcript.length,
    truncated: bounded !== undefined && allMessages.length > selected.length,
  }
}

/** Alias for callers using the shorter Room vocabulary. */
export const roomMessagesSince = listRoomMessagesSince

/** Persist a successful context-injection receipt before advancing a cursor. */
export function markRoomMessagesInjected(state, roomId, memberId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const member = stringOf(memberId)
  const receipt = stringOf(input.receipt ?? input.injectionReceipt)
  const ids = [...new Set(arrayOf(input.messageIds).map(String).filter(Boolean))]
  if (!member) return refusal('member-id-required')
  if (!receipt) return refusal('injection-receipt-required')
  if (ids.length === 0) return refusal('message-ids-required')
  const unknown = ids.find((id) => findMessage(room, id) === undefined)
  if (unknown !== undefined) return refusal('message-not-found', { messageId: unknown })
  if (!doc.roomInjections[room.roomId]) doc.roomInjections[room.roomId] = {}
  if (!doc.roomInjections[room.roomId][member]) doc.roomInjections[room.roomId][member] = {}
  const recorded = doc.roomInjections[room.roomId][member]
  const updatedAt = numberOf(input.injectedAt, numberOf(doc.now, Date.now()))
  const additions = []
  const receiptUpdates = []
  for (const id of ids) {
    if (recorded[id] === undefined) {
      recorded[id] = { receipt, firstReceipt: receipt, injectedAt: updatedAt, lastReceipt: receipt, lastInjectedAt: updatedAt }
      additions.push(id)
      continue
    }
    const entry = recorded[id]
    if (entry.lastReceipt === receipt || entry.receipt === receipt) continue
    entry.lastReceipt = receipt
    entry.lastInjectedAt = updatedAt
    receiptUpdates.push(id)
  }
  if (additions.length === 0 && receiptUpdates.length === 0) return { ok: true, deduplicated: true, messageIds: ids, receipt }
  touch(doc, { kind: 'room/messages-injected', roomId: room.roomId, memberId: member, messageIds: [...additions, ...receiptUpdates] })
  return { ok: true, deduplicated: additions.length === 0, updated: receiptUpdates.length > 0, messageIds: ids, receipt }
}

export const recordRoomInjection = markRoomMessagesInjected

/**
 * Advance one member cursor after a batch was successfully included.
 *
 * The batch must cover every row from the current cursor to the target. This
 * prevents a later message from skipping an undelivered earlier row. A cursor
 * can never point past the transcript tail, and repeating an old batch is
 * idempotent.
 */
export function advanceRoomCursor(state, roomId, memberId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const member = stringOf(memberId)
  if (member.length === 0) return refusal('member-id-required')
  const requested = [...arrayOf(input.messageIds ?? input.messages)]
  if (input.messageId !== undefined) requested.push(input.messageId)
  const ids = [...new Set(requested.map(String).filter(Boolean))]
  if (ids.length === 0) return refusal('message-ids-required')
  if (input.requireInjection === true) {
    const injected = objectOf(doc.roomInjections?.[room.roomId]?.[member])
    const missing = ids.find((id) => injected[id] === undefined)
    if (missing !== undefined) return refusal('message-not-injected', { messageId: missing })
  }
  const rows = ids.map((messageId) => ({ messageId, message: findMessage(room, messageId) }))
  const unknown = rows.find((row) => row.message === undefined)
  if (unknown !== undefined) return refusal('cursor-out-of-range', { messageId: unknown.messageId })
  const current = cursorSequence(room, room.cursors[member])
  if (current === undefined) return refusal('cursor-invalid')
  const sequences = [...new Set(rows.map((row) => numberOf(row.message.sequence, 0)))].sort((a, b) => a - b)
  const targetSequence = sequences[sequences.length - 1]
  if (targetSequence <= current) {
    return {
      ok: true,
      deduplicated: true,
      cursor: copyValue(room.cursors[member] ?? { messageId: null, sequence: 0 }),
      advanced: false,
    }
  }
  const delivered = new Set(sequences)
  const injected = input.requireInjection === true ? objectOf(doc.roomInjections?.[room.roomId]?.[member]) : {}
  for (let sequence = current + 1; sequence <= targetSequence; sequence += 1) {
    if (delivered.has(sequence)) continue
    const skipped = room.transcript[sequence - 1]
    // A member may skip rows that were not addressed to it. Rows relevant to
    // this member still have to be acknowledged before the cursor can pass them.
    if (messageIsRelevant(skipped, member, input)
      && (input.requireInjection !== true || injected[skipped.messageId] === undefined)) {
      return refusal('cursor-gap', { missingSequence: sequence })
    }
  }
  const target = room.transcript[targetSequence - 1]
  const cursor = {
    messageId: target.messageId,
    sequence: targetSequence,
    updatedAt: numberOf(input.updatedAt, numberOf(doc.now, Date.now())),
  }
  room.cursors[member] = cursor
  touch(doc, {
    kind: 'room/cursor-advanced',
    roomId: room.roomId,
    memberId: member,
    fromSequence: current,
    toSequence: targetSequence,
  })
  return { ok: true, deduplicated: false, cursor: copyValue(cursor), advanced: true }
}

/** Alias matching the wording in the v12 plan. */
export const advanceMemberCursor = advanceRoomCursor

/** Append a decision revision snapshot before mutating the live decision. */
function reviseDecision(state, decision, changes, kind) {
  if (!Array.isArray(decision.revisions)) decision.revisions = []
  decision.revisions.push(copyValue({ ...decision, revisions: undefined }))
  Object.assign(decision, changes)
  decision.revision = numberOf(decision.revision, 1) + 1
  touch(state, { kind, decisionId: decision.decisionId, revision: decision.revision })
  return decision
}

function confirmationMembers(input) {
  return [...new Set(arrayOf(
    input?.requiredConfirmations
      ?? input?.required_confirmations
      ?? input?.confirmationsRequired
      ?? input?.confirmations_required,
  ).map(stringOf).filter(Boolean))]
}

function confirmationRows(input) {
  return arrayOf(input?.confirmations).map((row) => {
    if (typeof row === 'string') return { member: stringOf(row) }
    return {
      member: stringOf(row?.member ?? row?.confirmedBy ?? row?.by),
      at: numberOf(row?.at ?? row?.confirmedAt, 0),
      rationale: stringOf(row?.rationale),
      evidenceLinks: arrayOf(row?.evidenceLinks).map(String),
    }
  }).filter((row) => row.member.length > 0)
}

function missingConfirmations(decision) {
  const confirmed = new Set(arrayOf(decision?.confirmations).map((row) => stringOf(row?.member)).filter(Boolean))
  return arrayOf(decision?.requiredConfirmations).map(stringOf).filter((member) => member && !confirmed.has(member))
}

function decisionVerdict(decision, extra = {}) {
  const missing = missingConfirmations(decision)
  return {
    ok: true,
    deduplicated: false,
    decision: copyValue(decision),
    requiredConfirmations: copyValue(decision.requiredConfirmations ?? []),
    missingConfirmations: missing,
    fullyConfirmed: decision.status === 'confirmed',
    ...extra,
  }
}

/**
 * Record a proposed decision. Only explicit confirmation moves it into the
 * effective decision set.
 */
export function proposeDecision(state, input) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const room = ensureRoom(doc, row.roomId)
  if (room === undefined) return refusal('room-id-required')
  const decisionId = stringOf(row.decisionId)
  if (decisionId.length === 0) return refusal('decision-id-required')
  const existing = room.decisions[decisionId]
  if (existing !== undefined) {
    const sourceProvided = row.sourceMessageId !== undefined
    const sameSource = !sourceProvided || stringOf(existing.sourceMessageId) === stringOf(row.sourceMessageId)
    return sameSource
      ? { ok: true, deduplicated: true, decision: copyValue(existing) }
      : refusal('decision-id-conflict', { decisionId })
  }
  const decision = {
    decisionId,
    roomId: room.roomId,
    sourceMessageId: stringOf(row.sourceMessageId),
    title: stringOf(row.title ?? row.choice),
    choice: stringOf(row.choice ?? row.title),
    rationale: stringOf(row.rationale),
    taskId: stringOf(row.taskId) || null,
    scope: stringOf(row.scope) || room.roomId,
    owner: stringOf(row.owner),
    status: 'proposed',
    revision: 1,
    proposedBy: stringOf(row.proposedBy ?? row.author),
    proposedAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    confirmedBy: null,
    confirmedAt: null,
    requiredConfirmations: confirmationMembers(row),
    confirmations: confirmationRows(row),
    supersededBy: null,
    revokedBy: null,
    evidenceLinks: arrayOf(row.evidenceLinks).map(String),
    revisions: [],
  }
  decision.missingConfirmations = missingConfirmations(decision)
  room.decisions[decisionId] = decision
  touch(doc, { kind: 'room/decision-proposed', roomId: room.roomId, decisionId })
  return { ok: true, deduplicated: false, decision: copyValue(decision) }
}

/** Explicitly confirm a proposed decision. */
export function confirmDecision(state, roomId, decisionId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const decision = room.decisions[stringOf(decisionId)]
  if (decision === undefined) return refusal('decision-not-found')
  if (decision.status === 'confirmed') {
    return decisionVerdict(decision, { deduplicated: true })
  }
  if (decision.status === 'superseded' || decision.status === 'revoked') {
    return refusal('decision-inactive', { status: decision.status })
  }
  const confirmedBy = stringOf(input.confirmedBy ?? input.by)
  const required = confirmationMembers(decision.requiredConfirmations ? {
    requiredConfirmations: decision.requiredConfirmations,
  } : input)
  const existingConfirmations = confirmationRows(decision)
  const prior = existingConfirmations.find((row) => row.member === confirmedBy)
  const nextConfirmation = confirmedBy.length === 0 ? null : {
    member: confirmedBy,
    at: numberOf(input.confirmedAt, numberOf(doc.now, Date.now())),
    rationale: stringOf(input.rationale),
    evidenceLinks: arrayOf(input.evidenceLinks).map(String),
  }
  if (required.length > 1 && confirmedBy.length > 0 && !required.includes(confirmedBy)) {
    return refusal('confirmation-not-required', {
      decisionId: decision.decisionId,
      requiredConfirmations: required,
      missingConfirmations: missingConfirmations(decision),
    })
  }
  const confirmations = prior !== undefined
    ? existingConfirmations
    : nextConfirmation === null
      ? existingConfirmations
      : [...existingConfirmations, nextConfirmation]
  const missing = required.filter((member) => !confirmations.some((row) => row.member === member))
  const fullyConfirmed = required.length <= 1 || missing.length === 0
  const revised = reviseDecision(doc, decision, {
    status: fullyConfirmed ? 'confirmed' : 'proposed',
    requiredConfirmations: required,
    confirmations,
    missingConfirmations: missing,
    confirmedBy: fullyConfirmed ? stringOf(confirmations[0]?.member ?? confirmedBy) || null : null,
    confirmedAt: fullyConfirmed
      ? numberOf(input.confirmedAt, numberOf(doc.now, Date.now()))
      : null,
    scope: stringOf(input.scope) || decision.scope,
    owner: stringOf(input.owner) || decision.owner,
    sourceMessageId: stringOf(input.sourceMessageId) || decision.sourceMessageId,
  }, fullyConfirmed ? 'room/decision-confirmed' : 'room/decision-confirmation-recorded')
  return decisionVerdict(revised, {
    deduplicated: prior !== undefined && nextConfirmation !== null,
  })
}

/** Mark an old decision as superseded by a replacement decision ID. */
export function supersedeDecision(state, roomId, decisionId, replacementDecisionId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const decision = room.decisions[stringOf(decisionId)]
  if (decision === undefined) return refusal('decision-not-found')
  const replacement = stringOf(replacementDecisionId)
  if (replacement.length === 0) return refusal('replacement-decision-id-required')
  if (room.decisions[replacement] === undefined) return refusal('replacement-decision-not-found')
  if (decision.status === 'superseded' && decision.supersededBy === replacement) {
    return { ok: true, deduplicated: true, decision: copyValue(decision) }
  }
  if (decision.status === 'revoked') return refusal('decision-inactive', { status: decision.status })
  const revised = reviseDecision(doc, decision, {
    status: 'superseded',
    supersededBy: replacement,
    supersededAt: numberOf(input.supersededAt, numberOf(doc.now, Date.now())),
    supersededReason: stringOf(input.reason),
  }, 'room/decision-superseded')
  return { ok: true, deduplicated: false, decision: copyValue(revised) }
}

/** Create and optionally confirm a replacement, then retire the old decision. */
export function replaceDecision(state, roomId, decisionId, replacementInput) {
  const created = proposeDecision(state, { ...objectOf(replacementInput), roomId })
  if (created.ok !== true) return created
  let replacement = created.decision
  if (replacementInput?.confirmed === true) {
    const confirmed = confirmDecision(state, roomId, created.decision.decisionId, replacementInput)
    if (confirmed.ok !== true) return confirmed
    replacement = confirmed.decision
  }
  const retired = supersedeDecision(
    state,
    roomId,
    decisionId,
    created.decision.decisionId,
    replacementInput,
  )
  if (retired.ok !== true) return retired
  return { ok: true, decision: retired.decision, replacement }
}

/** Revoke a decision without deleting its history. */
export function revokeDecision(state, roomId, decisionId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const decision = room.decisions[stringOf(decisionId)]
  if (decision === undefined) return refusal('decision-not-found')
  if (decision.status === 'revoked') return { ok: true, deduplicated: true, decision: copyValue(decision) }
  if (decision.status === 'superseded') return refusal('decision-inactive', { status: decision.status })
  const revised = reviseDecision(doc, decision, {
    status: 'revoked',
    revokedBy: stringOf(input.revokedBy ?? input.by),
    revokedAt: numberOf(input.revokedAt, numberOf(doc.now, Date.now())),
    revokedReason: stringOf(input.reason),
  }, 'room/decision-revoked')
  return { ok: true, deduplicated: false, decision: copyValue(revised) }
}

/** Return confirmed, non-superseded and non-revoked decisions. */
export function effectiveDecisions(state, roomId, options = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, options.memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const taskId = stringOf(options.taskId)
  const scope = stringOf(options.scope)
  const decisions = Object.values(room.decisions)
    .filter((decision) => decision?.status === 'confirmed')
    .filter((decision) => taskId.length === 0 || !decision.taskId || decision.taskId === taskId)
    .filter((decision) => scope.length === 0 || !decision.scope || decision.scope === scope)
    .sort((a, b) => numberOf(b.revision, 0) - numberOf(a.revision, 0))
    .map(copyValue)
  return { ok: true, decisions }
}

/**
 * Project every decision row through one lossless, status-explicit shape.
 * Unlike effectiveDecisions, this is a read model: proposed rows must remain
 * visible so callers can confirm them instead of concluding they do not exist.
 */
export function projectRoomDecisions(decisions, options = {}) {
  const source = Array.isArray(decisions) ? decisions : Object.values(objectOf(decisions))
  const includeInactive = options.includeInactive !== false
  const rows = source
    .filter((decision) => decision !== null && typeof decision === 'object' && !Array.isArray(decision))
    .filter((decision) => stringOf(decision.decisionId).length > 0)
    .filter((decision) => includeInactive || !['superseded', 'revoked'].includes(stringOf(decision.status)))
    .map((decision) => ({
      ...copyValue(decision),
      decisionId: stringOf(decision.decisionId),
      status: stringOf(decision.status) || 'proposed',
      title: stringOf(decision.title),
      choice: stringOf(decision.choice),
      rationale: stringOf(decision.rationale),
      references: arrayOf(decision.references).map(String),
      decidedBy: decision.decidedBy ?? null,
      requiredConfirmations: arrayOf(decision.requiredConfirmations).map(String),
      confirmations: copyValue(arrayOf(decision.confirmations)),
      missingConfirmations: missingConfirmations(decision),
      confirmedBy: decision.confirmedBy ?? null,
      confirmedAt: numberOf(decision.confirmedAt, 0) || null,
      createdAt: numberOf(decision.createdAt, 0) || null,
      revision: numberOf(decision.revision, 1),
    }))
    .sort((left, right) => numberOf(left.createdAt, 0) - numberOf(right.createdAt, 0)
      || left.revision - right.revision
      || left.decisionId.localeCompare(right.decisionId))
  const statuses = {}
  for (const row of rows) statuses[row.status] = Number(statuses[row.status] ?? 0) + 1
  return {
    decisions: rows,
    projection: {
      total: source.length,
      returned: rows.length,
      truncated: false,
      statuses,
    },
  }
}

/** Return proposed decisions that still need one or more lead confirmations. */
export function pendingDecisionConfirmations(state, roomId, options = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, options.memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const decisions = Object.values(room.decisions)
    .filter((decision) => decision?.status === 'proposed')
    .map((decision) => ({
      decisionId: decision.decisionId,
      title: decision.title,
      choice: decision.choice,
      requiredConfirmations: arrayOf(decision.requiredConfirmations).map(String),
      confirmations: copyValue(decision.confirmations ?? []),
      missingConfirmations: missingConfirmations(decision),
      revision: numberOf(decision.revision, 1),
    }))
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId))
  return { ok: true, decisions }
}

/**
 * Record an explicit risk, issue, question or decision request.
 *
 * Ordinary discussion text is never promoted automatically. A caller must
 * provide a kind and text to create an unresolved item.
 */
export function recordUnresolved(state, input) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const room = ensureRoom(doc, row.roomId)
  if (room === undefined) return refusal('room-id-required')
  const itemId = stringOf(row.itemId ?? row.unresolvedId)
  if (itemId.length === 0) return refusal('unresolved-id-required')
  const existing = room.unresolved[itemId]
  if (existing !== undefined) {
    const textProvided = row.text !== undefined || row.summary !== undefined
    return !textProvided || stringOf(existing.text) === stringOf(row.text ?? row.summary)
      ? { ok: true, deduplicated: true, item: copyValue(existing) }
      : refusal('unresolved-id-conflict', { itemId })
  }
  const text = stringOf(row.text ?? row.summary)
  if (text.length === 0) return refusal('unresolved-text-required')
  const item = {
    itemId,
    roomId: room.roomId,
    kind: stringOf(row.kind) || 'issue',
    status: 'open',
    text,
    sourceMessageId: stringOf(row.sourceMessageId),
    owner: stringOf(row.owner),
    taskId: stringOf(row.taskId) || null,
    createdAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    resolvedAt: null,
    resolution: null,
    revision: 1,
  }
  room.unresolved[itemId] = item
  touch(doc, { kind: 'room/unresolved-recorded', roomId: room.roomId, itemId })
  return { ok: true, deduplicated: false, item: copyValue(item) }
}

/** Resolve an explicit unresolved item while retaining its original text. */
export function resolveUnresolved(state, roomId, itemId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const item = room.unresolved[stringOf(itemId)]
  if (item === undefined) return refusal('unresolved-not-found')
  if (item.status === 'resolved') return { ok: true, deduplicated: true, item: copyValue(item) }
  item.status = 'resolved'
  item.resolution = stringOf(input.resolution)
  item.resolvedAt = numberOf(input.resolvedAt, numberOf(doc.now, Date.now()))
  item.revision = numberOf(item.revision, 1) + 1
  touch(doc, { kind: 'room/unresolved-resolved', roomId: room.roomId, itemId: item.itemId })
  return { ok: true, deduplicated: false, item: copyValue(item) }
}

/** Return open or resolved unresolved items for one Room. */
export function listUnresolved(state, roomId, options = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, options.memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const includeResolved = options.includeResolved === true
  const items = Object.values(room.unresolved)
    .filter((item) => includeResolved || item?.status === 'open')
    .map(copyValue)
  return { ok: true, items }
}

/**
 * Close a Room round with a structured, revisioned summary.
 *
 * This writes a separate round-summary record. It never edits transcript rows
 * and never confirms decisions implicitly.
 */
export function closeRoomRound(state, input) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const room = ensureRoom(doc, row.roomId)
  if (room === undefined) return refusal('room-id-required')
  const roundId = stringOf(row.roundId)
  if (roundId.length === 0) return refusal('round-id-required')
  const summaryText = stringOf(row.summary)
  const existing = room.roundSummaries.find((summary) => stringOf(summary.roundId) === roundId)
  if (existing !== undefined) {
    return summaryText.length === 0 || stringOf(existing.summary) === summaryText
      ? { ok: true, deduplicated: true, summary: copyValue(existing) }
      : refusal('round-summary-conflict', { roundId })
  }
  if (summaryText.length === 0) return refusal('round-summary-required')
  const unresolvedIds = []
  for (const unresolved of arrayOf(row.unresolved)) {
    if (typeof unresolved === 'string') {
      if (room.unresolved[unresolved] !== undefined) unresolvedIds.push(unresolved)
      continue
    }
    const recorded = recordUnresolved(doc, { roomId: room.roomId, ...objectOf(unresolved) })
    if (recorded.ok === true) unresolvedIds.push(recorded.item.itemId)
  }
  const summary = {
    summaryId: stringOf(row.summaryId) || room.roomId + ':' + roundId,
    roomId: room.roomId,
    roundId,
    summaryRevision: room.roundSummaries.length + 1,
    summary: summaryText,
    decisions: arrayOf(row.decisions).map(String),
    disagreements: arrayOf(row.disagreements).map(String),
    unresolved: [...new Set(unresolvedIds)],
    owners: [...new Set(arrayOf(row.owners).map(String).filter(Boolean))],
    nextSteps: arrayOf(row.nextSteps).map(String),
    evidenceLinks: arrayOf(row.evidenceLinks).map(String),
    sourceMessageIds: [...new Set(arrayOf(row.sourceMessageIds).map(String).filter(Boolean))],
    closedAt: numberOf(row.closedAt, numberOf(doc.now, Date.now())),
  }
  room.roundSummaries.push(summary)
  touch(doc, { kind: 'room/round-closed', roomId: room.roomId, roundId, summaryRevision: summary.summaryRevision })
  return { ok: true, deduplicated: false, summary: copyValue(summary) }
}

/** Alias used by callers that describe the operation as a summary. */
export const summarizeRoomRound = closeRoomRound

/** Build the durable facts needed after a restart or compaction. */
export function buildRoomRecoverySnapshot(state, roomId, memberId, options = {}) {
  const doc = normalizeRoomWakeState(state)
  if (!roomReadAllowed(doc, roomId, memberId)) return refusal('room-access-denied')
  const room = ensureRoom(doc, roomId)
  if (room === undefined) return refusal('room-id-required')
  const summaries = room.roundSummaries.map(copyValue).sort((a, b) =>
    numberOf(a.closedAt ?? a.summaryAt, 0) - numberOf(b.closedAt ?? b.summaryAt, 0)
      || numberOf(a.summaryRevision, 0) - numberOf(b.summaryRevision, 0))
  const latestSummary = summaries.length === 0 ? null : summaries[summaries.length - 1]
  const decisionProjection = projectRoomDecisions(room.decisions)
  const unresolved = listUnresolved(doc, room.roomId, { memberId })
  const cursor = getRoomCursor(doc, room.roomId, memberId)
  const messages = listRoomMessagesSince(doc, room.roomId, memberId, options)
  return {
    ok: true,
    roomId: room.roomId,
    memberId: stringOf(memberId),
    revision: doc.revision,
    latestSummary,
    decisions: decisionProjection.decisions,
    pendingDecisions: decisionProjection.decisions.filter((decision) => decision.status === 'proposed'),
    decisionProjection: decisionProjection.projection,
    unresolved: unresolved.ok === true ? unresolved.items : [],
    cursor: cursor.ok === true ? cursor.cursor : { messageId: null, sequence: 0 },
    messages: messages.ok === true ? messages.messages : [],
  }
}

/** Normalize a priority for ordering while preserving the caller's value. */
function priorityRank(priority) {
  if (typeof priority === 'number' && Number.isFinite(priority)) return priority
  const value = stringOf(priority).toLowerCase()
  if (value === 'urgent' || value === 'critical' || value === 'high') return 300
  if (value === 'low' || value === 'silent') return 100
  return 200
}

/** Create a durable inbox entry. Exact message IDs are idempotent. */
export function enqueueInboxMessage(state, input) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const messageId = stableMessageId(row.messageId)
  const target = stringOf(row.target)
  if (messageId.length === 0) return refusal('message-id-required')
  if (target.length === 0) return refusal('target-required')
  const existing = doc.inbox[messageId]
  if (existing !== undefined) {
    const textProvided = row.originalText !== undefined || row.text !== undefined
    const senderProvided = row.sender !== undefined
    const same = stringOf(existing.target) === target
      && (!textProvided || stringOf(existing.originalText) === stringOf(row.originalText ?? row.text))
      && (!senderProvided || stringOf(existing.sender) === stringOf(row.sender))
    return same
      ? { ok: true, status: 'deduplicated', deduplicated: true, entry: copyValue(existing) }
      : refusal('message-id-conflict', { messageId })
  }
  const originalText = stringOf(row.originalText ?? row.text)
  if (originalText.length === 0) return refusal('message-text-required')
  const entry = {
    messageId,
    target,
    sender: stringOf(row.sender),
    taskId: stringOf(row.taskId) || null,
    priority: row.priority ?? 'normal',
    priorityRank: priorityRank(row.priority),
    originalText,
    status: 'queued',
    wakeRequested: row.wakeRequested === true,
    wakeIds: [],
    dedupeKey: stringOf(row.dedupeKey) || null,
    createdAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    updatedAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    attempts: 0,
    lastError: null,
  }
  doc.inbox[messageId] = entry
  touch(doc, { kind: 'wake/inbox-enqueued', messageId, target })
  return { ok: true, status: 'queued', deduplicated: false, entry: copyValue(entry) }
}

/**
 * Materialize a native Team message that was committed outside the inbox
 * queue. The delivery event is the durable proof that the target received it,
 * so the row starts as injected and can be acknowledged without a wake batch.
 */
export function recordDeliveredInboxMessage(state, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const messageId = stableMessageId(row.messageId ?? row.inboxId ?? row.id)
  const target = stringOf(row.target)
  if (messageId.length === 0) return refusal('message-id-required')
  if (target.length === 0) return refusal('target-required')
  const updatedAt = numberOf(row.updatedAt ?? row.injectedAt ?? row.at, numberOf(doc.now, Date.now()))
  const injectionReceipt = stringOf(row.injectionReceipt ?? row.receipt)
  const existing = doc.inbox[messageId]
  if (existing !== undefined) {
    if (stringOf(existing.target) !== target) return refusal('message-id-conflict', { messageId })
    if (!['handled', 'rejected'].includes(stringOf(existing.status))) {
      existing.status = 'injected'
      existing.updatedAt = updatedAt
      if (injectionReceipt.length > 0) existing.injectionReceipt = injectionReceipt
      existing.injectedAt = updatedAt
    }
    return {
      ok: true,
      status: existing.status,
      deduplicated: true,
      messageId,
      entry: copyValue(existing),
    }
  }
  const entry = {
    messageId,
    target,
    sender: stringOf(row.sender) || 'native-team-message',
    taskId: stringOf(row.taskId) || null,
    priority: row.priority ?? 'normal',
    priorityRank: priorityRank(row.priority),
    originalText: stringOf(row.originalText ?? row.text) || '[native Team message]',
    status: 'injected',
    wakeRequested: false,
    wakeIds: [],
    dedupeKey: stringOf(row.dedupeKey) || null,
    createdAt: numberOf(row.createdAt, updatedAt),
    updatedAt,
    attempts: 0,
    lastError: null,
    injectionReceipt: injectionReceipt || null,
    injectedAt: updatedAt,
  }
  doc.inbox[messageId] = entry
  touch(doc, { kind: 'wake/inbox-native-delivered', messageId, target })
  return {
    ok: true,
    status: 'injected',
    deduplicated: false,
    messageId,
    entry: copyValue(entry),
  }
}

/** Set an inbox entry status and keep its update time. */
function setInboxStatus(doc, messageId, status, extra = {}) {
  const entry = doc.inbox[messageId]
  if (entry === undefined) return undefined
  entry.status = status
  entry.updatedAt = numberOf(extra.updatedAt, numberOf(doc.now, Date.now()))
  if (extra.attempts !== undefined) entry.attempts = numberOf(extra.attempts, entry.attempts)
  if (extra.lastError !== undefined) entry.lastError = extra.lastError
  return entry
}

/** Create a wake batch ID without relying on randomness. */
function nextWakeId(doc, target) {
  const key = 'wake:' + target
  const value = numberOf(doc.sequence[key], 0) + 1
  doc.sequence[key] = value
  return key + ':' + String(value)
}

/** Find a non-terminal batch for one target. */
export function pendingWakeBatch(state, target) {
  const doc = normalizeRoomWakeState(state)
  const name = stringOf(target)
  const wake = Object.values(doc.wakes)
    .filter((row) => row?.target === name && WAKE_MERGEABLE.has(String(row.status)))
    .sort((a, b) => numberOf(b.updatedAt, 0) - numberOf(a.updatedAt, 0))[0]
  return wake === undefined
    ? { ok: true, wake: null }
    : { ok: true, wake: copyValue(wake) }
}

/**
 * Queue or merge a wake request.
 *
 * Silent requests enqueue durable inbox rows but never create a wake batch.
 * Explicit requests for one target merge into the pending batch while keeping
 * every message ID, original text and priority as an individual inbox row.
 */
export function requestWake(state, input) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const target = stringOf(row.target)
  if (target.length === 0) return refusal('target-required')
  const rawMessages = arrayOf(row.messages)
  const messageIdList = Array.isArray(row.messageIds)
    ? row.messageIds
    : row.messageIds === undefined || row.messageIds === null
      ? []
      : [row.messageIds]
  const messageInputs = rawMessages.length > 0
    ? rawMessages.map((message) => objectOf(message))
    : [...messageIdList, ...(row.messageId === undefined || row.messageId === null ? [] : [row.messageId])]
      .map((messageId) => ({ messageId, target, sender: row.sender, originalText: row.originalText ?? row.text, priority: row.priority, taskId: row.taskId, createdAt: row.createdAt }))
  if (messageInputs.length === 0) return refusal('message-ids-required')
  const entries = []
  for (const message of messageInputs) {
    const ensured = enqueueInboxMessage(doc, {
      ...message,
      target,
      sender: message.sender ?? row.sender,
      originalText: message.originalText ?? message.text ?? row.originalText ?? row.text,
      priority: message.priority ?? row.priority,
      taskId: message.taskId ?? row.taskId,
      createdAt: message.createdAt ?? row.createdAt,
    })
    if (ensured.ok !== true) return ensured
    entries.push(ensured.entry)
  }
  const kind = stringOf(row.kind) || 'directed'
  const silent = kind === 'silent' || row.wakeup === false || row.silent === true || row.explicitWake === false
  if (silent) {
    for (const entry of entries) {
      const live = doc.inbox[entry.messageId]
      live.wakeRequested = false
      live.updatedAt = numberOf(row.createdAt, numberOf(doc.now, Date.now()))
    }
    touch(doc, { kind: 'wake/silent-enqueued', target, messageIds: entries.map((entry) => entry.messageId) })
    return {
      ok: true,
      status: 'queued',
      wakeup: false,
      wake: null,
      messageIds: entries.map((entry) => entry.messageId),
      entries: entries.map((entry) => copyValue(doc.inbox[entry.messageId])),
    }
  }
  const dedupeKey = stringOf(row.dedupeKey) || stringOf(row.reason)
  if (dedupeKey.length === 0) return refusal('wake-dedupe-key-required')
  const pending = Object.values(doc.wakes)
    .filter((wake) => wake?.target === target && WAKE_MERGEABLE.has(String(wake.status)))
    .sort((a, b) => numberOf(b.updatedAt, 0) - numberOf(a.updatedAt, 0))[0]
  const incomingIds = entries.map((entry) => entry.messageId)
  if (pending !== undefined) {
    const existingIds = new Set(arrayOf(pending.messageIds).map(String))
    if (existingIds.size + incomingIds.length > WAKE_BATCH_MESSAGE_LIMIT) {
      // Do not grow one wake batch without bound. A fresh batch keeps each
      // durable write and delivery receipt bounded.
    } else {
    const duplicate = pending.dedupeKeys?.includes(dedupeKey) && incomingIds.every((messageId) => existingIds.has(messageId))
    if (duplicate) {
      return {
        ok: true,
        status: 'deduplicated',
        wakeup: true,
        wake: copyValue(pending),
        messageIds: incomingIds,
      }
    }
    pending.messageIds = uniqueStrings([...arrayOf(pending.messageIds), ...incomingIds], WAKE_BATCH_MESSAGE_LIMIT)
    pending.dedupeKeys = uniqueStrings([...arrayOf(pending.dedupeKeys), dedupeKey], WAKE_META_LIMIT)
    pending.reasons = uniqueStrings([...arrayOf(pending.reasons), stringOf(row.reason)], WAKE_META_LIMIT)
    pending.priority = priorityRank(row.priority) > priorityRank(pending.priority) ? row.priority : pending.priority
    pending.priorityRank = Math.max(numberOf(pending.priorityRank, 0), priorityRank(row.priority))
    pending.updatedAt = numberOf(row.createdAt, numberOf(doc.now, Date.now()))
    if (pending.status === 'delivered' || pending.status === 'injected') {
      pending.status = 'queued'
      pending.redeliveryRequired = true
    } else if (pending.status === 'delivery-failed') {
      pending.status = 'queued'
    }
    for (const messageId of incomingIds) {
      const entry = doc.inbox[messageId]
      if (entry.status !== 'handled' && entry.status !== 'rejected' && !entry.injectionReceipt) entry.status = 'queued'
      if (!entry.wakeIds.includes(pending.wakeId)) entry.wakeIds.push(pending.wakeId)
      entry.wakeRequested = true
      entry.updatedAt = pending.updatedAt
    }
    touch(doc, { kind: 'wake/merged', wakeId: pending.wakeId, target, messageIds: incomingIds })
    return { ok: true, status: 'queued', wakeup: true, wake: copyValue(pending), messageIds: incomingIds }
    }
  }
  const wake = {
    wakeId: stringOf(row.wakeId) || nextWakeId(doc, target),
    kind,
    target,
    reason: stringOf(row.reason),
    reasons: uniqueStrings([stringOf(row.reason)], WAKE_META_LIMIT),
    dedupeKey,
    dedupeKeys: uniqueStrings([dedupeKey], WAKE_META_LIMIT),
    priority: row.priority ?? 'normal',
    priorityRank: priorityRank(row.priority),
    messageIds: uniqueStrings(incomingIds, WAKE_BATCH_MESSAGE_LIMIT),
    status: 'queued',
    wakeup: true,
    attempts: 0,
    createdAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    updatedAt: numberOf(row.createdAt, numberOf(doc.now, Date.now())),
    deliveredAt: null,
    handledAt: null,
    lastError: null,
  }
  doc.wakes[wake.wakeId] = wake
  for (const messageId of incomingIds) {
    const entry = doc.inbox[messageId]
    if (!entry.wakeIds.includes(wake.wakeId)) entry.wakeIds.push(wake.wakeId)
    entry.wakeRequested = true
    entry.status = 'queued'
  }
  touch(doc, { kind: 'wake/queued', wakeId: wake.wakeId, target, messageIds: incomingIds })
  return { ok: true, status: 'queued', wakeup: true, wake: copyValue(wake), messageIds: incomingIds }
}

/** Deliver all or part of one wake batch. */
export function deliverWakeBatch(state, wakeId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const wake = doc.wakes[stringOf(wakeId)]
  if (wake === undefined) return refusal('wake-not-found')
  if (WAKE_TERMINAL.has(String(wake.status))) return refusal('wake-terminal', { status: wake.status })
  const ids = [...new Set(arrayOf(input.messageIds ?? wake.messageIds).map(String).filter(Boolean))]
  const unknown = ids.find((messageId) => doc.inbox[messageId] === undefined)
  if (unknown !== undefined) return refusal('message-not-found', { messageId: unknown })
  const injectionReceipt = stringOf(input.injectionReceipt)
  if (injectionReceipt.length > 0 && wake.injectionReceipt === injectionReceipt) {
    return {
      ok: true,
      status: wake.status,
      deduplicated: true,
      wake: copyValue(wake),
      messageIds: ids,
      delivered: wake.status === 'delivered',
    }
  }
  wake.attempts = numberOf(wake.attempts, 0) + 1
  wake.updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  if (input.error !== undefined && input.error !== null) {
    wake.status = 'delivery-failed'
    wake.lastError = stringOf(input.error?.message ?? input.error)
    for (const messageId of ids) setInboxStatus(doc, messageId, 'delivery-failed', {
      attempts: wake.attempts,
      lastError: wake.lastError,
      updatedAt: wake.updatedAt,
    })
    touch(doc, { kind: 'wake/delivery-failed', wakeId: wake.wakeId, messageIds: ids })
    return { ok: true, status: 'delivery-failed', retryable: true, wake: copyValue(wake), messageIds: ids }
  }
  for (const messageId of ids) {
    const entry = setInboxStatus(doc, messageId, 'delivered', { attempts: wake.attempts, updatedAt: wake.updatedAt })
    if (entry !== undefined && injectionReceipt.length > 0) {
      entry.injectionReceipt = injectionReceipt
      entry.injectedAt = wake.updatedAt
    }
  }
  const delivered = wake.messageIds.every((messageId) => ['delivered', 'handled'].includes(doc.inbox[messageId]?.status))
  wake.status = delivered ? 'delivered' : 'queued'
  wake.deliveredAt = delivered ? wake.updatedAt : wake.deliveredAt
  if (delivered) wake.redeliveryRequired = false
  if (injectionReceipt.length > 0) {
    wake.injectionReceipt = injectionReceipt
    wake.injectedAt = wake.updatedAt
  }
  wake.lastError = null
  touch(doc, { kind: delivered ? 'wake/delivered' : 'wake/partially-delivered', wakeId: wake.wakeId, messageIds: ids })
  return {
    ok: true,
    status: wake.status,
    wake: copyValue(wake),
    messageIds: ids,
    delivered: delivered,
  }
}

/** Mark a delivered batch as present in the target model context. */
export function markWakeInjected(state, wakeId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const wake = doc.wakes[stringOf(wakeId)]
  if (wake === undefined) return refusal('wake-not-found')
  if (wake.status === 'rejected' || wake.status === 'handled') return refusal('wake-terminal', { status: wake.status })
  const ids = [...new Set(arrayOf(input.messageIds ?? wake.messageIds).map(String).filter(Boolean))]
  for (const messageId of ids) {
    const entry = doc.inbox[messageId]
    if (entry === undefined) return refusal('message-not-found', { messageId })
    if (entry.status !== 'delivered' && entry.status !== 'injected') return refusal('message-not-delivered', { messageId, status: entry.status })
  }
  const receipt = stringOf(input.injectionReceipt ?? wake.injectionReceipt)
  if (!receipt) return refusal('injection-receipt-required')
  if (ids.length > 0 && ids.every((messageId) => doc.inbox[messageId]?.injectionReceipt === receipt)) {
    return { ok: true, status: wake.status, deduplicated: true, wake: copyValue(wake), messageIds: ids, injected: true }
  }
  const updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  for (const messageId of ids) {
    const entry = doc.inbox[messageId]
    entry.injectionReceipt = receipt
    entry.injectedAt = updatedAt
  }
  const allInjected = wake.messageIds.every((messageId) => Boolean(doc.inbox[messageId]?.injectionReceipt) || doc.inbox[messageId]?.status === 'handled')
  wake.injectedAt = allInjected ? updatedAt : wake.injectedAt ?? null
  wake.updatedAt = updatedAt
  touch(doc, { kind: 'wake/injected', wakeId: wake.wakeId, messageIds: ids })
  return { ok: true, status: wake.status, wake: copyValue(wake), messageIds: ids, injected: allInjected }
}

export const injectWakeBatch = markWakeInjected

/** Return delivery, injection and handling states without collapsing them. */
export function getWakeMessageStates(state, wakeId) {
  const doc = normalizeRoomWakeState(state)
  const wake = doc.wakes[stringOf(wakeId)]
  if (wake === undefined) return refusal('wake-not-found')
  return {
    ok: true,
    wakeId: wake.wakeId,
    status: wake.status,
    messages: arrayOf(wake.messageIds).map((messageId) => {
      const entry = doc.inbox[messageId]
      return { messageId, status: entry?.status ?? 'missing', delivered: entry?.status === 'delivered' || entry?.status === 'injected' || entry?.status === 'handled', injected: entry?.status === 'injected' || entry?.status === 'handled' || Boolean(entry?.injectionReceipt), injectionReceipt: entry?.injectionReceipt ?? null, handled: entry?.status === 'handled' }
    }),
  }
}

function wakeSettlement(doc, wake) {
  const messageIds = uniqueStrings(arrayOf(wake?.messageIds).map(String))
  const unsettled = messageIds.filter((messageId) =>
    !['handled', 'rejected', 'deduplicated'].includes(String(doc.inbox?.[messageId]?.status ?? '')))
  return {
    messageIds,
    unsettled,
    allSettled: unsettled.length === 0,
  }
}

/** Mark delivered inbox rows as handled after they entered the target context. */
export function handleWakeBatch(state, wakeId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const wake = doc.wakes[stringOf(wakeId)]
  if (wake === undefined) return refusal('wake-not-found')
  if (wake.status === 'handled' || wake.status === 'deduplicated') {
    return {
      ok: true,
      status: 'handled',
      deduplicated: true,
      wake: copyValue(wake),
      messageIds: [...new Set(arrayOf(wake.messageIds).map(String).filter(Boolean))],
      handled: true,
      redeliveryRequired: false,
    }
  }
  if (wake.status === 'rejected') return refusal('wake-terminal', { status: wake.status })
  const ids = [...new Set(arrayOf(input.messageIds ?? wake.messageIds).map(String).filter(Boolean))]
  const allowUndelivered = input.allowUndelivered === true || input.allow_undelivered === true
  const pending = []
  for (const messageId of ids) {
    const entry = doc.inbox[messageId]
    if (entry === undefined) return refusal('message-not-found', { messageId })
    if (['delivered', 'injected', 'handled', 'deduplicated', 'rejected'].includes(entry.status) || entry.injectionReceipt) continue
    if (entry.status === 'queued') {
      if (!allowUndelivered) pending.push({ messageId, status: entry.status })
      continue
    }
    return {
      ...refusal('message-not-delivered', { messageId, status: entry.status }),
      status: entry.status,
    }
  }
  const settledBeforeAck = wakeSettlement(doc, wake)
  if (settledBeforeAck.allSettled) {
    wake.status = 'handled'
    wake.handledAt = wake.handledAt ?? numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
    wake.redeliveryRequired = false
    wake.updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
    touch(doc, { kind: 'wake/handled', wakeId: wake.wakeId, messageIds: settledBeforeAck.messageIds })
    return {
      ok: true,
      status: 'handled',
      deduplicated: true,
      wake: copyValue(wake),
      messageIds: settledBeforeAck.messageIds,
      handled: true,
      redeliveryRequired: false,
      remainingMessageIds: [],
    }
  }
  const ackable = ids.filter((messageId) =>
    ['delivered', 'injected'].includes(doc.inbox[messageId]?.status)
    || (allowUndelivered && doc.inbox[messageId]?.status === 'queued')
    || Boolean(doc.inbox[messageId]?.injectionReceipt))
  if (ackable.length === 0) return refusal('message-not-delivered', pending[0] ?? { status: 'queued' })
  const updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  for (const messageId of ackable) setInboxStatus(doc, messageId, 'handled', { updatedAt })
  for (const messageId of ackable) rememberAcknowledgedInbox(doc, messageId, doc.inbox[messageId], updatedAt)
  const settlement = wakeSettlement(doc, wake)
  wake.status = settlement.allSettled ? 'handled' : pending.length > 0 ? 'queued' : 'delivered'
  wake.redeliveryRequired = !settlement.allSettled && settlement.unsettled.length > 0
  if (settlement.allSettled) {
    wake.handledAt = updatedAt
  }
  wake.updatedAt = updatedAt
  touch(doc, { kind: settlement.allSettled ? 'wake/handled' : 'wake/partially-handled', wakeId: wake.wakeId, messageIds: ackable })
  return {
    ok: true,
    status: settlement.allSettled ? 'handled' : 'partially-handled',
    wake: copyValue(wake),
    messageIds: ackable,
    handled: settlement.allSettled,
    redeliveryRequired: wake.redeliveryRequired,
    remainingMessageIds: settlement.unsettled,
  }
}

/**
 * Build the acknowledgement input for a wake row the caller can see.
 * `inbox_list` exposes queued rows explicitly, so an explicit ack from the
 * target is sufficient evidence that the row was observed even when the
 * delivery worker has not advanced its durable status yet.
 */
export function inboxAckInputForCaller(wake, caller, input = {}) {
  const target = stringOf(wake?.target)
  const name = stringOf(caller)
  const allowOtherTarget = input.allowOtherTarget === true || input.allow_other_target === true
  if (name.length === 0) return refusal('inbox-ack-caller-required')
  if (!allowOtherTarget && target.length > 0 && target !== name) {
    return refusal('inbox-ack-scope', { target })
  }
  return {
    ...input,
    ok: true,
    messageIds: uniqueStrings(arrayOf(input.messageIds ?? wake?.messageIds).map(String), WAKE_META_LIMIT),
    allowUndelivered: true,
  }
}

/**
 * Acknowledge one inbox row without requiring it to belong to a wake batch.
 * Info deliveries are intentionally silent and may have no wake id; once the
 * row was injected into the target context it is still ackable.
 */
export function handleInboxMessage(state, inboxId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const messageId = stringOf(inboxId)
  const entry = doc.inbox[messageId]
  if (entry === undefined) {
    const retired = acknowledgedInboxEvidence(doc, messageId)
    if (retired !== undefined) {
      const requestedTarget = stringOf(input.target)
      if (input.allowOtherTarget !== true
        && requestedTarget.length > 0
        && stringOf(retired.target).length > 0
        && stringOf(retired.target) !== requestedTarget) {
        return refusal('inbox-ack-scope', { inboxId: messageId })
      }
      return {
        ok: true,
        deduplicated: true,
        retired: true,
        inboxId: messageId,
        messageId,
        status: 'handled',
        handled: true,
        cleared: true,
        wakeStatus: null,
        redeliveryRequired: false,
      }
    }
    return refusal('inbox-not-found', { inboxId: messageId })
  }
  if (entry.status === 'handled') {
    rememberAcknowledgedInbox(doc, messageId, entry, numberOf(entry.updatedAt, Date.now()))
    let wakeStatus = null
    let redeliveryRequired = false
    for (const wakeId of arrayOf(entry.wakeIds).map(String).filter(Boolean)) {
      const wake = doc.wakes[wakeId]
      if (wake === undefined) continue
      const settlement = wakeSettlement(doc, wake)
      wake.status = settlement.allSettled ? 'handled' : wake.status
      wake.redeliveryRequired = !settlement.allSettled && settlement.unsettled.length > 0
      wakeStatus = wake.status
      redeliveryRequired = wake.redeliveryRequired === true
    }
    return {
      ok: true,
      deduplicated: true,
      inboxId: messageId,
      messageId,
      status: 'handled',
      handled: true,
      wakeStatus,
      redeliveryRequired,
    }
  }
  if (entry.status === 'rejected') return refusal('inbox-terminal', { status: entry.status })
  const allowUndelivered = input.allowUndelivered === true || input.allow_undelivered === true
  if (!allowUndelivered && !entry.injectionReceipt && !['delivered', 'injected'].includes(entry.status)) {
    return {
      ...refusal('message-not-delivered', { messageId, status: entry.status }),
      status: entry.status,
    }
  }
  const updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  setInboxStatus(doc, messageId, 'handled', { updatedAt })
  rememberAcknowledgedInbox(doc, messageId, entry, updatedAt)
  let wakeStatus = null
  let redeliveryRequired = false
  for (const wakeId of arrayOf(entry.wakeIds).map(String).filter(Boolean)) {
    const wake = doc.wakes[wakeId]
    if (wake === undefined) continue
    const settlement = wakeSettlement(doc, wake)
    wake.status = settlement.allSettled
      ? (wake.status === 'rejected' ? 'rejected' : 'handled')
      : wake.status === 'rejected' ? 'rejected' : 'delivered'
    wake.redeliveryRequired = !settlement.allSettled && settlement.unsettled.length > 0
    if (settlement.allSettled) {
      wake.handledAt = updatedAt
    }
    wake.updatedAt = updatedAt
    wakeStatus = wake.status
    redeliveryRequired = wake.redeliveryRequired === true
  }
  touch(doc, { kind: 'inbox/handled', messageId })
  return {
    ok: true,
    inboxId: messageId,
    messageId,
    status: 'handled',
    handled: true,
    cleared: true,
    wakeStatus,
    redeliveryRequired,
  }
}

/** Alias for per-message acknowledgement callers. */
export const acknowledgeWakeMessages = handleWakeBatch

/** Reject a wake for a business reason. Rejected batches are not retryable. */
export function rejectWake(state, wakeId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const wake = doc.wakes[stringOf(wakeId)]
  if (wake === undefined) return refusal('wake-not-found')
  if (wake.status === 'rejected') return { ok: true, deduplicated: true, status: 'rejected', wake: copyValue(wake) }
  const updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  wake.status = 'rejected'
  wake.rejectedAt = updatedAt
  wake.reason = stringOf(input.reason) || wake.reason
  for (const messageId of arrayOf(wake.messageIds)) {
    if (doc.inbox[messageId]?.status !== 'handled') setInboxStatus(doc, messageId, 'rejected', { lastError: wake.reason, updatedAt })
  }
  touch(doc, { kind: 'wake/rejected', wakeId: wake.wakeId, reason: wake.reason })
  return { ok: true, status: 'rejected', retryable: false, wake: copyValue(wake) }
}

/** Retry only a delivery failure. */
export function retryWake(state, wakeId, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const wake = doc.wakes[stringOf(wakeId)]
  if (wake === undefined) return refusal('wake-not-found')
  if (wake.status !== 'delivery-failed') return refusal('wake-not-retryable', { status: wake.status })
  const updatedAt = numberOf(input.updatedAt, numberOf(doc.now, Date.now()))
  wake.status = 'queued'
  wake.updatedAt = updatedAt
  for (const messageId of arrayOf(wake.messageIds)) {
    if (doc.inbox[messageId]?.status === 'delivery-failed') setInboxStatus(doc, messageId, 'queued', { updatedAt })
  }
  touch(doc, { kind: 'wake/retry-queued', wakeId: wake.wakeId })
  return { ok: true, status: 'queued', wake: copyValue(wake) }
}

/**
 * Evaluate an all-idle stop episode.
 *
 * One continuous inactive period produces exactly one notification. New work
 * closes the episode; a later inactive period creates a new one. There is no
 * lifetime or cross-project reminder cap.
 */
export function evaluateStopEpisode(state, input = {}) {
  const doc = normalizeRoomWakeState(state)
  const row = objectOf(input)
  const projectId = stringOf(row.projectId) || 'global'
  const active = row.active === true || row.working === true
  const now = numberOf(row.now, numberOf(doc.now, Date.now()))
  const current = doc.stopEpisodes[projectId]
  if (active) {
    if (current !== undefined && current.status === 'open') {
      current.status = 'closed'
      current.closedAt = now
      current.revision = numberOf(current.revision, 1) + 1
      touch(doc, { kind: 'stop-episode/closed', projectId, episodeId: current.episodeId })
      return { ok: true, status: 'closed', notify: false, episode: copyValue(current) }
    }
    return { ok: true, status: 'closed', notify: false, episode: current === undefined ? null : copyValue(current) }
  }
  if (current !== undefined && current.status === 'open') {
    return { ok: true, status: 'suppressed', notify: false, episode: copyValue(current) }
  }
  const episode = {
    episodeId: stringOf(row.episodeId) || projectId + ':stop:' + String(numberOf(doc.sequence['stop:' + projectId], 0) + 1),
    projectId,
    teamId: stringOf(row.teamId) || null,
    status: 'open',
    reminderCount: 1,
    openedAt: now,
    closedAt: null,
    revision: 1,
  }
  doc.sequence['stop:' + projectId] = numberOf(doc.sequence['stop:' + projectId], 0) + 1
  doc.stopEpisodes[projectId] = episode
  touch(doc, { kind: 'stop-episode/notified', projectId, episodeId: episode.episodeId })
  return { ok: true, status: 'notify', notify: true, episode: copyValue(episode) }
}

/** Alias used by callers that name the condition directly. */
export const observeStopEpisode = evaluateStopEpisode
