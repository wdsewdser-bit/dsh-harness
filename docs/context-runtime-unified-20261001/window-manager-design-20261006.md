# 上下文折叠的生产接线设计（草案，待审查）

日期：2026-10-06。作者：Claude。状态：**草案，未实现，未审查**。范围：把压缩、W1、W2、W3 从“只在隔离实验里能用”接到普通生产会话，并定义它们各自什么时候出手。依据见 `execution-ledger.md` 2026-10-06 各检查点。

## 1. 已经确定的事实

| 事实 | 来源 |
|---|---|
| 命中输入价是未命中的 1/50（0.003 对 0.15 美元每百万 token），输出 0.60 | DeepSeek 官方定价页 |
| 缓存按整条消息对齐：靠前的消息一变，其后全部不命中；末尾追加则前面全部命中 | 直连探针 `lab-runs/context-size-split*`、`…gap*` |
| 3–6 万 token 的场景里，W1 投影贵约 71%，三次压缩贵约 3 倍，质量无收益 | `output/context-runtime-ab-batch-b2/b4-*.json` |
| 单次请求内的查找、易混项辨别、三跳推理、开头指令遵守到 90 万 token 不衰减；穷举计数从 50 万起出错，90 万时约三分之一出错 | `lab-runs/context-size-hard1/hard2-*` |
| 用户的设计：平时由里程碑触发压缩，里程碑是可跑几十万 token 的大阶段；`autoCompactRatio 0.75` 是硬上限，不动 | 用户 2026-10-06 |
| W2 提交期间持有全宿主读租约，会让其他会话的“懒安装”注册抛 `HOST_WRITER_BUSY`，其中一处在定时器里会成为未捕获异常 | 审查发现 2/3，`team-tools-v2-r10.mjs:8306-8314` 已核对 |
| 窗口检查点目前只支持“Team 根会话且绑定了已登记计划” | `team-v15-window-collector.mjs` |

## 2. 原则

1. **默认装载，按策略出手。** “默认开启”不等于每个请求都变换。出手与否由一个纯函数决定，每次决定都落一条可回放的记录。
2. **缓存热且上下文小的时候什么都不做。** 改写前缀的一次性代价是“保留部分 ×（未命中价 − 命中价）”，每轮收益只有“裁掉部分 × 命中价”。
3. **有损操作只在阶段边界做。** 压缩会丢细节，只在里程碑（大阶段完成）或硬上限时做。
4. **任何一步校验不过就原样继续**，不让窗口机制把一个正常回合变成错误。

## 3. 触发策略（W3 决策器）

输入：服务商回报的本会话上下文 token 数 `T`；上一次请求的命中比例 `h`；距上一次成功请求的秒数 `idle`；是否有刚完成且未处理的里程碑；窗口上限 `W`。全部可配置，下面是默认值。

| 条件 | 决定 |
|---|---|
| `T < 200k` | 不动。里程碑打勾只记录（已实现：`minMilestoneFoldTokens`） |
| `200k ≤ T < 500k`，里程碑刚完成 | 在空闲边界压缩（用户的主路径） |
| `200k ≤ T < 500k`，缓存已冷（`h < 0.2` 或 `idle` 超过配置的缓存寿命） | 允许在空闲边界折叠：此时重写前缀没有额外代价 |
| `200k ≤ T < 500k`，其他情况 | 不动 |
| `T ≥ 500k` | 在下一个安全边界主动折叠，不等里程碑 |
| `T ≥ 0.75 W` | 现有硬上限路径，原样保留 |

- 500k 这一档的依据是成本（每轮带着 50 万 token 即使全命中也要 0.0015 美元，冷启动一次 0.075 美元）加上穷举类任务开始出错；它是可调默认值，不是定论。
- 决策器先以 shadow 方式上线：只记录“如果自动会怎么做”和事后的实际用量，对账一段时间后才允许 `auto`。价格表作为配置输入，只用比例，不用绝对价。
- 生产配置里过期的 `cacheWriteReadRatio: 12.5` 改为 50。

## 4. 用哪种机制折叠

| 机制 | 定位 | 默认 |
|---|---|---|
| 原生压缩（摘要） | 主路径。里程碑与硬上限都走它 | 开（已是现状），加大小下限 |
| W2 持久切窗（检查点 + 原文可精确取回） | 压缩的替代：不需要摘要调用、不丢原文，适合“缓存已冷”和“超过 500k 但阶段没完”的情况 | 先关；满足第 6 节的前置条件后，在策略允许的时刻启用 |
| W1 请求投影（每个请求单独裁剪） | 不作为常规手段：它不落盘，每次都要重新保证前缀稳定，收益被缓存抵消 | 关；只保留 W0 影子记录用于观察“会裁掉什么” |
| async PTC | 与折叠无关，按需求证据单独决定 | 关（需求量化在 `output/async-ptc-demand/`，待验收） |

## 5. 普通会话怎么办

第一阶段**不**把窗口检查点扩展到无计划的普通会话。普通会话只用压缩（它不依赖计划），并受同一个决策器约束。W2 仍限定在“Team 根会话且有已登记计划”，因为检查点的价值正是把计划、任务、租约这些权威状态带过去；没有计划的会话没有这些东西可带，用摘要就够了。是否为普通会话定义“无计划检查点”，等 W2 在 Team 根会话上有了真实使用数据再定。

## 6. W2 启用前必须解决的三件事

1. **去掉提交期间的全宿主读租约。** 现在的做法是悲观锁：从准备到两次落盘都持有宿主读租约，期间任何会话的构造类变更都同步抛错。建议改成乐观校验：准备时取 `gate.snapshot()`；在追加 commit 记录之前的同一个同步段里 `gate.assert(snapshot)`，纪元变了就中止并登记 ABORTED，下个边界重试。单线程事件循环里“校验 + 追加”之间不会插入其他代码，所以校验点与提交点一致；之后的落盘等待不再需要锁，因为提交决定已经在追加那一刻做出。这样审查发现 2、3 涉及的所有调用方都不再受影响，不必逐个补丁。**这改的是并发契约，必须先过 oracle 或 reviewer。**
2. **协议证书改为进程内签发。** 把实验工具里的协议自检搬进运行时：启动时自检一次，证书绑定相关源码哈希与配置指纹，有效期跟宿主纪元走（HMR 或配置变化即失效并重签），不再用 120 秒墙钟。
3. **去掉“必须是隔离会话”的硬编码**，换成配置的会话范围策略：`off` / `shadow` / 名单 / 全部符合条件的 Team 根会话。保留一个全局急停开关。

已完成、作为防线保留：拆除类调用在读租约或写者期间排队（`runRelease`）；已提交窗口后的普通变动在适配器边界同步刷新 current-authority 消息。

## 7. 缓存对齐检查项

- 每轮都会被替换的消息必须在历史末尾。current-authority 消息已是追加在末尾。运行时上下文快照与 Team context manifest 在一次真实运行的日志里是以 `append` 方式追加在当轮用户消息之后，下一轮内容不变时不再追加（`lab-runs/ab-b2-w1-base-r1-20261006T0755`，只核对了这一个样本）：旧快照留在原位、新快照追加并声明取代旧的，不改写头部，对缓存友好。里程碑快照的位置未核对。
- 压缩和切窗都会改写头部，这一次未命中不可避免，所以才需要第 3 节的条件。

## 8. 上线顺序与每步的证据

1. 部署代码，全部关闭；写入 `minMilestoneFoldTokens: 200000`、`cacheWriteReadRatio: 50`；隔离会话核验加载与下一次请求。
2. 决策器 shadow：在真实会话上记录决定与实际用量，至少覆盖若干个跨过 200k 的会话。
3. 多轮大上下文实验（用户已批准）：10/30/50/70 万 token，压缩臂对不压缩臂，看约束保持与成本。
4. W2 的三项前置完成并过审查后，在名单内的 Team 根会话启用；故障矩阵在非隔离宿主上重跑。
5. 决策器 `auto`。

## 9. 未决问题

- 服务商缓存的实际寿命未知，`idle` 阈值先做成配置，用 shadow 数据里“间隔多久后命中比例掉下来”来定。
- 乐观校验方案是否满足规范 §10.1 对“提交时 CAS 与线性化点一致”的要求，需要审查确认。
- 500k 主动折叠时阶段还没完成，用压缩（有损）还是等 W2 就绪后用切窗（无损），取决于第 3 步实验里压缩在大上下文下的约束保持率。

## 10. W2 生产接线设计（2026-10-07，Claude；依据两轮只读调查，未评审）

约束（已从代码确认）：
- collector 的 `sessionIds` / `planBindings` / `protocolCertificateHash` 创建即冻结并进入 configFingerprint；`apply` 只能装一个（固定服务名与投影名）。所以**每个会话一个 collector**，用工厂 `createServerWindowCollector` 创建，由接线插件自己以唯一名字注册 `project` / `onDispatch`，不走 `apply`。
- 允许名单 `windowSessions` 在 `team-v12-runtime` 启动时一次性构造，无运行时入口。需要新增受限的 `teamWindowRuntime.admit(agent)`。
- 提交过窗口的会话，surface 必须在其整个生命周期内保持安装：没有它，后续请求只带历史检查点、缺 current-authority 消息，且不会报错。宿主重启后必须重建 collector + surface 并 `recover()` 到 clean，之后才能放行该会话的请求。
- 实验室的协议证书（绑定测试日志、`productionAuthorized:false`、120 秒）不能用于生产；`proveCompletedReasoningSpan` 在插件目录，可直接用；replay 降级守卫与 PTC binding 采集是实验专用，非提交必需。

设计：
1. **范围策略**（`team-v15-window-manager` 配置 `window.scope`）：`off`（默认）/ `list`（显式会话 id）/ `team-roots`（任何 tier 0、`member.root===agent`、`agent.id===sessionId` 且有已登记计划的 Team 根）。全局急停 `window.enabled:false`。只有通过策略的会话才调用 `admit`。
2. **`admit(agent)`**（`team-v12-runtime`）：仅当配置 `windowAdmission` 为 `runtime` 且调用方满足上面的根会话形状时把会话加入名单；否则抛 `WINDOW_SESSION_NOT_ALLOWED`。保留 `windowIsolatedSessions` 作为静态名单。
3. **进程内证书**：接线插件启动时自检一次——读取它实际依赖的窗口模块文件（projection / protocol / collector / surface / transition / participation / checkpoint / request-message-projection）的 SHA-256，连同路由（provider/model/api）与 `kind:'in-process-protocol-v1'` 组成证书体，`certificateHash = windowHash(body)`，作为该进程内所有 collector 的 `protocolCertificateHash`。证书体不含过期时间；route 的 `expiresAt` 在每次尝试前按“现在 + 5 分钟”重发，`configFingerprint` 每次尝试前从 `authorityForSurface(...).capture(...).source` 重取（它含宿主纪元）。文件哈希变化（HMR）即证书失效：已安装的会话保持只读保护（current-authority 仍然送达），不再发起新的提交，直到重启。
4. **安装**（按会话，惰性）：策略通过 → 身份 active、计划已登记 → `admit` → 建 collector（`isolated:true, sessionIds:[id], planBindings:{[id]:planId}, allowedRoots, recoveryDirectory, protocolCertificateHash`）→ 注册投影 → `createServerWindowSurface`。任一步失败：记录原因，本会话本进程内不再尝试，照常用压缩。
5. **重启恢复（fail-closed）**：agent 创建时扫描会话日志；若存在 `windowCommit` 或未决 `native/window-intent`，立即走安装并 `recover()`（对“宿主正在写”做有界重试）。在恢复到 clean 之前，该会话的 `agent/pre-step` 一律 reject（原因落盘）。安装失败同样保持 reject——宁可停下，也不能在缺 current-authority 的情况下继续。
6. **触发**：只在 `decideWindowAction` 给出 `fold` 且 `mechanism:'window'` 时，于 agent 空闲边界调用 `surface.commit()`。提交成功后把该成员的里程碑记为已折叠（避免压缩插件再压一次）。`transitionAborted` / `W2_DEFERRED_HOST_BUSY` / `WINDOW_NO_COMPLETED_SPAN` 等一律回退到现有压缩路径；硬上限始终走压缩。新的折叠需求出现时 `resetDemand()`。
7. **与压缩插件的先后**：压缩插件在空闲时折叠之前先问接线插件（服务 `windowFold.tryFold(agent, reason)`），返回 `folded` 则跳过压缩。没有该服务或返回其他值时行为与现在完全相同。
8. **上线顺序**：`off` 部署 → 隔离会话 `list` 验证（含重启恢复、宿主繁忙中止、HMR 证书失效）→ 真实 Team 任务 `list` → 是否开 `team-roots` 由用户决定。

分包：A = `admit` + 证书 + 按会话安装 + 重启恢复 + 提交入口（不含触发与压缩插件钩子），带测试与 reviewer 审查；B = 触发与 `tryFold` 钩子（改压缩插件，等“引擎压缩后的恢复通知”那项改动落定后再做）。

## 11. 审查后的修订（2026-10-07，reviewer 第二部分 6 条 + 64 回合上限）

1. **拆除与重装**。安装句柄的 `dispose()`：agent 已不在名单（会话结束/重开）→ 注销 collector 投影、`surface.dispose()`（此时它本就允许）、撤销准入；agent 仍在且已提交窗口 → 默认保留。另给 surface 加显式的 `dispose({ handover: true })`：只供同一进程内“立即重装”使用（接线插件热重载、`requestMessageProjection` 服务被重建），跳过“已提交窗口不得拆”的守卫。接线插件记录安装时拿到的投影服务实例；每个 pre-step 发现当前实例不是它，就对有窗口状态的会话拒步并在空闲时重装 + `recover()`。原则：有窗口状态的会话，只要没有一个绑定在当前投影服务上的健康安装，就不放行请求。
2. **证书**。(a) 绑定路由：`refreshRoute` 发现 `routeFor(agent)` 的 provider/model/api 与证书不同即抛 `WINDOW_CERTIFICATE_ROUTE_MISMATCH`；证书按路由签发。(b) 发布清单：接线插件配置 `window.expectedModules`（文件名→SHA-256，由部署工具在部署时从已评审的阶段文件写入）；签发时磁盘哈希与清单不一致则不签发，W2 对整个进程关闭（已有窗口的保护照常）。(c) 文件清单扩到提交正确性实际依赖的全部文件：8 个窗口模块 + `team-v15-window-install` / `-manager` / `-file-protection` / `-decision`、`team-control-plane`、`team-v12-runtime`、`team-v15-plan-registry`、`team-v14-durable-store`，以及原生包 `dsh-session`（index、native-bridge）、`dsh-session-persistence-jsonl`（index、window-barrier）、`dsh-agent-loop`。(d) 过期检查下沉到 `refreshRoute`；句柄不再暴露裸的 `surface` 与 `routes`。
3. **安装的原子性**。顺序改为：建 collector → 用它做一次 capture（不依赖名单，计划未登记/身份未激活/非根在这里失败）→ `admit` → 注册 → 建 surface；任一步失败按逆序撤销，包括新增的 `teamWindowRuntime.revoke(agent)`。`WINDOW_PARTICIPATION_UNVERIFIED`（宿主正在写）在安装阶段有界重试。恢复只在 agent 空闲时执行（`runMaintenance` 要求空闲），pre-step 只负责拒步，不负责恢复。
4. **“需要恢复”的判定**与 transition 构造函数对齐：`needsRecover = committed || pending`；读不到会话日志时抛错而不是返回“无状态”。安装句柄暴露 `needsRecover()`，`commit()` 在 paused 时先要求恢复。
5. **collector 投影**按会话短路（不是本会话直接原样返回，不进审计环）。
6. **64 份回合副本上限**：先查清 `retainCompletedTurns` 的保留语义（是否可以只保留“上一次已提交窗口之后”的回合、已折叠进窗口的回合副本是否仍需保留用于精确取回）再定：候选是按窗口分代清理 + 把上限做成配置。未查清前这是 W2 对长会话可用性的已知阻塞项。

## 12. 第二轮修订（2026-10-07，实现后发现的两条硬约束）

1. **同一会话在同一进程内不能重装**。原生 session bridge 一个会话只允许绑定一个窗口闸门且没有释放接口（`dsh-session/lib/native-bridge.js` 的 `bindWindowGate`，重复绑定抛 `WINDOW_COORDINATOR_ALREADY_INSTALLED`）。所以第 11.1 节的“交接拆除后立即重装”做不到。改为：安装句柄保存在**进程级登记表**（`globalThis[Symbol.for('dsh.window.installs.v1')]`，按会话 id）里，接线插件被热重载后从登记表**接回**原句柄而不是重装；被接回的句柄证书已失效（模块文件变了），按设计不再发起新提交，但已有窗口的保护继续生效。若 `requestMessageProjection` 服务本身被重建，旧注册随之消失且无法补注册：该会话在本进程内一律拒步（原因落盘），直到宿主重启。`dispose({handover})` 保留，但只用于 agent 已离开名单时的清理。
2. **回合副本上限**。每个已完成回合在磁盘上保留一份副本，按会话累计、永不清理，采集器对日志里**每个**已完成回合都要求副本存在并复核；原硬顶 64。已把硬顶放到 4096，生产安装默认申请 2048。遗留：每次 capture 都要复核全部副本，回合数多时每个请求的开销随之线性增长（未测量）；根本做法是只对“最后一次已提交窗口之后”的回合要求副本并按窗口分代清理，需与 surface 的窗口边界对齐，另行设计。

执行层（第二包 A2a）：新模块 `team-v15-window-executor.mjs`，不含 cordis 接线，只提供：`ensureInstalled`（按第 10.4 节惰性安装并登记）、`needsGuard` / `guardStep`（有窗口状态而没有健康安装或尚未恢复到 clean → 给出拒步原因）、`recoverIfNeeded`（仅在 agent 空闲时）、`tryFold`（仅当判断函数给出 `fold` + `window`、证书有效、无需恢复时提交；任何中止/推迟/无可折叠片段返回 `fallback` 让调用方走压缩）。A2b 再把它接进 `team-v15-window-manager`（范围策略、agent 创建/空闲/步前三个钩子）和压缩插件的 `tryFold` 询问点。
