# Handoff: DSH 统一上下文运行时与交付门禁

> 历史材料（2026-10-12 标注）：最新交接是 [CLAUDE-HANDOFF-20261011.md](CLAUDE-HANDOFF-20261011.md)，当前状态入口是 [docs/CURRENT_STATE.md](../CURRENT_STATE.md)。

更新时间：2026-10-06 01:31，Asia/Singapore。面向没有本聊天历史的 Claude。本文件是交接快照，后续持续登记仍用既有 execution-ledger.md，不另建施工台账。

## Status

- 用户最新要求：周额度只剩约 5%，快速做完当前一步、整理交接，让 Claude 接手。已停止扩项；不要把旧“持续执行、不发阶段 final”要求理解为 Codex 必须继续耗额度。
- 整体目标 **partial，未完成**，不能标 complete，也不能宣称生产接受。当前一步“普通非 Team、无 goal 会话的真实隔离宿主交付闭环”已通过，浏览器验证不在本次完成范围。
- Completed：真实原生循环消费输入后执行官方 PTC；计划注册、实现证明、真实 bash 测试证明、preview、commit 和 source-stale 检查全部通过。交付状态 partial -> accepted -> partial。
- 本步使用本地 fake adapter，不是 DS4.1F 模型质量实验：13 个本地采样流、0 外部模型请求、0 agent error、7 条输入全部消费、13 条原生工具副作用事件、0 unknown effect；无 Team、无 goal。
- 最后独立 JSONL 冷回读确认上述事件与状态；对应原生聚焦测试 6/6 通过。未重跑 1200 项全量，未部署、未 HMR、未重启业务实例。
- 当前没有需等待的 shell/cell/子代理；本步隔离宿主已 dispose，40124 无监听。没有新建 Claude/Codex 聊天，也没有向第三方发送材料。

## Key Decisions

1. 实际项目不是聊天 cwd。施工源在 `D:/dsh-test/staging/context-runtime-unified-20261001`，计划/台账在 `D:/dsh-test/docs/context-runtime-unified-20261001`。聊天 cwd `C:/Users/<user>/Documents/Codex/2026-09-14/d-dsh-docs` 只是旧调查材料，不能从那里重新扫描猜任务。
2. 不重启 DSH，不中断/杀死 active Team/member，不改 RustMc 产品仓，不清理 sessions/journal/telemetry/spill/usage/历史实验。不要修改 Codex 自身 JSONL/SQLite。
3. 不全局启用 W1/W2/W3、Reducer、opportunistic compaction 或 async PTC；经济策略默认 shadow。async PTC 只有真实需求证据才实施/启用。
4. 所有写入先核实真实物理路径与 junction，备份、hash，再改 staging。desktop/teamtest 可指向 web；headless 可能独立。`D:/dsh-test/app` 及 `D:/dsh-test/home` 是现有运行面，不能把 staging junction 当物理隔离。
5. 保留所有失败实验；不清 inbox、不绕过 debt/plan/authority/源码证书门禁、不把缺字段记零、不改 skip 洗绿。
6. 成本和 cacheWrite/reasoning 未提供则 unknown；bytes 不是 tokens。root 加全部后代才是 Team 总量，不外推单 fixture 为节省率。
7. 后续恢复先读本文，然后按需要读台账末尾和规范对应节，不再列全部聊天或倾倒完整工具输出。测试默认用安静 runner。

## 当前一步的根因与修复

文件：`D:/dsh-test/staging/context-runtime-unified-20261001/tools/session-delivery-lab.mjs`。

旧夹具在 pre-step 手工执行 run_code 后 reject；native inbox 的 claim 只是保留式认领，只有后续 canonical user/message 才消费输入。因此 commit 看见 pending-input，正确拒绝。仅改成 next() 仍无效：工具执行发生在输入消费之前；将预算从 1 改 3 也遗漏后续动作，后续 fake 请求实际抛 budget error。旧窗口的“只是断言失败/输入问题已修”描述不完整，以这里为准。

最终去掉 pre-step 手工工具执行与 beginSampling。fake adapter 返回正规 tool-call-delta，原生循环先持久消费输入，再执行官方 run_code -> tools.session_delivery，再处理真实 tool result。每个工具 turn 需要 proposal+terminal 两个流；6 个动作加 1 个文本检查精确为 13，硬预算为 13。新增 agentErrors、空 inbox、请求数和 0 external 断言；不更改交付模块的门禁。

前序仅限夹具的修复还包括：隔离 overlay 禁用 context-workspace 以解除 HOST_PENDING；Windows recipe 用 `& '...node.exe' oracle.cjs`，旧写法导致 PowerShell ParserError。沙箱仍报告 partial，不冒称完整文件隔离。启动的 session-telemetry-otel import warning 仍保留，未为此扩项。

## Changed Files

- `D:/dsh-test/staging/context-runtime-unified-20261001/tools/session-delivery-lab.mjs`：上述最终夹具修复；SHA256 `4A1A048F1A468838F6BBE0294635791F5C279C8E432BD02B6EB822B1B1F371D0`。
- `D:/dsh-test/staging/context-runtime-unified-20261001/tools-change-manifest.json`：仅登记该新工具 before=null/after=上述 hash；没有批量刷新已有源码漂移。
- `D:/dsh-test/docs/context-runtime-unified-20261001/execution-ledger.md`：追加交接检查点。
- `D:/dsh-test/staging/context-runtime-unified-20261001/work-context-checkpoint-20261005.md`：更新为本交接/唯一台账入口，避免恢复到旧失败步骤。
- 本交接文件。没有修改运行时业务源码、生产配置或产品仓。

备份：`D:/dsh-test/backups/context-runtime-session-delivery-lab-20261006-handoff/session-delivery-lab.before.mjs`，SHA256 `A10E48083CC700659752C626144E086EFA7B3FCAF4083D8291E576420FBCF6EC`；同目录 `tools-change-manifest.before.json`。备份是修改前的未通过夹具，不是可宣称通过的生产回滚点。更早完整历史备份路径见台账，禁止用这个小备份覆盖全部 staging。

## 验证证据

成功 run 目录：`D:/dsh-test/staging/context-runtime-unified-20261001/lab-runs/session-delivery-277b7a99-7183-4d91-8df4-6485f3977fd1`。
原生 session：`15ee8a08-dc84-4c7d-9338-7aa18c7670c4`。证据文件是目录内 `evidence.json`，SHA256 `034AEBF51BB5DE6CEC522F705BBEDF3B2A75BC31B8671BB4AD10C06F7218E559`；sessions 子目录保留实际 zstd JSONL。

| 证据 | 结果 / SHA256 |
| --- | --- |
| `D:/dsh-test/output/context-runtime-session-delivery-r13-20261006.log` | exit 0；`FC408931C00058314BB3EC63CD4E2A8B76FC7B175A8AA44A01775FA6278E4FDC` |
| `D:/dsh-test/output/context-runtime-session-delivery-focused-handoff-20261006.log` | 6 tests/6 pass/0 fail/0 skip；`169AF563CDFFD28D6BE6FEA19380FCB3DC200E664561CF04C789FFCA211B9C24` |
| `D:/dsh-test/output/context-runtime-session-delivery-cold-handoff-20261006.log` | 独立 Jsonl.open/read，7 accepted/0 unconsumed、13 effects/0 unknown；`FB9AA93C5FC713F741483197DC19DD31844CDE001C65CB647F7D410545C239BE` |

冷回读中 accepted 在 seq100/109，source 修改后 partial 在 seq119/128。控制面 receipts 仍保留旧接受记录，但当前 status 正确判 stale。成功日志中的 `DELIVERY_UI_*` 只是既有标记名称，**本次没有打开浏览器**。

精确执行入口（已运行；不要为接手重复成功实验）：

```powershell
Set-Location -LiteralPath 'D:\dsh-test\staging\context-runtime-unified-20261001'
$env:DSH_LAB_CANONICAL_MODULES='1'
$env:DSH_HOME='D:\dsh-test\staging\context-runtime-unified-20261001\lab-host-home'
node --check .\tools\session-delivery-lab.mjs
node --preserve-symlinks --preserve-symlinks-main --import ./tools/prepare-unified-lab-host.mjs ./tools/session-delivery-lab.mjs
node --preserve-symlinks --preserve-symlinks-main --import ./tools/prepare-unified-lab-host.mjs --test --test-reporter=spec native-tests/session-plan-delivery.test.mjs
```

真实冷读使用 `@deepseek-ai/dsh-session-persistence-jsonl` 的 Jsonl(ctx,{root:run+'/sessions',compression:'zstd'}).open(sessionId,'read')，核对 events 后 close/dispose。不能只读 evidence.json 代替原日志核验。

## Next Steps

- [ ] **P1 首先补浏览器消费面**：复用本工具 `--ui`，真实浏览器观察 partial/accepted/stale 三态及重载。宿主等待 run 目录的 `accept.txt`、`stale.txt`、`browser-closed.txt`（每段 300 秒）；截图后写相应 marker 才推进。新 run 隔离且只用 fake adapter，无需真实 provider。`--replay <上述run目录>` 只能重放最终 stale 状态并等待 `browser-replay-closed.txt`，不能冒称看过 accepted 状态。
- [ ] **P1 源码清单与 profile 收尾**：逐项审阅下述已知漂移/新增模块，补 before 备份、四 profile parity 和适用测试，再更新证书/manifest；不可只改哈希让门禁过。
- [ ] **P1 当前全量**：使用 `node tools/run-regression.mjs`，聚焦用 `node tools/run-regression.mjs --files <精确.test.mjs...>`。完整输出仅在 output/regressions/.../full.log，读取 summary.json，不倾倒 1200 行。先确认本 shell 不遗留错误 DSH_HOME；不要覆盖调用者环境。
- [ ] **P2 完整规范覆盖**：common 身份动态语义、合法验证复用、缺摘要字段造成的 debt 自然拒绝、Instant/W2/compaction 联动和完整有界 A/B 仍需逐条对照规范与历史证据。成功的自然摘要/family实验不重复跑，只针对新缺口或源码失效点。
- [ ] **最终运行面交付**：安全同步/加载仅在不会中断活跃任务的前提下做；disk SHA、真实 loaded module/config、下一真实安全请求的 consumed receipt 分开验证。HMR 不安全就登记 pending，不重启。
- [ ] 登记 canonical `v12Evidence.records` 并实际 read-back，更新当前完整 plan coverage/启用矩阵/回滚说明，向原 DSH root 回报；当前没有完成这些。原 DSH root 的精确会话 ID/路由在既有台账查验，不能把 Codex thread ID 当 DSH session ID。

## Unresolved Questions / 已知缺口

2026-10-06 本次现场核对，登记 lab 前原 85 条 manifest 有 **4 个 drift**（原 expected/actual 全值在 cold-handoff 日志）：

- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session/lib/index.js`
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
- `D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`
- `D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v12-runtime.mjs`

这些是既有非 Team/UI 工作未收尾，未在本步改写。lab 登记后总数应为 86，4 个既有 drift 必须仍显式保留。

headless 当前缺 `session-plan-delivery.mjs` 和 `team-v15-delivery-presentation.mjs`，headless 的 team-v12-runtime 仍为旧 manifest SHA `635AD1CD...`，web 为 `64F87F22...`；desktop/teamtest 的这三份文件都实际链接到 web，不能四份重复写。两份新模块还需登记 plugin manifest；不能声称四 profile 已同步。

最新记录的全量（不是本步重跑）：213 入口，1220 tests/1216 pass/3 fail/1 skip，目录 `D:/dsh-test/output/regressions/2026-10-05T12-16-02-600Z-88219a3e`。两个 subagent actual 因 `LAB_NATIVE_SURFACE_SOURCE_DRIFT` 被严格门禁拒绝；另一个 B-96 是 runner 覆盖 DSH_HOME，之后仅聚焦 8/8 修复通过。当前未有新全量全绿，不用更旧 r13 的 1178/1179 结果代替。

生产历史风险：2026-10-04 staging UI junction 曾误写生产两文件，已按备份恢复且磁盘 hash 一致；运行中进程是否曾缓存改变未知。详见 execution-ledger 08:31 记录。本次没有生产写入，不代表历史从未发生。

## Context Entry Points

- 总需求：融合 Fork v2、Instant Interrupt、prompt-memory-audit、native-ptc-compaction 四主文档（v1 仅参考），先修 P1-01..06/P2 身份/收敛/复用及摘要契约，再完成 W0/W1/W2、经济 shadow、Instant 和按需 async PTC；备份、四 profile、离线回归、真实有界 opencodego DS4.1F A/B、root+后代 usage、运行面/evidence/完整 plan coverage 缺一不可。
- 统一规范：`D:/dsh-test/docs/context-runtime-unified-20261001/implementation-plan.md`。顶部历史更新/第16节表有过时状态，以台账最新检查点和本次 evidence 为准，不按旧 pending 标签重做已验工作。
- 唯一施工台账：`D:/dsh-test/docs/context-runtime-unified-20261001/execution-ledger.md`。
- 主审计：`D:/dsh-test/docs/prompt-memory-audit-20261001.md`；`D:/dsh-test/docs/native-ptc-compaction-ds41f-audit-20261001.md`。
- 外部设计：`C:/Users/<user>/Downloads/DSH_Codex三项能力实施设计_当前Fork实装版_v2.md`；`C:/Users/<user>/Downloads/Codex_Instant_Interrupt_机制与Agent实现设计.md`；v1 `C:/Users/<user>/Downloads/DSH_Codex三项能力实施设计_基于PTC与Session架构.md`。
- 重要已完成历史证据：`D:/dsh-test/docs/context-runtime-unified-20261001/native-compaction-quality-AB-20261004.md`（三次官方摘要/同根恢复/基线，root-only且含失败恢复成本）；`D:/dsh-test/docs/context-runtime-unified-20261001/team-family-identity-usage-20261005.md`（四角色8请求、236649 tokens、独立回读，非成本 A/B）。
- 原生写入边界：`D:/dsh-test/docs/context-runtime-unified-20261001/writer-boundary-decision-20261002.md`；测试输出说明 `D:/dsh-test/docs/context-runtime-unified-20261001/test-output.md`。
- 清单：staging 根的 `native-change-manifest.json`、`plugin-change-manifest.json`、`tools-change-manifest.json`。加载入口 `D:/dsh-test/staging/context-runtime-unified-20261001/tools/prepare-unified-lab-host.mjs`；严格证明 `D:/dsh-test/staging/context-runtime-unified-20261001/tools/window-protocol-trial.mjs`。剩余 junction 可能指生产，写前逐一 realpath。
- Codex 原线程：`01a0f2b6-3a3f-7eb2-909b-8c0b66f03cf9`。交接不依赖该聊天可读；没有 PR/commit 基线可假设。
- 旧自动续跑 `15-41-dsh` 的 automation.toml 本次核实不存在，没有新建续跑；Codex 整体 goal 将按交接请求暂停，不标完成。

原始实验日志可能包含已经退出的本地 web token。交接文档不含密钥；不要原样上传日志、环境或 provider 凭据。若以后确需真实 provider，先核实当前配置，仅进程环境注入，事先给每个 case 请求数/时间/输出上限，禁止复用 active RustMc 会话。
