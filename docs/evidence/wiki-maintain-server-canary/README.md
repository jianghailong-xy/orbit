# 维护运行在服务端：本机隔离部署的 canary 与测试证据（服务端执行 P8）

判据见项目验收条目「核实、文章、导入、plan 起草/修订、文档构建、维护六条流水线，在 `ORBIT_WIKI_EXECUTOR`
为 `server`（或 canary 名单内的账号）时都由 wiki-worker 完成，不创建维护任务或会话，也不使用任何用户的 provider」。
生产从 `main` 构建，本任务落地之后才生效，所以生产 canary 在任务内做不到；本目录是**本机隔离部署**的完整记录：

- 本分支的 `dist` 起的真 apiserver 与 wiki-worker 进程；
- 真的 PostgreSQL（一次性容器，跑完迁移，最后一次是 `0407_wiki_maintain_job`）；
- fake 的 System model（`fake-model.mjs`，只答抽取与核实）；
- 本项目线的 runner 二进制 **0.1.225**（声明 `wiki-repo-op/v1`），两个账号各一台、各读自己的 checkout；
- `ORBIT_WIKI_EXECUTOR=canary`，两个账号都在名单里。

## 怎么跑

```bash
bash docs/evidence/wiki-maintain-server-canary/run.sh
# ORBIT_BIN=/path/to/orbit  换 runner 二进制；WORKTREE=/path/to/worktree 换工作区；CANARY_WORK=/tmp/... 换暂存目录
```

脚本：构建 dist → 把本分支 clone 成 runner 读的 checkout → 起 PG 并跑迁移 → `seed.cjs` 造 fixture →
起 fake model、apiserver（canary + 两个账号）、wiki-worker、两台 runner → `drive.mjs` 驱动并断言 →
把完整记录写进本目录的 `evidence.json`（同时留在 `$CANARY_WORK/logs/drive.json`）。

## 一、canary 的结果（`evidence.json`，24 项检查全过）

### 1. 连续 3 次 maintain 作业成功，游标每次推进

| 次 | 运行行 `wiki_maintenance_run.id` | 作业行 `wiki_job.id` | 作业状态 | 记下的 op | 服务端拒绝 | 游标推进前 → 后 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `d1ba6e1e-3a8b-4989-aca7-f57e0befd8e6` | `393ced82-3030-4d7c-9498-b8254cf73c61` | succeeded（attempts 3，前两次是 infra：runner 还没上报能力，退避重试且**不计**连续失败） | 2 | 0 | （无） → `ddb233ea-77ca-4805-a5d3-ac62b45de119` |
| 2 | `6cfc46f4-409d-483b-99c7-c5fce78c575c` | `aee0e18a-ee82-4650-bd5f-192748be773a` | succeeded | 2 | 0 | `ddb233ea…` → `46b04b86-0659-44f9-8be6-73470dab84f3` |
| 3 | `fbd41cf8-829d-43c9-ae5e-57ab2a601599` | `0c01a357-020e-4002-ba83-b4a7bf19ecdf` | succeeded | 2 | 0 | `46b04b86…` → `a06d6b18-78df-4639-b5c7-d273f9442915` |

游标行最后：`{kind: session_settled, ref: a06d6b18…, consecutive_failures: 0}`（`evidence.json` 的 `cursor.accountA`）。
三次运行的 `task_id` 都是 `null`，`catch_up` 都是 `null`。

### 2. 请求行：8 条，全部 `extract/succeeded`

`evidence.json` 的 `requests` 是全部 `wiki_model_request` 行（账号 A 与 B），`requestSummary` 是计数：
`{"extract/succeeded": 8}`——每个案卷一条抽取请求，全部走队列、由 worker 执行，没有一条经过用户 provider。

### 3. 这期间新增的 Task 和 Session 都是 0

`evidence.json` 的 `counts.accountA`：

```json
{"before": {"tasks": 7, "tasksInHiddenList": 1, "sessions": 26},
 "after":  {"tasks": 7, "tasksInHiddenList": 1, "sessions": 26},
 "tasksAdded": 0, "sessionsAdded": 0, "tasksInHiddenListAdded": 0}
```

账号 B 同样：`before {tasks: 4, sessions: 25}` → `afterRun {tasks: 4, sessions: 25}`（`tasksAddedByRun: 0`,
`sessionsAddedByRun: 0`）。隐藏维护列表里那 1 条任务是**跑之前就存在**的、已 CANCELLED 的旧维护任务。

### 4. 记下 op 且不在追赶期 ⇒ 排出了 articles 作业

`evidence.json` 的 `articlesJobs`（3 次运行各排一个，前两个随后被 worker 跑完，最后一个是 `queued`）：

| `wiki_job.id` | kind | state | created_at |
| --- | --- | --- | --- |
| `b5a43a8c-be60-4be8-8e4e-cc60ea33b260` | articles | succeeded | 2026-10-08T12:12:14.471Z |
| `54ed513c-2914-4bfa-8288-f9f9f73f6624` | articles | succeeded | 2026-10-08T12:12:20.412Z |
| `2a04e935-d7a0-4917-b3b7-a0ea34fbad27` | articles | **queued** | 2026-10-08T12:12:26.455Z |

（规则：`outcome succeeded && catchUp null && recordedOps`，`queueWikiArticlesAfterRun`；见 `articlesJobs` 与检查
「a run succeeded, recorded ops and was not behind, and a queued articles job exists for the space」。）

### 5. 一个没有任何 provider 行的账号：能打开维护并跑完一次运行

账号 B 在数据库里**没有任何 `model_provider` 与 `provider_pool` 行**（`providers: 0, providerPools: 0`），
空间里存的还是 `provider: "claude"`（内置引擎，维护会话起不了的那种）。`evidence.json` 的 `providerless`：

- `patch`：owner 自己的 `PATCH /api/wiki/spaces/:id` 回 **200**，`settings.maintenance.enabled = true`、`provider: "claude"` 原样保留；
- `run`：`runId e2ee697a-c242-42dd-b31c-c09d3c700fd4`、`jobId 3cddae8e-1584-4e3f-b876-1790ccea1c16`、
  `jobState succeeded`、`outcome succeeded`、`opsRefused 0`、`taskId null`，游标 `3d6dc8ec…`。

对照：runner 模式下同一份设置会被 `maintenance.provider` 拒绝（`wiki-maintain-trigger.pg.spec.ts` 的
「the settings door asks no provider of an account the server executes, and the runner mode's refusal is unchanged」）。

### 6. 已发布 runner 的门：409，没有调模型

`evidence.json` 的 `door`（runner 二进制 0.1.225）：

```
$ orbit wiki maintain --space 2TfiY62ITML9FOdlqIJrBg --json      # exit 1
orbit wiki maintain: GET /runner/wiki/spaces/…/maintenance/run -> 409
  refused: WIKI_SERVER_EXECUTES
  what:    this account's Wiki maintenance run is executed by the Orbit server (ORBIT_WIKI_EXECUTOR): its wiki
           worker reads the dossiers and calls the deployment's System model through the request queue, and no
           session's provider is asked. Nothing was read or proposed.
```

`GET …/maintenance/run`、`GET …/dossiers`、`POST …/cursor` 三条路由各自 `409 {"code":"WIKI_SERVER_EXECUTES"}`；
`model.callsDuringDoorChecks = 0`（fake model 的调用条数在门检查前后都是 8，只有 8 条抽取）。

## 二、测试（`tests.txt`，合并后的树 bd04eb510 + P8 提交）

| 命令 | 结果 |
| --- | --- |
| `node --test build/wiki-worker/wiki-maintain.spec.js` | **23/23 通过** |
| `run-pg-spec.sh …/wiki-maintain-job.pg.spec.ts` | **6/6 通过** |
| `run-pg-spec.sh …/wiki-maintain-trigger.pg.spec.ts` | **5/5 通过** |
| `run-pg-spec.sh …/wiki-maintenance.pg.spec.ts` | **38/38 通过**（runner 路径回归） |
| `run-pg-spec.sh …/wiki-health.pg.spec.ts` | **5/5 通过** |
| `cd src/apiserver && npm test` | **4970 通过、0 失败、0 跳过** |
| `cd src/shared && npx vitest run` | **24 文件、408 通过** |
| `cd src/web && npx vitest run --maxWorkers=2` | 368 文件、4758 通过（`web.txt`） |
| `npm run test:compose-topology` | 11 通过、0 失败（`topology.txt`） |

`wiki-maintain.spec.ts` 覆盖抽取检查、行与 spans、引文与 locator、离题、域外锚点、principle、重名、按模式的批次大小、
熔断的页算术、重问后缀；`wiki-maintain-job.pg.spec.ts` 覆盖整条服务端流水线（含**批次与熔断整页挡回**、
**游标推进**、**追赶期间跳过文档步骤**、articles 作业、infra/content 两种失败）。

## 三、和 runner 路径一致：哪张表、哪份 fixture

1. **同一张移植表**：`src/apiserver/src/wiki-worker/wiki-maintain.spec.ts` 的
   `the ported table: each row answers what the Go case it ports answers` 一表，每行写明它移植自
   `src/runner-go/wiki_maintain_test.go` 的哪个用例，同一份案卷（`portDossier()`，三条行、两条 spans）与同一份
   模型回答给出与 Go 相同的确定性结果：

   | Go 用例 | 这一行/这条 TS 用例 |
   | --- | --- |
   | `TestWikiMaintainTakesNothingFromASessionAboutSomethingElse` | 表第 1 行 + `the off-topic answer is read bare and fenced` |
   | `TestWikiMaintainQuotesTheRecordsOwnWordsWhereTheLineSaysTheyAre` | 表第 2 行 + `a quote one span holds is placed as the record's own words…` |
   | `TestWikiMaintainCitesTheRecordWithoutTheQuoteTheServerDoesNotFind` | 表第 3 行 + `a quote whose words the redactor took out…` |
   | `TestWikiMaintainRunsThePipelineAndAdvancesTheCursor`（域外锚点 / principle / 被拒条目） | 表第 4–6 行 |
   | `TestWikiMaintainReadsALineOfManyParagraphsWhole` | `a line continues over the indented lines under it…` |
   | `TestWikiMaintainHoldsItsBatchesToTheBreakerTheServerCounts`、`…HoldsBackEveryPageFromTheFirstThatDoesNotFit` | 表末的批次/熔断断言 + `wiki-maintain-job.pg.spec.ts` 的「the breaker holds back the ops of the first page that does not fit…」 |
   | `TestWikiMaintainCursorAdvanceMovesItAsSoonAsTheOpsAreRecorded`（catch-up 表） | `wiki-maintain-job.pg.spec.ts` 的整跑用例（`cursorAdvanced: true` 与游标行） |
   | `TestWikiMaintainCatchUpSkipsTheDocumentsAndThePlanProposal` | `wiki-maintain-job.pg.spec.ts` 的「a run made while the space is catching up…」 |
   | docs 表（`…WritesOnlyTheSectionsItsEntriesAndOriginMainTouched`、`…ProposesOneChange…`、`…WritesNoDocumentWithoutAConfirmedPlan`、`…DocsIsTheContracts`） | P7 的写入器与 P6 的门（`wiki-docs*.pg.spec.ts`、`wiki-plan*.pg.spec.ts`）＋本任务的文档步骤；canary 空间无确认 plan，走 `no_confirmed_plan` |

2. **同一份 fixture**：`wiki-maintain-job.pg.spec.ts` 的 `portDossier()`/`pageOf()` 就是 Go 测试里
   `fakeMaintainDoor` 的案卷与页（同一条工具行、同一段引文、同一条离题案卷），并且驱动的是**真的服务端写入口**
   （`WikiService.submitChangeset`、`advanceRecorded`、`recordAnchors`）——所以检查、配额（每日次数与队列余量）、
   熔断的读数来自同一套服务端代码，两条路径不可能给出不同的答案。
3. **配额的服务端一侧**：`wiki-maintain-trigger.pg.spec.ts` 的
   「a server run counts against the day the way a task's run does, and a local catch-up run is not counted」
   用 `dailyRunLimit: 1` 跑出 `daily_limit_reached`，再用 `catchUp=active + localEndpoint` 证明不计入——
   与 runner 路径的 `wiki-maintenance.pg.spec.ts`（38 例，同一批 held 理由）读同一条规则。
4. **runner 路径逐字未变**：`wiki-maintenance.pg.spec.ts` 38/38、`wiki-health.pg.spec.ts` 5/5、
   `wiki-maintenance-session.pg.spec.ts`、`wiki-plan.pg.spec.ts` 等既有 spec 全绿，`npm test` 4970 全过。

## 四、合并

- 项目线已 **merge**（不是 rebase）进本分支：`git merge origin/project/34bmzOkov3xN2yLPrnsCk` → 合并提交
  （见提交历史里的 `Merge the project line …`），无冲突。
- merge-tree（`git merge-tree --write-tree <HEAD> <ref>`，exit 0 = 干净）：
  - `HEAD` + `origin/project/34bmzOkov3xN2yLPrnsCk`（`d09019e2b`）→ 写入树 `dff066c17d06c81f0d5d205b2c3fe11e9bd918fb`，exit 0；
  - `HEAD` + `origin/main`（`6a58a9515`）→ 写入树 `76826467df00763ff08eef78b41362aad949ddc3`，exit 0。
- 整文件读取任务（`34cIIF63cjJB1zDdbsbC4`）当时还没落到项目线上（项目线上没有 `0406_*` 迁移目录）。
  它的迁移号是 `0406_wiki_repo_file`、本任务是 `0407_wiki_maintain_job`，**两个号不同、目录不同**，两边落地后可以并存，
  不需要再让号；它落地后若与 `contracts/wiki.contract.json`、`docs/wiki-contract.md` 或迁移账本
  （`task-judgment-data-preserved.spec.ts`）冲突，按项目线的合并结果两边都保留即可。

## 五、与本次改动无关的红 spec

`src/runner-go` 全量有 21 个与环境有关的失败（Antigravity/Claude 登录、真 Claude effort 探针），已在基线 worktree
（`/tmp/p8-baseline`，源码与 `76740abaa` 逐字节相同）用同一命令复现相同的失败用例名；本任务未改 `src/runner-go`。
