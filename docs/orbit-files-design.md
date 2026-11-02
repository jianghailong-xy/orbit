# Orbit Files：证据文件不再进仓库（设计稿）

> 状态：已定稿。所有者 2026-11-02「按建议」两次：先定了五项默认（自托管默认存本地卷；被取代的证据 30 天、探针和临时输出 14 天后过期；先做显式上传；提交闸门先拦再问；设计稿批准先做提示），再把第 6 节四项都定为 A。本稿覆盖第一、二阶段（M1 存储、M2 证据引用），实现见项目 34qIISTdcSurVokwRlp4w。
> 起因：2026-11-02 的仓库体积分析。GitHub 显示 1.91 GiB，历史里 96% 是证据、设计稿和 CI 截图，代码和文档不到 4%。
> 效果图：`docs/mocks/orbit-files/`（`1-today.png` … `5-landing.png`）。代码基线：main `01d68ff4a`，下文行号都指这一版。

## 0. 一页结论

- **现状**：证据只能引用工具调用、commit 和 checkpoint 包，没有地方放文件。agent 只好把截图、测试报告、日志提交进 `docs/evidence/`，再引用那个 commit。判定的人（协调者或你）要么去另一台 runner 上读那个 commit，要么去 GitHub 看图。
- **建议**：把现有的附件升级成 **Orbit Files**。字节按 sha256 存进存储后端（自托管默认本地卷），Postgres 只放元数据。证据新增 `FILE` 引用，保存时把 sha256 记进证据摘要。证据卡片直接显示缩略图和测试摘要，判定者按需把文件取到自己的 uploads 目录。
- **你这边**：证据卡片在判定标准下面多一块文件区（一行缩略图、一行测试摘要），点开是全部文件和大图。
- **agent 这边**：用 `file_upload` 上传，证据里写 `{"kind": "FILE", "ref": "<id>"}`；日志照旧引用工具调用。
- **不变**：`orbit-attachment:` 链接、对话里的图片、你上传的文件、任务附件、分享链接照旧可用；已有证据里的 COMMIT 引用照旧有效；不改写 git 历史。

## 1. 现状

### 1.1 数字（2026-11-02，本机实测）

| | HEAD 树 | 历史（压缩后） |
|---|---|---|
| `docs/evidence` | 1,098 MiB / 21,729 个文件 | 1,013 MiB（其中 471 MiB 已从 HEAD 删除） |
| `docs/mocks` | 529 MiB / 1,624 个文件 | 626 MiB |
| `probe/*` 分支上的 CI 截图 | — | 273 MiB |
| 其余（源码、配置、文档） | 116 MiB / 6,549 个文件 | 78 MiB |

- 近 30 天新增了 109 个证据目录（一共 113 个）。每个目录的中位数是 33 个文件、8 张截图、1.7 MiB；p90 是 142 个文件、33 张截图、7.8 MiB。
- 证据按类型分：图片 56%，JSON 报告和数据 30%，日志和文本 11%，压缩包 3%。
- 证据和设计稿里超过 5 MB 的文件只有 4 个；1 MB 以下的 23,137 个文件合计约 1.2 GiB。问题出在数量，不在大文件。
- 最近三周，每周进仓库的产物分别是 118、133、212 MiB，代码是每周 4–22 MiB。
- 本机 264 个 worktree 里，`docs/` 共占 267 GiB；根盘已用 93%，其中 218 GiB 是这些 `docs/`。

### 1.2 为什么证据进了仓库

1. **证据引用只有三种**：`TOOL_CALL`、`COMMIT`、`ARTIFACT`（`src/apiserver/src/tasks/task-evidence-envelope.ts:37`）。其中 `ARTIFACT` 指 checkpoint 的 `GIT_BUNDLE`（`src/apiserver/src/projects/task-checkpoint.ts:40`），是用来恢复代码的。截图和报告只能放进 commit。
2. **判定者拿不到别的会话的文件**：runner 取附件只认本会话（`src/apiserver/src/runner-api/runner-api.controller.ts:4640`，`where: { id: attId, sessionId }`）。协调者判证据时，和执行会话唯一共享的东西就是仓库。
3. **卡片上没有放图的地方**：证据卡片把引用汇总成一行「N checked for you」（`src/web/src/components/EvidenceDecisionCard.tsx:165`、`src/macos/OrbitKit/Sources/OrbitKit/App/EvidenceDecision.swift`）。要看图，只能去 GitHub。
4. **回合结束会提交一切**：`git add -A` 会把工作区里没被忽略的文件全部带走，`src/runner-go/agent_instructions.go:119` 那段指引写明了这一点。
5. **附件扛不住这个量**：附件字节存在 Postgres bytea 里（`src/apiserver/prisma/schema.prisma:2825`），单文件上限 25 MiB（`src/apiserver/src/attachments/attachments.media.ts:9`），上传时整份读进内存（`src/apiserver/src/attachments/attachments.controller.ts:32`）。照每周 100–200 MiB 的增长全放进 Postgres，备份和 vacuum 都会被拖累。

### 1.3 已经有、可以直接用的

- **链接**：runner 会把回复里的本地图片上传，改写成 `orbit-attachment:<id>`（`src/runner-go/codex_artifacts.go:63`）。web、Apple、Android 都会渲染这种链接。
- **上传和下载接口**：`POST /runner/sessions/:id/attachments`（`runner-api.controller.ts:4659`）和 `GET /runner/sessions/:id/attachments/:attId`（`:4632`）；runner 一侧是 `uploadSessionAttachment`（`src/runner-go/transport.go:1047`）。
- **工作区外的目录**：每个会话都有一个 uploads 目录，在 worktree 之外（`src/runner-go/worktree.go:448`、`src/runner-go/session.go:3271`），放进去的文件不会被提交。
- **分享**：分享链接已经能带附件（`GET /shared/:token/attachments/:id`）。
- **租户隔离测试**：每条附件路由都在隔离用例表里（`src/apiserver/src/auth/tenant-isolation-cases.ts:241`）。

## 2. 建议：Orbit Files

### 2.1 一个对象，两层存储

- **引用行**沿用 `attachment` 表，记录：属于谁、挂在哪里（会话、轮次、任务，新增证据版本和文件夹包）、文件名、类型、大小。新增 `sha256`、`retention`（保留级别）、`expiresAt`、`expiredAt`、`pinnedAt` 几列。
- **字节**放进新表 `file_blob`，同样内容按 sha256 只存一份。本地卷上的路径是 `files/<sha256 前 2 位>/<sha256>`，也可以用 S3 兼容存储。Postgres 不再存字节。
- **去重**：同样的字节只存一次。任务附件每次派发时只复制引用行；今天会把字节整行复制一份（`src/apiserver/src/tasks/tasks.service.ts:13111`）。
- **迁移旧附件**：后台分批进行：读 bytea → 算 sha256 → 写进存储后端 → 清空 `data` 列。迁移期间，读路径两边都认。
- **流式写盘**：上传先写到临时文件，边写边算 sha256；写完改名到正式位置，再提交引用行。不再整份读进内存。

### 2.2 文件夹包

- 上传一个目录时生成一个包：一份清单（相对路径 → 文件 id）加上目录里的各个文件。卡片和判定者都能按目录浏览。
- 一组截图矩阵（视口 × 主题）就是一个包，证据里引用包的 id 即可。

### 2.3 给 agent 的接口

- **MCP**：
  - `file_upload`：`path`（文件或目录，解析符号链接后必须在本会话自己的 worktree、uploads 目录或工作目录内；工作目录是 `/` 或包含 home 时不算；`~/.orbit` 下本会话目录以外的路径一律拒绝。回复附件用同一条规则，只差一点：那种工作目录对回复附件仍然算数，`~/.orbit` 照旧拒绝，因为这类会话里引擎本来就读得到，拒绝了普通的回复图片就显示不出来），可选 `taskId`、`label`、`as: "test-report"`。返回 `id`、`sha256`、大小，以及可以直接写进回复的 `orbit-attachment:` 链接。
  - `file_fetch`：给 `id`，把文件下载到本会话的 uploads 目录，返回绝对路径。
  - `file_list`：按任务、会话或证据版本列出文件。
- **CLI**：`orbit file upload|fetch|list`，参数同上。不支持 MCP 的引擎用 CLI。
- **名字不用 artifact**：代码里 artifact 已经有三个意思：证据的 `ARTIFACT`（checkpoint 包）、`artifacts/result`（工作区文件请求）、Codex 上传回复图片用的 `artifactUploader`。
- **agent 指引**（英文，写进给 agent 的说明）：日志引用工具调用；截图和报告用 `file_upload` 上传，证据引用 `FILE`；不要把证据文件写进仓库。

### 2.4 证据引用 `FILE`

- **写法**：`checks: [{ "kind": "FILE", "ref": "<文件或包的 id>" }]`。
- **解析**：按证据格式代码里的规矩，先写解析器再加类型（`task-evidence-envelope.ts:34`）。文件必须属于本人，并且是在本任务的会话里上传的，或者挂在本任务上。如果属于本人的另一个任务，照现有规则直接拒绝。
- **绑定字节**：服务器保存证据时，把每个 `FILE` 的 sha256 写进对应的 check，计入 `evidenceDigest`（`normalizeCompletionEvidence`，`src/apiserver/src/tasks/task-completion-evidence.service.ts:111`）。这样判定之后字节没法被偷换，保证程度和 COMMIT 一样。agent 今天选择提交到 git，正是为了这个保证。
- **引用标签**：`task_evidence_list` 返回的 FILE 引用带标签，显示文件名、大小、类型和图片尺寸；包显示成「9 files · 1.8 MB」。

### 2.5 测试报告

- `file_upload --as test-report` 能识别 Playwright JSON 和 JUnit XML，从中抽出总数、通过、失败、跳过的数量和失败用例名，存成这个文件的摘要。
- 卡片上显示一行「Playwright · 46 passed · 0 failed · 2 skipped」；有失败时，这一行改为列出失败用例名。
- 原始报告照常作为文件保存，跟着证据版本走保留期；摘要是元数据，文件过期后也还在。上次瘦身就是手工做的这件事：把 report.json 换成摘要，删掉了 798 MB 附件正文。

### 2.6 你看到什么（以 iPhone 为例，Mac、Web、Android 结构相同）

- **默认态**：证据卡片在「WHAT IT HAS TO SATISFY」下面加一块文件区。小标题是 `FILES · 9 · 1.8 MB`，下面最多 4 张缩略图，多出来的写「+5」；有测试报告时再加一行灰字摘要。卡片其余部分照旧：缺口、「checked for you」、Confirm done。没有 FILE 引用的证据，卡片和今天完全一样。
- **展开态**：点文件区，弹出「Evidence files」页。最上面是第几版证据、文件数和大小，接着是测试摘要（点开能看失败和跳过的用例），下面是按上传目录分组的缩略图网格，每组标出文件数。点缩略图看大图，左右滑动切换，底部显示文件路径、大小、尺寸和 sha256 的前 8 位，右下角可以存储或分享。
- **过期**：缩略图位置换成灰色占位「Expired Dec 2」，小标题后面加 `EXPIRED DEC 2`；文件名、大小、sha256 和测试摘要都还在。
- 全部使用现有组件：卡片、表单页、灰字层级不变，不新造颜色。

### 2.7 判定者看到什么

- 投递给协调者的那一轮里，逐个列出 FILE 引用：文件名、大小、类型，以及现成的 `file_fetch` 调用。
- 取文件：按需用 `file_fetch` 取到自己的 uploads 目录（在工作区之外，不会被提交），再用自己读图的能力看。
- **新的授权规则**：一个会话可以取某个文件，条件是二选一：文件是本会话上传的；或者文件被某个证据版本引用，而本会话有权判这个任务的证据。今天的规则只有前一半。

### 2.8 保留期（已定：30 天 / 14 天）

| 文件的状态 | 什么时候过期 |
|---|---|
| 用 `file_upload` 上传，还没被证据引用 | 上传 14 天后 |
| 被最新一版证据引用（还没判，或已确认） | 不过期 |
| 那一版被退回，或被新版本取代 | 从那一刻起 30 天后 |
| 任务完成时被确认的那一版 | 任务删除时 |
| 钉住的文件 | 不过期 |
| 对话里的图片、你上传的文件、任务附件 | 照旧，跟会话或任务走 |

- 一个文件被多处引用时，按最晚的那个算。
- 用 `file_upload` 上传、只写进回复、没被证据引用的文件，14 天后在对话里显示过期占位。需要长期保留的，agent 或你可以把它钉住。
- **过期只删字节**：引用行、文件名、大小、sha256 都保留，卡片显示过期占位，证据和判定记录完整。字节在最后一个引用过期、并过了宽限期之后才真正删除（第 6 节第 3 项：宽限 7 天，且不早于 Postgres 备份的保留期）。

### 2.9 权限、分享、敏感内容

- 按租户隔离，沿用附件的 owner 范围；新路由全部加进租户隔离用例表。
- 分享链接按现有的 `commentsAndFiles` 层决定是否带上证据文件。
- `file_upload` 上传的文本类文件（报告、日志）在保存前扫一遍密钥，**只拦高置信度的形状**，也就是发行方给自己的密钥定的格式（`ISSUED_CREDENTIALS`，`src/apiserver/src/common/secret-redaction.ts`）：带密钥正文的 PEM 私钥、JWT、API key（`sk-ant-`、`sk-proj-`、`sk-svcacct-`、`sk-admin-` 加够长的正文，或 `sk-` 加至少 32 位连续的字母数字）、Stripe 线上密钥（`sk_live_`、`rk_live_`），以及 GitHub、AWS、Slack、Google、GitLab、npm 的 token。
- **为什么不用脱敏的全部模式**：脱敏多删一个词，损失的只是那个词；上传被拒，损失的是整个文件。`password|token|secret=`、URL 里的用户名密码、`Bearer`/`Basic`、宽泛的 `sk-…`/`pk-…`/`rk-…` 会拒绝大量普通测试日志，把 agent 逼回往公开仓库提交，那比不扫更糟。2026-11-02 用 `docs/evidence` 里 12,504 个文本文件实测：这四类分别命中 537、82、4、21 个文件，其中宽泛的 `sk-…` 这一类抽查下来全是 `sk-ant-fixture…`、`sk-lab-fake-…` 这样的假值和普通词；高置信度的这份清单命中 0 个。
- **命中时**：这个文件不保存，不留文件也不留行。错误里写文件名、命中的类型和所在行，不回显密钥本身；也不改文件内容：改了就不是 agent 看到的那份，sha256 也对不上。
- **目录上传**：被拒的文件列在 `file_upload` 返回的 `skipped` 里，其余文件照常保存并打包；全部被拒时返回错误，不生成包。这一条在 runner 里实现，需要新版 runner。旧 runner 遇到这种拒绝时停在那个文件，不生成包，错误里带着同样的说明，被拒的文件同样不会保存。
- **文本还是二进制看字节，不看声明的类型**：类型是客户端给的，`.ts` 文件可能被标成视频。前 8000 字节里有 NUL 就算二进制，不扫（和 git 的判断相同），所以 UTF-16 文本目前算二进制。
- **范围和内存**：只管 `file_upload` 这道门，回复里的图片和用户上传的文件走各自的路由，不扫。扫描分块读磁盘上的临时文件，25 MiB 的文件和小文件占一样的内存。
- 比现在好的一点：仓库公开时，进了 `docs/evidence` 的截图和日志对所有人永久公开；放进 Orbit Files 之后，只有你和你分享的人能看到。

### 2.10 部署、备份、用量

- **compose**：apiserver 加一个绑定挂载 `./data/files:/var/lib/orbit/files`，和 Postgres 的 `./data/postgres` 同一个做法。存储后端用 `ORBIT_FILES_BACKEND=local`（默认）或 `s3`；用 S3 时还要配 endpoint、bucket 和 key。
- **备份**：pgbackup 侧车已经把 `./data/pg-archive` 同步到 `ORBIT_BACKUP_SYNC_TARGET`（`docker-compose.yml:147`），把 `./data/files` 也加进去一起同步。文件按 sha256 命名、只增不改，增量同步很便宜。恢复时先恢复 Postgres，再恢复文件；有删字节的宽限期，恢复出来的元数据就找得到对应的字节。
- **用量**：Settings 里显示本账户的存储量、按项目和任务的排行，以及每周增长。自托管默认不设配额；托管实例用环境变量设每个账户的配额，超出时上传返回明确的错误。
- **单文件上限**：沿用 25 MiB（第 6 节第 4 项）。

## 3. 和后面几个阶段的关系

- **M3 提交闸门**：发现疑似产物时先拦下，提示 agent 用 `file_upload`（已定：先拦再问）。
- **M4 设计稿看板**：每一版设计稿是一个文件夹包，建在同一个存储上（已定：批准先做提示）。
- **M5 CI 直连**：CI 用项目级、只能写文件的 token 调同一个上传接口。
- **M6 部分展开的 checkout**：被排除的路径里出现新文件时，把它转成 Orbit Files，顺带解决 `git add -A` 返回 1 的问题（git 2.47.3 实测，提交、finalize、diff 三处都会失败）。
- **M7 迁移助手**：把 `docs/evidence` 导入 Orbit Files，在仓库里留一份路径到文件的索引；测试读取的基线移到 testdata。

## 4. 实现要点

**apiserver**
- schema：`attachment` 加 `sha256`、`retention`、`expiresAt`、`expiredAt`、`pinnedAt`、`bundleId`、`evidenceId`；新表 `file_blob`（sha256 主键、大小、存储位置、最后引用时间）；`data` 列在迁移完后改为可空。
- 文件服务：流式写入（临时文件 → 算 sha256 → 改名 → 提交引用行）和流式读出；本地和 S3 两个后端实现同一个接口。
- runner 接口：上传改为流式；取文件加上 2.7 的授权规则；新增包上传。
- 证据：`EVIDENCE_CHECK_KINDS` 加 `FILE`，`RESOLVERS`（`task-evidence-envelope.ts:326`）加解析器，由 `citationLabel`（`:350`）生成标签；保存时写入 sha256 并计入摘要。
- 测试报告解析：Playwright JSON、JUnit XML。
- 保留清理：定时任务计算到期、打墓碑、过了宽限期再删字节；另外提供用量接口。

**runner**
- MCP 工具和 CLI 子命令：`file_upload`、`file_fetch`、`file_list`；目录打包上传；取到的文件写进 `uploadsDir`。
- 更新 agent 指引（英文）。

**客户端**
- Web `EvidenceDecisionCard.tsx`、Apple `EvidenceDecision.swift`、Android `core/cards/CardModels.kt`：文件区、Evidence files 页、大图、过期占位；Settings 里的存储用量。
- 新文案三端共用一份，沿用现有的文案一致性测试；所有文案用英文（`src/web/src/copyLanguage.test.ts`）。

**测试**
- 新路由加进租户隔离用例；证据只是重新排版时，摘要保持不变；保留期的各种状态转换；备份恢复演练。

## 5. 落地（按代价排）

1. **存储层 + 旧附件迁移**（服务端）：用户看不出变化。先上线，观察迁移和备份是否正常。
2. **agent 接口**（runner + 服务端）：`file_upload`、`file_fetch`、`file_list` 和 agent 指引。
3. **证据 FILE 引用 + 判定者取文件**（服务端 + runner）。
4. **证据卡片**：Web 先做，Apple 和 Android 跟上。
5. **测试报告摘要**（服务端 + 三端各加一行展示）。
6. **保留清理、用量视图、备份同步**（服务端 + compose）。

1–3 做完，agent 就不必再往仓库里放证据；4 做完，你就能在 Orbit 里直接看图。

## 6. 已定（2026-11-02，四项均选 A）

1. **存储对象怎么来**。A（推荐）：升级现有附件，链接继续用 `orbit-attachment:`。B：另建一套文件系统，配新链接。推荐 A：三端已经会渲染这种链接，runner 已经会上传和改写，分享链接和租户隔离测试都已覆盖；选 B 就要把这些全部重做一遍。
2. **判定者怎么拿文件**。A（推荐）：按需用 `file_fetch` 取，投递消息里列出文件和现成的调用。B：投递时自动把全部文件放进判定者的 uploads 目录。推荐 A：p90 的证据有 142 个文件，判定时通常只需要看几张；选 B 每次投递都要搬运全部字节。
3. **到期后什么时候删字节**。A（推荐）：先打墓碑，宽限 7 天后再删，并且不早于 Postgres 备份的保留期。B：到期立即删。推荐 A：恢复备份后，元数据还能找到字节；万一误判过期，也有时间挽回。
4. **单文件上限**。A（推荐）：保持 25 MiB，上传改成流式写盘，以后要调大只改配置。B：现在就提高到 100 MiB 以上，并做分片上传。推荐 A：HEAD 里没有超过 25 MiB 的文件，最大的 trace 包已经改为保存摘要；分片上传等真有需要时再做。
