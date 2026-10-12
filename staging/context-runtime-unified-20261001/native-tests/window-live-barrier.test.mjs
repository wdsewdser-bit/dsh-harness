import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { SessionStore } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { createJsonlWindowBarrier } from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js'
import { initializeNativeHost } from './native-host-fixture.mjs'
const require=createRequire(new URL('../app/package.json',import.meta.url))
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))

async function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'native-live-window-barrier-')),ctx=new Context()
  let handle
  t.after(async()=> {
    try { await handle?.close() } finally {
      try { await ctx.fiber.dispose() } finally { rmSync(root,{recursive:true,force:true}) }
    }
  })
  return initializeNativeHost(ctx,async()=> {
    const sessions=new SessionStore(ctx),backend=new Jsonl(ctx,{root,compression:'none'})
    const session=sessions.create('live-window-barrier',{meta:{cwd:root}})
    handle=await backend.create(session.header)
    session.append('user/message',{id:'original',role:'user',source:{kind:'user'},content:[{type:'text',text:'original routed history'}]},{surfaceOp:'append'})
    return {ctx,sessions,backend,session,handle}
  })
}

test('live barrier reuses the active routed writer without appending its buffered events twice',async t=> {
  const f=await fixture(t)
  const existing=createJsonlWindowBarrier(f.handle,f.session)
  await existing.persist()
  await f.ctx.sessions.flush(f.session)
  assert.deepEqual(await existing.read(),f.session.snapshotEvents())
  assert.equal(typeof f.backend.windowBarrierFor,'function')
  const barrier=await f.backend.windowBarrierFor(f.session,{isolated:true,sessionId:f.session.id})
  const first=await barrier.persist()
  assert.equal(first.durable,true)
  assert.deepEqual(await barrier.read(),f.session.snapshotEvents())
  f.session.append('native/window-aborted',{transitionId:'fixture',reason:'boundary-test',intentHash:'fixture'})
  await barrier.persist()
  await f.ctx.sessions.flush(f.session)
  assert.deepEqual(await barrier.read(),f.session.snapshotEvents())
  assert.equal(f.backend.tracker.writers.get(f.session.id),f.handle)
  await assert.rejects(f.backend.open(f.session.id,'write'),/already.*owned|already.*write|active write/i)
  const direct=createJsonlWindowBarrier(f.handle,f.session)
  f.session.append('user/message',{id:'tail',role:'user',source:{kind:'user'},content:[{type:'text',text:'safe tail'}]},{surfaceOp:'append'})
  await direct.persist()
  await f.ctx.sessions.flush(f.session)
  assert.deepEqual(await direct.read(),f.session.snapshotEvents())
})

test('live barrier refuses foreign identity, missing opt-in and stale writer before mutation',async t=> {
  const f=await fixture(t)
  assert.equal(typeof f.backend.windowBarrierFor,'function')
  await assert.rejects(f.backend.windowBarrierFor(f.session,{isolated:false,sessionId:f.session.id}),/WINDOW/)
  await assert.rejects(f.backend.windowBarrierFor({...f.session},{isolated:true,sessionId:f.session.id}),/WINDOW/)
  const barrier=await f.backend.windowBarrierFor(f.session,{isolated:true,sessionId:f.session.id})
  await barrier.persist()
  await f.handle.close()
  await assert.rejects(barrier.persist(),/WINDOW|closed/)
  await assert.rejects(barrier.read(),/WINDOW|closed/)
})
