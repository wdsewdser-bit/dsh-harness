docs: 作废一条被我自己读数否证的治理条款；入账 B-108

- GOVERNANCE 5.14：作废「控制面存储直读」作为「当前值」判决信道的实例。
  该实例对 16,500,879 B 的追加式日志做命中计数（命中 2 处）——
  命中只证明「某时刻写过该值」，不证明「当前存储值是它」。
  重启后实测：同一 revision 下 4 次读、2 种信道形状全部一致，
  contract.deliverable 已是新对象、contractRevision 4 推进到 6，故原结论错。
  精化：替代信道必须「对该问题唯一确定」，不是「恰好给出相反结论」。
  配套：deliverable 不是任务行字段（顶层恒 undefined），值在 contract.deliverable。

- PLATFORM-DEFECTS：新增 B-108（B-106 的修复只做了一半）。
  重启后第一方读数：10 条中 9 条 injectionReceipt 为 null（source:dispatch-pending），
  逐条 ack 得 9/9 返回 handled:true，随后 9 条全部仍在（清除 0 条）。
  判别器 = injectionReceipt 是否存在；对照带 receipt 的行 ack 后确实消失。
