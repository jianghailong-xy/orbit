# 单元 23 — 独立项目级验收与 feat/project 合并审计

**被验对象**：`feat/project` @ `1144099ce7935023296d305fb0159c2eac66f763`
**审计工作树**：`/root/.orbit/worktrees/pcc23-349bQHCJ-20260820`（分支 `orbit/23-project-acceptance-349bQHCJ`，从 `1144099c` 新建）
**执行日期**：2026-08-20
**方式**：不沿用单元 22 的自评结论。所有数字都是本次重新跑出来的；两条被单元 22 列为"遗留"的偏差（F-22-02 / F-22-04）由本单元从契约原文与实现源码独立裁决。

---

## 裁决

> **本节是第一轮（`1144099c`）的裁决，保留原样作为审计留痕。**
> 单元 24 已修掉标准 8 的 F-22-02 与 F-22-04，第二轮验收在 `feat/project@3bd874e0` 上重做，
> **现行裁决在[附录 C](#附录-c--在修复后的基线-3bd874e0-上重做验收)：11 PASS / 1 FAIL（仅标准 12），Project 仍保持 OPEN。**

**第一轮（`1144099c`）：NOT ALL PASS — Project 保持 OPEN。**

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

---

## 附录 B — 在协调者修正后的工作树里整套复跑

协调者以非破坏方式修正了附录 A 的错配：原任务工作树
`/root/.orbit/worktrees/01a0211a-70f6-7b30-b3fa-908223723ab3` 现为干净分支
`orbit/23-project-acceptance-correct`，错开的 `orbit/23-feat-project-b80670`（`07eefde9`）保留未动、不再被检出，仅作审计留痕。

**§2 的全套证据已在这棵被指定的工作树里重跑一遍，逐项复现。**

### B.1 被测代码与 §2 那次逐字节相同

`orbit/23-project-acceptance-correct` 从 `1144099c` 快进到 `feat/project`（`0e4fc164`），再快进吃下附录 A 的 `a5746ab6`。
两次快进都合法（祖先关系成立），未使用 `reset` / `update-ref`。而 `1144099c → 0e4fc164` 的全部差异是：

```
git diff --stat 1144099c 0e4fc164
 docs/project-acceptance-23.md | 270 ++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 270 insertions(+)
```

**只有本报告一个文件**——没有一行实现、迁移或测试改动。所以本次复跑与 §2 跑的是同一份产品代码，两组数字可以直接互相对照。

### B.2 复跑结果（容器/库全部换新命名 `pcc23c_*`，与 §2 无共享状态）

| 命令 | §2（`pcc23-349bQHCJ` 树） | 附录 B（协调者指定树） |
| --- | --- | --- |
| `scripts/project-e2e.sh` 迁移 | 141 | **141** |
| acceptance suite | 28/28 | **28/28** |
| recovery suite | 16/16 | **16/16** |
| §10.3 活性审计 | 零行 | **零行**，`EXIT=0` |
| 26 个 `.pg.spec` | 238 / 237 pass / 0 fail / 1 skip | **238 / 237 pass / 0 fail / 1 skip** |
| apiserver 全量单测 | 2143 / 1927 pass / 0 fail / 216 skip | **2143 / 1927 pass / 0 fail / 216 skip** |
| web `vitest run` | 54 文件 / 797 通过 | **54 文件 / 797 通过** |
| `go test -v -run Project ./...` | 87 PASS / 1 FAIL | **87 PASS / 1 FAIL**（同一条 `TestKimiFindProjectRootFallsBackToCWD`） |
| 变异探针（`GUARDED_AUTO→AUTO`） | 26/28，`EXIT=1` | **26/28，`EXIT=1`**，同样是 `not ok 5 - AC1: a project recorded in a session is bound to it in one insert` |

本次 pg 套件里 `project-reconcile-fault-injection` 直接就是 **7/7**：先按 §2.3 的注记跑了
`tsc -p tsconfig.project-reconcile-faults.json`，子进程要的 `build-project-reconcile-faults/` 才存在。
这反过来证实 §2.3 那次 5/7 确是跑法问题而非产品缺陷。

一次性容器 `pcc23c-e2e-pg16` / `pcc23c-pgspec-pg16` / `pcc23c-mut-pg16` 及其全部库已删除；变异探针已还原
（`git status` 该文件 0 行差异）；共享 `orbit-postgres` 本轮未被写入。

### B.3 对裁决的影响

**无。** 两次独立运行、两套一次性数据库、两棵工作树，数字逐项一致。
§3 的 **10 PASS / 2 FAIL** 与三条 blocker（BLK-23-01 / 02 / 03）维持原判。

---

## 附录 C — 在修复后的基线 `3bd874e0` 上重做验收

单元 24（`34AeXHc…`，Task DONE，其 task-linked Session `34Aep3wUaiDAfscdrkMMh` 自然收口为
`SUCCEEDED / task_done`，0 次重试）修掉了本报告 §6 交回的 BLK-23-01 与 BLK-23-02。
本附录是在 **`feat/project@3bd874e0`**（唯一父提交 `1a358663`）上做的第二轮独立验收。

`1a358663 → 3bd874e0` 一个提交，9 个文件、+981 −93：`project-reconcile.service.ts`（dead letter 写 blocker）、
`project-blocker.ts` / `project-blocker-conditions.ts`（条件与 §11.4 重算）、`project-decision.service.ts`（快照投影
`deadLetters`）、`project-e2e-recovery.pg.spec.ts`（+2 场景）、`project-coordinator-session.spec.ts`（契约核对）、
契约 §7.3 一行、以及修复报告。**prisma schema 与迁移 0 改动。**

### C.0 环境事故（如实记录）

两件事影响了本轮的跑法，都不改变结论，但必须写下来：

1. **runner 重启**打断了第一次 `project-e2e.sh`（日志停在 acceptance 第 11 条），其一次性容器
   `pcc23d-e2e-pg16` 因 trap 未触发而成为孤儿；已手动删除后重跑。
2. **专用审计工作树被环境清理掉了。** 本轮先按指令新建了
   `/root/.orbit/worktrees/pcc23d-349bQHCJ-20260821`（`-b orbit/23-acceptance-r2-349bQHCJ 3bd874e0`），
   跑到一半时它连同 `pcc16` / `pcc23` 等**全部非 session worktree** 被一次仓库级清理抹掉（`.git` 与
   `node_modules` 均消失，`git worktree list` 里已无残留，分支 ref 全部幸存）。因此第二轮改在
   **协调者指定的 session worktree** `/root/.orbit/worktrees/01a0211a-…723ab3` 上做，
   分支 `orbit/23-project-acceptance-correct` 从 `1a358663` 合法快进到 `3bd874e0`（未 `reset`、未 `update-ref`）。
   数据库仍然是全新的一次性容器（`pcc23e_*` / `pcc23f_*`）。
3. **一次我自己造成的假红。** 变异探针脚本每轮重编译，却在最后一次还原 `.ts` 后**没有重新编译**，
   于是紧接着的全量单测跑在带 M2 变异的 `build/` 上，报出 1 条失败
   （`F22: an unacknowledged dead letter is a condition the recomputation keeps observing`）。
   删掉 `build/` 重编译后复跑为 **0 fail**。记在这里是因为它恰好是一条真实的反向对照：那条断言确实会因该变异变红。

### C.1 BLK-23-01 / F-22-02 逐条复验（协调者点名的六项）

| 要求 | 实现处 | 证据 |
| --- | --- | --- |
| **DEAD 与 UNKNOWN_FAILURE 原子** | `deadLetter()` 在投递事务 `tx` 内写 blocker；调用点在同一事务里标 DEAD，异常则整体回滚 | 场景 `AC2: a dead letter that cannot record its blocker discards nothing`：在 blocker 写完之后注入失败 → `project_blocker` 为空、事件 `consumed_at` 仍 NULL、`disposition` NULL、`attempts` 停在 9（**那次没记成的尝试不计数**）；换成正常投递则 DEAD 与 blocker 同时出现。**两个方向都断言了** |
| **detail 里没有 UUID** | `uuidToBase62(event.id)`、`publicIdempotencyKey(event.dedupeKey)`、`uuidToBase62(projectId)` | 场景 4 逐字断言 `deadEvents = [{eventId: <Base62>, kind, dedupeKey: 'task.updated:<Base62>', attempts: 10}]`；变异 **M3** 把 `eventId` 换成裸 uuid → 立刻变红 |
| **重复 / 并发 / 重启不重复、不削弱** | `projectBlockerDedupeKey('UNKNOWN_FAILURE','PROJECT',…)` + `planProjectBlockers` 的 raise-or-touch；`lifecycle_generation` 由 `MAX+1` 在 INSERT 内分配 | 场景 `AC2: repeated, concurrent and post-restart dead letters are one episode` 通过；场景 4 复验同一 episode（`lifecycleGeneration = 1`，只动两列展示字段） |
| **owner / requiredAction / recovery / nextCheckAt / escalation 可观测** | `PROJECT_BLOCKER_POLICY.UNKNOWN_FAILURE`：`owner=USER`、`recovery=HUMAN`、`severity=CRITICAL`、`escalateMs` | 场景 4 断言五项齐全 + `nextCheckAt = firstSeenAt + 30min`（BL5 的升级闹钟）+ `escalatedAt=null`；并且**从控制面读得到**：`projects.blockers()` 返回 1 条，`raisedByActionId` 指回那条 `RAISE_BLOCKER` 动作 |
| **派发 / 授权 fail-closed** | PROJECT-subject 的开放 blocker 命中 `openBlockersStoppingDispatch()`；`blockerRunState()` 使 run_state 成为 `AWAITING_HUMAN` | 场景 4 **走生产授权路径**断言 `REFUSED / PROJECT_BLOCKED`、`session` 计数为 0；随后一次健康 pass 之后再派发**仍然** `PROJECT_BLOCKED` |
| **健康 pass 不会把它悄悄清掉** | §11.4 从快照投影 `world.deadLetters` 重算；`capture()` 查 `disposition='DEAD'` 且晚于最近一次**人工**（`resolved_by <> 'AUTO'`）解除 | 场景 4：`settle()` 之后仍是**同一条** blocker（同 id、同 generation、occurrences 增加）；变异 **M2** 让重算看不见 dead letter → 立刻变红 |

### C.2 反向对照（我自己的三个变异探针，独立于单元 24 自带的测试）

每次只改一处、类型安全、跑 `project-e2e-recovery.pg.spec`（基线 **18/18**），跑完即还原：

| 变异 | 改法 | 结果 |
| --- | --- | --- |
| 基线 | 不改 | **18 / 18 pass** |
| **M1** 退回修复前行为 | `deadLetter` 的 `observed: [condition]` → 空集，于是不写任何 blocker | **14/18**，红 3 条（场景 4、5、6），`expected: 1 actual: 0` |
| **M2** 重算看不见 dead letter | `deadLetterConditions` 的 `dead` 取空 | **15/18**，红 2 条（场景 4、5） |
| **M3** 裸 UUID 落进 detail | `eventId: uuidToBase62(event.id)` → `event.id` | **16/18**，红 1 条（场景 4） |

三条都证明：这套断言不是恒真的，修复是被测试**承重**的。

### C.3 BLK-23-02 / F-22-04 复验

- 契约 §7.3 的模板已改为 `pc:v1:<projectId>:rotate:<generation+1>`（`docs/project-coordinator-contract.md` 一行）。
- **实现未动**：`project-coordinator-session.ts:121` 仍是 `pc:v1:${projectId}:rotate:${generation}`，
  `git diff 1a358663 3bd874e0 -- project-coordinator-session.ts` 为空 —— **没有重写任何历史键**，正是本报告 §3.2 要求的方向。
- 代码里 `coord-session` 仅剩一处注释（解释这段历史）。
- 更好的是它不会再漂：新增测试 `the contract names this rotation key the way the ledger spells it`
  **直接解析** `docs/project-coordinator-contract.md` §7.3 的表格，把模板代入 generation 后与 builder 的输出逐字比较。

### C.4 全量矩阵（`3bd874e0`，全新一次性数据库）

| 命令 | 结果 |
| --- | --- |
| `scripts/project-e2e.sh`（空库 141 迁移 → 两套件 → §10.3 审计） | acceptance **28/28**、recovery **18/18**（+2 新场景）、审计**零行**、`EXIT=0` |
| 26 个 `.pg.spec`（模板库 + 每 spec 独立库） | **238 tests / 237 pass / 0 fail / 1 skip — ALL GREEN** |
| `node --test "build/**/*.spec.js"` | **2149 / pass 1933 / fail 0 / skip 216**（单元 24 新增 6 条） |
| `src/web` `vitest run` | **54 文件 / 797 通过** |
| `go test -v -run Project ./...` | **87 PASS / 1 FAIL** —— 仍是 `TestKimiFindProjectRootFallsBackToCWD`，main 上逐字复现的既有环境红 |
| `tsc -p tsconfig.test.json` / `tsconfig.project-reconcile-faults.json` | 均 exit 0 |

### C.5 生产入口（本轮的新事实：**控制环已经上线了**）

上一轮报告 §4 记的是"控制面尚未部署"。本轮复核发现**已经部署**，因此这次可以从真正的生产入口取证：

| 检查 | 结果 |
| --- | --- |
| `orbit-apiserver` 镜像 | 建于 **2026-08-21T00:13**，`dist/projects/` 由 12 个文件涨到 **50 个** |
| 部署的代码含单元 24 修复吗 | 含：`dist/projects/project-reconcile.service.js` 有 `projectDeadLetterCondition`，`project-blocker-conditions.js` 有 `deadLetterConditions` |
| 共享库迁移 | **141 条**（上一轮是 124），`project_action / project_blocker / project_decision / project_event / project_member / project_runtime` 六张表全部存在 |
| **§10.3 活性审计跑在真实生产库上**（只读） | **0 行违约** |
| **标准 11 在真实存量数据上** | 6 个既有 Project 全部是 `coordinator_enabled=false` / `automation_policy=MANUAL` —— 迁移没有把任何一个既有项目意外打开。**这比夹具证据强** |
| 生产现存 blocker / DEAD 事件 | 0 / 0 |

### C.6 合并审计（本轮的第二个新事实）

`main` 上出现了 **`0a684004 feat(projects): integrate project coordinator with 0.1.128 (#52)`** —— Project Coordinator 已经以 PR 的形式进入 main。

| 检查 | 结果 |
| --- | --- |
| `feat/project` vs main | merge-base `7074270a`；**领先 100 / 落后 12** |
| `git merge-tree --write-tree main feat/project` | **rc=1**，5 处冲突：`README.md`、`runner-api.controller.ts`（content），以及 `project-e2e-acceptance.pg.spec.ts`、`project-coordinator-validation-04.md`、`project-coordinator-contract-review-02-v1.3.md`（**add/add**） |
| 冲突是内容分歧还是历史产物？ | **历史产物。** `git diff 3bd874e0 main -- src/apiserver/src/projects` 只有 **−2 行**（一个 spec 的空行），迁移目录 0 差异，契约 §7.3 在 main 上同样是 `rotate`。main 是把这份工作**复制**进去而非 merge 进去，所以同名文件两边各"新增"了一次 |
| 结论 | 被验的实现**已经在 main 上、也已经在生产上**；`feat/project` 与 main 的差异是历史形状与本报告等文档，不是控制环代码 |

### C.7 12 条逐条（`3bd874e0`）

标准 1–7、9–11 的证据与 §3 相同，且本轮全部重跑复现；**标准 8 由 FAIL 转 PASS**，标准 12 仍 FAIL。

| # | 上一轮 | 本轮 | 变化依据 |
| --- | --- | --- | --- |
| 1–7、9、11 | PASS | **PASS** | 全量矩阵复现；标准 11 另有生产存量数据佐证（C.5） |
| **8** | **FAIL** | **PASS** | C.1 六项全部满足，C.2 三个变异探针证明其承重；`AC8×6` 之外新增两个 dead-letter 场景 |
| 10 | PASS（仅代码与测试） | **PASS（含生产入口）** | 控制面已部署，`coordinator/status` 在线上 dist 里；C.5 |
| **12** | **FAIL** | **FAIL** | 合并状态这一半已核对且良好（C.6），但"全部任务完成"这一半仍不成立 —— 见 C.8 |

**现行裁决：11 PASS / 1 FAIL。Project 保持 OPEN。**

### C.8 标准 12：被取代的历史尝试 vs 仍在进行的工作

协调者要求把两者分开，这里分开写。**本单元全程只读这三条，未 restart / update / archive / cancel / complete 任何一条 Task 或 Session。**

Project 现有 47 个 Task：**43 DONE / 1 FAILED / 3 IN_PROGRESS**（含本任务）。

**A. 被取代的历史尝试（技术内容已修复并被独立复审 PASS）——3 条**

| Task | 持久状态 | Session | 为什么说它被取代 |
| --- | --- | --- | --- |
| `34A8FPCBxkJsgE1vpBtJe` 04R | **FAILED** | FAILED，08-20 04:34 已归档 | 身份迁移复审失败；后续 03A 修复 |
| `34A9hr8j41AsVajr3Uo8j` 04R2 | **IN_PROGRESS** | AWAITING_INPUT，未归档 | 钉在被验 SHA `e2e426c6` 的历史 FAIL（P1-04R2-01）；03C 已修 |
| `34ABi44CV2Iun9MoSFPgz` 04R3 | **IN_PROGRESS** | AWAITING_INPUT，未归档 | 钉在被验 SHA `f2883075` 的历史 FAIL（P1-04R3-01）；03D 已修 |

三者的技术结论都已被 **04R4 `34AE0NtfR02I92WqYFxqD`（DONE，PASS）** 在 `d4392b28` 上独立复审推翻/闭环，证据提交 `c6e21de5`。本轮核对：`d4392b28` 与 `c6e21de5` 均为 `3bd874e0` 的祖先。

**B. 仍在进行的工作——0 条**（除本验收任务 23 自身外，没有任何一条真正未完成的工作）。

**因此标准 12 的失败是"记录未收口"，不是"工作未做完"。** 但标准 12 写的是"全部任务完成后"，
而持久状态里确实还有 1 个 FAILED、2 个 IN_PROGRESS（各带一条未归档的 AWAITING_INPUT Session）。
按用户的硬性约束，这段历史必须保持为真实审计证据，**不得**为了凑 PASS 去改写它 —— 所以本单元不改，
判 FAIL，并把收口动作交回外部控制台/协调者。

### C.9 blocker 状态

| id | 状态 | 说明 |
| --- | --- | --- |
| **BLK-23-01**（标准 8，dead letter 未 fail-closed） | **已关闭** | 单元 24 修复；C.1 六项复验 + C.2 三个反向对照 |
| **BLK-23-02**（F-22-04，契约 §7.3 拼写） | **已关闭** | 文档已改、实现未动、并加了解析契约的守卫测试（C.3） |
| **BLK-23-03**（标准 12，记录未收口） | **仍开放** | owner = **外部控制台 / Coordinator**（执行 Agent 被明确禁止改写这段历史）。所需动作：为 04R / 04R2 / 04R3 做终态归档决策，指向 04R4 作为后继裁决；**不得**把历史 FAIL 改判 DONE。`nextCheckAt`：归档动作完成后立即复验，建议 **2026-08-22** 前 |

### C.10 收尾

一次性容器 `pcc23d-e2e-pg16`（孤儿，已手动删）/ `pcc23e-e2e-pg16` / `pcc23e-mut-pg16` / `pcc23e-mut2-pg16` /
`pcc23e-pgspec-pg16` / `pcc23f-pgspec-pg16` 及其全部库均已删除；三个变异探针已还原且**已重新编译验证**
（`build/` 中 `const dead = input.world.deadLetters ?? []`、`eventId: uuidToBase62(event.id)`、`observed: [condition]` 均为原值）；
共享 `orbit-postgres` 本轮**只读**（只跑了活性审计与状态查询）；任务工作树除本报告外 clean。
部署工作树暂存状态全程未动：`M README.md` / `D docs/project-agent-contract.md`，
staged binary diff SHA-256 恒为 `966c46d48ff68e27f9a479eca869e92a8f203d6c2a4466eaa8d48a2d9fcf8105`，unstaged 0 字节。
