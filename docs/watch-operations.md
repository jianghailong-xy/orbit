# Watch 运维手册：安全、成本控制与可观测性

**状态**：任务「P2：补齐 Watch 安全、成本控制与可观测性」的产物。领域语义以
[`watch-contract.md`](./watch-contract.md) 和 [`contracts/watch.contract.json`](../contracts/watch.contract.json) 为准。
本文只讲这些保护机制在线上**怎么看、怎么判断、怎么处置**。

| 来源 | 位置 |
| --- | --- |
| 限额、拒绝码、死信码、重投规则 | `contracts/watch.contract.json` 的 `limits`、`refusals`、`deliveryGuards` |
| 创建时的配额与唤醒环 | `src/apiserver/src/watches/watches.service.ts` `assertCapacity` |
| 交付时复核、风暴、预算、continuous 间隔 | `src/apiserver/src/watches/watch-delivery.service.ts`（头注释 GUARDS） |
| 脱敏 | `src/apiserver/src/watches/watch-redaction.ts` |
| 指标与告警 | `src/apiserver/src/watches/watch-metrics.ts`，由 `GET /api/metrics` 暴露 |
| 测试 | `src/apiserver/src/watches/watch-security.pg.spec.ts` |

## 0. 一页结论

1. **每一种「盯不下去」或「叫不醒」都有看得见的落点。** 创建时返回带 `code` 的 400/403；求值时 Watch 进入终态
   `REVOKED` / `UNRESOLVABLE` / `EXPIRED`；交付时变成 `DEAD_LETTER` 死信，`last_error` 以死信码开头。没有静默丢弃。
2. **仪表从数据库读。** Watch 数、死信数、评估和交付的滞后都在 scrape 时直接读表，任何 replica 读到的都一样；
   计数器只说明「这个 replica 做了什么」。
3. **告警在服务端判定。** `orbit_watch_alert_firing{alert=…}` 为 1 就是在响。Prometheus 规则只需判断它是否等于 1，
   阈值写在 `watch-metrics.ts` 里，第 4 节逐条列出。
4. **死信可以列出、可以重投，但不是每个都能重投。** 没跑的唤醒（观察者结束、被打断、被撤回）和权限已撤销的载荷永远不重投；
   其余死信由 owner 调 `POST /api/watches/deliveries/:id/retry` 放回队列，并重新经过全部防护。

## 1. 保护机制一览

| 机制 | 何时判定 | 默认上限 | 超限后的可见状态 |
| --- | --- | --- | --- |
| 创建时权限复核 | 创建 | 观察者能读到每个目标 | 403 `PERMISSION_DENIED` |
| 求值时权限复核 | 每次求值 | 目标仍属于 owner | Watch `REVOKED`；`RESUME_SESSION` 观察者收到只含 `watchId`、`state` 的 turn |
| 交付时权限复核 | 每次交付尝试 | 目标与观察者会话仍属于 owner | 死信 `PERMISSION_REVOKED`，不投递载荷、不可重投；Watch 保持 `MATCHED`/`EXPIRED` |
| 目标删除 | 每次求值 | — | 目标 `GONE` 并移出集合；全部删除 → Watch `UNRESOLVABLE` |
| payload 脱敏 | 构造 turn、推送、写 `last_error` | 白名单（第 2 节） | 形状不对的值写成 `[redacted]` |
| TTL | 创建与编辑 | `[60s, 30d]`，默认 24h | 400 `TTL_OUT_OF_RANGE`；到期 → Watch `EXPIRED` |
| 每账号 live Watch 上限 | 创建（条件还未成立） | 500 | 400 `WATCH_QUOTA_EXCEEDED`，什么都不写 |
| 每目标 live Watch 上限 | 创建（条件还未成立） | 50 | 400 `WATCH_QUOTA_EXCEEDED` |
| 自唤醒 | 创建 | — | 400 `SELF_WATCH_LOOP` |
| 唤醒环 | 创建（`RESUME_SESSION`，条件已成立的也查） | 链深 32 | 400 `WAKE_LOOP` |
| 唤醒风暴 | 交付，在观察者会话行锁下 | 每个观察者每小时 60 次 | 死信 `WAKE_STORM_SUPPRESSED`，可重投 |
| 每日唤醒预算 | 交付 | 每个账号 24 小时 1000 次 | 死信 `WAKE_BUDGET_EXHAUSTED`，可重投 |
| continuous rate limit | 交付 | 同一个 Watch 两次唤醒至少隔 10 秒 | 交付回到 `PENDING`，`last_error` 以 `CONTINUOUS_RATE_LIMITED` 开头，不计失败次数 |
| 重试 | 交付失败 | 8 次；退避 5 秒起，每次翻倍，封顶 5 分钟 | 死信 `ATTEMPTS_EXHAUSTED`（`last_error` 是最后一次失败的原文），可重投 |
| 交付租约 | worker 中途死掉 | 60 秒 | 回收并计一次失败；次数用尽 → 死信 `LEASE_EXPIRED` |

说明：

- 「live」指 `ACTIVE` 或 `PAUSED`。暂停既不能绕过配额，也不能拆掉一个唤醒环。创建时条件已经成立的 Watch 当场结束，
  不占 live 名额。
- 风暴上限是**精确**的：同一个观察者的唤醒在它的会话行锁下逐个计数。每日预算是**软**上限：同一账号不同观察者的唤醒互不等待，
  并发交付时最多超出正在进行中的那几次。
- 一次唤醒在它的交付处于 `DELIVERED` 时计数。被观察者队列收掉的唤醒会变成死信，不再占用预算。
- 这些默认值就是契约的 `limits`，改默认值就是改契约：先改 `contracts/watch.contract.json`，再改
  `src/shared/src/watch.ts`，二者由 `watch-api.pg.spec.ts` 和 `watch-security.pg.spec.ts` 对齐，随版本发布。

## 2. 脱敏规则

Watch 往外说的每一样东西都只从白名单取：

- **唤醒 turn 的快照**（Match 的 `latestSnapshot` 与 `changedTargets`、到期 turn 的 `latestSnapshot`）：每个目标只保留
  `kind`、`id`、`epoch`、`state`、`changed`；`leaves` 只保留契约声明过的 leaf（以 leaf 标签为键，带参数的形如
  `TASK_NO_PROGRESS_FOR(600s)`），值必须是布尔；`observed` 只保留 `status`、`endReason`、`runState`、`lifecycleState`
  （都必须是单个标识符）、`pendingApproval`（布尔），以及谓词读进度时的 `progress`：`phase`（单个标识符）、`current` / `total`
  （计数）、`lastProgressAt` / `epochStartedAt`（时间）。报告的 `message` 从不进快照；`phase` 不是单个标识符时写成
  `[redacted]`，完整的报告用 `GET /api/tasks/:id/progress` 读。continuous Watch 的 Match 带 `window` 与 `budget`，到期带
  `openWindow`，每个字段形状都对才保留，否则整个写成 `[redacted]`。**其他键直接丢弃；形状不对的值写成 `[redacted]`**，
  读 turn 的人能看出有东西被扣下了。
- **reason**（turn 标题行、载荷、推送正文）：必须是谓词描述的词汇，例如 `ANY_OF(ALL TASK_TERMINAL 7/7, ANY TASK_FAILED 1/7)`、
  `ANY TASK_NO_PROGRESS_FOR(600s) 1/1`；continuous Watch 的 Match 后面还跟着 `; 2 crossings since <时间>; wake 3 of 10`。
  否则整条写成 `[redacted]`。推送要经过 Apple 的服务，只带这条 reason，不带任何目标。
- **`REVOKED` / `UNRESOLVABLE` 的终态 turn**：只有 `watchId` 和 `state`，从来不含目标。
- **`last_error`**：落库前，URL 里的用户名密码、`Bearer`/`Basic` 凭据、JWT、`sk-`/`gh*_`/`AKIA` 形式的 key、
  `password=`/`token:`/`api_key=` 之类的值都替换成 `[redacted]`，再截到 1000 字符。它会出现在 Watch 的读接口和死信列表里。

**排查 turn 里出现了 `[redacted]`**：说明存储的 Match 或到期快照里有契约之外的形状。用第 6 节的 SQL 读出原始的
`per_target_snapshot` / `expiry_snapshot`，找出是哪个构建或哪次手工改动写进去的。**不要**为了让 turn 完整而放宽白名单。

## 3. 指标

全部在 `GET /api/metrics`：Prometheus text format，用普通的 Bearer token 访问。标签值只来自封闭集合，从不含任何 id。

### 3.1 计数器（每个 replica 各自累计，跨 replica 求和）

| 指标 | 标签 | 含义 |
| --- | --- | --- |
| `orbit_watch_creates_total` | `outcome` = `created` / `matched_at_create` / `replayed` | 写出或返回了 Watch 的创建 |
| `orbit_watch_refusals_total` | `code` = 契约拒绝码 | 被拒的创建和编辑（配额、唤醒环、TTL 等） |
| `orbit_watch_evaluations_total` | `outcome` = `MATCHED` / `EXPIRED` / `UNRESOLVABLE` / `REVOKED` / `SCHEDULED` / `SETTLED` / `FAILED` | 求值次数 |
| `orbit_watch_evaluation_delay_seconds` | histogram | **评估延迟**：一个 Watch 从到期到求值落地等了多久，包括等 claim 和求值本身 |
| `orbit_watch_delivery_attempts_total` | `outcome` = `DELIVERED` / `RETRY` / `DEAD_LETTER` / `LEASE_LOST` / `DEFERRED` | 交付尝试 |
| `orbit_watch_dead_letters_total` | `code` = 死信码 | 变成死信的交付 |
| `orbit_watch_effective_wakes_total` | `action` | **有效唤醒**：确认为 `DELIVERED` 的交付，即入队了 turn 或发出了推送 |
| `orbit_watch_duplicates_suppressed_total` | `kind` = `create_replay` / `match` / `settled_evaluation` / `wake_replay` / `lease_lost` | **重复抑制**：被吸收、没有做第二遍的重复 |
| `orbit_watch_reconcile_repairs_total` | `kind` = `delivery_lease_expired` / `target_gone` | **对账修复**：没有任何事件、靠对账发现并纠正的情况 |
| `orbit_watch_redrives_total` | `outcome` = `redriven` / `refused` | owner 发起的死信重投 |

重复抑制各项的含义：`create_replay` 是同一个幂等键的重试拿回了已建的 Watch；`match` 是某次落地发现本代 Match 已经记录过，
直接沿用；`settled_evaluation` 是求值时 Watch 已被别的落地结算；`wake_replay` 是重投的唤醒遇到同一 key 下已入队的 turn，
没有入队第二个；`lease_lost` 是租约已被别的 worker 接管，这次尝试什么都没写。

### 3.2 每次有效唤醒的成本

| 指标 | 含义 |
| --- | --- |
| `orbit_watch_cost_per_effective_wake{unit="evaluations"}` | 本 replica 自启动以来，每次有效唤醒花掉的求值次数 |
| `orbit_watch_cost_per_effective_wake{unit="delivery_attempts"}` | 同上，交付尝试次数 |

跨 replica、按时间窗看，用计数器算：

```promql
sum(increase(orbit_watch_evaluations_total[1h])) / clamp_min(sum(increase(orbit_watch_effective_wakes_total[1h])), 1)
sum(increase(orbit_watch_delivery_attempts_total[1h])) / clamp_min(sum(increase(orbit_watch_effective_wakes_total[1h])), 1)
```

唤醒出来的那个 turn 本身的模型花费不在 Watch 指标里，按会话用量看。

### 3.3 仪表（scrape 时从数据库读，各 replica 一致，取 `max`）

| 指标 | 标签 | 含义 |
| --- | --- | --- |
| `orbit_watch_gauges_up` | — | 这次 scrape 能否读到下面这些仪表；0 表示数据库读失败 |
| `orbit_watch_watches` | `state` | **active / paused / matched / expired / cancelled / revoked / unresolvable** 的 Watch 数 |
| `orbit_watch_deliveries` | `state` | 各状态的交付数 |
| `orbit_watch_dead_letter_backlog` | `code` | 在库的死信，按死信码（**dead**） |
| `orbit_watch_dead_letters_recent` | `window` = `1h` / `24h`，`code` | 最近一小时、最近 24 小时变成死信的交付 |
| `orbit_watch_ended_recent` | `window` = `24h`，`state` = `EXPIRED` / `REVOKED` / `UNRESOLVABLE` | 最近 24 小时以这些终态结束的 Watch |
| `orbit_watch_delivered_recent` | `window` = `24h`，`action` | 最近 24 小时送达、至今仍为 `DELIVERED` 的交付 |
| `orbit_watch_evaluation_lag_seconds` | — | 到期最久、还没被任何 evaluator claim 的 Watch 已经到期多久；没有则为 0 |
| `orbit_watch_delivery_lag_seconds` | — | 到期最久的 `PENDING` 交付已经到期多久；没有则为 0 |
| `orbit_watch_delivery_leases_stalled` | — | 租约过期超过 60 秒、仍然没人回收的 `IN_FLIGHT` 交付 |
| `orbit_watch_alert_firing` | `alert`，`severity` | 第 4 节的每条告警，1 表示正在响 |

仪表的代价：按状态计数要扫 `watch` 和 `watch_delivery` 全表；滞后读的是部分到期索引，与已结束的 Watch 数量无关。
自托管规模下 15–60 秒的 scrape 间隔没有问题；表到百万行量级时调大 scrape 间隔。

## 4. 告警

服务端判定，Prometheus 只要一条规则：

```yaml
groups:
  - name: orbit-watch
    rules:
      - alert: OrbitWatch
        expr: max by (alert, severity) (orbit_watch_alert_firing) == 1
        for: 5m
        labels:
          severity: '{{ $labels.severity }}'
        annotations:
          summary: 'Orbit Watch alert {{ $labels.alert }}'
          runbook: docs/watch-operations.md
      - alert: OrbitWatchGaugesDown
        expr: max(orbit_watch_gauges_up) == 0
        for: 5m
        labels:
          severity: critical
```

| 告警 | 级别 | 条件（`watch-metrics.ts` 的 `WATCH_ALERTS`） | 处置 |
| --- | --- | --- | --- |
| `WatchEvaluationLagging` | critical | `orbit_watch_evaluation_lag_seconds` > 120 | 7.8 |
| `WatchDeliveryLagging` | critical | `orbit_watch_delivery_lag_seconds` > 120 | 7.8 |
| `WatchDeliveryLeaseStalled` | critical | 有租约过期超过 60 秒的 `IN_FLIGHT` 交付 | 7.8 |
| `WatchWakeStorm` | critical | 最近一小时有 `WAKE_STORM_SUPPRESSED` 死信 | 7.5 |
| `WatchWakeBudgetExhausted` | warning | 最近 24 小时有 `WAKE_BUDGET_EXHAUSTED` 死信 | 7.6 |
| `WatchDeliveryFailing` | warning | 最近 24 小时有 `ATTEMPTS_EXHAUSTED` / `LEASE_EXPIRED` / `TURN_REFUSED` / `OBSERVER_SESSION_UNAVAILABLE` / `OTHER` 死信 | 7.7 |
| `WatchPermissionRevoked` | warning | 最近 24 小时有 `PERMISSION_REVOKED` 死信，或有 Watch 以 `REVOKED` 结束 | 7.1 |
| `WatchUnresolvable` | info | 最近 24 小时有 Watch 以 `UNRESOLVABLE` 结束 | 7.2 |

读「最近窗口」的告警，在引发它的行离开窗口后自动熄灭；死信本身仍然留在库里，可以用第 5 节的列表读出。

配额和唤醒环的拒绝不落库，只能从计数器看，补两条规则：

```yaml
      - alert: OrbitWatchQuotaRefusals
        expr: sum(increase(orbit_watch_refusals_total{code="WATCH_QUOTA_EXCEEDED"}[1h])) > 0
        labels:
          severity: warning
      - alert: OrbitWatchWakeLoops
        expr: sum(increase(orbit_watch_refusals_total{code=~"WAKE_LOOP|SELF_WATCH_LOOP"}[1h])) > 10
        labels:
          severity: warning
```

## 5. 重试 / DLQ 运维入口

两个接口，都用 owner 的 Bearer token，只能看到、改动自己账号的交付。

**列出**：

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$ORBIT/api/watches/deliveries"                 # 死信（默认）
curl -s -H "Authorization: Bearer $TOKEN" "$ORBIT/api/watches/deliveries?state=PENDING"   # 任一状态
```

每行是一个交付：`id`、`watchId`、`kind`（`MATCH` / `EXPIRY` / `REVOKED` / `UNRESOLVABLE`）、`generation`、`state`、`attempts`、
`nextAttemptAt`、`lastError`、`deadLetterCode`、`retryable`、`deliveredAt`、`deadLetteredAt`，按最近变更倒序，最多 100 行。

**重投**：

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$ORBIT/api/watches/deliveries/$DELIVERY_ID/retry"
```

- 效果：死信回到 `PENDING`，立即到期，`attempts` 从 0 重新计，`dead_lettered_at` 清空；`last_error` 保留到下一次尝试写入新值。
  worker 在下一轮（默认 5 秒内）重新尝试，并重新经过全部防护：权限复核、观察者是否还活着、风暴上限、每日预算。
- 不是死信 → 409 `DELIVERY_NOT_DEAD_LETTER`。
- `retryable: false` 的死信 → 409 `DELIVERY_NOT_RETRYABLE`，包括 `PERMISSION_REVOKED`、`OBSERVER_SESSION_ENDED`、
  `OBSERVER_TURN_INTERRUPTED`、`WAKE_WITHDRAWN`、`WAKE_KEY_TAKEN`。没跑的唤醒是被有意收回的，重投会叫醒一个刚被停下的会话；
  唤醒的键被别的 turn 占着，重投时它仍然占着；权限已撤销的载荷不应再发出去。
- 条件还在的死信，重投后会再次变成同一个码的死信，例如预算窗口还没过去。这不是故障。
- 同一个死信被并发重投时只有一次生效（按 `state` 与 `last_error` 做 compare-and-set），另一次返回 409。

## 6. 观测步骤

1. **看告警和总量**：
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$ORBIT/api/metrics" \
     | grep -E '^orbit_watch_(alert_firing|watches|dead_letter_backlog|evaluation_lag|delivery_lag|gauges_up)'
   ```
2. **看死信**：第 5 节的列表，按 `deadLetterCode` 分组。
3. **直接查库**（运维在数据库上只读查询，不经过 API）：
   ```sql
   -- 最近 24 小时的死信，按码
   SELECT substring(last_error FROM '^([A-Z][A-Z0-9_]*):') AS code, attempts, count(*)
     FROM watch_delivery
    WHERE state = 'DEAD_LETTER' AND dead_lettered_at > now() - interval '24 hours'
    GROUP BY 1, 2 ORDER BY 3 DESC;

   -- 一个交付属于哪个 Watch、哪个账号、唤醒哪个会话
   SELECT d.id, d.kind, d.state, d.attempts, d.last_error,
          w.id AS watch_id, w.owner_id, w.observer_session_id, w.state AS watch_state
     FROM watch_delivery d
     LEFT JOIN watch_match m ON m.id = d.match_id
     JOIN watch w ON w.id = COALESCE(d.watch_id, m.watch_id)
    WHERE d.id = :delivery_id;

   -- 原始快照（排查 [redacted]）
   SELECT per_target_snapshot FROM watch_match WHERE watch_id = :watch_id;
   SELECT expiry_snapshot FROM watch_delivery WHERE watch_id = :watch_id;

   -- 最近一小时被唤醒最多的观察者（风暴嫌疑）
   SELECT w.observer_session_id, count(*) AS wakes
     FROM watch w
     JOIN watch_match m ON m.watch_id = w.id
     JOIN watch_delivery d ON d.match_id = m.id
    WHERE w.action = 'RESUME_SESSION' AND d.delivered_at > now() - interval '1 hour'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

   -- 各账号的 live Watch 数（配额）
   SELECT owner_id, count(*) FROM watch WHERE state IN ('ACTIVE', 'PAUSED') GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

   -- 到期未求值、到期未交付
   SELECT id, state, next_evaluate_at, now() - next_evaluate_at AS overdue
     FROM watch WHERE next_evaluate_at <= now() ORDER BY next_evaluate_at LIMIT 20;
   SELECT id, state, attempts, next_attempt_at, now() - next_attempt_at AS overdue
     FROM watch_delivery WHERE state = 'PENDING' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 20;
   ```
4. **看日志**：apiserver 日志里的 `WatchDelivery` 和 `WatchEvaluator` 两个 logger。死信一行 `is a dead letter after N attempt(s)`，
   重试一行 `attempt N failed, will retry`，求值失败一行 `evaluation failed`，仪表读失败一行 `watch gauges could not be read`。

## 7. 处置步骤

### 7.1 权限撤销（`WatchPermissionRevoked`；Watch `REVOKED`；死信 `PERMISSION_REVOKED`）

1. 用第 6 节第二条 SQL 找到 Watch 和账号，确认确实是撤销：目标的 `owner_id` 已经不是 Watch 的 `owner_id`。
2. 这是**预期行为**：系统在拒绝把读不到的东西说出去。不要改库把交付改回 `PENDING`，也不要把目标的 owner 改回来再重投。
   `PERMISSION_REVOKED` 死信不可重投，这是契约。
3. 撤销若是误操作且已经纠正，让用户**新建**一个 Watch。旧 Watch 保持终态（契约 §11）。
4. 持续出现，说明有流程在不停转移目标的归属，找到那个流程。

### 7.2 目标删除（`WatchUnresolvable`；Watch `UNRESOLVABLE`；目标 `GONE`）

1. `GET /api/watches/:id`，看 `targets[].state`，确认目标是 `GONE`。
2. 通常无须处置：等在它上面的 `RESUME_SESSION` 观察者已经收到一个 `UNRESOLVABLE` turn。
3. 大量出现，说明有批量删除（清理脚本、删项目）在删被盯着的对象，和做删除的人确认。

### 7.3 配额超限（`WATCH_QUOTA_EXCEEDED`；`OrbitWatchQuotaRefusals`）

1. 用第 6 节的配额 SQL 看是哪个账号、有多少 live Watch，再按 `observer_session_id` 分组，看是哪个会话建的。
2. live Watch 过多，通常是 agent 每轮都建新 Watch，却不取消旧的。取消不再需要的：`POST /api/watches/:id/cancel`。
3. 单个目标超限（50），说明很多会话在等同一个 Task 或 Session。确认是否真的需要；多数情况下可以只留一个等待。
4. 不要直接改库删除 Watch：删除会连同 Match 和交付记录一起消失。用 cancel。

### 7.4 唤醒环（`WAKE_LOOP` / `SELF_WATCH_LOOP`；`OrbitWatchWakeLoops`）

1. 拒绝本身就是处置：环没有建成，创建方收到 400 和 `code`。
2. 频繁出现，说明两个 agent 在互相等待。查它们的 live Watch：
   ```sql
   SELECT w.id, w.observer_session_id, t.target_resource_id, w.state
     FROM watch w JOIN watch_target t ON t.watch_id = w.id
    WHERE t.target_kind = 'SESSION' AND t.target_resource_id IN (:s1, :s2) AND w.state IN ('ACTIVE', 'PAUSED');
   ```
3. 改编排：让一方等另一方，另一方用 `session_send` 回话，而不是双方都等对方的 turn 结束。

### 7.5 唤醒风暴（`WatchWakeStorm`；死信 `WAKE_STORM_SUPPRESSED`）

1. 用第 6 节「被唤醒最多的观察者」SQL 找到会话。
2. 看它最近的 turn。典型症状是每一轮都重建一个当场就成立的等待（例如等一个早已结束的 Task），于是每次立刻被唤醒。
3. 止血：用 `GET /api/watches?state=ACTIVE` 找出 `observerSessionId` 是它的 Watch，逐个 cancel；必要时中断这个会话。
4. 修正 agent 的等待逻辑，等一小时窗口过去，再按需重投被抑制的死信。风暴期间不要批量重投。

### 7.6 每日唤醒预算耗尽（`WatchWakeBudgetExhausted`；死信 `WAKE_BUDGET_EXHAUSTED`）

1. 看 `orbit_watch_delivered_recent{action="RESUME_SESSION"}`，再按账号统计唤醒次数，判断是正常高负载还是失控。
2. 失控：按 7.5 找到并停掉唤醒源。
3. 正常高负载：等最早的唤醒离开 24 小时窗口，再重投需要的死信；每次重投都会重新检查预算。长期需要更高额度时，
   改契约的 `limits.maxWakesPerOwnerPerDay` 并随版本发布（第 1 节末尾）。

### 7.7 持续交付失败（`WatchDeliveryFailing`；死信 `ATTEMPTS_EXHAUSTED` / `LEASE_EXPIRED` / `TURN_REFUSED` / `OBSERVER_SESSION_UNAVAILABLE`）

1. 列出死信，读 `lastError`：它是最后一次失败的原文（已脱敏）。
2. `ATTEMPTS_EXHAUSTED`：8 次都失败了。常见原因是 apiserver 与数据库之间出了故障，或 `createTurn` 持续拒绝。
   先按第 6 节第 4 步看日志修好根因，再重投。
3. `LEASE_EXPIRED`：worker 反复在交付中途死掉（重启、OOM）。先确认 apiserver 不在崩溃循环里，再重投。
4. `TURN_REFUSED` / `OBSERVER_SESSION_UNAVAILABLE`：观察者会话拒收。确认会话状态（是否在 Trash、Completed，或已经结束）；
   会话恢复后再重投，会话不再使用就不重投。
5. 重投后，确认 `orbit_watch_delivery_attempts_total{outcome="DELIVERED"}` 在增长，且没有出现新的同类死信。

### 7.8 评估延迟 / 交付延迟 / 租约停滞（`WatchEvaluationLagging` / `WatchDeliveryLagging` / `WatchDeliveryLeaseStalled`）

1. 先看 `orbit_watch_gauges_up`，并确认 apiserver 在运行。evaluator 和交付 worker 是每个 apiserver replica 里的循环，
   进程不在就没人处理。
2. 进程在跑：看日志里的 `watch sweep failed` / `watch delivery pass failed`，多半是数据库连接或锁等待。
3. `orbit_watch_evaluation_delay_seconds` 的高分位变大、滞后仪表却不高：负载高但跟得上。滞后仪表持续增长：跟不上，
   加 replica 或查慢查询。
4. 租约停滞：`IN_FLIGHT` 交付的租约过期后没被回收，说明没有 worker 在跑（回收发生在每一轮开始时）。恢复 apiserver 即可：
   回收会把这些交付放回 `PENDING` 并计一次失败，不需要手工改库。

## 8. 已知限制

- 唤醒环只在创建时沿 live `RESUME_SESSION` Watch 的会话链检查，最多 32 跳。经由 Task 状态间接形成的环，以及总在对方的等待结束后
  才重建、从不同时存在的环，由唤醒风暴上限兜底。
- 每日预算是软上限，并发交付可能超出几次；风暴上限是精确的。
- continuous Watch 目前不能通过 API 创建，求值器也不会为它记录 Match。间隔限制已经在交付层生效，留给后续的持续订阅使用。
- 计数器是进程级的，重启归零。跨 replica 或按时间窗看，用 `increase()` 求和。
- 更大规模的负载与故障注入，由独立的 Claude 产品 QA Gate 复核。

## 9. 测试

```bash
bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-security.pg.spec.ts
WATCH_SECURITY_ONLY=S-05,S-06 bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-security.pg.spec.ts
```

| 用例 | 覆盖 |
| --- | --- |
| S-00 | 新的拒绝码、限额、死信码与契约一致 |
| S-01 | 求值前权限撤销 → `REVOKED`，终态 turn 不含目标 |
| S-02 | Match 与交付之间权限撤销 → `PERMISSION_REVOKED` 死信，不投递、不可重投 |
| S-03 | 目标删除 → `GONE` / `UNRESOLVABLE`；删除不算撤销 |
| S-04 | 脱敏：快照、reason、推送、`last_error` |
| S-05 | 每账号、每目标配额，并发创建下精确 |
| S-06 | 自唤醒、两跳与三跳唤醒环；并发互等只成功一个 |
| S-07 | 唤醒风暴与每日预算：死信、告警、窗口过去后重投 |
| S-08 | continuous rate limit |
| S-09 | 持续交付失败 → 死信 → 列出 → 重投 → 恰好送达一次；重投规则 |
| S-10 | 运维入口、配额拒绝和指标走真实 HTTP |
| S-11 | 仪表与行一致、评估与交付滞后、租约停滞、重复抑制、对账修复、每次有效唤醒成本、每条告警的触发与熄灭 |
