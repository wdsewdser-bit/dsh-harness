# 官方 PTC 与原生压缩对 DS4.1F 的适配审计

日期：2026-10-01。补充 `prompt-memory-audit-20261001.md`，专门回答官方提示词与原生压缩的问题。
本轮仅检查安装源码、配置和官方文档，运行一个内存内裁剪反例，并写审计文档。没有更改生产提示词、profile、角色、会话或历史，没有启动或重启 DSH。

## 结论

1. 当前自定义压缩触发器确实调用官方 `@deepseek-ai/dsh-compaction-basic` 引擎，不是另一套独立摘要系统，也不是供应商提供的远程压缩 API。
2. 官方 PTC 是通用工具编排协议，不是专门为 DS4.1F 调整过的完整工程行为准则。源码不足以证明它与 DS4.1F 不兼容；可以确认的是，它缺少足够具体的反复试错、验证预算、计划恢复和完成证据规则。
3. 原生摘要有目标、待办和关键约束等合理结构，但它是有损摘要。原文留在事件日志里，不等于下一轮模型能看到原文。
4. 当前里程碑插件走原生 `compactNow`，其保留参数是 0，而不是原生压力压缩的默认 16% 近期保留策略。这仍保留最后节点及为工具配对而扩展的尾巴，但不能理解为保留充分的近期工作过程。
5. 优化摘要提示词可以减少遗漏，不能单独保证不失忆。需要版本化计划/状态锚点、按需重读、恢复回执和完整性检查共同工作。

## 已核对的原生流程

安装包版本：`@deepseek-ai/dsh-compaction-basic` 为 `0.1.7-rc.2`。
以下行号均指 `D:/dsh-test/app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`。

- 59-85：库默认自动压缩开启，压力比例 0.8、近期原文比例 0.16、headroom 65536；摘要输出上限默认跟随 headroom。它是上限，不代表每次生成 65536 token。
- 124-145：实际压力阈值同时受上下文容量、输出保留与 headroom 约束，不是固定只看 80%。
- 410-432：选择较早历史，保留近期尾巴；不切开 assistant 工具调用与结果配对；开头的 system/message 不进入替换区。
- 914-960：原生压力路径先尝试长工具结果裁剪，再决定是否摘要；溢出路径的保留参数是 0。
- 985-1001：原生手动 `compactNow` 在 maintenance/idle 状态执行，也用保留参数 0；此分支没有先调用 pruner。
- 695-703：摘要输入由 system、原工具目录和被替换区域组成。保留下来的尾巴不在这个摘要输入里，因此摘要器本身不保证知道尾巴里的最新纠正；后续恢复模型必须结合尾巴处理冲突。
- 292-337：沿用会话路由或专门摘要路由，追加最后一条 user 摘要指令，调用 `ctx.llm.stream`，purpose 为 compaction。原工具目录和 toolHistory 仍进入请求。
- 327-328、601：要求有非空文本，且包装后的摘要比替换区域更小；还有边界、并发一致性和图片拒绝检查。没有验证八个标题是否齐全、关键计划项是否遗漏、所谓完成是否有证据。
- 634-660：追加 summary 与替换消息，记录原始 seq 与来源关系。改变的是活动上下文 surface，不是删除原始事件日志。

本机名为官方 `ptc` 的安装预设位于 `dsh-web-app/presets/ptc.patch.yml`，73 行已配置 `auto:false # compaction-policy: milestone-only`。这与库默认值不同，不能把当前安装配置当成未经调整的上游默认。
`home/profiles/web/plugins/step-compaction-v4.mjs:338-343` 直接调用原生 `compactNow`；381-392 的跨隔离域回退执行 `/compact`，同样到原生引擎。577-604 的桥接会按配置继承会话 reasoning effort。

## 原生摘要提示词写了什么

原文在 `dsh-compaction-basic/lib/index.js:243-277`。它要求八个固定部分：

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code
4. Errors and Fixes
5. Pending Jobs
6. Current Work
7. Next Step
8. Critical Context

它要求简洁英文、保留准确路径/命令/错误/标识符/数值，忠实记录用户纠正，不调用工具，并把已有摘要合并成新的摘要。不是完全没有防遗忘指令。
但这些规则缺少以下明确约束：

- 每个计划项目前的实现、测试、部署/启用状态，分别记录，不合成一个 done。
- 已验证完成与模型口头完成的区分，以及具体证据定位。
- 活跃主目标和用户临时补充的关系，防止最新一句反馈遮蔽仍未完成的原目标。
- 当前计划文档路径、版本/hash、必读章节和恢复前的读取要求。
- 必须跨多次压缩保存的约束、已否定方案与暂未证实的假设。
- 没有新证据时不能把旧摘要中的事实判成过时；冲突必须留下来源与待核验状态。
- 中间工具结果已裁剪、输入不是完整会话、证据不可见等信息缺口必须明示。

原生 checkpoint 前言在 280 行要求把摘要当作 established background，却没有同时规定“摘要中的完成结论必须由工作区和证据核实”。这是总结错误传播的一种风险，不是每次失忆的已证实原因。

## 官方 PTC 提示词与 DS4.1F

`dsh-web-app/presets/ptc.patch.yml:14-15` 的 persona 主要是身份与 cwd。
`dsh-system-prompt/lib/index.js:10-42,310-359` 还会叠加计划、Team、工具、PTC-only 和动态 SDK。模型最终看到的系统指令不是 persona 那一句，也包含本地注入规则。
`dsh-tools/lib/index.js:1689-1699` 解释 run_code、错误处理、独立只读并发，以及只打印/返回必要结果。PTC 下写短编排程序是正常行为，不能以脚本数量直接判断浪费。

缺口主要在行为控制，而不是英文或 PTC 本身：

- Goal 继续轮次的指令要求继续、验证和确认整个目标，但没有具体的同因失败/无新证据换路机制。
- “完整完成”有原则性要求，但基础 goal complete 接口并不验证外部计划每一项的证据；Team 自定义门禁要另行核对，不能说整个系统完全没有验收。
- 未明确按影响面选择最小验证、复用已成立结果、仅在新修改/新风险出现时扩大回归。
- 工具正文和 SDK 都在系统输入中，对长 Team 会话需要去重和按需展示；不能简单删除实际调用所需契约。

官方 DeepSeek Thinking Mode 文档本轮 HTTP 200 读取成功：
<https://api-docs.deepseek.com/guides/thinking_mode>
该接口当前默认 thinking/high，medium 等映射到 high；带 tools 时历史 reasoning_content 应回传并纳入上下文。以上是官方接口文档，不证明本地中转完全按相同方式映射，需 wire/request 回执核实。

官方模型卡本轮第一次 HTTP 200 读取成功，第二次读取遇到传输 EOF：
<https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash>
模型卡展示长上下文/agentic 目标，代码 agent 主评测描述使用 Harness Minimal。它不是证明 PTC 不适配的对照实验，也不能以结构描述推断用户的重复思考必然是模型架构导致。

原生摘要保留工具与历史，是为保持请求前缀和缓存机会。DS 的历史思考规则使这些摘要输入可能很重。不能无测试地删 tools/reasoning、降低思考或改路由：会影响历史语义、缓存和摘要质量。优先测保持路由与契约时的更短摘要；其他变体作为明确标记的协议实验。

## 一个可复现的裁剪风险

用安装包导出的 `ToolResultPruner.prototype.pruneContent`，在内存构造 10073 字符工具结果，关键计划路径、已验证阶段和不重启约束放在中间。使用本机 ptc 中的 8192/4096/1024 配置：

```json
{"originalChars":10073,"resultChars":5159,"originalHasCriticalMarker":true,"resultHasCriticalMarker":false,"prunedMarker":true,"originalUnchanged":true}
```

反例通过，说明确定性 head/tail 裁剪能丢掉中间的重要信息，原文仍在来源侧。它只证明机制风险，不证明当前里程碑压缩每次都走 pruner；当前 `compactNow` 分支没有这一步。
首次执行因 Windows ESM 路径不是 file URL 失败；改为 `file:///D:/...` 后通过，没有改包源码或测试断言。

## 建议的摘要契约增量（未部署）

保留现有八个标题，减少与恢复组件的兼容风险。新增的是字段与优先级，不再叠加一份重复长摘要模板。

```text
Create a grounded continuation checkpoint for the supplied earlier span.
The retained tail may contain newer instructions. Do not claim to summarize
messages you were not given. Keep the existing eight section headings.

Primary Request and Intent: active objective, user corrections, authorization,
and outstanding requests. A status question does not cancel unfinished work.
Files and Code: active plan/ledger paths and available revision/hash; mark
unavailable versions unknown. Include exact evidence and artifact locators.
Errors and Fixes: rejected hypotheses, observed failures, and the evidence
that justified a change of approach. Do not invent resolutions.
Pending Jobs: each remaining plan item and its unmet acceptance criteria.
Current Work: exact stage and next operation; separate implemented, tested,
deployed/enabled, and verified. Narration alone is not completion evidence.
Next Step: the next concrete action preserving the full active objective.
Critical Context: persistent constraints, required rereads, conflicts and
missing input/evidence. Never silently resolve a conflict or erase a still
active constraint because it is old. Preserve critical user wording verbatim.

Consolidate previous checkpoints using newer evidence, not recency alone.
Prioritize objective, constraints, progress, evidence and recovery locators
over implementation trivia. Use concise bullets; do not reproduce long logs.
If a fact is unknown or unsupported, label it rather than infer success.
Do not call tools. Output only the checkpoint.
```

配套恢复策略：压缩前从权威任务/计划提取小而完整的状态锚点；摘要后校验覆盖，缺失则补锚点或登记需恢复的债务；恢复首轮按文档 revision/epoch 判断是否重读，登记实际读取回执。缺失证据不得伪装成已恢复，摘要内容仍不是权威任务状态。
保留原生日志、工具配对和并发保护，不复制全历史进入每轮，不把一次重读扩成所有文档重读。
原生 idle compactNow 的近期保留应显式评估和支持安全可配置值，不能假定压力模式 retainRatio 已对它生效。

## 验证与边界

下一阶段应在隔离会话比较原提示词与增量契约，使用 DS4.1F 的真实路由：计划十项仅完成六项、只改未测、测过未启用、晚近用户纠正、关键事实在长输出中间、三次连续压缩、工具失败后换路、摘要/尾巴冲突等案例。
同时记录主代理与 Team 的完整 input/cache/output/reasoning、压缩请求用量、实际历史保留和文档读取回执。看完成判定、关键约束保留、原文可恢复与重复测试率，不只看摘要变短。
本轮没有执行模型 A/B，不能承诺节省比例或消除全部失忆，也没有把审计结论部署到活跃会话。

源码快照 SHA256：

| 文件 | SHA256 |
| --- | --- |
| compaction-basic/lib/index.js | B7AC52F20A36430CF01A66B3A36F23A48FFDB22708D714DBE1FFF541B5DF4EC5 |
| dsh-web-app/presets/ptc.patch.yml | 377A94666997FB64D729F26BE271CA0C345C2526EDBF7B1098F671CAEB638C0B |
| compaction-tool-result-pruner/lib/index.js | E86442E9A2403C392482B9035916E5610C251D62F3581892866404D69C064254 |

恢复入口：先读本文，再读 `prompt-memory-audit-20261001.md`，区分原生缺口、本地恢复缺口、待实施建议与真实运行证据。
