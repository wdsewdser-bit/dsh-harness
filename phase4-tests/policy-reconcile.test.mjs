import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const m = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\team-policy.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : '')) }

// ---- the durable provenance stamp ----
const stamped = m.stampDescription('probe', { tier: 2, group: 'alpha', parent: 'alpha' })
check('the stamp keeps the description readable', stamped.indexOf('probe [') === 0, stamped)
check('the stamp round-trips', JSON.stringify(m.parseStamp(stamped)) === JSON.stringify({ tier: 2, group: 'alpha', parent: 'alpha' }), stamped)
check('stripStamp restores the description', m.stripStamp(stamped) === 'probe', JSON.stringify(m.stripStamp(stamped)))
check('re-stamping never doubles', (m.stampDescription(stamped, { tier: 1, group: 'g', parent: 'lead' }).match(/\[v2 /g) || []).length === 1)
check('an unstamped description parses to undefined', m.parseStamp('probe') === undefined)

// ---- the restart: the Domain remembers every name, the registry remembers none ----
const R = m.createRegistry()
m.putMember(R, { name: 'lead', tier: 0, group: 'root' })
const roster = [
  { id: 'root', name: 'lead', role: 'lead', status: 'running' },
  { id: 'm1', name: 'alpha', role: 'teammate', status: 'inactive', description: m.stampDescription('probe', { tier: 1, group: 'alpha', parent: 'lead' }) },
  { id: 'm2', name: 'a2', role: 'teammate', status: 'inactive', description: m.stampDescription('probe', { tier: 2, group: 'alpha', parent: 'alpha' }) },
]
check('before the rebuild the member is invisible', m.getMember(R, 'alpha') === undefined)
m.reconcileRegistry(R, roster)
check('a restart re-adopts the tier-1 group lead', m.getMember(R, 'alpha') !== undefined && m.getMember(R, 'alpha').tier === 1 && m.getMember(R, 'alpha').group === 'alpha', JSON.stringify(m.getMember(R, 'alpha')))
check('a restart re-adopts the tier-2 member', m.getMember(R, 'a2') !== undefined && m.getMember(R, 'a2').tier === 2 && m.getMember(R, 'a2').parent === 'alpha', JSON.stringify(m.getMember(R, 'a2')))
check('the lead sees the adopted group lead again', m.canSee(R, 'lead', 'alpha'))
check('the lead still does not see a tier 2 member', !m.canSee(R, 'lead', 'a2'))
check('the lead can message an adopted member again', m.canMessage(R, 'lead', 'alpha') === true)
check('the rebuilt tier is enforced, not guessed', m.canMessage(R, 'a2', 'lead') === false && m.canSpawn(R, 'a2', 2, 'alpha').ok === false)

// ---- a member that predates the stamp ----
const R2 = m.createRegistry()
m.putMember(R2, { name: 'lead', tier: 0, group: 'root' })
m.reconcileRegistry(R2, [{ id: 'm3', name: 'legacy', role: 'teammate', status: 'inactive', description: 'probe' }])
check('an unstamped member is still adopted, as a visible tier-1 peer', m.getMember(R2, 'legacy') !== undefined && m.getMember(R2, 'legacy').tier === 1, JSON.stringify(m.getMember(R2, 'legacy')))
check('an unstamped member is never silently unrestricted', m.canInterrupt(R2, 'legacy', 'lead') === false)

// ---- a caller's roster is one Domain Team, so reconcile may only add ----
const R3 = m.createRegistry()
m.putMember(R3, { name: 'lead', tier: 0, group: 'root' })
m.putMember(R3, { name: 'lead-b', tier: 1, group: 'lead-b', parent: 'lead' })
m.reconcileRegistry(R3, [{ id: 'x', name: 'lead-b', role: 'lead', status: 'running' }])
check('a partial roster never deletes another group', m.getMember(R3, 'lead-b') !== undefined)
check('a lead row is never adopted as a teammate', m.getMember(R3, 'lead').tier === 0)
m.reconcileRegistry(R3, [{ id: 'failed-1', name: 'failed-one', role: 'teammate', status: 'failed', level: 1, groupId: 'failed-one', parentName: 'lead' }])
check('a failed provisioning row is removed from the live policy registry', m.getMember(R3, 'failed-one') === undefined)
check('a failed row returns its name and create quota', m.canSpawn(R3, 'lead', 1, 'failed-one').ok === true)
check('reconcile tolerates a missing roster', m.reconcileRegistry(R3, undefined) === R3)

// ---- the domain snapshot is the source of truth ----
// The forked domain carries level/groupId/parentName on every member row, so a
// brand-new registry rebuilt from the roster alone reproduces the whole tree with
// no side file, no restart hazard, and no cross-process staleness.
const R4 = m.createRegistry()
m.reconcileRegistry(R4, [
  { name: 'lead', role: 'lead', level: 0, groupId: 'root' },
  { name: 'alpha', role: 'teammate', level: 1, groupId: 'alpha', parentName: 'lead' },
  { name: 'a2', role: 'teammate', level: 2, groupId: 'alpha', parentName: 'alpha' },
])
check('the roster alone rebuilds the lead', m.getMember(R4, 'lead')?.tier === 0, JSON.stringify(m.getMember(R4, 'lead')))
check('the roster alone rebuilds a group lead', m.getMember(R4, 'alpha')?.tier === 1 && m.getMember(R4, 'alpha')?.group === 'alpha', JSON.stringify(m.getMember(R4, 'alpha')))
check('the roster alone rebuilds a tier 2 member and its parent', m.getMember(R4, 'a2')?.tier === 2 && m.getMember(R4, 'a2')?.parent === 'alpha', JSON.stringify(m.getMember(R4, 'a2')))
check('a rebuilt registry enforces the same visibility', m.canMessage(R4, 'a2', 'lead') === false && m.canSee(R4, 'a2', 'alpha') === true)
const R5 = m.createRegistry()
m.reconcileRegistry(R5, [{ name: 'legacy2', role: 'teammate' }])
check('a row with no level is adopted as a visible tier-1 peer', m.getMember(R5, 'legacy2')?.tier === 1)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
