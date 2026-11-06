# 架构

本文是分层、依赖与事实所有权的**唯一权威规格**。来源：早期设计文档 的 08、08a、13 号文档，以及当前代码（`verification/check-deps.mjs`、`packages/*`）。协议细节在 [host-protocol.md](host-protocol.md)；每条决策的来龙去脉见内部设计记录。

## 1. 分层

```text
contracts    id / 错误码 / schema / deadline / 端口类型 / digest / 工具定义        （无依赖）
   ↑
store   context   adapter-dsh    SQLite 事务、预算、上游版本适配                  （只依赖 contracts）
   ↑
core         纯领域规则与命令 reducer：组织、调度与租约、消息/线程/wait、goal 规则、
             交付状态转换、协作、快照内容生成                                   （contracts）
   ↑
delivery     Git、worktree、verifier 子进程等 IO 与恢复适配                      （contracts + core 端口类型）
   ↑
host         应用服务与唯一驱动：周期、effect 路由、定时、pre-step/请求边界、恢复、
             写命令网关                                                        （下行全部）
   ↑
projections  只读投影与 HTTP/SSE 读接口                                          （contracts、core 只读、store 只读）
   ↑
ui           浏览器端，只走 HTTP
   ↑
profiles     组合根：生成 patch、装配端口、固定插件顺序
```

- `packages/ptc-boost` 是上游插件叠层（纯 `.js`），**不在**模块矩阵内，check-deps 不扫描它。
- 依赖方向不是"目录好看"：它对应 [host-protocol.md](host-protocol.md) 的不变量 1（唯一驱动所有者）与规则 2（写入只走命令执行器）。

## 允许依赖矩阵

下表与 `verification/check-deps.mjs` 的 `MATRIX` 常量**逐行一致**，改表必须同时改代码，反之亦然。

| 包 | 允许依赖 | 备注 |
|---|---|---|
| `contracts` | 无 | 纯类型与规则常量，含 `GATE_RATIO = 0.75` |
| `core` | `contracts` | 领域 reducer，不碰 IO |
| `store` | `contracts` | SQLite、事务、事件日志、outbox |
| `context` | `contracts` | 预算、75% 闸门、artifact、gc、折叠 |
| `delivery` | `contracts`、`core` | 只用 core 的端口类型 |
| `adapter-dsh` | `contracts` | 上游 API/事件/executor/shell/session 的版本适配 |
| `host` | `contracts`、`core`、`store`、`context`、`delivery`、`adapter-dsh` | tool-guard 折在 `host/src/guard/` |
| `projections` | `contracts`、`core`（只读）、`store`（只读） | 只保留读接口与端口调用，写命令归 host |
| `ui` | 无 | 运行时只走 HTTP |
| `profiles` | 全部 | 组合根 |

### check-deps 实际执行的规则

`npm run check:deps`（默认只报告，`--strict` 才返回非零）依次检查：

| 规则 | 内容 |
|---|---|
| (a) | `packages/**` 不得导入 `verification/` |
| (b) | 跨包导入必须走对方公共入口（`packages/<pkg>/index.mjs` 或其 `package.json` 的 `exports`），深导即违规 |
| (c) | 源码不得硬编码盘符绝对路径（构建路径走 `build/builds.json`）；测试夹具豁免 |
| (d) | 源码不得导入测试模块（`/test/`、`/test-support/`、`*.test.mjs`），测试可以导入源码，测试之间也可以互相导入 |
| (e) | `exports` 不得暴露测试模块 |

另外两项结构检查：**matrix**（上表）与 **cycles**（包级导入不得成环）。两者**只看源码**（按 `/test/`、`/test-support/`、`*.test.mjs` 区分），测试只禁用深导。豁免写在 `verification/dependency-policy.json`，每条必须有非空 `reason`，且豁免只对 matrix 生效——循环检查始终用完整源码图，豁免掩盖不了环。

## 事实所有权

"唯一写者"指每类事实唯一的权威提交入口，不是宣称一个库能原子提交整个宿主。

| 事实 | 唯一权威写者 / 持久位置 | 不得冒充的事实 |
|---|---|---|
| 原生 agent 实例、parentAgent、活动/取消/销毁、Session ID | 上游 agents/agent-loop；原生运行态与 Session 日志 | Team 的 desired 状态不等于已停止；不复制原生 roster 作生命周期权威 |
| Session 原文、tool call/result、surface、压缩提交、原生 goal phase | 上游 session writer | `store` 只记 ref/seq/观察游标，不能写回整份 Session |
| 成员身份、角色、组织、期望状态、绑定 generation | `core` 组织规则 + `store` 的 members/bindings | observed running 是上游投影，不由看板状态推断 |
| requirement/task、合同批准、assignment、attempt、lease、写域授权 | `core` 的单一事务入口 → `store` | 协调者只能提交意图，不能自己开 run |
| mailbox 正文、责任归属、三级确认、广播订阅 | `core/mailbox.mjs` → `store` | inbox/inserted 不是耐久已处理 |
| 决策问题、提案、答复、结论、截止责任 | `core` 线程命令 → `store` | 不从聊天摘要里提取并覆盖正式结论 |
| 类型化依赖与解除原因 | `core` → `store` | 自由文本"等一下"不自动成为调度阻塞 |
| artifact 原文、hash、ACL、保留/过期 | `context/artifact-store.mjs`，不可变文件 + 元数据 | 截断文本或模型摘要不是原始证据 |
| budget 计量与 policy 许可 | `context/budget.mjs`（唯一实现）与 `context/policy.mjs`（只转述结论） | 缺 usage / cache-write 不解释为零 |
| 验收证书、合并授权、外部操作回执 | `delivery` | produced、verified、merged、accepted 不能混报 |
| 实际 Git refs、commit/tree、worktree 内容 | Git 仓库本身；`delivery` 是唯一受管变更入口 | ledger 的"合并成功"必须与实际 ref 对账 |
| 看板、root 摘要、统计、UI/检索 | `projections`（可删除重建的读模型） | 不允许从投影修复写回权威状态 |
| 跨进程已花 token 与预留 | `verification/real/budget.mjs` + `runs/real-budget.json` | 这是测试侧台账，不是产品预算规则；两者不可合并（内部设计记录 0005） |

## 不变量

11 条不变量写在 [host-protocol.md §3](host-protocol.md)，每条都有故障验收。概括：

1. 只有一个驱动所有者（按团队计算）
2. 不重入，也不丢唤醒
3. 事务不跨越 await
4. 续租不能复活旧授权
5. unknown 不释放冲突资源
6. 效果不盲目重试
7. 恢复先于 admission，但不能被完成栅栏锁死
8. 可见性必须来自真实请求载荷的证据
9. 停机可等待，错误可观察
10. 游标不能消费自己产生的事件
11. 团队跟随会话，多会话互相隔离

## 首批准则的最终口径

这四处曾有两种写法，现已定稿（细节见各自的决策记录）：

| 主题 | 最终口径 | 决策 |
|---|---|---|
| 基线版本 | 0.2.2-alpha.2 的 C1 build；`buildTarget()` 是唯一版本判定点，支持矩阵只有一个组合 | 0001 |
| "C3"这个名字 | 只指 instant-preempt 补丁（registry `id: C3`）；08 里那个"独立注入通道补丁"已作废，改称 I-inject | 0002 |
| 压缩策略 | 两层，互不替代：原生安全压缩（`thresholdRatio: 0.75`）+ 可选步骤折叠（`inputBound ≥ 200000` 且持证书，当前无证书即不启用） | 0003 |
| 输出预留（358k） | 闸门只看输入（`I ≥ 0.75W` 即拒）；输出上限 `min(358000, W − I)`；预留 `max(65536, bytes×4) + 该次上限` | 0004 |

## 代码规约

- 单行 160 字符、单文件 400 行是**新增代码**的约束（`npm run check:size`）；超出要写明理由才能豁免。
- 用来定位环境的常量（构建路径、端口、shell）走配置（`build/builds.json`、`DSH_BASH_PATH`），不写进源码。
- 一次性脚本进 `verification/archive/`，默认测试不扫描该目录（`check-archive` 守住这条）。
- 行为合同变了就同一次提交更新它唯一的权威规格，不留到最后补。
