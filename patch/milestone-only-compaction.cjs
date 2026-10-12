const fs = require('node:fs')
const path = require('node:path')

/**
 * Compaction is a milestone decision, not a background reflex.
 *
 * `dsh-compaction-basic` defaults `auto` to true, so a long session compacts
 * without any milestone tool call. Every shipped preset row is pinned to
 * `auto: false`; manual compaction and the milestone flow stay available.
 *
 * 0.1.7-alpha.2 moved the shipped presets from
 * `dsh-agent-presets/presets/<name>/agent.cordis.yml` to
 * `dsh-web-app/presets/<name>.patch.yml`, so both layouts are discovered by
 * walking the installed trees.
 */

const root = path.resolve(__dirname, '..')
const searchRoots = [
  path.join(root, 'app', 'node_modules'),
  path.join(root, 'home', 'profiles'),
]

const marker = 'compaction-policy: milestone-only'
const rowPattern = /^(\s*)- id: compaction-basic\s*$/
const namePattern = /^(\s*)name: '@deepseek-ai\/dsh-compaction-basic'\s*$/

function isPresetFile(file) {
  const normalized = file.split(path.sep).join('/')
  if (normalized.endsWith('/dsh-web-app/presets/ptc.patch.yml')) return true
  if (normalized.endsWith('/dsh-web-app/presets/standard.patch.yml')) return true
  if (normalized.endsWith('/dsh-web-app/presets/cordis.patch.yml')) return true
  if (normalized.endsWith('/dsh-web-app/presets/minimal.patch.yml')) return true
  if (normalized.endsWith('/dsh-agent-presets/presets/ptc/agent.cordis.yml')) return true
  if (normalized.endsWith('/dsh-agent-presets/presets/standard/agent.cordis.yml')) return true
  if (normalized.endsWith('/dsh-agent-presets/presets/cordis/agent.cordis.yml')) return true
  return false
}

function collectTargets(dir, out, depth) {
  if (depth > 12) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectTargets(full, out, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (!isPresetFile(full)) continue
    if (!out.includes(full)) out.push(full)
  }
}

function ensureOne(file) {
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(marker)) return 'present'
  const lines = text.split('\n')
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!rowPattern.test(lines[index])) continue
    const nameMatch = namePattern.exec(lines[index + 1])
    if (nameMatch === null) continue
    const indent = nameMatch[1]
    const injected = [
      `${indent}config:`,
      `${indent}  auto: false # ${marker}`,
    ]
    lines.splice(index + 2, 0, ...injected)
    const backup = `${file}.bak-before-milestone-only-compaction`
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    return 'patched'
  }
  return 'anchor-missing'
}

function ensure() {
  const targets = []
  for (const dir of searchRoots) collectTargets(dir, targets, 0)
  if (targets.length === 0) {
    console.warn('[milestone-compaction] WARNING: no shipped preset file found; policy not enforced')
    return true
  }
  let enforced = 0
  for (const target of targets) {
    const result = ensureOne(target)
    if (result === 'patched') {
      console.log(`[milestone-compaction] patched: ${target}`)
      enforced += 1
      continue
    }
    if (result === 'present') enforced += 1
    if (result === 'anchor-missing') {
      console.warn(`[milestone-compaction] WARNING: compaction-basic row not found in ${target}`)
    }
  }
  if (enforced === 0) {
    console.warn('[milestone-compaction] WARNING: no preset carried the policy after this run')
  }
  return true
}

module.exports = { ensure }

if (require.main === module && !ensure()) process.exit(1)
