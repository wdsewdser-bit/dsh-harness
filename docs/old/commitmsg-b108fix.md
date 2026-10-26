docs: 更正 B-108 机制（单因子判别器被推翻）；新增占位值形态条款

- B-108：我的单因子判别器（injectionReceipt 是否存在）必要但非充分。
  G-WORLD 的判别实验：两条消息都带 receipt，一条消失一条留存，
  差异在于是否被 source=dispatch-pending 的未退休 pendingMessages 条目钉住。
  正确机制 = 两个独立状态变量；ack 只清 V1，不触碰 V2。
  自认：9/9 样本两属性共变，对两个因子没有判别力 —— 共变不是判别。

- GOVERNANCE：不得在读数返回前写出形如真实 id 的占位值。
  同日两个独立实例；形如真 id 的占位值在形态上与真 id 不可区分。
