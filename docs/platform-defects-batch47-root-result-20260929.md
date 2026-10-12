批次 47（B-182 至 B-185）修复结果

清单指纹：size 675733，SHA256 A9939E6352DB7D24D3F15AF2865A4572CD99333E5E5F1613AE78926D6D8E7599，mtime 2026-09-29T04:17:35.8863946Z。

修复项：
- B-182：结构化等待票不再因任务进入终态被 task-terminal 静默关闭；只有 legacy 无结构化条件的票仍按终态关闭。显式 waiting_resolve 和条件满足自动解除保持可用。
- B-183：requirement/decision 授权现在从 input.taskIds、task_ids、已有记录及 requirementId = task:<taskId>:... 前缀解析任务作用域，并继承已有 scope；空 scope 不再直接判为 global。
- B-184：write-scope-guard.mjs 已有 verifier-scratch 白名单和产品路径负控，本轮未改代码；因 PID 124592 早于 guard mtime，只能标 focused-verified / live pending。
- B-185：citation_integrity / .ps1 引注门禁属 RustMc 产品仓，本轮平台侧无代码修改。

验证证据：
- 新增 platform-defects-twenty-seventh-pass.test.mjs，并同步旧断言。
- focused 组合 88/88 通过。
- 全量 phase1-phase11：486 tests / 485 pass / 0 fail / 1 skipped；日志 D:\dsh-test\output\platform-defects-batch47-full-phase1-phase11-20260929-v2.log。
- 四份 profile 两个目标文件 node --check 8/8；web/headless/desktop/teamtest 哈希一致。
- team-v14-waiting.mjs SHA256 874DE096242977F1FC297FE344494BA3EBE3E515382DF9689C833BC9CFF34444。
- team-v12-runtime.mjs SHA256 F11190B8D9D8014D4530170D4F08EFE0C34E17BB024E6174131A76400E9CEB18。

未决风险：
- 未重启 DSH，也未中断 active Team；B-182/B-183 以及 B-184 的 live 生效仍需 root 在进程更新后按原始反例复核。
- 未清理 backups/spill/telemetry/session，未修改 RustMc 产品仓。

台账：D:\dsh-test\docs\agent-team-platform-defects-fix-ledger-20260927.md
