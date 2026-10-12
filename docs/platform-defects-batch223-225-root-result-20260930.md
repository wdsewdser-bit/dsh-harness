# DSH 平台缺陷批次 223–225 修复结果

本轮处理最新清单中的 B-213c，并复核批次 223 addendum、224、225。

## 结论

- B-213c：**source fixed / focused-verified / original-counterexample-replayed / live pending**。
- 无 lease 时，四变体 A/B/C/D 均返回具名原因：`member ... has no declared static scope or active approved plan lease ... active lease: none`，不再误报命令必然能通过 inline interpreter 或 opaque expression 写入。
- 持有效 lease 时，普通 `-File` 与 `-OutFile` 形式仍按已批准脚本和 scope 判定放行。
- `&` 或其它 shell 组合仍 fail-closed，并具名为 `[explicit-file-required]`；本轮没有放宽授权、scope 或 carrier 语义。
- 批次 223 addendum、224、225 没有新增平台代码修复项；请求第 3 号维持 live verified，第 4/6 号维持既有 profile fixed / live pending，第 5 号维持原前提被反例否证。

## 验证

- 新原始反例：`3 tests / 3 pass / 0 fail / 0 skipped`。
- 既有 B-218 反例：`7 tests / 7 pass / 0 fail / 0 skipped`。
- platform-defects 聚焦集：`222 tests / 222 pass / 0 fail / 0 skipped`。
- phase1-phase11 串行全量：`543 tests / 542 pass / 0 fail / 1 skipped`。
- profile parity：`1/1 pass`。
- 四份 `write-scope-guard.mjs` 与两份测试 `node --check`：`6/6 pass`。
- 四份 guard 均为 size `64069`、SHA256 `9688D376C208B4F32CB0C6228448C7206479AB6CADC9779E452F12CF4E746864`。

## 约束与风险

- 未重启 DSH，未中断 active Team，未清理 backups/spill/telemetry/session，未修改 RustMc 产品仓。
- 当前 DSH PID `31528` / 端口 `40123` 保持。
- 修复写入于 PID `31528` 启动之后，因此不宣称 live verified；运行实例可能仍显示旧诊断。

清单最终指纹：size `1513763`，SHA256 `44712EFB68FD4E229E3BDE48C4711A2AF3418F59C487F2B0C987A41E0CE9D3B3`。
