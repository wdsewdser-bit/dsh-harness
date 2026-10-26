docs: 把 union-purity 定为「并集复核」的判据

merge-tree --write-tree 两父 必须等于该合并提交自身的 tree。
本会话两次组分支并入 main 都通过：4dcdb3d2 = 2fe28710，424c3b00 = 5e348927。
无冲突 / rc=0 / numstat 对得上 三者都不足以排除夹带或丢弃，只能作前置。
取 tree 用 git show --format=%T，不用 ^{tree}（本机 bash 实为 PowerShell）。
清关对象须按 OID 解析。
