# Codex 共享账号池（方案 3：网关持有登录）设计

**状态**：界面效果图与 4 项产品决策已定（2026-09-27）；实现未开始。
效果图、iOS 复刻和 web 界面 mock 补丁都在 [`docs/mocks/codex-shared-pool/`](./mocks/codex-shared-pool/)。

## 0. 一页结论

- 多个 Orbit 用户把各自的 ChatGPT（Codex）订阅登录放进同一个**共享池**。
  任一成员的 Codex 会话，按「剩余额度 + 自己的账号优先」落到池里的某个账号上。
- **登录只在 Orbit 服务器上**。账号登录由服务器发起、保存和刷新，任何 runner 都拿不到 token。
- **会话仍跑在成员自己的 runner 上**。runner 上的 codex 走现有的自定义 provider 通路，
  `OPENAI_BASE_URL` 指向 Orbit 网关，`OPENAI_API_KEY` 是会话令牌。
  网关代替 codex 带上池内账号的凭据，转发到 Codex 后端。
- **会话侧几乎没有新界面**：
  - 选择器、输入框用量条、换账号提示都是现成的；
  - 新界面只有共享池卡片、池页的 Members / Rules、「Add my account」流程、「New pool」。
- **风险**：共享账号违反 OpenAI 条款（"You may not share your account credentials or make
  your account available to anyone else"），封号按账号封。
  这一点在加账号时明示，决定保留。**不做任何规避检测的措施**。

## 1. 已定

| # | 决定 | 出处 |
|---|---|---|
| D1 | 走方案 3：网关持有登录，runner 不接触凭据 | 讨论 |
| D2 | 成员可以自己加账号（由池规则「Members can add accounts」控制，默认开） | 讨论 |
| D3 | 加账号弹窗保留 OpenAI 风险提示 | 效果图 03 · B |
| D4 | iOS 池页可操作：加账号、左滑移除、两个开关、删除/离开 | 效果图 05 |
| D5 | 换账号提示统一为 `Switched to X — the 5-hour window on Y is spent`，个人池同步 | 效果图 04 |
| D6 | 没出账号的成员也能用池；每人的本周用量份额公开可见 | 效果图 02 |
| D7 | 默认：网关先放在 apiserver 进程里 | 默认，未反对 |

## 2. 架构

```
成员的 runner                         Orbit apiserver                       Codex 后端
codex (custom provider "orbit") ──▶  /gw/codex/responses  ──选账号/换凭据──▶  (池内某账号)
  OPENAI_BASE_URL = 网关               会话令牌 → (pool, user, session)
  OPENAI_API_KEY  = 会话令牌            账号登录：加密存库，服务器刷新
```

### 2.1 账号登录托管

- 「Add my account」在**服务器上**发起 `codex login --device-auth`：
  - 容器里装一份官方 codex CLI，每个账号一个独立的 CODEX_HOME；
  - 界面显示验证页链接和一次性码，沿用 runner 登录中继的状态机；
  - **不自己实现 OAuth**。
- 登录成功后：
  - 读出 token，用 `PROVIDER_SECRET_KEY` 加密存库；
  - 读出账号 id 做判重：同一个 ChatGPT 账号不能进同一个池两次；
  - 读出套餐（Plus / Pro），组成标签「人 · 套餐」。
- 刷新也交给官方 CLI 做，比如 app-server 的 `account/read { refreshToken: true }`，由服务器单点完成。
  **禁止拷贝现成的 auth.json**：refresh token 会轮换，两处同时持有会互相顶掉。
- 登录失效（刷新失败、401）→ 账号状态为 `Unavailable · signed out`，只有贡献者本人能重新登录。

### 2.2 网关

- 路由：`POST /gw/codex/responses`，SSE 原样透传。**路径白名单**：P0 录一次 codex 的真实请求，
  确认要放行哪些路径，其余一律拒绝。
- 鉴权：
  - 会话令牌是随机串，库里只存 hash，绑定 (pool, user, session)，每次 claim 签发；
  - 会话结束、成员被移出、池被删除时，令牌立即失效。
- 转发时：
  - 只替换鉴权，补齐 ChatGPT 登录下 codex 本来会带的账号标识；
  - 其余请求原样转发，上游地址写死；
  - 不改请求内容，也不做任何伪装。
- 用量：
  - Codex 后端的响应里带着这个账号的 5 小时和周窗口用量，codex CLI 自己就是这么读的（P0 核实）；
  - 网关把它写回该账号的快照；
  - `response.completed` 里的 token 数记进用量账本，供 Members 卡计算每人的份额。
- 负载：流式请求期间**不占 DB 连接**。账本写入攒批或异步完成，见过去的连接池争用事故。

### 2.3 选账号与换账号

- 复用 `providers/pool-select.ts` 的语义：
  - 粘住当前账号，能用就不换；
  - 否则按剩余额度排序；
  - 全部用完时，报最早的恢复时间。
- 需要扩的地方：
  - 窗口列表加入 Codex 的 `primary` / `secondary`（目前只认 Claude 的 `fiveHour` / `sevenDay` 等）；
  - 加一条「Own account first」：请求者自己贡献、且还有额度的账号排最前。
- 什么时候选：claim 时选定，记在 `session.pool_account_id` 上；网关按它转发。
- 撞限：
  - 上游回用量耗尽时，网关立刻标记该账号用完，带上恢复时间；
  - 当前回合按现有的撞限流程结束，下一次 claim 换到别的账号；
  - 全部用完时，沿用现有的撞限等待。
- **已知约束**：
  - 换账号提示现在挂在「下一次引擎启动」事件上（`init` / `resumed`）；
  - 网关方案换账号时 runner 的环境不变、引擎不重启；
  - 控制面又**不能自己往 run_event 插行**；
  - 所以提示的投递方式要在 P2 定。
- P0 要验证：同一个 codex 线程换账号后还能否继续（加密 reasoning、prompt cache）。
  不能的话，换账号时丢弃加密 reasoning，或者新开线程接续。

### 2.4 数据模型（P1 定稿，迁移 0320；池里放组织/项目 API key）

- `provider_pool` 加列：`engine`（`claude` | `codex`）、`shared`、`members_can_add`、`own_key_first`（两条规则默认都开）。
  个人池是 `claude` 且不共享（0265 建的都是），共享池是 `codex` 且共享，`provider_pool_engine_check` 把两者绑死。
  `owner_id` 在共享池上是创建者：永远是 ADMIN，不能被降级或移出，要走只能删池。
- `provider_pool_person(pool_id, user_id, role ADMIN|MEMBER)`：共享池的人。
- `pool_api_key`：池里的一把 key。
  - 列：`id, pool_id, contributor_id, label, key_fingerprint, key_hint, secret_encrypted, state, enabled, share_cap, created_at, updated_at`；
  - `secret_encrypted` 用 `PROVIDER_SECRET_KEY` 加密；`key_fingerprint` 是 key 的 SHA-256，`unique(pool_id, key_fingerprint)` 判重；
    `key_hint` 是末 4 位，响应只给 `sk-…AB12`；
  - `state`：`ACTIVE` / `INVALID`（上游 401，由贡献者或管理员替换）/ `DISABLED`（上游因组织/项目停用而拒绝）；
    `enabled` 是贡献者自己的开关；claim 只选 ACTIVE 且 enabled 的；
  - `share_cap`：别人每个自然月（UTC）最多花多少美元（整数，可空 = 不设上限），贡献者自己用不受限；
  - 复合外键 `(pool_id, contributor_id) → provider_pool_person(pool_id, user_id) ON DELETE CASCADE`：
    「贡献者必须是成员」「成员离开，key 跟着走」都由库保证，和 0265 用外键做租户围栏的做法一致。
- `pool_gateway_token(id, token_hash, pool_id, user_id, session_id, created_at, expires_at, revoked_at)`：只存 hash。
  `(pool_id, user_id) → provider_pool_person ON DELETE CASCADE`，`session_id → session ON DELETE CASCADE`：
  成员被移出、池被删除、会话被删，令牌行在同一条语句里消失。
- `pool_usage(pool_id, key_id, user_id, window_start, input_tokens, output_tokens, cost_micros)`：按人、按 key、按月记账，
  `window_start` 是当月 1 日，`cost_micros` 是美元 × 10⁶；`(key_id, pool_id) → pool_api_key(id, pool_id)`。由网关写（P2）。
- `session.pool_key_id`：claim 选定的 key。和 `pool_member_provider_id` 一样不建外键。
- 个人 Claude 池（0265 的同 owner 外键）**不动**。

claim（P1 已落地，`QueueService.resolveSharedPool`）：

- 成员的会话下发 `OPENAI_BASE_URL = <PUBLIC_ORIGIN>/api/gw/codex`、`OPENAI_API_KEY = 会话令牌`，runtime = codex；
  非成员的会话什么都拿不到（按不存在处理）。
- 每次构建引擎环境（claim、runner 重启后的 reclaim、换 provider 的 reload）都签发一个新令牌（`orbit-gw-…`），库里只存 SHA-256。
  同一会话的旧令牌继续有效、过期时间跟着新令牌顺延 7 天——warm 引擎会一直用它被拉起时的那个令牌。
- 选 key 按 `pool-key-select.ts`：粘住当前 key；否则（`own_key_first` 时）先自己的 key；再按剩余额度（无上限 > 有上限且剩得多）；
  跳过关掉的、INVALID/DISABLED 的、别人已把 share cap 花完的；都不行时 `pool_key_id = null`，由网关回话。

### 2.5 权限

| 动作 | 管理员 | 成员 | 非成员 |
|---|---|---|---|
| 看到池、在选择器里选它、在它上面开会话 | ✓ | ✓ | ✗（按不存在处理） |
| 加自己的账号 | ✓ | 规则开着时 ✓ | ✗ |
| 移除账号 | 任何人的 | 只能移除自己的 | ✗ |
| 改规则、加/移成员、删池 | ✓ | ✗ | ✗ |
| 离开池（自己的账号一起离开） | — | ✓ | — |

- 所有接受 provider slug 的入口都要改：建会话、建任务或改任务、改 agent、会话中途换 provider。
  它们现在按「池属于 `session.ownerId`」放行，改成「`session.ownerId` 是池成员」。
- runner 仍然只跑自己 owner 的会话，这一点不变。
- P1 按 key 落地时补的几条（`SharedPoolsService`，接口在 `/api/providers/shared-pools`）：
  - 池的创建者始终是管理员，谁都不能把他降成成员或移出；管理员要离开，得先被别的管理员改成成员；
  - key 的 label / share cap / 开关只有贡献者本人能改；key 被上游 401 置为 INVALID 后，贡献者本人或管理员可以替换；
  - 非成员对池页的每个接口都得到 404，和池不存在时一样。

## 3. 界面

以效果图为准：[`docs/mocks/codex-shared-pool/`](./mocks/codex-shared-pool/)。

| 图 | 内容 |
|---|---|
| 01 | Providers 页共享池卡片与「New pool」 |
| 02 | 池页（管理员 / 成员视角）：Accounts、Members、Rules、删除/离开 |
| 03 | 建池 → 加账号说明（带风险提示）→ 设备码 → 完成 → 重复账号被拒 |
| 04 | 会话里：选择器、输入框用量、换账号提示（新文案） |
| 05 | web 443px 与 iOS 一一对应；iOS 池页可操作，删除账号用左滑 |

- `web-mock.patch` 是只有界面的 mock，数据接口是假的，可以作为 web 实现的起点。
- 文案逐字沿用效果图；web 与原生之间的文案走现有的 parity 测试。

## 4. 风险

- **条款**：共享账号违反 OpenAI 条款，封号按账号封。加账号时明示（D3），不做规避。
- **兼容性**：Codex 后端是否接受 codex 自定义 provider 形状的请求，要 P0 实测。
  codex 升级后请求可能变化，网关要有录制和回放的契约测试。
- **安全**：
  - apiserver 持有所有成员的 ChatGPT 登录，这份登录不只能用 Codex；服务器运维者技术上能解密；
  - 会话令牌泄露的影响限于网关白名单路径和这个池；
  - 日志里不出现 token 和邮箱。

## 5. 分期

- **P0 可行性验证（go / no-go）**：
  - 服务器端设备码登录；
  - 单账号经网关跑通一次 codex 回合（SSE）；
  - 能读到用量；
  - 换账号后线程能否继续；
  - token 刷新。
- **P1 数据与权限**：表、迁移、成员与角色、各入口按成员放行、会话令牌、claim 注入。
- **P2 网关**：转发、选账号（含 Own account first）、撞限换号、用量回写与账本、换账号提示的投递。
- **P3 web 界面**：按效果图 01–04，以 `web-mock.patch` 为起点。
- **P4 iOS / macOS 界面**：按效果图 05，加账号的设备码步骤复用 RunnerSignInView。
- **P5 文案**：`poolSwitchNotice` 改为 D5 的句式，个人池同步；parity 测试。
