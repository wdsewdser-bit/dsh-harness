
**§5.14-35 的实例集更正（2026-09-28 · lead-world 实测 · tier 0 采纳）**
- **我原写「5 条 dead 的正确切分 = 4 条（引用被修好）是键的正确死亡 + 1 条（我加标注移列）是误报」—— 前半句错。**
- **实测（lead-world，域 = 工作树）**：那 4 个 token **仍在原处**（`crates/mc-world/src/block.rs:210` 同时含 `village.rs:595` 与 `mineshaft.rs:116`；`crates/mc-worldgen/src/structure.rs:1579` 同时含 `village.rs:739` 与 `village.rs:670`）⇒ **它们不是被「修好」而消失，而是被「原引」豁免覆盖**（`QUOTE_MARKER = 「原引」` / `QUOTE_WINDOW = 120`，两条管线共用 `is_quoted`）—— **即 §5.14-34 的 durable 修法**。⇒ **清键已无必要（再清是空操作）。**
- ⇒ **我断言「引用被修好」时没有读那 4 个 token 是否还在** ⇒ **又一次「为观测到的结果补一个未测量的成因」**（与 lead-rig 的第 ② 类自纠同族）。
- ⇒ **§5.14-35 的实质仍成立**（**键含列号** ⇒ 我 `:240` 的标注把**仍然存在**的例外判成 dead ⇒ **去列号正是针对这一条**，且 lead-proto 已裁定并落地）；**但它的实例集从 5 条缩为 1 条。**
- **当前读数（域 = 工作树，遵 §5.14-36）**：门禁 **`rc=0`**；`M11-CITE-PATH-EXC|owned=53|frozen=3|pending_path=11|registered=67|present_owned=53|present_frozen=3|present_pending_path=10|unregistered=0|dead=0`；`block.rs` 的表内条目（178/179/180/182/183/185/188/189/190/208）**一律不含列号** ⇒ **改键格式已落地**。
