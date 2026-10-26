
**§5.14 追加（2026-09-28 · tier 0 · task-19）**

**1. 载体只能绑提交里存在的东西。** 实测反例：某包 `resourceScan.fixtures` 的 145 行是**工作树清单**，其中 23 行位于 `.gitignore:5 = /tests/golden/` 之下 ⇒ 在绑定提交 `55e91ef4` 上 `git ls-tree` = 0、`HEAD` = 0、`git log --all --diff-filter=A` **空**（任何 ref 都没加过），仅工作树存在。⇒ **含 gitignore 产物的清单，其「绑 commit 的聚合」不可复算** —— 这是绑定形态非符合的**根因**，不是它的表现。修法：清单分列 `tracked`（可 blob 寻址）与 `generated`（显式声明不绑提交），**不得混入同一个绑 commit 的聚合**。
   · 附实测：可 blob 寻址的 119 行与声明值 `size|sha256` **逐条相等（MATCH=119 / DIFFER=0）** ⇒ 声明值本身是对的，**问题纯粹在绑定**。

**2. 陈旧派生字段不得靠重写源对象来修。** 反例 = `group-rig-t3`（B-58）：顶层 `status=completed / phase=accepted / lifecycle=completed`，而 `contract.contract.lifecycle=running`、`contract.lifecycle=running`、`validation.contract*.lifecycle=running`（tier 0 自读 rev40 逐字确认）。**修它会毁掉反例**，缺陷随即隐形并静默复发；且 `task_contract_set` 必须重新供给 `acceptanceCriteria` 正文，转写差异 = 已完成卡内容损坏。⇒ **投影缺陷修在投影**；受影响卡走受准路径（直接 `team_run_lease(acquire)`，不改变任何判定输入）。**不修的代价必须记在案上**（「不修的缺陷代价必须记在案上」的**第 2 次适用**）。

**3. 「只有你能写」不等于「你必须写」。** 若写某载体的**输入形态未经证实**，正确做法是把事实登记到**可验证、人人可读的载体**（文档）上，而不是为了「只有你有权限」去赌一个未证实的 set 形态。⇒ **判别靠内容，不靠谁有权限**。

**4. 不得把「读到的输出形态」当作「被接受的输入形态」使用。** 实测：`team_v12(task_contract_get)` 返回 `{taskId, contract, validation, lifecycle}`，其中 `contract.contract` 才是契约本体（19 键）；而 `task_contract_set` 的**输入形态至今未证实**（零 `writeScopes` 的卡返回 `task-contract-invalid`；**owner-only 使组长与 tier 0 结构上都无法自验** —— 有能力试的只有「拥有带 scope 卡的成员」）。⇒ 把输出喂回输入 = 按字段清单自拼（第 104 条）。

**5. 大小写不敏感的语言里，上界变量必须取不可能同名的名字。** 实测：PowerShell 中 `$N` 与 `$n` 是**同一个变量** ⇒ 计数上界被字节数覆写 ⇒ 循环无界、作业被提升到后台。

**6. 流式解析中，`missing`/异常行也必须推进下标。** 实测：`git cat-file --batch` 的 `missing` 行未推进路径下标 ⇒ 第一条缺失之后 105 条**全部错配**，第一版报出**自造的**「DRIFT: 105」；修正后 `DIFFER=0`。⇒ **仪器错误会自造「发现」；报发现前必须先自证仪器。**

**7. 报告「我读不到 X」必须同时报「我在哪个 revision 读的」。** 实测：同一张卡 `group-rig-t3`，一个时点读不到 `contract.*.lifecycle` 的嵌套形态、另一时点读到 ⇒ 两个读数在各自时点都成立，**看似矛盾其实是时点差**（第 62 条扩用）。⇒ 否则两个不同时点的读数会被读成互相矛盾，并可能让一个**正确的**发现被撤回。

**8. 转述他人的成功实例时必须标「来源 = 他人记录」，不得写成「实测」。** 第 50 条（转述 ≠ 验证）**同样约束「引用别人的成功」**。实测：lead-world 引用 t57 owner 证据行里的 `task_contract_set` 成功记录并写成「实测」⇒ 自我撤回并立条。

**9. 改配置文件前必须逐字取原文，不得按语义重写。** 实测：`.cargo/config.toml` 的值为 `"D:\\dsh-test\\..."`（**TOML 转义后的双反斜杠**），与它**语义等价**的单反斜杠形态**字面不等** ⇒ 按语义构造的 `old_string` 找不到目标（本卡第一次 edit 即失败）。
