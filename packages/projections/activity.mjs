// P12: a bounded read-only translation of committed events, never of the latest entity rows.
const CATEGORIES = ['anomaly', 'needs-you', 'root-decision', 'delivery'];
const STATE_TEXT = { draft: '等待范围审批', ready: '准备开始', blocked: '正在等待处理', produced: '已产出',
  verifying: '正在验证', verified: '验证通过', integrating: '正在合并', merged: '已合并', accepted: '已验收',
  open: '已发起', collecting: '正在收集意见', decided: '已作出决定', escalated: '已转交处理', stored: '已送达信箱',
  visible: '已看到', resolved: '已完成', cancelled: '已取消', unknown: '结果尚未确认', expired: '等待期限已到',
  'dead-letter': '投递未能完成', running: '正在执行', frozen: '已暂停', retired: '已退役', closed: '已结束' };
const CATEGORY_TEXT = { anomaly: '异常', 'needs-you': '需要你', 'root-decision': 'root 裁决', delivery: '交付与验收', other: '团队动态' };

export function activityEvents(committed, { kind = null, member = null, from = null, to = null,
  afterSeq = null, beforeSeq = null, limit = 500, allowed, rows, replayAfterSeq = 0, asOfSeq = 0 } = {}) {
  if (afterSeq !== null && (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > asOfSeq)) {
    throw Error('INVALID_CURSOR');
  }
  if (beforeSeq !== null && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1 || beforeSeq > asOfSeq + 1 ||
      afterSeq !== null)) throw Error('INVALID_CURSOR');
  if ((beforeSeq !== null && beforeSeq <= replayAfterSeq) || (afterSeq !== null && afterSeq < replayAfterSeq)) throw Object.assign(Error('RESYNC_REQUIRED'), {
    code: 'RESYNC_REQUIRED', replayAfterSeq, asOfSeq, resync: true });
  const events = [];
  for (const event of committed) {
    const row = event.payload;
    if (!allowed(row) || !Number.isFinite(row.updatedAt)) continue;
    const id = event.entity;
    const type = id.split(':')[0];
    let category = 'other';
    if (['task', 'delivery', 'verification-evidence'].includes(type)) category = 'delivery';
    if (type === 'decision' || type === 'audit') category = 'root-decision';
    if (row.status === 'unknown' || row.lease === 'unknown' || row.status === 'dead-letter') category = 'anomaly';
    const rootEscalation = row.status === 'escalated' && row.responsible === 'operator' &&
      rows.get(row.escalatedBy)?.role === 'root';
    if (rootEscalation || (row.kind === 'stuck-member' && row.state === 'open') ||
        (['control-slot', 'effect-io'].includes(type) && row.state === 'unknown')) category = 'needs-you';
    const members = [type === 'member' ? id : null, row.owner, row.sender, row.recipient, row.memberId, row.by, row.openedFor,
      ...(row.recipients ?? [])].filter(Boolean);
    const at = row.updatedAt;
    if ((kind && kind !== category && kind !== type) || (member && !members.includes(member)) ||
        (from !== null && at < from) || (to !== null && at > to) || event.seq <= (afterSeq ?? replayAfterSeq) ||
        (beforeSeq !== null && event.seq >= beforeSeq)) continue;
    const name = row.title ?? row.question ?? row.summary ?? row.expectedOutcome ?? row.name ?? id;
    const state = row.status ?? row.state ?? row.option ?? row.verdict?.option ?? '已更新';
    const action = STATE_TEXT[state] ?? '记录已更新';
    const evidenceTag = row.evidence?.length ? ['证据 ' + row.evidence.length + ' 条'] : [];
    events.push({ seq: event.seq, at, kind: type, category, id, subject: { type, id, name },
      text: name + '：' + action, tags: [CATEGORY_TEXT[category], action, ...evidenceTag], members });
  }
  // Initial/beforeSeq pages walk newest -> oldest. afterSeq keeps its forward incremental semantics.
  const size = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : 500, 500);
  const forward = afterSeq !== null;
  const page = events.sort((a, b) => forward ? a.seq - b.seq : b.seq - a.seq).slice(0, size);
  const hasMore = events.length > page.length;
  return { events: forward ? [...page].reverse() : page, total: events.length, categories: [...CATEGORIES],
    replayAfterSeq, asOfSeq, nextAfterSeq: forward && hasMore ? page.at(-1).seq : asOfSeq,
    nextBeforeSeq: !forward && hasMore ? page.at(-1).seq : null, hasMore };
}
