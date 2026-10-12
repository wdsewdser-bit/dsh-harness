# DSH 平台缺陷批次 285-289 修复结果

## 清单输入

- `PLATFORM-DEFECTS.md`：size `1764976`，mtime `2026-09-30T10:39:05.1657171Z`，SHA256 `29A56D6B7E97B382D4D2B44F3D4F5EA50EE747AF13767F124F385FF50855CBC2`。
- `WORKAROUND-REVERT.md`：size `29392`，SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`，未变化。
- 未重启 DSH，未中断 active Team，未清理 backups/spill/telemetry/session，未修改 RustMc 产品仓。

## 已修复

- B-236：恢复串同时给出两条安全路径。A 为完成、记录精确 commit/evidence、释放 completed lease、replace plan、重新 acquire；B 为在飞时释放或取消 lease、replace plan、重新 acquire。
- PowerShell 注释路径误抽取：`write-scope-guard.mjs` 在路径提取前屏蔽 `#` 行注释和 `<# ... #>` 块注释；字符串内的 `#` 保留。
- `team_merge` 源单位歧义：新增显式 `source: "commit_sha" | "branch_head"`，默认行为保持兼容；回执打印 `sourceSelection`、`taskCommit`、`mergeSource`。
- `team_merge` 部分生效：回执现在分别报告 `gitApplied` 与 `phaseAdvance.status`。git 已应用但相位推进失败时，不再整体伪装为失败；回执保留 `phaseAdvance.code/reason`。
- 收件箱：`inbox_list` 返回可直接 ack 的顶层 `wake_id`；空 legacy wake 不再注入上下文；`inbox_ack` 的确定性记账失败归为 `stale-state`，不再永久触发 failure-memory。
- `team_worktree_setup`：任务已有 owner 且与 `target` 不一致时 fail-closed，拒绝静默夺走其他成员的写根。

## Partial / 无平台修改

- 清关键按 commit 绑定、不能继承相同 tree：本轮未放宽为 tree 清关。新增 tree 继承需要新的、可验证的证书继承模型；当前仍保持 commit-bound fail-closed，记为 `partial / no safe platform change`。
- `team_merge` 的 `destination-worktree-dirty` 对 tier-0 未提交台账的阻断属于落地窗口纪律；本轮未放宽脏树门禁。

## 验证

- 新增原始反例：`D:\dsh-test\phase11-tests\platform-defects-forty-fourth-pass.test.mjs`，`7/7` 通过；size `5779`，SHA256 `8C300DA25DD45B625F8D129DA73B3D9BAF7906A3166D01406B40353CF8559941`。
- 四 profile x 五个目标文件 + 新测试语法检查：`21/21` 通过。
- platform-defects 聚焦集：`240 tests / 240 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 SHA256 `FF537F523E79721214DB1183C3B9D7CACC384FFEA476D6AD920D8A70964B3B03`。
- phase1-phase11 串行全量：`561 tests / 560 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 SHA256 `4A4346DE69F08BCFC4817E38878BAA31F23D78EDECA99A1AE10F7C2D77931A4A`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`；日志 SHA256 `4F8DFF5F074DB22041B746BC1E96D88C2123B6B4DA8BBB9E658E8A71FA71F7EA`。
- HMR：`2026-09-30T10:55:27.7922151Z` 更新 web profile 五个目标插件 mtime；内容哈希不变。PID `16440` 保持不变，`team-health-web.json` 于 `2026-09-30T10:55:32.3360884Z` 重新计算为 `status=healthy / profileParity=healthy / reasons=[]`。

## 关键哈希

- `team-tools-v2-r10.mjs`：size `433234`，SHA256 `1C2DD3E14450FEABDAD2CEDEB0E6BFFA0EBC219046B9C47215BFDD5D64415DBE`。
- `write-scope-guard.mjs`：size `65851`，SHA256 `18C91C2766ED909B1AF29373B9C1D19223CA0E84AE419A9F08160E819B359416`。
- `team-control-plane.mjs`：size `216120`，SHA256 `42F7B2DB678AFBA6175D7BC432EA9E6DA3B5C881F3858E0FFF4F749CFFABA017`。
- `team-v12-runtime.mjs`：size `149730`，SHA256 `80CABBE985A2F203C51CE0386B039A13F6A9199D0210D2DD5BB255FBBBA15258`。
- `team-v13-failure-memory.mjs`：size `13016`，SHA256 `D8C4BFD7EB890E66389484CB28B3A37965F3E248886D681651EA3D8A85D8396A`。

## 未决风险

- 为避免中断 active Team，本轮没有在 live root Room 上重放需要真实 tier-1/tier-2 状态的原始反例；HMR 已加载源码，保留 live-behavior replay pending。
- tree-key clearance 仍未实现，非快进合并后即使 tree 相同也可能要求重新清关。
- `team_merge` 仍要求 destination worktree 干净；tier-0 台账写入必须在落地窗口外完成。
