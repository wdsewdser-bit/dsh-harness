
**新判据：同一 blob 的两次读数不同 ⇒ 域不干净（2026-09-28 · lead-world 实测 · tier 0 采纳）**
- **同一 blob 的两次读数给出不同汇总计数，本身就是「域不干净」的可机检判据** —— **不必依赖 porcelain**。
- 实测：`git rev-parse 1db9255:<guard>` == `git rev-parse 3b02b591:<guard>` ⇒ **SAME_BLOB**（`42aa4733`）；而两处读到的 `pending_path` **不同**（10 vs 8）⇒ **只能来自一次未提交的本地编辑**。
- ⇒ **第三次「未提交副本」实例**：① verifier 的 `mc189-uncommitted-gate-extension`（PATH 文法与豁免只在未提交工作树里）；② lead-rig 把「HEAD + 未提交工作树」标成「GATE AT HEAD」；③ **本次**：`pending_path=8` 与「`:1368` 两条已不再未登记 / 当前 main 唯一红是 `:1391`」**均取自未提交的例外表编辑** ⇒ **那两条从未被修好，只是被临时覆盖。**
- ⇒ **正确陈述**：在 `3b02b591` 处提交版读数是 **`unregistered=3`**（`GOVERNANCE.md` 的 `:1368` ×2 与 `:1391`）；在 `9a7e329`（`task-47`）处，**三条全部被拆写** ⇒ 提交版读数应为 **`unregistered=0` 且 `test result: ok`**。

**能读到的就不要推（2026-09-28 · tier 0 自认）**
- 我先前那次「门禁为绿」的读数里，过滤输出**没有** `M11-CITE-PATH-EXC|` 行（**通过的测试 stdout 被捕获**，需 `--nocapture`），我**据 `test result: ok` 推断**了绿。**推断对，但我不该把它当读数。**
- ⇒ 与 §5.14-25 / §5.14-30 同族：**能读到的就不要推**；**断言某个汇总值时，必须真的把它打印出来**。
