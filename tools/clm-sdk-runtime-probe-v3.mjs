import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renderToolsSdk } from '../app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

export const name = 'clm-sdk-runtime-probe-v3'
export const inject = ['agents', 'tools']
const hash = value => createHash('sha256').update(value).digest('hex')
export async function apply(ctx, config = {}) {
  const sessionId = config.sessionId ?? 'session-028e6f5b-1716-4c23-a232-af16d853d191'
  const agent = ctx.agents.list().find(row => String(row.session?.id ?? row.id) === sessionId)
  if (!agent) throw new Error('LIVE_AGENT_REQUIRED')
  const schemas = ctx.tools.sdkSchemas(agent)
  const sdk = renderToolsSdk(schemas)
  const report = { version: 3, codeIdentity: '20261001-v3-agent-scope', at: new Date().toISOString(), pid: process.pid,
    sessionId, agentId: agent.id, hasContext: !!agent.ctx, schemaCount: schemas.length,
    source: 'native-sdkSchemas-explicit-Agent-v3', schemaSha256: hash(JSON.stringify(schemas)), sdkSha256: hash(sdk),
    sdkBytes: Buffer.byteLength(sdk), moduleHash: hash(await readFile(new URL(import.meta.url))), schemas, sdk,
    boundaries: { modelRequests: 0, toolsExecuted: 0, journalChanges: 0 } }
  await mkdir(dirname(config.output), { recursive: true })
  await writeFile(config.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
}
