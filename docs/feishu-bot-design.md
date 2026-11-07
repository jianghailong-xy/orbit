# 飞书机器人集成：设计方案

状态：**设计已定**（2026-11-07）。§13 是所有者的五项决定，以及本文对其中两项的解读。按 §12 拆任务落地，全部属于第一期。
实现以本文为准；要偏离，先改本文。

## 0. 一句话

每个 Orbit 账号在设置里接入**自己的飞书企业自建应用**（App ID / App Secret），Orbit 用**长连接**收这个应用的事件。
Orbit 已有的提醒（审批、会话结束、agent 的 `notify`、owner item 等）发到账号主人的飞书私聊，默认只带标题。
主人在飞书里答复审批、回复会话、私聊直接开会话。主人把机器人拉进群并在 Orbit 里确认后，群里 `@机器人` 就能派活：
每单一个话题，结果回到话题里。这取代今天靠一个常驻 LLM 会话轮询的 `tea-cli lark dispatch`。

## 1. 现状

### 1.1 Orbit 今天怎么找到人

`PushService`（`src/apiserver/src/push/push.service.ts`）是唯一的出站提醒，APNs（iOS/macOS）和 FCM（Android）
两个通道，目标是 `device_token` 行。每种提醒都是**沿触发**的，判定写在 push 里：

| kind | 何时 | 去重 |
| --- | --- | --- |
| `approval` | 会话从没有待批审批变成有的那一刻 | `claimApprovalAlert` 在 session 行上认领，跨 apiserver 只响一次 |
| `finished` / `failed` | runner/reaper 标 `final` 的 STATUS 事件；auto-retry 放弃时 | collapse id `settled-<session>` |
| `agent-message` | agent 调 `notify` | 每会话每分钟一次（`claimAgentNotify`，记在行上） |
| owner item 四种 | 合并确认、协调者的提问、转给 owner 的异常、只有 owner 能解除的暂停 | `ownerItemAlert` 决定，collapse `owner-item-<id>` |
| 其余 | confirmation-problems、watch-matched、loop-missed / wakeup-dropped、engine-signed-out、claude-region-blocked、wiki-* | 各自 collapse |

- 偏好：`user.preferences.notifySessionFinished`、`notifyAgentMessage`（Settings → Notifications）。
- iOS/macOS 横幅上已有 **Allow / Deny / Reply** 三个动作（`src/macos/OrbitKit/Sources/OrbitKit/App/Notifications.swift`），
  用 App 的登录凭证调用户 REST。横幅上只有会话标题与工具名，锁屏上就能 Allow。飞书卡片要对齐的就是这三个动作。
- 角标：静默推送带 `badge` 与 `clearSessions`，审批在别处答了，横幅随之清掉。

### 1.2 已经有人用飞书驱动 Orbit

另一套部署上，有团队用自己写的 `tea-cli lark dispatch`（不在本仓库）加一个常驻的「Lark dispatch coordinator」
会话派活：外部 poller 定期给这个会话发 `LARK_DISPATCH_POLL_V1`，会话（一个 LLM）读飞书消息、建群、转发、回执，
再 `orbit session create` 开工作会话。service token 测试里的 `--label "feishu bridge"` 就是这个用法。报回来的问题：

| 现象 | Orbit 侧 |
| --- | --- |
| 协调会话活了 4 天、4858 轮，累计 cache-read 越过 int4，turn-complete 失败，会话卡死 3 小时 | 已修：0473 改 BIGINT，0478 按轮记账 |
| 长驻会话只能按轮数估上下文 | 已做：`contextTokens`（4ccbc411b） |
| runner 的 Claude 登录过期时每个新会话 1–2 秒就 FAILED，六小时建了 50 个，留下 1.5 GB worktree | 已做：创建前预检拒绝（4ccbc411b） |
| 配额恢复时间靠正则抠 error 文案 | 已有 `retryAt` |
| tea-cli 拼 argv 的下标错，带 `--agent-id` 必挂 | tea-cli 自己的 bug |

Orbit 一侧都修了，但根子在结构：**消息路由是确定性的事，却交给了一个每轮都要读全量上下文的 LLM 会话**。
每次轮询都是一轮付费推理，会话越活越大。

### 1.3 必须遵守的既有约束

1. **所有者通道**（`docs/human-only-authority.md`、`docs/personal-access-token-design.md` §5）：审批答复、确认卡、
   证据裁定、项目 start/done 等 49 条路由（`src/apiserver/src/auth/pat-owner-channel-routes.ts`，2026-11-07）只接受 LOGIN，
   PAT 一律 403 `OWNER_INTERACTIVE_CREDENTIAL_REQUIRED`。理由是官方脚本通道不能成为绕开确认卡的捷径。
2. **按账号自成租户**：没有团队或成员概念。每个飞书应用只属于一个账号（§4.1），它收到的每个事件都只在这个账号里生效。
3. **Copy Is English**（CLAUDE.md §5）：机器人发出的每个字（卡片、按钮、回执、错误、命令）都是英文。
   agent 写的正文和会话标题原样转发。
4. **多 apiserver**：已有 advisory-lock 选主（`realtime/control-plane-leader.ts`）和跨进程的行级认领，
   新逻辑不能假设只有一个进程。
5. **第三方凭据加密存库**：与用户自带的模型提供方 key 同一套（`providers/provider-crypto.ts`，密钥由 `PROVIDER_SECRET_KEY` 派生）。
6. **turn 结束时的副作用不能拖住 turn-complete**：int4 事故里，一次附带写入失败让整个 turn-complete 回滚，
   runner 每 2 秒重试一次，重试了三个小时。

## 2. 目标与非目标

目标（全部属于第一期）：

- **G1 自带应用**：每个账号接入自己的飞书企业自建应用。orbitd.io 上任何飞书租户的人都能用，不需要上架应用商店。
- **G2 飞书私聊收提醒**：§1.1 的提醒同时发到主人的飞书私聊，默认只带标题；事情了结后卡片自动变成终态。
- **G3 在飞书里处理**：在卡片上答复工具审批与 agent 的提问；回复会话；私聊直接开新会话，会话的回复回到同一条消息链。
- **G4 群里派活**：绑定的群里 `@机器人` 一句话，就在主人账号下开一个会话，每单一个话题，结果回到该话题。
  路由是确定性的，不用 LLM 轮询。
- **G5 内网可用**：没有公网地址的自建部署也能用。

非目标：

- 部署级的共享应用（一个应用服务多个 Orbit 账号）、飞书应用商店的商店应用。
- 用飞书登录 Orbit。绑定主人身份只表示「这个飞书用户可以代表这个 Orbit 账号收发」，不是一种登录方式。
- 别人私聊机器人派活。多人入口是群（§8）；私聊只受理主人。
- 会话全文镜像、逐字流式输出。
- 让 agent 往任意飞书会话发消息的新工具：那是一条外泄通道。agent 要找人仍用 `notify`。
- 证明「人在场」：`human-only-authority.md` 的结论不变。§7.2 说明飞书点击比 bearer token 强在哪、不强在哪。

## 3. 方案总览

```text
                  飞书 / Lark 开放平台（每个账号一个自建应用）
   私聊消息 · 群里 @机器人 · 卡片按钮点击              发消息 · 回复 · 改卡片
              │ 长连接（WSS，由 Orbit 主动外连）              ▲ REST（tenant_access_token）
┌─────────────▼──────────────────────────────────────────────┴───────────┐
│ apiserver · FeishuModule                                               │
│ 每个副本为每个启用的应用建一条连接，飞书把每个事件只投给其中一条       │
│                                                                        │
│ 入站  FeishuLink ─▶ feishu_inbound_event（应用 + event_id 去重）        │
│                  ─▶ FeishuRouter（事件只在该应用所属的账号里生效）       │
│         ├ 主人私聊：绑定码 / 回复某条消息 / 新消息 / 命令               │
│         │    → 绑定主人 · createTurn · create（默认 workspace）          │
│         ├ 别人私聊          → 一句英文说明，什么都不做                  │
│         ├ 卡片按钮          → 核对点击者是主人 → decideApproval（白名单） │
│         └ 群里 @机器人      → 群路由 → create / createTurn               │
│                                                                        │
│ 出站  PushService ─┬─ APNs                                             │
│                    ├─ FCM                                              │
│                    └─ FeishuTransport ─▶ feishu_message（卡片登记）     │
│       turn 结束 ─▶ feishu_outbox ─▶ FeishuRelay（回复回到消息链 / 话题） │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 为什么做在 apiserver 里，而不是一个外部桥接进程

外部桥接（拿 PAT 订阅 `GET /api/events`，再调用户 REST）不改 apiserver，看起来便宜，但：

| | apiserver 内的模块 | 外部桥接（PAT + SSE） |
| --- | --- | --- |
| 答复审批 | 可以，范围是 §7.2 的白名单 | 不行：审批属于所有者通道，PAT 被拒是有意的设计 |
| 什么时候该提醒 | 复用 push 的沿判定与跨进程认领 | 从事件流重新推一遍，必然与 push 漂移（例：同一轮多个审批只响一次） |
| 多个账号 | 每个账号填自己的应用，Orbit 统一托管连接 | 每个账号自己部署、看护一个桥接，各保管一个 PAT |
| 代价 | apiserver 多一个依赖（`@larksuiteoapi/node-sdk`），每个副本每个应用一条外连 WSS | — |

service token 与 PAT 照旧可以给想自己写桥接的人用，本方案不收回。

### 3.2 为什么用长连接，不用 Webhook

- **不需要公网地址**：长连接是 Orbit 主动连飞书的 WSS，内网、NAT 后面的自建部署都能用；Webhook 要飞书能访问到 Orbit。
- **少一个可伪造的入口**：Webhook 模式下，持有 Encrypt Key / Verification Token 的人能向 Orbit 伪造任意
  「某用户点了按钮」的回调，与拿 `JWT_SECRET` 铸 owner token 是同一类问题。长连接没有入站端点，点击事件只能由飞书产生。
- 长连接的约束方案都接受：只支持企业自建应用（本方案正是）；每条消息要在 3 秒内处理完（§7.1 先落库再处理）；
  集群模式，同一应用的多条连接里随机一条收到、不广播（§4.4 正好借它做多副本）；每个应用最多 50 条连接。
- 集群模式的另一面：**一个应用只能有一个消费者**。同一个应用如果同时被 tea-cli 或另一套 Orbit 用长连接连着，
  事件会被随机分给两边，两边都只收到一部分。设置页写明这一点；同一部署里一个 App ID 只能接到一个账号（§4.1）。

## 4. 应用：每个账号接入自己的飞书应用

### 4.1 设置页与数据

Settings → **Integrations → Feishu**：

- 平台（Feishu `open.feishu.cn` / Lark `open.larksuite.com`）、App ID、App Secret（只写不读）。保存前用这对凭证向飞书换一次
  `tenant_access_token`，换不到就 400，并带回飞书的错误码与说明，不保存。
- 状态：连接中的副本数、机器人名字、最近一次收到事件的时间、最近一次失败的原因。
- 主人身份（§5）、消息详情（§6.4，默认只发标题）、是否在飞书里答复审批（§7.2，默认开）、私聊新会话的默认 workspace（§7.3）。
- **Send me a test message**、**Remove app**。

```prisma
model FeishuApp {                     // feishu_app，每个账号至多一行
  id                 String    @id @default(uuid(7)) @db.Uuid
  ownerId            String    @unique @db.Uuid       // → User，onDelete: Cascade；v1 一个账号一个应用
  platform           String                           // 'FEISHU' | 'LARK'
  appId              String    @unique                // cli_xxx；一个应用只能接到一个账号（§3.2）
  appSecretEnc       String                           // providers/provider-crypto.ts 的 encryptSecret
  enabled            Boolean   @default(true)
  messageDetail      String    @default("TITLES_ONLY") // 'TITLES_ONLY' | 'FULL'（§6.4）
  approvalsInFeishu  Boolean   @default(true)         // 卡片上答复审批（§7.2）
  defaultWorkspaceId String?   @db.Uuid               // 私聊新会话进哪个 workspace（§7.3）
  ownerOpenId        String?                          // 主人在这个应用里的 open_id，绑定后才有（§5）
  ownerName          String?                          // 绑定时读取，只用于展示
  botName            String?                          // 连上后读取
  lastConnectedAt    DateTime?
  lastEventAt        DateTime?
  lastError          String?                          // 飞书的错误码与说明，不含凭证
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
}
```

- 轮换 `PROVIDER_SECRET_KEY` 后已存的 App Secret 解不开，状态报 `secretUnreadable`，用户重填（与提供方 key 同一已知限制）。
- 更换 App ID 就是换了应用：open_id 按应用区分，主人身份、群路由、卡片登记随旧应用一并清掉。
- 同一 App ID 第二个账号再填，409 `This Feishu app is already connected to another Orbit account.`

**管理员**：Admin → Integrations → Feishu 只有一个开关「Allow accounts to connect Feishu bots」（默认开）和已接入应用的数量；
关掉即断开所有连接。Admin → Users 可以移除某个账号的应用。理由：多租户部署上，每个应用都是每个副本的一条外连长连接，
运维要能不发版就把它们停掉。

### 4.2 飞书开放平台侧（用户自己做一次）

设置页给出逐步说明，权限名与事件名都可以一键复制。顺序有讲究：飞书控制台要检测到长连接已经建立，
才允许保存「使用长连接接收」，所以要先在 Orbit 里填好凭证，再回控制台切换订阅方式。

1. 在开发者后台用自己的租户创建**企业自建应用**，添加「机器人」能力。个人版租户里用户自己就是管理员；
   企业租户里发布应用通常要管理员审核。
2. 开通权限（名称以控制台为准，F0 第一步逐条核对）：以应用身份发消息（`im:message:send_as_bot`）；读取用户发给
   机器人的单聊消息（`im:message.p2p_msg:readonly`）；接收群里 @机器人 的消息（`im:message.group_at_msg:readonly`）；
   获取群信息（`im:chat:readonly`）；获取用户基本信息（`contact:user.base:readonly`，显示名字用）。
   **不申请**「读取群内所有消息」：群里只有 @机器人 的消息才会到 Orbit。
3. 把 App ID / App Secret 填进 Orbit，等状态变成已连接。
4. 回控制台，事件与回调的订阅方式都选「使用长连接接收」。事件订阅 `im.message.receive_v1`、`im.chat.member.bot.deleted_v1`；
   回调订阅 `card.action.trigger`。
5. 设置可用范围（谁能看到机器人，至少包含自己和要派活的群成员），发布版本。

### 4.3 网络

apiserver 要能出站访问 `open.feishu.cn`（或 `open.larksuite.com`）的 HTTPS 与 WSS。上线前在生产 apiserver 容器里实测一次，
做法同 Google 登录（`docs/google-sign-in-design.md` §7.3）。

### 4.4 多副本与规模

- **每个副本为每个启用的应用各建一条长连接**。飞书按集群模式把每个事件投给其中一条，副本挂了其余的照收，不需要选主。
  只让主副本连，反而会在接管空窗里（实测约 3.5 秒）一条连接都没有。
- 飞书在 3 秒内没收到确认就会重推同一事件。`feishu_inbound_event` 上 `(appId, eventId)` 的唯一约束兜底，
  重复的直接确认，不再处理。
- 凭证失效、应用被停用或删除：按 1 分钟起、最长 1 小时退避重连，原因写进 `lastError`；飞书明确说应用已停用或删除时停止重连。
- 每个副本把自己每条连接的状态（CONNECTING / CONNECTED / BACKOFF / STOPPED、连续失败次数、下次重试时间、错误）与心跳写进 `feishu_link`（F0-2），设置页数心跳新鲜的 CONNECTED 行。SDK 以 `autoReconnect: false` 运行，重连由 Orbit 掌握；断线后立即重连一次，失败才进入退避。长连接端点失败时再换一次 `tenant_access_token`，取飞书的错误码写 `lastError`；10003（应用不存在）、10013（应用状态异常）视为已删除或停用，停止重连，直到应用被重新保存（这两个码待真租户冒烟核实）。
- 连接数 = 应用数 × 副本数。`tenant_access_token` 由 SDK 按应用、按副本各自缓存续期。应用数到几百时，改成按行租约把每个
  应用分给两个副本连（v1 不做）；管理区显示的应用数就是看这个的。
- 出站任何副本都可以发。限频按 429 给出的建议等待时间退避（§6.3），不做跨进程令牌桶：单个账号的量远低于上限。

## 5. 主人身份：应用里哪个飞书用户是你

应用接上以后，Orbit 还不知道租户里哪个人是账号主人。提醒发给谁、谁的点击算数、谁的私聊受理、谁能把群接进来，都看这一项。

### 5.1 流程：从 Orbit 发起，把码私聊发给机器人

1. Settings → Feishu → **Connect your Feishu account**（只接受 LOGIN，PAT 以 `ACCOUNT` 拒绝）。服务端生成一次性绑定码
   （8 位、10 分钟、只能用一次，库里只存哈希）。页面显示绑定码和 **Open the bot in Feishu**（飞书 applink，直达机器人私聊）。
2. 用户在**私聊**里把码发给机器人；在群里发的码不受理，并且立即作废（群里的人都看到了）。重新生成码会作废本账号之前的码。事件里的发送者 open_id 由飞书认证。码对得上，发送者就成为主人，码作废。
3. 机器人回 `You're connected as the owner of this Orbit bot.`；设置页经控制面流显示主人的飞书名字。

- 码只在本账号自己的应用上有效。剩下的风险是码泄露给同租户的人、被他抢先发出：他会成为主人，能收提醒、能答审批。
  缓解：码 10 分钟一次性、只认私聊；设置页醒目地显示主人是谁；换人只需在 Orbit 里（LOGIN）重新生成一个码，
  飞书那边任何人都无法自己把主人换成自己。
- 不用飞书网页授权（OAuth）。它也能在一个浏览器里证明两边，但要在控制台登记回调地址、换 user_access_token，
  还要求 `PUBLIC_ORIGIN` 是公网 HTTPS（Google 登录 §7.2 的同一限制）；绑定码这三样都不需要。将来做「用飞书登录」时再加。

```prisma
model FeishuConnectCode {             // feishu_connect_code：短命，用掉即删
  // id, ownerId（→ User，Cascade）, codeHash @unique, expiresAt（@@index）, createdAt
}
```

### 5.2 解除与失效

- 本人：设置页 **Disconnect**（LOGIN），或主人私聊机器人发 `disconnect`。两者都只清掉主人身份，应用仍连着，提醒停发。
- 移除应用：断开连接，主人身份、群路由一并清掉。
- 账号停用（`disabledAt`）：连接断开，不再受理任何事件。
- 主人离开租户、被移出可用范围或屏蔽了机器人：发送失败时把原因记进 `lastError`，设置页提示。

## 6. 出站：提醒发到主人的飞书私聊

### 6.1 FeishuTransport 是 PushService 的第三个通道

不另写一套「什么时候提醒」。飞书走同一批调用点、同一套资格判定和跨进程认领（`claimApprovalAlert`、`claimAgentNotify`、
`ownerItemAlert` 等），已绑定主人的应用算一种目标：`enabled` 变成「APNs、FCM、飞书任一可用」，`targets()` 之外加一路飞书。
各 kind 在飞书里的样子：

| kind | 默认（只发标题） | 详情模式多带的内容 | 卡片上的动作 |
| --- | --- | --- | --- |
| `approval`：工具权限 | 会话标题、工具名、`Details hidden by your settings` | 输入预览（与 Web 审批卡同一份脱敏） | Allow once · Deny · Open in Orbit |
| `approval`：agent 的提问（AskUserQuestion） | 会话标题、`The agent asked you a question` | 问题与选项 | 详情模式下可在卡上作答；默认只有 Open in Orbit |
| `approval`：编排确认卡（`orbit_task_create`、`orbit_project_create`、`orbit_agent_create` / `update`、删除 runner、MCP 授权等） | 会话标题、卡的种类 | 摘要 | 只有 Open in Orbit |
| `finished` / `failed` | 会话标题、`Finished` / `Failed` | recap 或失败原因（`settleAlert`） | 回复这条消息即回复会话 · Open in Orbit |
| `agent-message` | 会话标题、`The agent sent you a message` | agent 写的那句话 | 回复即回复会话 · Open in Orbit |
| owner item 四种 | 项目标题、事项种类 | `ownerItemAlert` 的正文 | 只有 Open in Orbit |
| 其余 kind | 事件种类与标题 | 与推送同文 | Open in Orbit |

偏好：飞书沿用已有的按 kind 开关（`notifySessionFinished`、`notifyAgentMessage`），另加应用上的总开关。
不做「飞书送达了就不再推手机」的去重：两边都想收的人不少，不想要的关掉一边即可。

### 6.2 卡片的生命周期

- 每发一张卡记一行 `feishu_message`：飞书 message_id、chat、账号、kind、sessionId / approvalId / openItemId、状态。
- **事情了结就改卡**：审批在 Web 或 iOS 上答了、会话被接着跑了、owner item 解决了，卡片原地改成终态
  （`Allowed in Orbit · 10:32`），去掉按钮。触发点就是今天的角标同步（`RealtimeService.publish` → `scheduleBadgeSync`）：
  同一批「可能让 needs-you 变少」的事件，多做一步「关掉已不成立的卡」。飞书只允许更新 14 天内发出的卡，更早的不动。
- **合并而不叠加**，粒度与 APNs 的 collapse id 相同：一个会话的一段待批（同一轮的多个审批进同一张卡，每条有自己的按钮）、
  一个 owner item、一次 settle 各一张卡。重复通告改原卡，不发第二张。
- 实现（F1-4，迁移 0495）：`feishu_message` 以 `(app_id, collapse_key)` 唯一——审批是 `approval-<开启这一段的审批>`，
  settle 是 `settled-<会话>-<最后一轮的 seq>`，owner item 是 `owner-item-<id>`，其余沿用推送的 collapse id；重复通告把 `revision` 加一。
  谁拿到行上的租约（`lease_token` / `lease_until`）谁按库里此刻的内容画卡、发送或 PATCH，记下 `rendered_revision` 后放手并再看一次，
  所以两个 apiserver 同时通告只发一张卡。没认领到 `claimApprovalAlert` 的审批只给这一段的卡加一（`joinApprovalStretch`），
  卡上列出会话里所有仍待批的审批。
- 实现（F1-5，迁移 0498：feishu_message 的 status 增加 CLOSED）：`PushService.reconcileBadge` 每次对账（不论角标动没动）都调 `FeishuTransport.closeSettled`，
  `scheduleBadgeSync` 在只有飞书可用时也运行。看的是 14 天内发出、状态 `SENT` 的审批卡与 owner item 卡：审批卡在其会话仍在
  needs-you 且所列审批还有待批时成立（少了几条就按此刻待批的重画一遍），否则改成终态；owner item 卡在事项不再 OPEN 时改。
  改卡在行的租约下、且要求每次通告都已画过（`rendered_revision = revision`），用卡上次画的 alert 加终态一行重画、去掉按钮，
  行记 `CLOSED`（pump 不再碰它）；飞书没接通或 5xx 时留在 `SENT`，下次对账再试，飞书明确拒绝也记 `CLOSED`。
  终态文案：`Allowed in Orbit · 10:32 UTC`、`Denied in Orbit · …`、`Answered in Orbit · …`（有提问、或允许与拒绝都有）、
  `Resolved in Orbit · …` / `Answered in Orbit · …`（owner item）、`No longer waiting in Orbit · …`（会话离开 needs-you 或审批作废）；
  Orbit 不知道主人的时区，所以写明 UTC。`finished` / `failed` / `agent-message` 卡没有动作按钮，回复它们仍然进会话，不改。

### 6.3 限频、失败与文案

- 飞书的限频：对同一用户 5 QPS；对同一群 5 QPS，由群内所有机器人共享；超限返回 429 并给出建议等待时间。
  `agent-message` 本来就是每会话每分钟一次。
- 失败按「推送只是提示」处理：有限次重试后放弃，权威状态永远在 Orbit 里。
  实现：飞书没接通或 5xx 时最多试 3 次（2 秒起翻倍），飞书明确拒绝（4xx、错误码）不重试；放弃时原因写进该行与应用的 `last_error`。
- 首次发卡带飞书的去重键 `uuid`（`feishuDedupeUuid('alert-card', app_id, collapse_key)`，项目说明第 15 条）：应答丢失后重发、
  租约过期被别的副本接手重发，飞书都只投递一条。PATCH 不需要。
- 文案全英文；会话标题、agent 原文原样转发。

### 6.4 详情的边界（决定 5）

发到飞书的内容存在飞书的服务器上（飞书在国内，Lark 在海外），所以详情可配置，**默认不带**（`TITLES_ONLY`）：

- **默认**：提醒卡只带会话或项目的标题、事件种类、工具名。不带工具输入、recap、失败原因、agent `notify` 的原文、
  owner item 的正文、agent 提问的内容。
- **详情模式**（`FULL`）：加上 §6.1 表里第三列的内容。
- **在飞书里进行的对话不算详情**：从飞书开的会话（私聊或群），以及主人在飞书里回复过的会话，每轮的回复照常回到那条消息链
  或话题（§7.5），两种模式都一样。请求本来就是在飞书里提的；不回传，群派活就没有结果。
- 默认模式下，审批卡只有会话标题和工具名就能 Allow，与 iOS 锁屏横幅今天的做法相同。卡上写明细节被隐藏，要看细节就点 Open in Orbit。

## 7. 入站：在飞书里操作 Orbit

### 7.1 先落库，再处理

长连接收到事件后，插入 `feishu_inbound_event`（`(appId, eventId)` 唯一，存原文 JSON），立即确认（3 秒内），再由 worker
以 `FOR UPDATE SKIP LOCKED` 认领处理；失败有限次重试，处理完 7 天后清理。

卡片按钮是例外：飞书要求 3 秒内同步回一个 toast 或新卡片，所以同步处理（答复审批是一次库写，来得及）。
来不及时先回 `Working…`，再用延时更新 token（30 分钟内有效、至多用 2 次）补上结果。

### 7.2 新的凭证种类 FEISHU 与动作白名单（决定 1）

飞书来的动作不经过 `JwtAuthGuard`：`FeishuRouter` 直接调 service，身份是

```ts
{ userId, credential: { kind: 'FEISHU', appId, openId, messageId } }
```

`userId` 永远是这个应用所属的账号。`AuthCredential` 加这个成员。能调的 service 方法是一份**穷举白名单**，
普查 spec 双向钉住（做法同 `pat-route-coverage.spec.ts`）：

| 动作 | service | 条件 |
| --- | --- | --- |
| 回复会话 | `SessionsService.createTurn` | 主人私聊里的回复；或已绑定群路由的话题里、允许的发送者（§8.2） |
| 开新会话 | `SessionsService.create` | 主人私聊：不带 `permissionMode`，用账号默认值（与 PAT §5.1 同一规则）；群路由：用主人为该路由确认的 mode（§8.1） |
| 答复工具审批 | `SessionsService.decideApproval` | `approvalsInFeishu` 开着；只收 `allow` / `deny`，不收 `rememberRules`（「总是允许」会放宽常设权限，留在 App 里） |
| 答复 agent 的提问 | `SessionsService.decideApproval` 的 `answers` | 同上，且详情模式（默认模式下卡上看不到问题） |
| 查「等我处理的」 | `PushService.needsYouSessions` 等只读方法 | — |

白名单之外一律回 **Open in Orbit** 链接，与 PAT 的 `requiredAction: OPEN_ORBIT` 同义。每个动作都在 turn、审批决定和 Activity 上
记 `credentialKind=FEISHU` 以及 open_id、message_id，可以追溯到「哪个飞书用户在哪张卡上点的」。

`human-only-authority.md` 的矩阵加一行「Feishu bot」：HUMAN_ONLY 的两列一律拒绝；所有者通道除白名单内的审批外一律拒绝。

**飞书点击强在哪、不强在哪。** 卡片点击由飞书生成，带着点击者的 open_id，经 Orbit 主动建立的长连接送达。
拿到 `JWT_SECRET`、PAT，甚至应用的 App Secret，都造不出某个用户的一次点击：持有 App Secret 能以机器人身份发消息，
也能自己建连接截走一部分事件，但伪造不了点击。所以它近似 `human-only-authority.md`「Stronger options」里的带外审批，
强于 bearer token。它仍然不证明人在场：一台没锁屏的电脑、一个被盗的飞书账号都能点。另外，如果 runner 主机上有主人的
飞书 user token（像 tea-cli 那样），agent 能以主人身份**发消息**，从而以主人的名义回复会话。这与 agent 拿到主人的 PAT
是同一级风险，而且它按不了卡片按钮。

### 7.3 私聊消息怎么路由

只受理主人的私聊。别人私聊机器人，只回 `This bot only takes direct messages from its owner.`，什么都不做；
还没绑定主人时，回怎么绑定。

1. **回复某条消息**（事件带 `root_id` / `parent_id`）：根消息在 `feishu_message` 或 `feishu_thread` 里属于会话 S，
   就作为一个 turn 进 S，语义与 iOS 横幅上的 Reply 相同（S 已结束时按 App 里回复的同一规则处理）。
2. **私聊里的新消息**（不是回复）：在默认 workspace 开新会话。机器人回复这条消息，发回执
   `Started · <title> · <workspace>`，此后这条消息链就对应 S。没设默认 workspace 时回一张卡让主人选，选完记住。
3. **命令**（英文、整句匹配）：`help`、`status`（等我处理的会话与 owner item，每条带 Open）、`disconnect`；
   绑定码本身也算一条命令。
4. 非文本消息（图片、文件）回 `Only text messages are supported for now.`

一个会话可能有几条消息链（从私聊开的那条，加上主人回复过的提醒卡）。回传（§7.5）发到最近一次有人发言的那条。

### 7.4 卡片按钮

- **核对点击者**：卡片可以被转发。回调里的 open_id 必须等于应用的 `ownerOpenId`，否则回
  `Only the owner of this bot can answer this card.`，什么都不写。
- 过期的卡（审批已在别处答了、会话已结束）：回 `Already answered in Orbit.`，并把卡改成终态。
- 成功：toast，卡片原地变成终态（§6.2）。

### 7.5 会话的回复回到飞书

- 与飞书消息链或话题挂钩的会话（从飞书开的，或主人在飞书里回复过的），每个 turn 结束时把这一轮最后的 assistant 文本
  发回去：卡片 markdown（上限 30 KB），超出改发纯文本（上限 150 KB），再超就截断并注明；私聊里附 Open in Orbit。
- **turn-complete 只多写一行 `feishu_outbox`**，在提交之后、用它自己的语句写，失败只记日志；发送由 worker 做。
  turn 的确认永远不等飞书，也不会因为飞书失败（§1.3 第 6 条）。
- 只回传正文，不回传工具输出与文件。不做逐字流式。

## 8. 群聊派活

### 8.1 接入一个群

1. 主人把自己的机器人拉进群（只能是应用所在租户的内部群），在群里发 `@<bot> connect`。只有主人发的 connect 受理。
2. 机器人回一张 `Connect this group to Orbit` 卡片，按钮打开 Orbit 的确认页（LOGIN）。确认页凭一次性 ticket 进入。
3. 主人在确认页上选：
   - workspace；
   - permission mode，并写明后果：「群里的人能让 agent 在 <runner> 上以 <mode> 做事」；
   - 谁能派活：群里所有人，或指定的人（主人总是可以）；
   - 上限：同时进行的会话数、每天新开的会话数（同项目的 `sessionBudgetPerDay`）。
4. 确认是**所有者通道**动作（加进 `pat-owner-channel-routes.ts`，PAT 403），因为它让别人能在你的机器上启动 agent。
5. 机器人被移出群（`im.chat.member.bot.deleted_v1`）时路由停用。
6. 实现细节（F3-1）：`feishu_chat_route` 以 `(app_id, chat_id)` 唯一（同一个群可以分别接入不同账号的应用）。主人发 connect 时就建好这一行，
   只存 ticket 的 SHA-256、发 connect 的 open_id 与过期时间（30 分钟），`confirmed_at` 为空；确认用一条带条件的 UPDATE 写入选择并清掉
   ticket，所以 ticket 只能用一次，且发 connect 的人必须仍是主人。ticket 由 appId 与 event_id 派生，同一事件处理两次得到同一 ticket、
   同一张卡（飞书 uuid 去重），已用过的 ticket 不会被重放的事件重新打开。未确认或已停用的群里 @机器人 只回一句英文说明，不开会话。
   connect 只受理主人，且群不能是外部群（`GET /open-apis/im/v1/chats/:chat_id` 的 `external`）。
   确认页的「指定的人」按名字勾选：服务端用 ticket 对应的群读 `GET /open-apis/im/v1/chats/:chat_id/members`（open_id，逐页），
   列出主人以外的成员；读不到时只能选「群里所有人」。存的仍是 open_id。

### 8.2 一条群消息的路径（决定 4：每单一个话题）

- 顶层的 `@<bot> <text>`：发送者在允许名单内且未超上限，就在路由的 workspace、以路由的 mode 开会话。
  机器人以**话题**回复（`reply_in_thread`）发回执 `Started · <title>`，此后每个 turn 结束把正文回到这个话题。
- 话题里再 `@<bot> <text>`：作为一个 turn 进同一会话，按常规的 steer / 排队规则。
- 开不了会话（没有能跑的 runner、引擎没登录、配额用完）：创建前的预检已经会拒绝，把原因回到话题里，
  不建出一个秒死的会话（§1.2 的第三条教训）。
- **发送者署名**：turn 记一个外部发送者（`FEISHU`、open_id、名字），扩展 0349 的 `sender_session_id` 与在途 0485 的
  `last_user_from_*`（会话列表的「From <title>」）。客户端画成 `From Feishu · <name>`；runner 投递时加一句前言，
  告诉 agent 这句话来自飞书群里的某人、**不是账号主人**。前言计入 agent 指令的 token 预算，加之前先量。

### 8.3 安全边界

群成员不是账号主人，他们的话会成为跑在主人机器上、带着主人仓库与凭据的 agent 的输入。提示注入与外泄是群派活的主风险。规则：

1. 接入群是所有者通道动作，确认页写明后果（§8.1）。
2. 群会话的 permission mode 只能是主人为该路由选的那个，飞书里改不了。
3. 群会话的一切审批（包括 agent 的提问）只发到主人的私聊，**不进群**：群成员按不到 Allow。
4. 回到群里的只有每轮的最终正文：不发工具输出、文件、Orbit 链接。
5. 每条路由有并发与每日上限。
6. 主人在 Orbit 里能看到每个群会话及其发送者，随时可以停止或解除。
7. 建议给群路由单独一个只含非敏感目录的 workspace，必要时用单独的 runner 用户（`architecture.md` 的信任边界）。

### 8.4 与 tea-cli 派发器的关系

转发、回执、开会话、回传都由平台确定性地完成，不再需要常驻协调会话与 poller。tea-cli 的「每单建一个群」在本方案里换成
「每单一个话题」。迁移就是那个团队改用本集成：如果沿用同一个飞书应用，要先停掉 tea-cli 的长连接（§3.2，一个应用一个消费者）。
service token 照旧可用，要保留自定义逻辑的可以继续写桥接。

## 9. 数据模型一览

| 表 | 任务 | 作用 |
| --- | --- | --- |
| `feishu_app` | F0 | 账号的应用配置与主人身份（§4.1、§5） |
| `feishu_inbound_event` | F0 | 入站收件箱与去重（§7.1） |
| `feishu_link` | F0 | 每个副本每个应用一条连接的状态与心跳，设置页「连接中的副本数」由它计数（§4.4） |
| `feishu_connect_code` | F1 | 主人身份的绑定码（§5.1） |
| `feishu_message` | F1 | 发出的卡片登记，用于改卡与回复路由（§6.2、§7.3） |
| `feishu_thread` | F2 | 消息链 / 话题 ↔ 会话，`(appId, chatId, rootMessageId)` 唯一 |
| `feishu_outbox` | F2 | 回传发件箱（§7.5） |
| `feishu_chat_route` | F3 | 群路由（§8.1） |
| `conversation_turn` 的外部发送者列 | F3 | 署名（§8.2） |

每张新表都会碰到 apiserver 的普查：迁移台账、db-write inventory、trigger 清单、`@db.Uuid` 字段分类、NOT NULL 清单。
新路由还有 tenant isolation 普查和 PAT 路由普查，所有者通道的路由另加 `pat-owner-channel.pg.spec.ts` 的门例。
迁移号在落地时取 main 上的下一个空号，并查在途的 worktree。

## 10. 接口清单

用户路由（`JwtAuthGuard`）：

| 路由 | 作用 | 对 PAT |
| --- | --- | --- |
| `GET /api/integrations/feishu` | 我的应用配置（不含密钥）、连接状态、主人身份、群路由摘要 | `ACCOUNT` 拒绝 |
| `PUT /api/integrations/feishu` | 填写或更换应用（平台、App ID、App Secret），保存前校验凭证 | `ACCOUNT` 拒绝 |
| `PATCH /api/integrations/feishu` | 总开关、消息详情、是否在飞书里答审批、默认 workspace | `ACCOUNT` 拒绝 |
| `DELETE /api/integrations/feishu` | 移除应用 | `ACCOUNT` 拒绝 |
| `POST /api/integrations/feishu/test` | 给主人发一条测试消息 | `ACCOUNT` 拒绝 |
| `POST /api/integrations/feishu/connect-codes` | 生成主人身份的绑定码 | `ACCOUNT` 拒绝 |
| `DELETE /api/integrations/feishu/owner` | 解除主人身份 | `ACCOUNT` 拒绝 |
| `GET /api/integrations/feishu/chats` | 群路由列表 | `ACCOUNT` 拒绝 |
| `POST /api/integrations/feishu/chats/confirm` | 确认接入群 | `OWNER_INTERACTIVE` |
| `PATCH`、`DELETE /api/integrations/feishu/chats/:id` | 修改、停用群路由 | `OWNER_INTERACTIVE` |

管理员路由：`GET` / `PUT /api/admin/integrations/feishu`（开关与应用数）、`DELETE /api/admin/users/:id/feishu`（移除某账号的应用）。

没有公开路由：长连接模式下，飞书不向 Orbit 发请求。

## 11. 测试与验收

- 单元：每个 kind 在两种详情模式下的卡片渲染（英文文案，`copyLanguage.test.ts` 覆盖新文件）；默认模式的卡片逐字段断言
  不含 §6.4 列出的任何内容；私聊路由规则；白名单普查双向。
- pg spec：
  - 同一 `(appId, eventId)` 重推两次只产生一个 turn；
  - 两个账号各接各的应用，A 的应用收到的事件碰不到 B 的任何对象；同一 App ID 第二个账号保存得 409；凭证无效保存得 400；
  - 转发出去的卡被主人以外的人点击，什么都不写；别人私聊机器人，什么都不写；
  - Web 上答复的审批，对应卡片改成终态；
  - 新路由进 tenant isolation 普查；
  - 飞书出站全部失败时，turn-complete 照常确认。
- 假飞书：SDK 的 domain 可配，指向测试里起的假开放平台（长连接帧加 REST）。e2e 跑「私聊 → 会话 → 回复回到消息链」、
  「卡片 Allow → runner 收到决定」和「群里 @机器人 → 话题里收到结果」。
- 真租户冒烟：测试租户里建一个测试应用，私聊提醒、卡片答复、回复会话、群派活各留截图证据。

## 12. 落地顺序（任务拆分，全部属于第一期）

| 任务 | 内容 | 验收要点 |
| --- | --- | --- |
| F0 应用接入 | 新依赖过 `npm audit`；核对 Node SDK 在长连接下收 `card.action.trigger` 的写法与版本；`feishu_app`、设置页的应用配置与逐步说明、管理区开关、每副本每应用一条长连接、入站收件箱、出站 client、测试消息 | 填好凭证后状态变成已连接、测试消息能到达；两个副本时每个事件只处理一次；两个账号的应用互不串 |
| F1 主人身份与提醒 | 绑定码流程、`FeishuTransport`、两种详情模式的卡片、卡片登记与改卡 | §6.1 每种 kind 都能到达；默认模式不带 §6.4 的内容；Web 上答复后卡片变成终态 |
| F2 私聊交互 | 回复进会话、私聊开会话、回传、审批按钮与提问作答、点击者核对、`status` / `help` / `disconnect` | §7 的路由规则与点击者核对都有 pg 用例；飞书失败不影响 turn-complete |
| F3 群派活 | 群接入（所有者通道）、群路由、话题回传、外部发送者署名（服务端与 Web）、上限 | §8.3 每条规则一个用例；在真租户里演示 tea-cli 的场景 |
| F3n 署名的原生客户端 | iOS/macOS、Android 各一个任务，画 `From Feishu · <name>`，与 0485 的「From <title>」同一处 | 各端的单元测试与截图 |

F0 → F1 → F2 → F3 串行，F3n 在 F3 之后两端并行。以后再做：流式卡片、附件、项目进度播报到群、外部群、
部署级共享应用或商店应用、Webhook 模式。

## 13. 所有者决定（2026-11-07）

1. **飞书卡片上可以直接答复审批。** 按提问时的范围：只在主人私聊、只认主人本人的点击，只做工具审批的 Allow once / Deny
   和 agent 提问的作答；编排确认卡、owner item、「总是允许」留在 App（§7.2）。
2. **第一期就支持群聊派活。** §12 的任务全部属于第一期。
3. **每个账号自己配置机器人的 key。** 每个账号填自己的飞书企业自建应用（§4、§5）。
4. **群派活每单开一个话题**（§8.2）。
5. **消息详情可配置，默认不带**（§6.4）。

本文对其中两项的解读，所有者有异议就改：

- **决定 3 读作「只有每账号应用」**，不另做部署级的共享应用。要两种都支持，在 §4 加一种「部署应用 + 每人绑定」的接法。
- **决定 5 的「详情」指提醒卡上的内容。** 在飞书里进行的对话（从飞书开的会话、在飞书里回复过的会话）每轮的回复照常回传，
  否则群派活没有结果。默认模式下审批卡只有工具名，与 iOS 锁屏横幅一致；要求看清细节才能批的，把详情切成 `FULL`。
