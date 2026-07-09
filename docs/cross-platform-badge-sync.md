# 设计文档:跨平台角标同步(Cross-Platform Badge Sync)

状态:**提案 v1 · 待评审**(先讨论方案,暂不改代码) · 2026-07-08
作者:Claude(应 jianghailong 评估请求)
影响面:`src/apiserver`(`PushService` + `RealtimeService` 各扩展一处;无 DB 迁移)、`src/ios`(后台静默推送处理器 + 清横幅);`src/macos` 仅共享 `needsYou` 口径,零改动
关联:[realtime-control-plane-stream.md](./realtime-control-plane-stream.md)(本文档是其 §9「退出态通知 → APNs」的续集)、[macos-client-design.md](./macos-client-design.md)

---

## 1. 背景与问题

### 1.1 现状:推送与角标怎么来的

- **服务端唯一的推送触发点**是「新建审批」:runner 命中 permission-prompt → `POST /runner/sessions/:id/approvals` 建 `Approval` 行 → `runner-api.controller.ts:624` fire-and-forget 调 `PushService.notifyApprovalRequest`(`push.service.ts:48`)。
- 这条推送是 **alert 类型**(`apns-push-type: alert`,`push.service.ts:132`),带 `aps.badge`,发给该 owner 的所有 `DeviceToken`。
- **角标数字**当前 = 该 owner 名下**所有 `PENDING` 审批的行数**(`push.service.ts:61-63`):
  ```ts
  const badge = await this.prisma.approval.count({
    where: { status: 'PENDING', session: { ownerId: session.ownerId } },
  });
  ```
- **客户端**(iOS/macOS 共享 OrbitKit)自己也会在前台把角标对账一遍:`AppModel.updateDockBadge → setBadgeCount(needsYou.count)`,数字来自 `SessionGrouping.needsYou`(`SessionGrouping.swift:24-38`)= **非 system、且 `pendingApprovals > 0` 的会话数**;而 `pendingApprovals` 服务端只对 **RUNNING** 会话计算(`sessions.service.ts:359-367`),其余强制为 0。

### 1.2 两个缺陷

**缺陷 A — 角标语义不一致(推送 badge ≠ App 内 badge)。**
服务端数的是**审批行数**,客户端数的是**会话数**,且过滤范围不同。具体分歧:

| 维度 | 客户端 `needsYou`(权威 UI) | 旧服务端 push badge |
|---|---|---|
| 计数单位 | **会话**(一个会话记 1) | **审批行**(一个会话 2 个待批记 2) |
| 会话状态 | 只 RUNNING(`pendingApprovals` 只在 RUNNING 算) | 不限状态 |
| system 会话 | 排除(`source != "system"`) | 计入 |
| 死会话上的孤儿审批 | 不计(非 RUNNING) | **计入** |

后果:一个会话挂 2 个待批 → 推送角标 `2`、前台对账后 `1`;更糟的是**孤儿审批**(见 §1.3)会让推送角标**只增不减、越攒越多**。

**缺陷 B — 别处已处理后,后台/退出态的 iOS 角标不会同步消失。**(本分支的核心诉求)
在 web/macOS 上答复审批走 `decideApproval`(`sessions.service.ts:1165`),它只把审批行翻成 `ALLOWED/DENIED` 并往**该会话的实时流**发一个 `APPROVAL_RESOLVED`(`sessions.service.ts:1198`)——**不发任何 APNs 推送、不下发新角标、也不清除已送达的横幅**(没有静默推送)。于是:

- **iOS 在前台**:`APPROVAL_RESOLVED` 经用户级控制面 SSE 到达 → `loadSessions` 重算 → `setBadgeCount` 降下来。✅ 已一致。
- **iOS 在后台 / 被系统回收 / 被用户划掉**:没有任何东西更新角标,它**停在上一次推送的数字**,直到 App 被切回前台、或又来一个**全新**审批触发下一次 alert 推送才顺带纠正。❌ 这正是「别处处理了、iOS 角标不消失」。

### 1.3 决定触发面的三个关键事实(已核对代码)

1. **「需要你回复」的数量会下降的场景有两类**,不止一类:
   - ① 审批被**决定**(allow/deny)——`decideApproval`;
   - ② 会话**带着 PENDING 审批离开 RUNNING**(被取消 / 失败 / 休眠 PARKED / 自然结束)——此时客户端 `needsYou` 立刻不再计它,但**审批行仍是 PENDING**。
2. **`decideApproval` 是全仓唯一会改审批状态的地方**(`grep` 确认:除它之外没有任何 `approval.update/deleteMany`)。**没有任何代码在会话进终态时清理它的 PENDING 审批** → 场景 ② 会留下**孤儿审批**。这既解释了缺陷 A 里「push badge 只增不减」,也说明场景 ② 的角标下降**当前完全没有推送**。
3. **所有相关事件都已流经同一个 choke point** `RealtimeService.publish()`(`realtime.service.ts:195`):新建审批发 `APPROVAL_REQUEST`、`decideApproval` 发 `APPROVAL_RESOLVED`、runner 状态摄取发 `STATUS`、会话结束发合成 `session_ended`。**这意味着我们不需要去每个 mutation site 埋钩子** —— 挂在 `publish()` 上即可一网打尽 ①②。

### 1.4 本文档要解决什么

给出一个**同时**解决 A、B 的最小方案:(1) 把角标数字统一到**唯一权威口径**,消灭双算与孤儿;(2) 让这个数字**每次变化都主动同步到该用户的所有设备**(含后台/退出态的 iOS),而不打扰用户。

---

## 2. 目标与非目标

### 目标
- **G1** 角标只有**一个权威口径**:推送 badge、iOS 前台对账、macOS Dock 三者永远相等。
- **G2** 在**任一平台**处理掉「需要你回复」后,其它设备的角标**主动下降/清零**,包括 iOS 在后台或已退出时(尽力而为)。
- **G3** 同步是**静默**的:降角标不弹横幅、不响铃。
- **G4** **复用现有基建**:APNs 通道(`PushService`)、控制面 hub 与 `ownerCache`(`RealtimeService`);无新中间件、无 DB 迁移。
- **G5** 孤儿审批不再污染角标。
- **G6** 别处处理后,**已送达的横幅一并消失**(不只数字角标)。

### 非目标(本期不做)
- **N1** 保证后台静默推送 100% 送达。iOS 对 background push 节流、且**用户划掉 App 后不投递**——本方案明确接受尽力而为 + 兜底(§6)。
- **N2** 触碰 per-session 数据面流、或改审批的业务语义。

---

## 3. 权威口径:唯一的 `needsYouBadge(ownerId)`

把角标定义**收敛到服务端一个函数**,数值严格等于客户端 `needsYou`:

> **角标 = 该 owner 名下「需要你回复」的会话数** = `source != 'system'` 且 `status == RUNNING` 且**至少有一个** `PENDING` 审批的会话数(按会话去重)。

```ts
// PushService 内,唯一的 badge 计算;alert 推送与静默同步都用它
private async needsYouBadge(ownerId: string): Promise<number> {
  return this.prisma.session.count({
    where: {
      ownerId,
      status: RunStatus.RUNNING,          // 对齐 pendingApprovals 只在 RUNNING 计
      source: { not: 'system' },          // 对齐 SessionGrouping 排除 system
      approvals: { some: { status: 'PENDING' } },  // 会话级去重(count sessions, not rows)
    },
  });
}
```

**为什么是这个口径**:
- **按会话数**而非审批行数 → 和用户在列表里看到的「N 个会话等你」一致,点开 App 数字不跳。
- **`status == RUNNING`** → 自动排除 §1.3 的**孤儿审批**(死会话上的 PENDING 不再计),彻底修掉「只增不减」。
- **排除 `system`** → 和三端 UI 的 Active 分组口径一致。

逐条对齐见 §1.2 表格右移一列即「新权威」,与客户端**完全重合**。这一步单独就修掉了**缺陷 A**,且是 §4 的基础(两种推送共用它)。

---

## 4. 机制:何时推、推给谁、推什么

### 4.1 触发:挂在 `publish()` 的 badge 相关子集上

在 `RealtimeService` 增加一个**服务端常驻的对账器**(不是 per-connection 的 `streamForUser`——那个只在有设备连着 SSE 时才跑,退出态就没人跑了)。做法:在**本地** `publish()` 的路径上,对 badge 相关事件子集触发一次 owner 级对账。

```ts
// realtime.service.ts —— 在 publish() 里,事件属于 badge 子集时排一次去抖对账
private static readonly BADGE_EVENTS = new Set([
  RunEventType.APPROVAL_REQUEST,     // 可能 +1
  RunEventType.APPROVAL_RESOLVED,    // 可能 -1(decideApproval,任何平台)
  RunEventType.STATUS,               // 会话离开 RUNNING → 可能 -1(场景②)
  RunEventType.SESSION_ENDED,        // 合成结束 → 可能 -1
]);

publish(runId, event) {
  this.hub.next({ runId, event });                 // 现状不变
  if (RealtimeService.BADGE_EVENTS.has(event.type)) // 新增一行:排队对账
    this.badgeSync.schedule(runId);
}
```

**为什么挂 `publish()` 而不是订阅 hub**:`publish()` 只在**事件的源副本**上执行一次;hub 还会收到经 Postgres NOTIFY 桥来的**其它副本**的事件(`onNotify → hub.next`),若订阅 hub,N 个副本会各推一次。挂本地 `publish()` 天然「源副本推一次」,零跨副本重复。owner 解析复用现成的 `resolveOwner`/`ownerCache`(`realtime.service.ts:56, 271`)。

### 4.2 两种推送,各司其职

| | **① 新审批 alert(保留,微调)** | **② 变化静默同步(新增)** |
|---|---|---|
| 触发 | 新建审批(`notifyApprovalRequest`) | §4.1 对账器发现 badge 变了 |
| 类型 | `apns-push-type: alert`,priority 10 | `apns-push-type: background`,priority 5 |
| 载荷 | `alert{标题/正文}` + `sound` + **`badge`** + category | **仅 `content-available:1` + `badge`**,无 alert/sound |
| 用户感知 | 弹横幅「Needs your reply · 工具名」 | **无感**,只改数字角标 |
| 作用 | 通知「有新的要你批」并**升**角标 | 别处处理后**降/清**角标 |

两者的 `badge` 都来自 §3 的 `needsYouBadge()`。① 只需把 `push.service.ts:61-63` 换成调 `needsYouBadge()`;② 是新方法 `syncBadge(ownerId)`:算 `needsYouBadge` → 给 owner 每个 token 发上面的静默 background 推送。

### 4.3 静默 background 推送的 APNs 细节

- Header:`apns-push-type: background`、`apns-priority: 5`、`apns-topic: <bundleId>`(现有 `send()` 只需参数化这两个 header)。
- Body:`{ "aps": { "content-available": 1, "badge": <n> } }`,`badge: 0` 即清零。**不带** `alert`/`sound` → 系统静默处理。
- **iOS 侧零门槛**:`Support/Info.plist:40-42` 已声明 `UIBackgroundModes = [remote-notification]`,且 `aps-environment` 已配 → 后台静默推送可被投递;系统会**直接按 `aps.badge` 设角标,无需唤醒 App、无需额外客户端代码**。(可选:实现 `didReceiveRemoteNotification` 以便将来顺手清横幅/预取,见 §7 phase 4。)

### 4.4 去重与合并(避免噪声与超预算)

- **去抖合并(采纳 Q1)**:`badgeSync.schedule(ownerId)` 按 owner 去抖 **300ms** 合并窗。在 web 上连答 5 个审批 → 合并成**一次**静默推送(最终值),省 APNs 后台预算,并顺带把「本窗口内离开 `needsYou` 的会话集」攒起来供清横幅用(§4.5)。
- **「变了才推」**:对账器维护 per-owner「上次已推的 badge 值」,`needsYouBadge` 与之相等则**不推**。这也顺带解决①②的**重叠**:新建审批时 alert 已带 badge=N 并写入「上次已推=N」,对账器随后算出 N 相等 → 不重复推。
- **跨副本**:见 §4.1,源副本触发一次;per-owner「上次已推值」是进程内缓存,极端情况下不同副本各推一次同值静默推送——幂等无害,可接受(或后续用 NOTIFY 广播已推值,非必须)。

### 4.5 清横幅(采纳 Q3)

静默 background 推送(`content-available:1`)在 App **后台/挂起**时会唤醒 App 执行 `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`——**无需 Notification Service Extension**(NSE 用于「改」将展示的通知,我们只需「删」已送达的)。流程:

- **推送侧**:去抖窗口内累计「离开 `needsYou` 的 sessionId 集合」,随静默推送带下去:`{ aps:{ "content-available":1, badge:n }, clearSessions:[…] }`。
- **iOS 侧**:后台处理器按 `clearSessions` 调 `getDeliveredNotifications` → 过滤 `content.threadIdentifier ∈ clearSessions`(alert 推送已写 `thread-id: sessionId`)→ `removeDeliveredNotifications(withIdentifiers:)`;角标数字仍由系统按 `aps.badge` 自动设,与清横幅正交。
- **兜底(force-quit)**:静默推送不唤醒被划掉的 App → 那一刻横幅不清;**回前台**时 `loadSessions` 对账里对「已离开 `needsYou` 的会话」做同样的 `removeDeliveredNotifications`,下次打开即清。

---

## 5. 客户端

### 5.1 iOS
- **无需新增能力**:`remote-notification` 后台模式、`aps-environment` 均已就位(§4.3)。数字角标由系统按 payload 直接应用。
- **前台**:维持现状——控制面 SSE 的 `APPROVAL_RESOLVED`/`session.updated` 驱动 `updateDockBadge → setBadgeCount` 已能对账(缺陷 B 的前台部分本就正确)。静默 background 推送是**后台/退出态**的补充通道。
- **清横幅(采纳 Q3)**:在 `PushDelegate` 补 `application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`,按 §4.5 删除对应会话线程的已送达横幅;并在前台 `loadSessions` 对账里做同样清理以兜底 force-quit。**无需 NSE**。

### 5.2 macOS / web
- **macOS**:Dock/菜单栏角标本就来自 `needsYou`;§3 统一后与 iOS 数字天然一致,**零改动**。
- **web**:同一 `needs-you` 计数(`TasksSidePanel`)也来自 `pendingApprovals > 0`,口径一致,无改动。

---

## 6. 能力边界与降级(诚实说明)

| 场景 | 行为 | 兜底 |
|---|---|---|
| App 在前台 | 控制面 SSE 实时对账 | —— (已一致) |
| App 在后台(未划掉) | 收到静默 background 推送,系统改角标 | 若被节流延迟,下次 alert 推送或回前台纠正 |
| **用户划掉 App(force-quit)** | iOS **不投递** background 推送 → 角标暂不变 | **下次 alert 推送**(新审批)带最新值纠正;或回前台 `setBadgeCount` 纠正 |
| 已送达的**横幅** | 静默推送唤醒后按 §4.5 移除 | force-quit 时下次回前台清除 |

**核心判断**:角标数字非安全攸关,「尽力而为的静默推送 + alert 兜底 + 前台对账」三层足以让绝大多数情况下角标及时消失;而 force-quit 这一档,业界(iOS 平台限制)也只能靠下次可见推送或前台纠正,可接受。

---

## 7. 备选方案与取舍

| 方案 | 内容 | 取舍 |
|---|---|---|
| **C1 只做 §3(统一语义),不推 decrement** | 仅修数字口径 | ✗ 不满足核心诉求:后台 iOS 仍不消失 |
| **C2 在每个 mutation site 显式加推送钩子** | decideApproval + 各会话终态路径各调一次 syncBadge | ✗ 场景②的会话终态入口分散(取消/失败/reaper 强杀/park),**极易漏**;§4.1 挂 `publish()` 一处全覆盖,更稳 |
| **C3 用 alert 推送代替静默来降角标** | 决定后也弹一条 | ✗ 打扰:用户刚在 web 处理完,手机又响一下 |
| **C4 纯客户端(靠前台 reconcile)** | 不加服务端推送 | ✗ 退出态/后台无效,等于不解决 B |
| **★ 推荐 = §3 + §4** | 权威口径 + `publish()` 对账器 + 静默 background 推送 | ✓ 一处 choke point 覆盖①②;复用 APNs/ownerCache;无迁移;iOS 能力现成 |
| **C5 清横幅** | 静默推送唤醒后台处理器删 banner(**无需 NSE**) | ✓ 采纳:后台处理器即可 `removeDeliveredNotifications`;NSE 只用于「改」通知、非必需(§4.5) |

---

## 8. 实施阶段拆分

| 阶段 | 内容 | 可验证产物 |
|---|---|---|
| **P1 权威口径** | `PushService.needsYouBadge()`;把现有 alert 推送(`push.service.ts:61-63`)改用它 | 单测:多审批同会话→1、孤儿审批不计、system 排除;与 `SessionGrouping` 用例对齐 |
| **P2 静默同步 + 去抖** | `PushService.syncBadge(ownerId)`(background 推送,带 `clearSessions`)+ `RealtimeService` 对账器挂 `publish()`(badge 子集 + **300ms 去抖** + 变了才推 + 攒离开集)+ `send()` 参数化 push-type/priority | 集成:decideApproval / STATUS 离开 RUNNING →(合并后)一条 background 推送;新建审批不重复推 |
| **P3 清横幅** | iOS `didReceiveRemoteNotification` 按 `clearSessions` + 前台对账兜底,删已送达横幅(无 NSE) | 别处处理后横幅消失;force-quit 回前台清 |
| **P4 联调 + 真机** | 三端角标一致性;iOS 后台/退出态实测静默降角标 + 清横幅;force-quit 兜底 | 真机(静默推送/后台行为 Linux 验不了) |

P1–P2 可在 Linux 闭环(单测/编译);P3 客户端为主;P4 需真机 + 已配置 APNS_KEY 的运行栈。

---

## 9. 决议记录(2026-07-08)

| # | 问题 | 决议 |
|---|---|---|
| Q1 | 是否做去抖 | **做**:owner 级 300ms 合并窗(§4.4),P2 内实现 |
| Q2 | 跨副本同值重复静默推送 | **接受**:幂等无害,不引入 NOTIFY 已推值去重(§4.4) |
| Q3 | 首期是否清横幅 | **做**:静默推送唤醒后台处理器 + 前台兜底,无需 NSE(§4.5、§5.1) |
| Q4 | 孤儿审批终态清理 | **不做,记 TODO**:§3 口径已让孤儿不影响角标;审批表整洁另开小项(见下) |

**TODO(独立小项,不阻塞本方案)**:会话进终态(CANCELED/FAILED/PARKED/结束)时把其残留的 `PENDING` 审批标记为 `CANCELED`,清理 §1.3 的孤儿审批行。仅为数据整洁——角标已由 §3 的 `status==RUNNING` 口径规避,无功能依赖。

---

## 10. 小结

- **一个根因,两种表现**:角标是**派生状态**,却既没有**唯一口径**(缺陷 A),又只在「新建审批」时下发、从不在「别处已处理」时下发(缺陷 B)。
- **一个权威口径**(§3,按会话数、只 RUNNING、排除 system/孤儿)同时修好数字一致性与「只增不减」。
- **一处 choke point**(§4,`publish()` 上的 badge 子集对账器 + 去抖 + 静默 background 推送)让数字每次变化都尽力同步到所有设备(含后台 iOS)、不打扰用户,并**顺带清掉已处理会话的横幅**。
- **成本可控**:复用 APNs 通道与 `ownerCache`,**无 DB 迁移**;iOS 后台推送能力(`remote-notification`)**已就位**,客户端可零改动;macOS/web 因共享 `needsYou` 口径而天然一致。
- **边界清晰**:force-quit 是已知限制(iOS 不投递静默推送),角标与横幅均由下次 alert 推送与前台对账兜底。
</content>
</invoke>
