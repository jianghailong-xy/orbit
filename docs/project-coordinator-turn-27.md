# 单元 27：`OPEN_COORDINATOR_TURN` 的原子投递与可靠唤醒

> 本文是**执行记录**，不是规范。规范以 [`project-coordinator-contract.md`](./project-coordinator-contract.md)
> 的 §7.2 / §7.3 / §7.6 / §8.3 / §10.4 为准；本轮**没有修改任何一条已冻结条款**，只把它们实现出来。
>
> 上一单元是 26（[`project-failure-wakeup-26.md`](./project-failure-wakeup-26.md)，契约 v1.17 / `PC-CX-63`），
> 它冻结了「**要不要**开一条 turn」；本单元回答「**怎么把它交出去**」。

## 0. 单元 26 停在哪里

26 让 `planCoordinatorTurn` 对一份快照给出五种 verdict（`OPEN` / `RATE_LIMITED` / `NO_PROGRESS` /
`IN_FLIGHT` / `NO_LIVE_RUN`），并在 `OPEN` 时让 `plannedActions` 追加至多一条 `OPEN_COORDINATOR_TURN`。
它**刻意**没有投递，并在 §33.2 把投递列成下一个单元的事。

那个接缝是安静的，而且安静得有道理：账本的 `planned` 闸门是**单向**的 —— 一个动作要被 claim，必须先出现在
决策里；但**计划里没人 claim 的动作不报错**。于是一条 `project_decision` 可以逐字写着"叫醒协调器"，而协调器
从头到尾没被叫醒，没有任何一条断言会红。**这正是 26 自己诊断出的那个缺陷的形状**，只是往下挪了一层。

## 1. 这一轮做了什么

一句话：**决策、动作、conversation turn、Coordinator Session 的可运行状态、以及导致它的那些事件的消费，
在同一个事务里一起提交，或者一起不提交。**

### 1.1 新增执行器 `ProjectCoordinatorTurnService`（AC1）

`src/apiserver/src/projects/project-coordinator-turn.service.ts`，注册方式与 §7.5 的轮换执行器逐字相同
（`registerTurnExecutor`，一个，替换另一个活的会被拒）。reconcile pass 在**自己的事务里**调
`openInTransaction`，一次提交写下四样东西：

| # | 写什么 | 为什么必须在同一个事务里 |
|---|---|---|
| 1 | `project_action` 行，键 `pc:v1:<projectId>:turn:<generation>:<reasonDigest>`，**并写 `reason_code`** | `reason_code` 不是装饰：§7.6 TR2-a 的限频窗口锚点就是「该 `reasonCode` 上最近一条 APPLIED 的 turn 行」，`turnWindowsOf` 按它分桶。不写 ⇒ 窗口永远无锚点 ⇒ **TR2 静默地永不限频** |
| 2 | `conversation_turn`，`kind = 'message'` | 见 §1.2 |
| 3 | Session 状态：`AWAITING_INPUT`/`INTERRUPTED` → `PENDING`，`PENDING`/`RUNNING` 不动（复用 `statusAfterTurnEnqueued`，与其他所有 turn 生产者同一条规则） | 一条排进 `AWAITING_INPUT` 会话的消息**没有任何 runner 会为它去要一个 slot**。turn 落库了但永远不执行，比不落库更难发现 |
| 4 | 事件消费 | 执行器跑在 `deliverOnce` 的投递事务内，`consumed_at` 与上面三样天然同一个 COMMIT（§5.4） |

**没有**写 `result_session_id`。它是 unique 列，而这条协调会话已经是开出它的那条
`ROTATE_COORDINATOR_SESSION` 的 result；写进去要么撞唯一索引，要么把两个动作的归属搅在一起。链接放在
`detail`（`coordinatorSessionId` / `conversationTurnId` / `conversationTurnSeq` / `clientTurnId` /
`sessionStatusBefore` / `sessionStatusAfter`），`flushPendingTurns` 也从这里读回。

### 1.2 普通 `message`，不是 `steer`（任务描述的硬要求）

`SessionsService.createTurn` 会在引擎正忙时把一条消息**判定成 `steer`** —— 写进正在跑的那一轮，没有自己的
reply。协调轮次不能是这个东西，理由不是风格：

- §7.6 TR3 的整个前提是"上一次 turn **结束了**，而且没有改变它自己被叫醒的那些事实"。一个没有独立
  reply、没有独立完成语义的 steer，让"结束了"和"被吞了"在数据库里长得一模一样；
- 用户/协调器要能在这条会话里**单独回复、单独完成**这一轮。

执行器不走 `createTurn`，`kind` 由它自己写死成 `'message'`，因此**协调会话在忙的时候，turn 照样是排在后面
的普通消息**，等当前轮结束由 inbox 投递。pg spec 里有一条专门盯这件事的场景（协调会话 `RUNNING` + 一条
`IN_FLIGHT` 的 message，新 turn 仍然是 `message`/`PENDING`，会话保住已有 slot）。

### 1.3 幂等是**两层**，而且是同一个字符串（AC2 / AC3）

- 账本层：`project_action.idempotency_key` 上的 `ON CONFLICT DO NOTHING` —— 挡住第二次 **claim**；
- 会话层：`conversation_turn (session_id, client_turn_id)` 上的 `ON CONFLICT DO NOTHING` —— 挡住第二条
  **消息**。

`client_turn_id` **就是** §8.2 的那把键，逐字。不是派生，是同一个字符串出现在两张表里：一条修复 SQL 不需要
知道任何规则就能把账本行和 transcript 里那一轮 join 起来（`openCoordinatorTurnClientTurnId`）。会话作用域让
复用这个字符串是安全的 —— 键里带 `generation`，而一个 generation 只属于一条协调会话（§7.5）。

因此 AC3 的可追溯链是闭合的：
`conversation_turn.client_turn_id` = `project_action.idempotency_key` →
`project_action.decision_id` → `project_decision.outcome.turn.{verdict,reasonCode,reasonDigest}`，
而 `detail.turnFacts` 就是 digest 取值的那份投影。turn 的正文里也带 decision / action / reasonDigest，
因为协调器读的是 transcript，一个在会话里引不出来的唤醒理由没人能从会话本身审计。

### 1.4 一个 pass 只做一次 staleness-gated 写（顺序，不是巧合）

§7.7 的 gate 会在账本事务里**重新采集世界并比对 hash**，而 REPEATABLE READ 让事务看得见自己的写。所以
rotation / verdict / turn 三者里第二个跑的那个，会被第一个跑的那个的副作用判成 `STALE_SNAPSHOT`。

顺序定成 **rotation → verdict → turn**，turn 排最后是有理由的，不只是合法：

- **rotation 与 turn 根本不会同时出现**：TU7 让 `ROTATE` 与 `OPEN` 在一份快照上互斥（turn 需要一个活的落点，
  而 rotation 意味着没有）；
- **verdict 必须先走**：§13.2 的结论会改写 task 行，而那正是 turn 的 `turnFacts` 算出来的地方。让协调器在
  verdict **产生的**那个世界上醒来（下一 pass，事实动了就换 digest），比让它在一个马上要被改写的世界上醒来
  正确。

被让出的那一 pass 里，turn **不占键**（`DEFERRED` 不进账本），`next_wake_at` 被压到 `now`，理由写成
`coordinator turn awaiting a pass of its own`。**不占键这件事是硬要求**：一条 `STALE_SNAPSHOT` 的 REFUSED
行会永久占住这把键，而 TR1 找的是 APPLIED 行 —— 它会一直重新提议同一把已经花掉的键，谁都不会再开出这条
turn。真的落到那个状态时（循环里到不了，但账本键的这个性质对 rotation 同样成立），
`applyCoordinatorTurn` 记一条 **error 级**日志，把静默楔死变成看得见的楔死。

### 1.5 提交后通知只是加速（AC4）

`announce` 在提交之后跑，且**先回账本读一遍**才发（`deliveredTurn` 只认 APPLIED 行）—— 效果与 effect 之间
崩掉的事务会留下一行"什么都没发生"，不会为它发通知。两条通知路径都是长轮询之上的加速器：

- `PENDING` → `QueueService.notifySessionQueued()`，而 `claimSessionForRunner` 自己每 5 秒重试一次；
- `RUNNING` → `RealtimeService.notifyInbox()`，而 runner 的 `GET /runner/sessions/:id/inbox` 是个
  `for(;;)` + 最多 5 秒的 park，超时就自己重读。

所以丢一条通知最多花 5 秒延迟。pg spec 里把 `announce` 换成**必抛**的实现，然后用一条"runner 自己会看到
什么"的 SQL 断言：该 runner 上有一条 `PENDING` 会话，带一条 `PENDING` 的 `message` turn。

### 1.6 TR2-c：没被回答的显式请求不许被吃掉（本轮必须做的回归防线）

这一条本来不在本任务的 AC 里，但**是本次改动自己造出来的风险**，所以属于本轮：在 26 之前没有任何 turn 会被
打开，`user.manual_trigger` 被消费掉也无所谓（本来就没人回答它）；一旦 turn 真的开出来，TR2 的 60s 窗口
立刻变成活的，而 `deliverOnce` 会把整批事件**无条件**标 `consumed_at` —— 于是窗口内的第二次「现在跑一下」
被永久删除，控制面上什么都不会发生。这就是 §7.6 TR2-b/TR2-c 逐字冻结过的 `PC-CX-31`。

实现：`ProjectEventHandleResult` 新增 `hold?: { eventIds, nextAttemptAt }`。`handle` 在**这一 pass 没有提交
一条 `reasonCode = MANUAL` 的 turn** 时，把快照里全部 pending 的 `user.manual_trigger` 放进 `hold`：

- ① 不开 turn（verdict 不是 `OPEN` 就不进 `plannedActions`，26 已经如此）；
- ② `consumed_at` 保持 `NULL`；
- ③ `next_attempt_at` = 窗口边界（`RATE_LIMITED` 时）或本 pass 自己的 `next_wake_at`（其余情形），并且**在
  投递层被地板到 `now + 1s`**，理由和 `deferUntil` 那一行逐字相同：drain 是个循环，一个已经到点的重试时刻是
  自旋不是排期；
- ④ `attempts` **不动** —— 限频不是一次投递失败，让它计入死信阈值等于"十个窗口之后请求就没了"。

对称地还有 `answered?: string[]` —— **TF5 让它成为必需而不是对称美**：一条 `MANUAL` turn 回答的是**当时全部**
outstanding 的请求，而一条"被上一个窗口挂住、`next_attempt_at` 还在未来"的请求**也是** outstanding 的，于是
真正回答它的那次投递手上拿的是**别的**事件。只消费本批就会把它永远留在 pending，下一 pass 又选 `MANUAL`、
又撞上账本已经花掉的那把键 —— 这个 bug 我在实现过程中真的踩了一次，pg spec 里 TR2-c 那条场景的后半段
（窗口过去、由一条不相干的投递来回答）就是为它加的。

`deliverOnce` 的返回值 `eventIds` 也改成**真正被消费的那些**：把一条还挂着的信号报成 CONSUMED，正是 TR2-c
要防的那句谎话。

### 1.7 MANUAL 策略：不开 turn，也不花掉那把键

§9.2 把 `OPEN_COORDINATOR_TURN` 放在 `COORDINATOR_ROUTINE` 行（MANUAL ⚠ / GUARDED_AUTO ✔ / AUTO ✔），
提交点的授权适配器照常在 effect 里跑。但**在 claim 之前**还多问了一次快照上的策略格子，理由只有一个：
turn 键的 epoch 是 `coordinator_generation`，而**拒绝不会推进它**（不像 dispatch 的 attempt 会）。在 MANUAL 下
claim 就等于把这个 episode 唯一的名字烧在一个"要等人"的答案上 —— 等用户把项目改成 GUARDED_AUTO 之后，
这条 turn **再也开不出来了**。这与 `pendingVerificationVerdicts` 那条"别把不可 claim 的键放进审计"是同一条规则。

§7.2 TU6 要求的 `REQUEST_APPROVAL` + USER blocker **没有实现**（不在本任务 AC 内）。MANUAL 下实际得到的是：
不开 turn、不花键、请求保持未消费（TR2-c）、日志里一行 warn —— 既不静默执行，也不静默丢弃。pg spec 里有一条
完整走通"GUARDED_AUTO 开出协调会话 → 收紧到 MANUAL → 失败 + 手动触发都不开 turn → 放回 GUARDED_AUTO →
同一个 episode 照常开出，请求这时才被消费"的场景。

另外，§10.4 第 7 条（限频窗口作为唤醒候选）**代码早就写好了**（`project-next-wake.ts` 的 `source: 7` 与
`rateLimitedTurnWindows`），只是在没有任何 APPLIED turn 行的世界里恒为空。本轮写下 `reason_code` 之后它第一次
真的产出候选 —— 26 的 §33.2 把它列为"未实现"指的就是这个"活不起来"的状态，本轮没有改动它一行。

## 2. 测试与证据

环境：Node **v22.22.2**（仓库 `engines` 要求 ≥26，本机只有 22，用 `--engine-strict=false` 装依赖）、
npm 10.9.7、TypeScript 7.0.2（原生二进制）、Prisma 7.9.1、PostgreSQL 16（`postgres:16-alpine`，
tmpfs 数据目录，一次性容器，跑完 `docker rm -f -v`）。
worktree 内独立 `npm install` —— `/root/orbit/node_modules` 仍是 Prisma 5.22 / TS 5.9 的陈旧树，软链过去会得到
一批假错（26 已记过同一条）。

### 2.0 分支与提交

分支 `orbit/b-open-coordinator-turn-b86879`，从**包含单元 26 的最新主线** `b1391eee` 开出
（26 的分支 `orbit/a-coordinator-f675a4` 收工时仍未并入 `main`，而本单元必须站在它上面，所以是 fast-forward 到
它再往前做，不是另开一条从 `main` 出发的分支）。

- `9e4d3e30` feat(projects): deliver the coordinator turn the loop already decided
- `7486c783` style(projects): name the delivery record instead of inlining it in the SQL
- 本文所在的提交是当前分支 tip。

### 2.1 命令

```bash
# 单元（不需要数据库）
npm test -w @orbit/apiserver

# 真实 PostgreSQL：一次性容器 + 每个 spec 前重建**数据库**并 migrate（见 §2.4 为什么不是 schema）
docker run -d --name pccb-turn-pg --tmpfs /var/lib/postgresql/data:rw,size=1500m \
  -e POSTGRES_USER=pccb_user -e POSTGRES_PASSWORD=pccb_pw -e POSTGRES_DB=pccb_turn \
  -e PGDATA=/var/lib/postgresql/data/pgdata -p 127.0.0.1:55437:5432 postgres:16-alpine
DATABASE_URL=postgresql://pccb_user:pccb_pw@127.0.0.1:55437/pccb_turn npx prisma migrate deploy
COORDINATOR_PG_URL=postgresql://pccb_user:pccb_pw@127.0.0.1:55437/pccb_turn \
COORDINATOR_PG_EXPECTED_DATABASE=pccb_turn COORDINATOR_PG_EXPECTED_USER=pccb_user \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(docker exec pccb-turn-pg \
    psql -U pccb_user -d pccb_turn -tAc 'SELECT system_identifier FROM pg_control_system()') \
  node --test build/projects/project-coordinator-turn.pg.spec.js

docker rm -f -v pccb-turn-pg     # 一次性，跑完就删；tmpfs 不留卷
```

`COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER` **每个容器都不一样**，所以上面从容器里读而不是抄一个常数 ——
`coordinator-pg-test-safety` 要的就是"你确实知道自己连的是哪台一次性服务器"。本轮实际用过两台
（`7676636031404142626` 与最后一次复核的 `7676647512191844386`）。

### 2.2 结果

| 项 | 结果 |
|---|---|
| 基线 `npm test -w @orbit/apiserver`（改动前，`b1391eee`） | **2358 tests / 2112 pass / 0 fail / 246 skipped** |
| 改动后 | **2375 / 2118 / 0 fail / 257 skipped**（+17 = 6 条新单元 + 11 条新 pg；pg 无 URL 时 skip） |
| `project-coordinator-turn.pg.spec.ts`（真实 PostgreSQL） | **11 / 11 pass** |
| 全部 38 个 `*.pg.spec.ts` 逐文件**重建数据库**后顺序跑 | 见 §2.4 |

### 2.3 新 pg 场景逐条（都从**门**进：提交一条信号，然后 drain）

| 场景 | 盯的是 |
|---|---|
| 一次已落定的任务失败 ⇒ 一条动作 + 一条 message turn + 可运行的会话，一起提交 | AC1 / AC3：`reason_code = TASK_FAILURE`、键形状、`turnFacts`、`client_turn_id == idempotency_key`、动作 → 决策 lineage、`outcome.turn.verdict = 'OPEN'`、事件已消费、会话 `PENDING` |
| 空闲的协调会话变得可 claim；忙着的保住 slot 并排在后面 | `AWAITING_INPUT → PENDING`；`RUNNING` 时仍是 `message`/`PENDING` 而**不是 steer**；已 claim 的会话不再被重新 seed |
| 重复 / 乱序 / 重启后的同一 episode | AC2：4 次重投 + 一个**全新的服务实例**接管，仍然只有一把键、一条消息 |
| 同一把键的第二次 claim | AC2：`ALREADY_APPLIED`，不写第二条消息，并且回答的是**已经存在的那一轮**的 id |
| 提交后通知必抛 | AC4：动作照样 APPLIED，turn 照样 PENDING，"runner 自己会看到什么"的 SQL 仍然命中 |
| 计划之后世界动了 | `STALE_SNAPSHOT` 审计行 + 一条消息都没写，已 APPLIED 的那条不受影响 |
| 提交点上的 TU7（协调会话已结束） | 直接问 effect 自己的守卫：typed `COORDINATOR_SESSION_NOT_LIVE` + `retryable: true`，不写消息。单独问是因为 §7.7 的 hash gate 通常先答，而它比对的是拿行锁**之前**的 hash |
| 提交前 `SIGKILL`（真实进程被杀） | AC2/AC5：账本键与消息被 PostgreSQL 一起回滚，信号仍在；接管**恰好**重做一次 |
| 提交后 `SIGKILL` | AC2/AC5：提交了的就是提交了的；幸存者不再重复，死掉的进程欠下的那条通知只是延迟 |
| 窗口内的第二次 manual trigger | TR2-c：`consumed_at` 仍为 `NULL`、`attempts` 仍为 0、`next_attempt_at` **等于锚点行 `created_at + 60s`**、`next_wake_at ≤ 窗口边界 + 5s`（TR2-d 的 W3 地板）；然后窗口过去，由一条**不相干**的投递把它回答掉并消费（TF5） |
| MANUAL 策略下的失败 + 手动触发 | §9.2 / §1.7：一条动作都不写（**键没被花掉**）、一条消息都没有、请求未消费；放回 GUARDED_AUTO 后**同一个 episode** 照常开出，`reason_code = MANUAL`（TU4：人的请求仍然压过失败），这时请求才被消费 |

### 2.4 pg 回归（全部 38 个 `*.pg.spec.js`，逐文件一个**全新数据库** + `prisma migrate deploy`）

**每个文件一个新建的 database，而不是新建的 schema**：`pg_trgm` 是 database 级对象，而其中 7 个 spec 自己
往私有 schema 里跑 `prisma migrate deploy`；共用 database 会让第二个 deploy 的
`CREATE EXTENSION IF NOT EXISTS pg_trgm` 变成 no-op，`gin_trgm_ops` 于是在它自己的 search_path 里查不到。
（第一轮我按"重建 schema"跑，正是被这一条绊住的。）

```
coordinator-04r-adversarial                3/3    project-decision                        1/1
coordinator-04r3-adversarial          9/12 ✗      project-dispatch-boundary-verification  17/18(1 skip)
coordinator-companions                     8/8    project-dispatch-boundary               1/1
coordinator-final-row                    16/16    project-dispatch-pass                  15/15
coordinator-identity-migration             8/8    project-e2e-acceptance                 28/28
coordinator-identity-provenance          11/11    project-e2e-recovery                   17/17
coordinator-identity-service               8/8    project-event-sources                    4/4
coordinator-linearization                44/44    project-events-fault-injection        4/5(1 skip)
coordinator-service-linearization          9/9    project-events                           7/7
project-acceptance                       18/18    project-reconcile-fault-injection     6/7(1 skip)
project-authorization                      1/1    project-reconcile                        1/1
project-availability-event-sources         1/1    project-verdict-reconcile                7/7
project-blocker                          15/15    task-aggregation                       25/25
project-control-surface                    5/5    task-verification-verdict              17/17
project-coordinator-driver                 6/6    verify18-control-loop                    5/5
project-coordinator-session                1/1    agent-identity-migration                 6/6
project-coordinator-turn （本单元）      11/11    agent-persistence                        6/6
                                                  steer-dequeue                     0/11(全 skip)
                                                  merge-receipt                          11/11
                                                  task-supersession                      13/13
                                                  task-verification-doors                13/13
```

**37 个文件全绿；唯一的 3 个失败在 `coordinator-04r3-adversarial` 的第 9–11 条，与本次改动无关，可证明：**
该文件只 import `pg` 与 `coordinator-pg-test-safety`（两者本轮都没改），其余全部通过读迁移 SQL + spawn
`prisma migrate deploy` 完成；失败信息是 `P3018 / 42704 operator class "gin_trgm_ops" does not exist`，
发生在 **0068_session_search** 这条 2024 年的迁移上。原因是该文件在**同一个数据库内**先后往两个私有 schema
deploy：第一次把 `pg_trgm` 装进 schema A，第二次的 `IF NOT EXISTS` 于是 no-op，而 schema B 的 search_path
里看不到 A 的 opclass。本轮 diff 里**没有任何 SQL / 迁移 / Prisma schema 改动**（`git diff --stat` 可查），
因此结构上不可能是它的原因。

另外两处 skip 都是环境开关而非失败：`project-reconcile-fault-injection` / `project-events-fault-injection`
各有一条需要 `COORDINATOR_PG_CONTAINER`（真实 `docker stop/start` 注入），`steer-dequeue` 需要它自己的 URL 变量。
`project-reconcile-fault-injection` 与 `project-events-fault-injection` 还需要先编译各自的 overlay：
`npx tsc -p tsconfig.project-reconcile-faults.json` / `tsconfig.project-event-faults.json`（否则子进程
`require('./build-project-reconcile-faults/…')` 直接 module not found —— 这也是我第一轮那 2 个"失败"的全部原因）。

## 3. 刻意留下的边界（不是遗漏）

1. **TR3 的 `COORDINATOR_NO_PROGRESS` 没有落库。** turn 层的 TR3 **抑制**已经生效（verdict `NO_PROGRESS`
   ⇒ 不进 `plannedActions` ⇒ 不开 turn，反 foreman 性质完整），缺的只是那条"该有人看一眼"的可见行。没有顺手
   做，是因为它需要**重新分层** `planProjectDecision`：blocker 计划是 turn 的输入（`context.openBlockers`），
   turn 的 verdict 又要变成 blocker 的输入，而 blocker 集合还决定 `run_state` 与 §10.4 的候选表 —— 那会改变
   **每一个** PLANNING 项目的决策产物，远超本任务 AC 所settle 的范围。
   今天它不会漏掉任何东西：`MANUAL` 的 TR3 实际上不可达（回答它的那条 turn 会把信号一起消费，下一次请求是新的
   `dedupeKey` ⇒ 新 digest ⇒ 新键），而 `TASK_FAILURE` 根本不带信号。
2. **`ACCEPTANCE` 与 `REPLAN` 仍未求值**（26 的边界，本轮没有动）。因此没有任何项目开始收到 `REPLAN` turn。
3. **没有新增迁移、没有改 Prisma schema、没有改任何一条已冻结契约条款**，§33 作为修订日志按仓库惯例不回写。
4. **没有改写任何历史失败 Session**，也没有用任何形式的"完成"覆盖真实运行结果。
