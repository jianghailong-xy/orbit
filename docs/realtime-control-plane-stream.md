# 设计文档:用户级实时控制面流(Realtime Control-Plane Stream)

状态:定稿 v1(§10 全部决议) · 2026-06-26 · **P1-P5 已落地 2026-07-05**(P1-P3 于 06-26 首次落地但未提交,07-05 从 git dangling blobs 找回并重建;P4 心跳与 P5 客户端接入同日完成;P6 web 未做)
作者:Claude(应 jianghailong 评估请求)
影响面:`src/apiserver`(新增端点 + RealtimeService 扩展)、`src/macos`(OrbitKit + OrbitApp)、`src/web`(可选复用)
关联:[macos-client-design.md](./macos-client-design.md)、[interactive-claude-runner-design.md](./interactive-claude-runner-design.md)

---

## 1. 背景与问题

### 1.1 现状

Orbit 当前的实时推送是 **per-session、单端点** 的:

- **唯一的 SSE 端点**:`GET /api/sessions/:id/events`
  (`src/apiserver/src/sessions/sessions.controller.ts:180`)
  - 按 session 作用域,先回放持久化的 `RunEvent`(`?sinceSeq=N` 之后的),再接入实时流。
  - 鉴权:浏览器用 `?access_token=`(EventSource 不能设 header);**原生 macOS 端直接用 `Authorization: Bearer`**(`EventStream.swift:53`)。
  - 连接前用 `session.ownerId == user` 做归属校验。

- **内部扇出**:`RealtimeService`(`src/apiserver/src/realtime/realtime.service.ts:30`)
  - 进程内一个 RxJS `Subject<{ runId, event }>` 全局 hub;
  - 跨副本走 Postgres `LISTEN/NOTIFY`(`orbit_event` / `orbit_inbox` 频道,instance-id 去重,超 7000 字节的事件降级成「按 seq 发信号 + 对端从持久化日志取」);
  - `streamForRun(runId)` 只是 **按 runId 过滤** 整个 hub。

- **客户端拿列表的方式 = REST 轮询**:
  - macOS Active 侧栏每 4 秒轮询 `GET /sessions?view=active`(`AppModel.startPolling`);
  - 每个 agent 的 Sessions 列表此前**完全不刷新**(只在切换时拉一次),最近才补了同样的 4 秒轮询;
  - web 端同样靠 `refetchInterval` 轮询。

### 1.2 痛点

1. **没有"全局/用户级"的事件流。** 客户端要感知"某个非聚焦会话状态变了 / 新建了会话 / 后台任务完成了 / 来了个审批",只能靠轮询各个列表端点。延迟(最坏 4s)+ 无谓流量 + 每加一种通知就要再加一处轮询。
2. **不可扩展。** 产品后续会有更多需要推到客户端的通知(审批、后台任务、合并结果、未来的协作/系统消息……)。继续往"多处轮询"上叠,是技术债。
3. **macOS 尤其吃亏。** 这是个菜单栏常驻 app,期望"app 在后台也能及时收到通知"。靠多条 per-session 轮询/连接在后台保活既费电又不可靠。

### 1.3 这份文档要解决什么

设计一条 **用户级、常驻、承载所有通知的实时流**(控制面),让客户端登录后开一条连接就能驱动侧栏/列表/角标/系统通知,**取代现在所有列表轮询**;同时明确它与现有 per-session transcript 流(数据面)的分工,以及协议选型理由和能力边界。

---

## 2. 目标与非目标

### 目标

- G1 一条 per-user 的常驻流,推送 **会话生命周期 + 状态 + 审批 + 后台任务 + 未来通知**。
- G2 客户端据此 **撤掉所有列表轮询**;列表/角标/通知近实时更新(亚秒级)。
- G3 **复用现有基建**:RxJS hub、Postgres NOTIFY 多副本桥、JWT 鉴权,不引入新中间件(无 Redis、无 WebSocket Gateway)。
- G4 **向后兼容**:老客户端继续轮询照常工作;新端点是增量能力。
- G5 web 端也能复用同一端点替掉它的轮询(非 macOS 专属投入)。

### 非目标(本期不做)

- N1 **app 完全退出后的推送**。SSE/长连接只在 app 运行(含后台/菜单栏)时有效。退出态通知必须走 **APNs**,是独立的、更重的工作,见 §9。
- N2 把高频 transcript 增量(`text_delta` 等)也塞进这条流。明确**不做**,理由见 §3。
- N3 替换 per-session transcript 流。它继续存在、继续负责聚焦会话的逐字流式渲染。

---

## 3. 核心设计:控制面 / 数据面分离

把实时流拆成**两条职责不同的流**,而不是一条大 firehose:

| | **控制面(本文档新增)** | **数据面(沿用现状)** |
|---|---|---|
| 端点 | `GET /api/events`(用户级) | `GET /api/sessions/:id/events`(会话级) |
| 何时开 | 登录即开,**常驻一条** | 仅为**当前聚焦的 console** 开 |
| 内容 | 生命周期 / 状态 / 审批 / 后台任务 / 通知 | 全量 transcript(含 `text_delta` 逐字增量) |
| 频率 | 低频 | 高频 |
| 驱动的 UI | 侧栏列表、agent 会话列表、角标、系统通知 | 聚焦会话的实时 transcript |
| 补发策略 | **连接时一次性 REST 快照重建**(见 §4.5) | 现有 `?sinceSeq=N` 持久化逐事件回放 |

**为什么必须拆,而不是一条流推所有东西:**
若把所有运行中会话的 `text_delta` 都灌进这条常驻连接,一个挂着 5 个 running agent 的桌面端,**空闲时每分钟会收到几千条它根本不渲染的增量**。控制面/数据面分离让常驻连接保持廉价 —— 这正是后台/菜单栏常驻最需要的。这是经典的 control-plane / data-plane 划分。

**一个关键洞见(决定了补发策略的繁简):**
- 数据面需要**逐事件持久化回放**(`sinceSeq`)—— 因为漏掉一个 delta / tool_result 会让渲染出来的 transcript 损坏。
- 控制面**不需要**逐事件持久化回放 —— 因为它驱动的是**派生状态**(列表/计数),而这些状态**用一次 REST 快照就能完整重建**。所以控制面的补发 = "(重)连接时拉一次列表快照,然后实时流保持新鲜",彻底绕开 per-user 持久化事件日志的复杂度。

```
                         ┌─────────────────────────────────────┐
   runner ──ingest──▶    │  RealtimeService.hub (RxJS Subject)  │
                         │  {runId, event}  ── Postgres NOTIFY ─┼─▶ 其他副本
                         └───────────┬──────────────┬──────────┘
                                     │              │
                  streamForRun(id)   │              │  streamForUser(userId)   ← 新增
                  (按 runId 过滤)     │              │  (按 ownerId 过滤 + 事件子集 + 信封)
                                     ▼              ▼
                   GET /sessions/:id/events   GET /events
                        (数据面,已存在)        (控制面,新增)
                                     │              │
                                     ▼              ▼
                          聚焦 console 的 transcript   侧栏/列表/角标/通知
```

---

## 4. 服务端设计(`src/apiserver`)

### 4.1 新端点 `GET /api/events`

挂在一个新的轻量控制器(如 `EventsController`),或复用合适的现有控制器。签名与现有 SSE 端点对称:

```ts
@AllowQueryToken()          // 浏览器 EventSource 用 ?access_token=;原生用 Authorization header
@Sse('events')              // 路由:GET /api/events
events(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
  return this.realtime.streamForUser(user.userId).pipe(
    map((env) => ({ data: env }) as MessageEvent),
  );
}
```

- 鉴权与归属:`@CurrentUser()` 给出 `userId`,流**只**推该用户拥有的会话事件(`ownerId === userId`)。
- 不做 `sinceSeq` 回放(见 §4.5)。
- 复用现有 `@AllowQueryToken()` 装饰器,使 web 端 EventSource 可用。

### 4.2 事件信封 Schema

一条连接复用给多个会话,每条事件必须自带作用域。控制面事件类型用**独立命名空间**(`session.*` / `approval.*` / …),避免和 `RunEventType` 混淆:

```ts
// src/shared/src/realtime.ts(新增)
export interface ControlEvent {
  type: ControlEventType;     // 见下
  sessionId: string;
  agentId: string | null;     // 用于 per-agent 列表的客户端过滤
  ts: string;                 // ISO-8601
  data: Record<string, unknown>;  // 按 type 定义的载荷
}

export enum ControlEventType {
  SESSION_CREATED  = 'session.created',   // 用户新建/系统创建了会话
  SESSION_UPDATED  = 'session.updated',   // status / title / lastTurnAt / pendingApprovals 变化
  SESSION_ENDED    = 'session.ended',     // 进入终态 / 归档 / 删除
  SESSION_ERROR    = 'session.error',     // 运行错误(含非终态的中途错误)—— 决议 Q3:独立事件
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_RESOLVED  = 'approval.resolved',
  BACKGROUND_TASK    = 'background.task', // 后台进程结束(completed/failed/killed)
  // 预留:未来任意通知都走这个泛化类型,不用每次改协议
  NOTIFICATION       = 'notification',
}
```

`data` 载荷约定(够驱动列表/通知即可,**不塞 transcript 正文**):
- `SESSION_CREATED` / `SESSION_UPDATED`(决议 Q2:**推完整精简摘要**,客户端无脑 upsert):
  `{ id, title, status, agentId, agent:{id,name,model}, pendingApprovals, lastTurnAt }` —— 字段对齐 `GET /sessions` 列表行所需(`agent` 复用 `SessionAgentRef`)。**不做字段级 delta**(避免客户端做易错的字段合并)。
- `SESSION_ENDED`:`{ status, endReason }`。
- `SESSION_ERROR`(决议 Q3):`{ message, recoverable }`。`recoverable=false` 通常伴随 status→FAILED 的 `session.updated`(列表行由后者更新);`recoverable=true` 是中途错误(如内容过滤),status 仍可能停在 `AWAITING_INPUT`,此事件携带 `session.updated` 没有的信息。**客户端通知去重见 §5.2**。
- `APPROVAL_*`:`{ approvalId, pendingApprovals }`(计数用于角标/红点;明细仍走现有 approvals 端点)。
- `BACKGROUND_TASK`:`{ name, status, exitCode? }`。

### 4.3 控制面事件子集(从 hub 里筛什么)

hub 携带全部 `RunEventType`。`streamForUser` 只转发**派生列表/通知所需的粗粒度子集**,其余(transcript 正文)一律丢弃:

| 转发 → 控制面 | 丢弃(数据面专属) |
|---|---|
| `STATUS` → `session.updated` | `TEXT_DELTA` / `THINKING` / `THINKING_DELTA` |
| `TURN_END` → `session.updated`(刷新 lastTurnAt) | `ASSISTANT` / `TOOL_USE` / `TOOL_RESULT` |
| `APPROVAL_REQUEST` → `approval.requested` | `SYSTEM` / `USER` / `RESULT` |
| `APPROVAL_RESOLVED` → `approval.resolved` | `BACKGROUND_OUTPUT`(逐行 tail) |
| `BACKGROUND_TASK` → `background.task` | |
| `ERROR` → `session.error`(决议 Q3:独立事件) | |

`SESSION_CREATED` / `SESSION_ENDED` 是**合成事件**,见 §4.6。

### 4.4 ownerId 解析(关键实现点)

hub tuple 是 `{ runId, event }`,**不带 ownerId**;7 个 publish 调用点都只知道 `sessionId`。三种方案:

| 方案 | 做法 | 评估 |
|---|---|---|
| A 改 hub tuple | 让每个 publish 调用点带上 ownerId | ✗ 改 7+ 处调用点 + ingest 路径,侵入大 |
| **B 惰性缓存(推荐)** | `RealtimeService` 内置 `Map<sessionId, {ownerId, agentId}>`,miss 时一次 Prisma 查询后缓存 | ✓ 改动集中在新代码;命中率高(同一会话事件密集) |
| C 每事件查库 | 订阅整个 hub,逐事件查 owner | ✗ 高频时打爆 DB |

**推荐方案 B**。因为控制面只转发**粗粒度子集**(§4.3),进入解析的事件量本就不大,缓存几乎全命中。
**决议 Q4 —— 驱逐策略:有界 LRU(上限如 10k)+ 会话进终态(映射出 `session.ended`)时立即驱逐该条**。会话结束后 hub 不再产生它的事件,缓存只随"见过的不同 session"增长,LRU 封顶即足够;evict-on-ended 让常驻进程不至长期囤死会话。

```ts
// RealtimeService 新增（有界 LRU）
private ownerCache = new LruMap<string, { ownerId: string; agentId: string | null }>(10_000);

streamForUser(userId: string): Observable<ControlEvent> {
  return this.hub.asObservable().pipe(
    // 只看子集(同步过滤,先砍掉绝大多数高频事件)
    filter((m) => CONTROL_SUBSET.has(m.event.type)),
    // 解析 owner(异步、带缓存),非本用户的丢弃
    mergeMap(async (m) => {
      const meta = await this.resolveOwner(m.runId);  // 查缓存→miss 查库
      if (!meta || meta.ownerId !== userId) return null;
      return toControlEvent(m.runId, meta.agentId, m.event); // 映射成信封
    }),
    filter((env): env is ControlEvent => env !== null),
  );
}
```

### 4.5 补发策略:连接时一次性快照,不做逐事件回放

控制面**不实现** `sinceSeq` 式持久化回放。重连/首连流程由客户端负责"快照 + 跟随":

1. 客户端(重)连 `GET /events`,**先**或**同时**调一次 `GET /sessions?view=...` 拉当前列表快照,把列表 set 成快照;
2. 之后控制面实时事件做增量 upsert/移除。

由此**短暂连接缝隙不会丢状态**:重连后的快照即真值。这正是 §3 的洞见 —— 控制面驱动的是可被一次 REST 完整重建的派生状态,所以无需 per-user 持久事件日志。(数据面的 `sinceSeq` 逐事件回放保持不变,因为 transcript 不可用快照重建。)

### 4.6 合成生命周期事件(session.created / ended)

`SESSION_CREATED` / `SESSION_ENDED` 在 hub 里没有天然对应的 RunEvent,需要在状态变更处显式发。**机制(已落地 P3)**:在 shared `RunEventType` 加两个**控制面内部值** `session_created` / `session_ended`(`run_event.type` 是 String 列,**无需迁移**;且这俩**从不持久化**),经现有 `realtime.publish()` 走 hub —— 顺带白拿 NOTIFY 多副本桥;`RealtimeService` 上封装 `publishSessionCreated/publishSessionEnded`。`streamForRun`(transcript)用 `isLifecycleType` **过滤掉**它俩(永不污染 per-session 流),`streamForUser` 识别后映射为 `session.created/ended`。

发的位置:

- **created**:`SessionsService.create`(新建)+ `restore`(从归档/回收站恢复,重回 active)→ `publishSessionCreated`。`streamForUser` 补全完整 summary。
- **ended**:`SessionsService.archive`(endReason=`completed`)+ `remove`(软删,endReason=`deleted`)→ `publishSessionEnded(id, status, endReason)`。**这俩是"列表成员变化但不带 STATUS 事件"的场景**;而**终态运行状态**(SUCCEEDED/FAILED/CANCELLED)已被 `STATUS → session.updated` 覆盖(客户端按 status 决定离开 active),`PARKED` 仍留在 active(休眠)故不算 ended —— 因此**不在终态/recycle 处重复发 ended**,避免双信号。
- **evict-on-ended(Q4)**:`session.ended` 映射时顺手 `ownerCache.delete(sessionId)`。

### 4.7 多副本、心跳、网关、鉴权

- **多副本**:零改动。事件本来就经 `orbit_event` NOTIFY 桥到达每个副本的本地 hub;`streamForUser` 订阅的是同一个本地 hub,所以无论用户连到哪个副本都能收到全量。
- **多端同账号(决议 Q6,确认无副作用)**:`streamForUser(userId)` 订阅的是共享 hub `Subject`,同一用户 N 个设备各开各的 SSE → 各自拿到独立的过滤 Observable,互不影响。`ownerCache` 是只读式共享、无 per-connection 可变状态。天然支持多端。
- **心跳(决议 Q5,需新增;数据面也建议补)**:服务端在控制面流上每 **~20s** 发一个 SSE 注释帧 `: keepalive\n\n`。现有解析器已忽略 `:` 注释(`SSEFrameParser.swift:50`),但**客户端需在传输层加"最后收到字节时间"看门狗**:超过 2× 心跳间隔没有任何字节 → 判定连接半死 → 主动断开重连。心跳的**真正职责是让客户端快速发现半死连接**(不是顶反代超时);它修掉当前纯靠 TCP/TLS keepalive 探活、长 idle 连接半死不自知的问题。
- **网关(决议 Q5,查证 `gateway/nginx.conf`)**:
  - `GET /api/events` 落在现有 `location /api/` 块,**已自带正确的 SSE 代理**(`proxy_buffering off` + `proxy_read_timeout 3600s` + `Connection ''` + `chunked_transfer_encoding off`)。3600s 读超时对 20s 心跳极宽松,**长连接无需改网关代理配置**。
  - **唯一要补的网关改动**:web 端 `GET /api/events?access_token=…` 会把 token 写进 nginx 访问日志。现有只有 `~ ^/api/runs/[^/]+/events$` 配了 `access_log off`,应把 `/api/events` 也纳入一个 `access_log off` 块(原生 macOS 走 `Authorization` header、URL 不带 token,不受影响)。
- **鉴权**:复用 JWT。原生 macOS 用 `Authorization: Bearer`;web EventSource 用 `?access_token=` + `@AllowQueryToken()`。每条事件已按 ownerId 过滤,天然租户隔离。

---

## 5. 客户端设计(macOS,`src/macos`)

### 5.1 OrbitKit:`ControlPlaneStream` + 解析

- 在 `Realtime/` 下新增 `ControlEvent`(Codable,镜像 §4.2 信封)与解析(复用现有 `SSEFrameParser`,新增 `SSEDecoding.controlEvent(from:)`)。
- 新增 `ControlPlaneStreaming` 协议 + `URLSessionControlStream`(`URLSession.bytes`,带 `Authorization` header,**复用** §4.7 的看门狗式重连),与现有 `EventStreaming`/`URLSessionEventStream` 对称。纯逻辑(reducer/重连决策)放 OrbitKit 可在 Linux 上 `swift test`。

### 5.2 OrbitApp:`AppModel` 接入,撤掉轮询

- 登录成功后开一条 `ControlPlaneStream`,常驻于 `AppModel`(与现有 `startPolling` 同位置)。
- 收到事件 → 更新 `sessions` / `groups` / `menuSummary` / Dock 角标 / 发系统通知(复用现有 `SessionDelta` → `Notifications.content(for:)` 那套,但输入从"轮询前后快照 diff"换成"控制面事件"驱动)。
- **错误通知去重(决议 Q3)**:`session.error` 是错误的**唯一通知来源**。客户端在 `recoverable=false` 时**不要**再对随后的 `session.updated`(status→FAILED)重复弹通知 —— FAILED 只更新列表行,不二次通知;`recoverable=true` 的中途错误由 `session.error` 单独提示。
- **撤掉** `AppModel.startPolling` 的 4 秒列表轮询,以及 `AgentsView` 上一轮新加的 per-agent 轮询(§1.1)—— 改为:
  - 进入某个列表视图时,调一次 REST 拉快照(§4.5 的"连接时快照");
  - 之后由控制面事件做增量更新。
  - per-agent 列表 = 对同一份 `sessions` 按 `agent.id` 客户端过滤(`SessionFilter.forAgent` 已有),不再单独拉。
- **保留** per-session `ConsoleModel`/`EventStream`:聚焦 console 仍走数据面,逐字渲染不受影响。

### 5.3 后台保活与 App Nap

- 菜单栏常驻 app:一条轻量控制面连接比多条 per-session 轮询更易在后台保活、更省电 —— 又一条支持拆分方案的理由。
- 注意 macOS **App Nap** 可能在 app 后台时节流 `URLSession`。需验证后台仍能持流;必要时调整 `URLSessionConfiguration`(如 `isDiscretionary=false`、合适的 `waitsForConnectivity`)或声明活动。**此项需真机验证**(Linux 验不了)。

---

## 6. Web 客户端复用(`src/web`,可选、推荐)

同一个 `GET /events` 端点,web 用 `EventSource('/api/events?access_token=…')` 即可:
- 登录后开一条,事件喂给现有 query 缓存(`lib/queries`),`setQueryData` 增量更新列表;
- 撤掉(或大幅放宽)现有 `refetchInterval`,改"快照 + 跟随"。
- 收益与 macOS 一致,且证明端点不是 macOS 专属投入。

---

## 7. 向后兼容与灰度

- **纯增量**:新增端点,不改 `GET /sessions/:id/events` 与 REST 列表端点。
- **老客户端**:继续轮询,行为不变。
- **新客户端探测**:`GET /events` 404 / 连接失败 → 优雅回退到轮询(保留轮询代码到下个版本,确认线上稳定后再删)。
- **无 DB 迁移**(方案选 §4.5,不持久化控制事件)。若日后要做 §9 的 APNs 离线投递,再单独引入持久化与设备表。

---

## 8. 实施阶段拆分

| 阶段 | 内容 | 可验证产物 |
|---|---|---|
| **P1 协议层(✅ 2026-06-26 已落地)** | shared `realtime.ts`(`ControlEventType` + `ControlEvent` + 5 个 typed payload)+ OrbitKit `Models/ControlEvent.swift` 镜像(`.unknown` 兜底 + `payload(_:)` 解码) | **已验证**:shared `tsc --noEmit` 0 错 + vitest 2 passed(`realtime.spec.ts`);OrbitKit `swift test` 123 passed(+9 `ControlEventCodableTests`) |
| **P2 服务端流(✅ 2026-06-26 已落地)** | `RealtimeService.streamForUser` + ownerCache(有界 LRU)+ `buildSessionSummary`/`countPendingApprovals` + 纯映射 `realtime/control-events.ts` + `GET /api/events`(`EventsController`/`EventsModule` 入 AppModule) | **已验证**:apiserver 全量 `tsc` 0 错;`node --test` 9 passed(`control-events.spec` 纯映射 5 + `stream-for-user.spec` 集成 4:owner 过滤、session.updated 全摘要、approval 计数、transcript 丢弃)。**手测 curl SSE 待部署后在运行栈上做**(端点是 `/sessions/:id/events` 的同构镜像,已编译+单测) |
| **P3 合成生命周期(✅ 07-05)** | created/ended 于 create/restore(created)与 archive/remove(ended)发信号;终态运行状态走 session.updated 不重复发 | node --test 46 passed(realtime 13:含 created/ended 映射 + transcript 隔离) |
| **P4 心跳 + 看门狗(✅ 07-05)** | 服务端 20s keepalive(Nest @Sse 发不了 `:` 注释帧 → 改发 `{type:"ping"}` data 帧,客户端按类型丢弃、字节喂看门狗——效果等同) + OrbitKit 传输层字节看门狗(2× 间隔无字节 → 断开重连) | ControlStreamTests |
| **P5 客户端接入(✅ 07-05,macOS+iOS 共享层)** | OrbitKit `ControlEvent.swift`+`URLSessionControlStream`;`AppModel` 常驻流:连上→快照重建+停轮询tick,断→回退 4s 轮询(老服务器兼容);通知复用 SessionDelta(upsert 前后快照 diff) | swift test;真机后台保活待验 |
| P6 web 复用(可选) | EventSource 接入 + 放宽 refetch | 列表实时、轮询流量下降 |

P1–P4 大多可在 Linux 上闭环(单测 + curl);P5 的运行时/后台行为需真机。

---

## 9. 能力边界:退出态通知 → APNs(单独立项)

**本方案的长连接只在 app 运行(含后台/菜单栏)时有效。** 如果产品要"**app 完全退出了也能弹通知**",必须:
1. 接入 **Apple Push Notification service (APNs)**:客户端注册 device token,服务端持久化 token,关键事件(审批、任务完成)经 APNs 推送;
2. 这需要 Apple Developer 推送证书/Key、服务端 APNs 集成、设备表与投递偏好 —— 工作量与本方案**相当或更大**,且与 SSE 长连接正交。

建议:**先做本文档的控制面流**(覆盖"app 在用/在后台"的绝大多数场景),APNs 作为后续独立 RFC 评估,不要混在一起。

---

## 10. 决议记录(Resolved · 2026-06-26)

| # | 问题 | 决议 | 依据 |
|---|---|---|---|
| Q1 | 端点命名 | **`GET /api/events`** | 鉴权已隐含用户作用域,与 `/sessions/:id/events` 对称且更简洁(§4.1) |
| Q2 | `session.updated` 粒度 | **完整精简摘要**(客户端无脑 upsert) | 简单优先、不易错,体量也小;不做字段级 delta(§4.2) |
| Q3 | 运行错误通知 | **独立 `session.error` 事件** | 能携带非终态中途错误(如内容过滤)等 status 没有的信息;客户端按 §5.2 去重避免与 status→FAILED 双通知(§4.2/§4.3/§5.2) |
| Q4 | ownerCache 驱逐 | **有界 LRU(~10k)+ 终态即驱逐** | 子集事件量小、命中率高;封顶 + evict-on-ended 防囤积(§4.4) |
| Q5 | 心跳 & 网关 | **~20s 心跳 + 客户端字节看门狗**;网关 `/api/` 已正确代理 SSE,**无需改代理**,仅补 `/api/events` 的 `access_log off` | 查证 `gateway/nginx.conf`:`proxy_read_timeout 3600s` 对 20s 极宽松;心跳职责是客户端探活(§4.7) |
| Q6 | 多端同账号 | **天然支持,无副作用** | 各设备各订阅共享 hub,`ownerCache` 只读式共享(§4.7) |

---

## 11. 小结

- **协议选型:SSE 正确,不换 WebSocket/gRPC**。Orbit 是"服务端下推、客户端 REST 上行"的非对称模式,SSE 正好对口;且 `sinceSeq` 持久回放、原生 header 鉴权、已测的字节级 parser 都是现成资产,换协议要全部重造。
- **架构方向:控制面 / 数据面分离**。新增一条 per-user 常驻控制面流承载所有通知,取代列表轮询;per-session transcript 流保持不动。
- **实现成本可控**:复用 hub + NOTIFY + JWT,无新中间件、无 DB 迁移;主要新增是 `streamForUser` + ownerCache + 一个 SSE 端点 + 客户端一条流。
- **边界清晰**:退出态推送走 APNs,单独立项。
