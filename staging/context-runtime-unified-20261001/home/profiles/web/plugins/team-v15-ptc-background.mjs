import { Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installNativeSessionBridge, nativeSessionBridge } from '../../../../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

export const name = 'team-v15-ptc-background'
export const inject = ['agents', 'sessions', 'tools', 'jobs']
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = value => createHash('sha256').update(value).digest('hex')
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed-out', 'unknown'])
const latestJobs = session => {
  const rows = new Map()
  for (const event of session.log) if (event.type === 'native/ptc-job') rows.set(event.data.rootCallId, event.data)
  return rows
}

// Jobs keep ownership, cancellation and first-wins settlement. The native
// journal and verified result file, not the best-effort jobs index, are authority.
export class PtcBackground extends Service {
  constructor(ctx, config) {
    super(ctx, 'ptcBackground')
    this.hostCtx = ctx
    this.jobs = ctx.jobs
    if (!Array.isArray(config.sessionIds) || !config.sessionIds.length || !isAbsolute(config.resultDirectory ?? '')) fail('PTC_BACKGROUND_EXACT_OPT_IN_REQUIRED')
    this.config = config
    this.allowed = new Set(config.sessionIds)
    mkdirSync(config.resultDirectory, { recursive: true })
    this.directory = realpathSync(config.resultDirectory)
    this.live = new Map()
    this.closingOwners = new WeakSet()
    this.ownerCapabilities = new WeakMap()
    this.installed = new WeakSet()
    this.installing = new WeakMap()
    this.pendingCollections = new WeakMap()
    this.transitions = new Map()
    this.recoveries = new WeakMap()
    ctx.on('agent/created', ({ agent }) => this.install(agent))
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (this.allowed.has(agent.session.id)) await this.recover(agent)
      return next()
    })
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      const row = this.pendingCollections.get(exec)
      if (row && !result.isError && decision.kind === 'accept') {
        const effect = exec.agent.session.log.findLast(event => event.type === 'native/tool-effect' && event.data.callId === exec.callId)
        if (effect?.data.effectOutcome !== 'succeeded') fail('PTC_COLLECTION_EFFECT_UNPROVEN')
        await this.mark(exec.agent, { ...row, action: 'consumed', collectionCallId: exec.callId })
      }
      return decision
    })
  }
  actor(agent, requireBridge = true) {
    if (!this.allowed.has(agent?.session?.id) || this.hostCtx.agents.get(agent.id) !== agent
      || agent.session.header.parentSession || agent.session.header.delegationDepth > 0) fail('PTC_BACKGROUND_ACTOR_DENIED')
    const membership = this.hostCtx.get('agentTeams')?.tryMembership(agent)
    if (membership ? Number(membership.tier ?? 0) !== 0 : this.config.allowOrdinary !== true) fail('PTC_BACKGROUND_ROOT_REQUIRED')
    if (requireBridge) return nativeSessionBridge(agent.session) ?? fail('PTC_BACKGROUND_NATIVE_BRIDGE_REQUIRED')
  }
  handles(exec) { return !exec.parent && this.allowed.has(exec.agent?.session?.id) }
  async install(agent) {
    if (!this.allowed.has(agent.session.id) || this.installed.has(agent)) return
    if (this.installing.has(agent)) return this.installing.get(agent)
    const operation = this.installOnce(agent)
    this.installing.set(agent, operation)
    try { return await operation } finally { this.installing.delete(agent) }
  }
  async installOnce(agent) {
    this.actor(agent, false)
    let bridge = nativeSessionBridge(agent.session)
    if (!bridge) {
      const persistence = this.hostCtx.get('sessionPersistence')
      if (typeof persistence?.windowBarrierFor !== 'function') fail('PTC_BACKGROUND_JSONL_BARRIER_REQUIRED')
      const barrier = await persistence.windowBarrierFor(agent.session, { isolated: true, sessionId: agent.session.id })
      bridge = nativeSessionBridge(agent.session) ?? installNativeSessionBridge(agent.session, {
        isolated: true, sessionId: agent.session.id, flush: async () => (await barrier.persist()).durable === true,
      })
    }
    await bridge.requireDurable()
    if (typeof agent.registerBackgroundDrain !== 'function') fail('PTC_BACKGROUND_OWNER_DRAIN_REQUIRED')
    const capability = Object.freeze({ agent, bridge })
    this.ownerCapabilities.set(agent, capability)
    agent.registerBackgroundDrain(() => this.drainOwner(agent, capability))
    this.installed.add(agent)
    const disposePolicy = bridge.registerInputPreemption((target, message) => {
      if (target !== agent || this.config.teamInstant !== true) return false
      const teams = this.hostCtx.get('agentTeams'), member = teams?.tryMembership(agent), source = message.source
      if (!member) return false
      if (source?.kind === 'team-wake') return source.plugin === 'team-tools-v2-r10' && source.form === 'action'
      if (source?.kind !== 'team-message' || source.teamId !== member.root?.id || typeof source.messageId !== 'string') return false
      return teams.listMembers(agent).some(row => row.id === source.senderId)
    })
    agent.ctx.effect(() => disposePolicy)
    agent.ctx.tools.register({ name: 'ptc_job_result', description: 'Collect an owned PTC result receipt after its completion notice. Never reruns a program.',
      parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'], additionalProperties: false },
      output: { schema: {}, render: (_, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      execute: (args, exec) => this.collect(args.job_id, exec) })
    await this.recover(agent)
  }
  async mark(agent, data, state) {
    const key = agent.session.id + ':' + data.rootCallId
    // A live admitted job retains its exact bridge through terminal persistence and provider unload.
    const owned = state && this.live.get(key) === state && state.agent === agent
    const bridge = owned ? state.bridge : this.actor(agent)
    const operation = (this.transitions.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const current = latestJobs(agent.session).get(data.rootCallId)
      if (['notified', 'consumed'].includes(data.action) && current?.action === 'consumed'
        || data.action === 'notified' && current?.action === 'notified') {
        await bridge.requireDurable()
        return current
      }
      agent.session.append('native/ptc-job', data)
      await bridge.requireDurable()
      return data
    })
    this.transitions.set(key, operation)
    try { return await operation } finally { if (this.transitions.get(key) === operation) this.transitions.delete(key) }
  }
  resultPath(agent, rootCallId, status) {
    const directory = join(this.directory, hash(agent.session.id))
    mkdirSync(directory, { recursive: true })
    const physical = realpathSync(directory), delta = relative(this.directory, physical)
    if (isAbsolute(delta) || delta.startsWith('..')) fail('PTC_RESULT_SCOPE_DENIED')
    return join(physical, hash(rootCallId) + (status === 'unknown' ? '.unknown' : '') + '.json')
  }
  save(agent, rootCallId, value) {
    const path = this.resultPath(agent, rootCallId, value.status), text = JSON.stringify(value), sha256 = hash(text)
    if (existsSync(path)) {
      if (realpathSync(path) !== path || hash(readFileSync(path)) !== sha256) fail('PTC_RESULT_CONFLICT')
      return { path, sha256 }
    }
    const temporary = path + '.' + process.pid + '.tmp', fd = openSync(temporary, 'wx')
    try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    if (realpathSync(path) !== path || hash(readFileSync(path)) !== sha256) fail('PTC_RESULT_READBACK_MISMATCH')
    return { path, sha256 }
  }
  read(agent, row) {
    const path = this.resultPath(agent, row.rootCallId, row.status)
    if (row.resultRef?.path !== path || realpathSync(path) !== path) fail('PTC_RESULT_SCOPE_DENIED')
    const bytes = readFileSync(path)
    if (hash(bytes) !== row.resultRef.sha256) fail('PTC_RESULT_READBACK_MISMATCH')
    return JSON.parse(bytes)
  }
  async notify(agent, row, state) {
    this.read(agent, row)
    const inputId = 'ptc-result-' + row.receiptId
    await agent.steer(createUserMessage({ source: { kind: 'ptc-background', rpcId: inputId, form: 'receipt' },
      content: [{ type: 'text', text: JSON.stringify({ kind: 'ptc-completion', jobId: row.jobId,
        rootCallId: row.rootCallId, status: row.status, receiptId: row.receiptId, resultRef: row.resultRef }) }] }))
    await this.mark(agent, { ...row, action: 'notified', notificationInputId: inputId }, state)
  }
  async recover(agent) {
    if (this.recoveries.has(agent)) return this.recoveries.get(agent)
    const operation = this.recoverOnce(agent)
    this.recoveries.set(agent, operation)
    try { return await operation } finally { this.recoveries.delete(agent) }
  }
  async recoverOnce(agent) {
    const bridge = this.actor(agent)
    await bridge.requireDurable()
    for (let row of latestJobs(agent.session).values()) {
      if (this.live.has(agent.session.id + ':' + row.rootCallId) || row.action === 'consumed' || row.action === 'notified') continue
      if (!terminal.has(row.status)) {
        // A file without its terminal journal receipt is evidence of a crash
        // boundary, not authority to declare the program completed.
        const orphanPath = this.resultPath(agent, row.rootCallId)
        let uncommittedResultRef
        if (existsSync(orphanPath)) {
          if (realpathSync(orphanPath) !== orphanPath) fail('PTC_RESULT_SCOPE_DENIED')
          uncommittedResultRef = { path: orphanPath, sha256: hash(readFileSync(orphanPath)) }
        }
        const resultRef = this.save(agent, row.rootCallId, { status: 'unknown', code: 'PTC_OWNER_PROCESS_LOST',
          ...(uncommittedResultRef ? { uncommittedResultRef } : {}),
          effects: agent.session.log.filter(event => event.type === 'native/tool-effect' && event.data.rootCallId === row.rootCallId)
            .map(event => ({ seq: event.seq, callId: event.data.callId, effectOutcome: event.data.effectOutcome })) })
        row = await this.mark(agent, { ...row, action: 'settled', status: 'unknown', resultRef,
          receiptId: hash(JSON.stringify({ rootCallId: row.rootCallId, resultRef })) })
      }
      await this.notify(agent, row)
    }
  }
  async collect(jobId, exec) {
    this.actor(exec.agent)
    const row = [...latestJobs(exec.agent.session).values()].find(row => row.jobId === jobId)
    if (!row) fail('PTC_JOB_NOT_OWNED')
    if (!terminal.has(row.status)) fail('PTC_JOB_STILL_RUNNING')
    const value = this.read(exec.agent, row)
    if (row.action !== 'consumed') this.pendingCollections.set(exec, row)
    for (const context of value.contexts ?? []) exec.deferContext(context)
    const { contexts, ...content } = value
    const result = { jobId, receiptId: row.receiptId, resultRef: row.resultRef, ...content }
    const bytes = Buffer.byteLength(JSON.stringify(result))
    if (bytes <= 4096) return result
    return { jobId, receiptId: row.receiptId, resultRef: row.resultRef, status: row.status, artifactOnly: true, bytes,
      ...(value.error ? { error: { code: value.error.code, message: value.error.message.slice(0, 512) } } : {}) }
  }
  async drainOwner(agent, capability) {
    if (this.ownerCapabilities.get(agent) !== capability || capability?.agent !== agent) fail('PTC_BACKGROUND_OWNER_DRAIN_DENIED')
    this.closingOwners.add(agent)
    const states = [...this.live.values()].filter(state => state.agent === agent)
    for (const state of states) if (!state.terminal) {
      if (state.jobId) this.jobs.kill(state.jobId, agent.session.id, 'PTC owner teardown')
      else state.cancel('PTC owner teardown')
    }
    const outcomes = await Promise.allSettled(states.map(async state => {
      await state.completion.promise
      if (state.jobWait) await state.jobWait
    }))
    const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason)
    if (errors.length) throw Object.assign(new AggregateError(errors, 'PTC_OWNER_DRAIN_FAILED'), { code: 'PTC_OWNER_DRAIN_FAILED' })
  }
  async run(exec, operation, controller) {
    const agent = exec.agent, bridge = this.actor(agent), key = agent.session.id + ':' + exec.rootCallId
    if (this.closingOwners.has(agent)) fail('PTC_BACKGROUND_OWNER_CLOSING')
    if (this.live.has(key) || latestJobs(agent.session).has(exec.rootCallId)) fail('PTC_ROOT_CALL_ALREADY_STARTED')
    if (agent.phase.kind !== 'running') fail('PTC_BACKGROUND_OPEN_STEP_REQUIRED')
    const generation = bridge.samplingGeneration, detached = Promise.withResolvers(), finished = Promise.withResolvers()
    const completion = Promise.withResolvers()
    completion.promise.catch(() => {})
    const state = { agent, bridge, completion, generation, terminal: false, cancellationRequested: false, detaching: null, contexts: [], row: null,
      cancel: reason => {
        if (state.terminal) return
        state.cancellationRequested = true
        controller.abort(reason)
      } }
    this.live.set(key, state)
    const originalDefer = exec.deferContext
    exec.deferContext = context => state.detaching ? state.contexts.push(context) : originalDefer(context)
    const unsubscribe = bridge.subscribe(() => {
      if (state.terminal || state.detaching || bridge.generation === generation || !state.row) return
      const triggerSeq = bridge.inputCursor
      state.detaching = this.mark(agent, { ...state.row, action: 'detached', detachedAtGeneration: bridge.generation, triggerSeq }, state)
        .then(row => { state.row = row; detached.resolve({ logs: [], result: { kind: 'ptc-background',
          status: 'running', jobId: row.jobId, rootCallId: row.rootCallId } }) })
      state.detaching.catch(error => detached.reject(error))
    })
    let jobId
    try {
      jobId = this.jobs.start({ kind: 'ptc-' + hash(key), label: exec.arguments.description, owner: agent.session.id, run: handle => {
        const done = (async () => {
          let value, error
          try {
            state.row = { version: 1, sessionId: agent.session.id, rootCallId: exec.rootCallId,
              jobId: handle.id, generation, turn: agent.phase.turn, step: agent.phase.step, action: 'started', status: 'running' }
            await this.mark(agent, state.row, state)
            if (bridge.generation !== generation) fail('NATIVE_ADMISSION_CLOSED')
            value = await operation()
          } catch (caught) { error = caught }
          state.terminal = true
          if (state.detaching) await state.detaching
          const status = state.cancellationRequested ? 'cancelled' : error ? error.failureKind === 'timeout' ? 'timed-out' : 'failed' : 'succeeded'
          const resultRef = this.save(agent, exec.rootCallId, { status,
            ...(error ? { error: { code: error.code ?? 'PTC_RUN_FAILED', message: error.message } } : { value }), contexts: state.contexts,
            effects: agent.session.log.filter(event => event.type === 'native/tool-effect' && event.data.rootCallId === exec.rootCallId && event.data.callId !== exec.rootCallId)
              .map(event => ({ seq: event.seq, callId: event.data.callId, effectOutcome: event.data.effectOutcome, sha256: hash(JSON.stringify(event.data)) })) })
          state.row = await this.mark(agent, { ...state.row, action: 'settled', status, resultRef,
            receiptId: hash(JSON.stringify({ rootCallId: exec.rootCallId, resultRef })) }, state)
          if (state.detaching) {
            if (!this.closingOwners.has(agent) && this.hostCtx.fiber.state === 2) {
              try { await this.notify(agent, state.row, state) } catch (caught) { this.hostCtx.logger?.warn?.('PTC completion remains queued: ' + caught.message) }
            }
          } else {
            this.pendingCollections.set(exec, state.row)
          }
          completion.resolve()
          if (error) finished.reject(error); else finished.resolve(value)
          return { status: error ? 'failed' : 'completed', result: JSON.stringify({ receiptId: state.row.receiptId, resultRef }) }
        })().catch(error => { completion.reject(error); finished.reject(error); return { status: 'failed', detail: error.message } })
        return { done, cancel: state.cancel }
      } })
      state.jobId = jobId
      // This controller owns completion delivery. A real waiter makes the
      // generic job reporter skip its non-durable duplicate notification.
      state.jobWait = this.jobs.wait(jobId, 2147483647, agent.session.id)
      state.jobWait.catch(error => this.hostCtx.logger?.warn?.(error.message))
      finished.promise.catch(() => {})
      return await Promise.race([finished.promise, detached.promise])
    } catch (error) {
      if (!jobId) this.live.delete(key)
      throw error
    } finally {
      // The listener and execution resources belong to the still-running job,
      // not to the released foreground waiter.
      finished.promise.finally(() => { unsubscribe(); this.live.delete(key); exec.deferContext = originalDefer }).catch(() => {})
    }
  }
}

export async function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  const service = new PtcBackground(ctx, config)
  for (const agent of ctx.agents.list()) await service.install(agent)
}
