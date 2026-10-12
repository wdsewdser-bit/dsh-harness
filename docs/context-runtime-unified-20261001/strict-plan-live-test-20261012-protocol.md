# 严格计划交付这组改动的隔离验证：方案与预先登记（2026-10-12）

用户 14:36 UTC 回复“可以”，对应我提的建议：先在隔离副本上验证 staging 里“交付计划”那组 Team 改动。只验证，不部署。本文件在发出第一个模型请求之前提交。

## 先更正我之前的说法

我之前说这是“三个插件必须一起上”。核对之后不准确：

- 这组改动（2026-10-11 的 strict plan delivery）是 **6 个插件 + 4 个原生文件**。插件：`team-v15-delivery-service`、`team-v15-delivery-presentation`、`team-v15-goal-delivery`、`session-plan-delivery`、`team-v12-runtime`、`team-tools-v2-r10`。原生文件：`dsh-goal/lib/index.js`、`dsh-session-persistence-jsonl/lib/index.js`、`dsh-session/lib/index.js`、`dsh-client-ui-chat/lib/client.js`。耦合审计只查导入能否解析，所以只报出了三个。
- 原生文件里，这组改动和 PTC 后台包的日志格式改动（`native/ptc-job`）写在同一批行里，拆不开。没有 PTC 插件时这些行不会被触发。
- 这组改动是**开关式**的：`team-v12-runtime.deliveryPolicy.requirePlan` 和 `session-plan-delivery.requirePlan`。生产配置里两个都没有，`session-plan-delivery` 在生产配置里根本没有登记。所以“开关关着部署”预期对行为没有影响，只是让 staging 和生产对齐。
- 这组改动此前只用固定脚本的假模型验证过（15 个请求，0 个真实请求）。真实模型从没走过“登记计划、出证明、提交”这条路。上午那次 2000 多个请求的真实团队运行，控制面里登记的计划数是 0。

所以要回答的是两个不同的问题。

## 两个问题

**甲（开关关）**：把这组改动放进生产版本、不打开开关，团队行为是否和现在一样。这决定“为了对齐而部署”是否安全。

**乙（开关开）**：对团队根打开 `requirePlan` 之后，真实模型能不能走通。这决定这个功能本身是否可用。

## 做法

新建两个隔离副本，`output/strict-plan-live-20261012/off1` 和 `on1`，从当前生产复制：

- 插件：上面 6 个用 staging 版本覆盖，其余是生产版本。
- 原生文件：副本的 `app` 仍是指向生产的只读链接；宿主启动时用一个加载钩子把 `dsh-goal`、`dsh-session-persistence-jsonl`、`dsh-session` 三个文件的内容换成 staging 版本，并记下每次替换。`client.js` 是浏览器端静态包，钩子换不了，本次不覆盖（它只多显示一行拒绝代码，10-11 已用浏览器看过）。
- `on1` 的配置里给 `team-v12-runtime` 加 `deliveryPolicy.requirePlan: true`，其余不动。不额外配置 `recipeRef`、`allowedRoots`、`milestonePath`，因为要看的就是“只打开开关”会怎样。
- 权限仍收紧为只能写副本工作区；生产文件签名守护、导入失败自动停止照旧。
- 两个副本用同一条任务，在组长会话里发，原文：

> 请组建一个两人团队（你加一名开发成员）完成这件事：在工作区根目录新建 `sum.mjs`，导出 `sum(a, b)`，返回两数之和；再新建 `sum.test.mjs`，用 `node --test` 写三个用例并跑通。完成后设定并完成目标，向我报告。

- 上限：每个副本 150 个请求、40 分钟。两个副本先后跑，不同时。

## 观察项

| 编号 | 副本 | 观察什么 | 怎么取 |
|---|---|---|---|
| A1 | 两个 | 宿主启动无导入失败；三个原生文件都被替换 | 宿主日志、替换记录 |
| A2 | off1 | 任务是否完成，目标是否能完成 | 工作区文件、会话日志 |
| A3 | off1 | 是否出现 `DELIVERY_PLAN_REQUIRED`、`GOAL_PLAN_UNBOUND`、`GOAL_DELIVERY_BRIDGE_UNAVAILABLE`、`GOAL_BACKGROUND_PENDING` | 请求记录、会话日志 |
| A4 | off1 | 停掉宿主再启动，会话能否正常读回 | 第二次启动的日志 |
| B1 | on1 | 会话日志里是否出现带 `requiresPlan: true` 的 `native/goal-policy-required` | 会话日志 |
| B2 | on1 | 组长第一次尝试完成时是否被拒绝，拒绝代码是什么 | 请求记录里的工具结果 |
| B3 | on1 | 被拒绝之后组长做了什么：登记计划、出证明、提交；还是反复重试、放弃、或向用户谎报完成 | 请求记录 |
| B4 | on1 | 最终状态：accepted / partial / 无结论；用了多少请求（对照 off1） | 控制面、用量记录 |

## 我的预测（先写下）

- 甲：通过。A2 完成，A3 为 0，A4 正常。
- 乙：B1、B2 会出现。B3 我预测**走不通**：只配了开关而没有配证明所需的 recipe 和允许目录，模型即使登记了计划也拿不到可接受的执行证明，会停在 partial，或者在拒绝上打转。若它走通了，说明我对证明链的理解有误，要回头读代码。

## 判定规则（看到结果后不改）

- **甲通过**：A1–A4 全部满足。此时这组改动在开关关闭状态下可以部署。
- **甲不通过**：任一不满足。不建议部署，先查原因。
- **乙走通**：最终 accepted，且拒绝次数不超过 3。
- **乙可用但费劲**：最终 accepted，拒绝次数超过 3，或请求数是 off1 的两倍以上。
- **乙走不通**：到上限仍未 accepted，或组长在未被接受的情况下向用户报告完成。此时结论是“开关不能只开不配”，并写明还缺什么。
- 样本是每个副本一次运行、一条很小的任务。它能证明“会不会坏”，不能证明“大任务下表现如何”。

## 提前停止的条件

守护触发；达到上限；导入失败；同一个拒绝连续出现 5 次且两次之间没有新的工具动作；已得到 accepted。

## 启动前补充（仍在第一个模型请求之前）

两个副本已建好并各做了一次不发请求的启动自检：无导入失败，三个原生文件都在主线程被替换（`dsh-session` 有两个模块实例，都命中），配置解析后 `on1` 的 `requirePlan` 为 true、`off1` 不存在该键。

读代码得到的事实，支持上面对乙的预测：只配 `requirePlan` 时，登记计划要用的目录来自另一个配置键 `planReadRoots`（缺省为空，`team-v12-runtime.mjs:1845`），证明链还需要 `deliveryPolicy` 里的 `workspaceRoot`、`environmentRefs`、`recipeRef`、`allowedRoots`、`milestonePath`（`team-v15-delivery-source.mjs:16-17,54-58`、`team-v15-delivery-debt.mjs:29-65`）。这些都没配。真实运行要确认的是模型实际会撞到哪一个，以及撞到之后怎么表现。
