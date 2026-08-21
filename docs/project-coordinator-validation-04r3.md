# 04R3 独立复审：0114 coordinator identity provenance

结论：**FAIL（P1-04R3-01）**。被验提交为
`f288307567dce9993059ef58019cd38ac953970c`。0114 在迁移完成后的稳态行为通过了
既有与新增的正向矩阵，但迁移文件在 Prisma `migrate deploy` 下不是一个跨语句事务：
回填与 `CREATE OR REPLACE FUNCTION project_coordinator_reconcile()` 之间存在 mixed-version
writer 可提交的窗口。窗口内由 0113 函数派生的项目会留下
`source=DERIVED / identity_landing=NULL / member=A`；迁移后的首次 A→B relocation 将这个旧派生
误提升为 EXPLICIT 并保留 A，违反 04R 要求的 legacy-derived A→B 持续收敛。

本复审没有修改实现、迁移、Prisma schema 或权威契约；新增内容只有本报告与
`coordinator-04r3-adversarial.pg.spec.ts`。

## 1. 隔离与审计边界

* 新工作树：`/root/.orbit/worktrees/pcc04r3-34abi44c-20260820`
* 新分支：`orbit/04r3-independent-provenance-34abi44c`
* 起点：精确为 `f288307567dce9993059ef58019cd38ac953970c`
* PostgreSQL：唯一容器 `pcc04r3-pg-34abi44c-20260820`，PostgreSQL 16.14，
  `127.0.0.1:45442`，role `pcc04r3_admin`，system identifier
  `7675938939434364963`，tmpfs 数据目录，无 host data mount
* 仅在该容器内使用 `pcc04r3_verify`、`pcc04r3_atomicity`、
  `pcc04r3_atomicity2`、`pcc04r3_snapshot`、`pcc04r3_shadow`；从未连接、exec、迁移或测试
  `orbit-postgres/orbit`
* 历史 04/04R/04R2 Session 只读审计，没有恢复、发送、重启、结束、complete、cancel 或改写
* 已完整读取 Project goal、12 条 acceptance criteria、instructions；03/04、03A、04R、03B、
  04R2、03C 评论；04、03A、03B、04R2、03C 报告；PAC 与 coordinator contract 相关冻结规则；
  以及 `fe10704d..f2883075` 差异

## 2. P1-04R3-01：0114 的回填/函数替换不是原子迁移

### 2.1 可重复故障注入

在临时复制的 Prisma 目录中，只向 0114 回填之后、函数替换之前插入：

```sql
SELECT pg_sleep(12);
```

生产迁移文件与工作树保持不变。先把同一隔离集群的新库迁到 0113，创建 owner 与 landing A，
然后启动真实的：

```text
DATABASE_URL=postgresql://pcc04r3_admin:...@127.0.0.1:45442/pcc04r3_atomicity2 \
  npx prisma migrate deploy --schema /tmp/pcc04r3-atomicity-*/schema.prisma
```

控制台明确输出 `Applying migration 0114_project_coordinator_identity_source` 后，另一个连接观察并
执行 0110/0113 形状的 project INSERT。窗口观测为：

```text
active|Timeout|PgSleep|false|true
SET
INSERT 0 1
```

`PgSleep` 所在连接有 `xact_start`，但并发 INSERT 在 3 秒 lock timeout 内直接提交；因此该事务只
覆盖当前 sleep 语句，并不覆盖此前 ALTER/回填和此后的函数替换。迁移记录的总时长为
`00:00:12.03`，证明注入确实执行。窗口内提交行在迁移完成后的状态：

```text
landing=A | agent=A | source=DERIVED | identity_landing=NULL
```

随后创建同租户 live landing B，并用旧 writer 形状更新 `project.coordinator_workspace_id A→B`：

```text
UPDATE 1
landing=B | agent=A | source=EXPLICIT | identity_landing=NULL
```

0114 的结构判据把“窗口内旧函数派生但尚无 baseline”的 A 当成旧 binary 显式选择，静默冻结
了错误 WHO。正确结果必须是 `landing=B / agent=B / DERIVED / baseline=B`，或 typed
fail-closed；实际事务成功提交，所以这是 P1，不是测试环境噪声。

### 2.2 为什么普通回填和现有测试没有发现

同一注入的第一次尝试让 old-writer INSERT 落在迁移真正开始前。该行被 0114 回填为
`DERIVED + baseline=A`，后续行为正确。这证明问题不在普通 0110→0114 回填，而只在回填已经
提交、0114 函数尚未替换的窗口。现有 provenance 用例通过直接把整个 migration SQL 交给一个
`pg` query 建夹具；PostgreSQL simple-query 对那种调用形成整体事务，未复现 Prisma migration
engine 的逐语句提交方式。

### 2.3 修复门槛

不能通过放宽断言、改 PAC 或把 source 默认改为 EXPLICIT 解决。修复必须让旧 writer 在
“来源列可见”到“0114 reconcile 生效且既有行 baseline 完成”这一段不能提交不带 baseline 的
派生行，或增加可证明安全的迁后修复/判据；修复后必须保留本故障注入并证明窗口内 writer 要么
等待后由 0114 函数处理，要么其行被确定性修正。

## 3. 稳态正向矩阵

隔离护栏参数固定为数据库、role 与 system identifier 三元组。加入最终 blocker 用例后的八个
PostgreSQL 文件：

```text
node --test build/projects/coordinator-{identity-migration,identity-service,companions,
service-linearization,final-row,04r-adversarial,identity-provenance,04r3-adversarial}.pg.spec.js
tests 70 / pass 69 / fail 1 / skipped 0
# 唯一失败：a DERIVED row committed in the 0114 backfill/function gap still converges A to B
```

既有七文件保持 63/63；新增文件中 6 个稳态反例全部 PASS，第 7 个迁移窗口反例在应收敛
`agent=B` 处得到 `agent=A`，按设计保持红灯。6 个稳态反例覆盖：

| 格子 | 稳态结论 | 证据 |
|---|---|---|
| legacy DERIVED A→B | PASS | agent、landing、baseline 一起到 B |
| owner EXPLICIT C，old writer A→B | PASS | C 保持，source 保持 EXPLICIT |
| chooser-first / relocation-first 两种 commit ordering | PASS | 两种最终均 landing=B、agent=C |
| rotation、重复/乱序事件、replay | PASS | C 与 EXPLICIT 不变，generation 只按 session 基线递增 |
| clear、重复事件、reselect | PASS | clear 吸收；reselect 后新 C 吸收 |
| 非法 deleted / cross-tenant 显式 identity | PASS | SQLSTATE `ORB01`，整个 relocation/promotion 回滚 |
| disabled identity | PASS | WHO 仍真实且保持；运行路径另以 COORDINATOR_UNAVAILABLE 阻断 |
| source enum / NOT NULL / default DERIVED | PASS | 非法值与 NULL 被拒，旧 insert 得到 DERIVED |
| identity landing baseline 无 FK | PASS | 是历史判据；member FK/tenant/live 判定仍由权威行约束 |
| revision / unique / FK / tenant boundary | PASS | 既有 migration/service/linearization 用例全部通过 |
| generation baseline | PASS | rotation 与 replay 计数正确，A→B→A 不误增 |
| guarded-auto 安全默认 | PASS | create 默认 MANUAL/disabled；未给 policy 不写入 |

两个不可区分边界的精确裁决：

* **pre-0114 显式选择恰好等于 landing：严格吸收语义 FAIL / 行为确定。** 字节与 DERIVED 完全
  相同，0114 回填为 DERIVED，之后 relocation 会跟随 landing。0114 后通过当前 service 作同一
  选择则会原子记录 EXPLICIT 并 PASS。
* **old-binary 无 baseline clear：严格吸收语义 FAIL / 行为确定。** `member=NULL +
  baseline=NULL + DERIVED` 与“从未有身份”不可区分，下一合法 landing 会重新派生。P1-04R3-01
  证明迁移窗口可真实制造无 baseline 状态，因此这不只是不可达的理论形状。

## 4. 反向控制与旧断言审计

串行反向控制结果：

```text
# 0113 function on 0114 forward schema
COORDINATOR_PG_REVERSE_0114=1 provenance + final-row
tests 27 / pass 17 / fail 10

# 独立 04R3 反例 on 0113 function
COORDINATOR_PG_REVERSE_0114=1 04r3-adversarial
tests 7 / pass 1 / fail 6

# 0112 function on forward schema
COORDINATOR_PG_REVERSE_0113=1 final-row
tests 16 / pass 6 / fail 10
```

反向 0114 精确打红 explicit absorbing、同 landing choice、clear、非法 identity ORB01、并发顺序和
baseline；schema enum/default 那一格继续绿。反向 0113 精确打红 04R 的 final-row、代次、非法
落点与并发格。这使正向绿灯具有因果判别力。

Git 历史证明 03C 是订正自相矛盾，不是降低断言：

* `e2e426c6` 首次加入名为 “somebody chose” 的用例；先断言 rotation 保持显式
  `AGENT_DISABLED`，尾部却断言 relocation 把它改成 B。
* `9b4c0f1d` 在同文件加入 04R2 反例，明确要求同一显式 C 在旧 writer A→B 后保持 C；两条断言
  正面矛盾。
* `f2883075` 只把旧用例尾部改成 `landing=B / agent=AGENT_DISABLED`；此前三个 DERIVED
  final-row 用例仍要求 agent 跟随 B。
* 新增配对反例在同一 schema 中同时证明 DERIVED 到 B、EXPLICIT 留 C；反向 0113 时该用例变红。

因此断言方向的修正本身 PASS；它没有覆盖本报告的新迁移窗口。

## 5. 非数据库、契约与 Base62

```text
npx tsc -p tsconfig.test.json --pretty false
# 29 个分支既有 runner-api TS2554；04R3 新增 0

env -u COORDINATOR_PG_URL -u DATABASE_URL node --test "build/**/*.spec.js"
# tests 1830 / pass 1690 / fail 1 / skipped 139
# 无库时唯一失败仍是分支既有 reorderRunners；新增 7 个 PG 用例只增加 skip

node --test build/projects/coordinator-contract.spec.js
# 58/58

node --test build/common/public-id-coverage.spec.js build/common/public-id.spec.js \
  build/projects/project-coordinator.spec.js \
  build/projects/project-coordinator-identity.spec.js \
  build/projects/projects.service.spec.js \
  build/projects/project-session-coordinator-binding.spec.js \
  build/projects/project-task-page.spec.js
# 162/162

go test -run '^(TestMCPProject|TestProject|TestTaskCLI.*Project|TestMCPTask.*Project|TestTaskListCapabilitiesAdvertiseTheProjectFlag|TestTaskCreateCapabilitiesAndHelpAdvertiseTheProjectFlag)' -count=1 .
# ok orbit
```

`prisma validate` PASS。全库 migrate diff 仍列出分支既有的 run_status/session/session_tag/task
drift，但输出中没有 coordinator、project_member 或 project_runtime 条目。

## 6. 空库与真实 0110 全量快照

空 `pcc04r3_verify`：`prisma migrate deploy` 应用 128 个 migration 到 0114，PASS。

真实只读 dump：
`/root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump`，
前后 SHA-256 均为
`f5853df3e9ffe3fd8451dc7c83287ba3d2a1a2731dadbd3f1dadea1c648ec8c8`。只恢复到
`pcc04r3_snapshot`。PG17 dump 的 `SET transaction_timeout=0` 对 PG16 不可识别，因此流式恢复时
只过滤这一条 SET，其余 SQL 原样载入。

```text
before: migrations=124 max=0110_task_run_at
        projects=3 tasks=56246 sessions=3608 workspaces=18 bound=3
        project_member/project_runtime absent

after:  migrations=128 max=0114_project_coordinator_identity_source
        projects=3 tasks=56246 sessions=3608 workspaces=18 bound=3
        safe MANUAL+disabled defaults=3/3
        runtimes=3, nonzero generation=0, session baselines=3
        DERIVED=3, identity baselines=3
        members=3, member==landing=3, live same-tenant=3
```

手工重放 0114 输出 `UPDATE 0`。真实行探针先把 landing A→B，得到
`landing=B / agent=B / DERIVED / baseline=B`；随后按 0113 old-binary 形状把 member 改成 C，
再把 landing B→A，得到 `landing=A / agent=C / EXPLICIT / baseline=NULL`。因此常态快照前滚
PASS，但不能反证 P1 的部署中间态。

## 7. 最终门结论

0114 对 04R2 的稳态修复有效，03C 的断言订正也正确；真实数据与空库常态前滚均通过。
但是本门明确要求 0110..0114 mixed-version writer/reader 与 forward-schema rollback，且要求
legacy-derived A→B 必须持续收敛。P1-04R3-01 在真实 Prisma migration executor 上给出了成功
提交的反例，所以 04 与 04R3 都不得关闭。04R3 保持 IN_PROGRESS，等待研发修复后重新独立验收。
