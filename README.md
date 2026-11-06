# dsh-harness

A team-orchestration host built on top of [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH). It lets several DSH agents work as one team: a lead plans and assigns work, members run in parallel, and every decision, message and delivery is recorded in a durable store you can inspect from a web panel.

[中文说明](#中文说明)

> Status: personal research project. It targets one exact upstream release (DSH **0.2.2-rc.1**) and is not an official DeepSeek product. Expect rough edges.

## What it adds to DSH

- **Team host** – a single driver per team that owns scheduling, leases, mailboxes, decision threads and goal rules. Domain writes go through one command executor (reducers inside a SQLite transaction), so the UI, tools and host can never disagree about state.
- **Context management** – an input-only 75% budget gate, safe compaction plus optional folding, an immutable artifact store with ACL-checked recall, and a budget ledger that treats missing usage data as unknown, never as zero.
- **Delivery** – Git worktrees per task, verifier subprocesses and explicit states (`produced` → `verified` → `merged` → `accepted`) that are reconciled against real refs.
- **Upstream patches** – small, versioned patch sets applied to a *copy* of the upstream install (LLM dispatch, instant pre-emption, execution permits, role/tool boundaries, goal veto, team layout). The pristine install is never modified; a missing patch fails closed (`PATCH_MISSING`).
- **Web panel** – read-only projections over HTTP/SSE: team board, member sessions, threads and budget.
- **ptc-boost** – an optional plugin that improves DSH's programmatic tool calling (batching hints, output truncation, read de-duplication).

## Layout

```text
packages/
  contracts    IDs, error codes, schemas, tool definitions          (no deps)
  store        SQLite transactions, event log, outbox
  context      budget, gate, artifacts, recall, folding
  adapter-dsh  version adapter for the upstream DSH install
  core         pure domain rules and command reducers
  delivery     Git / worktree / verifier IO
  host         the single team driver and write gateway
  projections  read models and HTTP/SSE read API
  ui           browser panel (talks to projections over HTTP only)
  profiles     composition root: wires ports and plugin order
  ptc-boost    optional upstream plugin overlay
patches/       patch sets per upstream release
verification/  offline test runner, unit/integration/e2e suites, dependency and size checks
tools/         launcher for the web deployment
docs/          architecture, host protocol, per-module and operations docs
```

Dependency direction is enforced by `npm run check:deps`; see [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js **24+**. No third-party dependencies and no `npm install` step.
- An installed copy of `@deepseek-ai/dsh@0.2.2-rc.1` (only needed for build preparation, real-provider tests and the web deployment; the offline test suite uses a deterministic fake provider).
- Windows is the primary platform (Git Bash is used as the shell); most of the code is platform-neutral.

## Getting started

```bash
git clone https://github.com/wdsewdser-bit/dsh-harness.git
cd dsh-harness
npm test                 # offline suites, fake provider, no network (*)
npm run check:deps       # layering, cycles, deep imports, hard-coded paths
npm run check:size
npm run check:parity -- --check
```

(*) Suites that compose a real host (`host`, `profiles`, `superagent-borrow`, the e2e and `real/` suites) need a prepared upstream build from the steps below and fail without one; `core`, `ui`, `driver-surface` and the checks run from a plain clone.

To run against a real DSH install:

1. Install DSH 0.2.2-rc.1 somewhere, then copy `build/builds.example.json` to `build/builds.json` and point it at that install and at the directory where the patched copy should go (see [docs/operations/build-switch.md](docs/operations/build-switch.md)).
2. `node verification/prepare-build.mjs` – copies the install and applies `patches/upstream-0.2.2-rc.1/`. Idempotent; `--force` rebuilds.
3. Start the web deployment: set `DSH_V2_HOME` (a DSH home with your provider profile), optionally `DSH_LOGS`, `DSH_TMP`, `DSH_START_PORT`, then `node tools/launch-web.mjs`. Stop it with `node tools/stop-web.mjs`.

Provider credentials are never stored in this repository; the launcher only passes a reference to the credential file inside your DSH home.

## Documentation

Start with [docs/README.md](docs/README.md). Most design documents are written in Chinese.

- [Architecture](docs/architecture.md) – layers, dependency matrix, fact ownership
- [Host protocol](docs/host-protocol.md) – responsibilities, invariants, effect protocol
- [Modules](docs/modules/) – one page per package
- [Operations](docs/operations/) – running tests, build switching, budget, browser acceptance

## License

[MIT](LICENSE). Files under `patches/**/original/` are verbatim copies of upstream DSH sources, distributed under the upstream MIT license ([patches/UPSTREAM-LICENSE](patches/UPSTREAM-LICENSE)).

---

## 中文说明

dsh-harness 是建在 DeepSeek 的 [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)（DSH）之上的团队宿主，让多个 DSH 代理组成一个团队协作：组长规划、分派任务，成员并行执行，所有决策、消息和交付都写进持久存储，可以在网页面板上查看。

> 状态：个人研究项目，只适配上游 **0.2.2-rc.1** 这一个版本，不是 DeepSeek 官方产品。

**主要内容**

- **团队宿主**：每个团队只有一个驱动，负责调度、租约、邮箱、决策线程和目标规则；所有领域写入都经同一个命令执行器（SQLite 事务内的 reducer）。
- **上下文管理**：只看输入的 75% 预算闸门、安全压缩加可选折叠、带权限检查的不可变 artifact 存储；缺少用量数据时记为未知，不当成零。
- **交付**：每个任务一个 Git worktree、verifier 子进程，状态分为 produced / verified / merged / accepted，并和真实 ref 对账。
- **上游补丁**：补丁打在上游安装的副本上，原始安装不动；缺补丁直接报 `PATCH_MISSING`，不会悄悄退回未打补丁的版本。
- **网页面板**：通过 HTTP/SSE 只读查看看板、成员会话、线程和预算。
- **ptc-boost**：可选插件，改进 DSH 的程序化工具调用（批量化提示、输出截断、读取去重）。

**快速开始**：需要 Node.js 24 以上，无第三方依赖，不用 `npm install`。克隆后直接 `npm test` 跑离线测试（用假 provider，不联网）；其中需要装配真实宿主的套件（host、profiles、e2e 等）要先准备上游构建。接真实 DSH 时，先把 `build/builds.example.json` 复制成 `build/builds.json` 并填上本机路径，再运行 `node verification/prepare-build.mjs` 和 `node tools/launch-web.mjs`。详见 [docs/README.md](docs/README.md)。
