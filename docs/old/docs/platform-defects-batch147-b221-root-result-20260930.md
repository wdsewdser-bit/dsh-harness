# DSH 平台缺陷 B-221 修复结果说明

## 结论

B-221 已完成源码修复并通过聚焦与回归验证，状态为 `source fixed / focused-verified / live pending`。

根因：legacy wake 状态重水合时，`compactWakeTracking()` 只依据 wake 终态和 injection receipt 重建 inbox 行，没有读取 `acknowledgedInbox`。因此已经 ack 的 legacy 消息在规范化后会被重新建为 `queued`，在同一 `dedupeKey` 下继续形成唤醒风暴。

修复：规范化 legacy inbox 行时先读取 `acknowledgedInbox` 和既有 `inbox/handled` / `wake/handled` 证据；已 ack 行恢复为 `handled`，并保留最大 `handledAt`，不再复活为 pending。四份 profile 的 `team-v12-room-wake.mjs` 已同步。

## 改动与指纹

- 四份 `team-v12-room-wake.mjs`：size `87804`，SHA256 `9E541B7E0686034E53C29AA205FAAB8DC1B2F20A57B8AFCDD6F18122C3EE6765`
  - `D:\dsh-test\home\profiles\web\plugins\team-v12-room-wake.mjs`
  - `D:\dsh-test\home\profiles\headless\plugins\team-v12-room-wake.mjs`
  - `D:\dsh-test\home\profiles\desktop\plugins\team-v12-room-wake.mjs`
  - `D:\dsh-test\home\profiles\teamtest\plugins\team-v12-room-wake.mjs`
- 原始反例：`D:\dsh-test\phase11-tests\platform-defects-thirty-sixth-pass.test.mjs`
- 反例测试 SHA256：`A848E82613D8A9FA00B29233EE3168DB534CE593DB2FA20878C79C11A5262193`
- 修改前备份：`D:\dsh-test\backups\platform-defects-batch147-20260930-042100`

## 验证

- B-221 专项：`1/1` 通过。
- 四份 profile 语法：`4/4` 通过。
- 四份 profile parity：`1/1` 通过。
- platform-defects 聚焦集：`196 tests / 196 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`。
  - 日志：`D:\dsh-test\output\platform-defects-batch147-focused-platform-tests-20260930.log`
  - SHA256：`A61E0C2D2879A2AEF3FCB6C24FDABEFC94E4CB54436CB65988E75A0D547A5295`
- phase1-phase11 串行回归：`369 tests / 368 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`。
  - 日志：`D:\dsh-test\output\platform-defects-batch147-full-phase1-phase11-serial-20260930-v3.log`
  - SHA256：`D6217A7347EEB68033A0690B80F307A23DF53D3BAA4C2876CD5E9B8DD5FCF87F`

## 边界与未决

- 当前 DSH PID `30948` 早于 B-221 源码修改，因此本轮只记为源码修复和离线验证通过，不冒充 live verified。
- 未重启 DSH，未中断 active Team，未清理旧备份、spill、telemetry 或 session 数据，未修改 RustMc 产品仓。
- 本说明只收口 B-221。清单中的 B-222、41 小时 `queued` 停滞、补位组长 milestone 可见性仍是独立问题，不并入本修复。
