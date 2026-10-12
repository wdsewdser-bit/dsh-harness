import fs from 'node:fs'
import { Context } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SessionId } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
const R = process.argv[2]
const backend = new JsonlSessionPersistence(new Context(), { root: R + '/home/sessions', compression: 'zstd' })
const root = R + '/home/sessions'
for (const dir of fs.readdirSync(root)) { if (!fs.statSync(root + '/' + dir).isDirectory()) continue
  for (const sid of fs.readdirSync(root + '/' + dir).filter(n => /^(session-)?[0-9a-f]{8}-[0-9a-f-]{27}$/.test(n))) {
    const h = await backend.open(SessionId(sid), 'read')
    try { const { events } = await h.read()
      const pending = new Map(), seq = []; let comp = 0, detail = []
      for (const e of events) {
        if (e.type === 'compaction/end') { comp++; seq.push('|C|') }
        if (e.type === 'tool/call' && e.data.name === 'constraint_note') pending.set(e.data.callId, e.data.arguments)
        if (e.type === 'tool/result') { const m = JSON.stringify(e.data).match(/"callId":"([^"]+)"/); if (!m || !pending.has(m[1])) continue
          const t = (e.data.message?.content ?? []).map(p => p.text ?? '').join('')
          const args = String(pending.get(m[1])); let a = {}; try { a = JSON.parse(args) } catch {}
          const code = /TEXT_TOO_LONG/.test(t) ? 'T' + (a.text?.length ?? '?') : /SOURCE_TOO_LONG/.test(t) ? 'S' + (a.source?.length ?? '?') : /LEDGER_FULL/.test(t) ? 'FULL' : /HOST_PENDING/.test(t) ? 'PEND' : /"added":true/.test(t) ? '+' : /"retired"/.test(t) ? '-' : /"active"/.test(t) ? 'L' : '?' + t.slice(0, 40)
          seq.push(code); if (code === 'FULL' || code === 'PEND') detail.push(code + ' args ' + args.replace(/\s+/g, ' ').slice(0, 260)) } }
      if (seq.some(x => x !== '|C|')) console.log(sid.replace('session-', '').slice(0, 8), seq.join(' ')); for (const d of detail) console.log('    ' + d)
    } finally { await h.close() } } }
