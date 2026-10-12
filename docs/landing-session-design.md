<!-- 2026-10-04 · owner 决定落地要有会话；本文是评审工作流（4 个变体 × 3 个评委 → 合成）的结论，效果图见 docs/mocks/landing-session/。 -->

# 落地会话（契约修订 9 草案）

> 本草案作为集成线契约 **v1 修订 12** 落地（`docs/project-integration-line-contract.md` 附录 B；main 的修订 9、10 与附录 B 的 11 号已另有所指，见 §0.1 第 1 条）。文中的「修订 9」都指修订 12。


## 0. 红队修正（2026-10-04，优先于下文；下文与本节冲突处以本节为准）

红队核对了约 30 处关键引用，几乎都成立。它指出的问题集中在新增的机制上，以下按此修正。

1. **撤销改用「以事实为准」，不再要推送许可。** `push_granted_at`、120 s 启动窗口和推送许可都不做，原因有两个：
   - 许可在 TARGET_MOVED 之后的几轮里一直有效，叫停和放弃会被拒好几个小时；
   - 拿到许可后 runner 失联，作业就没有终态。

   改为：
   - 进度应答带 `cancelRequested`；
   - runner 在 PUSH 之前做一次**同步**回报（phase=PUSH），应答里带 cancel 就杀掉检查、不推送；
   - `applyCancel` 让晋升停在「取消中」，直到作业有终态结果；
   - `applyPromotionJobResult` 收到「已请求取消但 LANDED」的结果时，如实记为 MERGED 并写回执（不再返回 null，`project-promotion.service.ts:974`）。

   服务端以「是否已记下 PUSH 阶段」作为推送的界线。
2. **放弃。** 租约过期才能放弃：
   - 服务端还没记下 PUSH 阶段：写 ERROR / `RUNNER_LOST`，文案「nothing was pushed」；
   - 已经记下 PUSH 阶段：写 ERROR / `PUSH_OUTCOME_UNKNOWN`，文案「may have been pushed」，晋升改为 BLOCKED；同一 serial_key 上的下一个作业检查 `tested_sha` 是否已是目标的祖先，是就补写回执。

   放弃要走 apply-result 同一事务。`integration_abandon` 的门槛是「当前协调会话 且 LEASE_EXPIRED」，不套用 J-T1b 的待办规则。
3. **已请求取消的 RUNNING 作业也能被接管。** 把 `cancel_requested_at IS NULL` 从 claimOne 的顶层 WHERE 挪进 QUEUED 分支（`integration-job-relay.ts:317-318, 379-383`）。接管后 `runIntegrationJob` 立刻回报 CANCELLED。
4. **supersede 不再直接把 RUNNING 写成 CANCELLED。** 它改为写 `cancel_requested_at`，只有 QUEUED 才直接写 CANCELLED（`project-promotion.service.ts:842-846`）。v2 runner 收到 409 或终态应答就杀掉检查、释放进程内的 integrationLock。在本机锁上等待，作为一个有名字的步骤显示：*Waiting for another job on this runner*。
5. **落地主体按线区分，只用 promotion_id 或 task_id 作键，永远不读 `project_promotion.task_id`。** 后者总是有值：TASK_BRANCH 候选带自己的任务，PROJECT_BRANCH 候选带最后落地的任务。
   - MAIN 线（TASK_BRANCH 候选）：主体是任务段，这个任务的每个候选（包括重新提交的、被取代的）都是段里的一节，标题 *Land · <task> → main*。
   - PROJECT_BRANCH 线：LAND_TASK 归任务段；合入 main 归晋升主体。
6. **晋升会话的粒度（owner 2026-10-04 已定：每一轮合入一个会话）。** **每一轮合入一个会话**：从上一次 MERGED、DECLINED 或 CANCELLED 之后的第一个候选开始，到下一次这三者之一为止，被取代的候选都是会话里的一节。原因是 considerCandidate 和 supersede 会让「每个候选一个会话」频繁换页。会话行在第一次被领取时才插入（id 照旧在入队时预生成），所以 QUEUED 时就被取代的候选不会生出一行。
7. **会话判别列。** `session.kind` 的 CHECK 用 `NOT VALID` 加上之后单独的 `VALIDATE CONSTRAINT`，避免在最热的 session 表上全表扫描并持有 ACCESS EXCLUSIVE 锁。也可以照 merge-repair 的先例改用 `source='landing'`，实现时二选一，写进契约。
8. **引擎门用结构性守卫，不靠列举端点。**
   - 在 SessionsService 和 runner 会话控制器的入口统一调用 `assertEngineSession(session)`；
   - 用普查 spec 列出所有会改动 session 的路由；
   - 落地会话**不能 Trash**；
   - 行不存在时，GET /sessions/:id 和 session_get 通过 project_landing 渲染 landing 视图。
9. **G6 不变。** open-item:v1 的投递文本不改，否则滚动部署时重放会因字节不一致报冲突（`sessions.service.ts:4815-4825`）。链接只放在待办 payload 和 OPEN_LANDING 卡片动作里。旧客户端画不出 OPEN_LANDING，所以晋升待办上的 OPEN_TASK_SESSION 暂时保留，等客户端都升级后再去掉。
10. **版本差异。** 作业在领取时记下 `progress_protocol`，只有 v2 的领取会在 command 里带上 pre-push 回报的要求。legacy 作业的取消沿用第 1 条的「取消中，以事实为准」。
11. **轮次与通常用时。**
    - 轮次按领取计，例如 *claim 2 · round 1 of 3*，接管处留标记。
    - 「通常用时」只对 MERGE_CHECK 计算，或按命令哈希分别计算。TASK_ACCEPTANCE 每个任务的命令都不同，不显示通常用时。
12. **blockingReason 推广到三种作业。** 第 1 期就做，属于纯读取（V0）。跨账号的阻塞作业不显示 id 和标题，只显示原因，例如 *another landing into this repository*。
13. **补齐的缺陷修复。**
    - J-T8 for LAND_TASK：任务重开或取消的事务里，QUEUED 直接写 CANCELLED，RUNNING 写 `cancel_requested_at`。
    - 排空交还需要新增一扇有围栏的 release 门（RUNNING → QUEUED），写进 J-T 表和 db-write-inventory。
    - `_integrate-` 临时目录实际在 `~/_integrate-<id>`，因为 workDir 是 workspace 的 work_dir，要么挪进 worktreesDir，要么让 GC 扫描这个位置。
14. **租约过期提醒（owner 2026-10-04 已定：过期 15 分钟给 owner 开待办）。** J1 跨项目、跨账号，一个死掉的作业会卡住同一 repo#ref 上所有落地。把 §4.6（唯一允许的「时间→状态」时钟，只面向 owner）扩展到「租约过期超过 15 分钟 → 给 owner 一条待办」，待办里带 Abandon。
15. **分期顺序调整。**
    - 第 1 期：缺陷修复、以事实为准的撤销、30 s 续租并带当前检查的名称、序号和预算、所有作业的 blockingReason、J-T8、inFlight 带 id。
    - 第 2 期：落地会话核心，包括判别列、按线区分的 project_landing、引擎门守卫、不可 Trash。
    - 第 3 期：时间线事件、日志管道和 outputIdle 活性。
    - 第 4 期：各端页面与入口。实时事件 `landing.updated` 和 `includeLanding` 跟项目分组一起上，在那之前按 §2.7a 的节奏轮询。
16. **直接推到 main 的提交与合入 main 争抢（owner 2026-10-04 已定：第一次被抢就交回）。** LAND_PROMOTION 推送被拒（TARGET_MOVED）一次后，不再在作业里重跑两轮完整检查。作业结束，候选交回协调会话（Automatic 下）或 owner，由它决定重跑：
    - Automatic 下照旧回 READY；
    - owner 确认过的候选回 BLOCKED，并开 INTEGRATION 待办，payload 带 upstreamMovedBy。

    LAND_TASK（落到项目分支）的重取轮次不变。session merge 到 main 不与合入 main 串行，这一点不在本项目范围内。
17. **契约修订 9 还要写明以下内容：**
    - LANDING 会话的 AWAITING_INPUT 只表示容器未结案，prompt 永不投递，`provider='orbit'` 是保留值；
    - J-T 表新增的转移：放弃 RUNNING→ERROR、排空交还 RUNNING→QUEUED、进度驱动的 RUNNING→CANCELLED、可被接管的已请求取消作业；
    - 协调会话对在途作业新获得的放弃权；
    - lock-order.ts:149-153 的措辞：ensure 在领取语句提交后、在自己的事务里执行；
    - GET /sessions 和 session_list 的返回范围变化；
    - session-list-projects-design §3.4「不加新事件」被改写。

## 0.1 2026-10-07 复核修正（优先于 §0 与正文中被它改写的条目）

2026-10-07 在 main de0838eb7 上逐条复核。de0838eb7 比 5b73f4717 多 632 个提交。本节没提到的条目，仍按 §0 执行。

### 编号与基线
1. **修订号**：main 附录 B 已有 v1 修订 9（Chat about this，2026-10-03，5a897a5ea）和修订 10（合入卡挪到项目 sessions 页，2026-10-06，6b4bef713）。本草案作为**修订 12** 落地：2026-10-08 合入 main 时附录 B 的下一个空号已是 12（11 号被「一次落地可以不带合并检查跑」占用），J-T9 同时被 main 的超时重试占用，本草案原先的四条 J-T 顺延为 J-T10–J-T13；编号一律以合入 main 时附录 B 的下一个空号为准。本文标题和正文里的「修订 9」都指修订 12。
2. **迁移号**：0377 已是 dsh_runner_gate，main 最新为 0392（2026-10-07）。新迁移一律取实施时 main 最新号之后的空号。
3. **T0 的 8e69d8013**（orbit/9-a2dcf9）与 main 在附录 B 冲突，要在 origin/main 上重做；10-04 的退回意见仍然成立。

### main 上已经有的
4. **项目分组已上线**（a19a3d157、9c241dfa2、adb070ff6、383594ee2、609d4f226、ee7de74cc）：web 有 ?project= 页，iOS 有 SessionProjectPage，macOS 没有。§3「项目分组还没在 main 上」和 §0 第 15 条「landing.updated 和 includeLanding 跟项目分组一起上」作废，改为：
   - 平铺的 GET /sessions、/sessions/compact、/sessions/search、/sessions/counts、session_list、session_search 默认排除 LANDING；
   - GET /sessions?projectId= 只在 includeLanding=1 时以 LANDING 角色返回；成员关系 SQL 的两处（directProjectMembershipSql、projectMembershipCandidatesSql）都加 LANDING 分支；
   - 项目条目与项目 sessions 页的会话数、running 数和状态点不计 LANDING；
   - **不加 landing.updated**：分组上线时没有加实时事件，页面按 4 s 轮询；落地会话页按 §2.7a 的节奏轮询；
   - 服务端由新任务 t2list 负责，客户端由 web 入口任务和 t4apple 负责。
5. **修订 10**：合入卡在项目 sessions 页（web ProjectMergeStrip，iOS ProjectMergeCardView），协调会话里每个时刻只留一行。
   - §3「晋升卡在 CHECKING/CONFIRMED/RECHECKING 时显示 Watch」改为合入卡上的 Watch。
   - §5「晋升沿用 Cancel（project-promotion.controller.ts:77）」：现在在 :83，并且是 @PatForbidden('OWNER_INTERACTIVE')。
   - M-T10 改为「取消中」以后，ProjectPromotionView 由服务端给出 cancelRequested 与 pushBoundaryPassed，合入卡据此画「取消中」，不再自己看 execution.phase（ProjectMergeStrip.tsx:173）。
6. **落地行已经有四处**：项目页 Work overview、项目 sessions 页进度卡（859fc2e0c）、合入卡里的 LandingRow（6b4bef713）、会话列表项目行第二行（19555f614）。四处共用 landingLine。会话列表项目行在心跳超过 10 分钟时变灰，是同一种假停滞。V6 与活性规则覆盖全部四处，新字段一律可选。
7. **owner 重跑门已上线**（d2904706e，0380）：POST /projects/:id/tasks/:taskId/integration/retry 与 POST /projects/:id/promotions/:promotionId/integration/retry；发起者是会话或 user，二者互斥。§5 表「重跑」一行和 §8 第 4 期「放宽 0344」已经完成。
8. **LAND_TASK 的 blockingReason 已实现**，含跨账号只给原因。代码在 project-task-integration.ts:108-190 与 :340-375，不在 project-integration-line.ts。第 1 期只需推广到两种晋升作业和本机锁等待。
9. **晋升待办从来没有 OPEN_TASK_SESSION**：5b73f4717 与 main 都只投影 ASK_COORDINATOR_AGAIN、RETRY、REVIEW（open-item-doors.ts:634-643）。§0 第 9 条和 §3「晋升待办上错误的 Open task session」说的其实是转录卡上的「Open the failed session ↗」（OpenItemDeliveryCard.tsx:177-236；OrbitKit OpenItemDelivery.swift）和行上的 sessionId。暂时保留的是这两样。
10. **Automatic 合入被抢后已能交回**：今天在第 1 轮重取时经 M-T12（integrate.go:553-556）报 READY，服务端交回 owner（project-promotion.service.ts:1045-1047）。owner 确认过的候选以 ERROR 结束，已走 BLOCKED 加 INTEGRATION_ERROR 待办。§0 第 16 条剩下要做的是：轮次改为 0，加上提交列表。
11. **其他已上线、要读进时间线与结案规则的事实**：
    - task_reopen intent（28bd87aa4，0381）；
    - 修复任务 fixes_open_item_id（c84c6f9a3，0379）：协调会话现在建修复任务，而不是重开原任务；
    - 协调会话交接 handover_*（0378）；
    - MOVE_TASK（0386、0389）。

### 机制修正
12. **推送界线**（改 §0 第 1、2 条）：定义为「服务端在本次领取（claim_generation）下记下过同步 PUSH 回报」。
    - 第 1 期起就从作业行的一列读出（例如 push_reported_generation，由 PUSH 同步回报在租约围栏内写入），不依赖第 3 期才有的事件表。
    - 只能看 phase 的地方，PUSH 与 VERIFY 都算已过界。runner 推送成功后报 VERIFY（integrate.go:394、:687），而今天 applyCancel 只排除 PUSH（project-promotion.service.ts:610）：VERIFY 期间取消，会把已推送的合入记成 CANCELLED。这是 §9 第 1 条之外的新缺陷，由 t1srv-a 修。
13. **legacy 领取**（progress_protocol 不是 v2）：PUSH 回报是尽力而为，应答被丢弃（integrate.go:1034），所以「没记下 PUSH」不能证明没有推送。
    - 放弃一律写 PUSH_OUTCOME_UNKNOWN，不写 RUNNER_LOST，也不写「nothing was pushed」。
    - 检查期间不判 LEASE_EXPIRED，或以预算加余量为界；X-E5 用同一条界线。
14. **锁序**（改 §7 S3 的前提与 §0 第 17 条）：claimOne（integration-job-relay.ts:311-387）JOIN session、workspace 后 FOR UPDATE SKIP LOCKED（:385），没有 OF c，三张表都上行锁，但从不等待。
    - lock-order.ts 如实写现状。
    - 「作业门不等待 session 锁」写成对实现的要求。
    - 是否收窄为 OF c，由 t1srv-a 配竞态 spec 决定。
15. **J12 不需要迁移**：error_code 没有 CHECK（0281:85），闭集是 INTEGRATION_ERROR_CODES（project-integration-job.ts:71-83）加契约文本。phase 有 CHECK（0281:109），所以本机锁等待与 prepare 用可选的 step 列，不加 phase 值。
16. **提交列表改名**：upstreamMovedBy 与 project_promotion.upstream_moved_by（Int，0294）、ProjectPromotionView.recheck.upstreamMovedBy（number）重名，建议改为 upstreamMovedCommits。它放在结果的新可选字段里，不进 errorDetail：errorDetail 会被原样抄进待办 payload（relay :978）。
17. **J-T8 的「重开」** 指 task_reopen 门，与写 task_reopen_intent 在同一事务里。任务被写成 CANCELLED 或 FAILED 同样叫停。普通的 DONE→IN_PROGRESS 编辑是继续工作，不叫停。按现行 J-T3、J-T8、M-T10 就能做的修复拆成 t1srv-a，不等修订 12：QUEUED 直接 CANCELLED、已请求取消可接管、VERIFY 界线、LAND_TASK 的 J-T8、回填。
18. **删除回滚**（改 §9 第 2 条）：LAND_TASK 的 task_id 置空还违反 project_integration_job_land_task_chk（0281:117-119），所以任何一代 LAND_TASK 都会挡住删任务。project_promotion.task_id、session_id（0286:90-93）同样撞 project_promotion_terminal_guard（:128-143）。只能改为不带外键的历史引用，「让守卫放行」行不通。
19. **会话行补充**（改 §2「会话行」）：
    - root_session_id 为 NULL，否则会获得 CHILD 归属；
    - title_managed_by_project=true；
    - 显式写 dispatch_origin 与 run_source；
    - provider='orbit' 且 provider_builtin=true，并把 orbit 加入 providers/provider-slug.ts 的 RESERVED（今天不是保留值）；
    - PROMOTION 主体的 workspace 取 project.coordinator_workspace_id；
    - 判别列的线上字段名避开 kind：web 列表条目写 {...session, kind: 'session'}，会覆盖同名字段。
20. **结案补充**（§2「任务段」）：
    - MOVE_TASK 移走任务时，它的未结段结案为 CANCELLED；
    - 待办由修复任务解决时，写明 settled_as 与会话 status；
    - owner 重跑门的新一代落在同一段。
21. **runner 新查实的缺陷**（补 §9）：
    - 检查以 0 退出、但子进程仍占着 stdout 时，返回 exec.ErrWaitDelay，落进 integrate.go:894 的 default，被判 CHECK_FAILED（先例修复 0fa9af167）。
    - 自更新闸门只数会话轮次（runloop.go:103-116）。Update Runner Now（ef8745d30）与灰度发版会在长检查中途停掉心跳（:2005），runner 一直显示离线，直到作业结束（:2016）。
    - scratch 挪进 worktreesDir 以后，gcWorktrees 会把非 UUID 目录当作可删（runner-api.controller.ts:6433-6455）。要在 worktree.go:2517 排除它，并按在跑作业另做清扫。
22. **换掉 CombinedOutput 挪到第 1 期**（改 §8 第 3 期）：不换就量不出 outputIdleMs 与 outputBytes，也就没有活性。第 3 期只留上传 sink、日志表和脱敏。
23. **推送许可作废**：§2「数据」里的 push_granted_at、§5「推送许可」、§8 第 1 期的「推送许可」都已被 §0 第 1 条取代。

### 新的守护与约束
24. **main 上新增的普查**，本项目每个任务都要满足：
    - PAT 路由覆盖（pat-route-coverage.spec.ts）：owner 门用 @PatForbidden('OWNER_INTERACTIVE')，并登记 auth/pat-owner-channel-routes.ts；
    - 租户隔离名册（auth/tenant-isolation-cases.ts）：每个带 :param 的用户路由一例；runner 门不在名册里，要自己加用例；
    - 待办门矩阵（open-item-doors.ts 与 spec）：新动作 OPEN_LANDING、ABANDON 和新的待办 kind 都要有门；
    - requiredAction/primaryAction 逐字节不变（4f7584649）；
    - 列表与项目页的 inFlight deepEqual（project-integration-inflight.pg.spec.ts）；
    - public-id 覆盖、迁移台账（task-judgment-data-preserved.spec.ts）、db-write-inventory、lock-order。
25. **其他约束**：
    - 别人项目的落地读口回 404（同 da1b9b0b4 之后的 promotions 读口）；
    - 新的 Go 文件里出现 sourceSessionId 字样，要加进 ALLOWED_READERS；
    - readOpenListVersion 不能因作业每 30 s 的心跳失效（open-list-version.ts:107）。
26. **发布**：项目开着 Automatic，项目分支检查一过就会自动合进 main，协调会话拦不住，所以靠拆分来保证安全，不靠「一起合入」。
    - t2core 建落地主体、landing_id 和会话行的插入逻辑（ensure），但**不启用插入**：生产上不出现任何 LANDING 会话行。它的 pg spec 在测试里直接调用 ensure 验证。
    - t2guard 装好所有守卫与普查之后，在同一个任务里启用插入。
    - T0 落到项目分支后，Automatic 会把它合进 main，借此占住修订号。

### 引用漂移（5b73f4717 → de0838eb7）
| 设计里写的 | 现在 |
|---|---|
| project-promotion.service.ts:587-612（applyCancel）、:974 | :599-627（界线在 :610）、:986 |
| project-promotion.service.ts:842-846（supersede） | :855-858 |
| project-promotion.service.ts:399-406（中位数） | :417 与 :473-494（量的是整次 CHECK_PROMOTION） |
| project-promotion.service.ts:135-139 | :136-141；候选写 task_id/session_id 在 :176-178 |
| project-promotion.controller.ts:77 | :83 |
| integration-job-relay.ts:317-318、:379-383、:965 | :318、:376-382、:966 |
| project-integration-line.ts:276-313、:285-288 | inFlight :307-345，计数 :264-268；另有 readProjectIntegrationLines :139-193 |
| project-progress.ts:323 | OpenItemAction :324-332 |
| integrate.go:977、:1004-1019、:772/:813、:346/:613、:802-845、:136-149 | :1034、:1062-1076、:829/:870、:377/:670、:859-901、:138-149 |
| runloop.go:1230-1259 | :1257-1287 |
| sessions.service.ts:8631、:4815-4825、:3190-3210 | :8859-8873、createTurn :4933、:3340-3356 |
| tasks.service.ts:11508 | remove :12246，deleteMany :12399 |
| queue.service.ts:268-273 | :332-337（provider 白名单 :340-360） |
| schema.prisma:2445-2447 | :2653-2655 |
| ProjectDetail.swift:676-689 | ProjectTaskIntegration :719 |
| ProjectPage.swift:111-201、:184 | :120-203、:196 |

### 任务调整（2026-10-07）
- T0 在 origin/main 上重做，作为修订 12。
- t1srv 拆成两个任务：
  - t1srv-a：按现行条文修撤销与接管，可立即开工；
  - t1srv：v2 协议、续租、「取消中」、release 门。
- t1run 拆出「结果重发、排空交还、自更新闸门、scratch」，由它服务判据 11。
- t4web 拆出「web 入口与 Landings 组」。
- 新增 t2list，以及效果图 03 的刷新。
- t2core 不启用会话行插入，由 t2guard 装好守卫后启用（见第 26 条）。
- 不在本项目：契约对 0378–0381、ef527a22e（J-S2/M3）、门矩阵、da1b9b0b4 的补记。建议另开，作为修订 13，排在修订 12 之后。

## 1. 旧理由为什么站不住

- **把「不启动 engine」读成了「不需要会话」。**
  - 0281 头注 "It is not a session: nothing here starts an engine"（`0281_project_integration_job/migration.sql:11`）和契约词汇表（`docs/project-integration-line-contract.md:81`）把这两件事绑在了一起。
  - G1（:28）规定的是**谁拥有判断**，G3（:34-40）规定的是**时钟能产生什么**。两条都不禁止一件机器工作有自己的地址和记录。
  - 由「入队」这个已提交事实打开的会话，不是时钟产生的。
- **「没有会话」的代价全落在 owner 身上。**
  - `inFlight` 不带任何 id（`project-integration-line.ts:276-313`），这一行点不进去。
  - 检查输出用 `CombinedOutput` 收集，只保留 16 KB 尾巴（`integrate.go:802-845`）。
  - prepare 和检查期间没有续租：唯一的回报调用在 `integrate.go:977`，只在阶段边界触发。所以 HEAD 上每个超过 10 分钟的健康检查都显示 Update unavailable（`ProjectPage.swift:184`），服务端也分不清是 runner 死了还是检查很长。
  - 失败待办指向借来的会话；如果是晋升，指向的是一个无关任务的会话（`integration-job-relay.ts:965`、`project-promotion.service.ts:135-139`）。
  - agent 没有作业的读口，34Y7 的项目指令只好让协调会话直接查生产库。
- **34Y7 就是这种情况。**
  - owner 确认过的 LAND_PROMOTION 在一个作业里跑了约 1 小时，经历多轮 TARGET_MOVED 重取（`integrate.go:37,136-149`；`claimed_at` 不随轮次重置），最后以 ERROR TARGET_MOVED 结束。
  - 每一轮发生了什么，任何地方都没有记录。
  - beta.170 把它画成名字为空的 "Landing checking 62m 58s"。
- **Orbit 早就在会话里放机器工作。**
  - 先例：EXECUTABLE 验收的 shell 轮（`executable-acceptance-round.ts:26-34`），以及 bg_run 的「输出最后移动」活性（`schema.prisma:1155-1176`）。
  - 所谓结构性障碍只约束**能被 runner 领取**的会话：`prompt` 必填（`schema.prisma:961`）、`run_event.session_id` 是必填外键（:1771-1774）、未知 provider 会落回 Claude（`session.go:242-252`）。
  - 队列只领取 `status='PENDING' AND assigned_runner_id=<runner>` 的会话（`queue.service.ts:268-273`）。runner 永远为 NULL 的会话到不了任何 runner。

## 2. 推荐方案

**一句话：每个落地主体建一个由平台驱动的「落地会话」（`session.kind='LANDING'`）。git 和检查仍由平台执行；会话只负责地址、记录、实时状态和 owner 门；判断仍归协调会话或 owner。**

以 S1 为基础，嫁接如下：

| 来源 | 嫁接内容 |
|---|---|
| S4 | 作业事实日志（取代 run_event 作为记录载体） |
| S3 | 段的规则（任务重开不结案） |
| S2 | agent 读口 |

**Session 的新定义**：Orbit 里一件可寻址、可观察的工作。它有一个 id/URL、一条按时间排序的记录、一个生命周期（Open → Completed → Trash）、一个 owner，以及一个驱动者 `kind`。

| kind | 驱动者 | 记录 | 接收轮次 | 拥有判断 |
|---|---|---|---|---|
| CONVERSATION（今天的所有会话） | engine | run_event | 是 | 是 |
| LANDING | 平台 | 所属作业的事实日志投影 | 否 | 否 |

### 落地主体与三种作业

**任务段 TASK**（标题 "Land · <任务名>"）
- 一个任务从 DONE 到成果上线的这一段。
- 段里的每一代 LAND_TASK 是一次尝试：J-T1a（DONE）、J-T1b（重跑）、J-T1d（线开始时补排）、J-T1e（补排）。尝试内的推送重取轮和接管是这次尝试下的分节。
- 任务重开**不结案**。冲突今天只能靠 `task_reopen` 返工，见 §9 的 J-T1c。
- 结案条件：LANDED、未留下工作的 ALREADY_LANDED、NOTHING_TO_LAND，或者任务被取消、删除。
- 结案后再次 DONE，开新段 "(#2)"。

**晋升 PROMOTION**
- 一个 `project_promotion` 行对应一个会话，例如 "Merge project/34Y7 → main · #7"。
- 包含 CHECK_PROMOTION 的各代（含 `decidePromotionRetry`）、owner 或 Automatic 的确认、LAND_PROMOTION 及其轮次。
- 结案于 MERGED、DECLINED、CANCELLED 或 SUPERSEDED。
- 晋升没有 task，这个会话也不需要 task。34Y7 那一次从头到尾是一个会话。

**作业**
- 仍然是「一行 = 一次尝试」，本身不是会话。
- `job.session_id` 的含义不变，仍是**源工作会话**：路由（`integration-job-relay.ts:313-316`）、base_sha、领取守卫（:336-346）、回执（:792-800）都依赖它。线上别名为 `sourceSessionId`。

### 数据（迁移 0377，以 main 为准；当前 main 最新是 0376）

- **`session.kind`**：CHECK 闭集 `CONVERSATION | LANDING`，常量默认值，只改目录。
- **`project_landing`（落地主体）**
  - 列：`subject`、`task_id`/`promotion_id`、`episode`、`session_id`、`opened_at`、`settled_at`、`settled_as`。
  - `session_id` 是**在入队事务里预生成的 uuid，不加外键**。
  - 与作业在同一事务里写入（G2），是 rank 60 的子行。
  - 部分唯一索引保证每个任务只有一个未结段，每个晋升只有一个会话。
- **`project_integration_job` 新增列**
  - `landing_id`：插入时写，之后不再更新，所以不碰 J4。不加外键，理由同 0344:7-10。
  - 另加 `round`、`step`、`step_started_at`、`output_moved_at`、`push_granted_at`。
- **`project_integration_job_event`**
  - 只追加，rank 60。
  - 与各扇作业门（入队、领取后、回报、结果、取消、放弃）在同一事务里写。
  - 按 (job_id, key) 幂等。
- **`project_integration_job_log`**
  - 检查输出按每条检查设上限，保留头和尾。
  - 不写进 run_event。run_event 是热表，`runner-api.controller.ts:5341-5343` 记着每天 868 MB 的教训。

### 会话行

- **写入方式**：由 `projects/landing-session.ts` 在入队提交后的边沿，用预生成的 id 插入，不走 `SessionsService.create`。所以没有 sign-in 预检、没有准入、没有 worktree、没有 `initial-` 轮。
- **全部为 NULL 的列**：`assigned_runner_id`、`task_id`、`context_task_id`、`parent_session_id`。
- **其他字段**
  - `starts_task_work=false` 必须显式写。列默认值是 true（`schema.prisma:984`），默认值会让它进入领取守卫。
  - `provider` 用保留 slug `orbit`。
  - `prompt` 是一行固定描述，永不投递。
  - 标题由服务端管理。
  - workspace 取源会话的。
- **`last_turn_at` 永远为 NULL。** 所以它不会成为 wiki 维护的 session_settled 事实（`wiki-maintenance.ts:250`）。

**状态列只表示容器生命周期**

| 阶段 | status |
|---|---|
| 未结 | `AWAITING_INPUT` |
| 结案 | `SUCCEEDED`（LANDED / ALREADY_LANDED / NOTHING_TO_LAND / MERGED）或 `CANCELLED`，并写 `completed_at` |

- 实时状态只来自 `landing` 视图。
- **绝不写 RUNNING 或 FAILED。** 没有 runner 的 RUNNING 行会被 reaper 判为 runner 掉线，强制终结并挂上自动重试（`reaper.service.ts:76-83, 227-282`；`session-scheduling.ts:101-103`）。
- AWAITING_INPUT、无 runner、无 task 的行，reaper 不会动（:227-231, :322）。

### §2.9 落地会话（契约新增）

- **L1 打开**：主体行和预生成的 id 在入队事务里写；会话行在提交后插入。补偿点：心跳派发、领取后、回报、结果，各调用一次 `ensure`。
- **L2 记录**：作业事件与作业门在同一事务里写。**任何作业门都不锁 session。**
- **L3 结案**：在落地事实提交后的边沿、在自己的事务里完成，锁序 session(30) → project_landing(60)。在段行锁下复核没有更新的在途尝试。补偿点同 L1。
- **L4 决定只读不抄**：「协调会话重跑」「处理中」「owner 确认」从 retry_*（0344）、handling_*（0368）、待办行和晋升行读出，符合 V0。
- **L5 隔离**：落地会话的任何字段都不进 `IntegrationJobCommand`；检查照旧在 runner 自己的环境里跑（`integrate.go:798-801`）。
- **L6 拒绝 engine 路径**：createTurn、resume、interrupt、end、rename、fork、share 一律拒绝 LANDING。队列领取、回收和 reaper 扫描都加 `kind` 过滤；用普查 spec 守住「所有按 status 扫描会话的地方都过滤 kind」。
- **L7**：不存在由时钟打开、改变或结束落地会话的路径。
- **L8**：不计入协调会话的花费保险丝。

### 要改的条文

契约 :3 要求先改条文再改代码。以下写进附录 B 修订 9，缘由写 34Y7 2026-10-04 的案例。

- **G1（替换 :28）**：
  > 不存在「平台通知协调会话去执行一个结果确定的步骤」的设计；这类步骤由平台执行（apiserver 记账，runner 跑 git 与检查）。平台的每一次集成尝试都属于一个**落地会话**（§2.9）：它是这件事的地址、记录与实时状态，由平台驱动，不启动 engine、不接收轮次、不做决定。一件待办的负责人是会话，当且仅当处理它需要判断；落地会话永远不是负责人。
- **G3 第 2 条（替换）**：
  > 已提交事实的认领、续租与重投：runner 心跳领取已入队的集成作业；运行期间每 30 秒回报并续租（J-T4）；租约过期后可被同一 runner 的另一进程重新认领。它们产生机器工作与记录这些事实的作业事件，不产生 agent 轮次、engine 或唤醒。落地会话只由入队事实打开、只由落地事实结案；心跳只补做这两条边沿欠下的写，从不因时间到了而打开、改变或结束会话。
- **G3 第 3 条（补一句）**：
  > 「静默」「租约已过」只在读时推导，不写行。
- **词汇表 :81**
  - 集成作业改为：「落地会话里的一次尝试；`session_id` 是源工作会话，`landing_id` 指所属落地 | 本身不是会话，不启动 engine」。
  - 新增「落地会话」：「`kind='LANDING'` 的会话：一个落地主体的地址、记录与实时状态 | 不能发消息、不接收轮次、不做判断」。
- **J-T4、J-T8、§2.4 :425**：
  - 回报改为周期性，应答带 `cancelRequested`。
  - 推送前必须取得推送许可；已取得许可的作业拒绝取消与放弃。
  - QUEUED 的作业在取消门的事务里直接写 CANCELLED。
- **其他条文**
  - J12 增加 `RUNNER_LOST`。
  - §2.7a（:539）改为：「只读，并链接到所属落地会话；在途尝试的 owner 门只在落地会话页头出现」。
  - V6（:1207）：主计时改为当前步骤，对比其预算与通常时长；累计时长标明轮次与接管。
- **0281 头注**：已应用的迁移不能改。由 0377 的头注取代，写明：
  > 0281 说 'It is not a session: nothing here starts an engine.' 后半句仍成立；前半句收窄——作业本身仍不是会话，它是一个落地会话里的一次尝试。
  同时用同一句话改写 `schema.prisma:2445-2447` 的模型注释。
- **其他文档**
  - `docs/session-list-projects-design.md` §2 的角色表加 `LANDING`（判定：`project_landing.session_id = s.id`），并注明本修订取代该文第 45 行的「本期不加列」。
  - `docs/project-agent-contract.md:42` 不用改：落地不写 run_event。

## 3. 各端表面

### Work overview 行

适用于 iOS/macOS 的 `ProjectLandingRow` 和 web 的 `LandingRow`。规则：
- 最多 3 行：运行中、待决定、停滞。
- 名字位永不为空。
- 整行点击进入落地会话。

```
┌ Work overview ───────────────────────────────┐
│ ⟳ Merge to main · re-checking              › │
│   project/34Y7 → main · 5 tasks              │
│   Merge check 14m 02s of 60m · usually ~38m  │
│   Round 3 of 3 · 62m 58s in all              │
│   Output 6s ago · Updated just now           │
├──────────────────────────────────────────────┤
│ ✕ Land · Ledger migration order            › │
│   Checks failed · with coordinator · 18m     │
├──────────────────────────────────────────────┤
│ +2 queued                                  › │
└──────────────────────────────────────────────┘
停滞时：
│ ◌ Merge to main · Update unavailable       › │
│   No word from runner wikova for 12m         │
│   Merge check stopped at 21m 04s (09:14)     │
```

- `inFlight` 新增的字段全部可选：`jobId`、`landingSessionId`、`taskId`、`promotionId`、`runner`、`round`、`check{name,index,count,budgetSeconds,startedAt}`、`outputMovedAt`、`progressProtocol`、`typicalMs`、`liveness`。**原提的 `landings[]`（最多 3 条）由 main 的 `inFlightJobs` 取代**（契约 §1.6）：这些可选字段同样加在它的每一项上，落地行动态行与项目 sessions 页的 Landings 组都读它。
- 旧服务端没有这些 id 时，这一行照旧不可点，并写明原因。

### 落地会话页

各端共用会话外壳，按 kind 换渲染器。

```
┌──────────────────────────────────────────────┐
│ ‹ Merge project/34Y7 → main · #7          ⋯  │
│   Run by Orbit · runner wikova · 5 tasks     │
│ ┌──────────────────────────────────────────┐ │
│ │ Re-checking · round 3 of 3               │ │
│ │ Merge check 14m of 60m · usually ~38m    │ │
│ │ Output 6s ago · Updated just now         │ │
│ └──────────────────────────────────────────┘ │
│ Merge check ✓ 47m · Ready     [Review card ›]│
│ 06:43 You confirmed the merge                │
│ ── Round 1 ────────────────────────────────  │
│ 06:44 main moved 18 commits since the check  │
│ 06:45 ▸ Merge check  ✓ 31m          [log]    │
│ 07:16 Push refused · main moved 3 commits    │
│       outside the queue (feat(macos): …) ›   │
│ ── Round 2 … ─────────────────────────────── │
│ ── Round 3 ──── ▸ Merge check (live)  ▾      │
│ ──────────────────────────────────────────── │
│ Orbit runs this landing — nothing to type.   │
│ Decisions: coordinator · Open coordinator ›  │
└──────────────────────────────────────────────┘
```

- ⋯ 菜单：Open task、Open source session、Open coordinator、Review card。owner 门按条件出现：Stop，以及租约过期后的 Abandon。
- 不提供 rename、fork、share、model 和 merge 栏。

### 会话列表不被刷屏

- **默认排除**：`GET /sessions` 默认不返回 `kind=LANDING`，带 `includeLanding=1` 才返回。
- **新事件名**：实时推送用 `landing.updated`。旧客户端把它当未知事件忽略，所以永远看不到这些行，macOS 也不会弹本地的 "Session failed" 通知。
- **项目分组上线前**：项目分组还没在 main 上实现。在那之前，落地会话**不进任何列表**，只能通过链接到达。
- **项目分组上线后**：落地会话作为 `LANDING` 角色收进项目条目。项目页加一个 Landings 组：只列未结的和有待办的，已结的折叠成 "29 landed"。
- **量级**：24 个任务的项目约有 24 个任务段，加上每个晋升候选一个会话。平铺列表里是 0 行。

### 其他入口

- **任务页**
  - web：`LandTaskStatus` 的每一代都加链接。
  - iOS：开始解码 `landTasks`（今天不解码，`ProjectDetail.swift:676-689`），并加一个 "Landing ›" 入口。
- **源工作会话**
  - 加派生标签 "Landing · checking ›" 或 "On project/34Y7 ✓ ›"，读法同 merge-repair 子会话（`sessions.service.ts:3190-3210`），需要 `(session_id, created_at)` 索引。
  - 用词是集成线，不与 session merge 混淆。
- **协调会话**
  - INTEGRATION_* 卡片加服务端决定的 `OPEN_LANDING` 动作（`project-progress.ts:323`），晋升待办上错误的 Open task session 去掉。
  - `open-item:v1` 的投递内容加 "Landing session: <id>"。这个 id 在入队时就定了，重放时逐字节一致。
  - 落地过程本身不回写进协调会话的转录。
- **晋升卡**：在 CHECKING、CONFIRMED、RECHECKING 时显示 "Watch ›"；Swift 开始解码 `recheck.typicalMs`。
- **通知**：日常落地不推送。既有的待办推送和升级推送不变，卡片链接到落地会话。
- **agent 工具**
  - `session_get` 对 LANDING 返回 kind、`landing` 视图（主体、当前尝试、阶段、轮次、检查、活性、blockingReason、待办、各代）和事件尾。
  - `session_list` 默认排除 LANDING。
  - `session_send`、`reply`、`interrupt`、`end` 返回 409 `SESSION_IS_PLATFORM_DRIVEN`，并指向协调会话。
  - 新 runner 门 `GET /runner/projects/:id/integration`，可按作业、轮次、检查分页读日志，配 MCP 工具 `project_integration_get`。它替代 34Y7 指令第 9–10 条里的生产库查询。
  - `task_get.integration`、`project_get` 的 IN_FLIGHT、`integration_retry` 的应答都带上 `landingSessionId`。

## 4. 活性与时钟

### runner 上报的事实

- prepare 和每条检查运行期间，runner 每 30 秒回报一次 `{phase, round, check, outputIdleMs, outputBytes}`。这就是 G3 已经允许的续租。
- 服务端据此写：
  - `heartbeat_at`；
  - `output_moved_at` = 收到时刻 − outputIdleMs，与 bg_run 同一模型；
  - `step_started_at`，只在步骤变化时写。
- 只在内容变化时写事件；单纯的心跳不写事件。

### 活性（读时推导，不存储）

| 状态 | 条件 | 文案 |
|---|---|---|
| LIVE | 心跳 ≤90 s，且输出在 10 分钟内动过 | Output 6s ago |
| QUIET | 心跳新，输出超过 10 分钟没动 | No output for 14m · within its 60m budget |
| SILENT | 心跳在 90 s 到 10 分钟之间 | No word from runner wikova for 4m |
| LEASE_EXPIRED | 心跳超过 10 分钟 | Lease expired · nothing was pushed · Abandon |
| LEGACY | runner 未声明 `integration-progress/v2` | Reports only between steps（检查期间不推断静默） |

### 时钟（V6）

- **主数字**：当前步骤，对比其预算和通常时长。通常时长取同一项目、同一检查名最近几次通过时长的中位数，由 `project-promotion.service.ts:399-406` 推广而来。
- **次要数字**：从首次领取起的累计时长，标明轮次。接管时写 "Taken over 09:31 · first started 09:02"，不再静默重置。
- **本地时钟**只在 LIVE 或 QUIET、且读数不超过 90 s 时走；否则冻结并写明原因。
- **进展的证明**是两个服务端事实："Output Ns ago" 和 "Updated"。什么都没发生时它们只会变大，所以无法伪造进展。

### 不加的东西

- 不加 sweeper，不加作业截止时间，不加任何会写行的时钟。
- 卡住的尝试只由事实结束：同一 runner 的新进程接管，或者 owner、协调会话执行 Abandon。
- 停滞时给 owner 发推送不在本期。如果要做，作为 G3.1 的扩展另行讨论。

## 5. 控制与权限

| 门 | owner | 协调会话 | 落地会话自己 |
|---|---|---|---|
| 查看 | UI | `session_get`、`project_integration_get` | — |
| 发消息 | 无（不接收轮次） | 无 | — |
| 叫停在途尝试（取得推送许可前） | LAND_TASK 用新的用户门；晋升沿用 Cancel（`project-promotion.controller.ts:77`） | 无（任务重开走 J-T8） | — |
| 放弃（仅限 LEASE_EXPIRED） | 用户门 | `integration_abandon`（门槛同 J-T1b） | — |
| 重跑 | 先用 Ask the coordinator again；之后补上契约已写的 owner 门（:368），需要放宽 0344「四列同有同无」的约束 | `integration_retry`，不变 | 从不自己重跑（J5） |
| 确认或拒绝合入 main | 卡片，不变 | — | — |
| 处理待办 | 既有的门 | 既有的门 | 从不拥有待办 |
| Pin / Trash | 结案后才能 Trash | — | — |

**推送许可**
- runner 在 `integrationPush` 之前（`integrate.go:346`、`:613`）做一次同步回报 `{gate:true}`。
- 服务端只在 `cancel_requested_at IS NULL` 且领取仍有效时，用 CAS 写入 `push_granted_at`。
- runner 拿到许可才推送，且必须在 120 s 内开始。
- 取消和放弃改为以 `push_granted_at` 为界，替代今天按尽力而为的 `phase='PUSH'` 判断（`project-promotion.service.ts:595-598`）。
- 放弃要求 10 分钟静默，远长于 120 s 的许可窗口，所以不会出现已经拿到许可的推送被放弃的情况。

**叫停**
- QUEUED 的作业直接写 CANCELLED。
- RUNNING 的作业写 `cancel_requested_at`；runner 在下一次回报（不超过 30 s）收到后，杀掉检查的进程组，回报 CANCELLED。
- 任务段不结案，显示为 "Stopped by you · not landed"。

**放弃**
- 写 ERROR/RUNNER_LOST，并把 `claim_generation` 加 1。之后迟到的结果会收到 409 STALE_CLAIM。
- 按 §4.3 开待办。

**通用规则**：owner-only 的门照旧拒绝带 acting session 的请求（契约 :175、:635、:1118）。

## 6. 失败与判断在哪里发生

- **判断不在落地会话里做。**
  - CONFLICT、CHECK_FAILED、ERROR 照旧在结果事务里开 INTEGRATION_* 待办：Automatic 下归协调会话（通过 NEXT_TURN），否则归 owner。X-E1 升级不变。
  - 落地会话内嵌显示这张待办：负责人、等待时长、何时交给 owner，并链接到做判断的地方。
  - 判断的结果（重跑理由、处理中、已处理）作为带署名的条目，记在**同一个**落地会话里。
- **CHECK_FAILED**：协调会话调用 `integration_retry`，下一代出现在同一会话里（"Coordinator re-ran it: main was red at …"）。落地成功后待办标为 HANDLED（H2）。
- **CONFLICT**
  - `integration_retry` 拒绝 CONFLICT，而 J-T1c 没有实现。所以出路是：`task_reopen`，在任务的工作会话（CONVERSATION）里返工，再次 DONE；新一代仍在**同一段**里。
  - 如果是 MAIN_SYNC 冲突，M2 会挡住其他任务。它们的落地会话显示 "Waiting on the main-sync conflict in Land · X ›"。
- **TARGET_MOVED（34Y7）**
  - 每一轮是一节。推送被拒时写明 main 新来了哪些提交，以及哪些来自队列外：看同一 serial_key 上有没有 LANDED 作业能解释这些提交。
  - 结果为 ERROR 时开待办；协调会话用 `decidePromotionRetry` 发起的第 2 代检查，仍在这个晋升会话里。
- **runner 失联**：进入 LEASE_EXPIRED 后，要么同一 runner 的新进程接管（新开一节，标 "Taken over"），要么执行 Abandon，得到 RUNNER_LOST 并开待办。
- **待办 payload 新增**：`landingSessionId`、轮次、`upstreamMovedBy`。这些都是平台测到的事实，不是诊断。

## 7. 为什么不选其它变体

- **S1 原样不取。** 它有四处问题：
  - 把检查输出写进 run_event 热表；
  - 给没有 runner 的行投射 RUNNING 或 FAILED，会被 reaper 判为掉线、强制终结并挂上自动重试；
  - 每扇作业门都要先锁 session；
  - 冲突返工被 CALLED_OFF 切成两个会话，而且还依赖没有实现的 J-T1c。

  保留了它的 kind、不加外键、推送许可和 opt-in 列表，替换掉上面这几处。
- **不选 S2（由 agent 落地）。**
  - 让 engine 执行结果确定的步骤，正是 G1 仍然保留的那一半所禁止的。
  - 每次落地都要付 engine 费用，并在 engine 延迟期间占着 J1。
  - `landing_exec` 用 runner 的 git 凭据执行 agent 选的命令，可以绕过 J2 和 M7。
  - 它的「失联由 reaper 收尾」不会触发：检查期间会话是 AWAITING_INPUT，而掉线只对 RUNNING 致命（`session-scheduling.ts:101-103`）。
  - 外键 SET NULL 会撞上作业的终态守卫。
- **不选 S3（一个会话、两个驱动者）。**
  - 它在领取语句里切换驱动者并写 session 租约，违反了「领取只碰作业表」（`lock-order.ts:145-153`）。
  - 同一份转录有两个 seq 权威。
  - 每条线一个的「合入 main」会话永不结案。
  - engine 接入留作单独的决定（§10）。
- **不选 S4（宿主会话里嵌落地块）。**
  - 落地没有自己的会话，这正是 owner 否决的立场。
  - 地址随协调会话的指针漂移；没有协调会话时无处可放。
  - 「在原会话修复」需要给 G6 开复活例外。

  它的事件表、日志表、取消修复和源会话标签已经嫁接进来。

## 8. 分期落地

0. **契约修订 9（只改文档）。**
   - `docs/project-integration-line-contract.md`：G1、G3、词汇表、J-T4、J-T8、§2.4、§2.7a、J12、新增 §2.9、V6、附录 B。
   - `docs/session-list-projects-design.md`。
   - `schema.prisma` 的模型注释。
1. **活性与围栏。不依赖会话，先修真缺陷。**
   - runner：`src/runner-go/integrate.go` 加 30 s 回报、可杀的检查进程组、推送许可、结果缓存重发；`runloop.go:1230-1259` 排空时交还已领取未开始的作业；`transport.go` 声明能力 `integration-progress/v2`。
   - 服务端：`integration-job-relay.ts` 让回报续租，并在应答里带 `cancelRequested` 和许可；改 `project-promotion.service.ts` 的 applyCancel；迁移加作业列。
   - 读模型：`project-integration-line.ts` 和 `src/shared/src/project-progress.ts` 加 inFlight 字段。
   - 客户端：`ProjectPage.swift` 和 `ProjectPanoramaHeader.tsx` 的活性规则，两端文案在同一个提交里改（`ProjectPageCopyParityTests`）。
   - agent 读口：`runner-projects.controller.ts` 和 `src/runner-go/mcp.go` 加 `project_integration_get`。
2. **落地会话核心。**
   - 迁移：`session.kind`、`project_landing`、`job.landing_id`、`project_integration_job_event`。
   - 新文件：`src/apiserver/src/projects/landing-session.ts`。
   - 入队点：`project-integration-job.ts`、`project-integration-retry.ts`、`project-promotion.service.ts`。
   - 排除：`queue/queue.service.ts`、`realtime/reaper.service.ts`，以及 `sessions.service.ts` 里的拒绝。
   - 读接口：`GET /sessions/:id` 的 `landing` 视图，列表的 `includeLanding`。
   - 登记与测试：`common/db-write-inventory.ts`、`common/lock-order.ts`、锁序 spec、kind 普查 spec。
   - 客户端：web 新增 `LandingSessionView`，WorkspaceView 按 kind 路由；OrbitKit 解码，iOS/macOS 加落地会话页；Work overview 行可点；任务页、晋升卡、OpenItemCard 加链接。
3. **检查输出。**
   - 用管道替换 `CombinedOutput`（`integrate.go:813`），16 KB 尾巴照旧保留。
   - 输出分块上传到 `POST /runner/integration-jobs/:id/output`，带租约围栏。
   - 写入 `project_integration_job_log`，设上限，并对 runner 自己的秘密脱敏。
   - 兑现契约里的 VIEW_LOG（:896、:1247）。
4. **门与列表位置。**
   - LAND_TASK 的叫停门，以及 owner 重跑门（需要放宽 0344 的 CHECK）。
   - Abandon 和 `integration_abandon`（同步更新 `cli_mcp_parity_test.go`），J12 加 `RUNNER_LOST`。
   - 源会话上的落地标签。
   - 项目分组上线后，加 `LANDING` 角色和 Landings 组。

## 9. 顺带发现、无论选哪个方案都该修的缺陷

1. **【高】晋升 Cancel 在运行中不可靠。**
   - runner 只在作业开头读一次 cancel（`integrate.go:107-110`）。
   - 回报的应答被丢弃（`:977`），服务端也只回 `{accepted:true}`（`integration-job-relay.ts:560-595`）。
   - `applyCancel` 立刻把晋升写成 CANCELLED（`project-promotion.service.ts:587-612`），之后的结果对它返回 null（:974）。
   - 推断：已取消的合入仍可能推到 main，并且没有收据（未实测）。契约 :343 和 :425 的写法与代码不符。
2. **【高】删除被作业的终态守卫卡死。**
   - `job.session_id` 和 `task_id` 都是 ON DELETE SET NULL（0281 migration.sql:101-104）。外键置空动作本身是一次 UPDATE，会被 BEFORE UPDATE 守卫（:144-157）拒绝。
   - 我在一次性的 PG16 容器里复现过：整条 DELETE 回滚。
   - `purgeTrash` 是单条 `deleteMany`（`reaper.service.ts:139`），一个被引用的会话就会让整批回收失败。永久删除（`sessions.service.ts:8631`）和任务删除（`tasks.service.ts:11508`）也一样。
   - 修法：改成不带外键的历史引用（同 0344:7-10 的做法）。
3. **【中高】检查期间不续租。** 只在阶段边界回报（`integrate.go:977`），所以健康的长检查显示 Update unavailable（`ProjectPage.swift:184`）。
4. **【中】J-T1c 没有实现，但 J5 依赖它（契约 :345、:370）。**
   - 入队点只有 `project-integration-job.ts:580,637,799,877,1028`，`turnComplete` 里没有从 branchSha 到入队的路径。
   - 要么实现它，要么从 J5 里删掉。
5. **【中，推断】任务重开或取消时不会叫停 LAND_TASK。**
   - 作业 `cancel_requested_at` 的唯一写者是晋升的 applyCancel（`project-promotion.service.ts:595-600`），领取也不看任务状态（`integration-job-relay.ts:312-399`）。
   - 推断：已取消任务的排队落地仍会被执行。
6. **【中】已请求取消的 QUEUED 作业永远计为在途。** 领取会跳过它（`integration-job-relay.ts:318`），但计数只按状态统计（`project-integration-line.ts:285-288`）。
7. **【中】结果回报重试 5 次后就丢弃**（`integrate.go:1004-1019`），契约 J-S8 要求缓存并重发（:423）。
8. **【中】排空时，已领取但未开始的作业滞留 RUNNING**（`runloop.go:1230-1259`），并占着跨项目的 J1 槽。
9. **【中低】晋升失败待办指向无关会话**（`integration-job-relay.ts:965`、`project-promotion.service.ts:135-139`）。
10. **【中】直接推到 main 的提交不与集成队列串行。** J1 只管作业，`mergeLock` 只在进程内（`worktree.go:1196-1198`）。这是 34Y7 的根因；落地会话只能让它可见。
11. **【低】临时 worktree 的位置与契约 §2.4 不符**（`integrate.go:127`）。注释说 GC 能识别它的前缀（:30-32），实际不能（`worktree.go:2516-2518`）。

## 10. 需要 owner 拍板（2026-10-04 已全部定下，见 §0 第 6、14、16 条；判断点本期不接 engine）

1. **晋升落地会话按什么粒度建？**
   - 推荐：每个候选一个会话。owner 确认的是一个具名候选，它会结案；被取代的候选只计入折叠的数量。
   - 另一种：每条线一个会话。行数更少，但永不结案，实际成了日志。
2. **判断点要不要接入 engine？**
   - 推荐：本期不接。判断归协调会话或 owner，修复走 `task_reopen`。
   - 以后如果要接，二选一：
     - S4 的「在原会话修复」：需要给 G6 加一条复活例外。
     - S3 的「显式接入」：由协调会话或 owner 带上授权和理由发起，计入 F1，上限 2 次，做成独立的子会话。
3. **直接推到 main 的提交，要不要与 LAND_PROMOTION 串行？**
   - 选项一：LAND_PROMOTION 运行期间，让 session merge 到 main 的操作也走同一个 serial_key 排队。
   - 选项二：推送第一次被抢就把候选交回，不再在作业内重跑两轮完整检查。
   - 选项三：维持现状，只靠落地会话让问题可见。


## 附：嫁接来源

- S4：新建 project_integration_job_event（只追加，rank 60，与每扇作业门同一事务写入），检查输出另放 project_integration_job_log（每条检查有上限，保留头和尾）。两者都不进 run_event 热表，也不需要任何作业门去锁 session。
- S4：取消一个 QUEUED 作业时，在门的事务里直接写 CANCELLED，不再永远计入在途。
- S4：源工作会话上加派生的落地标签（"Landing · checking ›" 或 "On project/34Y7 ✓ ›"），并为 job 加 (session_id, created_at) 索引。
- S4：推送被拒时写明 main 被谁推进了（movedBy：队列外，或某个作业）；同时纠正 S1/S2/S3 都依赖的 J-T1c，它并没有实现。
- S3：任务段在任务重开（J-T8）时不结案，冲突返工后的新一代仍记在同一段里。
- S3：Work overview 最多显示 3 行（运行中、待决定、停滞），名字位永不为空。
- S3：服务端决定的 OPEN_LANDING 卡片动作，替换晋升待办上指向无关会话的 "Open task session"。
- S3：ProjectAttention 只把真正在跑的落地算作 platform working。
- S2：新增 runner 门 GET /runner/projects/:id/integration，配 MCP 工具 project_integration_get，替代协调会话对生产库的直接查询。
- S2：行上的主数字改为当前步骤对比其预算和通常时长；累计时长退为次要，并标明轮次与接管。
- S2：把 integrateOnce/promoteOnce 拆成步骤函数，让周期回报和推送许可只有一处实现。
- S1 保留：session.kind 鉴别列；job 上的落地链接不加 FK；推送许可 push_granted_at；列表 opt-in（includeLanding）加新的实时事件名；为旧 runner 保留 LEGACY 活性；落地会话从不拥有待办。
- 评审意见落实：落地会话 id 在入队事务里预生成，待办内容和 NEXT_TURN 重放时逐字节稳定；status 只在 AWAITING_INPUT（未结）和 SUCCEEDED/CANCELLED（结案）之间取值，实时状态只来自 landing 视图。
