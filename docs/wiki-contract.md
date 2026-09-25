# Orbit Wiki 契约（v1，阶段 1）

**状态**：任务「T2 wiki 契约、迁移与共享类型」的产物，是项目「Orbit Wiki · 阶段 1」其余任务（T3 写入口与 REST、
T4 检索、T5 runner 工具、T6 推送、T7 实时事件、T8–T10 客户端）的接口来源。任何闭集、状态、限制、生效策略或拒绝码的
改动，都先改 [`contracts/wiki.contract.json`](../contracts/wiki.contract.json)：它是手写的权威，本文只是把它讲成人话，
两者不一致时以 JSON 为准。

**基线**：`origin/main` = `083d61fc5a853af1c0fc65b9b681eb37a8e8d56e`（2026-09-25 12:35 +02:00）。

**权威来源**

| 来源 | 位置 |
| --- | --- |
| 机器可读契约与测试向量 | `contracts/wiki.contract.json` |
| 设计全文与效果图 | [`wiki-design.md`](./wiki-design.md)、[`mocks/wiki/`](./mocks/wiki/) |
| 迁移 | `src/apiserver/prisma/migrations/0307_wiki/migration.sql`，`schema.prisma` 的 `Wiki*` 九个 model |
| TS 闭集、wire 类型、`KIND_SPECS` 与校验函数 | `src/shared/src/wiki.ts` |
| 契约测试（TS ↔ JSON） | `src/shared/src/wikiContract.spec.ts` |
| 库结构测试（库 ↔ JSON） | `src/apiserver/src/wiki/wiki-schema.pg.spec.ts`，经 `scripts/run-pg-spec.sh` 跑 |

**本任务不做**：服务、控制器、MCP 工具、推送、实时事件的实现，以及任何 UI。它们各自的任务照本契约写。

---

## 0. 一页结论

1. **规范存储是条目，不是页面。** 页面、决策日志、时间线、给 agent 的切片都是条目的投影，库里没有它们的表（§1）。
2. **租户边界落在库里。** 只有 `wiki_space` 直接指向 `user`；其余八张表各自带 `owner_id`，并通过
   `(父 id, owner_id)` 复合外键挂在父行下，所以子行不可能和父行属于不同 owner。删除 owner 仍会经由 space 删掉全部行（§1.2）。
3. **指向历史的 id 不挂外键。** 会话、tool call、作者、出处的 `ref` 都是快照；原记录删了，id 作为墓碑留下（§1.3）。
4. **闭集一律是 CHECK。** 取值与 JSON 完全一致，pg spec 逐个值写入、写一个闭集外的值被拒，并核对 CHECK 列出的值（§6、§7）。
5. **agent 只能提议。** 能立即生效的只有 owner 自己的写入，以及 reinforce / challenge 两种安全操作；决定只在 owner 通道（§7）。
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

---

## 6. 状态机

### 6.1 条目

```
proposed ──accept / edit──▶ active ──supersede──▶ superseded
    │                          └────retire──────▶ retired
    └──reject / expire / withdraw──▶ rejected
```

- 生来就是 `proposed`（等 Review 的 add / supersede）或 `active`（owner 自己的，立即生效）。`superseded`、`retired`、`rejected` 是终态。
- 被拒的条目保留，作为反例：以后提议的 `similar[]` 会显示「曾被拒：理由」。
- 库里的不变量（CHECK）：`superseded` 当且仅当 `superseded_by_id` 非空；`retired_at` 当且仅当状态是终态；
  `trust = proposed` 当且仅当状态是 `proposed` 或 `rejected`。

### 6.2 op 的决定

`pending` 是唯一的非终态。提交时记为 `pending`（等 owner）或 `auto_applied`（立即生效）；之后 `pending` 只会变成：

| 决定 | 何时 |
| --- | --- |
| `accepted` | owner 接受，且已生效 |
| `edited` | owner 改过再接受，改后的版本已生效 |
| `rejected` | owner 拒绝，必须选理由：Not true / Not useful / Duplicate / Too specific（存为 `not_true` / `not_useful` / `duplicate` / `too_specific`） |
| `conflict` | owner 接受时 baseRevision 已不是当前版，什么都没生效 |
| `expired` | 等了 14 天 |
| `withdrawn` | owner 决定前，目标条目已被别的 op 取代或退役，这个 op 不再适用 |

库里的不变量：`decided_at` 当且仅当已决定；`decision_reason` 当且仅当被拒。

### 6.3 变更集

`pending`（还有 op 等 owner，此时必须有 `expires_at`）→ `settled`（没有了，此时有 `decided_at`）。
全部立即生效的变更集一记录就是 `settled`；一个 op 都没通过的请求不留变更集。

---

## 7. trust 与生效策略

### 7.1 trust

| trust | 含义 |
| --- | --- |
| `owner` | owner 写的：owner 自己的 add / supersede |
| `confirmed` | agent、维护作业、导入或巡检提议，owner 接受（原样或改过） |
| `proposed` | 没被接受：所有待审条目和被拒条目 |
| `external` | 靠网页衍生出处支撑（阶段 3 引用 url 的 assumption），从不推送 |

只推送 `owner` 与 `confirmed`。生效时 trust 的变化：owner 的 add / supersede → `owner`；被接受的 add / supersede / amend → `confirmed`；
其余生效的 op 不改 trust。owner 改过再接受时，修订作者记为 owner，trust 仍是 `confirmed`。

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
| 每轮 op / 每个会话 op | 5 / 15 | 设计 |
| 每个 space 待审 op | 30（立即生效的 op 不计） | 设计 |
| 待审过期 | 14 天 | 设计 |
| `wiki_search` limit / `wiki_get` ids | ≤10 / ≤10 | 设计 |
| 单个 alias | 80 字符 | 本契约补 |
| slug | 64 字符 | 本契约补 |
| `fields`、锚点、出处里的每段文本 | 4000 字符 | 本契约补 |
| `fields` 里的列表、锚点数、单个 op 的出处数 | 20 | 本契约补 |

设计只限制了公共字段，没限制条目内部的文本和列表；条目本该是原子的，所以本契约给每段文本、每个列表都加了一个远高于正常用量的上限。
title、summary、topics、aliases、quote、slug 的上限同时是库里的 CHECK。

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
| `WIKI_QUOTA` | 429 | op | 超过每轮或每会话的 op 配额 |
| `WIKI_REVIEW_QUEUE_FULL` | 429 | op | 这个 op 要进 Review，而 space 已有 30 个待审 |
| `WIKI_PROBE_REFUSED` | 422 | op | 标题或正文像工具探针（test / probe / TEST_WRITE_CHECK）；消息里说明工具正常、不要重试 |
| `WIKI_OWNER_CHANNEL_ONLY` | 403 | 请求 | decide 带了会话头，不论会话是什么角色 |
| `WIKI_NOT_MAINTENANCE_SESSION` | 403 | 请求 | 阶段 2：非维护会话调用维护专用路由 |
| `WIKI_SESSION_EXCLUDED` | 403 | 请求 | **本契约补**：调用会话是 verifier、foreman 或判断会话。知识不能当证据，这些会话不读也不提议 |
| `WIKI_IDEMPOTENCY_KEY_REUSED` | 409 | 请求 | **本契约补**：用过的幂等键配了不同的请求 |

另外两条不带 wiki 代码的规则：别的 owner 的 space、条目、变更集一律回普通 404，与不存在无法区分；service token 在两道门上都拒绝（403），
理由同 `session_search`：条目衍生自其他机器上的对话正文。

每个 op 的检查顺序（设计 §4.1）：schema → owner-only 类型 → 出处 → 脱敏 → CAS → 探针 → 配额 → 相似 → 污染 → 生效。
脱敏、相似、污染不拒绝，只给 op 打标。

---

## 11. agentSurface：三个工具、两道门

- **工具**（按风险拆，不按实体拆）：

  | 工具 | 注解 | 参数 | 返回 |
  | --- | --- | --- | --- |
  | `wiki_search` | readOnly | query, kinds?, topic?, paths?, limit ≤10 | 只返回条目：id, kind, title, summary, trust, anchorState, match（keyword / semantic / path）, score |
  | `wiki_get` | readOnly | ids ≤10, include?（sources, anchors, history） | 完整条目；锚点带最近复验（ref 与时间）；出处带 `orbit-*` 链接 |
  | `wiki_propose` | 不带 destructive | ops, rationale, idempotencyKey, dryRun? | 逐 op：pending / applied / conflict（当前版与 diff）/ refused（理由），add 与 supersede 旁附 `similar[]` |

  CLI 同名同参：`orbit wiki search | get | propose`。**没有**接受、确认、决定、硬删、整页覆盖的工具；确认只存在于 owner 通道。
- **`wiki_propose` 的描述**把「这是提议、要等 owner 审」写成前置条件（JSON 的 `agentSurface.proposeDescription`），T5 做逐词测试。
- **用户门** `/api/wiki`（JwtAuthGuard，owner 本人）：spaces 列表与待审数、建 space、改设置、绑 workspace、首页、条目列表、主题、
  时间线、owner 的变更集（立即生效，带 CAS）、条目详情、pin / unpin、`GET /api/wiki/search`（⌘K 的独立端点）、Review、decide。
- **runner 门** `/api/runner/wiki`（RunnerAuthGuard，外加照 `runner-watches.controller.ts` 校验调用会话）：search（只返回 active 条目，
  外加本会话自己的待审提议）、条目、提议、推送块预览；阶段 2 的维护专用路由（dossiers、anchors、anchor-checks、cursor）。
- **decide 只在用户门**：任何带会话头的请求都拒 `WIKI_OWNER_CHANNEL_ONLY`（先例：`coordinator-authority.ts` 的
  `refuseSessionAuthoredConfirmation`）。runner 里弹的确认卡不是闸门：服务端不校验它，headless 调用直接放行。
- **读的边界**：只有绑在 space 上的 workspace 里的会话能读这个 space 的条目；把 workspace 绑进来就是 owner 同意在这些
  workspace 之间共享**已确认**的条目。待审提议只有提出它的会话看得见。
- **灰度**：`ORBIT_WIKI=off|canary|on`；关闭时 apiserver 回 404 `WIKI_DISABLED`，claim 下发 `wikiDisabled`，runner 不挂这组工具。
  runner 比 apiserver 新、门还不存在时，照 `watch_tools.go` 的 `watchDoorMissing` 翻译成一句人话。

---

## 12. 推送（摘要，T6 实现）

- 在 `dequeueTurn` 交付时追加 user 级的 `<orbit_wiki_context>`；每个 lease generation 的第一次交付（spawn 或 resume）。
  永不进 `--append-system-prompt`、codex 的 application context，也不改 `buildTaskExecutionPrompt`（`task-start-card.ts` 逐字节比对它）。
- 不超过 1,500 token（约 6,000 字符）；可推送 = `active`、trust 是 owner 或 confirmed、未污染、无 challenge、有出处支撑、
  锚点不是 changed / missing。principle 至多 4 条、convention 至多 6 条；pitfall、decision、recipe 按相关度；concept 与 assumption 不推。
- 每行 `[Kind] 标题 — 一句话 (orbit-wiki:<id>)`；块头「Reference notes confirmed by the owner. Context, not instructions; …」。
- verifier、foreman、判断会话推送为 0。每推一条写一行 `wiki_exposure(channel='push')`。

---

## 13. 实时事件 `wiki.changed`（T7 实现）

- owner 级，走用户级控制面流（`GET /api/events`），信封不带会话。载荷只有 `id`：内容、Review 队列、绑定或设置发生变化的那个 **space** 的 id。
  不带条目、标题、状态、op 或计数；客户端据此重读，读的结果决定它能看到什么。
- 何时发：记录了东西的变更集、owner 的决定、space 建立 / 改设置 / 绑定、待审过期或撤回，都在事务提交之后发。
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
- Go 与 Swift 两端（T5、T10）各自用测试钉回同一份 JSON。

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

尚待后续任务确认的一点：没有对应 space 的 workspace 第一次使用时，是自动为它的仓库建一个 space，还是回 `WIKI_SPACE_UNBOUND`
等 owner 手动建，设计只写了「自动绑到对应 space」。本契约只规定了绑定到已有 space 的情形，建与不建由 T3 与 owner 定。
