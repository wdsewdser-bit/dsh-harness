# 宿主协议规格（team 宿主）

状态：草案。本文件只写规格，不改代码。

本文是宿主协议的权威规格。修订记录、外部审查意见与内部设计记录的编号属于内部过程材料，不在公开导出版中列出。

引用口径：本文所有"文件:行"都是实际读到的位置，行号对应 2026-10-28 的仓库状态。只用审查转述、没有亲自读到的结论标"未证实"。

术语：
- **宿主（host）**：产品里唯一驱动团队的那一层，位于 packages 下的 host 模块。
- **团队**：一个 teamId 作用域内的全部持久状态（store、成员、任务、消息、租约、驱动、游标、投影）。
- **周期（cycle）**：宿主一次串行推进，只包含状态推进与派发决策，不包含等待外部 IO。
- **effect**：需要外部动作的那条 outbox 记录。
- **准入（admission）**：允许新的业务写入（派发任务、发布产物、完成）。它与"团队能不能启动、能不能看状态"是两件事，见不变式 7。

---

## 1. 宿主的职责边界

### 1.1 宿主拥有什么

| 职责 | 说明 | 现在的落点（缺位时为"无"） |
|---|---|---|
| 所有权与 epoch | 以规范化团队目录为键：进程内注册 + 操作系统级独占锁；取得后写持久 epoch；所有命令、claim、回写校验 epoch；派发外部动作前再校验一次所有权。 | 无（apply 直接建库，profiles/team-plugin.mjs:22） |
| 驱动周期 | 每团队一个周期，只串行状态推进与派发决策：时钟、截止与窗口、准入、claim 清扫、派发（写 effect 或放进途集合）。外部 IO 不进周期。 | 只有生命周期 driver（lifecycle-driver.mjs:64-104），且它会 await 原生端口（:13-16） |
| 定时器 | 周期定时器、续租定时器、claim 超时清扫定时器、意图反对窗口到期。全部可停止、可等待、unref。 | 生命周期 driver 的 500ms 定时器（lifecycle-driver.mjs:101-102） |
| 续租 | 按"当前绑定 + fence + generation + 未过期"续租，间隔小于租约 TTL 的一半；续租不依赖在途外部调用。 | 无（runtime.mjs:81-87 的 heartbeat 无生产调用方） |
| 事务边界 | "意图 + effect 一次提交"→ 外部动作（有界在途集合）→ "回写一次提交"；外部动作期间不持有事务；区分"claim 已超时"与"调用已结束"，容量耗尽时背压并为安全收尾保留独立容量。 | 无统一所有者；native.mjs:18-46 自己有一套 |
| 可见性边界 | 请求前与步骤间隙按同一机制生成候选并注入；请求边界按真实请求载荷确认可见；关窗时冻结可见性事实。 | 无（provenance.mjs:5-30 无生产调用方） |
| 恢复与解冻 | 恢复把持久状态收敛到确定结论；解冻是另一个开关，只在没有未裁决**完成 token** 时打开。完成 token 未决时团队仍可启动、可看状态、可用运维命令，但不准入；普通 attempt / effect 的 unknown 只限制各自影响范围（不变式 5 规定 1）。 | 只有构造期 recover（core/index.mjs:18-22），且有栅栏问题（见不变式 7） |
| 停机 | 状态机收尾：停业务命令 → 撤钩子与定时器 → 允许当前 epoch 的在途回执回写 → 超时或关库屏障后撤销回写资格 → 关库。 | 只有 driver.stop(); store.close()（profiles/team-plugin.mjs:37） |
| 命令网关 | 所有写命令的唯一入口（含 operator 命令），按团队路由；外部请求身份与内部 CAS 分两层。 | 分散在 projections/commands.mjs:8-48 与 profiles/runtime.mjs:58-74 |
| 会话路由 | 组长会话决定团队；成员执行会话按 (teamId, memberId, generation) 路由；所有事件先路由再处理，禁止广播。 | 无（一个实例一个 store、一个身份） |
| 可观察面 | 状态机状态、准入开关、周期结果、被吞掉的错误、未知 effect、窗口统计、恢复结论。 | 无（错误多被吞：lifecycle-driver.mjs:77-78） |

### 1.2 宿主不拥有什么

- **领域规则**。租约 TTL、准入条件、状态机、完成判定、意图门禁归 reducer/core。宿主只按规则调用，不改规则。今天被破坏过一次：engine.mjs 把租约从 60 秒（index.mjs:86）改成 180 秒（engine.mjs:64、124）。
- **快照内容**。文本与 payload 由 core 生成（snapshot.mjs:34-73），宿主只负责注入与确认。
- **SQLite 事务、CAS、journal、outbox 持久化**。归 store（store/index.mjs:63-115）。
- **原生 API 版本适配与会话日志读取**。agent 生命周期、session 事件、executor、离线会话日志的读取都归 adapter（今天只有 create/resume/cancel/dispose，profiles/runtime.mjs:27-56；离线读取端口不存在）。
- **Git / worktree / 独立 verifier**。归 delivery（delivery/index.mjs:34-116）。
- **读侧投影与 HTTP/SSE**。归 projections（projections/http.mjs:25-27、51-52）。写网关在宿主，读接口不在。
- **模型工具 schema 与角色文案**。归 contracts/core。

### 1.3 与现有模块的关系（只写依赖方向）

宿主依赖：contracts、core、store、context、delivery、adapter。
宿主被依赖：profiles（组合根）、projections（只读引用）。
宿主**不**被 core 依赖：core 里出现的"驱动方"只是注释（runtime.mjs:26、lifecycle-driver.mjs:57-63）。

---

## 2. 公共接口草案

这一节是骨架形状，不是最终签名。M1b 落地可以改名，但不能减少职责。

### 2.1 生命周期与状态机

状态机（不变式 9 使用同一份）：

    starting ──→ recovering ──→ running ──→ stopping ──→ stopped
         └──────────┴───────────────→ stopping        （starting / recovering 可直接取消到 stopping）

- 不允许跳回；stopped 是终态，重启是一个新实例、新 epoch。
- starting 与 recovering 都必须能直接转到 stopping（stop 取消启动，见 2.1 规定 3）。
- running 上另有一个准入开关：默认关闭，只有"没有未裁决完成 token"时才打开（不变式 7）。
- recovering 期间准入一定关闭；running 但存在未裁决 token 时准入也关闭，但状态、投影、运维命令可用。

    createTeamHost({ teamId, root, adapter, delivery, context, clock }) -> host
    host.start()                       // 取得所有权 → 写 epoch → 恢复 → running（准入按结论开关）
    host.stop({ timeoutMs })           // 状态机停机；幂等；返回同一结果
    host.recover()                     // 冷启动恢复；start() 内调用一次，也可单独重放
    host.status()                      // 见 2.5

规定：
1. start() 的第一步是取得所有权（1.1、不变式 1）。取不到就停在 starting 并失败，不建业务库、不建定时器、不注册钩子。
2. start() 失败不留半个状态：释放锁、撤销已注册的钩子、关闭已开的库。
3. stop() 的时间预算（timeoutMs）覆盖整个 stop，包括取消未完成的 start()/recover()。stop 先发取消，再等它们撤销；预算到期后隔离尚未完成的异步结果：它们不得再注册钩子、派发外部动作或写库，只允许写外部日志与指标。重复 stop 返回同一个结果对象。
4. stop() 返回不代表外部动作已经停止（不变式 9）。
5. recover() 只在"已取得所有权、准入尚未开放、没有正常执行派发"的恢复阶段可调用（start 内部的 recovering，或 stopped 之后运维重放时先进入 recovering）。running 时拒绝；若要支持运行中重放，必须另行定义完整的维护模式，本版不定义。
6. recover() 只读持久状态与 adapter 提供的会话日志，不依赖内存中的 agent 句柄；日志不可获得时必须报告能力缺失（不变式 7）。恢复提交走内部专用命令类型（不变式 7 规定 2）。

### 2.2 挂到 DSH 会话上的钩子

入口先路由，再处理：把 executionSessionId 换成 (teamId, memberId, generation)（2.3）；换不到就无操作。禁止"广播给所有团队，各自尝试处理"。

| 钩子 | 触发 | 宿主做什么 | 对应现有实现 |
|---|---|---|---|
| pre-step | 每次 agent 请求前（上游 agent/pre-step） | 路由到成员绑定 → 让 core 生成候选快照 → 经 adapter 注入端口写进本轮消息 → 记下待绑定候选（按会话排队，串行） | engine.mjs:57 |
| 步骤间隙 | 每次工具调用结束后、下一条请求开始前 | 检查本会话是否有新到消息或责任页变化，有则按同一机制注入，不等整轮结束 | 无。**这个触发点是否存在尚未验证**（见 2.2 规定 6） |
| 请求边界 | adapter 在真正发出请求前给出请求身份 | 把上一次注入的候选绑定成 manifest；按真实载荷确认可见 | engine.mjs:120-121 |
| session/event | 会话事件 | 路由到团队后做原生观测、GoalGate.inspect；**不**在这里决定可见性 | profiles/runtime.mjs:17-20、goal-gate.mjs:97 |

规定：
1. 注入只产出候选，不写 visible。生成快照不等于可见（不变式 8）。
2. 同一会话的注入串行：同一时刻最多一个待绑定候选；并发请求要么复用它，要么排队。
3. 请求边界要真实载荷：请求身份来自 adapter 实际发出的那次请求，不是宿主自造的序号。产品侧今天**没有**这个钩子（profiles/runtime.mjs 无请求前回调）。
4. 钩子在 stop() 撤钩子阶段撤除；撤除后的回调是无操作，不抛错。
5. 请求前注入与步骤间隙注入是同一机制的两个触发点，不是两套实现。
6. **步骤间隙的时序保证尚未验证**：从 agent/pre-step 的注册点看不出它多久触发一次、是否覆盖工具调用之间；"只在整轮开始注入"的说法同样没有证据。这需要 adapter 探针证实（F16 标注"需 adapter 探针证实"）。

### 2.3 会话映射与团队创建

两张持久映射，不能压成一张：

| 映射 | 语义 | 唯一性 |
|---|---|---|
| ownerSessionId ↔ teamId | 开启团队模式的会话（组长会话）拥有这个团队 | 一对一；一个会话最多一个团队，一个团队只有一个组长会话 |
| executionSessionId → (teamId, memberId, generation, attemptRef) | 每个成员的原生执行会话 | 一个执行会话只属于一个团队的一个成员代；generation 变化后旧映射失效 |

规定：
1. **teamId 由服务端生成**：安全标识，规范化后作为团队目录名，不拼接任意用户输入。
2. 组长会话就是团队的 owner；成员执行会话不是 owner，也不产生新团队。
3. 所有全局入口都先路由再处理：工具绑定、pre-step/步骤间隙、session/event、goal completion guard、HTTP/SSE、命令网关。**禁止广播**。
4. 非团队会话（没有 owner 映射、也不是执行会话）不产生也不读取团队数据。
5. 映射是持久的：冷启动能还原 owner 与所有执行会话；无法还原的执行会话视为失效，不猜测。
6. **只有组长（owner）会话结束才停止团队**：团队进入 stopping，删除是显式命令。成员的执行会话结束只更新对应执行绑定、观测与故障状态，不自动停止团队，也不影响其它成员。

### 2.4 命令网关

    host.command({ requestId, teamId, actor, operationId, payload }) -> receipt

两层身份（不变式 10 之外的补充规则，见不变式 3 的可见性写入）：

1. **外部请求身份**：(teamId, 认证 actor, operationId, 规范化业务 payload)。它决定幂等：同 operationId + 同业务请求返回同一收据。
2. **内部并发控制**：事务内的当前 revision、必要的 CAS 重试。它不进入外部身份。
3. 提交顺序固定：先查已持久化的操作结果（同 operationId 且同业务请求 → 返回原收据），再做当前状态裁决；同 operationId 不同业务请求 → 明确冲突。
4. 由可见性、时钟、续租引起的 revision 变化，不能让一个已经成功的请求重放成冲突。
5. 模型侧不传版本号：协作回复是 reply { messageId, verdict: "ok" | "object", reason? }，服务端读当前消息版本并在提交里裁决（4.3）。expectedRevision 由网关补齐，不作为模型可见参数，模型也不该看到 CAS 类错误。
6. 运维命令至少包括：确认停止（回收 unknown 租约）、未知 effect 裁决、完成 token 的证据裁决、未知交付裁决、线程升级、团队停止/删除。今天只有后四类的一部分（projections/commands.mjs:18-36），没有确认停止，也没有完成 token 的裁决。

### 2.5 可观察面

    host.status() -> { teamId, epoch, state, admission, lastCycle: { at, took, dispatched, swept },
                       lastError, pendingEffects: n, unknownEffects: n,
                       inflight: { active, capacity, saturated },
                       intents: { passed, passedUnseen, objected, seenAll, seenPartial, seenNone } }

规定：周期里被拒绝/被跳过/被隔离的动作必须计数；catch 不能静默（反例：lifecycle-driver.mjs:77-78 把任何错误变成空数组）。

---

## 3. 不变量（逐条展开）

每条写三件事：现状（引擎怎么做、哪里不满足，给位置）、规定、故障测试。测试统一编号 F1–F23，汇总在 3.12。

### 不变式 1：只有一个驱动所有者

**现状。**
- 产品侧装配无条件：apply 直接建 store、建 core、起 driver、注册服务（profiles/team-plugin.mjs:22-37）。没有"同作用域已有宿主"检查。装配入口至少两处会插入同一个 entry（profiles/index.mjs:39-42、profiles/web.mjs:19-22）。
- 没有持久所有权记录：store 只有 entities/operations/events/outbox/inbox/cursors/run_slots 七张表（store/index.mjs:16-23）。跨进程时 WAL + busy_timeout 1 万毫秒（:14-15）意味着两个进程都能写。
- 没有任何操作系统级独占手段，因此"取不到所有权"今天无从判断。
- 更严重的是现在**同时有两个宿主**：真实实验 bootProfile 之后自己又起一套驱动（verification/real/engine.mjs:48、56、124），而 bootProfile 已经加载了产品插件（engine.mjs:48 → profiles/index.mjs:54-73）。

**规定。**
1. 以规范化团队目录为键：进程内注册表（同进程重复 apply 直接拒绝）+ 操作系统级独占（锁文件）。锁覆盖整个宿主有效期，进程崩溃后由操作系统释放。
2. 所有权设施自身的必要 IO 不算被禁止的副作用；失败者不打开**业务库**，不建定时器、不注册钩子。
3. 取得锁之后写持久 epoch；所有命令、claim、回写都校验 epoch；**派发外部动作之前再校验一次所有权**，防止旧宿主继续产生外部副作用。
4. 一个团队同一时刻只有一个有效宿主；"一个"按团队计算，同一实例两个团队各自一个。
5. M1b 只做本机独占，不做活进程间抢占；epoch 不能替代独占，两者都要。

**故障测试。**
- F1 重复挂载：同 ctx 两次 start → 第二次拒绝；无第二个业务库连接、第二个定时器、第二次 provide。不同路径别名指向同一团队目录 → 仍只有一个成功。
- F13 双进程与旧宿主：两进程对同一团队目录 start → 第二个拒绝；启动中崩溃 → 锁由操作系统释放，新实例取得新 epoch；旧宿主迟到派发外部动作 → 被所有权检查拦下，只留审计。

### 不变式 2：不重入，也不丢唤醒

**现状。**
- 生命周期 driver **具备部分形状，但不满足"不丢唤醒"**：有 running 守卫与 kickTimer 合并（lifecycle-driver.mjs:71-73、83-87），但没有运行期 dirty 标记——周期运行中 kick 的 timer 触发后只拿到已有 Promise，周期结束后不会再跑一轮。
- 更糟的是这个周期会 await 原生端口（lifecycle-driver.mjs:13-16、74-80）：一个端口不返回，周期就停住，后续清扫、时钟、窗口到期全部被拖住。
- 其余链路没有周期所有者：drain 同步（runtime.mjs:26-78）、applyEffect 逐条异步（effects.mjs:4-26）、tick 是纯 reducer（index.mjs:221-242），都没有"运行中到达的信号要留下待处理标记"的机制。
- 从命令侧直接回调进驱动是现存的边：发送消息提交后直接 notifyDelivery（index.mjs:124-127、tools.mjs:108-113），同步调用 preemptStep/wakeDriver（preempt.mjs:91-124、135-151）。
- 注入没有按会话串行（engine.mjs:57 的单槽 pending），并发请求会互相覆盖。

**规定。**
1. 周期串行的只是状态推进与派发决策：时钟、截止与窗口、准入、claim 清扫、把待执行动作**写进**在途集合。
2. 外部 IO 不占周期：派发后放进有界在途集合（按团队限流），回执完成时重新入队给周期处理；周期不 await 端口。
3. 端口永久悬挂不得让时钟、窗口到期、claim 清扫停摆；续租不依赖在途外部调用（否则健康执行的租约会被别人的卡住拖到过期）。
4. **claim 超时与调用结束是两件事**：claim 转 unknown 只说明结果不明，不说明底层调用已经停止，也不当然释放物理执行容量；槽位只在调用真正结束（有回执，或有可证的停止）时才归还。
5. **容量耗尽要背压**：在途集合满了就不再派发新的外部动作，但时钟、窗口、清扫、准入判定继续；容量耗尽本身是可观察状态（status 里的 inflight.saturated）。
6. **安全收尾有独立容量**：取消、停止收口、统一释放命令不能和普通派发抢同一池槽位，否则一次悬挂就能让收尾无法进行。
7. 不无条件承诺"永远有进展"：容量被悬挂调用占满时，只承诺时钟与清扫继续、状态里报饱和，并把降级写进验收（F20）。
8. kick 合并 + dirty 标记：运行中到达的信号保证"结束后再跑一轮"，不排队 n 轮、也不丢。
9. 命令侧回调只置 dirty 标记，不在提交内进周期。
10. 注入按会话串行；消息必须在步骤之间注入（2.2 规定 5、6）。

**故障测试。**
- F2 丢唤醒：周期运行中连续 kick N 次 → 只多跑一轮，且最后一轮看到全部新事件。
- 事务内 kick：在打开的提交里触发 kick → 不进入周期（断言没有嵌套 BEGIN）。
- 并发注入：同会话两个并发请求 → 两条快照各自有 manifest，没有孤儿快照。
- dispose 后唤醒：stop 之后到达的 notifyDelivery → 无操作、不抛错、不复活定时器。
- F20 端口悬挂与容量：分别验证 (a) 时钟与清扫不受影响；(b) 容量允许时其它 effect 仍有进展；(c) 全部槽位被悬挂调用占满时进入背压而非假装有进展（status 报 saturated）；(d) 无论哪种情况，stop 都在预算内返回、安全收尾仍能执行。

### 不变式 3：事务不跨越 await

**现状。**
- store 强制了下半段：reducer 返回 thenable 直接 ASYNC_TRANSACTION（store/index.mjs:102-103）。
- 上半段不满足。applyLifecycle 的顺序是：写意图 + claim（提交）→ await 原生端口（native.mjs:21）→ 改成员状态（native.mjs:24-37）→ settle（:46）。领域状态在 settle 之前就改了；settle 若因 fence 过期失败（store/index.mjs:137），成员行已无法回滚。
- effects.mjs:4-26 的形状更规矩（只写 effect 行），但把所有异常压成 unknown（:21-24），从不产出"确定没执行"。
- claim 前的 staleness 预检（effects.mjs:6-11）与 claim 不在一个事务，只是建议性的。

**规定。**
1. 一次提交只做一件事：意图与 effect 一起提交；外部动作在事务外；回写是另一次提交。
2. 持有有效 claim 的消费者，回写时在同一提交里原子更新 effect 行与领域行，并校验 effect fence、成员 generation（或 attempt fence）、目标实体 revision、epoch。
3. **失去 epoch 或 fence 的回执不改任何当前行**：既不改 effect 行（不许把已 confirmed 的结果盖成 unknown/dead-letter），也不改领域行；只追加一条带旧 claim 标识的审计记录。
4. 端口返回三态：executed / notExecuted / 不明。不明一律 unknown，不重试。
5. 迟到的"外部其实成功了"回执不得改写已经终结的结论，只作为裁决证据。

**故障测试。**
- F3 await 期间崩溃：claim 后进程被杀 → 重启后该 effect 是 unknown，成员与任务状态保持崩溃前一致。
- F4 迟到回执：三种情况分别断言"新结论不变"——(a) 新消费者已 claim；(b) 新消费者已 confirmed；(c) 旧宿主跨 epoch 回调。三种情况下 effect 行与领域行都不变，只多一条审计。
- 外部成功但回执丢失：effect 进 unknown，不重放；operator 裁决后有明确终点。

### 不变式 4：续租不能复活旧授权

**现状。**
- 正确实现存在但没人用：heartbeat 先走 authority，再在同一事务复查（runtime.mjs:81-87）；authority 校验租约 active、fence 相同、未过期、成员 desired 为 active、generation 相同（index.mjs:94-100）。
- 真实在跑的是 engine.mjs:64：每 20 秒遍历所有已绑定状态，只要 lease 仍是 active 就把 expiresAt 改成 now+180000。不校验 fence、generation、成员是否冻结、是否已过期，且把常量从 60 秒改成 180 秒；写入 actor 是 'adapter'，authorize 对 privileged actor 直接放行（authorization.mjs:8）。

**规定。**
1. 只有 heartbeat 延长租约；TTL 只在 reducer 里定义一次。
2. 续租必须来自当前绑定的执行：携带 attemptId 与 fence，绑定由宿主在执行开始时登记、结束时撤销。
3. 过期即拒绝，无宽限；过期后先由时钟降级为 unknown。
4. 成员 desired 不是 active、被冻结/退休、generation 变了，一律拒绝。
5. 续租不依赖任何在途外部调用（不变式 2 规定 3）。

**故障测试。**
- F5 续租复活：冻结成员的在途 attempt → 续租被拒，租约到期转 unknown。
- 过期后到达的续租 → INVALID_LEASE，expiresAt 未改写。
- 旧 fence 续租 → 拒绝；旧 epoch 宿主的续租 → 拒绝。

### 不变式 5：unknown 不释放冲突资源

**现状。**
- 资源确实还被占着：tick 把过期租约转 unknown 并保留行（index.mjs:226-232），store 对 active 与 unknown 都写 run_slots（store/index.mjs:81-85），准入遇到同 owner/task/scope 的 unknown 一律拒绝（index.mjs:71-82）。
- 唯一的回收手段没有入口：confirmStopped 要求 actor 是字面量 'operator' 且带证据（effects.mjs:35-44），命令网关没有这个分支（projections/commands.mjs:18-36）。UI 的 token 只能映射到 member:root（profiles/web.mjs:22），而 mailbox.mjs:5-13 已说明浏览器不能以 operator 认证。
- 重启调用 recover 只处理 active 的行（runtime.mjs:6-14），不动 unknown → unknown 实际永久占用。

**规定。**
1. **unknown 分三层，影响范围不同，不得混成"任何 unknown 都冻结全团队"**：
   - 完成 token 未决 → 关闭团队级业务准入（不变式 7）。
   - 普通 attempt unknown → 只保留它自己的 owner/task/scope 冲突占用，不冻结无关成员与任务。
   - effect unknown → 只限制受影响的那条链路（该成员的生命周期、该次派发），不冻结团队。
   扩大为全局冻结必须作为新的领域政策显式写进 reducer，不能靠一句概括隐式引入。
2. 超时不等于停止证据；unknown 继续占用它自己的冲突资源。
3. **资源释放统一经过同一个领域命令**（统一的 releaseAttempt 类 reducer）：撤销执行、回收租约、释放冲突占用都走这一条；证据可以来自受信端口的停止/失败回执，也可以来自 operator 裁决，**入口不同、写路径相同**。
4. operator 必须是真实认证主体，不是团队角色；可以是本机运维接口，但与浏览器 token 区分。
5. 重启不改变 unknown 结论，也不重复产生停止动作。
6. unknown 的团队仍然可以 running（准入关闭只在完成 token 未决时发生，见规定 1）。

**故障测试。**
- F6 unknown 占用：租约到期 → 同成员新准入被拒（CAPACITY），unknown 行仍在。
- 确认停止：operator 命令 → 经统一释放命令撤销租约、任务 failed、等待边取消；后续准入放行。
- 端口给出明确停止证据 → 同样经统一释放命令收口，不需要人工，也不产生第二条写路径。
- 无证据确认 → 拒绝；团队角色调用 → 拒绝。
- 重启后 unknown 保持 unknown，不被 recover 清除，也不被续租。
- F24 分层：一个成员 attempt unknown 时，无关成员与任务照常准入；effect unknown 只限制相关动作；完成 token 未决才关闭团队准入。

### 不变式 6：效果不盲目重试

**现状。**
- claim 原子（状态 + nextDue + tries，store/index.mjs:129-134），settle 校验 fence（135-142），这两点是资产。
- applyEffect 只产出 executed 与"不明"（effects.mjs:19-25），从不产出 notExecuted，所以 retryable 在正常路径不可达（store/index.mjs:138）。
- 没有运行期 claim 清扫：reconcile 只在启动调用一次（runtime.mjs:21）。
- tries 到 5 后 claim 永远 NOT_CLAIMABLE（:131），而 adjudicate 只接受 unknown（156-159）→ 到上限的效果没有终点。
- 协议层面今天不成立（详见 5.1）：cancel 有两种载荷且与端口参数不匹配（index.mjs:230、profiles/runtime.mjs:43-44）；member-lifecycle 有两种载荷且没有消费者；生命周期意图由扫描器消费，同时又写 outbox。

**规定。**
1. **协议的权威是 5.2 目标表**：每种 kind 只有一个载荷形状、一个消费者、一次收口；5.1 的现状表只用于解释迁移。
2. claim 原子，operationId 用 effectId，claim 携带 epoch；只有有效 claim 持有者能收口（不变式 3 规定 2、3）。
3. attempt 级取消必须解析到**精确执行绑定**（按 attemptId/generation），不能"按成员查当前句柄"。
4. **释放资源只有一个领域命令**（与不变式 5 规定 3 同一条）：撤销执行、回收租约、释放冲突占用都走它；证据来自受信端口回执或 operator 裁决，写路径相同。effect 表里的 cancel、lifecycle 都通过它收口，不各写一份。
5. **lifecycle 按三态分别收口**（缺一即视为没实现）：
   - executed：同一事务里 settle effect、member-intent=confirmed、成员换代（generation +1）、执行绑定更新、会话映射从旧 generation 切到新 generation。
   - notExecuted：effect 回 retryable、member-intent 保持待派发、成员状态不变、**不递增 generation**、不动旧执行。
   - unknown：effect 与 member-intent 在同一事务一起转 unknown（同一个人工裁决出口），成员与旧执行保持占用，**不递增 generation、不撤销旧执行**。
6. 生命周期意图的唯一权威是 member-intent 行；outbox 只作为执行索引，扫描器只负责派发、不执行。
7. 只有 notExecuted 重试；不明进 unknown；到重试上限进 dead-letter，可裁决、可观察。
8. 运行期必须清扫超时的 applying（等价 store/index.mjs:143-155，但按周期跑）。

**故障测试。**
- F7 claim 超时：claim 后无回执 → 一轮清扫后 unknown（不等下个进程）。
- 并发 claim：两处同时 claim → 一次成功一次 NOT_CLAIMABLE。
- 端口抛错 → unknown；明确 notExecuted → retryable 且退避后重试；到上限 → dead-letter。
- F21 双消费、精确取消与三态收口：生命周期意图同时被扫描器与 outbox 消费者发现 → 只执行一次；旧 attempt 的 cancel 到达时成员已绑定新执行 → 取消落在旧 attempt，新执行不受影响；executed/notExecuted/unknown 三种回执分别断言 generation、member-intent 终态与执行占用符合规定 5。

### 不变式 7：恢复先于 admission，但不能被完成栅栏锁死

**现状。**
- 恢复在构造函数里做（core/index.mjs:18-22），走 core.mutate('runtime')，而 mutate 检查完成栅栏：存在 prepared/authorized/unknown 的完成 token 时，非 completion 前缀一律 COMPLETION_FROZEN（index.mjs:34-36）。所以**残留一个未消费 token，构造函数直接抛错，整个 profile 起不来**（team-plugin.mjs:26）。
- GoalGate.reconcile 没有生产调用方（attach 只注册 check 与 inspect，goal-gate.mjs:95-99），而且它只处理 authorized/consumed（:83-84），**不处理 prepared**。
- 对账依赖 session.snapshotEvents()（goal-gate.mjs:82-84），宿主没有"离线读取会话日志"的端口，所以"无会话也能恢复"今天无法实现。
- 完成冻结是全局的：工具（tools.mjs:94）、preempt（preempt.mjs:46-48）、运维命令（operator-command.mjs:11）全部拒绝。这就是"团队起不来"和"业务不能准入"被混成一件事的来源。

**规定。**
1. **恢复完成与业务解冻分开**。恢复完成 = 把持久状态收敛到确定结论；解冻 = 打开准入开关。两者不耦合，后者可以一直关着。
2. **恢复提交使用内部专用命令类型**（如 system.recover），只允许修改限定集合：attempt 租约与状态、member-intent 状态、effect 行、runtime 恢复标记、completion token 的结论字段。它不能改任务、交付、消息的业务状态，也不给任何普通业务 actor 通用的"穿过栅栏"能力。
3. **准入关闭期间仍然允许执行**：恢复提交本身、完成 token 的证据裁决、执行/租约的停止证据收口（统一释放命令）、状态与投影查询。业务命令（派发、produce、accept、完成、交付）一律拒绝。
4. 对账结论只有四种：能确认完成已发生 → consumed；能证明未授权执行的 prepared → 安全撤销（cancelled + 证据）；**prepared 但无法证明可安全撤销 → unknown**，保留证据并进入同一个人工裁决出口；authorized/consumed 无法判断或日志不可读/损坏 → unknown，并记录"能力缺失"。
5. **unknown 时团队可以 start 到 running**，可以对外提供状态、投影与运维命令，但**准入保持关闭**：不派发新任务、不发布产物、不接受完成。注意这只是 completion token 未决这一层；普通 attempt unknown 不关闭团队准入（不变式 5 规定 1）。
6. 解冻条件：不存在未裁决的完成 token（只剩 consumed 或 cancelled），且恢复结论已落库；解冻是一个显式提交，可观察。
7. 离线日志读取是 adapter 端口（2.1 规定 5）；日志不可获得时不得当作"没有完成"。
8. 证据裁决入口：operator 命令可以把 unknown 的完成 token 裁成 consumed（确认已发生）或 cancelled（确认未发生），带证据引用；这是唯一的人工出口，不做自动解冻。prepared 转来的 unknown 用同一出口。
9. 恢复失败必须可观察（status 里能看到），不能静默半启动。
10. 启动顺序固定：开库 → 恢复提交（租约、意图、效果）→ 完成 token 对账 → 启动周期 → 按结论设置准入。

**故障测试。**
- F8 恢复与解冻（改写）：
  - 库里同时有 authorized token 与 active attempt → 团队启动成功、状态可读、准入关闭、token 降级 unknown、运维命令可用。
  - 存在完成栅栏时，恢复提交**实际成功**（专用命令类型穿过栅栏；普通业务命令仍被拒绝）→ 断言恢复的写入生效、业务写入失败。
  - 只有 prepared token → 能证明未授权执行就安全撤销；**证据不足 → 转 unknown**，保留证据，进入同一人工裁决出口，不依赖"有没有在途 attempt"。
  - 离线日志不可读 → 结论 unknown + 记录能力缺失，准入关闭，**不能因此自动解冻**。
  - 日志损坏 → 同上，且不重复写完成事实。
  - operator 裁决（consumed/cancelled）后再次启动 → 结论稳定、准入打开、不重复裁决。
  - 验收口径：**不以"自动解冻"作为通过条件**，以"启动成功 + 状态可读 + 准入关闭 + 裁决后开闸"为准。

### 不变式 8：可见性必须来自真实请求载荷的证据

**现状。**
- 规则写得不错：visible 要求 requestId、manifestHash、sessionSeq（index.mjs:133-139）；requestBoundary 校验 manifest 哈希、generation、消息绑定时 generation（provenance.mjs:19-30）。
- 产品里没人调用（provenance.mjs:5、19 无生产调用方）；真实实验自己拼了一套（engine.mjs:57、120-121）。
- 上一版把"压缩丢快照"写成"模型明明看过却永远不可见"，这个推论不成立，已更正：若首次请求之前源就丢了，engine 直接抛 NATIVE_MANIFEST_SOURCE_MISSING（engine.mjs:120），这时不能说模型看过；若某次真实请求已经确认过，后续压缩不应该撤销证据。
- 步骤间隙注入完全没有；pre-step 的触发频率是**未验证的时序假设**（2.2 规定 6）。

**规定。**
1. 宿主拥有"注入—绑定—确认"的配对关系，候选与它注入的那条原生消息一一对应，按会话保存。
2. 生成快照不等于可见；只有拿到真实请求载荷（requestId、sessionSeq）后才写可见。
3. 至少一次，不承诺恰好一次；不得伪造，也不得因为快照丢失就跳过。
4. 跨 generation 的旧消息一律拒绝（STALE_MESSAGE_BINDING 保留）。
5. 注入有两个触发点：请求前与步骤间隙，共用同一条按会话串行的队列；步骤间隙是否存在需 adapter 探针证实。
6. **关窗时冻结可见性事实**（4.4）：decision、closedAt、seenAtClose、visibilityEvidenceAtClose。关窗之后补到的证据只写 visibilityAfterClose，**不改 decision，也不改截止时的统计**。
7. 把消息写成可见不得改变已终结的结论：现有 visible() 直接把 status 写成 visible（index.mjs:133-138），对 passed/objected 必须拒绝或只写观测字段。
8. 证据必须绑定 team、recipient、generation/bindingGeneration、manifest、requestId、sessionSeq；rebind 会让旧证据失效（mailbox.mjs:32-35 已提供 bindingGeneration）。

**故障测试。**
- F9 可见性伪造/丢弃/重复：注入后源丢失 → 保持不可见并记录；伪造快照文本 → manifest 校验失败；重复注入 → 可见幂等。
- F14 窗口到期时没有任何请求上下文证据 → 结论通过但标"通过但未确认看见"（第 4 节）。
- F16 步骤之间注入 → 断言工具调用间隙到达的消息在下一条请求边界可见（**需 adapter 探针证实时序**）。
- F19 关窗后可见性（四类线性化，见 4.4）：截止前证据先提交 → 计入 seenAtClose；迟到证明 → 只审计；截止后请求 → 事后补看指标；旧 binding/generation → 无效，既不计已见也不计补看。

### 不变式 9：停机可等待，错误可观察

**现状。**
- 停机是两个动作：driver.stop(); store.close()（profiles/team-plugin.mjs:37）。
- driver.stop 只清定时器（lifecycle-driver.mjs:94-100），不等在途周期；whenSettled 用 2ms 轮询最多 2000 次，轮询的 setTimeout 不受 stop 管理（:88-93）。
- 在途 applyLifecycle 正在 await 端口时关库，回写会打到已关闭的数据库，错误被周期的 catch 吞掉（lifecycle-driver.mjs:77）。
- 没有状态机：stop 与 start/recover 并发、超时后再 start、旧回执落到新宿主，都没有约束。

**规定。**
1. 状态机（2.1）：starting → recovering → running → stopping → stopped，不允许跳回。
2. **starting / recovering 可以直接进入 stopping**：stop 先取消正在进行的启动或恢复，再按排空规则收尾（2.1 规定 3）。
3. **stopping 的排空阶段**：拒绝新业务命令，但**允许当前 epoch、尚未隔离的在途回执经内部网关提交**。这才是"等待在途回执"的含义。
4. **超时或关库屏障之后**：撤销回写资格，只写外部日志/指标，不访问 store。
5. **预算覆盖整个 stop**：timeoutMs 从 stop 开始计时，包含取消 start/recover 的时间；预算到期后隔离未完成的异步结果，它们不得重新挂钩子、派发或写库。
6. 重复 stop 返回同一结果；重启必须取得新 epoch；stop 返回不代表外部动作已停止。
7. 停机不改领域结论：关停不是裁决，未解决的责任保持未解决（engine.mjs:220 的升级做法不能照搬）。

**故障测试。**
- F10 停机在途：端口 await 中 stop → 排空阶段正常回写并 settle；关库后无"数据库已关闭"错误逃逸；stop 超时是明确结果。
- F23 stop 与启动并发：starting 中 stop、recovering 中 stop → 都收敛到 stopped，不留半个状态；**离线日志读取永久悬挂时 stop 仍在预算内返回**，隔离的恢复结果不再写库；超时后重新 start → 新 epoch；旧回执落在新宿主运行期间 → 只留审计（同 F4c）。

### 不变式 10：游标不能消费自己产生的事件

**现状。**
- drain 每消费一个事件就提交一次游标（runtime.mjs:47-51），游标写的是实体行 'dispatch-cursor'，每次 put 都追加 journal（store/index.mjs:92-93），events() 又从游标之后读（runtime.mjs:29、store/index.mjs:53-56）。
- 于是每次 drain 至少产生一条更新的日志行，下一次 drain 永远有事件可读；读到 'dispatch-cursor' 事件不匹配调度条件，再写一次游标，再产生一条。
- 仓库已侧面承认：快照计算事件版本时排除了 manifest: 与 dispatch-cursor（snapshot.mjs:39）。同类自产噪声还有 'scheduler'（index.mjs:90）与 'deferred:<seq>'（runtime.mjs:45）。

**规定。**
1. 游标推进不能被读成输入事件：要么不写 journal（同事务只改 cursors 表），要么读取时过滤内部前缀。
2. 没有进展就不写游标。
3. 过滤规则只认输入类前缀（task:、message:），放在 drain 的读侧。

**故障测试。**
- F11 游标自循环：空转 drain 20 轮 → journal 不增长（或只增长常量条数），cursor 不变。
- 一个可调度事件 → 恰好一次 schedule；再 drain 无新事件。
- 重启后游标不回退、不重放。
- 过滤不误伤：task/message 事件仍被消费。

### 不变式 11：团队跟随会话，多会话互相隔离

**现状。**
- 一个实例一个 store（team-plugin.mjs:22）、一个 driver（:34）、一份 teamRuntime（:36）。
- 身份写死：命令的团队字段是字面量 'team'（core/index.mjs:25）；组长在 UI 侧写死 member:root（profiles/web.mjs:22）；客户端默认 viewer 也是 member:root（ui/index.mjs:7、23）。
- 实体 id 全局单例：scheduler、clock、runtime、dispatch-cursor、deferred:<seq>、dependency-events、guard-audit:latest；实体表没有团队列（store/index.mjs:16-23）。两个团队不能共存于一个库。
- GoalGate 对整个 ctx 注册 completion guard（goal-gate.mjs:95-96），没有按会话分流；每团队各注册一份却不路由，A 团队的 guard 会作用于 B 或非团队会话。
- 真实实验里所有成员属于一个团队、一个组长（engine.mjs:56）。

**规定。**
1. teamId 由开启团队模式的组长会话决定（2.3），它是全部持久事实的作用域。
2. 一个团队一个 store；驱动、续租、游标、投影、完成 token 全部分开。
3. 两张映射分开（2.3）：ownerSessionId ↔ teamId，executionSessionId → (teamId, memberId, generation)。
4. 所有全局入口先按认证绑定路由，再调用团队宿主；禁止广播后各自尝试。
5. 不共享成员身份，尤其不共享组长：每个团队有自己的组长记录与 token 映射。
6. 投影跟随会话：没开团队模式的会话看到空数据，界面不展示团队面板。

**故障测试。**
- F12 跨团队串数据：两会话同时开团队 → 成员/任务/消息/租约/游标隔离；A 的组长命令写不到 B；同一后缀的成员 id 不串；成员执行会话路由到正确的团队与 generation；非团队会话的 goal 不触发任何团队 guard；重启后两张映射都能还原。

### 3.12 宿主故障矩阵

| 编号 | 故障 | 断言要点 | 覆盖的不变量 |
|---|---|---|---|
| F1 | 重复挂载/路径别名 | 第二次 start 原子拒绝；别名目录也只成功一次；无半个状态 | 1、2 |
| F2 | 丢唤醒 | kick 合并但不丢；运行中到达的事件在下一轮被看到 | 2 |
| F3 | await 期间崩溃 | 恢复结论幂等，领域状态不半写 | 3、7 |
| F4 | 迟到回执 | 新消费者已 claim / 已 confirmed / 跨 epoch 三种情况都不改 effect 与领域行，只留审计 | 3 |
| F5 | 续租复活 | 冻结/过期/旧 fence/旧 epoch 的续租全部拒绝 | 4 |
| F6 | unknown 占用 | 资源保持占用；只有带证据的 operator 确认能释放 | 5 |
| F7 | claim 超时 | 运行期清扫转 unknown；并发 claim 只成功一次；到上限 dead-letter | 6 |
| F8 | 恢复与解冻 | 完成栅栏存在时恢复提交实际成功、业务写入被拒；prepared 证据不足转 unknown 并进同一裁决出口；裁决后开闸；不以自动解冻为验收 | 7、3 |
| F9 | 可见性伪造/丢弃/重复 | 不伪造、不跳过、重复幂等 | 8 |
| F10 | 停机在途 | 排空阶段正常回写；关库后无错误逃逸；stop 超时是明确结果 | 9 |
| F11 | 游标自循环 | 空转不增长日志；无进展不写游标 | 10 |
| F12 | 跨团队串数据 | 团队间隔离；执行会话路由正确；成员执行会话结束不影响团队与其它成员；非团队会话不受影响 | 11、9 |
| F13 | 双进程与旧宿主 | 第二个拒绝；启动中崩溃后锁释放；旧宿主迟到派发被拦下 | 1、4、9 |
| F14 | 窗口到期但没人看到 | 结论通过、标未确认看见、发起方被通知、operator 不收升级任务 | 第 4 节、8 |
| F15 | 反对与到期竞态 | 截止前/恰好截止/截止后但周期未跑/旧 generation/错误成员/跨团队六种情况，恰好一个结论落地 | 第 4 节、3、8 |
| F16 | 步骤之间注入 | 工具调用间隙到达的消息在下一条请求边界可见（需 adapter 探针证实） | 2、8 |
| F17 | 模型不传版本 | 同一接收方后到者得"结论已定"；不同接收方可分别成功，竞争最终决策；重发返回原收据 | 第 4 节、3 |
| F18 | 意图门禁与多接收方 | 旧 intent 不适用于新修订；三态门禁；任一 object 即整体 objected，全部 ok 才提前 passed；未回复者到期不影响；反对与 produce 并发 | 第 4 节、3 |
| F19 | 关窗后可见性 | 四类线性化：截止前已见计入；迟到证明只审计；截止后请求计事后补看；旧绑定无效 | 第 4 节、8 |
| F20 | 端口悬挂与容量 | 时钟与清扫不受影响；容量允许时其它效果有进展；全部槽位悬挂时背压并报饱和；stop 在预算内返回 | 2、6、9 |
| F21 | 双消费与精确取消 | 意图只执行一次；旧 attempt 的 cancel 不落在新执行上 | 6 |
| F22 | 收据丢失后重发 | 同 operationId 同业务请求返回原收据；不同业务请求明确冲突 | 3、第 2.4 节 |
| F23 | stop 与启动并发 | starting/recovering 中 stop 收敛到 stopped；日志读取悬挂时仍在预算内返回；超时重启取新 epoch；旧回执只留审计 | 9、1 |
| F24 | unknown 分层 | 普通 attempt unknown 只占自身冲突资源、不冻结无关成员；effect unknown 只限相关动作；只有 completion 未决才关团队准入 | 5、7 |

---

## 4. 协作意图：沉默即同意（2026-10-28 用户确认）

### 4.1 为什么要改

最近一次真实实验：13 条 intent 没有一条被确认，实时打断计数为 0，其中几条 intent 到运行结束都没有进入接收方的请求上下文。今天"发出 intent → 等对方接责 → 才能继续"的协议在实践中退化成了"发出去、没人接、双方都停"。

但审查指出一个更要紧的事实：今天的门禁根本不等确认，它只判断"这个成员历史上发过至少一条 intent"（collab.mjs:102-126 的 sent > 0，tools.mjs:53-70 的拒绝文案）。所以它既没有绑定任务，也没有绑定接口修订，旧 intent 能一直给新工作开门。这次修订把门禁改成有约束的合同：反对有对象、通过有依据、结论不可变。

### 4.2 规则

1. **intent 绑定对象**：一条 intent 绑定 (taskId, contractRevision)（或接口修订号）与接收方集合。没有绑定对象的 intent 不能开任何门。
2. **窗口**：从提交时刻起算，长度由服务端按团队配置计算（3(a) 已定），不由模型传任意 deadline。
3. **三态门禁**：
   - open（窗口内）：允许做准备（读、取上下文、准备工作区），**不允许发布受该 intent 约束的 produce**。
   - passed：允许发布。
   - objected：阻断该修订的发布。改方案要发**新 intent（新修订号）**；旧结论不可变。撤回同时撤销对应的待发布工作，不能成为绕过门禁的方式。
4. **多接收方分开记账，结论按集合算**：
   - 每个接收方的回复（ok / object / 未回复）、generation/bindingGeneration、可见性各自记录，互不覆盖。
   - 任一合法接收方在窗口内 object → 整条 intent **立刻 objected**，不等其他人。
   - 全部接收方都 ok → 可以提前 passed。
   - 否则等到期：到期时没有任何反对 → passed。
   - 一个接收方的 ok 不能剥夺另一个接收方的反对权；竞争的是**最终决策**，不是"所有回复只能成功一次"。
5. **门禁与 produce 在同一个事务里检查**，覆盖所有公开入口（模型工具、UI 命令、API），不是"入口前先查一次"。
6. **不升级 operator**：窗口到期无反对即通过，发起方的下游动作不被阻塞。
7. **通过带逐接收方的可见性结论**：每个接收方是否进入过请求上下文分别记（4.4），不给一个布尔值掩盖"部分看到"。
8. **关窗即冻结**：decision、closedAt、逐接收方的 seenAtClose、visibilityEvidenceAtClose 一起落库；之后再看到的可见性只进 visibilityAfterClose，不改决策与统计（不变式 8 规定 6）。
9. 沉默即同意只适用于 intent。其它需要接责的消息维持"先可见才能接责"（用户已确认），到期未接责升级为 escalated（index.mjs:233-239 的现有行为）。

### 4.3 接口（reducer 侧只定义形状，实现细节不在这里展开）

发送：

    team_message { op: "send", kind: "intent", to: [...], summary, expectedOutcome, taskRef, contractRevision }

- 不再要求模型给 deadline：窗口长度由服务端按团队配置计算，模型传了也不作为权威（发送参数简化是方案 13 的要求）。

新增回复：

    reply { messageId, verdict: "ok" | "object", reason? }

权限与边界：
- 只有这条消息的**合法接收方**能回复：recipient 匹配 (teamId, memberId, generation)、bindingGeneration 匹配；reply 事务内同时校验消息状态、截止时间、接收方与有效绑定。ok 也一样，不允许任何第三方代答。
- 时间边界：now < closesAt 才接受回复；now >= closesAt 一律按到期规则处理，即使周期还没跑（迟到回复只审计，不改结论）。
- 模型不传版本号：服务端在提交时读当前版本；重复或过期回复返回"结论已定"，不要求模型重读。
- 并发：**不同接收方可以分别成功回复**，各自记一票；同一接收方的后一次回复在关窗前覆盖前一次，关窗后只审计，不改结论。

状态：

    stored → open(window) → passed      // 到期无人反对，或全部接收方 ok
    stored → open(window) → objected    // 任一合法接收方 object

- 投票逐接收方持久化（vote、generation、bindingGeneration、可见性），关窗时按 4.2 规定 4 汇总成 decision。
- passed 与 objected 都是终态，且不可变：同一 (taskId, contractRevision) 上的结论不能被后来的 intent 覆盖，只能由新修订的新 intent 产生新结论。
- unseen 不是状态，是 passed 上的逐接收方事实：关窗时某接收方没有请求上下文证据就记它 unseen；汇总单独给"全部看到 / 部分看到 / 都没看到"。

### 4.4 关窗时冻结的事实

关窗提交（到期或 reply）在同一事务里写：

| 字段 | 含义 |
|---|---|
| decision | passed 或 objected（按 4.2 规定 4 的集合规则汇总） |
| closedAt | 关窗时刻：到期时刻，或导致提前关窗的那次 object，或最后一次 ok |
| votes | 逐接收方：vote（ok / object / 未回复）、generation、bindingGeneration、提交时刻 |
| seenAtClose | **逐接收方**：关窗那一刻该接收方是否有请求上下文证据 |
| visibilityEvidenceAtClose | 逐接收方的证据引用（requestId、manifestHash、sessionSeq、generation） |
| visibilityAfterClose | 关窗之后才出现的可见性事实（只增，不改决策） |
| seenSummary | 汇总：全部看到 / 部分看到 / 都没看到（由 seenAtClose 计算） |

判定口径分成四类，不能混成一个指标：
1. 请求发生在 closedAt 之前，且证据在**关窗事务之前**提交 → 计入 seenAtClose。这是"截止时已见"的唯一来源。
2. 请求发生在 closedAt 之前，证据在**关窗之后**才落库 → 迟到证据：只审计，不追认，不计 seenAtClose；单独计数"迟到证据"。
3. 请求发生在 closedAt 之后 → 记入 visibilityAfterClose，计"事后补看"，与迟到证据分开统计。
4. 旧 binding / generation 的证据 → 无效：拒绝写入，或只记"无效证据"审计，既不计已见，也不计事后补看。

统计口径一律用 seenAtClose，不查询"当前 visible"（那样会被事后看见改写历史）。

### 4.5 截止时间处理

| 对象 | 今天的处理 | 新规定 |
|---|---|---|
| 租约（attempt.expiresAt） | 过期 → unknown，并产生 cancel 效果（index.mjs:226-232） | 不变（不变式 4、5） |
| 生命周期意图 | 超时 → unknown，交 operator（lifecycle-driver.mjs:29-46） | 不变 |
| intent 的反对窗口 | 与线程/消息同一条分支，到期升级为 escalated | 任一接收方窗口内 object → objected（立刻）；全部 ok → passed（提前）；到期无反对 → passed（带逐接收方 seenAtClose）。**不升级 operator** |
| reply 的边界 | 无（新接口） | now < closesAt 接受；now >= closesAt 走到期规则；不依赖周期是否已跑 |
| 其它消息（action 等） | 到期 → escalated，responsible=operator | 不变；接责仍要求先可见（用户已确认） |
| 线程 | 到期 → escalated | 不变 |
| wait 边 | 到期 → timed-out | 不变 |

规定：
1. 时钟只有一个：窗口到期由周期推进，不是每条 intent 一个裁决定时器；定时器只负责叫醒周期。
2. 到期提交在同一事务里：读状态与证据、只在仍 open 时推进、写 decision/closedAt/seenAtClose/证据引用。
3. 到期与 reply 的竞争由这个事务裁决，只有一个赢；输的一方得到"结论已定"。
4. 证据引用不落库的"未确认看见"不可复核，视为缺陷。
5. status() 给出 passed、passedUnseen、objected，以及 seenAll / seenPartial / seenNone 三个汇总计数（全部按逐接收方的 seenAtClose 统计）。

### 4.6 宿主在这条协议里负责什么

1. **开窗与关窗**：发送 intent 的那次提交打开窗口并记录开启时刻；关窗由 reply 或周期里的到期提交完成，都走命令网关。
2. **判定是否看到**：到期时读可见性证据，不猜、不因为对方在线或曾经注入过就当作看过。
3. **步骤之间注入消息**（不变式 2、8）：触发点是每次工具调用结束、下一条请求开始前，以及每轮开始前；按会话串行；注入后必须有请求边界确认，注入但请求没发出不算已见。该触发点是否存在需 adapter 探针证实。
4. **不重复裁决**：结论写入即终态；投影过期、会话重连、进程重启都不重算；恢复只读结论。
5. **通知**：结论变化后通知发起方（走 wake 效果）；通知失败按第 5 节规则处理，不影响结论。
6. **门禁在事务内**：宿主只负责把 produce 请求翻译成命令，门禁检查必须与 produce 同提交（4.2 规定 4）。

### 4.7 需要的故障测试

- F14 窗口到期但没人看到：接收方从未把 intent 带进请求上下文 → passed + 未确认看见，计数增加，发起方被通知，operator 不收升级任务。
- F15 反对与到期竞态：六种情况——截止前 reply、恰好截止、截止后但周期未跑、旧 generation、错误成员、跨团队回复 → 恰好一个结论落地；非法回复只审计。
- F16 步骤之间注入（需 adapter 探针证实）：一轮 3 次工具调用，intent 在第 1 次后到达 → 第 2 次后的请求边界可见。
- F17 模型不传版本：同一接收方的并发 reply 由服务端裁决，后到者得"结论已定"；**不同接收方可以分别成功回复**，竞争的是最终决策；收据丢失后重发返回原收据（F22）。
- F18 意图门禁与多接收方：旧 intent 不覆盖新修订；open 时 produce 被拒、passed 放行、objected 阻断；任一接收方 object 即整体 objected，全部 ok 才提前 passed；未回复的接收方在到期时不影响结论；非绑定接收方的回复被拒；反对与 produce 并发时 produce 不越门。
- F19 关窗后可见性（按 4.4 四类线性化）：(1) 截止前有效证据先于关窗事务提交 → 该接收方计入 seenAtClose；(2) 截止前请求、截止后才收到证明 → 只计"迟到证据"，不追认；(3) 截止后首次请求 → 计"事后补看"，独立指标；(4) 旧 binding/generation 证据 → 无效，不计已见也不计补看。

---

## 5. effect 协议

### 5.1 现状（只用于解释迁移，不是可实现的协议）

| kind | 载荷 | 产生点 | 今天的消费者 |
|---|---|---|---|
| start | { attemptId, owner, fence } | 调度准入（index.mjs:88） | 无（产品没有 start 端口） |
| message | { messageId } | 发送消息（index.mjs:121）、工具发送（tool-reducer.mjs:28、94） | 无（唤醒靠 core.notifyDelivery 在提交后直接做，index.mjs:124-127、tools.mjs:108-113） |
| cancel | { attemptId }（index.mjs:230）与 { attemptId, owner }（runtime.mjs:10-11） | 时钟降级、启动恢复 | 名义上是原生 cancel 端口（profiles/runtime.mjs:43-48），但它读 options.memberId → 取到 undefined → TypeError 被吞成 unknown |
| member-lifecycle | { intentRef }（tool-reducer.mjs:180）与 { memberId, generation, desired }（organization.mjs:20） | team_member 工具、organization.lifecycle | 无。真正被消费的是 member-intent 行（lifecycle-driver.mjs:4-20），它不读 outbox |
| native create/resume/cancel/dispose | { kind: 操作名, memberId, generation, options }（native.mjs:14） | applyLifecycle 内部 | applyLifecycle 自己 claim 并调用端口（native.mjs:18-46），不经 applyEffect |

现状的问题（也是目标表要逐项消除的）：同一 kind 两种载荷；cancel 与 native cancel 同名不同义；生命周期有扫描器与 outbox 两条路径；attempt cancel 只能按成员查"当前句柄"，取消可能落在新的执行上；没有任何"结果原子收口"的保证。

### 5.2 目标（M1b 的实现依据，逐项定死）

| kind | 唯一载荷 | 产生点 | 唯一消费者 | 原子收口 | 重试与终态 |
|---|---|---|---|---|---|
| start | { attemptId, memberId, generation, fence } | 调度准入 | 执行启动端口，按 attemptId 精确启动 | claim(epoch,fence) → 端口 → 同一提交：settle + attempt 启动标记 + 开始续租 | executed/notExecuted；不明 unknown；启动失败不续租 |
| cancel | { attemptId, memberId, generation, reason } | 时钟降级、恢复、确认停止 | 原生取消端口，按 attemptId 解析**精确执行绑定**（不是"该成员当前句柄"） | 同一提交：settle + 经统一释放命令置 attempt revoked（仅在有明确停止证据时）+ 取消等待边；generation 不变 | 只有 notExecuted；无停止证据 unknown，资源不释放 |
| wake | { messageId, recipient, generation } | team.wake 命令（含 intent 的逐收件人唤醒） | 唤醒/投递端口：经统一的执行绑定校验后投递；与 message 共用 wake-receipt 幂等键；唤醒结果（woke / 活回合内合并 / 驱动拒绝 / 驱动抛错）一路传回端口 | settle 只收口 effect 行；只有实际开回合或证明合并目标仍在时才写收据 | 绑定失效或驱动拒绝 → notExecuted（不写收据，结果留在消息行）；驱动抛错 → unknown（不写收据）；maintenance → deferred（延后：不写收据、不花 try，nextDue 按 1s 起、10s 封顶退避）；其它非执行 phase → notExecuted（没有合并目标，不写收据） |
| message | { messageId } | 直接消息提交（message.send 的 reducer） | 投递通知端口：与 wake 同一条邮箱边、同一个幂等键；只在该收件人的执行仍有效时开一次回合 | settle 只收口 effect 行；回执说明是否唤醒 | 唤醒成功/合法合并 → executed 并写收据；驱动拒绝 → notExecuted；驱动抛错 → unknown；maintenance → deferred（延后，不写收据、不花 try）；其它非执行 phase → notExecuted（没有合并目标，不写收据）；**没有任何有效执行**才以 delivered:false 收口（消息行是投递，调度器 mailbox 任务是兜底）。三者都不落成 missing adapter port |
| dispatch | { attemptId, recipient, generation, fence } | start 成功收口（effects/protocol.mjs start 分支，同一事务） | 首次派发端口：校验该 attempt 的执行绑定后，由唯一的唤醒消费者开 idle 边缘；与 mailbox 共用 **attempt-dispatch:<attemptId>** 这一 attempt 级"首次派发"持久记录 | settle 只收口 effect 行（attempt 行已由 start 收口写入） | 已记录派发（含 mailbox 先到）→ executed 且不再开回合；绑定失效/驱动拒绝 → notExecuted（retryable，可观察）；驱动抛错 → unknown；处于 maintenance → deferred（延后，不写派发事实、不花 try）；其它非执行 phase → notExecuted（不写派发事实）。拒绝与失败都不写成功收据 |
| intent-result | { messageId, decision, seenAtClose, initiator }（initiator 由开窗事务写入，含 kind/memberId/attemptId/generation/fence） | 关窗提交：**只复制**开窗时保存的绑定，不重新推断 | 通知发起方端口：按开窗记录的 attempt/generation/fence 校验当前执行；owner 由成员行的 root 角色识别（产品 owner 工具即 member:root），走 owner 路径，结果行即投递 | settle 只收口 effect 行；决策由关窗事务写 | 执行已释放、换代或租约失效 → notExecuted（结果留在日志等待合法消费，绝不唤醒 handles 里碰巧存在的代理或替换后的新执行）；驱动抛错 → unknown |
| lifecycle | { intentRef, memberId, generation, operation } | 生命周期意图提交 | 原生生命周期端口（create/resume/cancel/dispose 都是它的 operation） | 按三态收口（见不变式 6 规定 5）：executed → settle + member-intent=confirmed + generation+1 + 撤销旧执行 + 会话映射换代；notExecuted → retryable + 意图待派发，不变代；unknown → effect 与意图同事务转 unknown，保持占用 | 同 intentRef 只执行一次；有未对账遗留时拒绝新意图 |

目标表的配套规则（必须一起实现，缺一项即视为没达成）：
1. **生命周期权威唯一**：member-intent 行是意图的唯一权威；扫描器只负责把未派发的意图变成一条 lifecycle effect（一次），执行只由该 effect 的消费者做。organization.lifecycle（organization.mjs:15-23）要么改成写意图行，要么删除，不能继续写第二种形状的 outbox。
2. **create 与 start 的先后**：start 只在成员已完成 create（observed 为 running）后派发；两者都以实体 id 去重，重复派发是幂等空转，不是第二次执行。
3. **cancel 解析精确绑定**：执行绑定按 attemptId（以及 generation）登记，取消落在发起时那条绑定上；成员换了执行也不能取消错对象。
4. **收口只有一个写者**：epoch + claim fence 都相符的消费者；其他回执只写审计（不变式 3 规定 3）。
5. **kind 空间封闭**：新增 kind 必须同时更新本表与端口契约，不允许"按 kind 名找端口"的隐式扩展（effects.mjs:15 的写法要求端口存在，否则 MISSING_ADAPTER_PORT）。
6. **释放只有一个领域命令**：cancel 与 lifecycle 的撤销、租约回收、冲突占用释放都经它；证据来自端口回执或 operator 裁决，写路径相同（不变式 5 规定 3、不变式 6 规定 4）。
7. **成功换代要更新会话映射**：executed 的生命周期操作在同一事务里把 executionSessionId 的映射从旧 generation 切到新 generation；旧 generation 的会话随后的事件按失效处理。

### 5.3 F1 新消费者补充合同

- delivery：载荷固定为 deliveryId、taskId、deliveryRevision、target；生产 reconcile 只读端口返回 transition 证据，不获得写端口。effect claim 的 epoch/fence/owner 与 Delivery/task 最初 revision 同时登记；managed settle 在一个事务中校验当前 target/revision、完成栅栏，再执行有限 delivery.transition 和 effect 收口。停止后的已登记读回仅在排空预算内提交；不得开放通用 managed business dispatch。已有待消费 delivery effect 的 applying 行由消费者负责，冷恢复不得再竞争收口。
- gc：宿主时钟提交 gc effect，消费者使用同一团队 ArtifactStore 的真实 gc；执行失败转 unknown 并由 status 报告，不能用空成功端口代替。冻结期间仍属于普通 lifecycle，不获得安全取消豁免。
- dispatch（R5-2）：start 只准备执行，派发是它自己的一条持久事实，与 attempt 绑定、id 稳定（dispatch:<attemptId>）。派生在 start 收口的事务里完成，执行只在受控唤醒消费者里发生；start 回执里直接调用 wakeDriver 会变成第二个派发者，因此禁止。首次派发与邮箱唤醒共用同一个 idle 边缘：先到者开回合，后到者在运行中的回合里最多抢占一次（或判定 alreadyLive），不会开出第二个回合。
- message（R5-2）：普通消息 effect 必须有明确消费者，不允许落到 missing adapter port。合同是"投递通知"：消息行才是责任的载体，端口回执只说明是否唤醒了收件人的当前执行；收件人没有有效执行、或消息 generation 已过期时以 delivered:false 收口，绝不转 unknown。
- intent-result（R5-3，R6-1 收紧）：结果属于**开窗时**的那次执行。sendIntent 在开窗事务里保存可信的发起方绑定——执行路径存 attemptId/generation/fence，owner 路径按发送者自己的成员行 role=root 判定（产品 owner 工具以 member:root 行动，不能用字面量 'root' 或模型自报类型）——并写进 intent 行；closeIntent 只复制该绑定，绝不在关窗时查"现在是谁在跑"。消费者据此校验当前执行（generation、attempt、fence、epoch、租约），owner 走独立路径并以正常回执收口（F1 不主动唤醒 owner 会话，但不得进死信）。发起者被取消、释放或换代时回 notExecuted：结果留在持久日志等待合法消费，不得去唤醒 handles 里碰巧存在的代理，也不得唤醒替换后没有开过该意图的新执行。
- 共同首次派发事实（R6-2）：dispatch 与 mailbox 是同一个事实（"该 attempt 的第一次回合已经发生"）的两个生产者，共用 attempt-dispatch:<attemptId> 持久记录。mailbox 先开回合（woke/抢占/合并）时也会写这条记录，因此延迟到回合结束后的 dispatch 只是合法合并，不会再开第二个回合；后续新消息不受该记录约束，仍按各自输入身份抢占或唤醒。三种结果必须分开：已证明派发过或合法合并 → executed；确定未执行（绑定失效、驱动拒绝）→ notExecuted（retryable，可观察）；执行结果不明（驱动抛错等）→ unknown。任何"拒绝/未绑定"都不得写成功收据、不得 confirmed；intent-result 的回执同理。
- mailbox 的诚实三态（R7-1）：唤醒的拒绝与异常不再被折叠成"已合并"。wakeMember/onMail 把 openTurn 的结果一路传回（受控消费者返回 woke/refused/error/unavailable），端口据此给出 executed / notExecuted / unknown；只有实际开回合、或能证明合并目标仍是活回合时才写 wake-receipt 与 attempt-dispatch。拒绝按有界重试（tries<5）留在队列里，异常转 unknown 交 operator。
- 合并窗口绑定活回合（R7-2）：coalesce 只作用于仍然存在的 turn/step（依据 agent 的活 phase），不是依据时间。成员已经 idle 时不再判 coalesced，而是重新走合法的 idle 边缘（唤醒）；这样窗口内到达的新消息不会被确认成"已合并"却永远没人派发。同一活回合内的多次通知仍然只买一次请求。
- 非执行状态没有合并目标（R8-1/R8-2）：上游原生 Agent 的 phase 只有三种取值（dsh-agent-loop/lib/index.js:547-556、586-609）——idle；running（确有活回合在执行）；maintenance（压缩等后台作业持有 agent：没有 turn，结束后自行回到 idle，不会因为团队库里有消息就开回合，且 preemptStep 对它恒 false）。所以"不是 idle"不等于"有活回合"：只有 running 才能在后续边界消费（抢占或合法合并），只有 idle 才能走 idle 边缘唤醒；maintenance 及其它非执行 phase 一律返回 notExecuting，端口记 notExecuted（有界重试 tries<5），既不写 wake-receipt，也不写 attempt-dispatch；dispatch 与 intent-result 的 idle 边缘同样拒绝确认。维护结束后 phase 回到 idle，正是那次重试开回合并写收据——消息被派发且只派发一次。
- 维护等待是调度延后，不是执行失败（R9-1/R9-2）：上游 maintenance 会自行结束并把 agent 交回 idle（dsh-agent-loop/lib/index.js:586-609），所以维护期间不执行任何唤醒，只排下一次。runner 在 claim **之前**问一次（宿主驱动的 deferrable 钩子 → PreemptWatcher.maintenance），确认该成员的 agent 处于 maintenance 就直接持久化 nextDue；若 claim 之后才发现（期间进入维护），受保护收口同样记 deferred：status 回到 retryable、只退回本次 claim 花掉的那一次 tries（fence 单调、tries 绝不清零）、按 1s 起、每轮翻倍、10s 封顶退避。deferred 是证据归一化（executed / notExecuted / deferred / unknown）和持久收口合同里的独立状态，不得落到 unknown；不写 wake-receipt、不写 attempt-dispatch。message、wake、dispatch、intent-result 四个唤醒端口同一处理。只有 maintenance 可以延后：驱动明确拒绝仍是 notExecuted（tries<5，第五次进 dead-letter），抛错仍是 unknown。维护结束后由产品周期自己的 pump 完成那一次派发；等待期间 stop、完成冻结、换代都会让重试重新走租约、generation、epoch、所有权、停止与冻结检查，不会越权唤醒。
- 延后写口同样受完成栅栏约束（R10-1）：claim 之前的 defer 与普通 claim 共用同一个未决 completion 检查（core-access 的 assertNoPendingCompletion，二者各调用一次，不复制规则）。存在 prepared/authorized/unknown completion 时抛 COMPLETION_FROZEN，不调用 store.defer()——冻结期间 effect 的 defers、nextDue、tries、fence 与对应账本行一字不动，拒绝本身进 runner 审计；解冻后同一条 effect 恢复延后或正常派发。lifecycle 与 ownership 检查保留，safety/recovery 权限不因此扩大。deferred 收口仍按当前 fence 校验（同一 fence 不能重复退回 tries）。可观测性：runner.status().deferrals（profile capability 的 effects.deferrals 同源）给出 alertAfterMs（配置 deferAlertMs，默认 30000ms）、waiting、totalDefers、earliestDeferredSince、alerting，以及每条等待的 { effectId, kind, memberId, status, defers, deferredSince, waitingMs, nextDue, alerting }；长期等待只是被观测与告警，不设硬上限、不自动死信。
- 执行闸复用租约规则（R6-3）：端口不再自行拼一套租约判断，统一调用 TeamCore.authority（commands/lease.mjs 的 leaseOf），用宿主可信时钟判断 expiresAt > now、fence、成员 desired=active、generation 一致；在其上再叠加 router 路由、teamId/memberId、epoch 与 executionSessionId、目标 attempt 的比对。行状态仍是 active/running 但租约已过期或成员已被置为非 active 时，dispatch 与 intent-result 都不得触达原生唤醒。
- 冷启动 owner 日志（R5-1）：registry 已有 owner 时，不得用 sessions.create(existingId, {}) 造一个空 Session 充当恢复——openSessionLog 会把它当成"完整且为空"的日志，从而把持久日志里真实的完成事实误判成不存在。只有本次新铸造的 owner id 才能建空会话；已有 owner 要么本来就在 live sessions 里，要么保持未加载，由 openSessionLog 读持久日志；读不到就保持 unknown、准入关闭。
- 只读工具类别（R5-5）：team_read 这类只读查询走独立的 read 类别（要求 running、持有所有权、未被撤权，但不要求业务准入），冻结或待裁决期间仍允许经授权的查询；不得把查询提升为 operator 写类别。

### 5.3 历史补充事实（F1 以前）

- 今天没有任何 goal、delivery、gc 类的 effect。交付链是同步调用（delivery/index.mjs:34-116）；artifact gc 据审计从未被构造，本次未亲自复核，标"未证实"。
- applyEffect 从未产出 notExecuted（effects.mjs:19-25），所以 retryable 正常路径不可达（store/index.mjs:138）。
- 旧 attempt 的 cancel 到达时成员已绑定新执行，是目标表必须覆盖的故障（F21），不是边缘情况。

---

## 6. engine.mjs 职责迁移对照（已完成，正文已移出）

`packages/profiles/engine.mjs` 已删除：M1b 把驱动所有权切到 `packages/host`，测试框架不再替产品驱动。
原来的 19 行对照表，以及“real harness 改成产品驱动之后还剩什么”的清单，是一条已经走完的迁移路线，不再属于协议正文，
见 内部归档文档。

## 7. 问题状态

### 7.1 已定（2026-10-28）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 每团队一个库还是合库 | **每团队一个库。**另设最小的持久团队注册与会话映射设施；团队目录用服务端生成的安全标识并规范化，不拼接任意输入；暂不做跨团队写事务。 |
| 2 | 成员 ID 是否带团队前缀 | **库内可以继续用 member:root，对外一律复合身份。**这不等于共享组长：记录、认证绑定、生命周期必须独立；teamId 由已认证的宿主句柄封装，不要求每个内部函数机械加参数，但不得存在隐式默认团队。 |
| 3(a) | 默认窗口 | **5 分钟作为可配置初值，不是已验证的合理值**；deadline 由服务端按团队配置计算并限定范围；不再让模型提供任意截止时间（发送参数简化是方案 13 的要求）。 |
| 3(b) | 反对是否阻断 produce | **阻断受该 intent 约束的发布，不冻结整个团队**；按任务/合同修订关联；明确 open、passed、objected 三态门禁，不再依赖"曾发过任意 intent"。 |
| 3(c) | 非 intent 消息接责是否要求先可见 | **要求。用户已确认。**两条旧 accept 路径都不检查 visible（index.mjs:133-139、tool-reducer.mjs:97-105），因此这是明确的行为变更，要与证据绑定（接收方 generation）一起在共享 reducer 落实。 |
| 4 | 独占还是 epoch 接管 | **M1b 采用本机独占，不支持活进程间自动抢占**；同时保留持久 epoch 拒绝旧回执——epoch 不是独占的替代品。 |
| 5 | Delivery / gc 是否进 M1b | **按方案 13 第 90 行保留真实接线**：不要求扩大领域语义，但触发、执行、失败观察与必要恢复必须闭环；不能只挂空定时点或标"未接入"。若要延期，先改上位方案与验收范围，不能由本规格自行缩减。 |
| 6 | 真实请求载荷从哪里取 | **先做 adapter 探针，再锁定接口**：要证明工具间隙触发、注入与压缩顺序、最终实际发送内容、请求身份关联；只有 requestId 与 sessionSeq 不足以证明某条消息在请求里。缺能力时显式报告能力缺失，不能长期以"不写 visible"冒充完成接线。 |

### 7.2 已定（2026-10-28）

1. **Delivery 与 gc 在 M1b 里真实接线闭环**：触发、执行、失败观察、必要恢复都要闭环，不扩大其领域语义；验收把"接线闭环"与"领域语义扩展"分开写。
2. **发送参数简化与 M2 的共享 reducer 一起改**：team_message 的 intent 分支不再接受模型给的 deadline，工具 schema 与角色文案同一次提交改完，不出现两套发送形状。
3. **迟到的可见证据只审计、不追认截止时的统计**：另开"事后补看"指标（4.4 判定口径第 2、3 类分开计），decision 与 seenAtClose 一律不变。

### 7.3 仍需用户决定

本版没有。7.1 与 7.2覆盖了此前的全部待决项；新出现的问题按同样方式补进本节，不在正文里留下两种答案。

---

## 8. super-agent 借鉴协议：P0 合同（2026-11-01，默认 off）

本节是**当前实现状态与合同**，不是新语义的激活。依据：`内部设计记录` §2、§10 P0、§11。
P0（协议与基线探针）只发布合同与探针；订阅直通、root 角色守卫、批处理、人的名额（P1–P5）都未接线，本文 §4（M2b）
在 off 下仍是规范。

### 8.1 开关与校验入口

| 键 | 取值 | 默认 | 含义 |
|---|---|---|---|
| `superagentBorrow` | `'off'` \| `'v1'` | `'off'` | 一个协议版本，不是四个可自由组合的布尔开关 |
| `ownerModel` | `null` \| `{ provider, model }` | `null` | 部署选择；null 表示保留宿主当前选择 |
| `intentSemantics` | `'undecided'` \| `'root-decision-v1'` \| `'silence-pass-m2b'` | `'undecided'` | §12 已记录代选 `root-decision-v1`（用户可改回）；默认仅指部署未记录选择 |

- 合同：`packages/contracts/superagent-borrow.mjs`（`superagentBorrowConfig()`），schema：`packages/contracts/superagent-borrow.schema.json`。
  未知键、越界值一律 `INVALID_CONFIG`，结果冻结。
- 生成/装载：`packages/profiles/index.mjs` 在写 profile 前校验，`packages/profiles/team-plugin.mjs` 在挂载前再校验一次。
  **未命名任何键时不写入任何字段**，生成的 profile 与 HEAD 逐字节一致（§2 第一条）。
- 支持 v1 的构建须先满足 `team=true`、`guard=true`、`goalCheck=true`、`autonomy=on`、`collab=on`，并显式记录
  `intentSemantics:'root-decision-v1'`；P0 的 unsupported 拒绝优先于能力前置（非法配置值仍为 `INVALID_CONFIG`）。
- 本构建**没有 v1 消费者**：命名 `v1` 或显式 `ownerModel` 一律 `PROTOCOL_UNSUPPORTED`（fail closed），
  不把 off 的行为挂在新名字下运行。必须全部 P1–P5 消费者及能力验收就绪才可将 v1 标为 implemented，不能因第一个包落地激活。

### 8.2 off 黄金基线（逐字段）

- **工具目录**：`teamSchemasForBorrow('off', collab, autonomy)` 直接返回 `teamSchemasFor(collab, autonomy)` 的结果；
  默认位是同一对象（身份相等），其余位置内容相等。`teamSchemasForBorrow('v1')` 抛 `PROTOCOL_UNSUPPORTED`。
- **profile**：模块顺序、executor 选择（team 取 candidate preempt executor）、`instantInterrupt: true`、whitelist、
  `capabilityHash` 全部不变。
- **合同默认值**：`collabConfig()`、`autonomyConfig()` 不变；`codes` 只增（新增 8 个协议拒绝码，无一重复）。
- **存储**：off 不写 `team-policy:` 行，因此纯 off 旧库升级不需要迁移。
- **证据**：`verification/superagent-borrow-p0.test.mjs` 对 `5325aeb` 取 `git archive`，与工作树跑同一场景
  （`verification/superagent-borrow-off-scenario.mjs`）：未配置与显式 off 都对照 HEAD，在 autonomy/collab 四个组合比较
  profile / 工具面 / 合同 / 快照全文与 manifest / 工具结果 / 事件日志 / 行集合，并运行真实 plugin 入口（测试上下文）。
  子进程固定时钟和随机源，仅归一化工作目录路径，不抹除时间、引用关系或 hash。显式 off 仅剔除已断言值正确的新增配置三字段。
  变异验证在临时 HEAD 树将 `instantInterrupt:true` 改为 false，同一 golden 比较器必须报 generated profile 差异；不修改工作树做变异。
  这是固定离线场景的等价证据，不是任意工作负载/真实宿主行为的穷尽证明。

### 8.3 team-policy 与启动核对

行：`team-policy:<teamId> = { version: 1, superagentBorrow, activatedAt, migrationRef }`（`teamPolicyRow()`）。

- 读：`team-plugin.mjs` 在创建 core、开准入之前读该行；没有行 = `fresh`（不构成变更），有行且与配置不符 = `POLICY_MISMATCH`，
  进程不启动。版本不认识、协议值非法、未知业务字段、缺失/非法 activatedAt 或 migrationRef 同样是
  `POLICY_MISMATCH`（存储实体的通用封装字段除外）。无行不是空库/排空证明，旧库激活仍要迁移证据。
  拒绝路径关闭 store、释放 ownership/manager；store 构造失败也释放宿主资源，某步清理失败不跳过后续清理、不覆盖原拒绝码。
- 写：**P0 不写**。激活要求完整协议消费者及验收，不属于第一个消费者自行翻转；纯 off 库不自动增加该行。
  policy v1 固定 root-decision 语义，不承载可热切换 intent 变体；改回其他语义须先修订协议与迁移合同。
- 反向：off 构建打开有 v1 policy 的库被拒绝（`verification/superagent-borrow-p0.test.mjs` 有对应用例）。
- 不得热切换：配置与存储不符不按请求自选协议，只能走静止迁移。

### 8.4 迁移前置

`MIGRATION_PREREQUISITES` 逐条：`admission-stopped`、`executions-drained`（无 active/unknown attempt）、
`effects-settled`（无 applying/unknown effect）、`intent-windows-closed`、`objections-decided`、
`migration-summary-saved`、`host-stopped`。

- `migrationCheck(observation)` 要求每个字段都有观测值：缺字段是 `INVALID_CONFIG`，不是"当作 0"。
- 不满足时 `assertMigrationReady` 抛 `MIGRATION_REQUIRED`，并列出仍未满足的条目。
- **进程重启不是排空证明**：重启不把 unknown 执行变成已完成，也不关掉任何 objection。
- P0 只提供判定合同，没有任何迁移执行者，也不改写 M2b 的 open intent / passedUnseen / waiver。

### 8.5 来源与能力合同

- 能力封闭词表：`read-local | coordinate | execute | write-local | opaque`（`TOOL_CAPABILITIES`）。
- `TOOL_CAPABILITY_DECLARATIONS` 只登记**本仓发布的 team 工具**（12 个）；native / MCP / 批调用 / executor 工具由
  注册它们的包（P2）在可信注册点声明，避免同一事实两张表。未声明（含继承属性）= `null`，按 `unknown: 'deny'` 处理。
  team 表只是能力模板，不能按字符串同名自动授权；P2 需绑定工具实例/来源，最终策略权威在 tool-guard。
- `ROOT_TOOL_POLICY`：deny `opaque`/`write-local`/`execute`，allow `read-local`/`coordinate`，unknown deny。
  P0 对 `team_task`、`team_verify` 因带 `execute` 保守整工具拒绝；按 op 细化（协调型 checkpoint 与执行型 produce 分离）
  是 P2 的 `allowedOperations` 扩展点，不得抹掉整个工具的 execute 能力，未知 op 仍拒绝。
- `toolCapabilityDecision(policy, capabilities)` 是纯函数，输入只来自可信注册；拒绝原因分
  `UNDECLARED_TOOL` / `UNKNOWN_CAPABILITY` / `CAPABILITY_DENIED` / `CAPABILITY_NOT_ALLOWED`。
- 现状：HEAD 的 `tools.guard` 只有一处安装点（`packages/profiles/runtime.mjs` 的 `bindAgent`，对成员 agent），
  owner 会话不经过它——见 §8.7 探针 A。P0 未安装任何 root 守卫。

### 8.6 P0 未做的事（避免误读）

未改：`packages/profiles/runtime.mjs`、`packages/tool-guard/index.mjs`、`packages/core/**`、`packages/host/**`、
`packages/profiles/host-driver.mjs`、`effect-runner`、`patches/**`。未新增：resource Thread、v1 intent 分支、coordination
decision、输入批次、wake 收敛、N/H/C/I 名额、投影与 UI。`tools/execute` 钩子、`PreemptWatcher`、`instantInterrupt`
的组合根选择保持 HEAD。

### 8.7 §11 探针结论（P0 实测，不是设计结论）

| 未证实项（设计 §11） | P0 结论 | 证据 |
|---|---|---|
| owner 的最终工具调用、动态工具/MCP/嵌套 executor 是否都过同一个 guard | **本仓接线否定**：没有覆盖 owner 的统一角色守卫；不是 supported build 全路径零 IO 实测 | `verification/superagent-borrow-probe.test.mjs` 探针 A（profile 测试上下文）：autonomy off 时 `tools/execute` 监听器数量为 0；on 时唯一的钩子按**成员执行域**判定，无域（owner 会话）直接 `next()` 放行；全仓 `tools.guard(` 调用点只有 `runtime.mjs` 的 `bindAgent`，owner 会话从不经过 |
| 关闭 instantInterrupt 后当前 prepared build 的 wakeDriver 是否仍原子占 running | **有限证实（当前 driver idle 边沿独立于 step-abort）** | 探针 B：prepared build 的 `wakeDriver` 源码不读 `instantInterrupt`，只有 `beginPreempt` 读；动态上明确观测该构建 `instantInterrupt=false`，替换 kick 为门闩后 idle wake 同步占 running、8 次 busy wake 仅 1 次 kick；`preemptStep` 因无 armed step 返回 false。未更换 executor、未跑真实 LLM turn |
| 更换 executor 后的 wake 及工具边界 | **未证实** | P3 需对实际将用的 executor 组合另测，不从 driver 的 kick 门闩推断工具结果后的 preStep |
| 自然 preStep 是否覆盖"工具结果"边界 | **无法证实（P0）** | 离线只验证了 driver 的 idle/latch 语义；工具结果之后的下一 preStep 需要真实回合（门闩保持的真实 step）才能观测，属 P3 的 B 系列验收；P0 不据此改组合根 |
| owner 的真实 model/provider 与 host-control transport 终结能否绑定持久 control-slot | **无法证实** | 现有 `runtime.mjs` → `llm-execution.mjs` 有 owner host-control/transport 入口，但 P0 未证明请求 identity/终结事实可绑定持久 control-slot，更未覆盖未知传输与重启。不能由此推断 transport 不存在，也不能声称 H 可恢复；`ownerModel` 显式非 null 配置仍被 P0 拒绝 |
| 原生人类输入的认证/来源链是否携带稳定 operationId | **无法证实** | 本树不存在 `human-input`/`humanOriginRef` 铸造入口（P4 范围），P0 不新增、也不把普通消息当作人工来源 |
| provider 连接池/全局限流是否让额外本地名额失效 | **无法证实** | 不属 P0 范围；P4 需无收费 fake 限流测试，状态须区分 local queued 与 provider throttled（2026-11-02：§8.15 已用 fake 限流测试闭合该观察项，仍不承诺外部配额） |
| 自动 Git/PR/文件变化来源与原型收益 | **不适用** | 首包不接自动监听；本次未读原始实验日志，不填造发现率/节省/延迟结论 |

结论的使用方式：探针 B 证实"wake-only"能力可独立存在，P3 可以按设计 §5.4 先拆能力合同再切组合根；探针 A 说明
P2 必须新增真正的最终执行点，而不是把现有 `tools/execute` 当作已覆盖 owner 的守卫。

### 8.8 与 §4（M2b 沉默即同意）的关系

- `superagentBorrow: 'off'`：本文 §4 全文仍是规范，M2b 的窗口、投票、`passedUnseen` 与 waiver 一字未改。
- `v1`：S1 的共享 reducer 已按设计 §3.3 实现（见 §8.9），但整包未激活；off 下 §4 仍是唯一规范，v1 构建里 §4 的
  intent 门禁由 `assertCoordinationAllows` 替换。`内部设计记录` 同一次提交记录了这条边界，
  不保留两份相反的规范。
- §12 决定（2026-11-01，经离开模式代选、用户可改回）：采纳推荐，intent 为显式 root 裁决，取消沉默通过；
  部署设置 `intentSemantics:'root-decision-v1'`，P1 按此实现。默认 `'undecided'` 仅指部署未记录选择，仍阻塞 v1；
  `silence-pass-m2b` 可解析但不是当前 v1 支持的语义。此决定不自动激活协议，也不改变 off 的 M2b。

### 8.9 实施状态（P1–P5、集成候选、缺口 1–3）

P1–P5 与集成候选的实施流水（原文 §8.9–§8.16，约 260 行）已移出正文，见 内部归档文档。

当前状态只有一句：**`BORROW_IMPLEMENTATION.v1` 仍是 contract-only、默认 off**。缺口 2（公开入口 build × transport 恢复矩阵）与缺口 3（provider 状态分类）已闭合；缺口 1（权威证据保留/压缩）未闭合。细节以 内部设计记录 为准。

其他文档里“host-protocol §8.10 / §8.13 / §8.14 / §8.15”这类引用，指向的是本文件第三版的旧编号；退役文件保留原小标题与编号，按 §8.9–§8.16 查找即可。

## 附：本文没有覆盖的内容

- 预算与 75% 闸门（M3）。
- 投影 schema、UI 面板细节（M6）。
- delivery 的领域语义扩展（本轮只要求接线闭环）。
- 具体迁移的命令形状与错误码表（M2 的决策记录）。
