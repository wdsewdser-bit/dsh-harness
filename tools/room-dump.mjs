#!/usr/bin/env node
/** Dump room/round membership and speaker progress for one Team control plane. */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootId = process.argv[2]
const home = process.argv[3] || 'D:\\dsh-test\\home'
if (!rootId) {
  console.error('usage: node room-dump.mjs <rootId> [homeDir]')
  process.exit(2)
}

const modulePath = path.join(home, 'profiles', 'web', 'plugins', 'team-control-plane.mjs')
const mod = await import(pathToFileURL(modulePath).href)
const snapshot = mod.controlPlaneFor(rootId, { home }).snapshot()

for (const [roomId, room] of Object.entries(snapshot.rooms ?? {})) {
  const round = room?.currentRoundId == null ? undefined : snapshot.rounds?.[room.currentRoundId]
  console.log(JSON.stringify({
    roomId,
    kind: room?.kind ?? null,
    status: room?.status ?? null,
    members: room?.members ?? null,
    order: round?.order ?? null,
    spoken: round?.spoken ?? null,
    nextSpeaker: round?.nextSpeaker ?? null,
    roundStatus: round?.status ?? null,
    host: round?.host ?? room?.host ?? null,
    topic: String(round?.topic ?? '').slice(0, 120),
  }, null, 1))
}
