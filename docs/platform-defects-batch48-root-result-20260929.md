批次 48（B-186）修复结果

清单指纹：size 725502，SHA256 32AEFFA5D74AF2E3A5FADD97E6838EF80F7E11E34AC355E453FF375DD685CAF9，mtime 2026-09-29T04:57:14.8602150Z。

修复项：
- B-186：team-tools-v2-r10.mjs 对非 tier 0 增加相位边界判定，只允许推进到 integration-ready，不能手工进入 integrated 或 accepted。
- 已完成 discussion/review 卡片的既有直接 accepted 路径保持可用。
- reopen 自愈：edit 卡若已错误停在 integrated/accepted，重开会恢复到 execution，可重新按执行流程完成。

验证证据：
- 新增 platform-defects-twenty-eighth-pass.test.mjs，2/2 通过，覆盖越界拒绝、tier 0 放行、只读验收兼容和 accepted 重开自愈。
- 全量 platform-defects 聚焦集 168/168 通过。
- 全量 phase1-phase11：488 tests / 487 pass / 0 fail / 1 skipped；日志 D:\dsh-test\output\platform-defects-batch48-full-phase1-phase11-20260929.log。
- 四份 profile 目标文件与新测试 node --check 5/5 通过。
- web/headless/desktop/teamtest 的 team-tools-v2-r10.mjs SHA256 均为 1BF5F26E54FFAD58E482CAC9E44F0A67F64DA20B21B13667B240CD510D40CFF9。

未决风险：
- 未重启 DSH，也未中断 active Team；B-186 的 live 行为仍需 root 在进程更新后按原始反例复核。
- reopen 自愈只针对 edit 卡，不扩展为通用相位回退。

台账：D:\dsh-test\docs\agent-team-platform-defects-fix-ledger-20260927.md
