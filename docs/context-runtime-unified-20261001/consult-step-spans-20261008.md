# 咨询：回合内步区间折叠在真实大根上只折到 2 条消息——段里该允许哪些 user 消息（2026-10-08）

只读。不要修改文件、不要运行测试或启动进程。请给独立判断，不必认同自评。回答用中文，要点式，1500 字以内。

这是上一次咨询（`consult-window-economics-20261008.md` 及其 `-answer.md`，同目录）的后续。你上次建议"支持折叠回合内已完成的步区间、区间按净节省量选"，已照做并上线，下面是实测。

## 已实现（生产与暂存区一致）
代码在 `D:\dsh-test\staging\context-runtime-unified-20261001\home\profiles\web\plugins\`：
- `team-v15-window-collector.mjs`：`protection()`（已完成回合不再整体受保护，只保护近期尾部 6 条、system/developer、未结束回合）、`foldCandidates()`（整回合候选不变；否则在回合内找"带工具调用的 assistant + 它的全部工具结果"组成的完整步，取字节最大的**连续**段，`scope: 'steps'`）、`retainCompletedTurns()` 只保留候选区间的副本。
- `team-v15-window-projection.mjs` 的 `plan()`：`scope: 'steps'` 的边界是 assistant 开头、tool 结尾；成对检查不变。
- `team-v15-window-protocol.mjs` 的 `proveCompletedReasoningSpan`：接受已完成回合内的连续切片。
- `team-v15-window-surface.mjs`：净收益门槛（折叠后对话 + 检查点 + 每请求权威，须比折叠前少 25%）。

## 实测（真实大 Team 根，约 50 万 token，384 条消息，此前被摘要压缩过一次）
手动 `/window fold` → `WINDOW_NO_BOUNDED_REDUCTION`：`beforeBytes 2,233,966 → afterBytes 2,589,507`，`removedMessages 2 / keptMessages 382`，`checkpointBytes 435,457`（权威分项：wakeInboxRefs 124,962、requirementRefs 37,037、planCoverageStates 24,758、waitingRefs 6,436、ownerScopeLeaseRefs 5,643、pendingAcceptanceRefs 5,402）。门槛正确拒绝。

## 原因（离线统计该根的会话日志，只看结构）
工具步之间不断插入 user 角色的消息，现实现把它们全部当作段的断点。该根日志里的 user 消息按来源：

| 条数 | 字节 | source | 内容 |
|---|---|---|---|
| 50 | 344KB | `kind: team-message, plugin: tool-agent-team-v2, form: notice`（"team quiet batch"） | 多条队友消息/子代理收尾消息的合并投递（队友原文） |
| 91 | 310KB | `kind: team-message, plugin: team-v12-runtime, form: snapshot` | 上下文包清单与增量（运行时生成，可重发） |
| 52 | 173KB | `kind: subagent-settled`（带 `senderSessionId`） | 子代理结束通知 + 其收尾消息（队友原文） |
| 30 | 89KB | `kind: team-wake, plugin: tool-agent-team-v2, form: action` | 队友请求根做决定（队友原文） |
| 24 | 45KB | `kind: team-plugin-message` | 唤醒死信等运行时通知 |
| 6 | 20KB | `kind: team-message` 带 `teamId/senderId` | 队友直接消息 |
| 少量 | <15KB | `team-activity-digest` / `team-idle-watch` / `step-compaction` notice、里程碑 snapshot | 运行时生成 |
| 2 | 2KB | `kind: user`（`rpcId`） | 人的输入 |

各回合最长连续段（条数 / 字节），三种规则对比（第 2 回合是主体：509 条 / 2.2MB）：
- 现状（任何 user 消息都是断点）：第 2 回合 91 段，最长 13 条 / 122KB；全日志没有超过 153KB 的段。
- 规则 R（只让运行时生成的状态类消息留在段内：上下文包、活动摘要、空闲提醒、压缩恢复通知、里程碑快照、死信通知；队友原文与人的输入仍是断点）：第 2 回合 66 段，最长 13 条 / 122KB；全日志最长 33 条 / 174KB。**仍然远小于 435KB 的检查点。**
- 规则 T（除人的输入、无工具调用的 assistant 回答、agent-instructions、压缩检查点外，其余注入消息都可留在段内，含队友原文）：第 2 回合最长 414 条 / 1.83MB（其中注入消息 461KB），其余回合基本各成一段（120KB–320KB）。

用户已同意规则 R；规则 T 尚未获同意。我自己的判断：规则 R 没有实际收益；真正的选择在下面两条路之间。

## 想听你判断的问题
1. **规则 T 是否可接受**：被折掉的队友原文在恢复副本里逐字保留、在 Team 看板/证据库/收件箱里也有来源；而现有的"75% 硬上限摘要压缩"本来就会把这些队友消息一并有损摘要掉。在这个前提下，把队友消息折进窗口相对于摘要压缩是否并不更差？它会破坏什么保证（未答复的决定请求、尚未处理的队友结论、根对队友的承诺）？如果可接受，最小的安全条件是什么（例如：只折已被后续 assistant 步"看过"的队友消息；`team-wake` 的决定请求须已有对应的工具调用或回执才可折；最近 N 条队友消息保留；检查点里列出被折队友消息的发送者/消息 ID/一行摘要与取回方式）？
2. **另一条路：一次提交折叠多个不相连的段**（所有 user 角色消息原位保留，只折工具步）。按上表估算，user 消息合计约 1.0MB 会留下，收益约为规则 T 的一半，且要改 `team-v15-window-surface.mjs` 的"区间连续"前提与检查点位置语义。你认为哪条路对、或两者如何组合（例如多段 + 仅折运行时状态类消息）？请看 `makeProposal` 与 `plan()` 判断多段的改动面和风险。
3. **检查点 435KB**：其中 wakeInboxRefs 125KB 仍是最大项（已改为简要行）。在规则 T 下被折的队友消息与 wakeInboxRefs 是否重复表达同一批事实？能否让检查点只保留"未决"的唤醒/收件箱项（已决的只留计数与哈希），以及这样做的判定依据应取自哪里（控制面里的哪个状态）？请读 `team-v15-window-collector.mjs` 里 `authorityDetail === 'live'` 分支给出具体改法。
4. 被折区间里的上下文包消息（`team-v12-runtime` snapshot）：折掉后，上下文包的基线是否必须重置并在下一步完整重发？现有 `team-v14-context-delivery.mjs` 在切窗时的重置路径是否足够（你上次指出"切窗重置失败仅记日志"）？
5. 在你看来，按 1–4 做完后，这个根（2.23MB、检查点 435KB）折叠后的请求能否降到 1MB 以下并通过 25% 门槛？还有什么我没看到的、会让真实收益再次落空的因素（例如缓存前缀失效的一次性成本、被折内容随后被模型用工具大量取回）？
