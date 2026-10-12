#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const [candidatePath, backupPath, auditPath, outputPath] = process.argv.slice(2)
if (!candidatePath || !backupPath || !auditPath || !outputPath) {
  console.error('usage: node build-team-state-from-meta.mjs <candidate.json> <backup.json> <audit.jsonl> <out.json>')
  process.exit(2)
}

const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'))
const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
const rootId = String(candidate.rootId ?? candidate.teamRootId ?? '')
if (rootId.length === 0) throw new Error('candidate Team metadata has no root id')
if (String(backup.rootId) !== rootId) throw new Error('candidate and backup root ids differ')

const clone = (value) => structuredClone(value)
const asMap = (rows, key, label) => {
  const values = Array.isArray(rows) ? rows : rows !== null && typeof rows === 'object' ? Object.values(rows) : []
  const map = {}
  for (const row of values) {
    const id = String(row?.[key] ?? '')
    if (id.length === 0) throw new Error(label + ' entry has no ' + key)
    map[id] = clone(row)
  }
  return map
}

const state = {
  ...clone(backup),
  rootId,
  rooms: asMap(candidate.rooms, 'roomId', 'room'),
  rounds: asMap(candidate.rounds, 'roundId', 'round'),
  dispatches: asMap(candidate.dispatches, 'dispatchId', 'dispatch'),
  wakeEpisodes: asMap(candidate.wakeEpisodes, 'episodeId', 'wake episode'),
  escalations: asMap(candidate.escalations, 'escalationId', 'escalation'),
  boards: {},
  frozenMembers: {},
  counters: clone(candidate.counters ?? backup.counters ?? {}),
  health: clone(candidate.health ?? backup.health ?? {}),
  provider: clone(candidate.provider ?? backup.provider ?? {}),
}

for (const board of Array.isArray(candidate.boards) ? candidate.boards : []) {
  const boardId = String(board.id ?? board.boardId ?? '')
  if (boardId.length === 0) throw new Error('board entry has no id')
  const tasks = asMap(board.tasks, 'id', 'task')
  state.boards[boardId] = {
    boardId,
    seq: tasks === undefined ? 0 : Math.max(0, ...Object.values(tasks).map((task) => {
      const match = String(task.id).match(/t(\d+)$/)
      return match === null ? 0 : Number(match[1])
    })),
    tasks,
  }
}

for (const member of Array.isArray(candidate.members) ? candidate.members : []) {
  if (member?.frozen === true) {
    state.frozenMembers[String(member.name)] = {
      member: String(member.name),
      frozen: true,
      updatedAt: Number(candidate.health?.updatedAt ?? Date.now()),
      updatedBy: null,
    }
  }
}

const plans = { ...(backup.plans ?? {}) }
let auditEvents = 0
let latestAuditAt = Number(backup.updatedAt ?? 0)
for (const rawLine of readFileSync(auditPath, 'utf8').split('\n')) {
  const line = rawLine.trim()
  if (line.length === 0) continue
  let event
  try { event = JSON.parse(line) } catch { continue }
  if (String(event.rootId ?? '') !== rootId) continue
  const at = Number(event.at ?? 0)
  latestAuditAt = Math.max(latestAuditAt, at)
  if (at <= Number(backup.updatedAt ?? 0)) continue
  auditEvents += 1
  const data = event.data ?? {}
  if (event.type === 'plan/proposed') {
    const taskId = String(data.taskId ?? '')
    if (taskId.length === 0) continue
    const prior = plans[taskId]
    plans[taskId] = {
      taskId,
      state: 'plan-proposed',
      revision: Number(prior?.revision ?? 0) + 1,
      requirementId: String(data.requirementId ?? taskId),
      goal: String(data.goal ?? ''),
      members: Array.isArray(data.members) ? data.members.map(String) : [],
      writeScopes: Array.isArray(data.writeScopes) ? data.writeScopes.map(String) : [],
      dependencies: Array.isArray(data.dependencies) ? data.dependencies.map(String) : [],
      options: Array.isArray(data.options) ? clone(data.options) : [],
      selectedOption: data.selectedOption ?? null,
      checks: data.checks !== null && typeof data.checks === 'object' ? clone(data.checks) : {},
      risks: Array.isArray(data.risks) ? clone(data.risks) : [],
      rollback: String(data.rollback ?? ''),
      proposedBy: String(data.proposedBy ?? ''),
      approvedBy: null,
      approvedAt: null,
      replacedState: null,
      replaceReason: null,
      createdAt: Number(prior?.createdAt ?? at),
      updatedAt: at,
    }
  } else if (event.type === 'plan/approved') {
    const taskId = String(data.taskId ?? '')
    if (plans[taskId] === undefined) continue
    plans[taskId] = {
      ...plans[taskId],
      state: 'plan-approved',
      approvedBy: String(data.approvedBy ?? ''),
      approvedAt: at,
      updatedAt: at,
    }
  }
}
state.plans = plans

function maxTimestamp(value, seen = new Set()) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value !== 'object' || seen.has(value)) return 0
  seen.add(value)
  let max = 0
  if (Array.isArray(value)) {
    for (const row of value) max = Math.max(max, maxTimestamp(row, seen))
    return max
  }
  for (const [key, row] of Object.entries(value)) {
    if (/(At|Time|created|updated|opened|closed|resolved)$/i.test(key) && typeof row === 'number') {
      max = Math.max(max, Number.isFinite(row) ? row : 0)
    } else {
      max = Math.max(max, maxTimestamp(row, seen))
    }
  }
  return max
}

state.revision = Math.max(Number(backup.revision ?? 0), auditEvents, Number(candidate.revision ?? 0))
state.updatedAt = Math.max(latestAuditAt, maxTimestamp(candidate))
state.teamRootId = rootId
state.members = clone(candidate.members ?? [])
state.milestones = clone(candidate.milestones ?? [])
delete state.reconcile

const serialized = JSON.stringify(state, null, 2) + '\n'
const temporary = outputPath + '.tmp-' + String(process.pid)
try {
  writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx' })
  renameSync(temporary, outputPath)
} catch (error) {
  try { rmSync(temporary, { force: true }) } catch {}
  throw error
}

console.log(JSON.stringify({
  rootId,
  auditEvents,
  updatedAt: state.updatedAt,
  counts: Object.fromEntries(['rooms', 'rounds', 'plans', 'boards', 'dispatches', 'leases', 'wakeEpisodes', 'escalations', 'privilegeRequests', 'evidence', 'packets', 'frozenMembers'].map((key) => [key, Object.keys(state[key] ?? {}).length])),
  openTasks: Object.values(state.boards).flatMap((board) => Object.values(board.tasks ?? {})).filter((task) => !['completed', 'deleted'].includes(task.status)).length,
  activeLeases: Object.values(state.leases ?? {}).filter((lease) => lease.status === 'active').length,
  bytes: Buffer.byteLength(serialized),
  sha256: createHash('sha256').update(serialized).digest('hex'),
  outputPath,
}, null, 2))
