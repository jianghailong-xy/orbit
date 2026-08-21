# 14 策略、预算、权限与派发边界独立验证

验证日期：2026-08-20（Europe/Berlin）
任务：`349bQH1C0ouHfoKfsqqEn`
被验提交：`8aca54504ae65067b036593e5eededf5c704b1c1`（任务 13）与
`575714f4dbf194b54b8ee2a8e26a7c0c8dbf0dcd`（任务 12）
隔离分支：`verify/14-dispatch-boundary`
隔离 worktree：`/root/orbit-verify-14`

## 结论

任务 12（三策略授权判定）与任务 13（Task dispatcher / Runner scheduler 授权边界）
**未发现 P0/P1 缺陷**。本次只新增测试与本报告，未改动任何产品实现、迁移、Prisma
schema 或既有契约。

新增 29 条确定性用例（12 条纯单元 + 17 条真实 PostgreSQL 故障注入）在全新空库上
连续两轮 29/29 通过；与任务 12/13 既有 spec 合并后在另一个全新空库上 35/35 通过。

验证结果证明：

- `MANUAL` / `GUARDED_AUTO` / `AUTO` 三条策略列 × 九行策略矩阵全覆盖，每格的
  decision 与 reason code 都来自冻结表，不存在第二处判定；
- 项目状态、Coordinator 开关、协调者身份/成员身份/启用状态、`CREATE_TASK` 与
  `DELEGATE` 权限、跨租户 Task 全部在策略格之前 fail closed；
- 审批位是**恰好一个 idempotency key 的授权**：未绑定、绑到别的 key、`DENIED`、
  `EXPIRED`、`PENDING` 五种形态一共 0 个 Session，只有绑定正确的 `APPROVED`
  放行，且审计里记的是 `APPROVAL_GRANTED`；审批也买不回更早的门（并发上限、
  Agent 被停用）；
- Project 并发上限、Agent 并发上限、24h Session 预算在两个决策**都在对方提交前
  取快照**的真实竞态下各自只放行一个 Session；预算花掉之后对新决策仍然是花掉的；
- 退避 / 可归因性 / 尝试上限读的是持久 Session 历史：退避期内 `RETRY_BACKOFF_ACTIVE`
  且带 `retryAt`，配额类失败不计入尝试，无错误文本的失败判为 `UNKNOWN_FAILURE`
  升级而不是自动重试，达到上限后即使 `AUTO` 也要人点头；
- Provider 不可用时**绝不换 Provider**：空 fallback、全部不可用的 fallback 一律
  `PROVIDER_UNAVAILABLE` + 0 Session，审计里 `explicitFallbacks` 为空、
  `selectedProvider` 为 null；只有 Agent 显式声明的顺序会被采用，且第一个可用者胜，
  `fallbackHops` / `pinned` / `candidatesConsidered` 全部落库；同一次 fallback 在
  `GUARDED_AUTO` 下是高风险行，要审批，0 Session；
- Runner 离线、快照后离线、Agent 快照后被停用、runtime 已登出、缺能力、老 runner
  未上报能力，六种情况都是结构化拒绝（`refusalCode = NO_MATCHING_RUNNER`），
  没有一条变成"换个 Provider 跑"；
- 一个授权动作在**双服务实例并发、重复投递、进程对象重建、乱序投递、事务边界
  注入异常、真实 backend 被 `pg_terminate_backend`、真实容器 `docker restart`**
  七种情形下最多一个 Session：四次投递只留一行 `project_action`，回滚的那次
  连动作行和 `dispatch_attempt` 都不留；
- 陈旧快照、依赖变化、Task 状态变化、fencing token 失效、Coordinator 被关掉，
  一律 0 Session；陈旧那次还恰好入队一条未消费的 `coordinator.snapshot_stale`
  并写下 `next_wake_at` / `next_wake_reason`，reconcile 可以被可靠触发；
- 篡改 lineage 在四层各自 fail closed：`project_decision` 行不可 UPDATE、伪造
  decision 的 hash 对不上、动作不在 decision 里、idempotency key 的 shape 就带
  Project UUID（因此跨 Project 键根本无法计划）、账本里被别的 Project 占用的键
  被拒；已提交 Coordinator Session 的 resolution/provider 不可改，已 APPLIED 的
  dispatch 动作是终态，拿 REFUSED 动作铸 Session 被数据库拒绝；
- Coordinator Task 走不了 legacy sweep：`dispatch_authority` 由数据库从
  `project.coordinator_enabled` 派生并双向跟随，sweep 谓词只看得见 LEGACY 的那条；
  数据库直接拒绝 `LEGACY_SWEEP` 落到 COORDINATOR Task 上；而人工"开始执行"
  （`USER`/`MANUAL`）与非 Project Task 的 Task List 自动路径（`LEGACY_SWEEP`/
  `TASK_LIST_AUTO`）行为不变，三条入口共用同一条 per-Task 唯一 live claim。

## 隔离环境与护栏

- PostgreSQL 容器：`pcc14v-claude-pg16`（本次专用，可重启）。
- 镜像：`postgres:16`；服务端版本 `16.15 (Debian 16.15-1.pgdg13+2)`。
- 监听：`127.0.0.1:32799 -> 5432`（与共享集群不同容器、不同端口）。
- 数据库 / 角色：`pcc14v_verify` / `pcc14v_owner`（开发期另用过 `pcc14v_dispatch`）。
- `system_identifier`：`7676055481108463660`。
- 迁移：`137/137` 已应用，含 `0121_project_authorization_policy` 与
  `0122_project_dispatch_boundary`（spec 内断言）。
- 护栏：沿用 `coordinator-pg-test-safety.ts` 的 `pcc*` 命名 + 显式期望
  database/role/`system_identifier` 三重校验；本次再加一条——遍历 `process.env`，
  任何指向 `orbit-postgres` 的连接串都直接失败，并断言目标必须是 loopback。
- 事后只读复核共享集群 `orbit-postgres`：`user.email LIKE '%pcc14%'` 与本次夹具
  项目标题各 0 行，共享库未被写入。

## 新增文件（仅测试与报告）

- `src/apiserver/src/projects/project-dispatch-boundary-verification.spec.ts`
  （12 条纯单元：策略矩阵全格、权限门、Task 状态门、退避/上限、审批绑定、
  fallback 顺序与策略门、scheduler 纯度、审计可重放与防篡改）。
- `src/apiserver/src/projects/project-dispatch-boundary-verification.pg.spec.ts`
  （17 条真实 PostgreSQL 故障注入，含容器重启与 backend 终止）。
- `src/apiserver/tsconfig.project-dispatch-verification.json`（只包含上面两个文件）。
- 本报告。

## 命令与关键输出

```
# 隔离容器与空库
docker run -d --name pcc14v-claude-pg16 -p 127.0.0.1:32799:5432 postgres:16
docker exec ... CREATE ROLE pcc14v_owner ...; CREATE DATABASE pcc14v_verify OWNER pcc14v_owner;
DATABASE_URL=postgresql://pcc14v_owner:***@127.0.0.1:32799/pcc14v_verify \
  node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
#   -> All migrations have been successfully applied.  (137/137)

# 构建
node_modules/.bin/tsc -p src/apiserver/tsconfig.project-dispatch-verification.json   # rc=0
node_modules/.bin/tsc -p src/apiserver/tsconfig.test.json                            # rc=0

# 全量 apiserver 单测（不设 COORDINATOR_PG_URL，pg spec 按既有约定跳过）
env -u COORDINATOR_PG_URL node --test "build/**/*.spec.js"
#   -> # tests 1977 / # pass 1769 / # fail 0 / # skipped 208

# 全新空库：任务 12/13 既有 spec + 本次新增，顺序执行
node --test --test-concurrency=1 \
  build/projects/project-authorization.service.spec.js \
  build/projects/project-authorization.pg.spec.js \
  build/projects/project-decision.pg.spec.js \
  build/projects/project-dispatch-boundary.pg.spec.js \
  build/projects/project-dispatch-boundary-verification.spec.js \
  build/projects/project-dispatch-boundary-verification.pg.spec.js
#   -> # tests 35 / # pass 35 / # fail 0 / # skipped 0

# 可复现性：同一份新增 spec 在全新空库上连续两轮
#   -> run1 # tests 29 / # pass 29 / # fail 0
#   -> run2 # tests 29 / # pass 29 / # fail 0   （第二轮跑在第一轮留下的数据之上）
```

真实容器重启用例通过 `COORDINATOR_PG_RESTART_COMMAND="docker restart pcc14v-claude-pg16"`
真正重启了服务端；重启后重新校验了 `system_identifier`，已提交的 Session 仍在，
同一 action 重放得到 `ALREADY_APPLIED` 且 Session id 不变。

## 记录在案的边界事实（非缺陷）

这两条是本次要求"动态确认"的怀疑点。实测结果是：**都不是当前实现的越权缺陷**，
但都值得写下来，且各自被一条会随语义变化而失败的断言钉住。

1. **Agent 并发上限是 per-Project 的。** `workspace.max_concurrent_tasks` 在
   `project-authorization.service.ts` 的准入计数里带 `t.project_id = <本 Project>`，
   两个 Project 之间也没有共享的 Agent 容量锁。因此一个 cap=1 的 Agent 同时协调
   两个 Project 时，会有 2 条在飞 Session（每个 Project 各 1 条）。这与 schema 上
   那句 "admission cap for this Agent's Project tasks" 一致，也与契约一致——契约
   §9.4/§9.6 只定义了 Project 级的两个上限（`maxConcurrentTasks` /
   `sessionBudgetPerDay`），并没有任何一条声称 Agent cap 是全舰队口径。
   本次用例 `the per-Agent admission cap is scoped to one Project` 把这个语义写死：
   将来若要改成全局口径，必须来改这条断言，而不是悄悄变。

2. **审批位目前是 dispatcher 的调用参数，还没有持久化来源。**
   `ProjectTaskDispatchCommand.approval` 由调用方给出。当前分支上
   `ProjectTaskDispatcherService` 只在 `ProjectsModule` 里 provide/export，**没有任何
   生产调用方**；schema 里也还没有 Project 审批/blocker 表，`REQUEST_APPROVAL`
   只是一个动作类型。也就是说"把审批位绑到用户产生的持久记录"属于后续单元
   （blocker/审批状态机）的工作面，而不是 12/13 的回归。已经存在的那一半护栏是有效的，
   本次已验证：一个 `APPROVED` 位只对**它自己那个 idempotency key** 有效，
   未绑定或绑到别的 key 一律 `APPROVAL_TARGET_MISMATCH` + 0 Session，因此它不能
   被当成通配符重放。后续单元接上持久审批记录时，本文件的审批用例可以直接改成
   从记录读取。

3. **subject / lineage 冲突是四层 fail closed**，不是单点检查：计划期拒绝快照之外的
   Task；提交期拒绝不在 decision 里的动作；idempotency key 的 shape 里带 Project
   UUID，跨 Project 的键连计划都过不了；账本层再拒绝被别的 Project 占用的键。

## 测试工程上的两点观察（不改，只记录）

- `src/apiserver/tsconfig.project-authorization.json` 的 `outDir` 是
  `./build/project-authorization`，比 pg spec 里 `path.resolve(__dirname,
  '../../prisma/migrations/...')` 预期的层级深一层，因此那两个 pg spec 无法从这份
  build 产物运行（`ENOENT .../build/prisma/migrations/...`）。从
  `tsconfig.test.json`（`outDir: ./build`）构建则路径正确。本次即按后者运行。
  属于既有测试配置问题，不在本任务允许改动的范围内，故只记录。
- 设了 `COORDINATOR_PG_URL` 之后用 `node --test "build/**/*.spec.js"` 一次性并发跑
  全部 220 个 spec 会卡住：**去掉本次新增的两个文件同样复现**（170 条断言处超时），
  因此与本次新增无关。此外 `coordinator-*.pg.spec.ts` 这一族历史 spec 共用一个库
  顺序跑时会互相干扰（出现 `The column task.owner_id does not exist in the current
  database`），它们各自需要独立数据库。真实 PG spec 应当
  `--test-concurrency=1` 并按单元分库运行。

## 遗留

- 本次验收范围内无遗留缺陷。
- 上面第 2 条（审批位的持久化来源）是后续单元必须闭合的接口边界，本报告已写明
  当前无法被动态证伪的确切原因。
