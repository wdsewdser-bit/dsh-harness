#!/usr/bin/env node
/** Team quiet-message batching: the Lead sees one batch instead of a partial prefix. */
import { readFileSync } from 'node:fs'
import { assertV4RowAdmission } from '../app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}

const source = readFileSync(new URL('../home/profiles/web/plugins/team-tools-v2-r10.mjs', import.meta.url), 'utf8')
check('pre-step collapse is wired for lead', source.includes("if (membership.role === 'lead')") && source.includes('collapseQuietBatch(resolved.messages ?? [])'))
check('subagent settlement notices are batchable', source.includes("source?.kind === 'subagent-settled'"))
check('team quiet notices are batchable', source.includes("source.plugin === name && source.form === 'notice'"))
check('team notices use the v4 producer kind', source.includes("kind: 'team-message'") && !source.includes("kind: 'plugin'"))
check('control wake path stays direct', source.includes('args.wake === true') && source.includes('ctx.agentTeams.sendMessage'))
check('batch text preserves every original message', source.includes('--- message ') && source.includes('quietBatchText(quiet)'))

// Exercise the pure shape of the collapse contract without importing the plugin,
// whose top-level Cordis imports require the profile runtime.
function collapse(messages) {
  const quiet = messages.filter((m) => m.source?.kind === 'subagent-settled' || (m.source?.kind === 'team-message' && m.source?.form === 'notice'))
  if (quiet.length < 2) return messages
  const selected = new Set(quiet)
  const first = messages.indexOf(quiet[0])
  const kept = messages.filter((m) => !selected.has(m))
  kept.splice(Math.min(first, kept.length), 0, { kind: 'batch', text: quiet.map((m) => m.text).join('\n') })
  return kept
}
const input = [
  { text: 'child A', source: { kind: 'subagent-settled' } },
  { text: 'child B', source: { kind: 'subagent-settled' } },
  { text: 'team notice', source: { kind: 'team-message', form: 'notice' } },
  { text: 'user input', source: { kind: 'user' } },
]
const output = collapse(input)
check('one quiet batch replaces adjacent quiet notices', output.length === 2 && output[0].kind === 'batch' && output[1].text === 'user input')
check('the batch retains all quiet message bodies', output[0].text.includes('child A') && output[0].text.includes('child B') && output[0].text.includes('team notice'))

const row = {
  type: 'user/message',
  seq: 1,
  time: 1,
  data: { role: 'user', id: 'm', content: [{ type: 'text', text: 'x' }], source: { kind: 'team-message', plugin: 'team-tools-v2-r10' } },
}
let teamMessageAccepted = true
try { assertV4RowAdmission(row) } catch { teamMessageAccepted = false }
check('v4 admits the team-message producer kind', teamMessageAccepted)

let retiredPluginRejected = false
try {
  assertV4RowAdmission({ ...row, data: { ...row.data, source: { kind: 'plugin', plugin: 'team-tools-v2' } } })
} catch (error) {
  retiredPluginRejected = /producer-owned source kind/.test(String(error))
}
check('v4 rejects the retired plugin wrapper', retiredPluginRejected)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
