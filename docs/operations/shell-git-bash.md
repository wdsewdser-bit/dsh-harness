# Git Bash：Windows 上的唯一 shell

在 Windows 上，团队成员的命令统一走**固定路径的 Git Bash**，不沙箱、不回退到 `pwsh`、不取 PATH 上"下一个 bash"。这是 M4 的 WP-D（提交 `7eafe48`）。

## 它是怎么被选中的

- profile 里声明 `shell: 'git-bash'`；`packages/profiles/index.mjs` 只接受这一个值，其它值 `INVALID_CONFIG`。
- `packages/profiles/shell-entries.mjs` 提供 `bash-pin` 这个 Loader 条目：win32 上启用，其它平台**显式 disabled**（不是不存在），由 Loader 按实际平台决定。
- 固定的程序路径是 `C:/Program Files/Git/usr/bin/bash.exe`（`GIT_BASH`）；PATH 前缀也指向 Git 的 bin，保证 `bash -c ls` 用的是 Git 的 coreutils。

## 覆盖与失败

| 情况 | 行为 |
|---|---|
| 要换一个 bash | 设 `DSH_BASH_PATH` 指向可执行文件 |
| 指名的程序不存在 | `BASH_PIN_MISSING`（在生成 profile 时就拒绝，不写出一个装不上 shell 的部署） |
| 非 Windows | 条目 disabled，不使用任何替代 shell |

刻意不做的事：不提供沙箱、不承诺 OS 级写域隔离、不把 shell 绕过当成阻断（可检测、记录为 accepted-risk）。

## 本机 DSH 的后续

dsh-v2 仓库已经这样跑；你本机自己的 DSH（`DSH_HOME`）是否也切成 bash-pin，尚未执行——这件事按约定等重构完成后单独确认（相关记录属内部材料）。
