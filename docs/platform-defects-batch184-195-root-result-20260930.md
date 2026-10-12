# DSH 平台缺陷批次 184-195 修复结果

## 变化与修复

- 批次 184：`pwsh/powershell -File` 的源码修复仍未由当前运行进程证明 live；保持 `source fixed / focused-verified / live pending`，不冒充已生效。
- 批次 185：`team_acceptance_packet` 的 group-acceptance 必须点名目标组分支尖；偏离组尖时以 `packet-commit-not-group-tip` fail-closed。四份 profile 已同步。
- 批次 187：verifier 的 `condition` / `blocker` 直接投递 tier 0，并返回 `rootEscalation`。
- 批次 190：`ready=false` 现在返回 `readyReason` / `readyReasons`，可具名 `owner-busy`、`no-plan`、`dependency-unmet` 和写面持有者。
- 批次 193：`blocked` 且无活动租约的任务不再成为 runnable write-scope holder；等待者可看到 `write-scope-held-by`，持有者也可看到 `write-scope-holding` 的反向 taskIds。批次 195 的一手运行读数已确认 `t134` 为 `ready=false / blocked-phase`，`t129` 恢复 `ready=true`。
- 批次 194：新增 `team_escalation_list` 只读路径，默认返回 open escalation 的 `category`、`urgency`、`target`、`summary`、`decisionNeeded` 和 `automated` 标志；`team_delivery_check` 新增 `escalationSummary`，并把人工作出的决策与 `wake-dead-letter` 自动通知分别计数。
- 批次 195：是批次 193 的运行复核与闭环，无新增平台代码修改。
- 批次 186/188/189/191/192：为观察、文档或产品语义裁定；B-189 保持 `partial / no platform change`，不写成平台修复。

## 修改文件

- `D:\dsh-test\home\profiles\web\plugins\team-v12-evidence-scheduler.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-tools-v2-r10.mjs`
- `D:\dsh-test\phase11-tests\platform-defects-fourth-pass.test.mjs`
- `team-tools-v2-r10.mjs` 已同步到 web/headless/desktop/teamtest 四份 profile。

## 验证

- B-193 原始反例与批次 194 escalation 分流：`platform-defects-fourth-pass.test.mjs` `14/14 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`。
- platform-defects 聚焦集：`216 tests / 216 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`。
- phase1-phase11 串行全量：`536 tests / 535 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`。
- 四 profile `team-tools-v2-r10.mjs` 与 scheduler 语法检查及测试语法检查：`5/5` 通过。
- 四 profile `team-tools-v2-r10.mjs`：size `420520`，SHA256 `D11C78C9023263A2B5FF7B891354C01B5F080180F5AA2415560FF547E5B725E6`。
- 四 profile `team-v12-evidence-scheduler.mjs`：size `43286`，SHA256 `FF9A4B5925D280E9B65249752E3572C319EE9E7F4ABD26422E5D3375AED4459A`。
- 只读检查当前控制面：19 条 escalation 中 open `0`；历史分布为 `wake-dead-letter=18`、`blocked=1`，与批次 194 的分类事实一致。

## 未决风险

- 当前 DSH PID `30948` 早于本轮 profile 修改；批次 194 的 `team_escalation_list` 和 delivery summary 为 `source fixed / focused-verified / live pending`，未重启 DSH。
- 批次 184 的 `-File` 修复仍未由当前进程做 live 复核，继续保持 live pending。
- B-189 仍为 `partial / no platform change`；协调态共享锁写入路径和 41 小时 queued 投递停滞仍为独立未闭合项。
- 未重启 DSH、未中断 active Team、未清理 backup/spill/telemetry/session、未修改 RustMc 产品仓。

## 清单指纹

- size：`1383506`
- mtime：`2026-09-29T23:53:11.3479958Z`
- SHA256：`E50BA8DBD12723F494696E3D7542F31B88F995F2BA4918BFCFEA06D354866DC5`
