/**
 * team-milestone — Agent Team v3 self-declared milestones and the compaction anchor.
 *
 * The problem: DSH compacts on window pressure alone, at whatever step the runtime
 * happens to check, so a compaction can cut a task in half. The previous attempt keyed
 * the boundary off todo_write, which failed twice over: a session's todo list does not
 * outlive the session, and in a real project the main session never called todo_write
 * even once.
 *
 * The replacement: every agent declares its OWN milestone — a stage it can finish
 * without being interrupted by its next task — plus the test that will prove it done.
 * Ticking it means 'this work unit landed and the reasoning behind it is spent', which
 * is exactly the semantic boundary a compaction wants.
 *
 * Two hard facts shape the mechanics:
 *  1. A milestone is private to its owner. Nobody may set or tick someone else's.
 *  2. compactNow() requires an IDLE agent, and a tick happens inside a turn. So the
 *     tick only ARMS the compaction; agent/status -> idle is what fires it.
 */

export const BAND_START = 0.2
export const BAND_STEP = 0.1
/** At this share an idle agent folds even without a milestone tick. */
export const COMPACTION_PRESSURE_RATIO = 0.75
/** Backward-compatible name. */
export const HARD_RATIO = COMPACTION_PRESSURE_RATIO
/** Backward-compatible name. */
export const MILESTONE_REQUIRED_RATIO = COMPACTION_PRESSURE_RATIO

/** A fresh, empty Team-scoped progress bucket. */
function emptyScope() {
  return { members: {}, bands: {}, compactions: {} }
}

/**
 * Which reminder band a window share falls in: 0 below BAND_START, then 1, 2, 3...
 * Re-reminding on every band is what makes the mechanism idempotent: a model that
 * forgot is simply told again one band later, instead of never being told again.
 */
export function band(ratio, start = BAND_START, step = BAND_STEP) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < start) return 0
  // The epsilon absorbs 0.3 - 0.2 === 0.09999999999999998, which would otherwise
  // leave the 0.3 band stuck one position behind.
  return Math.floor((ratio - start) / step + 1e-9) + 1
}

/**
 * An empty milestone document.
 *
 * Version 2 stores one bucket per Team. A member name such as `lead` is only unique
 * inside one Team, so state keyed by name alone leaks across sessions.
 *
 * The top-level members/bands/compactions fields remain as a v1 compatibility
 * surface for the standalone unit helpers. Production callers must pass a Team key
 * through milestoneScope(); the old fields are never read once a scope is supplied.
 */
export function createMilestoneDoc() {
  return { version: 3, teams: {}, members: {}, bands: {}, compactions: {}, history: {} }
}

/** Normalize a document loaded from disk without discarding v1 data. */
export function normalizeMilestoneDoc(doc) {
  const value = doc !== null && typeof doc === 'object' ? doc : createMilestoneDoc()
  if (value.teams === undefined || value.teams === null || typeof value.teams !== 'object') value.teams = {}
  if (value.members === undefined || value.members === null || typeof value.members !== 'object') value.members = {}
  if (value.bands === undefined || value.bands === null || typeof value.bands !== 'object') value.bands = {}
  if (value.compactions === undefined || value.compactions === null || typeof value.compactions !== 'object') value.compactions = {}
  if (value.history === undefined || value.history === null || typeof value.history !== 'object') value.history = {}
  value.version = 3
  return value
}

/**
 * Resolve the storage bucket for one Team.
 *
 * An empty key is the legacy/test scope and returns the document's top-level
 * fields. Production Team members always have a stable membership.id, so their
 * names cannot collide with the same name in another session.
 */
export function milestoneScope(doc, teamKey) {
  const value = normalizeMilestoneDoc(doc)
  if (typeof teamKey !== 'string' || teamKey.length === 0) return value
  let scope = value.teams[teamKey]
  if (scope === null || typeof scope !== 'object') {
    scope = emptyScope()
    value.teams[teamKey] = scope
  }
  if (scope.members === undefined || scope.members === null || typeof scope.members !== 'object') scope.members = {}
  if (scope.bands === undefined || scope.bands === null || typeof scope.bands !== 'object') scope.bands = {}
  if (scope.compactions === undefined || scope.compactions === null || typeof scope.compactions !== 'object') scope.compactions = {}
  if (scope.history === undefined || scope.history === null || typeof scope.history !== 'object') scope.history = {}
  return scope
}

/** Stable marker used to recognise a milestone already present in the conversation. */
export function milestoneMarker(record) {
  const setAt = record !== undefined && typeof record.setAt === 'number' ? String(record.setAt) : 'unknown'
  return '[team milestone #' + setAt + ']'
}

/** The compact, model-facing milestone snapshot appended to the conversation tail. */
export function milestoneNotice(record) {
  return milestoneMarker(record) + ' Yours: "' + String(record?.stage ?? '') + '" (done when: '
    + String(record?.doneWhen ?? '') + ')'
    + (record?.done === true ? ' - TICKED, the context is folded at your next idle.' : ' - not ticked yet.')
}

/**
 * Whether `reader` may SEE `owner`'s milestone. Reading is deliberately wider than
 * writing: a superior steers the stage it can see, and a peer coordinates against it.
 */
export function canReadMilestone(reader, owner) {
  if (reader === undefined || owner === undefined) return false
  if (reader.name === owner.name) return true
  // A superior: tier 0 over a group lead, a group lead over its own members.
  if (reader.tier === 0) return owner.tier === 1
  if (reader.tier === 1 && owner.parent === reader.name) return true
  // A subordinate may read its own direct superior, to stay aligned with the plan.
  if (owner.name === reader.parent) return true
  // Peers coordinate without a go-between: group leads across groups, and members
  // within their own group. A member has no reason to read another group's member.
  if (reader.tier === owner.tier) return reader.tier === 2 ? reader.group === owner.group : true
  return false
}

/** Set (or replace) one agent's own milestone. Returns the new record. */
export function setMilestone(doc, owner, stage, doneWhen, now) {
  const previous = doc.members[owner]
  if (previous !== undefined && typeof previous === 'object') {
    if (doc.history === undefined || doc.history === null || typeof doc.history !== 'object') doc.history = {}
    const rows = Array.isArray(doc.history[owner]) ? doc.history[owner] : []
    rows.push({ ...previous })
    doc.history[owner] = rows.slice(-20)
  }
  const record = { owner, stage, doneWhen, setAt: now, done: false }
  doc.members[owner] = record
  return record
}

/** Tick one agent's own milestone. Undefined when it never declared one. */
export function markMilestoneDone(doc, owner, now) {
  const record = doc.members[owner]
  if (record === undefined) return undefined
  record.done = true
  record.doneAt = now
  return record
}

/**
 * Arm one independent compaction job for a ticked milestone.
 *
 * The current milestone record is allowed to be replaced immediately after a tick:
 * the normal workflow is "tick the finished stage, then declare the next one while
 * the context is still available". Keeping the pending fold on the milestone record
 * let setMilestone erase the only evidence that a fold was owed. The job therefore
 * lives in compactions[owner], keyed by the milestone revision that armed it.
 */
export function armMilestoneCompaction(doc, owner, now) {
  const record = doc.members[owner]
  if (record === undefined || record.done !== true) return undefined
  if (doc.compactions === undefined || doc.compactions === null || typeof doc.compactions !== 'object') doc.compactions = {}
  const setAt = typeof record.setAt === 'number' ? record.setAt : now
  const current = doc.compactions[owner]
  if (current !== undefined && current.milestoneSetAt === setAt) {
    return current.status === 'compacted' ? undefined : current
  }
  const job = {
    kind: 'milestone',
    attempts: 0,
    status: 'pending-idle',
    reason: 'milestone',
    milestoneSetAt: setAt,
    milestoneStage: String(record.stage ?? ''),
    requestedAt: now,
  }
  doc.compactions[owner] = job
  return job
}

/** The pending milestone fold for one owner, if it has not completed yet. */
export function pendingMilestoneCompaction(doc, owner, now = Date.now()) {
  const job = doc.compactions === undefined || doc.compactions === null
    ? undefined
    : doc.compactions[owner]
  if (job === undefined || job === null) return undefined
  if (!['pending-idle', 'retryable', 'compacting'].includes(String(job.status))) return undefined
  if (job.kind !== 'milestone' && job.reason !== 'milestone') return undefined
  if (job.status === 'retryable') {
    if (Number(job.attempts || 0) >= 3) return undefined
    if (now - Number(job.updatedAt || 0) < 5 * 60 * 1000) return undefined
  }
  // Only a completed revision may consume a milestone job. The current record
  // covers the ordinary case; history covers "tick A, then immediately set B",
  // where B is the live record but A is the work that was actually finished.
  const record = doc.members?.[owner]
  if (record !== undefined && record.setAt === job.milestoneSetAt) {
    return record.done === true ? job : undefined
  }
  const history = Array.isArray(doc.history?.[owner]) ? doc.history[owner] : []
  if (history.some((entry) => entry?.setAt === job.milestoneSetAt && entry.done === true)) return job
  // One-time compatibility for a job armed before history existed. A genuinely
  // recent tick/set pair is accepted; an old stranded job is not.
  if (record !== undefined
    && typeof record.setAt === 'number'
    && typeof job.milestoneSetAt === 'number'
    && record.setAt > job.milestoneSetAt
    && typeof job.milestoneStage === 'string'
    && job.milestoneStage.length > 0
    && now - Number(job.requestedAt || 0) <= 30 * 60 * 1000) return job
  return undefined
}

/** Mark one milestone compaction job as consumed exactly once. */
export function consumeMilestoneCompaction(doc, owner, now, milestoneSetAt) {
  const job = doc.compactions?.[owner]
  if (job === undefined || job === null) return undefined
  if (typeof milestoneSetAt === 'number' && job.milestoneSetAt !== milestoneSetAt) return job
  job.status = 'consumed'
  job.consumedAt = now
  return job
}

/** Retire jobs whose revision can no longer be proved complete. */
export function pruneStaleMilestoneCompactions(doc, now = Date.now()) {
  let changed = 0
  for (const scope of Object.values(doc.teams ?? {})) {
    if (scope === null || typeof scope !== 'object') continue
    for (const [owner, job] of Object.entries(scope.compactions ?? {})) {
      if (job === null || typeof job !== 'object') continue
      if (!['pending-idle', 'retryable', 'compacting'].includes(String(job.status))) continue
      if (job.kind !== 'milestone' && job.reason !== 'milestone') continue
      const current = scope.members?.[owner]
      const history = Array.isArray(scope.history?.[owner]) ? scope.history[owner] : []
      const known = (current?.setAt === job.milestoneSetAt && current.done === true)
        || history.some((entry) => entry?.setAt === job.milestoneSetAt && entry.done === true)
      const recentLegacy = current?.setAt > job.milestoneSetAt
        && now - Number(job.requestedAt || 0) <= 30 * 60 * 1000
      if (known || recentLegacy) continue
      job.status = 'stale'
      job.staleAt = now
      job.lastError = 'milestone revision is no longer provably complete'
      changed += 1
    }
  }
  return changed
}

/**
 * The reminder this agent owes right now, or undefined when it owes none.
 * Callers persist the returned band; absence of a record still owes a reminder, because
 * the point of the first one is to make the agent declare a milestone at all.
 */
export function pendingReminder(doc, owner, ratio) {
  const current = band(ratio)
  if (current === 0) return undefined
  const seen = typeof doc.bands[owner] === 'number' ? doc.bands[owner] : 0
  if (current <= seen) return undefined
  return { band: current, ratio, record: doc.members[owner] }
}

/** Record that a reminder band was delivered. */
export function acknowledgeReminder(doc, owner, atBand) {
  if (doc.bands === undefined) doc.bands = {}
  // Recorded even when the agent has declared no milestone yet: the FIRST reminder is
  // exactly the one with no member record to hang off.
  doc.bands[owner] = atBand
  return atBand
}

/**
 * Whether an idle agent should compact now.
 * A completed armed milestone is the preferred boundary. At the pressure
 * threshold a safety fold is allowed even without that tick.
 */
export function shouldCompact(record, ratio, pressureRatio = COMPACTION_PRESSURE_RATIO) {
  const armed = record !== undefined && record.done === true && record.compactedAt === undefined
  if (armed) return { yes: true, reason: 'milestone', ratio }
  if (typeof ratio === 'number' && ratio >= pressureRatio) return { yes: true, reason: 'pressure', ratio }
  return { yes: false, reason: 'not-armed', ratio }
}

/** Mark a compaction as performed, so the same milestone never fires twice. */
export function markCompacted(doc, owner, now, milestoneSetAt) {
  const record = doc.members[owner]
  if (record === undefined) return undefined
  // Only a fold tied to a concrete milestone revision may stamp that revision.
  if (typeof milestoneSetAt !== 'number') return record
  // A newer milestone may already have replaced the one that armed this fold.
  // Only stamp the record that actually belongs to the completed job.
  if (record.setAt !== milestoneSetAt) return record
  record.compactedAt = now
  return record
}

/** The reminder text appended to the agent's conversation as a quiet notice. */
export function reminderText(pending, tokens, windowSize) {
  const pct = Math.round(pending.ratio * 100)
  const budget = typeof windowSize === 'number' && windowSize > 0
    ? ' (' + Math.round(tokens / 1000) + 'k of ' + Math.round(windowSize / 1000) + 'k tokens)'
    : ' (' + Math.round(tokens / 1000) + 'k tokens)'
  const head = '[context check] Your context is ' + pct + '% full' + budget + '.'
  // A fold is lossy by design: only the board and the files survive it. Say so at the moment
  // the fold is already looming, because that is the only moment the agent can still act on it.
  const board = ' BEFORE the fold, move whatever must outlive it onto the Team board:'
    + ' team_task_create / team_task_update for durable facts (paths, decisions, exact commands,'
    + ' what is verified and what is not, what is left). After the fold the board and the files'
    + ' survive and your reasoning does not - work that lives only in your head gets redone.'
  if (pending.record === undefined) {
    return head + ' You have not declared a milestone yet. Declare one now with'
      + ' team_milestone(action:"set", stage:"<a stage you can finish before your next task>",'
      + ' done_when:"<the command or check that proves it done>"). When it is done, tick it with'
      + ' team_milestone(action:"done"): the context is folded at that moment, which is far cheaper'
      + ' than being cut off mid-task.' + board
  }
  return head + ' Your milestone is "' + pending.record.stage + '" (done when: '
    + pending.record.doneWhen + '). Tick it with team_milestone(action:"done") the moment it is'
    + ' really done, and declare the next one. Do not restate this reminder to anyone; it is'
    + ' private progress information.' + board
}
