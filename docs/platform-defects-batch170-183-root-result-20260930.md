# DSH 平台缺陷批次 170-183 修复结果

## 变化与修复

- 批次 170/171：RustMc 引注 AMBIG 与 baseline 行号位移属于产品/文档线，无 DSH profile 修改。
- 批次 172：`inactive` 目标冷启动已由 profile 热重载恢复，一手 `action` 探针恢复 `delivered`；这是运行态恢复，不是新的源码修复。
- 批次 173/174：`team_member_reparent` 的里程碑读取、工作树布置、分支合并和成员→组长消息均已验证；孤儿 `pid 32592` 已收割，端口 `25790` 已释放且未误杀常驻 oracle。
- 批次 175-179/183：新 `-File` 形状门拒绝全部 PowerShell 脚本起跑。已修复为：活动 approved plan 的 `writeScopes` 覆盖范围内的单个、显式、顶层 `pwsh/powershell -File <script>` 可放行；脚本必须存在、大小受限、UTF-8 且位于绑定工作树。`pwsh -Command`、`bash -lc`、shell 分隔符、重定向、组合命令、缺失/非 UTF-8 脚本继续 fail-closed。
- 批次 180：`-File` 入口与共享协调态写入路径保持分开处理。前者已修；后者仍为 partial，本轮没有为共享锁私开 scope 例外。
- 批次 181：`HEAVY-SLOT.md` 的取消标记与依赖释放属于团队文档/排程修正，无 DSH profile 修改。
- 批次 182：新增 `timed-out -> expired` 死信退役路径，仅 tier 0 可执行；target/sender 仍可沿用原有 `cancelled` 路径。这样历史死信可以退出 open/dead-letter 指标，而不必改自动投递。

## 修改文件

- `D:\dsh-test\home\profiles\web\plugins\write-scope-guard.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-control-plane.mjs`
- `D:\dsh-test\home\profiles\web\plugins\team-tools-v2-r10.mjs`
- 上述文件已同步到 `headless`，`desktop`/`teamtest` 通过共享实体读取同一版本。
- 新回归：`D:\dsh-test\phase11-tests\platform-defects-thirty-eighth-pass.test.mjs`
- 扩展回归：`D:\dsh-test\phase11-tests\platform-defects-fourth-pass.test.mjs`

## 验证

- B-218 回归原始反例：修复前 `2/6`；最终 `7/7 pass / 0 fail`。
- 批次 182 原始反例：修复前 `invalid dispatch transition "timed-out" -> "expired"`；修复后 `1/1 pass`。
- 四 profile 语法：`14/14` 通过。
- platform-defects 聚焦：`211 tests / 211 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`。
- phase1-phase11 串行全量：`531 tests / 530 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`。
- profile parity：`1/1`，`EXIT_CODE=0`。

## 未决风险

- 当前 DSH PID `30948` 早于本轮 profile 修改，两个修复均记为 `source fixed / focused-verified / live pending`；未重启 DSH。
- B-218 修复是按已批准计划 scope 放行受跟踪脚本载体，不是 OS 级沙箱；脚本内完全动态的外部程序写盘仍受 A-6 残余风险约束。
- 协调态共享锁写入路径仍为独立 partial，不随 `-File` 入口修复自动关闭。
- 41 小时 queued 投递停滞和旧接收者死信自动续投仍为运行态观察项。

## 清单指纹

- size：`1327090`
- mtime：`2026-09-29T22:44:01.1884490Z`
- SHA256：`6400B96ED3DE337C9B8B1DDC2E29688918E8E4ABF42BADD8299901DCB0BFC9D8`
