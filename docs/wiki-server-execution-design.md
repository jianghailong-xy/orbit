# Orbit Wiki — 服务端执行与 System model（2026-10-07 草案）

> 状态：草案，待 owner 审。本方案取代 runner 上「维护会话」的执行方式（`docs/wiki-design.md` §0 第 6 条、§8.2）。知识模型、写入口、审阅模式和配额都不变。
>
> 修订：2026-10-07 owner 定下以下几点：
>
> - 新增一个 worker 服务来消费作业，用 Node.js 写；
> - 对 LLM 的请求经队列限制并发；
> - 两个待定项都按建议选 A：部署时不等在途请求（§13 第 1 条）；多个空间按"优先级 + 先来先得 + 每作业上限"分 GPU（§13 第 5 条）。
>
> 架构图见 `docs/mocks/wiki/34-server-execution.html`。

## 0. 一页结论

1. **新增 `wiki-worker` 服务（Node.js）。** 它和 apiserver 用同一个镜像、同一套 TypeScript 代码，只是换了入口命令，专门消费 wiki 作业。System model 的地址和 key 只配给 worker，API 进程不接触。
2. **对模型的请求全部进队列。** 队列是持久化的 `wiki_model_request`。调度器按全局并发上限 `ORBIT_WIKI_MODEL_CONCURRENCY` 取请求执行，起多个 worker 进程也不会超过这个数。
   - 请求按优先级先来先得：owner 主动发起的排在后台维护前面。
   - 模型不可达或 key 被拒时，整个队列暂停，状态在界面上可见。
3. **runner 只做仓库操作。** 包括 fetch `origin/main`、建索引、读指定片段、diff、锚点检查。
   - 通道照集成作业（`integration-job/v1`）的做法：runner 在心跳里领取，在会话池之外执行。
   - 不起 agent 会话，不占并发槽位，也不接触任何模型 key。
4. **作业和请求都落库，带租约。** 每个请求同时就是一个断点：
   - 部署导致 worker 重启后，已完成的请求直接复用；
   - 进行中的请求带着已收到的部分重新排队。
5. **用户看到的变化。**
   - wiki 设置里不再选 provider，改为只读显示 System model 及其状态。
   - 不再有隐藏的「Wiki maintenance」任务和会话；每次运行的进度、排队位置和逐次调用日志显示在 Wiki 的 Activity 里。
   - 不花任何用户的 key、订阅或账号池，也不占 runner 槽位。
6. **流水线移植成 TypeScript，在 worker 里运行。** worker 和 apiserver 共用代码，直接使用服务端已有的数据和写入口。要移植的是 Go 流水线里的模型部分：约 1.4 万行代码，另有 1.1 万行测试。
7. **分阶段上线。**
   - 执行器开关 `ORBIT_WIKI_EXECUTOR=runner|canary|server`。
   - 按"核实 → 文章 → 导入 → plan → 文档 → 维护"的顺序逐条移植。每条先只对 canary 账号生效，与旧路径对照后再全量切换。
   - 全部切完后，删除维护会话机制和 runner 侧的模型代码。

## 1. 为什么改

### 1.1 现状

- **执行**：每个 wiki 作业都是隐藏列表里的一个任务，加一个 agent 会话。会话里的模型只负责发一条 Bash 命令（`orbit wiki maintain` 等）；真正的流水线在 runner 的 Go 代码里，每次模型调用都起一个干净的 `claude -p --bare`（`src/runner-go/wiki_maintain.go` 开头的说明）。
- **模型**：用空间设置里 pin 的 provider，默认值是写死的 `local-vllm`（`src/shared/src/wiki.ts`）。claim 时 provider 的 key 被注入到 runner 上的会话环境里（`src/apiserver/src/providers/custom-provider.ts` 的 `injectedEnv`）。

### 1.2 问题

1. **花的是用户自己的额度。** wiki 用的是 pin 的那个 provider，也就是用户自己的 key 或订阅；每个用户都要自己配一个。
2. **占 runner。** 维护会话占用 `Runner.maxConcurrent` 槽位，没有豁免（`src/apiserver/src/queue/queue.service.ts` 的 claim SQL）。起草一次 plan 要 1–2 小时；runner 一离线，整个 wiki 就停了。
3. **并发没人管。** 每个运行各自最多 4 个并发调用；多个空间同时跑时，压到同一块 GPU 上的请求没有全局上限。
4. **key 暴露。** provider 的 key 在 runner 的会话环境里，那台机器的主人能读到。
5. **发布成本高。** 流水线每改一次都要发一次 runner 版本，例如 runner 0.1.210 的 Bash 白名单修复。
6. **机制复杂。** 为了让一个 agent 会话安全地只跑一条命令，堆了一整套机制：干净启动、`wiki-maintenance-run/v1` 能力、claim 时拒绝、Bash 超时提示、`dontAsk`。作业状态也绑在 Task 和 Session 上：`wiki_maintenance_run.task_id` 不可为空，健康状态读 Task，恢复读 Session。

### 1.3 目标

- **G1**：模型调用只在服务端进行，只用部署方配置的 System model；不使用任何用户的 provider、订阅或账号池；key 只在 worker 上。
- **G2**：runner 只做仓库操作，不起会话、不占槽位、不需要模型。
- **G3**：对模型的并发由一个全局队列限制，排队状态可见，部署方能看到用量。
- **G4**：部署和重启不丢进度。
- **G5**：runner 离线时，只有需要仓库的步骤等待，其余照常进行。
- **G6**：流水线改动随服务端部署生效，不再依赖 runner 发版（仓库操作本身除外）。

### 1.4 非目标

- 不改知识模型、写入口（`submitChangeset`）、审阅模式、`WIKI_QUOTA` 和熔断。
- v1 不支持"服务端拿用户自己的 provider 调 wiki"（BYOK），也不做多模型路由。
- 服务端不直接访问代码仓库：仓库凭据仍然只在 runner 上。
- 不把这个队列做成全平台通用的 LLM 网关（会话起标题等仍按原样）；需要时再推广。

## 2. 产品定义

### 2.1 部署方配置（`.env` → docker compose）

| 变量 | 给谁 | 必填 / 默认 | 说明 |
| --- | --- | --- | --- |
| `ORBIT_WIKI_MODEL_BASE_URL` | wiki-worker | 启用时必填 | 兼容 Anthropic Messages 的端点，例如 vLLM 的 `/v1/messages`；要填 **worker 容器能访问到** 的地址 |
| `ORBIT_WIKI_MODEL_API_KEY` | wiki-worker | 启用时必填 | 以 Bearer 方式发送 |
| `ORBIT_WIKI_MODEL` | wiki-worker | 启用时必填 | 模型名 |
| `ORBIT_WIKI_MODEL_CONCURRENCY` | wiki-worker | 默认 4 | 所有空间合计同时在途的模型请求数，由队列在数据库层面保证 |
| `ORBIT_WIKI_EXECUTOR` | apiserver、wiki-worker | 默认 `runner` | `runner`、`canary` 或 `server` |
| `ORBIT_WIKI_EXECUTOR_CANARY_OWNERS` | apiserver、wiki-worker | 默认空 | `canary` 模式下走服务端的账号，逗号分隔 |

- 改完执行 `docker compose up -d wiki-worker`（开关类的变量还要重建 apiserver）即生效，不需要数据迁移，也不需要给 runner 发版。
- apiserver 不需要 key。模型名和状态由 worker 写进状态表（§5.3），API 从那里读出来给界面。
- **地址**：容器跑在 compose 的默认网桥里，容器内的 `127.0.0.1` 是容器自己，`host.docker.internal` 也没有映射。vLLM 在宿主机或 GPU 机器上时，有两种填法：
  - 填局域网地址或隧道地址；
  - 给 wiki-worker 加 `extra_hosts: host.docker.internal:host-gateway`。
- **变量名**：不用 `ANTHROPIC_*`。在会话里跑 compose 时，这类名字会被会话自己的环境覆盖（`src/apiserver/src/wiki/wiki-compose-env.spec.ts`）。

### 2.2 用户看到的变化

- **Wiki 设置**：
  - 去掉 Provider 项，改为只读的「Model: System model · <模型名>」，并显示状态：未配置、不可达、key 被拒、worker 未运行，或正常。
  - Workspace 项保留，含义改为"从哪个 workspace（也就是哪台 runner）读仓库"。
- **Activity**：每次运行（维护、plan 起草/修订、文档构建、导入、核实）显示步骤进度和逐次调用日志（排队时长、耗时、token、错误）。正在排队的请求显示前面还有几个。不再链接到隐藏的任务和会话。
- **健康行**：新增几种原因：「等待 runner 上线」「System model 不可达」「System model 拒绝了 key」「System model 未配置」「wiki worker 未运行」。
- **导入**：`orbit wiki import` 仍在 runner 上运行，但只负责读文件、注册 note。条目由服务端作业抽取，命令行等作业结束后打印结果。
- **核实**：Automatic 空间里会话提议的 op，改由服务端作业核实，会话不用再跑 `orbit wiki verify`。这个命令保留，含义变为"请求服务端核实并等待结果"。
- **隐私说明**（设置页加一句）：wiki 的材料会发给本部署的 System model，包括会话记录摘要、条目和仓库片段。

### 2.3 额度语义

- 不花任何用户的 provider key、Claude/Codex 订阅或账号池，也不占 runner 槽位。
- 对 GPU 的压力由全局并发上限控制；超出的请求排队等待，不会被拒绝。
- 每日运行次数（`dailyRunLimit`）保留，用来保护审阅队列，但计数改为按运行行，不再按隐藏列表里的任务。追赶期间的"本地端点不计数"，改为看 System model 的地址是否在本机或私网。
- `WIKI_QUOTA`、审阅队列上限和熔断都不变。

## 3. 架构

```text
apiserver（API 进程）                  wiki-worker（新服务，同一镜像）               System model
  触发器（事实驱动）
     │ 建作业
     ▼
  wiki_job ───────(租约)──────────▶ 作业执行（TS 流水线）
                                        │ 每次模型调用入队
                                        ▼
                                  wiki_model_request ──▶ 调度器（全局并发 N，优先级）──▶ /v1/messages
                                        │
  runner-door ◀──── wiki_repo_op ◀──────┘ 仓库操作请求
     ▲ 心跳领取 / 回传结果
  runner（git，在会话池之外执行）

  写入口（submitChangeset / drafts / docs，不变）◀── 作业执行
```

| 组件 | 在哪 | 内容 |
| --- | --- | --- |
| 触发与接口 | apiserver | 事实触发器改为建作业而不是建任务；Activity 和健康的读接口；runner 仓库操作的领取与回传 |
| 作业执行 | wiki-worker | `wiki_job` 的领取、续租和执行；流水线（verify、articles、import、plan draft/revise、docs build、maintain）直接调用服务端已有的函数：案卷、材料、核实证据、写入口 |
| 模型请求队列 | wiki-worker | `wiki_model_request` 入队与调度（全局并发、优先级）、流式客户端、`/health` 探测、遇 401 暂停、重试、超时、用量记录、模型状态 |
| 仓库操作 | apiserver + runner | `wiki_repo_op` 表；runner 侧的 `wiki-repo-op/v1` 执行器，复用 `wiki_anchors.go`、`wiki_plan_repo.go`、`wiki_docs_build.go` 里读 git 的代码 |

## 4. 关键决策

### 4.1 新增 wiki-worker 服务（owner 2026-10-07 同意）

- **形态**：
  - 和 apiserver 共用 `orbit-apiserver:local` 镜像，用 `command:` 换成 worker 入口。2026-09-01 之前的几个旁路容器就是这种做法。
  - 不跑数据库迁移：用 `depends_on` 等 apiserver 健康后再启动，迁移由 apiserver 开机时完成。
  - 设置 `restart: unless-stopped`，`stop_grace_period: 30s`。
- **为什么单独成服务**：
  - 几小时的流式调用和聚类计算不压在 API 进程上；
  - 模型的 key 只给 worker；
  - worker 挂了不影响读、搜和人工编辑；
  - 以后需要时可以加 worker 进程，并发上限由队列保证，不用改。
- **需要同步修改的**：
  - `test/compose-topology.test.mjs`：服务数、restart 策略、行数规则 (k)，按这次 owner 的决定修改并在文件里记录；
  - upgrade skill：构建和 `up -d --wait` 加上 wiki-worker；
  - `docs/configuration.md`、`docs/self-hosting.md`。

### 4.2 worker 用 Node.js（TypeScript），流水线从 Go 移植过来

- worker 和 apiserver 共用代码，可以直接使用 Prisma 和 wiki 服务：
  - 案卷：`wiki-dossier.ts`
  - plan 材料
  - 核实证据：`wiki-verify-evidence.ts`
  - 文章输入
  - 文档材料：`wiki-docs-material.ts`
  - 写入口

  这样就省掉了 runner-door 的 HTTP 胶水和会话鉴权上的特例。
- 如果在服务端复用 Go，需要为它新造一个跨用户的系统身份、一整套内部接口，还要把读 git 的代码改成读快照，收益不如移植。
- 模型调用和仓库读取耦合得不紧：
  - 模型调用函数只有 4 个：`askWikiVerifier`、`askWikiModel`、`askWikiPlanModel`、`askWikiImportModel`。它们的入参只是配置、system prompt 和 user prompt，与仓库无关。
  - 与仓库的耦合集中在少数几处检查上（§7），可以改成查快照。
- 合同常量已经在 TypeScript 里（`src/shared`）。移植后，wiki 的规则只剩一份实现。
- 风险控制：
  - 自下而上逐条移植；
  - Go 测试的用例逐条改写成 TS 测试；
  - 在 canary 上和旧路径对照：解析、门检查、配额这类确定性部分逐字比较。

### 4.3 仓库内容：runner 交快照，服务端查快照

- runner 在 `origin/main` 上建一份快照：
  - 路径列表（含大小）
  - 文档标题
  - 符号索引
  - `origin/main` 可达的提交集合
  - README 首段

  快照按 sha 缓存，同一个 sha 只传一次。
- 需要原文时按需读取：读指定 sha 上指定路径的片段，单个文件和单次请求都有上限。上限沿用现值：文档一节 4,200 字、合同 2,500 字、每节最多 22,000 字。
- 为什么不直接上传原文：
  - plan 起草要读本仓库约 27 MB 原文（113 篇文档、1,374 个源文件），远超 API 10 MB 的请求体上限（`src/apiserver/src/main.ts`）；
  - 真正写进 prompt 的只有几万字的摘要。
- 门检查（`hasPath` / `hasDocSection` / `hasSymbol`）、锚点（路径和提交可达性）和脚注核对，都在快照上查，不必每次都回 runner 问。

### 4.4 v1 只用 System model

- 部署没配 System model 时，执行器保持 `runner` 模式。如果开了 `server` 模式却没配，作业会挂起，健康行写明原因。
- "服务端拿用户自己的 provider 调用"放到以后，有需要再加。

### 4.5 Node.js 实现要点（owner 2026-10-07 定：worker 用 Node.js）

- **入口**：
  - 代码放在 `src/apiserver/src/wiki-worker/main.ts`，编译后是 `dist/wiki-worker/main.js`。
  - 用 `NestFactory.createApplicationContext` 起一个不监听端口的 Nest 上下文，只引入 Prisma 和 wiki 服务，不引入控制器；打开 `enableShutdownHooks()`。
  - compose 里写 `command: node src/apiserver/dist/wiki-worker/main.js`。镜像和 Dockerfile 都不变（`node:26-slim`）。
- **模型客户端**：
  - 用 Node 自带的 `fetch`（undici）流式读取，自己解析 Anthropic Messages 的 SSE 事件：`message_start`、`content_block_delta`、`message_delta`（含用量）、`message_stop`、`error`。
  - 超时、空闲断开和取消都用 `AbortController`。
  - 复用连接，连接池大小不小于 N。
- **唤醒**：Prisma 不能 LISTEN。用一条专用的 `pg` 连接监听 `pg_notify`，和 `src/apiserver/src/realtime/realtime.service.ts` 的做法一样，另有轮询兜底。
- **事件循环**：
  - worker 的工作以 I/O 为主，单进程就够。
  - TF-IDF k-means 聚类是 CPU 计算，规模不大（几千条标题），但必须分片让出事件循环，或者放进 `worker_threads`。否则续租定时器会被拖住，租约过期后作业可能被重复领取。
- **测试**：
  - 沿用 apiserver 的 `node:test` 和 pg spec（`bash scripts/run-pg-spec.sh`）。
  - 用一个本地 Node http 服务模拟 System model：SSE 流、`/health`，以及 429、5xx、401 等返回。
- **runner 侧仍然是 Go**：只有仓库操作留在 runner 上，复用现有的 Go 代码。

## 5. 作业与模型请求队列

### 5.1 作业 `wiki_job`

- 字段：
  - 身份：`id`、`owner_id`、`space_id`
  - 种类：`kind`，取值为 verify / articles / import / plan_draft / plan_revise / docs_build / maintain
  - 输入、优先级与状态：`input`；`priority`（owner 主动发起的高于后台维护）；`state`，取值为 queued / running / waiting / succeeded / failed / cancelled；`waiting_for`，取值为 repo / model / null
  - 重试：`attempts`、`next_attempt_at`
  - 租约：`lease_owner`、`lease_generation`、`lease_deadline_at`
  - 结果：`progress`、`report`、`error`；`failure_kind`，取值为 infra / content
  - 时间：`created_at`、`started_at`、`ended_at`
- 领取：照 `watch_delivery` 的做法。
  - 用 `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` 领取，每次领取给这一行一个新代数；
  - 所有回写都按代数做比较并交换；
  - 租约 60 秒，执行中定期续租；
  - 过期回收：租约已过期的作业放回 queued。
- 文章作业（`articles`）由维护运行的结束触发，规则见 §8（owner 2026-10-08 定）。
- 同一个空间同一时间只跑一个作业，沿用隐藏列表 `maxConcurrent 1` 的语义。一个 worker 同时执行的作业数另有上限。作业大部分时间在等模型，真正压在 GPU 上的量由 §5.2 的队列决定。
- `wiki_maintenance_run`、`wiki_plan_job`：增加 `job_id`，`task_id` 改为可空，用 CHECK 约束二者必有其一。健康状态和每日计数改为读运行行，不再读 Task 和 Session。

### 5.2 模型请求队列 `wiki_model_request`

- 字段：
  - 定位：`id`、`job_id`、`owner_id`、`space_id`、`step`、`unit`、`attempt`
  - 请求：`priority`；`request`（system、prompt、max_tokens）；`request_sha256`
  - 状态：`state`，取值为 queued / running / succeeded / failed / cancelled
  - 租约：`lease_owner`、`lease_generation`、`lease_deadline_at`
  - 时间：`enqueued_at`、`not_before`（退避）、`started_at`、`ended_at`
  - 结果：`answer`、`partial`（中断时已经收到的部分）、`input_tokens`、`output_tokens`、`http_status`、`error`
- **请求即断点**：(job_id, step, unit, attempt) 唯一。流水线重放时：
  - 找到已成功、且答案仍能解析的请求，就直接用它的答案（与 runner 现在"工作目录里的答案仍能解析就复用"一致）；
  - 请求还在排队或执行中，就继续等它。
- **全局并发**：调度器在一个事务里：
  1. 先拿一把 advisory 锁；
  2. 数出"running 且租约未过期"的行；
  3. 只领取 N 减去这个数的请求，按 `priority` 降序、`enqueued_at` 升序，`FOR UPDATE SKIP LOCKED`，每行一个新代数。

  这样无论起几个 worker 进程，同时在途的请求都不超过 `ORBIT_WIKI_MODEL_CONCURRENCY`。
- **公平**：
  - owner 主动发起的请求优先：plan 起草/修订、文档构建、命令行导入、会话在等的核实；
  - 同一优先级先来先得；
  - 各流水线自身的并发上限（每个作业最多 4 个在途请求）避免单个作业占满队列。
- **执行**：
  - 流式调用，定期把 `partial` 写回并续租；
  - 结束时按代数比较并写入结果；
  - 用 `pg_notify` 通知等待的作业，轮询兜底。
- **过期回收**：租约过期的 running 行回到 queued，`attempts` 加 1。
- **可见性**：Activity 里显示每个请求的排队时长和排在第几；`/api/metrics` 增加以下序列：
  - 队列深度、在途数
  - 排队和执行耗时（p50 / p95）
  - token 数
  - 按 HTTP 状态统计的错误数

### 5.3 模型状态 `wiki_model_status`（单行）

- 由 worker 写入：
  - 状态：`state`，取值为 up / down / auth_failed / unconfigured
  - 模型：`model`
  - 时间与原因：`since`、`last_error`、`checked_at`
  - worker 心跳：`worker_seen_at`
- **down**：停止领取，每 10 秒查一次 `/health`，恢复后自动继续。
- **auth_failed**（401）：停止领取，等部署方改好 key、重启 worker。理由与现在相同：后面的每次调用都会以同样方式被拒。
- 在 down 和 auth_failed 期间，请求留在队列里不动。等待超过各流水线现有的上限（抽取和文档 3 分钟、导入 10 分钟、plan 20 分钟）后，这次请求失败，作业按 infra 失败处理，稍后重试。
- API 读这一行，给设置页、健康行和 Activity 显示状态。`worker_seen_at` 过期就显示「wiki worker 未运行」。

### 5.4 停机与续跑

- worker 收到 SIGTERM 时（容器有 30 秒宽限）：
  1. 停止领取新的作业和请求；
  2. 中止在途的请求，把已经收到的部分存进 `partial`；
  3. 把租约截止时间设为当前时间，让新进程立即接手。
- 被打断的请求：如果端点支持 assistant 预填，就带上 `partial` 接着生成；否则整次重做。plan 骨架这类长调用最长约 13 分钟。
- 所有写入都沿用现有的幂等键（changesets、drafts、docs），重放不会重复写。

### 5.5 失败与恢复

| 失败 | 处理 |
| --- | --- |
| infra：端点不可达、5xx、429、runner 离线、worker 重启 | 退避重试，不计入连续失败；健康行显示在等什么 |
| 401 | 队列暂停（§5.3），健康行写明 key 被拒 |
| content：模型给不出可解析的结果、服务端拒绝 | 结束作业，计入连续失败；连续 3 次通知 owner（与现在一致） |
| owner 关闭维护或删除空间 | 作业和它排队中的请求改为 cancelled |

## 6. 模型调用（Claude Code 现在隐式做的事，要显式实现）

- **请求**：
  - `POST {base}/v1/messages`，带 `Authorization: Bearer` 和 `anthropic-version: 2023-06-01`，`stream: true`。
  - system 用各流水线现有的 system prompt，内容是一条 user 消息。
  - 不带 tools，不开 thinking。
- **`max_tokens`**：plan 用 32,000（现值）。其余步骤现在用的是 Claude Code 对未知模型的默认值，P1 实测后定一个显式值，写进合同。
- **健康检查**：`GET {base}/health`，返回 200 或 404 都算在线。由调度器统一探测（§5.3）。
- **重试**：5xx、429 和连接错误按 0 / 10 / 30 秒退避，请求重新排队。现在其中一部分靠 Claude Code 隐式重试，这里要自己实现。
- **超时**：沿用每一步的上限：核实、抽取、导入、文章 15 分钟，文档 20 分钟，plan 60 分钟。另加一个空闲超时：5 分钟没收到任何字节就断开。
- **用量**：每次请求的 token 记在队列行上，每个作业的合计写进它的 report。

## 7. 仓库操作（runner）

- **能力与表**：能力名 `wiki-repo-op/v1`，表 `wiki_repo_op`，字段：
  - 关联：`job_id`、`space_id`、`workspace_id`、`runner_id`
  - 内容：`kind`、`input`、`state`
  - 租约：`lease_owner`、`claim_generation`、`claimed_at`、`heartbeat_at`
  - 结果：`result`、`error`
- **下发**：照集成作业。
  - worker 建仓库操作，apiserver 调用 `notifyRunnerWake` 让 runner 立即发一次心跳。
  - runner 在心跳响应里领取（`FOR UPDATE SKIP LOCKED`，每次心跳最多 2 个）。
  - 按 `workspace.runner_id` 路由，并把 `workDir` 一起下发。
- **执行**：runner 在会话池之外的 goroutine 里执行，不占槽位。结果提交到 `POST /runner/wiki/repo-ops/:id/result`，按租约持有者加代数做校验，过期的回写返回 409 STALE_CLAIM。worker 通过 `pg_notify` 得知结果已到。
- **种类**：
  - `snapshot`：fetch 后得到 sha，生成索引：路径和大小、文档标题、符号、可达提交集合、README 首段。超过 10 MB 的请求体上限时分片上传。
  - `read`：给定 sha 和路径列表，返回有上限的文本片段，也包括脚注核对要用的整个文件；单个文件有上限。
  - `diff`：两个 sha 之间的 `--name-status -M`，以及新增的设计文档（`--diff-filter=AR -- docs/`）。
  - `anchors`：现有的锚点检查（`wiki_anchors.go`），直接复用。
- **安全检查**：沿用现有检查：origin URL 要和空间的 `repo.urlNorm` 一致，根提交要匹配，否则报错。
- **服务端缓存**：每个空间只保留最近一份快照及其片段，只对 owner 可见；空间删除时一起清理。
- **旧 runner**：没声明这个能力的 runner，需要仓库的步骤会挂起，健康行提示升级 runner。

## 8. 各流水线怎么搬

| 流水线 | 现在的 Go 代码 | 服务端已有的输入 | 需要的仓库操作 | 阶段 |
| --- | --- | --- | --- | --- |
| 核实 verify | 937 行 | 核实证据 | 无 | P3 |
| 文章 articles | 1,363 行 | 文章输入；聚类要移植 | 快照的 sha（作为 ref） | P4 |
| 导入 import | 2,014 行 | note 文本 | 快照（锚点：路径和提交） | P5 |
| plan 起草/修订 | 约 5,200 行 | plan 材料；聚类要移植 | 快照（索引）+ read | P6 |
| 文档构建 docs build | 2,679 行 | 文档材料 | 快照 + read（片段、脚注） | P7 |
| 维护 maintain | 3,252 行（含文档步骤） | 案卷 | 快照、diff、anchors | P8 |

- **文章的触发（owner 2026-10-08 定）**：
  - runner 模式下不变：维护运行自判据 3 第 3 版起不再重写主题文章，也没有别的东西自动重写。
  - 服务端执行的账号（`server`，或 `canary` 名单内）：一次维护运行成功结束、记下了 op、且不在追赶期（追赶进行中或暂停时都不建）时，服务端给这个空间排一个 `articles` 作业。runner 跑的维护运行也算，触发点在服务端记录运行结束的地方（finish 路由）；P8 的服务端维护作业结束时调用同一个入口。
  - 每个空间最多排一个，后台优先级 0，排在 owner 主动发起的请求之后；作业只重写指纹变了的主题。
  - 文章的 ref 取该空间最近一份仓库快照的 sha；还没有快照时先请求一次，作业挂起等它。
  - 对这样的账号，runner 门的文章三条路由回 `WIKI_SERVER_EXECUTES`，会话不再拿自己的 provider 写文章。

agent 会话用的 wiki 工具（`wiki_search` / `wiki_get` / `wiki_propose`，见 `src/runner-go/wiki_tools.go`）不在本次范围内，保持不变。

## 9. 安全

- **key**：只在 wiki-worker 的环境变量里。不进 apiserver，不写数据库，不出现在任何 API 响应里，不下发给 runner。客户端只看得到模型名和状态。
- **System model 地址**：这是部署方配置的可信地址，不套用 provider 连接测试里的 SSRF 限制，但地址本身不返回给客户端。
- **仓库片段**：进入服务端是一类新数据。
  - 只保留最近一份，只对 owner 可见，随空间删除。
  - 发给模型前过共享脱敏器，带上 workspace.env 里的值，与 note 的处理一致。
- **隔离**：作业、模型请求和仓库操作都按 owner 和空间划分；仓库操作只发给该空间 workspace 所在的那台 runner。

## 10. 迁移与上线

- **开关 `ORBIT_WIKI_EXECUTOR`**：
  - `runner`：默认值，行为和今天完全一样；
  - `canary`：名单内的账号走服务端；
  - `server`：全部走服务端。
- **worker 先上线**：worker 可以先部署。开关还是 `runner` 时它没有作业，只负责探测模型、写状态，所以可以提前验证地址和 key。
- **逐条生效**：每条流水线移植完成后，先只对 canary 账号生效；旧路径一直保留到 P10。
- **canary 对照**：
  - 确定性部分（解析、门检查、配额、熔断）：对同一份输入逐字比较；
  - 生成部分：看门检查通过率、核实结论的分布、排队和执行耗时、token。
- **回退**：把开关改回 `runner` 即可。服务端在途的作业和请求会被取消，游标的语义保证下一次会重新读取这些内容。
- **收尾（P10）**：
  - 删除维护会话机制：claim 拒绝、干净启动、`wiki-maintenance-run/v1`，以及隐藏列表里任务的这种用法；
  - 删除 runner 侧的模型代码；
  - 重写合同的相应章节；
  - 把默认值改为 `server`。

## 11. 合同与文档

- **`contracts/wiki.contract.json`**：
  - 新增 `systemModel`、`jobs`、`modelQueue`、`repoOps`；
  - 改写 `maintenance.run` / `session` / `list`、`plan.jobs.task` / `run`、`agentSurface.verify`、`articles.cleanClaudeCode`、`import.cli.model`；
  - 删除 `space.settings.maintenance.provider`。
- **文档**：`docs/wiki-contract.md`、`docs/wiki-design.md` 的 §0 和 §8、`docs/configuration.md`、`docs/self-hosting.md`、upgrade skill 的说明。

## 12. 分阶段与判据

| 阶段 | 内容 | 判据 |
| --- | --- | --- |
| P0 | 本设计和合同修订稿 | owner 确认 |
| P1 | wiki-worker 服务（compose、upgrade skill、拓扑测试）；System model 配置和客户端；`wiki_job`；模型请求队列（全局并发、优先级、模型状态）；停机续跑；执行器开关；metrics | pg spec 覆盖：并发不超过 N（多个调度器同时领取）、租约和过期回收、重启续跑、401 暂停、down 后恢复；对 fake 端点跑通一个冒烟作业 |
| P2 | runner 仓库操作：`wiki-repo-op/v1`，包括 snapshot / read / diff / anchors | runner 发版后，服务端能拿到本仓库的快照，大小和耗时有记录；spec 断言不占槽位 |
| P3 | 核实移到服务端 | canary 空间里待核实的 op 由服务端给出结论；会话不再需要跑 verify |
| P4 | 文章 | canary 空间的文章由服务端写出，脚注检查通过 |
| P5 | 导入 | canary 上的 `orbit wiki import` 由服务端抽取条目 |
| P6 | plan 起草和修订 | canary 上起草一次 plan，并通过门检查 |
| P7 | 文档构建 | canary 上完成一次文档构建 |
| P8 | 维护运行 | canary 空间连续 N 次维护运行成功，游标推进 |
| P9 | 客户端（Web 和 macOS/iOS）：设置、Activity 里的运行详情和排队状态、健康原因、文案对照 | 三端的对照测试通过 |
| P10 | 本部署切到 `server`；观察一周后删除旧路径、清理合同 | 删除旧路径后全量测试通过 |

- 依赖关系：
  - P3–P7 等 P1、P2 完成后可以并行；
  - P8 依赖 P3、P6、P7；
  - P9 从 P3 开始就可以并行。
- 适合登记成 Orbit 项目，每个阶段一个任务。

## 13. 风险与未决

1. **部署会重启 worker。** worker 和 apiserver 用同一个镜像，每次部署都会被重建。请求即断点，加上续写，可以减少损失；但 plan 骨架这类长调用仍可能被重做。
   - **owner 2026-10-07 定：选 A，部署时不等在途请求**。worker 被重建时中止在途请求，带着 partial 回到队列。
   - 如果重做太多，再考虑方案 B：部署前先排空在途请求。
2. **移植后行为跑偏。** 靠逐条移植测试和 canary 对照来发现；P10 之前旧路径一直都在。
3. **worker 访问不到 vLLM。** 需要部署方提供一个可访问的地址，或者给 wiki-worker 加 `extra_hosts`。
4. **仓库内容进入服务端。** 合规上需要部署方知情，设置页给出说明。
5. **公平性。** **owner 2026-10-07 定：选 A**，按"优先级 + 先来先得 + 每作业上限"分 GPU。如果出现某个空间长期占满队列，再加方案 B：同一优先级内按空间轮转。
6. **Claude Code 的隐式默认值。** `max_tokens`、重试这些，要在 P1 实测后显式写进合同。
7. **多副本。** compose 只跑一个 apiserver 和一个 worker，但租约和并发上限都按多进程安全来设计。
