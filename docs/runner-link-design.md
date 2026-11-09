# 设计文档：Runner 链路协议 v1（runner ↔ 控制面）

状态：定稿 v1 · 2026-10-07（代码引用按 main 的 701d9bae2 核对，2026-10-25）· 2026-10-27 增补 §15（实现与设计的差异）并更新 §11.4，按项目分支 4a493f6b8 的代码核对 · 决策见 §2（D1–D8 由 jianghailong 拍板，D9–D15 随本文定稿）
作者：Claude（应 jianghailong 评估请求）
影响面：`src/runner-go`（链路客户端）、`src/apiserver`（连接令牌、定向提示、在线状态、事件入库、旧路由下线）、新增链路网关（Go）、新增 `contracts/runner-link/v1`、部署（四层入口、NATS）
关联：[architecture.md](./architecture.md)、[interactive-claude-runner-design.md](./interactive-claude-runner-design.md)、[realtime-control-plane-stream.md](./realtime-control-plane-stream.md)、[run-event-retention-proposal.md](./run-event-retention-proposal.md)、[postgres-runtime-settings.md](./postgres-runtime-settings.md)

---

## 0. 一句话

每台 runner 一条直连单元网关的 WebSocket，用 protobuf 编码；流量按可靠性分成五类，各用各的规则。协议只切一次：v1 一次性放进 10 万用户规模要用的能力，之后的扩容全部在服务端内部完成，不再让 runner 换协议。

---

## 1. 背景

### 1.1 现状

runner 只主动发出站 HTTPS，路径是 Cloudflare → nginx → apiserver：

| 通道 | 形式 | 服务端实际在做什么 | runner 失败后怎么重试 |
|---|---|---|---|
| `GET /runner/sessions/claim` | 25s 长轮询 | 每 ≤5s 一次领活事务，每次都拿同一把全局 advisory 锁（`src/apiserver/src/queue/queue.service.ts:354`）；入队信号只在进程内，且广播给所有等待者（`queue.service.ts:143`） | 250ms→5s 退避 + 对账 |
| `GET /runner/sessions/:id/inbox` | 每个常驻会话一条，25s | 每 ≤5s 一次带 `FOR UPDATE` 的事务（`src/apiserver/src/runner-api/runner-api.controller.ts:3738`） | 固定 1s、不退避，6 处 poller 都是 |
| `GET /runner/wake` | 25s | 纯内存 | 5s |
| `POST /runner/heartbeat` | 每 30s | 整行重写 runner，带大块 JSON；响应里捎带 18 个字段的命令 | 等下一次 |
| `POST /runner/sessions/:id/events` | 每会话 250ms | 先锁会话行（`runner-api.controller.ts:6381`），每条事件（包括逐字增量）单独一次 `pg_notify`（`src/apiserver/src/realtime/realtime.service.ts:435`） | 100ms→2s；连续 30 次 500 丢掉整批 |
| `GET …/approvals/:id` | 25s | 每 1.5s 查一次库 | — |

另外两点：

- runner 的所有请求复用同一条到 Cloudflare 的 HTTP/2 连接，这条连接没有健康检查（`src/runner-go/transport.go:256`）。09-29 wiki 客户端踩过"连接静默死掉"的坑，修复只加在了 wiki 自己的客户端上（`src/runner-go/wiki_conn.go:8`）。
- 每个请求的鉴权都读一整行 runner（`src/apiserver/src/runner-api/runner-auth.guard.ts:41`）。

### 1.2 实测

数据来自本机 runner `workstation-gpu` 的 journal，时间范围 2026-10-02 23:16 → 10-07，约 4.5 天：

- **119 个错误窗口，约 26 个/天。** 多数是 10–60 秒的 502/521，形态和部署时重建容器一致（推断）。16 个 inbox poller 各自每秒重试一次，4.5 天累计约 7,900 次 inbox 失败。
- **10-05 02:28–02:38 UTC，服务端对所有接口回了约 10 分钟 500。** "连续 30 次 500 就丢弃"的规则因此丢掉 66,771 条事件，其中一个会话就丢了 66,715 条。原因是资源类数据库故障（P2024/P2028）在边界上仍然回 500（`src/apiserver/src/common/transaction-retry.ts:136`），只有冲突类会映射成 503。
- **两段 16–19 分钟的成片超时。** 10-06 那段时间里，同一个 runner 的 background-wake 请求成功了 3 次，说明连接没死，更像是服务端的 runner 接口变慢了。
- **自动恢复机制在起作用：** 0 次租约被接管；13 次 claim 响应丢失、3 次迟到的 claim 都自动对账恢复了。

### 1.3 规模目标与瓶颈

每个活跃用户的规划假设：

- runner 连接 1.5 条；
- 常驻会话 4 个；
- 高峰并发 turn 0.5 个；
- 持久事件每天约 4,000 条（生产上 6 个重度用户、去掉噪声后的实测）；
- 正在输出的 turn 每秒 20–50 条逐字增量。

按 10 万用户合计：约 15 万条 runner 连接、40 万个常驻会话、高峰 5 万个并发 turn、每天约 4 亿条持久事件（高峰每秒 1.5–2 万条）。

现架构的瓶颈（估算，需压测确认）：

| 瓶颈 | 大约在多大规模撞墙 |
|---|---|
| 每条事件一次 `pg_notify`，而 NOTIFY 提交时要全局串行 | 几百个同时在输出的 turn |
| 领活全局锁 + 广播唤醒 | 约 500–1,000 台 runner |
| 每会话每 250ms 一个带行锁的入库事务 | 约 1–2 千个并发 turn |
| 每个常驻会话每 5s 一次 inbox 事务 | 约 1–2 万个常驻会话 |
| 每 30s 整行重写 runner | 几千台 runner |

第一堵墙在几百到一千个活跃用户。

---

## 2. 决策记录

| # | 问题 | 决议 |
|---|---|---|
| D1 | runner 链路是否经过 Cloudflare | 不经过。用独立域名，DNS 只解析不代理，直连单元的四层入口（生产和按单元部署都这样）。默认安装例外：runner 走 web 网关的同一个端口，见 §15.10 |
| D2 | 编码 | protobuf |
| D3 | 持久事件如何进入写库路径 | 网关直接调用，不引入 JetStream 这类持久消息中间件 |
| D4 | 旧协议 | 不保留，直接切换；runner 直接升级，不做兼容 |
| D5 | 单元大小 | 1 万用户 |
| D6 | 会掐断 WebSocket 的公司代理 | 不做降级；这类网络里的用户用不了自托管 runner |
| D7 | 影子连接 | 切换前先跑 1–2 周 |
| D8 | 切换时正在运行的 turn | 等它跑完，不中断 |

由设计推出、随本文一并定稿的：

| # | 内容 | 理由 |
|---|---|---|
| D9 | 流量分五类，各有各的可靠性规则（§5.2） | 一一对应现有语义，只换通道 |
| D10 | 进程身份和连接身份分开（§5.4） | 断网重连不能让租约失效 |
| D11 | 在线状态放在 Postgres 的 UNLOGGED 表里（§6.5） | 不新增组件、能用 SQL 关联、不写 WAL |
| D12 | 第一版事件 payload 用 JSON 字节（§5.1） | 服务端本来存的就是 jsonb，客户端收的也是 JSON，避免重复定义 |
| D13 | 长尾的结果回报原样转发给现有内部路由（§5.6） | 业务逻辑和测试都不用动 |
| D14 | agent 工具 API、注册、附件、二进制下载继续走 HTTPS（§4） | 它们不属于守护进程协议 |
| D15 | 所有改动按开关分批合入 main：服务端的链路能力只新增、不改变现有 HTTP 行为；runner 的链路模式默认关闭；切换由服务端开关 `RUNNER_LINK_REQUIRED` 触发（§11.3；实现上是运行时开关，见 §15.1） | main 每天有上百次合入，长期分支不可行；切换和首选回滚都只是翻一个开关 |

---

## 3. 目标与非目标

目标：

- **G1** 每台 runner 只有一条连接；服务端不再为了等活挂起请求，也不再定时查库。
- **G2** 断线、部署、数据库故障时，不丢事件、不重复执行、不误判离线。
- **G3** 在每单元 1 万用户、共 10 个单元的规模下，链路和入库都留有余量。
- **G4** 协议只切一次。后续扩容（独立写入器、单元化、按需推流）不需要 runner 换协议。

非目标：

- **N1** 不改造 agent 工具 API（`orbit mcp`、CLI）。
- **N2** 客户端 SSE 协议不变；服务端内部改用 NATS 时客户端无感。
- **N3** 不涉及托管 runner 的沙箱与算力调度。
- **N4** 不做多区域多活。
- **N5** 不做 WebSocket 不可用时的降级传输（D6）。

---

## 4. 总体结构

```
runner ──WebSocket（TLS，protobuf）──▶ 四层负载均衡 ──▶ 链路网关（Go，单元内多节点）
  │                                                      ├─ 控制请求 → API 内部路由（HTTP/JSON，现有逻辑）
  │                                                      ├─ 持久事件 → 写库（第一步：沿用 API 现有入库逻辑）
  │                                                      └─ 提示、实时流 ⇄ NATS（只用核心功能，不用 JetStream）
  │
  └──HTTPS（经 Cloudflare）──▶ API：注册、领取连接令牌、自更新与 /dl、agent 工具 API、附件
```

**被替换的**：runner-api 主控制器里的全部守护进程路由（2026-10-25 统计为 49 个，2026-10-28 起为 52 个，见 §15.9），包括领会话、取消息、wake、心跳、事件、租约、各类结果回报等。

**继续走 HTTPS 的**（D14）：

- 注册（device flow）和领取连接令牌：建立链路之前就得用到。
- 自更新：`GET /api/runner/release`，以及 `/dl` 下的二进制和 `version.json`。
- agent 工具 API：其余 runner-* 控制器里的约 116 个路由，主要给 agent 和 CLI 用。
- 附件、产物的上传下载。以后可以换成对象存储的预签名 URL。

---

## 5. 协议 v1

### 5.1 帧与编码

- **帧格式**：WebSocket binary 帧，每帧一个 protobuf `Frame`，由 `id` 和 `oneof body` 组成。
- **定义与检查**：定义放在 `contracts/runner-link/v1/*.proto`。CI 跑 `buf lint` 和 `buf breaking`；字段编号只增不复用，删掉的字段标记 `reserved`。
- **代码生成**：Go 用 `google.golang.org/protobuf`，TS 用 `@bufbuild/protobuf`。
- **事件 payload**：用 `bytes payload_json`（D12），其余消息全部用强类型。
- **帧大小**：单帧上限 256KB。超出时在应用层切块，控制帧可以插在块与块之间。
- **写出优先级**，从高到低共三档：
  1. 控制：心跳应答、确认、取消、令牌续期、`Close`；
  2. 提示和 RPC 响应；
  3. 实时流。

### 5.2 五类流量

| 类别 | 例子 | 可靠性 | 丢了会怎样 |
|---|---|---|---|
| 提示（下行） | 有新消息、有可领的活、有命令待取、审批有结果、观看者变化 | 至多一次 | 最多推迟到下一次心跳（≤30s） |
| 控制请求（双向 RPC） | 取消息、领会话、turn 完成、merge/commit 结果、创建审批 | 请求带 id，幂等；错误带 `retryable` 和 `retry_after` | 重发，拿回同一个结果 |
| 心跳（上行，定期） | 进程身份、全部会话清单、容量、事实哈希 | 每 30s 全量一次，做电平触发的对账 | 下一次补上；连续缺失才判离线 |
| 持久事件流（上行） | 每个会话按 seq 排列的对话记录事件 | 至少一次 + 按 seq 去重 + 确认到第 N 条 | 从 N+1 续传，不丢不重 |
| 实时流（上行） | 逐字增量、thinking 增量、工具输出快照、后台输出 | 尽力而为，可以合并、可以丢 | 只影响动画；最终内容在持久事件里 |

### 5.3 消息清单

| 方向 | 消息 | 作用 | 首版服务端可以先简单实现的地方 |
|---|---|---|---|
| 上 | `Hello` | 进程身份、版本、能力、续传信息 | — |
| 下 | `Welcome` | 协议版本、心跳间隔、各项限额、每会话已持久化到的 seq、是否仍持有租约、有活的会话列表、指定的 runner 版本 | — |
| 下 | `TokenRefresh` / `Redirect` / `Drain` / `Close(code, retry_after)` | 令牌续期、改连别的单元、逐步断开、带原因关闭 | `Redirect` 暂时不会发 |
| 下 | `Hint` | inbox、claim、commands、approval、watchers | — |
| 双 | `Rpc` / `RpcResult` | 带 `request_id`、`after_seq`，错误有类型 | — |
| 上/下 | `Heartbeat` / `HeartbeatAck` | 对账 | 先每次都完整对账 |
| 上/下 | `EventBatch` / `EventAck(durable_seq, rejected[])` / `Credit` | 持久事件 | 额度先给一个宽松的固定值 |
| 上 | `LiveBatch` | 实时流 | 可以先全量转发，但 runner 必须支持停发 |
| 下/上 | `TurnPrefixRequest` / `TurnPrefixResponse` | 客户端中途打开会话时，取这一轮已经输出的半截文本 | — |

字段级定义以 `contracts/runner-link/v1/runner_link.proto` 为准（A1 定稿）。下面几处设计文档原先没写死，由 A1 定下、协调者确认：

- 心跳里的事实只带摘要，服务端要时再发全文（`Fact`、`HeartbeatAck.want_facts`）。
- `HeartbeatAck.reconcile_json` 原样携带今天的 HeartbeatResponse JSON，各类命令的合同不变。
- `Hello` 带上今天每个请求都带的头信息（系统、支持的引擎、写入契约、托管实例），由网关转发给后端。
- 实时流有自己的序号 `LiveEvent.live_seq`，和持久事件的 seq 分开；`TurnPrefixResponse.through_live_seq` 标明半截文本和实时流的衔接点。
- `TunnelResponse` 原样带回路由的状态码；`Failure` 只用于完全没拿到应答的请求。
- `EventAck.failure` 区分可重试和永久的入库失败。
- 超过 256 KiB 的帧用 `Chunk` 分块传输。

### 5.4 握手与身份

握手过程：

1. runner 用长期凭证（现有的 runner token），经 HTTPS 换取一个连接令牌。令牌有效期约 1 小时，里面写明 runner、租户、单元和链路地址。
2. 连接升级请求带上 `Authorization: Bearer <link token>`，网关验签通过后才升级。
3. 首帧发 `Hello`，内容包括：
   - 进程身份，即现在的 `leaseOwner`：每个进程一个，`exec` 之后换新；
   - 二进制版本、协议版本区间、能力列表；
   - 续传信息：每个会话最后发出的 seq，以及正在执行的 turn。
4. 服务端回 `Welcome`，内容见 §5.3。

身份规则：

- **进程身份决定租约，连接身份只决定往哪条连接投递。** 断网重连不换进程身份，租约不受影响；只有换了进程，才走现有的 takeover 接管流程。
- **同一进程出现两条连接时，以最新的那条为投递目标**，旧的关掉。
- **网关鉴权不查库。** 只用公钥验签；令牌在连接内续期；吊销时经 NATS 通知网关断开连接，令牌的短有效期作为兜底。

### 5.5 提示

- **三个信号都改成定向发送：**
  - `notifyInbox(sessionId)`：先查出会话属于哪台 runner，再发给它。
  - `notifySessionQueued()`：现在是广播，要改成带上 runnerId，涉及约十来个调用点。
  - `notifyRunnerWake`：本来就是定向的。

  三者统一发布到 NATS 主题 `rnr.<runnerId>`，由持有该连接的网关转发。
- **提示在数据库提交之后才发布。**
- **兜底不靠每个会话定时轮询**，而是在 `HeartbeatAck` 里附带"你名下有活的会话列表"。提示丢了最多推迟 30 秒。

### 5.6 控制请求

- **不再挂起。** 原来的几种长轮询（claim、inbox、wake、审批）都改成收到提示后立即调用、不挂起（`wait=0`）。例外是领会话时某个会话的行锁被别的事务占着（`FOR UPDATE NOWAIT` 拿不到，常见的是同一会话正在取消息）：这次领会话先自己再试，最多约 5 秒，间隔从 50 毫秒起翻倍、最长 1 秒，两次之间不占领活锁，runner 断开就停（`QueueService.claimSessionForRunner`，5d28c667a）。切换后清理（§13）删掉了长轮询本身：`/runner/wake` 只回 426，只有 `orbit mcp` 经 HTTPS 读审批时仍最多挂起 25 秒（§15.11）。
- **每个请求带 `request_id`，重发返回同一个结果。**
  - 取消息：同一个进程再来取、而它手上没有正在执行的那条时，立即重新投递，不再等 300 秒租约过期（`runner-api.controller.ts:4160`、`:480`）。runner 本来就按 turnId 去重。
  - 领会话：重试时返回同一个会话，取代现在事后靠 reclaim 对账。代码里已有先例：`TASK_RUN_REQUEST_IN_PROGRESS`（`src/runner-go/transport.go:176`）。
  - 实现上，取消息和领会话没拿到应答时，下一次沿用原来的 `request_id`，直到拿到应答为止，见 §15.4。
- **取消息时的现场判断全部保留：** 插队顺序（`runner-api.controller.ts:4169`）、插话只给正在运行的那一轮、账号暂停检查、按本次请求声明的能力决定是否下发。
- **`after_seq`。** 有顺序依赖的请求要带上它，例如 turn 完成必须在投递回执落库之后处理。服务端先确认该会话已经持久化到 `after_seq`，再处理请求。
- **错误统一带 `code`、`retryable`、`retry_after`。** 数据库资源类故障一律回可重试错误，不再回 500。
- **长尾的结果回报原样转发。** merge、commit、install、login 等十几种结果回报，用 `TunnelRequest{method, path, json_body}` 转给对应的内部路由（D13），以后再逐个改成强类型。

### 5.7 心跳

- 每 30 秒一次，间隔由 `Welcome` 下发。内容包括：
  - 进程身份、是否在排空、容量、全部会话清单；
  - 事实哈希：模型目录、技能、引擎状态、仓库健康。服务端遇到不认识的哈希时，才向 runner 要全量。
- 服务端怎么处理：
  - 每次心跳只写在线状态表（§6.5）。
  - 设一个"有变化"标记：这台 runner 名下有新命令、有取消、或租约有变化时置位。只有置位时，或者每 5 分钟一次，才做完整对账。首版可以每次都完整对账。
  - 命令（merge、commit、登录、安装等）仍然通过 `HeartbeatAck` 至少下发一次，并配合提示立即触发心跳。各类命令现有的合同和去重方式都不变。
- 按合同靠心跳续租的（codex reset、集成任务），照常更新它们自己的那几行记录。
- 服务端答得慢不算断线：一条连接上同时只有一个没答的心跳（`beat_id` 标明回答的是哪一个），迟到的回答不断开连接，连接死活只看 ping，见 §15.13。

### 5.8 持久事件流

- **发送与确认。** runner 按会话发 `EventBatch{session, events[seq…]}`，服务端写入成功后回 `EventAck{session, durable_seq, rejected[]}`。
- **本地缓冲。** runner 只删已确认的部分。未确认的先放在内存里（每会话 8MB、总共 256MB），超出后写到磁盘（例如上限 2GB）。
- **seq 续接。** 会话开始或重新开始时，从"服务端 durable_seq 和本地最大 seq 两者中较大的那个"加 1 开始，并先补发积压。否则，撞号的事件会被 `skipDuplicates` 静默跳过。实现上服务端遇到同一 seq 上不同的事件时照常确认，但记错误日志并计数，见 §15.7。
- **坏事件单独拒绝。** 服务端在这个 seq 上写一条墓碑占位，后面的事件照常写入。
- **额度（`Credit`）。** 网关按入库队列的深度发放额度。额度用完时，runner 只放慢发送，仍照常读取引擎的 stdout（`src/runner-go/session.go:830`）；进度类事件合并，实时类事件丢弃。
  - **总量上限。** 入库队列指所有连接已收下、还没确认的事件。它跨连接有一个总上限，条数和字节都算，默认 20 万条或 128 MiB（`LINK_INGEST_QUEUE_MAX_EVENTS`、`LINK_INGEST_QUEUE_MAX_BYTES`），不管连接多少都不会超过。按 C2b 测得的每条积压约 2.4 KB，默认上限约合网关内存半 GB。队列没有空位时，新批次按 `CREDIT_EXCEEDED`（可重试，1 秒后）退回、不转发，事件留在 runner 自己的缓冲里。
  - **排队。** 被挡下的会话按先来后到排队。队列腾出的空位先留给排队的会话，等它的 runner 重发，最多留 15 秒；别的批次不能占用，即使放得下。所以批次再大的会话也能轮到，不会有会话一直排不上。
  - **降级与恢复。** 队列超过上限的一半（高水位）时，每条连接的额度降到 1,000 条、8 MiB，并且条数不超过高水位在"队列里有事件的连接"之间平分的份额（5,000 条连接在发时每条 20 条）。这样不管连接多少、空闲的有多少，在发的连接在途事件加起来都在高水位附近，runner 自己放慢，而不是发出来再被退回；高水位到上限之间留给 `Credit` 帧送达之前就已发出的事件。在发的连接数变动超过八分之一，份额才跟着变。字节不平分：8 MiB 是最大的单条事件需要的，字节只由总上限管。队列低于上限的四分之一时，额度恢复。
- **提交节奏。** 每个会话约 1–3 秒提交一次；遇到边界事件（回复结束、工具结果、状态变化）立即提交。

### 5.9 实时流

- `LiveBatch` 不需要确认，可以合并。
- **只在有人看时转发。** 网关只在有人观看时才发布到 NATS 的 `ses.<id>.live`；没人看时下发 `Hint{watchers: 0}`，runner 就停发增量。
- **中途打开会话。** 客户端中途打开时，服务端向 runner 发 `TurnPrefixRequest`，拿到这一轮已经输出的半截文本后，再接上实时流。这取代现在只存在单个副本内存里的 turnPrefix。
- 实时事件不再逐条 `pg_notify`。

### 5.10 大块数据

- 附件、产物继续走现有的 HTTPS 接口。
- 超过约 64KB 的工具输出也不进链路，事件里只放引用。引用格式在 v1 里就定下来，以后换成对象存储预签名 URL 时，runner 不需要换协议。这一条没有实现，见 §15.2。

### 5.11 演进

- `Hello` 带能力列表；收到不认识的字段一律忽略；协议的小版本只能增加字段。
- 不兼容的改动开新的大版本，在 `Hello` 里协商。

---

## 6. 服务端

### 6.1 链路网关（Go，新服务）

- **连接与队列。** 每条连接一读一写两个协程，写出有三档队列。对方读得慢时，实时队列满了直接丢，控制队列满了就断开连接。
- **不持有业务状态。** 连接状态只存在内存里，断了重连可以续传。转发 RPC 时，幂等请求会在后端实例之间自动重试，所以后端发布不影响 runner 的连接。
- **存活检测。** WebSocket ping 每 20s 一次，60s 收不到回应就断开。判断 runner 进程是否活着，以心跳为准，不以 ping 为准：ping 由独立协程应答，主循环卡死了它照样会回。
- **逐步断开。** 发布或缩容时，分批向连接发 `Drain{reconnect_after}`，每条连接的重连延迟随机。
- **防护：**
  - 握手限速；
  - 未认证的连接几秒内断开；
  - 按 IP 限制新建连接的速率；
  - 每台 runner 最多 2 条连接。
- **可观测性：**
  - 指标：连接数、握手成功率与延迟、断开原因、RTT、未确认事件量、确认延迟、额度耗尽次数、实时流丢弃量、各 RPC 的延迟与错误。
  - 日志输出解码后的帧摘要，并配一个解码工具 `orbit link dump`。

### 6.2 连接令牌与单元目录

- 新增 `POST /api/runner/link-token`：走 HTTPS，用现有 runner token 鉴权，签发连接令牌并返回链路地址。
- 全局维护一份"租户 → 单元"的目录，现在只有 cell-1 一项。
- 吊销查询 `GET /api/runner/link-token/revocations` 只对网关开放：网关用服务密钥 `RUNNER_LINK_GATEWAY_TOKEN` 鉴权，不对公网开放。网关定期拉取，在本地维护拒绝名单，鉴权路径不查库。

### 6.3 NATS 主题

- `rnr.<runnerId>`：提示、踢连接。
- `ses.<sessionId>.live`：实时流。
- `usr.<userId>`：控制面事件，以后给客户端网关用。
- `api.held`、`api.<instanceId>`：apiserver 进程之间转交只在内存里的登录状态（Antigravity 粘贴的登录码、待检查的 Cursor 密钥；`src/apiserver/src/runners/relay-peers.ts`）。
  - 持有方在 `api.held` 上声明：哪个实例、为哪台 runner、持有哪个登录尝试或检查 ID。声明里不带登录码和密钥，持有期间每 5 秒重发一次，交出或作废后撤回。
  - 心跳落到别的进程时，该进程向 `api.<instanceId>` 发请求，带上自己读到的登录尝试或检查 ID，对得上才交出。登录码和密钥只出现在这一次应答里，发往请求方的 inbox，只交一次；不存库、不写日志、不进事件。
  - 只有 apiserver 的 NATS 用户能在 `api.>` 上发布、订阅和应答。网关的用户读不到 `api.>`，也读不到 `_INBOX.>`（`src/link-gateway/nats.conf`）。

### 6.4 控制请求的处理

- 现有 runner-api 路由挪到一个只有内网能访问的前缀，由网关调用（HTTP/JSON）。网关负责补齐能力 header；runner 断线时，网关取消在途的请求，所以现有的 `hungUp` 逻辑继续有效。
- 长轮询的处理器改成不挂起；加上 `request_id` 幂等，可以用一张幂等表，或者记在现有的行上。

### 6.5 在线状态与 reaper

- **新表 `runner_presence`（UNLOGGED）。** 字段包括 `runner_id`、`process_id`、`gateway_id`、`last_beat_at`、`link_state`、事实哈希、对账哈希。每次心跳 upsert 一行，每单元约 500 次/秒。
- **读取统一收口。** 现在有约 69 处（分布在 23 个文件里，2026-10-25 统计）直接读 `lastHeartbeatAt`，统一改成调用在线状态接口；`runner.last_heartbeat_at` 降为低频记录，例如每 5 分钟写一次。
- **启动宽限期。** UNLOGGED 表在主库崩溃或主备切换后会被清空，所以 reaper 启动后有一段宽限期（例如 3 分钟），期间不回收任何会话。
- **大面积断线时，断线的那一批 runner 不因静默被回收。** 单元内两成以上的 runner 在 45 秒内先后失联（已经重连回来的也算），或者两成以上同时静默，就是一次大面积断线。这一批 runner 的会话不因静默被回收，直到各自静默超过 10 分 45 秒（45 秒静默线加 10 分钟窗口）；不在这一批里的 runner 照旧在静默满 5 分钟后回收（列表仍按 90 秒显示离线，见 §15.6）。断线一被看到就记进数据库，所以保护不取决于哪个 apiserver 进程在清扫，也不取决于那一刻还有多少 runner 在静默。在线状态写入出现异常时，reaper 暂停全部回收。这是把现有"数据库出问题时不把沉默当证据"的规则（`transaction-retry.ts:129`）推广开。静默怎么计、失联怎么认、保护多久，以及和这里原来写法的差别，见 §15.6。

### 6.6 事件入库

- **第一步**：网关直接调用 API 现有的入库逻辑（D3），那 700 多行派生状态逻辑保持不动。
- **之后**：
  - 拆出独立的写入器进程（Go 或 Node），内部改用 gRPC。
  - 按会话哈希分到 256 个虚拟分区；写入器持有分区租约（带围栏号），交接完成后再写。
  - 会话行锁保留作为保险。
- **批量**：放宽持久事件的提交节奏（§5.8），多个会话的事件合批写入。
  - **合批调用的并发。** 网关同时在途的合批调用数随后端 apiserver 的数量变：`LINK_INTERNAL_API_URLS` 里每个 apiserver 最多 `LINK_EVENT_MERGE_CALLS_PER_BACKEND` 个（默认 4，可设 1–8）。所以一个 apiserver 时是 4 个，和以前一样；4 个 apiserver 时是 16 个。新的调用发给在途最少的 apiserver。刚拨不通的 apiserver 先跳过，它的份额也不借给别的 apiserver，所以没有哪个 apiserver 超过自己的份额。上限是 8，因为一个合批调用在整个事务期间占着 apiserver 的一条数据库连接，一个 apiserver 只有 10 条（pg 连接池的默认值），心跳和其他调用也要用。
  - **事务里的语句。** 合批事务里每条语句是一个来回，每个来回都要等 apiserver 的事件循环空下来才发下一条。C2b 测得合批事务约 72% 的时间耗在这种等待上，数据库处于 idle in transaction。所以各批次的 tool_call 写入、结果回写、审批卡回收、启动行回读，各合成整个调用一条语句；会话行的更新按写的列分组，每组一条；run_event 本来就是一条。语句数因此不随批次数增长。单个批次单独入库时（HTTPS，或合批调用退回的批次），语句和以前一样。
  - **实测**（2026-10-28，HPC）。基准测试里，一个 64 批的合批调用，事务里的语句从 185 条降到 14 条。apiserver 的事件循环一半以上时间在忙别的时，事务持锁时间从约 180–210 ms 降到约 45–50 ms。单个 apiserver 的入库从每秒约 1,400 批升到约 2,900–3,500 批。小规模压测用 2,000 条连接，每个 apiserver 限 0.5 核。入库从 1 个 apiserver 的每秒 2,681 条事件，升到 2 个的 5,821 条、4 个的 6,995 条。到 4 个时，瓶颈已经转到数据库。

### 6.7 去掉逐条的 pg_notify

- 实时流改走 NATS。
- 持久事件的跨副本通知，改为写入器提交后按会话发布一次，不再逐条 NOTIFY。

---

## 7. runner 端

- **链路客户端**：拨号时遵循 `HTTPS_PROXY`；TLS；重连用带全抖动的指数退避，从 1s 起、上限 60s，并遵守 `Close.retry_after`；支持续传。
- **`doVia` 改走链路**（`src/runner-go/transport.go:285`），所有守护进程调用随之迁移。链路模式由开关控制，默认关闭（D15）：服务端的切换开关打开、或收到 `UPGRADE_REQUIRED` 时切到链路，`Welcome` / `HeartbeatAck` 说回到 HTTP 时退回。
- **inbox poller**：claude、codex、codex app-server、kimi、opencode、antigravity 这 6 处，先收成一个公共组件，再改成由提示驱动。
- **事件流**：确认、额度、内存缓冲与落盘、seq 续接；实时流支持停发。turn 完成通知在发出之前也先写入本地暂存，重启后先补发，见 §15.8。
- **心跳**：改用事实哈希。
- **自更新**：`Welcome` 和 `HeartbeatAck` 下发指定版本；二进制仍从 `/dl` 下载并校验摘要（现有逻辑）。
- **`orbit doctor`**：检查链路连通性、TLS、代理、RTT，并明确报告"WebSocket 被代理拦截"。

---

## 8. 安全

- 链路入口和 Web 源站分开部署；Web 源站只放行 Cloudflare 的 IP 段。
- TLS 证书用 ACME 自动续期。连接令牌有效期短、可以吊销；升级前先验签；每台 runner 的连接数有上限。
- 网关只做粗粒度的租户检查。会话归属仍由后端每个处理器自己校验，和现在一样。

---

## 9. 容量（每单元 1 万用户，高峰）

| 项 | 每单元 | 说明 |
|---|---|---|
| runner 连接 | 1.5 万 | 3 个网关节点；平时每个节点 5 千条，坏一个节点时每个 7.5 千条 |
| 心跳 | 约 500 次/秒 | 只写在线状态表；标记置位时才查库 |
| 提示 + 取消息 | 每秒几十到一百次 | 随 turn 的开始和结束而定 |
| 持久事件 | 约 2 千条/秒 | 合批后每秒几十个事务 |
| 实时增量 | 产生约 15 万条/秒，只在有人看时转发后约 1 万条/秒 | 每条约 100 字节 |
| 上行带宽 | 每秒几 MB | 大块数据不走连接 |

apiserver 进程数和数据库规格按 C2b 在单元规模上的实测补齐（之前是 O3 的推算），见 §15.3。

---

## 10. 故障模式

| 故障 | 应对 |
|---|---|
| 网关节点宕机 | runner 带全抖动退避，重连到其他节点并续传；断线的那一批 runner 不因静默被回收（§6.5），避免误判 |
| 后端发布或宕机 | 网关重试幂等请求，runner 不断线 |
| 后端变慢（答心跳超过 runner 原来的 15 秒） | runner 不断线，心跳不堆积，在线状态照常刷新；连接死活只看 ping，40 秒内发现死掉的传输（§15.13） |
| NATS 故障 | 提示和实时流降级，由心跳兜底；持久事件不受影响 |
| Postgres 主库切换 | 写库返回可重试错误，runner 先缓冲在内存、满了落盘；在线状态有宽限期，配合大面积断线时的保护（§6.5）；主备切换不能丢已确认的提交，见 §15.5 |
| 在线状态写入异常 | reaper 暂停 |
| 在途响应丢失 | 带同一个 `request_id` 重发，拿回同一个结果 |
| 大量 runner 同时重连 | 全抖动退避 + 网关握手限速；`Welcome` 直接带上"有活的会话列表"，避免每个会话都去查一遍 |
| 单个会话刷屏 | 按会话和租户限额，进度事件合并，超出额度就降级 |
| runner 主循环卡死 | 心跳停了，按正常离线流程处理 |

---

## 11. 切换计划

### 11.1 前置条件

- **在现有协议里先加一个"暂停派发"开关。** 打开后，领会话和取新消息都不再返回内容；中断和结束仍然下发；正在运行的 turn 照常完成；新消息在服务端排队。
- **准备 staging 环境，做故障演练：**
  - 杀网关、杀 API；
  - 数据库主备切换；
  - 断网；
  - 自更新 `exec` 时正好撞上运行中的 turn；
  - 模拟 1.5 万台 runner 同时重连。

### 11.2 影子期（1–2 周，D7）

> **历史：影子期已在 2026-11-05 的切换后结束，它的代码已删除（§13）。** runner 的影子连接由切换后清理删除（§15.11）；网关的镜像比对、读切换开关的轮询、`LINK_MODE` 和 `MODE_HTTP` 的连接由 34sSqSNx9BHCECKDNblLr 删除（§15.12）。下面是当时的计划和通过标准。

- **过渡版 runner。** 工作仍走 HTTP。另起一个隔离的协程，只做握手和心跳，并把心跳和事件镜像到链路上；网关只解码比对，不落库、不派发。
- **影子协程必须和工作路径隔离。** 用独立的客户端、有资源上限、任何错误都只记日志，不能影响工作路径。
- **通过标准（先定好，再测）：**
  - 连接在线时间占比 ≥ 99.9%；
  - 重连 p99 < 30 秒；
  - 网关零崩溃，握手失败率 < 0.1%；
  - 心跳和事件镜像解码比对零差异；
  - runner 的内存和协程数保持平稳；
  - 期间至少做一次网关发布（逐步断开）和一次证书轮换，都没有异常。
- **顺带实测网络。** 测出各 runner 所在网络到候选机房的 RTT，据此确定单元放在哪个机房。

### 11.3 切换步骤（D4、D8）

按 D15，切换前所有代码都已分批合入 main 并部署：服务端同时提供 HTTP 和链路两套入口，runner 是支持链路模式、但默认关闭的版本。切换本身是翻开关：

1. 确认生产上的 runner 都已是支持链路模式的版本；切换步骤先在 staging 复验。
2. 打开"暂停派发"，等所有正在运行的 turn、集成任务、merge/commit 跑完（D8）。看板上列出剩余项和各自已运行的时长。
3. 打开服务端切换开关 `RUNNER_LINK_REQUIRED` 并部署。全部旧守护进程路由（当前 49 个）统一返回 `UPGRADE_REQUIRED`。实现上开关是运行时的，用 `PUT /api/admin/runner-link-required` 打开，1 秒内生效，不用部署；返回 `UPGRADE_REQUIRED` 的是 47 个，见 §15.1、§15.9。
4. runner 的处理：
   - 支持链路的 runner 收到 `UPGRADE_REQUIRED` 后，立即切到链路模式；
   - 还不支持的版本会触发自更新，升级后再切换。自更新最长等 10 分钟，此时没有 turn 在跑，`updateWhenNoTurnInFlight` 不会拦住；也可以手动执行 `orbit upgrade`。
5. runner 建立链路、接管会话；然后关闭"暂停派发"，排队的消息开始投递。
6. 观察 1 小时：连接数、确认延迟、错误率、会话恢复情况。

`Welcome` 和 `HeartbeatAck` 都带当前模式。开关关上时，runner 自动退回 HTTP 模式。（历史：开关和退回都已删除，网关只说 `MODE_LINK`，见 §15.11、§15.12。）

### 11.4 回滚

> **历史：切换后清理之后不再适用（§13、§15.11）。** 切换开关和 runner 的 HTTP 工作路径都已删除：服务端不再读 `runner_link_switch`，守护进程路由对 HTTPS 一律回 426；runner 没有 HTTP 工作路径，`Welcome` 说 `MODE_HTTP` 时留在链路上等，不退回。所以“关闭切换开关”这条退路已经没有了，下面写的只适用于清理之前的版本。清理之后的退路是服务端版本回滚，见 §15.11。
>
> 复验时测到的（34s3o06uFqPEpYxniDlvC，报告文件 34s7Y4wL3cApo6EmztEty；staging 上的真实栈 f8b9964f3，两台 0.1.245 的真实 runner）：网关正常时，关开关后 runner 在 3.6–30.2 秒内退回 HTTPS（5 次）；网关停着时关开关，300 秒内一台也没有退回。runner 只从网关的 `Welcome` / `HeartbeatAck` 得知开关已关，HTTPS 被拒之后它不会自己再试 HTTPS，所以关开关要让 runner 回到 HTTPS，必须有一个在运行、连得上 runner 的网关；网关起不来时，只能重启 runner 进程。

- **首选：关闭切换开关。** 旧路由恢复，runner 按 `Welcome` / `HeartbeatAck` 里的模式退回 HTTP。开关是运行时的，用 `PUT /api/admin/runner-link-required` 关，1 秒内生效，不用部署，见 §15.1。
  - **有多个 apiserver 时，关开关之前先让会话流都回到第一个 apiserver。** 退回 HTTPS 的 runner 把增量发到第一个 apiserver，只有那个进程上的流看得到（§15.3）。二选一：从 `docker-compose.override.yml` 去掉 web 网关挂载 `gateway/several-apiservers/` 的那一行，执行 `docker compose up -d gateway`；或者停掉多出来的 apiserver（`docker compose stop apiserver-2` 等）。然后再关开关。见 [self-hosting.md 的 "Several apiservers"](./self-hosting.md#several-apiservers)。
- **第二道退路：版本回滚。** 服务端回到 vN-1，`/runner/release` 指定 vN-1 并标记回滚（`src/runner-go/selfupdate.go:420`），runner 降级后重新走 HTTP。
- 两种回滚都要在 staging 完整演练一次。

runner 本地的两种暂存，回滚和降级时这样处理：

- **持久事件暂存（`~/.orbit/link-spool`；设了 `ORBIT_HOME` 的 runner 在 `$ORBIT_HOME/link-spool`，下同）。** 链路模式的 runner 停止时，未确认的持久事件留在暂存里。从 34mumXbJjOvZUwNmDNzmY 起，runner 接管会话时不论链路模式还是 HTTPS 模式（包括 `ORBIT_LINK_MODE=off`），都先按原 seq 把暂存发出去，发完再产生新事件，并从“服务端 MaxSeq 和暂存最大 seq 中较大的那个”加 1 编号。关闭切换开关（首选回滚）不需要额外步骤：停止时如果链路不通、HTTPS 没被拒，runner 在停止的宽限时间内改走 HTTPS 发完，发不完的留在暂存，由下一个进程先发。

**版本回滚：降级到没有 B8 的 runner 版本之前，先确认暂存为空。** 旧版本读不了暂存，会从服务端 MaxSeq+1 编号，占掉暂存事件的 seq；有 B8、但早于 34mumXbJjOvZUwNmDNzmY 的版本，在关了链路模式（`ORBIT_LINK_MODE=off`，或 config.json 里的 `"linkMode": "off"`）的 runner 上也是这样。这些事件以后存不进去：服务端只记错误日志，并计入 `orbit_run_event_seq_conflicts_total`（§15.7）。暂存超过 72 小时没动过，有 B8 的 runner 进程启动后会把它删掉；vN 删之前按会话在 runner 日志里写明条数和 seq 范围。顺序：先关切换开关，让 runner 继续以 vN 跑 HTTPS；在每台 runner 上确认 `find ~/.orbit/link-spool -name '*.jsonl' | wc -l` 为 0，不为 0 时子目录名就是会话 id（UUID 形式），给这些会话各发一条消息，让 runner 接管它，暂存先发；全部为 0 后，再让 `/runner/release` 指定 vN-1。降级后才发现暂存不为空：不要删暂存，先让这台 runner 回到 vN，接管会话时暂存先发；旧版本占掉的 seq 上的事件已无法恢复，看服务端的冲突日志确认丢了哪些。

- **turn 完成通知的暂存（`~/.orbit/link-spool/<会话 id>/turn-complete-<turn id>.json`）。** 从 34mwBTpOPo3S9LM2SXs10 起，runner 发出一个 turn 的完成通知之前，先把它写进会话的暂存目录，控制面应答后删除；只有 runner 停止或被杀时还没拿到应答，才留给下一个进程（§15.8）。下一个进程启动时接管名下所有未结束的会话，在会话的暂存事件存完之后、第一次取消息之前，以自己的租约补发留下的完成通知，所以已经结束的 turn 不会再交给引擎。链路模式和 HTTPS 模式（包括 `ORBIT_LINK_MODE=off`）都这样。同一任务还让空闲会话的暂存事件在 runner 启动时就发出，不再等下一次领取。关闭切换开关不需要额外步骤：停止时如果链路不通、HTTPS 没被拒，完成通知和暂存事件一样在停止的宽限时间内改走 HTTPS，没拿到应答的留给下一个进程补发。

**版本回滚：降级到不含 34mwBTpOPo3S9LM2SXs10 的 runner 版本之前，还要确认没有留下的完成通知，事件暂存也要为空。** 旧版本不读这些文件：完成通知丢了、服务端仍认为在执行的 turn，会带着续写重新交给引擎，引擎在已经结束的 turn 上再做一遍。事件不丢，但会重复执行：多耗额度，用户看到第二段回答，还可能在工作区里重复操作。这些版本也还有 34mwBTpOPo3S9LM2SXs10 修掉的两条暂存丢失途径：空闲会话的暂存要等下一次被领取才发，超过 72 小时没动过就会在 runner 进程启动时被删掉；暂存分段在发送途中被强杀，这一段就丢了。所以降级到这些版本时，即使是有 B8、没关链路模式的版本，也按上面的顺序先让事件暂存为空，再在每台 runner 上确认 `find ~/.orbit/link-spool -name 'turn-complete-*.json' | wc -l` 为 0；不为 0 时子目录名同样是会话 id，给这些会话各发一条消息，让 runner 接管它，先补发完成通知。降级后才发现不为 0：旧版本已经重新交给引擎的 turn 无法撤回；文件不用删，回到 vN 后补发的完成通知对已经结束的 turn 不起作用。

### 11.5 自托管用户

- **升级服务端就等于强制升级 runner。** 开着自更新的 runner 会自动升级；关了自更新的会看到 `UPGRADE_REQUIRED` 提示，需要手动执行 `orbit upgrade`。0.1.237 及以后的 runner 不用升级就能走链路。
- **默认安装和 `/upgrade` 会把链路带上，自托管用户不用做任何事：** 不新开域名或端口，不用证书，不改防火墙（§15.10）。docker-compose 里的网关和 NATS 由它们打开。只有想给链路单独一个域名的部署，才按 [self-hosting.md 的 "A link gateway of its own"](./self-hosting.md#a-link-gateway-of-its-own) 配。

---

## 12. 工作拆分（人日为粗估）

| 模块 | 内容 | 人日 |
|---|---|---|
| 协议 | proto 定义、buf CI、双端代码生成 | 3–5 |
| 网关 | TLS、WebSocket、验签、优先级队列、提示订阅、RPC 与事件转发、额度、逐步断开、指标 | 12–18 |
| 服务端 | 连接令牌、定向提示、长轮询改为立即返回、`request_id` 幂等、`after_seq`、`Welcome` 摘要、在线状态表及读取改造、大面积断线时暂停回收、暂停派发开关、旧路由下线 | 12–18 |
| 事件 | 网关直接调用入库、提交节奏、确认与拒收、实时流、中途取半截文本、去掉逐条 `pg_notify` | 8–12 |
| runner | 链路客户端（代理、重连、续传）、`doVia` 改走链路、inbox poller 合并后改为提示驱动、事件流与落盘、实时流、心跳、`orbit doctor` | 18–25 |
| 运维 | 四层入口、证书、NATS、docker-compose（自托管）、监控面板 | 5–8 |
| 影子期与切换 | staging、影子协程、演练、runbook、自托管发布说明 | 6–10 |
| 切换开关 | 服务端 `RUNNER_LINK_REQUIRED`、旧路由返回 `UPGRADE_REQUIRED`、runner 收到后切换模式、模式随服务端开关退回 | 2–4 |
| 切换后清理 | 见 §13 | 5–10 |

合计约 70–105 人日，风险主要集中在 runner 和网关。

---

## 13. 切换后清理

已完成（D2，34bsPmWGZjo7CPt4BFI5G）。删了什么、留下了什么以及为什么留，见 §15.11。原计划：

- 删除服务端 14 处 `runnerSupportsCapability` 能力判断、旧式轮询的兼容分支、旧的 `/complete` 路由、写入契约摘要 header、长轮询相关的代码和常量（包括 `/runner/wake`）。
- 删除影子期代码。
- 删除切换开关和 runner 的 HTTP 工作路径（D15）。

---

## 14. 风险

| 风险 | 缓解 |
|---|---|
| 没有退路（D4）：链路的缺陷会让所有 runner 同时停工 | 影子期、staging 故障演练、完整回滚演练 |
| 公司代理会掐断 WebSocket 的用户用不了自托管 runner（D6） | `orbit doctor` 明确报告原因 |
| 排空时间不可控（D8）：长 turn 会拉长切换窗口 | 选低峰时段，提前打开"暂停派发" |
| UNLOGGED 表在故障后被清空 | 启动宽限期 + 大面积断线时暂停回收 |
| 跨境网络质量 | 影子期实测后再定机房 |
| runner 首次引入外部 Go 依赖（protobuf、WebSocket 库） | 按 [dependency-security.md](./dependency-security.md) 审查 |

---

## 15. 实现与设计的差异

下面各条是实现落地后，和上文设计不一样或设计里没写到的地方，每条注明出处任务，并按项目分支 4a493f6b8（2026-10-27）上的代码核对过。正文相关的地方有一句指向这里；两处说法不一致时，以本节为准。

### 15.1 `RUNNER_LINK_REQUIRED` 是运行时开关

> 历史：开关已在切换后清理中删除，见 §15.11；网关读开关的轮询和 `LINK_MODE` 的删除见 §15.12。

出处：D0（34lqlVVjIXZRmKyCWzATR）。涉及 D15、§11.3、§11.4。

- 开关是数据库里的一行（表 `runner_link_switch`，迁移 0446），不是部署时设的环境变量。登录的管理员用 `GET` / `PUT /api/admin/runner-link-required` 查询和翻转（不接受访问令牌），不用重新构建，也不用重启或部署。
- 1 秒内生效：处理 `PUT` 的 apiserver 进程立即按新值应答，其他进程最多 1 秒后重读。网关每秒读一次 `GET /api/runner/link/mode`，之后的 `Welcome` 和每个 `HeartbeatAck` 都带新模式：连着网关的 runner（包括影子连接）在下一次心跳时得知；打开时，走 HTTPS 的 runner 也会在下一次守护进程调用被拒时得知。
- 打开后的头一秒，网关可能还没读到开关（34mBMr1Oe3xzjTGfM92t0）。apiserver 一打开就拒绝 HTTPS，这时被拒的 runner 连上网关，`Welcome` 说的还是 `MODE_HTTP`；C3 的演练里见过一次，runner 因此退回 HTTPS，5 秒后下一次调用被拒才回到链路。现在被拒后不到 2 秒（`src/runner-go/link_mode.go` 的 `linkModeReadLag`）、还没有网关对它说过 `MODE_LINK` 时的 `MODE_HTTP`，runner 不当作开关已关：`Welcome` 从 runner 发起这条连接时算（网关接受升级时定下连接的模式），其他从收到时算。守护进程调用留在链路上等，被拒满 2 秒时再连，这时网关已读到开关，被拒的那次调用改走链路完成。切换时，第一次被拒落在这一秒里的 runner 在日志里写 `runner link: the Welcome of <连接> said MODE_HTTP less than 2s after the control plane answered <调用> with UPGRADE_REQUIRED, so its gateway, which reads RUNNER_LINK_REQUIRED every second, may not have read it yet; daemon calls stay on the runner link, and its next connection opens in <多久>`，网关上多一条刚欢迎就被 runner 关掉的 `MODE_HTTP` 连接。关开关不受影响：网关对 runner 说过 `MODE_LINK` 之后（在链路上工作的 runner 都是），它说的 `MODE_HTTP` 立即生效；只有开关在网关读到之前又关上，runner 才在被拒 2 秒后退回 HTTPS。
- 读不到时保持上一次的值：数据库或路由不可用时，各 apiserver 进程和网关都按上一次读到的值应答，不来回切换。进程启动后还没读到过时，按关闭处理（网关告诉 runner `MODE_HTTP`）。
- 打开时，runner-api 主控制器的 52 个路由（2026-10-25 统计为 49 个，2026-10-28 又挪进来 3 个，见 §15.9）里，47 个守护进程路由对 HTTPS 调用返回 426 `UPGRADE_REQUIRED`，并提示执行 `orbit upgrade`；注册的 3 个（register、device/start、device/poll）和附件的 2 个按 D14 留在 HTTPS，照常应答。§11.3 第 3 步说"全部旧守护进程路由（当前 49 个）"统一返回 `UPGRADE_REQUIRED`，实际返回的是这 47 个。带 `X-Orbit-Runner-Caller` 标记的调用（`orbit mcp`、Antigravity 审批钩子、CLI 命令）也照常处理，守护进程从不带这个标记。
- 网关的 `LINK_MODE=link` 会不看开关，一直告诉 runner `MODE_LINK`。生产网关要保持默认的 `http`（跟随开关），否则关开关时 runner 不会退回 HTTP。

### 15.2 大载荷没有按引用传输

出处：B8（34bsPlVgY066plLgvdROj），以及协调者 2026-10-25 在 B8 上的评论。涉及 §5.10。

- §5.10 说超过约 64KB 的工具输出不进链路、事件里只放引用、引用格式在 v1 定下。这没有实现，proto 的 `Event` 也没有引用字段。
- B8 的临时做法（`src/runner-go/link_events.go`、`src/runner-go/link_events_kind.go`）：
  - 一个 `EventBatch` 最多 500 条事件、payload 合计不超过 1 MiB；单条超过 1 MiB 的事件单独成批。编码后超过 256 KiB 的帧照 §5.3 用 `Chunk` 分块传输。
  - 只有单独成批后帧仍超过链路上限（分块拼接后的帧最大 8 MiB，留 64 KiB 余量）的事件才截断：保留 seq、类型、turn 和不超过 4 KiB 的顶层字段，加上 `omittedBytes`（原 payload 的字节数）和 `omittedFields`（去掉的字段名）。每次截断都写 runner 日志并累计计数。
- 和 HTTPS 的差别：HTTPS 的事件上报请求体上限是 10 MB（`src/apiserver/src/main.ts`），payload 在链路上限和 10 MB 之间的事件，经 HTTPS 能完整保存，经链路会丢掉大字段的内容。
- 按引用传输留给后续任务：经 HTTPS 的附件接口上传（D14），入库时解析引用，或在 proto 里加引用字段、读取时解析。它不是 D1 的前置，除非账号所有者另有决定。

### 15.3 单元规格

出处：C2b（34m88i6i8CQeU4dSuw7HM）2026-10-31 在单元规模上的实测，和按同一台机器上测得的每种操作开销做的推算（任务评论 "C2b 证据 12" 到 "C2b 证据 30"，下面写作证据 N）。在它之前是 O3（34m88i2iPbDw1OpBHttrn）用五分之一负载做的推算：4 个 apiserver、数据库 8 核。实测、推算和怎么重做见 [scripts/runner-link/README.md](../scripts/runner-link/README.md#re-testing-at-cell-scale-task-c2b) 的 "Re-testing at cell scale"，运维文档见 [self-hosting.md](./self-hosting.md#the-cells-size) 的 "The cell's size"。涉及 §9。

§9 只写了网关节点数。按 §9 的高峰负载（1.5 万条连接、约 500 次/秒心跳、约 2 千条/秒持久事件、转发后约 1 万条/秒实时增量），每个单元：

- **链路网关**：3 个节点，每个 2 核 4 GB，前面是四层负载均衡。推算：坏一个节点时每个节点 7,500 条连接，占 1.12 GiB；全单元 1.46 核（证据 23）。实测只有一个节点，带全部 1.5 万条连接：均值 0.79 核、2,298 MiB，带实时流时 1.54 核（证据 24、27）。
- **apiserver**：6 个进程，每个 2 GB。实测：带单元级实时流时，每个进程主线程的 10 秒峰值 0.490–0.518（证据 29）；不带时 0.332–0.372（证据 26）；每个进程内存不到 600 MiB（证据 25、28）。推算：高峰时每个主线程 52% 忙，坏一个进程时 62%（证据 23）。
- **数据库**：11 核、32 GB 内存、独占的高速磁盘。实测：判定运行整小时的 10 秒峰值 5.85 核，占 11 核的 53.2%，落在 `run_event` 的 autovacuum 里，vacuum 窗口外 43.4%（证据 26）；带实时流的那一小时 50.3%（证据 29）。同样的 5.85 核按原来的 8 核算是 73.1%。推算：均值 4.17 核，10 秒峰值 6.26 核（证据 23）。
  - 压测栈的数据库容器只有 16 GiB 内存，两小时里一直顶在这个上限上：页缓存反复被逐出再读回，没有 OOM，CPU 也在标准以内（证据 26、29）。32 GB 是 O3 的推算，没有实测。
- **NATS**：1 个节点，1 核。实测带实时流时 0.34 核（证据 28），推算 0.31 核。

实测的条件（证据 24–29）：GCE c2d-standard-56（AMD EPYC 7B13，56 vCPU），整个压测栈和 loadgen 在这一台机器上，一个网关节点带全部连接；代码是项目分支 f6a150f07（含 apiserver 的 keep-alive 修复）；没有清库（开始时 `run_event` 约 1,979 万行），autovacuum 没调；心跳 11.4% 全量对账（`-volatile`，生产里会变的上报按生产的频率变），不是 O3 估的生产 25%。推算用的开销是 736f80245 上 4 个 apiserver、数据库 8 核时测的，输入在 `scripts/runner-link/cell-inputs.json`；只有每条实时增量的开销在 6 个 apiserver 上重测过，0.0999 ms（证据 29）。

为什么从 4 + 8 改成 6 + 11：同一台机器上，4 个 apiserver 带单元级实时流时主线程 10 秒峰值 0.626–0.637，超过 60%；数据库 8 核时，判定运行的峰值 57.4%，带实时流时 66.8%（证据 17、23）。协调者 2026-10-31 按证据 23 的推算改成 6 + 11，重跑的两小时实测的就是这个规格。

没有测的：三个网关节点的单元；库继续长大、每次 autovacuum 更长更重之后峰值怎么变（判定运行开始时 `run_event` 约 1,979 万行，证据 26）；人的请求（web 和 app）；生产的全量对账占比。网关重启后的重连只在 4 + 8、修复前的 736f80245 上测过（证据 20）。

另外：

- 起多个 apiserver 的做法见 [self-hosting.md 的 "Several apiservers"](./self-hosting.md#several-apiservers)：在 `docker-compose.override.yml` 里加 `apiserver-2` 等；链路网关的 `LINK_INTERNAL_API_URLS` 列出全部 apiserver；web 网关挂载 `gateway/several-apiservers/` 后，会话流和 link-token 分到所有 apiserver，人的其余请求仍只到第一个。
- 多个 apiserver 上生产之前，要先完成下面的前置。2026-10-28 时 (a)、(b)、(c)、(d) 和 34nb3xgCijTDzQJVXDVT7 已在项目分支落地，(f) 随 34njIJN86oqVMVzqtaPQ4 落地，(g) 随 34o01B4w5NYAczPEChHz2 落地，(e) 还没有完成；全部完成之前，多个 apiserver 只用于压测和 staging。
  - (a) 34mNe88onMT6k23kHz7ce：reaper、任务定时扫描和自动重试同一时刻只在一个进程上跑；心跳写入失败的保护所有进程都看得到。已落地：任务分支 703e3dd52 由合并提交 54a61ed32 合入项目分支。
  - (b) 34mNe8DOyUq2wlk81EGlZ：Antigravity 的登录码和 Cursor 的密钥检查，不管心跳落在哪个进程都能送到 runner。已落地：4752cf40e 到 3c04ae110 这 5 个提交，项目分支从 3a001854e 前进到 3c04ae110。
  - (c) 34mNe8H0YZ4Qkwd0t6jPJ：默认升级流程同时重建 apiserver 副本。已落地：任务分支 34eff2714（改动在 0707981e1）由合并提交 43fd969a9 合入项目分支。
  - (d) 34nb3xlT50n4F2ALdUAtB：会话总结、iOS 审批提醒和通知限频跨进程有效。已落地：任务分支 c14937af8 由合并提交 15179a12c 合入项目分支。
  - 34nb3xgCijTDzQJVXDVT7：会话实时流和 link-token 签发分散到所有 apiserver，见下一条。已落地：任务分支 1d6c5a10a 由合并提交 e8fae2b28 合入项目分支。
  - (e) `RUNNER_LINK_REQUIRED` 已打开，runner 都经链路工作。原因见下一条的“限制”。
  - (f) 34njIJN86oqVMVzqtaPQ4：别的进程入库的持久事件，读回失败时不丢。一批事件太大、通知里放不下时，通知只带 seq 范围，持有会话流的 apiserver 从 run_event 把它读回来（`realtime.service.ts` 的 `readBack`）。
    - 读回失败时，隔 250 ms、1 s、3 s 再读，最多读 4 次；从收到通知算起最多等 10 s。
    - 读回完成之前，这个会话在本进程后到的事件（别的进程的通知，以及本进程自己入库的）都排在它后面，所以流收到的 seq 是按顺序的。
    - 每次失败记一行日志，写会话、seq 范围和错误，不写事件内容。
    - 放弃时，给本进程这个会话的流发 `resync`：web、iOS/macOS、Android 收到后都丢掉已载入的窗口，重取一页 tail，再从它最新的 seq 接着连。同时在本进程发一条只在本地的 session_updated，owner 的列表行从库里重建摘要。排在后面还没读的读回不再去读，客户端重新拉取时会一并拿到。
    - 只有一个 apiserver 时，进程不读回自己入库的批次，行为不变。
    - apiserver 的 LISTEN 连接断开后要 2 秒才重连，这期间别的进程发来的通知它收不到，那几批事件同样到不了它的流：由 (g) 补上。
  - (g) 34o01B4w5NYAczPEChHz2：LISTEN 连接断开期间漏掉的通知，重连后补发 resync。由 (f) 发现：这期间别的进程发来的 NOTIFY 收不到，PostgreSQL 也不留，那几批持久事件到不了本进程的流（`realtime.service.ts` 的 `listenerBack`）。
    - 重连成功后，查 `apiserver_process`：断开期间或断开前 30 秒内有别的进程写过自己那一行，就算期间有别的 apiserver 在跑。有的话，给本进程所有开着流的会话各发一条 `resync`，并在本进程发一条只在本地的 session_updated，和 (f) 放弃读回时一样。读不到 `apiserver_process` 时也照发：多拉一页 tail 的代价，比悄悄漏掉几批事件小。
    - 只有一个 apiserver 时，进程自己的事件不经 NOTIFY 交给自己的流，什么也没漏，什么也不发，行为不变。
    - 记一行日志，写断开了多久、补发给了多少个会话，不写事件内容。
    - 数据库重启会让所有 apiserver 的 LISTEN 连接同时断开，所以之后几秒内单元里所有的流都要重新拉取，每条流一页 tail；第一个 apiserver 上，每个 owner 的控制流还会收到这些会话从库里重建的列表行。没有按单元规模测过。
    - inbox 和 wake 的通知漏掉了不用补。走 HTTPS 时，inbox 长轮询最多 5 秒自己再查一次库；wake 漏了，runner 等下一次心跳（30 秒内），和原来丢一次唤醒一样。走链路时，发起的 apiserver 自己经 NATS 提示 runner，不经 LISTEN。
    - 走链路时，事务里写的唤醒（`notifyRunnerWakeOnCommit`：排队的落地、晋升检查、wiki 仓库操作）由每个收到通知的 apiserver 各自标记 runner，只断一个 apiserver 的 LISTEN 不影响。所有 apiserver 同时漏掉时（例如数据库重启），runner 在下一次完整对账时拿到，最多晚 5 分钟，和改动计数没写成时一样。只有一个 apiserver 时现在也是这样，不是多 apiserver 的前置。
    - 还没覆盖的：本进程没有流的会话，owner 的列表行不重建。别的 apiserver 在这几秒里改了这些会话，列表要等这个会话下一次变化，或者重新加载时才更新。
- 已定：会话实时流分散到所有 apiserver，link-token 签发也分散。协调者 2026-10-28 根据 C2b（34m88i6i8CQeU4dSuw7HM）的实测定下，34nb3xgCijTDzQJVXDVT7 实现。
  - **依据（C2b 证据 9、11，单元规模，4 个 apiserver）。**
    - 会话流都在第一个 apiserver 上、实时增量按单元速率（每秒 1 万条）时：第一个 apiserver 的主线程均值 0.976（10 秒峰值 0.997），另外三个 0.38–0.39。增量照样全部送达，但同一进程上的其他工作被挤掉。
    - link-token 只由第一个进程签发，超时 9,768 次，连接只连上 6,020 条（目标 1.5 万）；心跳确认 p99 60 秒。
    - 按 O3 的规则（峰值时主线程不超过 60%），只在第一个进程上放不下，加进程也分不掉。
    - 网关发布式重启（drain）时 runner 集中重签 link-token，web 网关出了 968 个 502、4,572 个 499。查清是压测工具造成的，见下面的“drain 时的重签”。
  - **做法：web 网关的两条路由，多 apiserver 的部署才挂载。**
    - 路由在 `gateway/several-apiservers/` 的两个文件里。`gateway/nginx.conf` 只加了两条 include，用 glob 引用这两个文件；没挂载这个目录时什么也不匹配，所有请求照旧到第一个 apiserver。部署在 `docker-compose.override.yml` 里给 web 网关挂上这个目录才启用。
    - 会话流（`GET /api/sessions/:id/events`）按地址里的会话 id 做 hash，分到所有 apiserver；link-token（`POST /api/runner/link-token`）给在途请求最少的 apiserver（`least_conn`）。人的其余请求照旧到第一个，因为 Codex 的 "Sign in with ChatGPT" 在发起它的进程里跑。
    - 所有 apiserver 用同一个网络别名 `orbit-apiservers`：`docker-compose.yml` 给 apiserver 加上，`apiserver-2` 等 extends 时一起继承。nginx 的 upstream 用 `resolve` 每 10 秒重新解析这个名字，apiserver 重建或增减时自动跟上。
    - 用不带 `consistent` 的 `hash`：nginx 的一致性哈希按 server 的名字放点，同一个名字解析出的几个地址共用这些点，结果是轮流使用，同一个会话的流会落到不同进程上（实测 nginx 1.31.6）。普通 hash 按地址在列表里的位置选，apiserver 集合不变时，同一个会话的流始终落在同一个进程；集合变化时，一部分会话在下次重连时换进程，已经开着的流不动。
    - 一个 apiserver 停掉时，它上面的流断开，客户端重连：web 网关连它 2 秒不通就转到别的进程（`proxy_connect_timeout`），之后 10 秒不再选它，其间重新解析也会去掉它。客户端带着最后收到的持久事件的 seq（sinceSeq）重连，补上缺的，增量接着送达。
    - 观看人数：每个进程只为本进程有流的会话订阅 `ses.<id>.live`，并以自己的实例名报各自的人数（变化时发 WatchersHint，非零的每 20 秒重发；心跳应答里带本进程的人数），链路网关按实例相加。停掉的进程的人数 60 秒后过期（WatchersTTL）；其间多算的人数只会让 runner 多发一会儿增量。
  - **为什么默认配置不用 `resolve`。** upstream 的 `resolve` 是 nginx 1.27.3 才有的。部署沿用第一次拉下来的 `nginx:alpine`，升级默认不刷新基础镜像（`/upgrade` 要加 `--pull-base`），所以可能早于 1.27.3；而 nginx 读不了配置就起不来，网关整个不可用。所以默认的 `gateway/nginx.conf` 不用它，任何版本都能加载（实测 nginx 1.25.5），要求只落在挂载 `gateway/several-apiservers/` 的部署上：挂载前用 `docker compose exec gateway nginx -v` 确认版本，旧的先 `docker compose pull gateway`。1.25.5 加载这两个文件会报 `"resolver" directive is not allowed here`，起不来。
  - **限制：只用于链路承载 runner 工作的单元，即前置 (e)。** 走 HTTPS 的 runner 把增量发到第一个 apiserver（经 web 网关），那个进程只交给自己的流，不经 NOTIFY 转给别的进程（§6.7）。会话流落在别的 apiserver 上时，这个 runner 的回答只在每条消息存进去时整条出现，中途打开的流也拿不到前缀。开关打开之前网关处于影子期，不转发任何调用，多出来的 apiserver 本来也不承担 runner 的调用。关开关回滚之前，先让流都回到第一个进程，见 §11.4。
  - **HPC 上的小规模实测（34nb3xgCijTDzQJVXDVT7）。** 4 个 apiserver，1,000 个 runner，500 个运行中会话，每秒 200 条持久事件，容器都在 P 核上，每次稳态 6 分钟。详见 [scripts/runner-link/README.md](../scripts/runner-link/README.md#several-apiservers) 的 "Several apiservers"。
    - 分散（400 个会话有人看，每秒 8,000 条增量）：会话流按 99、102、109、90 分在 4 个进程上，没有会话同时落在两个进程上；4 个主线程 0.113–0.125 核，和均值相差不到 6%；增量每秒发 8,004.9 条、收到 8,004.1 条，延迟 p99 113 ms；没有错误，流也没有漏掉持久事件。
    - 同样的负载、会话流都在第一个进程上：它的主线程 0.264 核，另外三个 0.040–0.042。4 个进程合计，分散时 0.563 核，集中时 0.462 核：一条增量的转发，分在 4 个进程上约 0.044 ms，集中在一个进程上约 0.031 ms（没有实时流时合计 0.211 核）。
    - 一个进程挂掉（每个会话两条流，apiserver-d 被 SIGKILL，2 分钟后再起来）：它上面 48 个会话的 96 条流都在另外三个进程上重开，同一个会话的两条流落在同一个进程；每条流结束后 1.1–1.4 秒收到下一条增量，从最后收到的持久事件续上，没有漏。链路网关把发给它的 26 个调用改发给别的进程，runner 没有看到错误。
  - **另外三个 apiserver 每条增量约 0.085 ms 花在哪（C2b 证据 6、9）。** 不是每个进程都收到了所有会话的增量，所以这一项没有要改的。
    - 代码：apiserver 只为本进程有流的会话订阅 `ses.<id>.live`，链路网关只在有人看时往那个主题上发；HTTPS 入库的增量也不经 NOTIFY 转给别的进程（§6.7）。
    - 实测：会话流都在第一个进程上时，NATS 每秒给它送 4,020 条消息，给另外三个 0 条。另外三个每个进程的 CPU，没有实时流时 0.052–0.053 核，第一个进程每秒转发 8,000 条增量时 0.056–0.059 核（合每条每个进程不到 0.001 ms），把第一个进程限到 0.2 核、让它饱和（65% 的周期被限流）时 0.052–0.054 核。
    - 所以在 HPC 上，另外三个进程既不做和增量有关的工作，也没有被饱和的第一个进程拖慢。C2b 那 0.085 ms 更可能来自那台机器的超线程：e2-standard-32 的 32 个 vCPU 是 16 个物理核的超线程，实时转发让主机多忙了约 1.1 核，请求组合不变时数据库多用了 32% 的执行时间，另外三个 apiserver 各多用 7.5% 的 CPU。HPC 没有超线程，这一点在这里复现不了，也没有在 C2b 那种机器上单独验证。
  - **drain 时的重签。** 真 runner 不会集中重签：`linkClient.token()`（`src/runner-go/link_client.go`，工作连接和影子连接都经过它）在 token 离过期还有 5 分钟以上时沿用原 token，drain 后的重连也一样（`TestLinkReplacesADrainedConnectionWithTheTokenInHand` 钉住这一点，runner 代码不用改）。C2b 看到的集中重签是 loadgen 造成的：它把 Drain 当成 token 续期，重连时一律重签。34nb3xgCijTDzQJVXDVT7 改了 loadgen（`src/link-gateway/cmd/loadgen/runner.go`）：drain 后的重连，token 离过期还有 `-renew-before`（5 分钟）以上就沿用。签发仍然分散，因为 runner 首次连接和约每小时一次的续期都要签发，全量发版后 runner 一起重启时，签发仍会集中。
- 数据库连接池只能用会话模式：心跳语句是命名预编译语句，不能放在事务模式的 pgbouncer 后面，见 [self-hosting.md 的 "Database connections"](./self-hosting.md#database-connections)。

### 15.4 取消息和领会话：没拿到应答就沿用原来的 request id

出处：B2b（34m2PAvGXR3zxVWiQiVAp），协调者 2026-10-26 的裁定。涉及 §5.6。

- B6 的约定是每次调用一个 `request_id`：同一次调用的重发沿用它，下一次调用换新的。一次取消息或领会话的调用最多等 35 秒。
- B2b 改了其中两处：链路上的取消息（inbox poller）和领会话（领会话循环）没拿到应答时（传输错误、超时、链路断开），下一次取消息或领会话沿用同一个 `request_id`，不论隔了多久；拿到任何应答（一条 turn 或一个会话、"没有"、拒绝）之后才换新的。服务端对同一进程用同一个 id 的重取，原样返回上次交出的那条 turn（控制指令和插话也一样）或领到的那个会话。
- 原因：应答在提交后丢失、链路又断开超过 35 秒时，换了新 id 的重取拿不回那条控制指令或插话；领会话则会让会话停在"已分给这台 runner、却没有 supervisor"的状态。
- 其他守护进程调用仍是每次调用一个 id。HTTPS 的调用不带 request id，行为不变。开关关着时，链路连续 5 分钟不可达，runner 会把工作退回 HTTPS，保留的 id 随之作废；开关打开后 HTTPS 被拒，runner 不会退回，id 能撑过任意长的断连。

### 15.5 单元数据库的主备切换不能丢已确认的提交

出处：C1a（34bsPlctk8bxiL0FMsU9S）。涉及 §10。

- runner 收到 `EventAck`（HTTPS 下是事件上报的成功应答）就丢掉自己那份事件，之后这些事件只在数据库里。异步备库接管时可能丢掉最后一刻已确认的提交，这些事件就永久丢了。
- 所以单元数据库用同步备库（`synchronous_commit = on`，并在 `synchronous_standby_names` 里写明备库），或两个备库加法定数（`ANY 1 (...)`），或切换时不丢已确认提交的托管数据库。备库要放得近：每个写事件的提交都要等它。见 [self-hosting.md 的 "The cell's size"](./self-hosting.md#the-cells-size)。
- C1a 在 staging 演练的是同步备库的切换，没有丢事件；异步备库的情形没有演练。

### 15.6 reaper 怎么认大面积断线：静默按"漏了一次心跳"计，失联按时刻认，只保护断线的那一批 runner

出处：
- 静默按"漏了一次心跳"计：B3 的修复（34mY701NpkuzCFNg9VoiV）。问题由 C1b（34bsPllNT0PRG032Ejecc）的演练发现，修复后由它复验。
- 失联按时刻认、只保护断线的那一批、断线写进数据库：34nb3xhlRA03P4rMmfcpO。问题由 C2b（34m88i6i8CQeU4dSuw7HM）的压测发现，方案经协调者 2026-10-28 批准。

涉及 §6.5、§10。

**静默按"漏了一次心跳"计（B3）**

- 最初的实现按 90 秒离线线数静默的 runner。同时断开的 runner，最后一次心跳本来就分散在一个心跳周期里，会在 30 秒内一台台越过 90 秒线；头一台越线之后、占比到 20% 之前的扫描，会把已越线 runner 的会话回收掉。C1b 隔离 10 台中的 2 台时，就有一个会话这样被回收。
- 所以 runner 超过 1.5 个心跳周期没有心跳就算静默（30 秒周期下是 45 秒，由 `RUNNER_HEARTBEAT_EVERY_MS` 推导）。分母是最近 645 秒（45 秒加 10 分钟窗口）内有过心跳的 runner，不算标记为 OFFLINE 的，也不算被管理器排空或休眠的托管 runner。现在由 `src/apiserver/src/runners/runner-presence.ts` 的 `cellLosses` 计数，原来叫 `fleetSilence`。
- C1b 在修复后复验了 10 次断线（2 次停网关节点、8 次隔离 10 台中的 2 台），都没有回收会话。

**失联按时刻认，只保护断线的那一批（34nb3xhlRA03P4rMmfcpO）**

- 问题：B3 之后，reaper 仍然只数清扫那一刻还在静默的 runner，而且只在有会话要回收时才数。
  - 网关重启后 1.5 万个 runner 按指数退避陆续重连，九成 78 秒内回来。等第一台越过 90 秒线，还在静默的已不到两成，还在退避的尾巴就被当成普通离线回收了：判定那次回收了 975 个会话，强杀网关那次 194 个。
  - 生产单元有 3 个网关节点，坏一个，它的 runner 十几秒就连到另外两个上，几乎没有 runner 漏心跳，保护根本不会启动。
- 现在（`src/apiserver/src/realtime/reaper.service.ts` 的 `massDisconnects` 和 `massDisconnectsIn`，`runner-presence.ts` 的 `cellLosses`，迁移 0450）：
  - 每台 runner 最近一次失联的时刻，在它回来以后也留着：`runner_presence.lost_at`，即失联前的最后一次心跳。两种时候记下来：网关为它新开连接时（welcome 路由）；一次链路心跳离上一次超过 45 秒时。还在静默的 runner，失联时刻就是它的最后一次心跳。
  - 启动宽限期之外，每次清扫都读一遍全单元，不管有没有会话要回收。最近 645 秒内听到过的 runner 里，下面两种情况都算一次大面积断线：两成以上在 45 秒内先后失联（已经回来的也算）；两成以上此刻静默（失联时刻分散也算）。
  - 读到的断线记进 `runner_mass_disconnect`：这一批 runner 失联前最后一次心跳所在的时间区间，以及人数。以后的清扫只会扩大区间，接手的进程过了宽限期照样读得到。每小时清掉已经保护不了任何 runner 的记录。
  - 只保护这一批：会话的 runner 因静默被判离线时，如果它的最后一次心跳落在某次断线的区间里，并且静默还不到 10 分 45 秒（45 秒加 10 分钟窗口），就不回收。不在区间里的 runner（断线前后独自坏掉的那台）照旧在静默满 5 分钟后回收（见本节最后一段）。一直不回来的，静默满 10 分 45 秒后的下一次清扫回收。
  - 日志：一次断线第一次被看到、以及区间扩大或人数增加时，各写一行（人数、区间）。某次清扫因为某一批断线不回收时，这一批写一行：会话 id（最多列 10 个）、这批断线的区间和人数。不是每个会话一行。
  - 不变的：单台 runner 失联照旧回收，只是静默线是 5 分钟（见本节最后一段）；两成的门槛；reaper 启动后 3 分钟的宽限期；心跳写入失败、其他 apiserver 进程失联时仍然暂停全部回收；runner 主动下线（OFFLINE）、托管 runner 休眠或排空，都不算静默。
- 和 §6.5 原文、B3 做法的偏离，以及理由：
  1. **只保护断线的那一批 runner，不再整个 reaper 暂停回收。** 断线期间独自坏掉的 runner 照样 5 分钟回收；网关反复重启时（C2b 里每 132 秒一次），回收不会被无限推迟；误判（见下）只影响恰好同一时段坏掉的 runner。
  2. **"同时失联"按失联时刻计，已经重连回来的 runner 也算。** 快速重连时，此刻没有 runner 在静默，按清扫那一刻数，怎么采样都看不出来。
  3. **去掉"最后一次看到之后再暂停 90 秒"，每台 runner 从自己的静默线起保护 10 分钟。** 断线已经写进数据库，不需要再被看到一次。一直不恢复的大面积失联，原来约 12 分 15 秒后回收，现在约 10 分 45 秒（再加不超过一个清扫间隔）。
  4. **每次清扫都判断，不再只在有会话要回收时才判断。** 等到有会话要回收时，大部分 runner 已经回来了。启动宽限期内不判断：UNLOGGED 表可能刚被清空，读数不可信；宽限期过后，证据还在表里。
  5. **断线写进数据库，不放在进程内存里。** 选主换了进程以后，接手的进程照样保护，不取决于哪个进程在清扫。
- 代价（只会推迟回收，不会误回收）：
  - 令牌续期（每台每小时一次）和 runner 重启也会开新连接，也算失联。1.5 万台的单元每分钟约 1.8%，远低于两成。10 台、几个网关节点的小单元里，两台恰好在同一个 45 秒里续期，就会被算成一次断线，只会推迟同一时段里恰好坏掉的 runner 被回收。
  - 1 到 5 台的单元，一台失联就占五分之一，保护 10 分 45 秒，和以前一样。
  - HTTPS 心跳（以及走完整对账的托管 runner 心跳）不记 `lost_at`，没漏心跳就回来的 runner 在那里不留痕迹。HTTPS 下没有握手限速，不会拖出长尾；心跳失败的 runner 要等下一个 tick，静默时会被清扫看到。
- 测试：
  - `src/apiserver/src/realtime/reaper-mass-disconnect.pg.spec.ts` 起两个 apiserver 进程，模拟网关的调用，按真实时间注入断线。
  - staging 演练是 `scripts/runner-link/drills/mass-disconnect-drill.sh` 的 `node` 场景：两个网关节点，前面一个四层转发，停掉一个，另一个限速。

**回收线改为 5 分钟，离线展示仍是 90 秒（2026-11-06）**

- 起因：2026-11-05 一台 MacBook runner（`01a11ee9`）的出口网络反复断约 2 分钟。网关日志里 13:44:42 断、13:46:49 回，而 reaper 在 13:45:54 就以 90 秒静默把两条仍在产出事件的会话判成 `runner offline`，比 runner 回来早 55 秒。近 7 天 21 次 `runner offline` 全部落在这台 runner 上，每次距它最后一条事件入库只有 68–208 秒，其中 7 条已经跑完 34–139 轮。
- 现在：`RUNNER_REAP_AFTER_MS = 5 分钟`（`src/apiserver/src/realtime/reaper.service.ts`），reaper 用它判 RUNNING 会话的 `runner offline`；runner 列表、派发前的在线检查等仍用 `RUNNER_OFFLINE_AFTER_MS = 90 秒`。`silenceHold` 的各项窗口也按 5 分钟读，因为它们要覆盖被判静默的整段时间。
- 取舍：单台真死机的会话晚 3.5 分钟回收和重派；换来 1–3 分钟的网络抖动不再丢掉正在跑的 turn。大面积断线的保护（10 分 45 秒）不变。

### 15.7 同一 seq 上来了不同的事件：照常确认，但记错误日志并计数

出处：暂存修复（34mumXbJjOvZUwNmDNzmY）。涉及 §5.8。

- §5.8 说撞号的事件会被 `skipDuplicates` 静默跳过。现在服务端（HTTPS 和链路两个入口）发现某个 seq 已经存了另一个事件时，这一批照常确认，这条事件不存，但记一条错误日志，并计入 `orbit_run_event_seq_conflicts_total{door="https"|"link"}`（`GET /api/metrics`，每个 apiserver 进程从启动起各自计数）。
- 判断是不是同一个事件，只比类型、turn 和 runner 记的毫秒时间，不比 payload：入库会改写 payload，同一事件重发也会对不上。所以同类型、同 turn、同一毫秒的两个不同事件，会被当成重发。
- 不拒收的理由：这个 seq 已经有别的事件，拒收也存不进去；可重试的拒绝会挡住这个会话后面所有的事件；`EventAck.rejected` 的意思是墓碑占了这个 seq，这里不是；HTTPS 也没有拒收单条事件的办法。
- 从 34mumXbJjOvZUwNmDNzmY 起，runner 不再在暂存上编号，出现冲突说明是旧版本 runner 所致（§11.4），或者出了故障。

### 15.8 turn 完成通知先写入本地暂存，重启后先补发

出处：34mwBTpOPo3S9LM2SXs10（方案经协调者 2026-10-27 批准）。涉及 §5.6、§7。

- 问题：runner 停止时一个 turn 的完成通知没发出去（链路断开、开关又拒绝 HTTPS；HTTPS 模式下完成通知和 runner 一起丢了也一样），而它的 turn_end 事件留在暂存里，后来存了进去。服务端仍认为这个 turn 在执行，把它带着续写重新交给新进程，引擎在已经结束的 turn 上再做一遍。
- 现在（`src/runner-go/turn_complete_journal.go`、`src/runner-go/session.go`；服务端代码没改）：
  - 完成通知发出之前（也在它前面那次事件 flush 之前），先写入 `~/.orbit/link-spool/<会话 id>/turn-complete-<turn id>.json`（写临时文件再改名，权限 0600）。
  - 控制面应答，或为这个会话拒绝（409/403/404）之后删除。runner 运行中，暂时性的失败会一直重试；遇到明确的拒绝（400/401/413，或 `ORBIT_LINK_MODE=off` 时的 426）也删除，这个 turn 照旧被重新投递。只有 runner 停止或被杀时还没拿到应答，文件才留下。
  - 下一个进程启动时接管名下所有未结束的会话。会话的 supervisor 先把暂存的事件存完，再以自己的租约补发留下的完成通知，然后才第一次取消息，所以已经结束的 turn 不会再交给引擎。服务端对 turn 的完成是比较并设置，已经生效过的完成通知再发一次不改变任何东西。
  - 完成通知没写下来时，turn 照旧带着续写重新投递，投递仍是至少一次：runner 在引擎做完之前被杀，或在 turn_end 存进去之后、写文件之前被杀。后一段是读工作区 diff 的时间，34mwBTpOPo3S9LM2SXs10 在 HPC 上实测中位数 12.5–208 毫秒，随工作区大小而变。
  - 会话没交回这台 runner（已经关闭，或属于别的 runner）时不补发，文件等 72 小时清理，清理前写 runner 日志。
- 链路模式和 HTTPS 模式都这样，所以 HTTPS 模式的行为也变了：完成通知丢了的 turn 不再重跑。这是项目说明第 11 条（开关关着时行为和以前完全一样）的例外，经协调者批准；没有暂存文件时，两种模式的完成路径和以前一样。
- 同一任务还改了两处暂存：
  - runner 启动时，交回给它的空闲会话的暂存事件马上发出，不再等下一次领取；
  - 暂存分段读进内存后留在磁盘上，直到其中的事件全部存好；发送途中被强杀，下一个进程重发，服务端每个 seq 只存一次。
- 回滚和降级时怎么处理这些文件，见 §11.4。

### 15.9 守护进程漏在链路外的三个调用，已挪到链路上；runner 调用普查

出处：34nb3xeq1s4tHra7apUWD（(b) 34mNe8DOyUq2wlk81EGlZ 测试时发现）。涉及 §4、§11.3、D14。

- 2026-10-25 统计的 49 个路由只数了 runner-api 主控制器（RunnerApiController）。守护进程还发三个调用，由给 agent 工具用的控制器提供：链路不转（`RUNNER_LINK_ROUTE_NOT_ON_LINK`），runner 也一直走 HTTPS 发，开关打开后照样走 HTTPS。
  - `POST /runner/cursor-key-check-result`：回报心跳交来的 Cursor 密钥检查。
  - `POST /runner/sessions/:id/cursor-key-check`：会话启动前检查派发来的 Cursor 密钥，回报结果。
  - 会话的后台任务在没有引擎时结束，提醒账号所有者：原来走 `POST /runner/notify`（`orbit notify` 和 MCP 的 notify 工具也走它），会话 id 放在 `X-Orbit-Session-Id` 头里，而链路调用不带请求头。
- 现在三个都由 RunnerApiController 提供，runner 的 `linkDaemonRoutes` 也列了它们。前两个路径不变。后台任务的提醒改走守护进程自己的 `POST /runner/sessions/:id/notify`，会话 id 在路径里，和 `background-wake` 一样只接受分给这台 runner 的会话。`POST /runner/notify` 留给 agent 和 CLI，照旧走 HTTPS。
- RunnerApiController 现在有 52 个路由：`RUNNER_LINK_REQUIRED` 打开时 47 个对 HTTPS 返回 426，注册的 3 个和附件的 2 个照常应答（§15.1）。
- 开关关闭时：两个 Cursor 调用的请求和应答都和以前一样（同一路径、守卫和校验，应答里没有 id）。后台任务的提醒换了路由，推送的内容、标题和频率限制不变；只有会话已经不归这台 runner 时，以前照样推送，现在返回 403。
- 部署顺序：apiserver 先于这一版 runner 上线，否则新 runner 的后台任务提醒会得到 404。打开开关之前，runner 要升级到这一版：更早的支持链路的版本仍走 HTTPS 发两个 Cursor 调用，开关打开后会收到 426，回报丢失。
- 普查（runner-go 发出的每个 HTTPS 调用，2026-10-28，项目分支 54a61ed32）：
  - 守护进程的控制面调用，链路在用时全部走链路。例外只有 D14 列的几项：取连接令牌（`POST /runner/link-token`，在链路建立之前）；自更新（`GET /runner/release`，链路下发了版本时不再调用；`/dl` 下的 `version.json` 和二进制）；附件（`GET /runner/sessions/:id/attachments/:id`、`POST /runner/sessions/:id/attachments`）。
  - `orbit mcp`、CLI 和 Antigravity 审批钩子不是守护进程，没有自己的链路，都走 HTTPS，并用 `X-Orbit-Runner-Caller` 标明身份。它们用到的守护进程路由（审批、编排凭证续期、`GET /runner/me`、会话 meta 等），开关不拒绝（§15.1）。`orbit doctor` 检查开关时有意不带这个标记。
  - 守护进程直接访问的外部服务不是控制面，不归链路管：Cursor、Kimi、Claude 的用量接口，Kimi 的令牌刷新，引擎版本检查，Cursor CLI 和 dsh 的下载。

### 15.10 默认安装的链路走 web 网关的端口（偏离 D1）

出处：34sREuYT2DCEXiW6qZuOh。账号所有者 2026-11-05T17:47Z 决定：默认安装和升级先把链路带上，D2 才能落地，否则每个自托管部署都会在带 D2 的那次升级时停摆。涉及 D1、§6.1、§8、§11.5。

- **偏离的内容。** D1 要求 runner 直连网关，不经过 Cloudflare，也不经过 web 网关。生产和按单元部署照旧。默认安装可能只有一个局域网地址，没有公网证书，开新端口又要用户动防火墙，所以 runner 走 web 网关的同一个端口：`location = /runner-link`（gateway/nginx.conf）转给项目网络里的 `link-gateway:8443`，网关关掉 TLS（deploy/runner-link/behind-web-gateway.env）。不新开端口，不用证书，不改防火墙。托管 runner 的防火墙本来就放行这个端口。
- **D1 的理由这里不成立。** D1 防的是 CDN 终止和检查连接，以及它的故障和限额变成链路的问题，还有单元规模下 web 流量和链路互相影响。默认安装的规模到不了那里；前面有用户自己的 CDN 时，代价由用户选择。
- **加密。** 链路和部署自己的 HTTP 加密情况一样：部署是 https，链路就是 wss；部署是纯 http，链路就是纯 ws，会话内容和一小时的连接令牌明文传输（同一部署今天的会话内容和长期 runner 令牌本来就明文传）。安装和升级每次运行警告一次。这是账号所有者的取舍，见任务证据。
- **地址。** 固定的 `RUNNER_LINK_URL` 在这里给不对：`PUBLIC_ORIGIN` 默认是 localhost，托管 runner 只能到容器网络上的网关地址。所以新增取值 `RUNNER_LINK_URL=same-origin`，apiserver 按每个 runner 到达的地址回答（`sameOriginLinkUrl`，runner-link-token.ts）：
  - `PUBLIC_ORIGIN` 是 https：一律回答它的 `wss://`，请求头改变不了。唯一例外是托管 runner 配置里写明的明文地址，并且请求没有经过前置代理的迹象。
  - `PUBLIC_ORIGIN` 是 http：回答请求到达时的 `Host`（只接受主机和端口）。部署可能并不知道自己的地址。`X-Forwarded-Proto` 只能把 ws 升成 wss，不能反过来。`Host` 只影响带着它的那个请求的回答，不缓存。
  - 不需要 `TRUSTED_PROXIES`。它列出的代理只会让请求算作经过了前置代理。
  - 只改 apiserver 和 nginx，不改 runner，不需要发版：runner 从有链路的第一个版本起就接受 `ws://` 和路径。
- **容量。** 每个 runner 占 nginx 一个 worker 的 1024 个连接中的两个，一个 worker 大约带 500 个 runner，worker 数等于 CPU 数。超过时给链路单独的域名。所有 runner 在网关看来是同一个地址，所以这种形态把网关的单地址限速提到和全局限速一样。
- **没有自动翻开关。** 脚本不写 `runner_link_switch`：这是管理员的门（有日志和唤醒），而且 D2 马上会删掉它；无人值守的升级也不该在有 turn 运行时翻开关。D2 之前，部署走 HTTPS，影子连接连着；D2 的构建把它们带到链路上。管理员想提前切，仍然用 `PUT /api/admin/runner-link-required`。
- **`.env` 的三种状态和失败时的行为，** 见 [self-hosting.md 的 "Runner link"](./self-hosting.md#runner-link)。生产那种自己配置的链路，`.env` 不打开写，网关和 NATS 不构建也不重启；它的 web 网关在升级到这个版本时重建一次，因为 gateway/nginx.conf 变了。

### 15.11 切换后清理（D2）

出处：D2（34bsPmWGZjo7CPt4BFI5G）。涉及 §5.6、§11.3、§11.4、§13、§15.1、§15.9、D13、D14、D15。

- **守护进程路由。** RunnerApiController 现在有 55 个路由（含 11-05 加入的废弃检出清单 `POST /runner/abandoned-checkouts`）：48 个守护进程路由对没有链路上下文的调用（即 HTTPS）一律回 426 `UPGRADE_REQUIRED`，不读开关；7 个按 D14 留在 HTTPS（注册的 3 个、附件的 2 个、Claude 地区检查、agent 保留文件的上传）。处理器本身留着：网关经内部监听把链路调用转给同一批路由（D13），它们就是链路的业务逻辑。
- **带调用方标记的调用。** 任务给了两种做法，选的是第二种：路由保留，只给带 `X-Orbit-Runner-Caller` 标记的请求用，而且只在 8 个路由上（`@CalledByNamedCallers()`）：`GET /runner/me`、`POST /runner/deregister`、审批的两个、`scheduled-wakeup`、`orchestration-credential`、会话 meta、读会话事件。这是 runner-go 里 `orbit mcp`、Antigravity 审批钩子和 CLI（`newCallerTransport`）实际调用的全部守护进程路由。其余 40 个路由带了标记也回 426。`POST /runner/notify` 不在这个控制器上，不受影响。
- **`GET /runner/wake` 留成一个只回 426 的入口。** 它不读任何东西，谁调都一样。0.1.246 的 runner 进程启动时可能经 HTTPS 调一次 wake：得到 404 它的 wake 循环就永久停止，得到 426 则转到链路上再试。`POST /runner/sessions/:id/complete` 删了：0.1.246 只在 `/finalize` 回 404 时才调用它。
- **开关。** `GET` / `PUT /api/admin/runner-link-required` 删了（404）。表 `runner_link_switch` 和它的 Prisma 模型留着，没有迁移：服务端回滚到清理之前的版本时会读这一行，生产上它是打开的。网关读的 `GET /api/runner/link/mode` 留着，对网关一直答 `{"required": true}`，不读表：网关读不到它，就对 runner 说 `MODE_HTTP`，什么也不转。链路没配置时它和 `POST /api/runner/link-token` 一样回 404 `RUNNER_LINK_NOT_CONFIGURED`。
- **长轮询。** 删了 `LONG_POLL_MS`、`INBOX_LONG_POLL_MS`、`waitForSignal`、`waitForInbox`、`waitForRunnerWake` 和它们的等待者。领会话和取消息立即应答；领会话失去行锁时约 5 秒的重试留着（§5.6）。`APPROVAL_LONG_POLL_MS` 留着：`orbit mcp` 经 HTTPS 读审批时仍挂起 25 秒。
- **能力判断和旧式轮询。** 删了 2026-10-25 统计的 14 处 `runnerSupportsCapability` 和它们守着的旧分支：这些能力最晚由 0.1.232 的 runner 开始声明，而能和这个服务端工作的 runner 都有链路（0.1.237 起），都声明了它们。2026-11-01 加上的第 15 处留着：Claude 地区检查的"再查一次"只交给声明 `claude-region/v1` 的进程，而这个能力从 0.1.242 才有，0.1.237–0.1.241 的 runner 走链路照常工作、却不会检查。11-05 随废弃检出清单加入的 `abandoned-checkout-v1` 判断也留着：到 0.1.246 为止没有 runner 声明它。`RunnersService` 里读已持久化能力的登录门槛不是这种判断，留着。取消息必须带租约代次，不带回 400；`release-leases` 必须带代次和所有者。
- **写入契约摘要。** 服务端不再读、也不再发摘要 header 和应答里的 `X-Orbit-Server-*`，修订号照旧校验。runner 照旧发摘要和能力声明：清理之前的服务端缺了摘要会拒绝修订（`RUNNER_PROTOCOL_CONTRACT_MISMATCH`），能力声明它也照读。等再也没有清理之前的服务端，下一次清理才能删 runner 这一侧。
- **runner。** 删了 HTTP 工作路径（`ORBIT_LINK_MODE`、config.json 的 `linkMode`、链路 5 分钟不可达就退回 HTTPS、HTTPS 上的事件补发、`/complete` 回退）、影子连接（`ORBIT_LINK_SHADOW`）和守护进程的 wake 长轮询。守护进程的调用只走链路；`Welcome` 或 `HeartbeatAck` 说 `MODE_HTTP` 时 runner 不退回，留在链路上等。`orbit doctor` 对这种情况和没配链路的服务端都写 ✗。没有链路的传输只留给不是守护进程的进程（`orbit mcp`、CLI、钩子）；单元测试也用它驱动会话循环。
- **没动。** 网关（`mode.go` 读模式、`LINK_MODE`、`shadow.go`、`MODE_HTTP` 的连接、`client_switch.go` 的演练）和“暂停派发”开关。网关的清理是单独的任务：网关一发布，runner 要断开 4–56 秒。网关这一部分后来由 34sSqSNx9BHCECKDNblLr 清理，见 §15.12。
- **发布顺序。** 服务端和 runner 谁先发布都可以：0.1.246 的 runner 在 `MODE_LINK` 下只走链路，对着清理之后的服务端照常工作；清理之后的 runner 对着清理之前、开关打开的服务端也照常工作。清理之后的服务端回滚到清理之前的版本时，开关那一行还是打开的，所以清理之后的 runner 照常工作；有人再把开关关上，这些 runner 就停工，因为它们没有 HTTP 路径。没有链路的部署（开关关着、或没配链路）用不了清理之后的服务端和 runner，所以默认安装和升级要先带上链路（34sREuYT2DCEXiW6qZuOh）。
- **没有链路的旧 runner（0.1.237 之前）。** 它们的守护进程调用一律得到 426，第一次心跳被拒就以退出码 0 退出（日志 `⏸ interactive run … detached for shutdown (resumable)`），这时不会自更新。由 `orbit register` 装的服务（systemd 的 `Restart=always`、launchd 的 `KeepAlive`）几秒后把它拉起来，启动时的自更新经 `GET /runner/release`（仍走 HTTPS）换成 `/dl` 上的版本，随即走链路、接管会话，手上正在跑的 turn 也接着跑完（case 4c：turn 完成，事件 1..42 连续）；在终端里手动 `orbit run`、或没有重启策略的容器里跑的，会一直停着，直到有人再启动它，手上的 turn 以 runner 离线结束（case 4b，停了 13 分钟）。关了自更新的，每次启动都打印 426 的提示（`Run \`orbit upgrade\``）后退出。生产从 D1 打开开关起就是这样；自托管部署在第一次升级到清理之后的版本时遇到（34sREuYT2DCEXiW6qZuOh 的 case 4b 和 4c，0.1.233 的 runner）。

### 15.12 网关的影子期代码清理

出处：34sSqSNx9BHCECKDNblLr。涉及 §6.1、§11.2、§11.3、§13、§15.1、§15.11、D7、D15。D2 留下的网关部分（§15.11 “没动”）在这里清理；`upgrade.sh` 不重建生产的网关，所以合入本身不改变生产。

- **删了什么。** 网关里：镜像比对（`shadow.go` 和 `link_shadow_*` 指标）；读切换开关的轮询（`mode.go`：每秒读一次 `GET /api/runner/link/mode`，以及 `link_mode_link`、`link_mode_fetches_total`）；`LINK_MODE` 和它的 `link` 覆盖；`MODE_HTTP` 的连接（心跳立即回一个什么也不带的 `HeartbeatAck`、请求回 `LINK_MODE_HTTP`、事件批不存也不确认、提示记作 `mode_http`）；测试客户端的镜像（`-mirror`、`-http`、`-events`、`-corrupt-every`）和 `switch` 演练（`client_switch.go`）。`linkstub` 不再提供 mode 路由。脚本里：删了 `staging-check-switch.sh` 和 `drills/rollback-drill.sh`；四个演练共用的 `rollback-drill.mjs` 改名 `drills/drill-api.mjs`，去掉 `switch` 命令；durable-events 演练删了驱动开关和 HTTPS 路径的 `rollback`、`partition-off` 两个阶段；release-outage 演练的 `https` 阶段改成链路上的 `apiserver` 阶段；`staging-check.sh` 改成检查链路下的网关本身；`ORBIT_LINK_STAGING_MODE` 删除。各演练等的日志改成 D2 的 runner 写的那一行（`carries the work of process`）。
- **`LINK_MODE` 不再读取，`LINK_INTERNAL_API_URLS` 必填。** 还设着 `LINK_MODE` 的部署照常启动，runner 收到的也是 `MODE_LINK`，和读 D2 服务端的旧网关一样。
- **留下的：每个 `Welcome` 和 `HeartbeatAck` 都说 `MODE_LINK`。** 0.1.246 的 runner（763df9fab 的 `link_mode.go`、`link_shadow.go`）收到 `MODE_LINK` 把工作放到链路上，`Welcome` 不带模式时当作没说，收到 `MODE_HTTP` 退回 HTTPS；它的影子连接在说了 `MODE_LINK` 的连接上不发镜像，工作连接占住这个进程的连接后就让出来。所以这个网关对 0.1.246 的 runner 和以前的网关一样：D2 的服务端对它的 HTTPS 守护进程调用回 426（进程启动时一到三次），链路接手后不再有。
- **留下的：协议里的 `MODE_HTTP`。** contracts/runner-link/v1 保留这个值（buf breaking，编号不复用），这个网关不再发它。D2 的 runner 遇到旧网关说 `MODE_HTTP` 时留在链路上继续问（§15.11）。
- **留下的：服务端的 `GET /api/runner/link/mode`**，D2 让它对网关一直答 `{"required": true}`。清理之前的网关（生产的 f8b9964f3）每秒读它；启动后读不到，就对所有 runner 说 `MODE_HTTP`，什么也不转。自己配了链路域名的部署（`upgrade.sh` 的 `operator`），升级从不重建网关，所以这个路由要留到运维把网关重建成这个版本以后，才能由以后的清理删掉。
- **三种组合。**
  - 旧网关对 D2 的服务端：每秒读到 `required: true`，对 runner 说 `MODE_LINK`，照常转发。D2 的复验就是这样跑的；本任务的复验（staging，项目分支 32844320c 的服务端和网关，网关代码与 f8b9964f3 相同）o 阶段又测了一次：3 秒内读了 3 次、零失败，`link_mode_link` 为 1，`Welcome` 和 `HeartbeatAck` 全是 `MODE_LINK`；0.1.246 和 D2 的 runner 各开新会话、发消息，事件连续；HTTPS 上只有 0.1.246 进程启动时的三次调用（`GET /runner/wake`、`GET /runner/sessions/reclaim`、`GET /runner/me`），都回 426。
  - 0.1.246 的 runner 对这个网关：复验 n 阶段，新会话、消息、中断的 turn、网关重启、apiserver 重启都照常，期间没有 HTTPS 守护进程调用；0.1.246 重启时只有一次 `GET /runner/me` 被拒 426，它的影子连接收到 `MODE_LINK` 的 `Welcome` 后让出（`the shadow stands down`），工作连接接手。D2 的 runner 重启时没有 HTTPS 守护进程调用。
  - 这个网关对清理之前、开关打开的服务端（生产现在的 b4619320b）：和旧网关读到开关打开时一样。有人在那个服务端上把开关关上，这个网关仍说 `MODE_LINK`，runner 留在链路上（清理之前的服务端从不拒绝经网关转发的调用，`runner-link-required.ts`），关开关不再能把 runner 带回 HTTPS。
- **生产网关重建会怎样。** 合入之后，生产只有在有人重建网关时才带上它：`docker build` 网关镜像，再只重建 `link-gateway` 这一个容器。旧进程收到 SIGTERM 后 drain：每条连接在 1–30 秒的随机延迟后被要求重连；单节点时这次重连在新进程起来之前被 `503 DRAINING` 拒绝，连接留在旧进程上，到延迟之后再过 15 秒（`LINK_DRAIN_GRACE`）被关掉；连接都关了（最迟到 80 秒的 drain 超时）旧进程才退出，Compose 随后启动新进程，runner 按退避重连上来。正在跑的 turn 不中断，事件不丢。新网关不再读 mode 路由，`/metrics` 少了 `link_shadow_*` 和 `link_mode_*`。复验 g 阶段这样做了一次（只重建 `link-gateway` 一个容器，沿用旧的 compose 文件和环境，环境里还有 `LINK_MODE=http`）：镜像构建 8 秒，从重建容器开始到新网关提供服务约 55 秒；两台 runner 分别有 37 秒（0.1.246）和 60 秒（D2）没有工作连接，各自跨过重建的长 turn 照常完成，事件 1..33 连续，每个 turn 只交给引擎一次，期间没有 HTTPS 守护进程调用。断开多久取决于重连延迟的随机值和 runner 的退避：单节点时旧进程要等到最后一条连接被关掉（延迟最多 30 秒，再加 15 秒宽限）才退出。同一个容器 `docker restart` 时，两台 runner 断开 4 秒和 14 秒。它不改变 runner 能做的任何事，所以可以等到证书或安全修复本来就要重建网关时一起带上；什么时候重建由账号所有者决定，要走审过的步骤。
- **默认安装（same-origin，`upgrade.sh` 的 `managed`）。** 网关镜像以最后一次改 `src/link-gateway` 的提交命名，所以合入之后默认安装的下一次 `/upgrade` 会重建并重启网关，断开情况同上。

### 15.13 服务端答得慢不是断线：心跳带编号，连接死活只看 ping

出处：34t9dlSrMe6KgsWq8ysTX（账号所有者 2026-11-07 同意修复）。涉及 §5.7、§7、§10。

- **问题。** 2026-11-06 生产主机 CPU 饱和（8 核负载 50–88），apiserver 答链路心跳慢，传输本身没坏。runner 把迟到的回答当成断线：心跳 15 秒内没答，调用放弃；下一次心跳发现上一个还没答，就关掉连接重连（`a heartbeat sent on it was never answered`）。09:44–10:28Z 网关记了 561 次 `connection_lost`（平常每小时 0–1 次）。每次重连多一次 welcome 路由的调用、一次 `Welcome` 和未入库事件的重发，正落在已经过载的服务端上。
- **顺带发现。** runner 用的 coder/websocket 1.8.15 里，`Ping` 等不到 pong 只返回错误，不关连接，runner 的 pinger 随即停下。所以以前真正发现半开连接的是上面那条心跳规则，要 30–60 秒。
- **现在**（`src/runner-go/link_heartbeat.go`、`link_work.go`、`transport.go`；网关 `heartbeat.go`、`conn.go`；proto 加两个字段）：
  - 每个 `Heartbeat` 带 `beat_id`（进程内从 1 递增），网关在回答它的 `HeartbeatAck` 里原样带回：不论这个心跳是对账了、要事实（`want_facts`）、被拒，还是到了 `LINK_RPC_TIMEOUT` 没拿到回答。一条连接上同时最多一个没答的心跳。
  - 迟到的回答不断开连接。心跳的调用放弃以后，这个心跳在连接上仍算没答；下一个心跳先等它的回答，不应用（和 HTTPS 上超时以后才到的回答一样），再发自己。旧网关的回答不带 `beat_id`，按顺序认：网关对一条连接的心跳逐个转发、逐个回答（排队时较新的一个替换较旧的，runner 一次只有一个，碰不到）。
  - 链路上心跳的等待由 15 秒放宽到 75 秒，长于网关转发一次心跳的上限（`LINK_RPC_TIMEOUT`，默认 60 秒，到点回一个没拿到回答的 ack）。连接活着，心跳就等得到回答，对账照常应用。心跳不重叠，服务端答得多慢，心跳就来得多慢，不会堆起来；在线状态随每次回答刷新。HTTPS 上仍是 15 秒。
  - 连接死没死只看传输：每 20 秒 ping 一次，20 秒内没有 pong、其间也没从网关读到任何帧，就关掉重连。pong 由网关自己回，后端多慢都不影响。半开连接、网关冻住、断网，40 秒内发现（以前靠心跳规则，30–60 秒）；网关被杀、连接被重置，立刻发现。接着第一次重连前的等待不到 1 秒（全抖动）；网关一直连不上时，重试照旧按退避拉长，最多 60 秒一次，所以网关恢复后至多 60 秒连回。
  - 唯一的例外：一个心跳在能答 ping 的连接上 3 分钟（网关上限的三倍）没答，说明这个网关没在转发这条连接的心跳，结束这条连接。
  - 重连退避只在连接上有心跳被对账以后才清零，不再在每次 `Welcome` 时清零。连接一条接一条地断、链路始终不通时，等待的上限按 1、2、4…60 秒增长（全抖动），不会紧密循环，一批 runner 也不会一起涌向 `POST /api/runner/link-token`。
- **兼容和发布。**
  - proto 只加字段：`Heartbeat.beat_id = 7`、`HeartbeatAck.beat_id = 6`；`buf breaking` 对 main 通过。
  - 修复在 runner，要发 runner 版本。网关的改动（带回 `beat_id`，帧日志记 `beat=`）可有可无，随下一次重建网关带上即可。服务端不改。三者上线顺序任意。
  - 新 runner 对旧网关（生产的 f8b9964f3）：回答不带编号，按顺序认。0.1.247 对新网关：心跳不带编号，网关回 0，0.1.247 照旧（迟答仍断线重连，直到它升级）。
- **实测**（2026-11-07，HPC staging，项目分支 e5d72ce54 的服务端，本分支的网关和 runner；hbdelay 夹在网关和 apiserver 之间，把每个心跳扣住一段时间再转发，传输不受影响；0.1.247 和本分支的 runner 同时在跑）：
  - 心跳扣 20 秒，10 分钟：0.1.247 断开 37 次（网关记 37 次 `connection_lost`、37 次 welcome），37 个心跳只有 1 个到了 apiserver，其余都在它自己断线时被网关放弃，在线状态 118 次采样里 100 次静默，最长 550 秒。本分支的 runner 一次没断，19 个心跳全部对账（每个 20 秒），从未静默。两台的消息都照常回答。
  - 扣 40 秒，7 分钟：0.1.247 断开 28 次，27 个心跳一个也没到 apiserver；本分支的 runner 不断，10 个心跳全部对账（每个 40 秒）。
  - 扣 20 秒、每台留一个 12 分钟的长 turn（项目分支的服务端，reaper 90 秒判离线）：0.1.247 断开 45 次，静默过了 645 秒的保护线以后，它的会话被 reaper 以 `runner offline` 判 FAILED；本分支的 runner 不断，长 turn 照常做完，事件 1..54 连续。
  - 两台 runner 重连都沿用手上的连接令牌，所以这些窗口里 `POST /api/runner/link-token` 一次也没有；唯一的两次是各自 55 分钟时的正常续期。
  - 传输死掉：杀网关，两台都 0.3 秒发现；冻住网关 75 秒，0.1.247 52.7 秒（心跳规则）、本分支 26.6 秒（ping）；断网 90 秒，55.1 秒对 37.6 秒；旧网关上冻住，49.1 秒对 30.4 秒。
  - 生产的旧网关（f8b9964f3）上扣 20 秒、8 分钟：0.1.247 断开 29 次；本分支的 runner 不断（回答不带编号，按顺序认），18 个心跳 17 个对账，剩下一个在 55 分钟续期换连接的那一刻在路上，换到新连接上重发了。
  - 重连治不好答得慢时：心跳扣 90 秒（网关 60 秒放弃，一个也没对账），连杀网关 6 次、间隔 20 秒。0.1.247 断了 14 次（6 次被杀、8 次自己断），每次重连前都等不到 1 秒；本分支的 runner 只在 6 次被杀时断开，重连前的等待依次是 0.03、15.3、17.6、15.2、44.4、34.3 秒，随次数增长，带全抖动。
  - 合入 main 以后在合并后的服务端上重测（带 114002afb：reaper 静默 5 分钟才判 RUNNING 会话离线，大面积断线的保护 10 分 45 秒不变）。扣 20 秒的前 10 分钟：0.1.247 断开 38 次（38 次 welcome），39 个心跳只有 1 个对账，在线状态 99 次采样 87 次静默；本分支的 runner 不断，20 个心跳全部对账，只在变慢的那一刻静默过一次（50 秒）。两台各留一个 12 分钟的长 turn：reaper 在 0.1.247 静默 321 秒时第一次把它的会话判离线（项目分支的服务端是 90 秒），因为大面积断线的保护连续 11 次不回收，静默到 653 秒、过了 645 秒的保护线后判 FAILED；本分支的 turn 照常做完，reaper 一次也没判它离线。5 分钟的回收线救不了 0.1.247 的 turn：它的心跳到不了服务端，静默一直在涨，只是第一次判离线推后了。
  - 现有演练照常通过，没有会话被回收：lost-answer（10 次丢失的回答都在 5 秒内拿回、只执行一次）、durable-events（杀网关、杀 apiserver、数据库主备切换和切回、断网 600 秒，seq 1..1275 连续）、mass-disconnect（停网关 180 秒、隔离 10 台中的 2 台 180 秒）。合入 main 以后在合并后的树上再跑 mass-disconnect（main 把停网关和隔离都改成 420 秒）：两次都没有会话被回收。第一次停网关那一段有一次清扫比上一次晚了 39 秒才记下（主机负载约 50，那次清扫照样保护了全部 10 个会话），超过演练要求的 35 秒，判了失败；第二次两段都通过。

### 15.14 自动升级的推迟有上限：推迟满 1 小时后不再领新活，等在跑的 turn 自己结束再升级

出处：项目 34uUvixOgW5SbuNGvkAKA 标准 3，任务 34uVm0u43R1wMQ5D9WfuD。涉及 §7、§11.5。

- **问题。** runner 每 10 分钟查一次自己该跑的版本（`selfUpdateCheckInterval`）。有新版本时，只有在没有 turn、也没有心跳派来的操作（落地检查、引擎安装）在跑时才升级（`updateWhenNoTurnInFlight`，2026-09-25 账号所有者定的规则：自动升级不打断在跑的 turn）。这个等待没有上限：每次检查都忙的 runner 就一直不升级。workstation-gpu 因此停在 0.1.246 好几天，拿不到 0.1.248 的心跳修复。
- **现在**（`src/runner-go/runloop.go`、`session_pool.go`）：
  - **时限 1 小时**（`selfUpdateDeferralLimit`），从第一次"有要装的版本、但 runner 正忙"的检查算起，用会话池的时钟（测试里是可控时钟）。时限内照旧：任何一次检查碰上空闲就立即升级，不排空。
  - **到时限后排空**（`sessionPool.drainForUpdate`）：`admissionIdleCapacity` 返回 0，领取循环不再领新会话，也不再领已有会话的下一个 turn；心跳报 `draining=true`。另一条不经领取的路：turn 结束时会话里已排着下一条消息，服务端把许可直接交给它（`retainsTurnPermit`），排空期间这条后续消息不在这里开始（`holdFollowUpForUpdate`，`waitActive` 挡住），也不算在跑，会话留在 RUNNING，由升级后的进程重新领回——和 `closeForUpdate` 时恰好到达的领取走同一条路。否则一个每次 turn 结束都有新消息排着的会话会让排空永远结束不了。在跑的 turn 和操作一个都不动，等它们自己结束。
  - 排空期间每 15 秒再查一次（`selfUpdateDrainCheckInterval`，`nudgeWhileDrainingForUpdate`），不再等 10 分钟一次的检查；第一次查到什么都没在跑，就走原来的路：`closeForUpdate` 关池、停领取循环、会话断开交给新进程重新领回、装新版本、重新 exec。
  - 排空期间的检查不再读版本清单：读失败会把池重新打开，而停下来以后的安装（`selfUpdate`）本来就会重读一次指派的版本。版本在排空期间被撤回，结果是用原来的二进制重启一次，不会装错。
  - 推迟的起点在进程内不重置：检查失败或一时读不到版本不算"不落后了"。
  - 心跳的 `selfUpdate` 状态仍是 `waitingForIdle`，排空时 `reason` 写明已推迟多久、在等多少个 turn。
- **上界。** 版本发布 → 至多 10 分钟内被检查发现（"Update Runner Now"则立即）→ 1 小时 → 排空开始时在跑的最长 turn 结束 → 至多 15 秒 → 重启（几秒）。排空开始后不再有新 turn 开始，所以等待只取决于那一刻已经在跑的 turn。唯一的例外是引擎自己发起的 turn（Monitor 事件、`<task-notification>`，不经领取），排空挡不住它们，只能等它们结束；它们本身受 warm 驻留的 12 小时上限约束（`warmResidencyHardCap`）。
- **对控制面的影响。** 服务端不改。
  - 排空期间发给这台 runner 上会话的消息、给它的 agent 新建的会话，留在服务端排队（这些会话的工作区在这台机器上，别的 runner 本来也接不了），新进程起来重新领取后照常开始。等待就是排空的长度。
  - `draining=true` 的心跳：服务端已有的规则不再派合并、提交、落地任务、仓库操作和 Codex 重置给这个进程（`runner-api.controller.ts` 的 `draining`、`integration-job-relay.ts`、`wiki-repo-ops.ts`），它们等新进程或别的合格 runner。心跳照常，reaper 不会回收它的会话。
  - 已有的 `idleCapacity` 字段服务端不读，不受影响。
- **比较过的做法。**
  - 不设上限（原来）：一直忙的 runner 永远不升级，就是这次的问题。
  - 到时限强制重启：最简单，但会打断在跑的 turn 和 EXECUTABLE 验收命令（2026-09-25 一天 8 次被判 FAILED 的原因），违反账号所有者的规则。
  - 到时限只停领新会话、已有会话照常领 turn：一个一直有人在用的会话就能把升级无限拖住，上限不成立。
  - 由控制面判断时限、下发排空：要改服务端和协议，还要 runner 发布；runner 自己知道何时开始推迟、有什么在跑，`draining` 心跳也已经存在，没必要。
  - 选了"1 小时后停所有领取、等在跑的结束"：不打断任何 turn，上界只取决于排空开始时在跑的 turn；代价是排空期间这台 runner 的新消息要排队，时间等于最长那个 turn 剩下的部分。
  - 为什么是 1 小时：是 6 次检查，绝大多数 runner 在这期间总有一次空闲，根本不排空；一直忙的 runner 在一个多小时内拿到修复（workstation-gpu 落后的是好几天）。更短会让忙的 runner 更常为升级暂停接活，而发布频繁时这个代价每次都要付；更长则推迟修复。
- **兼容和发布。**
  - proto、服务端、网关都不改。`Heartbeat.draining` 早已存在，生产的旧网关 f8b9964f3 照样转发（它的 README：`draining` 是带类型的字段，原样转给服务端），当前服务端已经按它停发心跳派的工作。
  - 改动只在 runner，需要发一次 runner 版本才生效；它只在下一次升级（之后的版本）时起作用。0.1.248/0.1.249 等旧 runner 行为不变，与新 runner 混跑没有交互。
