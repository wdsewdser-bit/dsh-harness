// Direct model probe: how well does the routed model recall planted facts as the context grows?
// It calibrates the size thresholds for compaction/windowing (when attention starts to slip) and records what each
// tier really costs in missed and cached input. No DSH host is started and nothing under the production home is
// written; the provider key is read read-only, used in memory for the request header and never printed or stored.
// Usage: node tools/context-size-recall-probe.mjs --label t1 --tiers 50000,100000,300000 --reps 3 [--run]
//        without --run it only builds the documents and reports their sizes (no request is sent).
//        --mode hard replaces plain lookup with confusable look-alikes, three-hop chains, scattered counting and an
//        instruction given once at the very start: lookup alone stays perfect at any size and measures nothing.
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stage = resolve(fileURLToPath(new URL('..', import.meta.url)))
const route = Object.freeze({ baseURL: 'http://127.0.0.1:8788/v1', model: 'deepseek-v4.1-flash' })
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const label = arg('--label') ?? '', run = process.argv.includes('--run')
const tiers = (arg('--tiers') ?? '').split(',').filter(Boolean).map(Number), reps = Number(arg('--reps') ?? 1)
const hard = (arg('--mode') ?? 'simple') === 'hard'
const maxOutputTokens = Number(arg('--max-output') ?? (hard ? 16384 : 8192)), effort = arg('--effort') ?? 'high'
// The provider serves a new prefix from cache only some seconds after first seeing it: wait before the second question.
const gapMs = Number(arg('--gap-ms') ?? 20000), split = process.argv.includes('--split')
if (!/^[a-z0-9-]{1,24}$/.test(label) || !tiers.length || tiers.some(n => !Number.isSafeInteger(n) || n < 2000 || n > 950000)
  || !Number.isSafeInteger(reps) || reps < 1 || reps > 10) throw new Error('PROBE_ARGUMENTS_INVALID')
const sha = text => createHash('sha256').update(text).digest('hex')

// Deterministic generator: the same seed always builds the same document.
function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const MODULES = ['scheduler', 'ledger', 'renderer', 'importer', 'gateway', 'indexer', 'planner', 'verifier', 'cache', 'router', 'archiver', 'notifier']
const VERBS = ['reconciled', 'rebuilt', 'measured', 'migrated', 'validated', 'retried', 'profiled', 'rotated', 'compared', 'replayed', 'sampled', 'throttled']
const OBJECTS = ['the pending queue', 'two stale leases', 'the snapshot index', 'a partial batch', 'the retry budget', 'the shard map', 'an orphaned handle', 'the audit trail', 'the warm pool', 'a delayed ack']
const OUTCOMES = ['no change was needed', 'the earlier estimate held', 'one outlier was set aside', 'the result matched the dry run', 'a follow-up note was filed', 'latency stayed within range', 'the count agreed with the ledger']
const SUBJECTS = ['deploy window', 'retention period', 'owner group', 'error budget', 'batch size', 'review quorum', 'freeze date', 'rollback tag', 'quota ceiling', 'escalation contact', 'sampling rate', 'archive bucket']
const VALUES = ['amber', 'cobalt', 'ivory', 'saffron', 'teal', 'crimson', 'umber', 'jade', 'indigo', 'slate', 'coral', 'ochre', 'pewter', 'lilac', 'russet', 'azure']
function build(targetChars, seed) {
  const next = prng(seed), pick = list => list[Math.floor(next() * list.length)], code = () => Math.floor(next() * 0xfffff).toString(16).padStart(5, '0')
  const value = () => `${pick(VALUES)}-${Math.floor(100 + next() * 900)}`
  const facts = Array.from({ length: 24 }, (_, i) => ({ id: 'FACT-' + String(i + 1).padStart(2, '0'), depth: (i + 0.5) / 24,
    subject: `${pick(SUBJECTS)} of the ${pick(MODULES)} ${code()}`, value: value(), corrected: null }))
  // Every fourth fact is corrected later in the document: the current value is the corrected one.
  for (const fact of facts.filter((_, i) => i % 4 === 1)) fact.corrected = { value: value(), depth: Math.min(0.98, fact.depth + 0.15 + next() * 0.2) }
  const inserts = [...facts.map(f => ({ at: f.depth, text: `RECORD ${f.id}: the ${f.subject} is ${f.value}.` })),
    ...facts.filter(f => f.corrected).map(f => ({ at: f.corrected.depth, text: `CORRECTION for ${f.id}: the ${f.subject} is now ${f.corrected.value}; the earlier value no longer applies.` }))]
    .sort((a, b) => a.at - b.at)
  const lines = []
  let chars = 0, entry = 0
  while (chars < targetChars) {
    while (inserts.length && inserts[0].at <= chars / targetChars) { const row = inserts.shift(); lines.push(row.text); chars += row.text.length + 1 }
    const line = `[entry ${++entry}] ${pick(MODULES)} ${code()}: ${pick(VERBS)} ${pick(OBJECTS)} after ${Math.floor(next() * 90 + 5)} minutes; ${pick(OUTCOMES)} (ref ${code()}-${code()}).`
    lines.push(line); chars += line.length + 1
  }
  for (const row of inserts) lines.push(row.text)
  return { document: lines.join('\n'), facts }
}
const header = 'You are reading the working journal of a long engineering session. It contains routine entries, numbered RECORD lines and occasional CORRECTION lines. A CORRECTION replaces the value of the RECORD it names.\n\n=== JOURNAL START ===\n'
const question = ids => `\n=== JOURNAL END ===\n\nReport the CURRENT value of each of these records, applying any correction: ${ids.join(', ')}.\nAnswer with one JSON object only, mapping each record id to its current value string, for example {"FACT-01":"amber-123"}. No other text.`

// `text` may be [document, question]: sent as two messages so the document is a message-aligned prefix.
async function ask(key, session, text) {
  const started = Date.now()
  const response = await fetch(route.baseURL + '/responses', { method: 'POST', signal: AbortSignal.timeout(900000),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, 'x-opencode-session': session },
    body: JSON.stringify({ model: route.model, input: (Array.isArray(text) ? text : [text]).map(part => ({ role: 'user', content: [{ type: 'input_text', text: part }] })),
      max_output_tokens: maxOutputTokens, reasoning: { effort }, stream: false, store: false }) })
  const raw = await response.text()
  if (!response.ok) return { ok: false, status: response.status, error: raw.slice(0, 300), wallMs: Date.now() - started }
  const body = JSON.parse(raw), usage = body.usage ?? {}
  const answer = (body.output ?? []).flatMap(item => item.type === 'message' ? item.content ?? [] : []).filter(part => part.type === 'output_text').map(part => part.text).join('')
  const cached = usage.input_tokens_details?.cached_tokens ?? null
  return { ok: true, status: response.status, wallMs: Date.now() - started, finish: body.status ?? null, incomplete: body.incomplete_details?.reason ?? null,
    usage: { inputTokensTotal: usage.input_tokens ?? null, cachedTokens: cached, uncachedTokens: usage.input_tokens != null && cached != null ? usage.input_tokens - cached : null,
      outputTokens: usage.output_tokens ?? null, reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null }, rawUsage: usage, answer }
}
function score(facts, ids, answer) {
  let parsed = null
  try { const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer); parsed = JSON.parse(fenced ? fenced[1] : answer.trim()) } catch { /* unparsable answer scores zero */ }
  return ids.map(id => {
    const fact = facts.find(f => f.id === id), expected = fact.corrected?.value ?? fact.value, got = parsed && typeof parsed === 'object' ? String(parsed[id] ?? '') : ''
    return { id, depth: Number(fact.depth.toFixed(3)), corrected: fact.corrected !== null, correct: got === expected,
      stale: fact.corrected !== null && got === fact.value, missing: got === '' }
  })
}

const PEOPLE = ['Imani Okafor', 'Tomas Lindqvist', 'Mei Tanaka', 'Rafael Duarte', 'Anika Bose', 'Jonas Weller', 'Sofia Marchetti', 'Kwame Mensah', 'Elena Petrova', 'Diego Salazar', 'Hana Yilmaz', 'Oliver Grant', 'Priya Nair', 'Lucas Moreau', 'Zofia Kowalska', 'Amir Haddad']
const hardHeader = 'You are reading the working journal of a long engineering session: routine entries mixed with notes, updates, routing rules, rosters and incident lines. An Update replaces the value of the exact unit it names and no other.\nStanding instruction for your final report: write every colour word in UPPERCASE (for example AMBER-123), and append " (verified)" to the name of every person.\n\n=== JOURNAL START ===\n'
function buildHard(targetChars, seed) {
  const next = prng(seed), pick = list => list[Math.floor(next() * list.length)], code = () => Math.floor(next() * 0xfffff).toString(16).padStart(5, '0')
  const value = () => `${pick(VALUES)}-${Math.floor(100 + next() * 900)}`, spot = (low = 0.02, high = 0.97) => low + next() * (high - low)
  const inserts = []
  // Sixteen targets, each hidden among five look-alikes that share its subject and module and differ only in the unit code.
  const targets = Array.from({ length: 16 }, (_, i) => {
    const subject = SUBJECTS[i % SUBJECTS.length], module = pick(MODULES)
    const target = { id: 'Q' + String(i + 1).padStart(2, '0'), subject, module, unit: code(), value: value(), old: null, lookalikes: [] }
    // An update always comes after the note it replaces, otherwise "current" would be ambiguous.
    const after = at => at + (0.99 - at) * (0.2 + 0.75 * next())
    const noted = spot(0.02, 0.9)
    inserts.push({ at: noted, text: `Note: the ${subject} of ${module} unit ${target.unit} is ${target.value}.` })
    for (let k = 0; k < 5; k++) {
      const other = { unit: code(), value: value() }
      target.lookalikes.push(other.value)
      const otherAt = spot(0.02, 0.9)
      inserts.push({ at: otherAt, text: `Note: the ${subject} of ${module} unit ${other.unit} is ${other.value}.` })
      if (k === 0 && i % 3 === 1) { const moved = value(); target.lookalikes.push(moved); inserts.push({ at: after(otherAt), text: `Update: the ${subject} of ${module} unit ${other.unit} is now ${moved}.` }) }
    }
    if (i % 3 === 0) { target.old = target.value; target.value = value(); inserts.push({ at: after(noted), text: `Update: the ${subject} of ${module} unit ${target.unit} is now ${target.value}.` }) }
    return target
  })
  // Six three-hop chains whose links sit far apart, plus roster lines for unrelated units.
  const chains = Array.from({ length: 6 }, (_, i) => {
    const chain = { id: 'R' + (i + 1), a: code(), b: code(), c: code(), person: PEOPLE[Math.floor(next() * PEOPLE.length)] }
    inserts.push({ at: spot(), text: `Routing rule: the reviewer for unit ${chain.a} is whoever owns unit ${chain.b}.` })
    inserts.push({ at: spot(), text: `Ownership: unit ${chain.b} is owned by the on-call engineer of unit ${chain.c}.` })
    inserts.push({ at: spot(), text: `Roster: the on-call engineer of unit ${chain.c} is ${chain.person}.` })
    return chain
  })
  for (let i = 0; i < 12; i++) inserts.push({ at: spot(), text: `Roster: the on-call engineer of unit ${code()} is ${pick(PEOPLE)}.` })
  // Counting: sev-1 incidents per module, scattered, with sev-3 lines that must not be counted.
  const incidents = [...MODULES].map(module => ({ module, order: next() })).sort((x, y) => x.order - y.order).slice(0, 4)
    .map(row => ({ module: row.module, count: 3 + Math.floor(next() * 7) }))
  for (const row of incidents) {
    for (let k = 0; k < row.count; k++) inserts.push({ at: spot(), text: `INCIDENT sev-1 in ${row.module}: paging the duty lead (ticket ${code()}).` })
    for (let k = 0; k < 4; k++) inserts.push({ at: spot(), text: `INCIDENT sev-3 in ${row.module}: logged for the weekly review (ticket ${code()}).` })
  }
  inserts.sort((x, y) => x.at - y.at)
  const lines = []
  let chars = 0, entry = 0
  while (chars < targetChars) {
    while (inserts.length && inserts[0].at <= chars / targetChars) { const row = inserts.shift(); lines.push(row.text); chars += row.text.length + 1 }
    const line = `[entry ${++entry}] ${pick(MODULES)} ${code()}: ${pick(VERBS)} ${pick(OBJECTS)} after ${Math.floor(next() * 90 + 5)} minutes; ${pick(OUTCOMES)} (ref ${code()}-${code()}).`
    lines.push(line); chars += line.length + 1
  }
  for (const row of inserts) lines.push(row.text)
  const asked = '\n=== JOURNAL END ===\n\nAnswer these from the journal.\n'
    + targets.map(q => `${q.id}: the current ${q.subject} of ${q.module} unit ${q.unit}`).join('\n') + '\n'
    + chains.map(c => `${c.id}: the reviewer for unit ${c.a}`).join('\n') + '\n'
    + `COUNTS: the number of sev-1 incidents in each of: ${incidents.map(row => row.module).join(', ')}\n`
    + 'Reply with one JSON object only, shaped {"values":{"Q01":"..."},"reviewers":{"R1":"..."},"incidents":{"module":0}}. No other text.'
  return { document: lines.join('\n'), question: asked, targets, chains, incidents }
}
function scoreHard(built, answer) {
  let parsed = {}
  try { const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(answer); parsed = JSON.parse(fenced ? fenced[1] : answer.trim()) ?? {} } catch { /* unparsable answer scores zero */ }
  const lower = value => String(value ?? '').trim().toLowerCase()
  const values = built.targets.map(q => {
    const got = String(parsed.values?.[q.id] ?? '').trim()
    return { id: q.id, updated: q.old !== null, correct: lower(got) === q.value, stale: q.old !== null && lower(got) === q.old,
      confused: q.lookalikes.includes(lower(got)), formatted: got === q.value.toUpperCase() }
  })
  const reviewers = built.chains.map(c => {
    const got = String(parsed.reviewers?.[c.id] ?? '').trim()
    return { id: c.id, correct: lower(got).includes(c.person.toLowerCase()), formatted: got.endsWith(' (verified)') }
  })
  const incidents = built.incidents.map(row => {
    const got = Number(parsed.incidents?.[row.module])
    return { module: row.module, expected: row.count, got: Number.isFinite(got) ? got : null, correct: got === row.count }
  })
  const count = (list, key) => list.filter(row => row[key]).length
  return { values, reviewers, incidents, totals: { values: count(values, 'correct'), valuesAsked: values.length, stale: count(values, 'stale'), confused: count(values, 'confused'),
    chains: count(reviewers, 'correct'), chainsAsked: reviewers.length, counts: count(incidents, 'correct'), countsAsked: incidents.length,
    countError: incidents.reduce((sum, row) => sum + (row.got === null ? row.expected : Math.abs(row.got - row.expected)), 0),
    formatted: count(values, 'formatted') + count(reviewers, 'formatted'), formatAsked: values.length + reviewers.length } }
}

const output = join(stage, 'lab-runs', `context-size-${label}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}`)
mkdirSync(output, { recursive: false })
let key = null
if (run) {
  const require = createRequire(new URL('../app/package.json', import.meta.url))
  const { parseCredentialsDocument } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')))
  key = parseCredentialsDocument(readFileSync('D:/dsh-test/home/.credentials.yaml', 'utf8'), 'readonly-production').refs.get('OPENCODEGO_API_KEY')
  if (typeof key !== 'string' || !key) throw new Error('PROBE_CREDENTIAL_REFERENCE_MISSING')
}
let charsPerToken = Number(arg('--chars-per-token') ?? 3.4)
const rows = [], save = () => writeFileSync(join(output, 'summary.json'), JSON.stringify({ label, mode: hard ? 'hard' : 'simple', route, effort, maxOutputTokens, gapMs, run, charsPerToken, rows }, null, 1) + '\n')
let consecutiveFailures = 0
outer: for (const tier of tiers) for (let rep = 1; rep <= reps; rep++) {
  if (hard) {
    const seed = tier * 3 + rep * 104729, built = buildHard(Math.round(tier * charsPerToken), seed), prompt = hardHeader + built.document + built.question
    const row = { tier, rep, seed, documentChars: prompt.length, documentSha256: sha(prompt), requests: [] }
    if (run) {
      const result = await ask(key, 'context-size-probe-' + randomUUID(), prompt)
      const marks = result.ok ? scoreHard(built, result.answer) : null
      row.requests.push({ name: 'hard', ...result, answer: undefined, answerSha256: result.ok ? sha(result.answer) : null, ...(marks ?? {}) })
      writeFileSync(join(output, `answer-${tier}-r${rep}-hard.txt`), result.ok ? result.answer : JSON.stringify(result))
      const s = marks?.totals
      console.log(`tier=${tier} rep=${rep} hard ok=${result.ok} status=${result.status}` + (s ? ` values=${s.values}/${s.valuesAsked} stale=${s.stale} confused=${s.confused} chains=${s.chains}/${s.chainsAsked} counts=${s.counts}/${s.countsAsked} countErr=${s.countError} format=${s.formatted}/${s.formatAsked}` : '')
        + ` input=${result.usage?.inputTokensTotal} output=${result.usage?.outputTokens} reasoning=${result.usage?.reasoningTokens} finish=${result.finish}${result.incomplete ? '/' + result.incomplete : ''} wall=${Math.round(result.wallMs / 1000)}s${result.ok ? '' : ' ' + result.error}`)
      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1
      if (consecutiveFailures >= 3) { rows.push(row); save(); console.log('STOP three consecutive request failures'); break outer }
      if (result.ok && result.usage.inputTokensTotal > 0) charsPerToken = Number((prompt.length / result.usage.inputTokensTotal).toFixed(3))
    } else console.log(`tier=${tier} rep=${rep} hard chars=${prompt.length} sha=${row.documentSha256.slice(0, 12)} targets=${built.targets.length} chains=${built.chains.length} incidents=${built.incidents.map(r => r.count).join('/')}`)
    rows.push(row); save()
    continue
  }
  const seed = tier + rep * 7919, { document, facts } = build(Math.round(tier * charsPerToken), seed)
  const ids = facts.map(f => f.id), first = ids.filter((_, i) => i % 2 === 0), second = ids.filter((_, i) => i % 2 === 1)
  const prefix = header + document
  const row = { tier, rep, seed, documentChars: prefix.length, documentSha256: sha(prefix), requests: [] }
  if (run) {
    const session = 'context-size-probe-' + randomUUID()
    // Two questions over the identical prefix: the second shows what the provider serves from cache at this size.
    for (const [name, asked] of [['first-half', first], ['second-half', second]]) {
      if (name === 'second-half' && gapMs > 0) await new Promise(done => setTimeout(done, gapMs))
      const result = await ask(key, session, split ? [prefix, question(asked)] : prefix + question(asked))
      const marks = result.ok ? score(facts, asked, result.answer) : []
      row.requests.push({ name, ...result, answer: undefined, answerSha256: result.ok ? sha(result.answer) : null, answerChars: result.ok ? result.answer.length : 0,
        correct: marks.filter(m => m.correct).length, asked: asked.length, stale: marks.filter(m => m.stale).length, missing: marks.filter(m => m.missing).length, marks })
      writeFileSync(join(output, `answer-${tier}-r${rep}-${name}.txt`), result.ok ? result.answer : JSON.stringify(result))
      console.log(`tier=${tier} rep=${rep} ${name} ok=${result.ok} status=${result.status} correct=${marks.filter(m => m.correct).length}/${asked.length} stale=${marks.filter(m => m.stale).length} input=${result.usage?.inputTokensTotal} cached=${result.usage?.cachedTokens} output=${result.usage?.outputTokens} wall=${Math.round(result.wallMs / 1000)}s${result.ok ? '' : ' ' + result.error}`)
      consecutiveFailures = result.ok ? 0 : consecutiveFailures + 1
      if (consecutiveFailures >= 3) { rows.push(row); save(); console.log('STOP three consecutive request failures'); break outer }
      // Calibrate the size model from what the provider actually counted.
      if (result.ok && result.usage.inputTokensTotal > 0 && name === 'first-half') charsPerToken = Number(((prefix.length + question(asked).length) / result.usage.inputTokensTotal).toFixed(3))
    }
  } else console.log(`tier=${tier} rep=${rep} chars=${prefix.length} sha=${row.documentSha256.slice(0, 12)} facts=${facts.length} corrected=${facts.filter(f => f.corrected).length}`)
  rows.push(row); save()
}
save()
console.log('SUMMARY ' + join(output, 'summary.json'))
