# P5.3 会话工作区迁移与核心流程回归

服务于 [P5.3 完成会话工作区迁移与核心流程回归](orbit-task:34Za39Ov1yysHZaYL6wgJ)，项目验收条目 key `4Un2KxG0vLBv3dXWCfnqwK`：**P5：会话工作区完成迁移，输入、附件、富内容、消息操作及滚动导航行为无迁移回归。** 本任务是 P5 的收尾：`WorkspaceView` 的输入框、附件、菜单与浮层、会话列表与会话头部的操作、`WorkspaceConsole` 的读取状态全部离开 AntD；核心流程有浏览器、模拟器与单测的直接证据；会话阶段剩余的 AntD 使用点清零。

本批接在项目 tip `c1a1194f6` 上（开工时与 origin/main `11b2e0360` 持平），5 个提交：4 个自己的，1 个合并（origin/main `6fa5196e5`）。交付 `b72da6eda`，之上是本目录所在的提交，见[提交](#提交)。

## 结论

| 验收要点 | 结果 |
| --- | --- |
| 会话阶段剩余 AntD 使用点清零 | P5.3 的 97 个使用点（2 个生产文件、40 个测试、index.css 54 行上的 55 处）在交付上为 0；`--check-owners` 0 未归属、0 待定，其余归属（KEEP 1、P6 42）不变。会话工作区的路由（`/workspaces/:id/*`、`/agents/:id/*`、`/sessions/:id`，由 `WorkspaceConsole` 画出）静态可达 228 个模块，没有一个导入 antd（参照 226 个模块里 2 个，都归 P5.3）。运行时普查：交付 592 步里只有根上的 `ant-app`（`main.tsx` 的 App，归 P6）。见[迁移清单](#迁移清单)。 |
| 输入：发送/排队/中断/重试、IME、候选菜单、手动高度、流式顺序与滚动跟随 | 同提交对照（交付对撤回业务切换的参照，Chromium/WebKit × 明/暗 × 桌面/手机 8 个环境）正式轮 f1，两棵树都是 56/56 通过。输入框长高、到 12 行后滚动、拖出的高度与双击复位（桌面）、发送、流式按序、排队与停止、斜杠/提及/引用菜单、中文组合输入；每步记录的输入框状态（值、选区、高度、是否滚动、shell 模式、镜像的 chip、附件、菜单、Send/Stop、模型与选择器）、会话行的次序、到尾部的距离、发出的请求与请求体，两棵树逐字相同。 |
| 附件 | 粘贴、拖放、选图后的缩略图、点开预览、移除，两棵树的状态与请求相同；预览的按钮名称与焦点按 P5.2 已验收的约定。模拟器上经 Android 照片选择器选图、点缩略图打开预览、双指放大、点关闭、× 移除也都通过。 |
| 富内容与消息操作 | 会话列表的行菜单、按住时的菜单、范围菜单（视图、按标签筛选、新文件夹）、文件夹菜单，会话头部菜单与标签、Find、Rename…、Share、Move、Delete，三种确认框，链接到一条记录与不存在的会话：菜单项（禁用、选中、子菜单、✓、原生提示）、对话框文字与按钮、列表的行、请求，两棵树逐字相同；差异只在焦点与对话框角色，多数落在已验收的约定里，另有三条交协调者判（[对照结果](#对照结果)、[未消除的差异](#未消除的差异)）。审批与结果卡片本批没有改动，核对见[自有实现的核对](#自有实现的核对)。 |
| 滚动导航 | 链接到一条记录、手机上的 ← / 前进 / 后退、流式时停在尾部，两棵树相同。 |
| 浏览器、模拟器与真实手机 | 浏览器：8 个环境的同提交对照，278 张截图里 179 张逐字节相同，46 张抗锯齿级，53 张超出，逐张归类（[对照结果](#对照结果)）。**模拟器（HPC emulator-5554，API 36，Chrome for Android + Gboard）**：软键盘顶起输入框、Gboard 打字与回车发送、系统返回与边缘滑动返回、按住选词、按住打开行菜单、照片选择器、预览的点按与双指缩放，两棵树各 23/23 通过，差异只在焦点与名称的约定（[模拟器](#模拟器hpc-emulator-5554api-36chrome-for-android--gboard)）。**真实手机：未执行**，一页清单 [real-phone-checklist.md](real-phone-checklist.md)「待账号所有者于 P7.2 部署后执行」，在证据里记为缺口。 |
| 单测、合并检查、P0、OrbitKit | 合并检查（交付 `b72da6eda`）：类型检查与构建成功，Vitest 399 个文件、5163 个用例全部通过；OrbitKit 3669 个测试 0 失败。P0 页面矩阵两棵树都是 101 通过。标准 P0：起点 101 通过，交付 95 通过、6 失败，失败都在会话页的附件两张截图上（桌面的输入框轮廓来自焦点交还，手机是 P2.2 的 17px 附件菜单），是本批的迁移差异，要协调者 CONFIRM 后才能登记，见[合并检查与 P0](#合并检查与-p0)。 |

未消除的差异见[未消除的差异](#未消除的差异)；没有确立的部分见[未确立的部分](#未确立的部分)。

## 范围

开工时（项目 tip `c1a1194f6`）按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`：P5.3 负责 97 个使用点，逐点见 [inventory-closure.json](inventory-closure.json) 的 `before.p53`（参照树就是开工时的使用点：交付撤回业务切换）：

- 生产文件 2 个：`WorkspaceView.tsx`（`import { App as AntApp, Button, Dropdown, Image, Input, type MenuProps, Popover, Select, Spin, Tooltip } from 'antd'`）、`WorkspaceConsole.tsx`（`Button`、`Result`、`Spin`）。
- 测试 40 个：`ApprovalPanel` 2 个、`WorkspaceView.*` 38 个。多数只用 antd 的 `App` 包裹 WorkspaceView，另有按 AntD 类名找菜单、确认框和选择器的。
- index.css 54 行上的 55 处：41 处 `.ant-*` 选择器，14 处提到 AntD 的注释。

清单里还有 3 个已是自有实现、`reviewPhase` 为 P5.3 的文件（`ApprovalPanel`、`BackgroundShellsTray`、`TaskRunHandoffNotice`），以及 P3.1 交付、P5.3 再次回归的 `ComposerMirror`，按“已有自有实现以核对复用为主”核对，见[自有实现的核对](#自有实现的核对)。

范围外、本批只读不改：P5.1 的会话侧栏/搜索/输出，P5.2 的 Transcript 图片与查看器，`main.tsx` 的 `ConfigProvider`/`App` 与 `theme.ts`（P6）。

## 跟上 origin/main

| 时刻 | origin/main | 做法 |
| --- | --- | --- |
| 开工 | `11b2e0360` | 项目 tip `c1a1194f6` 已含它，本批接在项目 tip 上。 |
| 正式轮之前（10-10 10:53 UTC） | `6fa5196e5`：项目 tip 之后 9 个提交（wiki worker 的维护轮次、shared 的 wiki 合约、一次发布），`src/web` 没有改动 | `git merge-tree` 预演无冲突；合并为 `b72da6eda`。main 已含项目 tip（`52db68ba2` 把项目合进 main），所以正式轮的起点树就是 `6fa5196e5`。 |
| 交证据前（10-10 11:39 UTC） | 仍是 `6fa5196e5`，项目 tip 仍是 `c1a1194f6` | 不用再合；交付 `b72da6eda` 已含 main。 |

## 提交

| 提交 | 内容 |
| --- | --- |
| `799c8d3cc` | feat(web)：`Menu`、`Popover` 可用 span 作触发器（`nativeButton={false}`）；菜单项的原生提示（`title`）；`Result` 的 404 图（`ResultNotFound.tsx`，被替换的 Result `status="404"` 的图，MIT，注释指向本目录已有的 Ant Design 许可文件）。单测：`Menu.spanTrigger`、`Popover`、`Result`。 |
| `10e9c2bbf` | feat(web)：`Tooltip` 的 `trackTrigger`、`Menu` 的 `submenuOverflow`、结尾对齐的列表取自己盒子的小数边缘。单测：`Floating.submenu`、`Floating.dropdown`。`ui/README.md` 同步。 |
| `c868a02c2` | feat(web)：业务切换。`WorkspaceView.tsx`、`WorkspaceConsole.tsx`、index.css、41 个测试。参照树撤回的就是这一个提交。 |
| `128646c01` | test(web)：P5.3 的同提交对照用例（`ui-migration/p53.browser.mjs`、`p53-fixtures.mjs`、`p53.config.mjs`；标准 P0 忽略它们）。 |
| `b72da6eda` | 合并 origin/main `6fa5196e5`。 |

## 公共组件

都在 `components/ui/`，用法写进 `ui/README.md`；只加了这批真正用到的入口，默认行为不变。

- **`Menu` / `Popover` 的 `nativeButton={false}`**：触发器是页面画成文字或 ⋯ 的 span 时（会话列表的范围菜单、文件夹的 ⋯、按住时菜单的落点、输入框工具栏的上下文用量环），由组件给它 button 角色、Tab 停留点和 Enter/Space，外观仍是页面的。
- **菜单项的 `title`**：项自身的原生提示，可用与禁用的项都带（会话行的 Complete 不可用时说明原因），同被替换菜单项的 `title`。
- **`Menu` 的 `submenuOverflow="slide"`**：子菜单在行旁放不下时照常翻到另一侧，仍越出布局视口的部分滑回视口、盖在自己的菜单上，同被替换子菜单 builtinPlacements 的 shiftX。输入框的模型菜单在 390px 手机上，Provider 一级原先从屏幕外 104px 处开始。
- **`Tooltip` 的 `trackTrigger={false}`**：打开时按触发器定位，之后不再跟随，同被替换提示只对齐一次。用在会转动的触发器上（会话行与工作指示的 Spinner），它的盒逐帧变化，跟随会让提示上下晃动。
- **结尾对齐列表的小数边缘**：`useDropdownPlacement` 把列表左缘的小数部分从列表自己的盒子读出。Floating UI 的宽度取自计算样式（143.796875px 的列表读成 143.797），左缘因此比被替换的列表差 1/64px，从行尾开始、向下取整的子菜单就左移 1px（范围菜单的 Filter by Tag）。只影响结尾对齐、宽度带小数的列表，量的是同一个盒子。
- **`Result` 与 `ResultNotFound`**：`WorkspaceConsole` 的“会话不存在”沿用被替换 Result 的 404 图与排版。

## 业务切换

| 区域 | 被替换 | 交付 |
| --- | --- | --- |
| 输入框 | `Input.TextArea`（经 `resizableTextArea.textArea` 取 DOM）、`Dropdown`（+ 菜单、模型菜单）、`Select`（模式等工具栏选择器）、`Popover`（上下文用量）、`Image`（新选图片的缩略图与预览）、`Button`、`Spin` | Orbit `Textarea`（ref 就是 textarea；P3.1 的自动增高、手动高度、镜像共用 `.composer-field` 的度量）、`Menu`（附件变体；模型菜单 `submenuOverflow="slide"`）、`Select`、`Popover`（`nativeButton={false}`）、`Image` 与其预览（P5.2）、`Button`、`Spinner`。键位、菜单、粘贴、历史与发送逻辑原样留在 WorkspaceView。 |
| 会话列表 | 行 ⋯ 与按住时的 `Dropdown`、范围菜单与标签子菜单、文件夹 ⋯ 与文件夹页的 ⋯、状态提示 `Tooltip` | `Menu`（行菜单的 ⋯ 与按住时的落点、范围菜单的文字、文件夹的 ⋯ 都是原来的元素）、`Tooltip`（Spinner 上的 `trackTrigger={false}`）。 |
| 会话头部 | `Dropdown`（Find、标签组、Complete、Rename…、Move…、Copy link、Share…、Download HTML、Delete） | `Menu`（标签项 `closeOnSelect: false`，选中照旧打 ✓）。 |
| 确认 | `App.useApp().modal.confirm` ×6（撤回唤醒、移到回收站、永久删除、启用 worktree 隔离、清理 checkout、删除文件夹） | `useConfirm`（P2.1 的异步确认：保留 promise 与失败时不关闭的语义，`returnFocus` 指向发起的 ⋯）。 |
| 读取状态 | `WorkspaceConsole` 的 `Spin`、`Result`、`Button` | `Spinner`、`Result`（404 图）、`Button`。 |

从菜单打开的输入框（Rename…、New Folder…、Find）在菜单把焦点交还给它的按钮之后才打开：早一步打开，输入框可能与菜单的卸载落在同一次提交里，菜单随后把焦点还给按钮，输入框失焦即关闭。这是 P4.2 在 WebKit 上找到的同一机制，本批照 P4.2 的改法；文件夹行的 ⋯ 在菜单关上时隐藏、按住时的落点随菜单一起卸载，它们收不回焦点，也就没有这场竞争，输入框在下一个任务里打开。

index.css：菜单与输入框的 `.ant-*` 选择器改成 Orbit 的类，保留被替换控件实际画出的值。被替换菜单自己的项规则（`.ant-dropdown .ant-dropdown-menu .ant-dropdown-menu-item`，0,3,0）压过了页面的一些声明，只有真正生效的声明被移植：引擎标题行只留底边线，子菜单箭头离行尾 8px、行尾留 24px，工具栏选择器的行高与外边距，头部菜单里选中又悬停的标签行的深色底，输入框的菜单打开时保留输入框的轮廓，按住时菜单的 240px 下限，16px 的 + / ❯ 按钮随字号变的行高。

测试：41 个文件。27 个只去掉 antd 的 `App` 包裹；14 个把按 AntD 类名或菜单 key 找元素改成按角色、名称与标签找（确认框读 `aria-labelledby`/`aria-describedby`，模型菜单的行按显示的名字），子菜单的悬停改为真实的 pointer/mouse 事件序列，输入框附件菜单的源码钉子从 `.composer-attach-menu.ant-dropdown-menu` 改为 Orbit 附件变体的规则。断言的值都没有改：附件菜单仍是 250px、26px、42.4px、17px、max-content、不换行；只有分隔线一处，旧钉子钉的是被 AntD 自己的规则压过、从未生效的 `9.5px 24px`，新钉子断言手机 CSS 不再改分隔线（P2.2 已按实测保留原分隔线）。删掉的 39 行 `expect` 都有对应的新写法，另多了 4 行（例如新建/重命名文件夹时断言输入框拿到焦点）。其中 `WorkspaceView.sessionProjects.test.tsx` 是 P5.1 的测试，不是使用点：它的悬停打开子菜单需要真实的指针事件。

## 自有实现的核对

| 文件 | 核对 |
| --- | --- |
| `ApprovalPanel.tsx` | 本批没有改动，不导入 antd。它的行为由 `ApprovalPanel.test.tsx`、`ApprovalPanel.stale.test.tsx`、`ApprovalPanel.dsh.test.tsx`、`ApprovalPanel.questionWrap.test.tsx` 断言（例如：调用有了结果或回合结束后不再提供回答、为什么不再提供，以及各类审批卡片的内容、没有常设的“总是同意”、拒绝时说明保留什么）；前两个在 WorkspaceView 里挂载它，本批只去掉了 antd `App` 包裹，断言不变。 |
| `BackgroundShellsTray.tsx` | 本批没有改动，只用 `@ant-design/icons`（保留）。`Transcript.backgroundTasks.test.tsx` 的“the tray”一组断言每行按种类命名、说出运行中的 workflow 在哪；折叠/展开与停止本批没有另外验证（组件与它的样式都没有改动）。 |
| `TaskRunHandoffNotice.tsx` | 本批没有改动，不导入 antd。由 `WorkspaceView.taskRunHandoff.test.tsx`（只改了找按钮的方式）与 `TaskDetailPanel.test.tsx` 断言。 |
| `ComposerMirror.tsx` | 本批没有改动。镜像与 `textarea.orbit-textarea` 共用 `.composer-field` 的同一组声明（P3.1 的约定）；本批删掉其中的 `textarea.ant-input` 选择器，值不变。同提交对照里提及 chip 的那一步（`p53-mention-chip`）8 个环境逐字节相同。P3.1 的 `test:ui-composer` 拿旧字段与 Orbit Textarea 比，旧字段一侧靠的正是这些选择器；P3.2、P5.3 按 P3.1 的约定删掉之后，那一侧已不是页面上的样子，这个工具只作 P3.1 的历史证据，本批没有再跑它。 |
| 审批与结果卡片 | `WorkspaceView.criteriaDecisionCard`、`acceptanceConfirmationCard`、`commitResultMessage`、`evidenceHandoff`、`openItemDelivery` 等测试只去掉 antd `App` 包裹，断言不变。 |

## 同提交对照

方法同 P5.1、P5.2：参照树是交付 `b72da6eda` 撤回业务切换 `c868a02c2`（本地提交 `8f94ddda9`，不推送）——会话工作区仍用 AntD，新的组件入口、P5.3 的用例与其余一切同交付；同一份用例在 P0.2 的环境（P0 的生产构建、固定数据与时间，`reducedMotion: 'reduce'`，各自的网络命名空间）里分别跑两棵树，比较截图、计算样式与每步记录。三棵树都在 /mnt/data，见[复现](#复现)。

**固定数据**（[`p53-fixtures.mjs`](../../../../src/web/ui-migration/p53-fixtures.mjs)）：在 P0 的会话上加一段上下文用量，放进一个更满的列表：一个在工作的会话、一个置顶的、一个失败的、一个已分享的、一个有合并冲突的、一个文件夹、已完成与回收站里的会话、两个标签、第二个工作区；运行器的模型与两个 provider 供模型菜单使用；输入框、菜单与确认发出的写（发送、排队、中断、撤回、上传、改名、标签、置顶、完成、回收、永久删除、文件夹、配置）都按请求体记录。

**用例**（每个环境 7 个，[`p53.browser.mjs`](../../../../src/web/ui-migration/p53.browser.mjs)）：

1. 输入框：打字长高、两行、13 行到顶后滚动，拖高 100px 与双击复位（桌面），发送，一个回合流进来时按序画出并停在尾部，排队一条再撤回，Stop。
2. 输入框的菜单：`/`、`@`、`#` 的候选菜单（方向键、Enter 选中、Esc），中文组合输入（Chromium 经 DevTools 的 `Input.imeSetComposition`；WebKit 用 insertText 加组合事件与 229 的 Enter，同 P3.1），组合中的 Enter 不发送。
3. 附件：粘贴、拖放（拖入提示）、选一张图的缩略图、悬停、点开预览、关闭、移除，文件条。
4. + 菜单与 shell 模式，工具栏的工作区与模式选择器，模型菜单与 Provider/Effort 两级（及选择后的值），上下文用量浮层（桌面悬停；手机点按，只记文字，见下）。
5. 会话列表：行与状态提示（工作中、失败、标签），行 ⋯ 菜单、Esc、Rename… 就地改名，Delete 的确认与 Cancel（桌面）；按住打开行菜单与 Pin（手机）；范围菜单、按标签筛选（子菜单）、恢复全部、New Folder… 就地命名；文件夹的菜单（桌面用行的 ⋯，手机用文件夹页的 ⋯——行的 ⋯ 只在悬停时出现）与 Delete Folder… 的确认；回收站里的行菜单与 Delete Permanently…（桌面）。
6. 会话头部：⋯ 菜单、给会话加/去标签（菜单保持打开）、Esc、Find in session、Rename…、Share 与 Move 对话框、Delete 直接移到回收站。
7. 链接到一条记录（`?record=1`），手机上从列表进会话、← 回列表、浏览器前进与后退，一个还在读取、随后不存在的会话（读取中 → 404 → Go home）。

**每步记录**：地址、焦点、输入框的状态（值、选区、placeholder、高度、是否滚动、shell 模式、镜像的 chip、附件、菜单、Send/Stop、+、模型与选择器）、会话的行（次序）、排队的气泡、到尾部的距离、会话列表的行、头部标题、打开的菜单项（禁用、选中、子菜单、✓、原生提示）、选择器的选项、对话框（角色、标题、文字、按钮）、浮层与提示的文字、Find 的输入、滚动锁、发出的请求及请求体，以及 AntD 类的运行时普查。逐字段比较由 [`trace-semantics.py`](scripts/trace-semantics.py) 做。

### 对照结果

正式轮 f1：参照 `8f94ddda9`、交付 `b72da6eda`，两棵树都是 56/56 通过（[runs/p53-ref.txt](runs/p53-ref.txt)、[runs/p53-del.txt](runs/p53-del.txt)）。

**截图**（[compare/p53-summary.json](compare/p53-summary.json)、[compare/p53-beyond-clusters.txt](compare/p53-beyond-clusters.txt)）：278 张里 179 张逐字节相同，46 张差异在抗锯齿级（每通道不超过 2 级），53 张超出，归为 7 类：

| 类 | 张数 | 截图与环境 | 说明 |
| --- | --- | --- | --- |
| 浮层在触发器上方：纵向取整 | 24 | `p53-model-menu`、`p53-model-effort`、`p53-model-provider`，8 个环境 | 被替换的菜单以下缘对齐触发器，各行高度带小数，上缘落在小数像素上（实测 599.44）；Orbit 取整为 599。12px 的值（orbitd@Claude、Max、Standard）与箭头因此差 1px（[sheets/beyond/](sheets/beyond/)）。同 P5.1 的“浮层在触发器上方：纵向取整”。 |
| 手机附件菜单的字号 | 4 | `p53-plus-menu`，4 个手机环境 | P2.2 的附件变体：手机上 17px 的标签（P2.2 任务指定；被替换菜单实际画的是 14px），其余实测布局相同；同一张里还有纵向取整带来的图标小数位移，Chromium 手机上另有 + 的悬停残留（下面第 5 类）。 |
| 行菜单打开时第一项的高亮 | 4 | `p53-row-menu`，4 个桌面环境 | 被替换的行菜单带 `autoFocus`：指针打开时焦点与高亮都在第一项 Complete。Orbit 菜单指针打开时焦点在菜单本身，第一项不高亮；键盘打开时照样高亮第一项。见[未消除的差异](#未消除的差异)第 2 条。 |
| 焦点交还后输入框的轮廓 | 4 | `p53-context-popover`，4 个桌面环境 | 前一步在模型菜单里选了模型：Orbit 菜单把焦点还给模型按钮（已验收的约定），输入框因 `:focus-within` 保持轮廓；被替换菜单把焦点丢到 body，输入框没有轮廓。浮层本身两棵树相同。 |
| 触屏模拟留下的悬停 | 8 | `p53-folder-menu`、`p53-header-menu`、`p53-mode-list`、`p53-scope-tags`，Chromium 两个手机环境 | 点按后，被点的触发器在交付上保持悬停色，在参照上没有。Chromium 的触屏模拟在点按后把鼠标移到 (0,0)，被替换浮层的动效（AntD 不理会减少动态效果）结束时按 (0,0) 重算悬停，触发器失去 `:hover`；Orbit 浮层没有动效，悬停保留。真实的 Chrome for Android（模拟器）上两棵树都保留点按后的悬停、底色相同（`rgba(0, 0, 0, 0.04)`，见[模拟器](#模拟器hpc-emulator-5554api-36chrome-for-android--gboard)），WebKit 的手机环境也没有这一类。`p53-scope-tags` 的这一行是 Filter by Tag：子菜单打开时 Orbit 一直高亮它，被替换菜单只在悬停时高亮。 |
| 菜单圆角的合成噪声 | 6 | `p53-scope-tags`，4 个桌面环境与 WebKit 两个手机环境 | 至多 33 个像素、3–4 级，都在根菜单与子菜单的四个圆角上；两个菜单的盒在两棵树里逐位相同（WebKit 实测根菜单 435.94/144.06、子菜单 576）。 |
| 抗锯齿级的零星像素 | 3 | `p53-find`（Chromium 暗色手机）、`p53-header-tags`（Chromium 明色手机）、`p53-tip-failed`（Chromium 暗色桌面） | 4–9 个像素、至多 5 级：手机头部返回箭头与失败图标的边缘，各轮之间时有时无。 |

表里引用的实测（按住时菜单的盒、模型菜单各行的纵向位置、范围菜单两级的盒、点按后悬停的取样、❯ 的行高、参照留下的子菜单）在两棵正式树上重新量过，见 [probe/](probe/)（[scripts/probes-final.sh](scripts/probes-final.sh)，场景在 [scripts/probe/](scripts/probe/)）。

**计算样式**（同一摘要的 `styleDeltas`）：70 处捕获有差异，三类：WebKit 上行高的小数 48 处（22px 对 22.000019px、25.142857px 对 25.142879px：Orbit 的控件用无单位的 1.5714285714，被替换控件给的是算好的值）；确认框 16 处（被替换对话框的 `role` 在透明的外层 `.ant-modal` 上，底色、圆角与阴影在里层；Orbit 的 `role` 就在面板上，量到的元素不同，盒的位置与大小、截图都相同）；Chromium 手机上被点按的触发器的底色 6 处（上表第 5 类）。

**Trace**（[compare/p53-trace-semantics.json](compare/p53-trace-semantics.json)）：56 个用例、594 步。语义字段不同的 172 步只在焦点、对话框（角色与名称）、浮层/提示的归类与参照的残留菜单上，没有一步的请求、输入框状态、会话行、列表、菜单项、对话框文字或按钮不同：

| 类 | 步数 | 说明 |
| --- | --- | --- |
| 打开菜单或选择列表时焦点进入 | 58 | + 菜单、模型菜单、头部菜单、范围菜单、文件夹菜单、行菜单与回收站行菜单、按住时的菜单：交付焦点在菜单里，参照在触发器、第一项或 body；模式选择器：交付焦点在选项上。协调者 2026-10-07 判定的 Menu 约定与 P2.2 的 Select 约定。 |
| 选择、Esc 或对话框关闭后焦点回到触发器 | 72 | Plan/High/Sonnet 5.5 选中后、Esc、Share 与 Move 关闭、Delete 移到回收站、Cancel、按标签筛选与删除文件夹之后：交付回到发起的按钮，参照多在 body。P2.1 的“逐层返回焦点”。 |
| 头部菜单里切换标签后焦点留在菜单里 | 8 | Chromium 4 个环境：保存期间标签行照旧禁用，被替换菜单把焦点丢到 body，Orbit 菜单把它移到菜单里下一个能拿焦点的项。见[未消除的差异](#未消除的差异)第 3 条。 |
| 确认框是 alertdialog，焦点在 Cancel | 16 | 移到回收站、删除文件夹、永久删除：标题、文字与按钮相同。P2.1 的约定。 |
| 图片预览的按钮名称与焦点 | 8 | 参照的按钮名是图标名（close、flipY…），交付是 Close、Flip vertically…；焦点在 Close。P5.2 的约定。 |
| 上下文用量浮层是对话框 | 8 | 参照记为提示（tooltip 角色），交付是以 Context 命名的对话框，文字相同。P5.1 的 Popover 先例。 |
| 参照在 WebKit 手机上留下的子菜单 | 2 | 在按标签筛选的子菜单里点一个标签后，参照的子菜单留在屏幕上（筛选已生效、根菜单已关），用例记下 `leftOpen: ["AllDesignOps"]` 并点一下空白处关掉它；交付整个菜单关闭。两次选择各记一次（另一次与第 2 类同在“按标签筛选之后”那一步）。 |

**运行时普查**：参照在 592 步里画出 AntD 的类（`ant-dropdown-*`、`ant-select-*`、`ant-popover-*`、`ant-modal-confirm-*`、`ant-image-preview-*`、`ant-input`、`ant-spin-*`、`ant-tooltip-*`、`ant-result-*` 等 142 种），交付 592 步里只有根上的 `ant-app`。

**并排图**：[sheets/key/](sheets/key/) 是 8 个关键状态（输入框两行、斜杠菜单、附件缩略图、+ 菜单、模型菜单的 Provider 一级、头部菜单、删除文件夹的确认、404）在 8 个环境的参照 | 交付 | 差异图（半尺寸）；[sheets/beyond/](sheets/beyond/) 是全部 53 张超出的对，裁到差异所在处。

### 开发中对照找到并修正的差异

开发时逐环境对照（[scripts/dev-run.sh](scripts/dev-run.sh)、[dev-compare.sh](scripts/dev-compare.sh)、[probe-both.sh](scripts/probe-both.sh)）找到并在交付里修正的：

1. **手机上按住时的菜单宽度**：被替换的 Dropdown 对零宽的落点不设 `min-width`，`.session-row-menu` 的 240px 才生效（桌面 ⋯ 的菜单则跟 32px 的 ⋯，实际按内容宽 168.59px）。改为 `.orbit-menu.session-press-menu` 的 240px，只对按住时的菜单。
2. **模型菜单的引擎标题行**：被替换菜单自己的项规则压过了这一行的 padding、margin、圆角、指针与悬停，只剩底边线生效；只移植底边线。
3. **子菜单的箭头**（模型菜单、范围菜单）：行尾留 24px，12px 的箭头离行尾 8px，在行内居中。
4. **工具栏的选择器**：行高、外边距与高度按被替换的 Select。
5. **头部菜单里选中又悬停的标签行**：较深的选中底色。
6. **输入框的菜单打开时**：保留输入框的轮廓（`:has([data-popup-open])`，焦点此时在菜单里）。
7. **手机上模型菜单的 Provider 一级**从屏幕外 104px 处开始：`submenuOverflow="slide"`。
8. **Spinner 上的提示**随转动的盒上下晃动：`trackTrigger={false}`。
9. **范围菜单的子菜单左移 1px**（结尾对齐列表 1/64px 的取整）：见[公共组件](#公共组件)。
10. **从菜单打开的输入框立即关闭**：jsdom 与减少动态效果时，Base UI 的焦点归还在输入框获得焦点之后，先用下一个任务推迟；WebKit 上这个计时器仍会与菜单的卸载落在同一次提交（Rename… 与 New Folder… 在 WebKit 明色桌面与暗色手机各失败一次），改为 P4.2 的等焦点交还。修正后 WebKit 4 个环境 × 列表与头部两个用例 × 3 次，24/24 通过（[checks/webkit-race.txt](checks/webkit-race.txt)）。
11. **shell 模式的 ❯ 在 WebKit 下偏 1px**：被替换按钮的行高随 16px 字号变成 25.14px，Orbit 按钮固定 22px；16px 的 + / ❯ 按钮改用 1.5714 的行高后，`p53-shell` 在 WebKit 明色桌面与手机逐字节相同。

用例本身在开发中也改过两处，都不掩盖差异：手机上文件夹的菜单改从文件夹页的 ⋯ 打开（行的 ⋯ 在触屏上不出现，之前用脚本派发点击，不是真实路径）；参照在 WebKit 手机上留下的子菜单如上表记录后再关掉，桌面上菜单没关照样判失败。

## 模拟器（HPC emulator-5554，API 36，Chrome for Android + Gboard）

**这是模拟器，不是真实手机。** 按协调者的决定（请求 `34dOQT0PhGu7qD6OdjBIk` 选项 0，任务评论 `34dOR7YcVyV5J6KrlXRci`）在 HPC 的 Android 模拟器上跑，真实手机记为缺口（[真实手机](#真实手机)）。设备：emulator-5554，API 36（Android 16，google_apis userdebug），1080×2400、420dpi（CSS 视口 412×783，dpr 2.625），手势导航；Chrome for Android 133.0.6943.137；Gboard（默认设置，只有英文）。设备操作前先 `adb start-server`，再拿 `/var/lib/orbit/android/ui.lock`，跑完放开。

**做法**（[android/](android/)）：两棵树的构建各用 `vite preview` 起在本机 127.0.0.1（参照 4384、交付 4383），`adb reverse` 到设备，Chrome 打开的就是 http://127.0.0.1:端口。页面经 Playwright 的 Android 连接（CDP）读取，固定数据与桌面对照相同（P0 + P5.3，经 `page.route` 应答）；**输入全部是设备自己的**：`adb shell input tap/swipe/keyevent`、Gboard 屏幕键盘上的按键、Android 的照片选择器，双指缩放是写进触摸屏输入设备的多点触控事件（`mkpinch.py`、`pinch.sh`）。脚本 [emu-steps.mjs](android/emu-steps.mjs) 按同一顺序在两棵树上各跑一遍，每棵树都从重新启动的 Chrome 开始，每步记下看到的事实与是否符合预期（[android/record-ref.json](android/record-ref.json)、[android/record-del.json](android/record-del.json)）。

**结果**（最终一遍在两棵正式树上：参照 `8f94ddda9`、交付 `b72da6eda`，10-10 11:35–11:37 UTC；ui.lock 只在这两分钟里持有）：两棵树都是 23/23。23 步里 18 步记下的事实逐字相同，5 步不同，都是焦点与名称的已验收约定。并排图（左参照、右交付，设备截图的一半大小）在 [android/sheets/](android/sheets/)。

| # | 步骤 | 两棵树记下的事实 |
| --- | --- | --- |
| 1–2 | 打开会话，点输入框 | Gboard 弹出（`mInputShown=true`）；可视视口从 783 缩到 471px、上移 312px，输入框在可视视口的 373–455px，整个在键盘上方；焦点在 textarea。相同。 |
| 3 | 在 Gboard 上按 h-e-l-l-o | 值为 `Hello`（Gboard 自动大写）；5 次 keydown 229 加 5 次 `beforeinput insertText`，没有组合事件。相同。 |
| 4 | 按 Gboard 的回车 | keydown `Enter`（13）发送：请求体 `content: "Hello"`，输入框清空，键盘仍在。相同。 |
| 5 | 系统返回键 | 只收起键盘，仍在会话页。相同。 |
| 6–7 | 点会话头部的 ⋯，再点空白处 | 菜单打开、关闭；被点的 ⋯ 两棵树都保持悬停色 `rgba(0, 0, 0, 0.04)`（这正是浏览器对照里第 5 类在 Chromium 模拟中丢掉的那一个）。焦点：参照在 ⋯ 上、关闭后到 body；交付在菜单里、关闭后回到 ⋯（约定）。 |
| 8–9 | 点模式选择器，再点空白处 | 6 个选项相同，触发器两棵树都保持悬停。 |
| 10–11 | ⋯ → Find in session，在 Gboard 上打 interface，关闭 | 查找框拿到焦点、键盘弹出，1 处高亮。相同。 |
| 12 | + → Image → Android 照片选择器 → 选图 → Done | 菜单 5 项相同；照片选择器（`com.google.android.photopicker`）打开，选完回到 Chrome，上传一次，出现一张缩略图。相同。 |
| 13 | 点缩略图 | 预览打开。按钮名称：参照是图标名（第一个为空），交付是 Close、Flip vertically…；焦点在 Close（P5.2 的约定）。 |
| 14 | 两指张开 | 两个触点到达页面（`touchstart:2`），图片从 1 倍放到 3.67 倍。相同。 |
| 15–16 | 点 Close，再点 × | 预览关闭，焦点回到缩略图（参照的 `div.ant-image`、交付的 `span.orbit-image`）；× 移除。 |
| 17–18 | ← 回列表，按住一行 0.9 秒，点 Pin | 菜单在手指处打开，宽 240px（参照左缘 129、交付 129.14），6 项相同，没有选中文字；Pin 发出请求，菜单关闭。焦点：参照在 body，交付在菜单里（约定）。 |
| 19 | 点开一行，系统返回键 | 从会话回到列表。相同。 |
| 20 | 点开一行，从屏幕左缘向右滑 | 手势返回，回到列表。相同。 |
| 21–22 | 打开 `?record=1`；打开不存在的会话，点 Go home | 第 1 条记录在视口内（81–164px）；404 图与 Go home 相同。 |
| 23 | 在回复上按住一个词 | 选中 `existing`，Chrome 的选择把手与 Copy/Share/Select all 出现。相同。 |

**模拟器上没有做到的**：中文组词——这台 Gboard 只有英文、按默认设置逐字提交，`compositionstart` 一次也没有，组词只在真机清单里；双指缩放之外的手势（拖动、捏回）；横屏。

## 真实手机

**未执行。** 本任务没有真实手机。一页可独立执行的清单 [real-phone-checklist.md](real-phone-checklist.md) 覆盖软键盘顶起输入区、拼音组词、组词中与组词外的回车、长按选择、滑动/系统返回、按住打开行菜单、Find、照片选择与预览的触控，**待账号所有者于 P7.2 部署后执行**（账号所有者已答：真机检查放到 P7.2 部署后）。这一项在证据里记为缺口，不记为通过；模拟器的结果不能代替它，尤其是中文输入法的组词（模拟器上没有做到，见上）。

## 单测

- 业务切换改了 41 个测试文件（40 个使用点加 P5.1 的 `WorkspaceView.sessionProjects.test.tsx`），改法与断言的核对见[业务切换](#业务切换)末段。
- 公共组件的新入口各有单测：`Menu.spanTrigger.test.tsx`（span 触发器的角色、Tab、Enter/Space，菜单项的 `title`）、`Popover.test.tsx`（span 触发器）、`Result.test.tsx`（404 图）、`Floating.submenu.test.tsx`（`slide`：翻转后滑回、放得下时不动、默认不滑）、`Floating.dropdown.test.tsx`（结尾对齐列表取自己盒子的小数边缘；开头对齐为整数；盒子还没有宽度时退回测量值）。`Floating.dropdown.test.tsx` 的第一例在修正前的算法下得到 `0.20299999999997453px`（`580 - 143.797` 的小数部分），与期望的 `0.203125px` 不符。
- 开发中按区域连跑：`src/components/WorkspaceView*`、`src/components/ui`、`ApprovalPanel*` 共 64 个文件、633 个用例全部通过；完整的一遍在合并检查里。

## 合并检查与 P0

- **合并检查**（项目规则：在任务工作树上跑）：`npm run build -w @orbit/web && npm run test -w @orbit/web`，交付 `b72da6eda`：类型检查与构建成功，Vitest 399 个文件、5163 个用例全部通过（[checks/merge-check.txt](checks/merge-check.txt)）。
- **OrbitKit**（`ComposerMenuCopyParityTests`、`WatchWakeCopyParityTests`、`StartProjectCardCopyParityTests` 等原生对照读取 WorkspaceView 与 index.css 的文案和标记，本批改了它们周围的标记，所以照规则跑）：`swift:6.1` 镜像里在交付 `b72da6eda` 的检出上 `swift test`，3669 个测试，5 个跳过，0 失败（[checks/swift.txt](checks/swift.txt)）。
- **P0 页面矩阵**：参照与交付各自写出全部截图，两棵树都是 101 通过、11 跳过。两者对比（[compare/p0-summary.json](compare/p0-summary.json)）：252 张里 230 张逐字节相同，9 张抗锯齿级，13 张超出。超出的 12 张来自本批：
  - `session-attachment-staged`，8 个环境：P0 会话场景从 + 菜单选 File 放进一个文件后，Orbit 菜单把焦点还给 +（已验收的约定），输入框因 `:focus-within` 保持轮廓；被替换菜单把焦点丢到 body。输入框里面逐像素相同，只有边框与阴影不同（[sheets/p0/](sheets/p0/)）。与上面 `p53-context-popover` 同类。
  - `session-attachment-menu`，4 个手机环境：+ 菜单是 P2.2 的附件变体，标签 17px（任务指定），与 `p53-plus-menu` 同类。
  - 第 13 张是 `chromium-light-phone/task-action-focus` 的 2 个像素、3 级，任务页，与本批无关。
- **P0 严格比较**（交付对参照写出的截图，P0 比较器）：95 通过、6 失败，失败的正是会话页：两个明色桌面停在 `session-attachment-staged`，四个手机环境停在 `session-attachment-menu`（一个用例在第一张不符的截图处停下）。暗色桌面的轮廓差在比较器的颜色阈值以内，判为通过。
- **标准 P0**（期望截图 = P0.2 原图加已登记的层）：起点 `6fa5196e5`（不含本批）101 通过、0 失败；交付 95 通过、6 失败，失败与严格比较的 6 个相同（[checks/p0-standard-compare.txt](checks/p0-standard-compare.txt)）。**这 6 个失败是本批的迁移差异，不是漂移。** 按 [p0-drift README](../p0-drift/README.md) 的规则，只有协调者对本批证据作出 CONFIRM、本批落地之后，才能把它们登记进已接受层（同 P3.2 由[登记任务](orbit-task:34bSHg8V2p0zaRMKy7tUQ)登记）；登记时要按比较器重新确认哪些截图需要登记（手机上过了附件菜单之后还会看到 `session-attachment-staged`）。在那之前，标准 P0 在会话页上有这 6 个失败。

## 迁移清单

开工时与交证据前，都在交付上运行 `audit-antd.mjs --check-owners`（[scripts/audit.sh](scripts/audit.sh)）。[inventory-closure.mjs](inventory-closure.mjs)（P5.1 的同名脚本，owner 改为 P5.3）对比同提交参照与交付，结果在 [inventory-closure.json](inventory-closure.json)；每个点按审计自己的 `--check-owners` 规则（P0.1 清单加 inventory-delta 的 11 份记录）判归属。

| | 参照 `8f94ddda9`（撤回业务切换） | 交付 `b72da6eda` |
| --- | --- | --- |
| P5.3 的使用点 | 97 | 0 |
| 未归属 / 待定 | 0 / 0 | 0 / 0 |
| 其余归属 | KEEP 1、P6 42 | KEEP 1、P6 42 |
| 导入 antd 的生产文件 / 测试文件 | 11 / 42 | 9 / 3 |
| 按 AntD 类名找元素的测试文件 | 9 | 0 |

- `--check-owners` 在交付上：0 未归属、0 待定（[checks/delivery-check-owners.json](checks/delivery-check-owners.json)）。本批没有新的使用点要登记，不写清单记录。
- 会话工作区的路由：[session-route-closure.mjs](session-route-closure.mjs) 按 P4.4 `route-closure.mjs` 的走法，只换成它特意略去的会话路由（`WorkspaceConsole` 画出的 `/workspaces/:id/*`、`/agents/:id/*`、`/sessions/:id`）。交付：会话工作区可达 228 个模块、0 个导入 antd，登录后的外壳 230 个模块、0 个；参照：226 个模块里 2 个（`WorkspaceView.tsx`、`WorkspaceConsole.tsx`，都归 P5.3），外壳经 WorkspaceView 1 个（[checks/session-route-closure.json](checks/session-route-closure.json)、[checks/session-route-closure-reference.json](checks/session-route-closure-reference.json)）。非会话路由按 P4.4 的脚本照旧列出（[checks/route-closure.json](checks/route-closure.json)）。
- 交付上剩下的 9 个导入 antd 的生产文件都归 P6：`main.tsx`（`App`、`ConfigProvider`）、`theme.ts`、`StatusTag.tsx`（`Tag`），以及 `components/ui/__fixtures__/` 下 6 个把 AntD 与 Orbit 并排比较的开发用对照页；都不在会话工作区里。

## 未消除的差异

1. **焦点的约定**（已验收）：打开菜单时焦点进入菜单、在菜单里按 Tab 离开并关闭（协调者 2026-10-07，[component-contracts](../component-contracts.md)「Menu 打开后的焦点与 Tab」）；选择、Esc 或对话框关闭后焦点回到发起的按钮（P2.1「逐层返回焦点」）；选择列表打开时焦点在选项上（P2.2）；确认框是 alertdialog、默认焦点在 Cancel（P2.1）；图片预览的按钮名称与焦点（P5.2）；Popover 是对话框（P5.1）。它们带来的截图差异：`p53-context-popover`（输入框保持轮廓）、P0 会话页的 `session-attachment-staged`（桌面，见[合并检查与 P0](#合并检查与-p0)）。
2. **行 ⋯ 菜单打开时第一项的高亮**（交协调者判）：被替换的行菜单写明了 `autoFocus`，指针打开时焦点与高亮都在第一项。Orbit 菜单按上面的约定，指针打开时焦点在菜单本身、第一项不高亮，键盘打开时高亮第一项；键盘用户得到的与以前相同，指针用户看到的第一项没有底色（`p53-row-menu`，4 个桌面环境）。约定写的是“焦点同样移入菜单”，没有说到 `autoFocus` 的这一层高亮，所以单列。
3. **头部菜单切换标签后焦点的去处**（交协调者判）：给会话加/去标签时，保存期间标签行照旧禁用（业务逻辑未改）。被替换菜单里，拿着焦点的标签行一禁用，焦点就掉到 body；Orbit 菜单把焦点移到菜单里下一个能拿焦点的项（Rename… 或 Complete），菜单保持打开。焦点留在菜单里，与约定一致，但不在刚切换的那一行上。（Chromium 4 个环境；WebKit 4 个环境里两棵树都把焦点丢到 body。）
4. **输入框缩略图的可访问名称**（交协调者判）：被替换的缩略图是可点击、不可聚焦的 `div`（`alt=""`），键盘打不开预览。Orbit `Image`（P5.2）把它画成可聚焦的按钮，Enter/Space 打开预览、关闭后焦点回到它，按钮的名称取 `alt`；本批沿用原来的 `alt=""`，所以这个按钮没有名称。补名称（例如文件名或 “Preview image”）是新增文案，也牵涉 P5.2 `Image` 的接口，本批不改，在这里报出。
5. **浮层在触发器上方的纵向取整**（同 P5.1 已记录的类）、**手机附件菜单 17px**（P2.2 任务指定的字号）、WebKit 上行高的小数：见[对照结果](#对照结果)。
6. **参照的缺陷，交付没有**：WebKit 手机上，按标签筛选的子菜单在点选标签后留在屏幕上（参照 2/2 个 WebKit 手机环境都复现）；Orbit 菜单整个关闭。

## 未确立的部分

- **真实手机**：未执行，见[真实手机](#真实手机)。
- **中文输入法的组词在触屏设备上**：浏览器里只有 Chromium 的 DevTools 组合事件与 WebKit 的回放；模拟器上的 Gboard（默认、仅英文）逐字提交、不进入组词，`compositionstart` 一次也没有。真实的拼音组词与组词中的回车只在真机清单里。
- **WebKit 的输入法与软键盘**：WebKit 只在 Playwright 的桌面/手机模拟里跑，没有 iOS Safari；iPhone 的软键盘、组词与边缘返回在真机清单里。
- **模拟器上没有做的**：手动高度（输入框的拖动柄只响应鼠标，触屏上本来就没有，前后相同）；照片之外的文件选择；横屏。
- **P0 的接受登记**：`session-attachment-menu`（手机）与 `session-attachment-staged`（桌面）在协调者对本批证据作出 CONFIRM 之前不能登记为接受的迁移差异（`p0-drift/accepted/registry.json` 的规则），本批不登记。
- 协调者提到的项目已有缺陷（图片异步加载后，停在尾部的会话偶尔停在离尾部 1053px 处，两棵树都有）在正式轮里没有出现：两棵树各 576 次观察到尾部的距离都是 0。本批的会话记录里没有异步加载的图片（唯一取图的是输入框的附件；带图的记录在 P5.2 的固定数据里），所以这不说明缺陷已经消失；本批没有追查它。

## 复现

```bash
# 三棵树（都在 /mnt/data）：参照 = 交付撤回业务切换 c868a02c2；起点 = origin/main 6fa5196e5（已含项目 tip，不含本批）；del = 交付
scripts/make-trees.sh b72da6eda c868a02c2 6fa5196e5
# 正式轮 f1，逐步串行：P5.3 一对、P0 页面矩阵（参照、严格比较、交付）、标准 P0（交付与起点）；
# 之后在任务工作树上跑合并检查，在 v1/del 上跑 OrbitKit
scripts/chain.sh f1          # formal.sh f1 + npm run build/test -w @orbit/web + docker swift:6.1 swift test
scripts/analyze.sh f1        # 截图、计算样式、trace 逐字段、AntD 普查；P0 一对
scripts/audit.sh             # audit-antd（交付与参照）、--check-owners、清单闭合、会话与非会话路由
scripts/probes-final.sh      # README 引用的测量，在两棵正式树上
# 模拟器：两棵树的 vite preview、adb start-server，然后在 ui.lock 下跑 emu-pair.sh（emu-server.mjs + emu-steps.mjs）
android/emu-final.sh
scripts/collect.sh f1        # 把上面引用的东西收进本目录（并排图、摘要、trace、记录）
# P5.3 用例单独运行（在要比较的树的 src/web 下）：
P53_SNAPSHOTS=<dir> P53_OUTPUT=<dir> npx playwright test --config ui-migration/p53.config.mjs --update-snapshots=all
# 开发时的单环境对照与探针：scripts/dev-run.sh、dev-compare.sh、probe-both.sh（scripts/probe/ 的场景）、webkit-repeat.sh
```

## 证据体积

本目录共 11M（上限 30MB）：并排图 2.8M（256 色；关键状态半尺寸，超出的对裁到差异处），比较 3.1M，trace 1.7M（`extract-traces.py` 从报告里取出），日志与报告摘要 1.7M（`report-summary.py`：去掉附件正文，没有 trace.zip），模拟器 792K（两棵树的记录、13 张并排图、脚本），探针 76K，脚本 156K。没有收进来的原始运行（两棵树的全部截图、Playwright 报告与附件、模拟器的整幅截图、开发轮）留在 /mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/ 直到判定。
