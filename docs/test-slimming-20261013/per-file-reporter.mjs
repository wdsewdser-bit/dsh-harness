// Per-file inventory reporter: leaf test counts, durations, test names.
export default async function* (events) {
  const files = new Map()
  const get = f => { let r = files.get(f); if (!r) files.set(f, r = { file: f, tests: 0, pass: 0, fail: 0, skipped: 0, ms: 0, top: 0, cases: [] }); return r }
  let summary
  for await (const e of events) {
    const d = e.data ?? {}
    if ((e.type === 'test:pass' || e.type === 'test:fail') && d.file && d.details?.type !== 'suite') {
      const r = get(d.file)
      const ms = d.details?.duration_ms ?? 0
      r.tests++; r.ms += ms
      if (d.skip || d.todo) r.skipped++
      else if (e.type === 'test:pass') r.pass++
      else r.fail++
      r.cases.push([d.name, Math.round(ms), d.nesting])
    }
    if ((e.type === 'test:pass' || e.type === 'test:fail') && d.file && d.nesting === 0) get(d.file).top += d.details?.duration_ms ?? 0
    if (e.type === 'test:summary' && d.file === undefined) summary = d
  }
  yield JSON.stringify({ counts: summary?.counts, durationMs: summary?.duration_ms, files: [...files.values()] }) + '\n'
}
