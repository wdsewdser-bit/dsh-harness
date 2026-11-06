// Split of the former src/ui.mjs (M6 WP-3): atoms. Pure move, no behaviour change.
import { commandAdmission, commandObject, principalId } from '../authority.mjs';
/* global React, ReactDOM */
import { SEVERITY, CONTEXT_FULL, CONTEXT_WARN, ctxLevel, contextKnown, deadlineSeverity, memberName, relTime, utc, hasDeadline } from '../model.mjs';
import { unsupportedReason } from '../projection.mjs';
export const { createElement: h, Fragment, useState, useEffect, useRef, useSyncExternalStore, useMemo, useCallback } = React;

/**
 * What each command receipt status means to an operator, and how severe it is. `compacted` is the evidence-governance
 * answer: the operation did commit once, its result body was collected afterwards, replaying the same operationId is a
 * typed refusal (RECEIPT_COMPACTED), and re-running the business action under a new id is exactly what must not happen.
 */
export const RECEIPT_STATUS_TEXT = Object.freeze({
  accepted: '已受理 · 等待投影对账（未在本地改写任何状态）',
  conflict: '状态已变化 · 已重新读取投影，请复核后重试',
  rejected: '被服务端拒绝',
  unknown: '结果未知 · 等待投影对账',
  compacted: '已压缩 · 该操作此前已提交，结果正文已被证据治理收集；原样重放会以 RECEIPT_COMPACTED 拒绝，请不要换新 operationId 重跑同一业务操作',
});
export function receiptSeverity(status) {
  if (status === 'conflict' || status === 'compacted') return 'warn';
  if (status === 'unknown') return 'unknown';
  if (status === 'rejected') return 'bad';
  return 'ok';
}

/** Wiring set once by the plugin (single Team instance per client). */
export const TEAM = { client: null, ui: null, gateway: null, nav: null, source: null, control: null };

export const clockStore = (() => {
  let now = Date.now(), timer = null; const ls = new Set();
  return { get: () => now, sub(l) { ls.add(l); if (!timer) timer = setInterval(() => { now = Date.now(); ls.forEach(f => f()); }, 1000);
    return () => { ls.delete(l); if (!ls.size) { clearInterval(timer); timer = null; } }; } };
})();
export const useNow = () => useSyncExternalStore(clockStore.sub, clockStore.get);
export const useClient = () => useSyncExternalStore(TEAM.client.subscribe, TEAM.client.getSnapshot);
export const useUi = () => useSyncExternalStore(TEAM.ui.subscribe, TEAM.ui.getSnapshot);
export const cx = (...names) => names.filter(Boolean).join(' ');
export const memberById = (data, id) => data?.members.find(m => m.id === id) ?? null;
export const isEditable = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
// Identity: the viewer is the authoritative principal the source reads as (member:*), never a UI constant.
export const viewerOf = () => { const st = TEAM.client?.getSnapshot();
  return principalId(st?.viewer, st?.teamId ?? st?.data?.team?.teamId); };
export const dataOf = () => TEAM.client?.getSnapshot().data ?? null;
export const kname = id => id == null ? '—' : id === viewerOf() ? `${memberName(dataOf(), id)}（你）` : memberName(dataOf(), id);
// Known/unknown comes from the projection itself (goal.status, member.contextStatus, approvalsStatus): no hard-coded gaps.
export const UNKNOWN = '未知';
export const NO_DATA = UNKNOWN;
export const WHY = { context: '没有已提交的 context 计量（不显示为 0%）', counter: '没有已提交的计数（不补 0）', goal: '投影未给出原生 goal（goal.status = unknown）',
  gate: '没有已提交的完成门禁检查', approvals: '投影未给出 scope approval 读视图（approvalsStatus = unknown）' };
export const num = v => typeof v === 'number' && Number.isFinite(v);
/** Optional committed counter: value or 未知 (never 0 for "absent"). */
export const counter = (v, fmt = x => String(x)) => num(v) ? fmt(v) : h('span', { className: 'tm-cap', title: WHY.counter }, UNKNOWN);

// ── atoms ──────────────────────────────────────────────
export function Glyph({ sev, title }) {
  const s = SEVERITY[sev] ?? SEVERITY.ok;
  return h('span', { className: 'tm-glyph', 'data-sev': sev, title: title ?? s.label, role: 'img', 'aria-label': title ?? s.label },
    sev === 'unknown' ? h('span', null, '?') : s.glyph);
}
/** context.pct is already relative to the 75% hard limit (100 = full bar); it is shown as-is, never re-divided. */
export const pctText = p => `${Math.round(p)}%`;
export function CtxBar({ context, member, big }) {
  if (member?.observed === 'retired') return h('span', { className: 'tm-cap' }, '—');
  if (!contextKnown({ context, contextStatus: member?.contextStatus })) return h('span', { className: 'tm-ctx tm-cap', 'data-ctx': 'unknown',
    title: `上下文${UNKNOWN}：${member?.contextStatus?.reason ?? WHY.context}`, style: { fontSize: 11.5 } }, UNKNOWN);
  const level = ctxLevel(context.pct);
  const limit = num(context.limitTokens) ? context.limitTokens : null;
  return h('div', { className: cx('tm-ctx', big && 'tm-ctx-big'), 'data-level': level, 'data-ctx': 'known',
    title: `已用 75% 硬上限的 ${pctText(context.pct)} · ${context.inputTokens.toLocaleString()}${limit ? ` / ${Math.round(limit).toLocaleString()}` : ''} tok（窗口 ${context.window.toLocaleString()}）· ${CONTEXT_WARN}% 处为琥珀刻度` },
  h('div', { className: 'tm-bar', 'data-level': level, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': CONTEXT_FULL, 'aria-valuenow': Math.round(context.pct), 'aria-label': '上下文占 75% 上限' },
    h('i', { className: 'tm-bar-fill', style: { width: `${Math.min(100, context.pct)}%` } }), h('i', { className: 'tm-bar-tick' })),
  h('span', { className: 'num tm-ctx-pct' }, pctText(context.pct)),
  context.pct >= CONTEXT_FULL && !big && num(context.hardGateHits) && context.hardGateHits > 0 ? h('span', { className: 'tm-capped', title: `已兜底压缩（75% 硬门命中 ${context.hardGateHits} 次）` }, '兜底') : null);
}
export function AckDots({ ack, now }) {
  if (!ack) return h('span', { className: 'tm-cap' }, '—');
  const overdue = ack.worst.deadline != null && ack.worst.deadline <= now && !ack.worst.receipts.accepted;
  const names = ['stored', 'visible', 'accepted'];
  return h('div', { className: 'tm-ack', title: `最差一条 ${ack.worst.id}：${names.map((n, i) => `${n} ${ack.level > i ? '✓' : '✗'}`).join(' · ')}` },
    h('span', { className: 'tm-dots', 'data-sev': overdue ? 'bad' : undefined, 'aria-label': `确认级别 ${ack.level}/3` },
      names.map((n, i) => h('i', { key: n, 'data-on': String(ack.level > i) }))),
    ack.unaccepted ? h('span', { className: cx('num', overdue && 'tm-lease-bad') }, ack.unaccepted) : null);
}
export function Lease({ attempt, now }) {
  const l = attempt?.lease;
  if (!l) return h('span', { className: 'tm-cap' }, '—');
  if (l.state !== 'active') return h('span', { className: 'num tm-lease-bad', title: `lease ${l.state} · fence ${l.fence}` }, 'L✗');
  const left = l.expiresAt - now;
  if (left <= 0) return h('span', { className: 'num tm-lease-bad', title: '到期，等待对账（不代表进程已停）' }, 'L? 0s');
  return h('span', { className: 'num', title: `active · fence ${l.fence} · 到期 ${utc(l.expiresAt)}` }, `L✓ ${relTime(left)}`);
}
export function Fold({ context }) {
  if (!context) return h('span', { className: 'tm-cap' }, '—');
  if (!context.fold) return h('span', { className: 'tm-cap', title: `折叠：${WHY.counter}` }, '?');
  if (!context.fold.enabled) return h('span', { className: 'num tm-fold-off', title: '第二层折叠未启用' }, 'off');
  return h('span', { className: 'num', title: `第二层折叠 ${context.fold.count} 次` }, `F${context.fold.count}`);
}
export function WaitCell({ wait, now, onJump }) {
  if (!wait) return h('span', { className: 'tm-cap' }, '—');
  const sev = hasDeadline(wait.deadline) ? deadlineSeverity(wait.openedAt, wait.deadline, now) : null;
  const target = wait.memberRef
    ? h(Fragment, null, h('button', { className: 'tm-link', onClick: e => { e.stopPropagation(); onJump?.(wait.memberRef); }, title: `跳到 ${wait.memberRef}` }, memberName(dataOf(), wait.memberRef)),
      h('span', { className: 'tm-fg3' }, ' msg'))
    : h('span', { title: `${wait.kind} · ${wait.ref}` }, wait.label);
  return h('div', { className: 'tm-wait', 'data-sev': sev, title: `${wait.kind} · deadline ${hasDeadline(wait.deadline) ? utc(wait.deadline) : '无截止时间'}` },
    h('span', { className: 'tm-fg3' }, '⇢'), target, h('span', { className: 'num tm-wait-left' }, hasDeadline(wait.deadline) ? `(${relTime(wait.deadline - now)})` : '(无截止时间)'));
}
export function CmdButton({ cmd, label, disabled, title }) {
  const admission = commandAdmission(cmd, dataOf(), viewerOf(), TEAM.scope?.generation);
  if (cmd?.hidden || admission) {
    return commandObject(dataOf(), cmd?.target)?.capabilities ? h('div', { className: 'tm-note', role: 'note',
      'data-capability-refusal': cmd?.name }, admission ?? cmd.disabledReason) : null;
  }
  const why = cmd?.disabledReason && (cmd.hardDisabled || unsupportedReason(cmd.name)) ? cmd.disabledReason : null;
  return h('button', { className: 'tm-btn', disabled: !!(disabled || why), title: why ?? title, 'data-unsupported': why ? 'true' : undefined,
    onClick: () => TEAM.ui.openPalette(cmd) }, label);
}

export function Field({ field, value, onChange, id }) {
  const label = h('span', null, field.label, field.required ? h('em', null, '*') : null);
  if (field.type === 'radio') return h('div', { className: 'tm-field', role: 'radiogroup', 'aria-label': field.label }, label,
    field.options.map(([v, text]) => h('label', { key: v, className: 'tm-radio', 'data-checked': String(value === v) },
      h('input', { type: 'radio', name: id, value: v, checked: value === v, onChange: () => onChange(v) }), h('span', null, text))));
  if (field.type === 'choice') return h('label', { className: 'tm-field' }, label,
    h('select', { className: 'tm-input', value, 'aria-label': field.label, onChange: e => onChange(e.target.value) }, field.options.map(([v, text]) => h('option', { key: v, value: v }, text))));
  if (field.type === 'textarea') return h('label', { className: 'tm-field' }, label, h('textarea', { className: 'tm-input', value, 'aria-label': field.label, onChange: e => onChange(e.target.value) }));
  return h('label', { className: 'tm-field' }, label, h('input', { className: 'tm-input', 'aria-label': field.label, type: field.type === 'number' ? 'number' : 'text', value, min: 1,
    onChange: e => onChange(field.type === 'number' ? Number(e.target.value) : e.target.value) }));
}

