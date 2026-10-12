import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectProfileParity } from '../home/profiles/web/plugins/team-health.mjs'

test('profile parity fails closed when shared plugin hashes or exports drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-profile-parity-'))
  try {
    const dirs = ['desktop', 'web', 'headless'].map((profile) => join(root, profile, 'plugins'))
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'shared.mjs'), 'export const name = "shared"\nexport function run() {}\n', 'utf8')
    }
    const healthy = inspectProfileParity({
      profileDirs: dirs,
      sharedPluginFiles: ['shared.mjs'],
    }, dirs[1])
    assert.equal(healthy.status, 'healthy')
    assert.equal(healthy.rows[0].copies.every((row) => row.exists), true)

    writeFileSync(join(dirs[2], 'shared.mjs'), 'export const name = "shared"\n', 'utf8')
    const drifted = inspectProfileParity({
      profileDirs: dirs,
      sharedPluginFiles: ['shared.mjs'],
    }, dirs[1])
    assert.equal(drifted.status, 'disabled')
    assert.match(drifted.reasons.join(' '), /profile parity failed for shared\.mjs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
