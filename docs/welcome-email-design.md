# 新账号欢迎邮件（设计稿）

状态：已拍板（2026-11-11），待实现。效果图：`docs/mocks/welcome-email/01-board.html`（PNG 同目录）。

| # | 决定 |
|---|---|
| D1 发信通道 | **Resend HTTP API**（`POST https://api.resend.com/emails`） |
| D2 配置位置 | **管理后台 Admin → Email 页**：API key 加密存库，保存即生效，可当场发测试邮件 |
| D3 管理员建的账号 | **也发**，写明谁加的你、怎么登录 |
| D4 失败处理 | **自动重试 3 次 + Users 行内灰字 + ⋯ 菜单手动重发** |

## 1. 今天

**新用户不会收到任何邮件。** Orbit 没有任何发信能力：apiserver 没有 SMTP、没有邮件服务商 SDK，
依赖里也没有 nodemailer 一类的包，配置里也没有 `SMTP_*` / `MAIL_*`。

账号建出来的三个入口，都只写数据库：

| 入口 | 位置 | 今天做什么 |
|---|---|---|
| Google 开放注册（首次登录） | `google-login.service.ts` `link()`，`method: 'SIGNUP'` | 建 `user`（MEMBER，无密码）+ `user_identity` + 一条 Activity，同一事务 |
| 管理员在 Users 页建账号 | `users.util.ts` / `POST /api/admin/users` | 建 `user`；密码由管理员线下告知，或 passwordless 只能 Google 登录 |
| 首个管理员 `/setup` | `auth.service.ts` `bootstrap()` | 建 ADMIN；操作者就是装机的人 |

## 2. 目标与不做的事

目标：账号一建出来，对方收到**一封**欢迎邮件，告诉他账号在哪个部署、用什么登录、下一步做什么。

不做（这一版）：
- 不做营销邮件、周报、通知邮件。
- 不补发：开启前已存在的账号不发。
- 不做多语言：邮件文案是英文（CLAUDE.md §5）。
- 不做邮箱验证 / 找回密码。
- 不做 `.env` 配置：发信只在管理后台配。

## 3. 方案

### 3.1 配置：Admin → Email（新页）

与 Sign-in、Integrations 并列，一张卡，结构照搬 `AdminSignInPage`（同一张 orbit-card，同一套「密钥已存 / 解不开请重填」语义）：

| 字段 | 说明 |
|---|---|
| Send email from this deployment | 总开关。关着时新账号行记 `SKIPPED` |
| Resend API key | Sending access 即可。用 `PROVIDER_SECRET_KEY` 加密存库（`provider-crypto`），API 只回 `hasApiKey`，永不回传；留空 = 保留已存的 key |
| From | 如 `Orbit <orbit@example.com>`，域名必须已在 Resend 验证 |
| Reply-To | 可选；为空时取最早的 ADMIN 的邮箱，新人回信能找到人 |
| Send a welcome email to new accounts | 欢迎邮件开关，默认开（通道开着才生效） |
| Send test email | 发给当前管理员，当场显示 Resend 的回答：成功显示邮件 id；失败显示 HTTP 状态和 Resend 的 `message`（如 `403 The example.com domain is not verified`） |
| Last 7 days | `Sent 12 · Failed 1`，Show failures 列出收件人、时间、错误原文 |

- 「On」的条件：开关开、key 已存且能解密、From 已填。缺一项，卡头显示 Off，并说明缺什么。
- `PROVIDER_SECRET_KEY` 换了、已存的 key 解不开：页面警告「重新粘贴 API key」，发送暂停，PENDING 行原样等待，不消耗重试次数。
- 存储：新表 `email_settings`（单行：`enabled, resend_api_key_enc, from_address, reply_to, welcome_enabled, updated_at`），形状同 `sign_in_provider`。
- API：`GET` / `PUT /api/admin/email`，`POST /api/admin/email/test`，均需 ADMIN。
- 保存即生效，不用重启；worker 每轮读一次设置。
- 文档：`docs/self-hosting.md` 加「配置发信」一节（注册 Resend、验证域名、建 key、在 Admin → Email 填入、发测试邮件）。

### 3.2 发送：直接 `fetch`，不加依赖

- `POST https://api.resend.com/emails`，`Authorization: Bearer <解密后的 key>`，body `{from, to, reply_to, subject, html, text}`。
- Node 自带 `fetch`，**不加任何 npm 依赖**；10 秒超时。
- 带 `Idempotency-Key: welcome/<userId>/<generation>`：同一行的自动重试用同一个 key，worker 发出后崩溃、重取这一行时，Resend 不会发第二封。管理员手动重发时 `generation` + 1，换一个新 key。
  实现前要对着 Resend 文档确认两件事：key 的有效期（重试最长跨 ~71 分钟），以及失败响应会不会按 key 缓存。如果会缓存，可重试的错误就要换新 key。
- 结果分类：
  - `200` → `SENT`，记 Resend 的邮件 id。
  - `429`、`5xx`、网络错误、超时 → 可重试。
  - `401` / `403`（key 无效、域名未验证）→ 可重试（管理员在 Email 页改好后会自动发出），但第一次就打 error 日志。
  - `422`（收件地址不合法等）→ 直接 `FAILED`，重试也不会好。

### 3.3 什么时候发：事务内落 outbox，事务后发送

- 新表 `email_outbox`：`id, kind ('WELCOME'), user_id, to_address, status ('PENDING' | 'SENT' | 'FAILED' | 'SKIPPED'), attempts, generation, next_attempt_at, last_error, provider_message_id, sent_at, created_at`，`UNIQUE (kind, user_id)`。
- 在建账号的**同一个事务**里插一行（Google SIGNUP 的 `link()`、管理员建账号）。账号在，行就在；同一账号最多一行，并发首登、重复点击都只有一封。
- `/setup` 的首个管理员不发。
- 入队时通道未打开（见 3.1 的「On」条件）或欢迎邮件开关关着：行记 `SKIPPED`。之后配上也不补发旧行（管理员可在 Users 里对单个账号手动发）。
- 发送 worker：apiserver 内一个循环，`FOR UPDATE SKIP LOCKED` 取到期的 PENDING 行，**发送时才渲染**（行里不存正文、不存密钥）。失败按 1 分钟 / 10 分钟 / 1 小时重试，第 4 次失败记 `FAILED` + `last_error`。多个 apiserver 不会重复发。
- 发送成功 / 最终失败各记一条 Activity（`EMAIL_SENT` / `EMAIL_FAILED`）。

### 3.4 邮件内容（英文，HTML + 纯文本两份）

主题：`Welcome to Orbit, {firstName}`（Google 的 given name；没有就用邮箱 @ 前的部分）

1. 你的账号在哪：`{PUBLIC_ORIGIN}` 的 Orbit 已为 `{email}` 开好账号。
2. 用什么登录，三选一，**绝不放密码、token 或一次性链接**：
   - Google 注册：Sign in with Google, using that same address.
   - 管理员建、有密码：{admin} added you to Orbit. Sign in with this email address and the password {admin} gave you.
   - 管理员建、passwordless：{admin} added you to Orbit. Sign in with Google, using this address.
3. 主按钮 **Open Orbit** → `PUBLIC_ORIGIN`。
4. 三步上手，第 1 步按部署状态二选一：
   - 托管 runner 开着：Your runner is being prepared — nothing to install.
   - 没开：Connect a computer — install the runner from Settings → Runners.
5. 页脚：为什么收到、不是本人就回信给管理员；一次性事务邮件，无退订链接。

原第 5 项「客户端下载（macOS / iPhone / Android → `/dl`）」已删去（2026-11-11）：没有可链的客户端下载地址，`/dl` 只提供 runner 二进制。

模板是 apiserver 内的 TypeScript 纯函数（不引模板引擎），所有插值做 HTML 转义；内联样式、单列 560px；无外链图片。

### 3.5 管理员能看到什么

- Users 列表：欢迎邮件 **FAILED** 时，状态下方多一行灰字 `Welcome email failed`（悬停看错误原文和最后一次尝试时间）。成功不显示任何东西。
- 行的 ⋯ 菜单多一项 **Send welcome email**：状态为 FAILED 或 SKIPPED 时出现，把该行重置为 PENDING（attempts 清零、generation + 1）；已 SENT 的不出现。通道没配时这一项禁用，提示 `Email is not configured on this deployment`。
- `GET /api/admin/users` 每个用户多一个 `welcomeEmail: {status, lastError, updatedAt} | null`。

## 4. 安全

- 收件地址只来自 Google 已验证邮箱或管理员亲手填写的邮箱；一个账号最多一行，开放注册无法被刷成发信器。
- 邮件不含密码、token、魔法链接。
- Resend API key 加密存库，不进日志，不经任何 API 返回。
- 显示名、管理员名做 HTML 转义。

## 5. 落地（按代价排）

1. **模板 + 渲染函数**：纯函数；HTML/纯文本快照测试，覆盖 3 种登录方式 × 托管 runner 开/关。——小
2. **Resend 客户端 + Email 设置页 + 测试邮件**：`email_settings` 迁移、加密、API、web 页；`fetch` 调用与结果分类（用假 HTTP 服务测 200/422/429/5xx/超时）；self-hosting 文档。——中
3. **`email_outbox` + 建账号事务内入队 + 发送 worker + Activity**：迁移；pg spec 证明并发首登只一行、未配置记 SKIPPED、重试与 FAILED、两个 worker 不重复发。——中
4. **Users 行失败提示 + 重发菜单**：API 字段、web；iOS / Android 若有管理员用户页，跟同一字段。——小
