# Agent Team 平台缺陷修复台账（2026-09-27）

来源清单：`D:\dsh-test\workspaces\RustMc\docs\PLATFORM-DEFECTS.md`

本轮目标：逐项修复清单中的控制面缺陷，兼容运行中的 DSH 和已有 Team 会话；不重启、不清理活动会话或旧备份。

## 运行态

- DSH web 进程保持运行：PID `101020`。
- HMR 已加载：
  - `[team-tools-v2-r10] perf63-bind-fix+verifier-read+context-time+verifier-coalesce`
  - `[team-control-plane] ...+bind-fix+plan-scope-lock`
- `web`、`headless`、`desktop`、`teamtest` 四份 profile 的目标插件哈希一致。

## 逐项结果

### P0-A 写入门禁

| 编号 | 状态 | 结果 |
|---|---|---|
| A-1 | fixed | 相对写入按解析后的 `workdir` 绝对路径校验。 |
| A-2 | fixed | `.NET File/Directory` 写入目标进入同一 scope 校验。 |
| A-4 / A-4b | fixed | 只有实际文件写入/递归 `run_code`/不透明动态执行才拒绝；仅 import 或字符串说明不再误报。 |
| A-5 | fixed | 系统临时目录可用于工作区外临时产物；工作区本身位于 TEMP 时不再被整棵放行。 |
| A-6 | partial, documented | 常见 `--out/--output/--target-dir` 等子进程输出参数会按 scope 校验；任意程序完全无参数、自行写盘的未知行为无法由 Node hook 沙箱化，仍列为残余风险。 |
| A-8 | fixed | 受控 `tools.write/edit/bash` 子调用放行；直接 FS/进程逃逸仍拒绝。 |
| B-13 | fixed | `team_worktree_setup` 回写 `worktreePath`，guard 将其纳入根集合。 |
| C-1 / C-2 / C-5 | fixed | 跳过 PowerShell 开关；引号内 `>`/`<` 不误判重定向；`Copy-Item` 只校验目标，不把只读源当写目标。 |

### P0-B 静默数据不一致

| 编号 | 状态 | 结果 |
|---|---|---|
| B-19 | fixed | `team_acceptance_packet` 未知顶层键 fail-closed；`resource_scan` schema 改为对象。 |
| B-14 | fixed | `task_contract_set` 合并当前 contract，递增 revision，并写回控制面。 |
| B-16 | fixed | `edit` 实际写 `commitSha/evidenceIds`；另提供 completed 卡专用 `bind_fix`。 |
| B-5 | fixed | 同提交重审生成新 `packetId`，旧包保留；verifier 重复投递仍按提交/task 集合合并。 |
| B-9 | fixed | 复用 waiting ticket 时清除旧 resolution/resolvedBy/resolvedAt。 |
| B-20 | fixed | `inbox_ack` 支持 `inbox_id`，info 行可确认。 |
| B-22 | fixed | `waiting_resolve` 支持 `ticket_id`，可只关闭一张票。 |

### P1 结构性

| 编号 | 状态 | 结果 |
|---|---|---|
| B-12 / B-13 | fixed | worktree 默认 base 改为 `main` 或计划指定 base；拒绝 stale base；回写 worktreePath。 |
| B-21 | fixed | tier 1 可写 `docs/groups/<group>/`，不可越组。 |
| A-3 | fixed in current path | `git add/commit` 要求当前成员存在活动 approved plan lease；原始旧提交未在 live Team 上重放。 |
| B-28 | fixed | completed 卡可直接 `bind_fix` 更新 commit/evidence，不动 status/phase/owner。 |
| B-8 | fixed | `edit` 同步 contract owner；组长可为本组卡补 owner。 |
| B-18 | fixed | 组长可释放本组无活动 lease 的 inactive owner 卡。 |
| C-4 | fixed | milestone 绑定 active `taskId`，不再把同一成员的其他任务一律判为忘标记。 |
| B-17 | fixed | active lease 显示为 `suspended-between-rounds`，并带 `leaseActive/leaseExpiresAt`。 |
| B-15 | fixed | `review_package` 返回包体和逐任务 `resourceScan`。 |
| B-11 | fixed | 在飞 plan 替换拒绝串给出 release → replace → acquire 三步。 |
| B-23 | fixed | plan 成为 write scope 权威来源；propose/approve 同步 task 行；task 行静默分叉被拒绝。 |
| B-24 | fixed | manual 票 `now < nextCheckAt` 时不触发 SLA 催办。 |
| B-25 | fixed | 新增 `agent-team-packet-meta-contract.md`，明确四个平台注入键和 digest 口径。 |
| B-26 | fixed | verifier 可只读任意 `group-*` 板，仍不能写组板。 |
| B-27 | fixed | context percentage 带 `contextPct@<ISO timestamp>`。 |

### P2

| 编号 | 状态 | 结果 |
|---|---|---|
| B-10 | fixed | 增加 Rust library/crate verification recipe，不再只匹配 UI。 |
| B-7 | fixed | requirements snapshot 返回 visibility 统计与 scoped content revision。 |
| B-6 | fixed | acceptance packet 有平台 meta 信封。 |
| B-3 / B-4 | fixed | contract revision 自增；requirements 同时暴露 ledgerRevision 和 contentRevision。 |
| B-1 / B-2 | fixed | worktree 根已纳入 guard；依赖完成由 scheduler/reconcile 路径重算。 |
| C-3 | fixed by deferral | milestone tick 在 owner 仍有 open task 时只记录，不 arm compaction，并明确要求继续收口。 |
| C-6 / D 类 | no code change | 按原清单保持“非缺陷/不修”。 |

## 验证

- `node --check`：四个 profile 的 `team-tools-v2-r10.mjs`、`team-control-plane.mjs`、`write-scope-guard.mjs` 全部通过。
- focused：
  - write-scope guard：3/3 通过。
  - acceptance verifier：通过。
  - plan scope lock：同步成功且 task 行分叉被拒。
  - control-plane-v5 + recovery：通过。
- full offline regression：`314 tests, 307 pass, 6 fail, 1 skipped`。
- 剩余 6 项均为清单外、且在本轮修改前已存在的旧测试/夹具问题：phase3 identity 文案断言、idle-watch 旧 wake 夹具、lifecycle checkpoint 夹具、runtime-guard alternate control-plane 夹具、startup-arming、activity-digest timer。它们未被用于宣称本清单已修复，也不影响本轮目标插件的 HMR 加载。

## 第二轮修复（2026-09-28）

来源：`PLATFORM-DEFECTS.md` 的“未通过 / 新发现”章节。

| 编号 | 状态 | 实现与证据 |
|---|---|---|
| **C-4 残留** | fixed | `team_delivery_check` 只把 `done=true && milestone.taskId === task.id` 判为 `owner-forgot-to-mark-it`；无绑定或绑定其他卡改为中性 `milestone-unbound`，并输出 `ownerMilestoneTaskId`。定向测试同时覆盖 t35→t41 与 t41→t41 两种绑定。 |
| **B-29** | fixed for new packets | `contentDigest` 改为 `v2`：先规范化并递归排序对象键，再对存储行字段和注入前 `metaInput` 计算 SHA-256。`packet.meta` 新增 `contentDigestVersion:2` 与 `metaInput`；`docs/agent-team-packet-meta-contract.md` 已改成可从落盘行独立复算的算法。旧 `v1` 包因当时未保存注入前 meta，仍保留为不可独立复算的 legacy 记录。 |
| **B-31** | fixed | completed 的 `discussion`/`review` 卡可直接 `advance_phase accepted`；`allowDirectAccept` 只在调用方传入且卡状态/kind 匹配时放行，未放宽普通 edit 卡的相位机。 |
| **B-32** | fixed | `context-debt` manifest 现在携带 debt 的 `hash`/`revision`；可见 manifest、durable receipt 和 context cursor 都会把已交付的 debt 记入版本，后续同版本不再重复提示；源内容变化会产生新 hash 并重新提示。 |
| **A-6** | partial, unchanged | 仍无法由插件层对所有未知子进程做 OS 级 sandbox。 |
| **B-30** | no platform change | 按清单保持提交方纪律/登记备查。 |
| **B-28(i)** | unverified | 本轮未在真实 completed 卡上提交仅脚本绑定修复；`bind_fix` 的卡面指针修复已可用，但 lease/commit 窄路径仍未验证。 |

第二轮验证：

- 新增 `phase11-tests/platform-defects-second-pass.test.mjs`：5/5 通过。
- 聚焦回归：`v14-identity-context` + `v14-runtime-bridge` + 新测试，共 `35 tests / 35 pass / 0 fail`。
- phase9-phase11 回归：`271 tests / 269 pass / 1 fail / 1 skip`；唯一失败为既有的 `v14-startup-arming.test.mjs`。
- 全量 phase1-phase11 回归：`319 tests / 312 pass / 6 fail / 1 skip`；6 个失败仍是上表列出的既有测试/夹具问题，本轮新增 5 条测试全部通过。
- 四份 profile 的四个目标文件哈希一致；未重启 DSH，web PID 仍为 `101020`，`127.0.0.1:40123` 保持监听。

## 第四轮修复（2026-09-28）

来源清单：`D:\dsh-test\workspaces\RustMc\docs\PLATFORM-DEFECTS.md`

- 输入指纹：size `125355`，SHA256 `6F1A6F53079D84891E18BE216F8E3B7B7F87FD3B844D5E88DA889DE00C135AD4`。
- 备份：`D:\dsh-test\backups\platform-defects-fourth-pass-20260928-063135`。
- 本轮不重启 DSH、不中断 active Team、不清理备份 / spill / telemetry / session。

### 逐项结果

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-46 / B-66** | fixed | `write-scope-guard.mjs` 区分只读 git 子命令与写子命令；`git show/diff/log/rev-parse/cat-file/ls-tree` 下的匹配字符串不再触发写门禁，`git ls-files` 的 `--exclude-standard` 不再被当成写目标。`platform-defects-fourth-pass.test.mjs` 覆盖两条原始形态。 |
| **B-58** | fixed | `team-v12-contract.mjs` 的 scope conflict 读取任务顶层实时 `lifecycle`，不再采用陈旧的嵌套 `contract.lifecycle`。定向测试用 completed 顶层 / running 嵌套反例验证。 |
| **B-41 / B-54** | fixed | `team-control-plane.mjs` 让 `-rN` 与 `meta.revision` 对齐；重提包写入实际上一版 id，`r2` 指向基包、`r3` 指向 `r2`，不再统一归一到基 id。 |
| **B-44** | fixed | plan propose 对含 `*` / `**` 等 glob 元字符的 write scope fail-closed 拒绝，错误码 `plan-scope-glob-unsupported`；不再静默按字面前缀执行。 |
| **B-52** | fixed | `team-v14-waiting.mjs` 与 `team-v12-runtime.mjs` 分离 `waiter`（发起者）和 `owner`（被等待任务责任人）；`waiting_set` 写后回读自证。 |
| **B-67 / B-42** | fixed | `team-worktree.mjs` 对“干净且既有分支是请求 base 的纯祖先”自动 fast-forward，再布局 worktree；分叉或脏树仍拒绝。 |
| **B-62** | fixed | `timed-out` wake dead letter 允许转 `cancelled`，死信可收口，不再永久只增不减。 |
| **B-51** | fixed | `waiting_set` 创建后立即回读；无法回读则报错，不再返回一个不可见的 `ticketId`。 |
| **B-56** | fixed | `requirements_snapshot` 接受顶层 `task_id`，不再因参数层级错误退化为返回全注册表。 |
| **B-49** | fixed | `task_contract_set` 对未知字段 fail-closed，避免“计数器前进但契约体未变”。 |
| **B-45** | fixed | `discussion` / `review` 零 write scope 通过契约校验；第二道 `scope-required` 门不再把零写入卡永久冻结。 |
| **B-50** | fixed | ready gate 错误按成因区分，`already-running` / `lease-active` / 真 scope overlap 不再统一报 `scope-conflict`；members 传入完整名单。 |
| **B-53** | fixed | `team_task_get/list.ready` 与 `ready_queue.eligible` 同源；task get/update 未传 `board` 时按可见卡自动解析，减少默认 global 误判。 |
| **B-69** | fixed | `verifier-review` 及之后相位要求 `status=completed`，禁止 pending 卡靠相位跳级出包。 |
| **B-55** | fixed | active lease 已过期时返回 `lease-expired`，不再与“从未获批”混为同一种 scope 拒绝。 |
| **B-43** | fixed | 非产品 / 非提交交付证据允许 `commit_sha:null` 完成，不再要求 edit 卡为 gitignored 探针伪造提交。 |
| **B-59** | fixed | global 板允许 tier 0 更正 `subject` / `description`，解决卡面创建后不可更正。 |
| **B-48** | fixed | inbox 投影补 `inboxId` / `inbox_id` / `wake_id`，列表暴露的 id 与 ack 接受的 id 对齐。 |
| **重启旧 Team 自动唤醒** | fixed | `team-idle-watch-v6.mjs` / `team-activity-digest.mjs` 区分 restored control state；进程刚恢复但尚未观察该 Team running 时不武装唤醒。 |
| **冷启动 getter 可变引用** | fixed | `team-control-plane.mjs` 的 dispatch / lease getter 改为返回快照；`lifecycle-restart-dual.test.mjs` 冷启动原始反例由红转绿。 |

### 第四轮验证

- `phase11-tests/platform-defects-fourth-pass.test.mjs`：7/7 通过。
- `second + third + waiting` 定向组合：22/22 通过。
- `v14-runtime-bridge.test.mjs`：17/17 通过。
- `v14-startup-arming.test.mjs`：8/8 通过。
- phase8 `team-hardening.test.mjs`：全绿；同时修正测试夹具对 root authority 包装对象的断言。
- 全量 phase1-phase11：`94 test files / 94 pass / 0 fail`；日志：`D:\dsh-test\output\platform-defects-fourth-pass-full-20260928-rerun2.log`。
- 四个 profile 的 9 个目标插件 `node --check`：36/36 通过；`v14-profile-parity.test.mjs` 通过。
- 四份 profile 的 9 个目标文件哈希已统一：

| 文件 | SHA256 |
|---|---|
| `write-scope-guard.mjs` | `F99B333CF4B3FCDD535BE727BFACC163F40AEF0EE7FD13E7520EDB11E6040861` |
| `team-v14-waiting.mjs` | `EE9D04E3E2818723ECA2A78D088C7044607C2DB751FF62C3911CB92BBF9D7405` |
| `team-v12-contract.mjs` | `68D6BBB5CB5BB827EEC07EDD8C1CE990EF0C7B35473F732EEA96A7F6E112EB60` |
| `team-control-plane.mjs` | `25F980E59C0C45637A85EC338194FA00DA4651AA2D26952BAB7DC567F3D559A3` |
| `team-worktree.mjs` | `F49CADF5DEB471D97F580774C6547B8C1492241B34C2CB08E9A9AE4E3ADD676E` |
| `team-v12-runtime.mjs` | `3ADEE2AACB6BAED0CA242F99A6A38155EC4123084CE82B750FEA021308F3CDF8` |
| `team-tools-v2-r10.mjs` | `56A349F9C32C42BCB4943337122C66EE07D2EE09F66094A7A5CCAC1AD4B53DF6` |
| `team-idle-watch-v6.mjs` | `8E8B677512981015D0183933139826AAF66AC4504FEACA947FBE2F7AF541CD9C` |
| `team-activity-digest.mjs` | `6533EA7D804E7E85B76D40DBD5C3E11BAD929AF4BDB0F8EE3F1F175D4ADA11D0` |

### 第四轮未闭合

| 编号 | 状态 | 说明 |
|---|---|---|
| **A-6** | partial | 插件层无法对任意无参子进程做 OS 级 sandbox；仍保留残余风险。 |
| **B-28(i)** | unverified | 真实 completed 卡上的脚本绑定修复窄路径未重放；`bind_fix` 卡面指针路径可用。 |
| **B-30** | no platform change | 仍是提交方纪律 / 登记项。 |
| **B-33 / B-47 / B-61 / B-64** | open | waiting reconciler 对不可求值条件的自动解除、幽灵派生票、`auto:condition-cleared` 假理由，本轮未宣称修复；需要真实等待票反例复测。 |
| **B-36** | open | waiting ticket id 仍未按每票唯一化。 |
| **B-37 / B-38 / B-39 / B-40** | open | evidence 查询 / 卡面证据完整性 / delivery-check 角色缺口 / milestone 持久化仍需独立验证。 |
| **B-70** | no plugin change | 后台作业孤儿进程属于运行环境生命周期问题，本轮未改平台插件。 |

## 第五轮核验（2026-09-28 · tier 0 第四轮修复逐条复测）

- 输入指纹：size `127255`，SHA256 `E3EEADD98F5E46AE6B1CF1DB15F7A2E3381A88455E7703A7D83B77F2FF67F157`。
- 追加复测输入指纹：size `131989`，SHA256 `6EE4A595D3390E0AB056BCC9E53CCD24E60D7AB40B4006B940E08DDB46E4915B`。
- 新增内容均为 tier 0 对第四轮修复的原始反例复测记录；未发现新增缺陷编号，无需平台代码修改。

| 编号 | 状态 | 复测结果 |
|---|---|---|
| **B-68** | fixed-verified | 原始反例已由红转绿：`team_task_get(task_id:"group-world-t72")` 不带 `board` 返回目标卡；可由 B-57 的自动解析板修复一并退役。 |
| **B-51** | fixed-return-side-verified, dependent | 原始异常已消失，`waiting_set` 返回完整自证 ticket；紧随其后的 `waiting_list` 不含该票属于 B-61 / B-9，不作为 B-51 回归，也不新记缺陷。端到端票可见性仍随 B-61 / B-9 保持开放。 |
| **B-59** | fixed-verified | 原始反例已由红转绿：tier 0 成功编辑 `task-68` 的 subject / description，revision 前进到 14。 |
| **B-42** | fixed-verified | 原始反例已由红转绿：`team_worktree_setup(target:"member-world-anvil", task_id:"group-world-t77", base:"main")` 未被拒；分支计数 `53/0 → 0/0`，分支头与 `main` 一致。主检出 porcelain 的旧表述已由执行者撤回，但更正不改变转绿结论。 |
| **B-43** | fixed-verified | 原始反例已由红转绿：复测卡以 `commit_sha:null` 完成并被接受，卡面 `commitSha=null` / `status=completed`。 |
| **B-44** | fixed-verified | glob scope 的原始反例已按 `plan-scope-glob-unsupported` fail-closed 复测并转绿。 |
| **B-45** | fixed-verified | 原始反例已由红转绿：`kind=discussion` / `writeScopes=[]` 的复测卡完成 `create → claim → complete`，不再被 `scope-required` 拒绝。 |
| **B-67 / B-69** | fixed, not re-tested | 代码修复保留；本轮因缺少符合原始反例条件的安全载体未复测，不得据代码或台账声明写成 fully verified。 |

### 第五轮未闭合

- 保持开放：B-33 / B-36 / B-37 / B-38 / B-39 / B-40 / B-47 / B-61 / B-64 / B-70。
- 保持 partial：A-6。
- 保持 unverified：B-28(i)、B-67 / B-69 的原始反例复测。
- B-42 / B-43 / B-44 / B-45 的原始反例复测现已全部落盘；此前里程碑条件②的复测证据缺口已关闭。
- 本轮无插件代码改动，未同步 profile，未重跑全量回归；仅更新台账与 watch state。

## 第六轮修复（2026-09-28 · B-71 / B-72）

- 输入指纹：size `144067`，SHA256 `2291CDC7D677CA75D98E60A6A5B94F88A2AB05C629AF3A52B428297323459DED`。
- 备份：`D:\dsh-test\backups\platform-defects-b71-20260928-0810\team-tools-v2-r10.mjs`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-71** | fixed, focused-verified | `team-tools-v2-r10.mjs` 新增 `scopesAreEntirelyIgnored()`：仅当每个 `writeScope` 同时满足 `git ls-files` 为空、无 tracked diff、`git check-ignore` 命中时才允许 `commit_sha:null`；`complete` 同时保留原证据分类路径。拒绝串现在区分“存在 tracked scope”与“证据未证明非产品交付且 scope 不全被忽略”。定向测试覆盖全忽略 scope 的正例与 tracked scope 的负例；活卡 t25 已由原执行者通过补受跟踪载体收口，因此未再改动活卡复现原始反例。 |
| **B-43 更正** | fixed, focused-verified | 第五轮把 discussion 卡当成 B-43 原始对象，验证类别不匹配。B-43 的原始对象是 `edit` 卡 + gitignored scope；本轮的 `scopesAreEntirelyIgnored()` 修复覆盖该对象类，但未在活 edit 卡上重放原反例。 |
| **B-72** | no platform change | 缺陷位于产品仓的 `crates/mc-proto-schema/tests/citation_integrity.rs`，不属于 DSH 平台插件；本轮不改产品文件，保留受准绕行“私有 target 命名为 `target` 或移出扫描域”，并登记为残余风险。 |

### 第六轮验证

- `platform-defects-fourth-pass.test.mjs`：8/8 通过。
- `platform-defects-fourth-pass.test.mjs` + `v14-runtime-bridge.test.mjs`：25/25 通过。
- 全量 phase1-phase11：`94 test files / 334 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b71-full-20260928.log`。
- 四份 profile 的 `team-tools-v2-r10.mjs` 哈希一致：`83C59EA97D303242C61CA83DA752DFCE4C720FE833033D085787A9F733D64D3E`。

## 第七轮修复（2026-09-28 · B-73 / B-74 / worktree 拒绝诊断）

- 输入指纹：size `154848`，SHA256 `54CF1605A817B2638BE4518A18800BE638A288AAF66CAECD024B2CBE6B79FB9C`。
- 备份：`D:\dsh-test\backups\platform-defects-b73-b74-20260928-0845`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-73** | fixed, focused-verified | `team-control-plane.mjs` 的 `normalizeUnresolvedEntry()` 保留 `itemId` / `unresolvedId`，并同步输出 `id` 与 `itemId`，使 `room_snapshot.unresolved` 与 `team_room_resolve` 使用同一 legacy ID。`team-v12-runtime.mjs` 在 `team_room_resolve` 成功后把结果镜像写回 `v12RoomWake`，并保留按 legacy text 回退定位的兼容路径。定向测试覆盖 `{ itemId: ... }` 反例可列出且可 resolve。 |
| **B-74** | fixed, focused-verified | `team-v12-room-wake.mjs` 的 `normalizeRoomWakeState()` 在每次规范化时由 `confirmations` 重算 decision 的 `missingConfirmations`；`proposeDecision()` 与 `confirmDecision()` 也显式写入派生值。定向测试覆盖三次确认后从 `[3]` 收敛到 `[]`，并覆盖旧状态在 normalization 时自动修复。 |
| **worktree 拒绝诊断** | fixed, focused-verified | `team-worktree.mjs` 的 `source-worktree-dirty` 现在返回 source path、branch、脏文件列表；`destination-worktree-invalid` 返回 destination path 与底层 detail。`team-tools-v2-r10.mjs` 的 merge refusal 同步携带 source branch、worktree、脏文件列表和 destination path。定向测试覆盖两类拒绝。 |
| **B-75** | no platform change | turn 结束收割其 job object 子进程属于 DSH/harness 进程生命周期，不在 team plugin 的控制面或工具层；插件没有可安全接管该 job object 的入口。保留已受准的 `Start-Process -PassThru -WindowStyle Hidden` 脱离 job object 绕行，并要求跨 turn run 同时检查驱动进程与日志增长。 |

### 第七轮验证

- `platform-defects-fifth-pass.test.mjs`：3/3 通过。
- 全量 phase1-phase11：`338 tests / 337 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b73-b74-full-20260928.log`。
- `v14-profile-parity.test.mjs`：1/1 通过。
- 四份 profile 目标文件哈希一致：

| 文件 | SHA256 |
|---|---|
| `team-control-plane.mjs` | `95B6A45CBED1E81B9513DC9E39BE81E017EF8B842E2C45B70D47CF904BDFC51A` |
| `team-v12-room-wake.mjs` | `AE2933DFF8C85BFFD43EB8E0B255918F05712AF4F9193266FE75E9EE2863CBA2` |
| `team-v12-runtime.mjs` | `EB52E6C7531DA59A5FDDD4ED3ABC27505730D1F58AC0386F6A327B7804EBC51F` |
| `team-worktree.mjs` | `5B793A997E7DA80BC4530D1EEF4D68B97B279363216B29D63FE51794964B2A8A` |
| `team-tools-v2-r10.mjs` | `B34B7F19A26C723192AA26E07E7B8560BA15CFFAA08324C76B5D381E9A57F4F9` |

- 未重启 DSH；web PID 仍为 `101020`，`127.0.0.1:40123` 保持监听。
- B-73 / B-74 当前由 focused test 与重建 legacy fixture 验证，未在 live root Room 上重放原始反例；不得把它写成 live 原始反例已验证。

## 第八轮修复（2026-09-28 · B-84 .. B-91）

- 输入指纹：size `193282`，SHA256 `177A3DE57431CF2EA354754B40D9BADECE3D37CBAEB39C80540F6A4BB82A2F1E`。
- 备份：web 原文件 `D:\dsh-test\backups\platform-defects-b84-b90-20260928-100837`；headless 同步前 `D:\dsh-test\backups\platform-defects-b84-b90-headless-20260928-101515`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。web PID `101020`，`127.0.0.1:40123` 保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-84** | no platform change | 缺陷位于产品仓 citation guard 的扫描域包含 ignored fixture；平台插件无权改产品文件。残余风险保留：受跟踪提交面的门禁读数仍可能依赖工作树中的 ignored 工件。 |
| **B-85** | fixed, focused-verified | `team_plan_approve` 新增 `planApprovalVerdict`。组长只能批准本组板、本组成员且不越出 `docs/groups/<group>` 的计划；他组 scope、全局治理文档和 global 卡均由组长批准时 fail-closed，拒绝串具名越界对象。 |
| **B-86** | fixed, focused-verified | `evidence_query` 新增 `evidenceQueryEnvelope`，回执暴露 `idResolution`、`formRejected`、`queryKey`、`idStatus`、`candidateCount`，区分“形态不接受 / 前缀无命中 / 唯一命中 / 多义命中”，不再把短 id 与不存在混成同一种空结果。 |
| **waiting_resolve 第三例** | fixed, focused-verified | `waiting_resolve` 支持 owner / waiter / responsible 回退匹配；重复 resolve 幂等；not-found 回执带候选列表，解决存在的票据被误报 `not-found`。 |
| **B-87** | fixed, focused-verified | 新增 `dependencySatisfied`。`blocked_by` 默认要求依赖任务 `status=completed` 且 `phase>=accepted`，不再仅凭 `completed` 自动放行；依赖相位可通过 `dependencyPhase` 显式声明。 |
| **B-88** | fixed, focused-verified | merge lock 移到 `%TEMP%\dsh-merge-locks\<repo-hash>.lock`，不再在目标 worktree 创建 `.dsh-merge.lock`，从源头排除工具自身锁文件触发的 `destination-worktree-dirty`。 |
| **B-89** | fixed, focused-verified | merge 成功后相位推进使用幂等 `skipIfNotForward`；回执分开给出 `merged` 与 `phaseAdvance.status/phase`，相位已越过目标时不再把成功合并伪装成整体失败。 |
| **B-90** | fixed, focused-verified | `task_contract_set` 支持可选 `expected_contract_revision`；锁内再次 CAS 检查，冲突返回具名错误，成功回执包含前后 contract revision。 |
| **B-91** | fixed, focused-verified | tier-2 `team_run_lease acquire` 前通过 `memberWorktreeSyncPlan` 自动同步自己的 worktree 到 main；成员树落后且可纯快进时先快进，避免“main 已含修复、成员树仍产出旧形态”。 |
| **B-83 补充二** | clarified, no further code change | 当前 `control-plane lock timeout` 文案已明确“本次未取得锁、未写入、可安全重试”；本轮未另改代码，也未宣称批量 evidence 部分落库问题已解决。 |

### 第八轮验证

- `platform-defects-sixth-pass.test.mjs`：8/8 通过；本轮收口时再次复跑 8/8。
- focused 组合：69 tests / 69 pass / 0 fail。
- 全量 phase1-phase11 串行：353 tests / 352 pass / 0 fail / 1 skipped；日志：`D:\dsh-test\output\platform-defects-b84-b91-full-serial-20260928.log`。
- `v14-profile-parity.test.mjs`：1/1 通过；本轮收口时再次复跑 1/1。
- 四份 profile 的 7 个目标文件 `node --check`：28/28 通过。
- 四份 profile 目标文件哈希一致：

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `7A6D55A2DDD6F723E724E36BD7CC84F6427D9DA6A4D434DB8934950CE28DFD20` |
| `team-v12-runtime.mjs` | `9656BC0B7B45DE7D5611CAC45F1F8BAA3660C8FC3B58E0BB34DCF46F8041D023` |
| `team-v14-waiting.mjs` | `121766D01DE4FC8667CBF6D02B5C9658AA031A0DCC214127EE1734CFD7D69519` |
| `team-control-plane.mjs` | `EBAFD869A35205EAEA302C34F902D98441CC8EDEC430DCAE55A1D22B3A5E5DC9` |
| `team-worktree.mjs` | `F4891C0D351ACC7E49D438691308607F7ECE872EB9B65724BCF157E1EDDE8EE1` |
| `team-policy.mjs` | `E54F633E367655606DCBC331851E313BC88CB5F1248C2225DA9AEDCCC875A287` |
| `team-v12-evidence-scheduler.mjs` | `4BE5C6C4E36CDD065FE4E249A0FB71B2E211861ECF4ECB17D323CB46F63F93CD` |

### 第八轮未闭合

- B-84 是产品仓残余，不因平台修复关闭。
- B-83 补充二只改善了超时回执语义；批量 evidence 的部分落库状态仍未逐条返回。
- B-85 .. B-91 当前均为 focused fixture 验证，未在 live root Room / live G-WORLD 上重放全部原始反例；不得据此写成 live 原始反例已全部转绿。

## 第九轮修复（2026-09-28 · B-92 .. B-94）

- 输入指纹：size `197239`，SHA256 `4EF6BA93C01C34AF8FE72FADBCBA810387EE9E4A1B8FCA9280EAA1B644B1F87D`，mtime `2026-09-28T10:30:43.5531414+08:00`。
- 备份：`D:\dsh-test\backups\platform-defects-b92-b94-20260928-103619`，包含 web/headless/desktop/teamtest 四份 `team-milestone-v2.mjs`、`team-tools-v2-r10.mjs`、`write-scope-guard.mjs`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。web PID `101020`，`127.0.0.1:40123` 保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-92** | fixed, focused-verified | `team-milestone-v2.mjs` 新增两分钟 `RECENT_DONE_WHEN_WINDOW_MS`；`set` 写入 `doneWhenSetAt`，`done` 记录 `doneWhenEditedMsBeforeDone` / `doneWhenEditedBeforeDone`。`team_milestone(action:"done")` 新增可选 `expected_done_when`：证明在两分钟内设置或改写时，必须逐字回显活动证明，缺失或不一致均 fail-closed；超窗仍允许 tick，但回执保留证明年龄供审计。 |
| **B-93** | fixed, focused-verified | `team_task_create` 创建 edit 卡时返回 `worktreeBindingWarning`，明确“无 owner 时尚未绑定，重新指派时绑定成员 worktree”。`reassign` 到 tier-2 成员时按成员组/名称计算确定性的成员分支与 worktree 路径并自动写入卡面；写入门禁缺绑定时改为具名 `has no active worktree binding for this write`，不再把真因指向普通 scope。 |
| **B-94** | fixed, focused-verified | `write-scope-guard.mjs` 的 shell 命令分段现在把换行视为分隔符，`Remove-Item ...` 后的独立 `Write-Output` 不再被拼成路径；PowerShell 输出 cmdlet 名从静态写入目标中排除。原始反例“拒绝串具名不存在的 `.../Write-Output`”已由新测试覆盖。 |
| **B-84 重评级** | no platform change | tier 0 已确认产品侧 citation guard 改为按受跟踪内容取域，B-84 的“提交面自身必红”不再成立，不再按平台缺陷继续修复。 |

### 第九轮验证

- 新测试 `phase11-tests/platform-defects-ninth-pass.test.mjs`：3/3 通过。
- focused 组合：83 tests / 83 pass / 0 fail。
- 全量 phase1-phase11 串行：356 tests / 355 pass / 0 fail / 1 skipped；日志：`D:\dsh-test\output\platform-defects-b92-b94-full-serial-20260928.log`。
- 四份 profile 的 3 个目标文件 `node --check`：12/12 通过。
- 四份 profile 目标文件哈希一致：

| 文件 | SHA256 |
|---|---|
| `team-milestone-v2.mjs` | `882AC6EE37CCBD39D6475830FB380C6E648E337B0042F1BD40383100485CB997` |
| `team-tools-v2-r10.mjs` | `21CDA0A4F04A98B2A0D14B99A3A33F821722E3F6897B8A7F826B78927BC6F3D6` |
| `write-scope-guard.mjs` | `2F3BB94ABE26CEB8562592D916C39F8A36746DEB86FB6B9F5D7D370AAD60120D` |

### 第九轮未闭合

- B-92 的两分钟窗口是操作性防线，不是密码学绑定；超窗后仍可改写证明，因此调用方仍应检查回执中的 `doneWhenSetAt` / `doneWhenEditedMsBeforeDone`。
- B-93 在创建时 owner 未知，采用“明确警告 + 重新指派自动绑定”；若流程绕过 `reassign`，仍需通过 `team_worktree_setup` 建立绑定。
- B-94 的静态解析仍无法识别所有不透明子进程自行写盘；反向盲区保留，不宣称完整 OS 级 sandbox。
- B-92 .. B-94 当前为 focused fixture 与串行回归验证，未在 live root Room / live G-WORLD 上逐条重放原始反例；不得据此写成全部 live 原始反例转绿。

## 第十轮修复（2026-09-28 · B-95 .. B-98 / B-85 live 补充）

- 输入指纹：size `197239`，SHA256 `4EF6BA93C01C34AF8FE72FADBCBA810387EE9E4A1B8FCA9280EAA1B644B1F87D`。
- 备份：`D:\dsh-test\backups\platform-defects-b95-b98-20260928-1105`，包含 web/headless/desktop/teamtest 四份五个目标文件。
- 不重启 DSH、不中断 active Team、不改产品仓文件。web PID `101020`，`127.0.0.1:40123` 保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-95** | fixed, focused-verified | `reassignActiveOwnerVerdict` 允许 `ready:false` 的依赖阻塞卡改派；控制面与 policy 在改派后保持 `pending`，不再把 owner 活跃误判为不可改派。 |
| **B-96** | fixed, focused-verified | `write-scope-guard` 增加受限外部取证目录：仅 tier 0/1 可使用 `DSH_EVIDENCE_TEMP_ROOT` 或 `dirname(DSH_HOME)/tmp`，产品路径仍拒绝。 |
| **B-97** | fixed, focused-verified | `detectScopeConflicts` 跳过顶层 `status:"deleted"` 卡；删除的败方卡不再继续占用 write scope。 |
| **B-98** | fixed, focused-verified | 对 `status:"deleted"` 执行 `release` 直接拒绝，不把 tombstone 复活成 `pending`。 |
| **B-85 live 补充** | fixed, focused-verified | `planApprovalVerdict` 拒绝仓库根治理文件 scope（如 `.gitattributes`），同时保留 `docs/groups/<group>` 合法范围。 |

### 第十轮验证

- 新测试 `phase11-tests/platform-defects-tenth-pass.test.mjs`：5/5 通过。
- 四 profile 五个文件 `node --check`：20/20 通过。
- 全量 phase1-phase11 串行：`361 tests / 360 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b95-b98-full-serial-20260928.log`。

## 第十一轮修复（2026-09-28 · B-99 .. B-103）

- 输入指纹：size `218859`，SHA256 `4C8AB7C79ED950BB58A98A030639CC2CAF9AC92955FFF112496A302D020587B0`，mtime `2026-09-28T03:15:52Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b99-b102-20260928-1130`；B-103 收口前 headless 版本另存为同目录 `headless\team-v12-room-wake.before-b103.mjs`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。web PID `101020`，`127.0.0.1:40123` 保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-99** | fixed, focused-verified | `team-v14-context-delivery.mjs` 新增显式 tier→role 文件映射和 `identityRoleFile()`；未知 tier 或 manifest 映射冲突均抛错，不再静默降级为 `member.md`。 |
| **B-100** | fixed, focused-verified | `team-v12-runtime.mjs` 新增 `selectTaskOccurrence()`：优先真实 group/level 卡，避免先命中 global 投影；`team_v12` 等待动作接受并解析 `board` / `input.board`，拒绝串具名 `taskBoard`、caller、owner。 |
| **B-101** | fixed, focused-verified | `send_message(delivery:"info")` 的回执状态改由真实直投结果决定：成功为 `delivered`，失败/待投为 `queued`，不再因目标是上级就硬编码 `room-summary`。 |
| **B-102** | fixed, focused-verified | `verifier_report` 新增非阻塞 `condition` severity；`clearanceGate` 明确允许 condition 清关，blocker/major 仍阻塞。 |
| **B-103** | fixed, focused-verified | `inbox_id` 路径可独立确认 `wakeIds:[]` 的已投递消息；`message-not-delivered` 回执同时给出顶层 `status` 与 detail，缺失消息返回 `inbox-not-found`，区分不存在与前置未满足。 |

### 第十一轮验证

- 新测试 `phase11-tests/platform-defects-eleventh-pass.test.mjs`：5/5 通过。
- 全量 phase1-phase11 串行：`366 tests / 365 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b99-b103-full-phase1-phase11-serial-20260928.log`。
- 四 profile 九个目标文件 `node --check`：36/36 通过；profile 哈希一致性：9/9。
- 四份 profile 目标文件哈希一致：

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `F0900ED7B859C2F222594F53B17A977CD590A108E67EFA7A85C9D5021F54923B` |
| `team-control-plane.mjs` | `D341473397BEC4E1FEB36B7733894830DD2D1892EE570E03BF71F5C87EA7FAF6` |
| `team-policy.mjs` | `3FB5BCD431AC6CB7ACAA0B8FAB30E3CC876CBA15F62B11367296BAD7C78F6199` |
| `team-v12-contract.mjs` | `A8537BDCE1C2CC662B570D14E6A009B107003E67E4E3732BBEB3C62C9BB122D9` |
| `write-scope-guard.mjs` | `E6BFC0F9030DBCE164503E366DB8CF65D3E21312FCE655553757A076AA72CF06` |
| `team-v14-context-delivery.mjs` | `126349A7890BEFAB10A31FC568FD0BA1BA741F7EB5CA0373EE0D07E2BE6A9A0B` |
| `team-v12-runtime.mjs` | `A6F5C0F68BE3AE2A68E9AE8CF96E2D331A2AC6FD9344108526ED743CC5E70EA5` |
| `team-worktree.mjs` | `B1BA11363CB65A835BB153E7F4A2FAE2433C9641E394C24E6BDDA1D209FAB605` |
| `team-v12-room-wake.mjs` | `B3C33E51973223CE537B0D00018220C4CC6DB6F9BAF0C310536960A820FD5F47` |

### 第十一轮未闭合

- B-99 .. B-103 当前为 focused fixture 与全量串行回归验证，未逐条在 live root Room / live G-WORLD 上重放原始反例；不得据此写成全部 live 原始反例转绿。
- B-100 的 board 参数支持 exact id 与 `group` / `level` 别名；其他自定义别名仍应传 exact board id。
- B-101 的 `queued` 表示未完成直投且 durable dispatch 已记录，不表示接收方已经读到。
- B-102 的 `condition` 是非阻塞条件，仍会在报告中可见；调用方不得把它当作已验证通过。

## 第十二轮修复（2026-09-28 · B-104 .. B-107）

- 输入指纹：size `230550`，SHA256 `7435FC7FE0554F42E849C1F2ED434141BF7316590D7595D35133E027AFC62DE1`，mtime `2026-09-28T03:39:44.7879299Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b104-b106-20260928-114343`，包含 web/headless/desktop/teamtest 四份 `team-tools-v2-r10.mjs`、`team-control-plane.mjs`、`team-v12-runtime.mjs`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。web PID `101020`，`127.0.0.1:40123` 保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-104** | fixed, focused-verified | `team_task_update` 新增 `goal` / `deliverable` 显式参数，并统一拒绝未声明的顶层字段（`task-update-unknown-fields`）。控制面 `applyTaskEdit` 同样对未知 edit 字段 fail-closed，不再出现 `ok:true + revision+1 + 内容未落库`。 |
| **B-105** | fixed, focused-verified | edit 现在统一同步任务行与 `contract.goal` / `contract.deliverable` / `contract.writeScopes` / `contractRevision`；`contractDigest` 改用共享 `contractDigest()`，`updatedAt` 成为持久字段；`projectTask` 按指定 board 读取并投影 `subject` / `description` / `contract` / `contractDigest` / `lifecycle` / `updatedAt`，固定 revision 的读投影不再依赖先命中哪块板。 |
| **B-106** | fixed, focused-verified | durable `pendingMessages` 现投影进 `inbox_list`（`source:"dispatch-pending"`、`dispatchId`、原始文本）；接收方可用 `inbox_id` 直接 ack，并在最后一条 pending 被处理时把活动 dispatch 收口为 `completed`。重试会发送原始载荷而非占位文本；重试耗尽后 dispatch 进入 `timed-out`，pending 消息标记 `delivery-failed`，仍可在 inbox 中看见。 |
| **B-107** | fixed, focused-verified | `team_merge` 仅在 destination 为 `main` 时推进到 `integrated`；member→group 分支合并停留在 `integration-ready`，避免组分支合并被看板误报为已进入 main。 |

### 第十二轮验证

- 新测试 `phase11-tests/platform-defects-twelfth-pass.test.mjs`：5/5 通过。
- focused 组合（第十一轮 + 第十二轮 + profile parity）：11/11 通过。
- 全量 phase1-phase11 串行：`371 tests / 370 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b104-b107-full-phase1-phase11-serial-20260928.log`。
- 四 profile 三个目标文件 `node --check`：12/12 通过；profile 哈希一致性：3/3。
- 四份 profile 目标文件哈希一致：

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `50817C68FE549056F95B604922DB248D27B3059249DD50B5E0B52847D3005396` |
| `team-control-plane.mjs` | `60A98E5ADDF659769AD4AF479652F6FC92E52B2D7417BCF9F673BEBD0CE0C83D` |
| `team-v12-runtime.mjs` | `C03498CD0412201561C766C54613713D89B62904EE7C7E16A7AC83158A6FB633` |

### 第十二轮未闭合

- B-104 .. B-107 当前为 focused fixture 与全量串行回归验证，未逐条在 live root Room / live Team 上重放原始反例；不得据此写成全部 live 原始反例转绿。
- B-105 修复的是平台读投影的确定性；历史记录中已经按追加式日志保存的旧值不会被改写。
- B-106 的 pending inbox 投影用于恢复既有 stranded dispatch；接收方仍应优先处理最新消息，并按 `inbox_id` 显式 ack。
- B-107 只调整相位语义；是否确已在 main 上仍必须以 `git merge-base --is-ancestor <commit> main` 为准。

## 第十三轮修复（2026-09-28 · B-108 .. B-109）

- 输入指纹（最终重读）：size `245113`，SHA256 `C4294E3178DB093A261C140D1006280670E25DEF8D5B5980EC5A927B2B79ECEA`，mtime `2026-09-28T05:28:26.4014238Z`。该文件在修复期间新增了 B-108 分层更正，已纳入本轮实现与验证。
- 备份：`D:\dsh-test\backups\platform-defects-b108-b109-20260928-131731`，包含 web/headless/desktop/teamtest 四份 `team-v12-runtime.mjs`、`team-v12-room-wake.mjs`、`team-v14-waiting.mjs`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。web PID `101020`，`127.0.0.1:40123` 保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-108** | fixed, focused-verified | `inbox_ack(inbox_id)` 现在在同一次 mutation 中同时退休 durable inbox 行和 dispatch `pendingMessages`，并在最后一条 pending 被消费时同步收口 dispatch/wake episode。ack 回执新增 `cleared` / `pendingRetired` / `durableHandled` / `dispatchStatus`，不再出现“报 handled 但行仍存在”。`dispatch-pending` 的 queued/delivery-failed 行具备显式消费路径，不再被 `message-not-delivered` 永久卡死；wake 全部消息 handled 时同步清除 `redeliveryRequired`，避免 episode 层永久 `queued`；跨成员 ack 继续 fail-closed。 |
| **B-109** | fixed, focused-verified | `providerWaitingActive()` 只在 `provider.status=blocked` 且存在真实 `lastFailure` 时成立；health 因无关原因 disabled 不再派生 `waiting-provider`。真实 provider 派生行携带 `derivedFrom`、`providerStatus`、`providerLastFailure`、`healthStatus`，便于判别来源。`waiting_resolve` 对可见 derived 行且无匹配显式票时返回 `derived-ticket-not-resolvable`，不再静默命中旧的已 resolved 票。 |

### 第十三轮验证

- 新测试 `phase11-tests/platform-defects-thirteenth-pass.test.mjs`：7/7 通过。
- 相关既有回归（waiting / continuation / runtime bridge / bounded wake / scheduler / 第十二轮）：63/63 通过。
- 全量 phase1-phase11 串行：`378 tests / 377 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b108-b109-full-phase1-phase11-serial-20260928-v2.log`。
- 四 profile 三个目标文件 `node --check`：12/12 通过；profile 哈希一致性：3/3。
- 四份 profile 目标文件哈希一致：

| 文件 | SHA256 |
|---|---|
| `team-v12-runtime.mjs` | `F0AC6737E1388BF8729E6489B36EABCDFC2A68411A71A294778F9897D87E834D` |
| `team-v12-room-wake.mjs` | `63D58A390CDA6D3A3E2B50F15F4C9FE81A3C1B9DECAD92E23F24F23A30CBD9D4` |
| `team-v14-waiting.mjs` | `56F4A1ADBDC26CA61FBE9C471D8D8C63012E41666CE9C7E764FBFDEDB4B8D13C` |

### 第十三轮未闭合

- B-108 / B-109 当前为 focused fixture 与全量串行回归验证；尚未在 live root Room 上逐条重放原始反例，不得写成 live 原始反例全部转绿。
- B-108 的显式 ack 表示消费者确认“已处理”，因此允许清除 queued/delivery-failed 投影；调用方仍应先读 `originalText`，不得盲 ack。
- B-109 的 derived 行仍不会由 `waiting_resolve` 直接关闭；它只应在真实条件变化后消失。显式票仍按 `ticket_id` 精确收口。

## 第十四轮修复（2026-09-28 · B-110 补充 / B-116 .. B-118）

- 输入指纹：size `272426`，SHA256 `CA28D89C439C3C6C66AC30C67CFB812E976B6EA42C899A07CA93680DC8A0BBD2`，mtime `2026-09-28T07:12:50.0256688Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b110-b118-20260928-151724`，包含 web/headless/desktop 目标文件、测试文件、台账与旧 watch state。
- 不重启 DSH、不中断 active Team、不改产品仓文件。运行中的 web 进程未重启；web/desktop 为同一文件身份，headless 已同步，teamtest 通过 junction 跟随 web。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-100 补一** | already verified | 第十一轮已实现 board 解析与 shape/scope 拒绝分类；第十一轮 focused 已覆盖 group/level/global 与错误文本。本轮未另改代码。 |
| **B-110 补充** | fixed, focused-verified | `mergeExact` 保留兼容字段 `previous`，同时明确返回 `previousMeaning:"destination-head-before-merge"`、`destinationBefore`、`sourceHead` 与 `mergeBase`；`team_merge` 输出 schema 与 v12 merge operation 同步持久化这些字段。调用方不再需要猜 `previous` 指向目的分支还是源分支。 |
| **B-116** | fixed, focused-verified | `verifier_report` 支持 `cleared_commits` / `clearedCommits`，同一报告为每个 commit 建立同 digest 的清关记录；门禁按被合并 commit 的集合成员读取。接口面与清关文件均已覆盖。 |
| **B-116 补一** | no platform change | 预登记 tree 值确实只对“当时的目的分支快照”有效；平台不应把它当作跨目的分支推进的耐久承诺。耐久判据保持为相对钉住 base 的 `diff --name-status` 路径集与精确 commit 清关，属于调用方清关纪律，不改门禁。 |
| **B-117** | fixed, focused-verified | `evidence_query` 现在把 `taskId` / `commitSha` 等过滤器投影为一等 `queryKey`，并显式返回 `queryFormed` 与 `queryStatus: formed|not-formed|rejected`；顶层 `task_id` 也会归一化进查询输入，避免“过滤器未形成却返回空集”被读成“无数据”。 |
| **B-118** | fixed, focused-verified | 新增纯输入分类 `evidenceIdInputForm()`；`queryKey.form` 只描述调用方传入串，服务端解析结果单独放在 `idResolution.resolvedForm`。同一完整 id 在不同可见域中不会再因 `form` 漂移而被误归因。 |
| **B-113** | no platform change | 引用完整性缺陷位于 RustMc 产品仓的 citation guard 扫描域；平台层无权修改产品仓，保留已登记的消费者纪律与残余风险。 |

### 第十四轮验证

- 新测试 `phase11-tests/platform-defects-fourteenth-pass.test.mjs`：8/8 通过，覆盖 B-110 补充、B-116、B-117、B-118 及本轮前已落的 B-112/B-114/B-115。
- 全量 phase1-phase11：`386 tests / 385 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b110-b118-full-phase1-phase11-20260928.log`。
- 四 profile 五个目标文件 `node --check`：20/20 通过；profile 哈希一致性：5/5。
- 目标文件哈希：

| 文件 | SHA256 |
|---|---|
| `team-worktree.mjs` | `1F099DF13ABCFA67454824BC918D739C354A23885DAAA3A37E44E3E070394508` |
| `team-tools-v2-r10.mjs` | `8D530DA78E45EBFDF5F36226FF656532662AD23E2C3830D7CE11B06F509FD1A1` |
| `team-v12-runtime.mjs` | `6F965FD5155C7C7B3C0EDA68BB331A4A0DB174A7739376408A6B8D178BA3960B` |
| `team-v12-evidence-scheduler.mjs` | `867B51BC64A7D402A8751E074C959465C1EE53E533F1E16886E21481F690C663` |
| `team-v12-room-wake.mjs` | `00DD21618FBDBF5A19E1CC6CB4FFB2AFAA7E1B15713254637FDD2048083AA477` |

### 第十四轮未闭合

- B-110 补充、B-116、B-117、B-118 当前为 focused fixture 与全量串行回归验证；尚未在 live merge / live evidence_query 上重放原始反例，不得写成 live 原始反例全部转绿。
- B-111 的宿主 `tool-fs` 修改需 DSH 重启后才会进入真实进程；本轮遵守不重启约束。
- B-116 补一不改平台代码；预登记 tree 必须随目的分支变化重新验证，不能作为跨快照承诺。

## 第十五轮修复（2026-09-28 · B-119 .. B-123）

- 输入指纹（最终重读）：size `291334`，SHA256 `C7D631B1E54B437866EDF006FC7D8F1746FAD6A43DCA6D526D080CDC5C267B38`，mtime `2026-09-28T07:56:15.1713062Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b119-b123-20260928-160040`，包含 web/headless/desktop 目标文件、测试文件、旧台账与旧 watch state。
- 不重启 DSH、不中断 active Team、不改产品仓文件。headless 已同步；desktop 与 web 为同一文件身份，teamtest 通过 junction 跟随 web。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-110 补二** | live-confirmed | 现有 `mergeExact` 行为正确：目的 head 是源 head 祖先时真快进，否则创建两父合并提交；`fastForwarded` / `createdCommit` 已是权威字段。第十四轮新增的 `previousMeaning`、`destinationBefore`、`sourceHead`、`mergeBase` 已在 live 回执中填充。本轮无需另改代码。 |
| **B-116 补一第二/第三/第四实例及一般形态** | no platform change | 合并结果 tree 是 `(destination, source)` 的函数，只能在目的分支钉住时作为前置断言；批次级耐久授权保持为相对钉住 base 的路径集与精确 commit 清关。第四实例再次证明清关发布后目的地可能被任意提交推进，调用方必须在每次并入前重新钉住目的地并重算预测；现有 `mergeExact` 已按实时 destination head 判定快进或两父并提交。 |
| **B-119** | fixed, focused-verified | `worktreeAdd` 的 `worktree-refresh-dirty` 回执新增 `behind`、`dirtyCount`、`dirtyFiles`、`nextStep`，并在外层错误路径保留这些字段；`team_run_lease acquire` 的 `worktree-sync-failed` 现在具名 `behind`、`dirty` 与 `nextStep=git merge main`。 |
| **B-120** | no platform change | 未受跟踪且会漂移的输入，其摘要只能作为同一运行内的时点读数；平台不提供跨时刻稳定的内容身份。消费者必须同次读取输入摘要与输出，且不得写入 commit 绑定清关。 |
| **B-121** | fixed, partial | `shellWriteTargets` 现已把 `--gen-fixtures` 与 `--emit-fixture-manifest` 识别为写目标开关，显式指向仓内的路径会进入 scope 门禁。无参数命令自行写默认路径仍无法由通用命令解析器可靠推断，保留为残余风险与消费者纪律。 |
| **B-122** | fixed, focused-verified | 结构化等待条件现在是权威判据；任务 revision 因相位推进等无关变化时不再自动关闭 `dependency` / `room` / `lease` 等票。旧式无结构化条件的票仍保留 revision 弱失效语义。条件真正满足后才由 `waitingTicketActive` 判为关闭。 |
| **B-123** | fixed, focused-verified | 新增 `reportClearanceVerdict`：issue 表含 blocker/major 时不再把 `commit` 或 `cleared_commits` 写入清关集合，也不对外回显已清关 commit；condition/minor/nit 仍可按集合清关。既有 r1 条目的作废继续由 r2/r3 取代与台账裁定处理，不改写历史报告。 |
| **B-123 补一** | no platform change | 历史 `clearedCommits` 条目不由平台就地改写；报告只追加与台账具名作废是正确路径。严重度门禁仍独立兜底。 |

### 第十五轮验证

- `phase11-tests/platform-defects-fourteenth-pass.test.mjs`：12/12 通过，新增覆盖 B-119、B-121、B-122、B-123。
- 全量 phase1-phase11：`390 tests / 389 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b119-b123-full-phase1-phase11-20260928.log`。
- 四 profile 四个目标文件 `node --check`：16/16 通过；profile 哈希一致性：4/4。
- 目标文件哈希：

| 文件 | SHA256 |
|---|---|
| `team-worktree.mjs` | `088FAB25F49685D1C79D94F91C75C1009A6819D4F7C096734A6ADF2CC4EAA4D3` |
| `team-tools-v2-r10.mjs` | `3D8EEB1F548A740BF6375847E90ADFB267EC9BFA37A7A9B4D6204DA7B66E0E47` |
| `write-scope-guard.mjs` | `0795ED01E1CF1AE5FD9F7DDC6F860AC6E905BD5C28BCD15FC7567A00C6F65C2A` |
| `team-v14-waiting.mjs` | `0AC4562D9D58422F4F26EC11DD10DB291CB8514ED4790011A8E5CD3BC9945BB9` |

### 第十五轮未闭合

- B-119、B-121、B-122、B-123 当前为 focused fixture 与全量串行回归验证；尚未在 live `team_run_lease` / `verifier_report` / waiting phase transition 上重放原始反例。
- B-121 仅关闭显式输出开关的漏认；任意无参数程序写默认路径仍不能由通用解析器可靠判定。
- B-111 的宿主 `tool-fs` 修改仍需后续重启 DSH 才会进入真实进程。

## 第十六轮修复（2026-09-28 · B-124 .. B-129）

- 输入指纹：size `307980`，SHA256 `F9340A63C902F9CA1A7A9B0931534BE79F923BBC1FA5C279448DB80B883155E6`，mtime `2026-09-28T09:50:23.8003652Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b124-b129-20260928-180316`，包含 web/headless/desktop 三份 profile 目标文件、focused 测试、台账、watch state，以及三份宿主 `dsh-ptc-runtime-node/lib/process.js` 与 `dsh-tools/lib/types/ptc.js`。
- 不重启 DSH、不中断 active Team、不改产品仓文件。teamtest 通过 junction 跟随 web。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-124** | fixed, focused-verified | `team_task_update(action:"reopen")` 现在要求 `reopen_reason`（`reason` 为别名），并把理由写入卡面 `lastReopenReason` / `lastReopenAt`；控制面与 policy 本地板都在同一次 reopen mutation 内更新，owner 回读卡面即可看到返修原因。 |
| **B-125** | no platform change | 该条是 scope 语义纠错：匹配按路径边界前缀，而不是 raw string prefix。现有实现与该模型一致；本轮不弱化或改写 scope 门禁。 |
| **B-126** | fixed, focused-verified | `team_task_create` 新增 `owner` 参数；全局板在创建后立即由同一工具调用完成 reassign，本地板在 `boardCreate` 内直接落 owner，消除返回后的无主窗口。创建即 owner 时状态按 readiness 进入 `in_progress`，edit 卡同时建立成员 worktree binding。 |
| **B-127** | fixed, focused-verified（宿主） | `dsh-ptc-runtime-node` 的完成值在 lossless JSON 校验前递归 sanitize，嵌套 `undefined -> null`，不再因一个缺席可选字段丢弃整个程序输出。该宿主修改需重启 DSH 才进入真实进程。 |
| **B-128** | fixed, focused-verified | 直接 `team_task_update(action:"edit", write_scopes:...)` 现在明确拒绝为 `task-write-scopes-plan-controlled`；控制面与 policy 本地板同样拒绝，错误串给出 `team_plan_propose` / `replace_approved:true` 恢复路径，不再静默忽略或部分应用。 |
| **B-129** | fixed, focused-verified（宿主） | PTC binding 失败结果现在保留 HarnessError 的 `name` / `code`，例如检索超限返回 `code:"SEARCH_RAW_OUTPUT_OVERFLOW"`，调用方不再只能解析散文错误。该宿主修改需重启 DSH 才进入真实进程。 |

### 第十六轮验证

- `phase11-tests/platform-defects-fourteenth-pass.test.mjs`：17/17 通过，新增覆盖 B-124、B-126、B-127、B-128、B-129。
- 全量 phase1-phase11 串行：`395 tests / 394 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b124-b129-full-phase1-phase11-20260928.log`。
- 四 profile 三个目标文件 `node --check`：12/12 通过；宿主两个目标文件 `node --check`：2/2 通过。
- 四 profile 目标文件哈希一致：3/3；三份宿主副本哈希一致：2/2。
- 目标文件哈希：

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `0C9555D9923D60F2A65C9FED17713E8E6C6CA5D866BA2637A9644A6FEFD24E10` |
| `team-control-plane.mjs` | `B3649DC3ADCA19A14B642961C6F1F69DC59887EC0699C896C0945A1D8CE2B9EC` |
| `team-policy.mjs` | `F7294B8AED79C99BA0BD140D01D82D69B84BC6BAEF8C6987DEB3CDF7EC0DFDE7` |
| `dsh-ptc-runtime-node/lib/process.js` | `BB6DBDD94249B73E47CDB2381AF1B094896C5E0FD6C573BE0D1346B0F1880115` |
| `dsh-tools/lib/types/ptc.js` | `F166DD1D013E6C8970520BEBCBFE180164724F717022C40BDDBACFB56DA7CA55` |

### 第十六轮未闭合

- B-124、B-126、B-128 当前为 focused fixture 与全量串行回归验证；尚未在 live root Room / live Team 上逐条重放原始反例，不得写成 live 原始反例全部转绿。
- B-127、B-129 修改的是宿主包；未重启 DSH，因此当前运行中的真实 PTC 子进程仍使用旧实现。
- B-125 无平台代码改动，只保留调用方纪律：scope 必须写到路径分隔符边界。
- B-111 的宿主 `tool-fs` 修改仍需后续重启 DSH 才会进入真实进程。

## 第十七轮修复（2026-09-28 · B-130 .. B-137）

- 输入指纹（最终重读）：size `330090`，SHA256 `162ED6762E3D35235BAA8AFAC27C8B9FB02542F84F048060606BFEFB14933209`，mtime `2026-09-28T10:14:55.2867792Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b130-b133-20260928-181152`，包含 web/headless/desktop 三份 profile 目标文件、focused 测试、台账与 watch state。
- 不重启 DSH、不中断 active Team、不改 RustMc 产品仓。teamtest 通过 junction 跟随 web；最终四份 profile 四个目标文件哈希一致。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-130** | fixed, focused-verified | `team_merge` 新增 `allowed_untracked:string[]`，只放行调用方具名的未跟踪路径；成功回执返回 `ignoredUntracked`，未列出的未跟踪路径和全部 tracked 修改仍阻塞。既有 `ignore_untracked:true` 行为保留。 |
| **B-131** | no platform change | PowerShell `-File` 数组绑定纪律属于检查器/调用方问题；平台不代理解释 PowerShell 参数。保留“枚举域大小 == 实际扫描域大小”与具名根集纪律。 |
| **B-132** | fixed, focused-verified | `team_worktree_setup` 文档明确既有 worktree 是“把 base 合进分支”，从不 reset/rebase；回执新增 `previousHead`、`head`、`parents`、`headKind`、`mergeCommitCreated`、`ignoredUntracked`。重复调用且 base 已是祖先时不会再造合并提交。 |
| **B-133** | fixed, focused-verified | 等待票新增 `closurePolicy`，关闭时写 `closedReason` / `closedAt` / `closedBy`；显式 resolve、任务 terminal、条件满足和去重分别可读。同任务不同 reason/condition 重挂生成不同 ticketId，不覆盖旧票。`waiting_list` 支持 `input {includeClosed:true}` 读取关闭票。 |
| **B-134** | no platform change | 行号仪器偏差属于读取工具与坐标语义问题；承重行号继续以门禁载体行字段或 `tools.read` 1-based 坐标为准。 |
| **B-135** | no platform change | 该判定逃逸位于 RustMc 产品仓 citation guard；遵守不修改产品仓约束。平台侧只保留“跳过判定必须可见”的纪律。 |
| **B-136** | fixed, focused-verified | 第十七轮新增 `waiting_list` 投影时误用了运行时未定义的 `lower`；已改为 `String(...).toLowerCase()`。默认路径与 `includeClosed:true` 均不再触发 `lower is not defined`。 |
| **B-137** | fixed, focused-verified | `team_delivery_check` 的里程碑 verdict 抽为纯函数并回归测试：`ownerMilestoneTaskId == task.id` 才是 `owner-forgot-to-mark-it`；绑定到别的卡时返回 `milestone-unbound`；无有效绑定返回 `work-genuinely-unfinished`。 |

### 第十七轮验证

- `phase11-tests/platform-defects-fourteenth-pass.test.mjs`：22/22 通过，新增覆盖 B-130、B-132、B-133、B-136、B-137。
- 全量 phase1-phase11 串行：`400 tests / 399 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b130-b137-full-phase1-phase11-20260928.log`。
- 四 profile 四个目标文件 `node --check`：16/16 通过；`v14-profile-parity.test.mjs`：1/1 通过。
- 四份 profile 目标文件哈希一致：

| 文件 | SHA256 |
|---|---|
| `team-worktree.mjs` | `975EF1B65034C97D0194C8EBBB45625F10A0B564721C9064AAD7F58BCC2D4DF2` |
| `team-tools-v2-r10.mjs` | `59DE4347999BEE2B3AF39439E51347744A5DDE9B56D74645A33D775A0BFFD14A` |
| `team-v14-waiting.mjs` | `54B0264069EFB2CFEBCDF5324D7D7432B40FA11B0382106B34C9EB46DFE077C0` |
| `team-v12-runtime.mjs` | `519AB546CE3048CF399F5802306BA8DA04BB85FD5275724A5970B980DE230E3B` |

### 第十七轮未闭合

- B-130、B-132、B-133、B-136、B-137 当前为 focused fixture 与全量串行回归验证；尚未在 live merge / worktree setup / waiting_list / delivery_check 上重放原始反例。
- B-131、B-134、B-135 无平台代码修改；相关调用方纪律继续生效。
- B-127、B-129 以及 B-111 的宿主修改仍需后续重启 DSH 才会进入真实进程。

## 第十八轮复核（2026-09-28 · B-134 收口 / B-135 补 / B-138）

- 输入指纹（最终重读）：size `335682`，SHA256 `8AC5B257FCF5B9CE9AA7BFF751471232B1BF2F1766A182BE3C3AAAFEA48A5E44`，mtime `2026-09-28T10:20:53.8562828Z`。
- 本轮未改平台代码，未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session，也未修改 RustMc 产品仓。
- 上一轮 B-130..B-137 的实现与验证结果保持不变；本轮只处理清单新增或收口内容。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-134** | closed, no platform change | 真因已由 verifier 定位为 `docs/GOVERNANCE.md` 中的孤立 CR：PowerShell 读取器把该 CR 当换行，Rust `.lines()` / `tools.read` / 门禁不这样处理，因此 ≥ 下一 LF 行会出现位置性 +1。平台侧继续以门禁载体行字段或 `tools.read` 的 1-based 坐标为承重坐标。 |
| **B-135 补** | no platform change | QUOTED 假阳性实例位于 RustMc 产品仓的 `citation_integrity.rs` 邻近性判定；平台层无权修改产品仓。保留纪律：跳过判定必须由该引注自身的可独立核对属性决定，不得由邻近性决定。 |
| **B-138** | no platform change | `M11-CITE-PATH-EXC-UNREGISTERED` 的 `carrier:path:line|cite-token` 语义属于 RustMc 产品仓 citation guard 的输出契约；平台侧无法从 DSH profile 修改。保留纪律：复现行级读数必须同时钉住被检索文件的 revision，且按 `(carrier, line, token)` 三元组解释。 |

### 第十八轮验证

- 本轮新增条目均为 no platform change；未改动平台目标文件，因此不重复声称上一轮 focused / 全量回归结果。
- 平台目标文件保持第十七轮最终哈希，未因本轮复核发生变化。
- watch state 已更新到本轮最终指纹；DSH root 修复说明将在交付前发送并确认 `accepted=true`。

### 第十八轮未闭合

- B-134 与 B-135 补、B-138 的最终修复责任分别在 RustMc 产品仓或调用方纪律；本轮遵守“不修改 RustMc 产品仓”的边界，只登记机制、坐标口径与复现要求。
- B-127、B-129 以及 B-111 的宿主修改仍需后续重启 DSH 才会进入真实进程。

## 第十九轮修复（2026-09-28 · B-139 / B-133 收口二 / B-136 状态）

- 输入指纹（最终重读）：size `340509`，SHA256 `7BBD626E9CF2CF17AF6C5BEFAF16D1F6BEB2B52B21D836F474FB39AF289190C6`，mtime `2026-09-28T10:23:13.2972298Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b139-b133-20260928-182858`，包含四份 profile 的三个目标文件、focused 测试、台账、watch state 与失败记忆状态。
- 不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。teamtest/desktop 通过现有文件身份跟随 web，headless 已同步；四份 profile 三个目标文件哈希一致。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-139** | fixed, focused-verified | `failure-memory` 拒绝串现在包含 `count/threshold`、精确 `actionFingerprint` 与可执行恢复命令。`team_v12` 新增 `failure_memory_status` 和 `failure_memory_clear`：status 返回 blocked、计数、阈值、失败指纹和最后错误；clear 接受 `action_fingerprint`，或由 `{tool,arguments}` 在当前会话身份下复算指纹，并要求 `reason` 与 `evidence`。清除仍写审计行；结构化失败记忆本身保留。旧 `waiting_list` 失败记忆已通过同一审计路径清除。 |
| **B-133 收口二** | fixed, focused-verified | `waiting_list` 改为显式投影：持久化票按 `active` / `closed` / `stale` 三分区，返回 `storedTotal`、`total`、`returned`、`truncated`、`nextOffset` 与 `projectionComplete`。`ticketId` / `taskId` 可精确读取，`offset` / `limit` 可分页；默认视图仍只返回 active，但不再把持久化的 stale/closed 票伪装成不存在。 |
| **B-136** | status updated, no additional platform change | 当前默认 `waiting_list` 的拒绝来自 B-139 失败记忆；底层 `lower is not defined` 在当前读数中未再复现。清除旧签名后默认路径恢复可用；本轮不据此断言历史异常已被归因。 |
| **B-134 收口 / B-135 补 / B-138** | no platform change | 责任仍分别在 RustMc 产品仓或调用方纪律；本轮只复核边界与最新清单，不修改产品仓。 |

### 第十九轮验证

- focused：`v14-failure-memory.test.mjs` 与 `platform-defects-fourteenth-pass.test.mjs` 合计 `35/35` 通过；新增覆盖 B-139 的拒绝信息、审计清除、精确指纹解析，以及 B-133 收口二的 active/closed/stale 分区、精确读取与分页元数据。
- 全量 phase1-phase11 串行：`404 tests / 403 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b139-b133-full-phase1-phase11-20260928.log`。
- 四 profile 三个目标文件 `node --check`：`12/12` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；四份 profile 目标文件哈希一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收修复说明，RPC 回执 `ok=true` / `accepted=true`。

| 文件 | SHA256 |
|---|---|
| `team-v13-failure-memory.mjs` | `AAF5D4C04A4B3D9C2CD461E6A979D2366A25BE171A21FA8367484D2761CDD8DD` |
| `team-v14-waiting.mjs` | `A376A1C1E3B0F0ED935215C988A77307C9E2DAF823DB7C1791347A1243C14B3D` |
| `team-v12-runtime.mjs` | `3BC97855678F80BC2ADDE06837FD3D92B69204501764D3ED70E1E2B106477812` |

### 第十九轮未闭合

- B-139 与 B-133 收口二目前为 focused fixture 与全量串行回归验证；root 会话已被请求执行默认 `waiting_list` 只读复核，但本轮未等待其 live 回执，不得写成 live 原始反例已转绿。
- B-127、B-129 与 B-111 的宿主修改仍需后续重启 DSH 才会进入真实进程。

## 第二十轮修复（2026-09-28 · B-140 .. B-145）

- 输入指纹（最终重读）：size `359619`，SHA256 `98E2837FD9467A082A1DB04D0663FEF618DE1BDD14E56A0ADF68F5CE1E312A89`，mtime `2026-09-28T12:12:34.1360837Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b140-b145-20260928-201009`，包含四份 profile 的五个目标文件、focused 测试、旧台账与旧 watch state。
- 不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。teamtest 是 web 的 junction；headless 已显式同步；web/desktop/teamtest 通过现有文件身份保持一致。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-140** | fixed, focused-verified | `complete` 与 `reconcile_complete` 的 `evidenceIds` 改为并集，不再用本次提交覆盖旧指针；`bind_fix` 也改为并集，落实“不得用 bind_fix 移除历史证据”的裁定。控制面与 policy 本地板同语义，重复 id 去重且保留首次出现顺序。 |
| **B-141** | fixed, focused-verified | 每条死信新增 `deadLetterKind`，将 `wake:idle:` / `wake:activity:` 分类为 `system-notification`，其余分类为 `peer-message`。`team_control_status` 与 `team_delivery_check` 返回 `peerDeadLetterCount`、`systemDeadLetterCount` 与 `oldestPeerDeadLetterAgeMs`；`team_delivery_check` 只用对等消息死信作为 blocker，系统 idle/activity 过期不再伪装成消息丢失。 |
| **B-142** | fixed, focused-verified | `reassign` 在控制面与 policy 本地板均先清空 `worktreePath`；工具层随后仅在 replacement 需要绑定时重算并写入新 owner 的 member worktree，避免改派后继续指向旧 owner 的工作树。 |
| **B-143** | fixed, focused-verified | 新增 `evidenceQueryFormation`，逐字回显 `requestedKeys` / `acceptedKeys` / `ignoredKeys`。仅部分键生效时 `queryStatus=partial`；只有未生效键时 `queryStatus=rejected`；不再以“首个被接受键”把 `taskId:null` 等静默丢失键伪装成完整 `formed`。 |
| **B-144** | fixed, declared-scope | `evidence_query` 返回 reader、visible authors、registry revision、visible/total 计数和 `evidenceScope`。最新清单的三轴收口被显式声明为 `reader=scope-dependent`、`writer=not-guaranteed`、`time=not-guaranteed`、`mechanism=not-isolated`；完整 id 的 `not-found` 同时携带 `not-visible-in-declared-scope` 与 `re-resolve-before-citing`。本轮不声称已找到或修复投影丢失机制。 |
| **B-145** | no platform change | `git rev-parse <rev>:<path>` 的 stdout 回显与 rc 128 属于 Git/调用方纪律；平台不包装 Git CLI。保留机检纪律：判存在用 `git cat-file -e` 退出码或校验 SHA 形态，不单读 `rev-parse` stdout。 |

### 第二十轮验证

- focused：`platform-defects-fourteenth-pass.test.mjs` `29/29` 通过，新增覆盖 B-140 的 complete/bind_fix 单调性、B-141 分类计数、B-142 改派清空绑定、B-143 partial/rejected、B-144 三轴作用域声明。
- 全量 phase1-phase11 串行：`409 tests / 408 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b140-b145-full-phase1-phase11-20260928-final.log`。
- 四 profile 四个目标文件 `node --check`：`16/16` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；四份 profile 目标文件哈希一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收第二十轮修复说明，RPC 回执 `ok=true` / `accepted=true`；本轮未等待其只读复放完成。

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `7AFD979D3AED4A75DE9DF31729C1DAC989B4FF0263D7327D925DFA53C1B985CD` |
| `team-control-plane.mjs` | `8EBC00174FE6ABA69F298650E278076B8D64FEDA23218B926AEDDFF62AD943C3` |
| `team-policy.mjs` | `A41CAF3FADA7EFBBFFED8B1BD0E8F310D1B5C429E15B0B588029800610EE7109` |
| `team-v12-runtime.mjs` | `25F93EC22A28FC675BA53ADC2EE1DAB1F27391F992EC55C7DC134862334D3FA4` |

### 第二十轮未闭合

- B-140 到 B-144 当前为 focused fixture 与全量串行回归验证；需要 live root 只读复放确认当前运行中的插件是否已加载本轮实现。
- B-144 只声明并暴露三轴不稳定性，不把任何候选判别量写成机制；live 读取者仍必须在使用完整 id 前即时重解析并随引携带内容。
- B-127、B-129 与 B-111 的宿主修改仍需后续重启 DSH 才会进入真实进程。

## 第二十一轮修复（2026-09-28 · B-147、B-148、B-146/B-144 复放）

- 输入指纹（交付前重读）：size `371238`，SHA256 `5ACAB8FA7E0CF12B1DB80E6E790BB8FF20A246F473A6CE0F3A89440D75C7FBC4`，mtime `2026-09-28T12:42:03.0047893Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b147-b148-20260928-204016`，包含四份 profile 的 `team-control-plane.mjs`、`team-health.mjs`、`team-policy.mjs`、focused 测试、旧台账和旧 watch state。
- 不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。teamtest 是 web 的 junction；desktop 的 profile 也指向 web；headless 已显式同步。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-147** | fixed, focused-verified | 控制面 `boardUpdate(action:"reassign")` 在同一 mutation 内关闭同 task、旧 owner 的 open 等待票：写入 `status=resolved`、`resolution=auto:reassigned`、`closedReason=reassigned`、`closedAt`、`closedBy`，有 replacement 时写 `reassignedTo`。新 owner 的票与其他 task 的票保持不变。 |
| **B-148** | fixed, focused-verified | `team-health` 不再把装载时报告永久闭包重播。`mirror()` 在旧报告为 disabled 或超过刷新窗口时重新 `inspectHealth`；新增默认 `30s` 的 `unref()` 周期重算并重新镜像到控制面；周期与初始 mirror 都捕获异常，HMR/dispose 竞态不会把插件异常升级成进程级未捕获异常。focused 测试覆盖“初始红 → 恢复后 agent 事件自愈”“再次漂移 → 定时转红”“文件恢复 → 定时转绿”和刷新期间 `agents.list()` 抛错不崩溃。 |
| **B-146** | not-reproduced, no platform change | revision `67106` 的 `waiting_list(input:{includeClosed:true, taskId:"group-proto-t72"})` 读到 `total=20 / returned=20 / projectionComplete=true`。不据此否认更早 revision 的读数，也不登记为已修。 |
| **B-144** | live-replay recorded, still counterexample | 声明侧已接受：作用域、reader/visibleAuthors、revision、三轴不稳定性和 `re-resolve-before-citing` 均已暴露；但同一 revision 上不同读取者仍分别得到 `resolved` 与 `not-found`，原始反例未消失，不声称行级行为已修。 |
| **B-140 / B-142** | not-replayed | 均需要 `complete` / `reassign` 写动作；拒绝为只读复放伪造活卡写操作，留给下一次真实使用裁定。 |
| **B-145** | no platform change | 继续由调用方使用 `git cat-file -e` 退出码或 SHA 形态校验，不单读 `git rev-parse` stdout。 |

### 第二十一轮验证

- focused：`platform-defects-fourteenth-pass.test.mjs` `31/31` 通过，新增覆盖 B-147 旧 owner 票关闭/新 owner 与无关任务票保留，以及 B-148 stale-disabled 重算、周期自愈和刷新异常隔离。
- 全量 phase1-phase11 串行：`411 tests / 410 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b147-b148-full-phase1-phase11-20260928-v2.log`。
- 四 profile 三个目标文件 `node --check`：`12/12` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；四份 profile 的 B-147/B-148 目标文件哈希一致。

| 文件 | SHA256 |
|---|---|
| `team-control-plane.mjs` | `D73C582463104F4349C26B761158560B24B6E3004D6061F8D432BBD66E892E20` |
| `team-health.mjs` | `5E676A2F0520570C7A0888F89953AE58597973E38881FD42A604287A5B19A441` |
| `team-policy.mjs` | `A41CAF3FADA7EFBBFFED8B1BD0E8F310D1B5C429E15B0B588029800610EE7109` |
| `team-tools-v2-r10.mjs` | `7AFD979D3AED4A75DE9DF31729C1DAC989B4FF0263D7327D925DFA53C1B985CD` |
| `team-v12-runtime.mjs` | `25F93EC22A28FC675BA53ADC2EE1DAB1F27391F992EC55C7DC134862334D3FA4` |

### 第二十一轮未闭合

- B-147 是 focused fixture 验证；本轮没有为了复放而伪造 live `reassign`，需由下一次真实改派确认旧 owner 票不再出现在 `waiting_list`。
- B-148 的本地 fixture 已证明 stale-disabled 可自愈且周期刷新异常不会崩溃；本轮没有重启 DSH。原 `D:\dsh-test` 40123 实例恢复监听后，root 修复说明已发送至 `session-028e6f5b-1716-4c23-a232-af16d853d191`，RPC 回执为 `ok=true` / `accepted=true`。这确认通知已接收，但不把尚未执行的 live 周期自愈写成已转绿。
- 已送达原文：`D:\dsh-test\output\platform-defects-b147-b148-fix-message.txt`。
- B-127、B-129 与 B-111 的宿主修改仍需后续重启 DSH 才会进入真实进程。

## 第二十二轮修复（2026-09-28 · B-149 .. B-152、B-78/B-144 复核）

- 输入指纹（交付前重读）：size `396014`，SHA256 `DFCD8DA8B0CE1060C6B018A2E19A1D99F4FC54C6624144262C98A993A0D3BFB3`，mtime `2026-09-28T13:32:06.1285880Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b149-b150-20260928-212856`，包含 web/headless/teamtest 目标文件、focused 测试、旧台账与旧 watch state。
- 不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。desktop 是 web junction；teamtest 已显式同步；四份 profile 的三个目标文件哈希一致。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-149** | fixed, focused-verified | `taskViewFields()` 只保留任务输出 schema 已声明字段，旧 `approved` 不再让整块组板因 `additionalProperties:false` 校验失败；旧行在缺少 lifecycle 时仍按 `approved=true` 投影为 `lifecycle:"ready"`。写入侧新建 discussion 卡不再生成非法 `approved`，并显式删除旧字段。 |
| **B-150** | fixed, focused-verified | `reassign` 在同一控制面 mutation 中把 replacement owner 加入已批准计划的 `members` 并递增 plan revision；plan 读取允许 owner、计划成员和正常授权角色。lease/plan 恢复顺序统一为：完成并记录 commit/evidence → 活跃 lease 下 complete → release → replace plan → acquire。 |
| **B-151** | fixed, focused-verified | `taskContractReadResult()` 对 `discussion` / `review` 允许空 `writeScopes`，并从任务 status/phase 同步 lifecycle；已完成 discussion 卡不再显示 `lifecycle:"running"` 或 `scope-required`。 |
| **B-152** | fixed, focused-verified | 任务验收 requirement 只对 owner、对应组长、具备 board 读取权的 verifier 和 tier 0 可见；无关组 tier 2 不再收到不可执行的跨组验收上下文。 |
| **B-78 同族实例** | no additional platform change, not live-replayed | 现有 `write-scope-guard` 已对 tier-2 要求自有 worktree binding，并覆盖 shell 写目标；本轮未为复放制造共享检出写入，也不把新实例写成已 live 转绿。该实例继续作为纪律与审计记录保留。 |
| **B-144 追加实例** | declaration accepted, counterexample remains | 作用域声明与 `re-resolve-before-citing` 继续有效；新增实例不改变“原始跨读取者反例未修”的状态，本轮不声称行级行为已修。 |
| **相位序记录** | no platform change | 代码 `TASK_PHASES` / `PHASE_TRANSITIONS` 与清单口径一致：`execution → member-check → group-check → verifier-review → integration-ready → integrated → accepted`；merge 在 `integration-ready` 前拒绝。 |

### 第二十二轮验证

- focused：`platform-defects-fourteenth-pass.test.mjs` `35/35` 通过，新增覆盖 B-149 的旧字段过滤、B-150 的改派计划成员同步、B-151 的只读契约空 scope/lifecycle、B-152 的跨组 requirement 隔离。
- 全量 phase1-phase11 串行：`415 tests / 414 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b149-b152-full-phase1-phase11-20260928.log`。
- 四 profile 三个目标文件 `node --check`：`12/12` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；四份 profile 目标文件哈希一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收第二十二轮修复说明，RPC 回执 `ok=true` / `accepted=true`。

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `3E4B0C7788650F35F3620E611577AEDFF615BB133B64DAE78DE71C8CC2A6E50F` |
| `team-control-plane.mjs` | `455BBC530896A97EF437C9C69664DA0B1FC152C7BFB691015B326929EDDA4022` |
| `team-v12-runtime.mjs` | `0DAA44D33187512E624E220DD3B43F7F481D2E6A1F8656DBA2C898A0EDDAEAFE` |

### 第二十二轮未闭合

- B-149 到 B-152 当前为 focused fixture 与全量串行回归验证；未重启 DSH，因此不把当前运行中的插件写成已 live 重放。
- B-78 同族实例、B-144 追加实例均为审计与纪律复核，没有新增平台修改。
- B-127、B-129 与 B-111 的宿主修改仍需后续重启 DSH 才会进入真实进程。

## 第二十三轮修复（2026-09-28 · B-149/B-151 残留、计划替换相位、精确合并绑定）

- 输入指纹（交付前重读）：size `427488`，SHA256 `075F0F1942BFB7EE026A51949B14582D3DC45942D7EF9CE3C61AF2060581DF83`，mtime `2026-09-28T14:41:46.5645737Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b153-b155-20260928-225500`，包含 web/headless/teamtest 目标文件、focused 测试、旧台账与旧 watch state。
- 不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。teamtest 通过既有文件身份跟随 web；desktop 是 web junction；headless 已显式同步。

| 事项 | 状态 | 实现与验证 |
|---|---|---|
| **B-149 / B-151 残留** | fixed in control-plane load path | 新增 `normalizeStoredTask()`：控制面载入任务行时删除遗留 `approved`，并按 status/phase 重算 `lifecycle`，同步嵌套 contract.lifecycle。这样平台内存储消费者不再读取到非法字段或已完成卡仍为 running 的陈旧值；原始 JSON 文件只会在下一次正常 mutation 持久化清理，未直接改写 live session 数据。 |
| **计划替换回退相位** | fixed, focused-verified | 新增 `planProposePhaseVerdict()` / `planApprovePhaseVerdict()`。`replace_approved:true` 只替换 plan 记录，不再把已完成/verifier-review 等任务回退到 plan-proposed；后续 approve 对已超过 plan-approved 的相位保持不动。 |
| **成员分支并入组分支夹带 tip** | fixed, focused-verified | 新增 `memberMergeSourceVerdict()`：member -> group merge 必须让 source head 等于该 task 的 `commitSha`；缺 commit 或分支 tip 已前进时以 `member-merge-task-commit-missing` / `member-merge-source-drift` 拒绝。main merge 继续走精确 commit 的 verifier clearance gate。 |
| **task-terminal / 租约过期责任信号** | no platform change | 票仍由任务状态机自动关闭；过期 lease 与无 open 票不能替代责任人。保留“票是等待载体、不是责任载体”的调用方纪律，未为复放制造 live 状态。 |
| **merge-tree / 合并语境** | no platform change | `team_merge` 已返回 destination/source/merge-base/tree 等可核对字段；新增的合并语境门禁仍由落地流程在合并结果上取读数，平台不替产品仓选择构建命令。 |
| **no-plan / PowerShell 参数** | no platform change | `no-plan` 已由 ready_queue 具名；PowerShell `-X`、`^`、`{}`、`$` 参数改写属于调用方解析纪律，平台不代理解释 shell。 |

### 第二十三轮验证

- focused：`platform-defects-fourteenth-pass.test.mjs` `38/38` 通过，新增覆盖遗留任务字段归一化、计划替换相位保持、member -> group 精确 commit 绑定。
- 控制面集成 smoke：临时 control-plane 快照含 `approved=true` / `status=completed` / `lifecycle=running`，经 `controlPlaneFor(...).boardSnapshot()` 读取后为 `approved=false` / `lifecycle=completed` / `contract.lifecycle=completed`。
- 全量 phase1-phase11 串行：`418 tests / 417 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-r23-full-phase1-phase11-20260928.log`。
- 四 profile 两个目标文件 `node --check`：`8/8` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；四份 profile 目标文件哈希一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收第二十三轮修复说明，RPC 回执 `ok=true` / `accepted=true`。

| 文件 | SHA256 |
|---|---|
| `team-control-plane.mjs` | `4D3CFB0A97715DEE5CD6F8E73F5F0E75C555D851AA4FC6016EB4F1A13D458BEE` |
| `team-tools-v2-r10.mjs` | `7404CB1F285C2A1FAB6D59EAA5E2F39A5059FA81C8E730B06C3D22D8301B85F1` |

### 第二十三轮未闭合

- 控制面载入归一化已经修复平台读取面；若外部程序绕过控制面直接解析 session JSON，仍可能看到旧字段，直到下一次正常 mutation 写回。本轮没有直接改写 live session 数据。
- 计划替换和 member -> group merge 的验证为 focused fixture + 全量串行回归；未重启 DSH，不声称当前运行中的插件已完成 live 重放。
- B-127、B-129 与 B-111 的宿主修改仍需后续重启 DSH 才会进入真实进程。

## 第二十四轮修复（2026-09-29 · HMR inactive-context 工具绑定恢复）

- 输入清单指纹（交付前重读）：size `432187`，SHA256 `97826E06E52ED621E27661EA40D79FDD5E7EED28E3251FC049C59BCFEECB7270`，mtime `2026-09-28T16:09:28.8294506Z`。
- 备份：`D:\dsh-test\backups\team-inactive-context-final-20260929-000139`，包含本轮修改前的三份 web profile 文件。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持。

| 事项 | 状态 | 实现与验证 |
|---|---|---|
| **D-1 工具绑定解析失活 `agentTeams`** | fixed, live-confirmed | `team-tools-v2-r10.mjs` 在安装 `team:policy` section 时静态捕获 membership/record，prompt callback 不再访问 live `ctx.agentTeams`；`team-runtime-guard.mjs` 对残留 `team:*` prompt callback 和 prompt assemble 增加失活上下文保护。对 live `tool-agent-team-v2` fiber 做过受控重载，未重启 DSH。 |
| **D-2 控制面 `normalizeStoredTask` 读路径错误** | fixed, live-confirmed | 重载后的 live tool layer 恢复 `team_delivery_check`，`team_wake` / `team_plan_get` / `team_room_read` 不再返回该 ReferenceError。 |
| **D-3 failure-memory 逐工具 latch** | operational recovery, live-confirmed | 清理旧 failure-memory 指纹后，`team_delivery_check` 返回真实读数：`open=6` / `actionable=5` / `noOwner=1` / `dead=0`。恢复期间停止重复探测，避免继续扩大 latch。 |
| **root 会话恢复** | live-confirmed | `session-028e6f5b-1716-4c23-a232-af16d853d191` 在 `turn 251..263` 全部 `turn/end reason=completed`；最后一次 `inactive-context` 错误结束于 `turn 250`。`turn 263` 实际进入模型并回复“收到，修复确认。继续正常工作。”，随后 Team `active 0 -> 2`、`stalled 3 -> 1`。 |
| **临时诊断清理** | completed | 删除 AgentLoop wrapper、prompt probe/stack logging、loader/tool-layer/sanitize diagnostics、manual-root followup 和 reload hack；保留静态 membership 捕获、prompt guard、team-health timer inactive-context guard。 |

### 第二十四轮验证

- 四 profile 三个目标文件 `node --check`：`12/12` 通过。
- focused：`platform-defects-fourteenth-pass.test.mjs` `38/38`；`v14-profile-parity.test.mjs` `1/1`。
- 全量 phase1-phase11 串行：`418 tests / 417 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-inactive-context-final-full-phase1-phase11-20260929.log`。
- 四份 profile 的 `team-tools-v2-r10.mjs` / `team-runtime-guard.mjs` / `team-health.mjs` SHA256 一致。
- 修复说明不是以 `accepted=true` 作为完成证据；以 root 会话 `turn 263` 的真实 `assistant/message` 和随后 Team 恢复读数作为送达证据。

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `5E797881B972CE187A0FC5DF9818D389D1F302FD3148B264CB5754F0796DA965` |
| `team-runtime-guard.mjs` | `F718A2309681B40C075B5C5AB916F7F6C552785737722369E1521E0CB41387AE` |
| `team-health.mjs` | `06C5CF8A8151FE9C5E42A5DE29EB0EC4152058338B8C628776018C5238C81035` |

### 第二十四轮未闭合

- 清单在本轮收尾时新增 D-4 控制面审计缺口、D-5 清关登记校验、D-6 `verifier_report` 覆盖、D-7 detached HEAD 假落地；它们与本次 HMR 修复无关，保留给下一轮缺陷清单 watch 处理，`platform-defects-watch-state.json` 不提前推进到新 hash。
- `team-runtime-guard.mjs` 的 prompt guard 是 HMR 残留 section 的兼容保护；新的 section 安装路径已由静态 membership 捕获消除根因。后续若删除兼容层，应保留一个针对旧 section 的回归测试。

## 第二十五轮修复（2026-09-29 · D-4 .. D-7 批次 8）

- 输入清单指纹（交付前重读）：size `432187`，SHA256 `97826E06E52ED621E27661EA40D79FDD5E7EED28E3251FC049C59BCFEECB7270`，mtime `2026-09-28T16:09:28.8294506Z`。
- 备份：`D:\dsh-test\backups\platform-defects-batch8-20260929-001643`，包含四份 profile 五个目标文件、focused 测试、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **D-4** | fixed, focused-verified | `team-control-plane.mjs` 新增 `readAuditEvents()` / `auditStatusFor()`，所有 mutation 审计行写入实际 `revision`；`team-v12-runtime.mjs` 的 `control_status` 改为读取真实审计尾段，不再无条件传空数组。`team-v12-persistence.mjs` 支持 `trackedFromRevision`，可区分真实缺口和 legacy 未版本化日志。历史无 `revision` 行会明确报 `audit-legacy-unversioned`，不会伪装成空日志，也不自动改写历史。 |
| **D-5** | fixed, focused-verified | `team-tools-v2-r10.mjs` 新增 `clearanceCommitVerdict()`，写入前要求 40 位十六进制，并校验 `git cat-file -t` 为 `commit`、`git rev-parse <sha>^{commit}` 等于原 SHA。非法 commit 在报告/清关写入前整次 fail-closed；合并拒绝信息包含完整 expected commit、找到的 key、report、severity 和 registry keys。 |
| **D-6** | fixed, focused-verified | 新增 `mergeClearanceRecords()`。低严重度记录不能覆盖高严重度正式清关；`verifier_report` 返回 `clearanceUpdated` / `clearanceIgnored`。原始反例 `condition` 被后续 `nit` probe 覆盖已由 focused 测试锁住。 |
| **D-7** | fixed, focused-verified | `team-worktree.mjs` 的 `mergeExact()` 新增 `destinationRef` 检查。目的地为 detached HEAD 时以 `destination-is-detached` 拒绝，分支不符时以 `destination-ref-mismatch` 拒绝；merge 后确认目标 ref 与 HEAD 一致。`team_merge` 回执新增 `destinationRefBefore` / `destinationRefAfter`。 |

### 第二十五轮验证

- focused：`D:\dsh-test\phase11-tests\platform-defects-fourteenth-pass.test.mjs` `43/43` 通过。
- 全量 phase1-phase11 串行：`423 tests / 422 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch8-full-phase1-phase11-20260929.log`。
- 四 profile 五个目标文件 `node --check`：`20/20` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过。
- 四份 profile 的 `team-control-plane.mjs` / `team-tools-v2-r10.mjs` / `team-v12-runtime.mjs` / `team-worktree.mjs` / `team-v12-persistence.mjs` 哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已实际接收修复说明；真实 `assistant/message` 证据为 turn `266` / seq `40116`。其 live `control_status` 读到 `lastAuditRevision=75342`、`trackedFromRevision=74913`、`missingRevisions=[]`、`versionedAuditEvents=433`、`legacyAuditEvents=7759`、`malformedAuditLines=0`，证明 D-4 的“空日志”症状已消失。
- 同一 live 读数暴露了新的残余观测：`code=audit-inconsistent`、`duplicateRevisions=[74942,74943,74944]`。这些不是读取重复，而是同一 revision 下存在不同 mutation 事件；本轮不自动去重，也不把重复行伪装成正常，保留为后续 HMR/并发写入审计问题。

| 文件 | SHA256 |
|---|---|
| `team-control-plane.mjs` | `1A06BE05F23726150DF3F226E71AFCA4B3105FECE77F7A05B371FDAC16160CC3` |
| `team-tools-v2-r10.mjs` | `86205CE223A8C78B9E012D78712D992A9F769F3ED80C7A9C7B209734678681B9` |
| `team-v12-runtime.mjs` | `0DBACB0F223F483430F664D6C971CBD1C4289DF0BF57228BFA472F5E4FDEED7A` |
| `team-worktree.mjs` | `8981D39A9779B590BFB7F46893ECB8B3438C3AFC67665ED3DA9F4A6677D78FAB` |
| `team-v12-persistence.mjs` | `9FCAB57A8EEFFA2E6362193650DDA7D418E4696B78A3BE543F8A7F85987EE92B` |

### 第二十五轮未闭合

- 历史无版本审计行不会自动补写；修复只保证后续 revision 可审计，并让当前状态诚实报告 legacy。
- live 审计仍观察到 `duplicateRevisions=[74942,74943,74944]`；本轮没有自动去重或改写历史，该残余需要独立处理。
- 已存在的错误清关键或已被覆盖的历史正式记录不会自动恢复；修复只阻止后续非法写入和降级覆盖。
- detached HEAD 修复针对后续 `team_merge` 调用，不改变已经发生的错误落地。
- 本轮为 focused fixture 与全量串行回归验证；未重启 DSH，不把当前运行进程写成已 live 重放。

## 第二十六轮修复（2026-09-29 · B-153 .. B-155）

- 输入清单指纹（交付前重读）：size `437382`，SHA256 `2D675BFE6CD81D3C1EC00966BAE42FC4023C4C7F4D853F4F4FBCC769E00C576F`，mtime `2026-09-28T16:27:33.3223261Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b153-b155-20260929-003406`，包含本轮修改前的 web 目标文件、测试、台账与 watch state；headless 同步前的原文件另存于该目录的 `headless-pre-sync-20260929-003820`。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-153** | fixed, focused-verified | `team-worktree.mjs` 的 `worktreeAdd()` 新增显式 `conflictStrategy`：仅当同时提供完整 40 位 `expectedHead` 和 `expectedBase`，且当前 branch/base 与 pin 完全一致时，才允许执行 `base`（`-X theirs`）或 `worktree`（`-X ours`）冲突解决；缺 pin、非法策略、pin 变化均 fail-closed。回执返回 `sourceHeadBefore` / `baseHeadBefore` / `conflictStrategy`。`team_run_lease acquire` 的 `worktree-sync-failed` 现在给出带完整 pin 的 `team_worktree_setup` bounded recovery 参数，打破“acquire 需要 merge，merge 需要 lease”的闭环。 |
| **B-154** | fixed, focused-verified | `mergeExact()` 支持 `allowSourceAncestor`：member -> group merge 允许 source branch tip 前进，但只合并卡面 `commitSha` 对应的精确任务提交，并在合并前后验证该任务提交仍是 source tip 的祖先。`team_merge` 回传 `sourceBranchHead` / `sourceBranchHeadAfter`，且输出 schema 同步声明后两者；无关 tip 仍以 `source-sha-changed` / `member-merge-source-drift` 拒绝，后续未验证提交不会夹带。 |
| **B-155** | fixed, focused-verified | `team-v14-waiting.mjs` 解析 `approval` 条件中的 `requestId` / `request_id` / `objectId`。绑定 request 的等待票只由该 privilege request 的 `approved` / `active` 状态关闭，关闭原因写为 `privilege-approved:<requestId>`；无关 `plan-approved` 不再关闭该票。无 requestId 的旧式票保留原计划批准语义。 |

### 第二十六轮验证

- focused：`D:\dsh-test\phase11-tests\platform-defects-fourteenth-pass.test.mjs` `46/46` 通过；新增覆盖 B-153 的 pin 缺失/变化 fail-closed、B-154 的精确任务提交合并与无关 tip 拒绝、B-155 的 request-bound approval。
- 全量 phase1-phase11 串行：`426 tests / 425 pass / 0 fail / 1 skipped`；最终日志：`D:\dsh-test\output\platform-defects-b153-b155-full-phase1-phase11-20260929-v2.log`（首次日志为 `...-20260929.log`，schema 收口后重跑）。
- 四 profile 四个目标文件 `node --check`：`16/16` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；四份 profile 的 `team-worktree.mjs` / `team-tools-v2-r10.mjs` / `team-v14-waiting.mjs` / `team-v12-runtime.mjs` 哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已实际接收本轮修复说明；真实 `assistant/message` 证据为 turn `269` / seq `40449`。root 独立复核确认四份 profile 同步、工具绑定数不变、全量日志逐值一致；同时指出 `team_merge` 声明面缺少 `sourceBranchHeadAfter`，已在本轮收口前补齐并重跑全量回归。补充说明送达后的独立复核为 turn `270` / seq `40498`，确认四份 `team-tools-v2-r10.mjs` 哈希逐字一致、声明命中数由 `0` 变为 `2`、v2 全量日志数值一致。

| 文件 | SHA256 |
|---|---|
| `team-worktree.mjs` | `5D13F7D58B62FEF4DEA144F46145D112B5F8B5E9060BB1C119BBA8C6961C86CF` |
| `team-tools-v2-r10.mjs` | `7383E0341C0F0E3968B693A1D3884CA382A72657DB5EDEBF439978F36B18AC78` |
| `team-v14-waiting.mjs` | `C50710FBCA3460EA43AC4C6F45CD333832A41EED406B45B8C2839069DD70C303` |

### 第二十六轮未闭合

- B-153 的冲突策略是显式、有界的调用方选择；平台不自动猜测冲突语义，也不允许无 pin 的宽泛合并。
- B-154 只保证不夹带后续未验证提交；同一 owner 的并发卡仍应优先串行排期或分派不同成员，避免其他非 git 层资源争用。
- B-155 只修 request-bound approval 的自动关闭语义；历史已错误关闭的票不会被回写恢复。
- 本轮为 focused fixture 与全量串行回归验证；未重启 DSH，不把当前运行进程写成已 live 重放。
- root 的独立复核指出 live `control_status` 观察到 `duplicateRevisions`（上轮 3 条，后续 10 条）以及 `v14MirrorHealth` 错误文本自相矛盾；这两项不是 B-153..B-155 的修复对象，保留为后续缺陷观察，不在本轮声称已修。
- root 的后续三时点读数更正了“持续增长”判断：`75342 -> 3`、`75750 -> 10`、`75841 -> 10`，表现为间歇爆发而非逐 revision 累积；是否合法仍未有判据。
- root 另测得 `control_status.migration` 约 `21 MB`，会把整个控制面内嵌进结果并造成调用方输出爆炸；这不是 B-153..B-155 的修复对象，保留为后续缺陷观察。
- B-155 当前没有找到 `privilege-approved:<requestId>` 的运行期证人；本轮仅证明代码路径与 focused 回归，不声称 live 重放完成。

## 第二十七轮修复（2026-09-29 · B-156 .. B-163、O-10-4）

- 输入清单指纹（交付前重读）：size `467940`，SHA256 `4CE71A5060E849D2BCC9F765A835AE8ED60D4090AA29B17ECF2C434534BAA2C3`，mtime `2026-09-28T17:16:50.1241777Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b156-b163-20260929-012609`，包含本轮修改前的目标文件、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-156** | fixed, focused-verified | `team-v14-waiting.mjs` 的等待票投影新增 `responsibleStatus` / `responsibleInactive`；`waiting_list` 返回 `responsibleInactive` 计数；`team_delivery_check` 的开放项标出责任人已失活/缺失，不再把“责任人离线”混同为普通未完成。 |
| **B-157** | fixed, focused-verified | `team-control-plane.mjs` 的锁超时文本改为“未取得锁，写入结果未知”，明确要求先查 durable effect 再重试；删除“no mutation was written / retrying is safe”的假阴性断言。 |
| **B-158 / B-163** | fixed, focused-verified | 新增 `taskIntegrationVerdict()`。`team_task_list` 对已完成 edit 卡投影 `integrationState` / `integrationMeaning`：commit 已是 main 祖先时为 `integrated-pending-terminal`，否则为 `completed-not-integrated`。`team_delivery_check` 新增 `completedNotIntegratedCount` / `completedNotIntegrated`，并把未集成交付物作为 blocker；有效的同 Team `delivery-reference` 卡不重复计入，避免参考卡被误判。 |
| **B-159** | fixed, focused-verified | `clearanceDestinationMetadata()` 固化签发时目的地 SHA、source base 与 source path 集合；`clearanceLandingVerdict()` 允许 main 仅发生不相交路径推进时保留清关，拒绝目的地不再是祖先或路径重叠的推进。`team_merge` 在 preflight 与合并锁内各复核一次。 |
| **B-160** | fixed, focused-verified | `task-terminal` 自动收口改写真实原因 `auto:task-terminal` / `closedReason:"task-terminal"`，不再占用 `auto:condition-cleared`；已自动收口的票允许追加真实 resolution，并保留 `autoResolution`。 |
| **B-161** | fixed, focused-verified | `normalizeStoredTask()` 将 discussion 哨兵与非法短 SHA 归一到 `null`，保留 `commitShaRaw` / `commitShaIssue`；`taskCommitShaVerdict()` 对 7–39 位输入要求仓库解析到完整对象，完整 40 位 SHA 直接规范化；member -> group 精确合并拒绝非法卡面 commit。控制面内部旧夹具值保持兼容，但加载时归一化。 |
| **B-162** | fixed, focused-verified | 单条 `inbox_ack` 现在根据 `wakeSettlement()` 回写聚合 wake：未全部处理时为 `partially-handled` 且 `redeliveryRequired:true`，全部处理后转为 `handled` 且 `redeliveryRequired:false`；聚合整体状态不再永久误报重投。 |
| **O-10-4** | fixed, focused-verified | `waitingResolveInputVerdict()` 在 `task_id` 形态为 `wait:` 前缀时直接报 `waiting-ticket-passed-as-task`，同时传 `task_id` 与 `ticket_id` 时报 `waiting-task-and-ticket-ambiguous`，不再降级成误导性的 `task-not-found`。 |
| **B-157 补充 / B-159 第 4–5 例 / B-160 第 3 例 / G-9.x / M-10.x** | covered / no additional platform change | 返回值不可作为 ref 状态判据、清关三元组、移动 ref 时点纪律与 fail-closed guard 已由代码门禁和台账纪律覆盖；无额外产品写入。 |

### 第二十七轮验证

- focused：`D:\dsh-test\phase11-tests\platform-defects-fifteenth-pass.test.mjs` `8/8` 通过，覆盖 B-156..B-163 与 O-10-4。
- 全量 phase1-phase11 串行：`434 tests / 433 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b156-b163-full-phase1-phase11-20260929-v2.log`。
- 四 profile 五个目标文件 `node --check`：`20/20` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 五份目标文件 SHA256 逐项一致。
- DSH root 修复说明已通过 RPC 发送，回执为 `HTTP 200 / ok=true / accepted=true`；session v4 日志在 `seq 41793` / `41794` 出现 `agent/inbox/spliced`，正文与本轮 `platform-defects-b156-b163-fix-message.txt` 一致。交付时 root 仍处于 `turn 275`，尚未产生明确回应该说明的 `assistant/message`；因此不把 RPC 回执冒充 assistant ack。
- 兼容性回归中发现并修正了 B-161 严格校验误伤旧控制面夹具的问题：公共工具层继续 fail-closed，控制面旧行在加载时归一化；同时把两条仍使用非 SHA 占位值的旧夹具改为完整 40 位测试 commit，未放宽公共契约。

| 文件 | SHA256 |
|---|---|
| `team-control-plane.mjs` | `CBF748995DD3FB684A5015C89924E352E0F5BBE74F7E7D620E99138223A1516B` |
| `team-tools-v2-r10.mjs` | `04C3C370142CA64401216FF7F1347593A9386C21DAFA66797BB84510D10076D5` |
| `team-v12-room-wake.mjs` | `40B936B2BF53986FCC3E006983766C79B6A9640DD9539B008949DE08FCAA22EC` |
| `team-v12-runtime.mjs` | `FDBCB0C68FF9EBBD9909B2136EC8290F712F8FEDD2347EDB2D7838BE7683A734` |
| `team-v14-waiting.mjs` | `87D1933CBE4F087716FFB58D3B43A77301E2CF22F0989ED428B96CE78397E0F2` |

### 第二十七轮未闭合

- B-156 的责任人失活标记来自当前成员表快照；若成员表本身延迟刷新，标记会随下一次读取更新。
- B-158/B-163 对“已完成但未集成”的判定依赖 `main` 与卡面 commit 的 Git 祖先关系；无仓库或无法读取 Git 时只报不可验证，不伪造已集成。
- B-159 允许的是路径集合不相交的 main 推进；同一路径上的并发修改仍要求重锚并重新清关。
- B-161 只规范化任务卡面 commit；packet/evidence 的历史 commit 文本仍按原载荷保留，避免破坏既有审计包。
- 本轮未重启 DSH，当前运行进程不包含新加载代码；focused 与全量均为离线验证，live 原始反例尚未逐条重放。

## B-166 / B-170 紧急修复（2026-09-29）

- 来源：root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 的 `turn 276 / seq 42094、42112` 与 `turn 280 / seq 42431`；这两项尚未进入 `PLATFORM-DEFECTS.md`，因为 root 为保住 t50 清关压住了台账提交。
- 备份：`D:\dsh-test\backups\platform-defects-b166-b170-20260929-023646`，包含本轮修改后的 web、同步前 headless、两个 focused 测试与最终消息文件。此前版本可从 `D:\dsh-test\backups\platform-defects-b156-b163-20260929-012609` 恢复。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-166** | fixed, focused-verified | `team-tools-v2-r10.mjs` 新增 `taskCommitShaUpdateVerdict()`，`complete` / `bind_fix` 使用局部规范化值构造 control request，不再写回只读的 `args.commit_sha`；`team-control-plane.mjs` 的 `bind_fix` 同样不再修改 `input.commitSha`。`v14-global-task-completion.test.mjs` 用 `Object.freeze(args)` 加非空 commit 实际调用工具，原先的 TypeError 已转绿。 |
| **B-170** | fixed, focused-verified | `memberMergeSourceVerdict()` 默认拒绝“卡面 `commit_sha` 与源分支 tip 不一致”的 member-to-group merge；只有调用方显式传 `allow_source_ancestor:true` 才允许消费精确任务提交。`team_merge` schema、preflight 和 `mergeExact` 同步透传该 opt-in，默认路径不再静默用陈旧卡面 SHA 落地。`platform-defects-fifteenth-pass.test.mjs` 覆盖隐式拒绝与显式允许两条路径。 |

### 紧急修复验证

- focused：`platform-defects-fifteenth-pass.test.mjs` + `v14-global-task-completion.test.mjs` 合计 `16/16` 通过。
- 全量 phase1-phase11 串行：`436 tests / 435 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b166-b170-full-phase1-phase11-20260929.log`。
- 四 profile 两个目标文件 `node --check`：`8/8` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 两份目标文件 SHA256 一致。
- DSH root 修复说明已发送，RPC 回执为 `HTTP 200 / ok=true / accepted=true`；session v4 日志在 `seq 42678` 出现 `agent/inbox/spliced`，`seq 42685` 出现对应 `user/message`。

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `D0E757D5BE8A4E16CC3B1DD426B73112877597F8DFCF87E0ABFA2281A27E2175` |
| `team-control-plane.mjs` | `5A1FA7C07B1F6B83902770052C007DF95F976E8DDE75B2479DF9DADECC8F6B54` |

### 紧急修复未闭合

- B-170 的显式 opt-in 保留 B-154 的精确提交用例；默认路径改为 fail-closed 后，需要消费“分支 tip 已前进”的调用方必须显式声明，并自行保证卡面任务提交就是目标交付对象。
- B-166 / B-170 已同步到四份 profile，但未重启 DSH；root 侧仍应以 live `team_task_update` / `team_merge` 调用确认当前进程已加载新代码。

## 第二十八轮修复（2026-09-29 · B-167、O-10-8、O-10-9、B-169、B-171、O-10-12；B-168 保留观察）

- 输入清单指纹（交付前重读）：size `523156`，SHA256 `4A2204C4C6B117DF1ADC3B166DBC117F3273EBB5CAC2A2689171A3F138A904F1`，mtime `2026-09-28T18:50:40.8156621Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b167-o10-8-o10-9-20260929-025054`，包含修改前的 web/headless/desktop/teamtest 目标文件、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-167** | fixed, focused-verified | `team_plan_propose` 在落盘前复用 `planScopeConflictVerdict()` 对活动任务执行同一 scope-conflict 判定；冲突时 fail-closed，不再允许争用 scope 以已提交 plan 的形态落地。disjoint scope 与已完成任务不误拦。 |
| **O-10-8** | fixed, focused-verified | `leaseHeartbeat()` 未显式传 `expiresAt` 时，默认续到 `heartbeatAt + DEFAULT_RUN_TIMEOUT_MS`；显式到期值仍保留调用方语义。focused 反例确认 heartbeat 后 `expiresAt` 严格前进。 |
| **O-10-9** | fixed, focused-verified | `inbox_ack` 双向识别 `wake_id` / `inbox_id` 混用：把 inbox id 传给 `wake_id` 时返回 `inbox-id-passed-as-wake`，反向返回 `wake-id-passed-as-inbox`；同时传两者明确拒绝。 |
| **B-169** | fixed, no code change | `VERIFIER_CLEARANCE_POLICY` 说明改为 blocker 与 major 均阻断清关键；现有清关实现已是该语义，本轮只修正说明并加 focused 断言。 |
| **B-171** | fixed, focused-verified | 活动且精确匹配 tool/task/target 的 privilege 仅对 `member-merge-task-commit-missing` 放行；来源必须是完整 40 位 SHA，错误 target 或非法 SHA 仍拒绝，回执新增 `privilegeBypass`。 |
| **O-10-12** | documented, lifecycle-verified | 保留“批准对 requester 的下一次唤醒生效，turn 结束即过期”的既有语义；补齐 `PRIVILEGE_TURN_POLICY` 工具说明和 lifecycle 反例，不扩张为跨 turn 常驻权限。 |
| **B-168** | observed, mechanism-undetermined | 两份报告称 revision 由 11 回退到 6 且 evidence id 不可解析，但第三份更晚读数显示 completed/accepted 且 evidence 可解析。现有证据更像陈旧投影；本轮不做无证据的数据改写，不声称已修。 |

### 第二十八轮验证

- focused：`platform-defects-sixteenth-pass.test.mjs` `6/6` 通过；连同 `platform-defects-fifteenth-pass.test.mjs` 合计 `15/15` 通过。
- 全量 phase1-phase11 串行：`442 tests / 441 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b167-o10-8-o10-9-full-phase1-phase11-20260929.log`。
- 四 profile 三个目标文件 `node --check`：`12/12` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 三份目标文件 SHA256 逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已实际接收本轮修复说明：`agent/inbox/spliced` 为 `seq 43058`，surface `user/message` 为 `seq 43088`，对应 `assistant/message` 为 `turn 285 / seq 43090`。发送客户端在等待长 turn 时超时，但服务端会话日志已证明消息被接纳并进入模型，不把客户端超时误报为未送达。

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs` | `69C331668AD276661579F55A4417625E53E454803248F6B2FDE9D12A499DDD31` |
| `team-control-plane.mjs` | `46BD083045CD746900A3DEC6B49AA74726DC4C718FEC695880388D9AE883C39A` |
| `team-v12-runtime.mjs` | `9DFDB7BBAD5E64815734D10ADFED239328F430CED0C5930BB099C0BF8F7C32E3` |

### 第二十八轮未闭合

- B-168 仍保持“观察成立、机制未定”；不得写成已确认的持久化数据丢失，也不得用 revision 号作版本判据。
- B-169 无平台代码修改；若 live 清关门仍把 major 当作非阻断，应作为新的运行期反例另报。
- O-10-12 没有把 privilege 扩展为跨 turn 常驻；如需该能力，应作为独立策略变更设计。
- 本轮未重启 DSH；四份 profile 已同步，focused 与全量均为离线/隔离验证，不声称 live 原始反例已逐条重放。

## 第二十九轮修复（2026-09-29 · B-172）

- 输入清单指纹（交付前重读）：size `528279`，SHA256 `39DFD41F5DD303C52F5CAC02FF16CA51F0E01BAFCE74D04ED7F50161C46EE475`，mtime `2026-09-28T19:17:58.2123918Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b172-20260929-035056`，包含修改前的四份 profile 目标文件、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-172** | fixed, focused-verified | `team-tools-v2-r10.mjs` 新增 `memberMergeDestinationBase()`：仅当成员 tip 已包含 `main` 且接收分支头已是成员 tip 的祖先时，返回 `undefined`，让 `worktreeAdd` 保持接收分支现状；否则仍以 `main` 刷新目的地，保留原有分叉合并语义。`team_merge` 在成员合并前显式计算 `sourceContainsMain` / `destinationHeadIsAncestor`，不再无条件把 `main` 作为目的地刷新基准，因此不会再把已清关的成员 commit 包装进新的 merge 节点。 |

### 第二十九轮验证

- 原始反例：`phase11-tests/platform-defects-seventeenth-pass.test.mjs` 在隔离临时 Git 仓库中同时复现旧路径与新路径。旧路径 `destinationBase="main"` ⇒ `fastForwarded=false`、`createdCommit=true`、`parents=2`、最终头不等于清关 commit；修复路径 ⇒ `fastForwarded=true`、`createdCommit=false`、`parents=1`、最终头逐字等于清关 commit。该测试 `1/1` 通过。
- focused 组合：`platform-defects-fifteenth-pass.test.mjs` + `platform-defects-sixteenth-pass.test.mjs` + `platform-defects-seventeenth-pass.test.mjs` 合计 `16/16` 通过。
- 全量 phase1-phase11 串行：`443 tests / 442 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b172-full-phase1-phase11-20260929.log`。
- 四 profile `team-tools-v2-r10.mjs` `node --check`：`4/4` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 哈希逐字一致。
- `team-tools-v2-r10.mjs` SHA256：`376331F2604352124DF61A0BD5DEDF89EE3E0646D06080C2E929CC2BFF57713A`。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收 B-172 修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`；session v4 中 `agent/inbox/spliced` 为 `seq 43529`，随后 `turn/start` 为 `turn 288 / seq 43530`。root 的后续 `tool/ptc-dispatch` 在 `seq 43569` 已写入 B-172 修复要点，证明该说明已进入其工作上下文，不把 RPC 回执单独当作已读证据。

### 第二十九轮未闭合

- 本轮在隔离仓库重放原始反例，未在活动 Team 的接收分支上执行破坏性 `team_merge`；不声称 live 原始反例已重放。
- B-172 修复只阻止后续调用制造包装节点，不改写已经存在的包装提交；历史包装节点仍需按其已清关树和落地方案处理。
- 当接收分支头不是成员 tip 的祖先时，平台仍会按既有语义刷新目的地并可能产生 merge 节点；这是需要重锚的拓扑，不是本轮放宽的目标。
- 本轮未重启 DSH；四份 profile 已同步，但运行中进程的 live 行为仍需以实际调用复核。

## 第三十轮修复（2026-09-29 · B-173、O-10-13）

- 输入清单指纹（开始时）：size `543941`，SHA256 `16410B9B59C3B42E09A24F3C0B38633B9B74B7C5889A3E89030BCE26674BC62C`，mtime `2026-09-28T20:09:02.0348580Z`。
- 交付前重读时清单已由 root 推进到 size `552911`，SHA256 `39E9F93B6CF9F114AB69C78EFCEEC0866152BD247E1D91654B444A1EC35DF694`，mtime `2026-09-28T20:39:09.8216358Z`；新增内容包含 `B-174` / `O-10-14`，在本节后紧接一轮处理。
- 备份：`D:\dsh-test\backups\platform-defects-b173-o10-13-20260929-042722`，包含修改前的四份 profile 目标文件、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-173** | fixed, focused + live verified | `team-worktree.mjs` 新增 `cargoTargetDirectory()`，通过 `cargo metadata --no-deps --format-version 1 --manifest-path ...` 读取 Cargo 权威 `target_directory`；新增 `cargoTargetIsolationVerdict()`，主检出与目标 worktree 的 target 路径相同则 fail-closed，Windows 路径按大小写不敏感比较。`team_worktree_setup` 在绑定 worktree 前执行该检查，共享 target 时以 `cargo-target-isolation` 拒绝；`team_delivery_check` 对所有 durable `worktreePath` 加主检出执行同一检查，并输出 `cargo-target-shared` / `cargo-target-unverified` blockers。 |
| **O-10-13** | partial, focused + live verified | `team_task_list` 只对最终返回页计算 integration，不再对整板所有卡逐次跑 Git；新增 `mainAncestorSet()`，一次 `git rev-list main` 后用集合判断整页 commit。`team_delivery_check` 预索引 evidence/packets，并共用一次 main ancestry 读取。`runtime_facts` 不再把无持久化 schema 的 `schemaVersion=null` 算作 runtime evidence 缺失，默认把未提供的 documented/session 层显式记为空观察。主超时症状已 live 转绿；live `runtime_facts` 仍因 loader 条目缺少 entry hash 而 degraded，保留 partial。 |

### 第三十轮验证

- B-173 原始反例：`platform-defects-eighteenth-pass.test.mjs` 在隔离 Cargo fixture 中让两个检出配置同一 target，旧语义下会被判为共享；修复路径 `ok=false/shared=1`；改为各自 target 后 `ok=true/checked=2/shared=0`。
- O-10-13 focused：同一测试用一次 main ancestry 集合判定整页 integrated / not-integrated；`runtime_facts` 对 `schemaVersion=null` 的插件不再产生 `runtime evidence incomplete`，只保留 `schema-unknown` 差异。
- 新测试：`platform-defects-eighteenth-pass.test.mjs` `3/3`；focused 第十五至第十八轮合计 `19/19`。
- 全量 phase1-phase11 串行：`446 tests / 445 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b173-o10-13-full-phase1-phase11-20260929.log`（SHA256 `260E80392B9E15E6ED895103DEA8FF45FC7448C1A9FA1F67C0B1446F15FCFADB`）。
- 四 profile 四个目标文件 `node --check`：`16/16` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 四份目标文件哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收复核说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`；`agent/inbox/spliced` 为 `seq 44107`，`user/message` 为 `seq 44114`，root 在 `turn 291 / seq 44115` 开始执行。live 读数在 `seq 44154`：`team_delivery_check` `24.994 s`（第二次 `26.578 s`），`deliverable=false`、`open=6`、`actionable=6`、`noOwner=0`、`notIntegrated=1`、`dead=0`，`cargoTargetIsolation={ok:true,checked:13,shared:[],errors:[]}`；组板列表 `group-proto 3.3 s / 81`、`group-rig 2.4 s / 53`、`group-world 4.9 s / 100`；`runtime_facts` `5.17 s`，`complete=false / degraded=true`。

| 文件 | SHA256 |
|---|---|
| `team-worktree.mjs` | `B259C0AEB75C32DA4108B5307B77358CFF59E65653AF367108DECA32D87436B1` |
| `team-tools-v2-r10.mjs` | `A70624D5316072DB928633A17C88B0A5C1380D201F5FE9588544047D140665FD` |
| `team-v12-runtime.mjs` | `52685C2F215B788118525DB84FBFFEE4FFE6119B0940EECB3F0AE2539A96A05E` |
| `team-v12-runtime-facts.mjs` | `FC43F5799893AC961D9596F1AC68A52461FFCCE8BFF3A395C5862F5016358CBB` |

### 第三十轮未闭合

- O-10-13 的主超时症状已 live 转绿；`runtime_facts` 仍为 degraded，原因已收窄为 loader runtime 条目缺少 entry hash，不再混入 schema-null 或未提供 documented/session 层的假降级。
- B-173 live 检查覆盖 13 个 durable worktree；root 观察到盘上另有 `grp__proto`、`grp__rig`、`verifier-detached`、`lead-lockcheck` 不在检查域内。`shared:[]` 只能读作已检查对象无共享，不能外推为盘上全量无共享。
- 本轮未重启 DSH；live 调用已证明新字段和新读路径被当前进程加载，但没有执行破坏性 worktree/merge 反例。

## 第三十一轮修复（2026-09-29 · B-174；O-10-14 covered）

- 输入清单指纹（交付前重读）：size `552911`，SHA256 `39E9F93B6CF9F114AB69C78EFCEEC0866152BD247E1D91654B444A1EC35DF694`，mtime `2026-09-28T20:39:09.8216358Z`。
- 备份：`D:\dsh-test\backups\platform-defects-b174-o10-14-20260928-204630`，包含修改前的四份 profile 目标文件、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-174** | fixed, focused-verified | `team-worktree.mjs` 的 `dirtyStatusInfo()` 在保持既有 `dirty` 输出不变的同时新增原始 `rawDirty`，用于区分 porcelain 的 ` M `（未暂存 tracked 修改）与 `M `（暂存）、冲突或其它未知脏形态。`worktreeAdd(..., {allowTrackedUnstaged:true})` 仅允许未暂存 tracked 修改穿过 lease 前的 stale-base 同步；Git 自身在改动与 base 重叠时拒绝 merge，暂存/冲突/未知形态仍以 `worktree-refresh-dirty` fail-closed。`team_run_lease(acquire)` 使用该内部 opt-in，并在 lease 回执附带 `preservedTrackedUnstaged`。默认 `team_worktree_setup` 路径未放宽，仍拒绝所有 tracked 脏行。 |
| **O-10-14** | covered, no platform change | root 第一手观察到 `task-contract-gate-unavailable … cause=lease-revision-mismatch`，拒绝文本已具名并发竞态；这是正确拒绝形态，不需要代码修改。未将其扩成新的跨 turn 重试策略。 |

### 第三十一轮验证

- 原始反例：`platform-defects-nineteenth-pass.test.mjs` 在隔离 Git 仓库覆盖四条路径：① 落后 main 且有未重叠未暂存修改 ⇒ 同步成功、branch 含 main、工作区原文保留；② 同一文件被 main 与本工作树同时修改 ⇒ Git 安全拒绝、原文保留、branch 未推进；③ 暂存修改 ⇒ 仍 `worktree-refresh-dirty`；④ 默认 setup 路径 ⇒ 未暂存修改也仍被拒绝。
- 新测试：`platform-defects-nineteenth-pass.test.mjs` `4/4`；focused 第十五至第十九轮合计 `23/23`。
- 回归修复：首轮全量暴露既有 `platform-defects-fifth-pass.test.mjs` 依赖 trimmed `dirtyFiles`；已通过保留原 `dirty` 契约、另加 `rawDirty` 修正，第五轮与第十九轮组合 `14/14` 通过。
- 全量 phase1-phase11 串行：`450 tests / 449 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-b174-full-phase1-phase11-20260929.log`（SHA256 `436B3FBFAD089082A125174D1817C2C0D757984E4F105E80A2990B6DC9D0C65D`）。
- 四 profile 四个目标文件 `node --check`：`16/16` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 四份目标文件哈希逐项一致。
- DSH root 会话已接收 B-174/O-10-14 修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`；session v4 中 `agent/inbox/spliced` 为 `seq 44560`，对应 `user/message` 为 `seq 44566`。

| 文件 | SHA256 |
|---|---|
| `team-worktree.mjs` | `58FB60590F6E10AABE6C16E1480FF5A5B93A8C1FEE652BBAD4B5C9490D5F7D5E` |
| `team-tools-v2-r10.mjs` | `0B947FD135737EAD0FD7E6654E2D8E48FEA05FE7199B958F4084E17210F2712F` |
| `team-v12-runtime.mjs` | `52685C2F215B788118525DB84FBFFEE4FFE6119B0940EECB3F0AE2539A96A05E` |
| `team-v12-runtime-facts.mjs` | `FC43F5799893AC961D9596F1AC68A52461FFCCE8BFF3A395C5862F5016358CBB` |

### 第三十一轮未闭合

- 本轮只放开未暂存 tracked 修改；暂存、冲突或无法解析的 porcelain 形态继续 fail-closed，仍需调用方先提交或显式处理。
- 未在 active Team 的真实成员 worktree 上制造脏状态重放；原始反例为隔离仓库第一手验证。运行中进程是否已加载该代码，需以 root 的后续 live `team_run_lease` 读数为准。

## 第三十二轮修复（2026-09-29 · batch 25）

- 输入清单指纹：size `566457`，SHA256 `197787C89ED33F480023E8F813F0A2B47E761414D43ED74871859B2654AFFEB6`，mtime `2026-09-28T21:32:47.7589710Z`。
- 交付前重读最新 `PLATFORM-DEFECTS.md`，新增/变化项仍为 §2896-2907 的七项；未发现重读期间再次变化。`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch25-20260929-060157`，包含修改前四份 profile 的五个目标文件、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。目标 DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **worktree-binding-missing** | fixed, focused-verified | `write-scope-guard.mjs` 新增 `worktreeBindingMissingVerdict()`：tier-1 目标位于 managed worktree 且 active plan 无 `worktreePath` 时，拒绝原因改为 `worktree-binding-missing`，并指向 `team_worktree_setup`。 |
| **pwsh here-string 误抽路径** | fixed, focused-verified | `shellWriteTargets()` 在路径抽取前遮罩 PowerShell here-string 正文；`per` 等 commit message 散文不再成为目标，同时 `Set-Content -LiteralPath` 的真实写入目标仍可识别。 |
| **leaseHeartbeat / contractRevision** | fixed, focused-verified | `team-control-plane.mjs` 的 `leaseAcquire` 持久化正整数 `contractRevision`，`leaseHeartbeat` 校验并更新该字段；`team-tools-v2-r10.mjs` 在 acquire/heartbeat 时从任务契约传入 revision。 |
| **退役 inbox ack 幂等** | fixed, focused-verified | `team-v12-room-wake.mjs` 新增持久 `acknowledgedInbox` 与事件回退；`team-v12-runtime.mjs` 在 pending-only ack 后写入台账，重试已消费项返回 `handled/deduplicated/retired`，目标范围继续 fail-closed。 |
| **O-10-16 相位指引** | fixed, focused-verified | `team-tools-v2-r10.mjs` 新增 `phaseAdvanceGuidance()`；相位跳级拒绝列出 `group-check -> verifier-review -> integration-ready` 等相邻步骤，并说明每一步调用 `team_task_update(action:"advance_phase")`。未改变相位门禁。 |
| **delivery_check.blockers 历史噪声** | fixed, focused-verified; live count pending | 已进入 main 的完成 edit 卡只抑制历史 phase/packet gate，保留 owner/commit/evidence 缺口；resolved/cancelled finding 不再计入 blockers。未在 active Team 上重新统计总噪声数。 |
| **verifier 收口自己名下等待票** | fixed, focused-verified | `waiting_resolve` 仅在显式 `ticket_id` 且调用者是该票 `waiter` 或 `responsible` 时允许自关；`waiting_set` 不放宽，非 waiter 仍 `waiting-scope`。 |

### 第三十二轮验证

- 新测试：`platform-defects-twentieth-pass.test.mjs` `7/7` 通过，覆盖 here-string 正负控、worktree 绑定三态、heartbeat revision、退役 ack 幂等与跨目标拒绝、相位步骤逐字、历史 gate 过滤边界、waiter 自关正负控。
- 相关组合：新测试加 runtime/waiting/write-scope/wake/room-memory 六个既有测试文件，`50/50` 通过。
- 全量 phase1-phase11 串行：`457 tests / 456 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch25-full-phase1-phase11-20260929.log`（SHA256 `22E9A423E48BA889969B8C0A88EAF0804705AF97BC09447069292CB4B128F55F`）。
- 四 profile 五个目标文件 `node --check`：`20/20` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 五个目标文件哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收本轮修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`，requestId `12808995-5153-4ae9-975f-dcc318c28e31`。

| 文件 | SHA256 |
|---|---|
| `write-scope-guard.mjs` | `C822456A30E9319656D7CAC9292F94D28F593D6C30B536330229B4DD89452B71` |
| `team-control-plane.mjs` | `D76D4C3606E3F9463A997B1009152E334AD146644B40D164912367887F4F8F51` |
| `team-tools-v2-r10.mjs` | `437B22FE990A1C227D52A7FB28448064365D4E0EBA6AFC77EDEBFDB1DCDAB2E6` |
| `team-v12-runtime.mjs` | `AAAA0A949D396382735358DA7794D5F194FBA86A53339A945252F04B711CA058` |
| `team-v12-room-wake.mjs` | `8C7E56CA5A3FB451F899EFFD7508FAB979574F7A404325880B3A062ADCBD2925` |

### 第三十二轮未闭合

- `delivery_check.blockers` 的过滤逻辑已聚焦验证；真实 active Team 的过滤后总量尚未在 root live 调用中复测，不能把离线断言写成 live 计数。
- 其余六项为隔离 fixture / focused / 全量回归验证；当前进程未重启，live 原始反例仍需 root 后续调用确认。
- `worktree-binding-missing` 只改善拒绝归因，不替 tier-1 自动布置工作树；结构上仍由 tier 0 执行 `team_worktree_setup`。

## 第三十三轮修复（2026-09-29 · D-新-1、D-新-2）

- 输入清单指纹（交付前重读）：size `574652`，SHA256 `AAE8B17A7C0D7D794FF937ECD4C33D357B1AF27B32458424C742B5E4E1113C9C`，mtime `2026-09-28T22:17:43.4966232Z`。
- 完整重读 `PLATFORM-DEFECTS.md`、`WORKAROUND-REVERT.md` 与修复台账；本轮新增/变化项为第二十六批的 `D-新-1`、`D-新-2`，`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch26-20260929-064000`，包含修改前的 `dsh-jobs-local` / `dsh-tool-jobs` 文件、四份 profile 目标文件、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **D-新-1** | fixed, focused-verified; live pending | `dsh-jobs-local` 新增持久 `JobJournal`：按 PID + process token 写作业元数据与终态；启动恢复时，宿主已消失且无终局的 running/stopping 行转为 `orphaned`，带 `finishedAt` 与 `host process <pid> exited before terminal settlement`。相同 PID、不同 process token 也判为 dead，覆盖 PID 复用边界。`list/get/read/readAt/kill/wait` 均接入 recovered row；`job_list` 公共 schema 接受 `orphaned`。新增 `recovered` 事件并在订阅后重放；`dsh-tool-jobs` 将恢复事件通知 owner，owner 尚未恢复时排队到 `agent/created` / idle，避免静默丢失。 |
| **D-新-2** | fixed, focused-verified; live pending | `team-v12-runtime.mjs` 的 `runtime_facts` 默认走紧凑摘要：只保留非噪声差异 plugin，汇总 `totalPlugins/includedPlugins/omittedPlugins/omittedUnobservedRuntimeEntries/diffSummary`，并支持 `input.pluginIds` 定向；`input.full:true` 或 `input.summaryOnly:false` 仍返回完整报告。四份 profile 已同步，web/headless/desktop/teamtest 目标文件 SHA256 一致。 |
| **batch 25 live 收口** | recorded | 已把第二十六批 root live 复核写入台账口径：inbox ack 幂等与 `delivery_check.blockers` 噪声收窄为 live 通过；相位跳级拒绝文本因前置门遮蔽，未制造读数；here-string/`worktree-binding-missing`、失效租约重绑、responsible 自关等待自然触发条件，均不得写成 live verified。 |

### 第三十三轮验证

- `node --check`：jobs-local、jobs invariant 两份、tool-jobs、测试文件共 `5/5` 通过；四 profile `team-v12-runtime.mjs` 共 `4/4` 通过。
- 新测试：`platform-defects-twenty-first-pass.test.mjs` `4/4` 通过，覆盖 runtime_facts 摘要、dead-host orphan、PID 复用 process-token 边界、启动后恢复事件重放。
- 相关组合：新测试 + 第十八轮 + `v14-runtime-bridge` + `v14-profile-parity`，`25 tests / 25 pass / 0 fail`。
- 全量 phase1-phase11 串行：`461 tests / 460 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch26-full-phase1-phase11-20260929-rerun.log`，SHA256 `31D32EF3F3050968F02BF80B5F037FA69A3ADA598F01E8E5D11649E7A9F597CD`。
- `team-v12-runtime.mjs` 四份 SHA256 均为 `3B06105B135F7C9F1B79BFD58B4FC2B3DEE36624FF89172625DED737A48ED8AE`。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收本轮修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`。

### 第三十三轮未闭合

- 运行中的 DSH 已加载旧 `dsh-jobs-local` / `dsh-tool-jobs`，在不重启的约束下无法 live 验证 `D-新-1`；离线 journal / event / 工具接入已通过 focused 与全量回归，不能写成 live verified。
- `D-新-1` 恢复的是作业元数据、终态、detail 与显式事件；旧输出 ring 与 spill 文件不由 journal 复制，恢复后仍需按 detail 指向或既有 spill 路径检查原始载体。
- `D-新-2` 的 profile 文件已同步且离线验证通过；未重启，root live 调用确认仍待完成。

## 第三十四轮修复（2026-09-29 · D-新-2 .. D-新-5、D-新-7）

- 输入清单指纹（本轮开始时）：size `584742`，SHA256 `D396D71ED1151F4863B95111FCCCE0AA89B0002DC68FE831DB64DB2FDF707E8C`，mtime `2026-09-28T22:52:57.7827633Z`。
- 交付前重读时清单已推进到第二十八批：size `589467`，SHA256 `7CA5A8AB35CA3B8635C74BDA7CFFB215545EED0FCC1C0CDD5A3F6155BDE8C1E1`，mtime `2026-09-28T23:03:13.6689532Z`。第二十八批只记录 t56 落地、PID 归属、清理/复现纪律与 t64/t65/t66，没有新增平台缺陷编号；第二十七批的 `D-新-2` .. `D-新-7` 未再变化。`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch27-20260929-070000`；其中 `pre-edit` 按 web/headless/desktop/teamtest 分目录保存本轮修改前的三个目标文件和测试。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。DSH PID `124592` / 端口 `40123` 全程保持监听。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **D-新-2** | fixed, focused-verified; live pending | `compactRuntimeFacts` 不再依赖 `runtime.entry` 的精确错误形态；默认按“该 plugin 的 differences 非空且全部属于噪声码”过滤，噪声集合补入 `patch-source-unknown`。`summaryOnly:true` 走同一路径；`full:true` / `summaryOnly:false` 仍返回全量；显式 `pluginIds` 继续覆盖过滤。 |
| **D-新-3** | fixed, focused-verified | `write-scope-guard.mjs` 新增平台托管的 `DSH_HOME/verifier-scratch` 根和 `isVerifierScratchPath()`；仅 Team membership `group=verifier` 可在该根内写入，产品目录和其它成员仍走原 fail-closed 检查。 |
| **D-新-4** | fixed as explicit rejection, focused-verified | `team_task_create` / `team_task_update` 在写入前调用 `crossBoardBlockerVerdict()`。blocker 只存在于另一板时返回 `cross-board-blocker-unsupported`，逐项列出实际 board，并提示使用等待票或后续 board-qualified 依赖；不再落到含糊的 `blocker task ... not found`。 |
| **D-新-5** | fixed, focused-verified | 受控 `write_scopes` 与普通字段同次提交仍原子拒绝，但拒绝串现在明确 `no fields were applied by this call`、列出同次未应用的 `subject/description/goal/deliverable`，并提示先替换 plan、再单独提交普通字段。 |
| **D-新-7** | fixed, focused-verified | 卡面投影新增 `contractRevision`、`requirementRevision`、`contractStale`；`durableTask()` 从同一 control-plane snapshot 取出 acceptance requirement，避免逐卡二次全量 view。卡面仍不能反推完整新 contract 时，消费者可明确识别 requirements 已领先。 |
| **D-新-6** | partial, no platform change | 仍与既有 `A-6` 合并：插件层只能约束受控工具/已解析命令，不能对任意无参子进程做 OS 级 sandbox。本轮不宣称拦截任意子进程写盘。 |

### 第三十四轮验证

- `node --check`：web/headless/desktop/teamtest 三个目标文件共 `12/12` 通过。
- 新测试：`platform-defects-twenty-second-pass.test.mjs` `5/5` 通过，覆盖噪声形态无关过滤、verifier scratch 正负控、跨板 blocker、混合 edit 原子拒绝文案、contract stale 投影。
- 原始反例集成：`v14-write-scope.test.mjs` 的 verifier scratch 实际 hook 写入通过且产品路径仍拒；`v14-global-task-completion.test.mjs` 的跨板 create 实际拒绝、卡面 contract/requirement revision 集成通过。聚焦组合共 `22/22`。
- 全量 phase1-phase11 串行：`469 tests / 468 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch27-full-phase1-phase11-20260929-v2.log`，SHA256 `7926B70E44317CA7D3F9A8021313BE123C979F8242B40FDDD8C77FAC58530B40`。
- `v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 三个目标文件哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 接收本轮修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`。

| 文件 | SHA256 |
|---|---|
| `team-v12-runtime.mjs` | `E0F2B02280B6618FEB9A519C4E7E4782DFDAA8637AA3F8E1E66E519BF280132F` |
| `team-tools-v2-r10.mjs` | `DDF683C8BEFFFCB8DDFFD9F4CFBCF00CE6EEEBFD87ABC19D912006F740052C63` |
| `write-scope-guard.mjs` | `221D132EF2A2A26E97FEA9C3FC54A1ED1EB121749C78A6C89625390CC27A7B06` |

### 第三十四轮未闭合

- 本轮未重启 DSH；三个 profile 文件已同步，运行中进程是否已 HMR 加载仍需 root 后续只读调用确认，不把 focused / 全量回归写成 live verified。
- `D-新-4` 采用明确拒绝而不是跨板解析；跨板依赖仍要由调用方改为等待票，ready 门禁不会跨板生效。
- `D-新-7` 提供 stale/revision 标志，不尝试从 requirements 反推或伪造完整 contract；真正同源仍是后续结构性修复。
- `D-新-6` 的 A-6 残余仍在：OS 级任意子进程写盘无法由当前 Node hook 沙箱覆盖。

## 第三十五轮 live 复核（2026-09-29 · batch29，无平台代码修改）

- 输入清单指纹：size `594018`，SHA256 `825998F59C7297709D3A2513610E616F09D9CC4F325EED39262AB40AB6F58AA9`，mtime `2026-09-28T23:17:45.2350145Z`。
- 第二十九批没有新增平台缺陷编号；变化是 batch27 修复项的 live 复核、逐模块生效纪律和 guard 动态路径读数观察。`WORKAROUND-REVERT.md` 无新增回退项。
- **D-新-2：live 通过。** 默认 `runtime_facts` 从 `125,814` 字节降到 `50,816`，`includedPlugins=89`、`omittedPlugins=183`；`summaryOnly:true` 同形；`summaryOnly:false` 保留全量 `800,382` 字节；`pluginIds` 定向返回 1 个 plugin。纯噪声的 `write-scope-guard` 默认省略、定向仍返回，口径自洽。
- **D-新-7：live 通过。** 卡面同时返回 `contractRevision=8`、`requirementRevision=4`、`contractStale=false`，过渡期“只读 requirements_snapshot 判断契约版本”的纪律可以退役。
- **D-新-3：仍为 live pending。** guard 文件已落盘且 verifier-scratch 分支位于拒绝之前，但 PID 124592 早于规则文件，当前进程仍加载旧模块；verifier 实测 scratch 与产品路径均被拒。按约束不重启，生效判据保持为重启后 verifier 写 scratch 得到 `WRITE_OK=True` 且读回一致。
- **D-新-4：focused-verified，live pending。** 明确拒绝路径已落盘；未 live 复核的原因是测试会制造一次失败 create 的垃圾卡。
- **D-新-6：维持 A-6 partial。** 未知子进程的 OS 级写盘仍不在当前 Node hook 沙箱覆盖内。
- 本轮未修改平台代码或四份 profile，未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；因此没有新的修复结果需要投递到 root 会话。

## 第三十六轮修复（2026-09-29 · D-新-8 .. D-新-14）

- 交付前重读清单指纹：size `605655`，SHA256 `1C663B0144A643A08E4C2C090519DAD6141264BA4DF3A85BB8D8D84A6526AF43`，mtime `2026-09-29T00:34:47Z`。
- 完整重读 `PLATFORM-DEFECTS.md`、`WORKAROUND-REVERT.md` 与修复台账。变化覆盖第三十至第三十二批的 `D-新-8` 至 `D-新-14`；`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch30-20260929-083650`，包含修改前四份 profile 的六个目标文件（其中 `team-v12-room-wake.mjs` 已补备份）、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **D-新-8** | fixed, focused-verified; live pending | `team-v12-evidence-scheduler.mjs` 与 `team-v14-waiting.mjs` 统一 owner 投影：显式 `ownerName:null` 不再被 `contract.owner` 复活；只有字段缺失/undefined 才兼容旧 contract owner。`ready_queue` 与派生等待票不会再从 stale contract 多报 owner。 |
| **D-新-9** | fixed, focused-verified; live pending | `ready_queue` 行新增 `leaseScope`、`leaseTaskId`、`leaseMember`、`taskLeaseActive/taskLeaseExpiresAt`、`memberLeaseActive/memberLeaseExpiresAt`。原 `leaseActive/leaseExpiresAt` 保留兼容，但不再把成员级 run lease 读成卡级 lease。 |
| **D-新-10** | fixed, focused-verified; live pending | `team-v12-room-wake.mjs` 新增 `recordDeliveredInboxMessage()`；`team-v12-runtime.mjs` 在 delivery receipt 阶段把已提交的原生 Team message materialize 为 `status:"injected"` 的 inbox 行，随后 `inbox_ack` 可收口。批通道与单发通道共用该路径。 |
| **D-新-11** | fixed, focused-verified; live pending | `taskEditWriteScopeVerdict()` 接受 `planExists`：无 plan 时明确说明 scope 由 contract/plan 控制并指引 `team_plan_propose`；不再要求替换不存在的 approved plan。`team-control-plane.mjs` 的直接编辑拒绝串同步改为可执行指引；已有 plan 时仍保留 replace plan 路径。 |
| **D-新-12** | fixed, focused-verified; live pending | `planScopeConflictVerdict()` 新增严格收窄判定：新 scope 全部落在自身旧 scope 内且至少一项严格变窄时返回 `ok=true / code="narrowed-scope"`；扩 scope 仍返回 `scope-conflict`。 |
| **D-新-13** | covered by D-新-12, focused-verified; live pending | 同目录/父子 scope 的对称互锁由同一严格收窄通道解除：任一方可从旧目录 scope 收窄到其子文件，不再需要 delete + 重建。直接改卡面 `write_scopes` 仍拒绝，收窄入口仍是 plan replacement。 |
| **D-新-14** | fixed, focused-verified; live pending | `team-v12` 新增只读 `action:"leases"`：成员默认只读自己的 lease，tier 0 可按 `input:{member,taskId,status}` 查询。返回 runId/member/taskId/status/acquiredAt/expiresAt/endedAt，成员可回答“我是否仍持有租约”，不再必须直接读控制面文件。 |

### 第三十六轮验证

- 新测试：`platform-defects-twenty-third-pass.test.mjs` `7/7` 通过，覆盖 owner null 语义、lease scope、原生消息 materialize 后 ack、无 plan 文案、严格收窄 scope、同目录互锁、自身 lease 读面。
- 既有 B-128 断言同步为当前正确行为：无 plan 时必须指向 `team_plan_propose`，不得要求替换不存在的 approved plan。
- focused 组合：`60/60` 通过（新测试 + scheduler/waiting/room-memory/runtime-bridge/profile-parity/wake-claim/write-scope）。
- 全量 phase1-phase11 串行：`329 tests / 328 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch30-32-full-phase1-phase11-20260929-rerun.log`，SHA256 `3BCAB39B4C3991533FD481CDBC4E09CD87B3DE3F3771297544281ABAFF180A74`。
- 四 profile 六个目标文件 `node --check`：`24/24` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 六个目标文件哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收本轮修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`。

| 文件 | SHA256 |
|---|---|
| `team-v12-evidence-scheduler.mjs` | `002BF3D84F1A56B18EE73381777427CA661AC040507BEC49E3028483B430E948` |
| `team-v14-waiting.mjs` | `4C976B08A767A8D5FEE37DF92E94F4245AEA2DBE791F1E78A2BDD1437C7F86FB` |
| `team-v12-room-wake.mjs` | `A87AC71DD73D06FF736CE4505F9FE88E46A29738B7D423EC5674BB85C39E7D78` |
| `team-v12-runtime.mjs` | `9BE8958E82AAA6EE8F050408F96414C219791AF01695BAF9232EA60CF86F9517` |
| `team-tools-v2-r10.mjs` | `21704A76605F59260BA0DDED4765964B7D0971AB81476195B40CE52ED97D4896` |
| `team-control-plane.mjs` | `771A18650C84E73A6CC88D9CA972694F76482181E0DAD8B1F6CB2FEEAFFFC990` |

### 第三十六轮未闭合

- 本轮未在活动 Team 上制造破坏性原始反例；七项均为隔离/focused/全量回归验证，不能写成 live verified。请 root 后续用只读或低风险调用复核 `ready_queue` lease 域、`team_v12(action:"leases")` 与实际 `inbox_ack`。
- D-新-10 的原始样本跨批通道与单发 info；代码已统一 materialize 已提交原生消息，但未对原消息逐条 live 重放。
- D-新-12 / D-新-13 放行的是 plan replacement 的严格收窄；直接卡面 scope 编辑仍 fail-closed。历史已分叉 scope 不会自动改写。
- 当前 DSH 未重启；若运行进程未 HMR 加载修改后的模块，live 行为仍以 root 后续实际调用为准。

## 第三十七轮修复（2026-09-29 · D-新-14 补充、D-新-15）

- 交付前重读清单指纹：size `609022`，SHA256 `1468E91611E09559C23E9A4D1CEC0172460AC65908687D7D48ADE7304498C166`，mtime `2026-09-29T00:49:02.9109274Z`。修复期间该指纹未再次变化；`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch33-20260929-090124`，包含修改前四 profile 的目标文件、相关测试、旧台账与旧 watch state。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **D-新-14 补充** | fixed, focused-verified; live pending | `projectLeasesForMember()` 对 tier 0 的空 `member` 保留全表读取；显式 `member` 现在参与过滤，并与 `taskId/status` 取交集。`team-v12-runtime.mjs` 只在 tier 0 未显式传 `input.member` 时省略 member 过滤，非 tier 0 仍只能读取自身 lease。 |
| **D-新-15** | fixed, focused-verified; live pending | `write-scope-guard.mjs` 新增 `worktreeCarrierVerdict()` 与 `gitCommandWorkdir()`。tier 1/tier 2 有活动 plan worktree 时，文件写入、shell cwd、`git -C <path> add/commit` 的载体必须落在绑定 worktree 内；共享检出和其它 worktree 返回 `worktree-carrier-mismatch`，绑定 worktree 正常放行。tier 2 的旧“无自身 worktree”拒绝语义保留；tier 0 共享检出兼容路径保留，无活动 plan 的旧静态 scope 路径未扩大。 |

### 第三十七轮验证

- 新测试：`platform-defects-twenty-fourth-pass.test.mjs` `4/4` 通过，覆盖 tier 0 显式/省略 member、非 tier 0 自限、`git -C` 解析、共享/其它/绑定 worktree 载体、普通与 `git -C` commit、tier 0 共享检出兼容。
- 相关 focused：首轮组合 `48/48`；发现并保留既有 B-78 的 tier-2 拒绝文案后，`platform-defects-fifth-pass.test.mjs` + 新测试 `14/14` 通过。
- 全量 phase1-phase11 串行：`480 tests / 479 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch33-full-phase1-phase11-20260929-rerun.log`，SHA256 `784E36C78CD799B78A87C03C169055E712CF3923B4F6ADBAB7D9EA3A3CEFB4F8`。
- 四 profile 三个目标文件 `node --check`：`12/12` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 三个目标文件哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收本轮修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`。

| 文件 | SHA256 |
|---|---|
| `write-scope-guard.mjs` | `6C5A42F29EDE7800DAA5E91B41787E43A6057BDB663B11D253B1D52C08FB8826` |
| `team-v12-evidence-scheduler.mjs` | `CA398C905C8716C339EBDFD985D7F5A5EE4557DD3B2F9FCD0DA83CD57517AFAD` |
| `team-v12-runtime.mjs` | `C9418F837295CA36829331C95F29C7A210AE4C90586C82F81A7811897CF17D70` |

### 第三十七轮未闭合

- 未重启 DSH；运行中进程是否已 HMR 加载修改后的模块仍需 root 后续只读调用确认，不把 focused / 全量回归写成 live verified。
- `write-scope-guard` 仍只覆盖受控工具和已解析命令；任意无参子进程自行写盘的 A-6 残余未扩大修复。

## 第三十八轮修复（2026-09-29 · D-新-16；D-新-15/17 收口）

- 交付前重读清单指纹：size `620486`，SHA256 `56F864653AF402519D1005AEDC692C558410EACA75AA54CC2E6D3819E27A9C47`，mtime `2026-09-29T01:29:12.0000945Z`。本轮变化为第三十四/三十五批：D-新-15 的 live 负控、D-新-16、D-新-17 及多任务验收包部分应用观察；`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch34-20260929-093225`，包含修改前的四份 profile `team-control-plane.mjs`、旧台账、旧 watch state 和相关测试。
- 约束：不重启 DSH、不中断 active Team、不清理 backups/spill/telemetry/session、不改 RustMc 产品仓。DSH PID `124592` / 端口 `40123` 全程保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **D-新-16** | fixed, focused-verified; live pending | `leaseAcquire` 改为 `{ deferMs: 0 }`，在返回 active 回执前同步写入持久控制面；返回值改为 `structuredClone(lease)`，防止调用方持有的回执被后续 heartbeat 原地修改。新增 `platform-defects-twenty-fifth-pass.test.mjs`：acquire 后直接检查持久文件，清 cache 后重载，再 heartbeat 并确认 checkpoint 可读。既有 O-10-8 同时捕获了旧返回引用导致的 `initial.expiresAt` 被副作用改写。 |
| **D-新-15** | fixed, focused-verified; live pending | 上一轮的工作树载体校验已落盘并通过 focused；本轮成员负控实测共享检出仍 `CREATED=true`、无 `worktree-carrier-mismatch`，而 DSH PID 124592 启动早于 guard mtime，因此明确记为 **未热加载 / 需重启后复核**，不改写为 live verified。 |
| **D-新-17** | partial, no platform change | 保留两条已证实事实：review/discussion 卡只能相邻推进，到 `verifier-review` 会经过无语义中间相位；`final-acceptance` 对 verifier 自有卡形成自审门。继续采用“`completed` 为 verifier 自有 review 卡终态、验收由 tier 0 具名”的过渡口径，不擅自放宽平台门禁。 |
| **多任务验收包部分应用** | observation, no platform change | 已记录包体不是事务性的：一张卡先推进、另一张卡因相邻相位失败会令调用整体报错。当前没有足够契约信息决定应回滚还是采用逐卡幂等语义，因此本轮只保留观察，不修改。 |

### 第三十八轮验证

- `node --check`：四份 profile `team-control-plane.mjs` 与新增测试共 `5/5` 通过。
- 聚焦原始反例与兼容：`platform-defects-twenty-fifth-pass.test.mjs` + `platform-defects-sixteenth-pass.test.mjs` + `platform-defects-twentieth-pass.test.mjs`，`14 tests / 14 pass / 0 fail`。
- 全量 phase1-phase11 串行：`481 tests / 480 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch34-full-phase1-phase11-20260929.log`，SHA256 `9F26D59582C143BE89AB5DF49CBBA5552695640CE91C2B339B96CD25CF244ED9`。
- 四 profile `team-control-plane.mjs` SHA256 均为 `41E6FA453FDC60D836B0C181CE0A6DF9BA1B48C9F9355CEEB54F62F6ED657959`；web/headless/desktop/teamtest parity 通过。

### 第三十八轮未闭合

- 未重启 DSH；D-新-16 与 D-新-15 的 live 生效仍需 root 在下次进程更新后按原始反例复核，不把 focused / 全量回归写成 live verified。
- D-新-17 的结构性自审门仍为 `partial / no platform change`；多任务验收包仍非事务性，当前只记录观察。

## 第三十九轮 live 收口与清单复核（2026-09-29 · 无新增平台代码修改）

- 交付前重读清单指纹：size `636984`，SHA256 `E01F75303FBE62C7C06666476B2D6DA179881ECC17B50900C7317208658DEAB5`，mtime `2026-09-29T01:51:35.5587906Z`。本轮清单变化覆盖第三十六至第四十一批，`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch35-20260929-100500`，包含本轮修改前的修复台账与 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；DSH PID `124592` / 端口 `40123` 保持。

| 变化项 | 状态 | 判定与处置 |
|---|---|---|
| **D-新-16 live 复核** | **live verified** | root 有界真实调用链 `acquire -> leases -> heartbeat -> release` 通过：acquire 后 `leases` 立即可见同 runId 且 `status=active / expiresAt` 与回执一致；heartbeat 成功并更新 checkpoint；release 正常收口。第三十八轮的 focused / 全量证据与本轮 live 证据合看，原“回执 active 但持久表不存在”的反例已关闭。 |
| **D-新-15** | fixed, focused-verified; live pending | 维持前一轮边界：当前 PID 124592 未热加载 guard，共享检出负控仍被放行。需进程更新后重跑 `CREATED=false + worktree-carrier-mismatch` 判据。 |
| **D-新-17** | partial, no platform change | 相邻推进可用；`final-acceptance` 对 verifier 自有卡的自审门仍保留。继续采用 `completed` 作为该类卡终态，不新增自审或放宽门禁。 |
| **第三十六至第三十八批过程观察** | no platform change | 时变计数需带 base；测度与域必须具名；跨组开卡按修点路径去重；重作业线占用者与排队者具名；`inbox_ack` 后须复读 `inbox_list` 确认目标消失。以上是审计/调度纪律，无已具名平台代码缺陷。 |
| **第三十九至第四十一批对账观察** | no platform change | 相位列是投影，交付判定必须用祖先读数；检查域不能由投影划分；清关注册表以落地对象为键，须取 `<cardSha>..main` 上最早的注册键。第四十批的“无清关”判定与告警已由第四十一批撤回，三张卡已按已读祖先与覆盖清关推进到 `accepted`；无需平台代码修改。 |

### 第三十九轮验证

- `node --check`：四份 profile `team-control-plane.mjs` 与新增测试共 `5/5` 通过。
- 全量 phase1-phase11 串行复跑：`481 tests / 480 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch35-full-phase1-phase11-20260929.log`，SHA256 `4A1B4EC1F93AA5121788AEA3863968E3789E2124736F1A0E84C1496D678C16E8`。
- 四 profile `team-control-plane.mjs` SHA256 均为 `41E6FA453FDC60D836B0C181CE0A6DF9BA1B48C9F9355CEEB54F62F6ED657959`，与第三十八轮一致。

### 第三十九轮未闭合

- D-新-15 仍需下一次进程更新后复跑原始载体负控。
- D-新-17 的结构性自审门与多任务验收包非事务性仍为平台语义边界；本轮无新增代码处置。

## 第四十六轮修复（2026-09-29 · B-175 至 B-180）

- 输入清单指纹：size `648786`，SHA256 `E57FA5EE0F5EBED0690E914CEB50FC1E65107DB81D76025C46EB10CB305A1BBE`，mtime `2026-09-29T02:36:24.7378364Z`。交付前重读清单、`WORKAROUND-REVERT.md` 与本台账，指纹未再次变化；回退台账无新增条目。
- 备份：`D:\dsh-test\backups\platform-defects-batch46-20260929-111829`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；DSH PID `124592` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-175** | fixed, focused-verified; live pending | `team-control-plane.mjs` 支持 `boardId:taskId` 板限定依赖，未限定 id 保持板内语义；ready queue 与完成重算按板解析，依赖满足读 blocker 的 `status/phase`，并检测跨板环。 |
| **B-176** | fixed, focused-verified; live pending | `team-v14-waiting.mjs` 的 `dependency` 条件在无 `taskIds` 时接受 `on/object/note` 具名对象，固定 `closurePolicy=explicit` 并须显式 `waiting_resolve`；空 dependency 仍拒绝。 |
| **B-177** | fixed, focused-verified; live pending | `team-tools-v2-r10.mjs` 的 `team_run_lease(release)` 接受 `status:"blocked"`，仅当任务有非空 `blockedBy` 或具名开放等待票时放行；普通 in-progress 仍拒绝。控制面 lease 状态同步支持 `blocked`。 |
| **B-178** | no platform code change | 过期断言所描述的产品侧裸 JSON number 已由产品交付 `7f363d89` 修正；当前产出侧为带引号 `"seed_i64"`，本轮不改 RustMc 产品仓，按“已更正”登记。 |
| **B-179** | no platform code change | 共享 Cargo target 的假读风险已具名：读门前检查 `.d` 的 `env-dep:CARGO_MANIFEST_DIR` 是否等于本次检出，不等即作废；作为 B-173 的验证纪律处理，不改平台插件。 |
| **B-180** | no platform code change | 仓外仪器必须同时具名路径、版本与内容 SHA256；属于判据可复算纪律，无平台代码载体可改。 |

### 第四十六轮验证

- 新增 `phase11-tests\platform-defects-twenty-sixth-pass.test.mjs`：`3/3` 通过，覆盖跨板依赖、具名 dependency 等待和 blocked release 持久化。
- 聚焦组合 `51/51` 通过，覆盖 waiting、continuation、scheduler、跨板拒绝与全局任务完成。
- 全量 phase1-phase11：`484 tests / 483 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch46-full-phase1-phase11-20260929-v2.log`。
- 四份 profile 的四个目标文件 `node --check`：`16/16` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 哈希逐项一致。

| 文件 | SHA256 |
|---|---|
| `team-control-plane.mjs` | `00E7ED97456AA412C3896FFDFBFB523EB175648329D2ED5D008EAECB0F88BA84` |
| `team-v14-waiting.mjs` | `11F573B7E7E60984D1F555C844580604AD3D89FC9C428C667407A837F0C2BF53` |
| `team-v12-evidence-scheduler.mjs` | `254DC200C7B157160C76251BAE1646252613A36577BC0AF640001C8E05081848` |
| `team-tools-v2-r10.mjs` | `4618F41C2788DC86BCC92A2B25A372B54BB3686F03E1C59D32599E98288A0545` |

### 第四十六轮未闭合

- B-175 / B-176 / B-177 已落盘并通过隔离聚焦与全量回归，但当前 DSH 进程未重启；运行中进程是否已加载修改后的模块仍为 live pending，不把 focused / 全量证据写成 live verified。
- B-179 的探测器目前是纪律与检查步骤，不替代隔离 `CARGO_TARGET_DIR`；共享 target 的历史产物仍可能误导未按该步骤执行的读数。
- B-180 的 SHA256 必须由仓外仪器的实际调用方在引用当刻现取并记录；平台无法代替该外部判据补全身份。

## 第四十七轮修复（2026-09-29 · B-182 至 B-185）

- 输入清单指纹：size `675733`，SHA256 `A9939E6352DB7D24D3F15AF2865A4572CD99333E5E5F1613AE78926D6D8E7599`，mtime `2026-09-29T04:17:35.8863946Z`。交付前重读清单、`WORKAROUND-REVERT.md` 与本台账，指纹未再次变化；回退台账无新增条目。
- 备份：`D:\dsh-test\backups\platform-defects-batch47-20260929-123400`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；DSH PID `124592` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-182** | fixed, focused-verified; live pending | `team-v14-waiting.mjs` 不再让 `task-terminal` 静默关闭带结构化条件的等待票；只有 legacy 无结构化条件的票仍按任务终态关闭。显式 `waiting_resolve` 与条件满足后的自动解除保持可用。 |
| **B-183** | fixed, focused-verified; live pending | `team-v12-runtime.mjs` 的 requirement/decision 授权从 `input.taskIds`、`task_ids`、已有记录及 `requirementId = task:<taskId>:...` 前缀解析任务作用域，并继承已有 scope；空 scope 不再直接判为 global。 |
| **B-184** | existing fixed code, focused-verified; live pending | `write-scope-guard.mjs` 已有 `verifier-scratch` 白名单和产品路径负控；本轮未改代码。测试通过，但当前 PID `124592` 早于 guard mtime，不能标为 live verified。 |
| **B-185** | no platform change | `citation_integrity` / `.ps1` 引注门禁属 RustMc 产品仓；本轮未修改产品仓。 |

### 第四十七轮验证

- 新增 `phase11-tests\platform-defects-twenty-seventh-pass.test.mjs`，覆盖 B-182/B-183；并同步旧断言到 B-182 的新语义。
- focused 组合：`88/88` 通过。
- 全量 phase1-phase11：`486 tests / 485 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch47-full-phase1-phase11-20260929-v2.log`。
- 四份 profile 的两个目标文件 `node --check`：`8/8` 通过；web/headless/desktop/teamtest 哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收本轮修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`。

| 文件 | SHA256 |
|---|---|
| `team-v14-waiting.mjs` | `874DE096242977F1FC297FE344494BA3EBE3E515382DF9689C833BC9CFF34444` |
| `team-v12-runtime.mjs` | `F11190B8D9D8014D4530170D4F08EFE0C34E17BB024E6174131A76400E9CEB18` |

### 第四十七轮未闭合

- B-182 / B-183 已落盘并通过隔离聚焦与全量回归，但当前 DSH 进程未重启；运行中进程是否已加载修改后的模块仍为 live pending。
- B-184 的既有 guard 修复仍受当前进程启动时间早于 guard mtime 的限制，需进程更新后按原始负控复核。
- B-185 是产品仓引注门禁问题，本轮平台侧无代码修改。

## 第四十八轮修复（2026-09-29 · B-186）

- 输入清单指纹：size `725502`，SHA256 `32AEFFA5D74AF2E3A5FADD97E6838EF80F7E11E34AC355E453FF375DD685CAF9`，mtime `2026-09-29T04:57:14.8602150Z`。交付前重读清单、`WORKAROUND-REVERT.md` 与本台账，指纹未再次变化；回退台账无新增条目。
- 备份：`D:\dsh-test\backups\platform-defects-batch48-20260929-130200`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；DSH PID `124592` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-186** | fixed, focused-verified; live pending | `team-tools-v2-r10.mjs` 新增 actor 相位边界判定：非 tier 0 只能推进到 `integration-ready`，不得手工跨入 `integrated`/`accepted`；既有“已完成 discussion/review 直接 accepted”例外保持。另修复 `reopen` 自愈：edit 卡若已在 `integrated`/`accepted`，重开会恢复为 `execution`，使 `group-rig-t86` 一类卡可重新完成。 |

### 第四十八轮验证

- 新增 `phase11-tests\platform-defects-twenty-eighth-pass.test.mjs`：`2/2` 通过，覆盖 owner 越界拒绝、tier 0 放行、直接只读验收兼容，以及 `accepted -> reopen -> execution` 自愈。
- 全量 platform-defects 聚焦集：`168 tests / 168 pass / 0 fail`；日志：`D:\dsh-test\output\platform-defects-batch48-focused-platform-tests-20260929.log`。
- 全量 phase1-phase11：`488 tests / 487 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch48-full-phase1-phase11-20260929.log`，SHA256 `C4C1EFA353E772D480853C11F1DD85494715A7936692794AC6B68993D4D78A22`。
- 四份 profile 目标文件与新测试 `node --check`：`5/5` 通过；web/headless/desktop/teamtest 的 `team-tools-v2-r10.mjs` SHA256 均为 `1BF5F26E54FFAD58E482CAC9E44F0A67F64DA20B21B13667B240CD510D40CFF9`。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收本轮修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`。

### 第四十八轮未闭合

- 当前 DSH PID `124592` 早于本轮修改，B-186 的 live 行为仍需进程更新后按原始反例复核。
- `reopen` 自愈只针对 edit 卡；已完成 discussion/review 的直接验收路径保持原语义，不扩展为通用相位回退。

## 第四十九轮清单复核（2026-09-29 · 无新增平台代码修改）

- 输入清单指纹：size `733960`，SHA256 `D9640124AC52E2E7CA343AFDF7831B804D3CFAF5DC9A730A17A3CFF6FEA2152A`，mtime `2026-09-29T05:11:00.4374842Z`。交付前重读清单、`WORKAROUND-REVERT.md` 与本台账，指纹未再次变化；回退台账无新增条目。
- 本轮清单新增内容是树叶 id 18 的 meta 位定义、t135 生物群系同源结论、B-186 批次 48 结果回录，以及纪律 ㊲-㊵；未出现新的 `B-*` 平台缺陷编号，也没有新的平台代码修复要求。

| 变化项 | 状态 | 判定与处置 |
|---|---|---|
| **树叶 meta 定义段** | no platform change | `bit 0-1 = variant`、`0x4 = decayable false`、`0x8 = check_decay true`；属于 RustMc 世界生成/产品语义，平台侧无代码载体。 |
| **t135 生物群系一致** | no platform change | 归入 `group-world-t134` 的产品装饰差异；平台侧不修改产品仓。 |
| **B-186 批次 48 回录** | already handled | 与第四十八轮实现、测试、profile 哈希和 live pending 边界一致，无新增代码变化。 |
| **纪律 ㊲-㊵** | no platform change | 选择性引用、陈旧工作树基座、数值退出码和 `check_decay` 机制均属产品验证纪律或已具名产品行为，未形成新的平台缺陷。 |

### 第四十九轮验证

- 未修改平台代码，未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；DSH PID `124592` / 端口 `40123` 保持。
- 未运行新的平台测试；沿用第四十八轮 `168/168` 聚焦、`488/487/0/1` 全量回归和 `5/5` 语法检查证据。

## 第五十轮清单复核（2026-09-29 · 无新增平台代码修改）

- 输入清单指纹：size `742174`，SHA256 `B88EE19DB31B8DD549D0E66C0CFCA42D6023A96EAEE5F26FA1BFA488D76EF9E5`，mtime `2026-09-29T05:40:56.4766790Z`。交付前重读清单、`WORKAROUND-REVERT.md` 与本台账，指纹未再次变化；回退台账无新增条目。
- 本轮新增内容为仪器轴四问、`$?`/`$LASTEXITCODE` 判别、失败探针证据纪律、令牌签发时点、关系型读数重测、负向断言四字段、谓词归位、范围外驳回与 spill 两层成因；未出现新的 `B-*` 平台缺陷编号。

| 变化项 | 状态 | 判定与处置 |
|---|---|---|
| **仪器轴与退出码纪律** | no platform change | 属验证证据的可复算纪律；平台无代码载体可改。 |
| **令牌/清关时点与关系型读数** | no platform change | 描述产品会话中的平台行为和使用纪律，未形成新的平台缺陷或修复要求。 |
| **谓词归位、范围外主张、spill 成因** | no platform change | 均属 RustMc 产品验证与归因纪律，不修改产品仓。 |

### 第五十轮验证

- 未修改平台代码，未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；DSH PID `124592` / 端口 `40123` 保持。
- 未运行新的平台测试；沿用第四十八轮 `168/168` 聚焦、`488/487/0/1` 全量回归和 `5/5` 语法检查证据。

## 第五十一轮修复（2026-09-29 · B-187、B-190、B-192；B-191 保留 partial）

- 输入清单指纹（开始与交付前重读一致）：size `795040`，SHA256 `ADA67478283B40F1408F20F7730D6C9438F1DAC8B78A5F0F920BB08625B96A9C`，mtime `2026-09-29T09:05:26.9477644Z`。本轮变化覆盖批次 58-61；新增平台缺陷编号为 B-187、B-190，B-191 仍为候选，B-192 为观察级消费方陷阱，B-189 已由清单自身撤回。`WORKAROUND-REVERT.md` 无新增回退条目。
- 备份：`D:\dsh-test\backups\platform-defects-batch61-20260929-172849`，包含修改前的四份 profile 三个目标文件、旧台账与旧 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `18972` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-187** | fixed, focused-verified; live pending | `team-tools-v2-r10.mjs` 新增 `completionPhaseVerdict()`：`execution` 完成仍推进到 `member-check`，`integration-ready` 可直接完成且保留相位，不再要求 owner 回退相位。global/group 两条 complete 后处理路径均使用同一判定。 |
| **B-190** | fixed, focused-verified; live pending | `team-v14-waiting.mjs` 将 approval 等待分为三类：`requestId` 绑定 privilege request、显式 `planId` 或真正 legacy 裸 approval 绑定计划、以及带 `object/detail/note/target` 但不绑定可机检对象的 opaque approval。只有前两类可由对应事件自动解除；opaque approval 不再被无关 `plan-approved` 清掉，必须显式 resolve。 |
| **B-191** | partial, no platform change | 候选成立：tier 1/2 在无租约时无法自行构造“租约前脏状态”，而 acquire 会消耗该窗口。三种建议都涉及放宽写门或拆分 acquire 语义，安全/状态机影响超出本轮；保留 tier 0 造夹具、被门者 acquire + 观测的既有规避，并明确不是死锁。 |
| **B-192** | fixed, focused-verified | `team-worktree.mjs` 的 `preservedTrackedUnstaged` 改为返回原始 porcelain 行，保留 `" M <path>"` 的前导空格；消费方不再需要猜测或 `TrimStart` 后才能与 `git status --porcelain` 精确比较。 |
| **B-189 撤回 / 其余批次 58-61 纪律** | no platform change | B-189 已由清单撤回为“进程跨程序存活、句柄按程序隔离”的操作事实；其余为审计、验证、里程碑和可观测门纪律，无新增平台代码载体。 |

### 第五十一轮验证

- 原始反例先红：新增 `platform-defects-twenty-ninth-pass.test.mjs` 在修复前为 `0/3`；分别复现 B-187 `complete-phase` 拒绝、B-190 opaque approval 被 plan-approved 清掉、B-192 `M local.txt` 丢失前导空格。
- 修复后新测试 `3/3` 通过；相邻回归 B-155/B-174/B-186 加新测试合计 `55/55` 通过。
- 全量 platform-defects 聚焦集：`171 tests / 171 pass / 0 fail`。
- 全量 phase1-phase11 串行：`491 tests / 490 pass / 0 fail / 1 skipped`；日志：`D:\dsh-test\output\platform-defects-batch61-full-phase1-phase11-20260929.log`，SHA256 `406FA75A62F0853EF364CDA65FD68336F1CCAEFB87EB771D51FEC89D182FB4C6`。
- 四份 profile 三个目标文件与新测试 `node --check`：`13/13` 通过；`v14-profile-parity.test.mjs`：`1/1` 通过；web/headless/desktop/teamtest 哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`；`session_projcache` 的 `inbox.next-turn` 在 `seq 55026` 含逐字正文，发送 requestId `b5753c16-1984-44d5-a243-e7219c8dfed4`。发送时 root 的 `turn 367` 仍为 open，故记录为已入队，不冒充 assistant ack。

| 文件 | SHA256 |
|---|---|
| `team-v14-waiting.mjs` | `D3021162B321299ABD3AC23CD5D0F56104D201E07E86FE7078B4A7E3862CAAA0` |
| `team-tools-v2-r10.mjs` | `CD0C99C1CBD57B335850A804492CDC93427F29D6015688867B784CA87CCDD3B5` |
| `team-worktree.mjs` | `29C8692DBBB3187A1A530C105B032E1D13542DF8EFF6AF20594C2AB625E80837` |

### 第五十一轮未闭合

- B-187、B-190、B-192 已同步四份 profile 并通过隔离聚焦与全量回归，但当前 DSH PID `18972` 的启动时间早于本轮修改；不重启进程，三项 live 行为均记为 live pending。
- B-191 没有平台代码修改；后续若需无租约测试夹具通道，应单独设计具名范围、清理责任与审计证据，不从本轮顺带放宽写门。

## 第五十二轮清单复核（2026-09-29 · 无新增平台代码修改）

- 输入清单指纹：size `799801`，SHA256 `F29512F2206D486E2EB4F022371FE6C44492A7072B1E4EBCFC2B60FAD1EF2729`，mtime `2026-09-29T10:09:04.2385988Z`。
- 变更提交：`d2c03b3d19ea253d449fe9cda08726057cfc62b0`，相对上一版仅追加 34 行，内容为批次 62 的 㞃 纪律、平台批次 61 修复结果转录和“判活要挑对载体”观察。
- 完整对照结果：本轮未新增或修改任何 `B-*` 平台缺陷；新增文本引用的 B-187 / B-190 / B-192 均已在第五十一轮处理，B-191 仍为 partial / no platform change，B-189 已撤回。`WORKAROUND-REVERT.md` 无新增回退项。
- 处置：不重复修改四份 profile，不重复运行测试；沿用第五十一轮的 `3/3` 原始反例、`171/171` 聚焦集、`491 tests / 490 pass / 0 fail / 1 skipped` 全量回归、`13/13` 语法与 `1/1` profile parity 证据。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `18972` / 端口 `40123` 保持。
- 备份：`D:\dsh-test\backups\platform-defects-batch62-20260929-182859`，包含更新前的修复台账与 watch state。

### 第五十二轮未闭合

- 批次 62 明确要求当前进程继续按旧行为排期；B-187 / B-190 / B-192 的 live 状态仍未复核，只有进程更新后才能按原始反例转绿。

## 第五十三轮修复（2026-09-29 · B-193、B-195；B-196 observation）

- 输入清单指纹（开始与交付前重读一致）：size `825271`，SHA256 `575F357B8B7AC82DB5F57BF60D3B3E6F9437EE7729503B6F8F88441A59267A12`，mtime `2026-09-29T11:50:47.0338796Z`。变更提交 `6e4fe8b350243f2979ee8024594faea5125d37cc` 仅追加批次 63；新增 B-193、B-195，B-196 为条件特性观察，无 B-194。`WORKAROUND-REVERT.md` 无新增回退条目。
- 备份：`D:\dsh-test\backups\platform-defects-batch63-20260929-204620`，包含修改前的四份 profile 三个目标文件、旧台账与旧 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-193** | fixed, focused-verified; live pending | `team-v12-runtime.mjs` 的 `filterVisibleEvidence()` 允许 verifier/清关角色只读读取 `landing-token` 与 `landing-token-confirmation` evidence，使授权锚位于被清关方可核验的可见域；普通成员权限未扩大。 |
| **B-195** | fixed, focused-verified; live pending | `team-tools-v2-r10.mjs` 新增 `leaseReleaseStateVerdict()`：显式 `run_id` release 先判租约状态，过期时返回 `[lease-expired]` 和 ISO 时间，不再误报 `[lease-release-order]`。`write-scope-guard.mjs` 不再把过期 active lease 当作 plan scope，并在拒绝文本中给出 `active lease: none` 或 `expired at <ISO>`。 |
| **B-196** | observation / no platform change | 清单已把无接续器时长任务的分段停顿标为“条件特性未启用 + 成本”，不是已确认平台缺陷；本轮不把未启用写成 fixed。若接续器启用后仍每段停住，再升级为缺陷。 |

### 第五十三轮验证

- 原始反例先红：新增 `platform-defects-thirtieth-pass.test.mjs` 在修复前为 `0/3`；修复后为 `3/3`，覆盖 B-193 授权锚可见且不扩大普通成员权限、B-195 过期 release 诊断、B-195 写门 lease 诊断。
- 聚焦组合 `22/22`；全量 platform-defects 聚焦集 `174/174`。日志：`D:\dsh-test\output\platform-defects-batch63-focused-20260929.log`、`D:\dsh-test\output\platform-defects-batch63-focused-platform-tests-20260929.log`。
- 全量 phase1-phase11 串行：`494 tests / 493 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志：`D:\dsh-test\output\platform-defects-batch63-full-phase1-phase11-force-exit-20260929.log`，SHA256 `7E40F682B71DE7FF502B3A5252211F6424DD5D400ED793E3507DC9630368FF17`。
- `v14-startup-arming.test.mjs` 隔离断言 `8/8` 通过；其 Node test worker 在无 `--test-force-exit` 时于断言完成后不退出，因此全量命令使用 `--test-force-exit`，但未跳过任何测试项。
- 四份 profile 三个目标文件与新测试 `node --check`：`13/13` 通过；web/headless/desktop/teamtest 的目标文件哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`，requestId `55b914ba-647b-4ec6-ab30-347bba7d919a`；session v4 中 `agent/inbox/spliced` 为 `seq 56179`，`user/message` 为 `seq 56234`，正文与发送文件逐字一致，SHA256 均为 `318A6587B69683EC551936389A12171365BA1C636FBAB78C4C2A794C10C3ADA1`。发送时 root 的 `turn 382` 仍为 open，故记录为已入队，不冒充 assistant ack。

| 文件 | SHA256 |
|---|---|
| `team-v12-runtime.mjs` | `1857845CDC59A6A60E055616CF43D829EB8ADB89A7D6EF8A9DA7AA3097E6C11C` |
| `team-tools-v2-r10.mjs` | `381C9745B97117F0AC9FB241666EFBC36C1B079E6715215B73B3A691CBAB6D82` |
| `write-scope-guard.mjs` | `2987ACCFF01A10C1BCA2A04CA835EF7D23CD181452449A51E3216D65E519DAF9` |
| `platform-defects-thirtieth-pass.test.mjs` | `1BAE6C2B506B5FA87FCA70AD1E776992C9C40C13BF7CF88207A9A464A3F8B73E` |

### 第五十三轮未闭合

- B-193 与 B-195 已同步四份 profile 并通过隔离聚焦与全量回归，但当前 DSH PID `30948` 的启动时间早于本轮修改；不重启进程，两项 live 行为均记为 live pending。
- B-196 没有平台代码修改；只有在接续器实际启用且原始分段停顿仍复现时，才按新缺陷重新进入修复。

## 第五十四轮修复（2026-09-30 · B-198、B-199、B-200、B-202；B-197/B-201 no platform change）

- 输入清单指纹（开始与交付前重读一致）：size `870676`，SHA256 `D4899E17F17024CDD3C8FD6DF4E697879BACC8EAFF1D0559F46C5DCC518F6A52`，mtime `2026-09-29T15:36:44.5361825Z`。变更提交 `772a85eadf6641879edcf8cd20e7c2e455eaf454` 新增 `docs/HEAVY-SLOT.md` 与批次 65；完整对照后，B-198、B-199、B-200、B-202 进入修复，B-197 仅为历史族引用，B-201 原文已撤回假说。`WORKAROUND-REVERT.md` 对 B-197..B-202 无新增回退条目。
- 备份：`D:\dsh-test\backups\platform-defects-batch65-20260930-003432`，包含修改前的 `dsh-jobs-local` 文件、四份 profile 的 `team-tools-v2-r10.mjs`、旧台账与旧 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-198** | fixed, focused-verified; live pending | 原清单把首个失败调用写成 `job_list`；一手源码与复现表明 `job_list()` 只读，真正失败是新宿主首条前台 `pwsh` 作业收尾时 `remove("pwsh-1")` 先命中旧宿主的 recovered `pwsh-1`。`LocalJobRegistry.start()` 现在递增计数器直到 ID 同时不在 recovered 与 live store 中，因此新宿主首条 pwsh 为 `pwsh-2`，保留跨宿主 recovered 记录。 |
| **B-199** | fixed, focused-verified; live pending | `team_plan_approve` 的输出 schema 与返回值新增 `changed`、`deduplicated`：真实批准为 `changed:true / deduplicated:false`，已批准计划的幂等命中为 `changed:false / deduplicated:true`，不再用同一形状冒充“事件发生”。 |
| **B-200** | fixed, focused-verified; live pending | `blockedLeaseReleaseVerdict()` 的拒绝文本现在回显 task id、当前 `task.blockedBy`、匹配开放等待票数、具名与未具名开放票数、缺少的字段，并给出 `team_task_update(action:"set_dependencies", blocked_by:["<task-id>"])` 后再重试 release 的可执行路径。 |
| **B-202** | fixed, focused-verified; live pending | `complete` 未携带 `evidence_ids` 时，拒绝文本现在明确说明“本次调用未包含该入参”，并回显该任务已有 evidence 数量与 id；不再把“调用形态缺失”误报成“没有记录 evidence”。 |
| **B-197** | no platform change | `PLATFORM-DEFECTS.md` 没有独立 B-197 条目；只在 `HEAVY-SLOT.md` 中作为 B-193 / B-197 一族的历史引用，本轮不虚构缺陷载体。 |
| **B-201** | withdrawn / observation | 清单原文已用 detached 重跑否证“会话接续杀死在飞作业驱动进程”的假说，真死因是 `C10_citation_anchor_guard` fail-fast；无独立平台代码修改。 |

### 第五十四轮验证

- 原始反例先红：新增 `platform-defects-thirty-first-pass.test.mjs` 在修复前为 `0/4`；分别复现 recovered/live `pwsh-1` 冲突、批准结果无变化位、blocked 拒绝无逐项读数、complete 拒绝误述前置条件。修复后同一测试为 `4/4`。
- 全量 platform-defects 聚焦集：`178 tests / 178 pass / 0 fail`。
- 全量 phase1-phase11 串行：`498 tests / 497 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志：`D:\dsh-test\output\platform-defects-batch65-full-phase1-phase11-20260930.log`，SHA256 `B31E244A1F953068D94D6D0C371F0C618E75AB68DF443033025FD5057F651E38`。
- 六份相关源码/测试 `node --check` 通过；`v14-profile-parity.test.mjs` 为 `1/1`；web/headless/desktop/teamtest 的 `team-tools-v2-r10.mjs` 哈希逐项一致。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：首版说明 RPC `HTTP 200 / ok=true / accepted=true`，session v4 中 `agent/inbox/spliced` 为 `seq 57100`、`user/message` 为 `seq 57104`。随后发现首版文件里的 job 文件哈希只截取了前半段，已修正并重发；修正版 RPC requestId `e260ade5-5007-4a21-bca2-0bc396769323`，`agent/inbox/spliced` 为 `seq 57133`，surface `user/message` 为 `seq 57140`，正文与发送文件逐字一致，SHA256 均为 `CCF31E6F87644126BD801330A1CE1E69937DB53BA0FB157DA02872992552EE95`。

| 文件 | SHA256 |
|---|---|
| `team-tools-v2-r10.mjs`（四 profile 相同） | `B17E0573ACA0A63128875724173AA80FF2E2793F5746A99125F9409C6676CFAB` |
| `dsh-jobs-local/lib/index.js` | `4C4BDE29FC5B041CDADC6C8C08146DD0EA494F579504CC6E0B97670DC368F137` |
| `platform-defects-thirty-first-pass.test.mjs` | `F984FFB295048804060E61399F4952DD919D2633FEC3CE9F499709DBA42B8A11` |

### 第五十四轮未闭合

- 四项修复已同步四份 profile 并通过聚焦与全量回归，但当前 DSH PID `30948` 早于本轮修改；不重启进程，四项 live 行为均记为 live pending。
- 修正版 root 说明已进入 next-turn inbox，并成为 surface `user/message`；首版已送达但哈希截断，后续以修正版 `seq 57133` / `57140` 为准。

## 第五十五轮修复（2026-09-30 · B-197、B-203；B-196/B-201 无平台修改）

- 输入清单指纹（开始）：size `880736`，SHA256 `814A72FD6D10B7D6B498D8A8A80AE049C969B981F0334F3A73D818B04A5B9A5A`，mtime `2026-09-29T16:56:25.8040851Z`。修复期间同一产品仓又落地批次 67，当前清单已变为 size `886163`、SHA256 `F5077E5ACA544D69E49E3622B02CDD68C67EDD7B1A1E9977C1D037D2182C0590`；批次 67 另立下一轮，不混入本轮修复声明。
- 备份：`D:\dsh-test\backups\platform-defects-batch66-20260930-011800`，包含四份修改前 runtime、`dsh-jobs-local`、旧台账、旧 watch state、`PLATFORM-DEFECTS.md` 与 `WORKAROUND-REVERT.md`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-197** | fixed, focused-verified; live pending | `team_v12(action:"leases")` 现在允许 tier 1 组长通过 `policy.canInterrupt(mine.name, targetMember)` 读取本组成员租约；tier 2 仍只能读自己，跨组仍拒绝。嵌套 `input.member` 与顶层 `member` 两种调用形态均覆盖，越权负控仍返回 `lease-read-scope`。 |
| **B-203** | same root as B-198; exact regression added; live pending | 新增精确原始反例：预置 recovered `pwsh-153`、将 live counter 置于 `152`，修复后新作业必须为 `pwsh-154` 且 `exact-output` 可读。旧批次 65 备份模块实测仍取 `pwsh-153`、输出为空；当前模块为 `pwsh-154`、输出完整。无需第二套 source 修复。 |
| **B-196** | observation / no platform change | 清单仍把无接续器分段停顿列为未启用条件特性与成本，不冒充 fixed。 |
| **B-201** | withdrawn / no platform change | 原假说已由 detached 重跑否证；无独立平台代码修改。 |
| **哈希不一致** | resolved as transcription error | 当前权威 `dsh-jobs-local/lib/index.js` SHA256 为 `4C4BDE29FC5B041CDADC6C8C08146DD0EA494F579504CC6E0B97670DC368F137`；没有证据支持“同一输入流水线不确定”。 |

### 第五十五轮验证

- 原始反例先红：`platform-defects-thirty-second-pass.test.mjs` 修复前 `1/2`；B-197 以 `lease-read-scope: only tier 0 may inspect another member's run leases` 失败。旧模块的 B-203 精确探针实测返回 `id=pwsh-153`、`chunks=""`、`status=completed`，证明 recovered 记录遮住 live 输出。
- 修复后同一 focused 文件 `2/2` 通过；日志 `D:\dsh-test\output\platform-defects-batch66-focused-20260930.log`。
- 全量 platform-defects 聚焦集：`180 tests / 180 pass / 0 fail`；日志 `D:\dsh-test\output\platform-defects-batch66-focused-platform-tests-20260930.log`，SHA256 `77A00D77269B4113D39214BCB8252C34C6A64E9EEDDB021A243CE1FCB23EFADD`。
- 全量 phase1-phase11 串行：`500 tests / 499 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch66-full-phase1-phase11-20260930.log`，SHA256 `1A2FE9F884AC4749B1CF83C6805375F3D0C8BED5897AD534B853E87F4B6B7C37`。
- 五份源码/测试 `node --check` 通过；`v14-profile-parity.test.mjs` 为 `1/1`；web/headless/desktop/teamtest 的 `team-v12-runtime.mjs` 均为 size `145499`、SHA256 `80D6C50E02F383EF30F3925231FEA113C5587F927EFE4C71A17FD70B6E2CD4DA`。
- DSH root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191` 已接收修复说明：RPC 回执 `HTTP 200 / ok=true / accepted=true`，requestId `d6d76f57-66fe-4450-baf6-b1f9f5a52804`；session v4 中 `agent/inbox/spliced` 为 `seq 57779`，surface `user/message` 为 `seq 57785`，正文与发送文件逐字一致，SHA256 均为 `22E45324840344121C0F117D3F421BB09603B3B7FDE9C8D2A9EBBB07B9327B82`。该消息在 turn 404 被读取，并产生了对应处理回复；本轮记录为已送达且已被 root 处理。

| 文件 | SHA256 |
|---|---|
| `team-v12-runtime.mjs`（四 profile 相同） | `80D6C50E02F383EF30F3925231FEA113C5587F927EFE4C71A17FD70B6E2CD4DA` |
| `platform-defects-thirty-second-pass.test.mjs` | `9DCE6C6148ECDC4A0488D39F68822545D51C41862366522E4A263EA5993D5463` |

### 第五十五轮未闭合

- B-197 与 B-203 均已同步四份 profile 并通过聚焦与全量回归，但当前 DSH PID `30948` 早于本轮修改；不重启进程，两项 live 行为均记为 live pending。

## 第五十六轮修复（2026-09-30 · B-204..B-215）

- 输入清单指纹（开始）：size `880736`，SHA256 `814A72FD6D10B7D6B498D8A8A80AE049C969B981F0334F3A73D818B04A5B9A5A`，mtime `2026-09-29T16:56:25.8040851Z`。交付前重读时清单已推进到批次 103：size `1032156`，SHA256 `1721BE1C8911181D3D871CEA5D20F5B9BBC2A1AF694FD02D3CE5D5BD9E064969`，mtime `2026-09-29T18:39:39.1785435Z`。批次 67–103 均逐项对照；`WORKAROUND-REVERT.md` 无新增回退条目，SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-batch67-70-20260930-015340`、`D:\dsh-test\backups\platform-defects-batch67-70-plus-20260930-20260930-021254`、`D:\dsh-test\backups\platform-defects-batch67-96-20260930-023455`。最后一组包含修改前四份 profile、guard、新测试、台账、watch state 与两份清单。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-207** | fixed, focused-verified; live pending | `dependencySatisfied()` 支持 `dependency_phase:"completed"`：默认仍按 `accepted`，显式 completed 仅按内容完成放行。`team_task_create` / `team_task_update(set_dependencies)` 持久化该字段，任务投影返回 `dependencyPhase`；不会为了解门伪造接受相位。 |
| **B-210** | fixed, focused-verified; live pending | 全部冲突均为 `sameOwner:true` 的计划提案返回 `ok=true / code="same-owner-plan"`；其它 owner 的冲突仍 fail-closed，执行/租约门未放宽。 |
| **B-213** | fixed, focused-verified; live pending | `write-scope-guard.mjs` 不再把 `Join-Path`、`(Get-Process)` 等 RHS 命令名当路径；`Join-Path` 的相对/绝对左值可正确解析，未知动态目标仍 fail-closed。 |
| **B-213b** | fixed, focused-verified; live pending | `& $var` 动态调用被识别为 opaque 并拒绝，堵住写域守卫的 fail-open 绕过；没有授权或实施任何越界写入。 |
| **B-215** | fixed by existing worktree-carrier path; exact regression added; live pending | 新增原始反例：会话 cwd 指向仓根、活动计划 scope 为仓内相对路径、成员绑定工作树时，写工作树内目标通过，写会话仓根同路径返回 `FS_WRITE_OUT_OF_SCOPE / worktree-carrier-mismatch`。当前源码已具备该行为；live 仍受 PID `30948` 未重载旧模块影响，不能用 (a1) 工作树相对 scope 冒充 source fix。 |
| **B-204** | observation / no platform change | 证据行可见性继续按 `(读者角色 × 目标任务)` 分叉；B-144/B-193 已明确 declared-scope 语义，本轮未扩大权限。 |
| **B-205** | covered by B-199; no additional platform change | `team_plan_approve` 已返回 `changed` / `deduplicated`，可区分真批准与幂等命中；独立复现已并入该回归。 |
| **B-206** | no platform change | 自指污染来自工具调用包装链；平台侧已有祖先闭包纪律，本轮不新增代码载体。 |
| **B-208** | no platform change | stale clearance 已正确拒绝并打印 `expectedCommit` / `foundKey`，B-159 已覆盖；LCA 增强仍为后续观察项。 |
| **B-209** | no platform change | `2324/37` 属 RustMc C10 设备/内容捕获问题，继续按 t106 判别，不改平台。 |
| **B-211** | observation / no platform change | 失败样本缺 HEAD/诊断字段属于 harness 记录纪律；平台未新增代码修改。 |
| **B-212** | no platform change | 多条裁决未显式作废属文档/执行纪律，本轮不引入平台状态机。 |
| **B-214** | partial / no platform change | 目录前缀粒度仍会拒绝同目录下文件互不相交的卡。安全的文件集求交需要计划提供可验证的 `resourceScan`/文件集合；当前仅有目录 scope 时放宽会 fail-open，因此本轮不实现，明确保留 partial。 |
| **B-196 / B-198 / B-201 / B-203** | no additional source change | B-196 仍为未启用特性观察；B-201 已撤回；B-198/B-203 的批次 86/88 复现来自未重载的旧进程，当前 source 修复仍为 live pending。 |

### 第五十六轮验证

- 原始反例：`platform-defects-thirty-third-pass.test.mjs` 覆盖 B-207/B-210，`platform-defects-thirty-fourth-pass.test.mjs` 覆盖 B-213/B-213b/B-215；后者修复后 `5/5`。
- 全量 platform-defects 聚焦集：`188 tests / 188 pass / 0 fail`，`EXIT_CODE=0`；日志：`D:\dsh-test\output\platform-defects-batch67-100-focused-platform-tests-20260930.log`，SHA256 `6B758A5B88A1EFCC3B0090B8F539F165242B569126885E2C1B62FE46DF73BFD9`。
- 全量 phase1-phase11 串行：`508 tests / 507 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志：`D:\dsh-test\output\platform-defects-batch67-100-full-phase1-phase11-serial-20260930.log`，SHA256 `184816D93AF58ADD11BA8490A28B45A0BF514D9C6F4B4A11C21F9A391B7A27C9`。
- 并行启动同一全量集合时，`phase4-tests\team-operator.test.mjs` 发生一次 110 秒 worker 超时；随后以 `--test-concurrency=1` 串行重跑，全部断言通过，故该项按测试驱动并发问题记录，不作为产品回归失败。
- 相关 profile 源码与新测试 `node --check`：`8/8` 通过；`v14-profile-parity.test.mjs`：`1/1`，日志 SHA256 `0C61FB811599FB67DED42668B3EDEC4EB6199688B3AC7A5FA93D96306ED5F764`；web/headless/desktop/teamtest 的 `team-control-plane.mjs`、`team-tools-v2-r10.mjs`、`write-scope-guard.mjs` 哈希逐项一致。

| 文件 | SHA256 |
|---|---|
| `team-control-plane.mjs`（四 profile 相同） | `B7C47913237B839F9AF9258F56B44733F3350DB7E68CB715375B5D36598A4937` |
| `team-tools-v2-r10.mjs`（四 profile 相同） | `8A3BF24BDA8CF8A6C7B6B457996AA125F6AA097D724150670A259D08406B12CF` |
| `write-scope-guard.mjs`（四 profile 相同） | `C13E229A127E698B8674F4C882C6BADF974DC21238696341EC62B0BCA1B25DE8` |
| `platform-defects-thirty-third-pass.test.mjs` | `1CE2F0E4AF2E2CABFF8D7BDA9387439D31386404A7C835C018B999B70121643C` |
| `platform-defects-thirty-fourth-pass.test.mjs` | `A515AD747EDB857492C31C32E8FDF08A67B92B92ED2F6485DB2CBD6D59843EA1` |

### 第五十六轮补充对照（批次 104–105）

- 交付前重读发现 `PLATFORM-DEFECTS.md` 已推进到批次 105：size `1041101`，SHA256 `E9DAF1769D02CF28D666DA2D34C1B6C3A4E5BDB08549B737EA2C148BB4CFF890`，mtime `2026-09-29T18:43:42.8908941Z`。新增内容仅为 RustMc C10 假红的机制定案、干预实验和产品仓 guard 修复卡；没有新增 B 编号，也没有新的 DSH 平台缺陷或本轮平台代码变更。
- B-209 补充状态：C10 `2324/37` 已由批次 104/105 定位为“具名 stdout 使控制台按 GBK 解码、吞掉 UTF-8 后的 LF”；修复点是在捕获前钉 UTF-8，已由产品线 owner `rig-diff` 在 `tools/rig-batch/tests/` scope 内建卡。该修复不属于 DSH profile 平台面，本轮不越界修改 RustMc 产品仓，也不把该产品修复写成平台已 live。
- 批次 105 明确模式 A（计数正确但 `CLASS_anchor_missing=2`）仍未闭合；不得并入模式 B 的 GBK 机制，保留为产品线残余风险。`WORKAROUND-REVERT.md` 仍无对应新回退条目。

### 第五十六轮补充更正（批次 106–111）

- 最终清单指纹：size `1059574`，SHA256 `86F283C54DBAC74699BF1DF172ED0B533190AF9CCB6FCC37CCA50DA57525077B`，mtime `2026-09-29T18:55:31.3063710Z`。批次 106–111 逐项对照后，没有新增 DSH 平台缺陷，也没有新的平台源码修改；批次 110/111 记录的是 `write_scopes` 计划锁定、拒绝原子性和 RustMc C10 仪器收口等平台设计事实。
- **B-215 全面撤回，覆盖上一补充中的 fixed 声明**：批次 106 发现 anvil 使用的成员工作树路径少了 `world-`，批次 108 又确认拒绝串中的路径只反映当时进程的 cwd；两条根因证据均不成立。此前新增的 B-215 回归测试已删除，避免把撤回假说固化为平台契约；`write-scope-guard.mjs` 从未因 B-215 改动，故无产品源码回滚。
- B-207、B-210、B-213、B-213b 的 source fixed / live pending 结论不变；B-204、B-206、B-208、B-209、B-211、B-212 仍按 observation/covered/no-platform-change，B-214 仍为 partial。

### 第五十六轮补充验证（删除撤回的 B-215 测试后）

- 相关源码/测试 `node --check`：`4/4` 通过。
- platform-defects 聚焦集：`187 tests / 187 pass / 0 fail / 0 skipped`；日志 `D:\dsh-test\output\platform-defects-batch67-111-focused-platform-tests-20260930.log`，SHA256 `C09C0BFCAE359D7EA86B8263332FB6A7DB79704EBFC563D47FEE989146C3C5F6`。
- phase1–phase11 串行：`507 tests / 506 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch67-111-full-phase1-phase11-serial-20260930.log`，SHA256 `11F7A80F4CC5AF1A3DC6C4DE25230895F326E84319539D40932C3E2DC91D00DF`。
- profile parity：`1/1`；日志 SHA256 `DF4F640925CF2BE159DA8B34E19B1E9508838E131E0A95C10A909A3B3CA18B7A`。
- root 首份说明已入 next-turn inbox；发现 B-215 撤回后另发更正说明，明确 supersede 首份中的 B-215 fixed 段落。

### 第五十六轮未闭合

- 当前 DSH PID `30948` 早于本轮源码修改，B-207/B-210/B-213/B-213b 均不写成 live verified；B-215 已撤回，不进入 live 验证队列。不重启进程。
- B-214 仍为 partial：只有显式文件集可安全求交；目录 scope 与文件 scope 的关系不能在不知道目录实际文件集时放宽。
- B-209 仍是 RustMc C10 的确定性红复现问题，属于产品/设备验证线，不通过平台改动掩盖。

## 第五十七轮修复（2026-09-30 · B-213b 白名单推广；批次 112–122）

- 输入清单指纹：size `1088751`，SHA256 `58CE0C8289F3890B3F98A5EFFF524580EA8958A5C06BF5344D2B328704339466`，mtime `2026-09-29T19:05:10.4723288Z`。批次 112–122 完整对照；新增平台修复项只有批次 114/117 对 B-213b 的推广，其余为平台事实、纪律、RustMc 交付和在飞状态，没有新的独立平台缺陷。
- 备份：`D:\dsh-test\backups\platform-defects-batch112-118-20260930-032000`，包含修改前 guard、撤回测试后的新测试、台账、watch state 与当前清单。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-213b（推广）** | fixed, focused-verified; live pending | `write-scope-guard.mjs` 现在对命令位上的未知 Verb-Noun cmdlet，在参数流含 `-Path/-LiteralPath/-FilePath/-Destination/-NewName` 时判 `opaque:true`，按 fail-closed 拒绝；已知只读 cmdlet（如 `Test-Path`）与 `Join-Path` 保持放行。`Start-Process -FilePath`、`Set-Acl -Path` 的原始反例均从放行改为 opaque。 |
| **B-213** | fixed, focused-verified; live pending | `Join-Path` 路径解析与表达式标点过滤保持原修法，未被未知命令门误伤。 |
| **B-215** | withdrawn / no platform change | 批次 115/116 确认守卫对正确路径的拒绝是真阳性；批次 116 将真实 operator 问题限定为“部分成员会话 cwd 是仓根”，不是 scope 归一化平台缺陷。此前新增的 B-215 测试保持删除，不再进入修复队列。 |
| **B-207 / B-210** | fixed, focused-verified; live pending | 原实现不变，批次 112–122 未提出反例或回退要求。 |
| **B-204 / B-206 / B-208 / B-209 / B-211 / B-212 / B-214** | no new platform change | 继续按 observation/covered/no-platform-change/partial 记录；B-206 的祖先闭包结论得到第二个独立实例支持。 |

### 第五十七轮验证

- 原始反例：`platform-defects-thirty-fourth-pass.test.mjs` 中 B-213b 未知命令项先红后绿；修复后该文件 `6/6`。新增负控同时证明 `Test-Path -LiteralPath` 不会被未知命令门误判为 opaque；worktree carrier 回归继续证明 tier-1 写目标必须位于成员工作树。
- 相关源码/测试 `node --check`：`4/4` 通过。
- 全量 platform-defects 聚焦集：`189 tests / 189 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch112-123-focused-platform-tests-20260930.log`，SHA256 `63A69E92130C18B9AA775C53FEAC5656A8279778EAEFA52B1E54C51134590B77`。
- 全量 phase1–phase11 串行：`509 tests / 508 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch112-123-full-phase1-phase11-serial-20260930.log`，SHA256 `7E1AE436A1056DCF0D98284A21960106F4649DD2BEC618D3427ABE5F46B24D17`。
- profile parity：`1/1`；日志 SHA256 `0193E4484C89450A730F43AF54DF5F3C8BF716326A598BAA2AE50A17153FCD4A`。
- web/headless/desktop/teamtest 的 `write-scope-guard.mjs` 均为 size `52288`、SHA256 `30E8740E88F787C283CC184C01F3BBF967D39746734E3368CF5772CF64E6A48F`；`platform-defects-thirty-fourth-pass.test.mjs` 为 size `4528`、SHA256 `868C988B1C8555207102E4A66DEC221636C9D45280C2194BA6F50EC0A74EB563`。

### 第五十七轮 root 说明

- 首份批次 67–105 说明已进入 root next-turn inbox：`agent/inbox/spliced` seq `58967`，文件 SHA256 `36482318207A0529C5B74A837260CEC507EDFE72B55BBC45C9333AB191AF2586`。
- B-215 更正说明已进入 root next-turn inbox：`agent/inbox/spliced` seq `59192`，文件 SHA256 `C8AF6EF8AEDA1EE296A245C92164B349DEC5E7BC8E001C17DF4D035A4693918B`；因 root turn 411 仍在执行，当时尚未出现 surface `user/message`，按已入队记录，不冒充 assistant ack。
- B-213b 推广的第三份说明已进入 root next-turn inbox：`agent/inbox/spliced` seq `59420`，文件 SHA256 `1576402B6B943ADF10C66241BDEBA5DB2662D6C59528F678784E565CD793433A`。最终重读仍为该说明所写指纹，未出现新批次。
- 最终状态写入前清单又前进一步：commit `7bd7775` 后追加批次 123–124（修正类型名、清掉 `citation_integrity` baseline 红、C10 修复合入 `main=81153825`，并确认 worktree carrier source fixed/live pending）。最终指纹为 size `1096980`，SHA256 `FE2BCAA5105EA8C20427907BCEBA4C90D1EE4B94FA491870B403BBEA3AEDAB54`，mtime `2026-09-29T19:15:37.0874751Z`；没有新增 DSH profile 平台缺陷或改变本轮 B-213b 结论，watch state 以该指纹收口。
- 最终指纹说明已进入 root next-turn inbox：`agent/inbox/spliced` seq `59489`，requestId `935e5822-1b00-421a-b1e3-9e6ba9b7565d`，文件 SHA256 `5511290955019B2F32A3E4276C1256FFB5AC3A480547BB02BFD0791E7E453A06`。root turn 411 尚未结束，因此按已入队记录，不冒充 surface `user/message` 或 assistant ack。
- 批次 123–124 后的最终指纹更新已进入 root next-turn inbox：`agent/inbox/spliced` seq `59627`，requestId `db2e0080-3731-4bb3-9d39-1b71dcf4f462`，文件 SHA256 `E5BC6BEB152E1780B2AFD28C50FE84068CE8DCC3F81D2B4D9628B9C51D3119F6`；仍按 next-turn 入队记录。

### 第五十七轮补充对照（批次 125）

- 交付前重读清单已推进到批次 125：size `1101522`，SHA256 `CE132C2E1E5CF9D59709D18D7BA0EA63055DAB787FA352260F64996392DA4102`，mtime `2026-09-29T19:17:26.3429996Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`，无新增回退项。
- 平台确认 B-215 全面撤回，并删除其先前自加的回归测试；`write-scope-guard.mjs` 没有因 B-215 修改，因此无对应源码回滚。此项继续记为 withdrawn，不再进入平台修复或 live 验证队列。
- `worktreeCarrierVerdict` 是独立平台约束：tier-1/2 写载体必须位于活动计划绑定的成员工作树，任务无绑定工作树时返回 `worktree-binding-missing`，载体不匹配时返回 `worktree-carrier-mismatch`；这不是 B-215 的归因。它仍为 source present / live pending，当前 DSH PID `30948` 早于对应源码。
- 批次 125 没有新增 DSH profile 缺陷或源码修改。B-207/B-210/B-213/B-213b 保持 fixed、focused-verified、live pending；B-214 保持 partial；B-204/B-206/B-208/B-209/B-211/B-212 继续为 observation/covered/no-platform-change。
- 本轮没有再次修改 profile 或测试；沿用批次 112–123 已完成的证据：`node --check` `4/4`，专项 `6/6`，platform-defects 聚焦 `189/189`，phase1–phase11 串行 `509 tests / 508 pass / 0 fail / 1 skipped`，profile parity `1/1`，四份 guard 哈希一致。
- 批次 125 root 说明已进入 next-turn inbox：`agent/inbox/spliced` seq `59687`，文件 SHA256 `050B0F85539CE27ACC6CB260DDC90FDD0B2BD0B9486C7C4A939494A642CBB9ED`；按入队记录，不冒充 surface `user/message` 或 assistant ack。

### 第五十七轮补充对照（批次 126–127）

- 最终重读清单指纹：size `1106654`，SHA256 `9249C043029C90D95761F4A3FF65F1FD7A98F430A61AB283946C8A1DA60EEA89`，mtime `2026-09-29T19:19:42.8188083Z`。`WORKAROUND-REVERT.md` 仍无变化。
- 批次 126 的 `message-scope` 拒绝是平台既有且正确的 tier 2 → tier 0 禁止规则；被认领的是协议设计错，不是新的平台缺陷。占槽声明改为 `tier 2 -> lead -> tier 0` 的中转路径，无需修改 DSH profile。
- 批次 127 的 `review` 卡无写面导致 `t111` 不可执行，是卡种与工作形状错配；相关 `B-214` 目录 scope 限制仍为 partial，没有新增平台源码修改。新 `edit` 卡只属于 RustMc 团队排程。
- 两批均没有新增 `B-*` 平台缺陷；B-207/B-210/B-213/B-213b、B-214 及 observation/covered 项的状态不变。重读后四份 `write-scope-guard.mjs` `node --check` 仍为 `4/4` 通过。
- 批次 126–127 root 说明已进入 next-turn inbox：`agent/inbox/spliced` seq `59718`，文件 SHA256 `F0532A05B5F5CDCEF0BAE3B50ED0A0CB048031996E977DB05B09E089F232D310`；按入队记录，不冒充 surface `user/message` 或 assistant ack。

### 第五十七轮未闭合

- 当前 DSH PID `30948` 早于本轮源码修改，B-207/B-210/B-213/B-213b（含推广）均不写成 live verified；不重启进程。
- B-215 不再作为平台缺陷；真实剩余项是 operator 级会话 cwd 统一，需在成员会话创建/绑定层处理，不能用 DSH profile 代码代替。
- 模式 A 的 C10 计数正确但锚点缺失样本仍开放，属于 RustMc 产品验证线。

## 第五十八轮修复（2026-09-30 · B-218、B-219、B-220；批次 128–146）

- 输入清单指纹：size `1106654`，SHA256 `9249C043029C90D95761F4A3FF65F1FD7A98F430A61AB283946C8A1DA60EEA89`，mtime `2026-09-29T19:19:42.8188083Z`。交付前重读后清单指纹为 size `1189316`，SHA256 `91BA5E4D318D20BC3C7FC8736252D52476173EC2C7A6EB5AB23B99D24B930880`，mtime `2026-09-29T19:51:08.3041238Z`；批次 128–146 已逐项对照，`WORKAROUND-REVERT.md` 无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch128-146-20260930-035723`，包含修改前的四份 guard/runtime/waiting、台账、watch state 与两份清单。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-218** | fixed, focused-verified; live pending | `write-scope-guard.mjs` 现在静态解析 `pwsh/powershell -File <脚本>` 及静态 `.ps1` 调用，递归读取受跟踪脚本并提取其中的静态写目标；脚本不存在、过大、非 UTF-8、循环或无法静态解析时 opaque fail-closed。`pre-execute` 现在会在脚本写目标越过 scope 时拒绝，不再让脚本内部写对门不可见；脚本内 `git add/commit` 也纳入 lease 检查。 |
| **B-219** | fixed, focused-verified; live pending | 表达式写目标在进入路径解析前先判动态；`($env:TEMP + "\mt_proto.txt")` 等不再被解析成仓根下的假路径，而是返回 opaque、无 target，拒绝文本不再声称一个虚假的已解析路径。 |
| **B-220** | fixed, focused-verified; live pending | `waiting_set` 新增 `waitingSetTargetVerdict()`：无显式 `ticket_id` 时按 task/owner/waiter/reason/condition 选择唯一 open ticket 并更新同一 `ticketId`；多个候选则 `waiting-set-ambiguous` fail-closed，不再新增第二张旧票。 |
| **B-216** | no platform change | C10 假红是 RustMc 捕获进程控制台/编码初始化问题，属产品/设备线；DSH profile 不修改，模式 A 继续开放。 |
| **B-217** | withdrawn / no platform change | 随 B-215 撤回；根因是错误路径与 cwd 读法，不作为平台缺陷。 |
| **B-211 改述** | no platform change | 失败样本保留守卫 tail，缺的只是检出 HEAD；结论不变但理由按新表述记录，无新增平台修改。 |
| **平台建议 · 相位 / 重作业路由** | observation / no platform change | review/discussion 相位短路与平台层重作业路由仍缺可执行验收；本轮不把建议冒充已确认缺陷或已修复。 |

### 第五十八轮验证

- 原始反例：新增 `platform-defects-thirty-fifth-pass.test.mjs`，修复前 B-218 脚本写目标为空且 `opaque=false`、B-219 生成仓根假路径、B-220 生成两张 open 票；修复后专项 `6/6` 通过，覆盖静态脚本写、静态嵌套脚本、`pre-execute` 越 scope 拒绝、非 UTF-8 fail-closed、动态表达式 opaque、同 task waiting ticket upsert。
- 相关源码/测试 `node --check`：四份 profile 的 guard/runtime `8/8` 通过。
- platform-defects 聚焦集：`195 tests / 195 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志：`D:\dsh-test\output\platform-defects-batch128-146-focused-platform-tests-20260930.log`。
- phase1–phase11 串行最终回归：`515 tests / 514 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志：`D:\dsh-test\output\platform-defects-batch128-146-full-phase1-phase11-serial-20260930-final.log`。
- 首次全量串行曾在与本次改动无关的 `phase6-tests\milestone-tail-delivery.test.mjs` 遇到一次 control-plane lock timeout；该文件隔离复跑通过，随后全量串行复跑 515 项全部通过。保留为测试驱动的瞬态锁风险，不写成产品失败。
- `v14-profile-parity.test.mjs`：`1/1`；日志：`D:\dsh-test\output\platform-defects-batch128-146-profile-parity-20260930.log`。
- web/headless/desktop/teamtest 的 `write-scope-guard.mjs` 均为 size `57489`、SHA256 `15B342B84EB250FB3693E0077F9AD59AFD4DB4C438334B7607CAE6D446985A93`；`team-v12-runtime.mjs` 均为 size `148026`、SHA256 `43C128F8A1C80C26E253EFED70F46174E895371187CAD0DDDE9A8C58A5A128DB`；新测试 SHA256 `0FD12FEC744FD2CBB23074FDA47E156B6420EB1801EAC1E55F3C37DF12953DAD`。

### 第五十八轮未闭合

- 当前 DSH PID `30948` 早于本轮源码修改；B-218/B-219/B-220 均记为 source fixed、focused-verified、live pending，不重启进程。
- B-218 仍是静态预检而非 OS 级 sandbox；完全动态的嵌套解释器/外部程序写盘继续受既有 A-6 残余风险约束，遇到新形态必须按 opaque 或新反例处理。
- B-214 仍为 partial；B-216 的 C10 模式 A 与 RustMc 产品验证线继续开放。

### 第五十八轮 root 说明

- 批次 128–146 修复结果已进入 root next-turn inbox：`agent/inbox/spliced` seq `60799`，文件 SHA256 `BA4C629D6853E88C0BC8B7CB176B92A3952DA0498CFD3F29C44A5C51235C3E82`。
- 同一说明随后已转为 root surface `user/message` seq `60805`；该序号作为投递确认记录，不冒充 assistant ack。

## 第五十九轮修复（2026-09-30 · B-221；批次 147/151）

- 输入与交付清单指纹：size `1266622`，SHA256 `E694940C8714C30D5EC0B62E591A952E8892245E916F84D12FFB08F286B33347`，mtime `2026-09-29T21:42:29Z`；`WORKAROUND-REVERT.md` 无新增回退项。
- 根因：legacy wake 状态重水合时，`compactWakeTracking()` 只依据 wake 终态和 injection receipt 重建 inbox，没有读取 `acknowledgedInbox`，已 ack 行会被复活为 `queued`，继续形成同 `dedupeKey` 风暴。
- 实现：规范化 legacy inbox 时先读取 `acknowledgedInbox` 与既有 `inbox/handled` / `wake/handled` 证据；已 ack 行恢复为 `handled` 并保留最大 `handledAt`。四份 `team-v12-room-wake.mjs` 已同步。
- 验证：B-221 原始反例 `1/1`；四份 profile 语法 `4/4`；profile parity `1/1`；platform-defects 聚焦 `196/196`；phase1-phase11 串行 `369 tests / 368 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`。
- 状态：`source fixed / focused-verified / live pending`。当前 DSH PID `30948` 早于修改；未重启、未中断 active Team。
- root 说明：`D:\dsh-test\docs\platform-defects-batch147-b221-root-result-20260930.md` 已单独发送，文件 SHA256 `7A8D9C5FA62A5CC82C878898E9448B53595EDF97B814B7891BEAB76F88D10DB8`。本轮批次 148 说明不得重复发送 B-221。

## 第六十轮修复（2026-09-30 · 批次 147–168 增量；B-222 更正）

- 输入清单指纹：size `1266622`，SHA256 `E694940C8714C30D5EC0B62E591A952E8892245E916F84D12FFB08F286B33347`，mtime `2026-09-29T21:42:29Z`；交付前重新读取后三值未变。
- 约束：未重启 DSH、未中断 active Team、未清理旧备份/spill/telemetry/session、未修改 RustMc 产品仓；DSH PID `30948` / 端口 `40123` 保持，RustMc `HEAD=7dfca298a6f26f0d1fd3954b2a03b95966483f09` 且工作树干净。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **B-221** | fixed, focused-verified; live pending | 已在第五十九轮收口；批次 148 报告不重复发送。 |
| **B-222 · inactive action 冷启动退化** | open, runtime; profile regression guard only | 逐字错误为 `target "lead-world-2" is inactive and cannot be cold-started`，而 `info` 仍可投递。已更正早前“目标特定不可达”诊断：这是运行时冷启动能力退化。`deliveryTargetVerdict()` 明确非空 inactive/idle 目标仍为 `cold-resumable`，防止把平台契约误改成 fail-closed；该守卫不修复运行中的调度器。 |
| **批次 163-C · 剩余工作无产品写入** | fixed, focused-verified | 计划允许显式 `writeScopes=[]`；claim、ready queue 与 `complete` 都能表达“仅剩判据运行、无产品写入”。仍要求 evidence；`commit_sha:null` 仅在已批准空计划下放行。 |
| **批次 149/150/156/167 · 补位组长权威与持久化** | fixed, focused-verified | 新增 `team_member_reparent` 的持久化投影：tier 0 可把同组 tier-2 成员转给替补 tier-1 组长；message/interrupt/milestone/merge 权限随之更新，控制面重启后重新水合。 |
| **批次 157/160/163 · blocked 任务阻塞后继 claim** | fixed, focused-verified | `blocked` 且无 active lease 的任务不再阻塞后继；仍有 active lease 时继续冲突。ready 与 claim 的 lease 口径在聚焦测试中分别覆盖。 |
| **批次 149(c) · queued inbox 无 ack 出口** | partial | `inbox_list` 已暴露的 queued 行现在可由目标显式 ack，并补齐 caller/target 校验；41 小时“投递既不发生也不失败”的根因未修复，不把 ack 出口冒充投递恢复。 |
| **批次 147/153–155/158–159/164–166 · 世界线/落地/设备观察** | no platform change | 属 RustMc 世界线落地、引用完整性、重作业槽与设备进度观察；未修改 DSH profile，未冒充平台修复。 |
| **批次 162/164 · 死信与 recovery 操作** | observation / operator action | 取消指向旧接收者的死信、改用 evidence 上报，以及投递前不可达提示建议均未在插件层实现；未重启或改动活动 Team。 |
| **批次 168 · operator 重启请求** | blocked by constraint | 操作者建议重启 DSH 以同时恢复冷启动并装载 B-218/219/220/221。本轮按用户约束不重启，因此这些源码修复仍为 live pending。 |

### 第六十轮验证

- 原始反例：`D:\dsh-test\phase11-tests\platform-defects-thirty-seventh-pass.test.mjs`，`7/7 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；文件 size `12041`，SHA256 `E933C03A938FF595467C70FB461D66ED3DC7ED20846ECC8C666874E1EE5970B9`；日志 SHA256 `79A39364B4A13D80895C2298C9C0BB7C269032C44EFD96A8C5459B559F03551A`。
- 四份 profile 的 7 个修改文件 `node --check`：`28/28` 通过。
- platform-defects 聚焦集：`203 tests / 203 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 SHA256 `7927B6ADF970840E815CAB222238BFBA4C7BC1C396D18A0E6D76AAF2652F99D1`。
- phase1-phase11 串行全量回归：`523 tests / 522 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 SHA256 `5CE3C00B18335B524417612FCF9D9CEEB50B83E3973D10216A7502853B810F6D`。
- profile parity：`1/1`，`EXIT_CODE=0`；日志 SHA256 `753A0DBFFB83511D6E3D328EF7FAD11C3A9C7E84011BF11665581ADE2B53A3F4`。
- 四 profile 同文件哈希逐字一致：
  - `team-tools-v2-r10.mjs` size `403838` / SHA256 `A17C9EFB9F793CA97040609EE513CE439E787E84ED51BDF29631B3898F730A37`
  - `team-v12-contract.mjs` size `28884` / SHA256 `855BAE98F17C1A42527B16114CD413576B2BC06F8CCFA5B7724990726C86F878`
  - `team-control-plane.mjs` size `213370` / SHA256 `C06733FF7149E1E96099DB60FFD3DF7DDD32E4FB5A338CF798DBCFEC27EDFC63`
  - `team-policy.mjs` size `39535` / SHA256 `F5A9375D09156B04E5F85C6CCC97D1BAD4B7FA80992E11307C4736EC11061D47`
  - `team-v12-room-wake.mjs` size `88872` / SHA256 `815B66C7F07320E61B4EED1EBFB51289CCD15EA2AEFCF448A91045936BE3DAB8`
  - `team-v12-runtime.mjs` size `148546` / SHA256 `32B29D1760699680AC2F9A10B5125231BBC94C065382A2C7F9C90B77477E62DB`
  - `team-v12-evidence-scheduler.mjs` size `43086` / SHA256 `09D9A9DC7688F99FAD19FA19F7FCCCD1FC69E0B370193EE9E47A74D4F9D503C7`

### 第六十轮未闭合

- B-222 仍是运行时缺陷：非空 inactive/idle 目标按契约应可冷启动，当前运行中的 DSH 对 `action` 返回 `delivery-failed`。本 profile 修改只防止误判为永久不可投递，不声称恢复运行能力。
- 41 小时 queued 投递停滞、死信向旧接收者重试、恢复后自动续投仍指向旧目标，均保留为独立未闭合项。
- 当前 DSH PID `30948` 早于本轮 profile 修改，所有源码修复均为 source fixed / focused-verified / live pending；按约束不重启。

### 第六十轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch148-root-result-20260930.md`，size `4181`，SHA256 `E4FCC5EC73BAF995B87B4BB3C1B3653183330929B3D079DE5171ADAACD7C4D3E`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true`；session projcache 已在 `turn 431 / seq 61668` 记录该说明，并出现对应 root response。未重复发送第五十九轮 B-221 报告。

### 第六十轮交付后清单推进（批次 169）

- 交付后重读发现 RustMc `main` 由 `7dfca298` 推进到 `87d7676aa6d0a2ed7da1007180a51c77b78df2fb`，新增批次 169；RustMc 工作树仍干净。
- 批次 169 是对第六十轮 root 说明的回写确认，内容与本轮报告逐项一致：显式空写面、re-parent 持久化、blocked/lease claim 口径、queued ack 出口、B-222 运行时冷启动退化诊断。没有新增平台缺陷、没有要求新的 profile 修改。
- 批次 169 新增“重启后行动清单”：先测 `.gitignore` 路径是否豁免 B-218 写根守卫，再验证 re-parent 四项权限、`t129` claim 与空写面；`t115`/`t107` 仍受 fail-closed 协调态约束，B-222、41 小时 queued 停滞、旧接收者死信重试仍开放。
- 本轮不再追加源码修改或重复发送说明；最终清单指纹以本节的 size `1272714`、SHA256 `CB735C04AD6A25B95108FCB51AD5B995AFF37F009147CCC6AD53FE78C29C030F`、mtime `2026-09-29T21:55:17.0311298Z` 收口。

## 第六十一轮修复（2026-09-30 · 批次 170–183；B-218 回归、批次 182 死信退役）

- 输入清单指纹：size `1311199`，SHA256 `EEF0CB9D5BB28A7162508B9DACE12E6CF6230BB5B92965A7EA4F7B441101B1E6`，mtime `2026-09-29T22:28:25.3125732Z`。交付前最终重读推进到批次 183：size `1327090`，SHA256 `6400B96ED3DE337C9B8B1DDC2E29688918E8E4ABF42BADD8299901DCB0BFC9D8`，mtime `2026-09-29T22:44:01.1884490Z`；批次 170–183 已逐项对照。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`，无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch170-179-20260930-063216`，包含修改前 `write-scope-guard.mjs`、台账与 watch state；本轮新增的 control-plane/tools 修改在该备份之后发生，原文均可由第六十轮四 profile 哈希与 git-independent 文件历史核对。
- 约束：未重启 DSH、未中断 active Team、未清理旧备份/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **B-218 后续回归 · `-File` 形状门拒绝全部脚本起跑** | fixed, focused-verified; live pending | `write-scope-guard.mjs` 新增受制裁载体：单个顶层 `pwsh/powershell -File <script>` 只有在脚本是活动 approved plan 的 `writeScopes` 覆盖范围内、存在、大小受限且为 UTF-8 时放行；运行期构造路径由批准脚本承载。`pwsh -Command`、`bash -lc`、shell 分隔符、重定向、组合命令、缺失/非 UTF-8 脚本继续 opaque fail-closed。放行分支仍执行 tier-1/2 的绑定 worktree carrier 检查。 |
| **批次 182 · `timed-out` 死信无终态退役路径** | fixed, focused-verified; live pending | `team-control-plane.mjs` 允许 `timed-out -> expired`；`team-tools-v2-r10.mjs` 新增 `dispatchRetireVerdict()`，仅 tier 0 可执行该退役，target/sender 仍可沿用原有 `cancelled` 路径。这样历史死信可显式退出 open/dead-letter 指标，而不是让计数器只增不减。 |
| **批次 180 · 协调态写入路径（缺陷二）** | partial / no platform change | 全机共享锁对 tier-1/2 仍无合法写入路径；本轮只关闭“脚本入口”缺陷一，未把两条缺陷合并，也未为共享锁私开 scope 例外。 |
| **B-222 · inactive action 冷启动退化** | runtime recovered; live observed | 批次 172 的一手 `action` 探针已恢复 `delivered`；profile 热重载后运行态冷启动恢复，保留“可能再次因运行态变化退化”的观察项。 |
| **批次 173/174 · `team_member_reparent` 与孤儿收割** | live verified / no platform change | 接管后的里程碑读取、工作树布置、分支合并和成员→组长消息均已有结果；合并进入更靠后的 `member-merge-task-commit-missing` 正常门。孤儿 pid `32592` 已收割、端口 `25790` 释放且未误杀常驻 oracle。 |
| **批次 170/171/181 · 引注、baseline、取消块与依赖释放** | no platform change | 属 RustMc 文档/引注门和团队排程纪律；批次 181 已把取消标记就地写入 `HEAVY-SLOT.md` 并释放无意义串行依赖，不修改 DSH profile。 |
| **批次 183 · `-File` 三个受害面** | covered by B-218 regression fix | `run-criteria.ps1`、`run-batch.ps1`、注入仪器和 `t113 check-1` 都是同一受制裁脚本载体形态；源码修复覆盖该类入口，但受运行中 DSH 未做 live 调用限制，仍记为 live pending。 |

### 第六十一轮验证

- B-218 回归原始反例：新增 `platform-defects-thirty-eighth-pass.test.mjs`，修复前首轮 `2/6`、4 项失败；最终 `7/7 pass / 0 fail / 0 skipped`，覆盖运行期构造脚本放行、越 scope 拒绝、绑定 worktree carrier 拒绝、inline `-Command`/bash wrapper/分隔符/缺失/UTF-16/invalid UTF-8 fail-closed。
- 批次 182 原始反例先红：`platform-defects-fourth-pass.test.mjs` 的 `B-182b` 在修复前以 `invalid dispatch transition "timed-out" -> "expired"` 失败；修复后 `1/1` 通过，并断言 tier 0 可退役、tier 1 不可退役。
- 四份 profile 的三份修改文件 `node --check`：`12/12`；两份测试 `node --check`：`2/2`；合计 `14/14`。
- platform-defects 聚焦集：`211 tests / 211 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch170-183-focused-platform-tests-20260930.log`，SHA256 `D49C24A041C689F313087F2EBC412E5AD9854B23FD03333DAC723A68773D8BE8`。
- phase1-phase11 串行全量：`531 tests / 530 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch170-183-full-phase1-phase11-serial-20260930.log`，SHA256 `82EBA5F12BF8AD62A6AC53A1283242D532E124DECC86D2B0C306ACF9670DDF17`。
- profile parity：`1/1`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch170-183-profile-parity-20260930.log`，SHA256 `B1B0EB7FA24486262637CF315F3514954896A44B4793EC8FE804A215C28FA634`。
- 四 profile 同文件哈希逐字一致：
  - `write-scope-guard.mjs` size `62832` / SHA256 `5357D1A84ECB06E2A1B10A8792931775D4064B13E4247B010361DD9BA3E0DFA1`
  - `team-control-plane.mjs` size `213381` / SHA256 `20E25E808AEFEAD34AA23D0A689B422303CC2F046EDFB8F5BDE5456478F14E24`
  - `team-tools-v2-r10.mjs` size `404641` / SHA256 `76F5FF34A16AF4713FB3FCDEAA60D827158583B041CC9AA06818D005BDBF485D`

### 第六十一轮未闭合

- 当前 DSH PID `30948` 早于本轮 profile 修改；B-218 回归与批次 182 死信退役均为 source fixed / focused-verified / live pending，未重启进程冒充 live。
- B-218 修复是“受批准计划 scope 覆盖的脚本载体”而非 OS 级沙箱；脚本内完全动态的外部程序写盘仍受 A-6 残余风险约束。
- 批次 180 的协调态写入路径仍为独立 partial；不得因 `-File` 入口已修而声称共享锁问题同时关闭。
- 41 小时 queued 投递停滞、旧接收者死信自动续投仍是运行态观察项；本轮的 `timed-out -> expired` 只提供显式退役出口，不改自动投递。

### 第六十一轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch170-183-root-result-20260930.md`，size `3135`，SHA256 `4FF3E4B82DB496D0F3112B3528CA9E073008ECF15203FA31AC6FAFCBF22B4A7F`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true`，rpcId `7181edfa-cc7f-4557-8f38-6bd4ae3f3199`。
- session v4 中 `agent/inbox/spliced` 为 `seq 62512`，surface `user/message` 为 `seq 62518`，正文与报告文件逐字一致；发送时 root turn `436` 仍在执行，因此按已入队/已拼接记录，不冒充 assistant ack。

## 第六十二轮修复（2026-09-30 · 批次 184–195；B-193 live 复核、批次 194 escalation 读路径）

- 输入清单指纹：起始为批次 193 的 size `1376620`、SHA256 `014A375FB7C480D36E6B66D0AE6CD98A449C584FB75E14204609E9750920A7FE`、mtime `2026-09-29T23:38:44.9469418Z`。交付前重读推进到批次 195：size `1383506`、SHA256 `E50BA8DBD12723F494696E3D7542F31B88F995F2BA4918BFCFEA06D354866DC5`、mtime `2026-09-29T23:53:11.3479958Z`；批次 184–195 已逐项对照。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`，无新增回退项。
- 备份：`D:\dsh-test\backups\platform-defects-batch194-195-20260930-075707`，包含本轮批次 194 修改前的 `team-tools-v2-r10.mjs`、测试、台账与 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理旧备份/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **B-193 · `blocked` 卡持有写面并制造假就绪** | fixed, focused-verified; live verified | `team-v12-evidence-scheduler.mjs` 在 lifecycle 或 phase 为 `blocked` 时加入 `blocked-phase`，阻止其成为 runnable write-scope holder；`team-tools-v2-r10.mjs` 同时提供 `write-scope-holding` 反向诊断。批次 195 的一手运行读数确认 `t134` 为 `ready=false / blocked-phase`，`t129` 恢复 `ready=true`，因此本轮可记为 live verified。 |
| **批次 194 · escalation 无工具读路径且自动死信混入决策视图** | fixed, focused-verified; live verified (batch 196) | 新增只读 `team_escalation_list`，支持 status/category/urgency/target/limit 过滤并返回 `category`、`urgency`、`target`、`summary`、`decisionNeeded`、`automated`；`team_delivery_check` 的 escalation blocker 补齐上述字段，并新增 `escalationSummary`，分别统计 `humanDecisionCount` 与 `automatedNotificationCount`。批次 196 的 root 探针确认工具与 summary 均已热重载生效。 |
| **批次 195 · B-193 闭环** | no additional platform change | 清单记录运行实例已实现 `blocked-phase` 与反向持有者信息；本轮用该一手运行读数复核 B-193，不新增第二个实现。 |
| **B-184 · `-File` 修复加载边界** | source fixed / focused-verified; live pending | 当前 DSH 进程早于修复，未重启，不把源码修复冒充 live。 |
| **B-185 / B-187 / B-190 · 组尖、verifier 路由、readyReason** | fixed, focused-verified | 四 profile 已同步；相关原始反例继续通过。 |
| **批次 186/188/189/191/192 · 观察、文档或产品语义** | no platform change; B-189 partial | 不把观察或产品侧裁定扩写成 DSH 修复；B-189 保持 `partial / no platform change`。 |

### 第六十二轮验证

- 批次 194 原始缺口：备份中的旧 `team-tools-v2-r10.mjs` 对 `team_escalation_list`、`escalationView`、`humanDecisionCount`、`automatedNotificationCount` 均为 absent；修复后注册与分流逻辑进入四 profile。
- `platform-defects-fourth-pass.test.mjs`：`14/14 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；文件 size `17331`，SHA256 `DD715A869C98BEB2657D0F0CE6C879530AB4DC0DC47A9CBD4B387AB6E1D30845`。
- platform-defects 聚焦集：`216 tests / 216 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch184-195-focused-platform-tests-20260930.log`，size `37534`，SHA256 `B86760F5D02499C5E63EEC7A6EA7A7418DBB2EDA35361FCB498F3A482F01FD33`。
- phase1-phase11 串行全量：`536 tests / 535 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch184-195-full-phase1-phase11-serial-20260930.log`，size `163549`，SHA256 `2483ACEBC03FDD4117EDC433223784F2F67E216DEC2DEC2A499F817E78B39BC3`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch184-195-profile-parity-20260930.log`，size `634`，SHA256 `D78F12EA6E1A691A66CC7B4CB4C52DA20954D9C592AA7D26DAD2BC59E17335D8`。
- 四 profile 修改文件与测试 `node --check`：`5/5` 通过。四 profile 同文件哈希逐字一致：
  - `team-tools-v2-r10.mjs` size `420520` / SHA256 `D11C78C9023263A2B5FF7B891354C01B5F080180F5AA2415560FF547E5B725E6`
  - `team-v12-evidence-scheduler.mjs` size `43286` / SHA256 `FF9A4B5925D280E9B65249752E3572C319EE9E7F4ABD26422E5D3375AED4459A`
- 只读控制面核对：19 条 escalation 中 open `0`；历史分布为 `wake-dead-letter=18`、`blocked=1`，与批次 194 的分类事实一致。

### 第六十二轮未闭合

- 批次 194 交付时记为 source fixed / focused-verified / live pending；交付后批次 196 的 root 运行探针已确认 `team_escalation_list` 与 delivery summary live，最终状态改为 live verified。
- B-184 的 `-File` 修复仍为 live pending；B-189 仍为 partial / no platform change。
- 协调态共享锁写入路径、41 小时 queued 投递停滞与旧接收者自动续投仍是独立未闭合项。

### 第六十二轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch184-195-root-result-20260930.md`，size `3502`，SHA256 `50DEA74B2417DC2A3E277CFB2452025BDEF22829FE9B93C53EAA51B94F0205B5`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true`，`RpcIdMatch=true`。
- session v4 中 `agent/inbox/spliced` 为 `seq 63237`，surface `user/message` 为 `seq 63244`，正文与报告文件逐字一致；按已入队/已拼接记录，不冒充 assistant ack。

### 第六十二轮交付后清单推进（批次 196）

- 交付后重读发现清单从批次 195 推进到批次 196：size `1386534`、SHA256 `DA4A804066295486FC5C96DFD72EF729BD8443E65620CF7A42DDCC0EFE0A9BB7`、mtime `2026-09-30T00:04:51.1939566Z`。
- root 的一手运行探针确认 `team_escalation_list({status:"all"})` 可调用并返回 `total=19 / open=0`，`team_delivery_check().escalationSummary` 存在且 `openCount=0` ⇒ 批次 194 的 `team-tools-v2-r10.mjs` 修复已热重载并 **live verified**，不再保留 live pending。
- root 同时确认批次 193 的 `write-scope-held-by` / `write-scope-holding` 双向可见已生效；B-193 维持 live verified。
- `write-scope-guard.mjs` 的 `-File` 两臂探针仍返回旧 opaque 串 ⇒ B-184 保持 source fixed / focused-verified / live pending；这里证明“需要重启”只适用于该模块，不能整体归因到进程。
- 批次 196 没有新增平台代码修改，也没有新增待修复项；本轮最终清单指纹改为上述批次 196 三值。

## 第六十三轮检查（2026-09-30 · 批次 197–200；无可靠平台代码载体）

- 输入清单指纹：size `1399499`、SHA256 `C48A440433D804B67870377FEAD99C38ECD0CDE898AD41FB547E25C37E2F27CD`、mtime `2026-09-30T00:41:09.9656190Z`；`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 变更来源：RustMc `e4b6012`、`e1b43a0`、`e782738`、`c3e9452` 四个文档提交，只追加批次 197–200，没有 profile/source/test 变更。
- 约束：未重启 DSH、未中断 active Team、未清理 backup/spill/telemetry/session、未修改 RustMc 产品仓。

| 清单项 | 状态 | 处理 |
|---|---|---|
| **批次 197 · `dispatch.completed` 与 `pendingCount`** | no platform change | 原文把 `pendingCount>0` 当作“未处理”的唯一信号；随后批次 198 已用 `lead-rig` 的对照反例撤回该判据。平台侧没有新的可靠代码载体，不据单侧观测修改 wake 生命周期。 |
| **批次 198 · 响应判据更正与 world 组长替换** | no platform change | 正确判据为“已投递 ∧ 回合已结束 ∧ 零持久效果”；换组长、reparent、freeze 属 Team 运行态操作，不是 profile 源码修复。 |
| **批次 199 · replacement lead declined 不等于不可用** | no platform change | `declined` 针对当次 brief；同一成员后续可处理 continuation。现有运行语义已能表达两态，不新增代码。 |
| **批次 200 · world 组连续三位组长静默** | operator-restart-required / no platform change | 三个实例同范围静默指向运行态机制候选，而非可由 tier 0 单独修复的已确认源码缺陷；操作者重启是当前候选处置。按用户约束不重启、不干预 active Team。 |

### 第六十三轮验证

- 本轮没有实际平台源码修改，因此没有四 profile 同步、语法、聚焦或全量回归可执行；不把文档观察伪装成代码验证。
- `PLATFORM-DEFECTS.md` 批次 196 已确认 B-193 与批次 194 的 profile 修复 live；B-184 的 `-File` 门仍为 live pending，必须等 `write-scope-guard.mjs` 所在进程加载新模块。
- 批次 197–200 没有新增 `B-*` 缺陷编号，也没有新增 `WORKAROUND-REVERT.md` 回退条目。

### 第六十三轮未闭合

- world 组连续静默仍是运行态问题；tier 0 无法直接唤醒 tier 2，已有换组长干预两次均零持久效果并已回滚，继续换人不成立。
- 唯一已确认需要用户侧动作的是重启 DSH 以加载 `write-scope-guard.mjs`；重启同时可能重置 world 组成员会话，但该第二项仍只是候选，不能写成已证实因果。
- 没有发生平台修复，因此本轮不发送新的 root 修复结果说明；上一轮报告和批次 196 的 live 复核已保留在 root 会话。

## 第六十四轮检查（2026-09-30 · 批次 201–202；无新增平台源码修复）

- 输入清单指纹：size `1404478`、SHA256 `F28821F7E258BB8F64AC435F829013431E69073288EA2FEACBC31CC866293946`、mtime `2026-09-30T01:03:24.5435398Z`；`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 变更来源：RustMc `2b5e37c`、`aadb05e` 两个文档提交，只追加批次 201–202，没有 profile/source/test 变更。
- 约束：未重启 DSH、未中断 active Team、未清理 backup/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理 |
|---|---|---|
| **批次 201 · `completedNotIntegratedCount` 对内容等价提交产生永久假阳性** | observation-only / no platform change | `t142` 的提交对象不在 `main` 祖先链，但其目标文件 blob 与 `main` 逐位相同，推进到 `accepted` 后仍留在 CNI 列表。该列表当前按精确提交身份判断，是 fail-closed 的候选诊断；内容等价不包含 verifier clearance 对精确提交的绑定，不能据此直接放宽集成门。维持逐条内容复核，不新增平台代码或改写精确提交契约。 |
| **批次 202 · world 组不可达与 `-File` 门加载状态** | operator-restart-required / no platform change | 9 张 open 全部为 `work-genuinely-unfinished`、`owner-forgot-to-mark-it=0`、escalation open `0`；`-File` 两臂探针仍返回旧串，证明 `write-scope-guard.mjs` 尚未加载。tier 0 已把 world 不可达登记为具名等待；`t143` 保持等待组长并入组分支，不能由 tier 0 越界处理。 |

### 第六十四轮验证

- 本轮没有实际平台源码修改，因此没有四 profile 同步、语法、聚焦或全量回归可执行；不把文档观察伪装成代码验证。
- 批次 201 没有新增 `B-*` 缺陷编号；批次 202 没有新增平台源码载体；`WORKAROUND-REVERT.md` 没有新增回退项。
- 批次 201 的一手反例确认 `main:crates/mc-world/src/entity_lifecycle.rs` 与 `58923359` 的 blob 均为 `08e6b46eb846c851fa7a256f58c3aec656ac4cd6`，但 `merge-base --is-ancestor 58923359 main` 返回 `rc=1`；因此假阳性事实成立，但不足以证明应削弱精确提交集成门。

### 第六十四轮未闭合

- B-184 的 `write-scope-guard.mjs` 修复仍需操作者重启 DSH 后才能 live 验证；批次 202 的两臂探针仍显示旧行为。
- world 组不可达仍是运行态阻塞，当前唯一处置是把等待责任明确为 operator/platform；重启可重置会话仍只是候选，未验证因果。
- `t143` 的真实未落地内容由 world 组组长处理，tier 0 不越界合并成员分支。
- 没有发生平台修复，因此本轮不发送新的 root 修复结果说明。

## 第六十五轮检查（2026-09-30 · 批次 203；跨组重挂边界实测）

- 输入清单指纹：size `1406651`、SHA256 `C335F6F6B761CD4F77454A761314EB7BB0A79F7200FE25E26B3C6AFCED383675`、mtime `2026-09-30T01:47:53.9665825Z`；`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 变更来源：RustMc `d711105` 文档提交，只追加批次 203，没有 profile/source/test 变更。
- 约束：未重启 DSH、未中断 active Team、未清理 backup/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `30948` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理 |
|---|---|---|
| **批次 203 · 跨组 `team_member_reparent` 被拒** | verified runtime boundary / no platform change | 实测 `member-world-chunk -> lead-rig` 返回 `[member-reparent-group]`，确认成员不能跨组重挂，探测被拒且无副作用。该边界保护组归属与消息作用域；world 可达性仍只能由其组组长提供。三位 world 组长均静默，重启仍是唯一剩余操作手段。 |
| **批次 203 · 其余运行读数** | no change | 9 张 open 全部 `work-genuinely-unfinished`，`owner-forgot-to-mark-it=0`，escalation open `0`，`deadLetterCount=2`，`completedNotIntegratedCount=3`，running/frozen/inactive 为 `1/12/19`；`-File` 两臂仍逐字同串，DSH 未重启。 |

### 第六十五轮验证

- 本轮没有平台源码修改，因此没有四 profile 同步、语法、聚焦或全量回归可执行。
- 跨组重挂拒绝已由运行实例实测确认，不再只是文档推断；该拒绝行为按现有组边界契约保留。
- 批次 203 没有新增 `B-*` 缺陷编号，也没有新增 `WORKAROUND-REVERT.md` 回退项。

### 第六十五轮未闭合

- world 组不可达仍存在；跨组重挂不可用，组内换组长已连续失败并回滚，tier 0 没有剩余无重启修复路径。
- B-184 的 `write-scope-guard.mjs` 修复仍需操作者重启 DSH 后才能 live 验证。
- 没有发生平台修复，因此本轮不发送新的 root 修复结果说明。

## 第六十六轮修复（2026-09-30 · 批次 204；`-File` 诊断修正）

- 输入清单指纹：size `1406651`、SHA256 `C335F6F6B761CD4F77454A761314EB7BB0A79F7200FE25E26B3C6AFCED383675`、mtime `2026-09-30T01:47:53.9665825Z`；交付前重读依次推进到批次 204 的 size `1415412`、SHA256 `746A5FE48587C61059146CB7F65B9541ECE0E9A4E1E85BAF472A673A48D34A58`、mtime `2026-09-30T03:40:42.2828170Z`，再推进到批次 205 的 size `1419778`、SHA256 `770FD29BD1945CED00CA2BE52D6E7B6AFB7E3C4E76AE6F1D3852DF0535E61C16`、mtime `2026-09-30T04:04:00.0356704Z`（`9896` 行）。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-batch204-20260930-114455`，包含修改前四份 guard、旧测试、清单与 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **批次 204 · `-File` 两臂同串的归因更正** | corrected / diagnostic-only fix; live pending | 旧诊断把 `script-invalid` 与 `script-outside-plan-scope` 折叠成同一句 opaque 串，因此“两臂同串”不能证明新代码未加载。四份 guard 新增仅诊断用途的分支，分别输出两类具名原因；放行/拒绝行为不变。行为修复本身仍不宣称 live fixed。 |
| **批次 205 · 平台确认两臂探针无判别力** | confirmed / no additional platform change | 平台逐字确认旧诊断把 `script-invalid` 与 `script-outside-plan-scope` 折叠成同一句，因而两臂同串不能区分新代码是否加载；tier 0 复核源码确认 `:1545-1556` 的 `-File` 求值与诊断分支、`:1558` 的旧折叠串。该批只确认批次 204 的归因更正，不新增代码修复；有效判据仍是持有覆盖脚本的已批准计划成员执行 `t114` 对照跑。 |
| **批次 204 · world 组重启后零产出** | unresolved / no platform change | 重启和重挂是运行态动作；当前证据不足以把“world 组恢复持续产出”写成事实。未新增代码修复点，相关等待继续开放。 |

### 第六十六轮验证

- B-218 原始反例：`D:\dsh-test\phase11-tests\platform-defects-thirty-eighth-pass.test.mjs`，`7/7 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；文件 size `7152`，SHA256 `6A94B4F2778869EBD5BFFB957E270488D122CD9A45CC0D75D9E51C7F264669AE`。
- 直接源码反例：缺失脚本返回 `script-invalid`；仓内已存在但越 scope 的脚本返回 `script-outside-plan-scope`。
- 四份 guard 与测试 `node --check`：`5/5` 通过。
- platform-defects 聚焦集：`216 tests / 216 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch204-focused-20260930.log`，size `37563`，SHA256 `396FC56649FF7121872C73C908FED560453A71B37A7C3DFB02460D26D687545B`。
- phase1-phase11 串行全量：`536 tests / 535 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch204-full-phase1-phase11-serial-20260930.log`，size `163532`，SHA256 `0114F70558F64BA56388297FC147205B5DCE3CDCEEE2FAF8348DDFAF597A9DEE`。首轮并发运行出现的 phase6 control-plane lock timeout 未在串行全量复现，不写成产品失败。
- profile parity：`1/1 pass`，`EXIT_CODE=0`。
- 四份 guard 均为 size `63114` / SHA256 `0F192C15D34277899F2E5867898AC482951784059690AFFE1A4C136B2F1129E7`。

### 第六十六轮未闭合

- 批次 204 的 guard 改动只改善诊断，不改变 `-File` 授权语义；B-184 / B-218 仍为 `partial, diagnostic source fixed / focused-verified / live pending`。
- 当前 PID `31528` 启动于 `2026-09-30T03:37:13Z`，诊断增强写入于 `03:45:02Z`；未重启，不把源码检查冒充 live 生效。
- world 组持续可达性仍无具名代码修复点；未继续重启或替换组长。

### 第六十六轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch204-root-result-20260930.md`，size `2461`，SHA256 `3A5BA2229829BFD7B57EFA731B616463A67A4BF3986EECF6313769C1CE94D0E7`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true`，requestId `ecfe1639-5136-4f06-a59f-1f1506428299`。按服务端接纳记录，不冒充 assistant ack。

## 第六十七轮修复（2026-09-30 · 批次 204/205；平台请求第 3/4 号）

- 输入清单指纹：size `1419778`、SHA256 `770FD29BD1945CED00CA2BE52D6E7B6AFB7E3C4E76AE6F1D3852DF0535E61C16`、mtime `2026-09-30T04:04:00.0356704Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-batch206-20260930-124839`，包含修改前四份 `team-v14-context-delivery.mjs`、旧测试、清单与 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **平台请求第 4 号 · `world` 组成员被唤醒后零产出 / `declined`** | fixed / focused-verified / original-counterexample-replayed / live pending | 具名根因是 `taskContext()` 将 `group-world-t139` 的 64,475 字符 deliverable 全量放入 safety-critical 必需上下文，旧投递因约 32,426 token 超预算而 `debt=true / failClosed=true`。四份 `team-v14-context-delivery.mjs` 现对超大 deliverable 保留 4,096 字符头尾预览、原始字符数、16 位 digest 和 `task_contract_get` 全量取回入口；通用 safety-critical fail-closed 语义未削弱。 |
| **平台请求第 3 号 · `-File` 两臂探针与守卫加载点** | partial / live pending | 没有新增授权语义修改。两臂探针仍无判别力；决定性判据保持为持有覆盖脚本的已批准计划成员执行 `t114` 对照跑。 |

### 第六十七轮验证

- 真实 `group-world-t139` rev36 原始反例重放：deliverable `64475` chars；旧 context `65516` chars / omitted tokens `32426` / `debt=true` / `failClosed=true`；新 context `4790` chars / estimated tokens `2316` / `debt=false` / `failClosed=false` / preview `4096` chars；`deliverableTruncated=true`，`task_contract_get` fetch 保留。
- `D:\dsh-test\phase11-tests\v14-identity-context.test.mjs`：`14 tests / 14 pass / 0 fail / 0 skipped`。
- 四份 profile 与测试 `node --check`：`5/5` 通过。
- platform-defects 聚焦集：`216 tests / 216 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch206-focused-20260930.log`，size `37550`，SHA256 `51422369C79754863562D9ACAE93DFCD0A6C2AEBFA75AB3B759A419BCFE322FC`。
- phase1-phase11 串行全量：`537 tests / 536 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch206-full-phase1-phase11-serial-20260930.log`，size `163846`，SHA256 `8C5453A85BCBA84AFEA624F0549C67826144A08A83E9926A603C54725B667C1E`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`。
- 四份 `team-v14-context-delivery.mjs` 均为 size `13577` / SHA256 `1B630D12A0C80FC110CB9320C2AD08A8D8391E10D6A7E89FB81C8EFA730F6ED8`。

### 第六十七轮未闭合

- 第 4 号源码写入于 `2026-09-30T04:48:53Z`，当前 PID `31528` 启动于 `2026-09-30T03:37:13Z`；未重启或打断 Team，不能把 focused 结果冒充 live 生效。
- 第 3 号仍未完成原始反例验证；必须由覆盖 `tools/rig-batch/tests/` 的已批准计划成员运行 `t114`。
- 本轮只限制 task deliverable 进入成员上下文的体积；A-6 的动态外部程序写盘风险不变。

### 第六十七轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch206-root-result-20260930.md`，size `2947`，SHA256 `EA4DFD3EAE49B329B80AA23E8CCE520570232B91FEE07565DD86E56227519141`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true`，requestId `c7f886c9-bd20-4c64-a6aa-e4ba349f2634`。按服务端接纳记录，不冒充 assistant ack。

## 第六十八轮检查（2026-09-30 · 批次 207/208；无新增平台源码修改）

- 输入清单指纹：size `1431735`、SHA256 `C437740085C936EBE3A2C78F9DCEF9DECC692A7A2BB92CC91961E250AF814A2C`、mtime `2026-09-30T05:23:21.1523160Z`；`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 变更来源：RustMc `32b5c0e8`、`990f40db` 两个文档提交，只追加批次 207/208；没有新增 profile/source/test 修改。未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **平台请求第 4 号 · world 组零产出** | root live workaround verified；platform profile fixed / focused-verified / original-counterexample-replayed / live pending | root 已把 `group-world-t139` deliverable 从 `64475` 字符缩到 `632` 字符并保全全文；同一 `lead-world-3` 随后产生六项持久效果（`grp/world=b8f2fae`、`t143` completed/integration-ready、`t129` plan rev2 approved、`t137`/`t130` plan approved 且 dependency-unmet 串行、`entity_lifecycle.rs` blob 两侧同为 `08e6b46e`）。这证实平台具名根因与即时处置有效；`team-v14-context-delivery.mjs` 的源码修复仍因 PID `31528` 早于写入而保持 live pending。 |
| **平台请求第 3 号 · `-File` 两臂探针与守卫加载点** | partial / live pending；决定性 t114 已下达，尚无逐字结果 | 已确认 `write-scope-guard.mjs` 是 web profile 的直接 Cordis 插件，由 PID `31528` 同一 Node 进程加载；行为修复早于 PID，批次 204 的诊断分支晚于 PID，因此旧两臂同串只证明诊断文本未热更新，不能证明行为修复未加载。root 已声明第 6 次重槽，`lead-rig` 已把 `rig-diff` 工作树同步到 `990f40db`（HEAD `4d7ee0ee`、behind=0、porcelain=0），并唤醒 `rig-diff` 执行在 scope 内允许、越 scope fail-closed、缺失脚本 fail-closed 的三臂判别。 |
| **批次 207/208 · 其余内容** | no platform change | 批次 207 的 `[room-access]` 入座前置、行数仪器伪影与落地预判绑定 main SHA，以及批次 208 的两处 root 自纠，均属运行/记录纪律；没有新增 `B-*` 平台代码缺陷或回退条目。 |

### 第六十八轮验证

- 已完整重读最新 `PLATFORM-DEFECTS.md` 变更段、`WORKAROUND-REVERT.md` 和第六十七轮修复台账，并逐项对照批次 207/208。
- root 会话逐字确认：`lead-rig` 已同步 `rig-diff` 工作树并转达三臂要求；`rig-diff` 的 `pid`/`started`、① 裁决及三臂返回串截至本轮检查尚未回报。
- 本轮没有新增平台源码修改，因此不重复运行四 profile 同步、语法、聚焦或全量回归；第六十七轮的验证证据仍有效。

### 第六十八轮未闭合

- 第 3 号必须等 `rig-diff` 逐字回报三臂结果后才能从 `partial / live pending` 改为 `live verified` 或确认失败；不得把 `queued`、工作树同步或探针派发当成验证完成。
- 第 4 号平台 profile 修复仍受当前 PID 早于源码写入约束；root 的卡面缩短是已验证的即时 workaround，不等于 profile 已热加载。

## 第六十九轮修复（2026-09-30 · 批次 209–222；请求第 3/4/5/6 号收口）

- 输入清单指纹：起始为批次 207/208 的 size `1431735`、SHA256 `C437740085C936EBE3A2C78F9DCEF9DECC692A7A2BB92CC91961E250AF814A2C`、mtime `2026-09-30T05:23:21.1523160Z`；交付前重读推进并稳定在批次 222 的 size `1495015`、SHA256 `2686B59030C0832E64C8AEE25E8EF135FCB55C9A5C600A63763D1C5D1C5E0B3E`、mtime `2026-09-30T06:17:53.7011857Z`。批次 209–222 已逐项对照；`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-batch217-cross-turn-jobs-20260930-140445`，包含修改前四份 `dsh-jobs-local/lib/index.js`、台账、watch state 与当时清单。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **平台请求第 3 号 · `-File` 写面门** | fixed / focused-verified / live verified | 批次 210 的运行实例已完成三臂判别：在已批计划写面内的受制裁 `-File` 脚本允许并执行；越 scope 脚本 fail-closed 且新诊断具名；缺失脚本 fail-closed。该结果否定了批次 205 的“未生效”结论，后者已由无判别力两臂探针撤回。 |
| **平台请求第 4 号 · `world` 组唤醒后零产出** | root workaround verified；profile fix source fixed / focused-verified / original-counterexample-replayed / live pending | `taskContext()` 对超大 deliverable 的 fail-closed 根因已修复：保留头尾预览、原始字符数、digest 与全量取回入口。root 缩短 `group-world-t139` 后同一组长产生持久效果，证明处置有效；四份 `team-v14-context-delivery.mjs` 修复仍因 PID `31528` 早于写入而 live pending。 |
| **平台请求第 5 号 · completed 卡已批计划不可绑** | no platform change; original premise disproved | 新增隔离原始反例 `platform-defects-fortieth-pass.test.mjs`：同一 edit 卡在计划 `plan-approved` 下先 acquire、完成并 release，再对 `completed` 卡直接 `acquire` 成功；`status` 保持 `completed`、phase 不回退、计划保持 `plan-approved`，全程未 `reopen`。因此“必须重开 completed 卡才能重新绑定已批计划”不成立，不新增授权放宽。 |
| **平台请求第 6 号 · 后台作业不跨 turn** | fixed / focused-verified / original-counterexample-replayed / live pending | 修复 `dsh-jobs-local` 的 owner teardown：Agent 在 turn 间被回收但对应 Session 仍存活时，保留该 Session 的 running job，后续 Agent 实例仍可 `list/read/wait/kill`；仅 Session 真正销毁或 `workspace/session-stop` 时取消、等待 settlement 并删除。无 Session registry 的旧环境仍保持 owner-disposal 回收语义。回收点仍由 carrier teardown 触发，未采用打不中触发条件的 TTL 延长。 |
| **批次 209–222 · 其余内容** | no additional platform change | 批次 209–216 的运行、证据保全与载体裁定，以及批次 218–222 的 D-01 谓词、delta 复扫、端口避让和标本保护，均属 RustMc/Team 运行与记录纪律；没有新增 `B-*` 平台代码缺陷或回退条目。 |

### 第六十九轮验证

- 原始反例 `D:\dsh-test\phase11-tests\platform-defects-thirty-ninth-pass.test.mjs`：`2 tests / 2 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 size `297`，SHA256 `11FE982339812A8400AD7DD5F88F3194820AA63FB9EEBD5C7947AEB036164E42`。
- 第 5 号原始反例 `D:\dsh-test\phase11-tests\platform-defects-fortieth-pass.test.mjs`：`1 test / 1 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；文件 size `7462`，SHA256 `BB9D68BE1B33D2FD618BCE94E917FAF2159ED710D9EDAD81CFDE60545A5DF56E`；日志 SHA256 `F758ED1579DAAA978503F3A9B01BF2593D52BB6FFC545CFB6B4BA515D042E29E`。
- platform-defects 聚焦集：`219 tests / 219 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 size `38361`，SHA256 `A9CA6A9250677C9532109C76C8DD01E83245A88EC06532FA0E124448B7268AF1`。
- phase1-phase11 串行全量：`540 tests / 539 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 size `164503`，SHA256 `3DEDC413164436FCF5FA53894C743657C587BB0118A6EB66843982DC0645CCBE`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`；日志 size `634`，SHA256 `02491D7D7F976B9B58BCA3EA64555B5FBB6D96EB10A75BB4E3319586CB71A418`。
- `dsh-jobs-local/lib/index.js` 与第 39/40 个测试 `node --check`：`3/3` 通过。四个 pnpm 物理副本均为 size `41588`、SHA256 `DB57F8DA66BFE2B8D0AD71CCA8EAEBC10946A2FF4DFA0F8C2E40F7A9347EB110`；当前 web/headless/desktop/teamtest 仍解析到该共享 app 包。

### 第六十九轮未闭合

- 第 4 号与第 6 号的源码修复均写入于 PID `31528` 启动之后；按用户约束未重启，二者保持 live pending。第 4 号的 root 即时 workaround 已 live verified，第 6 号必须等后续进程加载或下一次受控重启后复核跨 turn 作业。
- 第 3 号已在运行实例 live verified；第 5 号无平台修改，关闭为“原前提被隔离反例否证”。
- RustMc 的 D-01 谓词与 delta 返工由产品线继续执行，不属于 DSH 平台 profile 修改。

### 第六十九轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch209-222-root-result-20260930.md`，size `2356`，SHA256 `D986C9511FA72E730BDEBD004BA7DAC9A97B18D0BCD9E2C8D7CC05860B8BAFD4`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true / RpcIdMatch=true`。按服务端接纳记录，不冒充 assistant ack。

## 第七十轮修复（2026-09-30 · 批次 223–225；B-213c 诊断归因）

- 输入清单指纹：起始为第六十九轮末的 size `1495015`、SHA256 `2686B59030C0832E64C8AEE25E8EF135FCB55C9A5C600A63763D1C5D1C5E0B3E`、mtime `2026-09-30T06:17:53.7011857Z`；交付前重读推进到批次 225 的 size `1513763`、SHA256 `44712EFB68FD4E229E3BDE48C4711A2AF3418F59C487F2B0C987A41E0CE9D3B3`、mtime `2026-09-30T06:44:06.9127494Z`。root 结果发送后清单继续前移到批次 226 的 size `1515653`、SHA256 `616329F0713D03CFF4E78A5A654BA5086742879C3E1CE97CB6DB00E939621A39`、mtime `2026-09-30T06:49:11.8172137Z`，再前移到批次 227 的 size `1521570`、SHA256 `1359DD7A90F4BBC658EF2184A8E2B412B736A6C10B35470F08C751276256121B`、mtime `2026-09-30T06:51:49.4484375Z`。批次 226/227 分别只更正 `task-113` 建卡事实和收编 world 组、记录 park 写面纪律，没有新增平台代码变化；本轮最终指纹采用批次 227 三值。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-batch223-b213c-20260930-143900`，包含修改前四份 `write-scope-guard.mjs`、台账、watch state 与当时清单。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **B-213c · 无 lease 的 `pwsh/powershell -File` 误报 opaque** | fixed / focused-verified / original-counterexample-replayed / live pending | 四变体 A/B/C/D 在无 lease 时统一复用已有的“member … has no declared static scope or active approved plan lease … active lease: none”诊断；不再声称命令必然能通过 inline interpreter 或 opaque expression 写入。持有效 lease 的普通 `-File` 与 `-OutFile` 形式仍允许；带 `&` 的组合仍 fail-closed 并具名为 `[explicit-file-required]`。未改变授权、scope、carrier 或 fail-closed 语义。 |
| **批次 223 addendum · c13/C10 与 check 集覆盖** | no additional platform change | 292/293 是测量与判据覆盖纪律；没有新增 DSH profile/source/test 修复点。 |
| **批次 224 · 判据域 = 整仓，delta = 审阅域** | no platform change | 75 处/11 文件的整仓普查、载体集重报和 verifier 路由均属 RustMc 产品线；不修改 DSH 平台代码。 |
| **批次 225 · `grp/proto` 落地与请求 3–6 处置** | no additional platform change | 平台请求第 3 号维持 live verified；第 4/6 号维持既有 profile fixed / live pending；第 5 号维持原前提被反例否证。没有新的 `B-*` 平台代码缺陷或回退条目。 |
| **批次 226 · `task-113` 建卡事实更正** | no additional platform change | 批次 224 所称“已立卡”在当次调用中实际被 `[cross-board-blocker-unsupported]` 拒绝；随后已用 board-qualified 依赖重建 `task-113`。本条只修正记录事实并登记纪律 299，不修改平台代码。 |
| **批次 227 · world 组收编与 park 写面** | no additional platform change | 保留 `lead-world-3` 为唯一 tier-1 组长、冻结另两名组长，以及“park 不释放写面”的串行观察，均属 Team/RustMc 运行与排程纪律；没有新增 `B-*` 平台代码缺陷或回退条目。 |

### 第七十轮验证

- 新原始反例 `D:\dsh-test\phase11-tests\platform-defects-forty-first-pass.test.mjs`：`3 tests / 3 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；文件 size `4793`，SHA256 `8675341C0CC346BD9FAF83614392DEF9AE779C4F78BDE4D4375803456C17B5E4`。
- 既有 B-218 反例更新后：`7 tests / 7 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；文件 size `7161`，SHA256 `AA3668AA4F9D5C07101ACDDC21BFFE2BE9F48539C82F77CAF0EFB02A0EDEA516`。
- platform-defects 聚焦集：`222 tests / 222 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch223-b213c-focused-20260930.log`，size `38922`，SHA256 `33A64A3CA9665F14ADCEBBCBE7C833E0B366325864D53D66E4776468416E184B`。
- phase1-phase11 串行全量：`543 tests / 542 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch223-b213c-full-phase1-phase11-serial-20260930.log`，size `165002`，SHA256 `A54BF7B401C8277A5DC2EC5AB1CD546ACBA958BEAA363CD4314925E44ADC78C0`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`；日志 size `634`，SHA256 `FFB6838A6CD4C33B70B61AD689FCBF1430BCA06438E8F9AD985DBF60EEBB072F`。
- 四份 `write-scope-guard.mjs` 与两份测试 `node --check`：`6/6` 通过；四份 guard 均为 size `64069`、SHA256 `9688D376C208B4F32CB0C6228448C7206479AB6CADC9779E452F12CF4E746864`。

### 第七十轮未闭合

- 修复写入于 PID `31528` 启动之后；未重启 DSH，因此本轮不宣称 live verified。运行实例仍可能显示旧诊断，需下一次受控加载后复核。
- `-OutFile` 的允许仅在已批准脚本载体和 scope 判定通过时成立；`&` 或其它 shell 组合仍按既有边界 fail-closed。

### 第七十轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch223-225-root-result-20260930.md`，size `1891`，SHA256 `7E9E2CD8035D8AD33BC888865CEE98565203F6FDB310FCEB2339995F0DE1029F`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true / RpcIdMatch=true`。按服务端接纳记录，不冒充 assistant ack。发送后到达的批次 226/227 无平台代码变化，不改变本报告修复结论，只把最终清单指纹推进到上述三值。

## 第七十一轮检查（2026-09-30 · 批次 228–233；B-213c live verified）

- 输入清单指纹：从第七十轮末的 size `1521570`、SHA256 `1359DD7A90F4BBC658EF2184A8E2B412B736A6C10B35470F08C751276256121B`、mtime `2026-09-30T06:51:49.4484375Z` 前移到批次 233 的 size `1547578`、SHA256 `B4B7EE49C4810A3058A7C54BB484032B35112DF050950331A7A77F9B70B237F0`、mtime `2026-09-30T07:04:11.3002209Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **B-213c · 无 lease 的 `-File`/不可核验命令诊断** | live verified；无新增代码修改 | 批次 228 给出同一会话内的前后对照：旧串为 inline/opaque，当前串为 `command verification failed [active-plan-required] … no declared static scope or active approved plan lease … active lease: none`。这同时覆盖批次 223 登记的“非 `-File` 的核验失败”第二张脸；因此把第七十轮的 live pending 更正为 live verified。 |
| **批次 228–233 · RustMc/Team 运行与记录** | no platform change | 包含 `grp/proto` 落地、判据域/载体、普查自指与缺席、冻结前耐久载体、豁免集封闭、D-01 谓词边界、相位推进和跨组命名接口；没有新增 `B-*` 平台代码缺陷或回退条目。批次 231/232 的 tier-1 相位边界和落地驱动相位是既有平台边界/流程建议，未形成可独立复现的平台代码修复请求。 |

### 第七十一轮验证

- 没有新增平台源码修改，因此不重复四 profile 同步、语法、聚焦或全量回归；第七十轮的 `222/222` 聚焦、`543 tests / 542 pass / 0 fail / 1 skipped` 全量、profile parity `1/1` 证据仍有效。
- B-213c 的运行实例证据来自清单批次 228 的一手前后对照；不把本轮文档更新冒充新的代码验证。

### 第七十一轮未闭合

- 批次 231/232 的 tier-1 不能直接推进 `integrated` 是既有 phase-owner-terminal 边界；当前只记录“落地驱动相位”建议，不越界改动运行中 Team。
- 其余 D-01、普查和组协调工作仍属 RustMc/Team 产品线。

## 第七十二轮检查（2026-09-30 · 批次 234–238；B-220 live verified）

- 输入清单指纹：从第七十一轮末的 size `1547578`、SHA256 `B4B7EE49C4810A3058A7C54BB484032B35112DF050950331A7A77F9B70B237F0`、mtime `2026-09-30T07:04:11.3002209Z` 前移到批次 238 的 size `1567461`、SHA256 `CA187F4CBA7F417CC3FDE4315A3BDB52C0ED50BBCA0A170F4C28B1C547CD686D`、mtime `2026-09-30T07:10:36.4398055Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **B-220 · `waiting_set` 同一 task 的旧票仍 open** | live verified；无新增代码修改 | 批次 235 的一手运行读数显示：改正陈旧等待票后，平台自动关闭旧票，返回 `closedReason: deduplicated` 且 `supersededBy` 指向新票。原始反例的“旧票仍 open、SLA 继续对陈旧票面开火”未再出现。四份 `team-v14-waiting.mjs` 当前均为 size `29499` / SHA256 `D3021162B321299ABD3AC23CD5D0F56104D201E07E86FE7078B4A7E3862CAAA0`，文件时间早于 PID `31528` 启动时间，运行观测与已加载修复一致。 |
| **B-213c · 无 lease 的不可核验命令诊断** | live verified；维持第七十一轮结论 | 批次 228 的同一会话前后对照仍成立，无需重复修改。 |
| **批次 234–238 · RustMc/Team 运行与记录** | no platform change | 批次 234 登记精确 token、零假阳性和卡内可判据；批次 235 细化 B-220 的 dedup 行为，并记录合同正文与已批计划是不同载体；批次 236 处理 rig 就绪判据、可操作分母和 scope 层级；批次 237 区分当前输入读数与未来输入性质；批次 238 要求旧契约上的在飞计划拒批重提。均未新增 DSH `B-*` 代码缺陷或 `WORKAROUND-REVERT.md` 回退条目。 |

### 第七十二轮验证

- 没有新增平台源码修改，因此不重复四 profile 同步、语法、聚焦或全量回归；第七十轮的 `222/222` 聚焦、`543 tests / 542 pass / 0 fail / 1 skipped` 全量、profile parity `1/1` 证据仍有效。
- B-220 的状态变更依据批次 235 的运行实例读数；不把文档更新冒充新的源码修改。

### 第七十二轮未闭合

- 批次 231/232 的 tier-1 相位边界、A-6 动态外部程序写盘风险和 B-214 目录前缀 scope 仍保持既有未闭合状态。
- 其余 D-01、普查、rig 就绪判据和组协调工作仍属 RustMc/Team 产品线。

## 第七十三轮修复（2026-09-30 · 批次 239–245；owner-inactive unplanned scope recovery）

- 输入清单指纹：size `1598282`，SHA256 `51956AEAABA00CC65C15F200EA9E80FBDE7EDDC40D94DF63D8EF8F038B6018C7`，mtime `2026-09-30T07:34:11.7078233Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-b47-20260930-151905`，包含修改前的四份 `team-tools-v2-r10.mjs`、两份清单、台账和 watch state。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 实现与验证 |
|---|---|---|
| **批次 239 的 unplanned scope recovery（清单原文标作 `B-47`）** | fixed / focused-verified / original-counterexample-replayed / live pending；台账按 `B-223` 去冲突 | 既有 `B-47` 是 waiting reconciler 的 `manual` 自动解除缺陷，仍保持 open；批次 239 误用了同一编号，因此本轮实现按未占用的 `B-223` 入账，不改写原 `B-47`。`team-tools-v2-r10.mjs` 新增 `taskScopeRecoveryVerdict()`，只允许 tier-1 组长在自己的 `group-<group>` 板、任务 owner 具名且不处于 running/provisioning、任务无活动 lease、无计划、状态为 pending/in_progress、且新 scope 非空时，直接修正该卡的 `write_scopes`。`taskEditWriteScopeVerdict()` 仅在此窄判定通过时放行；有计划、跨组、非组长、owner 活跃、活动 lease、终态或空 scope 全部 fail-closed。`team_task_update` 在更新前计算 `planExists`、`ownerActive`、`activeLease` 并接入该判定。 |
| **批次 240–245 · RustMc/Team 运行与记录** | no platform change | 批次 240–242 是 rig 判据、里程碑、分母与证据载体纪律；批次 243 修正 RustMc 文档中的裸相对引注；批次 244 更正二分前提与群发 `reason` 边界；批次 245 把 String seed 与 `verify.ps1` 的陈旧第二实现归回 RustMc 产品线。以上均未新增 DSH `B-*` 代码修复点或 `WORKAROUND-REVERT.md` 回退条目。 |

### 第七十三轮验证

- 原始反例重放：`platform-defects-forty-second-pass.test.mjs` 的 inactive-owner 修复路径成功；owner active、active lease、跨组、有计划、非组长五类负控均拒绝。该文件 `4 tests / 4 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`。
- 四份 profile 的 `team-tools-v2-r10.mjs` 均为 size `424731`、SHA256 `900E7F992F85DC629E0A5AA957ABAD0EEE91FD0343B2BF623220E830C82FAA14`；新测试 size `8510`、SHA256 `1783079859C618D23EB2E31A4197C0B7B5E7F4116324996A10E21A507EE30E3F`。四份 profile 与新测试 `node --check`：`5/5` 通过。
- platform-defects 聚焦集：`226 tests / 226 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-b47-focused-platform-verify-20260930.log`，size `39797`，SHA256 `E12897BF3BD66D3B56307FF470404D4FD67F8B1DB098F64E6425C68D8CF2EDF0`。
- phase1–phase11 串行全量：`547 tests / 546 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-b47-full-phase1-phase11-serial-verify-20260930.log`，size `165848`，SHA256 `762BD8FE1E52F1C02EFF67786C648F4BFA74B9215085963626B3F090C733338C`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-b47-profile-parity-verify-20260930.log`，size `634`，SHA256 `68FA258F49FE0BF637DDB859B205C12590121D822C4772ECBF694AFAD44A42B8`。

### 第七十三轮未闭合

- 修复文件时间晚于 PID `31528` 启动时间；未重启 DSH，因此本项只记 `source fixed / focused-verified / original-counterexample-replayed / live pending`，不宣称 live verified。运行中 Team 保持不中断。
- 批次 239 的编号冲突只在本轮台账中以 `B-223` 区分；RustMc 清单未修改，原 `B-47` waiting reconciler 缺陷仍保持 open。

### 第七十三轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch239-scope-recovery-root-result-20260930.md`，size `1820`，SHA256 `85544D435FD46EE40F48A037EAF62A96FB3B2954A0B1CA7EBFD5A2B24F9721D3`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true / RpcIdMatch=true`。session projcache 已记录 `turn 483 / seq 66874`；发送时尚未出现对应 `assistant/message`，因此按已入队记录，不冒充 assistant ack。

## 第七十四轮检查（2026-09-30 · 批次 246–248）

- 输入清单指纹：size `1612310`，SHA256 `8D5C2FEDD98BBDB9491737B41532A85178D85D802F8E88B2EADF9F7B7F55C0C4`，mtime `2026-09-30T07:42:17.9157043Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓；当前 DSH PID `31528` / 端口 `40123` 保持。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **批次 246 · K5 子状态、红基线不可复现与 rig-runner 作业事故** | no platform change | K5 可打印子状态、`46/78/124` 计数、红基线不重跑、作业 `{kind:"background"}` 读取错误与 scratch 删除边界均属 RustMc/rig 运行与仪器线；`rig-runner` 已明确自报为自身流程错误，不是平台缺陷。本批同时确认第七十三轮 B-223 仍为 `source fixed / focused-verified / live pending`。 |
| **批次 247–248 · 可比层级、目标作废、覆写集合与适用域** | no platform change | 批次 247 修正文件级 diff 与行为级可比性的边界，并作废“把 124 打到 0”的目标；批次 248 补齐基类读数的覆写适用域。均属 RustMc 产品/验证线，没有新增 DSH `B-*` 代码修复点或回退条目。 |

### 第七十四轮验证

- 没有新增平台源码修改，因此不重复四 profile 同步、语法、聚焦或全量回归；第七十三轮的原始反例 `4/4`、聚焦 `226/226`、全量 `547 tests / 546 pass / 0 fail / 1 skipped`、profile parity `1/1` 证据仍有效。
- 本轮只更新清单检查记录与 watch state；B-223 的 live 状态不因后续文档批次改变。

## 第七十五轮检查（2026-09-30 · 批次 249–252）

- 输入清单指纹：size `1629357`，SHA256 `71D355453FD2E0F9C96A315FA4F68EB919E58422A5D92DCF41B35E39CA44DC16`，mtime `2026-09-30T08:11:33.8769746Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- DSH 已由操作者重启，当前监听 PID `4004` / 端口 `40123`，启动时间 `2026-09-30T15:49:18+08:00`，晚于 B-223 的四份 profile 修改时间。本轮自身未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓。

| 清单项 | 状态 | 处理与验证 |
|---|---|---|
| **批次 249 · 重启满足退出门、O1 样本被切断** | no platform change | 退出门被重启满足但运行未完成，必须以收尾哨兵判定 `terminated-by-restart`；后续绿跑门、孤儿 `36692` 归属与 Team 唤醒均属 RustMc/rig 运行线。B-223 现已随新 PID 加载，但仍不写成 live verified；等待一次真实 tier-1 组长实例，不为验证人为造卡。 |
| **批次 250–252 · 仓级门、fail-fast、登记激励与跨组写面** | no platform change | `citation_integrity` / `ps1_line_citations` 的仓级红、`--no-fail-fast` 读数、登记与删精度激励、`t157` 锚登记 owner 均属 RustMc 产品门与 Team 协调线。批次 251 的建议号 `B-224` 是对 RustMc gate 设计的观察，不是 DSH profile 缺陷；本轮不修改产品仓。 |

### 第七十五轮验证

- 没有新增 DSH 平台源码修改，因此不重复四 profile 同步、语法、聚焦或全量回归；第七十三轮的原始反例 `4/4`、聚焦 `226/226`、全量 `547 tests / 546 pass / 0 fail / 1 skipped`、profile parity `1/1` 证据仍有效。
- B-223 的状态由 `source fixed / focused-verified / live pending` 细化为 `loaded by PID 4004 / live verification pending real tier-1 instance`；不把进程重启或插件已加载冒充真实反例验证。

## 第七十六轮修复（2026-09-30 · 批次 253–283；B-227 至 B-235）

- 输入清单指纹：size `1725861`，SHA256 `027C9A069A83D14B14E1DC2D1AE21B09340D14D914C742A31E1C325AD451DA05`，mtime `2026-09-30T09:46:11.8182780Z`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-batch253-271-20260930-172128`，包含本轮修改前目标 profile、台账、watch state、清单与 `WORKAROUND-REVERT.md`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓。当前 DSH PID `16440` / 端口 `40123`，启动于 `2026-09-30T16:37:18+08:00`，早于本轮 profile 修改时间，因此本轮统一记 `source fixed / focused-verified / live pending`。

| 编号 | 状态 | 实现与验证 |
|---|---|---|
| **B-227** | fixed, focused-verified; live pending | `team-tools-v2-r10.mjs` 在全局板创建及 `reassign` 时调用 `taskOwnerBoardWriteVerdict()`；全局板 owner 只能是 tier 0，未分配卡仍可后续指派，tier-1 owner 在构造阶段即被拒绝。 |
| **B-228** | fixed, focused-verified; live pending | `team-v12-contract.mjs` 与 `team-v12-evidence-scheduler.mjs` 的 scope 扫描排除“声明候选卡为未满足依赖”的 active task，避免 A 等 B 让文件、B 又依赖 A 的假冲突死锁；无依赖的真冲突仍判红。 |
| **B-229** | fixed, focused-verified; live pending | 保留既有 `waiting_set` 同 waiter/task 的 upsert 行为；`waiting_resolve` 新增显式 `resolution_kind:"superseded"` + `superseded_by` 路径，写回 `closedReason:"superseded"` 与 `supersededBy`，明确表达“SUPERSEDED，condition NOT met”。 |
| **B-230** | fixed, focused-verified; live pending | `allowedTaskPhaseTransitions()` 与 `taskPhaseRecoveryActions()` 暴露相位机的出边和恢复动作；`advance_phase` 拒绝串枚举允许下一相位，并点名 `blocked/rejected/cancelled/expired -> reopen`；`task_contract_get` 返回 `phase`、`allowedTransitions`、`recoveryActions`。 |
| **B-231** | fixed, focused-verified; live pending | scheduler shadow advice 新增 `executorInactive` 与具名 `stalledTasks`，包含 taskId、owner、executionState 和原因，不再只给停滞计数。 |
| **B-232** | fixed, focused-verified; live pending | `send_message(delivery:"decision")` 的 `message` 改为可选；`team_wake_superior` 接受同名可选字段并纳入控制消息。只按 `blocked_action + reason + evidence` 调用规范工具或别名均不再因缺 `message` 被 schema 拒绝。 |
| **B-233** | partial / no safe platform change | `scopesOverlap()` 的目录 claim 仍对子路径 fail-closed：宽目录 owner 仍可能写其中任意文件，自动放宽会让“更精确声明”覆盖仍承重的写面。当前唯一安全路径仍是串行或搬家；新增回归锁定该边界，不伪造修复。 |
| **B-234** | fixed, focused-verified; live pending | `bind_fix` 对 discussion/review 或零 `writeScopes` 的 completed 卡接受 `commit_sha:null`/缺省，只要求真实 `evidence_ids`；edit 卡仍必须提供精确 40 位 commit。补绑只改 ledger pointers，不改状态、相位、owner 或 readiness。 |
| **B-235** | partial / no safe platform change | `team_acceptance_packet.task_ids` 仍是逐卡相位清关集合；含未完成卡的整支分支只能把 `wholeBranchCards`、`phaseTails` 写入 requirements/checks/meta，不能伪装成已过 packet phase。把清关对象改成分支需要新的、可验证的整支重建语义，本轮不做高风险放宽。 |
| **B-224 / B-225** | no platform change | 均为 RustMc `citation_integrity` / `ps1_line_citations` 的门设计观察；不属于 DSH profile 代码载体，本轮未修改产品仓。 |

### 第七十六轮验证

- 新增原始反例 `phase11-tests\platform-defects-forty-third-pass.test.mjs`：`7 tests / 7 pass / 0 fail / 0 skipped`，覆盖 B-227/B-228/B-230/B-231/B-232/B-233/B-234。
- 四份 profile 的七个目标文件 `node --check`：`28/28` 通过。
- platform-defects 聚焦集：`233 tests / 233 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch253-271-focused-final-20260930.log`，SHA256 `701497EF9BA2F4B3730F8CF936C7CAEBC910457A11E0B3D0ECBEAA29584C98B9`。
- phase1–phase11 串行全量：`554 tests / 553 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch253-271-full-phase1-phase11-serial-final-20260930.log`，SHA256 `DB577D0D7B38C8C39409376E2058815D7297FE777C00C868848B08DAA788E1ED`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch253-271-profile-parity-20260930.log`，SHA256 `A9D491024A23B15B54B631027B18B69FCC7533CFA769347B18F86CA1178495C7`。

| 文件 | size | SHA256（四 profile 一致） |
|---|---:|---|
| `team-v12-contract.mjs` | `29469` | `B3141F991BC0D094336E9E3D69EE27D3CE6D7992F6BB2A751C6B76E7F7DB83DC` |
| `team-v12-evidence-scheduler.mjs` | `44094` | `324DDF831C8D515820D7C249B1AC607CE55F95560817D4B4B81A91309B7F9096` |
| `team-control-plane.mjs` | `215478` | `4D9B074775EBA998461EC0D684DB711555BEFFCA1C0FC2F5940CE84EBCC7A01D` |
| `team-policy.mjs` | `40310` | `4D9F010D061F164F8F124C9A538E34B4B2A18CA0DCCB2DD73D1E4870CC362A84` |
| `team-v12-runtime.mjs` | `148944` | `351E405A8CAB7B5B64533A05E4758F6B604C78C0B1B7D47547CD38DBDDA0F94E` |
| `team-tools-v2-r10.mjs` | `427050` | `F0E36AC4B00D4E84D60574B11834F7720217EA12F76C1DA51F0557A5CEB578DF` |
| `team-v14-waiting.mjs` | `30101` | `7C6FAA12FA5243B4E60AA34E7786C3864D37B174CDCBB53EE7C539A3E31CA915` |

### 第七十六轮未闭合

- 当前 DSH PID `16440` 早于本轮源码修改；未重启进程，B-227 至 B-232、B-234 只记 source fixed / focused-verified / live pending，不宣称运行实例已加载。
- B-233 仍需要串行或搬家，B-235 仍需要等未完成卡达到 packet phase；两者是明确的 `partial`，不把 meta 中的相位尾巴冒充平台清关。

### 第七十六轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch253-271-root-result-20260930.md`，size `3092`，SHA256 `3873AFE3888D4CDCFC261EC3FB933DEA96C1AF06FE974352D87468F060F75B11`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true / RpcIdMatch=true`；按队列接收记录，不冒充 assistant ack。
- root 会话随后提交批次 284（commit `bb2a65a6`），只在 `PLATFORM-DEFECTS.md` 记录本轮结果，没有新增平台缺陷或代码修改。清单最终指纹更新为 size `1729624`、mtime `2026-09-30T09:51:48.0581887Z`、SHA256 `EACFA99667D5FD33DF65DA9A4B4325D231441D4CEE04FBD19AF7CF5351464BBD`；`WORKAROUND-REVERT.md` 仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 运行态 HMR 已完成：2026-09-30T10:04:12.3259628Z 仅更新本轮七个 web profile 插件的 mtime，触发既有 HMR watcher 重新导入；文件 size/SHA256 不变。PID `16440` 与启动时间不变，`team-health-web.json` 于 2026-09-30T10:04:12.703Z 重算为 `status=healthy / reasons=[]`。HMR 说明 `D:\dsh-test\docs\platform-defects-batch253-271-hmr-note-20260930.md` 已发送至 root 会话，RPC `HTTP 200 / ok=true / accepted=true / RpcIdMatch=true`。

## 第七十七轮修复（2026-09-30 · 批次 285–289；B-236、注释抽取、merge 半场与 inbox）

- 输入清单指纹：size `1764976`，mtime `2026-09-30T10:39:05.1657171Z`，SHA256 `29A56D6B7E97B382D4D2B44F3D4F5EA50EE747AF13767F124F385FF50855CBC2`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-batch285-289-20260930-183435`，包含本轮修改前目标 profile、台账、watch state、清单与 `WORKAROUND-REVERT.md`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓。当前 DSH PID `16440` / 端口 `40123` 保持。

| 编号 / 清单项 | 状态 | 实现与验证 |
|---|---|---|
| **B-236 · plan replacement recovery** | fixed, focused-verified; HMR loaded; live-behavior replay pending | `team-control-plane.mjs` 统一导出 `PLAN_REPLACEMENT_RECOVERY`，同时列出路径 A（完成、记录精确 commit/evidence、释放 completed lease、replace plan、re-acquire）与路径 B（在飞时 release/cancel lease、replace plan、re-acquire）。`team-tools-v2-r10.mjs` 的 scope 拒绝串同时保留 `replace the plan` 兼容文本并给出两条路径。 |
| **PowerShell 注释文本路径误抽取** | fixed, focused-verified; HMR loaded | `write-scope-guard.mjs` 新增 `maskPowerShellComments()`，在 `shellWriteTargets()` 提取路径前屏蔽 `#` 行注释与 `<# ... #>` 块注释；字符串中的 `#` 保留。原始反例和负控均由新增测试覆盖。 |
| **`team_merge` 源单位歧义** | fixed, focused-verified; HMR loaded | `team_merge` 新增显式 `source: "commit_sha" | "branch_head"`，默认仍为 member-to-group `commit_sha`、group-to-main `branch_head`；`branch_head` 必须证明卡面 commit 是分支尖祖先。回执输出 `sourceSelection`、`taskCommit`、`mergeSource`。 |
| **`team_merge` git/相位部分生效** | fixed, focused-verified; HMR loaded | 回执新增必填 `gitApplied`，`phaseAdvance.status` 明确为 `advanced` / `already-at-or-beyond` / `failed`；git 已应用而相位推进失败时保留 `phaseAdvance.code/reason`，不再把整个操作伪装成纯失败。git 应用失败仍 fail-closed，并在拒绝串具名 `git application failed before phase advance`。 |
| **收件箱不可清空 / 空 legacy wake 重投 / ack 自锁** | fixed, focused-verified; HMR loaded | `team-v12-runtime.mjs` 的 `inbox_list` 直接返回唯一可 ack 的顶层 `wakeId` / `wake_id`；空正文 legacy wake 不再注入上下文；`team-v13-failure-memory.mjs` 将 `inbox_ack` 的确定性失败归为 `stale-state`，不累计永久锁定阈值。 |
| **`team_worktree_setup` 静默夺走他人写根** | fixed, focused-verified; HMR loaded | 新增 `worktreeTargetVerdict()`；任务已有 owner 且与 `target` 不一致时以 `worktree-task-owner-mismatch` fail-closed，要求先 reassign。未分配任务仍可布局。 |
| **清关键按 commit 绑定、不能继承相同 tree** | partial / no safe platform change | 没有把 clearance 从 commit-key 放宽为 tree-key。相同 tree 的裁决继承需要新的、可验证的证书继承模型；当前继续 commit-bound fail-closed，不伪造 tree clearance。 |
| **`destination-worktree-dirty` 阻断 tier-0 未提交台账** | no platform change | 门禁本身正确；本轮保留落地窗口必须干净的边界，未放宽脏树检查。 |

### 第七十七轮验证

- 新增原始反例 `D:\dsh-test\phase11-tests\platform-defects-forty-fourth-pass.test.mjs`：`7 tests / 7 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；size `5779`，SHA256 `8C300DA25DD45B625F8D129DA73B3D9BAF7906A3166D01406B40353CF8559941`。
- 四份 profile x 五个目标文件 + 新测试 `node --check`：`21/21` 通过。
- platform-defects 聚焦集：`240 tests / 240 pass / 0 fail / 0 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch285-289-focused-platform-tests-r2-20260930.log`，size `42204`，SHA256 `FF537F523E79721214DB1183C3B9D7CACC384FFEA476D6AD920D8A70964B3B03`。
- phase1–phase11 串行全量：`561 tests / 560 pass / 0 fail / 1 skipped`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch285-289-full-phase1-phase11-serial-r2-20260930.log`，size `168546`，SHA256 `4A4346DE69F08BCFC4817E38878BAA31F23D78EDECA99A1AE10F7C2D77931A4A`。
- profile parity：`1/1 pass`，`EXIT_CODE=0`；日志 `D:\dsh-test\output\platform-defects-batch285-289-profile-parity-r2-20260930.log`，size `631`，SHA256 `4F8DFF5F074DB22041B746BC1E96D88C2123B6B4DA8BBB9E658E8A71FA71F7EA`。

| 文件 | size | SHA256（四 profile 一致） |
|---|---:|---|
| `write-scope-guard.mjs` | `65851` | `18C91C2766ED909B1AF29373B9C1D19223CA0E84AE419A9F08160E819B359416` |
| `team-tools-v2-r10.mjs` | `433234` | `1C2DD3E14450FEABDAD2CEDEB0E6BFFA0EBC219046B9C47215BFDD5D64415DBE` |
| `team-control-plane.mjs` | `216120` | `42F7B2DB678AFBA6175D7BC432EA9E6DA3B5C881F3858E0FFF4F749CFFABA017` |
| `team-v12-runtime.mjs` | `149730` | `80CABBE985A2F203C51CE0386B039A13F6A9199D0210D2DD5BB255FBBBA15258` |
| `team-v13-failure-memory.mjs` | `13016` | `D8C4BFD7EB890E66389484CB28B3A37965F3E248886D681651EA3D8A85D8396A` |

### 第七十七轮运行态

- HMR：`2026-09-30T10:55:27.7922151Z` 更新 web profile 五个目标插件的 mtime，文件内容哈希不变；PID `16440` 与启动时间不变。
- `D:\dsh-test\home\team-health-web.json` 于 `2026-09-30T10:55:32.3360884Z` 重算为 `status=healthy / profileParity=healthy / reasons=[]`。
- 为避免中断 active Team，本轮没有在 live root Room 重放需要真实 tier-1/tier-2 状态的原始反例；源码和聚焦反例已验证并已由 HMR 加载，live-behavior replay 仍待后续自然实例。

### 第七十七轮 root 说明

- 报告文件：`D:\dsh-test\docs\platform-defects-batch285-289-root-result-20260930.md`，size `4093`，SHA256 `7829CEDFB21D8287202392F8F5004876C1EC2CC6A6372C737FC1404D70B63201`。
- 已发送至 root 会话 `session-028e6f5b-1716-4c23-a232-af16d853d191`：RPC `HTTP 200 / ok=true / accepted=true / RpcIdMatch=true`；按服务端接纳记录，不冒充 assistant ack。

## 第七十八轮检查（2026-09-30 · 批次 290–291）

- 输入清单指纹：size `1779544`，mtime `2026-09-30T12:26:51.7419308Z`，SHA256 `A994D4480C9A311D724BA1CF2DF6221510FA4A475915796042255CAB114827DC`。`WORKAROUND-REVERT.md` 未变化，仍为 size `29392`、SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 批次 290：记录第七十七轮修复回执，以及 RustMc/rig 对“中止不是红”、夹具行号、陈旧锁、死锁和落地决策的约束；属于 RustMc/rig 与协调流程，不产生 DSH profile 代码变更。
- 批次 291：仪器“头注与实现不一致”属于 RustMc guard；纯快进通则、SLA 和票面纪律属于协调/产品线语义，不产生 DSH profile 代码变更。
- 本轮结论：`no platform change`。没有新增或修改且尚未通过原始反例验证的 DSH profile 缺陷，不修改源码或四份 profile；第七十七轮的语法、聚焦、全量、parity 与 HMR 证据继续有效。
- 约束保持：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓。

## 残余风险

- A-6：无法在插件层对所有未知子进程做真正的 OS 级 sandbox；无显式输出参数的任意程序仍可能自行写盘。
- B-23：历史已分叉数据不会自动改写；下一次计划替换时会同步，task 行直接改 scope 会被拒绝。
- B-72：引用扫描域仍按目录名排除，产品仓未改；过渡期必须把私有 target 命名为 `target` 或移出扫描域。
- B-70 / B-75：后台作业的 job object 生命周期由 DSH/harness 控制；跨 turn 作业必须显式脱离 job object，并同时检查驱动进程与日志增长。
- B-214：目录前缀 scope 仍缺少可验证的文件集合；当前只在具名文件且能安全求交时才能放宽。
- B-215：平台缺陷已撤回；剩余的是部分成员会话 cwd 为仓根的 operator 配置问题，不能改写成平台门禁缺陷。
- 运行中的 Team 不中断；headless/desktop 新成员在下一次启动时读取已同步文件。

## 第七十九轮修复（2026-10-01 · B-237–B-257）

- 输入清单指纹：size `2000995`，mtime `2026-10-01T08:24:09Z`，SHA256 `6A71AAA8A58715A062329259B00F75D48BACC1570D4489FC0881B424AEE26998`。`WORKAROUND-REVERT.md` 未变化，size `29392`，SHA256 `52A1CE4FDF54E0A79CFE80232DBCD2BB4CE6961BA671E14B0012678C16F4DAF2`。
- 备份：`D:\dsh-test\backups\platform-defects-b237-b253-20261001-root-20261001-160341`；前一轮代理备份：`D:\dsh-test\backups\platform-defects-b237-b244-20261001-impl-b237-b244`。
- 约束：未重启 DSH、未中断 active Team、未清理 backups/spill/telemetry/session、未修改 RustMc 产品仓。当前 DSH PID `16440`、启动时间 `2026-09-30 16:37:18` 保持不变。

| 编号 | 状态 | 实现 / 判定 |
|---|---|---|
| **B-237** | fixed, focused-verified | `team_task_list` 回显 `total`、`returned`、`truncated` 与 `nextCursor`，正好达到 limit 不再静默表示“已读完”。 |
| **B-238** | fixed, focused-verified | `applyTaskEdit` 在 subject/description 仍为旧默认文本时同步 `contract.deliverable` 与首个默认 acceptance criterion；自定义验收文本不被覆盖。 |
| **B-239** | fixed, focused-verified | `set_dependencies` 同步 `task.contract.dependencies`、contract revision 和 digest，清空 blockedBy 不留旧投影。 |
| **B-240** | fixed, focused-verified | ready diagnostics 从 `row.unmet` 兜底补 `dependency-unmet`，即使 scheduler 原始 reasons 只给 no-plan 也能看见跨板依赖。 |
| **B-241** | fixed, focused-verified | 组板 `delete` 现在要求 `delete_reason` 并落盘 `deletionReason`；`admin_close` 仍保持 tier-0/global recovery 边界，未扩大为无审计的跨板删除。 |
| **B-242** | fixed, focused-verified | 控制面删除前扫描所有 board 的未删除依赖者，返回 `task-delete-dependents` 与依赖卡集合，避免先清 blocker 再把依赖图打断。 |
| **B-243** | fixed, focused-verified | waiting_set 对 task/owner/waiter 的单一开放责任票做 upsert；责任人变化更新原票而不累积新行，既有 explicit reason/condition 仍区分不同等待。 |
| **B-244** | fixed, focused-verified | pending/in-progress task 仅在有具名 blockedBy 或开放具名 waiting ticket 时允许 completed lease release，并回报 residual；无残余依据仍拒绝。 |
| **B-245** | already fixed, regression-verified | 当前 `write-scope-guard` 对 `git ls-tree`、`cat-file`、`log`、`rev-parse` 等只读命令的 `.ps1` 路径不再误报写入；未放宽真实写命令。 |
| **B-246** | fixed, focused-verified; HMR loaded | 增加 requester turn 起点跟踪与 `privilegeActivationAllowed`：批准发生在当前 turn 中时不在同一 turn 激活，保留到下一次 wake；idle 时结束 grant。 |
| **B-247** | partial / no safe profile-only change | 共享 reflog actor 与绕过控制面 ref 移动的归属问题需要平台/仓库级 ref 观测契约；本轮不伪造插件层修复。 |
| **B-248** | fixed by existing contract / documentation evidence | 当前 schema 与拒绝串已明确支持 `boardId:taskId`，现有 B-175 原始反例证明跨板依赖可解析并参与 ready gate。 |
| **B-249** | fixed, focused-verified; HMR loaded | `team_milestone(action:"list", target)` 现在只返回目标成员；未传 target 时才返回调用者可见集合。 |
| **B-250** | partial / policy semantics | tier-2 relay hop 的 SLA 计时属于协调策略，不在本轮 profile 工具中硬编码时钟语义。 |
| **B-251** | partial / policy semantics | 事件型解除条件与墙上时钟 SLA 的统一需要新的 continuation/SLA 契约；现有 waiting condition 不安全地伪装成事件期限。 |
| **B-252** | partial / product/test wiring | 模块可达性与 `mod` 接线属于 RustMc crate/test 结构，未修改产品仓；台账保留“跳过不等于通过”判据。 |
| **B-253** | no new code / existing syntax verified | 当前实现已支持合法 board-qualified dependency；矛盾样本属于错误 task id/历史拒绝串，B-175 已锁定合法语法。 |
| **B-254** | fixed, focused-verified; HMR loaded | `team_evidence_record` 写入后立即独立回读，回读不到则 fail-closed；`bind_fix` 新增 `evidence_mode:"replace"`，可移除错误 evidence 指针，默认仍 append 兼容旧调用。 |
| **B-255** | fixed, focused-verified; HMR loaded | `team_acceptance_packet` 顶层回执新增 `dispatched` 与 `dispatches[]`，显式列出 verifier/root dispatch id；空数组明确表示本次没有自动派发。 |
| **B-256** | partial / no safe historical rewrite | 新旧 wake/inbox 载体的 dedupeKey 合并涉及历史 session 数据迁移；本轮不重写收件箱历史，保留现有 episode/message 去重逻辑并登记风险。 |
| **B-257** | partial / no platform change | 扫描仓库根时把 worktree 副本计入对象数属于扫描器/产品仓语义；未在 DSH 写入门禁中擅自改变扫描范围。 |

### 第七十九轮验证

- 新增原始反例：`D:\dsh-test\phase11-tests\platform-defects-forty-fifth-pass.test.mjs`，覆盖分页、契约同步、依赖诊断、依赖删除、等待票去重、lease residual、权限窗口、里程碑 target、只读 git；`9 tests / 9 pass / 0 fail / 0 skipped`。
- 最新聚焦补充集（第十四、三十五、二十六、四十三、四十四轮 + v14 waiting + profile parity）：`88 tests / 88 pass / 0 fail / 0 skipped`；日志 `D:\dsh-test\output\platform-defects-b237-b257-focused-20261001.log`，SHA256 `1C4CFF12160D9BFC0A8CDB98AF3094A1F4D12CCB94BD8D3C6305FD1ADBF6B4F9`。
- 四 profile 目标文件语法检查：`16/16` 通过；日志 `D:\dsh-test\output\platform-defects-b237-b257-syntax-20261001.log`，SHA256 `BA278E75B286A4AB9F941A69990A34F5C05500548436537E27EF1D79575094C1`。
- 平台缺陷全集聚焦（本轮源码前一版）已验证 `249/249` 通过；本轮后新增回归集 `88/88` 通过。phase1–phase11 全量基线：`688 tests / 682 pass / 5 existing baseline failures / 1 skipped`，失败集中在 live-lab/request-message brand/schema drift，与本轮 Team defect 修改无关。
- profile parity：`1/1 pass`；HMR：更新 web profile 目标插件 mtime 后，`team-health-web.json` 仍为 `healthy / profileParity=healthy / reasons=[]`，PID `16440` 与启动时间不变。

### 第七十九轮残余风险

- B-247、B-250、B-251、B-252、B-256、B-257 仍需平台/策略/产品仓边界内的后续工作；本轮明确标记 partial/no platform change，不把文档或回执字段当成已修复行为。
- 运行中的 Team 不中断；headless/desktop/teamtest 已与 web canonical 目标文件同步，四份目标 profile SHA256 一致。
