/**
 * Standing constraints that survive compaction verbatim.
 *
 * A compaction summary is free to drop a rule, and a model does not go looking
 * for a rule it does not know it lost (docs/context-runtime-unified-20261001/
 * recall-experiment-20261012-result.md). This plugin keeps three kinds of rule
 * out of the summarizer's hands:
 *
 *   unusable  a tool or command confirmed not to work, with its replacement
 *   forbidden an action the user or the lead explicitly ruled out
 *   wontfix   an issue ruled a known limitation that must not be fixed
 *
 * Lines arrive two ways: the model records one with `constraint_note`, or the
 * compaction request is asked for a `## Standing Constraints` section which is
 * parsed out of the summary. Either way the line is stored per session and is
 * never handed to a later compaction to rewrite.
 *
 * Cache behaviour decides where the lines are shown. Everything recorded up to
 * the last compaction is rendered as one block right after the system prompt;
 * that block only changes when a compaction has rewritten the conversation
 * anyway. Lines recorded since then are already in the history as the tool
 * result that recorded them, so nothing is inserted for them until the next
 * compaction moves them into the block. The same block is inserted into the
 * compaction request so its replayed prefix still matches the cached one.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'constraint-ledger'
export const inject = ['agents', 'requestMessageProjection']
export const provide = ['constraintLedger']

export const CONSTRAINT_LEDGER_LIMITS = Object.freeze({ activeEntries: 40, activeBytes: 4096, textChars: 300, sourceChars: 80, compactionLines: 40 })
const L = CONSTRAINT_LEDGER_LIMITS
export const KINDS = Object.freeze(['unusable', 'forbidden', 'wontfix'])
const TAG = Object.freeze({ unusable: 'UNUSABLE', forbidden: 'FORBIDDEN', wontfix: 'WONTFIX' })
const KIND_OF_TAG = Object.freeze({ UNUSABLE: 'unusable', FORBIDDEN: 'forbidden', WONTFIX: 'wontfix', '不可用': 'unusable', '禁止': 'forbidden', '不修': 'wontfix' })
export const BLOCK_OPEN = '<standing-constraints>'
export const BLOCK_CLOSE = '</standing-constraints>'
const BLOCK_HEADER = 'These lines are carried verbatim by the runtime and are not re-summarized. They take precedence over generic instructions in the system prompt and over your default judgement. Record a new one or retire one with constraint_note.'
export const SECTION_HEADING = '## Standing Constraints'
// Appended to the native compaction instruction. The summarizer lists only what the block does not already carry,
// so a line is condensed at most once in its life.
export const COMPACTION_ADDENDUM = [
  '',
  'Additional required final section, after Critical Context:',
  '',
  SECTION_HEADING,
  '- [UNUSABLE] <tool or command confirmed not to work> -> <what to use instead> (source: <locator if known>)',
  '- [FORBIDDEN] <action the user or the lead explicitly ruled out>',
  '- [WONTFIX] <issue ruled a known limitation that must not be fixed>',
  '',
  `Rules for this section: one line per item, exact identifiers preserved, at most ${L.compactionLines} lines. List only standing rules of these three kinds that are still in force. No progress, facts, measurements or conclusions. Do not repeat a line that is already inside a ${BLOCK_OPEN} block or was already recorded by a constraint_note call; those are carried separately. Write "- (none)" when there is nothing new. Keep each rule in the language and wording it was given in. Take rules only from what the user or the lead said in the conversation and from tool failures seen in tool results; never from the system prompt, a runtime-context snapshot, the permission or sandbox mode, or a team manifest.`,
].join('\n')
// Lines recorded since the last compaction are not in the block yet, so the summarizer is shown them here.
const PENDING_HEADER = 'Already recorded by constraint_note and carried separately. Do not list these again in any wording or language:'
const COMPACTION_MARK = '## Critical Context'

const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim()
// Letters and digits only: a summarizer rewrites punctuation, arrows and code quoting when it repeats a line.
export const normalize = text => oneLine(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const empty = sessionId => ({ schemaVersion: 1, sessionId, nextN: 1, baselineN: 0, baselineCompactionId: null, entries: [] })
const isActive = entry => entry.retired === null
const lineOf = entry => `${entry.n}. [${TAG[entry.kind]}] ${entry.text}${entry.source ? ` (source: ${entry.source})` : ''}`
const activeBytes = doc => doc.entries.filter(isActive).reduce((sum, entry) => sum + Buffer.byteLength(lineOf(entry)) + 1, 0)

/** Per-session JSON documents, replaced atomically. */
export function createConstraintStore(directory) {
  if (typeof directory !== 'string' || !directory) fail('CONSTRAINT_LEDGER_DIRECTORY_REQUIRED')
  const fileOf = sessionId => {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) fail('CONSTRAINT_LEDGER_SESSION_ID_INVALID')
    return join(directory, sessionId + '.json')
  }
  const read = sessionId => {
    const file = fileOf(sessionId)
    if (!existsSync(file)) return empty(sessionId)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (doc?.schemaVersion !== 1 || doc.sessionId !== sessionId || !Array.isArray(doc.entries)) fail('CONSTRAINT_LEDGER_DOCUMENT_INVALID')
    return doc
  }
  const write = doc => {
    mkdirSync(directory, { recursive: true })
    const file = fileOf(doc.sessionId), temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(doc, null, 1))
    renameSync(temporary, file)
    return doc
  }
  return Object.freeze({ read, write, fileOf })
}

/** Add one line. A line whose normalized text is already active is reported, not duplicated. */
export function addEntry(doc, { kind, text, source, origin = 'tool', at = new Date().toISOString(), compactionId = null }) {
  if (!KINDS.includes(kind)) fail('CONSTRAINT_KIND_INVALID')
  const clean = oneLine(text)
  if (!clean) fail('CONSTRAINT_TEXT_REQUIRED')
  if (clean.length > L.textChars) fail('CONSTRAINT_TEXT_TOO_LONG')
  const cleanSource = oneLine(source)
  if (cleanSource.length > L.sourceChars) fail('CONSTRAINT_SOURCE_TOO_LONG')
  const key = normalize(clean)
  const duplicate = doc.entries.find(entry => isActive(entry) && normalize(entry.text) === key)
  if (duplicate) return { added: false, entry: duplicate }
  const entry = { n: doc.nextN, kind, text: clean, source: cleanSource || null, origin, addedAt: at, compactionId, retired: null }
  const active = doc.entries.filter(isActive)
  // Full means refuse, never silently evict: an evicted rule is exactly the loss this plugin exists to prevent.
  if (active.length >= L.activeEntries || activeBytes(doc) + Buffer.byteLength(lineOf(entry)) + 1 > L.activeBytes) fail('CONSTRAINT_LEDGER_FULL')
  doc.entries.push(entry)
  doc.nextN += 1
  return { added: true, entry }
}

/** Retiring keeps the line and marks it; nothing is deleted. */
export function retireEntry(doc, { n, reason, at = new Date().toISOString() }) {
  const entry = doc.entries.find(row => row.n === n)
  if (!entry) fail('CONSTRAINT_NOT_FOUND')
  if (!isActive(entry)) fail('CONSTRAINT_ALREADY_RETIRED')
  const why = oneLine(reason)
  if (!why) fail('CONSTRAINT_RETIRE_REASON_REQUIRED')
  entry.retired = { reason: why.slice(0, L.textChars), at }
  return entry
}

/** The block shown after the system prompt: active lines recorded up to the last compaction. */
export function renderBlock(doc) {
  const rows = doc.entries.filter(entry => isActive(entry) && entry.n <= doc.baselineN)
  if (!rows.length) return null
  return [BLOCK_OPEN, BLOCK_HEADER, ...rows.map(lineOf), BLOCK_CLOSE].join('\n')
}

/** Read `- [KIND] text (source: x)` lines out of the summary's Standing Constraints section. */
export function parseSummarySection(text) {
  const body = String(text ?? ''), start = body.indexOf(SECTION_HEADING)
  if (start < 0) return { found: false, lines: [] }
  const rest = body.slice(start + SECTION_HEADING.length), end = rest.search(/\n##\s|\n<\/compacted-summary>/)
  const lines = []
  for (const raw of (end < 0 ? rest : rest.slice(0, end)).split('\n')) {
    const match = /^\s*(?:[-*]|\d+\.)\s*\[([^\]]+)\]\s*(.+?)\s*$/.exec(raw)
    if (!match) continue
    const kind = KIND_OF_TAG[match[1].trim().toUpperCase()] ?? KIND_OF_TAG[match[1].trim()]
    if (!kind) continue
    const source = /\s*[（(]source:\s*([^)）]+)[)）]\s*$/i.exec(match[2])
    const line = oneLine(source ? match[2].slice(0, source.index) : match[2])
    if (line) lines.push({ kind, text: line.slice(0, L.textChars), source: source ? oneLine(source[1]).slice(0, L.sourceChars) : null })
    if (lines.length >= L.compactionLines) break
  }
  return { found: true, lines }
}

const messageId = (sessionId, block) => `constraint-ledger:${hash(sessionId).slice(0, 16)}:${hash(block).slice(0, 16)}`
const leadingSystemCount = messages => { let index = 0; while (index < messages.length && (messages[index]?.role === 'system' || messages[index]?.role === 'developer')) index += 1; return index }

/**
 * Projection for one request. Conversation and compaction requests both get the block at the same position;
 * a compaction request additionally gets the addendum on its final instruction message.
 */
export function projectRequest(options, doc, { collect = true } = {}) {
  const unchanged = (status, extra = {}) => ({ messages: options?.messages, constraintLedger: { status, ...extra } })
  if (!Array.isArray(options?.messages)) return unchanged('no-messages')
  const purpose = options.purpose ?? 'conversation'
  if (purpose !== 'conversation' && purpose !== 'compaction') return unchanged('auxiliary-unchanged')
  let messages = options.messages, status = 'unchanged'
  const block = renderBlock(doc)
  if (block) {
    const id = messageId(doc.sessionId, block)
    if (!messages.some(message => message?.id === id)) {
      const at = leadingSystemCount(messages)
      const message = { id, role: 'user', source: { kind: 'constraint-ledger', plugin: name, summary: 'Standing constraints carried verbatim' }, content: [{ type: 'text', text: block }] }
      messages = [...messages.slice(0, at), message, ...messages.slice(at)]
      status = 'block-inserted'
    } else status = 'block-present'
  }
  let addendum = false
  if (purpose === 'compaction' && collect) {
    const last = messages[messages.length - 1], index = Array.isArray(last?.content) ? last.content.findLastIndex(part => part?.type === 'text' && typeof part.text === 'string') : -1
    // Only the native instruction is amended; an unfamiliar final message is left alone.
    if (last?.role === 'user' && index >= 0 && last.content[index].text.includes(COMPACTION_MARK) && !last.content[index].text.includes(SECTION_HEADING)) {
      const pending = doc.entries.filter(entry => isActive(entry) && entry.n > doc.baselineN).map(lineOf)
      const extra = COMPACTION_ADDENDUM + (pending.length ? '\n\n' + [PENDING_HEADER, ...pending].join('\n') : '')
      const content = last.content.map((part, at) => at === index ? { ...part, text: part.text + '\n' + extra } : part)
      messages = [...messages.slice(0, -1), { ...last, content }]
      addendum = true
    }
  }
  if (messages === options.messages) return unchanged(status, { baselineN: doc.baselineN })
  return { messages, constraintLedger: { status, addendum, baselineN: doc.baselineN, blockBytes: block ? Buffer.byteLength(block) : 0 } }
}

export function createConstraintLedgerService(config = {}) {
  const directory = config.directory ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'constraint-ledger') : null)
  const store = createConstraintStore(directory)
  const collect = config.collectAtCompaction !== false
  const staged = new Map()
  const result = value => ({ ok: true, ...value })
  const refusal = error => ({ ok: false, code: error?.code ?? 'CONSTRAINT_LEDGER_UNAVAILABLE' })

  const note = (sessionId, args = {}) => {
    try {
      const doc = store.read(sessionId)
      if (args.action === 'list') return result({ active: doc.entries.filter(isActive).map(lineOf), retired: doc.entries.filter(entry => !isActive(entry)).map(entry => `${lineOf(entry)} — retired: ${entry.retired.reason}`), limits: L })
      if (args.action === 'add') {
        const { added, entry } = addEntry(doc, { kind: args.kind, text: args.text, source: args.source })
        if (added) store.write(doc)
        return result({ added, line: lineOf(entry) })
      }
      if (args.action === 'retire') {
        const entry = retireEntry(doc, { n: args.n, reason: args.reason })
        store.write(doc)
        return result({ retired: lineOf(entry), reason: entry.retired.reason })
      }
      return fail('CONSTRAINT_ACTION_INVALID')
    } catch (error) { return refusal(error) }
  }

  const project = options => {
    try {
      if (typeof options?.sessionId !== 'string') return { messages: options?.messages, constraintLedger: { status: 'no-session' } }
      return projectRequest(options, store.read(options.sessionId), { collect })
    } catch (error) { return { messages: options?.messages, constraintLedger: { status: 'failed-open', code: error?.code ?? 'CONSTRAINT_LEDGER_UNAVAILABLE' } } }
  }

  /** Session events: stage the summary's lines, commit them and move the baseline when the compaction ends. */
  const onSessionEvent = (session, event) => {
    try {
      const sessionId = String(session?.id ?? ''), compactionId = event?.data?.compactionId
      if (!sessionId || typeof compactionId !== 'string') return null
      if (event.type === 'compaction/summary') {
        const text = (Array.isArray(event.data.summary) ? event.data.summary : []).map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
        staged.set(sessionId, { compactionId, parsed: collect ? parseSummarySection(text) : { found: false, lines: [] } })
        return { staged: staged.get(sessionId).parsed.lines.length }
      }
      if (event.type !== 'compaction/end') return null
      const pending = staged.get(sessionId)
      staged.delete(sessionId)
      const doc = store.read(sessionId)
      let added = 0, skipped = 0
      if (pending?.compactionId === compactionId) for (const line of pending.parsed.lines) {
        try { if (addEntry(doc, { ...line, origin: 'compaction', compactionId }).added) added += 1; else skipped += 1 } catch { skipped += 1 }
      }
      // After this compaction every recorded line is shown in the block: the history that held the tool results is gone.
      doc.baselineN = doc.nextN - 1
      doc.baselineCompactionId = compactionId
      if (doc.entries.length || added) store.write(doc)
      return { added, skipped, baselineN: doc.baselineN, sectionFound: pending?.parsed.found === true }
    } catch { return null }
  }

  /**
   * The native compaction request ends with an instruction message that has no id, so the projection layer skips the
   * whole request as unrecognized. It is amended here instead, in place, from the llm/stream hook.
   */
  const prepareCompaction = options => {
    try {
      if (options?.purpose !== 'compaction') return false
      const projected = project(options)
      if (projected.messages === options.messages) return false
      options.messages = projected.messages
      return options.messages === projected.messages
    } catch { return false }
  }

  return Object.freeze({ note, project, prepareCompaction, onSessionEvent, read: sessionId => store.read(sessionId), limits: L, directory })
}

// dsh-tools takes the property map itself; a missing or unknown action is refused by the service.
const toolParameters = {
  action: { type: 'string', enum: ['add', 'retire', 'list'] },
  kind: { type: 'string', enum: [...KINDS], description: 'add: unusable = a tool or command confirmed not to work (say what to use instead); forbidden = an action the user or the lead explicitly ruled out; wontfix = an issue ruled a known limitation that must not be fixed.' },
  text: { type: 'string', description: 'add: the rule in one line, with exact identifiers.' },
  source: { type: 'string', description: 'add: optional locator of where the rule was decided.' },
  n: { type: 'integer', description: 'retire: the number of the line.' },
  reason: { type: 'string', description: 'retire: why the rule no longer holds.' },
}
const toolDescription = 'Record a standing constraint so it survives compaction verbatim. Use it the moment a tool or command is confirmed unusable, the user or the lead rules an action out, or an issue is ruled a known limitation that must not be fixed. One line each; not for progress, facts or conclusions. A full ledger refuses new lines until one is retired. Check ok in the result.'

export function apply(ctx, config = {}) {
  const service = createConstraintLedgerService(config)
  const installed = new Map(), disposers = []
  const install = agent => {
    if (installed.has(agent) || typeof agent?.ctx?.tools?.register !== 'function') return
    installed.set(agent, agent.ctx.tools.register(defineTool({ name: 'constraint_note', description: toolDescription, parameters: toolParameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: args => service.note(String(agent.session?.id ?? ''), args) })))
  }
  for (const agent of ctx.agents.list()) install(agent)
  disposers.push(ctx.on('agent/created', ({ agent }) => install(agent)))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent) }))
  disposers.push(ctx.on('session/event', (session, event) => { service.onSessionEvent(session, event) }))
  disposers.push(ctx.on('llm/stream', (options, next) => { service.prepareCompaction(options); return next() }))
  // Last among the projections, so the transforms that account for history messages never see the synthetic one.
  disposers.push(ctx.requestMessageProjection.register(name, service.project, { order: 90, preview: service.project }))
  disposers.push(ctx.provide('constraintLedger', service))
  const dispose = () => { for (const stop of installed.values()) stop?.(); installed.clear(); for (const stop of disposers.reverse()) stop?.() }
  ctx.effect(() => dispose)
  dispose.service = service
  return dispose
}
