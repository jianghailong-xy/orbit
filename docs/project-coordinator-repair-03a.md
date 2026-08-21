# 单元 03A 修复说明：身份迁移、轮换落点、锁序、孤儿清理与混合版本闭环

> 权威契约：[`project-coordinator-contract.md`](./project-coordinator-contract.md) §7.5 · §11 · §12.1，
> 以及 [`project-agent-contract.md`](./project-agent-contract.md)（PAC）§11.2 步骤 4/5 · M2。
> 被修复对象：单元 03（提交 `86a89b93`）。失败依据：[`project-coordinator-validation-04.md`](./project-coordinator-validation-04.md)
> 记录的 6 个 P1。**该验证报告一字未改**；本文只记录 03A 改了什么、为什么，以及它证明到哪里为止。
> 冲突时一律以契约为准。

## 1. 六项关闭映射

| P1 | 关闭方式 | 落在哪 | 反例（先失败后通过） |
|---|---|---|---|
| P1-01 存量身份未回填 | 迁移 `0112` 按 PAC §11.2 步骤 4/5 幂等回填：`coordinator_workspace_id` 非空、且该 workspace 与 Project **同 owner、未软删** 时写一条 `COORDINATOR` 成员；已有成员不覆盖 | `prisma/migrations/0112_project_coordinator_companions/migration.sql` | `coordinator-companions.pg.spec.ts` 前 3 例 + 真实快照测量（§4） |
| P1-02 轮换会迁移落点 | `coordinator()` 的落点改为 `coordinatorLanding()`：已记录协调 Workspace 的 Project **只能**开在那里；显式指定别处是 409；落点软删/禁用/不可运行返回结构化 `COORDINATOR_UNAVAILABLE`（`owner: USER`）；只有从未绑定过的 Project 才可选择落点 | `projects.service.ts` `coordinatorLanding` / `coordinatorUnavailable` / `lastCoordinatorWorkspace` | `project-coordinator.spec.ts` 4 例 + `coordinator-service-linearization.pg.spec.ts` 2 例 |
| P1-03 软删竞态越过 liveness | 成员写入在 project 行锁之后对 agent 行取 `FOR SHARE`；Workspace 软删路径改为先 `FOR UPDATE` 锁行、再查 `project_member`，有则 409 拒绝 | `projects.service.ts` `lockLiveAgent`、`workspaces.service.ts` `remove` | `coordinator-service-linearization.pg.spec.ts` 两个 commit ordering + `workspaces.service.spec.ts` 3 例 |
| P1-04 失败留下 live orphan | swap 语句抛错时先 `discardLoser()`（软删，不是 `end`，更不是 complete）再抛原错；cleanup 自身失败继续抛，不报成功 | `projects.service.ts` `coordinator()` 的 `try/catch` | `coordinator-service-linearization.pg.spec.ts` 3 个真实故障点 + `project-coordinator.spec.ts` 2 例 |
| P1-05 explicit null 变 500 | 三个 NOT NULL 字段改用 `@IsSent()`（`ValidateIf(v !== undefined)`）：omitted 仍可选，`null` 走完整校验并稳定 400；`sessionBudgetPerDay=null` 保持合法 | `projects/dto.ts` | `project-coordinator-identity.spec.ts` 4 例（含 runner door） |
| P1-06 混合版本半迁移 Project | 迁移 `0112` 用**延迟约束触发器**把伴生行与轮换计数变成数据库的机械保证，对 0110/0111/0112 三种 writer 一致；服务层不再自己写代数 | `0112` 的 `project_coordinator_companions` / `project_coordinator_rotation` | `coordinator-companions.pg.spec.ts` 5 个 old-writer 例 + service 侧 rotation 例 |

03 已通过的部分一字未动：Base62 出入站、列默认 `false`/`MANUAL` 的安全默认、`config_revision` 计数、
partial unique index、`project_member` 唯一键与 FK、runner 门对五个治理字段的 403、租户边界。

## 2. 落点固定（§7.5）的确切语义

`POST /projects/:id/coordinator` 现在分三种情况：

1. **有 live 协调 Session**：原样返回，指定别的 workspace 是 409（03 既有行为，未变）。
2. **记录了协调 Workspace**（无论 Session 是被删、进回收站还是指针为空）：新 Session **只能**开在该 Workspace。
   指定别处 → 409；该 Workspace 软删/禁用 → `COORDINATOR_UNAVAILABLE`；`sessions.create` 因禁用或未绑 runner
   拒绝 → 同一个 `COORDINATOR_UNAVAILABLE`（只翻译 403/400 两类拒绝，其余错误原样抛出）。
3. **从未绑定过**：`workspaceId ?? 任务最多的 assignee`，与 03 相同——这是绑定，不是迁移。

03 落地说明里"用户路径例外：协调会话被删除后仍允许显式换 workspace"**已撤回**。理由见 04 的 P1-02：
公开 endpoint 执行的就是 Session replacement，契约 §7.5 对它没有例外，而"删掉会话"不是"同意搬家"。
重新绑定协调 Workspace 是用户的显式动作，`COORDINATOR_UNAVAILABLE.requiredAction` 指的正是它；
本单元不实现该 rebind endpoint（属于后续单元），因此这条 blocker 目前的解法是用户改 Workspace 的可用性。

结构化错误体（沿用 `runner-orchestration-authorizer` 的形状，`PublicIdInterceptor` 不改写错误体，故不带任何 id）：

```json
{ "statusCode": 409, "error": "Conflict", "code": "COORDINATOR_UNAVAILABLE",
  "message": "...", "owner": "USER", "requiredAction": "rebind this project’s coordination workspace ..." }
```

## 3. 锁序（P1-03）

两条写路径的锁序是全序的，因此只有两种提交顺序、没有交错，也不会死锁：

```
ProjectsService.update   : project 行 FOR NO KEY UPDATE  →  workspace 行 FOR SHARE     →  写 project_member
WorkspacesService.remove : workspace 行 FOR UPDATE       →  读 project_member          →  写 deleted_at
```

- `FOR SHARE` 与软删那条 UPDATE 隐含的 `FOR NO KEY UPDATE` 冲突——而外键自带的 `FOR KEY SHARE` 不冲突，
  这正是 04 能把成员提交到已软删 Agent 上的原因。
- membership 先提交 → 删除排队，醒来后看见成员，409。
- 删除先提交 → 锁定读按新行版本重算 `deleted_at IS NULL`（Postgres 对被锁行重新求值谓词），读不到行，400。
- remove 从不锁 project 行，所以两条路径不构成环。

## 4. 真实快照（P1-01）

唯一数据库资源：本任务自建的一次性容器 `pcc03a-pg-34a6tlbe-20260820`（`127.0.0.1:45437`，无 host mount）。
**全程没有连接、exec、迁移或测试共享 `orbit-postgres`/`orbit`。**

```text
dump=/root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump
sha256=f5853df3e9ffe3fd8451dc7c83287ba3d2a1a2731dadbd3f1dadea1c648ec8c8   （与 04 报告一致）
before: 124 migrations, max=0110_task_run_at, database_size=2916 MB
before: projects=3 tasks=56246 sessions=3608 run_events=3893496
before: bound_projects=3 workspace_owner_match=3 workspace_live=3 workspace_enabled=3
after : 126 migrations, max=0112_project_coordinator_companions
after : projects=3 safe_defaults=3 runtime_rows=3 generation_nonzero=0
after : coordinator_members=3 member_matches_bound_workspace=3 member_owner_match=3 member_agent_live=3
after : tasks=56246 sessions=3608 run_events=3893496
re-apply 0112 by hand: coordinator_members=3 runtime_rows=3 generation_nonzero=0（幂等）
migrate diff（新增对象 grep）: 0 matches
```

04 记录的 `coordinator_members=0` 就此变成 3，且每一条都指向该 Project 自己绑定的、同 owner、未软删的 Workspace。

同一个前滚后的真实快照上，再按 0110 的 INSERT 形状写一条 Project（只有旧 binary 认识的列，不写任何伴生行），
即 04 用来记录 P1-06 的那次等价旧写入：

```text
04:   coordinator_enabled=f automation_policy=MANUAL config_revision=0 has_runtime=f    has_coordinator_agent=f
03A:  coordinator_enabled=f automation_policy=MANUAL config_revision=0 has_runtime=true has_coordinator_agent=true
      agent_is_bound_workspace=true
      旧 writer 首次绑定 → generation=0；旧 writer 换一次会话 → generation=1
```

探针行随后按 id 精确删除，复核 `probe_left=0 projects=3 members=3 runtime=3 tasks=56246 sessions=3608
run_events=3893496`。

## 5. 代数计数搬进数据库

`project_runtime.coordinator_generation` 的推进从 `ProjectsService.coordinator` 移到触发器
`project_coordinator_rotation_count`。条件与原来逐字相同（旧指针非空、新指针非空、两者不同），
因此语义不变：首次绑定是 0，指针被清空不计数，重复写同一个 id 不计数，输掉 CAS 的 swap 不更新行、也就不触发。

搬家的理由不是简洁，而是覆盖面：03 的写法只在"本服务是唯一 writer"时成立。旧 binary 也会换协调会话，
而它不会计数——代数停住而会话变了，后续按代数派生幂等键的单元就会把两次运行看成一次。
这一项也顺带简化了 P1-04：swap 之后不再有第二条语句，失败面更小。

## 6. 混合版本安全闭环（P1-06）

### 6.1 数据库机械保证的三条不变式

0112 之后，对**任何** writer（0110、0111、0112 及之后的 binary）都成立：

- **I1**：`project` 行一旦提交，必有 `project_runtime` 行（同一事务，提交时写入）。
- **I2**：`coordinator_workspace_id` 从 NULL 变为"同 owner 且未软删的 workspace"时，若该 Project 尚无
  `COORDINATOR` 成员，则写入一条；**永不覆盖**已有成员，**永不跨租户**，**永不复活**软删 Agent。
- **I3**：`coordinator_session_id` 由非空换成另一个非空值时，`coordinator_generation` 恰好 +1。

实现是三个 `DEFERRABLE INITIALLY DEFERRED` 约束触发器。延迟是必需的：现服务在同一条 INSERT 里自己写
membership，立即触发器会抢先写入并把每一次 create-in-session 变成唯一索引冲突。延迟到 COMMIT，
writer 自己的行已可见，触发器只补没人写的那部分。

代价与边界，都写在这里而不是留给读者发现：

- 同一事务内"插入 Project 后立刻读伴生行"读不到（提交后才写）。今天没有这样的读者。
- 触发器在写伴生行前确认 Project 仍存在：同一事务内建了又删的 Project 不会因外键把整个事务带崩
  （这是本单元自己在真实快照上打出来的错误，已有回归用例）。
- 迁移内部先建触发器、后跑回填：`CREATE TRIGGER` 持有 `SHARE ROW EXCLUSIVE`，与 INSERT 冲突，
  因此两条语句之间不存在"回填赶不上、触发器还没建"的空窗。

### 6.2 已证明的部署与回滚协议

1. **前滚**：`prisma migrate deploy` 应用 0111+0112。二者都是加法，不改任何既有行的含义，不发事件、不开 blocker、
   不改既有 Project 的 `false`/`MANUAL` 安全默认。
2. **滚动升级**：新旧 binary 可以并存，**不需要**先排空旧 writer——I1/I2/I3 由数据库保证，旧 writer 提交的
   Project 也是完整的（`coordinator-companions.pg.spec.ts` 的 5 个 old-writer 用例就是这条的可执行证明）。
3. **回滚**：只回滚应用、保留 forward schema。数据库降级**不是**回滚路径：0112 的触发器与 0111 的列、
   枚举、成员/runtime 行会一起丢失，且旧 schema 无法安全承载新写入。

### 6.3 仍然成立的残留（不声称已解决）

- 旧 binary 的 `coordinator()` 仍是 03 之前的落点链，因此在混合版本窗口内**它自己**可能把协调 Workspace 换到别处。
  数据库不阻止这件事，也**不应该**阻止：`COORDINATOR_UNAVAILABLE` 给用户的补救动作正是"重新绑定协调 Workspace"，
  一条硬性禁止改列的触发器会把这条补救一起禁掉。窗口结束后新 binary 不再迁移落点。
- 旧 binary 可以把 `coordinator_workspace_id` 指向跨租户或已软删的 Workspace。此时 I2 **故意**不写身份
  （不能凭空造一个），该 Project 会是"有落点、无身份"；新代码读它是 `coordinatorAgentId: null`，
  轮换时 fail-closed 到 `COORDINATOR_UNAVAILABLE`，不会静默搬家。
- 新版本写入 membership 后，旧版本硬删 Workspace 会被 `RESTRICT` 外键拒绝；软删则被 §3 的 409 拒绝。
  这是 04 已记录的行为差异，属于预期。

## 7. 复核入口

```bash
# 无库全集（从 src/apiserver）
npx tsc -p tsconfig.test.json --pretty false          # 29 个 TS2554 是父提交既有基线
env -u COORDINATOR_PG_URL -u DATABASE_URL node --test "build/**/*.spec.js"

# 一次性隔离 PostgreSQL（禁止指向共享 orbit-postgres）
docker run -d --name pcc03a-pg -e POSTGRES_PASSWORD=*** -e POSTGRES_USER=pcc03a_admin \
  -e POSTGRES_DB=pcc03a_verify -p 127.0.0.1:45437:5432 postgres:16-alpine
DATABASE_URL=postgresql://pcc03a_admin:***@127.0.0.1:45437/pcc03a_verify npx prisma migrate deploy
COORDINATOR_PG_URL=postgresql://pcc03a_admin:***@127.0.0.1:45437/pcc03a_verify \
COORDINATOR_PG_EXPECTED_DATABASE=pcc03a_verify COORDINATOR_PG_EXPECTED_USER=pcc03a_admin \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system()> \
  node --test build/projects/coordinator-identity-migration.pg.spec.js \
              build/projects/coordinator-identity-service.pg.spec.js \
              build/projects/coordinator-companions.pg.spec.js \
              build/projects/coordinator-service-linearization.pg.spec.js
```

`coordinator-pg-test-safety.ts` 在任何写入前拒绝非 `pcc*` 的库/角色、拒绝 Orbit 共享库，并要求显式声明
期望的 database / role / `system_identifier`。03A 只把库名前缀正则从 `pcc<数字>_` 放宽到 `pcc<单元>_`
（`03a` 也是单元名），三项显式身份断言未变。
