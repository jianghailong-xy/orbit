# `[K4]` 进展向量、失败与动作身份、不收敛熔断

实现单元 `[K4]`。规范来源是 `docs/project-coordinator-convergence-contract.md` v1.2 的 §4、§5/§5.1、
§8 与 §9；本文只写**怎么落地的**与**为什么是这样落地的**，不重述契约。

代码：

| 文件 | 内容 |
| --- | --- |
| `src/apiserver/src/projects/convergence-evidence.ts` | 证据 → 向量、新鲜度读数、动作/假设身份、`severityTrend` |
| `src/apiserver/src/projects/convergence-progress.ts` | `advanceCounters` 的两个新计数、§9 门禁 `convergenceDispatchRefusal` |
| `src/apiserver/src/projects/convergence-contract.ts` | v1.2 的两个计数、两个阈值、两个 reason、`SeverityTrend` |
| `src/apiserver/src/projects/convergence-ledger.ts` | 新鲜度闸门、身份入账、输入版本 v2 |
| `src/apiserver/src/projects/convergence-ledger.service.ts` | 窗口内动作计数（SQL）、`dispatchGate` |
| `prisma/migrations/0134_task_progress_vector_identity/` | 四个新列、九个计数的 CHECK/单调触发器、回填 |

测试：`convergence-evidence.spec.ts`（24 条纯函数 + 4 条反向变异）、`convergence-evidence.pg.spec.ts`
（10 条真实 PostgreSQL：迁移、并发、重投递、回填）。

## 1. 向量必须被推导，而不是被声明

`[K1]` 的 `strictlyImproves` 只接受两个向量，不问它们从哪来。这是事故最后一个还能住人的地方：调用方
自己算的向量可以宣称任意改善，而四个「自上次进展以来」的计数会照它的话清零。

`deriveProgressVector(snapshot)` 把 §1 那句「由证据推导，无人手写」变成代码。输入是一份结构化快照
（验收项、finding、blocker、checkpoint，每一项自带 `observedAt`），输出是向量 + 一份**新鲜度读数**。

三个判断值得记下来：

- **`WIP_RED` 的 checkpoint 不是 `knownGoodSha`。** §4 把「第一次出现 known-good」算作一次进展，
  于是「我把工作存下来了」若能读成「有一个好状态可以回退」，就等于白送一次进展。
- **最旧的一项决定读数。** 快照是对同一个世界的一次测量；其中一项过期，就意味着这份读数描述的是一个
  已经移动过的世界——那条「已关闭」的验收项完全可能已被正在被评判的这次改动重新打开，而数字上看不出来。
- **空快照是 `UNMEASURED`，不是 `FRESH`。** 空快照推出来的向量是全零，全零在只看数字的比较里与
  「所有缺陷都已修复」不可区分。证据管道坏掉必须读作坏掉。

新鲜度**没有**进向量（PV1 是穷举的）。它是一个前置条件：`STALE` 或 `UNMEASURED` 的读数不能刷新
`lastProgressAt`，但**照常消耗计数**——「这一轮没测出来」是一次没有进展的决定，而事故正是由这种决定
堆成的。

## 2. 动作身份：指纹的另一半

事故里 `sameFingerprintRepeats` 从未数到二，因为每条错误文字都带一个新 session id。同一套归一化用在
动作上，得到的就是 `actionIdentity`：kind + target + hypothesis + scopeHash，全部走 §5 的八步。

两个容易写错的地方：

- **身份里不能有 `attemptGeneration`，幂等键里必须有。** 幂等键回答「这个动作是不是已经执行过」，
  所以每代不同；身份回答「这是不是上次那件事」，所以每代相同。把两者写成一个东西，循环就永远显示为
  一串互不相同的新计划——而这正是 `[K2]` 的 `actionIdempotencyKey` 单独存在的原因。
- **计数是「窗口内的最大重复次数」，不是「与上一次相同」。** 连续计数会被交替两个动作绕过：
  A、B、A、B 永远不连续重复，而事故的形状恰好是「重跑测试 / 推一个修复」两件事轮流做。所以写入方在
  同一把行锁下用一条 SQL 数**自上次严格进展以来**这个身份出现过几次，`advanceCounters` 取它与已提交
  计数的**最大值**：新动作只能不增，不能把计数谈下来（RL3/TH4）。

## 3. 两条新线，以及它们不该停下的东西

| reason | 计数 | 默认 | 抓的是 |
| --- | --- | --- | --- |
| `SAME_ACTION_REPEATED` | `sameActionRepeats` | 2 | 一直做同一件事，哪怕每轮的错误文字都不同 |
| `SEVERITY_NOT_DECLINING` | `repairsWithoutSeverityDrop` | 3 | 一直在返修，而 `openP0 + openP1` 从不下降 |

`maxRepairsWithoutSeverityDrop` 是 3 而不是 2，理由是**顺序**而不是宽松：设成 2 时它会在事故自身的
回放里比 `SAME_FAILURE_REPEATED` 早一轮跳闸，于是把一个真正的诊断（「就是这个错，又来了」）替换成一个
次要的诊断。这两条线的职责是接住指纹线**接不住**的循环，不是抢在它前面说话。

反过来，它们**不得**停下真正在收敛的任务，这是本单元被复核的那个缺陷的 `[K4]` 版本：

- `severityTrend` 有三个值而不是两个。`NONE`（没有任何 P0/P1 可降）与 `HELD`（有而没降）是不同的世界，
  只有后者是返修循环的证据。一个不把 finding 记成 P0/P1 的任务，不该被一条与它无关的线砍掉，更不该
  收到一句对它并不成立的理由。
- `advanceCounters` 的 `severity` 与 `sameActionPriorCount` 是**必填**参数。给它们默认值，等于让忘记
  传的调用方悄悄把一个正在降缺陷数的任务判成返修循环——这种缺陷应该由类型检查器报出来，而不是由一个
  被错误理由停掉的任务报出来。
- `repairsWithoutSeverityDrop` 的清零许可比数据库能检查的更窄：库里只能看到 `last_progress_at` 动了
  （因为向量在账本行里，而账本行是在 task 更新之后才插入的），所以触发器守「计数不能往下走、清零只能
  清到零」，`advanceCounters` 守更窄的那条「进展 **且** 缺陷数真的降了」。

## 4. 原子熔断与「不再 retry」

一次判断在一个事务里做完三件事：移动 task 的列、插入账本行、（越线时）把 `progress_state` 落成
`NEEDS_REPLAN`。`[K2]` 的 `record` 已经是这个形状，`[K4]` 只是让越线的条件多了两条。

真正新增的是 §9 的门禁 `dispatchGate`：它取**同一把** `FOR UPDATE` 行锁再判定。这不是防御性编程——
一个不加锁的门禁会读到熔断前的世界，然后派发出正是熔断要阻止的那次重试。pg spec 里有一条专门盯这个：
A 事务里判断已越线但尚未提交，B 调门禁，断言它**阻塞**而不是返回一个乐观答案；A 提交后 B 得到
`TASK_NEEDS_REPLAN`。

门禁返回 `refusal | null` 而不是 `'ALLOWED'`，并且另外把 SM2 的「这个状态能不能派发」原样返回给调用方。
§9 只有两个拒绝码，发明第三个会让契约的表和代码对不上；而返回一个乐观的 `ALLOWED` 会诱使调用方跳过它
本来还该问的那些前置条件。接线到实际派发路径是 `[K7]` 的事。

## 5. 迁移 0134 的顺序

回填必须跑在两个计数函数被替换**之前**：单调触发器的 key 列表写在它自己的函数体里，先替换函数会让每一条
回填 UPDATE 看起来像「两个计数从 NULL 冒出来」，而那正是它要拒绝的东西。账本行的回填要临时关掉不可变
触发器一条语句——迁移补一个当时还不存在的 key，不是改写这条判断的结论，而不补的代价是每个 pre-0134 的
任务在恢复时都被报成账本与列不一致。

列默认值也要一起改：0132 的 `DEFAULT` 是七个 key 的字面量，不改的话 0134 之后新建的每个任务都会在第一次
判断时撞上九个 key 的 CHECK，症状会在几天后表现为「协调器写不了新任务」。
