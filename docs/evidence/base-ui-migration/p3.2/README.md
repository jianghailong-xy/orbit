# P3.2 任务详情、分享与任务附件试点

服务于 [P3.2 迁移任务详情、分享与任务附件试点](orbit-task:34Za39ACSBoCkYKc80Md8)，起点为项目分支 tip `da13423d3`（含 P3.1 交付）。开工读取了任务完整信息与历史评论（协调者关于额度中断后先提交 WIP 的说明）、项目目标/作业指导/验收条目、P0.1 清单（component-contracts、ownership、css-ownership）、P0.2 基线及 P1.2/P2.x/P3.1 交付。项目验收条目 key `3ojnKuvd3dQLuwsFV8g7Ll`，原文：**P3：任务详情与分享试点及会话输入代表场景达到既有外观和操作要求，并形成成本对照。** 本任务承担其中“任务详情与分享试点”子范围：试点在相同数据与环境下保持明暗/手机/桌面外观，编辑、分享、附件和输入操作保持原语义，受影响测试通过，并有迁移成本和实测对照。第 1 版落地与 main 冲突后，第 2 轮把 main 合入交付并复验受影响的部分，见文末[“第 2 轮：合入 main”](#第-2-轮合入-main落地冲突返工)。

## 范围

按 P0.1 `ownership.json`（phase 为“实际切换/清理的负责阶段”）：

| 文件 | 归属 | 本次 |
| --- | --- | --- |
| `TaskDetailPanel.tsx` | P3.2 | 全部 AntD 控件切换（见下表） |
| `ShareModal.tsx` | P3.2 | 全部切换 |
| `TaskInputs.tsx` | P3.2 | 全部切换，Upload 外壳换为原生多选文件输入 |
| `AccountSelect.tsx` | P4.2，任务范围点名“AccountSelect 等直接依赖” | 切换为 Orbit Select |

面板内渲染、但清单归属其它批次的子组件**未切换**，仍是 AntD：`TaskScheduleEditor`、`pages/TaskDetailPage` 的 `TaskAcceptance`、`TaskAttributionCard`、`TaskDependencyList`、`MentionDeliveryNotes`、`OwnerConfirmationReview`、`TaskDependencyGraph`（P4.3），`WatchRelations`/`TaskFollowedBy`（P4.4），`Transcript` 的 Markdown 图片（P5.2）。P4.3 任务（“迁移任务、项目、依赖图与决策卡片”，验收含“本批 AntD 使用点关闭”）仍为 OPEN，越界切换会替它关闭使用点。新旧组件在同一面板共存，主题、层叠、弹层与焦点在下文的试点对照中逐步核对。

## 提交

| 提交 | 内容 |
| --- | --- |
| `6e3e4f464` | feat：新增 Popconfirm/Segmented/Avatar/Alert；试点暴露的 P1/P2 公共组件修正（见下文）；choices fixture 为其 AntD 样例保留原分享菜单图标偏移 |
| `c4cc93eb7` | feat：TaskDetailPanel、ShareModal、TaskInputs、AccountSelect 切换；index.css 去掉 13 处 `.ant-*` 覆盖、改写到 Orbit 类；8 个单测文件改用角色/名称；P0 已知失败 FOCUS-1/FOCUS-2 转为通过 |
| `87f04679e` | test：`pilot.browser.mjs` 对照用例、`pilot-fixtures.mjs` 固定数据、`pilot-performance.browser.mjs`、`pilot.config.mjs`/`port.config.mjs`；P0 矩阵忽略试点用例 |
| `ba65da226` | fix：WebKit 对照发现的浮层滑回取整/箭头与下拉越界判定时机 |
| `131a8803f` | test：运行中提示截图前清除焦点（两树相同） |
| `5180e3319` | fix：浮层箭头改用布局偏移（记录运行发现小数 translate 使箭头边缘抗锯齿） |
| `3bfe489a4` | fix：末端对齐的列表保留旧组件左缘的小数部分（P0 task 场景发现 More 菜单文字差 0.17px） |
| `9edbaef26` | test：试点评论框加入中文输入法组合步骤（P3 验证方法点名中文输入与候选菜单） |
| `bd4f2ca0d` | fix：下拉对齐边按组件请求的对齐方式判定（P2.2 动效矩阵发现翻转到上方的手机附件菜单 x=−95：Floating UI 也会试另一种对齐作为后备，旧实现用后备的对齐做了判定） |
| `076e4ad0c` | test：P3.1 composer fixture 的 AntD 评论框样例保留 `.tdp-compose .ant-input { flex: 1 }`（该业务覆盖已从 index.css 清理，移入 fixture 样式） |
| `5311a0cf7` | fix：共享 Dialog 外壳恢复 22px 行高，无单位行高只给试点的分享与 Reopen 对话框（审阅对话框对照发现，见下） |
| `abb4c29e7` | test：OrbitKit 的两个文案对照测试改按 Orbit 属性名查找同样的词（`okText` → `confirmText`、`type="primary"` → `variant="primary"`）；分享对话框的确认层重新显式写出 `cancelText="Cancel"`（OrbitKit 对照发现，见“回归矩阵”） |

之后的提交只增加本目录证据（第 2 轮的合并与提交见“第 2 轮：合入 main”）。开发期间的两个 WIP 提交（`0111a8c9e`、`6f9b84e2e`，协调者要求先保存进度）与修正 `74e50482e` 已按内容重排为以上提交，源码逐字节相同。

## 组件与公共层修正

新增（只覆盖试点实际使用的能力，见 [ui/README](../../../../src/web/src/components/ui/README.md)）：

| 组件 | 替代 | 要点 |
| --- | --- | --- |
| `Popconfirm` | AntD Popconfirm | trigger 或 anchor+受控 open；title/description/confirmText/cancelText/danger/confirmLoading；onConfirm 返回 Promise 时 loading，resolve 关闭、reject 保留；打开聚焦浮层，`returnFocus` 指定关闭后焦点；贴视口边缘、最宽 100vw，与旧确认浮层相同 |
| `Segmented` | AntD Segmented | radiogroup；紧凑尺寸；选中块 0.3s 滑动（减少动态效果时直接切换）；方向键移动并选中 |
| `Avatar` | AntD Avatar（文字头像） | 圆形首字头像，尺寸/颜色由调用方给出 |
| `Alert` | AntD Alert（error） | role=alert；带说明时与旧组件相同的内边距、图标与标题字号 |

试点在真实页面暴露的 P1/P2 公共组件问题，在公共层修正（每条在本批对照中由截图/样式差异发现，修正后对应差异消失）：

- Select 家族根类名改为 `.orbit-select`：原 `.orbit-choice` 与 Checkbox/Radio 标签类同名，两份样式同时加载时互相套用边框与内边距。
- loading 时箭头位置显示旋转弧形，可搜索 Combobox 打开时显示放大镜；无边框变体聚焦/打开时 1px 品牌色内描边；打开且有值时值淡化到 .25；列表宽度用锚点精确宽度（Base UI 的 `--anchor-width` 取整到设备像素）。
- Select 与 Combobox 只在值真正改变时回调：重选当前项只关闭列表（试点 trace 发现 Combobox 重选会再发一次 PATCH，单测先复现两次 PATCH 后修正）。
- 浮层位置按被替换的 rc-trigger：其 `useAlign` 对每个 inset 向下取整（`Math.floor`，@rc-component/trigger 3.10.1 `lib/hooks/useAlign.js:491-497`），Floating UI 四舍五入，小数部分≥.5 的锚点会差1px；下拉列表与触发器起/止边对齐，越界时改对另一边而不沿触发器平移，并收窄到对齐一侧的剩余宽度（手机上的 Suggested 与访问权限菜单）；确认浮层最宽 100vw（原 Popover 的 `100vw-16px` 使手机删除确认窄16px）。
- Combobox 的值/占位/输入框放在同一个行盒（与旧选择器的 content 盒相同）：整体淡化（原先输入框底色与值分别半透明，叠加后文字差≤11级）；值与占位保持在文档流中，未设宽度的字段搜索时不塌缩；输入框由 inset 撑满（百分比高度使输入文字低1px）；行盒内隐藏的不换行空格提供基线（否则依赖区块高1px）。
- 未选值的 Combobox 打开即高亮第一项（旧 `defaultActiveFirstOption`，Enter 选中）。
- Checkbox/Radio/Switch 标签的行高改为无单位 1.5714（原固定 22px，在非 14px 文字上与旧组件不同；生产中只有试点使用这三个控件）。分享与 Reopen 对话框替换的 AntD Modal 同样是无单位行高，但共享 Dialog 外壳保持 22px：审阅对话框（ReviewCard、ProjectMergeStrip）直接基于它设计，第一次把外壳改成无单位后，审阅对话框对照发现手机上的计划与问题对话框按钮变矮、长计划正文变高；`5311a0cf7` 改为在 index.css 中限定到这两个对话框（`.share-dialog.orbit-overlay`、`.tdp-reopen-dialog.orbit-overlay`）。

## 对照方法

沿用 P3.1 的同提交对照：参照树是项目 tip `da13423d3` 的独立工作树（`/var/tmp/p32-ref`），只额外复制本批的 `pilot*.mjs`、`p32-reference.config.mjs`、`port.config.mjs` 与 `motion.config.mjs`；交付树为本分支。两棵树各自 `vite build`，用同一端口先后 `vite preview`（分享链接含绝对地址，端口不同会让截图不同），同一 Playwright 1.63.0 / Chromium 1243 / WebKit 2359、P0 字体与 `environment.mjs` 校验、DPR1、en-US/UTC、固定时间与固定 REST 数据（`pilot-fixtures.mjs`），默认 reducedMotion=reduce；八组合 = Chromium/WebKit × 明/暗 × 桌面 1280×900 / 手机 390×844。

`pilot.browser.mjs` 只经角色、可访问名称和页面自有类名操作，同一文件同时驱动 AntD 参照和 Orbit 交付：
- 截图：P0 harness 的 `capture`（等待两帧相同、0 像素容差写入各自目录），之后由 `compare_runs.py` 逐像素对比两树同名 PNG，不缩放、不屏蔽、不修图；判定分为逐字节相同、仅抗锯齿级（每个差异像素每通道≤2，与 P3.1 判定相同）与超出。
- 计算样式：每个截图点记录所选元素的尺寸、字体、颜色、背景、边框、圆角、阴影，逐项比较。
- trace：每步记录焦点所在（角色+名称）、可见弹层/对话框/菜单/选项/提示，以及该步发出的非 GET 请求（方法、路径、请求体），逐步比较两树。

`pilot-performance.browser.mjs` 按 P0.2 performance 方法在 chromium-light-desktop 取加载与操作耗时；`bundle-size.py`（P3.1）计初始 HTML 引用资源的 raw/gzip。

## 业务切换

| 文件 | 原 AntD | 现在 |
| --- | --- | --- |
| `TaskDetailPanel.tsx` | Alert, Avatar×3, Button×9, Dropdown, Input.TextArea, Modal, Popconfirm, Segmented, Select×6, Spin×3, Switch, Tooltip×2, Typography.Paragraph | Alert, Avatar, Button, Menu（More）, P3.1 Textarea（原生 ref 恢复 @提及光标）, Dialog（Reopen，Back/Reopen 页脚）, Popconfirm（Delete）, Segmented, Select（Suggested）/Combobox（Assignee/Provider/Model/List/Add prerequisite）, Spinner, Switch, Tooltip, 原生段落 |
| `ShareModal.tsx` | Button×5, Checkbox, Dropdown, Modal, Popconfirm, Select, Spin | Button/LinkButton, Checkbox, Menu（Access）, Dialog（`returnFocus`）, Popconfirm（锚定 Access 行、受控）, Select（Expires）, Spinner |
| `TaskInputs.tsx` | Button×2, Popconfirm, Upload | Button, Popconfirm（Remove）, 原生 `<input type="file" multiple hidden>`：每个文件一次 `uploadAttachment`（multipart + bearer），按钮上拖放同样接收，选择后清空 value 使重选同一文件即重试；授权缩略图仍以带令牌的 fetch 生成 object URL 并在卸载/竞态时回收 |
| `AccountSelect.tsx` | Select | Select（`renderOption` 显示状态，null 保护） |

业务语义保持：每个字段的请求方法/路径/请求体、成功后的缓存刷新、错误通知文字与重试路径不变（下文 trace 逐步核对请求）；只有“重选当前值”在旧组件与新 Select 中都不发请求，新 Combobox 起初会多发一次，已修正。

`index.css` 去掉 13 处只服务这四个文件的 `.ant-*` 覆盖（`.tdp-head > .ant-btn-icon-only`、`.tdp-head-actions > .ant-btn` 等 3 处、`.tdp-assignee-select.ant-select …` 4 处、`.tdp-dependency-view.ant-segmented`、`.tdp-compose .ant-input`、`.share-access-menu .ant-dropdown-menu-item` 2 处、`.share-layer-check .ant-checkbox`），同样的规则写到 Orbit 类上；其中 `.share-access-menu .ant-dropdown-menu-item { align-items:flex-start; padding:8px }` 在旧页面上从未生效（实测旧菜单项仍是 5px 居中），未搬运。其余 147 处 `.ant-*` 属于其它页面，未动。组件样式在 index.css 之后加载，业务覆盖 Orbit 类时以组件类限定提高优先级（如 `.share-layer-check.orbit-choice`）。

单测：8 个文件（TaskDetailPanel ×3、ShareModal、ProjectShareControls、WorkspaceView.shareEntry、SharedLinksPage、RunnerDetailPage.codexAccount）改为按角色、可访问名称和 aria 状态查找，不再依赖 `.ant-*` 类或 AntD 内部结构；Base UI 选项需要真实的 pointer/mouse 序列才当作点击，测试用 `press()` 发送完整序列。新增“重选当前模型不发请求”用例，先在修正前复现两次 PATCH。

## 迁移成本

由 [cost.py](cost.py) 从 git 统计（`da13423d3..abb4c29e7`，src/web 共 42 个文件 +1756 / −373，[cost.json](cost.json)；另有 src/macos 的 2 个 OrbitKit 对照测试 +3 / −3）：

| 类别 | 行数 | 说明 |
| --- | --- | --- |
| 新增 Orbit 组件 | +240 / −0（7 文件） | Popconfirm 74、Segmented 69+35、Avatar 16+8、Alert 24+14 |
| 已有公共组件修正 | +249 / −63（12 文件） | Floating.ts 定位 +111/−2、Select.css +36/−24、Combobox +28/−13、ui/README +13；其中 Floating.css 的 Popconfirm 样式 11 行与 foundation.css 的 Avatar/Segmented 明暗变量 12 行实为新组件所需 |
| 公共组件 fixture | +9 / −1（2 文件） | 为 AntD 参照样例保留被清理的业务覆盖 |
| 业务文件 | +242 / −194（4 文件） | 绝大部分是一对一换组件和属性名 |
| 业务样式 index.css | +52 / −22 | `.ant-*` 提及 188 → 170 |
| 单测 | +157 / −85（8 文件） | 选择器改为角色/名称；新增重选用例 |
| 浏览器对照工具 | +807 / −8（8 文件） | pilot.browser 411、pilot-fixtures 204、pilot-performance 147、配置 36；后续批次可复用 |

试点需要的新组件很小；成本主要在两处：一是让 P2 组件在真实页面上与旧组件逐像素一致（定位取整、越界翻转、下拉宽度、选择器内部盒结构），这些修正只做一次、后续批次直接复用；二是对照工具。业务切换本身接近一对一。

## 迁移清单更新

P0.1 清单（[ownership.json](../ownership.json)、[css-ownership.json](../css-ownership.json)、[component-contracts.md](../component-contracts.md)）是固定基线，不改写；本批关闭的条目与新增归属记录在此，逐文件的机器记录见 [inventory-closure.json](inventory-closure.json)。

- **文件**：`ownership.json` 中阶段为 P3.2 的 3 个文件（TaskDetailPanel、ShareModal、TaskInputs）全部切换，不再 import antd；任务范围点名的 AccountSelect（归属 P4.2）一并切换。
- **样式**：`css-ownership.json` 中归属 P3.2 的 3 个区段（TaskDetailPanel 10857–11366、TaskDetailPanel compose 12394、ShareModal 13393–13463，基线行号）共 13 行 antd 命中，全部删除，规则改写到 Orbit 类上，按业务前缀（`.tdp-`、`.share-`）仍归这三个区段；tip 与交付的 index.css 中这两个前缀下的 `.ant-*` 行分别为 13 与 0。
- **测试**：8 个测试文件不再依赖 `.ant-*` 类或 AntD 内部结构。
- **契约**：Upload 按 P3.2 契约换为原生文件选择 + 既有上传/删除 API；Segmented、Alert、Avatar 按“按需求”契约、Popconfirm 按 P2.1 契约（锚点、操作文案、异步 onConfirm、失败后保留、取消/外部关闭），都只实现试点用到的部分——Alert 只有 error 状态，Avatar 只有文字头像（图片与加载失败回退留给用到它们的批次），Typography.Paragraph 换为原生段落。
- **新增文件归属**：`ui/Popconfirm.tsx`、`ui/Segmented.tsx/.css`、`ui/Avatar.tsx/.css`、`ui/Alert.tsx/.css` 是供后续批次复用的 Orbit 公共组件；`ui-migration/pilot*.mjs`、`port.config.mjs` 是 P3.2 的验证入口；choices/composer fixture 样式里新增的两条 `.ant-*` 规则只服务各自 fixture 的 AntD 参照样例，随这些参照在 P6 退役；Floating.css 新增的 `.anticon` 尺寸规则属于允许保留的图标边界。没有新增 antd import 或内部 ref。
- **定制代码、覆盖样式与修改范围**：见“组件与公共层修正”“业务切换”“迁移成本”；**同场景包体积与交互测量**：见“包体积与同场景耗时”。

**AntD 清单**（P0.1 `audit-antd.mjs` 在 tip 与 `5311a0cf7` 各跑一次：[ref-antd-audit](checks/ref-antd-audit.txt)、[antd-audit](checks/antd-audit.txt) → [inventory-closure](checks/inventory-closure.txt)、[inventory-closure.json](inventory-closure.json)；`abb4c29e7` 没有增减任何 antd 或 `.ant-` 文本）：

- 4 个试点文件不再 import `antd`：生产文件中 import antd 的 99 → 95；阻碍退役的文件 228 → 223。
- `.ant-*` 选择器命中行 449 → 394、`.ant-` 类名命中行 480 → 422；含 `.ant-*` 选择器的测试文件 58 → 53（8 个试点测试文件改用角色/名称）。
- 试点文件余下的命中：`imperative-feedback`（`message.success(` 等文本模式，实为 P2.3 的 Orbit `useToast()`，与 tip 相同）和 `@ant-design/icons` 引用（按项目约定保留）。新增的图标引用来自 Alert、Popconfirm 与 Floating.css 的 `.anticon` 尺寸规则；`rc-support` +7 行是 Floating.ts 与 ui/README 注释中对 rc-trigger 行为的出处说明，不是依赖。

## 试点对照结果

记录运行（[checks](checks)，每项保存 argv、cwd、HEAD、未提交路径、源码哈希、退出码与完整输出）。最终代码为 `abb4c29e7`；中间提交上的记录运行保留为发现问题的过程（见下）。[verify-claims.py](verify-claims.py) 按这些记录与对照文件逐条核对本文关于最终提交的结论（哪些运行在哪个提交上通过、请求与计算样式的差异范围、P0 失败只属 task 场景、审阅对话框与 OrbitKit 同 tip、choices 失败全是同一步）。

| 检查 | 树 / 提交 | 结果 |
| --- | --- | --- |
| [ref-build](checks/ref-build.txt)、[build-6](checks/build-6.txt) | tip `da13423d3` / `abb4c29e7` | 构建通过 |
| [ref-pilot-4](checks/ref-pilot-4.txt) | tip（AntD 参照，含中文输入步骤） | 64/64 通过（8 用例 × 8 环境） |
| [pilot-6](checks/pilot-6.txt) → [pilot-compare-6](pilot-compare-6.json)、[摘要](pilot-summary-6.json) | `abb4c29e7` | 64/64；240 张截图 **72 逐字节相同、138 仅抗锯齿级（每通道≤2）、30 超出，其中 20 张与参照自身噪声相同**；56 条 trace **请求逐步全部相同**；108 个截图点的 120 项计算样式差异全部是行高数值精度（“未消除的差异”第 5 条） |
| [pilot-5](checks/pilot-5.txt) → [pilot-compare-5](pilot-compare-5.json)、[摘要](pilot-summary-5.json) | `5311a0cf7` | 74 / 147 / 19，其中 10 张为参照噪声；样式与请求结论同上 |
| [pilot-6-vs-5](checks/pilot-6-vs-5.txt) → [pilot-6-vs-5](pilot-6-vs-5.json)、[摘要](pilot-6-vs-5-summary.json) | 交付运行 5 vs 运行 6 | `abb4c29e7` 只给分享确认层写出与默认值相同的 `cancelText`：**计算样式 0 处不同**；截图 219 相同、10 抗锯齿级、11 超出（WebKit 暗色手机点阵 ×10、Chromium 暗色桌面关闭图标，均为下文噪声）；14 条 trace 的瞬时焦点/弹层不同，请求全部相同 |
| [pilot-5-vs-4](checks/pilot-5-vs-4.txt) → [pilot-5-vs-4](pilot-5-vs-4.json)、[摘要](pilot-5-vs-4-summary.json) | 交付 `bd4f2ca0d`（运行 4）vs `5311a0cf7`（运行 5） | 对话框行高改为限定后，试点**计算样式 0 处不同**；截图 192 相同、37 抗锯齿级、11 超出（同上两类噪声）；14 条 trace 的瞬时焦点/弹层不同，请求全部相同 |
| [reference-noise](checks/reference-noise.txt) → [reference-noise-compare](reference-noise-compare.json)、[摘要](reference-noise-summary.json) | AntD 参照第 1 次 vs 第 4 次 | 同一棵 AntD 树两次运行：180 相同、40 抗锯齿级、20 超出 |

对照方法自身的噪声：同一棵 AntD 树先后两次运行，就有 40 张截图在 ≤2 级、20 张在 3–7 级不同（WebKit 手机的依赖图背景点阵与滚动后的同一区域，暗色 ≤7 级、明色 3 级各 10 张）；trace 中点击后瞬间的焦点与仍在退场动画中的列表也会变化。最终对照中 30 张超出抗锯齿级的截图里，**20 张正是这组参照自身噪声**（同样的截图、环境、像素数与级数；运行 5 中这组只出现了明色的 10 张），其余 10 张：

| 截图 | 环境 | 差异 | 原因 |
| --- | --- | --- | --- |
| pilot-share-loading | Chromium 明/暗 × 桌面/手机 | 一个加载点，最大 18–20 级，31–36 像素 | P1.2 Spinner 静止帧中旋转 45° 的右侧圆点抗锯齿（圆点中心差 2 级）；几何、颜色与 AntD 相同 |
| pilot-share-expiry-open ×2、pilot-share-access-menu | Chromium 明 | 最大 3 级（10–20 像素超过 2） | 对话框阴影/遮罩区的大面积抗锯齿，与 138 张同类，只是到 3 级 |
| pilot-run-hint | Chromium 明桌面 | 最大 4 级，6 像素 | 提示箭头斜边：旧箭头 1085.219px、新箭头 1085.211px（Floating UI 以整像素 clientWidth 求中心） |
| pilot-delete-confirm | Chromium 明/暗桌面 | 5 像素，20 / 15 级 | 面板关闭图标的重绘抗锯齿：6 次交付运行中明色为 3/2/20/20/20/20 级、暗色为 15/1/15/15/1/15 级；交付自身的相邻运行之间暗色也差 15 级 |

发现并修正的过程（每次修正后只重跑受影响的一侧，参照树与用例不变时参照运行继续有效）：

| 运行 | 提交 | 结果 | 处理 |
| --- | --- | --- | --- |
| [pilot](checks/pilot.txt) → [pilot-compare](pilot-compare.json) | `131a8803f` | 80 相同 / 131 / 29 超出 | 箭头位置已一致，但小数 `translate` 使边缘抗锯齿（手机提示箭头 76–98 级）→ `5180e3319` 改用布局偏移 |
| [pilot-2](checks/pilot-2.txt) → [pilot-compare-2](pilot-compare-2.json) | `5180e3319` | 84 / 148 / 8 | 箭头相同或≤2 |
| [p0-vs-tip](checks/p0-vs-tip.txt) → [p0-task-compare](p0-task-compare.json) | `5180e3319` | More 菜单文字差 | 末端对齐列表左缘差 0.17px → `3bfe489a4` |
| [pilot-3](checks/pilot-3.txt) → [pilot-compare-3](pilot-compare-3.json) | `3bfe489a4` | 80 / 150 / 10 | — |
| regressions（[已中止的记录](checks/superseded-3bfe489a4)） | `3bfe489a4` | P2.2 动效矩阵：翻转到上方的手机附件菜单 x=−95 | → `bd4f2ca0d`；中止的运行改在最终提交上重跑 |
| [ref-pilot-4](checks/ref-pilot-4.txt)、[pilot-4](checks/pilot-4.txt) → [pilot-compare-4](pilot-compare-4.json)、[摘要](pilot-summary-4.json) | `bd4f2ca0d`（含 `9edbaef26` 中文输入步骤） | 70 / 140 / 30（其中 20 张为参照噪声） | — |
| [ref-reviews](checks/ref-reviews.txt)、[reviews](checks/reviews.txt) → [reviews-compare-2](checks/reviews-compare-2.txt)（[输出](reviews-compare.json)；[reviews-compare](checks/reviews-compare.txt) 因工具读内嵌 PNG 出错中止） | `076e4ad0c` | 审阅对话框：桌面 4 项相同，手机上的计划与问题对话框几何与截图不同（操作按钮高 44→42.42px，长计划正文滚动高度 7214→7891px） | 共享 Dialog 外壳的无单位行高改变了基于它设计的生产对话框 → `5311a0cf7` 外壳恢复 22px，只给试点的两个对话框 |
| [pilot-5](checks/pilot-5.txt) 等，[orbitkit](checks/orbitkit.txt) → [orbitkit-compare](orbitkit-compare.json) | `5311a0cf7` | 试点、P0、组件矩阵、审阅对话框、单测与耗时见各节；OrbitKit 3 个文案对照用例失败 | 用例按 AntD 属性名查找文案（`okText`、`type="primary"`）且分享确认层不再写出 `cancelText` → `abb4c29e7` |
| [pilot-6](checks/pilot-6.txt) 等 | `abb4c29e7` | 见上表 | 最终 |

### 操作语义（逐步 trace）

7 个场景 × 8 环境共 56 条 trace、每条 3–15 步。评论场景包含中文输入：按 P3.1 的方法（Chromium 用 DevTools `Input.imeSetComposition` 真实组合，WebKit 无输入法自动化，用 insertText 加 composition 事件与 keyCode 229 的确认 Enter 重放）在真实任务面板评论框组合“中文”，确认用的 Enter 不换行、不发送，随后 @ 提及菜单再接管 Enter，Ctrl+Enter 发出的评论请求体两树相同。**所有步骤发出的非 GET 请求（方法、路径、请求体）两树逐步相同**：字段编辑、Suggested/Model/Provider/List/Assignee 选择与清除、添加依赖、自动运行开关、上传两文件/删除、失败上传后重试、评论 @提及、删除确认取消、Reopen 被拒后返回、分享开启/范围勾选/有效期/关闭链接、账号选择。16 条 trace 完全相同，其余差异全部是焦点或弹层停留，逐类说明：

| 步骤 | 旧组件 | Orbit | 说明 |
| --- | --- | --- | --- |
| 打开分享 / Reopen 对话框 | 焦点在 Close 按钮 | 焦点在对话框本身 | P2.1 Dialog 约定（打开时聚焦容器） |
| 第二次打开 Reopen | 焦点仍在页面上的 Reopen task 按钮（模态框外） | 对话框（个别运行快照时尚未移入，见表后） | 旧组件第二次打开未移入焦点 |
| 删除 / 关闭链接询问打开 | 焦点留在触发按钮（或 body），确认层不是 dialog | 焦点进入确认层（role=dialog，名称为问题） | 键盘可直接回答；P2.1/P2.2 确认层约定 |
| 取消询问 | body | 回到触发按钮（Delete task / Access） | `returnFocus` |
| 确认关闭链接后 | 焦点留在已隐藏的 Turn off 按钮（再按 Enter 会重复提交） | body | 两者都在点击后立即关闭询问、请求期间禁用 Access；Orbit 归还焦点时目标被禁用 |
| 移除附件后 | 已隐藏的 Remove 按钮 | 余下文件的 Remove input 按钮 | 同上原因，Orbit 落在可见控件 |
| 分享对话框 Esc | 对话框与其后的任务面板一起关闭（P0.2 FOCUS-1） | 只关闭对话框，焦点回到 More actions | P0.2 已知缺陷 FOCUS-1/FOCUS-2 修正，预期失败标记已撤销 |
| 打开 Suggested / 账号选择 | 焦点留在输入框 | 焦点进入列表的选中项 | Base UI Select 约定（P2 已验收，键位见 P2 Select 快键任务） |
| 打开账号选择 | 虚拟列表的行没有 role=option（trace 列表为空） | 3 个 option | 旧组件可访问性缺口 |
| 勾选范围 / 关自动运行 / 切换依赖视图 | 焦点丢到 body 或无名称的隐藏 input | 焦点留在被点的复选框/开关/名为 List 的单选 | Orbit 控件本身可聚焦 |
| 鼠标选中列表项后 | body 或输入框，随引擎与时序变化 | 输入框/触发器或 body，随引擎变化 | 两树都不固定，非语义 |
| 选中后的瞬间 | 列表仍列出（0.2s 退场动画，旧组件在减少动态效果时仍有动画） | 已移除 | P1.2/P2.1 的减少动态效果约定 |

交付自身的相邻运行（[5 vs 4](pilot-5-vs-4-summary.json)、[6 vs 5](pilot-6-vs-5-summary.json)）之间也各有 14 条 trace 在个别步骤不同：删除附件的请求在途时确认层是否仍在（请求完成后关闭）、关闭链接后焦点在 body 还是 Access、Reopen 对话框是否已移入焦点、鼠标选中列表项后的焦点。这些是快照时刻的瞬时状态，两次运行的请求逐步相同。

## P0 页面矩阵（同提交对照）

按 P3.1 的方法：tip 参照树用 [p32-reference.config.mjs](p32-reference.config.mjs) 把 P0 矩阵的截图写入临时目录（[ref-p0](checks/ref-p0.txt)：100 通过、11 跳过、1 失败——WebKit 暗色桌面设置页的已知偶发，开关后 “Setting saved” 同时匹配两条通知；[ref-p0-settings](checks/ref-p0-settings.txt) 重跑通过并补写该截图），交付树以 0 像素容差比较。P0.2 不可变基线没有覆盖或改写。

交付最终提交 `abb4c29e7` 的严格比较 [p0-vs-tip-6](checks/p0-vs-tip-6.txt)：**93 通过、11 跳过（性能与断点用例按环境跳过，与 tip 相同）、8 失败，全部是本批切换的 task 场景**（8 环境各一）；`5311a0cf7` 上的 [p0-vs-tip-5](checks/p0-vs-tip-5.txt) 结果相同。projects、wiki、公开分享页、settings、profile、session、受控加载/错误、断点、P2.3 生产通知以及 FOCUS-1/FOCUS-2（现在直接通过）**全部与 tip 逐像素相同**——公共组件改动没有影响其它页面（除 Dialog 外，这些组件此前不在生产代码中，见“包体积”中的模块清单；Dialog 的生产用户审阅对话框另行对照，见“回归矩阵”）。上一轮 [p0-vs-tip-4](checks/p0-vs-tip-4.txt)（`bd4f2ca0d`）另有 WebKit 明色手机 profile 场景失败一次：与 settings 相同的已知偶发（保存后通知文字在一瞬间同时匹配通知与读屏 live region，strict 模式报两个元素），单独重跑通过（[p0-profile-4](checks/p0-profile-4.txt)）。

严格比较在第一张不同截图处停止，因此 task 场景另行完整截图并按试点方法分类（[p0-task-shots-6](checks/p0-task-shots-6.txt) → [p0-task-compare-6](p0-task-compare-6.json)、[摘要](p0-task-summary-6.json)；记录名为 p0-task-compare-7，因第一次分类在工具修正前中止，记录编号比运行编号大 1；运行 5 的分类见 [p0-task-summary-5](p0-task-summary-5.json)）：

| 截图 | 8 环境 | 说明 |
| --- | --- | --- |
| task-detail、task-action-hover、task-action-focus | 各 6 相同 + 2 抗锯齿级（运行 5 为 3–4 相同，task-action-focus 另有 1 个像素到 3 级） | 面板、头部按钮、Assignee 字段、悬停与键盘聚焦 More |
| task-action-menu | 8 张均不同 | More 按钮的焦点环：旧菜单打开后焦点留在触发按钮，Orbit Menu 把焦点移入菜单（P2.2 约定）；WebKit 另有 “Share…” 地球图标底行约 30 像素（见“未消除的差异”第 5 条）。菜单本身的位置、尺寸与文字与旧组件一致 |
| task-share-dialog | 8 张均不同 | 打开后按一次 Tab 的焦点位置：旧对话框先聚焦 Close、Tab 到 Access；Orbit 先聚焦对话框、Tab 到 Close。试点用例 “P0 share dialog, focused alike” 让两树聚焦同一元素后截图，8 环境均在抗锯齿级以内 |

摘要中的 task-public-share 只在参照一侧：它属于公开分享页场景（复制参照截图时按 `task-*` 前缀一并带入），该场景在严格比较中逐像素相同。计算样式差异除行高数值精度外有两类结构性差异，截图不受影响：P0 选择器 `.tdp-assignee-select` 命中的根元素（旧选择器根为 14px，13px 写在内部 content 上；Orbit 的 13px 写在根上，可见文字两树都是 13px）；`dialog` 选择器命中的旧 `.ant-modal` 是透明外层（可见表面是内部 `.ant-modal-container`），Orbit 的 `.orbit-overlay` 本身就是表面，因此背景、圆角、阴影出现在被测元素上。

中间提交上的同类运行（[p0-vs-tip](checks/p0-vs-tip.txt)、[p0-vs-tip-3](checks/p0-vs-tip-3.txt) 与对应分类）分别发现并验证了 More 菜单文字 0.17px 的修正；第一次分类因工具把失败用例的二进制 trace.zip 当 JSON 读而中止（[p0-task-compare](checks/p0-task-compare.txt)），修正后重跑。settings 的偶发在 tip 参照（[ref-p0](checks/ref-p0.txt)，补写见 [ref-p0-settings](checks/ref-p0-settings.txt)）与交付（[p0-settings](checks/p0-settings.txt) → [p0-settings-2](checks/p0-settings-2.txt) 通过）都出现过。

## 回归矩阵与单测

P1–P3.1 的组件矩阵在 `5311a0cf7` 上完整重跑（经 [port.config.mjs](port.config.mjs) 换端口，同机另一个工作树占用了固定端口；配置其余部分不变）。最终的 `abb4c29e7` 只改了 ShareModal.tsx 的一个属性和两个 Swift 测试，没有 fixture 渲染 ShareModal，这些矩阵加载的源码与 `5311a0cf7` 相同：

| 矩阵 | 记录 | 结果 |
| --- | --- | --- |
| foundation（P1.1） | [foundation-regression-2](checks/foundation-regression-2.txt) | 48/48 |
| controls（P1.2/P3.1） | [controls-regression-2](checks/controls-regression-2.txt) | 32/32 |
| overlays（P2.1） | [overlays-regression-2](checks/overlays-regression-2.txt) | 96/96 |
| choices（P2.2/P2 Select 快键） | [choices-regression-2](checks/choices-regression-2.txt)、[choices-regression-3](checks/choices-regression-3.txt) | 519/520、518/520：失败全是同一用例的同一键盘步骤，tip 上同样发生，见下 |
| composer（P3.1） | [composer-regression-2](checks/composer-regression-2.txt) | 121 通过、23 按环境跳过（与首轮相同） |
| toasts（P2.3） | [toasts-regression-2](checks/toasts-regression-2.txt) | 272/272 |
| 审阅对话框（reviews.check，生产中用 Orbit Dialog） | [ref-reviews](checks/ref-reviews.txt)、[reviews-3](checks/reviews-3.txt) → [reviews-compare-3](checks/reviews-compare-3.txt)、[输出](reviews-compare-3.json) | 两树各 6 通过（6 按环境跳过）；12 个附件（几何 JSON 与截图）**与 tip 全部相同** |
| OrbitKit（Swift；其文案对照与连线测试按文本读取 ShareModal、TaskDetailPanel、TaskInputs 等 web 源码） | [orbitkit-tip](checks/orbitkit-tip.txt)；[orbitkit](checks/orbitkit.txt) → [orbitkit-compare](checks/orbitkit-compare.txt)；[orbitkit-2](checks/orbitkit-2.txt) → [orbitkit-compare-2](checks/orbitkit-compare-2.txt)、[输出](orbitkit-compare-2.json) | tip 3110 项（5 跳过）0 失败；`5311a0cf7` 3 个用例失败（见下）；**`abb4c29e7` 3110 项（5 跳过）0 失败，与 tip 相同** |

两轮的失败都是 “multiple choices in Dialog keep their owner and menus do not activate a clickable row” 的键盘步骤（第 2 轮 Chromium 明色手机，第 3 轮 Chromium 暗色手机与 WebKit 明色手机）：聚焦 Row actions 按钮后 ArrowDown 与 Enter 相隔 8ms 发出，Enter 落在菜单项获得高亮之前（Row actions 计数停在 1）。这是 [P2 修复：Select 快速连按 ↓↓⏎](../p2-select-keys/README.md) 在“范围外发现：Menu 有同样的窗口”中记录的 Base UI Menu 打开窗口：菜单打开后焦点要到下一帧才进入菜单，窗口内的键落在触发按钮上（该任务的 burst 探针修复前后均 20/20 未选中），由 [P2 跟进：Menu 与 Select 打开窗口内的其余按键，与 AntD 对照](orbit-task:34b7qz5n4yA7s4fJmHNDn) 跟踪，本批没有改动它。为确认它与本批无关，在 Chromium 明色手机把该用例单独重复 40 次：tip [ref-multi-dialog-repeat](checks/ref-multi-dialog-repeat.txt) 失败 6 次、交付 [multi-dialog-repeat](checks/multi-dialog-repeat.txt) 失败 9 次，全部停在同一步，两者差异不显著（Fisher 精确检验 p≈0.57）；同一用例在 `bd4f2ca0d` 的首轮矩阵中 8 环境全部通过，Menu 自那以后未改。试点的 More 与 Access 菜单同样使用 Orbit Menu，因此也带着这个窗口（按键间隔短于一帧时）。choices-regression-2 开始时，并行的 P0 分类组临时复制的 `p32-reference.config.mjs` 尚未删除，记录如实列为未提交路径；它是 P0 矩阵的配置文件，不被 choices 配置匹配（choices-regression-3 的未提交路径为空）。

首轮矩阵（`bd4f2ca0d`，审阅对话框在 `076e4ad0c`）的记录保留为过程：overlays 95/96 与 choices 518/520 中，各有 1 个 fixture 因主机网络切换未挂载（trace 中 `net::ERR_NETWORK_CHANGED`，单独重跑 [overlays-rerun-1](checks/overlays-rerun-1.txt)、[choices-rerun-1](checks/choices-rerun-1.txt) 通过），choices 另有 1 个 WebKit 动效采样等待入场动画超时（[choices-rerun-2](checks/choices-rerun-2.txt) 通过）。为判断后者是否与本批相关，[ref-motion-repeat](checks/ref-motion-repeat.txt)、[motion-repeat](checks/motion-repeat.txt) 把同组 WebKit 动效采样在两树各重复 8 次：tip 96/96、交付 96/96，未再出现。首轮中还有一批记录在主机根分区被写满（其它会话的临时文件）时以 ENOSPC 中断，移到 [checks/superseded-disk-full](checks/superseded-disk-full)，删除本批自己的临时输出后以同名重跑。

两处 fixture 依赖了本批清理掉的业务覆盖：P2.2 choices fixture 的 AntD 访问权限菜单样例借用 index.css 的 `.share-access-menu .ant-dropdown-menu-item-icon { margin-top: 3px }`，P3.1 composer fixture 的 AntD 评论框样例借用 `.tdp-compose .ant-input { flex: 1 }`。真实页面已不再渲染 AntD，这两条只为 fixture 中的 AntD 参照样例存在，因此移到各自 fixture 的样式里（`6e3e4f464`、`076e4ad0c`），对照语义不变。第一次 composer 运行（[已中止](checks/superseded-bd4f2ca0d)）因此 11 项不同，修正后重跑。P2.2 动效矩阵在更早的 `3bfe489a4` 上发现了真实回归（翻转到上方的手机附件菜单 x=−95），由 `bd4f2ca0d` 修正。

OrbitKit 由 [orbitkit-run.sh](orbitkit-run.sh) 在 swift:6.1 镜像中对 `git archive` 出的两棵树各跑一次（client.yml 在 Linux 上的同一步），[orbitkit-compare.py](orbitkit-compare.py) 比较两边失败的用例。`5311a0cf7` 上失败的 3 个用例（SharePanelCopyParityTests 的关闭链接与 Done 两项、TaskDetailCopyParityTests 的附件文案）都是在 web 源码里按 AntD 属性名找同一个词：`okText="Turn off"`、`okText="Remove"`、`<Button type="primary" onClick={onClose}>`，另有分享确认层改用组件默认值后源码里不再出现 `cancelText="Cancel"`。词没有变，`abb4c29e7` 把三个锚点改为 Orbit 属性名（`confirmText`、`variant="primary"`），并让分享确认层像迁移前和任务面板的 Delete 一样写出 `cancelText="Cancel"`。第一次比较输出的 `summary` 字段误取了最后一个测试组的行（工具已修正），失败用例列表无误。

单测与构建：[merge-check-2](checks/merge-check-2.txt)（`abb4c29e7`）与 [merge-check](checks/merge-check.txt)（`5311a0cf7`）中 `npm run build`（shared 与 web，含 `tsc -b`）通过，`npm run test -w @orbit/web` 323 个测试文件、4066 项全部通过。

## 包体积与同场景耗时

**包体积**（[bundle-size-2](checks/bundle-size-2.txt)，P3.1 的 `bundle-size.py`：`dist/index.html` 引用的 JS/CSS，raw 与 gzip -9；两树同一构建配置；`5311a0cf7` 的 [bundle-size](checks/bundle-size.txt) 只少 20 字节）：

| | tip `da13423d3` | 交付 `abb4c29e7` | 差 |
| --- | --- | --- | --- |
| 初始 JS raw / gzip | 3,313,296 / 1,008,022 | 3,481,670 / 1,064,257 | **+168,374（+5.1%）/ +56,235（+5.6%）** |
| 初始 CSS raw / gzip | 392,654 / 65,210 | 428,187 / 70,718 | **+35,533（+9.0%）/ +5,508（+8.4%）** |

来源拆分（[bundle-composition-2](checks/bundle-composition-2.txt) → [bundle-composition-2.json](bundle-composition-2.json)，`5311a0cf7` 见 [bundle-composition](checks/bundle-composition.txt)：两树另以 `vite build --sourcemap` 构建到独立目录，经 source map 把初始 JS 的每个字节归到来源包；总数比上表多出各 JS 文件末尾的 `sourceMappingURL` 注释，每树共 208 字节）：

| 来源 | tip | 交付 | 差 |
| --- | --- | --- | --- |
| `@base-ui/react` | 42,126 | 205,358 | +163,232 |
| `@floating-ui/*`（dom/core/react-dom/utils） | 1,023 | 19,818 | +18,795 |
| `@base-ui/utils` | 12,010 | 13,277 | +1,267 |
| `src/components/ui`（Orbit 组件） | 2,550 | 25,139 | +22,589 |
| `antd` | 531,212 | 501,250 | −29,962 |
| `@rc-component/upload`、`@rc-component/progress`（Upload） | 11,437 | 0 | −11,437 |
| 其余（业务代码 +2,644、未映射 +1,239、其它包合计 +7） | — | — | +3,890 |

tip 的初始 JS 里 Orbit 组件只有 Dialog（审阅对话框）与通知门户；试点让 Button、Select/Combobox、Menu、Popconfirm、Tooltip、Checkbox/Switch、Textarea、Segmented、Alert、Avatar、Spinner 第一次进入生产代码，Base UI 与 Floating UI 随之进入初始包，CSS 也随这些模块带入各自的样式表（Vite 此处不产出 CSS source map，CSS 只有总数）。同时 AntD 只减少 3 万字节（Upload 连同 rc-upload/rc-progress 整体离开），因为 Select、Modal、Dropdown 等仍被其它页面使用。**共存期间包体积上升是本批的实测成本**；AntD 组件要等最后一个使用点迁走后才会离开包。

**同场景耗时**（P0.2 performance 方法，[pilot-performance.browser.mjs](../../../../src/web/ui-migration/pilot-performance.browser.mjs)，chromium-light-desktop；任务页加载 5 次、每个操作 10 次，取中位数，单位 ms）。本批的其它运行都结束后，在同一台 24 核共享主机上（其它会话的负载约 5.5–6）先后测两种动态效果设置：减少动态效果（与对照运行相同）[ref-performance-2](checks/ref-performance-2.txt)、[performance-2](checks/performance-2.txt) → [perf-compare-2.json](perf-compare-2.json)；默认动态效果（[motion.config.mjs](motion.config.mjs)）[ref-performance-motion-2](checks/ref-performance-motion-2.txt)、[performance-motion-2](checks/performance-motion-2.txt) → [perf-compare-motion-2.json](perf-compare-motion-2.json)。

| 操作 | 减少动态效果：旧 / Orbit | 默认动态效果：旧 / Orbit |
| --- | --- | --- |
| 任务页加载到就绪 | 436.2 / 420.3 | 418.8 / 419.3 |
| Assignee 选择器打开 | 429.0 / 80.6 | 429.6 / 429.7 |
| Assignee 选择器关闭 | 314.8 / 47.0 | 316.7 / 299.6 |
| More 菜单打开 | 438.2 / 97.7 | 447.6 / 464.3 |
| 分享对话框打开 | 455.5 / 97.7 | 464.1 / 447.4 |
| 分享对话框关闭 | 348.5 / 81.6 | 346.0 / 348.3 |
| 评论框输入 | 47.2 / 47.6 | 47.2 / 47.8 |
| 依赖视图切换 | 79.7 / 80.9 | 78.4 / 80.8 |

每个区间包含 Playwright 往返、可操作性检查、弹层透明度到 1 与两帧。减少动态效果时旧组件仍播放 0.2–0.3s 的动画（AntD 不读该设置），Orbit 组件直接出现，所以弹层操作快 270–360ms；默认动态效果下两者播放相同的动画，各操作中位数相差 −17～+17ms（约一帧），加载相差 0.5ms。任务页实际加载的 JS/CSS（Resource Timing 解码后大小）3,909,945 → 4,113,832 字节（+5.2%），与上面的包体积一致。首次测量（[ref-performance](checks/ref-performance.txt)、[performance](checks/performance.txt) → [perf-compare.json](perf-compare.json)，与组件矩阵同时运行，负载约 9–10）结论相同。两轮都在 `5311a0cf7` 上测；`abb4c29e7` 只增加一个与默认值相同的属性，没有重测。

## 未消除的差异

全部为渲染级或已有约定，没有布局、颜色、尺寸或请求差异：

1. **加载点**：分享对话框加载态的 P1.2 Spinner 静止帧（Chromium 4 环境，≤20 级、31–36 像素），圆点几何与颜色与旧组件相同，旋转 45° 的右侧圆点抗锯齿不同。
2. **3 级抗锯齿**：三张分享对话框截图（有效期列表 ×2、访问权限菜单）的阴影/遮罩区少量像素到 3 级（运行 5 的 P0 task-action-focus 另有 1 个像素到 3 级，运行 6 没有）。
3. **提示箭头斜边**：Chromium 明色桌面 6 像素 ≤4 级（位置差 0.008px，Floating UI 以整像素 clientWidth 求中心）。
4. **关闭图标重绘**：Chromium 桌面删除确认截图中面板关闭图标的 5 个像素，6 次交付运行中明色为 3/2/20/20/20/20 级、暗色为 15/1/15/15/1/15 级，交付自身的相邻运行之间也差 15 级——同一份代码随重绘历史变化（P3.1 记录过同类现象）。
5. **行高数值精度**：Vite 的 CSS 压缩器（Lightning CSS，32 位浮点）把 `1.5714285714285714` 写成 `1.57143`，AntD 运行时注入的是完整数值。Chromium 下计算值 18.8572px/18.8571px，WebKit 下 22.000019px/22px 等（试点的计算样式差异全部是这一项；P0 task 场景另有两类被测元素的结构性差异，见上）。Chromium 布局为 1/64px 时两者相同；WebKit 偶尔多出 1/64px 行高，最终只在 P0 打开的 More 菜单里 “Share…” 地球图标底行留下约 30 像素（≤59 级）。改用内联样式或调整全站压缩器都超出本批范围。
6. **焦点约定**：见上方 trace 表与 P0 表（对话框聚焦容器、菜单与确认层把焦点移入弹层、取消后归还触发按钮、Esc 只关闭对话框）。这些是 P2.1/P2.2 已验收的约定或对旧缺陷的修正，不是外观差异。

## 未确立的部分

- 面板内归属 P4.3/P4.4/P5.2 的子组件仍是 AntD（见“范围”），它们的切换与清理不在本批。
- 浏览器为固定版本的 Playwright Chromium/WebKit 与手机模拟，没有真机 iOS Safari/Android、软键盘、输入法与读屏软件听测；可访问性只按角色、名称与 aria 状态核对。
- 截图对照使用 reducedMotion=reduce；新组件 Popconfirm、Segmented 的正常动画沿用 P2 的浮层/0.3s 曲线，没有在本批逐帧对照（默认动态效果下的“同场景耗时”见上文，各操作与旧组件相差约一帧以内）。
- 性能数据来自同一台共享机器（两轮，见“同场景耗时”），用于同场景对照，不作为绝对指标。
- choices 矩阵中 Menu 的打开窗口（见“回归矩阵”）在 tip 与交付上同样偶发，由 P2 跟进任务处理，本批未改；因此 choices 矩阵没有一轮全绿。
- 第 2 轮的边界见下文“第 2 轮：合入 main”的最后一节。

## 第 2 轮：合入 main（落地冲突返工）

第 1 版证据之后，第 1 代落地在 REBASE 阶段停在冲突上（落地作业 `2FEAwsKlxxLvKm1lzz9QGe`）：交付分支 `orbit/p3-2-2b837b`（`b24209077`）与 main（`f33589b4c`）在 `src/web/src/components/AccountSelect.tsx` 冲突，项目分支本身与 main 不冲突。协调者退回本任务（任务评论 `34bQgi1TU4Kqb3RXJFIOy`）：本轮只把最新 main 合入已交付分支、解冲突、复验受影响的部分，其余沿用第 1 版。本轮会话分支 `orbit/p3-2-590579` 从项目 tip `da13423d3` 起。

| 提交 | 内容 |
| --- | --- |
| `b24209077` | 快进到第 1 版交付 |
| `83b908793` | 合入 main `f33589b4c`（父提交 `b24209077`、`f33589b4c`；合入与提交前各核对一次 main）。唯一冲突在 `AccountSelect.tsx` 开头的 import 行：main 的 `712d324a8`（feat(antigravity): keep several Google accounts per runner）引入 `withEnginePlanUsage` 与 `runsOnEnvKey`，本批去掉 antd 的 `Select`、引入 Orbit `Select`。两边都保留：main 的 env key 状态（`env key · runs on your Gemini key`）、经 `withEnginePlanUsage` 读取的额度、剩余额度的 `… % left` 格式与 `ENGINE_COPY` 的 antigravity 一项逐字未动，下拉仍是本批的 Orbit Select。`index.css` 与 `TaskDetailCopyParityTests.swift` 两边都改过，改动行不重叠，自动合并 |
| `7145f084f` | 直接联动（测试）：main 新增的 `RunnerDetailPage.antigravityAccount.test.tsx` 经 antd Select 的内部类（`.ant-select-content`、`.ant-select-item-option`）打开并读取账号列表。在只含合并的 `83b908793` 上，它的 3 个用例有 2 个在断言账号之前就失败（会话作业 `bgj_e57013f9f754`，同一命令中的 Codex 账号测试全部通过）。按本批迁移 `RunnerDetailPage.codexAccount.test.tsx` 的方式改为按角色读取：combobox、listbox 中的 option、每项的名称与状态行，选择时发送完整的指针按压。期望的名称、状态行与保存的 `antigravityAccount` 都没有改。改后 9 个账号相关测试文件 247 项通过（`bgj_73e40e91b955`：两个 RunnerDetailPage 账号测试、WorkspaceView.codexAccount、RunnerEngines 的两个 Antigravity 测试、engineAccounts、planUsage、runnerAttention、sessionProviderChoices） |
| `5ce67d6dd` | 试点对照第 9 个用例 “the Antigravity account picker”：`pilot-fixtures.mjs` 的 `antigravity` 选项只给这个用例的 runner 加两个 Antigravity 账号（其余用例的数据不变）。runner 以 Gemini key 运行 Antigravity：Default 未登录 Google（`env key · runs on your Gemini key`），Work 是已登录的 Google 账号、5 小时桶剩 4%（`gemini-5h 4% left · signed in`）。在新建工作区表单中截取账号字段（收起与展开），选 Work，Create，逐步记录 `POST /api/workspaces` 的请求体 |
| `3c1b24f02` | 对照完成后 main 前进到 `71e644742`（Google 登录 S1–S3），再合一次（父提交 `5ce67d6dd`、`71e644742`），无冲突。它没有改 `src/web`；`src/shared` 只在 `codec.ts` 的 `PUBLIC_ID_FIELDS` 加了 `updatedById`、`linkUserId` 两个字段名，其余 29 个文件在 apiserver |
| `2b17bae4f` | 提交证据前再核对：项目线前进到 `77233e226`（P0 漂移任务），合入（父提交 `3c1b24f02`、`77233e226`），无冲突 |
| `9fa5fc412` | main 前进到 `86203ffb0`，合入（父提交 `2b17bae4f`、`86203ffb0`），无冲突 |
| `6bd41335a` | 最后一次核对时 main 又前进一个提交 `db69d833b`（没有 agy 的机器跳过 agy 合同测试），合入（父提交 `e3ba1c923`、`db69d833b`），无冲突。相对 `9fa5fc412` 只多 `src/runner-go` 下 5 个 Go 测试文件。交付的最终代码；之后的提交只改本目录 |

除冲突解决与上面的测试联动外，本轮没有改动业务代码。

### 合并范围

[merge-scope.py](merge-scope.py) 只读 git，逐项核对合并动了什么（[r2-merge-scope](checks/r2-merge-scope.txt) → [r2-merge-scope.json](r2-merge-scope.json)，main `f33589b4c`；对 `71e644742` 的再次核对见下表 r2b），11 项全部成立：

- 两边都改过的 3 个文件（`AccountSelect.tsx`、`index.css`、`TaskDetailCopyParityTests.swift`）：合并结果恰好是 main 加上本批改动的行，也恰好是本批加上 main 改动的行（双向按行核对）。
- 本批其余 41 个文件（本证据目录除外）与 `b24209077` 逐字节相同，只有本轮有意改动的 `pilot.browser.mjs`、`pilot-fixtures.mjs` 不同；main 其余 418 个文件与 main 相同，只有上面联动的测试不同。
- main 没有改 `components/ui` 与 `ui-migration`。`index.css` 两边改动的选择器没有交集：本批 31 个，全部在 `.tdp-`、`.share-` 下；main 168 个（含 6 个 @media/@container 前导），首个类名都属于 `access-token*`、`app-shell`、`np-list`、`session-press`/`session-project`/`session-row`、`start-card`、`wk-*`，组件 fixture 与 4 个试点源文件都不使用这些类名。
- main 改动的 52 个 web 源文件中，只有 3 个引用本批改过的模块（含经 `components/ui` 内部引用间接到达）：`AccountSelect.tsx` 本身（冲突文件）、`RunnerDetailPage.tsx`（新增的 Antigravity 账号字段，即新试点用例与联动测试覆盖的路径）、`WorkspaceView.tsx`（main 在这里的改动，如 Antigravity 账号的会话路由，只经 `accountsOf` 用到 `AccountSelect`，本批没有改它；`ShareModal` 的引用与用法未变）。

### 复验

| 检查 | 树 / 提交 | 结果 |
| --- | --- | --- |
| [r2-merge-check](checks/r2-merge-check.txt) | `7145f084f` | 项目合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`：构建通过，338 个测试文件、4295 项全部通过（含 main 新增与改动的 AccountSelect、engineAccounts、planUsage 相关单测） |
| [r2-ref-build](checks/r2-ref-build.txt)、[r2-ref-pilot](checks/r2-ref-pilot.txt) | main `f33589b4c`（AntD 参照） | 72/72（9 用例 × 8 环境） |
| [r2-build](checks/r2-build.txt)、[r2-pilot](checks/r2-pilot.txt) → [r2-pilot-compare](r2-pilot-compare.json)、[摘要](r2-pilot-summary.json) | `5ce67d6dd` | 72/72；256 张截图 **90 逐字节相同、156 仅抗锯齿级、10 超出（9 张是第 1 版已列的渲染级差异，1 张是参照自身噪声）**；64 条 trace **请求逐步全部相同**；128 项计算样式差异全部是行高数值精度 |
| [r2-ref-pilot-again](checks/r2-ref-pilot-again.txt) → [r2-reference-noise](r2-reference-noise-compare.json)、[摘要](r2-reference-noise-summary.json) | main 参照第 2 次 | 同一棵 AntD 树两次运行：217 相同、37 抗锯齿级、2 超出（Reopen 被拒截图，Chromium 明/暗手机）；计算样式 0 处不同 |
| [r2b-merge-check](checks/r2b-merge-check.txt) | `3c1b24f02`（再次合入 main `71e644742`） | 项目合并检查：构建通过，338 个测试文件、4295 项全部通过 |
| [r2b-merge-scope](checks/r2b-merge-scope.txt) → [r2b-merge-scope.json](r2b-merge-scope.json) | `3c1b24f02` 对 main `71e644742` | 11 项全部成立（main 其余 439 个文件与 main 相同，只有联动的测试不同） |
| [r2b-dist-compare](checks/r2b-dist-compare.txt)；[r2b-ref-build](checks/r2b-ref-build.txt) → [r2b-ref-dist-compare](checks/r2b-ref-dist-compare.txt) | `3c1b24f02` / main `71e644742` | 两树重新构建的 `dist/` 与试点对照时服务的构建逐字节相同（`diff -r` 无输出） |
| [r2-orbitkit-main](checks/r2-orbitkit-main.txt)、[r2-orbitkit](checks/r2-orbitkit.txt) → [r2-orbitkit-compare](checks/r2-orbitkit-compare.txt)、[输出](r2-orbitkit-compare.json) | main `71e644742` / `3c1b24f02`（git archive） | 两树各 3218 项（5 跳过），失败的是同样 3 个用例、4 处断言，都是 main 自己的：ConfirmationStyleWiringTests 1 项（2 处）、WikiCopyParityTests 首页分区 2 项；交付没有多出失败。读取试点源码的 SharePanelCopyParityTests（13）、TaskDetailCopyParityTests（13，含 main 新增的移动请求断言与本批改过的锚点）、TaskDetailWiringTests（12）两树都通过 |
| [r2b-foundation-regression](checks/r2b-foundation-regression.txt)、[r2b-controls-regression](checks/r2b-controls-regression.txt)、[r2b-overlays-regression](checks/r2b-overlays-regression.txt)、[r2b-choices-regression](checks/r2b-choices-regression.txt) | `3c1b24f02` | 48/48、32/32、96/96、520/520（Menu 打开窗口的偶发这次没有出现） |
| [r2b-composer-regression](checks/r2b-composer-regression.txt)、[r2b-toasts-regression](checks/r2b-toasts-regression.txt) | `3c1b24f02` | composer 120 通过、23 按环境跳过、1 失败；toasts 268/272。5 个失败都是动效或进度采样（见下） |
| `suite-repeat` 5 组：[composer](checks/r2b-composer-motion-repeat.txt)（[main](checks/ref-r2b-composer-motion-repeat.txt)）、toasts [drawer-entry](checks/r2b-toasts-drawer-entry-repeat.txt)（[main](checks/ref-r2b-toasts-drawer-entry-repeat.txt)）、[exit-progress](checks/r2b-toasts-exit-progress-repeat.txt)（[main](checks/ref-r2b-toasts-exit-progress-repeat.txt)）、[entrance-progress](checks/r2b-toasts-entrance-progress-repeat.txt)（[main](checks/ref-r2b-toasts-entrance-progress-repeat.txt)）、[drawer-pixels](checks/r2b-toasts-drawer-pixels-repeat.txt)（[main](checks/ref-r2b-toasts-drawer-pixels-repeat.txt)） | main `71e644742` / `3c1b24f02` | 5 个失败用例各在原环境重复 5 次（exit-progress 的模式匹配 2 个用例，共 10 次）：main 26/30、交付 29/30（main 失败 drawer-entry 1、exit-progress 1、entrance-progress 2；交付失败 entrance-progress 1） |
| [r2b-ref-reviews](checks/r2b-ref-reviews.txt)、[r2b-reviews](checks/r2b-reviews.txt) → [r2b-reviews-compare](checks/r2b-reviews-compare.txt)、[输出](r2b-reviews-compare.json) | main `71e644742` / `3c1b24f02` | 两树各 6 通过（6 按环境跳过）；12 个附件（几何 JSON 与截图）**全部相同** |
| [r2b-ref-p0](checks/r2b-ref-p0.txt)、[r2b-p0-vs-main](checks/r2b-p0-vs-main.txt) | main `71e644742`（写参照截图）/ `3c1b24f02`（0 像素比较） | main 88 通过、13 失败、11 跳过；交付 80 通过、21 失败、11 跳过。逐项见下文“P0 页面矩阵” |
| [r2b-p0-task-shots](checks/r2b-p0-task-shots.txt) → [r2b-p0-task-compare](r2b-p0-task-compare.json)、[摘要](r2b-p0-task-summary.json) | `3c1b24f02` | task 场景完整截图后分类：与第 1 版运行 6 相同（见下） |
| `merged-p0-rerun` 5 组：settings webkit-light-desktop（[main](checks/r2b-ref-p0-settings-webkit-light-desktop.txt)、[交付](checks/r2b-p0-settings-webkit-light-desktop.txt)）、settings webkit-dark-desktop（[main](checks/r2b-ref-p0-settings-webkit-dark-desktop.txt)、[交付](checks/r2b-p0-settings-webkit-dark-desktop.txt)）、settings webkit-dark-phone（[main](checks/r2b-ref-p0-settings-webkit-dark-phone.txt)、[交付](checks/r2b-p0-settings-webkit-dark-phone.txt)）、profile chromium-light-desktop（[main](checks/r2b-ref-p0-profile-chromium-light-desktop.txt)、[交付](checks/r2b-p0-profile-chromium-light-desktop.txt)）、profile webkit-dark-desktop（[main](checks/r2b-ref-p0-profile-webkit-dark-desktop.txt)、[交付](checks/r2b-p0-profile-webkit-dark-desktop.txt)） | main `71e644742` / `3c1b24f02` | 10 条全部碰上同一不稳定（strict 模式报通知与读屏副本两个元素，或参照因此没写出的截图），见下 |

**参照为何重新生成。** main 改了 AccountSelect 的状态文案（env key、`… % left`）与 RunnerDetailPage（第三个账号字段），第 1 版的参照（tip `da13423d3`）与交付已不是同一份业务代码。项目 tip 是 main 的祖先，所以“合并后的基点（不含本批）”就是 main 本身。参照树 `/var/tmp/p32r2-ref` 检出 `f33589b4c`，同样只复制本批的 `pilot*.mjs`，两树各自构建、同一端口先后运行（方法同“对照方法”）。参照中账号与模型选择路径用的是旧 AntD Select，交付中是 Orbit Select。

**账号与模型选择。** 字段与选择器用例（Assignee、Suggested、Provider、Model、List 的打开、搜索、选中、重选、清除）、Claude 账号用例与新增的 Antigravity 账号用例，共 12 种截图 × 8 环境全部逐字节相同或仅抗锯齿级：

| 截图 | 相同 / 抗锯齿级 | 截图 | 相同 / 抗锯齿级 |
| --- | --- | --- | --- |
| pilot-detail | 4 / 4 | pilot-model-open | 2 / 6 |
| pilot-field-hover | 3 / 5 | pilot-list-open、pilot-list-search | 各 2 / 6 |
| pilot-assignee-open | 2 / 6 | pilot-account、pilot-account-open | 6 / 2、5 / 3 |
| pilot-suggested-open | 3 / 5 | pilot-antigravity-account | 6 / 2 |
| pilot-provider-open | 2 / 6 | pilot-antigravity-account-open | 4 / 4 |

这三个用例的 trace 在 8 个环境中请求逐步相同（Suggested/Model 选择与 List 选择、重选、清除的 PATCH 请求体两树相同，重选当前值两树都不发请求），差异只在焦点与列表停留，类别与第 1 版 trace 表相同：打开列表时 Orbit 把焦点移入选中项、旧组件留在输入框；旧账号列表是虚拟列表，可见行没有 option 角色（trace 中列表为空）；选中后的瞬间旧列表仍在退场动画中。Antigravity 用例里，Default 与 Work 两行的名称和状态行在两树中呈现相同（Chromium 明色桌面的展开截图与参照最大差 2 级，WebKit 暗色手机逐字节相同）；Create 一步在 8 个环境中两树相同，请求体为 `{"name":"Antigravity pilot","enableWorktree":false,"modelRouting":false,"modelRoutingProviders":[],"env":{},"codexAccount":null,"claudeAccount":null,"antigravityAccount":"work","runnerId":…}`。计算样式差异只有行高数值精度（“未消除的差异”第 5 条）。

**超出抗锯齿级的 10 张。** 9 张与第 1 版运行 6 的同名截图在同一环境、同样数量的像素超过 2 级、同样的最大级数：分享加载点 ×4、3 级阴影 ×3（有效期列表 ×2、访问权限菜单）、提示箭头、关闭图标（“未消除的差异”第 1–4 条）。第 10 张是 pilot-reopen-refused（Chromium 明色手机）：模态遮罩下工作区头像圆左缘 4 个像素、最大 9 级。交付在这里与第 1 版交付逐像素相同，变的是参照：main 上的 AntD 参照两次运行之间就在同样 4 个像素、同样 9 级上不同（r2-reference-noise），属于参照自身的重绘噪声，与第 1 版的关闭图标同类。第 1 版参照噪声中 WebKit 手机依赖图点阵的 20 张这次没有出现。

**main 再次前进后。** 对照完成后 main 前进到 `71e644742`（Google 登录 S1–S3），再次合入为 `3c1b24f02`。项目合并检查与合并范围核对在新合并上重跑；两树按原方式重新构建（参照树检出 `71e644742`），`dist/` 与对照时服务的构建逐字节相同：main 这次唯一触及 web 依赖的 `codec.ts`（`PUBLIC_ID_FIELDS` 的两个字段名）没有进入 web 产物。浏览器加载的文件两侧都没有变，所以上面的试点对照对 `3c1b24f02` 原样成立，没有再跑一次。

**组件矩阵的 5 个失败。** composer 的 “auto-size transitions match AntD; reduced motion drops them…”（Chromium 暗色手机）在失焦恢复高度时多采到一个仍在进行的 300ms 高度过渡；toasts 的 4 个（WebKit 明色手机 ×3、暗色桌面 ×1）是抽屉与对话框转移中的动效与进度采样（动画已经结束、进度计数差一步）。这几轮运行时主机 1 分钟负载在 13–70 之间（24 核；其它会话的 vLLM、Gradle、vitest 与 WebKit 运行），各矩阵耗时是第 1 版的 1.5–2 倍。5 个用例在 main 与交付上按原环境各重复 5 次：main 26/30、交付 29/30，main 失败得不比交付少；第 1 版这两套在交付上全部通过（composer 121、toasts 272）；main 没有改这些 fixture 渲染的组件。判断为负载下的时序采样，与本批及合并无关。

**P0 页面矩阵（r2b，基点 main `71e644742`；最终基点上的结果见下一节）。** 参照树（main `71e644742`）写截图，交付以 0 像素比较：

- 与 main 逐像素相同：projects、session、公开分享页、受控加载与错误重试、P2.3 生产通知各 8/8，断点 4（另 4 个按环境跳过），FOCUS-1/FOCUS-2 16/16（交付上作为普通测试通过；main 上它们仍是预期失败，旧缺陷还在），settings 5/8、profile 6/8。
- task ×8：本批切换的场景。分类与第 1 版运行 6 相同：task-action-menu、task-share-dialog 每个环境超过 2 级的像素数与最大级数都和运行 6 一样（焦点约定与 WebKit 下 “Share…” 一行的行高精度，见上文“P0 页面矩阵”）；task-detail、task-action-hover、task-action-focus 各 5 张逐字节相同、3 张抗锯齿级；task-public-share 只在参照一侧。
- wiki ×8：两树都在等待 `.wk-card` 时超时。main 的 Wiki 首页重构（`2f9cc095f`，drop status cards）去掉了这些卡片，P0 的 wiki 场景在 main 上已不能运行（参照同样 8/8 失败）。这是 main 相对 P0 基线的漂移，不归本批；本轮 Wiki 页因此没有视觉对照（main 与本批在 Wiki 上没有交集，见“合并范围”）。
- settings ×3、profile ×2：正是参照自己失败的 5 个环境，即 P0 已记录的不稳定：保存后的通知文字同时匹配通知与读屏 live region，strict 模式报两个元素。参照在写出后续截图前停止，交付因此缺参照截图，或自己也碰上同一不稳定。单独重跑这 5 个环境（两树各一次，记录见上表）时主机负载在 60–70 之间，10 条全部再次碰上它；之后等负载降到 24 以下再试一次，25 分钟内负载一直在 34–47，没有运行（会话作业 `bgj_445b1723b43d`）。这 5 个环境的 settings/profile 本轮没有完成比较；其余环境中这两个场景与 main 逐像素相同。

### 项目线与 main 再次前进后（最终基点）

提交证据前再次核对：项目线前进到 `77233e226`，即 P0 漂移任务的交付：`ui-migration/expected-screenshots.mjs` 分层的 P0 期望截图，在 Notifications 区域内查找保存通知，并合入了 main 到 `f86211ec3`。main 前进到 `86203ffb0`：登录页 Google 登录、Runner 页的引擎额度行、Wiki 首页与客户端修正。两者与本分支、彼此之间都没有冲突（`git merge-tree`），依次合入为 `2b17bae4f` 与 `9fa5fc412`。此时“合并后的基点（不含本批）”是项目线 tip 与 main 的合并：本地参考提交 `760287474`（父提交 `77233e226`、`86203ffb0`，树为两者 `git merge-tree` 的结果），参照树检出它，只复制试点 spec 与配置。在它上面重做：

| 检查 | 树 / 提交 | 结果 |
| --- | --- | --- |
| [r2c-merge-check](checks/r2c-merge-check.txt) | `e3ba1c923`（源码与 `9fa5fc412` 相同） | 项目合并检查：构建通过，340 个测试文件、4327 项全部通过 |
| [r2c-merge-scope](checks/r2c-merge-scope.txt) → [r2c-merge-scope.json](r2c-merge-scope.json) | `e3ba1c923` 对 `760287474` | 16 项全部成立。两边都改过的文件此时有 5 个（多了 P0 漂移任务也改过的 `page-scenarios.mjs`、`playwright.config.mjs`），合并结果都恰为双方改动之和；基点没有改 `components/ui`，在 `ui-migration` 只改了 P0 矩阵的 `expected-screenshots.mjs`、`page-scenarios.mjs`、`playwright.config.mjs`，没有组件矩阵文件；`index.css` 两边改动的选择器仍无交集，fixture 与试点源文件不使用基点改动选择器的首类名 |
| [r2c-ref-build](checks/r2c-ref-build.txt)、[r2c-ref-pilot](checks/r2c-ref-pilot.txt) | `760287474`（AntD 参照） | 72/72 |
| [r2c-build](checks/r2c-build.txt)、[r2c-pilot](checks/r2c-pilot.txt) → [r2c-pilot-compare](r2c-pilot-compare.json)、[摘要](r2c-pilot-summary.json) | `e3ba1c923` | 72/72；256 张截图 **95 逐字节相同、153 仅抗锯齿级、8 超出，8 张全部是第 1 版运行 6 的同一批**（同环境、同样数量的像素超过 2 级、同样的最大级数：分享加载点 ×4、3 级阴影 ×3、提示箭头）；64 条 trace **请求逐步全部相同**；128 项计算样式差异全部是行高数值精度；账号与模型选择的 12 种截图 8 环境全部逐字节相同或抗锯齿级；Antigravity 用例只在打开与选中两步有焦点与列表差异，Create 的请求两树相同 |
| [r2c-orbitkit-main](checks/r2c-orbitkit-main.txt)、[r2c-orbitkit](checks/r2c-orbitkit.txt) → [r2c-orbitkit-compare](checks/r2c-orbitkit-compare.txt)、[输出](r2c-orbitkit-compare.json) | `760287474` / `e3ba1c923`（git archive） | 两树各 3257 项（5 跳过），0 失败：main 已修好此前的 3 个失败用例 |
| [r2c-ref-p0](checks/r2c-ref-p0.txt)、[r2c-p0-vs-main](checks/r2c-p0-vs-main.txt) | `760287474`（写参照截图）/ `e3ba1c923`（0 像素比较） | 参照 93 通过、8 失败（wiki）、11 跳过；交付 85 通过、16 失败（task ×8、wiki ×8）、11 跳过。projects、session、公开分享页、受控加载与错误重试、P2.3 生产通知、settings、profile 各 8/8 与参照逐像素相同，断点 4（另 4 个按环境跳过），FOCUS-1/FOCUS-2 16/16（交付上作为普通测试通过，参照上仍是预期失败）。项目线修正通知查找后，settings/profile 不再碰上 r2b 中的不稳定。wiki 两树都在等待 `.wk-card` 时超时（main 的漂移，见上） |
| [r2c-p0-task-shots](checks/r2c-p0-task-shots.txt) → [r2c-p0-task-compare](r2c-p0-task-compare.json)、[摘要](r2c-p0-task-summary.json) | `e3ba1c923` | task 场景分类与第 1 版运行 6 完全相同：48 张中 18 逐字节相同、6 抗锯齿级、24 超出。超出的是 task-action-menu ×8、task-share-dialog ×8（每个环境超过 2 级的像素数与最大级数都与运行 6 相同），以及只在参照一侧的 task-public-share ×8 |

最后一次核对时 main 又前进到 `db69d833b`，只改了 Go runner 的 5 个测试文件，合入为 `6bd41335a`。web、shared 与锁文件和 `9fa5fc412` 相同，上面的对照原样适用；项目合并检查在 `6bd41335a` 上又跑了一次（[r2d-merge-check](checks/r2d-merge-check.txt)）：构建通过，340 个测试文件、4327 项全部通过。

组件矩阵与审阅对话框是在 `3c1b24f02`（基点 main `71e644742`）上跑的，没有在最终基点重跑。r2c-merge-scope 显示基点此后没有改 `components/ui` 和任何组件矩阵文件，`index.css` 新增规则的首类名也没有 fixture 使用；审阅对话框 fixture 渲染的 `ApprovalPanel`、`CoordinatorQuestionCard` 在基点中未变。

### 沿用第 1 版的部分及原因

- **迁移成本、包体积与同场景耗时。** 本批的业务与公共组件代码与第 1 版交付逐字节相同（见“合并范围”）；本轮只增加一处测试联动和一个试点用例，都是测试代码。`cost.json`、包体积与耗时的同场景对照（tip `da13423d3` vs `abb4c29e7`）沿用；合并后两树都多了 main 的代码，本批的增量没有在新基点上重测。
- **AntD 清单。** 第 1 版的统计（import antd 的生产文件 99 → 95 等）是本批相对 tip 的变化，沿用；main 新增代码中的 antd 使用不属于本批（本轮只迁移了因合并直接失效的一个测试）。

### 第 2 轮的边界

- 试点对照最终在基点 `760287474`（项目线 tip 与 main 的合并，不含本批）与交付 `e3ba1c923`（源码同 `9fa5fc412`）上完整重跑，最终代码 `6bd41335a` 相对它只多 5 个 Go 测试文件；此前在 `f33589b4c`/`5ce67d6dd` 与（以构建产物逐字节相同延伸到的）`3c1b24f02` 上的结果作为过程保留。`760287474` 是本地参考提交，没有推送。
- P0 的 wiki 场景在 main 上不能运行（main 的 Wiki 首页重构去掉了它等待的 `.wk-card`，两树同样失败），本轮 Wiki 页没有视觉对照。settings/profile 在 r2b 有 5 个环境因已记录的不稳定没有完成比较（两树单独重跑都碰上同一不稳定，等负载下降后的再试没能运行）；最终基点上项目线已修正通知查找，8 个环境全部与参照逐像素相同。
- 项目线的 P0 漂移任务把 P0 期望截图分成 P0.2 原图、main 漂移参考与“已接受的迁移差异”三层（[p0-drift](../p0-drift/README.md)）。本批 task 场景按设计不同的截图（task-action-menu、task-share-dialog 等）要等本证据被协调者 CONFIRM、本批落地后，才能按该任务的规则登记为已接受的迁移差异；本轮没有登记（[accepted/registry.json](../p0-drift/accepted/registry.json) 为空）。在登记之前，项目线上直接运行的 P0 矩阵（不经同提交参照）会在这些 task 截图上失败。
- 组件矩阵与审阅对话框只在 `3c1b24f02`（基点 main `71e644742`）上跑过，没有在最终基点重跑（理由见上）。其中 composer 1 项、toasts 4 项在整轮矩阵中失败，经两树重复判为负载下的时序采样（main 失败更多）；这两套在第 2 轮没有取得一轮全绿。
- 迁移成本、包体积、耗时与 AntD 清单沿用第 1 版，未在新基点重测。
- 联动测试的红色（合并后、联动前）只有会话作业 `bgj_e57013f9f754` 的输出，没有写成本目录的检查记录。
- 第 1 版“未确立的部分”（真机与读屏、正常动画逐帧、共享主机上的耗时、Menu 打开窗口）同样适用于本轮。

## 复跑

依赖准备同 P3.1（仓库根 `npm ci`）。参照树：

```sh
git worktree add /var/tmp/p32-ref da13423d3
cp src/web/ui-migration/pilot*.mjs docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs /var/tmp/p32-ref/src/web/ui-migration/
```

之后按组运行（每步经 run-check.py 记录到 `checks/`，同名记录拒绝覆盖；`REF`、`OUT` 可改；`port.config.mjs`、`motion.config.mjs` 由各组自行复制）：

```sh
R=docs/evidence/base-ui-migration/p3.2
bash $R/final-runs.sh pilot                  # 两树构建 + 试点 8 环境 + 对照
bash $R/final-runs.sh pilot-both N           # 用例改动后两侧重跑（参照第 N 轮）
bash $R/final-runs.sh pilot-delivery N [R]   # 代码改动后只重跑交付一侧，与第 R 轮参照比较
bash $R/final-runs.sh pilot-pair A B         # 交付两次运行互比
bash $R/final-runs.sh p0                     # P0 矩阵：tip 写截图，交付 0 像素比较
bash $R/final-runs.sh p0-delivery N          # 交付一侧重跑并对 task 场景分类
bash $R/final-runs.sh regressions            # P1–P3.1 组件矩阵与审阅对话框（两树）
bash $R/final-runs.sh regressions-again N    # 组件矩阵在后续提交上重跑
bash $R/final-runs.sh reviews-delivery N     # 审阅对话框交付一侧重跑并与 tip 比较
bash $R/final-runs.sh suite-repeat NAME SUITE PATTERN PROJECT COUNT  # 单个用例在两树重复
bash $R/final-runs.sh motion-repeat          # WebKit 动效采样在两树重复
bash $R/final-runs.sh merge                  # 构建 + 全部 Web 单测
bash $R/final-runs.sh measure                # 包体积、AntD 清单、同场景耗时
bash $R/final-runs.sh measure-quiet N        # 同场景耗时：减少动态效果与默认动态效果各一轮
bash $R/final-runs.sh bundle-composition     # 初始 JS 按来源包拆分
python3 $R/verify-claims.py                 # 逐条核对本文结论，任何一条不成立即退出 1
python3 $R/summarize-compare.py $R/pilot-compare-6.json
python3 $R/diff-clusters.py expected.png actual.png out.png   # 单张截图的差异像素聚类与并排放大裁剪
python3 $R/cost.py da13423d3 abb4c29e7
```

第 2 轮（参照树为 main，只复制 `pilot*.mjs`；`REF`、`OUT` 换成本轮的目录）：

```sh
git worktree add --detach /var/tmp/p32r2-ref f33589b4c
cp src/web/ui-migration/pilot*.mjs /var/tmp/p32r2-ref/src/web/ui-migration/
export REF=/var/tmp/p32r2-ref OUT=/var/tmp/p32r2-final
bash $R/final-runs.sh merged-check r2                # 项目合并检查
bash $R/final-runs.sh merged-pilot r2                # 两树构建 + 试点 9 用例 × 8 环境 + 对照与摘要
bash $R/final-runs.sh merged-noise r2                # 参照再跑一次，与第一次比较
bash $R/final-runs.sh merged-again r2b <main> <交付 dist 副本> <参照 dist 副本>   # main 前进后（参照树先检出 <main>）
bash $R/final-runs.sh merged-orbitkit r2 <main>      # OrbitKit：main 与交付
bash $R/final-runs.sh merged-regressions r2b         # 组件矩阵（交付）与审阅对话框（两树）
bash $R/final-runs.sh merged-p0 r2b                  # P0 矩阵：main 写截图，交付 0 像素比较；task 场景分类
bash $R/final-runs.sh merged-p0-rerun r2b <场景> <环境> [尝试]   # 单个 P0 场景在两树重跑
bash $R/final-runs.sh suite-repeat <名称> <套件> <用例> <环境> <次数>   # 单个矩阵用例在两树重复
python3 $R/merge-scope.py da13423d3 b24209077 <main> HEAD --round2 <本轮有意改动的文件…>
```

`collect.py` 把运行目录中的报告、JSON 附件（打包为 `attachments.tar.gz`，解包前的 SHA-256 在 `manifest.json`）与截图复制到本目录：[pilot-reference](pilot-reference)（AntD 参照第 4 轮）与 [pilot-delivery](pilot-delivery)（交付第 6 轮，`abb4c29e7`），截图各 240 张；[p0-task-reference-shots](p0-task-reference-shots)（tip 的 P0 运行）与 [p0-task-delivery](p0-task-delivery)（交付第 6 轮）。第 2 轮同样收集：[r2-pilot-reference](r2-pilot-reference)（main `f33589b4c` 上的 AntD 参照）与 [r2-pilot-delivery](r2-pilot-delivery)（`5ce67d6dd`），截图各 256 张；[r2b-p0-task-reference-shots](r2b-p0-task-reference-shots)（main `71e644742` 的 P0 运行，task 场景截图）与 [r2b-p0-task-delivery](r2b-p0-task-delivery)（`3c1b24f02`）。最终基点上的一组：[r2c-pilot-reference](r2c-pilot-reference)（`760287474` 上的 AntD 参照）与 [r2c-pilot-delivery](r2c-pilot-delivery)（`e3ba1c923`），截图各 256 张；[r2c-p0-task-reference-shots](r2c-p0-task-reference-shots) 与 [r2c-p0-task-delivery](r2c-p0-task-delivery)。
