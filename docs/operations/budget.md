# 预算与计费账本

真实测试会消耗 token，所以有"两层账"：产品侧**规则**（`packages/context/budget.mjs`）与测试侧**台账**（`verification/real/budget.mjs` + `runs/real-budget.json`）。两者不是同一件事，不要合并。

## 产品规则（唯一的闸门实现）

见 内部设计记录 0004 与 0005：

- 闸门只看输入：估算输入 `I ≥ 0.75 × W` 即拒绝（`CONTEXT_75_PERCENT_GATE_BEFORE_REQUEST`）。
- 输出上限：`min(358000, W − I)`；`358000` 是网关在真实探测里接受过的最大 `max_output_tokens`。
- 预留：`max(65536, 请求序列化字节数 × 4) + 本次输出上限`，按上界而非实测预留。

## 测试台账 `runs/real-budget.json`

结构（只读，别手改）：

```json
{
  "version": 1,
  "total": 150536692,
  "stages": { "smoke": 82598, "p2-replay": 55273, "model-contracts": 4105298,
              "soak": 68504152, "collab": 75753902, "performance": 2035469 },
  "input": 147475858, "output": 3060834,
  "cacheHit": 133034112, "cacheMiss": 14441746,
  "pending": null
}
```

- `total` 是目前累计消耗；`stages` 按阶段分账；`pending` 是在途预留（可对账）。
- 阶段上限与全局上限在 `verification/real/config.mjs`：`globalLimit = 267400000`，各阶段 `stages` 见同文件；并发、时长、无进展超时也在那里。
- 台账是**跨进程事实**，带文件锁；并发预留由它维护，不由产品预算规则维护。

## 硬红线

```bash
sha256sum runs/real-budget.json
# 必须始终以 d507e92a 开头
```

- `npm test` 在运行前后各算一次 sha256，不一致即失败；需要账本的套件拿到的是字节副本（`DSH_BUDGET_LEDGER`），原件不可写。
- 不要手工改这个文件、不要用真实计费入口来做验证。真实验收（`verification/real/`）有独立文档与参数，默认入口不触碰。
