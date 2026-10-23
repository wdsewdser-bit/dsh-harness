# Agent Team 剩余五类工作收口

授权来源：2026-10-21，用户要求“把这些全部完成”。范围为上一轮明确列出的五类：生产落地、旧沙盒异常、特定真实场景验收、三项早期能力、四项性能优化。本要求新增生产发布/加载/回滚验证和必要活跃Team迁移的授权，不把旧“未授权生产”继续当作当前阻断。

## 边界

- 只改D:/dsh-test本项目及新的output/agent-team-complete-20261021，不触碰其他DSH实例。
- 当前运行态需现场识别；有活跃任务时不强杀、不清理会话或篡改task/lease/Goal终态。生产写入前必须有备份、精确hash前置、失败回滚与适合当前状态的加载路径。
- 旧r4三小时四阶段已通过，不重复算未完成。旧报告、冻结脚本、日志和canonical保持原件；新源码和生产变更使用新版本、新清单，保存原字节，旧验收不冒充新版本全量。
- 不放松沙盒、跨scope/角色权限、CAS、证据/交付门禁；不恢复已撤销能力、不重建旧丢失能力目录。过去缺少删除审计时如实保留不可追溯事实，不能承诺找出不存在的历史证据。
- 不开启W1常规、W2扩围、经济auto或其他此前明确关闭的策略。性能优化保留unknown、原始回执、幂等和恢复兼容性，不用清理数据当优化。
- 唤醒延迟按用户要求不再处理；每分钟模型自动化继续PAUSED，不新增周期模型回查。
- 允许本地/真实原生场景和必要有界模型验收；每次模型场景先登记输入、调用/时间上限和停止条件，不沿用旧已结束窗口或无限试错。全部进程收齐真实终态。

## 验收矩阵

| ID | 目标 | 完成依据 |
|---|---|---|
| DEPLOY | 当前组合包生产同步、加载、回滚验证；需迁移的Team安全续接 | 备份与精确变更清单、真实运行入口加载hash/schema、回滚/恢复结果、Team状态前后对账 |
| SANDBOX | 查清可证实的失效机制并消除可修复风险 | 真实ACL正负例、正常生命周期/丢目录/撤销后的fail-closed、资源清理；历史不可追溯单列 |
| LIVE-GOAL | 自动Goal续轮真实触发 | 原生同Goal真实round事件、实际后续模型请求与任务交付，不由操作者代完成 |
| LIVE-RETRY | 自然链路错误后的真实重试恢复 | 同turn/step的失败attempt、退避、retry-start、后续成功及原回执保留；注入与自然区分 |
| LIVE-RESTORE | 跨恢复继续编辑与多角色内容正确性 | 真实持久恢复、exact来源和新旧约束oracle、最终版本独立复核及任务/lease/Goal闭环 |
| TOOL-REF-01 | 大payload/code权限与hash绑定引用 | 实际消费入口、ACL/hash/TTL/revoke/跨scope拒绝、引用与inline语义质量对照 |
| SDK-CATALOG-02 | 稳定核心SDK与角色目录/按需describe | 实际加载目录/schema、可发现/可执行的一致性、角色隔离/未知工具拒绝、兼容性与真实调用 |
| CLM-CHECKPOINT-03 | 合法历史检查点与completed episode分层 | 复用现有checkpoint/retention权威、协议pair/anchor/债务不丢、压缩恢复后正确消费与审计 |
| PERF-BUDGET | 增量token预算 | 与旧选择结果等价、Unicode/required/debt边界、规模对比，不只声称复杂度变化 |
| PERF-INBOX | inbox增量索引 | 同权威mutation维护、ack/HMR/restart/legacy/cross-member等价、规模对比 |
| PERF-DEBT | compaction debt去重写盘 | 重复timeline不重复改revision/fsync，新request/compaction与并发不丢状态 |
| PERF-ARCHIVE | operation回执有界生命周期 | completed/partial/unconfirmed明确语义、迟到重试和payload冲突不穿透、冷归档可回读、规模对比 |

## 当前阶段

已完成：独立工作包实现、一次具体安全审查及两个P1修复、根代理整合、全量回归、有界真实模型验收和生产发布/加载/回滚。没有匹配Ready Workflow（route实际none，available_ready=0），使用普通工作包，不伪造Workflow Run。

设计与验收按以下实际结果收口；旧协议登记保留各自时点。唯一恢复入口仍为同目录execution-ledger.md顶部最新检查点。

## 2026-10-23 重置后续测登记

按用户“重置后继续”授权恢复。旧 live/live-r2 共 171 次请求及其失败和已过期窗口保留原件，不重置旧预算。新增 live-r3 为一次独立的必要修正验证，上限 180 逻辑请求、200 HTTP、45 分钟、16384 输出；实际时钟只由正式 --launch 初始化，不能因失败续期。调用前须有当前全量回归通过、源码冻结及 --preflight 通过。永久认证失败即停止，不进行无限尝试。

本次仅在物理 staging Goal 驱动修正三个非语义策略分支，保留严格 Goal 收敛边界。恢复夹具由原生 Team 邮箱负责激活原身份成员，不手工 resume 子代理；在实际 agent/created 事件核对完整原始日志前缀，并保留同 Team、同三身份、跨进程续写、最终版本独立复核和 task/lease/Goal 原门禁。受控单次 503 只作为注入恢复实证，不称自然故障。

源码清单 source-inventory-r3.json 指纹为 47620bfc906596a0fec29e98aaabd7fe0f2d0fa7b5725e83bfb21f7a9ca2f856，674 项当前载体、11 项补充、227 项发布前生产事实、1298 项已保存原字节；287 目标发布计划及隔离 apply/rollback 已通过，实际生产尚未写入。生产 apply/真实 rollback/reapply、真实 profile 加载及原生冷读，必须等待本次真实模型和独立 cold 门禁通过。

## 2026-10-23 15:21 UTC 实际收口

- DEPLOY：287目标真实生产apply/rollback/reapply通过；424旧状态事实不变；独立五原生日志6711事件兼容冷读通过。production-runtime-r6实际加载生产profile，以原生run_code消费完整分页目录及权限拒绝，令牌303换cookie后200，0模型请求并正常dispose。官方服务PID46360/40123已ready/HTTP200，保持运行。前五次探针的PTC入口、初始化、分页和Node无cookie redirect夹具失败保留，没有为它们修改产品门禁。
- LIVE-GOAL/LIVE-RETRY/LIVE-RESTORE：r3窗口14:54:48.938至15:39:48.938UTC未重置，实际两阶段14:58:58和15:01:36结束，均exit0。自动同Goal round1、受控一次503原生重试、同Team/同两复核者的新进程恢复、冲突新要求续写、最终源/测试/报告消费/task/lease/Goal全部通过。独立cold PID28004恢复3日志1486事件。入口launch.mjs cold的循环import失败保留；直接cold.mjs成功，未改冻结驱动。
- SANDBOX：14真实ACL正负例及wrap后丢目录拒绝通过，禁止重建/重授已失效能力的版本实际部署。历史删除者未知、不能追溯或承诺恢复可用性，属于明确残余事实，不伪造归因。
- TOOL-REF-01/SDK-CATALOG-02/CLM-CHECKPOINT-03：已实现并整合原生权限/工具管线/当前批准任务和lease、角色目录/按需describe及completed episode稳定来源。原生集成、episode实际工具调用后仍可读及完整回归通过，已加载生产；核心投影false、collector范围未扩大。
- PERF-BUDGET/PERF-INBOX/PERF-DEBT/PERF-ARCHIVE：四项实现和语义/耐久/并发/规模验证通过，已随包生产。2000来源预算体字节相同，基准p50 2013.228->20.739ms；10万回执归档hot100/固定512分片根，旧幂等/冲突/缺数据fail-closed保留。
- 当前最终全量257文件1755测试：1754通过、0失败、1既有可选跳过。新125逻辑/125HTTP/125终态中124成功、1受控失败保留；旧171请求及过期失败窗口原样，合计296请求；未知cacheWrite/reasoning不填零，不换算费用/订阅扣减。
- 最终result.json SHA256 e92dc22cbdad84b0af61a51a76098d5fc3c43fb2bf814ec281ecdae03c8b98d7，1356绑定产物；canonical `five-category-closeout-20261023-82cba2c425ce77c6` passed，独立PID45560实际读回。final sourceHash 82cba2c425ce77c6为发布后的完整事实指纹；只允许原sandbox junction按实际计划从旧生产哈希转到已验收新哈希，原预发布冻结清单不回写。

以上仅关闭本次五类授权，不等于任意任务/平台/故障的普遍保证。旧r4三小时和旧失败报告保持历史状态；没有擅自提交/推送、扩大W1/W2或经济auto；唤醒延迟按用户要求不再处理。
