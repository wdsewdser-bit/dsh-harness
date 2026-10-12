/**
 * observation-pack — Agent Team v2 / Phase 2b
 *
 * Replaces a large tool observation with a compact *handle* that points at the
 * spilled full text, so the context window carries a reference instead of the
 * payload. Adapted from SoL-Pi's ObservationPack mechanism
 * (https://github.com/NVlabs/SoL-Pi).
 *
 * Recall is deliberately NOT a new tool: the handle carries an absolute path and
 * the agent already owns a read tool, so recall reuses the existing read path
 * (including its observation policy) instead of adding a surface the model can
 * misuse. Nothing is lost: the full text is always on disk before the handle is
 * emitted, and a spill failure falls back to the original observation.
 *
 * Hooks
 * -----
 *  - tools/post-execute      native tool calls            (content replacement,
 *                            value preserved)
 *  - tools/ptc-dispatch-log  run_code sub-dispatches      (ContentBlock[])
 *
 * Config
 * ------
 *   maxInlineChars: 4000      # observations at or below this stay untouched
 *   previewChars: 600         # how much of the head the handle carries
 *   spillDir: "D:\\...\\spill"
 *   tools: ["bash", "read"]   # optional allow-list; default = every tool
 *
 * @module observation-pack
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'observation-pack'
/** Reads no services. */
export const inject = []

/** Total text payload of one block list. */
function textSize(blocks) {
  if (!Array.isArray(blocks)) return 0
  let size = 0
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') size += block.text.length
  }
  return size
}

/** Join the text blocks for the spill file, keeping their order. */
function textOf(blocks) {
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Default evidence-bearing line pattern: what a reader must not lose. */
const DEFAULT_EVIDENCE = /(error|fail|failed|failure|panic|exception|timeout|timed out|denied|refus|cannot|undefined|null pointer|assert|expected|actual|mismatch|warning|\bwarn\b|✗|✘|×|Traceback|\bat [A-Za-z0-9_$.]+\()/i

/**
 * Keep the decisive lines of a long observation. A head-only preview loses the
 * one FAIL line that sits in the middle of a 500-line log, which is exactly the
 * evidence the agent needs; this selects matching lines explicitly, dedupes
 * them, and stays inside a character budget.
 */
function selectEvidence(text, pattern, budget) {
  if (budget <= 0) return ''
  const seen = new Set()
  const kept = []
  let used = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.length > 400) continue
    if (!pattern.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    if (used + line.length + 1 > budget) break
    used += line.length + 1
    kept.push(line)
  }
  return kept.join('\n')
}

/** One compact model-facing handle for a spilled observation. */
function handle(label, blocks, spillDir, previewChars, evidencePattern, evidenceChars) {
  const text = textOf(blocks)
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12)
  let file
  try {
    mkdirSync(spillDir, { recursive: true })
    file = join(spillDir, 'obs-' + digest + '.txt')
    writeFileSync(file, text, 'utf8')
  } catch (error) {
    return undefined
  }
  const lines = text.length === 0 ? 0 : text.split('\n').length
  const preview = text.length > previewChars ? text.slice(0, previewChars) : text
  const evidence = selectEvidence(text, evidencePattern, evidenceChars)
  const body = [
    '[observation-pack] tool=' + label + ' chars=' + text.length + ' lines=' + lines,
    preview + (text.length > previewChars ? '\n… (' + String(text.length - previewChars) + ' more chars)' : ''),
    evidence.length > 0 ? '--- evidence lines (always retained) ---\n' + evidence : '',
    'full output: ' + file,
    'read that path to recover the complete observation.',
  ].filter((part) => part.length > 0).join('\n')
  return { type: 'text', text: body }
}

/**
 * Register both packing listeners.
 * @param ctx - cordis plugin context.
 * @param config - this plugin row's config.
 */
export function apply(ctx, config = {}) {
  const maxInlineChars = Number.isFinite(config.maxInlineChars) ? config.maxInlineChars : 4000
  const previewChars = Number.isFinite(config.previewChars) ? config.previewChars : 600
  const spillDir = typeof config.spillDir === 'string' && config.spillDir.length > 0
    ? config.spillDir
    : join(process.env.TEMP || process.env.TMPDIR || '.', 'dsh-observations')
  const evidenceChars = Number.isFinite(config.evidenceChars) ? config.evidenceChars : 1500
  const evidencePattern = typeof config.evidencePattern === 'string' && config.evidencePattern.length > 0
    ? new RegExp(config.evidencePattern, 'i')
    : DEFAULT_EVIDENCE
  const allowed = Array.isArray(config.tools) && config.tools.length > 0 ? new Set(config.tools) : undefined

  const wanted = (label) => allowed === undefined || allowed.has(label)

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (downstream.kind === 'block') return downstream
    if (!exec || !wanted(exec.name)) return downstream
    if (!result || result.isError === true) return downstream
    if (textSize(result.content) <= maxInlineChars) return downstream

    const packed = handle(exec.name, result.content, spillDir, previewChars, evidencePattern, evidenceChars)
    if (packed === undefined) return downstream
    return { ...downstream, content: [packed] }
  })

  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const blocks = await next()
    if (!dispatch || dispatch.isError === true) return blocks
    if (!wanted(dispatch.name)) return blocks
    if (textSize(blocks) <= maxInlineChars) return blocks

    const packed = handle(dispatch.name, blocks, spillDir, previewChars, evidencePattern, evidenceChars)
    if (packed === undefined) return blocks
    return [packed]
  })
}
