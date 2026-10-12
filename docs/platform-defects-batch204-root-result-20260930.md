# DSH 平台缺陷批次 204 修复结果

## 变化与结论

- 更正上一轮对 `-File` 两臂探针的归因：两臂返回同一句旧 opaque 串，不能证明新代码没有加载。旧诊断把 `script-invalid` 与 `script-outside-plan-scope` 折叠成同一句文本。
- `write-scope-guard.mjs` 新增仅诊断用途的分支：两类失败现在分别返回 `[script-invalid]` 和 `[script-outside-plan-scope]`，并保留 fail-closed 行为。没有放宽任何写入授权。
- 当前 DSH PID `31528` 于 `2026-09-30T03:37:13Z` 启动；行为修复源码早于该进程启动。诊断增强于 `2026-09-30T03:45:02Z` 写入，尚未由当前进程证明 live。
- 批次 204 的 world 组问题仍无平台源码修复。重启后 `lead-world-3` 状态和重挂操作已有变化，但这不构成“world 组恢复持续产出”的证据；相关等待仍保持 open。

## 修改文件

- web/headless/desktop/teamtest 四份 `write-scope-guard.mjs`
- `D:\dsh-test\phase11-tests\platform-defects-thirty-eighth-pass.test.mjs`

四份 guard 均为 size `63114`，SHA256 `0F192C15D34277899F2E5867898AC482951784059690AFFE1A4C136B2F1129E7`。

## 验证

- B-218 原始反例：`7 tests / 7 pass / 0 fail / 0 skipped`，覆盖 scoped `-File` 放行、越 scope 拒绝、worktree carrier 拒绝、inline/组合命令 fail-closed、缺失或非 UTF-8 脚本 fail-closed。
- platform-defects 聚焦集：`216 tests / 216 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`。
- phase1-phase11 串行全量：`536 tests / 535 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`。
- 四份 guard 与测试 `node --check`：`5/5` 通过。
- 直接源码反例：缺失脚本返回 `script-invalid`；仓内但越 scope 的已存在脚本返回 `script-outside-plan-scope`。

## 未决风险

- B-184 / B-218 的诊断增强为 source fixed / focused-verified / live pending；没有重启 DSH，不把源码检查冒充 live 生效。
- `-File` 的静态预检仍不是 OS 级沙箱；完全动态的外部程序写盘继续受 A-6 残余风险约束。
- world 组持续可达性仍未解决，当前证据不足以指定新的代码修复点。
- 未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓。

## 清单指纹

- size：`1415412`
- mtime：`2026-09-30T03:40:42.2828170Z`
- SHA256：`746A5FE48587C61059146CB7F65B9541ECE0E9A4E1E85BAF472A673A48D34A58`
