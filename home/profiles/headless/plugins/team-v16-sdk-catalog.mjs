import { renderToolsSdk } from '../../../../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { clone, digest, fail } from './team-v16-capability-common.mjs'
export const name = 'team-v16-sdk-catalog'
export const inject = ['tools', 'agents', 'requestMessageProjection']
export const provide = ['teamSdkCatalog']
export function createSdkCatalog(ctx, { coreNames = ['run_code', 'sdk_catalog'], isolated = false, projectCore = false } = {}) {
  let closed = false
  function view(agent) {
    if (closed || !agent) fail('SDK_CATALOG_SCOPE_REQUIRED')
    const rows = ctx.tools.schemas(agent).map(row => {
      const definition = ctx.tools.get(row.name, agent)
      if (!definition) fail('SDK_CATALOG_SCOPE_CHANGED')
      return clone({ ...row, output: definition.output.schema })
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return { rows, hash: digest(rows) }
  }
  function list(agent, { cursor, limit = 32 } = {}) {
    const { rows, hash } = view(agent)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) fail('SDK_CATALOG_LIMIT')
    let offset = 0
    if (cursor) {
      let decoded
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { fail('SDK_CATALOG_CURSOR_INVALID') }
      if (decoded.hash !== hash || decoded.scope !== agent.session?.id) fail('SDK_CATALOG_CURSOR_STALE')
      offset = decoded.offset
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= rows.length) fail('SDK_CATALOG_CURSOR_INVALID')
    }
    const end = Math.min(offset + limit, rows.length)
    return { tools: rows.slice(offset, end).map(row => ({ name: row.name, summary: row.description.slice(0, 160), schemaHash: digest(row) })), scopeHash: hash,
      cursor: end < rows.length ? Buffer.from(JSON.stringify({ hash, scope: agent.session?.id, offset: end })).toString('base64url') : null }
  }
  function describe(agent, tool) { const row = view(agent).rows.find(row => row.name === tool); if (!row) fail('SDK_CATALOG_TOOL_DENIED'); return { schema: row, schemaHash: digest(row) } }
  function core(agent) { const { rows, hash } = view(agent); return { tools: rows.filter(row => coreNames.includes(row.name)), scopeHash: hash } }
  function project(options) {
    if (!isolated || !projectCore || options?.purpose !== 'conversation' || options.system || !Array.isArray(options.messages)
      || ctx.requestMessageProjection?.isAgentLoopRequest?.(options) !== true) return { messages: options?.messages }
    const agents = ctx.agents.list().filter(agent => agent.session?.id === options.sessionId)
    if (agents.length !== 1) return { messages: options.messages }
    try {
      const agent = agents[0], rows = view(agent).rows.filter(row => row.name !== 'run_code')
      if (!rows.some(row => row.name === 'sdk_catalog')) return { messages: options.messages }
      const titles = options.messages.filter(message => message.role === 'system' && message.source?.kind === 'system-prompt')
        .flatMap(message => message.content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string')
        .reduce((count, block) => count + block.text.split('## Writing code for run_code').length - 1, 0)
      if (titles !== 1) return { messages: options.messages }
      const full = renderToolsSdk(rows), compact = renderToolsSdk(rows.filter(row => coreNames.includes(row.name)))
      let matches = 0
      const messages = options.messages.map(message => {
        if (message.role !== 'system' || message.source?.kind !== 'system-prompt' || !Array.isArray(message.content)) return message
        const content = message.content.map(block => {
          if (block.type !== 'text' || typeof block.text !== 'string') return block
          const at = block.text.indexOf(full)
          if (at < 0 || block.text.indexOf(full, at + 1) >= 0) return block
          matches++
          return { ...block, text: block.text.slice(0, at) + compact + block.text.slice(at + full.length) }
        })
        return { ...message, content }
      })
      return { messages: matches === 1 ? messages : options.messages }
    } catch { return { messages: options.messages } }
  }
  return Object.freeze({ list, describe, core, project, dispose() { closed = true } })
}
export function installSdkCatalog(ctx, config = {}) {
  const service = createSdkCatalog(ctx, config)
  const stopTool = ctx.tools.register({ name: 'sdk_catalog', description: 'List visible native tools or retrieve their exact current schema.',
    parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['list', 'describe', 'core'] }, tool: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer' } }, required: ['operation'], additionalProperties: false },
    output: { schema: {}, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) { if (args.operation === 'describe') return service.describe(exec.agent, args.tool); if (args.operation === 'core') return service.core(exec.agent); return service.list(exec.agent, args) } })
  const stopProjection = ctx.requestMessageProjection.register(name, service.project, { order: 12, preview: service.project })
  return { service, dispose() { service.dispose(); stopProjection(); stopTool() } }
}
export function apply(ctx, config = {}) { const installed = installSdkCatalog(ctx, config); const stop = ctx.provide('teamSdkCatalog', installed.service); return () => { installed.dispose(); stop?.() } }
