const limit = (value, max) => {
  const text = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  return text.length <= max ? text : text.slice(0, max) + ' [truncated; see full.log]'
}
function failureMessage(error) {
  const message = String(error?.cause?.message ?? error?.message ?? '')
  // Fixture assertions often serialize a large run record before the real cause.
  try {
    const record = JSON.parse(message.split(/\r?\n/, 1)[0])
    const cause = record.saved?.error ?? record.result?.error ?? record.error
    if (typeof cause === 'string') return cause
    if (cause?.message || cause?.code) return [cause.code, cause.message].filter(Boolean).join(': ')
  } catch {}
  return message
}

// Keep Node's root counters, not a count of nested pass/fail notifications.
export default async function* compactReporter(events) {
  let summary
  const failures = []
  for await (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'test:fail') {
      const error = data.details?.error
      if (error?.failureType !== 'subtestsFailed') failures.push({
        name: limit(data.name, 300), file: data.file, line: data.line, column: data.column,
        code: error?.code, failureType: error?.failureType,
        message: limit(failureMessage(error), 2000),
      })
    }
    if (event.type === 'test:summary' && data.file === undefined) summary = data
  }
  yield JSON.stringify({ schema: 'dsh-compact-test-summary-v1', complete: Boolean(summary),
    success: summary?.success ?? false, counts: summary?.counts ?? null,
    durationMs: summary?.duration_ms ?? null, failures }, null, 2) + '\n'
}
