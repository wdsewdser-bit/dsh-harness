# A-01 有界真实 A/B 结果（2026-10-06）

范围：opencodego / deepseek-v4.1-flash，隔离 lab（STAGE `D:\dsh-test\staging\context-runtime-unified-20261001`），未改任何产品代码、工具、测试、清单。所有 verify 均为不带 provider 的离线冷读。usage 数字全部来自工具输出（`usage-root-only.json` 或 `result.json`），不推算费用、不外推。

## 1. 总表

输出目录均在 `STAGE\lab-runs\` 下（简写为 `lab-runs\`）。日志在 `D:\dsh-test\output\`，下表给 SHA256 完整值。usage 单位 token；cache write、reasoning 工具均给 unknown。

| case | 臂 | 序号 | 输出目录 | 运行日志 SHA256 | 请求数 | verify | input | cache read | output | total | root / 后代 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 native-compaction | 处理 | r1 | `lab-runs\ab-s1native-treat-r1-20261006` | `3670b79c51c2d72adfd17a73c7bbb68ee2a2348961d9e937e91db53b7107996f` | 9（对话 6 + 压缩 3） | 通过 | 125391 | 150528 | 6650 | 282569 | 仅 root，无后代 |
| S1 native-compaction | baseline | r1 | `lab-runs\ab-s1native-base-r1-20261006` | `01e67a3e1dd154e1d3727d34200fbbd3caf9938901f1ebda384f180e319c0ab7` | 6（对话 6，压缩 0） | 未通过 | 41991 | 166272 | 3840 | 212103 | 仅 root，无后代 |
| S2 unified window-native | 处理 | r1 | `lab-runs\ab-s2window-treat-r1-20261006` | `dd708d07cfe08f5e96ab820f7f3aed3e7e0814f2afa2319f934172ee13115b3c` | 6 | 通过 | 84253 | 178176 | 1184 | 263613 | 仅 root |
| S2 unified window-native | 处理 | r2 | `lab-runs\ab-s2window-treat-r2-20261006` | `a93189e049a4df580737f6a74fe3d114e8293ee545bdf02822e4eda1e97c3ea7` | 1（已放行，终态记录 0） | 未通过（失败运行） | unknown（工具记录 0 条终态） | unknown | unknown | unknown | 仅 root |
| S2 unified window-native | 处理 | r3 | `lab-runs\ab-s2window-treat-r3-20261006` | `1b54bfd224927ed94c610d090c468e550b3519a9f9ee4ef86d686ab16ed099cd` | 6 | 通过 | 84165 | 178432 | 1139 | 263736 | 仅 root |
| S2 unified window-native | baseline | — | 无（未创建） | `0ce1f00505ac5f99b744bc6bf2ad4f0a9da469ca38783c6b9f157b40e102e98c` | 0 | 不适用 | — | — | — | — | — |
| S3 instant | 处理 | r1 | `lab-runs\natural-instant-c79ac8bb-7c10-4c35-b40d-6c40fa6beeee`（该工具自行命名） | `67f5199bdf9fe1cf6fc0bdd10d3ff43321635e987969d658e2ceef9e30a83181` | 1（已放行，result.json 记 requests=1；因缺凭据实际未能发出） | 未做（无成功产物） | unknown | unknown | unknown | unknown | unknown；无对照臂 |
| S4 team-family | 处理 | r1 | `lab-runs\ab-s4team-treat-r1-20261006` | `8c233ab414e95c1688bca7f1a6ee104774bf78bc0acdf78a0fb7f2408272f6cc` | 8（对话 8） | 通过 | 171664 | 64768 | 909 | 237341 | 见下 |

S4 root 与后代（按 `request-terminals.json` 的 reportedUsage 按 sessionId 汇总，会话映射取自 `family-evidence.json`；4 个会话合计与工具总数一致）：

| 会话 | 请求 | input | cache read | output |
|---|---|---|---|---|
| root (lead) | 2 | 28397 | 28672 | 201 |
| 后代 probe-lead | 2 | 30355 | 30464 | 174 |
| 后代 probe-member | 2 | 56773 | 2816 | 336 |
| 后代 probe-verifier | 2 | 56139 | 2816 | 198 |

verify 日志（`D:\dsh-test\output\`，同为 `context-runtime-ab-*` 命名，arm 字段带 `-verify`）：
- S1 处理 `context-runtime-ab-s1native-treat-verify-r1-20261006.log` `1a754f5276c473c715640fff5cb9e28410ff298775a5728d213dcf230eb35953`（首次 verify 在会话内执行，输出一致，此日志为之后重跑留档）
- S1 baseline `context-runtime-ab-s1native-base-verify-r1-20261006.log` `553b60bbd9e361b08c9577fb58bc935ffc39eaf7bd6dca2eed4c27476b53b753`
- S2 r1/r2/r3 `context-runtime-ab-s2window-treat-verify-r{1,2,3}-20261006.log` `4dd2f77a...672a` / `54cccef1...81` / `6ce3e30d...5045`（全文 SHA 见同目录，r1=`4dd2f77a28435e8afb9b04509496add6c0321d1871d3d6dfd70fa776911f672a`，r2=`54cccef181a5cbfb9f32aa23e6fdf6d8cc4a237c6545a47b3095de60fdd87c81`，r3=`6ce3e30dd4ec3339af85d148711811b5071bc06b8b428ba0ce583d26bc25045c`）
- S4 `context-runtime-ab-s4team-treat-verify-r1-20261006.log` `ab019a9f61d5289d24a021e8baf388037ba5a2b5ce02bd731ee3d6a0d8ae8d39`

预检日志（零外部请求）：S1 `lab-runs\ab-native-pre-20261006`；S2 `context-runtime-ab-s2window-pre-r0-20261006.log` `5f85938c...857`；S3 `...s3instant-pre-r0...` `bfb093dc...236`；S4 `...s4team-pre-r0...` `2c588368...1c1`。

## 2. 各 case 质量结论

### S1 native-compaction
- 处理臂 verify 通过：sourceBound、toolPairMatched、retryPrefixPreserved、roundsVerified、requestBound、recoveryDispatched 均为 true；原生摘要 3、压缩请求 3、剩余强制项 4；独立磁盘冷读 true；外部请求 0。
- baseline 臂 verify 未通过：`roundsVerified:false`，其余项均为 true；摘要 0、压缩请求 0。运行器报错 `ERR_ASSERTION Expected values to be strictly equal: false !== true`。三轮中第 3 轮答复落在 seq 76，晚于预期的 seq 52 附近，说明该轮 baseline 经历了额外步骤；至少一轮答复未通过 `verifyCompactionAnswer`（JSON 四字段及当轮 writeScope 校验）。未进一步定位是哪一轮的哪个字段。
- 结论：处理臂质量成立，baseline 质量不成立，因此本次两臂不是“质量都成立”的配对，不陈述任何节省结论。按停止条件（关键约束答复错误），S1 不补重复。

### S2 unified window-native
- r1、r3 verify 通过：exactArtifactMatched、artifactHandedToAdapter、toolPairMatched、finalConstraintMatched、originalsPreserved、nativeSurfaceVerified、artifactReceiptVerified、matchingDebtResolved 均为 true；completedTurnCount 3；admittedRequests=6 且 providerTerminal=6。
- r2 失败：`LAB_FIRST_WINDOW_CHECKPOINT_MISSING`（`unified-natural-lab.mjs:555`），仅放行 1 次请求，usage 终态 0 条；`--verify` 因缺少 `history-quality-target`/`native-window-evidence` 类产物返回 `{"failed":true,"code":"ENOENT"}`。r2 为首个窗口检查点缺失，非 provider 错误。r3 为同 case 第二次运行并通过，没有再多跑。
- baseline 臂：工具不支持。`unified-natural-lab.mjs:668` 规定 `--baseline` 只能配 `--scenario window-recall`，对 window-native 报 `{"failed":true,"code":"LAB_QUALITY_SCENARIO_REQUIRED"}`，零请求、未建输出目录。没有自造对照臂，也没有改用 window-recall（场景不同，不构成配对）。

### S3 instant
- 预检通过（`bootstrap-no-provider`，accepted true，requests 0）。
- `--run` 失败：`llm-pi-ai: no credential for provider route "opencodego"; its profile resolves OPENCODEGO_API_KEY, which is not set`。`instant-natural-lab.mjs` 的入口（第 96–193 行）自身不像另三个 lab 的父进程那样读取生产凭据并注入子进程环境，而我被禁止读取/传递凭据，也不许改工具。属环境/工具前置条件缺失，不是 provider 403；按“不绕过”处理，未重跑，S3 本次无有效样本。
- 无对照臂（该工具无 `--baseline`）。

### S4 team-family
- verify 通过：accepted true；scope `isolated-actual-Team-four-role-next-turn; native-flat-parentage; root-plus-three-descendants`；providerAccepted true；includedRecords 8，excludedRecords 0，unresolvedRecords 0，truncated 0；providerTerminal 8，transportFailed 0；去重异常 0；独立磁盘冷读 true；externalRequests 0。
- 无对照臂（该工具无 `--baseline`）。

## 3. 累计请求与墙钟、停止条件

- 累计放行请求数：S1 15（9+6）+ S2 13（6+1+6）+ S3 至多 1（未真正发出）+ S4 8 = 37（含失败运行；上限 200，远未到）。
- 墙钟：约 15:37 开始，约 15:47 写文档，约 10 分钟（上限 90 分钟）。
- 触发的停止/异常：
  1. S1 baseline：关键约束答复校验失败（roundsVerified=false），S1 不补重复。
  2. S2 r2：`LAB_FIRST_WINDOW_CHECKPOINT_MISSING`，同 case 之后只重跑 1 次（r3）并通过。
  3. S2 baseline：工具拒绝（LAB_QUALITY_SCENARIO_REQUIRED）。
  4. S3：缺 OPENCODEGO_API_KEY，未重跑。
- 无 401/403/超时；无 late mutation、协议配对破坏、不可恢复状态。
- 过程说明：lab 父进程直接 `node tools/<lab>.mjs` 会因模块解析失败（`@deepseek-ai/cordis` 无 `getHostLifecycleGate` 导出）退出，需改用与历史一致的 `node --preserve-symlinks --preserve-symlinks-main --import ./tools/prepare-unified-lab-host.mjs tools/<lab>.mjs ...`，并设置 `DSH_HOME=<STAGE>\lab-host-home`、`DSH_LAB_CANONICAL_MODULES=1`（两个均为 lab 自己设置的非敏感值）。该失败发生在建目录之前，零请求。S2 baseline 之前的预检/运行均使用该命令形态。
- 工具输出中未发现夹带的指令式文字。

## 4. 限制

- 样本量：S1 与 S4 各 1 次，S2 处理臂 2 次通过加 1 次失败，S3 0 次有效。没有统计意义，不外推。
- 对照臂：S1 有 baseline 但质量未通过；S2 工具不支持 window-native baseline；S3、S4 本就没有 baseline。因此本次没有任何一个 case 具备“两臂质量均成立”的对照，故不给出节省比例。S1 两臂的 token 数字（见总表）只是各自运行的原始读数，baseline 失败，不可比较。
- unknown 维度：cache write、reasoning tokens 在所有运行中均为 unknown；`money` 为 null，费用未计算；S2 r2 与 S3 r1 的 usage 为 unknown/无终态。S2 的 purposes 在工具中全部归为 unknown。
- 范围：所有 verify 均标注 not-full-Team-AB（S1/S2）或隔离 lab（S4）；本次未覆盖规范要求的完整自然链、真实 Team 多轮自然任务、负例（例如 provider 403、late mutation、协议配对破坏的负例注入）以及 S3 instant 的 steer 链真实样本。S2 的 `initialRequestProjected:false`、`finalProjectionStatus:null` 表示未覆盖投影路径。
- S4 root 与后代的分项来自对 `request-terminals.json` 的汇总，不是工具直接输出的分项字段。
