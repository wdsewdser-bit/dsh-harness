import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AnonymousEntries, ScopedLayers } from '../app/node_modules/@deepseek-ai/dsh-scope/lib/index.js'
import { JobEventHub, JobJournal } from '../app/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js'
import { compactRuntimeFacts } from '../home/profiles/web/plugins/team-v12-runtime.mjs'

test('runtime_facts compact mode keeps signal rows and omits unobserved-entry noise', () => {
  const report = {
    schemaVersion: 1,
    kind: 'dsh.runtime-facts',
    collectedAt: '2026-09-29T00:00:00.000Z',
    instance: null,
    dsh: { version: 'test', profile: 'web' },
    collection: { complete: false, degraded: true, reasons: ['runtime observation was not supplied'] },
    plugins: {
      noise: {
        runtime: {
          id: 'noise',
          entry: {
            path: null,
            sha256: null,
            error: 'entry path was not observed',
          },
        },
      },
      signal: {
        runtime: {
          id: 'signal',
          entry: {
            path: null,
            sha256: null,
            error: 'entry path was not observed',
          },
        },
      },
      healthy: {
        runtime: {
          id: 'healthy',
          entry: {
            path: 'D:/plugins/healthy.mjs',
            sha256: 'a'.repeat(64),
            error: null,
          },
        },
      },
    },
    differences: [
      { pluginId: 'noise', code: 'entry-path-mismatch', severity: 'error' },
      { pluginId: 'noise', code: 'entry-hash-mismatch', severity: 'error' },
      { pluginId: 'signal', code: 'configured-but-not-loaded', severity: 'error' },
    ],
    diffSummary: { total: 3, errors: 3, warnings: 0, codes: ['configured-but-not-loaded', 'entry-hash-mismatch', 'entry-path-mismatch'] },
  }

  const compact = compactRuntimeFacts(report)
  assert.equal(compact.totalPlugins, 3)
  assert.equal(compact.includedPlugins, 1)
  assert.equal(compact.omittedPlugins, 2)
  assert.equal(compact.omittedUnobservedRuntimeEntries, 1)
  assert.deepEqual(Object.keys(compact.plugins), ['signal'])
  assert.equal(compact.diffSummary.total, 3)

  const explicitlySelected = compactRuntimeFacts(report, ['noise'])
  assert.deepEqual(Object.keys(explicitlySelected.plugins), ['noise'])
})

test('job journal preserves terminal status and marks a dead host running row orphaned', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-job-journal-'))
  try {
    const oldHost = new JobJournal({
      directory,
      processId: 111,
      processToken: 'old-host',
      isProcessAlive: () => true,
    })
    oldHost.recordStart({
      id: 'bash-1',
      kind: 'bash',
      label: 'orphaned probe',
      owner: { id: 'session-1' },
      status: 'running',
      startedAt: 1,
    })
    oldHost.recordStart({
      id: 'bash-2',
      kind: 'bash',
      label: 'completed probe',
      owner: { id: 'session-1' },
      status: 'running',
      startedAt: 2,
    })
    oldHost.recordSettlement({
      id: 'bash-2',
      kind: 'bash',
      label: 'completed probe',
      owner: { id: 'session-1' },
      status: 'completed',
      startedAt: 2,
      finishedAt: 3,
      detail: 'exit code: 0',
    })

    const liveHost = new JobJournal({
      directory,
      processId: 333,
      processToken: 'live-host',
      isProcessAlive: () => true,
    })
    liveHost.recordStart({
      id: 'bash-3',
      kind: 'bash',
      label: 'live host probe',
      owner: { id: 'session-1' },
      status: 'running',
      startedAt: 4,
    })

    const restarted = new JobJournal({
      directory,
      processId: 222,
      processToken: 'new-host',
      isProcessAlive: (pid) => pid !== 111,
    })
    const rows = Object.fromEntries([...restarted.recovered.values()].map((row) => [row.id, row]))

    assert.equal(rows['bash-1'].status, 'orphaned')
    assert.match(rows['bash-1'].detail, /host process 111 exited before terminal settlement/)
    assert.equal(rows['bash-2'].status, 'completed')
    assert.equal(rows['bash-2'].detail, 'exit code: 0')
    assert.equal(rows['bash-3'], undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('job journal treats a reused PID with a different process token as a dead host', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-job-journal-pid-reuse-'))
  try {
    const oldHost = new JobJournal({
      directory,
      processId: 777,
      processToken: 'old-process-instance',
      isProcessAlive: () => true,
    })
    oldHost.recordStart({
      id: 'bash-4',
      kind: 'bash',
      label: 'pid reuse probe',
      owner: { id: 'session-1' },
      status: 'running',
      startedAt: 10,
    })

    const restarted = new JobJournal({
      directory,
      processId: 777,
      processToken: 'new-process-instance',
      isProcessAlive: () => true,
    })
    const row = restarted.recovered.get('bash-4')

    assert.equal(row.status, 'orphaned')
    assert.match(row.detail, /host process 777 exited before terminal settlement/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('job event hub replays recovered rows to listeners attached after startup', () => {
  const layers = new ScopedLayers(() => {
    const controllers = new AnonymousEntries()
    const scoped = new AnonymousEntries()
    return {
      controllers,
      scoped,
      isEmpty: () => controllers.isEmpty() && scoped.isEmpty(),
    }
  }, () => {})
  const hub = new JobEventHub(layers, () => {}, () => undefined)
  const recovered = {
    type: 'recovered',
    job: {
      id: 'bash-5',
      kind: 'bash',
      label: 'recovered probe',
      owner: 'session-1',
      status: 'orphaned',
      detail: 'host process 777 exited before terminal settlement',
      startedAt: 10,
      finishedAt: 20,
      output: { total: 0, earliest: 0 },
    },
  }
  hub.queueRecovered(recovered)
  const events = []
  const ctx = {
    effect(generator) {
      const iterator = generator()
      iterator.next()
      return () => iterator.next()
    },
  }
  hub.subscribe(ctx, { owners: 'scope' }, (event) => events.push(event))

  assert.deepEqual(events, [recovered])
})
