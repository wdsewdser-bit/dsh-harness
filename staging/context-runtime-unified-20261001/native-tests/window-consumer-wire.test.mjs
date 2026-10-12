import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Session, KNOWN_SESSION_EVENT_TYPES } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { isSurfaceEvent } from '../app/node_modules/@deepseek-ai/dsh-session/lib/types/surface.js'
import { apply as applyLog } from '../app/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js'
import { apply as applySplitLog } from '../app/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/types/index.js'

const source = name => readFileSync(new URL('../app/node_modules/@deepseek-ai/' + name + '/lib/client.js', import.meta.url), 'utf8')
function region(text, marker) {
  const start = text.indexOf('//#region ' + marker)
  const end = text.indexOf('//#endregion', start)
  assert.ok(start >= 0 && end > start, marker)
  return text.slice(start, end)
}
const apiSource = source('dsh-api-session-controller')
const assertWire = new Function('KNOWN_SESSION_EVENT_TYPES',
  region(apiSource, '../../core/session/lib/types/surface.js')
  + region(apiSource, 'lib/types/client/session-wire-event.js') + ';return assertSessionWireEvent;')(KNOWN_SESSION_EVENT_TYPES)
const inspect = new Function('isSurfaceEvent', region(source('dsh-client-ui-conversation'),
  'lib/types/client/contract/system-prompt.js') + ';return inspectSystemPrompt;')(isSurfaceEvent)
const message = (id, role = 'user', window = false) => ({ id, role, content: [{ type: 'text', text: id }],
  source: { kind: 'user', ...(window ? { windowCommit: { transitionId: id, toWindowId: 1 } } : {}) } })
const range = (startSeq, endSeq = startSeq) => ({ startSeq, endSeq })
function fixture() {
  const session = Session.create('wire-window')
  session.append('system/message', { message: message('root-system', 'system') }, { surfaceOp: 'append' })
  const events = Array.from({ length: 6 }, (_, index) => index % 2 === 0
    ? session.append('system/message', { message: message('system-' + index, 'system') }, { surfaceOp: 'append' })
    : session.append('user/message', message('user-' + index), { surfaceOp: 'append' }))
  const window = session.append('user/message', message('checkpoint', 'user', true), {
    surfaceOp: { op: 'replace-many', ranges: [range(events[0].seq, events[1].seq), range(events[4].seq, events[5].seq)] },
    sourceEventSeqs: [events[0].seq, events[1].seq, events[4].seq, events[5].seq] })
  return { session, events, window }
}

test('actual browser history and follow-frame parser accepts native many metadata without normalization', () => {
  const { session, window } = fixture()
  for (const event of session.snapshotEvents()) assert.doesNotThrow(() => assertWire(event))
  const raw = JSON.parse(JSON.stringify(window))
  assertWire(raw)
  assert.deepEqual(raw.surfaceOp, window.surfaceOp)
  assert.deepEqual(raw.sourceEventSeqs, window.sourceEventSeqs)
})

test('browser parser retains exact metadata restrictions for malformed and unmarked many events', () => {
  const { window } = fixture()
  const bad = [
    { ...window, surfaceOp: { ...window.surfaceOp, extra: true } },
    { ...window, data: { ...window.data, source: { kind: 'user' } } },
    { ...window, surfaceOp: { op: 'replace-many', ranges: [range(0)] } },
    { ...window, surfaceOp: { op: 'replace-many', ranges: [range(0), range(window.seq)] } },
    { ...window, surfaceOp: { op: 'replace-many', ranges: [range(0), { ...range(4), extra: true }] } },
    { ...window, surfaceOp: { op: 'replace-many', ranges: [range(0), range(-0)] } },
    { ...window, surfaceOp: { op: 'replace-many', ranges: [range(0), undefined] } },
    { ...window, sourceEventSeqs: [0, window.seq] },
  ]
  for (const event of bad) assert.throws(() => assertWire(event))
})

test('browser system-prompt interpretation retains gap prompts and inherited checkpoint positions', () => {
  const { session, window, events } = fixture()
  let state
  for (const event of session.snapshotEvents()) state = inspect(state, event)
  assert.equal(state.uncertain, false)
  assert.equal(state.effective.text, 'system-2')
  assert.deepEqual(state.nodes.map(row => row.node.seq), [0, events[2].seq])
  assert.equal(state.replacements.get(window.seq), events[0].seq)
  const follow = session.append('user/message', message('follow'), {
    surfaceOp: { op: 'replace', ...range(window.seq, events[2].seq) }, sourceEventSeqs: [window.seq, events[2].seq] })
  state = inspect(state, follow)
  assert.equal(state.effective.text, 'root-system')
  assert.deepEqual(state.nodes.map(row => row.node.seq), [0])
})

test('browser partial history with any unknown earlier many endpoint withholds its system prompt', () => {
  const { window } = fixture()
  const partial = inspect(undefined, { ...window, seq: 100,
    surfaceOp: { op: 'replace-many', ranges: [range(20, 25), range(50, 55)] } })
  assert.equal(partial.uncertain, true)
  assert.equal(partial.effective, undefined)
})

test('actual bundled and split session-log contributors serialize all many ranges losslessly', () => {
  const { session, window } = fixture()
  for (const apply of [applyLog, applySplitLog]) {
    let extension
    apply({ sessions: { get: id => id === session.id ? session : undefined }, logger: { warn: message => assert.fail(message) },
      deepseekLlmApiExtensions: { register: (name, value) => { assert.equal(name, 'dsh_session_log'); extension = value } } },
    { enabled: true, maxBytes: 8 * 1024 * 1024 })
    const contribution = extension.prepare({ sessionId: session.id })
    const parsed = JSON.parse(JSON.stringify(contribution.value))
    const serialized = parsed.events.find(row => row.seq === window.seq)
    assert.deepEqual(serialized.surfaceOp, window.surfaceOp)
    assert.deepEqual(serialized.sourceEventSeqs, window.sourceEventSeqs)
    assert.equal(parsed.throughSeq, window.seq)
    assert.equal(serialized.surfaceOp.ranges.length, 2)
  }
})
