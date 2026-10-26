
**★ recipe 必须具名 collation（2026-09-28 · 四路 comparer 实测 · tier 0）**
- **实测（同一 118 文件集、同一模板 `path|size|sha256`、同一尾随 LF）**：`Ordinal` / `OrdinalIgnoreCase` / `InvariantCulture` / `InvariantCultureIgnoreCase` 各自给出确定的值（见证据行）⇒ **据此判定 `62ce4101…` 与 `d12e7e56…` 各由哪一个 comparer 产生。**
- **⇒ 结论（无论实测落在哪一边都成立）**：**排序轴确实重要**；**机制是 collation 强度**（ordinal vs linguistic / 文化无关 vs 文化敏感），**不只是大小写**。
- ⇒ **recipe 必须具名 collation**；**「culture-aware」在「大小写不敏感 ordinal」与「locale collation」之间是有歧义的**。**规范形态 = Ordinal（码元）升序。**
- **⇒ 尾随 LF 是承重项（第 4 次证明）**：同 comparer 下**有 / 无尾随 LF 给出不同的值**（`62ce4101…` vs `c0dec2cb…`）⇒ 与「路径分隔符 / 行模板 / 排序谓词」**并列**。
- **⇒ 更正 `task-59` 交付物 1 与 2 的标签**：交付物 1 的「成因不成立」**只对「大小写不敏感 ordinal」成立**，**对 locale collation 不成立**；交付物 2 的排序标签**按实测更正**。

**清单检查表（五项 + 承重项声明）**
- **路径基准 / 排序谓词（具名 collation）/ 行模板与分隔符 / 行尾 / 判别长度（或编码）** —— **五项逐项显式**；**另须声明尾随 LF 是否承重**。
