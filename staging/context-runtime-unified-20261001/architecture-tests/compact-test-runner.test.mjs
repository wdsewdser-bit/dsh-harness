import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import reporter from '../tools/compact-test-reporter.mjs'
import { discoverTests, stage } from '../tools/run-regression.mjs'

test('compact reporter takes only aggregate counters and retains actionable errors', async () => {
  const events = [
    { type: 'test:summary', data: { file: 'nested.mjs', success: false, counts: { tests: 9999 } } },
    { type: 'test:fail', data: { name: 'suite', details: { error: { failureType: 'subtestsFailed' } } } },
    { type: 'test:fail', data: { name: 'assertion', file: 'test.mjs', line: 3, details: { error: { cause: { message: 'x'.repeat(10000) } } } } },
    { type: 'test:fail', data: { name: 'fixture', details: { error: { message: JSON.stringify({ saved: { noise: 'x'.repeat(10000), error: { code: 'SOURCE_DRIFT', message: 'wrong source' } } }) + '\n\n1 !== 0' } } } },
    { type: 'test:summary', data: { success: false, counts: { tests: 2, failed: 1, passed: 1 }, duration_ms: 123 } },
  ]
  let output = ''
  for await (const part of reporter(events)) output += part
  const value = JSON.parse(output)
  assert.equal(value.counts.tests, 2)
  assert.equal(value.failures.length, 2)
  assert.equal(value.failures[0].line, 3)
  assert.ok(value.failures[0].message.length < 2100)
  assert.equal(value.failures[1].message, 'SOURCE_DRIFT: wrong source')
  assert.equal(value.success, false)
})

test('compact discovery includes the established suites and ignores output fixtures', () => {
  const root = mkdtempSync(join(stage, 'lab-runs/compact-discovery-'))
  for (const name of ['native-tests', 'architecture-tests', 'usage-tests', 'phase1-tests', 'phase11-tests', 'lab-runs']) {
    mkdirSync(join(root, name)); writeFileSync(join(root, name, 'case.test.mjs'), '')
  }
  assert.equal(discoverTests(root).length, 5)
})

test('actual runner retains noisy full logs, bounds stdout and propagates failing exit', { timeout: 30000 }, () => {
  const root = mkdtempSync(join(stage, 'lab-runs/compact-runner-'))
  const fixture = join(root, 'fixture.test.mjs')
  const invoke = () => spawnSync(process.execPath, [fileURLToPath(new URL('../tools/run-regression.mjs', import.meta.url)), '--files', fixture],
    { cwd: stage, env: { ...process.env, DSH_HOME: join(root, 'home') }, windowsHide: true, encoding: 'utf8', timeout: 12000, maxBuffer: 262144 })
  for (const fail of [false, true]) {
    writeFileSync(fixture, `import test from 'node:test';import assert from 'node:assert/strict';\nfor(let i=0;i<1200;i++)test('proof '+i,()=>{if(i===0){assert.equal(process.env.DSH_HOME,${JSON.stringify(join(root, 'home'))});console.log('NOISE_'+ 'x'.repeat(50000));assert.equal(${fail ? 'false' : 'true'},true)}});`)
    const result = invoke()
    assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr)
    assert.ok(result.stdout.length < 5000)
    assert.equal(result.stdout.includes('NOISE_'), false)
    const summaryPath = result.stdout.match(/^SUMMARY (.+)$/m)?.[1].trim()
    const fullPath = result.stdout.match(/^FULL (.+)$/m)?.[1].trim()
    assert.ok(summaryPath && fullPath)
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
    assert.equal(summary.complete, true)
    assert.equal(summary.counts.tests, 1200)
    assert.equal(summary.counts.failed, fail ? 1 : 0)
    assert.ok(readFileSync(fullPath, 'utf8').includes('NOISE_'))
  }
})

test('actual runner never hands the production home to a test process', { timeout: 30000 }, () => {
  const root = mkdtempSync(join(stage, 'lab-runs/compact-runner-'))
  const fixture = join(root, 'fixture.test.mjs'), production = join(stage, '../../home')
  writeFileSync(fixture, `import test from 'node:test';import assert from 'node:assert/strict';import { resolve } from 'node:path';
test('home',()=>{assert.ok(process.env.DSH_HOME);assert.notEqual(resolve(process.env.DSH_HOME).toLowerCase(),${JSON.stringify(production.toLowerCase())})});`)
  for (const home of [production, undefined]) {
    const env = { ...process.env }
    if (home) env.DSH_HOME = home; else delete env.DSH_HOME
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/run-regression.mjs', import.meta.url)), '--files', fixture],
      { cwd: stage, env, windowsHide: true, encoding: 'utf8', timeout: 12000, maxBuffer: 262144 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
})
