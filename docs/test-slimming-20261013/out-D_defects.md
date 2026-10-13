# 包 D：phase11 platform-defects-*-pass 分析（只读，未改仓库）

总览（42 个文件 / 249 条 / 基线 31.4 s）
1. 耗时集中：真起 git 子进程的用例 23 条 ≈27.2 s（不含将删的 B-192）+ 真起 cargo 的 1 条 0.28 s，合计约占本包 90%；其余 200+ 条合计 <4 s。
2. 可证明重复、可 DELETE：4 条（thirty-fifth B-220 与 forty-fifth B-243 同场景；twenty-ninth B-192 被 nineteenth B-174 首条覆盖；thirty-eighth 两条被 forty-first 超集覆盖），预计省 ≈0.95 s（其中 B-192 就占 0.94 s）。
3. 仅 MERGE（不删断言、省 0 s）2 组；只断言文案/源码文本的 7 条（B-157/B-169/B-83/B-236/B-129/B-136/B-249）默认 KEEP，仅作用户裁决项，几乎不省时间。
4. SLOW-CANDIDATE（缺陷反例，只标不删）：fourteenth 8 条 11.5 s、seventeenth 1 条 4.4 s、nineteenth 4 条 3.3 s、fourth 2 条 2.1 s、fifteenth 3 条 2.05 s 等；fixture 复用（保持语义）估计再省 ≈3 s（以基线约 40–50 ms/次 git 进程估算），给出具体行号见各文件段。
5. 额外风险：12 个文件用绝对路径 `D:/dsh-test/home/...` 动态 import 插件（读主检出而非 stage 副本），见末尾「额外发现」。

> 约定：下文「test 侧 git」= 用例体里显式 `git(...)`/`execFileSync('git')` 次数；`worktreeAdd`/`mergeExact` 内部每次调用另会经 `runGit`（team-worktree.mjs:105-108，`execFileSync('git')`）起约 8–15 个 git 进程，未计入。节省秒数为估算，基线只给用例级耗时。

---

### phase11-tests/platform-defects-eighteenth-pass.test.mjs  (tests=3, ms=908)
- 判定: SLOW-TESTS
- 被测: team-worktree `cargoTargetIsolationVerdict`；team-tools-v2-r10 `mainAncestorSet`/`taskIntegrationVerdict`；team-v12-runtime-facts `buildRuntimeFacts`
- 理由/证据: B-173（L31-56）两次调用 `cargoTargetIsolationVerdict`，默认 `inspect=cargoTargetDirectory` 会 `execFileSync('cargo')`（team-worktree.mjs:177），真起 cargo，依赖本机装有 cargo；O-10-13 ancestry（L58-98）真 git：test 侧 11 次（init/config×2/add/commit/worktree add/add/commit/rev-parse/merge/rev-parse）+ `mainAncestorSet` 1–2 次。第三条纯内存。
- 可删用例: 无
- 可入 slow 的用例: `B-173: shared Cargo target...` 275 ms（真 cargo；`inspect` 可注入但那会改变被测语义，不建议）；`O-10-13: one main ancestry read...` 631 ms（真 git，单条无可复用 fixture）
- 风险: 均为缺陷反例，只标 SLOW-CANDIDATE；无删除。

### phase11-tests/platform-defects-eleventh-pass.test.mjs  (tests=5, ms=7)
- 判定: KEEP
- 被测: B-99..B-103 纯函数/状态机（identityRoleFile、selectTaskOccurrence、infoDeliveryReceiptStatus、clearanceGate、handleInboxMessage）
- 理由/证据: 全内存、7 ms；B-99 用 mkdtemp 写 4 个小文件，无进程。各条断言唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-fifteenth-pass.test.mjs  (tests=9, ms=2056)
- 判定: SLOW-TESTS
- 被测: taskIntegrationVerdict、clearanceDestinationMetadata/clearanceLandingVerdict、taskCommitShaVerdict/normalizeStoredTask 等
- 理由/证据: 3 条真 git，且 fixture 前缀完全一致：L87-92（B-158/B-163）、L113-118（B-159）、L217-222（B-161）均为 `init -b main` + config×2 + 写 base.txt + add + commit（5 次 git）。test 侧 git 次数：B-158 ≈9（L87-101）、B-159 ≈16（L113-155）、B-161 ≈6（L217-223）。
- 可删用例: 无
- 可入 slow 的用例: `B-158/B-163` 651 ms、`B-159` 1038 ms、`B-161` 361 ms（均真 git）
- fixture 复用: 在 `before()` 里建一个“init+config+base.txt+commit”的模板仓库，三条各自 `cpSync(template, join(directory,'repo'), {recursive:true})` 取代 L87-92 / L113-118 / L217-222（模板此时尚无 worktree，拷贝安全；之后各自的 `worktree add`/commit 不变，语义不变）。省 3×5−5=10 次 git ≈0.4 s。B-158 之后会 `git merge` 进 main（L101），B-159 依赖 main==base，所以不能共用同一个仓库，只能共用模板。
- 风险: B-157（L75-80）纯文案断言（见文案清单），B-170/B-162 等 0–2 ms 内存用例不动。

### phase11-tests/platform-defects-fifth-pass.test.mjs  (tests=10, ms=1358)
- 判定: SLOW-TESTS
- 被测: control-plane 规范化、decision 确认、worktree 刷新/合并、write-scope-guard、receipt notice
- 理由/证据: 仅 B-80/B-81（L283-320）真 git：test 侧 13 次（init L294、config L295-296、base L297-299、branch L300、main-only L301-303、checkout L304、group L305-307、checkout L308、merge-base L315）+ `worktreeAdd` L310 内部。单条，文件内无可复用 fixture。
- 可删用例: 无
- 可入 slow 的用例: `B-80/B-81: stale integration branch is merged without rebasing and a missing destination worktree is created` 1331 ms（真 git）
- 风险: B-83（L336-349）只断言 `describeGateUnavailable` 文案，见文案清单；B-78（write guard）、B-73 为契约/持久化，必须保留。

### phase11-tests/platform-defects-fortieth-pass.test.mjs  (tests=1, ms=155)
- 判定: KEEP
- 被测: team_run_lease acquire 对已完成 edit 任务重新绑定已批准 plan（端到端 mock agentTeams）
- 理由/证据: 全内存 mock，无进程，155 ms 主要是 apply()+control-plane 落盘；唯一覆盖该缺陷。注意 L9 `base='D:\\dsh-test\\home\\profiles\\web\\plugins\\'` 动态 import（见额外发现）。
- 可删用例: 无
- 可入 slow 的用例: 无（155 ms，非 git）
- 风险: 无。

### phase11-tests/platform-defects-forty-fifth-pass.test.mjs  (tests=9, ms=9)
- 判定: KEEP+TRIM
- 被测: taskListPageMetadata、applyTaskEdit、readyReasonDiagnostics、taskDeleteDependents、waitingSetTargetVerdict、leaseReleaseOrderVerdict、privilegeActivationAllowed、shellWriteTargets
- 理由/证据: B-243（L68-87）与 thirty-fifth-pass `B-220: waiting_set updates the existing open ticket for the same task`（L99-140）几乎逐行相同：同一 `recordWaiting` → `waitingSetTargetVerdict` → 带 ticketId 再 `recordWaiting`，断言完全一致（target.ok、target.ticketId、updated.ticketId、updated.responsible 变更、tickets 数量==1），仅 responsible 名字、board 名不同，B-220 多一个 `taskRevision:3`。
- 可删用例: `B-243: waiting_set reuses the same responsibility row when the responsible actor changes`（替代: thirty-fifth-pass / `B-220: waiting_set updates the existing open ticket for the same task`，断言超集）。省 ≈1 ms，主要意义是去重。
- 可入 slow 的用例: 无
- 风险: 失去 board 名为 `group`、responsible 名为 old-lead/new-lead 的变体（对 `waitingSetTargetVerdict` 无逻辑差异）。另 B-249（L113-117）只对 `D:/dsh-test/home/.../team-tools-v2-r10.mjs` 源码做 2 条 regex，属源码文本断言（见文案清单），且读的是主检出而非 stage。

### phase11-tests/platform-defects-forty-first-pass.test.mjs  (tests=3, ms=28)
- 判定: KEEP
- 被测: write-scope-guard `tools/pre-execute` 对 `pwsh -File` 的 B-213c 诊断
- 理由/证据: 是 thirty-eighth 两条用例的超集（见 thirty-eighth 段），应当保留这边。第 1、3 条的断言含消息正文，但行为（reject）部分在 thirty-eighth 里没有 no-lease 变体，故唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-forty-fourth-pass.test.mjs  (tests=7, ms=6)
- 判定: KEEP
- 被测: shellWriteTargets 注释掩码、memberMergeSourceVerdict 选择、PLAN_REPLACEMENT_RECOVERY、ackableWakeIdForInboxRow、classifyFailure、mergePhaseAdvance*、worktreeTargetVerdict
- 理由/证据: 6 ms 全纯函数。B-236（L94-105）全部是对原因文案的 regex + `PLAN_REPLACEMENT_RECOVERY.includes(...)`，属文案断言（见文案清单），0 ms，不省时间，默认 KEEP。B-239 前两个 `mergePhaseAdvanceVerdict` 断言与 sixth-pass B-89 重复（见跨文件小节），第三个 `mergePhaseAdvanceFailureVerdict` 唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-forty-second-pass.test.mjs  (tests=4, ms=218)
- 判定: KEEP
- 被测: team_task_update 的 B-47 无计划 scope 恢复路径 + 纯 verdict
- 理由/证据: 内存 mock + control-plane 文件，63–92 ms/条，无进程。三个端到端分别断言 inactive 可修、active owner 拒绝、active lease 拒绝（权限/授权边界），契约测试保留。
- 可删用例: 无
- 可入 slow 的用例: 无（<100 ms）
- 风险: 无。

### phase11-tests/platform-defects-forty-third-pass.test.mjs  (tests=7, ms=194)
- 判定: KEEP
- 被测: team_task_create/update 全局板归属、detectScopeConflicts、buildReadyQueue/Advice、resolveWaiting superseded、evidence 绑定只读卡
- 理由/证据: 最慢 92 ms（B-234 端到端）、84 ms（B-227）；无进程；各 B-id 断言唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-fourteenth-pass.test.mjs  (tests=46, ms=12102)
- 判定: SLOW-TESTS（建议把 8 条 git 用例整体移入 slow 通道；同时可把该文件按 git/非 git 拆成 2–4 个文件）
- 被测: team-worktree `mergeExact`/`worktreeAdd`/`clearanceDigestGate`，team-control-plane、team-v14-waiting、evidence envelope、guard、team-health 等 B-110..B-155、R23、D-4..D-7
- 理由/证据: 46 条中 8 条真 git，合计 11.5 s（占本文件 95%），其余 38 条合计 ≈0.6 s（最慢 B-148 185 ms，含 setTimeout 轮询；B-140/B-142/B-147 ≈90 ms，control-plane 落盘）。8 条 git 用例的 test 侧 git 次数（每条均以相同 5 次前缀开头：init、config×2、add base、commit）：

  | 用例 | 行号 | ms | test 侧 git | 内部 git 入口 | 前缀行 |
  |---|---|---|---|---|---|
  | B-110 | L70-142 | 2373 | 21 | mergeExact×3 | L76-81 |
  | B-119 | L213-241 | 703 | 8 | worktreeAdd×1 | L218-223 |
  | B-130 | L607-650 | 1254 | 11 | mergeExact×2 | L613-618 |
  | B-132 | L652-695 | 1503 | 13 | worktreeAdd×2 | L658-663 |
  | D-5 | L1411-1438 | 363 | 6 | clearanceCommitVerdict | L1415-1420 |
  | D-7 | L1469-1504 | 1471 | 16 | mergeExact×2 | L1474-1479 |
  | B-153 | L1506-1565 | 2060 | 13 | worktreeAdd×4 | L1511-1516 |
  | B-154 | L1567-1621 | 1781 | 17 | mergeExact×3 | L1573-1578 |

  合计 test 侧 105 次 git + 内部 17 次 worktreeAdd/mergeExact（各约 8–15 次 git）。
- fixture 复用方案（不改语义）: 在文件顶部 `before()` 建一个模板仓库（`git init -b main` + config + 提交 base.txt；B-153 需要 `conflict.txt='base\n'`，可在模板里一并提交，对其余用例仅多一个被忽略的跟踪文件），各用例用 `cpSync(template, repo, {recursive:true})` 取代 L76-81 / L218-223 / L613-618 / L658-663 / L1415-1420 / L1474-1479 / L1511-1516 / L1573-1578。模板此刻无 worktree，.git 内无绝对路径，拷贝安全；后续 `worktree add`、commit 序列不变。省 8×5−5=35 次 git ≈1.3–1.7 s。B-119/B-132/B-153 会在 main 上再提交、B-110/B-130/B-154 不动 main、D-7 会 `checkout --detach` 主检出，所以只能共用“模板”，不能共用同一个仓库。
- 可删用例: 无（全部带 B-nnn/D-n/R23 标记，且各自唯一覆盖）。同文件内仅有的“看似重复”：B-140（L862-911）、B-142（L954-995）各有“内存 store + control-plane 持久化”两个半段，对应 team-policy 与 team-control-plane 两套独立实现，不是重复。
- 可入 slow 的用例: B-110 2373 ms、B-153 2060 ms、B-154 1781 ms、B-132 1503 ms、D-7 1471 ms、B-130 1254 ms、B-119 703 ms、D-5 363 ms（全部真 git）；B-148 185 ms（setTimeout 轮询，非 git，不必 slow）。
- 风险: 非 git 的 38 条中源码文本断言 B-129（L599-605，4 条 regex 读 `app/node_modules/.../ptc.js`）与 B-136（L828-832，对插件源码 `doesNotMatch(/\blower\s*\(/)`）无行为意义，见文案清单；B-127（L556-567）从源码截函数后 `new Function` 执行，有行为断言，保留。拆文件的收益取决于 runner 是否跨文件并行（本包 cases.txt 未体现，不确定）。

### phase11-tests/platform-defects-fourth-pass.test.mjs  (tests=14, ms=2168)
- 判定: SLOW-TESTS
- 被测: write-scope-guard gitWriteCommand/shellWriteTargets、contract detectScopeConflicts、control-plane packetPut/dispatchTransition/planPropose、tools verdict、team-worktree `worktreeAdd`、`scopesAreEntirelyIgnored`
- 理由/证据: 2 条真 git。B-67（L360-384）test 侧 10 次（init L366、config×3 L367-369、add/commit L371-372、branch L373、commit -qam L375、rev-parse L376、rev-parse L380）+ `worktreeAdd` L377；B-71（L386-407）test 侧 6 次 + `scopesAreEntirelyIgnored`×3（L397/402/403）。两条 base 内容不同（B-71 需要 .gitignore），共用价值 ≤5 次 git ≈0.2 s，不建议。其余 12 条 ≈57 ms。
- 可删用例: 无
- 可入 slow 的用例: `B-67 pure ancestor worktree branch is fast-forwarded to the moving base` 1334 ms、`B-71 all-gitignored edit scopes are recognized as non-product` 777 ms（真 git）
- 风险: 文件 L12 `base = 'D:/dsh-test/home/profiles/web/plugins/'` 动态 import（见额外发现）。B-182b、B-62 等 control-plane 用例为状态机契约，保留。

### phase11-tests/platform-defects-nineteenth-pass.test.mjs  (tests=4, ms=3333)
- 判定: SLOW-FILE
- 被测: team-worktree `worktreeAdd`（`allowTrackedUnstaged` 路径）
- 理由/证据: 4 条全真 git，且共用同一个 `fixture()`（L14-27）：init L17、config L18-19、写 2 文件 L20-21、add L22、commit L23、branch L24、worktree add L25 = 7 次 git/条。各条另有：T1 advanceMain 2 + merge-base L48 + status L50；T2 add/commit L61-62 + status L72 + merge-base L73；T3 advanceMain 2 + add L85；T4 advanceMain 2。test 侧共 41 次 + `worktreeAdd` 4 次内部调用。
- fixture 复用方案（不改语义）: `before()` 里只做 L17-23 的 5 步（init/config/写文件/add/commit）建模板；每条 `cpSync(template, repo)` 后再执行 L24-25（branch + worktree add，worktree 必须在拷贝之后建，因为 .git/worktrees 记绝对路径）。省 4×5−5=15 次 git ≈0.5–0.7 s。
- 可删用例: 无（4 条断言各不相同：未暂存保留 / 重叠拒绝且不丢本地编辑 / 暂存失败闭合 / 默认路径拒绝任何跟踪编辑，属失败闭合契约）
- 可入 slow 的用例: 全部 4 条：`B-174 lease sync preserves an unrelated unstaged tracked edit` 1004 ms、`overlapping main changes are rejected...` 920 ms、`staged edits remain fail-closed` 723 ms、`the default setup path still rejects every tracked edit` 686 ms（真 git）
- 风险: twenty-ninth-pass B-192 与第 1 条重复（见跨文件小节），保留这边。

### phase11-tests/platform-defects-ninth-pass.test.mjs  (tests=3, ms=4)
- 判定: KEEP
- 被测: milestoneProofVerdict/markMilestoneDone、memberWorktreeBindingVerdict、shellWriteTargets（换行分隔）
- 理由/证据: 4 ms 纯函数，各断言唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-second-pass.test.mjs  (tests=5, ms=293)
- 判定: KEEP
- 被测: team_delivery_check 里程碑 verdict、packet contentDigest v2、已完成 discussion 直达 accepted、context-delivery 欠账通知
- 理由/证据: 内存 mock + control-plane；最慢 151 ms（delivery check，含 `flush()`）。无进程。持久化格式（contentDigest v2 可重算）属契约，保留。L9 绝对路径 import（见额外发现）。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-seventeenth-pass.test.mjs  (tests=1, ms=4375)
- 判定: SLOW-FILE
- 被测: team-worktree `worktreeAdd` + `mergeExact`，team-tools `memberMergeDestinationBase`（B-172）
- 理由/证据: 单条用例内两次完整 `runMerge`（L52-83；L86 'old'、L92 'fixed'），每次都重建 `setupCounterexample`（L19-50）：init L24、config×2 L25-26、base L27-29、branch L30、switch L31、group L32-34、switch L35、main L36-38、worktree add L39、merge L40、task L41-43、rev-parse L44、runner merge-base×2 L45-46 = 19 次 git，另 L77-78 rev-parse/show 2 次；test 侧共 ≈42 次，加 `worktreeAdd`(L56)+`mergeExact`(L65) 每轮内部 ≈20+ 次。
- fixture 复用方案（不改语义）: 把 L19-50 提到 `before()` 只建一次；两次 `runMerge` 之间还原：先 `git worktree remove --force destination`（grp/rig 此时被 destination 检出，必须先移除），再 `git branch -f grp/rig <建好时记录的 sha>`（2 次 git）。省 17 次 git ≈0.8 s。L45-46 的两个 assert 只需执行一次。
- 可删用例: 无（唯一覆盖 B-172）
- 可入 slow 的用例: `B-172: a cleared source that already contains main is not wrapped by a destination refresh` 4375 ms（真 git，约 90 个 git 进程）
- 风险: 该文件是本包最重的单条，建议整体入 slow 通道；还原步骤若遗漏 worktree prune 会让第二轮 worktreeAdd 命中 `listedWorktree` 路径，改变语义，需验证。

### phase11-tests/platform-defects-sixteenth-pass.test.mjs  (tests=6, ms=68)
- 判定: KEEP+TRIM
- 被测: planScopeConflictVerdict、leaseHeartbeat、inboxAckIdentifierVerdict、memberMergeSourceVerdict（privilege）、privilege 生命周期
- 理由/证据: 68 ms，最慢 61 ms（O-10-8 含 10 ms sleep）。B-169（L107-110）仅对常量 `VERIFIER_CLEARANCE_POLICY` 做 2 条 regex，行为面已由 eleventh-pass `B-102: condition is a non-blocking verifier severity` 的 `clearanceGate` 断言覆盖（condition 放行、major/blocker 拒绝）。
- 可删用例: `B-169: clearance documentation names both blocking severities`（文案常量；替代: eleventh-pass / `B-102: condition is a non-blocking verifier severity`，仅覆盖行为不覆盖文案措辞）。0 ms，仅作用户裁决项，**默认 KEEP**。
- 可入 slow 的用例: 无
- 风险: 删后失去“文档里写了哪两个阻断等级”的措辞保证；O-10-12 末尾 `assert.match(PRIVILEGE_TURN_POLICY, /next wake/)` 同类，不单独动。

### phase11-tests/platform-defects-sixth-pass.test.mjs  (tests=8, ms=1223)
- 判定: SLOW-TESTS
- 被测: planApprovalVerdict、evidence envelope、waiting resolve、dependencySatisfied、withMergeLock、memberWorktreeSyncPlan+worktreeAdd
- 理由/证据: 仅 B-91（L187-227）真 git：test 侧 10 次（init L199、config×2 L200-201、base L202-204、branch L205、add/commit L208-210、merge-base L223）+ `worktreeAdd` 两次（L206、L220）。单条，无复用。其余 7 条 ≈5 ms。
- 可删用例: 无
- 可入 slow 的用例: `B-91: lease-time member worktree sync fast-forwards the member branch to main` 1218 ms（真 git）
- 风险: 与 fourth-pass B-67 近似（见跨文件小节，仅部分重叠），两条都保留。

### phase11-tests/platform-defects-tenth-pass.test.mjs  (tests=5, ms=66)
- 判定: KEEP
- 被测: planApprovalVerdict（B-85 live）、reassignActiveOwnerVerdict/boardUpdate、isEvidenceCheckoutPath + guard、detectScopeConflicts、control-plane release 墓碑
- 理由/证据: 66 ms，最慢 60 ms（B-98 control-plane）；权限/授权边界断言，保留。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-third-pass.test.mjs  (tests=8, ms=146)
- 判定: KEEP
- 被测: shellWriteTargets（A-9）、waiting derive/record、evidence query/put、milestone canRead、bind_fix null、team_milestone set 持久化
- 理由/证据: 146 ms 无进程；各 B-id 唯一。L8 绝对路径 import（见额外发现）。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirteenth-pass.test.mjs  (tests=7, ms=4)
- 判定: KEEP
- 被测: acknowledgeInboxEntry/acknowledgePendingDispatchMessage/handleWakeBatch、provider waiting
- 理由/证据: 4 ms 纯状态机；B-108 的 5 条分别覆盖不同载体（durable inbox+dispatch-pending、永久 queued 行、重复 ack 幂等、wake 级 ack、跨成员 scope），断言不相同。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirtieth-pass.test.mjs  (tests=3, ms=154)
- 判定: KEEP
- 被测: filterVisibleEvidence、team_run_lease release 过期、write guard 无有效 lease 的拒绝文案
- 理由/证据: 139 ms 的 B-195 release（含 40 ms setTimeout 等 lease 过期）。`B-195 write refusal names no active lease or its expiry` 以消息文案为主，但拒绝本身（throws）与 fifth-pass B-78 的 `has no active worktree` 不同路径，不可证明重复。L12 绝对路径 import。
- 可删用例: 无
- 可入 slow 的用例: 无（139 ms，含 sleep 40 ms，非 git）
- 风险: 无。

### phase11-tests/platform-defects-thirty-eighth-pass.test.mjs  (tests=7, ms=44)
- 判定: KEEP+TRIM
- 被测: write-scope-guard `tools/pre-execute` 对 `pwsh -File` 的 B-218 回归
- 理由/证据: 本文件的 harness（makeAgent/makeContext/runPreExecute/writeScopedScript，L11-79）与 forty-first-pass（L11-77）逐行相同，用的是同一个脚本内容（`$parts = @('out','.log')...`）、同一路径 `tools/rig-batch/tests/run.ps1`、同一 lease 注入。其中两条被 forty-first 超集覆盖：
  1. `a scoped -File script with runtime paths is allowed`（L81-97）= forty-first `B-213c: a sanctioned in-scope -File script remains allowed with a valid lease`（L104-119，同命令 `pwsh -NoProfile -File "${script}"` → `{kind:'allow'}`，后者多一个 `-OutFile` 变体）。
  2. `a shell separator around a scoped script stays fail-closed`（L166-181）= forty-first `B-213c: unverifiable non-File composition is named without claiming write capability`（L121-138，同一命令 `...-File "${script}"; Set-Content outside.txt -Value x`，同一 `[explicit-file-required]`，后者多 2 条消息断言）。
- 可删用例: 上述两条（替代见上，文件+用例名已给出）。省 ≈15 ms。
- 可入 slow 的用例: 无
- 风险: 失去 PLAN_SCOPES 含 `tests/golden/rig-batch/`、`target/` 的变体（该脚本路径不依赖这些 scope，无逻辑差异）。其余 5 条（脚本在计划外、worktree carrier、inline -Command、bash 包装、缺失/非 UTF-8 脚本）为失败闭合契约，唯一，保留。

### phase11-tests/platform-defects-thirty-fifth-pass.test.mjs  (tests=6, ms=18)
- 判定: KEEP
- 被测: shellWriteTargets（-File 脚本静态写入/嵌套/opaque）、pre-execute、recordWaiting/waitingSetTargetVerdict
- 理由/证据: 18 ms；mkdtemp 写小脚本，无进程。B-220 是 forty-fifth B-243 的保留方。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirty-first-pass.test.mjs  (tests=4, ms=196)
- 判定: KEEP
- 被测: LocalJobRegistry 恢复 id 去冲突（B-198）、team_plan_approve changed/deduplicated、blockedLeaseReleaseVerdict、team_task_update complete 拒绝诊断
- 理由/证据: 196 ms 无进程（B-199 118 ms 起整套 tools）。B-198 与 thirty-second-pass B-203 场景相同（见跨文件小节），仅 MERGE 建议，不删。B-200（L176-206）只断言拒绝文案，其 `ok===false` 行为已由 twenty-sixth-pass B-177 覆盖，文案本身唯一 -> 文案清单。L13 绝对路径 import。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirty-fourth-pass.test.mjs  (tests=6, ms=12)
- 判定: KEEP
- 被测: shellWriteTargets 的 B-213/B-213b 变量与 cmdlet 解析、worktree carrier（tier-1 写入限定在成员 worktree）
- 理由/证据: 12 ms；前 5 条是各自不同输入的解析器反例（Join-Path 赋值、字面量变量、未知 cmdlet、只读 cmdlet、动态 cmdlet 名）。最后一条 `worktree carrier keeps tier-1 writes inside the member worktree` 与 twenty-fourth-pass D-new-15 第 3 条在 `writeIntent` 放行/拒绝 `worktree-carrier-mismatch` 上有部分重叠，但这里用注入的 `controlPlane` 且断言 `error.code === 'FS_WRITE_OUT_OF_SCOPE'`，不可证明完全覆盖 -> KEEP。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirty-ninth-pass.test.mjs  (tests=2, ms=21)
- 判定: KEEP
- 被测: LocalJobRegistry 跨 turn 作业在 Agent dispose/Session 存活时的回收（崩溃恢复/生命周期）
- 理由/证据: 21 ms，含 5 ms 间隔的 waitFor 轮询（上限 1 s）；非 git。生命周期契约，保留。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirty-second-pass.test.mjs  (tests=2, ms=69)
- 判定: KEEP
- 被测: team_v12 leases 动作（B-197 两种参数形态）、LocalJobRegistry 恢复 id 跳过（B-203）
- 理由/证据: 69 ms；B-203 与 thirty-first B-198 同场景（见跨文件小节）。B-203 为超集（多断言 `read` 输出、`counters.set('pwsh',152)` 变体），保留这边。L12 绝对路径 import。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirty-seventh-pass.test.mjs  (tests=7, ms=364)
- 判定: KEEP
- 被测: deliveryTargetVerdict、inbox ack、team_member_reparent override、detectScopeConflicts、空 write scope 计划/完成
- 理由/证据: 最慢 172 ms（空 scope plan+readyQueue）、119 ms（criteria-only complete）、69 ms（reparent 持久化+rehydrate）；无进程。持久化/权限类，保留。L8 绝对路径 import。
- 可删用例: 无
- 可入 slow 的用例: 无（<200 ms）
- 风险: 无。

### phase11-tests/platform-defects-thirty-sixth-pass.test.mjs  (tests=1, ms=3)
- 判定: KEEP
- 被测: normalizeRoomWakeState 对已 ack 遗留 wake 行的持久化再水化
- 理由/证据: 3 ms，唯一覆盖 B-221；持久化格式契约。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-thirty-third-pass.test.mjs  (tests=3, ms=77)
- 判定: KEEP
- 被测: dependencySatisfied 的 completed 阈值、team_task_create/update 的 dependency_phase 持久化、planScopeConflictVerdict 同 owner
- 理由/证据: 77 ms；第 1 条首个断言 `dependencySatisfied(completed/integration-ready)===false` 与 sixth-pass B-87（L141）重复，但同条里另有 `'completed'` 阈值断言唯一。L8 绝对路径 import。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twelfth-pass.test.mjs  (tests=5, ms=3)
- 判定: KEEP
- 被测: taskUpdateUnknownFields、applyTaskEdit、pendingDispatchInboxRows/acknowledgePendingDispatchMessage、mergeTargetPhase
- 理由/证据: 3 ms 纯函数，各断言唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twentieth-pass.test.mjs  (tests=7, ms=56)
- 判定: KEEP
- 被测: shellWriteTargets here-string、worktreeBindingMissingVerdict、leaseHeartbeat contractRevision、acknowledgeInboxEntry、phaseAdvanceGuidance、taskGateActionable、authorizeWaitingAction
- 理由/证据: 56 ms（51 ms 为 leaseHeartbeat control-plane）。无进程。权限边界（waiter 解析）保留。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-eighth-pass.test.mjs  (tests=2, ms=142)
- 判定: KEEP
- 被测: taskPhaseAdvanceActorVerdict（B-186）与 team_task_update 端到端
- 理由/证据: 141 ms 为端到端（apply 全套工具 + control-plane），非 git。权限边界（只有 tier 0 可跨集成边界），保留。L8 绝对路径 import。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-fifth-pass.test.mjs  (tests=1, ms=51)
- 判定: KEEP
- 被测: leaseAcquire 落盘后才返回（D-new-16，持久化/崩溃恢复）
- 理由/证据: 51 ms，唯一覆盖；契约。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-first-pass.test.mjs  (tests=4, ms=11)
- 判定: KEEP
- 被测: compactRuntimeFacts、JobJournal 孤儿标记/PID 复用、JobEventHub 回放
- 理由/证据: 11 ms；崩溃恢复契约。与 twenty-second D-新-2 同调 `compactRuntimeFacts`，但断言字段不同（`omittedUnobservedRuntimeEntries` vs `omittedNoisePlugins`），无证据可删。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-fourth-pass.test.mjs  (tests=4, ms=65)
- 判定: KEEP
- 被测: projectLeasesForMember（D-new-14 追加）、gitCommandWorkdir/worktreeCarrierVerdict、write guard pre-execute carrier
- 理由/证据: 65 ms（62 ms 为 control-plane mutate+flush 的端到端）。`D-new-14 follow-up` 与 twenty-third `D-new-14` 同一缺陷、同一函数 `projectLeasesForMember`，输入/断言互补不相同（见跨文件小节），可挪进同一文件，不省时。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-ninth-pass.test.mjs  (tests=3, ms=1297)
- 判定: KEEP+TRIM（含 SLOW-TESTS）
- 被测: team_task_update complete（B-187）、waiting approval（B-190）、`worktreeAdd` 未暂存保留（B-192）
- 理由/证据: B-192（L199-230）与 nineteenth-pass `B-174: lease sync preserves an unrelated unstaged tracked edit`（L35-54）调用同一函数、同一选项（`worktreeAdd(repo, worktree, 'task', 'main', runGit, false, {allowTrackedUnstaged:true})`）、同一场景（worktree 内一个未暂存的跟踪文件改动 + main 上不相交的推进），断言 `outcome.ok===true` 与 `preservedTrackedUnstaged` deepEqual `[' M local.txt']` 在 B-174 的 L46-47 逐字存在，且 B-174 另断言文件内容保留与 `git status --porcelain`。区别仅 main 推进方式（B-192 新增 main.txt，B-174 改已跟踪的 main.txt），对 `unstagedTrackedStatusLine` 无差异。B-192 真 git：test 侧 8 次（L209-220）+ `worktreeAdd` 内部，937 ms。
- 可删用例: `B-192 preserved unstaged rows retain raw porcelain bytes`（替代: nineteenth-pass / `B-174: lease sync preserves an unrelated unstaged tracked edit`，L46-47）。省 ≈0.94 s。
- 可入 slow 的用例: `B-187 owner may complete from integration-ready without phase rollback` 359 ms（test 侧 6 次 git：L40-46，用于生成一个真实 commit_sha 给 complete 校验）
- 风险: 删后失去“B-192”标签；若要保留标签，可在 B-174 首条用例名里追加 `(B-192)`。B-190 为内存状态机（1 ms），保留。L9 绝对路径 import。

### phase11-tests/platform-defects-twenty-second-pass.test.mjs  (tests=5, ms=3)
- 判定: KEEP
- 被测: compactRuntimeFacts、verifierScratchRoot/isVerifierScratchPath、crossBoardBlockerVerdict、taskEditWriteScopeVerdict、taskContractRevisionProjection
- 理由/证据: 3 ms 纯函数；D-新-4 的 crossBoardBlockerVerdict 与 twenty-sixth B-175 同一函数不同输入（board 限定/非限定依赖），B-175 里 `crossBoardBlockerVerdict(['task-102'],'global',boards).ok===false` 与此处 `...(['group-rig-t63'],'global',boards).ok===false` 为同类断言，但 D-新-4 额外断言 `crossBoard` 结构与 detail，不删。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-seventh-pass.test.mjs  (tests=2, ms=3)
- 判定: KEEP
- 被测: 结构化 post-completion 等待在任务终态后存续；authorizeRequirementRecord
- 理由/证据: 3 ms。B-182 的 `legacy` 子断言与 fifteenth B-160 部分重叠（见跨文件小节），但 B-182 主体（external/dependency 存续）唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-sixth-pass.test.mjs  (tests=3, ms=120)
- 判定: KEEP
- 被测: 跨板依赖 gate（parseTaskDependencyReference、buildReadyQueue、control-plane boardCreate/Update 环检测）、非 task 对象依赖等待、blocked lease release
- 理由/证据: 120 ms（76 ms B-175 含 control-plane 多次写）；无进程。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

### phase11-tests/platform-defects-twenty-third-pass.test.mjs  (tests=7, ms=5)
- 判定: KEEP
- 被测: evaluateReadyTask/createReadyQueueContext、deriveWaitingTickets、recordDeliveredInboxMessage、taskEditWriteScopeVerdict、planScopeConflictVerdict、projectLeasesForMember
- 理由/证据: 5 ms 纯函数；D-new-8..D-new-14 各断言唯一。
- 可删用例: 无
- 可入 slow 的用例: 无
- 风险: 无。

---

## 跨文件重复

### 可证明重复（建议 DELETE，保哪边已标）
| A（建议删） | B（保留） | 证据 |
|---|---|---|
| twenty-ninth `B-192 preserved unstaged rows retain raw porcelain bytes` (L199-230) | nineteenth `B-174: lease sync preserves an unrelated unstaged tracked edit` (L35-54) | 同函数 `worktreeAdd(..., runGit, false, {allowTrackedUnstaged:true})`、同未暂存跟踪改动场景，B-192 的两个断言在 B-174 L46-47 逐字存在；B-174 更强。省 0.94 s |
| forty-fifth `B-243 waiting_set reuses the same responsibility row...` (L68-87) | thirty-fifth `B-220: waiting_set updates the existing open ticket for the same task` (L99-140) | 同函数链 recordWaiting→waitingSetTargetVerdict→recordWaiting(ticketId)，5 个断言逐项相同，仅名字不同；B-220 多 taskRevision |
| thirty-eighth `a scoped -File script with runtime paths is allowed` (L81-97) | forty-first `B-213c: a sanctioned in-scope -File script remains allowed with a valid lease` (L104-119) | 同 harness、同脚本、同命令，→ `{kind:'allow'}`；后者多 `-OutFile` 变体 |
| thirty-eighth `a shell separator around a scoped script stays fail-closed` (L166-181) | forty-first `B-213c: unverifiable non-File composition is named without claiming write capability` (L121-138) | 同命令、同 `[explicit-file-required]`；后者多 2 条消息断言 |

### MERGE（只合并写法、不删断言、不省时间）
- thirty-first `B-198 restarted host skips recovered job ids...`(L88-136) ↔ thirty-second `B-203 live pwsh-153 skips a recovered id...`(L138-186)：同一 `JobJournal.recordSettlement` + `LocalJobRegistry.start` 去冲突场景；B-203 为超集（多 `read` 输出断言），B-198 多一个“计数器未预置”变体（recovered `pwsh-1` → `pwsh-2`）。建议改成一个数据驱动用例两组参数；省 ≈13 ms，无实质收益，故保守不删。
- twenty-third `D-new-14` ↔ twenty-fourth `D-new-14 follow-up`：同缺陷同函数 `projectLeasesForMember`，输入/断言互补，可放同一文件，0 s。

### 部分重叠（保留双方，仅供参考）
- fourth `B-67`(L360) ≈ sixth `B-91`(L187)：都是“纯祖先成员分支 fast-forward 到 main”；B-67 在新建 worktree 路径（`created:true`），B-91 在已有 worktree 路径（走 `listedWorktree`）并含 `memberWorktreeSyncPlan`。内部都走 team-worktree.mjs:689 的 `merge --ff-only`，但入口不同，保留。合计 2.55 s。
- sixth `B-89`(L176-185) ⊃ forty-fourth `B-239`(L130-153) 的前两个断言（`mergePhaseAdvanceVerdict('integration-ready','integrated')` 与 no-op 分支）；B-239 的第三个 `mergePhaseAdvanceFailureVerdict` 唯一。
- fifteenth `B-170` implicit 分支 ≈ forty-fourth `B-238` 的 defaultMemberMerge（同输入同 `member-merge-source-drift`）；B-238 其余分支（commit_sha/branch_head 选择）唯一。
- sixth `B-87` 前半 `dependencySatisfied` 与 thirty-third `B-207` 首个断言重复一条；后者余下 `'completed'` 阈值唯一。
- sixth `B-87` 后半（createReadyQueueContext/evaluateReadyTask → `dependencies-unmet`）≈ fourteenth `B-112` 首段（blocker 在 integrated 时 dependent 被挡）；B-112 另有 `dependencyGate` 结构与 override，保留。
- fifteenth `B-160` 的 legacy task-terminal 断言 ≈ twenty-seventh `B-182` 的 `legacy` 子断言 ≈ fourteenth `B-133` 第一段的 external 存续；各自另有唯一断言。
- thirty-fourth `worktree carrier keeps tier-1 writes...` ≈ twenty-fourth `D-new-15: the write guard rejects shared-checkout writes...` 的前两个 writeIntent 断言；错误码、controlPlane 注入方式不同，保留。
- B-id 复用提醒：B-187/B-190（fourth vs twenty-ninth）、B-193（fourth vs thirtieth）、B-237/B-238（forty-fourth vs forty-fifth）、B-213（thirty-fourth）/B-213c（forty-first）在不同 pass 中是不同缺陷，按编号去重会误删。

## 只断言文案/源码文本的用例（几乎不省时，默认 KEEP，仅供用户裁决）
| 用例 | 位置 | 性质 | 行为面是否已被他处覆盖 |
|---|---|---|---|
| B-157 lock timeout never claims... | fifteenth L75-80 | 仅 `controlPlaneLockTimeoutMessage` 文案 regex | 否（唯一） |
| B-169 clearance documentation... | sixteenth L107-110 | 仅常量文案 regex | 行为由 eleventh B-102 覆盖 |
| B-83 unavailable gate reports... | fifth L336-349 | 仅 `describeGateUnavailable` 文案 | 否（唯一） |
| B-236 exposes both safe plan-replacement recovery paths | forty-fourth L94-105 | 仅 reason 文案 + 常量 includes | 否（唯一） |
| B-129 PTC tool failures preserve HarnessError code | fourteenth L599-605 | 读 `app/node_modules/.../ptc.js` 源码 4 条 regex | 否，且对实现文本脆弱 |
| B-136 waiting_list no longer references an undefined lower helper | fourteenth L828-832 | 对插件源码 `doesNotMatch(/\blower\s*\(/)` | 否；真正行为（waiting_list 运行）无他处断言 |
| B-249 target selection has a single-owner result contract | forty-fifth L113-117 | 读 `D:/dsh-test/home/.../team-tools-v2-r10.mjs` 源码 2 条 regex | 否，且读主检出 |
另：B-200（thirty-first L176-206）的 `ok===false` 行为已由 twenty-sixth `B-177` 覆盖，其独有价值是拒绝文案；B-195 write refusal、B-202 的 error.message regex 同类，均未单独列入。

## fixture 复用汇总（保持语义，估算节省）
| 文件 | 改动 | 节省 git 次数 | 估算节省 |
|---|---|---|---|
| fourteenth | `before()` 建模板仓库，8 条 `cpSync` 取代 L76-81/218-223/613-618/658-663/1415-1420/1474-1479/1511-1516/1573-1578 | 35 | ≈1.3–1.7 s |
| nineteenth | 模板仅含 L17-23，`cpSync` 后再 L24-25 | 15 | ≈0.5–0.7 s |
| seventeenth | L19-50 提到 `before()`，两轮之间 `worktree remove` + `branch -f` 还原 | 17 | ≈0.8 s |
| fifteenth | 模板取代 L87-92/113-118/217-222 | 10 | ≈0.4 s |
| 合计 | | 77 | ≈3 s（估算：本包 git 用例 27.9 s / 约 600–700 次含内部 git ≈ 40–50 ms/次） |
说明：被测代码自身（worktreeAdd/mergeExact/clearance*）的内部 git 调用占大头，fixture 复用只能去掉 test 侧重复前缀；要大幅降耗只能走 slow 通道（把上述 23 条 ≈27.2 s 移出快速通道，但需在完整回归中保留）。

## 额外发现（不影响取舍结论，但影响“测的是不是 stage 副本”）
以下文件用绝对路径动态 import `D:/dsh-test/home/profiles/web/plugins/*.mjs`（主检出），而不是同目录相对的 stage 副本 `../home/profiles/web/plugins/`：second L9、third L8、fourth L12、thirtieth L12、thirty-first L13、thirty-second L12、thirty-third L8、thirty-fourth L8、thirty-seventh L8、twenty-eighth L8、twenty-ninth L9、fortieth L9（共 12 个文件、约 40 条用例）；forty-fifth B-249 L114 同样用绝对路径读源码。另外 thirtieth（L8-10 相对、L12-14 绝对）与 thirty-first（L8-11 相对、L13-15 绝对）同时混用相对与绝对 import，同一文件内可能测到两份不同代码。若 stage 里的 plugins 与主检出不一致，这些用例不会反映 stage 改动。
