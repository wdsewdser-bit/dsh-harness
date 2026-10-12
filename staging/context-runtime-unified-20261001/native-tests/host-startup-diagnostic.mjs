import './host-lifecycle-resolve.mjs'
const { HostLifecycleGate } = await import('@deepseek-ai/cordis')
const original = HostLifecycleGate.prototype.runSync
let failures = 0
HostLifecycleGate.prototype.runSync = function (...args) {
  try { return original.apply(this, args) }
  catch (error) {
    if (error?.code === 'HOST_WRITER_BUSY' && failures++ < 5) {
      const snapshot = this.snapshot()
      process.stderr.write(JSON.stringify({ kind: 'lab-only-host-conflict', epoch: snapshot.epoch,
        pending: snapshot.pending, stack: error.stack }) + '\n')
    }
    throw error
  }
}
