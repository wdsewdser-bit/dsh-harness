// The plan a context window is bound to when the Team never registered a delivery contract.
//
// Real Teams plan per task (plan_propose / plan_approve) and do not call plan_register, so a window that insists on a
// registered contract can never be folded for them. This module projects the approved task plans into a stable,
// published snapshot the window can cite instead. It is deliberately NOT a delivery contract:
//  - it is derived from the tasks that exist, so it can say which known requirements have no approved task, but it
//    cannot know about a requirement nobody wrote down. Its coverage statement says exactly that;
//  - it carries no proofs and takes no part in the delivery gate, whose registered contract is a different thing.
// "Published" matters for stability: approvals come and go all day, and a window bound to the live set would see its
// plan hash move under it. The snapshot only changes when someone publishes (a phase boundary, or the moment before a
// fold), and publishing identical content does not create a new revision.
import { createHash } from 'node:crypto'

const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(canonical)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
const hashOf = value => sha(JSON.stringify(canonical(value)))
const text = value => typeof value === 'string' && value.length > 0 ? value : null

/** Deterministic projection of the approved task plans in one control-plane state. */
export function deriveWindowPlan(state) {
  const boardOf = new Map()
  for (const [boardId, board] of Object.entries(state?.boards ?? {})) for (const taskId of Object.keys(board?.tasks ?? {})) if (!boardOf.has(taskId)) boardOf.set(taskId, boardId)
  const byRequirement = new Map()
  for (const plan of Object.values(state?.plans ?? {})) {
    // Only an approval that still stands: a proposed, rejected, blocked or replaced plan commits the Team to nothing.
    if (plan?.state !== 'plan-approved' || text(plan.taskId) === null) continue
    const requirementId = text(plan.requirementId) ?? plan.taskId
    const row = byRequirement.get(requirementId) ?? { requirementId, tasks: [] }
    row.tasks.push({ boardId: boardOf.get(plan.taskId) ?? null, taskId: plan.taskId, planRevision: Number(plan.revision) || 1,
      goal: text(plan.goal), writeScopes: [...new Set(Array.isArray(plan.writeScopes) ? plan.writeScopes.filter(text) : [])].sort(),
      checksHash: hashOf(plan.checks ?? null), approvedBy: text(plan.approvedBy) })
    byRequirement.set(requirementId, row)
  }
  const items = [...byRequirement.values()].sort((a, b) => a.requirementId < b.requirementId ? -1 : 1)
    .map(row => ({ requirementId: row.requirementId, tasks: row.tasks.sort((a, b) => a.taskId < b.taskId ? -1 : 1) }))
  const known = Object.values(state?.v12Requirements?.requirements ?? {}).filter(row => text(row?.requirementId) !== null && row.status !== 'withdrawn' && row.status !== 'superseded')
  const mapped = new Set(items.map(item => item.requirementId))
  const unmapped = known.map(row => row.requirementId).filter(id => !mapped.has(id)).sort()
  return {
    kind: 'approved-task-plan-projection', rule: 'approved-task-plans-v1', items,
    coverage: {
      basis: 'approved-task-plans',
      // What this can and cannot vouch for, in words a reader of the checkpoint will see.
      statement: known.length === 0 ? 'requirement-list-unknown' : unmapped.length ? 'known-requirements-without-approved-task' : 'known-requirements-have-approved-tasks',
      knownRequirements: known.length, unmappedRequirements: unmapped,
    },
  }
}

/**
 * What a delivery check may say about requirements, next to (never instead of) its answer about tasks.
 * "Every task is closed" and "everything that was asked is covered" are different facts; the second one can only be
 * judged against a recorded requirement list, and without one the honest answer is "unknown".
 */
export function requirementCoverageNote(state) {
  const { coverage, items } = deriveWindowPlan(state)
  const completeness = coverage.statement === 'requirement-list-unknown' ? 'unknown'
    : coverage.statement === 'known-requirements-without-approved-task' ? 'incomplete' : 'covered'
  return { basis: 'approved task plans against the recorded requirement list', requirementCompleteness: completeness,
    knownRequirements: coverage.knownRequirements, requirementsWithoutApprovedTask: coverage.unmappedRequirements, approvedPlanGroups: items.length,
    note: completeness === 'unknown' ? 'No requirement list is recorded for this Team: closed tasks show that the planned work is done, not that the request is fully covered.'
      : completeness === 'incomplete' ? 'Some recorded requirements have no approved task plan; closing every task does not cover them.'
      : 'Every recorded requirement has at least one approved task plan.' }
}

/** The published snapshot in the shape the window collector reads a plan in, or undefined when none was published. */
export function publishedWindowPlan(state) {
  const row = state?.v15WindowPlan
  if (!row || !/^[a-f0-9]{64}$/.test(row.contentHash ?? '') || !Number.isSafeInteger(row.planRevision) || hashOf(row.content) !== row.contentHash) return undefined
  return { planId: row.planId, planRevision: row.planRevision, planHash: row.planHash, projection: true, items: row.content.items,
    coverage: row.content.coverage, ref: { path: 'control-plane:v15WindowPlan#' + row.planRevision, sha256: row.contentHash } }
}

/**
 * Publish the current projection for a Team. Identical content keeps the existing revision.
 * @returns `{ changed, plan }` where plan is in the collector's shape.
 */
export async function publishWindowPlan(control, agent, { now = Date.now } = {}) {
  if (typeof control?.mutateHot !== 'function') throw Object.assign(new Error('WINDOW_PLAN_CONTROL_REQUIRED'), { code: 'WINDOW_PLAN_CONTROL_REQUIRED' })
  let outcome
  // Nothing to publish is the common case (every install and every fold asks); it must not touch the control plane,
  // whose revision is part of what a checkpoint is bound to.
  const current = control.snapshot({ history: false, copy: false })
  if (current?.v15WindowPlan?.contentHash === hashOf(deriveWindowPlan(current))) {
    const plan = publishedWindowPlan(current)
    if (plan) return { changed: false, plan: structuredClone(plan) }
  }
  await control.mutateHot('v15/window-plan-published', {}, agent, latest => {
    const content = deriveWindowPlan(latest), contentHash = hashOf(content), prior = latest.v15WindowPlan
    if (prior?.contentHash === contentHash && publishedWindowPlan(latest)) { outcome = { changed: false }; return }
    const planId = 'derived:' + String(latest.rootId ?? control.rootId ?? 'team'), planRevision = (Number.isSafeInteger(prior?.planRevision) ? prior.planRevision : 0) + 1
    latest.v15WindowPlan = { planId, planRevision, contentHash, planHash: hashOf({ planId, planRevision, contentHash }), publishedAt: now(), content }
    outcome = { changed: true }
  }, { deferMs: 0 })
  await control.flush?.()
  const plan = publishedWindowPlan(control.snapshot({ history: false, copy: true }))
  if (!plan) throw Object.assign(new Error('WINDOW_PLAN_PUBLISH_FAILED'), { code: 'WINDOW_PLAN_PUBLISH_FAILED' })
  return { changed: outcome?.changed === true, plan }
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
