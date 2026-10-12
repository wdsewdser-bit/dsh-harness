#!/usr/bin/env node
/** Active idle-watch entry: repeated no-progress stop episodes must all remind. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, DEFAULTS } from '../home/profiles/web/plugins/team-idle-watch-v3.mjs'

const controlDir = mkdtempSync(join(tmpdir(), 'dsh-idle-no-cap-'))
const listeners = []
const followups = []
const root = { status: 'idle', followup: (message) => followups.push(message) }
const teams = {
  tryMembership(agent) {
    return agent === root ? { id: 'team-no-cap', root, name: 'lead' } : undefined
  },
  listMembers() {
    return [
      { role: 'lead', status: root.status },
      { role: 'teammate', status: root.status },
    ]
  },
}
const host = {
  on(name, listener) {
    if (name === 'agent/status') listeners.push(listener)
    return () => {}
  },
  get(name) {
    return name === 'agentTeams' ? teams : undefined
  },
  inject(_names, callback) {
    callback(host)
  },
}

const waitFor = async (predicate) => {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for idle reminder')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

try {
  assert.equal(DEFAULTS.maxNoProgressReminders, undefined)
  apply({ logger: { info: () => {}, warn: () => {} }, inject: host.inject }, {
    settleMs: 10,
    controlDir,
  })
  assert.equal(listeners.length, 1)

  for (let episode = 1; episode <= 4; episode += 1) {
    listeners[0]({ agent: root, status: 'running' })
    root.status = 'running'
    listeners[0]({ agent: root, status: 'idle' })
    root.status = 'idle'
    await waitFor(() => followups.length === episode)
  }

  assert.equal(followups.length, 4)
  console.log('PASS repeated no-progress stop episodes keep reminding without a cap')
} finally {
  rmSync(controlDir, { recursive: true, force: true })
}
