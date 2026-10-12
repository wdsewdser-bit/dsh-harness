import { contextDigest } from './team-v14-requirements.mjs'

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
  return text(value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

const MAX_PER_KIND = 32
const TERMINAL_TASKS = new Set(['completed', 'deleted', 'cancelled'])

function scoped(row, taskIds) {
  const ids = rowsOf(row?.taskIds).map(String)
  return ids.length === 0 || ids.some((id) => taskIds.has(id))
}

function take(rows, kind, omitted) {
  if (rows.length > MAX_PER_KIND) omitted[kind] = rows.length - MAX_PER_KIND
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
  const tasks = take(Object.values(objectOf(control.boards))
    .flatMap((board) => Object.values(objectOf(board?.tasks)))
    .filter((task) => text(task?.ownerName ?? task?.owner) === member && !TERMINAL_TASKS.has(text(task?.status)))
    .map((task) => ({
      id: text(task.id), revision: numberOf(task.revision, 1), subject: brief(task.subject),
      acceptance: rowsOf(task.contract?.acceptanceCriteria ?? task.acceptanceCriteria).map((row) => brief(row, 160)),
      blockedBy: rowsOf(task.blockedBy).map(String),
    })), 'tasks', omitted)
  const taskIds = new Set(tasks.map((task) => task.id))
  if (options.taskId) taskIds.add(text(options.taskId))
  const ledger = objectOf(control.v12Requirements)
  const requirements = take(Object.values(objectOf(ledger.requirements))
    .filter((row) => row?.status === 'active' && scoped(row, taskIds))
    .map((row) => ({ id: text(row.requirementId), revision: numberOf(row.revision, 1), text: brief(row.text ?? row.quote), acceptance: rowsOf(row.acceptance).map((item) => brief(item, 160)) })), 'requirements', omitted)
  const ledgerDecisions = Object.values(objectOf(ledger.decisions))
    .filter((row) => row?.status === 'confirmed' && scoped(row, taskIds))
    .map((row) => ({ id: text(row.decisionId), revision: numberOf(row.revision, 1), choice: brief(row.choice) }))
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
    const summaries = rowsOf(roomDoc.roundSummaries?.[roomId])
    if (summaries.length > 0) {
      for (const row of summaries.slice(-3)) {
        const id = text(row?.summaryId ?? row?.roundId)
        if (!id || seenSummary.has(id)) continue
        seenSummary.add(id)
        roomSummaries.push({ id, roomId, revision: numberOf(row?.summaryRevision, 1), text: brief(row?.summary ?? row?.text) })
      }
    } else {
      const latest = objectOf(legacy.latestSummary)
      const summary = text(latest.text ?? latest.summary ?? legacy.summary)
      if (summary) roomSummaries.push({ id: `room:${roomId}:summary`, roomId, revision: numberOf(legacy.revision, 1), text: brief(summary) })
    }
    const decisionRows = rowsOf(roomDoc.decisions?.[roomId]).length > 0
      ? rowsOf(roomDoc.decisions[roomId]) : rowsOf(legacy.decisions)
    for (const row of decisionRows) {
      if (row?.status !== 'confirmed') continue
      const id = text(row.decisionId ?? row.id)
      if (!id || seenDecision.has(id)) continue
      seenDecision.add(id)
      roomDecisions.push({ id, roomId, revision: numberOf(row.revision, 1), choice: brief(row.choice ?? row.title) })
    }
    const unresolvedRows = rowsOf(roomDoc.unresolved?.[roomId]).length > 0
      ? rowsOf(roomDoc.unresolved[roomId]) : rowsOf(legacy.unresolved)
    for (const [index, row] of unresolvedRows.entries()) {
      if (row && typeof row === 'object' && row.status && row.status !== 'open') continue
      blockers.push({ id: text(row?.itemId ?? row?.id) || `room:${roomId}:unresolved:${index + 1}`, roomId, text: brief(row?.text ?? row?.summary ?? row) })
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
  const sourceStatus = Object.values(omitted).some((count) => count > 0)
    ? 'truncated'
    : Object.values(facts).some((rows) => rows.length > 0) ? 'loaded' : 'empty'
  return { ok: sourceStatus !== 'truncated', sourceStatus, memberId: member, controlRevision: numberOf(control.revision), anchors, facts, omitted, digest: contextDigest({ member, anchors, facts }) }
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
  for (const [kind, rows] of Object.entries(objectOf(snapshot.facts))) {
    for (const row of rowsOf(rows)) {
      lines.push(`${kind}: ${text(row.id ?? row.roomId)}@${numberOf(row.revision, row.sequence)} ${brief(row.subject ?? row.text ?? row.choice ?? row.acceptance?.join('; '), 200)}`)
    }
  }
  let output = lines[0]
  let truncated = false
  for (const line of lines.slice(1)) {
    if (output.length + line.length + 1 > limit) { truncated = true; break }
    output += '\n' + line
  }
  if (truncated || snapshot.sourceStatus === 'truncated') output += '\n[Memory debt] Some facts omitted; reread authoritative state by ID.'
  return { ok: !truncated && snapshot.ok === true, text: output.slice(0, limit), truncated: truncated || snapshot.sourceStatus === 'truncated', digest: snapshot.digest }
}
