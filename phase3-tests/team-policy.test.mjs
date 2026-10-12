import { pathToFileURL } from 'node:url'
const m = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\team-policy.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : '')) }

const R = m.createRegistry()
m.putMember(R, { name: 'lead', tier: 0, group: 'root' })
m.putMember(R, { name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' })
m.putMember(R, { name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead' })
m.putMember(R, { name: 'lead-b', tier: 1, group: 'lead-b', parent: 'lead' })
for (const n of ['a1', 'a2', 'a3']) m.putMember(R, { name: n, tier: 2, group: 'lead-a', parent: 'lead-a' })
m.putMember(R, { name: 'b1', tier: 2, group: 'lead-b', parent: 'lead-b' })

// ---- visibility ----
// §6: the Lead's roster is the tier-1 leads. Tier-2 members belong to their own
// group lead; the human operator is the one who sees the whole Team.
check('lead sees the tier 1 leads', ['verifier','lead-a','lead-b'].every((n) => m.canSee(R, 'lead', n)))
check('lead does not see other groups tier 2 members', !m.canSee(R, 'lead', 'a1') && !m.canSee(R, 'lead', 'b1'))
check('lead sees itself', m.canSee(R, 'lead', 'lead'))
check('a group lead sees its own member but not another group', m.canSee(R, 'lead-a', 'a1') && !m.canSee(R, 'lead-a', 'b1'))
check('lead-b sees its own child', m.canSee(R, 'lead-b', 'b1'))
check('lead-a cannot see lead-b members (group isolation)', m.canSee(R, 'lead-a', 'b1') === false)
check('lead-a sees a tier-1 peer', m.canSee(R, 'lead-a', 'lead-b'))
check('tier2 sees the root (view allowed)', m.canSee(R, 'a1', 'lead'))
check('tier2 sees same-group sibling', m.canSee(R, 'a1', 'a2'))
check('tier2 sees its parent lead', m.canSee(R, 'a1', 'lead-a'))
check('tier2 cannot see another group', m.canSee(R, 'a1', 'b1') === false)
check('tier2 cannot see another group lead', m.canSee(R, 'a1', 'lead-b') === false)

// ---- messaging ----
// §5: tier 0 talks to tier 1 only. A tier-2 member is read-only to the Lead and
// work reaches it through its own group lead.
check('lead messages a group lead', m.canMessage(R, 'lead', 'lead-a'))
check('lead does not message a tier 2 member', !m.canMessage(R, 'lead', 'a1'))
check('the refusal names the group lead to route through', String(m.whyCannotMessage(R, 'lead', 'a1')).includes('lead-a'), String(m.whyCannotMessage(R, 'lead', 'a1')))
check('lead still cannot be messaged from below', !m.canMessage(R, 'a1', 'lead'))
check('tier2 CANNOT message the root', m.canMessage(R, 'a1', 'lead') === false)
check('tier2 messages its parent', m.canMessage(R, 'a1', 'lead-a'))
check('tier2 messages same-group peer', m.canMessage(R, 'a1', 'a2'))
check('tier2 cannot message another group', m.canMessage(R, 'a1', 'b1') === false)
check('tier1 messages the root', m.canMessage(R, 'lead-a', 'lead'))
check('tier1 messages a peer lead', m.canMessage(R, 'lead-a', 'lead-b'))
check('tier1 messages only its OWN child', m.canMessage(R, 'lead-a', 'a1') && m.canMessage(R, 'lead-a', 'b1') === false)

// ---- interrupt ----
check('lead interrupts anyone', m.canInterrupt(R, 'lead', 'lead-a'))
check('lead controls only its own child', m.canInterrupt(R, 'lead-a', 'a1') && m.canInterrupt(R, 'lead-a', 'b1') === false)
check('same-level peers cannot interrupt', m.canInterrupt(R, 'a1', 'a2') === false && m.canInterrupt(R, 'lead-a', 'lead-b') === false)
check('tier2 cannot interrupt upward', m.canInterrupt(R, 'a1', 'lead-a') === false && m.canInterrupt(R, 'a1', 'lead') === false)

// ---- spawn caps ----
check('lead may open a new group', m.canSpawn(R, 'lead', 1, 'lead-c').ok)
const RC = m.createRegistry()
m.putMember(RC, { name: 'lead', tier: 0, group: 'root' })
m.putMember(RC, { name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' })
for (const L of ['c1','c2','c3','c4','c5','c6','c7']) m.putMember(RC, { name: L, tier: 1, group: L, parent: 'lead' })
check('verifier does not consume a group-lead slot', m.canSpawn(RC, 'lead', 1, 'c8').ok === true, JSON.stringify(m.canSpawn(RC, 'lead', 1, 'c8')))
m.putMember(RC, { name: 'c8', tier: 1, group: 'c8', parent: 'lead' })
check('lead is capped at 8 group leads', m.canSpawn(RC, 'lead', 1, 'c9').ok === false, JSON.stringify(m.canSpawn(RC, 'lead', 1, 'c9')))
check('verifier slot is single', m.canSpawn(R, 'lead', 1, 'verifier').ok === false)
for (const n of ['a4','a5','a6','a7','a8']) m.putMember(R, { name: n, tier: 2, group: 'lead-a', parent: 'lead-a' })
check('lead-a is refused a 9th member', m.canSpawn(R, 'lead-a', 2, 'lead-a').ok === false, JSON.stringify(m.canSpawn(R, 'lead-a', 2, 'lead-a')))
const R2 = m.createRegistry()
for (const n of ['lead','lead-a']) m.putMember(R2, { name: n, tier: n === 'lead' ? 0 : 1, group: n === 'lead' ? 'root' : 'lead-a', parent: n === 'lead' ? undefined : 'lead' })
for (const n of ['x1','x2','x3','x4','x5','x6','x7','x8']) m.putMember(R2, { name: n, tier: 2, group: 'lead-a', parent: 'lead-a' })
check('group capped at 8 members', m.canSpawn(R2, 'lead-a', 2, 'lead-a').ok === false, JSON.stringify(m.canSpawn(R2, 'lead-a', 2, 'lead-a')))
check('tier1 cannot spawn tier1', m.canSpawn(R, 'lead-a', 1, 'lead-a').ok === false)
check('tier1 cannot spawn tier0', m.canSpawn(R, 'lead-a', 0).ok === false)
check('tier2 cannot spawn at all', m.canSpawn(R, 'a1', 2, 'lead-a').ok === false)
check('verifier group owns no members', m.canSpawn(R, 'verifier', 2, 'verifier').ok === false)

// ---- boards ----
check('only tier0 writes the global board', m.canWriteGlobalBoard(R, 'lead') && !m.canWriteGlobalBoard(R, 'lead-a') && !m.canWriteGlobalBoard(R, 'a1'))
check('global board readable by all', ['lead','lead-a','a1','verifier'].every((n) => m.canReadBoard(R, n, 'global')))
check('group board isolated', m.canReadBoard(R, 'a1', 'group-lead-a') && !m.canReadBoard(R, 'a1', 'group-lead-b'))

// ---- freeze ----
check('freeze is a distinct state', m.setFrozen(R, 'a1', true) === false)
check('frozen member cannot send', m.canMessage(R, 'a1', 'a2') === false)
check('frozen member cannot receive', m.canMessage(R, 'a2', 'a1') === false)
check('frozen member cannot be interrupted', m.canInterrupt(R, 'lead', 'a1') === false)
check('frozen member cannot spawn', m.canSpawn(R, 'a1', 2).ok === false)
check('thaw restores messaging', m.setFrozen(R, 'a1', false) === true && m.canMessage(R, 'a1', 'a2'))

// ---- refusal reasons must name the REAL cause ----
// A real headless run refused a message to a FROZEN target with the text
// "may not message (tier 0)"; the model then reasoned about tier rules instead
// of the freeze. These assertions pin the reason to the actual predicate.
m.setFrozen(R, 'a1', true)
const frozenMsg = m.whyCannotMessage(R, 'lead', 'a1')
check('frozen-target refusal names the freeze', /frozen/.test(frozenMsg || ''), frozenMsg)
const frozenInt = m.whyCannotInterrupt(R, 'lead', 'a1')
check('frozen-target interrupt refusal names the freeze', /frozen/.test(frozenInt || ''), frozenInt)
m.setFrozen(R, 'a1', false)
const upward = m.whyCannotMessage(R, 'a1', 'lead')
check('upward refusal names the visibility asymmetry', /may see the Lead but may not message/.test(upward || ''), upward)
const crossGroup = m.whyCannotMessage(R, 'lead-a', 'b1')
check('cross-group refusal names the owning group', /belongs to group "lead-b"/.test(crossGroup || ''), crossGroup)
const foreignInterrupt = m.whyCannotInterrupt(R, 'lead-a', 'b1')
check('foreign interrupt refusal names the real spawner', /was spawned by "lead-b"/.test(foreignInterrupt || ''), foreignInterrupt)
check('permitted message has no reason', m.whyCannotMessage(R, 'a2', 'a3') === undefined)
check('permitted interrupt has no reason', m.whyCannotInterrupt(R, 'lead-a', 'a2') === undefined)

// ---- the 13-teammate arithmetic ----
const R3 = m.createRegistry()
m.putMember(R3, { name: 'lead', tier: 0, group: 'root' })
let teammates = 1 // verifier
m.putMember(R3, { name: 'verifier', tier: 1, group: 'verifier', parent: 'lead' })
for (const L of ['l1','l2','l3']) {
  teammates++
  m.putMember(R3, { name: L, tier: 1, group: L, parent: 'lead' })
  for (let i = 0; i < 3; i++) { teammates++; m.putMember(R3, { name: L + '-' + i, tier: 2, group: L, parent: L }) }
}
check('full team is exactly 13 teammates', teammates === 13, 'teammates=' + teammates)

// ---- board documents must be lossless JSON ----
// A live Team run lost its group board to exactly this: the registry rejects a
// tool result that carries an explicit undefined, so an unclaimed task must not
// have an ownerName key at all.
const boards = m.createBoards()
const created = m.boardCreate(boards, 'group-alpha', { subject: 's', description: 'd' })
check('a new task has no ownerName key', !('ownerName' in created), JSON.stringify(created))
check('a new task survives a JSON round trip unchanged', JSON.stringify(created) === JSON.stringify(JSON.parse(JSON.stringify(created))))
const claimed = m.boardUpdate(boards, 'group-alpha', { taskId: created.id, expectedRevision: 1, action: 'reassign', owner: 'a1' }, 'lead')
check('reassign names an owner', claimed.ownerName === 'a1')
const unassigned = m.boardUpdate(boards, 'group-alpha', { taskId: created.id, expectedRevision: claimed.revision, action: 'reassign' }, 'lead')
check('reassign to nobody drops the key again', !('ownerName' in unassigned), JSON.stringify(unassigned))

// ---- an unknown actor owns no board, and the refusal says so ----
check('an unregistered actor resolves to no board', m.boardOf(R, 'nobody', 'group') === undefined)
// §5: tier 0 owns the global board plus its own group board, and has no level board.
check('tier 0 resolves group to its own group board', m.boardOf(R, 'lead', 'group') === 'group-root')
check('tier 0 has no level board', m.boardOf(R, 'lead', 'level') === 'global')
check('a group lead resolves to its own group board', m.boardOf(R, 'lead-a', 'group') === 'group-lead-a')
check('a group lead resolves to its level board', m.boardOf(R, 'lead-a', 'level') === 'level-1')

console.log('---')
console.log('total=' + (failed === 0 ? 'all' : 'has failures') + ' failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
