# 交接：DSH Agent Team、自研上下文与窗口自动执行

交接对象：下一位接手者。本文独立于聊天记录可读。

编写时间：2026-10-25；最新只读核对为 22:55 UTC（洛杉矶 15:55）。进程、端口、磁盘数字仅代表该时间点。本文不包含密钥，没有启动新的模型试验、生产服务或清理任务。

## 1. 状态：先看这几项

- **已完成：** 10 月 23 日的五类 Agent Team 收口曾实际部署生产，并完成实际回滚、再应用和原生加载验证；这与下面新窗口候选不是同一批发布。
- **已完成：** 最新窗口候选在 E 盘隔离目录修复证据接入、许可 TTL、最终 W1 校验、计数及空历史安装；108/108 回归、5/5 用量桥接检查、8 次真实请求和六轮约束核对通过。
- **仍阻断：** 当前真实 Responses 没有 cache-write 用量，线上 W1 实际投影、W2 持久折叠、经济动作均为 **0**。最新 canonical 仍为 **failed**，没有虚构正例。
- **未发布：** 10 月 25 日窗口修复只在隔离候选；没有同步 staging/生产，也没有全局开启经济 auto。
- **已完成：** 精确清除回收站内一份旧备份，239,192 个文件，D 盘从 0 可用恢复约 38.68 GiB；当前项目、生产数据、日志和报告保留。
- **FPS 支线：** 游戏核心检查通过，预览仍在；补时少 44 分 12 秒，不能算连续三小时或全部窗口需求通过。
- **当前运行态：** 40123 无监听。历史记录中的“生产服务保持运行”不是当前状态；本次没有为交接启动它。
- **没有待收集任务：** 无本次模型试验、代理、exec 等待或收尾回调尚待完成；不应从旧 IN PROGRESS 条目重跑。

## 2. 接手阅读顺序与事实优先级

1. 本文，建立范围和下一步。
2. `D:/dsh-test/docs/context-runtime-unified-20261001/handoff-20261025-window-auto-and-cleanup.snapshot.json`：本次只读复核，包括完整 tracked Git 状态、端口、磁盘、198 产物与源码校验。
3. `E:/Codex-Runs/window-auto-repair-20261025-r3/REPORT.md` 与 `result.json`：最新窗口重测结果。
4. `D:/dsh-test/docs/CURRENT_STATE.md` 顶部，然后只读所需专题。
5. `D:/dsh-test/docs/context-runtime-unified-20261001/execution-ledger.md` 顶部最新条目；需要追溯时再向下读。

唯一施工台账仍是第 5 项，本文是交接文档，不另建并行施工账。台账很长，新记录在顶部；不要先读尾部旧施工状态。`CURRENT_STATE.md` 下方保留历史快照；有冲突时按范围、时间和原始证据判断，不能把不同批次混为一项结论。

旧 `D:/dsh-test/docs/agent-team-v13-implementation-ledger.md` 目前不存在，Git 显示为历史删除；不要把它当恢复入口或据此重做 v13。

## 3. 原始目标、最新请求与边界

总体目标是可控、持久、可恢复、可验证的 Agent Team，以及自研上下文、恢复、压缩、交付、Instant/PTC 链路。用户要求真实消费面验证，不能只凭写文件、进程存在、单测或代理口头报告宣称完成。

近期请求顺序：三项窗口能力实测 → FPS 持续开发/补时 → 分析为什么窗口没有触发 → “修复一下 然后重测” → “你继续 然后清理下垃圾 备份什么的 空间又满了” → **“写交接文档 我准备让其他人接手了 记得写详细点”**。

本次交接阶段仅整理事实，没有继续施工。此前五类收口的生产发布已有用户授权且已执行；它不自动等于当前新窗口候选已获全局启用或任意新付费长测授权。已有授权范围内的常规工作可直接继续，实质扩围才需要明确决定。

保留这些决定：W1 常规默认 off，W2 不扩围，经济 auto 全局 off，SDK 核心投影 false；strict-plan B 搁置。唤醒延迟用户明确说不用继续处理。禁止周期模型轮询，不为了等待任务每隔几分钟唤醒模型。

## 4. 概念：W1、W2、W3 与验收层次

| 名称 | 本文含义 | 真正动作证据 |
|---|---|---|
| W1 | 请求级窗口投影，在原生请求边界选择合法 checkpoint 表示 | 最终 adapter 实际收到 projected payload，原生 onDispatch 回执与同一许可对应 |
| W2 | 原生空闲边界的持久历史折叠 | 真实执行、JSONL durable append/barrier、重启恢复后对应事件仍成立 |
| W3 | 是否执行窗口动作的经济决策层 | 真实已绑定的输入、许可、选择与实际执行回执；开启开关不算执行 |
| canonical | 通过正式证据登记器写入的持久验收记录 | 独立新进程从控制平面读回状态、绑定与全部产物 |
| 原生冷恢复 | 从磁盘日志重建真实 Session | `readStoredLog` 加 `Session.fromRestore`；只解析 JSON 不算 |

“安装成功 → 有候选 → 进入经济评估 → 获准 → 实际执行 → 持久/恢复正确 → 质量与收益合格”是不同层次。最新线上已到候选评估，尚未执行。离线原生正例没有取代线上经济正例。

## 5. 目录与实例地图

| 位置 | 用途与写入边界 |
|---|---|
| `D:/dsh-test` | 主项目；含生产 app/home、历史输出及 staging，不是整个目录都能随意改 |
| `D:/dsh-test/app` | 当前生产原生包与入口 |
| `D:/dsh-test/home` | 生产配置、插件、会话与控制状态；终端 DSH_HOME 可能指向这里 |
| `D:/dsh-test/staging/context-runtime-unified-20261001` | 统一改动的 staging，包括 app、插件、测试和工具 |
| `D:/dsh-test/docs/context-runtime-unified-20261001` | 本文、协议、唯一台账及历史设计 |
| `E:/Codex-Runs/window-auto-repair-20261025-r3` | **最新可参考的冻结窗口候选和验收证据** |
| `E:/Codex-Runs/window-auto-repair-20261025` | 前轮实现、独立审查、5 次请求失败及旧原生复验 |
| `E:/Codex-Runs/cod-continuous-resume-20261024-r4` | FPS E 盘恢复段、游戏工作树及最终失败报告 |
| `E:/Codex-Recovery/cleanup-20261025` | 精确垃圾清理报告、预检、执行脚本和结果 |
| `E:/Codex-Recovery/fps-20261024-r3-powerloss` | 旧断电/磁盘满后的代码与关键证据恢复快照 |

`D:/dsh-purge-standalone` 是另外一个实例，不属于本次随意停止或修改范围。不要仅凭 node/python 进程名结束服务。

## 6. 历史五类收口：已经做过什么

10 月 23 日已完成并发布的范围包括性能优化、沙盒失效后 fail-closed、真实 Goal 续轮/受控错误重试/同 Team 恢复，以及 TOOL-REF、SDK-CATALOG、CLM completed episode 能力。

原报告：`D:/dsh-test/output/agent-team-complete-20261021/result.json`。

- 当时全量 257 文件、1,755 测试，1,754 通过、0 失败、1 既有可选跳过。
- 287 个生产目标实际 apply → rollback → reapply；加载与原生 PTC 消费验证有回执。
- 新有界场景 125 次请求，124 成功和一次明确注入的 503；同 Goal 自动续轮与同 Team/原成员跨进程续写通过。旧 171 次失败不抹除，合计 296。
- canonical `five-category-closeout-20261023-82cba2c425ce77c6` 当时 passed，1,356 个绑定产物，独立 PID45560 读回。
- 当时核对 424 项既存团队/会话事实；143 个未完成任务和两个已有 NUL 损坏根保留，不是根代理代做或删卡。

生产发布证据：`D:/dsh-test/output/agent-team-complete-20261021/production-deployment/result.json`；加载证据：`D:/dsh-test/output/agent-team-complete-20261021/production-runtime-r6/result.json`。这些报告本次确认仍存在；**没有在交接时重新核验全部旧 1,356 产物或全部备份字节**。用户已清理部分旧备份，不能承诺所有历史 payload 仍可回滚。

沙盒补丁防止能力丢失后重建目录、重授 ACL 或降级逃逸；不等于找到了过去删除目录的人，也不等于能恢复已丢失能力。历史删除者仍未知。

## 7. 最新窗口修复前的真实问题

诊断报告：`E:/Codex-Recovery/window-auto-analysis-20261025/REPORT.md`，原始对照：同目录 `evidence.json`。

1. 原真实 adapter 的价格、成本、质量与 horizon 输入没有接完，存在硬编码 unknown/null。经济门禁按顺序拒绝，第一个价格错误掩盖后面的缺口；单修“价格未知”不够。
2. 旧 W2 在昂贵 preview/meter/hash **之前**开始 5 秒 TTL，准备期间可能过期。旧运行有 evidence-stale，但历史没记完整签发时间，不能把全部 12–13 秒耗时都断言为证书年龄。
3. 原 W1 选择后、最终 adapter 前没有继续校验经济许可；独立审查真实复现 5,179 ms 过期许可仍投影。
4. raw cache-write 两个明示别名冲突（0 与 7）时旧 relay 静默选一个，可能把有歧义值当 known。
5. 安装走 idle；空历史拒绝进入 30 秒失败退避，短测试可能一直装不上。FPS 长回合也使首装很晚。
6. 旧计数把 selected/blocked/handed 混淆：有 callback 或 selected 不能当实际 projected handoff。
7. 前轮测试观察器 `trimEnd()` 丢掉内容末尾空格，使“完整逐字读取”失败；该轮原 exit1 保留。

## 8. 新候选的改动文件与职责

以下都在 `E:/Codex-Runs/window-auto-repair-20261025-r3` 内；不是生产安装位置。后续修改应新建候选，不原地改冻结文件。

| 相对候选根的路径 | 职责 |
|---|---|
| `runtime/window-three-runtime.mjs` | 宿主策略/计划接入、原生安装、W1/W2 生命周期、最终许可与实际计数 |
| `runtime/window-host-evidence.mjs` | policy/plan 校验、来源绑定、成本情景、准备后单次签发与 freshness |
| `runtime/window-auto-engine.mjs` | 经济候选评估、授权结果与执行流程 |
| `runtime/window-economic-commit-guard.mjs` | 一次性执行许可与提交边界保护 |
| `runtime/window-participation-retry.mjs` | 仅 HOST_PENDING 的有界准备重建；不重放已交给 provider 的请求 |
| `driver/window-executor-adapter.mjs` | 原生执行适配与安全边界 |
| `retest/driver/raw-response-usage.mjs` | 同真实响应的原始用量采集与逻辑调用关联 |
| `retest/driver/raw-usage-relay.mjs` | 明示字段到原生 terminal usage 的保守补充；别名冲突拒绝 |
| `retest/driver/retest.mjs` | 六顺序输入、完整读取、约束 oracle、实际运行与清理 |
| `retest/secure-run.mjs` | 隔离环境、内存鉴权注入、一次性启动约束 |
| `retest/cold.mjs` | 独立原生磁盘冷恢复与来源守卫 |
| `finalize.mjs` / `verify-registry.mjs` | 最终报告与独立登记读回；输出含 wx，不要在旧目录重跑 |

上述 runtime 的相邻 `*.test.mjs` 是原生正负例与回归。旧实现细节文档仍有价值：`E:/Codex-Runs/window-auto-repair-20261025/implementation-evidence/IMPLEMENTATION.md`。其中早期计数/测试规模应以最新 R3 报告覆盖。

## 9. 证据合同：许可与原生安全边界

宿主 apply 的关键参数为 `economicEvidence: { policy: {path, sha256}, plan: {path, sha256} }`。这是宿主配置，不能由模型工具输入自行填造。

policy/plan 都绑定 schemaVersion、id、source、sessionId、actorId、provider/model/protocol/priceVersion、issuedAt/expiresAt。文件按精确字节 SHA256 钉住，准备、轻量复核和持久 append 时核对；文件变化拒绝。旧 R3 文件已过期，不能改时间继续复用。

证据在 capture、原生 retained-source 校验、hash/meter、候选估算与原生 revision/certificate stamp **之后**只签一次。5 秒 TTL 不放宽，同时检查墙钟和单调时钟。轻量 guard 不重跑昂贵准备，也不刷新签发时间。

W1 按原生 result 对象保存一次性经济 permit；before/after validateAdapter 均检查原始期限、route/source/CAS、loaded certificate、policy/plan hash、owner/cancel。保留原生 prepared registration、branding 和 hooks。transform 内只代表 selected/authorized，真正 applied 要等同一许可的实际 onDispatch。

W2 等真正 idle 和参与状态稳定再准备；只有当前私有 frame 的一次性许可可替代 size-only 决策。原生 writer fence、HostGate、active effects、源事件、retention、安全协议与 durable barrier 仍执行，不能绕过它们造正例。

## 10. 经济情景是什么，尚不是什么

当前 policy 是明确声明的 **cache-aware-relative-planning / relative-cost**。配置里的 cacheWriteReadRatio=50 被实际使用，但其余权重是宿主声明假设，不是供应商账单。

R3 取 input/output/reasoning 权重 50、cacheRead 1、ratio50；未来暖读比例 0.8，允许一次 full-source replay，额外 output/reasoning 各 32,768。它们是本次情景参数，不是推荐生产定价。

计算含义（B/A 为原/候选 tokenMeter 估算，R 为读权重，W=R×ratio，I 为未缓存权重，h 为剩余计划请求，q 为重放预算，f 为暖读比例）：

```text
checkpoint = A × W
cold = A × max(W, I)
recall = q × B × max(W, I) + extraOutput × outputWeight
         + extraReasoning × reasoningWeight
warmRate = f × R + (1-f) × max(W, I)
net = h × (B-A) × warmRate - checkpoint - cold - recall
```

W2 估算包括真实历史 checkpoint、完整 current-authority 和 16 个启发式 framing token。tokenMeter 不是供应商 tokenizer 上界；未来 authority、suffix、暖读率和召回次数仍是情景。

计划按实际 exact-root 原生 handoff 消耗位置，包括安装前请求；HOST_PENDING 预适配重建不消耗。W1 排除自己当前拟发送的一次，W2 取实际已 handoff 后余量。额外调用会耗尽计划，不能追加假 horizon。

质量只接受 `native-retained-source-structural-only`，semanticQualityClaim=false。证明结构、来源与恢复合同有效，不等于回答语义完全等价。reasoning 已包含在 output 中，这里的额外权重不能拿去当账单分解。

## 11. 当前真正阻断：严格五字段用量

经济层要求同 provider/model、同真实 terminal 绑定的五项都 known：input、cache-read、cache-write、output、reasoning。任何缺失保持 null，不推零、不用“没有字段大概没发生”替代。

R3 的 raw relay 从同 Responses 明示字段恢复了 reasoning，包括明确的 0；cache-write 8/8 仍缺失，正确为 unknown。因此六个有效候选都被 usage-unknown 拒绝。

补齐完整用量只是必要条件：短计划、保守召回/冷写成本仍可能让 net≤0，合理结果仍是不执行。不能为了出正例提高 horizon、把未知成本填零、降低质量门槛或删除安全 guard。

相关原始文件在 `E:/Codex-Runs/window-auto-repair-20261025-r3/retest/driver/project`：`raw-provider-usage.jsonl`、`usage-relay-1.jsonl`、`window-three-events.jsonl`、`policy.json`、`future-plan.json`。

## 12. 验证记录与未取得的审查结论

| 验证 | 实际结果 | 入口 |
|---|---|---|
| 最新候选回归 | 108/108，exit0，零外部生成 | `E:/Codex-Runs/window-auto-repair-20261025-r3/implementation-evidence/validation-summary-r3.json` 与 `full-tests-r3.log` |
| raw capture/relay | 5/5，exit0，零外部生成 | `E:/Codex-Runs/window-auto-repair-20261025-r3/retest/root-validation-r3.json` 与同名 `.log` |
| 离线真实原生集成 | 本地 fixture provider 下 W1 实际投影、W2 持久折叠及正负例通过 | `E:/Codex-Runs/window-auto-repair-20261025-r3/implementation-acceptance.json` |
| 线上重测 | 8 逻辑/8 HTTP/8 成功终态，六轮约束核对通过 | R3 `result.json` 与 `retest/driver/project` |
| 原生冷恢复 | 独立 PID38924，1 日志/120 事件，exit0 | R3 `retest/cold.json` |
| canonical 独立读回 | PID19012，198 产物及绑定/source 守卫通过 | R3 `registry-readback.json` |

初次独立审查：`E:/Codex-Runs/window-auto-repair-20261025/review/REPORT.md`，结论 request_changes，P1 最终 W1 TTL 和 P2 明示别名冲突均已修。原漏洞脚本的“通过”表示复现漏洞，不能当修复通过。

修复后独立复验服务端返回 **“This content was flagged for possible cybersecurity risk.”**，具体触发原因未知，没有反复重派或改写请求绕过。根会话做了针对性原生正负例、冷恢复与必要回归；`independentPostFixApproval=false` 保持。交接不把这件事说成模型能力差，也不声称独立审查已批准。

## 13. 最新线上短测的精确范围

协议：`E:/Codex-Runs/window-auto-repair-20261025-r3/retest-protocol.md`。

- 预算 15:03:06.320–15:13:06.320 UTC，墙钟最多十分钟；实际六个案例完成后约 46.9 秒结束，没有时长验收承诺。
- maxOutputTokens=16,384，配置 high；aggregate logical/HTTP cap 为 null，本次实际只有 8 次，不能把声明的八个计划位置当全局硬限额。
- 路由为 opencodego / deepseek-v4.1-flash / deepseek-dsh-v1。名称与 high 是运行配置事实，不推断底层真实模型身份。
- 从真正空会话开始，首个完成回合后 W1 注册于 15:03:33.265 UTC；没有预种日志或填 Goal/Task/Lease。
- 六个顺序输入：完整读两个各 360 行档案 → canary 覆盖为 stable → 旧值失效 → 文件名 → 原 auditToken → 严格最终 JSON。
- 初始请求明确引用两档案原文，以产生可折叠历史；仍通过原生 read 逐字核对完整读取。这是受控输入，不是自然开放业务质量实验。
- 有效候选 W1=2、W2=4，全部真实进入经济评估；更早两次 structure-unproven 保留。实际 projected handoff=0、fold=0、economicApplied=0。
- known subtotal：input 87,855；output 2,080；cacheRead 622,720；reasoning 1,188；total 712,655。reasoning 已在 output 内，不另相加；缺 cacheWrite，不能转成费用或订阅扣减。

较早失败轮有 5 次真实请求与 exit1，保留于 R3 `prior-attempt.json`；两轮合计 13 HTTP。旧失败不能被最新约束通过洗绿。

## 14. 冻结、登记与本次新鲜只读复核

R3 result SHA256：`5c25694de347ef0297b22553dc23187285db93626735a813f885382b55d04872`。

freeze SHA256：`f642db25166a1f00b6038c88111115af124262953700783f9e4639fb154b82cd`。

canonical ID：`window-real-adapter-repair-20261025-f642db25166a1f00`，status=failed；fingerprint=`a48d41f6210910f982527bf5019fea90eb8f241841ef7e4bafb2441e21495717`。

控制状态位置：`E:/Codex-Runs/window-auto-repair-20261025-r3/evidence-home/team-control-plane/default.json`。必须通过正式 `readControlPlaneSnapshot` 读取；磁盘 JSON 有 envelope，直接 `JSON.parse(...).v12Evidence.records` 不成立。

本次 22:55 UTC 新鲜核对：198/198 绑定产物、1,021 项 source/frozen guards、6 项前轮事实均 0 mismatch；canonical 仍 failed。这里只读，没有新模型生成。1,021 守卫包含 974 当前源码/生产事实、基线 1、runtime 14、script 21、environment 11；这不是 1,021 个新功能。

R3 的 runtime、脚本、协议、原始日志和绑定结果现在不可改写。REPORT.md 等收尾文字在 canonical 后生成，故有意不与 result 形成循环绑定；本文和 snapshot 也不冒充旧报告的绑定产物。

## 15. FPS 支线：代码在哪里，哪些没通过

游戏工作树：`E:/Codex-Runs/cod-continuous-resume-20261024-r4/driver/project/work`；HEAD=`9dd7d0cf76f250e42cb658ff7754537a62eff3d4`。

预览：`http://127.0.0.1:5179/`，22:53 UTC 实测 HTTP200，22:55 仍有 node PID31868 监听。桌面窄屏核心交互历史验证 21/21，测试 396/396（16 文件）、生产构建通过；128 项代码/测试哈希前后不变。没有独立补验命中击杀、完整比赛、音频或长时稳定性，不能称完整产品质量通过。

最终报告：`E:/Codex-Runs/cod-continuous-resume-20261024-r4/result.json`；SHA256=`e8d7b8ef35bdb605f0a6890aee3dff271e7d4aea22cb3a1cec24e413cabdc761`。

该段只补剩余 7,482,691 ms，实际 4,830,734 ms（80 分 30 秒），少 2,651,957 ms（44 分 12 秒）。Goal 提前 complete，驱动 exit1，正常清理；不是完整三小时。950 HTTP 中 948 成功、2 取消；W1/W2/W3 实际动作均 0。

独立原生冷恢复 8 日志/11,981 事件通过；canonical `fps-remaining-r4-20261024-fd14c6ae8350e3ec` 仍 failed，5,528 绑定产物，独立 PID38736 历史读回通过。本次只确认旧报告哈希/所需事实，未重新核对全部 5,528 产物。

更早 D 盘 R3 因 ENOSPC 在约 55 分 17 秒失败，之后才机器重启；不能把它统称成已跑满但断电。恢复快照保留，不直接拿旧 Git 管理路径当已迁移工作树。用户未在本次要求再补 44 分钟，交接没有额外付费启动。

## 16. 磁盘清理：实际做了与没做的

审计根：`E:/Codex-Recovery/cleanup-20261025`，包括 `REPORT.md`、`trash-preflight.json`、`trash-result.json`、`clear-old-backup.ps1`；这些也复制到 R3 `cleanup-evidence` 并纳入绑定。

旧备份原位置为 `D:/dsh-test/output/agent-team-complete-20261021/production-state-backup`，被移入回收站后空间未释放。精确匹配当前用户 SID 下 `$R4UE2FA` 及相应 `$I` 索引，预检 239,192 文件、40,672,581,129 逻辑字节、0 reparse，再原生 PowerShell 删除。

实际 15:02:16 UTC 前 0 可用，后 41,528,696,832 字节可用，释放约 38.68 GiB；目标与索引均消失。22:55 复核仍不存在。更早约 50 万文件的广泛清理曾被策略拒绝，未执行；不能把本次精确垃圾清理说成它也执行成功。

22:55 当前可用：C 2,466,029,568 B（约 2.30 GiB），D 40,966,430,720 B（约 38.15 GiB），E 72,426,119,168 B（约 67.45 GiB）。C 盘仍紧张，但不在交接阶段擅自清理用户目录。不要删除当前候选、绑定日志、供应商配置或游戏代码。

## 17. 当前进程、Git 与自动化

| 项目 | 22:55 UTC 状态 | 处理建议 |
|---|---|---|
| provider | python PID29364，127.0.0.1:8788 | 保留；PID 会变，行动前核对命令行与归属 |
| 游戏预览 | node PID31868，127.0.0.1:5179 | 为用户保留 |
| 浏览器/CDP | msedge PID4308，127.0.0.1:9334 | 归属同隔离环境，勿按进程名批量结束 |
| DSH 生产 | 40123 无监听 | 不从旧“保持运行”文字推断 alive；启动是下一项操作，不是交接必要步骤 |
| 隔离试验/其他实例端口 | 40131、40144、41123 均无监听 | 没有旧试验需要继续等待 |
| 一次性 FPS/旧分钟轮询 | 已知两个精确自动化文件路径均不存在 | 不重建循环、不复活过期任务 |

DSH 主仓库 main，HEAD=`bcc588f47d98179572efbf6c559ee7694c14ebc6`，本次只读 snapshot 记录 **192 项 tracked 变化**，包括历史文档删除和既有代码修改。不是干净仓库，不得 reset/clean/stash 覆盖或擅自 commit/push。

游戏 tracked 变化：M AGENTS.md、PROJECT.md、environment-ready.json；D vite.config.ts。旧产品验证还记录过含 untracked 的 11 项脏状态，本次只重查 tracked，不把四项当完整未跟踪清单。详细状态在 snapshot，后续先与其比较。

## 18. 下一步优先级与明确验收条件

**P0：先解决真实用量来源，再决定有无值得执行的重测。** 对照当前真实 Responses 和 provider 文档/本地适配器，确认 cache-write 是否有明确计数或可验证、契约成立的来源。不能凭输入/缓存读/总量相减猜写入量，更不能填零。若供应商根本不返回，报告接口限制与可选路线，不自动反复请求等字段出现。

**P1：如继续经济验收，另建新候选和协议。** 以冻结 R3 为参考拷贝代码，生成新 session/actor、策略、计划、hash、时钟与输出目录；声明真实剩余任务、重放预算和情景。完整五字段、正净收益、安全/质量条件都满足后，才期待实际正例。

正例验收至少包含：真实 provider payload 的 projected handoff；W2 实际持久事件与新进程原生冷恢复；同任务约束/答案质量匹配；source/CAS/owner/cancel/TTL/策略变更负例；没有未知填零；正式登记和独立读回。通过“候选进入评估”不满足这项。

**P1：补修复后的独立风险复核。** 当前记录没有批准意见。只在服务/授权允许的正常条件下继续，带 P1/P2 具体范围与现有证据，不通过换代理/绕过滤器伪造独立通过。没有复核时继续明确这一限制。

**P2：再考虑整合与生产。** 新窗口候选尚未发布；整合要先确认 native/plugin 耦合、实际加载位置、web/headless、manifest、pins/coupling 和可用回滚字节。旧生产备份已部分清理，不能照搬旧“已有备份”假设。全局自动启用是单独产品决定。

**P2：仅在用户继续要求时处理 FPS。** 代码可直接交给产品开发者；不足时长与全产品 QA 不能用本次窗口约束测试补盖。保留旧失败，另立真实窗口，不补写 Goal 或时钟。

明确不默认重做：已部署五类能力、143 旧任务、两个历史损坏根、唤醒延迟、strict-plan B、W2 扩围、W1 默认启用及周期模型监控。

## 19. 接手命令：只读核对与后续新候选模板

先用这组只读命令理解当前事实；不产生模型请求：

```powershell
Get-Content -LiteralPath 'D:/dsh-test/docs/context-runtime-unified-20261001/handoff-20261025-window-auto-and-cleanup.snapshot.json' -Raw
Get-Content -LiteralPath 'E:/Codex-Runs/window-auto-repair-20261025-r3/REPORT.md'
Get-Content -LiteralPath 'E:/Codex-Runs/window-auto-repair-20261025-r3/result.json' -Raw
Get-FileHash -Algorithm SHA256 -LiteralPath 'E:/Codex-Runs/window-auto-repair-20261025-r3/result.json'
git -C 'D:/dsh-test' status --short --untracked-files=no
Get-PSDrive -Name C,D,E | Select-Object Name,Free,Used
Get-NetTCPConnection -State Listen | Where-Object LocalPort -In 40123,40131,40144,41123,8788,5179,9334 | Select-Object LocalAddress,LocalPort,OwningProcess
```

以下是**后续新副本准备好以后**的验证模板，不是要求现在运行，也不是本次交接新增测试结果：

```powershell
# 将此变量改成你新建并检查过的候选根，绝不能指向冻结 R3。
$candidateRoot = 'E:/Codex-Runs/NEW-window-candidate'
$env:DSH_HOME = Join-Path $candidateRoot 'verification-home'
$env:TEMP = Join-Path $candidateRoot 'temp'
$env:TMP = $env:TEMP
$testFiles = @(Get-ChildItem -LiteralPath (Join-Path $candidateRoot 'runtime') -Filter '*.test.mjs' -File | ForEach-Object FullName)
& node --test @testFiles
# 逐步检查 exit code；失败先定位，不继续启动 provider 试验。
```

历史真实入口是 `retest/secure-run.mjs --prepare` / `--launch`，它启动 `retest/driver/retest.mjs`，不是不存在的 host.mjs。该 wrapper 内存读取供应商配置并注入子进程，**不要输出设置文件、环境密钥或带 token 的日志**。

wrapper 检查已有 budget.json、launch.log、launcher-exit.json，使用 wx 防止第二次试验。新目录必须重新准备所有身份、协议和冻结文件；直接改 $candidateRoot 不会自动修复脚本中的绝对路径，也不能复制旧会话状态冒充新试验。

登记模板仅用于**新候选已完成且报告已冻结后**：

```powershell
& node 'D:/dsh-test/staging/context-runtime-unified-20261001/tools/v13-register-ab-evidence.mjs' (Join-Path $candidateRoot 'result.json') (Join-Path $candidateRoot 'evidence-home')
# 再以新的独立进程执行该候选自己的读回验证器。
```

始终显式给新 evidence-home，避免默认写生产。旧 R3 `verify-registry.mjs` 会 wx 写 registry-readback.json，不可为“再验证一次”原地重跑；可仿照本次 snapshot 做只读检查，并把新回执写到新文件。

## 20. 已知坑、未解问题和交付标准

- 环境 `DSH_HOME` 可能为生产；所有测试显式隔离。别用 `$HOME/$home` 当脚本变量，PowerShell 有只读/系统含义。
- junction/链接必须解析真实路径，尤其原生包；同名插件可能多版本，以实际配置和 manifest 为准，不只按文件名猜。
- 涉及 staging 代码变动时同步 web/headless、manifest/pins/coupling；共享原生包改动才扩大适用全量，不为交接重跑整套。
- 多帧 zstd 会话日志不能只解第一帧。原生冷恢复与简单解析分开报告；不能手工修改 journal、Task/Lease/Goal 凑闭环。
- wx 输出存在就是已有试验/证据，不删除输出后重用旧窗口。被绑定产物改一个字节也会破坏旧报告。
- 本次 108 项是当前隔离窗口影响面的回归，不是重新跑了生产全系统 1,755 项；396 项是游戏测试，不是窗口验收。
- 原价格未知、真实 cache-write 缺失、语义质量未证明、独立复核中止、时长未满，是不同限制，不能合并成一句“全通过”。
- 真正费用、订阅消耗与节省金额未知；不要由 token 或 API 单价反推官方订阅扣减。
- 服务端复验中止具体原因、历史沙盒目录删除者、旧聊天唤醒延迟根因仍未知；后两者本次不再调查。

角色策略按用户当前全局 AGENTS：根 Sol，路线明确的 Luna/max，少量重大不确定性才 Astra/high；实际可用 ID/档位以运行时为准。此前代理出现服务端标记后本轮由根继续，没有反复冷启动代理。角色表不是必须开代理的指令，也不应在交接阶段启动代理或新聊天。

后续完成标准：说清改变什么、在哪个实例、用什么实际证据、哪些条件仍失败；必要的最终报告通过 canonical 在新隔离 home 登记，并由新进程读回。达到对应范围即停止，不把过期失败窗口复活，也不为了看见一次自动执行降低原合同。

本次交接全部入口以本地绝对路径给出。无需读取完整聊天才能从 P0 开始；若只接游戏，直接使用第 15、17 节；若接 Agent Team 发布，先读第 6、18 节及对应生产回执。
