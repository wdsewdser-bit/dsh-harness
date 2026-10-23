import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './v16-capabilities-fixture.mjs'
import { initializeNativeHost } from './native-host-fixture.mjs'
import { ToolRuntime } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { apply as applyEpisodes } from '../home/profiles/web/plugins/team-v16-context-episodes.mjs'
const resolveActor = () => ({ role: 'root', workspace: 'fixture', task: 't1', taskRevision: 2, plan: 'collector-plan', planRevision: 1 })

test('retained episodes survive actual native tool-call progression but not changed authority', async t => {
  const f = await fixture(t)
  let tools, dispose
  await initializeNativeHost(f.ctx, () => {
    tools = new ToolRuntime(f.ctx)
    dispose = applyEpisodes(f.ctx, { collector: f.service, resolveActor })
  })
  t.after(() => dispose())
  const service = f.ctx.teamContextEpisodes, { ids } = await service.collect(f.agent)
  assert.equal(ids.length, 1)
  const id = ids[0], original = service.read(f.agent, id)
  const args = { operation: 'read', id }
  f.session.append('step/start', { turn: 2, step: 1 })
  f.session.append('assistant/message', { turn: 2, step: 1, stream: [], message: {
    id: 'episode-tool-request', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    content: [{ type: 'tool-call', id: 'episode-read', name: 'context_episode', arguments: JSON.stringify(args) }],
  } }, { surfaceOp: 'append' })
  f.session.append('tool/call', { turn: 2, step: 1, callId: 'episode-read', name: 'context_episode', arguments: JSON.stringify(args) })
  const execute = (arguments_, callId) => tools.execute({ name: 'context_episode', arguments: arguments_, callId,
    agent: f.agent, signal: new AbortController().signal })
  const result = await execute(args, 'episode-read')
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.deepEqual(result.value.events, original.events)
  const list = await execute({ operation: 'list' }, 'episode-list')
  assert.equal(list.value[0].id, id)
  assert.notEqual(f.service.authorityForSurface(f.session.id).capture(f.session.id).checkpoint.checkpointIntegrityHash, original.checkpointHash)
  const summary = await execute({ operation: 'summarize', id }, 'episode-summary')
  assert.match(summary.value.text, /completed but raw original/)
  assert.equal(summary.value.sourceHash, original.sourceHash)
  await f.control.mutateHot('fixture/changed-task-authority', {}, f.agent,
    state => { state.boards.global.tasks.t1.revision++ }, { deferMs: 0 })
  const stale = await execute(args, 'episode-stale')
  assert.equal(stale.isError, true)
  assert.match(JSON.stringify(stale), /EPISODE_STALE/)
})
