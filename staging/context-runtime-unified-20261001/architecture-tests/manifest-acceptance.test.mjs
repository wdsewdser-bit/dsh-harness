// The change manifests only prove that disk and record agree. These tests pin the two places where a
// change is accepted on purpose: rewriting a manifest hash, and carrying a native edit across an upgrade.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stage = fileURLToPath(new URL('..', import.meta.url))
const run = (...args) => spawnSync(process.execPath, args, { cwd: stage, encoding: 'utf8', windowsHide: true })
const manifests = () => ['native', 'plugin', 'tools'].map(kind => readFileSync(join(stage, kind + '-change-manifest.json'), 'utf8'))

test('stage-closeout refuses to write without a stated reason, before touching anything', () => {
  const before = manifests()
  for (const extra of [[], ['--reason=short']]) {
    const result = run('tools/stage-closeout.mjs', 'lab-runs/closeout-reason-probe', ...extra)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /REASON_REQUIRED/)
  }
  assert.deepEqual(manifests(), before)
})

test('native patch carriage matches the accepted baseline', () => {
  const result = run('tools/native-patch-audit.mjs', '--check')
  assert.equal(result.status, 0, 'upstream version or patch channel changed; re-examine the edits, then --write-baseline with a reason\n' + result.stdout + result.stderr)
})
