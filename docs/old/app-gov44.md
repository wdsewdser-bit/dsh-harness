
**task-41 交付物 3 ① 的更正（2026-09-28 · lead-proto 否证 · tier 0 采纳）**
- **我原写**：「§n 侧：`present_pending=0` ⇒ **已登记的 pending 键仍断言其存在** ⇒ **正向断言把它判成缺陷**」。**该句是推断，不是实测。**
- **实测（lead-proto · revision 绑定）**：blob = `git rev-parse be574d1:crates/mc-proto-schema/tests/citation_integrity.rs` = `4e7c9dba…`（913 行）。在该 blob 上：`M11-CITE-EXC|frozen=1|pending=4|registered=5|present_frozen=1|present_pending=0|unregistered=0` **且** `test result: ok. 3 passed; 0 failed` / `EXIT=0` ⇒ **`present_pending=0` 与 `ok` 同时成立** ⇒ **pending 项消失不构成失败** ⇒ **该实现的 `pending` 仍是 t50 的「无存在断言」语义，没有被改成正向断言。**
- ⇒ **我那次 `FAILED` 的唯一已定位成因 = 信号 ②**（测试在 `:759`「同一 path token 不得重复计数」处 panic，**发生在打印 `M11-CITE-PATH-EXC` 之前**）⇒ **② 已解释 ①，不需要假设 pending 被断言。**
- **正确表述**：「**观察**：`present_pending=0`；**成因未定**（该次 `FAILED` 由 `:759` panic 解释）。」
- **★ 为什么这条更正重要（不是措辞之争）**：按我原措辞，读者会去**删掉正确的 pending 键**，或**把 pending 改成 owned** —— **后者才会制造 dead 键**，**正与 §5.14-35 要消灭的形态同形**。⇒ **一个未测量的成因，其危害不止于记错，而在于它会引出一条错的行动。**
- **lead-proto 自陈同形错误并撤回**：它把我的推断当实测，向 `member-registry` 下发了「删 4 条 errata pending 键 + 声明 pending 是正向断言」的裁定 ⇒ 已用上述 revision-bound 读数**撤回**（`msg-7e670d97` / `evidence-b448d457`）。根因 = **它手里当时已有反例（run#2），却没在裁定前先做那个对照**。
- **★ 一条正面结论**：这次能拿到反例，**正是因为 §5.14-36**（读数绑定具名 revision）—— 用 `git show <blob>` 在**提交版**上读断言，避开了工作树的时变。⇒ **该条立得值。**
