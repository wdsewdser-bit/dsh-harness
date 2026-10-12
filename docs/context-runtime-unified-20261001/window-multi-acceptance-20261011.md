# 多段窗口折叠验收

时间：2026-10-11 13:14 UTC。

结论：多段 + R、权威基线投递回读修复、原生多区间及消费层补丁已部署到生产文件。真实原根的隔离副本通过折叠、重启历史加载、原生冷恢复及 opencodego 模型后继请求。原生产根未执行折叠；不代表全项目 E0-E8 完成，也未全面启用。

## 范围与实现

- 保留人的输入、队友原文、最终回答；运行时状态类注入可进入折叠段。未启用直接折队友原文的 T。
- 一个 `replace-many` 事件原子提交有序、不重叠的多个区间，只在首段放一个检查点；其余间隙原样保留。非法、过期、缺结果或不满足净收益的候选拒绝。
- 权威基线投递须有落盘回读回执；重试也回读。源内容变化拒绝，合法旧精确回执允许非必需源版本升级，不退覆盖。
- 修复所有已定位的多区间消费面：TokenMeter、压力缓存 v6、浏览器 API metadata、system prompt 检查、DeepSeek session-log 编码。旧 v5 压力缓存重放；单区间和多区间均按实际 surface 增减计量，避免旧无 claim 扩张之后多段导致负 token。
- 生产窗口配置仍为 `scope: list / spanMode: multiple`，仅根 `session-9afa7cdb-b940-4b7e-8c26-0cb20ad6307a`；没有打开 `team-roots`。

## 验证

- 最终共享源码回归：229 个文件，1461 tests，1460 pass，0 fail，1 skip，正常退出。证据：`D:/dsh-test/output/regressions/2026-10-11T13-00-44-122Z-373bad5f/summary.json`。
- 针对权威回执、计量器的独立审查反例已修并复核。消费层追加审查因代理换窗缺上下文而停止，由根代理聚焦测试及真实页面验收；不宣称这部分额外独审通过。
- 初次部署 39 文件；消费层补充部署 17 文件。最终部署计划 222 文件、`toWrite: 0 / problems: []`，物理包副本及 web/headless 一致。
- 原生产启动守护因同测试工作区 child `session-2fa0b66c-fba4-4253-b87d-8e5426fb0b7a` 的日志恢复写入触发停机。该启动确实改变了 child 日志，未擅自回滚，也未放宽守护重试。
- 随后只复制根会话日志、其控制面和冷引用、必要配置到 `D:/dsh-test/output/window-isolated-live-20261011`；其他生产会话不在副本中。副本禁用自动 continuation/idle-watch，使用最终生产原生包和插件。
- 隔离副本实际 `/window fold`：一个 `replace-many` 事件，37 个不相邻区间，`toWindowId: 1`。提交前派生正文 2,158,609 B，提交后 1,362,998 B，减少 795,611 B，约 36.86%。这是模型正文 JSON 口径，不是 wire bytes、真实 token 或费用节省。
- 冷恢复：检查点 1 个；80 条原文证人逐条整消息 SHA 一致（37 人的输入、14 最终文本、29 队友原文）。真实后继回合完成后仍全部一致；当时会话有 3156 events / 224 messages。
- 实际浏览器能加载原始任务和折叠后的历史，没有先前 token surface 的 undefined range 错误。旧变更摘要 API 有 6 个 404、旧展示资源有 2 个 500；副本未复制这些历史附件，不能宣称浏览器 console 全无错误。它们不阻断会话历史或本次模型调用，未为此修改无关代码。
- 真实后继请求 `5458b936-614f-41a1-94d3-2ba5a81f2322`：`opencodego / deepseek-v4.1-flash / high`，Responses 路由经过本机 8788；terminal success，native-window-admission applied，handedToAdapter true，18.733 秒。adapterPayload 1,672,478 B；适配器回报 input 443586、output 555、cacheRead 1408、total 445549。未取得提供方 request ID，不将适配器数字当独立账单，也不据此外推节费。
- 回答以 `WINDOW_LIVE_OK` 开头，准确保留 Roguelike、至少 8 层、30 种物品、8 个阶段里程碑、`index.html`、无构建工具和第三方库的限制。后继回合无工具调用，未继续开发或主动唤醒队友。
- 隔离主机守护保护 747 个生产 Session/控制面主文件；结束后 size/mtime 逐文件一致，未触发生产变化。主机按 requested-stop 关闭、浏览器关闭，40123/40124 均无监听。

## 持久证据

- 完整验收：`D:/dsh-test/output/window-isolated-live-20261011/acceptance.json`；六项 checks 全 true。
- 页面快照和截图：同目录 `accepted-ui.yml`、`accepted-ui.png`。
- 请求原始台账：同目录 `home/usage-ledger/requests-14072-6fb9530b-b632-473c-9080-290324499d10.jsonl`。
- 证据记录：`window-multi-live-20261011-27a85963a95b332a`，status passed，绑定源码清单/config/原根日志 SHA。
- 实际落在隔离 `home/team-control-plane/default.json` 的 `v12ColdRefs.v12Evidence`（digest `5a151bf1bf14a0e76c0975ecd5a1b35e9a964b7620da56f83377b973381eb71d`）；独立新进程用 `controlPlaneFor(...).snapshot({history:true})` 回读得到 `v12Evidence.records[id]`，status/sourceHash/fixtureHash 全匹配。直接检查热 JSON 内联字段会误报缺记录，不能替代冷引用加载。
- 这是隔离证据登记，不是生产 default 控制面登记；未向原业务根发送通知。

## 回滚与剩余边界

- 部署备份：`D:/dsh-test/backups/context-runtime-production-multi-20261011`、`D:/dsh-test/backups/context-runtime-production-token-wire-20261011`；均有逐文件 before/after SHA 和 `deploy-backup.json`。
- 停机后按相反顺序运行 `node tools/deploy-production.mjs --rollback <backup>` 可撤回本轮两次部署。生产配置原件在 `D:/dsh-test/backups/context-runtime-multi-config-20261011/cordis.patch.yml`，恢复配置须单独明确范围，不能随手恢复旧大白名单。
- 原生产根实折、完整 Team 后代/A-B经济统计、整体计划 coverage、生产证据登记与原业务根通知未在本次闭合。
- 先前已登记的恢复副本热路径缓存、里程碑文件清理、临时上限及自身摘要债务策略等仍是独立待办。本报告不把这些标成已解决，也不打开经济 auto。
