# Agent Team v14 提示词与 PTC 契约

日期：2026-09-25。此文件记录活动提示词和角色身份的行为契约；权限仍由运行时代码 fail-closed 执行。

## PTC 结果与执行

以下两个界面不要混用：

1. 宿主 `tools/post-execute` 回调接收 `result: Readonly<ToolExecutionResult>`，其中成功是 `{isError:false,value,content}`，失败是 `{isError:true,error,content}`。回调中的 `await next()` 返回 `PostToolDecision`，例如 `{kind:"accept"}` 或 `{kind:"block",feedback}`，不是工具业务结果。做镜像、关联 ID、revision 或 evidence 时读 canonical `result`，只在成功分支写成功镜像。
2. `run_code` 中生成的 TypeScript/Python SDK 绑定由 `await tools.name(args)` 调用，成功解析为工具 canonical JSON value；失败以 `ToolCallError` reject，含 `toolName` 与可读 `message`。SDK 绑定只在该程序内调用，不是模型可直接调用的独立工具。

```ts
const receipts = [];
for (const step of orderedMutations) {
  try {
    const value = await tools[step.name](step.args);
    receipts.push({ name: step.name, ok: true, value });
  } catch (error) {
    receipts.push({ name: step.name, ok: false,
      toolName: error?.toolName, error: String(error?.message ?? error) });
    break;
  }
}
return receipts.map(({ name, ok, value, toolName, error }) => ({
  name, ok,
  id: value?.id,
  revision: value?.revision,
  toolName,
  error,
}));
```

示例仅展示回执形状；调用名和参数必须来自当前注入的 SDK schema，不得把 `orderedMutations` 或权限检查当成绕过 runtime 的通道。

## 并行、重试与回执

- `Promise.all` 仅并行互相独立、只读、无副作用的查询。运行时只把显式声明 `concurrencySafe === true` 的工具判为 parallel；未知、不可见、未声明、无效或分类器异常一律 exclusive。模型侧仍需确认调用之间无数据依赖。
- claim、审批、lease acquire/heartbeat/release、文件写入、消息、task complete、Room 决议、merge 等状态变化按依赖顺序 `await`；不能因“工具被分类为 parallel”而并发相互依赖的变更。
- 每个写调用完成后记录名称、call/receipt ID、成功/失败、业务 ID、revision、错误和是否已确认。`run_code` 程序失败、超时或取消不会回滚已经完成的子调用；先查真实状态，再仅重试未确认、可幂等的步骤。不能从缺少回执推断“没有执行”。
- PTC 单次运行的重复安全依赖各工具幂等键与当前 contract；没有幂等保证时不自动重发。SDK 不会自动重放失败程序。
- 只 `return` 紧凑回执/必要字段；不打印全量 inbox、Room、任务板、控制面或大日志。日志需先提取错误、ID、revision 和相关证据位置。

## Room、消息与确认

- Room 的 `waitAction` 只控制当前 Room 参与：`speak` 发言一次、`close` 仅 host 关闭、`stop` 结束当前 Room turn。stop 不覆盖其他独立且无阻塞的已批准任务。禁止模型 `wait_agent`、sleep、轮询或重复读 Room；由系统在 speaker/事件就绪时 handoff。
- `info` 只投递，不保证对方会醒来或回复；需要立即行动用定向 `action`，向直属上级请求阻塞决策用 `decision` 并带 `blocked_action`、`reason`、`evidence`。不要为普通进度唤醒整队。
- v12 wake `queued/delivered/injected/handled` 语义不同。确认进入上下文并处理后，使用 `inbox_list` 取到的精确 `wakeId` 做 `inbox_ack`；ack 不是通信，注入也不是处理完成。差量注入依赖 cursor/version，不得重放整批历史正文。
- 有后台命令时创建/使用持久 job 并等待系统完成或失败事件；无其他可执行任务时登记任务、等待条件、责任 owner、最近有效进展和下次检查时间，然后结束 turn。不要在模型内睡眠等待。

### 等待责任 API

用 `team_v12(action:"waiting_set", task_id:"<task-id>", input:{reason:"...", unblockCondition:{type:"dependency|room|approval|provider|manual|external|background", ...}, responsible:"<agent-or-operator>", nextCheckAt:"<optional-ISO-time>"})` 持久登记等待；`team_v12(action:"waiting_list")` 只读当前责任单。真实解除条件满足后，显式调用 `team_v12(action:"waiting_resolve", task_id:"<task-id>", input:{resolution:"..."})`。`manual`、`external`、`background` 等等待不能因时间经过或普通 task revision 变化自动解除；没有真实条件或显式 resolve 就保持等待。

### PTC 子调用回执

用 `team_v12(action:"ptc_receipts", input:{rootCallId:"<optional>", callId:"<optional>", limit:50})` 查询 canonical 子调用回执。分别判断 `isError`（执行是否失败）与 `projectionBlocked`（展示/投影是否被阻断）；`mirrorStatus:"failed"` 只表示镜像失败，不表示原 mutation 回滚或未执行。回执缺失时先查询，不得整段脚本重放。

## 身份版本与 handoff

`team-roles/identity-version.json` 对静态身份文件记录 schema/version、相对路径和 SHA-256。加载器应在 spawn 与恢复检查 manifest 哈希；不匹配或读取失败要 fail-closed 地报告身份状态，不得默认为最新。

- 新 spawn 在身份读取时获取当前文件；哈希只能证明文件版本，不能证明最终模型上下文包含正文。
- 已存在成员不会因文件落盘自动热更新。`identityVersion` 变化时，运行时须读取该成员实际角色对应的 `team-roles/<role>.md`、校验 SHA-256，并在受支持的 system handoff、恢复或下一 turn 注入该角色的实际变化及 version/hash；只发送版本号不算更新。不重写历史 system message，不通过 `info` 假装唤醒，也不打断执行中的成员。
- 验证传播须检查目标成员下一次真实 turn 的最终拼装上下文包含该版本/差异。未接入此 handoff 钩子或未完成实证前，只能报告文件已更新、manifest 可校验；不能报告旧成员已收到。
- 动态任务要求、决定、Room/inbox 摘要放在每轮动态 context pack 尾部，不拼进静态身份前缀。版本变化只追加相关差量和来源；权威信息读不到时记录 memory debt，不能把空值解释为“无要求/无未决项”。业务会话压缩后恢复自己的任务契约、用户要求和已确认 Room 决定；v14 平台实施计划/台账的重读规则只适用于实施平台的工作会话，不进入产品业务成员上下文。

## 运行约束

- tier 0 负责全局/跨组调度，tier 1 组长调度本组。当前有效配置：`maxTier1Leads=8`、`maxMembersPerLead=8`、全局 `maxMembers=30`（未冻结活跃成员）；tier 1 另有唯一 verifier。`maxMembers=500` 是原生层 roster backstop，不是有效活跃配额。
- 普通完成/依赖解除可作为系统事件交给接续器；接续器只执行已批准、owner 明确且 scope/lease/依赖复核通过的任务，不自动创建成员、改 owner 或扩大权限。未有接续器运行证据时，必须登记等待责任并通过允许的定向行动路径推进，不声称自动派发已生效。
- fail-closed 权限、任务状态、lease、provider 阻断和冻结规则不受本文或角色提示覆盖。Room 超时、provider 错误或确定性拒绝不能靠无限重试绕过。

## 官方本地契约来源

核对的随附 SDK：

- `app/node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts`：`ToolExecutionSuccess/Failure`、`tools/post-execute` 签名、`PostToolDecision`、`executionMode`。
- `app/node_modules/@deepseek-ai/dsh-tools/README.zh.md`：PTC SDK 调用、`ToolCallError`、并发与程序输出行为。
- `home/profiles/web/node_modules/@deepseek-ai/dsh-tools/lib/types/ptc.d.ts`：`run_code` bridge 和并发上限接口。
- 有效 Team 配额：`home/profiles/web/cordis.patch.yml` 中 `team-policy` config；禁止把 native bundle 的 8 roster default 或 profile 的 500 backstop 当活跃 Team 配额。

## 静态校验（不启动服务）

在 PowerShell 中运行以下短检查，验证 manifest、必需契约词和不应回到活动提示词的无关 unrestricted boilerplate：

```powershell
$dshHome = 'D:\dsh-test\home'; $roles = Join-Path $dshHome 'team-roles'
$required = @('isError:false','result.value','ToolCallError','Promise.all','waitAction','wake_id','waiting_set','waiting_resolve','ptc_receipts','projectionBlocked','mirrorStatus','identityVersion','maxTier1Leads: 8')
$text = (Get-Content (Join-Path $dshHome 'AGENTS.md') -Raw) + (Get-Content (Join-Path $roles 'AGENTS.md') -Raw) + (Get-Content (Join-Path $roles 'lead.md') -Raw) + (Get-Content (Join-Path $roles 'member.md') -Raw) + (Get-Content (Join-Path $roles 'verifier.md') -Raw)
if ($text -match 'unrestricted model|NSFW/GORE|Restrictions on tasks targeting') { throw 'unrelated boilerplate remains' }
foreach ($needle in $required) { if ($text -notlike "*$needle*") { throw "missing contract: $needle" } }
$manifest = Get-Content (Join-Path $roles 'identity-version.json') -Raw | ConvertFrom-Json
foreach ($name in $manifest.files.PSObject.Properties.Name) { $actual = (Get-FileHash (Join-Path $roles $name) -Algorithm SHA256).Hash; if ($actual -ne $manifest.files.$name) { throw "hash mismatch: $name" } }
'v14 prompt/identity static check: PASS'
```
