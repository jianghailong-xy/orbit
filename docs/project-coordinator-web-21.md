# 21 Web Project Coordinator 状态与控制界面

契约条款：AC10（§6.2 · §11.1 · §13.4），消费单元 20 的读面与写控制。
分支基线：`feat/project@0485a2c2`。

## 这个单元解决的问题

单元 20 把控制环的状态收进了一个读面和一条写控制，但那扇门只有 API / CLI / MCP 三种打开
方式。Web 上的 Project 详情页此时仍只有"目标 / 验收标准 / 说明 / 任务树 / 打开协调会话"
——**"这个项目为什么不动了"在浏览器里依然无法回答**，而这正是最常有人盯着屏幕问的地方。

本单元在 Project 详情页现有信息架构里补上 Coordinator 分区：消费 `GET
/projects/:id/coordinator/status` 的十一个小节，并把 owner 已有的两条写路径（手动触发、
协调设置）接上，全部带 compare-and-swap。

## 界面在哪里

`/projects/:id` → **Coordinator** 分区，位于 "Open / Start coordinator" 按钮之下、任务树
之上。两者是同一个问题的两半：那个按钮是**去和协调器说话**，这个分区是**它一直在做什么、
以及它被允许做什么**。分区整体在"项目已加载"分支内——404 的项目不会再发第二个注定失败的
请求。

## 读面（`src/web/src/components/ProjectCoordinatorPanel.tsx`）

全部组件都是**纯展示**：接收服务端答案与控制状态作为 props 后渲染，没有一个自己取数、
自己判断或自己推导。这既是它们可测的原因（静态渲染按不动按钮，只能把每种状态直接递进去），
也是这块屏幕最要紧的性质：**它必须和控制环说同一句话，而唯一可靠的办法就是永远不算第二遍**。
`runState`、blocker、W5 候选、预算算术、验收证据一律直读直显。

| 分区 | 展示 |
|---|---|
| State | 项目 lifecycle 与任务分布、`runState` + 释义、reconcile 租约（到期/心跳/fencing token）、`acceptanceAttempt`、读取时刻 |
| Coordination | 协调 Agent（Base62 链接 + DERIVED/EXPLICIT）、协调 Workspace、generation、协调 Session 及其 runStatus/runState/lifecycleState/endReason |
| Blockers | 每条 open blocker 的 kind / severity / owner / recovery / `requiredAction` / 升级 / next check / 出现次数 / 主体链接，外加历史 episode（谁解决的） |
| Run now | 手动触发按钮、拒绝原因、结果（queued vs already queued） |
| Coordination settings | `coordinatorEnabled` / `automationPolicy` / `maxConcurrentTasks` / `sessionBudgetPerDay` 四项写控制 |
| What it is spending | 在飞任务/剩余并发、24h 协调动作数/剩余预算、窗口起点 |
| Next wake | 下次唤醒时刻与原因、`flooredBy`、**落选候选**（决策记下的那张表） |
| Recent decisions | 最近 5 次判断：前后 `runState`、`decisionInputHash`、fencing token、产出动作与幂等键 |
| In flight | 已 claim 未发布的动作、未消费信号（`attempts` / `nextAttemptAt`） |
| Acceptance evidence | 验收标准、上次 `RUN_PROJECT_ACCEPTANCE`、verdict 计数、逐分支合并证据 |

### 三条硬规则

1. **缺失被画出来，不是被跳过。** 服务端每个可空字段旁边的封闭集合 `…AbsentReason`，都由
   `absentReasonText` 变成一句话渲染在值本该在的位置；**本 build 不认识的理由会被指名道姓
   地说出来**（`No value, and this build does not recognise the reason the server gave (X)`），
   而不是渲染成空。空白单元格和"这里没问题"在读者眼里没有区别——那正是服务端整套封闭集合
   设计要防的事。缺失的数字绝不画成 `0`，缺失的 blocker 绝不画成健康，没跑过的验收绝不画成
   通过。
2. **不暗示任何 fallback。** blocker 文案说的是**在等什么**：provider 不可用 = "工作在等它，
   不会被挪到另一个 provider"；无匹配 runner = "不会被改派给不匹配的 runner"；runtime 缺失 =
   "没有人替你装"。测试用正则扫过全部 18 个 kind，禁止出现 `falls back` / `instead uses` /
   `switch to another` 这类读法——控制环没有第二条派发路径（§12.3），界面不能承诺一条。
3. **绝不静默覆盖。** 每一次写都带 `expectedConfigRevision`；被 CAS 拒绝时表单**关闭**，
   直到读者按下 "Review current settings"。仅仅报告失败是不够的：下一次提交会带上**当前**
   revision 因而必然成功，把读者的陈旧意图直接写在刚刚拒绝它的那次修改之上。

## 写控制

| 控制 | 端点 | 说明 |
|---|---|---|
| Run now | `POST /projects/:id/coordinator/trigger` | 只入队一条信号。文案明说"它不授予任何权限、不跳过任何检查"——之后那一趟仍过同样的策略/授权/并发/预算门 |
| Save settings | `PATCH /projects/:id` | 四个授权字段。只发**改动过的**字段，避免一次编辑顺手把别人刚改的字段重新断言一遍 |

* `triggerId` 命名的是**这一次按下**，不是那一趟运行：按下时生成、被应答后清空，所以超时
  重试是同一个请求而不是第二趟协调。浏览器拿不到 `crypto.randomUUID` 时不发，由服务端分配。
* 打开协调器时必须同时指明 `automationPolicy`（服务端硬性要求），`policyPatchBody` 因此在
  off→on 时总是带上它——否则等于替 owner 选了一档自动化。
* **升级自动化必须确认**：打开协调器、抬高自动化档位、或撤掉每日预算，会渲染一条 warning
  并要求勾选 "I want this project to run with that much autonomy."。降档、调并发不需要确认。
  确认框是内联的（不是 Modal），因此静态渲染测得到。
* 关掉的项目、已 settled 的项目**照样可以改设置**——`PATCH` 并不拒绝这两者，而且"把协调器
  重新打开"正是在这张表单里做的；凭空多一条拒绝会把项目关死在里面。

## 拒绝与权限

`triggerRefusal` / `policyRefusal` 回答的是**服务端会给的那几条拒绝**，在请求之前给出，
所以一个禁用的按钮总能说出按下去会被告知什么：

| code | 何时 | 关的是哪个控制 |
|---|---|---|
| `READ_ONLY` | 服务端对上一次写控制回了 403 | 全部（顶部同时挂一条 Read-only 说明，读面完整保留） |
| `STATUS_UNKNOWN` | 状态还没读到 | 全部——**没读到不等于健康** |
| `STALE_CONFLICT` | CAS 被拒且尚未确认 | 全部 |
| `PROJECT_SETTLED` | 项目 DONE/CANCELLED | 仅 Run now |
| `COORDINATOR_DISABLED` | 开关关着 | 仅 Run now（并指向下方开关） |
| `IN_FLIGHT` | 已有写在飞 | 全部 |

只读态**不是从 payload 猜的**——读面里没有权限字段，凭空造一个要么藏起一个本来能用的控制、
要么留下一个必然失败的按钮。它来自唯一真正知道答案的地方：服务端的 403。

`ApiError` 因此新增了可选的 `code`：一个 409 不是一件事（`STALE_CONFIG_REVISION` /
`PROJECT_SETTLED` / `COORDINATOR_DISABLED` / open-coordinator 的 `ALREADY_COORDINATING`），
而其中只有一个可以被自动重试——按 message 分支会在第一次有人改文案时坏掉。

## Base62

页面上每一个 id 都经 `encodeId` 变成短公共 id 再进链接（Agent → `/workspaces/:id`、
Session → `/sessions/:id`、Task → `/tasks/:id`）。**编不出来的 id 显示为 `unreadable id`
而不是原值**——把裸值印出来正是 UUID 上墙的路径。测试用 UUID 拼装完整 fixture 渲染后，
以 UUID 正则断言整页 HTML 一处都不匹配。

## 测试

| 文件 | 覆盖 |
|---|---|
| `src/web/src/lib/coordinatorStatus.test.ts` | 41 条：15 个封闭理由各有句子、未知理由被指名、"uncapped ≠ 0" / "never attempted ≠ passed" / "never opened ≠ trashed" / "predates audit ≠ none"、provider/runner/runtime 三者可分且无 fallback 措辞（18 kind 全扫）、未知 kind 仍是 blocker、MANUAL 不是 off、未知 runState 不画成健康、六种拒绝码各自成立且 `PATCH` 不多造拒绝、CAS body 只发改动项 / 开机必带档位 / 关机不带档位 / 预算 null 显式发送、升级确认的四种触发与合并文案、`triggerBody` 带 fence 与 triggerId、409 按 `code` 分辨 |
| `src/web/src/components/ProjectCoordinatorPanel.test.tsx` | 31 条：loading/error/empty/陈旧读、只读态（两个按钮 + 四个字段全禁用，可驱动时为 0）、legacy 项目（每个 typed absent 都成句、默认关且不诱导开）、Base62 全覆盖 + 无裸 UUID + 不可编码 id、结构化 blocker（runner 离线 vs provider 不可用 vs 审批等待 vs `COORDINATOR_NO_PROGRESS`、已解决历史）、手动触发（queued vs already queued、服务端拒绝原文）、设置表单（三档文案、未改动不可保存、升级需确认、CAS 冲突关闭写路径、普通错误不伪装成冲突）、验收证据（没跑过说没跑过、合并状态未上报说未上报）、决策台账 |
| `src/web/src/pages/ProjectsPage.test.tsx` | +5 条并更新 4 条既有清单：api 调用清单增两条写、查询缓存清单增 coordinator 读、分区挂在已加载分支内、一次 `['project', id]` 失效同时刷新文档与状态、403/CAS latch 且无自动重试、triggerId 生命周期 |

全量：`npm test -w @orbit/web` → **54 files / 797 tests 通过**（基线 52 / 720）。
`tsc -b` 与 `vite build` 干净。

> 注：`node_modules/@orbit/shared` 默认软链到 main 的 `dist`，会让 `tsc -b` 报三条与本单元
> 无关的假红（`totalCapped`、`permissionModeAvailableOnRunner`）。把它指回本分支的
> `src/shared` 并 `npm run build -w @orbit/shared` 之后，`tsc -b` 零错误。
