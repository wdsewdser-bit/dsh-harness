/**
 * Public entry of the team host (M1b); docs/host-protocol.md §2, docs/decisions/M1b-host-driver-design.md §3-§4.
 *
 * Everything a composition root may touch is exported here. Files under src/ are private: another package that
 * reaches into packages/host/src/*.mjs breaks the dependency rule, and check-deps rejects it.
 */
export { createTeamHost, TeamHost } from './src/host.mjs';
export { canonicalTeamDir, teamDirKey } from './src/paths.mjs';
export { acquireOwnership, lockTarget, OwnershipHandle, OwnershipRegistry, ownershipRegistry } from './src/ownership.mjs';
export { HOST_STATES, HOST_TRANSITIONS, HostStateMachine, isLegalTransition } from './src/machine.mjs';
export { SessionRouter, sessionRouter, UNROUTED } from './src/sessions.mjs';
export { CommandGateway, createHumanInputGateway, canonicalJson, normaliseJson } from './src/gateway.mjs';
export { COMMAND_KINDS, createCommandAuthorization } from './src/authorization.mjs';
export { createCapability, createLifecycleToken, revokeLifecycleToken } from './src/capability.mjs';
export { createClock } from './src/clock.mjs';
export { CYCLE_STEPS, createCycle } from './src/cycle.mjs';
export { ACCESS_ROUTES, createCoreAccess } from './src/core-access.mjs';
export { newTeamId, REGISTRY_FILE, TeamRegistry } from './src/registry.mjs';
export { assertSingleMount, MANAGER_MARKER, TeamManager } from './src/manager.mjs';
export { teamCommands } from './src/commands/team.mjs';
export { createVisibility } from './src/visibility/dispatch.mjs';
export { visibilityDirty } from './src/visibility/dirty.mjs';
export { createEffectRunner, effectIoClaimKey } from './src/effect-runner.mjs';
export { effectCapabilities } from './src/effect-capabilities.mjs';
// The tool guard now lives inside the host (19-M3a-M4-plan §2.2: tool-guard folds into host/src/guard/), and only
// the contracts package is below it: normalizeScope came down to contracts, so the guard has no core edge left.
export { normalizeTarget, OPAQUE_TOOLS, WRITE_TOOLS, READ_ONLY_TOOLS, resolveToolPath, effectTargets, ToolGuard,
  NATIVE_IMPLEMENTATION, NATIVE_TOOL_CAPABILITIES, shapeCapabilities, ToolCapabilityRegistry, authorizeRoleTool,
  RoleToolGuard } from './src/guard/index.mjs';
// The operator write half of delivery (§WP-C 3): delivery keeps the IO port and the gate runner factory, while the
// delivery.adjudicate command assembly - the part that writes through core - moves to the host's write gateway.
export { submitDeliveryReconciliation } from './src/reconcile.mjs';
export { createLifecycleConsumer } from './src/lifecycle-consumer.mjs';
export { createRecovery, RECOVERY_GRANTS } from './src/recover.mjs';
export { createGoalRecovery, SESSION_LOG_UNAVAILABLE } from './src/goal.mjs';
export { createHostDelivery } from './src/delivery.mjs';
export { createGarbageCollector, DEFAULT_GC_INTERVAL_MS } from './src/gc.mjs';
export { createStopProver, stopProofId } from './src/stop-proof.mjs';
