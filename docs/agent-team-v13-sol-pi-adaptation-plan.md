# Agent Team v13：SoL-Pi 机制融合计划（待评审）

> 状态：v13.1 的 R1–R12 已全部实施并通过离线验证；phase10 45/45、phase1–9 95/95 通过。D 已完成短时 live shadow 验收（8 次真实决策、覆盖 2 个会话；10 次样本目标因会话已空闲且相同决策去重未凑满），Reducer 设置页/命令、A/B 证据登记、缓存前缀监控、失败指纹和压缩锚点校验均已落地。实施细节见 `agent-team-v13-implementation-ledger.md`。
> 日期：2026-09-25
> 参考：NVlabs/SoL-Pi（MIT），arXiv 2609.20519，EdgeBench 51 任务。
> 本文只覆盖“值得移植的机制”，不涉及替换 DSH 底座、不复制 Pi 架构。

## 1. 背景与结论

SoL-Pi 是 Pi 单代理 harness 上的 token 经济学扩展，不是多代理编排系统。它公开了四个经 auto-research 筛选后存活的机制：

1. Action Fusion：编辑与后续验证命令合成一次工具调用。
2. ObservationPack：大工具输出归档为 handle，按页精确召回。
3. Evidence-Preserving Reducer：长日志交给便宜模型阅读，但每条引用必须能在归档原文逐字命中。
4. Online Context Compact：子任务完成点作为压缩候选，用“未来节省能否回本”的经济计算决定是否压缩。

官方数据：EdgeBench 上 token 减少 44.7–49.0%，API 成本约降三分之一，保留 Pi 约 94% 分数；swarm 实验中 1 协调者 + 20 worker 相比 Pi swarm 少 17.5% cycles、成本低 26.8%。

本团队现状：**Action Fusion 与 ObservationPack 已移植并启用**，但存在覆盖窄和语义弱化的问题；**Evidence-Preserving Reducer 与 Online Context Compact 已在本轮 v13 中补齐**，分别对应“日志审查烧 token”和“压缩时机不可解释”两个真实痛点。

本计划的目标不是追求 45% 的降幅，而是在本团队自己的基线上逐项验证：**效率指标改善，且验收质量不下降**。

## 2. 现状审计

### 2.1 已启用

| 插件 | 文件 | 配置 | 问题 |
|---|---|---|---|
| action-fusion | `home/profiles/{web,headless}/plugins/action-fusion.mjs` | 仅匹配 `/[.](js|mjs|cjs)$/`，执行 `node --check "{file}"` | 对 Rust/TS/Python/Go 项目完全不触发；`node --check` 只是语法检查，不是项目真实验证 |
| observation-pack | `home/profiles/{web,headless}/plugins/observation-pack.mjs` | `maxInlineChars: 12000`、`previewChars: 800`、`evidenceChars: 1500`、`spillDir: D:\dsh-test\home\spill` | 立即替换、无“前 N 次仍发全文”、无内容寻址哈希校验、无精确分页召回语义 |

两个插件在 web 与 headless 的 `cordis.patch.yml` 中均已挂载。

### 2.2 已具备但不等价

| 能力 | 现有实现 | 与 SoL-Pi 的差距 |
|---|---|---|
| 上下文组装 | `team-v12-context.mjs` 的 context pack | 有来源/修订/保留类别，但无“大观察生命周期管理”，也没有把压缩成本纳入决策 |
| 压缩状态机 | `team-v12-compaction.mjs` + `step-compaction-v4.mjs` | 有 milestone done 与 75% 压力触发，但没有“这次压缩值不值”的经济判断，也没有 cache 债务跟踪 |
| 验证证据 | v12 G 的证据登记与 exact SHA 复用 | 有证据索引，但没有“日志阅读下放 + 引用逐字校验”的 reducer |
| 隔离回放 | v12 L 的 fixture 框架 | v13 E 已用 capability floor + Pareto 非支配筛选接入机制候选 |

### 2.3 关键事实

- `step-compaction-v4.mjs` 默认 `windowTokens: 1000000`、`autoCompactRatio: 0.75`、`reservedOutputTokens: 32768`、`safetyMarginTokens: 8192`。
- 75% 压力与 milestone done 是**必须保留的强制路径**，本计划的经济判断只用于“机会性提前压缩”，不得削弱这两条安全路径。
- 当前用户侧只有一个可用供应商与模型。Evidence-Preserving Reducer 的“下放给便宜模型”价值因此受限；但即使使用同一模型，**独立 reducer 会话不污染主会话上下文**仍可节省主会话 token 并保持主前缀稳定。

## 3. 设计约束

沿用 v12 已确认的原则：

- 提示词只说明，控制面做强制；权限与状态转换不由模型自觉决定。
- 硬门禁必须有可解释的拒绝原因与恢复路径，不能因机制新增而制造新的死锁。
- 任何效率机制都必须设 capability floor：效率改善不能以验收质量下降换取。
- 机制默认关闭或影子运行，先记录基线，再逐项启用。
- 失败必须 fail-open：观察归档、reducer、经济判断出错时保留原始内容或保持现有行为，不得阻断任务。
- 兼容现有会话、Room 游标、milestone 状态与 control plane schema，不重建、不清空。
- 所有改动先备份，可单独回滚；不改变 DSH 上游文件。

## 4. 工作包

### A. Action Fusion 覆盖真实项目语言

**目标**：让“编辑 → 验证”融合在 Rust/TS/Python/Go 项目里真正触发，并且验证命令针对被改文件所属的项目根。

**现状问题**：

- 规则只匹配 JS 家族，Rust 项目（MC）完全不触发。
- 即使匹配，`node --check` 只证明语法，不证明项目可编译。

**设计**：

- 规则从单条扩展为按扩展名的表：`.rs`、`.ts/.tsx`、`.py`、`.go`、`.js/.mjs/.cjs`。
- 新增 `projectRootFromFile` 语义：从被改文件向上查找 `Cargo.toml` / `package.json` / `pyproject.toml` / `go.mod`，在项目根执行命令，而不是 harness cwd。
- 建议默认规则（可按项目覆盖）：
  - Rust：`cargo check --message-format short`，仅在该文件所属 crate/workspace 内执行；找不到 manifest 则跳过。
  - TypeScript：存在 `tsconfig.json` 时 `tsc --noEmit`，否则跳过。
  - Python：`python -m py_compile "{file}"` 作为廉价语法门。
  - Go：`gofmt -l "{file}"` 作为廉价格式门；`go build ./...` 作为可选重规则。
  - JS：保留 `node --check "{file}"`。
- 增加内容哈希去重：同一文件在内容未变化时不重复执行同一验证命令，避免一轮内多次编辑造成重复检查。
- 验证失败只作为证据追加，不把工具调用变成错误；编辑本身失败时不执行验证命令。

**改动文件**：

- `home/profiles/{web,headless}/plugins/action-fusion.mjs`
- `home/profiles/{web,headless}/cordis.patch.yml` 的 `action-fusion.config.rules`

**已定策略（Rust）**：

- `.rs` 编辑默认执行 `cargo check --message-format short -p <crate>`，cwd 取该文件所属 crate 的 workspace 根；找不到 `Cargo.toml` 时安静跳过，不猜项目根。
- 必须带内容哈希去重与 per-crate 冷却：同一文件内容未变化、或同一 crate 在本轮内已成功检查过，则不重复执行。
- 超时 180 秒，输出上限 4000 字符；超时或命令不可用时追加 `[then_run:skipped]`，不把编辑变成错误。
- 每个项目可覆盖为 `rustfmt --check` 或 `off`。
- **功能立即生效，无时间门槛**；遥测持续记录每次检查耗时与通过率，样本足够后若中位耗时超过 60 秒，在报告中建议该项目降级，不自动改配置。

**验收**：

- Rust fixture：带类型错误的 `.rs` 编辑在同一个工具结果里返回编译错误；干净编辑返回成功。
- 编辑失败时验证命令不执行。
- 同一文件相同内容哈希不重复执行验证。
- 找不到项目 manifest 时安静跳过，不执行错误 cwd 的命令。

**风险**：`cargo check` 可能很慢、很贵。缓解：默认只做 crate 级检查、设置超时、允许按项目关闭重规则、先影子记录命令耗时。

### B. ObservationPack 对齐 SoL-Pi 语义

**目标**：大观察在保留可访问性的同时，不再每轮重放全文。

**现状差距**：

- SoL-Pi 用字节阈值（10KB）、前 2 次请求仍发全文、之后替换为头尾摘录 + handle、内容寻址 + sha256 校验、offset/next_offset 精确分页召回、失败回退原文。
- 现有实现按字符数、立即替换、无延迟投影、无哈希校验与分页语义。

**设计**：

- 阈值改为字节计量，默认 10KB（与 SoL-Pi 对齐），保留 `maxInlineChars` 作为兼容回退。
- 新增 `fullSends`（默认 2）：同一工具结果在前 N 次供应商请求中保持全文，之后才替换为 handle。
- handle 内容：id、工具名、原始字节/行数、估算 token、归档绝对路径、头尾完整行摘录、召回方式。
- 召回复用现有 read 工具；若需要精确分页，再评估是否增加只读 `obs_recall`，默认不新增模型可误用的工具面。
- 归档使用内容寻址 + sha256；读取时校验大小与哈希；拒绝符号链接；spill 失败回退原文，不失败工具调用。
- 错误结果、reducer receipt 不参与打包，避免把已验证证据再降级为摘录。

**改动文件**：

- `home/profiles/{web,headless}/plugins/observation-pack.mjs`
- 若需要“延迟投影”，可能新增一个只读的请求组装钩子模块；先做 API 可行性验证，不假设 DSH 一定提供。

**验收**：

- >10KB 纯文本工具结果前 2 次请求为全文，之后为 handle。
- 召回内容与归档逐字节一致；哈希/大小不匹配时回退原文。
- spill 失败、归档目录异常、符号链接均不阻断工具调用。
- 与启用前相比，主会话输入 token 下降，且 fixture 验收不退化。

**依赖**：需要先确认 DSH 是否暴露“出站请求消息组装”钩子；若没有，先只做内容寻址与哈希校验，延迟投影列为阻塞项。

### C. Evidence-Preserving Reducer（新插件）

**目标**：把长日志的“第一遍阅读”从主会话移出，并且不要求主代理信任一段无法核对的摘要。

**流程**：

1. 工具结果超过阈值（建议 20KB）且为纯文本日志类。
2. 原文归档到内容寻址文件，记录 sha256、总字节、总行数。
3. 若 reducer 启用，交给配置的 reducer 路由生成结构化 receipt：摘要 + 引用行 + 行号 + 未决问题。
4. **逐条校验**：每个引用行必须能在归档原文中逐字命中（仅允许统一换行符），行号范围必须有效。
5. 全部通过才用 receipt + 归档 handle 替换主会话内容；任一失败保留原文（fail-open）。
6. receipt 写入 v12 证据登记，关联归档 sha 与行号，供审查员按需回读原文。

**约束**：

- 默认关闭；启用后默认只允许本地 reducer 路由。
- 远程 reducer 需要显式配置与安全确认，日志可能含敏感内容。
- reducer 超时、模型错误、schema 不符、引用不匹配都不得阻断主任务。
- 即使 reducer 使用同一模型，独立会话仍能避免主会话上下文与缓存前缀被日志污染；这是当前单供应商条件下的主要收益。

**路由设计（已确认）**：

- 在设置里增加 `evidence-reducer` 选项，路由方式二选一：
  - `route: "session"`：不额外路由，直接使用该会话/Team 当前选中的模型。
  - `route: { provider, model, effort? }`：从 DSH 自身已配置的供应商与模型列表中选择，不新增凭据存储。
- 供应商/模型来源复用 DSH 自己的 provider registry（与 `/team route`、`spawn_agent` 的 `provider` 参数同源）。
- 设置入口优先放控制面板设置页；Phase 0 先定位现有设置面，同时提供 `/team reducer-route ...` 命令作为确定性回退。
- 若所选供应商为远程且 `remoteAllowed: false`，拒绝远程路由并回退到 `session` 或原文，不静默外发日志。
- 每 Team 覆盖留到后续版本，第一版只做全局设置。

**建议配置骨架**：

```yaml
evidence-reducer:
  enabled: false
  route: 'session'            # 'session' | { provider, model, effort? }
  thresholdBytes: 20480
  maxReceiptTokens: 1500
  timeoutMs: 60000
  archiveDir: 'D:\dsh-test\home\evidence-archive'
  remoteAllowed: false
```

**改动文件**：

- 新增 `home/profiles/{web,headless}/plugins/evidence-reducer.mjs`
- 新增纯函数校验模块（引用匹配、receipt schema、归档校验），便于隔离测试
- `cordis.patch.yml` 新增默认关闭的挂载项
- 控制面板设置页新增 reducer 路由选项；`team-operator` 新增 `/team reducer-route`

**验收**：

- 50KB 日志 fixture：引用全部命中时主会话内容显著缩小。
- 注入错误引用 / 行号越界 / reducer 超时：主会话保留原文。
- receipt 能反查归档原文；归档缺失时不静默接受。
- 主会话 fixture 验收不退化。

**依赖/待决**：是否具备第二个便宜模型路由；若没有，是否接受“同模型独立会话”作为第一阶段。

### D. Online Context Compact 经济闸门

**目标**：让“为什么这次压缩”永远可解释，并避免在明显不回本时提前压缩。

**现状**：

- milestone done 与 75% 压力是强制路径。
- 缺少“剩余请求估计、breakeven、cache write/read 比价、压缩后 cache 债务”的判断。

**设计**：

- 新增纯函数模块 `team-v13-compaction-economics.mjs`，参考 SoL-Pi 的 `economics.ts`：
  - 输入：当前上下文 token、窗口、reserved/margin、已完成子任务边界的请求数样本、平均上下文增量、预计摘要大小、cache write/read 比价、历史压缩次数、未偿还 cache 债务。
  - 输出：`compact | defer`、原因、breakeven 请求数、预计剩余请求数、是否窗口保护。
- 触发分层：
  - **强制**：milestone done → 压缩任务；上下文达到压力阈值 → idle 时压缩。经济判断不得否决。
  - **机会性**：子任务边界（Room 轮次关闭、任务卡完成、已验证子目标完成）且未触发强制路径时，才询问经济判断；只有回本才入队。
- 后续压缩增加 margin（建议 1.5x）与债务偿还条件，避免连续压缩反复重写 cache。
- 压缩任务与面板显示原因：`milestone` / `pressure` / `economic` / `deferred_*`。
- 第一版只做影子模式：计算并记录决策，不实际触发；观察一段时间后再启用机会性压缩。

**已定启用条件**：

- **先用现有会话做离线回放，不等待新数据**。现有 session journal 已包含逐事件 `usage.inputTokens / outputTokens / cacheReadTokens / totalTokens`（`team-usage.mjs` 已在使用），可直接重建历史请求序列、上下文增长与缓存比价。
- 离线回放要求：至少 5 个现有会话、至少 5 个已完成子任务边界、至少 30 个候选决策点；在每个历史边界运行经济判断，输出 `compact/defer + breakeven`，并与实际发生过的压缩事件对照。
- `cacheWriteReadRatio` 优先从现有 journal 的真实 cache read/write 数据推导；无法推导时标 `cache_ratio_unavailable`，不静默套默认值。
- 离线回放通过后，只做**短时 live 集成验证**（默认 10 次 live 决策、覆盖至少 2 个会话），确认运行时接入与离线模型一致即可，不设日历天数门槛。
- 同一状态下的 `compact/defer` 原因不得反复翻转；出现翻转先修正估计模型，不启用。
- fixture 成对 A/B 必须显示 token/成本下降且质量零回归，才允许打开机会性压缩。
- 机会性压缩只在 idle 时执行；有 active lease 或 Team 正在工作时只入队，不打断。
- milestone 与 75% 压力路径行为不变，经济判断只影响“是否提前压缩”。

**改动文件**：

- 新增 `home/profiles/{web,headless}/plugins/team-v13-compaction-economics.mjs`
- `step-compaction-v4.mjs` 或后续 v5 接入决策与原因记录
- `team-v12-compaction.mjs` 的 job 字段扩展（保持向后兼容）
- 控制面板显示压缩原因

**验收**：

- 影子模式能对每次 idle/边界给出 `compact/defer + reason + breakeven`。
- milestone 与压力路径行为不变。
- 启用后，机会性压缩只在 breakeven 低于预计剩余请求时发生。
- 成对 A/B 中 token/cost 下降，fixture 验收与关键决策召回不退化。

### E. Auto-Research 闭环方法论（最后阶段）

**目标**：把“真实会话出问题 → 人肉修”升级为“提案池 → 隔离回放 → 能力底线 → 保留非支配候选”。

**设计**：

- 以 v12 L 的隔离 fixture 与 v12 G 的证据登记作为评估基底。
- 候选机制按批次生成，每个候选在隔离环境回放，预声明 capability floor；效率改善且能力在容忍范围内才保留。
- 先只针对本团队已确认的故障类别（wake 风暴、压缩触发、重复测试、日志膨胀）做小规模闭环，不开放无边界搜索。
- 人类只负责设定先验、审核存活候选与清理实现，不进入自动循环。

在 A–D 与 G/J 的基线和遥测可用后启动，作为本计划最后阶段；若基线数据不足，先补齐数据再启动，不跳过能力底线直接搜索。

### F. 度量基线

所有机制启用前必须先有基线，按机制单独成对比较：

- 主会话输入 token、总 token（含 reducer 会话）、cache 命中率、模型轮数、工具调用数、墙钟时间。
- 质量：fixture 验收通过率、关键决策召回、缺陷逃逸、返工次数。
- 记录到 v12 证据登记，绑定 exact SHA、配置、模型与 fixture 版本。
- 任一机制若使 fixture 验收低于基线容忍范围，不得启用。

## 5. 实施顺序

1. 阶段 0：API 与基线盘点——确认出站消息钩子、usage/cache 指标、provider registry 读取方式、控制面板设置面；复用 `team-usage.mjs` 的 `decodeJournal` 提取现有会话的逐请求时间线（usage/cache/边界），作为 D 的离线回放输入；跑现有 fixture 基线。
2. 阶段 A：Action Fusion 多语言覆盖（低风险，先修 Rust 不触发问题）。
3. 阶段 B：ObservationPack 哈希/分页/延迟投影（延迟投影依赖阶段 0 结论）。
4. 阶段 D：压缩经济闸门——先对现有会话做离线回放校准，再做短时 live 影子验证；通过后才启用机会性压缩。
5. 阶段 C：Evidence-Preserving Reducer（含设置页路由选项与 `/team reducer-route`）。
6. 阶段 G/J：机制激活遥测与成本归因（见第 9 节；与 A–D 同步落地，否则无法验收）。
7. 阶段 D2：满足启用条件后打开机会性压缩并成对验证。
8. 阶段 E：小规模 auto-research 闭环（本次范围内，最后执行）。

## 6. 回滚与兼容

- 每个插件改动前保留带时间戳备份；配置项默认关闭或保持旧行为。
- schema 扩展只增字段，旧会话与旧 job 必须可读。
- ObservationPack / Reducer 归档只增不改；清理策略单独定义，不自动删除用户数据。
- 任何机制可独立通过 `cordis.patch.yml` 关闭，不依赖其他机制回滚。

## 7. 已确认决策

1. **Reducer 路由**：在设置中提供选项，可从 DSH 自身供应商/模型列表中选择 `provider + model` 路由；另提供 `session` 模式，不额外路由，直接使用该会话/Team 当前模型。远程 reducer 默认不允许，需显式开启。
2. **Rust 验证强度**：默认 crate 级 `cargo check`，配内容哈希去重、per-crate 冷却、180 秒超时与输出上限；支持按项目降级为 `rustfmt --check` 或关闭；功能立即生效，耗时只做持续遥测，不设时间门槛。
3. **机会性压缩**：直接用现有会话做离线回放（≥5 个会话、≥5 个边界、≥30 个决策点），cache 比价从真实 usage 推导；之后只做 10 次 live 集成验证，不按日历天数等待。fixture A/B 质量零回归后才启用；强制压缩路径不变。
4. **实施范围**：A–E 全部纳入，E 在最后执行；G/J 与 A–D 同步落地作为验收基础。

## 8. 明确不做

- 不替换 DSH/Pi 底座。
- 不照搬 SoL-Pi 的 swarm 拓扑，现有 tier/room/lease/fail-closed 继续作为编排事实源。
- 不为了效率削弱 75% 压力与 milestone 压缩路径。
- 不默认启用远程日志 reducer，不把摘要当作可替代原文的证据。
- 不用模拟回放替代必要的真实会话验收。

## 9. 追加检查与加强项

复查 v13 草案后发现以下缺口。G/J 属于 A–D 的验收基础，应同步实施；H/I/L 直接影响本团队已出现过的缓存、重复压缩与上下文丢失问题；K/M 可后续处理。

### G. 机制激活遥测与休眠检测（P0）

**问题**：当前“已启用”不等于“真实生效”。`action-fusion` 就是实例：它在两个 profile 都 enabled，但对 Rust 项目从未触发过一次。

**设计**：

- 每个机制记录 `enabled`、触发次数、最后触发时间、跳过原因直方图（如 `no-rule-match`、`below-threshold`、`reducer-disabled`、`timeout`）。
- 健康报告与控制面板显示每个机制的激活状态；连续 N 个会话（默认 5）零触发时标为 `dormant`，这是诊断标记，不阻断功能。
- 休眠机制不得在效率报告中计为收益；必须先解释为何不触发，再决定扩规则或关闭。

**验收**：Rust 会话中 `action-fusion` 若规则不匹配，报告显示 dormant 及 `no-rule-match`；修好规则后触发计数增长。

### H. 缓存前缀稳定性监控（P1）

**问题**：本团队曾长期只有 80–90% 缓存命中，且压缩、上下文裁剪、观察替换都可能改写历史前缀。

**设计**：

- 记录每次请求的 cache read/write 与命中率，关联当轮发生的机制事件（压缩、context pack prune、observation 替换）。
- Reducer 与 ObservationPack 只允许替换该工具结果本身或追加新消息，不得改写 system prefix；压缩摘要只能追加到末尾。
- 命中率异常下降时输出“前一个事件 + 前缀差异摘要”，区分正常 cache miss 与机制造成的 prefix churn。
- 该项与 SoL-Pi 的 C4/C20/R15 思路一致，但以本团队现有 usage 数据为准。

**验收**：能解释一次命中率下降由哪个机制事件造成；A–D 机制启用后命中率不因前缀重写而下降。

### I. Reducer 与 ObservationPack 优先级契约（P0）

**问题**：两个机制都作用于工具输出，若同时生效可能重复降级，把已验证 receipt 再替换成摘录。

**设计**：

- 固定顺序：`reducer（启用且符合条件）→ 成功则 ObservationPack 跳过 receipt → reducer 失败/禁用才由 ObservationPack 处理原文`。
- receipt 带唯一 marker、归档 id 与 sha；ObservationPack 见到 marker 直接跳过。
- 两者都 fail-open；共享同一份“观察来源”元数据，记录原始 sha、处理者、处理结果。

**验收**：同一大日志不会既生成 receipt 又被二次打包；reducer 失败时 ObservationPack 仍能接管原文。

### J. 机制级成本归因（P0）

**问题**：目前只能看整个 Team 的总消耗，无法回答“这个机制到底省了多少、值不值得留”。

**设计**：

- 以 provider usage + 激活事件，按机制记录节省/增加的 token、模型轮数、工具耗时与等待时间。
- reducer 的收益必须把独立 reducer 会话成本计入，不能只算主会话变短。
- 结果写入 v12 G 证据登记，绑定 exact SHA、模型与 fixture 版本。
- A–D 每个机制启用前后做同一 fixture 的成对比较，质量零回归才保留。

**验收**：任一机制可单独回答“触发多少次、省/费多少 token、质量是否变化”。

### K. 失败指纹记忆与修复预算（P2）

**问题**：相同错误在重启或压缩后可能重复触发多轮试错。

**设计**：对错误码、关键栈帧与命令生成稳定指纹，持久记录次数；同一指纹重复超过阈值时强制升级为重新规划或请求决策，而不是继续重试。v12 H 已有重复失败检测，本项把它做成跨压缩、跨重启的持久记忆。

### L. 压缩锚点机器校验（P1）

**问题**：压缩后丢失“下一步/owner/未决决策”曾多次出现，目前主要靠恢复提示和模型自觉重读。

**设计**：压缩完成后校验必需锚点是否在摘要中：当前任务契约、owner/scope、active milestone 与下一步、有效 Room 决策、未读游标、未决阻塞。缺项时注入恢复提示并把压缩标记为 `completed_with_debt`，不静默视为完成。

### M. 临时目录堆积（P2，观察项）

`D:\dsh-test` 下存在大量 `.team-control-runtime-*` 目录，疑似每次运行的临时目录。建议后续增加有界保留策略（保留最近 N 个或 M 天），删除前仍需用户确认；本项不属于 A–E 实施范围。

## 10. v13.1 补齐计划（2026-09-25）

审计发现 A–E/G/J 的“主体代码”与“完整验收”不是同一状态。以下 R1–R12 是本轮继续实施的验收清单；全部完成前不得把 v13 标记为完全交付。

### R1. Reducer 远程安全

- `route: "session"` 也必须解析实际 provider；未在 `localProviders` 且 `remoteAllowed !== true` 时拒绝，不把日志交给远程模型。
- 设置页/命令提供明确的本地/远程状态，失败时保留原文。

**状态：已完成。** `routeAllowed()` 已覆盖 `session` 与显式路由；失败保持原文。

### R2. G/J 完整激活与成本归因

- 遥测记录 `enabled`、触发、跳过、最后时间、按机制 token/工具耗时/等待时间/模型轮数和质量结果。
- `dormant` 按连续 N 个会话（默认 5）判定，不能只按“历史从未触发”。
- 健康报告和控制面板消费遥测；休眠机制不计收益。

**状态：已完成。** 已加入历史 kind 回填，`cache-prefix` 这类旧遥测不会因升级被误判为休眠。

### R3. Reducer 证据登记

- 验证通过的 receipt 写入 v12 evidence registry，绑定 archive sha、行号、fixture、模型和 exact commit。
- 归档丢失/验证失败不得登记为有效证据。

**状态：已完成。** 只有验证通过的 receipt 才登记；测试覆盖 archive、行号、模型和 fixture 绑定。

### R4. D cache 债务与 job 镜像

- 运行时记录 `lastCompactionContextTokens`、carried debt、已偿还债务和上次压缩时间。
- economic/deferred 原因写入 v12 compaction job；控制面板显示 `milestone` / `pressure` / `economic` / `deferred_*`。

**状态：已完成。** shadow 决策已写入 `v13-compaction-debt.json` 与 v12 compaction job。

### R5. F 基线与 A/B

- 增加机制级 A/B 报告：主会话输入、总 token、cache 命中率、模型轮数、工具调用、墙钟时间、质量结果。
- 绑定 exact SHA、配置、模型和 fixture 版本；质量不下降前不开启 D2。

**状态：已完成。** 报告 `v13-mechanism-ab.json` 绑定 source/config/fixture SHA；已登记为 `default` v12 evidence `v13-mechanism-ab-d6843bcd4fc015b2`，结果 `keep`、`qualityRegression=false`。

### R6. Action Fusion 冷却与聚合

- 增加 per-crate 成功冷却；同 crate 同一轮不重复 `cargo check`。
- 聚合检查耗时、通过率、超时率，供降级建议使用。

**状态：已完成。** phase10 覆盖冷却、去重、超时与聚合指标。

### R7. ObservationPack 符号链接与收益

- 归档校验拒绝符号链接。
- 记录归档前/后字节、估算节省 token 和召回路径；A/B 中必须体现主会话输入下降。

**状态：已完成。** 符号链接测试通过；A/B 显示 `19,764 -> 450` tokens。

### R8. I 共享观察来源

- Reducer 与 ObservationPack 共享 observation source metadata：原始 sha、processor、result、archive id。
- 保持 reducer 优先，receipt 不再二次打包。

**状态：已完成。** 共享 marker 与跳过二次打包均有测试覆盖。

### R9. E 故障类别闭环

- 候选池至少覆盖 wake 风暴、压缩触发、重复测试、日志膨胀四类真实故障 fixture。
- 每类输出 capability floor、token 估计、Pareto survivor 和 v12 evidence refs。

**状态：已完成。** 四个 fault fixture 均参与研究回放，存活候选 `bounded-fault-policy`，未自动应用。

### R10. H 缓存前缀监控

- 每次请求记录 cache read/write/命中率，并关联最近机制事件。
- 命中率异常下降输出前一个事件、session、seq 和前缀 churn 摘要。
- Reducer/ObservationPack 只能替换当前工具结果或追加消息，禁止改写 system prefix。

**状态：已完成。** 监控已挂载并记录 `cache-hit-drop`；只记录每个会话最新异常，避免首轮历史噪声刷屏。

### R11. K 持久失败指纹

- 对错误码、命令和关键栈帧生成稳定指纹，持久保存次数。
- 同一指纹重复超过阈值时，阻止原样重试并要求重新规划/请求决策；命令或方案变化后解锁。

**状态：已完成。** 阈值默认 3；命令或方案变化会生成新指纹并解锁。

### R12. L 压缩锚点校验

- 压缩后校验当前任务契约、owner/scope、active milestone/下一步、Room 决策、未读游标和未决阻塞。
- 缺项标记 `completed_with_debt` 并注入恢复提示。
- 每次压缩恢复提示必须同时重读 v13 计划与台账。

**状态：已完成。** 校验已覆盖上述锚点，并移除脆弱的拼接文本匹配。
