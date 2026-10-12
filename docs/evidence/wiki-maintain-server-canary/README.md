# 维护运行在服务端：本机隔离部署的 canary 与测试证据（服务端执行 P8）

判据见项目验收条目「核实、文章、导入、plan 起草/修订、文档构建、维护六条流水线，在 `ORBIT_WIKI_EXECUTOR`
为 `server`（或 canary 名单内的账号）时都由 wiki-worker 完成，不创建维护任务或会话，也不使用任何用户的 provider」。
生产从 `main` 构建，本任务落地之后才生效，所以生产 canary 在任务内做不到；本目录是**本机隔离部署**的完整记录：

- 本分支的 `dist` 起的真 apiserver 与 wiki-worker 进程；
- 真的 PostgreSQL（一次性容器，跑完迁移，最后一次是 `0407_wiki_maintain_job`）；
- fake 的 System model（`fake-model.mjs`，只答抽取与核实）；
- 一棵**指名提交**的 runner 二进制：`2865071b3`（本分支与项目线 5591b09a8 的合并提交）用
  `cd src/runner-go && GOCACHE=… go build -trimpath -ldflags "-X main.version=0.1.224+p8-merge.2865071b3" -o /tmp/p8-orbit-merge .`
  构建，`--version` 回 `0.1.224+p8-merge.2865071b3`；两个账号各一台、各读自己的 checkout。

  > 版本号的来源：runner 的版本是构建时用 `-ldflags "-X main.version=…"` 打进去的（`src/runner-go/main.go` 里
  > `var version = "dev"`），树里没有别处写死它。第 2 版证据用的是兄弟会话留在 `/tmp/p8canary/bin/orbit` 的预编译件
  > （`--version` 回 `0.1.225`）：`go version -m` 显示它 `-trimpath`、`orbit (devel)`、没有 `vcs.revision`，所以
  > **无法从二进制指认它出自哪棵树、哪个提交**——当时本分支与项目线（1cf7949fe）的 `package.json` 都是 0.1.224，
  > 0.1.225 是后来整文件读取任务落地（5591b09a8）才进的树。本节记录的这次 canary 换成了上面这枚由合并提交构建的
  > 二进制，provenance 可指名、可重建。
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
| 1 | `3e6fdfc1-000b-45e5-b2b7-898681e4b5f7` | `46cfb9a6-940e-4370-b0a9-15b2fad46c99` | succeeded（attempts 3，前两次是 infra：runner 还没上报能力，退避重试且**不计**连续失败） | 2 | 0 | （无） → `85a16c9a-ba78-430f-80d0-4e51357149d3` |
| 2 | `d2e55305-edbd-4eee-820e-bfe4bdc34463` | `14fb4b50-baf8-4cd6-81b3-9953d7dae5b9` | succeeded | 2 | 0 | `85a16c9a…` → `eb4ff8af-36d2-46ba-90dd-125140e9190d` |
| 3 | `65b42dd8-759b-49fc-beb2-72a4202d0890` | `12010986-a827-4ba7-8e5a-40f1643bf080` | succeeded | 2 | 0 | `eb4ff8af…` → `4a0329cb-bc74-4fd9-a87c-224da0e7e1f8` |

游标行最后：`{kind: session_settled, ref: 4a0329cb…, consecutive_failures: 0}`（`evidence.json` 的 `cursor.accountA`）。
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
| `ab4709d1-4fcb-4192-a574-4700839e11eb` | articles | succeeded | 2026-10-08T12:50:46.299Z |
| `e93ed091-ceac-42cf-8e16-30a8417fd2b2` | articles | succeeded | 2026-10-08T12:50:54.123Z |
| `7d1de98c-9831-48ae-8e48-166d0ab35f5b` | articles | **queued** | 2026-10-08T12:51:04.164Z |

（规则：`outcome succeeded && catchUp null && recordedOps`，`queueWikiArticlesAfterRun`；见 `articlesJobs` 与检查
「a run succeeded, recorded ops and was not behind, and a queued articles job exists for the space」。）

### 5. 一个没有任何 provider 行的账号：能打开维护并跑完一次运行

账号 B 在数据库里**没有任何 `model_provider` 与 `provider_pool` 行**（`providers: 0, providerPools: 0`），
空间里存的还是 `provider: "claude"`（内置引擎，维护会话起不了的那种）。`evidence.json` 的 `providerless`：

- `patch`：owner 自己的 `PATCH /api/wiki/spaces/:id` 回 **200**，`settings.maintenance.enabled = true`、`provider: "claude"` 原样保留；
- `run`：`runId 75ddc23c-711e-461d-8811-3736716f4991`、`jobId 0620050e-355f-404a-87eb-69865e75819f`、
  `jobState succeeded`、`outcome succeeded`、`opsRefused 0`、`taskId null`，游标 `1372a629…`。

对照：runner 模式下同一份设置会被 `maintenance.provider` 拒绝（`wiki-maintain-trigger.pg.spec.ts` 的
「the settings door asks no provider of an account the server executes, and the runner mode's refusal is unchanged」）。

### 6. 已发布 runner 的门：409，没有调模型

`evidence.json` 的 `door`（runner 二进制 `0.1.224+p8-merge.2865071b3`，由合并提交构建）：

```
$ orbit wiki maintain --space 1414QrDa3auwuAktck2Ijw --json      # exit 1
orbit wiki maintain: GET /runner/wiki/spaces/…/maintenance/run -> 409
  refused: WIKI_SERVER_EXECUTES
  what:    this account's Wiki maintenance run is executed by the Orbit server (ORBIT_WIKI_EXECUTOR): its wiki
           worker reads the dossiers and calls the deployment's System model through the request queue, and no
           session's provider is asked. Nothing was read or proposed.
```

`GET …/maintenance/run`、`GET …/dossiers`、`POST …/cursor` 三条路由各自 `409 {"code":"WIKI_SERVER_EXECUTES"}`；
`model.callsDuringDoorChecks = 0`（fake model 的调用条数在门检查前后都是 8，只有 8 条抽取）。

## 二、测试（`tests.txt`，合并后的树 2865071b3：项目线 5591b09a8 + P8 工作）

| 命令 | 结果 |
| --- | --- |
| `node --test build/wiki-worker/wiki-maintain.spec.js` | **23/23 通过** |
| `run-pg-spec.sh …/wiki-maintain-job.pg.spec.ts` | **6/6 通过** |
| `run-pg-spec.sh …/wiki-maintain-trigger.pg.spec.ts` | **5/5 通过** |
| `run-pg-spec.sh …/wiki-maintenance.pg.spec.ts` | **38/38 通过**（runner 路径回归） |
| `run-pg-spec.sh …/wiki-health.pg.spec.ts` | **5/5 通过** |
| `cd src/apiserver && npm test` | **4972 通过、0 失败、0 跳过** |
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
   `wiki-maintenance-session.pg.spec.ts`、`wiki-plan.pg.spec.ts` 等既有 spec 全绿，`npm test` 4972 全过。

## 四、合并

### 4.1 排版：合同文件只多三个键

第 2 版把 `contracts/wiki.contract.json` 整份重排了（2720 行 → 4387 行）。现在它逐字节回到项目线的写法，
新键按文件原有写法加在各自对象的末尾（小的 map 与数组仍在同一行：`"steps": { "extract": "extract", "planProposal": "plan_proposal" }`、
`"docsExcluded": ["docs/mocks/", "/docs/evidence/"]`）：

```
$ git diff --numstat 76740abaa -- contracts/wiki.contract.json      # 本任务的全部改动
33      2       contracts/wiki.contract.json
$ git diff --numstat origin/project/34bmzOkov3xN2yLPrnsCk -- contracts/wiki.contract.json
33      2       contracts/wiki.contract.json
```

按解析后的 JSON 比较（把项目线的 JSON 与本文件的 JSON 各解析一遍，递归找「新增/删除/改值」的键）：

```
added (top-level of each parent): ['.maintenance.job.server', '.plan.proposals.author', '.jobs.kindRuns.maintain']
removed: []
merged == project line + my three keys: True
```

那 2 行「删除」是三个末端成员各加了一个逗号（`"cli"` 的闭括号、`"reject"`、`"docs_build"`）——git 按行计。

### 4.2 合入整文件读取任务的落地（不 rebase）

整文件读取任务（`34cIIF63cjJB1zDdbsbC4`）的落地 `5591b09a8` 已进项目线（含迁移目录 `0406_wiki_repo_file`），
本分支 `git merge --no-ff origin/project/34bmzOkov3xN2yLPrnsCk` 合入，合并提交详见提交历史里的
`Merge the project line (5591b09a8) …`。两处冲突都两边保留：

- `contracts/wiki.contract.json`：项目线的原文 + 本任务三个键（上面 4.1 的 numstat 与解析比较）；
- `docs/wiki-contract.md`：§26.6 的 `look` 一条用落地那版（`runner_upgrade` 盖两种机器、`capability` / `wholeFile`
  分开），随后是完整的 §27（本任务的维护运行）；
- `src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts`：迁移账本 **0406 在前、0407 在后**，
  两条注释都在，数组只在 0407 之后闭合。

落地还改了仓库读取路径（`readWikiRepoFiles`，先查缓存、按 runner 是否声明 `wiki-repo-op-read/v1` 决定整份或
22,000 字窗口）。本任务的文档步骤改走它，仓库闸门改用 `wikiRepoStepsCanRun`：只有 `wiki-repo-op/v1` 的机器照旧
跑（有界读取），一点仓库能力都没有的照旧按 infra 拒绝。

### 4.3 merge-tree 与重跑

在 HEAD `383309af1`（本目录这次证据所在的提交；其后只改了本节文字）上测得，两条线都干净：

```
$ git merge-tree --write-tree HEAD origin/project/34bmzOkov3xN2yLPrnsCk
b362cf28a58a77f2821b9b9c4d4594b6d2085813        # exit 0；项目线当时为 5591b09a8
$ git merge-tree --write-tree HEAD origin/main
b362cf28a58a77f2821b9b9c4d4594b6d2085813        # exit 0；main 当时为 58a3889ff（已含项目线 5591b09a8）
```

合并后重跑：`npm test` **4972 通过 / 0 失败**、`src/shared` **408 通过**、四个 pg spec
**6/6、5/5、38/38、5/5**；canary 用**由合并提交构建**的 runner 重跑，**24/24 全过**（`evidence.json` 即这次运行）。

## 五、与本次改动无关的红 spec

`src/runner-go` 全量有 21 个与环境有关的失败（Antigravity/Claude 登录、真 Claude effort 探针），已在基线 worktree
（`/tmp/p8-baseline`，源码与 `76740abaa` 逐字节相同）用同一命令复现相同的失败用例名；本任务未改 `src/runner-go`。
