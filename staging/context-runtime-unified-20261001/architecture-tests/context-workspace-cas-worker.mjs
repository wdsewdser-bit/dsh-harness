import { join } from 'node:path'
const directory = process.argv[2]
process.env.DSH_HOME = directory
const { createContextWorkspaceService } = await import('../home/profiles/web/plugins/context-workspace.mjs')
const agent = { name: 'alice', id: 'fixture-team-a:alice', session: { id: 'fixture-team-a:alice' } }
const ctx = { agents: { list: () => [agent] }, agentTeams: { tryMembership: () => ({ id: 'fixture-team-a', name: 'alice', tier: 2, group: 'red' }) } }
const service = createContextWorkspaceService(ctx, { directory: join(directory, 'memo'), controlDir: join(directory, 'team-control-plane'), now: () => 100011 })
console.log(JSON.stringify(service.manage(agent, { action: 'memo_put', input: { sourceId: 'race', text: process.argv[3], expectedRevision: 1 } })))
