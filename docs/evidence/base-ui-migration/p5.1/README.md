# P5.1 会话导航、搜索、输出与选择控件

服务于 [P5.1 迁移会话导航、搜索、输出与选择控件](orbit-task:34Za39L1H6V82d2sobzPY)，项目验收条目 key `4Un2KxG0vLBv3dXWCfnqwK`：**P5：会话工作区完成迁移，输入、附件、富内容、消息操作及滚动导航行为无迁移回归。** 本任务承担其子范围：会话导航、搜索、输出和相关选择操作保持原语义；明暗/响应式、焦点与返回路径符合基线，本任务范围内 AntD 耦合已清除。

**结论**：P5.1 的 7 个生产文件不再导入 antd，6 个测试不再导入 antd、按 `.ant-*` 类名定位或在注释里提它，index.css 本批的 15 处改写到 Orbit 类名上；在交付上 `--check-owners`，P5.1 从 28 个使用点降到 0，剩下的只有协调者判归 P5.3 的两个已知未归属点。分支已合入当前 main（`23bdaa967`，含项目 tip `951882866`）。同提交对照（参照 = 交付只撤回业务切换）在八个环境里，正式轮 r2（合并之后）：

- P5.1 用例交付 60 通过；参照有一例在 WebKit 暗色手机上超时，两棵树补跑都通过。trace 的语义字段（地址、主题、侧栏亮着的行、请求与请求体、菜单项、提示、浮层文字、通知、alert）496 步里只有一类差异，已交代：空的合并目标菜单仍是菜单。合并之前的 r1 另有一次参照树的浮层在 Esc 后被延迟的悬停打开又拉开（插桩复现，交付 16 次都没有）。
- 288 张截图中 109 张超出抗锯齿级，全部归类：浮层在触发器上方的纵向取整、边缘栅格化、P4.2 已接受的 Tooltip 贴边边距、一处对话框阴影。
- P0 页面矩阵（每个页面都带侧栏）在逐像素阈值下与参照一致，逐字节只有 1 张有 3 个像素的边缘差异；标准 P0 的失败与起点逐条相同，是起点已有的漂移；overlays、controls、八个环境的 choices 组件矩阵全部通过；合并检查唯一的失败是本批一个测试的时序，已在 `b51a143e3` 修正并连跑验证。
- 对照中找到的 6 处差异已在交付里修正（见[对照找到并修正的差异](#对照找到并修正的差异)）；公共组件新增五项，默认值不变。
- 焦点与返回路径按 P2–P4 已接受的约定（焦点进出弹层的位置）；合并目标菜单的键盘可达性好于被替换的控件。

没有在真机、输入法与读屏软件上验证（见[未确立的部分](#未确立的部分)）。

## 范围

开工时按复扫规则运行 `audit-antd.mjs --check-owners`（起点 `d580e572d`，项目 tip，已含当时的 origin/main `46e28aaa3`）：P5.1 负责 28 个使用点，逐点列表见 [inventory-closure.json](inventory-closure.json) 的 `before.p51`：

- 生产文件 7 个：`TasksSidePanel`（Avatar、Dropdown、Tooltip）、`SessionSearch`（Modal、Spin）、`SessionOutputs`（Drawer、Dropdown、Input、Segmented、`theme.useToken`、Tooltip、`MenuProps`）、`SessionMoveModal`（`App.useApp` 的 `modal.confirm`、Modal、Spin）、`CodexResetCredit`（Button、Modal）、`PlanUsageIndicator`（Popover）、`NewSessionProviderHero`（Popover）。
- 测试 6 个：`PlanUsageIndicator.test`（AntD `ConfigProvider`/`App` 包裹、`.ant-modal-title`）、`SessionOutputs.commitFailure.test`（`App` 包裹）、`SessionSearch.wiki.test`（一句提到 AntD Modal 的注释）、`TasksSidePanel.admin.test`（`.ant-dropdown-menu-*`）、`WorkspaceView.projectSessions.test` 与 `WorkspaceView.sessionProjects.test`（`App` 包裹，以及会话列表行菜单的 `.ant-dropdown*` 选择器；2026-10-07 记录把这两个文件归 P5.1）。
- index.css 15 行：账号菜单（`.ant-dropdown-menu.tp-account-menu` 一组）、差异抽屉（`.wt-diff-drawer .ant-drawer-body`）、合并目标菜单（`.wt-merge-menu-list.ant-dropdown-menu` 与说明 antd 主题令牌的注释）、抽屉头部最大化按钮的注释、⌘K 面板（`.ssearch-modal .ant-modal-container` 与两段注释）、新会话引擎浮层（`.np-pop .ant-popover-container`）。

另有 `AppShell`（P0.1 记 KEEP、在 P5.1 复核）：本身不导入 antd，受影响的是它挂的侧栏与 ⌘K 面板，以及手机上的抽屉菜单（打开、点遮罩关闭、导航后关闭），这些都在本批用例里走过。

范围外、本批只读不改的：会话工作区（`WorkspaceView` 及其自己的下拉菜单、`modal.confirm`、Tooltip 等，P5.3）、Transcript（P5.2），以及 `main.tsx` 的 `ConfigProvider`/`App`、`theme.ts`（P6）。`WorkspaceView.sessionFolders.test`（P5.3 的文件）里查 Move 确认框的一段随本批改为按角色定位（见[单测](#单测)），同文件里查 WorkspaceView 自己的删除文件夹确认（仍是 AntD）的一段不动。

## 跟上 origin/main

| 时间（UTC） | 基础 | 说明 |
| --- | --- | --- |
| 10-10 00:33 开工 | 项目 tip `d580e572d`（P4.4 交付），已含 origin/main `46e28aaa3` | `git rev-list origin/project..origin/main` 为 0，不需要合并；`--check-owners` 报出 main 带来的 1 个未归属点 `WorkspaceView.recapRow.test.tsx`（协调者转告：归 P5.3，由 P5.2 写记录 2026-10-10，本批不动） |
| 10-10 01:45 前后（开发对照中途） | origin/main `ab47a1c11`（34 个新提交，主要是 provider/engine 项目的 T7：会话、任务与工作区先选引擎再选 provider） | 项目 tip 不在 main 里，按规则在 tip 上合入 main，再把本批提交接在合并之后（见[提交](#提交)）。文字冲突只有 `WikiSettingsPage.tsx`（tip 是 P4.4 迁移后的 Orbit 版，main T7 改了维护 provider 列表）：解法 = tip 的文件加 main 的 3 处改动，git rerere 重放的解法与逐行核对一致。语义冲突 1 处：T7 新增的单测「offers the keys Claude Code runs, by the compatibility table …」按 AntD 类名找对话框与选项，Orbit 页面不画这些类名，合入后必然失败（合并树上复现过）；报告协调者后（请求 `34dEqXW9ewr6tEUPubUe6`，选项 0「按建议办」）改为按角色定位、断言不变，内容取协调者晋升同步 `2fcd654d8` 的同一文件（与 P5.2 的 `378b7033e` 逐字节相同）。合并后 `--check-owners` 的未归属点是协调者转告过的两个（`WorkspaceView.recapRow.test.tsx`，以及 main T7 在 index.css 新加的 `.ant-dropdown-menu-item.composer-provider-gone` 一行，归 P5.3，由 P5.2 写记录 2026-10-10b），本批不动、不写记录；P5.1 与 P4.4 都是 0 个使用点。`NewSessionProviderHero.tsx` 在本批提交接到合并之后时有一处导入行的文字冲突（main 改了 `sessionProviderChoices` 的导入，本批把 antd Popover 换成 Orbit Popover），合成两边。 |
| 10-10 03:10 前后（正式轮之前） | origin/main `57324e33a`（`ab47a1c11` 之后 12 个提交，另有合并提交；src/web 里只有 index.css 一处：开工卡片对话框的关闭键 `b4a5183e3`，P4.3b 的范围） | 按同样的解法重做同步合并：`git merge-tree` 在 `67af3f29c` 上合入 main 的新提交（无冲突），得到的树以项目 tip `d580e572d` 与 `57324e33a` 为父提交写成 `dea24d897`，取代 `67af3f29c`；本批三个提交接在它之后，逐文件 patch-id 与之前相同（29 个文件），内容没有变化。合并后 `--check-owners` 仍只报那两个已知未归属点，P5.1 为 0 个使用点（见[迁移清单](#迁移清单)）。正式轮在这之后跑。 |
| 10-10 05:05 前后（正式轮 r1 之后、交证据之前） | origin/main `23bdaa967`：main 合入了项目线（`bcf00ab95`），项目 tip `951882866`（P2 的 Select 打开即高亮第一项与对话框 Close 的悬停底色、任务列表工具栏，以及项目线自己的同步带进来的 main 问答卡片）已在 main 里 | tip 在 main 里，同步就是合入 origin/main：在本批三个提交之后 `git merge --no-ff origin/main`，得到 `a0e84233f`（父提交 `eb9438625` 与 `23bdaa967`），分支同时带着当前 main 与当前项目 tip。冲突 1 处：`src/web/ui-migration/playwright.config.mjs` 的 P0 矩阵 `testIgnore`，两边各加了一类用例（本批 `p51*`，main `tasks-toolbar*`），两项都留；index.css 与 components/ui/README.md 自动合并（不同位置）。`git show --remerge-diff a0e84233f` 只有这一处解法。合并带进本树的 web/shared 变化与本批不相交：Dialog 的 Close 只在悬停时换底色，用例不悬停它；Select 打开即高亮第一项，本批不用 Select；Transcript 的问答卡片属 P5.2 的文件。合并后 `--check-owners` 不变（两个已知未归属点，CSS 那一行移到 17921 行；P5.1 为 0）。正式轮在合并上重跑为 r2，作为本批的记录；r1 的步骤日志留在 [process/r1/](process/r1/)。 |

## 提交

本批接在同步合并 `dea24d897`（项目 tip `d580e572d` + origin/main `57324e33a`）之后：

| 提交 | 内容 |
| --- | --- |
| `dea24d897` | **merge：项目 tip 合入 origin/main `57324e33a`。** 见[跟上 origin/main](#跟上-originmain)：`WikiSettingsPage.tsx` 的文字冲突与 `WikiSettingsPage.test.tsx` 的语义冲突（协调者判定），与第一次同步 `67af3f29c` 的解法相同。 |
| `64e45915e` | **feat：公共组件。** Avatar `icon`、Menu 项的 `className`、Menu `footer`、Popover `arrow={false}` 与 `collisionPadding`（见[公共组件](#公共组件)）。`Avatar.test.tsx` 3 个、`Menu.footer.test.tsx` 8 个、`Popover.test.tsx` 2 个单测，`Floating.test.tsx` 加 2 个（留 8px、0 时贴边）；拿掉 footer 的按键保护时打字用例失败（`d: expected true to be false`），忽略 padding 时贴边用例失败（`expected 8 to be +0`），见 [checks/shared-red.txt](checks/shared-red.txt)。README 各一句。默认值不变，这个提交里没有调用方用到新属性。 |
| `62a0820f9` | **feat：业务切换。** 7 个生产文件不再导入 antd；index.css 本批规则改写到 Orbit 类名，三个对话框加入无单位行高约定，另加同提交对照找到的同参照修正（见[对照找到并修正的差异](#对照找到并修正的差异)）；测试改按角色与名称定位（见[单测](#单测)）。 |
| `eb9438625` | **test：同提交对照用例。** `p51.browser.mjs`（7 个用例 × 8 个环境）、`p51-fixtures.mjs`、`p51.config.mjs`；P0 矩阵忽略 `p51*.browser.mjs`。 |
| `a0e84233f` | **merge：合入 origin/main `23bdaa967`（已含项目 tip `951882866`）。** 见[跟上 origin/main](#跟上-originmain)：P0 矩阵 `testIgnore` 的冲突两项都留。 |
| `b51a143e3` | **test：Menu footer 的用例等第一项取得焦点。** r2 合并检查里 `Menu.footer.test.tsx` 一例因时序失败，见[对照结果](#对照结果)的合并检查一条；只改这一个测试文件。 |
| 本目录所在的提交 | **docs：本目录。** 证据、对照脚本与运行记录（报告去掉附件正文）。 |

- 撤回 `62a0820f9` 就恢复本批的 AntD 界面，同提交参照树正是这样得到的：正式轮 r2 的参照树 `72fc42d85` = 交付 `a0e84233f` 撤回 `62a0820f9`，与交付只差业务切换的 15 个文件（r1 的参照树 `ca9b895b0` 同理，它的 `src/web/src` 与 `64e45915e` 逐字节相同）。
- 落地：分支里有合并提交，并同时带着当前 main 与当前项目 tip（`23bdaa967` 含 `951882866`），落地按 MERGE 方式整体接上。

## 公共组件

用法写在 [components/ui/README.md](../../../../src/web/src/components/ui/README.md)。五项都只为本批真实用到的地方增加，默认不改变其它调用方。

| 组件 | 替换 | 说明 |
| --- | --- | --- |
| `Avatar` `icon` | `icon={<UserOutlined />}` 的 Avatar | 没有图片（或图片加载失败）时代替文字画出图标，直接放在居中的盒里、字号为头像尺寸的一半（被替换组件按 `size / 2` 设字号），`> .anticon` 外边距为 0。侧栏账号按钮与账号菜单资料行的头像用它；有照片时照常画图片。 |
| `Menu` 项 `className` | Dropdown 菜单项的 `className` | 加在菜单项自身上（含子菜单触发行），账号菜单的资料行（`tp-account-profile`，64px 高）用它。 |
| `Menu` `footer` | Dropdown 的 `dropdownRender`（合并目标菜单的分支搜索） | 菜单项之下、方向键与 typeahead 导航之外的内容：菜单项在自己的盒（`.orbit-menu-list`）里滚动，footer 固定在下方；footer 里按的键不再冒泡到菜单（Base UI 的 typeahead 会把打的字母当作跳到某项并阻止输入），只有 Esc 与 Tab 照常关闭菜单；没有菜单项时只画 footer（“No matching branches”）。 |
| `Popover` `arrow={false}` | `arrow={false}` 的 Popover | 不画箭头，与触发器的间距是 4px 而不是 12px（rc-trigger 的偏移 = 箭头宽的一半 + 4px，无箭头时只剩 4px）。新会话的引擎列表用它。 |
| `Popover` `collisionPadding`（默认 8） | Popover 的 `align.overflow.shiftX`（rc-trigger 横向避让，贴着视口边缘停下） | 浮层滑回视口时与视口边缘保留的距离，同时交给整像素偏移与 Base UI 的避让；传 0 时与被替换浮层一样贴边。手机上的 Plan usage 浮层用它（药丸在一行中间，浮层两边都放不下）；其它浮层照旧留 8px。 |

## 业务切换

查询、变更、请求体、路由与 SSE 都不变，只替换控件、菜单、确认、浮层与状态展示。

| 文件 | AntD（之前） | 现在 |
| --- | --- | --- |
| `TasksSidePanel` | Avatar（两处，`icon={<UserOutlined />}`）、Dropdown（账号菜单：资料行、Appearance 子菜单、Settings、管理员的 Admin、Log out）、Tooltip（收起侧栏的离线/运行/后台作业标记与展开行的离线标记） | Avatar（`icon`）、Menu（`popupClassName="tp-account-menu"`，资料行 `className`，`side="top" align="start"`）、Tooltip。触发按钮的 `aria-haspopup`/`aria-expanded` 由 Menu 给出；Log out 的 `onSelect` 照旧调用登出。菜单宽 280px，`min-width: 0` 去掉 Orbit 菜单默认的“不窄于触发器”：被替换下拉框的 `minOverlayWidthMatchTrigger` 只加在看不见的外层上，菜单本身仍是 280px，手机上触发器比 280px 宽。 |
| `SessionSearch` | Modal（无标题、无关闭键、无页脚、`destroyOnClose`、宽 640、`top: 88`、正文无内边距，`afterOpenChange` 聚焦输入框）、Spin | Dialog（`title={null}`、`closable={false}`、宽 640、`initialFocus` 指向输入框，关闭后卸载）、Spinner。88px 的位置写在 `.orbit-dialog-viewport:has(> .ssearch-modal)`（同 P4.3b 的全屏图），手机上加对话框自身的 8px 外边距即 96px，与被替换的 `top: 88` 加 8px 外边距相同。窗口捕获阶段的 Esc、输入框失焦即关闭（点在面板自身时焦点落到可聚焦的面板上，`relatedTarget` 不为空，不关闭）都不变，只改了两段提到 AntD 的注释。 |
| `SessionOutputs` | Drawer（全屏时从下方升起、侧栏时右侧，`extra` 放最大化/还原）、Dropdown（合并目标，`dropdownRender` 自绘面板与 8 个以上分支时的搜索框）、Input（`size="small"`、`autoFocus`、`allowClear`）、Segmented（Unified/Split）、`theme.useToken`（面板底色、圆角、阴影、搜索框上边线、空结果文字色）、Tooltip（合并冲突、合并失败、分支偏离） | Drawer（`placement`、`height="100vh"`、`width` 同前，`headerActions` 放最大化/还原）、Menu（`side="top" align="end"`、`popupClassName="wt-merge-menu"`，搜索框与空结果放在 `footer`）、Input（`allowClear` + `onClear`）、Segmented（`size="small"`，`aria-label="Diff view"`）、Tooltip。令牌改为同值的变量：搜索框上边线 `--border-subtle`（明 #eceef1、暗 #343437，即 `colorBorderSecondary`）、空结果 `--text-3`（明 #8f959e、暗 #8b9099，即 `colorTextTertiary`）；面板就是菜单自己的表面（elevated 底色、8px 圆角、弹层阴影）。 |
| `SessionMoveModal` | `App.useApp().modal.confirm`（End and Move / Move 的确认，`onOk` 不等待移动就关闭）、Modal（移动中隐藏关闭键、禁止遮罩与 Esc 关闭）、Spin | `useConfirm`（确认挂在 Move 对话框里，层级在它之上；`onConfirm` 同样立即返回，移动的进度与结果由 Move 对话框显示）、Dialog（`busy` 阻止关闭、`closable={!busy}` 移动中不画关闭键）、Spinner（`aria-hidden`，所在的进度行本身是 `role="status"`）。 |
| `CodexResetCredit` | Button（`type="primary" block`、`size="small"`）、Modal（确认：宽 440、`zIndex: 1100` 以盖过额度浮层、打开时聚焦 Cancel、关闭后由 `restoreFocus` 把焦点放回入口或状态行） | Button（`variant="primary"` 加 `width: 100%`，同 P4.x 的先例）、Dialog（`initialFocus` 指向 Cancel，`returnFocus` 是关闭时才读取的目标：确认过就是状态行，否则是还能聚焦的入口，入口不能聚焦时是浮层本身）。确认框在浮层之后挂到 body、同为 1000 层，排在后面，遮罩盖住浮层（像素核对：浮层底色在确认框打开时是 140/140/140，即白色乘 0.55）。 |
| `PlanUsageIndicator` | Popover（`trigger={['hover','click']}`、`topRight`、手机上横向避让、受控 `open \|\| confirmOpen`，按压打开时在 `afterOpenChange` 里把焦点移进面板）；面板自己是 `role="dialog" aria-label="Plan usage"` | Popover（`openOnHover`、`side="top" align="end"`、`initialFocus` 指向面板，Base UI 只在按压打开时移焦点，悬停打开不动焦点；受控逻辑不变；`collisionPadding={0}`，手机上与被替换的横向避让一样贴着屏幕边缘）。浮层本身就是以标题 “Plan usage” 命名的对话框，面板去掉了重复的 `role`/`aria-label`，仍是 `tabIndex=-1` 的焦点落点，Tab 循环与 Esc 照旧由面板处理。`useCodexResetCredit` 的回退焦点从“执行聚焦的函数”改为“返回元素的函数”，供确认框的 `returnFocus` 读取。 |
| `NewSessionProviderHero` | Popover（`trigger="click"`、`bottom`、`arrow={false}`、`overlayClassName="np-pop"`） | Popover（`title={null}`、`side="bottom"`、`arrow={false}`、`popupClassName="np-pop"`）。 |

- 悬停打开的浮层再按触发器：被替换组件（rc-trigger 的 hover+click）按下即关；Base UI 在悬停打开后 500ms 内的按下保持打开（避免“刚悬停出来就被点掉”），500ms 之后的按下照样关闭。只在这半秒内不同。
- 被替换的 Spin 本身带 `aria-busy`；⌘K 面板头部的加载点换成 Spinner（`role="status"`），本批用例按两边的类名找它。

## 层叠顺序

被替换组件的样式由 antd cssinjs 插在 `<head>` 最前，权重相同时页面规则赢；Orbit 组件的样式在 index.css 之后加载，权重相同时 Orbit 赢（`Overlay.css` 例外，在 index.css 之前）。本批改写的页面规则都带上组件类或比组件规则更高的权重：`.tp-account-menu.orbit-menu`、`.tp-account-menu .orbit-menu-item`（0,2,0，对 `.orbit-menu-item` 的 0,1,0）、`.ssearch-modal.orbit-dialog`、`.orbit-dialog-viewport:has(> .ssearch-modal)`、`.wt-diff-drawer.orbit-drawer > .orbit-overlay-body`、`.wt-merge-menu.orbit-menu`、`.np-pop.orbit-popover`。P4.3a 的静态检查 [ties.py](../p4.3a/scripts/ties.py) 在交付的 7 个本批生产文件上只列出一处（`.cu-rc-confirm-dialog.orbit-overlay` 0,2,0 对 `.orbit-overlay` 0,1,0 的行高），页面规则权重更高，没有同权重的冲突（[checks/ties.txt](checks/ties.txt)）。

## 单测

本批的测试文件改为按角色、可访问名称和页面自己的类名定位，去掉 `.ant-*` 选择器与 AntD `App`/`ConfigProvider` 包裹，断言内容不变：

- `TasksSidePanel.admin.test`：账号菜单的普通行按 `[role="menu"].tp-account-menu [role="menuitem"]`，去掉资料行（`tp-account-profile`，菜单项的 `className`）与打开子菜单的行（`aria-haspopup`）。
- `PlanUsageIndicator.test`：两个对话框按可访问名称（`aria-labelledby` 指向的文字）找；“Plan usage” 的焦点落点是其中的面板。原来断言确认框 `aria-modal="true"`：Base UI 的模态对话框不设这个属性，而是在打开期间给其外的一切加 `aria-hidden`（实时区域除外），断言改为“药丸与浮层里的入口被隐藏于辅助技术、对话框本身不被隐藏”，同一层意思。`openUsage()` 等焦点进入浮层后再继续：Base UI 在下一帧才把焦点移进按压打开的浮层，同一帧内的下一次按压（测试才做得到，人做不到）会让这次迟到的聚焦落在确认框之后，把焦点从 Cancel 拉回面板（整文件连跑 4 次失败 2 次，加等待后连跑 5 次全过）。
- `SessionOutputs.commitFailure.test`、`SessionSearch.wiki.test`：去掉 `App` 包裹；改写一句注释。
- `WorkspaceView.projectSessions.test`、`WorkspaceView.sessionProjects.test`（P5.1 的文件，测的是 WorkspaceView 自己的会话列表菜单，仍是 AntD，P5.3 迁移）：去掉 `App` 包裹（这两个文件走的路径不调用 `modal.confirm`）；“打开着的菜单”按角色与状态找——菜单项 `[role="menu"] [role="menuitem"]:not([aria-haspopup])`，子菜单行 `[aria-haspopup]`，禁用读 `aria-disabled`，分隔线读 `role="separator"`，正在关闭或已关闭的菜单（被替换的下拉框留在页面里、退场时 `pointer-events: none`）不算打开。同一组定位在 P5.3 换成 Orbit 菜单后照样成立。
- `Menu.footer.test.tsx`（本批新增）：依赖“键盘打开后焦点落在第一项”的四个用例先等到菜单项取得焦点再继续（`b51a143e3`，原因与连跑结果见[对照结果](#对照结果)的合并检查一条）。
- `WorkspaceView.sessionFolders.test`（P5.3 的文件）：Move 的确认框（本批换成 `useConfirm`）按 `role="alertdialog"` 与标题找、确认键按文字与 `orbit-button-primary` 找；同文件里 WorkspaceView 自己的删除文件夹确认仍是 AntD，那一段不动。
- 新增单测：`Avatar.test.tsx` 3 个、`Menu.footer.test.tsx` 8 个、`Popover.test.tsx` 2 个，`Floating.test.tsx` 加 2 个（手机宽度上靠右对齐、本会伸出左缘的浮层：默认留 8px，`collisionPadding` 0 时贴边）（见[提交](#提交)）。两项新行为各做了一次红跑（[checks/shared-red.txt](checks/shared-red.txt)，在开发参照树上改、跑完还原）：拿掉 footer 的按键保护，打字用例失败；`useWholePixelOffsets` 忽略 padding、固定用 8，贴边用例失败；其余 12 个照常通过。

## 对照方法

沿用 P3.1–P4.4 的同提交对照。

- **三棵树**（[scripts/make-trees.sh](scripts/make-trees.sh)）：参照树 = 交付只撤回业务切换 `62a0820f9`（本地提交、未推送），本批界面是 AntD，公共组件、P5.1 用例和其它一切与交付相同；起点树 = 交付去掉本批的那一边，跑标准 P0；交付树完整检出。正式轮 r2：交付 `a0e84233f`、参照 `72fc42d85`、起点 `23bdaa967`（origin/main，含项目 tip）。合入 main 之前的 r1：交付 `eb9438625`、参照 `ca9b895b0`、起点 `dea24d897`。
- **磁盘与内存**：三棵树、TMPDIR 与全部运行产物在 `/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1/`；每一步在独立网络命名空间、带内存上限（`MemoryMax=6G`）与调高 OOM 分数的 scope 里跑（[scripts/capped.sh](scripts/capped.sh)），开始前按 `df -BM` 看根分区，低于 2 GB 就停下报告。
- **构建与环境**：各树 `vite build` 后 `vite preview`；与 P0 相同的字体、`environment.mjs` 校验、DPR 1、en-US/UTC、固定时间与固定 REST 数据、reducedMotion=reduce；八个环境 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844。
- **比较**：[p3.2/compare_runs.py](../p3.2/compare_runs.py) 比较截图、计算样式与 trace；[p4.1/summarize.py](../p4.1/summarize.py) 分为逐字节相同 / 抗锯齿级（每个差异像素每通道 ≤2）/ 超出；[p4.2/scripts/beyond-clusters.py](../p4.2/scripts/beyond-clusters.py) 把 >2 级像素聚成区域；[trace-semantics.py](trace-semantics.py) 逐步比较 trace 的语义字段（地址、主题、侧栏里亮着的行、请求的方法/路径/请求体、通知、菜单项与禁用、提示文字、打开的浮层文字、alert，以及步骤里记录的面板行与高亮行、按钮文字、引擎卡片与列表），焦点与对话框文字另行计数；被替换浮层的盒带 `role="tooltip"`，Orbit 浮层是对话框（P2–P4 已接受的约定，计入对话框），所以“提示”只取提示，浮层不分角色按文字单列比较；重置额度的 `clientRequestId` 每次按下都新生成，按“存在”读。另列每一步的 AntD 类名普查（`antd` 字段，侧栏也算在内）。
- **P5.1 用例**（[p51.browser.mjs](../../../../src/web/ui-migration/p51.browser.mjs)、[p51-fixtures.mjs](../../../../src/web/ui-migration/p51-fixtures.mjs)）：7 个用例 × 8 个环境（收起侧栏只在桌面），覆盖 P0 只走到一部分的本批状态：
  - 侧栏：工作区行（离线、运行、后台作业、待回复）、账号菜单（资料行、Appearance 子菜单、改主题并改回、Esc、Settings 及返回、手机抽屉的打开/导航后关闭/点遮罩关闭）、有照片时的头像；收起的侧栏与三种标记的提示、展开行的离线提示、从收起侧栏打开账号菜单。
  - ⌘K：最近会话、带 Wiki 组的结果、方向键、Esc、无结果、过短查询的提示、请求进行中的加载点、Enter 打开会话及返回、点面板外关闭。
  - 工作树条：12 个分支的合并目标菜单与搜索（过滤、无匹配、Esc）、选分支只改按钮目标、按合并发请求、3 个分支的普通菜单、合并冲突/合并失败/分支偏离的提示（手机上记录按钮文字）；差异抽屉的全屏、Unified/Split、下一个文件、还原为侧栏、Esc。
  - Move：第一步、新文件夹（Esc 只取消命名）、另一个工作区的一步、确认框（取消、End and Move）、移动中的进度、完成通知。
  - Plan usage：悬停打开（焦点不动）、按压打开（焦点进入）、Tab、重置额度的确认（焦点在 Cancel、取消后回到入口）、无人应答的创建（自动重发后交给 Retry）、开始（焦点到状态行）、成功与 Dismiss、Esc 回到药丸。
  - 新会话：引擎卡片与列表、Esc、改选 Codex。

  定位器是角色、可访问名称、标签和页面自己的类名，同一份文件驱动两棵树；被画出的盒用两边的类名并列。被替换的弹层关闭后仍留在页面里（隐藏），“已关闭”一律按隐藏判断。每一步记录前先过两帧再等动画结束（被替换弹层在收到关闭的下一帧才开始退场，此前没有动画可等）；选完主题、选完分支、进 Settings、打开 Move 之后先等所有菜单关闭，差异抽屉关闭后等抽屉消失；选完主题后指针移开（开发第 2 轮里，指针停在按下的那一行时，被替换的 Appearance 子菜单在主菜单关上之后仍画着，8 个环境中 6 个记录到，另有 1 个环境的参照因此点不到下一次的选项而超时；人按完会移开指针）；End and Move 时扣住结束会话的请求，进度一步画在会话仍未结束的页面上（不扣住时页面先读到会话已结束，截图取决于时机）。
- **P0 页面矩阵**：用 P3.2 的 [p32-reference.config.mjs](../p3.2/p32-reference.config.mjs)。参照树写出截图；交付树先按 `maxDiffPixels: 0` 对参照截图比较一次，再写出自己的截图供逐张分类。侧栏出现在每个 P0 页面上，所以这一步也逐张核对了默认状态下的侧栏（含账号头像）。另外在交付树和起点树上各跑一次标准 P0 回归。

## 对照结果

正式轮 r2 是本批的记录（[runs/](runs/)；交付 `a0e84233f`，参照 `72fc42d85`，起点 `23bdaa967`；比较结果在 [compare/](compare/)）。合入 main 之前在 `eb9438625` 上跑的 r1，各步结果与 r2 一致（下面逐项注明），步骤日志与 P5.1 的分类在 [process/r1/](process/r1/)。

- **P5.1 用例**：交付 60 通过、4 跳过（收起侧栏的用例只在桌面跑）。参照 59 通过、1 失败：WebKit 暗色手机上 Plan usage 一例，等“Couldn’t confirm the reset request”30 秒未出现，失败时的页面快照里没有浮层，被替换浮层在确认之后关上了；这一例在同一环境的两棵树上补跑（[scripts/p51-rerun.sh](scripts/p51-rerun.sh)）都通过，补跑的一对按同样方法比较（[compare/p51-rerun-webkit-dark-phone-summary.json](compare/p51-rerun-webkit-dark-phone-summary.json)），计入下面的数字。r1 两棵树各 60 通过。
- **截图**：288 张中 75 张逐字节相同、104 张抗锯齿级、109 张超出（主对照比到 285 张，参照失败的那一例缺的 3 张由补跑的一对补上，都超出）。超出的全部归类（[compare/p51-classes.txt](compare/p51-classes.txt)，规则在 [scripts/classify.py](scripts/classify.py)，每类有按开发轮实测定的上限，超出上限或不在任何一类的记为“未归类”，r1、r2 都是 0）：

  | 类 | 张数 | 最大 >2 级像素数 | 是什么 |
  | --- | --- | --- | --- |
  | 浮层在触发器上方：纵向取整 | 48 | 3732 | Plan usage 浮层（悬停、按压、重置额度的确认/开始/成功/无人应答时都在画面里）与 WebKit 上空的合并目标菜单。被替换浮层以下缘对齐触发器，面板各行高度带小数，上缘落在小数像素上（实测 469.797，Orbit 取整为 470）；面板里部分行因此取整差 1px（[shots/p51-above.png](shots/p51-above.png)，整对 [chromium-light-desktop/p51-usage](shots/p51-beyond/chromium-light-desktop/)）。同 P4.4 的“卡片在编号上方：纵向取整”。补跑的一对 5 张都在这一类，超过 2 级的像素数与 r1 同一环境逐张相同。 |
  | 边缘栅格化 | 36 | 36 | 菜单圆角、图标边缘、加载点，每张至多 36 个像素超过 2 级、最大 16 级（[shots/p51-edges.png](shots/p51-edges.png)）。 |
  | Tooltip 贴边边距（P4.2 协调者已接受） | 24 | 12616 | 桌面上收起侧栏的三种标记、展开行的离线标记、合并冲突与合并失败的提示：贴着屏幕边缘时被替换的提示贴边（左缘 x=0、右缘贴边），Orbit Tooltip 留 8px，箭头指着同一处（[shots/p51-tips.png](shots/p51-tips.png)，整对 chromium-light-desktop/p51-merge-conflict-tip）。 |
  | 对话框阴影 | 1 | 5200（每像素至多 4 级） | Chromium 明亮手机上 Move 的确认框：落在页面上的阴影差至多 4 级，确认框本身与其它环境相同（[shots/p51-shadow.png](shots/p51-shadow.png)）。 |

  r1 是 74 张相同、106 张抗锯齿级、108 张超出（48、35、24、1）。r1 的 108 张里 106 张在 r2 里（含补跑的一对）同样超出，超过 2 级的像素数逐张相同；其余的差别都在边缘栅格化里：r1 另有 2 张（工作树条右缘 1 个像素、手机 Move 进度的加载点），r2 另有 3 张（⌘K 方向键图标的边缘 2 张、另一个手机环境 Move 进度的加载点）。r1 与开发第 3 轮也是这样：108 张里 106 张同一批、逐张相同。
- **trace**：60 个用例、496 步（主对照 486 步，补跑 10 步）。语义字段的差异只有一类：8 个环境的“无匹配”一步，空的合并目标菜单仍是 `role="menu"`。r1 另有一处参照树在 Esc 之后又画出 Plan usage 浮层（WebKit 明亮桌面；开发第 3 轮在 Chromium 明亮手机上也有 1 次），是被替换浮层的延迟悬停打开，r2 没有出现；两者都在[未消除的差异](#未消除的差异)里交代。焦点 148 处、对话框文字 92 处不同，都是 P2–P4 已接受的约定（焦点进出弹层的位置、浮层作为对话框），逐类见[未消除的差异](#未消除的差异)。
- **AntD 普查**：交付各步画出的 AntD 类名只剩 `ant-app`（P6）与会话工作区自己的按钮、下拉触发器、输入框与选择框（P5.3）；参照里本批的头像、下拉菜单、抽屉、模态框与确认框、浮层、分段控件、加载点与提示，交付里一个也没有（[compare/p51-trace-semantics.json](compare/p51-trace-semantics.json) 的 `antd`）。r1 相同。
- **P0 页面矩阵**：参照 101 通过、11 跳过；交付按 `maxDiffPixels: 0` 对参照截图比较 101 通过、11 跳过（P0 配置的逐像素阈值是 Playwright 默认的 0.2，这一步说明没有任何像素越过阈值，不等于逐字节相同）；交付再写出自己的截图，101 通过、11 跳过，与参照逐字节比较：252 张中 241 张相同、10 张抗锯齿级、1 张超出，是边缘栅格化且不在侧栏上（桌面暗色 639px 宽的项目页，筛选条 “All” 的圆角 3 个像素、至多 4 级）（[compare/p0-summary.json](compare/p0-summary.json)，整对在 [shots/p0-beyond/](shots/p0-beyond/)）。r1：241、9、2，那两张同样是边缘栅格化、不在侧栏上（手机暗色项目页的同一个圆角，桌面任务详情右上角 1 个像素）。
- **标准 P0**：交付与起点（`23bdaa967`，不含本批）各 28 失败、73 通过、11 跳过，失败清单逐条相同，也与 r1 的相同（会话、设置、任务三个页面的 8 个环境，加桌面 4 个环境的断点用例）；失败用例的实际截图 26 张逐字节相同，2 张（任务详情，Chromium 明亮与暗色桌面）各差 5 个与 3 个像素、每像素 1 级（[checks/p0-standard-failures.txt](checks/p0-standard-failures.txt)，两个环境的期望/实际/差异图在 [shots/p0-standard/](shots/p0-standard/)）。这是起点已有的漂移，本批没有带来新的失败，也不登记它。
- **合并检查**：r2 在交付上 `npm run build -w @orbit/web && npm run test -w @orbit/web` 393 个文件里 1 个失败，是本批的 `Menu.footer.test.tsx`（主机负载 36）：Base UI 在菜单打开后的下一帧才把焦点移到第一项，晚于 footer 输入框的 `autoFocus`，用例只等固定的 4 个时钟就把焦点放进输入框，负载高时迟到的聚焦把打的字交给了菜单项。单独连跑：修正前合并后在任务工作树 15 次失败 7 次（键盘打开那一例的“第一项有焦点”同样在抢），合并前 15 次全过（被测组件合并前后相同）；`b51a143e3` 让依赖这次聚焦的四个用例先等到菜单项取得焦点（至多 2 秒），之后连跑 30 次全过，拿掉 footer 的按键保护时打字用例照样失败（[checks/menu-footer-loops.txt](checks/menu-footer-loops.txt)、[checks/footer-red-after-fix.txt](checks/footer-red-after-fix.txt)）。其余 5131 个测试通过。r1 在 `eb9438625` 上 391 个文件、5107 个测试全部通过。`b51a143e3` 只改这一个测试文件，r2 的浏览器各步不受影响。
- **组件矩阵**（交付）：overlays 184 通过、controls 32 通过、choices 八个环境各 97 通过（比 r1 多的是 main 带来的 Close 悬停与 Select 第一项用例；r1 为 176、32、85）。
- **最终提交上的复跑**：交证据前，在最终提交（交付、`b51a143e3` 加本目录）上再跑合并检查、apiserver 的 `npm test` 与 OrbitKit 的 Swift 全量测试（[scripts/final-checks.sh](scripts/final-checks.sh)），这三次运行在证据提交里引用。

## 对照找到并修正的差异

开发轮（先 Chromium 明亮桌面，再八个环境）找到、在交付里改掉的差异。都是同参照修正：照被替换控件当时画出的样子改页面规则或调用参数，公共组件的默认值不动。

| 差异 | 被替换控件 | 修正 |
| --- | --- | --- |
| 账号菜单 Appearance 行的子菜单箭头 | 子菜单标题行右侧留 24px；箭头 12px、图标色，脱离文档流，距行尾 8px，在行的行高盒里居中 | `.tp-account-menu .orbit-menu-item[aria-haspopup]` 右内边距 24px，`.tp-account-menu .orbit-menu-submenu-icon` 绝对定位（右 8px、12px、`--text-3`） |
| Log out 的颜色 | 危险项的文字用菜单自身的危险色；页面规则的 `--error` 只作用到图标 | 文字用 Orbit 菜单的危险色，`.tp-account-menu .orbit-menu-item[data-danger] .orbit-menu-icon` 用 `--error` |
| 差异抽屉头部高度 | 头部把无单位行高 1.5 传给标题与按钮：标题下 12px 的说明行高 18px、Maximize 按钮盒高 26px，头部 59px | `.wt-diff-drawer > .orbit-overlay-header`、`.wt-diff-drawer .orbit-overlay-title` 行高 1.5 |
| Move 对话框移动中的关闭键 | `closable={!busy}`：移动中不画关闭键 | 初版只传了 `busy`（阻止关闭，但关闭键还画着），补上 `closable={!busy}` |
| 手机上账号菜单的宽度（八个环境那一轮） | 280px。`minOverlayWidthMatchTrigger` 只把“不窄于触发器”加在看不见的外层上 | Orbit 菜单默认不窄于触发器（`min-width: var(--anchor-width)`），手机上触发器宽 304px，菜单跟着变成 304px；`.tp-account-menu.orbit-menu` 加 `min-width: 0` |
| 手机上 Plan usage 浮层的横向位置（同一轮） | `align.overflow.shiftX`：药丸在一行中间、浮层两边都放不下时贴着屏幕左缘滑回 | Orbit 浮层滑回时留 8px；Popover 新增 `collisionPadding`（默认 8，见[公共组件](#公共组件)），这里传 0 |

另有几处是用例本身的观察时机，不是产品差异，改在用例里（见[对照方法](#对照方法)的 P5.1 用例一条）：被替换弹层在收到关闭的下一帧才开始退场，记录前先过两帧；选完主题、选完分支、进 Settings、打开 Move 之后等菜单都关掉；选完主题后指针移开；End and Move 时扣住结束会话的请求。

## 未消除的差异

截图上的四类见[对照结果](#对照结果)。行为上：

1. **空的合并目标菜单仍是菜单**（8 个环境的 trace）：Orbit 菜单的弹层总是 `role="menu"`；搜索没有匹配时它只剩 footer（“No matching branches”与搜索框），读屏会报一个没有项的菜单。被替换的面板没有匹配时不画菜单元素。
2. **参照树的 Plan usage 浮层在 Esc 之后又打开**（正式轮 r1 WebKit 明亮桌面 1 次、开发第 3 轮 Chromium 明亮手机 1 次，r2 没有出现；交付各次都已关闭）：rc-trigger 在指针进入浮层时按 `mouseEnterDelay`（0.1s）排一次打开，受控的关闭不取消它；Esc 落在指针进入后 0.1s 之内时，这次打开在关闭之后生效。插桩复现见 [checks/escape-probe/](checks/escape-probe/)（参照树 WebKit 明亮桌面 16 次，日志从按 Dismiss 之前开始记）：Esc 距指针进入浮层 71、98、99ms 的三次都重新进场（一次之后仍画着，另两次随指针落点又关上），113ms 及以上、以及指针本就在浮层里的各次都没有。交付用同一插桩跑 16 次，每次 Esc 之后浮层都已关闭、2 秒后仍关着，其中 7 次 Esc 距指针进入浮层不到 0.1s（62–100ms）。这是被替换控件的竞态，不是要保留的语义。（第一次插桩只从按 Esc 前开始记，WebKit 与 Chromium 各 8 次，在 WebKit 上复现 1 次，看不到之前的指针事件，于是提前日志起点重跑；第一次的逐次日志没有保留。）
3. **焦点**（trace 的焦点字段，P2–P4 已接受的约定）：
   - 打开菜单时焦点进入菜单（账号菜单、合并目标菜单；悬停到 Appearance 时落在该项）；被替换的下拉框把焦点留在触发器上。选完或 Esc 之后焦点回到触发器；被替换的多数落到 body。
   - 按压打开的浮层，焦点进入浮层（新会话的引擎列表、Plan usage）；被替换的引擎列表把焦点留在卡片上。Plan usage 浮层本身是以标题命名的对话框，焦点落在其中的面板上（面板不再自带 `role="dialog"`）。
   - Move 对话框打开时焦点在对话框本身（被替换的在关闭键上）；Move 的确认框打开时焦点在 Cancel（P2.1 `useConfirm` 的约定），被替换的 `modal.confirm` 在 End and Move 上。
   - 差异抽屉打开时两边焦点都在抽屉容器上；Unified/Split 被替换的是隐藏的单选框，Orbit 是 `role="radio"` 的按钮。
4. **从键盘打开合并目标菜单**（[checks/merge-keyboard-probe/](checks/merge-keyboard-probe/)：两棵树，Chromium 与 WebKit 明亮桌面，各打开两次）：交付每次都落在第一项，方向键在项之间移动，Tab 到搜索框，Esc 关闭并回到 ▾；被替换的第一次打开落在搜索框、方向键进不了列表，第二次起焦点留在 ▾、方向键与 Tab 都到不了列表项，第一次的 Esc 把焦点丢到 body。交付的键盘可达性更好，不是回归。按指针打开时两边焦点都在搜索框（trace）。
5. **悬停打开后半秒内再按**（见[业务切换](#业务切换)）：被替换的按下即关；Base UI 在悬停打开后 500ms 内的按下保持打开。
6. **选完主题之后**：被替换的 Appearance 子菜单在指针停在按下的那一行时，主菜单关上之后仍画着（开发第 2 轮 8 个环境中 6 个记录到）；交付一起关上。用例改为选完后移开指针再记录（见[对照方法](#对照方法)）。

## 未确立的部分

- 没有在真机（iOS Safari、Android Chrome）、输入法与读屏软件上验证；触屏只有 Playwright 的手机模拟（`isMobile`/`hasTouch`），无障碍只按 trace 里的角色、名称、`aria-hidden` 与单测核对。
- 合并目标菜单的键盘探针只跑了明亮桌面的 Chromium 与 WebKit；Plan usage 的 Esc 插桩只跑了 WebKit 明亮桌面。
- r2 里参照树那一例（WebKit 暗色手机，Plan usage 的无人应答一步）为什么在确认之后关上了浮层，没有插桩查明；它与 Esc 重开同在被替换的浮层上，交付在 r1、r2 与开发轮的各次里都没有这样的失败，同一环境补跑两棵树都通过。
- 会话工作区本身（`WorkspaceView`，P5.3）与 Transcript（P5.2）仍是 AntD，它们的下拉菜单、确认框与输入框不在本批范围；普查里剩下的 `ant-btn`、`ant-select` 等来自它们。
- 未部署、未发布。

## 协调者的判定与转告

协调者（会话 34b245G3NiwgVVUj2JFJw）的转告与判定，都已照做：

1. **2026-10-10 两条清单转告**：main `2255a5313`（0418，会话列表第二行读服务端 recap）带进来的 `WorkspaceView.recapRow.test.tsx`（只为包裹 WorkspaceView 导入 antd `App`），以及 main T7（`3a3c58c1f`，经 `ab47a1c11` 进 main）在 index.css 新加的 `.ant-dropdown-menu-item.composer-provider-gone .scope-menu-row {`（composer 的 Provider 菜单），都已判定归 P5.3、由 P5.2 写记录 2026-10-10 与 2026-10-10b。本批不写记录、不动它们，`--check-owners` 里按已知未归属点列出（见[迁移清单](#迁移清单)）。
2. **main T7 的 WikiSettingsPage 单测**（请求 `34dEqXW9ewr6tEUPubUe6`，选项 0「按建议办：P5.1 在同步合并里改」）：作为这次合入 main 的语义冲突解法放进同步合并（第一次是 `67af3f29c`，正式轮之前按同一解法重做为 `dea24d897`），内容取协调者晋升同步 `2fcd654d8` 的同一文件（与 P5.2 的 `378b7033e` 逐字节相同；`c26b69643..ab47a1c11` 之间 main 没有再改这两个文件），只改定位、断言不变；它不是未归属点，不写清单记录。改完后 P4.4 回到 0 个使用点。

## 迁移清单

开工时与交证据前，都在交付上运行 `audit-antd.mjs --check-owners`（[scripts/audit.sh](scripts/audit.sh)，[checks/](checks/)）。[inventory-closure.mjs](inventory-closure.mjs)（P4.4 的同名脚本，owner 改为 P5.1）对比同提交参照与交付，结果在 [inventory-closure.json](inventory-closure.json)；每个点按审计自己的 `--check-owners` 规则（P0.1 清单加 inventory-delta 的九份记录）判归属。

| | 提交 | P5.1 的使用点 | 未归属 | 待定 | 其余归属 |
| --- | --- | --- | --- | --- | --- |
| 参照（本批撤回） | `72fc42d85` | 28 | 2 | 0 | KEEP 1、P5.2 11、P5.3 95、P6 42 |
| 交付 | `a0e84233f` | **0** | 2 | 0 | KEEP 1、P5.2 11、P5.3 95、P6 42 |

（合入 main `23bdaa967` 之前，r1 的参照 `ca9b895b0` 与交付 `eb9438625` 也是这组数字。）

- 交付上 `--check-owners` 以 1 退出，只因为那两个未归属点（[checks/delivery-check-owners.json](checks/delivery-check-owners.json)）：`WorkspaceView.recapRow.test.tsx` 与 index.css 的 `.ant-dropdown-menu-item.composer-provider-gone .scope-menu-row {`（合并后在 17921 行）。协调者已判定都归 P5.3、由 P5.2 写记录 2026-10-10 与 2026-10-10b（见[协调者的判定与转告](#协调者的判定与转告)），本树里还没有这两份记录，本批不动它们、不另写记录。
- 本批没有新的使用点要登记，不写清单记录。其余归属的数字在参照与交付之间不变：本批只移走自己的 28 个点。

## 查漏：登录后外壳还连着的 AntD

[p4.4/route-closure.mjs](../p4.4/route-closure.mjs) 在交付上重跑（[route-closure.json](route-closure.json)）：登录后各页共用的外壳（`AppShell`：侧栏与会话搜索）的静态导入闭包里，还导入 antd 的模块只剩 `WorkspaceView`（P5.3）与 `Transcript`（P5.2），都是经 `SessionSearch` 导入 `WorkspaceView` 的 `StatusIcon`/`statusLabel` 连上的；P5.1 的 7 个模块都不再导入 antd。P4.4 记录的“外壳到达 `TasksSidePanel`、`SessionSearch`（P5.1）及 `SessionMoveModal`、`SessionOutputs`、`NewSessionProviderHero`、`PlanUsageIndicator`、`CodexResetCredit`（P5.1）”这几条链已断开。

## 复现

在任务工作树里运行（脚本里的路径按本任务写死，产物都在 `/mnt/data/tmp/34Za39L1H6V82d2sobzPY/`）：

```
scripts/make-trees.sh a0e84233f4c532a810ca7bbd17214e34b0793344 62a0820f935a1d6ce2ca07289eebb0f7783e9629 23bdaa967e4e4a0f722a6e7a13a3b1ba874acad7
scripts/formal.sh r2        # P5.1 两棵树、P0 矩阵（参照 / 逐像素 / 交付）、标准 P0 ×2、合并检查、overlays、controls、choices
scripts/p51-rerun.sh r2     # 正式轮里失败的 P5.1 用例，在同一环境的两棵树上补跑
scripts/analyze.sh r2       # 截图、计算样式、trace 与其语义字段、AntD 普查；补跑的一对同样比较
python3 scripts/classify.py /mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1/compare-r2
scripts/audit.sh            # audit-antd（交付与参照）、--check-owners、迁移清单闭合、外壳路由闭合
scripts/collect.sh r2 r1    # 把本文引用的产物复制到本目录（r1 的步骤日志进 process/r1/）
scripts/final-checks.sh <最终提交> final   # 合并检查、apiserver npm test、OrbitKit swift test
```

开发轮用 `scripts/round3.sh <业务切换提交>`（重建开发参照树、两棵树各跑一遍八个环境、比较）；探针用 `scripts/probe-run.sh`、`scripts/repeat-run.sh`、`scripts/probe-repeat.sh`（探针文件本身在 checks/ 的两个探针目录里，跑时临时复制进树，跑完删除）。
