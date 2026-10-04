# P2.2 菜单、浮层与选择控件

服务于任务 `34Za394q2ZEgr7TKprjkF`，起点 `67e62c0b4028eefe2c619dac80d3fac312cea601`。开工读取了任务完整信息/历史评论、项目目标/验收/作业指导，以及已完成的 P2.1 第二版交付。项目验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本任务承担菜单、Popover、Tooltip、Select/Combobox；通知与确认不凭本证据宣称完成。

实现、公共用法与测试提交：`1a70fbb902d6b24453a57994f782a40546d67c94`。本目录在后续独立证据提交中保留，便于代码回退与历史复核。

## 交付与真实需求

除单值 Select/Combobox 外，MultiSelect 覆盖 P0 契约中仍在用的标签多选，以及 SharedPool/AccountPools 的受控邮件标签输入。公共组件位于 `src/web/src/components/ui/`。Base UI 1.8.0 原语只在公共组件内部使用，业务参数和主题均为 Orbit 自有接口；继续用现有主题变量、CSS 和 @ant-design/icons。公共实现不依赖 AntD DOM 或 `.ant-*` 选择器，复用 P2.1 的 OverlayScope/useOverlayChild、层级和焦点返回约定。

| 真实入口 | 本次覆盖 |
| --- | --- |
| AccountSelect | 空字符串 Automatic 与 null 清除区分、自定义账号状态第二行、禁用账号、未知值回退 |
| ShareModal | 已选权限菜单、小号有效期 Select、自定义值/选项展示、在 Dialog 和旧 Modal 内打开 |
| WorkspaceView | 附件菜单图标/分隔线、手机例外、分组模型菜单/子菜单、标签选中且不关闭、菜单打开 Dialog 后返回稳定入口、菜单点击不触发行导航 |
| TaskDetailPanel 等试点 | 可搜索/可清除、分组、无结果、远端搜索/加载、value=null 的动作选择器、borderless |
| TaskListView / SharedPool / AccountPools | 多选搜索后保持打开、逐项取消/删除、全部清除、maxTagCount、逗号/空格和 Enter/失焦提交邮件标签、中文组合事件 |
| ProjectsToolbar | 当前为 Input 搜索/清除与 Segmented，没有 Select；不为不存在的用法扩充 API |

这一步交付可供试点使用的公共组件与验证入口；业务页面批量替换由下游承担，未改路由、REST/SSE 或依赖锁文件。没有主张已从生产包移除 antd。

## 验证方法

`ui-migration/choices.html` 是独立开发入口，不增加业务路由。旧 AntD 与新 Orbit 使用相同的真实 ThemeProvider/ConfigProvider、reset、字体和固定数据；未替换为 mock 控件。完整环境由 P0 原 environment.mjs 校验：Chromium/WebKit × light/dark × 1280×900 桌面/390×844 手机，DPR1，en-US/UTC；浏览器、OS、字体文件哈希可追溯。

外观断言严格比较控制面与弹出面的尺寸、字体、颜色、圆角、padding、阴影、每项相对坐标/行高、已选/禁用状态；控制面还逐一比较真实文字 Range 和 SVG 的坐标、尺寸、文字颜色，以及控件在行内的绝对位置；Popover/Tooltip 另核对箭头几何、形状与外层 filter，并保留含箭头/阴影的上下文截图。禁用、hover/focus、空状态也有直接新旧对照。原 P0 截图基线保持不变，不增加像素容忍或 xfail。

行为覆盖方向键、Enter/Space、逐层 Esc、disabled 跳过、分组/子菜单、保持打开的 checkbox、选择/清除/空字符串、中文搜索、远端加载/动作选项、触摸/鼠标外部点击、viewport 边界、焦点返回、Dialog 内 portal/滚动锁/Tab、旧 Modal 共存、Popover 内 Select、Tooltip 的 focus/hover/Esc 与 aria-describedby、打开时系统主题切换。输入法用 composition/keyCode229 浏览器事件验证，不宣称验证真机输入法。

WebKit 手机实际 `tap()` 曾暴露 Base UI 1.8 Combobox 取消 pointerdown 后没有生成 click 的问题。私有 ComboboxOption 仅通过公开 `preventBaseUIHandler()` 允许触摸 click，并跳过兼容 mouseup 的拖选后备路径；单选与多选均断言选择值、回调次数和输入焦点。不是用鼠标 click 代替触摸来让检查通过。

## 明示差异与既有缺陷

- **手机附件菜单字号以任务的17px为准。** 原 P0 实测虽然有42.4px行高和26px圆角，AntD 高优先级样式把已有17px规则覆盖成14px、分隔线也不是设计值。新实现明确使用17px、42.4px、26px、图标19px与间距16px，并按已有规则保留分隔线24px内缩。浏览器量化单行42.390625px，5行加边距/分隔为251.953125px。测试保留旧/新原始测量，只精确声明这些请求指定的差异，其余字段仍严格相等；未改历史基线。
- **旧 AntD 6 Modal 的最后一次 Tab 会移到浏览器界面。** 用纯 AntD Modal+Select+Button 对照可同样复现，下一次 Tab 返回 Close。新控件组合与该基线一致。新 Dialog 的完整正反 Tab 循环单独验证；旧 Modal 的本地切换/子层Esc/返回焦点仍检查。早期失败报告保留，未将宿主缺陷说成已修复。下游替换旧 Modal 时应使用新 Dialog 的完整循环检查。
- 前置 P2.1 已记录 P0 的8项桌面3像素截图差异及旧分享焦点缺陷；本任务不覆盖原图或顺手修改它们。

## 证据保留与复跑

`run-check.py` 为每个命令保存原始输出、argv、起止时间、HEAD、源码 SHA-256 和退出码。相同名字拒绝覆盖。`collect-choice-evidence.mjs` 仅接受新目录，收集完整 Playwright 报告、环境、原始 PNG/JSON 附件及 SHA-256；失败诊断必须明确使用 `--diagnostic`。`diagnostics/` 保留开发中发现的样式、Tooltip语义、测试时序与旧宿主焦点问题。截图复核另外找到空字符串账号的文字被 Base Value 占位标记染灰、小号控件行内亚像素偏移、桌面菜单图标应为12px（占位14px）、账号第二行裁剪范围。修复实现并扩展内部文字/图标断言；修复前运行矩阵主动中断，57项通过、95项未执行的报告原样保留，不计为完整矩阵。

最后复核发现 Tooltip 原间距为12px而非8px，纯文字菜单图标的占位应为14px而非12px。新增精确断言先复现两项失败（`diagnostics/final-geometry-reproduction/`），再修正实现。首次64项复验中，外观全部通过，但 WebKit 手机子菜单有一次键盘时序失败（63通过/1失败）。trace 显示在 Codex 尚未取得焦点时 ArrowDown 已到达父菜单，随后 Enter 选中父层 checkbox。增加 Codex/Claude 的逐步焦点断言，不改最终选中值断言、重试或超时；WebKit 手机独立10次重复通过。原报告及 trace 位于 `diagnostics/final-geometry-matrix/`，最后再执行八环境复验。

开发期1429个诊断原件归档在 `diagnostics/history.tar.gz`，归档前后逐文件 SHA-256 一致，索引在 `diagnostics/index.json`；最终矩阵与最终外观附件直接保留。`audit-pixels.py` 逐像素报告原图差异，不编辑图片、不建立新的容忍阈值，也不代替几何/颜色和行为断言。

```sh
node node_modules/typescript/bin/tsc -p src/web/ui-migration/choices.tsconfig.json --noEmit
npm run test:ui-choices -w @orbit/web
node src/web/ui-migration/collect-choice-evidence.mjs /tmp/new-choice-evidence
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts src/components/ShareModal.test.tsx src/components/WorkspaceView.composerMenu.test.tsx
npm run build -w @orbit/web
```

## 最终结果与直接证据

| 检查 | 结果 | 原始记录 |
| --- | --- | --- |
| 完整选择控件八环境矩阵 | 208通过，0失败/跳过/重试 | [报告](full-matrix/report.json)、[附件及哈希索引](full-matrix/summary.json)、[环境](full-matrix/environment.json)、[命令](checks/full-final-matrix.json) |
| 最后两处外观修正及子菜单焦点补充断言后的八环境复验 | 64通过，0失败/跳过/重试 | [报告](final-surfaces/report.json)、[附件索引](final-surfaces/summary.json)、[命令](checks/final-surfaces-and-navigation.json) |
| WebKit 手机子菜单重复 | 10/10通过 | [报告](submenu-repeat/report.json)、[命令](checks/submenu-focus-repeat.json) |
| P2.1 弹层回归 | 96通过，0失败/跳过/重试 | [报告](overlay-regressions/report.json)、[附件索引](overlay-regressions/summary.json)、[命令](checks/overlay-regressions.json) |
| theme、公共边界、ShareModal、WorkspaceView 附件菜单单测 | 4文件/22项通过 | [原始输出](checks/focused-unit-regressions.txt) |
| 含开发样例的 TypeScript 检查 | 通过 | [记录](checks/final-types-and-fixture.json) |
| Web 生产类型检查与 Vite 构建 | 通过；保留现有大 chunk 提示 | [原始输出](checks/production-build.txt) |
| 范围与历史基线 | 仅 src/web 与本目录；P0原件无改动；公共运行时代码无 AntD 引用/选择器 | [扫描及源码哈希核对](scope-audit.json) |

完整矩阵之后只修改 Tooltip 的12px间距、菜单图标最小宽度，并增加相应几何/子菜单中间焦点断言；后续64项覆盖受影响的全部8种环境。运行记录带源码哈希，不能把起点 HEAD 当作未提交源码的唯一标识。生产构建的所有改动运行时文件哈希与实现提交一致。

[最终完整性核对](checks/evidence-integrity.txt) 验证1082个附件引用的 SHA-256、各报告计数、最终源码哈希及历史 P0 未变。[本任务工具调用引用](tool-call-refs.json) 将检查命令对应到可由 Orbit 解析的 `exec-*` 行；失败开发检查也保留原退出码。

代表原件：手机附件菜单 [Chromium 明色](final-surfaces/chromium-light-phone--attachment-matches-the-current-surface-density-and-option-states--orbit-attachment-open.png) 与 [原始测量](final-surfaces/chromium-light-phone--attachment-matches-the-current-surface-density-and-option-states--appearance.json)；[WebKit 暗色 Dialog 内组合](full-matrix/webkit-dark-phone--Dialog-owns-choices-top-layer-Escape-Tab-and-theme--choices-in-dialog.png)；[多选标签](full-matrix/chromium-light-desktop--multiple-chip-appearance-matches-current-labels-and-email-fields--orbit-multiple-default.png)；[Tooltip 含触发器/箭头上下文](final-surfaces/chromium-dark-phone--tooltip-matches-the-current-surface-density-and-option-states--orbit-tooltip-context.png)。键盘、触摸、远端搜索及邮件标签的逐项行为结果在各环境的 JSON 附件中。

[像素复核](pixel-audit.json) 合并最终外观复验与未受这两处改动影响的完整矩阵原图，共184对：114对逐像素相同，4对为明确要求的手机附件字号/间距差异，66对同尺寸但仍有像素差异。后者每对最多77像素，主要在圆角边缘、SVG或半透明图标，几何、颜色和 SVG path 严格相等；例如暗色搜索控件77像素最大通道差2，WebKit 权限菜单的差异位于圆角和 y=75.625px 的地球图标，原件及坐标/路径保留供复核。基于这些数据判断是栅格化差异，不宣称全部截图零差异。修正后的 Tooltip 上下文8对均逐像素相同。

本阶段没有重跑全量 Vitest 或 P0 正式页面矩阵，不宣称整站验收。本证据不确立真机 iOS 软键盘/原生输入法/手势滚动、真实后端远端搜索、业务页面批量替换或所有未声明拥有关系的浮层组合。旧 Modal 最后一次 Tab 的边界按上文单列；P0/P2.1既有问题未覆盖基线或改成通过。回退实现提交即可撤销功能变化，证据提交可独立保留；没有数据迁移、部署或发布。
