import { pathToFileURL } from 'node:url'
const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policy = await import(pathToFileURL(base + 'team-policy.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail)) }

// The registry is a PROJECTION of the domain roster. It used to ignore `frozen`, which made
// freezing useless (a member this process had not seen was adopted as unfrozen, so the cap
// stayed used) and made a restore incomplete (a stale true survived every predicate). Both
// are the model's report: 'freezing does not free a slot', 'after restore it never comes back'.
const registry = policy.createRegistry()
const leadRow = { name: 'g1-lead', role: 'lead', level: 1, groupId: 'g1', parentName: 'lead' }
const row = (name, frozen) => Object.assign({ name, role: 'teammate', level: 2, groupId: 'g1', parentName: 'g1-lead', frozen: false }, frozen === true ? { frozen: true } : {})
const memberNames = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']
const roster = (frozenNames) => [leadRow, ...memberNames.map((n) => row(n, frozenNames.includes(n)))]

policy.reconcileRegistry(registry, roster(['a1']))
check('a frozen roster row is projected as frozen', policy.getMember(registry, 'a1').frozen === true)
check('an unflagged roster row is projected as unfrozen', policy.getMember(registry, 'a2').frozen === false)

policy.reconcileRegistry(registry, roster(['a1', 'a2', 'a3']))
check('a group of frozen members is not full', policy.canSpawn(registry, 'g1-lead', 2, 'g1').ok === true, JSON.stringify(policy.canSpawn(registry, 'g1-lead', 2, 'g1')))
policy.reconcileRegistry(registry, roster(['a2', 'a3']))
check('a restored member consumes a slot again', policy.canSpawn(registry, 'g1-lead', 2, 'g1').ok === true)
policy.reconcileRegistry(registry, roster([]))
check('a fully unfrozen active group fills the cap at eight', policy.canSpawn(registry, 'g1-lead', 2, 'g1').ok !== true, JSON.stringify(policy.canSpawn(registry, 'g1-lead', 2, 'g1')))

policy.setFrozen(registry, 'a1', true)
check('setFrozen is reflected in the registry', policy.getMember(registry, 'a1').frozen === true)
policy.reconcileRegistry(registry, roster([]).map(({ frozen, ...member }) => member))
check('a legacy roster without a frozen field preserves the durable freeze', policy.getMember(registry, 'a1').frozen === true)
policy.reconcileRegistry(registry, roster([]))
check('the roster clears a stale frozen flag', policy.getMember(registry, 'a1').frozen === false)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
