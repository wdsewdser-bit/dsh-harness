# 系统运行问题修复

> 用户范围更正：本轮真正目标是 Agent Team 和我们已有的上下文/压缩/恢复等改动。下文可选 Browser/Computer Use 接入属于偏离范围的额外工作，不计入 Agent Team 修复完成量，不作为后续必做项。当前整体状态及尚未闭合问题见 [CURRENT_STATE.md](../CURRENT_STATE.md)；本有限修复报告不代表原团队恢复和自然正式交付已验收。

授权：用户要求修复优化已知系统问题。范围限 staging；生产、活跃团队、旧试验与其证据保持不变，不开展新的付费模型长试验，不降低权限和租约校验。

工作项：
1. 使用当前真实平面 Team API 验证并修复成员层级、组及父级在恢复后丢失的问题；保留跨组、全局板和向上消息拒绝。
2. 空闲观察器对同一语义状态持久去重，真实新输入或任务变化可重新提醒；不设置终身次数上限，运输失败仍可重试。
3. 复核已修 JSONL 并发读取和 Reducer 设置目标文件回归。Reducer 未触发等证据缺口不直接算故障，不擅自开启 shadow 功能。

备份：`D:/dsh-test/backups/system-runtime-fixes-20261017`。先记录真实失败，再修复、聚焦验证、同步副本和清单、全量回归。原生冷恢复与负向权限路径必须覆盖。

## 已实施

- `team-tools-v2-r10.mjs`：重新使用已有兼容身份戳，写入原生 Team 不会丢弃的不可变成员描述；只写服务端批准的 tier/group/parent，剥除调用者伪造的尾部身份戳，校验可恢复性和 200 字符原生上限。模型侧成员描述仍去戳。新成员在原生日志恢复后保持原组板权限，跨组、全局板、向上消息和冻结拒绝保留。此前已丢失且没有身份凭据的旧成员不会被猜测权限或自动迁移。
- `team-idle-watch-v6.mjs`：按真实输入、任务/组员身份、实质进展和约定检查期限计算语义身份；忽略观察器自己的提醒、普通时间流逝和 revision/updatedAt 变化。持久去重，运输失败可重试，新工作无限次重新激活；重叠观察器共享 claim，卸载等待自己的未决 claim，防止卸载后唤醒。没有自动解除 manual 等待或放宽门禁。
- 新增三个测试文件：真实原生 Team + 冷重建与拒绝检查；当前 v6 定时器、重载、并发 claim、失败重试和期限检查；真实 ToolRuntime + LlmRuntime Reducer 验证。后者使用本地确定性 adapter，不是外部付费模型，也不追认旧长试验中 Reducer 已触发。
- 更新一条旧用例：从“无进展定时重复唤醒”改为“同状态静默，实质任务变化后重新提醒”；新独立测试先在原实现上真实失败。

## 当前验证

- 初始夹具错误记录保留：21-25-11-41e92249；修正夹具后的真实红：`output/regressions/2026-10-17T21-25-50-054Z-e01612f8`，3/3 失败，分别是冷恢复组身份丢失、描述伪造 tier、空闲重复提醒。
- 聚焦：`2026-10-17T21-31-30-286Z-59b48063`，8 文件 44/44；另真实 Reducer：`2026-10-17T21-32-21-349Z-e20cd569`，1/1。
- web/headless 同步，stage-closeout --check pending=0。耦合报告只新增 idle-watch 的 alone-ok 项，旧耦合项未改变；已备份并更新清单基线。这不授权单独部署其他已有耦合模块。
- 冻结源码 343 文件，`output/system-runtime-fixes-20261017/source-inventory.json`，聚合 `bc9d064cfcaab2a8d6637cc834085dd763e0b1dcf1018415de2ba580abc2547b`。生产 227 文件当前与原修正后试验基线一致。
- 全量 247 文件正在运行：`output/regressions/2026-10-17T21-33-45-096Z-8ea03036`。结束前不再改 staging 源码、测试和钉住清单。

## 复核补充与最终修订

- 上一行是第一版历史状态。首轮全量真实结束：1677 项，1675 通过、1 失败、1 既有跳过。失败是 `context-runtime-receipt` 的首次 fixture commit 返回拒绝，未修改该产品模块；单跑 4/4 通过。仅给断言增加真实拒绝详情，没有放宽断言。后续在另一轮全量并发负载下有上限复测 20 轮、80/80 通过，仍不能解释或抹去首轮失败。
- 只读复核另重现一个 idle 竞态：claim 等待落盘期间组员开始工作，旧检查仍投递停工提醒。补成规范用例后真实失败；同时重现依赖重新注入时观察器无法重新激活。红记录：`2026-10-17T21-40-29-460Z-21afdc8b`，11 项 9 通过、2 失败。
- 最小修订：投递前重新核对整个 Team 停工、provider 及当前焦点；每次依赖安装有独立 generation，旧未决 claim 不能被重新注入激活。新增负例和正例都保留。
- 最终聚焦：`2026-10-17T21-41-54-994Z-816be346`，10 文件 52/52。
- v1 源码快照不覆盖修订，不覆盖为绿。v2 冻结 344 文件：聚合 `4dd1d680f9104e30433d7ca8d4b1bbb07226b2e58f7307562dc2e4e859e165aa`，产品 idle `02298A14`，tools `DE8C2FF2`。两个 profile 同步，清单 pending=0，耦合 --check 通过，生产 227 文件仍未变。
- 最终全量已真实结束，退出码 0：`output/regressions/2026-10-17T21-42-19-100Z-cfd254db`，247 文件、1680 项，1679 通过、0 失败、1 既有跳过，325515ms。v2 源码/测试/清单保持冻结；此结果不抹去首轮失败。

## 可选工具接入补充

- 更正初步判断：npm `latest` 标签较旧不代表没有匹配版本。四个 Browser/Computer Use 包均存在精确 `0.1.7-rc.2`，已安装到 staging 独立目录 `optional-tools-runtime-20261017`；锁定版本与完整 lockfile，没有改共享 node_modules。安装使用 ignore-scripts，未写生产配置。
- 新 `resolve.mjs` 仅供明确启动的隔离进程使用，优先当前宿主 SDK 与 staging 原生实现；仅允许四个可选包及浏览器 runtime 回退到独立目录。以命令行 `--import` 加载，不使用 NODE_OPTIONS，不会自动给现有宿主启用。接入说明见该目录 README.md。
- 实际冒烟加载四个真实插件并挂载真实 Context、AgentRegistry、SessionStore、ReactLoopAgent、ToolRuntime。自有 headless 浏览器的 tabs/navigation/screenshot 成功，PNG 已目视核对为非空；Computer Use 注册 56 工具，实际 `check_permissions` 成功，非提权 Medium、UIA/PostMessage 可用。自有服务和浏览器已释放。
- 冒烟仅使用非凭据的 dummy model key，0 外部模型请求；未执行 AI act/observe/extract、用户桌面输入或桌面截图。测试没有 attachment store，截图从真实工具返回值的原始图像块取得；不宣称宿主 UI 图像展示已验证。
- 旧生产 Stagehand 配置与新 provider schema 不兼容：`model.apiKey` 必填，旧 `apiKeyEnv`/`baseURL` 等不是该 model schema 字段。未来获授权接入前需按原 provider 与凭据边界迁移，不擅自换 provider 或把密钥写进证据。
- 可选目录完整冻结 4407 文件，聚合 `84ffd5c2ba58f1efafb7fdaf854d525bd1cefcb78c5229c2efd0145e761c41cc`。这是全量回归之后的独立冒烟证据，不冒充已被 247 文件核心回归覆盖。

## 最终证据

- 报告：`D:/dsh-test/output/system-runtime-fixes-20261017/result.json`，scopedFixesAccepted=true，allSystemFeaturesAccepted=false，productionDeployed=false。绑定核心 344 文件、可选目录 4407 文件、实际红绿/首轮失败/20 轮复测日志及冒烟截图。
- 使用现有 `v13-register-ab-evidence.mjs`，显式指定本次独立 `evidence-home` 注册，未写生产 default.json。记录 `system-runtime-fixes-20261017-4dd1d680f9104e30`，status=passed 仅指本次有限修复。
- 新进程读回原生 `v12Evidence.records`，验证记录、源文件、报告引用、可选目录及生产 227 文件哈希通过；`registry-readback.json`。报告 SHA256 `a27935f8a001f0bd198ab4b7fb81ba79570f155eaf8cb7b82c47bfa06d01c67a`，登记指纹 `0bc8aabd5944332453624fca3b99537084f3a2ea6fe15c036ab397aec3ba4155`。

## 剩余边界

旧成员缺失可信身份凭据时不猜测迁移权限。可选工具已在独立接入配方中通过上述冒烟，但默认宿主未自动启用，旧配置迁移、AI 操作、UI 附件展示及真实桌面输入仍未验收。首轮 context-runtime-receipt 偶发拒绝根因未知，后续 20 轮通过不算已修复它。shadow 功能不在这次擅自开启。未部署生产、未修改活跃团队，旧游戏验收与其 failed 记录保留不变。
