#!/usr/bin/env node
/** Idle-watch bootstrap: an already-stopped Team must be found without a fresh status event. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../home/profiles/web/plugins/team-idle-watch-v5.mjs'

const controlDir = mkdtempSync(join(tmpdir(), 'dsh-idle-bootstrap-'))
const followups = []
const root = {
  status: 'idle',
  followup(message) {
    followups.push(message)
  },
}
const member = { status: 'idle' }
const teams = {
  tryMembership(agent) {
    if (agent === root) return { id: 'team-bootstrap', root, name: 'lead' }
    if (agent === member) return { id: 'team-bootstrap', root, name: 'member' }
    return undefined
  },
  listMembers() {
    return [
      { name: 'lead', role: 'lead', status: root.status },
      { name: 'member', role: 'teammate', status: member.status },
    ]
  },
}
const host = {
  agents: { list: () => [root, member] },
  get(name) {
    if (name === 'agents') return this.agents
    if (name === 'agentTeams') return teams
    return undefined
  },
  on() {
    return () => {}
  },
  effect() {
    return () => {}
  },
}

const waitFor = async (predicate) => {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for bootstrap idle reminder')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

try {
  apply({ logger: { info: () => {}, warn: () => {} }, inject: (_deps, callback) => callback(host) }, {
    settleMs: 50,
    bootstrapScanMs: 10,
    controlDir,
  })
  await waitFor(() => followups.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(followups.length, 1)
  console.log('PASS bootstrap scan reminds an already-stopped Team without a status event')
} finally {
  rmSync(controlDir, { recursive: true, force: true })
}
