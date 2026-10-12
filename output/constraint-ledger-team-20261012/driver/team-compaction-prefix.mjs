import fs from 'node:fs'
import readline from 'node:readline'

// 流式逐行读取 requests.jsonl（不整读进内存）。解析失败或非对象的行跳过并计数，每条合格记录交给 onRecord。
function scan(file, onRecord) {
  let skipped = 0
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file, { encoding: 'utf8' })
    const rl = readline.createInterface({ input, crlfDelay: Infinity })
    input.on('error', reject)
    rl.on('error', reject)
    rl.on('line', line => {
      if (line.trim() === '') return
      let o = null
      try { o = JSON.parse(line) } catch {}
      if (!o || typeof o !== 'object') { skipped++; return }
      onRecord(o)
    })
    rl.on('close', () => resolve(skipped))
  })
}

const file = process.argv[2] + '/requests.jsonl'
// 第一遍：收集压缩请求（数量很少，整条保留）。
const comps = []
const skipped = await scan(file, o => { if (o.purpose === 'compaction-wire') comps.push(o) })
// 第二遍：每个压缩请求只保留“同会话、at 早于它、文件顺序最后”的一条对话请求（等价于原来的 .at(-1)）。其余对话请求不保存。
const prevs = comps.map(() => null)
await scan(file, o => {
  if (o.purpose != null) return
  comps.forEach((c, idx) => { if (o.sessionId === c.sessionId && o.at < c.at) prevs[idx] = o })
})
for (const [idx, c] of comps.entries()) {
  const prev = prevs[idx]
  if (!prev) continue
  let i = 0
  while (i < Math.min(prev.n, c.n) && prev.rows[i].id === c.rows[i].id && prev.rows[i].bytes === c.rows[i].bytes) i++
  const sum = rows => rows.reduce((s, x) => s + x.bytes, 0)
  const ids = new Set(c.rows.map(x => x.id)), pids = new Set(prev.rows.map(x => x.id))
  console.log(c.sessionId.replace('session-', '').slice(0, 8), c.at.slice(11, 19), 'prev n', prev.n, 'bytes', sum(prev.rows), '| compaction n', c.n, 'bytes', sum(c.rows), '| common prefix msgs', i, 'bytes', sum(c.rows.slice(0, i)),
    '| only in prev', prev.rows.filter(x => !ids.has(x.id)).length, 'only in compaction', c.rows.filter(x => !pids.has(x.id)).length,
    '| addendum', /Additional required final section/.test(c.rows.at(-1).tail), 'pendingList', /Already recorded by constraint_note/.test(c.rows.at(-1).tail))
  if (i < Math.min(prev.n, c.n)) console.log('   first diff @' + i, 'prev:', prev.rows[i].role, prev.rows[i].kind, prev.rows[i].bytes, (prev.rows[i].head || '').slice(0, 80).replace(/\s+/g, ' '), '|| comp:', c.rows[i].role, c.rows[i].kind, c.rows[i].bytes, (c.rows[i].head || '').slice(0, 80).replace(/\s+/g, ' '))
}
console.error('跳过行数', skipped)
