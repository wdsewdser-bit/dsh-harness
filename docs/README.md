# dsh-v2 文档

本仓库是 DSH 团队宿主（team host）的第二次重构版本。文档按"一件事一个权威位置"组织：同一规格只在一个地方写，其它地方链接过来。

## 文档树

| 文件 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 分层、允许的依赖矩阵、事实所有权、不变量。起步读这一篇。 |
| [host-protocol.md](host-protocol.md) | 宿主协议：职责边界、公共接口、11 条不变量、协作意图、effect 协议。 |
| [modules/](modules/) | 每个 `packages/*` 一份：职责、公共接口、依赖、测试入口。 |
| [operations/](operations/) | 运行、构建切换、观察页、预算与计费账本、浏览器验收、Git Bash。 |

## 常用命令

```bash
npm test                      # 离线全量 36 个套件（runner: verification/runner/run.mjs）
npm run test:deep             # 变异与长保留测试，默认入口不跑
npm run check:deps            # 依赖矩阵、循环、深导、硬编码路径（--strict 才返回非零）
npm run check:parity -- --check   # 断言数与文件闭包不得缩水
npm run check:size            # 单行 160 / 单文件 400 的行数闸门
npm run test:browser          # 浏览器验收（headless Edge + CDP），不属于 npm test
```

这些入口的语义、参数与证据位置见 [operations/running.md](operations/running.md)。

## 三条硬约束

1. **每一种事实、每一条规则只有一个权威所有者。** 跨包只能走公共入口，见 [architecture.md](architecture.md#允许依赖矩阵)。
2. **领域写入只走共享命令执行器**（事务内 reducer）。工具、API、UI、宿主只负责把请求翻译成命令。
3. **不改弱测试。** 断言只增不减；等价改写要逐条列清单，任何减少都进 `verification/parity-exceptions.json` 并写明理由。
