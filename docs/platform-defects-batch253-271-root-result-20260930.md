批次 253–283 平台缺陷修复结果（台账第七十六轮）

本轮清单发生两次变化，最终输入指纹为 size 1725861、mtime 2026-09-30T09:46:11.8182780Z、SHA256 027C9A069A83D14B14E1DC2D1AE21B09340D14D914C742A31E1C325AD451DA05。WORKAROUND-REVERT.md 未变化，size 29392、SHA256 52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2。

已修复并完成聚焦验证：
- B-227：全局板创建和 reassign 强制 owner 为 tier 0，tier-1 owner 在构造阶段被拒绝。
- B-228：scope-conflict 扫描排除“声明候选卡为未满足依赖”的 active task，保留真实冲突拒绝。
- B-229：waiting_resolve 支持显式 superseded 收口，写回 closedReason 与 supersededBy。
- B-230：暴露允许相位转移和 reopen 恢复动作，advance_phase 拒绝串不再隐藏返回路径。
- B-231：scheduler_advice 增加 executorInactive 和具名 stalledTasks，不再只报停滞计数。
- B-232：send_message(delivery:"decision") 与 team_wake_superior 的可选 message 字段集对齐。
- B-234：discussion/review 或零 write scope 的 completed 卡可用 commit_sha:null 补绑真实 evidence_ids；edit 卡仍要求 40 位 commit。

明确保留为 partial：
- B-233：宽目录 claim 仍必须覆盖子路径；自动放宽会释放仍承重的写面，安全路径仍是串行或搬家。
- B-235：整支分支与逐卡 packet phase 的单位尚未统一；不能把 meta 中的分支相位尾巴冒充平台清关。
- B-224/B-225 是 RustMc gate 设计观察，不是 DSH profile 缺陷，本轮未修改 RustMc 产品仓。

实现与同步：
- 修改 team-v12-contract.mjs、team-v12-evidence-scheduler.mjs、team-control-plane.mjs、team-policy.mjs、team-v12-runtime.mjs、team-tools-v2-r10.mjs、team-v14-waiting.mjs。
- web/headless/desktop/teamtest 四份 profile 的七个文件逐文件 size/SHA256 一致。
- 备份：D:\dsh-test\backups\platform-defects-batch253-271-20260930-172128。

验证：
- 新增原始反例：platform-defects-forty-third-pass.test.mjs，7/7 通过，SHA256 30217E91D2E36C958CC628F72317C9737BDE76BB91B134E541746702BF2B8CC8。
- 四 profile 七个目标文件 node --check：28/28。
- platform-defects 聚焦集：233 tests / 233 pass / 0 fail，EXIT_CODE=0；日志 SHA256 701497EF9BA2F4B3730F8CF936C7CAEBC910457A11E0B3D0ECBEAA29584C98B9。
- phase1–phase11 串行全量：554 tests / 553 pass / 0 fail / 1 skipped，EXIT_CODE=0；日志 SHA256 DB577D0D7B38C8C39409376E2058815D7297FE777C00C868848B08DAA788E1ED。
- profile parity：1/1，EXIT_CODE=0；日志 SHA256 A9D491024A23B15B54B631027B18B69FCC7533CFA769347B18F86CA1178495C7。

边界与未决：
- 当前 DSH PID 16440 / 端口 40123 启动于 2026-09-30T16:37:18+08:00，早于本轮源码修改时间；未重启 DSH，因此 B-227 至 B-232、B-234 的状态为 source fixed / focused-verified / live pending。
- 未中断 active Team，未清理 backups/spill/telemetry/session 数据，未修改 RustMc 产品仓。
- 最终清单 SHA256：027C9A069A83D14B14E1DC2D1AE21B09340D14D914C742A31E1C325AD451DA05。
