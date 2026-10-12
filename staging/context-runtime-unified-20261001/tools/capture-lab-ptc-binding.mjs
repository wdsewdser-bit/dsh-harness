import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(new URL('../app/package.json', import.meta.url))
const { NodePtcRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-ptc-runtime-node')))
const { ToolRuntime } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')))
const { symbols } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const original = value => value?.[symbols.original] ?? value
const sha = value => createHash('sha256').update(value).digest('hex')
const expect = (condition, code) => { if (!condition) throw new Error(code) }

// Server-side only: no RPC, prompt assembly, tool dispatch, or subprocess execution.
export function captureLoadedPtcBinding(ctx, agent, { expectedRoute, expectedSessionId } = {}) {
  expect(ctx && typeof ctx.get === 'function' && agent?.session?.id === expectedSessionId && typeof expectedSessionId === 'string', 'LOADED_PTC_SESSION_REQUIRED')
  expect(original(ctx.get('agents')?.get(expectedSessionId)) === original(agent), 'LOADED_PTC_AGENT_REQUIRED')
  const tools = ctx.get('tools'), runtime = ctx.get('ptcRuntime')
  expect(tools instanceof ToolRuntime && runtime instanceof NodePtcRuntime && !runtime.disposed, 'LOADED_PTC_SERVICES_REQUIRED')
  expect(original(agent.ctx?.get('tools')) === original(tools) && original(agent.ctx?.get('ptcRuntime')) === original(runtime), 'LOADED_PTC_SCOPE_REQUIRED')
  expect(tools.modeFor(agent) === 'ptc' && runtime.language === 'typescript', 'LOADED_PTC_MODE_REQUIRED')
  const projections = ctx.get('sessionProjections')
  expect(typeof projections?.stateOf === 'function', 'LOADED_PTC_PROJECTIONS_REQUIRED')
  const preset = projections.stateOf(agent.session, 'agentPreset')
  expect(preset === 'ptc', 'LOADED_PTC_PRESET_REQUIRED')
  const selection = projections.stateOf(agent.session, 'modelSelection')
  expect(selection && Object.hasOwn(selection, 'pending'), 'LOADED_PTC_SELECTION_REQUIRED')
  const parentId = agent.session.header?.parentSession
  const parent = typeof parentId === 'string' ? ctx.get('agents')?.get(parentId) : undefined
  const ownedChild = parent && ctx.get('agents')?.isOwnedBy?.(agent.id,parent) === true
  const projectedRoute = selection.pending ?? agent.session.requestHeader?.()?.config
  const route = projectedRoute ?? (ownedChild ? agent.options : undefined)
  expect(route?.provider === expectedRoute?.provider && route?.model === expectedRoute?.model && typeof route?.provider === 'string' && typeof route?.model === 'string', 'LOADED_PTC_ROUTE_REQUIRED')
  const schemas = tools.sdkSchemas(agent)
  expect(Array.isArray(schemas) && schemas.length > 0 && new Set(schemas.map(s => s.name)).size === schemas.length, 'LOADED_PTC_SCHEMAS_REQUIRED')
  const context = schemas.find(s => s.name === 'context_manage')
  expect(context?.parameters && context.output, 'LOADED_CONTEXT_SCHEMA_REQUIRED')
  const sdkText = tools.sdkSection().text({ scope: agent, agent })
  expect(typeof sdkText === 'string' && sdkText.length > 0, 'LOADED_PTC_SDK_REQUIRED')
  return { source: 'loaded-agent-ptc-services', capturedAt: new Date().toISOString(), pid: process.pid, labSessionId: expectedSessionId,
    language: runtime.language, agentPreset: preset, runtimeKind: 'dsh-ptc-runtime-node', isolation: runtime.isolation,
    sdkSha256: sha(sdkText), schemaCount: schemas.length, schemasSha256: sha(JSON.stringify(schemas)),
    contextParameters: structuredClone(context.parameters), schemaHashes: Object.fromEntries(schemas.map(s => [s.name, sha(JSON.stringify(s.parameters))])),
    toolsSchemaBindings: { context_manage: sha(JSON.stringify(context.parameters)) },
    route: { provider: route.provider, model: route.model },
    routeSource: projectedRoute ? 'session-selection-or-request-header' : 'native-owned-child-options', sdkText }
}
