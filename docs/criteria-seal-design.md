# Criteria seal & decision —— 落地形状定稿

> 勘察日期 2026-09-09，基线 `b414cee5`（分支 `orbit/seal-7e4000`）。`origin/main` 当时是 `c0b06b62`，
> 比本基线只多一条 web 提交，`src/apiserver/src/projects` 与 `src/apiserver/prisma` 零差异，
> 所以下面每一条引用在 main 上同样成立。
>
> 本文只勘察与设计，不改任何生产代码。

---

## 0. 一句话结论

**seal 复用，不新建表。** 仓库里已经有一个内容摘要身份、一个「判定记录它对着哪个版本产生」的
快照、以及一个「结算要求两者相等」的合取——三件事都在 main 上跑着，只是没有人把「尺子只能往严处走」
这条不变量接上去。真正缺的是**方向闸**（加严当场生效 / 削弱落 intent）、**削弱 intent 的决定落点**
（0195 的 intent 表能收提案，收不了答案），以及**标准的作者身份**（表上根本没有这一列）。

| 项目目标里的三条不变量 | 现状 | 本轮要做的 |
| --- | --- | --- |
| 1 时序封存（seal） | **已存在**：`criteriaSemanticRevision` + `project_standard_set_confirmation` + `Task.criterionRevision` 快照 | 只做「加严自动重新封存、已有确认顺延」的接线 |
| 2 职责分离 | **不存在**：标准定义表没有作者列 | 新建 `project_criteria_authorship` |
| 3 单调性 | **不存在**：`replaceAcceptanceDefinitions` 当场全量覆写 | 分类器 + 削弱改路 + 决定门 |
| 4 目标表达（结算前确认一次 seal） | **已存在并已落 main** | 只需为它补真红的 spec |

---

## 一、项目验收标准现在有哪些内容摘要设施

四套，逐个说清楚它算什么、谁写的、动什么会让它移动。

### 1.1 `content_hash` —— 一条标准的内容身份（触发器写）

* 列：`src/apiserver/prisma/schema.prisma:1960`（`content_hash CHAR(64)`）。
* 配方：`src/apiserver/prisma/migrations/0233_project_acceptance_criterion_wiring_removal/migration.sql:77`

  ```sql
  project_acceptance_definition_content_hash(p_text TEXT, p_verification_method TEXT)
    = sha256( jsonb_build_object('text', p_text, 'verificationMethod', p_verification_method)::text )
  ```

* 写入方：`BEFORE INSERT OR UPDATE` 触发器 `project_acceptance_definition_normalize`，函数体现役版本在
  `src/apiserver/prisma/migrations/0234_project_acceptance_evaluation_plan_lane_removal/migration.sql:74`，
  触发器装回在同文件 `:265`。它同时推进 `revision`（正文或判定方法任一变化 → `OLD.revision + 1`，
  `src/apiserver/prisma/migrations/0234_project_acceptance_evaluation_plan_lane_removal/migration.sql:90`）。
* **陷阱（对后续任务是承重的）**：应用层 `ProjectsService.replaceAcceptanceDefinitions` 自己也算了一个
  `contentHash`，用的是 `sha256(criterion.text)`——**只 hash 正文，不含 verificationMethod**
  （`src/apiserver/src/projects/projects.service.ts:885`），并且自己算了一遍 `revision`
  （同文件 `:895`）。这两个值写进去之后**都会被触发器覆写**。
  所以：**任何 seal 都必须在写入之后从库里读回来算，不能从 DTO 在 TS 里算。**

### 1.2 `semantic_hash` / `semantic_revision` —— 更窄的一条 lane（不要拿它当 seal）

* 列：`src/apiserver/prisma/schema.prisma:1968`、`:1969`。
* 配方：`src/apiserver/prisma/migrations/0233_project_acceptance_criterion_wiring_removal/migration.sql:88` —— `sha256(jsonb_build_object('text', btrim(p_text)))`，**只有正文**。
* 推进规则：`src/apiserver/prisma/migrations/0234_project_acceptance_evaluation_plan_lane_removal/migration.sql:90` —— `semantic_revision` 只在 `text` 变化时前进；
  改 `verification_method` **不动它**。
* 结论：**不能用作 seal**。「把判定方法从『一条 pg spec』改成『人工目测』」是本项目定义里的削弱，
  而它在这条 lane 上是零位移。用它当尺子的身份，等于给削弱开了一扇后门。

### 1.3 `project_completion_contract.contractDigest` —— 太粗，也不是标准集的身份

* 列：`src/apiserver/prisma/schema.prisma:2040`；快照函数 `project_completion_contract_snapshot` 现役版本在
  `src/apiserver/prisma/migrations/0234_project_acceptance_evaluation_plan_lane_removal/migration.sql:114`，`semantic_material` 的键在 `:170-208`。
* 它把这些一起 hash：`budget`(boundary)、`criteria`、`criteriaVersions`、`goal`、`outcomes`、
  `ownerId`、`permissions`、`recipients`、`recipientDigest`、`riskBoundary`。
* 也就是说 `maxConcurrentTasks`、`coordinatorEnabled`、`automationPolicy`、`attemptBudget`、
  `sessionBudgetPerDay`、项目成员、`goal` 任一变动都会推 `contractDigest` 走。
* 结论：**既太紧又太松**。太紧——一次与标准无关的项目配置改动会让一条待决的削弱提案失效；
  太松——摘要本身不告诉读者「当时台面上是哪一版标准」。它是契约的身份，不是尺子的身份。

### 1.4 `criteriaSemanticRevision` / `standardSetVersion` —— **这就是 seal，已经存在**

* 实现：`src/apiserver/src/projects/project-acceptance.ts:110`

  ```
  seal = sha256( sort([ `${definitionId}:${revision}:${contentHash}` ...]).join(',') )
  ```

* 包装成「摘要 + 可读材料」：`standardSetVersion`，`src/apiserver/src/projects/project-acceptance.ts:162`。
* 已被持久化：每次所有者确认写一行 `project_standard_set_confirmation`，
  `criteria_digest` + `criteria_material` 存的就是它（`src/apiserver/prisma/schema.prisma:2019`、
  `src/apiserver/prisma/migrations/0245_project_standard_set_confirmation/migration.sql:57`）。
* 已被比较：`standardSetConfirmationStanding`（`src/apiserver/src/projects/project-acceptance.ts:209`）→
  `UNCONFIRMED / CONFIRMED / STALE`。
* 已被读：`GET /projects/:id/acceptance/confirmation`
  （`src/apiserver/src/projects/projects.controller.ts:343` → `src/apiserver/src/projects/project-acceptance.service.ts:129`）。
* 性质：
  * **顺序不参与**（先排序），与 `ordinal` 明写「不进语义摘要」（`src/apiserver/prisma/schema.prisma:1943-1944`）一致；
  * **两半都覆盖**：`revision` 与 `contentHash` 都由触发器从 (text, verificationMethod) 推出；
  * **抗 ABA**：`revision` 单调不减，`definitionId` 是行自己的 id，删掉再建同样文字落不回旧摘要。
  * 不含 `ordinal`、不含 `completion_criterion_override_reason`——这是刻意的，不是遗漏。

### 1.5 判定侧「对着哪个 seal 产生」也已经有了

* 每条**标准**级别：`Task.criterionRevision` 是声明当时的快照，
  `src/apiserver/src/projects/project-criterion-declaration-staleness.ts:5-8` 说明它是快照且允许与现状不一致；
  结算把它折成 `DECLARATION_STALE` 子句（`src/apiserver/src/projects/project-criterion-satisfaction.ts:57`、`:62`）。
* 整个**标准集**级别：确认行的 `criteria_digest` 与今天的 seal 相等才算数
  （`src/apiserver/src/projects/project-acceptance.ts:209-216`）。

### 1.6 结论：复用，理由与代价

**复用 `criteriaSemanticRevision` / `standardSetVersion`，本轮不为 seal 新建任何表或函数。**

理由：

1. 「标准集有内容摘要身份」「每条判定记录它对着哪个 seal 产生」「结算要求两者相等」——三句话
   在 main 上都已经有实现（1.4、1.5、二节），新建一张 seal 表会是同一个事实的第二种拼法，
   而同一事实存两份的那一份就是会漂的那一份。
2. seal 是活行的**全函数**，没有历史可留：需要历史的那两个地方（确认、削弱提案）各自把当时的
   摘要**存进自己的行里**——确认存在 `project_standard_set_confirmation.criteria_digest`，
   提案存进 intent 的 `action` JSONB（见三、四节）。所以没有第三个地方需要一张 seal 表。
3. 新建 `project_criteria_seal` 表还要面对一个真问题：它必须与活行保持一致，一致性靠触发器
   （多一个写入方）或靠应用层重算（那就是第二种拼法）。两条都比「读的时候算」贵。
4. 约束顺带满足：本轮**零新增** `project_acceptance_` 前缀关系/函数，
   项目验收第 8 条（`15YL0XWVE56n4FMCVSpfoJ`）由构造成立。

代价与必须写下来的边界：

* seal 是**读时计算**，所以「seal 前进」这个断言只能通过**前后两次读**证明，不能断言某一行的某个列变了。
* 「加严当场生效、自动重新封存」在这个设计里不是一个动作：写入落库 → 触发器推 `revision`/`content_hash`
  → 下一次读 seal 自然是新值。**没有任何东西需要「重新封存」这个写。**
  所谓「已有确认顺延」在这里的准确含义是：**加严之后旧确认自动变 `STALE`，需要重新确认**。
  这与项目目标里「已有确认顺延」的字面不同，是本文要提请 coordinator 确认的第一处偏差（见第七节）。

### 1.7 ⚠️ 前缀普查比约束写的更宽：**列**也在普查里

任务约束说「新表/新函数不能用 `project_acceptance_` 前缀」。实测普查还盯着**已有那张表的列清单**，
三处逐列 deepEqual：

* `src/apiserver/src/projects/criteria-confirmation-removal.pg.spec.ts:61`（+ 断言在 `:165`）
* `src/apiserver/src/tasks/failure-continuation-removal.pg.spec.ts:88`（+ 断言在 `:500`）
* `src/apiserver/src/tasks/verification-subject-guard-removal.pg.spec.ts:81`（+ 断言在 `:240`）

关系级 / 触发器级的穷举普查（新增一张 `project_acceptance_*` 表或它上面的触发器会打红）：

* `src/apiserver/src/projects/criteria-confirmation-removal.pg.spec.ts:160`（关系+列）、`:185`（触发器）、`:198`
* `src/apiserver/src/tasks/verification-subject-guard-removal.pg.spec.ts:236`（关系+列）、`:253`（触发器）
* `src/apiserver/src/tasks/failure-continuation-removal.pg.spec.ts:496`
* `src/apiserver/src/outcome-reconciler/watchdog-coordinator-removal.pg.spec.ts:184`
* 0223 那条移除普查的 pg spec，`src/apiserver/src/projects/` 下、文件名取自 0217 建又被 0223 删的那张表，`:167`。
  **本文刻意不把那个文件名拼出来**：它的兄弟单元档有一条全树扫描，禁止任何 live source（含 `docs/`）
  拼出那条已删通道的词汇，而这份设计稿在扫描范围内——2026-09-09 实测，写全路径会直接把那条普查打红。
* `src/apiserver/src/tasks/task-judgment-data-preserved.pg.spec.ts:169`
* `src/apiserver/src/outcome-reconciler/canonical-done-gate-removal.pg.spec.ts:193`（`project` 上的触发器名）
* `src/apiserver/src/tasks/executable-acceptance-runtime-removal.pg.spec.ts:418`（同上）

（`src/apiserver/src/common/completion-ack-removal-preserved.pg.spec.ts:68` 和
`src/apiserver/src/common/completion-ack-removal.pg.spec.ts:134` 用的是 `>= 1` 下界，不会因新增打红。）

**推论：职责分离（项目验收第 6 条）需要的「作者会话」不能作为一列加在
`project_acceptance_criterion_definition` 上——那会一次打红三处逐列普查。**
它必须是自己的表，前缀不带 `project_acceptance_`：建议 `project_criteria_authorship`
（每 `(definition_id, revision)` 一行，记 `authored_by_session_id` / `authored_by_type` / `authored_at`）。

---

## 二、0229 之后项目 DONE 到底怎么派生的

**0229 删的是闸，2026-09-08 重新议过之后，DONE 变成了一个投影。** 判定代码在
`src/apiserver/src/projects/project-done-derived.ts`，整文件都是它。

### 2.1 规则本体

`deriveProjectDone`，`src/apiserver/src/projects/project-done-derived.ts:109-126`。一个**四子句合取**，
不短路（每条不成立的都报出来）：

| 子句 | 代码 | 含义 |
| --- | --- | --- |
| `NO_CRITERIA_STATED` | `:114` | 一条标准都没有 → 不能 DONE（拒绝空集的空洞真） |
| `CRITERION_UNSATISFIED` | `:115` | 有标准的服务工作没按自己声明的判据结算 |
| `CRITERION_UNLANDED` | `:116` | 有标准没有落到默认分支的合并回执（`!== 'LANDED'`，`UNKNOWN` 也算没有） |
| `STANDARD_SET_UNCONFIRMED` | `:117` | **没有所有者确认，或确认名的是已经被改过的那一版** |

`status = done ? DONE : OPEN`（`:120`）。`withheld` 为空当且仅当 done。

### 2.2 它读哪些输入（`readDerivedProjectDone`，`:141-181`）

一个 `Promise.all` 四路并发：

1. `prisma.projectAcceptanceCriterionDefinition.findMany`（`:147-159`），
   select 出 `id, ordinal, text, verificationMethod, completionCriterionOverrideReason, revision, contentHash`
   ——**恰好是 `criteriaFromDefinitions` → `standardSetVersion` 需要的那些列**；
2. `readCriterionSatisfaction`（`:160`，实现 `project-criterion-satisfaction.ts`，三子句：
   `NO_WORK_SERVES_IT` / `SERVING_WORK_UNSETTLED` / `DECLARATION_STALE`）；
3. `readCriterionLanding`（`:161`，实现 `project-criterion-landing.ts`，读合并回执）；
4. `latestConfirmation`（`:162`，实现在 `:233-253`：
   `project_standard_set_confirmation` 按 `(confirmedAt desc, id desc)` 取最新一行）。

然后 `:174-180`：

```
deriveProjectDone(
  criteria,                                     // satisfied + landing 每条一项
  standardSetConfirmationStanding(
    standardSetVersion(criteriaFromDefinitions(definitions)),   // ← 今天的 seal
    confirmation,                                               // ← 确认行名的那个 seal
  ).state,
)
```

**这就是「结算要求两者相等」。** 它已经在 main 上。

### 2.3 谁把它写回列（`storeDerivedProjectStatus`，`:213-228`）

`updateMany` 带 compare-and-set（`where.status` 取反向值，`:223`），双向：可以把 DONE 拿回 OPEN；
`CANCELLED` 两个方向都不碰（`:205-207`）。

调用点（本轮要新增第三个）：

* `ProjectsService.update` 的提交后边沿——`src/apiserver/src/projects/projects.service.ts:2060-2062`
  （`if (dto.acceptanceCriteriaItems !== undefined) await this.reprojectProjectStatus(ownerId, id)`）；
* `ProjectAcceptanceService.confirmStandardSet` 的 INSERT 之后——
  `src/apiserver/src/projects/project-acceptance.service.ts:212-217`。

它**不是闸**：`src/apiserver/src/projects/project-done-derived.ts:39-42` 明写「A gate refuses somebody's write. This refuses
nobody」，并且不经 `ProjectsService.update`（`:195-197`），因此不会撞
`refuseProjectStatusWrite`。

### 2.4 对本项目的直接影响（重要）

**项目验收第 5 条（`2cL4OUGvV5mdwfMstrRsrq`，任务 `34LYWa8N774MGOvE7LYK7`）描述的机器已经在 main 上。**
项目描述写的「0226 删了 owner 确认表」是 2026-09-08 之前的状态；`0245` 把确认行补回来了，
`36e62c76` / `4151625b` 把投影接上了。

所以那条任务**不是「实现它」，是「为它写出第一次必须真红的 spec」**，并把新的 seal 语义
（加严之后旧确认变 `STALE`）钉进去。写之前先照 `zero-row-acceptance-clause-needs-a-sibling-that-produces`
的口径：断言「推不出 DONE」必须配一条同夹具内**确实推出了 DONE** 的兄弟，否则是永真。

---

## 三、`ProjectRatifiedActionIntent` / `ProjectRatifiedActionCommit` 的不可变触发器约束了什么

模型在 `src/apiserver/prisma/schema.prisma:2055` / `:2081`，DDL 在
`src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:266` / `:289`。
**全仓零应用调用方**：唯一提到它们的非 spec 文件是
`src/apiserver/src/common/db-write-inventory.ts:1138`、`:1139`（触发器登记）。

### 3.1 逐条列出

| # | 对象 | 位置 | 约束的事 |
| --- | --- | --- | --- |
| 1 | `project_ratified_action_intent_immutable`（BEFORE UPDATE OR DELETE，逐行） | `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:316-329` | **任何 UPDATE 与 DELETE 一律 `RAISE`** `RATIFIED_ACTION_INTENT_IMMUTABLE`。唯一逃逸：`TG_OP='DELETE'` 且 `project` 行已不存在（外键 CASCADE 收尾），`:318-320` |
| 2 | `project_ratified_action_commit_immutable`（BEFORE UPDATE OR DELETE） | `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:331-344` | 同上，码是 `RATIFIED_ACTION_COMMIT_IMMUTABLE`；同一条 CASCADE 逃逸 |
| 3 | `project_owner_ratification_immutable` | `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:301-314` | 同形，作用在 `project_owner_ratification`（**不在本路径上**，见 3.3） |
| 4 | `project_action_intent_bind_full_revision`（**BEFORE INSERT**） | 0196 装（`src/apiserver/prisma/migrations/0196_outcome_binding_version_invalidation/migration.sql:312-314`），现役函数体是 `src/apiserver/prisma/migrations/0222_canonical_done_gate_removal/migration.sql:316-330` | INSERT 时按 `(project_id, contract_digest)` 反查 `project_completion_contract.contract_revision`；**查不到就 `RAISE RATIFIED_ACTION_BINDING_STALE`（SQLSTATE 40001）**，查到就覆写 `NEW.contract_revision` |
| 5 | 列级 CHECK | `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:270-280` | `principal_type IN ('SYSTEM','AGENT','RUNNER','OWNER','SERVICE')`；`trigger_kind IN ('AUTO','MANUAL')`；`budget_charge >= 0` |
| 6 | 唯一性 | `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:285-287` | `commit_token` UNIQUE；`UNIQUE(owner_id, project_id, idempotency_key)` |
| 7 | commit 的形状 | `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:289-296` | `intent_id` 是 PK 且外键指向 intent → **一条 intent 至多一条 commit**，重复 APPROVE 由 PK 直接挡掉 |
| 8 | 预算索引 | `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:298-299` | `(project_id, contract_digest, committed_at DESC)`；唯一读者是 24 小时预算求和 `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:1260-1263` |

### 3.2 「削弱 intent 能不能原样落在它上面」

**能，而且该落——但它只收得下提案，收不下答案。** 逐条对账：

能用的（正好是项目约束点名要复用的那几样）：

* `action JSONB` + `action_digest CHAR(64)`（`src/apiserver/prisma/schema.prisma:2071-2072`）——放「改成什么样」和它的摘要，
  项目验收第 2 条要的「actionDigest 可由请求内容重算得到」有落点；
* `commit_token UUID UNIQUE`（`:2074`）——一次性钥匙，决定门第一把；
* `UNIQUE(owner_id, project_id, idempotency_key)`（`:2077`）——同一次写入重发不会长出第二条提案；
* 触发器 1 保证提案**写下就不能改**——这正是「被考的人不能事后改自己的提案」。

缺的（四样，都要补）：

1. **没有 status 列，而且 UPDATE 被触发器 1 一律拒绝。**
   `PENDING → APPROVED/REJECTED` 这个状态机在这张表上**根本写不出来**。
   「待决」只能派生：*没有决定行的 intent 就是待决*。
2. **REJECT 没有落点。** `project_ratified_action_commit` 只表达「被 commit 了」。
   驳回一次削弱之后，没有任何行说它被驳回过——于是那把 `commit_token` 永远有效，
   卡片永远待决。项目验收第 4 条明写「intent 已 settled」要被 typed 拒绝，
   **没有 REJECT 落点就没有 settled**。
3. **没有「谁批的」。** commit 行只有 `owner_id`（租户），
   没有 `decided_by_id`。仓库里同类事实（`project_standard_set_confirmation.confirmed_by_id`
   `src/apiserver/prisma/schema.prisma:2027`、`task_evidence_decision.decided_by_id`）都单独记了「谁做的」。
   项目验收第 4 条的「记录批准」在这张表上没有列。
4. **绑的是 `contract_digest`，不是 seal。** 见 1.3：太紧（改 `maxConcurrentTasks` 就让待决提案作废）
   又不可读（摘要不说明台面上是哪一版标准）。

### 3.3 两条 SQL 入口用不了（这条最容易踩）

`project_submit_ratified_action`（`src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:1132`，0196 包了一层 `src/apiserver/prisma/migrations/0196_outcome_binding_version_invalidation/migration.sql:910`）
和 `project_commit_ratified_action`（`src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:1219`，0222 包了一层 `src/apiserver/prisma/migrations/0222_canonical_done_gate_removal/migration.sql:300`）
**都过不去**：

```sql
-- src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:1189-1191 与 :1252-1255
IF (trigger_kind = 'AUTO' OR effect_class NOT IN
    ('READ_ONLY_ANALYSIS','PLANNING','DISCARDABLE_EXPLORATION')) AND NOT ratified THEN
  -- OWNER_RATIFICATION_REQUIRED
```

`ratified := project_owner_ratification_effective(...)`（现役定义 `src/apiserver/prisma/migrations/0196_outcome_binding_version_invalidation/migration.sql:316`）要求
`project_owner_ratification` 里有一行。而那张表：

* **全仓零写入方**——`project_owner_ratify_contract` / `project_preapproved_ratify_contract`
  在 `src/` 下一个调用点都没有；
* **连 Prisma 模型都没有**——`schema.prisma` 里搜不到 `project_owner_ratification` 的 `@@map`
  （只在 `:2034` 的注释里被提到）。

所以线上没有任何项目是 ratified 的，这两个函数对**任何**削弱提案都只会回
`{ok:false, code:'OWNER_RATIFICATION_REQUIRED'}`。

**落地形状因此是：绕开这两个 SQL 函数，用 Prisma 直接 INSERT intent 行。**
这是安全的，因为写路径上仍然有触发器 4 把关（`contract_digest` 必须是项目当前的），
触发器 1 保证写下即不可改。代价是 `action_digest` 要在 TS 里算，且必须与
`outcome_sha256_json` 同口径（规范化 JSON 后 sha256，仓库里已有
`src/apiserver/src/projects/canonical-json.ts`）——**这一点必须有单元 spec 双向对账**，
否则项目验收第 2 条的「可重算」会有两种定义。

### 3.4 补法（建议）

新建**一张**表，名字不带禁用前缀：

```
project_criteria_decision
  intent_id      uuid PRIMARY KEY REFERENCES project_ratified_action_intent(id) ON DELETE CASCADE
  project_id     uuid NOT NULL
  owner_id       uuid NOT NULL
  decision       text NOT NULL CHECK (decision IN ('APPROVE','REJECT'))
  decided_by_id  uuid NOT NULL            -- 谁答的（不带外键，与 confirmed_by_id 同形）
  base_seal      char(64) NOT NULL        -- 决定时台面上的 seal
  resulting_seal char(64) NOT NULL        -- APPROVE 后的新 seal；REJECT 时 == base_seal
  note           text
  decided_at     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
```

* PK 就是 intent id ⇒ **一条提案至多一个答案**，重复决定由数据库挡掉，不靠服务端比较。
* 「已 settled」的判据 = 这张表里有它的行。**一次查询，两种结局同一个谓词。**
* 不加不可变触发器，与 0245（`src/apiserver/prisma/migrations/0245_project_standard_set_confirmation/migration.sql:38-44`）、0238 同一条理由：唯一写入方是一条 INSERT，
  没有任何代码路径 UPDATE/DELETE 它。
* APPROVE 时**另外**写一行 `project_ratified_action_commit`，`budget_charge` 传 **0**：
  这样 0195 那台两阶段机器的「已 commit」在它自己的表上成立（触发器 7 的 PK 顺便再兜一次重复），
  而 `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:1260-1263` 的 24 小时预算求和一分不动。REJECT 不写 commit 行。

---

## 四、`CoordinatorDeliveryService` 加一种 fact kind 要动哪几处

一共 **8 处必改 + 2 处按路线决定**。0246 是现成的模板（只加事件、什么都不动）。

### 4.1 必改

| # | 位置 | 改什么 |
| --- | --- | --- |
| 1 | `src/apiserver/src/projects/coordinator-wake.ts:79` | 往 `COORDINATOR_WAKE_EVENTS` 里加 `CRITERIA_DECISION_PENDING` |
| 2 | `src/apiserver/src/projects/coordinator-wake.ts`（新函数，抄 `criterionUnlandedFact:530` 的形状） | 造事实：`subjectType: 'PROJECT'`，`subjectVersion` 必须是**被测行的全函数**（建议 `sha256(baseSeal + ':' + actionDigest)`），`detail` 只放展示用信息 |
| 3 | 新迁移 `02NN_criteria_decision_wake/migration.sql` | 照 `src/apiserver/prisma/migrations/0246_project_acceptance_landed_wake/migration.sql:36-56` **整张清单重写** `project_coordinator_wake_event_chk`（不能只 relax） |
| 4 | `src/apiserver/src/projects/coordinator-wake.spec.ts:296-303` | 那条三方对账 spec **硬编码了 `0246_project_acceptance_landed_wake` 的路径**，必须改指向新迁移，否则新事件在 TS 侧有、在被读的迁移里没有，断言直接红 |
| 5 | `src/apiserver/src/projects/coordinator-judgment-opening.ts:60` `describeWakeFact` | 加一个 `case`。⚠️ 这个 `switch` 有 `default`（`:118`），**漏写不会编译报错**，只会静默降级成 `发生了 X，主体是 …`——这是这条链上唯一一处「忘了也不红」的地方 |
| 6 | `src/apiserver/src/projects/coordinator-judgment-opening.ts:281` `buildCoordinatorDeliveryMessage` | 加卡片正文分支。抄 `:287` 的 `PROJECT_ACCEPTANCE_LANDED` 分支：它是唯一一条**把项目状态快照抄进消息**的卡（理由在 `:259-268`），削弱决定卡同理——问的是「这个 diff 该不该生效」，不带 diff 的问题没法答 |
| 7 | `src/apiserver/src/common/db-write-inventory.ts` | 登记新的写入点（intent INSERT、decision INSERT、commit INSERT）与新触发器；`src/apiserver/src/tasks/failure-continuation-removal.pg.spec.ts:243-254` 拿它和活库逐条对账 |
| 8 | 生产者本身 | 在决定门/改路写入的提交后边沿调用投递（见 4.2） |

### 4.2 两处按路线决定 —— **推荐走 `deliver` 直连，不走 `openIfDecisive`**

`src/apiserver/src/projects/wake-disposition.ts:196` 的 `wakeDisposition` 现在只有一条投递分支：

```
:200  if (任一 criterion 是 STRANDED) return 'OPEN_JUDGMENT';
:201  if (event === 'CRITERION_UNLANDED' && 任一 BACKED 且未 LANDED) return 'DELIVER_TO_COORDINATOR';
:206  return 'RECORD_ONLY';
```

而 `WakeDispositionService.statesOf`（`src/apiserver/src/projects/wake-disposition.service.ts:261`）对
`subjectType === 'PROJECT'` **返回 `[]`**（`:283`，两个 `if` 都不命中）。
`wakeDisposition(event, [])` ⇒ `RECORD_ONLY` ⇒ `openIfDecisive` 返回 `null` ⇒
**事实被记录，卡片永远发不出去，而且没有任何 REFUSED 行可查。**

所以两条路：

* **推荐**：像 `ProjectTasksSettledProducer` 那样直接调 `CoordinatorDeliveryService.deliver`
  （`src/apiserver/src/projects/project-tasks-settled.producer.ts:171-174`
  ——`PROJECT_ACCEPTANCE_LANDED` 走的就是这条）。这样 `wake-disposition.ts` 与
  `wake-disposition.service.ts` **一行都不用改**，也不用给 `completion-input-router` 加门。
* 备选（不推荐）：给 `wakeDisposition` 加分支 + 给 `statesOf` 加 `PROJECT` 分支。
  两个文件都是「一个规则一个家」的单元，为一条与 criterion coverage 无关的事实开分支，
  等于把 §2.1 那条「事件只选读哪一维，答案仍来自 criterion 自己的行」的论证掰断。

`completion-input-router.service.ts` **不用动**：`COMPLETION_INPUT_CONSUMERS`
（`src/apiserver/src/projects/completion-input.ts:13`）是被 `consumer_type` 的 CHECK 钉死的闭集，
且只有 `JUDGMENT_REQUEST_DERIVER` 还在写。走 `deliver` 的终态是 `DELIVERED`，不需要 consumer。

### 4.3 投递侧还要知道的三件事

* 卡片按钮要的「现在能不能答」不能由 agent 转述。先例在
  `src/apiserver/src/projects/coordinator-delivery.service.ts:288`：`COMPLETION_EVIDENCE_REVISED` 在**投递时**替对话读了一次
  待决队列（`:336-344` 的 `evidenceAsk`），把 `readAt` 一起写进消息。削弱决定卡照抄这个形状。
* 消息的 turn 幂等键是事实的全函数（`src/apiserver/src/projects/coordinator-delivery.service.ts:217`
  `coordinatorDeliveryTurnId`），所以同一条事实重投不会说两遍。
* 投不进去（没 coordinator / 对话已终态 / `resume` 拒了）会 `release` 把钥匙还回去
  （`:354-396`），事实下次再派生时重来。**卡片不是队列，派生读才是地板**
  ——`src/apiserver/src/projects/completion-input-router.service.ts:160-195` 那段论证对削弱决定卡逐字适用。

---

## 五、决定门的确切请求 / 响应形状

### 5.1 路由与鉴权

```
POST /projects/:id/acceptance/criteria-decisions/:intentId
```

* 与 `POST /projects/:id/acceptance/confirmation`（`src/apiserver/src/projects/projects.controller.ts:351`）同一条 rail。
* **必须是账号所有者认证通道、且不带 acting session**，与 `CONFIRM_ACCEPTANCE_CRITERIA` 同规则：
  新增 `refuseSessionAuthoredCriteriaDecision`，抄 `src/apiserver/src/projects/coordinator-authority.ts:333`
  `refuseSessionAuthoredConfirmation` 的形状，自己的码
  `PROJECT_CRITERIA_DECISION_OWNER_CHANNEL_ONLY`（§12 E2：一条规则一种拼法，两条规则两个码）。
  **规则放在 service 里，不放 controller**——理由与 `src/apiserver/src/projects/project-acceptance.service.ts:149-152` 相同。

### 5.2 请求

```ts
export class DecideCriteriaChangeDto {
  /** intent 的一次性钥匙。绑「改的是什么」。 */
  @Matches(UUID_PATTERN) commitToken!: string;

  @IsIn(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';

  /** 卡片渲染时台面上的 seal。绑「对着哪一版答的」。 */
  @Matches(SHA256_DIGEST_PATTERN) baseSeal!: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(4_000) note?: string;
}
```

两把钥匙：`commitToken`（请求体里，绑动作）+ 所有者凭据（认证层，绑人）。
`baseSeal` 是第三个绑定，绑时刻——它不是钥匙，是**新鲜度**，所以它的失败码与钥匙的失败码不同。

### 5.3 四条 typed 拒绝（项目验收第 4 条逐条对应）

| 情形 | HTTP | code | 附带 | 断言「definition 未变」 |
| --- | --- | --- | --- | --- |
| 缺任一钥匙：带了 acting session | 403 | `PROJECT_CRITERIA_DECISION_OWNER_CHANNEL_ONLY` | `requiredAction: 'ASK_A_PERSON'` | ✅ |
| 缺任一钥匙：`commitToken` 缺失/格式错 | 400 | `PROJECT_CRITERIA_DECISION_KEY_MISSING` | — | ✅ |
| `commitToken` 与该 intent 不符 | 403 | `PROJECT_CRITERIA_DECISION_TOKEN_INVALID` | — | ✅ |
| intent 已 settled | 409 | `PROJECT_CRITERIA_DECISION_ALREADY_SETTLED` | `settledAs: 'APPROVE'\|'REJECT'`, `decidedAt` | ✅ |
| base seal 已移动 | 409 | `PROJECT_CRITERIA_DECISION_BASE_SEAL_MOVED` | `currentSeal` | ✅ |

> 顺序固定：鉴权 → 钥匙 → 已决 → seal。理由与 `confirmStandardSet` 一致：
> 先答「你有没有资格问」，再答「你问的是不是还在」。

### 5.4 成功响应（200）

```jsonc
{
  "intentId": "<publicId>",
  "decision": "APPROVE",
  "decidedAt": "2026-09-09T…Z",
  "decidedById": "<publicId>",
  "baseSeal":      "<64 hex>",
  "resultingSeal": "<64 hex>",     // REJECT 时 === baseSeal
  "applied": true,                  // 仅 APPROVE 为 true
  "acceptanceCriteriaItems": [ /* 这一刻在册的标准，形状同 project_get */ ],
  "confirmation": {                 // 抄 standardSetConfirmationStanding 的形状
    "state": "STALE",               // APPROVE 之后必然 STALE：seal 动了
    "confirmed": false,
    "currentVersion": { "digest": "<64 hex>", "material": [ … ] },
    "confirmation": { "criteriaDigest": "…", "confirmedAt": "…", "confirmedById": "…" }
  }
}
```

响应把 `confirmation` 一起带回来，是为了让调用方**当场看见 APPROVE 的第二个后果**：
削弱生效 ⇒ seal 前进 ⇒ 旧确认失效 ⇒ 项目退出 DONE。这不是附赠信息，是这次改动最重要的那一半。

### 5.5 事务边界

一个 `withTransactionRetry`：

1. `SELECT … FROM project WHERE id=… AND owner_id=… FOR NO KEY UPDATE`（与
   `src/apiserver/src/projects/projects.service.ts:1975-1986` 同一把锁、同一个顺序）；
2. 锁内重读 seal，与 `baseSeal` 比较（不等 → 抛，整条回滚）；
3. 读 intent + 校验 `commitToken`；查 `project_criteria_decision` 有无行（有 → 抛）；
4. APPROVE：把 intent 的 `action` 应用成一次 `replaceAcceptanceDefinitions`；
5. 锁内重读 seal ⇒ `resultingSeal`（**必须读回来，不能在 TS 里算——见 1.1 的陷阱**）；
6. INSERT `project_criteria_decision`；APPROVE 时另 INSERT `project_ratified_action_commit`
   （`budget_charge = 0`）。

提交后（事务外，与 `confirmStandardSet:212-217` 同形，失败只 warn 不回滚决定）：

7. `storeDerivedProjectStatus(prisma, ownerId, projectId)`；
8. 投递一条 `CRITERIA_DECISION_PENDING` 的**结算**通知或直接不投——决定门本身不产生新的待决卡。

> 数据库侧的最后一道兜底不是这段代码：`project_criteria_decision.intent_id` 是主键，
> 所以「同一条提案被答两次」即使两个请求同时穿过第 3 步，也只有一个能提交。

---

## 六、后续每个任务要新建的 spec 文件清单

任务的验收命令已经把主 spec 文件名钉死了，下表按任务列出**主 spec（已定）**与**必须一起写/改的其他 spec**。

| 任务 | 主 spec（验收命令已钉） | 还要新建 / 修改 |
| --- | --- | --- |
| `34LYWZv78m6RcER0Bh2qy` 分类器 | `npm run test:outcome-reconciler:fast-gate` | **新建** `src/apiserver/src/projects/criteria-change-classifier.spec.ts`（纯函数：加严/削弱/判不出，含「只改 verificationMethod 措辞」归削弱那一例）<br>**新建** `src/apiserver/src/projects/criteria-action-digest.spec.ts`（TS 的 `actionDigest` 与 `outcome_sha256_json` 同口径的双向对账，见 3.3） |
| `34LYWZyuovvutwn0gfKTm` seal 落库 + 加严当场生效 | `src/apiserver/src/projects/criteria-seal-additive.pg.spec.ts` | **修改** `src/apiserver/src/projects/project-acceptance.spec.ts`（seal 语义补例：改 verificationMethod 必须动 seal）<br>**新建** `src/apiserver/src/projects/criteria-authorship.pg.spec.ts`（`project_criteria_authorship` 每 `(definitionId, revision)` 一行，为第 6 条铺路） |
| `34LYWa0rmVyYZjANGWZT0` 削弱改路 | `src/apiserver/src/projects/criteria-weakening-intent.pg.spec.ts` | 无新增；但这条 spec 必须自带**阳性对照**（同夹具内先证明一次加严确实写进去了），否则「削弱没生效」是永真 |
| `34LYWa36gpESAe40j9IMy` 决定门 | `src/apiserver/src/projects/criteria-decision-door.pg.spec.ts` | **新建** `src/apiserver/src/projects/criteria-decision-authority.spec.ts`（`refuseSessionAuthoredCriteriaDecision` 的纯函数 spec，抄 `coordinator-authority.spec.ts` 的形状）<br>**修改** `src/apiserver/src/common/db-write-inventory.ts` + 让 `src/apiserver/src/tasks/failure-continuation-removal.pg.spec.ts:243` 的对账仍成立 |
| `34LYWa5vtQkAhAyzor77r` 待决派生读 + 投递 | `src/apiserver/src/projects/criteria-pending-decisions.pg.spec.ts` | **修改** `src/apiserver/src/projects/coordinator-wake.spec.ts:296`（改指新迁移，见 4.1 #4）<br>**新建** `src/apiserver/src/projects/criteria-decision-card-copy.spec.ts`（`describeWakeFact` / `buildCoordinatorDeliveryMessage` 的文案谓词——`describeWakeFact` 漏 case 不会编译报错，只有这条能抓）<br>**新建** `src/apiserver/src/projects/criteria-decision-delivery.pg.spec.ts`（事实 → 一条 turn；投不进去要释放钥匙） |
| `34LYWa8N774MGOvE7LYK7` 结算闸一 | `src/apiserver/src/projects/criteria-settlement-seal.pg.spec.ts` | 无新增。**注意二节 2.4：机器已在 main，这条 spec 第一次必须真红**——先证明它能红（临时把 `deriveProjectDone:117` 那句删掉跑一次），再证明它绿 |
| `34LYWaAc0Qdc7m6AEVFqC` 结算闸二 | `src/apiserver/src/projects/criteria-settlement-independence.pg.spec.ts` | 依赖 `project_criteria_authorship`；**修改** `src/apiserver/src/projects/project-done-derived.pg.spec.ts`（新增第五条 withheld 子句 `CRITERION_AUTHORED_BY_ITS_OWN_EVIDENCE` 的用例） |
| `34LYWaGAWRcXKwnVNzGzo` web | `src/web/src/components/CriteriaDecisionCard.test.tsx` | 三种过期输入 → 按钮 disabled。⚠️ 断 disabled 样式前先剔 `:not(:disabled)`，阴性必须先红 |
| `34LYWaM7EToV6CpqQf35n` iOS | EVIDENCE_JUDGMENT（发 beta + 所有者截图） | 无 spec；`ApprovalCards.swift` 已定稿口径别改（全宽按钮 34pt 写进 `label:`，选项行 44pt） |

### 6.1 迁移编号

下一号是 **`0247`**（现存最大 `0246_project_acceptance_landed_wake`）。
本轮至少三个迁移：`0247` 新建 `project_criteria_decision`、`0248` 新建
`project_criteria_authorship`、`0249` 扩 wake 事件 CHECK（也可以并进 `0247`，
但并进去会让 `coordinator-wake.spec.ts` 那条对账读到一个既建表又改 CHECK 的文件，可读性差）。
**并行分支会撞号，开工前重查 `ls prisma/migrations | tail -3`。**

### 6.2 跑法（分层，别每个任务跑 full-api）

* 单元 spec / 分类器：`npm run test:outcome-reconciler:fast-gate`（16~53s）。
  **它看不见 `.pg.spec` 也看不见只动 `prisma/migrations` 的改动。**
* pg spec 当验收**必须** `bash scripts/run-pg-spec.sh <path>`（**skip 即红**，约 37s/条）；
  直接 `node --test` 会全 SKIP 且 exit 0，是假绿。
* `npm run test:outcome-reconciler:full-api`（14~20min）只在合并边界跑一次。
* 前缀普查（1.7 列的那 9 处）只在 full-api 里跑到，所以**合并前那一次不能省**。

---

## 七、要 coordinator 确认的三处偏差

1. **「加严自动重新封存、已有确认顺延」在本设计里不成立**（见 1.6）。
   seal 是活行的全函数，加严把 seal 推走 ⇒ 旧确认变 `STALE` ⇒ 需要重新确认。
   要做到「顺延」，只能让确认绑一个**比 seal 更窄**的身份（例如只绑被删/被放宽的那几条），
   那等于承认「加严不算改尺子」，而加严也是改尺子。
   **建议按现状落地（加严也要求重新确认），并把这一句写进卡片文案**，
   因为重新确认的成本是一次点击，而「悄悄顺延」的成本是一个所有者从没看过的标准集被当成他确认过的。

2. **削弱提案的失效条件建议用 seal，不用 `contractDigest`**（见 1.3、3.2 第 4 条）。
   代价：0195 那台机器原本的失效语义被换掉了一半。收益：一次 `maxConcurrentTasks` 的改动
   不会把所有者面前的卡片作废。

3. **APPROVE 时是否要写 `project_ratified_action_commit`**（见 3.4）。
   建议写，`budget_charge = 0`。不写也能工作，写的收益是 0195 的两阶段机器在它自己的表上仍然自洽。

---

## 附：本文引用的关键位置速查

* seal 本体：`src/apiserver/src/projects/project-acceptance.ts:110`、`:151`、`:194`
* DONE 投影：`src/apiserver/src/projects/project-done-derived.ts:109`、`:141`、`:213`
* 标准写入路径：`src/apiserver/src/projects/projects.service.ts:831`（覆写点）、`:2002`（update 里的调用）
* 确认写入方：`src/apiserver/src/projects/project-acceptance.service.ts:165`
* 确认闸：`src/apiserver/src/projects/coordinator-authority.ts:333`
* intent/commit：`src/apiserver/prisma/schema.prisma:2055`、`:2081`；
  DDL `src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:266`
* 不可变触发器：`src/apiserver/prisma/migrations/0195_project_owner_ratification/migration.sql:316`、`:331`；INSERT 闸 `src/apiserver/prisma/migrations/0222_canonical_done_gate_removal/migration.sql:316`
* wake 事件闭集：`src/apiserver/src/projects/coordinator-wake.ts:79`；
  CHECK 模板 `src/apiserver/prisma/migrations/0246_project_acceptance_landed_wake/migration.sql:36`
* 投递：`src/apiserver/src/projects/coordinator-delivery.service.ts:236`、`:256`；
  卡片文案 `src/apiserver/src/projects/coordinator-judgment-opening.ts:281`
* 处置规则：`src/apiserver/src/projects/wake-disposition.ts:196`；
  服务 `src/apiserver/src/projects/wake-disposition.service.ts:133`、`:261`
* 直连投递先例：`src/apiserver/src/projects/project-tasks-settled.producer.ts:173`
