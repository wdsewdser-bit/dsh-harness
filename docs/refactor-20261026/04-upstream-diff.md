# 上游差异与迁移评估：DSH 0.1.7-rc.2 → 0.2.1-rc.4

日期：2026-10-26。方式：安装产物静态只读分析；未启动宿主、未执行 git、未联网或安装依赖。仅写本报告。

## 1. 结论先行

1. **新版确实支持同一长回合内、每一步之前压缩历史；不必等 idle。** 循环每次调用 preStep，后者派发 agent/pre-step；compaction-basic 在该钩子调用 compactIfNeeded，再由会话 surface 生成下一请求。证据：N/dsh-agent-loop/lib/index.js:902–926、953–980、1273–1288；N/dsh-compaction-basic/lib/index.js:834–852、925–956。
2. **这不是此次升级才新增的能力。** O/dsh-agent-loop/lib/index.js:952–977、1004–1009 和 O/dsh-compaction-basic/lib/index.js:859–880 已有同类钩子。当前 web 配置也明确 auto:true、thresholdRatio:0.75（W:875–898）。187 步不结束首先是折叠触发策略、作用域或预算信息问题，不能把“升级”当作根治证明。
3. **Agent Team profile 在旧安装中就存在，并非 0.2.1 新增。** 两侧均有 domain/profile/tools/UI 四包；新版是 profile bundle 开关，不是已证实的每会话 mode。N/dsh-experimental-agent-team-profile/README.md:28–61、cordis.patch.yml:4–32；脚本包清单见第 3 节。
4. **Team 的邮件语义发生重要变化，历史兼容不等于继续投递。** 新发送交给目标 Agent inbox/Steer；旧 team/message/queued、delivered 仅可重放，历史未送达邮件不会由 Team 补送。N/dsh-experimental-agent-team/README.md:128–148。应迁移投递账本，不能直接删除自研可靠投递层。
5. **升级对象不是可验证的纯净旧上游。** 旧安装包含 nativeSessionBridge、定制压缩保留参数、恢复引用和 goal 完成门禁，新版没有对应实现；不能把这些消失全部归为上游 breaking change。O/dsh-compaction-basic/lib/index.js:7、24–25、983 起；O/dsh-compaction-tool-result-pruner/lib/index.js:5–17、176 起；O/dsh-goal/lib/index.js:720–744。必须先把自研语义从旧包里提取成插件。

## 2. 证据口径与限制

- O = D:/dsh-test/app/node_modules/@deepseek-ai/。
- N = E:/Codex-Runs/dsh-upstream-0.2.1-rc.4/install/node_modules/@deepseek-ai/。
- W = D:/dsh-test/home/profiles/web/cordis.patch.yml；H = 同路径 headless/cordis.patch.yml。
- L = D:/dsh-test/home/profiles/web/plugins/。
- 文中“路径:行号”均为实际读取的发布文件，不把 README 链接里的 src/*.ts 当成本地存在的源码证据。
- 包差异由 Node 脚本 readdirSync + package.json 的 name/version 计算；没有按目录数手算。旧 pnpm 链接通过文件系统读取，未写入。
- **“新增/缺失”指给定两个安装快照的包集合，不证明 npm 上游停止发布或仓库删除。** 也未取得未改动的 0.1.7 发布归档，因此无法剥离全部本地补丁。
- 对 10 个顶层缺失名额外做了有深度上限的 npm 嵌套目录检查，未找到；不能据此证明全仓库删除。
- 对配置仅能证明声明/覆盖关系，不能证明正在运行的 profile、实际挂载成功或运行行为。无宿主测试，相关结论标“未证实”。

## 3. 包级差异（脚本结果）

### 3.1 总量及版本

| 项目 | 结果 |
|---|---|
| 旧 / 新 @deepseek-ai 顶层可读 package.json | 283 / 306 |
| 共有 / 新增 / 旧有而新快照缺失 | 273 / 33 / 10 |
| 共有 DSH 包 | 263 个：0.1.7-rc.2 → 0.2.1-rc.4 |
| 已证实改名 | 0；不能把删除+新增凭名称相似强行配对 |

共有基础包版本：cordis 4.0.4→4.0.5；cordis-plugin-group 1.0.4→1.0.5；cordis-plugin-include 1.0.9→1.0.10；cordis-plugin-loader 1.0.5→1.0.6；cordis-plugin-timer 1.1.6→1.1.7；cosmokit 1.8.5→1.8.6；schemastery 3.18.4→3.18.5；libreoffice-kit、libreoffice-kit-win32-x64 均 0.1.1→0.1.5；node-addon-system 保持 0.1.2。
版本行样例：O/N/cordis/package.json:4；O/N/cordis-plugin-loader/package.json:4。

以下清单省略统一前缀 @deepseek-ai/；新增项版本均为 0.2.1-rc.4，缺失项旧版本均为 0.1.7-rc.2。

### 3.2 新增 33 包：按功能域分组

| 功能域 | 新快照独有包 |
|---|---|
| API / 网络（2） | dsh-api-remote-access；dsh-web-deepseek-api |
| 客户端/UI（7） | dsh-client-product-analytics；dsh-client-ui-deepseek-model-label-1017；dsh-client-ui-entry-customization；dsh-client-ui-plugin-market；dsh-client-ui-secret-mask；dsh-client-ui-settings-session-log；dsh-experimental-client-ui-cot-translation |
| 插件市场（4） | dsh-plugin-market；dsh-plugin-market-index；dsh-experimental-plugin-market-bundle；dsh-experimental-badge-skill-bundle |
| 检查、检索、命名及开发上下文（7） | dsh-experimental-inspector；dsh-experimental-inspector-profile；dsh-experimental-session-inspector；dsh-experimental-session-search；dsh-experimental-session-titles-bundle；dsh-session-title-all-prompts-llm；dsh-harness-dev-context |
| 观测（2） | dsh-host-product-telemetry-otel；dsh-otel |
| 自动工作流/翻译（3） | dsh-experimental-ralph-bundle；dsh-experimental-cot-translation-bundle；dsh-experimental-translator |
| 工作树、目录、终端、调度（8） | dsh-experimental-terminal-bundle；dsh-experimental-tool-worktree；dsh-experimental-worktree；dsh-tool-schedule；dsh-tool-session-query；dsh-tool-terminal；dsh-tool-working-directory；dsh-working-directory |

### 3.3 新快照缺失 10 包

| 功能域 | 旧快照独有包 | 判断 |
|---|---|---|
| UI 基础设施（3） | dsh-client-store；dsh-client-ui-primitives；dsh-client-ui-slots | 运行时打包/分发变化的可能性高，未证实删除 API；新版 conversation 的 devDependencies 仍引用三者（N/dsh-client-ui-conversation/package.json:60、63、68） |
| Hooks / 集成（5） | dsh-hook-protocol；dsh-hooks-claude-code；dsh-hooks-codex；dsh-webhook；dsh-webhook-github | 新安装中缺失；有无替代/不再发布未证实 |
| 不变量（1） | dsh-invariants | 缺失，迁移去向未证实 |
| 子代理驱动（1） | dsh-subagent-in-process-driver | 缺失；spawn/fork/provider 能力仍在，不能认定一对一改名 |

### 3.4 team / room / mailbox / subagent 名称全量筛选

两侧共有：dsh-experimental-agent-team、dsh-experimental-agent-team-profile、dsh-experimental-tool-agent-team、dsh-experimental-client-ui-agent-team、dsh-subagent、dsh-subagent-fork-in-process、dsh-subagent-spawn-in-process、dsh-tool-subagent、dsh-tool-subagent-control、dsh-client-ui-subagent、dsh-client-ui-settings-subagent。
旧侧另有 dsh-subagent-in-process-driver；新侧无新增匹配名。两侧均无名字含 room 或 mailbox 的独立包。
内容层另检索 Team 类型：mailbox 是历史兼容数据，不是新邮箱服务（N/dsh-experimental-agent-team/lib/types/types.d.ts:105–113、198）。未发现等价于自研 room 的公开 Team API；此结论限已检查的 Team 声明与说明。

复核算法（本次已执行等价内联 Node 脚本；没有生成脚本文件）：

~~~js
const fs = require('fs');
const snapshots = roots.map(root => Object.fromEntries(
  fs.readdirSync(root)
    .filter(n => fs.existsSync(root + '/' + n + '/package.json'))
    .map(n => {
      const j = JSON.parse(fs.readFileSync(root + '/' + n + '/package.json', 'utf8'));
      return [n, { name: j.name, version: j.version }];
    })
));
const [oldPkgs, newPkgs] = snapshots;
const added = Object.keys(newPkgs).filter(n => !oldPkgs[n]);
const missing = Object.keys(oldPkgs).filter(n => !newPkgs[n]);
const common = Object.keys(oldPkgs).filter(n => newPkgs[n]);
// 输出 added / missing、common 的版本对分组，以及 /team|room|mailbox|subagent/ 筛选。
~~~

## 4. 上游 Agent Team：启用、架构与替代边界

### 4.1 启用是 profile layer，不是会话模式

- 上游文档方式是 dsh plugin --profile <name> add @deepseek-ai/dsh-experimental-agent-team-profile；依赖先有 dsh-base。这里只记录命令，未执行（N/...profile/README.md:28–43）。
- bundle 写入 profile 的 dsh.profile.bundles；Web/Desktop Plugins 页面同一开关控制工具和 UI（同文件:45–61）。
- layer 禁用四个默认 subagent 工具行，插入 agent-team、tool-agent-team、ui-agent-team；配置 maxMembers:8、maxTasks:256、maxMessageBytes:65536、disposalTimeoutMs:5000（N/...profile/cordis.patch.yml:4–32）。
- **建议的“单独 Team 模式、默认关闭”是本项目产品设计，而不是已存在的上游会话 mode。** 最稳妥先独立 team profile；若要同宿主逐会话切换，需要验证 service realm、工具可见性和 UI scope，不能只隐藏按钮。
- Team 根身份是普通 runtime root 的隐式 Lead，TeamId=SessionId；启用服务后并非另行创建一个特殊根类（N/dsh-experimental-agent-team/README.md:124–126）。

### 4.2 架构和现成能力

| 层 | 上游能力与证据 |
|---|---|
| 持久化域 | Lead 日志记录 team/member、team/task；先 append+flush 再报告成功。投影导出 roster/task board（N/dsh-experimental-agent-team/README.md:104–107、134–148、172–176） |
| 生命周期 | Lead 独占 spawn/assign/interrupt；fresh 无 Lead 历史，fork 只取已完成回合前缀；provisioning/failed 持久化、冷恢复；名称永久占用（同文件:58–64、124–126） |
| 调度与通信 | 目标 Agent 的 steer/inbox，continuation owner 做目标锁定、冷恢复和授权；兄弟通信不冒充 Lead（同文件:128–132） |
| 看板 | 任务依赖 DAG、expectedRevision CAS、claim/complete/release/reopen/assign、删除墓碑；writeScopes 只产生重叠警告（同文件:72–78、134–136） |
| 等待/中断 | waitForChange 等待一次变动，调用方重读状态；Lead 中断保留 inbox，不释放 task ownership（同文件:138–140） |
| UI | roster、task board、跳转 teammate session；复用会话投影（N/...profile/README.md:49–61；N/dsh-experimental-agent-team/README.md:172–176） |
| 底层子代理 | activation/provider 与 continuation；默认 maxActiveSubagents:8，容量超限拒绝、不排队，父代理等待子代理仍占其自身槽位（N/dsh-subagent/README.md:51–61） |

新版并不保证应用级 exactly-once：发送成功只表明 inbox 接受，不是已由模型处理，也非独立同步 flush；无未接受意图持久重试、显式重发去重或 Team 层全局顺序（N/dsh-experimental-agent-team/README.md:66–70、128–146）。
旧说明曾承诺离线排队、不丢不重（O/dsh-experimental-agent-team/README.md:67–69）；新版必须按新的实际契约迁移，而非沿用旧注释。

### 4.3 和生产自研 Team 的对照

| 自研功能/配置证据 | 能否直接替代 | 建议 |
|---|---|---|
| 基础 roster、fresh/fork、简单成员通讯、基础看板；W:108–120、314–330、346–350 | 大部分可用上游，但先适配权限/投递语义 | 删除重复基础实现，不删除附加约束 |
| tier/分组/verifier、冻结与活跃名额；W:308–344；H:224–247 | 不可直接替代：上游平面 Lead/teammate，名额包含永久 roster/失败成员 | 保留 team-policy，显式区分 roster、活跃槽位、业务名额 |
| write-scope guard；W:122–142 | 不可：上游 writeScopes 仅提示 | 重写为 fs 意图事件的标准硬约束插件，保持 fail-closed |
| room、maxRoomRounds、受控唤醒与回执；W:343、346–365；H:246–251 | 未发现等价 room/轮数协议；上游只有通用消息/等待 | 保留 room 域，不把普通 sendMessage 当 room 协议 |
| v12 runtime、v14 event/context delivery、memory anchor；W:157–194、369–400 | 上游有冷恢复与身份基础，不等价于本项目上下文交付与恢复债 | 依赖上游生命周期，保留业务契约/账本，去掉双重调度 |
| 自研 Team panel / operator / health；W:157–194、482–490 | 上游 UI 只覆盖基本 roster/board | 基础列表可替换；业务健康、审计、人工操作保留为独立 UI 插件 |
| mailbox-compaction；W:403–414 | 新邮件路径可能不再需要，但旧邮件仍在日志 | 先盘点 queued-minus-delivered、完成一次性对账，再退役 |
| goal driver、计划完成门禁；O/dsh-goal/lib/index.js:720–744 | 上游目标续轮可复用，定制完成门禁不能假定存在 | 从 goal 包内补丁抽离；完整性门禁标准扩展面未证实 |

## 5. 上下文、压缩与 187 步长回合

### 5.1 精确回答“每一步前能否改写请求历史”

**能，但方式是 pre-step 中提交持久化 surface 替换/压缩，再让 loop 派生历史；不是直接修改一个可变的完整 messages 数组。**

1. 每步边界：N/dsh-agent-loop/lib/index.js:953–959 在 while 内调用 preStep；902–920 的 agent/pre-step 是可 await 的 waterfall。
2. 钩子契约：N/dsh-agent/lib/types/runtime-types.d.ts:92–99、293–310；可 reject 或替换本步待接纳 UserMessage[]，并可声明 startsRequestSeries。payload.messages 是从 inbox claim 的输入，**不是完整历史**。
3. 真实改写示范：N/dsh-compaction-basic/lib/index.js:839–851 await compactIfNeeded；450–482 允许 open-turn 自动压缩，记录 compaction/start、摘要、commitCompactionBody；925–956 先剪枝、再测量、选区并 compactRegion。
4. 请求最终来自 session.deriveMessages()，冻结消息、数组和 envelope（N/dsh-agent-loop/lib/index.js:1273–1288）。因此在 llm/stream 中原地改 agent-loop 请求并非标准历史投影接口。
5. pre-step 不等于每次网络 retry：同一步 retry 复用已绑定 assembly/decision；见 N/dsh-agent-loop/README.md:118–122。溢出恢复另由 agent/request-error 完成（N/dsh-compaction-basic/lib/index.js:861–886）。

**未发现独立、公开的“任意完整请求历史 projection waterfall”。** runtimeContext.project、systemPrompt.project 是具体投影流程，不应把名称带 projection 的内部函数视作可替换请求 API。自研 request-message-projection 实际包装 adapterStream/forAdapter（L/request-message-projection.mjs:243–292），属高风险适配。

### 5.2 各包实质变化

| 包 | 核对结论 |
|---|---|
| dsh-compaction | 两版 lib/index.js 均 175 行，逐行集合差异仅说明链接注释；未见本入口运行逻辑改变（O/N:137–138）。不扩张为全包逐字相同 |
| dsh-compaction-basic | pre-step 自动压力压缩和 overflow retry 两版都有；新版 auto 默认 true、thresholdRatio 默认 .8（N:15、85、839–886）。本地旧版 manualRetainTokens/overflowRetainTokens、native bridge、pruneDurably 在新版缺失（O:24–25、983 起；N:932、943） |
| dsh-compaction-tool-result-pruner | 仍做头尾剪枝；旧版带 sourceHash/sha256/locator 的 tool-result-recovery 引用，新版变为普通 pruneContent(original.content)（O:5–17、105–120、176–179；N:91–111、151）。恢复定位语义不能无声丢失 |
| dsh-compaction-image-offload | request-error 钩子仍在；新版显式检查 signal.aborted，不在已取消请求上继续 offload（O/N/lib/index.js:141–142） |
| dsh-command-compact | 两版 lib/index.js 完整文本相同，均 102 行。/compact 调 compactNow（N:48–70）；手动路径拒绝 open turn（N/dsh-compaction-basic/lib/index.js:456–460），不能用手动命令解决持续运行根回合 |
| dsh-agent-loop | pre-step 存续；新版 runtime context fallback 在 pre-step listener 运行后才 project（N:909–919；O:960–968），避免在插件修改 surface 前绑定旧上下文；系统提示词按 prepared route 能力接纳（N:1057–1078） |
| dsh-goal | 新版公开 complete/block（N/lib/types/index.d.ts:108–121）；旧安装 native/ptc-job、delivery-required、goal-policy-required 等完成门禁不在新版实现中（O/lib/index.js:720–744）。这是本地语义差异，不冒称纯上游删除 |
| dsh-goal-round-driver | 新增等待子代理再续轮；上限、排队失败、pre-step 拒绝会 block 并给原因，不再只日志/disarm（N/lib/index.js:129–140、169–171、291–351；O:124–126、312–314） |

### 5.3 根因判断与建议落点

- **已证实**：本项目并非完全没有 mid-turn 配置：W:883–888 已启用上游 auto:true / .75；H:283–307 的自研 step-compaction 也设 enablePreStep:true。
- **已证实**：自研 pre-step 当前有预算拒绝/重试职责，不等同于每步主动折叠（L/step-compaction-v4.mjs:1336–1358）；window-wiring 另有 prepend/global pre-step guard（L/team-v15-window-wiring.mjs:122）。
- **未证实的现场原因**：187 步是否命中压缩阈值；该根会话是否使用这两个 preset；token meter/model contextWindow 是否有效；scope/list 是否把根代理排除；是否先被其他 waterfall 拒绝或桥接锁阻断。未提供该次日志，不能定案。
- 新架构将“压力硬预算”放每步边界；milestone/idle 折叠只作经济优化。不要继续让“任务完成/空闲”成为唯一压缩入口。
- 上游压力压缩失败会 warn 后 next()，并非 fail-closed（N/dsh-compaction-basic/lib/index.js:843–851）；仍需独立预算守卫。无可压区、模型窗口缺失、摘要失败也须可观测。
- 单一步工具执行内部没有安全中断压缩的证据；“mid-turn”这里明确指相邻模型步骤之间，不是在任意工具副作用中切历史。

## 6. 插件接口、LLM 与客户端 breaking 风险

| 扩展面 | 新版状态 / 迁移结论 |
|---|---|
| Cordis 注册 | 框架仍在，非换框架；4.0.4→4.0.5，loader 1.0.5→1.0.6。service class static inject/Config 与函数 name/inject/apply 仍可见（N/dsh-compaction-basic/lib/index.js:801–828；N/dsh-goal-round-driver/lib/index.js:26、377）。loader 内部完整 breaking 清单未证实 |
| 声明组合 | profile cordis.patch.yml、id-target override/disable/insert、cordis:group/isolate 仍有实际用例（N/...agent-team-profile/cordis.patch.yml:4–32；W:875–898）。不要复制整个旧 preset，按能力组合，避免固定旧 row id 和遗漏新插件 |
| agent/pre-step | 公开 waterfall 保留，可换待接纳消息/reject/startsRequestSeries；scope-filtered，agent 局部监听只接收相应代理事件；主机 global 监听需显式验证覆盖范围（N/dsh-agent/lib/types/runtime-types.d.ts:293–310） |
| agent/request | 仍是配置 waterfall，不是历史改写（N/dsh-agent-loop/lib/index.js:1175–1208）。原有模型路由挂点可迁，但不能靠它返回 messages |
| inbox API | 新版 send/followup/steer/inject 的声明返回 void，旧安装允许 void 或 Promise（O/N/dsh-agent/lib/types/runtime-types.d.ts:186、192、200、209）。调用方不能把返回值当 durable receipt；Team 的异步 send 与底层同步 inbox 要分层 |
| LLM | llm/stream waterfall 保留（N/dsh-llm/lib/types/index.d.ts:35–45）；prepareCall 绑定 adapter/config，支持 configure 控制选择（同文件:395–407）。旧版已存在 prepareCall（O/dsh-agent-loop/lib/index.js:1252），不能描述为新版全新 API |
| 请求投影 | 新版冻结 deriveMessages/envelope；自研 adapterStream/forAdapter 包装不能算公共 API。PTC retention 已明确依赖该桥接而非普通 llm/stream 改写（L/ptc-sdk-retention.mjs:185–223）。迁移为 surface 变更或受支持 adapter；完整 request-only 投影标准钩子未证实 |
| 会话/投影 | session/event、surface、会话投影仍被官方压缩和 Team 使用；要以 append/标准事务维护可重放性，不能绕开日志直接改消息数组（N/dsh-compaction-basic/lib/index.js:450–484；N/...agent-team/README.md:142–148） |
| UI 模块 | 并非新出现整套 dsh-client-ui-*；旧版已有大量同名模块。新分发仍用 package.json exports ./client + dsh.client 注入图（N/dsh-client-modules/package.json:16–34；N/dsh-client-ui-conversation/package.json:29–41） |
| UI 业务扩展 | 用 Slot/Component Factory；renderer 负责 React/状态集成，业务插件不 import renderer 内部（N/dsh-client-ui-renderer/README.md:28–50）。独立全局面板通过 main keyed slot、ctx.layout.selectPanel；底栏有 shell.bottom（N/dsh-client-ui-layout/README.md:30–34） |
| UI 旧基础包缺失 | 不能据安装缺失断言 slots/store/primitives API 删除，因新版开发依赖仍引用。旧 UI 直接 import 私有包/深路径需重新打包验证，勿盲目映射到 renderer |

生产具体挂靠清单：W:9–39 的 request projection、constraint ledger、PTC retention、context-workspace、usage ledger；W:43–65 的窗口层；W:122–142 的 fs guard；W:227–229 的 tools/post-execute 观察压缩/校验；W:495–672 的 LLM、UI、agent-loop、subagent 覆盖；W:957–958、1290–1291 的 workflow-ptc。
其中 tools/post-execute、fs intent 的新版完整签名/返回短路顺序，本轮未做逐项实现审计，标**未证实兼容**；不因包仍存在就承诺插件可原样加载。

## 7. 迁移建议与三大风险

### 7.1 应退役或改用上游

- 简单 roster/基础看板/成员导航/基础 spawn-fork 与 continuation 生命周期：以官方 Team/Subagent 为基础，业务差异放外层，避免两套调度器共同拥有同一孩子。
- 通用压力压缩、overflow recovery、image-offload、/compact：使用官方链路。保留摘要业务模板、恢复债/原始工具证据定位和硬预算拒绝，但不再维护压缩事务的包内分叉。
- 旧 mailbox-compaction 与重投递循环：新会话不再沿用旧 Team mailbox 模型；历史积压完成审计迁移后才退役，不可升级时一刀删除。
- 基础 Team roster/board UI 使用上游；自研健康/room/验收 UI 另做模块，不 patch 官方打包 client.js。

### 7.2 应抽成标准插件

- team-policy / room / verifier / freeze / active quota：独立业务域插件，依赖公开 agentTeams/subagents；Team 模式启用才挂载。
- write-scope guard：独立强制权限插件，不能降级为看板 writeScopes 提示。
- context policy：将 milestone/window 决策、硬预算、summary anchors、恢复债拆开；标准 pre-step + 官方 compaction seam。自定义摘要可用 BasicCompaction.summarize（N/dsh-compaction-basic/lib/types/index.d.ts:20、43–60）。
- PTC：保留工作流/运行时本体与 SDK retention 策略分离；优先复用 dsh-workflow-ptc、dsh-ptc-runtime(-node)，先证实请求投影方案，再接入 retention。
- 约束/验收 ledger、完成门禁：作为独立业务契约；上游 goal.complete 的受支持否决接口未证实，不能为了“插件化”伪造一个不存在的 hook。
- UI：按 dsh.client 元数据与 Slot/Factory 封装；UI 不拥有调度/持久化真相。

### 7.3 风险最高的三处

| 优先级 | 风险 / 已见证据 | 必须通过的验收 |
|---|---|---|
| P0 | **上下文真相与可恢复性**：旧 native bridge、prune 恢复引用、window/预算/SDK request 投影相互依赖；新版请求冻结且移除旧安装定制行为（第 5–6 节） | 单回合 ≥200 步在非 idle 边界压缩；工具 call/result 配对；摘要/flush 失败可恢复；冷热重放派生一致；预算超限不得发送；原始证据可寻址 |
| P0 | **Team 投递和调度所有权**：新旧邮箱语义不同；只有 Lead 可创建；flat roster 与业务层级/冻结不等价（第 4 节） | 默认 profile 无 Team 工具/后台唤醒；Team profile 启用完整能力；历史未送邮件显式对账；重复重发/冷唤醒/取消有回执；scope guard 不失效 |
| P1 | **Goal/宿主/UI 私有耦合**：goal 包内完成门禁、adapter 私有包装及 UI 深导入不是稳定公共契约（第 5–6 节） | goal 等孩子、上限 block、取消不误续轮；PTC SDK保留不丢约束；Web/headless 服务隔离；UI 模块编译与释放；不复制旧官方 bundle 作为新基线 |

### 7.4 推荐顺序与最终准入

1. 先生成“本地补丁语义清单”：native bridge、goal gate、压缩恢复定位、异步 send 假设、UI 深导入。当前报告已证明旧安装非纯净比较基线，全部差异归因仍未证实。
2. 以 0.2.1-rc.4 组合建干净基线：默认 profile 不含 Team bundle、自研 team-* timer、room UI；普通压缩/权限/PTC 不依附 Team 身份。
3. 独立 Team profile 挂上游 bundle + 策略/room/写域/验收插件。若最终产品需要同宿主模式切换，再做 per-agent realm 设计并验证，不能把 profile 全局开关误当会话开关。
4. 先通过 ≥200 步长回合、恢复与权限测试，再迁历史 Team/goal/window 数据；缓存版本重建不等于业务邮件搬迁（N/...agent-team/README.md:146–148）。
5. 最后替换基础 UI、清理重复实现。未完成投递对账、恢复引用迁移、完成门禁适配前，不应删除对应自研部分。

**收敛结论：可升级并借用上游核心，但不是“装新版删 Team”。先抽离本地包内语义，再按默认普通 / 显式 Team 两种组合重建；长回合问题应优先修复每步压力链路的实际生效，而非继续围绕 idle 追加定时器。**
