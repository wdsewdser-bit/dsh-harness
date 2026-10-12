# DSH 平台缺陷批次 209–222 修复结果

本轮按最新清单处理批次 209–222，并收口平台请求第 3/4/5/6 号。

## 结论

- 第 3 号 `-File` 写面门：**live verified**。运行实例的三臂结果与源码一致：已批计划写面内的受制裁 `-File` 脚本允许执行；越 scope 脚本 fail-closed 且诊断具名；缺失脚本 fail-closed。批次 205 的“未生效”结论已撤回，原两臂探针无判别力。
- 第 4 号 world 组零产出：root 缩短超大 deliverable 的 workaround 已 live verified，同一组长随后产生持久效果。平台源码修复仍为 `fixed / focused-verified / original-counterexample-replayed / live pending`，因为当前 PID 31528 早于写入。
- 第 5 号 completed 卡已批计划不可绑：**no platform change，原前提被反例否证**。新增隔离测试证明 completed edit 卡可直接重新 `acquire` 仍为 `plan-approved` 的计划，无需 `reopen`；卡状态保持 completed，phase 不回退。
- 第 6 号后台作业不跨 turn：**fixed / focused-verified / original-counterexample-replayed / live pending**。Agent 在 turn 间回收但 Session 仍存活时保留 running job；Session 真正销毁或归档时才取消、等待 settlement 并删除。未采用不命中触发点的 TTL 延长。

## 验证

- 第 39 个原始反例：`2/2 pass`。
- 第 40 个原始反例：`1/1 pass`。
- platform-defects 聚焦集：`219 tests / 219 pass / 0 fail / 0 skipped`。
- phase1-phase11 串行全量：`540 tests / 539 pass / 0 fail / 1 skipped`。
- profile parity：`1/1 pass`。
- `dsh-jobs-local` 与两份新反例 `node --check`：`3/3 pass`。
- 四个 pnpm 物理副本的 `dsh-jobs-local/lib/index.js` 均为 size `41588`、SHA256 `DB57F8DA66BFE2B8D0AD71CCA8EAEBC10946A2FF4DFA0F8C2E40F7A9347EB110`。

## 约束与风险

- 未重启 DSH，未中断 active Team，未清理 backups/spill/telemetry/session，未修改 RustMc 产品仓。当前 DSH PID 31528 / 端口 40123 保持。
- 第 4、6 号的源码修复仍需后续进程加载后才能 live 复核。
- 批次 220–222 的 D-01 谓词、delta 复扫、端口避让和标本保护属于 RustMc/Team 运行纪律，没有新增 DSH 平台代码修改。

清单最终指纹：size `1495015`，SHA256 `2686B59030C0832E64C8AEE25E8EF135FCB55C9A5C600A63763D1C5D1C5E0B3E`。
