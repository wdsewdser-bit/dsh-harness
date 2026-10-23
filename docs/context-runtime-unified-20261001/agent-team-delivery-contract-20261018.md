# 当前交付提交参数的可恢复错误提示

自然试验是起因，不是本补丁的通过证据。冻结包 `a898bd54` 上，真实模型完成计划登记、两个执行证明和独立 verifier 读数，但普通提交用了 `expectedSourceRevisionVector` 并漏传 `sourceIdentity`。四次只得到同一通用 CAS 冲突，模型如实报告未交付。操作者一次准确字段纠错后，同一原预算内另两次请求取得真实当前 durable receipt 和正确结果；总 24 请求。无引导未通过，操作者辅助的业务链成功；output 收尾脚本另有同步 cancel 返回值错误，因此整轮 canonical 状态仍 failed，旧证据不追改。

本次授权沿用 staging 有限修复，不发任何新 provider 请求，不改生产或活跃 Team，不重启已结束的试验。

## 修改

- `team-v15-plan-delivery.mjs`：当 CAS 输入确实缺少当前绑定字段时，列出缺项、fresh preview 的精确映射、正确 `sourceRevisionVector` 名称及普通 commit 不接受单独 previewToken 的边界。保留原 `DELIVERY_CAS_CONFLICT` code，不猜值、不接受别名、不复用旧向量、不自动提交。
- `team-v12-runtime.mjs`：实际 SDK 描述和严格 root 提示共用完整七字段 commit 合同。计划登记、proof 生成、source 读回、owner/lease 和 durable outbox 逻辑不变。
- 真实红例 16 项 15 通过/1 失败，证明旧错误提示缺项；修后四文件 78/78，包括实际注册 SDK、原生 goal/delivery、缺项无写入、正确当前提交与陈旧向量继续拒绝。
- 两个 profile 同步；stage-closeout 更新既有清单和 protocol-trial pin。coupling 仅新增 `team-v15-plan-delivery.mjs: alone-ok`，所有既有状态精确不变，备份后重新登记 baseline。此导入检查不授权单独部署其余耦合模块。

当前冻结为 `7bf9d5bdb55df270720c7a60cb70549271032341c8a7702719970b436d092621`，365 源码/测试/配置载体，不是功能数；227 生产文件不变。源码冻结后未再改动。最终全量 `output/regressions/2026-10-18T07-47-31-165Z-30c51c0f` 真实 exit 0：**248 文件、1720 项，1719 通过、0 失败、0 取消、1 既有跳过**，350412ms。

备份：`backups/agent-team-delivery-contract-20261018`。证据：`output/agent-team-delivery-contract-20261018`。旧 recovery 158 产物和自然试验 94 产物保持各自原哈希及 canonical passed/failed 含义；本补丁不会把无引导未过或收尾失败洗成通过。

边界：新提示只经过本地/原生测试，未再花费模型请求验证它能自行纠错。开放需求独立写完整计划、自然编辑交付、retention SDK 强 oracle、长稳定性、当前配对质量成本和生产加载/回滚仍不在本次关闭范围。

最终 `result.json` 绑定 28 份直接产物并引用两份原报告；独立进程 PID 41368 同时读回三个真实 canonical，并核对当前 365/227 与历史 158/94 绑定产物未改。当前记录 `agent-team-delivery-contract-20261018-7bf9d5bdb55df270`、status=passed、fingerprint `4e50cd37a0b8b930ff6c359a7c0e6f8d19a0d5b418f3addeb7b5290a853f198b`；恢复记录仍 passed，自然整轮记录仍 failed。当前 `scopedFixAccepted=true`，`allSystemFeaturesAccepted=false`、`unaidedNaturalDeliveryAccepted=false`、`productionDeployed=false`，续修 provider 请求为 0。
