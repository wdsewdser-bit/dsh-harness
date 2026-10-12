#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../home/profiles/web/plugins/team-activity-digest.mjs'

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

async function runCase(rows, key) {
  const controlDir = mkdtempSync(join(tmpdir(), 'dsh-activity-digest-'))
  const delivered = []
  const root = {
    status: 'idle',
    followup(message) {
      delivered.push(message)
      root.status = 'running'
    },
  }
  const events = []
  const ctx = {
    agents: { list: () => [root] },
    agentTeams: {
      tryMembership: () => ({ id: key, name: 'lead', role: 'lead' }),
      listMembers: () => rows,
    },
    logger: { warn: (message) => events.push(String(message)) },
  }
  const dispose = apply(ctx, { intervalMs: 25, controlDir })
  const deadline = Date.now() + 250
  while (delivered.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  dispose()
  rmSync(controlDir, { recursive: true, force: true })
  return { delivered, events }
}

const active = await runCase([
  { name: 'lead', role: 'lead', status: 'idle', groupId: 'core' },
  { name: 'core-lead', role: 'teammate', level: 1, status: 'running', groupId: 'core' },
  { name: 'worker', role: 'teammate', level: 2, status: 'running', groupId: 'core' },
], 'team-digest-active')
check('a live active Team wakes the root once', active.delivered.length === 1, JSON.stringify(active))
check('the automatic message is the activity digest',
  active.delivered.length === 1 && textOf(active.delivered[0]).includes('[team activity]'),
  active.delivered.length === 0 ? 'no message' : textOf(active.delivered[0]))
check('the digest reports the active group and running count',
  active.delivered.length === 1
    && textOf(active.delivered[0]).includes('groups=1/1 active')
    && textOf(active.delivered[0]).includes('running=2'),
  active.delivered.length === 0 ? 'no message' : textOf(active.delivered[0]))

const inactive = await runCase([
  { name: 'lead', role: 'lead', status: 'idle', groupId: 'core' },
  { name: 'core-lead', role: 'teammate', level: 1, status: 'idle', groupId: 'core' },
  { name: 'worker', role: 'teammate', level: 2, status: 'inactive', groupId: 'core' },
], 'team-digest-idle')
check('a fully idle Team stays completely silent', inactive.delivered.length === 0, JSON.stringify(inactive))

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
