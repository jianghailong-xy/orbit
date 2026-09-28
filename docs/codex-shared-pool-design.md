# Codex 共享池（共享组织/项目 API key + 网关）设计

**状态**：方向由账号所有者于 2026-09-27 定为「共享组织/项目 API key + 网关」，取代原「服务器保管成员个人
ChatGPT 登录」；本文档、效果图与 4 项产品决策已按新方向改写（2026-09-28）。P1（数据与权限，迁移 0321）与 P2（网关，迁移 0322）已实现，界面还没开始。
效果图、iOS 复刻和 web 界面 mock 补丁都在 [`docs/mocks/codex-shared-pool/`](./mocks/codex-shared-pool/)。

**改动日期与原因**：2026-09-27，账号所有者把项目方向定为「共享组织/项目 API key + 网关」。
原方向（成员把个人 ChatGPT 订阅登录放进池里、登录由服务器代持与刷新、靠设备码登录加账号）被三个执行会话
按 OpenAI 条款拒绝——条款不允许共享账号凭据，服务器代持他人的个人登录就是在绕开这一条。
新方向只搬 API key：不变更任何账号的登录态，也不碰个人凭据。

## 0. 一页结论

- 多个 Orbit 用户把各自的**组织/项目 OpenAI API key**（`sk-…`）放进同一个**共享池**。
  任一成员的 Codex 会话，按「剩余额度 + 自己的 key 优先」落到池里的某把 key 上。
- **key 只在 Orbit 服务器上**：用 `PROVIDER_SECRET_KEY` 加密存库，只有 apiserver 里的网关解密使用；
  接口只回打码指纹（`sk-…AB12`），明文不写日志、不进任何 claim 载荷或响应体。
- **会话仍跑在成员自己的 runner 上**。runner 上的 codex 走现有的自定义 provider 通路，
  `OPENAI_BASE_URL` 指向 Orbit 网关，`OPENAI_API_KEY` 是会话令牌。
  网关把令牌换成池内某把 key，其余原样转发给 OpenAI。**runner 上没有任何一把池内 key。**
- **硬边界：服务器不代持、不中转任何个人 ChatGPT 凭据，不做设备码登录。** 能放进池里的只有 API key。
- **会话侧几乎没有新界面**：
  - 选择器、输入框配额条、换 key 提示都是现成的；
  - 新界面只有共享池卡片、池页的 Members / Rules、「Add a key」流程、「New pool」。
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
- 429 `rate_limit_exceeded` 不是失效：在同一把 key 上退避，见 §2.3。

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
  - 上游 `rate_limit_exceeded`（429）→ **在同一把 key 上退避**，不跳 key；
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
  - `rate_limit_exceeded`：codex 0.158 自己不重试 429，网关在同一把 key 上按 retry-after / x-ratelimit-reset-* 退避重发
    （最多 4 次，单次 ≤20s、合计 ≤40s），仍是 429 就原样转回；不标记 key，下一次 claim 仍粘在它上面。
- P0 要验证：同一个 codex 线程换 key 后还能否继续（加密 reasoning、prompt cache）。
  不能的话，换 key 时丢弃加密 reasoning，或者新开线程接续。

### 2.4 数据模型（P1 定稿，迁移 0321；池里放组织/项目 API key）

- `provider_pool` 加列：`engine`（`claude` | `codex`）、`shared`、`members_can_add`、`own_key_first`（两条规则默认都开）。
  个人池是 `claude` 且不共享（0265 建的都是），共享池是 `codex` 且共享，`provider_pool_engine_check` 把两者绑死。
  `owner_id` 在共享池上是创建者：永远是 ADMIN，不能被降级或移出，要走只能删池。
- `provider_pool_person(pool_id, user_id, role ADMIN|MEMBER)`：共享池的成员。创建者是 ADMIN。
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

### 2.5 权限

下表里「key」就是池里的一把组织/项目 API key（下表沿用旧文里的「账号」，一律读作 key）。

| 动作 | 管理员 | 成员 | 非成员 |
|---|---|---|---|
| 看到池、在选择器里选它、在它上面开会话 | ✓ | ✓ | ✗（按不存在处理） |
| 加自己的 key | ✓ | 规则开着时 ✓ | ✗ |
| 停用 key（`enabled=false`） | 只能停用自己贡献的 | 只能停用自己贡献的 | ✗ |
| 移除 key | 任何人的 | 只能移除自己贡献的 | ✗ |
| 替换失效的 key | 任何人的 | 只能替换自己贡献的 | ✗ |
| 改规则、加/移成员、删池 | ✓ | ✗ | ✗ |
| 离开池（自己的 key 一起离开） | — | ✓ | — |

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
| 02 | 池页（管理员 / 成员视角）：Keys、Members、Rules、删除/离开 |
| 03 | 建池 → 加 key 说明（带风险提示）→ 填 key（名字、key、上限）→ 完成 → 重复 key 被拒 |
| 04 | 会话里：选择器、输入框配额条、换 key 提示（新文案） |
| 05 | web 443px 与 iOS 一一对应；iOS 池页可操作，删除 key 用左滑 |

- 每把 key 一行，显示：**贡献者 / 名字 / 打码指纹 / 本窗口用量 / 上限 / 状态**
  （状态词：`Available`、`Running now`、`Out of budget · resets …`、`Invalid · rejected by OpenAI`、`Disabled`）。
- `web-mock.patch` 是只有界面的 mock，数据接口是假的，可以作为 web 实现的起点。
- 文案逐字沿用效果图；web 与原生之间的文案走现有的 parity 测试。

## 4. 风险

- **条款与责任**：key 不得转卖、不得当独立账号转给别人用；用它跑的一切记在它所属组织/项目的账上，
  由贡献者负责。加 key 时明示（D3），不做规避。
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
  - 换 key 后线程能否继续。
- **P1 数据与权限**：表、迁移、成员与角色、各入口按成员放行、会话令牌、claim 注入、加 key 与替换流程。
- **P2 网关**（已实现，迁移 0322）：转发、选 key（含 Own key first 与上限）、撞限换 key、用量回写与账本、换 key 提示的投递。
- **P3 web 界面**：按效果图 01–04，以 `web-mock.patch` 为起点。
- **P4 iOS / macOS 界面**：按效果图 05。
- **P5 文案**：`poolSwitchNotice` 增加 D5 的 key 句式；个人池保持现有句式；parity 测试。
