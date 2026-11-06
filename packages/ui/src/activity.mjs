import { humanText, referenceIds } from './human-text.mjs';
// Request generation covers first pages, older pages, failures and source/team/filter changes alike.
export class ActivityPager {
  constructor(initialPage = null) {
    this.state = { page: initialPage, loading: false, error: null };
    this.listeners = new Set(); this.generation = 0; this.key = null; this.source = null;
  }
  getSnapshot = () => this.state;
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  set(patch) { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  matches(source, query, scope) { return this.source === source && this.key === JSON.stringify([query, scope]); }
  setScope(source, query, scope) {
    if (this.matches(source, query, scope)) return Promise.resolve();
    this.generation++; this.source = source; this.query = query; this.key = JSON.stringify([query, scope]);
    this.set({ page: null, loading: false, error: null });
    return this.load(false);
  }
  dispose() { this.generation++; this.key = null; }
  async load(more = false) {
    if (this.state.loading || !this.source?.activity) return;
    const before = this.state.page;
    if (more && before?.nextBeforeSeq == null) return;
    const generation = this.generation;
    this.set({ loading: true, error: null });
    try {
      const page = await this.source.activity({ ...this.query, ...(more ? { beforeSeq: before.nextBeforeSeq } : {}) });
      if (generation !== this.generation) return;
      const events = more ? [...before.events, ...page.events] : page.events;
      const unique = [...new Map(events.map(event => [event.seq, event])).values()];
      this.set({ page: { ...page, events: unique }, loading: false });
    } catch (error) {
      if (generation === this.generation) this.set({ error: String(error?.message ?? error), loading: false });
    }
  }
}
export function recordPresentation(data, event) {
  const id = event?.subject?.id ?? event?.id;
  const row = ['members', 'tasks', 'threads', 'messages', 'decisions', 'intents']
    .flatMap(key => data?.[key] ?? []).find(item => item.id === id);
  const raw = event?.subject?.name;
  const fallback = { task: '任务', thread: '讨论', message: '消息', decision: '决定', intent: '提议', member: '成员' };
  const title = row?.title ?? row?.question ?? row?.summary ?? row?.name ??
    (raw && raw !== id ? raw : fallback[event?.kind] ?? '团队记录');
  let text = event?.text ?? '记录已更新';
  for (const prefix of [raw, id, title].filter(Boolean)) {
    if (text.startsWith(prefix + '：') || text.startsWith(prefix + ':')) { text = text.slice(prefix.length + 1).trim(); break; }
  }
  // References remain available in the technical disclosure, not in the human summary.
  const references = referenceIds(data, event);
  return { title: humanText(title, fallback[event?.kind] ?? '团队记录', references),
    text: humanText(text, '记录已更新', references) };
}
