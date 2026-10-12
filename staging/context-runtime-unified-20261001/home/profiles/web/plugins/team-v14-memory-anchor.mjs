import { contextDigest } from './team-v14-requirements.mjs'
import { createHash } from 'node:crypto'

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function rowsOf(value) {
  return Array.isArray(value) ? value : Object.values(objectOf(value))
}

function text(value) {
  return value === undefined || value === null ? '' : String(value)
}

function numberOf(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function brief(value, limit = 240) {
  return fieldText(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function fieldText(value) {
  return value && typeof value === 'object' ? JSON.stringify(value) : text(value)
}

function entriesOf(value) {
  return Object.entries(value && typeof value === 'object' ? value : {})
}

const MAX_FIELD_METADATA = 128
const hashOf = (value) => createHash('sha256').update(value, 'utf8').digest('hex')
const pathOf = (parts) => 'control' + parts.map((part) => `[${JSON.stringify(String(part))}]`).join('')

function fieldRecord(value, projected, sourceId, revision, parts) {
  const original = fieldText(value)
  const fieldPath = pathOf(parts)
  const truncated = original.replace(/\s+/g, ' ').trim().length > projected.length
  const boundedPath = fieldPath.length <= 512 ? fieldPath : 'control'
  return {
    sourceId: text(sourceId).length <= 128 ? text(sourceId) : `sha256:${hashOf(text(sourceId))}`,
    fieldPath: boundedPath, revision,
    ...(fieldPath.length > 512 ? { fieldPathHash: hashOf(fieldPath), locatorFallback: 'control-root' } : {}),
    locator: { controlPath: boundedPath, requiredRead: 'Read the authoritative Team control snapshot at controlPath and verify revision/hash; no fetch API is assumed.' },
    sha256: hashOf(original), hashEncoding: 'utf8', hashScope: 'authoritative-field',
    originalLength: original.length, projectedLength: projected.length,
    lengthUnit: 'utf16-code-units', truncated, requiredFetch: truncated,
  }
}

const MAX_PER_KIND = 32
const TERMINAL_TASKS = new Set(['completed', 'deleted', 'cancelled'])

function scoped(row, taskIds) {
  const ids = rowsOf(row?.taskIds).map(String)
  return ids.length === 0 || ids.some((id) => taskIds.has(id))
}

function take(rows, kind, omitted) {
  if (rows.length > MAX_PER_KIND) omitted[kind] = numberOf(omitted[kind]) + rows.length - MAX_PER_KIND
  return rows.slice(0, MAX_PER_KIND)
}

/** Extract member-specific facts without mutating the authoritative snapshot. */
export function captureMemberMemory(control, memberId, options = {}) {
  if (!control || typeof control !== 'object' || Array.isArray(control)) {
    return { ok: false, sourceStatus: 'unavailable', reason: 'control-snapshot-unavailable', anchors: {}, omitted: {} }
  }
  if (!('boards' in control) && !('rooms' in control) && !('v12RoomWake' in control)) {
    return { ok: false, sourceStatus: 'unavailable', reason: 'control-domains-unavailable', anchors: {}, omitted: {} }
  }
  const member = text(memberId)
  if (!member) return { ok: false, sourceStatus: 'unavailable', reason: 'member-id-unavailable', anchors: {}, omitted: {} }
  const omitted = {}
  const fieldMetadata = []
  let metadataOmitted = 0
  let truncatedFields = 0
  let controlRootMetadata
  const register = (record) => {
    if (record.locatorFallback === 'control-root') {
      if (!controlRootMetadata) {
        const original = JSON.stringify(control)
        controlRootMetadata = { sha256: hashOf(original), originalLength: original.length }
      }
      // The bounded root locator must authenticate the root, not the lost field path.
      record = { ...record, ...controlRootMetadata, revision: numberOf(control.revision),
        hashScope: 'authoritative-control-snapshot', projectionScope: 'field-from-control-snapshot',
        truncated: true, requiredFetch: true,
        locator: { controlPath: 'control', revision: numberOf(control.revision),
          requiredRead: 'Read the complete authoritative Team control snapshot and verify its revision/root hash; sourceId and fieldPathHash are only field lookup clues.' } }
    }
    if (record.truncated) truncatedFields += 1
    if (fieldMetadata.length < MAX_FIELD_METADATA) fieldMetadata.push(record)
    else metadataOmitted += 1
  }
  const project = (value, id, revision, parts, limit = 240) => {
    const projected = brief(value, limit)
    register(fieldRecord(value, projected, id, revision, parts))
    return projected
  }
  const acceptanceOf = (value, id, revision, parts) => {
    const entries = entriesOf(value)
    if (entries.length > MAX_PER_KIND) {
      omitted.acceptanceItems = numberOf(omitted.acceptanceItems) + entries.length - MAX_PER_KIND
    }
    const projected = entries.slice(0, MAX_PER_KIND).map(([key, item]) => project(item, id, revision, [...parts, key], 160))
    if (entries.length > MAX_PER_KIND) register({ ...fieldRecord(value, JSON.stringify(projected), id, revision, parts), truncated: true, requiredFetch: true })
    return projected
  }
  const taskEntries = entriesOf(control.boards)
    .flatMap(([boardKey, board]) => entriesOf(board?.tasks).map(([taskKey, task]) => ({ task, parts: ['boards', boardKey, 'tasks', taskKey] })))
    .filter(({ task }) => text(task?.ownerName ?? task?.owner) === member && !TERMINAL_TASKS.has(text(task?.status)))
  const tasks = take(taskEntries, 'tasks', omitted).map(({ task, parts }) => {
    const id = text(task.id), revision = numberOf(task.revision, 1)
    const contract = task.contract?.acceptanceCriteria != null
    return {
      id, revision, subject: project(task.subject, id, revision, [...parts, 'subject']),
      acceptance: acceptanceOf(contract ? task.contract.acceptanceCriteria : task.acceptanceCriteria, id, revision,
        [...parts, ...(contract ? ['contract', 'acceptanceCriteria'] : ['acceptanceCriteria'])]),
      blockedBy: rowsOf(task.blockedBy).map(String),
    }
  })
  const taskIds = new Set(tasks.map((task) => task.id))
  if (options.taskId) taskIds.add(text(options.taskId))
  const ledger = objectOf(control.v12Requirements)
  const requirements = take(entriesOf(ledger.requirements)
    .filter(([, row]) => row?.status === 'active' && scoped(row, taskIds)), 'requirements', omitted)
    .map(([key, row]) => {
      const id = text(row.requirementId), revision = numberOf(row.revision, 1)
      const parts = ['v12Requirements', 'requirements', key]
      return { id, revision, text: project(row.text ?? row.quote, id, revision, [...parts, row.text != null ? 'text' : 'quote']),
        acceptance: acceptanceOf(row.acceptance, id, revision, [...parts, 'acceptance']) }
    })
  const ledgerDecisions = take(entriesOf(ledger.decisions)
    .filter(([, row]) => row?.status === 'confirmed' && scoped(row, taskIds)), 'decisions', omitted)
    .map(([key, row]) => ({ id: text(row.decisionId), revision: numberOf(row.revision, 1),
      choice: project(row.choice, row.decisionId, numberOf(row.revision, 1), ['v12Requirements', 'decisions', key, 'choice']) }))
  const roomDoc = objectOf(control.v12RoomWake)
  const legacyRooms = objectOf(control.rooms)
  const roomIds = new Set([
    ...Object.keys(legacyRooms),
    ...Object.keys(objectOf(roomDoc.roomAccess)),
    ...Object.keys(objectOf(roomDoc.transcripts)),
    ...Object.keys(objectOf(roomDoc.roundSummaries)),
  ])
  const roomSummaries = []
  const roomDecisions = [...ledgerDecisions]
  const cursors = []
  const blockers = tasks.flatMap((task) => task.blockedBy.map((id) => ({ id: `task:${task.id}:depends:${id}`, text: id })))
  const seenSummary = new Set()
  const seenDecision = new Set(roomDecisions.map((row) => row.id))
  for (const roomId of roomIds) {
    const legacy = objectOf(legacyRooms[roomId])
    const access = objectOf(roomDoc.roomAccess?.[roomId])
    const members = rowsOf(access.members ?? legacy.members).map(String)
    if (members.length === 0 || (!members.includes(member) && text(access.host ?? legacy.host) !== member)) continue
    const summaries = entriesOf(roomDoc.roundSummaries?.[roomId])
    if (summaries.length > 0) {
      if (summaries.length > 3) omitted.roomSummaryHistory = numberOf(omitted.roomSummaryHistory) + summaries.length - 3
      for (const [key, row] of summaries.slice(-3)) {
        const id = text(row?.summaryId ?? row?.roundId)
        if (!id || seenSummary.has(id)) continue
        seenSummary.add(id)
        roomSummaries.push({ id, roomId, revision: numberOf(row?.summaryRevision, 1), text: project(row?.summary ?? row?.text, id, numberOf(row?.summaryRevision, 1), ['v12RoomWake', 'roundSummaries', roomId, key, row?.summary != null ? 'summary' : 'text']) })
      }
    } else {
      const latest = objectOf(legacy.latestSummary)
      const summary = text(latest.text ?? latest.summary ?? legacy.summary)
      const summaryParts = latest.text != null ? ['latestSummary', 'text'] : latest.summary != null ? ['latestSummary', 'summary'] : ['summary']
      if (summary) roomSummaries.push({ id: `room:${roomId}:summary`, roomId, revision: numberOf(legacy.revision, 1), text: project(summary, `room:${roomId}:summary`, numberOf(legacy.revision, 1), ['rooms', roomId, ...summaryParts]) })
    }
    const modernDecisions = entriesOf(roomDoc.decisions?.[roomId]).length > 0
    const decisionRows = entriesOf(modernDecisions ? roomDoc.decisions[roomId] : legacy.decisions)
    for (const [key, row] of decisionRows) {
      if (row?.status !== 'confirmed') continue
      const id = text(row.decisionId ?? row.id)
      if (!id || seenDecision.has(id)) continue
      seenDecision.add(id)
      roomDecisions.push({ id, roomId, revision: numberOf(row.revision, 1), choice: project(row.choice ?? row.title, id, numberOf(row.revision, 1), [modernDecisions ? 'v12RoomWake' : 'rooms', ...(modernDecisions ? ['decisions', roomId] : [roomId, 'decisions']), key, row.choice != null ? 'choice' : 'title']) })
    }
    const modernUnresolved = entriesOf(roomDoc.unresolved?.[roomId]).length > 0
    const unresolvedRows = entriesOf(modernUnresolved ? roomDoc.unresolved[roomId] : legacy.unresolved)
    for (const [index, [key, row]] of unresolvedRows.entries()) {
      if (row && typeof row === 'object' && row.status && row.status !== 'open') continue
      const id = text(row?.itemId ?? row?.id) || `room:${roomId}:unresolved:${index + 1}`
      blockers.push({ id, roomId, text: project(row?.text ?? row?.summary ?? row, id, numberOf(row?.revision, legacy.revision ?? 1), [modernUnresolved ? 'v12RoomWake' : 'rooms', ...(modernUnresolved ? ['unresolved', roomId] : [roomId, 'unresolved']), key, ...(row?.text != null ? ['text'] : row?.summary != null ? ['summary'] : [])]) })
    }
    const cursor = roomDoc.cursors?.[roomId]?.[member]
    cursors.push({ roomId, sequence: numberOf(cursor?.sequence, 0), messageId: text(cursor?.messageId) || null })
  }
  const anchors = {
    taskContract: tasks.map((row) => row.id),
    ownerScope: member,
    milestoneNext: text(options.milestoneNext),
    requirements: requirements.map((row) => row.id),
    roomDecisions: roomDecisions.map((row) => row.id),
    roomSummary: roomSummaries.map((row) => row.id),
    cursor: cursors.map((row) => `${row.roomId}:${row.sequence}`),
    blockers: blockers.map((row) => row.id),
  }
  const facts = {
    tasks,
    requirements,
    decisions: take(roomDecisions, 'decisions', omitted),
    roomSummaries: take(roomSummaries, 'roomSummaries', omitted),
    cursors: take(cursors, 'cursors', omitted),
    blockers: take(blockers, 'blockers', omitted),
  }
  anchors.roomDecisions = facts.decisions.map((row) => row.id)
  anchors.roomSummary = facts.roomSummaries.map((row) => row.id)
  anchors.cursor = facts.cursors.map((row) => `${row.roomId}:${row.sequence}`)
  anchors.blockers = facts.blockers.map((row) => row.id)
  if (truncatedFields) omitted.fieldTruncations = truncatedFields
  const sourceStatus = Object.values(omitted).some((count) => count > 0)
    ? 'truncated'
    : Object.values(facts).some((rows) => rows.length > 0) ? 'loaded' : 'empty'
  return { ok: sourceStatus !== 'truncated', sourceStatus, memberId: member, controlRevision: numberOf(control.revision), anchors, facts, omitted,
    fieldMetadata, fieldMetadataOmitted: metadataOmitted,
    memoryDebt: { requiredFetch: sourceStatus === 'truncated', truncatedFields, metadataOmitted,
      locator: { controlPath: 'control', revision: numberOf(control.revision),
        ...(sourceStatus === 'truncated' ? { sha256: hashOf(JSON.stringify(control)), hashEncoding: 'utf8', hashScope: 'authoritative-control-json' } : {}),
        requiredRead: 'Read authoritative Team control state; omitted fields and rows remain required.' } },
    digest: contextDigest({ member, anchors, facts }) }
}

/** Produce a bounded first-turn recovery note, retaining IDs for full rereads. */
export function buildMemberRecoveryPack(snapshot, options = {}) {
  const limit = Math.max(512, Math.floor(numberOf(options.maxChars, 6000)))
  if (!snapshot || snapshot.sourceStatus === 'unavailable') return { ok: false, text: 'Memory source unavailable; reread the authoritative Team control state before resuming.', truncated: false }
  const lines = [`[Team memory recovery] member=${snapshot.memberId} controlRevision=${snapshot.controlRevision} source=${snapshot.sourceStatus} digest=${snapshot.digest}`]
  if (snapshot.anchors?.milestoneNext) lines.push(`milestoneNext: ${snapshot.anchors.milestoneNext}`)
  for (const [key, value] of Object.entries(objectOf(snapshot.anchors))) {
    if (key === 'milestoneNext' || key === 'ownerScope') continue
    const terms = Array.isArray(value) ? value.filter(Boolean).join(',') : text(value)
    if (terms) lines.push(`${key}: ${terms}`)
  }
  const recoveryFields = []
  let recoveryFieldCount = 0
  for (const [kind, rows] of Object.entries(objectOf(snapshot.facts))) {
    for (const row of rowsOf(rows)) {
      const id = text(row.id ?? row.roomId)
      const revision = numberOf(row.revision, row.sequence)
      const fields = Object.entries(row).filter(([key]) => ['subject', 'text', 'choice', 'acceptance'].includes(key))
      if (!fields.length) lines.push(`${kind}: ${id}@${revision}`)
      for (const [key, value] of fields) {
        const values = key === 'acceptance' ? rowsOf(value) : [value]
        for (const [index, item] of values.entries()) {
          const projected = brief(item, 200)
          lines.push(`${kind}: ${id}@${revision} ${key}${key === 'acceptance' ? `[${index}]` : ''}: ${projected}`)
          if (fieldText(item).replace(/\s+/g, ' ').trim().length > projected.length) {
            recoveryFieldCount += 1
            const source = rowsOf(snapshot.fieldMetadata).find((record) => record.sourceId === id && record.fieldPath.endsWith(`[${JSON.stringify(key)}]`))
            if (recoveryFields.length < MAX_FIELD_METADATA) recoveryFields.push({
              ...(source ?? { ...fieldRecord(item, projected, id, revision, []),
                hashScope: 'captured-projection', sourceOriginalLengthKnown: false }), projectedLength: projected.length,
              truncated: true, requiredFetch: true, stage: 'recovery-field',
            })
          }
        }
      }
    }
  }
  const fullText = lines.join('\n')
  const lengthTruncated = fullText.length > limit
  const truncated = lengthTruncated || recoveryFieldCount > 0 || snapshot.sourceStatus === 'truncated' || snapshot.memoryDebt?.requiredFetch === true
  // Reserve debt instructions before clipping, including an oversized header/anchor.
  const marker = truncated ? '\n[Memory debt] requiredFetch=true; read authoritative Team control state (control) at recorded revision/hash before relying on omitted fields/rows. See memoryDebt and fieldMetadata.' : ''
  const output = fullText.slice(0, limit - marker.length) + marker
  return { ok: !truncated && snapshot.ok === true, text: output, truncated, digest: snapshot.digest,
    fieldMetadata: snapshot.fieldMetadata ?? [],
    memoryDebt: { ...objectOf(snapshot.memoryDebt), requiredFetch: truncated,
      recoveryFields, recoveryFieldCount, recoveryMetadataOmitted: recoveryFieldCount - recoveryFields.length,
      output: { sourceId: `member:${brief(snapshot.memberId, 128)}`, fieldPath: 'recovery.text', revision: snapshot.controlRevision,
        locator: { controlPath: 'control', requiredRead: 'Read authoritative Team control state using source IDs and fieldMetadata; no fetch API is assumed.' },
        sha256: hashOf(fullText), hashEncoding: 'utf8', hashScope: 'recovery-projection',
        originalLength: fullText.length, projectedLength: output.length - marker.length,
        lengthUnit: 'utf16-code-units', truncated: lengthTruncated || (truncated && fullText.length > limit - marker.length), requiredFetch: truncated } } }
}
