const key=Symbol.for('dsh.profiles.business-tools.v1');
const registered=globalThis[key]??=(new WeakMap());

/**
 * Trusted plugin registration, not a model-supplied tool-name exemption. Native tools keep their effect guard.
 *
 * P2 (§4.1): the registration now carries the tool's capability declaration, and the declaration is bound to the
 * wrapper this call actually registers - never to the name. Two consequences the design asks for: an undeclared
 * business tool is registered but is undeclared for the owner role (fail closed, it cannot inherit the old
 * "business tools are exempt" rule), and a later registration of the same name replaces the entry, so the wrapper it
 * replaced no longer resolves and its calls are refused instead of inheriting the new declaration.
 *
 * The wrapper also asks the role guard itself before it starts any work. The platform boundary is the final hook, but
 * a direct or nested `execute()` never crosses that boundary; the same guard one level in closes it.
 */
export function registerBusinessTool(runtime, agent, definition) {
  if (!definition || typeof definition.name !== 'string' || !definition.name) {
    throw Object.assign(Error('INVALID_TOOL_DEFINITION'), { code: 'INVALID_TOOL_DEFINITION' });
  }
  const { capabilities, allowedOperations = null, ...rest } = definition;
  const tool={...rest,execute(args,exec){
    // Fail closed before the authorized write and before the plugin's own implementation runs.
    runtime.roleGuard?.assertCall?.({ sessionId: agent.session?.id ?? null, identity: tool.name, implementation: tool,
      operation: typeof args?.op === 'string' ? args.op : null });
    return runtime.host.executeAuthorized('business',()=>{
      const route=runtime.router.route(agent.session.id);
      if(!route?.routed)throw Error('NOT_ROUTED');
      if(route.attemptId)runtime.core.authority(route.attemptId,route.fence);
      return definition.execute(args,exec);
    });
  }};
  // An invalid declaration refuses the registration itself: a tool cannot be registered with a capability nobody
  // publishes, and it cannot be registered without an implementation token to bind that declaration to.
  const registration=runtime.roleGuard?.register?.({ identity: tool.name, capabilities: capabilities ?? [],
    operations: allowedOperations, implementation: tool, source: 'business' }) ?? null;
  const dispose=agent.ctx.tools.register(tool);
  let tools=registered.get(agent.session);if(!tools)registered.set(agent.session,tools=new Map());
  const entry = {tool,capabilities:capabilities ?? [],allowedOperations,registration};
  tools.set(tool.name,entry);
  return ()=>{if(tools.get(tool.name)===entry)tools.delete(tool.name);registration?.dispose?.();if(typeof dispose==='function')dispose();};
}
export const isBusinessTool=(agent,name)=>registered.get(agent.session)?.has(name)===true;
/** The registered entry (implementation token, declaration) the role guard resolves a call against. */
export const businessToolEntry=(agent,name)=>registered.get(agent.session)?.get(name)??null;
