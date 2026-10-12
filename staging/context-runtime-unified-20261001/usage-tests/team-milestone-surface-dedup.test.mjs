import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { hasCurrentMilestoneSnapshot } from '../home/profiles/web/plugins/team-tools-v2-r10.mjs'
import { milestoneNotice } from '../home/profiles/web/plugins/team-milestone-v2.mjs'
import { scanFrames } from '../tools/usage-history-backfill.mjs'

const record = { setAt: 123, stage: 'quoted "stage"', doneWhen: 'proof', done: false }
const snapshot = (value = record) => {
  const text = milestoneNotice(value)
  return { role: 'user', content: [{ type: 'text', text }], source: {
    kind: 'team-message', plugin: 'tool-agent-team-v2', form: 'snapshot',
    sections: [{ name: 'team:milestone', text }],
  } }
}
const surface = (message, count = 354, index = 95) => {
  const nodes = Array.from({ length: count }, (_, seq) => seq)
  const events = new Map([[index, { type: 'user/message', data: message }]])
  return { surface: { nodes }, eventAt: seq => events.get(seq),
    deriveMessages: () => { throw new Error('must not derive the full history') } }
}

test('trusted identical snapshot remains recognized beyond the 256-node tail', () => {
  assert.equal(hasCurrentMilestoneSnapshot(surface(snapshot()), record), true)
})

test('replacement or compaction removing the old node permits reinjection', () => {
  const session = surface(snapshot())
  session.surface.nodes.splice(95, 1)
  assert.equal(hasCurrentMilestoneSnapshot(session, record), false)
  session.surface.nodes = []
  assert.equal(hasCurrentMilestoneSnapshot(session, record), false)
})

test('changed marker, body, completion status, and untrusted source do not deduplicate', () => {
  for (const changed of [
    { ...record, setAt: 124 }, { ...record, stage: 'changed' },
    { ...record, doneWhen: 'changed proof' }, { ...record, done: true },
  ]) assert.equal(hasCurrentMilestoneSnapshot(surface(snapshot()), changed), false)
  for (const mutate of [
    message => { message.source.kind = 'user' },
    message => { message.source.plugin = 'other' },
    message => { message.source.form = 'notice' },
    message => { message.source.sections[0].name = 'other' },
    message => { message.source.sections[0].text += 'changed' },
    message => { message.content[0].text += 'changed' },
    message => { message.role = 'assistant' },
  ]) {
    const message = snapshot()
    mutate(message)
    assert.equal(hasCurrentMilestoneSnapshot(surface(message), record), false)
  }
})

test('pending trusted snapshots and legacy session API retain exact matching', () => {
  assert.equal(hasCurrentMilestoneSnapshot(undefined, record, [snapshot()]), true)
  assert.equal(hasCurrentMilestoneSnapshot({ deriveMessages: () => [snapshot()] }, record), true)
  assert.equal(hasCurrentMilestoneSnapshot(surface(snapshot()), undefined), false)
})

test('real root seq 69510 prevents the duplicate at seq 70686 (513 bytes)', () => {
  const journal = readFileSync('D:/dsh-test/home/sessions/--D-dsh-test-workspaces-RustMc--/session-028e6f5b-1716-4c23-a232-af16d853d191/session.v4.jsonl.zstd')
  const nodes = [], events = new Map()
  let duplicate
  scan: for (const frame of scanFrames(journal).frames) {
    const text = zstdDecompressSync(journal.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      const event = JSON.parse(line)
      if (event.seq === 70686) { duplicate = event; break scan }
      events.set(event.seq, event)
      if (event.surfaceOp === 'append') nodes.push(event.seq)
      else if (event.surfaceOp?.op === 'replace') {
        const start = nodes.indexOf(event.surfaceOp.startSeq)
        const end = nodes.indexOf(event.surfaceOp.endSeq)
        assert.ok(start >= 0 && end >= start)
        nodes.splice(start, end - start + 1, event.seq)
      }
    }
  }
  const original = events.get(69510).data
  assert.deepEqual(original.content, duplicate.data.content)
  assert.deepEqual(original.source, duplicate.data.source)
  const text = original.content[0].text
  assert.equal(Buffer.byteLength(text), 513)
  const fields = /^\[team milestone #(\d+)\] Yours: "(.*)" \(done when: (.*)\) - not ticked yet\.$/s.exec(text)
  assert.ok(fields)
  const value = { setAt: Number(fields[1]), stage: fields[2], doneWhen: fields[3], done: false }
  assert.equal(milestoneNotice(value), text)
  assert.equal(nodes.length, 354)
  assert.equal(nodes.indexOf(69510), 95)
  assert.equal(nodes.length - nodes.indexOf(69510), 259)
  assert.equal(hasCurrentMilestoneSnapshot({ surface: { nodes }, eventAt: seq => events.get(seq) }, value), true)
})
