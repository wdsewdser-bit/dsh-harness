批次 239 scope recovery 修复结果（台账第七十三轮）

本轮处理清单批次 239 新增的“owner 不活跃时，组长无法修正无计划卡的 write_scopes”。清单原文误标为 B-47，但 B-47 已被 waiting reconciler 的 manual 自动解除缺陷占用；为避免覆盖既有缺陷，本轮实现按 B-223 入账，原 B-47 仍保持 open。

实现：
- 四份 team-tools-v2-r10.mjs 新增 taskScopeRecoveryVerdict() / taskEditWriteScopeVerdict()。
- 仅允许 tier-1 组长在自己的 group-<group> 板、owner 具名且非 running/provisioning、任务无活动 lease、无计划、状态为 pending/in_progress、且新 scope 非空时修正 write_scopes。
- 跨组、非组长、owner 活跃、活动 lease、已有计划、终态或空 scope 全部 fail-closed；普通直接 edit 继续拒绝。
- 四份 profile 均同步，size 424731，SHA256 900E7F992F85DC629E0A5AA957ABAD0EEE91FD0343B2BF623220E830C82FAA14。

验证：
- 原始反例重放：platform-defects-forty-second-pass.test.mjs 4/4 通过；inactive-owner 路径成功，五类负控均拒绝。
- platform-defects 聚焦集：226/226，EXIT_CODE=0。
- phase1-phase11 串行全量：547 tests / 546 pass / 0 fail / 1 skipped，EXIT_CODE=0。
- profile parity：1/1，EXIT_CODE=0；四份 profile 与新测试 node --check：5/5。

边界与未决：
- DSH PID 31528 早于本轮源码 mtime，未重启 DSH，因此当前状态为 source fixed / focused-verified / original-counterexample-replayed / live pending。
- 未中断 active Team，未清理 backups/spill/telemetry/session 数据，未修改 RustMc 产品仓，WORKAROUND-REVERT.md 无新增回退项。
- 清单最终指纹：size 1598282，mtime 2026-09-30T07:34:11.7078233Z，SHA256 51956AEAABA00CC65C15F200EA9E80FBDE7EDDC40D94DF63D8EF8F038B6018C7。
