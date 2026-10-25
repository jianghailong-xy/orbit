# 生产 PG 运行时参数：取值、依据与逃生门

这个集群此前跑在**几乎全默认**的参数上。本文件记录对五个参数的复核：当前值、建议值、**支撑那个数字的实测
数据**，以及哪些已经落地、哪些还在等账号所有者决定。

复核分两轮：2026-09-17 首轮（7 小时的 pg_stat_statements 窗口），2026-09-29 落地前复测（9.2 天窗口）。
**第二轮推翻了首轮的两处结论**（应用语句最长多久、应用语句溢不溢临时文件），下文一律以第二轮为准，
被推翻的读数保留在原处并标明，免得有人拿旧数字再推一遍。

| | |
|---|---|
| 参数落点 | `docker-compose.yml` → `services.postgres.command`（为什么是这里，见 §0.1） |
| 核对生效值 | `docker exec orbit-postgres psql -U orbit -d orbit -c "select name,setting,unit,source from pg_settings where name in ('statement_timeout','lock_timeout','idle_in_transaction_session_timeout','work_mem','shared_buffers')"` |
| 相关 | `docs/postgres-lock-order.md`（锁序）· `docs/postgres-conflict-runbook.md`（冲突）· `docs/postgres-backup-restore.md`（归档） |

## 0. 一览

| 参数 | 复核前 | 建议 | 线上 | 状态 |
|---|---|---|---|---|
| `statement_timeout` | `0`（无限） | `300s` | `300s` | 2026-09-29 账号所有者批准并落地 |
| `lock_timeout` | `0`（无限） | `30s` | `30s` | 同上 |
| `idle_in_transaction_session_timeout` | `0`（无限） | `300s` | `300s` | 同上 |
| `work_mem` | `4MB` | `4MB`（不改） | `4MB` | 结论是不改，见 §4 |
| `shared_buffers` | `128MB` | `1GB` | **`128MB`** | **未获批准，未落地**，等所有者单独决定，见 §5 |

三个 `0` 是这次复核的主因：**任何一条失控语句、或任何一个忘关事务的客户端，都能无限期持有锁。**
这已经发生过两次：

- **2026-09-14**：一条 `updateMany` 在持 owner 行锁的事务里跑了 5 分钟以上，同一 owner 的所有请求排在它后面，
  浏览器全 499，客户端超时重试又锁 5 分钟，自锁死。
- **2026-09-19 03:32**：`coordinator_enabled` 的扇出改写一个项目的全部 task，排序溢盘、**跑了 13 分钟**；
  它持锁期间另一个项目的 9 个 `UPDATE task` 被堵死 10 分钟以上，apiserver 事务拿不到连接，
  **5 分钟内 238 条 P2028**，页面打不开。最后靠人工 `pg_terminate_backend` 解开。

两次都没有任何服务端防线能终止它。

### 0.1 为什么写在 compose 的 `command` 里，而不是 `data/postgres/postgresql.conf`

三个 timeout 都是 `PGC_USERSET`，写进 `postgresql.conf` 再 `pg_reload_conf()` 就能**零停机**生效；
写进 compose 的 `command` 则要重建容器，数据库不可用约 20 秒。选了后者，四条理由：

1. **进版本库、过评审。** `data/` 在 `.gitignore` 里，改 `postgresql.conf` 既不留提交也没人能审；
   集群里其他运行时参数（归档、`wal_compression`、pg_stat_statements、`log_temp_files`）也全在 compose 里。
2. **不会被悄悄盖掉。** 命令行 `-c` 的优先级高于 `postgresql.conf`。参数一旦分散在两处，
   以后有人往 compose 里加一行同名 `-c`，`postgresql.conf` 里那行就静默失效，没有任何报错。
3. **不重建也躲不掉那次重启。** `.claude/skills/upgrade/upgrade.sh` 用的是
   `up -d --wait apiserver web gateway`，**不带 `--no-deps`**：compose 改动一旦进 main，下一次部署会把
   postgres 当依赖顺手重建——时间点不受控，执行者也不会去核对 `pg_settings`。不如自己挑窗口做一次，做完就验。
4. 本任务判据写的是「变更项在 Compose 配置或 `postgresql.auto.conf` 中可见」，`postgresql.conf` 两者都不是。

代价就是那 20 秒，且只付一次。

### 0.2 落地记录（2026-09-29）

main `0022dd5f9`（合入 `030ca7f98`）。重建前确认：compose 在 `/root/orbit` 下解析出的 PGDATA 挂载源是
`/root/orbit/data/postgres`、当晚的 `pg_basebackup` 已在 00:23:34 结束、没有跑了 10 秒以上的查询、
`--dry-run` 只重建 `orbit-postgres`。

| | |
|---|---|
| `docker compose up -d --no-deps --wait postgres` | 00:31:47.8 → 00:32:06.3 健康，**约 18.5 秒** |
| 容器 | `9276427a…`（09-24 起）→ `997b7775…`，挂载源不变 |
| 数据 | 重建前后 `user=6 session=4557 task=112005`、已完成迁移 330 条，一字不差 |
| apiserver | 162 行连接类报错，**全部落在 00:31:51–00:32:00**；健康之后零报错，`/api/health` 200 |
| 其余 | pg_stat_statements 跨重启保留（统计起点仍是 09-19 20:03）；WAL 归档照常推进、`failed_count=0`；`postgresql.auto.conf` 未动 |

**配置现在其实分在三处，记一笔：** compose 的 `command`（本文件管的）；`postgresql.conf` 里是 initdb 的
默认值（`shared_buffers = 128MB` 就在这里）；`postgresql.auto.conf` 里有一行 `log_lock_waits = 'on'`——
那是 2026-09-19 17:06 有人用 `ALTER SYSTEM` 写的，与项目规范相悖，但它有用（§2 的锁等待数据就靠它），
本次不动。**不要再往 `postgresql.auto.conf` 里加东西。**

## 1. `statement_timeout`：`0` → `300s`

**它防的是什么：** 单条语句跑飞——上面两次事故的队头。

**为什么是 300s 而不是更紧：** 上限由**迁移**定，不由业务查询定。

| 口径（9.2 天 / 6,286 万次调用，2026-09-19 20:03 → 09-29） | 实测 |
|---|---|
| 单次执行超过 300s 的语句 | **4 条**：3 条是 agent 即席分析（最长一条 **11,700s**，3.25 小时），1 条是应用的调度扫描 |
| 调度扫描（`tasks.service.ts` 的 `reconcileReadyTasks`） | 7,465 次调用，平均 **6.2s**，最长 **655s** |
| 历史最长的一条 Prisma 迁移 | **52.0s**（`0140_task_progress_vector_identity`；次长 21.9s） |

> 首轮（09-17，7 小时 / 88.6 万次调用）记的是「应用语句最长 14.3s、没有超过 60s 的」。**这个结论被第二轮推翻了**，
> 7 小时窗口里碰巧没出现调度扫描的长尾。

**300s 会截断调度扫描的长尾，这是可以接受的**：它是一个每分钟跑一次的**只读兜底扫描**（`$queryRaw`，
不开事务、不加行锁），外面包着 `.catch`，代码注释写明「这一轮失败，下一轮重新决定」。被截断只是这一轮
报一条错、下一分钟重来；而现在它的长尾是占着连接池（`pg.Pool` 默认 10 个）里的一个连接 11 分钟。
它平均 6.2 秒这件事本身是个性能问题，不归这个参数管。

300s 是**最长历史迁移的 5.8 倍**。迁移在 apiserver 启动时 apply，失败就是崩溃循环、自己被 502 锁死，
这是必须留足的余量——`run_event` 已过千万行，将来在它上面建索引超过一分钟是可预期的。

**不受它影响的两类后台进程（都已核实，不是凭印象）：**

- **autovacuum**：PG 16 源码 `src/backend/postmaster/autovacuum.c` 第 602–604 行（launcher）与
  第 1620–1622 行（worker）用 `SetConfigOption(..., "0", PGC_SUSET, PGC_S_OVERRIDE)` 把这三个 timeout 全部强制为 0。
- **pgbackup 的 `pg_basebackup`**：每晚一次，实测每次 **7–10 分钟**（09-24 到 09-28 五次：7m19s、8m25s、8m51s、
  9m58s，以及 09-29 那次），远超 300s，所以这一条必须确证。源码：`enable_statement_timeout()` 在
  `src/backend/tcop/postgres.c` 里只被 `start_xact_command()` 调用；walsender 收到 `BASE_BACKUP` 走的是
  `exec_replication_command()` → `SendBaseBackup()`，不经过它。实证见 §1.1。

**⚠️ 两个逃生门，落地后必须知道：**

1. **手工 `VACUUM` / `VACUUM FULL` / `REINDEX` 不豁免**，会在 300s 被杀。对大表维护前先 `SET statement_timeout = 0;`。
2. **需要更长的迁移自带逃生门**：`migration.sql` 顶部写 `SET statement_timeout = 0;`。会话级 `SET` 覆盖集群默认值，
   这条路早就在用——agent 的分析查询常以 `set statement_timeout='600s';` 开头。

### 1.1 `pg_basebackup` 不受 `statement_timeout` 约束：实证

2026-09-29 00:24Z，落地前在生产上跑（紧接在当晚的备份 00:23:34 结束之后，避免两份备份并发）。
做成 A/B：给 walsender 会话设 `PGOPTIONS="-c statement_timeout=3s"`，看普通 SQL 与 BASE_BACKUP 谁被砍。

| | 做了什么 | 结果 |
|---|---|---|
| A | 逻辑复制连接（`replication=database`）与物理复制连接（`replication=true`，pg_basebackup 用的那种）里 `SHOW statement_timeout` | 都是 **`3s`**——参数确实送到了 walsender |
| B（阳性对照） | 同一种 walsender 会话里 `SELECT pg_sleep(6)` | **3 秒**被 `ERROR: canceling statement due to statement timeout` 砍掉，服务端日志同时记下 |
| C | 同样 3s 的限制下跑 `pg_basebackup -D - -Ft -X none --checkpoint=fast --max-rate=64k`，输出丢进 `/dev/null`，容器内 `timeout 25` 兜底 | **到 25 秒仍在传输**，是被 `timeout` 杀掉的（busybox 的 `timeout` 发 TERM，退出码 143）；服务端没有任何针对它的取消记录 |

B 证明 3s 的计时器在这种会话里是装着的，C 证明 BASE_BACKUP 不经过它，与源码一致。探针事后无残留进程、
无进行中的备份；`--checkpoint=fast` 与夜间备份脚本用的是同一种 checkpoint，不是额外的扰动。

## 2. `lock_timeout`：`0` → `30s`

**它防的是什么：** 等锁等到天荒地老。这是两次事故里**真正救命的旋钮**——死掉的不是持锁的那条语句，是
**排在它后面的一片请求**。`statement_timeout` 管队头，`lock_timeout` 管队伍本身。

它还堵住一个 Prisma 特有的洞：交互事务的超时计时器触发后，要等**在途那条查询结束**才发得出 `ROLLBACK`
（`pg` 客户端串行执行，ROLLBACK 排在卡住的语句后面）。所以「交互事务最长 5s」不能当持锁上限——卡在锁上时，
持锁时长等于挡住它的那把锁的时长。`lock_timeout` 让那条语句自己返回，是唯一能从服务端打断这个链条的东西。

**为什么是 30s：**

| 口径 | 实测 |
|---|---|
| `log_lock_waits` 日志（2026-09-24 15:37 → 09-29，4.4 天）：等锁超过 `deadlock_timeout`（1s）的次数 | **196** |
| 其中超过 5s / 超过 30s | **22 / 0** |
| 最长一次 | **12.1s** |
| pg_stat_statements 里取锁语句的最长执行（9.2 天，早于日志覆盖） | `pg_advisory_xact_lock` **104s**、`session` inbox lease 读 **92s** |

4.4 天的正常运行里没有一次锁等待到 30s，所以落地后在正常流量下**几乎不会触发**；那两条 104s / 92s 发生在
09-19 到 09-24 之间，日志已不覆盖，无法确认当时是否在事故中。这台宿主常年 load 30–60，饥饿导致的
十几秒等待是常态，**不能按教科书的 1–5s 设**——那会把正常请求打成错误。

**触发时会怎样：** 语句报 `55P03`（`lock_not_available`）。`transaction-retry.ts` 明确**不**把它当可重试错误；
后台定时路径（queue、auto-retry）已经把 `55P03` 读作 BUSY，下一轮再看；请求路径则直接报错返回——
这正是要的行为：快速失败，而不是无限排队拖垮连接池。

## 3. `idle_in_transaction_session_timeout`：`0` → `300s`

**先更正一处流传的错误：** 项目最初把 pid 1909054（空闲 12 天 16 小时的 psql）当成这个参数的实证。不对。
它的 `state` 是 **`idle`** 而不是 `idle in transaction`，`xact_start` 为空——**没有打开的事务**，因此不持锁、
不压 xmin。能终止它的参数是 `idle_session_timeout`（见 §7），不是这一个。2026-09-19 的事故也没用到它：
那次的锁链头是 active 的扇出查询，不是闲置事务。

所以这个参数防的是**结构性风险**：将来某个会话 `BEGIN` 之后就走了（agent 开的 psql、崩掉的客户端、
被宿主饥饿卡住的 node 进程）。这种连接持有的行锁会一直压着，且压住 `xmin` 让 vacuum 回收不了死元组。

**为什么是 300s——这个数由 orbit 自己的长事务模式定：**

| 口径 | 值 |
|---|---|
| orbit 代码里**最长**的显式事务预算 | **120s**（`runner-api.controller.ts` 的 `EVENTS_INGEST_TRANSACTION_TIMEOUT_MS`，事件批量写入；`maxWait` 同为 120s，但那是取连接池槽位的等待，发生在 `BEGIN` 之前，不计入 idle-in-transaction） |
| 其余显式预算 | 60s（`task-lists` / `tasks` / pause 投影）、30s（`sessions`） |
| Prisma 交互事务默认值 | 5s |
| **实测** idle-in-transaction 间隙（250ms 采样，见 §8） | 最长 **0.14s**（事务整体存活最长 0.22s） |

**300s = 最长声明预算的 2.5 倍。** Prisma 的交互事务在语句之间**确实**会让后端停在 `idle in transaction`
（那段时间 node 在做查询编译和序列化），而这台宿主 load 30–60，**Prisma 自己的超时计时器也可能因为事件循环
饥饿而迟到**。2.5 倍的余量就是留给这个的。反过来说：一个事务在 300s 还停在 idle，已经把 Prisma 自己的
120s 上限超了 2.5 倍——那时客户端只可能是走了或者卡死了，杀掉它没有误伤。

**下限是硬的：不得低于 120s。** 低于它就会开始杀正常的事件批量写入事务，而那条路径上每个写都是幂等可重试的，
代价本来只有超时本身——用服务端 timeout 去掐它是纯损失。

## 4. `work_mem`：`4MB` → **保持 `4MB`**

任务最初的假设：`pg_stat_database` 累计 `temp_files=329,939`、平均 4.3MB/个，**正好卡在 4MB 的溢出线上**，
所以提高 work_mem 能消掉临时文件。两轮数据给出的答案不一样，结论却一样——不改全局值。

**首轮（t1 的 Top SQL 报告，6h37m 窗口 + 本任务 09-17 23:56 独立复查的 7h 窗口）：**

| 口径 | 实测 |
|---|---|
| 应用语句写出的临时块 | **0**（918,526 次调用） |
| 写出临时块的语句 | 2 条，合计 ≈ 5.7GB，**都是 agent 即席分析**；其中一条单次 5,711MB（3 个并行 worker） |

据此首轮的结论是「应用负载不溢，提高 work_mem 收益为零」。**这个结论被第二轮推翻了：**

**第二轮（9.2 天窗口）：**

| 口径 | 实测 |
|---|---|
| 写过临时块的语句 | **97 条**，22,644 次调用，合计 **52GB** |
| 其中最大的一族 | `WITH classified AS MATERIALIZED …`（`project-list-rollup.ts`，项目列表的汇总读）：9,207 次调用、**40GB，占 76.9%**，**每次稳定溢出 4.4–4.5MB**，平均 0.76–1.2s |
| 其余 | 调度扫描两个变体合计 ~7.4GB，其余多为每次不到 1.5MB |

那一族**正是任务最初假设的形态**：每次溢出的量刚好比 4MB 多一点。但它已经在**查询层**被修掉了——
`9cad03c7d perf(projects): the project index counts each task into its project instead of spilling them
all to disk`（2026-09-28 23:58Z 落 main）把那个 CTE 改成逐项目计数，不再攒一个超出 work_mem 的 tuplestore。
复测时线上 apiserver 是 22:11Z 启动的，**尚未部署这个修复**，所以上表的数字里它还在。

**所以全局 work_mem 保持 4MB，三条理由：**

1. **最大的溢出源正在源头消失。** 查询层的修复零内存代价，只作用于那一条读；全局提高 work_mem 是用所有
   连接的内存去换一条查询的收益。
2. **work_mem 是内存放大倍数最高的参数**：按连接、按每个 sort/hash 节点各算一份（hash 节点还要乘
   `hash_mem_multiplier` 2.0），agent 的即席查询还会开并行 worker 各算一份。
3. **宿主没有这个余量**：swap 8191/8191 **全满**，`Committed_AS` 35GB 对 `CommitLimit` 19.7GB（**178% 超售**），
   根分区 94%，且这台多租户宿主有 global OOM 杀掉 orbit-runner 的前科。

**什么时候该重看：** `9cad03c7d` 部署之后重新量一次。查法（先确认溢出的是不是 agent 自己跑的，再谈调参）：
`select calls, temp_blks_written*8192/calls as bytes_per_call, left(query,80) from pg_stat_statements where temp_blks_written > 0 order by temp_blks_written desc;`
若剩下的应用溢出仍集中在某一条，优先在那条查询里 `SET LOCAL work_mem` 或改写，而不是动全局。

## 5. `shared_buffers`：建议 `128MB` → `1GB`，**未获批准，线上仍是 128MB**

2026-09-29 账号所有者批准的范围只有三个 timeout。`shared_buffers` 是 postmaster 级参数、+896MB 常驻内存、
必须重建容器，而宿主 swap 全满、根分区只剩 11–12G，**它等所有者单独决定**，本次没有落地。
compose 里也没有写它——线上的 128MB 来自 `postgresql.conf` 的 initdb 默认值。

建议仍然成立，依据如下，供决定时参考：

| 口径 | 实测 |
|---|---|
| 全历史缓冲命中率（`pg_stat_database`，`stats_reset` 为空 = 全历史真值，09-17 读） | **84.85%**（`blks_read` 61.2 亿 ≈ 46.7TB 读自 shared_buffers 之外） |
| 当时全库最贵语句（占 22.1% 执行时间）单次的缓冲行为 | `Buffers: shared hit=10574 read=12910`，单次命中率 45% |
| 最大的几张表 | `run_event` 5360MB、`tool_call` 1027MB、`task` 966MB、`attachment` 591MB（09-17） |

OLTP 的合理目标是 99%+。**为什么建议 1GB 而不是教科书的「内存 25%」（≈6GB）**：约束在宿主，不在库。
`shared_buffers` 是启动时一次性占住、**不会退让**的共享内存；在一台已经超售 178%、有 OOM 前科的多租户
机器上多占几个 GB 去换命中率，是拿「全站被 OOM 掀掉」换「查询快一点」。1GB（+896MB，约占可用内存 10%）
是 8 倍于现值、足以让热行与索引页常驻的一步。宿主内存压力解决后（部署运维问题，不在本项目范围内），
2–4GB 是合理的下一档。

**顺带记录、本次未改的两项：** `effective_cache_size` 仍是默认 4GB（只是规划器提示、不占内存，但改它会改
执行计划）；容器 `/dev/shm` 只有 docker 默认的 64MB（并行查询的 `dynamic_shared_memory_type=posix` 用它，
目前的并行 worker 都溢到磁盘而非卡在 shm 上）。

## 6. 那条空闲 12 天的连接是怎么来的：`docker exec` 的进程不随客户端一起死

pid 1909054（`backend_start` 2026-09-03 00:26:52，最后一条语句停在 00:31:36，空闲 12 天 16 小时）
的来源已查清，机制值得记下来，因为它会**反复发生**：

1. `client_addr` 为空、`client_port = -1` → 走的是 **unix socket**，即在容器内执行的
   `docker exec orbit-postgres psql`，不是通过网络连进来的应用。`application_name=psql` 也排除了 apiserver。
2. 2026-09-03 00:20–00:35 这个窗口里，**全库只有一个会话**跑过 `docker exec … psql`：
   `01a056b4-859e-7022-a412-be8e3fb82521`（「Outcome Reconciler：Agent 持续闭环未完成义务」），共 7 次调用。
3. 那条连接停住的语句 `SELECT * FROM project_acceptance_criterion_definition;` 正是该会话当时在查的对象
   （它前后几次调用分别在查这张表的触发器、外键和 format 分布）。
4. 它的 `backend_start`（00:26:52）落在该会话**已记录的 tool_call 的唯一空档**里
   （00:24:20 → 00:29:55，5 分 35 秒），而且**没有对应的 tool_call 行**——说明那次调用没有正常返回，
   因此没被记下来。
5. **关键机制（已在本机实证）**：`docker exec` 在容器内起的进程**不随宿主侧客户端一起死**。
   把 `docker exec orbit-postgres sh -c 'sleep 300'` 的客户端 `kill -9` 之后，容器内那个 `sleep`
   **仍在运行**。所以 Bash 调用被打断时，psql 进程留在容器里，连接一直开着，
   停在 `ClientRead` 等一个再也不会有输入的终端。

**这条连接已清理**：2026-09-17 17:07 因 t1 重建 postgres 容器而随旧容器一并销毁，不是被单独 kill 的。

**怎么防**：一次性查询一律用 `-c` 或 `<<'SQL'` 让 psql 自己退出，不要开交互式会话；在容器里跑可能久的命令，
把 `timeout` 放在 `docker exec` **里面**（`docker exec … timeout 60 psql …`），外面的 `timeout` 杀不到容器里的进程。
要兜住残留，见 §7 的 `idle_session_timeout`。

## 7. `idle_session_timeout`：仍为 `0`，本次**不改**，但要知道它的存在

§3 与 §6 已说明：pid 1909054 那条空闲 12 天的连接，能终止它的是**这个**参数而不是
`idle_in_transaction_session_timeout`。本次不设，理由有二：

1. **危害小。** 一条 `idle` 连接不持锁、不压 xmin，真实代价只有 100 个连接槽里的 1 个；实际用量十几个，远不是瓶颈。
2. **误伤面是我们自己。** 它会连带砍掉 agent 会话为排查问题开着的长命 psql。这是一个独立的取舍，
   该单独决定，不该搭本次的车。

## 8. `idle_in_transaction_session_timeout` 生效的实证

2026-09-29 00:33Z，落地（00:32:06 容器健康）后在生产上跑。**没有用会话级 `SET` 缩短等待**——那只能证明机制，
证明不了 compose 里那个值在生效——而是用集群默认值实打实等满 300 秒。

探针会话（`application_name=itx-timeout-probe`）：

```
 pid | idle_in_tx_timeout |    source    |    t_utc
-----+--------------------+--------------+--------------
 403 | 5min               | command line | 00:33:48.525      ← 生效的就是 compose 命令行上的值

BEGIN
   xid    | took_lock | idle_from_utc
----------+-----------+---------------
 67796024 |           | 00:33:48.533                          ← 拿了 xid，拿了一把 advisory 锁

client 00:33:48: going idle inside the open transaction; no statement is running
client 00:39:18: woke up, sending the next statement
FATAL:  terminating connection due to idle-in-transaction timeout
server closed the connection unexpectedly
connection to server was lost
psql exit=2
```

服务端日志：

```
2026-09-29 00:38:48.533 UTC [403] FATAL:  terminating connection due to idle-in-transaction timeout
```

| | |
|---|---|
| 进入闲置 | 00:33:48.533 |
| 被服务端终止 | 00:38:48.533——**恰好 300.000 秒** |
| 另一个会话 00:34:03 看到的 pid 403 | `idle in transaction`、`backend_xid=67796024`、持有 1 把 advisory 锁 |
| 终止之后 | 后端消失；那把锁无人持有；`txid_status(67796024) = aborted`——事务被回滚，不再压住 xmin |

探针那把锁用的是单个 bigint 键（`pg_advisory_xact_lock(hashtext('itx-timeout-probe')::bigint)`），与应用用的
双 int 键不在同一个键空间，不会挡到任何真实请求；探针也没碰任何业务行。

**方法上的两个坑，重跑时别再踩：**

1. 让后端进入 `idle in transaction` 的必须是**客户端停顿**（psql 里 `\! sleep n`），不能是服务端
   `SELECT pg_sleep(n)`——`pg_sleep` 执行期间后端是 `active`，这个计时器根本不走。首轮写在这里的配方就犯了这个错。
2. 想用一个 PL/pgSQL 循环盯着 `pg_stat_activity` 等某个 pid 消失，**每轮要先 `PERFORM pg_stat_clear_snapshot()`**：
   `pg_stat_activity` 在一个事务里只取一次快照，而整个 DO 块就是一个事务。这次的观察会话就因此一直看着
   00:34:03 那张旧快照，直到被自己的 `statement_timeout` 砍掉——它先 `SET statement_timeout = '420s'`，
   也确实是在 **420.0 秒**（00:34:03 → 00:41:03）而不是默认的 300 秒被砍，顺带证实了 §1 那个会话级逃生门有效。
   终止本身不依赖它：服务端日志与探针自己的输出各自独立地记下了。

首轮顺带量过一次**真实**的 idle-in-transaction 间隙：250ms 采样 `pg_stat_activity`，窗口 2026-09-17
23:54:32Z → 00:01:42Z（7.2 分钟），抓到 **28 个不同后端的 90 次** idle-in-transaction：最长的一次 idle 间隙
**0.14s**，最长的事务整体存活 **0.22s**，与 300s 差三个数量级。采样的已知局限：抓不到短于 250ms 的间隙，
窗口只有 7.2 分钟、抓不到低频的批量路径——但两者都不影响结论方向，本参数只关心**长**间隙。

## 9. `/dev/shm` 64MB 让手动 VACUUM 报 ENOSPC；`run_event` 的统计 17 天没刷新

**2026-10-09 事故**：生产库一次手动 VACUUM 失败：

```
ERROR:  could not resize shared memory segment "/PostgreSQL.3509582570" to 67145440 bytes: No space left on device
```

**原因链条**（每一步都在本机容器里实测复现过）：

1. Docker 容器默认 `/dev/shm` = 64MB；
2. PG16 对 ≥ `min_parallel_table_scan_size`（8MB）的表，**连不写 `PARALLEL` 的普通 VACUUM 也会自动并行**
   （`max_parallel_maintenance_workers=2`）——所以这不是「显式并行才踩」，是「手动 VACUUM 就踩」；
3. 并行 VACUUM 的动态共享内存段 ≈ `maintenance_work_mem`（默认 64MB）→ 请求 67,145,440 字节 > 64MB → ENOSPC。

**逃生门**（已实测）：`VACUUM (PARALLEL 0, ANALYZE)` 串行执行不受影响——死元组数组只在并行时才走动态共享内存。

**处置**：

| 项 | 处置 | 状态 |
|---|---|---|
| postgres 服务加 `shm_size: "256m"` | 官方 postgres 镜像文档的推荐值；重建容器生效，数据与 WAL 归档不动 | 账号所有者已批准，待部署 |
| `ALTER TABLE "run_event" SET (autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 1000)` | migration 0417，随 apiserver 启动应用 | 同上 |

**另一半：`run_event` 17 天没有 autoanalyze**。这张表几乎只追加：死元组只有 6,857（约 570 万行的 0.1%），
autovacuum 的清理触发线（50 + 0.2×行数 ≈ 113 万）永远够不到——这是预期行为，不是故障。真正缺的是统计：
autoanalyze 的触发线是 50 + 0.1×行数 ≈ 56.5 万次变更，所以 2026-09-22 → 2026-10-09 一次都没跑，
规划器拿 17 天前的 n_distinct/MCV 做高水位（`max(seq)`）读与事件扇出的计划。0.01 把触发线降到约 5.7 万行，
统计重新跟上实际分布；vacuum 侧维持默认——死元组不积累的表不需要更激进的清理。
