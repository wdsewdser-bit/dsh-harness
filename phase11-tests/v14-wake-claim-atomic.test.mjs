import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  controlPlaneFor,
  resetControlPlaneCache,
} from '../home/profiles/web/plugins/team-control-plane.mjs'

test('wake claim records the first and merged pending messages in one mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'v14-wake-claim-atomic-'))
  try {
    resetControlPlaneCache()
    const cp = controlPlaneFor('atomic-root', { directory: root })
    const first = await cp.wakeClaim({
      episodeId: 'episode-1',
      kind: 'control',
      sender: 'lead',
      target: 'member',
      messageHash: 'hash-1',
      pendingMessage: {
        messageId: 'message-1',
        messageHash: 'hash-1',
        text: 'first',
        status: 'queued',
      },
    }, { id: 'test-agent' })
    assert.equal(first.claimed, true)
    assert.equal(first.pendingAdded, true)

    const merged = await cp.wakeClaim({
      episodeId: 'episode-1',
      kind: 'control',
      sender: 'lead',
      target: 'member',
      messageHash: 'hash-2',
      pendingMessage: {
        messageId: 'message-2',
        messageHash: 'hash-2',
        text: 'second',
        status: 'queued',
      },
    }, { id: 'test-agent' })
    assert.equal(merged.claimed, false)
    assert.equal(merged.pendingAdded, true)
    await cp.flush()

    const state = cp.view({ history: false })
    const episode = state.wakeEpisodes['episode-1']
    assert.deepEqual(episode.pendingMessages.map((row) => row.messageId), ['message-1', 'message-2'])
    assert.deepEqual(episode.pendingMessages.map((row) => row.text), ['first', 'second'])

    const audit = readdirSync(root).find((name) => name.endsWith('.audit.jsonl'))
    assert.notEqual(audit, undefined)
    const types = readFileSync(join(root, audit), 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line).type)
    assert.deepEqual(types, ['wake/claimed', 'wake/claimed'])
  } finally {
    resetControlPlaneCache()
    rmSync(root, { recursive: true, force: true })
  }
})
