# P2.2 第二版：动效与手机实测布局

服务于 [P2.2 实现菜单、浮层与选择控件](orbit-task:34Za394q2ZEgr7TKprjkF)，沿用项目验收条目：`1BvO6hYrlFnU60JqxQPUHt`，**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。** 本证据仅承担菜单、浮层与选择控件子范围。

本版回应评论 `34ZyYZarpd4lBl60cQxzg`、`34ZycYWDQCZjHyE1eez9y` 的两项返工。首版 `43db5d2e` 的 SEND_BACK 判定为 `5XTttqDHYacHEkzpwR1FPb`。保留首版实现和原证据，不以其静态通过结果代替动效验收。[上级说明](../README.md)已撤回“手机额外布局差异获得授权”的错误判断。

手机布局和动效实现提交为 `e1905305657569086b8d103f15aa1bdd5214fb03`。完整496项矩阵、相关单测、类型及首次生产构建在此源码上运行。

观察器/归档工具的独立修正提交为 `522ac9d70cc0eb2b0862f6ab1360eb745a316bf5`，随后重跑全部动效检查。完整性脚本对运行时逐文件核对当前SHA-256；对修正前的观察器/收集器则核对当时提交的原文件，明确区分执行源码与后续工具修正。

`954396bdbac19d54cee94459274fa5983747de6f` 修复打开时已选文字未按旧界面淡化的问题，追加两行 Select.css 及独立对照测试。随后 `dc2d8320d5d862e9ecd52e00296dfefefc41c741` 仅修正新增截图的入场等待。最终运行时源码为 **`3f3a297374204e7764f77ecdd9715503fcc02187`**：以自有data-open保持普通Select在列表持有焦点时的激活边框与阴影；这与Combobox已有状态标记一致，borderless/disabled覆盖顺序保留。最后的定向检查覆盖全部八个环境（24项打开/恢复文字与触发器、32项既有选择器外观状态、8项选择键盘/清除行为、48项相关入退场动效），并重新检查类型和生产构建。没有将此前结果冒称为最终提交上的全量运行。

## 恢复手机实际布局

比较同一固定附件菜单的旧 AntD、首版和本版。任务指定17px文字与旧实测14px不同；除此之外，以旧界面实际呈现为准，不以被覆盖的旧 CSS 设计意图作为额外改版授权。

| 指标 | 旧界面实测 | 首版（退回） | 本版 |
| --- | --- | --- | --- |
| 宽度 / 总高度 | 250 / 240.953125px | 250 / 251.953125px | 250 / 240.953125px |
| 行高 / 外圆角 | 42.390625 / 26px | 相同 | 相同（CSS行高42.4px） |
| 字号 | 14px | 17px | 17px，任务明确要求 |
| 行 padding / 行圆角 | 5px 12px / 4px | 0 0 0 31px / 0 | 5px 12px / 4px |
| 图标 x / 文字起点 x | 12 / 55px | 31 / 66px | 12 / 55px |
| 分隔线 x / 宽度 / y | 0 / 250 / 98.78125px | 24 / 202 / 104.28125px | 0 / 250 / 98.78125px |
| 分隔后 Shell 行 y | 103.78125px | 114.78125px | 103.78125px |

桌面密度保持原值。严格外观检查新增分隔线完整计算样式和文字起点，图标全字段直接新旧相等；手机仅允许字号及相应文本 line-height 改变，删除首版对 height、padding、y、borderRadius 的额外豁免。[修复前失败](mobile-before/summary.json)与[八环境布局验证](mobile-layout/summary.json)保留原始测量/PNG。最终矩阵再次覆盖这8项。

## 按旧实测补齐动效

| 类型 | 时长 | 入场 / 退场 | 原点 |
| --- | --- | --- | --- |
| 根 Menu、Select、Combobox、MultiSelect | 200ms | scaleY(.8) + opacity0 → 1；退场反向 | 下方0% 0%，上方100% 100%，按实际翻转后的 side |
| 子菜单 | 200ms | scale(.8) + opacity0 → 1；退场反向 | 0 0，左右翻转均核对 |
| Popover | 200ms | 同上 zoom | 沿实际 side/align，start为12px，end为宽度−12px；箭头方向越过表面6px |
| Tooltip | 100ms | 同上 zoom | 同 Popover |

slide 的入场缓动为 `cubic-bezier(.23,1,.32,1)`，退场为 `cubic-bezier(.755,.05,.855,.06)`；zoom 对应 `.08,.82,.17,1` 与 `.78,.14,.15,.86`。原始浏览器值在 [旧动效探测](legacy-motion-probe.json)及最终各环境的 `motion.json` 中。

运行时仅使用 Orbit CSS 和 Base UI 公开的 data-open/data-closed/data-side/data-align/data-nested，遵循[官方 CSS 动画生命周期](https://base-ui.com/react/handbook/animation)。Base UI 等待退场后卸载/隐藏，不增加 JS 延时。退场面不接收指针；入场结束不保留 transform。Popover/Tooltip 的 filter 与缩放、透明度放在同一表面，保证阴影与内容一起渐隐。共享 Overlay、路由、REST/SSE、依赖锁文件均未修改。

`prefers-reduced-motion: reduce` 沿用 P2.1 规范，不做缩放/渐隐，仍验证关闭、焦点和滚动锁。正常动效下验证上下弹出、边缘翻转、start/center/end 原点、左右子菜单、逐帧视口边界、退场期间存活且不接收指针、退场结束隐藏、关闭途中重开，以及 Dialog→Popover→Select 逐层 Esc/焦点和手机真实 tap。

中间帧 PNG 来自真实 CSSAnimation：仅在截图检查中将已开始的动画暂停在 duration/2，截图后继续播放；记录实际时间、opacity、边界框、filter 和关键帧，新旧严格比较。上下/自动翻转及嵌套关闭另以自然时钟运行。未修改图片，也未用结束态截图冒充动画帧；中间帧上下文图保留触发器实际焦点状态，因此不把所有原图宣称为零像素差异。

## 诊断过程保留

- 首轮24项方向/子菜单关键帧通过，但中间帧图发现 filter 留在祖先，半透明内容被阴影染灰。先增加动画层 filter 精确断言，[2项复现失败](shadow-reproduction/summary.json)，再移动 filter。首次完整矩阵因此主动中断：[50通过、1中断、445未运行](interrupted-before-shadow-fix/report.json)，不计为完整通过。
- 新增重开测试误将 Combobox 的输入查询当作已选标签：[10通过/1失败/13未运行](lifecycle-first/report.json)。现按已有语义同时断言可见已选文字、无障碍描述和空查询；原选中值检查未降低。
- WebKit 对变量形式 transform-origin 的关键帧长属性返回空串，实际计算原点仍正确。改为与旧实现一致的显式上下方向关键帧，保持关键帧和实际中间帧比较；[原失败报告](shadow-and-focus/report.json)保留。
- 一次 WebKit 手机自动翻转搜索列表已显示，但仅靠 requestAnimationFrame 的观察未取得入场动画；[34通过/1超时/11未运行](motion-cross-browser/report.json)保留，不能仅据此认定组件没有动效。同一场景加诊断后独立5次通过，观察器进一步同时监听 animationstart 和每帧状态，未改产品实现、断言、重试或超时。随后[WebKit手机24项完整动效检查](webkit-motion/report.json)通过；最终矩阵再验证全部环境。
- 证据完整性核对发现旧收集器为重复测试生成相同文件名，5次动效诊断的首4份附件索引会指向最后一份文件。原report中的5份JSON body均完整；修正收集器追加重复序号，并从原report逐字节恢复到[独立文件](flipped-search-retained/summary.json)，全部哈希匹配。旧收集目录/report保留以追溯错误，不把错误索引当作有效原件。此归档工具修正在组件源码冻结之后，未改浏览器执行的源码；完整性检查明确记录4条恢复映射。
- 完整496项中有两次WebKit退场采样超时：搜索与Tooltip中间帧已记录，随后节点也已卸载，但观察器等待旧CSSAnimation对象的finished Promise未结束。动画取消会替换该Promise，不能用卸载后的新Promise等待本次退场；参见[Web Animations取消步骤](https://drafts.csswg.org/web-animations-1/#canceling-an-animation)。观察器改为等待finished/idle终止状态，停止对终止动画记录“绘制帧”，另加进入后仍可见断言；原关键帧/时长/缓动/原点/filter/中间帧和退出隐藏断言均保留。原失败的实际opacity、边界框与节点断开记录保存在full-matrix的motion-diagnostic附件，全部192项动效随后复验。
- 完整矩阵另有两项 Chromium 明色手机外观在本地源码请求处报 `net::ERR_NETWORK_CHANGED`，未进入新旧对照断言。trace保留于full-matrix；原用例不改断言各重复3次通过于[network-repeat](network-repeat/summary.json)。两类失败分开记录，不用网络错误解释退场观察器超时。
- 原始动效图还揭示触发器文字差异。旧 Select 打开时保留原色并以opacity=.25显示当前值；新 Select 仍为1，新 Combobox改成了禁用色。先保留[三项精确失败](open-value-reproduction/summary.json)，再以公开aria-expanded/data-open恢复原色的.25透明度，关闭时恢复1。新增测试比较可见文字、颜色、字号、字重与祖先合成opacity，并确认Esc后的焦点及恢复值；不对图片做遮罩。首次测试定位器误将隐藏aria-live播报与可见文字都匹配，[原始失败日志](../checks/r2-open-value-before.txt)保留；该次附件收集因未带diagnostic被拒，重跑前未另存trace，不能声称拥有该次trace。后续三项产品差异的JSON、PNG和trace均完整归档。
- 新增文字检查中的首次整页截图有部分赶在旧组件入场前拍下，不能用于完整弹出态像素对照。`open-value-final`的112项文字/行为/动效断言结果仍保留；增加实际opacity=1、缩放=1及控件过渡完成的等待后，[open-value-settled](open-value-settled/summary.json)24项再通过。补拍发现普通Select在列表持有焦点时缺少旧触发器激活边框/阴影；[open-border-before](open-border-before/summary.json)中两项精确复现。该报告的第三项是新增测试把“Esc后仍聚焦的根控件”误同“初始无焦点根控件”比较；现分别严格新旧对照这三个根控件状态，同时保持已选文字关闭前后相等，并新增Esc后激活边框/阴影等于打开时的断言。
- 协调者对**首版**的独立完整复跑为207通过/1失败：Chromium暗色手机资源加载出现 `net::ERR_NETWORK_CHANGED`，未进入外观断言；单项重复3/3通过。其单测22/22、类型和构建通过，但动效10组失败、三层焦点2组通过。[独立原件](reviewer/coordinator-checks.json)、[完整报告](reviewer/choices-report.json)、[单项复跑](reviewer/choices-repeat-report.json)保留，不能写成单次208/208通过。

## 执行结果与复核入口

| 检查 | 如实结果 | 直接证据 |
| --- | --- | --- |
| 完整八环境矩阵：既有208 + 动效192 + 生命周期96 | 492通过 / 4失败，无跳过/自动重试；4项原因及后续验证见上文 | [report](full-matrix/report.json)、[附件/哈希](full-matrix/summary.json)、[环境](full-matrix/environment.json)、[命令](../checks/r2-final-full-matrix.json) |
| 观察器修正后的全部动效 | 192/192通过 | [report](final-motion/report.json)、[附件/哈希](final-motion/summary.json)、[命令](../checks/r2-final-motion.json) |
| 两项网络受阻外观原用例，每项重复3次 | 6/6通过 | [report](network-repeat/report.json)、[附件/哈希](network-repeat/summary.json)、[命令](../checks/r2-network-repeat.json) |
| 文字淡化修复后的定向检查（954396bdb） | 112/112通过；其中新增整页截图的入场等待随后修正 | [report](open-value-final/report.json)、[命令](../checks/r2-open-value-final.json) |
| 截图等待修正后的文字状态（dc2d8320d） | 24/24通过；随后新增触发器边框/阴影断言 | [report](open-value-settled/report.json)、[命令](../checks/r2-open-value-settled.json) |
| 最终运行时的打开态/恢复态、既有选择行为与动效（3f3a29737） | **112/112通过，0失败/跳过/重试** | [report](open-state-final/report.json)、[附件/哈希](open-state-final/summary.json)、[命令](../checks/r2-open-state-final.json) |
| 主题/边界、ShareModal、WorkspaceView菜单单测 | 4文件、22/22通过 | [命令及源码](../checks/r2-unit-regressions.json)、[原始输出](../checks/r2-unit-regressions.txt) |
| 含全部私有样例的最终 TypeScript 检查（3f3a29737） | 通过 | [命令](../checks/r2-final-open-types.json)、[输出](../checks/r2-final-open-types.txt) |
| 最终生产类型检查与 Vite 构建（3f3a29737） | 通过；现有500kB chunk提示保留 | [命令](../checks/r2-final-open-build.json)、[输出](../checks/r2-final-open-build.txt) |

生命周期96项全部在完整矩阵中通过，覆盖正常动效与减少动态效果、Dialog→Popover→Select 逐层关闭和焦点、滚动锁、可见表面的实际点击命中、退场中重开后的点击/tap。原208项中的206项在完整运行通过，另2项由上述重复补验及最终定向检查验证。首版保留的P2.1独立96项不是本版的新复跑；本版未修改共享Overlay实现。

复核命令在仓库根运行，完整 `test:ui-choices` 现在包括新增24项文字状态，共520项；归档时必须选新的目录名，失败运行加 `--diagnostic`：

```sh
npm run test:ui-choices -w @orbit/web
node src/web/ui-migration/collect-choice-evidence.mjs /tmp/p22-review-new
npm test -w @orbit/web -- src/lib/theme.test.tsx src/components/ui/boundary.test.ts src/components/ShareModal.test.tsx src/components/WorkspaceView.composerMenu.test.tsx
node node_modules/typescript/bin/tsc -p src/web/ui-migration/choices.tsconfig.json --noEmit
npm run build -w @orbit/web
```

手机菜单代表原件：[Chromium明色新图](full-matrix/chromium-light-phone--attachment-matches-the-current-surface-density-and-option-states--orbit-attachment-open.png)、[对应旧图](full-matrix/chromium-light-phone--attachment-matches-the-current-surface-density-and-option-states--antd-attachment-open.png)、[完整测量](full-matrix/chromium-light-phone--attachment-matches-the-current-surface-density-and-option-states--appearance.json)。

最终打开态代表原件：[WebKit暗色账号选择器新图](open-state-final/webkit-dark-desktop--account-dims-the-current-value-while-open-and-restores-it-on-Escape--orbit-account-open-value.png)、[对应旧图](open-state-final/webkit-dark-desktop--account-dims-the-current-value-while-open-and-restores-it-on-Escape--antd-account-open-value.png)、[三种状态实测](open-state-final/webkit-dark-desktop--account-dims-the-current-value-while-open-and-restores-it-on-Escape--open-value.json)。

[最终逐像素报告](pixel-audit-final-state.json)保留304对原图的完整差异，不设置通过阈值：静态208对中130对相同，78对同尺寸有差异；动效中间帧96对中6对相同，90对同尺寸有差异。手机菜单的4对包含授权的14→17px文字变化；Chromium文字行之外0像素差，WebKit明/暗分别21/31像素、最大通道差1，位于边缘和图标。其余原有静态180对中114对相同，66对每对最多44像素；新增打开态24对中16对相同，其余每对最多151像素、最大通道差2。精确几何/样式/图标路径检查与这些原图同时保留，不把栅格差异冒称为全图零差异。

动效截图不作为零像素基线：它们保留实际触发器焦点/悬停状态、半透明阴影和缩放中的文字/图标栅格化；关键帧、时长、缓动、原点、filter、实际中间帧opacity与边界框仍逐项新旧相等。报告同时列出表面内的差异统计，便于独立检查，未裁掉差异区域或编辑图片。先前像素报告保留为诊断历史，其中`pixel-audit-final.json`包含过早的新文字截图，已由稳定截图和最终打开态报告取代，不用于最终视觉结论。

[初次完整性核对](integrity.json)验证2428个附件引用、4条从原report恢复的重复附件映射，以及1923个原P0/P2.2历史文件未变。[最后核对](integrity-final.json)保留初次索引2508个文件的原始哈希，追加验证503个附件引用，总计2931；[最终文件索引](artifact-index-final.json)含3027个文件。两个核对分别保留当时的源码/结果，不覆盖旧检查。[本任务工具调用引用](tool-call-refs.json)将每条r2命令与会话已有exec行、argv和退出码逐一对应，包括失败和中断。

这520个不同用例的通过证据来自完整运行与上述明确标识源码的补验/定向运行之并集，**不是最终提交上单次520/520全绿**。最后112项覆盖最终运行时新增差异；其他运行时文件在记录与最后源码间保持哈希相等。完整运行的4项失败、修复前失败、观察器错误以及旧收集索引错误全部保留。

回退本次返工按 `3f3a29737` → `dc2d8320d` → `954396bdb` → `522ac9d70` → `e19053056` 逆序撤销，历史证据独立保留。首版仍是被退回的状态，不能将回退当作可验收版本。要撤销整个P2.2组件，还需撤销首版 `1a70fbb90`。无数据迁移。

## 证据边界

固定浏览器、字体、OS、数据、DPR与P0环境校验沿用首版。每条命令记录源码SHA-256、argv、时间、退出码；源码提交和最终检查映射随最终证据信封保留。原P0截图、首版原图/日志未覆盖，失败和中断不从记录中删除。

没有宣称真机iOS软键盘/原生输入法/手势滚动、真实后端搜索或整站业务替换验收。输入法仍为浏览器合成composition/keyCode229事件。旧AntD Modal最后一次Tab移出浏览器内容区的既有边界、P0/P2.1已有问题继续单列；不将它们说成已修复。通知/确认由其他任务负责。本版没有部署、发布或数据变更。
