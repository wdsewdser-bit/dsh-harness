docs: 清关的承重不变量是 tree，不是 commit（本轮最后一条）

grp/world head 由 042c1067 变 da277208，而两 tree 逐字相同 ⇒ 复核收窄而非重做，省掉一次完整 head 级复核。
纪律：commit 身份变化而 tree 不变时，不得要求重做只依赖 tree 的读数。
配套：head 级清关必须同时具名 commit 与 tree，否则该情形不可判、只能重做。
