// Read-side admission for the existing browser gateway. Assumes fresh CAS and valid command arguments;
// it never simulates a write. Each branch mirrors its particular gateway/reducer, not a shared "decides" role.
const yes = Object.freeze({ allowed: true, reasonCode: null, reasonText: null });
const no = (reasonCode, reasonText) => ({ allowed: false, reasonCode, reasonText });
const roleDenied = () => no('ROLE_DENIED', '当前身份不能执行这条命令');
const stateDenied = () => no('INVALID_STATE', '对象当前状态不接受这条命令');

function publishGate(raw, actor, rows, policy) {
  if (!raw?.taskRef) return null;
  const task = rows.get(raw.taskRef);
  if (!task) return no('MISSING_REFERENCE', '关联任务不存在或不可见');
  const all = [...rows.values()];
  if (policy.intentProtocol === 'root-decision-v1') {
    const decisions = all.filter(row => row.kind === 'coordination' && row.binding?.taskRef === raw.taskRef &&
      row.binding?.contractRevision === task.contractRevision);
    const cleared = new Set();
    for (const row of decisions.filter(row => row.state === 'decided' && row.verdict?.option === 'approve')) {
      let id = row.binding?.previousDecisionId;
      while (id && !cleared.has(id)) { cleared.add(id); id = rows.get(id)?.binding?.previousDecisionId; }
    }
    if (decisions.some(row => !cleared.has(row.entityId) && !(row.state === 'decided' && row.verdict?.option === 'approve'))) {
      return no('COORDINATION_PENDING', '相关合同仍在等待 root 裁决');
    }
  } else if (policy.collab === 'on') {
    const intents = all.filter(row => row.kind === 'intent' && row.sender === actor && row.taskRef === raw.taskRef &&
      row.contractRevision === task.contractRevision);
    const waived = row => (row.waivers ?? []).some(w => w.contractRevision === task.contractRevision &&
      rows.get(w.decisionRef)?.state === 'decided' && rows.get(w.decisionRef)?.verdict?.option === 'waive');
    if (intents.some(row => row.decision === 'objected' && !waived(row))) return no('INTENT_OBJECTED', '下游提出异议');
    if (intents.some(row => row.decision === 'passed' || (row.decision === 'objected' && waived(row)))) return null;
    if (intents.length) return no('INTENT_WINDOW_OPEN', '提议窗口尚未通过');
    return no('INTENT_REQUIRED', '尚无已通过的提议');
  }
  return null;
}

export function capabilitiesFor(kind, object, me, actor, { rows = new Map(), ...policy } = {}) {
  const raw = rows.get(object.id) ?? object;
  const root = me.role === 'root' || actor === 'root' || actor === 'operator';
  const operator = actor === 'operator';
  const toolRole = ['root', 'subCoordinator', 'coordinator'].includes(me.role);
  const frozen = [...rows.values()].some(row => row.entityId?.startsWith('completion:') &&
    ['prepared', 'authorized', 'unknown'].includes(row.status));
  const check = command => {
    const readable = root || raw.entityId === actor || raw.owner === actor || raw.sender === actor ||
      raw.recipient === actor || raw.recipients?.includes(actor) || raw.requiredRespondents?.includes(actor) || raw.acl?.includes(actor);
    if (!readable) return no('REFERENCE_ACL', '对象对当前身份不可见');
    if (policy.enabled === false) return no('TEAM_DISABLED', '团队未启用');
    // The browser never holds this authority (§6 #12): it only ever reads the note and the refusal. The operator path
    // is the one the gateway carries, and it meets the core's freeze gate exactly as confirmStopped's own mutate does
    // (F24's freeze-proof close-out is the adapter's attempt.release path, not this entry). The branch still comes first
    // so a browser is told "operator only" rather than "frozen".
    if (command === 'organization.confirmStopped') {
      if (!operator) return no('OPERATOR_ONLY', '只有 operator 能确认会话已停止，浏览器没有此权限');
      if (frozen) return no('COMPLETION_FROZEN', '完成检查期间禁止修改');
      if (kind !== 'attempt' || !object.id?.startsWith('attempt:') || raw.lease !== 'unknown') {
        return no('NOT_UNKNOWN', '目标必须是 lease 为 unknown 的执行 attempt');
      }
      return yes;
    }
    if (frozen) return no('COMPLETION_FROZEN', '完成检查期间禁止修改');
    if (command === 'mailbox.send') {
      if (kind !== 'member') return no('TARGET_RECIPIENT_MISMATCH', '发消息的目标必须是收件成员');
      if (me.desired !== 'active' && !toolRole) {
        return no('MEMBER_INACTIVE', '发送者已暂停或退役');
      }
      if (!toolRole) return no('EXECUTION_BINDING_REQUIRED', '浏览器未携带执行 lease');
      return yes;
    }
    if (command.startsWith('organization.')) {
      const admitted = me.role === 'root' || (command === 'organization.retire' && ['root', 'operator'].includes(actor));
      return admitted && kind === 'member' ? yes : roleDenied();
    }
    if (command === 'scheduler.approveContract') {
      if (!root) return roleDenied();
      return (raw.status ?? object.state) === 'draft' && !raw.approved ? yes : stateDenied();
    }
    if (command === 'threads.decide') {
      if (!toolRole) return no('EXECUTION_BINDING_REQUIRED', '浏览器未携带执行 lease');
      if (raw.owner !== actor) return roleDenied();
      if ((raw.status ?? object.state) !== 'collecting') return no('STALE_DECISION', '只有 collecting 的 owner 能裁决');
      return publishGate(raw, actor, rows, policy) ?? yes;
    }
    if (command === 'threads.escalate') {
      if (!root) return roleDenied();
      return ['open', 'collecting', 'deciding'].includes(raw.status ?? object.state) ? yes : stateDenied();
    }
    if (command === 'mailbox.cancelMessage' || command === 'mailbox.rebind') {
      if (!root) return roleDenied();
      if (raw.kind === 'intent' || ['resolved', 'cancelled', 'unknown'].includes(raw.status ?? object.lifecycle)) return stateDenied();
      return yes;
    }
    if (!operator) return no('OPERATOR_ONLY', '只有 operator 能执行，浏览器没有此权限');
    if (command === 'mailbox.resolveUnknown') return object.id.startsWith('message:') &&
      (raw.status ?? object.lifecycle) === 'unknown' ? yes : no('INVALID_MESSAGE', '此入口只处理结果不明的消息');
    if (command === 'delivery.reconcile') return object.id.startsWith('delivery:') && raw.status === 'unknown'
      ? yes : stateDenied();
    return no('UNSUPPORTED_COMMAND', '浏览器网关未提供此入口');
  };
  const commands = { member: ['organization.requestFreeze', 'organization.requestResume', 'organization.retire', 'mailbox.send'],
    attempt: ['organization.confirmStopped'], task: ['scheduler.approveContract'], thread: ['threads.decide', 'threads.escalate'],
    message: ['mailbox.send', 'mailbox.cancelMessage', 'mailbox.rebind'],
    unknownEffect: ['mailbox.resolveUnknown', ...(object.id.startsWith('delivery:') ? ['delivery.reconcile'] : [])] };
  return Object.fromEntries((commands[kind] ?? []).map(command => [command, check(command)]));
}
