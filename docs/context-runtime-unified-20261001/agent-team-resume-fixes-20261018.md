# Agent Team 定时续修

启动：2026-10-17 18:47 PDT（2026-10-18 01:47 UTC），用户授权的一次性续跑。账户五小时 usedPercent=0，ordinaryUsageAllowed=true；自动化 dsh-agent-team 已暂停，不使用 reset credit。

最终状态（2026-10-17 19:59 PDT / 2026-10-18 02:59 UTC）：本轮限域修复已完成全量与 canonical 登记读回；247 文件/1699 项，1698 通过、0 失败、1 既有跳过。`scopedFixesAccepted=true`，`allSystemFeaturesAccepted=false`，未部署生产。中间失败及各次源码冻结均保留，末段为最终回执。

范围：CURRENT_STATE 的 AT-01/AT-02、CTX-01/CTX-02 及必要组合验证。仅 staging 与本次隔离产物；不改生产、活跃 Team、旧试验结果，不做游戏或上游 Browser/Computer 操控接入。W1 常规 off、W2 不扩围、strict-plan B 搁置、经济 auto off 不变。不启动外部 provider 或旧长试验；本轮先使用确定性 adapter、真实原生服务、物理 JSONL 冷恢复，外部模型请求上限为 0。

顺序：
1. 记录最新 344 源码/227 生产文件基线并备份，先补空 preview 和跨毫秒 proposal/最大 TTL 的真实红例。时间边界是可验证假设；历史首次拒绝没有业务错误码，不事后声称唯一归因。
2. 检查原生冷恢复、真实成员动作投递、组板/任务/租约路径。区分 native inactive（无活进程）与丢失 policy 身份；不伪造 running，不用根接管/删卡代替恢复，不从模型文本猜旧权限。
3. 查明严格正式计划在自然任务中未登记的接线/提示缺口，修正适用的真实消费路径，验证空计划仍拒绝、完整当前计划才能正式交付。任务计划不是完整需求计划。
4. 最小修订、定向回归和必要真实宿主/冷读后同步 web/headless、身份清单与 manifest；冻结版本跑适用全量，再做独立 canonical evidence 登记读回并更新当前状态和唯一台账。

证据目录：`D:/dsh-test/output/agent-team-resume-fixes-20261018`。备份：`D:/dsh-test/backups/agent-team-resume-fixes-20261018`。尚未完成整体验收；旧 failed 报告保留。

## 02:15 UTC 中间记录

- 基线 `before.json`：344 载体和 227 生产文件均匹配；原始 9 文件及追加 operator/root-role/strict-native-test 已备份。无外部模型调用，生产/活跃 Team 未改。
- CTX 真实红：`2026-10-18T01-50-48-263Z-d3e717f3`，20 项 3 失败。空 preview、步进时钟 proposal、最大 TTL memo 分别返回错误码，后二者为创建/到期时间分开读 clock 导致自身 lifetime 上限被突破。最小修订一行时间取样复用及安全 proposal 条件；3 文件 35/35 通过（`01-51-00-845Z-b2f9a693`）。历史首轮 commit 无错误码，不能唯一归因为此，但这个真实可复现缺陷已查明。
- AT-01 旧记录权威来源：原生 `tool/ptc-dispatch-start` 与成功 `tool/ptc-dispatch` 成对回执的真实 JSON member 结果，不读普通消息/模型文本/调用者指定 tier。按当前 native id/name、原 Team 和 journal owner、两层 parent/group 关系校验；只补 policy 投影，不改原生 immutable 成员元数据或 running 状态。现代完整结构字段/身份戳仍优先；来源未加载或证据缺失时不猜。
- 新恢复用例原先 group 错误真实失败；首个草稿 user-message fixture 的 content 形状错误同时保留，不当产品失败。修正夹具后原生 Team 测试 7/7。当前 helper 在 policy、正式 tools 和 operator-v5 三处接线。后续仍须补更多错误回执/匹配及真实 task/lease 恢复测试。
- 原三小时日志只读重建：`legacy-roster-readonly.mjs` 实际读取原 JSONL、Session.fromRestore 与真实 TeamService，共 11 日志/10 成员，3 个 tier1+7 个 tier2 恢复；组外/global/upward 负向权限保持，原日志哈希和 native 状态不变。registry 包装器无成员执行，明确 taskContinuationAccepted=false / leaseContinuationAccepted=false。
- AT-02：root/common 增加“任务执行 plan 不等于完整需求计划”，当前严格 root 缺计划时真实 systemPrompt 新 section 给出 canonical dsh-plan-contract、登记及最后 preview/commit 路径；普通/非严格 root 无新增提示，不自动登记或伪造 accepted。R6 初版组装夹具误传 scope=agent.ctx，已按官方实际 assembleContextFor 改为 scope=agent；保留早期错误。用正确夹具在无新增 section 的原实现真实红 `02-14-04-467Z-71ac8ce1` 后恢复修订，最新 5 文件40/40（`02-14-19-232Z-ae3d8625`）。
- 当前身份版本 `v15-2026-10-18.1`，AGENTS hash CCF70286、root hash 10C408E4，其他角色未改；next-turn 身份消费测试通过。尚未同步 headless/清单钉住、尚未冻结或新全量、尚未最终登记与 CURRENT_STATE 更新。

## 02:29 UTC 组合验证中

- 补齐无 start、失败结果、错 call、冲突结果、继承前缀、错成员 ID 和空 roster 行等负例。原生 Team 的 15 项恢复/权限/同任务租约冷策略重建用例通过；最新四文件 47/47、身份三文件 18/18。继承夹具第一次遗漏 `isSeeded` 的错误保留，修正的是夹具，不当产品红例。
- `team-policy`、`team-operator-v5` 已补进 manifest，并与 tools 同步 headless。coupling 明确记录三个文件必须联动，禁止单独投产；没有生产同步。源码冻结为 346 载体，SHA256 `869bc627634ccd3a633fe077c07eaa161c996ea795ad7f04aec577267b1fa350`，227 生产文件未变。
- 真实隔离 Web 宿主实际退出 0，29 个本地 adapter 请求、0 外部请求：真实成员完成初始轮次，缺正式计划时提示被根请求 adapter 实际收到，空计划/不完整证据拒绝，真实 ToolRuntime 的完整当前证明生成 durable validated 交付回执；retention/memo/PTC/W0/W1/W2 组合通过。后续切窗改变向量，最终 status 回到 partial，不能拿前一 accepted 复用到新向量。首次宿主夹具把已完成并卸载的成员当作 live agent 调 whenIdle，失败已保留；当前按实际 lifecycle 判断，不伪造 running。
- 原三小时 11 份物理日志复制到本轮隔离路径，两个真实独立进程（35308→36364）用当前原生 Session/JSONL/Team 和工具执行器：原成员 pres-menus 恢复 presentation 组，新增无写入 review 探针任务认领后，同 taskId、同 runId 租约可冷读心跳；global/foreign 仍拒绝。原日志哈希未变。它不是旧未完成 edit 卡片的复活，也没有启动该成员 LLM/执行 loop；不替代原 Team 全体续跑验收。
- Instant 首轮在 fixture 的 15 秒进入工具期限内未开始，取消前没有 PTC started，失败保留。第二轮通过 4 本地请求的转向、仅执行一次、detached settle/notified/consumed，审批记录器无请求，所以不能归因为审批；实际 tool/call→native started 为 13.265 秒。仅夹具的进入等待调整到有界 30 秒，保留总墙钟预算及全部业务断言，再验证一次；不把未查明的初始时延说成已修。压缩场景已实际退出 0，6 本地请求、精确原历史恢复通过。
- 当前仅 Instant 最终重测仍运行（exec 54017）；尚未全量、fresh 冷读、最终登记。所有业务源码保持冻结，不并发启动同端口宿主或与其冲突的全量。

## 02:41 UTC 首轮全量失败与限域修正

- exec 92858 / cell 490 已真实终态：`2026-10-18T02-29-47-761Z-756a0cf9`，247 文件、1697 项，1693 通过/3 失败/1 跳过。失败结果不改写。此前 exec 54017 的第三次 Instant 已退出 0，4 local/0 external；独立冷读进程 4344 读取 enabled/Instant/compact 的 4 份物理 JSONL 成功，原日志未变。
- 一个失败是 prepared lab template 仍有角色 v15-2026-10-17.1。已备份模板受影响文件，通过既有 canonical prepare 工具重建为 v15-2026-10-18.1；prepared=true、started=false、providerRequests=0，未启动生产宿主。
- 两个失败是 direct steer/queued promotion 的 native Instant fixture 在第二请求完成后等待 idle 超时。加真实 subprocess 时间线后 `02-37-47-725Z-018924ed` 再现 2 失败，Session flush 全部结束，但工作区观察器的仓库子进程仍在 D:/dsh-test 运行。夹具原 meta.cwd=源码根，导致测试流式会话时扫描控制仓库。
- 只修测试夹具：`instant-history-lab.mjs` 给 Session 使用独立空临时工作区，保留原 workspace observer、6 秒 idle 限制及所有 generation/superseded/input once 断言；补 workspace 非源码根的断言，未修改原生 Instant 引擎或生产 observer。真实聚焦绿 `02-38-59-652Z-ca0b033c` 2 文件12/12。旧 output Instant 首轮没有同等过程日志，不因此宣称已唯一归因。
- 新冻结 358 载体，包含准备模板/角色、相关 fixture 和核心。`source-inventory-v2.json` SHA256 `b5853adeffaa624a8f2a77b9d1eb81945666e583369e9465ace7dc9ff271cb81`；227 生产文件未变。首版 inventory 保留，未覆盖旧回执。
- 当前新版全量 exec 86199（`2026-10-18T02-40-01-533Z-9e9c94b4`）运行；补验宿主 exec 69379、端口40126。已查 canonical 测试/tools 无 40126，回归 Instant 用40124；独立 home/control/端口及冻结只读源码，无共享写入，所以可以并行执行，先前为避免未知端口冲突的保守串行限制已用证据解除。新宿主只追加新向量 preview/commit 回执验证，48 local/0 external/600s 边界未变。
- 原日志副本探针按新版源码再次运行：32664→9352，新 review probe 同 taskId/group/same lease 冷心跳通过；绑定新 sourceHash，原 11 日志均未变，仍无成员执行 loop 或旧 edit 验收。

## 02:59 UTC 最终回执

- 第二轮全量 `2026-10-18T02-40-01-533Z-9e9c94b4` 实际 1694 通过/2 失败/1 跳过；角色和 Instant 旧失败消失，新失败来自 `window-protocol-trial` 写死 schemaCount=75。刷新模板已把生产原有启用的 `constraint_note` 带入真实 SDK，实际为76，而非绑定缺失。
- 新真实红例 `2026-10-18T02-49-02-981Z-49ddd476` 5 项/2 失败，分别是合法76目录被拒绝、伪造非空 SDK hash 未被旧 guard 拒绝。限域改为核对同进程/会话的实际 server capture、SDK 文本/hash、正整数 cardinality 与 schema hash 元数据/context schema/route；不改原生权限，不删工具。`02-49-23-747Z-ce1cc5d3` 四文件23/23，包括四角色 A/B 耐久接受/冷恢复和故意 transport error 的正确收尾。
- 最终冻结 `source-inventory-v3.json`，359 载体 SHA256 `70522bda89749b05ade31faa724a18497d7a4a66c2410c08c88cfe67c1fd506d`。只有实验协议校验与对应测试在 v2 后改变；业务插件维持之前已验证版本。359 包含测试和模板，非功能数量。
- 最终全量 `2026-10-18T02-52-18-838Z-20d1f7e2`，exec64248 / cell539 **真实退出0**：247 文件、1699 项、1698 通过/0 失败/1 既有跳过，356121ms。之前两轮全量和所有红例保留，未弱化业务断言。
- 为同一最终冻结包重建的主宿主33 local/0 external，Instant4/0、compact6/0，均真实退出0/hostDisposed=true/background0。输出夹具也使用自有独立临时 workspace；观察器和沙箱保留，没有再扫描控制仓库。每次 manifest 绑定实际目录、源码 hash、脚本、请求/时间预算。
- 当前主宿主既验证缺计划/不完整证据拒绝，又验证完整证明的耐久交付；W2 切窗先让旧回执失效，再以新 preview/vector/idempotency key commit，最终 current native delivery-status=accepted。独立进程物理冷读三个场景的4份 JSONL 成功，未改原文件；旧 v1 partial 和 v2 accepted 冷读另存，不覆盖历史。
- 原11日志副本探针按最终 hash 再跑，进程4216→38428，同原成员 pres-menus / presentation 组、新 review probe task `group-presentation-t1`、同 run-ba97a994-8c18-4674-8d64-86acdf15bee0 冷续心跳，global/foreign 拒绝、原日志不变；依然不称旧 edit/全队 live 已验收。
- `verify-fixes verify source-inventory-v3.json` 实际通过359源码/模板及227生产文件，6插件 web/headless 同步；`result.json` 绑定187产物，包括两轮失败、最终全量、当前四角色原生 family 的实际 binding/request/JSONL/error 产物。report SHA256 `bc5a80192e81512a02147cd13a338191d2217152e6b09fa3dc7e341fccd8f6c1`。
- canonical 既有登记工具使用显式本轮 `evidence-home`，真实 record `agent-team-resume-fixes-20261018-70522bda89749b05`、status passed、fingerprint `a79726737f82ddf5f44a7a3f6a2bd4b8777a5dcd8f65dde0bb46947d6577da15`。独立进程22944 实际读回 `default.json/v12Evidence.records`，187产物/359载体/227生产哈希全部匹配。
- 剩余边界：原全队旧 edit 及 live 执行 loop 安全重接、自然模型完整需求计划到交付、自然 retention 强 SDK oracle、匹配质量/成本 A/B 及经授权生产发布仍未验收。旧 CTX 首次无代码拒绝及 output Instant 首次分发时延不唯一归因；宿主文件沙箱仍为 partial 执行能力，不声称通用 OS 安全。经济 auto off、W1 off、W2 不扩围、strict-plan B 搁置不变。无外部 provider、生产/活跃 Team 修改、commit/push 或新三小时试验。
