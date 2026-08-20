# 单元 23 — 独立项目级验收与 feat/project 合并审计

**被验对象**：`feat/project` @ `1144099ce7935023296d305fb0159c2eac66f763`
**审计工作树**：`/root/.orbit/worktrees/pcc23-349bQHCJ-20260820`（分支 `orbit/23-project-acceptance-349bQHCJ`，从 `1144099c` 新建）
**执行日期**：2026-08-20
**方式**：不沿用单元 22 的自评结论。所有数字都是本次重新跑出来的；两条被单元 22 列为"遗留"的偏差（F-22-02 / F-22-04）由本单元从契约原文与实现源码独立裁决。

---

## 裁决

**NOT ALL PASS — Project 保持 OPEN。**

12 条项目级验收标准中 **10 条 PASS、2 条 FAIL**（标准 8、标准 12）。
两条 FAIL 各自有一条可证伪的判据，写在下面 §3。

---

## 1. 环境

| 项 | 值 |
| --- | --- |
| 平台 | Linux 6.12.38+deb13-cloud-amd64 |
| Node | v22.22.2 |
| Go | 见 `src/runner-go/go.mod` 工具链，`go test` 本机默认 |
| PostgreSQL | `postgres:16-alpine`，一次性容器，跑完即删 |
| Prisma | 5.22.0，`@prisma/client` 与 `.prisma` 为**本工作树实体副本**并按本分支 schema 重新 `generate`，未触碰 `/root/orbit` 的共享 client |
| `@orbit/shared` | 软链指向**本工作树** `src/shared`，并在跑任何测试前 `tsc -p tsconfig.json` 重新构建（本分支改过 `codec.ts` / `enums.ts`，指向 main 的软链会造成假绿/假红） |
| 一次性数据库 | `pcc23_e2e`(55473) · `pcc23_tmpl`+`pcc23_s1..s26`(55474) · `pcc23_faults`(55475) · `pcc23_mut`(55476)，全部随容器销毁 |
| 共享 `orbit-postgres` | **只读**：仅 `SELECT` 任务/评论/迁移清单，未写入、未建库、未 exec 任何 DDL |

---

## 2. 本次重新跑出来的证据

### 2.1 一键端到端（`scripts/project-e2e.sh`）

```
PCC_E2E_CONTAINER=pcc23-e2e-pg16 PCC_E2E_PORT=55473 PCC_E2E_DB=pcc23_e2e \
PCC_E2E_USER=pcc23_admin PCC_E2E_PASSWORD=pcc23_e2e_pw bash scripts/project-e2e.sh
```

```
==> server identity: database=pcc23_e2e role=pcc23_admin system_identifier=7676231811654053927
==> 141 migrations applied              # 空库 prisma migrate deploy
==> acceptance suite  : # tests 28 / # pass 28 / # fail 0
==> recovery suite    : # tests 16 / # pass 16 / # fail 0
==> liveness audit clean                # scripts/project-liveness-audit.sql 零行
==> OK                                  # EXIT=0
```

28+16 条用例全绿，其中 **42 条是具名验收场景**（另 2 条是两套件各自的顶层包装用例）：AC11×4、AC1×4、AC4×4、AC5×2、AC6×2、AC7×2、AC8×6、AC10×3（=27，acceptance）与 AC2×6、AC9×5、AC3×4（=15，recovery）。场景名与单元 22 报告逐条对得上。

### 2.2 这套端到端不是空转的（独立变异探针）

只把生产实现改一个字面量：`projects.service.ts:428` 新建项目的默认策略 `GUARDED_AUTO → AUTO`，其余不动，重跑同一条命令：

```
==> acceptance suite : # tests 28 / # pass 26 / # fail 2   EXIT=1
   not ok 5 - AC1: a project recorded in a session is bound to it in one insert
```

改动已还原（`git status` 无 tracked diff）。**结论：标准 4 的默认级别一旦被改，套件会红**——它是承重的，不是恒真断言。

### 2.3 PostgreSQL 集成 / 故障注入套件（26 个 `.pg.spec`，各自独立库）

模板库跑一次 141 条迁移，之后每个 spec `CREATE DATABASE … TEMPLATE`，串行执行：

```
（每行为 node --test 的 `# tests` / `# pass`；有些 spec 把整个文件组织成一个带 subtest 的顶层用例，故计数为 1）

coordinator-04r-adversarial              3/3      project-coordinator-driver          6/6
coordinator-04r3-adversarial            12/12     project-coordinator-session         1/1
coordinator-companions                   8/8      project-decision                    1/1
coordinator-final-row                   16/16     project-dispatch-boundary-verif.   17/16 (1 skip)
coordinator-identity-migration           8/8      project-dispatch-boundary           1/1
coordinator-identity-provenance         11/11     project-event-sources               4/4
coordinator-identity-service             8/8      project-events-fault-injection      5/5
coordinator-linearization               44/44     project-events                      7/7
coordinator-service-linearization        9/9      project-reconcile-fault-injection   7/7 *
project-authorization                    1/1      project-reconcile                   1/1
project-availability-event-sources       1/1      task-aggregation                   25/25
project-blocker                         15/15     task-verification-verdict          17/17
project-control-surface                  5/5      verify18-control-loop               5/5

合计：26 spec / 238 tests / 237 pass / 0 fail / 1 skipped
```

`*` `project-reconcile-fault-injection` 必须从它**自己**的构建树跑：spec 里 spawn 的子进程 `require('./build-project-reconcile-faults/projects/project-reconcile.service.js')`，从 `build/` 跑会得到一个 `MODULE_NOT_FOUND` 的子进程失败（首次误跑得到 5/7）。按 `docs/project-reconcile-validation-10.md` 的原命令先 `tsc -p tsconfig.project-reconcile-faults.json` 再跑，为 **7/7**。这是跑法问题，不是产品缺陷，但值得写下来：这个 spec 有一个不在 `tsconfig.test.json` 里的前置构建步骤。

### 2.4 回归

| 命令 | 结果 |
| --- | --- |
| `tsc -p tsconfig.test.json` | exit 0 |
| `tsc -p tsconfig.project-reconcile-faults.json` | exit 0 |
| `node --test "build/**/*.spec.js"`（不设 `COORDINATOR_PG_URL`） | tests 2143 / **pass 1927 / fail 0** / skipped 216 |
| `src/web` `vitest run` | **54 文件 / 797 通过 / 0 失败** |
| `go test -v -run Project ./...` | **87 PASS / 1 FAIL** |

Go 的那 1 条是 `TestKimiFindProjectRootFallsBackToCWD`。本次在 `/root/orbit`（`main` @ `07eefde9`）上逐字复跑，**同样 FAIL**：

```
--- FAIL: TestKimiFindProjectRootFallsBackToCWD (0.00s)
    kimi_mcp_guard_test.go:47: kimiFindProjectRoot() = "/tmp", want cwd ".../not-a-repo/nested"
```

与本项目无关的既有环境依赖红，**不计入本次验收**。

---

## 3. 12 条标准逐条裁决

| # | 标准 | 裁决 | 本次证据 |
| --- | --- | --- | --- |
| 1 | 稳定 coordinatorAgent + 默认 Workspace；Session 可轮换可恢复；公开 ID 全 Base62 | **PASS** | AC1×4 全绿（一条 INSERT 同时落 binding/membership/runtime；重复认领 409；环自己 ROTATE 且 WHO/WHERE 不变；5 个读接口无裸 UUID）。独立复核 `publicIdempotencyKey()` / `publicizeIds()`：**字符串内嵌的 UUID 也被替换**（`pc:v1:<uuid>:…` 这类机器键不会泄漏裸 id） |
| 2 | 事务 outbox；重复 / 乱序 / 崩溃 / 重启不重复执行 | **PASS** | AC2×6 全绿，含真实 SIGKILL（commit 前回滚、commit 后不重放）与真实 `docker stop/start` |
| 3 | 可测试活性约束：OPEN 且非等待人工时限内启动下一任务，或持久化阻塞原因/责任人/所需动作/下次检查 | **PASS** | AC3×4 全绿 + 全库 `project-liveness-audit.sql` 零行。审计本身可证伪（AC3 场景 12 手工停钟必须变红）。独立读过 SQL：四子句是 §10.3 的析取，dead-letter 走的 (d)「未来唤醒 + 原因」是契约自己承认的合法形状，故**标准 3 不因 F-22-02 而 FAIL**（见下） |
| 4 | manual / guarded-auto / auto + 权限、并发、预算、重试、退避、审批边界；默认 guarded-auto | **PASS** | AC4×4 全绿；源码复核 `projects.service.ts:428` 新建项目显式写 `GUARDED_AUTO`（列默认是 `MANUAL`/`false`，专供存量行），§2.2 的变异探针证明这条被测试守住 |
| 5 | 一致快照 + 每次判断的输入/决策/动作/幂等键 | **PASS** | AC5×2 全绿（决策逐字节 replay；同键动作 exactly-once）。F-22-04 见 §3.2：**文档偏差，不影响本条** |
| 6 | 验证失败可原生退回 / 建缺陷子任务 / 阻断下游 | **PASS** | AC6×2 + `task-verification-verdict` 17/17 + `verify18-control-loop` 5/5 |
| 7 | 父 Task 聚合完成策略 | **PASS** | AC7×2（`ALL_CHILDREN_DONE` / `VERIFICATION_PASSED`）+ `task-aggregation` 25/25 |
| 8 | provider 不可用、无 Runner、合并冲突、测试失败、预算耗尽、等待用户**等情况**都有结构化 blocker 与去重升级；不得静默 fallback | **FAIL** | 枚举的 6 类各有场景且全绿（AC8×6）。**但 F-22-02 落在"等情况"里且没有 blocker** — 见 §3.1 |
| 9 | 崩溃 / Session 结束 / Runner 离线 / 接管 / 混合版本后能恢复，不丢任务、不重复启动、不越权 | **PASS** | AC9×5 全绿，含两实例真实争抢、旧二进制裸 SQL 派发被拒、真实数据库重启 |
| 10 | Web/API/CLI 展示状态、最近决策、下一动作、阻塞原因、下次唤醒、验收证据；有可独立运行的单元/集成/故障注入/迁移测试 | **PASS** | AC10×3 + `project-control-surface` 5/5；`GET /projects/:id/coordinator/status` 十一段齐全，`orbit project status\|verifications` 与 `ProjectCoordinatorPanel.tsx` 各自有测试（web 797 全绿）。**注意**：见 §4，这套控制面**尚未部署**，只能按代码与测试判定 |
| 11 | 既有 Project 默认兼容、不会被意外开启自动推进；迁移后须显式选策略或沿用安全默认 | **PASS** | AC11×4 全绿；独立读迁移 SQL：`0111` 加列即 `coordinator_enabled DEFAULT false` / `automation_policy DEFAULT 'MANUAL'`，`0122` 注释与逻辑均以「pre-0111 行 `coordinator_enabled=false`」为前提；`assertLevelNamedWhenTurningOn` 使「开机但不给 policy」400 且不写任何东西 |
| 12 | 全部任务完成后执行项目级验收并核对合并状态，只有全部通过才可 DONE | **FAIL** | 前置条件未满足 + 存在未关闭 blocker — 见 §3.3 |

### 3.1 F-22-02 — 独立裁决：**FAIL（标准 8）**，P1

**事实（三处，互相矛盾）**

1. `src/apiserver/src/projects/project-events.service.ts:49-52`（接口契约）：
   > `deadLetter` is required rather than a best-effort logger: once the tenth failure marks an event DEAD, the handler **must atomically persist the fail-closed UNKNOWN_FAILURE state** supplied by the blocker unit.
2. 同文件 `:330` 调用点注释：
   > no event can become DEAD **without the durable UNKNOWN_FAILURE record** required of the registered handler.
3. 唯一注册的生产 handler `ProjectReconcileService.deadLetter`（`project-reconcile.service.ts:331-353`）实际只做一件事：把 `project_runtime` 写成 `run_state='PLANNING'`、`next_wake_at = now + 5min`、`next_wake_reason = 'reconcile dead letter: …'`，然后放锁。**没有任何一行写 `project_blocker`。**

冻结契约同样是这么要求的，且不止一处：
- §5.4（`docs/project-coordinator-contract.md:388`）：「超过 10 次进 `DEAD` 并**同时开一条 `UNKNOWN_FAILURE` blocker**（fail closed，§11.3）」
- §11.2 BL2（`:3151`）：「任何 `catch` 到未分类异常的 reconcile **必须开它并停止本项目的自动派发**，直到有人处理」
- 故障表 F22（`:3507`）：「事件消费连续失败 10 次 → 事件置 `DEAD` **且**开 `UNKNOWN_FAILURE` blocker」

**后果（这是为什么它不是文档问题）**

`project-blocker-conditions.ts` 里没有任何一条谓词读 `project_event.disposition`，`openBlockersStoppingDispatch()` 只从 `project_blocker` 取行。所以 dead letter 之后：

- 那条信号被 `consumed_at` + `disposition='DEAD'` **永久丢弃**，不会再被处理；
- 没有 blocker 行 → **派发门没有任何东西可拦**，5 分钟后照常 PLANNING、照常自动派发；
- 没有 `owner` / `required_action` / `next_check_at` / 升级 → **没有人被指派**，也不会升级。

失败若是确定性的（毒 payload 一类），这就是"信号永久消失且无人知晓"。BL2 的 fail-closed 正是为这一格存在的。

**为什么判在标准 8 而不是 2/3**

- 标准 2：dead letter 不造成重复执行，**PASS**。
- 标准 3：§10.3 的四子句是析取，clause (d)「未来唤醒 + 原因」成立，项目**不是**静默空转，**PASS**。差的恰好是 (c) 要的「责任人 + 所需动作」两项 —— 那是 blocker 的字段，不是活性的字段。
- 标准 8 写的是「…等待用户**等情况**都有结构化 blocker 与去重升级机制；不得静默 fallback」。"等情况"是开放枚举，而**契约自己**（§5.4 / F22 / BL2）已经把这一格归类为必须开 `UNKNOWN_FAILURE`。既然规范把它算进来，就不能因为它不在标准 8 的六个例子里而豁免。按协调者要求，不以"没有静默空转"自动放行。

**可证伪判据**（改哪一行、哪条断言会翻）

在 `1144099c` 上，`project-e2e-recovery.pg.spec.ts:339-341` 现在断言的是：

```ts
assert.equal(await services.db.projectBlocker.count({
  where: { projectId: target.projectId, resolvedAt: null } }), 0,
  'F-22-02: today this path raises no blocker — change this assertion when it does');
```

场景标题却叫 `AC2: a batch that never succeeds dead-letters into a named blocker`。**标题与断言互斥**——这本身就是缺陷未闭合的书面证据。
修复判据：`ProjectReconcileService.deadLetter` 在同一事务内按 §11.3 的去重/升级语义插入 `UNKNOWN_FAILURE`（`owner=USER`、`recovery=HUMAN`、五字段齐全）后，上面这条断言必须从 `0` 改为 `≥1`，且 `openBlockersStoppingDispatch` 会因此停掉该项目的自动派发。改完前，本条 FAIL 成立；改完后可复验为 PASS。

### 3.2 F-22-04 — 独立裁决：**不影响标准 5**，P3 文档修正

- 契约 §7.3（`docs/project-coordinator-contract.md:685`）写 `pc:v1:<projectId>:coord-session:<generation+1>`；
- 实现 `project-coordinator-session.ts:121` 写 `pc:v1:${projectId}:rotate:${generation}`。

判据是「有没有第二处按契约拼写自己造这个键」。本次全仓检索：
- `grep -rn "coord-session" --include='*.ts' --include='*.go' --include='*.sql' --include='*.tsx'` → **代码里 0 处**（只出现在契约文档里）；
- 所有生产与测试的产生方**都**调用同一个 `rotateCoordinatorSessionIdempotencyKey()`（decision service、coordinator-session service ×3、两个 spec）。

一个函数造键 → 去重不可能因拼写而失效；键仍然永久、唯一，代次仍来自只进不退的 `coordinator_generation`，满足 §8.2 GE1 / I13。**标准 5 的审计与幂等契约未被破坏**。
遗留动作是**改文档**（把 §7.3 的 `coord-session` 改成 `rotate`），不是改已落库的永久键——改键会让历史动作改名，反而违反 §8.2。本单元刻意不顺手改，以免验收方修改被验对象。

### 3.3 标准 12 — **FAIL（门未满足）**

标准 12 的前置是「全部任务完成后」。截至本次审计，Project `349bHrtPbgwiouD3cfCVP` 的 46 个 Task 中有 3 个不是 DONE（本任务 23 除外）：

| Task | 状态 | Session |
| --- | --- | --- |
| `34A8FPCBxkJsgE1vpBtJe` 04R 新鲜 Codex 独立复审身份迁移与策略持久化 | **FAILED** | FAILED，08-20 04:34 收口 |
| `34A9hr8j41AsVajr3Uo8j` 04R2 GPT-5.6-Sol 独立复审 0113 最终行协调身份 | **IN_PROGRESS** | AWAITING_INPUT（未收口） |
| `34ABi44CV2Iun9MoSFPgz` 04R3 GPT-5.6-Sol 独立复审 0114 身份来源状态机 | **IN_PROGRESS** | AWAITING_INPUT（未收口） |

需要说清楚的是：**04R2 / 04R3 的技术内容已经被后续修复并独立复验过**。两者是钉在各自被验 SHA 上的历史 FAIL 裁决（`e2e426c6` / `f2883075`），修复分别落在 03C / 03D，独立复审 04R4（`34AE0NtfR02I92WqYFxqD`，PASS）在 `d4392b28` 上做，证据提交 `c6e21de5`——本次核对 `c6e21de5` 确为 `1144099c` 的祖先。所以这三条是**流程未收口**，不是技术缺口；但标准 12 的门是流程门，它现在**确实没满足**。

加上 §3.1 的未关闭 blocker，标准 12 双重不满足。

---

## 4. 合并审计

| 检查 | 结果 |
| --- | --- |
| 被验 HEAD | `feat/project` = `1144099ce7935023296d305fb0159c2eac66f763` |
| 与 main 的关系 | merge-base `7074270a`（chore(release): 0.1.127）；feat/project **领先 96 / 落后 4** |
| 与 main 是否冲突 | `git merge-tree --write-tree main feat/project` → **rc=0，无冲突**（结果树 `36648993`） |
| 是否已合入 main | **否**。main 上没有 Project 控制环的任何一条 |
| 文档里引用的提交 | 46 个候选串中 45 个是真提交，**45/45 可从 `1144099c` 到达** |
| 任务评论里引用的提交 | 227 个候选串 → 123 个是真提交，**116 个可达**，7 个不可达，逐个查明如下 |

7 个不可达提交，无一是丢失的交付：

| SHA | 是什么 | 判定 |
| --- | --- | --- |
| `07eefde9` / `12b5ed75` | main 的 HEAD / v0.1.2-beta.44，被引用为"基线红在 main 上同样复现"的对照 | 非交付物 |
| `6f0f1fce` | `On feat/project: autostash` | 中间态 |
| `6fcc243d` | `Merge branch 'feat/project' into orbit/05-project-outbox-381953` | 中间态 |
| `b8af00e7`（含全长） | 单元 05 的**旧** SHA。任务 05 第二条评论明确记录：它经 `6fcc243d` 带入了与任务 05 无关的 main 变更、污染了部署工作树暂存指纹，**已从 feat/project 移除**，重放为 `6045d9d0` | 已被取代；`6045d9d0` 可达 ✔ |
| `5781f0a3` | 单元 06 的分支提交，评论记「已拣选并快进合并到 feat/project：`324515c0`」 | 已被取代；`324515c0` 可达 ✔ |

按内容复核（不只信 `--contains`）：`0116_project_event_outbox` 与 `0117_project_event_sources` 两条迁移、`project-events.service.ts` 及其 spec 都在 `1144099c` 的树里。迁移共 **141 条**、`0107…0126` 连续无缺口（`0123_task_completion_policy`、`0124_task_verification_verdict` 只是命名不带 project 前缀）。

**部署现状（重要）**：线上 `orbit-apiserver`（镜像建于 2026-08-19T16:19）跑的是 feat/project 的**旧构建** —— 容器内 `dist/projects/` 只有 `contract-doc / dto / projects.controller / projects.module / projects.service`，没有 events / reconcile / decision / blocker 任何一个；共享库 `_prisma_migrations` 停在 **124 条（最新 `0110_task_run_at`）**，`project_runtime` / `project_event` / `project_blocker` 等表**在线上不存在**。因此标准 10 的控制面**无法从线上入口验证**，只能按代码 + 进程内生产服务图 + 测试判定；本报告不宣称任何"线上已验证"。部署与否不在 12 条标准之内，故不据此判 FAIL，但必须记录。

---

## 5. 收尾核对

- 一次性容器 `pcc23-e2e-pg16` / `pcc23-pgspec-pg16` / `pcc23-faults-pg16` / `pcc23-mut-pg16` 与其全部库已随脚本 trap 删除；未在共享 `orbit-postgres` 上创建任何对象。
- 变异探针改动已还原；`src/apiserver/build*`、`src/web/node_modules` 临时软链等构建产物在提交前清除，审计工作树除本报告外 clean。
- 部署工作树 `/root/.orbit/worktrees/feat-project-deploy` 的用户暂存状态**全程未动**：`M README.md` / `D docs/project-agent-contract.md`，staged binary diff SHA-256 恒为 `966c46d48ff68e27f9a479eca869e92a8f203d6c2a4466eaa8d48a2d9fcf8105`，unstaged 为 0 字节。合并只用 `git merge --ff-only`，未使用 `update-ref`。
- 本报告只新增 `docs/project-acceptance-23.md`，未修改任何实现、迁移、契约、测试。

---

## 6. 结构化 blocker（交回 Coordinator）

### BLK-23-01 — dead letter 不 fail-closed（标准 8）

| 字段 | 值 |
| --- | --- |
| kind | `UNKNOWN_FAILURE` 缺失 / 契约违背 |
| owner | 研发（单元 17 blocker 语义的机械扩展；单元 05 的 `deadLetter` 从未长出这段） |
| 范围 | `src/apiserver/src/projects/project-reconcile.service.ts:331-353` |
| 复现 | `project-e2e-recovery.pg.spec.ts` 场景 `AC2: a batch that never succeeds dead-letters into a named blocker`：第 10 次投递失败后 `project_blocker` 计数为 `0`，而场景标题与 `project-events.service.ts:49-52 / :330` 的注释都承诺有一条 |
| 所需动作 | 在 `deadLetter` 的同一事务内按 §11.3 去重/升级语义插入 `UNKNOWN_FAILURE`（`owner=USER`、`recovery=HUMAN`、`required_action`、`next_check_at` 五字段齐全）；把上述断言从 `=== 0` 改为 `>= 1`；补一条"派发在 dead letter 之后确实被停"的断言 |
| nextCheckAt | 修复任务落地后立即复验；建议 **2026-08-21** 前排入 |

### BLK-23-02 — 契约 §7.3 轮换幂等键拼写与实现不一致（P3，文档）

| 字段 | 值 |
| --- | --- |
| owner | 契约维护者 |
| 范围 | `docs/project-coordinator-contract.md:685` |
| 复现 | 契约写 `…:coord-session:<generation+1>`，`project-coordinator-session.ts:121` 造的是 `…:rotate:<generation>`；代码中 `coord-session` 零处 |
| 所需动作 | 改**文档**为 `rotate`。**不得**改实现——键是永久的，改它会让历史动作改名并违反 §8.2 GE1 |
| nextCheckAt | 与 BLK-23-01 同批 |

### BLK-23-03 — 标准 12 的前置未满足（流程）

| 字段 | 值 |
| --- | --- |
| owner | Coordinator |
| 范围 | Task `34A8FPCBxkJsgE1vpBtJe`(FAILED) · `34A9hr8j41AsVajr3Uo8j`(IN_PROGRESS) · `34ABi44CV2Iun9MoSFPgz`(IN_PROGRESS) |
| 复现 | `task_list --projectId 349bHrtPbgwiouD3cfCVP`：46 个任务中 42 DONE / 1 FAILED / 2 IN_PROGRESS（另加本任务） |
| 所需动作 | 三条的技术内容已由 03C / 03D 修复并经 04R4 在 `d4392b28` 独立 PASS（证据提交 `c6e21de5`，已在 feat/project 上）。Coordinator 需要决定它们的终态归档方式（例如以 04R4 为后继裁决把 04R/04R2/04R3 收成 CANCELLED，并在各自任务下留下指向 04R4 的说明），而**不是**把历史 FAIL 改判 DONE |
| nextCheckAt | BLK-23-01 修复复验时一并收口 |

**全部三条关闭且标准 8 复验为 PASS 之前，Project `349bHrtPbgwiouD3cfCVP` 保持 OPEN。**

---

## 附录 A — 启动基线错配（launch-base mismatch）

本单元的**任务工作树**在派发时并没有落在被验分支上。这条记录在这里，是因为它决定了"本次验收是不是在正确的树上跑的"。

### A.1 事实

| 时点 | 对象 | 值 |
| --- | --- | --- |
| 派发时 | 任务工作树 `/root/.orbit/worktrees/01a0211a-70f6-7b30-b3fa-908223723ab3` | HEAD `07eefde9`，分支 `orbit/23-feat-project-b80670` —— 即 **main 的头**，不含 Project Coordinator 的任何一行 |
| 派发时 | `git merge-base --is-ancestor 1144099c HEAD` | 返回 **1**（被验提交不在该树的历史里） |
| 派发时 | 被验分支 `feat/project` | `1144099c` |

### A.2 处置：换树，而不是在错的树上跑

发现错配后**没有**在任务工作树里做验证，而是另建了一棵专用审计树：

```
git worktree add /root/.orbit/worktrees/pcc23-349bQHCJ-20260820 \
    -b orbit/23-project-acceptance-349bQHCJ feat/project
# Preparing worktree (new branch 'orbit/23-project-acceptance-349bQHCJ')
# HEAD is now at 1144099c test(projects): walk the control loop end to end, and break it on purpose
```

§1–§5 的每一条命令都在这棵树里跑。可核验的证据是提交图本身：本报告提交 `0e4fc164` 的**唯一父提交就是 `1144099c`**——

```
git log -1 --format='commit=%H parent=%P' orbit/23-project-acceptance-349bQHCJ
# commit=0e4fc164d9ebf772c93fa4b077542bf61fd2e4d5 parent=1144099ce7935023296d305fb0159c2eac66f763
```

审计树的 reflog 也只有两个状态：全程 `1144099c`，直到写下本报告才前进到 `0e4fc164`。**没有任何一条验收命令跑在 `07eefde9` 上。**

### A.3 为什么当时不能靠 `git merge --ff-only feat/project` 修任务工作树

这条修法在派发那一刻**不可能成功**：`feat/project` 落后 main **4 个提交**（`07eefde9`、`711a3080`、`12b5ed75`、`154ef9e6`），所以任务工作树的 HEAD `07eefde9` **不是** `feat/project` 的祖先，`--ff-only` 会直接以 `Not possible to fast-forward` 中止。

```
git merge-base --is-ancestor 07eefde9 feat/project   # -> 1（不是祖先）
git merge-base --is-ancestor 07eefde9 1144099c       # -> 1
```

要让任务工作树落在 `1144099c` 上，只能"检出/换分支"，不能"快进"。事后该工作树确实被外部改成了新分支 `orbit/23-project-acceptance-correct` @ `1144099c`（其 reflog: `checkout: moving from orbit/23-feat-project-b80670 to orbit/23-project-acceptance-correct`），与本单元的处置结论一致。

### A.4 对裁决的影响

**无。** 换树发生在任何验证动作之前，全部 §2 的数字与 §3 的逐条裁决都产自 `1144099c`。这条记录的意义是流程侧的：

> **派发给验收类任务的工作树，其 HEAD 必须先被断言为被验提交。**
> 如果基线是从 main 派生而被验分支落后于 main，`merge --ff-only` 这条常规修法会失败；正确动作是从被验分支新建工作树/分支。建议把「`git merge-base --is-ancestor <被验SHA> HEAD` 必须为 0」做成验收任务开跑前的第一条断言。
