# Watch 灰度与回退运行手册

**状态**：任务「P3：迁移后台监控、灰度发布并建立回退路径」的产物。领域语义以 [`watch-contract.md`](./watch-contract.md) 为准；
保护机制、指标和死信处置见 [`watch-operations.md`](./watch-operations.md)。本文只讲四件事：怎么逐步打开原生 Watch，
怎么判断能不能继续放量，出了问题怎么关，已有的等待和数据怎么处理。

| 来源 | 位置 |
| --- | --- |
| 开关与拒绝 | `src/apiserver/src/watches/watch-rollout.ts`（`WatchesService`、evaluator、交付 worker、claim 都从这里读） |
| runner 侧 | `src/runner-go/watch_rollout.go`（引擎环境 `ORBIT_WATCHES`）、`src/runner-go/hook_bg_guard.go`（轮询拦截） |
| 测试 | `src/apiserver/src/watches/watch-rollout.spec.ts`、`watch-rollout.pg.spec.ts`、`src/runner-go/watch_rollout_test.go` |
| 演练 | 第 9 节 |

## 0. 一页结论

1. **一个开关**：apiserver 的环境变量 `ORBIT_WATCHES`，取值 `on`（默认）、`canary`、`drain`、`off`。改值就是重启 apiserver，
   不跑迁移，也不用发 runner。
2. **对没开 Watch 的账号，服务端就像没有 Watch**：新建、编辑、恢复、死信重投一律回 `404 WATCHES_DISABLED`，什么都不写；
   读、暂停、取消、release 照常。已发布的 runner（含 0.1.159）把这个 404 读成「没有 watch 门」，`session_create(wait)`
   退回迁移前的内联等待。
3. **drain 让已有的 watch 跑完，off 连评估和交付都停**。off 期间成立或到期的 watch 原地不动，重新打开后第一轮补上，每个恰好唤醒一次。
4. **新 runner 不再让 agent 轮询 Orbit 自己的工作**：一条命令里既读 Orbit 的 task/session、又 sleep，就被 bg-guard 拒绝，并指向
   `task_await` / `session_await`。构建、测试、dev server、等 CI 不受影响；按路径运行的脚本不打开，也不迁移。
5. **回退顺序**：`drain` → `off` → 回滚镜像。三步都不动数据库结构。

## 1. 开关

| `ORBIT_WATCHES` | 谁能新建、编辑、恢复、重投 | 读、暂停、取消、release | evaluator 与交付 worker | claim 里的 `watchesDisabled` |
| --- | --- | --- | --- | --- |
| `on`（默认） | 所有账号 | 所有账号 | 运行 | 不带 |
| `canary` | `ORBIT_WATCHES_CANARY_OWNERS` 列出的账号；其余账号同 `drain` | 所有账号 | 运行 | 名单外的账号带 |
| `drain` | 没有 | 所有账号 | 运行：已有 watch 照常成立、到期、交付 | 所有账号带 |
| `off` | 没有 | 所有账号 | 本 replica 不启动 | 所有账号带 |

- `ORBIT_WATCHES_CANARY_OWNERS`：逗号分隔的账号 id，uuid 或 public id（`GET /api/users/me` 的 `publicId`）都行，只在 `canary` 下读。
- 读不懂的取值按 **`off`** 处理（宁可停得多），启动日志 `[WatchRollout]` 打 WARN。`canary` 却一个账号都没列，等于 `drain`，同样打 WARN。
- 被拒的写入：HTTP 404，body 形如
  `{"code":"WATCHES_DISABLED","message":"Watch is not on for this account on this Orbit server (ORBIT_WATCHES=drain), so no watch was made. Watches made before can still be read, paused and cancelled."}`。
  用 404 是有意的：没有 Watch 的服务端给的就是 404，所以已发布的客户端不用升级，就会走对的降级路径（第 2 节）。
- 指标（`GET /api/metrics`，读本进程的环境，不读库，按 replica 各自报）：

  | 指标 | 含义 |
  | --- | --- |
  | `orbit_watch_rollout{mode}` | 当前模式为 1，其余模式为 0 |
  | `orbit_watch_rollout_canary_owners` | canary 名单里的账号数；非 canary 为 0 |
  | `orbit_watch_rollout_refusals_total{write}` | 因开关被拒的写入，`write` = `create` / `update` / `resume` / `redrive` |

**什么时候生效**

- apiserver：重启完成的那一刻。写入门、claim 标志、两个 worker 是否启动，都在启动时决定。
- 引擎一侧：会话**下一次 spawn 引擎**时（新会话，或 warm 引擎被回收后再次使用）。runner 把 claim 的标志写进引擎环境
  `ORBIT_WATCHES=on|off`，引擎启动的 `orbit mcp`、`orbit` CLI、bg-guard hook 都读它：
  - `off`：MCP 不列 `watch_*` / `task_await` / `session_await`，`orbit capabilities` 也不列；系统提示词里不带「用 task_await 等」那一段；
    `session_create(wait)` 与 `orbit session create --wait` 按迁移前的方式内联轮询，没等到就在 `watch` 里带
    `code: WATCHES_DISABLED`；bg-guard 不拦轮询。
  - `on`：上面这些都在，bg-guard 拦轮询（第 4 节）。
- **切换之前已经 spawn 的引擎保持原样**，直到它被回收（warm TTL 最长 4 小时）。它调 watch 工具会被服务端拒绝，工具回话写明
  「Watch 没开，不要退回轮询」。想让所有会话立刻按新值走，只能等引擎重新 spawn；不要为此重启 runner，那会杀掉会话的后台作业。

**在 Compose 部署上怎么改**：`docker-compose.yml` 的 apiserver 已经透传这两个变量（默认 `on` 与空）。

```bash
# 部署目录的 .env
ORBIT_WATCHES=canary
ORBIT_WATCHES_CANARY_OWNERS=<账号 public id>

docker compose up -d apiserver    # 只重建 apiserver；web、postgres、gateway 不动
```

重建 apiserver 会断开所有会话与 runner 的连接（runner 自己重连，排队的 turn 照常接上）。线上做之前按部署规程拿到批准。

## 2. 新旧客户端并存

同一个 apiserver 上可以同时跑三代 runner 以及 Web / macOS / iOS。runner 三代在第 9 节的演练里逐格验证过。

| 客户端 | Watch 开着的账号 | Watch 没开的账号（canary 名单外、drain、off） |
| --- | --- | --- |
| 本任务之后的 runner | 引擎 `ORBIT_WATCHES=on`；列出 watch 工具；`session_create(wait)` 由 watch 托底，内联返回后 release；拦轮询 | 引擎 `ORBIT_WATCHES=off`；不列 watch 工具；内联等待，不建 watch；不拦轮询 |
| 0.1.159（源码 `1471214ac`） | 列出 watch 工具；wait 由 watch 托底；不拦轮询 | 仍列出 watch 工具，调用得到「this Orbit server has no watch door … Upgrade the Orbit server; until then do not fall back to polling」——说要升级服务端并不准确，但它同时说了不要轮询；`session_create(wait)` 内联等待，不建 watch |
| Watch 之前的 runner（`1f42ef54` 及更早） | 没有 watch 工具；内联等待 | 同左，任何模式下都一样 |
| Web / macOS / iOS | 照常 | 列表、详情、暂停、取消照常；新建、编辑、恢复、重投失败时显示服务端的 message |
| apiserver 回滚到 `1471214ac` | 那一版没有开关，所有账号等同 `on` | — |

结论：先部署 apiserver 还是先发 runner，顺序无所谓；runner 新旧混跑也安全。轮询拦截只跟着新 runner 生效。

## 3. 旧 wait 与原生 Watch 的行为对照

| 场景 | 迁移前（轮询） | 原生 Watch |
| --- | --- | --- |
| Agent 等若干 Task 结束 | 自己写 `sleep` 加 `orbit task get` / `task_get` 的循环：前台 Bash 占着 turn；或者 Monitor、`bg_run` 脚本、ScheduleWakeup、宿主上的 `systemd-run` 单元 | 一次 `task_await {taskIds}`，然后结束本轮；条件成立时经正常队列起一个唤醒 turn，载荷带原因与快照 |
| Agent 等子会话回话 | `session_create(wait)` 在 MCP 进程里轮询，顶层约 10 分钟；超时就返回最后看到的状态，等待意图随之丢失 | 先建 watch 再内联等；等到了就 release，答案只到达一次；超时或断线时把 watch 交回，子会话 settle 时唤醒调用方 |
| 等待期间引擎被回收、runner 重启 | 前台轮询与 Monitor 随引擎一起死；ScheduleWakeup 丢失；`bg_run` 作业活过引擎回收，但 runner 重启会杀掉它 | watch 在服务端，两者都不影响；runner 回来后照常投递 |
| apiserver 重启 | 轮询报错，是否重试取决于脚本 | 数据库是事实源，重启后第一轮补上；不重复唤醒 |
| 占用 | 前台轮询占 turn 和 runner slot；Monitor、`bg_run` 占一个进程 | 等待期间不占 turn、slot 和进程，只占一行 watch |
| 可见性 | 只在 transcript 和脚本日志里 | Web / macOS 的 Following 页、会话上的「Waiting on a watch」、`/api/metrics` |
| 怎么结束 | 取决于脚本自己的逻辑；出错时常常静默空转 | MATCHED、EXPIRED、REVOKED、UNRESOLVABLE 各起一个 turn；CANCELLED 不唤醒；交付失败有死信 |

## 4. 现有的轮询模式与拦截规则

**线上盘点**（只读，2026-09-14，本机部署最近 30 天的 `tool_call`）

- 调用次数：Bash 155,090；`task_get` 1,531；`bg_run` 993；Monitor 309；`session_get` 185；ScheduleWakeup 79。
  `task_await`、`session_await`、`watch_create` 为 0：Watch 当天才上线，还没有 agent 用过（`watch` 表 0 行）。
- 同一条命令里既读 Orbit 的 task/session、又 sleep 的：Bash 1,748 条，Monitor 14 条，`bg_run` 3 条。随机抽 40 条，39 条确实是在等
  Orbit 的工作：
  - 最多的是每次调用跑一句 `sleep 25; orbit session get <id>`，大约一分钟一次地反复调；
  - 其次是 `for … do … sleep … done` 循环里读 `orbit task get`，或者经 `docker exec orbit-postgres psql` 查 `task` / `session` 表；
  - Monitor 里跑的也是这样的循环；
  - 1 条是误报：一段 Python heredoc 在改一个脚本文件的文本，那段文本恰好两样都有。
- 脚本型等待：Bash 与 `bg_run` 调 `watch-task.sh` / `watch-tasks.sh` 共 32 次；宿主上正跑着 2 个 `systemd-run` 单元执行
  `watch-tasks.sh`（协调会话的自唤醒，处理方式见第 8 节）。

**拦截规则**（`hook_bg_guard.go`；只在会话的 `ORBIT_WATCHES` 不是 `off` 时生效）

- 管这三个工具：Bash（前台、后台都管）、Monitor、`mcp__orbit__bg_run`。
- 同一条命令里两半都出现才拒绝：
  - **读 Orbit**：`orbit … task|session|tasklist|task-list|project get|list`；或 `/api/tasks`、`/api/sessions`、`/api/runner/…` 下的这两类路由；
    或者 `psql`、命令里有 `orbit`、且 `FROM/JOIN task|session|conversation_turn|task_progress`；
  - **等待**：`sleep <数字或变量>`、`time.sleep(`、`watch -n`。
- 拒绝文案告诉 agent：改用 `task_await` / `session_await`（其他条件用 `watch_create`），然后结束本轮；单次读取可以，真实的后台工作继续走 `bg_run`。
- 不拦（演练的 `hook-probe.txt` 逐条核过）：单次 `orbit task get`；`orbit task await`；`sleep 30 && gh run view`（等 CI）；
  dev server、构建、测试；`bash scratch/watch-tasks.sh …`（按路径运行的脚本不打开）。
- 已知漏网：Python 用列表形式调用 `subprocess.run(['orbit', 'task', 'get', …])`；没有 sleep 的紧循环；脚本文件；codex / opencode / kimi 会话
  （它们没有接这个 hook）；0.1.159 及更早的 runner。hook 是策略，不是门禁：它挡掉常见写法，把 agent 引向正确的工具，漏网的照样能跑。

**复查 SQL**（与拦截规则同口径；周期性地跑，看迁移进度）

```sql
-- 最近 7 天：各工具里「读 Orbit 并 sleep」的命令数
WITH c AS (
  SELECT name, coalesce(input->>'command', '') AS cmd FROM tool_call
   WHERE started_at > now() - interval '7 days' AND name IN ('Bash', 'Monitor', 'mcp__orbit__bg_run')
)
SELECT name,
       count(*) FILTER (WHERE
         (cmd ~* '\morbit\M[^|;&\n]*\s(task|session|tasklist|task-list|project)\s+(get|list)\M'
          OR cmd ~* '/api/(runner/)?(tasks|sessions)\M'
          OR (cmd ~* '\mpsql\M' AND cmd ~* 'orbit' AND cmd ~* '\m(from|join)\s+"?(task|session|conversation_turn|task_progress)\M'))
         AND cmd ~* '(\msleep\s+[0-9$({"'']|time\.sleep\s*\(|\mwatch\s+(-[a-z]+\s+)*-n\M)') AS polls,
       count(*) AS total
  FROM c GROUP BY 1;

-- 最近 7 天：原生等待的调用数
SELECT name, count(*) FROM tool_call
 WHERE started_at > now() - interval '7 days'
   AND name IN ('mcp__orbit__task_await', 'mcp__orbit__session_await', 'mcp__orbit__watch_create')
 GROUP BY 1;

-- 最近 7 天：被 bg-guard 拒绝的轮询（被拒的调用记为 is_error，output 里是拒绝文案；演练 G2 实测）
SELECT name, count(*) FROM tool_call
 WHERE started_at > now() - interval '7 days' AND is_error
   AND output::text LIKE '%Orbit holds that wait on its server%'
 GROUP BY 1;
```

## 5. 指标门槛

**放量门槛**（`canary` → `on`）：下面每条都满足，持续观察至少 24 小时，且 canary 账号累计至少 20 次有效唤醒，再放量。
数值是首轮灰度的保守起点，第 9 节有演练实测值作参照；有了线上数据后收紧。

| # | 看什么 | 门槛 | 怎么读 |
| --- | --- | --- | --- |
| G1 | 严重告警 | `orbit_watch_alert_firing{severity="critical"}` 在观察窗口内一直为 0 | metrics |
| G2 | 评估与交付滞后 | `orbit_watch_evaluation_lag_seconds`、`orbit_watch_delivery_lag_seconds` 一直小于 30（告警线是 120） | metrics |
| G3 | 交付失败 | `orbit_watch_dead_letters_recent{window="24h"}` 在 `ATTEMPTS_EXHAUSTED`、`LEASE_EXPIRED`、`TURN_REFUSED`、`OTHER` 上为 0 | metrics，或 `GET /api/watches/deliveries` |
| G4 | 唤醒有人接 | 下面的 SQL 返回 0 行：唤醒 turn 排队超过 30 分钟，观察者却在等输入 | SQL |
| G5 | 每次有效唤醒的成本 | 1 小时窗口内，求值次数 / 有效唤醒 ≤ 20，交付尝试 / 有效唤醒 ≤ 2 | watch-operations.md §3.2 的 PromQL |
| G6 | 创建可靠 | `orbit_watch_refusals_total{code="WATCH_QUOTA_EXCEEDED"}` 不增长；apiserver 日志里没有 `P2028` | metrics、日志 |
| G7 | 采用 | canary 账号里新 runner 会话的轮询数（第 4 节 SQL）为 0，await 调用大于 0 | SQL |

```sql
-- G4：排队超过 30 分钟、没人接的唤醒
SELECT t.session_id, t.client_turn_id, now() - t.created_at AS waiting
  FROM conversation_turn t JOIN session s ON s.id = t.session_id
 WHERE t.client_turn_id LIKE 'watch:%' AND t.status = 'PENDING'
   AND t.created_at < now() - interval '30 minutes' AND s.status::text = 'AWAITING_INPUT';
```

**回退触发**（任一条出现就执行第 7 节对应的步骤）

| 触发 | 动作 |
| --- | --- |
| 任一 critical 告警持续超过 5 分钟 | R1 `drain` |
| 同一次等待把会话唤醒了两次，或唤醒了不该醒的会话 | R2 `off`，先止损，保留现场排查 |
| `WAKE_STORM_SUPPRESSED` / `WAKE_BUDGET_EXHAUSTED` 死信持续出现，watch-operations.md §7.5 止不住 | R2 `off` |
| 数据库压力：watch 相关查询在 `pg_stat_activity` 里排队，apiserver 日志成片出现 `P2028` / `53300` | R2 `off` |
| 用户报 bg-guard 误拦了正常工作 | 先不动开关：hook 只影响新 runner 上的 agent，换一种写法即可；持续误拦再 R1（会同时收起 watch 工具） |
| 与 Watch 无关的 apiserver 回归 | R3 回滚镜像 |

## 6. 灰度步骤

**第 0 步：前置检查（只读）**

```bash
# 镜像带开关（≥1）
docker exec orbit-apiserver sh -c 'grep -c WATCHES_DISABLED /app/src/apiserver/dist/watches/watch-rollout.js'
# Watch 的迁移都已应用
docker exec -i orbit-postgres psql -U orbit -d orbit -tAc \
  "SELECT count(*) FROM _prisma_migrations WHERE migration_name ~ '^02(59|6|7)' AND finished_at IS NOT NULL"
# 基线
curl -s -H "Authorization: Bearer $TOKEN" "$ORBIT/api/metrics" \
  | grep -E '^orbit_watch_(rollout|alert_firing|watches|evaluation_lag|delivery_lag|gauges_up)'
```

再跑一次第 4 节的两条 SQL，记下基线。

> 2026-09-14 的线上状态：apiserver 已带 Watch（迁移 0271 于 12:13Z 应用），没有这个开关，等同 `on`；`watch` 表 0 行。
> 部署带开关的镜像并保持默认 `on`，行为不变。要不要先收窄到 `canary` 由 owner 决定。

**第 1 步：canary**

1. `.env` 设 `ORBIT_WATCHES=canary`、`ORBIT_WATCHES_CANARY_OWNERS=<账号>`，执行 `docker compose up -d apiserver`。
2. 确认：
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$ORBIT/api/metrics" | grep '^orbit_watch_rollout'
   # orbit_watch_rollout{mode="canary"} 1，orbit_watch_rollout_canary_owners 1
   docker logs orbit-apiserver 2>&1 | grep WatchRollout
   # Watch is canary for 1 account(s)
   ```
3. 用名单外账号的 token 建一个 watch，应该得到 404 `WATCHES_DISABLED`；名单内账号应该得到 201。
4. 在新 runner 上新开一个会话，确认引擎环境：`tr '\0' '\n' </proc/<claude 进程>/environ | grep ORBIT_WATCHES`。名单内为 `on`，名单外为 `off`。

**第 2 步：观察**第 5 节门槛 G1–G7。

**第 3 步：放量**：`ORBIT_WATCHES=on`（或删掉这一行），`docker compose up -d apiserver`，确认 `orbit_watch_rollout{mode="on"} 1`。

**第 4 步：runner 发版**：新 runner 带来工具开关和轮询拦截，和 apiserver 谁先谁后都行。发版后用第 4 节的 SQL 看轮询数下降、await 调用上升。

## 7. 回退步骤

### R1 drain（默认先做这一步）

1. `.env` 设 `ORBIT_WATCHES=drain`，`docker compose up -d apiserver`。
2. 确认：
   - `orbit_watch_rollout{mode="drain"} 1`，日志里有 `Watch is drain`；
   - 建 watch 得到 404 `WATCHES_DISABLED`，`orbit_watch_rollout_refusals_total{write="create"}` 增长；
   - 已有的 watch 照常成立和交付：`orbit_watch_effective_wakes_total` 照常增长；
   - 此后新 spawn 的引擎 `ORBIT_WATCHES=off`；会话、任务、`session_create(wait)` 照常。
3. 收尾：live watch 在各自的 TTL 内结束（默认 24 小时，最长 30 天）。要提前结束，用 owner 的 token 列出
   `GET /api/watches?state=ACTIVE` 与 `?state=PAUSED`，逐个 `POST /api/watches/:id/cancel`。取消不会唤醒观察者，先告诉在等的会话。

### R2 off（Watch 本身出问题：风暴、错误唤醒、数据库压力）

1. `.env` 设 `ORBIT_WATCHES=off`，`docker compose up -d apiserver`。
2. 确认：`orbit_watch_rollout{mode="off"} 1`；日志两行 `this replica evaluates no watch` 与 `this replica delivers no watch wake or notification`；
   `orbit_watch_gauges_up` 仍为 1。
3. 预期的副作用：
   - `orbit_watch_evaluation_lag_seconds` 随时间上涨，`WatchEvaluationLagging` 会响。关着 Watch 的这段时间静默这条告警。
   - 在等 watch 的会话不会被唤醒；到期的 watch 也不会被判 EXPIRED，一直等到重新打开。
4. 重新打开（`drain` 或 `on`）：重启后第一轮评估补上 off 期间成立或到期的 watch，每个恰好唤醒一次，滞后仪表回到 0。
   演练里从重启完成到两个唤醒入队的耗时见第 9 节。
5. 多 replica 部署时每个 replica 都要是 `off`：worker 按 replica 启停，`orbit_watch_rollout` 也按 replica 报。

### R3 回滚 apiserver 镜像（与 Watch 无关的回归，或开关本身坏了）

- 回到上一版镜像（`1471214ac` 一代，没有开关）。**不需要、也不要回滚迁移**：旧镜像读得懂新镜像写下的 watch（演练已验证）。
- 旧镜像没有开关，等同 `on`。所以要「关掉 Watch」不能靠回滚镜像，必须留在新镜像上用 `off`。
- 不要回滚到迁移 0259 之前的镜像：那一版不认识 watch 表和 0271 在 task 上加的触发器，没有验证过。

### R4 runner

关 Watch 不需要回退 runner：旧 runner 在任何模式下都能工作（第 2 节）；新 runner 的轮询拦截在 `drain` / `off` 下对新 spawn 的引擎自动关闭。

### 不要做

- 不要执行 `prisma/migrations/0259…0271/down.sql` 来「回退 Watch」：会删掉 watch 历史与审计记录，而旧镜像并不需要这样做。
- 不要直接改库批量改 watch 状态或删行；要停就用 API 的 cancel。
- 不要为了让新值立刻生效而重启 runner：重启会杀掉会话的后台作业，而新值对新 spawn 的引擎已经生效。

## 8. 数据迁移策略

1. **结构**：Watch 的表和触发器由迁移 0259–0271 加入，全部是增量的。本开关不带迁移；开关的任何取值、回滚镜像到 `1471214ac`，都不改结构。
2. **已有数据在每个模式下**：

   | 模式 | 已有的 watch |
   | --- | --- |
   | `on` / `canary` | 照常 |
   | `drain` | 照常评估、成立、到期、交付；只是不能新建或重新布防 |
   | `off` | 原地冻结；重新打开后补评估，每个唤醒恰好一次 |
   | 回滚镜像 | 读写照常，历史完整 |

3. **不回填，也不自动迁移旧的等待。** 旧等待的意图写在自由格式的脚本、提示词和 systemd 单元里：等哪些对象、成立后做什么、给谁发消息。
   这些没法可靠解析，猜错会唤醒错的会话或者漏掉条件。所以：
   - 已经在跑的轮询作业、Monitor、systemd 单元不停止、不改写，跑到它们自己结束；
   - 新 runner 只拦**新发起**的内联轮询命令，按路径运行的脚本不打开；
   - 由负责人在下次重新布防时自己换成 `task_await` / `session_await`：在等待的那个会话里调用，然后停掉旧作业（`bg_kill`，或 `systemctl stop <unit>`）。
4. **线上现存的旧等待**（2026-09-14 盘点）：宿主上 2 个 `orbit-coord-watch-bglifecycle-*` systemd 单元，是协调会话
   `34NcutOmkLEub00h4jw5a` 的自唤醒。按上一条保留；换不换成 Watch 由那个项目的协调会话决定。
5. **跟踪迁移**：每周跑一次第 4 节的 SQL。轮询数应随新 runner 普及而下降，await 调用应上升。

## 9. 演练记录

**2026-09-14，隔离环境，不碰线上**：一次性 postgres:16 容器；生产构建的 apiserver（`node dist/main.js`）与 web 包；真实的 `orbit` runner
和真实的 Claude 引擎（内置运行时，默认模型）。宿主负载 16–42（8 核），下面的时延都是在这个负载下测的。

| 被测部件 | 提交 |
| --- | --- |
| apiserver、web、「新」runner | `3417c261f`（本任务的产品代码；之后的提交只加测试和文档） |
| 「0.1.159」runner、回滚用的旧镜像 | `1471214ac` |
| 「Watch 之前」的 runner | `1f42ef54`（`b84e0fc00^`） |

账号 A（bootstrap 管理员）挂 `an`（新）和 `ao`（0.1.159）；账号 B 挂 `bn`（新）、`bo`（0.1.159）、`bp`（Watch 之前）。五个 runner 同时连在一个 apiserver 上。
按第 6、7 节的顺序执行，每一步都用本手册写的检查项核对：

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 基线 `on`：`an`、`ao` 的兼容矩阵 | 两代都列出 watch 工具；`task_await` 记下 watch；`session_create(wait)` 内联拿到答案，并由 watch 托底（驱动方式带来的 ALREADY_WOKEN，见下面的说明） |
| 2 | 切 `canary`，只列 A；重启 5.1s | `orbit_watch_rollout{mode="canary"}` 为 1、名单数为 1；日志 `Watch is canary for 1 account(s)`；迁移数 276 不变 |
| 3 | canary 兼容矩阵，五个 runner | 25/25。A 的两代照常；`bn` 引擎 `ORBIT_WATCHES=off`，不列工具，内联等待不建 watch；`bo` 仍列出工具，调用得到「no watch door」，内联等待不建 watch；`bp` 一切如旧；五个都没有多余的唤醒 |
| 4 | canary 下的用户接口 | 5/5。A 建 watch 得到 201；B 得到 404 `WATCHES_DISABLED`，没有任何写入；B 读 watch 和死信都是 200；拒绝计数器增长 |
| 5 | canary 下的真实 agent | `an`：让它「帮我盯着两个 task」，它调 `task_await` 建了 watch，没有任何轮询；task 失败后恰好唤醒一次，回话给出 FAILED。`an`：让它跑 `for … orbit task get …; sleep 5`，hook 拒绝，命令没有执行；同一会话里用 `bg_run` 起的 http.server 正常应答。`bn`（B，Watch 没开）：引擎 `ORBIT_WATCHES=off`，没有建 watch，turn 正常结束，同一条轮询命令照旧执行。`ao`（0.1.159）：轮询命令照旧执行，旧 hook 没有这条规则 |
| 6 | 建演练用的 watch（W1、W2 由新 runner 建，W3 由 0.1.159 建，TTL 300s），随即切 `off`；重启 10.9s | 日志两行 `this replica evaluates no watch` 与 `this replica delivers no watch wake or notification` |
| 7 | `off` 下的检查 | 16/16。用户接口和两代 runner 的 `task_await` 都被拒且说明了原因，没有写入；新 spawn 的引擎 `ORBIT_WATCHES=off`，内联等待正常；任务照常建、评论、取消；web 同源的 `/api/watches` 对 A、B 都是 200。T2 置 FAILED 之后的 4 分 36 秒里（28 次采样，跨过 W3 的到期时刻），W2、W3 一直是 ACTIVE，零唤醒；`orbit_watch_evaluation_lag_seconds` 超过 60，`WatchEvaluationLagging` 在响 |
| 8 | `off` 兼容矩阵（`an`、`ao`、`bp`） | 15/15 |
| 9 | 切回 `on`；重启 23.3s | 第一轮 2.1s 内：W2 MATCHED，唤醒 P2 一次；W3 EXPIRED，唤醒 P3（0.1.159 runner）一次；两个 turn 都被回答；30s 后仍然各一次；两个滞后仪表回到 0 |
| 10 | 切 `drain`；重启 13.8s | 14/14。T1 置 FAILED，W1（Watch 开着时建的）MATCHED 并唤醒 P1 恰好一次；所有写入被拒；新引擎为 `off`；内联等待、任务、web 读取照常 |
| 11 | 回滚到旧镜像 `1471214ac`；重启 13.4s | 4/4。迁移数不变，没有迁移可跑；旧镜像读出了新镜像写的全部 watch 以及 W1 的交付；建 watch 恢复为 201（旧镜像没有开关）；新 runner 在旧镜像下 spawn 的引擎为 `ORBIT_WATCHES=on` |
| 12 | 旧镜像兼容矩阵（`an`、`ao`） | 10/10 |
| 13 | 回到新镜像 `on`；重启 9.8s | 2/2，矩阵 10/10。B 建 watch 得到 201；第 10 步之前启动的旧式轮询作业跨过旧镜像、新镜像两次重启一直在跑：重启期间有几次读不到，之后接着读，没有被停掉或改写 |

bg-guard 的真实二进制探测（`hook-probe.txt`：3 代 runner × 3 种 `ORBIT_WATCHES` × 9 种命令形状）：新 runner 在 `on` 或未设置时拒绝 4 种轮询，
放行其余 5 种（单次读取、await、等 CI、dev server、按路径运行的脚本），`off` 下全部放行；0.1.159 和 Watch 之前的 runner 在任何取值下都放行轮询。

说明：

- 兼容矩阵是从引擎外面，用那个引擎的真实环境去驱动它那一代的 `orbit mcp`。这时父会话是空闲的，watch 成立后唤醒先于 release 被 runner 取走
  （`ALREADY_WOKEN`），所以输出里多一句「可能还会到一个内容相同的 turn」，会话上也多一个唤醒 turn。agent 在自己的 turn 里调用时，唤醒排在队里并被撤回
  （`WAKE_WITHDRAWN`），产品 QA 的 B2 已经验证过。矩阵的判据只看「是否由 watch 托底」以及「没开时一个 watch 都不建」。
- 第一次建演练 watch 时旧式轮询作业没有起来（`bg_run` 的 cwd 必须在会话自己的 checkout 里，是演练脚本写错了），修正后在第 10 步之前补起。
  两条 agent 判据第一次误判为失败，是脚本在 JSON 转义后的输出里找 `"status"`；按修正后的判据复核，见 `agents-recheck.json`。
- 演练期间 apiserver 日志里有 338 条 `P2028`，全部是 runner 认领长轮询和事件写入的事务等不到连接，分布在每个阶段，包括没有开关代码的旧镜像阶段（56 条），
  速率随宿主负载上升。它与开关无关，各项检查也照常通过；线上放量时照门槛 G6 看。

脚本在 `/root/.orbit/uploads/a4bf0f1e-992d-5b73-86b6-1ad0eaa4a7c7/drill/`，产物在它的 `artifacts/`：每一步的 JSON、`timeline.log`、`drill-summary.json`、
`hook-probe.txt`、`agents-recheck.json`、`legacy-watch.log`、`stack-logs/`。

## 10. 已知限制

- 开关按账号，不按 workspace 或会话；改值要重启 apiserver。
- 切换之前 spawn 的引擎保持旧值，直到被回收（最长 4 小时）。
- `off` 期间不唤醒任何在等 watch 的会话，也不判定到期：这是冻结的代价，重新打开后补上。
- 0.1.159 在 Watch 没开时的工具文案说「升级服务端」，不准确；但它同时说了不要退回轮询，行为是对的。
- 轮询拦截只覆盖 Claude 引擎，而且是文本规则，有漏网（第 4 节）。
- `off` 只停本 replica 的 worker，多 replica 部署要每个 replica 取同一个值。
