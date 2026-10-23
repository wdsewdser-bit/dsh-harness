import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { Context, getHostLifecycleGate } from '@deepseek-ai/cordis'
import * as tools from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'

async function fixture(t) {
  const ctx = new Context()
  await tick()
  const gate = getHostLifecycleGate(ctx)
  t.after(() => ctx.fiber.dispose())
  return { ctx, gate }
}

test('periodic tool installation waits for a foreign native host writer instead of throwing HOST_WRITER_BUSY', async t => {
  const { ctx, gate } = await fixture(t)
  let release, calls = 0
  const writer = gate.runAsync(() => new Promise(resolve => { release = resolve }))
  const install = () => gate.runSync(() => { calls++ })
  const sweep = tools.createToolInstallSweep?.(ctx, install)
    ?? { run() { install(); return Promise.resolve(true) }, dispose() {} }
  const outcome = Promise.resolve().then(() => sweep.run()).then(value => ({ value }), error => ({ error }))
  await tick()
  assert.equal(calls, 0)
  release(); await writer
  const settled = await outcome
  assert.equal(settled.error, undefined, String(settled.error))
  assert.equal(calls, 1)
  sweep.dispose()
})

test('periodic tool installation coalesces ticks queued behind one native writer', async t => {
  const { ctx, gate } = await fixture(t)
  let release, calls = 0
  const writer = gate.runAsync(() => new Promise(resolve => { release = resolve }))
  assert.equal(typeof tools.createToolInstallSweep, 'function')
  const sweep = tools.createToolInstallSweep(ctx, () => { calls++ })
  const first = sweep.run(), second = sweep.run()
  assert.equal(first, second)
  release(); await writer; await first
  assert.equal(calls, 1)
  sweep.dispose()
})

test('disposed tool sweep does not install after its queued writer becomes available', async t => {
  const { ctx, gate } = await fixture(t)
  let release, calls = 0
  const writer = gate.runAsync(() => new Promise(resolve => { release = resolve }))
  assert.equal(typeof tools.createToolInstallSweep, 'function')
  const sweep = tools.createToolInstallSweep(ctx, () => { calls++ })
  const pending = sweep.run()
  sweep.dispose(); release(); await writer
  assert.equal(await pending, false)
  assert.equal(await sweep.run(), false)
  assert.equal(calls, 0)
})

test('tool sweep propagates installation errors and permits a later actual retry', async t => {
  const { ctx } = await fixture(t)
  let calls = 0
  assert.equal(typeof tools.createToolInstallSweep, 'function')
  const sweep = tools.createToolInstallSweep(ctx, () => { if (++calls === 1) throw new Error('actual-install-failed') })
  await assert.rejects(sweep.run(), /actual-install-failed/)
  assert.equal(await sweep.run(), true)
  assert.equal(calls, 2)
  sweep.dispose()
})
