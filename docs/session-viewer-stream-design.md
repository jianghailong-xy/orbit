# 访客与只读观众的会话推送（SSE）设计

状态：设计已定（2026-11-16）：所有者对 §9 的 D1–D6 全部选 A（建议）。效果图 `docs/mocks/viewer-stream/board.html`（每部分一张 PNG）。
接在 `docs/session-guests-design.md`（访客）和 `docs/share-links-design.md`（公开链接）之后：两扇门今天都靠 `events?after=` 轮询跟随会话，这里给它们各加一条 SSE 流，轮询留作退路。

## 1. 为什么改

- 今天两类“不是所有者”的读者都靠轮询：**访客**（被邀请、已登录，`/sessions/<id>` 落到访客门 `/api/guest-sessions/:id/*`）和**只读观众**（拿公开链接 `/s/<token>`，匿名，`/api/shared/:token/*`）。节奏是公开页的 `followDelay`：会话在跑时 4 s 一次，在等回复时 30 s 一次，结束后不再问。
- 代价：
  1. Agent 的回复一段一段地跳出来（每 4 s 一块），看不到逐字输出；所有者看到的是逐字的。
  2. 会话在等回复时，所有者一回话，观众最多要等 30 s 才看到。
  3. 访客自己发的消息：11-16 已修成“点发送就画出来，0.5 s 一问直到回声到”（web a3a5b594f，原生 98922820c），但回声之后 Agent 的回复仍按 4 s 节奏到。
  4. 轮询的空问很多：production 11-16 03:39–03:44，访客页 4 s 一次 `events?after=`，绝大多数 304/空。
- 所有者自己的页面早就是推送：`GET /api/sessions/:id/events`（SSE，`sessions.controller.ts` `@Sse(':id/events')`），先补历史再接实时（`replayThenLive`），实时一半来自 `RealtimeService.streamForRun`，含逐字增量（`text_delta`/`thinking_delta`）。

## 2. 结论（建议）

- **用 SSE，不用 WebSocket。** 数据只单向（观众只收；访客发消息仍是一条 POST）；四个客户端都已有 SSE 客户端（web `useSessionStream.ts`、OrbitKit `EventStream.swift`、Android `EventTransport.kt`）；网关 `/api/` 已 `proxy_buffering off` + `proxy_read_timeout 3600s`；WebSocket 在本仓库只用于 runner ↔ link-gateway。
- **不把所有者的流开放给观众。** 所有者的流是原样全量（审批卡、排队、翻译、任务进度都在里面），按 `ownerId` 把门。观众流是新的两条路由，复用同一个实时来源，但每一帧过同一套“观众投影”（§4）。
- **轮询保留为退路**：流打不开（老服务器 404、429 超限、网络不支持）就回到今天的轮询，行为与现在一致。

## 3. 两条新路由

| 读者 | 路由 | 鉴权 | 投影 |
|---|---|---|---|
| 访客 | `GET /api/guest-sessions/:id/stream?sinceSeq=&maxPayload=` | 登录；EventSource 不能带头，沿用 `@AllowQueryToken()`（与所有者流同一套 `access_token` 查询参数，网关日志已脱敏） | 公开页“Tool calls and output 打开”的投影（与访客门今天的读口一致） |
| 只读观众 | `GET /api/shared/:token/stream?sinceSeq=&maxPayload=`；项目/任务链接里的会话：`GET /api/shared/:token/sessions/:sessionId/stream` | 匿名；token 即能力（`ShareLinksService.resolve`）；`PublicSurfaceGuard` 照旧（`no-store`、`noindex`、限流） | 按链接的 `include.toolOutput`：关时工具调用只留名字、结果只留成败（`withoutToolOutput`） |

两条路由的形状与所有者流相同：`sinceSeq` 有值时只补 `seq > sinceSeq` 的历史（缺口超过 `SSE_GAP_CAP` 发 `resync`，客户端重取尾页），没有时补最新 `SSE_REPLAY_CAP` 条；然后接实时；每 ~20 s 一个 `ping`；apiserver 平滑停机时流干净结束，客户端带 `sinceSeq` 重连到另一台。

## 4. 观众投影：一帧一帧怎么过滤

原则：**持久事件与今天的分页读口完全同一个判定，实时事件用白名单。** 判定写成一个函数，SQL 读口（`replayableEventSql`）和流共用它的两种拼法，并由同一组否定断言 spec 同时跑“读口”和“流”两扇门。

| 事件 | 所有者流 | 访客流 | 只读观众流 |
|---|---|---|---|
| 持久事件（`replayableEventSql` 放行的：user / assistant / thinking / tool_use / tool_result / system init… ） | 原样 | 原样（= 访客门今天的读口） | 同读口：`include.toolOutput` 关时过 `withoutToolOutput` |
| `text_delta`、`thinking_delta`（逐字增量） | 有 | **有**（D2） | **有**（D2） |
| `tool_output`、`background_output`（运行中工具的输出快照） | 有 | 有 | 仅 `include.toolOutput` 开时 |
| `approval_request` / `approval_resolved` | 有 | **无**；改发 `head`，其中 `waitingOnOwner` 变化 | 无；改发 `head` |
| `queued_turns_changed`、`translation`、`task_progress`、`tombstone` | 有 | 无 | 无 |
| `status`（含终态哨兵 seq） | 有 | 不原样发；触发一帧 `head` | 同访客 |
| `resync`、`ping` | 有 | 有 | 有 |
| 新增 `head`（只在观众流里） | — | 标题 + 状态字段 + `activity` + `waitingOnOwner`，即今天 `events?after=` 响应头部那几项 | 同左，无 `waitingOnOwner` |

- `head` 帧（D3）：服务端在流打开时先发一帧，之后在 `status` 事件、审批卡开/关、标题变化时重读一次 `sharedHead`（加访客的 `waitingOnOwner`），与上一帧不同才发；同一会话 250 ms 内的多次触发合并成一次。客户端拿它画状态胶囊和“Waiting for <owner> to approve”，不用再轮询头部。
- 白名单而非黑名单：以后新增的实时事件类型默认不进观众流，要进必须改表、改 spec。
- 增量帧沿用所有者流的瘦信封（只带 `seq/type/payload`）。

## 5. 撤销：流开着时权限没了怎么办（D4）

必须当场断流的情况：访客被移除 / 自己离开；公开链接被撤销、过期、改成不含会话；会话进回收站或被删。

- 建议 A：**hub 信号 + ping 时复查**。上面这些写路径在提交后发一条 `viewer.revoked`（按 sessionId，或按 linkId），经现有 NOTIFY 桥到每台 apiserver；收到后结束对应的流（发一帧 `{type:'gone'}` 再关，客户端据此显示今天的 404 态）。另外每个 `ping`（~20 s）顺手复查一次权限（一条按主键的查询），防信号丢失；过期时间到点这一步也会接住。
- B：只在 ping 时复查。实现简单，但撤销后最多还能看 20 s。

## 6. 容量与滥用（D5）

匿名长连接比匿名短请求更容易被耗：

- 每个 `IP + token` 同时最多 4 条流；每个链接同时最多 200 条；每台 apiserver 观众流总数上限（默认 2000，环境变量可调）。超了回 429，客户端回到轮询。
- 打开流计入 `PublicSurfaceGuard` 的现有限流（一次打开算一次请求）；重连有退避（1 s 起，翻倍到 30 s，加抖动）。
- 一条流的成本：hub 上一个过滤订阅（进程内 Subject）；开 runner-link 时 `hints.watch(sessionId)` 计数 +1（同一会话多个观众共享同一个 NATS 订阅）。没有额外 DB 轮询，只有 ping 时的一条权限复查和 `head` 的偶发重读。
- 多 apiserver：网关 `several-apiservers/server/routes.conf` 今天把 `/api/sessions/:id/events` 按会话哈希到同一台，让一个会话的流共享订阅。新路由同样加 location：访客流按 `:id` 哈希；公开流 URL 里只有 token，按 token 哈希（同一会话不同链接可能落两台，只多一个订阅，与所有者流“公开 id 和 UUID 哈希到两台”同理，可接受）。

## 7. 客户端

| 客户端 | 页面 | 改法 |
|---|---|---|
| Web | 公开页 `SharedSessionPage.tsx`（含项目/任务链接里的会话） | 打开流；收到 `head` 更新状态，收到持久事件按 seq 合并，增量画逐字草稿（复用 `Transcript` 已有的草稿渲染）；流断了带 `sinceSeq` 重连；打不开就用今天的 `followDelay` 轮询 |
| Web | 访客页 `GuestSessionPage.tsx` | 同上；发消息后不再需要 0.5 s 急问（回声随流到），“点发送即画出”保留 |
| iOS / macOS | `GuestSessionView.swift` | 复用 OrbitKit `EventStream`（换 URL 与鉴权），`GuestSentTurns` 保留；`GuestFollow` 作退路 |
| Android | `GuestConversation.kt` / `GuestSessionPage.kt` | 复用 `EventTransport`；`GuestFollow` 作退路 |

原生客户端没有公开页（公开链接只在浏览器里看），所以只读观众只涉及 Web。
标签页隐藏时：Web 关流（与今天隐藏时不轮询一致），回来时带 `sinceSeq` 重开；原生在后台关流，回前台重开。

## 8. 不做什么

- 不给观众看审批卡、排队、翻译、任务进度、费用面板；`head` 只说“在等所有者”，不说等什么。
- 不改公开链接“只读”的定位；访客发消息仍走 POST `/turns`。
- 不引入 WebSocket；不改所有者流。

## 9. 待定 · 要你拍板

| # | 问题 | A（建议） | B |
|---|---|---|---|
| D1 | 推给谁 | 访客 + 只读观众（公开会话链接，及项目/任务链接里的会话）同一期 | 先只做访客，公开页下一期 |
| D2 | 观众看不看逐字输出 | 看（与所有者一样逐字出现）；匿名观众也看 | 只推持久事件（整条消息到了才出现），不推增量 |
| D3 | 状态怎么更新 | 服务端推 `head` 帧 | 客户端收到 `status` 后自己重读一次头部 |
| D4 | 撤销多快生效 | hub 信号当场断流 + ping 复查兜底 | 只在 ping 复查（≤20 s） |
| D5 | 匿名流上限 | 每 IP+token 4、每链接 200、每台 2000，超了回轮询 | 不设流上限，只靠现有请求限流 |
| D6 | 轮询退路 | 保留（老服务器、超限、流失败时） | 流上线后删掉轮询 |

## 10. 落地（按依赖排）

1. **S1 服务端：观众投影 + 两条流路由**。共用判定函数（SQL 与流两种拼法）；`head` 帧；`gone` 帧；限流与上限；否定断言 spec 扩到流（同一组断言跑读口与流，证明流不比读口多给任何字段或事件类型）；pg spec：访客被移除、链接撤销/过期、会话进回收站时流在 1 s 内结束。
2. **S2 网关**：`several-apiservers` 两个新 location（按 id / token 哈希），单 apiserver 部署走 `/api/` 即可；验证 Cloudflare 后面 20 s ping 不被掐。依赖 S1。
3. **W1 Web 公开页** 与 **W2 Web 访客页**：接流、逐字草稿、重连、退回轮询。依赖 S1。
4. **N1 iOS/macOS 访客页**、**N2 Android 访客页**：接流、退回 `GuestFollow`。依赖 S1；需要发版。
5. **E1 端到端**：真 runner + 真浏览器：访客与匿名观众各开一页，所有者发一条消息，量“runner 写出 → 观众看到”的延迟（目标 p95 < 1 s，对照今天的 4 s / 30 s）；撤销后断流；超上限回轮询。
