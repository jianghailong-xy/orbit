#!/usr/bin/env python3
"""Build a dated delta record of the P0.1 antd inventory from an audit of the project tip.

usage: build-record.py CURRENT.json YYYY-MM-DD > YYYY-MM-DD.json

CURRENT.json is `node src/web/scripts/audit-antd.mjs --json` run on the tip being recorded, in a
checkout whose git history reaches the P0.1 baseline. The P0.1 inventory (audit-baseline.json,
ownership.json, css-ownership.json, routes-and-tests.md) is read and never written. The facts --
which use points are new, changed or gone since P0.1, their antd imports and hit kinds, the commit
that added each use line and whether that commit came from main or from this project's own line --
are computed here. Owners and reasons are the hand decisions in the tables below; the script stops
when a use point that needs one has none, so the record cannot silently leave a point unowned.
"""
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parent
ROOT = EVIDENCE.parents[2]
P01 = '1068a14b899911838526111b6814394e99762aaf'
# Parent of c21022ed1, the P0.1 delivery: every project-line commit comes after it.
PROJECT_START = 'ac7939eff27f2cb47b29d98f9842e6fec6c28367'
CSS = 'src/web/src/index.css'
SKIP = {CSS, 'src/web/package.json', 'package-lock.json'}
# A file is an antd use point when it imports antd (or the v5 patch) or has one of these hit kinds;
# the same rule `audit-antd.mjs --check-owners` applies. index.css is judged per line, on the two
# kinds css-ownership.json covers. The candidate kinds only matter beside a use; alone they were
# reviewed by hand (reviewedNotUse below).
USE = ('antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch')
CSS_KINDS = ('antd-reference', 'ant-class')
CANDIDATE = ('provider', 'theme', 'imperative-confirm', 'imperative-feedback', 'ref-focus')
C = 'src/web/src/components/'
P = 'src/web/src/pages/'

BATCHES = {
    'P4.1': ['34Za39Do3N6tkmIMP0GBP', '登录、初始化、个人资料、设置'],
    'P4.2': ['34Za39Feocgj42rrBYwzl', 'Provider、Runner、账号池、用户管理'],
    'P4.3a': ['34Za39GvWRQ08ZmKOpFNe', '任务与项目的列表、详情页和工具栏（含其中的状态、调度、分享入口组件）'],
    'P4.3b': ['34blYpxEcHMAf4oafuC2W', '任务/项目依赖图与业务决策、审阅、结算、确认类卡片'],
    'P4.4': ['34Za39J4QY3kDa5p2Wsau', 'Wiki、共享链接和公开只读页面，以及其余非会话入口'],
    'P5.1': ['34Za39L1H6V82d2sobzPY', '会话导航、搜索、输出与选择控件'],
    'P5.2': ['34Za39Mm04q5p66pqUTtj', '消息图片预览与富内容（Transcript）'],
    'P5.3': ['34Za39Ov1yysHZaYL6wgJ', '会话工作区完整迁移（WorkspaceView）'],
    'P6': ['34Za39RS6A28G7xPqMD0p', 'AntD 运行时、Provider、主题与遗留说明退役'],
}
# Owners that can no longer close a use point. A P0.1 owner in this list must be reassigned here.
INACTIVE = {
    **{phase: 'DONE' for phase in ('P1', 'P1.1', 'P1.2', 'P2', 'P2.1', 'P2.2', 'P2.3', 'P3.1', 'P3.2', 'P3.3')},
    'P4.3': '2026-10-07 拆成 P4.3a（34Za39GvWRQ08ZmKOpFNe）与 P4.3b（34blYpxEcHMAf4oafuC2W）',
}

PENDING = {
    'ProjectBlockers': {
        'candidates': ['P4.3a', 'P4.3b'], 'recommendation': 'P4.3a',
        'question': '项目阻塞区块在 ProjectsPage 详情页渲染（P4.3a），也嵌在 ProjectPromotionCard 晋升确认卡里（P4.3b），并带“解决说明”表单；按详情页区块归 P4.3a、由 P4.3b 复核卡内集成，还是随决策卡归 P4.3b？'},
    'ProjectProgressStatus': {
        'candidates': ['P4.3a', 'P4.3b'], 'recommendation': 'P4.3a',
        'question': '项目进度状态（仍欠事项、预算、异常/修复表单）在 ProjectsPage、ProjectCoordinatorCard（P4.3a）、ProjectPromotionCard（P4.3b）和 WorkspaceView（P5.3）里都渲染；按项目详情区块归 P4.3a，还是随决策卡归 P4.3b？'},
    'ProjectCrossingsCard': {
        'candidates': ['P4.3a', 'P4.3b'], 'recommendation': 'P4.3b',
        'question': '跨项目依赖卡带批准/拒绝确认（决策类，P4.3b），但渲染在 ProjectsPage 详情页和 TaskAttributionCard 里（P4.3a 的页面）；按决策功能归 P4.3b，还是按所在页面归 P4.3a？'},
    'TaskDependencyList': {
        'candidates': ['P4.3a', 'P4.3b'], 'recommendation': 'P4.3a',
        'question': '任务依赖列表（链接、状态、移除确认）在 TaskDetailPanel 的依赖视图里与依赖图切换显示；它不是图，按任务详情归 P4.3a，还是随依赖主题归 P4.3b？'},
}

# Production and test files: new since P0.1, changed since P0.1, or a P0.1 entry whose owner is inactive.
# path -> (owner, reason, extra). owner None means PENDING[extra['pending']].
FILES = {
    # main d233a6cd0: personal access tokens
    C + 'AccessTokenTable.tsx': ('P4.1', '令牌表（Table、Tag、Popconfirm），主调用方是设置下的 /settings/access-tokens（P4.1），AdminUsersPage（P4.2）也复用；按 P0.1 AccountSelect 的先例由最先到达的调用方批次迁移、后到的批次复核。', {'reviewPhase': 'P4.2'}),
    C + 'NewAccessTokenDialog.tsx': ('P4.1', '只由 AccessTokensPage 打开的新建令牌弹窗（Modal、Input、Radio、Select、Checkbox、Alert），属设置页的表单、校验与提交。', {}),
    P + 'AccessTokensPage.tsx': ('P4.1', '/settings/access-tokens 设置页（Button、Spin）。', {}),
    P + 'AccessTokensPage.test.tsx': ('P4.1', '覆盖 AccessTokensPage 与新建令牌弹窗，.ant-* 选择器随页面迁移改为角色/标签。', {}),
    P + 'SettingsPage.accessTokens.test.tsx': ('P4.1', '设置页里的访问令牌入口测试。', {}),
    P + 'ProfilePage.revokeAccessTokens.test.tsx': ('P4.1', '个人资料页改密码时撤销令牌的测试。', {}),
    P + 'AdminUsersPage.accessTokens.test.tsx': ('P4.2', '管理员用户页里的令牌表测试，随 AdminUsersPage 归 P4.2。', {}),
    # main cf98836d4 / 558a8ba1f: sign-in
    P + 'CliLoginPage.tsx': ('P4.1', '/cli-login 在浏览器里批准 orbit login（PAT device flow）的登录类页面（Card、Descriptions、Result、Alert、Tag、Spin、Space、Button）。', {}),
    P + 'CliLoginPage.test.tsx': ('P4.1', 'CliLoginPage 的测试。', {}),
    P + 'ProfilePage.signInMethods.test.tsx': ('P4.1', '个人资料页的登录方式（Google 关联/解绑）测试。', {}),
    P + 'AdminUsersPage.signIn.test.tsx': ('P4.2', '管理员用户页的登录方式测试，随 AdminUsersPage 归 P4.2。', {}),
    P + 'SettingsPage.modelRouting.test.tsx': ('P4.1', '设置页的模型路由开关测试（main 82c7e92ff）。', {}),
    # main 0ba581f31 / c8cee9c19 / 712d324a8 / f22557aff: runners and account pools
    C + 'AccountPause.tsx': ('P4.2', 'Runner 与账号池凭据的手动暂停（Modal、Radio、InputNumber、Tag、Button），只在 RunnerEngines 与 AccountPools 里渲染。', {}),
    C + 'AccountPause.test.tsx': ('P4.2', 'AccountPause 的测试。', {}),
    C + 'RunnerEngines.test-helpers.ts': ('P4.2', 'RunnerEngines 各测试共用的 .ant-dropdown 菜单查找辅助；文件名不是 test/spec，审计记为生产，实际随 RunnerEngines 的测试迁移。', {}),
    C + 'RunnerEngines.antigravityAccounts.test.tsx': ('P4.2', 'RunnerEngines 的 Antigravity 多账号测试。', {}),
    P + 'RunnerDetailPage.antigravityAccount.test.tsx': ('P4.2', 'RunnerDetailPage 的 Antigravity 账号测试（AntApp 包裹）。', {}),
    P + 'RunnerDetailPage.selfUpdate.test.tsx': ('P4.2', 'RunnerDetailPage 的自更新测试（AntApp 包裹）。', {}),
    C + 'RunnerEngines.tsx': ('P4.2', 'P0.1 已归 P4.2；main c8cee9c19 把账号操作收进 Dropdown 溢出菜单，新增 Dropdown/MenuProps，归属不变。', {}),
    P + 'AdminUsersPage.tsx': ('P4.2', 'P0.1 已归 P4.2；main 为令牌与 Google 解绑新增 Spin，归属不变。', {}),
    P + 'ProfilePage.tsx': ('P4.1', 'P0.1 已归 P4.1；main d233a6cd0 为改密码时撤销令牌新增 Checkbox，归属不变。', {}),
    # main 6c4e0ac0e / b85473546 / 2f9cc095f: wiki
    C + 'WikiActivityPage.tsx': ('P4.4', 'WikiPage 里的 Wiki Activity 页（Button）。', {}),
    C + 'WikiActivityPage.test.tsx': ('P4.4', 'Wiki Activity 页测试。', {}),
    C + 'WikiHome.window.test.tsx': ('P4.4', '渲染 WikiPage 首页的测试（AntApp 包裹）。', {}),
    C + 'WikiHomeContent.test.tsx': ('P4.4', '渲染 WikiPage 首页内容的测试（AntApp 包裹、.ant-* 选择器）。', {}),
    # main: sessions
    C + 'QueuedUserTurn.test.tsx': ('P5.2', '渲染 Transcript 的排队消息尾部（QueuedUserTurn 由 Transcript 导出），随 Transcript 归 P5.2。', {}),
    C + 'WorkspaceView.coordinatorChat.test.tsx': ('P5.3', '渲染 WorkspaceView 的 “Chat about this” 测试（AntApp 包裹）。', {}),
    C + 'WorkspaceView.loginPool.test.tsx': ('P5.3', '渲染 WorkspaceView 输入框的登录池账号测试（AntApp 包裹）。', {}),
    C + 'WorkspaceView.taskStartWaiting.test.tsx': ('P5.3', '渲染 WorkspaceView 的 TaskStart 等待卡测试（AntApp 包裹）。', {}),
    C + 'WorkspaceView.projectSessions.test.tsx': ('P5.1', '实际渲染 SessionSearch 会话列表里的项目条目与其 .ant-dropdown 行菜单，属会话导航（P5.1）。', {}),
    C + 'WorkspaceView.sessionProjects.test.tsx': ('P5.1', '实际渲染 SessionSearch 会话列表的项目分组与筛选子菜单，属会话导航（P5.1）。', {}),
    # main 0f47238c1 / ff68293bb: project done / settlement (P4.3 split)
    C + 'ProjectSettlementCard.tsx': ('P4.3b', 'P0.1 归 P4.3；结算卡属 P4.3b；main 0f47238c1 为项目完成结算流程新增的 Input/Modal 也在卡内。', {}),
    C + 'ProjectWhyNotDoneGate.test.tsx': ('P6', '只有测试数据里的 “antd migration”（以本项目为例的固定数据名），不是 antd 依赖；组件行为随 ProjectSettlementCard 由 P4.3b 复核，退役扫描里的这处文字由 P6 改名或登记为允许的说明。', {}),
    # project line: Orbit components and their AntD comparison fixtures (P1.1–P3.2)
    C + 'ui/README.md': ('P6', 'components/ui 使用约定里与 AntD 对照、说明替代关系的文字（P1.1–P3.1 写入）；不是运行时依赖，但退役扫描会拦，P6 移除 AntD 时改写或移入证据目录。', {}),
    C + 'ui/Floating.css': ('P6', 'Orbit 浮层样式里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写或移入证据目录。', {}),
    C + 'ui/MultiSelect.tsx': ('P6', 'Orbit MultiSelect 里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写。', {}),
    C + 'ui/Select.tsx': ('P6', 'Orbit Select 里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写。', {}),
    C + 'ui/SelectEmpty.tsx': ('P6', 'Orbit Select 空状态里说明与 AntD 对齐的注释（P2.2）；P6 退役时改写。', {}),
    C + 'ui/TextControls.css': ('P6', 'Orbit 文本控件样式里说明与 AntD 对齐的注释（P1.2/P3.1）；P6 退役时改写或移入证据目录。', {}),
    C + 'ui/Textarea.tsx': ('P6', 'Orbit Textarea 里说明与 AntD 对齐的注释（P3.1）；P6 退役时改写。', {}),
    C + 'ui/boundary.test.ts': ('P6', '断言 components/ui 不导入 antd 的负向测试（P1.1）；P6 决定保留为允许的负向断言还是改写，不得为过扫描删掉有效断言。', {}),
    C + 'ui/__fixtures__/ChoicesFixture.tsx': ('P6', 'ui-migration 浏览器对照用的 AntD 参照样例（P2.2），故意导入 antd 渲染旧实现；antd 移除时须一并删除或改为只渲染 Orbit 组件。', {}),
    C + 'ui/__fixtures__/ChoicesFixture.css': ('P6', 'ChoicesFixture 的 AntD 参照样式（P2.2/P3.2），随该样例由 P6 处理。', {}),
    C + 'ui/__fixtures__/ComposerFixture.tsx': ('P6', 'ui-migration 输入框对照用的 AntD 参照样例（P3.1），含 TextArea 内部 ref；antd 移除时须一并处理。', {}),
    C + 'ui/__fixtures__/ComposerFixture.css': ('P6', 'ComposerFixture 的 AntD 参照样式（P3.1/P3.2），随该样例由 P6 处理。', {}),
    C + 'ui/__fixtures__/ControlsFixture.tsx': ('P6', 'ui-migration 基础控件对照用的 AntD 参照样例（P1.2）。', {}),
    C + 'ui/__fixtures__/ControlsFixture.css': ('P6', 'ControlsFixture 的 AntD 参照样式（P1.2），随该样例由 P6 处理。', {}),
    C + 'ui/__fixtures__/FoundationFixture.tsx': ('P6', 'ui-migration 主题基础对照用的 AntD 参照样例（P1.1）。', {}),
    C + 'ui/__fixtures__/OverlaysFixture.tsx': ('P6', 'ui-migration 弹层对照用的 AntD 参照样例（P2.1），含 useApp 与 modal.confirm。', {}),
    C + 'ui/__fixtures__/ToastsFixture.tsx': ('P6', 'ui-migration 通知对照用的 AntD 参照样例（P2.3），含 useApp 与 modal.confirm。', {}),
    # P0.1 entries changed on the project line, owner unchanged
    C + 'WorkspaceView.composerMenu.test.tsx': ('P5.3', 'P0.1 已归 P5.3；P3.1（81f15bef1）把对 textarea.ant-input 规则的源码断言改成选择器列表并加了一处说明，归属不变。', {}),
    # P0.1 entries whose phase is done but which still hold a use point
    C + 'StatusTag.tsx': ('P6', '死代码：src/web 里没有任何引用（P0.1 基线时也没有，当时的 StatusTag 只是 RunnerEngines 内的同名局部函数），P1.2 也未切换它；P6 删除该文件即关闭这处 antd Tag 导入。', {'action': 'delete'}),
    C + 'ToastViewport.tsx': ('P6', 'P2.3 已完成且按 P0.1 只保留验证；剩下的是说明替代 AntD message 的注释，P6 退役时改写或移入证据目录。', {}),
    'src/web/src/lib/toast.tsx': ('P6', '同 ToastViewport：P2.3 已完成，剩余为说明 AntD 历史的注释。', {}),
    'src/web/src/lib/toastStore.ts': ('P6', '同 ToastViewport：P2.3 已完成，剩余为说明 AntD 历史的注释。', {}),
    C + 'TaskDetailPanel.test.tsx': ('P6', 'P3.2 已关闭此测试的 .ant-* 选择器（见 p3.2/inventory-closure.json），剩一句说明 antd Tooltip 空标题行为的注释；P6 改写。', {}),
    'src/web/src/indexCss.test.ts': ('P6', 'P0.1 的 P1 测试；剩一句提到 AntD 通知规则历史的注释，P6 改写。', {}),
    'src/web/src/lib/toast.test.tsx': ('P6', 'P0.1 的 P2 测试；剩一句对比 AntD 关闭回调的注释，P6 改写。', {}),
}

# P0.1 P4.3 entries split into P4.3a / P4.3b (owner None: PENDING). Keyed by component file stem.
P43_FILES = {
    'AcceptanceConfirmationCard': ('P4.3b', '验收确认卡，业务确认类卡片。'),
    'ConfirmationReviewTurnCards': ('P4.3b', '复审请求/答复卡，审阅类卡片。'),
    'CoordinatorQuestionCard': ('P4.3b', '协调者提问卡，业务决策卡片。'),
    'CriteriaChangeCard': ('P4.3b', '验收项变更确认卡。'),
    'CriteriaDecisionCard': ('P4.3b', '验收项提案的决定卡。'),
    'DecisionRail': ('P4.3b', '待回答事项固定栏，承载各决策卡的投影。'),
    'EvidenceDecisionCard': ('P4.3b', '证据裁决卡。'),
    'OwnerConfirmationCard': ('P4.3b', '任务完成确认卡。'),
    'OwnerConfirmationReopen': ('P4.3b', '确认复审后重新打开任务的弹窗，属确认卡流程。'),
    'OwnerConfirmationReview': ('P4.3b', '确认卡的复审栏。'),
    'ProjectPromotionCard': ('P4.3b', 'Merge to main 等晋升确认卡。'),
    'StartProjectCard': ('P4.3b', '项目启动确认卡；ProjectRunSettings 只从这里引用并发上限常量。'),
    'ProjectDependencyGraph': ('P4.3b', '项目任务依赖图。'),
    'TaskDependencyGraph': ('P4.3b', '任务依赖图（TaskDetailPanel 与 ProjectDependencyGraph 渲染）。'),
    'ProjectTasksGraph': ('P4.3b', '项目页与公开项目页的任务图分区。'),
    'MentionDeliveryNotes': ('P4.3a', '任务详情评论里 @ 提及的投递说明，只由 TaskDetailPanel 渲染。'),
    'ProjectAcceptanceCard': ('P4.3a', '项目详情页的验收条目区块，只展示状态与跳转、不做决定（ProjectsPage、SharedProjectPage）。'),
    'ProjectChainProgress': ('P4.3a', '项目详情页的链式进度文字区块，不是依赖图。'),
    'ProjectCoordinatorCard': ('P4.3a', '项目详情页的协调会话卡：状态、导航和更多操作，不做业务决定。'),
    'ProjectGoalCard': ('P4.3a', '项目详情页的目标区块。'),
    'ProjectPanoramaHeader': ('P4.3a', '项目详情页头部的状态计数与操作入口。'),
    'ProjectReadyToRun': ('P4.3a', '项目详情页的手动运行/恢复/暂停调度区块。'),
    'ProjectRunSettings': ('P4.3a', '项目详情页的运行设置（调度参数）。'),
    'ProjectSections': ('P4.3a', '项目列表的生命周期分组。'),
    'ProjectShareControls': ('P4.3a', '项目页的分享入口与导出。'),
    'ProjectsToolbar': ('P4.3a', '项目列表工具栏。'),
    'TaskAttributionCard': ('P4.3a', '任务详情里的归属/来源区块（TaskDetailPanel 渲染），不是决策卡。'),
    'TaskScheduleEditor': ('P4.3a', '任务详情的开始时间调度编辑。'),
    'ProjectsPage': ('P4.3a', '项目列表与项目详情页。'),
    'TaskDetailPage': ('P4.3a', '任务详情页。'),
    'TaskListView': ('P4.3a', '任务列表。'),
    'TaskRoute': ('P4.3a', '任务路由与加载。'),
    'ProjectBlockers': (None, 'ProjectBlockers'),
    'ProjectProgressStatus': (None, 'ProjectProgressStatus'),
    'ProjectCrossingsCard': (None, 'ProjectCrossingsCard'),
    'TaskDependencyList': (None, 'TaskDependencyList'),
}
# KEEP entries reviewed by P4.3 in P0.1: no use point, only their review batch is split.
P43_REVIEW = {
    'BatchGraph': ('P4.3b', 'Transcript 与 ApprovalPanel 里的批次图。'),
    'CardAction': ('P4.3b', '决策卡共用的操作按钮。'),
    'CardHotkey': ('P4.3b', '决策卡共用的快捷键归属。'),
    'OpenItemDeliveryCard': ('P4.3b', 'Transcript 里的协调异常卡。'),
    'ProjectStartedCard': ('P4.3b', 'Transcript 里的项目启动回执卡。'),
    'RunSettingsSummary': ('P4.3b', '只由 ProjectStartedCard 与 AcceptanceConfirmationCard 使用。'),
    'ProjectIntegrationLine': ('P4.3a', '项目详情页的产物去向区块。'),
    'ProjectPageBlocks': ('P4.3a', '项目详情页的区块顺序。'),
    'ProjectTaskLink': ('P4.3a', '项目页里打开任务的链接与历史语义。'),
    'ProjectTaskPanel': ('P4.3a', '项目上下文里的任务面板。'),
    'TaskProgressBlock': ('P4.3a', '任务进度块（Transcript、BackgroundShellsTray 也渲染，P5.2 复核会话内呈现）。'),
    'TaskStatusPill': ('P4.3a', '任务状态标记，列表与图共用；P4.3b 复核图内呈现。'),
}
# P0.1 P4.3 tests that hold a use point at the tip, by the component they render.
P43_TESTS = {
    C + 'ProjectAcceptanceCard.test.tsx': 'ProjectAcceptanceCard',
    C + 'ProjectBlockers.test.tsx': 'ProjectBlockers',
    C + 'ProjectCoordinatorCard.test.tsx': 'ProjectCoordinatorCard',
    C + 'ProjectPanoramaHeader.test.tsx': 'ProjectPanoramaHeader',
    C + 'ProjectProgressStatus.test.tsx': 'ProjectProgressStatus',
    C + 'ProjectReadyToRun.test.tsx': 'ProjectReadyToRun',
    C + 'ProjectSections.test.tsx': 'ProjectSections',
    C + 'ProjectShareControls.test.tsx': 'ProjectShareControls',
    C + 'ProjectTasksGraph.test.tsx': 'ProjectTasksGraph',
    C + 'TaskScheduleEditor.test.tsx': 'TaskScheduleEditor',
    P + 'ProjectCoordinatorSection.test.tsx': 'ProjectsPage',
    P + 'ProjectDetailPanorama.test.tsx': 'ProjectsPage',
    P + 'ProjectTasksTopology.test.tsx': 'ProjectsPage',
    P + 'ProjectsPage.delete.test.tsx': 'ProjectsPage',
    P + 'ProjectsPage.newTask.test.tsx': 'ProjectsPage',
    P + 'ProjectsPage.status.test.tsx': 'ProjectsPage',
    P + 'ProjectsPage.test.tsx': 'ProjectsPage',
    P + 'ProjectsPagePhone.test.tsx': 'ProjectsPage',
    P + 'ProjectsPageToolbar.test.tsx': 'ProjectsToolbar',
    P + 'TaskListView.createdIn.test.tsx': 'TaskListView',
    P + 'TaskListView.outsideProjects.test.tsx': 'TaskListView',
    P + 'TaskListView.scopeMenu.test.tsx': 'TaskListView',
    P + 'TaskListView.taskUrl.test.tsx': 'TaskListView',
    P + 'TaskListView.test.tsx': 'TaskListView',
    P + 'TaskRoute.test.tsx': 'TaskRoute',
}

# index.css lines whose text is new or changed since P0.1: (pattern on the hit text, owner, reason).
CSS_NEW = [
    (r'^\.composer-(?:field|box)', 'P5.3', 'P3.1（81f15bef1）把输入框 textarea.ant-input 规则改成选择器列表、加上 Orbit Textarea；.ant-input 部分仍服务现有 AntD 输入框，按 P0.1 区段「WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）」由 P5.3 清理。'),
    (r'^\.project-done-', 'P4.3b', 'main 0f47238c1 项目完成结算流程里 ProjectSettlementCard 的 Input/Modal 覆盖样式，随结算卡归 P4.3b。'),
    (r'^/\* The Reopen question replaced an AntD Modal', 'P6', 'P3.2（5311a0cf7）为 .tdp-reopen-dialog 写的、说明与被替换的 AntD Modal 行高一致的注释；不是依赖，P6 退役时改写或移入证据目录。'),
    (r'^/\* Unitless line height, as the AntD Modal', 'P6', 'P3.2（5311a0cf7）为 .share-dialog 写的同类注释；P6 退役时改写或移入证据目录。'),
    (r'^\.re-(?:runner-status|runner-card)', 'P4.2', 'RunnerEngines 卡头运行状态与账号行里 Tag 的覆盖样式（main 重画卡头、收拢账号操作时加入），随 RunnerEngines 归 P4.2。'),
    (r'^\.re-(?:action|account-menu)', 'P4.2', 'main c8cee9c19 RunnerEngines 账号溢出菜单（Dropdown）与操作按钮的覆盖样式，随 RunnerEngines 归 P4.2。'),
    (r'^(?:/\* A card drawn without AntD|the AntD Card it sits beside)', 'P4.1', 'main 558a8ba1f 为个人资料页 .orbit-card 写的注释，以旁边的 AntD Card 为对照；P4.1 迁移资料页 Card 时一并改写。'),
    (r'^\.access-token-field', 'P4.1', 'main d233a6cd0 NewAccessTokenDialog 里 Radio.Group 的覆盖样式，随该弹窗归 P4.1。'),
    (r'^\.wk-activity-btn', 'P4.4', 'main 6c4e0ac0e WikiPage 头部 Activity 按钮的 Button 覆盖样式，归 P4.4。'),
    (r'^\.account-pause-durations', 'P4.2', 'main 0ba581f31 AccountPause 里 Radio.Button 的覆盖样式，随 AccountPause 归 P4.2。'),
]
# index.css lines of the P0.1 P4.3 groups that are still present, split by selector prefix.
CSS_P43 = [
    (r'tasks-scope-menu|^/\* Qualified by antd', 'P4.3a', 'TaskListView 范围菜单。'),
    (r'seg-count', 'P4.3a', 'TaskListView 过滤分段的计数。'),
    (r'^\.start-card-', 'P4.3b', 'StartProjectCard 执行模式单选；与 .project-run-* 同一条规则，各批只删自己的选择器。'),
    (r'^/\* The two lines, one under the other|^`\.ant-radio-group`', 'P4.3b', 'StartProjectCard 与 ProjectRunSettings 共用的单选规则说明，记在启动卡（P4.3b）；先完成的一批只删自己的选择器，说明由后完成的一批删除并写入关闭记录。'),
    (r'^\.project-run-settings', 'P4.3a', 'ProjectRunSettings 执行模式单选与 merge check 字段。'),
    (r'pdg-|tdg-', 'P4.3b', '项目/任务依赖图的标题与全屏弹窗。'),
    (r'project-detail-meta|project-goal-|project-ready-|project-task-row|task row has flexible copy|under \.ant-list to outrank', 'P4.3a', '项目详情页的元信息、目标、待运行区块和任务行。'),
    (r'acceptance-', 'P4.3a', 'ProjectAcceptanceCard 验收条目区块。'),
    (r'projects-toolbar-filter|projects-redesign\.html|antd 5 → 6', 'P4.3a', 'ProjectsToolbar 分段过滤。'),
    (r'watch-row-list', 'P4.3a', 'WatchRelations 浮层（TaskDetailPanel）。'),
    (r'project-blockers-', None, 'ProjectBlockers'),
]
# Files whose only changed hits are candidate kinds, checked by hand.
REVIEWED = {
    C + 'DshRunnerStatus.tsx': 'message 来自 Orbit useToast()（lib/toast），不是 antd。',
    C + 'SignInMethodsCard.tsx': 'message 来自 Orbit useToast()；卡片用自有 .orbit-card，不导入 antd。',
    P + 'AdminSignInPage.tsx': 'message 来自 Orbit useToast()，不导入 antd。',
    C + 'WorkspaceView.tsx': 'main 新增的 message.info/warning/error 与一处 ref.focus 都来自 Orbit useToast() 和原生 textarea ref；P0.1 归属 P5.3 不变。',
    P + 'RunnerDetailPage.tsx': 'main f22557aff 新增的 message.success/error 来自 Orbit useToast()；P0.1 归属 P4.2 不变。',
}


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True, errors='replace')


def is_ancestor(a, b):
    return subprocess.run(['git', '-C', str(ROOT), 'merge-base', '--is-ancestor', a, b]).returncode == 0


def parents(commit):
    return git('rev-list', '--parents', '-n1', commit).split()[1:]


def subject(commit):
    return git('log', '-1', '--format=%s', commit).strip()


MAINISH = re.compile(r"^Merge (?:remote-tracking branch )?'?(?:refs/(?:heads|remotes)/)?(?:origin/)?main'?(?: into|$)|^Merge commit '[0-9a-f]+'")


def project_line(tip):
    """Commits this project's own work introduced. Main commits came in through "Merge refs/heads/main
    into refs/heads/project/..." or through a main merge inside a landed task branch."""
    own = set()
    for merge in git('rev-list', '--first-parent', tip, '--not', PROJECT_START).split():
        ps = parents(merge)
        if len(ps) == 1:
            own.add(merge)
            continue
        if subject(merge).startswith('Merge refs/heads/main into refs/heads/project/'):
            continue
        own.add(merge)
        intro = git('rev-list', ps[1], '--not', ps[0]).split()
        from_main = set()
        for commit in intro:
            cps = parents(commit)
            if len(cps) > 1 and not is_ancestor(cps[1], ps[0]) and MAINISH.match(subject(commit)):
                from_main |= set(git('rev-list', cps[1], '--not', ps[0]).split())
        own |= set(intro) - from_main
    return own


def main():
    current = json.load(open(sys.argv[1]))
    tip = current['baseline']['commit']
    baseline = json.load(open(EVIDENCE / 'audit-baseline.json'))
    ownership = json.load(open(EVIDENCE / 'ownership.json'))['files']
    css_groups = json.load(open(EVIDENCE / 'css-ownership.json'))['groups']
    closure_p32 = json.load(open(EVIDENCE / 'p3.2/inventory-closure.json'))

    def closure_record(by):
        """The batch closure record that covers a closing commit: P3.2 kept one for before..after."""
        before, after = closure_p32['before']['commit'], closure_p32['after']['commit']
        if any(is_ancestor(i['commit'], after) and not is_ancestor(i['commit'], before) for i in by):
            return 'p3.2/inventory-closure.json'
        return None
    test_phase, phase = {}, None
    for line in open(EVIDENCE / 'routes-and-tests.md'):
        if m := re.match(r'^### (P[\d.]+) ', line):
            phase = m.group(1)
        if (m := re.match(r'^\| `([^`]+\.(?:test|spec)\.[^`]+)` \|', line)) and phase:
            test_phase['src/web/src/' + m.group(1)] = phase
    own_line = project_line(tip)
    cache = {}

    def commit_info(commit):
        if commit not in cache:
            short, date, subj = git('log', '-1', '--format=%h%x00%ad%x00%s', '--date=short', commit).strip().split('\0')
            cache[commit] = {'commit': commit, 'short': short, 'date': date, 'subject': subj,
                             'line': 'project' if commit in own_line else 'main'}
        return cache[commit]

    blames = {}

    def blame(path):
        if path not in blames:
            lines, commit = {}, None
            for row in git('blame', '--line-porcelain', tip, '--', path).splitlines():
                if m := re.match(r'^([0-9a-f]{40}) \d+ (\d+)', row):
                    commit, number = m.group(1), int(m.group(2))
                elif row.startswith('\t'):
                    lines[number] = commit
            blames[path] = lines
        return blames[path]

    def after_p01(commit):
        return not is_ancestor(commit, P01)

    def removed_by(path, text):
        commits = git('log', '--format=%H', '-S', text, f'{P01}..{tip}', '--', path).split()
        return [commit_info(c) for c in reversed(commits)]

    def symbols(f):
        out = set()
        for item in f['imports']:
            if item['family'] in ('antd', 'react19-patch'):
                out |= {b['imported'] for b in item['bindings']} or {f"{item['kind']}:{item['module']}"}
        return out

    def kinds(f, which):
        return Counter(h['kind'] for h in f['hits'] if h['kind'] in which)

    def is_use(f):
        return bool(symbols(f)) or bool(kinds(f, USE))

    def types(f):
        out = set()
        if symbols(f):
            out.add('antd-import')
        for h in f['hits']:
            k = h['kind']
            if k == 'antd-reference' and not re.search(r"""['"`]antd(?:/[^'"`]*)?['"`]""", h['text']):
                out.add('antd-text')
            elif k == 'ant-selector':
                out.add('ant-selector')
            elif k == 'ant-class' and not re.search(r'\.ant-', h['text']):
                out.add('ant-class')
            elif k in ('provider', 'use-app', 'use-token', 'theme', 'internal-ref', 'react19-patch'):
                out.add({'provider': 'antd-provider', 'use-app': 'antd-use-app', 'use-token': 'antd-theme',
                         'theme': 'antd-theme'}.get(k, k))
            elif k == 'imperative-confirm' and kinds(f, ('use-app',)):
                out.add('antd-imperative')
        return sorted(out)

    def stem(path):
        return path.rsplit('/', 1)[-1].split('.')[0]

    bf = {f['path']: f for f in baseline['files']}
    cf = {f['path']: f for f in current['files']}
    files, closed, reviewed, review_phases, missing = {}, [], [], {}, []

    def facts(f):
        return {'category': f['category'], 'types': types(f), 'antdImports': sorted(symbols(f)),
                'hitKinds': dict(sorted(kinds(f, USE + CANDIDATE).items()))}

    def decide(path, status, extra_facts):
        if path in FILES:
            owner, reason, extra = FILES[path]
        elif stem(path) in P43_FILES and ownership.get(path, {}).get('phase') == 'P4.3':
            owner, reason = P43_FILES[stem(path)]
            extra = {'pending': reason} if owner is None else {}
            reason = None if owner is None else reason
        elif path in P43_TESTS:
            owner, reason = P43_FILES[P43_TESTS[path]]
            extra = {'pending': reason} if owner is None else {}
            reason = None if owner is None else f'渲染 {P43_TESTS[path]}，随其批次。' + reason
        else:
            missing.append(path)
            return
        entry = {'status': status, **extra_facts,
                 'p01Owner': ownership.get(path, {}).get('phase') or test_phase.get(path)}
        if extra.get('pending'):
            entry.update(owner=None, pending=PENDING[extra['pending']])
        else:
            entry.update(owner=owner, reason=reason, **{k: v for k, v in extra.items()})
        files[path] = entry

    for path in sorted(set(bf) | set(cf)):
        if path in SKIP:
            continue
        b, c = bf.get(path), cf.get(path)
        sb = (symbols(b), kinds(b, USE)) if b else (set(), Counter())
        sc = (symbols(c), kinds(c, USE)) if c else (set(), Counter())
        grew = sorted(sc[0] - sb[0]) + sorted(k for k in sc[1] if sc[1][k] > sb[1].get(k, 0))
        cb, cc = (kinds(b, CANDIDATE) if b else Counter()), (kinds(c, CANDIDATE) if c else Counter())
        if c and not grew and any(cc[k] > cb.get(k, 0) for k in cc) and path not in FILES:
            # Only candidate hits grew: a hand review says whether they are antd at all.
            if path in REVIEWED:
                reviewed.append({'path': path, 'hitKinds': dict(sorted(cc.items())),
                                 'p01Owner': ownership.get(path, {}).get('phase') or test_phase.get(path),
                                 'note': REVIEWED[path]})
            else:
                missing.append(f'{path} (candidate hits only)')
        if c and is_use(c):
            if not b or grew:
                added = []
                lines = blame(path)
                for n in sorted({h['line'] for h in c['hits'] if h['kind'] in USE + CANDIDATE}
                                | {i['line'] for i in c['imports'] if i['family'] in ('antd', 'react19-patch')}):
                    if after_p01(lines[n]):
                        added.append(lines[n])
                if not b:
                    added.insert(0, git('log', '--diff-filter=A', '--format=%H', tip, '--', path).split()[-1])
                seen = []
                for commit in added:
                    if commit not in seen:
                        seen.append(commit)
                infos = sorted((commit_info(x) for x in seen), key=lambda i: (i['date'], i['short']))
                extra_facts = facts(c)
                if b:
                    extra_facts['added'] = {'antdImports': sorted(sc[0] - sb[0]),
                                            'hitKinds': {k: sc[1][k] - sb[1].get(k, 0) for k in sorted(sc[1]) if sc[1][k] > sb[1].get(k, 0)}}
                extra_facts['introducedBy'] = infos
                decide(path, 'new' if not b else 'changed', extra_facts)
            else:
                p01 = ownership.get(path, {}).get('phase') or test_phase.get(path)
                if p01 is None or p01.split('→')[-1].strip() in INACTIVE:
                    decide(path, 'reassigned', facts(c))
                elif path in FILES:
                    decide(path, 'changed', facts(c))
        if b and is_use(b):
            gone_syms = sorted(sb[0] - sc[0])
            gone_kinds = {k: sb[1][k] - sc[1].get(k, 0) for k in sorted(sb[1]) if sb[1][k] > sc[1].get(k, 0)}
            if gone_syms or gone_kinds:
                texts = Counter(h['text'] for h in b['hits'] if h['kind'] in USE) - Counter(h['text'] for h in (c['hits'] if c else []) if h['kind'] in USE)
                by = []
                for text in texts:
                    for info in removed_by(path, text):
                        if info not in by:
                            by.append(info)
                by = sorted(by, key=lambda i: (i['date'], i['short']))
                record = closure_record(by) if path in closure_p32['files'] else None
                closed.append({'path': path, 'category': b['category'],
                               'p01Owner': ownership.get(path, {}).get('phase') or test_phase.get(path),
                               'closed': {'antdImports': gone_syms, 'hitKinds': gone_kinds},
                               'remaining': None if not c else {'antdImports': sorted(sc[0]), 'hitKinds': dict(sorted(sc[1].items()))},
                               'closedBy': by, 'closureRecord': record})

    for path, o in sorted(ownership.items()):
        if o['phase'] == 'KEEP' and o.get('reviewPhase') == 'P4.3':
            if stem(path) not in P43_REVIEW:
                missing.append(path)
                continue
            review_phases[path] = {'p01ReviewPhase': 'P4.3', 'reviewPhase': P43_REVIEW[stem(path)][0], 'reason': P43_REVIEW[stem(path)][1]}
        elif o['phase'] == 'P4.3' and path not in files and path in cf and not is_use(cf[path]):
            pass  # closed P4.3 entries stay in `closed`

    # index.css, line by line on the kinds css-ownership.json covers.
    def group(line):
        return next((g for g in css_groups if g['from'] <= line <= g['to']), None)

    base_hits = [h for h in bf[CSS]['hits'] if h['kind'] in CSS_KINDS]
    tip_hits = [h for h in cf[CSS]['hits'] if h['kind'] in CSS_KINDS]
    base_count = Counter((h['kind'], h['text']) for h in base_hits)
    tip_count = Counter((h['kind'], h['text']) for h in tip_hits)
    css = []
    lines = blame(CSS)
    for (kind, text), n in sorted((tip_count - base_count).items(), key=lambda kv: min(h['line'] for h in tip_hits if (h['kind'], h['text']) == kv[0])):
        at = [h['line'] for h in tip_hits if (h['kind'], h['text']) == (kind, text)]
        fresh = [line for line in at if after_p01(lines[line])][-n:] or at[-n:]
        rule = next((r for r in CSS_NEW if re.search(r[0], text)), None)
        if rule is None:
            missing.append(f'{CSS}: {text}')
            continue
        changed = rule[1] == 'P5.3'
        css.append({'path': CSS, 'kind': kind, 'text': text, 'count': n, 'lines': fresh,
                    'status': 'changed' if changed else 'new',
                    'type': 'antd-text' if kind == 'antd-reference' else 'css-override',
                    'introducedBy': sorted((commit_info(x) for x in dict.fromkeys(lines[y] for y in fresh)), key=lambda i: (i['date'], i['short'])),
                    'p01Group': 'WorkspaceView 输入框试点与完整切换（P3.1 → P5.3）' if changed else None,
                    'owner': rule[1], 'reason': rule[2]})
    def selector(text):
        return re.sub(r'\s*[{,]\s*$', '', text)

    for (kind, text), n in sorted((base_count - tip_count).items(), key=lambda kv: min(h['line'] for h in base_hits if (h['kind'], h['text']) == kv[0])):
        first = min(h['line'] for h in base_hits if (h['kind'], h['text']) == (kind, text))
        g = group(first)
        entry = {'path': CSS, 'kind': kind, 'text': text, 'count': n, 'p01Line': first,
                 'p01Group': f"{g['owner']}（{g['phase']}）" if g else None}
        # A selector that survives with another ending was rewritten (P3.1 turned rules into
        # selector lists); only a selector that is gone is closed, by whoever dropped it.
        kept = sorted({h['text'] for h in tip_hits if h['kind'] == kind and selector(h['text']) == selector(text)})
        if kept:
            entry.update(disposition='rewritten', rewrittenAs=kept, closedBy=removed_by(CSS, text))
        else:
            entry.update(disposition='removed', closedBy=removed_by(CSS, selector(text)) or removed_by(CSS, text))
        entry['closureRecord'] = closure_record(entry['closedBy'])
        closed.append(entry)
    for (kind, text), n in sorted(base_count.items(), key=lambda kv: min(h['line'] for h in base_hits if (h['kind'], h['text']) == kv[0])):
        first = min(h['line'] for h in base_hits if (h['kind'], h['text']) == (kind, text))
        g = group(first)
        if not g or g['phase'] != 'P4.3' or not tip_count[(kind, text)]:
            continue
        rule = next((r for r in CSS_P43 if re.search(r[0], text)), None)
        if rule is None:
            missing.append(f'{CSS} P4.3: {text}')
            continue
        entry = {'path': CSS, 'kind': kind, 'text': text, 'count': min(n, tip_count[(kind, text)]),
                 'lines': [h['line'] for h in tip_hits if (h['kind'], h['text']) == (kind, text)],
                 'status': 'reassigned', 'type': 'antd-text' if kind == 'antd-reference' else 'css-override',
                 'p01Group': f"{g['owner']}（{g['phase']}）"}
        if rule[1] is None:
            entry.update(owner=None, pending=PENDING[rule[2]])
        else:
            entry.update(owner=rule[1], reason=rule[2])
        css.append(entry)

    if missing:
        sys.exit('No decision for:\n  ' + '\n  '.join(missing))

    pending = [{'subject': name, **PENDING[name],
                'files': sorted(p for p, e in files.items() if e.get('pending') is PENDING[name]),
                'cssLines': sorted({x for e in css if e.get('pending') is PENDING[name] for x in e['lines']})}
               for name in PENDING]
    owners = Counter(e['owner'] or 'PENDING' for e in files.values()) + Counter(e['owner'] or 'PENDING' for e in css)
    record = {
        'schemaVersion': 1,
        'kind': 'antd-inventory-delta',
        'date': sys.argv[2],
        'task': '34bkjldwhL7rVdYPgWBwz',
        'p01': {'commit': baseline['baseline']['commit'], 'scopeHash': baseline['baseline']['scopeHash'],
                'readOnly': ['audit-baseline.json', 'ownership.json', 'css-ownership.json', 'routes-and-tests.md', 'component-contracts.md']},
        'scan': {'commit': tip, 'scopeHash': current['baseline']['scopeHash'], 'command': 'node src/web/scripts/audit-antd.mjs --json',
                 'counts': current['counts']},
        'rule': {
            'useFile': '生产或测试文件导入 antd（或 v5 patch），或含以下任一命中：' + '、'.join(USE),
            'useCss': f'{CSS} 按行判定，只看 ' + '、'.join(CSS_KINDS) + '（与 css-ownership.json 相同），按命中原文对照，不用行号',
            'candidates': '、'.join(CANDIDATE) + ' 只在文件已是使用点时随文件归属；单独出现的已人工复核，见 reviewedNotUse',
            'icons': '@ant-design/icons 与 .anticon 按项目约定保留，不是使用点',
        },
        'batches': BATCHES,
        'inactiveOwners': INACTIVE,
        'files': files,
        'css': css,
        'reviewPhases': review_phases,
        'closed': closed,
        'reviewedNotUse': reviewed,
        'forCoordinator': pending,
        'summary': {
            'files': dict(Counter(e['status'] for e in files.values())),
            'cssLines': dict(Counter(e['status'] for e in css)),
            'owners': dict(sorted(owners.items())),
            'closed': len(closed),
            'pendingSubjects': len(pending),
        },
    }
    json.dump(record, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == '__main__':
    main()
