// usage: node team-tail.mjs <root> <sid-fragment>...   Read-only: last events of matching sessions plus constraint_note results.
import fs from 'node:fs'
import { Context } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SessionId } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'

const R = process.argv[2], wanted = process.argv.slice(3)
const one = (value, max) => String(typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const backend = new JsonlSessionPersistence(new Context(), { root: R + '/home/sessions', compression: 'zstd' })
const root = R + '/home/sessions'
const noteResults = {}
for (const dir of fs.readdirSync(root)) {
  if (!fs.statSync(root + '/' + dir).isDirectory()) continue
  for (const sid of fs.readdirSync(root + '/' + dir).filter(name => /^(session-)?[0-9a-f]{8}-[0-9a-f-]{27}$/.test(name))) {
    const handle = await backend.open(SessionId(sid), 'read')
    try {
      const { events } = await handle.read()
      const noteCalls = new Set()
      for (const event of events) {
        if (event.type === 'tool/call' && event.data.name === 'constraint_note') noteCalls.add(event.data.id ?? event.data.callId)
        if (event.type === 'tool/result' && (noteCalls.has(event.data.id ?? event.data.callId) || event.data.name === 'constraint_note')) {
          const text = one(event.data.result ?? event.data.content ?? event.data, 160)
          const key = /ok|added|retired|recorded/i.test(text) && !/error|reject|full|limit/i.test(text) ? 'accepted' : 'other: ' + text
          noteResults[key] = (noteResults[key] ?? 0) + 1
        }
      }
      if (!wanted.some(fragment => sid.includes(fragment))) continue
      console.log('\n## ' + sid + ' events ' + events.length)
      const ends = events.filter(event => event.type === 'turn/end')
      console.log('turn/end kinds ' + JSON.stringify(ends.map(event => event.data?.reason?.kind)))
      console.log('last turn/end ' + one(ends.at(-1)?.data, 700))
      for (const event of events.slice(-8)) console.log('  ' + event.type + ' ' + one(event.data, 420))
    } finally { await handle.close() }
  }
}
console.log('\nconstraint_note results ' + JSON.stringify(noteResults, null, 1))
