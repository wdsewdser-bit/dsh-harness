import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renderToolsSdk } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

export const name = 'clm-sdk-runtime-snapshot'
export const inject = ['agents', 'tools']
const hash = text => createHash('sha256').update(text).digest('hex')
export async function apply(ctx, config = {}) {
  const sessionId = config.sessionId ?? 'session-028e6f5b-1716-4c23-a232-af16d853d191'
  const agent = ctx.agents.list().find(agent => String(agent.session?.id ?? agent.id) === sessionId)
  if (!agent) throw new Error('SDK_SNAPSHOT_LIVE_AGENT_MISSING')
  const schemas = ctx.tools.sdkSchemas(agent)
  if (!schemas.length || new Set(schemas.map(row => row.name)).size !== schemas.length) throw new Error('SDK_SNAPSHOT_INVALID_SCHEMA_SET')
  const sdk = renderToolsSdk(schemas)
  const output = config.output ?? 'D:/dsh-test/docs/architecture-review-20261001/sdk-baseline-runtime.json'
  const report = { version: 1, at: new Date().toISOString(), pid: process.pid, sessionId,
    source: 'current-live-agent-visible-native-sdkSchemas(agent)', schemaCount: schemas.length,
    schemaSha256: hash(JSON.stringify(schemas)), sdkSha256: hash(sdk), sdkBytes: Buffer.byteLength(sdk),
    moduleHash: hash(await readFile(new URL(import.meta.url))), schemas, sdk,
    boundaries: { modelRequests: 0, toolsExecuted: 0, journalChanges: 0 } }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  ctx.logger?.info?.(`[clm-sdk-runtime-snapshot] pid=${report.pid} schemas=${schemas.length} sha=${report.sdkSha256}`)
}
