import { randomUUID } from 'node:crypto'
import { binding, canonical, clone, digest, fail } from './team-v16-capability-common.mjs'
export const name = 'team-v16-tool-references'
export const inject = ['tools', 'agentTeams']
export const provide = ['teamToolReferences']
export const referenceTools = ['tool_ref_put', 'tool_ref_read', 'tool_ref_invoke', 'tool_ref_revoke']
export function createToolReferences(ctx, { resolveActor, authorizeShare, now = Date.now, maxEntries = 256, maxBytes = 1048576, maxTtlMs = 3600000 } = {}) {
  const records = new Map(), active = new Map(), parents = new Map()
  let closed = false
  const actor = agent => { if (closed) fail('TOOL_REF_CLOSED'); return binding(ctx, agent, resolveActor) }
  function schema(tool, agent) {
    if (referenceTools.includes(tool)) fail('TOOL_REF_RECURSION')
    const visible = ctx.tools.schemas(agent).find(row => row.name === tool)
    const definition = ctx.tools.get(tool, agent)
    if (!visible || !definition) fail('TOOL_REF_TOOL_DENIED')
    return digest({ ...visible, output: definition.output.schema })
  }
  function current(request, exec) {
    const a = actor(exec.agent), row = records.get(request.ref)
    if (!row || row.revoked || now() >= row.expiresAt || row.hash !== request.hash) fail('TOOL_REF_UNAVAILABLE')
    const owner = digest(row.owner) === digest(a)
    if (!owner && !row.shares.some(target => digest(target) === digest(a))) fail('TOOL_REF_ACL_DENIED')
    if (row.schemaHash !== schema(row.tool, exec.agent)) fail('TOOL_REF_SCHEMA_CHANGED')
    if (digest(JSON.parse(row.payload)) !== row.hash) fail('TOOL_REF_HASH_CHANGED')
    return row
  }
  return Object.freeze({
    put(request, exec) {
      const owner = actor(exec.agent), tool = request.tool, schemaHash = schema(tool, exec.agent)
      if (request.kind === 'code' && (tool !== 'run_code' || typeof request.arguments?.code !== 'string')) fail('TOOL_REF_CODE_TARGET_REQUIRED')
      if (!['payload', 'code'].includes(request.kind ?? 'payload')) fail('TOOL_REF_KIND_INVALID')
      const payload = canonical(request.arguments), ttlMs = request.ttlMs ?? 300000
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTtlMs || Buffer.byteLength(payload) > maxBytes) fail('TOOL_REF_LIMIT')
      for (const [id, row] of records) if (row.revoked || now() >= row.expiresAt) records.delete(id)
      if (records.size >= maxEntries) fail('TOOL_REF_LIMIT')
      const shares = (request.shareWith ?? []).map(clone)
      for (const target of shares) {
        if (target.team !== owner.team || target.workspace !== owner.workspace || target.role !== owner.role
          || target.task !== owner.task || target.taskRevision !== owner.taskRevision || target.plan !== owner.plan || target.planRevision !== owner.planRevision
          || typeof authorizeShare !== 'function' || authorizeShare(owner, target, tool) !== true) fail('TOOL_REF_SHARE_DENIED')
      }
      const ref = 'tr-' + randomUUID(), hash = digest(request.arguments), expiresAt = now() + ttlMs
      records.set(ref, { owner, shares, tool, schemaHash, payload, hash, expiresAt, kind: request.kind ?? 'payload', started: false, revoked: false })
      return { ref, hash, tool, schemaHash, expiresAt }
    },
    read(request, exec) { const row = current(request, exec); return { tool: row.tool, arguments: JSON.parse(row.payload), hash: row.hash, schemaHash: row.schemaHash } },
    async invoke(request, exec) {
      const row = current(request, exec)
      if (!exec.token || !exec.signal) fail('TOOL_REF_NATIVE_EXECUTION_REQUIRED')
      let ancestor = exec.parent
      const visited = new Set()
      while (ancestor !== undefined) {
        if (active.has(ancestor) || visited.has(ancestor) || visited.size >= 256) fail('TOOL_REF_RECURSION')
        visited.add(ancestor); ancestor = parents.get(ancestor)
      }
      if (row.kind === 'code' && row.started) fail('TOOL_REF_CODE_ALREADY_STARTED')
      if (row.kind === 'code') row.started = true
      active.set(exec.token, row.tool)
      try {
        return await ctx.tools.execute({ callId: 'tool-ref-' + randomUUID(), name: row.tool,
          arguments: JSON.parse(row.payload), agent: exec.agent, signal: exec.signal,
          parent: exec.token, rootCallId: exec.rootCallId ?? exec.callId })
      } finally { active.delete(exec.token) }
    },
    revoke(request, exec) { const row = current(request, exec); if (digest(actor(exec.agent)) !== digest(row.owner)) fail('TOOL_REF_OWNER_REQUIRED'); row.revoked = true; return { revoked: true } },
    observeExecution(exec) { parents.set(exec.token, exec.parent) },
    settleExecution(exec) { parents.delete(exec.token) },
    dispose() { closed = true; records.clear(); parents.clear() },
  })
}
export function installToolReferences(ctx, config = {}) {
  const service = createToolReferences(ctx, config), disposers = [], outcomes = new WeakMap()
  disposers.push(ctx.on('tools/pre-execute', (exec, next) => { service.observeExecution(exec); return next() }, { global: true }))
  disposers.push(ctx.on('tools/result', exec => service.settleExecution(exec), { global: true }))
  const refParameters = { type: 'object', properties: { ref: { type: 'string' }, hash: { type: 'string' } }, required: ['ref', 'hash'], additionalProperties: false }
  for (const operation of ['put', 'read', 'invoke', 'revoke']) {
    disposers.push(ctx.tools.register({ name: 'tool_ref_' + operation, description: 'Bound native tool reference ' + operation,
      parameters: operation === 'put' ? { type: 'object', properties: { tool: { type: 'string' }, arguments: {}, kind: { type: 'string' }, ttlMs: { type: 'integer' }, shareWith: { type: 'array', items: { type: 'object' } } }, required: ['tool', 'arguments'], additionalProperties: false } : refParameters,
      output: { schema: {}, render: (args, value) => outcomes.get(args)?.content ?? [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => operation === 'invoke' ? fail('TOOL_REF_NATIVE_BRIDGE_REQUIRED') : service[operation](args, exec) }))
  }
  disposers.push(ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'tool_ref_invoke') return next()
    const result = await service.invoke(exec.arguments, exec)
    outcomes.set(exec.arguments, result)
    if (result.concludesTurn === true) exec.concludeTurn()
    return result
  }, { global: true }))
  return { service, dispose() { service.dispose(); for (const stop of disposers.reverse()) stop() } }
}
export function apply(ctx, config = {}) {
  const installed = installToolReferences(ctx, config)
  const stop = ctx.provide('teamToolReferences', installed.service)
  return () => { installed.dispose(); stop?.() }
}
