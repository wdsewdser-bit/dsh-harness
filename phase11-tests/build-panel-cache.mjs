import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  readControlPlaneColdValue,
  readControlPlaneRoomHistory,
} from '../home/profiles/web/plugins/team-control-plane.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node build-panel-cache.mjs <control-plane.json>')
  process.exit(2)
}

const state = JSON.parse(readFileSync(file, 'utf8'))
const refs = state.coldHistory ?? {}
const rooms = {}
for (const [roomId, ref] of Object.entries(refs.rooms ?? {})) {
  const messages = readControlPlaneRoomHistory(file, ref)
  rooms[roomId] = messages.slice(-200)
}

const inbox = {}
for (const [messageId, digest] of Object.entries(refs.inbox ?? {})) {
  inbox[messageId] = readControlPlaneColdValue(file, digest)
}

const transcripts = {}
for (const [roomId, digest] of Object.entries(refs.transcripts ?? {})) {
  transcripts[roomId] = readControlPlaneColdValue(file, digest).slice(-200)
}

const output = file + '.panel-cache.json'
const temp = output + '.tmp-' + process.pid
writeFileSync(temp, JSON.stringify({
  version: 1,
  revision: Number(state.revision ?? 0),
  rooms,
  transcripts,
  inbox,
}), 'utf8')
renameSync(temp, output)
console.log(JSON.stringify({
  file: basename(output),
  rooms: Object.keys(rooms).length,
  roomMessages: Object.values(rooms).reduce((sum, rows) => sum + rows.length, 0),
  transcripts: Object.keys(transcripts).length,
  transcriptMessages: Object.values(transcripts).reduce((sum, rows) => sum + rows.length, 0),
  inbox: Object.keys(inbox).length,
}))
