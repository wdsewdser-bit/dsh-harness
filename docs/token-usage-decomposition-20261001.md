# DSH Token Usage 拆分

## 最新回填更正

下面的旧 cache 和单工作区解压结果仅保留作历史快照，不再作为当前完整统计。
最新入口为 `D:\dsh-test\docs\usage-audit-20261001\README.md`，严格扫描报告为
`history-2026-09-30T19-40-10-849Z-report.json`。

- 统计单位是用户 root 加全部层级 descendants，不能拿单个 child 否定 Team 总量。
- 两工作区 138 个源文件，经 v3/v4 去重得到 145,805 条调用记录。
- 已记录 total 为 44,011,704,608，仍有 181 条 total 未记录。它不是完整后台账单。
- mc189-rs 已记录 33,246,934,466；RustMc 已记录 10,764,770,142。
- 北京时间 2026-09-23 已记录 5,538,603,165，支持用户每天约 50 亿的观察。
- 已知总量中 cacheRead 为 41,810,397,409（约 95.00%），非缓存输入为
  1,942,741,811（约 4.41%），输出为 258,565,388（约 0.59%）。
- 平均 prompt 约 30 万 token，P50 239,169，P95 716,669。大头是长输入乘以大量轮次。
- Compaction 请求已记录 total 为 784,363,655，约占已知总量 1.78%。
- 与用户后台 47,672,606,230 的差额为 3,660,901,622，尚未完成同口径对账，不能填造补齐。

ObservationPack 的约 7.42 亿是机制估算，而不是 provider 的反事实账单；
除以不同快照的 476.73 亿得到约 1.56%，只说明量级，不能宣称这是实际总节省率。
“唯一归档只占原文约 12%”之类存储去重比例也不是发送给模型的 token 节省率。

新请求账本已通过无重启 HMR 加载，现有 RustMc root 的后续真实请求已记录；
无需用户另开会话。历史原 journal 没记录的字段仍为 null。

## 结论（按用户后台截图修正口径）

用户后台显示的是一个 root 会话下整个 Agent Team 的聚合，这个口径是正确的：子代理仍属于同一个工作流，不能用“单个子 session”来否定它。截图卡片为：

- total `47,672,606,230`
- input `47,401,706,869`
- output `270,899,361`
- reasoning `137,410,206`

其中 `input + output = total`；reasoning 是 output 的子项，不应再次相加。此前把“单个 session”和“一个 root Team 会话”混用，结论偏保守，现以 Team 聚合为用户侧主口径。

本地 journal 能证明一部分历史，但不能完全重建这张 UI 卡片：journal 的标准化 usage 把 `inputTokens` 与 `cacheReadTokens` 分开，旧记录也没有 `reasoningTokens` 和稳定的 protocol 字段；UI 可能使用了另一个累计投影或 billed-input 口径。

## 旧 usage cache 的 40 个 session

来源：`D:\dsh-test\home\cache\team-usage-cache.json`，SHA256 `9F9F7B22FC9A5766DD89E2497787EC4EB0B1141B46C21617D740B204F52BB584`。

| 指标 | 数值 | 占 total |
|---|---:|---:|
| input | 473,890,340 | 2.80% |
| output | 90,676,048 | 0.54% |
| cacheRead | 16,381,402,483 | 96.67% |
| total | 16,945,968,871 | 100% |

这批 cache 覆盖约 133.75 小时（5.57 天），折算约 30.4 亿 total/day，不是单个 session 的日消耗。

最高的单个旧 session 是 `0d9f795f-e340-4e13-9d6e-48d766488889`：

- total `2,078,035,259`
- 时间跨度约 127.79 小时
- 平均约 3.90 亿/day
- 其中 cacheRead `2,031,736,960`

## 当前 RustMc 工作区 journals

对 `D:\dsh-test\home\sessions\--D-dsh-test-workspaces-RustMc--` 下 35 个 v4 journal 做了只读解压统计（读取时刻的最新快照）：

- total `10,749,378,451`
- 时间跨度约 95.35 小时（3.97 天）
- aggregate 约 `27.1 亿/day`
- 北京时间日桶：
  - `2026-09-27`: `2,192,036,587`
  - `2026-09-28`: `4,048,467,005`（最高日，约 `40.5 亿`）
  - `2026-09-29`: `2,422,762,684`
  - `2026-09-30`: `2,066,020,268`
  - `2026-10-01`: `20,091,907`（截至读取时）
- 最高日 `2026-09-28` 中 `3,930,684,154` 是 cacheRead，约占该日 `97.09%`。
- 最高单 session：`session-028e6f5b-1716-4c23-a232-af16d853d191`
  - total `1,713,856,582`
  - 时间跨度约 95.34 小时
  - 平均约 `4.32 亿/day`
  - input `26,798,904`
  - output `11,638,542`
  - cacheRead `1,675,419,136`
  - request/header 中可见 `opencodego` 44 次、`cmd` 4 次；模型分别为 `deepseek-v4.1-flash` 和 `deepseek/deepseek-v4.1-flash`

按用户的后台项目口径，`mc-189-rs` 约 300 亿、`RustMc` 约 170 亿，合计约 470 亿，和截图的 47.67B 一致。两个 root Team 仍应分别统计，再在项目/账户层相加；不要拿单个 child session 的 journal 值去替代 root Team 卡片。

按这个用户侧分母，ObservationPack 的当前 `742359130` 估算节省只相当于约 `1.56%`（`742359130 / 47672606230`）。此前相对旧 169.46 亿 cache 子集的 `4.38%` 不能用于判断这两个项目的完整收益。

## 为什么 token 看起来这么大

旧 40-session cache 快照中约 96.67% 是 `cacheReadTokens`，并非全部两工作区的比例。
最新严格回填的已知总量中约 95.00% 是 cacheRead。这代表长上下文被多轮读取，
不是模型每轮重新生成了同样数量的全新 token。

因此要分开看：

- “本地已记录调用 total”：约 440.12 亿，含输出，且仍不完整。
- “非缓存输入 + 输出”：约 22.01 亿。
- “真实花费”：当前无法从本地数据直接算出，因为 usage cache 没有 provider、协议、单价和 cache-read 价格字段。

`cacheReadTokens` 仍可能计费；没有当前中转账单规则和单价，不能把缓存与新输入按同价折算，也不能直接报告金额收益。

## 如何补齐

### 现有会话：可以直接补，但只能补“已有字段”

可以对现有 v3/v4 journal 做只读回放，生成历史账本，补齐：

`rootTeam / childSession / provider / model / timestamp / input / output / cacheRead / total`

provider/model 对多数 v4 请求可从 `request/header.data.header.config` 和 descriptor 推导。这个过程不需要新建会话，也不修改原始 session。

不能从旧 journal 准确补出的字段必须标 `unknown`，不能伪造：

- `reasoningTokens`（旧 usage 对象没有保存）；
- `cacheWriteTokens`（旧 usage 对象没有保存）；
- Chat Completions 与 Responses 的稳定协议标识；
- 中转后台 UI 的最终 billed-input 归一化规则。

### 现有会话继续运行：从下一次请求开始补齐

不需要你新建会话。只要在 LLM response/usage 边界加一条 durable usage ledger，当前 root Team 和其后续子代理请求都会记录完整字段。已经结束的历史请求不会被重新写入真实 provider receipt，只能保留为 `historical/partial`。

### Reducer：历史可离线回放，真实收益必须新请求

历史归档可以验证 reducer 的提示、receipt 引用和压缩上限，但不能证明 DS4.1Flash 在 `opencodego` 上的真实耗时、质量和账单。要验证线上收益，不需要新建会话；让现有会话在启用小批真实测试后继续产生几条大日志即可。但在授权前不能自动打开路由。

## Provider / protocol 归因现状

- v4 journal 的 `request/header.data.header.config` 能识别 `opencodego`、`cmd` 和模型。
- 旧 `team-usage-cache.json` 的 provider 字段多数为空，因为汇总逻辑只累计 usage，没有回填 request header 的 provider。
- 当前 journal 中没有稳定、结构化的 `chat/completions` 或 `responses` 字段；协议归因暂标 `unknown`，不能凭文本命中下结论。

## 对节省效果的影响

ObservationPack 只处理符合条件的工具输出，不能减少全部系统区、工具定义、Team 消息和历史思维。
旧 4.38% 比较使用的是不完整 cache 子集，不再作为收益结论。

如果要明显降低总量，下一步需要把每次 request 的以下字段持久化到独立 usage ledger：

`sessionId / teamId / provider / model / protocol / input / output / cacheRead / cacheWrite / mechanism / requestId / timestamp`

没有这层归因，无法判断真正的大头是某个 session、某种 provider 路由，还是重复 cache prefix。

## 边界

- 本次只读解压和统计 journal/cache。
- 未修改 DSH profile、未启用 Reducer、未切换 Responses、未重启 DSH、未中断 Team、未清理任何历史数据。
