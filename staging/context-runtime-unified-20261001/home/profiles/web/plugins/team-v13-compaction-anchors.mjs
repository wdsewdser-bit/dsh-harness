/**
 * team-v13-compaction-anchors
 *
 * Machine checks for the minimum recovery anchors that must survive a fold.
 * The validator is deliberately pure so it can be used by tests and by the
 * compaction engine without knowing how the summary was produced.
 *
 * @module team-v13-compaction-anchors
 */

export const COMPACTION_ANCHOR_VERSION = 1
export const DEFAULT_REQUIRED_ANCHORS = Object.freeze([
  'taskContract',
  'ownerScope',
  'milestoneNext',
  'requirements',
  'roomDecisions',
  'roomSummary',
  'cursor',
  'blockers',
])

function text(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n')
  if (value !== null && typeof value === 'object') {
    return Object.values(value).map(text).filter(Boolean).join('\n')
  }
  return value === undefined || value === null ? '' : String(value)
}

/** Flatten a summary object or command result into searchable text. */
export function summaryText(value) {
  return text(value).trim()
}

/**
 * Validate that every required anchor has a non-empty value in the summary.
 * Optional anchors are reported for diagnostics but do not fail the result.
 */
export function validateCompactionAnchors(summary, anchors, options = {}) {
  const source = summaryText(summary)
  const required = Array.isArray(options.required) && options.required.length > 0
    ? options.required.map(String)
    : [...DEFAULT_REQUIRED_ANCHORS]
  const values = anchors !== null && typeof anchors === 'object' ? anchors : {}
  const missing = []
  const optionalMissing = []
  if (options.sourceStatus === 'unavailable' || options.sourceStatus === 'truncated') {
    missing.push('source:' + options.sourceStatus)
  }
  for (const key of required) {
    const terms = Array.isArray(values[key]) ? values[key].map(text).filter(Boolean) : [text(values[key]).trim()].filter(Boolean)
    // A verified empty collection is different from an unavailable source.
    if (terms.some((term) => !source.includes(term))) missing.push(key)
  }
  for (const [key, value] of Object.entries(values)) {
    if (required.includes(key)) continue
    const expected = text(value).trim()
    if (expected.length > 0 && !source.includes(expected)) optionalMissing.push(key)
  }
  return {
    version: COMPACTION_ANCHOR_VERSION,
    ok: source.length > 0 && missing.length === 0,
    summaryAvailable: source.length > 0,
    sourceStatus: options.sourceStatus ?? 'unspecified',
    missing,
    optionalMissing,
  }
}
