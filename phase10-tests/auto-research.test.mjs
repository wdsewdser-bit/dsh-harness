import test from 'node:test'
import assert from 'node:assert/strict'
import { runReplay } from '../home/profiles/web/plugins/team-v12-replay.mjs'
import { paretoFrontier, runAutoResearch } from '../home/profiles/web/plugins/team-v13-auto-research.mjs'

const fixture = {
  fixtureId: 'auto-research-test',
  initialState: { accepted: 0, rejected: 0 },
  events: [{ type: 'accept' }, { type: 'accept' }],
  postconditions: [
    { kind: 'equals', path: 'accepted', expected: 2 },
    { kind: 'equals', path: 'rejected', expected: 0 },
  ],
}

const keep = ({ state, event }) => ({
  ...state,
  accepted: Number(state.accepted ?? 0) + (event.type === 'accept' ? 1 : 0),
})
const reject = ({ state }) => ({ ...state, rejected: Number(state.rejected ?? 0) + 1 })

test('the capability floor rejects a cheaper candidate that breaks the fixture', async () => {
  const report = await runAutoResearch({
    fixtures: [fixture],
    runReplay,
    candidates: [
      { id: 'safe', reducer: keep, estimatedSavingsTokens: 1000, overheadTokens: 100 },
      { id: 'cheap-but-wrong', reducer: reject, estimatedSavingsTokens: 5000, overheadTokens: 100 },
    ],
    now: () => 0,
  })
  assert.deepEqual(report.survivors.map((row) => row.id), ['safe'])
  assert.equal(report.rejected[0].id, 'cheap-but-wrong')
  assert.equal(report.rejected[0].capabilityPass, false)
  assert.equal(report.applied, false)
})

test('the Pareto frontier keeps a capability winner beside a higher-scoring peer', () => {
  const frontier = paretoFrontier([
    { id: 'capability', capabilityPass: true, score: 10 },
    { id: 'score', capabilityPass: false, score: 100 },
    { id: 'dominated', capabilityPass: false, score: 50 },
  ])
  assert.deepEqual(frontier.map((row) => row.id).sort(), ['capability', 'score'])
})

test('the research report exposes all four real fault categories', async () => {
  const bounded = ({ state, event }) => {
    const next = { ...state }
    if (event.type === 'wake') {
      if (Number(next.wakeDispatches ?? 0) < 3) next.wakeDispatches = Number(next.wakeDispatches ?? 0) + 1
      else next.wakeDropped = Number(next.wakeDropped ?? 0) + 1
    } else if (event.type === 'boundary') {
      if (Number(next.compactions ?? 0) < 1) next.compactions = 1
      else next.deferred = Number(next.deferred ?? 0) + 1
    } else if (event.type === 'test-fail') {
      if (Number(next.testRuns ?? 0) < 2) next.testRuns = Number(next.testRuns ?? 0) + 1
      else next.blockedRetries = Number(next.blockedRetries ?? 0) + 1
    } else if (event.type === 'log') {
      const bytes = Number(event.data?.bytes ?? 0)
      if (Number(next.storedBytes ?? 0) < 100) next.storedBytes = Math.min(100, Number(next.storedBytes ?? 0) + bytes)
      else next.archivedBytes = Number(next.archivedBytes ?? 0) + bytes
    }
    return next
  }
  const fixtures = [
    {
      fixtureId: 'wake',
      category: 'wake-storm',
      initialState: { wakeDispatches: 0, wakeDropped: 0 },
      events: Array.from({ length: 6 }, () => ({ type: 'wake' })),
      postconditions: [
        { kind: 'equals', path: 'wakeDispatches', expected: 3 },
        { kind: 'equals', path: 'wakeDropped', expected: 3 },
      ],
    },
    {
      fixtureId: 'compact',
      category: 'compaction-trigger',
      initialState: { compactions: 0, deferred: 0 },
      events: Array.from({ length: 5 }, () => ({ type: 'boundary' })),
      postconditions: [
        { kind: 'equals', path: 'compactions', expected: 1 },
        { kind: 'equals', path: 'deferred', expected: 4 },
      ],
    },
    {
      fixtureId: 'retry',
      category: 'repeated-tests',
      initialState: { testRuns: 0, blockedRetries: 0 },
      events: Array.from({ length: 5 }, () => ({ type: 'test-fail' })),
      postconditions: [
        { kind: 'equals', path: 'testRuns', expected: 2 },
        { kind: 'equals', path: 'blockedRetries', expected: 3 },
      ],
    },
    {
      fixtureId: 'logs',
      category: 'log-bloat',
      initialState: { storedBytes: 0, archivedBytes: 0 },
      events: Array.from({ length: 5 }, () => ({ type: 'log', data: { bytes: 40 } })),
      postconditions: [
        { kind: 'equals', path: 'storedBytes', expected: 100 },
        { kind: 'equals', path: 'archivedBytes', expected: 80 },
      ],
    },
  ]
  const report = await runAutoResearch({
    fixtures,
    runReplay,
    candidates: [{ id: 'bounded', reducer: bounded, estimatedSavingsTokens: 100, overheadTokens: 10 }],
    now: () => 0,
  })
  assert.deepEqual(report.categories, [
    'compaction-trigger',
    'log-bloat',
    'repeated-tests',
    'wake-storm',
  ])
  assert.deepEqual(report.survivors.map((row) => row.id), ['bounded'])
})
