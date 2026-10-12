import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, addEntry, retireEntry, renderBlock, parseSummarySection, projectRequest, createConstraintStore, createConstraintLedgerService,
  CONSTRAINT_LEDGER_LIMITS, COMPACTION_ADDENDUM, SECTION_HEADING, BLOCK_OPEN } from '../home/profiles/web/plugins/constraint-ledger.mjs'

const SID = 'session-00000000-0000-4000-8000-000000000001'
const directory = t => { const root = mkdtempSync(join(tmpdir(), 'constraint-ledger-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
const text = value => ({ type: 'text', text: value })
const system = { id: 's', role: 'system', content: [text('system prompt')] }
const user = (id, value) => ({ id, role: 'user', source: { kind: 'user' }, content: [text(value)] })
const NATIVE_INSTRUCTION = 'Summarize.\n\n## Next Step\n- x\n\n## Critical Context\n- y\n\nRules:\n- Output only the checkpoint text.'
const end = (service, compactionId, summary) => {
  const session = { id: SID }
  service.onSessionEvent(session, { type: 'compaction/summary', data: { compactionId, summary: [text(summary)] } })
  return service.onSessionEvent(session, { type: 'compaction/end', data: { compactionId } })
}

test('a recorded line is stored, deduplicated by normalized text, and survives a reload', t => {
  const root = directory(t), service = createConstraintLedgerService({ directory: root })
  const first = service.note(SID, { action: 'add', kind: 'unusable', text: '`team_delivery_check`  returns a schema error; read the boards instead.', source: 'msg 002' })
  assert.equal(first.ok, true); assert.equal(first.added, true)
  assert.match(first.line, /^1\. \[UNUSABLE\] `team_delivery_check` returns a schema error; read the boards instead\. \(source: msg 002\)$/)
  const again = service.note(SID, { action: 'add', kind: 'unusable', text: 'team_delivery_check returns a schema error; read the boards instead' })
  assert.equal(again.added, false, 'same rule reworded only in punctuation is not a second line')
  assert.equal(service.note(SID, { action: 'add', kind: 'unusable', text: '`team_delivery_check` returns a schema error -> read the boards instead' }).added, false, 'nor in arrows and code quoting')
  const reloaded = createConstraintLedgerService({ directory: root }).note(SID, { action: 'list' })
  assert.equal(reloaded.active.length, 1)
  assert.deepEqual(readdirSync(root), [SID + '.json'], 'no temporary file is left behind')
})

test('invalid input is refused with a code and writes nothing', t => {
  const root = directory(t), service = createConstraintLedgerService({ directory: root })
  assert.deepEqual(service.note(SID, { action: 'add', kind: 'progress', text: 'x' }), { ok: false, code: 'CONSTRAINT_KIND_INVALID' })
  assert.deepEqual(service.note(SID, { action: 'add', kind: 'forbidden', text: '   ' }), { ok: false, code: 'CONSTRAINT_TEXT_REQUIRED' })
  assert.deepEqual(service.note(SID, { action: 'add', kind: 'forbidden', text: 'x'.repeat(CONSTRAINT_LEDGER_LIMITS.textChars + 1) }), { ok: false, code: 'CONSTRAINT_TEXT_TOO_LONG' })
  assert.deepEqual(service.note(SID, { action: 'retire', n: 3, reason: 'gone' }), { ok: false, code: 'CONSTRAINT_NOT_FOUND' })
  assert.deepEqual(service.note('../escape', { action: 'list' }), { ok: false, code: 'CONSTRAINT_LEDGER_SESSION_ID_INVALID' })
  assert.deepEqual(service.note(SID, { action: 'drop' }), { ok: false, code: 'CONSTRAINT_ACTION_INVALID' })
  assert.deepEqual(readdirSync(root), [])
})

test('a full ledger refuses a new line instead of evicting an old one, and retiring frees room without deleting', t => {
  const store = createConstraintStore(directory(t)), doc = store.read(SID)
  for (let index = 0; index < CONSTRAINT_LEDGER_LIMITS.activeEntries; index += 1) addEntry(doc, { kind: 'forbidden', text: 'rule number ' + index })
  assert.throws(() => addEntry(doc, { kind: 'forbidden', text: 'one too many' }), { code: 'CONSTRAINT_LEDGER_FULL' })
  assert.equal(doc.entries.length, CONSTRAINT_LEDGER_LIMITS.activeEntries)
  assert.throws(() => retireEntry(doc, { n: 1, reason: ' ' }), { code: 'CONSTRAINT_RETIRE_REASON_REQUIRED' })
  retireEntry(doc, { n: 1, reason: 'the user lifted it' })
  assert.throws(() => retireEntry(doc, { n: 1, reason: 'again' }), { code: 'CONSTRAINT_ALREADY_RETIRED' })
  assert.equal(addEntry(doc, { kind: 'forbidden', text: 'one too many' }).added, true)
  assert.equal(doc.entries.length, CONSTRAINT_LEDGER_LIMITS.activeEntries + 1, 'the retired line is kept')
})

test('the ledger is capped by characters, not bytes: fourteen long Chinese rules fit, and the line that would pass 8000 characters is refused', t => {
  const doc = createConstraintStore(directory(t)).read(SID)
  const chinese = index => ({ kind: 'wontfix', text: String(index).padStart(2, '0') + '商'.repeat(288) })
  const charsOf = entry => `${entry.n}. [WONTFIX] ${entry.text}`.length + 1
  const used = () => doc.entries.reduce((sum, entry) => sum + charsOf(entry), 0)
  for (let index = 0; index < 14; index += 1) addEntry(doc, chinese(index))
  assert.equal(doc.entries.length, 14, 'fourteen rules of about 290 characters each are all accepted')
  assert.ok(Buffer.byteLength(doc.entries.map(entry => `${entry.n}. [WONTFIX] ${entry.text}`).join('\n')) > 4096, 'the same rules are over 4096 bytes, so a byte cap would have refused them')
  assert.ok(used() < CONSTRAINT_LEDGER_LIMITS.activeChars)
  let refused = null
  for (let index = 14; refused === null; index += 1) {
    try { addEntry(doc, chinese(index)) } catch (error) { refused = { index, error } }
  }
  assert.equal(refused.error.code, 'CONSTRAINT_LEDGER_FULL')
  assert.ok(doc.entries.length < CONSTRAINT_LEDGER_LIMITS.activeEntries, 'the character cap, not the entry cap, refused it')
  assert.ok(used() <= CONSTRAINT_LEDGER_LIMITS.activeChars, 'what is recorded stays within 8000 characters')
  assert.ok(used() + charsOf({ n: doc.nextN, text: chinese(refused.index).text }) > CONSTRAINT_LEDGER_LIMITS.activeChars, 'and the refused line would have passed it')
})

test('a full ledger returns the active lines and a hint, and retiring one line makes room for the next add', t => {
  const service = createConstraintLedgerService({ directory: directory(t) })
  for (let index = 0; index < CONSTRAINT_LEDGER_LIMITS.activeEntries; index += 1) assert.equal(service.note(SID, { action: 'add', kind: 'forbidden', text: 'rule number ' + index }).ok, true)
  const full = service.note(SID, { action: 'add', kind: 'forbidden', text: 'one too many' })
  assert.equal(full.ok, false); assert.equal(full.code, 'CONSTRAINT_LEDGER_FULL')
  assert.equal(full.active.length, CONSTRAINT_LEDGER_LIMITS.activeEntries)
  assert.equal(full.active[0], '1. [FORBIDDEN] rule number 0')
  assert.deepEqual(full.active, service.note(SID, { action: 'list' }).active, 'the same format as list')
  assert.ok(full.hint.length > 0 && /retire/.test(full.hint))
  assert.equal(service.note(SID, { action: 'retire', n: 1, reason: 'merged into rule 2' }).ok, true)
  assert.equal(service.note(SID, { action: 'add', kind: 'forbidden', text: 'one too many' }).added, true)
  assert.equal(service.note(SID, { action: 'list' }).active.length, CONSTRAINT_LEDGER_LIMITS.activeEntries, 'one line retired and one added: still forty active')
})

test('lines recorded before any compaction are not inserted: they are still in the history as tool results', t => {
  const service = createConstraintLedgerService({ directory: directory(t) })
  service.note(SID, { action: 'add', kind: 'forbidden', text: 'never lower the difficulty' })
  const options = { sessionId: SID, messages: [system, user('u1', 'hi')] }
  const result = service.project(options)
  assert.equal(result.messages, options.messages, 'the request is untouched, so its cached prefix still matches')
  assert.equal(result.constraintLedger.status, 'unchanged')
})

test('after a compaction the block sits right after the system prompt, identically on every request', t => {
  const service = createConstraintLedgerService({ directory: directory(t) })
  service.note(SID, { action: 'add', kind: 'forbidden', text: 'never lower the difficulty' })
  assert.deepEqual(end(service, 'c1', '## Critical Context\n- nothing'), { added: 0, skipped: 0, baselineN: 1, sectionFound: false })
  const checkpoint = user('cp', '<compacted-summary>…</compacted-summary>')
  const first = service.project({ sessionId: SID, messages: [system, checkpoint, user('u2', 'next')] })
  assert.deepEqual(first.messages.map(message => message.role + ':' + (message.source?.kind ?? '')), ['system:', 'user:constraint-ledger', 'user:user', 'user:user'])
  assert.match(first.messages[1].content[0].text, new RegExp('^' + BLOCK_OPEN + '\\n.+\\n1\\. \\[FORBIDDEN\\] never lower the difficulty\\n</standing-constraints>$', 's'))
  // A line recorded after the compaction does not disturb the block until the next compaction.
  service.note(SID, { action: 'add', kind: 'wontfix', text: 'monsters path through closed doors' })
  const second = service.project({ sessionId: SID, messages: [system, checkpoint, user('u2', 'next'), user('u3', 'more')] })
  assert.deepEqual(second.messages[1], first.messages[1], 'byte-identical block and id keep the prefix cacheable')
  const replay = service.project({ sessionId: SID, messages: second.messages })
  assert.equal(replay.messages, second.messages, 'a request that already carries the block is not given a second one')
  assert.equal(replay.constraintLedger.status, 'block-present')
})

test('a compaction request gets the same block and the addendum on the native instruction only', t => {
  const service = createConstraintLedgerService({ directory: directory(t) })
  service.note(SID, { action: 'add', kind: 'unusable', text: 'tool A is broken; use B' })
  end(service, 'c1', 'no section')
  const history = [system, user('u1', 'hi')]
  const conversation = service.project({ sessionId: SID, messages: history })
  const instruction = { role: 'user', content: [text(NATIVE_INSTRUCTION)] }
  const compaction = service.project({ sessionId: SID, purpose: 'compaction', messages: [...history, instruction] })
  assert.deepEqual(compaction.messages.slice(0, 3), conversation.messages, 'the replayed prefix equals the conversation prefix')
  assert.equal(compaction.messages.at(-1).content[0].text, NATIVE_INSTRUCTION + '\n' + COMPACTION_ADDENDUM)
  assert.equal(instruction.content[0].text, NATIVE_INSTRUCTION, 'the input message is not mutated')
  assert.equal(compaction.constraintLedger.addendum, true)
  // A line recorded since the last compaction is not in the block yet; the summarizer is shown it so it is not listed again.
  service.note(SID, { action: 'add', kind: 'forbidden', text: 'never read b.txt', source: 'user' })
  const pending = service.project({ sessionId: SID, purpose: 'compaction', messages: [...history, instruction] })
  assert.ok(pending.messages.at(-1).content[0].text.endsWith(COMPACTION_ADDENDUM + '\n\nAlready recorded by constraint_note and carried separately. Do not list these again in any wording or language:\n2. [FORBIDDEN] never read b.txt (source: user)'))
  assert.deepEqual(pending.messages.slice(0, 3), conversation.messages, 'and the prefix is still the cached one')
  const unfamiliar = service.project({ sessionId: SID, purpose: 'compaction', messages: [...history, user('x', 'please summarize')] })
  assert.equal(unfamiliar.messages.at(-1).content[0].text, 'please summarize', 'an instruction this plugin does not recognise is left alone')
  const off = createConstraintLedgerService({ directory: service.directory, collectAtCompaction: false })
  assert.equal(off.project({ sessionId: SID, purpose: 'compaction', messages: [...history, instruction] }).messages.at(-1), instruction)
  const auxiliary = { sessionId: SID, purpose: 'title', messages: history }
  assert.equal(service.project(auxiliary).messages, history, 'other request purposes are untouched')
})

test('the summary section is parsed strictly and merged without duplicating what is already recorded', t => {
  const summary = ['## Critical Context', '- [FORBIDDEN] this bracket is outside the section and is ignored', '', SECTION_HEADING,
    '- [UNUSABLE] `node --test tests/` is broken on Node v24 -> run `node --test` at the repo root (source: msg 057)',
    '- [FORBIDDEN] never lower the difficulty.', '* [WONTFIX] monsters path through unlocked closed doors', '- [不修] 商店硬编码 20 不改',
    '- [PROGRESS] milestone 9 done', '- (none)', 'free text line', '## Another Section', '- [FORBIDDEN] after the section'].join('\n')
  const parsed = parseSummarySection(summary)
  assert.equal(parsed.found, true)
  assert.deepEqual(parsed.lines, [
    { kind: 'unusable', text: '`node --test tests/` is broken on Node v24 -> run `node --test` at the repo root', source: 'msg 057' },
    { kind: 'forbidden', text: 'never lower the difficulty.', source: null },
    { kind: 'wontfix', text: 'monsters path through unlocked closed doors', source: null },
    { kind: 'wontfix', text: '商店硬编码 20 不改', source: null }])
  assert.deepEqual(parseSummarySection('## Critical Context\n- x'), { found: false, lines: [], dropped: 0 })
  assert.equal(parsed.dropped, 0, 'nothing in this summary is marked as a repeat')
  const service = createConstraintLedgerService({ directory: directory(t) })
  service.note(SID, { action: 'add', kind: 'forbidden', text: 'Never lower the difficulty' })
  assert.deepEqual(end(service, 'c1', summary), { added: 3, skipped: 1, baselineN: 4, sectionFound: true })
  const doc = service.read(SID)
  assert.deepEqual(doc.entries.map(entry => entry.origin), ['tool', 'compaction', 'compaction', 'compaction'])
  assert.equal(doc.baselineCompactionId, 'c1')
  assert.equal(renderBlock(doc).split('\n').length, 7, 'open tag, header, four lines, close tag')
})

test('a summary line marked as a repeat is dropped and counted, and not staged; the same-as wording inside a rule is kept', t => {
  const summary = [SECTION_HEADING,
    '- [FORBIDDEN] never lower the difficulty (same as 3)',
    '- [FORBIDDEN] never lower the difficulty. (Same as 12).',
    '- [UNUSABLE] tool A is broken -> use B (already recorded)',
    '- [WONTFIX] Monsters path through doors (ALREADY RECORDED)   ',
    '- [FORBIDDEN] keep the shop at 20 (same as 3) (source: msg 4)',
    '- [WONTFIX] results are the same as 3 runs before and must not change',
    '- [FORBIDDEN] run `node --test` at the repo root (source: msg 2)'].join('\n')
  const parsed = parseSummarySection(summary)
  assert.equal(parsed.dropped, 5, 'the five marked lines are counted')
  assert.deepEqual(parsed.lines, [
    { kind: 'wontfix', text: 'results are the same as 3 runs before and must not change', source: null },
    { kind: 'forbidden', text: 'run `node --test` at the repo root', source: 'msg 2' }])
  const service = createConstraintLedgerService({ directory: directory(t) })
  assert.deepEqual(end(service, 'c1', summary), { added: 2, skipped: 0, baselineN: 2, sectionFound: true })
  assert.deepEqual(service.read(SID).entries.map(entry => entry.text), ['results are the same as 3 runs before and must not change', 'run `node --test` at the repo root'])
})

test('the summarizer is told a possible repeat gets a same-as mark', () => {
  assert.match(COMPACTION_ADDENDUM, /you may still list it, but end it with " \(same as N\)", where N is that line's number/)
})

test('a summary staged for one compaction is not committed by the end of another', t => {
  const service = createConstraintLedgerService({ directory: directory(t) }), session = { id: SID }
  service.onSessionEvent(session, { type: 'compaction/summary', data: { compactionId: 'c1', summary: [text(SECTION_HEADING + '\n- [FORBIDDEN] stale')] } })
  assert.deepEqual(service.onSessionEvent(session, { type: 'compaction/end', data: { compactionId: 'c2' } }), { added: 0, skipped: 0, baselineN: 0, sectionFound: true })
  assert.equal(service.read(SID).entries.length, 0)
  assert.equal(service.onSessionEvent(session, { type: 'turn/end', data: {} }), null)
})

test('a retired line leaves the block and a damaged document fails open', t => {
  const root = directory(t), service = createConstraintLedgerService({ directory: root })
  service.note(SID, { action: 'add', kind: 'forbidden', text: 'rule one' }); service.note(SID, { action: 'add', kind: 'forbidden', text: 'rule two' })
  end(service, 'c1', '')
  assert.equal(service.note(SID, { action: 'retire', n: 1, reason: 'lifted by the user' }).ok, true)
  const block = service.project({ sessionId: SID, messages: [system] }).messages[1].content[0].text
  assert.ok(!block.includes('rule one') && block.includes('2. [FORBIDDEN] rule two'), 'numbers are stable; the retired line is gone from the block')
  assert.match(service.note(SID, { action: 'list' }).retired[0], /rule one — retired: lifted by the user$/)
  const store = createConstraintStore(root)
  const damaged = JSON.parse(readFileSync(store.fileOf(SID), 'utf8')); damaged.sessionId = 'someone-else'; store.write({ ...damaged, sessionId: SID, schemaVersion: 2 })
  const options = { sessionId: SID, messages: [system] }, failed = service.project(options)
  assert.equal(failed.messages, options.messages)
  assert.deepEqual(failed.constraintLedger, { status: 'failed-open', code: 'CONSTRAINT_LEDGER_DOCUMENT_INVALID' })
  assert.deepEqual(projectRequest({ messages: null }, store.read('session-other')).constraintLedger, { status: 'no-messages' })
})

test('apply wires the tool per agent, the session events and one projection, and undoes all of it', async t => {
  const root = directory(t), handlers = new Map(), registered = [], provided = []
  const agent = id => { const tools = []; return { session: { id }, tools, ctx: { tools: { register: tool => { tools.push(tool); return () => tools.splice(tools.indexOf(tool), 1) } } } } }
  const first = agent(SID), late = agent('session-late')
  const ctx = { agents: { list: () => [first] }, on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
    requestMessageProjection: { register: (id, transform, options) => { registered.push({ id, transform, options }); return () => registered.splice(0) } },
    provide: (key, service) => { provided.push(key); return () => provided.splice(0) }, effect: () => {} }
  const dispose = apply(ctx, { directory: root })
  assert.deepEqual(registered.map(row => [row.id, row.options.order]), [['constraint-ledger', 90]])
  assert.deepEqual(provided, ['constraintLedger'])
  assert.equal(first.tools[0].name, 'constraint_note')
  handlers.get('agent/created')({ agent: late })
  assert.equal(late.tools.length, 1)
  const made = await first.tools[0].execute({ action: 'add', kind: 'forbidden', text: 'tier 0 talks to tier 1 only' })
  assert.equal(made.added, true)
  assert.equal((await late.tools[0].execute({ action: 'list' })).active.length, 0, 'each session has its own ledger')
  handlers.get('session/event')({ id: SID }, { type: 'compaction/summary', data: { compactionId: 'c1', summary: [text('x')] } })
  handlers.get('session/event')({ id: SID }, { type: 'compaction/end', data: { compactionId: 'c1' } })
  assert.equal(registered[0].transform({ sessionId: SID, messages: [system] }).messages.length, 2)
  // The native compaction request: frozen messages, the final instruction without id or source.
  const request = { sessionId: SID, purpose: 'compaction', messages: [system, user('u1', 'hi'), Object.freeze({ role: 'user', content: [text('Summarize.\n## Critical Context\n- …')] })] }
  let reached = 0
  assert.equal(handlers.get('llm/stream')(request, () => { reached += 1; return 'stream' }), 'stream')
  assert.equal(reached, 1)
  assert.deepEqual(request.messages.map(message => message.source?.kind ?? 'instruction'), ['instruction', 'constraint-ledger', 'user', 'instruction'])
  assert.ok(request.messages[3].content[0].text.endsWith(COMPACTION_ADDENDUM) && request.messages[3].id === undefined)
  const amended = request.messages
  handlers.get('llm/stream')(request, () => {})
  assert.equal(request.messages, amended, 'a retried request is not amended twice')
  const other = { sessionId: SID, purpose: 'session-title', messages: [system] }, frozen = Object.freeze({ ...request, messages: [system, request.messages[3]] })
  handlers.get('llm/stream')(other, () => {}); handlers.get('llm/stream')(frozen, () => {})
  assert.equal(other.messages.length, 1); assert.equal(frozen.messages.length, 2, 'a request that cannot be amended goes out as it was')
  handlers.get('agent/disposed')({ agent: late })
  assert.equal(late.tools.length, 0)
  dispose()
  assert.equal(first.tools.length, 0); assert.equal(registered.length, 0); assert.equal(provided.length, 0); assert.equal(handlers.size, 0)
})
