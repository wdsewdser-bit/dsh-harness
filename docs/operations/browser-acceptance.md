# 浏览器验收

`npm run test:browser` 是 M6 引入的独立验收入口：用 headless Edge + CDP 打开真实页面，逐条核对 v3 设计稿（16 §3 / 15 §9 的 V-01…V-24）。它**不属于 `npm test`**：浏览器运行有自己的超时，不该拖慢套件。

```bash
npm run test:browser                  # 整份清单
node verification/browser/acceptance.mjs --only V-05,V-06
```

## 它做什么

1. 用 `verification/browser/serve.fixture.mjs` 起一个**只能拿 mock 数据**的宿主：没有 provider 凭据、没有投影服务端口、不会发任何模型请求。
2. 用 CDP 驱动本机 Edge：先走一次登录 URL，再带 `?teamFixture=…` 进入应用。
3. 依次运行 `verification/browser/checks/` 下的检查：作用域、人话层、权限、语义、布局。
4. 截两张视口图，写报告：`runs/m6-browser/<时间戳>/report.json`。

## 判据

- 每项检查有 90 秒超时，整份有 20 分钟上限。
- 通过条数必须 ≥ `MIN_PASSED = 12`；"不适用（N/A）"要在报告里逐条写原因，"找不到 Edge"直接报错退出，不算通过。
- 这些情况会直接失败而不是放行：带 `--authorize-provider`、使用 <gateway-port> 端口。

## 已知边界

- 模拟数据造不出某些场景（例如绑定请求失败），那几项只能靠内存级单测或手工点击确认，报告里会写明。
- 最近一次 M6 结果：24 条里 14 条通过、0 条失败、10 条不适用（见 `runs/m6-browser/20261106T014653/report.json`）。
- 删掉一条检查要给出理由，并在验收记录里记一笔——它是验收证据，不是装饰。
