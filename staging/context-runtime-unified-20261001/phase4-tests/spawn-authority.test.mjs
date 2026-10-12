import { pathToFileURL } from 'node:url'
const m = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\team-tools-v2.mjs').href)

let failed = 0
const check = (label, cond, detail) => { if (!cond) failed++; console.log((cond ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : '')) }

// One process runs one Team per open session, so two live leads coexist.
const leadA = { id: 'session-a' }
const leadB = { id: 'session-b' }
const teammate = { id: 'child-of-b' }
const stranger = { id: 'not-in-any-team' }
const ctx = {
  agents: { list: () => [leadA, leadB] },
  agentTeams: {
    tryMembership(agent) {
      if (agent === leadA) return { root: leadA, role: 'lead', name: 'lead', id: 'team-a' }
      if (agent === leadB) return { root: leadB, role: 'lead', name: 'lead', id: 'team-b' }
      if (agent === teammate) return { root: leadB, role: 'teammate', name: 'alpha', id: 'team-b' }
      return undefined
    },
  },
}

check('a lead caller is its own authority', m.rootLead(ctx, leadB) === leadB)
check('a teammate caller resolves to ITS root lead', m.rootLead(ctx, teammate) === leadB)
check('the first enumerated lead is never substituted', m.rootLead(ctx, teammate) !== leadA)
check('a non-member caller carries no authority', m.rootLead(ctx, stranger) === undefined)
check('a caller with no Team gets no authority', m.rootLead({ agents: { list: () => [] }, agentTeams: { tryMembership: () => undefined } }, leadA) === undefined)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
