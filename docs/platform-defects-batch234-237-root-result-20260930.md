# DSH 平台缺陷检查修正（批次 234-238）

本轮没有新增平台源码修复，但有两项状态修正需要同步：

1. **B-213c 已 live verified**（批次 228）：同一会话的前后对照显示，旧 inline/opaque 拒绝串已变为具名的 `[active-plan-required]` 诊断，覆盖非 `-File` 的不可核验命令路径。
2. **B-220 已 live verified**（批次 235）：改正陈旧等待票后，旧票被平台关闭为 `closedReason: deduplicated`，并以 `supersededBy` 指向新票；原始反例中的“旧票仍 open”未再出现。四份 `team-v14-waiting.mjs` 均为 size `29499` / SHA256 `D3021162B321299ABD3AC23CD5D0F56104D201E07E86FE7078B4A7E3862CAAA0`，且文件早于 PID `31528` 启动。

批次 234-238 其余内容均为 RustMc/Team 运行与记录：精确 token 匹配、合同正文与已批计划分离、rig 就绪判据、可操作分母、scope 层级、未来输入负控，以及旧契约上的在飞计划拒批重提。没有新增 DSH `B-*` 代码缺陷，也没有新增 `WORKAROUND-REVERT.md` 回退条目。

本轮未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓。最终清单指纹：size `1567461`，SHA256 `CA187F4CBA7F417CC3FDE4315A3BDB52C0ED50BBCA0A170F4C28B1C547CD686D`，mtime `2026-09-30T07:10:36.4398055Z`。
