import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { buildTeamPanelOverview, projectPanelRooms } from '../home/profiles/web/plugins/team-v14-panel.mjs'
import { readPanelJsonCached } from '../home/profiles/web/plugins/team-operator-v5.mjs'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

const clientFile = new URL('../home/profiles/web/node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js', import.meta.url)
const client = readFileSync(clientFile, 'utf8')
const operator = readFileSync(new URL('../home/profiles/web/plugins/team-operator-v5.mjs', import.meta.url), 'utf8')
const jsx = (type, props) => ({ type, props: props ?? {} })
const component = (name, until) => {
  const start = client.indexOf('\t\tfunction ' + name + '(')
  const end = client.indexOf(until, start)
  assert.ok(start >= 0 && end > start, `${name} component source`)
  const context = {
    react_jsx_runtime: { jsx, jsxs: jsx }, react: { useState: (value) => [value, () => {}] },
    rosterTag: (value) => jsx('tag', { children: value }), ROSTER_STATUS_TONE: {}, ROSTER_NEUTRAL_TONE: {},
  }
  vm.runInNewContext(client.slice(start, end) + `\nthis.component = ${name};`, context)
  return context.component
}
const walk = (node, found = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') { found.push(String(node)); return found }
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  found.push(node)
  walk(node.props?.children, found)
  return found
}

test('operator panel projection has true statuses, bounded text and no synthetic dispatches', () => {
  const snapshot = {
    boards: { global: { tasks: { a: { id: 'a', status: 'pending', ownerName: 'member', blockedBy: ['b'] } } } },
    rooms: { room: { roomId: 'room', status: 'closed', messages: Array.from({ length: 90 }, (_, i) => ({ messageId: String(i), content: 'x'.repeat(3000) })) } },
    v12Requirements: { revision: 2, events: [{ revision: 2, type: 'requirement/revised', requirementId: 'r1' }] },
    v12Events: [{ eventType: 'team_task_create/post', correlationId: 'legacy-call', at: 1 }],
    v14Receipts: [{ callId: 'call-1', rootCallId: 'root-1', sessionId: 'session-1', tool: 'team_task_create', mirrorStatus: 'committed', ids: { id: 'a' }, at: 2 }],
    v12Compaction: { jobs: { c: { id: 'c', owner: 'member', status: 'pending' } } },
  }
  const overview = buildTeamPanelOverview(snapshot, [{ name: 'member', status: 'idle' }])
  assert.equal(overview.waitingResponsibility[0].reason, 'waiting-dependency')
  assert.equal(overview.requirements.changes[0].requirementId, 'r1')
  assert.equal(overview.ptcReceipts[0].correlationId, 'call-1')
  assert.equal(overview.ptcReceipts[0].rootCallId, 'root-1')
  assert.equal(overview.contextWarnings[0].reason, 'compaction-pending')
  const room = projectPanelRooms(snapshot, 6, 12)[0]
  assert.equal(room.messages.length, 6)
  assert.equal(room.omittedMessages, 84)
  assert.equal(room.messages[0].content.length, 500)
  assert.match(operator, /dispatches: Object\.values\(snapshot\.dispatches/)
  assert.doesNotMatch(operator, /continuationDispatches|waitingDispatches/)
})

test('meta side projections prefer v14 receipts and stay bounded', () => {
  const source = readFileSync(new URL('../home/profiles/web/plugins/team-operator-v5.mjs', import.meta.url), 'utf8')
  assert.match(readFileSync(new URL('../home/profiles/web/plugins/team-v14-panel.mjs', import.meta.url), 'utf8'), /snapshot\.v14Receipts/)
  assert.match(source, /const PANEL_WAKE_LIMIT = 10/)
  assert.match(source, /escalations: Object\.values\(snapshot\.escalations \?\? \{\}\)\.slice\(-20\)/)
  assert.match(source, /wakeEpisodes: Object\.values\(snapshot\.wakeEpisodes \?\? \{\}\)\.slice\(-PANEL_WAKE_LIMIT\)/)
  assert.match(source, /compactionJobs: Object\.values\(snapshot\.v12Compaction\?\.jobs \?\? \{\}\)\.slice\(-20\)/)
})

test('meta uses one durable hot read and indexed task reconciliation', () => {
  const source = readFileSync(new URL('../home/profiles/web/plugins/team-operator-v5.mjs', import.meta.url), 'utf8')
  const viewIndex = source.indexOf('durable = cp.view({ history: false })')
  const refreshIndex = source.indexOf('registry.refreshBoards?.(durable)')
  assert.ok(viewIndex >= 0 && refreshIndex > viewIndex, 'durable hot read must precede refreshBoards')
  assert.doesNotMatch(source, /registry\.refreshBoards\?\.\(durable\)[\s\S]{0,400}durable = cp\.view/)
  assert.match(source, /const durableById = new Map\(durableTasks\.map/)
  assert.match(source, /const domainIds = new Set\(domainTasks\.map/)
  assert.doesNotMatch(source, /durableTasks\.find/)
  assert.doesNotMatch(source, /domainTasks\.some/)
})

test('overview component renders each bounded operations section', () => {
  const OverviewView = component('OverviewView', '\t\t/**\n\t\t * The roster')
  const node = OverviewView({ meta: { bottlenecks: { ready: 1, waiting: 1 }, continuation: [{ taskId: 't1', owner: 'member' }], waitingResponsibility: [{ taskId: 't2', reason: 'waiting-dependency' }], requirements: { changes: [{ revision: 2, type: 'revised' }] }, ptcReceipts: [{ correlationId: 'call-1' }], contextWarnings: [{ reason: 'compaction-pending' }] }, t: (key) => key, css: {} })
  const text = walk(node).filter((item) => typeof item === 'string').join(' ')
  for (const key of ['continuation', 'waitingResponsibility', 'requirementChanges', 'ptcReceipts', 'contextWarnings']) assert.match(text, new RegExp(key))
  assert.match(text, /t1/)
})

test('room component shows latest round first and folds older rounds', () => {
  const RoomDetail = component('RoomDetail', '\t\t/** One compact dispatch row')
  const node = RoomDetail({ room: { roomId: 'r', status: 'closed', messages: [], omittedMessages: 2 }, rounds: {
    old: { roundId: 'old', roomId: 'r', openedAt: 1, status: 'closed' },
    recent: { roundId: 'recent', roomId: 'r', openedAt: 2, status: 'closed' },
  }, t: (key) => key, css: {}, onBack: () => {} })
  const details = walk(node).filter((item) => item?.type === 'details')
  assert.equal(details.length, 2)
  assert.equal(details[0].props.open, true)
  assert.equal(details[1].props.open, undefined)
  assert.match(walk(details[0]).join(' '), /recent/)
  assert.match(walk(node).join(' '), /roomOlderArchived/)
  for (const tab of ['members', 'frozen', 'boards', 'rooms', 'dispatches', 'overview']) assert.match(client, new RegExp(`key: "${tab}"`))
})

test('panel JSON cache reuses unchanged files and invalidates on content changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-panel-doc-'))
  try {
    const path = join(root, 'health.json')
    writeFileSync(path, JSON.stringify({ status: 'healthy' }), 'utf8')
    const first = readPanelJsonCached(path)
    assert.equal(readPanelJsonCached(path), first)

    writeFileSync(path, JSON.stringify({ status: 'degraded', reason: 'changed' }), 'utf8')
    const second = readPanelJsonCached(path)
    assert.notEqual(second, first)
    assert.equal(second.status, 'degraded')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('panel inbox projection keeps pending rows and bounds already-injected history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-panel-inbox-'))
  try {
    const file = join(root, 'bounded.json')
    const cp = controlPlaneFor('bounded', { directory: root })
    await cp.mutate('fixture/init', {}, null, () => ({ ok: true }))
    await cp.flush()

    const inbox = {}
    for (let index = 0; index < 10; index += 1) {
      const messageId = 'pending-' + index
      inbox[messageId] = { messageId, status: 'queued', updatedAt: 1000 + index }
    }
    for (let index = 0; index < 990; index += 1) {
      const messageId = 'injected-' + index
      inbox[messageId] = {
        messageId,
        status: 'delivered',
        injectionReceipt: 'receipt-' + index,
        injectedAt: 2000 + index,
        updatedAt: 2000 + index,
      }
    }
    writeFileSync(file + '.panel-cache.json', JSON.stringify({
      version: 1,
      revision: 1,
      fingerprint: 'fixture',
      rooms: {},
      transcripts: {},
      inbox,
    }), 'utf8')

    resetControlPlaneCache()
    const reopened = controlPlaneFor('bounded', { directory: root })
    const projected = reopened.view({ history: false }).v12RoomWake.inbox
    assert.equal(Object.keys(projected).length, 100)
    for (let index = 0; index < 10; index += 1) {
      assert.equal(projected['pending-' + index].status, 'queued')
    }
    assert.equal(Object.values(projected).filter((row) => row.injectionReceipt !== undefined).length, 90)
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})
