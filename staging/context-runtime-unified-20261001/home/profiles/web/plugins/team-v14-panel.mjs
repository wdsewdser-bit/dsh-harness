import { continuationCandidates } from './team-v14-event-continuation.mjs'

const rows = (value) => Array.isArray(value) ? value : Object.values(value ?? {})
const short = (value, limit = 160) => String(value ?? '').slice(0, limit)
const terminal = new Set(['completed', 'cancelled', 'expired', 'deleted'])

export function projectPanelRooms(snapshot, limit = 20, roomLimit = 12) {
  return rows(snapshot.rooms).slice(-roomLimit).map((room) => {
    const messages = rows(room?.messages)
    return {
      roomId: room.roomId,
      kind: room.kind,
      status: room.status,
      host: room.host,
      currentRoundId: room.currentRoundId ?? null,
      summary: short(room.summary ?? room.latestSummary?.text, 300),
      unresolved: rows(room.unresolved).slice(-15).map((item) => typeof item === 'string' ? short(item) : { text: short(item?.text ?? item?.content), status: item?.status }),
      decisions: rows(room.decisions).slice(-15).map((item) => ({ title: short(item?.title ?? item?.choice ?? item?.decisionId) })),
      messages: messages.slice(-limit).map((message) => ({
        messageId: message.messageId,
        roundId: message.roundId,
        author: message.author,
        kind: message.kind,
        turn: message.turn,
        createdAt: message.createdAt,
        content: short(message.content, 500),
      })),
      messageCount: messages.length,
      omittedMessages: Math.max(0, messages.length - limit),
    }
  })
}

export function buildTeamPanelOverview(snapshot, members) {
  const tasks = rows(snapshot.boards).flatMap((board) => rows(board?.tasks))
    .filter((task) => !terminal.has(String(task?.status ?? '').toLowerCase()))
  const continuation = continuationCandidates(snapshot, members).slice(0, 30)
    .map((task) => ({ taskId: task.id, owner: task.target, phase: task.phase, revision: task.revision, ownerStatus: task.ownerStatus }))
  const ready = new Set(continuation.map((row) => String(row.taskId)))
  const memberByName = new Map(members.map((member) => [String(member.name), member]))
  const tickets = rows(snapshot.v14Waiting?.tickets ?? snapshot.v12Waiting?.tickets)
  const waitingResponsibility = tickets.length > 0
    ? tickets.filter((ticket) => !['resolved', 'cancelled'].includes(ticket.status)).slice(0, 30).map((ticket) => ({
      taskId: ticket.taskId, owner: ticket.owner ?? ticket.responsible, reason: short(ticket.reason),
      unblock: short(ticket.unblockCondition), nextCheckAt: ticket.nextCheckAt ?? null,
    }))
    : tasks.filter((task) => task.ownerName && !ready.has(String(task.id)) && (rows(task.blockedBy).length > 0 || task.manualPause === true))
      .slice(0, 30).map((task) => ({ taskId: task.id, owner: task.ownerName,
        ownerStatus: memberByName.get(String(task.ownerName))?.status ?? 'unknown',
        reason: task.manualPause === true ? 'manual-pause' : 'waiting-dependency',
        unblock: rows(task.blockedBy).map(String).slice(0, 6).join(', '), nextCheckAt: null }))
  const ledger = snapshot.v12Requirements ?? {}
  const requirementChanges = rows(ledger.events).slice(-15).reverse().map((event) => ({
    revision: event.revision, type: short(event.type, 80), requirementId: event.requirementId ?? null,
    decisionId: event.decisionId ?? null, at: event.at ?? null,
  }))
  const receipts = (rows(snapshot.v14Receipts).length > 0 ? rows(snapshot.v14Receipts) : rows(snapshot.v12Events).filter((event) => String(event?.eventType ?? event?.type ?? '').endsWith('/post')))
    .slice(-15).reverse().map((event) => ({
      callId: short(event.callId), rootCallId: short(event.rootCallId), sessionId: short(event.sessionId),
      correlationId: short(event.correlationId ?? event.callId), tool: short(event.tool ?? event.eventType ?? event.type, 80),
      stage: short(event.stage ?? event.mirrorStatus ?? event.status, 50), isError: event.isError === true,
      projectionBlocked: event.projectionBlocked === true, ids: event.ids ?? {}, mirrorStatus: short(event.mirrorStatus, 40),
      error: short(event.error, 180), retry: short(event.retry, 120), at: event.at ?? null,
    }))
  const compactionJobs = rows(snapshot.v12Compaction?.jobs).filter((job) => !['compacted', 'completed', 'cancelled'].includes(job?.status))
  const contextWarnings = [
    ...compactionJobs.slice(0, 12).map((job) => ({ owner: job.owner ?? null, reason: 'compaction-' + short(job.status, 40), ref: job.jobId ?? job.id ?? null })),
    ...rows(snapshot.v14ContextWarnings ?? snapshot.v12ContextWarnings).slice(-12).map((warning) => ({ owner: warning.owner ?? null, reason: short(warning.reason), ref: warning.ref ?? null })),
  ]
  return {
    continuation,
    waitingResponsibility,
    bottlenecks: {
      ready: continuation.length,
      waiting: waitingResponsibility.length,
      activeLeases: rows(snapshot.leases).filter((lease) => lease?.status === 'active').length,
      openRooms: rows(snapshot.rooms).filter((room) => room?.status === 'open').length,
    },
    requirements: { revision: Number(ledger.revision ?? 0), changes: requirementChanges },
    ptcReceipts: receipts,
    contextWarnings,
  }
}
