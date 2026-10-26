# Reducer UI 与第二轮低风险施工记录

日期：2026-10-01（北京时间）

## 结论

Evidence Reducer 的设置页现在使用一条明确的 live Settings mutation 路径：提交时带当前 revision，Host 接受后重新读取 Settings mirror，并校验返回 revision 已落到页面状态；失败会保留草稿并显示错误，不再静默二次尝试或把文件回退写入伪装成 live 成功。

同时删除了 web profile 中重复的 Reducer settings override，增加了配置 lint，防止以后再次出现同一 id 多层覆盖和临时 probe 残留。Reducer 的 JSON 文件继续是兼容镜像/命令回退，不再被当成 live settings 的唯一事实源。

## 当前配置

```json
{
  "enabled": true,
  "routeMode": "session",
  "provider": "",
  "model": "",
  "reasoningEffort": "",
  "localProviders": ["opencodego"],
  "remoteAllowed": false,
  "thresholdBytes": 32768,
  "maxReceiptTokens": 1200,
  "maxQuotes": 16,
  "timeoutMs": 45000,
  "maxInputBytes": 131072,
  "maxInputLines": 3000
}
```

选择理由：当前主要链路是本地 `opencodego`，因此跟随当前会话即可避免写死模型；只允许 `opencodego`，不打开任意远程路由；32 KiB 阈值避开中等大小工具结果，1,200 token 收据和 16 条引用足够覆盖错误/警告/关键结论，同时限制 Reducer 自身成本；128 KiB/3,000 行输入上限避免把大型日志原样再发一次。

## 代码变化

- `home/profiles/web/plugins/evidence-reducer-ui/client.js`
  - 保存改为显式 `settings.mutate(namespace, ops, revision)`。
  - 成功后强制 reload mirror 并校验返回 revision 与 live revision 一致。
  - mutation 失败不再无条件重试、不再无 revision 写入；草稿保持可修正。
  - 页面增加“修改后点击保存，保存成功后立即写入运行态”的提示，避免把勾选框暂存误解为已经生效。
- `home/profiles/web/plugins/evidence-reducer.mjs`
  - Settings 镜像写入失败会记录 warning；live Settings 仍是权威来源，避免 JSON 镜像静默分叉。
- `home/profiles/web/plugins/team-operator-v5.mjs`
  - `/team reducer-route` 优先写 live Settings；live 写入失败时返回错误，不再悄悄写文件后报告“effective immediately”。
- `home/profiles/web/cordis.patch.yml`
  - 保留一个 Reducer insert 和一个 settings-editable override，清除重复 override 和一次性 probe。
- `context-workspace.mjs`
  - 为同一 Team/member/session、view revision、control revision 和 shadow/apply mode 增加 1 秒、最多 32 项的 projection preview cache。
  - source TTL 到期、view/CAS revision 变化、control revision 变化或 HMR 实例替换都会使缓存失效；权限/协议失败结果不缓存。
- `tools/reducer-settings-lint.mjs`
  - 检查 web/headless/teamtest patch 的 Reducer 行数、UI mount、临时 probe、配置值和 JSON 镜像。

四份 profile 的插件源码已同步；desktop 通过 web junction，teamtest/plugins 通过 web/plugins junction。

## 运行态证据

- PID `16440` 未变，启动时间仍为 `2026-09-30T16:37:18.1485795+08:00`。
- HMR 后 runtime probe：`runtime-services-ui-fix.json`。
  - C module hash：`2df427ebeaf05bf5143ef9d0e21f7ebcae9f1666e51e8948c225b7f6d43336b9`。
  - bridge registrations：4。
  - context mode：shadow，allowlist 为空。
- live `settings/describe`：`writable=true`、`applies=live`、revision `34`，enabled/route/allowlist/阈值全部为最终配置。
- JSON 镜像 revision `180`，由 live Settings 更新事件同步得到。

## 验证

- 7 个修改模块 `node --check` 通过。
- 聚焦回归：22 项 Reducer tests、13 项 context workspace tests、41 项 Team efficiency checks、5 项 digest checks 全部通过。
- `node D:/dsh-test/tools/reducer-settings-lint.mjs`：`ok=true`，web/headless/teamtest 结构检查通过，Reducer insert/override 唯一性通过，临时 probe=0。
- 完整回归（仅收集仓库根下的 `architecture-tests`、`usage-tests`、`phase*-tests`，排除 backups）共 146 个测试文件、679 项：673 通过、5 个既有基线失败、1 个跳过。5 个失败集中在 `live-lab-runner` 的 `SCHEMA_DRIFT` 与 `request-plan` / `request-message-projection` 的品牌契约断言，不涉及本轮改动文件；日志见 `full-regression-ui-fix-20261001-complete.txt`。
- 最终 telemetry 快照：`events=163035`、`fired=1`、`kinds.reduced=1`；另有 `route-not-allowed=8006`、`reducer-failed=112`、`receipt-unverified=2` 等历史跳过/失败样本，不能把这些样本计入成功收益。该 `fired=1/reduced=1` 是运行态链路已经实际触发的证据，但不是收益率结论。
- 未重启 DSH、未中断原 root/Team、未清理 backup/spill/telemetry/session，也没有修改 RustMc 产品仓。

## 未决项

- 当前历史 telemetry 仍可能出现 `route-not-allowed`、`reducer-failed` 或 `receipt-unverified`；启用开关只证明链路允许调用，不代表每个长日志都有 verified receipt。
- provider `cacheWriteTokens` 仍保持 unknown；没有原始 wire 字段就不做猜测归一化。
- context delivery 增量统计、inbox cursor、compaction debt 写盘抑制和 operationId 生命周期仍留在第二轮后续清单，未未经压测直接上线。
