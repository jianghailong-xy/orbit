# run_event 保留/归档策略提案

**状态：待账号所有者裁定。本文只产出决策依据，不落地任何改动。**
实测时间 2026-09-18 00:00 UTC（生产库 orbit-postgres）。所有数字都可用文末的复核命令重跑。

---

## 0. 一句话

噪声行的占比在三天内从 79.4% 涨到 **89.1%**，而最近 7 天的**新增行里 97.4% 是噪声**；
`system-noise.ts` 里「全量归档」这个权衡本身没写错，是它成立时所依据的量级已经不在了。

---

## 1. 实测现状

| 指标 | 2026-09-15 | 2026-09-18（本次） |
|---|---|---|
| run_event 行数 | 7,060,000 | **11,618,512** |
| pg_total_relation_size | 4402 MB | **5355 MB** |
| └ heap / TOAST / 索引 | — | 2861 / 1103 / 1390 MB |
| 噪声行（notNoiseSql 的补集） | 5,610,000（79.4%） | **10,356,621（89.1%）** |
| └ 其中 thinking_tokens | 5,610,000 | 10,045,463（86.5%） |
| 死元组 n_dead_tup | — | **1,196** |

两件事要先说清楚，因为它们排除了两条常见但错误的思路：

- **不是膨胀。** `n_dead_tup = 1196`，autovacuum 正常（最近一次 09-16 16:07）。
  这 5355 MB 全是活数据，`VACUUM FULL` 回收不到任何东西。这是**量**的问题，不是碎片问题。
- **不是 Trash 没清。** 30 天 Trash 清扫（`reaper.service.ts` `purgeTrash`，`TRASH_RETENTION_DAYS = 30`）
  确实在跑：库里最老的 `deleted_at` 是 2026-08-21，正好落在 30 天窗口内，没有漏网的。
  问题是它管不到 —— 见 §3。

run_event 占 public schema 全部表的 **63.6%**（5355 MB / 8423 MB）。
第二名 tool_call 只有 1027 MB。磁盘 `/` 197G 用 167G，剩 **23G（89%）**。

---

## 2. 增长的真实来源：不是「Orbit 长大了」，是一个 provider 的 ping 节奏

最近 7 天按 provider 拆（用 PG 自己的收件时钟 `ingested_at`，不用 runner 提供的 `created_at`）：

| provider | 会话数 | 行数 | 噪声 | 噪声率 | 行/会话 |
|---|---:|---:|---:|---:|---:|
| **deepseek** | 108 | **5,898,484** | 5,841,505 | **99.0%** | **54,616** |
| claude | 149 | 319,840 | 262,258 | 82.0% | 2,147 |
| anthropic-2 | 146 | 137,674 | 88,852 | 64.5% | 943 |
| anthropic | 7 | 5,390 | 3,004 | 55.7% | 770 |
| codex | 6 | 2,325 | 9 | **0.4%** | 388 |

**deepseek 一个 provider 贡献了最近 7 天 92.7% 的行**，单会话行数是 claude 的 **25 倍**，噪声率 99.0%。

单会话实测（`01a0a90e-…`，标题「criteria decision 通过后刷新消失」）：
34 小时里 188,600 条 `thinking_tokens`，**1.54 行/秒**，持续不停。同一会话里真正有内容的
`context`（带 contextTokens）只有 221 条，`status` 491 条。

deepseek 在 `model_provider` 里是 `runtime = claude`、`base_url = https://api.deepseek.com/anthropic`
的自定义 provider —— **走的是同一份 claude.go 代码路径**，差别只在对端把 token 级进度流得细得多。

这条结论决定了后面所有选项的排序：
`system-noise.ts` 注释里「~92% of all stored run_events」这个自估是在**另一种 provider 构成**下写的。
判定谓词没有过时，**过时的是「反正也没多少」这个隐含前提**。

日增长曲线（收件时钟，行/天）：

```
09-08    34,799      09-13   336,763
09-09    37,230      09-14   137,952
09-10    67,524      09-15 1,420,969
09-11    89,302      09-16 3,281,740   ← 峰值，≈971 MB/天
09-12   135,016      09-17   958,919
```

上一个 7 天（09-04…09-10）合计 291,475 行；最近 7 天 6,364,762 行 —— **周环比 21.8 倍**。

---

## 3. 问题二先答：保留窗口 —— 时间窗口在这张表上基本无效

（先答这条，因为它决定了 §4 的选型。）

按 `created_at` 切年龄窗口，实测能覆盖到的行：

| 窗口 | 行数 | 占比 |
|---|---:|---:|
| 早于 90 天 | 57,849 | 0.5% |
| 早于 60 天 | 2,948,157 | 25.4% |
| **早于 30 天** | **3,879,639** | **33.4%** |
| 早于 14 天 | 4,962,340 | 42.7% |
| 早于 7 天 | 5,253,815 | 45.3% |

**一个 30 天保留窗口今天只能删掉 33.4% 的行，而且这个比例每天都在变小** —— 因为表的一半以上是最近 7 天写的。
对比之下按形状删噪声是 89.1%，且这个比例每天都在**变大**。

### 与 Trash / 级联删除的关系

`run_event.sessionId` 是 `onDelete: Cascade`，所以 run_event 唯一的真实删除路径是**整个 session 被硬删**。
而 session 被硬删只有一条路：`reaper.service.ts#purgeTrash` 删掉 `deleted_at` 早于 30 天的 session。

按生命周期拆当前持有的行：

| 会话状态 | 会话数 | 持有 run_event 行 | 占比 |
|---|---:|---:|---:|
| COMPLETED | 2,958 | 8,742,543 | 75.3% |
| OPEN | 460 | 2,750,899 | 23.7% |
| **TRASH** | 1,860 | **113,207** | **1.0%** |

**Trash 机制结构上不可能约束 run_event 的增长**：一个会话只有被人手动删进 Trash 才会开始计时，
而**「已完成」不会自动进 Trash**。占 75.3% 行的 COMPLETED 会话永远不会被这条路径碰到。
这不是 bug，是 Trash 的产品语义（软删只是隐藏，30 天后才真删）—— 但它意味着
**「靠现有机制自然收敛」这条退路不存在**。

### 时间窗口还有一个语义代价

`run_event_text_trgm`（132 MB，GIN，`WHERE type IN ('user','assistant')`）给
`session_search` 的全文搜索供数。**按时间删行会静默地缩小用户能搜到的历史范围**；
按形状删噪声不会——噪声行的 `type` 是 `system`，根本不在这个索引里。

---

## 4. 问题一：thinking_tokens 这类纯 ping 行是否继续全量归档

### 4.1 继续全量归档的成本（按实测增速外推）

边际成本用**前后差额**测，不用绝对阈值（本项目已经在这上面栽过一次）：

- 2026-09-15 18:16 → 2026-09-18 00:00，行数 +4,533,783，`pg_total_relation_size` +953 MB。
- 窗口内还删掉了 389 MB 的冗余索引 `run_event_session_id_seq_idx`，加回来：真实增长 **1342 MB**。
- **边际全成本 ≈ 310 字节/行**（含 heap + 索引条目；噪声 payload 约 101 字节，从不进 TOAST）。

| 口径 | 行/天 | 磁盘/天 | 23 GB 余量还能撑 |
|---|---:|---:|---:|
| 最近 7 天均值 | 909,252 | **269 MB** | **88 天** |
| 09-16 峰值 | 3,281,740 | **971 MB** | **24 天** |

90 天 +23.7 GB，365 天 +95.9 GB —— 后者已经超过整机 197G 的一半。
参照：2026-09-15 这台机器已经因磁盘打满让 PG 报过 288 次 ENOSPC。

噪声行当前占的空间（按实测拆账）：

| | 噪声占用 | 该项总量 | 占比 |
|---|---:|---:|---:|
| heap（实测 `pg_column_size(t.*)` 2171 MB + 每行 28 字节头/行指针） | ~2448 MB | 2861 MB | 86% |
| 索引（pkey + session_id_seq_key 每行一条；turn_id_idx 按 98.8% 带 turn_id 摊） | ~1059 MB | 1390 MB | 76% |
| TOAST | 0 MB | 1103 MB | 0% |
| **合计** | **~3507 MB** | **5355 MB** | **65%** |

即：**清掉噪声行 + 重写，表从 5355 MB 降到约 1848 MB**。

此后的日增：最近 7 天非噪声行只有 168,481 条 = **24,069 行/天**。这些行单价高得多
（它们才是带 TOAST 的那批）：heap 330 + TOAST 882 + 索引 265 ≈ **1477 字节/行**，
所以日增从 269 MB 降到约 **34 MB —— 8 倍**。

### 4.2 不继续全量归档，失去了什么

必须说清楚，因为这是本提案里唯一真正"损失"的一侧：

1. **失去「run_event 是运行时输出的完整归档」这条不变量本身。**
   目前任何人拿到这张表，就等于拿到了 runtime 吐出过的每一个 system 事件。改了之后，
   这句话要改成「完整归档，除了纯 ping 形状的那一类」。这是产品承诺的削弱，**不是技术细节**。

2. **失去一条事后取证的路。** 举一个具体场景：如果将来怀疑某个 provider 的 ping 频率异常
   （比如本提案 §2 靠的正是这批行才定位到 deepseek 的 1.54 行/秒），
   删掉之后这类调查就只剩实时抓包。**本提案自己的证据，就来自将被删掉的那批数据。**
   缓解办法在 §5 的 E 方案（保留每会话每小时的计数摘要）。

3. **不会失去的（重要）：** codex 的 stderr。
   `isNoiseSystemEvent` 按 **payload 形状**判定，不是 subtype 黑名单 —— 正因为
   codex.go / codex_appserver.go 把 stderr 作为**无 subtype** 的 `system` 事件发出
   （"No conversation found with session ID…"、"Session ID … is already in use"），
   那是运行时起不来时唯一的记录。只要复用现成谓词而不新写一套，就不会误伤。
   实测背书：codex 会话最近 7 天 2,325 行里只有 **9 行**被判为噪声（0.4%）。
   **保护 codex 的那条规则，和造成 99% 体积的那个 provider，是两件互不相干的事。**

### 4.3 建议

**不继续全量归档**，但保留 §5-E 的计数摘要作为第 2 条损失的对冲。
理由：这批行携带的唯一信息是「某会话某时刻还活着」，而这个事实已经由
`conversation_turn`、`session.last_turn_at`、以及 `subtype = 'context'` 的 contextTokens ping
（不是噪声，不受影响）分别记录着。

---

## 5. 问题三：归档方式选型与迁移代价

五个方案，按侵入性从小到大。可组合。

### A. 入口不落库（ingress drop）

`runner-api.controller.ts` 第 3951 行 `tx.runEvent.createMany({ data, skipDuplicates: true })`
之前加一次 `filter(e => !isNoiseSystemEvent(e))`。该文件第 210 行已经导入了这个函数，
第 4329 行已经用它过滤实时广播。

- **改动量**：≈3 行 + 一条 spec。无迁移。
- **收益**：日增从 269 MB 降到约 34 MB（§4.1），**立刻**。
- **代价**：只管未来，不回收存量 3507 MB。
- **seq 语义**：留下 `seq` 空洞。这已经是既有常态 —— `system-noise.ts` 注释写明流式 delta
  本来就广播而不持久化，「clients order and dedup by seq without assuming it's gapless」。
  **但要注意 `max(seq)` 是承重的**：`queue.service.ts:357` 和 `runner-api.controller.ts:1686`
  都从 `max(run_event.seq)` 重建 runner 的事件计数器。入口丢弃使 DB 的 max 低于 runner 的计数器；
  由于被丢弃的 seq 槽位此后永久空着，恢复时从 `max+1` 起算不会撞上任何存量行。
  需要一条 spec 把这个不变量钉住。

### B. 就地删除存量噪声行 + 周期清扫

按 `notNoiseSql` 的补集分批 `DELETE`，然后 `VACUUM FULL` 或 `pg_repack` 归还空间。

- **改动量**：一个迁移 + 一个 reaper 定时任务。
- **收益**：表 5355 MB → ~1848 MB，回收 **~3.4 GB**。
- **代价**：
  - `DELETE` 1035 万行会产生大量 WAL，且只标死元组；**归还空间必须重写表**。
    `VACUUM FULL` 需要与表相当的额外空间（~5.4 GB，当前余量 23 GB，够）
    且**持 ACCESS EXCLUSIVE 锁**，期间整个 run_event 不可读写 —— 所有会话的读写全停。
    `pg_repack` 可避免长锁，但需要装扩展。
  - **`max(seq)` 风险**：删掉一个会话的尾部行会让 `max(seq)` 回退。实测
    **5265 个会话里只有 103 个（2.0%）的最高 seq 行是噪声行**，所以
    「每会话保留最高 seq 的那一行」这个补丁只需多留 103 行，就能完全消除这个风险。
    必须做，因为 `createMany({ skipDuplicates: true })` 会让 seq 冲突**静默吞掉**真事件
    （同一个坑的另一面已经记录在案：控制面往 run_event 插行会吞掉 runner 的下一条事件）。
  - 建议只对**终态且非 live** 的会话执行，或加上上面那条保留规则。

### C. 按时间分区（PARTITION BY RANGE (created_at)）

- **收益**：删旧数据变成 `DETACH`/`DROP PARTITION`，秒级、不产生死元组、立刻还空间。
- **代价**：**最大**。1161 万行的表要在线转分区表，实际做法是建新表 + 回填 + 切换，
  需要约 5.4 GB 临时空间和一个写入停顿窗口；
  Prisma 不原生支持分区表，`@@unique([sessionId, seq])` 和主键都必须包含分区键 `created_at`，
  这会改掉 `run_event_pkey` 和 `run_event_session_id_seq_key` 的形状，
  进而影响所有按 `(session_id, seq)` 查询的读路径；外键 `onDelete: Cascade` 在分区表上也要重新验证。
- **判断**：**在 §3 的数据下，分区解决的是一个不存在的问题** —— 时间窗口只能覆盖 33.4%
  且比例在下降。除非同时做 A（把日增压到 24k 行/天），否则分区只是把同样的体积换个放法。
  A 做完之后，表增长回到 ~7 MB/天，分区就更不必要了。**建议不做。**

### D. 导出后删除（冷存档）

`COPY (SELECT … WHERE <noise>) TO PROGRAM 'zstd > …'` 落盘/对象存储，再执行 B。

- **收益**：保住 §4.2 第 1、2 条损失 —— 归档仍然完整，只是不在主库。
- **代价**：噪声 payload 压缩比极高（10 万行几乎完全相同的 JSON），
  估计 996 MB payload 压后 < 30 MB。真正的代价是**运维**：多一份要备份、要轮转、要有人记得它存在的文件。
  且本项目已记录异地备份目标 219.74.54.93:1522 不可达 —— 冷存档放在同一块打满过的盘上，没有意义。
- **判断**：如果所有者认为 §4.2 第 1 条（归档完整性承诺）不能让步，这是唯一能兼顾的方案。否则不值当。

### E. 就地压缩噪声行（聚合为计数）

不删干净，而是把每会话每小时的噪声 ping 折叠成一行
`{subtype, sessionId, count, firstAt, lastAt}`。

- **收益**：1035 万行 → 约 5 万行（按会话数 × 活跃小时数估），保住「某会话某时段有多少 ping」
  这个唯一有信息量的维度，正是 §2 定位 deepseek 所需要的那个维度。
- **代价**：这**改变了行的语义** —— 折叠行不是 runtime 发出过的事件，
  而 `isNoiseSystemEvent` 会把它判成**非噪声**（它带 `count`/`firstAt` 等自有字段，
  按形状规则就"有内容"了），于是它会**出现在用户的 transcript 里**。
  必须给它一个专门的 `type`（不是 `system`），并加进 `NON_REPLAYABLE_EVENT_TYPES`，
  或者干脆写到另一张表 `run_event_ping_rollup`。**推荐后者** —— 不污染 run_event 的语义。

### 建议组合

**A（立刻止血）+ B（回收存量，带"每会话保留最高 seq 行"补丁）+ E 的独立汇总表（对冲取证损失）。**
不做 C，D 仅在所有者坚持归档完整性时做。

---

## 6. 对 system-noise.ts 既有读路径语义的影响

**核心约束：以上任何方案都不得修改 `isNoiseSystemEvent` / `notNoiseSql` 的判定。**

`system-noise.ts` 注释有明确要求：`notNoiseSql` 必须"select exactly the complement of this function"，
且 `system-noise.spec.ts` 用同一批 payload 同时校验两者。这条互补性是**读路径正确性的地基**：
实时广播走 JS 谓词（`runner-api.controller.ts:4329`），分页与重放走 SQL 谓词
（`sessions.controller.ts:779`、`sessions.service.ts:2881/2954`、`runner-api.controller.ts:5150`），
两者一旦不同步，实时看到的 transcript 和刷新后重放出来的就会不一致。

好消息是**没有任何方案需要动它**：

- **A 和 B 是这个谓词的新消费者，不是它的修改者。** 写路径复用同一个函数，
  语义自动跟着走；将来谓词改了，写路径和读路径一起改，互补性天然维持。
- **库里已经有一份该谓词的物化补集**：
  ```
  run_event_renderable_idx  btree (session_id, seq)
    WHERE NOT (type = 'system'
      AND COALESCE(payload->>'subtype','') <> ALL (ARRAY['init','resumed'])
      AND ((payload - 'model' - 'subtype' - 'sessionId') = '{}'::jsonb))
  ```
  69 MB，被扫了 357,172 次。这是第三处必须与那两者保持一致的地方 ——
  **任何改谓词的提案都必须同时改这个索引的 `WHERE`，否则读路径会静默走错行。**
  本提案的方案不改谓词，所以这个索引也不动；B 执行后它会从 69 MB 略缩（噪声行本来就不在里面）。

需要补的 spec（如果方案落地）：
1. 写路径与读路径用**同一个** `isNoiseSystemEvent`，不允许各写一份形状判断。
2. `run_event_renderable_idx` 的 `WHERE` 与 `notNoiseSql` 的文本一致性检查
   （目前没有任何测试钉住这三者中的第三者）。
3. B 方案的「每会话保留最高 seq 行」不变量。

---

## 7. 「不做」的成本（对照项）

不做也是一个合法选择。它的账：

| | 数值 |
|---|---|
| 磁盘余量 | 23 GB |
| 按最近 7 天均值（269 MB/天）撑到 ENOSPC | **88 天**（≈ 2026-12-15） |
| 按 09-16 峰值（971 MB/天） | **24 天**（≈ 2026-10-12） |
| 90 天后 run_event 体积 | 约 29 GB |
| 365 天后 | 约 101 GB（整机 197 GB 的一半以上） |

注意这个外推**偏保守**：它假设 provider 构成不变。而 §2 显示周环比是 21.8 倍，
新增一个 deepseek 量级的 provider 就会把 88 天砍到 40 天。

不做的非磁盘代价：

- **备份与恢复窗口**：库 8.9 GB 里 5.4 GB 是 run_event，其中 3.5 GB 是噪声。
  pg_dump / 恢复时间、异地备份带宽都按这个体积走。
- **写放大**：每条噪声行要写 heap + 2 个全量索引（pkey、session_id_seq_key）+ WAL。
  1.54 行/秒/会话 × 108 个 deepseek 会话，这部分 IOPS 是纯浪费。
- **已经发生过一次**：2026-09-15 磁盘打满，PG 报 288 次 ENOSPC。这不是假设风险。

「不做」唯一保住的东西，是 §4.2 里那条**归档完整性承诺**。
所以真正要拍的板是：**这条承诺值不值 3.5 GB 存量 + 269 MB/天 + 88 天的跑道。**

---

## 8. 需要账号所有者拍板的三个问题

1. **`run_event` 是否继续作为「运行时输出的完整归档」？**
   建议：改为「完整归档，纯 ping 形状的进度行除外」，并在 `system-noise.ts` 的注释里写明这次改动和理由。
2. **存量 3507 MB 噪声行怎么处理？**（B 直接删 / D 先导出冷存档再删 / 不动）
   建议：B + E 的汇总表。
3. **是否需要 §5-E 的计数汇总表**（`run_event_ping_rollup`），以保住 provider 行为的可取证性？
   建议：需要 —— 本提案自身的核心结论就出自这批数据。

三条都答完之后，再单独建落地任务。**在此之前不做任何改动。**

---

## 复核命令

```bash
# 体积与行数
docker exec orbit-postgres psql -U orbit -d orbit -c "
select pg_size_pretty(pg_total_relation_size('run_event')) total,
       pg_size_pretty(pg_relation_size('run_event')) heap,
       pg_size_pretty(pg_indexes_size('run_event')) idx, count(*) from run_event;"

# 噪声占比（与 notNoiseSql 逐字一致）
docker exec orbit-postgres psql -U orbit -d orbit -c "
select count(*) total,
  count(*) filter (where type='system'
    and coalesce(payload->>'subtype','') not in ('init','resumed')
    and (payload - 'model' - 'subtype' - 'sessionId') = '{}'::jsonb) noise
from run_event;"

# 按 provider 拆最近 7 天
docker exec orbit-postgres psql -U orbit -d orbit -c "
select coalesce(s.provider,'(null)') provider, count(distinct s.id) sess, count(*) rows,
  count(*) filter (where e.type='system'
    and coalesce(e.payload->>'subtype','') not in ('init','resumed')
    and (e.payload-'model'-'subtype'-'sessionId')='{}'::jsonb) noise
from run_event e join session s on s.id=e.session_id
where e.ingested_at >= now()-interval '7 days' group by 1 order by 3 desc;"

# 会话生命周期持有的行（证明 Trash 管不到）
docker exec orbit-postgres psql -U orbit -d orbit -c "
select case when s.deleted_at is not null then 'TRASH'
            when s.completed_at is not null then 'COMPLETED' else 'OPEN' end st,
       count(distinct s.id) sessions, count(e.id) rows
from session s left join run_event e on e.session_id=s.id group by 1 order by 3 desc;"
```
