# 回归输出约定

在 `D:/dsh-test/staging/context-runtime-unified-20261001` 运行：

```powershell
node tools/run-regression.mjs
```

局部验证使用明确路径，保留相同原生预加载、模块隔离及串行测试配置：

```powershell
node tools/run-regression.mjs --files architecture-tests/compact-test-runner.test.mjs
```

- 默认发现 native、architecture、usage、phase1 至 phase11 的所有 `.test.mjs`，没有删除或跳过原测试。
- 控制台仅输出入口数、终态统计、最多六条有限长失败摘要及证据路径。不打印通过用例、逐条插件日志、对象和堆栈。
- 每次独立保存到 `D:/dsh-test/output/regressions/<时间-随机ID>/`：`full.log` 是原生 spec 完整报告，`process.log` 是启动阶段 stdout/stderr，`summary.json` 是结构化终态和失败信息。
- 退出码同时核验实际子进程、原生 root summary 和非空测试计数；启动失败、空跑、缺汇总、取消及测试失败均不能记为成功。
- 保留调用者原有 `DSH_HOME` 等环境；隔离宿主夹具自行设置专用目录，不由日志入口改变测试语义。
- 正常验收只读取 `summary.json`。失败再按用例名定位 `full.log` 的对应片段，默认不全文读回日志或 execution-ledger.md。
- 已有历史日志和 provider 证据不删除、不覆盖。不为整理输出重跑已经通过的 provider 实验。

自测包含两次各1200项原生子进程成功/失败、50KB 噪声保存、环境继承及控制台长度限制；完整回归仍使用原有测试，不由测试入口总数推断用例总数。真实1220项回归已经通过此入口执行；回归结果与输出机制验收分开登记。
