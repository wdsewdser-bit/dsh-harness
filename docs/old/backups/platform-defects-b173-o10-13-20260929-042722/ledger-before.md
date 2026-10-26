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

## 残余风险

- A-6：无法在插件层对所有未知子进程做真正的 OS 级 sandbox；无显式输出参数的任意程序仍可能自行写盘。
- B-23：历史已分叉数据不会自动改写；下一次计划替换时会同步，task 行直接改 scope 会被拒绝。
- B-72：引用扫描域仍按目录名排除，产品仓未改；过渡期必须把私有 target 命名为 `target` 或移出扫描域。
- B-70 / B-75：后台作业的 job object 生命周期由 DSH/harness 控制；跨 turn 作业必须显式脱离 job object，并同时检查驱动进程与日志增长。
- 运行中的 Team 不中断；headless/desktop 新成员在下一次启动时读取已同步文件。
