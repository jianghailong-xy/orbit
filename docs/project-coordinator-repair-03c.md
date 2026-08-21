# 单元 03C 修复说明：把协调身份的来源写进数据库，并保护显式 WHO

> 权威契约：[`project-coordinator-contract.md`](./project-coordinator-contract.md) §1.2 · §7.5 · §12.1，
> 以及 `project-agent-contract.md`（PAC）R3 · M2 · §11.2 步骤 4/5。
> 被修复对象：单元 03B（提交 `e2e426c6`，格式化后 `fe10704d`）。失败依据：04R2 独立复审在唯一隔离库上
> 稳定复现的 **P1-04R2-01**（报告 [`project-coordinator-validation-04r2.md`](./project-coordinator-validation-04r2.md)）。
> **04R2 的 FAIL 结论、其 Session `34A9idAqG7nvEY3ovRj8L`、04 `34A5vNaM8X62KbIfBn2wD` 与 04R
> `34A8GrCXcJxG5PT59LUeM` 一字未改**；本文只记录 03C 改了什么、为什么，以及它证明到哪里为止。
> 冲突时一律以契约为准。

## 1. 根因

0113 让三个延迟约束触发器在 `COMMIT` 时**锁住 Project 行重读**，于是"身份必须与落库的行一致"成立，
04R 的陈旧身份被关闭。它是靠**把每个 `landing` 事件都当成重新派生的授权**做到这一点的：
`project_coordinator_reconcile` 在 `TG_ARGV[0]='landing'` 时删掉既有 `project_member`，再按
`coordinator_workspace_id` 重建。

问题在于，**"身份是 A、落点是 B"这一个状态有两种来源**，而 `project` 与 `project_member` 两张表
之间没有任何一列能说出是哪一种：

| 来源 | 交错 | 正确答案 |
|---|---|---|
| 数据库自己派生的**陈旧值** | 0110 writer 把落点 A→B，身份仍停在 A | 收敛到 B（04R） |
| owner 通过 `coordinatorAgentId` **明确选择**的 C | 落点仍是 A，身份是 C；随后 0110 writer 把落点 A→B | 保持 C（04R2） |

0113 把两者压成同一种处理：修好了第一种，第二种被无错误、无拒绝、无审计地改写。这违反 PAC R3
（WHO / WITH WHAT / WHERE 是三条独立解析链，一条不得成为另一条的隐式输入）与 contract §1.2
（`project_member.role=COORDINATOR` 是稳定身份，`coordinatorWorkspaceId` 只是协调 Session 的运行位置）。

**缺的事实不在这两张表里，所以 0114 把它写下来。**

## 2. 修法：两列来源，落在既有 `project_runtime` 上

不新增业务实体（Project + Task 仍是仅有的两个业务概念）；来源写在**控制环自己的行**上，
也就是 0113 已经用来存"代次基线"的那张表。**不放在 `project_member` 上**，因为来源必须比成员行活得久：
"owner 清空了协调者"同样是一个选择，`landing` 事件不得用"座位没了"当作可以重新安排一个的理由。

```
project_runtime.coordinator_identity_source       project_identity_source NOT NULL DEFAULT 'DERIVED'
project_runtime.coordinator_identity_landing_id   UUID NULL
```

* `coordinator_identity_source` — `DERIVED`（数据库从落点推出来的，可以再推一次）或
  `EXPLICIT`（有人选的，包括选择"没有"）。**当前 service 在写成员行的同一个事务里写它**。
* `coordinator_identity_landing_id` — `DERIVED` 身份**是从哪个落点派生的**，与
  `coordinator_session_id` 之于代次完全同构。它是**结构性证据**：数据库派生的座位一定叫得出这个
  workspace，所以叫别人的座位一定是被人搬过的，消失的座位一定是被人删掉的。

第二列不是保险，它就是**回滚协议本身**。0113 时代的 binary 回滚到 0114 schema 上（schema 前滚、
app 后退，正是这一系列迁移针对的部署形态）会直接写 `project_member.agent_id`，而写不了来源列——
结构性判据不需要写入方配合，所以它的显式选择照样被认出来，并且**被记下来**，让下一个同样不会做这个
判断的写入方直接继承结论。

`DEFAULT 'DERIVED'` 而不是 `EXPLICIT`：这是每一行存量必须保持的值，也是唯一让数据库**仍有能力自我
纠正**的答案；默认成 `EXPLICIT` 会把 04R 关闭的每一个陈旧派生原地冻结。有默认值而不是 NOT NULL 无默认：
0113 时代的 binary 会插入 `project_runtime` 行（`ProjectsService.create`）而不提这一列，
"回滚后插不进 Project"比"回滚后插进一个可派生的 Project"更糟。

### 2.1 判定顺序（`project_coordinator_reconcile`，0114 版）

0113 的每一步都保留——最终行读取、`FOR NO KEY UPDATE`、runtime 行、代次基线、租户与软删条件、
rotation 分流、delete-then-insert——只在决定 `landing` 事件能做什么之前插进一个问题：
**这个座位是数据库放的那个吗？**

1. 锁住并重读最终 Project 行；行没了就什么都不做。
2. runtime 行与代次基线（0113 原样）。
3. 读座位与来源。
4. **提升**：`source='DERIVED'` 且（座位既不是记录的派生值、也不是当前落点）或（座位没了而派生值有记录）
   → `source := 'EXPLICIT'`，派生基线清空，**落库**。
5. 落点为 NULL → 返回（没有可派生的东西，也不是解散团队的指令）。
6. 座位 == 落点 → 返回；顺手把没记下来的派生基线补上（0112/0113 时代的触发器或回滚 binary 留下的）。
7. `source='EXPLICIT'` → **保持**。没有座位就是"明确不要协调者"，`landing` 不得凭空安排一个；
   有座位则在 `FOR SHARE` 下验证它仍是本账号的 live agent，**验不过就 `RAISE EXCEPTION`（`ERRCODE=ORB01`）**。
8. rotation 且已有座位 → 返回（§7.5，0113 原样）。
9. 派生路径（0113 原样）+ 记录派生基线。

第 7 步是"无法证明安全就结构化 fail-closed"：这个状态**产品路径到不了**
（`writeCoordinatorAgent` 在锁下校验，`WorkspacesService.remove` 拒绝删除仍在协调项目的 agent）；
真到了，这个函数绝不能做的两件事是**安排一个 PAC M2 排除的 agent**和**悄悄替换 owner 的选择**——
让事务可见地失败是唯一两件都不做的答案。

### 2.2 来源状态机

```
                    ┌──────────────────────────── 存量回填 ────────────────────────────┐
                    │  座位 = 落点  → DERIVED, 基线 := 落点                            │
                    │  座位 ≠ 落点  → EXPLICIT, 基线 := NULL   （只有选择者写得出来）  │
                    │  无座位       → DERIVED, 基线 := NULL                            │
                    └─────────────────────────────────────────────────────────────────┘

   DERIVED ──── 0110 writer 迁落点 ─────────────────► DERIVED（座位跟走，基线跟走）   [04R]
   DERIVED ──── service 设/换/清 coordinatorAgentId ─► EXPLICIT（同事务写来源）
   DERIVED ──── 回滚 binary 直接改 project_member ───► EXPLICIT（结构性提升，落库）   [04R2]
   DERIVED ──── 有人删掉数据库派生的座位 ────────────► EXPLICIT（结构性提升，落库）
   EXPLICIT ─── 任何 landing / rotation / 重放 ──────► EXPLICIT（不变；不合法则 ORB01）
   EXPLICIT ─── service 再次显式写 ──────────────────► EXPLICIT
```

`EXPLICIT` 是吸收态：没有任何操作把一个项目退回"数据库可以替我决定"。

### 2.3 六个边界的明确规则

| 边界 | 规则 |
|---|---|
| 新建 Project | `ProjectsService.create` 写 `runtime.coordinatorIdentityLandingId = 落点`，来源保持 `DERIVED`——座位是"记录这个项目的会话所在的 agent"，没有人**选**过它，所以落点将来移动时仍应收敛 |
| 存量 0110/0111/0112/0113 | 见上表。0114 之前的每个 COORDINATOR 成员行只可能来自四条派生路径（0112 回填、0112/0113 触发器、`create`）或 owner 的显式写，而四条派生路径**都写落点**，所以"座位 ≠ 落点"是可证明的选择 |
| 显式选择恰好等于落点 | **当前 service 记为 `EXPLICIT`**（`writeCoordinatorAgent` 即使成员行不变也写来源）。**写不了来源列的写入方**（回滚 binary、裸 SQL）留下的同样状态与派生**不可区分**，按 `DERIVED` 处理——这也是回填对该格的答案，理由相同：反过来读会冻结 04R 关闭的一切 |
| clear / reselect | clear 记 `EXPLICIT` 且无座位 → `landing` 事件不得安排协调者；结构性版本（有人删掉数据库派生的座位）走同一条提升规则。reselect 是普通显式写，照常生效 |
| 软删 / 跨租户 | 座位 == 落点时落点软删不动身份（0113 原样）；`EXPLICIT` 座位自身不合法时 `ORB01` fail-closed；派生路径的两个安全条件（同账号、未软删）一字未改 |
| 并发提交顺序 | 显式写走 `ProjectsService.update` 的 Project 行锁，0110 relocation 的 UPDATE 取同一把 `FOR NO KEY UPDATE`，两者是两个顺序而不是交错；后到的那个重读先提交的结果 |

代次逻辑**完全未改**：基线不回退、不重复增代，来源的变化不触碰计数。

## 3. 反例关闭映射

| 编号 | 反例 | 关闭方式 | 证据 |
|---|---|---|---|
| P1-04R2-01 | 旧 writer 迁 WHERE 静默覆盖显式 WHO | 0114 来源列 + 结构性判据；`landing` 事件对 `EXPLICIT` 身份只读不写 | `coordinator-final-row.pg.spec.ts`「an old writer relocating WHERE cannot silently overwrite an explicitly chosen WHO」；`coordinator-identity-provenance.pg.spec.ts` 11 例 |
| 04R（回归保护） | 0110 relocation 留下陈旧身份 | 派生身份仍按最终行收敛，基线随之移动 | 同文件「a 0110 relocation moves the identity with the landing」「a derived identity is recorded as derived, and still follows its landing」 |

**一处旧断言被订正**（不是放宽）：`coordinator-final-row.pg.spec.ts`
「rotating the session leaves a coordinator somebody chose exactly where it was」的**末尾两行**原本断言
"迁落点会重新派生"（`agent === AGENT_B`）。那正是 P1-04R2-01 的另一种写法：同一个文件里它与 04R2 加入的
反例互相矛盾，任何实现都不可能同时满足。现改为断言 `landing` 变成 B 而 `agent` 仍是被选中的那个，
并在注释里写明这是 04R2 记录的缺陷。测试的前半段（rotation 不换 agent、代次仍 +1）一字未动。

## 4. 复核入口

```bash
# 一次性隔离 PostgreSQL（本任务唯一；禁止指向共享 orbit-postgres/orbit）
docker run -d --name pcc03c-pg-34aasqy3-20260820 --tmpfs /var/lib/postgresql/data:rw,size=3g \
  -e POSTGRES_PASSWORD=*** -e POSTGRES_USER=pcc03c_admin -e POSTGRES_DB=pcc03c_verify \
  -p 127.0.0.1:45440:5432 postgres:16-alpine
export COORDINATOR_PG_URL=postgres://pcc03c_admin:***@127.0.0.1:45440/pcc03c_verify \
       COORDINATOR_PG_EXPECTED_DATABASE=pcc03c_verify \
       COORDINATOR_PG_EXPECTED_USER=pcc03c_admin \
       COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=7675926592852803624
prisma migrate deploy                       # 128 migrations, max 0114

# 无库全集（从 src/apiserver）
npx tsc -p tsconfig.test.json --pretty false # 29 个既有 runner-api TS2554；本单元新增 0
env -u COORDINATOR_PG_URL -u DATABASE_URL node --test "build/**/*.spec.js"
#   → tests 1823 / pass 1690 / fail 1 / skipped 132
#     pass 与 04R2 基线（1811/1690/1/120）逐字相同；新增 12 例全部为需要库的 skip
#     唯一失败 reorderRunners… 是分支自带，与本单元无关

# 七个协调 PostgreSQL 文件
node --test build/projects/coordinator-{identity-migration,identity-service,companions,\
service-linearization,final-row,04r-adversarial,identity-provenance}.pg.spec.js
#   → tests 63 / pass 63 / fail 0（04R2 基线 51，本单元 +11 provenance +1 service）

# 反向对照：把 0113 的函数放回 0114 的 schema 上（旧 binary × 新 DB），同一批用例必须变红
COORDINATOR_PG_REVERSE_0114=1 node --test \
  build/projects/coordinator-identity-provenance.pg.spec.js build/projects/coordinator-final-row.pg.spec.js
#   → tests 27 / pass 17 / fail 10
#     变红的正是本单元负责的 10 格；0113 已经做对的（最终行读取、代次、非法落点、两个顺序）全部仍绿
#     仍绿的 2 个 provenance 用例（backfill 分类、0110..0113 前滚）自己在用例里应用 0114，按设计不受此开关影响

# 契约与 Base62/API
node --test build/projects/coordinator-contract.spec.js                    # 58/58
node --test build/common/public-id-coverage.spec.js build/common/public-id.spec.js \
            build/projects/project-coordinator{,-identity}.spec.js \
            build/projects/projects.service.spec.js \
            build/projects/project-{session-coordinator-binding,task-page}.spec.js   # 162/162
cd src/runner-go && go test -run '^(TestMCPProject|TestProject|TestTaskCLI.*Project|TestMCPTask.*Project|\
TestTaskListCapabilitiesAdvertiseTheProjectFlag|TestTaskCreateCapabilitiesAndHelpAdvertiseTheProjectFlag)' \
  -count=1 .                                                               # ok orbit
```

## 5. 真实快照前滚（只读 base backup → 隔离实例）

未连接、exec、迁移或测试共享 `orbit-postgres` / `orbit`。使用的是磁盘上已有的基础备份文件，
只读取，恢复到本任务自己的隔离实例 `pcc03c-pg-snapshot-34aasqy3-20260820`（PostgreSQL 16.14，
`127.0.0.1:45441`，system identifier `7651470862549594147`），WAL 归档以 `:ro` 挂载。

`base.tar.gz` SHA-256 `e25f287efa3724638c5124b47c150f98cfa46ca8921061112ce99303de32a465`（校验前后一致）。

* before：124 migrations / max `0110_task_run_at`；projects=3、tasks=56257、sessions=3616、
  workspaces=18、bound=3；`project_member` / `project_runtime` 尚不存在。
* after：128 migrations / max `0114`；业务表计数逐字不变；safe defaults 3/3（`coordinator_enabled=false`、
  `MANUAL`）；runtime 3 行、非零代次 0、基线 3；三个项目座位均 == 落点 → `DERIVED` 且派生基线已记录；
  三个座位全部是本账号 live agent。
* 手工重放 0114：`UPDATE 0`，来源与基线逐字不变。
* 在真实行上验两条规则（每条语句独立事务，否则延迟触发器尚未执行）：
  0110 relocation A→B **座位跟走、基线跟走、来源仍 DERIVED**；随后成员行被改成 C（回滚 binary 的写法）、
  再 relocation B→A **座位仍是 C、来源提升为 EXPLICIT、派生基线清空**。
* 收尾：`docker rm -f` 该实例，删除恢复目录；归档文件校验和不变，共享 `orbit-postgres` 仍
  `Up 11 hours (healthy)`，全程未重启。

## 6. 部署与回滚

* 0114 只做三件事：建枚举（`DO … EXCEPTION WHEN duplicate_object`）、加两列（`IF NOT EXISTS`，均有默认或可空）、
  `CREATE OR REPLACE` 一个函数。**不新建、不删除任何触发器**——0113 的三个触发器按名字调用同一个函数，
  替换函数即可，这也让"重放 0113 = 回滚到旧 binary 行为"成为一条可测的对照。
* 从只到 0110、0111、0112、0113 与空库前滚均已实测（`coordinator-identity-provenance.pg.spec.ts`
  「0114 rolls forward from a database that stopped at 0110, 0111, 0112 or 0113」「an empty database
  gets the same objects as one that was caught up」）。**已应用的 0111/0112/0113 一字未改。**
* 回滚保持 forward schema：两列留在库上，0113 时代的 binary 照常读写（列有默认值），
  它写不了来源列的显式选择由结构性判据接住。反向对照就是这个组合。
* 新增 `@db.Uuid` 列 `coordinatorIdentityLandingId` 归入 `NEVER_PUBLIC_ID_FIELDS`：它不是地址，
  是触发器逐字节比较的基线，任何一端翻译它都会让那次比较说谎。

## 7. 仍然成立的残留（不声称已解决）

1. **写不了来源列的写入方，其"显式选择恰好等于落点"仍不可区分**。0113 时代 binary 回滚期间做出的这类选择，
   在下一次 0110 relocation 时会跟着落点走。这是信息论上的界限，不是实现取舍：那个状态与派生态在库里
   逐字节相同。当前 binary 的同类请求已记为 `EXPLICIT`。
2. **回滚 binary 的 clear 无法与"从未有过身份"区分**：它删掉座位而写不了来源。若被删的是数据库派生并
   记录过基线的座位，结构性判据能认出来（已测）；若该项目本就没有派生基线，则认不出来。
3. 数据库**仍不阻止**旧 binary 更换落点（repair-03a §6.3 的原始残留）。0114 改变的是它**不再能借此改写 WHO**。
4. `ORB01` fail-closed 分支产品路径不可达，只有裸 SQL / 直接改库能触发；它是护栏，不是流程的一部分。
