import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from '../../store/index.mjs';
import { TeamCore } from '../../core/index.mjs';
import { SessionRouter } from '../../host/index.mjs';
import { installRuntime } from '../runtime.mjs';
import { createRoleToolBoundary } from '../../adapter-dsh/index.mjs';
import { registerBusinessTool } from '../business-tools.mjs';
import { resolveOwnerModel } from '../llm-execution.mjs';
import { ToolCapabilityRegistry, RoleToolGuard, authorizeRoleTool, NATIVE_IMPLEMENTATION, NATIVE_TOOL_CAPABILITIES,
  shapeCapabilities } from '../../host/index.mjs';
import { ROOT_TOOL_POLICY, TOOL_CAPABILITY_DECLARATIONS, TOOL_OPERATION_CAPABILITIES, toolOperationCapabilities,
  assertProtocolSupported } from '../../contracts/index.mjs';


export const TEAM = 'team:s2';
export const OWNER = 'session:owner';
export const AUDIT_FIELDS = ['teamId', 'sessionId', 'principalKind', 'role', 'toolIdentity', 'op', 'decision', 'reason'];

/**
 * S2 (§4, §9 R01-R05): the owner's role guard at its final execution hook.
 *
 * The world is the real installRuntime over a real core and store, a real SessionRouter for routing, and a fake
 * context that only provides what the runtime asks for. autonomy is off on purpose: the role policy is driven by the
 * borrow protocol, not by the autonomy switch, and an off-autonomy world keeps the test about the guard.
 */
export async function world(options = {}) {
  const { borrow = 'v1', ownerSessionId = OWNER, registerOwner = true, rootRole = 'root',
    revocable = true, authorizeFails = false, ownerModel = null, llm = null, boundary = true } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2-guard-'));
  const store = new ControlStore(root);
  const configuration = { enabled: true, teamId: TEAM, autonomy: 'off' };
  if (borrow === 'v1') {
    configuration.superagentBorrow = 'v1';
    configuration.intentSemantics = 'root-decision-v1';
    if (ownerModel !== null) configuration.ownerModel = ownerModel;
  }
  const core = new TeamCore(store, {}, configuration);
  if (rootRole !== null) core.member('member:root', rootRole);
  const listeners = new Map();
  const globalTools = new Map();
  const agentTools = new Map();
  let initiator = null;
  const ctx = {
    tools: { register(definition) { ctx.tools.roleToolBoundary?.track(definition); globalTools.set(definition.name, definition); return () =>
      globalTools.delete(definition.name); } },
    agents: { currentInitiator: () => initiator },
    on(name, handler) {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return revocable ? () => set.delete(handler) : undefined;
    },
    sessions: { get: () => null, create: async id => ({ id }) },
  };
  if (boundary) ctx.tools.roleToolBoundary = createRoleToolBoundary(ctx.tools);
  ctx.tools.executable = name => agentTools.get(name) ?? globalTools.get(name);
  if (llm !== null) ctx.llm = llm;
  let selected = null;
  const modelAgent = { session: { id: ownerSessionId }, model: { select(value) { selected = value; }, current() { return selected; } } };
  ctx.agents.get = id => id === ownerSessionId ? modelAgent : null;
  // Trusted fixture registration: only these actual definitions get native declarations, not their names.
  const nativeDefinitions = new Map();
  for (const [name, capabilities] of Object.entries(NATIVE_TOOL_CAPABILITIES)) {
    const definition = { name, execute: () => 'native' };
    nativeDefinitions.set(name, definition);
    ctx.tools.register(definition);
  }
  const router = new SessionRouter();
  if (registerOwner) router.registerTeam({ teamId: TEAM, ownerSessionId });
  const authorize = (kind, work) => { if (authorizeFails) throw Error('AUDIT_DOWN'); return work(); };
  let runtime;
  let failure = null;
  try {
    const ownerModelSelection = await resolveOwnerModel({ ownerModel, ctx, ownerSessionId });
    runtime = installRuntime(ctx, core, { authorize, route: id => router.route(id), ownerSessionId, ownerModelSelection });
    for (const [name, definition] of nativeDefinitions) runtime.roleGuard?.register({ identity: name,
      capabilities: NATIVE_TOOL_CAPABILITIES[name], implementation: definition, source: 'fixture-native' });
  }
  catch (error) { failure = error; }
  if (runtime) runtime.roleGuard?.bindOwnerSession?.(ownerSessionId);
  const agent = { session: { id: ownerSessionId },
    ctx: { tools: { register(tool) { ctx.tools.roleToolBoundary?.track(tool); agentTools.set(tool.name, tool); return () => agentTools.delete(tool.name);
      } } } };
  const hostRuntime = runtime ? { ...runtime, host: { executeAuthorized: (kind, work) => work() }, router, core } : null;
  return {
    root, store, core, ctx, router, runtime, failure, agent, listeners, globalTools, agentTools, hostRuntime,
    setInitiator(id) { initiator = id === null ? null : { session: { id } }; return initiator; },
    close() { try { store.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Run one call through the real listener chain, in the order the platform installed it; the terminal counts IO. */
export async function call(w, name, args = {}, sessionId = OWNER) {
  let executed = 0;
  // The owner call carries the registered agent, so a business-tool registration resolves to its own entry.
  const execution = { agent: sessionId === OWNER ? w.agent : { session: { id: sessionId } }, name, callId: 'call-' + name, arguments: args };
  const handlers = [...(w.listeners.get('tools/execute') ?? [])];
  let index = 0;
  const next = async () => {
    if (index < handlers.length) { const handler = handlers[index++]; return handler(execution, next); }
    executed++;
    return 'ran';
  };
  try { await (w.ctx.tools.roleToolBoundary?.run(execution, w.ctx.tools.executable(name), next) ?? next()); return { ok: true, executed }; }
  catch (error) { return { ok: false, executed, error, code: error?.code, decision: error?.decision }; }
}

