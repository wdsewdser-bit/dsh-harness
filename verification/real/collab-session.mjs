import fs from 'node:fs';
import path from 'node:path';
import { roleTools } from '../../packages/contracts/team-tools.mjs';
import { handleTool } from '../../packages/core/tools.mjs';
import { toolDescription } from '../../packages/core/authorization.mjs';
import { implementGate } from '../../packages/core/collab.mjs';
import { assertLosslessJson } from './tool-output.mjs';

/**
 * The native tools a collaboration member may use, and the workspace boundary the experiment puts around them.
 *
 * The feasibility probe that preceded this stage found two facts worth stating plainly. dsh-fs-local is a filesystem
 * provider and not a containment boundary: a relative path resolves against the process directory, and an absolute
 * path outside the workspace is written without complaint. bash likewise runs with the process directory unless the
 * call names a workdir. Both are fine for a deployment whose members are trusted with one machine; neither can carry
 * an experiment whose whole point is comparing what independent members produce. So the boundary is enforced here, by
 * a per-agent tool guard over the exact paths each member's calls name, and every member session also gets its own
 * working directory so relative paths mean the member's workspace rather than the repository.
 */
export const nativeToolNames = ['read', 'write', 'edit', 'read_image', 'bash'];

/** The absolute workspace of one member; every path check below is against this root. */
export function workspaceOf(engine, actor) { return path.resolve(engine.root, 'ws', actor); }

function inside(root, target) {
  const resolved = path.resolve(target);
  const normal = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return normal(resolved) === normal(root) || normal(resolved).startsWith(normal(root) + path.sep);
}

/**
 * Refuse any native call whose target leaves the member's workspace.
 *
 * Returns the refusal text the model reads, or undefined to allow. The check is deliberately on the argument the model
 * passed and on the resolved absolute path, so a member cannot escape with '..' or with an absolute path elsewhere.
 */
export function workspaceRefusal(workspace, name, args) {
  const target = name === 'bash' ? (args?.workdir ?? null) : (args?.file_path ?? null);
  if (name === 'bash') {
    if (target !== null && !inside(workspace, target)) return 'WORKSPACE_BOUNDARY: run commands inside ' + workspace;
    // A command that changes directory itself is only refused when it names a directory outside the workspace.
    const command = String(args?.command ?? '');
    for (const match of command.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
      const where = match[1].replace(/^['"]|['"]$/g, '');
      if (!here(workspace, where)) return 'WORKSPACE_BOUNDARY: cd ' + where + ' leaves ' + workspace;
    }
    return undefined;
  }
  if (typeof target !== 'string' || !target) return undefined;
  // A relative path is resolved against the member workspace, which is the directory the tool itself resolves it
  // against; resolving it against the process directory would refuse every honest relative write.
  return here(workspace, target) ? undefined : 'WORKSPACE_BOUNDARY: ' + target + ' is outside your workspace ' + workspace;
}

function here(workspace, where) {
  const absolute = path.isAbsolute(where) ? where : path.resolve(workspace, where);
  return inside(workspace, absolute);
}

/**
 * Mechanism 1 on the native side of the same guard.
 *
 * The plan puts the guard in front of "entering implement", and this stage reads the task state machine as the
 * definition of that transition: an attempt may produce, verify or decide only after the downstream has the intent,
 * which handleTool already enforces. A member that could still write the code but not produce would be gated on the
 * paperwork instead of the work, so the same committed intent state also gates the workspace-mutating native calls
 * (write, edit, bash). Reading, reading images, the intent send itself and every team read stay open -- a member that
 * could not look at anything or speak could never satisfy the gate.
 */
export function implementRefusal(engine, state, name) {
  if (engine.collab !== 'on') return undefined;
  if (!['write', 'edit', 'bash'].includes(name)) return undefined;
  // Only a role that produces a deliverable is gated on its own shell and writes. Root coordinates and the independent
  // verifier inspects: their "entering implement" step is team_thread decide and team_verify, and both stay gated by
  // handleTool. Refusing root's read-only shell inspection for a missing intent demanded an intent that had no
  // downstream, which is a refusal a model cannot satisfy honestly.
  if (state.role !== 'worker') return undefined;
  const gate = implementGate(engine.core, 'member:' + state.actor);
  if (!gate) return undefined;
  // The refusal names the shape that satisfies it (host-protocol 4.3): a recipient set, the task and the revision the
  // interface binds, and no deadline -- the window is the server's, and silence when it closes is consent.
  if (gate === 'INTENT_WINDOW_OPEN') return gate + ': the intent window is still open; prepare, and retry this ' + name +
    ' when it closes (silence is consent, so no ack is needed)';
  return gate + ': send team_message {op:"send",kind:"intent",to:["member:<downstream>"],taskRef:"' + (state.task ?? 'task:collab:' + state.actor) +
    '",contractRevision:1,summary:"the interface and its assumptions",expectedOutcome:"ok, or object with what breaks"} ' +
    'first, then retry this ' + name;
}

/**
 * Install one member's tool surface: the role's team tools plus the native tools, restricted to that list.
 *
 * Team tools go through handleTool exactly as they do in the release profile, so the collaboration mechanisms are the
 * production ones and not a stage copy. Native tools are already published by the host's own plugins; this function
 * only restricts the visible set and installs the workspace guard, so there is no second implementation to drift.
 */
export function installCollabTools(engine, state) {
  const ctx = engine.agent(state.actor).ctx;
  const workspace = workspaceOf(engine, state.actor);
  const collab = engine.collab;
  const role = engine.core.store.read('member:' + state.actor).role;
  // The role surface comes from the arm: collab off publishes the release tools only, collab on publishes the
  // release tools plus team_assume and team_decision. The native tools are the workload, so both arms have them.
  const schemas = roleTools(role, collab);
  const names = [...Object.keys(schemas), ...nativeToolNames];
  engine.byAgent.set(engine.agent(state.actor), state);
  ctx.tools.restrict({allow:names});
  if(state.collabInstalled===engine.agent(state.actor))return workspace;
  state.collabInstalled=engine.agent(state.actor);
  // Native tool calls are observed here, after the dispatch, so the metrics count the calls that actually ran: a call
  // a guard refused never reaches this listener with a success, and a call that wrote a file is one row with the path
  // it wrote. That is what reworkRate and changePropagationLatency are computed from.
  ctx.on('tools/post-execute', async (execution, result, next) => {
    if (nativeToolNames.includes(execution.name)) {
      engine.facts.toolActions.push({ actor: state.actor, name: execution.name, args: execution.arguments,
        requestId: state.requestId, at: Date.now(), elapsedMs: 0, resultRef: result?.value?.path ?? null,
        isError: !!result?.isError, source: 'native-model-tool' });
      // A workspace mutation is the collaboration stage's own progress signal: a member that is writing files or
      // running commands is working even when its turn has not finished yet, which is exactly the interval the old
      // start-based clock measured as silence. Only successful mutations count; a refused call is not progress.
      if (!result?.isError && ['write', 'edit'].includes(execution.name)) engine.progress('workspace:' + state.actor);
      else if (!result?.isError && execution.name === 'bash') engine.progress('bash:' + state.actor);
    }
    return next();
  });
  ctx.tools.restrict({ allow: names });
  ctx.tools.guard(execution => {
    const reason = workspaceRefusal(workspace, execution.name, execution.arguments) ??
      implementRefusal(engine, state, execution.name);
    if (reason) (engine.facts.guardDenials ??= []).push({ actor: state.actor, name: execution.name,
      arguments: execution.arguments, reason, at: Date.now() });
    return reason;
  });
  return workspace;
}

/**
 * The tool catalogue the provider sees for one member: the role's team tools and the native tools, in one list.
 * wireSchemas is the registry's own published view, so the native side of the catalogue cannot be hand-written.
 */
export function collabCatalog(engine, actor) {
  const ctx = engine.agent(actor).ctx;
  const state = engine.states.get(actor);
  const role = engine.core.store.read('member:' + actor).role;
  const schemas = roleTools(role, engine.collab);
  // The catalogue is the registry's own published view either way. 0.2.2 removed the mode-driven wireSchemas() (and
  // the mode it branched on) in favour of schemas(scope), which projects the same name/description/parameters for the
  // visible definitions; the older release only has the former, so the newest available one is used.
  const published = new Map(((ctx.tools.wireSchemas?.(ctx).schemas ?? ctx.tools.schemas(ctx)) ?? [])
    .map(schema => [schema.name, schema]));
  const out = [];
  for (const [name, parameters] of Object.entries(schemas)) {
    out.push({ type: 'function', name, description: toolDescription(role, name, engine.collab), parameters, strict: false });
  }
  for (const name of nativeToolNames) {
    const schema = published.get(name);
    if (!schema) throw Error('NATIVE_TOOL_NOT_PUBLISHED:' + name + ' for ' + state?.actor);
    out.push({ type: 'function', name, description: schema.description ?? name, parameters: schema.parameters, strict: false });
  }
  return out;
}

/** Create the per-member workspaces and the hidden area once, before any agent exists. */
export function prepareWorkspaces(engine, actors) {
  for (const actor of actors) fs.mkdirSync(workspaceOf(engine, actor), { recursive: true });
  fs.mkdirSync(path.join(engine.root, 'hidden'), { recursive: true });
}
