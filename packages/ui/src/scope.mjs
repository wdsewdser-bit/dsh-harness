// One stable external store; only this production entry owns client/source replacement.
import { ProjectionClient } from './projection.mjs';
import { commandAdmission } from './authority.mjs';
export class TeamScope {
  constructor({ createSource, ui, install = () => {} }) {
    this.createSource = createSource; this.ui = ui; this.install = install;
    this.bindingSource = createSource().source;
    this.listeners = new Set(); this.generation = 0; this.sessionId = undefined;
    this.client = null; this.unlisten = null; this.pending = null;
    this.state = { data: null, viewer: null, status: 'loading', binding: undefined, scopeGeneration: 0 };
  }
  getSnapshot = () => this.state;
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  publish(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  start() { return this.switchSession(this.ui.getSnapshot().frameSession, true); }
  stop() {
    this.generation++; this.unlisten?.(); this.client?.stop();
    this.unlisten = null; this.client = null; this.pending = null; this.install(null);
    this.publish({ data: null, viewer: null, status: 'stopped', binding: undefined, error: null,
      retryAt: null, scopeGeneration: this.generation });
  }
  resync(reason) { return this.client ? this.client.resync(reason) : this.switchSession(this.sessionId, true); }
  switchSession(sessionId, force = false) {
    sessionId ??= null;
    if (!force && this.pending && sessionId === this.sessionId) return this.pending;
    if (!force && this.state.status !== 'error' && this.state.binding !== undefined && sessionId === this.sessionId) return Promise.resolve();
    const generation = ++this.generation;
    this.unlisten?.(); this.unlisten = null; this.client?.stop(); this.client = null;
    this.sessionId = sessionId; this.install(null);
    this.ui.resetScope(sessionId);
    this.state = { data: null, viewer: null, status: 'loading', error: null, binding: undefined,
      sessionId, teamId: null, scopeGeneration: generation };
    this.publish({});
    const current = () => generation === this.generation;
    this.pending = (async () => {
      try {
        // The standalone overview has no native session; a selected session always requires binding confirmation.
        const binding = sessionId == null ? 'overview' : await this.bindingSource.binding(sessionId);
        if (!current()) return;
        if (!binding) { this.publish({ status: 'ready', binding: null }); return; }
        const picked = this.createSource(binding === 'overview' ? null : binding);
        const client = new ProjectionClient(picked.source, { teamId: binding.teamId ?? null });
        this.client = client; this.install(picked);
        const update = () => {
          if (!current()) return;
          this.publish({ ...client.getSnapshot(), binding, sessionId, scopeGeneration: generation });
          const cmd = this.ui.getSnapshot().palette;
          if (cmd && commandAdmission(cmd, this.state.data, this.state.viewer, generation)) this.ui.closePalette();
        };
        this.unlisten = client.subscribe(update);
        await client.start();
        if (current()) this.ui.syncFrame(sessionId, client.getSnapshot().data?.members ?? null);
      } catch (error) {
        if (current()) this.publish({ status: 'error', error: String(error?.message ?? error), binding: undefined });
      } finally { if (current()) this.pending = null; }
    })();
    return this.pending;
  }
}
