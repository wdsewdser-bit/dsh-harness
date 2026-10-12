/**
 * Emit the v13 mechanism cost report from runtime telemetry.
 *
 * Usage:
 *   node tools/v13-cost-report.mjs --json
 *   node tools/v13-cost-report.mjs --before before.json --after after.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildCostAttributionReport } from '../home/profiles/web/plugins/team-v13-cost-attribution.mjs'
import { readTelemetry } from '../home/profiles/web/plugins/team-v13-mechanism-telemetry.mjs'

const DEFAULTS = {
  telemetryDir: 'D:/dsh-test/home/team-control-plane',
  output: 'D:/dsh-test/home/team-control-plane/v13-cost-report.json',
  before: undefined,
  after: undefined,
  sourceHash: undefined,
  config: undefined,
  model: undefined,
  fixtureVersion: undefined,
  json: false,
}

function parseArgs(argv) {
  const options = { ...DEFAULTS }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    const match = /^--([A-Za-z][A-Za-z0-9]*)(?:=(.*))?$/.exec(arg)
    if (match === null) continue
    const value = match[2] ?? argv[++index]
    if (value === undefined) continue
    if (match[1] === 'telemetryDir') options.telemetryDir = value
    else if (match[1] === 'output') options.output = value
    else if (match[1] === 'before') options.before = value
    else if (match[1] === 'after') options.after = value
    else if (match[1] === 'sourceHash') options.sourceHash = value
    else if (match[1] === 'config') options.config = value
    else if (match[1] === 'model') options.model = value
    else if (match[1] === 'fixtureVersion') options.fixtureVersion = value
  }
  return options
}

function readJson(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const options = parseArgs(process.argv.slice(2))
const report = buildCostAttributionReport({
  telemetryRows: readTelemetry(options.telemetryDir),
  before: readJson(options.before),
  after: readJson(options.after),
  sourceHash: options.sourceHash,
  config: options.config,
  model: options.model,
  fixtureVersion: options.fixtureVersion,
})
mkdirSync(dirname(options.output), { recursive: true })
writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', 'utf8')
if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
else console.log(JSON.stringify({ mechanisms: report.mechanisms.length, comparison: report.comparison?.verdict ?? null, output: options.output }, null, 2))
