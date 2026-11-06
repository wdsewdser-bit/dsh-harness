import { createTeamHost } from './host.mjs';
import { createEffectRunner } from './effect-runner.mjs';
/** Product consumer for non-profile embedders; no legacy IO or native-effect claims. */
export function createLifecycleConsumer(core, { root, intervalMs = 500 } = {}) {
  let runner, running = null;
  const host = createTeamHost({ teamId: 'team:lifecycle', root, core, recoverer: async () => ({ status: 'ok', admission: true }),
    cycleIntervalMs: intervalMs, steps: { drain: () => ({}), intents: () => host.coreAccess.lifecycle().prepareLifecycle(), pump: () => runner.pump() } });
  const ports = {};
  for (const kind of ['create', 'resume', 'dispose', 'cancel-member']) ports[kind] = async request => ({ executed: true,
    receipt: await core.ports[kind === 'cancel-member' ? 'cancel' : kind]({ ...request, nativeRef: core.store.read(request.memberId)?.nativeRef }) });
  runner = createEffectRunner({ access: host.coreAccess, clock: host.clock, ports });
  const ready = host.start();
  const cycle = () => {
    if (running) return running;
    running = (async () => { await ready; const before = core.store.effects().filter(e => e.id.startsWith('lifecycle:')).length;
      await host.cycle.kick('external'); await runner.whenIdle();
      while (runner.pump().claimed > 0) await runner.whenIdle();
      return core.store.effects().filter(e => e.id.startsWith('lifecycle:')).slice(before).map(e => ({ result: e }));
    })().finally(() => { running = null; });
    return running;
  };
  return { cycle, kick: () => { cycle().catch(() => {}); }, whenSettled: async () => { await (running ?? cycle()); },
    async stop() { await ready; await host.stop(); runner.stop(); }, status: () => runner.status() };
}
