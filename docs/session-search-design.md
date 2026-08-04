# Session Search (⌘K) — 设计方案

跨 agent / 跨 runner / 跨生命周期视图定位历史 session。web 用 ⌘K 命令面板,macOS 用 ⌘K 弹窗,
iOS 用同一个面板(抽屉放大镜进入)。三端共用一个服务端 endpoint。

## 1. 为什么必须走服务端

web 的 session 列表是 `GET /sessions?runnerId=&view=`,缓存键 `['sessions', runnerId, view]`
按 runner + view 分片(`src/web/src/lib/queries.ts:81`)。⌘K 要跨 agent、跨 runner、跨
Open/Completed/Trash 定位,客户端缓存里从来没有全量数据。原生端同理
(`APIClient.listSessions(view:runnerId:)`)。

## 2. 线上数据现状(2026-07-26 实测)

| 项 | 值 |
|---|---|
| session 总数 | 1330(主账号 1299) |
| run_event 总数 | 3,010,227 行 / 1468 MB |
| 其中 `user` + `assistant` | 36,568 行 / **14 MB**(占 1.2%) |
| 其中 `system` | 2,787,318 行(占 92%,吃掉了几乎全部体积) |
| session 表体积 | 9.4 MB(prompt 均长 847 / 最长 7255) |

这个比例是整个方案的支点:**正文检索只需要覆盖 1.2% 的行**。

## 3. 技术选型

### 3.1 排除 tsvector 全文检索 —— 中文分词不可用

```
to_tsvector('simple','支持搜索Session 的方案')
  → '支持搜索session':1  '的方案':2
```

整段 CJK 被吞成单个 token,搜"搜索"永远搜不到。镜像 `postgres:16-alpine` 的
`pg_available_extensions` 里**没有 zhparser**(完整清单只有 contrib:`pg_trgm`、`unaccent`、
`btree_gin`、`pgcrypto` 等)。原生 FTS 对中文语料直接出局。

### 3.2 排除 ParadeDB BM25 —— 能力够,但代价不对

`pg_search`(Tantivy 后端,带 Lindera 中文分词)确实能同时解决分词和相关性排序,且**没有**下面
trigram 的字符门槛。排除它的理由不是能力:

1. **交互模型不匹配。** ⌘K 是增量输入的已知项定位,敲"会"→"会话"→"会话列"每步都要出结果,
   需要的是**子串匹配**;BM25 是 token 上的排序函数,词中间的子串匹配不是原生能力。
2. **排序维度不同。** session 切换场景里 recency 压倒 relevance —— 没人想要三个月前"最相关"
   的 session 排在十分钟前刚碰过的那个上面。本方案的排序是 `matchField 分档 → last_turn_at DESC`,
   BM25 分数在这个排序里没有位置。
3. **规模撑不起。** 单账号 1299 sessions / 36k 消息 / 14 MB。trigram 实测 4.7–13 ms,
   优化到个位数毫秒用户无感知。
4. **风险不对等。** 要把生产库镜像从 `postgres:16-alpine` 换成 ParadeDB,数据目录直接挂在
   `./data/postgres`,而这个部署此前已因 compose 层面失误出过一次全员不可用事故。

**重新评估的阈值**(避免这个决定被无限期拖着):单账号 user+assistant 消息超过 ~500 万行,
或用户开始做多词探索式查询(排序质量真正决定成败),或 2 字中文查询的退化被实际抱怨。
到那一步正确答案是 ParadeDB + Lindera,不是给 trigram 打补丁。

### 3.3 选定 pg_trgm —— 以及它的 3 字符门槛

在 36,568 行真实语料 + GIN 索引上实测:

| 查询 | 索引行为 | 耗时 |
|---|---|---|
| `ilike '%session search%'` | Bitmap Index Scan → 127 行 | **13 ms** ✅ |
| `like '%会话列表%'`(4 字) | Bitmap Index Scan → 174 行 | **4.7 ms** ✅ |
| `like '%会话%'`(2 字) | 索引返回**全部 36568 行**再 recheck | **533 ms** ❌ |
| 无索引裸 ILIKE 打 run_event | 3M 行 parallel seq scan | **1063 ms** ❌ |

`%xx%` 只有 2 个字符时提取不出任何必然出现的三元组,索引退化成全扫,比 seq scan 还慢。

**由此定死一条产品规则:`q` 去空白后长度 ≥ 3 才查长文本正文。**

实现时发现门槛不能只加在 `run_event` 上 —— 2 字查询同样会打 `session_search_trgm`,索引答不了却仍要
全量 recheck。实测把短查询改成只匹配**短"名字"字段**(title / branch / agent / task):

| 短查询路径 | 耗时 | 命中数 |
|---|---|---|
| 拼接表达式 ILIKE(走索引) | 128 ms | 512 |
| 只匹配 title + branch | **4.4 ms** | 51 |

快 29 倍,而且结果更好 —— 2 个字符匹配进 7KB prompt 本来就是噪音。所以最终是**三层**:
名字(任意长度)→ 长正文 + 消息(≥3 字符)。UI 明确提示"再输入 N 个字可搜正文",不静默降级。

## 4. 数据层 —— migration `0068_session_search`

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Tier A:session 元数据。实测 8.9 MB。
CREATE INDEX session_search_trgm ON session USING gin (
  (coalesce(title,'') || ' ' || coalesce(prompt,'') || ' ' ||
   coalesce(last_assistant_text,'') || ' ' || coalesce(branch,'')) gin_trgm_ops);

-- Tier B:对话正文。部分索引,只吃 user/assistant 那 1.2% 的行。实测 34 MB。
CREATE INDEX run_event_text_trgm ON run_event USING gin ((payload->>'text') gin_trgm_ops)
  WHERE type IN ('user','assistant');
```

注意事项:

- Prisma 不支持表达式 GIN 索引 → 纯 raw SQL migration,`schema.prisma` 不动;在 `Session` /
  `RunEvent` model 上加注释说明这两个索引由 migration 管理,避免后人 introspect 后误删。
- **没有用 `CONCURRENTLY`**:Prisma 把每个 migration 文件包在事务里,而 CREATE INDEX
  CONCURRENTLY 不能在事务中执行。实测在 3.6 万行的临时库上建两个索引耗时 **11.3 s**;生产的
  `run_event` 有 300 万行,部分索引仍需扫全表才能挑出那 1.2%,预计更久,且期间持有
  ACCESS EXCLUSIVE 锁会**阻塞事件摄取**。→ 必须低峰期部署。
- **写路径影响**:GIN 会拖慢 `run_event` 的批量 insert(`runner-api.controller.ts` 的事件摄取)。
  部分索引把 92% 的 `system` 事件完全排除,是关键缓解手段。上线后观察摄取延迟。

## 5. API

```
GET /sessions/search?q=<string>&limit=20
```

⚠️ **必须声明在 `@Get(':id')` 之前**(`src/apiserver/src/sessions/sessions.controller.ts:77`)——
Nest 按装饰器声明顺序匹配,写在后面 `search` 会被当成 id 吃掉。

### 响应

```ts
{
  q: string,
  contentSearched: boolean,        // q 不足 3 字符时 false,驱动 UI 提示
  hits: Array<{
    id: string,
    title: string,
    status: RunStatus,             // 兼容字段；等于 runStatus
    runStatus: RunStatus,          // runner/进程的原始执行态
    sessionState: SessionState,    // 旧客户端兼容字段;新客户端不用它推断列表位置
    runState: SessionRunState,     // 执行态/结果,与生命周期位置正交
    lifecycleState: SessionLifecycleState, // OPEN | COMPLETED | TRASH
    agent: { id: string, name: string } | null,
    runnerId: string | null,
    taskId: string | null,
    taskTitle: string | null,
    lastTurnAt: string | null,
    createdAt: string,
    completedAt: string | null,    // lifecycleState=COMPLETED 时结果行标注 Completed
    deletedAt: string | null,      // 结果行标注「在 Trash」
    endReason: string | null,      // 诊断/兼容；运行状态文案以 runState 为准
    matchField: 'id'|'title'|'prompt'|'reply'|'message'|'branch'|'agent'|'task'|'recent',
    snippet: string | null,        // 命中处 ±60 字符窗口,服务端截 + 折叠空白
  }>
}
```

滚动升级期间响应还可携带 `filingState` 与 `archivedAt`,分别映射
`COMPLETED → ARCHIVED` 和 `completedAt → archivedAt`;它们是只读兼容别名,新客户端只以
`lifecycleState` 判断结果属于 Open、Completed 还是 Trash。

### 检索与排序

- **不回传 snippet 偏移量**:服务端折叠了 snippet 里的空白(否则一段 markdown 回复切出来是
  一堆空行),折叠会让任何偏移量失效。客户端改为在成品 snippet 里自己定位查询词 ——
  web `splitHighlight` / OrbitKit `SessionSearchHighlight`,两边配同一套测试。
- **ID 直达**:完整 UUID、URL 中的 Base62 短 ID，以及 agent/log 常用的 8–12 位 UUID
  前缀。完整 ID 走主键精确匹配；前缀若碰撞会返回全部候选，不擅自挑一个。
- **Tier A**:`title`、`prompt`、`last_assistant_text`、`agent.name`、`branch`、`task.title`。
- **Tier B**(`q.length >= 3`):`run_event.payload->>'text'` where `type in ('user','assistant')`,
  每个 session 只取最高优先的一条命中。
- **范围**:默认含 Completed 和 Trash ——「我记得有个 session」十有八九就在 Completed,
  只是结果行打角标区分。
- **排序**:`matchField` 分档(id > title > prompt/reply > message > agent/branch/task),
  同档按 `last_turn_at DESC NULLS LAST, created_at DESC`。
- **实现**:`meta` + `content` 两个 CTE 做 `FULL OUTER JOIN` 后按 rank 取最优,沿用 `list()`
  已有的 `$queryRaw` 风格(该方法已因需要在 SQL 里 `left()` 截断而手写 raw)。

  ⚠️ **`meta` 必须写成 UNION 而不是 OR 链。** 最初写成
  `(索引表达式 ILIKE p OR a.name ILIKE p OR t.title ILIKE p)`,规划器因为 OR 跨了 join 表
  **完全放弃 `session_search_trgm`**,退化成全表扫 + 每行 6 次 ILIKE。改成三个独立分支 UNION
  (session 文本 / agent 名 / task 名)后索引才真正生效:

  | 查询 | OR 链 | UNION |
  |---|---|---|
  | `merge` | 279 ms | **132 ms** |
  | `会话列表` | 151 ms | **41 ms** |
  | `SSE keepalive` | 110 ms | **12 ms** |
  | 无命中 | 118 ms | **4.9 ms** |

- **字段表驱动**:match_field CASE、match_text CASE、re-test 三处必须一致,手写三遍会悄悄漂移
  (报告匹配了某字段,snippet 里却没有查询词)。服务里由一张 `fields` 表统一生成,门槛也只在这
  一处决定。

### 安全

`run_event` 没有 owner 列。Tier B **必须** `JOIN session s ON s.id = session_id WHERE s.owner_id = $1`,
否则跨账号泄露对话内容。trgm 索引本身不是 owner-scoped,规划器会先 bitmap scan 再 join 过滤 ——
结果正确,但这个 join 条件是安全边界,不能省。

### 纯函数与测试

rank 排序和 snippet 窗口都在 SQL 里(见上),留给纯函数的是最容易出错的那部分:查询归一化 ——
`src/apiserver/src/sessions/search-query.ts`(LIKE 通配符转义 + 门槛判定,按**码点**而非 UTF-16
单元计数),配 `search-query.spec.ts`,参照 `remember-rules.spec.ts` 的既有习惯。

转义不是理论问题:实测 `q='100%'` 不转义时返回 20 行、其中只有 5 行真含 "100%";转义后 19 行
全部命中。

## 6. Web

新建 `src/web/src/components/SessionSearch.tsx`,挂在 `AppShell.tsx:34`(TasksSidePanel 旁),
**全局路由可用**。

- **快捷键** `⌘K` / `Ctrl+K`。参照 `AgentView.tsx:1262` 的 window keydown 模式,但
  **不跳过 INPUT/TEXTAREA** —— 带修饰键,在 composer 里也该能触发。
- **不绑 `/`** —— 会撞 composer 的 slash 命令补全(`AgentView.tsx:2346`)。
- `Esc` 关、`↑↓` 选、`Enter` 打开。
- UI 用 antd `Modal`(项目已重度使用)+ 自绘列表;结果行复用 `StatusIcon` / `statusLabel`。
- **query key 必须写进 `lib/queries.ts`** —— 该文件开头注释把这条定成铁律(两处自定义 key 会
  导致静默 cache miss)。debounce 200 ms + `placeholderData: keepPreviousData` 防列表闪烁。
- **空 query 显示最近 session**(服务端 recents,limit 20),让 ⌘K 同时是「快速切换器」。
- 跳转 `navigate('/sessions/' + encodeId(id))`。`AgentView` 的 `scopeAgentId`
  (1156–1176)会自动把左栏重定位到该 session 的 agent,**跨 agent 跳转天然可用**。
- 移动端无键盘 → 在 `session-col-head`(`AgentView.tsx:2686`)加放大镜图标做入口。

## 7. macOS

- `⌘K` 目前**空闲**(已占用:⌘N 新建、⌘D Complete、⌘⇧F 全屏、⌘1–9 跳 agent)。
- 注册进 `OrbitApp.swift:37` 的 `.commands`,放在 `CommandMenu("Go")` 里 —— 与 ⌘1–9
  的「跳转」语义同族,且菜单栏可发现。
- 弹窗:`.sheet` + `SessionSearchView`(内含 `NavigationStack` + `.searchable`;没有
  NavigationStack 时搜索框根本不渲染)。
- 结果行复用 `StatusGlyphView` / `SessionStatusGlyph`,与会话列表同一套视觉。

## 8. iOS

- **与 macOS 共用同一个 sheet**,而不是把 `.searchable` 挂到会话列表上。原因:搜索是跨 agent /
  跨生命周期的,把跨域结果塞进一个只作用于单个 agent 的列表会读成 bug —— 清空输入框时那些
  session 就凭空消失了。
- 入口是抽屉标题栏的放大镜,紧邻 Recents:做的是同一件事(跳到某个 session),只是不限于最近
  几条、也不限于单个 agent。
- iPad 外接键盘同样绑 `.keyboardShortcut("k", modifiers: .command)`。

**共享**:iOS 通过 `project.yml` 复用 `../macos/OrbitApp/Sources/OrbitApp` 全部源码(带
exclude 列表)。`SessionSearchView.swift` 一份两端共用,只有窗口尺寸按 `#if os(macOS)` 分叉。
**新文件不要加进 exclude 列表。**

sheet 挂在两端各自的「已登录根视图」(macOS `RootView` in `OrbitApp.swift` / iOS `RootView` in
`OrbitiOSApp.swift`),不是挂在 shell 上 —— iPhone 与 iPad 用的是不同 shell(`CompactShell` /
`MainView`),而面板要能同时被菜单命令、抽屉按钮和硬件 ⌘K 打开。

**OrbitKit 改动**:
- `Models/DTOs.swift` 加 `SessionSearchHit` / `SessionSearchResponse`,`matchField` 用宽松解码
  (未知值回落 `.message`),避免服务端加字段把老客户端的面板打空。
- `Net/APIClient.swift` 加 `searchSessions(q:limit:)`。
- `App/SessionSearchHighlight.swift` —— web `splitHighlight` 的 Swift 端口,配 XCTest。
- `SessionStatusGlyph.make` 增加一个接受散字段的重载(原 `make(for: Session)` 委托给它)。搜索
  命中的 payload 比 `Session` 薄,为调用它去手工拼一个 `Session` 意味着要把一个很长的
  memberwise init 参数顺序写对 —— 这个项目在这上面栽过(beta.96)。

## 9. 落地状态与验收

三阶段都已实现。

| 阶段 | 内容 | 验证结果 |
|---|---|---|
| 1 | migration 0068 + `GET /sessions/search` | ✅ `EXPLAIN ANALYZE` 确认两个索引都走 Bitmap Index Scan;`search-query.spec.ts` 6 例绿;apiserver 81/81 |
| 2 | web ⌘K 面板 + recents + snippet 高亮 | ✅ web 构建通过,70/70(新增 `searchHighlight.test.ts` 9 例) |
| 3 | OrbitKit + `SessionSearchView` + macOS ⌘K + iOS 抽屉入口 | ✅ 已过 Mac/iOS CI 编译门并发版;后续修过一处实机问题(Esc 关闭面板) |

**实测性能**(通过编译后的 service 打真实数据副本,best-of-3 热连接):

| 查询 | 耗时 | 命中 | contentSearched |
|---|---|---|---|
| `merge`(高频词) | 114 ms | 20 | true |
| `会话列表` | 31 ms | 20 | true |
| `SSE keepalive` | 17 ms | 1 | true |
| `会话`(2 字) | 12 ms | 11 | false |
| `ab`(2 字) | 15 ms | 20 | false |
| `100%`(通配符) | 49 ms | 20 | true |
| 无命中 | 13 ms | 0 | true |
| 空(recents) | 7 ms | 20 | false |

全部 < 150 ms 目标。每个用例都断言了「返回的 snippet 确实包含查询词」,8/8 通过。

**仍需人工验收**

- 上线后观察事件摄取延迟,确认 `run_event` 上的 GIN 索引没有可观测回归。
- 生产 migration 的实际耗时(临时库 3.6 万行是 11.3 s,生产 300 万行会更久)。

## 10. 部署

- 阶段 1、2 动了 apiserver + web + 一个 migration → **必须全量部署**,不能用 web-only 捷径。
- 阶段 3 是纯客户端,走 Mac CI + TestFlight beta。
- **migration 必须低峰期跑**:建索引期间持 ACCESS EXCLUSIVE 锁,会阻塞 runner 的事件上报。
