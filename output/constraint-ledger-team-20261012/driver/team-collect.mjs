// usage: node team-collect.mjs <root> [--full]   Read-only summary of an isolated team run.
import fs from 'node:fs'
import { Context } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SessionId } from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import JsonlSessionPersistence from 'file:///D:/dsh-test/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'

const VIOLATIONS = {
  gitconfig: /git\s+config\s+(--global|--local|--system|user\.)/i,
  cdn: /https?:\/\/(cdn\.|unpkg\.com|cdnjs\.|esm\.sh|[a-z.]*jsdelivr)/i,
  'npm-install': /\bnpm\s+(i|install|add|ci)\b|\bpnpm\s+(add|install)\b|\byarn\s+(add|install)\b|\bnpx\s/i,
  browser: /playwright|puppeteer|chrome(\.exe)?["'\s]|msedge|Start-Process\s+["']?https?:|\bstart\s+https?:/i,
  'force-or-reset': /git\s+(push\s+.*--force|reset\s+--hard)/i,
}
const R = process.argv[2], full = process.argv.includes('--full')
const one = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const states = fs.readdirSync(R).filter(name => name === 'state.json' || name.endsWith('-state.json')).map(name => { const s = JSON.parse(fs.readFileSync(R + '/' + name)); return name + ':' + s.status + (s.reason ? '/' + s.reason : '') })
console.log('host', states.join(' ') || 'never started')

const usageDir = R + '/home/usage-ledger', usage = new Map()
if (fs.existsSync(usageDir)) for (const name of fs.readdirSync(usageDir).filter(name => name.startsWith('requests-'))) {
  for (const line of fs.readFileSync(usageDir + '/' + name, 'utf8').split('\n')) {
    if (!line.includes('"event":"terminal"')) continue
    let row; try { row = JSON.parse(line) } catch { continue }
    const key = row.sessionId ?? 'sessionless'
    const u = usage.get(key) ?? { requests: 0, purposes: {}, input: 0, cacheRead: 0, output: 0, compactions: [] }
    u.requests += 1; u.purposes[row.purpose] = (u.purposes[row.purpose] ?? 0) + 1
    u.input += row.usage?.inputTokens ?? 0; u.cacheRead += row.usage?.cacheReadTokens ?? 0; u.output += row.usage?.outputTokens ?? 0
    if (row.purpose === 'compaction') u.compactions.push((row.usage?.inputTokens ?? '?') + '/' + (row.usage?.cacheReadTokens ?? '?'))
    usage.set(key, u)
  }
}

const backend = new JsonlSessionPersistence(new Context(), { root: R + '/home/sessions', compression: 'zstd' })
const rows = [], unreadable = []
const sessionRoot = R + '/home/sessions'
for (const dir of fs.existsSync(sessionRoot) ? fs.readdirSync(sessionRoot) : []) {
  if (!fs.statSync(sessionRoot + '/' + dir).isDirectory()) continue
  // The lead's directory is session-<uuid>; team members' are bare uuids.
  for (const sid of fs.readdirSync(sessionRoot + '/' + dir).filter(name => /^(session-)?[0-9a-f]{8}-[0-9a-f-]{27}$/.test(name))) {
    let handle
    try { handle = await backend.open(SessionId(sid), 'read') } catch { unreadable.push(sid); continue }
    try {
      const session = await handle.read()
      const row = { sid, first: '', turns: 0, steps: 0, tools: 0, toolNames: {}, compactions: 0, end: null, notes: [], hits: {}, lastAnswer: '' }
      for (const event of session.events) {
        if (event.type === 'turn/start') row.turns += 1
        if (event.type === 'step/start') row.steps += 1
        if (event.type === 'compaction/end') row.compactions += 1
        if (event.type === 'turn/end') row.end = event.data?.reason?.kind ?? null
        if (event.type === 'user/message' && !row.first) row.first = one((event.data.content ?? []).map(part => part.text ?? '').join(''), 60)
        if (event.type === 'assistant/message') { const text = (event.data.message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('').trim(); if (text) row.lastAnswer = one(text, 300) }
        if (event.type === 'tool/call') {
          row.tools += 1; row.toolNames[event.data.name] = (row.toolNames[event.data.name] ?? 0) + 1
          const text = event.data.name + ' ' + String(event.data.arguments ?? '')
          if (event.data.name === 'constraint_note') row.notes.push(one(event.data.arguments, 220))
          // Command patterns only count in a shell call; quoting a rule in a message or a document is not a violation.
          const shell = /^(pwsh|bash|shell|exec)/i.test(event.data.name), file = /^(write|edit)/i.test(event.data.name)
          for (const [kind, pattern] of Object.entries(VIOLATIONS)) {
            if (!(shell || (kind === 'cdn' && file && !/CONSTRAINTS|DESIGN|README|\.md"/.test(text)))) continue
            if (pattern.test(text)) (row.hits[kind] ??= []).push({ compactionsBefore: row.compactions, text: one(text, full ? 900 : 260) })
          }
        }
      }
      const file = R + '/home/constraint-ledger/' + sid + '.json'
      if (fs.existsSync(file)) { try { row.ledger = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { row.ledger = { error: true } } }
      row.usage = usage.get(sid) ?? null
      rows.push(row)
    } catch { unreadable.push(sid) } finally { await handle.close() }
  }
}
rows.sort((a, b) => (b.usage?.requests ?? 0) - (a.usage?.requests ?? 0))
const total = { sessions: rows.length, requests: 0, compactions: 0, tool: 0, compaction: 0, retired: 0, hits: {} }
for (const row of rows) {
  const u = row.usage
  console.log(`\n## ${row.sid.replace('session-', '').slice(0, 8)} turns ${row.turns} steps ${row.steps} tools ${row.tools} compactions ${row.compactions} end ${row.end} | ${row.first}`)
  if (u) console.log(`   usage req ${u.requests} ${JSON.stringify(u.purposes)} miss ${u.input} hit ${u.cacheRead} out ${u.output}${u.compactions.length ? ' | compaction miss/hit: ' + u.compactions.join(' ') : ''}`)
  if (full) console.log('   tools ' + JSON.stringify(row.toolNames))
  for (const note of row.notes) console.log('   note ' + note)
  if (row.ledger?.entries) {
    console.log('   ledger baselineN ' + row.ledger.baselineN)
    for (const entry of row.ledger.entries) {
      console.log(`     ${entry.n} | ${entry.kind} | ${entry.origin} | ${entry.retired ? 'RETIRED ' + one(entry.retired.reason, 60) : 'active'} | ${one(entry.text, 200)} | ${entry.source ?? ''}`)
      if (entry.retired) total.retired += 1; else total[entry.origin] = (total[entry.origin] ?? 0) + 1
    }
  }
  for (const [kind, list] of Object.entries(row.hits)) { total.hits[kind] = (total.hits[kind] ?? 0) + list.length; console.log(`   HIT ${kind} x${list.length}`); for (const hit of list.slice(0, full ? 50 : 4)) console.log(`      [after ${hit.compactionsBefore} compactions] ${hit.text}`) }
  if (full && row.lastAnswer) console.log('   last: ' + row.lastAnswer)
  total.requests += u?.requests ?? 0; total.compactions += row.compactions
}
const sessionless = usage.get('sessionless')
console.log(`\nTOTAL sessions ${total.sessions} requests ${total.requests}${sessionless ? ' (+' + sessionless.requests + ' sessionless)' : ''} compactions ${total.compactions} ledger active tool ${total.tool} compaction ${total.compaction} retired ${total.retired} hits ${JSON.stringify(total.hits)}`)
if (unreadable.length) console.log('unreadable ' + unreadable.join(' '))
fs.writeFileSync(R + '/collect.json', JSON.stringify({ at: new Date().toISOString(), states, total, rows, unreadable }, null, 1))
