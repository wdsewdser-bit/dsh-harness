# DSH 上下文、恢复、验收与即时转向统一施工规范

> 当前状态入口：[docs/CURRENT_STATE.md](../CURRENT_STATE.md)（2026-10-12 起）。下面到第 1 节之前的各段“补充”是按时间倒序保留的历史记录，其中的回归数字和启用状态都已被后续覆盖；本文件里仍然有效的状态只看第 16 节的登记表。

2026-10-05 07:03 UTC 补充：P1-06 的持久门禁补上此前 WeakMap/WeakSet 无法跨冷恢复的缺口。五条原始反例分两轮实红；现在先持久化 session 的 policy/目标验收要求，再提交控制面 binding。冷恢复缺插件、门禁降级、目标改变沿用或重绑旧计划均拒绝；暂停/恢复且目标未变保持合法。真实 JSONL、故障边界、Team tool、原生 GoalService 及实际 Typert UI Remote 完成入口联合83项通过，日志 `context-runtime-goal-durable-final-r1-20261005.log` SHA256 `083D427E8CB7FE717D5DD07ED2C2225A9F45BD10CDB11A472C5C13BFF05FAFA7`。这是核心服务/远程入口验证，不冒称普通会话完整轻量计划接线、无goal最终文本门禁或浏览器验收完成。新共享源码须新全量；生产仍未部署/HMR，整体partial。

2026-10-04 23:17 UTC 补充：四角色自然family八请求及独立Jsonl回读accepted，role-A/B下一轮、原生flat parent与实际tier、当前身份hash、八终态usage与canonical逐字段一致；全部completionAllowed=false。root+三后代Total236649，费用/cacheWrite/reasoning未知。黄金15类篡改与预算联合19项通过；详见 `team-family-identity-usage-20261005.md`。这是身份版本对照，非成本A/B，common动态语义与非Team/UI最终门禁等仍partial；不重复成功provider实验。r13不包含后加的黄金测试，运行时共享source未变。

2026-10-04 22:54 UTC 补充：子代理投递的耐久Promise传播、pending关闭顺序、cold恢复Agent引用和父结算通知已修，三项原始反例先红后绿，32项底层聚焦及6项真实host离线/API延迟落盘/错误清理通过。最终JSONL冷读保留完整运行前缀与原生teardown附加事件，不删末尾记录；独立verify accepted、externalRequests=0、providerAccepted=false。当前83条manifest无漂移，74个JS/MJS语法通过。冻结后209入口全量r13为1179tests/1178pass/0fail/1既有skip，日志SHA `9C714A9E32D5DD2E0E12F0DB4D76AB7821EF33EADE88D8540D7BFAB7CBB727F8`。以下旧“待收”状态是历史记录；新四角色自然实验仍待本轮有界验收，整体E0-E8 partial、生产未部署/HMR。

2026-10-04 12:48补充：AgentRegistry真实创建/恢复writer生命周期已修；实际四角色零模型bootstrap通过，native-owned-child route证书读取已保留ownership边界。首个自然family在旧driver下发现合并quiet通知未消费原队列，重复provider请求达到8上限，原日志保留、不当accepted。新增原始反例先红后绿；driver现在把实际claim的ID随最后一条已交付user/message原子提交，兼容非native/旧日志，projection stateVersion=3，later arrivals不被误消费，实际JSONL冷读通过。当前39项联合聚焦（含actual API direct/queued steer、live writer、Agent生命周期）绿。冻结后208入口全量r12仍运行，不先报全绿；生产未部署/HMR，旧自然W2/Instant记录不自动继承此driver变更。整体E0-E8仍partial；无需假称goal resume（当前goal usageLimited，但用户已授权12:12续跑）。

2026-10-04 10:04补充：三次官方Basic模型摘要与最新tail纠正、原始tool artifact恢复已在同一原生持久会话通过cold磁盘独立回读；matched无压缩baseline也独立accepted。实验root `f441444d-9bfe-48b4-8919-ef6597bd4018`，原自然9requests中恢复读因实验接线漏tools/result失败，宿主重建后仅追加2requests修复读取（总11，旧失败和日志不删），3次摘要不重跑。最终4pages+assemble及SDK真实parent、整包后继投递、plan path/hash/8标题/prohibition、newestscope、remaining4/completefalse/pendingpreserve、所有rawprefix均验证。baseline root `51e32d51-133b-4fa6-86b9-48d3ec462f1a` 6requests/0summary，三恢复轮同样通过。共17成功场景请求，另首个引擎依赖夹具失败的2provider请求亦保留，不宣称稳定收益/费用或全Team。实验历史result.accepted=false因验收器未识别原生沙箱固定尾注保留，以新cold offline-verification accepted为准；解码仅允许精确固定尾注，11类source/parent/dispatch/falsecomplete/tail等篡改拒绝，最新6项pure+actualcanonical测试通过。源码与profile共享模块自r11未变，仅新runner/verifier/tests更新。N-01仍是本单fixture已验，不代表全部强制恢复/缺项debt/live业务覆盖或生产启用。

2026-10-04 09:35补充：r11已真实exit0，205入口、1157tests/1156pass/0fail/1原有skip，157682ms，日志SHA256 `F19A4BD4A04F970D38B38325B809B4698D484BB8C867AE25F91232DA461EEC44`。r10保留为模块退出失败证据，不改历史；该模块无诊断复验9/9正常退出，当前未证明挂起根因，不因此改无关源码。新增三次原生摘要自然A/B runner及三项边界测试已通过，实际原生引擎/宿主bootstrap 0requests/hostDisposed；首个实验组正在有界真实采样，不能先标摘要质量accepted。旧4/6请求限额不变，新场景单组12req/2048output/256KiB/180s wall/215s process，两组串行，保留fixture-seeded-history/root-only范围，非完整后代Team A/B。新runner在r11之后新增，单独验证，不声称r11覆盖它。

2026-10-04 09:13施工补充：Instant实际provider单case已由原生磁盘独立回读accepted，非完整A/B。当前新增用量原始反例真实3红后修复，账本按原生 `SAMPLING_PREEMPTED` 单独计抢占，hard abort不改分类；取消/中断的零值及非零adapter快照保留为reportedUsage，不冒充完整最终usage，最终未知保持null。真实原生LlmRuntime及账本/经济联合38/38通过；两个模块四logical profile哈希一致，plugin manifest新增真实production before的request-usage-ledger条目，旧before保留。当前205入口全量r10仍运行，日志 `D:/dsh-test/output/context-runtime-canonical-regression-r10-20261004.log`，不能先标通过。历史Instant case raw usage报告不改写；新的分类修复不冒称历史旧进程已采用。生产off，三次模型摘要、非Team/UI finalgate、后代usage/完整A-B与最终交付仍partial。

2026-10-04 08:49补充：真实DS4.1F Instant单case `natural-instant-e2b9f25a-5b8f-4b90-931f-4adfe27afb93` 已独立原生磁盘回读accepted（0额外provider），31events、一次耐久steer/一次消费/一次superseded旧片段、原生因果顺序/后继PTC exact配对/final completed均成立，无旧partial重入。实际3请求，后继TTFT约3110ms，只有root，非完整A/B。历史result中因验收器错用tool/result层级而accepted=false保留未改，以 `offline-verification.json` 新回执为准；验收器最新3项及真实canonical篡改负例已绿。共享模块仍是r9冻结版本，新runner/独立验证文件不在r9的204入口内。旧抢占usage当前1 unclassified terminal、adapter零快照无法证明零费用，须继续修分类/unknown语义；真实非Team、三次摘要、全Team后代/完整A-B及生产交付仍partial。

2026-10-04 08:37补充：r9真实exit0，204入口、1151tests/1150pass/0fail/1原有skip，日志SHA256 `486A9EBC975BC6A98A094C6ECD9CC075DF2B8C5D8CB1C717B2E6D3DB85107D00`。隔离后20项聚焦日志SHA256 `73E294EE9B9BE1E66243B97C75DCFB6282D1DA2A1B6B108378F6B7BE4E8CB84E`。以下“r9运行中”为历史阶段，当前已终态。新增真实Instant runner/verifier测试1/1；实际官方PTC/品牌adapter/当前严格proof/bootstrap已0provider、hostDisposed验，真实采样尚未执行。r9不包含之后新增独立runner/test，不改变既有共享模块已通过结论。整体仍partial。

2026-10-04 08:31最新状态：Instant实际隔离Team API与浏览器插话、冷重启持久会话展开已验；真实provider/非Team/UI最终门禁仍未验。33项聚焦后新增物理隔离门禁，修复后API/Web/wire/隔离联合20/20；当前源码全量r9为204入口，仍运行，日志 `D:/dsh-test/output/context-runtime-canonical-regression-r9-20261004.log`，不能先称green。纠正此前“生产未修改”的描述：staging `dsh-client-ui-chat` 原junction指向生产，两处UI文件曾被误写；已保留修改版本、将staging独立化，并按0406备份恢复生产client.js和chat-nodes.d.ts，逐hash确认。24项native/9项tools manifest实际回读drift0，所有已改原生文件真实路径位于staging，before与生产恢复后基线一致。无重启/HMR/活跃Team中断；生产运行进程是否曾缓存这两处UI变更未知，不以磁盘恢复声称已加载状态。全目标保持partial，旧阶段记录按各自时间线解读。

2026-10-04 03:54最终补充：当前Instant幂等抢占源码适用全量r8已真实exit0，200入口、1136tests/1135pass/0fail/1原有skip，日志 `D:/dsh-test/output/context-runtime-canonical-regression-r8-20261004.log` SHA256 `16EAFA88216B542FFAEDE7BDAA7677072F1B3BF9584BDCE2996AA5A547B6DD32`；native/plugin/tools共59条hash readback drift0。下段“r8待收”为先前阶段记录，现已终态。W2旧自然成功仍是该bridge变更前证据，当前Instant不冒称provider/UI已验；下一项I-02重连accumulator缺generation/superseded终态保留的实修尚未开始。整体仍partial，不部署或标complete。

2026-10-04 03:50最新状态：W2隔离端到端及真实官方PTC三轮/6请求恢复accepted，独立canonical回读accepted；证据 `staging/context-runtime-unified-20261001/lab-runs/natural-window-native-20261003-2216/offline-verification.json`。原文、两轮retention、真实live writer/maintenance、prepared/committed宿主重建、当前权威晚于历史checkpoint、全原artifact投递及读取债务解除均已验证，仍是root-only单case，不是完整Team A/B或生产接受。此前源码全量r7为200入口、1132tests/1131pass/0fail/1原有skip，日志 `D:/dsh-test/output/context-runtime-canonical-regression-r7-20261003.log` SHA256 `A35FB10F771A7972F47A5B1FC1A11DA98066B18D98910105641E44F7AD24E878`。随后Instant输入幂等和合并flush原始反例已先红后绿，七入口98/98；当前新增源码全量r8待收，旧r7不能覆盖后续修改。整体仍partial/生产未部署，Instant/UI、摘要质量、实际后代usage和最终HMR/evidence/root通知未完成。

2026-10-03 20:08最新状态：当前源码适用全量r6为197入口、1101tests/1100pass/0fail/1原有skip，日志`D:/dsh-test/output/context-runtime-canonical-regression-r6-20261003.log`，SHA256`BC1CF968158F1E71183F6E9ADE9245FB1B9F5D12116F42EB115F636C8A1983F5`。服务端history assemble已通过真实NodePTC父子调用、实际原文包adapter投递和控制面读取债务解除；自然DS4.1F受限4请求及独立回读均accepted，证据`staging/context-runtime-unified-20261001/lab-runs/natural-history-assembly-20261003-2003/offline-verification.json`。原有同输入单对SDK恢复质量A/B仍是历史证据，不把新单case称为整套A/B。这不是完整自然链、W2、Instant/UI或生产接受，整体仍partial/未部署。下方各旧回归为历史阶段记录，不能当最新状态。

2026-10-03 15:52补充：最新完成全量r4为194入口、1073tests/1072pass/0fail/1原有skip，日志context-runtime-canonical-regression-r4-20261003.log，SHA256 C15CB0BAC3DF46497B2AB0B63756690B4C29226DE65E1E97BC76D81AAE2678DE。随后W1 forwarded actor/checkpoint安全边界补丁已通过45项聚焦，未重跑全量；整体仍partial、生产未部署。自然W0官方PTC四dispatch/two turns及独立exact恢复已accepted，W1自然协议/质量未accepted。下方旧全量描述为历史阶段证据，不代表最新源码全量覆盖。

> 【已过期，2026-10-12 标注】下一段的“W2/Instant尚未启用”是 2026-10-03 的状态。W2 多段窗口已在生产以名单模式启用（1 个会话），Instant + PTC 后台已在 staging 验收、生产未部署。原文保留如下。

版本：2026-10-01 / reviewed-2，施工状态更新至2026-10-03。计划状态：**reviewed，E1/E2 staging canonical回归通过；真实隔离主机消费验证准备中，W2/Instant尚未启用**。本文件是施工规范，不是实施完成报告。已完成针对数据一致性、投递与副作用竞态的一次独立审查，按第16节记录接口前置阻断；E1正确性修复可继续，W2/Instant不能跳过接口证明。不增加一次用户批准环节。

最新适用全量：192入口，1052tests/1051pass/0fail/1原有benchmarkskip，canonical staged native preload，日志`D:/dsh-test/output/context-runtime-canonical-regression-r3-20261003.log`，SHA256`643BA7A4C10D8F0B52FE6D9EF6BD85CE78E1167AD53A7DF92A87FCC91FE90669`。保留旧红回归作为历史证据，不以fixture通过代替自然业务启用。全量之后更新隔离主机provider准备器和真实Agent安装依赖：Responses路线准备8/8；新Team依赖反例及runner边界联合30/30，runner验收另3/3。已真实启动隔离主机并完成首个DS4.1F官方PTC静态探针：2个adapter terminal、1个run_code及exact最终回答，canonical离线复核通过；不是完整A/B或平台启用验收，文件沙箱能力partial。证据`staging/context-runtime-unified-20261001/lab-runs/natural-static-20261003-1139/offline-verification.json`。全量结论不覆盖之后的修改。

## 1. 目标、范围与事实等级

目标是让长期 DSH Team/Session 在多个可恢复的模型窗口中继续同一完整任务，保持有效指令、原始证据、工具副作用和验收事实，并及时响应运行中的用户转向。利用现有 PTC、控制面、context-workspace、RequestPlan、projection、durable journal 与事件续跑体系增量实现。

成功必须分开记录 implemented、tested、enabled、accepted、partial。写入代码或提示词只证明 implemented；静态测试不证明真实请求采用；一份局部 fixture 不证明业务收益；关完当前任务卡不证明计划没有遗漏；设计中的 proposed API 不是当前已存在的接口。

事实等级：

| 等级 | 含义 | 本计划使用方法 |
| --- | --- | --- |
| audited | 四主文档记载的源码/纯函数/历史真实请求证据 | 作为定位入口，施工前核对当前文件、加载模块和请求回执 |
| parent-verified | 本轮主代理补充的现场证据 | 与旧审计区分，登记采样时间、路径和 hash 后成为施工基线 |
| proposed | 本文的状态机、字段、门禁和阶段设计 | 实施前适配现有 schema，不宣称已有实现 |
| unknown | 未获得真实接口、价格、当前基线或运行结果 | 保留 unknown/null，不默认通过或填零 |

本轮规划代理只读取资料并创建本文件，未实现业务代码、修改配置、历史、角色或 Downloads 文档，未执行模型 A/B。

### 1.1 硬边界

- 不重启 DSH，不中断或杀死 active Team/member，不因实验取消用户运行任务。
- 不修改 RustMc 产品仓，不清理旧 journal、telemetry、spill、session、usage 或 fixture 数据。
- 不把 W1/W2/W3、Reducer、opportunistic compaction 或 async PTC 全局自动启用；部署状态逐项登记。
- 本施工当前无 `D:/dsh-test` Git 基线。采用范围明确的备份、文件 SHA256 manifest、staging 和逐文件回滚，不虚构 commit。
- 四个 logical profile 可能由 junction 指向同一物理目录。必须先解析物理路径和实际加载实例再写入，不按四份独立目录处理。
- 业务写入、配置、角色与官方安装包改动由主代理施工阶段执行。本规划子任务仅允许写本文件。

### 1.2 来源编号与取舍

| 来源 | 路径 | 用途与优先级 |
| --- | --- | --- |
| S1 | `C:/Users/<user>/Downloads/DSH_Codex三项能力实施设计_当前Fork实装版_v2.md` | 当前 fork 能力、W0-W3、请求投影、缓存经济、async PTC 主设计 |
| S2 | `C:/Users/<user>/Downloads/Codex_Instant_Interrupt_机制与Agent实现设计.md` | sampling preempt/turn abort、输入队列、重试抢占、UI partial 与工具边界 |
| S3 | `D:/dsh-test/docs/prompt-memory-audit-20261001.md` | P1-01 至 P1-06、P2-01 至 P2-04、身份和真实 CLM 缺陷 |
| S4 | `D:/dsh-test/docs/native-ptc-compaction-ds41f-audit-20261001.md` | 原生摘要、compactNow 留尾、DS4.1F 协议与隔离测试 |
| S5 | `C:/Users/<user>/Downloads/DSH_Codex三项能力实施设计_基于PTC与Session架构.md` | 上游 Session/Query/durability 的设计背景，不能覆盖 fork 事实 |

S5 的通用 Instruction Registry 和阈值 0.78/0.86 不机械落地；按 S1 先修现有身份/权威投递。S1 第一阶段遗漏的 P1-01、P1-06 由 S3 补为强制正确性工作。S2 的 generation/admission/native-steer 是工程建议，Codex 源码事实不直接证明 DSH 已支持。S4 的官方接口历史协议不是本地中转的 wire 兼容证书。冲突以当前实际加载源码、canonical journal、请求回执为准，更新登记而非强行套旧文档。

## 2. 已有能力与待建边界

| 能力 | 资料证明已存在 | 仍需施工/验证 |
| --- | --- | --- |
| PTC | 官方 run_code、nested guards、one-shot、canonical subcall receipts、concurrencySafe | 保留默认；async 需求门槛与事件驱动扩展；steer 生命周期解耦 |
| Context Workspace | state/memo_put/get/diff/propose/preview/commit/rollback、ACL/CAS/TTL/locator/hash、memo view | action schema 修正、自然采用、窗口/checkpoint/transition；当前 memo suffix 没有替换 transcript |
| Request Projection | preview、prepare immutable snapshot、onDispatch、audit/capture、purpose 限定 | window transform、协议证书、receipt 字段和实际请求对照 |
| SDK/ObservationPack | SDK retention、部分观察投影、compatibility certificate | 当前包版本、transform 顺序、conversation/compaction 覆盖重新验证 |
| 身份/恢复 | identityVersion/hash handoff、memory anchor、baseline 注入、context debt | notice/body/fetch 分离、字段级截断、计划读取闭环、next-turn 身份 |
| Team 验收 | plan/phase/lease/commit/evidence 检查和 delivery_check | exact task/contract/tree 绑定、完整计划覆盖、最终完成表述绑定 |
| Compaction | 官方 basic 引擎、八段摘要、surface replace、原日志保留 | ContentBlock 返回解析、摘要覆盖、manual retain policy、恢复入口统一 |
| Window Manager | 可复用地基 | W0-W3 均属于待建/待验；不可把 memo apply 命名为 W2 |
| Instant | S2 对照设计 | DSH queue/stream/abort/tool/UI 的集成与 race 验证均待建/待验 |

主代理已反馈：四个关键插件当前 hash 与旧审计匹配，说明旧缺陷未因这些文件变化被覆盖；这不是当前进程已加载相同文件的证明。历史回归 `679 total / 673 pass / 5 knownfail / 1 skip`，更新平台台账是 `688 / 682 / 5 / 1`。两者是历史口径，不能继续当作本轮基线。

本轮主代理新取得现场基线（parent-verified）：147 个测试文件，`688 tests / 686 pass / 1 fail / 1 skipped`，唯一失败 `architecture-tests/live-lab-runner.test.mjs:128`，原因 `SCHEMA_DRIFT`。完整日志：`D:/dsh-test/output/context-runtime-unified-baseline-20261001.log`。施工以此命名失败对照新回归，仍不能以数量相同替代具体失败定位。

本轮运行采样（parent-verified）：新 DSH 监听 `40123`，PID `11516`，本机 StartTime `2026-10-01 20:50:25`；RPC `session/list` 可读 480 sessions，原 root 仍在列表。旧 PID `16440` 不作为当前实例。RPC 列表只证明会话存在，不能推断原 root 正在执行或所有成员已加载新插件；每次涉及部署仍检查真实目标实例与安全边界。

## 3. 需求追踪与依赖

以下 ID 作为施工/验收索引。状态 `planned` 表示本文已定义、尚未实施；conditional 表示需满足触发条件后实现并保持 opt-in。不得在合并计划时丢掉来源中的强制项。

| ID | 需求与来源 | 当前状态 | 前置依赖 | 必需验收 |
| --- | --- | --- | --- | --- |
| B-01 | profile/源码/加载态/基线快照，S1/S3/S4 | 完成：基线、备份与哈希清单齐备；生产 disk/loaded/consumed 三层已核验（10-06） | 无 | 物理路径、hash、活动实例、当前回归登记 |
| P1-01 | 防跨任务旧 commit 误验收，S3 | 已部署生产（10-06）；staging 反例通过；生产未专门做跨任务旧 commit 反例 | B-01 | foreign task、旧 tree、契约变更拒绝；合法复用通过 |
| P1-02 | debt notice 不吞正文，S1/S3 | 已部署生产；真实 Team 任务中实际触发：回合中途增量额度放不下必送内容而拒步 4 次，已修（改用整包额度）并调大额度配置 | B-01 | 小预算 notice 后大预算正文真正恢复 |
| P1-03 | 关键字段截断显式 debt，S1/S3/S4 | 已部署生产；exact 取回未在生产专门验证 | P1-02 | 长验收中间/后段限制可 exact 取回 |
| P1-04 | compaction summary ContentBlock 解析，S3/S4 | 已部署生产；两次真实 Team 任务共 49 次压缩的摘要均被正常解析 | B-01 | 实际引擎对象与无区间/失败分类 |
| P1-05 | 产品与平台恢复 refs 统一，S3 | 已部署生产；自然压缩后的产品恢复 refs 未专门核对 | P1-02/03 | 产品恢复不跳到平台计划，版本读取回执 |
| P1-06 | 完整计划及最终 delivery gate，S3/S1 | 既有服务已部署；2026-10-11 strict 空计划门禁 staging 完成：66聚焦、1468全量通过、无goal真实host/browser及冷恢复已验；新strict包未部署/启用生产，完整需求计划是否已登记仍须逐根核实 | P1-01/02/03/05 | 十项六项完成拒绝整体 complete；partial 明示 |
| C-01 | CLM action schema/成功语义，S1/S3 | 已部署生产；apply / 窗口恢复未验 | B-01 | memo_put CAS 合同与真实 put/get/commit |
| C-02 | common/role 身份 next-turn，S1/S3 | 已部署并启用（activeIdentity + hostBootstrap，10-06）；两次真实 Team 任务（11 与 42 个会话）在其下运行；common 动态语义仍 partial | C-01/P1-05 | 旧 lead/member/verifier 真实下一轮有效版本 |
| C-03 | 收敛/失败假设/goal blocker，S3 P2-02/03 | 已部署并启用（hypothesis.enabled，10-06）；自然成员消费未专门核对 | P1-06 | 同因换包装无新证据识别、blocker 连续计数 |
| C-04 | 验证与协作证据复用，S3 P2-04 | 已实现 v15 证明锚定的复用上下文并部署（10-06）；生产命中率未统计 | P1-01 | exact tree/recipe/env 复用与失效 |
| N-01 | 原生八段摘要契约与锚点，S4 | 已部署生产并实际使用；步边界压缩（引擎 auto）后的锚点校验与恢复通知 10-07 补做中 | P1-02/03/04/05/06 | 三次压缩、纠正/尾巴冲突、缺项 debt |
| N-02 | compactNow configurable safe tail，S4 | 已部署生产；默认保持旧策略 | N-01/B-01 | manual/pressure/overflow 分支真实保留区间 |
| H-01 | exact history recall，S1/S5 | 代码已部署，生产未启用 | P1-02/03 | 被 shadow 原文与 hash/seq exact 对照 |
| W-00 | W0 checkpoint/window shadow，S1 | 代码已部署，生产未启用 | P1-01 至 06/C-01/H-01 | 权威覆盖、refs、纯 preview、raw 无变化 |
| W-01 | W1 隔离 request projection，S1 | 代码已部署，off。30–60k 两臂实验：成本 +71%、无质量收益，结论为不作常规手段，仅保留 W0 影子 | W-00/N-01 | 协议/quality/immutable/onDispatch/raw gate |
| W-02 | W2 durable intent + surface CAS，S1/S5 | 提交改为乐观校验（10-06，oracle + reviewer）；真实运行 100k 3/3、300k 3/4、500k 3/3，改造后 5/5；已作为休眠代码部署，生产无调用方，接线未做 | W-01/C-02/H-01 | 各故障点恢复、并发修订、pending 不丢 |
| W-03 | W3 cache-aware policy，S1 | 新增纯判断函数与影子观察插件，生产 shadow（10-07）；两次真实任务 293 条影子决定，修正去重与“刚压缩完误判缓存已冷”；auto 未启用 | W-02/T-01/A-01 | 无价格拒绝经济 auto，稳定 cache 和质量 |
| I-01 | Instant queue/step preempt/abort，S2 | 代码已部署，生产 off；状态同前（完整竞态 partial） | B-01/P1-02/H-01 | lost wakeup、stream/retry race、ordered durable queue |
| I-02 | 工具 admission/partial UI/events，S2 | 代码已部署，生产 off；状态同前 | I-01/P1-01 | 旧 generation 不启动新副作用；已启动结果对账 |
| I-03 | Instant 与 window/compaction 联动，S1/S2 | 代码已部署，生产 off；状态同前 | I-02/W-02/N-01 | 同时 steer/transition/abort、replay 一致 |
| J-01 | 用户明确要求的 Instant + detached PTC，S1/S2/S5 | 2026-10-11 scoped staging已实现；16项runtime、真实Web UI和原生Team+1child消费验收通过，同一个已启动实例转后台不重跑；生产保持off，真实provider质量/交互approval/独立审查尚待 | I-02/T-01/现有 job 审计；ptc-background-20261011.md | receipt/outbox/resume/unknown/no polling |
| T-01 | telemetry/usage/quality，S1/S2/S3/S4 | 生产运行中；用量台账已用于触发规则回放与缓存寿命测量 | B-01 | 全 Team 口径、unknown、dispatch 与 terminal 区分 |
| A-01 | 官方 PTC DS4.1F 有界 A/B，S1/S3/S4 | 有界 A/B 完成（bounded-AB-20261006.md、大上下文批次）并跑了两次真实 Team 任务；Instant、真实后代场景未覆盖 | 各被测阶段聚焦检查 | 真实 route/wire、自然会话、负例、质量与成本 |
| D-01 | 安全同步/HMR/交付回滚，S1/S3 | 已执行：每次生产改动均有备份与回滚命令（见 execution-ledger）；回滚从未演练；teamtest 未单独核验（其 plugins 为 web 的联接） | 每阶段验证 | disk/loaded/request 三层证据，阶段启用矩阵 |

状态列于 2026-10-07 按 execution-ledger 更新（Claude）。表外新增、不属于原需求的生产改动：里程碑折叠下限 20 万（`minMilestoneFoldTokens`）；包额度 `tier0ContextPackMaxTokens: 16000`、`contextDeltaMaxTokens: 6000`；拒步原因落盘 `pre-step-rejects.jsonl`；硬上限由引擎在步边界执行（各 preset `compaction-basic` 设 `auto: true, thresholdRatio: 0.75`，取代原 `milestone-only`，因真实任务中一个不空闲的长回合越过 75% 涨到 91 万后无法压缩）。

2026-10-07 晚间追加（Claude，详见 execution-ledger 的“检查点（10-07 约 18:30）”）：

- **请求预算准入与超窗恢复**（已部署）：已知超预算的请求不发出；被拒的步当场把认领的输入放回收件箱并延时自唤醒，引擎在下一回合的步边界压缩；接近窗口的 provider “参数被拒” 400 改判为超窗；预留输出按路由真实上限 128000，余量 32768。
- **窗口计划投影**（已部署）：`team-v15-window-plan.mjs` 从已批准任务计划派生并发布 `state.v15WindowPlan`，窗口引用它而不要求注册 v15 交付计划；覆盖声明区分“需求清单未知 / 有已知需求无任务 / 已知需求都有任务”。交付门（P1-06）仍只对注册了计划的 Team 生效，真实 Team 目前没有注册。
- **W2 生产接线**（已部署，`scope: list`，仅一个测试 Team 根）：`team-v15-window-wiring.mjs` + `team-v15-window-executor.mjs`；空闲压缩先问窗口、被拒回落压缩；操作员命令 `/window status|fold`；“≥50 万 token 在下一个空闲边界折叠”成为真实触发（`proactiveFoldTokens: 500000`）。生产端到端已验证提交、切窗后的真实请求、带窗口的热重载交接、主机重启恢复。
- **W2 对真实 Team 根（team-roots）未开启，且不应开启**，直到检查点权威瘦身：实测 2 个任务的小 Team 权威 68KB、提交事件存两份、每请求再附 72KB，小会话切窗后反而变大；大 Team 会越过 256KiB 权威上限，已有窗口的会话届时无出路。
- **生产缺口**：请求的官方代理循环标记在另一份 dsh-llm 模块实例里，投影服务看不到，`team-context` / `plan-read` / `history-recall` 三个投影在真实会话上从未生效。只为窗口采集器开了跨副本识别（`isAgentLoopRequestInAnyCopy`），其余待用户决定。

可以独立推进 P1-01 的纯函数修复与 P1-02/03 的 delivery 模块，但共享 runtime、配置、身份清单、profile 实体写入由主代理串行合并。W2 与 I-03 共享 session revision/input cursors/transition coordinator，不能独立写两套状态机。

## 4. 数据契约与确定性验收

### 4.1 P1-01：证据覆盖键

覆盖键至少是 `boardId + taskId + requirementId + contractRevision + planRevision + sourceIdentity + environmentFingerprint + recipeFingerprint`。Git 产品使用 exact commit 加 working tree fingerprint；没有 Git 的 DSH 平台使用 SHA256 manifest/tree identity，不把 absent commit 当任意匹配。控制面 lease/owner scope 在验收时仍有效。只按 `ac-1` 查 passed 属于禁止路径。

passed evidence 必须对应正确任务与当前被验对象。沿用旧 evidence 须有显式 reuse receipt，声明原证据、目标需求、适用理由、受影响文件集、兼容环境和有效期；reuse 并非将源 evidence 的 taskId 原地改写。部署验收需要实际入口、加载 hash 和运行环境，不能用单测 evidence 代替。

若 requirement、contract、tree、recipe、环境或测试输入变化，使证据不再成立，结果变为 stale/uncovered，而不是延续 passed。历史 integrated packet 可以只读展示，不自动为当前计划提供覆盖。兼容策略按新增 plan revision 生效，不批量回写旧 acceptance。

### 4.2 P1-06：计划覆盖与交付

在工作开始/接续时登记 planRef（path/locator）、原文件 SHA256/revision、scope、全部 mandatory requirement IDs、用户补充 refs 与显式 conditional 条件。把计划条目映射到任务，而非以目前任务列表反推出计划范围。新增用户约束使 planRevision 更新；只读状态问题不取消原任务。

每项状态保存 `implementationRef, testEvidenceRefs, enablementReceiptRefs, acceptanceEvidenceRefs, remaining, applicability`。这些是独立维度。合法 notApplicable 要保留具体条件、理由、授权来源与审查 evidence；必选项不可被模型自由删成 optional。conditional J-01 若未触发，交付报告写“已评估、未触发、保持关闭”，不能声称 async 已实现。

Delivery receipt 绑定 `planRevision/hash + coverageMatrixHash + task/contract revisions + exact tree manifest + runtime receipts + unresolved debt/blockers + deliveredScope + remainingScope`。gate 在提交时复核来源版本；已生成 matrix 之后 plan/tree 变化则拒绝 stale receipt。请求整体完成只有全部 mandatory 接受且 necessary enablement/真实入口证据成立才通过。

已有 Team delivery gate 作为唯一门禁基础扩展。goal complete、Team delivery 和最终用户可见完成消息通过同一 receipt 校验入口绑定；原始 UI 文本只能作为陈述，不能设置 canonical accepted。对普通非 Team 任务保留与风险相称的轻量计划证据入口，不能通过移出 Team 绕过承诺范围；低影响任务不强制制造巨型验收矩阵。

最终提交接口由既有控制面模块承担（proposed `commitDeliveryReceipt`，不是声称已有）。在 `mutateHot` 同一锁内重读 plan/task/contract/lease/coverage/debt/source vectors，expected vector 冲突返回稳定 `DELIVERY_CAS_CONFLICT`，缺项返回 `DELIVERY_INCOMPLETE`，同 idempotencyKey+同内容返回原 receipt。控制面 durable receipt 为唯一 accepted authority；goal service（安装包当前 `dsh-goal/lib/index.js:706,865`）、Team gate 和 UI 的 completion 请求均接入该入口，goal/session 事件由 durable outbox 幂等补写，不先 goal complete 再尝试保存 receipt。现有 `session.append` 不提供跨域 CAS，工具前置检查不能代替 service/RPC 入口约束。E1 pure matrix 修复与此最终提交绑定分别登记，不以其一验收另一项。

负例必须覆盖：foreign-task ac-1、旧 commit、dirty tree、changed contract、环境/recipe 变化、漏建计划任务、已改未测、测过未启用、仅 packet 存在、goal complete 无 receipt、摘要自称全部完成。正例包括显式合法复用及按已交付范围准确 partial。gate 失败允许报告进展与未完成项，不允许循环无意义重跑测试。

现场已有 `v12-evidence-scheduler` 旧测试刻意期望 task1 的证据默认供 task2 共用，这与 P1-01 新合同冲突。保留该案例，更新为“无显式 reuse receipt 必须拒绝”的负例，并新增“匹配目标/版本/环境/recipe 的显式复用允许”的正例；记录这是授权安全合同收紧及历史行为变更，不能删除测试、跳过断言或仅改 expected 以消除失败。其他无关 baseline 断言不随本次修改。

## 5. Delivery、截断与恢复闭环

### 5.1 P1-02：三种事实分开

Delivery 记录按 `sessionId/windowId/compactionEpoch/sourceId/revision/hash` 定位，并分别保存 notice receipt、正文 request receipt、fetch receipt。状态可为 pending、notice_delivered、content_delivered、content_fetched、superseded、revoked；正文已直接完整注入时不机械要求再工具读取，locator-only 且 requiredFetch 时必须有 exact fetch。

通知只是“有内容缺失”；content_delivered 表示正文出现在最终 prepared payload 并 handed-to-adapter，不表示模型实际理解；content_fetched 表示读取正确 revision/hash 且结果进入有效上下文。生成 projection/在日志提交一个 notice、stream 未迭代、prepare 后 abort 都不够。传输失败的 dispatch 可以记 attempted-delivery；在没有确定模型消费证据时，债务保持未清或允许幂等补发，不能静默退休。

已投递同 hash 不能压住未完成的 fetch debt。预算增加、窗口/epoch 改变或恢复路径进入时重新计算有效覆盖；旧窗 seen 状态不能证明新窗还可见。source 更新将旧 revision superseded 并为新 revision 建 debt；revoked 内容不得再次恢复。迁移旧 knownVersions/cursor 无正文证据条目为 notice-only/unknown，不清空旧数据、不伪造 fetch。

required 来源未恢复时，只阻断依赖它的 mutation、transition 与最终交付，独立工作可继续；safetyCritical 权限/安全来源不全则相关副作用 fail-closed。无限小预算不应产生假恢复，也不能因每轮 notice 引发 polling storm。

### 5.2 P1-03：字段级完整性

投影字段携带 `sourceId, fieldPath, revision, locator, sha256, originalLength, projectedLength, lengthUnit, truncated, requiredFetch`。长度按固定字符/字节单位声明，不混用 token。omitted 同时记录缺行与字段截断；loaded 只表示来源可读，不能等于正文完整，packOk 需与 requiredDebt/coverage 分离。

计划标题、验收条件、决定、持久约束被截断，保留原定位并显式 debt；不通过每轮注入整份巨文档补救。critical 信息在工具输出中间的 pruner 反例纳入验收。全文先 durable，再返回有界片段+locator/hash；即使输出有 head/tail，也不能据此声称中间关键事实已进入 checkpoint。

### 5.3 P1-04/05：摘要结果与恢复入口

摘要解析适配真实引擎 `{summary: ContentBlock[]}`，提取 text blocks 并保持来源，未知非 text blocks不默默丢失。明确区分 completed-with-summary、no-compactable-range、failed、summary-missing、anchor-missing/completed-with-debt。folded 字符串是兼容输入而非唯一返回格式。使用安装引擎对象 fixture 加真实隔离调用验证。

统一恢复入口读取当前 task 的 registered plan/document refs，校验 path/locator/hash/revision/epoch，并记录 actual readReceipt。平台施工恢复当前平台计划，产品任务恢复自己的产品计划；`compaction_status`、自动 baseline、手动恢复和 checkpoint 不再分别返回冲突的平台旧指令。仅在版本变更、epoch/window 变化、覆盖不足时重读相关章节，不能每个 step 无条件重读全部计划。

失效 locator/hash mismatch/无权限/已超 retention 返回明确 debt 或 error。不能以“日志里仍有”推断模型当前已经拿到；不可访问来源不能由摘要猜测补全。

## 6. CLM、身份和行为提示词

### 6.1 C-01：action schema

按 action 明确 required 参数：memo_put 必需 expectedRevision；首次创建 revision 哨兵、更新 revision 读取值和 sourceId/parentRevision 语义由当前实现核对后写到 schema/example，本文不猜首次值。state/get/read 不因全局 schema 误要求写入 CAS。propose/commit/rollback 明确 view revision/CAS/权限。缺 revision 返回稳定业务 code、不产生任何写入；stale revision 不自动覆盖。

成功判定同时检查 tool envelope 与业务 `ok/code`；isError:false 不是成功。canonical receipt 保存 id/revision/hash；成功 memo_put 后才可按该 source 读取。memo/ref TTL 到期和 soft delete 不得摧毁仍被有效 checkpoint 必需引用的内容；transition 引用须获得可恢复的 retention pin 或拒绝并登记 debt。

当前 context view `pin` 只是投影选择标记，不是 retention pin。W0/W2 必需 exact revision/hash 引用应获得独立 recovery retention receipt，或复制为带当前 ACL、durable barrier、完整性 hash 的 recovery artifact；无法取得即拒绝 transition。定义续期/释放、64-revision 上限和崩溃重建；安全 revoke 优先，不能借归档绕过权限撤销。历史 locator 被最新 tombstone/TTL 撤销是当前实现事实，不可当作已解决。

### 6.2 C-02：实际身份链

把短 CLM 契约写进真实 old-member 链读取的 `team-roles/AGENTS.md` 及适用 role，而非仅 home/AGENTS。共同规则包含：阶段开始 state、关键假设/决定变化 memo_put(expectedRevision)、handoff/压缩/window 前更新 working memo、按版本恢复、ok/code 检查、memo 不能设置 task done。

identity-version 清单按实际五文件规范重新生成 hash；先核对身份包自洽，再通过现有 handoff 在下一安全 turn 生效。不得热替换 active step 的 captured identity 或中断旧成员。证据分为 disk version、handoff receipt、实际 next-turn request/journal 内容，逐角色/目标 session 登记；一位 lead 注入成功不证明所有后代更新。

身份 bootstrap 从 current有效 role/identityVersion、task/requirements/decisions、owner/scope/lease/phase、waiting/inbox、current checkpoint/debt 和 pending 用户输入确定性 materialize。tool-registry SDK 更新不当作用户持久 policy。若真实 client developer policy 有需求，复用 durable store 增最小 session/turn instruction domain；不能先造完整第二套 Registry。

### 6.3 C-03/04：收敛与验证复用

persona、Team contributor、PTC、goal continuation、common/role 各自负责一段唯一契约，避免叠加多份同义长规则。官方 PTC 不强制 max，不因 high 多或脚本多就认定浪费；DS4.1F route/档位以真实 wire 回执为准，未经测试不全局降档或删除 reasoning/tools。

新增小的任务级 hypothesis/attempt/newEvidence 记录：同因失败换路径包装仍计入同假设；有新证据、新错误或更小验证可继续；没有新信息与进展时改最小验证方法或升级，不能机械规定所有调试只准两次。保留 exact argument/error failure gate。goal blocked 文案与实现统一到同 blocker 连续计数，变更 blocker 或明确进展重置；用户普通请求不自动扩成长时间 goal。

验证分局部修改、共享契约、部署验收。局部修改用直接检查/聚焦测试；共享数据与并发改动扩回归和故障注入；部署必须真实消费入口。复用证据由 P1-01 exact identity 检查，只有新修改、失败或剩余风险才扩大测试。Room 用于真正的共享 scope/接口/lease 冲突，不以绕过权限减少交流；独立无冲突小工作减少重复全仓扫描、一次性脚本与无信息通信。

telemetry 纳入 failure-recorded/replan-required/repeated-failure-block，修正 FIRED_KINDS 使 dormant 不再掩盖已触发机制；继续保留原统计，不能重置计数掩盖历史。

## 7. 原生摘要与 compactNow 保留

保留官方 basic 引擎和八个标题，在原模板内增字段优先级：完整活跃目标/用户纠正、plan refs/hash、逐项 implemented/tested/enabled/accepted/remaining、真实证据定位、持久约束、已否定假设及证据、当前阶段与下一操作、active jobs、冲突与输入缺口。摘要只覆盖提供的 earlier span；retained tail 可能有较新纠正，不能宣称看过未提供消息。旧摘要事实以新证据修订，不能仅因“旧”而自动失效。

权威小锚点在压缩前确定性编译；压缩后校验 plan/constraints/evidence/recovery 覆盖，缺失补小锚点或 debt。模型摘要仍属 working，不把“established background”升级为验收事实。保持原 seq、summary 来源关系、图片拒绝、配对和并发检查。

分别审计压力、overflow、manual compactNow、milestone 与跨域 `/compact`：库默认压力 retainRatio=0.16，当前官方名 ptc 安装预设 auto=false/milestone-only；manual/overflow retain=0，仍有最后节点和配对扩展，不等于完整近期工作。manual 分支无 pruner，不能把 pruner 反例归因到每次 milestone。

为 idle compactNow 提供安全可配置近期尾巴策略，或在现有 API 不支持时使用局部维护补丁/适配器，保持安装版本与路径 manifest。策略需明确 ratio/最低完整节点/输出预算及 headroom，不把压力 retainRatio 误当 manual 生效。未知 API 先留原行为并登记 N-02 partial，不改 adapter 隐藏分支差异。默认先隔离测试，证据支持后逐 preset 更新；不对 active 会话强制 compact。

至少测试晚近用户纠正、摘要与尾巴冲突、十项只做六项、已改未测/测过未启用、三次连续压缩、长工具中间关键事实、已有摘要错误完成、无区间、失败和未知 block。每例比较 raw input span、实际保留 seq、summary、恢复首轮真实读回执与最终门禁。

## 8. History Exact Recall

复用 `ctx.sessionQuery` 与已有 search/read/trace/locator，先确认当前 fork API。search 输出有界候选 refs；read 指定 sessionId/seq/locator、revision/hash 和可选邻居；trace 给来源链。checkpoint 只保存 refs，按需读旧细节，不全量灌回。

exact read 必须返回原始未裁剪 event/content 或明确分页的全量 artifact，保持 encoding/hash。摘要、head/tail、derived surface 或 FTS snippet 不能冒充 exact。较大数据先返回 locator/范围，分页读取完整后形成 readReceipt；只读第一页不标 full fetched。权限遵循已有 session/Team scope，跨任务资料不自动变成新指令。

验证 shadowed/compacted 原 event 仍可取回、邻居工具配对完整、正确 revision/hash、ACL 拒绝、失效 refs debt、分页完整性、重复 read 幂等。引用 retention、TTL、artifact 生命周期进入 checkpoint 可恢复性检查，不能因 journal 永久而假定所有 context:// memo 也永久。

## 9. Window 数据模型与模式

### 9.1 Proposed checkpoint 合同

```text
ContextCheckpointV1
  schemaVersion, checkpointId, sessionId, rootTeamId, windowId
  planRef + planRevision + planHash
  authority
    activeTaskIds + taskRevisions + contractRevisions
    requirementRefs + decisionRefs + ownerScopeLeaseRefs + phaseRefs
    pendingAcceptanceRefs + waitingRefs + wakeInboxRefs
    planCoverageStates + evidenceRefs
  working
    activeObjective + progress + currentHypotheses
    rejectedHypotheses(evidenceRefs) + nextActions + openQuestions
    memoRevision + freshnessVector
  recovery
    requiredRereads + memoryDebt + historyRefs + activeJobs
  sourceRange + sourceHash + surfaceRevision + criticalRevisionVector
  identityVersion + identityHashes + configFingerprint
  createdAt + checkpointIntegrityHash
```

authority 由平台确定性生成、不能由 memo 编辑；working 可由模型维护但要区分观察、假设和证据。模型说 task done 而控制面 open，authority 获胜。checkpoint sourceHash 固定算法和范围，不用容易变化的整份日志字节 hash 代替相关版本向量。

ContextWindowRecord 保存 mode、window revision、checkpointId、source range、committed surface revision、transitionId、input cursors、reason、created/committedAt；windowId 单调且 session-scoped。不同 session 同 windowId 不冲突；失败 intent 不伪造成功窗口，允许保留 reserved id 并登记 abandoned。

### 9.2 W0/W1/W2/W3

| 模式 | 改变对象 | 启用范围 | 验收含义 |
| --- | --- | --- | --- |
| W0 shadow | 只产生候选/receipt，无实际 request/surface 改动 | 可先隔离，再受控观测 | 不证明 token 节省；候选保留/排除理由完整 |
| W1 project | 最终 conversation request projection | exact 隔离 session allowlist | 降 adapter payload，raw safety 仍权威；不解决 raw native 超限 |
| W2 surface | durable intent 支持的原生 surface transition | W1 通过后的隔离 session | native meter/compaction 看新小窗，journal 仍完整 |
| W3 auto | 自动 continue/compact/checkpoint/transition 选择 | 先 shadow，单独启用 | 不等于所有 window 功能默认生产开启 |

bootstrap 顺序为 current system/PTC 契约、有效身份、权威 task/requirement/decision、owner/scope/lease/phase、working checkpoint、debt/rereads、unresolved waiting/wake/inbox、pending 用户/runtime 输入、完整 safe recent tail。所有动态信息有来源边界，检索资料不升级为规则，不能堆几十轮 summary-of-summary。

### 9.3 Projection、协议与 raw safety

复用唯一 request-message-projection。preview 纯函数、prepare 固定 immutable snapshot、caller 后续 mutation 不影响 prepared payload、onDispatch 才为 handed-to-adapter；aborted/blocked/uniterated 不算实际模型看到。候选 transform 顺序 window 5 → SDK 10 → OP 20 → memo 30 仅是建议，实际依赖审查后锁定 order/configFingerprint；变更顺序重新核验证书。

验证 roles/order、assistant calls/results、tool IDs、DeepSeek 必要 reasoning 历史、unknown blocks、SDK 可用性、pending chain。conversation 与 compaction/auxiliary purpose 分开 allowlist，不把 W1 套所有 LLM 请求。未知 protocol/route/block/证书过期时 projection fail-open 到原 request，并产生 blocked reason；不能自由 flatten/猜测修复。

fail-open 是语义兼容回退，不是放行不安全请求。若原 request 已超 raw gate，原有安全路径继续拒绝/要求受支持压缩；W1 不修改 raw native pressure authority。W2 protocol 不可证明则 fail-closed transition、保留旧窗口。不能以 before/after bytes 直接换算 provider token 或调高模型容量。

## 10. W2 Transition：持久 intent、提交 CAS 与崩溃恢复

仅一个完整 step settlement/idle maintenance 的安全边界允许 transition。未配对工具、PTC unknown mutation、正在权威写入、未持久用户输入、未覆盖 critical revisions、缺恢复来源不能切窗。长 detached job 可按独立 job 记录留在 recovery，但需要证明已启动 subcalls 的边界/回执完整；不能把正在写控制面 job 看作安全只读。

### 10.1 Intent 与序列化域

```text
TransitionIntentV1
  transitionId + sessionId + fromWindowId + toWindowId
  state: PREPARED | COMMITTED | ABORTED | RECOVERY_REQUIRED
  expectedSurfaceRevision + expectedWindowRevision
  expectedAuthorityRevisionVector + expectedIdentityVersion
  expectedPlanRevision/hash + configFingerprint
  checkpointId/hash + oldSurfaceRecoveryRef/hash
  proposedSurfaceHash + transformFingerprint + protocolCertificate
  boundarySeq + pendingInputCutoff + consumedInputIds/cursor
  ownerToken/fencingEpoch + preparedAt + commitReceiptRef
```

窗口 mutex 只挡窗口请求，不保证其他 Team 会话、任务状态写入、身份或 pending input 不变。commit-time CAS 必须与 surface commit 的线性化点一致：复用可串行化控制面 revision API 或同锁/事务域的 revision fence。先 validate 再不受保护 apply 属于 TOCTOU，不能验收。

若跨存储无法原子提交，使用 durable intent + 单调 fencing + redo/undo 协议，明确哪个 record 是唯一 commit authority、哪一个 durability barrier 确认成功；读请求在中间态暂停或按旧完整 view，不暴露混合/空白 view。不能伪称多个 JSON 文件顺序 rename 就是跨域事务。若现有 API 无法提供 commit fence，W2 保持 blocked/关闭，先交主代理修接口，W1 可继续验证。

E5实装前必须登记接口证书：唯一 commit authority、实际 durability barrier、compaction/surface append/inbox claim/identity与authority更新/recovery worker 的 participating writer fence 接入点。当前安装 `dsh-session` 的 append/flush 无 authority expected vector，basic compaction 直接 surface replace；`flush=false`（无durability listener）不得通过 durable gate。只加窗口 mutex 或 intent JSON 不算该证书。

接口证书变更登记（2026-10-06，Claude；oracle 咨询 + reviewer 审查，见 execution-ledger 约 22:20 检查点）：config（宿主）域的 participating writer fence 由“跨两次 fsync 持有全宿主读租约”改为“按修订绑定、在 commit append 点复核”。依据：会改宿主纪元的操作与原先被租约挡住的操作是同一集合（都经 `host-lifecycle.js` 的 `#begin`），而 `team-v15-window-transition.mjs` 从复核到 `session.append` 之间无 await，所以复核与提交是同一步。control-plane 围栏（authority/identity/lease/plan）与文件保护仍跨两次 fsync 持有，未变。提交点冲突按 10.2 第 6 步在同一同步段登记 ABORTED 并解除围栏；校验器缺陷类错误不视为冲突，保持围栏。唯一 commit authority 与 durability barrier 未变。恢复（10.3）仍不替旧提交做第一次落盘。

### 10.2 提交步骤

1. 在安全边界获取 session transition fence，限制新 tool admission；新用户输入可继续 durable enqueue。
2. 捕获 surface/window/authority/plan/identity/config revisions 与 input cutoff；确定必要来源和 recovery refs。
3. 编译 authority、校验 working freshness，读取不足按 P1 debt 处理；memo stale 时同一任务更新，不另起常驻总结代理。
4. 校验 schema、refs/hash/ACL/retention、工具配对和协议；构建新 surface preview/hash 与 old recovery ref。
5. durable 保存 checkpoint、intent PREPARED 和恢复数据，flush/barrier，再 exact read-back verify。此时旧窗口仍可恢复且尚未宣称成功。
6. 进入真正 commit fence，重新 CAS surface/window、全部 critical authority revision、plan/identity/config 与 input cursor。任一变化拒绝并登记 ABORTED，释放 fence 后重新计划；不能仅重写 expected 值绕过。
7. 原子或可重放地提交 surface replace/window-start/intent COMMITTED 与只在此边界消费的 input IDs；所有事件携带 transitionId/idempotencyKey。事务失败对模型不发布新窗。
8. commit durability barrier 和 read-back 成功后发布 runtime/UI receipt、下一 request 使用已提交 window；释放 fence。

pendingInputCutoff 之后的新输入不被 checkpoint summary 吞掉；保留为队列，下一 step 按 acceptance order drain。输入消费 cursor 与写 history 要同事务/outbox 或由原始 durable input ID 幂等重放。绝不先 pop 再 append 造成 crash 丢消息。权限/lease变化也不能借 transition 冻结旧 authority 继续写。

### 10.3 故障恢复决策

| 持久观察 | 必须行为 |
| --- | --- |
| checkpoint/intent 不 durable | 原窗口有效；不提交、不返回 reset success |
| PREPARED、surface 仍旧 revision | 回读校验；来源仍匹配才幂等 finish，否则 ABORTED 保留旧窗 |
| PREPARED、surface 已带 transitionId、新窗事件未全写 | 根据唯一 commit authority/redo 规则补齐；不能再执行一次副作用工具 |
| COMMITTED、窗口投影未发布/缓存丢失 | 从 durable checkpoint、surface records、current有效 sources 重建并刷新 view |
| 第三方 surface/authority revision 已变化 | 不盲目覆盖；恢复到可证明完整 view、登记 conflict/debt，拒绝后续 mutation |
| intent/checkpoint/hash 损坏或不可读 | fail-closed 后续请求/副作用；保留旧可恢复 view，报告 RECOVERY_REQUIRED |

恢复按 transitionId 幂等，fencing 防旧 worker 迟到提交；已 committed 之后原始旧窗只是历史，rollback 生成新 transition，不在原位覆盖已追加的新消息。恢复测试用隔离进程的 fault injection/kill，不针对 live DSH。

最小故障矩阵：checkpoint write/flush/read-back 失败、intent durable 后 crash、CAS 前 task/lease/plan/identity 修改、CAS 与 surface 同时竞争、surface 后/window-start 前 crash、commit 后/UI前 crash、双 recovery、fence 超时旧 worker、tail 中 pending input、100+ transitions/replay、history exact recall。每点检查 journal、authority、window/surface、input 和 tool receipts，而非只看返回码。

## 11. Instant：Turn、Sampling、Tool/Job 的独立生命周期

SamplingPreempt 是用户 steer 或有效 policy change 停当前过时推理；TurnAbort 是明确停止整个 turn；JobCancel 是指定 job 的取消请求。三个 signal/controller 分离。preempt 返回 FollowUpRequired，不计 failed，也不设置 turn completed/interrupted。hard abort 优先，不因 follow-up resurrect。

### 11.1 输入与抢占序列

输入先 durable acceptance，生成 inputId/acceptanceSeq/turnId，再入 queue/outbox 并通知；传输重试按 inputId 去重。watcher **先 subscribe、再查 queue**，所有醒来重新检查 UserInput；普通工具回执/Team消息不默认作为 steer。多个 A/B/C 输入按顺序合批，不每条创建一份旧上下文请求。

当前原生 session/prompt 在 steer/followup 后返回 accepted，未等 session flush；接口适配必须在返回 accepted 前完成明确 durable barrier，失败返回未accepted而保留可重试inputId。原生 claim/remove inbox 在异步assemble之前，必须保留reservation/inputIds，直至user history commit才消费，启动恢复重放未commit claim。故障测试增加 accepted后立即crash、claim后assemble/reject/abort、claim与history之间flush/crash。原生steer仅next-step，不登记为已实现Instant。

每 step 有 generation 与独立 preempt token，watcher 生命周期限当前 generation。LLM 建连、stream read、retry/backoff 和必要 prompt preparation 支持 preempt/abort race；如果某 provider 的建连不可取消，则 fence 阻止结果应用并登记迟到请求/用量。HTTP 中转不支持原生 steer/WebSocket 时采用 close/preempt + rebuild/resample，不模拟服务端 successor。

推荐可追溯顺序：input-accepted durable → sampling-preempt-signaled → old-generation-admission-closed → old sampling terminal/preempted → 已启动工具结果按策略 settlement → input-committed-to-history → capture fresh StepContext → successor request dispatched。存在并行完成时以 canonical seq/因果 parent refs 表达，不能用墙钟强行重排工具事实。输入在 preempt 前已获 durable acceptance，任何 crash 后仍可重放。

下一 sampling 使用 current identity/tool/environment/authority/window，不盲用旧 snapshot；一次有界 drain 后新到输入留下一次。队列和 watcher 无新事实时不触发无限 follow-up，退出完成前再查 pending/user events；hard abort 同时到达则不启动 successor，新输入保留/转入后续 turn 的规则需 explicit receipt。

### 11.2 Tool admission 与副作用

preempt fence 生效后旧 generation 后续 tool proposals 不再 admission；“校验 generation→启动工具”必须在同 admission 线性化边界，不能先检查后异步启动。已经 admitted/started 的工具继续按 policy，不因新输入默认 kill。缺 receipt 不推断没有执行，cancel future 不等于 rollback。

sampling preempt 不abort已启动工具的caller signal。generation admission最终校验/登记放在安装 `dsh-tools/lib/index.js` 的 body invocation 边界，覆盖root与nested PTC，不能仅依赖其前面的异步pre-execute/around-dispatch。当前工具框架在caller abort后用通用ABORTED覆盖body成功结果：hard abort需要独立effectOutcome/reconciliation receipt保留原value/meta/hash，不让cancelled标签抹掉已发生mutation。新增mutation成功后preempt/abort时world state与成功receipt仍可恢复的验收。

| 对象 | preempt | abort/job cancel |
| --- | --- | --- |
| 模型 stream/retry | 停当前请求、拒迟到 generation | 终止 turn 请求 |
| 纯读短工具 | 通常完成并落回执 | 支持取消时取消 |
| 长只读过程 | 可受控 soft cancel/yield | 独立 process cancel policy |
| 写入/外部 mutation | 默认 settle/reconcile | 已发生副作用记录，工具事务明确支持才 rollback |
| detached PTC/job | 保留 running、可 yield handle | 按显式 ownership/policy cancel；不借 turn abort 猜成功撤销 |
| history/receipt/telemetry durable flush | 尽力完成原子提交 | 不因为 abort 删除审计结果 |

V1 可保守 drain 已启动普通工具后 resample；若长工具使 steer 响应无界，必须报告这一限制，J-01 需求门槛由真实日志触发。不能为了“即时”脱离 mutation 对账就开始依赖新方向的写入。允许下一步做不依赖 pending job 的独立分析时，需明确 pending/unknown 状态。

### 11.3 Partial UI 与 canonical history

response item 分 committed 完整 message、UI-only text delta、完整 tool proposal、已启动未结束 tool 和 partial reasoning/commentary。每条 UI delta 携带 generation/itemId/sequence。抢占将未提交文本标为 interrupted/superseded，不伪装完整 assistant 结论，不重复灌入下一 prompt。

tool call 一旦 admitted，即使 assistant item 部分流也要保留 canonical invocation/receipt 链；late results 不按 generation 全部丢弃，而按 rootCallId/callId 幂等入审计/history。旧纯文本 late delta 可拒绝，旧副作用工具结果必须可见并对账。工具配对和 DS reasoning 要求由协议 validator 判定，无法形成合法链则有界 recovery/debt，不能静默抹掉 invocation。

UI 与 journal 合成同一个 terminal receipt：旧流 preempted、turn still running、工具 pending/succeeded/unknown、next generation 状态分别呈现。S2 已指出 Codex partial UI 同步仍有 TODO，因此必须自己验证，不假设 upstream 已替 DSH 解决。

### 11.4 与压缩/window/retry 的 race

preempt/abort 与 stream completed 同时到达：canonical 优先规则允许一个先处理，但 input 不能丢，abort 禁止后续 successor。retry timer 同时触发不能发旧 generation 新请求；每个 retry dispatch 前检查 fence。pending user input 的 durable seq/cursor 与 W2 同一 coordinator；transition 中接受输入不修改已 prepared checkpoint，commit CAS/cutoff 确保留队列。

step preempt 后发生 compaction，新 step 仍 drain 已 signaled 输入；compaction 与 W2 surface mutation 共享 revision fence，不能各自覆盖。tool completed 与 abort 同时发生，通过 canonical terminal receipt 幂等决定 outcome；不把 cancelled label 覆盖已成功 mutation。

聚焦验证：subscribe 前后入队、stream/preempt同到、abort/preempt同到、输入重传、A/B/C 顺序、watcher leak、retry/backoff抢占、late tool admission、晚到写入结果、partial UI reload、window/compaction同时steer、启动恢复、长工具延迟。集成测试必须断言 world state、input history 与 UI，不能只断言 AbortController 被调用。

## 12. 需求驱动 PTC Async

2026-10-11 用户明确目标是减少团队交流延迟：新消息即时插入处理，已启动的同一个 PTC 实例继续后台执行，不能取消后重跑。历史真人插话计数不再作为不实现 J-01 的理由。默认仍 fresh one-shot；不复制新的 JS runtime、SDK、scheduler 或审批桥。复用 persistent job、waiting_set/resolve、durable event continuation/wake/inbox，并先核对当前模块安全合同。前台等待权与执行生命周期分离，旧 generation 不得启动后续工具，已启动结果必须耐久对账。

proposed detached API 返回 rootCallId/jobId（cellId 可作别名）、running receipt，不声称 completed。状态 CREATED/RUNNING/COMPLETED/FAILED/CANCELLED/TIMED_OUT/UNKNOWN_OUTCOME；yield 是 observation/control outcome，job 仍 running，不算 terminal。

子工具仍走 guard/ACL/approval/sandbox；仅真正独立只读且 concurrencySafe 的操作可并行。部分失败保留每个 canonical 子调用结果，可 allSettled 防整批成功值丢失，写入依赖串行 await。large output durable artifact + locator/hash + 小回执；完成事件先 durable outbox，再幂等通知。通知失败重放 event，不重跑 program。

resume/crash 无法证明副作用终态标 UNKNOWN_OUTCOME，通过 canonical state/ptc_receipts 对账；不可自动重试有副作用的整段代码。不引入模型 wait/sleep/polling 风暴，只有新事件产生下一 step。取消需 ownership/permissions，TurnAbort 与 explicit JobCancel policy 单独登记。

测试涵盖 success/failure/timeout/cancel/crash、部分 mutation、unknown reconcile、yield handle、approval、large result、completion event duplicate、notification fail、resume、不额外 polling sampling。未触发 async 条件则保留计划与理由，不能偷偷用 persistent REPL 改默认行为。

## 13. Cache Economics 与 Telemetry

窗口内 system/identity/SDK 和内容排序保持稳定；结构重写集中于明确边界。复用未变 view/config/authority revisions 的 bounded projection cache，不把每轮时间戳/随机 ID 插入稳定 system 前缀。identity 安全更新优先于缓存节省，不能为保持 warm 忽略新约束。

历史统计约 95% cacheRead、平均 prompt 300453/P95 716669 属旧窗口。S3 最近 RustMc 的 payload 字节分类属于另一范围，两者不可拼成当前节省率。SDK 重写曾首轮大量 uncached、后续 warm 是现象，不是所有 provider 的保证。

经济 preview 保留 current/projected token estimates、cold prefix estimate、预计剩余 turns/不确定性、checkpoint额外请求、recall频次、质量风险、route/protocol/priceVersion。未知 price/cacheWrite/reasoning 不填零。若真实规则允许计算：

```text
transitionCost = checkpointCost + firstColdPenalty + expectedRecallCost
warmBenefitPerTurn = stableOldCost - stableNewCost
breakEvenTurns = transitionCost / warmBenefitPerTurn
```

warmBenefit <= 0 或价格/归一化未知不生成可靠 break-even，不按猜测启用 economic auto。hard context safety 与经济 trigger 独立：接近合法容量只能走受支持的 safe compaction/transition，不能借预算优化放松 gate。W3 初期只记录 wouldContinue/wouldCompact/wouldCheckpoint/wouldTransition。

usage schema 增加 requestId/attemptId/dispatchReceiptId/session/rootTeam/turn/step/generation、window/checkpoint/transition/mode/reason/viewRevision、purpose/route/model/reasoningEffort、rawSafety/projectedEstimate、before/after bytes/hash/commonPrefix/firstChange、compactionEpoch、identityVersion、debt/read receipts、historyRecall、PTC rootCall/job、preempt原因/时延、input batch、tool survivors、partial UI terminal。

provider usage 分 input/cacheRead/cacheWrite/output/reasoning 与 priceVersion；reasoning 若为 output 子集不重复相加。attempted、handed-to-adapter、provider-terminal、transport-failed、preempted 分开；dedupe terminal 不删重试真实消耗。root 加全部 descendants 才是 workflow 总量，auxiliary/checkpoint/compaction/steer follow-up 同样统计。telemetry 默认不记录正文/密钥，不输出原文来证明 hash。

报表同时比较任务完成质量、遗漏/错误完成、约束遗失、重复工作/测试、request count、warm-up requests、uncached cold debt、recall、payload bytes、provider usage、latency、真实费用或 unknown。cacheRead 不当免费，bytes 不冒充 tokens，provider effort display 不冒充实际 reasoning token。

## 14. 阶段施工、最小验证与回滚

| 阶段/检查点 | 输出与启用上限 | 最小验证 | 回滚/停止条件 |
| --- | --- | --- | --- |
| E0/B-01 | current-code/loading/profile/backup manifest、当前 baseline | 物理路径/junction、版本/hash、active实例、测试失败分类 | 未明确真实路径/active资源停止写；不重启找证据 |
| E1/P1-01 至 06 | 确定性正确性修复、plan/ref/delivery 合同 | 各已复现反例、合法复用、debt预算恢复、十项六项/旧packet兼容 | 新误验收/输入丢失/兼容破坏关闭新路径、恢复 staged source；保留新增审计 records |
| E2/C/N/H | action schema、身份短规则、摘要/留尾与恢复读取 | 自然 memo、next-turn角色、真实summary对象、三次压缩/exact recall | identity/hash mismatch、摘要缺约束、read债务被误清则撤对应配置/提示词版本 |
| E3/W0/T | checkpoint/window planner和telemetry，shadow | preview纯、authority胜memo、source/ACL/TTL、raw request未变 | shadow意外改请求停止并恢复插件 |
| E4/W1/A | exact隔离会话conversation apply | prepared immutable、actual payload、unknown fail-open、raw gate、DS协议、质量A/B | oracle失败/协议不明/预算耗尽立即结束隔离实验、allowlist撤回 |
| E5/W2 | intent/commit fence/recovery，隔离manual | 全故障点、并发CAS、pending消费、replay/history/native meter | 不能提供线性化commit或恢复空窗则保持关闭，回到W1/原安全路径 |
| E6/I-01/02/03 | Instant opt-in + UI/queue/stream integration | 三signal、lost wakeup、retry/admission/world state/UI、window race | 新输入丢失、迟到写入、abort复活、UI假完成停止灰度 |
| E7/J-01 | 有需求才做 existing-job detached | job矩阵/receipts/unknown/no polling | 需求未触发保持off；对账不可靠不启用 |
| E8/W3/D | 经济policy shadow、profile parity、最终交付 | 自然usage/价格质量证据、全当前回归、加载/消费面、完整plan receipt | 价格未知不auto；active不支持安全HMR只登记pending，不重启 |

E6 可以在 E3/E4 时先做独立 queue/stream 原型与单测，但与 W2 的共用 commit/input race 必须在 E5 后验证；已准备用于生产的共享写入仍串行。

每阶段先语法/模块加载与聚焦测试；共享状态与事务阶段再运行当前完整 offline regression。首次 E0 重新取得 baseline，此后只在新共享修改/失败/剩余风险需复查时重跑全套；不反复为证明同一事实付费。保留 knownfail 名称与输出，不能通过删断言/改 skip 洗绿。

### 14.1 备份、同步与 HMR

备份逐目标记录 logicalPath/resolvedPhysicalPath/original SHA256/时间、配置有效值与原角色版本；staging 包记录 changedHash、测试命令/退出码/失败摘要。写入前校验原 hash，若有人并发修改则合并或停止该写入，不能覆盖新用户修改。无 Git 时备份 manifest 作为回滚身份，不使用 git reset 或清理目录。

部署原子替换必要文件，依赖模块/身份包需按现有 HMR 合同打包，先加载隔离实例。每个 logical profile 输出 physical mapping 与 parity hash；junction别名只写物理目标一次。官方安装包补丁须记录包版本/来源/恢复方法，避免包更新悄悄覆盖。新schema版本要可识别旧records，不用删除旧数据完成迁移。

HMR 验证三层：disk SHA → 当前服务实际 module/config identity → 下一真实安全请求的 receipt/behavior。active step保持captured snapshot，next-turn才用新identity/config；不能因磁盘一致宣称所有 active member 已加载。HMR不能安全完成时该项 enabled=false/pending，使用新隔离实例验证并保留 active Team 原状态，不擅自重启。

回滚关闭相关 feature/allowlist、恢复目标文件/配置前先核对 current hash 是本次版本；不覆写其他人的后续改动。已产生的窗口/输入/job/evidence records 保留，回滚 reader需支持新schema或继续关闭仅新路径。W2 数据回滚是新的协调transition，不能删除 COMMITTED 事件或恢复过时文件来抹掉外部副作用。

## 15. 官方 PTC、DS4.1F 隔离有界 A/B

使用当前真实官方 `ptc` preset 和实际 DS4.1F route，新建隔离 workspace/session，不复用 RustMc active root；four logical profiles 的 mapping/config 准确登记。先对照原行为，再按 E1/E2/W1/Instant 单变量或明确组合顺序实验。相同任务输入、model/route/settings、环境和seed条件尽量一致；随机性记录而非承诺完全一致。

正式模型调用前在ledger登记 per-case最大请求/重试、总时间/usage/额外费用预算与停止条件；由真实price/usage约束计算，价格未知可用请求+时间+usage上限，不捏造货币值。默认小样本跑质量负例，通过后扩代表性自然任务，不跑长期无界goal。provider/环境错误先记录原因，禁止自动切供应商或反复整段重试。

必含自然链：state → memo_put → 改决定 → memo更新 → checkpoint → manual/连续压缩 → 按当前计划exact恢复 → 处理新约束 → 十项逐项验收。另含缺revision、stale CAS、foreign evidence、过期plan、notice小预算后正文大预算、截断中间关键约束、摘要/尾巴冲突、工具失败换包装同假设、late steer/abort/retry、mutation已发生缺回执。

W1 比较原完整request与窗口projection，核实原journal未变；W2比较surface/meter窗口变化和exact history；Instant比较steer acceptance到successor TTFT、无效输出、工具存活/对账；N-02比较真实manual retained span而非配置字段。模型oracle输入包括canonical计划/约束/证据状态，检测漏做、误报完成、遗忘、重做，不能只看模型自述。

冷→warm各请求分别记录，全Team后代、辅助摘要、recall与steer跟进都计入。若底层不开放cacheWrite/reasoning/费用，报告可验证usage维度和unknown。相同任务质量先成立才谈收益，禁止预定百分比或单fixture外推。

停止：critical约束丢失、错验收、input丢失、late mutation、协议pair破坏、不可恢复状态、已登记请求/时间/用量预算到达。只停止实验session/job（其取消按副作用policy对账），不得停止active业务。失败实验保留原始receipts/manifest与复现入口。

## 16. 施工登记与最终交付

根代理逐检查点更新本表，或在既有平台ledger引用本表ID；路径以实际登记为准。不能把空白表作为已完成证据。

| 检查点 | 实现状态 | 改动路径与before/after hash | 最小验证命令/结果/evidence locator | disk/loaded/consumed状态 | 回滚入口/剩余 |
| --- | --- | --- | --- | --- | --- |
| E0 | 基线与备份已核验 | e0/native backup manifests，详见execution-ledger | baseline 688/686/1 fail/1 skip | 原采样已登记；部署前需刷新 | 尚未部署 |
| E1 | staging partial | staging/plugin-change-manifest.json；详见execution-ledger最新检查点 | 最新全量804/801/2fail/1skip为修复前记录，其中本轮runtime回归已聚焦修复，SCHEMA_DRIFT仍保留；债务35/35、实现证明与实际runtime/权限32/32 | disk/tested，19模块四profile一致；production loaded/consumed未证 | P1-06登记、全文读取、durable goal/outbox、债务及实现载体证明已接staging；真实test/acceptance/runtime-load生产者、非Team/UI及自然验收仍待 |
| E2 | staging partial | staging/native-change-manifest.json及home/team-roles | 原生边界15项、留尾5项；身份四角色真实reader与五hash校验 | disk/tested；next-turn及模型质量未证 | N-01真实摘要质量/恢复读取、C-03运行收敛尚待 |
| E3 | 隔离 accepted，生产 off | 见 execution-ledger W-00/W-01 各检查点与 §3 状态列 | 同上；最新全量 215 文件 1268/1267/0 fail/1 skip（2026-10-06 07:17 UTC，`output/regressions/2026-10-06T07-17-17-738Z-57f50c0e`） | disk/tested；loaded/consumed 未证 | 未部署，未启用 |
| E4 | 隔离 accepted，生产 off | 见 execution-ledger W-02 各检查点（10-03 22:24 三轮自然恢复） | 同 E3 全量 | disk/tested；loaded/consumed 未证 | 启用前须处理 read lease 窗口内断线与生产 gateway 无 handler 回调 |
| E5 | staging partial | 见 execution-ledger W-03 与 T-01 检查点 | pure/runtime 测试绿，natural/live 未验 | disk/tested；shadow/auto false | 经济策略未启用 |
| E6 | scoped staging accepted；完整矩阵仍partial | execution-ledger；ptc-background-20261011.md | 最新230files/1485tests/1484pass/0fail/1skip；共享70/70；真实UI queue→steer→后台回执，原生Team消息及多时点crash通过 | 隔离host disk/loaded/consumed已证，fixture adapters/0external；生产off | 实际provider质量、交互approval和生产审查尚待；不把局部验收等同完整E6 |
| E7 | 用户明确需求；scoped staging accepted，生产off | ptc-background-20261011.md；output/ptc-background-20261011/acceptance.json；隔离default持久evidence record | runtime16/16、共享70/70、当前全量零失败；真实Web UI+原生Team/1child；receipt/crash/unknown/large artifact/notification幂等 | 同一original runtime一次启动；隔离loaded/consumed、cold replay已证；没有真实provider或生产enable结论 | 独立security review、live交互approval、真实provider质量及production opt-in未完成；整个E0-E8仍partial |
| E8 | pending/shadow | 待填 | 待填 | unknown | auto单独登记 |

| 生产部署 2026-10-06 | 已部署并核验（Claude） | 文件 126 + 同包副本 11 + `team-v12-runtime.mjs` 再部署 2；配置：`step-compaction` 的 `minMilestoneFoldTokens: 200000`、`cacheWriteReadRatio: 50`，`team-v12-runtime` 的 `hypothesis.enabled: true`、`activeIdentity: { enabled, hostBootstrap, allowedRoots }`；before/after hash 在各备份目录的 `deploy-backup.json` / `config-backup.json` | 部署后 `deploy-production.mjs --plan` toWrite 0；生产主机启动日志 0 error；test 工作区冷恢复会话与全新会话各 1 回合 `completed` | disk/loaded/consumed 均已证（仅上述两类会话，未覆盖多成员 Team） | 备份：`backups/context-runtime-production-{deploy-20261006,deploy-20261006-copies,hypothesis-20261006,identity-20261006}`；回滚命令见 execution-ledger 约 22:05 检查点，未演练。W1/W2/W3/async PTC 在生产仍未启用 |
| W2 乐观提交 2026-10-06 | staging accepted，未部署 | `team-v15-window-{participation,transition,surface}.mjs`（web/headless 一致，清单与 pin 已刷新）；备份 `backups/context-runtime-w2-optimistic-20261006` | 全量 215 文件 1302/1301/0 fail/1 skip；切窗相关 5 文件 87/87 | disk/tested；生产无调用方 | 生产接线（调用方、路由证书续签、恢复重试、会话范围策略）未做；遗留项见 execution-ledger 约 22:20 检查点 |

审查登记：2026-10-01 23:41，北京时间，`/root/unified_risk_review`（Sol/high，Reviewer）完成只读独立审查。5项有效发现已在4.2、6.1、10.1、11.1、11.2补入：final receipt service入口、abort成功工具结果、accepted/claim耐久性、view pin非retention、W2 writer fence证书。结论是E1 pure正确性修复可继续；W2/Instant/final跨域提交需接口实装和fault injection后才能验收。未运行真实RPC mutation、UI、HMR或故障注入；`mutateHot`内部锁/barrier尚须施工核实。其风险不是新增用户批准环节，也不能用draft状态替代实施。

最终交付包至少含本规范最新planRevision/hash、差异与逐项需求覆盖、staging/backup/hash manifest、聚焦及当前全回归结果、隔离PTC真实运行证据、profile物理映射/parity/HMR回执、启用矩阵、故障恢复/回滚说明和remaining。状态区分“implemented但未enabled”“隔离accepted”“生产未auto”“conditional未触发”。v14持久evidence通过既有规范登记到canonical store并read-back（若当前平台仍要求 `default.json -> v12Evidence.records`，核对实际schema后确认），写报告不代替持久验收记录。

达到本阶段验证就停止无关扫描。生产未启用的功能不能冒充业务收益；无法在不重启/不中断active前提下验证的加载项明确pending，同时继续完成已授权且不依赖它的施工。整体complete由P1-06当前完整计划coverage决定，无法达成则报告具体partial与依赖，不把用户授权误解释为所有功能立即生产auto。
