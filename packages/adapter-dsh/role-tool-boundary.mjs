import { AsyncLocalStorage } from 'node:async_hooks';

/** P2 adapter contract. No listeners or definition changes until a role policy is installed.
 * Registered bodies, shared pipelines and the executor entry all use the same initiating-session carrier.
 * A plugin's arbitrary JS/function copied before registration is NOT a supported tool entry.
 */
export function createRoleToolBoundary(tools) {
  const context = new AsyncLocalStorage(), policies = [], definitions = [], executors = [], wrapped = new WeakSet();
  let initiator = () => null;
  const native = new WeakMap();
  const sid = exec => context.getStore()?.sessionId ?? exec?.agent?.session?.id ?? initiator()?.session?.id ?? null;
  const question = (exec, definition) => {
    const agent = context.getStore()?.agent ?? exec?.agent ?? initiator();
    const identity = definition?.name ?? exec?.name ?? null;
    // The step's old toolSet and captured callbacks are not current registration authority.
    const current = typeof tools.get === 'function' ? tools.get(identity, agent) : tools.executable(identity, agent);
    return { sessionId: sid(exec), identity, implementation: current === definition ? definition ?? null : null,
      operation: typeof exec?.arguments?.op === 'string' ? exec.arguments.op : null, authority: context.getStore()?.authority ?? null };
  };
  const check = (exec, definition) => { for (const policy of policies) policy(question(exec, definition)); };
  const run = (exec, definition, work) => {
    if (!policies.length) return work();
    const carrier = Object.freeze({ sessionId: sid(exec), agent: context.getStore()?.agent ?? exec?.agent ?? initiator(),
      authority: context.getStore()?.authority ?? new Map(), definition });
    return context.run(carrier, () => { check(exec, definition); return work(); });
  };
  function wrap(definition) {
    if (wrapped.has(definition)) return;
    const body = definition.execute, name = definition.name;
    if (typeof body !== 'function') throw Error('ROOT_GUARD_UNAVAILABLE: tool has no body');
    // Bind both the name and the body: mutating a registered object cannot swap in foreign work under its declaration.
    Object.defineProperty(definition, 'name', { value: name, writable: false, configurable: false, enumerable: true });
    Object.defineProperty(definition, 'execute', { configurable: false, enumerable: true, writable: false,
      value: function(args, exec) {
        const execution = { ...exec, name, arguments: args };
        return run(execution, definition, () => Reflect.apply(body, this, [args, exec]));
      } });
    wrapped.add(definition);
  }
  function wrapExecutor(executor) {
    if (wrapped.has(executor)) return;
    const execute = executor.execute;
    Object.defineProperty(executor, 'execute', { configurable: false, writable: false,
      value: function(input) { return api.batch(input, () => Reflect.apply(execute, this, [input])); } });
    wrapped.add(executor);
  }
  const api = Object.freeze({ version: 'role-tool-boundary/1',
    current: () => context.getStore() ?? null,
    declareNative(definition, capabilities) {
      native.set(definition, Object.freeze([...capabilities]));
      return definition;
    },
    nativeDeclaration: definition => native.get(definition) ?? null,
    track(definition) { definitions.push(new WeakRef(definition)); if (policies.length) wrap(definition); },
    trackExecutor(executor) { executors.push(new WeakRef(executor)); if (policies.length) wrapExecutor(executor); },
    install(policy, getInitiator) {
      if (typeof policy !== 'function' || typeof getInitiator !== 'function') throw Error('ROOT_GUARD_UNAVAILABLE');
      // Wrap before publishing the policy. An unwritable definition means this host cannot provide the contract.
      for (const ref of definitions) { const definition = ref.deref(); if (definition) wrap(definition); }
      for (const ref of executors) { const executor = ref.deref(); if (executor) wrapExecutor(executor); }
      initiator = getInitiator;
      policies.push(policy); // permanent tombstone on revoke; only context disposal removes the execution boundary
    },
    check,
    run,
    batch(input, work) {
      if (!policies.length) return work();
      return context.run(Object.freeze({ sessionId: sid(input), agent: context.getStore()?.agent ?? input.agent ?? initiator(), authority: context.getStore()?.authority ?? new Map(), definition: null }), () => {
        for (const call of input.calls) {
          let args; try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments; } catch { args = null; }
          const exec = { agent: input.agent, name: call.name, arguments: args };
          check(exec, tools.executable(call.name, input.agent, input.toolSet));
        }
        return work();
      });
    },
  });
  return api;
}
