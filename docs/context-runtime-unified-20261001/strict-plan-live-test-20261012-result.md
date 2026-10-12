# 严格计划交付这组改动的隔离验证：结果（2026-10-12）

方案与预先登记见 [strict-plan-live-test-20261012-protocol.md](strict-plan-live-test-20261012-protocol.md)。生产没有任何改动，这组改动没有部署。

## 结论

- **甲（开关关）通过。** 把 6 个插件和 3 个原生文件放进生产版本、不打开开关，真实团队照常完成任务和目标，没有出现任何新的拒绝，重启后会话能读回。为了对齐 staging 和生产而部署这组改动，在开关关闭的前提下没有看到风险。
- **乙（开关开）走不通，和预测一致。** 只打开 `deliveryPolicy.requirePlan` 而不配别的，团队把活干完了，但目标永远完成不了。组长没有谎报完成，目标以 blocked 结束。
- **一个方案里没预料到的问题。** 开关打开后，页面自动新建的空白普通会话也被写上了永久的 `requiresPlan: true` 标记。这个标记按设计是单调的，写上就去不掉。

## 甲：开关关（副本 off2）

| 编号 | 结果 | 证据 |
|---|---|---|
| A1 | 无导入失败；三个原生文件都被替换（`dsh-session` 两个模块实例都命中） | `off2/r1-host.log`、`off2/overlay-r1.log` |
| A2 | 团队完成：`sum.mjs`、`sum.test.mjs` 合入 main，任务卡 accepted，目标 `goal-0bdd83f0` complete | 组长最终报告；工作区 |
| A3 | `DELIVERY_PLAN_REQUIRED`、`GOAL_PLAN_UNBOUND`、`GOAL_DELIVERY_BRIDGE_UNAVAILABLE`、`GOAL_BACKGROUND_PENDING` 出现次数均为 0 | `off2/requests.jsonl` |
| A4 | 停掉再启动，会话内容完整读回，日志无错误 | `off2/r2-host.log`；页面 |

用了 149 个请求。

## 乙：开关开（副本 on1）

| 编号 | 结果 |
|---|---|
| B1 | 组长会话日志里出现 `native/goal-policy-required`，带 `requiresPlan: true` |
| B2 | 完成目标被拒，代码 `GOAL_PLAN_UNBOUND`；会话里写入 6 条 `native/delivery-status`，都是 `partial` + `DELIVERY_PLAN_REQUIRED`；页面显示 “Plan verification: partial” |
| B3 | 组长写了一份计划合同并尝试登记，换了四个路径，全部 `RECOVERY_PATH_DENIED`；`goal_plan_bind` 返回 `PLAN_NOT_FOUND`。它随后去读了插件源码，定位到 `planReadRoots` 为空和 `environmentRefs`、`recipeRef` 缺失这两个原因。目标在连续三轮上报受阻后被运行时标为 blocked |
| B4 | 最终状态 blocked / partial。139 个请求（off2 是 149 个） |

组长的最终报告如实写了“交付物已完成、目标因环境不可完成而 blocked”，并列出了要补的配置。没有绕过门禁，没有伪造完成。

按判定规则，这是“乙走不通”：开关不能只开不配。还缺的配置：

- `team-v12-runtime.planReadRoots`（登记计划时允许读的目录，缺省为空，`team-v12-runtime.mjs:1845`）。
- `deliveryPolicy.workspaceRoot`、`environmentRefs`、`recipeRef`、`allowedRoots`、`milestonePath`（`team-v15-delivery-source.mjs:16-17,54-58`，`team-v15-delivery-debt.mjs:29-65`）。其中 recipe 是一份严格格式的 JSON 配方，要和每个任务的检查项逐项对应。

这一条真实运行只证实了第一个缺口（`planReadRoots`）。后面几个是读代码得出的，模型没走到那里。

## 没预料到的问题：空白会话也被标记

`on1` 里有一个只有 6 行的会话（`session-8789bb24`）：页面打开时自动建的，没有发过消息，没有团队。它的第 5 行就是 `native/goal-policy-required`，带 `requiresPlan: true`。

含义：`team-v12-runtime.mjs:1890` 把“tier 0”当成团队根，但没有组队的普通会话也算 tier 0。所以在生产配置里打开这个开关，之后新建的**每一个**普通会话都会被永久标成“必须有计划”，而生产里普通会话用的 `session-plan-delivery` 根本没有登记，它们没有任何办法登记计划。我没有在这样的会话里实际去完成一个目标，“它们的目标也完成不了”是从标记和 `dsh-goal` 里的检查推出来的，不是测出来的。

这和 10-11 验收文档里“只作用于 tier-0 根”的说法不矛盾，但那句话容易被读成“只作用于团队”。

## 回滚隐患（读代码得出，未演练）

打开过开关的会话日志里会有 `plans` 为空的 `native/delivery-status`。生产现有的 `dsh-session-persistence-jsonl` 把空 `plans` 判为非法。所以一旦开关打开过，再把原生文件退回旧版，这些会话可能读不回来。开关没打开过就没有这个问题。

## 运行中的偏离和干扰

- **第一次开关关的运行（off1）作废，55 个请求。** 我用 `NODE_OPTIONS` 把替换原生文件的预加载传给宿主，结果模型在沙箱里启动的每个 `node` 子进程也继承了它，写工作区外的日志被拒，`node` 起不来。改成只对宿主进程生效的命令行参数后重跑（off2）。这是测试装置的问题，不是被测改动的问题。
- **`on1` 的请求上限用了 250，方案写的是 150。** off2 用了 149 个，门禁在最后才触发，按 150 会在看到结果之前被截断。实际用了 139 个。
- **裸 `node --test` 在收紧的沙箱里跑不了**（`spawn EPERM`）。两个副本的组长都申请过一次放宽到完全访问，我都拒绝了；它们改用 `--test-isolation=none` 验收，并在报告里如实说明字面命令没有验证过。这是我给副本收紧权限造成的，生产的默认权限不受影响。
- **`on1` 的组长中途问要不要加平台强制的验证角色**（合并到 main 必须有独立验证方的放行）。我选了加，和 off2 里组长自己选的路径一致。
- `client.js`（浏览器端多显示一行拒绝代码）没有覆盖，页面上看到的 “Plan verification: partial” 来自生产现有的界面。

## 证据位置

`D:/dsh-test/output/strict-plan-live-20261012/{off1,off2,on1}`：`prepare.json`、`*-host.log`、`overlay-*.log`、`requests.jsonl`、`home/sessions`。驱动在 `driver/`（仓库里同路径有副本）。三次宿主都已停，40124 无监听，浏览器标签已关，真实工作区 HEAD 仍是 `ab5de82`。真实请求合计 343 个。

## 我的建议

1. **不要在生产打开这个开关。** 它现在的状态是：打开就把所有新会话的目标完成堵死，而且标记去不掉。
2. **开关关闭状态下部署这组改动是安全的，但我不建议单独为它部署。** 它对行为没有任何影响，唯一的好处是让 staging 和生产对齐，而原生文件里和 PTC 的日志格式改动写在一起，要部署就得把 PTC 的格式改动一起带上。更合理的是等 PTC 那组过了门槛一起上。
3. **如果要让这个功能可用，先要改两处设计，而不是补配置：**
   - 开关的作用范围要从“tier 0”收窄到“真的有团队成员的根”，或者做成按会话名单打开。
   - 证明链要求的 recipe、环境文件、里程碑文件，对一个临时起的团队来说太重了。上午 2000 多个请求的真实团队没有登记过一个计划，这次的组长在读了源码之后也只能停下。要么给一条不需要预先配置 recipe 的轻量路径，要么承认这个功能只适用于预先配置好的固定项目。

## 后续：开关范围已在 staging 收窄（2026-10-12 21:40 UTC）

用户同意先做建议 3 的前半（收窄范围），后半（不依赖预配 recipe 的证明路径）搁置。只改了 staging，未部署。

- 改动只在 `team-v12-runtime.mjs`（web 与 headless 相同，76079319 → 41E7816F），没有动原生文件。
- 开关现在要求“tier 0、配置打开、并且这个根确有其他成员”。成员来自 `ctx.agentTeams.listMembers`，它是根自己会话日志里团队事件的投影，冷恢复后仍然正确；还在创建中或创建失败的成员不算，因为标记写上去不掉。
- 标记改由插件在三个时机写入：装配时（补上崩溃漏写的）、成员事件之后、完成目标的门禁检查时兜底。已有标记的会话行为不变，单调性保留。
- 新测试 `native-tests/strict-plan-scope.test.mjs` 6 条全过：无成员不标记且目标可完成；第一个成员出现后只写一条标记并开始拒绝；创建中或失败的成员不触发；成员离开加关掉配置后仍然拒绝；冷恢复补写且不重复；开关关闭时不变。相关的四个现有测试文件 57 条全过，清单验收测试 3 条全过。

还没做的验证：

- 全量回归没有跑，另一个线程正在占用宿主端口做生产复核，等它结束再跑。
- 没有在真实宿主里看过“第一个成员创建后标记立刻写入”。测试里的成员表是夹具。如果事件时机和推断的不一样，标记会推迟到下一次门禁检查才写，不会漏。
- 读成员表出错时按“没有成员”处理，也就是出错时不开启严格模式。这是有意的取舍：宁可漏开，不把一个普通会话永久锁死。

全量回归（21:32 UTC，补跑）：237 个文件 1554 条，1552 过、1 失败、1 跳过。失败的是 `phase6-tests/milestone-tail-delivery.test.mjs`，原因是控制面文件锁等待超时；这个测试不引用被改的插件，单独重跑两次都通过，判为时序偶发。报告在 `output/regressions/2026-10-12T21-32-54-582Z-fc0f3012/summary.json`。顺带看到一件与本次改动无关的事：这个测试的临时控制面文件建在 `D:\dsh-test\home\.team-control-runtime-<pid>\` 下，也就是生产 home 目录里，值得另外改掉。
