# DSH 官方 PTC、角色身份、CLM 与压缩恢复审计

审计日期：2026-10-01，北京时间。用户确认使用官方 `ptc` 模式。
本轮只读审计运行资料、安装包和 profile 源码，并创建本文档；没有修改业务仓、提示词、角色、配置或原始历史，没有启动、重启或中断 DSH。

官方原生摘要请求、原生 PTC 对 DS4.1F 的适配、手动压缩保留策略及提示词改进契约，详见补充审计：[native-ptc-compaction-ds41f-audit-20261001.md](D:/dsh-test/docs/native-ptc-compaction-ds41f-audit-20261001.md)。补充审计同样未修改生产配置。

## 结论与适用范围

用户反映的几个现象有机制层的依据：CLM 使用指导没有跟随工具上线；验收覆盖会误用其他任务的旧证据；恢复内容截断、债务投递和原文读取没有完整闭环。需要同时改提示词与确定性检查，单纯增加“认真检查”“不要忘记”等文字不能解决这些问题。

官方 PTC 本身没有强制 `max` 思考。先前找到的 `minimal-zh-ptc` 固定 max 属于另一个自定义预设，不适用于本用户会话，已从原因分析中排除。近期业务请求确实普遍使用 `high`，但不能据此断言每一次 high 都多余。

“脚本很多”也不能单独证明浪费：PTC 本来就通过 `run_code` 编排工具。应该衡量是否重复读取、重复测试、重复发送长历史，以及每一步是否获得新的信息或进展。

本报告区分已复现的实现问题、现场记录和待验证行为假设。静态问题不能自动证明某次任务偏离计划就是由它造成。

## 已核实的身份与 CLM 状态

- `D:/dsh-test/home/AGENTS.md` 与 `home/team-roles/*.md` 最后修改仍在 9 月 27 日；身份版本为 `v14-2026-09-27.5`，清单中的 5 个文件哈希全部匹配。文件中没有 `context_manage`/CLM 使用指导。
- 旧成员身份更新链读取的是 `team-roles/AGENTS.md` 与对应角色文件，不是 `home/AGENTS.md`。仅改 home 全局文件不足以证明旧成员收到更新。入口：`team-v14-context-delivery.mjs:154-166`、`team-v12-runtime.mjs:3017,3045-3046`。
- 身份注入已有真实证据：lead `6327df13-c098-4de7-9f8a-e5aadb00397e` 的 journal `seq13`，2026-10-01 14:51:04.843，包含共同规则、lead 身份和当前版本；member `26d03f4b-e85e-4cda-8a7f-2bd09980862f` 的 `seq13` 也包含共同规则和 member 身份。这不是全部旧成员均已刷新的证明。
- `context-workspace.mjs:409-413` 对现有 agents 注册工具并订阅新 agent。root 的 system-prompt `seq75409` 与上述 lead 的 `seq2115` 都含 `context_manage`，所以不能把问题归为工具完全不可见。
- 当前磁盘配置 `cordis.patch.yml:23-29` 是 `mode: shadow`、`appliedSessionIds: []`。当前实现编辑 memo 的选取视图；即便 allowlisted apply，也只追加 memo 后缀，保留原始历史，见 `context-workspace.mjs:219,393-396`。它尚不等于 CLM 论文的完整上下文替换或历史缩减。
- 5 个 context-workspace JSON 只含 `clm-evidence` fixture 历史。此前隔离实验的 shadow 通过、apply 为 partial，记录见 `architecture-review-20261001/implementation-ledger.md` 最终收口节。不能把 fixture 当业务采用或总节省率。

原 RustMc root `session-028e6f5b-1716-4c23-a232-af16d853d191` 确实尝试过工具：

| 北京时间 | journal seq | 实际调用 | 业务结果 |
|---|---|---|---|
| 17:09:27 | 75579 → 75580 | memo_put | `ok:false / INVALID_REVISION` |
| 17:09:45 | 75590 → 75591 | state | `ok:true / mode:shadow` |
| 17:09:46 | 75592 → 75593 | memo_get | `ok:false / SOURCE_REVISION_UNAVAILABLE` |

第一条失败原因已查清：`input.expectedRevision` 缺失，而 `context-workspace.mjs:280` 无条件校验它。`sourceId`、`parentRevision` 缺失本身允许。模型没有成功写入，所以后续没有对应 source 可读取。另 8 个后代在本次有界窗口内没有实际 CLM 调用。工具层 `isError:false` 不代表这些业务调用成功，必须同时检查 `ok/code`。

读取范围：与最新 ledger 匹配的 9 个 journal，各读取末最多 8 MiB 压缩数据、最多 64 MiB 解压；覆盖各自近期请求窗口，解析没有报错。没有回放或改写整个历史。

## 官方内部提示词的实际链路

当前安装版本为 `0.1.7-rc.2`；core 包实际由 `D:/dsh-test/app/node_modules/@deepseek-ai/` 提供，不是旧 tmp 或 backup 目录。

| 层 | 真实来源与行为 | 判断 |
|---|---|---|
| 官方 PTC 身份 | `dsh-web-app/presets/ptc.patch.yml:14-15,149`，cwd、coding-agent 身份、`mode:ptc` | 没有指定 max，也没有完整的收敛与验收方法 |
| 系统组装 | `dsh-system-prompt/lib/index.js:10,317-359`，persona → plan → Team → PTC-only → tools → SDK | 后续 Team/工具指引同样影响行为，不能只改开头 persona |
| 每步与历史 | `dsh-agent-loop/lib/index.js:904,1029-1035`，每 step assemble，按 in-history 更新 | 需要继续验证已部署 SDK 投影对新版本的兼容覆盖 |
| 思考档位 | `dsh-agent-loop/lib/index.js:1153` 及 web `dsh-llm-pi-ai/lib/index.js:1850` | 来自请求选项、同路由历史 header 或 provider profile；官方 PTC 没有强制 max |
| 目标续跑 | `dsh-goal-round-driver/lib/index.js:15` | 要求继续推进和验证，但没有按同一假设/无新证据识别停滞 |
| PTC 编排 | `dsh-tools/lib/index.js:1695-1697,1431` | 独立读取示例用 Promise.all；一个子调用 reject 会使整批 return 丢失其他成功值，增加整批重读风险 |

## 优先修复项

### P1-01：验收矩阵跨任务、跨 commit 误覆盖

`team-v12-evidence-scheduler.mjs:358-375` 构造 acceptance matrix 时仅按 `requirementId` 查询并选 passed，没有同时过滤当前 taskId、commit 或契约版本。常见默认验收 ID 是 `ac-1`，见 `:130-140`。实际 `team_v12(review_package)` 会给它所有可读证据，见 `team-v12-runtime.mjs:2668-2688`。

只读纯函数反例：task A 当前 commit=NEW、必选 ac-1；registry 唯一证据属于 task B、commit=OLD、ac-1、status=passed。返回 `covered:true / uncovered:[]`，证据 task=B、commit=OLD。退出码 0。这是已复现的错误覆盖，尚未证明用户某次具体交付受此影响。

修复要求：以 task/board、契约版本、exact commit 或当前 tree、环境和 recipe 绑定覆盖；明确声明的复用才能跨任务，不凭 ac-1 碰巧同名复用。用 foreign-task、old-commit、changed-contract、合法复用反例验证。

### P1-02：恢复债务被当成已见内容，之后不再补发

`team-v14-context-delivery.mjs:183,209-210` 将 debt 的 hash 放入 known versions，`team-v12-runtime.mjs:1840-1841` 也把债务记入 cursor。下轮同 hash 即跳过。阻断只覆盖 safetyCritical，见 context-delivery `:292`；普通需求/决定/Room 主要只有 required，见 runtime `:3069,3087,3097`。

纯函数反例：256 token 预算只发 required debt，`failClosed=false`；提交回执后预算增加至 12000，仍得到空 body、debt=false。已复现。投递回执证明缺失提示被提交，不证明原文已经读取。

修复要求：分开保存 noticeDelivered、contentDelivered、contentFetched；债务在同 revision/hash 的真实取回之前保持 pending。相关任务的写入与最终交付检查 required 资料是否已恢复，允许不依赖该资料的独立工作继续。

### P1-03：长验收和决定被无标记截断

`team-v14-memory-anchor.mjs:20-34,61,137-140,156` 截标题/需求/决定至 240 字、验收至 160 字，恢复正文还截至 200 字；omitted 主要记录行数，不记录字段截断。

纯函数反例：1000 字标题变成 240，500 字验收变成 160，但 `sourceStatus=loaded / omitted={} / packOk=true`。已复现。重要限制若位于后半段可能不可见，是否产生具体执行偏差需要现场对照。

修复要求：保留原始 locator/hash、长度和截断标记；不完整字段产生明确债务，按需取回原条目。保持恢复包有界，不用每轮注入整份巨型文档解决。

### P1-04：压缩摘要返回结构不匹配

`step-compaction-v4.mjs:97-105` 只读取 folded 字符串或 settled.text/result；实际基础引擎 `dsh-compaction-basic/lib/index.js:662,994` 返回含 `summary:ContentBlock[]` 的对象。正常压缩也可能被 `step-compaction-v4.mjs:343-361` 标成 summaryAvailable=false / completed_with_debt。

修复要求：统一解析真正的 summary text blocks；区分无可压缩区间、失败、没有摘要和缺少具体锚点。用实际引擎返回格式验证，不能只用字符串 mock。

### P1-05：两套恢复指令互相冲突

`team-v12-compaction.mjs:13,505` 和 `team-v12-runtime.mjs:2558-2569` 的 compaction_status 仍要求重读 v12/v13 平台计划和台账；当前自动恢复 `step-compaction-v4.mjs:69-71` 明确要求恢复产品任务，排除这些平台实施文档。

修复要求：所有入口统一从当前任务的文档 refs 恢复。DSH 施工任务才引用平台计划；RustMc 等产品任务引用自己的计划。旧指令确实由状态工具返回，但本轮没有证明目标会话使用过这一入口。

### P1-06：有完成门禁，但缺少完整计划覆盖与用户完成表述的绑定

当前 `team-tools-v2-r10.mjs:7853-7946` 已验证 plan、phase、lease、commit 和任务 evidence，不能说现有系统毫无验收。`team_delivery_check:7232-7288` 又检查阶段和 acceptance packets，但主要检查记录存在、commit 匹配和 blocker；它不逐条读取原计划确定是否漏建任务、漏实现、漏启用或漏真实入口验证。对 integrated history 存在兼容放行，不宜不分历史与当前工作直接全局加严。

官方 `dsh-goal/lib/index.js:706` 的 complete 本身没有 evidence 参数；普通文本“完成了”也没有被上述 Team 门禁强制绑定。文档里的工作若没有进入任务/验收清单，关完现有卡片不足以证明用户需求全部交付。

修复要求：任务开始时登记当前计划的必选验收项，逐项区分 implemented / tested / enabled / accepted / partial，并关联证据。最终 delivery receipt 绑定当前 plan revision 和必要运行证据；部分完成只能报范围与剩余项。允许声明合理不适用，不能用自述把必选项删除。

### P2-01：CLM 工具上线后缺少用法和自然触发机制

角色版本、common 指引没有随 CLM 更新；工具描述较概括，schema 的 expectedRevision 对所有 action 都是可选字段，但 memo_put 实现必需。root 的第一次真实调用因此失败。shadow/空 allowlist 的配置也意味着没有业务投影。

修复要求：在真正被读取的 common+role 中加入短的 action 参数示例和业务成功检查；开始阶段、关键决定改变、交接/压缩前更新 memo，恢复时按版本取回。用实际 next-turn 身份内容证明旧成员收到了规则。先证明自然会话成功 memo_put/get/commit，再按已授权范围做 allowlisted apply；明确当前视图只处理 memo，不声称已经削减原 transcript。

### P2-02：失败记忆只识别相同工具参数，不能识别持续死磕同一假设

`team-v13-failure-memory.mjs:56-61,87-93,99-120,208-231` 对完整工具参数和错误指纹统计，适合拦截完全相同的确定性失败。换脚本、路径包装或错误文本，仍可能继续追同一个失败思路。模型在没有新证据时如何切换方法，目前缺少统一规则。

现场 telemetry 已有 `failure-recorded=7793 / replan-required=19 / repeated-failure-block=49`，所以不能因 `fired=0` 声称它没有运行。`team-v13-mechanism-telemetry.mjs:23-32` 的 FIRED_KINDS 未包含这些事件，health 的 dormant 容易误导。

修复要求：保留现有精确失败门禁；新增任务级 hypothesis/attempt/newEvidence 小记录，同因失败且没有新证据时换最小验证方法。明确时间/轮次预算和升级条件，避免把合理复杂调试机械限制为两次。修正 telemetry 的有效触发口径。

### P2-03：goal 的 blocker 文案与实现不一致

官方 `dsh-tool-goal/lib/index.js:196,200,360` 说同一阻塞条件连续至少 3 轮才可 blocked，但实现只检查总 roundsStarted，没有按 blocker 做连续统计；直接人类 turn 跳过该检查。普通用户请求也可以被模型推断成长期 goal，默认轮次上限 256，见 `dsh-goal/lib/index.js:588,593`，不代表实际必跑 256 轮。

修复要求：精确实现同 blocker 连续计数或纠正文案；为长期工作记录实际进展、失败原因和无进展预算。没有现场 goal 轨迹归因之前，不把全部高消耗归罪于这个默认值。

### P2-04：验证和协作成本没有随风险收敛

角色 `lead.md:10` 和 `member.md:9` 要求先进入 Room；官方 Team 提示词要求 review/run tests，但缺少风险分层。当前已有 `verification_plan` 和 exact-SHA 复用建议，角色文件有提及，实际使用与节省需要专门统计。

修复要求：明确单文件/局部修复、共享契约变化和部署验收三类最小验证；同 hash/revision 的合格证据可复用；只有新修改、失败或剩余风险扩大验证。保留必要权限/lease/验收边界，减少没有接口争议的小任务反复 Room、重扫全仓、生成一次性脚本和重复全量回归。收益需要按实际测试与通信调用分类验证。

## 最新业务请求的负载证据

来源 `home/usage-ledger/requests-4204-391f87b1-912d-4145-868c-b63654f94634.jsonl`。按 requestId 去重 terminal，仅计 workspace=RustMc；时间为 17:04:29.598–18:10:12.747。

- 336 次 success，root 53、后代 283，共 9 sessions；另 16 条 terminal 不具备该 workspace 过滤条件，未混入。
- reasoningEffort：high 332、未知 4；context-workspace transform：unchanged 332、字段缺失 4、applied 0。未知不能按关闭或零成本填充。
- 累计请求 payload categories 为 248,563,517 字节：system 34.44%，历史 assistantReasoning 24.43%，工具调用参数 13.45%，toolResult 10.93%，Team 注入 7.99%，其他注入 5.92%，assistantText 2.11%，其余 0.72%。

这些是包含重复历史的发送字节占比，不是精确 token 或费用占比。它说明持续携带的 system、历史思考、参数和 Team 信息都需要治理，不能只压缩日志。high 分布也不直接给出新增 reasoning token 数。过去回填的均值约 30 万 prompt tokens、95% cacheRead 是旧统计窗口，见 `usage-audit-20261001/README.md:27-50`；不要与本窗口合并外推收益。

思考优化建议先在隔离同类任务对照：简单查询/记账/搬运是否能用较低档，复杂架构与难调试保留 high。档位变动可能影响中转缓存，必须同时看轮次、质量、cacheRead 和实际费用规则。本文没有修改全局思考档位。

## 压缩提示词已经做什么、还缺什么

基础摘要 `dsh-compaction-basic/lib/index.js:243-277` 已有目标、技术、文件、错误修复、Pending Jobs、Current Work、Next Step、Critical Context，并要求合并旧摘要。成功压缩后 runtime 也会按 epoch 强制补发 Team baseline，见 `team-v12-runtime.mjs:1859-1868,3131-3172`。不能把它说成完全没有恢复机制。

仍缺少稳定的计划文档登记与读取闭环：本轮范围内没有 `path + sha256/revision + compactionEpoch + readReceipt` 联动，planId 经常只是 taskId，投递回执记录消息提交。摘要本身没有可核验的“已完成且已验证 / 当前阶段 / 未完成 / 必须长期保留 / 需重读文档”状态表。

建议结构化 checkpoint 固定这些字段，并保持它们能从权威任务与证据重建。压缩后只取回当前阶段相关的计划条目、用户持久约束和近期决定；资料版本改变或发生压缩才重新校验，避免每个 step 重读全量大文档。CLM memo 可保留分析记忆和假设，不能覆写权威任务状态。

## 推荐施工顺序与验收

1. 先修 P1-01 至 P1-05 的确定性反例，建立按真实返回结构和数据边界的聚焦测试。
2. 登记当前计划的验收项与文档 refs，补恢复读取、最终交付回执；把“已实现”“已验证”“已启用”“部分完成”分清。
3. 更新共同角色与具体身份版本/哈希，加入简短 CLM、收敛、验证复用规则，核验旧成员 next-turn 真实注入。
4. 新隔离官方 PTC 会话实测：自然写 memo → 改决定 → checkpoint → 压缩 → 按当前计划恢复 → 处理变更 → 逐项验收；另测缺 revision、过期文档、债务预算恢复、异任务证据和同错误换脚本。
5. 再比较相同工作基线/改进后的 root+全部后代请求数、输入/缓存/输出、耗时、重复工具、重试、遗忘与漏验收。A/B 合格后再评估业务投影与有界历史整理，不声称任何预定百分比节省。

## 当前运行态限制

18:15–18:17 的瞬时采样未发现此前 PID 4204/16440 或对应监听。health 文件的 healthy 来自 18:10:13.914，最新 ledger 截至 18:10:25；不能当作当前在线证明。用户说重启后继续，本轮继续审计，不擅自启动服务。本文的近期调用、身份与 SDK 结论属于留存的真实运行证据；当前进程加载状态仍需在下一次实际部署或会话验证时重查。

## 源码指纹与恢复入口

| 文件 | 审计时 SHA256 |
|---|---|
| home/AGENTS.md | `169409E890F7EC1D4323C40E39C277A2C237E3718324AD2A6AD1FA56E8322C43` |
| home/team-roles/identity-version.json | `5643A91E97DC95AEE5200C5444104CB45CBCF57E0BAAC822B2F57F4583F1DFC2` |
| home/team-roles/AGENTS.md | `1DBBEBF8BF79D67BF3F90E8ABB85600F28EF1632CE594189F76C3DD5AFCA7D3F` |
| web/cordis.patch.yml | `A8769067907859D85D6722F8614D63B499B4C0B4A24978C19A6EE2E8EB54C0C6` |
| plugins/context-workspace.mjs | `2DF427EBEAF05BF5143EF9D0E21F7EBCAE9F1666E51E8948C225B7F6D43336B9` |
| plugins/team-v14-memory-anchor.mjs | `C314A3BB5FE22AAA286D24CA3BE3D6322134D4BF6B4EA0906B7FAA87E1893407` |
| plugins/team-v14-context-delivery.mjs | `1B630D12A0C80FC110CB9320C2AD08A8D8391E10D6A7E89FB81C8EFA730F6ED8` |
| plugins/step-compaction-v4.mjs | `1939379DD0C23528E4DC35FF2270EFAA99D5DB67686F54752132146506012335` |
| plugins/team-v12-evidence-scheduler.mjs | `DE2AC8658F58FAD1A66CA308061192F5DD925A64E16745A7B4007816EEA1B776` |

恢复时先读本文，再读实际最新 profile、角色清单和相关原始证据。此前 CLM/Reducer 已实施范围见 `D:/dsh-test/docs/architecture-review-20261001/implementation-ledger.md` 与 `change-summary-20261001.md`，历史 usage 见 `D:/dsh-test/docs/usage-audit-20261001/README.md`。本文记录审计结果与待实施建议，不把建议当作已修复或已上线。
