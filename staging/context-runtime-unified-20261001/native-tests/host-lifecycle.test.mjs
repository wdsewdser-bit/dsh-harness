import './host-lifecycle-resolve.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { Context, getHostLifecycleGate } = await import('@deepseek-ai/cordis');
const { Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { createScope, bindScopeParent, scopeParentOf } = await import('@deepseek-ai/dsh-scope');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('actual app boot prelude can mount Loader without a false competing writer', async () => {
  const ctx = new Context();
  const diagnostics = new Context();
  diagnostics.logger = ctx.logger;
  diagnostics.logger.exporter({ levels: { default: 2 }, export() {} });
  ctx.provide('dshHomePath', { fixture: true });
  ctx.on('internal/update', (_config, _noSave, next) => next(), { global: true, prepend: true });
  await ctx.plugin(Loader);
  ctx.provide('profileContext', { fixture: true });
  assert.equal(getHostLifecycleGate(ctx).snapshot().pending, false);
  await ctx.fiber.dispose();
  await diagnostics.fiber.dispose();
})

test('lifecycle observation preserves falsy rejection values', async () => {
  const [, gate] = await host();
  for (const value of [undefined, null, false, 0]) {
    let rejected = false;
    try { await gate.observeSettlement(() => Promise.reject(value)); }
    catch (error) { rejected = true; assert.equal(error, value); }
    assert.equal(rejected, true);
  }
})
async function host() { const ctx = new Context(); await tick(); return [ctx, getHostLifecycleGate(ctx)]; }
test('Fiber config and Registry delete reject before fenced side effects', async () => {
  const [ctx, gate] = await host();
  const plugin = () => {};
  const fiber = ctx.plugin(plugin, { value: 'old' }); await fiber; await tick();
  const lease = gate.acquireRead();
  assert.throws(() => fiber.update({ value: 'new' }), { code: 'HOST_WRITER_BUSY' });
  assert.equal(fiber._config.value, 'old');
  assert.throws(() => ctx.registry.delete(plugin), { code: 'HOST_WRITER_BUSY' });
  assert(ctx.registry.has(plugin));
  lease.release(); fiber.update({ value: 'new' }); await fiber.await(); await tick();
  assert.equal(fiber.config.value, 'new');
  await fiber.dispose(); await tick();
});
test('teardown requested under a read lease changes nothing until the lease is released', async () => {
  const [ctx, gate] = await host(); let cleaned = false;
  const fiber = ctx.plugin(child => { child.effect(() => () => { cleaned = true; }); }); await fiber; await tick();
  const lease = gate.acquireRead();
  fiber.dispose(); await tick();
  assert.equal(cleaned, false); lease.assert();
  lease.release(); await tick(); await tick();
  assert.equal(cleaned, true);
});
test('async native plugin remains pending through setup and effect collection', async () => {
  const [ctx, gate] = await host(); const setup = deferred(); let cleaned = false;
  const fiber = ctx.plugin(async () => { await setup.promise; return () => { cleaned = true; }; });
  await tick(); assert.equal(gate.snapshot().pending, true);
  assert.throws(() => gate.acquireRead(), { code: 'HOST_PENDING' });
  setup.resolve(); await fiber; await tick();
  assert.equal(gate.snapshot().pending, false); await fiber.dispose(); await tick(); assert(cleaned);
});
test('failed async effect stays pending through its async cleanup', async () => {
  const [ctx, gate] = await host(); const setup = deferred(), cleanup = deferred(); let started=false;
  const effect = ctx.effect(async function* () { yield async () => { started=true; await cleanup.promise; }; await setup.promise; throw new Error('setup-failed'); });
  await tick(); setup.resolve(); await tick();
  assert(started); assert(gate.snapshot().pending);
  assert.throws(() => gate.acquireRead(), { code:'HOST_PENDING' });
  cleanup.resolve(); await assert.rejects(Promise.resolve(effect), /setup-failed/); await tick(); assert.equal(gate.snapshot().pending,false);
});
test('Loader config waits before options mutation and actual async setup', async () => {
  const [ctx, gate] = await host(); const loader = new Loader(ctx); await tick();
  const setup = deferred(); loader.builtins.slow = async () => { await setup.promise; };
  const lease = gate.acquireTransition();
  const task = loader.create({id:'slow', name:'cordis:slow', config:{value:'old'}});
  await tick(); assert.equal(loader.root.data.length,0); assert.equal(loader.store.slow,undefined);
  lease.release(); await tick(); assert(gate.snapshot().pending);
  assert.equal(loader.store.slow.options.config.value,'old');
  setup.resolve(); await task; await tick(); assert.equal(gate.snapshot().pending,false);
  const read = gate.acquireRead(); const update=loader.update('slow',{config:{value:'new'}});
  await tick(); assert.equal(loader.store.slow.options.config.value,'old');
  assert.throws(() => loader.remove('slow'), {code:'HOST_WRITER_BUSY'});
  read.release(); await update; await tick(); assert.equal(loader.store.slow.options.config.value,'new');
  loader.remove('slow'); await tick();
});
test('nested awaited installation does not wait on its own host writer', async () => {
  const [ctx,gate] = await host(); let ran=false;
  const fiber=ctx.plugin(async child => { await child.plugin(async () => { await tick(); ran=true; }); });
  await fiber; await tick(); assert(ran); assert.equal(gate.snapshot().pending,false); await fiber.dispose(); await tick();
});
test('global and scoped persona sections and disposers are fenced', async () => {
  const [ctx,gate]=await host(); await ctx.plugin(SystemPrompt,{personaPrefix:'global'}); await tick();
  const global=ctx.systemPrompt.section({name:'additional',order:1,text:'additional'});
  const owner=ctx.inject(['systemPrompt'],()=>{}); await owner; await tick();
  const key={}; const scoped=createScope(owner.ctx,key); await scoped.ctx.fiber.await(); await tick();
  const local=scoped.ctx.systemPrompt.section({name:'deployment:persona-prefix',order:0,text:'local'}); await tick();
  assert.equal((await ctx.systemPrompt.assemble({scope:key})).sections.find(s=>s.name==='deployment:persona-prefix').text,'local');
  const read=gate.acquireRead(['cordis','scope','system-prompt']);
  assert.equal(local(), undefined); await tick();
  assert.equal((await ctx.systemPrompt.assemble({scope:key})).sections.find(s=>s.name==='deployment:persona-prefix').text,'local');
  assert.throws(() => scoped.ctx.systemPrompt.section({name:'other',order:1,text:'x'}),{code:'HOST_WRITER_BUSY'});
  read.release(); await tick(); await tick(); local(); await tick(); assert.equal((await ctx.systemPrompt.assemble({scope:key})).sections.find(s=>s.name==='deployment:persona-prefix').text,'global');
  global(); await scoped.dispose(); await tick();
});
test('owner survives module HMR, epoch rejects ABA and old callbacks, veto survives failure', async () => {
  const [ctx,gate]=await host(); const snap=gate.snapshot(); let called=false;
  const old=gate.callback(snap,()=>{called=true;}); gate.runSync(()=>{}); gate.runSync(()=>{});
  assert.throws(old,{code:'HOST_STALE_EPOCH'}); assert.equal(called,false);
  const hmr=await import('../app/node_modules/@deepseek-ai/cordis-v15/lib/host-lifecycle.js?hmr=1');
  assert.equal(hmr.getHostLifecycleGate(ctx),gate); assert.equal(hmr.getHostLifecycleGate(ctx).snapshot().instance,snap.instance);
  gate.revoke('security'); await assert.rejects(gate.runAsync(async()=>{throw new Error('activation-failed');}),/activation-failed/);
  assert.throws(()=>gate.acquireRead(),{code:'HOST_ADMISSION_VETO'}); gate.clearVeto(gate.snapshot());
  assert.throws(()=>gate.acquireRead(['identity']),{code:'HOST_DOMAIN_MISSING:identity'}); gate.close();
  assert.throws(()=>gate.acquireRead(),{code:'HOST_CLOSED'});
});
test('synchronous effect failure owns asynchronous partial cleanup', async () => {
  const [ctx,gate]=await host(); const cleanup=deferred(); let started=false;
  assert.throws(()=>ctx.effect(function*(){ yield async()=>{started=true; await cleanup.promise;}; throw new Error('sync-failed'); }),/sync-failed/);
  assert(started); assert(gate.snapshot().pending); cleanup.resolve(); await tick(); assert.equal(gate.snapshot().pending,false);
});
test('native failed plugin remains pending until cleanup, not its method return', async () => {
  const [ctx,gate]=await host(); const setup=deferred(),cleanup=deferred(); let cleaned=false;
  const fiber=ctx.plugin(async function*(){ yield async()=>{await cleanup.promise; cleaned=true;}; await setup.promise; throw new Error('plugin-failed'); });
  setup.resolve(); await tick(); assert(gate.snapshot().pending); assert.equal(cleaned,false);
  cleanup.resolve(); await assert.rejects(fiber.await(),/plugin-failed/); await tick(); assert(cleaned); assert.equal(gate.snapshot().pending,false);
  await fiber.dispose(); await tick();
});
test('real event callback from previous activation cannot revive after A-B-A', async () => {
  const [ctx,gate]=await host(); let calls=0;
  const fiber=ctx.plugin(child=>{child.on('hmr-probe',()=>{calls++;});},{name:'A'}); await fiber; await tick();
  const old=ctx.events._hooks['hmr-probe'][0].callback;
  fiber.update({name:'B'}); await fiber.await(); await tick(); fiber.update({name:'A'}); await fiber.await(); await tick();
  assert.throws(()=>old(),{code:'HOST_STALE_CALLBACK'}); ctx.emit('hmr-probe'); assert.equal(calls,1);
  await fiber.dispose(); await tick(); assert.throws(()=>old(),{code:'HOST_STALE_CALLBACK'}); assert.equal(gate.snapshot().pending,false);
});
test('real tool registry, scoped restrictions and guard disposal reject before mutation', async () => {
  const {ToolRuntime}=await import('../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  const [ctx,gate]=await host(); await ctx.plugin(SystemPrompt,{}); await tick();
  const tools=new ToolRuntime(ctx); const undo=tools.register({name:'probe',description:'test',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>({content:[]})},execute:()=>({})});
  const owner=ctx.inject(['tools'],()=>{}); await owner; await tick(); const scoped=createScope(owner.ctx,{}); await scoped.ctx.fiber.await(); await tick();
  const read=gate.acquireRead(['tool-registry']);
  assert.throws(()=>tools.register({name:'new',parameters:{type:'object'}}),{code:'HOST_WRITER_BUSY'});
  assert.throws(()=>scoped.ctx.tools.restrict({deny:['probe']}),{code:'HOST_WRITER_BUSY'});
  assert.throws(()=>tools.guard(()=> 'deny'),{code:'HOST_WRITER_BUSY'}); assert.equal(undo(), undefined); await tick();
  assert.throws(()=>tools.layers.global.tools.insert('raw',{name:'raw'}),{code:'HOST_WRITER_BUSY'});
  assert(tools.layers.global.tools.has('probe')); read.release(); await tick(); await tick();
  assert(!tools.layers.global.tools.has('probe')); undo(); await scoped.dispose(); await tick();
  gate.revoke('security'); assert.equal(tools.guardReason({}), 'HOST_ADMISSION_VETO');
});
test('volatile references retain old values until host transition releases', async () => {
  const {default:z}=await import('../app/node_modules/@deepseek-ai/schemastery/lib/index.mjs');
  const [ctx,gate]=await host(); const loader=new Loader(ctx); await tick(); let starts=0;
  function plugin(){ starts++; } plugin.Config=z.object({value:z.string().volatile()}); loader.builtins.volatile=plugin;
  await loader.create({id:'volatile',name:'cordis:volatile',config:{value:'old'}}); await tick();
  const entry=loader.store.volatile; const ref=entry.fiber.config.value;
  const read=gate.acquireTransition(); const task=entry.update({config:{value:'new'}});
  await tick(); assert.equal(entry.options.config.value,'old'); assert.equal(ref.get(),'old');
  assert.throws(()=>entry._commitVolatile(),{code:'HOST_WRITER_BUSY'}); read.release(); await task; await tick();
  assert.equal(ref.get(),'new'); assert.equal(starts,1); assert.equal(entry.fiber._config.value,'new'); loader.remove('volatile'); await tick();
});
test('attached scope parent rebind participates before ancestry mutation',async()=>{
  const [ctx,gate]=await host(); const parent={},child={},next={}; const binding=bindScopeParent(child,parent);
  const scoped=createScope(ctx,child); await scoped.ctx.fiber.await(); await tick(); const read=gate.acquireRead(['scope-parent']);
  assert.throws(()=>binding.rebind(next),{code:'HOST_WRITER_BUSY'}); assert.equal(scopeParentOf(child),parent);
  read.release(); binding.rebind(next); assert.equal(scopeParentOf(child),next); await scoped.dispose(); await tick();
});
test('two host readers order a third async installation and rejected setup cleanup',async()=>{
  const [ctx,gate]=await host(); const loader=new Loader(ctx); await tick(); const setup=deferred(),cleanup=deferred();
  loader.builtins.failed=async function*(){yield async()=>{await cleanup.promise;}; await setup.promise; throw new Error('loader-install-failed');};
  const one=gate.acquireRead(),two=gate.acquireRead(); const installation=loader.create({id:'failed',name:'cordis:failed'});
  const outcome=installation.then(()=>undefined,error=>error);
  one.release(); await tick(); assert.equal(loader.store.failed,undefined); two.assert(); two.release(); await tick();
  setup.resolve(); await tick(); assert(gate.snapshot().pending); assert.throws(()=>gate.acquireRead(),{code:'HOST_PENDING'});
  cleanup.resolve(); assert.match((await outcome).message,/loader-install-failed/); await tick(); assert.equal(gate.snapshot().pending,false);
  loader.remove('failed'); await tick();
});
test('disabling Loader entry stays pending through actual async disposal',async()=>{
  const [ctx,gate]=await host(); const loader=new Loader(ctx); await tick(); const cleanup=deferred();
  loader.builtins.dispose=()=>async()=>{await cleanup.promise;}; await loader.create({id:'dispose',name:'cordis:dispose'}); await tick();
  const read=gate.acquireRead(); const update=loader.store.dispose.update({disabled:true}); await tick();
  assert.equal(loader.store.dispose.options.disabled,undefined); assert.throws(()=>loader.root.remove('dispose'),{code:'HOST_WRITER_BUSY'});
  read.release(); await update; assert(gate.snapshot().pending); cleanup.resolve(); await tick(); assert.equal(gate.snapshot().pending,false);
  loader.remove('dispose'); await tick();
});
test('native tool body admission rechecks host revoke after preparation',async()=>{
  const {ToolRuntime}=await import('../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  const [ctx,gate]=await host(); await ctx.plugin(SystemPrompt,{}); await tick(); const tools=new ToolRuntime(ctx); let executed=0;
  tools.register({name:'admission',description:'test',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>({content:[]})},execute:()=>{executed++;return {};}});
  const prepared=await tools.prepareScheduledExecution({name:'admission',arguments:{},callId:'host-test',signal:new AbortController().signal});
  assert.equal(prepared.kind,'dispatch'); gate.revoke('security');
  const result=await tools.completeScheduledExecution(prepared); assert.equal(executed,0); assert(result.isError); assert.match(JSON.stringify(result),/HOST_ADMISSION_VETO/);
});
