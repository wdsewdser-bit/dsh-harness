# Agent Team v13 实施台账

> 状态：v13.1 R1–R12 已全部实现；phase10 45 项测试、phase1–9 95 项回归全部通过；D 已在运行中的 web profile 产生真实 shadow 遥测并完成短时 live 验收，未重启 DSH。
> 日期：2026-09-25
> 计划：`D:/dsh-test/docs/agent-team-v13-sol-pi-adaptation-plan.md`
> 备份：`D:/dsh-test/backup-v13-20260925-140123`

## 1. 已完成

### A. Action Fusion 多语言

新增 `home/profiles/{web,headless}/plugins/action-fusion-v2.mjs`：

- 语言感知的项目根：`Cargo.toml` / `tsconfig.json` / `package.json` / `pyproject.toml` / `go.mod` / `.git`。
- Rust：解析 crate 名，找到 `[workspace]` 根，执行 `cargo check --message-format short -p {crate}`。
- 占位符：`{file}`、`{dir}`、`{project}`、`{crate}`。
- `requireFile`：缺少项目标记时安静跳过。
- 内容哈希去重：相同文件内容不重复验证。
- `{crate}` 无法解析时跳过，不执行错误命令。

### B. ObservationPack v2

新增 `home/profiles/{web,headless}/plugins/observation-pack-v2.mjs`：

- 按 UTF-8 字节阈值（默认 10 KiB）。
- 内容寻址归档：`obs_<sha256前24>`，写入时校验已有对象。
- `llm/stream` 延迟投影：前 `fullSends`（默认 2）次请求保留全文，之后替换为 handle。
- handle 含头尾完整行摘录、错误证据行、归档绝对路径、原始字节/行数。
- 归档缺失、哈希/大小不符时 fail-open，保留原文。
- error 结果与 `sol_pi_evidence_receipt_v1` receipt 不打包。
- PTC 子调度日志立即归档替换（程序已拿到完整值，模型从未看到）。

### C. Evidence-Preserving Reducer 后端

新增 `home/profiles/{web,headless}/plugins/evidence-reducer.mjs`：

- 内容寻址归档长日志，receipt schema `version/summary/quotes/unresolved`。
- 每条 quote 必须命中对应源行的逐字内容；行号越界、摘要超长、版本不符均拒绝。
- 失败、超时、路由不允许、receipt 不可验证一律 fail-open，保留原文。
- 路由支持 `session`（读取该会话最新 `request/header` 的 provider/model）和显式 `{provider, model, effort?}`。
- 显式远程路由默认被 `remoteAllowed: false` 挡住；`session` 模式是显式 opt-in。
- 设置文件：`D:/dsh-test/home/evidence-reducer.json`（默认 `enabled: false`）。
- 已增加 volatile `Config` schema，Settings > Plugins 可编辑 reducer 开关、路由模式、provider/model/effort、阈值等字段。
- `/team reducer-route show|off|session|set <provider> <model> [effort]` 已接入 web 与 headless operator；命令同步 settings 和 `evidence-reducer.json`，运行实例按事件重读配置，不要求重启。
- 设置更新事件会把解析后的 settings section 镜像到 JSON 文件，保证设置页与命令使用同一运行时来源。

### D. 压缩经济判断（纯模块 + 离线回放）

新增 `home/profiles/{web,headless}/plugins/team-v13-compaction-economics.mjs`：

- 移植 SoL-Pi `estimateRemainingRequests` / `decideCompaction`。
- 支持 cache write/read 比价、窗口保护、首次压缩放大、后续压缩 margin、carried debt。
- 新增保守闸门：`minContextGrowthTokens`、`minRequestsSinceCompaction`。
- 缺少 cache 比价时输出 `cache_ratio_unavailable`，不静默套默认值。

新增 `tools/v13-compaction-replay.mjs`：

- 解码现有 `session.v4.jsonl.zstd`，重建逐请求 prompt 大小与 cache 份额。
- 边界来源：`turn/end`、`team_milestone done`、`team_task_update complete`。
- 离线回放经济判断，不调用 provider、不写会话、不触发压缩。

实测（5 个 MC 会话）：

- cache read 份额 95.0%–97.9%。
- 不提供 cache 比价时，974 个决策全部 `cache_ratio_unavailable`，符合 fail-safe 设计。
- 显式边界 + `cacheWriteReadRatio=12.5` + growth/cooldown 闸门时，229 个决策中 128 compact / 101 defer，原因分布 `economic` / `deferred_growth` / `deferred_cooldown`。

新增 `home/profiles/{web,headless}/plugins/team-v13-compaction-shadow.mjs`：

- 从 session journal 读取请求、边界和压缩事件，按 60 秒 TTL 缓存。
- 只评估 idle 边界；同一会话的相同请求/边界/原因/上下文桶不会重复计数。
- `opportunisticCompaction: off` 保持旧行为，`shadow` 只记遥测，`on` 才允许经济决策执行压缩。
- milestone 与 75% 压力路径完全绕过经济判断，行为不变。

`step-compaction-v4.mjs` 已把强制路径和机会路径分开：强制路径先判定，机会路径仅在未命中强制路径时运行。

### G/J. 机制激活遥测

新增 `home/profiles/{web,headless}/plugins/team-v13-mechanism-telemetry.mjs`：

- 每个机制独立 JSON 文件，避免共享锁。
- 记录 `fired`、`kinds`、`skipped`、最后事件与时间。
- skip 事件按 20 条缓冲写入，减少磁盘抖动。
- `dormantVerdict()` 用于把“已启用但从未触发”的机制标为休眠。

已接入：`action-fusion`、`observation-pack`、`evidence-reducer`。

运行态证据：

- `team-health-web.json` 已包含 `team-v13-compaction-economics.mjs`、`team-v13-compaction-shadow.mjs`、`team-v13-mechanism-telemetry.mjs`、`evidence-reducer.mjs`。
- `mechanism-telemetry-compaction-economics.json` 已由运行中的 web profile 写入；截至 2026-09-25 14:33，记录 4 次决策：2 次机会性 `would_compact`（旧键曾写作 `compacted`）、2 次 `deferred`，最后一次为 `economic`、上下文 326,837 tokens。
- `home/spill` 已出现运行态 observation-pack 归档文件，说明 ObservationPack v2 已实际处理大观察。

短时 live shadow 验收（2026-09-25 14:52–14:59）：

- 运行态共记录 8 次真实决策，覆盖 2 个会话：
  - `a9cba9fa-344b-4649-8f0b-49c255a69b70`：`deferred / deferred_cooldown`，上下文 753,079 tokens。
  - `b6d7a2d2-fabc-4077-bb22-bd07ac33a3bc`：`would_compact / economic`，上下文 424,245 tokens。
- 决策分布：`would_compact` 1、`deferred` 5、历史 `compacted` 2；运行态写入正常，无异常跳过。
- 计划里的 10 次是默认短时样本目标，不是启用门槛。两个会话随后都已空闲，且相同请求/边界/原因/上下文桶会被去重，因此有界等待 6 分钟停在 8 次；没有为了凑数注入消息或打断会话。
- 结论：D 的运行时接入、会话发现、journal 回放、经济判断与遥测写入均已真实生效；`opportunisticCompaction` 仍保持 `shadow`，不会自行折叠上下文。

### E. Auto-Research 闭环

新增 `home/profiles/{web,headless}/plugins/team-v13-auto-research.mjs`：

- 有界候选批次，默认最多 8 个。
- 基于 v12 `runReplay` 的隔离 fixture 回放，不调用 provider、不写活动会话。
- 预声明 capability floor：最少覆盖 fixture、最多 violations/errors、要求全通过。
- 先剔除未过 capability floor 的候选，再做 Pareto 非支配筛选；不会自动应用候选。
- 报告带 v12 `v12Evidence.records` 的 exact id/status/commit/fixture 引用摘要，便于把候选结果绑定到 v12 G 证据登记。

新增 `tools/v13-auto-research.mjs`：

- 可读取单个 fixture 或 fixture 目录。
- 写入 `home/team-control-plane/v13-auto-research.json`，同时输出 survivor/rejected 摘要。
- 已用 `phase10-tests/fixtures/v13-auto-research-basic.json` 做 smoke，结果只保留 `compact-one-boundary`，错误候选被 capability floor 拒绝。

### 配置

`home/profiles/{web,headless}/cordis.patch.yml`：

- `action-fusion` → `./plugins/action-fusion-v2.mjs`，多语言规则。
- `observation-pack` → `./plugins/observation-pack-v2.mjs`，新配置键。
- 新增 `evidence-reducer` 挂载，默认 `enabled: false`，设置页可编辑 volatile 路由字段。
- `step-compaction` 新增 `opportunisticCompaction: shadow`、`sessionsRoot`、`telemetryDir`、`cacheWriteReadRatio: 12.5` 和机会性压缩闸门。

## 2. 测试

`D:/dsh-test/phase10-tests/`：

- `action-fusion-v2.test.mjs`：5 通过。
- `compaction-economics.test.mjs`：7 通过。
- `compaction-shadow.test.mjs`：3 通过。
- `evidence-reducer.test.mjs`：7 通过。
- `observation-pack-v2.test.mjs`：4 通过。
- `auto-research.test.mjs`：2 通过。

结果：`PHASE10_ALL_PASS`（45 个测试，全部离线，无 provider 调用）。

回归：phase1–9 共 95 个测试全部通过。

## 3. 运行态状态

- DSH 桌面 Host 正在运行：PID 28180，端口 19387，启动于 13:26:40。
- 运行中的会话仍在写入（MC 工作区）。
- **未重启、未中断任何运行中的 Team。**
- 新挂载已在运行态确认加载：health、telemetry、spill 均有新证据。
- 尚未做大型 provider 测试；Reducer 默认关闭，机会性压缩默认 shadow，不会自行折叠上下文。

## 4. 后续建议

无阻塞项。当前 8 次 live 决策已满足“覆盖至少 2 个会话”的集成验收；若后续要做启用前统计，可继续积累到 10 次，不必等待日历时间。切换 `opportunisticCompaction` 到 `on` 前，应先看 telemetry 的 compact/defer 分布和 reducer receipt 质量。

## 5. 回滚

- 备份目录：`D:/dsh-test/backup-v13-20260925-140123`。
- 单机制回滚：把对应 `cordis.patch.yml` 的 `name` 指回原文件，或删除新挂载项。
- 新文件均为增量文件；原 `action-fusion.mjs`、`observation-pack.mjs`、`step-compaction-v4.mjs` 保留。
- `team-v13-auto-research.mjs` 已同步到 web/headless 两份，SHA-256 均为 `F3C82467F0E8CF3F6CBD6A4F9EA165E3E6190C473E32C521C923E6C33E217F0C`；它是被 `tools/v13-auto-research.mjs` 使用的库，不需要挂载进 Cordis。

## 6. v13.1 补齐状态

本轮按计划第 10 节 R1–R12 继续实施。状态在每项完成并通过测试后逐项更新；在 R1–R12 全部完成前，不再使用“v13 全部完成”表述。

- R1 Reducer 远程安全：已完成。`routeAllowed()` 同时约束 `session` 和显式路由，未授权远程路由保留原文。
- R2 G/J 激活与成本归因：已完成。遥测记录启用/触发/跳过/最后时间/成本指标，支持 dormant 会话阈值；历史 kind 回填修复已加入。
- R3 Reducer 证据登记：已完成。验证通过的 receipt 才写入 v12 evidence，绑定 archive sha、行号、fixture、provider/model。
- R4 D cache 债务与 job 镜像：已完成。`v13-compaction-debt.json` 记录上下文、债务、请求数与更新时间；economic/deferred 决策镜像到 v12 job。
- R5 F 基线与 A/B：已完成。`v13-mechanism-ab.json` 绑定 source/config/fixture SHA、模型和 fixture version；已登记 `default` v12 evidence `v13-mechanism-ab-d6843bcd4fc015b2`，结果 `keep`、`qualityRegression=false`。
- R6 Action Fusion 冷却与聚合：已完成。per-crate 冷却、内容哈希去重、耗时/通过/失败/超时指标均有测试。
- R7 ObservationPack 符号链接与收益：已完成。拒绝符号链接，记录归档前后字节与估算节省 token；A/B `19,764 -> 450`。
- R8 I 共享观察来源：已完成。Reducer 与 ObservationPack 共享 `sol_pi_observation_source_v1`，receipt 不会二次打包。
- R9 E 故障类别闭环：已完成。wake 风暴、压缩触发、重复测试、日志膨胀四类 fixture 均进入 capability floor 与 Pareto 筛选，未自动应用候选。
- R10 H 缓存前缀监控：已完成。缓存 read/write/命中率与最近机制事件关联；首轮历史异常只记录每个会话最新一条，避免刷屏。
- R11 K 持久失败指纹：已完成。按 action + failure fingerprint 持久计数，同一指纹第 3 次阻止原样重试；命令或方案变化解锁。
- R12 L 压缩锚点校验：已完成。压缩后校验 task contract、owner/scope、milestone/下一步、Room decisions、cursor、blockers；缺项标记 `completed_with_debt` 并注入恢复提示。

### v13.1 最终验证

- `phase10`：45/45 通过。
- `phase1–9`：95/95 通过。
- 离线 A/B：ObservationPack `19,764 -> 450` tokens；Reducer `19,764 -> 352` tokens（含 reducer 开销）；质量回归为 false。
- 运行态：DSH 未重启；Reducer 仍默认关闭，机会性压缩仍为 `shadow`。
- R5 evidence：`D:\dsh-test\home\team-control-plane\default.json` 的 `v12Evidence.records` 已含 `v13-mechanism-ab-d6843bcd4fc015b2`。

### v13.1 关键哈希

- `action-fusion-v2.mjs`：`B49673D885030DF9C3E27E3F91DF957A49D25F7ECB5CD28DBE0BC6DFA69E0F6E`
- `observation-pack-v2.mjs`：`04BC108CCD8CC19D18E30C9664B1BCB06745DF0981301A2814305F5D50EF5DC4`
- `evidence-reducer.mjs`：`4A5B61CCDA96913192E4BF59091E90895B402A9EB06EBE16088AB8CA3060B2D8`
- `team-v13-mechanism-telemetry.mjs`：`B2E4CF692226FD6BDBF5874153AE256358289DEC75F1F76EE89E84B29F0FF2CA`
- `team-v13-cache-monitor.mjs`：`8414D5C38919504118A293D82F44957B1D74D853B36758A99A64B52F1AB4AA13`
- `step-compaction-v4.mjs`：`9004F84E9181FD76302939D65F4DF14D5623B319A289B99C45ADF381A5AA52CF`
- `tools/v13-mechanism-ab.mjs`：`D6843BCD4FC015B2F561D04780957490E60628D50A622EB643F30F85FB4E1028`
- `tools/v13-register-ab-evidence.mjs`：`DAE8A14C02216C6B7D8ABBFDC345037F15AEB724DC553A15805791048D02868C`
