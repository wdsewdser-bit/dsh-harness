# DSH 平台缺陷批次 204/205 与第 3/4 号请求修复结果

## 变化与结论

- 第 4 号已找到具名根因：`taskContext()` 把 `group-world-t139` 的超大
  deliverable 全量放进 safety-critical 必需上下文。旧路径因此触发
  `team-context-safety-debt` fail-closed，成员看到的表现为拒绝或零产出。
- `team-v14-context-delivery.mjs` 现在对超大 task deliverable 保留头尾预览、
  原始字符数和 digest，并继续携带
  `fetch: { action: "task_contract_get", task_id }`。通用 safety-critical
  fail-closed 语义没有削弱。
- 第 3 号的 `-File` 两臂探针仍无判别力；状态保持
  `partial / live pending`。决定性验证仍是持有覆盖脚本的已批准计划成员执行
  `t114` 对照跑。

## 修改文件

- web/headless/desktop/teamtest 四份 `team-v14-context-delivery.mjs`
- `D:\dsh-test\phase11-tests\v14-identity-context.test.mjs`

四份 profile 均为 size `13577`，SHA256
`1B630D12A0C80FC110CB9320C2AD08A8D8391E10D6A7E89FB81C8EFA730F6ED8`。

修改前备份：
`D:\dsh-test\backups\platform-defects-batch206-20260930-124839`。

## 原始反例重放

真实 `group-world-t139` rev36：

- deliverable chars：`64475`
- 旧 context chars：`65516`
- 旧 omitted tokens：`32426`
- 旧 `debt=true`，旧 `failClosed=true`
- 新 context chars：`4790`
- 新 estimated tokens：`2316`
- 新 `debt=false`，新 `failClosed=false`
- 新 preview chars：`4096`
- `deliverableTruncated=true`
- `task_contract_get` fetch 保留

## 验证

- `v14-identity-context.test.mjs`：`14/14 pass`
- 四份 profile `node --check`：`4/4` 通过
- platform-defects 聚焦集：`216 tests / 216 pass / 0 fail / 0 skipped`
- phase1-phase11 串行全量：`537 tests / 536 pass / 0 fail / 1 skipped`
- profile parity：`1/1 pass`
- 聚焦日志：
  `D:\dsh-test\output\platform-defects-batch206-focused-20260930.log`
  SHA256
  `51422369C79754863562D9ACAE93DFCD0A6C2AEBFA75AB3B759A419BCFE322FC`
- 全量日志：
  `D:\dsh-test\output\platform-defects-batch206-full-phase1-phase11-serial-20260930.log`
  SHA256
  `8C5453A85BCBA84AFEA624F0549C67826144A08A83E9926A603C54725B667C1E`

## 未决风险

- 本轮 profile 写入时间为 `2026-09-30T04:48:53Z`，当前 DSH PID `31528`
  启动于 `2026-09-30T03:37:13Z`；未重启 DSH，因此第 4 号修复为
  `source fixed / focused-verified / original-counterexample-replayed / live pending`。
- 第 3 号仍需已批准计划成员按原始反例执行 `t114` 对照跑。
- 该修复限制的是进入成员上下文的 task deliverable 预览，不是 OS 级沙箱；
  完全动态外部程序写盘继续受 A-6 残余风险约束。
- 未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、
  未修改 RustMc 产品仓。

## 清单指纹

- size：`1419778`
- mtime：`2026-09-30T04:04:00.0356704Z`
- SHA256：`770FD29BD1945CED00CA2BE52D6E7B6AFB7E3C4E76AE6F1D3852DF0535E61C16`
