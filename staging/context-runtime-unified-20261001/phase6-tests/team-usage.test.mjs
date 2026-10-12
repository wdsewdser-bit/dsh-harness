#!/usr/bin/env node
/** Phase 6: whole-Team usage aggregation (Agent Team v3, item 9). */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { collectTeamUsage, decodeJournal, readSessionUsage, summarizeTeamUsage } from '../home/profiles/web/plugins/team-usage.mjs'

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  ' + detail))
}

const usageEvent = (input, output, cached) => JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, totalTokens: input + output + cached } } })
const writeSession = (root, id, parent, label, events) => {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const head = JSON.stringify({ type: 'session', version: 3, id, parentSession: parent })
  const desc = label === undefined ? null : JSON.stringify({ type: 'subagent/descriptor', data: { label, agentModel: 'm' } })
  const body = [head, ...(desc === null ? [] : [desc]), ...events].join('\n')
  // Two frames, because a real journal appends one frame per write and the one-shot
  // decompressor only ever returns the first.
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([zstdCompressSync(Buffer.from(body + '\n')), zstdCompressSync(Buffer.from(usageEvent(5, 1, 0) + '\n'))]))
}

// ---- multi-frame decode ----
{
  const one = zstdCompressSync(Buffer.from('alpha\n'))
  const two = zstdCompressSync(Buffer.from('beta\n'))
  check('a two-frame journal decodes completely', decodeJournal(Buffer.concat([one, two])) === 'alpha\nbeta\n', JSON.stringify(decodeJournal(Buffer.concat([one, two]))))
}

// ---- one session's totals ----
{
  const text = ['{"type":"session","id":"s","parentSession":"r"}', usageEvent(100, 10, 900), usageEvent(50, 5, 0)].join('\n')
  const row = readSessionUsage('s', text)
  check('usage accumulates across events', row.input === 150 && row.output === 15 && row.cached === 900, JSON.stringify(row))
  check('the parent link is read from the session header', row.parent === 'r', row.parent)
}

// ---- the Team tree, walked rather than listed ----
{
  const root = mkdtempSync(join(tmpdir(), 'usage-'))
  writeSession(root, 'root', '', undefined, [usageEvent(100, 10, 0)])
  writeSession(root, 'child-a', 'root', 'A', [usageEvent(200, 20, 0)])
  writeSession(root, 'grandchild', 'child-a', 'A1', [usageEvent(300, 30, 0)])
  writeSession(root, 'stranger', '', undefined, [usageEvent(9999, 9999, 0)])
  writeSession(root, 'other-team-child', 'another-root', 'X', [usageEvent(7777, 0, 0)])
  const rows = collectTeamUsage(root, 'root')
  const ids = rows.map((r) => r.id).sort().join(',')
  check('the Team is the root plus everything under it', ids === 'child-a,grandchild,root', ids)
  check('an unrelated session is excluded', !ids.includes('stranger'))
  check('another Team member is excluded', !ids.includes('other-team-child'))
  const s = summarizeTeamUsage(rows, 'root')
  check('totals cover every agent, not just the Lead', s.agents === 3 && s.total > 0, JSON.stringify({ agents: s.agents }))
  check('the Lead share is reported separately', s.leadTotal < s.otherTotal, JSON.stringify({ lead: s.leadTotal, others: s.otherTotal }))
}

// ---- a missing root is survivable ----
{
  check('a missing sessions directory returns nothing', collectTeamUsage(join(tmpdir(), 'nope-' + Date.now()), 'root').length === 0)
}

// ---- real data: the portal project, if it is still on this machine ----
{
  const real = 'D:\\dsh-test\\home\\sessions\\--D-dsh-test-workspaces-test--'
  const rows = collectTeamUsage(real, 'session-4a1d8fcf-bfc5-4929-aea8-1f204e71d875')
  if (rows.length === 0) {
    console.log('SKIP real portal journ**als are not present')
  } else {
    const s = summarizeTeamUsage(rows, 'session-4a1d8fcf-bfc5-4929-aea8-1f204e71d875')
    console.log('     real portal project: ' + s.agents + ' agents, total ' + s.total.toLocaleString('en-US') + ' tokens (lead ' + s.leadTotal.toLocaleString('en-US') + ', others ' + s.otherTotal.toLocaleString('en-US') + ')')
    check('real data reproduces the 14-agent team', s.agents === 14, String(s.agents))
    check('real total matches the independently measured 248,749,350', s.total === 248749350, s.total.toLocaleString('en-US'))
  }
}

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
