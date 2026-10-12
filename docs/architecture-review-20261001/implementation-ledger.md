# DSH 架构优化与 CLM 施工台账

日期：2026-10-01，北京时间。用户已授权施工，要求完成后开新 DSH 会话实测。

## 恢复入口

先读 implementation-plan.md、本文，再读各工作包 validation.md 与实际源码。
当前 goal 已建立，token_budget=100000000；恢复先 get_goal，不重复创建有效 goal。

- 主实例：端口40123，启动本轮时PID16440；后续须重新核对，不拿PID存在替代加载证据。
- 原业务root：session-028e6f5b-1716-4c23-a232-af16d853d191，不steer/取消/重跑。
- staging：D:/dsh-test/staging/architecture-clm-20261001/home/profiles/web/plugins。
- 初始77个mjs及四逻辑profile配置备份：D:/dsh-backups/architecture-clm-20261001-071217。
- 新离线测试：D:/dsh-test/architecture-tests。
- 新DSH实验：工作区目录clm-lab-20261001-a已prepare，root预分配为session-09c1b95e-6d63-474f-82a5-1b5a6c7ea6c4；首次create在gateway参数校验处拒绝，未注册workspace/创建session/发模型请求，runner修正中。

## 工作包状态

| 包 | 当前状态 | 证据/剩余 |
|---|---|---|
| A RequestPlan/meter/receipt/cache归因 | staging完成，独立审查通过 | 64项原聚焦；最终11项RequestPlan；待部署 |
| B Team query/通知/operationId | staging完成，独立审查通过 | 41 checks + 5 timer，6旧聚焦入口；待部署 |
| C Scoped memo/结构化view shadow | staging完成，独立审查通过 | 13/13；第一版只编译memo追加视图，不删原transcript |
| D Artifact/目录/checkpoint | 有界评估待补 | 不与前三批捆绑默认上线 |
| 新会话真实测试runner | 已完成一批真实调用，但功能验收partial | lab-b新root已调用opencodego/DS4.1；模型未按协议调用CLM工具，完整stage失败；lab-a因cacheWrite未知提前停止，均保留原始证据 |
| 独立权限/并发审查 | 已通过限定A/B/C范围 | 身份/TTL/rollback/准备快照/recovery竞态原反例已关闭 |
| profile parity/HMR/全量回归 | 待前置完成 | 当前两项旧失败和health假绿不得抹去 |

## 已确定共享契约

2026-10-01 08:05正确SDK基线：sdk-baseline-runtime-v3.json，PID16440，原root134 schemas，144589 bytes，SDK SHA256=36fb549199503b202530c0acc2f51f1a84e4dad808f1ccf6a05762d406ef215e。
前三个snapshot文件实际执行旧插件函数，只看到global69 schemas，不作为Agent可见SDK基线。
修复探针时改用独立plugin id/name，v3运行结果携带正确codeIdentity，不能用磁盘moduleHash单独证明函数已重载。
部署新增schema后会立即捕获实际SDK，结构化比较与扩证前未知版本继续保留历史；这是临时fail-open，不冒充优化已生效。

桥保留 register(id,transform,{order})，扩preview与onDispatch：

- register(id,transform,{order,preview?,onDispatch?})。
- preview(options) -> {options,receipt}，只调用显式pure preview，不调用legacy有副作用transform。
- prepare(options,prepared?) -> {options,receipt}，最终stream采用一次，不再次消费计数。
- onDispatch({options,inputOptions,result,receipt}) 位于native adapter boundary；abort、未iterate、waterfall阻断无回调。
- receipt提供requestId/stage、before/after bytes/hash、firstChangedMessageIndex/commonPrefixBytes。
- SDK order10，OP order20，context-workspace order30。
- C注册pure transform，同时preview:transform；工具commit写view，投影不改持久状态。

具体API仍以最终测试源码为准；这里是实施协作契约，不是已部署证据。

## 实验边界

新隔离工作区、新DSH root；如需要最多一个新后代，不触碰原Team。
首批上限：合计16个provider请求、1000000 input、24000 output、并发1、10分钟。
必须用当前opencodego/deepseek-v4.1-flash并合并root+后代usage，未知字段不当0。
创建会话与执行分阶段；root配置exact appliedSessionIds后才运行有限apply。
失败停止，保留日志和回执；禁止provider_resume、全局thinking/协议变更。

## 当前禁止事项

不改RustMc、不重启DSH、不打断活跃Team、不清理原数据、不启用生产Reducer或机会压缩on。
不追加delivery/window实测，用户已确认修复并要求不用再测。
不使用Terra；新工具产生的新SDK必须保守兼容验证，不能静默使旧SDK优化失效。

## 部署与真实消费面证据（2026-10-01）

- staging A/B/C 已复制到 web/headless；desktop 是 web junction，teamtest/plugins 是 web/plugins junction。14 个模块四逻辑 profile SHA256 全部一致；四份 patch 均含 request bridge、SDK retention（`mode:apply`, `policy:latest`, conversation `ptc-only`, compaction `certified-latest`）、context-workspace shadow、OP v2 和 Team v2。
- 未重启 PID 16440。原生 HMR 曾因 ObservationPack 未挂 fiber cleanup 触发 `REQUEST_MESSAGE_PROJECTION_DUPLICATE_ID`；补上幂等 `ctx.effect` 注销并分段重载 bridge -> OP -> SDK/C 后成功。证据：`hmr-repair-v7e.json`、`hmr-consumers-v8.json`、最终 `hmr-consumers-final.json`；最终 bridge version=2、registrations=4（bridge+OP+SDK+C）、C moduleHash=`679f1d410979c784eadb70224ad17b78a3c298c95a9873574456b93acff75e0d`、shadow、allowlist为空。临时 probe/reload rows 已从 web patch 移除，证据 JSON 保留。
- SDK 实际 Agent-scope 基线：`sdk-baseline-runtime-v3.json`（原 root 134 schemas / 144589 bytes / SDK SHA256=`36fb549199503b202530c0acc2f51f1a84e4dad808f1ccf6a05762d406ef215e`）；新增 C/B schema 后加载快照 `sdk-loaded-root-v4.json` 是 135 schemas / 145862 bytes / 新 hash，未扩充旧五版证书，未知版本仍 fail-open。
- 运行态边界：`sdk-loaded-root-v4.json` 中 `context_manage` 已出现，但 `team_task_get/list` 仍是旧 schema（没有 `view`/`snapshotRevision`），`send_message` 也没有 operation 字段。B 的新文件和四份 profile 已同步，但为避免中断活跃 Team，本轮没有对 Team 工具插件做 live HMR；B 只能标记 staged/未运行态验收，不能声称 Team query/operationId 已在当前实例生效。
- lab-a `clm-lab-20261001-a`：首个真实请求返回 `cacheWriteTokens=null`，严格 runner 以 `UNKNOWN_USAGE_STOP` 停止；原始 terminal usage 未改写。
- lab-b `clm-lab-20261001-b`：标准预设下的新 root `session-123b0026-9fb7-4a64-89ea-3d5fc536c261`，workspaceId=`1df77d70-197b-4b2b-b060-cb255e2d634c`，route=`opencodego/deepseek-v4.1-flash`, endpoint=`http://127.0.0.1:8788/v1`, protocol=`openai-completions`。6 个逻辑请求，input=`346099`（含 cacheRead），output=`5787`；`cacheWriteTokens` 每次为 null，证据报告保留 `unknownFields=6`，没有把未知记成0。模型实际发的是 5 个 `bash` 调用，未发 `context_manage`、`team_task_*` 或 `read`，故 canonical receipt assertions/oracle 全部失败；这证明标准预设不适合这套工具协议，不证明 C 功能或节省失败。
- lab-c `clm-lab-20261001-c`：改用显式 `agentPreset=ptc` 的新 root `session-576e54eb-e5b4-46bc-a12b-8192ad502151`，workspaceId=`00c8cb7f-f9bd-4830-801e-6daa3f8d3046`，同一路由和端点。2 个逻辑请求，input=`97157`，output=`6648`，`cacheWriteTokens=null`（`unknownFields=2`）。在 PTC 预设下，真实 canonical receipts 已通过 `team_control_status`、`team_task_create`、3 次 `read`、`context_manage` 的 memo_put/memo_get/memo_diff/CAS 冲突等 13 项断言；随后 `team_task_get` 返回后，模型在 run_code 中失败，compact/view 与最终 oracle 未完成。证据：`clm-lab-20261001-c/lab-evidence.json`；这批真实结果确认测试必须显式使用 `agentPreset=ptc`，而不是标准预设。
- 真实会话没有触碰原 root/Team，也没有启用生产 Reducer、机会压缩或 apply allowlist；实验失败阶段均按 runner 停止，未重试相同 session，保留原始 journal/usage/receipt。

## 交付条件

源码/聚焦/共享契约审查通过后，由root一次性部署、同步四逻辑profile并验证运行态。
新会话实测须有canonical工具回执、真实usage与质量oracle，不能只看模型自述。
完成前重读计划/本文，逐包标completed或有证据的partial；结果queue通知原DSH root。

## 最终收口（2026-10-01 10:55 北京时间）

本节 supersedes 上面部署段落中“B 未运行态验收”和“未启用 Reducer”的早期记录；早期证据保留用于说明为什么必须做 Team 依赖 HMR 和受控开关。

- 当前 DSH 仍为 PID `16440`，启动时间 `2026-09-30T16:37:18.1485795+08:00`；本轮未重启、未取消原 root `session-028e6f5b-1716-4c23-a232-af16d853d191`、未清理任何 backup/spill/telemetry/session。
- A/B/C 代码已部署到 web/headless，desktop 通过 web junction，teamtest/plugins 通过 web/plugins junction；15 个关键模块（含 `context-workspace`、`evidence-reducer`）四 profile SHA256 parity=true。最终静态 patch 中一次性探针/HMR 行数为 0。
- ObservationPack 的 fiber cleanup、请求桥 `resetRegistrations` 和依赖分段 HMR 已验证；`hmr-consumers-final.json` 显示 bridge version 2、registrations 4，`hmr-team-v10b.json` 显示 10 个 Team 依赖在同一 PID 完成 HMR。当前最终 runtime receipt：`runtime-services-final.json`，C 为 `shadow`、`appliedSessionIds=[]`，PID 16440；探针随后已移除。
- Team 受控加载后的 Agent SDK：`sdk-loaded-root-g.json`，`schemaCount=135`、SDK bytes `147905`；同一份 SDK 同时包含 `context_manage`、`team_task_get/list(view,snapshotRevision)` 和 `send_message(operation_id)`。这取代旧 `sdk-loaded-root-v4.json` 的旧 schema 结论。
- 新隔离 PTC 会话 `clm-lab-20261001-g`：workspaceId `719030c6-0d6b-4685-aef1-423110982cb1`，root `session-d86a7eb6-0aef-42f2-b01c-6939fd81a260`，route `opencodego/deepseek-v4.1-flash` / `http://127.0.0.1:8788/v1` / `openai-completions`。shadow-bootstrap 全部 21 个 canonical assertions、projection unchanged 和 oracle 通过；usage requests=2, input=93436, output=1837, unknown=0, cacheWrite unknownFields=2。
- 同一新会话的有限 apply 已通过 live gate（C runtime `apply`, exact root allowlist），并通过 mode/view revision、spawn/wait/list、operationId duplicate、task revision/status/phase relation；模型没有完成 apply 阶段需要的二次 context commit，因此 `context-workspace:applied` projection 和两个 commit/revision assertion 未通过，runner 以 `STAGE_CANONICAL_VERIFICATION_FAILED` 停止并取消隔离会话。该包标记 partial，不重试同一 session。
- CLM 结束后 Reducer 运行态最终确认：settings revision `29`（随后文件镜像 revision `177`）、`enabled=true`、`routeMode=session`、`localProviders=[opencodego]`、`remoteAllowed=false`；四 profile 配置保持相同安全边界。历史 telemetry 当前 `events=159620`、`fired=0`，最新 real events 均为 `below-threshold`，因此没有把“打开”冒充成“已产生真实 receipt”。离线 `v13-mechanism-ab` 仍为 ObservationPack `19764 -> 485`、Reducer `19764 -> 374`、`qualityRegression=false`；Reducer focused tests 10/10 通过。
- 最终验证：16 个关键模块 `node --check` 通过；聚焦测试 82/82 通过（包括 request plan/context workspace/live lab/team query/digest/OP/ledger/dedup）；profile parity 通过；PID/启动时间未变。适用全量回归沿用早先记录：626 tests，623 pass、2 known fail、1 skip；两个旧失败与 health 脚本退出码假绿未抹平。
- 用户要求的第二轮架构复核已完成，报告见 `second-pass-optimization.md`；它只提出证据化后续项，没有把未经压测的缓存、inbox 增量、context delivery O(n²)、compaction debt 写盘优化伪称本轮已上线。

## Reducer UI / 第二轮低风险续施工（2026-10-01 14:30 北京时间）

- 备份：`D:/dsh-backups/reducer-ui-fix-20261001-133726`，7 个原始文件已保存。
- UI 保存根因修复：`evidence-reducer-ui/client.js` 现在显式使用当前 Settings revision 做一次原子 `settings.mutate`，成功后 reload mirror 并校验 live revision；失败不再无 revision 重试或落到文件伪成功。页面增加保存后立即生效提示。
- 运行态镜像修复：`evidence-reducer.mjs` 的 JSON 镜像失败会发 warning；`team-operator-v5.mjs` 的 `/team reducer-route` 在 live settings 存在时优先更新 live，live 更新失败直接报错，不再静默 file fallback。
- 配置收口：web patch 现在只有一个 Reducer insert 和一个可编辑 override；一次性 probe/HMR 行数为 0。`reducer-settings-lint.mjs` 输出 `ok=true`，web/headless/teamtest patch、UI mount、最终配置和 JSON 镜像均通过。
- 最终 Reducer 配置：enabled=true、routeMode=session、localProviders=[opencodego]、remoteAllowed=false、thresholdBytes=32768、maxReceiptTokens=1200、maxQuotes=16、timeoutMs=45000、maxInputBytes=131072、maxInputLines=3000。live `settings/describe`：writable=true、applies=live、revision=34；JSON mirror revision=180。
- 低风险性能续施工：`context-workspace.mjs` 增加同 actor/session/view/control revision 和 shadow/apply mode 的 1 秒、最多32项 projection preview cache；source TTL、CAS/view revision、control revision、HMR 实例变更失效。四 profile 源码 parity 保持一致。
- 无重启 HMR 证据：`runtime-services-ui-fix.json`，PID16440，context hash=`2df427...336b9`，bridge registrations=4，C shadow/空 allowlist；PID启动时间不变。
- 验证：7 个修改模块语法通过；Reducer 22 项、context 13 项、Team efficiency 41 项、digest 5 项聚焦通过；配置 lint 通过。适用全量回归未重跑，保留上一轮 626 tests / 623 pass / 2 known fail / 1 skipped 的已知基线。
- 未决：Reducer 历史 telemetry 仍可能有 route-not-allowed/reducer-failed/receipt-unverified；cacheWrite unknown、context delivery/inbox/compaction debt/operation lifecycle 后续项尚未上线。未重启、未中断原 root/Team、未清理任何数据、未修改 RustMc。

### 本轮最终核验更正（2026-10-01 15:00 北京时间）

- 重新按正确入口执行完整回归：根目录 `architecture-tests`、`usage-tests` 和 `phase*-tests` 共 146 个测试文件、679 项，673 通过、5 个既有基线失败、1 个跳过；日志 `D:/dsh-test/docs/architecture-review-20261001/full-regression-ui-fix-20261001-complete.txt`。失败仍是 `live-lab-runner` 的 schema drift 与 request-plan/request-message-projection 品牌契约，不由本轮 Reducer UI 或 context projection cache 改动引入。
- 最终 live telemetry 已观察到 `events=163035`、`fired=1`、`kinds.reduced=1`；这证明开关、路由、调用和 receipt 记录链路至少成功触发一次。历史 `route-not-allowed=8006`、`reducer-failed=112`、`receipt-unverified=2` 仍保留并单独计数。
- 四逻辑 profile 的 `evidence-reducer.mjs`、`context-workspace.mjs`、`team-operator-v5.mjs` SHA256 parity=true；web/desktop/teamtest 的 Reducer UI client parity=true；probe=0、`request-message-projection` 唯一。PID `16440` 和启动时间未变。
