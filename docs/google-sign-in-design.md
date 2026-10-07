# Google 账号登录：设计方案

状态：设计已定（2026-10-06）。所有者已答复第 12 节前三个问题：开放注册、Google 权威邮箱自动关联、四端一起；
第 4 个问题（orbitd.io 上线安排）待定。已建为 Orbit 项目「Google 账号登录与开放注册」，任务按第 11 节拆分。
本文是执行会话的契约：写代码前读它；实现与本文冲突时，先在任务评论里说清楚再改，别悄悄偏离。

> 范围：本文讲的是**用 Google 账号登录 Orbit 本身**（Web、iOS、macOS、Android）。它和已上线的
> 「Antigravity 用 Google 登录」无关——那是 runner 上的引擎凭据（`src/runner-go/antigravity_google*.go`、
> Web `RunnerSignIn`），登录的是 agy CLI，不是 Orbit 账号。两者不共用代码、配置或数据。

## 1. 现状

| 方面 | 今天 |
|---|---|
| 登录方式 | 只有邮箱 + 密码：`POST /api/auth/login`（`auth.service.ts`）。邮箱精确匹配，区分大小写（`User_email_key` 建在原值上） |
| 开户 | 没有自助注册。首个用户经 `/setup` 的 `POST /auth/bootstrap` 成为 ADMIN（先到先得）；其余由管理员在 Admin → Users 按邮箱建，系统生成一次性密码，由管理员转交（`users.util.ts#createOrResetUser`） |
| 凭证 | JWT access（`{sub,email}`，默认 7 天，`ACCESS_TOKEN_TTL`）+ 不透明的轮换 refresh token（30 天滑动，只存哈希，重放即吊销整族） |
| Web | SPA 与 `/api` 同源（gateway nginx）；token 存 localStorage（`orbit_token` / `orbit_refresh`）；`/login?next=` 回跳由 `LoginPage.tsx` 的 `loginDestination` 只放同源路径 |
| iOS / macOS | `LoginView` 只有邮箱、密码；实例默认 `orbitd.io`（隐藏面板可改）；token 按 host 存 Keychain；两端都已注册 `orbit://` scheme，`DeepLink.parse` 只认 session/task/list/runner/watch/active |
| Android | 实例地址由用户填写（必须 HTTPS）；token 用 Keystore 加密存文件；没有任何深链接 intent-filter；还没有 release 签名，APK 直装 |
| CLI | `orbit register` 走设备流，批准页是 Web 的 `/enroll?code=`；PAT 设计里的 `orbit login` 同构（`/cli-login`，未落地）。两者都只要求浏览器已登录 |
| 配置 | 只有环境变量（`.env` → compose），没有存在库里的实例设置。compose 的 apiserver 段被 `test/compose-topology.test.mjs` 钉在一个已审提交上，新增变量要所有者重新审 |
| 定位 | 自建产品（README：not a managed SaaS）。`self-hosting.md` 写明没有自助注册，其余用户由管理员开。orbitd.io 是一个多用户的单实例 |

`User.passwordHash` 是 NOT NULL；没有邮箱验证、邀请、停用账号的概念；管理员删不掉仍拥有 runner、workspace 或任务的用户
（`admin.controller.ts` 的删除会因外键失败）；认证路由没有限流。

## 2. 目标与非目标

目标：

- 用 Google 账号登录 Web、iOS、macOS、Android。登录结果与密码登录**完全同形**：同一对 access/refresh token、
  同一 `LOGIN` 凭证种类，下游代码不需要知道人是怎么登录的。
- **开放注册**：管理员在管理区把注册策略设为「开放」后，任何 Google 账号第一次登录即自动开户（MEMBER，无密码）。
  默认是「仅已有账号」，所以自建部署启用 Google 登录不会顺带对外开放注册；orbitd.io 按所有者的决定打开（5.6）。
- 已有账号按邮箱自动关联（只限 Google 权威邮箱，5.2）；用户可以在个人资料页手动关联、解除关联；
  管理员可以建「只用 Google 登录」的账号。
- 管理员可以停用账号。开放注册之后，这是处置滥用的手段（5.5）。
- 自建部署用自己的 Google OAuth 客户端即可启用：管理员在 Web 管理区填写，不改部署文件、不重启（7.1）。
  没配置时一切与今天相同，登录页不出现 Google 按钮。
- CLI 不改：设备流的批准页在浏览器里，浏览器能用 Google 登录，CLI 就自然支持。

非目标（v1）：

- 不替代密码登录。有的用户所在网络访问不了 Google，密码登录必须一直可用。
- 不做邮箱 + 密码的自助注册：没有发信设施，也没有邮箱验证。自助注册只经 Google，由 Google 担保邮箱已验证。
- 不拿 Google 的 access/refresh token，不申请 `openid email profile` 以外的 scope，不调用任何 Google API。
- 不做通用 OIDC、SAML 或其他身份提供方。数据模型留了 `provider` 列，但只实现 Google。
- 不改 `/setup`：第一个管理员仍用邮箱密码建，之后再关联 Google。
- 不引入 Google 的客户端 SDK（GIS JS、GoogleSignIn-iOS、Credential Manager），理由见 3.1。
- 不做按 Workspace 域名开户；以后需要时给注册策略加第三档即可。
- 不做按用户的资源配额、注册量日上限、用户自助删除账号（5.6 列为开放后的观察项）。

## 3. 方案总览

### 3.1 为什么是服务端授权码流程

| 方案 | 做法 | 结论 |
|---|---|---|
| A. 服务端授权码 + PKCE（**选用**） | apiserver 是 OIDC 客户端：浏览器跳 Google，回调到 apiserver，apiserver 用 client secret 换 ID token | 一个「Web 应用」类型的 OAuth 客户端、一个回调地址，四端共用；自建部署只配一次 |
| B. Web 用 Google Identity Services 按钮 / One Tap | 页面加载 `accounts.google.com/gsi/client`，拿 ID token 交后端校验 | 只解决 Web；要引入第三方脚本，受浏览器第三方 cookie / FedCM 变化影响；原生端还得另做一套 |
| C. 原生端用 Google SDK | App 里直接拿 ID token | **自建部署做不到**：iOS SDK 要把每个部署的 client ID 反写成 URL scheme 编进 App；Android 要在部署方的 GCP 项目里登记官方 App 的包名 + 签名 SHA-1，而同一组包名/SHA-1 不能在多个项目里登记，Android 目前也还没有 release 签名 |

原生端按 RFC 8252 用系统浏览器（Apple `ASWebAuthenticationSession`、Android Custom Tabs）打开同一个服务端流程，
用自定义 scheme 回到 App。Google 本来就拒绝在内嵌 WebView 里登录。

### 3.2 一次登录的全过程

```
客户端                         apiserver                                    Google
  │ 生成 verifier / challenge      │                                           │
  │── GET /api/auth/google/start?client=web|native&code_challenge=… ──▶        │
  │                               │ 建 flow 行（state、nonce、Google 侧 PKCE、客户端 challenge）
  │◀── 302 + Set-Cookie: orbit_oauth_flow（把流程绑在这个浏览器上）           │
  │───────────────────────────── 浏览器跳到 Google 授权页 ───────────────────▶│
  │                               │◀──── 302 /api/auth/google/callback?code&state
  │                               │ 校验 state + cookie → 用 code 换 ID token → 校验声明
  │                               │ flow 记下已验证的 Google 身份，签一张 2 分钟的一次性票据
  │◀── 302 /login?google_ticket=T（Web）或 orbit://auth/google?ticket=T（原生）
  │── POST /api/auth/google/exchange {ticket, codeVerifier} ──▶              │
  │                               │ 票据即用即焚 → 校验 verifier → 找到 / 关联 / 开户 → 签 Orbit token
  │◀── {accessToken, refreshToken, user}（与 POST /auth/login 同形）
```

贯穿全文的两条规则：

1. **回调只产出票据，不落定任何事。** 登录、开户、关联都在 `exchange` / `link/confirm` 里做，这两步必须由发起端
   出示 verifier（关联还要出示 LOGIN JWT）。
2. **票据第一次被出示就作废**，不管 verifier 对不对。

## 4. 协议细节

### 4.1 发起：`GET /api/auth/google/start`

参数：`client=web|native`（必填）、`code_challenge`（必填，S256，43 字符 base64url）、`client_state`（原生端可选，原样带回）。

- 建一行 `oauth_login_flow`（5.1），有效期 10 分钟；顺手删掉已过期的行。
- 设 cookie `orbit_oauth_flow=<32 字节随机>`：`HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=600`，
  `PUBLIC_ORIGIN` 是 https 时加 `Secure`。库里只存它的 sha256。
- 302 到 `https://accounts.google.com/o/oauth2/v2/auth`：`response_type=code`、`client_id`、
  `redirect_uri=${PUBLIC_ORIGIN}/api/auth/google/callback`、`scope=openid email profile`、`state`、`nonce`、
  `code_challenge`（Google 这一侧的 PKCE，与客户端那一对不是同一个）、`prompt=select_account`。
- 未启用 Google：Web 302 回 `/login?google_error=GOOGLE_NOT_CONFIGURED`，原生回 `orbit://auth/google?error=…`。
- 参数不合法（`code_challenge` 缺失或不是 S256 格式，或 `client_state` 超过 512 字符）、该 IP 超出限流、未完成的
  flow 已达总量上限（7.4）时，也按 4.2 失败表 302 回跳而不回 JSON，错误码依次为 `GOOGLE_BAD_REQUEST`、
  `GOOGLE_RATE_LIMITED`、`GOOGLE_SIGN_IN_BUSY`；这些回跳与上一条一样不设 cookie、不写库（连过期行也不清理），
  原生端只在 `client_state` 合法时带回它；`client` 缺失或不是 `web` / `native` 时无处可回，仍回 400。

### 4.2 回调：`GET /api/auth/google/callback`

1. 按 `state` 的哈希找 flow：不存在、过期、不是 `PENDING` → `GOOGLE_FLOW_EXPIRED`。
2. cookie 的哈希必须等于 flow 记的绑定值，否则同样 `GOOGLE_FLOW_EXPIRED`。这一条挡住「受害者在自己的浏览器里
   完成了攻击者发起的流程」。无论结果如何都清掉 cookie。
3. Google 回了 `error`（如 `access_denied`）→ `GOOGLE_CANCELLED`。
4. POST `https://oauth2.googleapis.com/token` 换 token（`client_secret` + Google 侧 `code_verifier`），失败 → `GOOGLE_EXCHANGE_FAILED`。
5. 校验 ID token 声明：`iss ∈ {https://accounts.google.com, accounts.google.com}`；`aud` 等于 client ID
   （是数组时 `azp` 也要等于它）；`exp` 未过（容 60 秒偏差）；`nonce` 等于 flow 的；`sub` 非空；
   `email_verified === true`，否则 `GOOGLE_EMAIL_UNVERIFIED`。
   ID token 是 apiserver 经 TLS 直接从 Google token 端点拿到的，按 OIDC Core 3.1.3.7 可用 TLS 校验代替验签，
   所以不拉 JWKS、不加依赖。**Google 返回的 access token 当场丢弃。**
6. 把 `{sub, email, emailVerified, hd, name}` 写进 flow，状态改 `AUTHENTICATED`，签票据（32 字节随机，存哈希，2 分钟）。
7. 302 到客户端：

| client / intent | 成功 | 失败 |
|---|---|---|
| web / LOGIN | `/login?google_ticket=T` | `/login?google_error=CODE` |
| web / LINK | `/settings/profile?google_link_ticket=T` | `/settings/profile?google_error=CODE` |
| native / LOGIN | `orbit://auth/google?ticket=T&state=<client_state>` | `orbit://auth/google?error=CODE&state=…` |

Web 的目标都是相对路径；原生只有这一个固定地址。**服务端不接受客户端传来的回跳地址**，所以没有开放重定向。

### 4.3 兑换：`POST /api/auth/google/exchange`

Body：`{ticket, codeVerifier}`。

1. 一条语句 `DELETE … WHERE ticket_hash = $1 AND status = 'AUTHENTICATED' RETURNING *` 取行——即用即焚，并发兑换只有一个拿得到。
2. 票据过期、`S256(codeVerifier) ≠ client_challenge`、或 intent 不是 LOGIN → 400 `GOOGLE_FLOW_MISMATCH`。
3. 按 5.2 找到、关联或建出 Orbit 用户；不成立时返回对应错误码（403）。
4. 交给 `AuthService.completeLogin(user)` 签发——与密码登录同一个出口（9.2），返回 `{accessToken, refreshToken, user}`。

### 4.4 安全要点

- `state`（一次性、10 分钟）+ `nonce` + 两层 PKCE（apiserver↔Google、客户端↔apiserver）+ 浏览器绑定 cookie。
- 票据：256 bit、只存哈希、2 分钟、第一次出示即焚、必须配 verifier。落进浏览器历史或访问日志也换不出 token。
- 回跳目标是固定集合。Web 的 `next` 只存在前端（sessionStorage），仍由现有 `loginDestination` 校验，服务端不经手。
- 只认 `email_verified` 为真的邮箱；按邮箱连到已有账号只在 Google 对该邮箱**有权威**时进行（5.2）。
- 不存 Google token，不申请敏感 scope。
- 新 controller 整类 `@PatForbidden('AUTH')`（与 `AuthController` 一致）；关联、解除关联只接受 LOGIN 凭证。
- `/start` 是匿名写库的入口，要有限流和总量上限（7.4）。
- 已知残余风险：设备上装了抢注 `orbit://` 的恶意 App，由它自己发起流程，再诱导用户在 Google 页面选账号。
  这是 RFC 8252 第 8.6 节所述、自定义 scheme 无法根除的情形；`prompt=select_account` 保证用户至少要亲手选一次账号。

## 5. 账号模型与关联规则

### 5.1 数据

```prisma
model UserIdentity {                 // user_identity
  id           String    @id @default(uuid(7)) @db.Uuid
  userId       String    @db.Uuid    // → User，onDelete: Cascade
  provider     String                // 'google'
  subject      String                // Google 的 sub：稳定、不复用的身份。不是邮箱
  email        String                // 最近一次登录时 Google 给的邮箱，只用于展示
  hostedDomain String?               // hd 声明
  createdAt    DateTime  @default(now())
  lastSignInAt DateTime?
  @@unique([provider, subject])
  @@unique([userId, provider])       // v1：一个 Orbit 账号最多关联一个 Google 账号
}

model OAuthLoginFlow {               // oauth_login_flow：短命，兑换即删
  // id, provider, intent ('LOGIN' | 'LINK'), client ('WEB' | 'NATIVE'),
  // stateHash @unique, bindingHash, nonce, providerCodeVerifier, clientChallenge, clientState?,
  // linkUserId? (→ User，Cascade), status ('PENDING' | 'AUTHENTICATED'), claims Json?,
  // ticketHash? @unique, ticketExpiresAt?, expiresAt (@@index), createdAt
}
```

- `User.passwordHash` 改为可空：null 表示「没有密码，只能用 Google 登录」。`login()` 遇到 null 一律回
  `401 invalid credentials`，与密码错误不可区分。
- `User` 新增 `disabledAt DateTime?`（5.5）。
- 身份永远按 `(provider, sub)` 认，邮箱只在**第一次**把 Google 账号连到已有 Orbit 账号时用。Google 那边改了邮箱，
  `sub` 不变，照样登录；`User.email` 不跟着改。
- 另有一张配置表 `sign_in_provider`，见 7.1。
- 迁移号在实现时取 main 上的下一个空号。三张新表会碰到 apiserver 的五个普查（迁移台账、db-write inventory、
  生成的 trigger 清单 `scripts/sync-db-trigger-inventory.mjs --write`、`@db.Uuid` 命名分类、NOT NULL 清单），一并更新。

### 5.2 登录时怎么找到 Orbit 账号

「Google 对该邮箱有权威」指：`email_verified` 为真，且邮箱是 `@gmail.com`（或 `@googlemail.com`），或 ID token
带 `hd`（Workspace 账号）。其余情况——用公司邮箱注册的个人 Google 账号——Google 只在注册当时验证过邮箱，
不保证此人现在仍控制它。这是 Google 自己的 ID token 校验文档给的判断标准。

按顺序判断：

| # | 条件 | 结果 |
|---|---|---|
| 1 | `(google, sub)` 已关联 | 该用户已停用 → `ACCOUNT_DISABLED`；否则登录，并更新身份上的 email / hd / lastSignInAt |
| 2 | 部署里还没有任何用户 | `SETUP_REQUIRED`（第一个管理员只能走 `/setup`） |
| 3 | 按邮箱（不分大小写）恰好匹配 1 个用户 | 见下表 |
| 4 | 匹配到多于 1 个用户（历史上大小写不同的重复邮箱） | `GOOGLE_EMAIL_AMBIGUOUS`，由管理员先改正 |
| 5 | 没匹配到，注册策略为「开放」 | 自动开户：MEMBER、无密码，名字取 Google `name`（截到 80 字），没有则取邮箱前缀；建身份；登录；记 Activity |
| 6 | 没匹配到，注册策略为「仅已有账号」 | `GOOGLE_ACCOUNT_NOT_FOUND`：提示请管理员用这个邮箱开户 |

第 3 条匹配到的那个用户：

| 情况 | 结果 |
|---|---|
| 已停用 | `ACCOUNT_DISABLED` |
| 已关联另一个 Google 账号 | `GOOGLE_ACCOUNT_MISMATCH` |
| 邮箱不权威 | `GOOGLE_EMAIL_NOT_AUTHORITATIVE`：提示先用密码登录，再到个人资料页关联 |
| 邮箱权威 | 自动关联并登录，记 Activity |

- 邮箱是否权威只影响「连到已有账号」。开放注册下，没匹配到账号的非权威邮箱照常开新户：身份认的是 `sub`，
  邮箱只是这个新账号的标签。
- 匹配用 `lower(email)`，不改现有唯一索引：自建库里可能已有大小写重复的历史数据，加唯一索引会让迁移失败。
- 并发首登同一个 Google 账号：`(provider, subject)` 与 `email` 的唯一约束兜底，失败的一方重读一次即命中第 1 条。

### 5.3 手动关联与解除

- **关联**（已登录，在个人资料页）：`POST /api/auth/google/link {codeChallenge}` → 设绑定 cookie、返回
  `{authorizationUrl}` → 前端跳转 → 回调 → `/settings/profile?google_link_ticket=T` →
  `POST /api/auth/google/link/confirm {ticket, codeVerifier}`，要求当前 JWT 的用户等于 flow 的 `linkUserId`。
  手动关联不要求邮箱一致或权威（这个人同时证明了两边）；该 Google 账号已关联别人 → `GOOGLE_ALREADY_LINKED`。
  回调后多一步 confirm，是为了挡住「拿到受害者的授权链接，在自己的浏览器里用自己的 Google 账号走完，
  把自己的 Google 挂到受害者账号上」。
- **解除**（本人）：`DELETE /api/auth/google/link`。账号没有密码时拒绝，`GOOGLE_UNLINK_WOULD_LOCK_OUT`。
- **管理员**：可以解除任何人的关联；用现有「重置密码」给无密码账号设一个密码（`force` 路径不变）。
- 关联、解除、自动开户都写 Activity（`credentialKind = LOGIN`），payload 记 provider、Google 邮箱、方式（`AUTO` / `SETTINGS` / `ADMIN` / `SIGNUP`）。

### 5.4 只用 Google 的账号

- 开放注册建出的账号都没有密码。管理员也可以手动建：`POST /api/admin/users {email, name?, passwordless: true}`，
  不生成密码；与 `force` 同用时报错，不会把已有密码抹掉。
- 这种账号的个人资料页不显示「Change password」，改为说明它用 Google 登录。要给它密码，管理员「重置密码」即可。

### 5.5 停用账号与会话

- Orbit 会话与 Google 会话互不影响：退出 Orbit 不退出 Google；Google 账号被停用后，已签发的 Orbit refresh token
  仍然有效（30 天滑动）。在 Workspace 里停用某人不会自动停用他的 Orbit 账号。
- 新增「停用」：管理员在用户管理里 Disable / Enable（`User.disabledAt`）。不能停用自己，也不能停用最后一个管理员。停用后：
  - 密码登录、Google 兑换、refresh 一律拒绝 `ACCOUNT_DISABLED`；停用时吊销该用户全部 refresh token（恢复后要重新登录）。
  - access token 是无状态 JWT，PAT 也走同一个 guard：`JwtAuthGuard` 对照一份内存里的停用用户集合
    （每 30 秒从库里重读），停用在半分钟内对所有用户路由生效，不必每个请求查库。PAT 不吊销，停用期间被拒，恢复后照常可用。
  - runner 凭证的鉴权本来每次就按 `tokenHash` 查 runner（`runner-api/runner-auth.guard.ts`），同一次查询带出 owner 的
    `disabledAt` 即可拒绝；`runner-session-auth.guard.ts` 与 service token 同理。停用账号的 runner 因此收不到也领不到活。
  - 不删任何数据，可以恢复。身份行保留，同一个 Google 账号不能靠重新注册绕过（5.2 第 1 条先命中）。
- 删除照旧：仍拥有 runner、workspace、任务的用户删不掉。处置滥用用停用，不用删除。

### 5.6 开放注册

- **策略**：`signupPolicy` 取 `EXISTING_ACCOUNTS`（默认）或 `OPEN`，管理员在「Sign-in」设置里切换，即时生效。
  切回 `EXISTING_ACCOUNTS` 就是关闭注册的总开关，已注册的账号不受影响。
- **注册即开户**：没有邮件验证、审核或邀请码。Google 担保邮箱已验证，且有人亲手走完了 Google 的登录。
- **防滥用（v1）**：`/start`、`/exchange` 按 IP 限流（7.4）；注册策略总开关；停用账号（5.5）；管理员用户列表显示
  登录方式和开户时间，便于发现异常注册。
- **新用户落点**：没有 runner 的新账号按现有 `DefaultLanding` 去 `/runners/register`，用自己的机器注册 runner；
  托管 runner 项目启用后由它开通默认 runner（9.2）。新用户看不到也用不了别人的 runner、workspace 和共享池
  （共享池要池主显式拉人）。
- **在 orbitd.io 切到 OPEN 之前**（代码可以先落地，开关晚点开）：
  1. 停用账号已上线（第 11 节 X1）。
  2. 做完租户隔离普查（第 11 节 T1）。今天的用户都是管理员拉进来的同事；开放之后，按 `ownerId` 的隔离要挡住陌生人，
     越权读写就是数据泄露。
  3. Google 同意屏幕已发布为「正式」（7.2），orbitd.io 有首页与隐私政策页可填。
- **开放后要观察、本方案不做的**：按用户的资源配额（附件存储、会话与任务数量）、注册量日上限、用户自助删除账号。
  README 与 `messaging-brief.md` 里「不是托管 SaaS」的表述是否随 orbitd.io 开放注册调整，由所有者另行决定。

## 6. 接口清单

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /api/auth/methods` | 公开 | `{password: true, google: boolean, googleSignup: boolean}`，客户端据此决定是否显示 Google 按钮和注册提示 |
| `GET /api/auth/google/start` | 公开 | 4.1 |
| `GET /api/auth/google/callback` | 公开 | 4.2 |
| `POST /api/auth/google/exchange` | 公开（票据 + verifier 即凭证） | 4.3，返回同 `POST /auth/login` |
| `POST /api/auth/google/link` | LOGIN | 5.3 |
| `POST /api/auth/google/link/confirm` | LOGIN | 5.3 |
| `DELETE /api/auth/google/link` | LOGIN | 5.3 |
| `GET /api/users/me` | LOGIN | 新增 `signInMethods: {password: boolean, google: {email} \| null}` |
| `GET /api/admin/users` | ADMIN | 每行新增 `signInMethods`、`disabledAt` |
| `POST /api/admin/users` | ADMIN | 新增可选 `passwordless` |
| `PATCH /api/admin/users/:id/disabled` | ADMIN | `{disabled: boolean}`，5.5 |
| `DELETE /api/admin/users/:id/identities/google` | ADMIN | 解除他人的关联 |
| `GET /api/admin/sign-in/google` | ADMIN | `{enabled, clientId, hasSecret, secretUnreadable, signupPolicy, redirectUri}`，从不返回密钥；`secretUnreadable` 为真时管理区提示重填（换了 `PROVIDER_SECRET_KEY`，见 7.1） |
| `PUT /api/admin/sign-in/google` | ADMIN | `{enabled, clientId, clientSecret?, signupPolicy}`；不带 `clientSecret` 即保留原值 |

全是新路由或增量字段，旧客户端不受影响。新路由要过 `pat-route-coverage.spec.ts` 的声明普查（admin 路由沿用 `@PatForbidden('ADMIN')`）。
旧版客户端遇到 `ACCOUNT_DISABLED` 会按各自的通用错误处理，不会误判为已登录。

## 7. 配置与部署

### 7.1 配置：管理员在管理区填写，存库

```prisma
model SignInProvider {               // sign_in_provider，每个提供方一行
  provider        String   @id       // 'google'
  enabled         Boolean  @default(false)
  clientId        String
  clientSecretEnc String              // providers/provider-crypto.ts 的 encryptSecret（密钥由 PROVIDER_SECRET_KEY 派生）
  signupPolicy    String   @default("EXISTING_ACCOUNTS")   // 'EXISTING_ACCOUNTS' | 'OPEN'
  updatedById     String?  @db.Uuid
  updatedAt       DateTime @updatedAt
}
```

- 管理区新增「Sign-in」设置：开关、Client ID、Client secret（只写不读）、注册策略（选「开放」时写明任何 Google 账号
  都能在这里开户），以及**要去 Google 控制台登记的回调地址**（`${PUBLIC_ORIGIN}/api/auth/google/callback`，带复制按钮）。
- `enabled` 为真且 ID、密钥都在，才算启用；否则 `/auth/methods` 报 `google: false`，行为与今天完全相同。
- 回调地址取已有的 `PUBLIC_ORIGIN`，必须与 Google 控制台登记的一字不差；`self-hosting.md` 已要求它是对外的 HTTPS 地址。
- 密钥与模型提供方的 API key 同一套加密：没有密钥版本，轮换 `PROVIDER_SECRET_KEY` 后要重填（与提供方相同的已知限制）。
  轮换后 `GET /api/admin/sign-in/google` 报 `secretUnreadable: true`，Sign-in 页据此提示已保存的密钥解不开、要求重填，
  不显示 On 与「A secret is saved」；用户侧登录仍按 4.3 的通用失败文案处理。

为什么不用环境变量：apiserver 的 compose 段被 `test/compose-topology.test.mjs` 钉住，加变量要所有者重新审批；
改了还要重启。存库则 orbitd.io 和每个自建部署都是「发版后管理员填一次」，不动部署文件。

### 7.2 Google Cloud 控制台（每个部署做一次）

1. 建项目，配 OAuth 同意屏幕：用户类型「外部」（只给自己的 Workspace 用可选「内部」）；应用名 Orbit；
   授权域名填部署域名；scope 只要 `openid`、`email`、`profile`。
2. 凭据 → 创建 OAuth 客户端 ID → 类型「Web 应用」→ 已获授权的重定向 URI 填 `https://<域名>/api/auth/google/callback`。
3. 把 client ID / secret 填进 Orbit 管理区的「Sign-in」设置，打开开关。
4. 「测试」状态一般只放行登记的测试用户（最多 100 个），但只申请基础 scope（`openid`、`email`、`profile`）的应用
   不受此限：Google 的 [Manage App Audience](https://support.google.com/cloud/answer/15549945) 写明这类请求的用户
   不必在测试用户名单里，也看不到警告。本方案正是如此，所以「测试」状态挡不住任何 Google 账号，不能用来灰度；
   决定谁能进 Orbit 的是注册策略（默认「仅已有账号」）。开放注册必须发布为「正式」：
   按控制台要求提供应用首页、隐私政策链接，并验证授权域名的所有权。只用基础 scope 不需要 Google 的应用审核；
   要在同意屏显示应用名与 Logo，须通过品牌验证（未验证时只显示域名）。

限制：Google 要求回调地址是 https 公网域名（`http://localhost` 例外，可用于本机试用）。只有内网 IP 的自建部署用不了 Google 登录。

### 7.3 网络

- 用户的浏览器要能访问 `accounts.google.com`，apiserver 要能访问 `oauth2.googleapis.com`。apiserver 的 FCM 推送
  （`push/fcm-transport.ts`）已经在向同一个 token 端点换 token，用的也是全局 `fetch`；上线前在生产 apiserver
  容器里 curl 一次该端点确认可达。
- 访问不了 Google 的用户继续用密码登录，这也是密码登录不能下线的原因。

### 7.4 限流与清理

- `/start` 与 `/exchange` 按 IP 限流，复用 `shared/public-surface.guard.ts` 的 `SharedRateLimiter`
  （按 `visitorAddress()`，即 nginx 给的 `X-Real-IP`）。
- `/start` 每次开 flow 前删除已过期的 flow；未完成的 flow 设总量上限，超出时拒绝（`/start` 按 4.1 回跳
  `GOOGLE_SIGN_IN_BUSY`，`/link` 回 `503`），不无限写库。
- 密码登录本身仍没有限流，这是既有缺口，不在本方案范围内。

## 8. 客户端

### 8.1 Web

- `LoginPage`：表单下方加「Continue with Google」（`components/ui/Button` + 符合 Google 品牌规范的 G 标），
  `GET /auth/methods` 说启用才显示；`googleSignup` 为真时按钮下多一行「New to Orbit? Continue with Google to create an account.」。
  点击：生成 verifier → sessionStorage 存 `{verifier, next}` → `location.assign('/api/auth/google/start?client=web&code_challenge=…')`。
- 回到 `/login?google_ticket=T`：先 `history.replaceState` 抹掉参数 → `POST /auth/google/exchange` → `setSession(res)` →
  `location.href = loginDestination(next)`，与密码登录同一出口。`google_error=CODE` 和兑换返回的错误码（含 `ACCOUNT_DISABLED`）
  都给出能照着做的提示（Web 目前没有 i18n，文案用英文）。
- 设备流不用改：`/enroll?code=` → 未登录 → `/login?next=…` → Google → 回到 `/login` → 按 sessionStorage 里的
  `next` 回到 `/enroll?code=…`。`/login` 已在 `BootGate` 的放行表里，不新增路由。
- `ProfilePage`：新增「Sign-in methods」卡片——密码（有 / 无）、Google（已关联邮箱 + Disconnect，或 Connect Google）；
  无密码账号隐藏「Change password」。
- `AdminUsersPage`：列表标出登录方式、开户时间和停用状态；新建对话框加「Google sign-in only」；每行加
  「Disable / Enable」与「Unlink Google」。
- 管理区「Sign-in」设置（7.1），只对 ADMIN 显示，入口与用户管理并列。

### 8.2 iOS / macOS

- `LoginView` 表单下加「Continue with Google」，当前实例的 `auth/methods` 说启用才显示（进页面、换实例时各取一次；
  旧服务端 404 即不显示）；`googleSignup` 为真时同样加注册提示。
- OrbitKit 新增 Google 登录流程：生成 verifier / state →
  `ASWebAuthenticationSession(url: …/start?client=native…, callbackURLScheme: "orbit")`，
  `prefersEphemeralWebBrowserSession = false`（复用 Safari 里已登录的 Google）→ 解析
  `orbit://auth/google?ticket&state` 或 `error` → `POST auth/google/exchange` → 走 `APIClient.login` 同一段
  「存 Keychain + 读回校验」→ `me()` → `signedIn`。
- `LoginFailure` 按错误码给文案（`ACCOUNT_DISABLED`、`GOOGLE_ACCOUNT_NOT_FOUND` 等），不再把它们都说成「密码不对」。
- 两端都已注册 `orbit` scheme，不改 Info.plist。`ASWebAuthenticationSession` 自己截获回调，不经 `onOpenURL`；
  `DeepLink.parse` 对 host `auth` 继续返回 nil（加一条测试钉住）。
- macOS 要给 `ASWebAuthenticationSession` 提供窗口锚点；Developer ID 的非沙盒 App 可直接用 AuthenticationServices。
- 新注册的账号没有 runner，沿用 App 现有的「还没有 runner」状态。关联、解除关联 v1 只在 Web 做。

### 8.3 Android

- `AuthScreen` 加同样的按钮和注册提示（按实例的 `auth/methods`）。
- 新依赖 `androidx.browser`（Custom Tabs；设备上没有支持 Custom Tabs 的浏览器时退回默认浏览器）。
- `MainActivity`（或单独的转接 Activity）加 VIEW / BROWSABLE intent-filter：`orbit://auth/google`。Android 上任何
  App 都能声明同一个 scheme，所以 verifier 只留在本进程，被别的 App 截走的票据换不出 token。
- 浏览器期间进程被杀、verifier 丢失：提示「登录被打断，请重试」。票据已焚，不会泄露。
- `AuthSession` 新增「用票据登录」，复用 `login` 里「先退出旧会话 → 存 token → 发布 SignedIn」那一段；
  `messageFor` 按错误码给文案（今天只有 401 映射为密码错误）。
- 302 到自定义 scheme 时，若个别浏览器不自动拉起 App，回调改落一个带「Return to Orbit」按钮的兜底页（真机上验证后定）。

### 8.4 CLI

不改。`orbit register`（以及将来的 `orbit login`）都在浏览器里批准。`runner-cli.md` 补一句：批准页可以用 Google 登录。

## 9. 与在途工作的衔接

### 9.1 Web 组件迁移（P4.1 / P4.2）

P4.1（LoginPage、SetupPage、ProfilePage、SettingsPage）和 P4.2（含用户管理）尚未开工。新增 UI 一律用
`components/ui` 的 Orbit 组件，不新增 antd 用法，迁移任务就没有新东西要迁；LoginPage 本身已经是原生表单。
两边谁后落地谁 rebase，冲突面只是这几个页面的少量行。

### 9.2 托管默认 runner（项目「Kubernetes 托管默认 Runner 与跨节点持久存储」T05）

`docs/managed-runner-design.md` 要求在登录 / bootstrap 成功**之后**记录开通意图，不放进 token 签发和 refresh。
本方案把密码登录、bootstrap、Google 兑换收敛到 `AuthService.completeLogin(user)` 一个出口，T05 的钩子只挂这一处。
开放注册与托管 runner 同时开启时，每个新注册都会触发开通，靠托管项目的容量准入（其 T06）兜底；托管功能默认关闭，
开放注册本身不会建任何 runner。

### 9.3 PAT 与 `orbit login`

不冲突。Google 登录得到的是 LOGIN 凭证；签发 PAT、批准设备流照旧只认 LOGIN。

## 10. 测试与验收

- apiserver 单测：声明校验（表驱动）；5.2 两张表的每一行，两种注册策略各跑一遍；回跳表；票据即焚、过期、
  verifier 不符、intent 不符；cookie 缺失或不符；未启用时 `/auth/methods` 为 false、`/start` 拒绝。
  Google 端点经可注入的客户端换成假实现，不打真网络。
- pg spec：并发兑换只有一个成功；并发首登不重复开户；过期 flow 被清理；`passwordHash` 为 null 的账号密码登录 401；
  删除用户级联删除身份；停用后登录、兑换、refresh 被拒，guard 在 30 秒内拒绝 access token 与 PAT，runner 凭证被拒，
  恢复后可重新登录。
- Web：按钮与注册提示的显隐；`next` 经 Google 往返后回到 `/enroll?code=`；错误码文案；个人资料页、用户管理页、「Sign-in」设置。
- Apple：OrbitKit 测 URL 构造、回调解析、兑换与 Keychain 写入、错误码文案；`DeepLink` 钉住 `auth`；client.yml 两个 job 绿。
- Android：回调解析与 `AuthSession` 单测；真机走一遍 Custom Tabs。
- 租户隔离普查：见第 11 节 T1 的验收。
- 真 Google 端到端：在隔离栈上用回调地址为 `http://localhost:<port>` 的测试客户端和测试 Google 账号，走 Web 登录、
  开放注册开户、自动关联、手动关联、解除、停用、`/enroll` 回跳，原生端各走一遍。需要所有者先在 Google Cloud 建测试客户端、提供测试账号。

## 11. 落地顺序（任务拆分）

每个任务服务项目的一条验收标准（「标准」列是项目验收标准的序号）。

| # | 内容 | 标准 | 依赖 | 验收 |
|---|---|---|---|---|
| S1 | 服务端·配置与默认关闭：`sign_in_provider` 表与加密、`GET/PUT /admin/sign-in/google`、`/auth/methods`；未启用时 Google 路由一律拒绝 | 1 | — | spec：未配置、已关闭两态下 `/auth/methods` 为 false、Google 路由拒绝、密码登录与 refresh 回归；密钥不出现在任何响应里 |
| S2 | 服务端·登录协议：`oauth_login_flow`、start / callback / exchange、cookie 绑定、两层 PKCE、票据、声明校验、限流与清理；`user_identity` 表与「已关联身份直接登录」；`completeLogin` 出口 | 4 | S1 | spec 逐条覆盖第 4 节的每项检查（Google 端点用假实现） |
| S3 | 服务端·账号解析与开放注册：5.2 全部规则、注册策略、`passwordHash` 可空、仅 Google 账号（admin `passwordless`）、Activity | 3 | S2 | 表驱动 spec 覆盖 5.2 两张表每一行 × 两种策略；pg spec：并发首登不重复开户、并发兑换只有一个成功 |
| S4 | 关联与管理：link / confirm / unlink、admin 解除关联、`me` 与 admin 列表的 `signInMethods`；Web 个人资料「Sign-in methods」、用户管理页、管理区「Sign-in」设置 | 5 | S3 | spec（confirm 只认发起用户、解除的锁死保护）+ Web 测试与截图 |
| W1 | Web·Google 登录：按钮与注册提示、票据兑换、`next` 往返、错误码文案；未启用时不显示按钮 | 2 | S3 | Web 测试（含 `/enroll?code=` 往返）+ 截图 |
| A1 | iOS / macOS·Google 登录：OrbitKit 流程、LoginView 按钮、错误码文案；未启用时不显示按钮 | 2 | S3 | OrbitKit 测试；client.yml 两个 job 绿；截图 |
| D1 | Android·Google 登录：Custom Tabs、intent-filter、AuthSession、错误码文案；未启用时不显示按钮 | 2 | S3 | 单测 + 模拟器或真机走通的录屏 |
| X1 | 停用账号（5.5）：`User.disabledAt`；登录、兑换、refresh 拒绝并吊销 refresh token；`JwtAuthGuard` 与 runner 鉴权对照停用状态；用户管理页 Disable / Enable | 6 | S3 | pg spec：停用后 30 秒内各类凭证被拒，恢复后可重新登录 |
| T1 | 租户隔离普查：每条带 id 的用户路由都有「用户 B 访问用户 A 的对象 → 404/403，且什么都没写」的用例（可按 `PublicIdPipe` 参数生成）；发现的越权逐个修 | 7 | — | 普查 spec 绿，且新增路由不补用例即失败 |
| DOC | 文档：`self-hosting.md`、`configuration.md` 加 Google 登录一节（Google 控制台步骤、回调地址、管理区填写、注册策略及风险）；`runner-cli.md` 补一句 | 8 | S4 | 文档审阅 + 按文档在隔离栈上从零配置走通一次 |
| E1 | 真 Google 端到端（隔离栈）：四端登录、开放注册开户、自动与手动关联、解除、停用、`/enroll` 回跳 | 2 | S4、W1、A1、D1、X1 | 端到端记录（截图或录屏 + 服务端日志）；需要所有者提供测试客户端与测试账号 |
| P1 | orbitd.io 生产启用：发版部署后，所有者在管理区填入正式客户端，先用「仅已有账号」；X1、T1 完成且同意屏幕发布为「正式」后切「开放」 | 9 | E1、X1、T1、DOC | 所有者在生产核对一次真实登录和一次开户 |

S1 → S2 → S3 是串行的服务端底座；S3 之后 S4、W1、A1、D1、X1 可以并行；T1 与其余任务无依赖，可以立即开始。

## 12. 所有者决定（2026-10-06）

1. **谁可以用 Google 登录：开放注册。** 落成管理区里的注册策略开关，默认「仅已有账号」，自建部署不会被动开放；
   orbitd.io 打开它，前提见 5.6。
2. **按邮箱自动关联：Google 权威邮箱（gmail / Workspace）自动关联已有账号。** 其他邮箱先用密码登录，再到个人资料页手动关联。
3. **客户端范围：四端一起。** Web、iOS/macOS、Android 在服务端之后并行。

待定：

4. **orbitd.io 上线**：需要所有者在 Google Cloud 建正式、测试两个 OAuth 客户端（测试客户端用于隔离栈端到端，
   回调地址是 `http://localhost:<port>`），提供一个测试 Google 账号，并提供 orbitd.io 的首页与隐私政策页
   （同意屏幕发布为「正式」时必填）。生产先在「测试」状态只放少数账号灰度，还是直接正式发布？
