# 设计文档：Runner 链路协议 v1（runner ↔ 控制面）

状态：定稿 v1 · 2026-10-07（代码引用按 main 的 701d9bae2 核对，2026-10-25）· 决策见 §2（D1–D8 由 jianghailong 拍板，D9–D15 随本文定稿）
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
| D1 | runner 链路是否经过 Cloudflare | 不经过。用独立域名，DNS 只解析不代理，直连单元的四层入口 |
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
| D15 | 所有改动按开关分批合入 main：服务端的链路能力只新增、不改变现有 HTTP 行为；runner 的链路模式默认关闭；切换由服务端开关 `RUNNER_LINK_REQUIRED` 触发（§11.3） | main 每天有上百次合入，长期分支不可行；切换和首选回滚都只是翻一个开关 |

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

**被替换的**：runner-api 主控制器里的全部守护进程路由（2026-10-25 统计为 49 个），包括领会话、取消息、wake、心跳、事件、租约、各类结果回报等。

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

- **不再挂起。** 现在的几种长轮询（claim、inbox、wake、审批）都改成收到提示后立即调用、不挂起（`wait=0`）。
- **每个请求带 `request_id`，重发返回同一个结果。**
  - 取消息：同一个进程再来取、而它手上没有正在执行的那条时，立即重新投递，不再等 300 秒租约过期（`runner-api.controller.ts:4160`、`:480`）。runner 本来就按 turnId 去重。
  - 领会话：重试时返回同一个会话，取代现在事后靠 reclaim 对账。代码里已有先例：`TASK_RUN_REQUEST_IN_PROGRESS`（`src/runner-go/transport.go:176`）。
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

### 5.8 持久事件流

- **发送与确认。** runner 按会话发 `EventBatch{session, events[seq…]}`，服务端写入成功后回 `EventAck{session, durable_seq, rejected[]}`。
- **本地缓冲。** runner 只删已确认的部分。未确认的先放在内存里（每会话 8MB、总共 256MB），超出后写到磁盘（例如上限 2GB）。
- **seq 续接。** 会话开始或重新开始时，从"服务端 durable_seq 和本地最大 seq 两者中较大的那个"加 1 开始，并先补发积压。否则，撞号的事件会被 `skipDuplicates` 静默跳过。
- **坏事件单独拒绝。** 服务端在这个 seq 上写一条墓碑占位，后面的事件照常写入。
- **额度（`Credit`）。** 网关按入库队列的深度发放额度。额度用完时，runner 只放慢发送，仍照常读取引擎的 stdout（`src/runner-go/session.go:830`）；进度类事件合并，实时类事件丢弃。
- **提交节奏。** 每个会话约 1–3 秒提交一次；遇到边界事件（回复结束、工具结果、状态变化）立即提交。

### 5.9 实时流

- `LiveBatch` 不需要确认，可以合并。
- **只在有人看时转发。** 网关只在有人观看时才发布到 NATS 的 `ses.<id>.live`；没人看时下发 `Hint{watchers: 0}`，runner 就停发增量。
- **中途打开会话。** 客户端中途打开时，服务端向 runner 发 `TurnPrefixRequest`，拿到这一轮已经输出的半截文本后，再接上实时流。这取代现在只存在单个副本内存里的 turnPrefix。
- 实时事件不再逐条 `pg_notify`。

### 5.10 大块数据

- 附件、产物继续走现有的 HTTPS 接口。
- 超过约 64KB 的工具输出也不进链路，事件里只放引用。引用格式在 v1 里就定下来，以后换成对象存储预签名 URL 时，runner 不需要换协议。

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

### 6.4 控制请求的处理

- 现有 runner-api 路由挪到一个只有内网能访问的前缀，由网关调用（HTTP/JSON）。网关负责补齐能力 header；runner 断线时，网关取消在途的请求，所以现有的 `hungUp` 逻辑继续有效。
- 长轮询的处理器改成不挂起；加上 `request_id` 幂等，可以用一张幂等表，或者记在现有的行上。

### 6.5 在线状态与 reaper

- **新表 `runner_presence`（UNLOGGED）。** 字段包括 `runner_id`、`process_id`、`gateway_id`、`last_beat_at`、`link_state`、事实哈希、对账哈希。每次心跳 upsert 一行，每单元约 500 次/秒。
- **读取统一收口。** 现在有约 69 处（分布在 23 个文件里，2026-10-25 统计）直接读 `lastHeartbeatAt`，统一改成调用在线状态接口；`runner.last_heartbeat_at` 降为低频记录，例如每 5 分钟写一次。
- **启动宽限期。** UNLOGGED 表在主库崩溃或主备切换后会被清空，所以 reaper 启动后有一段宽限期（例如 3 分钟），期间不回收任何会话。
- **大面积断线时暂停回收。** 如果单元内短时间有超过一定比例（例如 20%）的 runner 同时失联，或者在线状态写入出现异常，reaper 就暂停回收。这是把现有"数据库出问题时不把沉默当证据"的规则（`transaction-retry.ts:129`）推广开。

### 6.6 事件入库

- **第一步**：网关直接调用 API 现有的入库逻辑（D3），那 700 多行派生状态逻辑保持不动。
- **之后**：
  - 拆出独立的写入器进程（Go 或 Node），内部改用 gRPC。
  - 按会话哈希分到 256 个虚拟分区；写入器持有分区租约（带围栏号），交接完成后再写。
  - 会话行锁保留作为保险。
- **批量**：放宽持久事件的提交节奏（§5.8），多个会话的事件合批写入。

### 6.7 去掉逐条的 pg_notify

- 实时流改走 NATS。
- 持久事件的跨副本通知，改为写入器提交后按会话发布一次，不再逐条 NOTIFY。

---

## 7. runner 端

- **链路客户端**：拨号时遵循 `HTTPS_PROXY`；TLS；重连用带全抖动的指数退避，从 1s 起、上限 60s，并遵守 `Close.retry_after`；支持续传。
- **`doVia` 改走链路**（`src/runner-go/transport.go:285`），所有守护进程调用随之迁移。链路模式由开关控制，默认关闭（D15）：服务端的切换开关打开、或收到 `UPGRADE_REQUIRED` 时切到链路，`Welcome` / `HeartbeatAck` 说回到 HTTP 时退回。
- **inbox poller**：claude、codex、codex app-server、kimi、opencode、antigravity 这 6 处，先收成一个公共组件，再改成由提示驱动。
- **事件流**：确认、额度、内存缓冲与落盘、seq 续接；实时流支持停发。
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

---

## 10. 故障模式

| 故障 | 应对 |
|---|---|
| 网关节点宕机 | runner 带全抖动退避，重连到其他节点并续传；大面积断线时暂停回收，避免误判 |
| 后端发布或宕机 | 网关重试幂等请求，runner 不断线 |
| NATS 故障 | 提示和实时流降级，由心跳兜底；持久事件不受影响 |
| Postgres 主库切换 | 写库返回可重试错误，runner 先缓冲在内存、满了落盘；在线状态有宽限期，配合"大面积断线时暂停回收" |
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
3. 打开服务端切换开关 `RUNNER_LINK_REQUIRED` 并部署。全部旧守护进程路由（当前 49 个）统一返回 `UPGRADE_REQUIRED`。
4. runner 的处理：
   - 支持链路的 runner 收到 `UPGRADE_REQUIRED` 后，立即切到链路模式；
   - 还不支持的版本会触发自更新，升级后再切换。自更新最长等 10 分钟，此时没有 turn 在跑，`updateWhenNoTurnInFlight` 不会拦住；也可以手动执行 `orbit upgrade`。
5. runner 建立链路、接管会话；然后关闭"暂停派发"，排队的消息开始投递。
6. 观察 1 小时：连接数、确认延迟、错误率、会话恢复情况。

`Welcome` 和 `HeartbeatAck` 都带当前模式。开关关上时，runner 自动退回 HTTP 模式。

### 11.4 回滚

- **首选：关闭切换开关。** 旧路由恢复，runner 按 `Welcome` / `HeartbeatAck` 里的模式退回 HTTP。
- **第二道退路：版本回滚。** 服务端回到 vN-1，`/runner/release` 指定 vN-1 并标记回滚（`src/runner-go/selfupdate.go:420`），runner 降级后重新走 HTTP。
- 两种回滚都要在 staging 完整演练一次。

### 11.5 自托管用户

- **升级服务端就等于强制升级 runner。** 开着自更新的 runner 会自动升级；关了自更新的会看到 `UPGRADE_REQUIRED` 提示，需要手动执行 `orbit upgrade`。
- **发布说明要写清楚：** 需要新开一个链路域名或端口（不经过 Cloudflare）、新增 NATS 容器、调整防火墙规则。
- docker-compose 里增加网关和 NATS。

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
