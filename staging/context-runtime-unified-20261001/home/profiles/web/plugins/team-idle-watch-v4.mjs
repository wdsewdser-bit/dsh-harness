/**
 * Combined Team watchdog entry.
 *
 * DSH profile HMR watches config patches, not arbitrary plugin source files. This
 * wrapper gives the existing `team-idle-watch` entry a new module URL so a live
 * profile reload picks up both:
 *  - the original stopped-Team safety net; and
 *  - the 20-minute active-Team visibility digest.
 */
import { apply as applyIdleWatch } from './team-idle-watch-v3.mjs'
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
