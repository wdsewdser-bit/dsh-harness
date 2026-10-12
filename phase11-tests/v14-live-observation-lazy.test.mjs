import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import {
  createTailBackedEvents,
  createLazyLiveEvents,
  createLiveObservationLazy,
  inject as runtimeGuardInject,
} from '../home/profiles/web/plugins/team-runtime-guard.mjs'

function fakeSession(length) {
  const calls = { eventAt: 0, fullSnapshot: 0, rangeSnapshot: 0 }
  const session = {
    seq: length,
    eventAt(index) {
      calls.eventAt += 1
      return { seq: index, type: index % 2 === 0 ? 'user/message' : 'assistant/message' }
    },
    snapshotEvents(from = 0, to = length) {
      if (from === 0 && to === length) calls.fullSnapshot += 1
      else calls.rangeSnapshot += 1
      return Array.from({ length: Math.max(0, to - from) }, (_, offset) => session.eventAt(from + offset))
    },
  }
  return { session, calls }
}

test('runtime guard declares the sessions service used by live history reads', () => {
  assert.equal(runtimeGuardInject.includes('sessions'), true)
})

test('lazy live events preserve page operations without a full snapshot', () => {
  const length = 100_000
  const { session, calls } = fakeSession(length)
  const events = createLazyLiveEvents(session, length - 1)

  assert.equal(Array.isArray(events), true)
  assert.equal(events.length, length)
  assert.equal(events.at(-1).seq, length - 1)
  assert.equal(events.at(-length - 1), undefined)
  assert.equal(events[length - 2].seq, length - 2)
  assert.equal(events[length], undefined)

  for (let index = length - 1; index >= length - 3; index -= 1) {
    assert.equal(events[index].seq, index)
  }
  const page = events.slice(length - 3, length)
  assert.equal(page.length, 3)
  assert.equal(page[0].seq, length - 3)
  assert.equal(calls.fullSnapshot, 0)
  assert.equal(calls.rangeSnapshot, 1)
  assert.ok(calls.eventAt < 20)
})

test('explicit array methods materialize once and preserve dense results', () => {
  const { session, calls } = fakeSession(6)
  const events = createLazyLiveEvents(session, session.seq - 1)

  assert.deepEqual(events.map((event) => event.seq), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(events.filter((event) => event.seq % 2 === 0).map((event) => event.seq), [0, 2, 4])
  assert.equal(events.reduce((total, event) => total + event.seq, 0), 15)
  assert.equal(events.join(','), Array.from({ length: 6 }, () => '[object Object]').join(','))
  assert.equal(calls.fullSnapshot, 1)
})

test('live observation bridge is idempotent, retains laziness, and restores the service', async () => {
  const { session, calls } = fakeSession(500)
  const originalObservation = {
    source: 'live',
    cursor: session.seq - 1,
    events: [{ seq: 'eager' }],
    retain() {
      return { ...this, retain: this.retain }
    },
    [Symbol.dispose]() {},
  }
  const service = {
    async observeSession() {
      return originalObservation
    },
  }
  const original = service.observeSession
  const ctx = { sessions: { get: () => session } }
  const bridge = createLiveObservationLazy(service, ctx)
  try {
    const observation = await service.observeSession('session-live')
    assert.equal(observation.source, 'live')
    assert.equal(Array.isArray(observation.events), true)
    assert.equal(observation.events.at(-1).seq, 499)
    assert.equal(calls.fullSnapshot, 0)

    const retained = observation.retain()
    assert.equal(Array.isArray(retained.events), true)
    assert.equal(retained.events[498].seq, 498)
    retained[Symbol.dispose]()

    const second = createLiveObservationLazy(service, ctx)
    assert.equal(second.installed, true)
    assert.notEqual(service.observeSession, original)
    second.dispose()
    assert.equal(service.observeSession, original)
  } finally {
    bridge.dispose()
    assert.equal(service.observeSession, original)
  }
})

test('prepared observations pass through unchanged', async () => {
  const prepared = { source: 'prepared', events: Object.freeze([{ seq: 0 }]) }
  const service = { async observeSession() { return prepared } }
  const bridge = createLiveObservationLazy(service, { sessions: { get: () => undefined } })
  try {
    assert.strictEqual(await service.observeSession('cold'), prepared)
  } finally {
    bridge.dispose()
  }
})

function writeTailFixture() {
  const root = mkdtempSync(join(tmpdir(), 'v14-cold-tail-'))
  const path = join(root, 'session.v4.jsonl.zstd')
  const frame = (value) => zstdCompressSync(Buffer.from(JSON.stringify(value) + '\n'))
  const frames = [
    frame({ type: 'session', version: 4, id: 'session-tail' }),
    frame({ seq: 0, type: 'user/message' }),
    frame({ seq: 1, type: 'assistant/message' }),
    frame({ seq: 2, type: 'user/message' }),
  ]
  writeFileSync(path, Buffer.concat(frames))
  return { root, path }
}

test('tail-backed cold events preserve page operations without full replay', () => {
  const { root, path } = writeTailFixture()
  try {
    const events = createTailBackedEvents(path)
    assert.equal(Array.isArray(events), true)
    assert.equal(events.length, 3)
    assert.equal(events.at(-1).seq, 2)
    assert.equal(events[1].seq, 1)
    assert.equal(events[3], undefined)
    assert.deepEqual(events.slice(1, 3).map((event) => event.seq), [1, 2])
    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cold observation bridge uses the tail reader for projection-none reads', async () => {
  const { root, path } = writeTailFixture()
  const originalObservation = { source: 'prepared', events: [{ seq: 'eager' }] }
  let originalCalls = 0
  const service = {
    async observeSession() {
      originalCalls += 1
      return originalObservation
    },
  }
  const persistence = {
    async findLog() {
      return { sourcePath: path, currentPath: path, sourceVersion: 4 }
    },
    async readGenerationHeader() {
      return { id: 'session-tail', version: 4, isSeeded: false }
    },
  }
  const ctx = {
    sessions: { get: () => undefined },
    get: (name) => name === 'sessionPersistence' ? persistence : undefined,
  }
  const bridge = createLiveObservationLazy(service, ctx)
  try {
    const observation = await service.observeSession('session-tail', { projectionMode: 'none' })
    assert.equal(observation.source, 'prepared')
    assert.equal(observation.events.at(-1).seq, 2)
    assert.equal(originalCalls, 0)
  } finally {
    bridge.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
