/**
 * Shared source metadata for v13 observation transformations.
 *
 * Reducer and ObservationPack both replace a tool observation. This module
 * gives them one stable metadata line so later diagnostics can identify the
 * original bytes, archive, processor and result without trusting prose.
 *
 * @module team-v13-observation-source
 */

export const OBSERVATION_SOURCE_VERSION = 1
export const OBSERVATION_SOURCE_MARKER = 'sol_pi_observation_source_v1'

function stableJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
    .join(',') + '}'
}

/** Render one machine-readable source metadata line. */
export function renderObservationSource(input = {}) {
  const row = {
    version: OBSERVATION_SOURCE_VERSION,
    processor: String(input.processor ?? 'unknown'),
    result: String(input.result ?? 'unknown'),
    sha256: String(input.sha256 ?? ''),
    archiveId: String(input.archiveId ?? ''),
    bytes: Number.isFinite(input.bytes) ? Number(input.bytes) : null,
  }
  if (typeof input.archivePath === 'string' && input.archivePath.length > 0) row.archivePath = input.archivePath
  if (Array.isArray(input.lineNumbers)) row.lineNumbers = input.lineNumbers.map(Number).filter(Number.isInteger)
  if (typeof input.provider === 'string' && input.provider.length > 0) row.provider = input.provider
  if (typeof input.model === 'string' && input.model.length > 0) row.model = input.model
  return OBSERVATION_SOURCE_MARKER + ' ' + stableJson(row)
}

/** Parse the first source metadata line, or return undefined. */
export function parseObservationSource(text) {
  if (typeof text !== 'string') return undefined
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(OBSERVATION_SOURCE_MARKER + ' ')) continue
    try {
      const parsed = JSON.parse(line.slice(OBSERVATION_SOURCE_MARKER.length + 1))
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** True when text already carries the shared source marker. */
export function hasObservationSource(text) {
  return typeof text === 'string' && text.split(/\r?\n/).some((line) => line.startsWith(OBSERVATION_SOURCE_MARKER + ' '))
}
