import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = 'D:\\dsh-test\\home\\profiles\\web\\plugins\\'
const policy = await import(pathToFileURL(base + 'team-policy.mjs').href)

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const directory = mkdtempSync(join(tmpdir(), 'dsh-freeze-capacity-'))
try {
  const ctx = { agentTeams: { tryMembership: () => undefined } }
  policy.apply(ctx, { maxMembers: 30, maxTier1Leads: 3, maxVerifiers: 1, maxMembersPerLead: 30, controlDir: directory })
  const team = policy.policyFor('freeze-capacity-' + Date.now())
  team.put({ name: 'lead', tier: 0, group: 'root', frozen: false })
  team.put({ name: 'lead-a', tier: 1, group: 'lead-a', parent: 'lead', frozen: false })
  for (let index = 0; index < 29; index += 1) {
    team.put({ name: 'm' + index, tier: 2, group: 'lead-a', parent: 'lead-a', frozen: false })
  }

  const full = team.canSpawn('lead-a', 2, 'lead-a')
  check('30 active teammates fill the capacity', full.ok !== true, JSON.stringify(full))

  const previous = await team.setFrozenAsync('m0', true, 'lead')
  check('freeze records the previous state', previous === false, String(previous))
  team.refreshFrozen()
  check('frozen state survives a control-plane reload', team.get('m0').frozen === true)
  check('freeze frees one active slot', team.canSpawn('lead-a', 2, 'lead-a').ok === true, JSON.stringify(team.canSpawn('lead-a', 2, 'lead-a')))

  team.refreshFrozen()
  check('frozen member is retained in the registry', team.get('m0') !== undefined)
  check('frozen list exposes the parked member', team.frozenNames().includes('m0'), JSON.stringify(team.frozenNames()))

  await team.setFrozenAsync('m0', false, 'lead')
  team.refreshFrozen()
  check('restore removes the frozen marker', team.get('m0').frozen === false)
  check('restore consumes the freed capacity again', team.canSpawn('lead-a', 2, 'lead-a').ok !== true)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
