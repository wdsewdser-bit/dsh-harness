import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2] ?? 'D:/dsh-test/home/team-control-plane'
const limit = Number(process.argv[3] ?? 1000)

const files = fs
  .readdirSync(root)
  .filter((name) => name.endsWith('.audit.jsonl'))
  .map((name) => path.join(root, name))

const events = []
const typeCounts = new Map()
const statusCounts = new Map()

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = String(event.type ?? '')
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
    const status = String(event.data?.status ?? '')
    if (status.length > 0) {
      const key = `${type}:${status}`
      statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1)
    }
    if (typeof event.at === 'number') events.push(event)
  }
}

events.sort((a, b) => a.at - b.at)

const claimed = new Map()
const paired = []
const pairedByStatus = new Map()
for (const event of events) {
  const episodeId = event.data?.episodeId
  if (typeof episodeId !== 'string') continue
  if (event.type === 'wake/claimed') {
    claimed.set(episodeId, event)
  } else if (
    event.type === 'wake/acknowledged' &&
    ['delivered', 'turn-started', 'delivery-failed'].includes(event.data?.status)
  ) {
    const start = claimed.get(episodeId)
    if (start !== undefined) {
      const row = {
        episodeId,
        sender: start.data?.sender,
        target: start.data?.target,
        status: event.data.status,
        claimedAt: start.at,
        acknowledgedAt: event.at,
        latencyMs: event.at - start.at,
      }
      paired.push(row)
      const values = pairedByStatus.get(row.status) ?? []
      values.push(row)
      pairedByStatus.set(row.status, values)
    }
  }
}

paired.sort((a, b) => a.claimedAt - b.claimedAt)

const percentile = (values, ratio) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index]
}

const summarize = (values) => {
  if (values.length === 0) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Math.max(...values),
    mean: Math.round(total / values.length),
  }
}

const byTarget = new Map()
const delivered = paired.filter((item) => item.status === 'delivered')
const turnStarted = paired.filter((item) => item.status === 'turn-started')
const recent = turnStarted.slice(-limit)
for (const item of delivered.slice(-limit)) {
  const values = byTarget.get(item.target) ?? []
  values.push(item.latencyMs)
  byTarget.set(item.target, values)
}

const slowest = [...delivered.slice(-limit)]
  .sort((a, b) => b.latencyMs - a.latencyMs)
  .slice(0, 20)

const status = [...statusCounts]
  .sort((a, b) => b[1] - a[1])
  .map(([key, count]) => ({ key, count }))

const types = [...typeCounts]
  .sort((a, b) => b[1] - a[1])
  .map(([key, count]) => ({ key, count }))

console.log(
  JSON.stringify(
    {
      root,
      files: files.length,
      events: events.length,
      paired: paired.length,
      latencyByStatus: Object.fromEntries(
        [...pairedByStatus].map(([key, rows]) => [
          key,
          summarize(rows.slice(-limit).map((item) => item.latencyMs)),
        ]),
      ),
      limit,
      latency: summarize(recent.map((item) => item.latencyMs)),
      byTarget: [...byTarget]
        .map(([target, values]) => ({ target, ...summarize(values) }))
        .sort((a, b) => (b.p90 ?? 0) - (a.p90 ?? 0)),
      slowest,
      status,
      types,
    },
    null,
    2,
  ),
)
