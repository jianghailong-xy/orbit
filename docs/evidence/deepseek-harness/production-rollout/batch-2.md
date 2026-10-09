# 批次 2：wikova、workstation 安装 dsh，盘点其余 runner

任务 34bU211JgZyyUgzJcnZMp，对应项目验收判据 3。总览见 [README.md](README.md)。
执行工作区 orbit-prod（runner wikova，主机 vmi3129740）。workstation 上的命令经 shell 会话 34bZJX6q3fN8SypZ9U3sO（工作区 wikova-data，`POST /api/sessions {shell:true}`）下发：runner 直接 `bash -lc` 执行，不经模型，输出取自 run_event 的 shell tool_result 行。
脚本和原始输出在两台的 /var/tmp/orbit-b2/ 下。时间一律为 UTC。

## 概要

| runner | 切换窗口 | 切换后的 runner | dsh 安装 | 冒烟 / 旧引擎复核 | 结论 |
| --- | --- | --- | --- | --- | --- |
| wikova 33aHx39nnWbvJhYO2blSk | 2026-10-07 07:08:20–07:11:27Z | 0.1.220（重启时自更新），之后空闲自更新到 0.1.225（构建 `29f49af63`） | 10-08 13:29:56Z 调用，13:31:13Z 的心跳起 installed:true | dsh 34cNSSDl4tdb3AFvWZ96x ✓；claude 34cNUGdgMMC0BPwiYLNZ3 ✓ | 已上线 |
| workstation 33yiv1Y24wrKHcVCo8Fk5 | 2026-10-09 03:16:37–03:18:36Z（03:17:06Z 重启） | 0.1.225（构建 `3369ee1e0`，即 /dl 当前件） | 03:20:51Z 调用，03:21:37Z 的心跳起 installed:true | dsh 34chrCdV3Pqc9ywqmwF0A ✓；旧 deepseek 34chs0lwiGOiBhbDNYkPD ✓ | 已上线 |
| longdeMac-mini.local 349tsNoHC7biW3WXF1ddp | — | — | 没有安装（`DSH_PLATFORM_UNSUPPORTED`） | — | 未上线 |
| workstation-gpu（HPC）34P34HcKKoFRn2j9KitgJ | — | — | 批次 1 已安装 | — | 批次 1 金丝雀，本批只盘点 |

两台的服务 PATH 都用 systemd drop-in 换成独立安装的 Node v26.10.0，只改 runner 服务的 PATH；Node 用官方 linux-x64 tarball，GPG 签名与 SHASUMS256 核对通过。两次切换时都没有进行中的回合，被 detach 的会话都标为 resumable 并已恢复；没有触发回退条件。

## 授权、决定与经过

- 2026-10-07T00:58:34Z，账号所有者在 ask_owner 34bVbpt27vgsugOmz7mmq 中选择「两台都改」：允许为 wikova 与 workstation 的 runner 服务换用 Node 26，把 workstation 的 runner 升级到生产 /dl 最新版，并在没有进行中回合时各重启一次。
- 10-07 01:42Z 开工（执行会话 3teIrnWKC6L6rqIZlt5bRQ）。01:54Z 第 2 步命中停止条件：wikova 仓库的 CI 用 Node 20、Dockerfile 用 node:22。两台都没改，用 project_send 报告了协调会话（请求 34bWxt4krBtDDcogRftrw）。
- 同一时刻，按任务原写法在 wikova-data 建 provider claude 的会话被拒：409 `ENGINE_SIGNED_OUT`「Claude Code is signed out on runner "workstation"」。所以 workstation 的旧引擎复核用旧 deepseek。
- 01:54–03:23Z 执行会话因 Claude 账号额度暂停，期间没有执行任何命令。
- 03:26:52Z，账号所有者在 ask_owner 34bZCiT7ADYUXoTBCRnwq 中选择「照改并重装 wikova 依赖」，任务于 03:28Z 重写。
- 03:52Z，协调会话答复请求 34bZpibKHswmrnGU88QUL，在上述授权之内收窄范围：
  - 原生模块只判本机平台（linux-x64 glibc）适用的 10 个，musl 变体照实列出，不作为回退条件；
  - wikova 两个主目录不重装依赖，claude-code/node_modules 也不动，改为切换后在新 runner 环境里重做加载测试（理由见「改动前只读核对」）；
  - drop-in 到切换窗口开始时才放进去；
  - wikova 由 systemd-run 守门脚本重启：只在 wikova 上没有 RUNNING / PENDING 会话、也没有 bg 作业时重启，超过 30 分钟仍不空闲就放弃并报告；
  - workstation 是否临时暂停 FineWeb 派发，由协调会话发卡问账号所有者。
- 04:03:45Z，账号所有者在 ask_owner 34bZsuanb5Xf6ue22DACP 中选择「暂停 FineWeb 派发」（协调会话评论 34baBgx9kiCI7Bpe9kufy）。
- 04:29:59Z，协调会话答复请求 34ban11k6ItukVMIlLzfB，选 A：重开守门脚本，时限 3 小时，规则不变。
- 07:08–07:11Z，第 2 轮守门脚本完成 wikova 的切换。07:34Z 执行会话 3teIrnWKC6L6rqIZlt5bRQ 因 Claude 周额度失败；它的进度和评论里没有记下这次切换，由 10-08 的会话依据日志补齐。
- 2026-10-08，账号所有者指示「全部上线就好」。协调会话把任务的 provider 由 claude 改为 anthropic-2，13:23:03Z 起新会话 4VRFSLrBeq2V3L7hBh0NY9，并放宽了 wikova 的重启授权（这时 wikova 已于 10-07 完成切换）。
- 10-08 13:23Z 之后，执行会话四次因 API 429 中止（15:24Z、15:37Z、16:15Z、16:54Z），都没有动过 runner、provider 配置或 FineWeb。判断会话两次设了定时启动（16:45Z 与 10-09T03:00Z）。
- FineWeb（项目 01a02d83）于 2026-10-08T15:08:51.039Z 暂停，paused_reason 为 OWNER。
- 2026-10-09T03:00:23Z，执行会话 77p34f53E5Gnq1HV4N1cqO 由定时启动，完成 workstation 的切换与收尾，03:39:32Z 提交证据。

## 改动前盘点（2026-10-07T03:48:55.724Z）

`GET /api/runners`，HTTP 200，账号下共 4 台。

| runner | 平台 | 版本 | 最近心跳 | 在线 | 声明 provider:dsh | selfUpdate | engines[dsh] |
| --- | --- | --- | --- | --- | --- | --- | --- |
| wikova 33aHx39nnWbvJhYO2blSk（vmi3129740） | os:linux | 0.1.219 | 03:48:39.400Z | ONLINE，activeSessions 4 | 是 | waitingForIdle，/usr/local/bin | installed:false，`DSH_NODE_UNSUPPORTED` |
| workstation 33yiv1Y24wrKHcVCo8Fk5（登记主机名 gateway，实机 hostname 为 workstation） | os:linux | 0.1.211 | 03:48:38.251Z | ONLINE，3 | 否 | null | installed:false，`DSH_NODE_UNSUPPORTED` |
| longdeMac-mini.local 349tsNoHC7biW3WXF1ddp | os:darwin | 0.1.213 | 03:48:48.485Z | ONLINE，2 | 否 | null | installed:false，`DSH_PLATFORM_UNSUPPORTED` |
| workstation-gpu（HPC）34P34HcKKoFRn2j9KitgJ | os:linux | 0.1.219 | 03:48:26.291Z | ONLINE，5 | 是 | waitingForIdle，/usr/local/bin | installed:true，0.2.0-rc.2，versionCompatible true |

- capabilities：wikova 与 HPC 共 27 项，含 provider:claude/codex/opencode/antigravity/dsh；workstation 与 Mac 共 26 项，少 provider:dsh。
- 03:37:17Z 起，生产 /dl/version.json 为 0.1.220（linux-x64 sha256 `1d8fc42d…efd0`），/dl/previous 为 0.1.219。这是 wikova 上另一会话 01a113da「Git 拉取并升级」部署的 `38b8f366b`（chore(release) … as 0.1.220），不是本任务做的。因此 wikova 和 HPC 的 selfUpdate 变为 waitingForIdle，workstation 的升级目标变为 0.1.220。

## 改动前只读核对

wikova（本机，10-07 01:47Z）：

- unit orbit-runner-root.service（/etc/systemd/system/），User=root，没有 drop-in。
- 服务 PATH：`/root/.bun/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`（unit 与进程 environ 一致）。
- 其中 node 为 /usr/bin/node v22.22.2（nodesource 包 22.22.2-1nodesource1，npm 10.9.7），也是系统默认 node。
- runner：/usr/local/bin/orbit 0.1.219，sha256 `b425ce08…850c5d`，sourceSha `25cfa3b72`（与 HPC 同一构建）；MainPID 2820548，ActiveEnterTimestamp 2026-10-06T23:44:59Z，NRestarts=1。

workstation（shell 回合，10-07 03:28:53Z）：

- Debian 12，x86_64。unit orbit-runner-root.service，User=root，没有 drop-in。
- unit 的 PATH：`/root/.local/bin:/root/.nvm/versions/node/v22.17.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/jdk/bin`。进程 environ 前面还多了 `/root/.opencode/bin:/root/.kimi-code/bin`：进程自 2026-10-05T12:24Z 启动后原地 re-exec 过。
- 其中 node 为 nvm 装的 /root/.nvm/versions/node/v22.17.1/bin/node v22.17.1（npm 11.4.2）；没有系统 nodejs 包，登录 shell 的默认 node 也是它。
- runner：/usr/local/bin/orbit 0.1.211，sha256 `b8b10ce7…5639`（与 HPC 留存的回退件同一构建），sourceSha `728c3feb`。
- 不自更新的原因（journal）：自 2026-10-05 起每 10 分钟一条「orbit 0.1.219 update available; deferred — 2/3 turn(s) in flight, checking again in 10m0s」，共 152 条，一次都没有空闲过。selfUpdate 为 null，是因为 0.1.211 早于 selfUpdate 上报功能。
- 忙的来源：wikova-data 的 WARC 流水线，属于 FineWeb 项目 01a02d83（109,402 个 OPEN 任务，maxConcurrentTasks 3）。

各工作区仓库对 Node 版本的要求（git 已跟踪文件，HEAD 与 origin 默认分支都扫了）：

| 主机 / 目录（工作区） | HEAD | 要求 |
| --- | --- | --- |
| wikova /root/orbit（orbit-prod） | `db69d833b` = origin/main | package.json engines.node ">=26.0.0"；ci.yml、docs.yml 用 node-version 26；Dockerfile 用 node:26-slim / node:26-alpine；pages.yml 用 setup-node@v4、node-version 20 |
| wikova /root/wikova-develop（wikova-develop） | develop 2645954（origin/main 344f75a 相同） | 没有 engines.node、.nvmrc、.node-version；build-client.yml 四处 node-version 20；apiserver、crawler、scheduler、worker 的 Dockerfile 用 node:22-bookworm-slim，frontend 用 node:22-alpine |
| wikova /root/wikova（wikova-prod） | main 21a86a7，10 个已跟踪文件有未提交修改（不含 package.json 和 lockfile） | 同上 |
| workstation /root/wikova（wikova-data） | main 344f75a = origin/main，干净 | 同上 |
| workstation /root/lfs（lfs） | main 7498876 = origin/main | 没有 package.json；docker/Dockerfile 用 debian:trixie；不是 JS 仓库 |
| workstation /root/wikids（wikids） | main 27ea05c = origin/main | engines.node ">=20"（不排除 26）；release.yml 用 node-version "20"；Dockerfile 用 node:20-alpine |

包管理器、lockfile 与原生模块（wikova 上两个主目录 /root/wikova、/root/wikova-develop 完全相同）：

- 根目录为 npm workspaces（apiserver、worker、crawler、scheduler、cli、packages/*、claude-code/pkgs/agent-sdk），package-lock.json v3，sha256 `18a206e0…cd74`。
- frontend/ 是独立的 npm 项目，package-lock.json v3，sha256 `0e91e55a…81bd`。
- claude-code/pnpm-lock.yaml，sha256 `f64a0df6…bf4d`。只有 /root/wikova 有 claude-code/node_modules：2026-04 用 pnpm 装的，没有原生模块；主机上没有 pnpm。
- 根目录与 frontend 的 package.json 都没有 preinstall / install / postinstall / prepare。
- 每个目录 20 个 .node 文件，逐个在主机上加载，Node 22.22.2 与 Node 26.10.0 的结果相同：
  - 可加载的 10 个（glibc）：frontend/node_modules 下的 @rollup/rollup-linux-x64-gnu、@tailwindcss/oxide-linux-x64-gnu、@tauri-apps/cli-linux-x64-gnu、lightningcss-linux-x64-gnu；node_modules 下的 @msgpackr-extract/msgpackr-extract-linux-x64（node.abi115.glibc.node 与 node.napi.glibc.node）、@resvg/resvg-js-linux-x64-gnu、@rolldown/binding-linux-x64-gnu、@rollup/rollup-linux-x64-gnu、lightningcss-linux-x64-gnu。
  - 加载失败的 10 个：上述各包对应的 -musl 变体，报错为缺 libc.musl-x86_64.so.1，或 /lib/x86_64-linux-gnu/libc.so: invalid ELF header。它们是给 Alpine 用的可选平台包，Node 22 下同样失败，与 Node 版本无关。
- 不重装依赖的理由：适用于本机平台的 10 个原生模块都是 N-API 预编译件，在 Node 22 和 26 下都能加载，不存在 ABI 冲突。
- workstation 的 /root/wikova 没有 node_modules（主目录深度 ≤ 4 内一个都没有），那里没有可重装的依赖。
- 会话 worktree：wikova 仓库在 wikova 上有 6 个、在 workstation 上有 49 个，都没有自己的 node_modules。
- wikids：主目录没有 node_modules；9 个 worktree 中有 5 个带 node_modules 且含 .node，按规则只记录，不重装。
- 其他：/root/orbit 有 3 个 .node（rolldown gnu、lightningcss gnu 在 Node 26 下可加载，lightningcss musl 不可加载）；wikova 主机 /usr/lib/node_modules 下全局包的 5 个 linux-x64 原生模块在 22 与 26 下都可加载；workstation 上 nvm Node 22 的全局包里有 27 个 .node，没有测。
- wikova 上的 wikova-* 容器只挂载 /root/wikova 的 config 与 data 目录，不挂 node_modules。

## 回退点与 Node 26 准备

改动前的回退点：

- wikova：unit 原文副本在 /var/tmp/orbit-b2/rollback/wikova-orbit-runner-root.service（775 字节），没有 drop-in；runner 0.1.219，sha256 `b425ce08…850c5d`；lockfile sha256 见上。
- workstation：unit 原文副本在其 /var/tmp/orbit-b2/rollback/workstation-orbit-runner-root.service（sha256 `753b4729…cbf2`），没有 drop-in；runner 0.1.211，sha256 `b8b10ce7…5639`。0.1.211 的回退件在 HPC 的 /root/.orbit/rollback/。
- 两台的 NeedDaemonReload 都是 no。

Node v26.10.0（官方 linux-x64 构建）：

- 来源：`https://nodejs.org/dist/v26.10.0/node-v26.10.0-linux-x64.tar.xz`，tarball sha256 `ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022`，与 SHASUMS256.txt 核对通过。
- SHASUMS256.txt.asc 的签名有效（`gpg --verify` 为 GOODSIG / VALIDSIG）：EDDSA 签名钥 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356（Antoine du Hamel，在 nodejs/node README 的发布者列表里），签名时间 2026-09-22T09:02:05Z。
- wikova 于 10-07 03:38:15Z、workstation 于 10-07 03:51:02Z 解包到 /opt/node-v26（root:root，229M），切换前不在任何 PATH 上。
- 两台的 bin/node sha256 都是 `ab9c8eecf9f82d6693cdc3accced17034065c8d96213b0aa76a7e803d20ae1da`，与 tarball 内的文件相同；`node --version` 为 v26.10.0，ABI 147，N-API 10，npm 11.19.1。
- 10-07 做 GPG 核对时留下的一个 gpg-agent，在 wikova 切换的 SIGKILL 中被一并杀掉（见下）；10-08 在 wikova、10-09 在 workstation 复核时，临时 GNUPGHOME 用完后都 kill 了 gpg-agent。

## wikova 切换（2026-10-07T07:08–07:11Z）

守门脚本：

- /var/tmp/orbit-b2/restart-gate.sh，以 systemd-run 临时单元运行，不在 orbit-runner-root.service 的 cgroup 里，重启不会杀掉它。
- 空闲判定：只读生产 DB，wikova 上没有 RUNNING / PENDING 会话，且任何会话的 running_bg_jobs / running_bg_shells 都为空；相隔 10 秒的两次读取都成立才算空闲。
- 第 1 轮（orbit-b2-restart-gate-20261007T035632）：03:56–04:26Z 没有空闲窗口，EXIT=GAVE_UP，没有做任何改动。
- 第 2 轮（orbit-b2-restart-gate2-20261007T043119）：04:31:20Z 启动，截止 07:31:20Z。

切换窗口：

- 07:08:20.081Z：两次读取都空闲，打开窗口。当时 wikova 上 24 小时内有活动的 AWAITING_INPUT 会话 13 个，包括执行会话本身（07:06:44Z 结束回合）。
- 07:08:22.020Z：放入 /etc/systemd/system/orbit-runner-root.service.d/10-node26-path.conf（sha256 `dd2525dc4201842d194038e2b5241ac9ecee49cdddd660c4e2a6c7342e07dedf`），并 daemon-reload。
- 07:08:22.410Z：第三次读取仍空闲，执行 `systemctl restart`。
- 07:08:22–07:08:26Z：runner 开始 drain，把 7 个还有 warm 引擎的会话 detach，日志为「detached for shutdown (resumable)」（01a1142c、01a0f5f4、01a113da、01a10ea9、800ff1af、01a11525、01a1145f）。
- runner 进程随后没有退出。07:11:22.519Z systemd 的 stop 超时（180 秒），对整个 cgroup 发 SIGKILL。同时被杀的有集成作业 0d3afadd（LAND_TASK，项目 01a0f53a，任务 01a1149d）正在跑的合并前检查，以及做 GPG 核对时留下的一个 gpg-agent。守门脚本只看会话和 bg 作业，没有看 runner 认领的集成作业，这是它的漏洞。
- 07:11:22.674Z：服务重新启动；07:11:23.2–23.9Z 启动时自更新 0.1.219 → 0.1.220 并 re-exec；07:11:27.865Z 脚本记 EXIT=RESTARTED。

drop-in 全文：

```ini
# Batch 2 of the DeepSeek Harness rollout (task 34bU211JgZyyUgzJcnZMp): put the separately installed
# Node v26.10.0 (/opt/node-v26, official linux-x64 build, SHASUMS256-checked) first on this runner
# service's PATH; everything after it is the unit's own PATH unchanged. Rollback: delete this file,
# systemctl daemon-reload, restart the service while no turn is in flight.
[Service]
Environment=PATH=/opt/node-v26/bin:/root/.bun/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

改动前后：

| | 改动前（10-07 01:47Z 核对，07:08Z 前守门脚本复读） | 改动后（07:11:27Z） | 10-08 13:24–13:28Z |
| --- | --- | --- | --- |
| unit 的 PATH | `/root/.bun/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`，没有 drop-in | `/opt/node-v26/bin:` 加上原 PATH，DropInPaths 为上述 drop-in | 同左，NeedDaemonReload=no |
| 进程 environ 的 PATH | 与 unit 相同 | `/root/.opencode/bin:/root/.kimi-code/bin:/opt/node-v26/bin:/root/.bun/bin:…`（runner 启动时自行前置 opencode、kimi） | 同左 |
| PATH 上的 node | /usr/bin/node v22.22.2 | /opt/node-v26/bin/node v26.10.0 | 同左 |
| runner | 0.1.219，sha256 `b425ce08…850c5d`，MainPID 2820548 | 0.1.220，sha256 `7a1b67cf…235ae1`，MainPID 4085193 | 0.1.224，sha256 `ddd875d4…340c1b`，MainPID 373553 |

- 系统默认 node 没有改：/usr/bin/node 仍是 v22.22.2。全部 service 单元中，Environment 引用 /opt/node-v26 的只有 orbit-runner-root.service；/etc/profile*、/etc/environment 和 root 的 shell 配置都没有引用它。同机另一账号的 orbit-runner-husong.service 的 PATH 没有变。

切换时进行中的工作与恢复：

- 没有进行中的回合，也没有 bg 作业或 bg shell。
- 被 detach 的 7 个会话都标为 resumable；之后收到新消息的 5 个（01a113da、800ff1af、01a10ea9、01a1142c、01a1145f）都正常续上。800ff1af 随后因 Claude 周额度失败，与切换无关。其余会话没有收到新消息，保持 AWAITING_INPUT。
- 07:12:46–47Z，新进程 reclaim 了 01a11360-1ffc（opencode）和 74dba685（deepseek），并重新挂上它们的 worktree。
- 集成作业 0d3afadd：07:12:00Z 被新进程重新认领（claim_generation 2），从头重跑；TASK_ACCEPTANCE 通过（1401 秒），MERGE_CHECK 到 3600 秒超时，08:37:37Z 记为 CHECK_FAILED。重启前的上一次尝试 928944ae（10-07 05:45–06:55Z，Node 22 环境）的 MERGE_CHECK 已经是 exit 1。这次超时是否与重启或 Node 26 有关，无法判定。所属项目 01a0f53a 与任务 01a1149d 都已 DONE，该项目 10-07 07:00Z 之后没有新的集成作业，所以没有再去唤醒它的协调会话。

切换后的两件事（都不是本任务的操作）：

1. 10-07 10:16–10:18Z 主机全局 OOM：内核记录 tempo 触发 oom-killer（constraint NONE），被杀的是 runner cgroup 里的 tsc（anon RSS 2.9 GB）。systemd 因此按 oom-kill 停掉整个 unit：10:20:01Z drain 到时，4 个会话被中途 tear down（680f6be7、711c5ceb、a96b124c、de97dc12）；10:20:30Z 记为 Failed（oom-kill），本轮 memory peak 11.7G；10:20:35Z 自动重启（restart counter 1），启动时自更新 0.1.220 → 0.1.221，PATH 仍带 /opt/node-v26/bin。4 个会话都在 10:21:24–27Z 恢复，其中 711c5ceb、a96b124c、de97dc12 之后 SUCCEEDED，680f6be7 于 10:30:01Z FAILED，错误为「acceptance command exited 1; expected 0」。按 PATH 推断那个 tsc 由 Node 26 执行，进程已不在，无法核实；OOM 与 Node 26 是否有关，无法判定。
2. 空闲时原地自更新，MainPID 373553 不变，环境变量沿用：0.1.221 → 0.1.222（10-07T23:40:44Z），0.1.222 → 0.1.224（10-08T11:21:03Z），0.1.224 → 0.1.225（10-08T14:21:15Z）。

## wikova 切换后核对、安装 dsh 与冒烟（2026-10-08）

切换后盘点（`GET /api/runners`，13:28:19.303Z，HTTP 200）：

| runner | 版本 | 最近心跳 | 在线 | provider:dsh | selfUpdate | engines[dsh] |
| --- | --- | --- | --- | --- | --- | --- |
| wikova | 0.1.224 | 13:28:13.186Z | ONLINE，activeSessions 2 | 是（capabilities 31 项） | enabled，上次 0.1.222→0.1.224 于 11:21:04Z | installed:false，`DSH_NOT_INSTALLED`（不再是 `DSH_NODE_UNSUPPORTED`） |
| workstation | 0.1.211 | 13:28:08.423Z | ONLINE，3 | 否（26 项） | null | installed:false，`DSH_NODE_UNSUPPORTED` |
| longdeMac-mini.local | 0.1.224 | 13:27:57.684Z | ONLINE，0 | 是（31 项） | enabled，上次 0.1.223→0.1.224 于 09:32:27Z | installed:false，`DSH_PLATFORM_UNSUPPORTED` |
| workstation-gpu（HPC） | 0.1.222 | 13:27:56.621Z | ONLINE，6 | 是（30 项） | waitingForIdle | installed:true，0.2.0-rc.2，versionCompatible true，modelCatalogReadable true |

新 runner 环境下的原生模块复测（13:27:45–13:27:55Z）：

- 环境：执行会话就是 orbit-prod 的新会话，进程链为 bash → claude → orbit run 373553（runner MainPID），cgroup 为 /system.slice/orbit-runner-root.service，PATH 与 runner 进程相同；node 取 PATH 上的 `command -v node`，即 /opt/node-v26/bin/node v26.10.0（ABI 147，N-API 10）。
- 做法：/var/tmp/orbit-b2/load-test.sh 对每个 .node 文件单独起一个进程 require，cwd 为 /tmp，只读。
- 结果：/root/wikova（wikova-prod）与 /root/wikova-develop（wikova-develop）都是适用模块 10/10 加载成功；10 个 -musl 变体照旧失败，不作判定。与 10-07 在主机上用 Node 22.22.2 和 26.10.0 测的结果逐行相同。
- 依赖与 lockfile 没有动：两个主目录的 package-lock.json、frontend/package-lock.json、claude-code/pnpm-lock.yaml 用 `sha256sum -c` 与改动前的记录核对全部 OK；node_modules 目录的 mtime 仍为 2026-04/05/06。
- 判定 ✓：两个主目录中适用于本机平台的原生模块在 Node 26 下全部加载成功。

安装 dsh：

- 安装前复读配置（只读 SQL，不取 Key 列）：`deepseek-harness`（01a10ee3-…，runtime dsh）enabled=true，updated_at 仍是 2026-10-06T01:45:32.893Z；runtime 为 dsh 的配置只有这一条；旧 deepseek 与 anthropic-2 都没有改动。
- orbit-prod 以账号所有者身份调用 `POST https://orbitd.io/api/runners/33aHx39nnWbvJhYO2blSk/install`，body `{"engine":"dsh"}`。13:29:56.373Z 发出，HTTP 201，返回 `{"status":"pending","engine":"dsh","command":null,"message":null,"mode":"install"}`。
- 每 15 秒读一次：心跳 13:29:43Z、13:30:13Z、13:30:43Z 时仍为 installed:false；心跳 13:31:13.688Z 起为 installed:true，version "0.2.0-rc.2"，versionCompatible true。
- 本机：/root/.orbit/engines/dsh/0.2.0-rc.2 于 13:30Z 发布，`node_modules/@deepseek-ai/dsh/lib/bin.js` 的 sha256 为 `1a03dee1…f307f`，与运维文档第 1 节的固定值一致。
- 判定 ✓：capabilities 含 provider:dsh；`engines[dsh]` 为 installed:true，version 0.2.0-rc.2。

dsh 冒烟：会话 34cNSSDl4tdb3AFvWZ96x（UUID 01a11bb6-b207-742c-80ce-80a1899f4b5b），工作区 orbit-prod，provider `deepseek-harness`，permissionMode default，模型未指定。run_event 共 15 条，全部由 wikova 摄入；error 事件 0 条，审批相关事件 0 条。

| 轮次 | 时间 | 事件 | 内容 |
| --- | --- | --- | --- |
| 启动 | 13:32:10.770Z | seq 1 system/launch | provider dsh，runtime acp，cliVersion 0.2.0-rc.2 |
| 1 新建 | 13:32:14.172Z | seq 2 system/init | provider dsh，cliVersion 0.2.0-rc.2，sessionId = runtimeSessionId = a0f26522-b781-4c3f-a468-33d8952c30f7，resumed:false |
| 1 新建 | 13:32:16Z | seq 6–7 | 唯一一次工具调用：读 package.json，isError false |
| 1 新建 | 13:32:17.550Z | seq 10 turn_end | completed / end_turn |
| 2 同进程续聊 | 13:32:37–13:32:39.023Z | seq 11–15 | 没有新的 init，没有工具调用；seq 15 turn_end 为 completed / end_turn，runtimeSessionId 仍是 a0f26522-… |

- 问答只读：第 1 轮答「name 是 orbit，engines.node 是 >=26.0.0」，第 2 轮凭记忆复述了文件、两个字段和值；没有出现审批卡，changedFiles 为空。
- dsh 进程 pid 685408，父进程是 runner 373553，exe 为 /opt/node-v26/bin/node，cwd 是会话 worktree。
- 13:33:18Z 用 session_end 结束（CANCELLED，end_reason ended），没有删除；/root/.orbit/dsh-sessions/01a11bb6-… 保留。
- 判定 ✓：init 为 provider dsh / cliVersion 0.2.0-rc.2；两轮都是 end_turn；ACP 会话 id 不变。同一进程内的续聊不要求 `resumed:true`。

旧引擎复核（claude）：会话 34cNUGdgMMC0BPwiYLNZ3（UUID 01a11bb7-c954-70cf-b3ea-334b48ab99d1），工作区 orbit-prod，provider claude，permissionMode default，模型 claude-opus-5-5；run_event 全部由 wikova 摄入，error 事件 0 条。

| 轮次 | init | turn_end |
| --- | --- | --- |
| 1 新建 | 13:33:26.214Z，sessionId 844fdcfd-35a9-432a-8b73-622653b5410d | 13:33:32.141Z success |
| 2 续聊 | 13:34:37.754Z，sessionId 844fdcfd-… 相同 | 13:34:41.952Z success |

会话的 runtime_session_id 是 844fdcfd-…；13:35:07Z 用 session_end 结束，没有删除。判定 ✓：Claude 新建与续聊成功，runtimeSessionId 不变。

## workstation 切换（2026-10-09T03:00–03:20Z）

前提：

- FineWeb（01a02d83）的 paused_at 为 2026-10-08T15:08:51.039Z，paused_reason 为 OWNER（03:01:17Z 只读核对）。
- FineWeb 暂停后，workstation 已经自更新过一次：10-08T17:44:08Z 之前每 10 分钟一条「deferred — 1 turn(s) in flight」；10-08T17:54:08Z「orbit 0.1.225 update available and no turn in flight」，drain 时把 01a11468、01a005f5、01a104c1 三个会话 detach（均为 resumable），17:54:11Z online。这是原地 re-exec：MainPID 1830 不变，环境变量沿用旧的，PATH 上仍是 nvm 的 Node 22.17.1。装上的 0.1.225 是 10-08 15:32Z 部署的 `721e48275` 构建，sha256 `6b127daa…2c69`。
- 之后 /dl 又以同一版本号 0.1.225 发布了新构建：/dl/version.json 为 0.1.225，linux-x64 gz sha256 `b9026d4d…1e94`，解压后 `68b8db09…b0d`，sourceSHA `3369ee1e0`（10-08T21:39Z 部署）。wikova 上的 0.1.225 又是另一份构建（`a583bcc2…`，`29f49af63`）。

切换前盘点（`GET /api/runners`，03:02:26.397Z，HTTP 200）：

| runner | 版本 | 最近心跳 | 在线 | provider:dsh | selfUpdate | engines[dsh] |
| --- | --- | --- | --- | --- | --- | --- |
| wikova | 0.1.225 | 03:02:25.462Z | ONLINE，activeSessions 1 | 是（32 项） | enabled，上次 0.1.224→0.1.225 于 10-08T14:21:15Z | installed:true，0.2.0-rc.2，versionCompatible true，modelCatalogReadable true |
| workstation | 0.1.225 | 03:02:12.070Z | ONLINE，0 | 是（34 项） | enabled，没有 lastUpdated* | installed:false，`DSH_NODE_UNSUPPORTED` |
| longdeMac-mini.local | 0.1.225 | 03:02:02.885Z | ONLINE，0 | 是（32 项） | enabled，上次 0.1.224→0.1.225 于 10-08T13:52:29Z | installed:false，`DSH_PLATFORM_UNSUPPORTED` |
| workstation-gpu（HPC） | 0.1.225 | 03:02:09.899Z | ONLINE，10 | 是（34 项） | enabled，上次 0.1.222→0.1.225 于 10-08T15:33:39Z | installed:true，0.2.0-rc.2，versionCompatible true，modelCatalogReadable true |

workstation 的其他引擎：claude 已装（2.1.295，auth no）；codex 已装、version null、auth no，journal 每 30 分钟一条「Codex is not runnable: Missing optional dependency @openai/codex-linux-x64」，切换前就有；kimi、opencode 未安装；antigravity 1.3.2，auth yes。

预检（03:04:03Z，只读）：

- unit：MainPID 1830，NRestarts 0，TimeoutStopUSec 3min，KillMode mixed；/etc/systemd/system/orbit-runner-root.service.d 不存在。
- unit 的 PATH 与 node 同改动前；备好的 drop-in /var/tmp/orbit-b2/workstation-10-node26-path.conf 的 sha256 为 `3d84aff3…a382`，与 10-07 的记录一致；/opt/node-v26/bin/node 的 sha256 为 `ab9c8eec…1da`，v26.10.0。
- 常驻负载只有「僵尸会话清扫器」01a104c1（provider deepseek）：大约每 10 分 7 秒一个回合，每回合 70–110 秒；切换窗口选在它两个回合之间。

空闲判定（只读 SQL，/var/tmp/orbit-b2/ws-busy.sh），四条同时成立：

1. workstation 上没有 RUNNING / PENDING 会话；
2. 没有在跑的 bg 作业或 bg shell；
3. 近 14 天活跃的会话里没有未 ANSWERED 的回合；
4. 没有 finished_at 为空的集成作业（补上了 wikova 守门脚本漏看集成作业的问题）。

清扫器回合 579 于 03:12:17Z 答复，之后 03:15:21Z、03:15:46Z、03:16:37Z 三次判定都是 IDLE。

第一次发出（03:15:47Z），脚本在第 (2) 步自己停下，没有改动：

- `orbit upgrade` 本身成功，sha256 核对也都对上；最后一项「复读 /dl/version.json」用的是 Python urllib，被 Cloudflare 回了 HTTP 403，脚本按设计判为不一致。
- 03:15:55Z 脚本把二进制恢复为原来的 `6b127daa…`，没有放 drop-in，也没有重启。这是核对脚本自己的问题，不是与文档不符；改用 curl 后重发。
- 副作用：/usr/local/bin/orbit 被替换过两次，所以第二次 (0) 里 /proc/1830/exe 显示为「(deleted)」，内容 sha256 仍是 `6b127daa…`。

第二次发出（03:16:37.951Z，脚本 ws-switch2-cmd.sh，03:16:46Z 结束）：

- (0) 改动前：MainPID 1830，NRestarts 0，没有 drop-in；/usr/local/bin/orbit 0.1.225，sha256 `6b127daa…`，sourceSHA `721e48275`。
- (1) 在本机复核 Node v26.10.0：重新下载 SHASUMS256.txt.asc，`gpg --verify` 为 GOODSIG / VALIDSIG（同一把签名钥，签名日期 2026-09-22）；签名正文里 tarball 的 sha256 为 `ca70e9e3…f022`，`sha256sum -c` 成功；tarball 内的 bin/node 与 /opt/node-v26/bin/node 的 sha256 都是 `ab9c8eec…1da`。
- (2) runner：原二进制留存为 /var/tmp/orbit-b2/rollback/orbit-before-switch2（`6b127daa…`）。03:16:43Z `orbit upgrade` 输出「already on 0.1.225; reinstalling to repair... ✓ orbit is now 0.1.225」。gz 的 sha256 `b9026d4d…` 与 /dl/version.json 一致，解压后 `68b8db09…` 与 /usr/local/bin/orbit 一致，版本 0.1.225，sourceSHA `3369ee1e0`；03:16:45.711Z 判定通过。0.1.225 的 upgrade 对 root 的服务不迁移、不重启，下载件与 version.json 的 sha256 不符时会拒装。
- (3) 03:16:45Z 放入 /etc/systemd/system/orbit-runner-root.service.d/10-node26-path.conf（sha256 `3d84aff3…a382`），然后 daemon-reload；unit 的 PATH 变为 `/opt/node-v26/bin:` 加原 PATH，NeedDaemonReload=no。
- (4) 用 systemd-run 起临时单元 orbit-b2-ws-restart-20261009T031646.service（在 /system.slice 下，不在 runner 的 cgroup 里）：等 20 秒让这一 shell 回合先结束，然后 restart，90 秒后自检。若 runner 不在 running、NRestarts 不为 0 或运行不足 60 秒，就自动回退：删 drop-in、daemon-reload、换回原二进制并重启。设这道自动回退，是因为 runner 起不来时 shell 会话也就发不出命令了。

drop-in 的注释行与 wikova 的相同，`[Service]` 下为：

```ini
Environment=PATH=/opt/node-v26/bin:/root/.local/bin:/root/.nvm/versions/node/v22.17.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/jdk/bin
```

切换窗口（2026-10-09）：

- 03:17:06.132Z restart，当时 MainPID 1830；03:17:06.147Z「runner stopping; draining session supervisors...」。
- 03:17:06.285–.298Z detach 三个会话，日志均为「detached for shutdown (resumable)」：01a005f5（FineWeb 协调会话）、01a104c1（清扫器）、01a11468（下发命令的 shell 会话）。
- 03:17:06.357Z Deactivated successfully：停机约 0.2 秒，没有走到 stop 超时，也没有 SIGKILL。
- 03:17:06.402Z Started；03:17:07.375Z runner "workstation" online，新 MainPID 1460277。
- 03:17:11.64–.95Z reclaim 12 个会话，其中 8 个重新挂上 worktree：01a005f5、01a02fe3（LFS 协调会话）、01a03f47、01a08627、01a0cd2a、01a0ddc4、01a0e2d1、01a0efd7、01a104c1、01a10c06、01a11468、e66f72d5。
- 03:18:36.457Z 临时单元自检：MainPID 1460277，active/running，NRestarts 0，uptime 90s，判为 HEALTHY，没有触发自动回退。
- 进行中的工作与恢复：切换时没有进行中的回合，也没有 bg 作业、bg shell 或集成作业；清扫器的下一回合（seq 580）03:21:02Z 建立，03:22:23Z 由新进程正常答复；shell 会话之后的 4 个回合都正常；其余 10 个被接管的会话没有收到新消息，保持 AWAITING_INPUT。
- 新进程 03:17:07Z 启动时有一条「codex model catalog refresh failed: exit status 1」。切换前 10-08T17:54:12Z（Node 22 下）启动时也有同样一条，原因是该机 codex 缺可选依赖，与本次切换无关。

改动前后（workstation）：

| | 改动前（03:16:38Z） | 改动后（03:19:25Z 与 03:26:55Z 两次相同） |
| --- | --- | --- |
| unit 的 PATH | `/root/.local/bin:/root/.nvm/versions/node/v22.17.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/jdk/bin`，没有 drop-in | `/opt/node-v26/bin:` 加原 PATH，DropInPaths 为上述 drop-in，NeedDaemonReload=no |
| 进程的 PATH | `/root/.opencode/bin:/root/.kimi-code/bin:` 加 unit 的 PATH | 与 unit 的 PATH 相同（opencode、kimi 在该机都未安装，新进程没有前置它们） |
| PATH 上的 node | /root/.nvm/versions/node/v22.17.1/bin/node v22.17.1 | /opt/node-v26/bin/node v26.10.0（npm 11.19.1） |
| runner | 0.1.225（`721e48275` 构建，sha256 `6b127daa…`），MainPID 1830，自 10-05T12:24Z 起 | 0.1.225（`3369ee1e0` 构建，sha256 `68b8db09…`，与 /dl 当前件一致），MainPID 1460277，自 03:17:06Z 起；没有设置 `ORBIT_NO_SELFUPDATE` |

- 系统默认 node 没有变：workstation 没有 /usr/bin/node，登录 shell 的 node 仍是 nvm v22.17.1。/etc/systemd/system 与 /lib/systemd/system 下，引用 /opt/node-v26 的只有这个 drop-in。
- runner 版本与升级时间：0.1.211 → 0.1.225（`721e48275` 构建）于 10-08T17:54:08–11Z 空闲时自更新，这是 FineWeb 暂停后它第一次检查到空闲；换成 /dl 当前构建（`3369ee1e0`）于 10-09T03:16:43Z `orbit upgrade`，03:17:06Z 重启后生效。

## workstation 安装 dsh、冒烟与旧 deepseek 复核（2026-10-09）

切换后盘点（`GET /api/runners`，03:20:12.923Z，HTTP 200）：workstation 为 0.1.225，心跳 03:20:07.438Z，ONLINE，activeSessions 0；provider:dsh 为是，capabilities 35 项（比切换前多 kimi-account-move/v1，来自新构建）；selfUpdate enabled，installDir /usr/local/bin；`engines[dsh]` 为 installed:false、`DSH_NOT_INSTALLED`，不再是 `DSH_NODE_UNSUPPORTED`。其他引擎与切换前相同；另外三台与切换前盘点相同。

- 03:20:34Z 通知协调会话：workstation 已切换并核对，可以恢复 FineWeb 派发。协调会话回复已转告账号所有者。到 03:25:35Z，FineWeb 的 paused_at 仍为 10-08T15:08:51Z，恢复派发由账号所有者在 Web 上操作。

安装 dsh：

- 安装前复读配置（只读 SQL，不取 Key 列）：`deepseek-harness`（01a10ee3-…，runtime dsh，preset deepseek-harness）enabled，updated_at 仍为 2026-10-06T01:45:32.893Z；全库 runtime 为 dsh 的配置只有这一条；旧 deepseek（runtime claude，updated_at 2026-08-04）与 anthropic-2（2026-09-14）都没有变。
- 调用 `POST https://orbitd.io/api/runners/33yiv1Y24wrKHcVCo8Fk5/install`，body `{"engine":"dsh"}`。03:20:51.979Z 发出，HTTP 201，返回 `{"status":"pending","engine":"dsh","command":null,"message":null,"mode":"install"}`。
- 每 15 秒读一次：心跳 03:20:37Z、03:21:07Z 时仍为 `DSH_NOT_INSTALLED`；心跳 03:21:37.439Z 起为 installed:true，version "0.2.0-rc.2"，dsh.versionCompatible true（credentialPresent false，modelCatalogReadable false，requestValidation / sandboxEnforcement unknown）。
- 本机：/root/.orbit/engines/dsh/0.2.0-rc.2 于 03:21Z 建立；`lib/bin.js` 的 sha256 为 `1a03dee1…f307f`，与运维文档第 1 节的固定值以及 wikova 上的一致；package 为 @deepseek-ai/dsh 0.2.0-rc.2。
- 判定 ✓：capabilities 含 provider:dsh；`engines[dsh]` 为 installed:true，version 0.2.0-rc.2。

dsh 冒烟：

- 第一次尝试没有进入模型调用：session_create 在 wikova-data 建的会话 34chpAO8q1odES3ZOy3ci（01a11eae-…）沿用了工作区默认的 effort xhigh，runner 启动时拒绝：`dsh config reasoning_effort value "xhigh" is not uniquely advertised by this session`。03:21:56Z FAILED，0 轮；ACP 会话 d925f539-… 已建立，在 set_config_option 这一步失败。原因：dsh 的模型目录只提供 off / low / high / max 四档，默认 high；按服务端代码，dsh 的 effort 只按 runner 上报的目录校验，workstation 刚装好 dsh、目录还没上报（modelCatalogReadable false），xhigh 就被原样下发了。此前所有成功的 dsh 会话都用 effort max，包括 10-08 wikova 的冒烟。
- 正式冒烟：会话 34chrCdV3Pqc9ywqmwF0A（01a11eaf-b52c-7134-bddc-a1a9c91dff76），以账号所有者身份 `POST /api/sessions` 创建；工作区 wikova-data，provider `deepseek-harness`，permissionMode default，effort max，模型未指定。run_event 共 14 条，全部由 workstation 摄入；error 事件 0 条，审批相关事件 0 条，changedFiles 为空。

| 轮次 | 时间 | 事件 | 内容 |
| --- | --- | --- | --- |
| 启动 | 03:23:15.509Z | seq 1 system/launch | provider dsh，runtime acp，cliVersion 0.2.0-rc.2 |
| 1 新建 | 03:23:16.452Z | seq 2 system/init | provider dsh，cliVersion 0.2.0-rc.2，sessionId = runtimeSessionId = a5048860-cbf4-4f46-8fca-831b48d00c57，resumed:false |
| 1 新建 | 03:23:18.8–.9Z | seq 5–6 | 唯一一次工具调用：读会话 worktree 里的 package.json，isError false |
| 1 新建 | 03:23:20.501Z | seq 10 turn_end | completed / end_turn |
| 2 同进程续聊 | 03:24:07.3–03:24:08.676Z | seq 11–14 | 没有新的 init，没有工具调用；seq 14 turn_end 为 completed / end_turn，runtimeSessionId 仍是 a5048860-… |

- 问答只读：第 1 轮答「name 是 wikova，workspaces 共 7 项」，第 2 轮不调工具，凭记忆复述。
- dsh 进程 pid 1471370，父进程是 runner 1460277，exe 为 /opt/node-v26/bin/node，cwd 是会话 worktree。
- 03:26:39Z 用 session_end 结束（CANCELLED，end_reason ended），没有删除。之后 workstation 上没有残留的 dsh 进程；/root/.orbit/dsh-sessions/ 下 01a11eaf-… 与 01a11eae-… 都保留。
- 判定 ✓：init 为 provider dsh / cliVersion 0.2.0-rc.2；两轮都是 end_turn；ACP 会话 id 不变。同一进程内的续聊不要求 `resumed:true`。

旧引擎复核（旧 deepseek，runtime claude；workstation 上 Claude 未登录）：会话 34chs0lwiGOiBhbDNYkPD（01a11eb0-31bc-725a-b63e-fbd86c4fd053），工作区 wikova-data，provider deepseek，permissionMode default，模型 deepseek-flash，effort xhigh（与该机近 7 天 71 个成功的 deepseek 会话配置相同）；run_event 全部由 workstation 摄入，error 事件 0 条。

| 轮次 | init | 工具 | turn_end |
| --- | --- | --- | --- |
| 1 新建 | 03:23:47.553Z，model deepseek-flash，sessionId fcf08830-3292-4518-82e1-3576dc957ecf | 读 package.json | 03:23:51.266Z success |
| 2 续聊 | 03:24:07.643Z，sessionId fcf08830-… 相同 | 无 | 03:24:09.449Z success |

会话的 runtime_session_id 为 fcf08830-…；03:26:40Z 用 session_end 结束，没有删除。判定 ✓：旧 deepseek 新建与续聊都成功，runtimeSessionId 不变。

## 最终盘点（2026-10-09T03:26:54.824Z）

`GET /api/runners`，HTTP 200，账号下 4 台。

| runner | 平台 | 版本 | 最近心跳 | 在线 | provider:dsh | engines[dsh] | 批次 2 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| wikova 33aHx39nnWbvJhYO2blSk | os:linux | 0.1.225 | 03:26:25.368Z | ONLINE，1 | 是（32 项） | installed:true，0.2.0-rc.2，versionCompatible true | 已上线 |
| workstation 33yiv1Y24wrKHcVCo8Fk5 | os:linux | 0.1.225 | 03:26:37.437Z | ONLINE，1 | 是（35 项） | installed:true，0.2.0-rc.2，versionCompatible true | 已上线 |
| longdeMac-mini.local 349tsNoHC7biW3WXF1ddp | os:darwin | 0.1.225 | 03:26:32.793Z | ONLINE，0 | 是（32 项） | installed:false，`DSH_PLATFORM_UNSUPPORTED` | 未上线 |
| workstation-gpu（HPC）34P34HcKKoFRn2j9KitgJ | os:linux | 0.1.225 | 03:26:39.874Z | ONLINE，7 | 是（34 项） | installed:true，0.2.0-rc.2，versionCompatible true | 批次 1 金丝雀，已上线 |

- wikova 03:27:32Z 复核：MainPID 373553，DropInPaths 为 10-node26-path.conf（sha256 `dd2525dc…`），进程 PATH 含 /opt/node-v26/bin，node v26.10.0；runner 0.1.225（`a583bcc2…`），10-08T14:21:15Z 原地自更新；系统默认的 /usr/bin/node 仍是 v22.22.2。
- 生产 DB 的 runner 表另有 4 行属于其他账号，不在本账号的盘点内：vmi3129740（与 wikova 同主机，非 root，0.1.210，ONLINE，由 orbit-runner-husong.service 运行，本批不动）；codex-steer-smoke、laotan、e2e-workdir 都是 OFFLINE，最近心跳分别为 2026-08-21、2026-08-03、2026-06-16。

## 未上线

- longdeMac-mini.local：dsh 不支持 macOS，runner 上报 `DSH_PLATFORM_UNSUPPORTED`。没有调用 install，没有派发 dsh 会话，也没有做回退（没有可回退的改动）。
- 本批没有其他未完成切换的 runner。workstation 已完成切换，任务描述中「没有无回合窗口就跳过」的默认处理没有用上。

## 回退

- 没有触发回退条件：两台 runner 都正常起来，被接管的会话都恢复了，wikova 的原生模块全部可加载。
- 唯一一次「恢复」是 workstation 第一次切换命令里脚本的自我保护（版本复读被 403，恢复原二进制）。当时没有放 drop-in，也没有重启，结果与改动前完全一致。
- 两台现有的回退路径：删除 drop-in，daemon-reload，空闲时重启。wikova 的原单元与依赖没有改过，不需要重装；workstation 留有切换前的二进制 orbit-before-switch2。runner 本身的二级回退见项目作业指导「回退准备」（HPC 上的 0.1.211 件，见 [batch-1-hpc.md](batch-1-hpc.md)）。

## 剩余限制

1. dsh 的 effort：工作区默认 effort 不在 dsh 的四档（off / low / high / max）里时（例如 wikova-data 默认的 xhigh），如果 runner 还没上报 dsh 模型目录，dsh 会话会在启动时失败。按 runner 代码，install 请求不会触发目录刷新，目录要等约每小时一次的刷新，或在 Web 上手动刷新；到 03:26:54Z，workstation 仍是 modelCatalogReadable false。规避办法：建 dsh 会话时显式选 high 或 max，或者在目录上报之前不用目录以外的 effort。协调会话的决定：列入上线记录的已知限制；修复（install 后刷新目录，或服务端在没有目录时收窄 effort）属于产品侧改进，超出本项目的验收范围，本项目不建任务，已作为待办候选报给账号所有者。
2. /dl 同一版本号多次重建：0.1.225 版本号相同、构建不同。在用的构建为 wikova `29f49af63`、workstation `3369ee1e0`（/dl 当前件），workstation 切换前用的是 `721e48275`，HPC 未逐一核对。自更新只比较版本号，不会把它们拉齐。协调会话的决定：本批不另做动作，下一次换版本号的发版后各 runner 会自更新到同一构建，自然收敛。
3. workstation 的 codex 本来就不可用（缺可选依赖 @openai/codex-linux-x64），与本批无关；nvm Node 22 全局包里的 27 个 .node 文件在 Node 26 下没有测。
4. wikova 切换时守门脚本没有看集成作业，重启打断了集成作业 0d3afadd 的合并前检查（见上）。已于 10-08T13:36:48Z 用 project_send 报告协调会话（请求 34cNZloTXxZIoOTlZwGSz），协调会话答复 workstation 继续等 FineWeb 暂停、暂不提交证据；workstation 的空闲判据已补上集成作业。
5. 旧执行会话 4VRFSLrBeq2V3L7hBh0NY9 的兜底 watch（10-09T04:29:03Z 到期）到收尾时仍是 ACTIVE。按服务端代码，watch 的唤醒不会复活 FAILED 的会话，投递会记为 OBSERVER_SESSION_ENDED 死信，不会引起重复执行；没有观察到它实际到期。
6. 测试会话：dsh 冒烟和旧引擎复核的会话都已 session_end，没有删除；最初那个 xhigh 会话是 FAILED（已结束）。shell 会话 34bZJX6q3fN8SypZ9U3sO 在记录贴完后 session_end。
7. 需要用户身份的接口：在 apiserver 容器内为账号所有者签 1 小时令牌，存在 /dev/shm（0600），没有打印。只读 SQL 每条前先 `SET default_transaction_read_only = on`，不读 Key 或密文列。

## 来源

- 核对记录：任务评论 34bZxZ91vgYrRhq0T3AHN（1/n：盘点、前提核对、回退点、准备）、34cNf7D2aAnIixVqzT2KO（2/n：wikova 切换）、34cNg4PMS0fOW2LxgzBZV（3/n：wikova 切换后核对、原生模块复测、安装、冒烟、claude 复核）、34ci68TpcntdwuSXxhL3U（4/n：workstation 切换）、34ci7YnI3A0pTfEJwUReI（5/n：workstation 安装、冒烟、旧 deepseek 复核、最终盘点）、34ciATVGSeq9k6YNykzBb（6/n：两条已知限制的处置）。
- 协调会话评论：34baBgx9kiCI7Bpe9kufy（10-07 04:04Z，暂停 FineWeb 的决定）、34cNFOWfjcF5uL15VLPaY（10-08 13:24Z，换 provider 与重启授权）。
- 判断会话评论：34cQJXQrC2YgEnyTY1ggO、34cQcXPmNuSTVwbo4q3Ur、34cSSFOXGIXDcpbLPSW36（10-08，429 中止后的处置）。
- 完成证据 2lP1zWUB41fWNg8TumoKL6（2026-10-09T03:39:32Z，50 条引用）。
- 原始响应：wikova 的 /var/tmp/orbit-b2/runners-postswitch-20261008.json、runners-preswitch-ws-20261009.json、runners-final-20261009.json（摘要已按 API Key 与 JWT 的字符形态脱敏）。
