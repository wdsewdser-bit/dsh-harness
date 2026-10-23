import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { readTeamJsonCached } from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'

test('team tool JSON cache reuses unchanged files and invalidates on content changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-tool-doc-cache-'))
  try {
    const path = join(root, 'milestones.json')
    writeFileSync(path, JSON.stringify({ version: 3, teams: { one: { members: { lead: { stage: 'a' } } } } }), 'utf8')
    const first = readTeamJsonCached(path)
    assert.equal(readTeamJsonCached(path), first)
    assert.equal(first.teams.one.members.lead.stage, 'a')

    writeFileSync(path, JSON.stringify({ version: 3, teams: { one: { members: { lead: { stage: 'b' } } } } }), 'utf8')
    const second = readTeamJsonCached(path)
    assert.notEqual(second, first)
    assert.equal(second.teams.one.members.lead.stage, 'b')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Team JSON cache observes changed or invalid content even when filesystem metadata collides', () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-tool-doc-cache-metadata-'))
  const path = join(root, 'milestones.json'), stat = fs.statSync
  try {
    writeFileSync(path, '{"stage":"a"}', 'utf8')
    const first = readTeamJsonCached(path), fixed = stat(path, { bigint: true })
    fs.statSync = (file, ...options) => file === path ? fixed : stat(file, ...options)
    syncBuiltinESMExports()
    writeFileSync(path, '{"stage":"b"}', 'utf8')
    const second = readTeamJsonCached(path)
    assert.notEqual(second, first)
    assert.equal(second.stage, 'b')
    writeFileSync(path, '{"stage":!}', 'utf8')
    assert.throws(() => readTeamJsonCached(path), SyntaxError)
    writeFileSync(path, '{"stage":"b"}', 'utf8')
    assert.equal(readTeamJsonCached(path), second)
  } finally {
    fs.statSync = stat
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})
