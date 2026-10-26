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

## 残余风险

- A-6：无法在插件层对所有未知子进程做真正的 OS 级 sandbox；无显式输出参数的任意程序仍可能自行写盘。
- B-23：历史已分叉数据不会自动改写；下一次计划替换时会同步，task 行直接改 scope 会被拒绝。
- B-72：引用扫描域仍按目录名排除，产品仓未改；过渡期必须把私有 target 命名为 `target` 或移出扫描域。
- B-70 / B-75：后台作业的 job object 生命周期由 DSH/harness 控制；跨 turn 作业必须显式脱离 job object，并同时检查驱动进程与日志增长。
- 运行中的 Team 不中断；headless/desktop 新成员在下一次启动时读取已同步文件。
