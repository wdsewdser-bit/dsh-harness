/**
 * team-v13-auto-research
 *
 * Bounded, offline-only candidate evaluation for the v13 context-economy
 * mechanisms. It consumes deterministic v12 replay fixtures, applies a
 * predeclared capability floor, and returns the non-dominated candidates.
 *
 * It never calls a provider, mutates a live configuration, or applies a
 * survivor. A human or a separate approved change step must promote a
 * candidate after reading the report.
 *
 * @module team-v13-auto-research
 */

export const AUTO_RESEARCH_SCHEMA_VERSION = 1

export const DEFAULT_CAPABILITY_FLOOR = Object.freeze({
  minCoveredFixtures: 1,
  maxViolations: 0,
  maxErrors: 0,
  requireAllPass: true,
})

/** Stable JSON for fingerprints and deterministic comparisons. */
function stableJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key]))
    .join(',') + '}'
}

/** Keep candidate batches finite and deterministic. */
export function boundCandidates(candidates, maximum = 8) {
  const rows = Array.isArray(candidates) ? candidates : []
  const seen = new Set()
  const bounded = []
  for (const candidate of rows) {
    if (candidate === null || typeof candidate !== 'object') continue
    const id = String(candidate.id ?? '').trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    bounded.push(candidate)
    if (bounded.length >= Math.max(1, Number(maximum) || 8)) break
  }
  return bounded
}

/** Compare two candidate observations under the capability floor. */
export function evaluateCandidate(candidate, observations, floor = DEFAULT_CAPABILITY_FLOOR) {
  const covered = Number(observations?.coveredFixtures ?? 0)
  const violations = Number(observations?.violations ?? 0)
  const errors = Number(observations?.errors ?? 0)
  const allPass = observations?.allPass === true
  const capabilityPass = covered >= Number(floor.minCoveredFixtures ?? 1)
    && violations <= Number(floor.maxViolations ?? 0)
    && errors <= Number(floor.maxErrors ?? 0)
    && (floor.requireAllPass !== true || allPass)
  const savingsTokens = Math.max(0, Number(candidate.estimatedSavingsTokens ?? 0))
  const overheadTokens = Math.max(0, Number(candidate.overheadTokens ?? 0))
  return {
    id: String(candidate.id),
    capabilityPass,
    coveredFixtures: covered,
    violations,
    errors,
    allPass,
    savingsTokens,
    overheadTokens,
    score: savingsTokens - overheadTokens,
    observationFingerprint: observations?.fingerprint ?? null,
  }
}

/** Return the Pareto frontier: higher capability and score dominate. */
export function paretoFrontier(rows) {
  const candidates = Array.isArray(rows) ? rows : []
  return candidates.filter((candidate) => !candidates.some((other) => {
    if (candidate === other || other.id === candidate.id) return false
    const noWorse = Number(other.capabilityPass) >= Number(candidate.capabilityPass)
      && Number(other.score) >= Number(candidate.score)
    const strictlyBetter = Number(other.capabilityPass) > Number(candidate.capabilityPass)
      || Number(other.score) > Number(candidate.score)
    return noWorse && strictlyBetter
  }))
}

/** Fingerprint the exact fixture set used by a research run. */
export function fixtureFingerprint(fixtures) {
  return stableJson((Array.isArray(fixtures) ? fixtures : []).map((fixture) => ({
    id: fixture?.fixtureId ?? fixture?.id ?? null,
    version: fixture?.fixtureVersion ?? fixture?.version ?? 1,
    category: fixture?.category ?? null,
    initialState: fixture?.initialState ?? fixture?.state ?? null,
    events: fixture?.events ?? [],
    postconditions: fixture?.postconditions ?? fixture?.assertions ?? [],
    invariants: fixture?.invariants ?? [],
  })))
}

/**
 * Evaluate a bounded candidate batch with caller-supplied v12 `runReplay`.
 * The caller owns fixture discovery and candidate generation; this function
 * owns the capability floor and non-dominated filtering.
 */
export async function runAutoResearch({
  fixtures,
  candidates,
  evidenceRefs = [],
  runReplay,
  maximumCandidates = 8,
  capabilityFloor = DEFAULT_CAPABILITY_FLOOR,
  now = () => Date.now(),
} = {}) {
  if (typeof runReplay !== 'function') throw new Error('runAutoResearch requires a runReplay function')
  const fixtureRows = Array.isArray(fixtures) ? fixtures : []
  const categories = [...new Set(fixtureRows.map((fixture) => String(fixture?.category ?? '')).filter(Boolean))].sort()
  const bounded = boundCandidates(candidates, maximumCandidates)
  const evaluations = []
  for (const candidate of bounded) {
    const replayResults = []
    for (const fixture of fixtureRows) {
      const result = await runReplay(fixture, {
        reducer: candidate.reducer,
        implementationId: candidate.id,
      })
      replayResults.push(result)
    }
    const coveredFixtures = replayResults.filter((result) => result?.covered === true).length
    const violations = replayResults.reduce((total, result) => total + (result?.violations?.length ?? 0), 0)
    const errors = replayResults.reduce((total, result) => total + (result?.errors?.length ?? 0), 0)
    const allPass = replayResults.length > 0 && replayResults.every((result) => result?.status === 'passed')
    const observations = {
      coveredFixtures,
      violations,
      errors,
      allPass,
      fingerprint: fixtureFingerprint(fixtureRows),
    }
    evaluations.push(evaluateCandidate(candidate, observations, capabilityFloor))
  }
  // A candidate that misses the capability floor is not eligible for the
  // frontier, even if it is cheaper. This is the guard against optimizing a
  // mechanism by breaking the behavior it was meant to preserve.
  const survivors = paretoFrontier(evaluations.filter((row) => row.capabilityPass))
  const survivorIds = new Set(survivors.map((row) => row.id))
  return {
    schemaVersion: AUTO_RESEARCH_SCHEMA_VERSION,
    generatedAt: new Date(now()).toISOString(),
    fixtureCount: fixtureRows.length,
    fixtureFingerprint: fixtureFingerprint(fixtureRows),
    categories,
    evidenceRefs: (Array.isArray(evidenceRefs) ? evidenceRefs : []).slice(0, 64),
    evidenceFingerprint: stableJson((Array.isArray(evidenceRefs) ? evidenceRefs : []).slice(0, 64)),
    candidateCount: bounded.length,
    capabilityFloor,
    evaluations,
    survivors,
    rejected: evaluations.filter((row) => !survivorIds.has(row.id)),
    applied: false,
  }
}
