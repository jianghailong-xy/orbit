# 个人访问令牌（PAT）：以用户身份做二次开发

状态：设计已定（2026-10-06），第 11 节四个问题所有者已答复，按第 10 节拆任务落地。
本文是执行会话的契约：写代码前读它；实现与本文冲突时，先在任务评论里说清楚再改，别悄悄偏离。

## 1. 问题

二次开发（自写脚本、内部系统集成、runner 机器上的 cron）需要**以用户本人的身份**读写 Orbit：
建任务、改任务、看项目、给会话发消息，写入要归到用户名下，而不是归到 agent 或机器。

今天能用的三种非浏览器凭证都不是用户：

| 凭证 | 身份 | 能力 |
|---|---|---|
| 会话凭证（`ORBIT_SESSION_ID` + 注入的签名凭证） | 某个 agent 会话 | 受编排开关约束；建任务/项目走确认卡 |
| runner 凭证（`~/.orbit/config.json` 的 `runnerToken`） | 机器 | 只碰本 runner 托管的会话，不能新建 |
| service token（`orbit token mint`） | 机器下属的无头进程 | 仅 `session:get/list/send/create`，钉在 runner + workspace |

唯一的用户凭证是 Web/App 登录得到的 JWT（`POST /api/auth/login`，`{sub,email}`，默认 7 天）加
一次性轮换的 refresh token。拿它做脚本有三个硬伤：

1. 要把**密码**放进脚本，或者自己保管、轮换 refresh token；两个进程并发刷新会触发
   「重放 = 盗用」，吊销该用户**所有**登录态（`auth.service.ts` 的 family revoke）。
2. access token 是对称 JWT，**无法单独吊销**，泄露后最长 7 天有效。
3. 它是**全权**的：没有 scope、没有 workspace 限定，并且和所有者在浏览器里的点击**不可区分**
   ——`docs/human-only-authority.md` 的矩阵里「Borrowed or minted owner JWT」那一行正是这个。

## 2. 目标与非目标

目标：

- 用户在设置页签发一个**有名字、有 scope、有到期、可单独吊销、能看到最近使用**的令牌。
- 令牌走现有用户 REST API（`/api/...`，`JwtAuthGuard` 那 41 个 controller），写入归属该用户。
- 服务端能区分「浏览器登录」与「PAT」两条通道，并把通道记进审计。
- `orbit` CLI 能以用户身份工作：`orbit login` / `whoami` / `logout`，一个通用 `orbit api`，
  再逐步让常用子命令支持用户模式。
- runner 机器上可以用，但**PAT 永远不进 agent 会话的环境**。

非目标：

- 不证明「人在场」。PAT 和 JWT 一样是 bearer 凭证，`human-only-authority.md` 的结论不变。
- 不做 OAuth 第三方应用授权、不做组织/团队级令牌（Orbit 是多用户、按 `ownerId` 自成租户，
  没有 workspace 成员概念）。
- 不扩大 service token；它继续服务「机器下属的无头进程」这一场景。
- MCP 不接 PAT。MCP 只在会话里跑，会话里的身份就是会话。

## 3. 凭证格式与存储

**不透明随机串，不用 JWT。**

```
orbit_pat_<43 字符 base64url>        # randomBytes(32)，256 bit
```

- 固定前缀 `orbit_pat_` 让 secret scanning（GitHub、gitleaks）能识别，也让 guard 一眼分流。
- 只存 `sha256(token)`；明文只在签发响应里出现一次。
- 不用 JWT 的理由：PAT 每次请求本来就要查库（吊销、到期、`lastUsedAt`），JWT 的无状态优势用不上；
  反而 JWT 可以被拿到 `JWT_SECRET` 的一方**凭空铸造**（N20 已在生产演示过），不透明串没有签发密钥可偷，
  只有数据库里的哈希。

新表 `personal_access_token`（迁移号按落地时 main 上的下一个编号）：

| 列 | 说明 |
|---|---|
| `id uuid` | 公开 id（`orbit token` 风格的列表、吊销用） |
| `owner_id uuid` → `user` `ON DELETE CASCADE` | 令牌只属于一个用户 |
| `name text` | 用户起的名字，必填，同一用户下未吊销的名字唯一 |
| `token_hash text UNIQUE` | `sha256` hex |
| `token_hint text` | 末 4 位，用于在列表里认出是哪一个 |
| `scopes text[]` | 见第 4 节 |
| `workspace_ids uuid[]` | 可空；非空时只能碰这些 workspace 下的对象 |
| `expires_at timestamptz` | 可空 = 永不过期；签发时默认 90 天（见第 11 节） |
| `created_via text` | `WEB` \| `CLI_DEVICE` |
| `last_used_at` / `last_used_ip` / `last_used_user_agent` | 节流写入，至多每 60 秒一次 |
| `revoked_at` / `revoked_reason` | `USER` \| `EXPIRED` \| `PASSWORD_CHANGED` \| `USER_DELETED` \| `ADMIN` |
| `created_at` | |

生命周期：

- 改密码 → **默认不**吊销 PAT（脚本不该因改密码全挂），但设置页改密码对话框给一个勾选
  「同时吊销所有访问令牌」。
- 用户被管理员删除 → 级联删除。管理员把用户降级不影响其 PAT（PAT 本来就拿不到 admin scope）。
- 每个用户最多 50 个未吊销令牌，超出返回 409，防止脚本循环签发。

## 4. Scope

按资源 × 读/写，粗粒度，便于用户理解；**默认拒绝**。

| scope | 覆盖 |
|---|---|
| `tasks:read` / `tasks:write` | 任务、任务清单、依赖、评论、附件上传 |
| `projects:read` / `projects:write` | 项目读写（不含第 5 节的所有者通道动作） |
| `sessions:read` | 会话列表、详情、事件、搜索 |
| `sessions:write` | 发消息、新建会话、interrupt、end、移动文件夹 |
| `workspaces:read` / `workspaces:write` | workspace（agent）与 provider 配置 |
| `runners:read` | runner 列表与状态（不含 rotate token / 注册审批） |
| `wiki:read` / `wiki:write` | wiki 条目 |
| `events:read` | `GET /events` SSE 流 |

设置页提供三个预设：**只读**（全部 `:read`）、**读写**（全部 scope）、**自定义**。

**永远不可授予**（PAT 打到这些路由一律 403，无论 scope）：

- `auth/*`（改密码、登出）、PAT 自身的签发与吊销 —— PAT 不能生出 PAT。
- `admin/*` —— 用户管理。
- runner 注册审批（`runners/device/:userCode/approve`）、runner token 轮换 —— 否则 PAT 泄露 = 能接管机器执行。
  同为准入入口的也算：enrollment token 的签发与列表（`runners/enrollment-tokens`）、
  设备码查询（`GET runners/device/:userCode`）。
- 第 5 节列出的所有者通道动作。
- 分享链接 —— 这是对外公开数据，留在浏览器里做。整个 controller 都拒绝，**读取也算**：
  读到的是公开 URL，令牌吊销后这个 URL 照样能用。

### 4.1 声明方式与拒绝码（2026-10-06 协调者确认的细化）

- `@PatScope(scope, { workspaceConfinable })` **只能挂在 handler 上**（第二个参数必填，见 6.3）：类型上是
  `MethodDecorator`，挂到 controller 上编译不过。
  controller 级的 scope 会让以后加进来的路由静默继承授权，普查就逼不出决定。`@PatForbidden(reason)`
  可挂 handler 也可挂 controller —— controller 级的拒绝是失败安全的；两者同时出现时拒绝优先。
- `@PatSelf()`（2026-10-06 协调者新增）：任何有效令牌都可调用，不看 scope、不做 workspace 判定，只挂 handler。
  全仓只有两条路由用它 —— 令牌自省 `GET /pat/self` 与令牌吊销自己 `DELETE /pat/self`（第 6.5 节）；普查双向钉住
  这两条，挂在第三条路由上或挂到 controller 上都会变红。优先级在拒绝与 scope 之后：同一 handler 上若也有
  `@PatForbidden` 或 `@PatScope`，以它们为准。
- PAT 被拒时的 403 body：

  | 情形 | body |
  |---|---|
  | 路由 `@PatForbidden(reason)` | `{code, reason, requiredAction: 'OPEN_ORBIT', message}`；`reason = OWNER_INTERACTIVE` 时 `code = OWNER_INTERACTIVE_CREDENTIAL_REQUIRED`（第 5 节），其余 `code = PAT_FORBIDDEN` |
  | 令牌没有路由要的 scope | `{code: 'PAT_SCOPE_MISSING', scope, message}`，消息写明缺哪个 |
  | 路由两者都没声明（fail-closed） | `{code: 'PAT_ROUTE_UNDECLARED', message}` |
  | 令牌限定了 workspace（第 6.3 节） | 路由不能按 workspace 判定：`{code: 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE', message}`；请求点名的对象越界：`{code: 'PAT_WORKSPACE_OUT_OF_SCOPE', fields, message}` |
  | 第 5 节的字段级拒绝 | 同 `OWNER_INTERACTIVE`，另带 `fields`（被拒的字段名） |

- 原因码全集（`PAT_FORBIDDEN_REASONS`，`src/apiserver/src/auth/pat-scope.decorator.ts`）。前六个是本节与第 5 节的
  「永远不可授予」，后四个是第 4 节 scope 表覆盖不到的路由：

  | reason | 路由 |
  |---|---|
  | `AUTH` | `auth/*` 里挂 `JwtAuthGuard` 的（`POST auth/change-password`；登录、刷新、登出本来就不经 guard） |
  | `ADMIN` | `admin/*`：用户与 provider 管理，含管理员列出、吊销某用户的访问令牌（第 11 节第 4 条） |
  | `TOKEN_MANAGEMENT` | PAT 自身的签发、列表、吊销（`/access-tokens*`，第 6.5 节），挂在 controller 上，以后加的路由也拒绝 |
  | `RUNNER_CREDENTIALS` | runner 准入与 token 轮换：`runners/device/:userCode`（查询与 approve）、`runners/enrollment-tokens`（签发与列表）、`runners/:id/rotate-token` |
  | `SHARE_LINK` | 分享链接整个 controller，含读取 |
  | `OWNER_INTERACTIVE` | 第 5 节所有者通道 |
  | `ACCOUNT` | 账号本身：`users/me*`（资料、头像、偏好）、push 设备注册与注销 |
  | `RUNNER_CONTROL` | runner 只有 `runners:read`，改动与驱动都在 App 里做：改名、排序、删除、引擎登录中继、装/卸引擎、引擎更新、刷新模型、账号管理、Claude 历史扫描、发起 Codex 限额重置 |
  | `SECRET_REVEAL` | 明文取回已存的密钥（`GET providers/mine/:id/key`） |
  | `NO_SCOPE` | v1 scope 集合没有对应 scope 的：watches、link-previews、metrics（v1 不加 scope）、outcomes/inbox |

- 每条挂 `JwtAuthGuard` 的路由都必须声明 `@PatScope`、`@PatForbidden` 之一（唯一的例外是那两条 `@PatSelf`），
  普查 spec `auth/pat-route-coverage.spec.ts` 逐条核对（第 6.2 节）。

## 5. 与所有者通道动作的关系

`human-only-authority.md` 说得很清楚：所有者 JWT 打来的请求今天被当作「所有者亲手操作」，
确认卡、证据裁定、审批答复都只靠这条门。如果 PAT 也能走这些门，等于把「borrowed owner JWT」
那一行从「可能被偷用」变成「官方支持的脚本化途径」，确认卡就失去了意义。

因此定义一组 `OWNER_INTERACTIVE` 路由，**只接受浏览器/App 登录凭证**，PAT 打来返回
`403 OWNER_INTERACTIVE_CREDENTIAL_REQUIRED`，`requiredAction: OPEN_ORBIT`：

- 任务确认卡的答复（`task-owner-confirmation.controller.ts`）
- 证据裁定（`task-completion-evidence.controller.ts` 的 decision）
- 会话审批答复（`sessions/:id/approvals/:approvalId/decision`）
- 项目标准集确认、验收标准变更裁定（`projects/:id/acceptance/confirmation`、`decideCriteriaChange`）
- 项目 promotion 确认（`project-promotion.controller.ts`）
- 项目 handoff 审批

这些门今天都靠「请求不带 `X-Orbit-Session-Id`」区分 agent 与所有者；PAT 引入后它们要多判一条
「凭证种类是 `LOGIN`」。这仍然**不是**人在场证明（偷到浏览器 localStorage 的照样能过），
只是不让官方脚本通道成为绕开确认卡的捷径。`human-only-authority.md` 的矩阵加一行：

| Request path | … | 所有者通道动作 |
| --- | --- | --- |
| Personal access token | 等同所有者 REST 的 `NON_JUDGMENT`，但记录 `credentialKind=PAT` | **refused**：`OWNER_INTERACTIVE_CREDENTIAL_REQUIRED` |

（已落地：该页矩阵的 Personal access token 一行按那里的列逐格写明，「Why credentials cannot prove "human"」一节
也写明 PAT 不改变那里的结论。）

实现上，「凭证种类是 `LOGIN`」这一条由 `JwtAuthGuard` 读路由上的 `@PatForbidden('OWNER_INTERACTIVE')` 判，
门自己的代码不变。设计列的门落在 9 条路由上（promotion 有 confirm / decline / cancel 三条）。按同一原则 ——
代码已对 agent 会话拒绝的、或只在没有 agent 门的地方回答「交给所有者的问题」的 —— 另标了 23 条
（2026-10-06 协调者确认）：

- 项目：`start`（启动即为标准集盖章）、`done`、`pause`、`resume`、`done-requests/:itemId/decline`；
- 交给所有者的问题：`GET acceptance/criteria-decisions/pending`（它发出裁定用的 `commitToken`）、
  `fuse/:episodeId/resume`、open-items 的 `answer` / `return-to-coordinator` / `resolve`；
- wiki 的所有者通道（对 agent 会话拒绝 `WIKI_OWNER_CHANNEL_ONLY`）：entries 的 `confirm` / `reject`，
  changesets 的 `decide` / `revert` 与 `GET changesets/:id`，`spaces/:id/verifications/reopen`，以及 wiki plan 全部 7 条
  （`GET plan`、`GET plan/versions`、`GET plan/versions/:version`、`POST plan/edits`、`POST plan/versions/:version/confirm`、
  `POST plan/redraft`、`POST plan-proposals/:id/decide`）。

第 3 步任务又追加 1 条：`PATCH /projects/:id/integration`。它的每个字段都是下面 5.1 里 `PATCH /projects/:id`
拒绝 PAT 的 `integration`（对 agent 会话也是 `INTEGRATION_SETTINGS_OWNER_ONLY`），不拒它，字段级规则换个 URL 就绕过去了。

完整清单共 33 条，在 `src/apiserver/src/auth/pat-owner-channel-routes.ts`。普查 spec `auth/pat-route-coverage.spec.ts`
双向精确核对装饰器与清单；`auth/pat-owner-channel.pg.spec.ts` 对生产 apiserver 逐门各一条：持全部 scope 的 PAT →
403 `OWNER_INTERACTIVE_CREDENTIAL_REQUIRED`、`requiredAction: OPEN_ORBIT`，同一请求换 LOGIN 由门自己回答；
能真实搭起来的门（标准集确认、start、done、pause、resume、integration）对 LOGIN 做了事，对 PAT 什么都没写。

### 5.1 混合路由：按字段拒绝

有些路由按 scope 放行，body 里却带着所有者通道的字段。路由级只能按 scope 放行，这些字段在 **service 层**按凭证种类判
（`refuseOwnerFieldsToToken`，与同一字段对 agent 会话的拒绝写在一处）：PAT 带了其中任何一个，**整个请求** 403
`OWNER_INTERACTIVE_CREDENTIAL_REQUIRED`，body 的 `fields` 列出被拒的字段，**不做部分写入**；不带这些字段时，
其余字段 PAT 照常可写。LOGIN 不经过这条规则，行为不变。

| 路由 | PAT 不可写的字段 |
|---|---|
| `PATCH /projects/:id` | `status`（`DONE` / `CANCELLED` / `OPEN` 都算）、`integration`、`acceptanceCriteriaItems`；项目授权集合 ◆ |
| `POST /projects` | `integration` ※；项目授权集合 ◆ |
| `POST /wiki/spaces` | `maintenance` |
| `PATCH /wiki/spaces/:id` | `reviewMode`、`maintenance`、`automaticSpotChecks` ※ |
| `PATCH /sessions/:id/config` | `permissionMode`，改成任何值都拒绝 |
| `POST /sessions/:id/resume` | `permissionMode` ※ |
| `POST /sessions` | `permissionMode`，任何值都拒绝 ◆ |

项目授权集合指 `automatic`、`coordinatorEnabled`、`maxConcurrentTasks`、`sessionBudgetPerDay`、`coordinatorAgentId`
五个字段，任何值都算，包括 `sessionBudgetPerDay`、`coordinatorAgentId` 用来清空的 `null`。

`permissionMode` 的任何改动都拒绝，往更严的模式改也一样：否则 PAT 能把会话切到绕过审批的模式，
「审批答复必须走 LOGIN」就失去意义。

※ 第 3 步任务按同一原则追加（同一字段的另一个门，或代码已以同一理由对 agent 会话拒绝），见该任务评论：
`POST /projects` 的 `integration` 对 agent 会话同样是 `INTEGRATION_SETTINGS_OWNER_ONLY`；`automaticSpotChecks` 与
`reviewMode`、`maintenance` 一样对 agent 会话拒绝 `WIKI_OWNER_CHANNEL_ONLY`；`resume` 复活已结束的会话时会重新套用
`permissionMode`，不拒它，config 的规则就能「先结束再带新模式复活」绕过去。

◆ 协调者 2026-10-06 决定新增的两项：

- **项目授权集合**（`POST /projects` 与 `PATCH /projects/:id`）。这几个字段决定 agent 能自主到什么程度：协调者是否替所有者
  做决定（Automatic）、同时能跑几个任务、一天能自己开几个会话、由谁来当协调者。runner 门已经对 agent 拒绝它们
  （`runner-projects.controller.ts` 的 `refuseGovernance`）；PAT 是脚本通道，同样不该替所有者改授权。service 层直接读
  `ProjectsService.AUTHORIZATION_FIELDS` 再加 `coordinatorAgentId`，与 runner 门同一份清单，授权集合以后加字段，PAT 也跟着拒绝。
  PAT 带任何一个，整请求 403，不建项目、`configRevision` 不动；不带时照常建项目（授权取默认值，与 LOGIN 不带时建的一样）、
  照常改其余字段。`POST /projects` 本来只收其中三个（`coordinatorEnabled`、`maxConcurrentTasks`、`sessionBudgetPerDay`；
  新项目的 Automatic 就是 `coordinatorEnabled`，协调者由 `workspaceId` 开在哪里决定），`automatic` 和 `coordinatorAgentId`
  过去被全局 whitelist 静默丢掉，PAT 带了会得到一个「不带它们的项目」。现在 `CreateProjectDto` 按 `PATCH` 的校验声明这两个字段，
  只为按名拒绝，谁带都不写入：LOGIN 带合法值仍照旧忽略（格式不对的值与 `PATCH` 一样 400）；runner 门的 `refuseGovernance`
  也因此按名拒绝 agent 带来的这两个字段，不再静默丢弃。
- **新建会话的 `permissionMode`**（`POST /sessions`）。理由与 `PATCH /sessions/:id/config` 相同：不拒的话，PAT 新建一个绕过审批的会话，
  就绕开了「审批答复只能走 LOGIN」。不带时按账号默认模式建会话：默认模式是所有者在设置里选的 `defaultPermissionMode`，
  PAT 改不了（`users/*` 对 PAT 是 `PAT_FORBIDDEN` `ACCOUNT`）；没选过的账号与 MCP 派生、任务运行等所有不指定模式的会话一样，
  落到服务端下限 `auto`（工作区内的改动与命令不询问）。

保持不变、PAT 照常可写的两项（协调者 2026-10-06 决定）：

- **新建项目时的首批验收标准**（`POST /projects` 的 `acceptanceCriteriaItems`）。确认标准集仍然只有 LOGIN 能做
  （`POST /projects/:id/acceptance/confirmation` 与 `start` 都是 `OWNER_INTERACTIVE`），PAT 写的标准不会自动生效为已确认；
  编辑已有项目的标准仍按上表拒绝。
- **wiki principle 类条目的写入**（`POST /wiki/spaces/:id/changesets` 经 PAT 以所有者身份写入，可以写 agent 不能写的
  principle）。它是内容，不是所有者通道的裁定，按 `wiki:write` 放行。

## 6. 服务端实现

### 6.1 Guard

不新增第二个 guard 让 41 个 controller 改装饰器，而是**扩展 `JwtAuthGuard`**：

```
Authorization: Bearer orbit_pat_…  → PatService.verify → req.user = {userId, email, credential: {kind:'PAT', tokenId, scopes, workspaceIds}}
Authorization: Bearer <jwt>        → 现状                → req.user = {userId, email, credential: {kind:'LOGIN'}}
```

- `?access_token=`（SSE）**不接受 PAT**：PAT 是长期凭证，不能进访问日志。CLI 能设 header，用不上 query。
- `AuthUser` 增加可选 `credential` 字段；现有只读 `userId` 的代码不受影响。
- verify：哈希查行 → 未吊销 → 未过期（`expires_at` 为空即不过期）→ 用户仍存在；`lastUsedAt` 节流、不 await（和 service token 一致）。
- 失败一律 `401 invalid token`，不区分「不存在 / 已吊销 / 已过期」，避免枚举；
  CLI 收到 401 时统一提示「令牌无效、已吊销或已过期，运行 `orbit login`」。

### 6.2 Scope 声明与普查

新装饰器（`@PatScope` 只挂 handler，`@PatForbidden` 可挂 handler 或 controller，见 4.1）：

```ts
@PatScope('tasks:write')       // PAT 需要此 scope
@PatForbidden('OWNER_INTERACTIVE') // PAT 一律拒绝，附原因
```

`JwtAuthGuard` 在 `credential.kind === 'PAT'` 时读元数据：

- 有 `@PatForbidden` → 403 及其原因码；
- 有 `@PatScope(s)` 且令牌不含 s → `403 PAT_SCOPE_MISSING`，消息写明缺哪个 scope；
- **两者都没有 → 403**（fail-closed）。新加的路由忘了声明，PAT 用不了，而不是默认放行。

配一条普查 spec（仿 `public-id-coverage.spec.ts` / db-write 普查的写法）：枚举所有挂了
`JwtAuthGuard` 的路由，断言每条要么有 `@PatScope` 要么有 `@PatForbidden`，并对第 4、5 节列出的
路由断言必须是 `@PatForbidden`。新增用户路由时这条 spec 逼作者做决定。

### 6.3 Workspace 限定

`workspace_ids` 非空时，在 scope 检查之后判定请求碰到的对象是否在令牌的 workspace 内。一次性改全太大，分两步：

1. v1：带 `workspace_ids` 的令牌**只能**访问按 workspace 能直接判定的路由
   （任务、会话、workspace 本身），其余路由在普查表里标 `workspaceConfinable: false`，限定令牌打来返回 403。
2. 之后按需补齐项目、wiki 的判定。

v1 的落地。最初设想由各 service 的读写入口过滤；实际做法是单对象路由由 JwtAuthGuard 按声明统一判定，
只有列表在 service 里收窄。理由见该任务的评论：几十个读写入口逐个过滤容易漏，统一判定之后漏声明会让普查变红。

- **归属**：任务看 `assignee_id`，会话看 `workspace_id`，workspace 就是它自己。未分配的任务、不属于任何 workspace
  的会话，不在任何令牌的范围内。
- **声明**：`@PatScope(scope, { workspaceConfinable })` 的第二个参数必填，取值有三种：
  - `false`：限定令牌一律返回 `403 PAT_ROUTE_NOT_WORKSPACE_CONFINABLE`。
  - `'LIST'`：由 handler 用 `workspaceConfinement(user)` 把列表收窄到令牌的 workspace。v1 只有 `GET /tasks`、
    `/sessions`、`/workspaces`（及别名 `/agents`）。
  - `{ params, body, requires }`：JwtAuthGuard 在 handler 运行前判定路径参数和请求体里点名的任务、会话、workspace。
    任何一个不在令牌的 workspace 内，就返回 `403 PAT_WORKSPACE_OUT_OF_SCOPE`，`fields` 列出越界的字段。
    「不存在」和「不属于该用户」也按越界处理，以免限定令牌借此探测对象是否存在。
- **按 id 点名的字段**：请求体或查询参数里按 id 点名其他对象、而该路由不判定的字段（`PUBLIC_ID_FIELDS`，例如
  `projectId`、`listId`、`parentTaskId`）一律拒绝。
- **创建类路由**：必须给出新对象落在哪个 workspace（`requires`）。`POST /tasks` 要 `assigneeId`，带 `verification`
  时还要 `verification.assigneeId`；`POST /sessions` 要 `workspaceId`。
- **普查 spec 的断言**：
  - 每条令牌可达的路由都声明了 `workspaceConfinable`；
  - 只有 tasks、sessions、workspaces 的路由可以 confinable；
  - 每条 confinable 路由解码出的每个 id（DTO 的 `@IsPublicId`，`PublicIdPipe` 的参数、查询、`forFields`）只能是以下三种之一：被判定；
    运行时会被拒；或者列在 `UNJUDGED_IDS` 里并写明理由，说明它不指向其他对象。
- **v1 不处理**：
  - 已放行对象的响应里嵌入的关联对象，例如任务详情里依赖任务的标题。
  - 经对象已有关系产生的连带影响，例如给一个 subject 在别处的 verifier 写 verdict，或删除一个被别处任务依赖的任务。
  - 分页任务列表、计数、搜索、事件流、附件、批量操作都是 `workspaceConfinable: false`。

### 6.4 归属与审计

- 写入照常记成该用户：`Task.creatorType = USER`、`creatorId = userId` 等，不新造 actor 类型，
  下游所有「是不是用户写的」的判断都不变。
- 额外记录**通道**：`Activity` 增加可空列 `credential_kind`（`LOGIN` | `PAT`）与 `credential_id`
  （PAT 的 id）。经 PAT 的写请求在现有 activity 写入点带上这两列。
  需要确认 `Activity` 覆盖了哪些写；没覆盖的写不在 v1 补，先在本文列出缺口。
  落地时确认（迁移 0384）：`activity` 在此之前**没有任何写入点**。所以 v1 新建了唯一一个写入点：
  用户通道建任务，即 `POST /tasks`（含带 `verification` 的成对创建）与 `POST /tasks/batch-create`。
  在写 task 行的同一事务里，每个新任务写一行：`type = 'task.created'`、`payload = {taskId}`、
  `actor_id = userId`。runner 通道建任务不记。其余用户写路由都不产生 activity，v1 不补。
  落地时共 186 条：PAT 可达 111 条，PAT 一律 403 的 75 条；逐条清单在落地任务的评论里。
  之后第 5 节把 `PATCH /projects/:id/integration` 改为对 PAT 一律 403，两数变为 110 与 76。
- **请求级审计**补上了 PAT 一侧的缺口：经 PAT 的每个写请求（POST / PUT / PATCH / DELETE）在应答发出之后
  写一行 activity，`actor_id = userId`、`credential_kind = 'PAT'`、`credential_id` = 令牌 id。
  - `type = 'pat.request'`：JwtAuthGuard 放行的请求。`payload = {method, route, status, params}`。
    `route` 是路由模板，写法同 §6.2 普查（`/tasks/:id`，不带 `/api`，不是带具体 id 的实际路径）。
    `status` 是应答的状态码，handler 答的 4xx、5xx 也照写。`params` 只取路径参数里指向行的那些
    （`:id` 和以 `Id` 结尾的），一律写成公开 id；`:token`、`:slug`、`:engine` 之类不记。
  - `type = 'pat.request.denied'`：因令牌无权而被拒的请求，即抛出 `PatRefusal` 的那些。包括 JwtAuthGuard 拒的
    （`@PatForbidden`、未声明、缺 scope、workspace 限定），也包括 §5 只有所有者能设的字段：这种请求已经过了 guard，
    是在 service 里被拒的。payload 在上面四项之外带拒绝码 `code`；拒绝体里有 `reason`、`scope`、`fields` 时一并带上，
    不带 `message`。其他拒绝，例如业务规则的 403、wiki 未开放的 404，不算越权，照样记 `pat.request` 和状态码。
  - 不记：读请求（GET 等），放行和被拒都不记；LOGIN 凭证的请求；401，那时令牌还没解析出来，不知道是谁的。
    请求体一律不读，正文、密钥这类内容不进审计。
  - 建任务的两条路由照常保留事务内的 `task.created`，请求级记录照样再写一行。两者用途不同，不去重。
  - 记录不属于请求本身：应答发出之后用一条单独的语句写入（autocommit INSERT，已登记 db-write-inventory）。
    写入失败只记一行日志，不重试，也改不了已经发出的应答。调用方不等应答就断开时同样记一行，`status` 为 null。
  - LOGIN 一侧不变：仍然只有建任务记 activity，上一条列的缺口在 LOGIN 一侧照旧。
- 设置页的令牌详情显示「最近使用」与最近 N 条经该令牌的 activity。

### 6.5 签发接口

```
POST   /api/access-tokens          {name, scopes[], workspaceIds?, expiresInDays}  → {id, token, ...}   仅 LOGIN 凭证
GET    /api/access-tokens          → {tokens: [...]}（不含明文）
DELETE /api/access-tokens/:id      → 吊销，幂等
```

三条都 `@PatForbidden('TOKEN_MANAGEMENT')`，挂在 controller 上（`auth/access-tokens.controller.ts`）。落地时的细节：

- `expiresInDays` 取 30、90、365 或 `null`（永不过期）；不传为 90（第 11 节第 1 条），其他值 400。`created_via = WEB`。
- 明文只在 `POST` 的应答里出现；列表每项是除哈希外的整行，外加 `state`（`ACTIVE` | `EXPIRED` | `REVOKED`，
  过了到期时间还没结算的也算 `EXPIRED`）和 `workspaces`（限定的 workspace 的名字，管理员查不到别人的
  workspace，所以由服务端给；已删除的不在其中）。新的在前，已吊销、已过期的也列出，设置页分两个标签显示。
- 管理员（第 11 节第 4 条）：`GET /api/admin/users/:id/access-tokens` 与上面同样的列表，
  `DELETE /api/admin/users/:id/access-tokens/:tokenId` 吊销并记 `revoked_reason = ADMIN`，幂等，令牌不属于该用户时 404。
  两条随 admin controller 是 `ADMIN`。
- 改密码（第 11 节第 3 条）：`POST /api/auth/change-password` 多一个可选 `revokeAccessTokens`，应答多一个
  `revokedAccessTokens`（本次吊销的个数）。勾选时先把已过期的结算为 `EXPIRED`，再把其余未吊销的记
  `PASSWORD_CHANGED`，然后才改密码：两步之间失败，令牌已按要求吊销、密码未变，重试即可完成；反过来则会留下
  新密码和本该吊销却仍有效的令牌。

令牌自省（2026-10-06 协调者新增，供 CLI `whoami` / `login --with-token`；`GET /users/me` 对 PAT 是 `ACCOUNT` 拒绝）：

```
GET    /api/pat/self               → {userId, email, token: {id, name, scopes, workspaceIds, expiresAt}}
```

- `@PatSelf`：任何有效令牌都可调用，不需要 scope；限定了 workspace 的令牌也可以（它只读令牌自己那一行）。
- 登录凭证调用返回 400 `NOT_A_PERSONAL_ACCESS_TOKEN`；已吊销、已过期、不存在的令牌照常 401。
- 路径不在 `/access-tokens*` 与 `auth/*` 之下：这两个前缀对 PAT 都是 Forbidden。
- 请求级审计（第 6.4 节）对它与其余路由用同一条判定：guard 在判定声明之前就把请求交给审计，审计只看方法。
  `GET /pat/self` 是读，不记；`DELETE /pat/self` 是写，照常记 `pat.request`。

令牌吊销自己（2026-10-06 协调者决定，CLI 任务落地；第 7.3 节 `orbit logout` 默认同时吊销服务端令牌，而令牌调不了
`/access-tokens*`）：

```
DELETE /api/pat/self               → {id, revokedAt, revokedReason}
```

- 同为 `@PatSelf`：任何有效令牌都能吊销自己，不需要 scope，限定了 workspace 的也可以。只吊销发起请求的那一把，
  `revoked_reason = USER`（与设置页里吊销同一记法），同一用户的其他令牌不受影响；吊销之后这把令牌的下一个请求就是 401，
  再调一次 `DELETE /pat/self` 也是 401。
- 登录凭证调用返回 400 `NOT_A_PERSONAL_ACCESS_TOKEN`，什么都不吊销。
- 普查 `auth/pat-route-coverage.spec.ts` 双向钉住恰好这两条 `@PatSelf` 路由；`auth/access-tokens.pg.spec.ts` 第 (9) 条
  对生产 apiserver 证明以上各点，并断言这次吊销记了一行 `pat.request`。

## 7. CLI

### 7.1 凭证存放

- 新文件 `$ORBIT_HOME/user.json`（默认 `~/.orbit/user.json`，`0600`，目录 `0700`），
  字段 `{serverUrl, token, tokenId, name, email}`。**和 runner 的 `config.json` 分开**：
  runner 服务进程读 `config.json`，从不读 `user.json`。
- 环境变量 `ORBIT_USER_TOKEN`（加可选 `ORBIT_SERVER_URL`）优先于 `user.json`，给 CI / 容器用。
- 没有注册 runner 的机器也能用：`user.json` 自带 `serverUrl`，用户模式不依赖 `config.json`。

### 7.2 身份选择顺序

```
1. ORBIT_SESSION_ID 存在            → 会话身份（现状）。此时忽略 PAT，并在 stderr 提示一次。
2. ORBIT_SERVICE_TOKEN 存在         → service token（现状）
3. ORBIT_USER_TOKEN 或 user.json    → 用户身份（新）
4. config.json 的 runnerToken       → runner 凭证（现状）
```

第 1 条是关键：在会话里，agent 不能因为机器上有人 `orbit login` 过就变成用户。这只是纵深防御
（同一 OS 用户下 agent 能读 `user.json`，见第 8 节），但它保证**正常路径**下不会串身份。

`orbit whoami [--json]` 打印当前生效的是哪一种身份、为什么（哪一条命中）、用户邮箱、令牌名、scope、到期。

落地时（CLI 任务，2026-10-06）：

- 解析在 `src/runner-go/user_identity.go` 的 `resolveCLIIdentity`，只读环境变量与 `$ORBIT_HOME`，不发请求。某一条「存在」就由它决定，
  哪怕它不可用：`user.json` 读不了（权限不是 0600/0700、不是普通文件、不是合法 JSON、缺 token 或 serverUrl）时报出问题，
  **不**落到 runner 凭证。`user.json` 与 `config.json` 一样只在私有存储里才用：别人能写的文件可能写了别人的服务器地址。
- 会话内若手边有 PAT（`ORBIT_USER_TOKEN` 或 `user.json`），stderr 每个进程只说一次。`capabilities --json` 的 `identity`
  用同一个解析函数，但不往 stderr 写；会话里它带 `userTokenIgnored: true`。
- `ORBIT_SERVER_URL` 只跟 `ORBIT_USER_TOKEN` 一起用；没设时发往本机 runner 的服务器，再没有就是二进制内置的服务器。
  `user.json` 里的令牌永远只发往它自己的 `serverUrl`。
- 与现有代码的出入（已在任务评论里说明）：`orbit session` 子命令与 capabilities 的 headless 门在会话内仍让
  `ORBIT_SERVICE_TOKEN` 优先，两者同时设置时 `whoami` 报会话、`orbit session list` 用 service token。统一交给子命令移植任务。

### 7.3 命令

```
orbit login [--server URL] [--name NAME] [--scopes PRESET|LIST] [--expires 90d|never]   # 设备流，见下
orbit login --with-token [--server URL]                                            # 从 stdin 读已签发的令牌
orbit logout [--keep-token]                                                        # 默认同时吊销服务端令牌
orbit whoami [--json]
orbit api [-X METHOD] PATH [--data JSON | --data-file -] [--paginate] [--json]     # 类 gh api
```

- `--with-token` 只从 stdin 读，遵守仓库已有约定（`--body-file` 只认 `-`），令牌不进 shell 历史。
- **设备流**复用 runner 注册已有的形状（`runner-api.controller.ts` 的 `device/start` / `device/poll`、
  Web `/enroll?code=`）：`orbit login` 申请一个 user code、打开浏览器，Web 上展示请求的名字、scope、到期，
  用户确认后签发 PAT（`created_via = CLI_DEVICE`），CLI 轮询拿到。确认页走 LOGIN 凭证，
  所以「签发 PAT」这一步永远由浏览器里的人点。
- `orbit api` 是 v1 的主力：二次开发要的是 REST 面，先给一个能打任意 `/api/...` 的出口，
  不必等子命令逐个移植。
- 已有子命令（`task`、`project`、`session`…）今天打的是 `/api/runner/...`。用户模式下逐个改为打用户路由，
  按使用频率排期（第 10 节）；未移植的子命令在用户模式下报错并提示用 `orbit api`，**不**静默退回 runner 凭证。

落地时（CLI 任务，2026-10-06）：

- `orbit login` 不带 `--with-token` 时走设备流（见下面「落地时（设备流任务）」）。`--with-token` 读 stdin 第一行，必须以 `orbit_pat_` 开头；
  令牌出现在参数里直接拒绝，也不回显。先 `GET /pat/self` 核对，401 不写文件；成功后原子写入 `user.json`
  `{serverUrl, token, tokenId, name, email}`（`name` 是令牌名）。服务器默认值依次是 `--server`、`ORBIT_SERVER_URL`、
  已保存登录的服务器、本机 runner 的服务器、内置服务器。
- 第 8 节的警告：`$ORBIT_HOME` 里有带 `runnerToken` 的 `config.json` 就打印一次。runner 从它的 `ORBIT_HOME` 读
  `config.json`，`user.json` 写在同一个 0700 目录里，能读前者的服务就以同一 OS 用户（或 root）运行，它起的 agent 也一样。
- `orbit logout` 默认 `DELETE /pat/self` 再删 `user.json`。服务器连不上或答非 2xx/401 时什么都不删，提示重试或
  `--keep-token`；401 说明令牌已无效，照样删文件。`ORBIT_USER_TOKEN` 不归它管，只提示 unset。
- 在会话内，`login`、`logout` 直接拒绝，`orbit api` 也拒绝（会话凭证打不了用户路由，也不拿 PAT 顶上）。
  service token 或只有 runner 凭证时，`orbit api` 同样拒绝，不借用其他凭证。
- `orbit api`：PATH 只接受路径（`/api/tasks`、`api/tasks`、`tasks` 等价），拒绝 URL 与跳出 `/api` 的路径，令牌只发往它所属的
  服务器，并且不跟随换 scheme 或 host 的重定向。带 body 默认 POST，`GET` 不带 body；`--paginate` 只用于 GET，跟随
  `{items, nextCursor}` 的 `cursor` 查询参数，逐页打印。非 2xx 先打印应答再以非零退出；401 统一提示令牌无效、已吊销或
  已过期，运行 `orbit login`。
- `orbit capabilities` 列出 `login`、`logout`、`whoami`、`api` 四条，均为 `HeadlessOnly`（会话里不提供给 agent），
  各带自己的 input schema。`cli_mcp_parity_test.go` 只要求每个 MCP 工具有 CLI 命令，不要求反向；
  `cli_help_flag_coverage_test.go` 现在也检查单命令（`orbit api --help` 等）的帮助文本。
- 本任务没有让未移植的子命令在用户模式下报错，那是子命令移植任务的验收条目。

落地时（设备流任务，2026-10-06）：

- 路由都在 `/api/access-tokens/device` 下（`auth/pat-device-login.controller.ts`）。`POST start`、`POST poll` 不需要凭证：
  device code 只有 CLI 持有（库里只存 sha256），它就是轮询的凭证。`GET :userCode`、`POST :userCode/approve`、`POST :userCode/deny`
  走 JwtAuthGuard，controller 级 `@PatForbidden('TOKEN_MANAGEMENT')`，令牌一律 403：批准就是签发，令牌不能签发令牌。
  普查的 `/access-tokens*` 规则也钉住这三条。查询、批准、拒绝按用户限流（5 分钟 20 次），与 runner 的设备码查询一致。
- **令牌在批准之后、CLI 下一次轮询时才签发**，不在批准时签发再暂存（runner 流程把 runner 凭证明文暂存在行里，等 CLI 取走）。
  批准只记录谁、何时批准。轮询先用 CAS 把请求从 APPROVED 改成 DELIVERED，再以批准者的名义签发（`created_via = CLI_DEVICE`）。
  明文只出现在这一次轮询应答里，§3「只存 sha256、明文只出现一次」照样成立。并发或重试的轮询拿不到第二个令牌，只得到 `delivered`。
  签发被拒时（批准之后名字被占，或到了 50 个上限）撤回认领，把 409 答给 CLI。批准时先按同样的规则查名字与上限，浏览器里就能看到 409。
  CLI 在批准前退出的话，令牌不会签发。
- 新表 `pat_device_login`（迁移 0388；当时 main 最高是 0386，0387 被另一条在途分支占用）：请求的名字、scope、天数（NULL = 永不过期）、主机名，
  状态 `PENDING | APPROVED | DENIED | DELIVERED`，决定者与决定时间，请求自身 10 分钟的到期。决定者被删除时级联删除。
- 轮询应答 `{status}`：`pending`、`approved`（带签发应答的全部字段，含 `token`）、`denied`、`expired`、`delivered`。
  已拒绝、已取走的请求过了 10 分钟仍如实回答；已批准却没在 10 分钟内取走的答 `expired`，不再签发。
  过期请求的查询、批准、拒绝都是 404。拒绝过的再批准、已批准的再拒绝是 409 `PAT_DEVICE_LOGIN_DECIDED`；
  同一个人重复同一决定，照原样回答。
- `start` 按签发的规则校验：名字去掉空白后非空、至多 100 字符；`scopes` 列表与 `preset`（`read-only` | `read-write`，
  由服务端按 `PAT_SCOPES` 展开）二选一；`expiresInDays` 取 30、90、365 或 `null`，不传为 90。
- Web `/cli-login?code=`（`pages/CliLoginPage.tsx`）与 `/enroll` 同构，未登录先跳登录页再回来。页面展示令牌名、scope（摘要加逐条）、
  到期（天数与大致日期；永不过期时加标记和警告）、来源主机名、用户码，以及 Approve、Deny 两个按钮。
  名字已被自己的有效令牌占用时说明原因，Approve 不可点。
- CLI：`orbit login [--server URL] [--name NAME] [--scopes PRESET|LIST] [--expires 30d|90d|365d|never]`。默认名字是
  `orbit CLI on <主机名>`，默认 `read-only`、`90d`，与设置页新建对话框的默认一致。链接和用户码打印到 stderr，并尝试打开浏览器；
  按服务端给的间隔轮询，网络错误、5xx、429 视为暂时性的。拿到令牌后与 `--with-token` 走同一条路径：`GET /pat/self` 核对后写 `user.json`。
  `--name`、`--scopes`、`--expires` 与 `--with-token` 同时出现时拒绝。start 与 poll 不带 `Authorization` 头。
- 401 等提示里的「运行 `orbit login --with-token`」改为「运行 `orbit login`」。

### 7.4 能力与一致性

- `orbit capabilities --json` 增加 `identity` 字段（与 `whoami` 同源），各命令标注当前身份下是否可用。
- `cli_mcp_parity_test.go` 校验的是「CLI 覆盖每个 MCP 工具与参数」；`login`/`whoami`/`api` 是 CLI 独有，
  不需要 MCP 对应项。落地时确认 parity 测试不要求反向覆盖。

## 8. runner 机器上的隔离

用户在 runner 机器上 `orbit login` 是被支持的场景，必须保证 agent 拿不到这把钥匙：

1. **环境剥离**：所有给 agent 子进程拼环境的地方（`claude_spawn.go`、`codex_appserver.go`、`kimi_acp.go`、
   `antigravity.go`、`dsh_mcp.go`、`background_job.go`、`wiki_maintenance_session.go`）在注入 `ORBIT_*`
   之前删掉 `ORBIT_USER_TOKEN`。加一条测试枚举这些构造点，断言输出里没有它。
2. **文件**：`user.json` 是 `0600`。runner 服务若以同一 OS 用户运行，agent 仍然能读到它——
   这一点要在 `orbit login` 输出与文档里**直说**，并建议：
   - 在 runner 机器上用单独的 OS 用户做二次开发；或
   - 给该机器上的令牌只发需要的 scope、加 `workspace_ids` 限定、短到期。
3. `orbit login` 检测到本机是已注册 runner 且当前 OS 用户与 runner 服务相同，打印上述警告一次。

这与 `human-only-authority.md`「进程与主机隔离」一节同一立场：凭证层面的措施是纵深防御，
硬边界只能靠 OS 身份隔离。

## 9. 客户端

- **Web**：设置页新增「Access tokens」卡片 → `settings/access-tokens`（与 `settings/shared-links` 并列）。
  列表列：名字、scope 摘要、workspace 限定、到期、最近使用（时间 + IP）、创建方式；操作：新建、吊销。
  新建对话框：名字、预设/自定义 scope、workspace 多选、到期（30/90/365 天 / 永不过期，默认 90 天；选永不过期时
  对话框写明「泄露后在吊销前一直有效」，列表里该行显示 `Never expires` 标记）；签发后只展示一次明文 + 复制按钮 +
  「离开后无法再查看」提示。设备流确认页 `/cli-login?code=` 与 `/enroll` 同构。
  落地时：列表分「Active」与「Revoked & expired」两个标签，后者写明结束原因（被管理员吊销、随改密码吊销、过期）；
  自定义 scope 里勾「写」会连带勾「读」，取消「读」会连带取消「写」。明文只存在于签发请求的应答里（不进查询缓存，
  离开页面即释放），显示在列表上方，点 Done 或离开页面后不再可见。改密码在个人资料页（Profile）的
  Change password 卡片里，勾选框默认不勾。管理员的 Users 页每个用户有 Access tokens 按钮，打开该用户的令牌列表并可吊销。
- **iOS / macOS**：v1 只做列表与吊销（丢手机/电脑时能远程吊销），不做签发。

## 10. 落地顺序（建议拆成的任务）

| # | 内容 | 依赖 | 验收 |
|---|---|---|---|
| 1 | 表 + 迁移、`PatService`（签发/校验/吊销/节流）、`JwtAuthGuard` 分流、`AuthUser.credential` | — | apiserver spec：签发→调用→吊销→401；过期；改密码行为 |
| 2 | `@PatScope` / `@PatForbidden`、fail-closed、普查 spec，给全部用户路由标注 | 1 | 普查 spec 绿；第 4、5 节路由全为 Forbidden |
| 3 | 所有者通道动作拒绝 PAT（第 5 节）、`human-only-authority.md` 矩阵加行 | 2 | 每个门一条 PAT → 403 的 spec |
| 4 | `/api/access-tokens` 接口 + Web 设置页；管理员列出/吊销他人令牌；改密码对话框的吊销勾选 | 1 | Web 测试 + 截图 |
| 5 | CLI：`user.json`、身份顺序、`login --with-token`/`logout`/`whoami`/`api`；agent 环境剥离 | 1 | Go 测试：身份顺序表驱动、环境剥离枚举 |
| 6 | 设备流 `orbit login`（API + Web 确认页 + CLI 轮询） | 4、5 | 端到端：隔离栈上走通 |
| 7 | 审计：`Activity.credential_kind/credential_id`、令牌详情页最近活动 | 1 | spec：经 PAT 的写入带 credential |
| 8 | CLI 子命令用户模式移植：`task` → `project` → `session` | 5 | 每个子命令在用户模式下的 Go 测试 |
| 9 | workspace 限定（第 6.3 节 v1） | 2 | 限定令牌越界 403 的 spec |
| 10 | iOS/macOS 列表与吊销 | 4 | client.yml 两 job success |
| 11 | 文档：`runner-cli.md`、`configuration.md`、`self-hosting.md` | 5 | — |

1→2→3 是安全底座，必须先于 4（在 2、3 落地前开放签发，PAT 会默认拿到全部路由）。

## 11. 所有者决定（2026-10-06）

1. **到期**：允许永不过期。默认 90 天，签发时可选 30 / 90 / 365 天或永不过期；永不过期要在对话框里明示风险，
   列表里单独标出。
2. **所有者通道动作**：不提供任何 scope 放开。第 5 节的路由对 PAT 永远 403。
3. **改密码**：默认不吊销 PAT，改密码对话框提供「同时吊销所有访问令牌」勾选（`revoked_reason = PASSWORD_CHANGED`）。
4. **管理员**：管理员可以列出并吊销其他用户的 PAT（`revoked_reason = ADMIN`），看不到明文（本来也不存）。
   对应管理接口挂在 `admin/*` 下，PAT 不可调用。

service token 保留：它钉在 runner、不代表用户；`runner-cli.md` 写清两者的选择标准——
代表「这台机器上的某个集成」用 service token，代表「我本人」用 PAT。
