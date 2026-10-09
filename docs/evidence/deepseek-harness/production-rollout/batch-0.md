# 批次 0：生产服务端部署与核对

任务 34bU203Yom9UZ0tdhcFCf，对应项目验收判据 1。总览见 [README.md](README.md)。
执行工作区 orbit-prod，即 runner wikova（主机 vmi3129740），生产 Docker Compose 栈和 /root/orbit 都在这台机器上。
时间一律为 UTC，未注明日期的是 2026-10-07。

## 概要

| 项 | 值 |
| --- | --- |
| 部署提交 | `86203ffb0cb724f961c6d260679883078001f23e`（当时的 origin/main，包含 `25c3233c7`） |
| upgrade | 00:31:54Z 启动，00:34:35Z 结束；日志 `/var/tmp/orbit-upgrade-86203ffb0.log` 的末行是「✓ Upgrade complete — all services healthy.」 |
| 重建范围 | apiserver、web 重建；postgres、gateway 没有动 |
| orbit-postgres | Id `997b7775bdca…ba79b`，startedAt 2026-10-06T06:04:03Z，部署前后都没变 |
| 迁移 | 最新一条 `0392_user_password_hash_nullable`，共 391 行，与部署提交中的 391 个迁移目录一一对应；本次没有新迁移 |
| /dl | version.json 0.1.219，previous 0.1.217；部署前后版本号都没变 |
| dsh | 没有任何 runner 的 `engines[dsh]` 为 installed:true；以 `deepseek-harness` 新建会话返回 409 `DSH_NOT_INSTALLED` |
| 回退 | 没有执行 |
| 结论 | 通过 |

## 经过

- 2026-10-06 23:53Z 至 10-07 00:11Z，前三次运行 3Dl7sVROBvv1IMyI5vi7G2、3d6xatjuNd2nuGRCUp2UoY、1xsNV28sxOgKWfs996jTVs 都被派到 provider opencode（opencode/big-pickle），启动即失败，报错为「opencode runtime not initialized」。三次都是 0 轮，没有执行任何命令，没有动过生产栈，不需要回退。
- 00:18:59–00:19:11Z，协调会话把本项目五个任务都固定为 provider claude（账号所有者 2026-10-07 的选择）。
- 00:19:18Z，运行 3mItvylJnLdSaWzsLrhRQi 开始。它完成了部署前记录（00:29:45Z）和续聊样本，00:31:54Z 脱离会话启动 upgrade。00:32:45Z 它因 Claude 会话额度用完而中断，00:35:49Z 记为失败。upgrade 照常跑完了。
- 00:38:20Z，运行 6OUNvK78xRZkTVnRCfrFQC 接手，核对 upgrade 的结果并完成其余步骤。00:55:08Z 提交证据，任务随后判为 DONE。
- 部署只做了一次。

## 部署前（00:29:45Z）

部署历史：

- /root/orbit 在 main 上，没有已跟踪文件的改动；HEAD 与 origin/main 都是 `86203ffb0`。
- 最近一次部署是 `a3b4753d6aea3b42fd3508d32f18d5346e327fc5`，时间是 2026-10-06 23:13:06–23:17:57Z，日志末行为 ✓。它是另一项目的任务 34b6gj4DZ8BJhmxRBO9Bw「R · Wiki 新首页上线：部署与 TestFlight」用同一 upgrade 流程完成的（会话 18jQo1hSqi3fqakDMFbVJT，同在 orbit-prod）。
- 更早的 `c5dadf4b8`（2026-10-06 09:02:55Z）、`25cfa3b72`、`4920dab40`、`b31de23ca` 和 `a3b4753d6` 都包含 `25c3233c7`，日志末行也都是 ✓。所以本批不是第一次把含 dsh 的 main 部署到生产，而是一次增量部署。

镜像与容器：

| 服务 | 镜像 Id（`docker compose images`） |
| --- | --- |
| apiserver | 0e229f0c1875 |
| web | 26a506baa904 |
| postgres / pgbackup | d845e7f0ac85 |
| gateway | 8b1e78743a03 |

- orbit-postgres 的 Id 为 `997b7775bdcaa5acab1fb7c531d99d65ed41f7df903fb59d2601fb195b9ba79b`，created 2026-09-29T00:31:51Z，startedAt 2026-10-06T06:04:03Z，restarts 0，healthy。

版本、迁移与配置：

- /dl/version.json 为 0.1.219（linux-x64 sha256 `97b011b6…`）；/dl/previous/version.json 为 0.1.217（`15776d4f…`）。
- `_prisma_migrations` 的最新一条是 0392_user_password_hash_nullable（finished 2026-10-06 22:20:39Z）。共 391 行，unfinished 0，rolled_back 0，与 HEAD 中的 391 个迁移目录一一对应。
- runtime 为 dsh 的配置只有一条：`deepseek-harness`（id 01a10ee3-31dd-73ad-b11d-2ab3c8fcb834，label「DeepSeek Harness」，preset deepseek-harness），enabled=true，updated_at 2026-10-06 01:45:32。
- 旧 `deepseek` 配置：id 019fc645-9d5c-7ba2-9d44-ae9ccdbd7a9c，runtime claude，enabled=true。
- `GET /api/health` 返回 HTTP 200 `{"status":"ok"}`。

apiserver 日志（a3b4753d6 那个容器，每 10 分钟计数）：

| 时段 | ERROR | Prisma 事务超时 |
| --- | --- | --- |
| 2026-10-06 23:10Z | 2 | 2 |
| 23:20Z | 30 | 30 |
| 23:30Z | 121 | 122 |
| 23:40Z | 71 | 68 |
| 23:50Z | 1 | 1 |
| 10-07 00:00Z | 7 | 2 |
| 00:10Z | 9 | 0 |
| 00:20Z | 1 | 1 |

- 事务超时集中在 23:20–23:50Z，与 2026-10-06 23:14–23:43Z 的无响应时段重合，之后回落。
- a3b4753d6 那次 upgrade.sh 跑在 23:13:06–23:17:57Z，只覆盖无响应时段的开头；后面约 25 分钟不是 upgrade.sh 本身造成的。
- 00:27Z 主机状态：负载 15/23/45，swap 已用 8187.7 / 8192 MiB，僵尸进程 1536 个，磁盘可用 144G。
- 判断：health 为 ok，错误率已回落，可以部署。无响应的原因本批没有调查。

## 续聊样本（部署前建立）

两个会话都在 HPC 的 p6-dsh-smoke 工作区，permissionMode plan，只读提问「README.md 第一行写了什么」，都答出了「# P6 smoke repo」。

| 会话 | provider | runtimeSessionId | 首轮 |
| --- | --- | --- | --- |
| 34bUt0YKOjfafxUOxg5Ft | claude | adea2757-dfc3-4c28-b0cb-5cf95be5ce35 | 00:28:23Z init，00:29:03Z turn_end success |
| 34bUt3zW8ppuYt3Hmgpuh | 旧 deepseek（runtime claude，模型 deepseek-flash） | a6ce7e14-9508-4681-9b3e-2e5b780bead4 | 00:28:25Z init，00:28:30Z success |

这两个会话保留、没有结束，留给批次 1 复核。

## 部署（00:31:54–00:34:35Z）

- 启动前（00:31:31Z）：没有 /tmp/orbit-upgrade.lock，也没有 upgrade.sh 进程；/root/orbit 没有改动，`git pull --ff-only` 输出 Already up to date；HEAD 与 `git ls-remote origin main` 都是 `86203ffb0`，且包含 `25c3233c7`。
- 命令：`setsid nohup bash /root/orbit/.claude/skills/upgrade/upgrade.sh --prune > /var/tmp/orbit-upgrade-86203ffb0.log 2>&1 < /dev/null & disown`（pid 2968545）。
- web 的构建参数为 `ORBIT_SOURCE_SHA="86203ffb0cb724f961c6d260679883078001f23e"`。
- apiserver：新镜像 3c2637544989，容器 created 00:33:42Z。它的构建步骤全部命中缓存，但导出的镜像摘要变了，compose 仍然重建了它。
- web：新镜像 851ed37bdaf9，容器 created 00:33:54Z。
- postgres 与 gateway 在日志里是「Running」，没有动。
- 部署期间每 15 秒探测一次 `/api/health`：00:33:44Z 为 200，00:33:59Z 与 00:34:15Z 为 502，00:34:30Z 起恢复 200。这是 apiserver 重建的窗口，约 30–45 秒。
- orbit-postgres：00:42:12Z、00:44:09Z、00:48:13Z 三次核对，Id 都是 `997b7775bdca…ba79b`，startedAt 都是 2026-10-06T06:04:03Z，没有被重建，也没有重启。
- 00:42:54–00:43:40Z 执行 `docker builder prune -f --keep-storage 3gb`，回收 7.69GB，构建缓存从 11.05GB 降到 3.361GB。
- apiserver 启动日志：00:34:06Z「391 migrations found in prisma/migrations」，00:34:07Z「No pending migrations to apply.」，00:34:18Z「Nest application successfully started」。
- 部署后到 00:50Z，ERROR 共 4 条，都是 ERR_HTTP_HEADERS_SENT；没有事务超时。WARN 只有 APNs 403、FCM 未配置、plan usage 403 这些既有告警。
- 00:36:57Z，落地流程把 /root/orbit 快进到 `db69d833b`（test(runner): skip the agy contract tests on a machine without agy）。这个提交只改了 src/runner-go 下 5 个 `*_test.go`，没有迁移，版本号不变，也不编进 apiserver、web 或 runner 二进制。本批没有为它再部署：生产运行的是 `86203ffb0`。

## 部署后核对（00:42–00:48Z）

- `GET /api/health` 在 00:42:23Z、00:44:09Z、00:48:13Z 三次都是 HTTP 200 `{"status":"ok"}`。
- `_prisma_migrations` 的最新一条仍是 0392_user_password_hash_nullable，共 391 行，unfinished 0，rolled_back 0。部署提交中最新的迁移目录也是它，共 391 个，两边差集为空。
- /dl/version.json 仍是 0.1.219，但 linux-x64 sha256 从 `97b011b6…` 变成 `47c4a2e4…`：web 镜像用 `86203ffb0` 重编了 runner 二进制，版本号没变。runner 自更新只比较版本号，所以这次部署不会触发自更新。/dl/previous 仍是 0.1.217。
- runner：部署前（00:29:54Z）、部署后（00:44:15Z）、收尾（00:48:14Z）三次的取值完全相同，只有心跳时间不同。

| runner | 版本 | 最近心跳（前 / 后 / 收尾） | 声明 provider:dsh | selfUpdate | engines[dsh] |
| --- | --- | --- | --- | --- | --- |
| wikova 33aHx39nnWbvJhYO2blSk | 0.1.219 | 00:29:39Z / 00:44:09Z / 00:48:09Z | 是 | enabled，/usr/local/bin | installed:false，`DSH_NODE_UNSUPPORTED` |
| workstation 33yiv1Y24wrKHcVCo8Fk5 | 0.1.211 | 00:29:38Z / 00:44:08Z / 00:48:08Z | 否 | null | installed:false，`DSH_NODE_UNSUPPORTED` |
| longdeMac-mini.local 349tsNoHC7biW3WXF1ddp | 0.1.213 | 00:29:48Z / 00:43:48Z / 00:47:48Z | 否 | null | installed:false，`DSH_PLATFORM_UNSUPPORTED` |
| workstation-gpu（HPC）34P34HcKKoFRn2j9KitgJ | 0.1.219 | 00:29:26Z / 00:43:56Z / 00:47:56Z | 是 | enabled，/usr/local/bin | installed:false，`DSH_NOT_INSTALLED` |

- 四台都是 ONLINE。`engines[dsh].dsh` 在四台上相同：versionCompatible、credentialPresent、modelCatalogReadable 都是 false；requestValidation、sandboxEnforcement、auth 都是 unknown。
- 判定：没有任何 runner 的 `engines[dsh]` 为 installed:true。wikova 与 HPC 声明了 provider:dsh，这是自更新带来的预期状态。
- `deepseek-harness` 部署后仍是 enabled=true，updated_at 没变。

## 旧引擎

全部在 HPC 上执行，run_event 都由 workstation-gpu 摄入。逐轮核对 run_event 中 init 的 sessionId 是否等于会话的 runtime_session_id。

| 会话 | 本次 | init 的 sessionId | 结果 |
| --- | --- | --- | --- |
| claude 样本 34bUt0YKOjfafxUOxg5Ft | 00:44:52Z 发出只读追问，00:45:28Z turn_end success | adea2757-…，与部署前相同 | 没有重读文件，凭对话记忆答出「# P6 smoke repo」并列出 3 项 |
| 旧 deepseek 样本 34bUt3zW8ppuYt3Hmgpuh | 00:44:54Z 发出，00:45:01Z success | a6ce7e14-…，没有变化 | 同样凭记忆答对 |
| 新建 claude 34bVIMUkCWj2pv4g0ZXjn（plan） | 00:44:58Z 创建；首轮 00:45:00Z init、00:45:32Z success；续聊 00:46:16Z init、00:47:07Z success | 两轮都是 bee732f3-2856-412c-bd70-c9e0a3d8b6f2 | 首轮答「# P6 smoke repo」，续聊凭记忆答对；00:47:34Z 用 session_end 结束（CANCELLED，未删除） |

两个样本会话在 00:48:13Z 都是 AWAITING_INPUT，error 为空，runtimeSessionId 与部署前相同。

## dsh 门禁

本步没有安装 dsh，也没有启用或改动任何配置。

1. session_create（p6-dsh-smoke，provider `deepseek-harness`，permissionMode plan），00:45:07Z 返回 400：`DeepSeek Harness cannot enforce permission mode "plan"; use Default, Auto or Don't Ask`。这是权限模式校验，不是安装门禁；runtime-environment 文档写明安装状态在权限模式校验之后判断，结果与文档一致。
2. 同样的调用改用 permissionMode default，00:45:20Z 返回 409：`DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet; install it from Providers, then try again`。
3. Web 用的入口 `POST https://orbitd.io/api/sessions`（以账号所有者身份，provider `deepseek-harness`，permissionMode default），00:45:34Z 返回 HTTP 409，正文与第 2 条相同。

只读 SQL：00:44Z 之后新建的会话只有本批那一个 claude 会话；provider 为 deepseek-harness 或 dsh 的会话为 0 个。被拒的请求没有写入任何会话。

## 回退准备与回退

- 没有执行回退。
- 回退准备：部署前记录了 /root/orbit 的 HEAD、上一次部署、各服务镜像 Id、orbit-postgres 容器 Id 与迁移最新一条（见上）；本次部署没有新迁移；`deepseek-harness` 保持 enabled 且没有改动，一级回退随时可用；此时没有任何 runner 安装 dsh。
- 批次 0 的记录没有列出 apiserver、web 镜像的回退目标。运维文档第 4 节的两级回退都不涉及服务端。

## 与运维文档的偏差

- 运维文档第 3 节批次 0 预期所有 runner 都不声明 provider:dsh，dsh 创建返回 409 升级提示。生产上 wikova 与 HPC 已因自更新声明了 dsh，对 HPC 的创建得到的是 409 `DSH_NOT_INSTALLED`。没有对未声明 dsh 的 runner（workstation、Mac）测试升级提示。项目作业指导「生产现状」一节已认可这一点（总览「不一致之处」第 1 条）。
- 对 dsh 配置用 plan 模式创建会话会先得到 400，所以批次 1 起冒烟改用 Default 或 Auto。

## 剩余限制与观察

1. 生产运行的是 `86203ffb0`，main 已前进到 `db69d833b`（只改了 runner 测试文件）。下次有人跑 upgrade，会把它和之后的提交一起部署。
2. 本次 apiserver 构建全部命中缓存，镜像摘要仍然变了，apiserver 因此被重启。即使 apiserver 没有改动，upgrade.sh 也会重启它；部署窗口内 `/api/health` 会有约 30–45 秒的 502。
3. 2026-10-06 23:14–23:43Z 无响应的原因没有调查。00:47Z 主机 swap 仍然用满（8191 / 8191 MiB），僵尸进程有 1565 个。
4. 旧引擎只在 HPC 上实测了 Claude 新建与续聊、旧 deepseek 续聊；Codex、Kimi、OpenCode、Antigravity 以及其他 runner 没有实测。
5. 需要用户身份的接口：在 apiserver 容器内为账号所有者签一个 1 小时的令牌，写到 /dev/shm（权限 0600），没有打印；令牌文件已在 00:51:35Z 删除。只读 SQL 每条前先 `SET default_transaction_read_only = on`，没有查询 provider 的 Key 或密文列。
6. 另一项目的任务 34b6gj4DZ8BJhmxRBO9Bw 已在 2026-10-06 23:47Z 打出 v0.1.2-beta.187（`6c6528dbb`，包含 `25c3233c7`），早于金丝雀，见 [client-release.md](client-release.md)。

## 来源

- 核对记录：任务评论 34bVUtZhZJKPg5vaNEraQ（1/2）、34bVVZniyRQhTZsaycMVi（2/2）。
- 判断会话评论：34bUm2gmhaole2TfcL5D2（00:23Z，opencode 失败与上一次部署）、34bVBk663JQQc3UX7L60p（00:40Z，从 HPC 只读核对部署）、34bVE1TPZyB8isNhTi0dT（00:42Z，HPC 磁盘）。
- 完成证据 5TT2CwyxVKJyZUB4q8sQp9（00:55:08Z，22 条引用）；其中后台作业 bgj_e2d818179fbb 为部署前记录，bgj_2dcc55bf8d4a 为部署后核对，bgj_edc2f50072f9 为收尾复核。
- 脚本与原始输出在 wikova 的 /var/tmp/orbit-b0/。
