import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renderToolsSdk } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

export const name = 'clm-runtime-probe-v4'
export const inject = ['agents', 'tools', 'requestMessageProjection', 'contextWorkspace']
const hash = value => createHash('sha256').update(value).digest('hex')
export async function apply(ctx, config) {
  const moduleHash = hash(await readFile(new URL(import.meta.url)))
  let running = false, disposed = false
  const capture = async () => {
    if (running || disposed) return
    running = true
    try {
      const services = { requestMessageProjection: ctx.requestMessageProjection.stats(), contextWorkspace: ctx.contextWorkspace.runtimeFacts() }
      const receipt = { version: 4, codeIdentity: '20261001-loaded-service-probe-v4', source: 'loaded-runtime-services',
        capturedAt: new Date().toISOString(), pid: process.pid, labSessionId: config.labSessionId, moduleHash, services }
      await mkdir(dirname(config.output), { recursive: true })
      await writeFile(config.output + '.tmp', JSON.stringify(receipt, null, 2) + '\n')
      await rename(config.output + '.tmp', config.output)
      for (const target of config.sdkTargets ?? []) {
        if (existsSync(target.output)) continue
        const agent = ctx.agents.list().find(row => String(row.session?.id ?? row.id) === target.sessionId)
        if (!agent) continue
        const schemas = ctx.tools.sdkSchemas(agent), sdk = renderToolsSdk(schemas)
        const tools = ['context_manage', 'send_message', 'team_task_list'].map(toolName => {
          const definition = ctx.tools.get(toolName, agent)
          return { name: toolName, present: !!definition, executionSha256: definition ? hash(String(definition.execute)) : null }
        })
        await writeFile(target.output, JSON.stringify({ version: 4, codeIdentity: receipt.codeIdentity, at: receipt.capturedAt,
          source: 'native-sdkSchemas-explicit-Agent-v4', pid: process.pid, sessionId: target.sessionId, moduleHash,
          schemaCount: schemas.length, schemaSha256: hash(JSON.stringify(schemas)), sdkSha256: hash(sdk), sdkBytes: Buffer.byteLength(sdk),
          schemas, sdk, tools, boundaries: { modelRequests: 0, toolsExecuted: 0, journalChanges: 0 } }, null, 2) + '\n', { flag: 'wx' })
      }
    } catch (error) { ctx.logger?.warn?.(`[clm-runtime-probe-v4] ${error.code ?? error.message}`) }
    finally { running = false }
  }
  await capture()
  const timer = setInterval(capture, 1000); timer.unref()
  ctx.effect(() => () => { disposed = true; clearInterval(timer) })
}
