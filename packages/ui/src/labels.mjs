// The human-language dictionary (15-ui-design-v2.md §3.2). Constants only: WP-4 wires them into the panel; they live
// here from WP-3 so the wording has one home and the split itself changes no rendered text.
export const ACTIVITY_TEXT = Object.freeze({
  running: '运行中', idle: '空闲', maintenance: '维护中', missing: '状态未知',
});
export const ACTIVITY_COMPACTION_TEXT = '压缩上下文';
export const MEMBER_STEP_TEXT = Object.freeze({
  requested: '已登记', creating: '正在创建', bound: '已绑定会话', active: '运行中', freezing: '正在暂停',
  frozen: '已暂停', resuming: '正在恢复', retiring: '正在退役', retired: '已退役', unknown: '状态不明',
});
export const LIFECYCLE_TEXT = Object.freeze({
  starting: '正在启动', pausing: '正在暂停…', paused: '已暂停',
  retiring: '退役中…', retired: '已退役', unknown: '状态不明',
});
export const TASK_STAGE_TEXT = Object.freeze({
  draft: '待批准', ready: '待开始', executing: '进行中', blocked: '卡住', produced: '已产出',
  verifying: '验证中', verified: '已验证', integrating: '合并中', merged: '已合并',
  accepted: '已验收', cancelled: '已取消',
});
export const THREAD_STATE_TEXT = Object.freeze({
  open: '收集答复中', collecting: '收集答复中', deciding: '等待决定', escalated: '已升级',
  decided: '已决定', closed: '已关闭', cancelled: '已取消', superseded: '被新提案取代',
});
export const MESSAGE_STEP_TEXT = Object.freeze({ stored: '已送达', visible: '看到', accepted: '接手' });
export const MESSAGE_LIFECYCLE_TEXT = Object.freeze({
  resolved: '已办结', cancelled: '已取消', expired: '已过期', 'dead-letter': '死信',
});
export const MESSAGE_KIND_TEXT = Object.freeze({
  action: '行动请求', decision: '决定请求', info: '通知', intent: '提议',
});
export const INTENT_TEXT = Object.freeze({
  open: '反对窗口进行中', objected: '有反对 · 不会自动通过', passed: '自动通过',
  unseenAtPass: '▲ 通过时还没看到', ok: '同意', object: '反对',
  silent: '看到了 · 没表态', unseen: '已送达 · 还没看到',
});
export const VIEWER_ROLE_TEXT = Object.freeze({
  root: '你是组长 · 可操作', operator: 'operator · 可裁决', viewer: '只读查看 · 无写权限',
  member: '成员 · 部分可操作', unknown: '身份未确认 · 暂不可操作',
});
export const DELIVERY_TEXT = Object.freeze({
  valid: '证书有效', invalid: '证书失效', prepared: '合并中', confirmed: '合并已确认', unknown: '合并结果不明',
});
