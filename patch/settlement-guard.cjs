const fs = require('node:fs')
const path = require('node:path')

/**
 * Keep Agent Team upward reporting deliberate.
 *
 * Continuable children settle on their own schedule. Letting every settlement
 * start a parent turn turned one real Team test into 26 extra root turns, so a
 * Team member receives the notice at its next step (`inject`) instead of being
 * woken. Non-Team parents keep the shipped waking behaviour.
 *
 * The installed layout differs between DSH releases (a flat npm tree before
 * 0.1.7-alpha.2, the pnpm `.pnpm` virtual store after), so targets are found by
 * walking instead of hardcoding one layout.
 */

const root = path.resolve(__dirname, '..')
const searchRoots = [
  path.join(root, 'app', 'node_modules'),
  path.join(root, 'home', 'profiles'),
]

const marker = 'Agent Team owns its own upward reporting'
const anchor = '\t\t\tthis.sendWaking(parent, message, parent.status === "idle" ? "queue" : "steer");'
const guard = [
  '\t\t\t// Agent Team owns its own upward reporting: room handoff and send_message',
  '\t\t\t// deliver one deliberate hop at a time, and team-idle-watch wakes the Lead',
  '\t\t\t// once the whole Team stops. Letting every continuable child settlement also',
  '\t\t\t// start a parent turn turned one real test into 26 extra root turns, so Team',
  '\t\t\t// members receive the notice at their next step instead of a new turn.',
  '\t\t\tconst teams = typeof this.ctx.get === "function" ? this.ctx.get("agentTeams") : void 0;',
  '\t\t\tif (teams !== void 0 && typeof teams.tryMembership === "function") {',
  '\t\t\t\ttry {',
  '\t\t\t\t\tif (teams.tryMembership(parent) !== void 0) {',
  '\t\t\t\t\t\tparent.inject(message);',
  '\t\t\t\t\t\treturn;',
  '\t\t\t\t\t}',
  '\t\t\t\t} catch {',
  '\t\t\t\t\t/* Not a Team member: fall through to the waking path. */',
  '\t\t\t\t}',
  '\t\t\t}',
].join('\n')

const suffix = path.join('dsh-subagent', 'lib', 'index.js')

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
    if (!full.endsWith(suffix)) continue
    if (!out.includes(full)) out.push(full)
  }
}

function ensureOne(file) {
  const text = fs.readFileSync(file, 'utf8')
  if (text.includes(marker)) return 'present'
  const index = text.indexOf(anchor)
  if (index < 0) return 'anchor-missing'
  const backup = `${file}.bak-before-settlement-guard`
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, `${text.slice(0, index)}${guard}\n${text.slice(index)}`, 'utf8')
  return 'patched'
}

function ensure() {
  const targets = []
  for (const dir of searchRoots) collectTargets(dir, targets, 0)
  if (targets.length === 0) {
    console.warn('[settlement-guard] WARNING: no dsh-subagent/lib/index.js found; guard not enforced')
    return true
  }
  let enforced = 0
  for (const target of targets) {
    const result = ensureOne(target)
    if (result === 'patched') {
      console.log(`[settlement-guard] patched: ${target}`)
      enforced += 1
      continue
    }
    if (result === 'present') enforced += 1
    if (result === 'anchor-missing') {
      console.warn(`[settlement-guard] WARNING: anchor not found (upstream may have changed): ${target}`)
    }
  }
  if (enforced === 0) {
    console.warn('[settlement-guard] WARNING: no target carried the guard after this run')
  }
  return true
}

module.exports = { ensure }

if (require.main === module && !ensure()) process.exit(1)
