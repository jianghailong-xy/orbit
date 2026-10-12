# P4.1 登录、初始化、个人资料与设置

服务于 [P4.1 迁移登录、初始化、个人资料与设置](orbit-task:34Za39Do3N6tkmIMP0GBP)，项目验收条目 key `hnPVsE0kmorHXurrs4Qdp`：**P4：全部非会话业务界面完成迁移，既有页面操作和响应式呈现保持一致。** 本任务承担其子范围：本批页面原有字段校验、错误展示、提交/重置、跳转和设置行为正常；代表性截图与当前基线一致，相关回归通过，本批清单项关闭。

起点为项目分支 tip `a84bc61e7`（含 P3.3 结论、P0 漂移登记第 3 批、清单增量复核）。开工读取了任务与协调者评论（前置任务、`.orbit-card` 命名决定、同提交参照）、项目目标/作业指导/验收条目、清单增量记录与复扫规则、P3.1/P3.2 的同提交对照方法和 P0 漂移规则。

## 结论

- **页面与清单**：SetupPage、ProfilePage、SettingsPage、AccessTokensPage、CliLoginPage 与 AccessTokenTable、NewAccessTokenDialog 改用 Orbit 组件和原生表单，7 个生产文件不再导入 antd；P4.1 清单 18 → 0，未归属 0、待定 0。LoginPage 已由 main 改为原生表单，本批只复核它的单测与登录跳转。
- **行为**：同提交对照，参照树是交付只撤回业务切换。
  - P4.1 用例 12 个 × 8 环境，两树全部通过。
  - 逐步 trace 共 488 步，地址、请求、通知、表格行与记录的状态 0 差异。覆盖：字段校验（必填、邮箱格式、6 位、确认密码联动）、错误展示、提交/重置、登录与初始化跳转、改名/头像/改密码、设置与主题持久化、令牌签发/撤销、CLI 批准/拒绝。
  - 焦点的不同都属于 P2.x 已接受的约定。
- **外观**：
  - P4.1 截图 272 张：200 张逐字节相同、60 张抗锯齿级、12 张超出。超出的 12 张里，8 张是按设计统一卡片几何后 Sign-in methods 卡片的 1px；1 张是 AntD 页自身也会出现的 WebKit 手机排版；3 张是头像边缘抗锯齿，每棵树自身各轮之间也有同量级的变化。
  - P0 同提交 252 张：236 张相同、12 张抗锯齿级、4 张超出（2 张噪声，2 张见下）。
- **回归**：
  - 组件矩阵 overlays 96/96、choices 520/520。
  - P3.2 试点在交付上复跑、与起点对照：截图 200 张相同、47 张抗锯齿级、5 张为已记录或运行间会变的抗锯齿；负载下 2 个用例各超时一次，单独重跑各 3/3 通过。
  - 合并检查：构建通过，Vitest 347 个文件、4414 个用例通过。
  - 标准 P0：99 通过、11 跳过、2 失败，两次运行结果相同。
- **待协调者判定**：
  - 标准 P0 的 2 个失败是 WebKit 明/暗手机的 `profile-validation`：“Name saved”通知胶囊右移 4px。
  - 根因：参照页上 AntD 表单项的一次同步布局读取（4 个 `.ant-form-item` 的 `offsetParent`），与 Linux WebKit 手机 8px 滚动条模拟相互作用。由测试注入一次读取后，交付与 P0 期望逐像素一致。
  - 本批没有改产品代码迎合，也没有动 P0 的截图、场景、断言或登记。是否作为迁移差异接受，请协调者判定。
- **`.orbit-card`**：收为 `components/ui` 的公共样式，由 `Card` 组件渲染，类名作为公开约定写进 README。理由，以及对两个现有使用方各 1px 的影响，见“`.orbit-card` 的决定”。

## 范围

开工时按复扫规则运行 `audit-antd.mjs` 与 `--check-owners`（[start-audit-summary](checks/start-audit-summary.txt)、[start-check-owners](checks/start-check-owners.json)）：P4.1 负责 18 个使用点，0 个未归属、0 个待定。逐点列表见 [inventory-closure.json](inventory-closure.json) 的 `before.p41`：

- 生产文件 7 个：`pages/SetupPage`、`ProfilePage`、`SettingsPage`、`AccessTokensPage`、`CliLoginPage`，`components/AccessTokenTable`、`NewAccessTokenDialog`；
- 测试 8 个：`ProfilePage.test`、`.revokeAccessTokens.test`、`.signInMethods.test`，`SettingsPage.test`、`.accessTokens.test`、`.modelRouting.test`，`AccessTokensPage.test`，`CliLoginPage.test`；
- index.css 3 行：main 写在 `.orbit-card` 上方、提到 AntD 的两行注释，以及 `.access-token-field .ant-radio-group`。

`LoginPage` 已由 main（14ed14ace）改为原生表单加 Orbit Button，没有使用点；本批只复核：它的单测（`LoginPage.google.test`、`App.loginNext.test`、`App.googleSignIn.test`）照常通过，P4.1 浏览器用例从一个未登录的 `/cli-login` 链接走完登录跳转（见“对照结果”）。

为让本批页面完成切换而改到的其它文件，各有直接原因：

| 文件 | 归属 | 改动与原因 |
| --- | --- | --- |
| `components/SignInMethodsCard.tsx` | 资料页的直接依赖（无 antd） | 改用公共 `Card`（见“`.orbit-card` 的决定”） |
| `pages/AdminSignInPage.tsx` | P4.2 管理页（无 antd） | 一行 `import '../components/ui/Card.css'`：卡片类名原在 index.css，现在移入 `components/ui`；`.admin-signin` 补回原来由 `.orbit-card` 给的 16px 下边距 |
| `pages/AdminUsersPage.tsx` | P4.2 | 访问令牌弹窗内的正文包一层 `OverlayScope`：`AccessTokenTable` 的撤销确认改为 Orbit Popconfirm 后，按 P2.1 共存约定留在该 AntD Modal 的焦点与层级内 |
| `pages/AdminUsersPage.accessTokens.test.tsx` | P4.2 | 只改指向 `AccessTokenTable` 的选择器（令牌行、撤销确认）；用户表与 Modal 的 `.ant-*` 仍归 P4.2 |
| `components/TaskDetailPanel.tsx` | P3.2 | `Segmented` 加了默认的 middle 尺寸，任务面板的依赖视图显式写 `size="small"`，渲染不变 |
| `ui-migration/page-scenarios.mjs` | P0 场景中归属本批的定位器 | settings/profile 截图点从 `.ant-card`、`.ant-select`、`.ant-segmented`、`.ant-form-item-*` 改指 Orbit 的卡片、选择器、分段与字段；场景步骤和断言不变 |

## 提交

| 提交 | 内容 |
| --- | --- |
| `0bb647a81` | feat：公共组件。新增 `Card`、`Field`/`FieldFeedback`/`useFormFields`、`PasswordInput`、`Table.css`/`TableScroll`；`Avatar` 画图片，`Alert` 增加 warning 与无说明时的居中图标，`Segmented` 增加默认 middle 尺寸，`MultiSelect` 打开即高亮首项并显示放大镜，`Dialog` 宽度上限与滚动终点同旧对话框，`Popconfirm` 改用页面坐标定位；README 写明用法 |
| `7d81822b1` | feat：业务切换。7 个生产文件不再导入 antd；index.css 清理本批的 `.ant-*` 与注释、移出卡片样式、加入新增样式；9 个单测文件改用角色/名称，新增 `SetupPage.test`、`ProfilePage.password.test`；P0 settings/profile 定位器 |
| `b0b59fa39` | test：`p41.browser.mjs`、`p41-fixtures.mjs`、`p41.config.mjs`；P0 矩阵忽略 `p41*.browser.mjs` |

之后的提交只增加本目录证据。三个提交各自可回退：撤回 `7d81822b1` 即恢复 AntD 页面（同提交参照树就是这样得到的）；`0bb647a81` 单独存在时没有业务页面引用新增组件。

## 公共组件

只覆盖本批页面实际用到的能力，逐项按被替换组件的计算样式与几何测出（开发期间的探针对 AntD 页面逐元素取值），用法写在 [ui/README](../../../../src/web/src/components/ui/README.md)“卡片、表单字段与表格”等节：

| 组件 | 替代 | 要点 |
| --- | --- | --- |
| `Card` | AntD Card | `section` 以标题 `h2` 命名；1px 分隔色边框、8px 圆角、凸起表面；56px 头部、16px 半粗单行标题（25.14px 行高）、头部下分隔线由正文上移 1px 覆盖；24px 正文；不带外边距 |
| `Field` + `useFormFields` | Form / Form.Item | 原生 `<form onSubmit>`。标签在上（8px），控件行至少 32px，消息占用字段保留的 24px（单行不推动下方字段），`extra` 在后；消息 0.1s 淡入下移、离开时淡出。校验时机同旧表单：改动即校验该字段；依赖它的字段改动或校验过后随之重校验（确认密码）；提交时全部校验；`reset` 回到初值。控件的 `id`、`aria-invalid`、`aria-required`、`aria-describedby`（`${id}_help`/`${id}_extra`）同旧表单 |
| `FieldFeedback` | Form.Item hasFeedback 图标 | 校验通过/失败的 14px 图标，0.2s 放大淡入 |
| `PasswordInput` | Input.Password | 显示/隐藏开关：`role=button`、在 Tab 顺序中、Enter/Space 切换、名称 Show/Hide、`aria-pressed`；按下不夺焦点与光标；后缀图标排在开关后 8px |
| `Table.css` + `TableScroll` | Table（`scroll.x`） | 原生 `table`：半粗表头与分隔线、表头单元间 1px 竖线、16px 单元格、行悬停底色、空表一行浅色居中说明（限在可见宽度、横向滚动时不动）；横向滚动盒在仍有内容的一侧画旧表格的内阴影，滚动条颜色同旧表格（因而是浏览器自身的覆盖式滚动条）；表头为空的列保留一个空格宽（旧表格测量行的效果） |
| `Avatar` 扩展 | Avatar（图片） | `src` 画图片（铺满边框内侧、按圆裁切、`alt` 默认空），没有图片或加载失败时显示文字 |
| `Alert` 扩展 | Alert（warning、无说明） | `type="warning"`；无说明时图标与文字垂直居中（旧组件默认），有说明时顶对齐 |
| `Segmented` 扩展 | Segmented（默认尺寸） | `size="middle"`（默认）：28px 项、11px 内边距、6px/4px 圆角；任务面板写 `size="small"` |
| `MultiSelect` 修正 | Select `mode="multiple"` | 打开即高亮第一项（Enter 选中，旧 `defaultActiveFirstOption`），打开期间箭头换成放大镜；`mode="tags"` 不变 |
| `Dialog` 修正 | Modal | 宽度上限按视口宽度（100vw−32px，窄屏 100vw−16px），弹层视口出现滚动条时宽度不变；滚动到底止于对话框下缘（AntD 6 的 Modal 没有底部内边距）。开发对照中 WebKit 手机上比旧弹窗窄 8px、底部多出 32px 可滚动空白，修正后与旧弹窗相同 |
| `Popconfirm` 修正 | Popconfirm | 改用页面坐标（`positionMethod="fixed"`）。原先在对话框内以对话框为定位容器：手机上被限在对话框宽度内（374 对 390px，文字换行不同），打开的第一帧按对话框偏移画在错误位置（减少动态效果时可见一帧，并让指针悬停状态停在浮层上）；修正后第一帧即在最终位置、指针悬停状态保留，位置与宽度和旧确认浮层相同。P3.2 试点矩阵复跑证明其它用法不变（见“P3.2 试点复跑”） |

## `.orbit-card` 的决定

协调者要求本批迁 AntD Card 时决定 main 的原生 `.orbit-card` 收为公共样式还是改名。**决定：收为公共样式**，放进 `components/ui/Card.css`，由 `Card` 组件渲染，类名 `.orbit-card`、`-head`、`-title`、`-body` 作为公开约定写进 README；根元素不能是 `section` 的情形（AdminSignInPage 的表单卡片）沿用这些类名并直接导入 `Card.css`。没有新造同名或近名的卡片类。

理由：
1. main 写 `.orbit-card` 的本意就是复刻资料页旁 AntD Card 的盒子、头部和内边距（原注释原文如此）。本批要把资料、设置、初始化、CLI 登录四页的 AntD Card 换成同一外观，全站只应有一套卡片样式。
2. 两个现有使用方（SignInMethodsCard、AdminSignInPage）用的就是这组类名，收编不必改名，避免重蹈 P3.2 `.orbit-choice` 两套同名样式互相套用的覆辙。
3. 样式由组件自带（组件文件导入 CSS），不再散在 index.css 的业务区段里。

收编时把几何改成与 AntD Card 一致（逐像素对照得出）：头部 `margin-bottom: -1px`（正文与分隔线重叠 1px）、标题行高 25.14px 并单行省略；外边距不再写在卡片上，改由页面给（`style={{ marginBottom: 16 }}`，SignInMethodsCard 用 `.profile-signin`，AdminSignInPage 用 `.admin-signin`），两个现有使用方的间距不变。代价是这两张卡片的正文和其下方内容上移 1px、标题盒随行高微调（文字中心不变）：资料页见“对照结果”中的 `p41-profile-signin`，管理端见“管理端 Sign-in 卡片”。

## 业务切换

| 页面/组件 | 原 AntD | 现在 |
| --- | --- | --- |
| SetupPage | Card、Typography.Paragraph、Form/Form.Item（required、email、min 6、确认密码 validator + dependencies、hasFeedback）、Input、Input.Password、Button block | Card、`<p>`、`<form>` + Field/useFormFields（同文案：Please enter Email / Email is not a valid email / Password must be at least 6 characters / Please enter Confirm password / passwords do not match；邮箱格式沿用 async-validator 的正则与 320 字符上限）、Input、PasswordInput + FieldFeedback、Button 撑满 |
| ProfilePage | Card、Avatar（图片/首字母）、Button、Input（onPressEnter）、Form（改密码：required、min 6、确认密码联动）、Input.Password、Checkbox + extra、`form.resetFields()` | Card、Avatar、Button、Input（Enter 保存，忽略输入法合成与按住重复）、`<form>` + Field/useFormFields（Enter your current password / Enter a new password / At least 6 characters / Confirm your new password / Passwords do not match）、PasswordInput、Checkbox + Field extra、成功后 `reset()` 并取消勾选 |
| SettingsPage | Card、Select（loading）、Switch（loading）、Segmented、Button | Card、Select、Switch、Segmented（middle），控件以所在行的标题命名（`aria-label`） |
| AccessTokensPage | Button、Spin | Button、Spinner |
| AccessTokenTable | Table（`scroll.x`、空态文字、行类名、右对齐操作列）、Tag warning、Popconfirm、Button danger | 原生表格 + TableScroll、Badge warning、Popconfirm（danger 确认）、Button |
| NewAccessTokenDialog | Modal（destroyOnHidden）、Input autoFocus + onPressEnter、Radio.Group 按钮样式 ×2、Checkbox、Select multiple + allowClear、Alert warning | Dialog（关闭即卸载，初始焦点在 Name）、Input（Enter 创建）、RadioGroup `variant="button"` ×2、Checkbox、MultiSelect clearable、Alert warning；对话框限定无单位行高 |
| CliLoginPage | Card、Spin、Descriptions（bordered small、136px 标签）、Tag、Alert（warning；error + description）、Result（success/info/warning）、Space、Button | Card、Spinner、原生两列表格（同边框、标签底色与内边距）、Badge、Alert、原生结果块（同 72px 图标——info 为感叹号圆、warning 为三角——24px/32px 标题、14px 副标题）、flex 按钮行 |

请求、路由、文案与业务语义都没有改：登录跳转、初始化后进入 runner 注册引导、资料名与头像的保存/删除、改密码（可选同时撤销访问令牌）、偏好与主题同步到账号、访问令牌的签发/撤销/只显示一次，以及 CLI 登录的批准/拒绝。


## 对照方法

沿用 P3.1/P3.2 的同提交对照。参照树 `b5a39dd48` = 交付提交 `b0b59fa39` 只撤回业务切换 `7d81822b1`（在 `/var/tmp` 的独立稀疏工作树中本地提交，未推送）：本批页面是 AntD，公共组件、P4.1 用例与 P0 定位器之外的一切与交付相同。两棵树各自 `vite build` 后 `vite preview`，Playwright 1.63.0 / Chromium 1243 / WebKit 2359、P0 字体与 `environment.mjs` 校验、DPR 1、en-US/UTC、固定时间与固定 REST 数据，reducedMotion=reduce；八环境 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844。

- **P4.1 用例**（[p41.browser.mjs](../../../../src/web/ui-migration/p41.browser.mjs)）：12 个用例 × 8 环境，每环境 34 张截图，覆盖 P0 矩阵不到的状态。定位器是角色、可访问名称、标签和页面自己的类名，同一份文件驱动两棵树；卡片、表格、选择器的外框用两边的类名并列（`.ant-card, .orbit-card` 等），只用于样式取值。每一步记录 trace：地址、焦点、打开的对话框、标为无效的字段及其说明、alert、通知区文字、该步发出的请求。
- **P0 页面矩阵**：用 P3.2 的 [p32-reference.config.mjs](../p3.2/p32-reference.config.mjs)，参照树写出截图，交付树一次按 0 像素容差严格比较、一次写出自己的截图供逐张分类。两棵树都用 4173 端口（分享链接含端口）。另跑一次标准 P0 回归（对照 P0.2 原图与漂移/已接受层）。
- **分类**：与 P3.1/P3.2 相同，逐字节相同 / 抗锯齿级（每个差异像素每通道 ≤2） / 超出；超出的逐张说明。[summarize.py](summarize.py) 在 [p3.2/compare_runs.py](../p3.2/compare_runs.py) 的结果上分类；[trace-semantics.py](trace-semantics.py) 逐步比较两棵树的请求、地址、通知、表格行与记录的状态（勾选、开关、主题、保存的偏好、密码框类型），不比较焦点表现。
- **参照自身噪声**：开发期间用 tip `a84bc61e7`（本批页面与参照树相同）连续跑两轮 P4.1 用例（`r1-ref`、`r1-ref2`），得到同一棵 AntD 树的差异；正式运行后又在两棵树上各重复两轮有差异的用例（见“重复运行”）。

## 对照结果

正式运行一次跑完（作业 `bgj_a87a4425bf33`，脚本 [formal-runs.sh](scripts/formal-runs.sh)），依次为 P0 参照、P0 严格比较、P0 交付、标准 P0、P4.1 参照、P4.1 交付，日志与报告摘要在 [runs/](runs)。

### P4.1 用例

| 运行 | 提交 | 结果 |
| --- | --- | --- |
| [f-p41-ref](runs/f-p41-ref.txt) | 参照 `b5a39dd48` | 96 通过 |
| [f-p41-del](runs/f-p41-del.txt) | 交付 `b0b59fa39` | 96 通过 |

截图 272 张（[compare/f-p41-summary.json](compare/f-p41-summary.json)，逐张数据 [compare/f-p41-compare.json](compare/f-p41-compare.json)）：**200 张逐字节相同，60 张抗锯齿级，12 张超出**。抗锯齿级主要是新建令牌对话框的阴影（31 张）、初始化页（12 张）与管理员撤销确认（4 张）。超出的 12 张：

| 截图 | 环境 | 差异 | 归类 |
| --- | --- | --- | --- |
| `p41-profile-signin` | 8 个 | 9.1k–15.7k 像素：Sign-in methods 卡片高 227→226（文字折行时 249→248），其下全部内容上移 1px | **按设计**：`.orbit-card` 收为公共样式后与同页另两张卡片同一几何（见“`.orbit-card` 的决定”）；计算样式差异只有这 1px |
| `p41-profile-photo` | Chromium 明/暗桌面、明色手机 | 81–87 像素，≤33 级：只在头像圆边下半（橙色半边与蓝色底色相接处）和卡片、按钮圆角的抗锯齿像素 | **边缘栅格化的运行间差异**（见“重复运行”）：每棵树自身三轮之间差到 89 像素、40 级，与跨树同一量级。两树的几何与计算样式相同；同一状态用单独探针渲染（直接加载与按用例选图两种路径），两树头像区域逐字节相同。两树的结果集合不重叠，具体来源没有查到，列入“未消除的差异” |
| `p41-cli-denied` | WebKit 明色手机 | 20.7k 像素：前一步批准被拒时留下的错误通知卡（仍固定显示）宽 350 对 358，背后页面的横向位置不同 | **WebKit 手机模拟的两种排版之一，AntD 页自身也会出现**（见“重复运行”）：起点 tip 的 AntD 页两轮各出现一种，与参照、交付的这张逐字节相同；通知卡宽度是 profile-validation 的同一机制；暗色手机两树本轮相同 |

计算样式差异（142 处）只有几类：WebKit 下行高的数值精度（`22px` 对 `22.000019px`，P3.2 已记录的 Lightning CSS 压缩精度）；`dialog` 选择器命中的旧 `.ant-modal` 是透明外层，Orbit 的 `.orbit-overlay` 本身就是表面（背景、圆角、阴影出现在被测元素上，P3.2 同样记录）；`table` 选择器命中旧表格的外层容器（936/358px），Orbit 命中在滚动盒里的 `<table>` 本身（984.5px，内容宽度）；以及上面的卡片 1px。

**trace**（[compare/f-p41-trace-semantics.txt](compare/f-p41-trace-semantics.txt)）：96 个用例、488 步，地址、请求（方法、路径、请求体）、通知、表格行、勾选、开关、主题、保存的偏好、密码框类型**全部相同，0 处差异**。原样比较有 57 份 trace 不同，差在不属于业务语义的字段，都是既有约定：

| 字段 | 步数 | 内容 |
| --- | --- | --- |
| 焦点 | 93 | 焦点落在带角色的元素上而不是隐藏的 `input`（单选、复选、开关、选择器）；开关保存中保留焦点（AntD 保存时焦点掉到 body）；选择器打开后焦点进入列表（P2.2）；撤销确认打开后聚焦确认层本身（P2.2/P3.2）；按钮点击后焦点留在按钮上 |
| 打开的对话框 | 16 | Orbit 撤销确认是 `role=dialog`，打开时列在对话框里（旧确认浮层不是） |
| 无效字段的说明 | 16 | AntD 在消息淡出期间把新旧两条消息一起作为说明（如 `Enter a new passwordAt least 6 characters`）；Orbit 在减少动态效果时立即只留当前消息 |
| 头像 `alt` | 8 | `alt=""`（装饰性图片，名字已在页面上） |
| 选项 | 5 | 打开的选择器把选项作为 `role=option` 暴露（旧下拉的选项没有角色） |

焦点的等价性另在开发期间逐项核对：打开新建令牌对话框聚焦 Name、Esc 依次把焦点还给 New token / Revoke / Access tokens、密码显示开关的键盘行为两树相同。

### P0 页面矩阵（同提交）

| 运行 | 提交 | 结果 |
| --- | --- | --- |
| [f-p0-ref](runs/f-p0-ref.txt) | 参照 `b5a39dd48`，写截图 | 101 通过、11 跳过 |
| [f-p0-strict](runs/f-p0-strict.txt) | 交付，对参照截图 0 像素严格比较 | 99 通过、11 跳过、**2 失败**：WebKit 明/暗手机 `profile` 的 `profile-validation`（378 / 341 像素） |
| [f-p0-del](runs/f-p0-del.txt) | 交付，写自己的截图 | 101 通过、11 跳过 |

逐张分类（[compare/f-p0-summary.json](compare/f-p0-summary.json)）：252 张，**236 张逐字节相同，12 张抗锯齿级，4 张超出**：

| 截图 | 环境 | 差异 | 归类 |
| --- | --- | --- | --- |
| `profile-validation` | WebKit 明/暗手机 | 4.9k / 4.2k 像素，全在顶部“Name saved”通知胶囊：交付比参照右移 4px | 本批引起，根因与隔离见下节 |
| `breakpoint-639-projects` | Chromium 暗色桌面 | 7 像素，≤4 级：项目页工具栏 AntD 分段控件左侧圆角 | **噪声**：两棵树都在同样两种逐字节结果间交替（重复运行 `n-*`：参照 3 轮得 2 种，交付 3 轮得 2 种，两树的两种相同）。该页不使用本批改动的组件（Orbit `Segmented` 只用于设置页与任务面板） |
| `task-action-focus` | Chromium 明色手机 | 2 像素，≤3 级 | **噪声**：交付再跑两轮，均与参照逐字节相同 |

settings 场景的截图（`settings`、`settings-saved`）8 个环境都与参照逐字节或抗锯齿级相同。

### 标准 P0 回归

`npm run test:ui-migration` 的同一配置，对照 P0.2 原图与漂移层/已接受层，在交付上跑了两次：

| 运行 | 结果 |
| --- | --- |
| [f-p0-standard](runs/f-p0-standard.txt)（正式运行之一） | **99 通过、11 跳过、2 失败** |
| [f-p0-standard-2](runs/f-p0-standard-2.txt)（作业 `bgj_5fe95ef2a8e0`，报告 [f-p0-standard-2.report.summary.json](runs/f-p0-standard-2.report.summary.json)） | **99 通过、11 跳过、2 失败**，同两项、同像素数 |

- 失败的都是 WebKit 明/暗手机的 `profile`，停在 `profile-validation`（378 / 341 像素），与同提交比较的那两张相同；期望、实际与差异图见 [shots/p0-standard](shots/p0-standard)。
- 参照 `b5a39dd48` 写出的这张截图与它的 P0 期望（main 漂移参考，归因 `d233a6cd0`）逐字节相同。
- 第一次运行的完整 JSON 报告被随后同一工作树里的一次 `--list` 覆盖（该配置的 JSON reporter 在列出用例时也写报告）。它的日志与失败目录完整，第二次运行补上了报告。

### WebKit 手机 profile-validation：根因与隔离

两棵树执行的是同一段通知代码，差别在通知出现前页面有没有做一次同步布局。逐步测量见 [toast-root-cause/](toast-root-cause)（探针 [probes.mjs](toast-root-cause/probes.mjs)，输出 `reference.json` / `delivery.json`）：

1. **1px 溢出从哪来**：资料页的内容在 `.app-view` 里滚动，文档本身正好 844px。`lib/toast.tsx` 的 `announce()` 在第一次提示时同步往 body 末尾加一个读屏 live region（`div.sr-only`），文档因此变成 845px。
2. **WebKit 手机的固定定位宽度**：index.css 全局的 8px `::-webkit-scrollbar` 让 Linux WebKit 手机模拟在溢出后把 `visualViewport` 宽度变成 382（两树都收到这次 resize），而 `documentElement.clientWidth` 仍是 390。溢出之后才排版的固定定位元素按 382 排，之前排好的保持 390，直到它自己需要重排（滚动会触发，样式或布局变化不会）。这是 [P2.3-B1](../p2.3-b1/README.md) 已经复现的同一现象（`root-cause/webkit-fixed-probe`）。
3. **参照为什么是 382**：从 live region 插入到通知列插入之间，AntD 的代码读了 Change password 表单 4 个 `.ant-form-item` 元素的 `offsetParent`（调用栈见 `reference.json`），这是一次同步布局。这次布局先看到了溢出，之后插入的通知列按 382 排：图层 382、通知列 350、胶囊 x = 123.14。
4. **交付为什么是 390**：Orbit 的 Field 不读布局。live region 和通知列在同一次布局中排出，通知列按溢出前的 390 排：图层 390、通知列 358、胶囊 x = 127.14，右移 4px。
5. **排除的其它解释**：
   - 改密码响应延迟 0/20/50/100ms，两树结果都不变。
   - 用 Enter 保存（不点击按钮，没有 AntD 波纹）结果不变。
   - 把参照页的 47 个 AntD 样式表注入交付页，结果不变。
   - 把参照页的头像、按钮换成同尺寸占位，结果不变；改密码卡片设为 `display: none` 并放同高占位后也不变（表单项仍在文档里，仍被读取）。
   - Base UI 复选框的隐藏 `input`（`position: fixed`）去掉或加一个同样的元素，结果不变。
6. **隔离**：在交付上只加一次同步读取（`scrollHeight`，紧跟 live region 插入，由测试注入，不改产品代码），探针得到 382/350。放进 P0 harness 原样运行 profile 场景（[isolation/](isolation)），对照 P0 期望截图：

   | 运行 | chromium-light-phone | webkit-light-phone | webkit-dark-phone |
   | --- | --- | --- | --- |
   | 不注入（[log](isolation/run-as-is.txt)） | 通过 | 失败 378 像素 | 失败 341 像素 |
   | 注入一次读取（[log](isolation/run-forced-read.txt)） | 通过 | **通过** | **通过** |

   注入后与 P0 期望逐像素一致（0 像素容差）。所以交付与 P0 期望之间只差这一次布局读取。
7. **对照其它通知**：
   - Chromium 手机上，两棵树和 P0 期望都把这个胶囊画在 390 宽的位置（图标 x = 138）。
   - 同一 WebKit 手机项目里，设置页的“Setting saved”胶囊在 P0 期望和两棵树里也都按 390 排，与 Chromium 相同。
   - 也就是说，交付在资料页上的位置与 Chromium、与设置页一致；P0 期望里 382 的位置来自 AntD 那次读取。
   - 真机 iOS Safari 用覆盖式滚动条，WebKit 桌面（1272）与 Chromium 不受影响（B1 的分析）。

**处理**：没有改产品代码去迎合。
- 在交付里补一次布局读取，等于为测试环境的排版怪癖复刻 AntD 的副作用。
- 改通知组件让它“总是按当前宽度排”，会把设置页的“Setting saved”改成 382，破坏现在通过的 P0 截图。
- 这两张截图要等协调者判定：作为本批的迁移差异接受（CONFIRM 后按 [p0-drift](../p0-drift/README.md)“已接受的迁移差异”规则，在本批落地后登记，before 为本批起点 `a84bc61e7`），或另行处理。
- 本批没有改 P0 截图、场景、断言、等待条件或任何登记。在处理之前，项目线上直接运行的 P0 矩阵会在这两张上失败。

### 管理端 Sign-in 卡片

AdminSignInPage 用同一组卡片类名（见“`.orbit-card` 的决定”），已在 Orbit 控件上，P0 与 P4.1 用例都不覆盖。为说明收编的影响，用 P0 固定数据加一个固定的 `GET /admin/sign-in/google`，在两棵树的 8 个环境各截一张（[admin-signin/](admin-signin)，脚本 [admin-signin-shots.mjs](scripts/admin-signin-shots.mjs)，几何与比较 [compare/admin-signin-compare.json](compare/admin-signin-compare.json)）：
- 头部高度不变（56px）；标题盒 24→25.14px，文字中心不变，头部区域像素相同。
- 正文起点上移 1px，卡片矮 1px（桌面 611.86→610.86，手机 745.16→744.16）。
- 正文部分与参照整体上移 1px 后逐像素相同（6/8 个环境）。
- Chromium 桌面另有选中单选圆点 21 个像素、≤4 级的抗锯齿残差；WebKit 手机另有 8px 滚动条滑块随内容高度变化。

### P3.2 试点复跑

公共组件的改动（Dialog 宽度上限与滚动终点、Popconfirm 定位、MultiSelect、Segmented 默认尺寸与任务面板的 `size="small"`）也落在已迁移的页面上。用 P3.2 的试点用例检查这些页面没有变：任务详情、分享对话框、任务附件与账号选择器，88 个用例 × 8 环境。
- 参照：本批起点 `a84bc61e7`，还没有这些改动（`pilot-tip`）。
- 交付：`b0b59fa39`。
- 两者都用 4321 端口：分享链接里带端口。

| 运行 | 提交 | 结果 |
| --- | --- | --- |
| [pilot-tip](runs/pilot-tip.txt) | 起点 `a84bc61e7` | 81 通过、7 跳过 |
| [pilot-final2](runs/pilot-final2.txt) | 交付，4321 端口（作业 `bgj_69e56f4b2d88`） | 80 通过、7 跳过、1 失败：WebKit 暗色桌面 “fields, pickers and the panel header” 超过 90 秒用例时限（1.6 分钟，主机 1 分钟负载 42–67） |
| [pilot-rerun](runs/pilot-rerun.txt) | 交付，WebKit 暗色桌面 “dependencies, inputs and comments” × 3 | 3 通过（6.3–7.5 秒） |
| [pilot-rerun2](runs/pilot-rerun2.txt) | 交付，WebKit 暗色桌面 “fields, pickers and the panel header” × 3 | 3 通过（7.8–8.7 秒） |

截图（[compare/pilot-final2-summary.json](compare/pilot-final2-summary.json)）：256 张中 **200 张逐字节相同，47 张抗锯齿级，5 张超出**，另有 4 张因上面那个超时没有写出。这 4 张（`pilot-delete-confirm`、`pilot-list-open`、`pilot-list-search`、`pilot-run-hint`，WebKit 暗色桌面）由 `pilot-rerun2` 写出，与起点逐字节相同（[compare/pilot-rerun2-vs-tip.json](compare/pilot-rerun2-vs-tip.json)）。超出的 5 张都属于 P3.2 已记录或运行间会变的抗锯齿：
- `pilot-delete-confirm`（Chromium 明/暗桌面，14–17 像素，≤20 级）：面板关闭图标，P3.2 记录其交付自身相邻运行之间也差 15–20 级。
- `pilot-share-loading`（Chromium 明色桌面，65 像素，20 级）：Spinner 静止帧中旋转圆点的抗锯齿，P3.2 记录同类。
- `pilot-dependencies`、`pilot-dependency-view-hover`（WebKit 暗色手机，100 像素，3 级）：依赖图连线；同一张在 4173 端口那一轮是 17 像素、3 级。

trace：72 份中 62 份原样相同，其余差在焦点表现的时序（P3.2 记录的同一类）。

第一次复跑（`pilot-final`，作业 `bgj_d6836b24923d`）误用了 4173 端口。分享链接里的端口文字使 32 张分享对话框截图不同；同一轮 WebKit 暗色桌面的 “dependencies, inputs and comments” 在负载 55 时超时。该轮记录保留在 [runs/](runs)（`pilot-final.*`）与 [compare/pilot-final-summary.json](compare/pilot-final-summary.json)，结论以 `pilot-final2` 为准。

本批开发期间在提交前跑过一轮（`pilot-del`，代码与交付相同，4321 端口）：81 通过、7 跳过；截图 210 张相同、45 张抗锯齿级，1 张超出（`pilot-delete-confirm` 关闭图标，5 像素）。

### 组件矩阵与合并检查

在交付 `b0b59fa39` 上依次运行（作业 `bgj_15f6ab6272d2`，脚本 [checks.sh](scripts/checks.sh)，每项在独立网络命名空间里）：

| 运行 | 覆盖 | 结果 |
| --- | --- | --- |
| [c-overlays](runs/c-overlays.txt) | `npm run test:ui-overlays`：Dialog、确认层等弹层矩阵（本批改了 Dialog 的宽度上限与滚动终点、Popconfirm 的定位方式） | **96 通过** |
| [c-choices](runs/c-choices.txt) | `npm run test:ui-choices`：选择控件矩阵（本批改了 MultiSelect 的首项高亮与放大镜、Segmented 的默认尺寸） | **520 通过**（23.7 分钟） |
| [c-merge](runs/c-merge.txt) | 合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过（`tsc -b` 与 Vite），**Vitest 347 个文件、4414 个用例全部通过** |

其中本批相关的单测：资料页、设置页、访问令牌、CLI 登录、管理员令牌的既有测试改用角色与名称；新增 [SetupPage.test](../../../../src/web/src/pages/SetupPage.test.tsx)（空提交、逐字段校验文案、确认密码跟随、提交内容与跳转、拒绝时保留表单、已有用户时转到登录）与 [ProfilePage.password.test](../../../../src/web/src/pages/ProfilePage.password.test.tsx)（空提交、输入中校验与确认跟随、有效提交的请求体、成功后清空）。

### 重复运行

正式运行后，两棵树各再跑两轮 P4.1 的选图用例与两个 CLI 登录用例（作业 `bgj_d6836b24923d`，[followup.sh](scripts/followup.sh)；每轮 24 个用例，4 轮全部通过）。逐张哈希见 [compare/repeats.json](compare/repeats.json)（[repeats.py](scripts/repeats.py)）。三轮 × 两树、56 张截图中，45 张每一轮都逐字节相同。其余：

- **`p41-profile-photo`**（Chromium 四个环境）：
  - 每棵树自身三轮就有 1–3 种结果。树内两轮之间最多差 89 像素、40 级；跨树最多 107 像素、40 级，同一量级。
  - Chromium 暗色手机上有一对跨树结果只差抗锯齿级（34 像素、2 级）。
  - 差异只在头像圆边与圆角的抗锯齿像素；两树的结果集合不重叠。
- **`p41-cli-denied`**：
  - WebKit 明色手机有两种结果：一种是通知卡 350 宽、页面停在最左；另一种是通知卡 358 宽、页面横向滚到最右。卡片固定 500px 宽，手机上本可横向滚动；Approve/Deny 两树都靠右。
  - 起点 tip 的 AntD 页两轮各出现一种，分别与参照和交付的结果逐字节相同。参照 `b5a39dd48` 三轮都是前者，交付三轮都是后者。通知卡宽度是 profile-validation 的同一机制（WebKit 手机 382/390）。
  - 其它 6 个环境（Chromium 四个、WebKit 明色桌面与暗色手机）各有至少一棵树在自己的三轮之间出现两种结果；正式对照中都在抗锯齿级以内。

## 迁移清单

交付提交上重跑复扫（[delivery-audit-summary](checks/delivery-audit-summary.txt)、[delivery-check-owners](checks/delivery-check-owners.json)），[inventory-closure.mjs](inventory-closure.mjs) 对比参照 `b5a39dd48` 与交付 `b0b59fa39`（[inventory-closure.json](inventory-closure.json)）：

- P4.1 负责的使用点 **18 → 0**；未归属 0、待定 0。其它阶段的数量不变（P4.2 81、P4.3a 82、P4.3b 33、P4.4 50、P5.1 28、P5.2 11、P5.3 90、P6 36、KEEP 1）。
- 7 个生产文件不再导入 antd（导入前后逐文件列在 `files`）；`@ant-design/icons` 的引用多 1 处（CLI 登录页的结果图标），按项目约定保留。
- 测试文件中的 `.ant-*` 选择器：本批 8 个测试文件全部清零；`AdminUsersPage.accessTokens.test` 剩下的 4 处属于用户表与 AntD Modal，归 P4.2。
- index.css：`.ant-*` 149 行（少 1 行：`.access-token-field .ant-radio-group`），提到 AntD 的行少 2 行（`.orbit-card` 上方的两行注释随卡片样式移出）。

## 未消除的差异

1. **WebKit 手机 P0 `profile-validation`**（明/暗）：通知胶囊右移 4px，标准 P0 回归因此有 2 个失败。根因与隔离见上，待协调者判定。
2. **`p41-profile-photo` 的边缘抗锯齿**：Chromium 三个环境 81–87 像素、≤33 级。每棵树自身各轮之间的差异同一量级，单独探针渲染两树逐字节相同；但两树的结果集合不重叠，具体来源没有查到。可见效果为头像下半圆边与几个圆角的个别像素。
3. **WebKit 下的行高精度**：`22.000019px` 一类的数值来自全站 CSS 压缩，与 P3.2 相同，截图不受影响。

## 报告协调者的问题

已在任务评论中报告（2026-10-07 15:43 UTC）：

1. **需要判定**：P0 的 WebKit 明/暗手机 `profile-validation`（见“WebKit 手机 profile-validation：根因与隔离”）。
2. **范围外，未修：浮层第一帧位置**。
   - 机制：Base UI 的 Positioner 第一次在 `position: fixed` 下测量位置，再以 `absolute` 应用。浮层挂在已定位的容器（对话框等）里时，第一帧按容器偏移画在错误位置，下一帧回位；减少动态效果时这一帧可见。
   - 本批只把 Popconfirm 改为 `positionMethod="fixed"`。Select、Combobox、MultiSelect、Menu、Popover、Tooltip 是同样写法。
   - 交付上的实测（[frames/](frames)，减少动态效果）：
     - 新建令牌对话框的 Workspaces 多选框，桌面第一帧画在 (744, 559)，之后在 (384, 459)，偏 (+360, +100)；Chromium 与 WebKit 手机偏 (+8, +108)。第一帧完全不透明。
     - 旧 AntD 下拉第一帧就在最终位置，只是淡入。修正后的 Popconfirm 第一帧也已在最终位置（桌面 (850, 152)、手机 (0, 204)，与旧确认浮层相同）。
   - 并行任务 [P2 跟进（第 2 批窗口）](orbit-task:34blUhb6Wip3e5nyziKfq) 正在改 Menu、Select 和 Overlay.tsx，本批没动它们，建议由该任务或新任务同样处理。本批的 `Overlay.css` 与 `Popconfirm.tsx` 改动与该任务相邻，落地时需留意合并。
3. **磁盘**：根分区从 14:50 UTC 的 15G 降到 15:42 UTC 的 4.9G（100%），低于作业指导的 30G。本批临时目录 1.8G（参照工作树 1.1G），判定后清理。

## 未确立的部分

- 只在 Linux 的 Playwright Chromium/WebKit 模拟中比较，没有真机、没有读屏软件实测。
- 默认动态效果（非减少）下的逐帧外观没有做同提交对照：两树都在减少动态效果下比较；消息淡入淡出、校验图标放大的时长与曲线按旧组件取值，只在开发探针中核对。
- `AdminUsersPage` 自己的 AntD 用户表与 Modal 未动（P4.2）；本批只让其中的访问令牌表与撤销确认用上 Orbit 组件。
- P0 的 settings/profile 场景只覆盖本批的部分状态，其余状态由 P4.1 用例覆盖；没有在 main 的其它入口（如移动端 App 内嵌页）上验证。

## 复跑

按作业指导准备工作树（`bash scripts/worktree-overlay.sh`）与 P0.2 浏览器环境后，在交付树 `src/web`：

```bash
npm run build -w @orbit/web
# 同提交参照树：交付提交撤回业务切换，单独构建（scripts/make-reference.sh 的做法）
git worktree add --detach /var/tmp/p41-ref b0b59fa39 && git -C /var/tmp/p41-ref revert --no-edit 7d81822b1
# P0 页面矩阵：参照写截图，交付严格比较并写自己的截图（配置复制自 p3.2/p32-reference.config.mjs）
P32_SNAPSHOTS=$R/ref-shots P32_OUTPUT=$R/ref-out npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all   # 在参照树
P32_SNAPSHOTS=$R/ref-shots P32_OUTPUT=$R/strict-out npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none # 在交付树
# P4.1 用例：两棵树各写一套截图
P41_SNAPSHOTS=$R/p41-shots P41_OUTPUT=$R/p41-out npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
# 分类与 trace
python3 docs/evidence/base-ui-migration/p3.2/compare_runs.py REF_SHOTS DEL_SHOTS REF_REPORT DEL_REPORT OUT.json
python3 docs/evidence/base-ui-migration/p4.1/summarize.py OUT.json
python3 docs/evidence/base-ui-migration/p4.1/trace-semantics.py REF_REPORT DEL_REPORT
# 标准 P0、组件矩阵与合并检查
npm run test:ui-migration -w @orbit/web
npm run test:ui-overlays -w @orbit/web && npm run test:ui-choices -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
# WebKit 手机通知：探针（两棵树各起 vite preview）与 P0 harness 内的隔离
node docs/evidence/base-ui-migration/p4.1/toast-root-cause/run.mjs http://127.0.0.1:PORT <树>/src/web/ui-migration readsBetween
ISO_FORCE=1 ISO_OUTPUT=/tmp/iso npx playwright test --config <复制的 isolation.config.mjs> --project webkit-light-phone
```

本批运行时实际用的脚本在 [scripts/](scripts)：`formal-runs.sh`（正式运行）、`checks.sh`（组件矩阵与合并检查）、`followup.sh`（试点复跑与重复运行）、`noise-repeat.sh`（P0 两张小差异的重复）、`make-reference.sh`（参照树）。正式运行在主机网络里逐个执行（4173 与 4331 端口）；之后的组件矩阵、合并检查、试点复跑和重复运行都放在独立网络命名空间里（`unshare -n`），固定端口不与其它会话冲突。

## 文件清单

由 [scripts/collect.sh](scripts/collect.sh) 从 `/var/tmp/p4.1-293463` 复制；完整原始运行（含 trace.zip 与带附件的报告）留在那里，判定后清理。

| 路径 | 内容 |
| --- | --- |
| [checks/](checks) | 开工与交付时的 `audit-antd.mjs` 摘要与 `--check-owners` 结果 |
| [inventory-closure.mjs](inventory-closure.mjs)、[inventory-closure.json](inventory-closure.json) | 清单关闭的逐文件、逐类比较 |
| [runs/](runs) | 每次运行的日志 `*.txt`（`checks.sh`、`followup.sh`、`final.sh` 写出的日志开头有 argv、HEAD 与未提交路径）和去掉附件正文的报告 `*.report.summary.json` |
| [compare/](compare) | 截图与样式比较（`compare_runs.py` 输出与 `summarize.py` 分类）、trace 语义比较、试点比较、重复运行的逐张哈希、管理端卡片比较 |
| [traces/](traces) | P4.1 两次正式运行每个用例的逐步 trace |
| [shots/p41-beyond](shots/p41-beyond)、[shots/p0-beyond](shots/p0-beyond) | 超出抗锯齿级的每一张，参照与交付并列 |
| [shots/p0-standard](shots/p0-standard) | 标准 P0 两个失败的期望、实际与差异图 |
| [shots/p41-delivery](shots/p41-delivery) | 交付在 Chromium 明色桌面与 WebKit 暗色手机上的全部 P4.1 状态 |
| [admin-signin/](admin-signin) | 管理端 Sign-in 卡片：8 个环境的几何，两个环境的截图 |
| [toast-root-cause/](toast-root-cause) | WebKit 手机通知的探针与两棵树的输出 |
| [isolation/](isolation) | 在 P0 harness 里注入一次布局读取的配置、用例与两次运行日志 |
| [frames/](frames) | 对话框内浮层（MultiSelect、撤销确认）开头几帧的位置 |
| [scripts/](scripts) | 本批实际运行的脚本与开发探针（`probe-scenarios.mjs` 含开发期间逐元素取样 AntD 页面的探针） |
| [summarize.py](summarize.py)、[trace-semantics.py](trace-semantics.py)、[extract-traces.py](extract-traces.py) | 分类、trace 语义比较与 trace 抽取 |
