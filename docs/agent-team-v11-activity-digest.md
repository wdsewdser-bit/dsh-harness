# Agent Team v11：活跃 Team 20 分钟自动巡检

## 目标

当会话中的 Team 确实有工作在执行时，每 20 分钟自动唤醒 session root/Team Lead，并向其投递一份精简的 Team 活动摘要。root 无需自己轮询 `list_agents` 或看板。

摘要用于回答三个问题：

- 当前有哪些 group 在活跃；
- 哪些成员正在运行；
- 是否存在 idle / inactive 但仍有开放任务、且没有 active lease 的疑似停滞成员。

如果没有任何 group 处于活跃状态，巡检完全静默，不产生消息。

## 实现

### 运行时入口

Web profile 的稳定入口仍是：

```text
id: tool-agent-team-v2
```

模块已切换为：

```text
D:\dsh-test\home\profiles\web\plugins\team-tools-v2-r9.mjs
```

关键点：热重载时保持 entry id 不变，只更换 module name。运行态验证结果：

```text
entryId: include:tool-agent-team-v2
moduleName: file:///D:/dsh-test/home/profiles/web/plugins/team-tools-v2-r9.mjs
enabled: true
fiberPhase: active
```

`team-operator` 入口同步切到 `team-operator-v4.mjs`，以读取 r9 的 `activeRouteApplier`。

### 巡检模块

```text
D:\dsh-test\home\profiles\web\plugins\team-activity-digest.mjs
D:\dsh-test\home\profiles\headless\plugins\team-activity-digest.mjs
```

默认间隔：

```text
20 * 60 * 1000 = 1200000 ms
```

巡检读取：

- `agentTeams.listMembers(root)`：成员状态、group、tier、组长；
- control plane snapshot：open tasks、active leases、boards。

活跃条件：

- 有 `running` / `provisioning` 成员；
- 或有 active lease；
- 或开放任务由当前活跃成员持有。

摘要包含：

- 独立 verifier group 的运行状态；
- active group 数 / 总 group 数；
- running、idle、inactive 成员计数；
- active lease 数；
- open task 数；
- 每组组长、运行成员、开放任务、租约；
- `idle-with-open` 成员名单。

### 唤醒与去重

只有 root/Lead 处于 idle 时才发送。发送使用：

```text
root.followup(createUserMessage(...))
```

它不是 quiet inject，因此能真正启动 root 的下一轮。

去重使用 control plane 的：

```text
wakeClaim({ episodeId: 'activity:' + teamKey + ':' + slot, ... })
```

同一个 20 分钟时间槽最多成功投递一次。摘要本身是消息，不写入可缓存 system prefix，所以不会破坏 prompt cache。

### 与 stop watchdog 的分工

- `team-activity-digest`：Team 仍活跃时，每 20 分钟给 root 一次状态摘要。
- `team-idle-watch`：整个 Team 已停工 30 秒时，唤醒一次并提示检查未完成工作。

### 已停工 Team 的 bootstrap 扫描

进程重启或最后一轮没有发出 `agent/status` 时，Team 可能已经是停止状态，但旧 watch 从未布置倒计时。v5 增加 `bootstrapScanMs`（默认 30 秒）的独立扫描：

- 遍历 live agents，解析每个 Team 的 root；
- root 非 running 且全员停止时执行同一套 idle 检查；
- 仍使用 `wakeClaim` 去重，一个停止 episode 只提醒一次；
- root 恢复 running 后取消该 episode。

实测：热重载到 v5 后 30 秒内产生新的 `team-idle-watch` wake episode，目标会话从 `running:false` 变为 `running:true`。

为避免重复启动 digest：

- Web profile 的 `team-idle-watch` 使用 `team-idle-watch-v5.mjs`；digest 只由 r9 启动。
- Headless profile 的 `team-idle-watch` 使用 `team-idle-watch-v2.mjs`；digest 只由 `team-tools-v2.mjs` 启动。

## 配置

Web：

```yaml
- id: tool-agent-team-v2
  name: './plugins/team-tools-v2-r9.mjs'
  config:
    controlDir: 'D:\dsh-test\home\team-control-plane'
    activityDigestIntervalMs: 1200000

- id: team-idle-watch
  name: './plugins/team-idle-watch-v5.mjs'
  config:
    settleMs: 30000
    bootstrapScanMs: 30000
    controlDir: 'D:\dsh-test\home\team-control-plane'
```

Headless：

```yaml
- id: tool-agent-team-v2
  name: './plugins/team-tools-v2.mjs'
  config:
    controlDir: 'D:\dsh-test\home\team-control-plane'
    activityDigestIntervalMs: 1200000
```

## 热重载

本次修复未重启 DSH；在线热重载时 PID 为 `89368`，端口为 `40123`。

已通过 DSH 自身的 `pluginManager/setBundleEnabled(..., true)` 触发无配置变化的 reconcile，让运行态重新读取 `cordis.patch.yml`。

实时清单确认：

```text
tool-agent-team-v2 -> team-tools-v2-r9.mjs (active)
team-idle-watch    -> team-idle-watch-v5.mjs (active)
team-operator      -> team-operator-v4.mjs (active)
```

## 验证

```powershell
node D:\dsh-test\phase8-tests\team-activity-digest.test.mjs
node D:\dsh-test\phase8-tests\team-activity-digest-timer.test.mjs
node D:\dsh-test\phase8-tests\team-idle-watch-bootstrap.test.mjs

Get-ChildItem D:\dsh-test\phase1-tests,D:\dsh-test\phase2-tests,D:\dsh-test\phase3-tests,D:\dsh-test\phase4-tests,D:\dsh-test\phase5-tests,D:\dsh-test\phase6-tests,D:\dsh-test\phase7-tests,D:\dsh-test\phase8-tests -Filter *.test.mjs -File |
  Sort-Object FullName |
  ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { exit 1 } }
```

结果：

```text
PHASE1_8_ALL_TESTS_PASS
```

本次完整本地测试为 47 个文件全部通过。

`team-health-web.json` 状态为 `healthy`，r9、digest、idle-watch v5、operator v4 均为 enabled。

## reopen 作用域修复

`recoverTaskPhaseForReopen` 曾错误地嵌套在 `assertTaskPhaseCanAdvance` 内，外部 reopen 分支调用时报 `is not defined`。r9 和 headless `team-tools-v2.mjs` 已把该函数移回模块级作用域。
