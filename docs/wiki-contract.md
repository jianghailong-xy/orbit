# Orbit Wiki 契约（v1，阶段 1）

**状态**：任务「T2 wiki 契约、迁移与共享类型」的产物，是项目「Orbit Wiki · 阶段 1」其余任务（T3 写入口与 REST、
T4 检索、T5 runner 工具、T6 推送、T7 实时事件、T8–T10 客户端）的接口来源。任何闭集、状态、限制、生效策略或拒绝码的
改动，都先改 [`contracts/wiki.contract.json`](../contracts/wiki.contract.json)：它是手写的权威，本文只是把它讲成人话，
两者不一致时以 JSON 为准。

**基线**：`origin/main` = `083d61fc5a853af1c0fc65b9b681eb37a8e8d56e`（2026-09-25 12:35 +02:00）。

**阶段 2 的增补（判据 7：审阅模式，2026-09-27）**：space 设置 `reviewMode`（Manual / Tiered / Automatic）、两个新 trust
`auto` 与 `unreviewed`、五条安全底线、抽检、整次撤回与逐条 Reject，见新增的 §7.3；迁移
`0311_wiki_review_modes`；各节里受影响的地方已随之改写。JSON 里对应的是 `reviewModes` 一节。

**判据 7 第 3 版（owner 2026-09-27）：Automatic 先核实再生效**：Automatic 收下的 op 先进入「待核实」
（op 决定 `verifying`），由 `orbit wiki verify` 用干净的 Claude Code 调本地模型给出四种结论之一再按结论生效；核实结论
留痕在 op 上；拒绝率超阈值自动退回 Tiered；Automatic 默认不发抽检卡；抽检卡不再占 30 条待审名额。见 §7.4，迁移
`0312_wiki_verification`，JSON 里是 `reviewModes.verification` 与 `agentSurface.verify`。

**判据 2（阶段 2，2026-09-28）：案卷与游标**：space 设置 `maintenance`（默认关闭、只有 owner 能改，打开时建隐藏的
「Wiki maintenance」清单）、维护会话的判定、服务端确定性抽取的会话案卷、`wiki_cursor` 的水位与 backlog、两个新拒绝码
`WIKI_CURSOR_BEHIND` / `WIKI_CURSOR_INVALID`，见新增的 §16；迁移 `0315_wiki_cursor`，JSON 里是 `space.settings.maintenance` 与
`maintenance` 一节。

**判据 9（阶段 2，2026-09-28）：文档视图 · 生成**：主题有显示名和所属大类（`wiki_topic.category`，六类闭集）；每个主题一篇由
本地模型从 active 条目写成、句句带脚注的文章，大主题拆成子主题文章加一篇总览，存进可丢弃的缓存 `wiki_topic_summary`；
归主题先看条目锚到的代码路径；脚注和字数由代码校验；一个新拒绝码 `WIKI_ARTICLE_STALE`，见新增的 §18；迁移
`0317_wiki_topic_articles`，JSON 里是 `articles` 一节。

**判据 11（阶段 2，2026-09-29）：Wiki plan**：写文档之前先有 plan——大类、文档、每篇的读者与范围、大纲，以及每一节从哪里取材；
本地模型起草，服务端检查闸把关（schema、篇数、受保护的篇、引用），owner 只经 JWT 门确认；plan 留版本，已确认的版本不再改动；
维护作业落不进任何一节的知识产出「plan 修改建议」，owner 接受后才变成新草稿。三个新拒绝码 `WIKI_PLAN_GATE` /
`WIKI_PLAN_STALE` / `WIKI_PLAN_UNCONFIRMED`，写文档的入口先调 `requireConfirmedPlan`，见新增的 §21；迁移 `0325_wiki_plan`，
JSON 里是 `plan` 一节。

**判据 9 第 2 版（阶段 2，2026-09-29）：文档**：给人读的主视图改为按确认的 plan 逐节写的文档；脚注指向一手原文（设计文档、代码、
契约带 `path@sha#L起-止`，会话记录带 id 与字符区间）并附逐字引文，条目只作 via entry；会话记录的引文由服务端重读原文逐字核对，
仓库引文收 runner 在某 sha 上的核对；逐句存状态与脚注明细，超过 5% 无出处或核对不过整篇待审；某节材料指纹不变不重写，每节记下
生成时的 origin/main 提交；条目被拒、退役或锚点失效时经它引用的句子撤下；一个新拒绝码 `WIKI_DOC_INVALID`，见新增的 §22；
迁移 `0326_wiki_docs`，JSON 里是 `docs` 一节。§18 的按主题文章保留，直到客户端切换。

**服务端执行 P1a（项目「Wiki 服务端执行与 System model」，2026-10-07）：wiki-worker 与 System model**：新增 compose 服务
`wiki-worker`（与 apiserver 同一镜像，换入口），System model 的地址和 key 只配给它；worker 每 10 秒探测 `{base}/health`，把模型状态
和自己的心跳写进单行表 `wiki_model_status`；apiserver 经 `GET /api/wiki/system-model` 只给出模型名和状态，心跳过期时是
`worker_not_running`。流式客户端（`/v1/messages`、SSE、单次超时、空闲断开、取消、错误分三类）也在这一期；作业表、请求队列和执行器开关在
P1b。见新增的 §23，迁移 `0400_wiki_model_status`，JSON 里是 `systemModel` 一节。

**服务端执行 P1b（2026-10-08）：作业与模型请求队列**：新增 `wiki_job`（服务端作业的领取、租约、代数、重试，同一空间同时只跑一个）
与 `wiki_model_request`（所有模型调用的持久化队列：`(job_id, step, unit, attempt)` 唯一即断点，advisory 锁里数在途数再按并发上限
领取，中断的请求带着 partial 重排队）；`wiki_maintenance_run` 与 `wiki_plan_job` 增加 `job_id`、`task_id` 改为可空；执行器开关
`ORBIT_WIKI_EXECUTOR`（默认 `runner`，行为不变）在这一期只由 worker 读；作业种类先只有端到端验证队列用的 `smoke`。见新增的 §24、§25，
迁移 `0401_wiki_job`，JSON 里是 `jobs` 与 `modelQueue` 两节。

**服务端执行 P4（2026-10-08）：文章**：执行器把账号交给服务端时（`server`，或 `canary` 名单内），主题文章由 wiki-worker 的
`articles` 作业用 System model 写：维护运行成功结束、记下了 op、且不在追赶期时，服务端给该空间排一个文章作业（owner 2026-10-08 定），
只重写指纹变了的主题；文章的 ref 取空间最近一份仓库快照的 sha，没有快照就先请求一次。runner 门对这样的账号回新拒绝码
`WIKI_SERVER_EXECUTES`（409），`orbit wiki articles` 读到它就说明文章由服务端写、不调模型、以 0 退出。runner 模式下一切照旧：
维护运行自判据 3 第 3 版起不再重写文章。见新增的 §18.8，JSON 里是 `articles.serverExecution`、`articles.job` 与
`jobs.kindRuns.articles`。

**权威来源**

| 来源 | 位置 |
| --- | --- |
| 机器可读契约与测试向量 | `contracts/wiki.contract.json` |
| 设计全文与效果图 | [`wiki-design.md`](./wiki-design.md)、[`mocks/wiki/`](./mocks/wiki/) |
| 迁移 | `src/apiserver/prisma/migrations/0307_wiki/migration.sql`、`0311_wiki_review_modes/migration.sql`、`0312_wiki_verification/migration.sql`，`schema.prisma` 的 `Wiki*` 九个 model |
| TS 闭集、wire 类型、`KIND_SPECS` 与校验函数 | `src/shared/src/wiki.ts` |
| 契约测试（TS ↔ JSON） | `src/shared/src/wikiContract.spec.ts` |
| 库结构测试（库 ↔ JSON） | `src/apiserver/src/wiki/wiki-schema.pg.spec.ts`，经 `scripts/run-pg-spec.sh` 跑 |
| 审阅模式的行为测试 | `src/apiserver/src/wiki/wiki-review-mode.pg.spec.ts`，经 `scripts/run-pg-spec.sh` 跑 |
| Automatic 核实的行为测试 | `src/apiserver/src/wiki/wiki-verify.pg.spec.ts`（服务端），`src/runner-go/wiki_verify_test.go`（`orbit wiki verify`，假 vLLM 端点） |
| 案卷与游标的行为测试 | `src/apiserver/src/wiki/wiki-dossier.pg.spec.ts`（服务端），`src/runner-go/wiki_dossier_test.go`（`orbit wiki dossier` / `orbit wiki cursor advance`） |
| 文章的行为测试 | `src/apiserver/src/wiki/wiki-articles.pg.spec.ts`（服务端），`src/runner-go/wiki_articles_test.go`（`orbit wiki articles`，假 vLLM 端点），`WikiArticlesContractTests.swift`（OrbitKit）；服务端执行：`src/apiserver/src/wiki-worker/wiki-articles-writer.spec.ts`、`wiki-articles-job.spec.ts`、`wiki-articles-job.pg.spec.ts`，两条路径共用 `src/shared/src/wiki-article-writer.fixture.json` |
| plan 的行为测试 | `src/apiserver/src/wiki/wiki-plan.pg.spec.ts`（服务端：检查闸、版本、确认、修改建议、跨租户），`src/runner-go/wiki_plan_test.go`（runner 门三条路由与检查闸的错误），`WikiPlanContractTests.swift`（OrbitKit） |
| System model 的行为测试 | `src/apiserver/src/wiki-worker/wiki-model-status.pg.spec.ts`（状态行、读接口、心跳与 worker 启停），`wiki-model-client.spec.ts`（本地 http 服务模拟 SSE），`test/compose-topology.test.mjs`（compose 里的 `wiki-worker`） |
| 服务端核实的行为测试 | `src/apiserver/src/wiki-worker/wiki-verify.spec.ts`（提示词、编号、结论解析，照 `wiki_verify_test.go` 改写），`wiki-verify-job.pg.spec.ts`（建作业、跑作业、结论落库，对 fake System model）|

**本任务不做**：服务、控制器、MCP 工具、推送、实时事件的实现，以及任何 UI。它们各自的任务照本契约写。

---

## 0. 一页结论

1. **规范存储是条目，不是页面。** 页面、决策日志、时间线、给 agent 的切片都是条目的投影，库里没有它们的表（§1）。
2. **租户边界落在库里。** 只有 `wiki_space` 直接指向 `user`；其余八张表各自带 `owner_id`，并通过
   `(父 id, owner_id)` 复合外键挂在父行下，所以子行不可能和父行属于不同 owner。删除 owner 仍会经由 space 删掉全部行（§1.2）。
3. **指向历史的 id 不挂外键。** 会话、tool call、作者、出处的 `ref` 都是快照；原记录删了，id 作为墓碑留下（§1.3）。
4. **闭集一律是 CHECK。** 取值与 JSON 完全一致，pg spec 逐个值写入、写一个闭集外的值被拒，并核对 CHECK 列出的值（§6、§7）。
5. **agent 只能提议。** 能立即生效的只有 owner 自己的写入、reinforce / challenge 两种安全操作，以及 space 的审阅模式
   放行的 add / amend（§7.3）；安全底线在任何模式下都不放开，决定、撤回、逐条 Reject、切换模式只在 owner 通道（§7）。
6. **每类条目有自己的字段 schema。** `KIND_SPECS` 与 JSON 的 `kinds.<kind>.fields` 逐字段相等，校验失败按字段路径报错（§3）。
7. **`wiki.changed` 只带 space 的 id**，丢了只影响客户端多等一会儿（§12）。

---

## 1. 存储

### 1.1 九张表

| 表 | 是什么 |
| --- | --- |
| `wiki_space` | 一个 owner 的一个代码库的 wiki，含设置 |
| `wiki_space_workspace` | 哪些 workspace 的会话读这个 space；一个 workspace 最多绑一个 |
| `wiki_topic` | 条目的主题分组，以及落在它下面的锚点路径前缀 |
| `wiki_entry` | 谱系行：id 跨修订不变（`orbit-wiki:<id>` 指向它），带当前修订的内容、status、trust 与推送要读的标记 |
| `wiki_entry_revision` | 每一版，只插入不更新；`(entry_id, revision)` 唯一 |
| `wiki_source` | 某一版引用的一手记录，以及其中不超过 300 字的引文 |
| `wiki_changeset` | 一次提交（agent 的提议或 owner 的编辑），带幂等键和在 Review 里的状态 |
| `wiki_changeset_op` | 提交里的一个 op，以及 owner 对它的决定 |
| `wiki_exposure` | 哪个会话、通过什么渠道、收到了哪条的哪一版 |

id 一律 `uuid(7)`，由 Prisma 生成，库里不给默认值。

### 1.2 租户：为什么子表不直接指向 `user`

- `wiki_space.owner_id → user(id) ON DELETE CASCADE`，这是唯一一条指向 `user` 的外键。
- 其余每张表都有 `owner_id`，并通过复合外键挂到父行：绑定、主题、条目、变更集挂 space；修订、曝光挂条目；出处挂修订；
  op 挂变更集。绑定还通过 `(workspace_id, owner_id)` 挂 workspace，为此迁移在 `workspace` 上加了
  `(id, owner_id)` 唯一键（`id` 本来就唯一，不会拒绝任何现有行）。
- 为什么不让子表也指向 `user`：外键检查会对被指向的行取 `FOR KEY SHARE`，而 `user` 行在
  [`postgres-lock-order.md`](./postgres-lock-order.md) 里是秩 10、被 `lockOwnerTaskGraph` 以 `FOR UPDATE` 持有的那一行。
  `wiki_exposure` 会在 `dequeueTurn` 里写，那时会话行（秩 30）已经在手；再去取秩 10 正是那份文档要消灭的环。
  经由 space 挂载，wiki 的写只锁 wiki 自己的行。
- **给 T3/T6 的一条锁规矩**：锁条目用 `FOR NO KEY UPDATE`（普通 `UPDATE` 默认就是），不要用 `FOR UPDATE`。
  曝光和 op 的外键会对条目取 `KEY SHARE`，`FOR UPDATE` 会和它互斥。

### 1.3 不挂外键的 id

`wiki_changeset.session_id / tool_call_id`、`wiki_entry_revision.author_user_id / author_session_id /
author_tool_call_id / changeset_op_id`、`wiki_exposure.session_id`、`wiki_source.ref`。先例是 0238 的
`deciding_session_id`：原记录被删后引用仍要作为墓碑留下（`wiki_source.state` 记录它），并且 wiki 的写不对
session / task / tool_call 取锁。

wiki 内部的两种互指带复合外键：

- `supersedes_id / superseded_by_id`：`NO ACTION`。取代的两端在同一个 space，删 space 的级联在一条语句里把两端一起删掉。
- `wiki_changeset_op.entry_id / result_entry_id`：`ON DELETE CASCADE`。op 从 space 出发有两条路可达（经变更集、经条目），
  `NO ACTION` 的检查会在另一条路的级联到达之前触发，从而拒绝删除 space。删掉条目时，关于它的 op 一起删掉：删除即遗忘。

### 1.4 状态只有一个写入点，修订只追加

`wiki_entry.status / trust / challenged / unsupported` 只由 `WikiService.applyOp()` 和 `WikiService.recomputeFlags()` 写，
`db-write-inventory` 里也只登记这两处（T3）。`wiki_entry_revision` 只插入：改动就是新的一版。

### 1.5 关键词检索的表达式

`wiki_entry_search_text(title, summary, aliases, fields)` 把标题、摘要、别名，以及 `fields` 里的每一个字符串值（不含字段名）
用空格连起来，并照 0095 和 `sessions.service.ts` 的 `stripMarks` 去掉 `*` 和反引号（`_` 保留）。GIN `gin_trgm_ops` 索引
`wiki_entry_search_trgm` 就建在这个函数调用上。**查询侧必须调用同一个函数、传同样四列**，换任何别的写法都会扫全表；
pg spec 用执行计划钉住了这一点。它声明为 IMMUTABLE（里面的 `array_to_string` 一般只是 STABLE，对 `text[]` 其实不变），
因此 PostgreSQL 不会内联它，索引和查询两边保持同一个调用。

---

## 2. Space

- **身份**：owner × 代码库。`repo_url_norm` 是去掉协议、userinfo、结尾 `.git` 和 `/` 的远端地址：
  `git@github.com:a/b.git` 与 `https://github.com/a/b` 都读作 `github.com/a/b`。它在每个 owner 内唯一；
  NULL 表示背后没有仓库的 space，这种可以有任意多个。`root_commit_sha` 等 runner 补报后用来区分同一 URL 背后的两个仓库。
- **slug**：`^[a-z0-9]+(?:-[a-z0-9]+)*$`，至多 64 字符，每个 owner 内唯一。主题的 slug 同形，在 space 内唯一。
- **绑定**：一个 workspace 最多绑一个 space，且只能绑自己 owner 的 space（复合外键拒绝别的）。带 `repo_url` 的
  workspace 第一次使用时自动绑到同 owner、同 `repo_url_norm` 的 space；没有的由 owner 在 Wiki 设置里手动绑。
  会话所在 workspace 没绑定时返回 `WIKI_SPACE_UNBOUND`，并用一句话说明怎么绑。项目通过其 codebase 的仓库地址找到 space，没有单独的表。
- **设置**（`settings` jsonb，缺省的键按默认值读）：
  - `push`，默认开（owner 2026-09-25 拍板：推送默认开，每个 space 可以关）；
  - `autoAcceptReinforce`，默认开：非 owner 的 reinforce 立即生效；关掉后进 Review；
  - `reviewMode`：`manual` / `tiered` / `automatic`（§7.3）。**新建的 space 写成 `tiered`**（判据 7 的默认）；**阶段 1 就有的
    space 设置里没有这个键，读作 `manual`**，不回填——在客户端（判据 8）能显示和切换模式之前，已有的 space 若开始直接
    应用 agent 的提议，就是 owner 看不见、也撤不回的行为变化。只能经 owner 门（JWT）的 `PATCH /api/wiki/spaces/:id` 切换，
    带会话头的请求一律 `WIKI_OWNER_CHANNEL_ONLY`；
  - `automaticSpotChecks`，默认关：Automatic 是否给 owner 发抽检卡；打开后按每 200 条抽 1 条（§7.4）。和 `reviewMode`
    一样只能经 owner 门修改，带会话头一律 `WIKI_OWNER_CHANNEL_ONLY`；Tiered 的抽检不看它；
  - `reviewModeChangedAt` / `reviewModeChangedBy`（`owner`、`spot_checks` 或 `verification`）：服务端写，记录模式最近一次
    在何时、被谁改——`verification` 是核实拒绝率超阈值把 Automatic 退回 Tiered；
  - `maintenance`、`embedding` 留给阶段 2。
- **列表**（`space.list`）：`GET /api/wiki/spaces` 按 slug 列出 owner 的全部 space，每行是单个 space 的读，外加四个字段（单个
  space 的读不带它们；老服务器没有后三个，客户端读作没有）：
  - `pendingOps`：这个 space 变更集里等 owner 决定的 op 数（Review 的数）。plan 的修改建议不是 op，不算在里面。所有 space
    的 `pendingOps` 之和，就是 Activity 页第一条横幅和 Review 页头的数；
  - `planWaiting`：这个 space 的 plan 里等 owner 的件数，各算一件：在途的起草、修订或生成作业（plan 读给出的那个作业）被挡住——
    服务端挂起（`plan.jobs.held`），或已建任务还没开跑而维护 workspace 的 runner 不在线；起草或修订失败、之后没有存过新版本；
    等确认的草稿；每条待处理的修改建议。只是在进行中的（排队、起草中、写文档中）和失败的生成不算。runner 是维护 workspace 所在的
    那台，在线与否用 runners 列表的同一条规则（`isRunnerOnline`）；没设维护 workspace、它已删除或没有 runner，就是不知道，
    不知道不算不在线。口径与 web `wikiPlanPending`、OrbitKit `WikiPlanLogic.pending` 相同，三方都钉在
    `src/shared/src/wiki-docs.fixture.json` 的 `plan.states`（每个用例的 `pending`）上，服务端是 `wiki-plan-waiting.spec.ts`。
    所有 space 的 `pendingOps + planWaiting` 之和，就是抽屉、web 侧栏和 Wiki 页头 Activity 角标的那个「等你」数，等于
    Activity 页琥珀横幅之和；
  - `workspaceIds`：绑在这个 space 上、没被删的 workspace，按绑定的先后，和 user 门上所有 id 一样是 public id；
  - `docs`：`{ written, total }`，已确认 plan 的篇数与已写篇数，算法同目录（§22.7）；没有已确认的 plan 时为 null。

---

## 3. 条目类型与字段

### 3.1 通用字段

| 字段 | 规则 |
| --- | --- |
| `kind` | 必填，见下表 |
| `title` | 必填，至多 120 字符 |
| `summary` | 必填，至多 280 字符，一句话：卡片和给 agent 的切片展示它 |
| `fields` | 必填，这一类自己的字段 |
| `topics` | 可选，至多 3 个主题 slug |
| `aliases` | 可选，至多 8 个同义词，每个至多 80 字符；填中英两种说法，关键词检索靠它们 |
| `anchors` | 可选，至多 20 个，形状见 §4 |

一条谱系的 `kind` 不变；换类型是 supersede，会开一条新谱系。

### 3.2 各类必填字段（`KIND_SPECS`）

| kind | 必填字段 | 可选字段 | 谁能写 | 推送 |
| --- | --- | --- | --- | --- |
| `principle` | statement, rationale | — | add / amend / supersede **只有 owner**（`WIKI_KIND_OWNER_ONLY`） | 总是 |
| `convention` | rule, scope（glob 列表，至少 1 个） | exceptions | agent 提议，owner 确认 | 总是 |
| `decision` | context, decision, alternatives（至少 1 个 `{option, whyRejected}`）, consequences, decidedAt | — | agent 提议，owner 确认；**不能 amend，只能 supersede** | 按相关度（推的是它的约束） |
| `pitfall` | trigger `{paths[], commands[], errorSignature?}`（三者至少一个非空）, symptom, cause, fix | detector | agent 提议，owner 确认 | 按相关度 |
| `recipe` | steps（至少 1 步）, verify `{command, expectedExit 0–255}` | — | agent 提议，owner 确认 | 按相关度 |
| `concept` | definition, boundaries | notToConfuseWith | agent 提议，owner 确认 | 从不（只能拉取） |
| `assumption` | **阶段 3 占位**：dependency `{purl \| cli \| url}`, contract, probe | — | — | 从不 |

`assumption` 这个词库里的 CHECK 已经收下（阶段 3 不用再迁移），但阶段 1 的每一道门都拒绝它（`WIKI_SCHEMA`，路径 `kind`），
`KIND_SPECS` 里也没有它。

### 3.3 字段语言

JSON 的 `kinds.<kind>.fields` 与 TS 的 `KIND_SPECS[kind].fields` 用同一套写法，`wikiContract.spec.ts` 断言两者逐字段相等：

- `text`：含非空白字符的字符串，至多 4000 字符；给了 `pattern` 就要整串匹配。
- `textList`：text 的数组，至多 20 项、至少 `minItems` 项。
- `date`：真实存在的 ISO 8601 日期（`YYYY-MM-DD`），可带时间和时区偏移。
- `integer`：整数，落在 `min`–`max` 内。
- `object`：只含所列字段的对象；`atLeastOneOf` 要求所列字段里至少一个是非空列表或非空文本。
- `objectList`：上述对象的数组。

严格规则：缺了必填字段是错；出现 schema 没列的键是错；出现的可选字段按类型校验；`null` 当作缺省。
每个错误都带字段路径，例如 `fields.alternatives[0].whyRejected`、`anchors[2].sha`、`sources[1].ref`。

`src/shared/src/wiki.ts` 提供：`KIND_SPECS[kind].validate(fields)`、`validateWikiEntryDraft(entry)`（add / supersede 的整条）、
`validateWikiEntryChanges(changes, kind)`（amend 与 Review 里的编辑）、`validateWikiSources(sources)`。它们只查形状；
出处能否解析、引文是否逐字存在、CAS、配额这些要查库的步骤归 T3。

---

## 4. 锚点

| type | 字段 | 复验结果 | 复验方式 |
| --- | --- | --- | --- |
| `path` | path | verified / missing | runner：`git cat-file -e origin/main:<path>` |
| `symbol` | path, symbol, regionSha256? | verified / changed / missing | runner：`git grep -n` 找符号，对其后若干行做哈希比对 |
| `commit` | sha（40 位小写十六进制） | verified / missing | runner：`git merge-base --is-ancestor`，必须验 |
| `criterion` | criterionId, semanticHash? | verified / changed | 服务端比对 semanticHash |
| `merge_evidence` | contentHash | verified / missing | 服务端看证据是否仍被观察到 |
| `command` | command, expectedExit | verified / changed | 维护作业重跑（阶段 2） |
| `record` | ref（`orbit-task:` / `orbit-session:` / `orbit-project:` / `orbit-list:` 链接） | verified / missing | 服务端查存在性 |

- 新锚点的状态是 `unchecked`；`changed` / `missing` 让条目立刻退出推送，并生成一条系统 challenge 进 Review。
- 服务端把每个锚点最近一次复验的结果（状态、ref、时间）存在锚点旁边；**提议者不能发这些**，带了锚点类型没列的键会被 `WIKI_SCHEMA` 拒绝。
- 需要 git 的复验只在 runner 上跑（维护作业，阶段 2），apiserver 不跑 git。
- 库里的 CHECK（`wiki_anchors_valid`）保证每个锚点都是对象、`type` 是上表之一。

---

## 5. 出处

- **只收一手记录**：`turn`、`event`、`tool_call`、`task`、`task_comment`、`approval`、`evidence`、`owner_decision`、
  `merge_receipt`、`criterion`、`commit`、`note`、`url`。wiki 条目、主题摘要或任何视图都不能当出处，否则检索会塌缩成自引用。
- **提议时的形状**：`{ kind, ref?, session?, seq?, locator?, quote? }`。`ref` 是记录 id 或 commit sha；引用调用方会话的
  turn 时写 `{ kind: 'turn', session: 'self', seq? }`，不写 `ref`，引文在会话结算时补验，Review 卡上显示是否验过。
- **每种 kind 的 `ref` 填什么**（契约 `sourceInput.refs`）。id 两种写法都收：UUID，或 Orbit 显示的短 id。

  | kind | `ref` |
  | --- | --- |
  | `turn` | 那条 turn 的 id；调用方会话的 turn 写 `session: 'self'`，不写 `ref` |
  | `event` | run event 的 id |
  | `tool_call` | tool call 行的 id，或引擎给这次调用的 tool_use_id（`toolu_…`、`call_…`）：会话在自己记录里看到的就是它，`task_evidence_submit` 的 TOOL_CALL 收的也是它 |
  | `task`、`task_comment`、`approval`、`merge_receipt` | 那条记录的 id |
  | `owner_decision` | owner 带备注解决的那条项目 blocker 的 id |
  | `note` | `orbit wiki import` 登记的 note 的 id |
  | `commit` | 完整 sha，要是本 owner 某条 merge receipt 里记着的 |
  | `evidence`、`criterion`、`url` | 暂时引不了：没有哪道门解析它们，一律 `WIKI_SOURCE_UNRESOLVED` |

  `wiki_propose` 的 `sources` 参数说明和 `orbit wiki propose --help` 写的是同一张表（runner-go `wikiSourceRefs`，
  `TestWikiProposeSaysWhatEachSourceKindTakesAsItsRef` 钉住每种 kind 都说到）。
- **ref 先过形状，再查库**：`sourceInput.rowIdKinds` 里的 kind（turn、event、task、task_comment、approval、owner_decision、
  merge_receipt、note），`ref` 两种写法都解不出 id 的，在 schema 这一步就拒 `WIKI_SCHEMA`，`errors[]` 按 path
  （`ops[i].sources[j].ref`）点名，消息里说这种 kind 该填什么。任何 ref 都不会原样拿去比 uuid 列：10-04 线上把 tool_use_id
  填进出处，值原样进了 uuid 列，Prisma 报 P2007，整个请求 500，dryRun 也一样。
- **`tool_call` 的 tool_use_id**（契约 `sourceInput.toolUseId`）：先当行 id 找；本 owner 没有这个 id 的行，再当 tool_use_id 找。
  先找调用方会话自己的调用；没有，再找本 owner 的其他会话，恰好一个会话带它才算数。同一会话里同一次调用被重复入库
  （线上有 324 个 tool_use_id 各存了 2–19 行，内容逐字节相同），算一次调用，取最早那一行；两个及以上会话都带它，或者谁都
  没带，就是 `WIKI_SOURCE_UNRESOLVED`。存进 `wiki_source.ref` 的是行 id。决定（decide）和核实时，op 的出处从它的 payload 重读，
  调用方同样是提议它的那个会话。调用方会话那一步是 `(session_id, tool_use_id)` 索引的一次探测；跨会话那一步要沿同一个索引
  走遍 owner 的会话（10-06 线上 5.5k 个会话约 0.14 秒），只有引的不是自己会话的调用时才走到。
- **校验**（T3）：每个出处都要在本 owner 的行里解析出来，否则 `WIKI_SOURCE_UNRESOLVED`，`errors[]` 按 path 点名那条出处，
  消息里说这种 kind 的 ref 该填什么；引文做空白归一化后必须是原文子串，
  否则 `WIKI_QUOTE_NOT_FOUND`；非 owner 的 add / amend / supersede / reinforce 至少带一个出处，owner 自己写的可以不带。
- **存储**：出处行挂在它支撑的那一版上；reinforce 只往当前版追加出处行。`quote` 至多 300 字、先脱敏；`quote_sha256`
  与 `quote` 同在同缺。`url` 只给 assumption 用，并且一定标 `tainted`。
- **删除即遗忘**：出处状态 `live → trashed → live | deleted`，`live → deleted`。会话进回收站时出处先标 `trashed`，条目退出推送但保留；
  原记录被删时同一事务里置 `deleted`，`quote` 与 `quote_sha256` 清空；只靠已删出处支撑的 confirmed 条目标 `unsupported`，
  退出推送进 Review。owner 手写的条目不受影响。

### 5.1 `note` 出处与 `orbit wiki import`（判据 1，契约 `import`）

- **一个文件一条 note**（迁移 0316，表 `wiki_note`）：`POST /api/runner/wiki/spaces/:id/notes` 收 `{path, text}`，
  正文和路径先过共享脱敏器（带 owner 的 `workspace.env` 值），**只存脱敏后的正文、它的 sha256 和路径**，原文不落库。
  `UNIQUE (space_id, content_sha256)`：同一文件重导、或同样内容换个文件名（AGENTS.md 重复 CLAUDE.md），回答已有的那条
  （`created: false`），不产生新行。回答里的 `text` 就是存下的脱敏正文，导入端交给模型的也是它，所以模型抄的引文
  对得上原文。正文至多 10 万字、路径至多 500 字。
- **引用**：`{ kind: 'note', ref: <note id>, quote? }`，只在本 owner 的 note 里解析（别人的 note 是 `WIKI_SOURCE_UNRESOLVED`），
  引文校验和 Automatic 的核实读的都是存下的脱敏正文；出处的 `locator` 是 `{ path }`，客户端显示成「Note · 路径」。
  note 是 agent 写的二手内容，不算 owner 原话。
- **提议**：`POST /api/runner/wiki/spaces/:id/imports`，body 同 `wiki_propose`，origin 由路由定为 `import`（不收 body 字段）。
  生效只看 space 的审阅模式：Manual 全部待审；Tiered 直接生效为 Unreviewed（按抽检规则抽检）；Automatic 先等核实，
  由同一会话的 `orbit wiki verify` 核实。安全底线照常：principle 拒 `WIKI_KIND_OWNER_ONLY`，tainted 待审，熔断，
  每个变更集至多 30 个 op。两条路由都要带 `X-Orbit-Session-Id`（无会话 400），别的 owner 的 space 是 404。
- **`orbit wiki import --from <dir|file> --space <id>`**（runner-go `wiki_import.go`）：逐文件登记 note → 用干净的
  Claude Code 调本地模型（同 `orbit wiki verify` 的启动参数、环境白名单和 apiKeyHelper，默认不开 thinking）从脱敏正文里
  抽至多 6 条 → 整批 dryRun 自检 → 提议。每次运行至多 30 个 op；因内容被拒的 op 丢弃并计数，从第一个因名额被拒的 op
  （`WIKI_QUOTA`、`WIKI_REVIEW_QUEUE_FULL`）起留给下一次运行，所以要审的一批一批进 Review。principle 不提议、只计数。
  目录按 frontmatter 的 type（feedback、user、reference、project、其余）再按文件名排序，跳过 `MEMORY.md`。
  在本机（`$ORBIT_HOME/wiki-import` 或 `--state`）记住导到了哪：重跑从断点续，导过的文件不再送模型，内容变了的按新
  note 导。碰到模型端点的第一个 401 就停；首次调用前先等 `/health` 回 200。
- **服务端执行时的导入**（服务端执行 P5，契约 `import.server`；执行器开关为 `server`，或账号在 `canary` 名单内）：
  - 命令先问 `GET /api/runner/wiki/spaces/:id/import`：回答 `{ executor, model, modelState }`。回答不是 `server` 的——`runner`、
    老服务端的 404、拒绝、没有回答——都按上面的老路径走，行为和文案都不变。问错了也不会调模型：服务端执行时，不带
    `readBy: "server"` 的登记会被拒（见下）。
  - 回 `server` 时，命令照旧列文件、读 frontmatter、登记 note（body 带 `readBy: "server"`，回答里不再有 `text`），然后把
    要读的 note 和带着上次没提议的 op 的 note，按顺序一次交给 `POST .../import-jobs`（作业 id 由命令起，重发是同一个作业；
    至多 1000 条 note），等 `GET .../import-jobs/:jobId` 的作业结束，打印作业报告里的数字，并把报告写回本机的记忆，
    所以下一次运行不管走哪条路都从断点续。不需要会话的 provider，不起 Claude Code，`--model` 不用。
  - 作业（wiki-worker 的 `import`，优先级 1）：每条 note 经模型请求队列调一次 System model（step `import`，unit 是 note id，
    system prompt 和 prompt 与 runner 上逐字相同，max_tokens 8192），不合格的带着问题再问一次（step `import_retry`）；解析、
    修复、字段和语言检查、verify.command 必须出现在 note 的代码里、引文逐字匹配，全部与 Go 一致——
    `src/shared/src/wiki-import.fixture.json` 把两边逐字节绑在同一组输出上。锚点查 space 的快照：路径在 origin/main 的树里、
    提交被 origin/main 可达；space 的 runner 能取时先要一份新快照（最多等 180 秒，持租约等），取不到就用 space 已有的快照，
    都没有就不带锚点。之后先 dry run，再以 import 来源、调用会话的身份、`wiki-import:<空间和 op 的哈希>` 幂等键提议；
    分批规则和老路径相同：遇到 `WIKI_QUOTA` 或 `WIKI_REVIEW_QUEUE_FULL`，剩下的留给下一次。
  - 命令停止等待（作业留在服务端，id 记在本机，下一次运行先收它的结果）：System model 拒了 key 或没配置时立即停；模型
    不在线、或作业没开始，超过 10 分钟时停；作业已经失败重试 3 次时停。作业失败时，交给它的 note 保持已登记，下一次运行交给新作业。
  - runner 门在此时归服务端（`WIKI_SERVER_EXECUTES`，409）：不带 `readBy: "server"` 的登记——也就是会用会话自己的模型
    读 note 的老版命令——在登记任何东西之前就被拒；`POST .../imports` 也被拒，因为提议由作业来做，不收会话模型写的条目。
    老版命令因此在第一次登记就停下，不会调任何模型。

---

## 6. 状态机

### 6.1 条目

```
proposed ──accept / edit──▶ active ──supersede──▶ superseded
    │  ▲                       ├────retire──────▶ retired
    │  │                       └────reject──────▶ rejected   （仅审阅模式直接生效、trust 为 auto / unreviewed 的条目）
    │  └──reopen（§7.5）── rejected
    └──reject / expire / withdraw──▶ rejected
```

- 生来就是 `proposed`（等 Review 的 add / supersede，或 Automatic 里等核实的 add）或 `active`（owner 自己的，或审阅模式直接生效的 add）。
  `superseded`、`retired` 是终态。`rejected` 是「已结束」（`states.entry.ended`：不推送、agent 检索不到、客户端显示为结束），
  但不再是终态：唯一的出路是 §7.5 的重开——当时读不到任何出处原文、被 unsupported 结论拒掉的谱系回到 `proposed`，重新等核实。
- Automatic 里等核实的 add：核实结论 supported 让它变 `active`（trust `auto`），partial 变 `active`（trust `unreviewed`），
  unsupported 与 duplicate 让它变 `rejected`（§7.4）。
- 审阅模式直接生效、还没人确认的条目（trust `auto` / `unreviewed`），owner 在抽检卡上或在条目上 Reject 时变 `rejected`，与被拒的提议一样留作反例。
- 被拒的条目保留，作为反例：以后提议的 `similar[]` 会显示「曾被拒：理由」。
- 库里的不变量（CHECK）：`superseded` 当且仅当 `superseded_by_id` 非空；`retired_at` 当且仅当状态已结束（superseded、retired 或 rejected）；
  `trust = proposed` 当且仅当状态是 `proposed` 或 `rejected`。

### 6.2 op 的决定

提交时记为 `pending`（等 owner）、`auto_applied`（立即生效）或 `verifying`（Automatic 收下、等核实结论，§7.4）。
`auto_applied` 只有两种出路：审阅模式直接生效的 add，owner 在条目上 Reject 时变 `rejected`（§7.3 的逐条 Reject）；owner 在条目上
Confirm 时，模式对它生效过、还没人答的 op 变 `accepted`（§7.5）。其余 `auto_applied` 不再变。`rejected` 只有 §7.5 的重开能让它
回到 `verifying`（当时读不到原文的 unsupported 结论）；Automatic 的 space 里等 owner 的 tainted add / amend，重开也能把它从 `pending`
送去 `verifying`。其余被拒的 op 不再变。`verifying` 只由事实离开：核实结论让它变 `auto_applied`（supported / partial 生效）、`pending`
（生效后被抽成抽检卡）、`rejected`（unsupported 记 `not_true`，duplicate 记 `duplicate`）或 `conflict`（amend 的目标条目在
结论到来前已变，或已归 owner）；整次撤回或 amend 的目标条目离开 active 时变 `withdrawn`。它不过期，也没有任何时钟会动它。
`pending` 只会变成：

| 决定 | 何时 |
| --- | --- |
| `accepted` | owner 接受，且已生效 |
| `edited` | owner 改过再接受，改后的版本已生效 |
| `rejected` | owner 拒绝，必须选理由：Not true / Not useful / Duplicate / Too specific（存为 `not_true` / `not_useful` / `duplicate` / `too_specific`） |
| `conflict` | owner 接受时 baseRevision 已不是当前版，什么都没生效 |
| `expired` | 等了 14 天 |
| `withdrawn` | owner 决定前，目标条目已被别的 op 取代或退役（或被整次撤回），这个 op 不再适用 |

抽检卡（`spot_check`）也是 `pending` 的 op：效果已经生效，accept 是确认、edit 是 owner 改写后确认、reject 是撤销；条目在 op 生效后又被改过时记为 `conflict`。

库里的不变量：`decided_at` 当且仅当已决定（`pending` 与 `verifying` 都没有）；`decision_reason` 当且仅当被拒；
`verifying` 的 op 不带结论，只有 add 与 amend 会等核实或带结论；`verification_evidence` 只在有结论时才可能有值（迁移 0314）；
`verification_history` 是列表，没被重开过的 op 是空列表。

### 6.3 变更集

`pending`（还有 op 等 owner 或等核实，此时必须有 `expires_at`）→ `settled`（都没有了，此时有 `decided_at`）。
§7.5 的重开把一个 op 送回等核实时，它所在的 `settled` 变更集回到 `pending`（重新给 `expires_at`），所以 `settled` 不再是终态。
全部立即生效的变更集一记录就是 `settled`；一个 op 都没通过的请求不留变更集。Review 只列出有 op 在等 owner 的变更集：
只剩 op 在等核实的变更集不是 owner 的卡片。

---

## 7. trust 与生效策略

### 7.1 trust

| trust | 含义 |
| --- | --- |
| `owner` | owner 写的：owner 自己的 add / supersede |
| `confirmed` | agent、维护作业、导入或巡检提议，owner 接受（原样或改过）；或 owner 接受了它的抽检卡；或 owner 在条目上 Confirm（§7.5） |
| `auto` | 审阅模式直接生效、没人看过：Tiered 下出自 owner 原话或经机器验证的，Automatic 下通过校验的全部。推送，标 Auto |
| `unreviewed` | Tiered 直接生效但既无 owner 原话也无机器验证的；Automatic 核实为 partial 的、读不到任何出处原文的、或 tainted 的（§7.5）；或被整次撤回、被拒的抽检恢复过的。显示、标 Unreviewed，从不推送 |
| `proposed` | 没被接受：所有待审条目和被拒条目 |
| `external` | 靠网页衍生出处支撑（阶段 3 引用 url 的 assumption），从不推送 |

只推送 `owner`、`confirmed` 与 `auto`。生效时 trust 的变化：owner 的 add / supersede → `owner`；被接受的 add / supersede / amend → `confirmed`
（被接受的 amend 落在 `auto` / `unreviewed` 条目上时也变 `confirmed`）；审阅模式直接生效的 add / amend → `auto` 或 `unreviewed`；
抽检被接受 → `confirmed`；owner 在条目上 Confirm → `confirmed`；被整次撤回或被拒的抽检恢复的条目 → `unreviewed`；其余生效的 op 不改 trust。owner 改过再接受时，
修订作者记为 owner，trust 仍是 `confirmed`。

### 7.2 生效策略（设计 §4.2）

| 来源 \ op | add | reinforce | amend | supersede | retire | challenge |
| --- | --- | --- | --- | --- | --- | --- |
| owner | 立即 | 立即 | 立即 | 立即 | 立即 | 立即 |
| agent / maintenance / import / watch | 待审 | 立即（space 可关） | 待审 | 待审 | 待审 | 立即 |
| 被污染的 op（owner 除外） | 待审 | 待审 | 待审 | 待审 | 待审 | 立即 |

- 污染：调用会话在这个 op 之前用过 WebFetch / WebSearch（codex 的 webSearch 也算），或引用的 turn 来自被污染的时段。
  被污染的 op 按第三行处理，Review 卡上有 Web-derived 警示。
- challenge 从任何来源都立即生效：它只打一个标，作用是让条目立刻退出推送，等 owner 在 Review 里 Re-confirm、Amend 或 Retire。
- `wiki.ts` 的 `WIKI_EFFECT_POLICY` 是这张表的数据形态，`wikiOpEffect()` 给出单个 op 的结论。
- **决定**：`POST /api/wiki/changesets/:id/decide`，逐个 op 给 `accept` / `edit` / `reject`；只在 owner 通道（§11）。

### 7.3 审阅模式（判据 7）

生效策略先判；它直接生效的（owner 自己的写入、reinforce、challenge）不受模式影响。它扣下的，由 space 的 `reviewMode` 决定：

| 模式 | 直接生效的 | trust | 其余 |
| --- | --- | --- | --- |
| `manual` | 无（就是 §7.2，和阶段 1 一样） | — | 进 Review |
| `tiered` | add，以及对 `auto` / `unreviewed` 条目的 amend | owner 原话或机器验证 → `auto`，否则 `unreviewed` | 进 Review |
| `automatic` | 同上，但**先核实再生效**（§7.4）：收下后记 `verifying`，按核实结论生效 | supported → `auto`，partial → `unreviewed` | 进 Review |

- **只放行 add 和 amend**：只有它们撤得回来（撤回把 add 退役、把 amend 恢复到上一版）。supersede 与 retire 会结束一条谱系，
  终态回不来，所以任何模式下都待审；autoAcceptReinforce 关着时被扣下的 reinforce 同样待审。op 行上记 `applied_by_mode`
  （Automatic 的 op 在结论让它生效时才记）。数据形态是 `wiki.ts` 的 `wikiReviewEffect()`：Tiered 返回 `applied`，
  Automatic 返回 `verifying`。
- **Tiered 的分类**（`wikiTieredBasis()`）：
  - **owner 原话**：kind 是 decision 或 convention，出处里至少一条是 owner 自己的话，且引文校验通过。owner 自己的话 =
    owner 从用户门发出的 message / steer（带显式路由意图、client turn id 不是控制面自己的命名空间；runner 门转发的消息不带意图，
    所以 agent 冒充不了），或 owner 回答过的 AskUserQuestion（`decided_by_id` 非空的 ALLOWED 审批）。
    **已知缺口**：Apple 客户端发消息时还不带路由意图，这些消息暂不算 owner 原话，相关条目显示为 Unreviewed；客户端补发意图后即可。
  - **机器验证**：recipe 的验证命令由维护作业重跑为绿（维护作业还没有回报通道，所以现在一律不算）；pitfall 的锚点复验是
    `verified`，且出处覆盖 2 个以上独立会话。新条目的锚点还没复验过，所以 add 在复验之前不会是机器验证；不动锚点的 amend
    沿用条目的复验结果。
  - 其余一律 `unreviewed`。
- **五条安全底线**（任何模式都生效）：principle 只有 owner 能写（`WIKI_KIND_OWNER_ONLY`）；tainted 绝不靠模式放行——Manual 与
  Tiered 下待审，Automatic 下先核实但结论最多到 Unreviewed（§7.5）；修改或退役 owner
  写的、owner 确认过的条目（trust 是 owner / confirmed，或有任何一版由 owner 写）一律待审；单个变更集经模式直接改动的条目数
  超过开始时 active 条目的 10% 就熔断，越线的 op 拒 `WIKI_QUOTA`（active 少于 100 条时不熔断，让空 space 能写入第一批）；
  每个变更集最多 30 个 op（`limits.opsPerChangeset`）。
- **抽检**（按事实，不用时钟）：Tiered 直接生效的 op 每 10 个抽 1 个进 Review；Automatic 默认不抽，owner 打开
  `automaticSpotChecks` 后按结论生效的 op 每 200 个抽 1 个。位置由 space 与块号的哈希决定，重放抽到同一个。
  抽检卡记 `pending` + `spot_check`，是 Review 里的卡片，但**不占 30 条待审名额**（判据 7 第 3 版：名额只留给需要 owner
  决定的条目），所以队列满时既不拒绝已生效的 op，也不跳过抽检。最近 10 张已答的抽检卡
  （只算模式最近一次变更之后记录的）里被拒超过 30% 时，同一事务把 space 改回 `manual`（对模式做 compare-and-set），
  提交后给 owner 推一次通知；已经是 Manual 的 space 不会再切、也不会再通知。
- **整次撤回**：`POST /api/wiki/changesets/:id/revert`，owner 门、不带会话头。把这个变更集里模式直接生效、owner 还没答过的
  op 全部撤掉：add 的条目退役，被 amend 的条目恢复到这次运行第一次改它之前的那一版（带那一版的出处）并变 `unreviewed`，
  这次运行未答的抽检卡撤回；还在等核实的 op 记 `withdrawn`（add 的 proposed 谱系随之变 `rejected`），之后到来的结论不再能让它生效。撤回本身是 owner 的一个变更集，走 `recordChangeset` / `applyOp`，留修订历史；幂等键
  `revert:<变更集 id>`，再按一次返回第一次的回答。已离开 active、或之后又被改过的条目不动，列在 `skipped` 里。撤回后这些条目立刻退出推送。
- **逐条 Reject**：`POST /api/wiki/entries/:id/reject`（`reason` 取四个拒绝理由之一），owner 门、不带会话头。只对 active 且 trust 是
  `auto` / `unreviewed` 的条目：条目变 `rejected`，拒绝记在当初创建它的那个模式生效的 add 上。那个 add 若是未答的抽检卡，
  这就是它的回答，计入拒绝率。其余条目回 409：提议在 Review 里拒，owner 写的或确认过的用 retire。
- **批量导入**（预览 space 的一次性载入）：在 apiserver 里直接构造 `WikiService` 调 `submitChangeset`，principal 为
  `origin: 'import'`、`authorKind: 'system'`，不冒充 owner；Automatic 的 space 里先等核实，同一 principal 调
  `listVerifications` / `recordVerifications` 取待核实的 op、写结论（§7.4）；出处可以只挂记录 id、不带引文；
  幂等键防重放；每个变更集最多 30 个 op，熔断照常。

### 7.4 Automatic 先核实再生效（判据 7 第 3 版）

owner 2026-09-27 定：Automatic 收下的 op 先由本地模型核实，再按结论生效。核实是**另一次**调用，用干净的 Claude Code，
对照 op 自己引用的一手记录下结论，没有看过提议者的推理。

- **待核实**：Automatic 收下的 op（add，或对 `auto` / `unreviewed` 条目的 amend，过了全部底线）记 `verifying`：不生效、
  不推送、不是 Review 卡片；不占 30 条待审名额，也不计 opsPerTurn / opsPerSession；熔断与每变更集 30 个 op 照常算它。
  提议者拿到的回答是 `pending`，带 `waitsFor: "verification"`。add 的谱系先以 `proposed` 写下（similar[] 与结论都要读它）。
- **四种结论**（`reviewModes.verification.verdicts`）：

  | 结论 | 结果 |
  | --- | --- |
  | `supported` | 生效：add 的谱系变 active、amend 写新版，trust `auto`，推送 |
  | `partial` | 生效，trust `unreviewed`：显示、不推送，owner 可 Reject |
  | `unsupported` | op 被拒，`decision_reason = not_true`，核实理由记在 op 上；add 的谱系变 `rejected` 留作反例，之后的 similar[] 显示 `rejectedReason: not_true` 和 `rejectedBecause`（核实者原话） |
  | `duplicate` | 必须用 `duplicateOf` 指明重复的是哪条：只能是这个 op 自己 similar[] 里的条目，或 amend 自己的目标条目，且必须 active。op 被拒（`decision_reason = duplicate`，add 的谱系随之 `rejected`），它的出处追加到那条条目上（同 reinforce，内容、状态、trust 不变）；space 关了 `autoAcceptReinforce` 时不追加 |

  生效同样只经 `applyOp` / `recomputeFlags`；结论让它生效的 op 记 `auto_applied` + `applied_by_mode = automatic`，所以整次撤回、
  逐条 Reject、抽检都把它当作模式生效的 op。amend 在结论到来时再过一遍底线：目标条目已变、或已归 owner（owner 写过或确认过），
  就记 `conflict`，什么都不改（结论照样留痕）。
- **留痕**（迁移 0312）：op 上的 `verification_verdict`、`verification_reason`（一句话，脱敏，≤500 字）、`verification_model`（≤200 字）、
  `verified_at`（服务端记录时刻）四个同在同缺，`verification_duplicate_of` 当且仅当结论是 duplicate。读回来是 op 的
  `verification: {verdict, reason, model, at, duplicateOf}`。`verification_duplicate_of` 是 wiki 里唯一不带外键的内部指针：
  它是核实者说过的话，要比它指的条目活得久（外键级联会把整行留痕删掉，SET NULL 会改写它）。
- **谁能回报**：
  - runner 门 `GET` / `POST /api/runner/wiki/spaces/:id/verifications`：必须带 `x-orbit-session-id`（无会话一律 400），
    只列出、只接受**提交这批 op 的那个会话**自己的 op；别的会话的 op、别的 owner 的一切都是 404。每条结论单独一个事务，
    各自回答 `applied` / `rejected` / `reinforced` / `conflict` / `refused`；全被拒时回第一条拒绝的状态。同一结论重报回放、不写；换结论 409。
  - 系统导入路径：`{origin: import, authorKind: system}` 的 principal 在容器里直接调 `WikiService.listVerifications` /
    `recordVerifications`，只够得着不带会话的 import 变更集，落到同样的留痕。
  - 维护运行接手核实（`reviewModes.verification.adoption`）：提议它的会话已经结束——run 状态 SUCCEEDED / FAILED / CANCELLED，
    或已 completed / 已删除——还在等核实的 op，没人会再核它（2026-09-29 冷启动时 orbit space 有 71 个，来自 3 次失败的维护运行）。
    本 space 的维护运行在自己的核实之后接手它们：`GET` / `POST /api/runner/wiki/spaces/:id/maintenance/verifications`，
    只对本 space 的维护会话开放（无会话 400、别的会话 `WIKI_NOT_MAINTENANCE_SESSION`、别的 owner 的 space 404），从不列自己的、
    还在跑的会话的、不带会话的 op；每次最多 `maintenance.job.rules.adoptOpsMax`（50）个，旧的在前，没拿到结论的留给下一次运行，
    不让本次运行失败。列表里每个 op 的 `similar[]` 除了当时记下的，还加上它的草稿**现在**的近邻（不含它自己的谱系）——等待期间，
    后来的 op 可能已经把同一条知识变成了 live 条目；duplicate 可以点名这些近邻里的任何一个，走现有的 reinforce。
    另有一道确定性的闸：接手的 add 若按结论会生效，而 space 里已有一条 active 条目与它的谱系**一字不差**（同种类、同标题、同摘要），
    就按那条的 duplicate 处理——谱系 rejected、`decision_reason = duplicate`、出处按 duplicate 的规则加到那条上（tainted 不加、
    `autoAcceptReinforce` 关着不加），回答 `reinforced`；留痕照记模型给的结论，不写 `verification_duplicate_of`（只有 duplicate 结论才点名）。
    其余一切同提议者自己的核实：没结论不生效，出处按提议它的会话读，tainted 最多 `unreviewed`，读不到原文的封顶且不计，
    unsupported 照常计入自动退回，space 不是 Automatic 就拒收。
- **不靠时钟**（选的是「一直等着」）：`verifying` 的 op 没有结论就一直等，不过期、不撤回、不生效，`pendingExpiryDays` 管不到它。
  让它结束等待的只有事实：结论到来；owner 整次撤回（`withdrawn`）；amend 的目标条目离开 active（`withdrawn`）。
- **离开 Automatic 之后**：space 不再是 Automatic（owner 切走，或下面的退回）时，结论一律 409 拒收，op 原样继续等，
  直到 space 再切回 Automatic 或被整次撤回——模式已经不让核实者做主，之前算出来的结论不能越过它。
- **自动退回**：一条 `unsupported` 结论记下时，若 space 仍是 Automatic，数模式最近一次变更之后最近 50 条结论里的
  unsupported；超过 50 的 30%（即 ≥16 条）就在同一事务里把 space 改成 `tiered`（`reviewModeChangedBy = verification`，
  对模式做 compare-and-set），提交后给 owner 推一次通知（`notifyWikiVerificationTripped`）；已经不是 Automatic 的不再切、不再通知。
- **`orbit wiki verify`**（runner-go，§11）：读上面的列表，逐条用干净的 Claude Code 调本地模型核实，读到一条结论就回报一条。

### 7.5 核实拿得到证据（判据 7 第 4 版）

owner 2026-09-27 定：核实必须拿得到证据。预览 space 里出处全是工具、thinking、系统事件的 op，核实者一个字原文都看不到，
95.7% 被判 unsupported；有一条可读出处的 op，unsupported 只有 0.9%。JSON 的 `reviewModes.verification.evidence` 与 `.reopen`、
`reviewModes.entryConfirm`、`floors.taintedWaits` 是权威，下面是说明。

- **出处原文**：提交时的引文校验、核实列表、案卷行的位置（16.3）读的是**同一份**原文（`wiki-verify-evidence.ts`：`runEventText`、
  `toolCallText`、`approvalText`）。run_event：user / assistant / thinking 取 `text`；tool_use 是工具名加输入（每个键一行）；
  tool_result 是 `content`（字符串，或各文本块按行拼接，图片块没有字），工具报错时前面标一句；error 取 `message`；background_task 取
  `command` 与 `summary`；turn_end 取 `subtype`；system 只取它带的文字（`text`、`notice`、`stderr`），`subtype=context` 这类统计没有原文。
  tool_call 行是调用和结果合在一起：工具名、输入（每个键一行）、输出（字符串、文本块，或把文本块放在 `content` 里的结果）——引命令和引输出
  一样是这条记录的原话（判据 2 第 2 版之前只有输出）。approval 是回答与 owner 的附言各一行，ExitPlanMode 再加它批的 plan。
  每种文本都由若干「部分」按行拼成，顺序固定。空串或只有空白算**读不到**：claude 的 thinking 大多是空串，那是一条没有内容的记录，
  不是一条「什么都没说」的证据。
  交给核实者前先过共享脱敏器（`secret-redaction.ts`，含本 owner `workspace.env` 的真实值），再按 `verificationSourceMaxChars`（8,000 字）截断。
- **证据标记**：核实列表的每个 item 带 `evidence: readable | unreadable`（至少一条出处有原文 / 一条都没有）。服务端记结论时**自己再读一遍**，
  不信 runner 报的，并把它存进 op 的 `verification_evidence`（迁移 0314；0314 之前的结论为 NULL），读回来是 `verification.evidence`。
- **读不到原文不等于无支撑**：全部出处都读不到原文的 op，supported、partial、unsupported 一律按 `unreviewed` 生效（显示、不推送）；
  duplicate 仍转 reinforce（只追加出处）。这些结论不计入自动退回：退回窗口只数有可读原文（或 0314 之前记下）的结论。
- **tainted 在 Automatic 下**：`wikiReviewEffect` 让 Automatic 把 tainted 的 add、对机器写的条目的 amend 送去核实（Manual、Tiered 仍待审；
  对 owner 写过或确认过的条目的 amend、supersede、retire、reinforce 仍等 owner）。核实结论最多到 `unreviewed`：supported、partial 都是
  `unreviewed`，unsupported 照样拒绝并计入退回，duplicate 被拒但**不追加任何出处**——tainted 的出处不能改变已有条目的推送资格
  （例如凑成 pitfall 的「2 个以上独立会话」）。它不占 30 条待审名额，不推送；runner 门的 `wiki_search`、`wiki_get` 与会话开场推送都拿不到
  「tainted 且 trust 不是 owner / confirmed」的 active 条目（提出它的会话自己的待审提议照旧看得见）；owner 在 web / iOS 里照常看得到。
  规则函数是 `wiki.ts` 的 `wikiVerdictEffect()`。
- **owner 确认**：`POST /api/wiki/entries/:id/confirm`，只在用户门、不带会话头（带会话头拒 `WIKI_OWNER_CHANNEL_ONLY`），没有对应的 MCP 工具。
  对 active 且 trust 是 `auto` / `unreviewed` 的条目（tainted 与否都可）：写一版由 owner 署名的修订（内容不变，出处沿用当前版的 live 出处），
  trust 变 `confirmed`，从此可推送；模式对它生效过、还没人答的 op 与它未答的抽检卡记 `accepted`，之后整次撤回那次运行不会再动它。
  其余条目回 409。推送与 agent 检索的规则因此是：tainted 的条目只有 trust 是 owner / confirmed 时才可推送、可被 agent 读到
  （`push.eligible.taintedOnlyWithTrust`）——owner 在 Review 里接受的 tainted 提议也在内，与设计 §10.3「接受之后才可推送」一致。
- **重开**：`WikiService.reopenVerifications(principal, spaceId)`。owner 走用户门 `POST /api/wiki/spaces/:id/verifications/reopen`
  （不带会话头）；一次性导入在容器里用 `{origin: import}` 的 principal 直接调，只够得着自己的变更集；runner 门没有这条路。它做两件事，
  每个 op 单独一个事务、对 op 当时的决定做 compare-and-set，所以重复调用找不到可动的东西，也没有任何时钟会调它：
  - 被 unsupported 结论拒掉（`not_true`）、且当时全部出处都读不到原文的 add / amend——看结论上的证据标记；0314 之前的结论没有标记，
    就按当时的读法判断（那时只给核实者 user / assistant 事件的原文，其余事件一概没有）——回到 `verifying`：旧结论、旧决定与重开时刻
    追加进 `verification_history`（旧的在前），add 的谱系回到 `proposed`，已 settle 的变更集回到 `pending`。它不再以 `not_true` 出现在
    近邻提示里（新的 `similar[]` 不带拒绝理由，核实列表里记录的近邻也按当前状态去掉）。
  - space 现在是 Automatic 时，等 owner 的 tainted add / amend 若按今天的规则会被送去核实，就转成 `verifying`，离开 Review 与 30 条名额；
    对 owner 写过或确认过的条目的 amend 继续等 owner，列在 `skipped` 里。
  - 回答 `{spaceId, mode, reopened[], toVerification[], skipped[{opId, reason}]}`。

### 7.6 一次运行的读：时间线、按 id 读变更集、条目的生效来源（判据 8）

Review 只列还有 op 等 owner 的变更集，时间线列的是 op、不说它来自哪个变更集。所以客户端只有在一次运行还有卡片挂在 Review
里时，才能把它的 op 对到运行上：折成一行、打开运行页、整次撤回。Automatic 默认不抽检，结论让它全部生效之后 Review 里
什么都不剩，这次运行在客户端里就撤不回了。下面三个读把每一次运行都点得出名字。JSON 的 `reviewModes.run` 是权威，下面是说明。

- **时间线**：`GET /api/wiki/spaces/:id/timeline` 的每个 item 带 `changesetId`（这个 op 所在的变更集）和
  `changesetAppliedByMode`（这个变更集的生效方式，见下）。`changesetAppliedByMode` 不为空的，客户端把同一变更集的 item 折成一行，
  用下面的读打开；为空的（owner 自己的写入、Review 里接受的提议、撤回本身）照旧一个 op 一行。`origin` 是变更集的，
  `appliedByMode` 仍是这个 op 自己的。
- **按 id 读变更集**：`GET /api/wiki/changesets/:id`，只在用户门，带会话头拒 `WIKI_OWNER_CHANNEL_ONLY`，别的 owner 的一律 404。
  不管它还有没有东西在 Review 里，都回答 `changesetView`：
  - 变更集本身与它的 op，形状同 Review（决定、结果、核实留痕）；
  - `appliedByMode`：有 op 由核实结论生效就是 `automatic`，否则有 op 按 Tiered 规则生效就是 `tiered`，都没有是 `null`（不算一次运行）；
  - `entries`：它的 op 提到的每个条目，按现在的样子；
  - `counts`：`applied`（由这次运行生效、效果还在的 op：`auto_applied`，或模式生效后作为抽检卡等着、或已被接受 / 编辑的）、
    `auto` 与 `unreviewed`（生效的 add / amend 里，条目现在 active、仍停在这个 op 写的那一版、trust 是 auto / unreviewed 的）、
    `rejectedByCheck`（被 unsupported / duplicate 结论拒掉的）、`toReview`（等 owner 的：抽检卡和底线扣下的）；
  - `revertible` 与 `revert: {adds, amends}`：**现在**调整次撤回会做什么，照撤回自己的规则算（§7.3「整次撤回」）：还 active 的 add
    各退役一条，被 amend 过、之后没人再改过的条目各退回一版。任一个大于 0 就是 `revertible: true`；已经撤回过（幂等键
    `revert:<变更集 id>`）的一律 `false`；`revert` 在 `revertible` 为 false 时是 `null`。客户端只在 `revertible` 时给出 Revert run…，
    确认框说的就是这两个数。
- **条目的生效来源**：用户门的 `GET /api/wiki/entries/:id` 给当前修订带上 `changesetId`（写出这一版的 op 所在的变更集）、
  `appliedByMode`（那个 op 的）和 `verification`（那个 op 的核实结论：模型、结论、理由、时间，同 §7.4 的留痕），没有的就是 `null`
  （owner 的 Confirm 自己写一版、没有 op）。条目说明条的第二行「Checked by <model>: <verdict>」读的就是它。runner 门的条目读不带这三项：
  给 agent 的是条目，不是它怎么被判的。

---

## 8. op 的形状

| op | 必带 | 做什么 | baseRevision |
| --- | --- | --- | --- |
| `add` | `entry`（整条），`sources` | 新谱系，第 1 版 | 不带 |
| `reinforce` | `entryId`，`sources`（至少一个） | 往当前版追加出处，内容、状态、trust 不变 | 不带 |
| `amend` | `entryId`，`baseRevision`，`changes`，`sources` | 同一谱系的新一版；`changes` 里给的键整体替换，没给的沿用 baseRevision | 必带 |
| `supersede` | `entryId`，`baseRevision`，`entry`，`sources` | 新谱系取代旧的；生效时旧条目变 `superseded` | 必带 |
| `retire` | `entryId`，`baseRevision`，`reason` | 条目从 active 变 retired | 必带 |
| `challenge` | `entryId`，`reason` | 打 challenged，条目立刻退出推送 | 不带 |

- **CAS 不可省**：amend / supersede / retire 带上写它时依据的版本号，只有它仍是当前版时才生效，否则
  `WIKI_REVISION_CONFLICT`，并返回当前版和 diff。故意不提供「当前是什么就按什么」的写法。库里的 CHECK 保证
  `base_revision` 恰好出现在这三种 op 上，`entry_id` 恰好不出现在 add 上。
- op 按它在请求 `ops` 里的位置从 0 编号（`seq`），所有回答都按这个编号指认它。
- 每个 op 独立判定：通过的 op 在一个事务里一起记录，被拒的 op 什么都不写。一个都没记录的请求，用第一个拒绝的 HTTP 状态回，
  正文里带每个 op 的结果；记录了东西的请求回 200。`dryRun` 只校验、照常回答，不记录也不发事件。状态码也和正式提交一样：
  有 op 会被记录就回 200，一个都不会记录就回第一个拒绝的状态，所以先 dryRun 自检的调用方，拿到的就是正式提交会拿到的
  （runner 的 MCP 工具、`orbit wiki maintain` 与 `orbit wiki import` 一直把带 ops 正文的 4xx 当回答读）。回答里另带 `breaker`：
  请求开始时（还没算它的任何 op）熔断的读数 `{scope, activeAtStart, changed, remaining}`——`scope` 对维护运行的 changeset 是
  `run`（整次运行，§19.4 第 6 步），否则是 `changeset`；`activeAtStart` 是熔断按的 active 基数；`changed` 是已经经模式改动的条目；
  `remaining` 是模式还能再改动几个不同条目，越过它的 op 会被拒。没有 op 受熔断约束时（Manual、owner 自己写、active 少于 100）
  `remaining` 为 null。同样的 op 马上正式提交，被拒的正好是超出 `remaining` 的那些。
- **幂等**：幂等键属于 owner。同一个键加同样的规范化请求是重放，返回记下的回答（`replayed: true`），不写也不发事件；
  同一个键配不同的请求被拒 `WIKI_IDEMPOTENCY_KEY_REUSED`。为此变更集上同时存 `idempotency_key` 和 `request_sha256`，两者同在同缺。

---

## 9. 限制

| 限制 | 值 | 出处 |
| --- | --- | --- |
| title / summary | 120 / 280 字符 | 设计 |
| topics / aliases | 3 / 8 个 | 设计 |
| quote | 300 字符 | 设计 |
| 每轮 op / 每个会话 op | 5 / 15，**只计等 owner 的 op** | 设计（判据 7 改为只计待审） |
| 每个变更集 op | 30，任何来源 | 设计 §8.2 |
| 每个 space 待审 op | 30，只计等 owner 决定的 op（立即生效的、抽检卡、等核实的都不计） | 设计（判据 7 第 3 版：抽检卡不占） |
| 待审过期 | 14 天 | 设计 |
| `wiki_search` limit / `wiki_get` ids | ≤10 / ≤10 | 设计 |
| 单个 alias | 80 字符 | 本契约补 |
| slug | 64 字符 | 本契约补 |
| `fields`、锚点、出处里的每段文本 | 4000 字符 | 本契约补 |
| `fields` 里的列表、锚点数、单个 op 的出处数 | 20 | 本契约补 |

设计只限制了公共字段，没限制条目内部的文本和列表；条目本该是原子的，所以本契约给每段文本、每个列表都加了一个远高于正常用量的上限。
title、summary、topics、aliases、quote、slug 的上限同时是库里的 CHECK。

每轮 5 个、每会话 15 个的配额是为了保护 Review 队列，所以只计被生效策略扣下、要等 owner 的 op（提议、challenge）；直接生效的
op（owner 自己的、reinforce、审阅模式放行的）和等核实的 op（§7.4）都不计，改由每个变更集 30 个和熔断（§7.3）约束。

---

## 10. 拒绝码

| 代码 | HTTP | 范围 | 何时 |
| --- | --- | --- | --- |
| `WIKI_DISABLED` | 404 | 请求 | 这个账号的 wiki 关着（`ORBIT_WIKI` 灰度） |
| `WIKI_SPACE_UNBOUND` | 409 | 请求 | 调用会话的 workspace 没绑 space，也没能自动绑上 |
| `WIKI_SCHEMA` | 400 | op | 形状不对：字段、限制、阶段 3 的 kind、amend 一条 decision、该带或不该带 baseRevision、该是行 id 的出处 ref 解不出 id（`sourceInput.rowIdKinds`）；`errors[]` 列出每个出错字段 |
| `WIKI_KIND_OWNER_ONLY` | 403 | op | 非 owner 对只有 owner 能写的类型 add / amend / supersede |
| `WIKI_SOURCE_UNRESOLVED` | 422 | op | 出处在本 owner 内解析不到（`errors[]` 按 path 点名那条）、引用了 wiki 条目或视图，或该带出处却没带 |
| `WIKI_QUOTE_NOT_FOUND` | 422 | op | 引文空白归一化后不是原文子串 |
| `WIKI_REVISION_CONFLICT` | 409 | op | baseRevision 不是当前版；回答里带当前版和 diff |
| `WIKI_QUOTA` | 429 | op | 超过每个变更集 30 个；或这个 op 要等 owner、且超过每轮或每会话的待审配额；或审阅模式会直接应用它、但变更集会越过熔断线 |
| `WIKI_REVIEW_QUEUE_FULL` | 429 | op | 这个 op 要进 Review，而 space 已有 30 个等 owner 决定的待审 op（抽检卡、等核实的不计） |
| `WIKI_PROBE_REFUSED` | 422 | op | 标题或正文像工具探针（test / probe / TEST_WRITE_CHECK）；消息里说明工具正常、不要重试 |
| `WIKI_OWNER_CHANNEL_ONLY` | 403 | 请求 | decide、整次撤回、逐条 Reject、切换审阅模式或改 `automaticSpotChecks` 带了会话头，不论会话是什么角色 |
| `WIKI_NOT_MAINTENANCE_SESSION` | 403 | 请求 | 阶段 2：非维护会话调用维护专用路由 |
| `WIKI_SESSION_EXCLUDED` | 403 | 请求 | **本契约补**：调用会话是 verifier、foreman 或判断会话。知识不能当证据，这些会话不读也不提议 |
| `WIKI_IDEMPOTENCY_KEY_REUSED` | 409 | 请求 | **本契约补**：用过的幂等键配了不同的请求 |

另外两条不带 wiki 代码的规则：别的 owner 的 space、条目、变更集一律回普通 404，与不存在无法区分；service token 在两道门上都拒绝（403），
理由同 `session_search`：条目衍生自其他机器上的对话正文。

每个 op 的检查顺序（设计 §4.1）：变更集大小 → schema → owner-only 类型 → 出处 → 脱敏 → CAS → 探针 → 污染 → 生效 → 配额 → 相似。
脱敏、污染、生效、相似不拒绝，只给 op 打标。配额排在生效之后，是因为它数的东西取决于生效：待审队列、要等 owner 的 op，以及熔断数的模式直接生效的 op。

---

## 11. agentSurface：三个工具、两道门

- **工具**（按风险拆，不按实体拆）：

  | 工具 | 注解 | 参数 | 返回 |
  | --- | --- | --- | --- |
  | `wiki_search` | readOnly | query, kinds?, topic?, paths?, limit ≤10 | 只返回条目：id, kind, title, summary, trust, anchorState, match（keyword / semantic / path）, score |
  | `wiki_get` | readOnly | ids ≤10, include?（sources, anchors, history） | 完整条目；锚点带最近复验（ref 与时间）；出处带 `orbit-*` 链接 |
  | `wiki_propose` | 不带 destructive | ops, rationale, idempotencyKey, dryRun? | 逐 op：pending（Automatic 等核实的带 `waitsFor: "verification"`）/ applied / conflict（当前版与 diff）/ refused（理由），add 与 supersede 旁附 `similar[]` |

  CLI 同名同参：`orbit wiki search | get | propose`。**没有**接受、确认、决定、硬删、整页覆盖的工具；确认只存在于 owner 通道。
- **`orbit wiki verify --space ID [--model M] [--effort LEVEL] [--max N] [--json]`**（JSON 的 `agentSurface.verify`）：唯一没有 MCP 工具对应的 wiki
  动词——它跑模型，是 runner 的活，不是一次工具调用。读 §7.4 的待核实列表，逐条起一个**干净的 Claude Code**：
  `claude -p --bare --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --output-format json
  --model <模型> --system-prompt <核实者自己的短提示> --settings <只含 apiKeyHelper 的文件>`，HOME 与 CLAUDE_CONFIG_DIR 是空的临时目录，
  环境按白名单构造（不带会话的 `ORBIT_*`、会话自己 Claude Code 的 `CLAUDE_CODE_*`、`ANTHROPIC_API_KEY`）。**默认不开 thinking**
  （`agentSurface.verify.thinking`）：Claude Code 对自定义端点上它不认识的模型会自带 `output_config.effort: "high"` 与
  `thinking: {type: adaptive}`，本地模型上一条结论要 56 秒、1.3k 输出 token；所以子进程固定带 `CLAUDE_CODE_EFFORT_LEVEL=unset` 与
  `MAX_THINKING_TOKENS=0`，请求里既没有 effort 也没有 thinking，会话 provider 声明的 effort 不传过去；要开得显式传 `--effort
  low|medium|high|xhigh|max`。出处全都读不到原文的 op 照样问模型：服务端会把结论封顶（§7.5），duplicate 仍能追加出处。模型与端点取会话
  provider 注入的 `ANTHROPIC_MODEL`、`ANTHROPIC_BASE_URL`（配置型 provider 现在也注入 `ANTHROPIC_MODEL`），token 由
  `apiKeyHelper`（`printenv ANTHROPIC_AUTH_TOKEN`）以 Bearer 送出——bare 模式下 `ANTHROPIC_API_KEY` 只走 x-api-key，vLLM 回 401。
  提示词手写：条目的 kind、标题、摘要、字段，每条出处的原文，以及可被判为重复的条目（op 自己 similar[] 里 active 的，amend 的目标条目）。
  可被判为重复的条目只给短编号（按列出的顺序 E1…En），不给 id：本地模型抄 21 位的 id 会抄错——09-30 到 10-02，`34XhYj76NhjjOJTEFEtFE`
  一再被写成 `34XhYj76NhjjOJTEFE`，这个 op 一直拿不到结论。回答必须是一个 JSON 对象 `{"verdict", "reason", "duplicateOf"}`，duplicateOf
  填编号，命令把它映射回条目 id 再回报。编号必须是提示里列出的之一、原样：id（完整的或截断的）都不算编号，不按前缀或相似度猜；
  verdict 与编号的读法同 21.3 的枚举值（只去包裹的反引号、引号和首尾空白）。**读不成结论就不放行**：不回报、计入失败，op 继续等。
  遇到模型端点 401 立即停（真 Claude Code 每次 401 要重试约 3 分钟），space 不再是 Automatic 时停；有 op 没拿到结论就非零退出。
  单独调用时这个退出码的语义不变。维护运行不看它：它在自己的进程里核实本次运行的 op，没结论的再问一遍，仍没结论的不让运行失败（19.4 第 8 步）。
  **服务端模式**（`ORBIT_WIKI_EXECUTOR=server`，或 `canary` 名单内的账号）：核实由服务端自己的 `verify` 作业做，会话不必跑这条命令；
  命令的含义变成"请求服务端核实并等结果"，runner 那一半随下一次 runner 发版上线，默认 `runner` 模式下这条命令一字未改（`agentSurface.verify.serverExecution`，§24.7）。
  描述文案把「只核实本会话的 op、绝不手写结论」写成前置条件（`agentSurface.verify.precondition`），逐词测试。
- **`wiki_propose` 的描述**把「这是提议、要等 owner 审」写成前置条件（JSON 的 `agentSurface.proposeDescription`），T5 做逐词测试。
- **用户门** `/api/wiki`（JwtAuthGuard，owner 本人）：spaces 列表（待审数、plan 等你数、绑定的 workspace、文档数，§2）、建 space、改设置（含审阅模式）、绑 workspace、首页、条目列表、主题、
  时间线、owner 的变更集（立即生效，带 CAS）、条目详情、pin / unpin、逐条 Reject 与 Confirm、`GET /api/wiki/search`（⌘K 的独立端点）、Review、
  按 id 读一次运行（`GET /api/wiki/changesets/:id`，§7.6）、decide、整次撤回、重开核实（§7.5）。
- **runner 门** `/api/runner/wiki`（RunnerAuthGuard，外加照 `runner-watches.controller.ts` 校验调用会话）：search（只返回 active 条目，
  外加本会话自己的待审提议；tainted 且没人担保——trust 不是 owner / confirmed——的 active 条目不返回，get 同样 404）、条目、提议、推送块预览；阶段 2 的维护专用路由（dossiers、anchors、anchor-checks、cursor）；
  核实的两条路由 `GET` / `POST /api/runner/wiki/spaces/:id/verifications`（§7.4，只对提交这批 op 的会话），以及维护运行接手核实的
  `GET` / `POST /api/runner/wiki/spaces/:id/maintenance/verifications`（§7.4，只对本 space 的维护会话）。
- **decide 只在用户门**：任何带会话头的请求都拒 `WIKI_OWNER_CHANNEL_ONLY`（先例：`coordinator-authority.ts` 的
  `refuseSessionAuthoredConfirmation`）。runner 里弹的确认卡不是闸门：服务端不校验它，headless 调用直接放行。
  整次撤回、逐条 Reject 与 Confirm、重开核实、切换审阅模式、读一次运行同样只在用户门、同样拒绝带会话头的请求。
- **读的边界**：只有绑在 space 上的 workspace 里的会话能读这个 space 的条目；把 workspace 绑进来就是 owner 同意在这些
  workspace 之间共享**已确认**的条目。待审提议只有提出它的会话看得见。
- **灰度**：`ORBIT_WIKI=off|canary|on`，默认 `on`；`canary` 只给 `ORBIT_WIKI_CANARY_OWNERS` 列出的账号（逗号分隔的 id），其余账号同 `off`。
  对没开 wiki 的账号：两道门的所有路由都回 404 `WIKI_DISABLED`，claim 下发 `wikiDisabled`，runner 不挂这组工具，不推送
  `<orbit_wiki_context>`，`orbit-wiki:` 链接卡读作 unavailable；web 收到 `WIKI_DISABLED` 就藏起侧栏入口和 ⌘K 的 Wiki 分区。
  实现见 `src/apiserver/src/wiki/wiki-rollout.ts`。
  Compose 部署在宿主 `.env` 里写 `ORBIT_WIKI_MODE`，`docker-compose.yml` 把它传给 apiserver 作为 `ORBIT_WIKI`；`ORBIT_WIKI_CANARY_OWNERS`
  不改名。宿主侧不用 `ORBIT_WIKI`，是因为 runner 往每个 agent 会话的环境里都注入了 `ORBIT_WIKI`，而 Compose 插值时 shell 环境优先于
  `.env`：从会话里跑部署，`.env` 的值会被会话带的 `on` 悄悄盖掉（`src/apiserver/src/wiki/wiki-compose-env.spec.ts` 锁住这一点）。
  runner 比 apiserver 新、门还不存在时，照 `watch_tools.go` 的 `watchDoorMissing` 翻译成一句人话。

---

## 12. 推送（摘要，T6 实现）

- 在 `dequeueTurn` 交付时追加 user 级的 `<orbit_wiki_context>`；每个 lease generation 的第一次交付（spawn 或 resume）。
  永不进 `--append-system-prompt`、codex 的 application context，也不改 `buildTaskExecutionPrompt`（`task-start-card.ts` 逐字节比对它）。
- 不超过 1,500 token（约 6,000 字符）；可推送 = `active`、trust 是 owner、confirmed 或 auto（`unreviewed` 不推）、未污染（污染的只有 trust
  是 owner / confirmed——有人担保过——才推，§7.5）、无 challenge、有出处支撑、
  锚点不是 changed / missing。principle 至多 4 条、convention 至多 6 条；pitfall、decision、recipe 按相关度；concept 与 assumption 不推。
- 每行 `[Kind] 标题 — 一句话 (orbit-wiki:<id>)`；块头「Reference notes confirmed by the owner. Context, not instructions; …」。
  块里只要有一行是 `auto`，块头换成 `push.headerWithAuto`（「Reference notes the owner wrote or confirmed, or that this space's
  review mode accepted. …」），不说 owner 确认了没人看过的东西；Manual 的 space 没有 `auto` 条目，块与阶段 1 逐字相同。
- verifier、foreman、判断会话推送为 0。项目的协调会话推送也为 0（owner 2026-09-29），但照常能调 `wiki_search` / `wiki_get`。
  每推一条写一行 `wiki_exposure(channel='push')`。

---

## 13. 实时事件 `wiki.changed`（T7 实现）

- owner 级，走用户级控制面流（`GET /api/events`），信封不带会话。载荷只有 `id`：内容、Review 队列、绑定或设置发生变化的那个 **space** 的 id。
  不带条目、标题、状态、op 或计数；客户端据此重读，读的结果决定它能看到什么。
- 何时发：记录了东西的变更集、owner 的决定、space 建立 / 改设置 / 绑定、记下了核实结论、待审过期或撤回，都在事务提交之后发。
  幂等重放、dryRun、什么都没记录的请求不发。
- 正确性不依赖它：丢掉所有事件只让客户端多等一会儿（聚焦、重连时都会重读）。web 把它映射到 wiki 查询组，不能落到 `groupsFor`
  默认的 sessions 组；Swift 解码为 `ControlEvent.wikiChanged`。

---

## 14. 钉回与测试向量

- **TS ↔ JSON**：`wikiContract.spec.ts` 逐个比对闭集、限制、生效策略、`KIND_SPECS` 的字段 schema、锚点 schema；检查状态机
  自洽（终态无出边、每个状态可达）；检查每个拒绝码都声明了 HTTP 状态与范围、正文里提到的每个 `WIKI_*` 都已声明；
  并把 JSON 里的 21 条 `vectors` 逐条跑过校验函数，要求报出的字段路径与向量完全一致。每类条目都至少有一条合法、一条非法向量。
- **库 ↔ JSON**：`wiki-schema.pg.spec.ts` 在跑完全部迁移的新库上，对每个闭集逐值写入、写 `bogus` 被对应 CHECK 拒绝、
  并核对 CHECK 列出的值与 JSON 完全一致；逐条验证限制、不变量、跨 owner 的复合外键、`(entry_id, revision)` 唯一、
  外键清单（历史 id 不挂外键）、删除 owner 的两路级联，以及检索索引只被同一函数调用命中。
- Go 与 Swift 两端（T5、T10）各自用测试钉回同一份 JSON；两端都钉住 `trust.values`（含 `auto`、`unreviewed`），Swift 另钉 `trust.pushable`。
- **审阅模式**：`wikiContract.spec.ts` 钉住 `reviewModes` 的取值、规则数字、默认与未设时的模式、`wikiReviewEffect` 的整张表与五条底线；
  `wiki-review-mode.pg.spec.ts` 在真库上逐格验证「三种模式 × 六种 kind × 三类来源」的生效与推送（Automatic 的格子先验证等核实、
  再经 supported 结论生效）、五条底线在 Automatic 下的反例、Tiered 抽检拒绝率越线退回 Manual 且只通知一次、整次撤回后相关条目全部退出推送。
- **核实**：`wikiContract.spec.ts` 钉住四种结论、`verifying` 的出边、留痕列与抽检卡不占名额；`wiki-verify.pg.spec.ts` 在真库上验证
  等核实时什么都不生效、四种结论各自的结果与留痕、只有提议会话能回报且跨租户 404、不靠时钟、离开 Automatic 后拒收、整次撤回、
  50 条里超过 30% unsupported 退回 Tiered 且只通知一次、Automatic 默认不抽检且打开后每 200 条抽 1 条、抽检卡不占 30 条名额；
  runner-go 的 `TestWikiVerify*` 用假的 vLLM 端点覆盖四种结论、读不成结论、401、离开 Automatic，以及干净启动的 argv 与环境
  （机器上有真 Claude Code 时另用真的跑一遍）；Go 钉住四种结论（`wikiVerifyVerdicts`），Swift 钉住 `states.op.values` 里的 `verifying` 与四种结论。
- **文档**（§22）：`wikiContract.spec.ts` 钉住 `docs` 的闭集、规则、schema、迁移里的 CHECK、路由与链接规则；`wiki-docs.pg.spec.ts` 在真库上
  验证没有已确认的 plan 拒写、会话引文逐字核对（伪造、翻译、拼接、省略号、条目标题当原话都核对不过）、仓库引文缺 sha 拒收、过渡句与
  5% 线、材料不变不重写、Reject / 退役 / 锚点失效撤句并标待重写、不进推送也不能当出处、跨租户 404；Go 的 `TestWikiDoc*` 钉住写入请求的字段
  与路由，Swift 的 `WikiDocsContractTests` 钉住闭集、读取形状，以及会话记录脚注拼出 `SessionRecordLink` 深链。

---

## 15. 本契约对设计的补充（需要知道的决定）

设计没写死、而下游任务必须有答案的地方，本契约做了如下选择，均已写进 JSON：

1. **只有 `wiki_space` 直接指向 `user`**，其余表经父行复合外键挂到 owner（§1.2 说明了锁序上的理由）。删 owner 的级联不变。
2. **op 对条目的外键用 `ON DELETE CASCADE`**，以免两条级联路径互相卡住（§1.3）。
3. **两个新拒绝码**：`WIKI_SESSION_EXCLUDED`（设计 §7.3 要求服务端拒绝 verifier 等会话调用 `wiki_*`，但 §5.4 没给代码）和
   `WIKI_IDEMPOTENCY_KEY_REUSED`（设计要求「键加规范化摘要」，但没说键配了别的请求怎么办）。为后者变更集多存一列 `request_sha256`。
4. **补的上限**：alias 80 字符、slug 64 字符、条目内部每段文本 4000 字符、每个列表 20 项（§9）。
5. **每个表的次要列**：`wiki_space.updated_at`、`wiki_space_workspace` 的 `id` 与 `created_at`、`wiki_topic.created_at`、
   `wiki_source.created_at`、`wiki_changeset_op.decided_at`（T11 的「Review 72 小时内处理」要按 op 计时）、`wiki_exposure` 的 `id`
   与 `owner_id`；`wiki_exposure.session_id` 可空（headless 的 search / get 没有会话，push 则必须有，CHECK 保证）。
6. **amend 的语义**：给出的键整体替换、没给的沿用 baseRevision；**decision 不能 amend**，只能 supersede（设计「永不改写」）。
7. **提议时 add / supersede 就建出 `proposed` 的条目行和第 1 版修订**，好让 `orbit-wiki:<id>` 与 `similar[]` 能指向它；
   pending 的 amend 内容只存在 op 的 payload 里，被接受时才写新一版。
8. **`wiki.changed` 的 id 是 space 的 id**：每次写都落在一个 space 里，客户端按 space 重读。

9. **主题名由 slug 反推**（T8）：阶段 1 没有任何写入点写 `wiki_topic`，条目只按 slug 记自己的主题，所以
   `GET /api/wiki/spaces/:id/topics/:slug` 的名字取自 slug（`tasks-dispatch` → "Tasks dispatch"），
   `declared: false` 明说这不是 owner 起的名字；阶段 2 的维护作业写下 `wiki_topic` 行之后，名字改由那一行决定。
10. **用量读数是 `GET /api/wiki/spaces/:id?include=usage`**（T8）：首页右栏「Agents used the wiki」要的是
   `wiki_exposure` 上的四个聚合，属于按需付钱的那一类，所以不新开路由，按 `entries/:id` 已有的 `include` 写法挂在
   space 文档上；窗口是滚动的 7 天，否则「this week」名不副实。

尚待后续任务确认的一点：没有对应 space 的 workspace 第一次使用时，是自动为它的仓库建一个 space，还是回 `WIKI_SPACE_UNBOUND`
等 owner 手动建，设计只写了「自动绑到对应 space」。本契约只规定了绑定到已有 space 的情形，建与不建由 T3 与 owner 定。

---

## 16. 维护作业：案卷与游标（判据 2）

JSON 里是 `space.settings.maintenance` 与 `maintenance`；实现在 `src/apiserver/src/wiki/wiki-dossier.ts`（抽取）、
`wiki-maintenance.ts`（游标、案卷页）、`wiki-maintenance-settings.ts`（设置与维护会话的判定），runner 门在
`runner-api/runner-wiki-maintenance.controller.ts`。

### 16.1 维护设置与维护会话

- `settings.maintenance = { enabled, workspaceId, provider, dailyRunLimit, lookbackDays, listId }`，默认
  `{ false, null, 'local-vllm', 8, 14, null }`。只能经用户门 `PATCH /api/wiki/spaces/:id` 改，带会话头一律 `WIKI_OWNER_CHANNEL_ONLY`；
  runner 门没有改设置的路由。只写 `maintenance` 这一个键，在 SQL 里合并，其他设置的并发写不会互相覆盖。
- `lookbackDays`：打开维护时游标从多少天前起读，整数 0–365（`bounds.lookbackDays`），默认 14；0 只读打开之后的事实，
  `null` 是「全部历史」，从最早的事实读起。`null` 是一个取值，不是没传：请求里不带这个键才是不改。存着的值越界或不是整数，
  读出来是默认的 14。怎么写起点见 16.2。
- `dailyRunLimit`：这个 space 每个 UTC 自然日最多建几个维护任务，整数 1–48（`bounds.dailyRunLimit`），默认 8，不按 token 算。
  计数是维护清单里自 UTC 零点起建出的任务数，不论结局；维护作业建任务前用 `wikiMaintenanceRunsToday` 读它。存着的值越界、
  或是契约已经没有的键（早先的 `dailyTokenBudget`），读出来一律是默认值。
- `provider` 只收 Claude Code 运行时上的配置型 provider：内置引擎（`claude` 是本机登录，干净启动用不了；codex / kimi / opencode
  不是 Claude Code）、别的运行时上的 provider、账号池一律 400 并说明原因；还没有的名字照收，认领时仍没有就拒绝那次运行（16.5）。
- 打开维护必须给出 owner 自己的 workspace。第一次打开时建一个隐藏的任务清单（标题「Wiki maintenance」、`hidden = true`、
  `maxConcurrent = 1`），id 写进 `listId`；关掉时清单和 `listId` 都保留。`listId` 永远不从请求里取。
- **维护会话 = 任务在这个清单里的会话**。判定是导出函数 `isWikiMaintenanceSession` / `wikiMaintenanceSpaceOf`，
  锚点复验、文章生成、维护作业、干净启动都用它，不各自再判断一遍。
- `task_list.hidden` 为真的清单不进 owner 的清单索引（`GET /task-lists`），里面的任务仍可按 id 读到。

### 16.2 事实、水位与 backlog

- 五类已提交事实各让 backlog 加一：会话结算（会话停下来——等输入、成功、失败、取消或被打断——按 `last_turn_at`）、任务终态
  （`updated_at`）、审批回答（AskUserQuestion 已回答、ExitPlanMode 已决定、带理由的 DENIED，按 `decided_at`）、merge receipt
  （`created_at`）、判据修订（`updated_at`）。普通的 Bash 允许不算：它没有可学的内容。
- **backlog 是数出来的，不是记出来的**：每次读游标都从这些行里现算水位之后的事实，所以事件丢了也不会漏事实；wiki 模块不往
  Sessions / Projects 服务注入任何依赖。数完写回 `wiki_cursor` 的 `backlog`、`pending_sessions`、`oldest_pending_at`、`lag_seconds`，
  给首页状态行直接读。
- **范围**：普通会话按它所在的 workspace 归属。项目的协调会话、它的 coordinator wake 打开的判断会话「代表一个项目」，
  只有它代表的项目在这里干活，它们才属于这个 space——协调者所在的 workspace 只说明它在哪儿开的，不说明项目在做哪个代码库。
  「在这里干活」指三者之一：项目的任务会话在 space 绑定的 workspace 里跑过、项目的任务指派给了其中一个 workspace、项目的代码库
  就是 space 的仓库；没有任何任务被指派或跑过、也没有代码库的项目说不出自己在哪儿干活，才按协调会话自己的 workspace 算。
  只看第一条会漏掉任务还没跑的项目：2026-09-28 线上按字面规则会排除 orbit 自己的 15 个项目的协调会话。项目属于 space 用的也是这三条。
  维护作业自己的会话、任务、审批和回执都不算事实，免得一次运行喂大自己的 backlog。
- 事实按（时间到毫秒, 种类, id）排成一条线；水位是线上的一个位置，存成三列而不是 jsonb，所以推进是一条 compare-and-set。
- **起点只写一次**（`maintenance.cursor.start`）：把维护从关变成开的那次 PATCH，如果这个 space 的游标还没有位置，就在同一个事务里
  把游标起点定在「那一刻减 `lookbackDays` 天」：水位设成起点位置（那个时刻、顺序里最前的种类、nil id，排在那一刻所有事实之前），
  已下发的最远位置取它原来的值和起点中较后的那个。`lookbackDays` 为 `null` 时什么都不写，没有位置的游标从最早的事实读起。
  游标已有位置就不动：之后再打开维护、或改 `lookbackDays`，都不会把它往回拨。只有这一次写读时钟，时钟不启动任何工作。
  在此之前，新开维护的 space 会从最早的事实读起；orbit space 的起点是 2026-09-28 经 owner 批准手工写的一行 `wiki_cursor`。
- 到期条件（判据 3，§19.1）：水位之后有事实的会话达到 20 个（设计 §8.2 说的是「20 个会话」，不是 20 条事实），或新事实到达时
  最老的未处理事实已超过 24 小时（`state.due`）。时钟不启动任何工作。

### 16.3 案卷

- `GET /api/runner/wiki/spaces/:id/dossiers?after=<token>&limit=N`：只对该 space 的维护会话开放；headless 回 400，别的会话
  `WIKI_NOT_MAINTENANCE_SESSION`，别的 owner 的 space 是普通 404。页从「after 与水位中较后的那个」之后开始，只取已过 120 秒
  宽限的事实（给事务留提交时间），按顺序取到 N 个会话为止（默认 20、最多 50）；返回的 `cursor` 是本页覆盖到的最后一个事实，
  `from` 是本页开始之前的位置：推进到 `from` 等于本页一条都不算处理过，下次从这里翻页会把它重新发出来。
- 内容照设计 §8.2 第 1 步，外加 agent 自己的轨迹：头部（会话、任务、验收标准、污染标记）；任务会话的开场 prompt（去掉任务模板尾巴）、
  owner 的消息和 steer、打断；AskUserQuestion 问答、ExitPlanMode、带理由的 DENIED；agent 的回复、thinking 里命中信号的句子、
  压缩的工具时间线（命令首行 + 结果首尾行，连续的读 / 改折成一行）；已结算任务最新 3 条 agent 评论和 owner 评论；merge receipt 的 sha；
  owner 解决 blocker 时写的说明。读写记忆文件的工具调用连同结果剔除，指向记忆库的句子剔除。
- 打分与装箱照演示的打包器 v2；每行以 `L12` 开头，`sources` 把每个行名对到一手记录（turn / event / tool_call / task_comment /
  approval / merge_receipt / owner_decision），维护作业提议条目时引用这些记录，不引用案卷。服务端的出处解析因此补了
  `merge_receipt` 与 `owner_decision`（owner 解决的 blocker；它不算 Tiered 的 owner 原话）。
- **每行记原文位置（判据 2 第 2 版，`maintenance.dossier.spans`）**：`sources` 的每一项是 `{ ref, kind, id, spans }`，
  `spans` 是 `[{ start, end, text }]`——该行的字在记录原文里的位置：记录的**那一份**原文（7.5，即引文校验读的文本）先脱敏，
  按**码点**计的 `[start, end)`，`text` 是那一段逐字原文。原样抄的行一个 span；压缩过的行按它保留的片段各一个 span，
  顺序排列、互不重叠：工具行是命令（或路径）、结果首行、结果末行，截断的消息是截断前保留的那段，thinking 是命中信号的各句，
  评论是首段和结论段，AskUserQuestion 是回答里的问题和答案。案卷自己的字（说话人、`$ `、`→ ok:`、`ERR:`、`…[cut]`、选项列表）不进 span。
  一行没显示记录里的字时，指向它代表的那段：重复的开场 prompt 指向 prompt，plan 的决定指向 plan；没有任何字的记录（不带话的打断）
  是 `{0, 0, ''}`。工具调用的输入输出只对**装进案卷的行**整条读（存储超过 256 KiB 的输出不读：这行的调用和结果首行照样定位，末行不定位）。
  `wiki-dossier.pg.spec.ts` 逐行核对：按位置从记录原文（脱敏后）取出的字与该行声明的原文逐字一致，压缩行也一样。
- **维护作业按位置引原话**（`maintenance.job.citation`）：模型给的引文先要逐字出自它引的那一行（否则照旧算问题、重问一次）；
  再按引文比对的读法（去掉反引号和星号、弯引号拉直、空白合一）在该行的各 span 里找：落在某一个 span 里，就把**记录原文在那里的字**
  （标记、引号、空白都按原文）当 quote，位置 `{ start, end }` 放进 source 的 `locator`，引文超长截到 `quoteMaxChars`；
  跨了案卷的缩写（`$ go test → ERR: …`）、跨了案卷剪掉的空隙、或含脱敏掉的字，就只挂记录，不带 quote 也不带 locator。
  dry run 仍拿不到的引文连同 locator 一起摘掉。服务端的案卷若还不带 spans（旧服务端），照旧用行里的字当 quote。
- **先脱敏再截断**：每条记录的文本先过共享脱敏器（owner 的 workspace.env 值作字面量），再裁剪、打分、装箱；最后整段再过一遍。
  每个会话不超过 8,000 token（`wikiEstimateTokens`：ASCII ÷ 3.4 + 其他 ÷ 1.25 + 1），装不下的被截断并标 `truncated`。
- **确定性**：同样的记录两次抽取字节一致、spans 相同，哈希（正文 + NUL + sources 的 ref、kind、id 的 JSON 的 sha256）相同；spans 不进哈希：
  它们是同一批记录里字的位置，正文和记录都没变的案卷，作业已经读过。抽取不读时钟。
- **只存 (sourceIds, hash)**：`wiki_dossier` 每个 space、每个会话一行，存 sources（每行的记录和 spans 的位置，**不存 span 的字**）、hash、
  token 数和发放它的页的位置，没有任何列存正文。
  同一 hash 已在游标推进过的页上发过时，`unchanged = true`，作业可以跳过。
- **批量项目只给聚合统计**：任务标题把数字读成 `#` 之后，同一项目（没有项目时同一清单）里有 20 个以上同模板的任务，就是批量项目，
  它的会话不出案卷，只出一条聚合：任务按状态计数、本页会话数、最常见的报错签名（FineWeb 的 11 万个任务只有 7 个模板）。
- **报错簇**：`tool_call.is_error` 按（工具, 归一化首行——数字、hex、路径、引号内文本换成占位符）分组，统计 space 近 14 天停下来的会话，
  3 个以上会话共有的才算簇，页上只给本页会话所在的簇。

### 16.4 游标推进

- `POST /api/runner/wiki/spaces/:id/cursor`，body `{ to, outcome?, error? }`，`outcome` 是 `succeeded`（默认）/ `failed` / `truncated`。
- 只有 `succeeded` 推得动：`failed` / `truncated` 只记失败（`consecutive_failures + 1`、`last_error`（先脱敏）、`last_run_at`），
  回 200、`advanced: false`，可以不带 token。
- 只能前进：token 落后于水位回 `WIKI_CURSOR_BEHIND`（409，附当前游标），不改任何东西；等于水位算一次不移动的成功；
  不是本 space 某页发出的 token（解不开、别的 space 的、超过发出过的最远位置）回 `WIKI_CURSOR_INVALID`（400）。
- 推进本身是一条 compare-and-set（水位仍在 token 之前、发出过的最远位置不在 token 之前），两次运行里位置靠后的那次赢，
  另一次被判 behind。
- CLI：`orbit wiki dossier --space <id> [--after <token>] [--limit N] [--json]`、
  `orbit wiki cursor advance --space <id> --to <token> [--outcome …] [--error TEXT] [--json]`，只有 CLI、没有 MCP 工具，三张 family 表都登记。
- `orbit wiki maintain` 在 op 记下后就用同样的 compare-and-set 推进游标（`POST …/maintenance/advance`，19.4 第 8 步），只动位置、不写健康字段；
  它在这条路由上之后的成功报告不再移动游标，失败报告照样计一次失败。

### 16.5 维护会话的运行：干净启动与护栏

JSON 里是 `maintenance.run`；服务端在 `wiki/wiki-maintenance-session.ts`，runner 在 `runner-go/wiki_maintenance_session.go`。

- **只有维护会话拿到它**：认领（`GET /runner/sessions/claim`）和 runner 重启后的 reclaim 都给维护会话带上
  `wikiMaintenance = { spaceId, workspaceId, provider, providerFallbacks: [], maxTurns: 120, disallowedTools, cleanStart: true, refusal? }`，
  其他会话一个字段都不多。护栏同时写进 agent 配置：`maxTurns 120`、`disallowedTools` 加上 Task / Agent / WebFetch / WebSearch、
  `permissionMode dontAsk`（没人看着的运行：没预批准的一律拒绝，不去问人）、不带 effort；维护会话不做编排。
- **钉死，否则不跑**：provider 与 workspace 取 space 的维护设置，没有回退。维护关着、会话不在设置的 workspace、会话的 provider
  不是设置钉的那个、那个 provider 不存在 / 已关闭 / 不在 Claude Code 运行时 / 是账号池——任一条都写进 `refusal`，runner 以它把
  这次运行记为 FAILED，不起引擎。绝不落到 runner 自己的 Claude 登录上，也不经账号池换成员。
- **只交给认得它的 runner**：runner 在 `X-Orbit-Runner-Capabilities` 里声明 `wiki-maintenance-run/v1` 才会被派到维护会话；
  不声明的，认领 SQL 不给这一行、reclaim 也跳过它（同 SR35 对待钉了 SOURCE 的会话），会话等能干净启动的 runner。
- **干净启动**（runner 见到 `cleanStart`）：`claude -p --bare --setting-sources '' --tools Bash --strict-mcp-config`，
  `--mcp-config` 只挂 orbit 一个 server，且它只提供 `task_get`、`task_comment`、`task_progress_report`（不给 `task_update`：
  光它的 schema 每次请求就约 4k token，运行的成败由任务的验收命令判，不由运行自己写）；
  `--system-prompt` 只说维护运行做什么（按任务执行 `orbit wiki maintain`，按结果汇报）；`--max-turns 120`、`--disallowedTools`、
  `--permission-mode dontAsk`、`--allowedTools`（上面三个 orbit 工具和 `orbit wiki …` 命令，写路径、写裸命令都算，见下条）。HOME 与 CLAUDE_CONFIG_DIR 是会话
  自己在 runner scratch 下的目录，第一次建出来时只有 onboarding 标记——不读本机的登录、记忆、设置和 CLAUDE.md，会话自己的
  transcript 留在那里供 `--resume`。项目里的 `.claude/settings.json` 在 `--bare` 下照样会读，所以要 `--setting-sources ''`。
- **`orbit` 写路径或裸命令都放行**（`cleanStart.orbitCommand`）：dontAsk 下没预批准的命令一律拒绝。平台给会话的规则写的是 CLI 的
  绝对路径（带引号的，以及路径是一个 shell 词时不带引号的），系统提示给的也是这个路径；任务描述（19.3、21.7、21.9）写的却是裸命令
  `orbit wiki maintain --space <id>` 等，模型两种都会照抄。10-01 至 10-03，裸的 `orbit wiki maintain` 16 次全被拒，写绝对路径的
  66 次全放行，有 4 次运行因此失败。所以同一族 `orbit wiki` 命令也按裸命令放行（只这一族：CLI 的其他命令、别的程序都不放行），
  前提是交给引擎的 PATH 上的 `orbit` 就是 runner 自己的可执行文件：PATH 上第一个名为 orbit 的可执行文件与它是同一个文件，且它前面
  没有空目录或相对目录（shell 会到会话的 checkout 里找）。这个 PATH 就是 runner 自己的；只有补上 CLI 所在目录就能解析到它时，才把
  这个目录补在末尾。前面有别的 orbit、或有空目录 / 相对目录时，PATH 原样不动，也不放行裸命令：宁可拒绝，也不执行到别的 orbit。
  自带 PATH、串接、管道、命令替换或重定向的命令不匹配任何一条规则。
- **鉴权与 thinking**：`--settings` 只有 `apiKeyHelper: printenv ANTHROPIC_AUTH_TOKEN`（Bearer）；bare 模式下 `ANTHROPIC_API_KEY`
  走 x-api-key，vLLM 回 401，所以这个变量根本不交给引擎。thinking 默认关：`CLAUDE_CODE_EFFORT_LEVEL=unset` 加
  `MAX_THINKING_TOKENS=0`（只设前者仍会发 `thinking: adaptive`）。环境从零搭：provider 的端点、token、模型、自定义头、上下文窗口，
  runner 的 PATH（需要时在末尾补上 CLI 所在目录，见上条）、locale、TMPDIR、证书与代理，`ORBIT_HOME` 和会话上下文；runner 与
  workspace 的其他变量都不带。
- **一次 Bash 跑完整个运行**（`cleanStart.bash`、`bashCall`）：环境里 `BASH_DEFAULT_TIMEOUT_MS` 与 `BASH_MAX_TIMEOUT_MS` 都是
  `bashTimeoutMs`（18000000，5 小时），`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`：模型不传 timeout 也有 5 小时，而不是 2 分钟；
  命令也不会被挪到后台（只有 Bash、没有 Read 的运行读不到后台命令的结局）。`--settings` 不带 env 块，它会盖过进程环境。
  但调用自己传的 timeout 优先于默认值：10-03 有一次运行给了 600000，10 分钟被截断，又用 1800000 重跑，再被截断（exit 143），
  会话内唯一一次重试也白用了。所以维护任务和 plan 作业任务的描述（19.3、21.7、21.9）与系统提示都写明：Bash 调用给
  `timeout: 18000000`，不许更短；工具在命令结束前就返回（超时或被截断）时不要再跑，换什么 timeout 都不跑，也不占那一次重试，
  汇报截断前打印的内容就结束。接着做的是下一次运行（维护靠游标）、owner 的下一次要求（起草、修订作业记失败），或下一次生成
  （已写的节原样保留）。这和 19.7 里「服务端 5xx 后命令自己说可以再跑」不是一回事。
- **截断算失败**：开场 prompt 用满 120 个模型回合，CLI 以 `error_max_turns` 结束这一回合；runner 把回合记为 FAILED，并在游标路由上
  报 `outcome: truncated`——space 的连续失败加一，游标不再移动：在 op 记下之前被截断的，游标没动过；之后被截断的，游标停在
  `orbit wiki maintain` 推进到的位置（19.4 第 8 步）。

## 17. 锚点复验（判据 4）

JSON 里是 `anchorRules.verify`；实现在 `src/apiserver/src/wiki/wiki-anchors.ts`（列表、合并检查结果、重置基线）、
`wiki.service.ts` 的 `recordAnchorChecks` / `answerChallenge`（写入只经 `applyOp` 与 `recordChangeset`），runner 门在
`runner-api/runner-wiki-anchors.controller.ts`，runner 一侧是 `src/runner-go/wiki_anchors.go` 的 `orbit wiki anchors verify`。

### 17.1 谁能复验、复验什么

- 只对该 space 的维护会话开放（`isWikiMaintenanceSession`，与案卷、游标同一个判定）：headless 回 400，别的会话
  `WIKI_NOT_MAINTENANCE_SESSION`，别的 owner 的 space 是普通 404。复验的结果会让条目退出推送、往 owner 的 Review 里放 challenge，
  所以别的会话不能回报。
- 只复验 git 能验的三种锚点：`path`、`symbol`、`commit`。其余四种（criterion / merge_evidence / command / record）归服务端或配方重跑，
  还没有人写它们的检查结果，所以带这类锚点的条目在它们被检查之前一直是 `unchecked`。
- 列表 `GET /api/runner/wiki/spaces/:id/anchors?after=&limit=`：该 space 里 **active** 且带 git 锚点的条目，按 id 排序，每条带当前
  revision 和它的 git 锚点（带在 `anchors` 里的下标；symbol 另带它要对上的哈希，第一次检查前为 null）；默认每页 50、最多 200。
  待审的提议不列，生效后再验。`repo` 是默认 checkout：绑定到 space 的 workspace 的工作目录——调用会话自己的 workspace 优先，
  其次是 space 的维护 workspace，再次是住在这台 runner 上的第一个绑定 workspace——**原样返回**，`~/orbit` 这样的写法由 runner 按自己的
  家目录展开（apiserver 不知道 runner 的家目录）。

### 17.2 runner 怎么验

- 先 `git fetch origin +refs/heads/main:refs/remotes/origin/main`，再对 `refs/remotes/origin/main` 此刻指向的提交逐个检查；fetch 失败就什么都不验、
  什么都不报。报告里带这个 40 位 sha（`ref`）。
- path：`git cat-file -e <ref>:<path>`（去掉开头的 `./`、`/` 和结尾的 `/`），在就是 verified，不在就是 missing。
- symbol：`git grep -n -w -F -I` 在该文件（路径是目录时取路径序的第一个文件）里找符号作为整词出现的第一行；从这一行起共 20 行
  （到文件尾为止）为区域，每行以换行结尾，取 sha256（小写十六进制）为 `regionSha256`。找不到就是 missing。
- commit：`git merge-base --is-ancestor <sha> <ref>`，是祖先才 verified；不是祖先、或仓库里根本没有这个 sha，一律 missing——非祖先的 sha
  会毒化依赖它的下游。
- git 验不了的锚点（git 本身报错）什么都不报，命令以非 0 退出；stale 不算失败。

### 17.3 服务端怎么记

- 每个条目一个事务（同核实结论）。条目已不 active、已不是报告里的 revision、或某个下标上已不是报告的那种锚点，就回 `stale`，
  什么都不写，下次运行重读。畸形的条目 `WIKI_SCHEMA` 并指出字段；别的 space 的条目 404。全部被拒才按第一个拒绝的状态码回。
- **基线**：symbol 锚点对自己的 `regionSha256`；没写的，对第一次检查找到的区域（存为检查里的 `baselineSha256`）。找到的 symbol 由服务端
  对基线判 verified / changed，runner 的判断不作数；changed / missing 的检查不会移动基线，只有 owner 的 Re-confirm 会。
- 每个锚点最近一次检查存在 `wiki_entry.anchors[i].check`：`{ state, ref, at }`，找到的 symbol 另有 `regionSha256`（这次找到的）和
  `baselineSha256`（检查采纳的基线）。**修订里存的是写下时的锚点，不带检查**；amend 冲突回答里给的当前锚点也不带。
- `anchor_state` 由各锚点的最近检查汇总：有 missing 就是 missing，否则有 changed 就是 changed，否则有未检查的（或根本没有锚点）就是
  unchecked，否则 verified；`anchor_checked_ref` / `anchor_checked_at` 是最近一次检查的 ref 和时间。只由 `applyOp` 写：一次检查，
  以及重新给出锚点的 amend（新锚点是 unchecked，Re-confirm 带着保留的检查除外）。

### 17.4 失效：退出推送与系统 challenge

- 检查让 active 条目成为 changed 或 missing，它当场退出推送（`push.eligible.anchorStateNot`）；若没有未决的 challenge，同一事务里经唯一写入口
  记一条**系统 challenge**：origin 为 maintenance、不挂会话（不占任何会话的配额），challenge 的 reason 写明哪些锚点不再成立、在哪个 ref 上验的。
  条目有任何未决 challenge 时不再重复记。
- owner 在 Review 里经 JWT 门的 decide 回答（带会话头一律 `WIKI_OWNER_CHANNEL_ONLY`），三个新动作只用于 challenge op，用在别的 op 上 `WIKI_SCHEMA`：
  - `reconfirm`：条目按最近一次检查时的 ref 保持原样——区域变了的 symbol 以检查找到的区域为新基线（写进锚点自己的 `regionSha256`），
    检查为 missing 的锚点删掉；有改动就作为 owner 的新修订写入（沿用条目当前修订的出处）。只动锚点，所以不许改写的 decision 也照此
    Re-confirm。trust 为 auto / unreviewed 的变 confirmed。
    challenge 记为 accepted。
  - `amend`：`edited` 形如 amend 的 changes（至少一个键），作为 owner 的修订叠在条目上，出处沿用、trust 同上；changes 没给的锚点照 Re-confirm
    重置基线，给了的锚点是新的、未检查。decision 这种只能取代、不能改写的 kind 回 `WIKI_SCHEMA`。challenge 记为 edited。
  - `retire`：owner 自己的 retire（当前修订为 baseRevision），经唯一写入口记录，reason 取 owner 的附言，没有就取 challenge 的 reason；
    challenge 随条目离开 active 被 withdrawn。
  - challenge 指向的条目已不 active 时记 conflict、什么都不做。`accept` / `edit` / `reject` 对 challenge 保持原意。
- **Tiered 读得到复验结果**：Tiered 的 pitfall 条件读 `anchor_state`；检查让一条 Tiered 以 unreviewed 生效的 pitfall（active、未污染、当前修订就是那次
  tiered op 写的）变成 verified，且 space 仍是 Tiered、那次 op 自己的出处跨 2 个以上独立会话时，同一事务里升为 auto 并开始推送。

### 17.5 CLI

- `orbit wiki anchors verify --space <id> [--repo <path>] [--json]`，只有 CLI、没有 MCP 工具，三张 family 表都登记。
- 前置条件（逐词测试）：「Re-verify anchors only as a Wiki maintenance run of the space, in a checkout of its repository, and report only what git
  said: every state is read from origin/main just after a fetch, and an anchor git could not check is reported as nothing.」
- 分页读列表、每批最多 50 个条目回报；fetch 失败、git 验不了某个锚点、或服务端拒了某个条目时以非 0 退出。

---

## 18. 文档视图 · 生成：主题、文章与脚注（判据 9）

> 判据 9 于 2026-09-28 改写：给人读的主视图改为按 plan 逐节写的文档（§22）。本节的按主题文章保留、照常可读，直到客户端切到文档。

JSON 里是 `articles`；实现在 `src/apiserver/src/wiki/wiki-articles.ts`（归主题、指纹、校验、读写），user 门在
`wiki/wiki-articles.controller.ts`，runner 门在 `runner-api/runner-wiki-articles.controller.ts`，CLI 在
`src/runner-go/wiki_articles.go`。

### 18.1 主题与大类

- `wiki_topic` 的 `title` 就是显示名，新增 `category`：六类闭集（CHECK），顺序照演示：`platform` 平台核心、`runner` Runner 与引擎、
  `clients` 客户端与界面、`data` 数据与后端、`engineering` 工程流程、`collaboration` 协作。界面上用英文名（`categories[].title`）。
- space 还没有任何主题时，第一次向服务端要计划（`POST …/article-plan`）就写入 `articles.defaultTopics`：演示的 22 个主题，各带显示名、
  大类、描述和路径前缀。已有主题的 space 不动。演示里「`src/apiserver` 一律算会话」的兜底规则去掉了。
- `GET /api/wiki/spaces/:id/topics/:slug` 从此读得到这一行的显示名（§15 第 9 条说的「阶段 2 写下 wiki_topic 行之后」）。

### 18.2 条目归哪个主题（先路径，后文本）

- 参与的条目：该 space 的 active 条目，去掉 tainted 的；每条恰好归一个主题，或者哪个都不归。
- 三步，前一步定了就不看后一步：
  1. **路径**：条目点名的每个 repo 相对路径（path / symbol 锚点、pitfall 的 `trigger.paths`、convention 的 `scope` 截到第一个通配符）
     各投一票给「匹配最长」的那个主题；票多者得，平票看匹配更长，再平看主题顺序。路径先去掉 `./` 和 checkout 的绝对前缀
     （`/root/orbit/`、`…/.orbit/worktrees/<id>/`）。`path_prefixes` 里既有前缀也有后缀：前缀按字符数计，以 `/` 结尾的也匹配
     目录本身（锚点写成 `src/web` 等同 `src/web/`）；`*` 开头的是后缀（`*.swift` 匹配裸文件名 `ConsoleModel.swift`），按 `*` 之后的
     字符数计，所以目录前缀总是压过后缀。默认主题表照演示的路径规则写：runner-go 里除引擎、MCP / CLI、worktree 与 git、wiki
     之外都归 Runner，另补演示原有的后缀规则（`*.swift`、`*.sql`、`*_test.go`、`*.spec.ts` 等）。
  2. **自报**：否则取条目 `topics[]` 里第一个是本 space 主题的 slug。
  3. **文本**：否则按标题、摘要、别名的 tf-idf（英文词 + 中文二字组）余弦，找最近的主题；主题的向量是它自己的名称和描述，
     加上前两步归给它的条目。一个都不近就不归任何主题。
- 为什么：演示按字面相似分组，「会话」下出现了「数据库写入与迁移治理」「Nest 运行陷阱与联调」；条目锚在哪段代码上是更可靠的证据。
  用演示的 11,689 条回放：演示「会话」下那篇「数据库写入与迁移治理」的 79 条里 48 条改归「数据库」、一条不留在「会话」；
  全部条目里 87% 与演示同主题，其余大多是演示那条兜底规则的错归。
- 归类要读整个 space 的条目，所以计划、输入、写入都要它：服务端按「主题定义 + 每条条目的 id:修订号」为签名缓存上一次的结果，
  一次运行只算一次（11,689 条约 1 秒）。条目的文字和路径只随新修订改变，所以签名不变结果就不变。

### 18.3 文章、指纹与重写

- `wiki_topic_summary` 一行一篇：`part = 0` 是主题自己的文章（`article`），或拆分主题的总览（`overview`）；`part ≥ 1` 是子主题文章
  （`subtopic`），经 `parent_id` 挂在总览上。存标题、正文（`body`：`[{ heading, sentences: [{ text, notes }] }]`）、脚注
  （`citations`：`[{ n, entryId, revision }]`）、写作所依据的条目（`entry_ids`）、条目集合指纹、生成时的 ref、模型和校验统计。
- **指纹**：主题条目的 `<id>:<当前修订号>` 按 id 排序、换行拼接后的 sha256。条目加入、离开或被 amend 都会改变它。
- **不变不重写**：写入带上生成时依据的指纹；它等于已存 part 0 的指纹就什么都不写（`unchanged`）；它既不是已存的、也不是主题
  当前的，就回 `WIKI_ARTICLE_STALE`（409），什么都不写——条目在写作期间变了，下一次运行按新条目重写。所以已存的文章永远
  准确说明它是依据哪些条目写的。
- **谁来重写，不用时钟**：看执行器把账号交给谁（`jobs.executor`）。runner 模式（默认）下，维护运行自判据 3 第 3 版起不再重写主题文章，
  也没有别的东西自动重写；维护会话里手动跑 `orbit wiki articles` 才写。服务端执行的账号（owner 2026-10-08 定）：该空间的一次维护运行
  成功结束、记下了 op、且不是在落后时建的（追赶进行中或暂停时都不算，与文档那一步同一条规则），服务端就给它排一个文章作业（§18.8），
  不管这次运行是 runner 跑的还是服务端跑的；作业只重写指纹变了的主题。
- 一个主题的各行在一个事务里整体替换（先 `FOR NO KEY UPDATE` 锁主题行，再核一次指纹）。

### 18.4 代码校验

- 每篇的输入是带 `[n]` 标记的 Markdown 和 `notes`（`[n]` 指 `notes[n-1]` 这条条目）；子主题还要给出自己这一组的条目。
- 断句：`。！？`，以及后面跟空白或行尾的句点、英文 `?` / `!`；但英文 `?` / `!` 前面是空白或另一个 `?` / `!` 时不断（那是模型没加
  反引号的代码，如 `a ?? b`、`a != b`，试跑里切开过一句）；反引号里的代码不断句，其中的 `[0]` 之类也不算脚注。第一个一级标题是
  整篇的标题，不进正文；其余标题各起一段。
- 子主题起名按组依次进行，每次把本主题已用的名字告诉模型、要求不重复（并行起名时同一主题的组名常是近义词）。
- 标记只在「n 在 1 到 notes 个数之间，且 notes[n-1] 是本主题（含其子主题）的条目」时保留；越界、指向别的主题、指向不存在的条目，
  一律剥掉。剥完没有标记的句子删掉。
- 字数按保留下来的句子的字符数（码点）计，不含标记和标题：写作端目标 400–900（提示里要 450–800、8–11 句，短于 400 且素材够时
  重写一次）；服务端超过 900 就从「句子最多的那段」末尾一句一句删，直到不超过。演示平均 1,052 字。
- 脚注按首次出现顺序重排为 1、2、……；子主题剥完一句不剩的整篇丢掉；part 0 一句不剩就整次不写。

### 18.5 视图，不是知识

- 不进 `<orbit_wiki_context>`：推送只读 `wiki_entry`。
- 不能当出处：没有任何出处种类指向 `wiki_topic_summary`，引用文章一律 `WIKI_SOURCE_UNRESOLVED`（§5「不允许引用 wiki 条目或视图」）。
- agent 的 `wiki_search` / `wiki_get` 只返回条目；文章 id 不是任何条目的 id。

### 18.6 谁能读写

- **写**：只有该 space 的维护会话（`isWikiMaintenanceSession`）经 runner 门、服务端自己的文章作业（principal 为
  `origin: 'maintenance'`、无会话、无用户，修订署名 `system`，§18.8），以及 API 服务器容器里的一次性导入（principal 为
  `origin: 'import'`、无会话、无用户，给预览 space 用）。其余一律 `WIKI_NOT_MAINTENANCE_SESSION`；headless 400；别的 owner 的 space 404。
  user 门没有写文章的路由。
- 执行器把账号交给服务端时，该 space 的维护会话调 runner 门的计划、输入、写入三条路由都回 `WIKI_SERVER_EXECUTES`（409）：文章由
  wiki-worker 写，不交出材料、也不收写入，所以无论 runner 是哪个版本，都不会拿会话的 provider 调模型。
- runner 门三条（都在 `maintenanceRoutes`）：`POST /api/runner/wiki/spaces/:id/article-plan`（计划；空 space 先写默认主题）、
  `GET …/articles/:slug/input`（主题的条目，按出处数、时间排好，带归组用的路径和指纹）、`POST …/articles/:slug`（写入）。
- **读**：owner 经 user 门：`GET /api/wiki/spaces/:id/articles`（大类 → 主题 → 文章与子主题）、`GET …/articles/:slug`、
  `GET …/articles/:slug/:part`（脚注解析成条目的标题、摘要、种类、状态、trust）、`GET …/article-index`（全部文章按标题 A–Z）。
  跨租户一律 404。
- **文章依据的条目**：文章读带 `entryIds`，就是生成时存进 `wiki_topic_summary.entry_ids` 的条目池（总览是整个主题，子主题是它那一组），
  另带 `entries`：这些条目按现在的样子，被引用的排在前面，最多 `reads.entriesListed`（200）条——总览能有几百条，读里给全部 id、只带前 200 条。
  文章下面的条目列表就用它画，文案是「the N this article is written from, by kind」，N 是 `entryIds` 的条数。

### 18.7 `orbit wiki articles`

- `orbit wiki articles --space <id> [--topic <slug>] [--model MODEL] [--json]`，只有 CLI、没有 MCP 工具，三张 family 表都登记。
- 计划 → 只取条目集合变了的主题 → 读条目 → 超过 45 条的主题在 runner 上用代码分组（锚点路径前缀权重最高，其次是标题/摘要的词；
  演示的 tf-idf 球面 k-means，每组约 40 条、最多 40 组、少于 8 条的并进最近的组）→ 干净的 Claude Code 调本地模型给每组起名、写每篇 →
  提交。模型只读条目，不读会话原文；每篇最多用组里出处最多的 30 条。
- 干净调用照抄 `orbit wiki verify` 的启动参数、环境白名单和 apiKeyHelper，只换系统提示；thinking 默认关：`CLAUDE_CODE_EFFORT_LEVEL=unset`
  且 `MAX_THINKING_TOKENS=0`（只设前者仍会发 adaptive thinking）。碰到第一个 401 就停；有主题没写成就以非 0 退出。
- 服务端执行的账号：服务端回 `WIKI_SERVER_EXECUTES`，命令打印「The Orbit server writes the articles of space …」，不调模型、不写任何东西，
  以 0 退出；运行中途开关切过去（读输入或写入时才回这个码）也一样就此停下。这部分随下一次 runner 发版上线；旧版 runner 在这里报错退出，
  同样不调模型。

### 18.8 服务端执行（服务端执行 P4，2026-10-08）

JSON 里是 `articles.serverExecution`、`articles.job` 与 `jobs.kindRuns.articles`；实现在 `src/apiserver/src/wiki-worker/`
（作业 `wiki-articles-job.ts`、移植过来的写作与分组 `wiki-articles-writer.ts`）和 `src/apiserver/src/wiki/wiki-articles-jobs.ts`（排作业）。

- **对谁**：执行器开关把账号交给服务端的（`server`，或 `canary` 名单内）。runner 模式下这一节都不发生。
- **什么时候排**：服务端记下一次维护运行结束的地方（runner 路径是 finish 路由，`finishWikiMaintenanceRun`）判断：运行成功、记下了 op
  （有这次会话的 `maintenance` 来源 changeset）、不是在落后时建的——满足就给空间排一个 `articles` 作业，优先级 0（后台，排在 owner 主动发起
  的请求之后）。每个空间最多排一个：排队中的作业运行时才读计划，挂起等快照的作业重放时会重读，所以都能覆盖之后结束的运行；已经在跑的
  作业可能读过计划了，下一次运行结束就在它后面再排一个。排作业失败只记日志，不影响运行本身的结束。P8 的服务端维护作业结束时调同一个入口。
- **作业做什么**：
  1. 以作业的身份（`origin: 'maintenance'`、无会话、无用户）读计划；空间没有主题时照常先写默认主题；只取指纹变了的主题，一个都没有就直接成功、
     不调模型。
  2. **ref**：取空间最近一份仓库快照（§26.4）的 sha，写进每篇文章的 `ref`。没有快照就向空间的 runner 请求一次 `snapshot`，作业挂起等它
     （`waiting_for = 'repo'`，最多 `articles.job.snapshotWaitSeconds` = 900 秒），快照落地后作业回到队列、从头重放。请求过却没拿到（操作失败，
     或没在时限内完成），或者空间没有可读的 checkout，就不带 ref 写，报告里写明原因——文章是从条目写的，不读仓库原文。
  3. 每个主题：读输入；超过 45 条的主题用和 runner 逐步相同的分组（tf-idf 球面 k-means，锚点路径优先），算的时候分片让出事件循环
     （设计 §4.5）；按组依次起名、每次告诉模型已用的名字；子主题文章和总览（或小主题的一篇文章）每次 4 个并行；保留字数不到 400 的稿子、
     素材够 8 条时再要一次（字数用服务端自己的校验来数）。
  4. 经 `WikiArticles.write` 写回，和 runner 门是同一个写入口：脚注只在指向本主题条目时保留，没有脚注的句子删掉，超长的从最长一段末尾删；
     `model` 是 System model 的名字。
- **提示词**：与 runner 逐字相同（系统提示、文章/子主题/总览提示、条目行、起名提示、再要一次的后缀）。两条路径由
  `src/shared/src/wiki-article-writer.fixture.json` 钉成同一个答案：同一个主题的每一次调用逐字相同、大主题的分组逐条相同，
  `wiki_articles_test.go` 和 `wiki-articles-job.spec.ts` 都读它。
- **调用即断点**：每次调用是队列里的一条请求，step `articles`，unit 是 `<slug>@<指纹前 12 位>/name-<n>`、`/part-<n>` 或 `/part-<n>/again`；
  作业被重放时答过的调用直接复用，主题条目在两次尝试之间变了就重新问。5xx、429、断连由队列退避重试；401 让整个队列停下（§25.6）。
  `max_tokens`：文章、总览、子主题 4096，起名 512（`articles.job`）。
- **怎么结束**：拿起的主题全部写成或无变化就成功，报告就是 runner 的 summary（seeded、ref 与 refWhy、各主题的结果、written / unchanged /
  failed、调用数、token、校验统计）。有主题没写成（调用以作业自己的原因结束，或写入被拒，包括 `WIKI_ARTICLE_STALE`）：其余主题照常写完，
  然后作业以 content 失败结束，报告留在作业行上——和命令以非 0 退出一样，下一个作业按当时的条目重写。平台的失败（请求等待超限、数据库、
  worker 停机）按 infra 处理，重放时从计划重新开始。
- **runner 门**：见 §18.6 与 §18.7。

## 19. 维护作业：由事实建任务、`orbit wiki maintain` 与 `orbit wiki check`（判据 3）

JSON 里是 `maintenance.job`；迁移 `0320_wiki_maintenance_run`；服务端在 `src/apiserver/src/wiki/wiki-maintenance-run.ts`
（触发、运行的起止与判据）、`wiki-maintenance-breaker.ts`（整次运行的熔断），runner 门在
`runner-api/runner-wiki-maintain.controller.ts`；runner-go 在 `wiki_maintain.go`。

服务端执行的账号（`ORBIT_WIKI_EXECUTOR`）由 wiki-worker 跑同一条流水线：触发建 `maintain` 作业而不是任务，章节见 §27；
本节讲的是 runner 模式（默认）下的任务、命令与检查。

### 19.1 触发：事实驱动，不用时钟

- `WikiMaintenanceTrigger` 把本副本发布的每个事件当作提示：会话的 STATUS / SESSION_ENDED / SESSION_UPDATED / APPROVAL_RESOLVED，
  以及 `task.changed` 点名的任务。只有提示点名的是**这个 space 的、仍在游标之后的已提交事实**（会话结算、它回答的审批、它的 merge
  receipt、space 的任务终态），才去问这个 space 是否到期；改名、维护作业自己的事件、别的 space 的工作都不算新事实，
  space 再到期也不建任务。merge receipt 与判据修订自己不发事件：它们照样计入 backlog，由下一个到达的事实一起带进来。
- 到期：水位之后有事实的会话 ≥ `rules.backlogThreshold`（20），或新事实到达时最老的未处理事实已超过 `maxPendingAgeHours`（24）。
  年龄只在事实到达时读，从不等：夜里悄悄满一天的 space，早上第一个事实到达时才建任务。
- 不建：维护关了或缺 workspace / 清单；清单里有未结束（OPEN / IN_PROGRESS）、且不是「死任务」（19.7）的任务——死任务先被重跑或关单，
  只有等着重跑的那个仍占着清单；这个 space 有排队（`queued`）的 plan 作业
  （21.7「plan 作业先走」：触发改为把作业的任务建出来）；提示不是新事实；没到期；过了 120 秒宽限的事实里没有可覆盖的；被挡住（19.2）。
- 建任务在维护清单那一行的锁下进行，锁内再读一遍未结束的任务、排队的 plan 作业和当天次数：两个事实同时到达只建一个，其间排上的作业照样先走。
- **追赶时**（19.8）：space 落后超过 24 小时、追赶没有暂停时，上一次维护运行的结束本身就是一个新事实——提示点名的是 space 最新那次运行的任务、
  或它的一个会话，且该任务已结束——没有别的新事实也照常往下问（到期、当天次数、审阅队列）。不在追赶、或追赶暂停时，维护作业自己的事件
  仍不算新事实。

### 19.2 被挡住：健康状态里的 `held`

- `daily_limit_reached`：这个 space 自 UTC 零点起建出的维护任务已达 `settings.maintenance.dailyRunLimit`（`wikiMaintenanceRunsToday`，不论结局；
  但追赶中不计数的运行除外，见 19.8），且下一次运行会计数——追赶中钉在本地端点上的运行不计数，所以不会被挡。
- `review_queue_full`：Manual 模式下每条提议都等 owner，审阅队列连一个会话的提议都放不下。
- 记在 `wiki_cursor.held_reason` / `held_at`，游标状态里是 `held: { reason, at }` 或 null；同一原因保留第一次被挡的时刻，建出任务时清空。

### 19.3 任务的样子

- 在 space 隐藏的「Wiki maintenance」清单里；标题 `Wiki maintenance: <space 标题>`；指派给维护设置的 workspace，provider 钉死为
  维护设置的 provider（认领时按 §16.5 干净启动）；`runAt` 为建出的时刻；创建者为 owner（USER）。
- 描述就是运行的指令：用 Bash 跑一次 `orbit wiki maintain --space <id>`，Bash 调用给 `timeout: 18000000`（5 小时），不许更短（16.5）；
  跑完用 task_progress_report 与一条 task_comment 汇报，含 token 花费；失败时贴最后几行；不跑别的，失败最多重试一次。
  服务端答 5xx 或不答时命令自己先等服务恢复（19.7），所以它说可以再跑的那次可以立刻重跑；它说服务端没回来时不要再跑——
  下一次运行会读同一批案卷。工具在命令结束前就返回（超时或被截断）时不要再跑，也不占那一次重试：汇报截断前打印的内容就结束，
  下一次运行接着做。
- 判据 EXECUTABLE：`orbit wiki check --space <id> --expect-cursor <token>`，期望退出码 0，时限 `rules.checkTimeoutSeconds`（300 秒）。
- **期望位置**：从游标起、只看过了宽限的事实，按案卷页的同一走法数够 `runSize` 个会话时页会停在的位置。运行从同一游标翻页
  （案卷路由的 `until`）正好走到这里。
- **一次运行的大小**（`wikiMaintenanceRunSessions`），按每个会话最多 `entriesPerSessionMax`（6）条算，让它提议的东西放得进护栏：
  Manual 下取一个会话最多留给 owner 的数（`limits.opsPerSession`）与审阅队列的空位中较小者；Tiered / Automatic 下 space 有
  ≥100 个 active 条目时取它们的 10%（熔断线）；否则 `runSessionsMax`（20）。永不超过 20。

### 19.4 `orbit wiki maintain --space <id> [--model MODEL] [--concurrency N] [--json]`

只有维护会话能跑（其余 `WIKI_NOT_MAINTENANCE_SESSION`），一次跑完以下各步。**游标在 op 记下之后立刻推进**（判据 3 第 4 版，第 8 步）：
记下之前的任何一步失败或被截断都不推进游标；记下之后核实、锚点或文档失败，运行照样记 failed、连续失败加一，但游标留在推进到的位置，
下一次运行不再重读这些会话。熔断扣下 op 不算失败，游标停在被扣下的案卷之前；op 没拿到核实结论也不算失败（第 9 步）：

1. **起点**：`GET …/maintenance/run` 拿 space 与仓库、维护 workspace 的工作目录、主题表、护栏数字和期望位置，同时记下运行开始、是哪个会话。
2. **checkout**：维护 workspace 的工作目录（`~` 按 runner 账号的家目录展开——会话里 HOME 是干净目录），先 fetch；它的 origin 与 space
   的仓库（`repo_url_norm`、有记录时的根提交）不一致就判失败并说明原因。
3. **案卷**：从游标翻页到期望位置（`until`）；自上次处理后没变的案卷跳过。
4. **抽取**：每个案卷一次干净的 Claude Code 调本地模型——照演示的 A2+6：8k 案卷、不开 thinking、每例最多 6 条；提示里带 space 的仓库
   名、地址和一两句它是做什么的（取自仓库 README 的开头），要求讲的不是这个仓库的会话回答 `{"offTopic": true}`。每条照演示的
   `extract.py` 校验：种类与字段、出处必须是案卷里的行且引文逐字出自该行、锚点必须在 origin/main 上存在；没过的整批再问一次。
   代码锚点全都不在本仓库的条目丢弃（计 `entries.foreign`），离题的会话计 `offTopic`。principle 只有 owner 能写，抽到的丢弃并计数。
5. **自检**：按主题分批（每批最多 `limits.opsPerChangeset` 个 op；Manual 最多 `limits.opsPerTurn`），逐批 `dryRun`：服务端找不到的
   引文从出处上去掉再查一次，仍被拒的 op 丢掉（`selfCheckDropped`），被审阅配额挡住的不提议（`heldBack`），被熔断拒的留给第 6 步，
   和别的批一起算。
6. **熔断**：服务端对维护运行的 changeset 按整次运行计熔断（`wiki-maintenance-breaker.ts`）：本次运行先前各 changeset 经模式改动的
   条目都算已用——同一会话里前一次没跑完的 `orbit wiki maintain` 也算——active 数按运行开始时算（现在的 active 减去本次运行自己
   加出来且仍 active 的）。runner 不自己算：还能改动几个条目，以 dryRun 回答里的 `breaker.remaining` 为准（旧服务端的 dryRun 不带它时，
   退回按起点的 active 取 10%）。按读到的顺序逐页收下，直到某一页的 op（模式会直接生效或等核实的，含 dryRun 里被熔断拒的）放不下；
   从这一页起的 op 全部扣下不提议（`heldBackByBreaker`），一个会话出现在几页时按最后一页算；游标只推进到这一页的 `from`，下一次运行
   重读这些案卷，扣下的知识不丢，已提议的也不会被重读。这一步不写任何东西，也不让运行失败。
7. **提议**：`POST …/maintenance/changesets`，origin 为 `maintenance`；此时还有 op 被拒就判失败。
8. **推进游标**（判据 3 第 4 版）：所有批次都记下后，立刻 `POST …/maintenance/advance`，带最后一页的 token（熔断扣下过 op 时，是第一个被扣下的页的
   `from`）：游标越过这些 op 所属的会话。只用游标的比较并交换往前移，不写运行的健康字段（`last_ok_at`、连续失败、`last_outcome`）；token
   在游标处或之后已被越过的，什么都不动。从这里往后的步骤失败，运行照样以 failed 收尾，游标不回退；报告带 `cursorAdvanced: true`。
   服务端没有这条路由（旧版本）时，游标照旧在收尾时推进。
9. **核实**：Automatic 下走 `orbit wiki verify` 对本次运行自己的 op 的核实，没拿到结论的再核一遍：第二遍的提示里写明上一遍的回答
   为什么没被收下（例如 duplicateOf 不是列出的条目），并列出 duplicateOf 能填的编号（一条都没列时，说明它不可能是 duplicate）；回答照样
   严格解析，不宽读成别的结论。然后接手已结束的会话留下的等核实的 op（§7.4），每次最多 `adoptOpsMax`（50）个，本次运行没抽取过就先为
   它们备好模型。**没拿到结论的 op 不让运行失败**，本次运行自己的（两遍之后）和接手的一样：没结论就不生效，照旧等核实；运行照常往下走、
   以 succeeded 收尾、推进游标，连续失败数不加；本次运行的会话结束后，由下一次运行接手（报告的 `verification.waitingForNextRun`）。
   起因：2026-09-30 与 10-01 的运行因 89 个 op 里 1 个、79 个里 4 个没结论而整次失败，游标不动，下一次重读同一批案卷、按同样的比例
   再失败。真正的停止照旧让运行失败：模型端点 401、服务端出错。space 已不是 Automatic 时核实停下，没核的 op 等它再切回 Automatic，
   这同样不让运行失败。
10. **锚点**：`orbit wiki anchors verify`，`--repo` 取上面的 checkout。
11. **文档**（判据 3 第 3 版，19.6）：有已确认的 plan 时，只重写本次运行的事实碰到的节——条目碰到的、仓库材料在 origin/main 上变了的、
    被撤过句的，以及没有生成作业在等时还从没写过的——落不进任何一节的新知识至多产出一条 plan 修改建议；没有已确认的 plan 就不写文档，
    报告里注明（`docs.skipped: no_confirmed_plan`）。space 落后时建出的运行（追赶中或追赶暂停，19.8）整步跳过：不写任何一节，也不产出
    修改建议（`docs.skipped: catching_up`）。按主题的文章不再重写。这一步不让运行失败：没写成的，下一次运行照样会重写。
12. **收尾**：`POST …/maintenance/finish`，带推进到的那个 token（最后一页的，或熔断扣下过 op 时第一个被扣下的页的 `from`）、outcome 与运行报告；
    成功时游标已在那里，不再移动，只记下成功（`last_ok_at`、连续失败清零）。失败时 outcome 为 failed、带原因、连续失败加一；游标在第 8 步
    之前失败的不动，之后失败的留在第 8 步推进到的位置。
    被 maxTurns 截断时由 runner 在游标路由上报 truncated（§16.5），同样记到运行上；游标不会超过已记下的 op。

运行报告（`WikiMaintenanceReport`）：会话、案卷、跳过、离题数，条目（抽到 / 保留 / 丢弃 / 锚点在库外 / principle），
op（提议 / 记下 / 被拒 / 自检丢弃 / 被配额挡住 / 被熔断扣下 / 直接生效 / 等待），核实（本次运行自己的 op；接手的单列为
`verification.adopted {ops, verified, failed}`，CLI 输出里是一行 `- adopted: …`；没拿到结论、等下一次运行接手的 op——本次运行
自己的与接手的合计——单列为 `verification.waitingForNextRun`，CLI 输出里是一行 `- waiting for the next run: …`）、锚点、文档（`docs`，19.6）各自的结果，**token（输入、输出、
调用次数，含抽取、核实、文档的节与 plan 修改建议）**与耗时，失败时 `stoppedAt`，游标在 op 记下后推进过时 `cursorAdvanced: true`。最多 16,000 字节 JSON，存在运行那一行上，`ops.refused` 单独
成列。判据 3 第 3 版之前的运行报的是 `articles`，不是 `docs`。

### 19.5 `orbit wiki check --space <id> --expect-cursor <token> [--json]`

- `GET /api/runner/wiki/spaces/:id/maintenance/check?expect=<token>`：只读。任务的验收命令在会话回合之后、在没有会话上下文的 shell
  里跑，所以它接受 owner 的 runner 不带会话的调用；带了会话头的，须是该 space 的维护会话。
- 通过的条件：游标已在期望位置或之后，**并且**期望这个位置的最新一次运行以 succeeded 收尾、`ops.refused` 为 0。判据原文的两条
  ——游标没推进、有 op 校验不过就非 0 退出——是它失败的其中两个原因，不是全部。
- 否则退出码 1，每条原因一句：游标没到；没有任务期望这个位置；运行没说怎么结束的或没成功；运行没报它的 op；服务端拒了 op。
- **游标已推进、后续步骤失败**（判据 3 第 4 版）：`reached` 为 true，运行 outcome 为 failed——退出码 1，原因写明游标已越过 op 记下的会话、
  下一次运行不再重读它们，以及运行停在哪一步、为什么。任务因此 FAILED；运行行记 outcome failed、failureKind、error 和报告（`stoppedAt`、
  `cursorAdvanced`）；space 的连续失败加一。

### 19.6 文档跟着变化走：只重写受影响的节，落不进的产出修改建议（判据 3 第 3 版）

JSON 里是 `maintenance.job.docs`；runner 在 `src/runner-go/wiki_maintain_docs.go`，服务端的一半在 `src/apiserver/src/wiki/wiki-docs-affected.ts`。
owner 09-29：agent 往 `docs/` 里写的设计文档，wiki 要主动跟上。

- **受影响的节（条目）**：`GET …/maintenance/docs`（22.12）列出已确认 plan 里已写过的节中，有条目**在该节生成之后**被应用了 op、且条目符合该节
  的来源条件（`docs.affected.fit`：关键词、锚点路径、项目、条目 kind、主题）的节，以及被撤过句（`stale`）的节。按「生成之后」而不按
  「本次运行」算，所以失败过的运行、owner 后来才接受的 op 都不会丢。
- **受影响的节（仓库材料）**：每个节记着生成时的 `repoSha`。runner 把节按 sha 分组，每个 sha 一次 `git diff --name-status -M <sha> origin/main`
  （只看名字，不读内容），与节引用的文件（设计文档、代码、契约；目录则是其下的文件）对照；动过的，再在两个提交上各取一遍该节从这些文件
  取的材料（章节、符号、文件头与匹配的声明、契约）比较，文字不同才算受影响——只比文件和章节，不重读全仓库。checkout 里没有那个 sha 的，
  其节算受影响。
- **引用的文件没了**：节引用的文件在 origin/main 上被删、或改名走了，runner 把这些路径交给 `POST …/maintenance/docs/withdrawals`
  （22.12）：经它引用的句子按「锚点失效」撤下（`anchor_missing`，记下路径），所在的节标 `stale`，重写时就只取 origin/main 现有的材料。
- **从没写过的节**：space 没有等着或正在跑的生成作业（`build`）时，已确认 plan 里还没写过的节也一并写——生成作业中途失败留下的空缺由此补上。
- **重写**：这些节交给 `orbit wiki docs build` 的写法（22.11），在比较时那一个 origin/main 提交上写；材料指纹没变的节照样跳过、不调模型；
  重写的节带上新的 `repoSha`，仓库脚注带新的 sha。一篇里有节被重写，它的概述节也一并交给写法（指纹决定写不写）。
- **落不进任何一节的新知识**：GET 答的 `unplaced`（生成 plan 之后变过、符合不了任何一节、也没有被任何修改建议点名过的条目），加上 origin/main 自
  plan 核对引用那次提交（`plan.repoSha`）以来在 `docs/` 下新增或改名进来的 Markdown 设计文档（不含 `docs/mocks`、`docs/evidence`），且没被
  任何一节、任何一条修改建议引用。每次运行至多产出**一条** plan 修改建议：本地模型拿到 plan 的目录、这些新知识（设计文档附标题、章节与开头，
  至多 `rules.proposalItemsMax` = 12 条，设计文档在前），挑出讲同一件事的一组（不相干的不凑在一起，也不建「杂项」篇），用 plan 的行格式回答放进哪一篇（给它加节）或新增哪一篇；runner 先在 origin/main 上
  核对它引用的文件、章节、符号、契约，再交服务端的检查闸（`POST …/plan/proposals`）；哪道闸查出问题就带着逐条问题让模型重写，最多
  `rules.proposalRoundsMax` = 3 轮。事实是它放进去的条目（`entry`）和加入设计文档的提交（`commit`，完整 sha）。owner 确认之前 plan 不变；
  没放进这条建议的新知识留给下一次运行。修改建议没过闸不让运行失败，报告里写明原因。
- **报告**：`docs { planVersion, skipped?, repoSha, affected { byEntries, byRepo, stale, unwritten, total }, withdrawn { paths, sentences },
  sections { written, unchanged, failed }, unplaced { designDocs, entries }, proposal: { outcome, id, doc, newDoc, facts, rounds, reason, error } | null,
  tokens { input, output, calls }, seconds, error? }`（`WikiMaintenanceDocsReport`）：这一步自己的模型调用与耗时另算一份，也计在运行的 token 里。`skipped` 为 `no_confirmed_plan`（没有已确认的 plan，什么都不写）、`no_server_support`（服务端还没有 22.12
  的路由）或 `catching_up`（space 落后时建出的运行，文档留给追平后的第一次运行，19.8）。

### 19.7 死在基础设施上的任务不再挡住维护（`maintenance.job.recovery`，迁移 `0356_wiki_maintenance_run_attempts`）

起因（10-01 至 10-02 线上）：维护任务的会话在 runner 重启时被 reaper 判 `runner offline`，任务停在 OPEN、没有活会话；
触发器把任何 OPEN 任务都当作「运行中」，四个多小时没建新维护。调度器为什么没重派：reaper 对开了 autoRunWhenReady 的任务
不挂会话重试，让给调度器；而调度器的三条自动扫描各要一样维护任务没有的东西——依赖边（`AUTO_RUN_READY_SQL`）、所属项目
（`PROJECT_INDEPENDENT_READY_SQL`）、未到期的 `runAt`（`SCHEDULED_DUE_SQL`，首次派发已把它消费成 NULL）；`rearmEndedAutoRuns`
只认 `dep:` 回执，维护任务唯一的回执是 `sched:<task>:0`。于是谁也不会再启动它。

- **失败类别**（`failureKinds`）：`infra`——平台的失败：会话被判 `runner offline`、引擎没起来（`<provider> runtime not initialized`、
  一轮都没跑成）、服务端 5xx 或连不上、磁盘满（`No space left on device`）、provider 过载；`content`——其余：读到的内容、模型的回答、
  被服务端拒的 op、轮数上限、有人停掉的会话。运行自己上报失败时（`failureKind`）以它为准；没说的（比这个字段旧的 runner）按 error 的字样判：5xx、连接断开、
  磁盘满这类算 `infra`，其余算 `content`。
- **死任务**（`deadTask`）：清单里 OPEN / IN_PROGRESS 的任务，跑过会话、最新会话已结束、没有 PENDING / RUNNING / AWAITING_INPUT /
  INTERRUPTED 的会话、没有挂着的会话自身重试、也没有等着的 `runAt`。它不再算「未完成」。
- **谁来处理**：维护触发器，在死后的第一个提示上——死掉的会话自己的终态事件就是一个提示——在清单行的锁下，先于触发器的其他判断。
  不用时钟。清单里的 plan 作业任务同样处理。
- **重跑一次**（`rerun`）：`infra` 的死、且重跑次数未达 `rules.rerunsMax`（1）：给同一任务设 `runAt` = max(现在, 会话结束 +
  `rules.rerunAfterMinutes`（10 分钟）)，由调度器的定时扫描到点再启动——新会话、钉死的 workspace 与 provider，只有它的 runner
  在线时才会认领。运行行记 `reruns`、`rerunAt`，并在重跑开始前写明这次死（outcome failed、failureKind infra、原因）。等重跑期间它占着清单。
- **关单**（`close`）：`content` 的死，或重跑后又死：任务记 FAILED；运行行没说过怎么结束的，补 outcome failed、failureKind 和原因。清单空出来，
  下一个事实照常建下一次运行（游标没动，space 仍到期）。
- **孤儿运行行**（`orphan`）：任务已终态（DONE / FAILED / CANCELLED）而运行行没有 outcome 的，补 outcome failed、failureKind infra、
  error `The run did not report its end.`，ended_at 不早于最后一次开始。现存的由迁移 0356 一次补齐，之后由触发器在每个提示上补本 space 的。
- **多次尝试**（`attempts`）：运行行保留首次开始（`startedAt`，不再改写），另记最后一次开始（`lastStartedAt`）与次数（`attempts`）；
  会话内重试和平台重跑都算一次。每次开始清掉上一次尝试说的结局（outcome、endedAt、error、failureKind、opsRefused、report），
  所以运行行说的是最近一次尝试的结局，`endedAt` 不会早于 `startedAt`。迁移 0356 把已经「先结束后开始」的行改成两次尝试，
  首次开始取该任务最早的会话。
- **会话内**（`inSession`）：`orbit wiki maintain` 遇到服务端答 5xx 或不答时先等服务恢复，最多 `rules.serverWaitMinutes`（15 分钟），
  用一个只读、会读数据库的请求探活（`/api/health` 不碰数据库，磁盘满时照样答 200）：开始之前等，因为某一步停在服务端上而失败时，
  也等到服务恢复再上报（失败报告只发一次）。停在服务端或模型端点上的失败上报 `failureKind: infra`，输出里说可以再跑一次；
  等不到服务恢复就不上报，输出里说这是基础设施失败、本会话不要再跑，运行行由孤儿规则补结局。被 Bash 工具截断的调用不在此列：
  命令没跑完，也就没说过可以再跑，一次也不再跑（16.5）。
- **健康**：读接口带 `lastFailure`（20.1），客户端据此区分平台失败与运行失败。

### 19.8 追赶（`maintenance.job.catchUp`，判据 3 第 4 版，迁移 `0357_wiki_maintenance_catch_up`）

起因（10-02）：游标停在 09-19 00:41，落后约 13 天，积压 1,800–1,970 条，一直不降：每天最多 8 次、失败的也算，每次只处理 20 个会话，
plan 确认后每次运行都重写文档（10-01 10:40 那次 93 分钟里文档占 54 分钟）。owner 06:36Z 选了「开追赶模式」。

- **落后**：游标之后最老的未处理事实早于 `rules.behindHours`（24）小时前（`wikiMaintenanceBehind`）；游标越过所有那么老的事实后即不再落后。
  只在提示到达时按事实读，从不等，不用时钟启动任何东西（硬约束 5）。
- **暂停**：落后时，space 最近 `rules.pauseAfterFailures`（3）次已结束的运行全部失败（failed / truncated，按运行行自己的结局数——会话死掉、
  由 19.7 补了结局的也算），追赶暂停；下一次运行成功即恢复。暂停时每日上限照常起作用，运行结束也不再是触发事实。
- **状态**：触发器建运行时判定并记在运行行上（`catch_up`）：`active`——落后且未暂停；`paused`——落后且暂停；null——不落后，或不是
  触发器建的运行。运行的起点（`GET …/maintenance/run`）带 `catchUp`。
- **触发**：追赶进行中（active），上一次维护运行的结束本身就是触发事实：提示点名 space 最新那次运行的任务或它的会话，且任务已结束——
  验收回合判定任务之后该会话自己发出的事件就是这样的提示。其余条件照旧（清单空闲、没有排队的 plan 作业、到期、每日上限按下一条、审阅队列）。
- **每日上限**：追赶中建出的运行，钉住的 provider 是本地端点的，或运行失败的（failed / truncated），不计入
  `settings.maintenance.dailyRunLimit`；公网 provider 上没失败的照计。暂停时或不落后时建出的运行照旧计数，不论结局。追赶中钉在本地端点上的运行
  不受当天上限阻挡；钉在公网 provider 上的只在当天还有名额时建——它成功就要计数。健康读接口的 `dailyLimitReached` 与此一致。
- **本地端点**（`localEndpoint`）：space 维护设置钉住的 provider，是不出自厂商预设（`presetSlug` 为 null——预设就是该厂商的计费 API）
  的已配置 provider，且 `baseUrl` 的主机在本机或私有网络：`localhost` 或 `.localhost` 下的名字、回环地址（127.0.0.0/8、::1）、私有 IPv4
  （10.0.0.0/8、172.16.0.0/12、192.168.0.0/16）、IPv6 唯一本地地址（fc00::/7）、链路本地地址（169.254.0.0/16、fe80::/10）
  （`wikiMaintenanceEndpointIsLocal`、`wikiMaintenanceProviderIsLocal`）。其他主机名一律不算（名字不说明它解析到哪里，判错的代价只是计数），
  厂商预设、内置引擎、账号池、不存在的 slug 也不算。建运行时判定，记在运行行上（`local_endpoint`）。local-vllm（`http://127.0.0.1:8000`）是本地端点。
- **文档**：space 落后时建出的运行（active 或 paused）整步跳过文档：不写任何一节，也不产出 plan 修改建议（`docs.skipped: catching_up`）。
  不再落后后建出的第一次运行照 19.6 重写追赶期间受影响的节：`byEntries` 从每节自己的 `generatedAt` 算起、`byRepo` 从每节自己的 `repoSha`
  算起，所以推迟的一节都不丢；材料指纹没变的节照旧不重写。

## 20. 健康可见：Wiki 首页的状态行与连续失败的通知（判据 5）

JSON 里是 `maintenance.health`；服务端在 `src/apiserver/src/wiki/wiki-health.ts`（读）与 `wiki-maintenance.ts` 的
`advanceCursor`（通知），用户门在 `wiki/wiki-health.controller.ts`；共享类型与 look 的判定在 `src/shared/src/wikiHealth.ts`；
两端的文案在 web `lib/wikiHealth.ts` 与 OrbitKit `WikiHealthLogic.swift`，由 `src/shared/src/wiki-health.fixture.json` 锁住。
读的是 0315 的 `wiki_cursor` 与 0320 的 `wiki_maintenance_run`（0356 给运行行加了尝试次数与失败类别，见 19.7）。

### 20.1 读：`GET /api/wiki/spaces/:id/health`

- 只给 space 的 owner（JWT 门）；别的账号的 space 是普通的 404，wiki 没对该账号开放时是 `WIKI_DISABLED`。**只读**：连游标行也不建——
  从没跑过的 space 没有游标行，读作游标在最开头。
- `entries`：space 的 **全部** active 条目数，即状态行的「N entries」。条目列表有自己的上限（200），它的长度不是计数。
- `maintenance`：
  - `enabled`；`lastOkAt`（上次成功）、`lastRunAt`（上次有运行报告，不论结局）；`consecutiveFailures`（连续失败次数，成功即清零）；
  - `backlog`、`oldestPendingAt`、`lagSeconds`：游标之后的事实数（§16.2 的 backlog）、其中最老的一条及其年龄，**读时现算**——
    游标行上存的那份只是上一次运行写下的。只在维护开着时算：关着的 space 读作 0 / null / 0；
  - `dailyLimitReached`：今天（UTC）建出的维护任务已达 `dailyRunLimit`（追赶中不计数的运行除外，19.8），且下一次运行会计数——追赶中钉在本地端点上时为 false；`held`：§19.2 的 `{reason, at}` 或 null；
  - `running`：已开始、未结束、且它的任务仍是 OPEN / IN_PROGRESS 的那次运行 `{sessionId, startedAt}`，或 null；`startedAt`
    是它最近一次尝试的开始（会话内重试或平台重跑的开始，不是首次开始）；
  - `lastRun`：最后结束的那次运行 `{sessionId, outcome, endedAt}`，或 null——状态行的 View run 打开它的会话；
  - `lastFailure`：最近一次尝试失败（failed / truncated）的运行里最后结束的那个 `{kind, reason, at, sessionId}`，或 null；
    `kind` 是 `infra` 或 `content`（19.7），`reason` 是它的 error。客户端据此区分「平台挂了」与「运行本身失败」；本契约版本客户端尚未使用。
  - `running`、`lastRun`、`lastFailure` 自 P9 起各多一个 `jobId`：服务端作业跑的运行（§24.6 的 `job_id`）没有会话，View run 改为打开
    Activity 里这次运行的那一行（§24.8），不再去 `/sessions/…`；维护会话跑的运行 `jobId` 为 null，View run 照旧打开它的会话。
  - `look`：状态行画哪一种（20.2）。
- `executor`（P9）：执行器开关对这个 owner 怎么说，`{ mode, serverExecutes }`（§24.5 的「读」）。
- `systemModel`（P9）：`serverExecutes` 为真时是 §23.5 读到的 System model 状态（`{ state, model, since, checkedAt, workerSeenAt }`，
  不含地址和 key）；`runner` 下为 null，也不去读。状态行的服务端原因就从它和 `repo` 说出来。

### 20.2 四种样子（另加「正在跑」）

按 `looks` 的顺序，第一个成立的就是（`wikiMaintenanceLook`）：

| look | 条件 | 状态行（效果图 11 ②、12 ④） |
|---|---|---|
| `off` | 维护关着 | `Maintenance off · Set up`（Set up 进 Wiki 设置） |
| `failing`（红） | `consecutiveFailures > 0` | `● Maintenance failed 3 times · last success 2d ago · 57 to catch up · View run` |
| `running` | `running` 不为空 | `Maintaining now · started 4m ago · 24 to catch up` |
| `behind`（琥珀） | 最老的事实超过 `maintenance.rules.maxPendingAgeHours`（24） | `● Maintenance behind · 43 to catch up, oldest 26h · last run 1d ago · daily limit reached` |
| `ok` | 以上都不成立 | `Maintained 2h ago ✓ · 6 to catch up` |

- 效果图没画、这次补的写法：失败 1 次写 `Maintenance failed`（2 次起写 `… N times`）；从没成功过就不写 `last success`；运行没报出会话
  就不给 View run；开着但还没成功过一次写 `Maintenance on · N to catch up`；滞后原因除了 `daily limit reached`，Manual 下审阅队列满时写
  `review queue full`。
- 时间：`just now` / `4m ago` / `2h ago` / `1d ago` / `3w ago`；滞后量三天以内按小时（`26h`，对着 24 小时的线读），之后按天（`14d`）。
- web 各宽度与 iOS 同一句话：entries（全量、千分位）· 锚点 · 维护部分；web 桌面在 entries 后多一个审阅数（手机由琥珀横幅说）。

### 20.3 连续失败 3 次通知 owner 一次

- 运行报告失败（游标路由的 failed / truncated，或 finish 路由的 failed）时，计数是游标行上的**一条** `UPDATE … RETURNING`：
  加一并读回新值。并发上报时每个报告读回各自的数，只有读回恰好 `notify.afterFailures`（3）的那一次推送——同一轮第 4、5 次不再推。
- 推送走 `PushService.notifyWikiMaintenanceFailing`：标题 `Wiki maintenance failed 3 times`，正文是 space 标题、「成功之前 wiki 收不到新
  东西」和最后一次错误的第一行；kind `wiki-maintenance-failing`，thread `wiki-<space>`，不改角标。在语句之后、任何事务之外发，尽力而为：
  手机没响，失败照样记下。
- 成功的运行把计数清零（§16.4），下一轮连续失败到它自己的第 3 次再推一次。

## 21. Wiki plan：先有 plan，owner 确认后才写文档（判据 11）

JSON 里是 `plan`；迁移 `0325_wiki_plan`；服务端在 `src/apiserver/src/wiki/wiki-plan.ts`（检查闸、版本、修改建议、`requireConfirmedPlan`），
user 门在 `wiki/wiki-plan.controller.ts`，runner 门在 `runner-api/runner-wiki-plan.controller.ts`；共享类型在 `src/shared/src/wikiPlan.ts`，
runner-go 在 `wiki_plan.go`，OrbitKit 在 `Models/WikiPlan.swift`。起草作业（`orbit wiki plan draft / revise`）、按 plan 写文档和客户端各有
自己的任务，照本节写；起草作业的服务端与 runner 部分见 21.7、21.8。

### 21.1 四张表与版本

- `wiki_plan` 一行是 plan 的**一个版本**：版本号（每个 space 从 1 数起）、状态、谁做的（`origin`：`maintenance` 是维护会话的起草作业，
  `owner` 是 owner 的编辑或接受的修改建议）、修订的哪一版（`base_version`）、大类（JSON）、声明的「需新增」字段、这一版被要求的
  篇数范围、检查闸报告、runner 报告的仓库引用核对结果与对应的 sha、谁在何时确认。
- `wiki_plan_doc` 一行一篇：大类、slug、标题、读者带着的问题、写给谁、含与不含（不含的归到哪篇）、预计篇幅、是否受保护。
- `wiki_plan_section` 一行一节：顺序、在本篇内稳定的 `key`、标题、类别、讲什么、篇幅、材料来源条件。
- `wiki_plan_proposal` 一行一条修改建议：理由、改动内容、由哪些事实引起、状态与 owner 的回答。
- 状态：`draft`（过了闸、等 owner）、`confirmed`（owner 确认的、文档据以写的那一版）、`superseded`（被更新的草稿或新的确认取代，
  原样留作历史）。每个 space 至多一个草稿、至多一个已确认版本（两个部分唯一索引）。
- **已确认的版本不再改动**：篇和节只插入；起草、编辑、接受建议都产生新版本，在 space 行的锁（`FOR NO KEY UPDATE`）下一个事务写完。
  一个版本唯一会被更新的是它自己那一行 `wiki_plan` 的状态（被确认、被取代）。所以 owner 确认的那一版，就是文档据以写的那一版，一字不差。
- 草稿和编辑都要写明它建在哪一版上（`baseVersion`，首个草稿为 null），而且必须是当前最新的未取代版本（有草稿就是草稿，否则是已确认版）；
  否则 `WIKI_PLAN_STALE`（409），什么都不写——同一份草稿带着存下它的幂等键再落一次除外（见 21.6）。接受建议建在它找到的最新版本上，
  写入期间 plan 变了也同样 409。

### 21.2 plan 的形状（`plan.schema`）

- 草稿是 `{ categories, docs, newFields? }`，两个都是列表：文档用大类的 `key` 指明所属大类，大类和文档都按目录顺序排。
- 大类：`key`（slug）、`title`、`question`、`forAgents`（给 agent 的开发约定单列一类，判据 11）。
- 文档：`category`、`slug`、`title`、`question`、`audience`、`scopeIn`、`scopeOut: [{ text, docs: [slug] }]`、`length: { min, max }`、
  `protected`、`sections`；`audience`、`scopeIn`、`sections` 不能为空。
- 节：`key`（可省，服务端给：沿用上一版同标题那节的 key，否则下一个 `s<n>`）、`title`、`kind`（十类闭集：overview、concepts、flow、
  interface、data、ops、pitfalls、decisions、conventions、other）、`covers`、`length`、`sources`。
- `sources`：`docs: [{ path, section }]`（设计文档章节）、`code: [{ path, symbols }]`（代码文件与符号）、`contracts: [{ path }]`、
  `sessions`（会话条件，或 null）：`projects`（按 id 或完整标题）、`since` / `until`（`YYYY-MM-DD` 或 null）、`keywords`、`anchorPaths`、
  `entryKinds`、`topics`（本 space 的主题 slug）、`evidence`（要找什么样的原话）。
- **需新增的字段**：schema 没有的字段一律拒。模型真需要新字段时，在 `newFields` 里声明 `{ at, name, why }`（`at` 是 category、doc 或
  section），值放进该对象的 `extra` 里、按名字存，和 schema 自己的字段分开；检查闸报告的 `needsNewFields` 列出来给 owner 看。声明的名字
  已是 schema 字段的拒，`extra` 里没声明的名字也拒。owner 的编辑和修改建议只能用所改版本已声明的字段。

### 21.3 检查闸（`plan.gate`）

四项，按顺序跑，全部跑完一起回答，不在第一个错误处停：

| check | 查什么 |
|---|---|
| `schema` | 每个字段都在 schema 里（或已声明为需新增），类型对、长度在 `rules` 内；节的类别在闭集里；大类 key、文档 slug、同篇的节 key 不重复 |
| `docCount` | 篇数在目标范围内：请求没写 `target` 时是 `rules.docsMin`–`rules.docsMax`（20–35），写了就按它（上限 `docsCeiling` 200） |
| `protected` | 被修订版本里受保护的篇，在新版本里原样保留：slug、大类、字段、各节及其顺序都不变（节的 key 不算）；只有 owner 能把一篇设为受保护，草稿或建议自己设的拒。owner 自己的编辑不查这一项 |
| `references` | 会话条件里的项目是 owner 的（按 id，或只有一个项目叫这个名字的完整标题）、主题是本 space 的、条目 kind 在闭集里；文档的大类是本 plan 的大类；`scopeOut` 指向的篇是本 plan 的篇；建议的事实是本 space 的条目或 owner 的会话 |

- 不过闸：`WIKI_PLAN_GATE`（422），`errors[]` 逐条给出 `{ check, path, message }`，`path` 从请求根算起
  （草稿是 `plan.docs[3].sections[2].sources.sessions.projects[0]`，编辑是 `doc.…` / `section.…`，建议是 `change.doc.…`）；编辑和建议
  会让整个 plan 变成什么样，关于那份结果的错误按结果 plan 的位置写（`plan.docs[20].protected`）。最多列 `rules.errorsMax`（200）条，
  消息里写总数。什么都不存，起草作业把清单交回模型重做。
- **报错里的值、枚举值的读法**（`plan.gate.values`）：message 里引用请求给的值，一律写成 JSON 字符串——带双引号，看不见的字符
  （控制字符、格式字符、行与段分隔符、U+0020 以外的空白）写成 `\uXXXX`——让反引号、不可见字符、首尾空白都看得见。起因：10-01 的维护
  运行里，plan 修改建议三轮都没过闸，报错是 ``…entryKinds[0]: `decision` is no kind of entry: one of principle, convention, decision, …``：
  模型把值写成了带反引号的 `` `decision` ``，报错没加引号，读起来像「decision 不是 decision」，模型三轮都没改对。枚举类字段（节的
  kind、会话条件的 entryKinds 与 topics、newFields 的 at、facts 的 kind）校验前去掉首尾空白和包裹整个值的反引号或引号（`` ` `` `"`
  `'` `“”` `‘’` `「」` `『』` `«»`，可以套几层；成对、且里面不再有同样的符号才算包裹）。只去包裹，不做别的宽读：`` `decision` `` 读作
  decision，Decision、decisions、后面跟着零宽空格的 decision 照样拒。runner 自己的闸和维护运行对修改建议的检查，读法和写法都一样。
- **仓库引用不在服务端查**：文件、docs 章节、符号、契约只在 checkout 里有，服务端没有。起草作业在 runner 上、在某个 sha 上核对，随草稿报
  `repoCheck: { sha, checked, missing: [{ kind, ref, at }] }`（`kind` 为 file / docSection / symbol / contract）；服务端原样存在版本上
  （`repo_sha`、`repo_check`），不评判。owner 做出的版本没有 runner 核对过，这两项为空。
- 过了闸的版本存检查闸报告：`{ checkedAt, checks（各项 passed；owner 编辑时 protected 为 skipped）, docs, target, needsNewFields }`。

### 21.4 修改建议（`plan.proposals`）

- 维护作业遇到落不进 plan 任何一节的新知识，就提一条建议：理由（`reason`）、改动内容（`change: { doc, category? }`：这篇文档应有的样子
  ——按 slug 替换 plan 里的那篇，或者新增一篇；需要新大类时一并给出）、由哪些事实引起（`facts: [{ kind: entry | session | commit, id }]`：
  本 space 的条目、owner 的会话，或者——没有任何一节引用的新设计文档——把它加进 origin/main 的提交，用完整的 40 位 sha；服务端没有
  checkout，只核它的形状，查证是维护作业在 origin/main 上做的）。
- 提建议要求 space 已有确认的 plan（否则 `WIKI_PLAN_UNCONFIRMED`）；建议对着已确认版本过闸（含受保护检查），存为 `pending`。
  **接受之前，plan 的任何版本都不变。**
- owner 拒绝：只结算这条建议（可附 note），plan 不动。owner 接受：把文档放进当前最新版本（替换同 slug 的篇，或插在同大类最后一篇之后），
  **重新过闸**（plan 可能已经变了），过了就产生新草稿（`origin: owner`，记下 `proposal_id`），建议记 `accepted` 与 `resultVersion`，
  二者在一个事务里；没过就 `WIKI_PLAN_GATE`，建议保持 pending。新草稿照常等 owner 确认。
- 已决定的建议再回答：`WIKI_PLAN_STALE`。

### 21.5 守卫：`requireConfirmedPlan`

- `requireConfirmedPlan(db, { ownerId, spaceId })`：返回 space 已确认的版本 `{ id, version, confirmedAt }`，没有就抛
  `WIKI_PLAN_UNCONFIRMED`（409）。只有草稿不算。写文档的入口（判据 9 的任务）在写之前调它，可传入自己持有的事务。

### 21.6 谁能做什么，路由

- **runner 门**（`maintenanceRoutes`）：只对本 space 的维护会话（`isWikiMaintenanceSession`）开放；别的会话 `WIKI_NOT_MAINTENANCE_SESSION`，
  不带会话头 400，别的 owner 的 space 404。
  - `GET /api/runner/wiki/spaces/:id/plan`：当前已确认版本、草稿、待定建议；
  - `POST /api/runner/wiki/spaces/:id/plan/drafts`：`{ baseVersion, target?, plan, repoCheck, model?, idempotencyKey? }`，过闸存为新草稿；
  - `POST /api/runner/wiki/spaces/:id/plan/proposals`：`{ reason, change, facts }`，过闸存为待定建议。
  - **草稿的幂等键**（`plan.idempotency`，迁移 `0339_wiki_plan_idempotency`）：草稿可以带 `idempotencyKey`（至多 200 字），和变更集的一样
    属于 owner。存下的版本记着键和请求摘要（请求 JSON 按键排序、连同 space id，`request_sha256`），一个键只存一个版本
    （`UNIQUE (owner_id, idempotency_key)`）。同一个键加同样的请求是重放：在读 plan 之前就回答这个键存下的那一版（按它现在的样子），
    带 `replayed: true`，不写、不发事件、不过闸，也不报 `WIKI_PLAN_STALE`；两次同时落下时，第二次在 space 行的锁下找到第一次存的那一版，
    同样作答。同一个键配不同的请求被拒 `WIKI_IDEMPOTENCY_KEY_REUSED`（409），什么都不写。草稿的回答是整版外加 `replayed`，本次存下的为 false。
    owner 的编辑和接受的建议不带键。
- **user 门**：只认 JWT，owner 本人；带会话头的请求（任何角色）一律 `WIKI_OWNER_CHANNEL_ONLY`，读也一样，在读任何东西之前拒。
  别的 owner 的 space、版本、建议一律 404。runner 门没有任何确认或决定的路由，也不做 MCP 工具（硬约束 2）。
  - `GET /api/wiki/spaces/:id/plan`：`{ spaceId, confirmed, draft, proposals, job }`（`job` 见 21.7）；
  - `GET /api/wiki/spaces/:id/plan/versions`：全部版本，新的在前（版本号、状态、来源、修订自哪版、篇数、时间）；
  - `GET /api/wiki/spaces/:id/plan/versions/:version`：某一版全文；会话条件里的项目读作 `{ id, title }`（标题是现在的，项目已删为 null）；
  - `POST /api/wiki/spaces/:id/plan/edits`：`{ baseVersion, docSlug, doc }` 改一整篇（新 slug 即改名），或
    `{ baseVersion, docSlug, sectionKey, section }` 改其中一节，产生新草稿；
  - `POST /api/wiki/spaces/:id/plan/versions/:version/confirm`：确认草稿，原已确认的版本被取代；不是草稿的 `WIKI_PLAN_STALE`；
  - `POST /api/wiki/plan-proposals/:id/decide`：`{ action: accept | reject, note? }`；
  - `POST /api/wiki/spaces/:id/plan/redraft`：`{ instructions? }`，要一份草稿（带修改意见就是修订），见 21.7。
- 每次存下版本、确认、提出或决定建议，事务提交后发一次 `wiki.changed`（只带 space id）。
- plan 不是知识：不进推送块，不能当出处，`wiki_search` / `wiki_get` 不返回它。

### 21.7 plan 的作业：起草、修订与触发（`plan.jobs`）

JSON 里是 `plan.jobs`；迁移 `0338_wiki_plan_job`；服务端在 `src/apiserver/src/wiki/wiki-plan-job.ts`，共享类型在 `src/shared/src/wikiPlan.ts`。

- **作业是维护清单里的任务**：起草（`draft`，跑 `orbit wiki plan draft`）、修订（`revise`，跑 `orbit wiki plan revise`，带 owner 的修改意见）
  和生成（`build`，跑 `orbit wiki docs build`，owner 确认一个版本后按它写全部文档，21.9）都建在该 space 隐藏的「Wiki maintenance」清单里，所以跑它的会话就是维护会话
  （`isWikiMaintenanceSession`），plan 的 runner 门只对它开放。任务：指派 `settings.maintenance.workspaceId`，provider 钉
  `settings.maintenance.provider`，`runAt` 为建出的那一刻，创建者是 owner（`USER`）；描述就是指令，修订时把 owner 的原话引在后面，
  并写明 Bash 调用给 `timeout: 18000000`、不许更短，工具在命令结束前就返回时不要再跑、汇报截断前打印的内容就结束（16.5）；
  判据 `EXECUTABLE`：`orbit wiki plan check --space <id> --job <id>`，超时 `rules.checkTimeoutSeconds`（300 秒）。
- **事实触发，不用时钟**（`triggers`）：`space_created`——新建 space（`POST /api/wiki/spaces`，或会话提议时隐式建的 space）；
  `owner`——owner 在 plan 页要求（`POST /api/wiki/spaces/:id/plan/redraft`，只认 JWT，带会话头一律 `WIKI_OWNER_CHANNEL_ONLY`；
  body 带 `instructions` 就是修订，最多 `rules.instructionsMaxChars` 4000 字，不带就是起草），或者确认一个版本
  （`POST /api/wiki/spaces/:id/plan/versions/:version/confirm`，要的是按它生成文档：`build`）。
- **不重复**：一个 space 至多一个没结束的起草或修订（部分唯一索引）。再次要求时回答已有的那个（`{ created: false, job }`），并重新问它现在能不能建；
  已建出、但任务已结束或已删除而运行没报结果的，先记为失败，不挡后来的要求。生成作业（迁移 0340）：一个 space 至多一个**等着建**的生成
  （`queued` 或 `held`，另一个部分唯一索引）；再次确认时回答它，并把它指向更新的版本；已建出、正在跑的生成不挡——它写它被建时的版本，
  等着的那个写下一个。生成作业从一开始就带着要写的版本（`version`，CHECK 保证非空），失败了也保留。
- **和维护运行错开，plan 作业先走**（`staggered`）：作业和维护运行共用这个清单，一次一个任务。清单里有没结束的任务时，作业先记下（`queued`），
  等 owner 的某个任务结束（`task.changed`）再建，排在下一次维护运行之前：维护触发在清单有没结束的任务时不建，这个 space 有排队的作业时也不建
  ——事实到达时清单已空，就改为把作业的任务建出来；这期间到达的事实照常累积在 backlog 里，作业的任务结束后，由下一个事实按原有规则再判断。
  held 的作业等的是 owner 的设置，不是清单，不挡维护。GPU 不会被两边同时占用。
- **听哪些任务变化**（`trigger`）：`WikiPlanJobFacts` 读本副本发布的每个 `task.changed`——发给 owner 的（任务模块），和发在会话上的
  （runner 门：会话的回合或结束让任务落定时发在这个会话上），后者按会话的 owner 读。维护任务正是这样结束的：验收回合比对完，任务转 DONE 或
  FAILED，事件发在维护会话上。起因：2026-10-01 owner 05:26 确认 plan v1，生成作业排在一次维护后面；那次维护 05:55 结束时事件发在会话上，
  作业只听发给 owner 的事件，没听到；维护触发随后由别的会话的事实在 05:56、06:35 又各建了一次维护，生成直到 07:07 owner 再次确认才建出，
  多等了 1 小时 11 分。
- **没配维护不建**（`held`）：`settings.maintenance.workspaceId` 不是 owner 的 workspace 时是 `no_maintenance_workspace`，provider 起不来
  （`wikiMaintenanceProviderProblem`）时是 `maintenance_provider_unusable`；原因和最初那一刻记在作业上（`held_reason` / `held_at`，
  照 `maintenance.job.held` 在游标上的做法）。owner 改维护设置、或再次要求时重新问，能建就建。清单还没有就为作业建（维护不必打开）。
- **不算维护运行**（`notAMaintenanceRun`）：不计入 `dailyRunLimit`（`wikiMaintenanceRunsToday` 只数清单里的其他任务），也不被它挡；
  维护关着也能跑：认领时不因维护关闭而拒它的会话。它的会话撞上 120 轮被截断时，只记为这个作业失败，游标不动也不计失败。
- **作业状态**（`GET …/plan` 的 `job`，先取没结束的，否则取最后结束的，从没有过就是 null）：`queued`（附 `waitingFor`：挡着它的任务和
  那次运行的会话、开始时间）、`held`（附 `held: { reason, at }`）、`running`（任务已建：`provider`、`sessionId`、当前第几轮
  `attempt` / `attemptsMax`、`startedAt`；生成作业另带 `progress: { docs: { done, total }, current: { slug, title } | null }`，plan 页的
  「Writing documents」读它）、`succeeded`（存下的 `version`；生成作业是它写的已确认版本）、`failed`（最后一轮检查闸的 `errors`、`error`、
  运行报告 `report`，以及它最后那份草稿 `draft`，照送进检查闸时的样子）。作业种类 `draft | revise | build`。
- **runner 门**（都在 `maintenanceRoutes`）：`GET …/plan/job`（本会话的作业，以及 space、仓库和维护 workspace 的 checkout；记下开始）、
  `POST …/plan/job/progress`（`{ attempt }`，1 到 `rules.attemptsMax`；生成作业是 `{ docs: { done, total }, current }`）、
  `POST …/plan/job/finish`（`{ outcome, version?, errors?, error?, report?, draft?, attempt? }`；成功时 `version` 必须是本会话存下的本 space 的
  草稿——生成作业则是 owner 确认过的版本；报告至多 16,000 字节，草稿至多 1,000,000 字节）、
  `GET …/plan/materials`（owner 的项目及任务数、会话数；本 space 的 workspace 近 90 天的会话标题、月份、是否任务会话、所属项目、
  引擎；条目按 kind 与状态的分布；主题及 active 条目数、最近六条。标题出门前先脱敏）——这四条只对本 space 的维护会话开放；本会话的任务
  不是作业、或作业已结束时 `WIKI_PLAN_NO_JOB`（409）——只有一种例外：作业只结束一次，同一个运行把同样的结局再报一遍（第一次送到了、回答在
  路上丢了，runner 会重发），答它记下的、什么也不改；别的结局照样 409。`GET …/plan/check?jobId=<id>`：任务的验收命令，无会话头时认本 owner 的 runner。

### 21.8 起草作业怎么跑（`orbit wiki plan draft / revise / check`）

- **准备材料**：维护 workspace 的 checkout（`~` 按 runner 账号展开），fetch 后以 origin/main 为准：模块结构与入口、`docs/` 标题树
  （不含 `docs/mocks`、`docs/evidence`）、contracts 清单、代码符号索引；再经 runner 门读项目、会话标题的统计与聚类、条目与主题分布。
- **分四步起草**，每步用干净的 Claude Code 调本地模型（`--bare`、`--setting-sources ''`、空 HOME 与 CLAUDE_CONFIG_DIR、不挂 MCP、
  apiKeyHelper 鉴权、不开 thinking），紧凑行格式，回答流式落盘：目录骨架 → 按大类补每篇的读者与范围 → 逐篇大纲与每节材料来源 → 规则草案。
  开跑前等 `/health` 返回 200，碰到第一个 401 就停。
- **检查闸**：先过本地的闸——字段与格式、篇数、受保护的篇、引用（文件、docs 章节、符号、契约在 origin/main 那个 sha 上都存在；项目、主题
  存在；正文里「→ x.y」「见 x.y」指向本 plan 的篇）、修订时移出的节只能是约定类（`conventions`）——再交服务端的闸。
  任一道不过，就把逐条错误交回模型、只重做出错的单元，最多 `rules.attemptsMax`（3）轮；仍不过就以非 0 退出并列出错误。
- **修订**：模型先出新目录（每篇写明由上一版哪些篇组成，以及移到给 agent 的大类的节），只重写合并或新增的篇；只由上一版一篇组成的，
  沿用它的大纲、去掉移出的节。受保护的篇原样带过去。交给模型的上一版的篇（以及重做时交回的那一篇），会话条件里的项目写标题，和起草
  提示里一样，不写要模型照抄的 id；只有标题和别的项目重名、或者材料里的项目清单可能被截断时，才保留 id。
- **结束**：`POST …/plan/job/finish`；`orbit wiki plan check` 读作业：结束且成功、版本还在，才退出 0。
- **门的瞬时故障**：这些调用和 wiki 的其他调用一样走 `Transport.doWiki`：遇到网关 502/503/504、连接或流被重置、回答在路上丢了，
  读、`progress` 与 `finish` 再发（结局可以落两次，见 21.7）。草稿带一个由作业、会话和草稿本身派生的幂等键（21.6），所以也再发
  （`wikiRecordsOnce`）：第一次已经存下、回答丢了时，第二次拿到那一版（`replayed: true`），运行照常成功，只有一个版本；
  下一轮改过的草稿是另一个键。

### 21.9 生成作业：确认后按新版本写文档（`build`，判据 11）

- **谁要的**：owner 确认一个版本（`POST …/plan/versions/:version/confirm`）是一个事实。确认提交之后，服务端据此要一个生成作业（`trigger:
  owner`，`version` 为刚确认的版本），失败了也不影响确认本身；作业照 21.7 建任务、排队、held、不计每日次数、维护关着也能跑。
- **任务**：标题 `Wiki documents: <space 标题>`，描述是指令——跑一次 `orbit wiki docs build --space <id>`，再汇报写了、没变、失败的篇与节、
  token 与耗时（Bash 调用同样给 `timeout: 18000000`；被截断时不再跑，已写的节保留，下一次生成原样不动，16.5）；验收命令同样是 `orbit wiki plan check --space <id> --job <id>`：作业以 succeeded 结束、它写的版本是 owner 确认过的，才通过。
- **怎么跑**：`orbit wiki docs build` 在这个任务的会话里先问 `GET …/plan/job`——本会话的作业是生成作业，就按已确认的 plan 写全部文档（22.11），
  每开始写一篇报一次 `progress`，最后 `finish`：没有节写失败才是 succeeded，并带 `version` 与报告（`WikiPlanBuildReport`：`planVersion`、
  `repoSha`、`docs { total, written }`、`sections { written, unchanged, failed }`、`tokens`、`seconds`、`model`）。不是作业（`WIKI_PLAN_NO_JOB`）
  或是起草作业的会话，照常写、什么也不报。生成作业的会话里 `--doc`、`--section` 不可用。
- **只重写变了的**：材料指纹没变的节跳过，所以小改后重新确认，只重写变了的节。写到一半 plan 又被确认了新版本：旧版本的写入会被
  `WIKI_PLAN_STALE` 拒绝，这次生成以失败结束；等着的那个生成接着写新版本。
- **服务端执行**：执行器开关把账号交给服务端时，生成作业不建任务，由 wiki-worker 的 `docs_build` 作业来写，见 22.13。

### 21.10 服务端起草与修订（服务端执行 P6，`plan.jobs.server`）

JSON 里是 `plan.jobs.server`；迁移 `0404_wiki_plan_server_draft`；实现在 `src/apiserver/src/wiki-worker/`（行格式 `wiki-plan-format.ts`、
快照上的仓库 `wiki-plan-repo.ts`、材料与聚类 `wiki-plan-materials.ts`、提示 `wiki-plan-prompts.ts`、检查闸 `wiki-plan-gate.ts`、作业
`wiki-plan-draft-job.ts`），是 `src/runner-go/wiki_plan_*.go` 的移植；常量是 `src/shared/src/wikiPlan.ts` 的 `WIKI_PLAN_SERVER_JOB`。

- **什么时候走这条路**：执行器开关是 `server`，或是 `canary` 且账号在名单内（24.5）。`runner`（默认）和名单外的账号，作业照 21.7、21.8
  建任务、由维护会话跑，一字不改。
- **怎么建**：`advanceWikiPlanJob` 先问开关：起草建 `plan_draft`、修订建 `plan_revise` 的 `wiki_job`（优先级 1，输入 `{ planJobId }`），
  和把 plan 作业记为 `made`（`wiki_plan_job.job_id`）在同一个事务里。仍然要维护 workspace——worker 经它的 runner 读仓库——没有就照旧
  held `no_maintenance_workspace`；不问 provider（不调任何会话的模型），也不等隐藏清单（`staggered` 是 runner 那条路的规则：服务端由队列和
  「同一空间同时只跑一个作业」保证模型不被两边同时调）。不建任务、不建会话。建 space 和 owner 的要求都是 owner 发起的，所以作业的每个
  请求都排在后台维护前面（`jobs.priority`）。
- **调用**：每次调用是模型请求队列里的一个请求。step 是 `plan_skeleton` / `plan_details` / `plan_outline` / `plan_rules` /
  `plan_revise_catalogue` / `plan_revise_doc` / `plan_redo_doc`，都是 `plan_*`：等待至多 20 分钟，一次调用至多 60 分钟（25.5）。unit 是
  `a<轮次>/<runner 上的单元名>@<这次调用 sha256 的前 12 位>`，所以重放碰到的是已经发出的那个请求，问题变了就是新请求。max_tokens 32,000，
  system prompt 与 runner 逐字相同，一条 user 消息；已收到的部分随调用写进请求的 `partial`。回答读不成行格式的，把格式要求再说一遍重问，
  一个单元至多 3 次；一个作业同时至多 4 个请求在途，和 runner 的 `--concurrency` 默认值一样。
- **分几步**：同 21.8。起草先出目录骨架，篇数不在范围内时带着篇数重问，至多两次，仍不对的交给检查闸；再按大类并行补每篇的读者与范围，
  逐篇并行出大纲与每节来源，规则草案和它们同时问。修订先出新目录，只重写合并或新增的篇，受保护的篇原样带过去。
- **材料**：作业第一次运行时读一次，存在 plan 作业上（`wiki_plan_job.materials`）：space 快照的 sha——runner 能取时先要一份新快照（至多等
  300 秒），否则用 space 已有的快照，都没有就按 infra 等——plan 材料（`GET …/plan/materials` 用的同一个函数）、读材料的日期，以及快照
  不带的原文：概览的几篇文档和 `schema.prisma`，经 runner 的 read 在该 sha 上读（至多等 300 秒）。重放读回它们，问模型的还是那些问题；
  快照在作业下面换了（别的作业取了更新的快照），就在新快照上从头起草，和 runner 起草所用的 sha 离开 origin/main 时一样。
- **材料上限**（字符，沿用 runner 的现值）：出目录读概览 14,000、模块结构 32,000、docs 标题树 45,000；按大类补细节读 10,000 / 26,000 /
  30,000；逐篇出大纲读概览 8,000，代码符号摘录 16,000 字节。会话标题照旧按 TF-IDF k-means 聚类，每算 20 毫秒让出一次事件循环。
- **仓库**：runner 的作业在 checkout 里读的，全部在同一个 sha 的快照索引上读：文件和大小（模块结构、`hasPath`）、每篇文档的标题（标题树、
  `hasDocSection`）、每个源文件的符号（代码摘录、`hasSymbol`）、契约的顶层键（契约清单）。索引里没有的符号，和 runner 一样在文件原文里
  找这个词——原文在这一轮过闸之前按该 sha 读，读的是**整个文件**（`repoOps.read`，owner 2026-10-08）。两条路仅剩的一处可能不同，是索引
  只记对象的键（JSON 是数组或空对象的契约读作「非 JSON」）；原文本身不再有窗口。空间的 runner 只声明了 `wiki-repo-op/v1` 时仍是旧窗口，
  写明的缺失会说明这一点（§26.5）。
- **检查闸**：先过作业自己的闸——21.8 的本地检查，错误文案逐字相同，文件、docs 章节、符号、契约都在快照上查——再过服务端的闸（21.3）：
  作业在进程内提交（`WikiPlans.submitServerDraft`），带草稿的幂等键，`repoCheck` 是快照的 sha 和作业的闸查到的结果，所以服务端的闸
  现在也查得了仓库。两道闸查出的错误，连同可用的章节标题和符号，按单元交回模型重做，一共至多 `rules.attemptsMax`（3）轮。
- **作者**：存下的版本记跑出它的 `wiki_job`（`wiki_plan.author_job_id`，读出来是 `authorJobId`），会话存下的照旧记会话；来源 `maintenance`，
  模型名是 System model 的。
- **进度与结束**：plan 作业照 21.7 记进度——第一次运行记 `started_at`，每轮记 `attempt`，plan 页读的就是这些；`wiki_job` 自己的进度是
  `{ planJobId, attempt, step }`。运行照 21.7 的规则结束 plan 作业（`WikiPlans.finishServerJob`）：成功时带上这个作业存下的本 space 的版本，
  失败时带最后一轮的错误、出错原因、报告和最后那份草稿；`wiki_job` 以 `{ kind, planJobId, outcome, version, error, plan }` 结束。平台的
  失败——请求等待超限、space 的 runner 不在、worker 停机——不算草稿的失败：`wiki_job` 重试（24.4），plan 作业保持 running。`wiki_job`
  结束了而 plan 作业没结束的，记为失败；开关不再把账号交给服务端时，还没开始的 `wiki_job` 被取消，plan 作业随之结束。
- **runner 门归服务端**（`WIKI_SERVER_EXECUTES`，409）：找到 space 之后，不论谁来问，起草用的路由——`GET …/plan/job`、
  `POST …/plan/job/progress`、`POST …/plan/job/finish`、`GET …/plan/materials`、`POST …/plan/drafts`——一律拒绝，生成作业
  （`build`）自己的会话也一样：P7 起文档也由服务端写（22.13），不再建生成任务；开关切换之前建的生成任务，它的会话在第一次调用时就停下，
  作业随任务结束。所以会话里的 `orbit wiki plan draft` 或 `revise`，包括本期之前的版本，在第一次调用时就停下，没问过任何模型；
  新版命令（随下一个 runner 版本发布）说明 plan 由服务端用 System model 起草、这里什么也没读也没问模型、要起草请 owner 在 plan
  页要求。维护运行读 plan（`GET …/plan`）、提修改建议、`plan check` 都不变。`runner` 下每条路由照 21.7。
- **迁移 0404**：加 `wiki_plan.author_job_id`，`wiki_plan_author_chk` 改为维护来源的版本恰好记会话或作业之一；加 `wiki_plan_job.materials`；
  `wiki_plan_job_made_chk` 改为 made / ended 时恰好有一个来源（任务或作业），与文档构建的 0405（P7）逐字相同，谁先跑另一条就什么也不做。
- **两边同一个答案**：`src/shared/src/wiki-plan.fixture.json` 由 `src/runner-go/wiki_plan_fixture_test.go` 从一个真实的 checkout 按 runner 的
  方式读出，`src/apiserver/src/wiki-worker/wiki-plan-golden.spec.ts` 按服务端的方式读——行格式读回、引用、材料、每一步的 prompt、每一轮
  的草稿、检查闸的错误和仓库检查，逐字节相同。

## 22. 文档：按确认的 plan 逐节写，脚注引一手原文（判据 9 第 2 版）

JSON 里是 `docs`；迁移 `0326_wiki_docs` 与 `0337_wiki_doc_dispositions`；服务端在 `src/apiserver/src/wiki/wiki-docs.ts`（写入、
核对、分类、读）、`wiki-docs-material.ts`（一节的服务端材料）与 `wiki-doc-withdrawal.ts`（撤句），user 门在 `wiki/wiki-docs.controller.ts`，
runner 门在 `runner-api/runner-wiki-docs.controller.ts`；共享类型在 `src/shared/src/wikiDocs.ts`，runner-go 在 `wiki_docs.go`（类型与
门）和 `wiki_docs_build.go`（`orbit wiki docs build`，22.11），OrbitKit 在 `Models/WikiDocs.swift`。客户端有自己的任务，照本节写。

### 22.1 四张表

- `wiki_doc`：一篇一行，用 plan 篇的 slug 跨版本对应。记最近一次写入依据的已确认版本（`plan_id`、`plan_version`、`plan_doc_id`）、
  状态（`ok` / `needs_review`）、那次写入读仓库时的 origin/main 提交（`repo_sha`）和时间。
- `wiki_doc_section`：写过的一节一行，用 plan 节的 key 对应。记依据的 plan 节、材料指纹（`material_sha256`）、生成时读仓库的
  origin/main 提交（`repo_sha`）、块（`blocks`）、模型、统计、生成时刻，以及 `stale_at`：有句子被撤下时写上，下一次维护运行重写这一节。
- `wiki_doc_sentence`：一句一行：正文、状态、无出处句带出的新事实记号，撤下时写明时间、原因与经由的条目。
- `wiki_doc_footnote`：一个句子的一个脚注一行：种类、位置（仓库原文 `path@sha#L起-止`；记录是 id 加字符区间）、逐字引文
  （已脱敏）、仓库原文附带的那几行（`excerpt`）、结论、谁核对的（`server` / `runner`）、via entry。
- 旧的按主题文章（§18，`wiki_topic_summary`）保留、照常可读，直到客户端切到文档。
- 历史引用不挂外键：plan 的行、via entry、撤下时记的条目、脚注的记录 id。四张表都经 `(…, owner_id)` 复合外键级联到 space。

### 22.2 写入：`POST /api/runner/wiki/spaces/:id/docs/:slug`

- **谁能写**：本 space 的维护会话（`isWikiMaintenanceSession`），以及 API 服务器进程里的导入（`origin: 'import'`、无会话、无用户）。
  别的会话 `WIKI_NOT_MAINTENANCE_SESSION`，不带会话头 400，别的 owner 的 space 404。user 门没有写文档的路由。
- **次序**：写入者 → `requireConfirmedPlan`（没有已确认的 plan 就 `WIKI_PLAN_UNCONFIRMED`，只有草稿也算没有）→ 这一篇在已确认的
  plan 里（否则 404）→ 请求的 `planVersion` 就是已确认的版本（否则 `WIKI_PLAN_STALE`）→ 形状 → 核对 → 一个事务写入。
- **请求**：`{ planVersion, repoSha, model?, sections: [{ key, materialSha256, markdown, footnotes, dispositions? }] }`。一次最多 20 节（整篇）。
  `dispositions` 是这一节材料的处置留痕（22.9）。
  - `repoSha`：这次读仓库时 origin/main 的提交，40 位小写 hex，必填；写到的每一节都记下它。
  - 仓库脚注（`design_doc` / `code` / `contract`）：`{ kind, path, sha, lines: { start, end }, section?, symbol?, quote?, excerpt?, verified, viaEntryId? }`，
    `sha` 必填（7–64 位 hex），`verified` 是 runner 在那个 sha 上自己核对的结果。
  - 记录脚注（`turn`、`event`、`tool_call`、`task`、`task_comment`、`approval`、`owner_decision`、`merge_receipt`、`note`）：
    `{ kind, ref, chars?: { start, end }, quote?, viaEntryId? }`。
  - 引文最多 1000 字，`null` 或不给算没给引文；`viaEntryId` 必须是本 space 的条目。
- **形状不对**：`WIKI_DOC_INVALID`（422），`errors[]` 逐条 `{ path, message }`，一次列全（最多 200 条，消息里写总数）：schema 外字段、
  仓库脚注缺 sha 或行号、行号倒着、记录脚注缺 id、plan 这篇没有的节、同一节写两次、不是本 space 条目的 via entry、`repoSha`
  不是 40 位提交……什么都不写，runner 改完一起重发。
- **正文**：Markdown，`[n]` 指本节的 `footnotes[n-1]`。第一行若是标题，那是本节自己的标题（plan 已给），丢掉；围栏代码块是一个
  code 块、不核对；其余标题行是 heading 块；列表项是 item 块，缩进的下一行接着它；其余连续行到空行为一段。段与列表项按文章的规则
  断句（§18.4：`。！？`，以及后面跟空白或行尾的句点和英文 `?` / `!`，代码段里不断），所以「；」不算句末。越界的标记指不到脚注，
  去掉并计数（`markersDropped`）；只有标记没有字的不算一句；一节一句都没有就拒。
- 句子、标题、代码块、引文和附带的行，落库前都过共享脱敏器（带 owner 的 workspace.env 值）。

### 22.3 核对

- **会话记录由服务端核对**：按记录 id 在本账号自己的行里重读原文——经 `WikiService.sourceText`，也就是条目出处的引文核对、核实者
  读到的原文、案卷行的位置所用的同一个读法（`wiki-verify-evidence.ts`：event 是 `runEventText`，tool call 是工具名、输入和输出
  放在一起，approval 是回答和附言、以及它决定的 plan）——先脱敏，再和同样脱敏过的引文逐字比。给了 `chars` 就只在那一段里找。
  找到的位置记为字符区间（脱敏后文本的码点），连同记录所在的会话、序号、时间、标签，供页面拼链接。
- **比对前折叠**：NFC；全角标点 `，。：；（）！？「」“”‘’、『』【】—–` 读作对应的半角；去掉 `**`、`__`、反引号；Markdown 转义读作
  被转义的字符；去掉全部空白。原文另比一遍去掉每行开头注释符（`//`、`///`、`/*`、`*`、`*/`、`#`）的样子，所以引代码注释的话也找得到。
  引文必须是原文里连续的一段：省略号不是可以跳过的缺口；翻译、转述、把两段拼成一句都找不到。折叠后不足 4 个字的引文到处都找得到，
  一律算找不到。
- **结论**：`verified`；`not_found`（不在原文里）；`no_quote`（没给引文）；`unresolved`（记录不是本账号的、已删、或根本不是记录）。
- **仓库引文由 runner 核对**：服务端没有 checkout，照收 runner 的结论，记为「由 runner 在某 sha 上核对」（`checked_by = runner`、
  `sha`）；没带 sha 的拒收。仓库脚注不会是 `unresolved`。

### 22.4 句子的状态，整篇待审

| 状态 | 条件 |
|---|---|
| `sourced` | 带脚注，其中至少一个 `verified` |
| `unverified` | 带脚注，一个都没核对过 |
| `withdrawn` | 某个脚注经由的条目已被拒、退役、被取代，或锚点变了 / 不见了（22.6） |
| `transition` | 不带脚注，句中每个事实记号都已出现在同篇有出处的句子或标题里（篇的标题、读者的问题、各节标题、正文里的标题块） |
| `unsourced` | 不带脚注，有新的事实记号；这些记号随句存下 |

- **事实记号**：反引号里的代码；3 个字符以上的英文标识符或路径（`the`、`and`、`for`、`with`、`not`、`are`、`can`、`its`、`but`、`via` 不算）；
  两位以上的数字；带单位的数（秒、分钟、小时、天、个、条、次、%、ms、s、MB、KB）。一律小写、去空白。
- 每写一节就对整篇重新分类一次：一节里的过渡句要对上其他节现在说的话。
- 无出处和核对不过的句子不删，逐句标出。二者合计**超过**全篇句子的 5%（正好 5% 不算），整篇标 `needs_review`。已撤下的句子计入总数、
  不计入分子：它们等重写。

### 22.5 不变不重写

- `materialSha256` 是 runner 算的：这一节在 plan 里的定义（标题、类别、covers、篇幅、来源条件）加上它取到的材料。服务端不重算，只比。
- 已存的这一节指纹相同、且没有被撤过句（`stale_at` 为空），就不写（`outcome: unchanged`，行原样不动）；否则整节替换，句子和脚注随之。
- 已确认的 plan 里这篇不再有的节，下一次写这篇时删掉。没有时钟重写任何东西（硬约束 5）。
- 每节的 `repoSha` 读接口会带回来（22.7），维护作业拿它和当前 origin/main 比：节引用的设计文档、代码或契约变了，就重写这一节
  （owner 09-29：agent 往 `docs/` 写了新东西，wiki 要跟上）。比对是维护作业的事，服务端只存、只还。

### 22.6 撤句

- 条目被拒（Reject）、退役、被取代，或锚点变成 `changed` / `missing` 时，经它引用的句子（有脚注的 via entry 是它）标为 `withdrawn`，
  记下时间、原因（`rejected` / `retired` / `superseded` / `anchor_changed` / `anchor_missing`）和条目；所在的节写上 `stale_at`，由下一次
  维护运行重写（不看指纹）。
- **钩子挂在条目状态唯一的写入点上**：`WikiService.recomputeFlags`，`applyOp` 的每个分支都以它收尾（设计 §3，`storage.singleWriter`），
  在条目自己的事务里做，所以没有哪条改条目的路径会漏掉它，也没有另开条目状态的写入点。
- 写文档时，经由的条目已处在上述状态的，那一句当场就是 `withdrawn`、那一节当场 `stale`。写入事务先以 `FOR SHARE` 按 id 锁住所有
  via entry，所以同时发生的 Reject 会等写完再撤掉它写的句子；两边都是先条目、后文档，不会互相死锁出环。
- **仓库文件没了**（迁移 0340，`docs.withdrawalPaths`）：维护作业发现节引用的文件在 origin/main 上被删或改名走了，就交给
  `POST …/maintenance/docs/withdrawals`（22.12）：本 space 文档里有仓库脚注引用它的句子，按 `anchor_missing` 撤下，记下路径
  （`withdrawn_path`，代替条目），所在的节标 `stale`。撤下的句子记的是条目或路径，二者恰有其一（CHECK），路径只配 `anchor_missing`。
  文档按 id 顺序 `FOR NO KEY UPDATE`，与写入和条目撤句取锁的顺序一致。

### 22.7 读

- **user 门**（JWT，owner 本人；别的 owner 的 space 或文档一律 404）：
  - `GET /api/wiki/spaces/:id/docs`：目录。已确认 plan 的大类（编号从 1 起）→ 篇（编号 `<大类>.<序号>`、标题、读者的问题、是否写了、
    状态、更新时间、依据的 plan 版本、导语）→ 节（编号、标题、类别、是否写了、是否待重写）。没有已确认的 plan 时 `plan` 为 null、目录为空。
    **导语**（`lead`，`docs.lead`）是首页上每篇的两行：已写的篇取第一节（按已确认 plan 里节的顺序）按位置排、不是 `withdrawn`
    的头两句，照原样连起来（英文句号后空一格，全角句号后不空），超过 200 字（code point）就截断、末尾加「…」；句子是文档页上的
    原文，行内标记照留。没写的篇为 null；写了但第一节没写、或第一节的句子都撤下了，也为 null。
  - `GET /api/wiki/spaces/:id/docs/:slug`：文档页。编号、标题、读者的问题、写给谁、含与不含（不含的篇给出编号和标题）、大类、篇幅、
    状态、依据的 plan 版本与当前版本、`repoSha`、更新时间；各节按 plan 的顺序，带 `repoSha`、块和句子（状态、脚注号、新事实记号、
    撤下的原因与条目）；脚注按首次出现编号（同一原文、同一位置、同一引文只编一个号），每个带种类、结论、谁核对的、引文、位置字符串
    和链接数据；以及 via entry 现在的样子（种类、标题、状态、trust、锚点状态）和它带进来的脚注号。plan 里有、还没写的篇：`written: false`，
    各节空着；plan 里没有的：404。
  - `GET /api/wiki/spaces/:id/doc-index`：A–Z 索引。plan 的全部篇，加上别的篇没有同名的节标题（「总览」「已知的坑」「约定」这类
    篇篇都有的不收），各带所在篇的编号、标题、大类和是否写了，按标题排序（客户端再按拼音分组）。
- **链接数据**（`docs.links`）：
  - turn、event、tool_call 的脚注带**记录 id（`recordId`）和它所在的会话 id（`sessionId`）**——`wiki_source` 只存记录 id，客户端拼深链
    要两个一起：web 用 `sessionRecordHref(sessionId, recordId)`，iOS 用 `SessionRecordLink.url(session:record:)`，服务端的读取是
    `GET /api/sessions/:id/events/page?around=<recordId>`。
  - 其余记录带它所在的东西：approval、merge receipt 带会话，task comment 带任务，owner decision 带项目，note 带路径；另有会话、任务、
    项目的标题，turn / event 的序号、时间与标签（turn 的 kind、event 的 type、工具名、评论的作者类型、receipt 的结果）。
  - 仓库原文带 path、sha、行号、章节或符号，以及 runner 附带的那几行。
- **runner 门**（维护会话）：`GET /api/runner/wiki/spaces/:id/docs`：已确认 plan 的版本，和每篇已写的文档：依据的版本、状态、`repoSha`、
  各节的指纹、`repoSha`、是否待重写、生成时刻——维护作业据此决定重写哪些节。
- 每次写入有节被写，事务提交后发一次 `wiki.changed`（只带 space id）。

### 22.8 视图，不是知识

- 不进 `<orbit_wiki_context>`：推送只读 `wiki_entry`。
- 不能当出处：没有任何出处种类指向文档、节、句子或脚注，引用它们一律 `WIKI_SOURCE_UNRESOLVED`；脚注的种类（`design_doc` 等）本身
  也不是出处种类，写进条目的出处是 `WIKI_SCHEMA`。
- agent 的 `wiki_search` / `wiki_get` 只返回条目。没有读写文档的 MCP 工具。

### 22.9 处置留痕：每条材料最后怎样了（迁移 0337）

- 写入的每一节可以带 `dispositions`（契约 `docs.dispositions`，最多 `rules.dispositionsPerSection` = 200 条），逐条是
  `{ material, kind, ref, action, into, reason }`：
  - `material`：runner 给这条材料在本节里的编号（`D1` 设计文档章节、`C2` 代码、`K1` 契约、`S3` 记录），字母开头、最多 16 个字符，本节内不重复；
  - `kind`：仓库种类或记录种类（与脚注相同的闭集）；`ref`：仓库材料是 `path#L起-止`，记录是记录 id；
  - `action`（`docs.dispositionActions`）：`adopt` 归并时采用、交给写作；`merge` 归并时并到本节另一条（`into` 必填，指本节留痕里的另一条）、
    和它一起交给写作；`drop` 归并时舍弃、写作看不到；`over_cap` runner 没交给模型——本节材料满了；`filtered` runner 按规则拿掉——平台模板消息、
    或与本节另一条原文相同；
  - `reason`：理由，不能为空，最多 `rules.reasonMaxChars` = 500 字；`into` 只有 `merge` 才有，其余为 null。
- 形状不对同样是 `WIKI_DOC_INVALID`，错误路径到 `sections[i].dispositions[j].<字段>`，一次列全。
- 存在 `wiki_doc_section.dispositions`（JSONB 数组，CHECK 为数组），理由和其他文字一样先过脱敏器；节被重写时随新行一起换，节不变时原样留着。
  读文档（user 门与 runner 门）时每节带回 `dispositions`；还没写的节是空数组。

### 22.10 runner 门的两个读：一节的服务端材料，和写成的文档

- **`GET /api/runner/wiki/spaces/:id/docs/:slug/material?section=<key>`**（`docs.reads.material`，维护会话）：`{ spaceId, slug, section,
  planVersion, condition, entries, records, unresolved }`，是这一节材料里只有数据库才有的那一半（`docs.material`）。
  - 没有 `section` 400；plan 这篇没有这一节、或没有这篇 404；没有已确认的 plan `WIKI_PLAN_UNCONFIRMED`；别的会话 `WIKI_NOT_MAINTENANCE_SESSION`，
    不带会话头 400，别的 owner 的 space 404。
  - `condition`：已确认 plan 里这一节的会话条件，项目带现在的标题；没有会话条件时为 null，其余都空。
  - **条目引路**：space 里 active、锚点既非 changed 也非 missing、**符合**这一节来源条件的条目（`docs.affected.fit`）：关键词（标题、摘要、
    字段、别名里出现，每个 3 分）或锚点路径（在 `anchorPaths` 之下，2 分）命中，或者——属于 `entryKinds` 之一（没列就不限）——在 `topics`
    之一，或取自 `projects` 之一的会话或任务；主题、种类、项目各再加 1；分高的在前，同分取新，最多 `entriesPerSection` = 6 条。维护作业把
    条目归到节，用的是同一条规则（22.12）。每条取当前修订的
    live 出处，按引用顺序最多 `sourcesPerEntry` = 3 条：条目只引路，材料是它引的一手记录（`via` 带条目 id、标题、种类和出处的引文）。
  - **按条件检索**：同时有项目和关键词时，这些项目的协调会话与其任务的会话里、时间窗（`since` 当天起，`until` 当天止）内、含任一关键词（不分
    大小写）的 owner 原话（`isOwnerTurn`），和这些项目的任务评论；命中关键词多的在前、同样多取新，最多 `ownerTurnsPerSection` = 6 条和
    `commentsPerSection` = 4 条。
  - **每条记录**都经 `WikiService.sourceText` 读出，用共享脱敏器加 owner 的 workspace.env 值脱敏——和脚注核对读到的是同一段文字（22.3）。
    不超过 `excerptChars` = 1100 字的整条给出；更长的给出它周围的 1100 字（以出处引文的位置为准，没有就以第一个关键词为准，前面留三分之一），
    `chars` 是这段文字在脱敏后全文里的码点区间——正是记录脚注的 `chars`，所以从这段里原样抄的引文，服务端核对时找得到。另带 `length`
    （全文码点数）、证据分量 `weight`（`docs.material.weights`：`decision` owner 原话 / 回答 / 决定 / 评论，`merge` 合并回执与交付评论，`output`
    命令与工具输出，`error` 报错，`other` 其余）、`ownerWords`、时间、所在会话 / 任务 / 项目的标题、note 的路径。同一条记录只给一次。
  - 条目引的出处若已不是本账号的记录（被删、或别人的），不读、不给，列在 `unresolved`。
- **`GET /api/runner/wiki/spaces/:id/docs/:slug`**（`docs.reads.writerDoc`，维护会话）：和 user 门的文档页是同一个回答。维护作业写概述时，
  没重写的节从这里读它们写成的样子。

### 22.11 `orbit wiki docs build`：逐节取材、归并、写作、核对仓库引文

```
orbit wiki docs build --space <id> [--doc <slug>] [--section <key>] [--repo <path>] [--model MODEL] [--json]
```

维护会话的命令，没有对应的 MCP 工具（`docs.build`）。前置条件照 `docs.build.precondition` 逐字写在描述开头。

1. **读**：已确认的 plan（`GET …/plan`）与已写的状态（`GET …/docs`）；在 `--repo`（默认当前目录的 checkout）里 `git fetch origin main`，
   此后一律读 origin/main 这时指向的提交（`repoSha`）。fetch 失败什么都不写。
2. **取材**（`docs.build.repository`）：设计文档章节——从匹配的标题行到下一个同级或更高级标题；代码符号——定义连同上面的注释，到花括号合上
   为止（Go 方法按接收者、TS 方法按所在类找）；没列符号的代码文件——文件头注释和与本节字眼匹配的至多 3 个声明；目录——其下前 4 个文件；契约
   ——整个文件。都在行边界上截到限额，带文件、行号。有会话条件的节再取 22.10 的服务端材料。
3. **机械清理**：项目结算卡片发出的复查模板消息（以 `About “` 开头、含 `Orbit has not recorded it done` 的 turn）不是 owner 原话，拿掉；与本节
   另一条原文相同的只留第一条。二者在留痕里记为 `filtered`。
4. **上限**：一节交给模型的材料至多 `materialMaxChars` = 22000 字（每条另算 120 字的标题）；讲机制的节（概念、流程、接口、数据、运维）先取
   设计文档与代码，其余节先取记录；第一条不论多长都给。放不下的记为 `over_cap`。
5. **指纹**：对本节在 plan 里的定义（标题、类别、covers、篇幅、来源条件——项目只按 id）和取到的全部材料（含被拿掉的）算 sha256；不含提交本身，
   所以没动到本节所读内容的新提交不改指纹。和 `GET …/docs` 里存的相同且没被撤句，就跳过，不调模型。
6. **归并**（一次干净调用）：模型对交给它的每条写「采用 / 合并到 x / 舍弃」和理由，再写 3–8 条现状要点；证据分量决定 > 合并记录 > 命令输出 >
   报错，同级取最新；讲机制以代码为准。没写处置的按采用，并到不存在的条目按采用，都在理由里说明。
7. **写作**（一次干净调用）：只喂采用和合并的材料。每个事实句各自在句末标材料编号，决策、坑、约定段也逐句标；契约与设计文档的缩写第一次
   出现先说明；每个编号都要附一行逐字引文（不翻译、不拼接、不加省略号）。只在段末标一次、前面有事实句没标的段落，带着问题再问一次，新稿
   更好才用。编号换成按首次出现的 `[n]`，不属于本节材料的编号去掉。
8. **核对引文**：仓库引文在该提交的文件里找（折叠规则同 22.3，只是 runner 不做 NFC），先在材料那几行里找，找不到再在全文件找；`lines` 是找到的行、
   `excerpt` 是那几行，`verified` 如实写；记录引文在服务端给的那段文字里先找一遍（服务端会再核）。有编号的引文缺了或找不到，就只问这几个
   编号一次，补上的引文再核一遍。
9. **提交**：每写完一节就提交一次（带 `dispositions`），写入是逐节的检查点；一篇的写入一次只发一个。门的每个调用都经
   `Transport.doWiki`（`wiki_retry.go`）：读随时可以重发；写也可以——同一节同一指纹落两次，第二次是 `unchanged`，什么都不多记。
10. **概述最后写**：其余节写完后再写概述节。它的材料是这些节写成的正文（本轮写的用本地结果，没重写的从 22.10 的文档读），脚注换成
    `[F1]`…，模型只能沿用这些编号；概述的脚注照抄被引那条的原文与引文，仓库引文在本轮的提交上再核一遍。概述的指纹是它的定义加其余各节
    现在的指纹，所以任何一节重写，概述就跟着重写；它没有归并，留痕为空。
11. **模型**：一律经 `askWikiModel`——`wiki_verify.go` 的干净启动（`--bare`、空 HOME 与配置目录、不挂工具和 MCP、不存会话、环境白名单、
    apiKeyHelper），不开 thinking（`CLAUDE_CODE_EFFORT_LEVEL=unset` 加 `MAX_THINKING_TOKENS=0`）；开写前等 `/health` 返回 200（至多 3 分钟）；
    失败的调用隔 10 秒、30 秒各重试一次；碰到第一个 401 就停，不再发任何调用。一篇的节至多 4 个同时在写。
12. **退出码**：有节没写成就非 0，下次运行再试；`--json` 输出每节的结果、材料处置计数、脚注数、本地找到引文的数、调用数、token 与耗时。
13. **生成作业**：开跑前先问 `GET …/plan/job`；本会话跑的是生成作业（21.9），就在每开始写一篇时报 `progress`、结束时报 `finish`；否则什么也不报。
    维护作业把它当作库来调，只交给它受影响的节，并给定比较时用的那个提交（不再 fetch）。

### 22.12 维护作业要重写哪些节，和引用的文件没了（判据 3 第 3 版）

- **`GET /api/runner/wiki/spaces/:id/maintenance/docs`**（`docs.reads.affected`，维护会话）：`{ spaceId, plan, build, sections, unplaced,
  unplacedMore, proposed }`（`WikiDocsAffected`）。
  - `plan`：已确认的版本、确认时间、plan 最近一次核对仓库引用的提交（`repoSha`：确认版本的，没有就沿 `baseVersion` 往前找最近一个有的）、
    这个 space 第一版 plan 的起草时间（`draftedAt`）；没有已确认的 plan 就是 null，其余全空——维护作业就不写文档。
  - `build`：space 没结束的生成作业（`{ jobId, state, version }`），没有就是 null。
  - `sections`：已写过的节里，要因为条目重写的：有条目在该节生成（`generatedAt`）之后被应用了 op（模式直接生效的 `auto_applied`、抽检前已生效的、
    owner 接受或编辑的），且符合该节的来源条件（`docs.affected.fit`）；再加上所有 `stale` 的节。每节带 `repoSha`、`generatedAt`、`stale` 和
    这些条目的 id。
  - `unplaced`：自第一版 plan 起草以来被应用过 op、active 且锚点健在、符合不了已确认 plan 任何一节、也没被任何修改建议（无论结果）点名的条目，
    新的在前，至多 `docs.affected.rules.unplacedMax` = 50 条；`unplacedMore` 是其余的数。
  - `proposed`：space 所有修改建议已经点名的条目、提交，以及它们的改动里引用的设计文档路径——维护作业不再提。
- **`POST /api/runner/wiki/spaces/:id/maintenance/docs/withdrawals`**（`docs.withdrawalPaths`，维护会话）：`{ repoSha, paths: [{ path, change:
  deleted | renamed, to? }] }`，`repoSha` 是这些路径已不在的 origin/main 提交（40 位），至多 `withdrawPathsMax` = 500 条；形状不对
  `WIKI_DOC_INVALID`，逐条列出。回答 `{ spaceId, withdrawn, sections: [{ doc, key }] }`：这次撤下的句子数（已撤的不再算）和它们所在的节。

### 22.13 服务端执行（服务端执行 P7，2026-10-08）

JSON 里是 `docs.build.server`、`jobs.kindRuns.docs_build` 与 `plan.jobs.server.build`；迁移 `0405_wiki_plan_job_server_maker`；实现在
`src/apiserver/src/wiki-worker/`（作业 `wiki-docs-build-job.ts`、一次构建 `wiki-docs-build.ts`、移植过来的写作 `wiki-docs-writer.ts`）和
`src/apiserver/src/wiki/wiki-plan-job.ts`（排作业）、`wiki-docs.ts`（写入者与门）。

- **对谁**：执行器开关把账号交给服务端的（`server`，或 `canary` 名单内）。runner 模式下这一节都不发生：确认照 21.9 建任务，
  `orbit wiki docs build` 照 22.11 写，逐字不变。
- **怎么排**：owner 确认一个版本，照 21.9 要一个生成作业；对这样的账号，生成作业不建隐藏列表里的任务，而是建一个 `docs_build` 作业：
  plan 作业以 made 记下这个作业（`wiki_plan_job.job_id`，没有 `task_id`），作业优先级 1（owner 发起，排在后台维护之前），输入
  `{ planJobId }`，二者在同一个事务里写。空间的维护没有指定 workspace 时照样 held（`no_maintenance_workspace`）：作业要经这个 workspace
  所在的 runner 读仓库。不检查 provider，也不排在列表里未结束的任务后面——没有哪个会话的模型参与。迁移 0405 把 0338 的
  `wiki_plan_job_made_chk` 改写成「made / ended 的作业有一个制造者：任务或 wiki 作业」，否则这样的 plan 作业根本建不出来。
  开关改回 runner 时，还在排队、服务端没开始的这种作业，会在下一次要生成时被取消，plan 作业以失败结束并写明原因。
- **仓库**：先请求一次 `snapshot`（空间已有这个提交的快照时 runner 回 `skipped`），它给出的提交就是 origin/main——runner 的 fetch，和
  命令自己的 fetch 一样。各节来源点名的文件，在这个提交上**整个**读回（不带 section；owner 2026-10-08）：按快照里的大小打包，一次操作
  至多 `repoOps.read.operationBytes`（4 MiB），超过 `inlineBytes` 的回答走分片（§26.4）；服务端按 `(space, sha, path)` 缓存，同一份原文
  不再读第二次。然后照 22.11 第 2 步在服务端切出设计文档的节、符号、声明和契约，行号相同。目录照 git 显示树的样子给出（从快照的路径
  列出），和 runner 的 `git show` 一样。超过 `wholeFileBytes`（2 MiB）的文件不读：按缺失处理，原因写明 `too_large`。空间的 runner 只
  声明了 `wiki-repo-op/v1` 时是旧窗口（22,000 字）：保留截断前的整行，不在其中的标题或符号记为缺失并写明原因——这样的文件里只找名字或
  编号对得上的标题，不找只是包含这个名字的标题，那可能是另一节。读取持有作业租约等待（`repoOps.waiting` 的例外），每次至多 300 秒；
  空间的 runner 不能领操作（`no_workspace` / `runner_missing` / `runner_offline`）或等待超时都是 infra 失败，稍后重试——只声明了
  `wiki-repo-op/v1` 的机器不算，它照旧跑，只是读得短。
- **会话材料**：在进程里直接调 `wiki-docs-material.ts`，和 22.10 的材料读一样：条件挑出的条目、它们引用的记录、项目与时间窗与关键词找到的
  记录，都按 owner 的 workspace.env 脱敏、定位。
- **调用**：每次调用是队列里的一条请求：系统提示与 runner 逐字相同，一条 user 消息，`max_tokens` 8192，step 是 `docs_merge`、`docs_write`、
  `docs_rewrite`（只在段末标一次的段落再问一次）、`docs_quotes`（引文缺了或找不到再问一次）或 `docs_overview`，unit 由文档、节和提示词的
  sha256 组成，作业被重放时问题没变的调用直接复用答案。5xx、429、断连由队列退避重试；401 让整个队列停下（§25.6）。
- **确定性部分与 runner 相同**：提示词、过滤、上限、指纹、归并与草稿的读法、脚注及其行号。`src/shared/src/wiki-docs-build.fixture.json`
  把两条路径钉成同一个答案，由 `src/runner-go/wiki_docs_build_fixture_test.go` 写出、`wiki-docs-build-golden.spec.ts` 读取——指纹一致，
  空间从 runner 路径切到服务端时，runner 写过的节不会因此重写。
- **写入**：经 `WikiDocs.write`，和 runner 门是同一个写入口，身份是服务端自己（`origin: 'maintenance'`、无会话、无用户）；一次写一节，
  一次构建的写入一个一个来；`model` 是 System model 的名字。被拒（`WIKI_DOC_INVALID`、`WIKI_PLAN_STALE`、`WIKI_PLAN_UNCONFIRMED`）就是
  这一节失败，原因照 runner 的说法写。
- **进度与结束**：每开始写一篇和结束时，写 plan 作业的 `progress`（21.9 的 `{ docs: { done, total }, current }`）和作业自己的 progress。
  拿起的节全部写成或无变化：plan 作业以 succeeded 结束，带写的版本和 `WikiPlanBuildReport`；作业成功，报告是这次构建的 summary。
  有节没写成：其余节照常写完，plan 作业以失败结束（`<n> sections were left unwritten`），作业以 content 失败结束、报告留在行上——
  和命令以非 0 退出一样。平台的失败（runner 不在、读取或请求等待超限、worker 停机）两者都不结束：作业稍后重放，已写的节靠指纹原样不动。
  重放时发现 plan 作业已经结束，就按那个结束回答。
- **runner 门**：对这样的账号，文档在 runner 门上的路由（`writerState`、`writerDoc`、`material`、`write`、`affected`、`withdraw`）
  对维护会话一律回 `WIKI_SERVER_EXECUTES`，什么都不读；plan 作业的路由对所有会话也都这样回，生成作业的会话在内（21.10）——所以旧
  runner 的 `orbit wiki docs build` 和维护运行的文档步骤都问不到会话的模型。别的会话照旧是 `WIKI_NOT_MAINTENANCE_SESSION`。runner 模式下
  照 22.10、22.12 回答。
- **命令行（随下一次 runner 发版）**：`orbit wiki docs build` 把 `WIKI_SERVER_EXECUTES` 读作「文档由服务端写」——第一次调用读作业时
  如此，读写文档的路由上也如此：不调模型、不再写、说明一句（`--json` 里 `serverExecutes`），以 0 退出。开关切换之前建的生成任务，它的
  会话在第一次调用时就被拒，作业随任务结束；运行到一半开关切换、结束作业也被拒的，同样留给任务。在那之前，旧 runner 碰到拒绝会以非 0
  退出，同样什么都没问。

## 23. System model 与 wiki-worker（服务端执行 P1a）

JSON 里是 `systemModel`；设计见 `docs/wiki-server-execution-design.md` §2.1、§4.1、§4.5、§5.3、§6。迁移 `0400_wiki_model_status`；
worker 在 `src/apiserver/src/wiki-worker/`（入口 `main.ts`、配置 `wiki-system-model.ts`、客户端 `wiki-model-client.ts`、状态与心跳
`wiki-model-status.ts`），读接口在 `src/apiserver/src/wiki/wiki-system-model.ts` 与 `wiki-system-model.controller.ts`，metrics 在
`wiki/wiki-model-metrics.ts`；共享常量在 `src/shared/src/wikiSystemModel.ts`。本阶段 worker 只探测模型、写状态和心跳；作业表、请求队列
和执行器开关在 P1b，还没有流水线经它调用模型。

### 23.1 服务

- compose 服务 `wiki-worker`：镜像 `orbit-apiserver:local`，`command: node src/apiserver/dist/wiki-worker/main.js`；`depends_on`
  apiserver（`service_healthy`），自己不跑迁移；`restart: unless-stopped`，`stop_grace_period: 30s`；不监听端口，不挂卷。
- 入口用 `NestFactory.createApplicationContext` 起 `WikiWorkerModule`：只有 Prisma 和 worker 自己的 provider，没有控制器。打开
  `enableShutdownHooks([], { useProcessExit: true })`：容器里 node 是 PID 1，收到 SIGTERM 后停止探测、等最后一次写入完成、关闭数据库，
  然后显式退出。
- owner 2026-10-07 同意新增这个服务。`test/compose-topology.test.mjs` 的 (l) 逐行钉住它的定义，(k) 把它放在一边之后，仍要求 compose
  比基线删的行多于加的行。

### 23.2 配置（`systemModel.env`）

| 变量 | 说明 |
|---|---|
| `ORBIT_WIKI_MODEL_BASE_URL` | 不带凭据的 http(s) 地址；去掉末尾的 `/` 后，调用发到 `{base}/v1/messages`，探测发到 `{base}/health` |
| `ORBIT_WIKI_MODEL_API_KEY` | 以 Bearer 发送 |
| `ORBIT_WIKI_MODEL` | 模型名 |
| `ORBIT_WIKI_MODEL_CONCURRENCY` | 所有空间合计的在途请求上限，默认 4；不是正整数时用默认值 |

- 前三项齐全且可用才算已配置；缺任何一项就是 `unconfigured`，不探测，也不调用。
- 只配给 wiki-worker，apiserver 的环境里一项都没有。名字都不是 `ANTHROPIC_*`。
- `readWikiSystemModel(env)` 是纯函数，返回配置、缺了哪几项（`missing`）和 `problems`。worker 启动时经 `currentWikiSystemModel()` 读一次，
  问题只记一次日志。`problems` 和日志都不引用 key 和地址（日志只写地址的 origin）。

### 23.3 调用（`systemModel.request`）

- `POST {base}/v1/messages`，头是 `authorization: Bearer {key}`、`anthropic-version: 2023-06-01`、`content-type: application/json`；体是
  `{model, max_tokens, system, messages: [一条 user], stream: true}`。`max_tokens` 由每次调用显式给出；不带 tools，不开 thinking。
- 用 Node 自带的 fetch 流式读取，按 SSE 的规则逐行解析：`event:` 给事件名，多行 `data:` 用换行拼接，空行派发，`:` 开头是注释；CRLF 和
  跨块切开的行照常读。`message_start` 给出模型名和初始用量；`content_block_delta` 里的 `text_delta` 依次拼成答案；`message_delta` 给出
  `stop_reason` 和截至目前的用量；收到 `message_stop` 才算结束。`error` 事件按类型分类。`ping`、`content_block_start` / `stop`、不认识的事件，
  以及不是对象的 data（如 `[DONE]`），都跳过。
- 用量取流里最后报出的值：有 `message_delta` 的就用它的，否则用 `message_start` 的。
- 中断：一个 `AbortController` 管三件事——单次调用的预算（各步骤的上限）、空闲断开（`idleTimeoutSeconds` = 300 秒没收到任何字节，
  从发出请求起就开始计）、调用方的取消。
- 部分文本：每个 delta 之后，把目前收到的全文交给 `onPartial`；失败时，错误也带着 `partial`。§25 的队列用它写请求的 partial。
- 错误分三类（`WikiModelError.kind`）：

| 类 | 包括 |
|---|---|
| `retryable` | HTTP 5xx、429；连接被拒、被重置、中途断开、域名解析失败；流在 `message_stop` 之前结束；空闲断开；SSE `error` 的 `overloaded_error`、`api_error`、`rate_limit_error` |
| `unauthorized` | HTTP 401，或 SSE `error` 的 `authentication_error` |
| `other` | 其余状态码和 SSE 错误、不是事件流的回答、预算用完、调用方取消 |

- 错误消息里去掉 key、地址和主机名，可以原样存、原样显示。连接错误只写错误码（如 `ECONNREFUSED`），不写 Node 带地址的原文。
- 连接用 fetch 自带的连接池：keep-alive 复用，每个 origin 不限连接数，所以不会低于并发上限。收到 `message_stop` 之后仍把流读到结束
  （最多再等 1 秒），连接才能回到池里。

### 23.4 探测与状态行（`systemModel.health`、`systemModel.status`）

- 每 `intervalSeconds` = 10 秒 `GET {base}/health` 一次，带同样的 Bearer 和版本头，超时 5 秒：200 或 404 是 up，401 是 auth_failed，
  其余状态、超时、连不上都是 down。
- 每次探测（未配置时是每一拍）都写 `wiki_model_status` 唯一的一行（id = 1），语句是 `INSERT … ON CONFLICT (id) DO UPDATE`：

| 列 | 含义 |
|---|---|
| `state` | `up` / `down` / `auth_failed` / `unconfigured` |
| `model` | 模型名；只有未配置时可以为 NULL |
| `since` | 这个状态从什么时候开始；状态和模型都没变时保持不动 |
| `last_error` | 不是 up 的原因，不含地址和 key（HTTP 状态、连接错误码、变量名）；恰好在 up 时为 NULL |
| `checked_at` | 最近一次探测；未配置时为 NULL |
| `worker_seen_at` | worker 的心跳，随每次写入更新 |

- `auth_failed` 一直保持到 worker 重启：`/health` 通常不校验 key，它恢复 200 并不说明 key 已经改好；重启时才会读到改好的 key。调用遇到 401
  时，由请求队列（P1b）调 `WikiModelStatusProbe.keyRefused` 报告。
- down 时请求留在队列里不动（§25.6），探测继续，下一次 up 就恢复。
- 只有 worker 写这一行（db-write inventory 里是一条 `ONE_ROW_BY_KEY` 语句），apiserver 只读。

### 23.5 读：`GET /api/wiki/system-model`（`systemModel.read`）

- JWT 门加 `WikiRolloutGuard`；个人访问令牌要有 `wiki:read`。读的是部署的模型，不分 space：wiki 对其开放的账号都读到同一个回答。只读。
- 回答 `{ state, model, since, checkedAt, workerSeenAt }`（`WikiSystemModelStatus`）。`state` 比状态行多一个 `worker_not_running`：没有这一行，
  或 `worker_seen_at` 已超过 `workerStaleSeconds` = 60 秒，就是它，设置页和健康行显示「wiki worker 未运行」；这时 `since` 是最后一次心跳。
- 不返回地址和 key，也不返回 `last_error`。
- P9 起多一个 `executor`：执行器开关对**提问的这个账号**怎么说，`{ mode, serverExecutes }`（§24.5 的「读」）。设置页据此在服务端执行时
  画 System model、不画 provider；其余五个字段是部署的，每个账号读到的都一样。

### 23.6 `/api/metrics`（`systemModel.metrics`）

| 序列 | 类型 | 说明 |
|---|---|---|
| `orbit_wiki_model_state{state}` | gauge | 读接口给出的那个状态为 1，其余为 0 |
| `orbit_wiki_worker_heartbeat_age_seconds` | gauge | 距最后一次心跳的秒数；还没有心跳时不输出 |
| `orbit_wiki_model_calls_total{outcome}` | counter | `succeeded` / `retryable` / `unauthorized` / `other`；读请求队列的行（§25.8）|
| `orbit_wiki_model_call_duration_seconds` | summary | 0.5 与 0.95 分位、sum、count，取自结束的行（§25.8）|

- 调用都发生在不监听端口的 worker 里，所以这些数都在读 metrics 时从库里取，每个副本给出的都一样；标签值只来自闭集。

## 24. 服务端作业 `wiki_job`（服务端执行 P1b）

JSON 里是 `jobs` 一节；设计见 `docs/wiki-server-execution-design.md` §5.1、§5.4、§10。迁移 `0401_wiki_job`；实现在
`src/apiserver/src/wiki-worker/`（表访问与领取 `wiki-jobs.ts`、执行循环与种类注册 `wiki-job-executor.ts`、冒烟作业 `wiki-smoke-job.ts`、
执行器开关 `../wiki/wiki-executor-switch.ts`）；共享常量在 `src/shared/src/wikiJobs.ts`。

### 24.1 表与状态

- `wiki_job`：`id`、`owner_id`、`space_id`（复合外键到 `wiki_space`，随空间删除而删）、`kind`、`input`（JSONB，作业自己的材料，
  从不含地址和 key）、`priority`（默认 0，owner 主动发起的高于后台维护）、`state`、`waiting_for`、`attempts`、`next_attempt_at`、
  租约三列（`lease_owner` / `lease_generation` / `lease_deadline_at`）、`progress`、`report`、`error`、`failure_kind`、
  `created_at` / `updated_at` / `started_at` / `ended_at`。
- `state`：`queued` / `running` / `waiting` / `succeeded` / `failed` / `cancelled`；`waiting_for`：`repo` / `model`（只在 waiting 时非空，
  且此时不占租约）；`failure_kind`：`infra` / `content`。本期还没有代码把作业置为 `waiting`：作业在等模型请求时保持 `running` 并续租，
  由请求的等待上限收尾；把作业停在仓库操作上（P2）或停在模型不在时的那套转换，随需要它的阶段到来。
- CHECK：租约三列与 `running` 互为条件；只有结束态有 `ended_at`；`succeeded` 没有 `error`；`report` / `progress` 是对象。
- `kind` 闭集：`verify` / `articles` / `import` / `plan_draft` / `plan_revise` / `docs_build` / `maintain`，加上本期的 `smoke`——
  只调一次模型、把答案和用量写进 `report`，是队列最短的一条端到端路径（`wiki-jobs.pg.spec.ts` 对 fake 端点跑通它）；`verify` 自 P3 起有实现（§24.7）。
  还没落地的种类留在队列里：领取只取本 build 认识的种类，不会被交给一个只能失败的 worker。
- `import`（P5，§5.1 的服务端执行、契约 `jobs.kindRuns.import`）：由 runner 门的 `POST .../import-jobs` 建，输入是命令交来的 note
  和调用会话，报告就是命令打印并记下的那份（`wiki-import-job.ts`）。执行中写 `progress`（`snapshot` / `reading` / `proposing` 和计数）。
- `verify`（P3，§24.7）：由记录 op 进入 `verifying` 的那次提交建（业主重开核实也建），按会话排一条、`priority = 1`。
- `plan_draft` / `plan_revise`（P6，§21.10、契约 `jobs.kindRuns.plan_draft` / `plan_revise`）：由 `advanceWikiPlanJob` 在开关把账号交给服务端时
  建，和 plan 作业同一个事务，输入是 `{ planJobId }`，优先级 1；报告是 `{ kind, planJobId, outcome, version, error, plan }`
  （`wiki-plan-draft-job.ts`）。执行中写 `progress`（`planJobId`、`attempt`、`step`）。
- 作业重放时，某个单元上一次的请求如果是因等待超限而失败的（平台的失败，不是这次调用的），就换下一个 `attempt` 再问一次；否则
  作业每次重放都会碰到同一行失败的请求，模型回来以后也永远不再问（`wikiModelRequestAttempt`，P5 补上）。

### 24.2 领取、租约、回收

- 领取照 `watch_delivery`：一条 `UPDATE "wiki_job" … FROM (SELECT … FOR UPDATE SKIP LOCKED)`，候选是
  `state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())`、本 build 认识的种类、本 worker 服务的账号（§24.5）、
  且**同一空间没有在跑的作业**；顺序是 `priority DESC, created_at, id`；每条给一个新的 `lease_generation`，`started_at` 取第一次领取。
- 每次领取 `lease_deadline_at = now + 60s`，执行中每 20 秒续租一次；回写（成功、infra 重试、content 失败）都按代数比较并交换，
  被接管的旧进程写不进任何一行。
- 过期回收：`running` 且租约过期的行回到 `queued`，`attempts + 1`，`next_attempt_at = now + 退避`（§24.4），`failure_kind = 'infra'`；
  接管者从头跑这个作业，已经发出过的请求由请求行本身回答重放（§25.3）。
- 同一空间同时只跑一个作业：领取的谓词跳过一个在跑作业的空间，`wiki_job_space_running_key`（`space_id` 上的部分唯一索引）是数据库里
  同一条规则；两个调度器同时读表时，输的一方拿到的是空领取，不是错误。
- 一个 worker 同时执行 `maxConcurrentPerWorker` = 4 个作业。

### 24.3 开机与停机

- 开机先补跑一轮：worker 启动时立刻做一遍「回收 → 领取」，把上次死掉的 worker 留下的作业接起来。
- SIGTERM（docker 30 秒宽限，设计 §5.4，owner 2026-10-07 定的方案 A：不等在途请求）：停止领取；取消在跑的作业，每个作业把自己的
  租约截止时间设为现在并退出，让新进程的回收立刻接手；请求那一侧同理（§25.7）。

### 24.4 失败与退避

| 失败 | 处理 |
| --- | --- |
| infra（端点不可达、5xx、429、runner 离线、worker 重启、等待超限）| 回到 `queued`，`attempts + 1`，`next_attempt_at = now + backoffSeconds[attempts]`（0 / 10 / 30 秒；`attempts` 是这次失败之前已有的次数），不计入连续失败 |
| content（模型给不出可解析的结果、服务端拒绝）| 结束：`state = 'failed'`、`failure_kind = 'content'`、`ended_at`，计入连续失败 |
| 作业的请求等待超过步骤上限 | 请求以 `other` 失败（§25.5），作业读到后按 infra 处理 |

- 本 build 不认识的错误（不是作业自己抛的两类）按 infra 处理：宁可重试，不拿它去计空间的连续失败。

### 24.5 执行器开关 `jobs.executor`

| 变量 | 说明 |
|---|---|
| `ORBIT_WIKI_EXECUTOR` | `runner`（默认）/ `canary` / `server` |
| `ORBIT_WIKI_EXECUTOR_CANARY_OWNERS` | 只在 `canary` 下读：逗号分隔的账号 uuid |

- 纯函数 `readWikiExecutorSwitch(env)`（`src/apiserver/src/wiki/wiki-executor-switch.ts`，照 `wiki-rollout.ts` 的形状）由 apiserver 与
  worker 共用；`wikiExecutorServes` / `wikiExecutorClaimOwners` 把模式变成领取时的账号过滤：`server` 不过滤，`canary` 只取名单内，
  `runner` 是空集合——默认值下没有 worker 领取任何作业。
- 误拼的值读作 `runner` 并记一条 problem：拿不准时落在已经在跑的旧路径上，而不是落在一个没人部署 worker 的新路径上。
- 开关只管执行，不删历史；改回 `runner` 只是停止新的领取。
- 两个变量进服务环境的方式和 System model 的一样：compose 从部署的 `.env` 传给 **apiserver 与 wiki-worker 两个服务**（P3 接上；
  `test/compose-topology.test.mjs` 逐行钉住这两行，`wiki-compose-env.spec.ts` 确认它们读的是宿主同名变量），都没设就是 `runner`。
  把开关改成 `canary` 或 `server` 是 owner 的事：生产上停在 `runner` 直到 P10。
- **读（`jobs.executor.read`，P9）**：读接口只告诉提问的账号两件事——`mode`（部署的开关）和 `serverExecutes`（服务端是否执行这个账号的
  wiki：`server`，或 `canary` 且名单里有它）。名单本身、别的账号在不在名单里，都不出读接口（`wikiExecutorView`）。
  `GET /api/wiki/system-model` 和 `GET /api/wiki/spaces/:id/health` 都带它；客户端只在 `serverExecutes` 为真时画服务端的设置、
  Runs 卡和状态行的服务端原因，`runner` 下（或读不到这个字段的旧控制面）一切照旧。

### 24.6 运行行与计数

- `wiki_maintenance_run.job_id` 与 `wiki_plan_job.job_id` 记下跑出这一行的作业；两个表的 `task_id` 自 0401 起可空，CHECK 要求已开始的行
  恰好有一个来源（plan job 在 `queued` / `held` 时豁免——它两个都还没有）。
- 健康行与每日计数按运行行统计：`wiki_maintenance_run` 里由作业跑的运行（`job_id` 非空）按自己的行计数，与旧路径一样排除
  本地端点上的追赶运行和失败的运行；任务那条路径的计数一字未改，所以同一个部署今天算出的数和昨天一样。
- 服务端运行不建任务、不建会话：不占 `runnerActiveTurns`，runner 在服务端路径里只做 P2 的仓库操作。

### 24.7 核实作业：Automatic 的 op 由服务端核实（服务端执行 P3）

JSON 里是 `jobs.kindRuns.verify`、`jobs.make`、`agentSurface.verify.serverExecution`、`reviewModes.verification.who.server`；设计见
`docs/wiki-server-execution-design.md` §2.2、§8。实现在 `src/apiserver/src/wiki-worker/`（提示词与结论解析 `wiki-verify.ts`、作业
`wiki-verify-job.ts`、建作业端 `../wiki/wiki-verify-jobs.ts`）；测试是 `wiki-verify.spec.ts`（从 `src/runner-go/wiki_verify_test.go`
逐条改写来的）与端到端的 `wiki-verify-job.pg.spec.ts`。

**会话侧的门关上了（`servedBy`，P3 第 2 版）**：账号由服务端执行时（`jobs.executor` 为 server，或在 canary 名单内），
runner 门对非维护会话不再交出核实的材料——`GET …/verifications` 返回空页，带 `servedBy: "server"` 与 `waiting`（这个会话还有几条
op 在等），于是旧版 `orbit wiki verify` 读到空列表就正常退出，不会用会话自己的 provider 去调模型（下一次 runner 发版的命令连 provider 环境都不再需要：它先问谁核实，由服务端核实就不读 endpoint、token 和模型，直接请求并等待）；`POST …/verifications`
对这类会话回 409 `WIKI_SERVER_EXECUTES`（合同 `refusals`，与 P4 同一条）；`POST …/verifications/request` 让会话请服务端核实一次，
返回它等的那条作业（同一 space+session 只排一条，所以重复请求还是那条）。`submitChangeset` 的回答同样带 `servedBy: "server"`，
`wiki_propose` 对会话的说明随之改成「由服务端核实，结论会自己到，不需要跑命令」。维护会话与 runner 模式一字未改：维护运行照旧
读自己的列表、自己报结论（P8 之前仍在 runner 上），runner 模式下这些字段一律不出现。

**什么时候建作业**

- 一次提交里只要有 op 因为 Automatic 落成 `verifying`，就在这次提交的事务**提交之后**建一个 `verify` 作业：`input = { sessionId }`，
  `priority = 1`——提议的那个会话正在等这条结论，而 space 在这条结论到来之前不认这次提议（`jobs.make`、`jobs.priority`）。
- 作业的身份是**提出 op 的那个会话**：结论只认提出者的 op（§7.4），作业不是会话，所以它带着会话 id 去读、去写，写下的行 authored
  `system`，因为这是服务端用自己的账号做的（`reviewModes.verification.who.server`）。
- 同一 space 同一会话同时只有一个**排队中**的 verify 作业：作业跑起来时才读"此刻在等的 op"，所以排队期间又来一次提交搭这班车；
  作业已经在跑之后进来的 op 会有自己的作业（同一 space 一次只跑一个作业，排在后面）。
- 业主重开核实（§7.5，`POST /api/wiki/spaces/:id/verifications/reopen`）把 op 送回 `verifying` 时同样建作业：那些 op 所属的会话
  多半早就结束了，结论仍然得有人去问。
- 执行器开关不为这个账号开（`runner`，默认）就不建作业，一切照旧；维护运行提议的 op 也不建作业（本节末）。

**作业做什么**

- 逐页读该会话在这个 space 里等待核实的 op（`listVerifications`，一页 `rules.verificationListMax` 条），证据用服务端自己的读取器：
  同一条列表路由、同一份 `wiki-verify-evidence.ts` 的取文本、脱敏与截断。
- 每个 op 组装一条提示（`wiki-verify.ts`，与 runner 的 `wikiVerifyPrompt` 逐句相同：条目、每条出处的原文、可判重复的条目按
  E1…En 编号），经请求队列问 System model：一条 op 一个请求，`step = verify`、`unit = op id`，所以作业重放时已经答过的请求直接复用。
- 回答按 runner 的严格程度解析：**读不成结论就什么都不报**，这个 op 记进 `report.failures`，继续等下一次（09-30 的教训：89 个里 1 个没结论
  不该让整次运行失败）。作业因此以 `succeeded` 结束，`report` 是 `{ kind, spaceId, mode, model, looked, verified, supported, partial,
  unsupported, duplicate, failed, failures[{opId, why, refused}], stopped, usage }`。
- 结论走 `recordVerifications`（唯一的结论写入方）：supported 按 Auto 生效并推送、partial 记 Unreviewed、unsupported 驳回并留理由、
  duplicate 把出处追到它指向的那条——与 runner 路径同一条写入路径、同一份留痕。
- space 不再是 Automatic 就地停下（`stopped` 写明），剩下的继续等。单条 op 的调用以"这不是平台的错"的方式结束（队列的 content 类）
  算这个 op 的失败，不算整次的失败；平台的错照 §24.4 回队列重试。
- P8 的维护运行调用同一个函数的另外两个参数：维护的第二遍（带着 `refused` 的 retry 后缀再问一次）和收养（`adopt`，最多 50 条）。

**会话这一侧**

- server（或 canary 名单内）下会话不必再跑 `orbit wiki verify`：发起提交就有结论。命令保留，含义变成"请求服务端核实并等结果"——
  runner 那一半（命令改为请求服务端并等待，不再自己起一个模型）随下一次 runner 发版上线；在那之前、以及默认 `runner` 模式下，
  这条命令的行为一字未改（`agentSurface.verify.serverExecution`）。
- 维护运行不是会话：它至今仍在自己的进程里核实自己的 op（P8 才搬过来），所以它的提交不为它建作业。

**compose 里的执行器开关**

- `ORBIT_WIKI_EXECUTOR` 与 `ORBIT_WIKI_EXECUTOR_CANARY_OWNERS` 现在同时给 apiserver 和 wiki-worker（两个服务的 `environment`，
  默认 `runner`）：一个建作业、一个领作业，两个进程对同一账号必须给出同一个答案。`test/compose-topology.test.mjs` 逐行钉住这两行，
  `src/apiserver/src/wiki/wiki-compose-env.spec.ts` 确认它们读的是宿主同名变量（不是会话会带进来的 `ORBIT_*` 名字）。
- 生产上把开关改成 `canary` 或 `server` 是 owner 的事（设计 §10，P10）。

### 24.8 Activity 的读：`GET /api/wiki/spaces/:id/jobs`（`jobs.read`，服务端执行 P9）

服务端的运行没有任务、也没有会话可打开（设计 §2.2）：它在做什么——步骤、调用、在哪里排队——都在 Activity 里，Runs 卡和运行页读的就是
这条。实现在 `src/apiserver/src/wiki/wiki-job-reads.ts`，用户门在 `wiki/wiki-jobs.controller.ts`；共享类型 `WikiJobsRead` 在
`src/shared/src/wikiJobs.ts`。

- 只给 space 的 owner（JWT 门加 `WikiRolloutGuard`；个人访问令牌要有 `wiki:read`）；别的账号的 space 是普通的 404。只读。
- 回答 `{ spaceId, jobs }`：这个空间最新的 `limits.jobs` = 10 行 `wiki_job`，按 `created_at` 新的在前。每行：

| 字段 | 含义 |
|---|---|
| `id`、`kind`、`state`、`waitingFor`、`priority`、`attempts` | 作业行本身 |
| `createdAt`、`updatedAt`、`startedAt`、`endedAt`、`nextAttemptAt` | 时间；`nextAttemptAt` 是 infra 失败后下一次重试的时间 |
| `failureKind`、`error` | 失败的类别和原因 |
| `ahead` | 排队（`queued`）时：部署里按领取顺序（`priority DESC, created_at, id`）排在它前面的排队作业数；其余状态为 null |
| `progress` | 流水线自己写的进度（§24.1）读成 `{ step, done, total }`：写了 `done` / `total` 的照读；导入的形状（`notes`、`read`、`failed`）读成「读完或放弃的 note / 交来的 note」；没写为 null |
| `calls` | 它的调用按状态计数（`total`、`queued`、`running`、`succeeded`、`failed`、`cancelled`），加上报出的输入、输出 token 合计 |
| `nextCall` | 它排队的调用里队列最先轮到的那个：`{ ahead, enqueuedAt }`；没有排队的为 null |
| `requests` | 按 `enqueued_at` 最新的 `limits.callsPerJob` = 40 个调用，旧的在前；没列出的由 `calls.total` 计着 |

- 每个调用只有元数据：`id`、`step`、`unit`、`attempt`、`attempts`、`state`、`enqueuedAt`、`startedAt`、`endedAt`、`inputTokens`、
  `outputTokens`、`httpStatus`、`error`、`errorKind`，排队时再加 `ahead`——部署里按队列的领取顺序（`priority DESC, enqueued_at, id`）
  排在它前面的排队请求数，不论是谁的。排队时长从 `enqueuedAt` 到 `startedAt`（排队中到现在），耗时从 `startedAt` 到 `endedAt`
  （执行中到现在）；`startedAt` 是第一次领取的，所以重试花的时间算在这个调用自己身上。
- **不出这条读的**：调用本身（system prompt、prompt、`max_tokens`）、`request_sha256`、`answer` 和 `partial`；两张表的租约列；作业的
  `input` 和 `report`；队列里排在前面的是谁；System model 的地址和 key——两张表的任何一行都不含它们（§23.3：队列的错误消息不写
  key、地址和主机名）。

## 25. 模型请求队列 `wiki_model_request`（服务端执行 P1b）

JSON 里是 `modelQueue` 一节；设计见 `docs/wiki-server-execution-design.md` §5.2、§5.4、§5.5、§6。迁移 `0401_wiki_job`；实现在
`src/apiserver/src/wiki-worker/`（表访问与领取 `wiki-model-queue.ts`、调度与执行循环 `wiki-model-queue.service.ts`、`pg_notify` 监听
`wiki-model-notify.ts`）；共享常量在 `src/shared/src/wikiJobs.ts`。

### 25.1 表与身份

- `wiki_model_request`：`id`、`job_id`（外键到 `wiki_job`，随作业删除而删）、`owner_id`、`space_id`、`step`、`unit`、`attempt`、
  `attempts`、`priority`、`request`（`{ system, prompt, maxTokens }`）与 `request_sha256`、`state`、租约三列、`enqueued_at`、
  `not_before`、`started_at`、`ended_at`、`answer`、`partial`、`input_tokens`、`output_tokens`、`http_status`、`error`、`error_kind`。
- `(job_id, step, unit, attempt)` 唯一，`(step, unit)` 是这次调用在作业里的地址；`attempt` 是这一单元的第几次（真重做才 +1），
  `attempts` 是这一行被跑过几次（租约过期和可重试失败各记一次，退避读它）。
- `state`：`queued` / `running` / `succeeded` / `failed` / `cancelled`；`error_kind`：`retryable` / `unauthorized` / `other`。
- CHECK：租约三列与 `running` 互为条件；`succeeded` 当且仅当有 `answer` 和 `ended_at`；`partial` 只在非 `cancelled` 的行上。

### 25.2 全局并发与公平（`modelQueue.concurrency`）

- `ORBIT_WIKI_MODEL_CONCURRENCY`（默认 4）是整个部署在途请求的上限，与有几个 worker 无关。
- 调度器在一个事务里领取（`claimWikiModelRequests`）：先 `pg_advisory_xact_lock` 拿全队列一把锁；数出 `state = 'running' AND
  lease_deadline_at > now()` 的行数 r；只领 `N − r` 条（哪次领取都不会越过上限）；候选按 `priority DESC, enqueued_at, id`，
  `FOR UPDATE SKIP LOCKED`，每条给一个新的 `lease_generation`。
- 同一优先级先来先得；每个作业最多 `maxInFlightPerJob` = 4 条在途，避免一个作业占满队列。

### 25.3 请求即断点

- 流水线对 `(step, unit)` 只发一次：重发同一次调用会「撞上」那一行（`enqueueWikiModelRequest` 的 `ON CONFLICT` 返回已有行的 id），
  再等它（`WikiModelRequestQueue.whenSettled`）——已成功的直接用它的答案，还在排队或执行中的继续等。作业被回收后重跑，已经答过的
  调用不会再发一次。
- 同一单元带着不同的调用再次出现（`request_sha256` 不同）是错误：答案不是这次问的问题，作业按 content 失败。

### 25.4 执行与租约（`modelQueue.lease`）

- 领取时 `lease_deadline_at = now + 60s`；执行中每 20 秒续租；每 5 秒把目前收到的文本写回 `partial`（只有变长了才写）。
- 结束按代数比较并交换：成功写 `answer` 和两组 token（`state = 'succeeded'`）；失败按类处理（§25.5）。被接管后迟到的写不进任何一行，
  接管者重发这次调用。
- 租约过期的 `running` 行回到 `queued`，`attempts + 1`，**保留 partial**；下一次领取带着已经收到的部分重发。

### 25.5 失败、退避与等待上限

| 情况 | 处理 |
| --- | --- |
| `retryable`（5xx、429、连接失败、空闲断开、流提前结束）| 回到 `queued`，`attempts + 1`，`not_before = now + backoffSeconds[attempts]`（0 / 10 / 30 秒；`attempts` 是这次失败之前已有的次数）|
| `unauthorized`（401、authentication_error）| 回到 `queued`（等部署方改 key，不是这条请求的错），并把拒绝报给状态探测：状态转 `auth_failed`，队列停领（§25.6）|
| `other`（预算用完、不是事件流、其它错误）| 结束：`state = 'failed'`、`error_kind = 'other'`；作业读到后按 content 处理 |

- 等待上限（`waitLimit`，从 `enqueued_at` 起算，重试不重新计时）：`extract*` / `docs*` 180 秒、`import*` 600 秒、`plan*` 1200 秒，
  其余 900 秒。排队超过它的请求以 `other` 失败，错误文案以「the request waited past its step's limit」开头；作业读到这个前缀就按
  infra 失败处理（稍后重试），所以模型长时间不在时是以一次失败的作业收场，而不是永远挂着。
- 单次调用的预算（`callBudget`，设计 §6）：`docs*` 20 分钟、`plan*` 60 分钟，其余 15 分钟；另加合同里的空闲断开。

### 25.6 暂停与恢复

- 每一轮领取前读一次 `wiki_model_status`（§23.4）：状态不是 `up` 就不领——`down` 和 `auth_failed` 期间请求留在队列里不动。
- `down` 会自愈：探测继续，下一次 `up` 之后的领取自动继续；`auth_failed` 保持到 worker 重启（那时才读到改好的 key）。

### 25.7 停机与唤醒

- SIGTERM：停止领取；取消在途的调用，每个把已收到的文本写进 `partial`、把租约截止时间设为现在，让新进程的回收立刻接手并带着 partial
  重发（方案 A，不等在途请求）。
- 结束的请求用 `pg_notify` 在 `wiki_model_request` 频道上广播自己的 id；worker 用一条专用的 LISTEN 连接（照
  `realtime/realtime.service.ts`）唤醒等待的作业，另有 2 秒一次的轮询兜底——通知丢了只丢延迟，不丢答案。

### 25.8 `/api/metrics`（`modelQueue.metrics`）

| 序列 | 类型 | 说明 |
|---|---|---|
| `orbit_wiki_model_calls_total{outcome}` | counter | 按行的现状读：成功行是 `succeeded`，失败行是它 `error_kind` 的类，失败后重排队的行在成功或超限之前算在失败的那一类 |
| `orbit_wiki_model_call_duration_seconds` | summary | 结束的行从 `started_at` 到 `ended_at` 的耗时（0.5 / 0.95 分位、sum、count）|
| `orbit_wiki_model_queue_depth` | gauge | 排队中的请求数 |
| `orbit_wiki_model_requests_in_flight` | gauge | 当下在途（租约未过期）的请求数，不会超过并发上限 |
| `orbit_wiki_model_request_wait_seconds` | summary | 结束的行从 `enqueued_at` 到 `started_at` 的排队时长 |
| `orbit_wiki_model_request_run_seconds` | summary | 结束的行从 `started_at` 到 `ended_at` 的执行时长 |
| `orbit_wiki_model_request_tokens_total{direction}` | counter | 成功调用花掉的 token（input / output）|
| `orbit_wiki_model_request_errors_total{status}` | counter | 失败的调用按 HTTP 状态分；没有回答的失败（连接、超时）是 `none` |

- 与 §23.6 同理：全部在读 metrics 时从库里取，每个副本一致；标签值来自闭集，状态标签是行里的状态码（这条序列本来就是讲状态码的）。

## 26. 仓库操作 `wiki_repo_op`、快照缓存与原文缓存（服务端执行 P2）

JSON 里是 `repoOps` 一节；设计见 `docs/wiki-server-execution-design.md` §4.3 和 §7。迁移 `0402_wiki_repo_op`（操作、分片暂存与快照缓存）
和 `0406_wiki_repo_file`（按 (space, sha, path) 保存读到的原文）；服务端实现在
`src/apiserver/src/wiki-worker/`（表、领取、结算、快照与原文缓存 `wiki-repo-ops.ts`、`pg_notify` 监听 `wiki-repo-op-notify.ts`、
两个通道共用的 LISTEN 连接 `wiki-notify-channel.ts`），runner 侧在 `src/runner-go/wiki_repo_ops.go`（四种操作复用
`wiki_plan_repo.go` 的索引和 `wiki_anchors.go` 的锚点检查）；共享常量在 `src/shared/src/wikiRepoOps.ts`。

### 26.1 表与状态

- `wiki_repo_op`：`id`、`job_id`（复合外键到 `wiki_job`，作业删掉它也跟着删）、`owner_id`、`space_id`（复合外键到 `wiki_space`）、
  `workspace_id`（复合外键到 `workspace`：读的是它的 `work_dir`，路由按它的 `runner_id`）、`runner_id`（领取时写入，接管时刷新）、
  `kind`、`input`（JSONB，从不含地址和 key）、`state`、租约四列（`lease_owner` / `claim_generation` / `claimed_at` / `heartbeat_at`）、
  `result`、`error`、`created_at` / `updated_at` / `ended_at`。
- `state`：`queued` / `running` / `succeeded` / `failed` / `cancelled`；`kind`：`snapshot` / `read` / `diff` / `anchors`。
- CHECK：租约三列（owner、claimed_at、heartbeat_at）与 `running` 互为条件；只有结束态有 `ended_at`；`succeeded` 没有 `error`；
  `input` / `result` 是对象。
- 领取**不占槽位**：仓库操作不是任务也不是会话，`runnerActiveTurns`（runner 上 RUNNING 的会话数）在领取前后不变
  （`wiki-repo-ops.pg.spec.ts` 断言）。

### 26.2 下发：心跳与路由

- 能力 `wiki-repo-op/v1`（`src/runner-go/transport.go` 声明，服务端 `WIKI_REPO_OP_CAPABILITY`）。没有声明它的 runner 什么都拿不到：
  操作留在队列里，等它的步骤挂起，健康行说「升级 runner」（§26.6）。没有 `leaseOwner`、正在 drain 的进程同样什么都拿不到——
  这不是错误，是一台机器普通的状态。
- 第二个能力 `wiki-repo-op-read/v1`（`WIKI_REPO_OP_READ_CAPABILITY`，owner 2026-10-08）：声明了它的 runner，`read` 回答的是指定 sha 上的
  整个文件。只声明 `wiki-repo-op/v1` 的 runner 照旧能领到操作，只是 `read` 只给每个文件的前 `boundedChars`（22,000）字——服务端照旧处理，
  健康行给出同一个「升级 runner」的原因（§26.6）。
- 领取照集成作业：一条 `UPDATE "wiki_repo_op" … FROM (SELECT … JOIN workspace w ON w.id = o.workspace_id
  WHERE w.runner_id = <本机> AND (state = 'queued' OR (state = 'running' AND heartbeat_at < now - 60s AND lease_owner <> <本进程>))
  ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)`，每条给一个新代数。**每次心跳最多 2 个**，两个 apiserver 同时心跳时
  在 `SKIP LOCKED` 上错开，而不是互相等待。
- 按 `workspace.runner_id` 路由，`work_dir` 与空间记录的 `repo_url_norm`、`root_commit_sha` 一起下发：runner 读的是自己的
  checkout，检查也是在自己的 checkout 上做的。
- 入队时 `notifyRunnerWake`（与集成作业同一条通道，事务内发出、提交时投递），机器立刻心跳一次，而不是等 30 秒。

### 26.3 回写：三条路由与租约代数

| 路由 | 作用 |
|---|---|
| `POST /runner/wiki/repo-ops/:id/progress` | 续租：`heartbeat_at` 只在 `(runner_id, lease_owner, claim_generation)` 还对得上、且仍在 `running` 时写入 |
| `POST /runner/wiki/repo-ops/:id/fragments` | 分片上传：一片一次调用，同一把租约锁；按 `(op_id, ordinal)` 幂等，重发一片就是同一片 |
| `POST /runner/wiki/repo-ops/:id/result` | 结算：先按代数比较并交换（`updateMany` 的谓词就是租约），再写结果与快照缓存 |

- 过期的回写（换过 owner、换过代数、换过 runner，或行已终结）得到 **409 `STALE_CLAIM`**，什么都不写；结果重复到达（回包丢了）
  不算错误，回答行里已有的状态。没有这条操作的账号得到 404。
- 结算与它引发的一切在同一个事务里：快照的载荷变成空间的那一份、暂存分片删掉、`pg_notify` 发出。读者看不到「已结算但字节不齐」。

### 26.4 分片上传、快照缓存与原文缓存

- API 的请求体上限 10 MB（`src/apiserver/src/main.ts`），所以一份回答大于 `inlineBytes`（4 MiB）时走分片：每片不超过
  `fragmentBytes`（2 MiB），按 3 MiB 的整数倍切字符（不会把一个字符切成两半）；服务端按 ordinal 拼回、按 sha256 和字节数与结果
  对照，全部通过才落库。整份上限 `maxSnapshotBytes`（64 MiB）。**快照的索引和 `read` 的回答用同一套**：读很多文件时整份回答可能
  超过一个请求体，就以同样的方式分片上传和拼回。
- 缓存 `wiki_repo_snapshot`（每空间一行：`sha`、`digest`、`size_bytes`、`fragment_count`）与它保存载荷的
  `wiki_repo_snapshot_fragment`（按 ordinal）。**每个空间只留最近一份**：新的整份替换旧的，外键把旧的分片一起带走；空间删除时
  随复合外键一起删。没有路由返回它的内容，只对 owner 可见（设计 §9），发给模型前过共享脱敏器。
- 缓存 `wiki_repo_file`（`0406`）：一行一个 `(space, sha, path)`——`state`（`found` / `cut` / `missing` / `too_large`）、`content`（`found`
  和 `cut` 时的原文，至多一个文件的上限）、`size_bytes`（该 sha 上文件的大小）。**同一份原文只从 runner 读一次**：命中缓存就不再下发
  `read`。新的快照落地时，这个空间只留它那个 sha 的行（和快照一起换代）；空间删除时随复合外键一起删。`cut` 是只声明了
  `wiki-repo-op/v1` 的 runner 给的窗口：读旧路径的调用者能用，声明了整文件能力的调用者按未命中重新读。
- 上传途中死掉的进程不会破坏缓存：分片先落在 `wiki_repo_op_fragment`（挂在操作上，随操作删），只有结算那一刻才写缓存。

### 26.5 读取：指定 sha 上的整个文件（owner 2026-10-08）

- 一项（`read` 的一个 item）：不给上限时回答的是**该 sha 上的整个文件**。单个文件上限 `wholeFileBytes`（2 MiB）；更大的文件不截断，
  而是「缺失并注明原因」：`found: false`、`reason: "too_large"` 和它的大小，服务端照缺失处理。
- 一次请求：不再有「一节材料」的读取上限。服务端按快照给出的大小打包（`operationBytes`，4 MiB 一份），一份回答超过 `inlineBytes`
  就分片（§26.4）。runner 只对声明了 `wiki-repo-op-read/v1` 的调用者这么回答。
- 只声明 `wiki-repo-op/v1` 的 runner：一项最多 `boundedChars`（22,000 字），整份回答不超过 `sectionChars`（22,000 字），超出的截断并标
  `truncated`；服务端照旧处理（截断按缺失并写明），健康行给出升级原因。
- **每节材料的切取上限**（文档一节 `docSectionChars` 4,200 字、合同 `contractChars` 2,500 字、一节材料 `sectionChars` 22,000 字）仍然是
  服务端切取材料时的规则：plan 和文档构建照旧按这些数字给模型材料，它们不再是读取的上限。
- 带 `section` 的 item 仍然可以要一节：它按一节回答，缓存里记作 `cut`（不是整个文件）。

### 26.6 等待：pg_notify 与健康行

- 作业要用仓库时 `waitForWikiRepoOpAsJob`：作业先落到 `waiting` / `waiting_for = 'repo'`，**交出租约**（等的是别的东西，
  就不该占着租约）；操作结算的通知（`wiki_repo_op` 通道）一到就把它放回 `queued`，领取用新代数接手，流水线从头重放，答案已经在缓存里。
  等待本身超时（或 worker 停机）是 infra 失败：作业回 `queued`、`attempts + 1`、`failure_kind = 'infra'`、理由写在行上；
  操作留在队列里给下一次尝试。轮询是兜底，不是主路径。worker 停机时等待立即结束（`WikiRepoOpWaitCancelled`），不再空转到超时。
- 导入的快照是例外（§5.1、契约 `import.server.snapshot`）：持着租约有上限地等，等不到就用 space 已有的快照或不带锚点，
  所以 runner 不在时，导入只是少了新快照，不会卡住。
- 健康行新增 `wikiRepo`：`GET /api/wiki/spaces/:id/health` 的回答多一个 `repo` 字段（`look` / `workspace` / `runner` / `pending`），
  `look` 取 `ready` / `no_workspace` / `runner_missing` / `runner_offline` / `runner_upgrade`。`runner_upgrade` 就是「升级 runner」，它盖两种
  机器：没有声明 `wiki-repo-op/v1` 的（什么都领不到，需要仓库的步骤会挂起），和只声明了它、没有声明 `wiki-repo-op-read/v1` 的
  （照旧只读到 22,000 字）。`runner` 字段里的 `capability` 和 `wholeFile` 把这两者分开：前者说这台机器能不能领，后者说它读不读整个文件。

## 27. 服务端执行的维护运行：`maintain` 作业（服务端执行 P8）

JSON 里是 `maintenance.job.server` 和 `jobs.kindRuns.maintain`；迁移 `0407_wiki_maintain_job`；设计见
`docs/wiki-server-execution-design.md` §5、§5.5 和 §8。服务端实现在 `src/apiserver/src/wiki-worker/`：
`wiki-maintain.ts`（抽取的提示词、离题判定、逐条检查、引文定位、重问、分批与熔断的算术）、
`wiki-maintain-plan.ts`（一次 plan 修改建议：提示词、解析、按快照检查）、`wiki-maintain-job.ts`（整条流水线）；
触发与运行行的收尾在 `src/apiserver/src/wiki/wiki-maintenance-run.ts`；runner 侧同一套逻辑在 `wiki_maintain.go` 与
`wiki_maintain_docs.go`，P10 之前两条路并存。

### 27.1 触发：建作业，不建任务

- `ORBIT_WIKI_EXECUTOR` 给这个账号服务端执行时（`server`，或 `canary` 名单内），`considerWikiMaintenance` 的判定读法一字不变
  （到期、当日次数、队列余量、期望位置），写入换成 `MaintenanceJobWriter.makeJob`：一个 `wiki_job`（`kind = maintain`，
  `input = { runId }`，优先级 0）和它名下的 `wiki_maintenance_run` 行（`job_id` 写在同一事务里，
  `wiki_maintenance_run_maker_chk` 要求每行恰好一个建者），**不建任务、不建会话**。空间行 `FOR NO KEY UPDATE` 是它的锁：
  两个事实同时到达只建一个作业，进行中的作业像未结束的任务一样挡住下一次（`unfinished`），排队的 plan 作业照旧先走。
- 服务端这条路上隐藏列表不是必需的：`settings.maintenance.enabled` 与 `workspaceId` 就够。列表存在时，死在里面的维护任务照旧先被
  重跑或收尾（§19.7）。
- 当日计数、追赶与熔断都按运行行统计：`wikiMaintenanceRunsToday` 的 `byJob` 分支数 `job_id` 非空的运行行（不再要求有列表），
  追赶期本地端点不计数的判定改看运行行上的 `local_endpoint`——worker 起跑时按 System model 的地址写入，
  apiserver 不读、也不校验任何 provider。
- 打开维护（PATCH 空间设置）在服务端执行的账号上不校验 provider（`checkWikiMaintenanceInput`、`setWikiMaintenance`）：
  一个没有任何 provider 行的账号也能打开维护并跑通一次运行。runner 模式下这段校验逐字不变。

### 27.2 运行的身份：作业，而不是会话

- 运行没有会话，所以**运行就是它的 `wiki_job`**：`wiki_changeset.job_id`（0407）记下它，熔断按它统计本次运行此前的改动
  （`wikiMaintenanceRunChanges`），核实列表按它找自己的 op（`proposerScope`），plan 修改建议的 `author_job_id` 也写它
  （`author_session_id` 为空，`wiki_plan_proposal_author_chk` 要求恰好一个作者）。写入的 principal 是 origin `maintenance`、
  无会话、无 user（与文档构建作业相同）。
- runner 门不再把运行的模型工作交给会话：`GET …/maintenance/run`、`GET …/spaces/:id/dossiers`、
  `POST …/maintenance/changesets`、`GET`/`POST …/maintenance/verifications`、`POST …/maintenance/advance`、
  `POST …/maintenance/finish` 在服务端执行的账号上回 **409 `WIKI_SERVER_EXECUTES`**（`RunnerWikiMaintainController`、
  `RunnerWikiMaintenanceController`）；`GET …/maintenance/check` 不在其中——它是验收命令的只读调用。runner 模式下两个门都不变。

### 27.3 流水线：与 `orbit wiki maintain` 同序

1. **仓库**：一次 `snapshot` 仓库操作拿到 origin/main 的 sha 与索引（路径与大小、文档标题与章节、符号、契约、可达提交、
   README 首段）；锚点查快照，不再有 checkout。
2. **案卷**：`WikiMaintenance.dossierPage` 同一条服务端读法，从游标读到运行期望的位置；已处理过的（`unchanged`）跳过。
3. **抽取**：每个案卷一个请求（step `extract`，unit 是案卷的 session id），同一作业最多
   `maintenance.job.rules.extractConcurrency` 个在途；离题回 `{"offTopic": true}`；每条按案卷的行与 spans 检查字段与引文、
   按快照检查锚点、按 `WIKI_MAINTAIN_JOB.planMaxTokens` 之外的同一条提示词重问一次（unit 加 `#retry`，拒绝原因写进提示词）。
   引文的定位与 runner 逐字一致（`wikiMaintainPlain` / `wikiMaintainPlace`）。
4. **自查与熔断**：按主题分组，每批最多 `limits.opsPerChangeset`（Manual 空间 `limits.opsPerTurn`）；先 dry run，
   服务端找不到的引文从来源上摘掉再查一次，仍被拒的丢掉，被审阅队列挡下的不提交；熔断按 dry run 的回答把整页整页挡回，
   游标停在那一页的起点。
5. **提交**：每批用 `wiki-maintain-<runId>-<ops 摘要>` 的幂等键提交 changeset（origin maintenance，挂在作业上）；
   dry run 通过而此刻被拒的 op 让这次运行失败。
6. **推进游标**：op 记下后立刻 `advanceRecorded`（判据 3 第 4 版）：成功推进不再动它，之后任何一步失败仍以 failed 结束，
   游标留在原处。
7. **核实**：用 P3 的 `verifyWikiOps`，自己的 op 核两遍（第二次带上被拒原因），再收养最多
   `rules.adoptOpsMax` 个等待中的 op；没有结论的 op 不上线、留给下一次运行，不算失败。
8. **锚点**：一页一页取 `listWikiAnchorsForJob`，把这一页的锚点作为一次 `anchors` 仓库操作交给空间所在的 runner，
   结果按现有写入口 `recordAnchorChecks` 写回（锚点状态、挑战 op）。
9. **文档**（追赶期整步跳过）：`wikiDocsAffected` 拿服务端那一半；仓库那一半用 `diff` 仓库操作按节自己的 `repoSha`
   比到 head（消失的路径先撤回，`withdrawPaths`），只重写受影响的节（P7 的 `runWikiDocsBuild`，`only` 传入本次要写的节）；
   新增的设计文档（`--diff-filter=AR -- docs/`，去掉 `docs/mocks/` 与 `docs/evidence/`、已被引用或已被建议的）算出标题、
   章节与开头；最后提一次 plan 修改建议，用 P6 的门（`proposeServer`）检查，最多三轮把门报的错回给模型。
10. **结束**：写报告与 token 合计，`finishWikiMaintenanceJob` 推进游标、写运行行、按 owner 2026-10-08 的决定调用
    `queueWikiArticlesAfterRun`——只有成功、记下了 op、且不在追赶期才排文章作业（§24）。

### 27.4 失败与恢复（设计 §5.5）

- **infra**：runner 不在或太旧、仓库操作超时、请求等过上限、worker 停机。运行行不结束，作业回 `queued` 按退避重试，
  **不计入连续失败**（`consecutive_failures` 不动）。
- **content**：模型给不出可用的答案、dry run 通过却被服务端拒绝、某一步自己的错误。运行以 failed 结束：
  游标按规则不动，`consecutive_failures` 加一，连续三次通知 owner；作业以 `failure_kind = content` 结束。
- **worker 停机**：模型请求与仓库等待被中止（`WikiModelWaitCancelled` / `WikiRepoOpWaitCancelled`），运行不结算，
  租约交回，下一个进程重放；已经答过的请求直接复用。
