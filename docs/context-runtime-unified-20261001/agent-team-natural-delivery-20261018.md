# 有界自然 Team 交付试验

授权：用户于 2026-10-18 07:19:14 UTC 明确批准本次 root 与成员合计最多 32 请求、15 分钟、先到即停的新隔离试验。不是旧三小时试验重启，不授权生产或活跃 Team 变动。

试验前先要求当前 staging 全量回归通过。代码冻结以 `output/agent-team-runtime-continuation-20261018/source-inventory-v4.json` 为准。新夹具、批准计划、冻结配方和程序记录在 `output/agent-team-natural-delivery-20261018`；只允许一个正式模型尝试，不重置计数隐藏失败。

目标是一个小型只读账目审计，不是游戏或整个平台的全面验收。五条带符号整数分记录，两个 mandatory requirement：全量行数与总额、按 settled/pending/void 分类合计。root 与至多一名独立 tier-1 verifier 使用执行前从当前实际配置核实的同一 `opencodego/deepseek-v4.1-flash` 路由。凭据仅供运行时内存使用，不写入隔离凭据文件、不打印。

宿主预置已批准审计任务/租约、完整计划合同、不可修改的输入和配方，但不登记计划、不生成 proof、不提交 delivery。真实模型必须自行通过实际 SDK 注册完整计划、执行两份配方、取得独立成员实际读数、preview/commit 当前耐久交付回执，并返回可机械比对的最终数值。自然验收要求答案正确、独立子会话真实读文件、当前 delivery coverage 可交付同时成立；仅任务完成、仅测试执行或仅口头说 accepted 不通过。

限制：总逻辑请求和实际 HTTP Responses 请求双重上限 32，wall 900000ms，单响应最多 4096 tokens；禁用 llm-retry，原生 pi transport 已配置 maxRetries:0。创建第二名子成员、跨 provider、任意 shell、文件/任务/租约修改拒绝；bash 只允许两条冻结配方。所有副作用仅新隔离目录。额外工具白名单不是通用 OS 沙箱安全证明。

记录完整请求、工具结果、原生物理日志、当前 control、真实清理及只读哈希。已批准完整合同是试验输入，不算模型自行从开放需求撰写计划的证据；只读审计通过也不能替代编辑交付、长稳定性、retention SDK 强 oracle、质量成本配对或生产加载验收。失败、限额结束和未知 usage 都如实保留。

## 预分发夹具修正

初始宿主于 07:31:37.362 UTC 启动，原截止固定为 **07:46:37.362 UTC**。首轮在任何 provider 请求之前失败：验证监听器试图修改原生只读 `maxTokens`。现场 progress、请求文件缺失及独立原生 JSONL 冷读均证实 0 逻辑/0 HTTP generation 请求；保留 19 条事件和错误，不归咎模型或产品。仅停止经过命令行校验的本轮自有宿主 PID 43936；真实终态 4294967295、`hostDisposed=false`，不伪造 cleanup。

修正只限 output 验证脚本：不再修改只读请求参数，实际 wire output budget 仍 fail-closed 检查；只读输入、合同、oracle 和 staging 产品没有修改。旧 host/launcher 快照、原 manifest 与运行日志保留。准备指针版本错误亦在任何新宿主启动/模型分发前修正并保留。恢复分支 `run-r2` 使用 **同一原截止**，前次已消费 provider 0，总额度仍 32，不给新 15 分钟。这是夹具修复后的同预算执行，不是无记录重试或新增模型预算。

## 真实结果：辅助业务链成功，整轮未通过

- 无引导阶段累计 22 请求。真实 root 读了账目并登记完整批准计划；独立 verifier 真实读文件、返回相同的 5/4000/3075/875/50 整数结果。root 执行两份配方、proof 通过，preview complete。但四个实际 commit 参数漏掉 `sourceIdentity`，前三个还错误使用 `expectedSourceRevisionVector`；只有通用 CAS 拒绝，没有耐久交付回执。模型如实报告 blocked，没有谎称 accepted。`unaided-observation` 冻结了引导前原始日志、工具、请求和控制面。
- 07:41:59 UTC 仅通过正常原生 Web 输入框给一次精确字段纠错，提前向用户披露辅助性质。独立物理日志确认收到原文；不是宿主注入证明或替模型提交。纠错后两次额外模型请求完成 fresh preview、正确七字段 commit 和最终精确答案。
- 全部 **24 逻辑请求、24 实际 HTTP Responses 请求、24 terminal**，均在原始 07:46:37.362 UTC 截止之前完成，未新增一轮预算。root+verifier 两份物理 JSONL 共 328 事件，fresh 冷读 PID 47020 确认真实登记 1、execution_prove 2、preview 8、成功 commit 1，以及 verifier 实际 read 2。当前 validated receipt 为 `delivery-df79fe061e11a35db8e13ff9`。
- 业务完成之后，output 验证脚本收尾错误地对同步 void `cancel()` 调用 `.catch()`，导致宿主真实 exit 1；PID 44168 已退出、40127 释放，但 **hostDisposed=false**，没有伪造正常 cleanup。该异常属于本轮 observer 夹具，不据此宣称原生引擎崩溃。原脚本和原错误日志已被绑定，不在原地修成“本来就成功”。
- `result.json` 明确：`assistedBusinessDeliveryAccepted=true`、`unaidedNaturalAuditAccepted=false`、`teardownAccepted=false`、`scopedNaturalAuditAccepted=false`、`allSystemFeaturesAccepted=false`。94 份产物绑定，canonical 隔离记录 `natural-team-audit-20261018-a898bd54735039ac` 的 **status=failed**，fresh 进程 PID 42504 核对实际 default.json、全部绑定和当时 362/227 源码/生产哈希。failed 不被后续补丁覆盖。
- 已知 usage：input 134244、output 9069、cacheRead 797440、total 940753；24 行 cacheWrite/reasoning 未知，不当成实际零，也不换算 Codex 订阅扣减或费用。

诊断边界：审批任务只预置 canonical control，未建立完整原生任务投影，因而原生 task_get/list 返回空是这个夹具的已知不一致；不能据此认定产品数据库/权限故障。相同任务和 gate 在仅纠正参数后成功，直接证据支持“提交缺字段”，不支持模型猜测的“任务变化导致 CAS”。

随后仅在 staging 修复 SDK 字段说明与缺项错误提示，另有 `agent-team-delivery-contract-20261018.md` 和独立冻结/本地回归。原自然试验源码是 `a898bd54`，不是新提示包；没有再发模型请求或声称提示修后已经无引导自然通过。操作者辅助的有限只读审计也不替代编辑交付、开放需求计划撰写、长稳定性或完整平台验收。
