import { pathToFileURL } from 'node:url'
const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policy = await import(pathToFileURL(base + 'team-policy.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail)) }

// v10 removed the lifetime create cap. Frozen members are parked and do not
// consume active capacity; only non-frozen, non-failed members count.
const ctx = { agentTeams: { tryMembership: () => undefined } }
policy.apply(ctx, { maxMembers: 30, maxTier1Leads: 100, maxVerifiers: 1, maxMembersPerLead: 100 })
const T = policy.policyFor('budget')
check('there is no lifetime create ceiling', T.registry.maxLifetimeCreates === undefined, String(T.registry.maxLifetimeCreates))

T.put({ name: 'lead', tier: 0, group: 'root', frozen: false })
for (let i = 0; i < 40; i += 1) T.put({ name: 'frozen-' + i, tier: 1, group: 'f' + i, parent: 'lead', frozen: true })
check('a parked roster does not consume active capacity', policy.canSpawn(T.registry, 'lead', 1, 'fresh-lead').ok === true, JSON.stringify(policy.canSpawn(T.registry, 'lead', 1, 'fresh-lead')))

for (let i = 0; i < 30; i += 1) T.put({ name: 'active-' + i, tier: 1, group: 'a' + i, parent: 'lead', frozen: false })
const full = policy.canSpawn(T.registry, 'lead', 1, 'overflow')
check('thirty active members fill the model capacity', full.ok !== true, JSON.stringify(full))
check('the refusal names the freeze escape hatch', /Freeze a finished member/.test(full.reason ?? ''), full.reason)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
