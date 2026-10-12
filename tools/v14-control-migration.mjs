#!/usr/bin/env node
/**
 * v14 control-plane migration helper. Default mode is dry-run. Apply creates
 * a sibling backup and writes the split hot/history representation atomically;
 * rollback restores that backup without deleting the original until the new
 * files have been validated.
 */
import { existsSync, readFileSync, copyFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { argv, exit } from 'node:process'
import { controlPlaneFile, persistControlPlaneSnapshot, readControlPlaneSnapshot } from '../home/profiles/web/plugins/team-control-plane.mjs'

function arg(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
function inspect(file) {
  if (!existsSync(file)) throw new Error('missing control-plane file: ' + file)
  const parsed = readControlPlaneSnapshot(file)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid control-plane document')
  return { parsed, bytes: Buffer.byteLength(JSON.stringify(parsed)), rooms: Object.keys(parsed.rooms ?? {}).length }
}
const root = arg('--root', process.env.DSH_HOME || process.cwd())
const team = arg('--team', 'default')
const mode = arg('--mode', 'dry-run')
const file = resolve(arg('--file', controlPlaneFile(team, { home: root })))
try {
  const backup = file + '.v14-backup'
  if (mode === 'rollback') {
    if (!existsSync(backup + '.json')) throw new Error('no migration backup found: ' + backup + '.json')
    copyFileSync(backup + '.json', file)
    const original = JSON.parse(readFileSync(file, 'utf8'))
    const oldSidecar = file + '.history-' + String(Number(original.revision || 0)) + '.json'
    if (existsSync(backup + '.history.json')) copyFileSync(backup + '.history.json', oldSidecar)
    readControlPlaneSnapshot(file)
    console.log(JSON.stringify({ mode, file, restored: true }, null, 2))
    exit(0)
  }
  const result = inspect(file)
  const original = readFileSync(file, 'utf8')
  const oldSidecar = file + '.history-' + String(Number(result.parsed.revision || 0)) + '.json'
  if (mode === 'apply') {
    if (existsSync(backup + '.json')) throw new Error('migration backup already exists: ' + backup + '.json')
    copyFileSync(file, backup + '.json')
    if (existsSync(oldSidecar)) copyFileSync(oldSidecar, backup + '.history.json')
    try {
      persistControlPlaneSnapshot(file, result.parsed)
      const roundtrip = readControlPlaneSnapshot(file)
      if (JSON.stringify(roundtrip.rooms) !== JSON.stringify(result.parsed.rooms)
        || JSON.stringify(roundtrip.v12Events ?? []) !== JSON.stringify(result.parsed.v12Events ?? [])
        || JSON.stringify(roundtrip.v12RoomWake?.events ?? []) !== JSON.stringify(result.parsed.v12RoomWake?.events ?? [])
        || JSON.stringify(roundtrip.v12RoomWake?.transcripts ?? {}) !== JSON.stringify(result.parsed.v12RoomWake?.transcripts ?? {})
        || JSON.stringify(roundtrip.v12RoomWake?.inbox ?? {}) !== JSON.stringify(result.parsed.v12RoomWake?.inbox ?? {})) {
        throw new Error('control-plane archive validation failed')
      }
    } catch (error) {
      const restoreTemp = file + '.restore.tmp'
      writeFileSync(restoreTemp, original, 'utf8')
      renameSync(restoreTemp, file)
      throw new Error('migration failed; original hot snapshot restored: ' + String(error?.message ?? error))
    }
  }
  console.log(JSON.stringify({ mode, file, bytesBefore: result.bytes, rooms: result.rooms, coldBlobCount: mode === 'apply' ? Object.keys(readControlPlaneSnapshot(file).coldHistory?.rooms ?? {}).length + 2 : null, backup: mode === 'apply' ? backup : null }, null, 2))
} catch (error) {
  console.error(String(error?.stack ?? error))
  exit(1)
}
