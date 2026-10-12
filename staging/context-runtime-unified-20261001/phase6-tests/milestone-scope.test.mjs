#!/usr/bin/env node
/** Team-scoped milestone storage: same member names in different sessions do not collide. */
import {
  createMilestoneDoc,
  milestoneNotice,
  milestoneScope,
  normalizeMilestoneDoc,
  pendingReminder,
  setMilestone,
} from '../home/profiles/web/plugins/team-milestone.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}

const doc = createMilestoneDoc()
const teamA = milestoneScope(doc, 'session-a')
const teamB = milestoneScope(doc, 'session-b')

setMilestone(teamA, 'lead', 'A stage', 'A proof', 100)
setMilestone(teamB, 'lead', 'B stage', 'B proof', 200)

check('same member name is stored in separate Team buckets',
  Object.keys(doc.teams).sort().join(',') === 'session-a,session-b')
check('each Team reads its own milestone record',
  teamA.members.lead.stage === 'A stage' && teamB.members.lead.stage === 'B stage')
check('a reminder band is scoped to one Team', (() => {
  const due = pendingReminder(teamA, 'lead', 0.21)
  return due !== undefined && due.band === 1 && teamB.bands.lead === undefined
})())
check('the same name does not leak through the legacy top-level fields',
  Object.keys(doc.members).length === 0)

const legacy = normalizeMilestoneDoc({ version: 1, members: { old: { stage: 'old' } }, bands: { old: 1 } })
check('loading a v1 document preserves it for explicit migration', legacy.members.old.stage === 'old' && legacy.version === 3)
check('loading a v1 document creates an empty Team map', legacy.teams !== null && typeof legacy.teams === 'object')

const notice = milestoneNotice({ setAt: 123, stage: 'stage', doneWhen: 'proof', done: false })
check('the conversation marker is stable and identifies the exact revision',
  notice.startsWith('[team milestone #123]') && notice.includes('not ticked yet'))

console.log('checks=all failed=' + failed)
process.exitCode = failed === 0 ? 0 : 1
