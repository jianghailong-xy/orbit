# 04R2 独立复审：0113 最终行协调身份

日期：2026-08-20（Europe/Berlin）  
任务：`34A9hr8j41AsVajr3Uo8j`  
被验提交：`e2e426c67c864acafe91d59a4365c8d2d05ebd8c`  
起点：`541d17b8291c0685a4aeb6285022d38413471418`  
结论：**FAIL — 1 个 P1 blocker**

## 1. 独立性与审计边界

- 从 `feat/project=e2e426c67c864acafe91d59a4365c8d2d05ebd8c` 新建隔离工作树
  `/root/.orbit/worktrees/pcc04r2-34a9hr8j-20260820`；修改前 `HEAD` 精确等于被验提交，工作区干净。
- 完整读取 Project `349bHrtPbgwiouD3cfCVP` 的 goal、12 条 acceptance criteria、instructions，
  以及 03、04、03A、失败 04R、03B 的全部评论；没有采信研发自述作为验收证据。
- 完整复核 `docs/project-coordinator-validation-04.md`、`repair-03a.md`、`repair-03b.md`、PAC、
  Coordinator contract 的相关权威条款、0110–0113 迁移，以及 `541d17b8..e2e426c6` 全部差异。
- 未恢复、发消息、重启、结束、complete、cancel 或改写历史 Session
  `34A5vNaM8X62KbIfBn2wD` / `34A8GrCXcJxG5PT59LUeM`。
- 数据库验证只使用本任务创建的 `pcc04r2-pg-34a9hr8j-20260820`（PostgreSQL 16.14，tmpfs，
  `127.0.0.1:45439`，system identifier `7675917932067987491`）及其
  `pcc04r2_verify` / `pcc04r2_reverse` / `pcc04r2_snapshot` 三个库。共享
  `orbit-postgres` / `orbit` 从未被连接、exec、迁移或测试。

## 2. P1-04R2-01：旧 writer 的 WHERE 变更静默覆盖显式 WHO

### 最小交错

1. 0110 writer 建 Project，落点 A、Session S1；0113 合法派生 Coordinator Agent A。
2. owner 经 `PATCH /projects/:id` 的 `coordinatorAgentId` 明确选择同租户、live 的 Agent C；
   `project_member.role=COORDINATOR` 现在是 C，而落点仍是 A。
3. 滚动部署中的 0110 writer 不认识 `project_member` / `coordinatorAgentId`，只把
   `project.coordinator_workspace_id` 从 A 改为 B，并把 Session 从 S1 改为 S2。
4. COMMIT 成功；0113 的 `landing` 触发器删除 C 的成员行并插入 B。新 reader 读到 B，
   owner 的显式身份选择无错误、无拒绝、无审计地丢失。

真实 PostgreSQL 结果：

```text
test: an old writer relocating WHERE cannot silently overwrite an explicitly chosen WHO
expected agent = 00000000-0000-7000-8000-0000000006b5  (explicit C)
actual   agent = 00000000-0000-7000-8000-0000000006b2  (landing B)
landing = B, generation = 1, transaction committed
```

### 为什么是契约失败

- PAC R3 冻结 WHO / WITH WHAT / WHERE 为三条独立解析链，禁止一条链成为另一条链的隐式输入。
- Coordinator contract §1.2 把 `project_member.role=COORDINATOR` 定义为稳定身份，把
  `project.coordinatorWorkspaceId` 单独定义为协调 Session 的运行位置。
- §7.5 进一步规定 Session 轮换只换 Session、Agent 不变，且落点不能静默迁移。
- 0113 `project_coordinator_reconcile()` 只在 `TG_ARGV[0]='rotation'` 时保留既有成员；任何
  `landing` 事件都在第 211–214 行删掉既有成员并按 Workspace 重建，因此无法区分“迁移派生身份”
  与“owner 已显式选择身份”。

这不是“陈旧 A 与落点 B 不一致”的 04R 旧缺陷：C 是 owner 明确选择、与 WHERE 独立的权威 WHO，
不是从 A 派生出的陈旧值。0113 把两种状态压成同一种处理，修复了前者，却破坏了后者。

### 严重级别、责任边界与恢复动作

- **P1**：滚动部署或 forward-schema 回滚到 0110 writer 时，已授权身份可被静默改写；没有数据损坏到
  无法恢复，也不直接产生 live orphan，因此不是 P0。
- 责任组件：`0113_project_coordinator_final_row` 的 identity provenance / landing reconciliation，
  不是 API DTO、Session rotation 或 PAC。
- 所需动作：在数据库中持久区分“由 legacy landing 派生”与“owner 显式选择”，或让旧 writer 的
  relocation 在不能证明可覆盖时 typed fail-closed；随后用本报告加入的反例证明 C 保留或事务可见失败，
  同时保持 04R 的 A→B 修复。
- 下次检查：产生新的修复 SHA 后立即重新跑本报告 §3–§6 全矩阵。当前 04 与 04R2 必须保持
  `IN_PROGRESS`。

## 3. 原 04 六个 P1 与 04R 回归矩阵

| 边界 | 独立结果 | 证据 |
|---|---|---|
| P1-01 存量身份/运行时安全幂等回填 | PASS | 迁移 spec；真实 0110 快照 3/3 项目均有 runtime 与 live 同租户 coordinator member；0113 重放 `UPDATE 0` |
| P1-02 固定 Agent/Workspace、不可用 typed fail-closed | PASS（除本报告的新旧 writer 边界） | service linearization：已绑定落点不迁移；deleted/disabled/unrunnable 返回 `COORDINATOR_UNAVAILABLE` |
| P1-03 soft-delete/member 两种 commit ordering | PASS | `membership first` / `delete first` 两条真实双连接用例均通过 |
| P1-04 swap/generation 多故障无 live orphan | PASS | commit fault、statement fault、FK fault、双 caller race 均无 live loser；9/9 service PG |
| P1-05 三个 explicit null 稳定 400，预算 null 合法 | PASS | DTO/AppPipe/runner door；三项各有 validation error，`sessionBudgetPerDay=null` 0 error |
| P1-06 old writer 机械伴生 runtime/identity | PASS | 0110 insert/update、rotation count、服务接管均通过 |
| 04R insert A→update B 最终身份 | PASS | 原 04R 反例原样 3/3；最终 Project 行给出 B |
| 04R old-writer A→B | PASS | generation=1、baseline=S2、identity=B |
| insert+delete 同事务 | PASS | 合法 COMMIT，project/member/runtime 均无残留 |
| owner 显式 WHO + old-writer WHERE relocation | **FAIL (P1-04R2-01)** | COMMIT 后显式 C 被静默替换为 B |

候选自带六文件矩阵在未加入新反例前是 **49/49 pass**。加入两个独立用例后是
**51 total / 50 pass / 1 fail**：新增的 A→B→C landing 最终行用例通过，只有显式 WHO 用例失败。

## 4. 0113 最终行、反例与边界

以下均在真实 PostgreSQL 上重新验证：

- INSERT A→UPDATE B、old-writer A→B、A→B→A、Session A→B→C、landing A→B→C；
- 重复/乱序 deferred events、空值丢失与重绑、相同值重放、0113 migration 重放；
- 跨租户、软删落点、禁用落点、显式 Agent 跨 Session rotation；
- partial unique T1/T2、FK CASCADE/RESTRICT、tenant/live predicate、runtime baseline 与 generation；
- insert+delete 无残留、landing relocation 与 soft-delete 的两个 commit ordering。

正向新增矩阵：**16 total / 15 pass / 1 P1 fail**。  
反向重装 0112：**16 total / 5 pass / 11 fail**；新加的 landing A→B→C 用例也变红，而显式 WHO
用例在 0112 下反而通过，直接证明 P1 是 0113 新引入的过度覆盖。原失败 04R 三项在 0112 对照库上
仍为 **3 total / 1 pass / 2 fail**（只有 insert+delete 合法项通过）。

## 5. API、默认值、约束与非数据库回归

- Base62 / public-id / owner API / runner API 定向：**123/123 pass**；Runner CLI/MCP Project
  定向 Go 测试：`ok orbit`。未见 UUID 出站泄漏。
- `coordinatorEnabled=null`、`automationPolicy=null`、`maxConcurrentTasks=null` 各被拒；
  `sessionBudgetPerDay=null` 合法。runner 治理入口在写入前拒绝 owner-only 字段。
- 新 Project 由服务显式写 `GUARDED_AUTO`；数据库安全默认供 legacy/存量使用：
  `false / MANUAL / 3 / NULL / revision 0`。
- 空库 `prisma migrate deploy`：127 migrations，最大 `0113_project_coordinator_final_row`；
  `prisma validate` 成功；migrate diff 对 coordinator 相关对象 **0 matches**。
- `project_member`：T1 `(project_id,agent_id)` unique、T2 coordinator partial unique、agent index；
  Project FK `CASCADE`、Agent/Workspace FK `RESTRICT`。`project_runtime` 以 Project 为 PK/FK `CASCADE`。
- 三个 Project constraint trigger 均 `DEFERRABLE INITIALLY DEFERRED` 且只指向
  `project_coordinator_reconcile`；0112 两个旧函数为 0。
- TypeScript test build 仍是父提交已有的 29 个 runner-api `TS2554`，新增文件 0 个类型错误。
- 无库全集（加入 2 个 PG-only skip 后）：**1811 total / 1690 pass / 1 fail / 120 skipped**。
  唯一失败 `reorderRunners…runsAsRoot` 在 541d17b8 与 e2e426c6 上逐字相同，相关 source diff 为 0，
  与本候选无关。

## 6. 真实 0110 全量快照前滚

只读源：

```text
/root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump
sha256 f5853df3e9ffe3fd8451dc7c83287ba3d2a1a2731dadbd3f1dadea1c648ec8c8
```

恢复前：124 migrations，最大 `0110_task_run_at`，数据库 2916 MB；projects=3、tasks=56246、
sessions=3608、run_events=3893496、workspaces=18、bound_projects=3。

前滚后：127 migrations；safe legacy defaults=3/3；runtime=3、generation nonzero=0、
baseline matches Project=3/3；coordinator members=3、landing match=3/3、owner match=3/3、live=3/3；
tasks/sessions/run_events 数量不变。原 04R 三项在该前滚库 **3/3 pass**。

手工重放 0113：`ADD COLUMN` notice、backfill `UPDATE 0`，随后 projects/members/runtime 仍为 3/3/3、
generation nonzero=0、baseline match=3/3。相关 migrate diff 0 matches。独立显式 WHO 反例在快照实例上同样
稳定复现（16 total / 15 pass / 1 fail）。

## 7. 混合版本与回滚结论

| 组合 | 结论 |
|---|---|
| 0110 writer → 0113 schema → 新 reader（无显式 WHO） | PASS：final-row trigger 机械补齐 runtime/identity，A→B 不陈旧 |
| 0111/0112 writer → 0113 schema | 基本兼容：新增 baseline 列可忽略，现有服务写与触发器可共同提交 |
| 0113 writer/readers 滚动部署 | 已覆盖的创建、轮换、重放与故障路径通过 |
| owner 显式 WHO → 0110 writer relocation → 0113 schema | **FAIL：静默授权改写，P1-04R2-01** |
| forward schema + 0110/0111/0112 binary rollback | **不满足安全协议**：旧 binary 可触发上述静默覆盖；不能宣称安全回滚 |
| 物理回退到 0112 函数/触发器 | 不安全：04R 两项与最终行 11 项反向对照失败 |

因此 0113 对“最终 Project 行”“代次/伴生行”“跨租户与软删”已经形成有效修复，但混合版本协议还缺少
显式身份的 provenance/fence。该 P1 关闭前，本验收门不能 PASS。

## 8. 资源清理

验证结束后只执行 `docker rm -f pcc04r2-pg-34a9hr8j-20260820`；该 tmpfs 容器及三个
`pcc04r2_*` 数据库均已消失，`docker ps -a --filter name=pcc04r2-pg-34a9hr8j-20260820`
返回空。共享 `/orbit-postgres` 仍为 `running healthy`，启动时间保持
`2026-08-19T15:15:24.477443791Z`，与本复审开始前一致。
