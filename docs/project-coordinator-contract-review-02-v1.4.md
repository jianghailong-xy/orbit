# Project Coordinator 契约 v1.4 独立复审（任务 02，第五轮）

## 1. 结论

**FAIL / BLOCKED：不接受 v1.4 作为无 P0/P1 歧义的冻结契约。**

本轮从 `feat/project` 的 `8164f10c65c8f19b77ffdddf0966461d93f98b1d` 独立开始，先重读 Project 的 goal、12 条 acceptance criteria、instructions、任务 02 历史评论及关联研发任务 01D 的提交证据。上一轮 PostgreSQL 输出因曾误连共享控制面，**全部作废且未被本轮引用**。本轮只在一次性容器、一次性网络和专用数据库中重新执行。

v1.4 对上一轮 `PC-CX-21..27` 的修订通过既有静态、模型与真实 PostgreSQL 反例；但反例外扩发现 **2 个 P0 + 2 个 P1** 新阻断项：

| ID | 严重度 | 结论 |
|---|---:|---|
| `PC-CX-28` | **P0** | AU1 只把 cap 写与派发串行化，却允许“控制环先派发、用户随后调低 cap”两次都提交，最终 `inFlight > maxConcurrentTasks`；与 I16/CAP1/CAP3 的硬不变量正面冲突 |
| `PC-CX-29` | **P0** | 提交点只重放 §9.2 和 §7.4 第 6/7 条；Agent/团队/Provider/Workspace/Runner/Task 执行上下文在快照后被人工撤销时不共享门，已禁用 Agent 仍能产生新 Session，违反 I7 |
| `PC-CX-30` | **P1** | §6.1 冻结的 `world` 没有 `project_action` / Coordinator turn 历史，但 §4.2 guard 4 与 §7.6 TR2/TR3 必须读取它们；同一份声明输入因此可要求两个 `run_state`/动作，S8 的“完整读集”测试是假阴性 |
| `PC-CX-31` | **P1** | TR2 拒绝 60 秒内第二次语义 turn 后，没有持久化 pending 状态，也不在 §10.4 的封闭 `nextWakeAt` 列表安排限频边界；第二次 `user.manual_trigger` 可被消费后永久丢失，或不消费而无确定重试时刻 |

因此任务 02 的 acceptance criterion“无未解决 P0/P1，或以结构化 blocker 阻止后续”只满足后一支；应由 Coordinator 原生退回 01D 或创建后续契约缺陷任务，03 继续保持被阻断。

## 2. 被验基线与独立性

```text
$ git rev-parse feat/project
8164f10c65c8f19b77ffdddf0966461d93f98b1d

$ git log --oneline -2 feat/project
8164f10c docs(project): close the seven coordinator contract blockers PC-CX-21..27
caf1939a test(project): record coordinator contract v1.3 re-review
```

01D 的研发提交为 `8164f10c65c8f19b77ffdddf0966461d93f98b1d`。本轮没有修改 `docs/project-coordinator-contract.md`，也没有把失败改写成通过；只新增/修改验证代码、安全闩和本报告。

## 3. 强制 PostgreSQL 隔离证据

### 3.1 创建前核验

唯一名称：

- network：`pcc02-v14-net-349bqgko-20260819a`
- container：`pcc02-v14-pg-349bqgko-20260819a`
- database：`pcc02_v14_349bqgko_20260819a`
- role：`pcc02_v14_349bqgko`

```text
$ docker inspect pcc02-v14-pg-349bqgko-20260819a
error: no such object: pcc02-v14-pg-349bqgko-20260819a

$ docker network inspect pcc02-v14-net-349bqgko-20260819a
Error response from daemon: network ... not found

$ docker network create pcc02-v14-net-349bqgko-20260819a
11a5d3412adc1c07001e8988a55235f53fc7c81c14773eba3f019e959bae4f7b

$ docker run -d --name pcc02-v14-pg-349bqgko-20260819a \
    --network pcc02-v14-net-349bqgko-20260819a \
    -e POSTGRES_USER=pcc02_v14_349bqgko \
    -e POSTGRES_PASSWORD=<ephemeral-password> \
    -e POSTGRES_DB=pcc02_v14_349bqgko_20260819a \
    -p 127.0.0.1::5432 postgres:16-alpine
64f4d3e52fafe081ff74a3acb024d2514decdc6a3b3b133d46ec2da54cbedd33
```

### 3.2 执行任何测试前的身份核验

```text
$ docker inspect --format '<id>|<name>|<image>|<network>=<ip>' pcc02-v14-pg-349bqgko-20260819a
64f4d3e52fafe081ff74a3acb024d2514decdc6a3b3b133d46ec2da54cbedd33
|/pcc02-v14-pg-349bqgko-20260819a|postgres:16-alpine
|pcc02-v14-net-349bqgko-20260819a=172.23.0.2

$ docker port pcc02-v14-pg-349bqgko-20260819a 5432/tcp
127.0.0.1:32769

$ docker exec pcc02-v14-pg-349bqgko-20260819a psql -h 127.0.0.1 \
    -U pcc02_v14_349bqgko -d pcc02_v14_349bqgko_20260819a \
    -c 'SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), system_identifier ...'
pcc02_v14_349bqgko_20260819a|pcc02_v14_349bqgko|127.0.0.1/32|5432|7675696401559072802
```

测试进程又在**每个连接完成后、任何 fixture 写入前**读同一组身份并匹配显式环境变量，关键输出：

```text
# coordinator-pg-isolation database=pcc02_v14_349bqgko_20260819a
# user=pcc02_v14_349bqgko server=172.23.0.2/32:5432
# system_identifier=7675696401559072802 version=16.14
```

本轮从未连接、`docker exec` 或传入共享 `orbit-postgres`、`orbit` 数据库、其 IP 或凭据；没有读取共享容器元数据。新增 `coordinator-pg-test-safety.ts` 使破坏性 spec 必须显式提供并匹配专用 database/user/system identifier，且拒绝共享 Orbit 命名。新反例只使用 `pcc_v14_review` schema。

### 3.3 清理

测试后先以只读查询再次得到相同 identity，再只清理本轮对象：

```text
$ docker rm -f pcc02-v14-pg-349bqgko-20260819a
pcc02-v14-pg-349bqgko-20260819a

$ docker network rm pcc02-v14-net-349bqgko-20260819a
pcc02-v14-net-349bqgko-20260819a

$ docker inspect pcc02-v14-pg-349bqgko-20260819a
error: no such object: pcc02-v14-pg-349bqgko-20260819a

$ docker network inspect pcc02-v14-net-349bqgko-20260819a
Error response from daemon: network ... not found
```

## 4. 可自动化反例矩阵

| 场景 | 唯一权威状态 | 确定性动作 / 幂等身份 | 责任人与恢复 | 本轮判定 |
|---|---|---|---|---|
| 重复事件 | 世界事实不变；仅 `occurrences/last_seen_at` 可变 | 同动作键；副作用一次 | 无责任人；无需恢复 | PASS：I14/F01、既有模型 |
| 乱序事件 | 重新读当前世界，最终状态与顺序无关 | E1；当前事实生成同键 | 无需恢复 | PASS：F02 |
| 业务事务回滚 | 无业务行、无 outbox 行 | 不产生动作键 | 原事务调用者重试 | PASS：N4/F04 |
| 两个 worker / 接管 | 只有新 fencing token 可提交 | 同输入同键；旧 token 整事务回滚 | SYSTEM；租约过期后接管 | PASS：PG PC-CX-09/19/20/21 |
| Coordinator Session 结束 | Agent 身份不变，generation +1 | `coord-session:<generation+1>` | SYSTEM 自动轮换；Workspace 不可用则 USER | PASS：§7.5/F08/F09 |
| Runner 离线 | Session 90s 后失败，结构化失败/退避 | 当前失败代次生成后续键 | SYSTEM/EVENT；恢复事件或 reaper | PASS：F10 |
| Provider 不可用 | `PROVIDER_UNAVAILABLE` blocker | 显式 fallback 才允许策略动作，绝不静默换 | SYSTEM/EVENT；provider 恢复 | PASS：F12 |
| 无匹配 Runner | `NO_MATCHING_RUNNER` 或 `RUNTIME_REQUIREMENT_UNMET` | NOOP/RAISE_BLOCKER 唯一映射 | SYSTEM/EVENT 或 USER/HUMAN | PASS：F11 |
| 合并冲突 | `MERGE_CONFLICT` blocker | lifecycle generation + conditionVersion；开一次 turn | COORDINATOR/EVENT；无进展转 USER | PASS：TF4/TR3/F13/F33 |
| 测试失败 | 退避期 PLANNING/EXECUTING；超阈值 AWAITING_HUMAN | `dispatchAttempt` 单调；阈值 blocker | SYSTEM/TIME 后 USER/HUMAN | PASS：Q3/F14 |
| 验证失败 | FAIL 原生退回、缺陷子任务、下游阻断 | `verdictRevision` | COORDINATOR/EVENT；修复后重验 | PASS：V7/F15 |
| 预算耗尽 | 24h 预算为 BLOCKED；并发占满为 NOOP | blocker lifecycle 或无动作键 wake | SYSTEM/TIME；窗口/Session 结束 | PASS（静态）；cap 变更竞态见 `PC-CX-28` FAIL |
| 等待用户 | AWAITING_HUMAN，五字段齐全 | approval target key / blocker generation | USER/HUMAN；升级后可停钟 | PASS：N-null/BL5 |
| 混合版本部署 | 投影始终由 DB 派生；旧 sweep 被拒 | D5/D6/D8/D9/D10/D11 | SYSTEM；失败可见且有界重试 | PASS：PG PC-CX-25、F20/F24/F30 |
| 人工与控制环同时启动不同 Task | Project 行锁后计数 | loser 类型化拒绝 | SYSTEM；下一事件恢复 | PASS：现有 PG PC-CX-26 |
| 人工在派发后调低 cap | 可提交 `inFlight=2,max=1`，无唯一合法不变量 | 没有修复动作/键 | 未定义 | **FAIL `PC-CX-28`** |
| 人工禁用 Agent 与旧快照派发 | 可提交 `agent.enabled=false + 新 Session` | D5/D9 与 AU1 都不检查 PAC 上下文 | 未定义 | **FAIL `PC-CX-29`** |
| 同一声明输入、不同动作历史 | runState 可为 PLANNING 或 ACCEPTANCE；TR3 也分叉 | action history 不在 hash | 未定义 | **FAIL `PC-CX-30`** |
| 60s 内第二次 manual trigger | 可被限频但没有 pending/wake | 新 dedupeKey 无确定后果 | 未定义 | **FAIL `PC-CX-31`** |

## 5. 项目级 12 条验收映射

| AC | v1.4 复审 | 证据 / 阻断 |
|---:|---|---|
| 1 | PASS | 稳定 Agent / 可轮换 Session / Base62 的规范与静态断言仍一致 |
| 2 | PASS | outbox、重复/乱序/回滚、幂等与接管模型通过 |
| 3 | **FAIL** | `PC-CX-31` 没有 rate-limit 边界的持久化恢复，显式 manual 请求可静默消失 |
| 4 | **FAIL** | `PC-CX-28` 破坏硬 cap；`PC-CX-29` 撤权集合不完整 |
| 5 | **FAIL** | `PC-CX-30`：声明输入漏掉动作/turn 历史，不能重放唯一机械决策 |
| 6 | PASS | FAIL/INCONCLUSIVE 原生后果与 verdictRevision 模型通过 |
| 7 | PASS | 聚合 current-state CAS、回退与无业务新实体规则一致 |
| 8 | PASS | 六类 blocker、去重/复发/升级、无 silent fallback 规则通过 |
| 9 | **FAIL** | token/Session/旧版本恢复通过，但 `PC-CX-29` 允许人工撤权后的 stale execution context 提交 |
| 10 | PASS（契约层） | 状态/决策/blocker/nextWake/验收展示字段有映射；实现归后续任务 |
| 11 | PASS | 存量 MANUAL/disabled、D8 投影、混合版本 PG 反例通过 |
| 12 | PASS（契约层） | acceptanceDigest、DONE 硬门、merge evidence 协议一致；实现归后续任务 |

## 6. 结构化失败证据

### `PC-CX-28` — P0 — cap writer 没有维护硬 cap

- **最小交错**：初始 `max=2,inFlight=1`；控制环取 project lock，计数 1 后插入第二条 Session 并提交；用户随后取得同一锁，把 `max` 改成 1 并“照常生效”。
- **已提交反例**：`inFlight=2,max=1`。
- **冲突条款**：AU1-a 允许第二步生效；I16/CAP1/CAP3 又要求任何顺序 `inFlight <= max`。
- **既有测试漏检**：`coordinator-counterexample.spec.ts` 对 `COORDINATOR_FIRST` 明确加了豁免 `|| order === 'COORDINATOR_FIRST'`，却仍宣称遍历八格；PG 测试只测“两个入口争一个槽”，未测 cap 自身被调低。
- **责任人/恢复**：契约研发；要么 cap 写入者在同一 project 锁后拒绝 `newMax < inFlight`，要么把 cap 定义改为 admission limit 并删除当前状态不变量。两种语义必须二选一，并增加两提交顺序 PG 测试。

### `PC-CX-29` — P0 — PAC execution context 撤权不在提交门内

- **最小交错**：快照中 assignee Agent enabled；用户提交 `enabled=false`；控制环随后取 AU1 project 锁，四个策略字段仍允许，按旧解析插 Session。
- **已提交反例**：`agent.enabled=false` 且 `Session(resolvedAgentId=该 Agent,status=PENDING)` 新增成功。
- **原因**：AU1 明确只重跑 §9.2 和 §7.4 第 6/7 条，不重跑第 8 条；Agent/team/task/provider/workspace/runner 行与 project 策略行没有共同锁或 revision。D5/D6/D9 只证明 task/project/action/token，不证明 PAC 执行上下文仍获授权。
- **责任人/恢复**：契约研发 + PAC 集成；冻结 commit-time `resolveExecutionContext` 的读集、版本/锁序和拒绝码。至少覆盖 Agent disabled/removed、Task assignee/provider/model 改写、Workspace/Runner 可用性变化、Provider 撤回、Coordinator Workspace 重绑。

### `PC-CX-30` — P1 — 决策输入不是实际读集

- **最小反例**：两份数据库状态的 §6.1 `world/evaluation/signals` 完全相同；其中一份多一条未收敛 `RUN_PROJECT_ACCEPTANCE` action。§4.2 要求前者 PLANNING、后者 ACCEPTANCE。
- **第二反例**：相同声明输入下，隐藏的既有 turn 是在飞还是已结束，TR3 分别要求 `ALREADY_APPLIED` 与 `COORDINATOR_NO_PROGRESS`。
- **原因**：`world` 没有 action/turn 投影；现有 S8 测试只从动作键、GE1 和 acceptanceDigest 的手选列名采集，根本没有采集 §4.2/§7.6 的读集。
- **责任人/恢复**：契约研发；把最小 action/turn 投影纳入输入/hash，或定义一个同等可回放的事务输入，并让 S8 从全部规范读集双向生成。

### `PC-CX-31` — P1 — TR2 限频没有持久恢复

- **最小交错**：MANUAL turn 后 10 秒，用户发第二个不同 dedupeKey 的 manual trigger；TU4 仍选 MANUAL，TR2 拒绝新 turn。
- **歧义**：消费事件会永久丢请求；不消费会让它立即重复命中，但 §10.4 没有 `lastTurn+60s` wake/nextAttempt 规则。两种都能从现行文字实现。
- **责任人/恢复**：契约研发；冻结 rate-limited outcome（pending signal 或不消费事件）、单调 window identity、`nextWakeAt`/`nextAttemptAt`、幂等键与用户可见状态，并加入重复 manual trigger 的模型/时钟测试。

## 7. 命令与关键输出

聚焦编译（当前隔离 worktree 无本地 `node_modules`，显式只读共享依赖目录；没有安装或修改依赖）：

```text
$ /root/orbit/node_modules/.bin/tsc --strict --target ES2022 \
    --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck \
    --types node --typeRoots /root/orbit/node_modules/@types \
    --baseUrl /root/orbit/node_modules --rootDir src/apiserver/src \
    --outDir src/apiserver/build <5 coordinator specs>
# exit 0
```

无数据库全矩阵：

```text
$ env -u COORDINATOR_PG_URL ... node --test <5 compiled specs>
# tests 103; pass 90; fail 0; skipped 13; duration_ms 441.687668
```

隔离 PostgreSQL（每个命令都同时提供并匹配 expected database/user/system identifier）：

```text
$ node --test coordinator-linearization.pg.spec.js
# isolation identity printed; tests 10; pass 10; fail 0; skipped 0

$ node --test coordinator-v13-adversarial.spec.js
# isolation identity printed; tests 9; pass 9; fail 0; skipped 0

$ node --test coordinator-v14-adversarial.spec.js
# isolation identity printed; tests 6; pass 6; fail 0; skipped 0
# PC-CX-28 PG counterexample reproduced
# PC-CX-29 PG counterexample reproduced
```

说明：最初直接运行 project-wide `tsc -p src/apiserver/tsconfig.test.json` 因隔离 worktree 没有 `node_modules` 报 `TS2688`，增加 `typeRoots` 后仍因全仓包解析失败；这是环境探测，不是被验契约失败。随后使用与前四轮相同边界的五份聚焦 spec 编译，exit 0。

## 8. 运行环境、提交与合并

```text
Linux 6.12.38+deb13-cloud-amd64 x86_64 GNU/Linux
Node v22.22.2; npm 10.9.7; TypeScript 5.9.3
git 2.47.3; Docker 29.5.2
PostgreSQL 16.14 (postgres:16-alpine disposable container; removed)
review worktree: /root/.orbit/worktrees/01a01971-bb7b-7593-91ed-3d6648a3dc9d
review branch: orbit/02-coordinator-32ba2b
```

- 被验提交：`8164f10c65c8f19b77ffdddf0966461d93f98b1d`
- 验证提交：见任务最终评论（提交本报告与验证 spec 后回填）
- 合并状态：见任务最终评论；要求提交可从 `feat/project` 到达
- 目标工作树既有 staged 改动：`M README.md`、`D docs/project-agent-contract.md`，合并前后必须保持不变

## 9. 后续自动化清单

1. `PC-CX-28`：真实 PG 两提交顺序，初始 `max=2,inFlight=1`，cap 调到 1；断言最终语义唯一。
2. `PC-CX-29`：Agent disable/remove、Task assignee/provider/model、Workspace/Runner/Provider、Coordinator Workspace rebind 各跑两个提交顺序。
3. `PC-CX-30`：从 `runStateOf`、TR1–TR3、策略、blocker、验收全部读集生成输入字段，禁止手选子集。
4. `PC-CX-31`：两个不同 manual dedupeKey 在 60 秒窗内，断言请求不丢、不会 busy loop、边界只执行一次。
5. 保留本轮 PostgreSQL 身份安全闩：缺少 expected database/user/system identifier 时，在任何 fixture DDL/DML 前失败。
