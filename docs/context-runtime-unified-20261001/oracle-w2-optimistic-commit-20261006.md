**结论：推荐你的乐观校验方案，线性化论证成立，但要补四处才完整；`host-lifecycle.js` 不需要改。** 全部结论来自读代码，未运行任何测试。

下文 `P` = `D:\dsh-test\staging\context-runtime-unified-20261001\home\profiles\web\plugins`，`GATE` = `D:\dsh-test\staging\context-runtime-unified-20261001\app\node_modules\@deepseek-ai\cordis-v15\lib\host-lifecycle.js`。

额外读了 4 个文件，外加 3 次限定在 `P` 内的符号 Grep：
- `P\team-v15-window-surface.mjs`（全文）：`validateProposal` / `safeBoundary` 的真实实现。
- `P\team-v15-window-checkpoint.mjs:1-78`：确认 `syncWindow` 强制同步，以及 `validate` 的比较方式。
- `P\team-v15-window-collector.mjs:222-261`：宿主纪元如何进入检查点。
- `P\team-v12-runtime.mjs:3655-3704`：`loadedFacts` 与 `hostContext` 的来源。

## 改变决策的发现

1. **乐观校验在提交段里已经存在。** 宿主纪元进了 `expectedCritical.host`（`P\team-v15-window-participation.mjs:37`）、`expectedCritical.loaded.host`（`P\team-v12-runtime.mjs:3666-3670`）和检查点的 `criticalRevisionVector.host` 与 `configFingerprint`（`P\team-v15-window-collector.mjs:235-240`）。它们都在 `P\team-v15-window-transition.mjs:124-133` 这个无 `await` 的同步段里被复核。
2. **现有代码在提交 CAS 冲突时不写 ABORTED。** `transition.mjs:126-127` 抛错后，`:140` 因 intent 已在日志里而保持 `paused=true`，会话读写被围住，直到有人调 `recover()`。悲观锁下这条路径几乎走不到，乐观后它成为常态路径。
3. **`recover()` 会因宿主纪元抖动而失败。** 它用 `participation.acquire(currentCritical)`（`transition.mjs:166-168`），而 `participation.mjs:56,64` 在等待控制面围栏前后各比一次含纪元的哈希。去掉租约后，无关会话的注册会让恢复抛 `WINDOW_PARTICIPANT_CAS_CONFLICT` 并保持 paused。
4. **读租约还有一个副作用：把拆除类调用推迟到释放之后**（`GATE:82-88`）。去掉后，原先被排队的拆除会立刻执行并推进纪元；如果切窗流程自身触发拆除，每次都会自我中止。未验证是否存在这种情况。
5. **只去掉租约达不到“多会话宿主默认启用”。** 已有窗口的会话每次请求都会比较含纪元的检查点；`refreshAdapter` 明确不刷新宿主变化（`surface.mjs:130-136`），随后 `validateAdapter` 拒绝本回合（`surface.mjs:159`，`checkpoint.mjs:66-73`）。这是既有行为，与租约无关；投影到适配器校验之间的间隔多长、调用方是否重试，未验证。

## 1. 是否满足 §10

满足 §10.1“CAS 与线性化点一致”，仅限宿主域。两个依据：
- 被读租约挡住的操作和会改纪元的操作是同一集合，都经过 `#begin`（`GATE:31` 抛错，`GATE:34` 加纪元）。`revoke` / `clearVeto` / `close` 也改纪元（`GATE:126-128`）；进行中的异步 writer 由 `assert` 的 `HOST_PENDING` 覆盖（`GATE:49`）。
- `transition.mjs:124-133` 之间没有 `await`，`syncWindow` 拒绝异步函数和 thenable（`checkpoint.mjs:13-18`）。

这个论证不适用于进程外状态，所以控制面围栏和文件保护必须保留（`participation.mjs:50,60-62`），与你的方案一致。`transition.mjs:7-8` 的契约注释和实施计划 §10.1 的接口证书要重新登记：config 域从“跨两次 fsync 持锁”改为“在 append 点做修订校验”。

**(a) 中止并写 ABORTED 足够**，符合 §10.2 第 6 步，但这是要新写的代码（见发现 2）。条件：
- ABORTED 与失败的校验在同一同步段内、带 writer token 追加，并且只在 `surfaceRevision` 与旧 surface 哈希未变时写（沿用 `transition.mjs:186` 的前提）。
- 落盘成功后才解除 paused；落盘失败则保持 paused，交给 `recover()`。
- 完整性类错误（`verifyIntent` / `verifyOld`）和 intent 落盘本身结果不明的情况，不走内联中止。
- 重试必须换新 `transitionId` 并重新生成 proposal（`transition.mjs:94` 已禁止复用，`surface.mjs:166` 会清空 `prepared`）。

**(b) 没有发现“已提交窗口与宿主不一致且 recover 处理不了”的情形。** 理由：
- 提交的检查点声明为历史快照、非权威（`surface.mjs:89-91`），当前权威每次请求重新采集（`surface.mjs:105-118`）。
- `recover()` 从不比较 intent 里的 `expectedCritical`，而是现取当前值（`transition.mjs:166`）；已提交分支只核对日志与磁盘（`:171-179`）。
- 因此 append 之后的宿主变更，等价于发布之后的变更。

有一个活性缺口会变得更容易触发：commit 在内存、不在磁盘、进程存活时，`transition.mjs:176-177` 直接抛 `RECOVERY_REQUIRED`，不补做落盘，会话卡到重启。原先只有 I/O 失败能触发；现在持久化后端或会话在 append 与 fsync 之间被拆除也能触发。建议在已提交分支先 `barrier.persist()` 再回读（符合 §10.3 第 3 行的 redo）。`barrier.read()` 是否隐含 flush，未验证。

**(c) 提交点的宿主复核已有三处**，都在同一同步段：
- `certificate()` 对新快照做 `assert`（`participation.mjs:43`）。
- `validate` 的源 CAS，含 `criticalRevisionVector.host`（`surface.mjs:61-68`）。
- `assertHeld` 的哈希比较（`participation.mjs:78`）。

仍需把 `participation.mjs:76` 换成 `host.assert(保存的快照, HOST_DOMAINS)`，因为哈希比较不覆盖 `instance` 身份和 `HOST_CLOSED`（`GATE:47,50`）。快照含 Symbol，不能进 `expectedCritical`（`participation.mjs:14`），要放在 `leases` 的 WeakMap 里。`acquire` 在首个 `await` 前与采集 `expectedCritical` 同段执行，纪元必然一致。

## 2. 读租约保护的其他不变量

- **拆除推迟**（发现 4）：提交前的拆除会被纪元检出并中止；append 之后的拆除不被任何 CAS 检出，后果见 1(b) 的活性缺口。
- **recover 路径**（发现 3）：它的两个分支都不依赖宿主状态，恢复模式下应把宿主纪元排除出 CAS，只保留控制面围栏。
- **`safeBoundary` 与 maintenance**：不受影响。`live()` 和 `boundary()` 在提交段内由 `validate` 重新执行（`surface.mjs:29-41`）；Team 运行时被重载会翻转 `runtimeDisposed`（`team-v12-runtime.mjs:3669`）而被 CAS 检出。
- **`protectFiles`**：不受影响，它挂在控制面租约上（`participation.mjs:60-62`）。
- **`gate.close()` 与 `clearVeto()`**：原先在租约期间会抛错（`GATE:127-128`），现在会成功并使切窗中止，宿主关闭不再等待进行中的提交。日志恢复能覆盖，但属行为变化；调用方如何处理，未验证。
- **未验证的一点**：`finally` 里 `participation.release` 若因控制面已被拆除而抛错，会掩盖已落盘的提交回执。调用方应以 `status()` 和日志为准。

## 3. 活锁

不是严格活锁，但会饥饿，且每次失败有成本。
- 脆弱区间是“等待控制面围栏 + 一次 intent 落盘”，期间任何会话的任何 writer 都会使本次失败。区间时长未测。
- 每次 PREPARED 之后的中止，会在日志里留下一条完整 intent（含 proposal 和全部 `originalEventRefs`，`transition.mjs:112-118`），并且 `verifyJournal` 每次都重验所有 intent（`:65-67`）。

推荐策略（数值为可配置默认值）：
- 每个安全边界只试一次，不在同一 maintenance 里循环。
- intent 之前的拒绝不计入预算，下个边界再试。这类拒绝包括 `transition.mjs:99` 遇到 pending writer、`participation.mjs:63-64` 的冲突，都没有落盘成本。
- 每个折叠需求最多 2 次落盘中止，退避 30 秒、2 分钟；用尽后记一条 `W2_DEFERRED_HOST_BUSY` 决策记录并放弃，由硬上限压缩兜底。
- 可利用已有的 `await participation.settle()`（`surface.mjs:165`）前后各取一次纪元；变了就跳过本边界。

不建议现在把纪元收窄到“相关域”：
- 六个域对会话都相关，按域拆不减少冲突。真正能减少的是按会话拆，而闸门属于根上下文（`GATE:5-10`），不知道会话。
- 全局纪元按构造是完备的；收窄出错是正确性问题，误冲突只损失活性。
- 若 shadow 数据显示中止率或发现 5 的拒绝率过高，再做第二阶段：用按纪元缓存的“会话可见配置内容指纹”替换原始纪元。涉及 `collector.mjs:235-240`、`team-v12-runtime.mjs:3666-3670`、`participation.mjs:11-17`。

## 4. 保留读租约

不适用。构造类入口是同步返回值的（`GATE:75,137`），无法改成等待而不改所有调用方签名。

## 5. 最小改动与测试

改动位置：
- `P\team-v15-window-participation.mjs:acquire`：`:57` 改为取快照加 `assert`，`:63` 改为对同一快照 `assert`，`:69` 去掉宿主释放。
- `P\team-v15-window-participation.mjs:assertHeld`：`:76` 改为对保存的快照 `assert`。
- `P\team-v15-window-participation.mjs:release`：`:85` 去掉宿主释放。
- `P\team-v15-window-participation.mjs:read` / `acquire`：增加恢复模式，剔除 `host` 与 `loaded.host`。
- `P\team-v15-window-transition.mjs:transition`：`:124-127` 冲突时内联写 ABORTED，调整 `:138-141` 的 catch，更新 `:7-8` 注释。
- `P\team-v15-window-transition.mjs:recover`：`:166-168` 用恢复模式，`:176-177` 先补做落盘。
- `P\team-v15-window-surface.mjs:reserved` / `commit`：返回可重试的中止结果，可选做静默采样。重试预算放在调用 `commit()` 的决策器里；该调用方位置未验证，`team-v15-*.mjs` 内没搜到。
- `GATE`：不改。

必须新增的测试：
1. `optimistic_commit_idle_host_first_attempt`：空闲隔离宿主上一次提交成功，采集与提交时纪元相同。
2. `foreign_register_during_intent_fsync_succeeds_and_aborts`：别的会话在 intent 落盘期间注册不抛错，本次恰好留下一条落盘的 ABORTED。
3. `foreign_register_after_commit_append_commit_stands`：commit 落盘期间的注册成功，回执为 COMMITTED，下一请求带新的当前权威。
4. `async_host_writer_pending_at_commit_aborts`：提交段遇到进行中的异步 writer，中止而不提交。
5. `aborted_transition_leaves_session_readable`：中止后无需 `recover()`，会话可读，换新 ID 可再次提交。
6. `recover_tolerates_host_epoch_churn`：恢复期间宿主持续变更，`recover()` 仍完成而不保持 paused。
7. `recover_redoes_persist_for_inmemory_commit`：commit 追加后落盘失败，`recover()` 补做落盘并返回 committed，期间没有提前发布回执。
8. `fault_matrix_with_host_writer_at_each_point`：现有六个故障点各注入一次宿主 writer，日志与 surface 结论不变。
9. `bounded_retry_under_continuous_churn`：持续变更下落盘中止不超过预算，回合不失败，日志增长有界。
10. `lazy_install_callers_unaffected_during_transition`：`team-tools-v2-r10.mjs:8306-8314` 的巡检和 `team-v15-window-economics-runtime.mjs:176-190` 的先注销再注册在切窗期间不抛错，工具仍在。

**最大风险**：切窗自身或环境造成的纪元变动让每次尝试都在 PREPARED 之后中止，叠加发现 2，会话会被围住。
**最小验证**：先跑测试 1（隔离进程，等 40124 端口空闲后）。若空闲宿主上纪元有变化，先找出是哪个 writer，再推进其余改动。

## 交接摘要

- 乐观方案对宿主域成立，依据是 `GATE:31,34` 与 `transition.mjs:124-133` 无 `await`；闸门不用改。
- 必补四处：内联 ABORTED、`recover()` 不比宿主纪元、已提交分支补做落盘、有界重试。
- 提交点的纪元比较已有三处；`participation.mjs:76` 仍需换成对保存快照的 `assert`。
- 控制面围栏与 `protectFiles` 不变；`safeBoundary` 与 maintenance 不受影响。
- 不收窄纪元；按会话的内容指纹留作第二阶段，由 shadow 数据决定。
- 既有阻塞项：已有窗口的会话，请求路径上纪元一变就拒绝（`surface.mjs:130-136,159`）。
- 未验证：`commit()` / `recover()` 的生产调用方；切窗自身是否触发宿主 writer；`barrier.read` 是否 flush；控制面释放在运行时被拆除后的行为；请求路径间隔时长与是否重试。
- 契约变更需登记：`transition.mjs:7-8` 注释与实施计划 §10.1 接口证书。

TASK_TERMINAL: completed