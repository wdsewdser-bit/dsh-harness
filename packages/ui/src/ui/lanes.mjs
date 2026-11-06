import { humanText, referenceIds } from '../human-text.mjs';
// Split of the former src/ui.mjs (M6 WP-3): lanes. Pure move, no behaviour change.
import {
  SEVERITY, CONTEXT_FULL, CONTEXT_WARN, ROLE_ABBR, ROLE_LABEL, PIPELINE, groupRows, groupKey, memberName, pipelineCounts,
  truncate, waitChain, relTime
} from '../model.mjs';
import { h, Fragment, useEffect } from './atoms.mjs';
import { TEAM, memberById, useUi, UNKNOWN, WHY, num, Glyph, pctText, CtxBar, AckDots, Lease, Fold, WaitCell } from './atoms.mjs';
import { TaskCell } from './commands.mjs';
import { MemberSummaryLine } from './situation.mjs';
// ── lanes ────────────────────────────────────────────────
export function effectiveDensity(ui, n) { return ui.density === 'auto' ? (n > 16 ? 'compact' : 'comfortable') : ui.density; }
export function isCollapsed(ui, g, memberCount) { return g.headless ? false : ui.collapsed[g.group.id] ?? (memberCount > 10 ? !g.hot : false); }
export function Tally({ tally }) {
  const keys = ['bad', 'unknown', 'warn', 'wait'];
  const parts = keys.filter(k => tally[k]).map(k => h('span', { key: k, className: 'tm-tally tm-sevtext', 'data-sev': k }, h('span', { className: 'num' }, tally[k]), SEVERITY[k].glyph));
  return parts.length ? h('span', { className: 'tm-tally', style: { gap: 6 } }, parts) : h('span', { className: 'tm-cap' }, '全部正常');
}
export function laneModel(data, now, ui, order) {
  const groups = groupRows(data, now, order);
  const n = data.members.length;
  const anomalies = new Set();
  if (ui.onlyAnomalies) for (const g of groups) for (const r of g.rows) if (r.severity !== 'ok') for (const id of waitChain(data, r.member.id)) anomalies.add(id);
  const visible = [];
  const shaped = groups.map(g => {
    let rows = g.rows;
    if (ui.onlyAnomalies) rows = rows.filter(r => anomalies.has(r.member.id));
    if (ui.stage) rows = rows.filter(r => r.task?.state === ui.stage);
    const collapsed = isCollapsed(ui, g, n);
    if (!collapsed) for (const r of rows) visible.push(r.member.id);
    return { ...g, shownRows: rows, collapsed };
  }).filter(g => !(ui.onlyAnomalies || ui.stage) || g.shownRows.length);
  return { groups: shaped, visible, density: effectiveDensity(ui, n) };
}
export function Lanes({ data, now, ui, model, onOpen }) {
  const flashing = ui.flash.id && now - ui.flash.at < 2200 ? ui.flash.id : null;
  const jump = id => {
    const m = memberById(data, id);
    if (!m) return;
    TEAM.ui.setGroup(groupKey(m.group), false); TEAM.ui.flash(id); TEAM.ui.openDetail('member', id);
  };
  useEffect(() => { if (ui.flash.id) document.querySelector(`.tm-row[data-member="${ui.flash.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [ui.flash.at]);
  const rowCount = model.groups.reduce((a, g) => a + 1 + (g.collapsed ? 0 : g.shownRows.length), 1);
  return h('section', { 'aria-label': '成员泳道' },
    h('div', { className: 'tm-section-title' }, '成员', h('span', { className: 'tm-badge num' }, data.members.length),
      ui.stage ? h('button', { className: 'tm-badge', style: { cursor: 'pointer', background: 'none' }, onClick: () => TEAM.ui.setStage(ui.stage) }, `任务 ${ui.stage} ✕`) : null,
      h('span', { className: 'tm-spacer' }),
      h('div', { className: 'tm-toolbar', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } },
        h('button', { className: 'tm-btn', 'aria-pressed': ui.onlyAnomalies, onClick: TEAM.ui.toggleAnomalies, title: '只显示非 ● 的行与其等待链对象' }, '只看异常 ', h('span', { className: 'tm-kbd' }, 'x')),
        h('button', { className: 'tm-btn', 'aria-pressed': model.density === 'compact', onClick: () => TEAM.ui.cycleDensity(model.density), title: '舒适 32px / 紧凑 24px' },
          model.density === 'compact' ? '紧凑' : '舒适', ' ', h('span', { className: 'tm-kbd' }, 'd')))),
    h('div', { className: 'tm-lanes', 'data-density': model.density, role: 'grid', 'aria-rowcount': rowCount, 'aria-label': '成员泳道：状态、任务、等待、确认、上下文、折叠、租约' },
      h('div', { className: 'tm-lane-grid tm-lane-head', role: 'row' },
        ['', '成员', '当前任务', '等待 → 对象', 'ACK', '上下文 / 上限', 'F', '租约'].map((t, i) =>
          h('div', { key: i, role: 'columnheader', className: ['', '', 'tm-col-task', '', 'tm-col-ack', '', 'tm-col-fold', 'tm-col-lease'][i] }, t))),
      data.members.length === 0 ? h('div', { className: 'tm-empty' }, '还没有成员：root 会按目标创建') : null,
      model.groups.map(g => h(Fragment, { key: g.group.id },
        g.headless ? null : h('button', { className: 'tm-group', role: 'row', 'aria-expanded': String(!g.collapsed), onClick: () => TEAM.ui.setGroup(g.group.id, !g.collapsed) },
          h('span', { className: 'tm-caret' }, '▾'),
          h('span', { className: 'tm-group-name', title: g.group.undescribed ? '该组不在投影的 groups 列表中（按成员自身 group 字段归组）' : undefined }, g.group.label),
          g.group.lead ? h('span', { className: 'tm-cap' }, `子协调者 ${memberName(data, g.group.lead)}`) : null,
          h('span', { className: 'tm-group-sum' }, h('span', { className: 'num' }, `${g.rows.length} 人`), h(Tally, { tally: g.tally }),
            h('span', null, '上下文最高 ', g.maxCtx == null ? h('span', { className: 'tm-cap', title: WHY.context }, UNKNOWN)
              : h('span', { className: 'num tm-sevtext', 'data-sev': g.maxCtx >= CONTEXT_FULL ? 'bad' : g.maxCtx >= CONTEXT_WARN ? 'warn' : undefined }, pctText(g.maxCtx))))),
        g.collapsed ? null : g.shownRows.map(r => {
          const m = r.member;
          return h('div', { key: m.id, className: 'tm-lane-grid tm-row', role: 'row', 'data-member': m.id, 'data-sev': r.severity, 'aria-selected': String(ui.selected === m.id),
            'data-flash': String(flashing === m.id || (r.movedAt && now - r.movedAt < 2000)),
            onClick: () => { TEAM.ui.select(m.id); TEAM.ui.openDetail('member', m.id); }, onDoubleClick: () => onOpen(m.id) },
          h('div', { role: 'gridcell' }, h(Glyph, { sev: r.severity })),
          h('div', { role: 'gridcell', className: 'tm-name', title: `${m.name} · ${ROLE_LABEL[m.role]}` }, h('strong', null, truncate(m.name, 16)), h('span', { className: 'tm-role', title: ROLE_LABEL[m.role] }, ROLE_ABBR[m.role])),
          h('div', { role: 'gridcell', className: 'tm-col-task' }, h(TaskCell, { task: r.task, member: m })),
          h('div', { role: 'gridcell' }, h(WaitCell, { wait: m.wait, now, onJump: jump })),
          h('div', { role: 'gridcell', className: 'tm-col-ack' }, h(AckDots, { ack: r.ack, now })),
          h('div', { role: 'gridcell' }, h(CtxBar, { context: m.context, member: m })),
          h('div', { role: 'gridcell', className: 'tm-col-fold' }, h(Fold, { context: m.context })),
          h('div', { role: 'gridcell', className: 'tm-col-lease' }, h(Lease, { attempt: m.attempt, now })));
        }))),
      data.restrictedMembers ? h('div', { className: 'tm-restricted', role: 'row' }, h('span', { className: 'tm-glyph', 'data-sev': 'frozen' }, '⊘'),
        `受限成员 ×${data.restrictedMembers}（服务端 ACL 过滤，不显示名称）`) : null));
}


// ── v3 §3.2 members page ─────────────────────────────────
/** Five states, in the order the page sorts by importance (§3.2). */
export function memberStatus(member) {
  if (member.observed === 'unknown' || member.status === 'unknown') return { key: 'stuck', text: '卡住 · root 在处理', sev: 'warn' };
  if (member.observed === 'retired') return { key: 'retired', text: '已退役', sev: 'idle' };
  if (member.desired === 'retired' || member.observed === 'retiring') return { key: 'retiring', text: '退役中…', sev: 'idle' };
  if (member.observed === 'frozen') return { key: 'paused', text: '已暂停', sev: 'idle' };
  if (member.desired === 'frozen') return { key: 'pausing', text: '正在暂停…', sev: 'warn' };
  const activity = member.activity ?? null;
  if (activity?.kind === 'running') return { key: 'running', text: '正常', sev: 'ok' };
  if (activity?.kind === 'maintenance') return { key: 'maintenance', text: '维护中', sev: 'warn' };
  return { key: 'idle', text: '空闲', sev: 'idle' };
}

/** The "what is it doing" column: one sentence, never a status-machine word. */
export function memberDoing(member, data) {
  const references = referenceIds(data);
  const activity = member.activity ?? null;
  const task = member.taskId ? (data.tasks ?? []).find(t => t.id === member.taskId) : null;
  if (task) return humanText(task.title, '正在处理任务', references);
  if (activity?.kind === 'maintenance') return humanText(activity.sub, '维护中', references) + (activity.since ? ' · ' + relTime(Date.now() - activity.since) : '');
  if (activity?.kind === 'running') {
    if (activity.tool) return '正在处理任务 · 已用 ' + relTime(activity.tool.elapsed);
    return humanText(activity.sub, activity.since ? relTime(Date.now() - activity.since) : '运行中', references);
  }
  if (member.wait) return '在等 ' + humanText(member.wait.targetLabel, '外部输入', references);
  return '没有进行中的任务';
}

export function MembersPage({ data, now }) {
  const ui = useUi();
  const groups = data.groups ?? [];
  const members = data.members ?? [];
  const references = referenceIds(data);
  const row = member => {
    const status = memberStatus(member);
    return h('tr', { key: member.id, 'data-member': member.id, 'data-group': groupKey(member.group), 'data-selected': String(ui.selected === member.id),
      onClick: () => { TEAM.ui.select(member.id); TEAM.ui.openInspector('member', member.id); TEAM.ui.setDrawer('detail'); } },
      h('td', { className: 'tm-v3-name', title: humanText(member.name, '成员', references) }, humanText(memberName(data, member.id), '成员', references)),
      h('td', { className: 'tm-v3-what fg2', title: memberDoing(member, data) }, memberDoing(member, data)),
      h('td', null, h('span', { className: 'tm-v3-st', 'data-sev': status.sev, 'data-status': status.key }, status.text)));
  };
  const grouped = groups.length > 1 && members.length > 6;
  const body = [];
  if (grouped) {
    for (const group of groups) {
      const rows = members.filter(m => groupKey(m.group) === group.id);
      if (!rows.length) continue;
      body.push(h('tr', { key: 'g:' + group.id, className: 'tm-v3-group', 'data-group-header': group.id }, h('td', { colSpan: 3 }, group.label ?? group.id)));
      for (const member of rows) body.push(row(member));
    }
    const ungrouped = members.filter(m => !groups.some(g => g.id === groupKey(m.group)));
    if (ungrouped.length) body.push(h('tr', { key: 'ungrouped', className: 'tm-v3-group', 'data-group-header': '__ungrouped' },
      h('td', { colSpan: 3 }, '未分组')));
    for (const member of ungrouped) body.push(row(member));
  } else for (const member of members) body.push(row(member));
  return h('div', { className: 'tm-v3-col', 'data-page': 'members' },
    h(MemberSummaryLine, { summary: data.memberSummary ?? null, onOpen: () => TEAM.ui.setPage('members') }),
    h('table', { className: 'tm-v3-table' },
      h('thead', null, h('tr', null, h('th', { style: { width: '24%' } }, '名字'), h('th', null, '在做什么'),
        h('th', { style: { width: '26%' } }, '状态'))),
      h('tbody', null, body)));
}

export function Pipeline({ data, ui }) {
  const c = pipelineCounts(data.tasks);
  const label = { produced: 'produced', verifying: 'verifying', verified: 'verified', integrating: 'integrating', merged: 'merged', accepted: '✓ accepted' };
  return h('section', { 'aria-label': '交付管线' },
    h('div', { className: 'tm-section-title' }, '交付管线', h('span', { className: 'tm-spacer' }),
      h('span', { className: 'tm-cap', style: { textTransform: 'none', letterSpacing: 0, fontWeight: 400 } }, 'produced ≠ accepted：只有 accepted 用绿色')),
    h('div', { className: 'tm-pipe' }, PIPELINE.map((k, i) => h('button', { key: k, className: 'tm-stage', 'data-end': k === 'produced' || (k === 'accepted' && c[k] > 0) ? k : undefined,
      'aria-pressed': ui.stage === k, onClick: () => { TEAM.ui.setStage(k); TEAM.ui.setTab('task'); } },
    h('span', { className: 'tm-stage-label' }, label[k]), h('span', { className: 'tm-stage-count' }, c[k]),
    i < PIPELINE.length - 1 ? h('span', { className: 'tm-stage-arrow', 'aria-hidden': true }, '›') : null))));
}

