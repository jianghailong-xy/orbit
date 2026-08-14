# 设计文档:把 base62 public id 变成 API 的 id(方案 A)

状态:草案 · 2026-08-14 · **Phase 0 / 1 / 2 已落地**(分类清单 · 双向覆盖测试 · 客户端版本上报 · 服务端双发 · 三端拼写无关)· **Phase 3 服务端机制已落地但无客户端启用**(改为逐客户端 opt-in,默认行为完全不变)· phase 4(删 UUID 那半)须等 `client_version` 有数据 · **全部未部署**
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

**Phase 3 —— 翻转 `id` 本身**·**服务端机制已落地,无客户端启用**

原计划是"等版本下限说明旧构建消失后全局翻转"。改成了**按客户端逐请求选择加入**:客户端发 `X-Orbit-Id-Format: public`,该响应里 `id` 及所有 public id 字段就是 base62;不发的一律照旧。

为什么让客户端声明而不是服务端按 `X-Orbit-Client` 版本推断:版本阈值要配、要解析、要比较,每一步都是一次对"某个没人记得的构建"猜错的机会——一个开了一个月的浏览器标签页是在它主人刷新时升级,不是在某个配置说升级时。**客户端是唯一知道自己能解析什么的一方,所以由它来说。** `client_version` 于是专职回答另一个问题——UUID 那条路什么时候能删——这本来就是它建出来的目的。

好处是这条路没有"翻转日":每端各自准备好各自 opt-in,出问题只回滚那一端,不需要全局闸门,也不需要赌。

**web 已 opt-in(本轮完成)。**

做法不是逐个改比较,而是**把 web 的内部规范拼写整体换成 public id**——这样路由参数和 API id 两侧自然同拼写,那 103 处比较**一处未动**:

- `routeId()` 取代路由边界上的 `decodeId()`(12 处):把参数归一成 public id(旧的裸 UUID 书签照样能用)
- 三条传输全部 opt-in:REST 发头;**两条 SSE 发 query**
- `decodeId` 保留,只服务于必须跨翻转保持稳定的存储键(`transcriptStore`)

**服务端为此补了 query 形式的 opt-in。** `EventSource` 根本设不了头(这也是 token 被迫走 `?access_token=` 的原因)。没有它,opt-in 的 web 会从 REST 拿到 base62、从自己的事件流拿到 UUID——一个页面里同一个 session 两种拼写,正是这次迁移要消灭的状态。

⚠️ **部署耦合(重要):** web 的 opt-in **不能先于**服务端的 `idFormat` query 支持上线。当前线上的 apiserver 只有 header 形式,没有 query 形式——两者必须同批部署。测试 `the public-id opt-in covers every transport` 钉住了 REST 与 SSE 必须成对,但钉不住跨服务的版本顺序。

**原生端与 runner:建议不 opt-in。** 它们的 id 只有一个来源(服务器)、也没有地址栏,翻转拼写对它们零收益、纯风险;存储键在 phase 2 已经与拼写无关了。**只有 web 从中受益,因为只有 web 有 URL**——这恰好是"逐客户端 opt-in"比"全局翻转"对的地方。

**原先记录的前提(现已解决):** 不是加个 header 就行。web 目前把 UUID 当内部规范拼写——路由参数经 `decodeId` 归一成 UUID,再与 API 给的 `id` 比较。一旦 opt-in,`s.id` 变 base62 而 `selectedId` 仍是 UUID,这些比较会**静默**恒假:

- `WorkspaceView.tsx:1255` `sessions.find((s) => s.id === selectedId)`
- `WorkspaceView.tsx:1286` `sessionDetailQ.data?.id === selectedId`
- `WorkspaceConsole.tsx:36` `workspaces.find((a) => a.id === openWorkspaceId)`

全库 103 处 id 比较,其中 20 处涉及路由派生的 id。选定 base62 为内部拼写后,这 20 处两侧同时变成 base62,**因此一处都不用改**——`RunnerEngines.test.tsx` 的 fixture 是唯一暴露出来的,因为它绕过服务器直接注入 UUID id,正好演示了拼写不一致时故障有多安静:焦点行什么都不标,不报错。

验证(已做):默认形状不变、opt-in 后 `id`/嵌套/数组均翻转且 `toUuid(id)` 仍指向同一行、非 UUID 值不被改写,以及 doc 要求的那条——**opt-in 状态下围栏令牌逐字节不变、往返穿过 `::uuid` 路径后仍相等**。

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
