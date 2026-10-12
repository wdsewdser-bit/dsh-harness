/**
 * Run the bounded v13 auto-research loop against local replay fixtures.
 *
 * Usage:
 *   node tools/v13-auto-research.mjs --fixture D:/path/fixture.json --json
 *   node tools/v13-auto-research.mjs --fixture-dir D:/dsh-test/phase10-tests/fixtures
 *
 * The tool writes a report only. It never edits the active profile.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runReplay } from '../home/profiles/web/plugins/team-v12-replay.mjs'
import { runAutoResearch } from '../home/profiles/web/plugins/team-v13-auto-research.mjs'

const DEFAULTS = {
  fixtureDir: 'D:/dsh-test/phase10-tests/fixtures',
  output: 'D:/dsh-test/home/team-control-plane/v13-auto-research.json',
  maximumCandidates: 8,
  json: false,
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, fixture: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    const match = /^--([A-Za-z][A-Za-z0-9]*)(?:=(.*))?$/.exec(arg)
    if (match === null) continue
    const key = match[1]
    const value = match[2] ?? argv[++index]
    if (value === undefined) continue
    if (key === 'fixture') options.fixture = value
    else if (key === 'fixtureDir') options.fixtureDir = value
    else if (key === 'output') options.output = value
    else if (key === 'maximumCandidates') options.maximumCandidates = Number(value)
  }
  return options
}

function readFixture(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function findFixtures(options) {
  if (typeof options.fixture === 'string' && options.fixture.length > 0) {
    const fixture = readFixture(options.fixture)
    return fixture === undefined ? [] : [fixture]
  }
  const rows = []
  let entries
  try {
    entries = readdirSync(options.fixtureDir)
  } catch {
    return rows
  }
  for (const entry of entries) {
    const path = join(options.fixtureDir, entry)
    try {
      if (!statSync(path).isFile() || !entry.endsWith('.json')) continue
    } catch {
      continue
    }
    const fixture = readFixture(path)
    if (fixture !== undefined) rows.push(fixture)
  }
  return rows
}

function findEvidenceRefs(dir) {
  const refs = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return refs
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.startsWith('mechanism-telemetry-')) continue
    const path = join(dir, entry)
    try {
      if (!statSync(path).isFile()) continue
      const doc = JSON.parse(readFileSync(path, 'utf8'))
      const records = doc?.v12Evidence?.records
      if (records === null || typeof records !== 'object') continue
      for (const record of Object.values(records)) {
        if (record === null || typeof record !== 'object') continue
        refs.push({
          id: record.id ?? record.evidenceId ?? null,
          status: record.status ?? null,
          commitSha: record.commitSha ?? null,
          requirementId: record.requirementId ?? null,
          fixtureVersion: record.fixtureVersion ?? null,
        })
      }
    } catch {
      /* skip unreadable or non-control-plane JSON */
    }
  }
  return refs
}

/**
 * A deliberately small candidate family. Each candidate changes one replay
 * decision and declares its expected token delta; capability is still decided
 * by the fixture assertions, not by the estimate.
 */
function candidates() {
  const keep = ({ state, event }) => ({
    ...state,
    accepted: Number(state?.accepted ?? 0) + (event.type === 'accept' ? 1 : 0),
    rejected: Number(state?.rejected ?? 0),
  })
  const bounded = ({ state, event }) => {
    const next = { ...state }
    if (event.type === 'accept') {
      next.accepted = Number(next.accepted ?? 0) + 1
    } else if (event.type === 'wake') {
      if (Number(next.wakeDispatches ?? 0) < 3) next.wakeDispatches = Number(next.wakeDispatches ?? 0) + 1
      else next.wakeDropped = Number(next.wakeDropped ?? 0) + 1
    } else if (event.type === 'boundary') {
      if (Number(next.compactions ?? 0) < 1) next.compactions = 1
      else next.deferred = Number(next.deferred ?? 0) + 1
    } else if (event.type === 'test-fail') {
      if (Number(next.testRuns ?? 0) < 2) next.testRuns = Number(next.testRuns ?? 0) + 1
      else next.blockedRetries = Number(next.blockedRetries ?? 0) + 1
    } else if (event.type === 'log') {
      const bytes = Math.max(0, Number(event.data?.bytes ?? 0))
      if (Number(next.storedBytes ?? 0) < 100) next.storedBytes = Math.min(100, Number(next.storedBytes ?? 0) + bytes)
      else next.archivedBytes = Number(next.archivedBytes ?? 0) + bytes
    }
    return next
  }
  const reject = ({ state }) => ({ ...state, rejected: Number(state?.rejected ?? 0) + 1 })
  return [
    { id: 'baseline-keep', reducer: keep, estimatedSavingsTokens: 0, overheadTokens: 0 },
    { id: 'bounded-fault-policy', reducer: bounded, estimatedSavingsTokens: 5000, overheadTokens: 800 },
    { id: 'aggressive-reject', reducer: reject, estimatedSavingsTokens: 20000, overheadTokens: 800 },
  ]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const fixtures = findFixtures(options)
  const report = await runAutoResearch({
    fixtures,
    candidates: candidates(),
    evidenceRefs: findEvidenceRefs(dirname(options.output)),
    runReplay,
    maximumCandidates: options.maximumCandidates,
  })
  try {
    mkdirSync(dirname(options.output), { recursive: true })
    writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', 'utf8')
  } catch {
    /* The report is still returned on stdout when the optional file write fails. */
  }
  if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    console.log(JSON.stringify({
      fixtures: report.fixtureCount,
      categories: report.categories,
      candidates: report.candidateCount,
      survivors: report.survivors.map((row) => row.id),
      rejected: report.rejected.map((row) => row.id),
      evidenceRefs: report.evidenceRefs.length,
      applied: report.applied,
      output: options.output,
    }, null, 2))
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
