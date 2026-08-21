# 单元 03B 修复说明：0112 延迟约束触发器改按最终 Project 行判定

> 权威契约：[`project-coordinator-contract.md`](./project-coordinator-contract.md) §7.5 · §12.1，
> 以及 [`project-agent-contract.md`](./project-agent-contract.md)（PAC）§11.2 步骤 4/5 · M2。
> 被修复对象：单元 03A（提交 `541d17b8`）。失败依据：04R 独立复审在唯一隔离库上稳定复现的两个反例
> （只读证据工作树 `/root/.orbit/worktrees/pcc04r-34a8fpcb-20260820`）。
> **04R 的真实 FAILED、其 Session `34A8GrCXcJxG5PT59LUeM` 与既有验证报告一字未改**；本文只记录 03B 改了什么、
> 为什么，以及它证明到哪里为止。冲突时一律以契约为准。

## 1. 根因

0112 把伴生行与轮换计数写成三个 `DEFERRABLE INITIALLY DEFERRED` 约束触发器，因此它们在 `COMMIT` 时执行。
**延迟的是执行时刻，不是行像**：延迟触发器拿到的 `NEW` 仍然是**事件发生当时**的那一份快照。
0112 用这份快照推导协调身份，于是提交状态与判定输入可以不同：

| 反例 | 提交后的 `coordinator_workspace_id` | 0112 写下的 `COORDINATOR` 身份 |
|---|---|---|
| 同一事务 `INSERT`(A) → `UPDATE`(B) | B | **A**（INSERT 事件的行像）；`bind` 触发器的 `WHEN` 只认 NULL → set，补不上 |
| 0110 形状 old-writer 把已绑定 Project 从 A 迁到 B | B | **A**（代次正确 +1，身份停在 A） |

第二条正是 [`project-coordinator-repair-03a.md`](./project-coordinator-repair-03a.md) §6.3 第一条残留描述的那个窗口：
数据库**不阻止**旧 binary 换落点——但 0112 那条"让身份对得上行"的触发器，恰恰是那个没有回头看的。
结果不是 fail-closed，而是一个**非空却自相矛盾**的固定 Agent / 固定 Workspace，新 reader 会照单全收。

## 2. 修法：提交点锁行重读，一个函数三个事件

新增迁移 `0113_project_coordinator_final_row`。**三个触发器名字、时机、事件一个都没变**（因此是替换而不是叠加），
它们现在都执行同一个 `project_coordinator_reconcile()`，而这个函数的第一句就是：

```sql
SELECT * INTO final FROM "project" WHERE "id" = NEW."id" FOR NO KEY UPDATE;
IF NOT FOUND THEN RETURN NULL; END IF;
```

- **`FOR NO KEY UPDATE`**：同一 Project 的两次协调在提交点成为两个顺序而不是一次交错，第二个重读第一个提交的结果。
  它是能做到这件事的最弱锁——不与"往 Project 里归档任务"取的 `FOR KEY SHARE` 冲突。
  锁序 project → workspace，与 `ProjectsService.update` 同序；`WorkspacesService.remove` 从不锁 project 行，无环。
- **`IF NOT FOUND`**：同一事务内建了又删的 Project 照常提交，不写任何伴生行（0112 既有行为，保留）。

除 `INSERT` 事件读一次 `NEW."coordinator_session_id"` 外（见 §3），函数不再从行像取任何值。

### 2.1 身份：`TG_ARGV[0]` 区分两类事件

| 触发器 | 事件 | 参数 | 对身份的权限 |
|---|---|---|---|
| `project_coordinator_companions_insert` | `AFTER INSERT` | `landing` | 按最终落点重新推导 |
| `project_coordinator_companions_bind` | `AFTER UPDATE OF coordinator_workspace_id`，`IS DISTINCT FROM` | `landing` | 按最终落点重新推导 |
| `project_coordinator_rotation_count` | `AFTER UPDATE OF coordinator_session_id`，`IS DISTINCT FROM` | `rotation` | **只补空，永不替换**（§7.5：轮换只换 Session，Coordinator Agent 不变） |

`bind` 的 `WHEN` 从 `NULL → set` 放宽到"变了就算"。0112 那条窄条件对**服务**是对的（§7.5 让指定别的 workspace 成为 409），
对**数据库**是不够的：旧 binary 照样会迁落点，而那正是身份必须跟着走的时刻。

`rotation` 这一格不是保守，是契约：`PATCH /projects/:id` 的 `coordinatorAgentId` 会写一个**不等于**落点的身份，
且不碰 `coordinator_workspace_id`。若轮换也重新推导，用户显式选的协调 Agent 会在下一次换会话时被悄悄弹回落点。

### 2.2 落点合法性：与 0111 回填逐字相同的两个条件

同 owner、未软删（PAC M2）。`enabled` **不是**这里的条件，也不该是：这条判"身份是否为真"，
而"能不能在那里跑"是 `lastCoordinatorWorkspace` 的问题，答案是结构化的 `COORDINATOR_UNAVAILABLE`（§7.5），不是静默搬家。
取 `FOR SHARE` 而不是裸读，理由与 `ProjectsService.lockLiveAgent` 逐字相同（验证 04 的 P1-03）：软删是一次 UPDATE，
外键自带的 `FOR KEY SHARE` 不与它冲突。

推导结果按三种committed 状态收敛，**最终状态可判**：

| 最终 `coordinator_workspace_id` | 现有 `COORDINATOR` 成员 | 结果 |
|---|---|---|
| NULL | 任意 | 不动（没有可推导的来源；空落点不是解散团队的指令） |
| 合法落点 L | 无 / ≠ L | 写成 L（`landing` 事件）；`rotation` 事件只在"无"时补 |
| 合法落点 L | = L | 不写（重放、重复事件、乱序都到这一格） |
| 非法落点（跨租户 / 软删） | 无 | 不写（**绝不凭空造身份**，与回填同一条） |
| 非法落点 | = 该落点 | 不动（落点在身份**底下**被软删：两者仍指同一个，无矛盾，§7.5 身份稳定） |
| 非法落点 | ≠ 该落点 | 删除该成员（**有落点无身份**，而不是留一对互相矛盾的值） |

因此提交后恒成立：**一个 `coordinator_workspace_id` 非空的 Project，其 `COORDINATOR` 身份要么就是这个 workspace，
要么不存在**——不会是第三个 workspace。

落座用"删旧 + `INSERT ... ON CONFLICT (project_id, agent_id) DO UPDATE SET role`"而不是 `UPDATE agent_id`：
被落座的 Agent 可能已经持有本 Project 的一条 `MEMBER` 成员，`project_member_project_id_agent_id_key` 会拒绝它——
而且是在 `COMMIT` 上拒绝一个没做错任何事的事务。

## 3. 代次：从"事件的 OLD 行像"改为"落库的基线"

新增列 `project_runtime.coordinator_session_id`：**当前代次是对着哪一条协调 Session 记的**。
无外键，理由与 `project_decision.coordinator_session_id` 相同（§7.7 D19-b）：这是历史 id 不是引用；
`SET NULL` 会在会话被清理时悄悄重置基线，而**重置的基线就是漏掉的下一次轮换**。

判定条件与 0112 **逐字相同**（旧指针非空、新指针非空、两者不同），只是把"某一个事件的 OLD"换成"落库的基线"：

```
final.session ≠ NULL ∧ baseline ≠ NULL ∧ final.session ≠ baseline  →  generation + 1，baseline := final.session
否则 baseline IS DISTINCT FROM final.session                        →  baseline := final.session（首次绑定 / 失去会话，不计数）
```

语义因此一条没变：首次绑定是 0；指针被清空不计数；重复写同一个 id 不计数。
**变的是答案不再取决于这次改动被拆成几条语句**：一个事务里 A→B→A 计 0，A→B→C 计 1，
重复投递的延迟事件读到已经推进过的基线，计 0。

`INSERT` 事件是函数里唯一读 `NEW` 的地方，且只读一个值：Project **出生时**叫的那条 Session——
这是最终行给不出、而代次必须从它量起的量。条件化的 `ON CONFLICT DO UPDATE`（仅当基线为空且代次为 0 时采纳）
让新旧两种 writer 对齐：现服务在 INSERT 里自己写 `project_runtime`，那行此刻还没有基线，而一行"没记过基线也没计过数"
的 runtime 只可能是本事务刚建的。

迁移里的回填把每一条既有 runtime 行的基线写成它的 Project 当前的 Session：它们**已经**按现状计过数了。

## 4. 反例关闭映射

| 反例（来源） | 关闭方式 | 反向对照下的表现 |
|---|---|---|
| 同事务 `INSERT`(A) → `UPDATE`(B) 身份留 A（04R） | §2 提交点重读最终行 | `coordinator-04r-adversarial` #1 失败：expected `…04b1`，actual `…04a1` |
| 0110 old-writer A→B 代次对身份错（04R） | §2.1 `bind` 触发器 `IS DISTINCT FROM` + 重新推导 | `coordinator-04r-adversarial` #2 失败，同上 |
| 同事务 insert + delete 必须合法且无残留（04R） | 0112 既有行为，`IF NOT FOUND` 保留 | 反向对照下**通过**——这一格不是 03B 的 |
| A→B→A、多次更新、乱序、重复延迟事件重复增代 | §3 基线判定 | 反向对照下 #4 #5 失败 |
| 幂等重放（同一语句再来一次、迁移再跑一次） | §2.1 表格第三行 + `ON CONFLICT` | 反向对照下 #7 失败 |
| 跨租户 / 软删落点 fail-closed | §2.2 表格第 4、6 行 | 反向对照下 #8 失败 |
| 禁用落点 | DB 照常落座；fail-closed 在服务层（`COORDINATOR_UNAVAILABLE`） | 反向对照下**通过**——这一格是 03A 的 |
| 并发 commit ordering | §2.2 `FOR SHARE` | 反向对照下 #14 失败 |
| §7.5 身份稳定（轮换不改 Agent） | §2.1 `rotation` 参数 | 反向对照下 #11 失败 |

## 5. 复核入口

```bash
# 无库全集（从 src/apiserver）
npx tsc -p tsconfig.test.json --pretty false          # 29 个 TS2554 是 541d17b8 既有基线
env -u COORDINATOR_PG_URL -u DATABASE_URL node --test "build/**/*.spec.js"
#   → tests 1809 / pass 1690 / fail 1 / skipped 118
#     唯一失败 reorderRunners… 在父提交 541d17b8 的构建上同样失败（已独立归因，非本单元引入）

# 一次性隔离 PostgreSQL（禁止指向共享 orbit-postgres）
docker run -d --name pcc03b-pg --tmpfs /var/lib/postgresql/data:rw,size=6g \
  -e POSTGRES_PASSWORD=*** -e POSTGRES_USER=pcc03b_admin -e POSTGRES_DB=pcc03b_verify \
  -e PGDATA=/var/lib/postgresql/data/pgdata -p 127.0.0.1:45438:5432 postgres:16-alpine
DATABASE_URL=postgresql://pcc03b_admin:***@127.0.0.1:45438/pcc03b_verify npx prisma migrate deploy
COORDINATOR_PG_URL=postgresql://pcc03b_admin:***@127.0.0.1:45438/pcc03b_verify \
COORDINATOR_PG_EXPECTED_DATABASE=pcc03b_verify COORDINATOR_PG_EXPECTED_USER=pcc03b_admin \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system()> \
  node --test build/projects/coordinator-identity-migration.pg.spec.js \
              build/projects/coordinator-identity-service.pg.spec.js \
              build/projects/coordinator-companions.pg.spec.js \
              build/projects/coordinator-service-linearization.pg.spec.js \
              build/projects/coordinator-final-row.pg.spec.js \
              build/projects/coordinator-04r-adversarial.pg.spec.js
#   → tests 49 / pass 49 / fail 0（前四个文件单独跑仍是 03A 的 32/32）

# 反向对照：把 0112 的两个函数与三个触发器放回去，同一批用例必须变红
COORDINATOR_PG_REVERSE_0113=1 node --test build/projects/coordinator-final-row.pg.spec.js
#   → tests 14 / pass 4 / fail 10（通过的 4 个正是 0112 已经做对的那几格）
```

`coordinator-final-row.pg.spec.ts` 在自己的 schema（`pcc03b_final_row`）里按 0111 → 0112 → 0113 的顺序建库，
因此它对**任何** writer 成立，也因此可以用一个环境变量把 0113 摘掉做反向对照。
`coordinator-04r-adversarial.pg.spec.ts` 是 04R 那三条反例**原样**收进仓库的版本（一个断言都没有放宽），
走真实 `prisma migrate deploy` 后的 schema。

## 6. 真实快照前滚（只读 dump → 隔离实例）

唯一数据库资源：本任务自建的一次性容器 `pcc03b-pg-34a8j2er-20260820`（`127.0.0.1:45438`，tmpfs，无 host mount）。
**全程没有连接、exec、迁移或测试共享 `orbit-postgres`/`orbit`。**

```text
dump=/root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump
sha256=f5853df3e9ffe3fd8451dc7c83287ba3d2a1a2731dadbd3f1dadea1c648ec8c8   （与 04 / 03A 报告一致）
before: 124 migrations, max=0110_task_run_at, database_size=2916 MB
before: projects=3 tasks=56246 sessions=3608 run_events=3893496 workspaces=18 bound_projects=3
after : 127 migrations, max=0113_project_coordinator_final_row
after : projects=3 safe_defaults=3 runtime_rows=3 generation_nonzero=0
after : baseline_matches_project=3 baseline_null=0
after : coordinator_members=3 member_matches_bound_workspace=3 member_owner_match=3 member_agent_live=3
after : triggers → project_coordinator_reconcile(landing|landing|rotation), stale_0112_functions=0
after : tasks=56246 sessions=3608 run_events=3893496
re-apply 0113 by hand: projects=3 members=3 runtime=3 generation_nonzero=0 baseline_matches=3（幂等）
migrate diff（0111..0113 新增对象 grep）: 0 matches
```

同一份前滚后的真实快照上，再按 0110 的形状打两条探针——即 04R 的两条反例：

```text
probe_insert  : agent=<workspace A> generation=0 baseline=<session 1> enabled=false policy=MANUAL
probe_relocate: landing=<workspace B> agent=<workspace B> matches=true generation=1
probe_drift   : landing=<workspace B> agent=<workspace B> matches=true generation=0
```

探针行随后按 id 精确删除，复核 `probe_left=0 projects=3 members=3 runtime=3 tasks=56246 sessions=3608
run_events=3893496`。快照库 `pcc03b_snapshot` 与容器在本单元结束时删除。

## 7. 部署与回滚

1. **前滚**：`prisma migrate deploy` 应用 0113。加一列（可空）、回填基线、替换三个同名触发器、删掉 0112 那两个
   已经没有触发器指向的函数。不改任何既有行的含义，不发事件、不开 blocker、不动安全默认。
2. **0112 已经上线的库**：这正是把修复写成新迁移而不是改 0112 的原因——改一条已应用的迁移会让
   `migrate deploy` 的校验和对不上。0113 对"只到 0112"和"全新库"两种状态给出同一个终态。
3. **滚动升级**：新旧 binary 仍可并存。服务层一行未改，0113 是纯数据库改动。
4. **回滚**：只回滚应用，保留 forward schema（与 0111/0112 相同）。降级数据库不是回滚路径。

## 8. 仍然成立的残留（不声称已解决）

- 旧 binary 依然可以把 `coordinator_workspace_id` 换到别处。数据库**不阻止**，只保证换完之后身份与落点不矛盾
  （repair-03a §6.3 第一条的前半句仍然成立，后半句从"身份会留在旧落点"变成"身份跟着走或者退成无身份"）。
- 用户通过 `coordinatorAgentId` 显式选的协调 Agent，在**落点被迁移**时会被重新推导覆盖。这是有意的：
  身份的权威来源是落点（PAC §11.2 步骤 5），而落点迁移本身已经是契约不允许服务做的动作。
  §7.5 要求的"轮换不改身份"由 `rotation` 参数保证，已有回归用例。
- `project_runtime.coordinator_session_id` 只被数据库写。没有服务读它，也不该有：它是计数的基线，不是"现在是哪一条"
  （那是 `project.coordinatorSessionId`）。
