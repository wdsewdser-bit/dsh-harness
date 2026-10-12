# 四角色身份切换与完整后代用量回执

状态：本隔离场景 accepted，整体统一目标仍 partial；生产未部署或 HMR。本回执只证明实际四角色的两轮身份切换、完成约束回答与全后代用量，不是经济收益 A/B，也不替代最终 delivery gate。

## 实际入口

- 目录：`D:/dsh-test/staging/context-runtime-unified-20261001/lab-runs/natural-team-family-20261005-0654`。
- 实际运行时间：2026-10-04 22:54:32.685Z 至 22:55:13.670Z。
- 官方 PTC preset；通过原生 `run_code -> tools.spawn_teammate` 零模型建组，随后实际 opencodego / deepseek-v4.1-flash / openai-responses 采样八次。身份探针明确不调用工具，不能把这八次纯回答称为八次模型 PTC 工具调用。
- 四个原生持久 Session。物理 parent 均按平台原契约指向 root；组长/成员层级来自真实 Team policy，未修改 Session header 或伪造父子关系。
- 输入采样上限八次、output 2048/request、墙钟150秒、父进程185秒。原始记录最大 adapter payload 134414 bytes，小于登记的262144 bytes；没有额外重试或更换 provider。
- 真实身份激活 epoch 1 -> 2、family-A -> family-B；四角色实际请求都包含当前完整角色正文与 bundle hash，后继回答角色文件/tier/probe token 正确。十项要求仅六项验证时，全部回答 completionAllowed=false。

## Root 与后代

| 角色 | Session ID | 请求 | Input | Cache Read | Output | Total |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| root | 409c14da-2ad2-466b-8b73-1fd75f7ac620 | 2 | 28236 | 28672 | 328 | 57236 |
| lead | ba8ee3a7-f3b8-496a-87e3-02e9ff59c516 | 2 | 30190 | 30336 | 174 | 60700 |
| member | a502211d-a56b-44e2-9ee9-d6fec1744d93 | 2 | 56546 | 2816 | 501 | 59863 |
| verifier | 8941b9e3-a3e0-4a17-b86b-ed786bc2c091 | 2 | 55850 | 2816 | 184 | 58850 |
| 合计 | root + 三个实际后代 | 8 | 170822 | 64640 | 1187 | 236649 |

八个 request/attempt/handed-to-adapter/provider terminal 一一对应，transportFailed/preempted/unclassifiedTerminal 均0；八个 canonical assistant usage 与终态账本逐字段一致。Cache Write、独立 Reasoning、费用及缺字段 componentTotal 保持 null，不用零值代替未知，不估算人民币或订阅扣减。

旧失败不被本次覆盖：`natural-team-family-20261004-1236` 达到八请求预算后父超时，原始四会话保留但完整终态用量缺失；`natural-team-family-20261004-1252` 有一个实际请求和error终态，403上游审核拒绝，usageFinal=false。此前失败成本未加入本次成功场景的236649，也没有当作零成本。

## 独立验证

原生 Jsonl 冷读与保存的完整四会话逐项相同；每轮前缀、seq、回答范围、turn/end、parent、角色、当前身份与原生 provider replay 均核对。保留宿主清理阶段追加的原生事件，未删原始日志。该清理记录不作为W2 pending保留证据。

验收器使用真实成功文件为黄金样本，并拒绝15类篡改。原始负例发现五个检查缺口后修复：epoch/hash、foreign provider、未实际交付adapter、伪造usage。19项验收器/预算检查通过；加强的是离线验收，不重跑已成功模型请求。

- `family-journals.json` SHA256：`9C5AC61B25C4FC0BE840BD5370043565F194BB3312D7B76BEEB8FFE14FCF2ED0`
- `request-evidence.json` SHA256：`381098C76B943F58BE760E0F102BA5343EABD8CBB777FFE5707AF8F1532EF629`
- `request-terminals.json` SHA256：`759F4EBF12C0A11652D5E73A46812E63A8B189C46A6BF83CC23130715BAB75A9`
- `family-evidence.json` SHA256：`555F735AAB1524B83F04585A2883D2DEC1E648C122E8DAFE7394E1C8C2D8BB57`
- 冷读 canonical object SHA256：`ae8cda78b8ce01fc04876124178e6f126ec611fabd80062371cc395c2a77689d`
- 独立回读日志：`D:/dsh-test/output/context-runtime-team-family-independent-r1-20261005.log`，SHA256 `43D0160255F13B8379A2F3B0ACBB06D18F7610DC92272A87C7B77606DAF39EDE`。
- 19项日志：`D:/dsh-test/output/context-runtime-team-family-verifier-r1-20261005.log`，SHA256 `2D915AF35B5644FF22EA4679A780E76CF2620BE3689B4B33555712330E05320B`。

共享模块在r13冻结版本上验收：209入口、1179tests/1178pass/0fail/1既有skip。r13之后仅加强本实验runner/verifier并新增黄金测试；共享运行时代码未变，不把r13称为包含新黄金测试。

## 剩余范围

仍需非Team与UI最终delivery门禁、Instant/W2/compaction联动、摘要缺项debt自然门禁、合法验证复用和最终安全同步/HMR运行证据、持久v12Evidence.records登记及原DSH root通知。async PTC按原条件评估，不因本场景强行启用。common文件动态变更的独立语义探针不在本次角色probe覆盖内，不能把角色A/B结果扩称所有身份变化场景完成。
