# cua existing-profile 授权 + Stagehand 改用 Chrome（2026-09-15）

## 1) cua-driver existing-profile 授权
- 现象：browser_prepare(strategy=existing_profile) 被拒 `browser_consent_required`。
- 根因：插件用 `CuaDriver.create(void 0)`，即 standard 模式；附着你已登录的浏览器 profile 属于
  residual boundary，standard 下必须由嵌入 host 授权。
- 改法（嵌入式等价于 CLI 的 --grant existing-profile）：
  文件 `D:\dsh-test\home\profiles\web\node_modules\@deepseek-ai\dsh-experimental-computer-use-cua-driver-native\lib\index.js`
  `CuaDriver.create(void 0)` -> `CuaDriver.createConfigured({ claudeCodeCompatibility:false, authorization:{ allowedModes:[0,1,2], compatibilityMode:2, unrestrictedAcknowledged:true, maxSessionTtlSeconds:86400n, maxIdleTtlSeconds:3600n } })`
- 备份：同目录 `lib/index.js.orig-no-grant`，另存 `D:\dsh-test\patch\cua-driver-native-index.js.orig`。
- 回滚：把备份覆盖回 `lib/index.js`。

## 2) Stagehand 改用 Chrome
- 本机原先没有 Chrome，配置把 executablePath 指到 Edge，DSH host 内 launch 报
  `Failed to launch the browser process:  Code: 0`（@puppeteer/browsers 判定子进程在给出 CDP 端点前退出）。
- 已安装 Chrome for Testing 到 `D:\dsh-test\tools\chrome-for-testing\chrome-win64\chrome.exe`
  （安装包保留在 `D:\dsh-test\tmp\chrome-win64.zip`）。
- 配置改动：`D:\dsh-test\home\profiles\web\cordis.patch.yml` 第 27 行 executablePath 指向上面的 chrome.exe。
- 回滚：把该行改回 `'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'`。

## 生效方式
需要重启 DSH 才会加载新插件代码与配置：
```
# 重启
taskkill /F /PID <dsh-pid>
node D:\dsh-test\app\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --no-open --port 40123
```

## 3) existing-profile 附着仍被挡：中文确认框（2026-09-15 补充）
- 授权补丁生效后，拒绝码从 `browser_consent_required` 变为 `browser_wrong_target_refused`：
  `no exact Chromium remote-debugging consent prompt appeared for reconnect attempt 1`。
- 原因：Edge 会弹出原生确认框「是否允许远程调试？」（中文），而 cua 只匹配英文提示文本，
  等不到就拒绝；它尝试的自动 setup（打开 edge://inspect 页、勾 per-instance 复选框）因此也判定失败。
- 相关开关：`edge://inspect/#remote-debugging` 的
  "Allow remote debugging for this browser instance"；勾选后 Edge 在 127.0.0.1:9222 提供 CDP
  （已实测该端口可连），但 cua 的 existing-profile 流程不消费这个既有端点，仍会被上面的匹配问题挡住。
- 可行绕法：把 Edge 显示语言改成英文再试；或完全退出 Edge 后让 cua 自行拉起实例；或改用 Stagehand。
