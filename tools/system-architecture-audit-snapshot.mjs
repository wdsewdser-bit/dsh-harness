import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const base = 'D:/dsh-test'
const directory = `${base}/docs/architecture-review-20261001`
const rootTeamId = 'session-028e6f5b-1716-4c23-a232-af16d853d191'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = []
const byRequest = new Map()
for (const name of (await readdir(`${base}/home/usage-ledger`)).filter(name => /^requests-16440-.+\.jsonl$/.test(name)).sort()) {
  const path = `${base}/home/usage-ledger/${name}`
  const info = await stat(path)
  if (info.size > 1024 * 1024) throw new Error('Snapshot file exceeds bounded read: ' + name)
  const bytes = await readFile(path)
  const lines = bytes.toString('utf8').split('\n').filter(Boolean)
  sources.push({ path, capturedBytes: bytes.length, sha256: hash(bytes), lines: lines.length,
    note: 'Append-only live source can grow after this snapshot' })
  for (let index = 0; index < lines.length; index++) {
    const row = JSON.parse(lines[index])
    if (row.event !== 'terminal' || row.rootTeamId !== rootTeamId || row.provider?.startsWith('mock-')) continue
    const receipt = { source: path, line: index + 1, requestId: row.requestId, sessionId: row.sessionId,
      rootTeamId: row.rootTeamId, status: row.status, startedAt: row.startedAt, endedAt: row.endedAt,
      provider: row.provider, model: row.model, usage: row.usage, payloadBytes: row.payload?.bytes,
      categories: Object.fromEntries(Object.entries(row.payload?.categories ?? {}).map(([key, value]) => [key, { bytes: value.bytes, items: value.items }])),
      transforms: row.requestProjection?.transforms ?? [] }
    byRequest.set(row.requestId, receipt)
  }
}
const receipts = [...byRequest.values()].sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
const aggregate = rows => {
  const usage = {}
  for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']) {
    const known = rows.filter(row => Number.isFinite(row.usage?.[field]))
    usage[field] = { observedSum: known.reduce((sum, row) => sum + row.usage[field], 0), knownRequests: known.length, missingRequests: rows.length - known.length }
  }
  return { requests: rows.length, sessions: [...new Set(rows.map(row => row.sessionId))],
    statuses: rows.reduce((sum, row) => { sum[row.status] = (sum[row.status] ?? 0) + 1; return sum }, {}), usage }
}
const projected = receipts.filter(row => row.status === 'success' && row.transforms.some(transform => transform.id.startsWith('ptc-sdk-retention:') && transform.status === 'applied'))
const latest = projected.at(-1)
const latestPayload = latest ? { requestId: latest.requestId, source: latest.source, line: latest.line,
  bytes: latest.payloadBytes, categories: Object.fromEntries(Object.entries(latest.categories).map(([key, value]) => [key, {
    ...value, byteSharePercent: latest.payloadBytes ? value.bytes / latest.payloadBytes * 100 : null,
  }])) } : null
const artifacts = []
for (const relative of ['docs/clm-ds41flash-dsh-followup-20260930.md', 'docs/context-opt-20261001/delivery-manifest.json',
  'docs/usage-audit-20261001/README.md', 'docs/token-usage-decomposition-20261001.md',
  'home/profiles/web/plugins/request-message-projection.mjs', 'home/profiles/web/plugins/ptc-sdk-retention.mjs',
  'home/profiles/web/plugins/observation-pack-v2.mjs', 'home/profiles/web/plugins/request-usage-ledger.mjs',
  'home/profiles/web/plugins/team-tools-v2-r10.mjs', 'home/profiles/web/plugins/team-activity-digest.mjs',
  'home/profiles/web/plugins/step-compaction-v4.mjs', 'home/profiles/web/plugins/team-v13-cache-monitor.mjs',
  'home/profiles/web/plugins/team-v12-context.mjs', 'home/profiles/web/plugins/team-v14-memory-anchor.mjs',
  'home/profiles/web/plugins/team-v14-durable-store.mjs']) {
  const path = `${base}/${relative}`
  const bytes = await readFile(path)
  artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes) })
}
const snapshot = { version: 1, capturedAt: new Date().toISOString(), rootTeamId, sources, artifacts,
  observedRootAndDescendants: aggregate(receipts), projectedSuccess: aggregate(projected),
  projectedAfterFirstColdRequest: aggregate(projected.slice(1)), latestPayload, receipts,
  boundaries: { readOnlyProduction: true, modelRequests: 0, profileChanges: 0, dshRestarts: 0 },
  limitations: ['Only currently observed ledger sessions, not full historical Team coverage',
    'inputTokens is uncached; cacheRead is separate; reasoning is not added to output',
    'Missing usage is unknown, never assumed zero', 'Category shares are bytes, not provider tokens or cost',
    'Observed adjacent requests are not matched counterfactual tasks', 'Provider prices and monetary savings unknown'] }
await mkdir(directory, { recursive: true })
const output = `${directory}/snapshot.json`
await writeFile(output, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ output, sha256: hash(await readFile(output)), capturedAt: snapshot.capturedAt,
  observed: snapshot.observedRootAndDescendants, projected: snapshot.projectedSuccess,
  afterFirstCold: snapshot.projectedAfterFirstColdRequest, latestPayload }))
