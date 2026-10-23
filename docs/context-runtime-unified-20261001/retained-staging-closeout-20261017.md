# 本轮 Staging 收口

> 当前状态入口：[DSH Agent Team 当前状态](../CURRENT_STATE.md)（2026-10-17 后续核对）。本文仅保留当时 `6457ba5e` 版本的 25 项限域验收；其后源码、retention 和真实长任务已有变化，不能据此宣称当前系统整体完成。旧报告及其绑定文档保持原样。

原规范 Plan-Revision 3 明确保留的 **25 个主项、9 个阶段框架已完成限域验收并正式登记**。最终 `retainedStagingAccepted=true`，不是新的阶段暂停点；不等同整个 DSH 平台完工或生产启用。

## 正式证据

- 最终报告：`D:/dsh-test/output/overall-staging-closeout-20261017/final-result.json`。
- 独立登记读回：同目录 `evidence-registry-readback.json`，passed=true；重新核对50个证据引用与162个源码哈希。
- 原规范25项：同目录 `canonical-plan-result.json`；真正的计划注册、25项物理实现证明、25项服务器 ToolRuntime 质量验证、完整交付回执与原生accepted，新进程JSONL/control/service重算通过。它不是自然链10项fixture，也不是一条v12Evidence记录。
- 计划回执：`delivery-835b36863bbed79e5bc5f0b9`；规范版本3与隔离机器合同注册版本1分别记录，不混称。
- 登记ID：`overall-staging-20261017-6457ba5eb9d4d606-51946615`。实际记录位于上述目录 `evidence-home/team-control-plane/default.json -> v12Evidence.records`；生产default.json未写。
- 最终全量：`D:/dsh-test/output/regressions/2026-10-17T09-15-06-293Z-f8682037`，242文件、1646通过、0失败、1既有跳过，真实退出0。
- 当前源码：`6457ba5eb9d4d60677dc84909bf303555b14a0a9295878d42e865ddead2c5545`；162载体/native58，4逻辑profile映射2物理目录，58插件哈希一致，原before lineage保留。
- 当前E1：`D:/dsh-test/output/e1-session-cold-final-20261017/final-result.json`；真实Web/API三阶段partial、accepted、源码改变后partial，3张截图已视觉核对，69事件独立冷读及单独证据登记通过。

## 最后闭合的缺陷

实际25项冷恢复发现，非Team本地任务初建时缺默认生命周期字段，控制面重载补字段后使任务哈希漂移、旧receipt失配。现在初建沿用既有 `normalizeStoredTask`，未降低CAS、权限或验收维度。新原生回归先红后绿，23/23；跨进程规范化和两次cache-cold均保留原receipt，真实task revision变化仍拒绝。源码、测试与清单的备份在 `D:/dsh-test/backups/session-cold-task-20261017`。

## 自然链的精确边界

真实Team自然链v2的native最终accepted、独立冷核验及17负控通过；原13请求失败保留，修后11请求，总24未加预算、未重采样。原输出格式偏差、原driver退出1和非必需业务维度accepted=false均保留；独立零请求裁决没有改写raw answer。

该自然实验实际执行包c7b01e6f，最终包6457ba5e仅上述非Team本地route一文件改变，其余161注册载体（包括全部Team/native/tool载体）同hash。最终验收器核对精确代码变换、旧清单和原自然脚本；不声称在最终整包上新跑了自然采样。当前全量、Web/cold及25项正式凭据分别验证修后的本地route。历史E2/E4的证据范围、15项E2历史source差异及费用未知均保留。

## 清理与未启用范围

最终安全复核 `final-safety-check.json` 通过：生产8文件哈希未变，40123/40124/40125/40126均空闲；本轮宿主、浏览器已退出，无provider凭据副本。用户8788服务/PID16472保留。没有commit/push、active-Team中断、全局配置改写或本轮生产部署。

strict-plan B搁置、W1常规off、W2保留既有allowlist/manual但不扩围、经济auto off；生产发布另需授权。未认证生产回滚演练、全provider/sandbox通用安全或当前全工作流经济收益。它们不是本轮25项保留合同的漏项。原三份规范/状态文件已哈希绑定，不在登记后追改；后续源码或范围变化需要新版本验收，不能复用此回执冒称当前有效。
