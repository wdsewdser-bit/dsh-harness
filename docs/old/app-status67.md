
### ⑥ 裁定：不为清除「冻结夹具树内的 402 文件构建目录」**不开卡**（2026-09-28 · tier 0 · task-67）
- **请示**：`tests/golden/rig-batch/detached-b3a6760` **冻结夹具树内部**的 `cargo-target-isolated`（**402 文件**）是否需要 G-PROTO 出卡清除（scope `tests/golden/rig-batch/detached-b3a6760/**`）。
- **裁定：不开卡。** 理由三条：**① 收益为 0** —— 该目录 `.rs`/`.md` = **0** ⇒ **域计数 300/118 与一切聚合均不受影响**（实测 5/5 目录 `.rs`·`.md` 为 0）⇒ **删掉它不改变任何读数**。**② 它会破坏承重的不变量** —— 该目录在**冻结快照**内部，而该快照的完整性**正是由 `FROZEN_PATH_EXCEPTION_KEYS` 的正向断言（消失即红）守护的**（owner=lead-rig）⇒ **删除它的一部分 = 或者让该断言失效、或者要改动冻结树本身**，即**毁掉那个例外所保护的属性**。**③ durable 修法在生成侧**（把输出根移出被扫描域）⇒ 一旦落地，**不再产生新的嵌套 target 目录**；现有的 402 是**潜伏且无害**的。
- ⇒ **处置**：**登记为域例外（已由 lead-proto 落在 `resourceScan.domain_exceptions` + `evidence-99fb74cd`），期限挂在 durable 修法上**。
- ⇒ **一般化**：**当一个「缺陷」的收益为 0、而清除它会触碰一个由正向断言守护的不变量时，正确动作是登记例外，不是清除。** ⇒ 与「不修的缺陷代价必须记在案上」同族：**登记把代价显式化，清除却可能把不变量一起清掉。**
- **归属更正（lead-proto → lead-rig，已收编）**：lead-rig 把 `rig-stats/target-iso` 报为「别组的」—— **更正**：`tools/rig-stats/src/main.rs:1` 写「G-RIG M3-01 消费者」，`docs/GOVERNANCE.md:1535` 记 `group-rig-t21` 声明 `tests/golden/rig-batch/` ⇒ **5 个在域构建目录全在 G-RIG 一侧，无他组可路由。**
