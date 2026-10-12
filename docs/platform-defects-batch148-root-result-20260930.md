# DSH 平台缺陷批次 148 修复结果说明

## 结论

本轮处理清单批次 147-168 的平台可修项，并对 B-222 的诊断作出更正。源码修复状态为 `fixed / focused-verified / live pending`；B-222 仍是运行中的冷启动能力退化，不能用 profile 代码冒充已修复。

## 已实现

1. 显式空写面完整路径

   已批准计划现在可以声明 `writeScopes=[]`，用于“实现已完成、只剩判据运行且无产品写入”的任务。claim、ready queue 和 `complete` 都接受这一显式状态；仍要求已有 evidence，`commit_sha:null` 仅在已批准空计划下放行。

2. 补位组长 re-parent 持久化

   `team_member_reparent` 允许 tier 0 把同组既有 tier-2 成员转给替补 tier-1 组长。覆盖会持久化，并在控制面重启后重新水合；message、interrupt、milestone 和 merge 权限随新 parent 生效，不重写成员会话谱系。

3. blocked 任务不再无条件阻塞后继

   `blocked` 且无 active lease 的任务不再阻塞后继 claim；如果仍有 active lease，冲突继续生效。ready 与 claim 的 lease 口径已分别覆盖。

4. queued inbox 显式 ack

   `inbox_list` 已暴露的 queued 行现在可由目标显式 ack，并补齐 caller/target 校验。这只修复 ack 出口；41 小时 queued 投递停滞的根因仍未修复。

5. B-222 诊断更正

   Agent Team 契约允许非空 inactive/idle 目标冷启动。当前运行中的 DSH 对 `action` 返回 `delivery-failed`，而 `info` 仍可投递，因此是运行时冷启动能力退化，不是目标属性，也不能通过把 inactive 改成永久不可投递来“修复”。profile 中新增的 `deliveryTargetVerdict()` 仅作为契约回归守卫。

## 验证

- 原始反例：`D:\dsh-test\phase11-tests\platform-defects-thirty-seventh-pass.test.mjs`
  - `7 tests / 7 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`
  - test SHA256：`E933C03A938FF595467C70FB461D66ED3DC7ED20846ECC8C666874E1EE5970B9`
  - log SHA256：`79A39364B4A13D80895C2298C9C0BB7C269032C44EFD96A8C5459B559F03551A`
- 四份 profile 的 7 个修改文件 `node --check`：`28/28` 通过。
- platform-defects 聚焦集：`203 tests / 203 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`
  - log SHA256：`7927B6ADF970840E815CAB222238BFBA4C7BC1C396D18A0E6D76AAF2652F99D1`
- phase1-phase11 串行全量回归：`523 tests / 522 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`
  - log SHA256：`5CE3C00B18335B524417612FCF9D9CEEB50B83E3973D10216A7502853B810F6D`
- profile parity：`1/1`，`EXIT_CODE=0`
  - log SHA256：`753A0DBFFB83511D6E3D328EF7FAD11C3A9C7E84011BF11665581ADE2B53A3F4`

## 同步指纹

以下文件在 web/headless/desktop/teamtest 四份 profile 中 size 与 SHA256 均逐字一致：

- `team-tools-v2-r10.mjs`：size `403838`，SHA256 `A17C9EFB9F793CA97040609EE513CE439E787E84ED51BDF29631B3898F730A37`
- `team-v12-contract.mjs`：size `28884`，SHA256 `855BAE98F17C1A42527B16114CD413576B2BC06F8CCFA5B7724990726C86F878`
- `team-control-plane.mjs`：size `213370`，SHA256 `C06733FF7149E1E96099DB60FFD3DF7DDD32E4FB5A338CF798DBCFEC27EDFC63`
- `team-policy.mjs`：size `39535`，SHA256 `F5A9375D09156B04E5F85C6CCC97D1BAD4B7FA80992E11307C4736EC11061D47`
- `team-v12-room-wake.mjs`：size `88872`，SHA256 `815B66C7F07320E61B4EED1EBFB51289CCD15EA2AEFCF448A91045936BE3DAB8`
- `team-v12-runtime.mjs`：size `148546`，SHA256 `32B29D1760699680AC2F9A10B5125231BBC94C065382A2C7F9C90B77477E62DB`
- `team-v12-evidence-scheduler.mjs`：size `43086`，SHA256 `09D9A9DC7688F99FAD19FA19F7FCCCD1FC69E0B370193EE9E47A74D4F9D503C7`

## 未决与约束

- B-222 仍需运行中的 DSH 恢复冷启动能力。当前唯一受约束内可用的推进方式是 `info` 留信或为每个工作单元 spawn 新成员；本报告不声称 action 冷启动已恢复。
- 41 小时 queued 投递停滞、旧接收者死信重试、恢复后自动续投仍指向旧目标，均保留为独立未闭合项。
- 当前 DSH PID `30948` 早于本轮 profile 修改；未重启 DSH、未中断 active Team、未清理旧备份/spill/telemetry/session、未修改 RustMc 产品仓。
- B-221 已单独报告，不在本报告中重复收口。
