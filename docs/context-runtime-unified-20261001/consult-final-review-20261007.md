# 终审请求：上下文运行时三步改动（2026-10-07）

你是独立复核者。只读，不要修改任何文件，不要启动宿主或跑测试（可以读代码和日志）。请给出独立判断，不必认同下面的自评。

## 背景
DSH 是一个多代理（Agent Team）宿主。模型上下文窗口约 1,048,576 token；`autoCompactRatio: 0.75` 是不可移动的硬上限，其上 25% 是有意留的余量。此前你建议的顺序是：①请求预算准入与超窗恢复 → ②修正后的 A+B（宿主从已批准任务计划派生计划，只在阶段边界/切窗前发布；任务覆盖与需求完整性分开）→ ③统一的提交/恢复层与受控的 W2（持久窗口）接线。三步现已实现并部署到生产（`D:\dsh-test\app`、`D:\dsh-test\home`），W2 只对一个测试会话开启。

暂存区根：`D:\dsh-test\staging\context-runtime-unified-20261001`（生产文件与其一致）。插件目录：`home\profiles\web\plugins\`。完整记录：`D:\dsh-test\docs\context-runtime-unified-20261001\execution-ledger.md`（很大，只需读最后约 150 行，从"检查点（10-07 约 18:30）"开始；其上两条"补记"是本轮的中间记录）。

## 请读的代码（都在插件目录下）
1. `step-compaction-v4.mjs`：`preStepBudget`、`summaryRequestBudget`、预算重试块（搜 `dsh.step-compaction.budget-retries.v1`）、`installBudget`、`installOverflowReclassifier`、`windowFold`、`compactOnIdle`。
2. `team-v15-window-plan.mjs`（全文）。
3. `team-v15-window-wiring.mjs`（全文）、`team-v15-window-executor.mjs`（全文）。
4. `team-v15-window-install.mjs` 的 `installSessionWindow`；`team-v15-window-collector.mjs` 的 `planFor` / `sourceFor` / `protectionFiles`；`team-v15-window-surface.mjs` 的准入投影与 `maxPayloadBytes` / `maxRequestBytes` 用法；`team-v15-window-projection.mjs` 的 `plan()`。
5. `request-message-projection.mjs` 里 `brandModules` / `isAgentLoopRequestInAnyCopy` 相关的十几行。
按需再读其它文件的局部，但不要通读 `node_modules`。

## 已有证据（自评，供你核对或反驳）
- 全量回归 224 文件 / 1391 过 / 0 失败。
- 生产端到端（测试 Team 根会话，真实形态）：手动切窗 `COMMITTED`；切窗后真实请求正确作答；带已提交窗口的热重载交接成功；主机重启后 30 秒内自动恢复；其它会话零改动。
- 两位 Opus 审查者分别审过第①步的拒步恢复和第③步的接线，指出的问题已修（见台账）。

## 想听你判断的问题
1. **第①步是否真的闭合**：已知超预算的请求不再发出；被拒的步如何恢复（当场放回输入 + 延时自唤醒 + 引擎步边界压缩）；provider 的"参数被拒"400 在接近窗口时改判为超窗。还有哪条路径能让一个成员在 88 万～104 万 token 之间卡死或静默丢输入？重试用尽后只通知根代理，这够不够？
2. **第②步的取舍**：没有给真实 Team 自动注册 v15 交付计划（那会把它们切到要求四维证明的交付门上），而是把已批准任务计划的确定性投影发布到控制面，窗口引用它，覆盖声明明确写"需求清单未知/有已知需求无任务/已知需求都有任务"。这是否满足你当初"任务覆盖不等于需求完整性"的要求？`team_delivery_check` 里还没有加覆盖提示——有必要吗？
3. **W2 的数据设计（最想听的）**：实测一个只有 2 个任务的小 Team，检查点权威 68KB（证据 28KB、唤醒收件箱 20KB 含已处理项、等待票据 6KB…），提交事件里检查点存两份（149KB），之后每个请求再附 72KB 的"当前权威"消息且缓存不到。小会话上切窗后请求反而变大；大 Team 的权威会超过 256KiB 上限，已有窗口的会话届时每个请求都会被拒。我的判断是：现在不能对真实 Team 根开启，必须先把权威改成"引用+哈希"并去掉双份。请评估这个判断，并给出你认为最小且安全的权威瘦身方案（哪些域可以只留哈希/计数、哪些必须留全文、"当前权威"消息是否还有必要每请求重发、已有窗口的会话在权威超限时应有什么出路）。
4. **生产缺口**：请求的"官方代理循环"标记存在于另一份 dsh-llm 模块实例里，投影服务一直看不到，导致 `team-context`、`plan-read`、`history-recall` 三个投影在真实会话上从未生效。我只为窗口采集器开了跨副本识别，没有替用户打开那三个功能。这个处理是否恰当？如果要打开，应先验证什么？
5. **"≥50 万 token 在下一个空闲边界折叠"现在是真实触发**（对所有成员，走摘要压缩；窗口范围内的会话先问窗口）。带 10 分钟冷却。有没有会造成反复压缩或与 0.75 硬上限路径相互干扰的情况？
6. 你看到的、上面没提到的最严重的 1～3 个问题。

## 输出要求
- 开头给总判断：三步各自是"可以交付 / 有条件交付 / 不应交付"。
- 每个结论给出依据（文件与函数名），区分"读代码确认"和"推测"。
- 结尾列出：必须在对真实 Team 开启 W2 之前完成的事项（按优先级），以及可以以后再做的事项。
- 用中文，控制在 1500 字以内的要点式回答。
