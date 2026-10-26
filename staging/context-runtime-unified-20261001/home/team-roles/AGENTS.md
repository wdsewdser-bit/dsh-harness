# Agent Team Standing Identities

这些文件只定义长期身份；权限、任务阶段、lease、冻结和 provider/runtime guard 优先。身份清单与版本在 `identity-version.json`。角色文件在 spawn 时读入；已有成员不会因磁盘变化自动热加载。`identityVersion` 改变时，运行时钩子须按角色重读对应的 `<role>.md` 并校验哈希，再通过 system handoff/下一 turn 交付实际变化；仅通知版本号不等于更新身份。

## 通用硬规则

- 只处理明确分配的任务；每轮完成相关可执行批次，等待时登记责任和解除条件。先确认接口、依赖、文件范围、验收和回滚，再在批准 plan 与活动 `team_run_lease` 下写入。
- 新消息、工具结果、Room/摘要/压缩/唤醒注入和普通模型响应末尾会带 `[time: YYYY-MM-DD HH:mm:ss +08:00]`。这是事件发生时间，不是截止时间；比较时间判断新旧，旧消息晚到不得覆盖更新的状态，已有时间戳不得重复追加。
- 只写声明的 `write_scopes`。先读最新 revision，再 CAS 更新；拒绝后按返回前置条件修复，不重复重试或绕过权限。
- 读取具体组板或层级板时使用完整 board id，例如 `board:"group-proto"` 或 `board:"level-1"`；`board:"group"` 只是调用者自己的组板别名，root 的该别名是 `group-root`。
- `send_message` 必须声明 `delivery`: `info` 静默，`action` 定向唤醒，`decision` 向直属上级提交 `blocked_action`、`reason`、`evidence`。带 `task_id` 还要有最新 `based_on_revision`/`based_on_phase`。
- `action`/`decision` 返回 `queued` 表示消息已进入 durable mailbox，后台仍会继续投递；这不是失败，不得因此重发。只有明确 `isError` 或 `delivery-failed` 才按真实回执处理。
- Wake 决策表：只记录不唤醒用 `send_message(delivery:"info")`；需要同级/下级立即行动用 `send_message(delivery:"action")`，兼容别名 `team_wake`；阻塞后需要直属上级决策用 `send_message(delivery:"decision")`，兼容别名 `team_wake_superior`。`queued` 是持久投递，不得重发。
- v12 收件箱先 `team_v12(action:"inbox_list")` 获取准确 wakeId；确认已进入上下文并处理后，再 `team_v12(action:"inbox_ack", wake_id:"<exact-id>")`。`wake_id` 必须是顶层字段。
- `team_room_read` 严格遵守 `waitAction`：`speak` 一次主发言，`close` 仅 host 关闭，`stop` 结束当前 Room turn。Room 等待不得 `wait_agent`、sleep、轮询或重复读取，系统 handoff 后再继续。
- 跨组决策必须在 `team_room_decide` 中列出所有受影响组长的 `required_confirmations`；被点名的组长逐个调用 `team_room_confirm`，全部确认前不得把它当作有效决策。
- 需要判断并行收益或验证覆盖时，先用 `team_v12(action:"scheduler_advice")` 和 `team_v12(action:"verification_plan", task_id:"<task-id>")` 读取建议；建议默认是 shadow，不替代 owner、plan、scope 或权限门禁。
- 成员完成顺序：写入 → evidence → 持 lease `team_task_update complete` → `team_run_lease release`。回报路径、命令、结果、证据、commit 和风险。
- 正式需求计划与任务执行 plan 不同：由 tier 0 按完整用户需求登记 `team_v12(action:"plan_register")`；组长/成员回报真实 task、实现及测试证明，不自行缩减必选项。任务板清空、context receipt 或 `team_plan_approve` 不等于整体交付；最终以当前完整计划的 durable delivery receipt 为准。
- 失败不回滚已经成功的调用；根据真实 ID/revision/query 判断效果，只重试未确认且幂等的步骤。
- 等待用 `team_v12(action:"waiting_set", task_id:"<task-id>", input:{reason:"...", unblockCondition:{type:"...", ...}, responsible:"...", nextCheckAt:"<optional-ISO-time>"})` 登记，用 `waiting_list` 查看；只有真实条件满足后才 `waiting_resolve`，`manual`/`external`/`background` 不因时间或普通 revision 自动解除。
- PTC 回执可用 `team_v12(action:"ptc_receipts", input:{rootCallId:"<optional>", callId:"<optional>", limit:50})` 查询；分开看 `isError`、`projectionBlocked` 和 `mirrorStatus`，镜像失败不代表原变更回滚。
- CLM：context state 变化时用 `memo_put` 携 `expectedRevision` 更新；首次为 `0`，否则先 `memo_get` 当前 revision。只记关键决定、约束或下一步变化，不逐步重读；memo 是 working state，不是 authority，并检查回执 `ok`/`code`。
- 收敛：仅有新假设或证据才重试，同一原因换包装不算新假设；局部修改做匹配的局部验证，不重复整套；复用证据须 exact 对象、source、environment、recipe 且授权有效，不默认跨任务复用。

## 就绪与环境诊断

- 派发准备与产品执行分开：目标、owner、范围、接口和验收已明确的独立任务可先派发做只读定位、依赖核实和验证准备。产品写入仍须批准 plan、活动 lease、有效 scope 和已满足的依赖；有未确认 Room 决策的依赖任务等待该决定，不阻塞无关任务。
- Room ID 与 board ID 不通用。先 `team_room_list` 获取可见的真实 `room_id`；组 Room 的规范形式是 `group:<group>:tier-2`，不是组板 `group-<group>`。列表为空或 `room-not-found` 时不猜别名、不重复读或 join；向有权限的组长报告缺失 Room，由其创建和安排轮次。tier 2 不能 open Room。
- `team_worktree_setup` 前先只读核实仓库 HEAD 和所选 base 可解析为 commit，例如 `git rev-parse --verify HEAD` 与 `git rev-parse --verify '<base>^{commit}'`。空仓库或 base 缺失时登记 bootstrap 责任人，等待获授权的初始化提交或正确 base 后继续，不以重复 setup 代替前置条件。tier 0 布置直属组长，组长布置自己成员，verifier 只布置自己的只读 checkout；普通成员不替自己 setup。
- 环境能力先在实际消费会话核实：记录工具、运行身份、路径、环境和真实返回。浏览器出现 spawn EPERM、mojo Access denied 等权限失败时，区分产品缺陷与环境阻断，向直属上级提交原始证据和所需能力，转交已获授权的宿主浏览器渠道；相同权限状态下改启动参数、换包装或换执行者不算新假设。只有能力或权限发生可核实变化后再试，禁止自行绕过 sandbox 或授权。
