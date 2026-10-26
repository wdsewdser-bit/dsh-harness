# DSH 0.1.6 兼容升级计划

**计划版本**：2026-09-15  
**目标目录**：`D:\dsh-test`  
**生产边界**：不修改、不重启 `D:\dsh` 当前实例  
**目标版本**：`dsh-v0.1.6-alpha.1` / npm `0.1.6-alpha.1`

## 1. 结论与升级策略

官方当前发布的是 `0.1.6-alpha.1` 预发布版，不是稳定版。`D:\dsh-test` 当前是混合依赖：

- `app` 根运行时为 `@deepseek-ai/dsh 0.1.5-rc.1`，锁文件中大量核心包为 `0.1.5-rc.2`。
- Web/Team profile 及其 lockfile 仍为 `0.1.5-alpha.2`。
- 自定义 Team v2 已经替换了内置 Team 工具，但仍有一个旧生命周期监听器和多份旧预设引用。

本次采用**主动适配**：以 0.1.6 的新接口为主，在我们自己的插件层保留必要的兼容降级，避免把业务规则重新交回上游默认实现。升级只在 `D:\dsh-test` 的测试运行时进行，先备份，再生成锁文件，再启动验证；生产目录不参与本轮变更。

## 2. 必须完成的改动（P0）

### 2.1 统一版本与锁文件

将 `app/package.json`、`app/package-lock.json`、`home/profiles/web/package.json`、`home/profiles/web/pnpm-lock.yaml`、`home/profiles/web/pnpm-workspace.yaml`、`home/profiles/teamtest/package.json` 统一到 `0.1.6-alpha.1`。

必须使用显式版本，不使用 `latest`：npm 的 `latest` 仍指向旧版本，实验性 Team 包的默认标签也未同步。升级后检查所有 `@deepseek-ai/dsh-*` 的实际解析版本，禁止出现 0.1.5 与 0.1.6 混装。

### 2.2 PTC 与工作流包名迁移

0.1.6 删除旧别名：

- `@deepseek-ai/dsh-workflow-worker-thread` -> `@deepseek-ai/dsh-workflow-ptc`
- 旧 code-runtime/worker-thread 配置按 0.1.6 的 `@deepseek-ai/dsh-ptc-runtime`、`@deepseek-ai/dsh-ptc-runtime-node` 及其服务名重新挂载。
- 搜索并处理 `workflow-worker-thread`、旧 PTC service id、E2B backend、Python PTC 配置；不能只更新 npm 依赖而留下 Cordis 行。

所有自定义预设都要扫描。未使用的历史备份可保留，但不能被当前 profile 加载；当前加载路径中发现旧包名时必须改名或显式禁用。

### 2.3 生命周期事件迁移

将 `home/profiles/web/plugins/team-runtime-guard.mjs` 的 `agent/session-start` 监听改为 `agent/created`。保留原有“provider 失败时阻断整个 Team”的逻辑，并让监听函数返回可等待的 Promise（若当前逻辑无异步操作则显式返回 `undefined`）。

全局扫描所有自定义插件和 patch，确保不再有依赖旧事件的本地代码。0.1.6 的 `agent/created` 是异步串行初始化，首次模型请求会等待它完成；不得在插件里绕过该顺序自行唤醒成员。

### 2.4 DeepSeek 官方 endpoint

`home/settings.yaml` 当前写的是旧官方根地址 `https://api.deepseek.com`。若保留官方 DeepSeek provider，改为 `https://api.deepseek.com/anthropic`；若该 provider 只作为备用且不使用官方适配器，则删除手工 `baseURL` 让 DSH 使用默认值。

OpenCode/CommandCode 等自定义 provider 的地址和密钥不在本次自动改写范围内，不打印、不复制密钥。

### 2.5 Team 工具冲突控制

继续保留自定义 `team-tools-v2.mjs` 作为唯一 Team 工具层：

- 保持 `tool-agent-team`、`tool-subagent`、`tool-subagent-fork` 等上游冲突行被禁用。
- 对 0.1.6 新增的 `tool-subagent-control`、`tool-subagent-list-agents` 以及可能的 Team profile 行做显式审计，禁止内置工具与 v2 同时挂载。
- 保持 `spawn_teammate`、`send_message`、`wait_agent` 等新命名；不恢复旧 `subagent`/`subagent_fork`。
- 保留本地 Team policy、write-scope、lease、room、review 汇总和 runtime guard；只修接口适配，不降低硬拒绝规则。

## 3. 应完成的兼容增强（P1）

### 3.1 Session 历史读取适配

0.1.6 弃用同步 `snapshotEvents`、`eventAt`、`ownEvents`。为验证脚本和诊断工具增加一个小型 history adapter：

1. 优先使用 0.1.6 的异步 SessionHandle/session-query 读取接口。
2. 仅在旧运行时存在时临时回退到同步接口。
3. 输出统一为现有验证器使用的事件数组，避免业务插件直接依赖 Session 内部实现。

Team 上游内部仍可能使用旧接口，因此第一阶段不改 `node_modules`；只改我们自己的 `verify/*.mjs`、诊断脚本和直接调用这些接口的插件。

### 3.2 Node PTC 执行环境审计

Node PTC 现在独立进程运行，`process.env` 为空，并受会话文件策略、输出和堆内存限制约束。审计所有 `run_code`/PTC 代码：

- 不从 `process.env` 读取业务必需路径、provider 或密钥。
- 通过显式参数、工作区文件或受控配置传递值。
- 对按次 timeout 使用 120 秒默认值，必要时不超过 600 秒。
- 验证输出截断、异常和取消都能回传给 Team 控制面。

宿主插件中用于定位 `DSH_HOME`、临时目录和 provider key 的 `process.env` 不属于 Node PTC，不做无关替换。

### 3.3 image offload 与缓存路径

Session/trajectory 解析器要允许新的 `image offload` 事件，不把它当未知事件丢弃。检查任何读取旧图片缓存目录的脚本，迁移到：

`DSH_HOME/cache/attachments/request-images`

旧缓存不自动删除；升级验证通过后再按需清理。

### 3.4 热更新失败闭环

0.1.6 取消热更新事务回滚：解析失败保留旧配置，插件激活失败可能部分生效。启动器和诊断脚本增加：

- patch 解析预检；
- 必需插件/可选插件加载结果记录；
- 部分激活时的明确失败标记；
- 修复配置后重新加载的确认步骤。

不能把“进程仍在监听端口”当作升级成功。

### 3.5 计量与验证基线

DeepSeek V4.1 的图片缩放和 token 估算发生变化。重新记录 Team token、图片字节、压缩次数、工具调用次数和完成率基线；旧报告只作为历史记录，不能直接比较升级前后效率。

## 4. 不需要重写的部分

- `team-tools-v2.mjs` 和 `team-health.mjs` 已使用 `agent/created`，方向正确。
- Team control-plane、write-scope、角色文件、room/lease/task 状态属于本地业务层，原则上不随上游实现重写。
- Web terminal、archived session、MCP resources、Auto review 使用上游实现。按用户追加要求，安装原生 Stagehand 和 CUA，并补齐 registry 服务；Stagehand 默认挂载，通过本地适配层支持自定义 Anthropic endpoint/model，使用 cmd 供应商做有界小页面验证，不回退到其他付费供应商。
- Stagehand 适配须保留上游浏览器隔离、取消和附件机制；配置支持显式端点、模型和凭据引用，不将密钥写入补丁或报告。原生 CUA 不在未授权的真实桌面执行点击测试。
- 上游 Team profile 的 `maxMembers` 仍为 8；本地 policy 显式设置为 20，升级时保持本地值，并分别验证同时成员数与终身创建预算，不能混为同一个限制。

## 5. 实施顺序

1. 记录 `D:\dsh-test` 运行状态，确认只操作测试端口；备份 package/lock、settings、profile patch、插件和当前 Team control-plane。
2. 修改版本声明和包名引用，使用 npm/pnpm 生成全新锁文件。
3. 更新 `agent/created`、DeepSeek endpoint、PTC/workflow 配置和 history adapter。
4. 扫描所有当前预设，阻断旧插件名、旧事件和旧 service id 的加载。
5. 做静态检查：YAML/JSON/ESM 解析、依赖树版本一致性、插件清单、patch 行唯一性。
6. 启动独立测试实例（不使用 39123），验证必需插件加载、可选插件失败隔离、路由恢复和 Team roster。
7. 做小型冒烟，不跑大型游戏任务：
   - 1 个 root、1 个组长、1 个组员的 `spawn_teammate`；
   - 同组 room/peer 消息、跨级升级拒绝、lease/write-scope 拒绝；
   - 一个受限 Node PTC `run_code` 和超时/取消；
   - session 恢复/分叉及 image offload 事件；
   - provider 失败后 runtime guard 阻断与 root 恢复。
8. 根据真实日志修复兼容问题，重复第 5-7 步；只有所有 P0 和冒烟项通过才考虑切换生产。

## 6. 验收标准

- 所有实际加载包解析为 `0.1.6-alpha.1`，无 0.1.5 混装和旧 PTC/workflow 包名。
- 自定义 Team v2 是唯一提供 Team 工具的层，内置 Team 不重复注册。
- 新成员创建必经 `agent/created`，初始化完成后才发送首个模型请求。
- 无权限调用在触达文件、shell、Team domain 前被代码拒绝。
- Team 消息、任务、lease、scope、审查汇总和 provider guard 在恢复/重启后仍可观察。
- 验证脚本不因异步 history API、image offload 或新通知正文格式误判。
- 测试实例无未处理的必需插件失败、部分激活标记、端口冲突或新增会话污染。

## 7. 回滚与风险

升级失败时只回滚 `D:\dsh-test` 的备份，不执行 `git reset --hard`，不覆盖用户未参与本次升级的文件。生产 `D:\dsh` 保持原样。

主要风险按优先级排序：

1. P0：混合版本锁文件、旧包名、旧生命周期监听、Team 工具重复挂载。
2. P1：同步 history API、Node PTC 环境、image offload、热更新部分激活。
3. P2：新 UI、MCP SDK v2、Browser/Computer Use 等增量功能。

本计划完成后，实施记录追加到同目录的升级报告中，记录实际改动、命令、日志摘要和未解决风险。

## 8. 实施记录（2026-09-15）

### 8.1 版本、包与组合

- `app`、`web`、`headless`、`teamtest` 已统一到 `@deepseek-ai/dsh@0.1.6-alpha.1`，没有保留 0.1.5 混装。
- 已安装并校验 0.1.6 Team profile、Team web profile、Stagehand 原生浏览器、CUA 原生驱动、PTC runtime 和检查器相关包。
- 上游 Team 工具与 v2 自研工具已显式去重；当前 profile 只由 `team-tools-v2` 提供 Tier、群组、房间、任务板、冻结、写范围、审查汇总和交付门禁。
- `web` 与 `headless` 的 Team 核心插件保持镜像一致；本次修改后的 SHA-256 一致项包括 `team-milestone.mjs`、`team-tools-v2.mjs`、`step-compaction.mjs`、`team-operator.mjs`。

### 8.2 里程碑跨会话污染

根因不是模型“记错”，而是旧 v1 存储只在顶层按成员名记录。不同 Team 都会出现 `lead`、`verifier` 等同名成员，所以后一个 Team 可以覆盖或读到前一个 Team 的记录，旧实现又把这部分文案渲染进动态 system prompt。

修复如下：

- 存储改为 v2：`teams[<membership.id>]` 下分别保存 `members`、`bands`、`compactions`，同名成员不再跨 Team 碰撞。
- 旧 v1 顶层数据不再自动迁移，避免按名字猜测归属；迁移必须由确认过 Team id 的人工操作完成。
- system prompt 只保留静态 Team 身份和权限规则，不再包含任何会随里程碑变化的文本。
- 动态里程碑快照通过 `agent/pre-step` 返回的 `decision.messages` 追加到当前请求尾部。0.1.6 会把该消息作为 `user/message` 记录到当前会话表面，因此不会重写此前可复用的系统前缀，也不会破坏更早消息的缓存。
- 使用稳定的 `[team milestone #<setAt>]` 标记，并从 `session.deriveMessages()` 读取当前可见表面，避免同一步骤重复追加；压缩删掉标记后，下一步会补回。
- 加载器改用 `normalizeMilestoneDocument`，即使 v2 文件省略旧顶层字段，也不会丢掉 `teams` 桶。
- 工具参数示例已改为通用“交付并验证一个用户可见能力 / 运行项目聚焦验收命令”，不再绑定传送门、MC 或其他单一项目。

### 8.3 里程碑数据清理

旧文件曾包含其他测试会话的 MC、COD 和地牢条目。清理前已停止 `D:\dsh-test` 测试实例并备份：

`D:\dsh-test\home\team-milestones.json.bak-20260915-195011`

当前 `team-milestones.json` 已重置为 v2 空桶。旧 v1 条目没有被猜测性迁移到任何 Team；历史会话日志中此前已经产生的文本不会被改写，但不会再有插件读取它作为当前 Team 的里程碑。

### 8.4 Provider 与 Stagehand 路由

- CommandCode 的 Anthropic `/provider/v1/messages` 不支持 `deepseek/deepseek-v4.1-flash`，上游明确返回“请使用 OpenAI/OSS `/chat/completions`”。因此 cmd provider 改成 `openai-completions` 路由，不再把该模型强塞进 Anthropic Messages 端点。
- Stagehand 的自定义 Anthropic 适配仍使用官方 `https://api.deepseek.com/anthropic` 和 `DEEPSEEK_API_KEY`，并已验证真实 `createAnthropicModel` 请求成功。
- `stagehand-anthropic.test.mjs` 7/7 通过；它验证自定义模型名、端点拼接、结构化输出、图片/工具结果转换、错误脱敏和鉴权优先级。
- Stagehand 真实浏览器路径已验证：连接本地 Edge CDP 后，`observe()` 返回 1 个可执行动作，`act()` 成功点击按钮，目标 DOM 计数从 `0` 变为 `1`。

### 8.5 验证结果

- 里程碑专项测试：`milestone.test.mjs`、`milestone-scope.test.mjs`、`milestone-tail-delivery.test.mjs`、`step-compaction.test.mjs`、`team-isolation.test.mjs` 全部通过。
- 全量 phase 测试：`node --test` 覆盖 `phase1-tests` 到 `phase7-tests`，28/28 通过，0 失败。
- `D:\dsh-test` 测试实例已重新启动，PID 与端口文件一致，监听 `127.0.0.1:40123`。
- Web 与 headless 健康报告已拆分为 `team-health-web.json` 和 `team-health-headless.json`，避免后启动的 profile 覆盖另一个 profile 的检查结果；两份报告均为 `status: healthy`，无原因、无关键插件失败、角色文件全部有效。
- 最新启动日志段没有 `Error:`、`FATAL` 或未处理异常；旧的 `NTUSER.DAT` watch 错误只存在于更早的日志段。

### 8.6 剩余风险

1. 旧会话日志中已经写入的动态 milestone 文本无法自动抹除；要彻底清干净只能在相应会话内做历史重建或明确压缩，不能靠改当前存储解决。
2. `session.deriveMessages()` 在 0.1.6 仍同步可用；如果后续版本移除或改成必须异步读取，需要把该读取路径迁移到 `sessionQuery.observeSession()`。
3. v1 数据保留为显式迁移源，不做自动归属推断；以后若需要恢复旧记录，必须先从会话元数据确认 `membership.id`，再手工写入 v2 Team 桶。
