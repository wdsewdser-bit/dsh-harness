const { getHostLifecycleGate } = await import('@deepseek-ai/cordis')

// Direct service constructors belong to one installation owner. Return only
// when all nested asynchronous setup or failed-install cleanup has settled.
export async function initializeNativeHost(ctx, install) {
  if (typeof getHostLifecycleGate !== 'function') throw new Error('NATIVE_HOST_FIXTURE_REQUIRES_CANONICAL_PRELOAD')
  const gate = getHostLifecycleGate(ctx)
  return gate.observeSettlement(() => gate.runAsync(install))
}
