# DSH 代码与运行时现状盘点（2026-10-26）

## 结论先行
- web/headless 的 144/29 是 patch 文本中 `- id:` 出现次数，不是已启动插件数：包含模型、重复预设、禁用覆盖。web 31 个、headless 22 个现存本地入口；另有 bundle 层。证据：`home/profiles/web/cordis.patch.yml:507,679,910`；`home/profiles/headless/cordis.patch.yml:49`；bundle：两者 `package.json:22,29`。
- “plan-delivery、window-executor 都是死文件”不成立：web wiring 静态导入 executor 并创建执行器，runtime 导入 plan-delivery；PTC background 未挂载本地 profile。证据：`home/profiles/web/plugins/team-v15-window-wiring.mjs:19,148`；`team-v12-runtime.mjs:32`（下文路径缩写规则）。
- 共享自研模块 web/headless 文本一致，但功能并不等价：headless 缺 window wiring、mailbox compaction、UI 和预设；web window manager 为 shadow，wiring 仅指定 session；上下文工作区也为 shadow。证据：`home/profiles/web/cordis.patch.yml:28,47,58,61,408`；headless 全文 `:1-341`。
- 上游修改有三套来源：应用 pnpm 10 项、web pnpm 5 项/headless 3 项，以及 staging 原地覆盖清单；仅重装 profile 无法可靠恢复整体。证据：`app/pnpm-workspace.yaml:296-306`；`home/profiles/web/pnpm-workspace.yaml:38-43`；`staging/context-runtime-unified-20261001/tools/deploy-production.mjs:62-80`。
- 关键热点不是纯粹“每次请求全扫 journal”：现役已有缓存、增量和有界 tail；但同步冷读/落盘、全量快照和多套扫描仍存在。证据：`home/profiles/web/plugins/team-usage.mjs:229-255`；`evidence-reducer.mjs:275-305`；`team-idle-watch-v6.mjs:815,847`。

## 口径、边界与复算方法
- 全程只读取文本，不启动 DSH、不执行项目脚本、不作 git 操作、不通读 backup-*；只写本报告。中断后确认本报告原先不存在，故无既有内容需要保留。
- “现役”在本报告指配置允许加载且本地静态 import 可达，不等于运行时已激活；未连接宿主，服务注入成功、HMR 当前代、真实 profile 选择均未证实。预设是按需激活，不应当作常驻插件。
- 路径均相对 `D:/dsh-test`；正文 web/、headless/、desktop/、teamtest/ 均省略 home/profiles/；下表 P=`home/profiles/{profile}/plugins/`，R=`home/profiles/{profile}/`，A=`app/node_modules/@deepseek-ai/`，S=`staging/context-runtime-unified-20261001/`。表格 `:1` 是文件与职责定位，挂载行另列。
- 脚本通过 read/glob 读取四 profile 的 plugins/presets 下全部 *.mjs/*.cjs/*.js（排除 backup-/bak/node_modules），扫描 YAML 相对 name，排除同级 disabled:true，递归匹配 from/import 相对字面量；行数使用 read.totalLines。没有执行 !!js。
- 统计按物理路径，不按内容去重；客户端自动加载资源单列，不混入 import 闭包；不把上游 node_modules、staging 测试、工具、patch diff 行数混入自研插件行数。动态计算 import/加载器惯例不能穷尽；源码匹配可能包含未执行分支。
- “不可达”≠“零入边死文件”：后者在四 profile 本地代码所有字面量 import 和四 YAML（含禁用行）均无引用；Reducer client.js 作为浏览器伴随资源保守排除死文件。这是指定候选集合的精确静态计数，不声称全仓库无人调用，更不是删除许可。

## 脚本统计
| profile | id 文本次数 | 本地入口（现存） | import 闭包文件 | 闭包总行 | 候选内不可达 | 零入边死候选 |
|---|---:|---:|---:|---:|---:|---:|
| web | 144 | 31 | 96 | 51419 | 51 | 35 |
| headless | 29 | 22 | 79 | 47275 | 33 | 18 |
| desktop | 144 | 31 | 96 | 51419 | 51 | 35 |
| teamtest | 17 | 12 | 43 | 35128 | 98 | 46 |
- 四 profile 候选 547 文件；现役闭包共 314 个路径、185241 行；零入边死候选 134；不可达 233。入口/闭包统计不含缺失项。证据：四份 cordis.patch.yml:1 及下表路径:1。
- web/headless 共同可达 79 文件，文本不同 0；desktop 对 web 的 96 个对应文件不同 0，配置文本相同=true。同名路径分开统计，不代表只部署一份。证据：对应文件:1。
- teamtest 的 `plugins/opencode-search.mjs` 缺失，配置仍引用；无法证明测试 profile 可正常启动。证据：`home/profiles/teamtest/cordis.patch.yml:54`。

- 补充浏览器资源：web/desktop 的 `plugins/evidence-reducer-ui/client.js:1` 各 519 行，由 `plugins/evidence-reducer-ui/package.json:8,10-18` 声明。加入这两份资源后，配置现役自研路径合计 316 个/186279 行；web、desktop 各 97 个/51938 行。teamtest 有同名 client 文件但无现役 UI 入口，故不加入现役数。客户端是否已经在浏览器成功注入未证实。
- 全仓“没有任何 YAML/import 引用”的最终死文件总数未证实：134 是本报告四 profile 候选集的零入边数，不能外推到 staging/tools/所有测试；动态 import 和客户端资源使机械删除不安全。

## 现役自研文件逐项清单
- W/H/D/T 分别表示 web/headless/desktop/teamtest；挂载列是对应 cordis.patch.yml 的 name 行；“import”不是独立插件挂载。下表 web 文件以 P 相对路径列出，H/D 同名对应路径仅在可达时合并；同文本已逐文件比较，不能把相同文件名推定为相同来源。
| 文件（P，预设用 R；每项 :1） | 行数 | 可达 profile / 挂载行 | 一句话职责 |
|---|---:|---|---|
| P/request-message-projection.mjs:1 | 395 | W:10 H:8 D:10 T:22 | 请求消息投影与窗口适配 |
| P/team-v15-window-loaded.mjs:1 | 30 | W:import H:import D:import T:import | 压缩/窗口状态辅助：window-loaded |
| P/constraint-ledger.mjs:1 | 315 | W:14 H:12 D:14 | 请求约束账本 |
| P/ptc-sdk-retention.mjs:1 | 237 | W:16 H:14 D:16 T:26 | PTC SDK 历史保留/认证策略 |
| P/request-usage-ledger.mjs:1 | 438 | W:35 H:33 D:35 T:45 | LLM 请求用量审计和预算 |
| P/team-token-meter-cache.mjs:1 | 20 | W:import H:import D:import T:import | 会话 token 测量缓存 |
| P/context-workspace.mjs:1 | 642 | W:26 H:24 D:26 T:36 | 上下文工作区与成员恢复包 |
| P/team-policy.mjs:1 | 1058 | W:334 H:225 D:334 T:156 | 层级、角色与成员策略 |
| P/team-control-plane.mjs:1 | 5184 | W:import H:import D:import T:import | 团队控制快照、冷存储、任务阶段和审计 |
| P/team-v14-durable-store.mjs:1 | 189 | W:import H:import D:import T:import | 团队策略/运行辅助：durable-store |
| P/team-v15-window-file-protection.mjs:1 | 127 | W:import H:import D:import T:import | 压缩/窗口状态辅助：window-file-protection |
| P/team-v12-contract.mjs:1 | 725 | W:import H:import D:import T:import | 团队策略/运行辅助：contract |
| P/team-v12-persistence.mjs:1 | 609 | W:import H:import D:import T:import | 团队策略/运行辅助：persistence |
| P/team-control-lifecycle.mjs:1 | 152 | W:import H:import D:import T:import | 团队策略/运行辅助：control-lifecycle |
| P/team-v12-context.mjs:1 | 472 | W:import H:import D:import T:import | 压缩/窗口状态辅助：context |
| P/team-v14-memory-anchor.mjs:1 | 280 | W:import H:import D:import T:import | 团队策略/运行辅助：memory-anchor |
| P/team-v14-requirements.mjs:1 | 317 | W:import H:import D:import T:import | 计划/交付/goal 辅助：requirements |
| P/team-v15-window-manager.mjs:1 | 248 | W:44 H:42 D:44 | 窗口折叠决策观测（配置为 shadow） |
| P/team-v15-window-decision.mjs:1 | 73 | W:import H:import D:import | 压缩/窗口状态辅助：window-decision |
| P/team-v15-window-wiring.mjs:1 | 305 | W:53 D:53 | 持久窗口折叠宿主接线 |
| P/team-v15-window-install.mjs:1 | 243 | W:import D:import | 压缩/窗口状态辅助：window-install |
| P/team-v15-window-collector.mjs:1 | 618 | W:import D:import | 压缩/窗口状态辅助：window-collector |
| P/team-v15-plan-registry.mjs:1 | 117 | W:import H:import D:import | 计划/交付/goal 辅助：plan-registry |
| P/team-v15-plan-delivery.mjs:1 | 260 | W:import H:import D:import T:import | 计划交付状态与哈希 |
| P/team-v15-plan-refs.mjs:1 | 132 | W:import H:import D:import | 计划/交付/goal 辅助：plan-refs |
| P/team-v15-window-plan.mjs:1 | 105 | W:import H:import D:import T:import | 压缩/窗口状态辅助：window-plan |
| P/team-v15-delivery-debt.mjs:1 | 247 | W:import H:import D:import T:import | 计划/交付/goal 辅助：delivery-debt |
| P/team-v14-context-delivery.mjs:1 | 574 | W:import H:import D:import T:import | 压缩/窗口状态辅助：context-delivery |
| P/team-v14-waiting.mjs:1 | 698 | W:import H:import D:import T:import | 团队策略/运行辅助：waiting |
| P/team-v15-window-checkpoint.mjs:1 | 88 | W:import H:import D:import | 压缩/窗口状态辅助：window-checkpoint |
| P/team-v15-window-participation.mjs:1 | 106 | W:import H:import D:import | 压缩/窗口状态辅助：window-participation |
| P/team-v15-window-surface.mjs:1 | 308 | W:import D:import | 压缩/窗口状态辅助：window-surface |
| P/team-v15-window-projection.mjs:1 | 199 | W:import D:import | 压缩/窗口状态辅助：window-projection |
| P/team-v15-window-transition.mjs:1 | 251 | W:import D:import | 压缩/窗口状态辅助：window-transition |
| P/team-v15-window-protocol.mjs:1 | 59 | W:import D:import | 压缩/窗口状态辅助：window-protocol |
| P/team-v15-window-executor.mjs:1 | 185 | W:import D:import | 执行窗口转换与折叠 |
| P/compatibility-health.mjs:1 | 49 | W:94 D:94 | 浏览器/计算机兼容健康检查 |
| P/write-scope-guard.mjs:1 | 1885 | W:134 H:76 D:134 T:103 | 文件写入作用域强制检查 |
| P/team-health.mjs:1 | 349 | W:145 H:84 D:145 | 插件/依赖健康检查 |
| P/team-v13-mechanism-telemetry.mjs:1 | 332 | W:import H:import D:import T:import | 证据/观察/审计辅助：mechanism-telemetry |
| P/action-fusion-v2.mjs:1 | 464 | W:235 H:159 D:235 | 融合工具行动与观察 |
| P/observation-pack-v2.mjs:1 | 540 | W:260 H:185 D:260 T:134 | 观察结果封装/限额 |
| P/team-v13-observation-source.mjs:1 | 58 | W:import H:import D:import T:import | 证据/观察/审计辅助：observation-source |
| P/evidence-reducer.mjs:1 | 641 | W:269 H:194 D:269 | 长工具结果归档、压缩与证据回执 |
| P/team-usage.mjs:1 | 356 | W:import H:import D:import T:import | 会话 journal 用量统计与缓存 |
| P/team-v12-evidence-scheduler.mjs:1 | 1388 | W:import H:import D:import T:import | 证据/观察/审计辅助：evidence-scheduler |
| P/evidence-reducer-ui/index.js:1 | 2 | W:294 D:294 | Reducer 设置宿主空壳（浏览器另有 client） |
| P/team-v13-cache-monitor.mjs:1 | 187 | W:296 H:212 D:296 | 证据/观察/审计辅助：cache-monitor |
| P/team-v13-compaction-shadow.mjs:1 | 320 | W:import H:import D:import | 压缩/窗口状态辅助：compaction-shadow |
| P/team-v13-compaction-economics.mjs:1 | 249 | W:import H:import D:import | 压缩/窗口状态辅助：compaction-economics |
| P/team-v13-failure-memory.mjs:1 | 236 | W:302 H:218 D:302 | 证据/观察/审计辅助：failure-memory |
| P/team-v14-identity.mjs:1 | 102 | W:import H:import D:import | 团队策略/运行辅助：identity |
| P/team-tools-v2-r10.mjs:1 | 8436 | W:347 H:235 D:347 T:168 | 团队工具注册、权限/任务/room 强制执行 |
| P/team-query-efficiency.mjs:1 | 42 | W:import H:import D:import T:import | 任务查询快照/过滤 |
| P/team-message-operation.mjs:1 | 49 | W:import H:import D:import T:import | 消息操作幂等标识 |
| P/team-v12-room-wake.mjs:1 | 2005 | W:import H:import D:import T:import | room 决议、等待依赖与唤醒判定 |
| P/team-v15-delivery-service.mjs:1 | 57 | W:import H:import D:import T:import | 计划/交付/goal 辅助：delivery-service |
| P/team-v15-delivery-authority.mjs:1 | 172 | W:import H:import D:import T:import | 计划/交付/goal 辅助：delivery-authority |
| P/team-activity-digest.mjs:1 | 365 | W:import H:import D:import T:import | 团队策略/运行辅助：activity-digest |
| P/team-armed-roots.mjs:1 | 116 | W:import H:import D:import T:import | 团队策略/运行辅助：armed-roots |
| P/team-milestone-v2.mjs:1 | 382 | W:import H:import D:import T:import | 压缩/窗口状态辅助：milestone-v2 |
| P/team-worktree.mjs:1 | 793 | W:import H:import D:import T:import | 团队工作树隔离与作用域 |
| P/team-v12-runtime.mjs:1 | 4140 | W:370 H:254 D:370 | 团队运行桥、goal gate、工具与恢复集成 |
| P/team-v15-delivery-source.mjs:1 | 73 | W:import H:import D:import | 计划/交付/goal 辅助：delivery-source |
| P/team-v15-history-recall.mjs:1 | 410 | W:import H:import D:import | 团队策略/运行辅助：history-recall |
| P/team-v15-implementation-proof.mjs:1 | 90 | W:import H:import D:import | 证据/观察/审计辅助：implementation-proof |
| P/team-v15-runtime-proof.mjs:1 | 101 | W:import H:import D:import | 证据/观察/审计辅助：runtime-proof |
| P/team-v15-execution-proof.mjs:1 | 169 | W:import H:import D:import | 证据/观察/审计辅助：execution-proof |
| P/team-v15-hypothesis-runtime.mjs:1 | 560 | W:import H:import D:import | 计划/交付/goal 辅助：hypothesis-runtime |
| P/team-v15-hypothesis-memory.mjs:1 | 483 | W:import H:import D:import | 计划/交付/goal 辅助：hypothesis-memory |
| P/team-v15-active-identity.mjs:1 | 506 | W:import H:import D:import | 计划/交付/goal 辅助：active-identity |
| P/team-v15-goal-delivery.mjs:1 | 152 | W:import H:import D:import | 计划/交付/goal 辅助：goal-delivery |
| P/team-v15-delivery-presentation.mjs:1 | 36 | W:import H:import D:import | 计划/交付/goal 辅助：delivery-presentation |
| P/team-v12-compaction.mjs:1 | 540 | W:import H:import D:import | 压缩/窗口状态辅助：compaction |
| P/team-v12-runtime-facts.mjs:1 | 727 | W:import H:import D:import | 团队策略/运行辅助：runtime-facts |
| P/team-v12-observability.mjs:1 | 485 | W:import H:import D:import | 证据/观察/审计辅助：observability |
| P/team-v12-replay.mjs:1 | 589 | W:import H:import D:import | 证据/观察/审计辅助：replay |
| P/team-v14-event-continuation.mjs:1 | 567 | W:397 H:277 D:397 | 事件驱动续跑与周期恢复 |
| P/team-agentteam-mailbox-compaction.mjs:1 | 64 | W:408 D:408 | 团队邮箱压缩接线 |
| P/step-compaction-v4.mjs:1 | 1439 | W:418 H:284 D:418 | 里程碑/压力触发压缩与恢复 |
| P/team-v13-compaction-anchors.mjs:1 | 69 | W:import H:import D:import | 压缩/窗口状态辅助：compaction-anchors |
| P/team-idle-watch-v6.mjs:1 | 884 | W:455 H:310 D:455 | 团队空闲、room 健康和提醒扫描 |
| P/team-runtime-guard.mjs:1 | 819 | W:469 H:320 D:469 | 运行状态保护与恢复 |
| P/team-operator-v5.mjs:1 | 605 | W:483 H:329 D:483 | 操作员命令和面板元数据 |
| P/team-v14-panel.mjs:1 | 83 | W:import H:import D:import | 预设重放/人格/UI 辅助：panel |
| R/presets/minimal-zh-ptc/zh-warmup-ptc-replay.mjs:1 | 553 | W:1004 D:1004 | 预设重放/人格/UI 辅助：zh-warmup-ptc-replay |
| R/presets/minimal-zh-ptc-catgirl/zh-warmup-ptc-replay.mjs:1 | 536 | W:1336 D:1336 | 预设重放/人格/UI 辅助：zh-warmup-ptc-replay |
| R/presets/minimal-zh-ptc-catgirl/catgirl-tool-zh.mjs:1 | 160 | W:1352 D:1352 | 预设重放/人格/UI 辅助：catgirl-tool-zh |
| R/presets/minimal-zh-ptc-catgirl/catgirl-mode.mjs:1 | 133 | W:import D:import | 预设重放/人格/UI 辅助：catgirl-mode |
| R/presets/minimal-zh-ptc-catgirl/catgirl-reheat.mjs:1 | 244 | W:1364 D:1364 | 预设重放/人格/UI 辅助：catgirl-reheat |
| R/presets/minimal-zh-ptc-catgirl/catgirl-persona-anchor.mjs:1 | 235 | W:1383 D:1383 | 预设重放/人格/UI 辅助：catgirl-persona-anchor |
| P/team-v16-capabilities-runtime.mjs:1 | 100 | W:1471 H:338 D:1471 | 能力引用、SDK 目录与上下文片段注册 |
| P/team-v16-tool-references.mjs:1 | 95 | W:import H:import D:import | PTC 能力/SDK 辅助：tool-references |
| P/team-v16-capability-common.mjs:1 | 33 | W:import H:import D:import | PTC 能力/SDK 辅助：capability-common |
| P/team-v16-sdk-catalog.mjs:1 | 73 | W:import H:import D:import | PTC 能力/SDK 辅助：sdk-catalog |
| P/team-v16-context-episodes.mjs:1 | 85 | W:import H:import D:import | 压缩/窗口状态辅助：context-episodes |
| teamtest/plugins/action-fusion.mjs:1 | 202 | YAML:122 | 团队策略/运行辅助：action-fusion |
| teamtest/plugins/step-compaction.mjs:1 | 339 | YAML:187 | 压缩/窗口状态辅助：step-compaction |
| teamtest/plugins/team-milestone.mjs:1 | 319 | import | 压缩/窗口状态辅助：milestone |
| teamtest/plugins/team-idle-watch.mjs:1 | 268 | YAML:199 | 团队策略/运行辅助：idle-watch |
| teamtest/plugins/team-operator.mjs:1 | 351 | YAML:213 | 团队策略/运行辅助：operator |
| teamtest/plugins/team-tools-v2-r6.mjs:1 | 3914 | import | 团队策略/运行辅助：tools-v2-r6 |
- 浏览器文件补项：`home/profiles/web/plugins/evidence-reducer-ui/client.js:1`、`home/profiles/desktop/plugins/evidence-reducer-ui/client.js:1`，各 519 行，Reducer 设置表单与客户端注册。
- web 与 desktop 的对应实现逐项文本一致；T 仍挂 action-fusion.mjs、step-compaction.mjs、team-idle-watch.mjs、team-operator.mjs 老实现（不是 v2/v4/v6/v5）。证据：`home/profiles/teamtest/cordis.patch.yml:122,187,199,213`；各文件:1。
- 特殊跨目录依赖不算“自研插件文件”行数：`app/node_modules/@deepseek-ai/dsh-session/lib/index.js:1`（1937 行）；`app/node_modules/@deepseek-ai/dsh-session/lib/native-bridge.js:1`（169 行）；`app/node_modules/@deepseek-ai/dsh-tools/lib/index.js:1`（3769 行）。

## 上游包直接修改与部署渠道
- 下列 pnpm 注册只能证明安装输入；现装文件可能已被 staging 再覆盖。patch/ 副本不是自动 mount，不能把存在本身当作生效证明。
| 注册位置 | 包/补丁文件（均相对该位置） | diff 行数 | 改动目的/证据 |
|---|---|---:|---|
| app/pnpm-workspace.yaml:297 | @deepseek-ai/dsh-agent-loop；patches/@deepseek-ai__dsh-agent-loop@0.1.7-rc.2.patch:1 | 25 | session 事件读取/运行上下文一致性 |
| app/pnpm-workspace.yaml:298 | @deepseek-ai/dsh-api-session-controller；patches/@deepseek-ai__dsh-api-session-controller@0.1.7-rc.2.patch:1 | 204 | 活动会话/历史 API 控制 |
| app/pnpm-workspace.yaml:299 | @deepseek-ai/dsh-experimental-agent-team；patches/@deepseek-ai__dsh-experimental-agent-team@0.1.7-rc.2.patch:1 | 89 | 成员元数据、冻结、生命周期取消、邮箱/恢复 |
| app/pnpm-workspace.yaml:300 | @deepseek-ai/dsh-ptc-runtime-node；patches/@deepseek-ai__dsh-ptc-runtime-node@0.1.7-rc.2.patch:1 | 22 | 修正数组 length 回退操作 |
| app/pnpm-workspace.yaml:301 | @deepseek-ai/dsh-session-format-v0-to-v1；patches/@deepseek-ai__dsh-session-format-v0-to-v1@0.1.7-rc.2.patch:1 | 16 | 历史格式迁移兼容 |
| app/pnpm-workspace.yaml:302 | @deepseek-ai/dsh-session-format-v3-to-v4；patches/@deepseek-ai__dsh-session-format-v3-to-v4@0.1.7-rc.2.patch:1 | 22 | v4 会话迁移兼容 |
| app/pnpm-workspace.yaml:303 | @deepseek-ai/dsh-session-persistence-jsonl；patches/@deepseek-ai__dsh-session-persistence-jsonl@0.1.7-rc.2.patch:1 | 134 | 会话持久化/恢复与 journal 兼容 |
| app/pnpm-workspace.yaml:304 | @deepseek-ai/dsh-session-query；patches/@deepseek-ai__dsh-session-query@0.1.7-rc.2.patch:1 | 95 | 会话查询与活动标题 |
| app/pnpm-workspace.yaml:305 | @deepseek-ai/dsh-session-query-sqlite；patches/@deepseek-ai__dsh-session-query-sqlite@0.1.7-rc.2.patch:1 | 26 | 去掉事件全量 clone；指纹改为末事件/计数 |
| app/pnpm-workspace.yaml:306 | @deepseek-ai/dsh-session-title；patches/@deepseek-ai__dsh-session-title@0.1.7-rc.2.patch:1 | 72 | 活动会话标题 |
| home/profiles/web/pnpm-workspace.yaml:39 | @deepseek-ai/dsh-experimental-agent-team-profile；patches/@deepseek-ai__dsh-experimental-agent-team-profile@0.1.7-rc.2.patch:1 | 13 | 团队默认 maxMembers=30 |
| home/profiles/web/pnpm-workspace.yaml:40 | @deepseek-ai/dsh-experimental-agent-team；patches/@deepseek-ai__dsh-experimental-agent-team@0.1.7-rc.2.patch:1 | 744 | 成员元数据、冻结、生命周期取消、邮箱/恢复 |
| home/profiles/web/pnpm-workspace.yaml:41 | @deepseek-ai/dsh-experimental-client-ui-agent-team；patches/@deepseek-ai__dsh-experimental-client-ui-agent-team@0.1.7-rc.2.patch:1 | 6097 | 大幅替换 Team 面板 |
| home/profiles/web/pnpm-workspace.yaml:42 | @deepseek-ai/dsh-experimental-browser-use-stagehand-native；patches/@deepseek-ai__dsh-experimental-browser-use-stagehand-native@0.1.7-rc.2.patch:1 | 308 | 自定义 Anthropic 模型/baseURL/超时适配 |
| home/profiles/web/pnpm-workspace.yaml:43 | @deepseek-ai/dsh-llm-pi-ai；patches/@deepseek-ai__dsh-llm-pi-ai@0.1.7-rc.2.patch:1 | 28 | 传递 systemPromptUpdate=in-history |
| home/profiles/headless/pnpm-workspace.yaml:31 | @deepseek-ai/dsh-experimental-agent-team-profile；patches/@deepseek-ai__dsh-experimental-agent-team-profile@0.1.7-rc.2.patch:1 | 13 | 团队默认 maxMembers=30 |
| home/profiles/headless/pnpm-workspace.yaml:32 | @deepseek-ai/dsh-experimental-agent-team；patches/@deepseek-ai__dsh-experimental-agent-team@0.1.7-rc.2.patch:1 | 593 | 成员元数据、冻结、生命周期取消、邮箱/恢复 |
| home/profiles/headless/pnpm-workspace.yaml:33 | @deepseek-ai/dsh-llm-pi-ai；patches/@deepseek-ai__dsh-llm-pi-ai@0.1.7-rc.2.patch:1 | 28 | 传递 systemPromptUpdate=in-history |
- desktop 的 pnpm-workspace.yaml:38-43 同样注册五个补丁；与 web 的五份对应 patch 逐一文本相同=true。teamtest 无 pnpm-workspace.yaml，且 package.json:6 仍依赖 team-profile 0.1.6-alpha.1，并非其他 profile 的 0.1.7-rc.2。
- web/headless team pnpm diff 分别 744/593 行，不是同一个补丁版本；其余共享 llm/profile diff 应以各自文件为准。安装 team/lib/index.js 也分别 1963/1949 行，不能仅因自研插件相同而宣称两环境一致。证据：两 profile `patches/@deepseek-ai__dsh-experimental-agent-team@0.1.7-rc.2.patch:1`、`node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:1`。

### staging 原生覆盖：逐包现装文本复核
- 清单来源 S/native-change-manifest.json；部署器 S/tools/deploy-production.mjs:62-80 会映射 -v15 包名并复制 profile 副本。下面“相同”是当前文件与 staging 来源的 UTF-8 文本相同，不是原始字节 SHA 校验；不同不等于未部署，可能后续再改。所有包均属 @deepseek-ai。
| 包名 | 清单文件数 | 当前目标同文/存在 | 目的与证据 |
|---|---:|---|---|
| dsh-session | 5 | 5/5 | 窗口/会话 native bridge；app/node_modules/@deepseek-ai/dsh-session/lib/index.js:1 |
| dsh-agent-loop | 3 | 3/3 | 窗口运行上下文与请求接线；app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:1 |
| dsh-tools | 3 | 3/3 | PTC SDK/工具呈现与执行接线；app/node_modules/@deepseek-ai/dsh-tools/lib/index.js:1 |
| dsh-api-session-controller | 7 | 7/7 | 即时历史、窗口和 API 投影；app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js:1 |
| dsh-compaction-basic | 2 | 2/2 | 压缩与窗口转换衔接；app/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:1 |
| dsh-goal | 6 | 6/6 | goal 状态与交付生命周期；app/node_modules/@deepseek-ai/dsh-goal/lib/index.js:1 |
| dsh-session-persistence-jsonl | 2 | 2/2 | 窗口持久化与 barrier；app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:1 |
| dsh-tool-goal | 1 | 1/1 | goal 工具的 v15 接线；app/node_modules/@deepseek-ai/dsh-tool-goal/lib/index.js:1 |
| cordis | 2 | 2/2 | 宿主生命周期 gate；app/node_modules/@deepseek-ai/cordis/lib/index.js:1 |
| cordis-plugin-loader | 1 | 1/1 | 插件加载生命周期；app/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:1 |
| dsh-system-prompt | 1 | 1/1 | 窗口/SDK 系统提示衔接；app/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js:1 |
| dsh-scope | 1 | 1/1 | 作用域生命周期；app/node_modules/@deepseek-ai/dsh-scope/lib/index.js:1 |
| dsh-client-ui-chat | 2 | 2/2 | 聊天窗口与即时历史 UI；app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:1 |
| dsh-agent | 2 | 2/2 | agent 能力与上下文接线；app/node_modules/@deepseek-ai/dsh-agent/lib/index.js:1 |
| dsh-subagent | 6 | 6/6 | 子代理恢复/交付；app/node_modules/@deepseek-ai/dsh-subagent/lib/index.js:1 |
| dsh-session-format-v3-to-v4 | 1 | 1/1 | 格式迁移兼容（具体范围未证实）；app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:1 |
| dsh-token-meter | 5 | 5/5 | 窗口 token 测量；app/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js:1 |
| dsh-client-ui-conversation | 1 | 1/1 | 会话 UI 与窗口显示；app/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:1 |
| dsh-session-log-deepseek | 2 | 2/2 | 日志到模型消息投影；app/node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js:1 |
| dsh-compaction-tool-result-pruner | 5 | 5/5 | 结果裁剪与窗口保护；app/node_modules/@deepseek-ai/dsh-compaction-tool-result-pruner/package.json:1 |
| dsh-sandbox-local | 1 | 1/1 | 本地沙箱/工具执行；app/node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js:1 |
| dsh-goal-round-driver | 1 | 1/1 | goal round 驱动；app/node_modules/@deepseek-ai/dsh-goal-round-driver/lib/index.js:1 |
- 清单共 60 项、22 包，当前目标同文 60/60；原生功能概述不等于相对官方发布包的逐行 diff。没有下载干净上游，未证明所有原地修改都被清单覆盖。证据：S/native-change-manifest.json:1。
### patch/ 目录的复制链
- `patch/session-query-live-title-20260927/package.json:2` → @deepseek-ai/dsh-session-query（会话查询与活动标题）；与 app 现装 lib/index.js 不同或目标缺失。历史来源可见，当前完整落地不可仅凭副本确认。
- `patch/agent-team-mailbox-scan-20260927/package.json:2` → @deepseek-ai/dsh-experimental-agent-team（成员元数据、冻结、生命周期取消、邮箱/恢复）；与 app 现装 lib/index.js 同文。历史来源可见，当前完整落地不可仅凭副本确认。
- `patch/live-history-api-controller-20260927/package.json:2` → @deepseek-ai/dsh-api-session-controller（活动会话/历史 API 控制）；与 app 现装 lib/index.js 不同或目标缺失。历史来源可见，当前完整落地不可仅凭副本确认。
- `patch/agent-loop-runtime-context-20260927/package.json:2` → @deepseek-ai/dsh-agent-loop（session 事件读取/运行上下文一致性）；与 app 现装 lib/index.js 不同或目标缺失。历史来源可见，当前完整落地不可仅凭副本确认。
- `patch/session-title-live-title-20260927/package.json:2` → @deepseek-ai/dsh-session-title（活动会话标题）；与 app 现装 lib/index.js 同文。历史来源可见，当前完整落地不可仅凭副本确认。
- patch/milestone-only-compaction.cjs 与 patch/settlement-guard.cjs 是补丁脚本而非 profile 插件；是否最后一次执行、是否覆盖后续实现未证实。证据：两文件:1。

## 功能域：规模、耦合、重复和残留
- 下列域统计只对 web 的本地闭包，按文件名/路径单归类，跨域大文件不拆分，避免重复计算；不是全项目行数。逐文件归属可据上表与命名复算。
- team/治理：27 文件/30358 行（上表各文件:1）。
- 上下文/window：27 文件/7801 行（上表各文件:1）。
- PTC：5 文件/538 行（上表各文件:1）。
- 证据/审计：14 文件/5610 行（上表各文件:1）。
- 看板/goal：13 文件/3112 行（上表各文件:1）。
- UI/预设：8 文件/1946 行（上表各文件:1）。
- room：2 文件/2054 行（上表各文件:1）。
- team 调度：team-tools 8436 + runtime 4140 + control-plane 5184 行横跨工具、权限、持久化、goal 和 room；不是小插件组合。工具依赖 policy/control-plane/room-wake/delivery/milestone，重构需先切稳定服务边界。证据：P/team-tools-v2-r10.mjs:26-43；P/team-v12-runtime.mjs:15-32。
- room：room-wake 独立 2005 行但决议还经过 tools、control-plane、idle-watch 和 event-continuation；多套唤醒/恢复易重复调度，幂等机制不是完全缺失（message-operation 已存在）。证据：P/team-tools-v2-r10.mjs:35-39；P/team-v14-event-continuation.mjs:544-560；P/team-idle-watch-v6.mjs:847。
- 看板/goal：plan-delivery、delivery-service、goal-delivery、requirements、hypothesis/proof/identity 分散；又依赖原生 goal、tool-goal、goal-round-driver。相同“交付/身份/计划”概念跨层出现是边界重叠，是否语义重复需逐契约验证。证据：P/team-v12-runtime.mjs:32；A/dsh-goal-round-driver/lib/index.js:1；S/native-change-manifest.json:1。
- 上下文/window：step-compaction、milestone、window-manager、wiring/executor、context-workspace 并存；manager shadow ≠ executor 未运行。W1/W2/W3 不是三个独立已挂载插件，具体折叠级别由状态/配置决定，实际 session 转换未证实。证据：web/cordis.patch.yml:28,47,58；P/team-v15-window-wiring.mjs:140-154；P/step-compaction-v4.mjs:34-41。
- PTC：ptc-sdk-retention、v16 capability catalog 和预设重放会影响 SDK/提示；原生 ptc-runtime-node 另有 pnpm 修补。team-v15-ptc-background 存在但不是四 profile 的静态现役。证据：web/cordis.patch.yml:16,957,1471；app/pnpm-workspace.yaml:300；P/team-v15-ptc-background.mjs:1。
- 证据/审计：reducer、evidence-scheduler、usage ledger、team-usage、cache-monitor、failure-memory、telemetry 有多套落盘/用量投影，不能把这些“账本”强行视为一份真相；需统一 identity/retention。证据：P/evidence-reducer.mjs:25,158-161；P/team-usage.mjs:168,197；P/request-usage-ledger.mjs:210。
- UI：pnpm Team 面板 diff 6097 行，另有原生 chat/conversation 覆盖、Reducer 设置 client 和多个 persona/replay 预设；web 与 desktop 相同，headless 未挂这些 UI 入口。证据：web/patches/@deepseek-ai__dsh-experimental-client-ui-agent-team@0.1.7-rc.2.patch:1；P/evidence-reducer-ui/index.js:1-2；web/cordis.patch.yml:1004,1336,1383。
- 部署工具代码量（glob 直接子文件，源码后缀 mjs/cjs/js/ps1/py/sh，排除 bak）：tools/ 共 62 文件/5823 行，S/tools/ 共 106 文件/12020 行，均用 read.totalLines 求和；不计下载浏览器、node_modules 和测试产物。证据：tools/clm-hmr-team-v10b.mjs:1；S/tools/deploy-production.mjs:1；两目录其余直接源码:1。
- 部署工具：tools/ 下含 HMR v6/v7b-e/v8/v9/v10/v10b、迁移和 session 修复脚本；S/tools/deploy-production 系列含 plan/apply/rollback，属于运维代码不是插件。未执行这些工具，不能据文件名推断当前宿主状态。证据：tools/clm-hmr-team-v10b.mjs:1；tools/compact-session-command-outputs.mjs:190-191；S/tools/deploy-production.mjs:1-7。

## 性能疑点（代码证据，不是实测结论）
| 优先级 | 证据（P 默认 web） | 风险与已有缓解 |
|---|---|---|
| 高 | P/team-control-plane.mjs:41,1483,1669,1780-1785 | 同步 write+fsync、冷存储整块读取、重复 stringify 对比；阻塞事件环风险；已有 signature/raw cache，不能说每次都全读。 |
| 高 | P/team-v12-runtime.mjs:476-493,1751,1792 | 同步快照 JSON 读写；消息内容 stringify 搜索、JSON roundtrip 拷贝，随团队/历史体积增长。 |
| 高 | P/team-usage.mjs:229-255,267-271 | 冷缓存全文件同步读取和 journal 解码；每次 collect 仍枚举会话目录；已有 mtime/size 缓存、settle 和增量读取，不支持“每次请求全量扫描”断言。 |
| 中高 | P/evidence-reducer.mjs:275-305,561 | 工具 post-execute 路径可能递归枚举会话目录（最多 4 层）；journal 为有界 tail 32 帧/512KiB/4MiB，不是无限全读。 |
| 中高 | P/team-idle-watch-v6.mjs:815,847-856；P/team-v14-event-continuation.mjs:550-560 | 多个周期任务；continuation 可遍历所有 agents 且逐个启动 promise；实际 scanMs 是否启用需看配置。已 unref/dispose，不可直接断言 timer 泄漏。 |
| 中 | P/team-v12-room-wake.mjs:106,418 | JSON 深拷贝和 stringify 全值比较；room 文档增长会放大成本，需测调用频次。 |
| 中 | P/team-v15-window-wiring.mjs:68,205,210 | 每条 window note 同步 append，baseline 序列化后又 stringify 计算 bytes；指定 session 范围缓解，非所有请求必经。 |
| 中 | P/evidence-reducer.mjs:158-161,397 | 证据归档/设置同步读写；需观察长结果和重复输出是否重复落盘，未测吞吐。 |
| 反证/改善 | app/patches/@deepseek-ai__dsh-session-query-sqlite@0.1.7-rc.2.patch:9-23 | 已去掉 detachedEvents 全量 clone/事件全量指纹；仍构建搜索 documents，不能据旧文档继续报告原始 clone 热点。 |
- 未运行 benchmark/宿主，不给毫秒、CPU/内存占用或瓶颈占比；优先用冷/热缓存、journal/room 大小、agent 数、扫描周期、序列化字节数作离线基准。

## 死候选、版本残留与来源差异
- 零入边死候选精确 134，定义见口径；完整按 profile 分组列在下一行（每项都是该路径:1）；禁用插件如 usage-projection 虽不可达但有 YAML 引用，不计入零入边。证据：web/cordis.patch.yml:478-480。
- web 零入边列表（前缀 `home/profiles/web/`，每项 `:1`）：`plugins/session-plan-delivery.mjs:1`、`plugins/team-v15-ptc-background.mjs:1`、`plugins/verifier-native-capability.mjs:1`、`plugins/team-v15-window-economics-runtime.mjs:1`、`plugins/desktop/team-tools-v2-r10.mjs:1`、`plugins/teamtest/team-tools-v2-r10.mjs:1`、`plugins/web/team-tools-v2-r10.mjs:1`、`plugins/desktop/team-v12-runtime.mjs:1`、`plugins/teamtest/team-v12-runtime.mjs:1`、`plugins/web/team-v12-runtime.mjs:1`、`plugins/desktop/team-v14-event-continuation.mjs:1`、`plugins/teamtest/team-v14-event-continuation.mjs:1`、`plugins/web/team-v14-event-continuation.mjs:1`、`plugins/team-message-time.mjs:1`、`plugins/team-operator.mjs:1`、`plugins/team-v13-auto-research.mjs:1`、`plugins/team-v13-cost-attribution.mjs:1`、`plugins/team-v12-integration.mjs:1`、`plugins/team-operator-v4.mjs:1`、`plugins/team-idle-watch-v5.mjs:1`、`plugins/team-operator-v3.mjs:1`、`plugins/team-idle-watch-v4.mjs:1`、`plugins/team-operator-v2.mjs:1`、`plugins/step-compaction.mjs:1`、`plugins/step-compaction-v3.mjs:1`、`plugins/team-tools-v2-r5.mjs:1`、`plugins/team-tools-v2-r4.mjs:1`、`plugins/team-tools-v2-r3.mjs:1`、`plugins/team-preset-hot-reload.mjs:1`、`plugins/team-tools-v2-r2.mjs:1`、`plugins/team-tools-v2.mjs:1`、`plugins/team-idle-watch-v2.mjs:1`、`plugins/team-idle-watch.mjs:1`、`plugins/action-fusion.mjs:1`、`plugins/observation-pack.mjs:1`。
- headless 零入边列表（前缀 `home/profiles/headless/`，每项 `:1`）：`plugins/session-plan-delivery.mjs:1`、`plugins/team-v15-ptc-background.mjs:1`、`plugins/verifier-native-capability.mjs:1`、`plugins/team-v15-window-wiring.mjs:1`、`plugins/team-v15-window-economics-runtime.mjs:1`、`plugins/headless/team-v12-runtime.mjs:1`、`plugins/headless/team-tools-v2-r10.mjs:1`、`plugins/headless/team-v14-event-continuation.mjs:1`、`plugins/team-message-time.mjs:1`、`plugins/team-operator.mjs:1`、`plugins/team-v13-auto-research.mjs:1`、`plugins/team-v13-cost-attribution.mjs:1`、`plugins/team-v12-integration.mjs:1`、`plugins/team-idle-watch-v2.mjs:1`、`plugins/team-idle-watch-v4.mjs:1`、`plugins/step-compaction.mjs:1`、`plugins/action-fusion.mjs:1`、`plugins/observation-pack.mjs:1`。
- desktop 零入边列表（前缀 `home/profiles/desktop/`，每项 `:1`）：`plugins/session-plan-delivery.mjs:1`、`plugins/team-v15-ptc-background.mjs:1`、`plugins/verifier-native-capability.mjs:1`、`plugins/team-v15-window-economics-runtime.mjs:1`、`plugins/desktop/team-tools-v2-r10.mjs:1`、`plugins/teamtest/team-tools-v2-r10.mjs:1`、`plugins/web/team-tools-v2-r10.mjs:1`、`plugins/desktop/team-v12-runtime.mjs:1`、`plugins/teamtest/team-v12-runtime.mjs:1`、`plugins/web/team-v12-runtime.mjs:1`、`plugins/desktop/team-v14-event-continuation.mjs:1`、`plugins/teamtest/team-v14-event-continuation.mjs:1`、`plugins/web/team-v14-event-continuation.mjs:1`、`plugins/team-message-time.mjs:1`、`plugins/team-operator.mjs:1`、`plugins/team-v13-auto-research.mjs:1`、`plugins/team-v13-cost-attribution.mjs:1`、`plugins/team-v12-integration.mjs:1`、`plugins/team-operator-v4.mjs:1`、`plugins/team-idle-watch-v5.mjs:1`、`plugins/team-operator-v3.mjs:1`、`plugins/team-idle-watch-v4.mjs:1`、`plugins/team-operator-v2.mjs:1`、`plugins/step-compaction.mjs:1`、`plugins/step-compaction-v3.mjs:1`、`plugins/team-tools-v2-r5.mjs:1`、`plugins/team-tools-v2-r4.mjs:1`、`plugins/team-tools-v2-r3.mjs:1`、`plugins/team-preset-hot-reload.mjs:1`、`plugins/team-tools-v2-r2.mjs:1`、`plugins/team-tools-v2.mjs:1`、`plugins/team-idle-watch-v2.mjs:1`、`plugins/team-idle-watch.mjs:1`、`plugins/action-fusion.mjs:1`、`plugins/observation-pack.mjs:1`。
- teamtest 零入边列表（前缀 `home/profiles/teamtest/`，每项 `:1`）：`plugins/team-v16-capabilities-runtime.mjs:1`、`plugins/team-v12-runtime.mjs:1`、`plugins/team-idle-watch-v6.mjs:1`、`plugins/team-operator-v5.mjs:1`、`plugins/session-plan-delivery.mjs:1`、`plugins/team-v15-ptc-background.mjs:1`、`plugins/verifier-native-capability.mjs:1`、`plugins/team-v15-window-manager.mjs:1`、`plugins/constraint-ledger.mjs:1`、`plugins/team-v15-window-wiring.mjs:1`、`plugins/step-compaction-v4.mjs:1`、`plugins/team-v15-window-economics-runtime.mjs:1`、`plugins/team-v13-cache-monitor.mjs:1`、`plugins/desktop/team-tools-v2-r10.mjs:1`、`plugins/teamtest/team-tools-v2-r10.mjs:1`、`plugins/web/team-tools-v2-r10.mjs:1`、`plugins/desktop/team-v12-runtime.mjs:1`、`plugins/teamtest/team-v12-runtime.mjs:1`、`plugins/team-health.mjs:1`、`plugins/team-runtime-guard.mjs:1`、`plugins/web/team-v12-runtime.mjs:1`、`plugins/desktop/team-v14-event-continuation.mjs:1`、`plugins/teamtest/team-v14-event-continuation.mjs:1`、`plugins/web/team-v14-event-continuation.mjs:1`、`plugins/team-message-time.mjs:1`、`plugins/team-agentteam-mailbox-compaction.mjs:1`、`plugins/compatibility-health.mjs:1`、`plugins/evidence-reducer-ui/index.js:1`、`plugins/action-fusion-v2.mjs:1`、`plugins/team-v13-auto-research.mjs:1`、`plugins/team-v13-cost-attribution.mjs:1`、`plugins/team-v12-integration.mjs:1`、`plugins/team-operator-v4.mjs:1`、`plugins/team-idle-watch-v5.mjs:1`、`plugins/team-operator-v3.mjs:1`、`plugins/team-idle-watch-v4.mjs:1`、`plugins/team-operator-v2.mjs:1`、`plugins/step-compaction-v3.mjs:1`、`plugins/team-tools-v2-r5.mjs:1`、`plugins/team-tools-v2-r4.mjs:1`、`plugins/team-tools-v2-r3.mjs:1`、`plugins/team-preset-hot-reload.mjs:1`、`plugins/team-tools-v2-r2.mjs:1`、`plugins/team-tools-v2.mjs:1`、`plugins/team-idle-watch-v2.mjs:1`、`plugins/observation-pack.mjs:1`。
- 同名跨版本实载的强证据：teamtest 的 team-operator.mjs:21 仍 import team-tools-v2-r6.mjs，同时该 profile YAML:168 直接挂 r10；因此 T 的 r6（3914 行）不能当死代码删。
- 版本残留：web 下 team-tools-v2 与 r2…r9 不因最新 r10 被挂载而自动生效；相同旧实现可能仍由其他旧文件导入。T 老 step/idle/operator 实际仍有挂载，不能全仓一刀切删除旧后缀。证据：web/cordis.patch.yml:347；teamtest/cordis.patch.yml:187,199,213；P/team-tools-v2-r9.mjs:1。
- plugins/web、plugins/desktop、plugins/teamtest、headless/plugins/headless 内还有同名 team-tools/control-plane/runtime 等嵌套副本，配置指向上一级 plugins 不是这些子目录；它们是独立来源路径，不是别名。证据：web/cordis.patch.yml:347,370；P/web/team-tools-v2-r10.mjs:1；P/desktop/team-control-plane.mjs:1。
- staging/home/profiles 下是开发来源镜像，未列为生产入口；本报告逐项将 native manifest 来源与当前目标比较。lab-host-home、lab-runs、output 不当作生产配置；也没有依据这些夹具的 YAML 抬高现役计数。证据：S/tools/deploy-production.mjs:62-80。

## 未证实与重构前需冻结的契约
- 实际运行 profile、插件注入成功、动态 import/客户端加载器的完整资源图、宿主最后一次 HMR 代、W1/W2/W3 的真实 session 覆盖、所有包相对官方 tarball 的完整差异均未证实；没有启动宿主进行补证。
- 建议先固定“配置 → 插件闭包 → 原生文件 → patch/覆盖渠道”锁定清单，再拆 team-control-plane/工具层；先统一存储和唤醒幂等接口，最后调整 UI。不要先按死候选列表删除文件。证据：P/team-tools-v2-r10.mjs:34-43；S/tools/deploy-production.mjs:36-80。
