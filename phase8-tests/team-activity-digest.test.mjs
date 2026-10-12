#!/usr/bin/env node
import { activityDigestText, buildActivitySnapshot } from '../home/profiles/web/plugins/team-activity-digest.mjs'

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const rows = [
  { name: 'lead', role: 'lead', status: 'idle' },
  { name: 'lead-a', role: 'teammate', level: 1, groupId: 'g-a', status: 'running' },
  { name: 'a1', role: 'teammate', level: 2, parentName: 'lead-a', groupId: 'g-a', status: 'running' },
  { name: 'a2', role: 'teammate', level: 2, parentName: 'lead-a', groupId: 'g-a', status: 'idle' },
]
const state = {
  leases: {
    run1: { runId: 'run1', member: 'a1', taskId: 't1', status: 'active' },
  },
  boards: {
    global: {
      tasks: {
        t1: { id: 't1', status: 'in_progress', phase: 'execution', ownerName: 'a1', writeScopes: ['src'] },
        t2: { id: 't2', status: 'in_progress', phase: 'plan-approved', ownerName: 'a2', writeScopes: ['docs'] },
        t3: { id: 't3', status: 'completed', phase: 'accepted', ownerName: 'a1' },
      },
    },
  },
}

const active = buildActivitySnapshot(rows, state)
check('an active running member makes the digest active', active.active === true, JSON.stringify(active))
check('the digest counts only open tasks', active.openTaskCount === 2, JSON.stringify(active))
check('the digest counts active leases', active.activeLeaseCount === 1, JSON.stringify(active))
check('an idle owner with open work is surfaced for inspection',
  active.idleWithOpen.some((row) => row.group === 'g-a' && row.name === 'a2'),
  JSON.stringify(active.idleWithOpen))
const text = activityDigestText(active, 'lead', 'team-1')
check('the digest text identifies the active group and the idle-with-open member',
  text.includes('g-a') && text.includes('a2') && text.includes('activeLeases=1'),
  text)

const verifierOnly = buildActivitySnapshot([
  { name: 'lead', role: 'lead', status: 'idle' },
  { name: 'verifier', role: 'teammate', level: 1, groupId: 'verifier', status: 'running' },
], { leases: {}, boards: {} })
check('a running verifier alone keeps the activity digest active', verifierOnly.active === true, JSON.stringify(verifierOnly))
check('the verifier group appears in the digest', verifierOnly.groups.some((group) => group.group === 'verifier'), JSON.stringify(verifierOnly.groups))

const idle = buildActivitySnapshot(rows.map((row) => ({ ...row, status: row.name === 'a1' ? 'idle' : row.name === 'lead-a' ? 'idle' : row.status })), {
  leases: {},
  boards: { global: { tasks: { t3: { id: 't3', status: 'completed', ownerName: 'a1' } } } },
})
check('a Team with no running member, lease or open task is inactive', idle.active === false, JSON.stringify(idle))

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
