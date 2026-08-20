# 03D 修复：关闭 0114 Prisma 跨语句提交窗口

> 根因证据：`docs/project-coordinator-validation-04r3.md` 的 P1-04R3-01。被修复基线为
> `722f2aaf4358be2289eb154a421dcbf5550fa6eb`；该提交只记录独立复审报告与红灯，不修改
> 0114。本文不改写 04R3 的 FAIL 结论，而是记录后续修复及其复核入口。

## 1. 根因与不能采用的修法

Prisma PostgreSQL migration executor 不会自动把一个 `migration.sql` 的所有顶层语句包进同一
事务。0114 依次增加来源列、回填、再 `CREATE OR REPLACE` 延迟 reconciliation 函数；旧 writer
可以在回填已经提交、函数还停在 0113 时提交 Project。它留下：

```text
landing=A / member=A / source=DERIVED / identity_landing=NULL
```

原 0114 函数随后第一次处理 A→B 时，把 baseline-less 的 A 读成旧 binary 的显式选择，提交为
`landing=B / member=A / source=EXPLICIT`。这个状态冻结了错误 WHO。

不能修改已发布 0114 再补 `BEGIN/COMMIT`：已应用数据库已经记录它的 checksum，修改历史会把
部署兼容性变成工具版本的隐含行为。也不能把 no-baseline 一概解释成 DERIVED：旧 binary 的显式 C
同样写不了来源列，这会重新打开 04R2。修复因此保留 0114 的每一个字节和 DERIVED/EXPLICIT 语义。

## 2. 两段式迁移

### 2.1 0113 guard：窗口内 typed fail-closed

`0113_project_coordinator_identity_source_guard` 按目录名排在 0113 后、0114 前，并在一个显式事务中
安装两个立即触发器：

* Project INSERT；
* `coordinator_workspace_id` / `coordinator_session_id` UPDATE。

命中时抛出稳定 SQLSTATE `ORB02`，提示在 `prisma migrate deploy` 完成后重试。`CREATE TRIGGER`
取得的表锁也会等待 guard 安装前已经开始的 Project writer；因此 guard 提交以后，没有未受保护的
旧 Project 写入可以跨过 0114。部署若在 0114 或 0115 中断，guard 留在数据库里，表现为可见、可重试
的 fail-closed，而不是半迁移数据。

### 2.2 0115 repair：兼容已应用 0114，再原子撤 guard

`0115_project_coordinator_identity_window_repair` 自己也是一个显式事务，依次：

1. 只回填可证明安全的形状：`DERIVED + no-baseline + member == current landing`；EXPLICIT 从不降级。
2. 安装永久 BEFORE relocation 谓词。若第一次后续事件正是 A→B，它仍能读到 `OLD landing=A`；仅当
   runtime 是 DERIVED/no-baseline 且成员也是 A 时，先记录 baseline=A。0114 的延迟函数随后把成员与
   baseline 一起收敛到 B。显式 C 不等于 OLD landing，完全不命中，仍由 0114 提升并吸收。
3. 在同一事务的最后删除两个临时 guard trigger 和 guard function。最终库只保留永久 repair trigger，
   没有解除 guard 后才安装安全谓词的窗口。

这同时覆盖两条部署路线：

* **未来数据库**：0113 → guard → 0114 → 0115；窗口 writer 得到 ORB02，部署后重试并正常收敛。
* **已经记录 0114 的数据库**：Prisma 把新增、但词法顺序早于已记录 0114 的 guard 视为 pending，先
  应用它，再应用 0115；0114 checksum 不变。no-baseline DERIVED 行被安全回填或在第一次 relocation
  时由 OLD landing 修复。

### 2.3 已经被旧 0114 错误提升的行

若数据库不仅应用了 0114，而且在 0115 到来前已经把窗口行提升为
`EXPLICIT / baseline=NULL / member!=landing`，该行与真正的旧-binary 显式选择逐字节相同。0115
**不会静默 demote** 它。必须先用部署时段、请求审计和 owner 意图判定来源；确认是 0114 窗口派生后，
由 operator 在一个事务里锁 Project，复核 expected stale member、expected current landing、同租户 live
workspace，再把 coordinator member 改到 current landing，并把 runtime 原子写为
`DERIVED / baseline=current landing`。不能只按 SQL 形状批量执行，也不能用自动 fallback 代替判定。

## 3. 真实 Prisma fault injection

`coordinator-04r3-adversarial.pg.spec.ts` 保留原红灯，并新增真实 executor 夹具：

1. 用真实 `prisma migrate deploy` 把独立 schema 部署到 0113；
2. 加入正式 guard/0115，只在临时复制的 0114 backfill 后注入 `pg_sleep(4)`；
3. 通过独立 `application_name` 在 `pg_stat_activity` 观察 migration backend 为
   `active / PgSleep`；
4. 窗口内用 0110 形状 INSERT，精确断言 SQLSTATE `ORB02`，且 Project 行数仍为 0；
5. migration 完成后用同一旧 writer INSERT，再 A→B，精确得到
   `landing=B / member=B / DERIVED / baseline=B`。

另一个真实 executor 用例先只部署原 0114，读取 `_prisma_migrations.checksum` 并与原文件 SHA-256
比较；再把 guard 与 0115 加入 migration 目录。Prisma 会把两者都应用，0114 checksum 前后不变，
baseline-less 行转为安全基线并在 A→B 后收敛。

## 4. 复核结果

唯一 PostgreSQL 资源为 `pcc03d-pg-34acv9-20260820`，PostgreSQL 16.14，
`127.0.0.1:45443`，role `pcc03d_admin`。最终实例 system identifier 为
`7675956429340278819`，8 GiB tmpfs；数据库均以 `pcc03d_` 开头。最初的同名 3 GiB tmpfs 实例在恢复
真实 dump 时到达容量上限，已删除并以同名、更大 tmpfs 重建；没有改用或连接共享
`orbit-postgres/orbit`。

```text
# 空库真实 Prisma deploy
130 migrations / max 0115 / PASS

# 八个 coordinator PostgreSQL 文件（含真实 executor pause）
tests 73 / pass 73 / fail 0 / skipped 0

# 反向因果控制
COORDINATOR_PG_REVERSE_0114=1 provenance + final-row: 27 / 17 / 10
COORDINATOR_PG_REVERSE_0114=1 04r3-adversarial:      10 / 3 / 7
COORDINATOR_PG_REVERSE_0113=1 final-row:              16 / 6 / 10

# contract / Base62+API / runner-go
58 / 58
162 / 162
ok orbit

# 无数据库全集
tests 1833 / pass 1690 / fail 1 / skipped 142
# 唯一失败仍是既有 reorderRunners runsAsRoot select 断言；本修复新增 3 个 PG skip。

# TypeScript
29 个既有 runner-api TS2554；本修复新增 0。

# Prisma
prisma validate PASS；migrate diff 只有既有 run_status/session/session_tag/task drift，
没有 coordinator、project_member 或 project_runtime 条目。
```

## 5. 真实 0110 快照

只读 dump：
`/root/orbit/data/incident-20260819T0446Z/orbit-current-post-project-20260819T121806Z.dump`，
SHA-256 `f5853df3e9ffe3fd8451dc7c83287ba3d2a1a2731dadbd3f1dadea1c648ec8c8`。只把
production `public` schema 恢复到专用 `pcc03d_snapshot`；incident recovery/quarantine schema 不在产品
migration 路径内，没有恢复。PG17 dump 的 `SET transaction_timeout=0` 在 PG16 不存在，流式恢复时只过滤
该 SET；其余 public schema SQL 原样载入。

```text
before: migrations=124 / max=0110_task_run_at
        projects=3 / tasks=56246 / sessions=3608 / workspaces=18 / bound=3
        project_member=NULL / project_runtime=NULL

after:  migrations=130 / max=0115_project_coordinator_identity_window_repair
        业务计数逐字不变
        safe MANUAL+disabled=3/3
        runtimes=3 / nonzero generation=0 / session baselines=3
        DERIVED=3 / identity baselines=3
        members=3 / member==landing=3 / live same-tenant=3
        temporary guard triggers=0 / permanent repair trigger=1
```

真实行探针使用独立事务：DERIVED A→B 后得到 B/B/DERIVED/baseline=B；随后用旧 binary 形状把成员
改成 C，再把 landing B→A，得到 A/C/EXPLICIT/baseline=NULL。说明 0115 关闭窗口而没有放宽 03C 的
DERIVED/EXPLICIT 状态机。
