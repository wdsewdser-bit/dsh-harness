// Shadow replay of the pure window-decision rule (team-v15-window-decision.mjs) over the production
// request-usage ledger.
//
// It streams every `requests-*.jsonl` ledger file line by line, keeps the terminal record of each main
// conversation request, and replays `decideWindowAction` at that point in time to answer: when, and for
// which reason, would this rule have folded the context - and how does that compare with the folds the
// ledger shows actually happened. Read-only analysis: it opens the ledger for reading only, touches no
// runtime state, starts no service and sends no request. Message bodies are never read nor printed; only
// numeric and identifier fields are used.
//
// Usage: node tools/window-decision-shadow.mjs [--ledger <dir>] [--out <dir>]

import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { decideWindowAction, WINDOW_DECISION_DEFAULTS } from '../home/profiles/web/plugins/team-v15-window-decision.mjs'

const DEFAULT_LEDGER_DIR = 'D:\\dsh-test\\home\\usage-ledger'
const DEFAULT_OUT_DIR = 'D:\\dsh-test\\output\\window-decision-shadow'

const WINDOW_TOKENS = 1048576
const MILESTONE_DONE = false
const SAFE_BOUNDARY = true
const FOLD_DROP_RATIO = 0.4
const FOLD_MIN_BEFORE = 30000
const MINUTE = 60000

const CONTEXT_BUCKETS = [
  { label: '<50k', max: 50000 }, { label: '50-100k', max: 100000 }, { label: '100-200k', max: 200000 },
  { label: '200-300k', max: 300000 }, { label: '300-500k', max: 500000 }, { label: '500-786k', max: 786432 },
  { label: '>=786k', max: Infinity },
]
const GAP_BUCKETS = [
  { label: '<1min', max: MINUTE }, { label: '1-5min', max: 5 * MINUTE }, { label: '5-15min', max: 15 * MINUTE },
  { label: '15-60min', max: 60 * MINUTE }, { label: '>60min', max: Infinity },
]

const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const mean = values => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
const round = (value, digits = 4) => value === null || value === undefined ? null : Number(value.toFixed(digits))

/** Nearest-rank quantile over an ascending array. */
const quantile = (sorted, q) => {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]
}
const bucketOf = (buckets, value) => buckets.find(bucket => value < bucket.max)
/** Ledger session ids are opaque; the first eight meaningful characters are enough to tell them apart. */
const sessionPrefix = id => id.replace(/^session-/, '').slice(0, 8)
const bucketRow = buckets => Object.fromEntries(buckets.map(bucket => [bucket.label, { requests: 0, sessions: new Set(), hitRatios: [], folds: 0 }]))

function parseArgs(argv) {
  const args = { ledger: DEFAULT_LEDGER_DIR, out: DEFAULT_OUT_DIR }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ledger' && argv[i + 1]) args.ledger = argv[++i]
    else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i]
  }
  return args
}

async function* readLines(path) {
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of reader) yield line
}

/** Terminal record of a main conversation request -> the shape the replay needs, or a skip reason. */
function extractMainRequest(record) {
  if (record.event !== 'terminal') return { skip: 'not-terminal' }
  if (record.purpose !== 'conversation') return { skip: 'not-conversation', purpose: record.purpose ?? '(missing)' }
  const sessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0 ? record.sessionId : null
  if (sessionId === null) return { skip: 'no-session-id' }
  const usage = record.usage ?? {}
  const inputTokens = numeric(usage.inputTokens)
  if (inputTokens === null) return { skip: 'no-input-tokens' }
  const cacheReadTokens = numeric(usage.cacheReadTokens)
  const cacheWriteTokens = numeric(usage.cacheWriteTokens)
  // Canonical DSH counters are disjoint (input + cacheRead + cacheWrite + output === totalTokens), so the
  // context the request carried is their sum, not inputTokens alone.
  const contextTokens = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (contextTokens <= 0) return { skip: 'zero-context-tokens' }
  const startedAt = Date.parse(record.startedAt)
  const endedAt = Date.parse(record.endedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return { skip: 'no-usable-timestamps' }
  if (endedAt < startedAt) return { skip: 'end-before-start' }
  return {
    request: {
      requestId: typeof record.requestId === 'string' ? record.requestId : null,
      sessionId, startedAt, endedAt, contextTokens,
      cacheReadTokens, hitRatio: cacheReadTokens === null ? null : cacheReadTokens / contextTokens,
      status: typeof record.status === 'string' ? record.status : '(missing)',
      usageSource: typeof record.usageSource === 'string' ? record.usageSource : '(missing)',
      model: typeof record.model === 'string' ? record.model : '(missing)',
      provider: typeof record.provider === 'string' ? record.provider : '(missing)',
    },
  }
}

async function loadLedger(dir) {
  const fileNames = (await readdir(dir)).filter(name => name.startsWith('requests-') && name.endsWith('.jsonl')).sort()
  const overview = { ledgerFiles: fileNames.length, ledgerBytes: 0, linesRead: 0, parseErrors: 0, terminalRecords: 0 }
  const skipped = {}
  const purposeSkips = {}
  const statusCounts = {}
  const skippedStatusCounts = {}
  const usageSourceCounts = {}
  const sessions = new Map()
  const seenRequestIds = new Set()
  let duplicateRequestIds = 0
  let unreadableFiles = 0

  const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1 }
  const skip = (reason, purpose, status) => {
    bump(skipped, reason)
    if (purpose) bump(purposeSkips, purpose)
    if (typeof status === 'string') bump(skippedStatusCounts, status)
  }

  for (const fileName of fileNames) {
    let lines = 0
    try {
      overview.ledgerBytes += (await stat(join(dir, fileName))).size
      for await (const line of readLines(join(dir, fileName))) {
        lines++
        if (line.trim().length === 0) continue
        let record
        try { record = JSON.parse(line) } catch { overview.parseErrors++; continue }
        if (record.event === 'terminal') overview.terminalRecords++
        const extracted = extractMainRequest(record)
        if (extracted.skip) { skip(extracted.skip, extracted.purpose, record.status); continue }
        const request = extracted.request
        if (request.requestId !== null) {
          if (seenRequestIds.has(request.requestId)) { duplicateRequestIds++; continue }
          seenRequestIds.add(request.requestId)
        }
        bump(statusCounts, request.status)
        bump(usageSourceCounts, request.usageSource)
        let bucket = sessions.get(request.sessionId)
        if (bucket === undefined) { bucket = []; sessions.set(request.sessionId, bucket) }
        bucket.push(request)
      }
      overview.linesRead += lines
    } catch (error) {
      unreadableFiles++
      overview[`unreadable:${fileName}`] = String(error?.message ?? error)
    }
  }
  return { overview, skipped, purposeSkips, statusCounts, skippedStatusCounts, usageSourceCounts, sessions, duplicateRequestIds, unreadableFiles }
}

function replaySessions(sessions) {
  const decisions = new Map()
  const reasonRows = new Map()
  const foldReasonRows = new Map()
  const sensitivityFoldReasons = new Map()
  const contextRows = bucketRow(CONTEXT_BUCKETS)
  const actualFoldRows = bucketRow(CONTEXT_BUCKETS)
  const gapRows = Object.fromEntries(GAP_BUCKETS.map(b => [b.label, { pairs: 0, hitRatios: [] }]))
  const folds = []
  const perSession = []
  const cacheColdIdles = []
  let mainRequests = 0
  let minStartedAt = Infinity
  let maxStartedAt = -Infinity

  const bump = (map, key, sessionId) => {
    let row = map.get(key)
    if (row === undefined) { row = { requests: 0, sessions: new Set() }; map.set(key, row) }
    row.requests++
    row.sessions.add(sessionId)
    return row
  }

  for (const [sessionId, requests] of sessions) {
    requests.sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt)
    let peak = 0
    let actualFoldCount = 0
    let ruleFoldCount = 0

    for (let i = 0; i < requests.length; i++) {
      const current = requests[i]
      const previous = i > 0 ? requests[i - 1] : null
      mainRequests++
      peak = Math.max(peak, current.contextTokens)
      minStartedAt = Math.min(minStartedAt, current.startedAt)
      maxStartedAt = Math.max(maxStartedAt, current.startedAt)

      const input = {
        contextTokens: current.contextTokens,
        windowTokens: WINDOW_TOKENS,
        milestoneDone: MILESTONE_DONE,
        safeBoundary: SAFE_BOUNDARY,
        lastRequestAt: previous === null ? undefined : previous.endedAt,
        lastCacheHitRatio: current.hitRatio === null ? undefined : current.hitRatio,
        now: current.startedAt,
      }
      const decision = decideWindowAction(input)
      const gapMs = previous === null ? null : current.startedAt - previous.endedAt
      if (gapMs !== null) {
        // Sensitivity: treat a reported ratio of exactly 0 as "provider did not report caching", which
        // hands the cold test to the 300 s idle rule instead.
        const alt = decideWindowAction({ ...input, lastCacheHitRatio: current.hitRatio ? current.hitRatio : undefined })
        if (alt.action === 'fold') bump(sensitivityFoldReasons, alt.reason, sessionId)
      }

      decisions.set(decision.action, (decisions.get(decision.action) ?? 0) + 1)
      bump(reasonRows, decision.reason, sessionId)
      if (decision.action === 'fold') {
        ruleFoldCount++
        bump(foldReasonRows, decision.reason, sessionId)
        if (decision.reason === 'cache-cold' && decision.facts.idleMs !== null) cacheColdIdles.push(decision.facts.idleMs)
        folds.push({ sessionId, requestId: current.requestId, startedAt: current.startedAt, contextTokens: current.contextTokens, reason: decision.reason })
      }

      const contextRow = bucketOf(CONTEXT_BUCKETS, current.contextTokens)
      const row = contextRows[contextRow.label]
      row.requests++
      row.sessions.add(sessionId)
      if (current.hitRatio !== null) row.hitRatios.push(current.hitRatio)

      if (previous !== null) {
        const gapRow = gapRows[bucketOf(GAP_BUCKETS, Math.max(0, gapMs)).label]
        gapRow.pairs++
        if (current.hitRatio !== null) gapRow.hitRatios.push(current.hitRatio)
        // Actual fold: the carried context dropped sharply, so something rewrote the prefix between the two.
        if (current.contextTokens < previous.contextTokens * (1 - FOLD_DROP_RATIO) && previous.contextTokens >= FOLD_MIN_BEFORE) {
          actualFoldCount++
          const foldRow = actualFoldRows[bucketOf(CONTEXT_BUCKETS, previous.contextTokens).label]
          foldRow.folds++
          foldRow.sessions.add(sessionId)
        }
      }
    }
    perSession.push({ sessionId, requests: requests.length, peak, actualFolds: actualFoldCount, ruleFolds: ruleFoldCount })
  }

  return {
    mainRequests, minStartedAt, maxStartedAt, decisions, reasonRows, foldReasonRows, sensitivityFoldReasons,
    contextRows, actualFoldRows, gapRows, folds, perSession, cacheColdIdles,
  }
}

const rowList = map => [...map.entries()].map(([key, row]) => ({ key, requests: row.requests, sessions: row.sessions.size }))
  .sort((a, b) => b.requests - a.requests)

const withStats = row => ({
  label: row.label,
  requests: row.requests,
  sessions: row.sessions.size,
  averageCacheHitRatio: round(mean(row.hitRatios)),
  cacheHitSamples: row.hitRatios.length,
})

function buildSummary({ args, loaded, replay }) {
  const buckets = CONTEXT_BUCKETS.map(bucket => withStats({ ...replay.contextRows[bucket.label], label: bucket.label }))
  const actualFolds = CONTEXT_BUCKETS.map(bucket => {
    const row = replay.actualFoldRows[bucket.label]
    return { label: bucket.label, folds: row.folds, sessions: row.sessions.size }
  })
  const totalActualFolds = actualFolds.reduce((sum, row) => sum + row.folds, 0)
  const foldsBelow200k = actualFolds.filter(row => ['<50k', '50-100k', '100-200k'].includes(row.label))
    .reduce((sum, row) => sum + row.folds, 0)
  const gaps = GAP_BUCKETS.map(bucket => {
    const row = replay.gapRows[bucket.label]
    const sorted = [...row.hitRatios].sort((a, b) => a - b)
    return { label: bucket.label, pairs: row.pairs, samples: sorted.length, averageCacheHitRatio: round(mean(sorted)), medianCacheHitRatio: round(quantile(sorted, 0.5)) }
  })
  const idleSorted = [...replay.cacheColdIdles].sort((a, b) => a - b)
  const cacheColdFolds = replay.foldReasonRows.get('cache-cold')?.requests ?? 0
  const bucketRequests = buckets.reduce((sum, row) => sum + row.requests, 0)
  const reasonRequests = rowList(replay.reasonRows).reduce((sum, row) => sum + row.requests, 0)

  return {
    generatedAt: new Date().toISOString(),
    ledgerDir: args.ledger,
    outDir: args.out,
    rule: {
      source: 'home/profiles/web/plugins/team-v15-window-decision.mjs',
      settings: { ...WINDOW_DECISION_DEFAULTS },
      replayedInput: { windowTokens: WINDOW_TOKENS, milestoneDone: MILESTONE_DONE, safeBoundary: SAFE_BOUNDARY, window: null },
      fieldsUsed: ['event', 'purpose', 'sessionId', 'requestId', 'status', 'usageSource', 'model', 'provider',
        'usage.inputTokens', 'usage.cacheReadTokens', 'usage.cacheWriteTokens', 'startedAt', 'endedAt'],
      contextTokensFormula: 'usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens (missing cacheWrite counted as 0)',
      mainRequestRule: 'event === "terminal" && purpose === "conversation"',
      actualFoldRule: 'within a session, adjacent main requests with contextTokens down more than 40% and the pre-drop size >= 30000',
    },
    overview: {
      ...loaded.overview,
      sessions: loaded.sessions.size,
      mainRequests: replay.mainRequests,
      skipped: loaded.skipped,
      skippedByPurpose: loaded.purposeSkips,
      duplicateRequestIds: loaded.duplicateRequestIds,
      unreadableFiles: loaded.unreadableFiles,
      firstRequestAt: replay.minStartedAt === Infinity ? null : new Date(replay.minStartedAt).toISOString(),
      lastRequestAt: replay.maxStartedAt === -Infinity ? null : new Date(replay.maxStartedAt).toISOString(),
      statusCounts: loaded.statusCounts,
      skippedStatusCounts: loaded.skippedStatusCounts,
      usageSourceCounts: loaded.usageSourceCounts,
    },
    contextBuckets: buckets,
    decisions: {
      byAction: Object.fromEntries([...replay.decisions.entries()].sort((a, b) => b[1] - a[1])),
      byReason: rowList(replay.reasonRows),
      foldByReason: rowList(replay.foldReasonRows),
      sensitivityRatioZeroAsUnknown: rowList(replay.sensitivityFoldReasons),
      foldsTotal: replay.folds.length,
    },
    actualFolds: {
      total: totalActualFolds,
      byContextBucket: actualFolds,
      below200kShare: totalActualFolds === 0 ? null : round(foldsBelow200k / totalActualFolds),
      below200kCount: foldsBelow200k,
    },
    foldComparison: {
      cacheColdIdle: {
        folds: cacheColdFolds,
        samples: idleSorted.length,
        foldsWithoutIdle: cacheColdFolds - idleSorted.length,
        medianMs: quantile(idleSorted, 0.5),
        p90Ms: quantile(idleSorted, 0.9),
        minMs: idleSorted[0] ?? null,
        maxMs: idleSorted[idleSorted.length - 1] ?? null,
      },
      gapToCacheHit: gaps,
    },
    topSessions: [...replay.perSession].sort((a, b) => b.peak - a.peak || b.requests - a.requests).slice(0, 10)
      .map(row => ({ sessionIdPrefix: sessionPrefix(row.sessionId), mainRequests: row.requests, peakContextTokens: row.peak, actualFolds: row.actualFolds, ruleFolds: row.ruleFolds })),
    consistency: {
      bucketRequestsEqualMainRequests: bucketRequests === replay.mainRequests,
      reasonRequestsEqualMainRequests: reasonRequests === replay.mainRequests,
      bucketRequests, reasonRequests,
    },
  }
}

const asPercent = value => value === null || value === undefined ? '-' : `${(value * 100).toFixed(1)}%`
const asDuration = ms => ms === null || ms === undefined ? '-' : ms >= MINUTE ? `${(ms / MINUTE).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`

function renderMarkdown(summary) {
  const lines = []
  const push = text => lines.push(text)
  const table = (header, rows) => {
    push(`| ${header.join(' | ')} |`)
    push(`| ${header.map(() => '---').join(' | ')} |`)
    for (const row of rows) push(`| ${row.join(' | ')} |`)
  }
  const o = summary.overview
  push('# 窗口折叠规则影子回放')
  push('')
  push(`生成时间：${summary.generatedAt}；台账目录：\`${summary.ledgerDir}\``)
  push('')
  push('只读回放：把生产台账里每个会话主请求的终态用量，喂给纯函数 `decideWindowAction`，看它在当时会给出什么决定，并与台账里实际发生的折叠对照。不改变任何运行时行为。')
  push('')
  push('## 1. 总览')
  push('')
  table(['指标', '数值'], [
    ['台账文件数 (requests-*.jsonl)', o.ledgerFiles], ['台账字节数 (仅上述文件)', o.ledgerBytes],
    ['读取行数', o.linesRead], ['JSON 解析失败行', o.parseErrors],
    ['终态记录数 (event=terminal)', o.terminalRecords], ['会话数', o.sessions], ['主请求数 (purpose=conversation)', o.mainRequests],
    ['请求时间范围', `${o.firstRequestAt ?? '-'} → ${o.lastRequestAt ?? '-'}`],
    ['主请求状态分布', Object.entries(o.statusCounts).map(([key, value]) => `${key} ${value}`).join('、')],
  ])
  push('')
  push('跳过的记录（按首个不满足的条件归类，一条记录只计一次）：')
  push('')
  table(['跳过原因', '记录数'], Object.entries(o.skipped).sort((a, b) => b[1] - a[1]).map(([key, value]) => [key, value]))
  push('')
  push('被跳过的记录按 status 分布：')
  push('')
  table(['status', '记录数'], Object.entries(o.skippedStatusCounts).sort((a, b) => b[1] - a[1]))
  push('')
  push(`其中被 purpose 排除的：${Object.entries(o.skippedByPurpose).map(([key, value]) => `${key} ${value} 条`).join('、') || '无'}。`)
  push(`重复 requestId 丢弃 ${o.duplicateRequestIds} 条；不可读文件 ${o.unreadableFiles} 个。`)
  push('')
  push('说明：`not-terminal` 是配套的 start 记录，`no-session-id`、`not-conversation`、`zero-context-tokens` 各自代表缺少会话标识、'
    + '不是会话主请求、以及没有可用输入 token 数的终态记录；被跳过者含全部 consumer-return 与 error 记录，'
    + '因此本报告只描述成功完成、且用量已落为适配器最终快照的请求。')
  push('')
  push('## 2. 上下文大小分布（主请求 contextTokens）')
  push('')
  table(['桶', '请求数', '会话数', '平均缓存命中比例', '有命中比例的样本数'],
    summary.contextBuckets.map(row => [row.label, row.requests, row.sessions, asPercent(row.averageCacheHitRatio), row.cacheHitSamples]))
  push('')
  push('contextTokens = inputTokens + cacheReadTokens + cacheWriteTokens（缺失的 cacheWrite 记 0）；"有命中比例的样本数"小于请求数说明该桶里有请求没有上报缓存读。'
    + '平均命中比例高的桶意味着该区间多数请求几乎是重发同一前缀，折叠它们会丢掉仍然有效的缓存。')
  push('')
  push('## 3. 判断函数的决定分布')
  push('')
  table(['action', '请求数'], Object.entries(summary.decisions.byAction))
  push('')
  push('按 reason：')
  push('')
  table(['reason', '请求数', '涉及会话数'], summary.decisions.byReason.map(row => [row.key, row.requests, row.sessions]))
  push('')
  push('fold 决定按 reason 细分：')
  push('')
  table(['reason', '请求数', '涉及会话数'], summary.decisions.foldByReason.map(row => [row.key, row.requests, row.sessions]))
  push('')
  push(`因回放固定 safeBoundary=true（每个请求发出前都被视为安全边界），规则不会返回 wait-for-boundary；`
    + `milestoneDone 固定为 false（台账没有里程碑信息），所以不会出现 milestone/milestone-below-floor，这部分被系统性忽略。`)
  push(`敏感度：若把缓存命中比例恰好为 0 视作"服务商未上报缓存"、改由 300 s 空闲规则判定冷缓存，fold 决定变为 `
    + `${summary.decisions.sensitivityRatioZeroAsUnknown.map(row => `${row.key} ${row.requests}`).join('、')}。`)
  push('')
  push('## 4. 实际发生的折叠')
  push('')
  table(['判定前大小桶', '折叠次数', '涉及会话数'], summary.actualFolds.byContextBucket.map(row => [row.label, row.folds, row.sessions]))
  push('')
  push(`实际折叠共 ${summary.actualFolds.total} 次，其中 ${summary.actualFolds.below200kCount} 次发生在 200k 以下，占 ${asPercent(summary.actualFolds.below200kShare)}。`
    + '新规则在 200k 以下一律不折，这部分正是"按新规则不该折"的折叠。')
  push('')
  push('说明：实际折叠只用 token 数的骤降近似（相邻主请求下降超过 40% 且下降前不小于 30000），'
    + '既可能漏掉"折叠后仍然很大"的情形，也可能把真实的内容删除、分支切换误记为折叠。')
  push('')
  push('## 5. 对照')
  push('')
  const idle = summary.foldComparison.cacheColdIdle
  table(['新规则 cache-cold 折叠', '值'], [
    ['折叠次数', idle.folds], ['有可用空闲时长的样本数', idle.samples],
    ['无空闲时长的折叠（各自会话的首个请求）', idle.foldsWithoutIdle],
    ['空闲时长中位数', asDuration(idle.medianMs)], ['空闲时长 P90', asDuration(idle.p90Ms)],
    ['最小 / 最大', `${asDuration(idle.minMs)} / ${asDuration(idle.maxMs)}`],
  ])
  push('')
  push('空闲时长 = 本请求开始时间 − 上一请求结束时间。这些请求被判 cache-cold 是因为它们的缓存命中比例低于 20%（多数为 0），'
    + '空闲时长只是同一时刻的背景量；由于台账几乎总是上报了命中比例，300 s 空闲规则在这批数据里极少实际生效。'
    + '样本量很小，中位数与 P90 只作参考，不足以支撑结论。')
  push('')
  push('相邻请求间隔 → 后一个请求的缓存命中比例：')
  push('')
  table(['间隔桶', '相邻请求对数', '有命中比例样本', '平均命中比例', '中位命中比例'],
    summary.foldComparison.gapToCacheHit.map(row => [row.label, row.pairs, row.samples, asPercent(row.averageCacheHitRatio), asPercent(row.medianCacheHitRatio)]))
  push('')
  push('这张表用来估计服务商缓存的实际寿命：中位命中比例仍高的间隔桶，说明该时长内前缀缓存大概率还活着，'
    + '在那时折叠等于白扔缓存；命中比例跌到接近 0 的间隔桶，折叠的额外成本最小。')
  push('')
  push('## 6. 最大的 10 个会话（按峰值 contextTokens）')
  push('')
  table(['会话 id 前 8 位', '主请求数', '峰值大小', '实际折叠次数', '新规则 fold 决定次数'],
    summary.topSessions.map(row => [row.sessionIdPrefix, row.mainRequests, row.peakContextTokens, row.actualFolds, row.ruleFolds]))
  push('')
  push('峰值是新规则关注的对象；实际折叠次数与新规则 fold 次数差距大的会话，就是新规则会明显改变行为的地方。')
  push('')
  push('## 7. 一致性自检与局限')
  push('')
  table(['检查', '结果'], [
    ['各桶请求数之和 = 主请求数', `${summary.consistency.bucketRequests} / ${summary.overview.mainRequests} → ${summary.consistency.bucketRequestsEqualMainRequests}`],
    ['各 reason 计数之和 = 主请求数', `${summary.consistency.reasonRequests} / ${summary.overview.mainRequests} → ${summary.consistency.reasonRequestsEqualMainRequests}`],
  ])
  push('')
  push('局限：')
  push('')
  push('- 台账没有里程碑信息，`milestoneDone` 恒为 false，规则中依赖里程碑的两条分支未被检验。')
  push('- 回放把每个请求都当作安全边界，`wait-for-boundary` 分支未被检验。')
  push('- `lastCacheHitRatio` 按回放约定取"该请求自身"的缓存读比例，而函数文档说的是"上一个请求"，两者相邻，但含义不同；'
    + '这会让 cache-cold 判定偏保守（少数首次请求、缓存尚未建立时命中比例天然为 0）。')
  push('- `window` 不传，mechanism 恒为 compaction，本报告不评估 W2 窗口机制的收益。')
  push('- 会话标识依赖台账写入时的 sessionId，写不出来的记录（见跳过统计）被整体丢弃。')
  push('- 回放只发生在有终态记录的主请求上；被中途取消、没有终态用量的请求不参与。')
  push('')
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const loaded = await loadLedger(args.ledger)
  const replay = replaySessions(loaded.sessions)
  const summary = buildSummary({ args, loaded, replay })
  await mkdir(args.out, { recursive: true })
  await writeFile(join(args.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await writeFile(join(args.out, 'summary.md'), renderMarkdown(summary), 'utf8')
  const { consistency, overview } = summary
  process.stdout.write(`ledger files=${overview.ledgerFiles} sessions=${overview.sessions} mainRequests=${overview.mainRequests} `
    + `parseErrors=${overview.parseErrors} folds(actual)=${summary.actualFolds.total} folds(rule)=${summary.decisions.foldsTotal} `
    + `bucketSum=${consistency.bucketRequestsEqualMainRequests} reasonSum=${consistency.reasonRequestsEqualMainRequests}\n`)
  process.stdout.write(`wrote ${join(args.out, 'summary.json')} and ${join(args.out, 'summary.md')}\n`)
}

await main()
