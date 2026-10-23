import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDurableJson, updateDurableJsonSync } from '../home/profiles/web/plugins/team-v14-durable-store.mjs'

test('default updates keep revision writes while skipUnchanged preserves return contracts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-skip-unchanged-'))
  try {
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ revision: 0, count: 3 }), 'utf8')

    assert.equal(updateDurableJsonSync(file, doc => { doc.count = 3; return { observed: doc.count } }).observed, 3)
    assert.equal(readDurableJson(file).revision, 1, 'default updates still write a semantic no-op')
    assert.equal(updateDurableJsonSync(file, doc => { doc.count = 3 }).revision, 2)
    const unchangedBytes = readFileSync(file)

    assert.deepEqual(updateDurableJsonSync(file, doc => ({ observed: doc.count }), { skipUnchanged: true }), { observed: 3 })
    assert.deepEqual(updateDurableJsonSync(file, doc => undefined, { skipUnchanged: true }), readDurableJson(file))
    assert.equal(readDurableJson(file).revision, 2)
    assert.deepEqual(readFileSync(file), unchangedBytes, 'unchanged updates must not replace the file')

    assert.deepEqual(updateDurableJsonSync(file, doc => { doc.count += 1; return { next: doc.count } }, { skipUnchanged: true }), { next: 4 })
    assert.equal(readDurableJson(file).revision, 3)
    assert.equal(readDurableJson(file).count, 4)

    assert.equal(updateDurableJsonSync(file, doc => doc.count), 4)
    assert.equal(readDurableJson(file).revision, 4, 'default mode remains write-on-every-call after skip mode')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skipUnchanged exceptions do not write and the acquired lock is released', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-skip-error-'))
  try {
    const file = join(dir, 'state.json')
    writeFileSync(file, JSON.stringify({ revision: 4, count: 9 }), 'utf8')
    const before = readFileSync(file)
    assert.throws(() => updateDurableJsonSync(file, () => { throw new Error('updater failed') }, { skipUnchanged: true }), /updater failed/)
    assert.deepEqual(readFileSync(file), before)
    assert.equal(existsSync(file + '.lock'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skipUnchanged checks lock ownership before returning without a write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v14-skip-lock-owner-'))
  try {
    const file = join(dir, 'state.json')
    const lock = file + '.lock'
    writeFileSync(file, JSON.stringify({ revision: 2, count: 1 }), 'utf8')
    const before = readFileSync(file)
    assert.throws(() => updateDurableJsonSync(file, doc => {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }), 'utf8')
      return { observed: doc.count }
    }, { skipUnchanged: true }), /ownership changed/)
    assert.deepEqual(readFileSync(file), before)
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, 'replacement-owner')
    unlinkSync(lock)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
