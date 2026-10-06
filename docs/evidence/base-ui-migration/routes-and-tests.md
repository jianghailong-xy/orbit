# 路由、测试与人工复核索引

本表是 P0.1 的依赖与后续验证归属记录；没有修改生产页面，也不宣称已建立视觉基线或运行完这些测试。路径除特别注明外相对 `src/web/src/`。实施基线为 `1068a14b899911838526111b6814394e99762aaf`；规划快照为 `9172a78368eaffbf024b549e9f9bfb553ff99e4c`。

## 规划快照复核

计数单位是文件，不是 import、组件实例或测试用例；生产/测试按 `.test.*` / `.spec.*` 文件名分开。antd 静态 import 包含 `antd/…` 深层路径与 side-effect；独立 `@ant-design/icons` 不计入 antd。`.ant-*` 测试采用原始源码 `.ant-` 子串口径，因此含注释或源码断言也算，不应解读为 54 个纯 DOM 测试。

| 集合 | 规划 | 实施 | 差异（均相对 `src/web/src/`） |
| --- | ---: | ---: | --- |
| antd 生产文件 | 91 | 93 | 新增 `components/ConfirmationReviewTurnCards.tsx`、`components/OwnerConfirmationReopen.tsx`、`components/OwnerConfirmationReview.tsx`；移出 `lib/toast.tsx` |
| antd 测试文件 | 62 | 64 | 新增 `components/WorkspaceView.sessionMenu.test.tsx`、`pages/ProviderConnectPage.gemini.test.tsx` |
| 含 `.ant-` 的测试文件 | 54 | 54 | 新增 `components/WorkspaceView.sessionMenu.test.tsx`；移出 `indexCss.test.ts`；相同数量不等于相同集合 |
| 独立图标生产文件 | 78 | 80 | 新增 `components/ConfirmationReviewTurnCards.tsx`、`components/OwnerConfirmationReview.tsx`、`components/ToastViewport.tsx`；移出 `lib/toast.tsx` |
| 生产 antd / 图标并集 | 117 | 120 | 新增以上三个确认卡文件与 `ToastViewport.tsx`；移出 `lib/toast.tsx` |

已用两个提交的 `git ls-tree -r --name-only <revision> src/web/src` 与逐文件 `git show <revision>:<path>` 独立复核集合。当前 `src/web/package.json` 为 antd `^6.6.5`，icons `^6.3.4`；`main.tsx` 不再导入 React 19 的 AntD v5 patch。旧 wiki 中 v5 补丁导入顺序的约定不适用于当前版本，不能为迁移重新加回。`lib/toast.tsx`、`toastFeed.ts`、`toastStore.ts` 与 `ToastViewport.tsx` 已构成自有 Toast；P2 是保留并验证其行为，不应误判仍需用 AntD message 迁移。

## 所有路由入口及布局

基线 `App.tsx` 有 **48 个带 path 的 Route、1 个 index Route、2 个无 path 布局 Route**。以下逐项列出 path；`wiki` 实际为 **15 条**，源码“ten routes”注释已过时。除 public/auth/兼容 redirect 明示的例外，路径均在已登录的 AppShell 内，表中相对路径对应根 `/`。

| path | 入口 | 必须保留的路由或布局行为 | 负责阶段 |
| --- | --- | --- | --- |
| `/s/:token` | SharedLinkPage → SharedProjectPage / SharedTaskPage / SharedSessionPage | 公开；按 root.kind 分派、preview=1 不计浏览 | P4.4 |
| `/s/:token/c/:sessionId` | SharedSessionPage | 公开；共享 scope 内会话及下载 | P4.4 / P5.2 |
| `/s/:token/t/:taskId` | SharedProjectTaskRoute → SharedTaskPage | 公开；项目范围任务、无权限与失效同样处理 | P4.4 |
| `/login` | LoginPage | 已登录 Navigate /；next 路径与 query 恢复并拒绝站外 next | P4.1 |
| `/setup` | SetupPage | 已登录 replace /；已有用户跳登录 | P4.1 |
| `/enroll` | EnrollPage | 未登录携 query 跳 /login?next=… | P4.2 注册配置 / P4.1 鉴权跳转 |
| `*` | LoginRedirect | 仅未登录分支；保留 pathname+search，根仅跳 /login | P4.4 / P4.1 鉴权跳转 |
| `tasks` | TaskRoute → TaskListView | 自有 main；项目任务归位、列表保持挂载 | P4.3 / P3.2 |
| `tasks/:id` | TaskRoute → TaskListView / ProjectDetailPage | 自有 main；task 深链、明确 list/createdIn scope 保留 | P4.3 / P3.2 |
| `lists/:key` | TaskRoute → TaskListView | 自有 main；命名列表 scope | P4.3 |
| `settings/profile` | ProfilePage | DocView | P4.1 |
| `settings/account` | Navigate /settings/profile | replace；旧书签兼容 | P4.1 |
| `settings` | SettingsPage | DocView | P4.1 |
| `settings/shared-links` | SharedLinksPage | DocView；Active / Paused / Ended | P4.4 |
| `admin` | AdminUsersPage | DocView；成功信息弹窗仍需迁移 | P4.2 |
| `providers` | ProvidersPage | DocView；用户自有 BYOK | P4.2 |
| `providers/new` | ProviderPickPage | DocView；厂商选择 | P4.2 |
| `providers/new/:slug` | ProviderConnectPage | DocView；按厂商直达连接表单 | P4.2 |
| `providers/:id` | ProviderConnectPage | DocView；编辑已有连接 | P4.2 |
| `providers/pools/:id` | ProviderPoolPage | DocView；账号池权限和成员操作 | P4.2 |
| `admin/providers` | Navigate /providers | replace；旧管理入口兼容 | P4.2 |
| `following` | FollowingPage | DocView；watch query 定位卡片 | P4.4 |
| `projects` | ProjectsPage | DocView；项目列表、筛选与新建 | P4.3 |
| `projects/:id` | ProjectDetailPage | DocView；全景与任务面板 | P4.3 |
| `projects/:id/tasks/:taskId` | ProjectDetailPage | DocView；同一页面实例，保留滚动与展开状态 | P4.3 / P3.2 |
| `wiki` | WikiPage route="home" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/review` | WikiPage route="review" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/review` | WikiPage route="review" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space` | WikiPage route="home" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/t/:topic` | WikiPage route="topic" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/t/:topic/:part` | WikiPage route="topic" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/d/:doc` | WikiPage route="doc" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/plan` | WikiPage route="plan" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/plan/d/:doc` | WikiPage route="planDoc" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/plan/d/:doc/:section` | WikiPage route="planSection" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/browse` | WikiPage route="browse" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/az` | WikiPage route="index" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/e/:entry` | WikiPage route="entry" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/settings` | WikiPage route="settings" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `wiki/:space/run/:run` | WikiPage route="run" | DocView；保留空间、文档、分节或运行标识 | P4.4 |
| `runners` | RunnersPage | DocView | P4.2 |
| `runners/register` | RunnerRegisterGuide | FlushView；注册引导 | P4.2 |
| `runners/:id` | RunnerDetailPage | DocView；账号、工作区、模型路由 | P4.2 |
| `workspaces/:id/*` | WorkspaceConsole → WorkspaceView | 共享 layout；工作区、新会话等子路径不卸载流 | P5.3 |
| `agents/:id/*` | WorkspaceConsole → WorkspaceView | 共享 layout；旧 workspace 命名兼容 | P5.3 |
| `sessions/:id` | WorkspaceConsole → WorkspaceView | 共享 layout；会话深链、runner 延迟解析、404 | P5.3 |
| `/workspaces/:id/sessions/:sessionId` | LegacySessionRedirect | 鉴权后、AppShell 外；UUID 编码为 /sessions/:id；无效 / | P5.3 |
| `/agents/:id/sessions/:sessionId` | LegacySessionRedirect | 鉴权后、AppShell 外；旧别名同上 | P5.3 |

不带 path 的入口与根装配同样属于迁移边界：

| 入口 | 当前装配与保留行为 | 负责阶段 |
| --- | --- | --- |
| `main.tsx` | StrictMode → QueryClientProvider → ThemeProvider → ConfigProvider / AntApp → BrowserRouter → BootGate / App / ToastViewport；保留 query defaults、主题解析、路由内 toast 导航 | P1 / P2 / P6 |
| `BootGate.tsx` | login/enroll/setup 和 `/s/` bypass；首屏 setup 判定与数据预热；SSE/业务语义保持 | KEEP；P4.4 集成复核 |
| `AppShell.tsx` 无路径布局 | ControlPlaneProvider 内常驻 TasksSidePanel、全局 SessionSearch、Outlet；手机遮罩与路由切换关导航；已登录后才启动每标签 SSE | P5.1 |
| `DefaultLanding` index | 第一可打开 workspace；加载 Spin；0 runner 引导、1 runner 详情、多个 runner 列表；查询前不闪现错误页面 | P4.4（App.tsx） |
| `WorkspaceConsole.tsx` 无路径布局 | workspaces/agents/sessions 共用 WorkspaceView；保留挂载、流、列表与已解析 runner fallback；失败深链呈现 404 | P5.3 |
| `DocView` / `FlushView` | 页面 gutter 与滚动容器 / 全幅契约；TaskListView 自有 main 和侧面详情面板 | P1 / 对应页面阶段 |

`pages/` 下全部 22 个生产 TSX 模块均在上表或下列入口链中：`TaskListView` 由 `TaskRoute` 装配；`SharedProjectPage`、`SharedTaskPage` 由 `SharedLinkPage` 分派；`TaskDetailPage.tsx` 目前导出任务验收编辑块而不是独立路由，由 `TaskDetailPanel` 使用，也被共享任务页引用常量；生产文件由 P4.3 负责，P3.2 试点同时复核集成。迁移不得因为文件名无同名 Route 而漏记或删除。

## 人工复核：容易漏掉的运行时契约

| 位置 | 耦合或现状 | 替代与保留行为 | 负责阶段 |
| --- | --- | --- | --- |
| `TaskDetailPanel.tsx:1041` | `taRef.current?.resizableTextArea?.textArea`，ref 是 `any`，只找类型 import 会漏掉 | P3.1 自有自动增高输入框提供真实 textarea ref；`@` 提及选择后焦点、光标与 draft 必须保持 | P3.1 / P3.2 |
| `WorkspaceView.tsx:6374,6395` | 同一内部 textarea 路径，读取 offsetHeight / scrollHeight / clientHeight；依赖 rc-textarea 自动高度下一帧完成 | 自动增高上限、拖动高度 44–640、双击重置、达到上限后显示把手；后续同文件 focus 不得失效 | P3.1 / P5.3 |
| `RunnerDetailPage.tsx:41,300,1127,1396` | `RefSelectProps` 与 `keepFreeRef.current?.focus({ preventScroll: true })` | 自有 Select 公开真正需要的聚焦操作；保留 keep-free 提醒后焦点且不滚动页面 | P4.2 |
| `SessionOutputs.tsx:495,643–658` | `theme.useToken()` 的 elevated 背景、圆角、阴影、文字色、分隔线 | 使用已有 Orbit 设计变量；核对 merge 下拉自绘内容明暗主题与层叠 | P1 / P5.1 |
| `SessionSearch.tsx:158–188` | `.ant-modal-wrap` 只在注释中，但记录了真实 Esc 焦点缺陷；已有 window capture 监听 | 全局 ⌘K/Ctrl+K、Esc 一次关闭、打开后输入聚焦、上下与 Enter、多路由常驻及不吞其他快捷键 | P2 / P5.1 |
| `PlanUsageIndicator.tsx:44–127` / `CodexResetCredit.tsx:569–574` | Popover 内叠 Modal；click/hover 区分聚焦、手动 Tab 环、确认默认 Cancel、自定义关闭后焦点、Modal zIndex 1100 超过 Popover 1030 | 保留手机 shiftX 防横向溢出、Popover 在确认时不关闭、确认后回状态行/取消后回触发器；新旧弹层共存必须实测 | P2 准备 / P5.1 切换 / P5.3 集成 |
| `AdminUsersPage.tsx:48` | `modal.success`，不是 `modal.confirm`；只扫 confirm 会遗漏 | 保留创建用户成功信息和关闭路径；Orbit 弹层 API 只覆盖此真实需求 | P2 / P4.2 |
| `lib/toast.tsx` / `ToastViewport.tsx` | 已独立于 antd，保留 icons | 保留 3s / 6s / pinned 寿命、Undo、错误诊断、aria-live、会话导航与 void 返回避免 mutation 等关闭 | P2 |
| `AppShell` / `PlanUsageIndicator` / `SessionFind` / `WorkspaceView` 等 | 自有 class、querySelector 和焦点管理不是全部都属于 AntD 内部耦合 | 保留既有 DOM/滚动/焦点行为；以依赖清单中确切 `.ant-*` 或 ref 证据为清理范围，不批量改 DOM | 对应页面阶段 |

命令式调用的独立复核全集：`RunnerDetailPage` 6 个 confirm；`RunnersPage` 1；`ProjectsPage` 1；`WikiRunPage` 1；`RunnerTokenRotation` 1；`SharedPool` 2；`SessionMoveModal` 1；`WorkspaceView` 6；`AdminUsersPage` 1 个 success。共 **19 个 confirm + 1 个 success**，由 **10 处 useApp**（9 个文件，SharedPool 有两个组件）取得 modal。阶段先由 P2 提供公共弹层，再由对应页面阶段完成替换，P6 最后移除根 Provider。详尽出现行以机器清单为准。

## 测试全集与归属

当前全集 **287 个** `.test.*` / `.spec.*` 文件，下面全部列出；即使没有直接 import antd 的渲染、源码契约、纯业务测试，也保留在索引内，避免只迁移 test Provider 而漏掉集成边界。每行阶段是优先负责复核的阶段，共享依赖改变时仍需扩展到调用方。

`A` = 直接 antd import（含类型/side-effect）；`S` = 原文含 `.ant-`（也含注释或源码断言）；`—` = 两者均无，不表示与组件迁移无关。示例检查点来自该测试首个 describe/it 名称，仅供定位，不能代替阅读全部断言。现有文本/markup/source snapshot **不是浏览器截图证据**；P0.2/P3.3/P7 及各页面迁移批次按项目要求留固定数据、视口、主题和环境的真实视觉证据。

### P1 · 基础外观、主题与通用控件（4 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `indexCss.test.ts` | — | index.css |
| `lib/statusPalette.test.ts` | — | dependency graph edge palette |
| `lib/tagColor.test.ts` | — | tagChipLabels |
| `lib/useDelayedFlag.test.tsx` | — | useDelayedFlag |

### P2 · 弹层与已有自有 Toast（2 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `lib/toast.test.tsx` | — | a toast says what happened to what |
| `lib/toastFeed.test.ts` | — | levels |

### P3.2 · TaskDetailPanel / ShareModal / TaskInputs 试点（6 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `components/ShareModal.test.tsx` | S | the Share dialog on a session |
| `components/TaskDetailPanel.modelRouting.test.tsx` | S | the Suggested tier in Details |
| `components/TaskDetailPanel.reopen.test.tsx` | — | the Reopen press in the task detail panel |
| `components/TaskDetailPanel.share.test.tsx` | S | the task panel’s ⋯ |
| `components/TaskDetailPanel.test.tsx` | S | an OWNER_CONFIRMED task in the panel |
| `components/TaskInputs.test.tsx` | — | TaskInputs |

### P4.1 · 登录、注册、个人资料、设置（2 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `pages/ProfilePage.test.tsx` | — | Profile · the photo and the name are the owner's to change |
| `pages/SettingsPage.test.tsx` | — | session orchestration, one switch for the whole account |

### P4.2 · Provider / Pool / Runner / Admin（31 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `components/ClaudeHistoryOffer.test.tsx` | — | ClaudeHistoryOffer |
| `components/RunnerEngines.accounts.test.tsx` | S | a runner with two Codex accounts |
| `components/RunnerEngines.claudeAccount.test.tsx` | S | a runner with two Claude accounts |
| `components/RunnerEngines.duplicateAccount.test.tsx` | S | one Codex account signed into two slots |
| `components/RunnerEngines.removeAccount.test.tsx` | S | removing one Codex account from a runner |
| `components/RunnerEngines.renameAccount.test.tsx` | AS | renaming an account on a runner |
| `components/RunnerEngines.singleAccount.test.tsx` | S | 见文件内断言 |
| `components/RunnerEngines.test.tsx` | — | what one engine row says |
| `components/RunnerEnginesSection.test.tsx` | — | a machine's engine CLIs |
| `components/RunnerSignIn.test.tsx` | — | RunnerSignIn on a runner with an earlier sign-in on record |
| `lib/codexLogin.test.ts` | — | withLogin |
| `lib/codexResetCredit.test.ts` | — | which reset entry a runner gets |
| `lib/engineAccounts.test.ts` | — | the name + Account gives a new account |
| `lib/providerAdmin.test.ts` | — | suggestProviderName |
| `lib/providerGlyphs.test.ts` | — | provider glyph aliases |
| `lib/providerPools.test.ts` | — | a pool's head line |
| `lib/runnerAttention.test.ts` | — | runnerAttention.cases.json |
| `lib/runnerSlots.test.ts` | — | keeps transient queue and startup notices quiet for ten seconds |
| `lib/sharedPools.test.ts` | — | where a shared pool key stands, for whoever reads it |
| `pages/EnrollPage.test.tsx` | — | runner enrollment identity |
| `pages/ProviderConnectPage.gemini.test.tsx` | A | connecting a Gemini key |
| `pages/ProviderConnectPage.test.tsx` | — | naming a provider whose vendor is already connected |
| `pages/ProviderPoolPage.access.test.tsx` | AS | a Codex pool shared with people before it has an API key |
| `pages/ProviderPoolPage.whoCanUseIt.test.tsx` | AS | a Codex pool, as its owner and as somebody they added read it |
| `pages/ProvidersPage.codexLogin.test.tsx` | AS | a Codex pool of one’s own ChatGPT account |
| `pages/ProvidersPage.pools.test.tsx` | AS | Account pools on /providers |
| `pages/ProvidersPage.sharedPools.test.tsx` | AS | a shared pool on /providers and on its own page |
| `pages/RunnerDetailPage.codexAccount.test.tsx` | AS | which Codex account a workspace runs on |
| `pages/RunnerDetailPage.layout.test.tsx` | AS | a runner’s page, laid out as web.png |
| `pages/RunnerDetailPage.modelRouting.test.tsx` | AS | smart model selection on the Agent |
| `pages/RunnersPage.test.tsx` | A | the Runners list’s third line |

### P4.3 · 任务、项目、图和业务卡片（78 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `components/AcceptanceConfirmationCard.test.tsx` | — | whether a coordinator conversation is drawn the card |
| `components/CardAction.test.tsx` | — | both cards get their actions from one component |
| `components/CardHotkey.test.tsx` | — | confirmation keys |
| `components/CoordinatorQuestionCard.test.tsx` | — | what the card says |
| `components/CriteriaChangeCard.test.tsx` | — | the words, as the copy table has them |
| `components/CriteriaDecisionCard.receipt.test.tsx` | — | a criteria card answered in this window |
| `components/CriteriaDecisionCard.sessionSwitch.test.tsx` | — | the criteria card when the view moves from one project’s conversation to another’s |
| `components/CriteriaDecisionCard.settled.test.tsx` | — | the receipt of an approved proposal |
| `components/CriteriaDecisionCard.test.tsx` | — | a proposal the door would answer |
| `components/DecisionRail.exceptions.test.tsx` | — | the cards the owner presses, on the line |
| `components/DecisionRail.pointer.test.tsx` | — | the line takes the reader to the evidence card that answers it |
| `components/DecisionRail.settlement.test.tsx` | — | the settlement question on the line |
| `components/DecisionRail.test.tsx` | — | the line |
| `components/EvidenceDecisionCard.test.tsx` | — | the card is drawn from the row the pending read published |
| `components/EvidenceDecisionReceipt.test.tsx` | — | the receipt a decision leaves |
| `components/MentionDeliveryNotes.test.tsx` | — | MentionDeliveryNotes |
| `components/OpenItemDeliveryCard.test.tsx` | — | an exception item delivered to the coordinator |
| `components/OwnerConfirmationCard.test.tsx` | — | the confirmation card |
| `components/OwnerConfirmationReview.test.tsx` | — | the review bar, line for line (shared fixture) |
| `components/ProjectAcceptanceCard.test.tsx` | — | ProjectAcceptanceCard |
| `components/ProjectBlockers.test.tsx` | S | ProjectBlockersCard — what each blocker says |
| `components/ProjectChainProgress.test.tsx` | — | ProjectChainProgress |
| `components/ProjectCoordinatorCard.test.tsx` | — | ProjectCoordinatorCard — NEVER_OPENED |
| `components/ProjectCrossingsCard.test.tsx` | — | ProjectCrossingsCard — the question a person answers |
| `components/ProjectDependencyGraph.test.tsx` | — | projectGraphOverview |
| `components/ProjectPanoramaHeader.test.tsx` | — | ProjectPanoramaHeader |
| `components/ProjectProgressStatus.test.tsx` | S | ProjectOpenItems — the project page’s Open items card |
| `components/ProjectPromotionCard.test.tsx` | — | state A — the checks passed and it is waiting on you |
| `components/ProjectReadyToRun.test.tsx` | S | ProjectReadyToRun |
| `components/ProjectRunSettings.test.tsx` | — | How it runs — what the block says |
| `components/ProjectSections.test.tsx` | — | ProjectSections |
| `components/ProjectSettlementCard.test.tsx` | — | the copy |
| `components/ProjectShareControls.test.tsx` | S | the project header’s sharing controls |
| `components/ProjectStartedCard.test.tsx` | — | a project start told to the coordinator |
| `components/ProjectTaskPanel.test.tsx` | — | ProjectTaskPanel |
| `components/ProjectTasksGraph.test.tsx` | S | ProjectTasksGraph |
| `components/StartProjectCard.test.tsx` | — | the words, as the copy table has them |
| `components/TaskAttributionCard.test.tsx` | — | TaskAttributionCard — where this work counts |
| `components/TaskDependencyGraph.test.tsx` | — | TaskDependencyGraph |
| `components/TaskDependencyList.test.tsx` | — | TaskDependencyList |
| `components/TaskScheduleEditor.test.tsx` | — | the Start at editor — showing the schedule the server holds |
| `components/WorkOverviewReadiness.acceptance.test.tsx` | — | mobile Work overview consumes canonical readiness |
| `lib/batchGraph.test.ts` | — | buildBatchGraph |
| `lib/decisionReceipt.test.ts` | — | where a receipt goes |
| `lib/liveTaskProgress.test.ts` | — | reduceLiveTaskProgress |
| `lib/outcomeSurfaces.contract.test.ts` | — | Outcome surface Web contract |
| `lib/planUsage.test.ts` | — | planUsageRows |
| `lib/projectAttention.test.ts` | — | attention classification |
| `lib/slashCommands.test.ts` | — | slashCommands |
| `lib/taskDeletion.test.ts` | — | task deletion API client |
| `lib/taskDependencyGraph.test.ts` | — | normalizeTaskDependencyGraph |
| `lib/taskFilters.test.ts` | — | task filters |
| `lib/taskOutcome.test.ts` | — | taskOutcome |
| `lib/taskPages.test.ts` | — | taskPagePath |
| `lib/taskSchedule.test.ts` | — | runAtLocalValue — a stored instant as the control’s own value |
| `lib/taskSelection.test.ts` | — | toggleOne |
| `lib/taskSorting.test.ts` | — | task sorting |
| `lib/useControlPlane.pendingDecisions.test.tsx` | — | the pending-decision reads ride the control-plane stream |
| `pages/ProjectCoordinatorSection.test.tsx` | AS | ProjectCoordinatorSection — what a press costs |
| `pages/ProjectDetailPanorama.test.tsx` | — | ProjectDetailPage — the panorama, assembled |
| `pages/ProjectTaskRow.opening.test.tsx` | — | a project task row |
| `pages/ProjectTasksTopology.test.tsx` | S | ProjectTasks — topological bands |
| `pages/ProjectsPage.automatic.test.tsx` | — | ProjectsPage — the Automatic switch |
| `pages/ProjectsPage.delete.test.tsx` | S | ProjectDetailPage — deleting a project |
| `pages/ProjectsPage.newTask.test.tsx` | A | the project page’s New task door |
| `pages/ProjectsPage.status.test.tsx` | S | ProjectDetailPage — recording the project’s own status |
| `pages/ProjectsPage.test.tsx` | — | ProjectsPage |
| `pages/ProjectsPagePhone.test.tsx` | S | projects list on a phone |
| `pages/ProjectsPageProductionSnapshot.test.tsx` | — | projects index — 2026-08-23 production snapshot |
| `pages/ProjectsPageRowSortKeysVisible.test.tsx` | — | projects index — the sort keys are on the rows they sort |
| `pages/ProjectsPageToolbar.test.tsx` | S | ProjectsPage — status filter |
| `pages/TaskDetailPage.test.tsx` | — | the task detail page’s acceptance block |
| `pages/TaskListView.createdIn.test.tsx` | AS | the Tasks page scoped to one session |
| `pages/TaskListView.outsideProjects.test.tsx` | A | the Tasks page lists the tasks outside projects |
| `pages/TaskListView.scopeMenu.test.tsx` | AS | the Tasks page’s title |
| `pages/TaskListView.taskUrl.test.tsx` | A | opening a task from a list |
| `pages/TaskListView.test.tsx` | A | opening one task list |
| `pages/TaskRoute.test.tsx` | S | TaskRoute |

### P4.4 · Wiki、共享公开页面及其他页面（35 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `App.loginNext.test.tsx` | A | a signed-out visitor on an in-app page |
| `components/SameOriginLink.test.tsx` | — | sameOriginRoute |
| `components/WatchCard.test.tsx` | — | a watch card |
| `components/WatchEditor.test.tsx` | S | following a target |
| `components/WatchRelations.test.tsx` | S | a task’s Followed by |
| `components/WikiArticlePage.test.tsx` | AS | a topic's article |
| `components/WikiDocPage.test.tsx` | AS | a document's page |
| `components/WikiEntryDrawer.test.tsx` | — | the entry drawer |
| `components/WikiEntryMarks.test.tsx` | AS | an entry a review mode applied |
| `components/WikiMaintenanceStatus.test.tsx` | — | the Wiki home’s status line |
| `components/WikiPlanPage.test.tsx` | A | the plan page, by what its job is doing |
| `components/WikiReviewPage.challenge.test.tsx` | AS | a challenge card |
| `components/WikiReviewPage.edit.test.tsx` | AS | Review's Edit |
| `components/WikiReviewPage.phone.test.tsx` | — | Review on a phone |
| `components/WikiReviewPage.test.tsx` | — | Review — one card per op |
| `components/WikiRunPage.test.tsx` | AS | one run’s drawer |
| `components/WikiSettingsPage.test.tsx` | AS | Wiki settings |
| `lib/useControlPlane.watches.test.tsx` | — | the watches read rides the control-plane stream |
| `lib/useControlPlane.wiki.test.tsx` | — | the wiki reads ride the control-plane stream |
| `lib/watches.test.ts` | — | the condition, in words |
| `lib/wiki.test.ts` | — | the trust vocabulary |
| `lib/wikiArticles.test.ts` | — | the articles' words |
| `lib/wikiContext.test.ts` | — | the wiki context a session was handed |
| `lib/wikiDocs.test.ts` | — | the documents' words |
| `lib/wikiHealth.test.ts` | — | the status line says the fixture’s words for every look |
| `lib/wikiImport.test.ts` | — | an imported note as a source |
| `lib/wikiPlan.test.ts` | — | the plan's words |
| `lib/wikiReviewMode.test.ts` | — | the Wiki settings page says the fixture’s words, in its order |
| `lib/wikiRollout.test.ts` | — | the server saying the wiki is off |
| `pages/FollowingPage.test.tsx` | — | the Following page |
| `pages/SharedLinksPage.test.tsx` | S | Settings → Shared links |
| `pages/SharedProjectPage.test.tsx` | S | a project link’s public page |
| `pages/SharedSessionPage.test.tsx` | — | the shared page, a page at a time |
| `pages/SharedTaskPage.test.tsx` | — | a task link’s public page |
| `pages/WikiPage.test.tsx` | — | the Wiki home |

### P5.1 · 会话导航、检索、输出、侧栏（22 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `components/MergeRecoveryPanel.test.tsx` | — | shows every extra commit and the full diff, then approves exactly the displayed preview |
| `components/NewSessionProviderHero.accounts.test.tsx` | — | Codex accounts in the New Session picker |
| `components/NewSessionProviderHero.pools.test.tsx` | — | an account pool in the New Session picker |
| `components/NewSessionProviderHero.test.tsx` | — | NewSessionProviderHero |
| `components/PlanUsageIndicator.test.tsx` | AS | the Plan usage pill |
| `components/SessionOutputs.commitFailure.test.tsx` | A | a failed commit on the worktree bar |
| `components/SessionSearch.wiki.test.tsx` | — | ⌘K with the wiki above the sessions |
| `components/TasksSidePanel.admin.test.tsx` | S | Admin, for an admin |
| `components/TasksSidePanel.projects.test.tsx` | — | the sidebar’s Projects group |
| `components/TasksSidePanel.test.tsx` | — | TasksSidePanel nav |
| `components/TasksSidePanel.wiki.test.tsx` | — | the sidebar’s Wiki entry |
| `components/TasksSidePanel.workspaceStep.test.tsx` | — | ⌘/Ctrl + Up/Down through the Workspaces |
| `lib/findMatches.test.ts` | — | findMatches |
| `lib/scrollbarAutohide.test.ts` | — | installScrollbarAutohide |
| `lib/searchHighlight.test.ts` | — | splitHighlight |
| `lib/sessionActivity.test.ts` | — | session activity |
| `lib/sessionFolders.test.ts` | — | listShowsFolders |
| `lib/sessionGrouping.test.ts` | — | sessionTimeSections |
| `lib/sessionImport.test.ts` | — | importClaudeSessionAndWait |
| `lib/sessionSwipe.test.ts` | — | sessionSwipeActions |
| `lib/sessionTags.test.ts` | — | session tags API client |
| `lib/useControlPlane.folders.test.tsx` | — | session folders ride the control-plane stream |

### P5.2 · Transcript 及呈现依赖（41 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `components/BackgroundWakeSteer.test.tsx` | A | a wake written into the running turn, while it waits for the runner |
| `components/OrbitLinkCard.test.tsx` | — | the cards, one per kind |
| `components/OrbitReferenceLinks.test.tsx` | — | orbit-* references outside the transcript open their page in the app |
| `components/SessionCreatedTasksStrip.test.tsx` | — | the collapsed row |
| `components/SessionMessageCard.test.tsx` | — | another session’s message |
| `components/SessionReplyCard.test.tsx` | — | the recipient’s card says the message is a request, and where it stands |
| `components/TaskStartCard.test.tsx` | — | the turn that starts a task run |
| `components/Transcript.backgroundJobs.test.tsx` | — | a background-jobs note, opened |
| `components/Transcript.backgroundTasks.test.tsx` | — | background agent and workflow cards |
| `components/Transcript.backgroundWake.test.tsx` | A | a wake turn in the transcript |
| `components/Transcript.controlPlaneNote.test.tsx` | — | with the note recorded: only the typed words are the bubble’s own, and the block is a folded entry under them that opens to what the model read |
| `components/Transcript.inserts.test.tsx` | — | an insert sits at its moment in the conversation |
| `components/Transcript.localArtifact.test.tsx` | — | a path in the session’s own directories |
| `components/Transcript.referencedTask.test.tsx` | — | a `#`-referenced task in a bubble |
| `components/Transcript.settledReply.test.tsx` | A | a settled reply in the transcript |
| `components/Transcript.streamingOrder.test.tsx` | — | the live drafts sit where the generation started |
| `components/Transcript.test.tsx` | — | transcript sign-in cards |
| `components/Transcript.thinking.test.tsx` | — | a settled stretch of reasoning |
| `components/Transcript.turnEnd.test.tsx` | — | a turn_end that did not finish the turn |
| `components/Transcript.watchWake.test.tsx` | — | a turn a watch queued |
| `components/WikiContextNote.test.tsx` | — | the entries under the folded Wiki context line |
| `lib/ansi.test.ts` | — | stripAnsi |
| `lib/backgroundJobs.test.ts` | — | parseBackgroundJobs |
| `lib/backgroundShells.test.ts` | — | mergeBackgroundShells |
| `lib/backgroundWake.test.ts` | — | the block a background job’s wake opens a turn with |
| `lib/clipboard.test.ts` | — | copyText |
| `lib/contextSeed.test.ts` | — | context seed decisions |
| `lib/deliveredMessage.test.ts` | — | splitRecordedNote |
| `lib/eventFull.test.ts` | — | memoized untrimmed payloads |
| `lib/liveToolOutputs.test.ts` | — | foreground shell output snapshots |
| `lib/markdownText.test.ts` | — | markdownToPlainText |
| `lib/orbitLink.test.ts` | — | the shared cases, walked in full |
| `lib/plainPreview.test.ts` | — | plainPreview |
| `lib/referencedTask.test.ts` | — | parseReferencedTasks |
| `lib/sessionExport.download.test.tsx` | — | Download HTML from the session menu |
| `lib/sessionExport.test.tsx` | — | exporting a session that names Orbit objects |
| `lib/thinkingDraft.test.ts` | — | what a finished thinking block keeps |
| `lib/transcriptDeepLink.test.ts` | — | a link to one record of a session |
| `lib/transcriptPaint.test.ts` | — | transcriptPlaceholder |
| `lib/transcriptStore.test.ts` | — | eventsToPersist |
| `lib/turnPlacement.test.ts` | — | authoritative server turn placement |

### P5.3 · WorkspaceView 与会话交互（63 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `components/ApprovalPanel.questionWrap.test.tsx` | — | a multi-line AskUserQuestion in the generic form |
| `components/ApprovalPanel.stale.test.tsx` | A | an approval that arrived live outlives the question it was raised for |
| `components/ApprovalPanel.test.tsx` | A | single create approval |
| `components/WorkspaceView.acceptanceConfirmationCard.test.tsx` | A | the start card in WorkspaceView |
| `components/WorkspaceView.codexAccount.test.tsx` | AS | the runner account a session runs on |
| `components/WorkspaceView.commitResultMessage.test.tsx` | A | a finished commit reports the runner line |
| `components/WorkspaceView.compactingAfterInit.test.tsx` | — | a compaction that begins after the per-turn init |
| `components/WorkspaceView.composerMenu.test.tsx` | AS | the composer + menu |
| `components/WorkspaceView.criteriaDecisionCard.test.tsx` | A | the criteria decision card in an open coordinator conversation |
| `components/WorkspaceView.decisionStrip.test.tsx` | — | the pending strip is pinned above the conversation |
| `components/WorkspaceView.evidenceHandoff.test.tsx` | A | Chat about this on the evidence card |
| `components/WorkspaceView.exceptionPlacement.test.tsx` | — | where the conversation’s exception cards come from |
| `components/WorkspaceView.jumpToStart.test.tsx` | A | the way back to a session’s first message |
| `components/WorkspaceView.modelControl.test.tsx` | AS | the composer model control |
| `components/WorkspaceView.modelRouting.test.tsx` | AS | the model chip on a task run smart selection picked |
| `components/WorkspaceView.openItemDelivery.test.tsx` | A | an exception item’s delivery, on its way into the transcript |
| `components/WorkspaceView.pinnedFold.test.tsx` | A | the Pinned section folds |
| `components/WorkspaceView.poolAccount.test.tsx` | A | the status bar of a session on an account pool |
| `components/WorkspaceView.projectBackLink.test.ts` | — | projectBackLink |
| `components/WorkspaceView.projectIntent.test.tsx` | A | New Session project intent |
| `components/WorkspaceView.promotionPlacement.test.tsx` | A | the record a merge leaves, in the conversation it happened in |
| `components/WorkspaceView.queuedTurn.test.tsx` | — | the server-placement labels in the pending tail |
| `components/WorkspaceView.queuedTurnWake.test.tsx` | AS | a wake a watch queued, in the queued tail |
| `components/WorkspaceView.retryAttachments.test.tsx` | A | the card that offers to re-send the last message |
| `components/WorkspaceView.retryMessage.test.tsx` | A | the Retry button on a run that a provider outage killed |
| `components/WorkspaceView.retrySessionMessage.test.tsx` | A | the failure card’s Retry, for another session’s message |
| `components/WorkspaceView.scrollToBottom.test.tsx` | A | the jump-to-bottom button |
| `components/WorkspaceView.sessionDeepLink.test.tsx` | A | a session opened at one record |
| `components/WorkspaceView.sessionFolders.test.tsx` | AS | folders in the session list |
| `components/WorkspaceView.sessionLine.test.tsx` | — | sessionLine |
| `components/WorkspaceView.sessionMenu.test.tsx` | AS | the session row More actions menu |
| `components/WorkspaceView.sessionMessageQueue.test.tsx` | A | another session’s message, waiting in the queue |
| `components/WorkspaceView.sessionSwipe.test.tsx` | A | session row swipes on a phone |
| `components/WorkspaceView.settlementPointer.test.tsx` | A | the settlement question on the pinned line |
| `components/WorkspaceView.shareEntry.test.tsx` | AS | a shared session in the session list and its conversation |
| `components/WorkspaceView.statusGlyph.test.tsx` | — | the background-process status glyph |
| `components/WorkspaceView.stickyWake.test.tsx` | A | the sticky bar over a turn a watch queued |
| `components/WorkspaceView.streamOrder.test.tsx` | A | the live stream renders in the order it arrived |
| `components/WorkspaceView.taskRunHandoff.test.tsx` | AS | sending into a run the platform has already replaced |
| `components/WorkspaceView.watchingRow.test.tsx` | A | the session list over a session a watch will resume |
| `lib/acceptedUserTurn.test.ts` | — | an accepted user turn before its transcript event arrives |
| `lib/composerRefs.test.ts` | — | segmentComposer |
| `lib/composerSendState.test.ts` | — | composer draft after CURRENT_WORK routing |
| `lib/interruptAndSend.test.ts` | — | interruptSession |
| `lib/paneTransition.test.ts` | — | navigateWithPaneSlide |
| `lib/queuedTurnRestore.test.ts` | — | returnsToComposer |
| `lib/reseedActiveSnapshot.test.ts` | — | reseedWithActiveSnapshot |
| `lib/runRequestResend.test.ts` | — | a Run now whose answer never arrives |
| `lib/runRequestToken.test.ts` | — | the token one Run gesture draws |
| `lib/sessionCapabilities.test.ts` | — | isCompleteShortcutEligible |
| `lib/sessionDetailPolling.test.ts` | — | shouldPollSessionDetail |
| `lib/sessionLifecycleApi.test.ts` | — | canonical session lifecycle API |
| `lib/sessionProviderChoices.test.ts` | — | providerChoices |
| `lib/sessionState.test.ts` | — | sessionRunStateOf |
| `lib/sessionTurnIntent.test.ts` | — | composer default send intent |
| `lib/startingAnchor.test.ts` | — | what the waiting notice counts from |
| `lib/steerDelivery.test.ts` | — | steer delivery states |
| `lib/steerDeliveryParity.test.ts` | — | steer delivery labels, web vs OrbitKit |
| `lib/streamAnchor.test.ts` | — | streamAnchorAfter |
| `lib/tailPinning.test.ts` | — | a settled stretch of reasoning folds to its summary |
| `lib/taskRunHandoff.test.ts` | — | a message sent into a run that no longer holds the task |
| `lib/workspaceDefaults.test.ts` | — | remembered new-session models |
| `lib/workspaceOrder.test.ts` | — | orderWorkspaces |

### P6 · 根 Provider、全局兼容与退役（3 文件）

| 文件 | 耦合 | 首个可定位检查点 |
| --- | --- | --- |
| `api.test.ts` | — | getSessionEventPage |
| `lib/idCodec.test.ts` | — | encodeId |
| `nginxConf.test.ts` | — | nginx: a public share page |

## 复查方法与验证边界

1. 在实施基线或后续阶段工作树运行主 README 所列审计入口，比较 JSON/清单文件集合而不只比较总数。每次记录 `git rev-parse HEAD` 与工作区差异；上方 54→54 正说明数量相同仍会增删耦合。
2. 路由入口复查：`rg -n '<Route|path=|<Navigate|useMatch|BYPASS' src/web/src/App.tsx src/web/src/components/BootGate.tsx src/web/src/components/WorkspaceConsole.tsx`，并人工沿 TaskRoute、SharedLinkPage 和 WikiPage 分派读取。`rg` 行数不等于 Route 数。
3. 隐性耦合复查：`rg -n 'useApp|useToken|modal\.(confirm|success|info|error|warning)|resizableTextArea|RefSelectProps|afterOpenChange|getPopupContainer|popupRender|dropdownRender|querySelector|closest\(' src/web/src`，区分代码、类型、注释、测试 mock，以及 Orbit 自有 DOM；不要把所有 querySelector 当作 AntD 依赖。
4. 测试全集复查：`rg --files src/web/src | rg '\.(test|spec)\.[cm]?[jt]sx?$' | sort`。后续按阶段运行真实相关测试，例如在仓库根 `npm test -w @orbit/web -- src/components/TaskDetailPanel.test.tsx src/components/ShareModal.test.tsx src/components/TaskInputs.test.tsx --testTimeout=30000`。这里只记录入口，未执行该示例，不声称通过。
5. `.ant-*` 断言不能机械删除；用 role、label、键盘和可见结果表达同一行为；仍需 CSS/视觉契约时保留等价强度证据。Vitest 不等于 TypeScript 检查，且生产 tsconfig 排除测试文件；实际改测试的阶段须另行检查其类型。不得覆盖基线或弱化断言掩盖回归。

本次是静态依赖审计。未执行界面迁移、浏览器截图、全量业务测试或 build；这些不能由本索引推导为已通过，也不属于 P0.1 的完成主张。
