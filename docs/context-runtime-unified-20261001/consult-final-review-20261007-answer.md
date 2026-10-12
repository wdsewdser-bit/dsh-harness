**总判断：①有条件交付，仅作止损；②有条件交付；③不应交付给真实 Team，维持测试 list。**

只读终审完成，未改文件、运行测试或启动宿主。核对既有回归为1391过、0失败、1跳过。以下代码路径已确认，故障后果为静态推断，未实测复现。

1. **①预算尚未闭合。**[preStepBudget](D:/dsh-test/home/profiles/web/plugins/step-compaction-v4.mjs:422)只测已入会话的内容，漏算本步输入、上下文及后置投影；`summaryRequestBudget`只拦空闲摘要，未覆盖引擎摘要。因此不能宣称“超预算零发送”。400重分类仍是启发式，宜限定路由及错误码。仅静默通知根不够：根自身卡住没有接收者，重启也会丢失重试定时器。需要持久暂停、操作员告警和恢复入口；[v12安全欠账拒步](D:/dsh-test/home/profiles/web/plugins/team-v12-runtime.mjs:3626)仍须保全已认领输入。

2. **②投影合理，交付口径未闭合。**[deriveWindowPlan](D:/dsh-test/home/profiles/web/plugins/team-v15-window-plan.mjs:22)的三态声明与稳定发布合理；但[deliveryCheckCoverage](D:/dsh-test/home/profiles/web/plugins/team-v15-delivery-service.mjs:12)无注册计划仍准许交付。`team_delivery_check`应显示需求未知/漏项，并分开“任务完成”和“需求完整”，无须强推四维证明。

3. **③同意先瘦身，且首次提交也有风险。**[sourceFor](D:/dsh-test/home/profiles/web/plugins/team-v15-window-collector.mjs:241)携带历史全文；[makeProposal](D:/dsh-test/home/profiles/web/plugins/team-v15-window-surface.mjs:78)未按256KiB检验后续当前权威，故首次切窗也可能提交后立即卡住，并非必然安全回落。最小方案：分域不可变快照，引用带版本、哈希、ACL和保留保证；旧证据、已处理唤醒、已结束等待、旧任务只留引用及计数。当前任务、硬约束、owner/scope/lease、待处理输入和恢复债务保留有界全文；超限细节必须先读取。检查点仅存一份。宿主每请求校验最新权威，模型采用稳定基线加差量；确认基线仍在且版本匹配才免重发全文。已有窗口超限应暂停，并提供宿主迁移/重建入口，不能关闭守卫放行。

4. **新增P1：摘要后可能静默漏发当前权威。**[summarizeCompaction](D:/dsh-test/app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:597)不保留`nativeWindowCheckpoint`；[surface准入投影](D:/dsh-test/home/profiles/web/plugins/team-v15-window-surface.mjs:115)仅见该标记才补发。标记被摘要覆盖后，即使`windowId>0`也可能漏发；应依据持久窗口状态判断。

5. **跨副本修复应单独验收。**生产[isAgentLoopRequest](D:/dsh-test/home/profiles/web/plugins/request-message-projection.mjs:277)的保守处理合理。扩大前须验证三投影的真实派发、权限、顺序、收据、预算，以及摘要/无标记请求不被误识别。审查期间，暂存版本已被外部改为全面跨副本识别，生产未变，现已不一致。

6. **50万规则有重复压缩风险。**[compactOnIdle](D:/dsh-test/home/profiles/web/plugins/step-compaction-v4.mjs:871)读取成员行的冷却，[observeEngineCompaction](D:/dsh-test/home/profiles/web/plugins/step-compaction-v4.mjs:1003)却写`engine:成员`；引擎压缩后仍≥50万可能马上再压。0.75路径失败可继续回合，尚非硬保障；headless也未配置50万。

**真实 Team 开启W2前，按优先级完成：**①最终请求及摘要预算、统一拒步恢复；②首切体积准入、摘要后权威补发；③快照瘦身、旧窗口迁移及大上下文/重启/HMR验收。**可后做：**进一步缓存优化、历史索引优化、完整四维交付门。

TASK_TERMINAL: completed
