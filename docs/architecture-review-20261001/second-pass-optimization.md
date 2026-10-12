# DSH 第二轮架构与效率复核（2026-10-01）

范围：复核 `architecture-review-20261001` 的 implementation-plan/ledger、v13/v14 台账、当前 web profile 源码、staging A/B/C 和真实 CLM 实验记录。本文记录第二轮复核当时的只读判断；后续受控 HMR 和隔离 PTC 实测的最终事实以 `implementation-ledger.md` 最终收口节、`change-summary-20261001.md` 为准。本文本身没有修改 profile、重启 DSH、中断 Team 或清理 session/spill/telemetry/backup。下面按优先级列出最多 8 个仍值得处理的项目，避免重复已经在首轮计划中完成的 Action Fusion、ObservationPack 基本哈希校验、Team ready 一次派生和无变化 digest 抑制。

## 最终事实覆盖

复核报告形成后，P0 项 1 已通过同一 PID 的受控 Team HMR 和新 PTC 会话验收：`sdk-loaded-root-g.json` 同时含 `context_manage`、`team_task_get/list(view,snapshotRevision)`、`send_message(operation_id)`。P0 项 2 的未知 usage 语义仍保持不变。Reducer 已按用户授权仅 allowlist `opencodego`；UI/live Settings 修复、重复 override lint 和运行态 HMR 已完成，真实 telemetry 是否产生 verified receipt 仍需自然长日志样本。

## 结论

当前最大风险是“磁盘/staging 已有新能力，但运行态仍消费旧契约”，其次是几个每轮热路径仍会重复扫描、编译或同步写盘。A/B/C 的离线测试很强，但不能替代新会话的真实工具 schema、provider usage 和质量闭环。建议先收口运行态一致性与计量，再做长驻性能优化；本轮只建议实施低风险的证据/缓存改造，涉及 HMR/重启或 provider 行为的项目保留为后续受控验收。

## 优先项

### 1. P0：消除 staging 与运行态 Team schema 分裂（本轮不直接实施，先做受控加载验收）

**证据**：`D:/dsh-test/docs/architecture-review-20261001/implementation-ledger.md:62-67` 记录加载快照已有 `context_manage`，但 `team_task_get/list` 仍是旧 schema、`send_message` 没有 `operation`；B 的新文件虽然四 profile 已同步，却没有对 Team 工具做 live HMR。`team-efficiency-validation.md` 的剩余限制也明确没有 live loading、profile parity 或 SDK certificate。

**收益假设**：避免模型看到新旧两套能力而形成错误调用路径，例如用新 `operation_id` 预期幂等、实际却落到旧发送契约，进而重复通知或把 staged 查询结果当运行态事实。统一 loaded hash、schema version、plugin instance id 的健康输出后，部署判断才不再依赖磁盘哈希。

**验证建议**：在隔离新会话中先采集旧 SDK/hash，再受控加载 Team plugins，确认 `team_task_get/list(view,snapshotRevision)`、`send_message(operation_id)` 与 `context_manage` 同时出现在同一 agent scope；跑一次正常查询、一次相同 operation 重放和一次跨 revision 拒绝。记录 HMR 后的实际 plugin instance/hash，不把 staged 文件存在当作通过。

### 2. P0：补齐 provider usage 字段归一化，保持未知值语义（建议本轮实施为只读 schema 适配）

**证据**：同一 ledger 的真实实验记录中，lab-a、lab-b、lab-c 的 `cacheWriteTokens` 均为 `null`，分别以 `UNKNOWN_USAGE_STOP` 或 `unknownFields` 保留；`request-usage-ledger.mjs:10-31, 136-149` 只从固定 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens/totalTokens` 读取。`implementation-plan.md` 也要求未知字段不能当 0。

**收益假设**：正确识别当前中转的 usage 命名/嵌套后，compaction economics、cache monitor 和成本归因不再长期停在 unknown；同时保留 raw provider receipt 和 `usageSource`，避免把推测值写成账单事实。若确实没有 wire 字段，结果仍应是明确 unknown，而不是猜测。

**验证建议**：对当前 opencodego/DeepSeek 中转捕获一条未改写的 usage chunk，建立字段映射表和 route-specific normalizer；用含 cache write、缺 cache write、分块多次 usage、错误终止四个 fixture 验证求和、unknown 传播和 ledger 原文保留。未有真实字段时只落“未提供”诊断，不改计量为 0。

### 3. P1：为 context-workspace 的同 revision 投影增加可失效缓存（本轮已实施）

**证据**：staging `context-workspace.mjs:225-227` 每次服务调用都从 durable JSON 重新读文档；`context-workspace.mjs:360-375` 每次 request projection 都重做 `currentView`、`previewView`、member memory/recovery pack、hash 和 suffix。view revision 未变时这些结果是同一份输入的重复工作。

**收益假设**：减少每个 agent step 的同步读盘、SHA256、锚点捕获和 JSON 分配，降低事件循环延迟；缓存只针对 `(teamId, member, sessionId, viewRevision, controlRevision, moduleHash)`，不会跨权限或跨 session 复用。预期收益是长会话中 projection p95 与 durable-store 锁等待下降，而非直接承诺 provider token 节省。

**本轮结果**：加入同一 Team/member/session、view revision、control revision 和 mode 的 1 秒/32 项 bounded cache；source TTL、CAS/view revision、control revision 和 HMR 实例变化会自然失效。13 项 context workspace 回归和 live HMR hash 通过；尚未做 100/2000 source 的 p95 压测，因此不宣称固定百分比收益。

### 4. P1：上下文预算选择改为增量 token 统计，避免 O(n²) 重算

**证据**：`team-v14-context-delivery.mjs:209-220` 为每个 source 重新 hash/计算 prepared stats；`team-v14-context-delivery.mjs:255-266` 的 `renderStats([...items, source])` 每加入一个 source 都重新遍历全部已选内容。Room、requirements、inbox 和 memo 合并后，source 数增长会把预算组装放大为二次复杂度。

**收益假设**：用每个 source 的预计算行/债务 token stats，加上当前累计值和 manifest 增量，能把构造成本从 O(n²) 降到 O(n)；同时保持同样的 required/safetyCritical/debt 选择顺序。这样优化的是 CPU/GC 和等待，不改变实际上下文语义。

**验证建议**：构造 32、128、512、2000 个 source 的等价 fixture，比较 `buildContextDelivery` 的 p50/p95、分配量和结果 hash；检查 required source、budget 边界、Unicode tokenStats、changed revision 与 failClosed 输出逐项一致。将 limit/分页和权限过滤放在增量计算之前。

### 5. P1：停止每个 pre-step 对完整 inbox 做线性扫描

**证据**：当前 `team-v12-runtime.mjs:3126-3133` 在每个 `agent/pre-step` 对 `Object.values(doc.inbox)` 全量遍历，再按 target/status/native id 过滤。历史审计记录过单个 inbox 达 1324 条、同一批消息重复注入 20 次（`agent-team-scheduling-memory-ptc-audit-20260925.md:58-62`）；即使新 receipt 去重正确，扫描成本仍随历史 inbox 增长。

**收益假设**：维护 target→queued/unhandled 索引或利用持久 cursor 只读取自上次 receipt 后的增量，可把每步成本从 O(全部 inbox) 降到 O(本成员新增/未处理条数)，并减少重复字符串构造。索引必须由同一 control-plane mutation 更新，不能让内存索引成为事实源。

**验证建议**：用 0/1k/10k inbox fixture 比较 pre-step 组装耗时、分配量和注入 body hash；并发 ack、重启/HMR、legacy wake 重水合、跨成员权限过滤后检查索引与全量重建一致。发生索引缺失时回退一次有界全量重建并记录原因。

### 6. P1：compaction shadow 的 debt 更新避免每次 idle 同步写盘

**证据**：`team-v13-compaction-shadow.mjs:46-91` 的 `debtForSession()` 每次计算都调用 `updateDurableJsonSync`，并在 `:72-79` 写入新的 `updatedAt`；`evaluateTimeline():249-285` 即使后续 fingerprint 判定 duplicate，也先完成 debt 写入。durable store `team-v14-durable-store.mjs:152-169` 每次更新都会加 revision、加锁、fsync 和原子 rename。

**收益假设**：当 timeline 的最后 request/compaction seq 未变化时只读/复用 debt；只有新 seq、真实 compaction 或 debt 数值变化时才提交。可显著降低 idle 事件下的锁竞争和同步 fsync，同时保留 crash-safe 的最后一次已处理 seq。

**验证建议**：重复同一 session/timeline 100 次，断言 durable revision、write/fsync 次数只增加一次或按变化增加；追加 request、compaction、跨进程并发更新后验证 debt、lastProcessedRequestSeq 和 telemetry 不丢。强制压力/milestone 路径必须继续独立工作。

### 7. P2：为 operationId 与操作回执增加有界生命周期（本轮暂不实施，先定归档语义）

**证据**：`team-efficiency-validation.md` 的 Remaining limits 明确指出 durable operation keys 当前没有 TTL；staging `team-message-operation.mjs:2-46` 只维护进程内 active gate，持久查找/更新由 control plane 完成，未定义 completed/partial-failed 回执的归档或压缩边界。implementation-plan 要求将操作键用于幂等，但没有生命周期条款。

**收益假设**：长驻 Team 中 operation receipt 若永久保留，会增加热状态、快照复制和查询成本；按 task/episode 完成、外部回执确认和保留期分层归档，可控制状态体积，同时保留冲突审计。不能简单按时间删除，否则迟到重试可能穿透幂等保护。

**验证建议**：先定义 completed/partial-failed/externally-unconfirmed 的保留状态机和人工恢复入口，再测 10 万 operation keys 的热快照、查询 p95、冷引用和 GC 可达性。验证归档后旧 key 的重放返回 `expired/superseded`，payload 变化仍拒绝；没有语义前不做自动删除。

### 8. P2：清理 Reducer 的重复配置挂载并补生产质量闸门（本轮已做配置 lint，质量闸门仍后续）

**证据**：`home/profiles/web/cordis.patch.yml:241-265` 在 insert 中挂载 `evidence-reducer`，同文件 `:1373-1396` 和 `:1401-1424` 又出现两个同 id 的设置覆盖行；`agent-team-v13-implementation-ledger.md:42,125` 对默认状态分别写过 `enabled:false` 与当前配置 `enabled:true`。`evidence-reducer.mjs:53-75` 默认配置虽有上限，但重复实例/覆盖顺序是否只产生一份 listener 没有静态门禁。真实 telemetry 仍不能证明生产 reducer receipt 的质量闭环。

**收益假设**：唯一配置来源和重复 id lint 能避免双 listener、设置覆盖顺序不确定及一次日志多次归档；质量闸门则把 `archive -> reducer -> receipt -> evidence registration -> recall` 视为完整链路，未通过时保持原文，不把离线 A/B 直接外推为生产收益。

**本轮结果**：`tools/reducer-settings-lint.mjs` 已对 web/headless/teamtest patch、Reducer insert/override、UI mount、临时 probe 和 JSON 镜像做检查；web 现在只有一个可编辑 override，最终 enabled/route/allowlist/阈值可解释。生产仍保持远程拒绝和受控 allowlist；质量闸门（archive -> reducer -> receipt -> evidence registration -> recall）仍需真实长日志样本。

## 建议顺序

1. 先完成第 1、2 项的真实 schema/usage 证据，否则无法解释后续效率数据。
2. 在不触碰活跃 Team 的隔离 staging 中实施第 3、4、5、6 项，并跑 CPU/锁等待/结果等价回归。
3. 为第 7、8 项补生命周期和配置语义后再决定是否部署；不要用清理历史数据或重启替代证据。

## 本轮边界

本复核没有修改源码或配置；所有“建议本轮实施”仅指可在隔离 staging 中做实现与验证，不表示已加载到 PID `16440`。真实 CLM 实验仍应使用显式 PTC preset；standard preset 未按协议调用 `context_manage` 的结果不能当作 CLM 功能失败。任何 provider usage 字段若没有原始 wire 证据，最终报告必须保持 unknown。
