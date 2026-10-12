平台缺陷批次 253–283 热重载说明

已对运行中的 web profile 执行定向 HMR，未重启 DSH、未中断 active Team、未清理任何数据。

- 触发时间：2026-09-30T10:04:12.3259628Z
- 方式：只更新本轮七个已修改插件的 mtime，触发现有 profile HMR watcher 重新导入；文件内容与 SHA256 均未变化。
- 文件：team-v12-contract.mjs、team-v12-evidence-scheduler.mjs、team-control-plane.mjs、team-policy.mjs、team-v12-runtime.mjs、team-tools-v2-r10.mjs、team-v14-waiting.mjs。
- 运行态证据：PID 16440 和启动时间保持不变；team-health-web.json 在 2026-09-30T10:04:12.703Z 重算，status=healthy、reasons=[]。
- 当前状态：七项平台修复已由 web profile HMR 加载；未重启进程。其他 profile 的磁盘副本仍一致，将在各自启动时加载。
- 清单最终 SHA256：EACFA99667D5FD33DF65DA9A4B4325D231441D4CEE04FBD19AF7CF5351464BBD。
