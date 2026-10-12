#!/usr/bin/env node
/** team-idle-watch: stopped-state semantics and the late-stop timer path. */
import { apply, stoppedState } from '../home/profiles/web/plugins/team-idle-watch-v3.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}

check('root running means not stopped',
  stoppedState([{ role: 'lead', status: 'running' }, { role: 'teammate', status: 'idle' }], 'running').stopped === false)
check('all non-frozen subordinates idle and root idle means stopped',
  stoppedState([{ role: 'lead', status: 'idle' }, { role: 'teammate', status: 'idle' }], 'idle').stopped === true)
check('one subordinate still running means not stopped',
  stoppedState([{ role: 'lead', status: 'idle' }, { role: 'teammate', status: 'running' }], 'idle').stopped === false)
check('provisioning blocks stopped state',
  stoppedState([{ role: 'lead', status: 'idle' }, { role: 'teammate', status: 'provisioning' }], 'idle').stopped === false)
check('parked members do not create a stopped Team by themselves',
  stoppedState([{ role: 'lead', status: 'idle' }, { role: 'teammate', status: 'idle', frozen: true }, { role: 'teammate', status: 'failed' }], 'idle').stopped === false)

// The first timer expiry sees one teammate still running. Then that teammate becomes idle
// WITHOUT another agent/status event. A one-shot timer loses this stop forever; the periodic
// watchdog must still wake the root.
{
  const listeners = []
  let rootFollowups = 0
  let memberStatus = 'running'
  const rootAgent = {
    id: 'root', status: 'idle',
    followup() { rootFollowups += 1 },
    inject() {},
  }
  const member = { id: 'member', get status() { return memberStatus } }
  const teams = {
    tryMembership(agent) {
      if (agent === rootAgent) return { name: 'lead', root: rootAgent, id: 'team-1' }
      if (agent === member) return { name: 'member', root: rootAgent, id: 'team-1' }
      return undefined
    },
    listMembers() {
      return [
        { id: 'root', name: 'lead', role: 'lead', status: rootAgent.status },
        { id: 'member', name: 'member', role: 'teammate', status: memberStatus },
      ]
    },
  }
  const host = {
    on(name, fn) { if (name === 'agent/status') listeners.push(fn); return () => {} },
    get(name) { return name === 'agentTeams' ? teams : undefined },
    inject(names, callback) { callback(host) },
  }
  apply(host, { settleMs: 5, maxReminders: 100 })
  if (typeof listeners[0] !== 'function') throw new Error('idle-watch did not install its status listener')
  listeners[0]({ agent: member, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('watchdog stays armed while another member is still running', rootFollowups === 0, 'followups=' + rootFollowups)
  memberStatus = 'idle'
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('watchdog wakes the root after the last member stops without another event', rootFollowups === 1, 'followups=' + rootFollowups)
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
