# 设计文档：列表保鲜——控制面事件做提示，条件增量读做真相

状态：草案 v1 · 2026-11-07 · 起因：生产 PostgreSQL 300% CPU（会话 34tDirOsRXbvjK2UMgDjb）及其复查
影响面：`src/apiserver`（sessions / realtime / events）、`src/web`、`src/macos`（OrbitKit + OrbitApp，iOS 共用）、`src/android`
关联：[realtime-control-plane-stream.md](./realtime-control-plane-stream.md)（"快照 + 跟随"的原始设计）、[postgres-lock-order.md](./postgres-lock-order.md) §4（`open_list_epoch`）

---

## 1. 为什么要重新看这件事

[realtime-control-plane-stream.md](./realtime-control-plane-stream.md) 定下的模型是"连接时拉一次快照，之后跟随事件"，并计划撤掉轮询。三端实际走成了另一个样子：

- **macOS/iOS**：`AppModel` 每 4 秒无条件读一次 Open 列表，流在不在线都读，macOS 隐藏、最小化、关窗后照样读（`AppModel.swift:960-1006`；只有 `logout` 停它，`:857`）。读的是 `since=` 增量，而服务端增量路径先完整构建列表、不比版本（`sessions.service.ts` `listOpenSince`）。**每台设备每分钟约 15 次全量构建，全天不停。**
- **Web**：流在线时，每个事件（500 ms 合并）都会重拉屏幕上所有会话列表、`/sessions/counts` 和逐项目读；流断开时，Open 列表和每个项目的读（一个标签页 42–76 个）都变成 4 秒一次，不退避。
- **Android**：每个事件、每次连接都并行重读 5 个完整列表（Open 列表不带 `since=`、不带 ETag），外加 `/projects`、`/users/me` 等，不合并。

原因是同一个：**控制面事件只是"提示 + 精简摘要"，不是可靠的变更流**，所以各端各自用轮询兜底，兜底又各不相同、都没有预算。

## 2. 事实（2026-11-07 代码调研，file:line 以 main `3f9fb9bc6` 为准）

### 2.1 服务端事件（`GET /api/events`）
- 信封 `{type, sessionId, agentId, ts, data}`，**没有序号，没有回放**（`src/shared/src/realtime.ts:95-108`；`events.controller.ts:19-20`）。跨副本走 `pg_notify('orbit_event')`，发布在写之后、不等待，**至多一次**；进程在两者之间崩溃就丢（`realtime.service.ts:599-607, 880-887`）。
- `session.created/updated` 的载荷是投递时重读的 `ControlSessionSummary`（`realtime.service.ts:1224-1229, 1344-1498`）：**每个连接各读一次**，约 10+ 条查询 × 该账户在线的连接数。
- 摘要比列表行少约 30 个字段：预览行（`lastToolUse` 等）、`tags`、`pinnedAt`、`shared`、后台计数、`assignedRunner`、`queued*`、`createdAt`、`numTurns`/`costUsd`/`error`……
- **大量行可见的变化不发任何事件**：ingest 中途写的预览、工具行、引擎阶段、后台任务；接管清空后台集合；出队；置顶；改配置（含 `lastTurnAt`，会改排序）；`mergeStatus`；分享链接；runner 上下线与心跳；删文件夹/标签的级联；所有 open item 写入；以及所有时钟阈值（runner 离线、后台任务变安静、评审窗口、升级期限）。
- `mergeMap` 并发投递，同一会话的两个事件可能乱序到达；摘要在投递时读，旧读可能盖掉新读。

### 2.2 服务端读
- 只有平铺 Open 列表有版本判断（`sessions.controller.ts:434-447` + `open-list-version.ts`）：命中时不构建。
- `since=` 在版本判断之前返回，**每次都完整构建**；游标快照只在单进程内，换副本或重启就回 `full:true`（`open-list-delta.ts:19-21`）。
- `/sessions/counts`、`/projects`、`/projects/sidebar`、`/tasks/page`、`/watches`、带 `projectId` 的会话读：**每次都完整构建**，只有 Express 的整包哈希 ETag（只省字节）。
- 0484/0487 的计数器：29 张源表的每次写入都会给账户的 `(owner, source)` 计数加一。**这是一个完整的"Open 列表的源数据变了"信号**，只差没有送到客户端。

### 2.3 客户端现状与同类问题清单

| # | 端 | 问题 | 位置 | 量级（每台在线设备） |
|---|---|---|---|---|
| A1 | Apple | 4 s 无条件 Open 列表读，流在线也读；macOS 隐藏/关窗也读 | `AppModel.swift:960-1006`；`OpenListReader.swift:52-82` | 13–15 次全量构建/分 |
| A2 | Apple | 同一个 tick 里不看流、不看可见性的读：watches ×4/32 s、`/runners`/16 s、`/projects`+`/projects/sidebar`/16 s（+每个可见项目页约 7 个读）、managed runner | `AppModel.swift:1011-1027`；`ProjectsModel.swift:60-65` | 约 20–35 请求/分 |
| A3 | Apple | 未识别的事件（`watch.changed`、`project.criteria_decisions.changed`）和 macOS 上的 `folder.changed` 落到全量 Open 读 | `ControlEvent.swift:10-39`；`AppModel.swift:1206-1213` | 每事件 1 次全量读 |
| A4 | Apple | 重连：一连上就算"健康"，代理接受再断时 0.3–1 s 重连一次；每次连接 12–20 个 GET；401 后流永久停止 | `ReconnectPolicy.swift:54-73`；`AppModel.swift:1064-1107` | 最坏数百至数千请求/分 |
| A5 | Apple | 断网时 REST 轮询不退避 | `AppModel.swift:1534-1539` | 约 30 失败请求/分 |
| A6 | Apple | 视图轮询不看流：Completed/Trash 整账户 4 s；项目页 4 个 4 s 循环；Landings 4/15 s；重复的 `/runners` | `AgentsView.swift:596-606`；`SessionProjectPage.swift:472-506` | 15–30+ 请求/分 |
| A7 | Apple | 每个就地应用的事件都让下一次 ETag 读失去 304（ETag 模式下每次约 1.5 MB） | `AppModel.swift:1642`；`OpenListReader.swift:77` | — |
| W1 | Web | 每个 `session.*`/`approval.*` 事件（500 ms 窗口）重拉屏上会话列表、`/sessions/counts`、该会话详情、所在项目的读、请求卡片，watches 读两遍（立即 4 个 + 3 s 后 4 个）；未映射的事件类型默认也走会话组；隐藏的标签页同样照做 | `useControlPlane.tsx:244-299, 362-390` | 每事件 13–17 个请求 |
| W2 | Web | 断流后 Open 列表与逐项目读一律 4 s，不退避（一个标签页 42–76 个项目） | `WorkspaceView.tsx:2515`；`useSessionProjectData.ts:50` | 15 + 15·N 次/分 |
| W3 | Web | 不看流的固定轮询：`/sessions/counts` 5 s/15 s、`/projects/sidebar` 15 s、`/tasks/page` 5 s/15 s、`/watches` ×4 60 s | `TasksSidePanel.tsx:303-319`；`queries.ts:645-650, 1055-1068`；`TaskListView.tsx:576-582` | 约 20 请求/分 |
| W4 | Web | 流在线、没有事件时仍在跑的固定轮询：逐项目读每 60 s 同步一波、会话详情 5 s（+链接预览）、协调者卡片 20 s、项目页、任务页 5/15 s（`task.*` 事件已会刷新它） | `queries.ts:334`；`WorkspaceView.tsx:2593`；见 2.3 注 | 70–150 请求/分 |
| W5 | Web | 17 处操作直接 invalidate `['sessions']`，服务端随后的事件再读一遍：每次点击 2–3 次列表读；打开页面读 Open 列表 2–4 次（BootGate 预热、staleTime 0 的挂载重读、第二个 key、流打开时对齐） | `BootGate.tsx:163`；`WorkspaceView.tsx:2508`；`useControlPlane.tsx:333` | — |
| W6 | Web | 重连：每次流打开约 70–110 个请求；浏览器 `online` 事件再触发一轮；断网期间 `retry:1` 让每个失败的轮询翻倍 | `useControlPlane.tsx:325-339, 405`；`main.tsx:40` | — |
| W7 | Web（正确性） | 改 workspace 不产生 `workspace.*` 事件（服务端只有 `agent.changed`），而 `agent.changed` 只刷新会话组，workspace 列表不刷新 | `useControlPlane.tsx:264, 285`；`workspaces.service.ts:299` | — |
| D1 | Android | 每个事件、每次连接重读 5 个完整列表（Open 列表无 `since=`/ETag），读完立刻处理下一次，无合并 | `RealtimeRest.kt:43-50`；`RealtimeStore.kt:209-283` | 每事件约 8 个读 |
| D2 | Android | 每个事件还读 `/projects?status=OPEN`、`/users/me`、阅读器卡片 6–8 个、有通知时再读一次 Open 列表 | `DrawerProjects.kt:51-60`；`AccountAppearance.kt:83-103`；`PushController.kt:81-87` | 项目会话阅读器上每事件 25–30 个读 |
| D3 | Android | 页面轮询不看流：项目页 4 s 循环、Projects 15 s、watches 30 s、Landings 15 s；多数不随 Activity 停止 | `SessionProjectPage.kt:326-330` 等 | 30+ 请求/分 |
| S1 | 服务端 | `since=` 不比版本，每次完整构建 | `sessions.controller.ts:402-408` | 每个 Apple tick 一次全量构建 |
| S2 | 服务端 | 事件摘要按连接重读 | `realtime.service.ts:1165-1229` | 10+ 查询 × 连接数 / 事件 |
| S3 | 服务端 | 除平铺 Open 列表外的列表端点全都每次完整构建 | 见 2.2 | — |
| S4 | 服务端 | 版本里哈希了 `runner_presence` 的 ctid:xmin（列表正文带 `lastHeartbeatAt`），每台 runner 每 30 s 心跳一次就让版本变 | `open-list-version.ts:81` | 304 命中率上限被压低 |

（另：调研推断出两处正确性疑点，待复核后另立：`approval.requested` 以 seq 0 发布，载荷超 7000 字节时其他副本按 seq 0 取不到；以及上面的乱序覆盖。）

## 3. 结论：能不能复用 events 做增量更新

**不能把现有事件直接当增量来源**：没有序号和回放（丢了不知道），载荷缺约 30 个字段，大量变化根本不发事件。要让它成为可靠的行级变更流，得给每条写路径补发布、补全行载荷、补序号与回放——改动面是"所有写路径"，而漏一条就是静默的陈旧数据。

**可以复用事件做"提示"**，正确性交给一条便宜的条件增量读：

1. **提示要完整，但不靠写路径各自发布。** 0484/0487 的计数器已经覆盖了 Open 列表的所有源表写入。服务端每个进程对"本进程有在线控制流的账户"每秒读一次计数和（一张很小的表、一条语句，与客户端数量无关），变了就向该账户的流发 `sessions.list_changed`（带版本）。时钟阈值（runner 离线、后台任务变安静、各种期限）由同一个进程每 15 s 算一次完整版本补上。这样"静默写"、其它副本的写、时钟翻转都会产生提示，不需要逐条写路径补发布。
2. **读是条件的、增量的。** 客户端收到提示后发 `GET /sessions?view=open&since=<cursor>`；服务端先算版本，与该游标构建时的版本相同就回空 delta，不构建；不同才构建，并只回变化的行。
3. **同一版本只构建一次。** 一次变化会同时提示该账户的所有设备；进程内按 `(owner, scope, version)` 缓存几秒构建结果，并发的读共享一次构建。
4. **行补丁只做延迟优化。** 事件里已有的字段（状态、审批、标题……）照旧就地应用，让界面更快；但永远不靠它保证正确。
5. **安全兜底很慢。** 流在线时，每个客户端每 60 s 做一次条件读（未变时只花一次版本探测，约 2k buffers），用来兜住投递丢失。

这条路线保留现有契约（快照 + 跟随、`since=`、ETag），每一步都能单独上线、单独度量。

## 4. 三端统一规则（列表预算）

适用于 Open 列表，也适用于第 2.3 节里的其它列表（counts、projects、sidebar、watches、tasks、项目页、Landings、Completed/Trash）：

- **R1 流在线**：不做定时全量读。只在收到相关提示时读，合并窗口 ≥ 1 s、同一列表同时最多一个读在途；另有 60 s 的条件兜底读。
- **R2 流断开**：所有列表一起退避，4 → 8 → 16 → 30 s 封顶，带抖动；收到第一条消息后才重置。
- **R3 不可见/后台**：不做定时读（macOS 隐藏、最小化、遮挡、关窗；Web 标签页隐藏，TanStack 已默认；Android Activity 停止）。回到前台做一次条件读。
- **R4 重连**：连接建立不算健康，收到第一条消息才算；重连后只对齐当前屏上的列表，用条件读，不是 12–20 个 GET。
- **R5 事件路由**：未知或未映射的事件类型不触发任何读；一个事件只读它影响的列表；workspaces、folders、tags、runners 只在各自的事件上读。
- **R6 视图轮询**：页面级轮询（项目页、Landings、Completed/Trash、任务页）同样遵守 R1–R3。没有事件的状态（落地与合入卡片的进度、runner 上下线）保留有界轮询，只在可见且在途时生效：落地或合入作业 RUNNING 时卡片 4 s 一读，runner 页面打开期间按它自己的节奏读；不可见时一律不读，没有在途工作时照 R1–R3。

## 5. 分阶段计划

- **P0（已完成，待上线）**：0487，计数器不再让写入互相等待（`fb4147c65`）。
- **P1（相互独立，可并行）**
  - 服务端：`since=` 先比版本（S1）。
  - Web：W1–W3（断流退避覆盖全部列表；流在线时撤掉不看流的固定轮询，改为事件驱动 + 慢兜底；未映射事件不再落到会话组）。
  - Apple：A2–A6（macOS 隐藏时暂停；重连退避与重连扇出；未知事件不读；断网退避；视图轮询看流）。
  - Android：D1–D3（事件读合并、只读受影响的列表、页面轮询看流并随生命周期停止）。
- **P2**（依赖 P1 的服务端项）：服务端 `sessions.list_changed` 提示 + 按版本共享构建 + 事件摘要每事件只算一次（S2）；随后 Apple 撤掉 4 s 地板（A1），Web 与 Android 改用 `since=` 增量读 + 提示驱动。
- **P3**：其它列表端点的条件读（S3）；收窄版本（S4：把心跳时间戳移出列表行，不可见列不计数）；若度量显示运行中会话的预览更新仍是读的大头，再让事件携带预览字段。

每一步都用同一组生产数据度量：`pg_stat_statements` 区间增量（列表构建与版本探测的调用数和总耗时），以及网关日志中 `/api/sessions` 按客户端类型、按 200/304/空 delta 的请求数。
