#!/usr/bin/env node
/** Phase 6: self-declared milestones and the compaction anchor (Agent Team v3). */
import { band, canReadMilestone, createMilestoneDoc, setMilestone, markMilestoneDone, armMilestoneCompaction, pendingMilestoneCompaction, consumeMilestoneCompaction, pendingReminder, acknowledgeReminder, shouldCompact, markCompacted, reminderText, BAND_START, HARD_RATIO } from '../home/profiles/web/plugins/team-milestone.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}

// ---- the reminder band, and why it is idempotent ----
check('below the start ratio nothing is due', band(0.19) === 0, String(band(0.19)))
check('the start ratio is band 1', band(BAND_START) === 1, String(band(BAND_START)))
check('0.3 lands on band 2 despite float error', band(0.3) === 2, String(band(0.3)))
check('0.35 is still band 2', band(0.35) === 2, String(band(0.35)))
check('0.9 is band 8, so a forgetful model keeps being reminded', band(0.9) === 8, String(band(0.9)))
check('a non-number ratio is band 0', band(undefined) === 0 && band('x') === 0)

// ---- who may see whose milestone ----
const lead = { name: 'lead', tier: 0 }
const alpha = { name: 'alpha', tier: 1, group: 'alpha', parent: 'lead' }
const beta = { name: 'beta', tier: 1, group: 'beta', parent: 'lead' }
const a1 = { name: 'a1', tier: 2, group: 'alpha', parent: 'alpha' }
const a2 = { name: 'a2', tier: 2, group: 'alpha', parent: 'alpha' }
const b1 = { name: 'b1', tier: 2, group: 'beta', parent: 'beta' }
check('an agent reads its own milestone', canReadMilestone(a1, a1))
check('tier 0 reads a group lead', canReadMilestone(lead, alpha))
check('tier 0 does NOT reach a tier 2 member', canReadMilestone(lead, a1) === false)
check('a group lead reads its own member', canReadMilestone(alpha, a1))
check('a group lead does NOT read another group member', canReadMilestone(beta, a1) === false)
check('a member reads its own direct superior', canReadMilestone(a1, alpha))
check('a member does NOT read the tier 0 lead', canReadMilestone(a1, lead) === false)
check('peers read each other for coordination', canReadMilestone(a1, a2) && canReadMilestone(a2, a1))
check('peer group leads read each other', canReadMilestone(alpha, beta))
check('a member does NOT read an unrelated member', canReadMilestone(a1, b1) === false)

// ---- set / tick ----
const doc = createMilestoneDoc()
check('an empty document starts with no members', Object.keys(doc.members).length === 0)
const rec = setMilestone(doc, 'a1', '双门离屏渲染跑通', 'node tools/portal-check.js 输出 PASS', 1000)
check('setting a milestone stores the stage and its proof', rec.stage === '双门离屏渲染跑通' && rec.doneWhen.includes('portal-check') && rec.done === false)
check('a fresh milestone is un-ticked and un-compacted', rec.done === false && rec.compactedAt === undefined)
check('a milestone is owned by exactly one name', Object.keys(doc.members).join() === 'a1')
check('ticking marks it done with a timestamp', markMilestoneDone(doc, 'a1', 2000).done === true && doc.members.a1.doneAt === 2000)
check('ticking a milestone that was never set returns undefined', markMilestoneDone(doc, 'ghost', 1) === undefined)

// ---- re-setting must not re-earn old reminders ----
{
  const d = createMilestoneDoc()
  setMilestone(d, 'a1', 'first', 'x', 1)
  acknowledgeReminder(d, 'a1', 3)
  setMilestone(d, 'a1', 'second', 'y', 2)
  check('replacing a milestone does not re-earn old reminders', pendingReminder(d, 'a1', 0.31) === undefined)
  check('but the next band still reminds', pendingReminder(d, 'a1', 0.51) !== undefined && pendingReminder(d, 'a1', 0.51).band === 4, String(band(0.51)))
}

// ---- the reminder is driven by bands, not by memory ----
{
  const d = createMilestoneDoc()
  check('nothing is due below the start ratio', pendingReminder(d, 'a1', 0.15) === undefined)
  const first = pendingReminder(d, 'a1', 0.21)
  check('an agent with no milestone is still reminded at 0.2', first !== undefined && first.band === 1 && first.record === undefined)
  acknowledgeReminder(d, 'a1', first.band)
  check('the same band is never reminded twice', pendingReminder(d, 'a1', 0.22) === undefined)
  const second = pendingReminder(d, 'a1', 0.31)
  check('the next band reminds again, so forgetting is recoverable', second !== undefined && second.band === 2)
  acknowledgeReminder(d, 'a1', second.band)
  setMilestone(d, 'a1', 'stage', 'proof', 5)
  acknowledgeReminder(d, 'a1', second.band)
  const third = pendingReminder(d, 'a1', 0.41)
  check('once it declares a milestone the reminder carries the record', third !== undefined && third.record !== undefined && third.record.stage === 'stage')
  check('a band already delivered stays delivered after declaring', pendingReminder(d, 'a1', 0.35) === undefined)
}

// ---- tick arms, hard threshold fires ----
check('an un-ticked milestone below the hard threshold does not compact', shouldCompact({ done: false }, 0.4).yes === false)
check('a ticked milestone arms a compaction', shouldCompact({ done: true }, 0.4).yes === true && shouldCompact({ done: true }, 0.4).reason === 'milestone')
check('context pressure alone triggers a safety fold', shouldCompact(undefined, HARD_RATIO).yes === true && shouldCompact(undefined, HARD_RATIO).reason === 'pressure')
check('just below the hard threshold nothing fires', shouldCompact(undefined, HARD_RATIO - 0.01).yes === false)
check('a milestone never compacts twice', shouldCompact({ done: true, compactedAt: 7 }, 0.4).yes === false)
check('marking a compaction is recorded', markCompacted({ version: 1, members: { a1: { done: true, setAt: 100 } } }, 'a1', 99, 100).compactedAt === 99)
check('a hard-threshold fold never stamps the current milestone', markCompacted({ version: 1, members: { a1: { done: true, setAt: 100 } } }, 'a1', 99).compactedAt === undefined)

// ---- tick, then immediately declare the next milestone ----
{
  const d = createMilestoneDoc()
  setMilestone(d, 'a1', 'S0', 'proof S0', 100)
  markMilestoneDone(d, 'a1', 200)
  const job = armMilestoneCompaction(d, 'a1', 201)
  setMilestone(d, 'a1', 'S1', 'proof S1', 202)
  check('setting the next milestone keeps the ticked fold armed',
    job !== undefined && d.compactions.a1?.milestoneSetAt === 100)
  check('the replacement milestone itself is not marked compacted',
    markCompacted(d, 'a1', 300, 100)?.setAt === 202 && d.members.a1.compactedAt === undefined)
  d.compactions.a1.status = 'compacted'
  check('a consumed fold does not remain pending', pendingMilestoneCompaction(d, 'a1') === undefined)
}

// ---- a stale job can never fold a newer milestone ----
{
  const d = createMilestoneDoc()
  setMilestone(d, 'a1', 'old', 'old proof', 100)
  markMilestoneDone(d, 'a1', 200)
  armMilestoneCompaction(d, 'a1', 201)
  setMilestone(d, 'a1', 'new', 'new proof', 202)
  check('a freshly ticked old job survives a set of the next milestone',
    pendingMilestoneCompaction(d, 'a1', 203)?.milestoneSetAt === 100)
  const legacy = createMilestoneDoc()
  legacy.members.a1 = { owner: 'a1', stage: 'old', doneWhen: 'x', setAt: 100, done: false }
  legacy.compactions.a1 = { kind: 'milestone', status: 'pending-idle', reason: 'milestone', milestoneSetAt: 100, milestoneStage: 'old', requestedAt: 201, attempts: 0 }
  check('an old job without a provably complete revision is not returned',
    pendingMilestoneCompaction(legacy, 'a1', 201) === undefined)
  d.compactions.a1.status = 'compacted'
  check('a compacted old job is not returned for a newer un-ticked milestone',
    pendingMilestoneCompaction(d, 'a1') === undefined)
  markMilestoneDone(d, 'a1', 203)
  const current = armMilestoneCompaction(d, 'a1', 204)
  check('ticking the new revision arms a fresh job', current?.milestoneSetAt === 202)
  consumeMilestoneCompaction(d, 'a1', 205, 202)
  check('a consumed job stays consumed', pendingMilestoneCompaction(d, 'a1') === undefined)
}

// ---- the injected text has to be actionable ----
{
  const unset = reminderText({ band: 1, ratio: 0.2, record: undefined }, 200000, 1000000)
  check('the first reminder states the usage and names the tool', unset.includes('20%') && unset.includes('team_milestone(action:"set"'), unset.slice(0, 80))
  const set = reminderText({ band: 3, ratio: 0.4, record: { stage: 'S', doneWhen: 'W' } }, 400000, 1000000)
  check('a later reminder repeats the stage and its proof', set.includes('40%') && set.includes('S') && set.includes('W'))
  check('the reminder survives an unknown window size', reminderText({ band: 1, ratio: 0.2, record: undefined }, 50000, undefined).includes('50k'))
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
