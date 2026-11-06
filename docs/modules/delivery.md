# 模块 · delivery

Git、worktree、独立 verifier 子进程这些 IO，以及合并回执与恢复适配。它是**唯一受管的 Git 变更入口**。

- 包名：`@dsh-v2/delivery`
- 公共入口：`packages/delivery/index.mjs`
- 允许依赖：`contracts`、`core`（只用端口类型）
- 测试入口：3 个测试文件（`packages/delivery/test`：`fix2`、`readback`、`worktree-base`）挂在 `npm test -- --only=adapter-build` 里。

## 职责

- `createGitRunner` / `createGitGuardRunner`：受根目录约束的 git 调用（`assertGitTarget`、`resolveGitRoots`），默认只允许 `runs/` 下的仓库。
- `createDeliveryPort`：提交、worktree、读回与回执。
- `verifier.mjs`：独立验收，证书签名校验 `certificateIsSigned`。

## 公共接口

单一入口 `.`。

## 边界

- 不判定"任务算不算完成"：它给出证据（精确 commit/tree、verifier 结果），判定在 `core` 的 goal 规则。
- 不写 team 库；回执经 host 的 effect 消费者落库。
