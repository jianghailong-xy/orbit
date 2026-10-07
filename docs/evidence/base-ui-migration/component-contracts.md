# AntD 组件替代与保留行为

这是迁移设计约束，不是已完成迁移的声明。`audit-baseline.json` 的 `files[].imports[].bindings` 给出每一处导入的原名、别名、类型标记和行号；以下按原名定义替代方式。实际切换批次由 `ownership.json` 的文件条目指定，公共能力准备阶段不能当作所有调用方已迁移。Base UI 的具体正式版本及 API 由 P1 实施时核实，业务只调用 Orbit 公共组件。

所有控件共同保留现有 CSS/语义变量、字体、图标、信息密度、明暗主题、手机布局，以及实际使用的 hover/focus/disabled/loading/error 状态。32px 控件、6px 基础圆角和10px 弹窗圆角是起点；局部例外及计算样式由 P0.2 实测，不能只复制 seed token。

| 导入原名 | 公共能力准备 | 替代方式与必须保留的行为 |
| --- | --- | --- |
| Button | P1.2 | Orbit Button / 原生 button；type、submit、防重复提交、禁用/加载、小号与图标按钮、可访问名称及焦点轮廓 |
| Input | P1.2、P3.1 | Orbit Input/Password/Textarea；受控值、清除、密码可见性、前后缀、Enter；Textarea 保留自动增高、原生 ref、选区、中文输入法、手动高度与镜像对齐 |
| InputNumber | P3/P4 按实际使用补充 | 原生数值字段的 Orbit 外壳；min/max/step、空值、整数修正、失焦及 Enter 提交时序；尤其 RunnerDetailPage 的 1–64 修正后保存 |
| Checkbox | P1.2 | Orbit Checkbox；checked/indeterminate、标签点击、禁用及表单值语义 |
| Radio | P1.2 | Orbit Radio/RadioGroup；分组、受控值、键盘、标签、禁用及项目执行模式说明 |
| Switch | P1.2 | Orbit Switch；checked/loading、禁用和原有立即保存行为 |
| Segmented | P1/P2 按需求 | Orbit 分段选择；选择值、标签计数/图标、禁用、键盘及手机密度，不改变当前过滤或 tab 语义 |
| Spin | P1.2 | Orbit Spinner；行内/整页占位尺寸、加载遮罩及可访问加载状态 |
| Alert | P1/P3 按需求 | Orbit 反馈/状态块及原生语义结构；状态颜色、图标、标题正文、操作区和错误信息，不改变决策卡业务含义 |
| Avatar | P1/P3 按需求 | 原生图片/文字头像的 Orbit 外壳；尺寸、回退字符、圆形/方形、加载失败表现 |
| Tag | P1.2 | Orbit Badge/状态标签；颜色、文案、紧凑排版与状态含义 |
| Card | 随调用方批次 | 原生 section/div + 既有样式；标题、extra、边界、内容间距、loading及嵌套层级 |
| Typography | 随调用方批次 | 原生标题/段落/文本/链接及最小复制控件；语义层级、弱化/危险色、截断、换行、code/pre、复制反馈；CodexSignIn 的复制按钮样式单列 |
| Space | 随调用方批次 | 原生 flex/grid + 既有间距；换行、方向、对齐及操作组密度 |
| List | 随调用方批次 | 原生 ul/li 或业务行；空状态、分隔、标题/描述与项目任务整行点击区域 |
| Descriptions | P4.2 | 原生 dl/grid；注册页标签和值、响应式列、长 token 换行 |
| Empty | 随调用方批次 | Orbit 空状态/原生结构；原文、图示占位、操作与高度 |
| Result | 随调用方批次 | Orbit 结果状态/原生结构；成功/失败语义、说明及重试/返回操作 |
| Skeleton | 随调用方批次 | Orbit 占位块；加载尺寸、结构及动画，不让已知内容在刷新时消失 |
| Modal | P2.1 | Orbit Dialog；打开/关闭、标题说明、footer、Esc/遮罩、滚动锁、焦点圈定及归还、嵌套层级、异步确认成功/失败/重复提交 |
| Drawer | P2.1 | Orbit Drawer；方向、宽度、手机底部/侧边面板、内部滚动、关闭与焦点恢复 |
| Popconfirm | P2.1 | Orbit ConfirmDialog/确认浮层；锚点、操作文案、异步 onConfirm、失败后状态、取消/外部关闭 |
| Dropdown | P2.2 | Orbit Menu；items、图标、分组/分隔、危险项、禁用、受控打开、点击/触摸触发、阻止行点击冒泡、键盘和关闭后焦点 |
| Popover | P2.2 | Orbit Popover；锚点、方向/避让、点击/悬浮、交互内容、嵌套层级、主题；PlanUsageIndicator 的手机两侧边界 |
| Tooltip | P2.2 | Orbit Tooltip；hover/focus、延迟、位置、长文案、禁用按钮锚点和可访问说明 |
| Select | P2.2 | Orbit Select/Combobox；单选/多选、搜索、过滤、清除、禁用、分组/自定义项、弹窗内 portal、键盘/触摸和焦点 |
| Form | P4.1 | 原生 form + 最小 Orbit Field/校验；LoginPage/SetupPage/ProfilePage 的 required、密码联动、错误展示、提交/重置、初始值和原有接口 |
| Table | P4.2 | 原生语义 table + 既有响应式样式；AdminUsersPage/ProvidersPage 的列、行键、行操作、loading/empty、水平滚动及实际分页设置 |
| Upload | P3.2 | 原生文件选择 + Orbit 上传外壳；TaskInputs 的文件过滤/多选、beforeUpload 阻止 AntD 自行 XHR、既有 uploadAttachment/删除 API、错误/重试、对象 URL 清理 |
| Image | P3/P5.2 | Orbit 图片及 Base UI Dialog 预览；Transcript/WorkspaceView 的授权加载、对象 URL、分组、切换、缩放、关闭/返回、加载失败和缩略图遮罩 |
| App | P2.1 准备，调用方逐批切换，P6删除 | 删除 AntApp/AntdApp/App 别名调用方对 useApp 的依赖；命令式 confirm/success 改 Orbit 服务，保留上下文主题及异步语义；根 Provider 最后退役 |
| ConfigProvider | P1.1 准备，P6删除 | 共存期间维持 AntD主题；Orbit 从 lib/theme.tsx 与 CSS 语义变量取值；P6才去掉主题桥和 reset |
| theme | P1.1 准备，SessionOutputs P5.1，P6删除 | SessionOutputs.useToken 改 CSS/Orbit tokens；theme.ts 的 darkAlgorithm 在覆盖实测配色后退役，保留 system/light/dark、账号同步及首屏 |
| ThemeConfig | P1.1/P6 | 删除 AntD 主题类型；Orbit 只定义真实 token 需求，不复制全套 ThemeConfig |
| MenuProps | P2.2准备，随调用方切换 | 换 Orbit Menu 项的最小业务类型；保留 key、label、icon、disabled、danger、divider、children 等实际使用字段 |
| TableColumnsType | P4.2 | 页面本地/Orbit 原生表格列类型；只覆盖当前列与 render/响应式需求 |
| RefSelectProps | P4.2 | Orbit 公开 focus/原生 ref 能力；RunnerDetailPage 的 keepFreeRef.focus({ preventScroll: true }) 是公开 ref 使用，但仍须随 Select 迁移，不是任意内部DOM读取 |

## Menu 打开后的焦点与 Tab（协调者 2026-10-07 判定）

**约定**：Orbit `Menu` 打开后，焦点在菜单内；在菜单内按 Tab，焦点离开菜单，菜单随之关闭。旧 AntD Dropdown 不同：打开后焦点留在触发器，按 Tab 才进入菜单。协调者把 Orbit 的行为作为 WAI-ARIA 菜单按钮模式的约定接受（P3.3 缺口 G5）。理由有两条：
- 打开即聚焦是 P2.2 已验收的行为，方向键、回车和 Menu 打开窗口的修复（`4fb7ee43f`）都建立在它上面；
- 恢复旧语义要和 Base UI 的焦点管理对着干，会抬高长期维护成本。

账号所有者可随时推翻这一判定。

**适用范围**：
- 所有 Orbit `Menu`（`components/ui/Menu.tsx`）的根菜单，也就是各批替换 Dropdown 的菜单：试点已在用的 More（TaskDetailPanel）和 Access（ShareModal）、P4 其余用 Dropdown 的文件、P5 的 WorkspaceView。
- 打开方式不限。用键盘打开（触发器上 ⏎、↓、↑）时，焦点落在打开键高亮的那一项；用指针或触摸打开时，焦点同样移入菜单。
- 约定里的 Tab 指焦点已经进入菜单之后。以下情况没有记录，不在本约定内：
  - 打开后、焦点移入前那一帧里落在触发器上的 Tab；
  - 子菜单里的 Tab；
  - Shift+Tab。

  前两项归「P2 跟进（第 2 批窗口）」处理。

**各批对照怎么处理**：
- 同提交对照里，AntD 参照与 Orbit 如果只差在下面两点，按本约定处理：不算回归，也不为此改 `Menu`。
  - 打开后，焦点在触发器（AntD）还是在菜单内（Orbit）；
  - 按 Tab 是进入菜单（AntD），还是离开并关闭菜单（Orbit）。
- 其他焦点差异照常逐条解释。
- 由此带来的 P0 截图变化（例如触发按钮上的焦点环），仍按作业指导在证据里逐张说明，经协调者确认后登记。

**测试依据**：
- 打开后焦点在菜单内，有三处常驻检查：
  - [`Menu.test.tsx`](../../../src/web/src/components/ui/Menu.test.tsx) 的 9 个参照用例（jsdom）：分别用 ↓、↑、⏎ 打开，让焦点移动的那一帧运行之后，焦点在打开键高亮的那一项上。
  - [`choices.browser.mjs`](../../../src/web/ui-migration/choices.browser.mjs) 的「menu arrows, disabled items, submenu, checkbox and focus return work」（`npm run test:ui-choices -w @orbit/web`，八环境）：在触发器上按 ↓ 打开后，第一项获得焦点；按 Esc 后，焦点回到触发器。
  - P0 的 `task-action-menu`（`npm run test:ui-migration -w @orbit/web`，八环境）：点击 More 打开菜单后截图，More 按钮上没有焦点环。浅色 4 张已作为 P3.2 的已接受迁移差异登记（[p3.2-accepted](p3.2-accepted/README.md)）。深色 4 张的差异低于 P0 比较器阈值，查不出这一变化。
- 按 Tab 离开并关闭菜单，目前**没有常驻用例断言**。直接记录在 [p2-keyboard-window](p2-keyboard-window/README.md)「范围外观察」第 1 条：
  - 逐键（paced）按 `⏎ Tab ↓ ⏎`，字段页和样例页各 20 次。Orbit 菜单每次都在 Tab 后关闭，焦点移到触发器之后的下一个可聚焦元素，没有执行任何菜单项（40/40）。
  - 同一组按键下，旧 Dropdown 的 Tab 把焦点移入菜单（`@rc-component/dropdown` 的 `es/hooks/useAccessibility.js:30-54`），随后的 ↓⏎ 执行了 Image（20/20）。
- 这一行为来自 Base UI 1.8.0：
  - 根菜单的 `MenuPopup` 对任何打开方式都设 `initialFocus`；
  - Orbit `Menu` 传 `modal={false}`，焦点移出浮层树时，`FloatingFocusManager` 以 `focusOut` 关闭弹层。

  升级 Base UI 或改动 `Menu` 的焦点管理时，要重新核对这两点。

## 非导入依赖

`audit-baseline.json` 按行标记 Provider、useApp、useToken、命令式确认及反馈、内部 ref、ant-* class/selector、图标和支持包；不是只数 import。`routes-and-tests.md` 人工复核热点，`css-ownership.json` 为 index.css 命中的每个区段给出迁移归属。

`main.tsx` 的 `import 'antd/dist/reset.css'` 是当前唯一 antd side-effect import；P6 删除前补齐 Orbit 所需基础 reset，尤其列表 margin。当前无 `@ant-design/v5-patch-for-react-19`，不能按旧 v5 wiki 说明重新加入。

`TaskDetailPanel.tsx` 的 textarea 内部访问由 P3.2 使用 P3.1 的原生 ref 替代；`WorkspaceView.tsx` 的两处访问在 P3.1 验证兼容、P5.3 完整切换。保留 selection/caret、滚动高度、手动高度和镜像的时序。

`lib/toast.tsx`、`toastFeed.ts`、`toastStore.ts` 与 `ToastViewport.tsx` 已为 Orbit 自有通知。P2.3 应验证短提示、常驻错误/警告、撤销/跳转、去重和堆叠；不要因历史规划再造通知内核。扫描中的业务 `message.error` 等需追踪接收者，不能见方法名就认定为 AntD。

## 图标与锁文件边界

保留 `@ant-design/icons`、`@ant-design/icons-svg`、合法 `.anticon` 样式及它们实际可达的传递依赖。`@ant-design/*` 并不都等于 `antd`。审计报告另列 `ant-design-support`、`rc-support`；P6 通过干净安装与依赖树确认哪些仍由图标包需要，不手工删锁文件中的整个命名空间。

当前锁定 antd 及图标版本、传递依赖和 peerDependencies 见报告 `dependencies`。P6 的静态扫描只能证明本范围中列出的文本耦合已清理；安装树与构建产物仍须独立核验。
