# 模块 · ui

浏览器端 Team 面板。M6 把它从单个 `ui.mjs` 拆成 `src/ui/*` + barrel，并按 v3 设计稿重写了呈现层。

- 包名：`@dsh-v2/client-team`
- 公共入口：`packages/ui/index.mjs`
- 允许依赖：无（运行时只走 HTTP）
- 测试入口：`npm test -- --only=ui`（`packages/ui/test`，27 个文件）；浏览器验收 `npm run test:browser`（不属于 npm test）。

## 职责

- `src/plugin.mjs`：`apply(ctx, config)`，注册插槽与面板。
- `src/scope.mjs`、`store.mjs`：会话作用域与首帧/晚到快照处理（团队跟随会话，0017）。
- `src/human-text.mjs`、`labels.mjs`：人话层与文案字典（内部 ID、字段名默认折叠）。
- `src/real-source.mjs`、`transport.mjs`：HTTP 读接口；`src/mock.mjs`：离线夹具。
- `build.mjs`：打包产物（手写脚本，不加依赖）。

## 公共接口

`exports` 三个入口：`.`、`./client`（`lib/client.js`，DSH 客户端插件入口）、`./package.json`。

## 边界

- 不引用服务端 store，不持有数据库句柄；只走 HTTP 与插槽。
- 不改投影值来"说人话"：状态机取值不动，标签在前端映射（0010）。
