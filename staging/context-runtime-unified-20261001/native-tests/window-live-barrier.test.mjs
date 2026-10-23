import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Session, SessionStore } from '../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import Jsonl from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import { createJsonlWindowBarrier } from '../app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/window-barrier.js'
import { initializeNativeHost } from './native-host-fixture.mjs'
const require=createRequire(new URL('../app/package.json',import.meta.url))
const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))

async function fixture(t, { routed = true } = {}) {
  const root=mkdtempSync(join(tmpdir(),'native-live-window-barrier-')),ctx=new Context()
  let handle
  t.after(async()=> {
    try { await handle?.close() } finally {
      try { await ctx.fiber.dispose() } finally { rmSync(root,{recursive:true,force:true}) }
    }
  })
  return initializeNativeHost(ctx,async()=> {
    const sessions=new SessionStore(ctx),backend=new Jsonl(ctx,{root,compression:'none'})
    const session=routed ? sessions.create('live-window-barrier',{meta:{cwd:root}}) : Session.create('standalone-window-barrier')
    handle=await backend.create(session.header)
    session.append('user/message',{id:'original',role:'user',source:{kind:'user'},content:[{type:'text',text:'original routed history'}]},{surfaceOp:'append'})
    return {ctx,sessions,backend,session,handle}
  })
}

test('separate standalone barriers on one writer serialize snapshot and suffix append together',async t=> {
  const f=await fixture(t,{routed:false})
  const first=createJsonlWindowBarrier(f.handle,f.session),second=createJsonlWindowBarrier(f.handle,f.session)
  const results=await Promise.all([first.persist(),second.persist()])
  assert.ok(results.every(row=>row.durable))
  assert.deepEqual(await first.read(),f.session.snapshotEvents())
  f.session.append('user/message',{id:'tail',role:'user',source:{kind:'user'},content:[{type:'text',text:'later suffix'}]},{surfaceOp:'append'})
  await Promise.all([second.persist(),first.persist()])
  assert.deepEqual(await second.read(),f.session.snapshotEvents())
})

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

test('a slow writer-handle read cannot mistake a later concurrent append for physical log shrinkage',async t=> {
  const f=await fixture(t),barrier=createJsonlWindowBarrier(f.handle,f.session)
  await barrier.persist()
  const prefix=f.session.snapshotEvents()
  let release,captured
  const paused=new Promise(resolve=>{captured=resolve}),resume=new Promise(resolve=>{release=resolve})
  const originalRead=f.backend.readStoredLog.bind(f.backend)
  let hold=true
  f.backend.readStoredLog=async(...args)=>{
    const result=await originalRead(...args)
    if(hold){hold=false;captured();await resume}
    return result
  }
  let appendStarted=false
  const originalPersist=f.backend.persistBatch.bind(f.backend)
  f.backend.persistBatch=async(...args)=>{appendStarted=true;return originalPersist(...args)}
  const read=f.handle.read().then(value=>({value}),error=>({error}))
  await paused
  f.session.append('user/message',{id:'concurrent-tail',role:'user',source:{kind:'user'},content:[{type:'text',text:'concurrent append'}]},{surfaceOp:'append'})
  const append=f.handle.drainLive()
  await new Promise(resolve=>setImmediate(resolve))
  if(appendStarted)await append
  release()
  const result=await read
  await append
  assert.equal(result.error,undefined,'a prior read snapshot is not evidence that the physical log shrank')
  assert.deepEqual(result.value.events,prefix)
  assert.deepEqual((await f.handle.read()).events,f.session.snapshotEvents())
  assert.equal((await barrier.persist()).durable,true)
})

test('the same handle still rejects genuine physical truncation after a newer prefix was observed',async t=> {
  const f=await fixture(t),barrier=createJsonlWindowBarrier(f.handle,f.session)
  await barrier.persist()
  const file=await f.backend.resolveCurrentLog(f.session.id),before=readFileSync(file)
  f.session.append('user/message',{id:'durable-tail',role:'user',source:{kind:'user'},content:[{type:'text',text:'persist before truncation'}]},{surfaceOp:'append'})
  await barrier.persist()
  writeFileSync(file,before)
  await assert.rejects(f.handle.read(),/stored log shrank below a previously observed prefix/)
})
