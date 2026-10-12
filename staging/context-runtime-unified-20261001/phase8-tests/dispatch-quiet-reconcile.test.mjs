#!/usr/bin/env node
/** A quiet Team notice has no target turn, so it must never age into a red timeout. */
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL('D:\\dsh-test\\home\\profiles\\web\\plugins\\team-control-plane.mjs').href)
let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail === undefined ? '' : '  ' + detail))
}

const at = 10_000_000
const state = {
  dispatches: {
    quiet: {
      dispatchId: 'quiet', sender: 'lead-boot', target: 'lead-core', wakeup: false,
      status: 'queued', attempt: 1, createdAt: at - 60_000, deadlineAt: at - 1,
      runId: null, resolvedAt: null, lastError: null,
    },
    wake: {
      dispatchId: 'wake', sender: 'lead', target: 'lead-core', wakeup: true,
      status: 'queued', attempt: 1, createdAt: at - 60_000, deadlineAt: at - 1,
      runId: null, resolvedAt: null, lastError: null,
    },
  },
}

const changes = mod.reconcileState(state, { deliveryTimeoutMs: 1_000, runTimeoutMs: 1_000, maxAttempts: 3 }, at)
check('a quiet queued notice completes instead of timing out',
  state.dispatches.quiet.status === 'completed' && state.dispatches.quiet.lastError === null,
  JSON.stringify(state.dispatches.quiet))
check('a waking queued dispatch still follows retry/timeout recovery',
  state.dispatches.wake.status === 'queued' && state.dispatches.wake.attempt === 2,
  JSON.stringify(state.dispatches.wake))
check('reconcile reports the quiet completion', changes.some((row) => row.kind === 'dispatch-completed' && row.dispatchId === 'quiet'))

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
