# 原团队执行循环隔离续接

## 授权与限制

2026-10-18 06:49 UTC 一次性 heartbeat 续跑，已核对 Codex 五小时使用 0%、每周使用 25%，原自动化已暂停。仅允许 staging 与新的隔离证据；外部 provider 请求上限为 0。没有修改生产、活跃团队、游戏、原始日志或旧绑定报告，没有重新启动旧三小时试验。

本轮起点为上轮 `70522bda89749b05ade31faa724a18497d7a4a66c2410c08c88cfe67c1fd506d` / 359 载体、全量 1698 通过、0 失败、1 跳过。之后确有产品代码变更，以下保留探索经过，最终结果见文末，不把起点回执当成当前回执。

## 新确认的前提

原三小时试验最终 control 中的任务全部为 completed 或 deleted，没有可以安全继续的旧未完成任务；原租约也为终态。不能复活已删除卡、延长终态租约或创建新探针来声称原任务续跑通过。

本轮补充原先缺失的真实 Agent 执行 loop 证据：复制原 11 份物理日志和原 control/冷数据文件到新隔离 home，使用真实 runProfile、agent factory、Team mailbox 和 ToolRuntime。以本地确定性 adapter 替代原 provider，不发外部请求；通过原生消息恢复原成员，读取原组板和旧卡，尝试终态租约 heartbeat 应拒绝。该证据不等于自然模型理解、历史游戏质量或旧未完成任务继续执行。

读取期间有额外严格工具白名单，仅本轮 run_code 与任务读取/终态租约负例允许；历史 pending 文件或 shell 副作用不授权。原日志携带的 sandbox 元数据与实际执行能力必须如实披露，不能把这个测试白名单称为通用 OS 沙箱验收。

## 运行记录

- 输出目录：`output/agent-team-runtime-continuation-20261018`。
- 每次复制前后核对 359 当前载体、227 生产文件、原日志及 control 哈希。
- 运行限额：最多 64 个本地 adapter 请求、240 秒，外部请求 0；持久化 manifest 在宿主运行前登记。
- 第一轮真实退出 1，宿主已 disposed：新增验证程序未声明返回值中的 board 变量，且没有安装本轮 native receipt bridge。旧源代码、原日志、原任务不变；该失败和脚本副本保留，不算产品缺陷。
- 第二、三轮真实退出 1 并正常清理，暴露产品缺口：宿主的 continuable residency 会卸载空闲组长。即使先通过原生 mailbox 唤醒过全员，稍后二级成员执行时组长也已不在 agents/sessions 中；只看已加载日志的恢复逻辑仍丢失 group。保留 25/25 次本地请求、原始失败与第三轮现场诊断，不当作模型能力问题。
- 修复仅限 `team-policy.mjs`：在 agent created/pre-step 通过原生 persistence 的短期 read handle 读取已验证的同 Team 组长日志，只采用原匹配的服务端 spawn 回执；以原生 stat revision 缓存精简回执，变化时重读，并发共享读取，handle 始终关闭。外来/缺失/失败/冲突/继承前缀回执不授予权限，不唤醒组长，不新增权限侧文件。29 项聚焦通过，覆盖停驻、版本变化、读取/关闭失败、并发和原有防伪负例。
- 当前冻结 `af7ec848dd23312b598caf90d3b3892cb708aabd7531d18e988faed4f985b07c`，359 载体中仅 web/headless policy、该聚焦测试和插件清单 4 文件改变；两个 profile 同步，coupling check 仍通过。生产 227 文件不变。
- 修后首轮 37 本地请求中，11 个真实 loop 的读取和终态租约负例已完成；夹具最后对已卸载成员取 `.session` 导致收尾退出 1，正常 disposed，全部原始证据保留。这是新收尾夹具错误，不是再次推断产品故障。
- 最终宿主 `run-2026-10-18T07-07-23-601Z` 真实退出 0、disposed；37 本地请求、0 外部请求。10 名旧成员通过原生消息冷恢复，11 个 loop 均实际执行 SDK 工具，原 tasks/leases 精确相同、原日志和 control 哈希不变。另进程原生 JSONL/Session 冷读 11 份日志、21120 事件，通过真实 durable tool effect 和 PTC 子调用校验；不只检查文件存在。
- 整包回归运行中，结果待真实终态，不提前写成通过。

## 自然模型验收准备

旧三小时预算已结束。本协议原团队副本的外部请求始终为 0。用户于 07:19:14 UTC 明确批准另一次新隔离自然试验：根与成员合计最多 32 个请求、15 分钟，任一上限即停。该试验独立登记在 `agent-team-natural-delivery-20261018.md`，不能把本地确定性续接改称自然模型证据；没有新增定时循环。

建议只选择一个小型、独立、可机械判定的需求集，验证真实模型自行通过 SDK 登记完整计划、执行、证明并提交最终交付。所有本地 oracle 与配方先冻结，根及后代统一计数，usage 未知保留未知；不得用宿主事后注入 accepted 或改弱 oracle 使其通过。生产部署、原活跃团队迁移和完整质量/费用 A/B 仍不在授权范围内。

## 最终冻结与登记结果

- 停驻组长恢复修复后的首轮全量为 1713 项：1709 通过、3 失败、1 跳过。三个既有纯 policy 测试传入 `{}`，新监听器未检查 `ctx.on`；补齐能力检查后保留原测试，三文件 36/36 聚焦通过。旧红例、各次夹具错误及原日志均保留。
- 实际 V2 宿主在定时工具安装与原生成员创建并发时以 `HOST_WRITER_BUSY` 突然退出。只读检查确认 11 份隔离日志均可原生恢复、端口释放、原始文件与生产不变；该次 `hostDisposed=false`，不伪造正常 cleanup。`fatal-terminal-observation.json` 为真实终态的操作者记录，`fatal-observation.json` 为独立原生日志核查。
- 第二个产品修复只在 `team-tools-v2-r10.mjs`：30 秒安装 sweep 经原生 host lifecycle gate 的异步 writer 排队、合并重复 tick，dispose 后不执行排队中的安装，错误仍向调用方传播。四个真实 gate 并发测试先全部红、修后全绿；没有吞掉原生 writer 错误或放宽 sandbox。
- 最终冻结 V4：`a898bd54735039ac8b30e8463adac3d23e09fc98b53aee2c15e2570ad44bb3b1`，**362 个源码/测试/模板载体**。V1/V2/V3 清单保留；V4 增补实际被 closeout 更新的 lab-template pin。web/headless 同步，coupling check 通过，生产 227 文件不变。没有把载体数当成功能数。
- 当前 V4 实际宿主 `run-2026-10-18T07-23-43-229Z`：真实 exit 0、host disposed，37 本地请求、0 外部请求；10 名成员从原生 mailbox 冷恢复、11 个真实 SDK loop 全部完成。task/lease 精确不变，原 11 日志和 1772 control/sidecar 文件不变。
- 独立进程 PID 39184 冷读当前 V4 的 11 份物理 JSONL，真实 durable effect/PTC 子调用均存在；隔离 credential 审计通过，没有外部凭据复制。
- 最终全量 `output/regressions/2026-10-18T07-25-18-820Z-edaa514b`：**248 文件、1717 项，1716 通过、0 失败、0 取消、1 既有跳过**。真实运行 exit 0，347390ms；不是仅看进程或预期计数。
- `result.json` 绑定 158 份产物，`scopedRecoveryAccepted=true`，`allSystemFeaturesAccepted=false`、`originalTaskAcceptance=false`、`naturalModelAcceptance=false`、`productionDeployed=false`。各次本地尝试累计 176 次 adapter 调用，失败不从统计删除。
- 已通过既有 canonical 注册器写入本输出专属 `evidence-home`，id `agent-team-runtime-continuation-20261018-a898bd54735039ac`、status `passed`、fingerprint `cc55925d78604f47d73506a4b435b30d72b7e659b98758649994b06f726fcc37`。独立进程 PID 7856 读回真实 `default.json/v12Evidence.records`，核对全部 158 产物、362 当前载体和 227 生产文件。

边界仍在：旧控制面所有 22 卡均为终态，没有可安全续跑的旧未完成卡；不能复活 deleted/terminal 工作来凑验收。新增的是原 11 个执行 loop 的只读续接证据，不是原整队自然编辑继续执行、长稳定性、通用 OS 沙箱或生产加载验收。原长试验 failed 记录不改写。
