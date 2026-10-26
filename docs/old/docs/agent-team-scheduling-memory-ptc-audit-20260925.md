# Agent Team 调度、记忆与 PTC 提示词专项审查

日期：2026-09-25。状态：F1–F9 已纳入 v14 实施并完成回归；最终运行态、部署哈希和剩余边界以 `agent-team-v14-implementation-ledger.md` 与 `agent-team-performance-hotfix-20260926.md` 为准。

本报告补充 `agent-team-v13.2-architecture-review-and-optimization.md`，依据实际会话、当前配置和代码调用链，不将旧计划的“完成”勾选直接当作运行效果。

## 0. 审计项收口映射

| 审计项 | 当前状态 | 主要证据 |
| --- | --- | --- |
| F1 官方 post-execute 契约与成功/失败镜像 | complete | `phase11-tests/v14-runtime-bridge.test.mjs`：`post hook mirrors result.value even when next blocks`、`failed original result never creates a successful mirror` |
| F2 inbox 投递、注入、处理分层与去重 | complete | `v14-room-memory`：`wake delivery, injection and handling remain distinct`；`v14-runtime-bridge`：20 步 pre-step 幂等与 native message id 去重 |
| F3 Room 新旧结构、摘要、未决项与游标 | complete | `v14-room-memory`：Room index/migration、cursor injection receipt、latest/history 分表与权限过滤 |
| F4 Room speaker 最终超时与 host 恢复 | complete | `v14-scheduler`：`room timeout detection is durable...`、`room timeout delivery retries are bounded...` |
| F5 ready queue、真实状态映射与停滞误报 | complete | `v12-evidence-scheduler`、`v14-scheduler`、`v14-continuation` 的 ready/blocked/terminal/manual-pause 回归 |
| F6 correlation 传播与观测失败隔离 | complete | `phase9-tests/v12-runtime-observability-replay.test.mjs`：causal timeline propagates IDs、delivered 不升级为 handled |
| F7 无新 Room 消息时仍交付要求/决策差异 | complete | `v14-runtime-bridge`：`new requirement is delivered without a new Room message` |
| F8 压力压缩必保留项与 memory debt | complete | `phase9-tests/v12-room-wake-compaction-context.test.mjs` 的 F 组；`v14-room-memory`：pressure memory fixture 区分 empty/missing/loaded |
| F9 控制面热状态全量同步读写与 no-op 写放大 | complete（运行态已加载） | `v14-storage`：no-op/重复 join/cold-hot 分离；`perf16` clone-free：10 MB 状态 120 笔热更新 `commitMs=672.9` |

当前仍存在的部署边界不是审计项未修：`dsh-session-persistence-jsonl` 的会话列表缓存补丁位于核心 `node_modules`，需下一次受控重启才会加载。Team 控制面的 F9 热路径修复已通过 HMR 在 PID `35728` 生效。

## 1. 结论

还有明确的重构、优化和功能补齐空间。用户反映的“人多但慢、成员停着、沟通延迟、容易忘事”有代码和运行记录支持，不能都归结为模型纪律不足。

主要问题是：

1. v12 适配层误读官方工具钩子返回值，部分任务契约、证据和消息镜像没有正确建立。
2. 同一收件箱批次被逐步重复注入，大量旧消息挤占注意力和上下文。
3. Room 新旧数据结构不一致，记录存在但新版恢复流程没有正确读取。
4. Room 唤醒超时进入终态后没有自动交给主持人恢复。
5. ready queue 是查询/影子结果，不是自动派发器，而且状态判断还有错误。
6. 提示词强调停止、静默和等待，但没有和可靠的系统接续机制配套。

正确方向不是继续堆提示词、把全部静默通知改成唤醒，或增加团队数量；应先修复这些实际缺陷，再把已批准任务的接续、等待责任和关键记忆做成可验证的系统行为。

## 2. 审查范围与限制

- 读取 v12 计划、相关实施台账、v13 台账、上次 v13.2 审查；本轮没有重新逐字阅读全部历代文档。
- 核查当前 web 配置入口与相关 headless 副本；重点审查调度、Room、wake、context pack、压缩锚点、持久化和 PTC 适配。
- 当前目标：`session-7a601594-66f6-4255-92ba-1ef6813cbf1a`，工程 `D:\dsh-test\workspaces\mc189-rs`。
- 主会话和抽查成员的 projection 均显示 `agentPreset = ptc`，不是自定义中文预热预设。
- 提示词审查依据配置入口、官方组装代码、AGENTS/身份文件和真实日志；本轮没有导出每个运行中成员最终拼装的完整系统提示词，不能宣称所有旧成员已加载最新角色文本。
- 取样包括 root journal 尾部 8 MiB、5 个成员 journal 尾部、实时写入中的控制面 JSON 和审计日志尾部。
- 数据采样主要在北京时间 16:22–16:35；各文件不是同一事务快照。projection 的旧 turn 状态不等于实时运行状态，不能据此宣称全部成员空闲。
- 没有重启、热重载、唤醒/打断成员、修改会话、清理文件或调用供应商。只新增报告和离线诊断脚本。
- 没有复现用户几小时前所有任务的完整执行过程，不能给出整段耗时的精确因果占比或承诺提速倍数。

## 3. 当前会话的证据

| 项目 | 观察值 | 正确解释 |
| --- | --- | --- |
| 控制面任务 | 216 张，163 completed，4 deleted，21 in_progress，28 pending | 是本地控制面口径；原生 global 板另有历史卡，不能简单相加 |
| ready queue | ready 3，blocked 46 | 3 张 ready 实为 in_progress/lifecycle running，不是可立即新增的 3 个并行任务 |
| 停滞诊断 | 201 条 suspected-hang，其中 155 张已 completed | 已确认误报，会掩盖真实阻塞 |
| 最新启动后新建卡 | 11 张中 10 张没有持久 contract | 不是全是历史旧卡；适配路径持续漏写 |
| inbox | 1324 条中 1316 条的 messageId 等于正文；最长 ID 68,474 字符 | ID 构造和结果读取有缺陷，不是正常大正文设计 |
| root 注入样本 | 71 份 v12 inbox batch，序列化 content 累计约 226 万字符 | 字符累计，不是 token 数，也不是当前保留上下文总量 |
| 同批重复 | 55,904 字符批次完全相同地注入 20 次 | 另一个 6,389 字符批次在 15:08–16:19 注入 17 次，问题仍近期发生 |
| 成员注入 | lead-core 尾部最近一份 batch 为 133,895 字符 | 超出“紧凑待办摘要”的预期 |
| Room 记忆 | 28 个 transcript；旧 Room 有 16 份非空摘要、36 个未决条目；v12 summary/cursor/unresolved/decision 共 0 | 旧消息和摘要不是丢光了，但新版记忆路径没接通 |
| 控制面大小 | 约 62.6 MB；v12RoomWake.events 2000 条占约 2100 万字符 | 保留条数有上限，单条体积及热数据读写仍失控 |

四个 v12 wake 的 `attempts` 为 264/75/112/95 且无 lastError。这不是“网络重试了几百次”的证据：代码会在每次成功注入时增加 attempts，指标混用了注入次数和运输重试次数。

## 4. 需要先修的代码缺陷

### F1 / P1：工具 post-execute 协议适配错误

位置：`home/profiles/web/plugins/team-v12-runtime.mjs:846-984`。

官方当前契约在 `home/profiles/web/node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:70,413-429,465-478`：

- `result` 是工具执行结果，成功业务对象位于 `result.value`。
- `await next()` 返回 `PostToolDecision`，例如 `{kind:"accept"}`，不是业务对象。

当前桥接代码把 `await next()` 存为 `settled`，随后读取 `settled.id/messageId/evidenceId/merged`。后果：

- task create 的成功 ID 读不到，contract 自动镜像漏写。
- 消息 ID 回退成 `args.message`，即把整段正文当标识符。
- 未检查真实 `result.isError`，被拒绝的 send 也可能写入新版 inbox，制造不存在的待办。
- evidence、milestone、merge 镜像同样不能假设正确；需要逐分支按真实 envelope 复验。

修复：统一一个官方 hook 适配层，分清执行结果和后续策略决定，只镜像确认成功的业务动作；失败记录和成功镜像分流，稳定 ID 使用真实结果或 scoped call ID，不用正文。测试须通过真实注册的 hook 入口和 canonical result，不能只直接调用纯函数。

### F2 / P1：投递与处理混淆，同批消息反复灌入上下文

位置：`team-v12-runtime.mjs:1157-1172`、`team-v12-room-wake.mjs:882-908`。

pre-step 每次选择 queued 或 delivered 的第一个 wake；只要模型尚未显式 inbox_ack，就重复拼接整批正文。拼接格式还包含 `[messageId] + originalText`，与 F1 合并后相同正文单份内再次重复。该批次没有按 context pack 的 32k 预算计量。

修复：区分 queued、delivered、injected、handled。成功提交到历史后写入注入回执；业务未处理只保留简短未办提示，不逐步重放全文。发生压缩、注入失败或新消息加入时按游标补差量。注入回执不代表工作已完成，保留逐项处理确认。把所有注入源纳入同一预算，batch 上限不能绕开总上下文预算。

### F3 / P1：Room 写入用 transcripts，读取却遍历 rooms

位置：`team-v12-room-wake.mjs:93-107,134-149,211-249`；`team-v12-runtime.mjs:903-921,1032-1062`。

Room 模块写 `state.transcripts[roomId]` 等分表；runtime 恢复却遍历 `doc.rooms`。当前 `doc.rooms={}`，因此没有枚举实际 28 个房间，游标推进也没有运行。镜像分支只复制 messages，没有同步旧轮次摘要和未决项。

修复：统一 Room 访问接口，按真实 room ID 集合枚举，按当前成员权限过滤；按 legacy revision 幂等迁移摘要和未决项，保留来源。不要把模型聊天中的意见自动提升为已确认决策。迁移前备份，提供差异统计，保留旧记录和双读兼容直到验证通过。

### F4 / P1：Room speaker 唤醒最终超时后没有责任人接手

位置：`team-control-plane.mjs:474-490`；`team-tools-v2-r10.mjs:857-965,1880-1898`。

实际例子：`task:g-boot-wake-3` 在 15:59 开轮，16:00:47 为 member-proto 创建 speaker wake；16:35 采样时仍以其为 nextSpeaker，对应 dispatch 已 `timed-out / dispatch deadline expired`。

定时 reconcile 仅处理 `dispatch-retry`；达到次数后发出的 `dispatch-timeout` 没有通知主持人恢复。`team_room_read` 不修复；后续显式 open/post 可重新认领，但无人发言时不会自行发生。

修复：最终超时必须形成持久 blocker，并向 host/负责组长合并投递一次恢复请求；可重试运输使用有界退避与 episode 去重。不能通过无限重新创建 wake 绕过暂停/冻结/供应商阻断。主持人不可用时才升级 root，保持普通消息不唤醒全队的原始目标。

### F5 / P2：ready queue 与停滞诊断使用了错误状态口径

位置：`team-v12-evidence-scheduler.mjs:214-263,286-305`；`team-v12-runtime.mjs:535-555,666-669`。

- 只识别字面 `status=running`，漏掉原生 `in_progress` 与 running lifecycle，运行任务可出现在 ready 中，scope 冲突集合也会漏。
- refreshDerived 永远传空成员表，owner 可用性检查被跳过。
- 全量任务进入 stall 分类，没有过滤 completed/deleted，产生 155 个终态误报。
- 只看 task 时间和 phase 推断工作状态，没有结合实际工具进展、后台 job、依赖完成状态。

修复：为原生状态与控制面生命周期建立唯一映射。区分“待首次派发”“可恢复执行”“正在运行”“等依赖”“等人工”“终态”；不简单把所有 in_progress 永远排除，否则真正停住的执行任务也无法恢复。派发前重新校验 owner、lease、scope 和依赖。诊断只报告有动作责任人的异常。

### F6 / P2：追踪事件报错阻止后续派生刷新

位置：`team-v12-runtime.mjs:360-367,559-565,979-982`；`team-v12-observability.mjs:200-204`。

makeObservation 没传 correlationId，而 createObservationEvent 要求该字段。镜像后 appendEvent 抛错，后面的 refreshDerived 不执行；外层只 warn。当前会话 `v12Events=[]`，纯内存复现得到 `correlationId is required`。

修复：从根会话、turn、call、task 传播因果 ID；可观测性失败不得跳过必要的状态更新，必要错误须进入健康诊断。不能静默制造“界面 healthy，但派生状态未更新”。

### F7 / P2：已有 context pack 会阻止新任务要求刷新

位置：`team-v12-runtime.mjs:1117-1126`。

即使新契约/决策使 digest 变化，只要历史有 pack 且本次没有新的 Room 消息 ID，就不再注入。这让变更后的验收标准、依赖或决策停留在磁盘，模型仍使用旧版。

修复：根据与当前工作相关的契约、决定和未决事项版本比较，生成变化摘要；旧 pack 是否存在不应该决定新事实是否可达。采用追加版本替代通知，避免逐次重写历史前缀。测试“没有新发言但要求改变”。

### F8 / P2：压力压缩的记忆校验可能是空检查

位置：`step-compaction-v4.mjs:59-69,98-103,301,351`；`team-v13-compaction-anchors.mjs:48-50`。

锚点主要取 pending.handoff；没有该 handoff 的压力压缩使用空 decisions/cursor/blockers，校验器又跳过空集合。它不能证明实际 Room 共识被保留。原有交接提示仍在，不应说所有压缩都丢记忆；缺陷是“没有取得应保留内容，却可能将校验记为通过”。

修复：从权威状态生成每个成员的必保留项；明确区分“确实无此项”和“未读取到”。生成失败时记 memory debt，恢复首先加载当前工作摘要。保留用户要求的 done 后必须压缩、set 不取消待压缩任务的规则。

### F9 / P1 性能风险：共享热状态全量同步读写，空操作也写

位置：`team-control-plane.mjs:508-547,620-636,690-695,1394-1415`；`team-tools-v2-r10.mjs:840-848,1264`。

每次 mutation 都同步读/解析/序列化/替换整个约 62.6 MB JSON。每步无提权也调用 privilegeActivate；每次发消息 ensureRoom 会对已存在成员逐个 roomJoin，照样增加 revision 并写全文件。

只读样本在独立 Node 进程执行 read+parse+clone+stringify 约 524 ms，尚不包含写盘、锁竞争和官方执行路径的额外读取。它证明热路径规模不合理，不是完整服务性能基准。

审计尾部约 14 小时有 3194 次 room/member-added、1859 次 privilege/activated、1723 次 v12/wake-delivered。不能把这些全算成无效操作，但与重复 join/空激活的代码路径相符。

修复顺序：先消除正文 ID、重复注入和 no-op 写入；再合并一次逻辑动作的事务。把可归档正文/历史与小型调度热状态分开，保留审计引用和恢复路径。先选择一个清晰的单写者/事务存储方案，不同时维护多套可写事实源。迁移前必须有可验证备份，不能直接清旧数据。

## 5. 调度架构还缺什么

### 5.1 ready queue 不等于自动调度器

现有代码只计算、保存、查询 ready queue，没有自动领取或派发接线。v12 计划 H 原本允许先影子运行，这属于尚未激活的能力，不该宣传成已实现无人干预的任务推进。

全体停工提醒必须等 root 和所有未冻结成员都停下；另有 20 分钟活动摘要，但它唤醒 root 做检查，不会替每个组长接续组内任务。只要一组仍工作，另一组可能长期没有新动作。

建议增加事件触发的接续器：

- 输入：任务完成/失败、依赖解除、lease 释放、审批完成、Room 关闭、消息处理结果。
- 只调度已批准、owner 明确、权限与 scope 满足的工作，不自动 spawn/reassign/扩大权限。
- 用 task revision + owner + dispatch generation 形成幂等键；唤醒前重新验证状态。
- 一次事件优先通知真正可推进的 owner 或组长；普通进度不唤醒 root。
- 影子与主动模式在面板显示，启用前用离线回放和小型新测试会话验证。

### 5.2 每个等待都有原因和下一位责任人

把笼统 idle 拆成：无任务、等依赖、等审查、等人工、等工具后台结果、Room 等待、权限阻塞、运输失败、异常失联。

每条等待保存：当前卡、等待条件、负责解除的人/事件、最近有效进展、下次检查时点。结束 turn 前允许返回结构化等待记录，系统决定何时检查，不让模型睡眠轮询。

完成回报应是可消费事件。成员 complete 后，系统汇总给负责组长；依赖满足则唤醒下一 owner，不要求模型把普通完成硬包装成“阻塞决策”才能上报。

### 5.3 度量真实吞吐，避免追求开满成员

显示交付用时分解：排队、模型执行、工具、审批、Room、集成、返工。用“验收并合入的交付物”衡量进展，不以消息数、工具步数或 opened team 数衡量。

同一任务链、共享文件、同一编译资源或唯一审查员构成瓶颈时，应优先解除瓶颈；增加成员只会增加通知与上下文。给建议依据，不擅自降低用户已配置配额或打断在执行成员。

## 6. PTC 和提示词审查

### 6.1 实际来源

官方 `dsh-web-app/presets/ptc.patch.yml` 加载 PTC tool presentation、agent-instructions、文件/命令工具等；`dsh-tools/lib/index.js:1689-1699` 已提供 await、只读并行、ToolCallError、只打印必要内容等基础说明。官方基础说明不是空白，也不能把自定义错误都归给官方。

额外叠加：`home/AGENTS.md`、spawn 时拼入的 `team-roles/*.md`、r10 POLICY、v12 POLICY、动态 Room/inbox/context notices。主要协调矛盾出现在这些自定义层。

### 6.2 已发现的问题

| 规则/来源 | 问题 | 建议 |
| --- | --- | --- |
| r10 POLICY:43,52,53 | 派发后立刻停、沉默代表工作、每次醒来只处理一件事；系统却没有可靠局部接续 | 改为先处理本次相关可执行批次、登记等待责任，再停；仍禁止无依据轮询 |
| r10 POLICY:44 | 等所有组长都结束才交唯一 verifier | 按依赖完整的交付批次送审；不为一个小改动反复唤醒，也不等无关慢组 |
| r10 POLICY:45；各角色 Room 等待段 | 任意 Room read 返回 stop 就结束整个 turn，即使旧房间已无开放轮次 | stop 只暂停该 Room 参与；当前无阻塞的独立已批准任务可以继续。等待不得成为遗漏已分配任务的理由 |
| home/AGENTS.md:144 | 对 all-idle 已有上述例外，但角色和硬编码 POLICY 没同步 | 合并唯一行为定义，再生成角色与工具说明 |
| home/AGENTS.md:114；spawn 描述:1388 | 宣称 3 组长/3 组员，当前 policy/config 为 8/8 | 从运行配置输出有效配额，避免多份手写数字 |
| home/AGENTS.md 开头 | 大段与编码协作无关的“无约束/覆盖限制”声明 | 从执行提示词中移除；测试材料独立保存，不作为权限声明 |
| role readRole:124-132；spawn:1408-1423 | 身份正文在 spawn 时读入；仅改磁盘不能证明老成员得到新身份 | 增加 identityVersion/hash，恢复/新 turn 检查后只追加变化说明；不要重写已有历史或假称热加载完成 |

member-shots 的实际尾部回复以 `round:null / waitAction:stop` 为结束理由，并继续列出仍等待的任务。它符合旧提示词文字，不应简单批评“模型不主动”。要同时修语义与系统唤醒责任。

### 6.3 提示词的推荐结构

1. 全局层：事实、权限、验证、不可逆操作和基本沟通规则，删去过时上限与重复身份。
2. 角色层：负责什么、何时交给谁、何时可结束；root/组长/成员/审查员分别短写。
3. PTC 层：真实 SDK 示例、读操作并行、状态变更串行、异常后的已执行回执、紧凑输出。
4. 每次恢复的动态包：当前任务 ID/revision、必须满足的要求、有效决定、未决点、待处理消息、新增约束和允许的下一步。

动态事实追加在消息尾部，不塞入静态系统前缀。配额/工具 schema/错误修复提示尽量从同一个定义生成。

PTC 需要专门说明：

- 中途异常不代表之前的写操作回滚；以返回 ID/revision 或查询结果核实，禁止整个脚本无脑重跑。
- `Promise.all` 仅用于独立、安全的读取；审批、claim、lease、complete、release、merge 按依赖 await。
- 完成工具调用后 return 紧凑回执，不输出全部 inbox、全部 room 或整个控制面。
- 修改类调用都 await，不能让 run_code 提前结束并遗弃消息/工具任务。
- 长命令后台执行并交给持久 job 完成事件；有其他可执行任务再继续，没有则登记等待。
- 工具更名/参数/权限不靠模型背诵历史错误，应返回当前合法下一步和准确引用。

### 6.4 让关键要求有明确载体

为用户要求建立短小、版本化 requirement 记录：要求 ID、原文引用、适用范围、验收条件、变更时间、替代关系。任务引用适用要求，组长下发时自动携带相关版本；过期指令返回版本差异。

这不要求把整份大需求在每步重读。关键约束必须保留，普通历史只放引用。压缩验收针对真实待办和要求，不能只检查摘要提到了“计划/台账”两个词。

## 7. 更实用的功能建议

| 功能 | 解决什么 | 边界 |
| --- | --- | --- |
| 待接续任务视图 | “谁停着、为什么、该谁接手”一眼可见 | 区分人工暂停与系统遗失；不把所有 idle 当故障 |
| 完成事件接力 | 已批准依赖自动衔接，不等全队停工 | 保留 owner/scope/lease 门禁，精准唤醒 |
| 阻塞责任单 | 超时、权限拒绝、Room 卡轮不悄悄挂着 | 有负责人、证据、恢复条件、去重和升级路径 |
| 关键要求/决定差异包 | 压缩与跨组后恢复正确版本 | 必须来自权威记录，不能自动将聊天意见变成决议 |
| PTC 操作回执 | 一串工具中后半失败时不重复前半写入 | 记录子调用状态与真实 ID，提供查询/重试范围 |
| 瓶颈时间线 | 找出小时级等待是在审批、工具还是协调 | 只读观察，不靠额外模型询问每个成员 |
| 交付批次审查 | 避免审查员碎片唤醒和全组同步等待 | 按依赖完整批次、风险与变更范围送审 |

跨组协作不应为每件小事开 Room。共享接口/同文件冲突/跨组验收变更才触发讨论；已稳定契约可引用后直接执行。讨论结果形成决定和 owner 后关闭，避免“每次开工都重新讨论全部历史”。

## 8. 推荐实施顺序

1. 修 F1/F2/F3/F6：官方 hook 契约、稳定 ID、消息注入回执、Room 数据接口、事件记录失败隔离。
2. 修 F4/F5/F7/F8：超时交接、真实状态映射、动态要求更新、压缩必保留项。
3. 修 F9：消除空事务和重复 join，再拆热状态与历史；先量化后迁移。
4. 同步 AGENTS/身份/POLICY/PTC 使用说明；加入现有成员的版本感知，验证实际新 turn 收到。
5. 以已批准任务启用接续器和等待责任单；保留人工暂停、冻结和 provider 阻断。
6. 最后增加吞吐面板、要求差异包、PTC 回执与瓶颈度量。

不是推倒重写。先收敛到一个权威任务/消息状态，再替换桥接和派生视图；原生 Team journal、已有用户会话、任务 ID、证据和冻结规则继续兼容。任何修复不得通过关闭门禁、重建会话或清空历史来“消掉问题”。

## 9. 验证与回归标准

本轮新增纯内存诊断：

```powershell
node D:\dsh-test\tools\audit-v13-bridge-readonly.mjs
```

实际注册 v12 post-execute callback，按官方 result.value + PostToolDecision 契约输入，六项缺陷均被复现：contract 漏写、正文作 ID、失败消息也镜像、Room 索引为空、trace 缺 correlationId 跳过刷新、旧摘要未镜像。所有存储依赖替换为内存，无真实会话写入。输出 true 表示缺陷被复现，不表示产品验收通过。

独立审查已运行：

```powershell
node --test phase9-tests/v12-room-wake-compaction-context.test.mjs phase9-tests/v12-runtime-authorization-context.test.mjs phase10-tests/v13.1-core.test.mjs
```

24 项通过；另一路调度/Room/活动摘要测试 16 项通过，存在重叠，不能相加宣称 40 项唯一测试。现有测试通过仍未覆盖此次真实 hook、运行时接续和大量历史场景。

下一轮必要回归：

- 真实 PTC 子调用创建任务/发消息，检查 canonical value 和持久镜像一致；失败操作不得伪造成功状态。
- 同一 wake 连续 20 个 pre-step，仅首次或新增消息发生增量注入；处理确认仍独立存在。
- 旧 Room 摘要/未决项在当前成员恢复包可见；游标只对真正注入的内容前进。
- speaker 超时达到重试阈值后，host 得到一次可操作恢复事件；不全队唤醒、不无限重试。
- completed/deleted 不计停滞，running 不当新 ready，inactive 但有工作者进入明确 resume 流程。
- 契约版本改变但没有 Room 发言，下一次执行仍看到新要求。
- 压缩前埋入真实待办、要求、决定、阻塞；压缩后不依赖长历史仍能恢复，缺失明确报 debt。
- 以当前约 60 MB 规模的脱敏 fixture 测 p50/p95 控制操作耗时、锁等待、事件循环延迟、单步注入量。
- 端到端小型新会话：两个组长各两个成员，含依赖完成、一次投递失败、一次压缩、一次 Room 接力；不干预用户主项目。

修复完成必须同时有代码回归、兼容旧会话的数据检查和新测试会话实证，不能再仅凭模块存在、哈希一致或纯函数测试宣布“调度/记忆已完整工作”。
