# 设计文档:把 base62 public id 变成 API 的 id(方案 A)

状态:草案 · 2026-08-14(2026-08-16 追加 phase 3.5) · **Phase 0–3.5 已落地**(分类清单 · 双向覆盖测试 · 客户端版本上报 · 服务端双发 · 客户端拼写无关 · **`id` 无条件为 public id,仅机器协议除外**)· Phase 0–2 已部署,**Phase 3 的无条件翻转未部署** · phase 4(删 UUID 孪生字段)须等 `client_version` 有数据
作者:Claude(应 jianghailong 要求)
影响面:`src/apiserver`(响应侧拦截器 + 字段清单)、`src/web`、`src/ios`、`src/macos`、`src/runner-go`
关联:`src/apiserver/src/common/public-id.ts`(入方向规则)、`src/apiserver/src/common/workspace-alias.interceptor.ts`(同型迁移的先例)

---

## 1. 目标

id 在 **API 线以上**只有一种拼写:base62 public id。URL、请求、响应、客户端状态全部一致,UUID 不出 service/DB 层。

现状是"base62 只是 URL 的渲染形式":`decodeId()`(`src/web/src/lib/idCodec.ts:9`)在路由边界把短 id 还原成 UUID,之后一切——请求路径、响应体、React Query key、SSE 事件、本地缓存主键——都是 UUID。

**先说清楚终点在哪**:即使 A 全部做完,DB 行、server 日志、以及 8 个文件里 80 处 `::uuid` 裸 SQL 仍然是 UUID。所以 A 不是"全系统一种 id",而是"API 线以上一种 id"。翻译点不会消失,它从「地址栏 ↔ 网络」挪到「网络 ↔ 数据库/日志」。这是选 A 时要接受的前提。

---

## 2. 现有资产(比看起来小)

1. **codec 已就位且双射**:`uuidToBase62` / `base62ToUuid` / `toUuid`(`src/shared/src/codec.ts`),有 round-trip 测试。
2. **入方向已经做完了**:`PublicIdPipe` / `IsPublicId` 覆盖每个 id 形状的 param / query / body 字段,并且有一个用路由元数据反射的覆盖测试(`src/apiserver/src/common/public-id-coverage.spec.ts`)在新路由漏配时让构建变红。A 要补的只是**出方向**。
3. **出方向的机器已经有一个跑着的先例**:`WorkspaceAliasInterceptor`(注册于 `src/apiserver/src/main.ts:34`)已经在深度受限地遍历每个 JSON 响应做字段镜像。而且——因为 Nest 的 `@Sse` handler 走的是同一条 `next.handle()` 管道——它**顺带覆盖了 SSE 帧**,两个 SSE 端点(`sessions.controller.ts:424`、`events.controller.ts:28`)都在内。出方向不需要新架构,照抄这个拦截器即可。
4. **客户端 id 是 `String` 不是 `UUID` 类型**(Swift 侧 `public let id: String`)。所以换拼写不会让解码崩——它破坏的是**相等比较和本地持久化**,这是真正的风险面,也是沉默的那一类。

---

## 3. 核心规则:编码集必须等于解码集

这是整个方案里最容易做错、且做错了不报错的一点。

schema 里有 90 个 `@db.Uuid` 列、37 个不同字段名。**但"是 UUID 列"不等于"是 public id"**,今天的解码集是刻意排除了一部分的:

- **围栏/租约令牌 —— 绝不能编码**:`operationId`(由 `mergeOperationId` / `commitOperationId` 发出,见 `realtime.service.ts:779` 和 `:857`)、`leaseOwner` / `inboxLeaseOwner`(`runner-api.controller.ts:1158`)、`leaseGeneration`、`generation`。runner 会把它们**原样回传**(`runner-api.controller.ts:2735`、`:1190`),服务端用 `parseLeaseGeneration` 严格解析,再拼进裸 SQL 的 `::uuid`(`:1285`)。`public-id.ts:24` 已经明确把 `operationId` 列为"不是 public id"。
  出方向按"是 UUID 列"编码、入方向不解码 → 要么 400/500,要么**围栏比较永远不相等**。后者会复现"merge 卡 pending → takeover 409 → reclaim 死循环"那类整机停摆,而且日志上看不出是 id 拼写问题。
- **id 命名但根本不是 UUID —— 保持不动**:`clientTurnId`、`toolUseId`、`bundleId`、`runtimeSessionId`、`claudeSessionId`、`requestId`、`limitId`(清单见 `public-id.ts:20-26`)。

**做法**:把字段清单从散落的调用点提到 `@orbit/shared` 里的两个导出常量——`PUBLIC_ID_FIELDS`(编码 + 解码)和 `NEVER_PUBLIC_ID_FIELDS`(两边都不碰)——出入两侧读同一份。`public-id-coverage.spec.ts` 扩成双向断言:清单里的字段必须两边都接,不在清单里的 UUID 列必须两边都不碰。**新增一个 UUID 列而没归类,构建就红。**

---

## 4. 第二个坑:id 被当成持久化主键

换拼写会让两端的本地状态成为孤儿:

- web 的 transcript 缓存是 IndexedDB,keyPath 为 `['userId','sessionId','seq']`(`src/web/src/lib/transcriptStore.ts:190-194`);
- runner 直接拿 session id **当磁盘目录名**:`filepath.Join(runsDir(), sessionID)`(`main.go:607`、`session.go:324`),以及 uploads 目录和 `meta.json`。

**不要写数据迁移。** 正确做法是在存储边界归一:所有持久化 key 先过 `toUuid()`,让存储层永远保持 UUID 拼写,与线上说什么无关。runner 侧已经有现成的 `decodeSessionID`(`main.go:698`)。这样 phase 3 翻转时,本地缓存和 run 目录完全无感。

---

## 5. 分阶段

**Phase 0 —— 冻结规则(无线上变化)**
把 §3 的两份清单提到 `@orbit/shared`,覆盖测试改成双向断言。
验证:覆盖测试绿;响应字节不变。

**Phase 1 —— 服务端双发**
新增 `PublicIdInterceptor`,照 `WorkspaceAliasInterceptor` 的形状写、注册在它旁边:对编码集里的每个字段补一个 base62 孪生字段(`id` → `publicId`,`sessionId` → `sessionPublicId`…)。只补不覆盖——handler 自己写过的保持原样。
验证:一个 spec 打代表性端点 + 一帧 SSE,断言两种拼写并存且 `toUuid(publicId) === id`;围栏字段断言**没有**孪生。

**前置(phase 0 落地时发现):`turnId` 的出入两侧今天就不对称。**
`POST runner/sessions/:id/turn-complete` 的 body 是 `@Body() dto: TurnCompleteRequest`,而 `TurnCompleteRequest` 是 **interface**(`src/shared/src/dto.ts:958`)——全局 ValidationPipe 看不见它,这个路由也没挂 `PublicIdPipe.forFields`。于是 `dto.turnId` 原样进了 `where: { id: dto.turnId }`(`runner-api.controller.ts:2004`)。
同一个 `turnId` 在用户侧路由上**是**解码的(`sessions.controller.ts:179`),而且它由服务端发给 runner(`runner-api.controller.ts:1700`、`:1739`)后再被 runner 回传——一条完整的往返。phase 1 一旦编码 `turnId`,这条路径就会 `ack.count === 0`:turn 永远不落 `ANSWERED`,而且**不报错**,只是静默 `applied: false`。
所以 phase 1 的第一步不是写拦截器,是先给这个路由(以及其它 interface-DTO 的 runner 路由)补上 `PublicIdPipe.forFields('turnId', …)`。今天补是无害的(没人发 base62),phase 1 之后补就晚了。

**审计结果(已修):** 全量扫了 80 处 `@Body()` 和所有 DTO class,解码集共 **7 个缺口**,其中 6 个是**今天就存在的线上 bug**,不是 phase 1 才会激活的隐患:

| 位置 | 当时的装饰器 | 今天的症状 |
|---|---|---|
| `UpdateTaskListDto.foremanWorkspaceId` | `@IsUUID()` | 粘贴 base62 → **400**,报 "must be a UUID" |
| `BatchExecuteDto.taskIds` | `@IsString({each})` | base62 过校验后裸奔到 Prisma → **500**(P2023) |
| `BatchStopDto.taskIds` | 同上 | 同上 |
| `BatchAssignDto.taskIds` | 同上 | 同上 |
| `BatchAssignDto.assigneeId` | `@IsString()` | 同上 |
| `CreateTaskCommentDto.mentions` | `@IsString({each})` | 同上 |
| `TurnCompleteRequest.turnId` | 裸 `@Body()` | 今天无害;phase 1 后会静默 `applied:false` |

全部改成 `@IsPublicId`,并加了 `public-id-body-coverage.spec.ts` 把这两类缺口钉死——它是**源码级**扫描,因为接口类型在运行时已被擦除,反射看不见 body。

**Phase 2 —— 让客户端与拼写无关**(每端各自发版)· **已落地**

原计划是"各端改读服务端给的 `publicId`"。落地时发现这条路既贵又没必要:

**codec 是双射,而且三端都已经有它**。`encodeId(uuid)` 和服务端的 `publicId` 是同一个确定性函数的同一个输出——逐字节相同。所以"改读服务端的值"对用户零可见变化,只是把 27 个链接构造点各改一遍,换来 27 次漏改的机会。

真正需要的性质不是"读服务端的值",而是**客户端对拼写不敏感**。这便宜得多,也稳固得多:

| 改动 | 作用 |
|---|---|
| `encodeId` 改为幂等(先 `toUuid` 再编码) | 27 个链接点**一处不改**就能挺过 phase 3;否则 `id` 变 base62 后 `uuidToBase62` 会当场抛 |
| `transcriptStore.storageKey()` | IndexedDB 的 key 永远是 UUID 拼写,与线上说什么无关 |
| runner `runDir` / `uploadsDir` / `baseRefName` | 磁盘目录和 **git ref** 同理。base ref 尤其要紧:它不会报错,只会把每次 diff 悄悄基于错的 commit |
| Swift `PublicID.storageKey()` + `TranscriptStore.url(for:)` | 同上;Swift 原本没有 codec,新写了解码方向(编码方向没有调用者——原生端不构造 URL) |

**这也意味着 phase 1 的孪生字段对现有三端基本是冗余的**,它的价值集中在 phase 3:届时 `id` 本身变 base62,需要一个过渡期让新旧客户端都能取到自己认识的拼写。孪生字段留着,但别指望 phase 2 会去读它。

验证:web 432/432、runner `go test ./...` 全绿、新增 storageKey/idCodec/runner 三组键归一测试。Swift 的 128 位 base62 解码**用 20000 个随机 id 与 `@orbit/shared` 对拍过**(逐行转写成 JS 比对,零不符,含溢出与前导零边界),但 Swift 本身**未编译**——需要 client CI。

**Phase 3 —— 翻转 `id` 本身**·**已落地**

**最终形态:无条件翻转,没有协商。** `id` 就是 public id,不需要任何 header 或 query 去要。

(中间曾做过一版逐客户端 opt-in header,后被移除——一旦每个客户端都要发那个头,协商本身就只是噪音。)

**唯一的例外是 runner 协议(`/api/runner/*`),它保持 UUID。** 这不是兼容垫片,是**协议边界**:runner 上的 id 不是任何人会去链接的地址,而是**键**——它把 id 直接写进文件系统路径和 git ref 名(`refs/orbit-base/<id>`),旁边还并排走着逐字节比较的租约/围栏令牌。翻转它们不是改格式,是给**已经存在于本服务器管不到的机器磁盘上的状态重新做键**。

写这段时线上 `runner.version` 显示还有一台停在 **0.1.98**,比教会 runner 归一化拼写的那个版本落后十八个发布。对它而言,翻转会让在飞会话的 base ref 变成孤儿,而且是最安静的那种故障:不报错,只是之后每次 diff 都基于错的 commit。

这条边界没有过期日期要惦记,也不依赖任何人升级。

**Phase 3.5 —— 把这条边界从「路径前缀」收窄成「机器协议」**·**已落地**(2026-08-16)

上面那段把 `/api/runner/*` 整体当成了边界,但那个前缀底下其实住着两拨东西,只是共用路径和凭据:

| | Controller | 有没有拿 id 当键 | 谁在读响应 |
|---|---|---|---|
| 机器协议 | `RunnerApiController`(claim / reclaim / leases / events / finalize / worktree op) | **有**:scratch 目录、`refs/orbit-base/<id>`、逐字节比较的围栏 | runner 进程 |
| Agent 面 | `RunnerTasks` / `RunnerSessions` / `RunnerAgents` / `RunnerServiceTokens` | **没有** | 模型(`orbit mcp`)和人(`orbit` CLI) |

Agent 面在 runner 里是**纯透传**:`orbit mcp` 一律 `toolResult(prettyJSON(raw))`,CLI 一律 `writeCLIRawJSON`,响应体原封不动变成工具结果或 stdout。所以按前缀排除的实际效果是:**模型看到的每一个任务和会话都还是裸 UUID**——恰恰是这次迁移要消灭的那种东西。前缀从来不是边界,**做键**才是。

做法:`@MachineProtocol()` 标记类,拦截器读 `context.getClass()` 的元数据。**不能继续按路径分**,因为两拨在 URL 空间里交叉——`GET runner/sessions/claim` 是机器协议,`GET runner/sessions/:id` 是 agent 面,前缀测试分不开它们。`machine-protocol-split.spec.ts` 把这份名单钉成闭集:两个方向的错都不报错,标错了是 UUID 悄悄回到模型面前,漏标了是给活着的 runner 重新做键。

同时补上第三个入方向位置:**header**。`X-Orbit-Session-Id` / `X-Orbit-Workspace-Id` / `X-Orbit-Agent-Id` 此前完全没解码——`RunnerOrchestrationAuthorizer.assert` 拿它和令牌的 `sub` 逐字节比,`resolveAgentCreator` 直接拿它进 `where: { id }`。runner 注的一直是 UUID 所以没炸,但这意味着 header 这层是 UUID 锁死的。现在由一个三名字的中间件归一(`public-id-headers.ts`),放在 guard 之前。这是唯一一处**全局按名字**的归一,理由和别处相反:header 是个我们自己拥有的封闭三元组,不是那条塞满 `clientTurnId` / `toolUseId` 的线。

runner 侧则把 `ORBIT_SESSION_ID` / `ORBIT_AGENT_ID` / `ORBIT_TASK_ID` 改成注 base62(新增 `publicID()`,`decodeSessionID` 的逆,幂等)。**老 runner 不受影响**:它继续注 UUID,而服务端两种拼写都收——写这段时线上那台 0.1.98 仍在心跳。磁盘键那条路一行没动,仍然全程 `decodeSessionID`。

**web 的改造。** 做法不是逐个改比较,而是**把 web 的内部规范拼写整体换成 public id**——这样路由参数和 API id 两侧自然同拼写,那 103 处比较**一处未动**:

- `routeId()` 取代路由边界上的 `decodeId()`(12 处):把参数归一成 public id(旧的裸 UUID 书签照样能用)
- `decodeId` 保留,只服务于必须跨翻转保持稳定的存储键(`transcriptStore`)

**原生端(iOS/macOS)的改造:** 它们的 id 全部来自服务器、也没有地址栏,所以拼写翻转本身不需要它们配合。真正要改的是**跨"纪元"比较**的地方——一侧是旧构建写下的持久值,另一侧是服务器今天的拼写:

- `AppModel.swift` 冷启动恢复"上次用的 agent":`UserDefaults` 里存的 id 与 API 的 id 直接 `==`。拼写一变就静默失配,app 不报错,只是忘记你在哪个 agent 里、落到第一个。改成两侧都过 `PublicID.storageKey`,并且**选中的是匹配到的 agent 的当前 id**,不是记住的那个旧拼写字符串(否则下游比较会二次失配)。
- 转写缓存的文件名在 phase 2 已经归一,升级后仍能命中旧快照。

**为什么必须整体换而不能只翻一半(原始分析,现已解决):** web 原本把 UUID 当内部规范拼写——路由参数经 `decodeId` 归一成 UUID,再与 API 给的 `id` 比较。服务端一翻转,`s.id` 变 base62 而 `selectedId` 仍是 UUID,这些比较就会**静默**恒假:

- `WorkspaceView.tsx:1255` `sessions.find((s) => s.id === selectedId)`
- `WorkspaceView.tsx:1286` `sessionDetailQ.data?.id === selectedId`
- `WorkspaceConsole.tsx:36` `workspaces.find((a) => a.id === openWorkspaceId)`

全库 103 处 id 比较,其中 20 处涉及路由派生的 id。选定 base62 为内部拼写后,这 20 处两侧同时变成 base62,**因此一处都不用改**——`RunnerEngines.test.tsx` 的 fixture 是唯一暴露出来的,因为它绕过服务器直接注入 UUID id,正好演示了拼写不一致时故障有多安静:焦点行什么都不标,不报错。

验证(已做):`id`/嵌套/数组均翻转且 `toUuid(id)` 仍指向同一行、非 UUID 值不被改写、runner 协议整条路径保持 UUID(且仍收到孪生字段),以及本文要求的那条——**围栏令牌逐字节不变、往返穿过 `::uuid` 路径后仍相等**。

**Phase 4 —— 删掉孪生字段和 `encodeId`/`decodeId`。**

---

## 6. 风险与该知道的事

**Phase 3 的闸门目前不可测量。** 服务端**没有任何客户端版本上报**——搜遍 apiserver 没有 `appVersion` / `clientVersion` / UA 解析。只有 `Runner.version` 一个字段。也就是说 runner 什么时候全升完你知道,浏览器标签页和 TestFlight 装机量什么时候全升完**你无从判断**。

这不是假设性担忧,有现成的证据:`WorkspaceAliasInterceptor` 的注释白纸黑字写着 "DELETE THIS once every client in the field speaks `workspace*`",而它今天还在跑,phase 3-4 从没发生。**如果不先补客户端版本上报,A 的现实终局是:两个都带着过期日期、但都不会过期的迁移垫片。**

所以 phase 0 追加了一项前置,**已落地**:客户端在每个请求上带 `X-Orbit-Client: <kind>/<version>`,服务端按 (user, kind) 存一行(`client_version` 表,迁移 0101)。web 从 vite define 注入仓库版本;iOS/macOS 共用 `OrbitKit/Net/APIClient.swift` 一处;runner 不上报——`Runner.version` 已经答了,两个真相源迟早对不上。

写入是 fire-and-forget + 每小时节流(版本变化立即写),失败会撤销节流位以便下次重试——这张表的价值在于"空缺是可信的",一次失败静默致盲一小时比不做还糟。

phase 3 的闸门查询:
```sql
SELECT kind, version, count(*) FROM client_version
WHERE last_seen_at > now() - interval '30 days' GROUP BY 1, 2 ORDER BY 1, 2;
```
**注意:数据的价值随时间累积。** 现在开始记,phase 3 决策时才有一条完整的升级尾巴可看;等到要砍字段那天再建表,就得再等一个完整升级周期。

**其余代价**:4 次落地、跨 3 个发布中的客户端 + runner;phase 1→3 期间响应体多带一份 id 字段。

---

## 7. 备选(方案 B,未采纳)

保持 UUID 为 wire id,把 base62 严格限制成 URL 渲染形式,一致性体现在**规则**而非拼写:全系统恰好一个 encode 点、一个 decode 点,并照 `public-id-coverage.spec.ts` 的思路补一个出方向检查(禁止链接模板里出现未经 `encodeId` 的 id)。
成本约半天,无迁移,无版本闸门依赖。代码今天就是 B,只有 `src/web/src/pages/ProvidersPage.tsx:104` 和 `:107` 一处漏网。
未采纳原因:jianghailong 明确选 A,理由是系统一致性。
