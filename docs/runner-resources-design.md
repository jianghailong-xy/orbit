# Runner 上报 CPU / 内存 / 硬盘（设计稿）

> 状态：设计稿，等所有者拍板 §6 的四件事。
> 起因：2026-10-10 你的话：「runner 需要支持上报 CPU 内存 硬盘的监控，先出设计图」。
> 效果图：`docs/mocks/runner-resources/`（`1-today.png` … `7-landing.png`，单独的手机图 `phone-*.png`）。Web 那几张是这个分支的真实构建，把新的部分插进页面截的；手机是画的。代码基线：main `9498167b9`，下文行号都指这一版。

## 0. 一页结论

- **现状**：runner 只报每个工作区目录所在盘的剩余空间。客户端从里面挑最紧的一块，画成机器页 Capacity 里的 Disk 条，外加一条「Disk N% full」提醒。CPU、内存、swap、被内存不足杀掉的进程、Worktrees 那块盘，一个数都没有，也没有历史。
- **建议**：runner 每 5 s 读一次本机，攒成每分钟一条，跟着现有的 30 s 心跳送上去。服务端存「此刻」和「每分钟（7 天）」两份。三端在三处显示：
  - 机器列表：每台机器三根条。
  - 机器页：一节 Resources（现在的数 + 曲线）和 Using It Now（谁在用）。
  - Disks：每块盘一行。
- **提醒**：内存被耗尽（OOM 杀了进程）进 Needs Attention，红色，按钮直接调 Max Concurrent。磁盘提醒改成看 Orbit 会写的每一块盘。CPU 只变色、不提醒。
- **成本**：
  - 不新开连接，不给 runner 加依赖（纯标准库、`CGO_ENABLED=0`）。
  - 服务端每次心跳不多一条语句。
  - 新增一张分钟表，每台机器 7 天约 1 万行。
- **要你拍板四件事**（§6）：
  1. 历史存不存。推荐按分钟存 7 天。
  2. 「谁在用」这次做不做。推荐做，只看此刻。
  3. 内存要不要像 Keep Free 一样拦任务。推荐先不拦，只提醒。
  4. Keep Free 要不要也看 Worktrees 那块盘。推荐看，这是这次顺带发现的漏洞。

## 1. 现状

### 1.1 HPC 今天（2026-10-10 12:03 CST，本机实测）

| 项 | 读数 |
|---|---|
| CPU | 24 核，load 27.86 / 26.34 / 27.38 |
| 内存 | 14 GiB，可用 2 GiB；swap 43 GiB，用了 22 GiB |
| 内存压力（PSI） | `memory full avg10=15.34`：最近 10 秒里，有 15% 的时间所有进程都在等内存 |
| OOM | `/proc/vmstat oom_kill 33`，开机 7 天 12 小时 |
| runner 被连带停掉 | `orbit-runner-root.service` 是 `OOMPolicy=stop`。10-09 16:30 内核杀了它 cgroup 里的一个 chrome，systemd 把整个 runner 停了，16:33:37 才重新起来（`ActiveEnterTimestamp`） |
| 盘 | `/` 915 G 用了 897 G（99%，剩 9.2 G）；`/mnt/data` 15 T 用了 3%；`/data`（NFS）87%，Orbit 不写 |
| 谁占着 | runner 的 34 个子进程树一共占 9.7 GB RSS。最大的一个是某个会话的后台任务，1.9 GB |

这些在 Orbit 里一个都看不到。`/` 在 10-07 到 10-10 之间满了四次，每次都是有人 ssh 上去才发现的。

### 1.2 现在报了什么、在哪显示

- **runner**：只在 `scanAgentDirs` 里对每个工作区目录 `statfs` 一次（`src/runner-go/agent_dir_probe.go:138`），可用量取 `Bavail`（`diskusage_unix.go`）。心跳每 30 s 一次（`runloop.go:23`），`HeartbeatRequest`（`types.go:49`）里没有 CPU 和内存。
- **服务端**：心跳处理在 `runner-api.controller.ts:1074`。
  - 它每次都 UPDATE runner 那一行（`lastHeartbeatAt` 每次都变）。
  - 每个工作区的读数写进 `workspace.workDirFreeBytes / workDirTotalBytes`（`:1415` 起）。
  - 没有任何历史表。
  - `GET /api/runners`（`runners.service.ts:111` 的 `runnerViews`）不带盘的数；盘的数走 `GET /api/workspaces`。
- **拦截**：`diskBelowFloor`（`tasks.service.ts:1730`）只在 60 s 一次的自动派活扫描里用（`:11201`、`:11275`）。低于 Keep Free（`runner.minFreeDiskMb`）的工作区不再被自动派任务。
- **三端**：
  - Web：`runnerDisk`（`runnerAttention.ts:296`）挑最紧的一块；`diskItem`（`:521`）出「Disk N% full」；机器页 Capacity 画条（`RunnerDetailPage.tsx:1580`）。
  - iPhone / Mac：同一套 SwiftUI。`RunnerRow` 在 `SkillsRunnersView.swift` 里，Capacity 是 `RunnerDetailContent` 的一节。
  - Android：`RunnerScreens.kt` 的 `RunnerCapacity`。
  - 三端都对着 `runnerAttention.cases.json` 测同一套规则，都是每 15 s 轮询 runners。

### 1.3 顺带发现

1. **Keep Free 看的不是会话写的那块盘。**
   - 拦截比的是「工作区目录所在盘」。可开了 worktree 的会话，写在 runner 自己的 `machineHome()/worktrees`（`worktree.go:430`），在 HPC 上就是 `/root/.orbit/worktrees`。
   - 所以工作区在大盘、runner 的 home 在小盘的机器上（比如工作区放 `/mnt/data`），小盘满了照样派任务过去。
   - runner 自己清 worktree 时量的倒是对的盘（`measureWorktreePressure`，`worktree.go:2617`）。见 §6 ④。
2. **注释和代码不一致。** 「foreman 和普通任务一样过额度和磁盘拦截」（`tasks.service.ts:11583`）这句注释说的不是代码的实际行为：`diskBelowFloor` 只有自动派活扫描这一个调用点。不在这次范围里，记一笔。

## 2. 采什么、怎么采

runner 每 5 s 读一次，每分钟汇总成一条（平均 + 最高）。「谁在用」每 30 s 算一次，随心跳送。

| 指标 | 定义 | Linux | macOS | Windows |
|---|---|---|---|---|
| CPU % | 整机所有核的忙碌比例 | `/proc/stat` 两次读数之差 | 每分钟一次 `top -l 2 -n 0`（不用 cgo） | 不报 |
| Load | 1 / 5 / 15 分钟 | `/proc/loadavg` | `sysctl vm.loadavg` | — |
| 内存 | 总量 − 可用（页缓存不算用掉） | `MemTotal − MemAvailable` | `hw.memsize` + `vm_stat` | — |
| Swap | 已用 / 总量 | `SwapTotal − SwapFree` | `vm.swapusage` | — |
| OOM | 内核因内存不足杀掉的进程数 | `/proc/vmstat` `oom_kill` 的增量 | 没有对应物（先压缩、换页） | — |
| 盘 | Orbit 会写的每块盘 | `statfs`，按设备去重；另报 inode 用量 | `statfs` | 不报（和今天一样） |
| 谁在用 | 每个会话：引擎的进程组 + 它的后台任务；其余合成 Other processes（写最大的三个进程名） | `/proc/<pid>/stat` 的 utime+stime、RSS | `ps -o pid,pgid,%cpu,rss` | — |

补充说明：

- **「Orbit 会写的每块盘」**：Worktrees、Repos（`reposRoot`）、Home（`machineHome()`）、Temp（`os.TempDir()`），以及每个工作区目录。每块盘带上它装着哪些（`holds`），三端写成「Worktrees · Repos · Home · Temp · orbit-develop」。
- **容器里的托管 runner**：总量取 cgroup 的 `memory.max` / `cpu.max`，不拿节点的数。
- **离线**：CPU、内存是「此刻」的数，离线就显示 —。盘留最后一次读数并变灰。

## 3. 上报：心跳多一个字段

`HeartbeatRequest.resources`，可选；不带就不动服务端的旧值（和 `engines` 的做法一样）。

```json
"resources": {
  "at": "2026-10-10T04:03:20Z",
  "cpu": { "cores": 24, "busyPct": 97.2, "load": [27.9, 26.3, 27.4] },
  "memory": { "totalBytes": 15032385536, "usedBytes": 12992153600,
              "swapTotalBytes": 46170898432, "swapUsedBytes": 23622320128 },
  "oomKills": 33,
  "disks": [{ "mount": "/", "totalBytes": 982473277440, "freeBytes": 9878424166,
              "inodesUsedPct": 18, "holds": ["worktrees", "repos", "home", "temp", "workspace:<id>"] }],
  "minutes": [{ "at": "2026-10-10T04:02:00Z", "cpuAvg": 96.1, "cpuMax": 100,
                "memAvg": 85.9, "memMax": 87.0, "swapUsedBytes": 23500000000,
                "oomKills": 0, "diskUsed": { "/": 972594853274 } }],
  "sessions": [{ "sessionId": "<id>", "cpuCores": 6.2, "rssBytes": 2040109465 }],
  "other": { "cpuCores": 8.9, "rssBytes": 2791728742, "top": ["qemu-system-x86_64", "dockerd", "java"] }
}
```

- 字段格式：
  - `oomKills` 是开机以来的累计数，增量由服务端算，所以 runner 重启不会丢也不会重算。
  - `minutes` 是还没被确认的分钟汇总。正常一次 0–1 条；断线时最多攒 60 条，回来一次补齐。
- 大小约 1–2 KB。
- 这些数只是参考，runner 采不到就不报，不会拖慢心跳。读 `/proc` 放在和会话遥测一样的「后台缓存、心跳只读上一次结果」的结构里（`heartbeat_telemetry.go`）。

## 4. 存储与接口

- **`runner.resources`（JSON）**：
  - 存此刻的数，以及服务端算出来的「24 小时内 OOM 次数 / 最近一次时间 / 离线区间」。
  - 和 `lastHeartbeatAt` 走同一条 UPDATE，不多语句。
- **`runner_resource_minute`**：
  - 主键 `(runnerId, minute)`。列：cpuAvg/Max、memAvg/Max、swapUsed、load1、oomKills、`diskUsed`（JSON，按挂载点）。
  - 写法照 `PoolUsage` 账本：内存里攒，`POOL_USAGE_FLUSH_MS`（2 s）一批 `INSERT … ON CONFLICT DO NOTHING`（`pool-usage-ledger.ts:29`、`:116`）。
  - 保留 7 天，照 `purgeTrash`（`reaper.service.ts:137`）的样子每小时删一次。
  - 每台每天 1,440 行，7 天约 1 万行。
- **接口**：
  - `GET /api/runners` 每台多带 `resources`。
  - 新增 `GET /api/runners/:id/resources?range=1h|24h|7d`，分别按 1 / 5 / 30 分钟一个点返回，带 OOM 时刻和离线区间。
  - 只有机器的主人能读；PAT 用读 runner 的那个 scope。
- **普查**（新表 / 新路由 / 新迁移都要过）：
  - db-write inventory
  - `PUBLIC_ID_FIELDS`（`runnerId` 要归类）
  - 迁移台账（append-only 列表，现在最大 0421；落地前扫各分支再取号）
  - 租户隔离
  - PAT scope
  - `/api/runner/*` 的 id 形态（`machine-protocol-split.spec.ts`）

## 5. 三端显示与提醒

画面见效果图。三端的规则和英文文案各只有一份：判断在 `runnerAttention.ts`，Swift 的 `RunnerAttention` 和 Kotlin 的 `RunnerPage` 镜像，三边都对着 `runnerAttention.cases.json` 测；文案进 `runnerCopy.ts`。

| 提醒 | 条件 | 标题（英文，产品文案） | 按钮 |
|---|---|---|---|
| Out of memory（红） | 24 小时内有 OOM 杀进程 | `Out of memory 4 times in 24 hours`；列表短句 `Out of memory 4× in 24 h` | `Lower Max Concurrent`（跳到 Max Concurrent） |
| Memory high（琥珀） | 5 分钟平均 ≥ 90%，且没有 OOM | `Memory 94% used` | — |
| Disk（琥珀，已有） | 低于 Keep Free；没设时剩不到 10% | `Disk 99% full`（不变） | `Set a Reserve…`（不变） |
| CPU | 不提醒；5 分钟平均 ≥ 90% 时条变琥珀 | — | — |

变化：

- **磁盘**：规则不变，但看的从「各工作区目录的盘」换成 Disks 里的每一块盘。
- **机器页**：
  - Capacity 去掉 Disk 一行，只留 Max Concurrent 和 Keep Free 两个设置。
  - Resources 和 Using It Now 放主栏最上面。机器不忙时，Using It Now 默认收起。
- **曲线**：
  - Web 手写 SVG；iPhone / Mac 用 Swift Charts（iOS 17 / macOS 14 自带）；Android 用 Compose Canvas。三端都不引图表库。
- **刷新节奏不变**：
  - 列表和机器页仍是每 15 s 拉一次 runners。
  - 曲线只在打开 Resources 时取，开着时 60 s 刷新一次。

## 6. 待定 · 要你拍板

1. **历史存不存、存多久**。
   - **A（推荐）**：按分钟存 7 天，三端有 1h / 24h / 7d 曲线。
   - **B**：只存此刻，不加表，没有曲线。
2. **「谁在用」这次做不做**。
   - **A（推荐）**：这次做，只看此刻（Using It Now）。
   - **B**：先只做整机。
3. **提醒和拦截做到哪**。
   - **A（推荐）**：只提醒，不加新拦截，CPU 只变色。HPC 一整天 load 27.9 / 24 核、内存 86% 加 22 GB swap，按阈值拦，它大半天都派不了活。先看一周真实数据再定。
   - **B**：加内存拦截（5 分钟平均 ≥ X%，或刚发生 OOM 的 30 分钟内，不自动派新任务），CPU 持续 30 分钟 ≥ 95% 也提醒。
4. **Keep Free 也看 Worktrees 那块盘**。
   - **A（推荐）**：开了 worktree 的工作区，取两块盘里更紧的那块。服务端 `diskBelowFloor` 和 runner 的 `belowFloor` 一起改。
   - **B**：不动，只在 Disks 里看得到。

## 7. 落地（按代价排）

1. **runner**：采样 + 心跳带 `resources`。Go 测试用假的 `/proc` 目录喂数。
2. **server**：
   - `runner.resources` 列 + 分钟表 + 两个读接口 + 每小时清理。
   - 新表新接口要过 §4 列的普查。
3. **三端共享规则和文案**：
   - 三端的规则加 OOM、内存、多块盘：`runnerAttention`（Web）、`RunnerAttention`（Swift）、`RunnerPage`（Kotlin）。
   - `cases.json` 补用例；文案进 `runnerCopy.ts`。
4. **Web**：机器卡片三根条；机器页加 Resources、Using It Now、Disks。
5. **iPhone / Mac**：同上，在 CI 的 macOS 26 模拟器上截改前 / 改后。
6. **Android**：同上，在共享模拟器上截图。
7. **Keep Free 看两块盘**（④ 选 A 才做）。
8. **另起**：
   - OOM 推送通知。
   - 自动派活时优先挑空闲的机器。
   - GPU（HPC 有卡）。
   - runner 被 OOM 连带停掉时，重启后说明原因。

建议 1–3 先做，算一个任务（数据和规则）；4 / 5 / 6 三端并行；7 看 ④。整件事 6–7 个任务，适合开一个 Orbit 项目。

## 8. 不做的事

- **不做通用监控**：不导出 Prometheus，不做每个进程的浏览器，不报网络 IO。现成的监控不知道会话、Keep Free 和 Max Concurrent，还得另外部署一套。这里只做跟派活有关的那几个数。
- **不存每个会话的用量历史**：量大，等真有需要再说。
