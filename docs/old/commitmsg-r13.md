docs: stage 与 done_when 的证伪标准不同；记录第十三轮 B-108/B-109 修复

- GOVERNANCE：stage 是描述（只需为真），done_when 是判据（必须可满足）。
  同一措辞在两处的证伪标准不同，不得因字面相邻而一并改。
  判别动作：问它指一个操作还是一个批次（有枚举/分步箭头者通常是后者）。
  配套：set 回执回显请求值 ⇒ set 后必须 list 回读，以 readbackEqualsRequested 为准。

- PLATFORM-DEFECTS：第十三轮修复 B-108/B-109（本会话 tier 0 入账的两条）。
  边界：focused + 全量串行回归，未在 live root Room 重放；且未重启 DSH
  ⇒ 本会话当前读数仍是修复前行为，此刻复测会读到旧行为，不得据此判修复无效或生效。
