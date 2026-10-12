import { pathToFileURL } from 'node:url'
const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policy = await import(pathToFileURL(base + 'team-policy.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail)) }

// Two Teams in ONE process. This used to be a single module-level registry + board store,
// so the second Team's panel showed the first Team's roster and shared tasks, and its
// spawns were refused against the first Team's caps. policyFor() keys both by Team id.
const ctx = { agentTeams: { tryMembership: () => undefined } }
policy.apply(ctx, { maxTier1Leads: 3, maxMembersPerLead: 3 })

const A = policy.policyFor('team-a')
const B = policy.policyFor('team-b')
A.put({ name: 'lead', tier: 0, group: 'root', frozen: false })
A.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead', frozen: false })
A.put({ name: 'a1', tier: 2, group: 'lead-a', parent: 'lead-a', frozen: false })
B.put({ name: 'lead', tier: 0, group: 'root', frozen: false })

check('two Teams never share a registry', A.registry !== B.registry)
check('team A sees only its own members', A.all().length === 3, String(A.all().length))
check('team B sees only its own members', B.all().length === 1, JSON.stringify(B.all().map((m) => m.name)))
check('a name known to A is unknown to B', B.get('lead-a') === undefined)
check('two Teams never share a board store', A.boards !== B.boards)
A.boardCreate('global', { subject: 'A only' })
check('A board has its task', A.boardList('global').length === 1)
check('B board stayed empty', B.boardList('global').length === 0)

// Caps are counted per Team, so filling A's group must not consume B's headroom.
A.put({ name: 'a2', tier: 2, group: 'lead-a', parent: 'lead-a', frozen: false })
A.put({ name: 'a3', tier: 2, group: 'lead-a', parent: 'lead-a', frozen: false })
const fullA = A.canSpawn('lead-a', 2, 'lead-a')
check('a full group refuses inside its own Team', fullA.ok !== true, JSON.stringify(fullA))
const roomB = B.canSpawn('lead', 1, 'lead-b')
check('the other Team still has room', roomB.ok === true, JSON.stringify(roomB))
check('activePolicy tracks the last Team resolved', policy.activePolicy() === B)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)