# 运行：测试与检查入口

所有入口都是离线脚本，没有 `npm install` 步骤（Node 24 内置模块，无第三方依赖）。`package.json` 里的脚本就是全部入口。

| 命令 | 作用 | 证据/输出位置 |
|---|---|---|
| `npm test` | 全量离线套件：`verification/runner/suites.json` 共 38 个，其中 2 个 deep 默认跳过，实跑 **36** | `verification/.scratch/<runId>/` |
| `npm run test:deep` | 只跑 deep 套件（`profiles-retention`、`profiles-mutation`：变异与长保留） | 同上，结论另记 `verification/.scratch/test-deep.json` |
| `npm run check:deps` | 依赖矩阵、循环、深导、硬编码路径。默认只报告；`-- --strict` 返回非零 | stdout，`file:line` + 规则号 |
| `npm run check:size` | 单行 160 / 单文件 400（`--scope all --strict` 检查 packages + verification） | stdout |
| `npm run check:parity -- --check` | 断言数与测试文件闭包不得低于 `verification/parity-baseline.json` | stdout |
| `npm run test:browser` | 浏览器验收，见 [browser-acceptance.md](browser-acceptance.md) | `runs/m6-browser/<时间戳>/report.json` |

## 参数

```bash
npm test -- --only=host          # 只跑一个套件（id 见 verification/runner/suites.json）
npm test -- --jobs=4             # 并行度；默认值见 run.mjs
npm run check:parity -- --print  # 逐套件打印；--explain 说明这个指标看得见什么
DSH_TEST_TIMEOUT_MS=120000 npm test -- --only=ui   # 只为诊断，临时覆盖单套件超时
```

## 一次运行会发生什么

1. **前置检查**：`assertSafeEntry` 拒绝在错误目录运行；`runs/real-budget.json` 在运行前后各取一次 sha256，前后不一致即判定失败（套件里需要 `runs/` 根的那些用**字节副本** `DSH_BUDGET_LEDGER`，永远碰不到原件）。
2. **分两阶段**：普通套件按 `--jobs` 并行；需要端口或断言操作系统行为的套件进串行阶段。
3. **判据**：退出码 0 **且** 输出里出现套件声明的 expect 标记。"零测试也算通过"会被判失败。
4. **失败证据**：`verification/.scratch/<runId>/diagnostics/<suite>/` 保存完整输出、元数据与 JSON 产物；只保留最近 5 次运行（`KEEP_RUNS = 5`）。
5. **deep 记录**：默认运行会在汇总里打印 deep 被跳过的条数，并附带上次 `test:deep` 的时间/结果；超过 24 小时没跑会提示。

## 什么时候算"改坏了"

- 断言数减少、测试文件闭包缩小：`check:parity --check` 直接失败；确属删除的必须写进 `verification/parity-exceptions.json`（`{suite, field, from, to, reason}`）。
- 新增跨包深导或回边：`check:deps -- --strict` 失败。
- 改坏 `runs/real-budget.json`：整次运行判失败，且这是硬红线（见 [budget.md](budget.md)）。

## 不要做的事

- 不要在 `runs/` 或 `reports/` 里创建测试工作区：`packages/host/test-support/helpers.mjs` 明确要求测试用独立临时目录。
- 不要给 flake 加自动重试：只记录并标 FLAKY（内部设计记录 0009）。
- 不要用 `--authorize-provider` 或 <gateway-port> 端口跑默认入口：真实 provider 计费入口单列，`verification/real/` 下有独立说明。
