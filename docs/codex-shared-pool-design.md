# Codex 共享池（共享组织/项目 API key + 网关）设计

**状态**：方向由账号所有者于 2026-09-27 定为「共享组织/项目 API key + 网关」，取代原「服务器保管成员个人
ChatGPT 登录」；本文档、效果图与 4 项产品决策已按新方向改写（2026-09-28）。P1（数据与权限，迁移 0321）、P2（网关，迁移 0322）、
共享池的 web / iOS 界面，以及池主本人 ChatGPT 账号的池（P3-a / P3-b / P3-c，迁移 0323 / 0324）都已实现。
2026-10-02 池主选定**方案 A**（D8）：服务端（迁移 0355 / 0358）和 web 界面已实现，macOS / iOS 的方案 A 界面截至 2026-10-03 还在做。
**2026-10-03 池主改定：D8 里「ChatGPT 账号只跑池主自己的会话」这条规则去掉**——池里被加进来的人（people）也跑在
池主的 ChatGPT 账号上，与池主同一条顺序（先用账号，账号都不能跑才落到 API key），见下面 D9。旧规则的效果图
（`docs/mocks/account-pool-access/02` 里成员视角的锁定行）不再代表产品行为，图纸未重画。
**2026-10-03 同日再进一步（D10）：池里的人可以签名下自己的 ChatGPT 账号加进池**——加进来的账号与池主的对称，
跑全池的会话；`pool_codex_login` 的复合外键从池主换成池里的**人**（迁移 0371），池主本人才有 `pool_login_token`
（`orbit-gwl-`）这件事不变。这一条把 2026-09-27 的「服务器不代持别人的个人 ChatGPT 凭据」硬边界**有意跨过**：
D9 只借池主的账号跑别人的会话，D10 起服务器还要代持并刷新**成员自己**的个人登录。风险由各贡献者与池主承担，
产品提示如实说明（见 §4）。
效果图、iOS 复刻和 web 界面 mock 补丁都在 [`docs/mocks/codex-shared-pool/`](./mocks/codex-shared-pool/)；
方案 A 的效果图在 [`docs/mocks/account-pool-access/`](./mocks/account-pool-access/)。

**改动日期与原因**：2026-09-27，账号所有者把项目方向定为「共享组织/项目 API key + 网关」。
原方向（成员把个人 ChatGPT 订阅登录放进池里、登录由服务器代持与刷新、靠设备码登录加账号）被三个执行会话
按 OpenAI 条款拒绝——条款不允许共享账号凭据，服务器代持他人的个人登录就是在绕开这一条。
新方向只搬 API key：不变更任何账号的登录态，也不碰个人凭据。

**方案 A（2026-10-02，池主定）**：「本人 ChatGPT 池」和「OpenAI API key 共享池」合成一种 Codex 池。
一个池可以同时有池主的多个 ChatGPT 账号、OpenAI API key 和被加进来的人。
~~ChatGPT 账号只跑池主自己的会话，对别人锁住（不显示邮箱、套餐、`…AB12`、额度）；被加进来的人只跑池里的 API key。~~
**2026-10-03 改定（D9）：账号对池里每个人可用，与池主同一顺序（先用账号，账号都不能跑才落到 API key）；
邮箱、套餐、`…AB12`、额度对成员同样可见。**
**2026-10-03 再定（D10）：池里的人可以把自己名下的 ChatGPT 账号签进池**（谁能加由池规则
`members_can_add_accounts` 控制，默认开）；账号跑全池的会话，只有签名者本人能 Sign in again，签名者本人和池的
管理员可以把它移出。理由：
- OpenAI 条款写的是「You may not share your account credentials or make your account available to anyone else」，
  09-27 改方向也是因为这一条；2026-10-03 池主明确要求去掉「只跑池主」这条规则、并让成员能拿自己的账号入池，
  共享账号与服务器代持个人登录的风险由各贡献者与池主自己承担，产品里的提示如实说明这一点（不再写「别人不能跑」）。
- D9 时 `pool_codex_login` 与 `pool_login_token` 的 `(pool_id, user_id) → provider_pool(id, owner_id)` 外键都原样保留
  （成员跑在池主账号上不需要自己的行）。D10 起前者换成 `(pool_id, user_id) → provider_pool_person(pool_id, user_id)`
  （迁移 0371，与 `pool_api_key.contributor` 同一把围栏）：登录行属于**池里的一个人**，随他离开池一起删；后者不动，
  登录令牌仍只属于池主。

## 0. 一页结论

- 多个 Orbit 用户把各自的**组织/项目 OpenAI API key**（`sk-…`）放进同一个**共享池**。
  任一成员的 Codex 会话，按「剩余额度 + 自己的 key 优先」落到池里的某把 key 上。
- **key 只在 Orbit 服务器上**：用 `PROVIDER_SECRET_KEY` 加密存库，只有 apiserver 里的网关解密使用；
  接口只回打码指纹（`sk-…AB12`），明文不写日志、不进任何 claim 载荷或响应体。
- **会话仍跑在成员自己的 runner 上**。runner 上的 codex 走现有的自定义 provider 通路，
  `OPENAI_BASE_URL` 指向 Orbit 网关，`OPENAI_API_KEY` 是会话令牌。
  网关把令牌换成池内某把 key，其余原样转发给 OpenAI。**runner 上没有任何一把池内 key。**
- ~~**硬边界：服务器不代持、不中转任何别人的个人 ChatGPT 凭据。**~~ **2026-10-03 起这条边界被有意跨过（D9 / D10）**：
  服务器代持池主与各成员**本人经设备码登入**的 ChatGPT 凭据（加密存库、只在服务器上刷新），池主与成员各自承担
  账号共享的条款风险；别人能主动放进池里的仍只有自己的账号（设备码登录）与 API key，见 D9 / D10 与 §4。
- **方案 A（2026-10-02）**：一个 Codex 池可以同时放池里的多个 ChatGPT 账号（池主的，2026-10-03 起也可以是成员自己签进来的）、
  API key 和被加进来的人。会话先用池里的 ChatGPT 账号，都用不了才落到 key。「谁能用」由池里有哪些人派生。
- **会话侧几乎没有新界面**：
  - 选择器、输入框配额条、换 key 提示都是现成的；
  - 新界面只有共享池卡片、池页的 Members / Rules、「Add a key」流程、「New pool」。
    （方案 A 起两种池共用一个池页，Members / Rules 由「Who can use it」卡取代，见 §3。）
- **风险**：key 不得转卖，也不得当作独立账号转给别人用；用这把 key 跑的一切都记在它所属组织/项目的账上，
  由贡献者负责。这一点在加 key 时明示，决定保留。**不做任何规避检测的措施**。

## 1. 已定

| # | 决定 | 出处 |
|---|---|---|
| D1 | 走「共享组织/项目 API key + 网关」：key 只在服务器，runner 不接触凭据 | 2026-09-27 账号所有者定（原 D1「网关持有成员个人登录」作废，理由见上） |
| D2 | 成员可以自己加 key（由池规则「Members can add keys」控制，默认开） | 讨论（原「成员可以自己加账号」按新方向改写） |
| D3 | 加 key 弹窗保留风险提示（key 不得转卖、贡献者对其使用负责） | 效果图 03 · B（提示本身保留，文案改 key 版） |
| D4 | iOS 池页可操作：加 key、左滑移除、两个开关、删除/离开 | 效果图 05 |
| D5 | 换 key 提示：`Switched to X — Y is out of budget`；401 时 `Switched to X — Y was rejected by OpenAI`；个人 Claude 池保持已上线的 `the 5-hour window on Y is spent` 句式 | 效果图 04（原 D5 是个人登录版的同一句式） |
| D6 | 没出 key 的成员也能用池；每人的用量份额公开可见 | 效果图 02 |
| D7 | 默认：网关先放在 apiserver 进程里 | 默认，未反对 |
| D8 | 方案 A：一种 Codex 池，可以同时有池主的多个 ChatGPT 账号、OpenAI API key 和被加进来的人。「谁能用」（Just me / Me and people I add）由池里的人派生；D9 覆盖其中「账号只跑池主自己的会话」一条 | 2026-10-02 池主定（效果图 `account-pool-access/02` 的主方案；同图的「方案 B · 两种池不合并」未采用）。0323 / 0324 的池主外键不变、不放宽（见文首） |
| D9 | **池主的 ChatGPT 账号，池里的每个人都能跑**（2026-10-03 池主定，取代 D8 里「只跑池主自己的会话」）：与池主同一条顺序——先用账号，账号都不能跑才落到 API key。理由是池主本人要求把「只跑池主」这条规则去掉，共享账号的风险（OpenAI 条款视为违规、账号可能被限制）由池主自己承担；产品里的提示改成如实说明这一点（登录弹窗、Who can use it 卡脚注） | 2026-10-03 池主定，经会话确认（含账号优先、成员看到完整账号卡片、macOS / iOS 一起改）。当时 0323 / 0324 的池主外键不变——别人跑在池主账号上不需要自己的 `pool_codex_login` / `pool_login_token` 行；`pool_codex_login` 的围栏已由 D10 换成池里的人（0371） |
| D10 | **池里的人可以签名下自己的 ChatGPT 账号加进池**（2026-10-03 池主定）：两种池（本人的 Codex 池与共享池 0321）都行；加进来的账号与池主的完全对称——跑全池的会话，先用账号、账号都不能跑才落到 key；**只有签名者本人**能 Sign in again（管理员也没有那个账号的凭据），签名者本人与池的管理员可以把它移出；能否加由池的新规则 `members_can_add_accounts`（默认开）控制，与 key 的规则 `members_can_add` 各管一摊。数据上 `pool_codex_login` 的复合外键从池主换成池里的**人**（迁移 0371，`(pool_id, user_id) → provider_pool_person`，与 `pool_api_key.contributor` 同一把），登录令牌 `pool_login_token` 仍只属于池主（`orbit-gwl-`） | 2026-10-03 池主定，经会话确认（账号范围＝池里每个人、管理权＝贡献者＋池主、独立规则、两种池都行）。**有意跨过 2026-09-27「服务器不代持别人的个人登录」的硬边界**：D9 是借池主账号跑别人的会话，D10 起服务器还代持并刷新成员自己的个人 ChatGPT 登录；风险由各贡献者与池主承担，提示如实（§4） |

## 2. 架构

```
成员的 runner                         Orbit apiserver                        OpenAI
codex (custom provider "orbit") ──▶  /gw/codex/responses  ──池内某把 key──▶  api.openai.com
  OPENAI_BASE_URL = 网关               会话令牌 → (pool, user, session)
  OPENAI_API_KEY  = 会话令牌           池内 key：加密存库，网关解密使用
```

### 2.1 加入一把 key

- 入口：池页的「Add a key」。成员（池规则开着时）和管理员都能加；加进来的 key 属于贡献者本人。
- 表单：**key**（`sk-…`）、**名字**（列表里认得出是哪把，如 `orbit-org-1`）、可选的 **share cap**
  （别人每月最多花多少；留空＝不限。自己用不受这个上限约束）。
- 提交后（服务器）：
  1. 校验格式（`sk-` 前缀与长度）；不合法当场拒，不用打上游；
  2. 按**指纹**判重：指纹是 key 的 sha256，`unique(pool_id, key_fingerprint)`。
     同一把 key 进同一个池两次被拒，文案见效果图 03 · E；
  3. 用 `PROVIDER_SECRET_KEY` 加密存库（与现有 provider key 同一套密钥与封装）；
  4. 只回**打码指纹** `sk-…AB12`（后 4 位）：界面、日志、响应体里都只有它，明文不回显。
- 上游拒绝（401）→ 该 key 置 `INVALID`：池不再选它，当前会话换下一把；
  由**贡献者本人或管理员**用「Replace key」换上 key：同样校验格式、加密存库、只回打码指纹。
  判重管的是**加入**：换成池里另一把已有的 key 仍被拒；重填同一把 key 就是替换，收下并置回 `ACTIVE`，
  若上游仍拒，下一次 401 再置 `INVALID`。
- 429 `rate_limit_exceeded` 不是失效：网关先在同一把 key 上退避；退避用尽仍是 429 时给该 key 记一个短期
  throttle（0382），下一次 claim 可以换走，见 §2.3。

### 2.2 网关

- 路由：`POST /gw/codex/responses`，SSE 原样透传。**路径白名单**：P0 录一次 codex 的真实请求，
  确认要放行哪些路径，其余一律拒绝。
- 鉴权：
  - 会话令牌是随机串，库里只存 hash，绑定 (pool, user, session)，每次 claim 签发；
  - 会话结束、成员被移出、池被删除时，令牌立即失效。
- 转发时：
  - 只替换鉴权：`Authorization: Bearer <池内某把 key>`（从库里解密，用完即弃，不写日志）；
  - 其余请求原样转发，上游地址写死 `https://api.openai.com`；
  - 不改请求内容，也不做任何伪装。API key 的请求本来就带组织/项目，不需要补任何账号标识。
- 用量：
  - 应答里的 token 计数（`usage`）记进用量账本：按 key、按人；
  - 每个 key 的本窗口用量写回它的快照，池页与选择器读的就是这一份；
  - 上游若回组织级用量（`x-ratelimit-*` 一类），一并记进同一快照（P0 核实要读哪几个头）。
- 负载：流式请求期间**不占 DB 连接**。账本写入攒批或异步完成，见过去的连接池争用事故。
- P2 落地（`providers/pool-gateway.service.ts`，`/api/gw/codex/*`）：
  - 白名单只有 `POST /responses`：codex 0.158 经自定义 provider 只发这一个（上下文压缩也走它），
    录制在 `providers/fixtures/codex-gateway-recording.json`（runner-go `codex_gateway_recording_test.go` 用生产 builder 驱动真 codex 生成，
    codex 升级时重录），`pool-gateway.pg.spec.ts` 把它经真网关回放；
  - 令牌：按 hash 查，未撤销、未过期、会话 open、会话仍在这个池上、令牌的人就是会话 owner，否则 401；
    成员移出、池删除、会话删除靠外键级联删令牌行；白名单外 403；
  - 转发：codex 发来的请求体一字不改；头只去掉逐跳头和自家边缘（Cloudflare、nginx）加的头（含 `accept-encoding`，
    codex 本身不发），鉴权换成会话当前那把 key；上游地址写死 `https://api.openai.com/v1`；
  - key 用不了（没选到、贡献者关了、INVALID/DISABLED、别人把 cap 花完——含账本还没落库的部分）→ 403 并写明原因，不打上游；
  - 上游 401 → key 置 INVALID，回 403 + 自己的说明（上游 401 的 body 带 OpenAI 打码的 key 前后缀，
    且 runner 会把 `401 Unauthorized` 画成登录卡片，而成员自己的凭据没问题）；
  - 上游 `insufficient_quota` → `spent_until` = 上游给的恢复时间，否则下个自然月 1 日（UTC），响应原样转回；
  - 用量：旁路解析 `response.completed`（及带 usage 的 incomplete / failed），按模型价表（`providers/openai-prices.ts`）
    算 `cost_micros`，内存攒批每 2 秒一条 upsert（`PoolUsageLedger`）；
  - API key 没有 5 小时 / 周窗口（codex 的 primary / secondary 来自 ChatGPT 订阅的 `x-codex-*` 头，api.openai.com 不发），
    `x-ratelimit-*` 是每分钟限流、不是用量，所以 key 的「本窗口」就是账本的自然月，不另存快照。
- P3-b 落地（2026-09-28 方向：账号所有者**本人的一个** ChatGPT 登录、服务器代管；迁移 0324，
  `providers/pool-login-gateway.service.ts`）：
  - 同一个 `/api/gw/codex/*`，按会话令牌前缀分流：`orbit-gw-` 是共享池（上面那套），`orbit-gwl-` 是登录型池
    （表 `pool_login_token`：人按 `(pool_id, user_id) → provider_pool(id, owner_id)` 钉死为池主，令牌绑定 claim 时池里的账号，
    账号被移出即级联删令牌）。claim / reclaim / 换 provider 的 reload 都经 `QueueService.resolveLoginPool` 下发网关地址与令牌，
    并把账号记在 `session.pool_codex_account_id`（会话读接口不返回它）。
    （方案 A 起前缀只说明令牌存在哪张表，上游按会话当前的凭据定；0355 起令牌不再绑定账号。见下面「方案 A 落地」。）
  - 上游写死 `https://chatgpt.com/backend-api/codex`，鉴权换成 `Authorization: Bearer <access token>` + `ChatGPT-Account-ID`，
    与官方 codex CLI 用 ChatGPT 登录时一致；其余头与请求体原样转发。依据是两份录制：runner 侧 codex 经自定义 provider 发来的
    （`fixtures/codex-gateway-recording.json`）与官方 CLI 用 ChatGPT 登录直连后端时发出的
    （`fixtures/codex-chatgpt-backend-recording.json`，runner-go `codex_chatgpt_backend_recording_test.go` 驱动真 codex 0.158、
    假登录、本机 TLS 录制桩生成）。两者请求体字段集相同、`instructions` 一字不差；CLI 以内置 provider 身份才加的
    `version`、`x-codex-routing-hint` 与 zstd 压缩，网关不代加（只换鉴权、不做任何伪装）。
  - 白名单仍只有 `POST /responses`：CLI 以 ChatGPT 登录自己会去后端拿的 models、workspace 路由（`/wham/accounts/check`）、
    插件、设置、埋点都不经网关，令牌也够不着。
  - 刷新只在网关一处：access token 离过期 5 分钟内先刷新；上游 401 就按 CLI 同样的请求（JSON：`client_id` / `grant_type` /
    `refresh_token`，打 `https://auth.openai.com/oauth/token`）刷新一次再重发。刷新在账号行的行锁下做、进程内合并（refresh token
    只能用一次）；token 端点按 CLI 的分类拒绝（401、`invalid_grant`、`refresh_token_expired|reused|invalidated`）或新 token 仍被 401
    → 账号置 `SIGNED_OUT`（`last_error` 为原因），回 403 `orbit_pool_login_signed_out`（「only you can sign in again」），
    只有池主能经设备码重新登录；同一账号重登后原会话令牌照常可用。
  - 额度：上游 429 `usage_limit_reached`（CLI 据 `error.resets_at` 报 usageLimitExceeded、不重试）→ `pool_codex_login.spent_until`
    = `resets_at`，答复原样转回；失败回合的重试武装在这个时间（`QueueService.loginPoolRetryAt` / `accountPoolResumesAt`），
    **不换号**，会话上的账号不变；上游再收下一次请求即清除。`rate_limit_exceeded` 在同一登录上退避（同 P2）。
    （P3-b 时池里只有一个账号。多账号起网关仍然不换号，但有别的账号或 key 能跑时重试时间是「现在」，下一次 claim 把会话换过去，见 §2.3「方案 A 落地」。）
  - 提示：额度用完与被登出时给会话挂 `pool_switch_notice`（`The 5-hour window on X is spent — this session waits for its reset at …`
    / `The ChatGPT account X on "P" was signed out by OpenAI — only you can sign in again, on the pool's page`）；那一回合失败会清空
    会话的待发队列，所以空 reload 由下一次 claim 排（与 P2 换 key 同一时机），resident 引擎用 `resumed`、冷启动用 `init` 带走，
    控制面不插 run_event。回合失败当时，codex 自己的报错（`You've hit your usage limit… try again at …` / 网关 403 的原文）已在
    transcript 里。个人 Claude 池的换号句式不变。（多账号起，claim 把会话换到别的账号或 key 时，用「Switched to …」替掉网关留下的这句，见 §2.3。）
  - 账本 `pool_login_usage`：按会话、账号、UTC 整点小时记 requests / input（含 cached）/ output token 与按 API 价表折算的
    `cost_micros`（订阅不按 token 计费，这是可比的等价成本）；`x-codex-*` 窗口读数写回 `pool_codex_login.usage`，池页据此显示用量。
    两者都内存攒批、每 2 秒各一条语句写入，流式期间不占 DB 连接。
- 方案 A 落地（2026-10-02，迁移 0355；`providers/pool-gateway.controller.ts`）：
  - 令牌只认证 (pool, user, session)。前缀只说明它存在哪张表：`orbit-gwl-` 是 `pool_login_token`（只发给池主自己的会话），
    `orbit-gw-` 是 `pool_gateway_token`（池里某个人的）。白名单仍只有 `POST /responses`，两侧共用（`gatewayAllows`）。
  - 上游由会话**当前**的凭据决定，每个请求现读：`session.pool_codex_account_id` → ChatGPT 的 Codex 后端
    （`PoolLoginGatewayService.forward`）；`session.pool_key_id` → `api.openai.com`（`PoolGatewayService.forward`，账本与 share cap 照 P2）。
    两个都空时由令牌那一侧回话：登录令牌按「池里没有账号」回 403 `orbit_pool_login_missing`，个人令牌按「没有你能用的 key」回 403 `orbit_pool_key_unavailable`。
  - ~~ChatGPT 账号只跑池主的会话：会话的 owner 不是池主，就在读任何账号之前回 403 `orbit_pool_login_owner_only`~~
    ——2026-10-03 起这条已去掉（D9）：池主的会话（`orbit-gwl-` 令牌）和被加进来的人的会话（`orbit-gw-` 令牌）都
    由这里转发到会话当前的账号；账号的登录 / 重登 / 登出仍只在池主那组门（CodexLoginService）。
    账号被登出 / 池里没有账号的拒绝语按读者与**该账号的签名者**的关系分两种（D10 起）：签名者本人读到
    "only you can sign in again"，别人读到 "only the person who signed it in can sign it in again"（池里没有账号时
    对所有人同一句 "sign one in on its page"，谁能加由池规则决定）。
  - 令牌不再绑定账号（0355）：warm 引擎拿着换号前签发的令牌，下一次请求就走会话现在的账号，不用重启引擎；
    移出一个账号不会让别的会话的令牌失效，正在用这个账号的会话收到 403 `orbit_pool_login_missing`，直到下一次 claim 把它换走。
  - 池主的会话落到 key 上时，用的仍是同一个 `orbit-gwl-` 令牌；被加进来的人永远只有 `orbit-gw-` 令牌。

### 2.3 选 key 与换 key

- 复用 `providers/pool-select.ts` 的语义：
  - 粘住当前 key，能用就不换；
  - 否则按剩余额度排序；
  - 全部用完时，报最早的恢复时间。
- 需要扩的地方：
  - 「Own key first」：请求者自己贡献、且还有额度的 key 排最前；
  - 上限判定：某把 key 被别人花到 share cap 后，跳过它（贡献者自己的会话不受这条限制）。
- 什么时候选：claim 时选定，记在会话的 pool key 上；网关按它转发。
- 撞限：
  - 上游 `insufficient_quota`（或余额用尽）→ 网关立刻标记该 key 本窗口用完，带上恢复时间（上游给的话）；
    当前回合按现有的撞限流程结束，下一次 claim 换到别的 key；
  - 上游 401 → 该 key 置 `INVALID`，下一次 claim 换到别的 key，等贡献者本人或管理员替换；
  - 上游 `rate_limit_exceeded`（429）→ 网关先在**同一把 key 上退避**，不跳 key；退避用尽仍是 429 时给该 key
    记一个短期 throttle（迁移 0382），下一次 claim 可以换走；
  - 全部用完时，沿用现有的撞限等待。
- 换 key 提示（D5）：
  - `Switched to orbit-org-2 — orbit-org-1 is out of budget`
  - `Switched to orbit-org-2 — orbit-org-1 was rejected by OpenAI`
  - `Switched to orbit-org-2 — orbit-org-1 is disabled`
- **已知约束**：
  - 换 key 提示现在挂在「下一次引擎启动」事件上（`init` / `resumed`）；
  - 网关方案换 key 时 runner 的环境不变、引擎不重启；
  - 控制面又**不能自己往 run_event 插行**；
  - 所以提示的投递方式要在 P2 定。
- P2 定下的做法（`QueueService.resolveSharedPool`、`pool-key-select.ts`）：
  - 网关从不换 key，只标记；换 key 只在 claim 时发生，提示写进 `session.pool_switch_notice`，
    由下一个 `init` / `resumed` 带走（与个人池同一机制）；
  - warm 引擎被 claim 复用时不发 init/resumed，所以 claim 换了 key 就在 inbox 排一个空 `reload`（content `{}`，
    出队不带 env，runner 不重启，只回一条 `resumed (config_changed)`），inbox 本来就把 reload 排在等待的消息前，
    提示正好落在用新 key 跑的回合之前；冷启动时提示由引擎自己的 init/resumed 带走，这条 resumed 什么都不带；
  - key 版句式另加一条：key 已被移出池时 `Switched to X — the previous key is no longer in this pool`；
    别人把 share cap 花完也说 `is out of budget`；
  - 没有 key 能跑时会话留在原 key 上（不置 null），网关回 403 说明原因，之后换走时提示能说出从哪把换走；
  - 撞限后的回合：回合失败时若会话的 key 已不能再跑（按库里状态判，不看 codex 的措辞），
    turn-complete / finalize 按 `QueueService.sharedPoolKeyRetryAt` 武装自动重试（另一把 key 能跑＝现在，
    全部用完＝最早恢复时间）；`accountPoolResumesAt` 对共享池给出同一个时间，sweeper 和任务的额度闸都按它；
  - `rate_limit_exceeded`：codex 自己不重试 429（0.160 实测：只发一次请求就判失败，`request_max_retries` 也管不着），
    网关在同一把凭据上按 retry-after / x-ratelimit-reset-* 退避重发（最多 4 次，单次 ≤20s、合计 ≤40s）。
    仍是 429 时网关把 429 原样转回，并给该凭据记一个短期 `throttled_until`（迁移 0382，60s–15min，与订阅窗口的
    `spent_until` 严格分开）：它落在 `loginCanRun` / `keyCanRun` 里，于是下一次 claim 能换到别的账号或 key，
    换不了时会话留在原处、`loginPoolRetryAt` / `sharedPoolKeyRetryAt` 按这个时刻武装重试 —— 而不是走通用的
    30s/2m/5m API 错误梯度（那条梯度只留给池回答不了的会话，例如 BYOK 自定义 provider）。
    这会话层的一条由 `retryPlanFor` 里 `isRateLimitApiErrorText` 分流。
- 方案 A 落地（2026-10-02，`providers/pool-credential-select.ts` 的 `choosePoolCredential`，账号之间的规则在 `pool-login-select.ts`）：
  构建引擎环境的每个入口（claim、runner 重启后的 reclaim、换 provider 的 reload）都在这里选一次，记在会话上（`pool_codex_account_id`
  或 `pool_key_id`，两者至多一个有值），网关只照着转发。
  - **每个人都是同一条顺序**（2026-10-03，D9）：先用 ChatGPT 账号，一个都不能跑时才用 API key。
    理由：订阅额度用了不另花钱，key 按用量计费。会话落在 key 上以后，哪一次 claim 发现有账号能跑了，就换回账号。
    池主自己的会话走 `QueueService.resolveLoginPool`（`orbit-gwl-` 令牌），被加进来的人的会话走 `resolveSharedPool`
    （`orbit-gw-` 令牌），两边都调用同一个 `choosePoolCredential`，账号优先这条对谁都不再区分。
    - 账号能跑（`loginCanRun`）：ACTIVE、`spent_until` 没到、最近一次读数里没有用满（≥100%）且还没重置的窗口。
    - 账号之间（`chooseLoginAccount`，和 `pool-select.ts` 同一套规则）：粘住当前账号，能跑就不换；否则在能跑的账号里，
      没接近用完的（5 小时窗口 80%、更长的窗口 90%）排在接近用完的前面，再按额度最先过期 / 重置的（`quotaExpiresAt`）、
      5 小时窗口用得少的（没有读数的排最后）排，还平手就取较早加入的账号。
    - key 之间按 `pool-key-select.ts`：粘住当前 key；池的 `own_key_first` 开着时池主自己的 key 优先；跳过关掉的、INVALID / DISABLED 的、
      `spent_until` 没到的，以及别人贡献、本月已被贡献者以外的人花到 share cap 的（share cap 不限制贡献者本人，池主用别人的 key 也受它限制）。
    - 账号和 key 都不能跑：会话留在原来的账号或 key 上，由网关回原因；从没落过、或原账号已不在池里的会话，记到最先恢复的那个账号上
      （都等不回来就记到最早加入的账号），这样网关回的是额度原因，而不是「池里没有账号」。
  - **被加进来的人**（`QueueService.resolveSharedPool`；2026-10-03 起）：读池里的账号（`sharedPoolOf` 一并取出 `pool_codex_login`
    的 accountId / email / state / spentUntil / usage），与 key 一起交给同一个 `choosePoolCredential`——账号优先，own key first 与
    share cap 只在落到 key 上时照旧；换号提示里 key → 账号那一句对成员说 `the pool's ChatGPT accounts come first`（对池主仍是
    `your ChatGPT accounts come first`）。账号和 key 都不能跑时会话留在原来的账号或 key 上，由网关回原因。
  - **共享池**（`shared=true`，0321；池里没有账号）不受影响：所有人都只在 key 之间选；会话行上残留的账号 id
    （以前在自己的本人池上跑过）仍直接清掉，不写提示。
  - 换号提示沿用个人池的句式。账号用邮箱称呼，没有邮箱时用 `…` 加账号 id 末 4 位；key 用它的名字：
    - 账号 → 账号：`Switched to <Y> — the <5-hour|weekly> window on <X> is spent`；X 被 OpenAI 登出时 `Switched to <Y> — <X> was signed out by OpenAI`；
      只有 `spent_until`、说不出是哪个窗口时 `Switched to <Y> — the usage limit on <X> is reached`；
      只是被限流（0382 的 `throttled_until`）时 `Switched to <Y> — <X> is rate limited right now`；
      X 已被移出池时 `Switched to <Y> — the previous account is no longer in this pool`。
      例：`Switched to hl.work@gmail.com — the weekly window on jianghailong.rd@gmail.com is spent`。
    - 账号 → key：原因同上，前面换成 key 的名字，如 `Switched to orbit-org-1 — the weekly window on jianghailong.rd@gmail.com is spent`。
    - key → 账号：池主的会话说 `Switched to <账号> — your ChatGPT accounts come first`；被加进来的人的会话说
      `Switched to <账号> — the pool's ChatGPT accounts come first`（key 本身没问题，只是会话先用账号；2026-10-03 起账号对
      池里每个人都是「先用账号」）。
    - key → key：仍是 D5 的句式（被限流时 `Switched to <Y> — <X> is rate limited right now`）。
      会话第一次落到某个凭据上是起点，不算换号，不写提示。
    - 网关在额度用完 / 被登出时留下的那句（`The <window> window on X is spent — this session waits for its reset at …` 等）
      只在没有别的账号或 key 能跑、会话留在原处时保留；claim 把会话换走时用「Switched to …」替掉它。
      投递照旧：claim 时给 warm 引擎排一个空 reload，reclaim / reload 由重启的引擎自己的 init / resumed 带走。
  - 等待与重试：`loginPoolRetryAt` 在会话当前的凭据还能跑时为 null（失败不怪它）；否则取账号（`loginPoolResumesAt`）
    和 key（`poolKeysResumeAt`）里最早能跑的时间——有别的账号或 key 能跑＝现在，全部用完＝最早的恢复时间，
    等也等不回来（全部被登出、池里没有能用的凭据）＝null。`accountPoolResumesAt` 对这类池给同一个时间，sweeper 和任务的额度闸都按它。
  - 入口拒绝（`codexPoolUnavailableReason`）：池里一个 ACTIVE 账号都没有、也没有一把开着且没被 OpenAI 拒的 key 时才拒，原因点名账号；
    读者是被加进来的人时措辞改成 "ask its owner to sign in (again), on the pool's page"（他不能自己登录）。
  - 账号状态的实时推送（`CodexLoginService.publishPool`）自 2026-10-03 起到池的**所有人**（`provider_pool_person`），
    不再只推池主：账号被登出 / 用满 / 重置决定成员能否开会话，成员页面和选择器要跟着失效重读。
- P0 要验证：同一个 codex 线程换 key 后还能否继续（加密 reasoning、prompt cache）。
  不能的话，换 key 时丢弃加密 reasoning，或者新开线程接续。
- P0 结论（2026-10-02 实测，见任务「P0 验证：换号后 codex 线程能否接着跑」的证据）：**换号后同一个 codex 线程能直接续上，不需要降级。**
  - 测法：codex-cli 0.160.0（与 runner 用的是同一个二进制），自定义 provider 照 `codexProviderArgs` 配，`base_url` 指向本机一个仿
    `/api/gw/codex` 的转发桩：头处理照网关（只换鉴权，ChatGPT 加 `ChatGPT-Account-ID`），请求体不改。模型 gpt-5.5（effort high）。
    请求都是 `store=false`、`include=reasoning.encrypted_content`，不带 `previous_response_id`。
  - ChatGPT 账号 A → 账号 B、ChatGPT 账号 → API key、API key → ChatGPT 账号，三种换号后的那一回合都返回 200 并完成，
    前几回合的上下文都还在；同一个常驻 app-server 里连续换号也没问题。上游照样接受别的账号产生的加密 reasoning，
    只有密文被改动时才回 400 `invalid_encrypted_content`。
  - 所以换号时网关只换鉴权、请求体不动，不丢 reasoning，也不新开线程；多账号换号和方案 A 都是这样实现的。
    降级办法也实测可行，只是用不上：丢弃 reasoning 项、只去掉 `encrypted_content`、新开线程带上可见对话（这一种会丢工具调用结构，线程 id 也会变）。
    将来真遇到 400 `invalid_encrypted_content`，首选丢弃 reasoning 项后重发一次；这个兜底目前没有实现。
  - 成本：换号后第一个请求的 prompt cache 只命中公共指令前缀，线程历史按未缓存计费一次，之后恢复命中。
  - 没覆盖到的：转发用的是仿网关桩（真网关按会话当前账号转发，由 `pool-login-gateway.pg.spec.ts` 用桩上游验证：令牌签发于 A、会话改到 B，
    上游收到 B 的 `ChatGPT-Account-ID`）；只测了 gpt-5.5；没测 B → A；ChatGPT 账号只测了两个个人账号（Plus、Pro），Team / Enterprise 工作区没测，
    API key 只测了一个组织；key 与 key 之间的换号没有单独测。

### 2.4 数据模型（P1 定稿，迁移 0321；池里放组织/项目 API key）

- `provider_pool` 加列：`engine`（`claude` | `codex`）、`shared`、`members_can_add`、`own_key_first`（两条规则默认都开）。
  个人池是 `claude` 且不共享（0265 建的都是），共享池是 `codex` 且共享，`provider_pool_engine_check` 把两者绑死。
  （0323 放宽了这条 CHECK：不共享的池可以是 `claude` 或 `codex`，共享池仍只能是 `codex`。下文的「Codex 池」指 `engine = 'codex'` 的池，共享与否都算。）
  `owner_id` 在共享池上是创建者：永远是 ADMIN，不能被降级或移出，要走只能删池。
- `provider_pool_person(pool_id, user_id, role ADMIN|MEMBER)`：共享池的成员。创建者是 ADMIN。
  0358 起每个 Codex 池都有池主的这一行，见下面「方案 A 的数据模型」。
- `pool_api_key`：池里的一把 key。
  - 列：`id, pool_id, contributor_id, label, key_fingerprint, key_hint, secret_encrypted, state, enabled, share_cap, created_at, updated_at`；
    - `label`：贡献者给这把 key 起的名字（`orbit-org-1`），列表和提示里都用它；
    - `key_fingerprint`：key 的 sha256，`unique(pool_id, key_fingerprint)` 判重；
    - `key_hint`：key 的末 4 位，响应只给 `sk-…AB12`；
    - `secret_encrypted`：`PROVIDER_SECRET_KEY` 加密后的 key 本体，只在服务器上解密，任何响应都不带它；
    - `state`：`ACTIVE` | `INVALID`（上游 401 置）| `DISABLED`（上游因组织/项目停用而拒绝）；
    - `enabled`：贡献者自己的开关，界面上的 `Disabled` 就是它关着；claim 只选 `ACTIVE` 且开着的；
    - `share_cap`：别人每个自然月（UTC）最多花多少美元（整数，空＝不限；自己用不受限）。
  - 本窗口用量不存在 key 行上，从 `pool_usage` 按月汇总；草案里的 `window_usage`（上游报的恢复时间）由 P2 落成
    `spent_until`（迁移 0322）：上游 `insufficient_quota` 后到这个时间之前 claim 不选它，经它成功一次或替换 key 即清除；
    `last_error` 没有加。
  - 复合外键 `(pool_id, contributor_id) → provider_pool_person(pool_id, user_id) ON DELETE CASCADE`：
    「贡献者必须是成员」「成员离开，key 跟着走」都由库保证，和 0265 用外键做租户围栏的做法一致。
- `pool_gateway_token(id, token_hash, pool_id, user_id, session_id, created_at, expires_at, revoked_at)`：只存 hash。
  `(pool_id, user_id) → provider_pool_person ON DELETE CASCADE`，`session_id → session ON DELETE CASCADE`：
  成员被移出、池被删除、会话被删，令牌行在同一条语句里消失。
- `pool_usage(pool_id, key_id, user_id, window_start, input_tokens, output_tokens, cost_micros)`：按 key、按人、按月记账，
  `window_start` 是当月 1 日，`cost_micros` 是美元 × 10⁶；`(key_id, pool_id) → pool_api_key(id, pool_id)`。由网关写（P2）。
- `session.pool_key_id`：claim 选定的 key。和 `pool_member_provider_id` 一样不建外键。
- 个人 Claude 池（0265 的同 owner 外键）**不动**。

claim（P1 已落地，`QueueService.resolveSharedPool`）：

- 成员的会话下发 `OPENAI_BASE_URL = <PUBLIC_ORIGIN>/api/gw/codex`、`OPENAI_API_KEY = 会话令牌`，runtime = codex；
  非成员的会话什么都拿不到（按不存在处理）。
- 每次构建引擎环境（claim、runner 重启后的 reclaim、换 provider 的 reload）都签发一个新令牌（`orbit-gw-…`），库里只存 SHA-256。
  同一会话的旧令牌继续有效、过期时间跟着新令牌顺延 7 天——warm 引擎会一直用它被拉起时的那个令牌。
- 选 key 按 `pool-key-select.ts`：粘住当前 key；否则（`own_key_first` 时）先自己的 key；再按剩余额度（无上限 > 有上限且剩得多）；
  跳过关掉的、INVALID/DISABLED 的、别人已把 share cap 花完的、`spent_until` 未到的（P2）；都不行时会话留在原来那把 key 上
  （从没有过 key 的仍是 null），由网关回话（P2 起；P1 当时是置 null）。
- 0358 起，被加进来的人在别人的本人 Codex 池上也走这里（`orbit-gw-` 令牌；2026-10-03 起与池主一样先用池里的 ChatGPT 账号，
  账号都不能跑才落到 key）；池主自己的会话走 `resolveLoginPool`（`orbit-gwl-` 令牌）。见 §2.3「方案 A 落地」。

方案 A 的数据模型（2026-10-02，迁移 0355 / 0358；0323 / 0324 的池主外键不变）：

- **所有 Codex 池都有池主的 `provider_pool_person` 行**（role ADMIN）。共享池（0321）建池时就有；本人 Codex 池
  （`engine = 'codex' AND NOT shared`，0323 建的）由 0358 回填，`created_at` 取池的创建时间，`ON CONFLICT DO NOTHING`
  （已有的行保留原来的 role）；之后新建的 Codex 池由 `ProvidersService.createPool` 在建池的同一条写入里建这一行。Claude 池不收人，不涉及。
  有了这一行，池主就能经共享池那一组门（`SharedPoolsService`）往自己的池里加人、加 key，`pool_api_key`、`provider_pool_person`
  与 `pool_codex_login` 的行并存在同一个池上。0321 的 key 只经 `id` 连到 `provider_pool`，对池没有别的条件，所以 0358 没有加、删或改任何约束，
  唯一的写入就是这条 INSERT。
- **「谁能用」由池里的人派生，不另存**：只有池主一行＝Just me；还有别人＝Me and people I add。
  回到 Just me 就是把别人都移出：每移出一个人，他加的 key 和他的网关令牌都经 0321 的复合外键随他的那一行一起删掉。
- **`shared` 不改写**，仍然只表示「在共享池页建的、只有 API key、永远没有 ChatGPT 账号的池」；本人池不管加了谁都是 false，
  池主的会话在上面仍先用 ChatGPT 账号。不改写的理由（迁移头部写明）：跟着人数变的 `shared` 等于把人员行已经说明的事实再存一份，
  每次加人、移人都要同步；而且现在读 `shared` 的地方（登录 `CodexLoginService`、池主的池列表与池页 `ProvidersService`、claim
  `QueueService.accountPool`）都把它读成「这里没有 ChatGPT 账号」，加一个人就会让池主的账号离开池主自己的会话和池页。
- **一个池多个 ChatGPT 账号（D10 起还是多个人的）**：`pool_codex_login` 的主键 0323 起就是 `(pool_id, account_id)`，没有新迁移。服务端不再拒绝第二个账号
  （`POOL_CODEX_ACCOUNT_TAKEN` 已去掉）；同一个账号再登回 409 `POOL_CODEX_ACCOUNT_DUPLICATE`（`This ChatGPT account is already in "<池名>"`），
  已被登出（SIGNED_OUT）的同一个账号重登则接管原来那一行——**但只有把它签进来的那个人能重登**，同样的账号由别人签回
  仍是 409 `POOL_CODEX_ACCOUNT_DUPLICATE`（行随贡献者走，见上）。账号按 `created_at`、`account_id` 升序（较早加入的在前）。
  登出只移除一个账号：`DELETE /api/providers/pools/:id/codex-login/account?fingerprint=…AB12`；两个账号后四位相同时回 409
  `POOL_CODEX_ACCOUNT_AMBIGUOUS`，什么都不删。
- **令牌与账号解绑（0355）**：`pool_login_token` 去掉 `account_id` 列、`(pool_id, account_id) → pool_codex_login` 外键和这一对的索引。
  令牌行就是 (pool_id, user_id, session_id) + hash + 时间，不点名任何账号，所以移出账号也删不到它。
  会话跑在哪个账号上只看 `session.pool_codex_account_id`（0324），网关每个请求现读。0355 原本写作 0348，落地前因 main 已有
  `0348_session_folder` 改号。
- **会话上的凭据**：`session.pool_codex_account_id`（0324）和 `session.pool_key_id`（0321），claim 写下选中的那一个、清掉另一个。
  被加进来的人的会话自 2026-10-03 起也会是 `pool_codex_account_id`——他们跑在池里的账号上（D9 起是池主的，D10 起也可以是
  某个成员自己的）——但永远不会有 `pool_login_token` 行：那张表的外键（0324）把它钉在池主身上，他们的令牌始终是
  `pool_gateway_token`（`orbit-gw-`）。
- **账号的围栏是池里的一个人（D10，迁移 0371）**：`pool_codex_login_pool_id_user_id_fkey` 从
  `FOREIGN KEY (pool_id, user_id) REFERENCES provider_pool(id, owner_id)` 换成
  `REFERENCES provider_pool_person(pool_id, user_id) ON DELETE CASCADE`（`pool_api_key.contributor`、`pool_gateway_token.person`
  同一条围栏）。所以「谁能有一行登录」＝池里的一个人，插一个池外的人（哪怕他是另一个池的池主）仍被外键拒绝；
  人离开池，他签进来的账号随他的那一行一起删。存量行都指向池主、池主必有 person 行（0358），无需回填。
- **`pool_login_token` 的池主围栏不变**：`pool_login_token_pool_id_user_id_fkey` 仍是 0324 的
  `FOREIGN KEY (pool_id, user_id) REFERENCES provider_pool(id, owner_id)`——登录令牌只发给池主的会话，成员的会话始终是
  `pool_gateway_token`（`orbit-gw-`），即使它跑在某个成员签进来的账号上。
  `pool-login-fences.pg.spec.ts`（D10 时从 `pool-login-owner-fence.pg.spec.ts` 改名）在跑完全部迁移的库上用
  `pg_get_constraintdef` 比对这两条定义与 0371 / 0324 原文一致，并验证：登录行对池里的人（池主与成员）都可以插、
  对池外的人被拒；登录令牌对成员仍被拒、只对池主可以插；人离开池，他的登录行随之删除。

### 2.5 权限

下表里「key」就是池里的一把组织/项目 API key（下表沿用旧文里的「账号」，一律读作 key；方案 A 新增的几行写明「ChatGPT 账号」的除外，
指池主本人的 ChatGPT 账号）。本人 Codex 池上的管理员只有池主一个（0358 起，见表下）。

| 动作 | 管理员 | 成员 | 非成员 |
|---|---|---|---|
| 看到池、在选择器里选它、在它上面开会话 | ✓ | ✓ | ✗（按不存在处理） |
| 加自己的 key | ✓ | 规则 `members_can_add` 开着时 ✓ | ✗ |
| 停用 key（`enabled=false`） | 只能停用自己贡献的 | 只能停用自己贡献的 | ✗ |
| 移除 key | 任何人的 | 只能移除自己贡献的 | ✗ |
| 替换失效的 key | 任何人的 | 只能替换自己贡献的 | ✗ |
| 加自己的 ChatGPT 账号（Sign in with ChatGPT，D10） | ✓ | 规则 `members_can_add_accounts` 开着时 ✓ | ✗ |
| 被登出后 Sign in again（D10） | **只有把该账号签进来的那个人**（管理员也没有那个账号的凭据） | 同左（自己的账号） | ✗ |
| 移除池里的一个 ChatGPT 账号（D10） | 任何人的 | 只能移除自己签进来的 | ✗ |
| 改规则、加/移成员、删池 | ✓ | ✗ | ✗ |
| 离开池（自己的 key 与签进来的账号一起离开） | — | ✓ | — |
| **ChatGPT 账号（方案 A 起；D10 起两种池都有，账号可以属于池里任何人）** | **池主 / 管理员** | **成员（被加进来的人）** | **非成员** |
| 看到 ChatGPT 账号的邮箱、套餐、`…AB12`、额度读数、被登出的原因、签名者姓名 | ✓ | ✓（2026-10-03 起，与池主同一份视图；只有 OpenAI 的账号 id 谁也读不到） | ✗ |
| 会话跑在 ChatGPT 账号上 | ✓（先用账号，都用不了才落到 key） | ✓（同一条顺序，2026-10-03 起） | ✗ |

- 所有接受 provider slug 的入口都要改：建会话、建任务或改任务、改 agent、会话中途换 provider。
  它们现在按「池属于 `session.ownerId`」放行，改成「`session.ownerId` 是池成员」。
- runner 仍然只跑自己 owner 的会话，这一点不变。
- P1 按 key 落地时补的几条（`SharedPoolsService`，接口在 `/api/providers/shared-pools`）：
  - 池的创建者始终是管理员，谁都不能把他降成成员或移出；管理员要离开，得先被别的管理员改成成员；
  - key 的 label / share cap / 开关只有贡献者本人能改；key 被上游 401 置为 INVALID 后，贡献者本人或管理员可以替换；
  - 非成员对池页的每个接口都得到 404，和池不存在时一样。
- 方案 A 落地时补的几条（2026-10-02）：
  - 本人 Codex 池只有池主一个管理员：以 ADMIN 身份加人、或把别人改成 ADMIN，回 403 `POOL_OWN_ONE_ADMIN`
    （`A pool of your own has one admin, you — the people you add to it are members`）。所以删池（ChatGPT 账号随池一起删）和改规则只有池主能做。
    被加进来的人都是成员：规则「They can add their own API keys」（即 `members_can_add`）开着时能加自己的 key，离开时 key 和令牌跟着走。
  - 池主在本人池上加人（按 Orbit 账号邮箱）、移人、加删 key、改规则，走的是共享池那一组门 `/api/providers/shared-pools/:id/...`。
    `GET /api/providers/shared-pools` 列出调用者所在的共享池，以及别人把他加进去的本人池；自己的池仍在 `/api/providers/pools`。
  - ChatGPT 账号的登录、重登、登出只在 `/api/providers/pools/:id/codex-login…`，D9 时只认池主（`CodexLoginService.ownPool`）；
    D10 起这些门认**池里的任何人**（`poolOf` 查 `provider_pool_person` 行，两种池都算），加账号按池规则
    `members_can_add_accounts`（管理员总是可以），登出（移除）只允许签名者本人与管理员，Sign in again 只允许签名者本人；
    池外的人一律 404（与池不存在同形）。每个 (池, 人) 一对独立的登录尝试：两个人同时登录同一个池互不顶掉，也从读不到对方尝试的结果。
  - ~~被加进来的人读到的池视图里，关于 ChatGPT 账号只有 `ownerHasChatGPT`（池里有没有）……~~ 2026-10-03 起（D9）成员读到
    **完整账号视图**：`SharedPool.logins` 与池主页面同一份（`codexLoginView`：邮箱、套餐、`…AB12`、state、`usage`、`lastError`、
    `spentUntil`），另加一个 `next` 标记说明他下一次 claim 会落到哪张账号；`ownerHasChatGPT` 字段随锁定行一起删除。
    视图由 `choosePoolCredential` 求 `next`（账号优先），与 claim 同一条规则。OpenAI 的账号 id 谁也读不到（`maskedAccount`）。
  - 选择器和接受 slug 的入口（`listUsable`、`accountPoolRuntime`、`accountPoolRefusal`）对被加进来的人放行别人的本人 Codex 池；
    拒绝只在「池里的账号一个都不能跑、也没有一把能用的 key」时给出（`codexPoolUnavailableReason`；账号被登出时，签名者本人读到
    "sign in again on its page"，别人读到 "only the person who signed it in can sign it in again, on the pool's page"，
    池里没有账号时所有人同一句 "sign one in on its page"），一个账号能跑就不再置灰（web 选择器里该池可点）。
  - 边界由三处守住（D10 起）：库里 **`pool_login_token` 的池主围栏**（登录令牌只发给池主的会话，成员不会、也不能有自己的行）；
    claim 不给成员签发登录令牌（他们的会话可以跑在任何账号上，但令牌是 `orbit-gw-`）；**Sign in again 只有签名者本人**能做
    （`CodexLoginService.signOut`/`store` 的贡献者判定），别人——管理员也一样——没有那个账号的凭据。
    账号本身的围栏是池里的人（0371），池外的人插不进一行登录。
    `pool-security-boundary.pg.spec.ts` 让成员的会话走 claim、reclaim、换 provider 的 reload，断言 `pool_login_token` 里没有他的行、
    `session.pool_codex_account_id` 是池里的账号、拿到的令牌经网关转发到 ChatGPT 后端并带上该账号的 `ChatGPT-Account-ID`；
    再以成员身份调用 providers 四个控制器（含 shared-pools）声明的全部路由，被拒的也算——包括在池里的登录门上起一个自己的登录、
    轮询、放弃，以及越权移除别人的账号得 403——断言他读得到账号的邮箱、套餐、`…AB12`、额度与 `last_error`（和池主一样），
    但任何响应、会话读接口和推送里都没有 OpenAI 的账号 id 或任何凭据。池主身份的同一组请求作为正对照。

## 3. 界面

以效果图为准：[`docs/mocks/codex-shared-pool/`](./mocks/codex-shared-pool/)。

方案 A（2026-10-02）起，Codex 池的池页、加账号与分享的对话框、Providers 页的池卡以
[`docs/mocks/account-pool-access/`](./mocks/account-pool-access/) 为准（每张图都有 PNG 和 HTML；英文文案逐字照抄，
web 与原生之间走 parity 测试）。两套图说法不一样的地方，以 account-pool-access 为准。

| 图（account-pool-access） | 内容 |
|---|---|
| 01-review-and-accounts | 左半：原池页的 review（头部读数只看 5h、登出图标常红、「Just me」只是一句副标题、只能放一个账号）。右半 A–E：一个池放多个 ChatGPT 账号——右上角常驻 Add account；Accounts 卡头部写 `Next:` 下一个会话落在哪个账号、以及它最紧的窗口；登出图标平时灰色、悬停才变红；「Who can use it」成为一张卡；换号句式 |
| 02-who-can-use-it | 池主和被加进来的人看同一个池：分享后 API key 标 `Everyone here`（~~ChatGPT 账号标 `Only you`、成员只剩一行锁住的说明~~——已作废，见下）；Who can use it 卡（Just me / Me and people I add、每人能跑什么和 API key 本月用量份额、They can add their own API keys）；池里没有 key 且没有账号登录时的黄色提示。右下的「方案 B」（两种池不合并）未采用。**2026-10-03（D9）起，这张图里成员视角的锁定行与 `Only you` 标注不再代表产品行为**：账号与 key 一样标 `Everyone here`，成员读到和池主相同的账号卡片（邮箱、套餐、`…AB12`、额度、被登出原因），卡脚注如实写明账号共享与条款风险；**（D10）起卡上再添一条规则开关「They can add their own ChatGPT accounts」，成员可以由头部按钮 `Add account` 把自己的账号签进来，账号行第二行以签名者姓名开头（如 `Zhang Min · ChatGPT Plus · …AB12`），Sign out / Sign in again 按行给：Sign in again 只有签名者本人，Sign out 签名者本人与管理员**；图纸与 PNG 未重画 |
| 03-flows | Add account 先选加什么（Sign in with ChatGPT / Paste an OpenAI API key）；第二个账号的登录说明；完成页与同一账号再登；Share Codex Pool（含池里没有 key 的变体）；Make Codex Pool just yours?；Providers 页的池卡（池主 Just me / 分享后，以及成员看到的同一个池） |

- web 已按这三张图实现：`ProviderPoolPage.tsx` 的 `CodexPoolPage` 按池主 / 被加进来的人两种视角画同一个池，0321 建的 key 池也走这个页面，
  只是没有 ChatGPT 账号；成员的会话选择器里没有能跑的 key 时该池置灰，写 `No key you can run on`。
- 原生：iOS 池页的多账号已实现（macOS 没有池页，共用 OrbitKit 的逻辑和文案）；方案 A 的界面与 parity 截至 2026-10-03 还在做。
- 设备码登录那几步没有重画，仍照下表 03。

方案 A 之前的图（`codex-shared-pool/`）：

| 图 | 内容 |
|---|---|
| 01 | Providers 页共享池卡片与「New pool」 |
| 02 | 池页（管理员 / 成员视角）：Keys、Members、Rules、删除/离开 |
| 03 | 建池（Codex · Just me）→「Sign in with ChatGPT」：说明（只本人可用、登录只在服务器、不得共享）→ 设备码（打开登录页、输入一次性码、等待确认）→ 完成（邮箱与 `…AB12`）→ 码过期 / 同一账号再登 / 被登出后用原账号重登（P3-c，2026-09-28 按本人账号方向改写） |
| 04 | 会话里：选择器、输入框配额条、换 key 提示（新文案） |
| 05 | web 443px 与 iOS 一一对应：本人账号池的池页与登录弹层；iOS 池页可操作，登出用左滑（iOS 效果图源文件是 `ios.html`；P3-c 改写） |
| 06 | 本人账号池的池页：代管账号的邮箱、套餐、状态、各额度窗口与恢复时间；被 OpenAI 登出后「Sign in again」（只给本人）；还没有账号时「Sign in with ChatGPT」（P3-c 新增） |

- 01、02、04 与 `web-mock.patch` 画的是共享 API key 池（另一条凭据形态，仍然有效）；本人账号的登录型池以 03、05、06 为准。
  方案 A 起两种池共用一个池页，池页以 account-pool-access 为准（见上）。

- 每把 key 一行，显示：**贡献者 / 名字 / 打码指纹 / 本窗口用量 / 上限 / 状态**
  （状态词：`Available`、`Running now`、`Out of budget · resets …`、`Invalid · rejected by OpenAI`、`Disabled`）。
- `web-mock.patch` 是只有界面的 mock，数据接口是假的，可以作为 web 实现的起点。
- 文案逐字沿用效果图；web 与原生之间的文案走现有的 parity 测试。

## 4. 风险

- **条款与责任**：key 不得转卖、不得当独立账号转给别人用；用它跑的一切记在它所属组织/项目的账上，
  由贡献者负责。加 key 时明示（D3），不做规避。
- **共享账号（2026-10-03 起，D9）**：池主的 ChatGPT 账号跑池里所有人的会话，这正是 OpenAI 条款里
  「make your account available to anyone else」那条所说的共享；池主已知情并明确要求这么做，风险（账号被限制甚至停用）
  由池主承担。产品不再声称「别人跑不到」，而是在登录弹窗和 Who can use it 卡里如实写明这一点，不做任何规避检测。
  池主随时可以登出账号或把人移出池来收回使用权。
- **成员的个人登录由服务器代持（2026-10-03 起，D10）**：成员用自己的账号入池后，服务器不但转发它，还**代持并刷新该账号的
  access / refresh token**（`PROVIDER_SECRET_KEY` 加密存库），并在上游 401 时把它标为 SIGNED_OUT；换言之 2026-09-27 被
  三个执行会话按条款拒绝的方向（服务器代持他人的个人 ChatGPT 登录）**被池主有意要求并接受**，风险（账号被限制甚至停用）
  由各贡献者本人与池主承担。产品提示如实写明：登录弹窗对成员说「Everyone in this pool runs on it」与条款风险句；
  账号行写明签名者，Sign in again 只给签名者本人；贡献者随时可以把自己的账号登出（离开池时自动一起删），池主随时可以
  把它移出池。不做任何规避检测。
- **兼容性**：OpenAI 是否接受 codex 自定义 provider 形状的请求，要 P0 实测。
  codex 升级后请求可能变化，网关要有录制和回放的契约测试。
- **安全**：
  - apiserver 持有池里所有 key 的明文（可解密）；一把组织/项目 key 的权限可能不止 Codex；
    服务器运维者技术上能解密；贡献者放进池里前应当了解这一点，取走时把 key 从池里移除或在上游轮换；
  - 会话令牌泄露的影响限于网关白名单路径和这个池；
  - 日志里不出现 key 明文与打码指纹以外的任何成分。

## 5. 分期

- **P0 可行性验证（go / no-go）**：
  - 录一次 codex 的真实请求，定网关白名单；
  - 单把 key 经网关跑通一次 codex 回合（SSE）；
  - 读到用量（应答里的 token 计数，以及上游有没有组织级用量头）；
  - 撞限三态实测：`insufficient_quota` / 401 / 429 各一次，定各自的处置；
  - 换 key 后线程能否继续。2026-10-02 实测：ChatGPT 账号之间、ChatGPT 账号与 API key 之间换号都能直接续上，不需要降级
    （见 §2.3「P0 结论」）；key 与 key 之间没有单独测。
- **P1 数据与权限**：表、迁移、成员与角色、各入口按成员放行、会话令牌、claim 注入、加 key 与替换流程。
- **P2 网关**（已实现，迁移 0322）：转发、选 key（含 Own key first 与上限）、撞限换 key、用量回写与账本、换 key 提示的投递。
- **P3 web 界面**：按效果图 01–04，以 `web-mock.patch` 为起点。
- **P4 iOS / macOS 界面**：按效果图 05。
- **P5 文案**：`poolSwitchNotice` 增加 D5 的 key 句式；个人池保持现有句式；parity 测试。
- **方案 A**（2026-10-02 起，D8）：多账号、选号与换号、令牌与账号解绑（迁移 0355）、合并两种池（迁移 0358）、web 界面已实现；
- **D9 / D10**（2026-10-03）：账号对全池可用；成员可以签自己的账号入池（迁移 0371：`pool_codex_login` 的围栏换成
  `provider_pool_person`，`provider_pool.members_can_add_accounts` 默认开）。web 与原生一起改，
  `pool-login-fences.pg.spec.ts`、`codex-login.pg.spec.ts`、`codex-login-scope.pg.spec.ts`、`pool-security-boundary.pg.spec.ts`、
  `shared-pool-doors.pg.spec.ts` 与 web / 原生的页面测试随之更新。
- macOS / iOS 的方案 A 界面与 parity 截至 2026-10-03 还在做。
