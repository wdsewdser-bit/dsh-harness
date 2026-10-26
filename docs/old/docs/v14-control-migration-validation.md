# v14 控制面迁移独立验收

日期：2026-09-25

本次只读检查选择 `D:\dsh-test\home\team-control-plane\session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json`，它是当前最大的旧控制面 JSON。live 文件只执行 dry-run；apply 在新建 fixture 目录中进行，没有启动服务、调用 provider、修改原生 session 或清理旧数据。

## 输入与 dry-run

- D 盘剩余空间：约 `33.2 GiB`。
- live snapshot：`62,723,741` bytes；迁移工具规范化读取统计 `bytesBefore=60,756,207`，`rooms=28`。
- live dry-run 命令：`node D:\dsh-test\tools\v14-control-migration.mjs --file D:\dsh-test\home\team-control-plane\session-7a601594-66f6-4255-92ba-1ef6813cbf1a.json --mode dry-run`
- dry-run 结果：成功，`coldBlobCount=null`，无 backup。
- live SHA-256（dry-run 前）：`8ae19a423b48c39332ec5b58b74c4c3386df3e23ab6a0433e292046c4bf28fd3`。
- live SHA-256（dry-run 后）：`8ae19a423b48c39332ec5b58b74c4c3386df3e23ab6a0433e292046c4bf28fd3`。

原始 JSON 复制到 fixture 后才执行 apply。原输入没有 `coldHistory`，因此没有需要从 live 复制的冷 blob 引用；迁移过程在 fixture 内生成新的 content-addressed 冷 blob。

## Fixture apply/reopen

fixture 目录：`D:\dsh-test\output\v14-control-migration-validation-20260925`

- fixture 输入：`control.json`
- migration backup：`control.json.v14-backup.json`
- apply 输出：`apply.json`
- 回读证据：`verification.json`
- apply 生成的热文件：`9,395,371` bytes
- backup 与 live 原 snapshot SHA-256 相同：是
- 实际冷 blob：`1,387` 个，合计 `52,091,951` bytes
- 工具 apply 输出中的 `coldBlobCount=30` 是工具当前的 room + event 摘要字段；上述 `1,387` 是目录中实际生成的全部 blob，包含 transcripts/inbox 引用。
- 通过 `controlPlaneFor('control', { directory: fixture })` reopen，并与 `readControlPlaneSnapshot` 直接回读比较：一致。

## 保留证据

| Room | messages 前/后 | message IDs | summary | unresolved 前/后 | unresolved IDs |
|---|---:|---|---|---:|---|
| root | 714/714 | yes | yes | 0/0 | yes |
| group:g-boot:tier-2 | 247/247 | yes | yes | 4/4 | yes |
| group:g-net:tier-2 | 417/417 | yes | yes | 0/0 | yes |
| group:g-core:tier-2 | 202/202 | yes | yes | 0/0 | yes |
| group:g-nbt:tier-2 | 163/163 | yes | yes | 0/0 | yes |
| level:1 | 314/314 | yes | yes | 0/0 | yes |
| group:g-src:tier-2 | 77/77 | yes | yes | 0/0 | yes |
| task:g-boot-wake-2 | 10/10 | yes | yes | 4/4 | yes |
| task:g-boot-p0-t38 | 9/9 | yes | yes | 4/4 | yes |
| task:g-boot-p0-t39 | 6/6 | yes | yes | 3/3 | yes |
| task:g-boot-wake-abl | 2/2 | yes | yes | 0/0 | yes |
| task:g-boot-wake-shots | 2/2 | yes | yes | 0/0 | yes |
| task:g-boot-wake-abl-2 | 3/3 | yes | yes | 0/0 | yes |
| task:g-boot-wake-scaf | 2/2 | yes | yes | 0/0 | yes |
| task:g-boot-p0-t16 | 6/6 | yes | yes | 2/2 | yes |
| task:g-boot-p0-abl | 4/4 | yes | yes | 2/2 | yes |
| task:g-boot-p0-shots | 2/2 | yes | yes | 2/2 | yes |
| task:g-boot-p0-t16b | 6/6 | yes | yes | 1/1 | yes |
| task:g-boot-p0-t31 | 4/4 | yes | yes | 2/2 | yes |
| task:g-boot-p0-t36 | 2/2 | yes | yes | 0/0 | yes |
| task:g-boot-p0-t16c | 4/4 | yes | yes | 1/1 | yes |
| task:g-boot-p0-t39b | 6/6 | yes | yes | 0/0 | yes |
| task:g-boot-p0-t16d | 2/2 | yes | yes | 1/1 | yes |
| task:g-boot-p0-t39c | 2/2 | yes | yes | 2/2 | yes |
| task:g-boot-p0-t31d | 2/2 | yes | yes | 2/2 | yes |
| task:g-boot-p0-t40 | 6/6 | yes | yes | 4/4 | yes |
| task:g-boot-p0-t37 | 4/4 | yes | yes | 2/2 | yes |
| task:g-boot-wake-3 | 1/1 | yes | yes | 0/0 | yes |

任务和控制面 ID 集合回读无缺失：

| 集合 | 前 | 后 | 缺失 |
|---|---:|---:|---:|
| rooms | 28 | 28 | 0 |
| rounds | 42 | 42 | 0 |
| plans | 189 | 189 | 0 |
| dispatches | 992 | 992 | 0 |
| leases | 242 | 242 | 0 |
| wakeEpisodes | 252 | 252 | 0 |
| escalations | 5 | 5 | 0 |
| privilegeRequests | 2 | 2 | 0 |
| evidence | 516 | 516 | 0 |
| packets | 29 | 29 | 0 |
| board tasks | 216 | 216 | 0 |

## 结论

fixture apply 后 reopen 读取完整历史成功，所有 Room messages/summary/unresolved、216 个任务及上述关键 ID 均保留。live dry-run 前后 snapshot hash 完全不变，backup 与原 snapshot hash 相同。本报告及 fixture 是新增验证产物；没有修改 live 控制面或原生 session。
