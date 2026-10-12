import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { apply, installRequestMessageProjection } from '../home/profiles/web/plugins/request-message-projection.mjs'

const profileRequire = createRequire(new URL('../home/profiles/web/package.json', import.meta.url))
const appRequire = createRequire(new URL('../app/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/cordis')).href)
const profileLlm = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-llm')).href)
// A distinct cache key loads the real official module with its own class and
// WeakSet, even when canonical preload correctly unifies profile/app aliases.
const appLlmUrl = pathToFileURL(appRequire.resolve('@deepseek-ai/dsh-llm'))
appLlmUrl.searchParams.set('fixture', 'independent-official-brand')
const appLlm = await import(appLlmUrl.href)
const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values }
const message = (text, llm = profileLlm) => llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const append = suffix => options => ({ messages: options.messages.map(m => ({ ...m, content: [...m.content, { type: 'text', text: suffix }] })), audit: { savedBytes: 4, sensitiveText: 'DO-NOT-AUDIT-BODY' } })

test('adapter validators are synchronous request-local vetoes, not dispatch observers', async () => {
  for (const rejectedStage of ['before','after','async']) {
    const state = runtime(), bridge = installRequestMessageProjection(state.llm,profileLlm), stages = []
    let observed = 0
    bridge.register('strict-adapter-validation',input=>({messages:input.messages}),{
      validateAdapter({stage,options:actual,inputOptions,result}) {
        stages.push(stage)
        assert.equal(result.messages,inputOptions.messages)
        assert.equal(actual.sessionId,inputOptions.sessionId)
        if (rejectedStage === 'async') return Promise.resolve()
        if (stage === rejectedStage) throw Object.assign(new Error('validation veto'),{code:'VALIDATOR_VETO'})
      },onDispatch(){observed++},
    })
    const chunks = await collect(state.llm.stream(options()))
    assert.equal(state.counter.dispatches,0)
    assert.equal(observed,0)
    assert.equal(bridge.audit().at(-1).handedToAdapter,false)
    assert.equal(chunks.at(-1).reason.kind,'error')
    assert.deepEqual(stages,rejectedStage==='after'?['before','after']:['before'])
    bridge.dispose();state.unregister()
  }
})

test('separately prepared plans sharing a signal validate only their own transform result', async () => {
  const state = runtime(), bridge = installRequestMessageProjection(state.llm,profileLlm), seen = []
  bridge.register('native-plan-binding',input=>({messages:input.messages,tag:input.messages[0].content[0].text}),{
    validateAdapter({stage,result,inputOptions}) {
      assert.equal(result.tag,inputOptions.messages[0].content[0].text)
      seen.push(stage+':'+result.tag)
    },
  })
  const a = options(profileLlm,'first'), b = {...options(profileLlm,'second'),signal:a.signal}
  const pa = bridge.prepare(a), pb = bridge.prepare(b)
  await collect(state.llm.stream(pa.options)); await collect(state.llm.stream(pb.options))
  assert.equal(state.counter.dispatches,2)
  assert.deepEqual(seen,['before:first','after:first','before:second','after:second'])
  bridge.dispose();state.unregister()
})

function runtime(module = profileLlm, chunks = [{ type: 'text-delta', text: 'fixture' }, { type: 'finish', reason: { kind: 'stop' } }]) {
  const ctx = new Context()
  const llm = new module.LlmRuntime(ctx)
  const captures = []
  const counter = { preparations: 0, dispatches: 0 }
  const adapter = generation => new class extends module.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async prepareCall(provider, model) {
      counter.preparations++
      return { model: { provider, id: model, name: model }, stream(options) {
        counter.dispatches++
        captures.push({ generation, options })
        return (async function* () { yield* chunks })()
      } }
    }
  }()
  const unregister = llm.registerAdapter(['fixture'], adapter('A'))
  return { ctx, llm, captures, counter, unregister, adapter, chunks }
}

function options(module = profileLlm, text = 'original') {
  return { provider: 'fixture', model: 'fixture-model', messages: [message(text, module)], signal: new AbortController().signal }
}

test('real prepared frozen request reaches adapter with ordered messages, original brand and exact other property identities', async () => {
  const state = runtime()
  const dispose = await apply(state.ctx)
  const service = state.ctx.requestMessageProjection
  service.register('second', append('second'), { order: 20 })
  service.register('first', input => ({ ...append('first')(input), provider: 'must-be-ignored', model: 'must-be-ignored', signal: null }), { order: 10 })
  const prepared = await state.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  const tools = Object.freeze([{ name: 'fixture-tool', description: 'fixture', parameters: { type: 'object' } }])
  const toolHistory = Object.freeze({ fixture: true })
  const extra = { preserved: true }
  const base = { ...options(), tools, toolHistory, extra, ...prepared.config }
  Object.defineProperty(base, 'hiddenAttribute', { value: extra, enumerable: false })
  base[Symbol('preserved-attribute')] = extra
  const request = Object.freeze(profileLlm.markAgentLoopRequest(base))
  const originalMessages = request.messages
  const observed = []
  const unhook = state.ctx.on('llm/stream', (request, next) => { observed.push(request); return next() }, { global: true })
  const values = await collect(prepared.stream(request))
  const received = state.captures[0].options
  assert.equal(state.counter.dispatches, 1)
  assert.equal(state.counter.preparations, 1)
  assert.deepEqual(received.messages[0].content.map(b => b.text), ['original', 'first', 'second'])
  assert.notEqual(received, request)
  assert.equal(Object.isFrozen(received), true)
  assert.equal(Object.isFrozen(received.messages[0].content), true)
  assert.equal(request.messages, originalMessages)
  assert.deepEqual(request.messages[0].content.map(b => b.text), ['original'])
  assert.equal(profileLlm.isAgentLoopRequest(received), true)
  for (const key of Reflect.ownKeys(request).filter(key => key !== 'messages')) assert.equal(received[key], request[key])
  assert.equal(Object.isFrozen(extra), false)
  assert.equal(observed[0], received)
  values.forEach((chunk, index) => assert.equal(chunk, state.chunks[index]))
  assert.throws(() => prepared.stream(request), { code: 'INVALID_PREPARED_CALL' })
  assert.equal(state.counter.dispatches, 1)
  assert.ok(!JSON.stringify(service.audit(received)).includes('DO-NOT-AUDIT-BODY'))
  assert.deepEqual(service.audit(received).transforms.map(row => row.id), ['first', 'second'])
  assert.match(service.stats().moduleHash, /^[a-f0-9]{64}$/)
  unhook(); await dispose(); state.unregister()
})

test('prepared adapter generation remains A after registration replacement and only one dispatch occurs', async () => {
  const state = runtime()
  const dispose = await apply(state.ctx)
  dispose.service.register('projection', append('projected'))
  const prepared = await state.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  state.unregister()
  const replacement = state.llm.registerAdapter(['fixture'], state.adapter('B'))
  await collect(prepared.stream({ ...options(), ...prepared.config }))
  assert.equal(state.captures[0].generation, 'A')
  assert.equal(state.counter.preparations, 1)
  assert.equal(state.counter.dispatches, 1)
  assert.equal(profileLlm.isAgentLoopRequest(state.captures[0].options), false)
  replacement(); await dispose()
})

test('entry wrapper preserves internal prepared object and Cordis caller shadow receiver', async () => {
  const state = runtime()
  const original = state.llm.streamWithRegistration
  const calls = []
  state.llm.streamWithRegistration = function(request, prepared) {
    calls.push({ request, prepared, context: this.ctx })
    return original.call(this, request, prepared)
  }
  const dispose = await apply(state.ctx)
  dispose.service.register('projection', append('projected'))
  const caller = state.ctx.extend({ fixtureCaller: 'scoped-caller' })
  const prepared = await caller.llm.prepareCall({ provider: 'fixture', model: 'fixture-model' })
  const request = Object.freeze({ ...options(), ...prepared.config })
  await collect(prepared.stream(request))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].prepared.config, prepared.config)
  assert.equal(calls[0].context.fixtureCaller, 'scoped-caller')
  assert.equal(calls[0].request.signal, request.signal)
  assert.equal(state.counter.dispatches, 1)
  await dispose(); state.unregister()
})

test('unrecognized and asynchronous transforms fail open without mutating mutable caller messages', async () => {
  const state = runtime()
  const dispose = await apply(state.ctx)
  const original = options()
  original.messages = structuredClone(original.messages)
  const originalJson = JSON.stringify(original.messages)
  dispose.service.register('mutation', input => { input.messages[0].content[0].text = 'mutated'; return { messages: input.messages } })
  dispose.service.register('invalid', () => ({ messages: 'invalid' }))
  dispose.service.register('async', async () => { throw new Error('private-error-body') })
  await collect(state.llm.stream(original))
  assert.equal(state.captures[0].options, original)
  assert.equal(JSON.stringify(original.messages), originalJson)
  assert.equal(Object.isFrozen(original.messages), false)
  assert.deepEqual(dispose.service.audit(original).transforms.map(row => row.status), ['failed-open', 'skipped-invalid-result', 'skipped-async-transform'])
  assert.ok(!JSON.stringify(dispose.service.audit()).includes('private-error-body'))
  await dispose(); state.unregister()
})

test('malformed returned messages fail open transactionally between valid transforms', async () => {
  const state = runtime()
  const dispose = await apply(state.ctx)
  dispose.service.register('first', append('first'))
  dispose.service.register('malformed', input => ({ messages: input.messages.map(m => ({ ...m, content: [null] })) }))
  dispose.service.register('last', append('last'))
  const original = options()
  await collect(state.llm.stream(original))
  assert.deepEqual(state.captures[0].options.messages[0].content.map(b => b.text), ['original', 'first', 'last'])
  assert.deepEqual(dispose.service.audit(original).transforms.map(row => row.status), ['applied', 'failed-open', 'applied'])
  assert.deepEqual(original.messages[0].content.map(b => b.text), ['original'])
  await dispose(); state.unregister()
})

test('original middleware errors preserve identity and adapter failure normalization stays official', async () => {
  const state = runtime()
  const dispose = await apply(state.ctx)
  dispose.service.register('projection', append('projected'))
  const error = new Error('middleware failure')
  const unregisterHook = state.ctx.on('llm/stream', () => { throw error }, { global: true })
  assert.throws(() => state.llm.stream(options()), caught => caught === error)
  assert.equal(state.counter.dispatches, 0)
  unregisterHook()
  state.unregister()
  const adapterFailure = new profileLlm.LlmError('adapter failure', 'FIXTURE_FAILURE')
  const adapter = state.adapter('failed')
  adapter.prepareCall = async () => { throw adapterFailure }
  const release = state.llm.registerAdapter(['fixture'], adapter)
  const chunks = await collect(state.llm.stream(options()))
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'FIXTURE_FAILURE')
  release(); await dispose()
})

test('unload preserves existing iterator; reload restores transforms without layering methods', async () => {
  const state = runtime()
  const originalMethod = state.llm.streamWithRegistration
  const dispose = await apply(state.ctx)
  dispose.service.register('one', append('one'))
  const iterator = state.llm.stream(options())[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value, state.chunks[0])
  await dispose()
  assert.equal(state.llm.streamWithRegistration, originalMethod)
  assert.equal((await iterator.next()).value, state.chunks[1])
  await iterator.next()
  assert.equal(state.counter.dispatches, 1)
  const reloaded = await apply(state.ctx)
  const remove = reloaded.service.register('two', append('two'))
  await collect(state.llm.stream(options()))
  assert.deepEqual(state.captures[1].options.messages[0].content.map(b => b.text), ['original', 'two'])
  remove(); remove()
  await collect(state.llm.stream(options()))
  assert.deepEqual(state.captures[2].options.messages[0].content.map(b => b.text), ['original'])
  await reloaded(); state.unregister()
})

test('real Cordis dependent plugins re-register after provider HMR restart', async () => {
  const state = runtime()
  const provider = state.ctx.plugin({ name: 'projection-provider-fixture', inject: ['llm'], apply })
  await provider.await()
  const counts = { loaded: 0, unloaded: 0 }
  const consumer = state.ctx.plugin({
    name: 'projection-consumer-fixture', inject: ['requestMessageProjection'],
    apply(ctx) {
      counts.loaded++
      ctx.effect(() => ctx.requestMessageProjection.register('consumer', append('consumer')))
      return () => { counts.unloaded++ }
    },
  })
  await consumer.await()
  assert.equal(state.ctx.requestMessageProjection.stats().registrations, 1)
  await collect(state.llm.stream(options()))
  await provider.restart()
  await consumer.await()
  assert.deepEqual(counts, { loaded: 2, unloaded: 1 })
  assert.equal(state.ctx.requestMessageProjection.stats().registrations, 1)
  await collect(state.llm.stream(options()))
  assert.equal(state.counter.dispatches, 2)
  assert.deepEqual(state.captures[1].options.messages[0].content.map(b => b.text), ['original', 'consumer'])
  await provider.dispose()
  assert.equal(counts.unloaded, 2)
  await consumer.dispose(); state.unregister()
})

test('dispose restores the original own descriptor and never overwrites a later wrapper', async () => {
  const state = runtime()
  const own = { value: state.llm.streamWithRegistration, configurable: true, writable: false, enumerable: true }
  Object.defineProperty(state.llm, 'streamWithRegistration', own)
  const dispose = await apply(state.ctx)
  await dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(state.llm, 'streamWithRegistration'), own)
  const second = await apply(state.ctx)
  const later = () => 'later'
  Object.defineProperty(state.llm, 'streamWithRegistration', { value: later, configurable: true, writable: true })
  await second()
  assert.equal(state.llm.streamWithRegistration, later)
  state.unregister()
})

test('separately loaded official runtime uses its own brand weak set; auxiliary routing attributes remain exact', async () => {
  const state = runtime(appLlm)
  const dispose = await apply(state.ctx, { resolveLlmModule: () => appLlm })
  dispose.service.register('projection', append('projected'))
  const branded = Object.freeze(appLlm.markAgentLoopRequest(options(appLlm)))
  await collect(state.llm.stream(branded))
  assert.equal(appLlm.isAgentLoopRequest(state.captures[0].options), true)
  assert.equal(profileLlm.isAgentLoopRequest(state.captures[0].options), false)
  const auxiliary = { ...options(appLlm), purpose: 'compaction', maxTokens: 23, temperature: 0.5, stop: ['END'], system: 'auxiliary', sessionId: 'fixture-session' }
  await collect(state.llm.stream(auxiliary))
  const received = state.captures[1].options
  assert.equal(appLlm.isAgentLoopRequest(received), false)
  for (const key of Object.keys(auxiliary).filter(key => key !== 'messages')) assert.equal(received[key], auxiliary[key])
  assert.equal(Object.isFrozen(auxiliary.stop), false)
  assert.equal(Object.isFrozen(received), false)
  await dispose(); state.unregister()
})

test('unsupported runtime is rejected before service provision and duplicate bridge is explicit', async () => {
  let provided = 0
  await assert.rejects(apply({ llm: {}, provide() { provided++ } }), { code: 'REQUEST_MESSAGE_PROJECTION_BOUNDARY_UNAVAILABLE' })
  assert.equal(provided, 0)
  const state = runtime()
  assert.throws(() => installRequestMessageProjection(state.llm, appLlm), { code: 'REQUEST_MESSAGE_PROJECTION_LLM_MODULE_MISMATCH' })
  const first = installRequestMessageProjection(state.llm, profileLlm)
  assert.throws(() => installRequestMessageProjection(state.llm, profileLlm), { code: 'REQUEST_MESSAGE_PROJECTION_ALREADY_INSTALLED' })
  first.dispose(); state.unregister()
})
