【平台修复结果 · D-新-14 补充 / D-新-15】

本轮已修复第三十三批变化：

1. D-新-14 补充：`team_v12(action:"leases")` 现在在 tier 0 未传 `member` 时仍返回全表；一旦显式传 `input.member`，就真正按 member 过滤，并与 `taskId`、`status` 取交集。非 tier 0 仍只能读取自己的 lease。

2. D-新-15：`write-scope-guard.mjs` 新增绑定工作树载体校验。tier 1/tier 2 有活动 plan worktree 时，文件写入、shell cwd、`git -C <path> commit/add` 的载体必须落在绑定 worktree 内；共享检出和其它成员 worktree 会被 `worktree-carrier-mismatch` 拒绝，绑定 worktree 正常放行。tier 0 共享检出兼容路径保留；无活动 plan 的旧静态 scope 路径未扩大。

验证：

- 新测试 `platform-defects-twenty-fourth-pass.test.mjs`：4/4。
- 相关 focused：48/48；兼容调整后 fifth-pass + 新测试：14/14。
- 全量 phase1-phase11：480 tests / 479 pass / 0 fail / 1 skipped。
- 四 profile 目标文件语法：12/12；`v14-profile-parity.test.mjs`：1/1。
- 全量日志：`D:\dsh-test\output\platform-defects-batch33-full-phase1-phase11-20260929-rerun.log`，SHA256 `784E36C78CD799B78A87C03C169055E712CF3923B4F6ADBAB7D9EA3A3CEFB4F8`。

文件 SHA256：

- `write-scope-guard.mjs`：`6C5A42F29EDE7800DAA5E91B41787E43A6057BDB663B11D253B1D52C08FB8826`
- `team-v12-evidence-scheduler.mjs`：`CA398C905C8716C339EBDFD985D7F5A5EE4557DD3B2F9FCD0DA83CD57517AFAD`
- `team-v12-runtime.mjs`：`C9418F837295CA36829331C95F29C7A210AE4C90586C82F81A7811897CF17D70`

约束与风险：

- 未重启 DSH，PID 124592 / 端口 40123 保持；未中断 active Team，未清理 backups/spill/telemetry/session，未修改 RustMc 产品仓。
- 运行中进程是否已 HMR 加载这三份模块仍需 root 后续只读调用确认，不能把本轮 focused/全量回归写成 live verified。
- `write-scope-guard` 仍只覆盖受控工具和已解析命令；任意无参子进程自行写盘的 A-6 残余未扩大修复。

备份：`D:\dsh-test\backups\platform-defects-batch33-20260929-090124`。
