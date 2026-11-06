// Command form lifecycle is independent from command descriptor construction.
/* global ReactDOM */
import { freshness } from '../projection.mjs';
import { commandAdmission } from '../authority.mjs';
import { explainError } from './commands.mjs';
import { h, useEffect, useState, useRef, TEAM, useUi, useClient, useNow, Field, RECEIPT_STATUS_TEXT, receiptSeverity } from './atoms.mjs';
/**
 * Action button; commands the server does not support, and commands this viewer may not run (hardDisabled:
 * role or a missing fact), render disabled with the reason as tooltip. Soft reasons stay in the palette.
 */
export function CommandPalette() {
  const ui = useUi(), st = useClient(), now = useNow();
  const cmd = ui.palette;
  const admission = commandAdmission(cmd, st.data, st.viewer, TEAM.scope?.generation);
  useEffect(() => { if (cmd && admission) TEAM.ui.closePalette(); }, [cmd, admission]);
  const [form, setForm] = useState({});
  const [phase, setPhase] = useState({ kind: 'edit' });
  const boxRef = useRef(null), restoreRef = useRef(null);
  useEffect(() => {
    if (!cmd) return;
    restoreRef.current = document.activeElement;
    setForm(Object.fromEntries((cmd.fields ?? []).map(f => [f.key, f.value])));
    setPhase({ kind: 'edit' });
    const t = setTimeout(() => (boxRef.current?.querySelector('.tm-modal-body input,.tm-modal-body textarea,.tm-modal-body select') ?? boxRef.current?.querySelector('.tm-modal-foot button'))?.focus(), 30);
    return () => { clearTimeout(t); const r = restoreRef.current; if (r && document.contains(r)) r.focus?.(); };
  }, [cmd]);
  useEffect(() => {
    if (!cmd) return;
    const onEsc = e => { if (e.key === 'Escape') { e.stopPropagation(); TEAM.ui.closePalette(); } };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [cmd]);
  useEffect(() => { if (phase.kind === 'receipt') boxRef.current?.querySelector('.tm-modal-foot button')?.focus(); }, [phase.kind]);
  if (!cmd || admission) return null;
  const fresh = freshness(st, now);
  const stale = fresh.level === 'stale' || fresh.level === 'error';
  const missing = (cmd.fields ?? []).filter(f => f.required && (form[f.key] === '' || form[f.key] == null || Number.isNaN(form[f.key])));
  const invalid = (cmd.fields ?? []).map(f => form[f.key] != null && form[f.key] !== '' && f.validate?.(form[f.key])).filter(Boolean);
  const blocked = admission || cmd.disabledReason || stale || missing.length > 0 || invalid.length > 0 || phase.kind === 'sending';
  const close = () => TEAM.ui.closePalette();
  const submit = async () => {
    const current = TEAM.client.getSnapshot();
    if (blocked || TEAM.ui.getSnapshot().palette !== cmd ||
        commandAdmission(cmd, current.data, current.viewer, TEAM.scope?.generation)) return;
    const generation = TEAM.scope?.generation;
    setPhase({ kind: 'sending' });
    const receipt = await TEAM.gateway.submit({ ...(cmd.operationId ? { operationId: cmd.operationId } : {}), name: cmd.name, target: cmd.target,
      expectedRevision: cmd.expectedRevision, args: { ...cmd.args, ...form } })
      .catch(error => ({ operationId: '—', status: 'unknown', revision: null, entityId: cmd.target, message: String(error?.message ?? error) }));
    if (generation !== TEAM.scope?.generation || TEAM.ui.getSnapshot().palette !== cmd) return;
    if (receipt.status === 'conflict') TEAM.client.resync('conflict');
    setPhase({ kind: 'receipt', receipt });
  };
  const onKeyDown = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') {
      const nodes = [...boxRef.current.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    e.stopPropagation();
  };
  const receipt = phase.kind === 'receipt' ? phase.receipt : null;
  const errText = explainError;
  const statusText = RECEIPT_STATUS_TEXT;
  const body = h('div', { className: 'tm tm-modal-scrim', onMouseDown: e => { if (e.target === e.currentTarget) close(); } },
    h('div', { className: 'tm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tm-modal-title', ref: boxRef, onKeyDown },
      h('div', { className: 'tm-modal-head' }, h('h2', { id: 'tm-modal-title' }, cmd.title),
        h('span', { className: 'tm-badge' }, '命令面板'),
        h('button', { className: 'tm-btn tm-btn-ghost', onClick: close, 'aria-label': '关闭' }, '✕')),
      h('div', { className: 'tm-modal-body' },
        h('div', { className: 'tm-cmd' }, `${cmd.name}(${cmd.target}${cmd.expectedRevision != null ? `, expectedRevision=${cmd.expectedRevision}` : ''})`),
        h('dl', { className: 'tm-kv' }, h('dt', null, '影响范围'), h('dd', null, h('ul', { className: 'tm-list', style: { gap: 3 } }, cmd.impact.map((t, i) => h('li', { key: i }, t))))),
        cmd.diff ? h('div', { className: 'tm-cmd' }, cmd.diff.map((d, i) => h('div', { key: i }, d))) : null,
        cmd.evidence ? h('dl', { className: 'tm-kv' }, h('dt', null, '证据'), h('dd', null, h('ul', { className: 'tm-list', style: { gap: 3 } }, cmd.evidence.map((t, i) => h('li', { key: i }, '· ', t))))) : null,
        (cmd.notes ?? []).map((n, i) => h('div', { key: i, className: 'tm-warnbox' }, n)),
        receipt ? null : (cmd.fields ?? []).map(f => h(Field, { key: f.key, id: `tm-f-${f.key}`, field: f, value: form[f.key] ?? '', onChange: v => setForm(s => ({ ...s, [f.key]: v })) })),
        receipt ? h('div', { className: 'tm-receipt', 'data-status': receipt.status, role: 'status' },
          h('span', { className: 'tm-fg3' }, 'operationId'), h('span', { className: 'mono' }, receipt.operationId),
          h('span', { className: 'tm-fg3' }, 'status'), h('span', { className: 'tm-sevtext', 'data-sev': receiptSeverity(receipt.status) }, `${receipt.status} — ${statusText[receipt.status]}`),
          h('span', { className: 'tm-fg3' }, 'revision'), h('span', { className: 'mono' }, receipt.revision ?? '—'),
          receipt.message ? h('span', { className: 'tm-fg3' }, 'message') : null,
          // A refusal is shown as what it means first, with the server's own code kept beside it: COMPLETION_FROZEN says
          // nothing to the operator, "控制面被冻结" does, and the code is still what a bug report needs.
          receipt.message ? h('span', { className: 'mono', title: receipt.message }, errText(receipt.message).explanation ?? receipt.message) : null,
          receipt.message && errText(receipt.message).code ? h('span', { className: 'mono tm-fg3' }, errText(receipt.message).code) : null) : null),
      h('div', { className: 'tm-modal-foot' },
        h('span', { className: 'tm-note' }, cmd.disabledReason ?? (stale ? '投影过期：需先刷新再提交' : missing.length && !receipt ? `还缺：${missing.map(f => f.label).join('、')}` : invalid.length && !receipt ? invalid.join('；') : 'Esc 取消 · 提交前不会改变任何状态')),
        h('span', { className: 'tm-spacer' }),
        stale && !receipt ? h('button', { className: 'tm-btn', onClick: () => TEAM.client.resync('manual') }, '刷新投影') : null,
        h('button', { className: 'tm-btn', onClick: close }, receipt ? '关闭' : '取消'),
        receipt ? null : h('button', { className: 'tm-btn tm-btn-primary', disabled: !!blocked, onClick: submit },
          phase.kind === 'sending' ? '提交中…' : stale ? '需先刷新' : '确认提交'))));
  return ReactDOM.createPortal(body, document.body);
}
