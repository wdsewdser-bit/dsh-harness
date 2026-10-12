import { nativeSessionBridge } from '../../../../app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
import { windowHash as hash } from './team-v15-window-checkpoint.mjs'
import { randomUUID } from 'node:crypto'
const { getHostLifecycleGate } = await import('@deepseek-ai/cordis')
const HOST_DOMAINS = ['cordis', 'loader', 'system-prompt', 'scope', 'scope-parent', 'tool-registry']
const hostOwners = globalThis[Symbol.for('dsh.window.host-owner-ids.v15')] ??= new WeakMap()
function hostGate(ctx) {
  if (typeof getHostLifecycleGate !== 'function') throw new Error('HOST_NATIVE_IMPLEMENTATION_UNAVAILABLE')
  return getHostLifecycleGate(ctx)
}
export function nativeHostBinding(ctx) {
  const gate = hostGate(ctx), snapshot = gate.snapshot()
  if (!hostOwners.has(gate)) hostOwners.set(gate, randomUUID())
  // The opaque native instance never enters JSON or structuredClone.
  return { ownerId: hostOwners.get(gate), epoch: snapshot.epoch, pending: snapshot.pending,
    veto: snapshot.veto ?? null, domains: [...snapshot.domains].sort() }
}
export function nativeHostFacts(ctx) {
  const gate = hostGate(ctx)
  const binding = nativeHostBinding(ctx)
  try {
    gate.assert(gate.snapshot(), HOST_DOMAINS)
    return { binding, coveredDomains: ['config'], externalWriters: [] }
  } catch (error) {
    return { binding, coveredDomains: [], externalWriters: ['native-host:' + error.message] }
  }
}

/** Actual CP and native writer evidence; missing loaded-writer ownership stays
 * explicit rather than accepting a caller's `verified:true` certificate. */
export function createNativeWindowParticipation({ control, session, bridge, loadedFacts, hostContext, protectFiles=false, sourceFiles=()=>[] }) {
  if (nativeSessionBridge(session) !== bridge || bridge?.options?.isolated !== true || bridge.options.sessionId !== session.id
    || typeof control?.acquireWindowFence !== 'function' || typeof loadedFacts !== 'function') throw new Error('WINDOW_REAL_PARTICIPANTS_REQUIRED')
  const host = hostContext ? hostGate(hostContext) : undefined
  const leases = new WeakMap()
  const read = () => ({ control: control.windowFenceFacts().binding, loaded: loadedFacts().binding,
    ...(host ? { host: nativeHostBinding(hostContext) } : {}) })
  const certificate = () => {
    const cp = control.windowFenceFacts(), native = bridge.windowParticipationFacts(), loaded = loadedFacts()
    const covered = new Set(loaded.coveredDomains ?? [])
    const hostBlockers = []
    if (host) {
      try { host.assert(host.snapshot(), HOST_DOMAINS); covered.add('config') }
      catch (error) { hostBlockers.push('native-host:' + error.message) }
    }
    const missing = ['identity', 'config'].filter(domain => !covered.has(domain))
    return { kind: 'participating-writers-v1', sessionId: session.id, rootId: control.rootId,
      domains: [...cp.domains, 'input-claim', ...covered],
      boundary: { cpFile: cp.file, native, fileProtection:protectFiles ? cp.fileProtection : null }, blockers: [...missing.map(d => 'loaded-writer-not-participating:' + d),
        ...cp.externalWriters.filter(writer=>!(protectFiles && cp.fileProtection?.supported===true && writer==='out-of-process file replacement'))
          .map(writer => 'control-plane-external-writer:' + writer), ...(loaded.externalWriters ?? []), ...hostBlockers],
      deployment: 'exact-isolated-only-off-by-default' }
  }
  function verifyCertificate(c) { return hash(c) === hash(certificate()) && c.blockers.length === 0 }
  // Recovery decides from the journal and the disk alone, so unrelated host churn must not keep a session fenced:
  // its comparison leaves the host binding out. Control-plane, identity and config bindings stay bound.
  const comparable = (value, recovery) => {
    if (!recovery) return value
    const { host: _host, ...rest } = value ?? {}
    if (rest.loaded && typeof rest.loaded === 'object') { const { host: _loadedHost, ...loaded } = rest.loaded; rest.loaded = loaded }
    return rest
  }
  async function acquire(expected, { recovery = false } = {}) {
    if (hash(comparable(read(), recovery)) !== hash(comparable(expected, recovery))) throw new Error('WINDOW_PARTICIPANT_CAS_CONFLICT')
    // Optimistic host binding: no host-wide read lease is held, so other sessions keep installing and disposing while
    // this one prepares. The snapshot is taken in the same synchronous segment as the caller's read and re-asserted at
    // every later check; any host writer since then has moved the epoch and fails this commit instead.
    const hostSnapshot = host && !recovery ? host.snapshot() : undefined
    if (hostSnapshot) host.assert(hostSnapshot, HOST_DOMAINS)
    let controlLease
    try {
      controlLease = await control.acquireWindowFence(expected.control, { isolated: true, sessionId: session.id,
        ...(protectFiles ? {protectFiles:true,sourceFiles} : {}) })
      if(protectFiles && controlLease.fileProtection?.kind!=='windows-share-deny-write-delete-v1') throw new Error('WINDOW_FILE_PROTECTION_UNAVAILABLE')
      if (hostSnapshot) host.assert(hostSnapshot, HOST_DOMAINS)
      if (hash(comparable(read(), recovery)) !== hash(comparable(expected, recovery))) throw new Error('WINDOW_PARTICIPANT_CAS_CONFLICT')
      const token = Object.freeze({})
      leases.set(token, { hostSnapshot, controlLease, recovery })
      return token
    } catch (error) {
      try { await controlLease?.release() } catch { /* the acquire failure is the result */ }
      throw error
    }
  }
  function assertHeld(lease, expected) {
    const held = leases.get(lease)
    if (!held) throw new Error('WINDOW_PARTICIPANT_STALE_FENCE')
    // Covers what the hash below cannot: the gate instance, a pending writer, a veto and a closed host.
    if (held.hostSnapshot) host.assert(held.hostSnapshot, HOST_DOMAINS)
    held.controlLease.assertHeld(expected.control)
    if (hash(comparable(read(), held.recovery)) !== hash(comparable(expected, held.recovery))) throw new Error('WINDOW_LOADED_IDENTITY_CONFIG_CHANGED')
    return true
  }
  async function release(lease) {
    const held = leases.get(lease)
    if (!held) throw new Error('WINDOW_PARTICIPANT_STALE_FENCE')
    leases.delete(lease)
    await held.controlLease.release()
  }
  return Object.freeze({ certificate, verifyCertificate, read, acquire, assertHeld, release,
    settle:()=>control.flush() })
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
