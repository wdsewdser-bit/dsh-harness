# DSH / CLM 施工变更说明

日期：2026-10-01（北京时间）

## 结论

本轮把请求投影、计量归因、Team 紧凑查询/消息幂等和 CLM scoped memo/context view 接入了 DSH 当前运行态，并通过 HMR 在 PID `16440` 上加载；没有重启 DSH，没有中断原 root/Team，也没有清理任何历史数据。

CLM 的默认行为是 `shadow`：它可以保存 task/member scoped memo、做 CAS 版本召回、提出下一轮 context view，并给出预览，但不会改写原 journal、task、lease、phase、permission 或 evidence 权威事实。隔离 PTC 会话已经完整通过 shadow 的 canonical 工具回执；有限 apply 到达了真实 allowlist 边界，但模型没有执行 apply 阶段要求的二次提交，因此按实证标记 `partial`，没有伪报成功。

Reducer 在 CLM shadow 验收后才切换为可用配置：只允许本地 `opencodego`，保持 `remoteAllowed=false`，仍以当前 session route 解析 provider/model。历史真实 telemetry 目前没有 fired/reduced receipt，原因是实际输入被 ObservationPack 先处理或低于 20,480 bytes；这不是“Reducer 已经产生收益”的证据。离线 fixture 的 reducer 质量回归通过，但不能外推账单节省。

## 改了什么

### 1. 请求与计量（A）

- `request-message-projection.mjs` 增加了可复用的 prepared request plan、纯 preview、最终一次性 prepare 和 dispatch receipt。
- `ptc-sdk-retention.mjs`、`observation-pack-v2.mjs` 与 `step-compaction-v4.mjs` 使用同一请求快照语义；原始安全上限和投影后的经济计量分开记录。
- `request-usage-ledger.mjs` 与 `team-v13-cache-monitor.mjs` 按同一 `requestId` 关联 projection/usage；未知 provider 字段保持 unknown，不写成 0。
- ObservationPack 的 HMR teardown 改为幂等 fiber cleanup，避免重载后重复 registration。

### 2. Team 查询与通知（B）

- `team-tools-v2-r10.mjs` 对同一权威 revision 一次构造 ready queue，支持 compact/full、精确 task IDs、changed_since、snapshotRevision 和分页。
- `team-activity-digest.mjs` 只在 actionable facts 或真实责任到期变化时生成新 digest，抑制无变化时间槽重复唤醒。
- `team-message-operation.mjs` 和控制面消息提交使用 sender/target/task revision/event/delivery 绑定的 `operation_id`，重复提交返回原始回执，payload 改变会拒绝。
- `team-control-plane.mjs`、`team-v12-runtime.mjs`、`team-v12-evidence-scheduler.mjs` 等依赖一起做了受控 HMR，避免只刷新入口导致旧 schema 残留。

### 3. CLM 工作上下文（C）

- `context-workspace.mjs` 提供 `context_manage`：`state`、`memo_put/get/diff`、`propose`、`preview`、`commit`、`rollback`。
- memo 具备 scope/ACL、revision/parentRevision、SHA256、locator、evidenceRefs、TTL、软删除和 CAS 冲突保护。
- context view 只作用于下一安全请求边界；预览回执包含原文保留、权威状态保留、锚点、最早改写位置、suffix bytes 和预计冷债。
- C 的投影桥使用纯 transform，拒绝未知协议、损坏锚点、未完成工具链和越权 locator，并保留原始历史。

### 4. Reducer 运行态

最终 live settings：

```json
{
  "enabled": true,
  "routeMode": "session",
  "localProviders": ["opencodego"],
  "remoteAllowed": false,
  "thresholdBytes": 20480,
  "maxReceiptTokens": 1500
}
```

安全理由：当前主要 route 是本地 `http://127.0.0.1:8788/v1` 的 `opencodego`；allowlist 只放这个 provider，避免 Reducer 误把远程/未验证中转当作受信路径。Reducer 仍先归档原文、再做 receipt 验证和 evidence registration；失败或未知时保留原始结果。

## 为什么这样改

- DSH 的权威事实和 CLM 的可编辑工作视图必须分层；直接复制 CLM 自由编辑 transcript 会破坏 DeepSeek thinking/tool history、task/evidence 对齐和恢复语义。
- Team 查询/通知属于确定性热路径，减少重复构造和无新事实唤醒比让模型自己过滤长全值更可靠。
- 统一 prepared request 和 receipt 是区分“投影尝试”“交给 adapter”“provider 实际使用”的前提，尤其当前中转的 `cacheWriteTokens` 经常返回 null。
- Reducer 只对明确受信 provider 放行，并保留原文/回执，避免把离线样本或 ObservationPack modeled savedTokens 当成真实账单节省。

## 运行态与新会话证据

- DSH PID `16440`，启动时间未变：`2026-09-30T16:37:18.1485795+08:00`。
- HMR：`hmr-consumers-final.json`、`hmr-team-v10b.json`；最终 C runtime：`runtime-services-final.json`，模式 `shadow`，allowlist 为空。
- Agent SDK：`sdk-loaded-root-g.json`，135 schemas、147,905 bytes；同一 agent scope 同时包含 `context_manage`、`team_task_get/list(view,snapshotRevision)` 和 `send_message(operation_id)`。
- 隔离工作区：`D:/dsh-test/workspaces/clm-lab-20261001-g`。
  - PTC shadow：2 requests，input `93,436`，output `1,837`，21 个 canonical assertions、projection unchanged、oracle 全部通过。
  - 有限 apply：live gate `apply + exact root allowlist` 通过；operationId duplicate、task revision/status/phase 关系通过；模型未提交二次 context view，故 apply projection 与两个 commit/revision assertion 为 partial。该 session 已停止，不重试相同 session。
- 原标准预设实验 `lab-b` 未调用 CLM 工具；这证明标准 preset 不适合该工具协议，不代表 CLM 实现失败。后续真实验证固定使用显式 `agentPreset=ptc`。

## 验证

- 关键模块 `node --check`：16 个通过。
- 聚焦回归：82/82 通过，覆盖 request plan、context workspace、live runner、Team query/digest、request bridge、usage ledger、ObservationPack lineage、milestone dedup。
- Reducer focused tests：10/10 通过；离线 mechanism A/B：ObservationPack `19,764 -> 485`，Reducer `19,764 -> 374`，`qualityRegression=false`。
- 四逻辑 profile（web/headless/desktop/teamtest）关键插件 SHA256 parity=true。
- 适用全量回归沿用已记录结果：626 tests，623 pass、2 known fail、1 skip；旧失败和 health 脚本退出码假绿均保留，没有伪报全绿。

## 未决风险与后续

- `cacheWriteTokens` 仍是中转未知值；本轮没有猜测归一化结果。
- Reducer 历史真实 fired/reduced 仍为 0，需在自然产生大于阈值且未被 ObservationPack 先处理的真实工具结果后再评估总成本、cache cold debt 和质量。
- CLM apply 需要模型按协议完成二次 commit；当前默认 shadow 是安全可用状态，不扩大 allowlist。
- 第二轮只读优化报告见 `second-pass-optimization.md`。优先级是运行态 schema/usage 证据、context 同 revision 缓存、context delivery 增量统计、inbox cursor、compaction debt 写盘抑制；本轮没有把未经压测的建议直接上线。

## 边界确认

没有修改 RustMc 产品仓；没有重启 DSH；没有中断原 root/Team；没有删除或清理 backup、spill、telemetry、session；没有启用机会压缩；没有切换 Responses/全局 thinking；没有使用 Terra。

## 后续续施工：Reducer UI 与低风险缓存（2026-10-01）

在用户反馈“UI 勾选后实际没有作用”后，新增的详细记录见 `reducer-ui-fix-20261001.md`。核心变化是 UI 保存现在带 live Settings revision、原子 mutation、读回校验和明确的保存提示；重复 Reducer override 已删除，配置 lint 已加入。当前 live 配置为 enabled/session/opencodego-only/remote-deny，阈值与输入上限已调整为 32768/1200/16/45000/131072/3000。

同时实施了文档第二轮中边界最清楚的 context projection cache，并同步四 profile；HMR 后仍为 PID 16440、bridge registrations=4，context runtime hash 已更新。Reducer JSON 现在只作为镜像和命令回退，live Settings 是事实源；镜像失败会告警，命令的 live 写入失败会直接报告。聚焦验证和 `reducer-settings-lint.mjs` 均通过。

### 最终验证更正（2026-10-01 15:00）

按正确递归入口补跑了完整回归：146 个测试文件、679 项，673 通过、5 个既有基线失败、1 个跳过。失败为 `live-lab-runner` schema drift 以及 request-plan/request-message-projection 品牌契约，和本轮改动无关；原始日志保留在 `D:/dsh-test/docs/architecture-review-20261001/full-regression-ui-fix-20261001-complete.txt`。运行态 Reducer telemetry 已出现 `fired=1` / `reduced=1`，因此现在可以确认 UI 设置已能进入实际 Reducer 链路；这不等于已经得到稳定收益率。
