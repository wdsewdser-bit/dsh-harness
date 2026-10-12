#!/usr/bin/env node
/** Apply the room-seat rule to a live Team control plane without calling a model. */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootId = process.argv[2]
const home = process.argv[3] || 'D:\\dsh-test\\home'
if (!rootId) {
  console.error('usage: node v14-room-seat-check.mjs <rootId> [homeDir]')
  process.exit(2)
}

// Roster captured from the live run (panel + control plane): tier/group per member.
const ROSTER = {
  lead: { name: 'lead', tier: 0, group: 'root' },
  'lead-alpha': { name: 'lead-alpha', tier: 1, group: 'alpha' },
  'lead-beta': { name: 'lead-beta', tier: 1, group: 'beta' },
  'alpha-m1': { name: 'alpha-m1', tier: 2, group: 'alpha' },
  'alpha-m2': { name: 'alpha-m2', tier: 2, group: 'alpha' },
  'beta-m1': { name: 'beta-m1', tier: 2, group: 'beta' },
  'beta-m2': { name: 'beta-m2', tier: 2, group: 'beta' },
}

const toolsPath = path.join(home, 'profiles', 'web', 'plugins', 'team-tools-v2-r10.mjs')
const controlPath = path.join(home, 'profiles', 'web', 'plugins', 'team-control-plane.mjs')
const { roomSeatVerdict } = await import(pathToFileURL(toolsPath).href)
const { controlPlaneFor } = await import(pathToFileURL(controlPath).href)
const snapshot = controlPlaneFor(rootId, { home }).snapshot()

for (const [roomId, room] of Object.entries(snapshot.rooms ?? {})) {
  const seated = []
  const excluded = []
  for (const member of room.members ?? []) {
    const verdict = roomSeatVerdict(room.roomId, room.kind, ROSTER[member])
    ;(verdict.ok ? seated : excluded).push(member)
  }
  console.log(JSON.stringify({ roomId, kind: room.kind, seated, excluded }))
}
