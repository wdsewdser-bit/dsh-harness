# W2 Writer Boundary Decision

2026-10-02，北京时间。Oracle（Astra/high）只读核对真实源码后，根代理选择以下路线。本文是接口决策，不是已启用证明；执行状态仅登记在 execution-ledger.md。

## 决策

采用 CP durable active identity、原生 host 生命周期参与门禁和实际 loaded config 单调代次的混合路线。配置消费者包括 AgentLoop options、global/scoped persona 和 SystemPrompt sections；仅将 resolved config 复制进 CP 会产生第二套配置权威，不能覆盖这些真实入口。

身份完整五文件及 manifest 校验后，通过 CP 原子激活为 immutable bundle。普通磁盘编辑只是提案，不能由 identitySource 每 step 自动生效。实际 next-turn 消费 active bundle；安全撤销先设置 admission veto，再等待正常激活/持久操作，失败保留 veto。

## 参与边界

固定顺序：host read lease、CP fence、native Session writer。host gate 的 owner 不被 HMR 替换，host epoch 和 instance token 防止 A→B→A 与旧 callback 的 ABA。

Loader 更新 options、dispose、volatile config 及 Cordis Fiber._config 修改之前必须取得 lifecycle writer；后置 internal/update 或 partial-dispose hook 不够。异步安装从 setup 开始到失败清理/effect 注册结束一直标记 pending。直接 registry delete、global/scoped SystemPrompt 注册和 tool registry 有效变更也属于 writer。同步入口遇 transition lease 应在任何副作用前拒绝，不先改再等待。

W2 commit、下一 sampling、每次 retry 和 tool admission 都重新核对 host/identity/config epochs 与 revoke veto。不能只检查 native generation。

## 持久与旁路

CP 原公开 persistControlPlaneSnapshot/Async 绕过 service lock；其 raw implementation 应改为 owner capability 私有入口。外部公开合作 writer 须同 file lock 和 expected revision，初始化、迁移、恢复也参与；内部已持锁调用不得重入死锁。

CP 旧写入链仅 write+rename，未 fsync。root 已开始补文件数据同步及失败测试，但新增测试不证明全部参与边界收口。冷引用和主快照必须在成功回执前同步；Windows 目录元数据同步不可移植，须区分进程崩溃屏障与掉电保证，不用 readback 替代后者。

同权限不受控外部文件替换不会服从软件锁。证书只覆盖受控 writer；如需抵抗该部署威胁，要独立 owner/OS 权限隔离，或明确拒绝该环境，不能删除 blocker 冒充安全。

## 真实验收

- 五角色 activation、磁盘改动不自动生效、activation/W2 竞争的唯一顺序与 epoch ABA。
- 实际 Loader/Cordis 的 update/remove/volatile/direct Fiber update/registry delete/global 与 scoped persona，在 commit 前不能先改状态。
- 双 Team 并行 W2，加第三个异步安装、旧 HMR callback；无死锁、半安装证书或旧 owner 复活。
- direct persist sync/async、合作跨进程写入、初始化与恢复竞争；锁外 raw writer 被拒。
- CP/JSONL 每个同步失败和进程崩溃；恢复只认 native journal 的单事件 commit authority。
- revoke/commit/retry/tool races，无撤销后 successor，pending 输入按原序保留。

## 证据入口

源码依据为 staging team-v14-context-delivery.identitySource、team-v12-runtime.install、team-control-plane 持久与锁 API，以及原生 AgentLoop.systemPrompt.assemble、Cordis Fiber.update/Registry.delete、Loader.update、dsh-system-prompt 与 dsh-persona 的 section 注册。行号会随施工变化，按上述符号定位。

原参与包日志 D:/dsh-test/output/window-instant-participation-focused-20261002.log 为 77/77；它证明当前 CP/Session/Inbox/ToolRuntime 接线，不证明本文新增 identity/lifecycle/durability 项已通过。Oracle 未修改源码、未执行额外测试、未 RPC/provider 或生产操作。

## 附：effect disposer 延迟释放例外（2026-10-06）

起因：隔离 lab 带浏览器连接收尾时，gateway 的 `done.then(() => release())` 在 writer 持有期间同步抛 HOST_WRITER_BUSY，成为 unhandledRejection 并 exit 1。实现在 stage 的 cordis-v15（host-lifecycle.js `runRelease`，index.js effect 的两个 disposer 包装）。
- 精确语义：无阻塞或调用者继承当前 writer token 时与 runSync 相同；仅被 writer 阻塞且调用者不是 token 持有者时，disposer 排队到 writer 释放后再执行，同步返回 undefined（fire-and-forget，不返回依赖 writer 释放的 promise，否则 writer 内等待该返回值的流程会互等，例如 agent-loop 的 `await unfollowOwner()` 被 host dispose 的 writer 反向等待）；存在 read lease 时仍同步抛 HOST_WRITER_BUSY，不改动。
- 排队期间 gate 被 close 则静默放弃（只吞 HOST_CLOSED）；已 close 后调用仍同步抛 HOST_CLOSED；disposer 自身错误交给包装传入的 onError（`ctx.logger.error`），不吞；无 onError 的直接 gate 调用则成为 unhandledRejection。排队释放的完成只能通过 writer/gate 回到 idle 观察。
- 不破坏“副作用前拒绝”：延迟发生在任何副作用之前，只是等待而非先改后等；`runner.epoch` 在执行时才检查，重复调用或所属 fiber 已被级联 dispose 时，延迟的调用是 no-op，epoch/ABA 与 instance token 不变。
- 残余风险：read lease 窗口（window transition、W2 fence）内外部 disposer 仍同步抛；生产 `dsh-api-gateway` 的 `done.then(() => release())` 无 rejection handler，部署 v15 gate 且启用 W2 前必须处理。
- 2026-10-06 更新（Claude）：上一条残余风险的前半已处理。`runRelease` 现在在“无 writer 且无 read lease”之外的非持有者调用一律排队，read lease 全部释放后才执行；lease 期间不产生任何副作用，返回值与错误语义同 writer 情形。`host-lifecycle-disposer-race.test.mjs` 原“read lease 下同步抛”的用例改为延迟语义，并新增连接结束回调与多 lease 两个用例（改前 3 红）。生产 gateway 的无 handler 回调不再因 gate 抛错，但它自身仍无 rejection handler，这点未变。
