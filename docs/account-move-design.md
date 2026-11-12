# 把账号从私有部署搬到 orbitd.io（设计稿）

> 状态：已定，2026-11-12。owner 定 §9 的 D1–D7 全部按推荐（A），并追加一条约束：**orbitd.io 不允许把数据搬到外部站点**（§2.4、D8）。本文只做设计，不改代码。
> 效果图：`docs/mocks/account-move/01-board.html` 与 `01-board-1.png` … `01-board-6.png`。
> 相关：`self-hosting.md`、`postgres-backup-restore.md`、`public-id-migration-design.md`、`runner-link-design.md`、
> `runner-update-drain-design.md`。

## 0. 一页结论

一个私有部署的用户换到 orbitd.io，今天只能带走代码（本来就在自己的 git 里）和 Claude 会话的原始记录（`orbit session
import`）。任务、项目、证据、wiki、附件、会话事件都留在旧库里。本文给出一个**按账号整体搬家**的功能：

1. **一次搬一个账号，原样保留 id。** 主键全是 UUIDv7，两个库合并不会撞号；public id 是 UUID 的 base62，所以
   `orbitd.io/sessions/<id>` 与旧链接只差域名。引用、链接、证据里的 id 全部不用改写，只改写"这个账号是谁"。
2. **旧服务器推，新服务器收。** 用户在 orbitd.io 生成一个搬家码，贴到旧服务器上；旧服务器打包后主动推给
   orbitd.io（只要求旧服务器能出网，私有部署通常只有入网受限）。不能出网的，下载同一个包再手动上传。
3. **新服务器先在临时库里"补齐版本"再合并。** 包里带着来源的迁移列表；orbitd.io 建一个临时库，迁到来源的版本，
   灌入数据，再迁到自己的版本，最后在一个事务里并入正式库。来源不必和 orbitd.io 同版本，只要不比它新。
4. **runner 自己换服务器。** 搬完后旧服务器经 runner 链路告诉每台 runner"去 orbitd.io，这是你的新凭据"，
   runner 改写配置、重连。runner id、工作区、检出目录、会话都不变，进行中的会话在新服务器上接着跑。
5. **旧账号变只读并指路。** 旧服务器上该账号进入"已搬走"状态：只读、所有客户端显示"已搬到 orbitd.io"，
   旧链接跳转到新地址。用户确认无误后可以在旧服务器上删除。
6. **一张表一张表地登记。** 174 张表每张都在一个登记表里写明"搬 / 改写 / 不搬"及理由；新加的表不登记，测试就红。
   这是功能能长期不坏的关键（同 `copyLanguage.test.ts`、`public-id-coverage.spec.ts` 的做法）。

## 1. 现状

| 事实 | 出处 |
|---|---|
| 没有任何账号导出或导入功能；备份恢复只针对整个实例 | `postgres-backup-restore.md` |
| 174 个 Prisma model，515 个迁移 | `src/apiserver/prisma/` |
| 主键 `@default(uuid(7))`；public id = UUID 的 base62，双射 | `src/shared/src/codec.ts` |
| orbitd.io 是一个多用户的单实例；数据按 `ownerId` / `userId` 归属 | `google-sign-in-design.md` §1 |
| 附件按 sha256 内容寻址（`file_blob`），`storage` 为 `local` 或 `s3` | `schema.prisma` `FileBlob` |
| 服务商密钥、账号池登录用实例自己的 `PROVIDER_SECRET_KEY`（AES-256-GCM）加密 | `configuration.md` |
| runner 凭据只存哈希（`runner.token_hash`），服务器地址在 runner 的 `~/.orbit/config.json` | `schema.prisma`、`runner-cli.md` |
| `orbit session import` 能把机器上的 Claude Code 记录重放成一个会话 | `runner-cli.md` |

## 2. 用户侧效果

### 2.1 一次搬家的全过程（效果图 ②③④）

1. **orbitd.io → Settings → Account → Move from another Orbit → Create move code。** 得到一个搬家码
   `orbit-move:` 开头，24 小时有效，只能用一次，只能把数据搬进**当前这个账号**。
2. **旧服务器 → Settings → Account → Move to another Orbit。** 贴入搬家码。旧服务器先连 orbitd.io 核对搬家码，
   然后给出**预览**：
   - 会搬：工作区、会话（含事件）、任务、项目、证据、wiki、附件、标签和文件夹、监视、服务商（含密钥）、
     个人访问令牌，每类给出条数和总大小。
   - 不搬及原因：托管 runner（orbitd.io 有自己的）、飞书应用（要在 orbitd.io 重新接回调，先搬过去但停用）、
     与其他人共享的账号池（其他成员不随你搬）、实例设置（登录方式、邮件）。
   - 正在跑的：N 个会话在跑。可选 "Move when they finish"（默认）或 "Interrupt and move now"。
   - 目标账号已有数据时：显示 "Your orbitd.io account already has 2 workspaces. Moved data is added next to them."
3. **按 Move to orbitd.io。** 进度条分五段：Pausing work → Packing → Sending → Checking on orbitd.io → Switching
   runners。每段有数字（例如 `Sending 2.1 of 4.3 GB`）。网页可以关掉，搬家在服务器上继续，结束后发邮件和推送。
4. **runner 切换。** 在线的 runner 几秒内重连到 orbitd.io；不在线的，下次上线时切换（旧服务器会一直保留这个指令）。
   runner 版本太旧不认识这个指令的，runner 卡片上写出要执行的一行命令。
5. **结束。** 旧服务器上：顶部横幅 "This account moved to orbitd.io on Nov 12. It is read-only here." 和
   "Open orbitd.io"；orbitd.io 上：横幅 "Moved from orbit.example.com · 1,284 sessions, 312 tasks, 6 projects ·
   View report"，报告里逐类对数。

### 2.2 搬完后的各个入口（效果图 ⑤）

| 入口 | 行为 |
|---|---|
| 旧服务器网页 | 账号只读；横幅指向 orbitd.io；`/sessions/<id>` 等页面上有 "Open on orbitd.io" |
| 旧服务器的分享链接 | 302 到 orbitd.io 上同一个 id |
| 手机、Mac 客户端（登录的是旧服务器） | 下次请求得到 `ACCOUNT_MOVED`，弹出 "Your account moved to orbitd.io" 和 "Sign in to orbitd.io"，地址已填好 |
| `orbit` CLI（旧服务器的个人令牌） | 令牌已随账号搬过去；CLI 收到 `ACCOUNT_MOVED` 时改写 `user.json` 的服务器地址并提示一次 |
| runner | 自动改连（§5）；runner 卡片显示 "Moved to orbitd.io" |
| 删除旧数据 | 旧服务器上 "Delete this account's data here"，要求输入账号邮箱确认；不自动删 |

### 2.3 失败时用户看到什么

- 任何一步失败，**两边都不改**：旧账号恢复可写，runner 不切换，orbitd.io 上什么都没有并入。错误写成一句人话加
  一个 "Try again"。
- 搬家码过期或已用：要求在 orbitd.io 重新生成。
- 旧服务器版本比 orbitd.io 新（极少见）：提示等 orbitd.io 升级。
- 超出 orbitd.io 的存储配额：预览阶段就拦下，告诉差多少。

### 2.4 只进不出：orbitd.io 不允许搬走（owner 2026-11-12）

搬家分两个方向，各由一个部署开关控制：

| 开关 | 含义 | 私有部署默认 | orbitd.io |
|---|---|---|---|
| `ORBIT_ACCOUNT_MOVE_OUT` | 本服务器的账号可以搬到别处 | on | **off** |
| `ORBIT_ACCOUNT_MOVE_IN` | 本服务器可以签发搬家码、接收搬来的数据 | off | on |

`MOVE_OUT` 为 off 时，所有搬出入口一起关，不留旁路：

- Settings 里不显示 "Move to another Orbit"，也不显示下载搬家包；
- 导出接口（预览、打包、推送、下载）一律回 403 `ACCOUNT_MOVE_OUT_DISABLED`，`orbit-admin account export` 同样拒绝；
- 搬家码核对接口本来就在接收方，与此无关。

`MOVE_IN` 在私有部署默认关，所以搬家码只能在 orbitd.io 上生成，私有部署之间不会互相搬，除非管理员自己打开。
开关读环境变量，不放进库里的设置：改它要动部署文件，界面上没有人能把它打开。M0 的覆盖测试同时检查：每个导出
路由都过这道开关。

## 3. 架构

```
旧服务器 (self-hosted)                                     orbitd.io
┌───────────────────────────┐   1 verify code     ┌──────────────────────────────┐
│ Settings: Move to …        │ ───────────────────▶│ /api/account-moves/:code     │
│ account-move exporter      │   2 PUT parts (resumable, zstd, sha256)            │
│  - freeze account          │ ───────────────────▶│ move inbox (object store)    │
│  - snapshot (REPEATABLE    │                     │ importer:                     │
│    READ, one tx)           │   3 poll status     │  a staging DB @ source schema │
│  - NDJSON per table + blobs│ ◀───────────────────│  b load rows, migrate to head │
│  - secrets re-sealed       │   4 runner creds    │  c validate + conflicts       │
│ runner handover (link)     │ ◀───────────────────│  d one tx into prod           │
└───────────┬───────────────┘                     └──────────────┬───────────────┘
            │ 5 "move to orbitd.io" + new credential             │ 6 runner reconnects
            ▼                                                     ▼
        runner (same id, same workspaces, same checkouts) ───────────▶
```

### 3.1 包的格式

一个可续传的分块包，同一格式既用于推送也用于下载：

- `manifest.json`：来源地址、来源版本、来源已应用的迁移名列表、账号 id 与邮箱、每张表的行数和 sha256、
  blob 列表与大小、搬家码的 id、导出时刻。
- `tables/<table>.ndjson.zst`：每张登记为"搬"的表一份，按外键顺序。
- `blobs/<sha256>`：附件字节，只含 `file_blob.bytes_deleted_at` 为空的。
- `secrets.sealed`：服务商密钥、账号池登录、账号机密的明文，用搬家码派生的一次性密钥封装（§6）。

### 3.2 导出

1. **冻结。** 该账号停止派发新 turn（按账号的派发暂停），等进行中的 turn 结束或按用户选择打断；写接口对该账号
   返回 `ACCOUNT_MOVING`。冻结有超时，超时自动解冻并报失败。
2. **快照。** 一个 `REPEATABLE READ` 只读事务里按登记表逐表 `COPY (SELECT … WHERE <归属条件>) TO STDOUT`。
3. **核对。** 写 manifest，逐表计数和哈希。

### 3.3 导入（orbitd.io）

1. **补齐版本。** 建临时库，`prisma migrate deploy` 到包里的迁移列表为止（列表必须是 orbitd.io 列表的前缀，
   否则拒绝），`COPY` 灌入，再 `migrate deploy` 到 orbitd.io 的版本。数据迁移因此照常作用在搬来的行上，
   不必为"跨版本导入"另写转换。
2. **改写归属。** 来源账号 id → orbitd.io 当前账号 id（只有这一列在变，所有 `owner_id`、`user_id`、`actor_id`、
   `creator_id`、`imported_by_id` 等按登记表列出的列改写）。其余 id 不变。
3. **冲突检查。** 任何一个主键已存在于正式库即拒绝（UUIDv7 下只会发生在同一个包导入两次，搬家码一次性已防住）；
   同一台机器已在 orbitd.io 注册为另一个 runner 时，预览里提示，导入时合并为一个（§5.3）。
4. **并入。** 一个事务里从临时库 `INSERT … SELECT` 进正式库，blob 先写入对象存储（内容寻址，已存在则跳过）。
5. **回执。** 返回每张表的条数、新 runner 凭据（§5）、报告链接。旧服务器据此进入"已搬走"状态。

## 4. 数据分类（登记表）

每张表标一个类，规则写在代码里，新表不登记测试即红（M0）。

| 类 | 含义 | 表（举例，全表见 M0 的登记文件） |
|---|---|---|
| **搬** | 按归属条件选出，原样写入 | workspace, session, run_event, tool_call, conversation_turn, approval, usage, session_tag(_link), session_folder, share_link, session_merge_receipt, task 全族（task_*，evidence、decision、checkpoint、comment、dependency…）, task_list(_event/_revision), project 全族（project_*）, wiki 全族（wiki_space … wiki_repo_file）, watch 全族, owner_request, attachment, file_blob, agent, workspace_permission_rule, model_provider, provider_pool(只搬本人独有的), activity, user_avatar, personal_access_token, user_identity, session_scheduled_wakeup, session_wakeup_loop, background_job_wake |
| **搬并改写** | 搬，但有列要变 | user（并入目标账号，不新建）, runner（新凭据，§5）, model_provider / account_secret / pool 登录（密钥重新加密，§6）, feishu_app（搬但停用）, share_link（保留 token） |
| **不搬：实例级** | 属于部署而不是账号 | sign_in_provider, email_settings, dispatch_pause, runner_link_switch, feishu_deployment_setting, runner_mass_disconnect, apiserver_process, open_list_epoch, client_version, provider_engine_migration_*, wiki_model_status, executable_runtime_*, managed_runner_capacity |
| **不搬：会话期凭据和临时队列** | 到新服务器重新产生 | refresh_token, oauth_login_flow, pat_device_login, device_token, enrollment_token, service_token, device_enrollment, tenant_cell, runner_presence, runner_link_revocation, inbox_lease_generation, email_outbox, feishu_outbox, feishu_inbound_event, wiki_job / wiki_model_request（目标侧重排维护）, project_integration_job（未完成的在目标侧重新入队） |
| **不搬：资源** | 新服务器有自己的 | managed_runner（托管 runner 的容器在旧部署里） |

**跨账号的行。** 私有部署可能多人共用：账号池（`provider_pool_person`）、项目或会话的访客。规则：只搬归属于搬家
账号的行；指向其他账号的成员关系不搬，预览里列出"这些共享关系不会随你搬走"。整个实例一起搬（每个人各自生成
搬家码）是 D3 的另一个选项。

## 5. runner 交接

### 5.1 流程

1. 导入成功后，orbitd.io 为包里每台 runner 生成一份**新**凭据（旧凭据不搬，见 D4），放在回执里交给旧服务器。
2. 旧服务器把 `{server: "https://orbitd.io", link: "wss://…", token: "<new>"}` 作为一个交接指令，经 runner 链路
   下发（与升级、登录指令走同一条心跳投递）。
3. runner 校验新地址可达、新凭据有效后，原子地改写 `~/.orbit/config.json`，断开旧链路，连上 orbitd.io。
   运行中的进程不重启；进行中的会话按 runner 重连的既有逻辑接着跑。
4. 旧服务器把这台 runner 标为 "Moved to orbitd.io"，作废旧凭据。

### 5.2 不能自动切换的情况

- runner 离线：指令一直保留，上线即执行。
- runner 版本不认识该指令：旧服务器先让它自更新（既有路径），仍不行就在卡片上给出一行命令
  `orbit register --server https://orbitd.io --move-code <code>`，这个码只能认领这一台 runner。
- 托管 runner：不交接，它属于旧部署。

### 5.3 同一台机器已在 orbitd.io 注册过

按 `runner.name`（机器上报的身份，见 schema 注释）匹配到同一台机器时，预览提示；导入时以**搬来的 runner 行**为准
（会话都挂在它上面），把目标侧那台的工作区挪过来，删除目标侧那台的行，并给机器下发一份凭据。

## 6. 安全

- **搬家码** 是 orbitd.io 签发的一次性能力，只授权"把数据并入签发它的那个账号"。它带一个 256 位随机数，
  服务器只存哈希；24 小时过期；导入成功或用户撤销即失效。
- **身份确认。** 旧服务器要求当前登录用户再输一次密码（或重新走 Google 登录）才能开始搬家，避免被盗的会话把数据
  搬给别人。orbitd.io 一侧，搬家码本身就是"目标账号主人同意"的证据。
- **密钥。** 导出时用来源的 `PROVIDER_SECRET_KEY` 解密，再用由搬家码派生（HKDF）的一次性密钥封装；orbitd.io 解封后
  用自己的密钥重新加密。包里没有明文密钥；搬家码不在包里。
- **Orbit 凭据。** runner 凭据、刷新令牌不进包；个人访问令牌只搬哈希（令牌本身从未存过），让脚本改个地址就能用
  （D6 可改）。
- **审计。** 两边各写一条 activity：谁、何时、从哪到哪、每类条数。

## 7. 规模与性能

- 大头是 `run_event`、`tool_call` 和附件。导出用 `COPY` 流式写出，压缩后分块上传（默认 64 MB 一块，可续传）。
- 导入的临时库放在 orbitd.io 的数据盘上，导入后立即删除；并入正式库的事务按表分批 `INSERT … SELECT`，
  单事务时长要在 M6 演练里实测（目标：100 万条事件以内的账号，并入事务 < 60 s）。
- orbitd.io 一次只跑一个导入（队列），不影响正常请求的时延。

## 8. 落地（按依赖排）

| 编号 | 内容 | 验收 |
|---|---|---|
| M0 | 登记表：174 张表逐张分类、归属条件、要改写的列；覆盖测试（新表未登记即红） | 测试在 main 上绿；故意加一张表变红 |
| M1 | 导出：冻结、快照、包格式、manifest 核对；`orbit-admin account export` CLI；`ORBIT_ACCOUNT_MOVE_OUT` 开关 | 真实库上导出一个账号，逐表计数与 SQL 一致；开关为 off 时每个导出路由回 403 |
| M2 | 导入：临时库补版本、改写归属、冲突、并入、回执；`ORBIT_ACCOUNT_MOVE_IN` 开关 | 旧版本（落后 ≥ 20 个迁移）的包并入新库，逐表对数，抽样页面打开正常 |
| M3 | 搬家码、推送通道（可续传）、下载/上传后备、两边的进度与预览界面（web） | 断网续传；搬家码过期、重复使用被拒 |
| M4 | runner 交接指令（runner 发版）+ 旧 runner 的命令后备 | 进行中的 Claude 会话在交接后继续出事件，无丢失 |
| M5 | 旧账号"已搬走"状态：只读、横幅、跳转、`ACCOUNT_MOVED`；iOS / macOS / Android 的提示 | 三端各一次真实登录旧服务器后被引到新服务器 |
| M6 | 端到端演练：旧版本 compose 部署 → orbitd.io 的预发副本，含 2 台 runner、1 个进行中会话、附件、密钥 | 报告对数一致；runner 自动切换；回滚演练（中途失败两边不变） |

## 9. 决定（owner 2026-11-12：D1–D7 取 A，追加 D8）

| # | 问题 | A | B | 推荐 |
|---|---|---|---|---|
| D1 | 数据怎么过去 | 旧服务器用搬家码直接推给 orbitd.io；不能出网时下载包再上传 | 只做下载包、手动上传 | **A**（B 作为后备已包含在 A 里） |
| D2 | 版本不一致 | orbitd.io 用临时库补齐版本后并入，来源只要不比它新 | 要求两边同版本，否则先升级 | **A**（要求用户先升级会卡住大多数人） |
| D3 | 一次搬多少 | 按账号，一人一码；共享关系不随人搬 | 整个实例一次搬，所有账号一起 | **A**（orbitd.io 上账号对应真人，整实例搬没有目标账号可并） |
| D4 | runner 怎么换 | 旧服务器下发新凭据，runner 自动改连，id 不变 | 用户在每台机器上重新注册（`orbit register`） | **A**（B 保留为旧 runner 的后备） |
| D5 | 旧账号搬完怎么办 | 只读 + 指路 + 用户手动删除 | 搬完立即删除 | **A**（给用户核对的余地，且旧链接还能跳转） |
| D6 | 个人访问令牌 | 搬哈希，脚本改地址即可用 | 不搬，到 orbitd.io 重新签发 | **A** |
| D7 | 目标账号已有数据 | 并到一起，预览里说明 | 只允许搬进空账号 | **A**（UUID 不会撞，并到一起没有风险） |
| D8 | 搬出 | — | — | **orbitd.io 只进不出**：`ORBIT_ACCOUNT_MOVE_OUT=off`，见 §2.4 |
