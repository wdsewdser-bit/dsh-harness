**结论：原版 T 不宜直接启用；先补处置证明、工作摘要与计量，再试受控 T；收益不足再扩展多段＋R。**全程只读，未修改文件、运行测试或启动进程。

1. **T：副本无损不等于模型记忆无损。**当前[工作态](/D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-collector.mjs:441)没有工作摘要，W2 正文也不带它，直接折掉队友结论可能比摘要更差。最低条件：来源白名单、稳定消息 ID、合并消息逐项核对；未答决定、未验收结论、根的承诺保留，或先形成必读要点。wake 要关联实际决定及执行／拒绝回执；后续出现 assistant、普通 ack、保留最近 N 条均不能替代。仍限已结束回合，保留工具配对、尾部保护及副本校验；整回合分支也应适用。

2. **多段可组合，但不是 surface 小改。**`plan()` 已能处理多个各自连续的 span；collector 只选最大段。`makeProposal`、transition 和[原生日志](/D:/dsh-test/staging/context-runtime-unified-20261001/app/node_modules/@deepseek-ai/dsh-session/lib/index.js:293)均限定单个 replace。需要原子多区间提交、共享检查点及明确插入位置，保持间隙消息顺序，并修改日志验证、恢复与兼容语义；不能只删连续检查。建议先保留单区间事务做受控 T；若坚持队友原文始终可见，则选多段＋R，接受收益上限。

3. **“只保留未决”已部分实现。**[live 分支](/D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-collector.mjs:348)已汇总 handled 收件箱及 handled/rejected 唤醒；目标根磁盘仍有146条未处理收件箱、14条非终态唤醒，125KB不能靠再次过滤已决消失。依据 `v12RoomWake` 的 inbox/wakes/acknowledgedInbox，并核对 `dispatches.pendingMessages`；delivered/injected 不算已决，ack 也不证明业务完成。具体应把 `briefRow` 的“所有字段截短”改为固定字段：ID、发送者／目标、状态、短要点、处置引用及取回方式；同消息去重，wake 仅引用消息 ID，其他成员无关项聚合。重复项须能追到已处置的原消息，不能按文本相似直接删。

4. **基线重置仍不够。**[窗口事件处理](/D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v12-runtime.mjs:2140)失败只记日志；force 仍受预算，部分包派发即可推进 baselineId，旧 versions 又继续继承。应从已提交窗口日志恢复 epoch，失效旧覆盖，重发当前必需源；最终派发前核验关键源齐全，缺失则拒步。实际派发回执持久化后才清除基线欠账，失败重试。无需重放所有历史包。

5. **不能承诺低于1MB。**这次报错来自 [plan 的“未缩小”预检](/D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-projection.mjs:95)，尚未到25%门槛。435KB计入 source 与正文中的重复权威；[W2估算](/D:/dsh-test/staging/context-runtime-unified-20261001/home/profiles/web/plugins/team-v15-window-surface.mjs:156)也包含 source，应统一按最终发送体计量，计入基线重发、权威差量、工具定义，再按净收益选段。假设同口径确可删1.83MB：`2.234−1.83＋0.435≈0.84MB`，仅余约160KB；但414条候选来自全日志，当前只有384条，不能套用。25%门槛只要求约≤1.675MB。缓存重建、差量转全量、结论缺失后大量取回，均可能抵消收益。

