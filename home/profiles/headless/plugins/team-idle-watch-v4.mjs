/**
 * Combined Team watchdog entry for the headless profile.
 *
 * Keeps the original stopped-Team safety net and adds the active-Team
 * visibility digest on the same module entry.
 */
import { apply as applyIdleWatch } from './team-idle-watch.mjs'
import { apply as applyActivityDigest } from './team-activity-digest.mjs'

export const name = 'team-idle-watch'
export const inject = []

export function apply(ctx, config = {}) {
  const disposeIdle = applyIdleWatch(ctx, config)
  const disposeActivity = applyActivityDigest(ctx, config)
  return () => {
    disposeActivity?.()
    disposeIdle?.()
  }
}
