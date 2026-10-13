# 回归测试精简：取舍分析规范（只读分析，不改仓库）

## 背景
测试根（只读）：`D:\dsh-test\.claude\worktrees\intelligent-hawking-e47cda\staging\context-runtime-unified-20261001`
全量回归 1554 条 / 270 s / 237 个 `*.test.mjs`。用户认为冗余、太慢、日志占 token，要求精简。
基线逐文件数据：`<SP>\cases.txt`（每个文件一个 `## 目录/文件 tests=N ms=M` 头，其下是每条用例名和耗时）。
SP = `C:\Users\yadaz\AppData\Local\Temp\claude\D--dsh-test--claude-worktrees-intelligent-hawking-e47cda\0b5787da-3fa6-4f4e-b301-4129b35cd33a\scratchpad`
已知：phase2–8 的文件是单条的旧脚本式测试；phase11 `platform-defects-*-pass` 是逐缺陷的原始反例；
被测插件在 `home\profiles\web\plugins\`（stage 内）；生产实际加载的插件清单见仓库根 `home\profiles\web\cordis.patch.yml`。

## 铁律（违反即判错）
1. **只读**：不改、不删、不新建仓库文件。只把结果写到你的输出文件（路径见任务）。
2. 每个缺陷的**原始反例必须保留**：用例名带 `B-nnn`、`D-n`、`§nn`、`batch`、`defect` 标记的，默认 KEEP。只有当你**读过**另一条测试，确认它对同一被测函数/同一输入/同一断言完全覆盖时，才能提 DELETE，且必须写出替代用例的「文件 + 用例名」。
3. **契约测试保留**：断言对外协议、持久化格式、权限/授权边界、崩溃恢复、并发/CAS 语义的，KEEP。
4. 提 DELETE/MERGE 必须给证据：它被什么覆盖（文件+用例名），或它测的模块已不在生产加载（引用 cordis.patch.yml 里的事实），或它只断言日志/快照文本格式。凭文件名猜测不算证据。
5. 不确定就 KEEP 并写明不确定在哪；宁可少删。
6. 「慢」只按基线耗时（cases.txt）和是否真起进程/真 git/真宿主判断；给出建议的 SLOW 归类理由（起子进程？真 git？睡眠/轮询？）。慢但属于缺陷反例的，只标 SLOW-CANDIDATE 并说明，不要自行判 DELETE。

## 输出格式（markdown，一个文件）
先写 5 行以内总览（文件数、建议 DELETE/MERGE/SLOW 的条数与预计节省秒数）。然后每个文件一段：

```
### <目录/文件名>  (tests=N, ms=M)
- 判定: KEEP | KEEP+TRIM | DELETE-FILE | SLOW-FILE | SLOW-TESTS | MERGE-INTO <文件>
- 被测: <被测模块/函数一句话>
- 理由/证据: <具体：替代覆盖的 文件+用例名 / 未加载证据 / 只测日志格式 …>
- 可删用例: <用例名列表，每条附替代覆盖>   (无则写“无”)
- 可入 slow 的用例: <用例名 + 耗时 + 原因>   (无则写“无”)
- 风险: <删了会失去什么；S0 反例是否受影响>
```
最后列「跨文件重复」小节：A 文件的哪些用例与 B 文件的哪些用例重复，建议保哪边。
