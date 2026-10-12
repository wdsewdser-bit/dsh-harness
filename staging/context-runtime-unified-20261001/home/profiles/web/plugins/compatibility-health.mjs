import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'compatibility-health'
export const inject = ['loader']
const required = [
  'agent-team', 'team-policy', 'tool-agent-team-v2', 'write-scope-guard',
  'team-runtime-guard', 'team-health', 'step-compaction', 'team-operator',
  'browser-use', 'browser-use-stagehand-native', 'computer-use',
  'computer-use-cua-driver-native',
]
const forbidden = ['tool-agent-team', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']

export function inspectCompatibility(ctx) {
  const entries = [...ctx.loader.entries()]
  const active = (entry) => !entry.disabled && entry.fiber?.state === 2
  const byId = (id) => entries.filter((entry) => entry.options.id === id)
  const failures = required.filter((id) => !byId(id).some(active)).map((id) => `${id}: not active`)
  for (const id of forbidden) if (byId(id).some(active)) failures.push(`${id}: conflicting upstream tools active`)
  if (ctx.get('browserUse')?.providerName !== 'stagehand-native') failures.push('Stagehand provider not registered')
  if (ctx.get('computerUse')?.providerName !== 'cua-driver-native') failures.push('CUA provider not registered')
  const inactive = entries.filter((entry) => !entry.disabled && entry.fiber?.state !== 2)
    .map((entry) => ({ id: entry.options.id, state: entry.fiber?.state ?? 'missing' }))
  return {
    pid: process.pid, at: new Date().toISOString(), ready: failures.length === 0,
    failures, inactive, required: required.map((id) => ({ id, active: byId(id).some(active) })),
  }
}

export function apply(ctx) {
  const file = join(process.env.DSH_HOME, 'compatibility-health.json')
  let previous
  const check = () => {
    const state = inspectCompatibility(ctx)
    const signature = JSON.stringify({ ...state, at: undefined })
    if (signature === previous) return
    previous = signature
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2))
    renameSync(temp, file)
    if (state.ready) ctx.logger.info('DSH 0.1.6 compatibility: required plugins active')
    else ctx.logger.warn('DSH compatibility pending/partial: %s', state.failures.join('; '))
  }
  // Loader health is diagnostic and changes only on plugin reload. Polling it
  // every second walks the whole loader graph for no operational benefit.
  const timer = setInterval(() => { try { check() } catch (error) { ctx.logger.error('Compatibility health failed: %s', error.message) } }, 30000)
  timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'compatibility-health.timer')
}
