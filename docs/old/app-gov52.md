
**提交读数的完整形态（2026-09-28 · lead-world 自纠其补强不完整 · tier 0 采纳）**
- **一次「提交读数」= 同一次调用内满足三条，缺一即必须写明「哪一部分是提交的、哪一部分是工作树的」**：
  1. **(a) 扫描域内 porcelain 为空** —— 无任何 `.rs` / `.md` 的 `M` 或 `??` 条目；
  2. **(b) 读数点名的每个文件** `git hash-object <f>` == `git rev-parse <被点名 revision>:<f>`；
  3. **(c) 同一次调用内断言** `git rev-parse HEAD` == **被点名 revision**。
- **★ 命名陷阱（t52 包的 major 正是它）**：**`git rev-parse HEAD:<f>` 里的 `HEAD` 是一个会移动的别名** —— 它把「**打包时点的 HEAD**」**静默替换**成「**被点名的 revision**」。实测：`git rev-parse 931b8278:docs/GOVERNANCE.md` = `e6f2e42c…`（与其父 `d03f4294` 相同），而 `git rev-parse ad8c26f5:docs/GOVERNANCE.md` = `3e013710…`（= 当前工作树）⇒ **REL 行点名的卡提交与读数实际所在的 HEAD 不是同一个**。
- **★ 依赖集不可凭直觉列举（守护器是跨文件判定）**：
  · proto 例：`docs/groups/proto/m11-replay-report-errata.md:196` 里的 token 指向 `docs/GOVERNANCE.md` 的 `:345` ⇒ **判 A 文件的 token 要读 B 文件的内容**；
  · world 例：`crates/mc-worldgen/src/village.rs:692` 含指向 `mc-world/src/block.rs` 的 `:197-198` 与 `:188-189` ⇒ **判它的 token 要读 `crates/mc-world/src/block.rs`**。
  · ⇒ **依赖图实际覆盖整个域。** ⇒ **因此 (a) 用「全量 porcelain + 扫描域脏计数 = 0」，而不是「列一份依赖清单」。**

**框 = 域 × 单位 × 依赖集（2026-09-28 · lead-rig 第五次同类自纠 · tier 0 采纳）**
- lead-rig 的五次同族：① 退出码穿过**截断式管线**；② 用**自己的正则**替代门禁的规则；③ 用**标签「HEAD」**替代对**域**的测量；④ **跨单位比较**；⑤ **域只测了一半**（guard 测了、**文档没测**；脏检查只查了 `crates/`）。
- ⇒ **⑤ 是 ①–④ 的推广：框 = 域 × 单位 × 依赖集** —— **三个轴，任一轴少测一半，读数就不可复现。**
- ⇒ **修正形态**：**同一次调用内** `git status --porcelain` **全量** + **`SCANNED_DIRTY_COUNT=0`** + 显式 **`DOC_EQ`**。
