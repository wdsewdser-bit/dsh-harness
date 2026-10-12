#!/usr/bin/env node
/**
 * v14 control-plane migration helper. Default mode is dry-run. Apply creates
 * a sibling backup and writes the split hot/history representation atomically;
 * rollback restores its hydrated content under CAS with a new revision.
 */
import { constants, existsSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
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
    if (!existsSync(backup + '.snapshot.json')) throw new Error('hydrated migration backup unavailable; refuse unguarded legacy restore')
    const original = JSON.parse(readFileSync(backup + '.snapshot.json', 'utf8'))
    const expectedRevision = readControlPlaneSnapshot(file).revision
    original.revision = expectedRevision + 1
    persistControlPlaneSnapshot(file, original, { expectedRevision })
    readControlPlaneSnapshot(file)
    console.log(JSON.stringify({ mode, file, restored: true }, null, 2))
    exit(0)
  }
  const result = inspect(file)
  const oldSidecar = file + '.history-' + String(Number(result.parsed.revision || 0)) + '.json'
  if (mode === 'apply') {
    if (existsSync(backup + '.json')) throw new Error('migration backup already exists: ' + backup + '.json')
    const expectedRevision = result.parsed.revision
    const publication = structuredClone(result.parsed)
    publication.revision = expectedRevision + 1
    try {
      persistControlPlaneSnapshot(file, publication, { expectedRevision, beforePublish() {
        // Called while the cooperative writer owns the same control lock.
        copyFileSync(file, backup + '.json', constants.COPYFILE_EXCL)
        writeFileSync(backup + '.snapshot.json', JSON.stringify(result.parsed), { flag: 'wx' })
        if (existsSync(oldSidecar)) copyFileSync(oldSidecar, backup + '.history.json', constants.COPYFILE_EXCL)
      } })
      const roundtrip = readControlPlaneSnapshot(file)
      if (JSON.stringify(roundtrip.rooms) !== JSON.stringify(result.parsed.rooms)
        || JSON.stringify(roundtrip.v12Events ?? []) !== JSON.stringify(result.parsed.v12Events ?? [])
        || JSON.stringify(roundtrip.v12RoomWake?.events ?? []) !== JSON.stringify(result.parsed.v12RoomWake?.events ?? [])
        || JSON.stringify(roundtrip.v12RoomWake?.transcripts ?? {}) !== JSON.stringify(result.parsed.v12RoomWake?.transcripts ?? {})
        || JSON.stringify(roundtrip.v12RoomWake?.inbox ?? {}) !== JSON.stringify(result.parsed.v12RoomWake?.inbox ?? {})) {
        throw new Error('control-plane archive validation failed')
      }
    } catch (error) {
      throw new Error('migration failed; inspect durable state before CAS rollback; no unguarded restore: ' + String(error?.message ?? error))
    }
  }
  console.log(JSON.stringify({ mode, file, bytesBefore: result.bytes, rooms: result.rooms, coldBlobCount: mode === 'apply' ? Object.keys(readControlPlaneSnapshot(file).coldHistory?.rooms ?? {}).length + 2 : null, backup: mode === 'apply' ? backup : null }, null, 2))
} catch (error) {
  console.error(String(error?.stack ?? error))
  exit(1)
}
