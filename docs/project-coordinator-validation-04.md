# 04 独立验证：Coordinator 身份、策略迁移与 Base62 兼容性

日期：2026-08-20（Europe/Berlin）  
验证分支：`orbit/04-independent-validation-20260820`  
被验证提交：`86a89b932560407d62cb029f2b8428b6232eb6c0`  
父提交：`b9aa2e58c0757e6882fd69c100e73e94bd2a50ea`  
结论：**FAIL（P1 blockers，04 必须保持 IN_PROGRESS）**

## 1. 范围与独立性

验证前独立读取了 Project `349bHrtPbgwiouD3cfCVP` 的 goal、12 条 acceptance criteria、instructions，任务 03/04 的完整评论与提交差异，以及：

- `docs/project-agent-contract.md`（PAC）；
- `docs/project-coordinator-contract.md`（v1.14 权威正文）；
- `docs/project-coordinator-contract-review-02-v1.14-fresh.md`；
- `docs/project-coordinator-implementation-03.md`；
- `b9aa2e58..86a89b93` 的完整差异。

新工作树在任何修改前为 clean，并从 `feat/project` 的 `86a89b93` 新建验证分支；没有 reset、stash 或覆盖其他工作树。验证没有修改实现代码或权威契约，本文件是唯一新增证据。

## 2. 总结

正向结论：

- 新 Project 的服务层默认是 `coordinatorEnabled=true` / `GUARDED_AUTO`；迁移列默认是 `false` / `MANUAL`。
- Coordinator partial unique index、membership `(project, agent)` 唯一键、runtime FK/CASCADE 与 workspace FK/RESTRICT 均存在；隔离 PostgreSQL 测试 15/15 通过。
- 正常服务路径的 Coordinator Session 替换会保留旧 Session，并在同一事务中更新指针和 generation。
- 四个授权字段的写入各使 revision 增加一次，散文更新不增加；权威契约 §9.6 明确 revision 是观测版本而不是 CAS token，实际提交互斥依赖 project row lock。
- API / runner API 的 ID 定向测试 119/119 通过；runner CLI/MCP Project 定向 Go 测试通过，未发现 UUID 出站泄漏。
- 空库 125 个迁移成功。真实 0110 dump 全量恢复后，候选 0111 前滚成功，相关新增对象的 `migrate diff` grep 为空；3 个存量 Project 全部保留 `false/MANUAL`，3 个 runtime 行均为 generation 0，task/session/run_event 行数不变。
- 03 评论中的唯一无库失败 `reorderRunners` 在父提交和候选上逐字同样复现，且两个相关源文件在 `b9aa2e58..86a89b93` 无差异；它是解释清楚的父提交基线，不是 03 新回归。

但下列六项可复现 P1 阻止 PASS。

## 3. P1 blockers

### P1-01：真实存量的 Coordinator 身份没有回填

**原因**：真实 0110 dump 中 3/3 Project 都已有相互一致、同租户、live/enabled 的 `coordinator_session_id` 与 `coordinator_workspace_id`；0111 前滚后 `project_member.role=COORDINATOR` 仍为 0。`ProjectsService.coordinator()` 对仍存活的旧 Session 直接返回，不会补身份，因此这不是一次打开即可自愈的短暂状态。PAC §11.2 步骤 4/5 要求从默认协调 Workspace 镜像并回填 Project Team。

关键输出：

```text
bound_projects=3 workspace_owner_match=3 workspace_live=3 workspace_enabled=3
session_owner_match=3 session_workspace_match=3 coordinator_members=0
```

**责任人**：03 migration / identity 实现责任人。  
**所需动作**：在不伪造 Agent 身份的前提下，为满足 owner、live、enabled、session-workspace 一致性的存量绑定设计幂等回填；补真实快照断言，证明已有绑定前滚后有且仅有一个稳定 Coordinator 身份。若 02A Agent 表必须先落地，应显式调整依赖顺序，不能让 03 宣称身份完成。  
**下次检查**：修复 SHA 进入 `feat/project` 后 2 小时内，最迟 2026-08-21 12:00 CEST。

### P1-02：被删除的 Coordinator Session 可把稳定落点迁移到另一个 Workspace

**原因**：`ProjectsService.coordinator()` 的落点为 `workspaceId ?? rememberedWorkspace ?? busiestAssignee`；现有测试还明确接受 “a trashed coordinator may be replaced in a different workspace”。这与权威契约 §7.5 “只轮换 Session；Agent/Workspace 不变；原 Workspace 不可用时开 `COORDINATOR_UNAVAILABLE` 而不是搬家”冲突。03 文档把它称为“用户路径例外”，但公开 endpoint 实际执行的正是 Session replacement，任务 04 的验收没有该例外。

关键输出：

```text
ok 1 - a trashed coordinator may be replaced in a different workspace
result.created=true, result.workspaceId=WORKSPACE_OTHER
```

**责任人**：03 `ProjectsService.coordinator` 实现责任人。  
**所需动作**：所有 replacement 路径固定使用已记录的 `coordinatorWorkspaceId`；原 Workspace 缺失、软删、disabled 或不可运行时返回权威 typed blocker/错误，不更新 Workspace。补显式 workspace、软删 workspace、并发 replacement 的 PG 反例。  
**下次检查**：修复 SHA 进入 `feat/project` 后 2 小时内，最迟 2026-08-21 12:00 CEST。

### P1-03：Coordinator Agent 的软删除竞态可在提交时越过 liveness 边界

**原因**：`resolveAgent()` 在 project 事务和 row lock 之外检查 `workspace.deleted_at IS NULL`。故障注入在该读之后暂停，第二连接软删 Workspace，再恢复 update；FK 只能证明物理行存在，不能拒绝软删，最终 membership 成功提交并指向 deleted Agent。

关键输出：

```json
{"memberCommitted":true,"agentDeletedAt":"2026-08-19T23:09:53.356Z"}
```

现有单测 “an agent deleted between the check and the write” 只模拟物理删除产生 P2003，没有覆盖产品实际使用的软删除。

**责任人**：03 `ProjectsService.update/resolveAgent` 与 Workspace 删除写路径责任人。  
**所需动作**：在 project lock 事务内重读并锁定 Agent/Workspace；与软删除写路径采用一致锁序，保证两个提交顺序分别得到“membership 先提交则删除被拒/等待”或“删除先提交则 membership 被拒”。补两个真实 PG interleaving。  
**下次检查**：修复 SHA 进入 `feat/project` 后 2 小时内，最迟 2026-08-21 12:00 CEST。

### P1-04：指针/generation 事务失败会遗留 live、无引用的 Coordinator Session

**原因**：Session 在 project transaction 之前创建；清理只覆盖 CAS `count=0`，没有覆盖事务抛错。故障触发器令 `project_runtime` update 抛错后，project 指针和 generation 正确回滚，但新 Session 仍 live 且无任何 Project 引用。

关键输出：

```json
{"errorName":"PrismaClientUnknownRequestError","pointerRolledBack":true,"generation":"0","freshSessionExists":true,"freshSessionReferences":0}
```

**责任人**：03 `ProjectsService.coordinator` 实现责任人。  
**所需动作**：对 Session 创建之后的所有 swap/generation 失败统一执行 loser cleanup；cleanup 自身失败必须升级而不能报告成功。补 runtime update/FK/连接错误三个故障点，并断言无 live orphan。  
**下次检查**：修复 SHA 进入 `feat/project` 后 2 小时内，最迟 2026-08-21 12:00 CEST。

### P1-05：显式 null 绕过强校验并变成未映射 Prisma 500

**原因**：`@IsOptional()` 同时跳过 `undefined` 和 `null`。三个数据库 NOT NULL 字段 `coordinatorEnabled`、`automationPolicy`、`maxConcurrentTasks` 的 `null` 均得到 0 个 DTO validation errors，随后服务把 null 交给 Prisma，抛出没有业务 code/http status 的 `PrismaClientValidationError`。`sessionBudgetPerDay=null` 是唯一合法清空值，不在此问题内。

关键输出：

```text
coordinatorEnabled null []
automationPolicy null []
maxConcurrentTasks null []
coordinatorEnabled PrismaClientValidationError no-code no-http-status
automationPolicy PrismaClientValidationError no-code no-http-status
maxConcurrentTasks PrismaClientValidationError no-code no-http-status
```

**责任人**：03 Project DTO / API validation 责任人。  
**所需动作**：区分 omitted 与 explicit null；三个 NOT NULL 字段对 null 返回稳定 400，保留 `sessionBudgetPerDay=null`。用户 API 与 runner API 都补 route-level 测试。  
**下次检查**：修复 SHA 进入 `feat/project` 后 2 小时内，最迟 2026-08-21 12:00 CEST。

### P1-06：0111 DDL 后的 0110 旧写入可制造缺 runtime/identity 的半迁移 Project

**原因**：migration 只在执行当时回填 `project_runtime`；旧 0110 binary 在 rolling deploy 或 app rollback 期间仍可按旧 INSERT shape 创建 Project。数据库列默认保证它是 `false/MANUAL`，但没有 trigger/default relation 生成 runtime 或 Coordinator membership。真实 0110 全量快照前滚后的等价旧写入已提交为：

```text
coordinator_enabled=f automation_policy=MANUAL config_revision=0
has_runtime=f has_coordinator_agent=f
```

实现注释声称缺 runtime “只能是 runtime row 出现前创建的 Project”，该假设在 mixed-version window 中不成立。

**责任人**：03 migration / release compatibility 责任人。  
**所需动作**：给出并实现可机械验证的 mixed-version 协议：要么 DB 保证旧 INSERT 也原子生成必需伴生行，要么发布流程在 migration 前排空并禁止旧 writer，且正式撤回 rolling/rollback 兼容声明。补旧 writer→新 reader/rotation 的 PG 测试。数据库 downgrade 不应作为回滚；安全回滚只能是应用回滚并保留 forward schema，但当前缺行问题必须先解决。  
**下次检查**：修复 SHA 进入 `feat/project` 后 2 小时内，最迟 2026-08-21 12:00 CEST。

## 4. 迁移验证

唯一数据库资源为本任务创建的 `pcc04-pg-349bqgnv-20260820`，始终绑定 `127.0.0.1`，无 host mount；从未连接或 exec 共享 `orbit-postgres/orbit`。

真实快照：

```text
file=/root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump
sha256=f5853df3e9ffe3fd8451dc7c83287ba3d2a1a2731dadbd3f1dadea1c648ec8c8
before: 124 migrations, lexical max 0110_task_run_at, database_size=2916 MB
before: projects=3 tasks=56246 sessions=3608 run_events=3893496 project_fk_orphans=0
after:  125 migrations, 0111_project_coordinator_identity applied
after:  projects=3 safe_defaults=3 runtime_rows=3 generation=[0,0]
after:  tasks=56246 sessions=3608 run_events=3893496
related migrate-diff grep: 0 matches
```

第一次 2 GiB tmpfs 全量恢复在 `COPY run_event` 约 254 万行处因验证资源容量耗尽，未归因于候选 migration；删除同一个自有容器并按原名用 8 GiB tmpfs 重建后，全量恢复与 0111 前滚成功。最终报告只采用后一次完整结果。

迁移本身是 additive，旧 binary 读取既有对象可以工作；实际 rollback 应回滚应用并保留 forward DB。直接降级 DB 会丢失新列、枚举、runtime/member 行且不可安全支持新写入。另有 mixed-version P1-06，以及新版本写入 membership 后，旧版本硬删 Workspace 会被新 RESTRICT FK 拒绝的行为差异。

## 5. 测试与命令

环境：Linux 6.12.38 x86_64；Node v22.22.2；npm 10.9.7；TypeScript 5.9.3；Git 2.47.3；Docker 29.5.2；PostgreSQL 16.14。

主要命令与结果：

```bash
# 对齐与差异
git rev-parse HEAD HEAD^ feat/project
git diff --stat b9aa2e58c0757e6882fd69c100e73e94bd2a50ea 86a89b932560407d62cb029f2b8428b6232eb6c0

# 编译与无库全集（从 src/apiserver 执行）
npx tsc -p tsconfig.test.json --pretty false
env -u COORDINATOR_PG_URL -u DATABASE_URL node --test "build/**/*.spec.js"
# tsc: 29 个既有 TS2554；node test: 1763 total, 1678 pass, 1 fail, 84 skipped

# Base62/API/runner API
env -u COORDINATOR_PG_URL -u DATABASE_URL node --test \
  build/common/public-id-body-coverage.spec.js \
  build/common/public-id-coverage.spec.js \
  build/common/public-id-headers.spec.js \
  build/common/public-id.interceptor.spec.js \
  build/projects/project-coordinator-identity.spec.js \
  build/projects/project-session-coordinator-binding.spec.js \
  build/runner-api/runner-projects.controller.spec.js
# 119/119 pass

# CLI/MCP Project 定向（从 src/runner-go 执行）
go test -run '^(TestMCPProject|TestProject|TestTaskCLI.*Project|TestMCPTask.*Project|TestTaskListCapabilitiesAdvertiseTheProjectFlag|TestTaskCreateCapabilitiesAndHelpAdvertiseTheProjectFlag)' -count=1 .
# ok orbit

# 真实 PG 测试（密码仅属于已删除的 throwaway 容器）
COORDINATOR_PG_URL='postgresql://pcc04_admin:***@127.0.0.1:32785/pcc04_verify?schema=public' \
COORDINATOR_PG_EXPECTED_DATABASE=pcc04_verify \
COORDINATOR_PG_EXPECTED_USER=pcc04_admin \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=7675882652792823843 \
node --test build/projects/coordinator-identity-migration.pg.spec.js \
  build/projects/coordinator-identity-service.pg.spec.js
# 15/15 pass

# 空库
DATABASE_URL='postgresql://pcc04_admin:***@127.0.0.1:32785/pcc04_verify?schema=public' \
  npm run prisma:deploy -w @orbit/apiserver
# 125 migrations applied

# 真实 0110 dump 全量恢复（PG17 client 产生 PG16 不认识的 SET，故只过滤该兼容性行）
set -o pipefail
pg_restore --no-owner --no-privileges --exit-on-error -f - \
  /root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump \
  | sed '/^SET transaction_timeout =/d' \
  | docker exec -i pcc04-pg-349bqgnv-20260820 \
      psql -U pcc04_admin -d pcc04_real0110 -X -v ON_ERROR_STOP=1

DATABASE_URL='postgresql://pcc04_admin:***@127.0.0.1:32785/pcc04_real0110?schema=public' \
  npm run prisma:deploy -w @orbit/apiserver

npx prisma migrate diff \
  --from-url 'postgresql://pcc04_admin:***@127.0.0.1:32785/pcc04_real0110?schema=public' \
  --to-schema-datamodel src/apiserver/prisma/schema.prisma --script \
  | grep -nE 'project_member|project_runtime|coordinator_(enabled|generation)|automation_policy|max_concurrent_tasks|session_budget_per_day|config_revision'
# grep exit 1, 0 matches

# 03 唯一无库失败：候选和父提交分别执行
node --test --test-name-pattern='reorderRunners' build/runners/runners.service.spec.js
git diff --exit-code b9aa2e58c0757e6882fd69c100e73e94bd2a50ea \
  86a89b932560407d62cb029f2b8428b6232eb6c0 -- \
  src/apiserver/src/runners/runners.service.ts \
  src/apiserver/src/runners/runners.service.spec.ts
# parent/candidate 均同一 runsAsRoot expectation failure；diff exit 0

# rotation 反例（现有候选测试把错误行为写成 PASS）
node --test --test-name-pattern='a trashed coordinator may be replaced in a different workspace' \
  build/projects/project-coordinator.spec.js

# DTO null probe
node -e 'require("reflect-metadata"); const {plainToInstance}=require("class-transformer"); const {validate}=require("class-validator"); const {UpdateProjectDto}=require("./build/projects/dto.js"); (async()=>{for(const field of ["coordinatorEnabled","automationPolicy","maxConcurrentTasks"]){const errors=await validate(plainToInstance(UpdateProjectDto,{[field]:null})); console.log(field,"null",errors.map(e=>e.constraints));}})()'
```

另外在 `pcc04_verify` 上执行了三个内联、双连接 Node/Prisma probe：

1. `workspace.findFirst` live 检查后暂停 → 第二连接软删 → 恢复 `ProjectsService.update`；
2. Session create 完成后，用 `BEFORE UPDATE project_runtime` trigger 注入异常 → 检查 pointer/generation/orphan；
3. 对三个 NOT NULL policy 字段逐一把 `null` 送入真实 `ProjectsService.update`。

它们的完整关键输出记录于 P1-03/P1-04/P1-05；probe 结束后固定 ID fixture、trigger、function 均精确删除，复核为：

```text
fixture_rows=0
fault_trigger=0
fault_function=0
```

## 6. 基线与未计入候选回归的失败

- Candidate 无库全集：`1763 total / 1678 pass / 1 fail / 84 skipped`。唯一 fail 是 `reorderRunners`。
- Parent `b9aa2e58` 对同一个 compiled test 的 actual/expected diff 完全相同，都是新增已有 `runsAsRoot: true` 与旧 expectation 不一致；03 差异没有触及这两个源文件。因此本项是已解释的父提交基线。
- `tsc -p tsconfig.test.json` 的 29 个 TS2554（runner-api spec 构造参数）在父提交和候选相同，不计为 03 回归。
- runner-go 全集另有既有 `TestKimiFindProjectRootFallsBackToCWD` 环境失败；本任务覆盖的 Project/CLI/MCP 精确定向集通过。

## 7. 资源与合并

报告提交前已完成：

- 删除唯一自建容器 `pcc04-pg-349bqgnv-20260820`；
- 删除 `/tmp/pcc04-prisma-0110` 与父提交临时 worktree `/tmp/pcc04-parent-b9aa2e58`；
- 删除本工作树中验证产生的 ignored build/dependency overlay；

提交与合并步骤将复核 `feat-project-deploy` 的 staged `M README.md`、`D docs/project-agent-contract.md` 与 staged binary diff SHA-256 `966c46d48ff68e27f9a479eca869e92a8f203d6c2a4466eaa8d48a2d9fcf8105` 在 `--ff-only` 合并前后完全不变。

由于结论是 FAIL，任务 04 不得置 DONE，也不得启动下游；本报告合并不改变这一状态。
