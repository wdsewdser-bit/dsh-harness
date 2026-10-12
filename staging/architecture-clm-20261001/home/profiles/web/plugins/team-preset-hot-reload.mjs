export const name = 'team-preset-hot-reload'

/**
 * Re-link idle live agents to the newest standing composition of their preset.
 *
 * Adding a new plugin file avoids ESM's same-URL module cache, but existing
 * sessions still point at the generation they mounted at boot. The shipped
 * agent-presets service detects a changed preset file and creates a new
 * generation for NEW sessions; this one-shot bridge moves already-idle agents
 * onto that generation too. Running agents are deliberately skipped.
 */
export const inject = ['agents', 'agentPresets']

export function apply(ctx) {
  const timer = setTimeout(() => {
    void (async () => {
      for (const agent of ctx.agents.list()) {
        if (agent.status === 'running') continue
        let current
        try {
          current = ctx.agentPresets.composedPreset(agent.ctx)
        } catch {
          continue
        }
        if (current !== 'ptc') continue
        try {
          await ctx.agentPresets.recompose(agent.ctx, current)
          ctx.logger?.info?.(`[team-preset-hot-reload] recomposed ${agent.id} on ${current}`)
        } catch (error) {
          ctx.logger?.warn?.(`[team-preset-hot-reload] ${agent.id}: ${String(error?.message ?? error)}`)
        }
      }
    })()
  }, 0)

  return () => clearTimeout(timer)
}
