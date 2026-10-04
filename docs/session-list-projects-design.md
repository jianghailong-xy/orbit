# 会话列表里的项目条目：一个项目合成一个条目

状态：已定稿（2026-10-04），按项目「会话列表：一个项目合成一个条目」分任务落地。效果图在 `docs/mocks/session-list-projects/`：`01-web` 是真实 Web 控制台截图，新加的部分用控制台自己的样式画进页面；`02-ios` 是 iPhone 版式，照 `AgentSessionRow.compactRow` 画。
本文是执行会话的契约：写代码前读它；实现与本文冲突时，先说清楚再改，别悄悄偏离。

## 1. 为什么

一个项目跑起来，会话列表里就混进它的 coordinator、一串执行任务的会话、判断会话和 @ 任务的对话，按时间和普通会话搅在一起；你真正要找的 coordinator 被挤在中间。项目的主要交互是和 coordinator 对话，执行会话很少需要你直接进去。

所以：一个项目在会话列表里只占一行。这一行就是 coordinator 那一行，再带上项目进度；成员会话收在它后面，列表里不展开。

不做成“系统文件夹”：项目归属是推导出来的（会话 → 任务 → 项目），文件夹是用户手动归类，两者会抢 `folderId` 这一个槽；项目跨 Workspace（coordinator 在 `coordinatorWorkspaceId`，执行会话落在各任务 assignee 的 Workspace），文件夹只属于一个 Workspace。文件夹的列表规则仍是这里的先例（`docs/session-folders-move-design.md` §3.3、§7）。

## 2. 哪些会话算项目的成员

| role | 怎么认 |
|---|---|
| `COORDINATOR` | `project.coordinator_session_id = s.id` |
| `TASK` | `s.task_id → task.project_id` |
| `CONTEXT`（@ 任务发起的对话） | `s.context_task_id → task.project_id` |
| `JUDGMENT`（coordinator 的一次性判断会话） | `project_coordinator_wake.session_id`，`status = 'SESSION_OPENED'` |
| `CHILD` | 自己不属于任何项目、但根会话（`root_session_id`）属于某个项目的子会话，跟根会话走 |

- 一个会话同时命中多条时按表格顺序取第一条（正常不会发生：coordinator 不执行任务，`task_id` 和 `context_task_id` 有 CHECK 互斥）。
- 被 `/coordinator/replace` 换掉的旧 coordinator 认不回来（项目不再指向它），它留在 Completed 里平铺。本期不处理。

## 3. 服务端

### 3.1 `projectMembership`

会话列表（`GET /sessions`）、会话详情（`GET /sessions/:id`）和 `session.updated` 推送的会话摘要（`buildSessionSummary`）都加：

```jsonc
"projectMembership": {              // 不属于任何项目时为 null
  "projectId": "…",
  "projectTitle": "后台作业生命周期",
  "projectStatus": "OPEN",          // OPEN | DONE | CANCELLED
  "role": "COORDINATOR"             // COORDINATOR | TASK | CONTEXT | JUDGMENT | CHILD
}
```

- **不改现有 `projectId` / `projectTitle`。** 它们的含义是“这个会话协调哪个项目”，只给 coordinator；Coordinator 标、会话里的卡片、iOS 的 `coordinatorPulses`、Back to project 都在读。
- 嵌套的 `projectId` 已在 `PUBLIC_ID_FIELDS` 里（`src/shared/src/codec.ts`），拦截器按字段名改写、不看层级，所以 codec 不用改。
- 成员关系写成**一段 SQL**，三处共用，免得列表、详情、推送算出来不一样。列表查询已经 `LEFT JOIN task t`、`LEFT JOIN project cp`（`sessions.service.ts` 的 `listRows`），在此基础上补 `context_task_id` 的任务、判断会话的 wake 和根会话。
- 本期不加列、不做迁移。

### 3.2 按项目列会话

`GET /sessions?projectId=<id>&view=<open|completed>`：这个项目在**所有 Workspace** 里属于调用者的成员会话（含 coordinator），行的形状和排序与列表相同。别人的项目返回空列表。项目会话页用它。

### 3.3 `/projects/sidebar` 补进度数字

每个项目加 `taskCounts: { done, failed, total }`，取自触发器维护的 `project_task_status_count`：`done` 是 DONE，`failed` 是 FAILED，`total` 是除 CANCELLED 外的全部。`buckets.running`、`attention`、`coordinatorActivity` 已经有了。

### 3.4 实时

不加新事件。客户端：
- 成员会话的 `session.updated` 本来就实时，条目上的状态点、第 2 行的话跟着它变。
- 进度数字（`taskCounts`、`buckets.running`）和 coordinator 处理中的例外来自 `/projects/sidebar`：照旧 15 秒轮询，另外收到成员会话的 `session.updated` 时去抖（约 2 秒）顺手刷新一次。
- 把两端都没处理的 `project.changed` 接上：Web 的 `groupsFor` 现在只刷会话，Swift 的 `ControlEventType` 把它解成 `.unknown`；收到时刷新项目摘要。

## 4. 列表里的项目条目

### 4.1 版式

和会话行**一样高**：Web 64px，iPhone 75pt（`compactRow`），都是两行。iPad 用 `regularIOSRow` 的版式，同样两行。

- **第 1 行**：四宫格图标（Web 侧栏 Projects 的 `square.grid.2x2`，品牌蓝；iOS 是标题前的小图标）、项目名（和会话行同一字重，不加粗：owner 10-04 的决定，效果图里的粗体以此为准）、状态点、时间。
  - 时间：组里成员会话最新的 `lastTurnAt ?? createdAt`。
  - 不再画 `Coordinator` 标：图标已经说明这是项目。
- **第 2 行**：开头是**进度小标签**，放在会话行放标签的位置（现在 coordinator 行放 `Coordinator` 标的位置）：迷你进度条（绿 done、蓝 running、红 failed、灰其余）加 `done/total`。项目 DONE 时小标签变绿。后面是“第 2 行的话”（§4.2）。
- **状态点**：组里任一会话的状态是“等你” → 琥珀；否则任一在跑 → 图标位置和会话行一样转圈（Web 蓝色转圈代替四宫格，iOS 灰色转圈：owner 10-04 的决定，效果图里的运行状态以此为准）；否则只剩后台作业 → 呼吸。读法和会话行、文件夹行同一套（Web `statusGlyphMotion` / `sessionNeedsYou`，iOS `SessionLiveIndicator`）。
- 条目上**没有琥珀计数**，也**没有子行**：列表里不展开。

### 4.2 第 2 行的话

按顺序取第一个成立的：

1. **coordinator 等你**：它会话行现在的原话（Web `sessionLine` / iOS `SessionLine.make`），如 `Approve merge to main`、`Question from coordinator`、`Escalated to you`、`Paused`、`Ready to start`，琥珀色。
2. **有执行会话等你**（coordinator 没在等）：`<那个会话行的等待原话> · <会话名>`，如 `Waiting for your confirmation · 额度恢复后自动重试`，琥珀色。几个都在等时取等得最久的那个。会话名在窄栏里会被截断，Web 悬停能看全。
3. **coordinator 在处理例外**（`/projects/sidebar` 的 `attention.coordinatorItems`）：项目页那个蓝标签的话去掉 `Coordinator ·` 前缀、首字母大写，如 `Resolving a merge conflict · 18m`，蓝字。
4. **其余**：coordinator 会话行的原话（`Running …` 蓝字、`You: …`、最后一条回复预览）。
5. **没有 coordinator**（从没开过、在回收站或已清除）：`No coordinator`，灰字。

### 4.3 点击

- **点条目**：进第 2 行所说的那个会话。第 1、3、4 种是 coordinator；第 2 种是那个等你的执行会话；第 5 种进项目会话页。
- **点进度小标签**：进项目会话页（§5）。它是单独的点击区：Web 悬停时描边变蓝，提示 `<n> sessions · <m> running`（n 含 coordinator）；iOS 把它的点击区加高到整行。
- **Web 悬停 ⋯ / iOS 长按**：`Open Coordinator`、`Sessions`、`Open Project`，分隔线，`Pin` / `Unpin`、`Move…`。后两项作用在 coordinator 上，条目跟着走。
  - **不放** `Complete`、`Share`、`Delete`：完成 coordinator 会影响整个项目，要在对话里做。
  - **不放任何回答按钮**：回答只在对话里的卡片上（`OwnerConfirmationCard.test` 钉着“会话列表上不能有回答入口”）。
- **滑动**（iOS、Web 手机）：右滑 `Pin` / `Unpin`，左滑 `Move`。
- **选中态**（Web）：打开的会话是这个项目的成员时，条目高亮。

### 4.4 放在哪

- **位置**：占 coordinator 的位置。coordinator 置顶就在 Pinned；否则按组里最新的活动时间进时间分组。成员会话自己的置顶不影响条目。
- **Open / Completed**：视图里有这个项目的任何一个会话就显示条目，状态点、时间只算这个视图里的会话（同文件夹）。执行会话在任务 DONE 后会自动进 Completed（`docs/session-lifecycle-design.md` §3），所以 Completed 里的条目收着已完成的执行会话。
- **Trash、Filter by Tag、Group by Tag、搜索**：平铺，不合并，免得两套分组叠在一起（同文件夹）。
- **文件夹**：coordinator 在哪个文件夹，条目就在哪个文件夹（文件夹行的数字和标记把条目里的会话算进去）。成员会话一律收在条目后面，忽略它们自己的 `folderId`；非 coordinator 成员的 `Move…` 隐藏。
- **跨 Workspace**：每个有成员会话的 Workspace 列表里都出现这个条目，内容是整个项目的，状态点只算本 Workspace 的会话；点了照样打开第 2 行所说的会话，会话栏跟着换到它的 Workspace（Web 本来就这样）。
- **老服务器**：没有 `projectMembership` 时平铺，和现在一样。项目不在 `/projects/sidebar` 里（比如已 DONE）时，进度小标签只显示 `projectStatus`，不画进度条。
- **Needs-you 提示条、推送**：不变，照旧直接跳到等你的那个会话。

## 5. 项目会话页

- **入口**：进度小标签、菜单里的 `Sessions`、没有 coordinator 时点条目。
- **Web**：会话栏原地换页，地址带 `?project=<id>`，浏览器后退、刷新都对；在这一页里打开会话时参数跟着走。做法照文件夹页（`?folder=`）。
- **iOS**：iPhone 推进导航栈（`NavNode` 加一种页面）；iPad 中间栏原地换页。和文件夹页走同一套。
- **页头**：‹ 回到 Workspace 的列表；标题是项目名，下面一行小字 `Project · <n> sessions`；⋯ 里是 `Open Project`、`Open Coordinator`。这里没有 New session：项目的会话由 coordinator 派发。
- **进度条**：页头下面一条，迷你进度条 + `<done>/<total> done · <m> running`，Web 用 ↗、iOS 用 `Project ›` 进项目页。
- **列表**：`Coordinator` 一节放 coordinator（行上照旧带 `Coordinator` 标），下面是成员会话，按时间分组；行、悬停按钮、左右滑、长按都和外面一样。列的是 `GET /sessions?projectId=` 返回的全部 Workspace 的成员会话，范围跟着进来时的视图（Open 或 Completed）。

## 6. 文案（Web 与 OrbitKit 逐字一致）

| 用在哪 | 英文原文 |
|---|---|
| 进度小标签 | `<done>/<total>` |
| 小标签悬停（Web） | `<n> sessions · <m> running` |
| 执行会话等你 | `<等待原话> · <会话名>` |
| coordinator 处理例外 | `Resolving a merge conflict · <age>`、`Checks failed · <age>`、`Handling an integration error · <age>`、`Handling a failed task · <age>`、`Reviewing a delivery · <age>` |
| 没有 coordinator | `No coordinator` |
| 菜单 | `Open Coordinator`、`Sessions`、`Open Project`、`Pin`、`Unpin`、`Move…` |
| 项目会话页 | `Project · <n> sessions`、`Coordinator`（节名）、`<done>/<total> done · <m> running`、`Project ›`（iOS） |

等待原话、coordinator 的话沿用会话行已有的常量，不另写。处理例外的五句来自 `projectAttention.ts` 的 `COORDINATOR_LEAD_COPY`，首字母大写。Swift 侧加对照测试，读取 `src/web/src/lib/sessionProjects.ts`（照 `ProjectAttentionCopyParityTests`）。

## 7. 客户端实现

- **分组在客户端做**：纯函数放 `src/web/src/lib/sessionProjects.ts` 和 OrbitKit 的 `SessionProjectGrouping`，带单测。输入会话、文件夹和项目摘要，输出文件夹行、项目条目、平铺的会话；接在文件夹分组之后。
- **Web 分页**：需要分组时像文件夹一样整页拉取列表（`limit: null`），不然组里的会话会漏。
- **读源码文本的测试**：iOS 的 `SessionFolderPageWiringTests`（`AgentsView` 里文件夹 `ForEach`、`SessionFolderGrouping.listing(` 那几行）；Web 的 `WorkspaceView.decisionStrip` / `exceptionPlacement` / `promotionPlacement` / `acceptanceConfirmationCard` / `projectBackLink`、`OwnerConfirmationCard` 等。改列表代码时别动这些行和字符串。
- **Swift**：本机没有 gh，用 swift:6.1 docker 跑 OrbitKit；iOS UI 的构建靠 CI。
- **新字段一律 `decodeIfPresent`**：老服务器不返回也能解码。

## 8. 这一期不做

- macOS（现在的列表连文件夹都不显示）。
- 进度改成验收标准进度（`3/5 criteria met`），要服务端新做汇总。
- 认回被替换的旧 coordinator（要存储列）。
- 服务端分组分页。

## 9. 分任务

1. 服务端：`projectMembership`（§3.1）。
2. 服务端：`GET /sessions?projectId=`（§3.2），依赖 1。
3. 服务端：`/projects/sidebar` 的 `taskCounts`（§3.3）。
4. Web：分组纯函数、文案和列表里的项目条目（§4、§6、§7），依赖 1、3。
5. Web：点击目标和项目会话页（§4.3、§5），依赖 2、4。
6. OrbitKit：`SessionProjectGrouping`、`projectMembership` 解码和文案对照测试，依赖 4。
7. iOS：列表里的项目条目、项目会话页、长按和滑动，依赖 2、3、6。
8. Owner 在部署后的 Web 控制台和 TestFlight 构建上对照效果图确认，依赖 5、7。
