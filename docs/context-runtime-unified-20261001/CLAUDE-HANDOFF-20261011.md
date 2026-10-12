# Handoff: DSH 上下文、交付门禁与 Instant/PTC 后台执行

交接时间：2026-10-11 20:20 America/Los_Angeles。接手者：Claude。用户当前要求只写交接，不启动 Claude、不继续施工。

## Status

- Completed：多段窗口 + R、权威基线投递回读及消费层修复已部署到生产文件。原根的隔离副本通过真实折叠、冷恢复、页面历史加载和 opencodego 后继回合；原生产根没有折叠。详见下面的窗口报告。
- Completed：Strict 空计划门禁在 staging 闭合。显式 `requirePlan` 后空注册集不能交付，持久 strict 标记不能被配置降级或缺插件绕过，真实普通会话 UI 已验证 partial/accepted/源变化后 partial。这个新包未生产部署或启用。
- Completed：Instant + 同实例 PTC 后台包在 staging 闭合。新消息先处理，原程序和已启动工具继续，不取消后重跑；晚结果可耐久收取。16 项运行时测试、真实 Web UI、原生 Team 邮箱 + 一个真实子会话均通过。LLM 使用 fixture adapter，不是外部模型。这个新包未生产部署或启用。
- Completed：当前全量 230 文件 / 1485 tests / 1484 pass / 0 fail / 0 cancelled / 1 existing skip；共享聚焦 70/70。清单、headless 和 pin 已同步；隔离 evidence record 已持久登记并由新进程回读。
- In progress：接手后按优先级补实际交互审批、真实 provider 行为质量及独立安全/并发审查，再按授权准备生产 opt-in。整个 E0-E8 项目仍是 partial，不能写成全部完成。
- Blocked / limitations：旧 Codex 子代理曾换窗丢任务，后续不再派发；不能据此伪称独立审查已取得。真实 provider 与交互审批的验收仍缺，不是已确认代码失败。
- 交接前只读复核：`stage-closeout --check` pending=0；最新 full summary complete/success 均为 true。40123/40124 无监听；8788 有监听、PID 36508，只证明代理进程在，不证明 provider 可用。没有待接续 exec/cell 或本任务浏览器。

## Key Decisions

- 工作根是 `D:/dsh-test`，施工根是 `D:/dsh-test/staging/context-runtime-unified-20261001`。唯一持续台账是 `D:/dsh-test/docs/context-runtime-unified-20261001/execution-ledger.md`；从最后检查点读起，旧的“full running / 尚未登记”已被最后的验收收口覆盖。
- 当前 Codex 聊天 ID 是 `01a0f2b6-3a3f-7eb2-909b-8c0b66f03cf9`，但接手不依赖访问聊天历史。旧 `CLAUDE-HANDOFF-20261006.md` 是历史材料，不是最新状态入口。
- 只继续已授权范围：不碰 RustMc、其他生产 Team/原根，不清理 session、cold refs、备份或 telemetry，不提交代码，不启动原生产宿主，不扩大 `team-roots`。以前的多段部署授权不能被解释为新 Strict/PTC 包自动生产开启。
- 生产窗口最后确认是 `scope: list / spanMode: multiple`，只包含 `session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a`；接手要重新只读核对配置，不能恢复旧 workspace 白名单或全面开启。
- 上次原生产启动自动恢复了测试 child `session-2fa0b66c-fba4-4253-b87d-8e5426fb0b7a` 的日志，守护因此停机。不要放宽 guard 重试，也不要声称历史上完全没有其他会话写入。后来的验证改用隔离副本。
- PTC 复用 `LocalJobRegistry` 和原 `NodePtcRuntime.run` promise。前台等待权与执行生命周期分离；旧 generation 不能启动后续副作用，已经启动的结果必须对账。不能复制执行器/SDK、重新提交原 program 或用模型 polling 伪装异步。
- `runController` 在正常 finally 中也会 abort，不能凭 signal.aborted 判用户取消。显式取消单独记录；timeout 按结构化 failureKind 分类。
- 结果文件 fsync、rename、SHA 回读后才写终态与通知。崩溃发生在文件已落盘但终态未入账时，原文件只是未提交证据，恢复另建 `.unknown.json`，不覆盖、不认成功、不重跑。
- Cordis 服务方法有 caller-context 绑定；后台服务用保存的 `hostCtx` 访问自身宿主依赖。无既有 bridge 时必须取得实际 JSONL owner barrier，不能把 `sessions.flush()` 的 undefined 当耐久成功。
- 显式 JobCancel/owner teardown 会 abort 原 PTC runtime，但已开始的子工具会 drain 并逐项留回执；不承诺 non-cooperative 子工具瞬停。通知重复/失败重放不等于重跑程序；大结果保持完整 artifact，收取只返回小回执。
- full regression 与实际 lab host 共用 `lab-host-home`，必须串行。此前并行曾产生 HOST_WRITER_BUSY，不是通过证据。合格验收不重复跑；新代码或具体缺口才补相应验证。
- Claude 遵循用户现有 Claude 配置，不为了交接改全局模型、缓存、供应商或权限策略。普通确定性工作可 Haiku 优先，高风险审查由适合的独立执行者承担；不要复用已丢任务的 Codex 代理。

## Changed Files

以下均为 staging 的当前实现，完整 before/after 见三个清单，不要按本列表覆盖整包：

- `D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-ptc-background.mjs`：新增 exact-session opt-in 后台服务、原实例 job ownership、结果/通知/收取/恢复。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js`：PTC 可选后台接线、原 generation admission、结构化 failureKind。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-tools/lib/types/ptc.js` 和 `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-tools/lib/types/ptc.d.ts`：独立 JS/type 表面与 bundled 实现一致。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session/lib/native-bridge.js`：受信 input preemption、耐久发布后通知、待收取 job 阻止 writer。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session/lib/index.js`：新增已知 native job event。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`：job 生命周期、精确 detach/通知/收取关系；只允许已开始子调用晚结算。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`：严格 native marker/status schema，不放宽未知事件。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-goal/lib/index.js`：strict requirement 和后台未收取 debt 阻止完成。
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`：明确展示 missing-plan/background-pending partial 状态。
- `D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-delivery-service.mjs`、`D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-delivery-presentation.mjs`、`D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/session-plan-delivery.mjs`、`D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v12-runtime.mjs`：strict/debt 联动；同名 headless 副本已同步。
- `D:/dsh-test/staging/context-runtime-unified-20261001/native-tests/ptc-background-runtime.test.mjs`：16 项实际执行器/JSONL 测试，只有 LLM adapter 与受控工具延迟是 fixture。
- `D:/dsh-test/staging/context-runtime-unified-20261001/tools/ptc-background-lab.mjs`：真实 Web/官方 PTC/UI 验收工具。
- `D:/dsh-test/staging/context-runtime-unified-20261001/tools/ptc-background-team-lab.mjs`：真实 Team/一 child 邮箱验收工具，不是 membership 桩。

## Next Steps

- [ ] P0：读下面的最新报告、acceptance 和台账末尾；核对真实物理路径/清单/hash/当前服务，不新列整个仓库或重跑已完成实验。
- [ ] P1：在新隔离 HOME/session 中补交互 approval handoff：已经等待审批或审批后旧 generation 的工具不能越权启动；拒绝/批准/用户转向/取消/owner teardown 都要有真实 canonical 回执，不用假成功替代。
- [ ] P1：针对 exact ownership、stale generation、跨 turn journal、artifact scope、幂等通知/收取与恢复降级做必要独立审查。若发现实际反例，最小修复并补聚焦；不要把主控自审写成独审。
- [ ] P1：有界测试新 PTC 包的真实模型行为，不重跑已完成的旧 multi/window/provider 验收。历史授权 route 为 `opencodego/deepseek-v4.1-flash`、代理 `http://127.0.0.1:8788/v1`；先只读核实当前 route/auth，不能改全局协议或换供应商。保守沿用首批 16 provider requests、1000000 input、24000 output、并发 1、10 分钟上限；root+child 合并统计，unknown usage 不填 0。canonical 没执行、预算/认证/协议失败就停止并保存证据。
- [ ] P2：通过上述门槛后，先按现有授权准备可审查部署计划、精确 allowlist、备份/回滚与 reader 兼容；不擅自启用新生产 Strict/PTC，也不启动原生产 host。授权范围不足才向用户问这一具体边界。
- [ ] 每个新修改包更新同一台账和实施计划，记录真实启用维度、hash、测试、剩余项。证据用既有 registrar 登记到正确隔离/生产控制面并独立回读，不只写报告。

## Unresolved Questions

- 真实模型收到后台 running handle/完成通知时能否可靠收取并遵守原约束，尚未由当前 fixture 证明；不得声称已测真实 provider。
- 实际交互审批、独立安全审查和新包生产 opt-in 未完成。整个 E0-E8 仍 partial；具体后续需对照计划各状态，不从旧“conditional/off 无需求”推断 J-01 无需实现。
- 本轮没有完整项目 typecheck 或生产 HMR 验收结论；JS syntax、实际 runtime、focused/full、Web/Team 消费面的证据是分开记录的。
- 未来启用后不能删 native readers、markers、pending jobs 或 artifacts 来回滚。先禁止新 opt-in，drain/reconcile 原有工作，保留证据，再准备有边界的 rollback。

## Context Entry Points

- Original request：继续按优先级完成 DSH 整体工作；完整计划不能只做部分后宣称交付；用户明确要求减少 Team 消息延迟，同一已启动 PTC 实例转后台，不许取消后重跑。
- Related issue/PR：本任务没有新 PR 或 commit；不要擅自创建/提交。
- Plan file：`D:/dsh-test/docs/context-runtime-unified-20261001/implementation-plan.md`。优先看 J-01、E6/E7 和验收边界。
- Ledger：`D:/dsh-test/docs/context-runtime-unified-20261001/execution-ledger.md`，最后的“Scoped PTC 施工验收收口”覆盖之前运行中状态。
- Review/acceptance reports：`D:/dsh-test/docs/context-runtime-unified-20261001/ptc-background-20261011.md`；`D:/dsh-test/docs/context-runtime-unified-20261001/strict-plan-delivery-20261011.md`；`D:/dsh-test/docs/context-runtime-unified-20261001/window-multi-acceptance-20261011.md`。PTC 包没有独立 security review 报告。
- Machine acceptance：`D:/dsh-test/output/ptc-background-20261011/acceptance.json`。sourceHash=`e963d7b04a01c88c2f6d3b467f35a475983a0d4bb8108c484f3254fb1e079535`；fixtureHash=`50a63c8c963d4e83983c66af51ff58a0149a8780d9118b15b5e422519aae0a20`。
- Durable evidence：`D:/dsh-test/output/ptc-background-20261011/home/team-control-plane/default.json`，record=`ptc-background-20261011-e963d7b04a01c88c`，passed，独立 native snapshot 回读一致；这是隔离 default，不是生产登记。
- Logs：`D:/dsh-test/output/regressions/2026-10-11T23-06-35-454Z-c50589e2/summary.json`，同目录 full.log/process.log；聚焦 `D:/dsh-test/output/regressions/2026-10-11T22-58-55-235Z-7e3ae1f2/summary.json`；PTC16项 `D:/dsh-test/output/regressions/2026-10-11T22-57-04-821Z-de9f964c/summary.json`。
- Live fixture evidence：`D:/dsh-test/staging/context-runtime-unified-20261001/lab-runs/ptc-background-e3229be6-fae5-4d07-aadd-0ff900f556fe/evidence.json`；`D:/dsh-test/staging/context-runtime-unified-20261001/lab-runs/ptc-background-team-1360972d-e6a1-4f7b-9cce-eae3210cb0bb/evidence.json`。
- Screenshots：`D:/dsh-test/output/ptc-background-20261011-final-before-release.png`；`D:/dsh-test/output/ptc-background-20261011-final-after-collection.png`。
- Manifests：`D:/dsh-test/staging/context-runtime-unified-20261001/native-change-manifest.json`、`D:/dsh-test/staging/context-runtime-unified-20261001/plugin-change-manifest.json`、`D:/dsh-test/staging/context-runtime-unified-20261001/tools-change-manifest.json`。
- Backups：`D:/dsh-test/backups/context-runtime-ptc-background-20261011`、`D:/dsh-test/backups/context-runtime-ptc-background-closeout-20261011`；Strict 对应 `D:/dsh-test/backups/context-runtime-strict-plan-20261011` 和 `D:/dsh-test/backups/context-runtime-strict-plan-closeout-20261011`。先理解历史层次，不能恢复旧包时抹掉新 strict 修改。
- Deployment lineage：`D:/dsh-test/docs/context-runtime-unified-20261001/deploy-previous-chronological.txt`。未来部署要保持按时间顺序的 previous 清单，核对所有 canonical/.pnpm/profile 实体副本，不能只更新 hash 掩盖漂移。

### Test Commands

下列入口已实际执行通过；接手先读结果，不因交接重跑全套。仅新修改/具体缺口才执行：

```powershell
Set-Location D:/dsh-test/staging/context-runtime-unified-20261001
node tools/stage-closeout.mjs --check   # 写入模式自 2026-10-12 起必须带 --reason=<原因>
node tools/run-regression.mjs --files native-tests/ptc-background-runtime.test.mjs native-tests/session-plan-delivery.test.mjs phase11-tests/unified-team-delivery-gate.test.mjs phase11-tests/unified-delivery-authority.test.mjs native-tests/instant-window-compaction-race.test.mjs
node tools/run-regression.mjs
```

只有确需新宿主验收，且 full 未运行、端口未被占用时才串行执行：

```powershell
$env:DSH_HOME='D:/dsh-test/staging/context-runtime-unified-20261001/lab-host-home'
$env:DSH_LAB_CANONICAL_MODULES='1'
node --preserve-symlinks --preserve-symlinks-main --import ./tools/prepare-unified-lab-host.mjs tools/ptc-background-lab.mjs --ui
# 等该宿主和独立浏览器关闭后，才运行下一条。
node --preserve-symlinks --preserve-symlinks-main --import ./tools/prepare-unified-lab-host.mjs tools/ptc-background-team-lab.mjs
```

UI lab 在独立新目录中等控制 marker：输入 NEW_DIRECTION，Enter 排队后点 Steer queued message；确认回答先于原工具释放，再在它打印的 directory 创建 release.txt；验收和浏览器关闭后创建 browser-closed.txt，让 host 正常 dispose。不要向旧目录补 marker。Windows 现有浏览器是 msedge，不要因默认 Chromium 缺失去下载或改生产浏览器。

模型 fixture 必须通过真实 `tool-call-delta` 和官方 PTC 执行；不要在 `agent/pre-step` 直接执行工具冒充模型消费。native Team spawn 的 prompt 是 ContentBlock[]，返回值的 child ID 位于 roster.member.id。

### Scheduling

一次性 `claude-5h-haiku-say-hi` 和 `codex-dsh` 都已实际执行并暂停，attempted guard 已存在；不要重建或再刷 say hi。Claude 成功记录是 `C:/Users/<user>/Documents/Codex/2026-09-14/d-dsh-docs/outputs/claude-haiku-reset-20261011/result.json`；续工记录是 `C:/Users/<user>/Documents/Codex/2026-09-14/d-dsh-docs/outputs/codex-resume-20261011/result.json`。本交接不另设定时任务。
