import { humanText, referenceIds } from '../human-text.mjs';
// M6 WP-4 (16 §3.3): the records page. A filtered timeline read through the P12 endpoint; the page never invents
// events. Newest first, grouped by day. The five chips are the projection's categories.
import { clock } from '../model.mjs';
import { h, Fragment, useRef, useEffect, useSyncExternalStore } from './atoms.mjs';
import { ActivityPager, recordPresentation } from '../activity.mjs';
import { TEAM, useNow, useUi, useClient, cx, UNKNOWN } from './atoms.mjs';

export const RECORD_CHIPS = Object.freeze([
  ['all', '全部'], ['anomaly', '只看异常'], ['needs-you', '需要你'],
  ['root-decision', 'root 的裁决'], ['delivery', '交付与验收'],
]);
export const RECORD_RANGES = Object.freeze([['all', '全部时间'], ['today', '今天'], ['7d', '最近 7 天']]);
// 15 §9 V-23: --tm-done belongs to accepted work only. A record's dot marks its category, not an acceptance: the
// delivery timeline also carries produced/verifying rows, so it uses the in-progress token and never turns green.
export const SEV = Object.freeze({ anomaly: 'bad', 'needs-you': 'warn', 'root-decision': 'ok', delivery: 'wait', other: 'idle' });
const DAY = 86400000;

export function dayKey(at, now) {
  const date = new Date(at);
  const today = new Date(now);
  const startOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(date)) / DAY);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
}

export function groupByDay(events, now) {
  const groups = [];
  for (const event of events) {
    const key = dayKey(event.at, now);
    let group = groups.find(item => item.key === key);
    if (!group) { group = { key, events: [] }; groups.push(group); }
    group.events.push(event);
  }
  return groups;
}

export function RecordRow({ event, onOpen, data }) {
  const { title: name, text } = recordPresentation(data, event);
  return h('li', { 'data-sev': SEV[event.category] ?? 'idle', 'data-record': event.id, 'data-category': event.category, role: 'button', tabIndex: 0,
    onClick: e => { e?.currentTarget?.focus?.({ preventScroll: true }); onOpen(event); },
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } },
    h('span', { className: 'tm-v3-time num' }, clock(event.at)),
    h('span', { className: 'tm-v3-dot' }),
    h('div', null, h('b', { className: 'tm-v3-who', title: name }, name), ' ', text,
      (event.tags ?? []).length ? h('span', { className: 'tm-v3-tags' }, ' · ' + event.tags.map(tag => humanText(tag, '', referenceIds(data, event))).filter(Boolean).join(' · ')) : null));
}

export function RecordsPage({ data, now, initialPage = null }) {
  const ui = useUi();
  const st = useClient(), source = TEAM.source;
  const ref = useRef(null);
  if (!ref.current) ref.current = new ActivityPager(initialPage);
  const pager = ref.current;
  const from = ui.recordRange === 'all' ? null : new Date(now).setHours(0, 0, 0, 0) - (ui.recordRange === '7d' ? 7 * DAY : 0);
  const query = { kind: ui.recordFilter === 'all' ? null : ui.recordFilter, member: ui.recordMember, from, limit: 20 };
  const scope = st.scopeGeneration ?? 0, key = JSON.stringify([query, scope]);
  const state = useSyncExternalStore(pager.subscribe, pager.getSnapshot);
  const active = !source?.activity || pager.matches(source, query, scope);
  const page = active ? state.page : null, loading = !active || state.loading, error = active ? state.error : null;
  useEffect(() => { pager.setScope(source, query, scope); return () => pager.dispose(); }, [source, key]);
  const more = () => pager.load(true);
  const clear = () => { TEAM.ui.setRecordFilter('all'); TEAM.ui.setRecordMember(null); TEAM.ui.setRecordRange('all'); };
  const members = data?.members ?? [];
  const events = page?.events ?? [];
  return h('div', { className: 'tm-v3-col', 'data-page': 'records' },
    h('div', { className: 'tm-v3-chips' },
      RECORD_CHIPS.map(([value, label]) => h('button', { key: value, type: 'button', className: cx('tm-v3-chip', ui.recordFilter === value && 'on'),
        'data-chip': value, 'aria-pressed': String(ui.recordFilter === value), onClick: () => TEAM.ui.setRecordFilter(value) }, label)),
      h('span', { className: 'tm-spacer' }),
      h('select', { className: 'tm-v3-select', 'aria-label': '按成员筛选', value: ui.recordMember ?? '',
        onChange: e => TEAM.ui.setRecordMember(e.target.value || null) },
        h('option', { value: '' }, '成员：全部'), members.map(m => h('option', { key: m.id, value: m.id }, '成员：' + (m.name ?? m.id)))),
      h('select', { className: 'tm-v3-select', 'aria-label': '按时间筛选', value: ui.recordRange,
        onChange: e => TEAM.ui.setRecordRange(e.target.value) },
        RECORD_RANGES.map(([value, label]) => h('option', { key: value, value }, label)))),
    error ? h('div', { className: 'tm-v3-empty', 'data-error': 'records' }, h('b', null, '连不上记录'),
      h('div', { className: 'tm-fg3' }, error), h('button', { className: 'tm-btn', type: 'button', onClick: () => pager.load(false) }, '重试'))
      : loading && !events.length ? h('div', { className: 'tm-v3-empty' }, '正在读取记录…')
      : !events.length ? h('div', { className: 'tm-v3-empty', 'data-empty': 'records' }, h('b', null, '这个筛选下没有记录'),
        h('button', { className: 'tm-btn', type: 'button', onClick: clear }, '清除筛选'))
      : h(Fragment, null,
        groupByDay(events, now).map(group => h('section', { key: group.key, className: 'tm-v3-day' },
          h('div', { className: 'tm-v3-daylabel' }, group.key),
          h('ul', { className: 'tm-v3-tl' }, group.events.map(event => h(RecordRow, { key: event.id + ':' + event.seq, event, data,
            onOpen: item => { TEAM.ui.openInspector('record', item.id, { event: item }); TEAM.ui.setDrawer('detail'); } }))))),
        page?.nextBeforeSeq != null ? h('button', { className: 'tm-btn tm-v3-more', type: 'button', disabled: loading, onClick: more }, '更早的记录') : null));
}
