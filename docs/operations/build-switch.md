# 构建切换：0.2.2 与 buildTarget

本仓库跑在**一个已准备好的上游构建副本**上，不是直接跑 `node_modules`。版本判定只有一个函数：`packages/adapter-dsh/build-target.mjs` 的 `buildTarget()`。

## 配置在哪

`build/builds.json`（唯一配置源，代码里不许出现盘符路径，`check-deps` 规则 c 会拦）：

```json
{
  "default": "<path-to-dsh-c1-build-0.2.2-rc.1>",
  "pristine": {
    "0.2.2-alpha.2": "<path-to-dsh-upstream-0.2.2-alpha.2>/install/node_modules/@deepseek-ai/",
    "0.2.2-rc.1": "<path-to-dsh-upstream-0.2.2-rc.1>/install/node_modules/@deepseek-ai/"
  },
  "builds": {
    "0.2.2-alpha.2": { "c1": "<path-to-dsh-c1-build-0.2.2>", "c2": "<path-to-dsh-c2-build-0.2.2>" },
    "0.2.2-rc.1": { "c1": "<path-to-dsh-c1-build-0.2.2-rc.1>", "c2": "<path-to-dsh-c2-build-0.2.2-rc.1>" }
  },
  "patches": "upstream-0.2.2-rc.1",
  "borrow": { "release": "0.2.2-rc.1" }
}
```

- `default`：本次要跑的构建副本（当前是 0.2.2-rc.1 的 C1 副本）；`builds[version]` 给出每个版本的 C1/C2 对，`patches` 选补丁集，`borrow.release` 必须等于 default 构建自身 manifest 的版本（`verification/unit/build-target.test.mjs` 断言）。
- `pristine[version]`：该版本只读的上游安装，构建副本是它的补丁产物。`load()` 从 pristine 读，`loadBuild()` 从构建副本读。
- 只剩两个 0.2.2 release。**0.2.1-rc.4 已在 M8 放弃支持**（2026-11-05）：补丁集整包归档在 `<path-to-archive>/patches-upstream-0.2.1-rc.4-20261105.zip`，`builds`/`pristine` 里不再有它的条目，所以回退只在 0.2.2 的两个 build 之间。

## 谁能覆盖

| 变量 / 文件 | 作用 |
|---|---|
| `DSH_UPSTREAM_BUILD` | 直接指名一个构建副本路径（测试与变异运行用它） |
| `runs/m1b-build-current.txt` | `verification/prepare-build.mjs` 准备完构建后写入的指针；没有 `DSH_UPSTREAM_BUILD` 时读它 |
| `DSH_BUILD_ROOT` | 覆盖 `default`（不改配置文件时的临时切换） |

优先级：`DSH_UPSTREAM_BUILD` → 指针文件 → `DSH_BUILD_ROOT` / `default`。

## 准备一个新构建

```bash
node verification/prepare-build.mjs          # 幂等；已完整打过的副本直接复用
node verification/prepare-build.mjs --force  # 重建
```

它把 C1 副本复制出来并应用 `patches/upstream-0.2.2-rc.1/` 下的补丁（llm-dispatch、instant-preempt、execution-permit、role-tool-boundary、goal-veto、team-layout）。pristine 安装全程只读；每一步缺失都是 `PATCH_MISSING`，不会悄悄退回未打补丁的构建。

## 版本判定读什么

`buildTarget()` **读构建自己的 `@deepseek-ai/dsh/package.json` 和它实际带的插件包**，不按路径猜，也没有按版本号写死的分支：

- 构建 manifest 的版本只用来查 `pristine[version]` 与 `borrow.release`。
- 是否带 executor 插件、是否带 llm-dispatch、是否带 boundary-wake 的 latch，决定能力探测结果。0.2.2 起每个 release 都带 `dsh-tool-executor-native`（`dsh-tools` 自己的 `mode` 是 `z.never()`），因此接线只有一套：缺这个包就是 `PATCH_MISSING`，不存在"退回旧接线"的分支。
- 缺配置/读不到/版本不符 → `PATCH_MISSING`（fail-closed）。

## 支持矩阵

本树只有一个受支持组合：**恰好 0.2.2-rc.1** 的 prepared build（带 llm-dispatch、execution-permit/1、瞬时抢占的 executor）配已登记的 transport。0.2.2-alpha.2 的 build 仍可装配（`pristine` 里有它的路径，`builds` 里有 C1/C2），它是 p4-* 系列里的"上一版对照"臂；但 super-agent 借鉴（v1）在它上面是 `PATCH_MISSING`；v1 目前整体仍是 contract-only、默认 off。见 内部设计记录 0001。
