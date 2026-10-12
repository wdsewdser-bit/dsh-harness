import { buildReadyQueue } from './team-v12-evidence-scheduler.mjs'

export function assertQueryRevision(snapshot, requested) {
  if (requested === undefined) return
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('snapshotRevision must be a non-negative safe integer')
  if (Number(snapshot.revision) !== requested) throw new Error('snapshot-revision-conflict: requested ' + requested + ', current ' + snapshot.revision)
}

export function createTaskQuerySnapshot(snapshot, members, options = {}) {
  assertQueryRevision(snapshot, options.snapshotRevision)
  const tasks = Object.values(snapshot.boards ?? {}).flatMap((board) => Object.values(board?.tasks ?? {}))
  const queue = (options.buildReadyQueue ?? buildReadyQueue)(tasks, members, Object.values(snapshot.leases ?? {}), {
    now: options.now ?? Date.now(), plans: snapshot.plans ?? {},
  })
  const rows = [...(queue.ready ?? []), ...(queue.blocked ?? [])]
  const readyById = new Map()
  for (const row of rows) if (!readyById.has(String(row.id))) readyById.set(String(row.id), row)
  return { snapshot, rows, readyById, snapshotRevision: Number(snapshot.revision), snapshotId: String(snapshot.rootId) + '@' + snapshot.revision }
}

export function taskQueryFilter(task, args = {}) {
  const ids = args.taskIds ?? args.task_ids
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) throw new Error('taskIds must be an array of exact task ids')
  if (args.changed_since !== undefined && (!Number.isSafeInteger(args.changed_since) || args.changed_since < 0)) throw new Error('changed_since must be a non-negative timestamp in milliseconds')
  return (ids === undefined || ids.includes(String(task.id)))
    && (args.changed_since === undefined || Number(task.updatedAt ?? task.createdAt ?? 0) > args.changed_since)
}

export function projectTaskQueryView(task, view) {
  if (view === undefined || view === 'full') return task
  if (view !== 'compact') throw new Error('view must be compact or full')
  // Retain the legacy schema's required fields; omit large descriptions/contracts.
  const fields = ['id', 'revision', 'subject', 'status', 'phase', 'ownerName', 'blockedBy', 'dependencyPhase', 'writeScopes', 'workKind', 'ready', 'readyReason', 'readyReasons', 'writeScopeWarnings', 'board', 'commitSha', 'evidenceIds', 'contractRevision', 'requirementRevision', 'contractStale', 'lifecycle', 'updatedAt', 'integrationState']
  return { ...Object.fromEntries(fields.filter((key) => task[key] !== undefined).map((key) => [key, task[key]])), description: '', queryView: 'compact', completionEvidence: false }
}

export function projectEvidenceQueryView(rows, view) {
  if (view === undefined || view === 'full') return rows
  if (!['compact', 'metadata'].includes(view)) throw new Error('evidence view must be full, compact or metadata')
  const fields = ['id', 'evidenceId', 'taskId', 'kind', 'status', 'recordedAt', 'recordedBy', 'fingerprint', 'requirementId', 'recipeId', 'recipeFingerprint', 'commitSha', 'treeHash', 'sha256', 'hash', 'locator', 'path', 'size', 'revision']
  return rows.map((row) => ({ ...Object.fromEntries(fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])), queryView: 'metadata', completionEvidence: false }))
}
