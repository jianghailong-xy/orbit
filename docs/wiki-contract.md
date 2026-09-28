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
| 文章的行为测试 | `src/apiserver/src/wiki/wiki-articles.pg.spec.ts`（服务端），`src/runner-go/wiki_articles_test.go`（`orbit wiki articles`，假 vLLM 端点），`WikiArticlesContractTests.swift`（OrbitKit） |

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
- **校验**（T3）：每个出处都要在本 owner 的行里解析出来，否则 `WIKI_SOURCE_UNRESOLVED`；引文做空白归一化后必须是原文子串，
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

- **出处原文**：提交时的引文校验和核实列表读的是**同一份**原文（`wiki-verify-evidence.ts` 的 `runEventText`）。run_event：
  user / assistant / thinking 取 `text`；tool_use 是工具名加输入（每个键一行）；tool_result 是 `content`（字符串，或各文本块按行拼接，
  图片块没有字），工具报错时前面标一句；error 取 `message`；system 只取它带的文字（`text`、`notice`、`stderr`），`subtype=context`
  这类统计没有原文。空串或只有空白算**读不到**：claude 的 thinking 大多是空串，那是一条没有内容的记录，不是一条「什么都没说」的证据。
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
  正文里带每个 op 的结果；记录了东西的请求回 200。`dryRun` 只校验、照常回答，不记录也不发事件。
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
| `WIKI_SCHEMA` | 400 | op | 形状不对：字段、限制、阶段 3 的 kind、amend 一条 decision、该带或不该带 baseRevision；`errors[]` 列出每个出错字段 |
| `WIKI_KIND_OWNER_ONLY` | 403 | op | 非 owner 对只有 owner 能写的类型 add / amend / supersede |
| `WIKI_SOURCE_UNRESOLVED` | 422 | op | 出处在本 owner 内解析不到、引用了 wiki 条目或视图，或该带出处却没带 |
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
  提示词手写：条目的 kind、标题、摘要、字段，每条出处的原文，以及可被判为重复的条目（op 自己 similar[] 里 active 的，amend 的目标条目）；
  回答必须是一个 JSON 对象 `{"verdict", "reason", "duplicateOf"}`。**读不成结论就不放行**：不回报、计入失败，op 继续等。
  遇到模型端点 401 立即停（真 Claude Code 每次 401 要重试约 3 分钟），space 不再是 Automatic 时停；有 op 没拿到结论就非零退出。
  描述文案把「只核实本会话的 op、绝不手写结论」写成前置条件（`agentSurface.verify.precondition`），逐词测试。
- **`wiki_propose` 的描述**把「这是提议、要等 owner 审」写成前置条件（JSON 的 `agentSurface.proposeDescription`），T5 做逐词测试。
- **用户门** `/api/wiki`（JwtAuthGuard，owner 本人）：spaces 列表与待审数、建 space、改设置（含审阅模式）、绑 workspace、首页、条目列表、主题、
  时间线、owner 的变更集（立即生效，带 CAS）、条目详情、pin / unpin、逐条 Reject 与 Confirm、`GET /api/wiki/search`（⌘K 的独立端点）、Review、
  按 id 读一次运行（`GET /api/wiki/changesets/:id`，§7.6）、decide、整次撤回、重开核实（§7.5）。
- **runner 门** `/api/runner/wiki`（RunnerAuthGuard，外加照 `runner-watches.controller.ts` 校验调用会话）：search（只返回 active 条目，
  外加本会话自己的待审提议；tainted 且没人担保——trust 不是 owner / confirmed——的 active 条目不返回，get 同样 404）、条目、提议、推送块预览；阶段 2 的维护专用路由（dossiers、anchors、anchor-checks、cursor）；
  核实的两条路由 `GET` / `POST /api/runner/wiki/spaces/:id/verifications`（§7.4，只对提交这批 op 的会话）。
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
- verifier、foreman、判断会话推送为 0。每推一条写一行 `wiki_exposure(channel='push')`。

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
  并把 JSON 里的 20 条 `vectors` 逐条跑过校验函数，要求报出的字段路径与向量完全一致。每类条目都至少有一条合法、一条非法向量。
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

- `settings.maintenance = { enabled, workspaceId, provider, dailyRunLimit, listId }`，默认
  `{ false, null, 'local-vllm', 8, null }`。只能经用户门 `PATCH /api/wiki/spaces/:id` 改，带会话头一律 `WIKI_OWNER_CHANNEL_ONLY`；
  runner 门没有改设置的路由。只写 `maintenance` 这一个键，在 SQL 里合并，其他设置的并发写不会互相覆盖。
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
- 到期条件（判据 3，§19.1）：水位之后有事实的会话达到 20 个（设计 §8.2 说的是「20 个会话」，不是 20 条事实），或新事实到达时
  最老的未处理事实已超过 24 小时（`state.due`）。时钟不启动任何工作。

### 16.3 案卷

- `GET /api/runner/wiki/spaces/:id/dossiers?after=<token>&limit=N`：只对该 space 的维护会话开放；headless 回 400，别的会话
  `WIKI_NOT_MAINTENANCE_SESSION`，别的 owner 的 space 是普通 404。页从「after 与水位中较后的那个」之后开始，只取已过 120 秒
  宽限的事实（给事务留提交时间），按顺序取到 N 个会话为止（默认 20、最多 50）；返回的 `cursor` 是本页覆盖到的最后一个事实。
- 内容照设计 §8.2 第 1 步，外加 agent 自己的轨迹：头部（会话、任务、验收标准、污染标记）；任务会话的开场 prompt（去掉任务模板尾巴）、
  owner 的消息和 steer、打断；AskUserQuestion 问答、ExitPlanMode、带理由的 DENIED；agent 的回复、thinking 里命中信号的句子、
  压缩的工具时间线（命令首行 + 结果首尾行，连续的读 / 改折成一行）；已结算任务最新 3 条 agent 评论和 owner 评论；merge receipt 的 sha；
  owner 解决 blocker 时写的说明。读写记忆文件的工具调用连同结果剔除，指向记忆库的句子剔除。
- 打分与装箱照演示的打包器 v2；每行以 `L12` 开头，`sources` 把每个行名对到一手记录（turn / event / tool_call / task_comment /
  approval / merge_receipt / owner_decision），维护作业提议条目时引用这些记录，不引用案卷。服务端的出处解析因此补了
  `merge_receipt` 与 `owner_decision`（owner 解决的 blocker；它不算 Tiered 的 owner 原话）。
- **先脱敏再截断**：每条记录的文本先过共享脱敏器（owner 的 workspace.env 值作字面量），再裁剪、打分、装箱；最后整段再过一遍。
  每个会话不超过 8,000 token（`wikiEstimateTokens`：ASCII ÷ 3.4 + 其他 ÷ 1.25 + 1），装不下的被截断并标 `truncated`。
- **确定性**：同样的记录两次抽取字节一致，哈希（正文 + NUL + sources 的 JSON 的 sha256）相同；抽取不读时钟。
- **只存 (sourceIds, hash)**：`wiki_dossier` 每个 space、每个会话一行，存 sources、hash、token 数和发放它的页的位置，没有任何列存正文。
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
  `--permission-mode dontAsk`、`--allowedTools`（上面三个 orbit 工具和 `orbit wiki …` 命令）。HOME 与 CLAUDE_CONFIG_DIR 是会话
  自己在 runner scratch 下的目录，第一次建出来时只有 onboarding 标记——不读本机的登录、记忆、设置和 CLAUDE.md，会话自己的
  transcript 留在那里供 `--resume`。项目里的 `.claude/settings.json` 在 `--bare` 下照样会读，所以要 `--setting-sources ''`。
- **鉴权与 thinking**：`--settings` 只有 `apiKeyHelper: printenv ANTHROPIC_AUTH_TOKEN`（Bearer）；bare 模式下 `ANTHROPIC_API_KEY`
  走 x-api-key，vLLM 回 401，所以这个变量根本不交给引擎。thinking 默认关：`CLAUDE_CODE_EFFORT_LEVEL=unset` 加
  `MAX_THINKING_TOKENS=0`（只设前者仍会发 `thinking: adaptive`）。环境从零搭：provider 的端点、token、模型、自定义头、上下文窗口，
  runner 的 PATH、locale、TMPDIR、证书与代理，`ORBIT_HOME` 和会话上下文；runner 与 workspace 的其他变量都不带。
- **截断算失败**：开场 prompt 用满 120 个模型回合，CLI 以 `error_max_turns` 结束这一回合；runner 把回合记为 FAILED，并在游标路由上
  报 `outcome: truncated`——space 的连续失败加一，游标不动。

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
  准确说明它是依据哪些条目写的。重写只由维护作业在事实到达后触发，不用时钟。
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

- **写**：只有该 space 的维护会话（`isWikiMaintenanceSession`）经 runner 门，以及 API 服务器容器里的一次性导入（principal 为
  `origin: 'import'`、无会话、无用户，给预览 space 用）。其余一律 `WIKI_NOT_MAINTENANCE_SESSION`；headless 400；别的 owner 的 space 404。
  user 门没有写文章的路由。
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

## 19. 维护作业：由事实建任务、`orbit wiki maintain` 与 `orbit wiki check`（判据 3）

JSON 里是 `maintenance.job`；迁移 `0320_wiki_maintenance_run`；服务端在 `src/apiserver/src/wiki/wiki-maintenance-run.ts`
（触发、运行的起止与判据）、`wiki-maintenance-breaker.ts`（整次运行的熔断），runner 门在
`runner-api/runner-wiki-maintain.controller.ts`；runner-go 在 `wiki_maintain.go`。

### 19.1 触发：事实驱动，不用时钟

- `WikiMaintenanceTrigger` 把本副本发布的每个事件当作提示：会话的 STATUS / SESSION_ENDED / SESSION_UPDATED / APPROVAL_RESOLVED，
  以及 `task.changed` 点名的任务。只有提示点名的是**这个 space 的、仍在游标之后的已提交事实**（会话结算、它回答的审批、它的 merge
  receipt、space 的任务终态），才去问这个 space 是否到期；改名、维护作业自己的事件、别的 space 的工作都不算新事实，
  space 再到期也不建任务。merge receipt 与判据修订自己不发事件：它们照样计入 backlog，由下一个到达的事实一起带进来。
- 到期：水位之后有事实的会话 ≥ `rules.backlogThreshold`（20），或新事实到达时最老的未处理事实已超过 `maxPendingAgeHours`（24）。
  年龄只在事实到达时读，从不等：夜里悄悄满一天的 space，早上第一个事实到达时才建任务。
- 不建：维护关了或缺 workspace / 清单；清单里有未结束（OPEN / IN_PROGRESS）的任务；提示不是新事实；没到期；过了 120 秒宽限的
  事实里没有可覆盖的；被挡住（19.2）。
- 建任务在维护清单那一行的锁下进行，锁内再读一遍未结束的任务和当天次数：两个事实同时到达只建一个。

### 19.2 被挡住：健康状态里的 `held`

- `daily_limit_reached`：这个 space 自 UTC 零点起建出的维护任务已达 `settings.maintenance.dailyRunLimit`（`wikiMaintenanceRunsToday`，不论结局）。
- `review_queue_full`：Manual 模式下每条提议都等 owner，审阅队列连一个会话的提议都放不下。
- 记在 `wiki_cursor.held_reason` / `held_at`，游标状态里是 `held: { reason, at }` 或 null；同一原因保留第一次被挡的时刻，建出任务时清空。

### 19.3 任务的样子

- 在 space 隐藏的「Wiki maintenance」清单里；标题 `Wiki maintenance: <space 标题>`；指派给维护设置的 workspace，provider 钉死为
  维护设置的 provider（认领时按 §16.5 干净启动）；`runAt` 为建出的时刻；创建者为 owner（USER）。
- 描述就是运行的指令：用 Bash 跑一次 `orbit wiki maintain --space <id>`，跑完用 task_progress_report 与一条 task_comment 汇报，
  含 token 花费；失败时贴最后几行；不跑别的，失败最多重试一次。
- 判据 EXECUTABLE：`orbit wiki check --space <id> --expect-cursor <token>`，期望退出码 0，时限 `rules.checkTimeoutSeconds`（300 秒）。
- **期望位置**：从游标起、只看过了宽限的事实，按案卷页的同一走法数够 `runSize` 个会话时页会停在的位置。运行从同一游标翻页
  （案卷路由的 `until`）正好走到这里。
- **一次运行的大小**（`wikiMaintenanceRunSessions`），按每个会话最多 `entriesPerSessionMax`（6）条算，让它提议的东西放得进护栏：
  Manual 下取一个会话最多留给 owner 的数（`limits.opsPerSession`）与审阅队列的空位中较小者；Tiered / Automatic 下 space 有
  ≥100 个 active 条目时取它们的 10%（熔断线）；否则 `runSessionsMax`（20）。永不超过 20。

### 19.4 `orbit wiki maintain --space <id> [--model MODEL] [--concurrency N] [--json]`

只有维护会话能跑（其余 `WIKI_NOT_MAINTENANCE_SESSION`），一次跑完以下各步，任何一步失败、被截断或熔断都不推进游标：

1. **起点**：`GET …/maintenance/run` 拿 space 与仓库、维护 workspace 的工作目录、主题表、护栏数字和期望位置，同时记下运行开始、是哪个会话。
2. **checkout**：维护 workspace 的工作目录（`~` 按 runner 账号的家目录展开——会话里 HOME 是干净目录），先 fetch；它的 origin 与 space
   的仓库（`repo_url_norm`、有记录时的根提交）不一致就判失败并说明原因。
3. **案卷**：从游标翻页到期望位置（`until`）；自上次处理后没变的案卷跳过。
4. **抽取**：每个案卷一次干净的 Claude Code 调本地模型——照演示的 A2+6：8k 案卷、不开 thinking、每例最多 6 条；提示里带 space 的仓库
   名、地址和一两句它是做什么的（取自仓库 README 的开头），要求讲的不是这个仓库的会话回答 `{"offTopic": true}`。每条照演示的
   `extract.py` 校验：种类与字段、出处必须是案卷里的行且引文逐字出自该行、锚点必须在 origin/main 上存在；没过的整批再问一次。
   代码锚点全都不在本仓库的条目丢弃（计 `entries.foreign`），离题的会话计 `offTopic`。principle 只有 owner 能写，抽到的丢弃并计数。
5. **自检**：按主题分批（每批最多 `limits.opsPerChangeset` 个 op；Manual 最多 `limits.opsPerTurn`），逐批 `dryRun`：服务端找不到的
   引文从出处上去掉再查一次，仍被拒的 op 丢掉（`selfCheckDropped`），被审阅配额挡住的不提议（`heldBack`）。
6. **熔断**：space 有 ≥100 个 active 条目时，各批 dryRun 里会被模式直接生效或等核实的 op 合计不得超过 active 的 10%，超过就熔断，
   一条都不写。服务端对维护运行的 changeset 也按整次运行计熔断（`wiki-maintenance-breaker.ts`）：本次运行先前各 changeset 经
   模式改动的条目都算已用，active 数按运行开始时算（现在的 active 减去本次运行自己加出来且仍 active 的）。
7. **提议**：`POST …/maintenance/changesets`，origin 为 `maintenance`；此时还有 op 被拒就判失败。
8. **核实**：Automatic 下走 `orbit wiki verify` 对本次运行自己的 op 的核实，没拿到结论的再核一遍。
9. **锚点**：`orbit wiki anchors verify`，`--repo` 取上面的 checkout。
10. **文章**：`orbit wiki articles`，只重写条目集合变了的主题。
11. **收尾**：`POST …/maintenance/finish`，带最后一页的 token、outcome 与运行报告；失败时 outcome 为 failed、带原因，游标不动、连续失败加一。
    被 maxTurns 截断时由 runner 在游标路由上报 truncated（§16.5），同样记到运行上。

运行报告（`WikiMaintenanceReport`）：会话、案卷、跳过、离题数，条目（抽到 / 保留 / 丢弃 / 锚点在库外 / principle），
op（提议 / 记下 / 被拒 / 自检丢弃 / 被配额挡住 / 直接生效 / 等待），核实、锚点、文章各自的结果，**token（输入、输出、调用次数，含抽取、
核实、文章三处）**与耗时，失败时 `stoppedAt`。最多 16,000 字节 JSON，存在运行那一行上，`ops.refused` 单独成列。

### 19.5 `orbit wiki check --space <id> --expect-cursor <token> [--json]`

- `GET /api/runner/wiki/spaces/:id/maintenance/check?expect=<token>`：只读。任务的验收命令在会话回合之后、在没有会话上下文的 shell
  里跑，所以它接受 owner 的 runner 不带会话的调用；带了会话头的，须是该 space 的维护会话。
- 通过的条件：游标已在期望位置或之后，**并且**期望这个位置的最新一次运行以 succeeded 收尾、`ops.refused` 为 0。
- 否则退出码 1，每条原因一句：游标没到；没有任务期望这个位置；运行没说怎么结束的或没成功；运行没报它的 op；服务端拒了 op。
