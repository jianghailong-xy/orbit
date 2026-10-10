# P4.4 Wiki、共享页面与其余非会话入口

服务于 [P4.4 迁移 Wiki、共享页面并查漏非会话入口](orbit-task:34Za39J4QY3kDa5p2Wsau)，项目验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。** 本任务承担其子范围：Wiki/共享及其余非会话页面的既有操作和呈现保持一致，相关回归通过；所有非会话业务页面的运行时 AntD 使用点均已关闭，明确保留到 P5/P6 的入口与基础设施项。

本批 5 个提交接在 origin/main `896226a23` 上（交付 `f4ec61864`），见[提交](#提交)。

## 结论

- **使用点**：本批负责的 55 个 AntD 使用点全部关闭（23 个生产文件、19 个测试文件、index.css 13 行），包括协调者转来的 `WikiReviewPage.decided.test.tsx`、`WikiShareButton.tsx`、`SharedWikiPage.tsx`、`SharedWikiPage.test.tsx`、index.css 19729 `.ant-popover .watch-row-list` 与公开分享项目页的 AntD `List`；main 带来的 2 个未归属点按协调者判定处理（`App.managedRunner.test.tsx` 在业务切换里去掉包裹，`WorkspaceView.managedRunner.test.tsx` 归 P5.3，记录 `2026-10-09c.json`）。交付上 `--check-owners` **0 未归属、0 待定**，P4.4 已无使用点。
- **查漏**：会话工作区以外的 25 个路由入口里，静态导入还能到达的 AntD 模块全部归 P5.1/P5.2/P5.3（会话侧栏、会话搜索、会话工作区、Transcript），是通过 `statusLabel`、`MD`、`relTime` 等辅助函数连上的；应用根的 `ConfigProvider`/`App` 与 `theme.ts` 归 P6。运行时普查：本批用例在交付上 708 步观察里，677 步只见到应用根的 `ant-app`，其余 31 步都在会话工作区。**非会话业务页面已没有运行时 AntD 使用点。**
- **行为**：查询、变更、请求体、路由与公开页面的只读边界都没有改。与同提交参照（交付只撤回业务切换）对比，P4.4 的 14 个用例在 8 个环境里两边都跑完的 111 个用例、700 步，地址、请求、通知、菜单、选择、列表、说明与卡片内容只有 2 步不同，都是默认落地页一步的观察时机（两树跳转序列相同，探针核对）。
- **呈现**：P4.4 截图 496 对，260 张逐字节相同、158 张抗锯齿级、77 张超出；77 张逐张归类（[对照结果](#对照结果)）。开发对照找到的 10 处呈现差异已按参照修正（[对照找到并修正的差异](#对照找到并修正的差异)），其中两处是迁移时漏掉的被替换组件属性（脚注卡片的 `arrow.pointAtCenter`、标记说明的固定底色）。需要协调者确认的一处：条目抽屉在手机上的按钮恢复成设计的 40px，参照（main）上是 32px（[未消除的差异](#未消除的差异)第 1 条）。
- **回归**：P0 矩阵交付对参照逐张 0 像素通过；标准 P0 在交付与起点上失败的 49 个用例逐个相同、原因相同，都是 main 的基础漂移（`/api/auth/capabilities` 没有夹具、Infrastructure 页改动侧栏），不符截图 40 张里 39 张与起点逐字节相同；合并检查（构建与 Vitest 382 个文件、4968 个测试）、overlays 176、controls 32 通过，choices 679 通过、1 个计时用例失败（补跑见[合并检查与组件矩阵](#合并检查与组件矩阵)）；OrbitKit 的 Swift 全量 3588 个测试 0 失败。参照失败的那个 P4.4 用例补跑后两棵树都通过；choices 的计时用例单独复查交付与起点各两次都通过。最终轮之后 main 并入了 P0 漂移第 7 批，交付与新 main 的临时合并上标准 P0 **101 通过、0 失败**，P4.4 用例 **112 通过**。
- 没消除的差异与没确立的部分分别见[未消除的差异](#未消除的差异)、[未确立的部分](#未确立的部分)。

## 范围

开工时按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`。同提交参照树（交付只撤回业务切换）上，P4.4 负责 55 个使用点，逐点列表见 [inventory-closure.json](inventory-closure.json) 的 `before.p44`：

- 生产文件 23 个：
  - `components/` 下 18 个：`WatchCard`、`WatchEditor`、`WatchRelations`、`WikiActivityPage`、`WikiArticlePage`、`WikiDirectory`、`WikiDocPage`、`WikiEntryDrawer`、`WikiEntryMarks`、`WikiHome`、`WikiNewEntry`、`WikiPlanCard`、`WikiPlanPage`、`WikiReviewPage`、`WikiRunPage`、`WikiSettingsButton`、`WikiSettingsPage`、`WikiShareButton`；
  - `pages/` 下 4 个：`FollowingPage`、`SharedLinksPage`、`SharedProjectPage`、`SharedWikiPage`；以及 `App.tsx`（默认落地页的加载圈）。
- 测试 19 个（见[单测](#单测)）。
- index.css 13 行：本批页面的 `.ant-*` 覆盖样式与提到 AntD 的注释，包括 P4.3a 转来的 19729 `.ant-popover .watch-row-list`（2026-10-08b 记录）。公开分享项目页的 AntD `List`（P4.3a 留下的分界）也在 `SharedProjectPage` 里。
- 另有 main 带来的 2 个未归属点，按协调者判定处理（见[迁移清单](#迁移清单)）。

范围外、本批只读不改的：会话工作区（`WorkspaceView` 及其子组件，P5.3）、会话侧栏与会话搜索（`TasksSidePanel`、`SessionSearch`，P5.1）、Transcript（P5.2），以及 `main.tsx` 的 `ConfigProvider`/`App`、`theme.ts`（P6）。

## 跟上 origin/main

| 时间（UTC） | 基础 | 说明 |
| --- | --- | --- |
| 10-09 开工 | origin/main `251c3de8f`（项目线并入 main 的合并提交） | 业务切换与开发对照在这里开始；`--check-owners` 报出 main 带来的 2 个未归属点（见[迁移清单](#迁移清单)） |
| 10-09 19:10 前后（第 2 次复活之后） | origin/main `896226a23` | main 的 10 个新提交只改 `src/android`（A05d：会话列表里的项目行等）；项目 tip `17980cb7c` 已在 origin/main 里，按规则直接 rebase，无冲突，src/web 内容逐行不变 |
| 10-09 23:30（最终轮之后） | origin/main `56c21bdd2`（124 个新提交，含 P0 漂移第 7 批：给 `GET /api/auth/capabilities` 加 P0 夹具、登记 Infrastructure 侧栏等漂移；另有 Infrastructure/Provider 页、RunnerEngines、会话页与 Transcript、决策卡片等） | 按最终轮之后的规则先干跑：`git merge-tree --write-tree` 无冲突；main 改到的 Web 文件里与本批共同的只有 index.css，各改各的规则（main 加的是证据排队卡片、Provider 引擎与密钥行、会话预览标签），本批自己的文件与依赖的公共组件都没动。main 改到了本批回归所依赖的 P0 夹具（第 7 批），所以不 rebase，在临时合并提交 `d064a3141`（交付合并 `56c21bdd2`，只在本地，不推送）上跑标准 P0 与本批用例：标准 P0 **101 通过、0 失败**（11 个跳过同上），P4.4 用例八个环境 **112 通过**（[runs/merged-p0-standard-merged.txt](runs/merged-p0-standard-merged.txt)、[runs/merged-p44-merged.txt](runs/merged-p44-merged.txt)；合并树的记录 [runs/merged-merge-tree.txt](runs/merged-merge-tree.txt)） |

- 每次接上新基础后都在交付上重跑 `audit-antd.mjs --check-owners`：0 未归属、0 待定。

## 提交

| 提交 | 内容 |
| --- | --- |
| `b9136d57a` | **feat：Tooltip `toggleOnClick`。** 按下触发器时打开关闭着的提示、关闭打开着的提示，同被替换提示的 click 触发；Wiki 文档里被标记句子的说明带链接，触屏读者按句子打开它。`Tooltip.test.tsx` 3 个单测（不接这个属性时其中 2 个失败），README 一行。 |
| `824974aee` | **feat：Popover `pointAtCenter`。** 同被替换 Popover 的 `arrow.pointAtCenter`（见[公共组件](#公共组件)）。`Floating.test.tsx` 4 个单测，按参照实测的三张脚注卡片的边（不改 `Floating.ts` 时其中 3 个失败），README 一行。 |
| `90ce00944` | **feat：业务切换。** 23 个生产文件不再导入 antd；index.css 本批规则改写，另加同提交对照找到的同参照修正（见[对照找到并修正的差异](#对照找到并修正的差异)）；19 个测试文件改按角色与名称定位，`App.managedRunner.test.tsx` 去掉 AntD `App` 包裹（协调者判定）；OrbitKit 4 个文案对照测试文件里 9 个失败测试的 12 处锚改到新标记（见[OrbitKit 的文案对照测试](#orbitkit-的文案对照测试)）；P0 的 Wiki 场景按角色找新条目对话框的表面。 |
| `29ef702b3` | **test：同提交对照用例。** `p44.browser.mjs`（14 个用例）、`p44-fixtures.mjs`、`p44.config.mjs`；P0 矩阵忽略 `p44*.browser.mjs`。 |
| `f4ec61864` | **docs：清单记录 `2026-10-09c.json`。** main 的 managed runner 项目（`94025579b`）带来的 `WorkspaceView.managedRunner.test.tsx` 按协调者 2026-10-09 的判定归 P5.3；生成脚本 `build-record-09c.py` 与该次扫描的审计（`checks/record-09c-audit.json`），`verify-record` 通过。见[迁移清单](#迁移清单)。 |
| 本目录所在的提交 | **docs：本目录。** 证据、对照脚本与运行记录（报告去掉附件正文）。 |

- 撤回 `90ce00944` 就恢复本批的 AntD 页面，同提交参照树正是这样得到的。
- 两个公共组件提交单独存在时没有业务页面用到新属性；默认值与之前相同（`toggleOnClick`、`pointAtCenter` 默认关）。

## 公共组件

用法写在 [components/ui/README.md](../../../../src/web/src/components/ui/README.md)。两项都只为本批真实用到的地方增加，默认不改变其它调用方。

| 组件 | 替换 | 说明 |
| --- | --- | --- |
| `Tooltip` `toggleOnClick` | `trigger={['hover', 'click']}` 的 Tooltip | Base UI 的提示默认只在悬停与聚焦时打开，按下只会关闭（closeOnClick）。打开后 Esc 照常关闭。Wiki 文档里被标记句子的说明（`WikiDocPage` 的 `wk-dc-tip-pop`）用它。 |
| `Popover` `pointAtCenter` | `arrow={{ pointAtCenter: true }}` 的 Popover | rc-trigger 对 `bottomLeft` 加 `pointAtCenter`：卡片移到箭头（距对齐边 12px、宽 16px）指着触发器中心的位置，即对齐边在中心前 20px，向下取整；越界翻到另一边时 rc-trigger 从触发器的近角量起，新的对齐边在触发器起边外 20px，向上取整；不沿触发器滑动，翻转按可视区判断（避让留白 0）。不加这个属性时，Orbit Popover 让卡片起边对着触发器起边；脚注编号只有 14–20px 宽，Floating UI 的箭头中间件会把卡片挪 5.7px 让箭头够得着，靠右的卡片在离边缘还有 1px 时就翻到另一边（8px 避让留白）。Wiki 文档、专题文章与公开分享的 Wiki 页的脚注卡片用它。 |

## 业务切换

查询、变更、请求体、路由与公开页面的只读边界都不变，只替换控件、菜单、确认、浮层与状态展示。

| 文件 | AntD（之前） | 现在 |
| --- | --- | --- |
| `WikiPlanPage` | Button、Drawer、Dropdown、Input、InputNumber、Modal、Select、Switch | Button、Drawer（编辑文档，`wk-pl-drawer`）、Menu（版本 `wk-pl-vermenu`、⋯）、Input/Textarea、NumberInput、Dialog（重拟 `wk-pl-redraft-dialog`、章节 `wk-pl-section-dialog`）、Select、Switch |
| `WikiSettingsPage` | Button、Card、InputNumber、Modal、Radio、Select、Switch | Button、Card、NumberInput、Dialog（维护设置 `wk-setup-dialog`）、RadioGroup（`wk-modes`）、Select、Switch |
| `WikiEntryDrawer` | Button、Dropdown、Input、Modal | Button、Menu（⋯：取代、退役、复制链接）、Input/Textarea、Dialog（编辑、取代、退役 `wk-entry-edit-dialog`） |
| `WikiReviewPage` | Alert、Button、Dropdown、Modal | Alert（被拒原因）、Button、Menu（驳回原因）、Dialog（编辑提案 `wk-proposal-dialog`） |
| `WikiRunPage` | App（`modal.confirm`）、Button、Dropdown | `useConfirm`（Revert run…，确认挂在用它的组件里）、Button、Menu（驳回原因与说明行） |
| `WikiNewEntry` | Button、Input、Modal、Select | Dialog（`wk-new-entry-dialog`）、Input/Textarea、Select、Button |
| `WikiDocPage`、`WikiArticlePage`、`SharedWikiPage` | `WikiDocPage`：Button、Drawer、Popover、Tooltip；`WikiArticlePage`：Button、Drawer、Popover；`SharedWikiPage`：Drawer、Popover | 脚注卡片 Popover（`pointAtCenter`）、手机底部面板 Drawer（`wk-fnsheet`：不要标题行，保留抓手）、标记说明 Tooltip（`toggleOnClick`）、Button/LinkButton |
| `WikiActivityPage`、`WikiDirectory`、`WikiEntryMarks`、`WikiHome`、`WikiPlanCard`、`WikiSettingsButton`、`WikiShareButton` | Button | Button |
| `WatchCard` | Button、Popconfirm | Button、Popconfirm（Stop watching） |
| `WatchEditor` | Checkbox、Modal、Radio、Select | Dialog（`watch-editor-dialog`）、RadioGroup（含按钮组）、Checkbox、Combobox（会话选择的远程搜索） |
| `WatchRelations` | Button、Popover | Button、Popover（`watch-popover`） |
| `SharedLinksPage` | Button、Popconfirm、Spin | Button、Popconfirm（Turn off）、Spinner |
| `SharedProjectPage` | Empty、List、Tag、Typography | 项目页的原生 `.orbit-list` 行（`ProjectsPage` 导出 `tagTone` 给 Badge 色）、`.orbit-typography` 标题、Empty |
| `FollowingPage` | Button、Spin | Button、Spinner |
| `App.tsx`（默认落地页） | Spin | Spinner |

- 被替换的 Spin 都带 `aria-busy="true"`；换上的 Spinner 保留它（P0 与本批用例按 `[aria-busy="true"]` 找加载区）。
- 子元素可能是 `false` 的按钮改为 `null`：AntD 把 `false` 当作没有子元素（只显示图标的方按钮），Orbit Button 只认 `null`/`undefined`。
- 按钮尾部的箭头用 `iconPlacement="end"`；条目抽屉的 Reject ▾ 是下拉触发器，被替换按钮的下箭头是 12px（`.ant-dropdown-trigger.ant-btn > .anticon-down`），页面规则同样设 12px。
- 脚注底部面板的 12px 顶部圆角写的是 `.ant-drawer-content`，AntD 6 不渲染这个元素，参照里从未生效，所以不搬（P4.3a 有同样的先例：`.ant-radio-inner`）。

## 层叠顺序

被替换组件的样式由 antd cssinjs 插在 `<head>` 最前，权重相同时页面规则赢；Orbit 组件的样式在 index.css 之后加载，权重相同时 Orbit 赢（P4.3a 的发现）。本批改写的页面规则一律带上组件类（如 `.wk-modes.orbit-radio-group`、`.watch-editor-options.orbit-radio-group`、`.wk-setup-limit .orbit-number-input`）。P4.3a 的静态检查 [ties.py](../p4.3a/scripts/ties.py) 在交付的 24 个本批生产文件上跑出的结果在 [checks/ties.txt](checks/ties.txt)：标记为 `TIE?` 的 10 处逐条核对，都不是同一元素上同权重、同属性的冲突——或在不同的子元素上（`.watch-editor-session` 对 `.orbit-select-trigger`、`.wk-settings-card` 对 `.orbit-card-head`、`.wk-pl-modal-t` 对对话框外壳），或按钮带文字因而不是 icon-only（`.wk-fncard-open`），或页面规则权重更高（`.wk-activity-btn.on.orbit-button` 0,3,0），或组件规则本身就按旧组件的权重写（公开项目页标题 `h2.page-title.orbit-typography`：`h2.orbit-typography` 0,1,1 胜过 `.page-title`，与 AntD 的 `h2.ant-typography` 一样）。同提交对照的截图核对了这些页面。

## 对照找到并修正的差异

开发轮的同提交对照（Chromium/WebKit 明色桌面与手机，两棵树）逐张查超出截图，用探针在两棵树上实测（几何与计算样式），按参照修正：

| 差异（参照 → 修正前的交付） | 原因 | 修正 |
| --- | --- | --- |
| Wiki 设置页 review mode 列表里各项的标题行压在一起 | Orbit 单选组 `font-size: 0; line-height: 0`；被替换的组只把字号设成 0，无单位行高 1.5714 照常传下去，抽查项标题没有自己的行高 | `.wk-modes.orbit-radio-group` 设无单位行高 1.5714 |
| 七个对话框（新条目、编辑/取代/退役、Review 的编辑、计划重拟、章节编辑、维护设置、关注编辑器）里没有自设行高的 12–13px 说明与标签行高变成 22px，对话框高 2.4–9.5px（重拟 296.2 → 298.6，章节 420.5 → 430） | AntD Modal 的内容区传无单位行高 1.5714；Orbit 对话框外壳是 22px | 各对话框加类名，按对话框约定（index.css 里替换 Modal 的对话框各自恢复无单位行高的那一组）设 1.5714 |
| 计划编辑抽屉的标题高 6px（75 → 81），其下内容整体下移 6px，关闭键下移 3px | AntD 抽屉标题行高无单位 1.5，12px 的第一行（`.sub`）是 18px；Orbit 抽屉标题固定 24px | `.wk-pl-drawer .orbit-overlay-title { line-height: 1.5 }` |
| 条目抽屉的 Reject ▾ 宽 2px，Confirm 与 Reject 左移 2px，驳回菜单随之 | 被替换的下拉触发器按钮的下箭头 12px，Orbit 图标 14px | `.wk-reject-btn .anticon-down` 12px |
| 脚注卡片：文档 [44] 在右侧时翻到编号左边（左缘 368 对 799），文章 [2] 右移 8px（754 对 746） | 参照的 Popover 带 `arrow={{ pointAtCenter: true }}`，迁移时漏了 | 公共组件 `Popover` `pointAtCenter`（`824974aee`），三处脚注卡片都传它；探针实测三张卡片与参照同位 |
| 计划版本菜单每行高 2px（29.64 → 32），菜单高 4px | 被替换的菜单项没有最小高度，12.5px 文字的版本行 30px 高；Orbit 菜单项最小 32px | `.wk-pl-vermenu .orbit-menu-item { min-height: 0 }` |
| 章节表单的 Kind 选择框宽 2px（100.36 → 102.36），箭头右移 2px | AntD 6 选择框的值与箭头之间是 `ceil(14 × 1.25) − 12 = 6px`；Orbit 选择框触发器的间隙 8px。只在宽度随值变化的选择框上看得出 | `.wk-pl-section-dialog .wk-pl-f .orbit-select-trigger { gap: 6px }` |
| Following 页卡片底部 Pause/Resume/Stop 的文字低 1px | AntD 6.6.5 的按钮不设行高（`contentLineHeight` 令牌定义了但样式里没用），继承卡片的 1.45（14px × 1.45 = 20.3px）；Orbit 按钮固定 22px | `.watch-actions .orbit-button { line-height: inherit }` |
| 暗色主题下文档标记的说明底色：黑 → 灰（#5b5b6c） | 被替换的提示设了 `color="rgba(0, 0, 0, .85)"`，两种主题都用这个底色，迁移时漏了；Orbit 提示的暗色主题底色是 #5b5b6c | `.wk-dc-tip-pop.orbit-tooltip { --orbit-tooltip-bg: rgba(0, 0, 0, 0.85) }`（底色与箭头同用这个变量） |
| 手机上 Wiki 头部的 Activity 按钮宽 8px（45.5 → 53.5） | 手机上按钮没有文字、只有绝对定位的待办数徽标。被替换按钮把徽标当自己的直接子元素，脱离排版；Orbit 按钮把子元素包进一个 span，这个空 span 仍然占着图标后的 8px 间隙 | `.wk-activity-btn.orbit-button > span:not(.orbit-button-icon) { display: contents }` |

其中三类（选择框间隙、菜单项最小高度、按钮行高继承）其实是公共组件与 AntD 的一般差异，只在本批这种用法里看得出；本批只用页面规则按参照修正自己的页面，没有改公共组件（改了会动到已迁移页面的 P0 截图），建议另建任务在公共组件里统一（见[未消除的差异](#未消除的差异)）。

另有几处是用例本身的时序，已在用例里修正（两棵树同样）：被替换的弹层（下拉菜单、气泡、提示）不管减少动态效果的设置，入场第一帧尺寸为 0、透明度为 0，观察前等它“画完”（有尺寸且自身与祖先不透明）；标记说明画完后再看里面有没有 See footnote；手机底部面板关上并结束退场后再滚到下一个编号；按下脚注编号后把指针移开（手机面板会画在指针下）；Following 的 Retry 用键盘按（还没有读到列表时，按下后页面立刻回到加载圈，指针点击会在按钮消失后重找它）；公开项目页截图前等任务图（P4.3b 的组件，异步载入）画出；Review 的手机分页按挑战卡片自己的那条琥珀色说明翻页。

## 查漏：非会话入口还连着的 AntD

[route-closure.mjs](route-closure.mjs) 从 `App.tsx` 声明的每个会话工作区以外的路由出发，沿静态导入、再导出与动态 `import()` 走遍 `src/web/src`，列出路上每个还导入 antd 的模块、到达它的链与它的归属（`--check-owners` 规则），结果在 [route-closure.json](route-closure.json)。登录后各页共用的外壳（侧栏与会话搜索）单列一项。

交付 `f4ec61864` 上 25 个入口（模块数是该入口的静态导入闭包大小）：

| 入口 | 模块 | 闭包 | 还能到达的 AntD 模块（归属，导入的 antd 名称；经由） |
| --- | --- | --- | --- |
| `/s/:token`（任务、项目、Wiki 或会话的分享链接）、`/s/:token/t/:taskId` | `SharedLinkPage` | 187 | `Transcript`（P5.2，Image；经 `SharedSessionPage`） |
| `/s/:token/d/:slug`（公开的 Wiki 文档） | `SharedWikiPage` | 115 | `Transcript`（P5.2，Image；经 `SharedSessionPage` 的 `SharedLoading`/`SharedUnavailable`） |
| `/s/:token/c/:sessionId`（分享的会话） | `SharedSessionPage` | 104 | `Transcript`（P5.2，Image）——会话的公开页本身属会话阶段 |
| 登录后各页共用的外壳（侧栏与会话搜索） | `AppShell` | 225 | `TasksSidePanel`（P5.1）、`SessionSearch`（P5.1）；会话搜索导入 `WorkspaceView` 的 `StatusIcon`/`statusLabel`，从而到达 `WorkspaceView`（P5.3）及其 `SessionMoveModal`、`SessionOutputs`、`NewSessionProviderHero`、`PlanUsageIndicator`、`CodexResetCredit`（P5.1）与 `Transcript`（P5.2） |
| `/tasks`、`/tasks/:id`、`/lists/:key` | `TaskRoute` | 146 | `Transcript`（P5.2；`TaskDetailPanel` 导入它的 `MD`） |
| `/projects`、`/projects/:id`、`/projects/:id/tasks/:taskId` | `ProjectsPage` | 168 | `Transcript`（P5.2；经 `ProjectTaskPanel` → `TaskDetailPanel` 的 `MD`） |
| `/wiki` 及其子路由 | `WikiPage` | 255 | `WorkspaceView`（P5.3；`WikiPage` 导入它的 `statusLabel`）及其上述子组件（P5.1/P5.2）；`SessionSearch`（P5.1；导入 `openSessionSearch`）；`Transcript`（P5.2；`OrbitLinkCard` 导入它的 `relTime`） |
| `/`（默认落地页） | `App.tsx` 的 `DefaultLanding` | 12 | — |
| `/login`、`/setup`、`/enroll`、`/cli-login`、`/settings/profile`、`/settings`、`/settings/shared-links`、`/settings/access-tokens`、`/admin`、`/admin/sign-in`、`/infrastructure`、`/providers/*`、`/providers/pools/:id`、`/following`、`/runners/register`、`/runners/:id` | 各自的页面 | 7–69 | — |

- 还能到达的 AntD 模块全部归会话阶段：P5.1（会话侧栏、会话搜索、会话输出、移动会话、新会话的引擎卡、用量与 Codex 额度卡）、P5.2（Transcript）、P5.3（`WorkspaceView`）。非会话页面是通过导入这些模块里的**辅助函数与小部件**（`statusLabel`、`StatusIcon`、`MD`、`relTime`、`openSessionSearch`）连上的，并不画出其中的 AntD 组件；这些模块迁移后，这几条链自然断开，本批不动它们。
- 应用根上的 `ConfigProvider`/`App`（`main.tsx`）与 `theme.ts` 不在路由闭包里，归 P6；`StatusTag` 等不再被引用的旧组件与 `__fixtures__` 也在 P6 的清单里。
- 运行时普查（本批用例每一步的 `antd` 字段：侧栏 `aside.app-nav` 以外、可见元素上的 AntD 类名，图标的 `anticon` 不计；[compare/p44-trace-semantics.json](compare/p44-trace-semantics.json) 的 `antd`）：最终轮交付的 708 步观察里，677 步只见到应用根上的 `ant-app`（`main.tsx` 的 AntD `App`，P6），其余 31 步都在会话工作区（`/sessions`、`/workspaces`：手机上从脚注打开会话原文、默认落地页到达的工作区、会话页的关注徽标），属 P5；参照 696 步里 631 步见到本批页面的 AntD 组件。

结论：非会话业务页面已没有运行时 AntD 使用点；还连着的都是会话阶段的组件（P5.1/P5.2/P5.3）与基础设施（P6）。

## OrbitKit 的文案对照测试

OrbitKit 的 `*CopyParityTests` 逐字读取 Web 源文件，把每句文案锚在它周围的标记上。业务切换后在 Linux 上按 CI 的方式跑（`docker run … swift:6.1 swift test`，[scripts/swift-check.sh](scripts/swift-check.sh)）：改锚之前 9 个测试失败，都是锚在被替换标记上、文案本身没变的断言。业务切换提交里改 4 个测试文件的 12 处锚，只换标记，文案逐字不变，断言个数不变：

| 测试 | 原来的锚 | 现在的锚 |
| --- | --- | --- |
| `TaskDetailCopyParityTests`（关注编辑器） | `okText={editing ? 'Save' : '…'}` | `{editing ? 'Save' : '…'}` |
| `WikiCopyParityTests`（条目的 ⋯ 菜单两项） | `{ key: 'supersede', …, label: WIKI_ACTION_SUPERSEDE }`、`{ key: 'retire', …, danger: true }` | 同一行，结尾改为 `,`（菜单项多了 `onSelect`） |
| `WikiCopyParityTests`（编辑/取代/退役的确认键） | `okText={mode === 'retire' ? …` | `{mode === 'retire' ? …` |
| `WikiCopyParityTests`（Review 的驳回菜单） | `items: WIKI_REJECT_MENU.map(({ reason, label }) => ({ key: reason, label }))` | `items={WIKI_REJECT_MENU.map(({ reason, label }) => ({` |
| `WikiPlanCopyParityTests`（重拟） | `okText={WIKI_PLAN_REDRAFT_GO}` | `{WIKI_PLAN_REDRAFT_GO}` |
| `WikiReviewModeCopyParityTests`（维护设置） | 切到 `</Modal>`；`okText={maintenance.enabled ? WIKI_SAVE : WIKI_TURN_ON}` | 切到 `</Dialog>`；`{maintenance.enabled ? WIKI_SAVE : WIKI_TURN_ON}` |
| `WikiReviewModeCopyParityTests`（条目抽屉的 Edit） | `<>{WIKI_ACTION_EDIT}</>` | `wikiEntryAnswerable(data) ? null : WIKI_ACTION_EDIT}` |
| `WikiReviewModeCopyParityTests`（运行的驳回菜单） | `...WIKI_REJECT_MENU.map(({ reason, label }) => ({ key: reason, label }))` | `…({ key: reason, label, onSelect: () => onReject(reason) }))` |
| `WikiReviewModeCopyParityTests`（Revert run… 的确认） | 切到 `onOk:`；`okText: WIKI_REVERT_RUN_CONFIRM`、`okButtonProps: { danger: true }` | 切到 `onConfirm:`；`confirmText: WIKI_REVERT_RUN_CONFIRM`、`danger: true,` |

- **改锚之后，全量**：`4c7aba65e`（本批提交当时的样子，与最终交付相比只差 index.css 一条规则与对照用例）3588 个测试、5 个跳过、**0 失败**（[checks/swift-4c7aba65e.txt](checks/swift-4c7aba65e.txt)）。跳过的 5 个是 PerfBaselineTests，Linux 上总是跳过。最终提交上的复跑见[合并检查与组件矩阵](#合并检查与组件矩阵)末尾。

## 单测

本批 19 个测试文件改为按角色、可访问名称和页面自己的类名定位，去掉 `.ant-*` 选择器与 AntD `App` 包裹，断言内容不变：菜单按 `role=menu`/`menuitem`，对话框与确认按 `role=dialog`/`alertdialog` 与标题、按钮名称，单选按 `role=radio` 与 `aria-checked`，开关 `role=switch`（禁用读 `aria-disabled`），Select 与 Combobox 按触发器打开、选项按指针“按下”的事件序列选择（Base UI 在 jsdom 里的约定），加载按 `role=status`。

- `App.managedRunner.test.tsx`（main 的 `94025579b` 带来，用 AntD `App` 包裹被测的 `App`）：协调者 2026-10-09 判定由本批在 `App.tsx` 范围内去掉包裹，改法同 `App.loginNext.test.tsx`；去掉后照样通过，这个使用点随之消失，不写记录。
- 新增单测：`Tooltip.test.tsx` 3 个、`Floating.test.tsx` 4 个（见[提交](#提交)）。

全量 Vitest 结果见[合并检查与组件矩阵](#合并检查与组件矩阵)。

## 对照方法

沿用 P3.1/P3.2/P4.1/P4.2/P4.3a 的同提交对照。

- **三棵树**（[scripts/make-trees.sh](scripts/make-trees.sh)）：参照树 `c55c2ef2b` = 交付 `f4ec61864` 只撤回业务切换 `90ce00944`（本地提交、未推送），本批页面是 AntD，公共组件、P4.4 用例和其它一切与交付相同；起点树 `896226a23`（origin/main），跑标准 P0；交付树 `f4ec61864` 完整检出。
- **磁盘与内存**：三棵树、TMPDIR 与全部运行产物在 `/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1/`；每一步在独立网络命名空间、带内存上限（`MemoryMax=6G`）与调高 OOM 分数的 scope 里跑，开始前按 `df -BM` 看根分区，低于 2 GB 就停下报告。
- **构建与环境**：各树 `vite build` 后 `vite preview`；与 P0 相同的字体、`environment.mjs` 校验、DPR 1、en-US/UTC、固定时间与固定 REST 数据、reducedMotion=reduce；八个环境 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844。
- **比较**：[p3.2/compare_runs.py](../p3.2/compare_runs.py) 比较截图、计算样式与 trace；[p4.1/summarize.py](../p4.1/summarize.py) 分为逐字节相同 / 抗锯齿级（每个差异像素每通道 ≤2）/ 超出；[p4.2/scripts/beyond-clusters.py](../p4.2/scripts/beyond-clusters.py) 把 >2 级像素聚成区域；[trace-semantics.py](trace-semantics.py) 逐步比较 trace 的语义字段（地址、请求的方法/路径/请求体、通知、菜单项与禁用、alert、打开的选择，以及步骤里记录的列表选项、标记说明 `tip`、脚注卡片头 `card` 与去往原文的方式 `open`、行、卡片数），焦点与对话框文字另行计数；Orbit 选择控件旁供表单取值的隐藏原生输入按含义去掉，每次按下都新生成的 `triggerId` 与 `idempotencyKey` 里的 UUID 按“存在”读。另列每一步的 AntD 类名普查（`antd` 字段）。
- **P4.4 用例**（[p44.browser.mjs](../../../../src/web/ui-migration/p44.browser.mjs)、[p44-fixtures.mjs](../../../../src/web/ui-migration/p44-fixtures.mjs)）：14 个用例 × 8 个环境，覆盖 P0 只走到一部分的本批状态：Wiki 首页的头部、新条目表单与分享对话框；成文文档的标记说明、脚注卡片与手机底部面板（含从面板打开会话原文再后退）；专题文章的脚注卡片；条目抽屉的回答、菜单与表单（驳回原因、⋯、编辑、退役、确认）；Review 的卡片、编辑表单与被拒、挑战与手机分页；计划的版本菜单、比较、重拟、编辑抽屉（含长度、受保护开关、章节类型）与章节表单，以及还没有计划时；Wiki 设置（review mode、抽查、维护设置与开启后的状态）；Activity 与一次运行（Revert run… 的确认、运行抽屉里的驳回）；Settings → Shared links 的各状态（页签、关闭链接的两种确认、再次分享、加载与读取失败）；公开分享的项目页与 Wiki 页；Following 的各页签（暂停、恢复、停止、加载与读取失败后重试）；任务上的关注编辑器与会话页的关注徽标；默认落地页读取工作区时的加载圈。定位器是角色、可访问名称、标签和页面自己的类名，同一份文件驱动两棵树；被画出的盒用两边的类名并列。
- **P0 页面矩阵**：用 P3.2 的 [p32-reference.config.mjs](../p3.2/p32-reference.config.mjs)。参照树写出截图；交付树先按 `maxDiffPixels: 0` 对参照截图比较一次，再写出自己的截图供逐张分类。另外在交付树和起点树上各跑一次标准 P0 回归。

## 对照结果

最终轮（第 3 次开跑，[scripts/formal.sh](scripts/formal.sh) `runs3`）依次为：P4.4 参照、P4.4 交付、P0 参照、P0 严格比较、P0 交付、标准 P0（交付、起点）、合并检查、overlays、controls、choices（一个环境一步）。三棵树：参照 `c55c2ef2b`、起点 `896226a23`、交付 `f4ec61864`。前两次开跑（`runs1`、`runs2`）在 P4.4 两步跑出主机高负载下的用例问题后停下，修正用例（等待“画完”的时限、Following 的 Retry、会话页的载入时限、每个用例 180 秒）与一处呈现（标记说明在暗色主题下的固定底色）后重建三棵树从头跑；第 3 次开跑在 P0 参照中途被运行器回收会话时停下一次，可续跑的脚本从 P0 参照接着跑（已完成的两步不重跑）。各步开始时的负载与根分区余量记在每份日志开头。

- 日志在 [runs/](runs)：开头记 argv、树、HEAD、未提交路径、负载、根分区余量与 TMPDIR，结尾记退出码、负载与结束时间；终端颜色码已去掉。报告去掉了附件正文（`*.report.summary.json`）。

### P4.4 用例

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [p44-ref](runs/p44-ref.txt) | 参照 `c55c2ef2b` | 111 通过、1 失败（26.7 分钟） |
| [p44-del](runs/p44-del.txt) | 交付 `f4ec61864` | 112 通过（12.9 分钟） |
| [p44-rerun-ref-chromium-dark-desktop](runs/p44-rerun-ref-chromium-dark-desktop.txt) | 参照，补跑参照失败的用例（[scripts/p44-rerun.sh](scripts/p44-rerun.sh)） | 1 通过（25.4 秒） |
| [p44-rerun-del-chromium-dark-desktop](runs/p44-rerun-del-chromium-dark-desktop.txt) | 交付，同一用例与环境 | 1 通过（13.6 秒） |

参照的 1 个失败：Chromium 暗色桌面的计划用例，章节页 `page.goto` 之后 15 秒内没有画出（只画出了侧栏，主机负载约 99）。该用例在两棵树上同一环境补跑，都通过：9 张截图 2 张逐字节相同、6 张抗锯齿级、1 张超出（`p44-plan-edit-kinds`，被替换列表自绘的滚动条），12 步语义 0 处不同（[compare/p44-rerun-chromium-dark-desktop-summary.json](compare/p44-rerun-chromium-dark-desktop-summary.json)、[-trace-semantics.json](compare/p44-rerun-chromium-dark-desktop-trace-semantics.json)）。正式运行里只有交付一侧的那张 `p44-plan-section` 因此也有了对照：逐字节相同。

截图 496 对（14 个用例 × 8 个环境，参照失败的用例少 1 张）：**260 张逐字节相同，158 张抗锯齿级，77 张超出**，1 张只有交付一侧（补跑的那一对另行比较）。数据文件：汇总 [compare/p44-summary.json](compare/p44-summary.json)，逐张数据 [compare/p44-compare.json](compare/p44-compare.json)，>2 级像素的区域 [compare/p44-beyond-clusters.txt](compare/p44-beyond-clusters.txt)，超出的逐张归类 [compare/p44-beyond-classes.json](compare/p44-beyond-classes.json)（[scripts/classify.py](scripts/classify.py) 按下表的规则生成）。超出的截图：边缘栅格化与加载点静止帧放在一张放大裁切图上（[shots/p44-edges.png](shots/p44-edges.png)：参照、交付、>2 级像素），其余是完整截图（[shots/p44-beyond](shots/p44-beyond)）。

| 类别 | 张数 | 截图与环境 | 说明 |
| --- | --- | --- | --- |
| 条目抽屉在手机上的 40px 按钮 | 20 | `p44-entry`、`-reject`、`-more`、`-edit`、`-retire`，四个手机环境 | 见[未消除的差异](#未消除的差异)第 1 条：参照里这排按钮是 32px，交付恢复成设计的 40px，抽屉其下的内容随之下移 8px |
| Select 打开时不高亮第一项 | 8 | `p44-settings-workspaces`，八个环境 | P4.3a 已记录、交协调者决定的公共组件差异：被替换的 Select 没有选值时打开即高亮第一项（最多 10–15 级） |
| 被替换列表自绘的滚动条 | 7 | `p44-plan-edit-kinds`，七个环境 | 被替换的 Select 用虚拟列表，打开后自绘的滚动条会显示约 1 秒；Orbit Select 用原生滚动，测试浏览器隐藏原生滚动条。第八个环境（Chromium 暗色桌面）参照截图时这条滚动条已经隐去，两张为抗锯齿级 |
| 在编号上方的卡片：纵向取整 | 4 | `p44-doc-footnote-44`，四个桌面环境 | 卡片翻到编号上方时，rc-trigger 以下边缘定位（`bottom: 80px`，上边缘 623.78），Base UI 取整上边缘（624），差 0.22px，卡片里部分文字行落到下一像素行 |
| 被替换的说明在面板下仍开着 | 4 | `p44-doc-mark-footnote`，四个手机环境 | 见[未消除的差异](#未消除的差异)第 2 条 |
| 加载点的静止帧 | 3 | `p44-landing`、`p44-links-loading` | 加载圈的静止帧（最多 20 级） |
| WebKit 里新遮罩下按钮保持悬停 | 1 | `p44-settings-setup`，WebKit 暗色手机 | 按下 Set up… 后对话框盖上来，指针没有移动；交付一侧遮罩下的按钮仍是悬停色（WebKit 要等指针移动才更新悬停），参照一侧不是 |
| 边缘栅格化 | 30 | 各环境 | 图标、单选圆点、圆角边缘的个别像素（每张 >2 级 1–23 个），以及条目 ⋯ 菜单的图标：末端对齐的菜单左缘 1092.266 对 1092.281（差 0.015px），文字落在同一像素，SVG 图标的抗锯齿不同（89–97 个像素） |

计算样式差异的类别与 P3.2–P4.3a 相同：对话框的 `surface` 选择器在参照命中 AntD 的透明外层、在交付命中本身就是表面的 `.orbit-overlay`；行高的数值精度（`22px` 对 `22.000019px` 一类）。

**trace**（[compare/p44-trace-semantics.json](compare/p44-trace-semantics.json)，两棵树的逐步记录在 [traces/](traces)）：两边都跑完的 111 个用例、700 步。

- 语义字段（地址、请求的方法/路径/请求体、通知、菜单项与禁用、alert、打开的选择、列表选项、标记说明、脚注卡片头与去往原文的方式、行与卡片数）：**只有 2 步不同，都是默认落地页 “landed” 一步的观察时机**：两棵树都先到 `/workspaces/<id>`，桌面上会话工作区（P5.3，两树代码相同）约半秒后再带到最近的会话 `/sessions/<id>`，用例只等前者；参照在 Chromium 明/暗桌面两个环境里观察落在第二次跳转之后。探针在两棵树上逐时记录（Chromium 明色桌面、WebKit 明色手机）：跳转序列与终点相同。
- 其余差在不属于业务语义的字段，都是 P2.1–P4.3a 已接受的约定：焦点 269 步（菜单、确认浮层与对话框打开时聚焦自身，关闭后回到打开它的按钮；参照多落在 body 或触发器上），打开的对话框 60 步（锚定的确认在 Orbit 里是 `role=dialog`，被替换的是 tooltip；被替换的确认框在文字里把标题重复一遍）。
- 每次按下都新生成的 `idempotencyKey`（新条目、退役、关注）按“存在”读：两边形如 `wiki-new:<uuid>`、`wiki-retire:<uuid>`、`<uuid>` 相同。

### P0 页面矩阵与标准 P0

| 运行 | 树 | 结果 |
| --- | --- | --- |
| [p0-ref](runs/p0-ref.txt) | 参照 `c55c2ef2b`，写出截图 | 80 通过、21 失败、11 跳过 |
| [p0-strict](runs/p0-strict.txt) | 交付对参照截图，`maxDiffPixels: 0` | 80 通过、21 失败、11 跳过——失败的 21 个与参照逐个相同，没有截图不符 |
| [p0-del](runs/p0-del.txt) | 交付 `f4ec61864`，写出截图 | 80 通过、21 失败、11 跳过（同上） |
| [p0-standard](runs/p0-standard.txt) | 交付，标准 P0 回归 | 52 通过、49 失败、11 跳过 |
| [p0-standard-base](runs/p0-standard-base.txt) | 起点 `896226a23`，标准 P0 回归 | 52 通过、49 失败、11 跳过——与交付逐个相同、原因相同 |

- **基础漂移，起点与交付相同**（按协调者的开工提醒列出，不由本批修、不登记）：
  - 两套 P0 里所有失败都来自 main，不来自本批：P0 矩阵的 21 个失败全部是“每个 API 调用都要有浏览器夹具”的检查报出 `GET /api/auth/capabilities` 没有夹具（main 的 managed runner 项目 `94025579b` 新加的读取，P0 夹具没跟上）：8 个环境的 session、P2.3 生产通知，4 个桌面环境的 600/640/960px 两侧，Chromium 明色桌面的性能基线记录。截图都在这项检查之前拍完，比较照常进行。
  - 标准 P0 的 49 个失败：上面这类 9 个（8 个 P2.3 生产通知、1 个性能基线），以及 40 个截图不符：4 个桌面环境各 9 个用例（session、wiki、task、settings、projects、profile、projects 加载、projects 出错再重试、600/640/960px 两侧，共 36 个，正是协调者转告的 Infrastructure 页 `33e0e2e09` 带来的漂移：侧栏多了 Infrastructure 一项）与 4 个手机环境的 session。
  - 交付与起点在标准 P0 上失败的用例、环境与原因逐个相同（[scripts/failures.py](scripts/failures.py) 列出两份报告的失败再 diff，见 [checks/p0-standard-failures.txt](checks/p0-standard-failures.txt)）；40 张不符截图里 39 张交付与起点的实际截图逐字节相同，1 张（Chromium 暗色桌面 `projects-list`）差 6 个像素、最多 2 级（项目列表分段控件的圆角，P4.3a 记录过的栅格点）。不符截图的期望、实际与差异图在 [shots/p0-standard](shots/p0-standard)（Chromium 明色桌面 9 个用例与明色手机的 session；其余环境的同类截图留在 /mnt/data）。
- **漂移在 main 上已登记**：最终轮之后 P0 漂移第 7 批并入 main（`56c21bdd2`：`/api/auth/capabilities` 的 P0 夹具、Infrastructure 侧栏等登记）。交付与它的临时合并 `d064a3141` 上标准 P0 **101 通过、0 失败**（见[跟上 origin/main](#跟上-originmain)）。
- **P0 截图没有因本批改变**：严格比较里交付对参照的全部截图（含 Wiki 首页、目录与新条目对话框）以 0 像素逐张通过；标准 P0 的不符截图与起点相同。
- P0 矩阵写出的 252 张截图（参照与交付各一次运行）：**232 张逐字节相同、17 张抗锯齿级、3 张超出**（[compare/p0-summary.json](compare/p0-summary.json)）。超出的是 Chromium 暗色的 `breakpoint-639-projects`、`projects-list`、`projects-search-empty`，同一个分段控件圆角的 3–4 个像素（最多 4 级），与严格比较的逐张通过一起看，是两次运行之间的栅格化，不是两棵树的差别。计算样式差异：新条目对话框的 `surface` 是 P3.2 起已记录的选择器差别；`input` 一项是 main 原有定位器 `dialog.locator('input').first()` 的取样：参照落在 AntD Select 的搜索框（22px 高），交付落在 Base UI Select 供表单取值的隐藏输入（1×1），截图上不可见。
- 跳过的 11 个各树相同：7 个环境里的性能基线记录和 4 个手机环境里的 600/640/960px 两侧（配置只在别的环境跑它们）。

### 合并检查与组件矩阵

| 运行 | 命令（交付的完整检出） | 结果 |
| --- | --- | --- |
| [merge](runs/merge.txt) | `npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过（`tsc -b` 与 vite）；Vitest 382 个文件、4968 个测试全部通过（含英文文案守卫 `copyLanguage.test.ts`） |
| [overlays](runs/overlays.txt) | `npm run test:ui-overlays -w @orbit/web` | 176 通过 |
| [controls](runs/controls.txt) | `npm run test:ui-controls -w @orbit/web` | 32 通过 |
| choices（`runs/choices-<环境>.txt`，八个环境各一步） | `npm run test:ui-choices -w @orbit/web -- --project <环境>`（Popover、Tooltip 与各选择控件） | 679 通过、1 失败（八个环境各 85 个；Chromium 明色桌面 84 通过） |
| choices 复查（`runs/choices-recheck-{del,base}-{1,2}.txt`） | 失败的那个用例单独跑，交付与起点各两次 | 4 次全部通过 |

- choices 的失败是 Chromium 明色桌面的 “no-preference Dialog Popover Select exits restore one layer at a time”：三层弹层逐层关闭后，用例用一次真实的滚轮输入确认页面恢复滚动，这次没有记到那次输入（`scroll.input?.trusted` 为 undefined）。这是 P2 的生命周期用例，量的是对话框、Popover 与 Select 关闭后的滚动锁，本批的两处公共组件改动（Tooltip `toggleOnClick`、Popover `pointAtCenter`）都默认关闭、不在这条路径上；单独复查时交付与起点各两次都通过。主机当时负载约 30。

- 交证据前，在最终提交（交付加本目录）上再跑合并检查、apiserver 的 `npm test`（不连库的部分；其中的 removal 扫描读整棵树，包括本目录的日志）与 OrbitKit 的 Swift 全量测试（[scripts/final-checks.sh](scripts/final-checks.sh)）。这三次运行在证据提交里引用。

## 迁移清单

开工时与交证据前，都在交付上运行 `audit-antd.mjs --check-owners`：交付 `f4ec61864` 上 **0 未归属、0 待定**，P4.4 已无使用点（[checks/delivery-check-owners.json](checks/delivery-check-owners.json)，九份记录）。审计全文：交付 [checks/delivery-audit.json](checks/delivery-audit.json)，同提交参照 [checks/reference-audit.json](checks/reference-audit.json)。

[inventory-closure.mjs](inventory-closure.mjs)（P4.3b 的同名脚本，owner 改为 P4.4）对比同提交参照 `c55c2ef2b` 与交付 `f4ec61864`，结果在 [inventory-closure.json](inventory-closure.json)。每个点按审计自己的 `--check-owners` 规则（P0.1 清单加 inventory-delta 的九份记录）判归属：

- **使用点**：P4.4 负责的使用点 **55 → 0**：23 个生产文件、19 个测试文件、index.css 13 行（逐点列表见 `before.p44`），其中包括协调者转来的 `WikiReviewPage.decided.test.tsx`、`WikiShareButton.tsx`、`SharedWikiPage.tsx`、`SharedWikiPage.test.tsx`（2026-10-07c 记录）与 index.css 19729 `.ant-popover .watch-row-list`（2026-10-08b 记录：随 `WatchRelations` 的 Popover 一起改写成 `.watch-popover .watch-row-list`）。未归属 1 → 0（`App.managedRunner.test.tsx`，见下），待定 0 → 0；其它阶段两边相同：P5.1 28、P5.2 11、P5.3 95、P6 42、KEEP 1（`WikiMarks.tsx` 里说 AntD 图形的一句注释，P0.1 已定 KEEP，P6 的 `--check-retired` 仍会拦它）。
- **导入**：23 个生产文件不再导入 antd（导入前后逐文件列在 `files`）；`WikiRunPage` 不再用 `App.useApp`（Revert run… 的确认改用 `useConfirm`）。
- **审计计数**（参照 → 交付）：直接引用 antd 的生产文件 42 → 19，测试文件 62 → 49；含 `.ant-*` 选择器的测试文件 27 → 13，含裸 `ant-*` 类名的测试文件 28 → 13；`--check-retired` 阻塞文件 139 → 96。
- **命中行**（参照 → 交付）：`ant-class` 209 → 140、`ant-selector` 202 → 135、`antd-reference` 224 → 180、`provider` 75 → 62、`use-app` 6 → 4、`imperative-confirm` 11 → 10。`imperative-feedback` 221 → 221 是对 Orbit `useToast` 返回值 `message.success/error(...)` 的文字命中，不是 AntD 调用（P4.1–P4.3 相同）。

### main 带来的未归属点与清单记录

开工后跟上 origin/main `251c3de8f`，`--check-owners` 报出 2 个未归属点，都是 managed runner 项目（`94025579b`）带进 main 的测试文件，只用 antd 的 `App` 包裹被测组件。报告协调者后（请求 34d03o2iZn8f3mmhnHNSq，选项 0“按建议办”）：

- `src/web/src/App.managedRunner.test.tsx` 在本批的 `App.tsx` 范围内：由本批在业务切换里去掉 AntD `App` 包裹，改法同 `App.loginNext.test.tsx`（它测的路由不需要 AntD 的 provider）。去掉后照样通过，这个使用点随之消失，不写记录。参照树带回了包裹，所以参照上它是 1 个未归属点。
- `src/web/src/components/WorkspaceView.managedRunner.test.tsx` 归 **P5.3**，status 记 new，与其余 `WorkspaceView.*.test.tsx` 一致：新增 [2026-10-09c.json](../inventory-delta/2026-10-09c.json)（`2026-10-09`、`09b` 已被 P4.3b、P4.3a 占用），由 [build-record-09c.py](../inventory-delta/build-record-09c.py) 从交付 `29ef702b3`（src/web 与最终交付相同）的审计 [checks/record-09c-audit.json](checks/record-09c-audit.json) 生成，重新生成逐字节相同；[inventory-delta/README.md](../inventory-delta/README.md) 加了一行；单独一个提交。`verify-record.mjs` 用该次扫描的审计核对通过：1 个文件条目与审计一致，读入前 8 份记录后正好这 1 个点要它的新增条目，九份记录一起读时 0 未归属、0 待定；`2026-10-09b.json` 用它自己的审计复核仍然通过（[checks/verify-record-09c.txt](checks/verify-record-09c.txt)）。

## 协调者的判定与转告

协调者（会话 34b245G3NiwgVVUj2JFJw）的转告与判定，都已照做：

1. **2026-10-08 的三条任务评论**：`WikiReviewPage.decided.test.tsx`（main `6ec468a25`）、`WikiShareButton.tsx`、`SharedWikiPage.tsx`、`SharedWikiPage.test.tsx`（main 的 Wiki 分享改动）归 P4.4，随 Wiki 一并迁移；index.css 的 `.ant-popover .watch-row-list` 改归 P4.4，随 `WatchRelations` 的 Popover 一并处理。见[迁移清单](#迁移清单)。
2. **开工提醒（2026-10-09）**：已知的基础漂移——Infrastructure 页（`33e0e2e09`）让标准 P0 在 4 个桌面环境各 9 个用例失败、共 36 个，P4.2 同提交用例也有 5 个失败——在证据里按基础漂移列出、证明起点与交付相同，不由本批修、不登记（由第 7 批 34cswWfvNasFTq8kDM0Q4 处理）；作业指导的新规则（重运行放进独立 cgroup、最终轮之后跟上 main 的停止规则、改了文案周围标记要跑 OrbitKit 的 Swift 套件、英文文案守卫 `copyLanguage.test.ts`）；写清单记录前先请协调者定名；P4.4 的现有点包括 index.css 19729 与公开分享项目页的 AntD `List`。见[对照结果](#对照结果)与[OrbitKit 的文案对照测试](#orbitkit-的文案对照测试)。
3. **main 带来的 2 个未归属点**（2026-10-09，选项 0）：见[迁移清单](#迁移清单)。
4. **会话额度停下后的两次原位复活**（2026-10-09 15:26Z、16:37Z）：核对分支与工作树、看哪些运行已完整跑完、从中断处接着做；重运行放进独立 cgroup，队列脚本可续跑。第 2 次复活时最终轮还没有开跑，被停的只是开发用的对照运行（19:00Z 的任务评论记了当时的位置与下一步）。

## 未消除的差异

1. **条目抽屉在手机上的按钮高度：交付恢复 40px，参照是 32px**（20 张截图）。Wiki 的条目抽屉（2026-09-25 `c00eefef3` 引入）沿用任务面板的页头 `.tdp-head-actions`，手机上那里的按钮按设计是 40px 高（`.tdp-head-actions > .ant-btn { height: 40px }`）。P3.2 试点（`c4cc93eb7`，2026-10-06）把这条共享规则改写成 `.orbit-button` 时，Wiki 的抽屉还是 AntD 按钮，从此在 main 上落成 32px；本批把抽屉换成 Orbit 按钮后，这条规则重新生效。交付与 2026-09-25 的设计一致，与当前参照（main）不一致。没有为了贴合参照而加规则把它压回 32px。**请协调者确认**按设计恢复。
2. **手机上从标记说明打开脚注面板时，被替换的说明还开着**（4 张）。被替换的提示是点击触发（`trigger={['click']}`），只在点到外面时关闭；按下其中的 See footnote 打开底部面板后，它还压在遮罩下，面板关上后仍显示，焦点回到它的 See footnote。Orbit 的提示在面板拿走焦点时关闭，面板关上后焦点落在 body。页面上的内容与操作相同，差在面板关上后那条说明是否还留着。没有为此改公共组件。
3. **公共组件与 AntD 的三处一般差异，本批用页面规则按参照修正了自己的页面**（见[对照找到并修正的差异](#对照找到并修正的差异)）：Select 的值与箭头之间 8px（AntD 6 是 6px）、Menu 项最小 32px（AntD 没有最小高度）、Button 固定 22px 行高（AntD 6.6.5 的按钮继承上下文的行高）。别的页面用到同样的组合时会遇到同样的差别；建议另建任务在公共组件里统一，并用 P0 与已迁移批次的对照用例回归（直接改公共组件会改动已登记的 P0 截图，迁移任务不能这样做）。
4. **Select 打开时不高亮第一项**（8 张）：P4.3a 已记录、交协调者决定。
5. **被替换列表自绘的滚动条**（7 张）、**在编号上方的卡片的纵向取整**（4 张，0.22px）、**WebKit 新遮罩下按钮保持悬停**（1 张）、**加载点静止帧**（3 张）与**边缘栅格化**（30 张）：见[对照结果](#对照结果)的分类表。
6. **在本批之外的已有缺陷，参照里就有**：
   - 手机上会话页的关注徽标浮层：被替换的 Popover 超出视口右缘 16px，把页面撑到 406px 宽（用例的视口检查因此拒绝在参照上截这张图，改为在 trace 里记页面与浮层的宽度，见 `traces/` 的 “waiting on, widths” 一步）；交付不超出。
   - 脚注底部面板的 12px 顶部圆角在参照里从未生效（见[业务切换](#业务切换)）。
   - 默认落地页的 “landed” 一步只等第一次跳转（见[对照结果](#对照结果)），用例是本批的；两棵树行为相同。

## 未确立的部分

- 只在 Linux 上的 Playwright Chromium/WebKit 模拟中比较，没有真机，也没有用读屏软件实测；手机的触屏是模拟的指针按下。
- 同提交截图对照只在减少动态效果下做；被替换的弹层不管这个设置照样播放入场动画（用例等它们“画完”再截图），本批没有逐帧对照动效。
- 后端是固定 REST 数据，不连真实服务；会话原文（`/sessions/se4`）在夹具里回 404，用例只验证面板的按钮带到会话路由。
- 主机在最终轮期间负载 25–99（其它会话的 vLLM、Gradle、模拟器），P4.4 参照有 1 个用例超时、choices 有 1 个计时用例失败，都单独补跑（见[对照结果](#对照结果)）；补跑与正式运行不是同一次运行。
- `pointAtCenter` 只在本批的三处脚注卡片（文档、文章、公开 Wiki 页；正常、靠右与翻到上方三种位置）与单测里验证，没有加进 choices 组件矩阵；默认关闭，别的调用方不受影响。
- 条目抽屉手机按钮的 40px 是按 git 历史与原设计判断的，参照（main）上是 32px，见[未消除的差异](#未消除的差异)第 1 条。

## 复现

```bash
# 三棵树（都在 /mnt/data），然后一次跑完同提交对照与最终检查（各步可续跑）
scripts/make-trees.sh f4ec61864 90ce00944 896226a23   # 参照 c55c2ef2b = 交付撤回业务切换；起点 origin/main 896226a23
scripts/formal.sh runs3            # 日志在 /mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1/runs3/<name>.txt
scripts/p44-rerun.sh runs3         # 正式运行里失败的 P4.4 用例，两棵树同一环境各再跑一次
scripts/analyze.sh runs3           # P4.4 与 P0 矩阵两对的比较
python3 -I scripts/classify.py /mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1/compare-runs3   # 超出截图的逐张归类
scripts/audit.sh f4ec61864         # 审计（交付与参照）、--check-owners、记录核对、关闭对照与入口闭包
scripts/collect.sh runs3           # 本目录的副本（报告去掉附件正文）
scripts/final-checks.sh <最终提交> final   # 合并检查、apiserver npm test、OrbitKit swift test
# 清单记录 2026-10-09c（在仓库根目录；审计是交付 29ef702b3 上的扫描）：重新生成应逐字节相同，再核对
python3 -I docs/evidence/base-ui-migration/inventory-delta/build-record-09c.py docs/evidence/base-ui-migration/p4.4/checks/record-09c-audit.json | cmp - docs/evidence/base-ui-migration/inventory-delta/2026-10-09c.json
node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs docs/evidence/base-ui-migration/p4.4/checks/record-09c-audit.json 2026-10-09c.json
# P4.4 用例单独运行（在要比较的树的 src/web 下）：
P44_SNAPSHOTS=<dir> P44_OUTPUT=<dir> npx playwright test --config ui-migration/p44.config.mjs --update-snapshots=all
# 开发时的单环境对照与探针：scripts/dev-run.sh、dev-all.sh、dev-compare.sh、probe-run.sh（探针文件不提交）
```
