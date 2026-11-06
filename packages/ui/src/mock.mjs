// Mock projection source + command gateway for P4 stage 1 (no model, no network).
// Scenario follows the 08 §4.1–4.6 state model; swap for createHttpSource() later.
import { SCHEMA_VERSION, COMMANDS, GATE_RATIO } from './projection.mjs';

/** Principal the mock reads as: the operator works through the root principal, like the real token registry. */
export const MOCK_VIEWER = 'member:root';
/**
 * Authoritative member ids are `member:*` (core). Fixtures are written with short names for readability;
 * this maps every member reference to the authoritative id (names stay short). 'operator' is the human,
 * who acts as the root principal. Idempotent.
 */
export function authorityIds(data) {
  const id = x => x == null || x.startsWith('member:') ? x : x === 'operator' ? MOCK_VIEWER : 'member:' + x;
  return { ...data,
    groups: data.groups.map(g => ({ ...g, lead: id(g.lead) })),
    members: data.members.map(m => ({ ...m, id: id(m.id), wait: m.wait && { ...m.wait, ...(m.wait.memberRef ? { memberRef: id(m.wait.memberRef) } : {}) } })),
    tasks: data.tasks.map(t => ({ ...t, owner: id(t.owner) })),
    threads: data.threads.map(t => ({ ...t, owner: id(t.owner), escalationOwner: id(t.escalationOwner),
      requiredRespondents: t.requiredRespondents.map(r => ({ ...r, member: id(r.member) })), replies: t.replies.map(r => ({ ...r, member: id(r.member) })),
      lateEvidence: t.lateEvidence.map(r => ({ ...r, member: id(r.member) })) })),
    messages: data.messages.map(m => ({ ...m, from: id(m.from), to: id(m.to), escalatedTo: m.escalatedTo && { ...m.escalatedTo, member: id(m.escalatedTo.member) } })),
    approvals: data.approvals.map(a => ({ ...a, member: id(a.member) })),
    ...(data.resourceThreads ? { resourceThreads: data.resourceThreads.map(thread => ({ ...thread,
      owner: id(thread.owner),
      subscribers: thread.subscribers.map(sub => ({ ...sub, memberId: id(sub.memberId) })) })) } : {}) };
}

const S = 1000, M = 60 * S;

function lease(now, sec, state = 'active', fence = 17) { return { state, expiresAt: now + sec * S, fence }; }
/**
 * Fixture context, written as share of the model WINDOW for readability, emitted in the server contract:
 * pct relative to the 75% limit (P4B §7.1). Counters exist here because the mock models a future with
 * committed counters; real sources may omit them (UI shows unknown, never 0).
 */
function ctxUse(windowPct, extra = {}) {
  const window = 128000, limitRatio = GATE_RATIO, limitTokens = window * limitRatio;
  const inputTokens = Math.round(window * windowPct / 100);
  return { pct: Math.round(100 * inputTokens / limitTokens), window, inputTokens, limitRatio, limitTokens, logRevision: 40 + Math.round(windowPct),
    hardGateHits: windowPct >= 75 ? 1 : 0, truncRefs: extra.truncRefs ?? 0,
    fold: { enabled: extra.fold !== undefined, count: extra.fold ?? 0, last: extra.foldLast ?? null }, snapshotTokens: extra.snap ?? 1400 };
}
/**
 * M6 P5 stand-in: what the member is doing now, in the shape the projection publishes. Absent (null) for a session
 * that is paused, retiring or unknown — those show their lifecycle instead, never "空闲".
 */
function memberActivity(o, now) {
  const observed = o.observed ?? 'active', desired = o.desired ?? 'active';
  if (['unknown', 'retired', 'retiring', 'frozen'].includes(observed) || desired === 'frozen') return null;
  if (o.activity) return o.activity;
  if (o.attempt?.state === 'running') return { kind: 'running', sub: '执行任务', since: now - 12 * M, tool: { name: 'bash', elapsed: 6 * M + 12 * S } };
  return { kind: 'idle', sub: null, since: now - 25 * M };
}
function member(now, id, role, group, o = {}) {
  return { id, name: o.name ?? id, role, group, generation: o.gen ?? 1, desired: o.desired ?? 'active', observed: o.observed ?? 'active',
    history: o.history ?? ['requested', 'creating', 'bound', 'active'], attempt: o.attempt ?? null, taskId: o.task ?? null, wait: o.wait ?? null,
    activity: memberActivity(o, now),
    context: o.context === undefined ? ctxUse(30) : o.context,
    contextStatus: (o.context === undefined || o.context) ? { status: 'known', limitRatio: GATE_RATIO } : { status: 'unknown', limitRatio: GATE_RATIO, reason: 'no committed context record' },
    delegation: o.delegation ?? (role === 'worker' ? { scope: `${group}/**`, risk: 'low', budgetUsed: 0.4, budget: 4, expiresAt: now + 4 * 60 * M } : null),
    nativeRef: o.nativeRef ?? `ses-${id}-${(id.length * 7919).toString(16)}`, checkpointAt: o.checkpointAt ?? now - 2 * M, revision: o.revision ?? 3 };
}
function attempt(now, n, state, leaseSec, o = {}) {
  return { id: `att-${o.task ?? 'x'}-${n}`, n, state, lease: leaseSec == null ? null : lease(now, leaseSec, o.leaseState, o.fence),
    worktree: o.worktree ?? `wt-${n + 10}`, superseded: o.superseded ?? [] };
}
function msg(now, id, from, to, kind, o = {}) {
  const at = o.openedAt ?? now - 20 * M;
  const stored = { at, evidence: 'outbox committed' };
  const visible = o.visible ? { at: at + 5 * S, requestId: `r-${3300 + id.length * 13}`, manifest: '9f2c41ab7d', seq: 1203 } : null;
  const accepted = o.accepted ? { at: at + 60 * S, checkpoint: `cp-${12 + id.length}` } : null;
  return { id, from, to, kind, openedAt: at, deadline: o.deadline ?? null,
    lifecycle: o.lifecycle ?? (accepted ? (o.resolved ? 'resolved' : 'accepted') : visible ? 'visible' : 'stored'),
    expectedOutcome: o.expected ?? '', generation: o.gen ?? 1, receipts: { stored, visible, accepted },
    delayReason: o.delay ?? null, escalatedTo: o.escalatedTo ?? null, rebinds: o.rebinds ?? [], revision: o.revision ?? 1 };
}
function task(id, title, state, owner, o = {}) {
  return { id, title, state, owner, contractRevision: o.rev ?? 1, attempts: o.attempts ?? [{ n: 1, state: state === 'executing' ? 'running' : 'produced' }],
    delivery: o.delivery ?? null, revision: o.revision ?? 2 };
}

/** The default 17-member scenario (+2 ACL-restricted members), with authoritative member ids. */
export function scenarioDefault(now) { return authorityIds(buildDefault(now)); }
function buildDefault(now) {
  const members = [
    member(now, 'root', 'root', 'root', { context: ctxUse(52, { fold: 1, snap: 2100 }), task: null }),
    member(now, 'sc-1', 'coordinator', 'engine', { context: ctxUse(46, { fold: 0 }) }),
    member(now, 'worker-a', 'worker', 'engine', { gen: 3, task: 'task-12', context: ctxUse(58, { fold: 2, truncRefs: 3, snap: 1900, foldLast: { at: now - 9 * M, masked: 16, revFrom: 38, revTo: 41 } }),
      attempt: attempt(now, 2, 'running', 41, { task: 'task-12', superseded: [{ n: 1, state: 'failed' }], worktree: 'wt-12' }),
      delegation: { scope: 'engine/render/**', risk: 'low', budgetUsed: 1.2, budget: 4, expiresAt: now + 3 * 60 * M } }),
    member(now, 'worker-b', 'worker', 'engine', { gen: 3, task: 'task-14', context: ctxUse(37, { fold: 0 }),
      attempt: attempt(now, 1, 'checkpointed', null, { task: 'task-14' }),
      wait: { kind: 'Decision', ref: 'thr-7', label: 'decision #7 rev2', openedAt: now - 30 * M, deadline: now + 14 * M, state: 'pending' } }),
    member(now, 'verifier-e', 'verifier', 'engine', { task: 'task-9', context: ctxUse(71, { fold: 4, truncRefs: 5, snap: 3100, foldLast: { at: now - 4 * M, masked: 22, revFrom: 51, revTo: 55 } }),
      attempt: attempt(now, 1, 'running', 118, { task: 'task-9' }),
      wait: { kind: 'MessageResponsibility', ref: 'msg-90', label: 'worker-a msg-90', memberRef: 'worker-a', openedAt: now - 23 * M, deadline: now - 3 * M, state: 'pending' } }),
    member(now, 'worker-c', 'worker', 'engine', { task: 'task-15', context: ctxUse(76, { fold: 3, truncRefs: 9, snap: 3900 }),
      activity: { kind: 'maintenance', sub: '压缩上下文', since: now - 40 * S },
      attempt: attempt(now, 1, 'running', 22, { task: 'task-15' }) }),
    member(now, 'sc-2', 'coordinator', 'portals', { context: ctxUse(41, { fold: 0 }) }),
    member(now, 'worker-p1', 'worker', 'portals', { task: 'task-18', context: ctxUse(22),
      wait: { kind: 'Approval', ref: 'apr-3', label: 'scope approval apr-3', openedAt: now - 20 * M, deadline: now + 40 * M, state: 'pending' } }),
    member(now, 'worker-p2', 'worker', 'portals', { task: 'task-19', context: ctxUse(44), attempt: attempt(now, 1, 'running', 52, { task: 'task-19' }) }),
    member(now, 'worker-p3', 'worker', 'portals', { task: 'task-20', desired: 'frozen', observed: 'active', context: ctxUse(33),
      history: ['requested', 'creating', 'bound', 'active', 'freezing'], attempt: attempt(now, 1, 'running', 30, { task: 'task-20', leaseState: 'revoked' }) }),
    member(now, 'worker-p4', 'worker', 'portals', { observed: 'unknown', context: null, history: ['requested', 'creating', 'unknown'], task: null, nativeRef: null }),
    member(now, 'sc-3', 'coordinator', 'gameplay', { context: ctxUse(30) }),
    member(now, 'worker-g1', 'worker', 'gameplay', { task: 'task-22', context: ctxUse(27), attempt: attempt(now, 1, 'running', 33, { task: 'task-22' }) }),
    member(now, 'worker-g2', 'worker', 'gameplay', { task: 'task-23', context: ctxUse(18),
      attempt: attempt(now, 1, 'produced', null, { task: 'task-23' }),
      wait: { kind: 'TaskAccepted', ref: 'task-23', label: 'task-23 delivery r1', openedAt: now - 10 * M, deadline: now + 50 * M, state: 'pending' } }),
    member(now, 'worker-g3', 'worker', 'gameplay', { desired: 'retired', observed: 'retired', context: null, history: ['requested', 'creating', 'bound', 'active', 'retiring', 'retired'] }),
    member(now, 'worker-g4', 'worker', 'gameplay', { task: 'task-24', context: ctxUse(12), attempt: attempt(now, 1, 'running', 47, { task: 'task-24' }) }),
    member(now, 'verifier-final', 'verifier', 'verify', { task: 'task-21', context: ctxUse(35, { fold: 0 }), attempt: attempt(now, 1, 'running', 175, { task: 'task-21' }) }),
  ];
  const valid = { revision: 1, certificate: 'valid', merge: null };
  const tasks = [
    task('task-3', '渲染批处理接口 v2 骨架', 'accepted', 'worker-a', { attempts: [{ n: 1, id: 'attempt:task-3:1', state: 'produced' }], delivery: { revision: 1, certificate: 'valid', merge: 'confirmed',
      // Contract: packages/projections/schema.mjs certificateBindingSchema (complete, attempt bound).
      certificateBinding: { certificateHash: 'c3a91f0e5b7d24c8a1f06e2d9b4c7a3051e8d2f6b9a0c4e7d1f3a5b8c2e6d904', taskId: 'task-3', attemptId: 'attempt:task-3:1',
        verifier: 'member:verifier-e', contractRevision: 1, candidate: '7e21c9a4d0b3f6e8a1c5d2b7f9e0a3c6d8b1f4e2', tree: '4b0d8f1c7a2e5d9b3f6a0c8e1d4b7a2f5c9e3d60',
        deliveryId: 'delivery:task-3', deliveryRevision: 1, status: 'accepted' } } }),
    task('task-4', 'shader 缓存键迁移', 'merged', 'worker-c', { delivery: { revision: 1, certificate: 'valid', merge: 'confirmed' } }),
    task('task-5', 'portals 资源清单生成', 'merged', 'worker-p2', { delivery: { revision: 2, certificate: 'valid', merge: 'confirmed' } }),
    task('task-6', '纹理图集打包脚本', 'verified', 'worker-g1', { delivery: valid }),
    task('task-7', 'gameplay 事件总线适配', 'verified', 'worker-g4', { delivery: valid }),
    task('task-8', 'engine 帧图依赖排序', 'verified', 'worker-b', { delivery: valid }),
    task('task-9', '验收 task-8 帧图依赖排序', 'verifying', 'verifier-e', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-10', 'portals 预取策略', 'produced', 'worker-p2', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-11', 'HUD 层渲染路径', 'produced', 'worker-g1', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-12', '渲染管线 pass 合并', 'executing', 'worker-a', { rev: 2, attempts: [{ n: 1, state: 'failed', supersededBy: 2 }, { n: 2, state: 'running' }] }),
    task('task-13', '后处理链兼容层', 'produced', 'worker-c', { delivery: { revision: 1, certificate: 'invalid', merge: null } }),
    task('task-14', 'portals 加载顺序对接 v2', 'blocked', 'worker-b'),
    task('task-15', 'GPU 资源生命周期重构', 'executing', 'worker-c'),
    task('task-16', '集成 engine 批次 #2', 'integrating', 'root', { delivery: { revision: 1, certificate: 'valid', merge: 'prepared',
      // Legacy certificate: no attemptId (never inferred).
      certificateBinding: { certificateHash: '91d0e6a7c2f4b8330e5a1c9d7b2f4e6a8c0d3b5f7e9a1c2d4b6f8e0a3c5d7b9f', taskId: 'task-16', verifier: 'member:verifier-final',
        contractRevision: 1, candidate: 'a5c3e19b7d2f4a6c8e0b1d3f5a7c9e2b4d6f8a0c', tree: 'e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9', deliveryId: 'delivery:task-16', deliveryRevision: 1, status: 'verified' } } }),
    task('task-18', 'portals shim（需扩大写域）', 'blocked', 'worker-p1'),
    task('task-19', 'portals 流式加载', 'executing', 'worker-p2'),
    task('task-20', 'portals 遮挡剔除', 'executing', 'worker-p3'),
    task('task-21', '最终验收：集成分支 int-41', 'verifying', 'verifier-final'),
    task('task-22', '角色动画管线迁移', 'executing', 'worker-g1'),
    task('task-23', '物理调试绘制', 'produced', 'worker-g2', { delivery: { revision: 1, certificate: null, merge: null } }),
    task('task-24', '粒子系统批处理', 'executing', 'worker-g4'),
  ];
  const threads = [
    { id: 'thr-7', question: '接口 v2 是否破坏 portals 的加载顺序？', owner: 'sc-1', escalationOwner: 'operator',
      requiredRespondents: [{ member: 'worker-a', revision: 2 }, { member: 'sc-2', revision: 2 }, { member: 'verifier-e', revision: null }],
      openedAt: now - 30 * M, deadline: now + 14 * M, state: 'collecting', proposalRevision: 2, supersededRevisions: [1],
      replies: [{ member: 'worker-a', revision: 2, text: '可以，附测试', artifact: 'art-551' }, { member: 'sc-2', revision: 2, text: '需要 portals 侧 shim', artifact: 'art-553' }],
      lateEvidence: [], affectedTasks: ['task-14', 'task-18'], decisionRevision: null, revision: 6 },
    { id: 'thr-9', question: 'portals shim 是否允许改动 engine/loader 写域？', owner: 'operator', escalationOwner: 'operator',
      requiredRespondents: [{ member: 'sc-1', revision: 1 }, { member: 'sc-2', revision: 1 }, { member: 'worker-p1', revision: null }],
      openedAt: now - 48 * M, deadline: now - 3 * M, state: 'escalated', proposalRevision: 1, supersededRevisions: [],
      replies: [{ member: 'sc-1', revision: 1, text: '只允许 loader/hooks 子目录', artifact: 'art-560' }, { member: 'sc-2', revision: 1, text: '同意，需要回归测试', artifact: 'art-561' }],
      lateEvidence: [], affectedTasks: ['task-18'], decisionRevision: null, revision: 4 },
    { id: 'thr-11', question: '动画重定向放在 gameplay 还是 engine？', owner: 'sc-3', escalationOwner: 'root',
      requiredRespondents: [{ member: 'worker-g1', revision: 1 }, { member: 'sc-1', revision: null }],
      openedAt: now - 5 * M, deadline: now + 35 * M, state: 'collecting', proposalRevision: 1, supersededRevisions: [],
      replies: [{ member: 'worker-g1', revision: 1, text: '倾向 gameplay，接口更窄' }], lateEvidence: [], affectedTasks: ['task-22'], decisionRevision: null, revision: 2 },
    { id: 'thr-5', question: '渲染批次大小默认值取 256 还是 512？', owner: 'sc-1', escalationOwner: 'root',
      requiredRespondents: [{ member: 'worker-a', revision: 1 }, { member: 'worker-c', revision: 1 }],
      openedAt: now - 120 * M, deadline: now - 60 * M, state: 'decided', proposalRevision: 1, supersededRevisions: [],
      replies: [{ member: 'worker-a', revision: 1, text: '256，附基准', artifact: 'art-512' }, { member: 'worker-c', revision: 1, text: '同意 256' }],
      lateEvidence: [{ member: 'worker-g4', text: '粒子批次在 512 下更快（晚到，不覆盖决定）' }], affectedTasks: ['task-3'], decisionRevision: 1, revision: 9 },
  ];
  const messages = [
    msg(now, 'msg-77', 'root', 'worker-b', 'decision', { visible: true, accepted: true, resolved: true, gen: 3, openedAt: now - 70 * M,
      rebinds: [{ from: 2, to: 3, at: now - 65 * M }], expected: '确认 frame graph 排序方案' }),
    msg(now, 'msg-88', 'worker-a', 'worker-b', 'action', { visible: true, openedAt: now - 6 * M, deadline: now + 24 * M, expected: '确认 v2 接口签名' }),
    msg(now, 'msg-90', 'verifier-e', 'worker-a', 'action', { openedAt: now - 23 * M, deadline: now - 3 * M, expected: '提供 task-8 的基准复现脚本',
      delay: '收件人在长工具（bash 6m12s）', escalatedTo: { member: 'sc-1', at: now - 2 * M } }),
    msg(now, 'msg-91', 'sc-1', 'verifier-e', 'decision', { visible: true, openedAt: now - 11 * M, deadline: now + 9 * M, expected: '对 #7 提案 rev2 表态' }),
    msg(now, 'msg-93', 'root', 'verifier-e', 'action', { openedAt: now - 1 * M, deadline: now + 20 * M, expected: '验收完成后报告覆盖率差距' }),
    msg(now, 'msg-95', 'sc-2', 'worker-p2', 'info', { visible: true, openedAt: now - 15 * M, expected: '' }),
    msg(now, 'msg-96', 'worker-g2', 'verifier-final', 'action', { visible: true, accepted: true, openedAt: now - 9 * M, deadline: now + 30 * M, expected: '验收 task-23 交付 r1' }),
    msg(now, 'msg-97', 'root', 'sc-3', 'info', { visible: true, accepted: true, resolved: true, openedAt: now - 50 * M }),
    msg(now, 'msg-98', 'sc-1', 'worker-c', 'action', { visible: true, openedAt: now - 3 * M, deadline: now + 30 * M, expected: '拆分 task-15，控制上下文' }),
    msg(now, 'msg-99', 'sc-2', 'worker-p3', 'action', { lifecycle: 'cancelled', openedAt: now - 8 * M, deadline: now + 12 * M, expected: '暂停遮挡剔除，等待冻结' }),
  ];
  const unknownEffects = [{ id: 'op-91', kind: 'merge', ref: 'int-41 → refs/heads/main', summary: 'merge op-91：目标 ref 已移动、回执丢失', openedAt: now - 6 * M,
    evidence: ['integration intent int-41 已提交（prepared）', 'update-ref 回执缺失（进程在 Git 返回前退出）', 'refs/heads/main 现为 9f2c1e7，期望 old=4ab09d2'], revision: 2 }];
  const approvals = [{ id: 'apr-3', kind: 'scope', member: 'worker-p1', task: 'task-18', summary: 'worker-p1 申请扩大 task-18 写域', openedAt: now - 20 * M,
    diff: ['+ engine/loader/hooks/**（写）', '风险 low → medium', '预算 $2.00 → $3.00'], deadline: now + 40 * M, revision: 1 }];
  return { goal: { id: 'goal-1', title: '迁移渲染管线到 v2', status: 'known', native: { id: 'goal-1', objective: '迁移渲染管线到 v2', revision: 3 },
      source: { sessionId: 'ses-root', seq: 48190 }, gate: { status: 'blocked', revision: 3, evaluatedAt: now - 12 * M, sourceSeq: 48190, semantics: 'last-committed-check' },
      acceptanceGaps: 3, completionToken: 'none' }, approvalsStatus: { status: 'known', source: 'mock' }, restrictedMembers: 2,
    groups: [{ id: 'root', label: 'root', lead: null }, { id: 'engine', label: 'engine', lead: 'sc-1' }, { id: 'portals', label: 'portals', lead: 'sc-2' },
      { id: 'gameplay', label: 'gameplay', lead: 'sc-3' }, { id: 'verify', label: '独立验收', lead: null }],
    members, tasks, threads, messages, unknownEffects, approvals };
}

/** 30 members (root + 3 coordinator groups of 8 + 2 verifiers), ~200 messages (09 §8 A7). */
export function scenarioLarge(now) {
  const base = buildDefault(now);
  const members = [member(now, 'root', 'root', 'root', { context: ctxUse(55, { fold: 2 }) })];
  const groups = [{ id: 'root', label: 'root', lead: null }];
  const names = ['engine', 'portals', 'gameplay'];
  let k = 0;
  names.forEach((g, gi) => {
    groups.push({ id: g, label: g, lead: `sc-${gi + 1}` });
    members.push(member(now, `sc-${gi + 1}`, 'coordinator', g, { context: ctxUse(35 + gi * 6) }));
    for (let i = 1; i <= 8; i++) {
      k++;
      const id = `${g.slice(0, 3)}-w${i}`, t = `task-${100 + k}`, o = { task: t, context: ctxUse((k * 17) % 70 + 5), attempt: attempt(now, 1, 'running', 20 + (k * 7) % 50, { task: t }) };
      if (k === 3) Object.assign(o, { wait: { kind: 'MessageResponsibility', ref: 'msg-l3', label: `${g.slice(0, 3)}-w1 msg`, memberRef: `${g.slice(0, 3)}-w1`, openedAt: now - 30 * M, deadline: now - 4 * M, state: 'pending' } });
      if (k === 14) Object.assign(o, { attempt: attempt(now, 1, 'running', -12, { task: t, leaseState: 'expired' }) });
      if (k === 20) Object.assign(o, { observed: 'unknown', context: null });
      if (k === 6 || k === 11) Object.assign(o, { context: ctxUse(k === 6 ? 66 : 77) });
      if (k === 9) Object.assign(o, { desired: 'frozen', observed: 'active' });
      if ([2, 8, 12, 17, 22].includes(k)) Object.assign(o, { wait: { kind: 'Decision', ref: 'thr-7', label: 'decision #7 rev2', openedAt: now - 10 * M, deadline: now + (20 + k) * M, state: 'pending' } });
      if (k === 24) Object.assign(o, { desired: 'frozen', observed: 'frozen', attempt: null });
      members.push(member(now, id, 'worker', g, o));
    }
  });
  groups.push({ id: 'verify', label: '独立验收', lead: null });
  members.push(member(now, 'verifier-1', 'verifier', 'verify', { task: 'task-9', context: ctxUse(48) }));
  members.push(member(now, 'verifier-final', 'verifier', 'verify', { task: 'task-21', context: ctxUse(31) }));
  const messages = [];
  for (let i = 0; i < 200; i++) {
    const to = members[1 + (i * 7) % (members.length - 1)].id, from = members[(i * 3) % members.length].id;
    messages.push(msg(now, `msg-l${i}`, from === to ? 'root' : from, to, i % 5 === 0 ? 'info' : 'action',
      { visible: i % 9 !== 0, accepted: i % 4 !== 0, resolved: i % 4 !== 0 && i % 3 === 0, openedAt: now - (i % 30 + 2) * M, deadline: now + (12 + (i % 9) * 6) * M }));
  }
  const states = ['executing', 'executing', 'executing', 'produced', 'verifying', 'executing', 'blocked', 'executing'];
  const tasks = [...base.tasks, ...members.filter(m => m.taskId && !base.tasks.some(t => t.id === m.taskId))
    .map((m, i) => task(m.taskId, `${m.group} 子任务 ${i + 1}`, m.wait?.kind === 'Decision' ? 'blocked' : states[i % states.length], m.id))];
  return authorityIds({ ...base, members, groups, messages, tasks, restrictedMembers: 0 });
}

export function scenarioEmpty() {
  return { goal: { id: 'goal', title: 'unknown', status: 'unknown', native: null, source: null, gate: { status: 'unknown' }, acceptanceGaps: null, completionToken: 'none' },
    approvalsStatus: { status: 'known', source: 'mock' }, restrictedMembers: 0,
    groups: [], members: [], tasks: [], threads: [], messages: [], unknownEffects: [], approvals: [] };
}

/**
 * P5: a team that uses the v1 read states, so the client contract is exercised with real-shaped blocks rather than a
 * comment. Resource threads are a separate collection; capacity shows an unknown occupant (admission closed) and a
 * queued human; the role guard reports denials; one batch was bounded with an omitted item. Nothing here is a second
 * source of truth: the mock only replays the envelope the server would publish.
 */
export function scenarioBorrow(now) {
  const base = scenarioDefault(now);
  const resourceThreads = [{
    id: 'thread:res-1', kind: 'resource', status: 'open', owner: 'member:root',
    resource: { kind: 'branch', repositoryKey: 'repo:acme/app', key: 'refs/heads/main' },
    head: 3, retainedFrom: 1, pending: 1, descriptionRef: 'artifact:desc:1',
    subscribers: [
      { memberId: 'member:sc-1', generation: 1, subscriptionEpoch: 1, state: 'active', startAfterSeq: 0, visibleThrough: 2, pending: 1 },
      { memberId: 'member:worker-a', generation: 3, subscriptionEpoch: 2, state: 'active', startAfterSeq: 0, visibleThrough: 3, pending: 0 },
    ],
    lastEvent: { seq: 3, eventType: 'conflict-observed', summary: 'worker-a 报告 main 与 feature 冲突',
      actor: 'member:worker-a', occurredAt: now - 4 * M },
    revision: 7,
  }];
  const latest = { id: 'manifest:borrow-1', memberId: 'member:worker-a', generation: 3, cutoffSeq: 100, items: 2,
    pendingCount: 4, omittedCount: 1, nextCursor: 2, injectedAt: now - 60 * S, revision: 1 };
  return authorityIds({ ...base, resourceThreads,
    capacity: { normal: { current: 5, limit: 8, unknown: 0, queued: 0, oldestAge: null },
      human: { current: 1, limit: 1, unknown: 1, queued: 2, oldestAge: 60 * S },
      unknown: 1, admissionClosed: true, queued: 2, oldestAge: 60 * S,
      blocked: [{ originRef: 'human-input:borrow', recipient: 'member:worker-p1', reason: 'recipient-unavailable' }],
      occupants: [{ ref: 'control-slot:team:borrow', originRef: 'decision:borrow', holderRef: 'owner-call', state: 'unknown', lane: 'human' }],
      providerCapacity: 'unknown', providerWait: 'none', providerRetryAfterMs: null, providerRecoveryAt: null },
    roleGuard: { coordinatorOnly: true,
      policy: { deny: ['opaque', 'write-local', 'execute'], allow: ['read-local', 'coordinate'], unknown: 'deny' },
      installed: true, revoked: false, denials: 3, allows: 9, auditPersistFailed: false,
      declared: ['read', 'team_read'],
      audit: { denied: 3, allowed: 9, byTool: [{ identity: 'bash', allowed: 0, denied: 2 }, { identity: 'read', allowed: 9, denied: 1 }] } },
    inputs: { count: 1, latest, batches: [latest] } });
}
/**
 * M6 (§WP-0): fixtures the v3 panel acceptance needs, composed from the default team so every other row keeps the
 * shape the existing suites already pin. They are data only: a different *viewer* and a *stale* envelope are driven by
 * createMockSource's config/control (viewer via the source config, staleness via control.setStale), not by a fixture.
 */
export function scenarioLongText(now) {
  const base = scenarioDefault(now);
  const long = '渲染管线批处理与后处理链在 portals 与 gameplay 之间的跨组适配方案（含回滚路径与灰度开关）';
  return authorityIds({ ...base,
    members: base.members.map(m => m.id === 'member:worker-a' ? { ...m, name: 'worker-a-长名字-0123456789' } : m),
    tasks: base.tasks.map(t => t.id === 'task-12' ? { ...t, title: long.repeat(3) } : t) });
}
/** One message the outbox gave up on, plus one unknown read-model gap: the two rows the records page must separate. */
export function scenarioDeadLetter(now) {
  const base = scenarioDefault(now);
  return authorityIds({ ...base,
    messages: base.messages.map(m => m.id === 'msg-90' ? { ...m, lifecycle: 'dead-letter', revision: m.revision + 1,
      deadLetter: { reason: 'receipt-lost: the recipient session ended before the outbox confirmed',
        at: now - 2 * M, suggestedRecipient: 'member:sc-1' } } : m),
    unknownEffects: [...base.unknownEffects, { id: 'read-model:context:member:worker-p4', kind: 'read-model',
      ref: 'read-model:context:member:worker-p4', summary: '上下文读模型缺失', openedAt: now - 4 * M,
      evidence: [], revision: 1 }] });
}
/** An open proposal window with one recipient that has not seen it yet. */
export function scenarioIntent(now) {
  const base = scenarioDefault(now);
  const intent = { id: 'msg-intent-1', from: 'member:worker-a', to: 'member:worker-b',
    kind: 'intent', openedAt: now - 4 * M, deadline: now + 6 * M, closesAt: now + 6 * M, lifecycle: 'stored',
    expectedOutcome: '把 feature/render-v2 合入 main', generation: 1, receipts: { stored: null, visible: null, accepted: null },
    delayReason: null, escalatedTo: null, rebinds: [], revision: 1,
    recipients: [{ member: 'member:worker-b', delivery: 'stored', reply: null }],
    seenAtClose: null, summary: 'worker-a 提议：合入 feature/render-v2' };
  return authorityIds({ ...base, messages: [intent, ...base.messages] });
}
/** A second team's rows with unmistakable names: switching sessions must never show one on the other's page. */
export function scenarioTeamB(now) {
  const base = scenarioDefault(now);
  return { ...base,
    members: base.members.map(m => ({ ...m, name: 'b-' + m.name })),
    groups: base.groups.map(g => ({ ...g, label: g.label + '-b' })),
    goal: { ...base.goal, id: 'goal-b', title: '团队 B：只为隔离验收存在的目标' } };
}
export const FIXTURES = { default: scenarioDefault, 'team-30': scenarioLarge, empty: scenarioEmpty, borrow: scenarioBorrow,
  viewer: scenarioDefault, stale: scenarioDefault, 'unknown+deadletter': scenarioDeadLetter,
  'long-text': scenarioLongText, deadletter: scenarioDeadLetter, intent: scenarioIntent, 'two-teams': scenarioTeamB };


/**
 * M6 stand-in for the projection's v3 panels (N1/N3/N4/N2/P6/P2/P3/P4). The real server computes these in
 * packages/projections/panel.mjs; the client never derives them itself, so the mock must publish the same blocks or
 * the page would have nothing to render. Fixtures stay data; this only adds the panels over them.
 */
export function withPanelBlocks(data, viewer, now = Date.now()) {
  const members = data.members ?? [], tasks = data.tasks ?? [];
  const root = members.find(m => m.role === 'root') ?? null;
  const lifecycle = m => {
    if (m.observed === 'unknown' || m.status === 'unknown') return 'stuck';
    if (m.desired === 'retired' || m.observed === 'retiring' || m.observed === 'retired') return 'retiring';
    if (m.desired === 'frozen' || m.observed === 'frozen') return 'paused';
    return m.taskId || m.attempt ? 'normal' : 'idle';
  };
  const memberSummary = { normal: 0, stuck: 0, paused: 0, retiring: 0, idle: 0, stuckHandledBy: null };
  for (const m of members) if (m.role !== 'root') memberSummary[lifecycle(m)]++;
  if (memberSummary.stuck && root) memberSummary.stuckHandledBy = root.id;
  const has = states => tasks.filter(t => states.includes(t.state)).length;
  const total = tasks.filter(t => t.state !== 'cancelled').length;
  const delivery = { produced: has(['produced']), verifying: has(['verifying']), merged: has(['merged', 'integrating']),
    accepted: has(['accepted']), total };
  const working = members.filter(m => m.activity?.kind === 'running').length;
  const escalations = [];
  // N2: only a root -> operator transfer needs a human. The verdict is the operator's, so the row has no button: it is
  // a note saying where it is decided (§6 #12), exactly like the projection's escalationsOf.
  for (const t of data.threads ?? []) {
    if (t.state !== 'escalated' || t.escalationOwner !== 'operator') continue;
    escalations.push({ id: 'escalation:' + t.id, issueKey: t.id, sources: [t.id], question: t.question ?? '需要你决定',
      why: 'root 已把它转交 operator；浏览器没有这项权限', waitingSince: t.escalatedAt ?? t.openedAt ?? null,
      consequence: '确认前相关工作保持现状', primary: null, note: '说明行：由 operator 侧确认，浏览器不提供按钮',
      severity: 'bad', subject: { type: 'thread', id: t.id } });
  }
  // An unknown capacity occupancy is the safety row a person must see (15 §10); it carries the adjudication entry.
  for (const slot of data.capacity?.occupants ?? []) {
    if (slot.state !== 'unknown') continue;
    escalations.push({ id: 'escalation:' + slot.ref, issueKey: slot.ref, sources: [slot.ref],
      question: '容量占用 ' + slot.ref + ' 结果不明', why: '只有 operator 能根据证据确认',
      waitingSince: typeof data.capacity?.oldestAge === 'number' ? now - data.capacity.oldestAge : null,
      consequence: '确认前执行准入保持关闭', primary: null,
      note: '说明行：operator 侧核对 effectId 后记录结论；浏览器不提供按钮', severity: 'bad',
      subject: { type: 'capacity', id: slot.originRef ?? slot.ref } });
  }
  const headline = escalations.length ? 'needs-you' : memberSummary.stuck ? 'root-handling' : 'ok';
  const tail = escalations.length ? '需要你处理 ' + escalations.length + ' 件事'
    : memberSummary.stuck ? 'root 正在处理 ' + memberSummary.stuck + ' 个卡住' : '一切正常';
  const fresh = root ? members.find(m => m.id === root.id) : null;
  return { ...data,
    summary: { working, accepted: delivery.accepted, total, headline: { kind: headline,
      text: working + ' 人在做 · 已验收 ' + delivery.accepted + '/' + total + ' · ' + tail, targetRef: escalations[0]?.subject?.id ?? null } },
    memberSummary, delivery, escalations,
    intents: (data.messages ?? []).filter(m => m.kind === 'intent').map(m => ({ id: m.id, from: m.from ?? null,
      summary: m.summary ?? m.expectedOutcome ?? null, openedAt: m.openedAt ?? null, closesAt: m.closesAt ?? m.deadline ?? null,
      state: m.state ?? m.lifecycle ?? null, recipients: m.recipients ?? [], passedAt: null, unseenAtPass: [],
      revision: m.revision ?? 1 })),
    team: { teamId: 'team:mock', name: data.goal?.title ?? null, leaderSessionId: fresh?.nativeRef ?? 'session-root',
      createdAt: data.goal?.createdAt ?? now - 3600000 },
    viewerRole: viewer?.startsWith('viewer:') ? 'viewer' : (members.find(m => m.id === viewer)?.role ?? 'unknown'),
  };
}


const ACTIVITY_STATE_TEXT = { draft: '等待范围审批', ready: '准备开始', blocked: '正在等待处理', produced: '已产出',
  verifying: '正在验证', verified: '验证通过', integrating: '正在合并', merged: '已合并', accepted: '已验收',
  open: '已发起', collecting: '正在收集意见', deciding: '等待决定', decided: '已作出决定', escalated: '已转交处理',
  stored: '已送达信箱', visible: '已看到', resolved: '已完成', cancelled: '已取消', unknown: '结果尚未确认',
  expired: '等待期限已到', 'dead-letter': '投递未能完成', running: '正在执行', frozen: '已暂停', retired: '已退役' };
const ACTIVITY_CATEGORY_TEXT = { anomaly: '异常', 'needs-you': '需要你', 'root-decision': 'root 裁决',
  delivery: '交付与验收', other: '团队动态' };
/** M6 P12 stand-in: the mock derives the same bounded timeline shape the projection's activity endpoint publishes. */
export function mockActivity(data, query = {}, now = Date.now()) {
  const rows = [];
  const add = (id, row, kind, category, name, state, members = []) => rows.push({
    at: row.updatedAt ?? row.openedAt ?? row.createdAt ?? row.acceptedAt ?? row.verifiedAt ?? now,
    kind, category, id, subject: { type: kind, id, name }, members: members.filter(Boolean),
    text: name + '：' + (ACTIVITY_STATE_TEXT[state] ?? '记录已更新'),
    tags: [ACTIVITY_CATEGORY_TEXT[category], ...(row.evidence?.length ? ['证据 ' + row.evidence.length + ' 条'] : [])],
  });
  for (const t of data.threads ?? []) {
    const category = t.state === 'escalated' && t.responsible === 'operator' ? 'needs-you'
      : t.state === 'decided' ? 'root-decision' : 'other';
    add(t.id, t, 'thread', category, t.question ?? t.id, t.state, [t.owner, t.escalatedBy]);
  }
  for (const m of data.messages ?? []) {
    const category = m.lifecycle === 'dead-letter' || m.lifecycle === 'unknown' ? 'anomaly'
      : m.lifecycle === 'resolved' ? 'root-decision' : 'other';
    add(m.id, m, 'message', category, m.summary ?? m.expectedOutcome ?? m.id, m.lifecycle, [m.from, m.to]);
  }
  for (const t of data.tasks ?? []) add(t.id, t, 'task', 'delivery', t.title ?? t.id, t.state, [t.owner]);
  for (const t of data.decisions ?? []) add(t.id, t, 'decision', 'root-decision', t.summary ?? t.id, t.state, [t.openedFor]);
  rows.sort((a, b) => a.at - b.at);
  rows.forEach((row, index) => { row.seq = index + 1; });
  const asOfSeq = rows.length;
  const filter = query.kind ?? null;
  let events = rows.filter(row => (!filter || row.category === filter || row.kind === filter) &&
    (!query.member || row.members.includes(query.member)) &&
    (query.from == null || row.at >= query.from) && (query.to == null || row.at <= query.to));
  const limit = Math.min(Number.isSafeInteger(query.limit) && query.limit > 0 ? query.limit : 500, 500);
  const forward = query.afterSeq != null;
  if (forward) events = events.filter(row => row.seq > query.afterSeq).sort((a, b) => a.seq - b.seq);
  else {
    if (query.beforeSeq != null) events = events.filter(row => row.seq < query.beforeSeq);
    events = events.sort((a, b) => b.seq - a.seq);
  }
  const total = events.length, page = events.slice(0, limit), hasMore = total > page.length;
  const ordered = forward ? [...page].reverse() : page;
  return { events: ordered.map(row => ({ ...row, members: [...row.members] })), total,
    categories: ['anomaly', 'needs-you', 'root-decision', 'delivery'], replayAfterSeq: 0, asOfSeq,
    nextAfterSeq: forward && hasMore ? page.at(-1).seq : asOfSeq,
    nextBeforeSeq: !forward && hasMore ? page.at(-1).seq : null, hasMore };
}

/**
 * In-memory ProjectionSource. Emits ordered events (lease heartbeats, context drift) and
 * reflects accepted commands a little later, the way an authoritative server would.
 * `control` exists only for verification (gap, stream drop, stale flag, fixture switch).
 */
export function createMockSource(options = {}) {
  const now = options.now ?? (() => Date.now());
  const tickMs = options.tickMs ?? 2000;
  let fixture = options.fixture ?? 'default';
  const viewer = options.viewer ?? (fixture === 'viewer' ? 'viewer:readonly' : MOCK_VIEWER);
  let data = withPanelBlocks(FIXTURES[fixture](now()), viewer, now());
  let baseline = new Map(data.members.map(m => [m.id, m.context?.pct]));
  let seq = 48211, stale = fixture === 'stale', dropUntil = 0, gapNext = false;
  const subscribers = new Set();
  const revisions = () => ({ organization: 312 + seq % 7, scheduler: 9021 + seq, mailbox: 4410 + seq, threads: 88, delivery: 61 });
  const emit = event => {
    if (now() < dropUntil) return;
    const e = { schemaVersion: SCHEMA_VERSION, seq: gapNext ? seq + 2 : seq + 1, ...event };
    if (gapNext) { gapNext = false; seq += 2; } else seq += 1;
    // Authoritative state advances even when a subscriber is about to resync.
    const { upserts, removes, goal } = event;
    if (goal) data = { ...data, goal };
    // P5: resourceThreads (and any later optional collection) may not exist in an older fixture; an event for it
    // creates the collection instead of failing on undefined.
    for (const key of Object.keys(upserts ?? {})) { const map = new Map((data[key] ?? []).map(x => [x.id, x])); for (const x of upserts[key]) map.set(x.id, x); data = { ...data, [key]: [...map.values()] }; }
    for (const key of Object.keys(removes ?? {})) data = { ...data, [key]: (data[key] ?? []).filter(x => !removes[key].includes(x.id)) };
    const panel = withPanelBlocks(data, viewer, now());
    for (const s of subscribers) s.onEvent({ ...e, summary: panel.summary, memberSummary: panel.memberSummary,
      delivery: panel.delivery, escalations: panel.escalations, intents: panel.intents, team: panel.team,
      viewerRole: panel.viewerRole });
  };
  let tick = 0;
  const heartbeat = () => {
    tick++;
    if (now() < dropUntil) return;
    const t = now();
    const changed = [];
    for (const m of data.members) {
      const a = m.attempt;
      if (!a || a.state !== 'running' || !a.lease || a.lease.state !== 'active') continue;
      let next = m;
      if (a.lease.expiresAt - t < 15 * S) next = { ...next, attempt: { ...a, lease: { ...a.lease, expiresAt: t + 60 * S } }, checkpointAt: t };
      const base = baseline.get(m.id);
      if (m.context && base != null && (tick + m.id.length) % 3 === 0) {
        // Bounded drift around the fixture value so long sessions keep the designed state mix.
        // Relative to the 75% limit: keep each member inside its designed band (ok < 80 ≤ warn < 100 ≤ bad).
        const pct = Math.max(1, Math.min(base >= 100 ? 105 : base >= 80 ? 99 : 77, base + Math.round(Math.sin((tick + m.id.length * 3) / 4) * 3)));
        next = { ...next, context: { ...m.context, pct, inputTokens: Math.round(m.context.limitTokens * pct / 100) } };
      }
      // Lease heartbeats / context usage are scheduler & context facts: they do not bump the organization revision used for CAS.
      if (next !== m) changed.push(next);
    }
    emit({ upserts: changed.length ? { members: changed } : {}, stale });
  };
  let timer = null;
  const ensureTimer = () => { if (!timer && subscribers.size) timer = setInterval(heartbeat, tickMs); if (timer && !subscribers.size) { clearInterval(timer); timer = null; } };
  const later = (ms, fn) => setTimeout(fn, ms);
  const findMember = id => data.members.find(m => m.id === id);
  const source = {
    describe: () => ({ kind: 'mock', label: `模拟投影 · ${fixture}`, viewer, heartbeat: true }),
    async snapshot() {
      await new Promise(r => setTimeout(r, 120));
      return { schemaVersion: SCHEMA_VERSION, teamId: 'team:mock', asOfSeq: seq, sourceRevisions: revisions(),
        stale, viewer, data: structuredClone(data) };
    },
    // M6 P2/P12: which team a session belongs to, and the records timeline. `session:none` is the fixture's
    // "this session has no team" case.
    async binding(sessionId) {
      if (!sessionId || sessionId === 'session:none' || fixture === 'empty') return null;
      const member = [...data.members].find(m => m.nativeRef === sessionId) ?? null;
      return { teamId: 'team:mock', sessionId, memberId: member?.id ?? null, role: member?.role ?? null, name: data.team?.name ?? null };
    },
    async activity(query = {}) { return mockActivity(data, query, now()); },
    subscribe(afterSeq, onEvent, onStatus) {
      const sub = { onEvent, onStatus };
      subscribers.add(sub); ensureTimer();
      setTimeout(() => onStatus(now() < dropUntil ? 'closed' : 'open'), 30);
      return () => { subscribers.delete(sub); ensureTimer(); };
    },
  };
  const control = {
    get fixture() { return fixture; },
    setFixture(name) { fixture = name; data = withPanelBlocks(FIXTURES[name](now()), viewer, now()); baseline = new Map(data.members.map(m => [m.id, m.context?.pct])); seq += 100; for (const s of subscribers) s.onEvent({ schemaVersion: SCHEMA_VERSION, seq: seq + 1000 }); },
    injectGap() { gapNext = true; heartbeat(); },
    dropStream(ms) { dropUntil = now() + ms; for (const s of subscribers) s.onStatus('closed'); setTimeout(() => { for (const s of subscribers) s.onStatus('open'); heartbeat(); }, ms + 50); },
    setStale(value) { stale = value; heartbeat(); },
    seq: () => seq,
  };
  /** Mock command gateway: returns a receipt; state changes arrive only via later projection events. */
  const gateway = {
    async submit(command) {
      await new Promise(r => setTimeout(r, 350));
      const operationId = `op-${Math.random().toString(16).slice(2, 10)}`;
      if (viewer !== MOCK_VIEWER || command.name === 'organization.confirmStopped') return { operationId, status: 'rejected', revision: null,
        entityId: command.target, message: 'ROLE_DENIED' };
      const target = command.target;
      // Same contract as packages/projections/commands.mjs: unknown command → rejected; missing/old revision → conflict.
      if (!COMMANDS[command.name]) return { operationId, status: 'rejected', revision: null, entityId: target, message: 'UNSUPPORTED_COMMAND' };
      // Opening a resource names a new thread id: it has no current row, so it is the one command whose target may
      // legitimately be absent. Everything else is CAS'd against the row the browser read.
      if (command.name === 'threads.openResource') {
        const issueId = target ?? ('thread:' + operationId);
        const thread = { id: issueId, kind: 'resource', status: 'open', owner: command.args.owner ?? MOCK_VIEWER,
          resource: command.args.resource, head: 0, retainedFrom: 1, pending: 0, descriptionRef: command.args.descriptionRef,
          subscribers: [], lastEvent: null, revision: 1 };
        later(300, () => emit({ upserts: { resourceThreads: [thread] } }));
        return { operationId, status: 'accepted', revision: 0, entityId: issueId };
      }
      const current = [...data.members, ...data.threads, ...(data.resourceThreads ?? [])].find(x => x.id === target);
      if (!current || !Number.isSafeInteger(command.expectedRevision) || current.revision !== command.expectedRevision)
        return { operationId, status: 'conflict', revision: null, entityId: target, message: 'CAS_CONFLICT' };
      if (command.name === 'threads.publish' && !(data.resourceThreads ?? []).find(x => x.id === target))
        return { operationId, status: 'rejected', revision: null, entityId: target, message: 'WRONG_THREAD_KIND' };
      if (command.name === 'mailbox.send' && command.target !== command.args.recipient)
        return { operationId, status: 'rejected', revision: null, entityId: target, message: 'TARGET_RECIPIENT_MISMATCH' };
      const t = now();
      switch (command.name) {
        case 'organization.requestFreeze': {
          const m = findMember(target);
          later(1200, () => emit({ upserts: { members: [{ ...findMember(target), desired: 'frozen', history: [...m.history, 'freezing'], revision: m.revision + 1 }] } }));
          later(7000, () => { const cur = findMember(target); emit({ upserts: { members: [{ ...cur, observed: 'frozen', history: [...cur.history, 'frozen'], attempt: cur.attempt && { ...cur.attempt, lease: cur.attempt.lease && { ...cur.attempt.lease, state: 'revoked' } }, revision: cur.revision + 1 }] } }); });
          break;
        }
        case 'organization.requestResume': {
          later(1200, () => { const cur = findMember(target); emit({ upserts: { members: [{ ...cur, desired: 'active', history: [...cur.history, 'resuming'], revision: cur.revision + 1 }] } }); });
          later(5000, () => { const cur = findMember(target); emit({ upserts: { members: [{ ...cur, observed: 'active', history: [...cur.history, 'active'], revision: cur.revision + 1 }] } }); });
          break;
        }
        case 'threads.decide': {
          later(1200, () => { const th = data.threads.find(x => x.id === target); emit({ upserts: { threads: [{ ...th, state: 'decided', decisionRevision: 1, revision: th.revision + 1 }] } }); });
          break;
        }
        case 'threads.subscribe': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const memberId = command.args.memberId ?? MOCK_VIEWER;
          const subscribers = [...thread.subscribers.filter(sub => sub.memberId !== memberId),
            { memberId, generation: 1, subscriptionEpoch: 1, state: 'active', startAfterSeq: thread.head, visibleThrough: 0, pending: 0 }];
          const next = { ...thread, subscribers, revision: thread.revision + 1 };
          later(400, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'threads.unsubscribe': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const memberId = command.args.memberId ?? MOCK_VIEWER;
          const subscribers = thread.subscribers.map(sub => sub.memberId === memberId ? { ...sub, state: 'closed', pending: 0 } : sub);
          const next = { ...thread, subscribers, revision: thread.revision + 1 };
          later(400, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'threads.publish': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const seq = thread.head + 1;
          const next = { ...thread, head: seq, revision: thread.revision + 1,
            lastEvent: { seq, eventType: command.args.eventType, summary: command.args.summary, actor: MOCK_VIEWER, occurredAt: t },
            subscribers: thread.subscribers.map(sub => sub.state === 'active' ? { ...sub, pending: sub.pending + 1 } : sub) };
          later(500, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'threads.closeResource': {
          const thread = data.resourceThreads.find(x => x.id === target);
          const next = { ...thread, status: 'closed', revision: thread.revision + 1 };
          later(400, () => emit({ upserts: { resourceThreads: [next] } }));
          break;
        }
        case 'mailbox.send': {
          const id = `msg-${Math.floor(t / 1000) % 1000}`;
          const m = msg(t, id, MOCK_VIEWER, command.args.recipient, command.args.kind, { openedAt: t, deadline: t + command.args.deadlineMin * M, expected: command.args.expectedOutcome });
          later(900, () => emit({ upserts: { messages: [m] } }));
          later(4000, () => emit({ upserts: { messages: [{ ...m, lifecycle: 'visible', receipts: { ...m.receipts, visible: { at: now(), requestId: 'r-' + id, manifest: 'c0ffee12ab', seq: seq + 1 } }, revision: 2 }] } }));
          break;
        }
        default: break;
      }
      return { operationId, status: 'accepted', revision: current.revision, entityId: target };
    },
  };
  return { source, control, gateway };
}
