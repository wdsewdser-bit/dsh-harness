import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { rpc } from './usage-runtime-rpc.mjs'

const home = 'D:/dsh-test/home'
const audit = 'D:/dsh-test/docs/usage-audit-20261001'
const require = createRequire('D:/dsh-test/app/node_modules/@deepseek-ai/dsh/package.json')
const yaml = require('yaml')
const parseYaml = text => yaml.parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parseLines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const profiles = []
for (const profile of ['web', 'headless', 'desktop', 'teamtest']) {
  const directory = home + '/profiles/' + profile
  const bytes = await readFile(directory + '/plugins/request-usage-ledger.mjs')
  const current = parseYaml(await readFile(directory + '/cordis.patch.yml', 'utf8'))
  const previous = parseYaml(await readFile('D:/dsh-backups/usage-ledger-20261001/' + profile + '-cordis.patch.yml', 'utf8'))
  const mounts = current.flatMap(row => row.insert ?? []).filter(row => row.id === 'request-usage-ledger')
  const withoutLedger = current.map(row => row.insert
    ? { ...row, insert: row.insert.filter(item => item.id !== 'request-usage-ledger') } : row)
    .filter(row => !row.insert || row.insert.length)
  if (mounts.length !== 1 || JSON.stringify(withoutLedger) !== JSON.stringify(previous)) {
    throw new Error('Unexpected profile change: ' + profile)
  }
  profiles.push({ profile, realDirectory: await realpath(directory), moduleHash: hash(bytes), mount: mounts[0] })
}
if (new Set(profiles.map(row => row.moduleHash)).size !== 1) throw new Error('Plugin parity mismatch')

const records = []
const runtime = []
for (const file of await readdir(home + '/usage-ledger')) {
  if (file.startsWith('requests-') && file.endsWith('.jsonl')) {
    records.push(...parseLines(await readFile(home + '/usage-ledger/' + file, 'utf8')))
  } else if (file.startsWith('runtime-status-') && file.endsWith('.jsonl')) {
    runtime.push(...parseLines(await readFile(home + '/usage-ledger/' + file, 'utf8')))
  }
}
const terminal = records.filter(row => row.event === 'terminal')
if (new Set(terminal.map(row => row.requestId)).size !== terminal.length) throw new Error('Duplicate terminal request')
const summarize = rows => {
  const categories = {}
  for (const row of rows) {
    for (const [name, item] of Object.entries(row.payload?.categories ?? {})) {
      const sum = categories[name] ??= { bytes: 0, utf16Units: 0, items: 0 }
      sum.bytes += item.bytes
      sum.utf16Units += item.utf16Units
      sum.items += item.items
    }
  }
  const measuredBytes = Object.values(categories).reduce((sum, item) => sum + item.bytes, 0)
  for (const item of Object.values(categories)) item.byteSharePercent = measuredBytes ? item.bytes / measuredBytes * 100 : null
  return {
    requests: rows.length, knownTotal: rows.reduce((sum, row) => sum + (row.usage?.totalTokens ?? 0), 0),
    missingTotal: rows.filter(row => row.usage?.totalTokens == null).length,
    statuses: rows.reduce((result, row) => { result[row.status] = (result[row.status] ?? 0) + 1; return result }, {}),
    categories, measuredBytes,
    limitation: 'Content byte shares, not provider-token or monetary attribution. Count terminal events only.',
  }
}
const namespaces = await rpc('settings/describe')
const settings = namespaces.namespaces ?? namespaces
const reducer = settings.find(row => row.ns === 'evidence-reducer')
const provider = settings.find(row => row.ns === 'llm-pi-ai')?.value?.providers?.opencodego
const historicalPath = audit + '/history-2026-09-30T19-40-10-849Z-report.json'
const historicalBytes = await readFile(historicalPath)
const history = JSON.parse(historicalBytes)
const groups = new Map()
for (const row of history.summary.groups) {
  const group = groups.get(row.rootTeam) ?? { rootTeam: row.rootTeam, workspace: row.workspace, requests: 0, knownTotal: 0, missingTotal: 0 }
  group.requests += row.requests
  group.knownTotal += row.usage.total.observedSum ?? 0
  group.missingTotal += row.usage.total.missingRequests
  groups.set(row.rootTeam, group)
}
const report = {
  at: new Date().toISOString(), profiles, runtime,
  history: { path: historicalPath, sha256: hash(historicalBytes), requests: history.summary.own.requests,
    usage: history.summary.own.usage, rootTeams: [...groups.values()].sort((a, b) => b.knownTotal - a.knownTotal) },
  live: { starts: records.filter(row => row.event === 'start').length, terminals: terminal.length,
    root: summarize(terminal.filter(row => row.rootTeamId === 'session-028e6f5b-1716-4c23-a232-af16d853d191')),
    probe: summarize(terminal.filter(row => row.sessionId === 'session-58d081fd-d2c0-46b7-b810-6c8f14289eeb')),
    receipts: terminal.map(row => ({ requestId: row.requestId, sessionId: row.sessionId, rootTeamId: row.rootTeamId,
      status: row.status, usage: row.usage, provider: row.provider, model: row.model,
      endpoint: row.endpoint, protocol: row.protocol, startedAt: row.startedAt, endedAt: row.endedAt })) },
  settings: { reducer: reducer ? { revision: reducer.revision, enabled: reducer.value?.enabled,
    routeMode: reducer.value?.routeMode, remoteAllowed: reducer.value?.remoteAllowed, localProviders: reducer.value?.localProviders } : null,
    opencodego: { api: provider?.api ?? null, baseURL: provider?.baseURL ?? null } },
  boundaries: { rawBodies: false, secrets: false, originalSessionsModified: false, productionReducerActivated: false },
}
const output = audit + '/live-verification.json'
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ output, sha256: hash(await readFile(output)), profiles: profiles.map(row => ({ profile: row.profile, moduleHash: row.moduleHash })),
  rootTeams: report.history.rootTeams.slice(0, 2), liveRoot: report.live.root, probe: report.live.probe, settings: report.settings }))
